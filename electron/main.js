const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// --- Portable mode (run from a USB / external disk) -------------------------
// When launched from electron-builder's `portable` target, PORTABLE_EXECUTABLE_DIR
// points at the folder holding the user-visible .exe (the app itself runs from a
// temp extraction). We also honour a `data/` folder or a `FunSync-portable.txt`
// marker next to the exe so an unpacked/zip build can opt in (VS Code convention).
//
// In portable mode ALL durable data — config, logs, backups, the (plaintext)
// Handy key — lives in a `data/` folder next to the exe instead of %LOCALAPPDATA%,
// so the whole thing travels on the stick. Regenerable caches (thumbnails, remux)
// deliberately stay in the OS temp dir — they're fast-local and not worth carrying.
//
// MUST run before require('./logger') and require('./store') below: electron-log
// resolves its file path lazily and electron-conf reads userData when initStore()
// constructs it, so the override has to land first. See SCOPE-portable-install.md.
const PORTABLE_DIR = (() => {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    if (fs.existsSync(path.join(exeDir, 'FunSync-portable.txt'))
        || fs.existsSync(path.join(exeDir, 'data'))) {
      return exeDir;
    }
  } catch { /* getPath('exe') can throw very early on some platforms — ignore */ }
  return null;
})();
let IS_PORTABLE = false;
if (PORTABLE_DIR) {
  const dataDir = path.join(PORTABLE_DIR, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // Probe writability up front — read-only / locked media must degrade
    // gracefully (Nielsen #9), not crash on the first config write.
    fs.accessSync(dataDir, fs.constants.W_OK);
    app.setPath('userData', dataDir);
    app.setAppLogsPath(path.join(dataDir, 'logs'));
    IS_PORTABLE = true;
    // Surfaced to safe-key.js + auto-updater gating without a circular require.
    process.env.FUNSYNC_PORTABLE = '1';
  } catch (err) {
    // Unwritable portable media → fall back to the default userData so the app
    // still runs (data just won't be portable). Logged once logger is up.
    // eslint-disable-next-line no-console
    console.error('[Portable] Cannot use portable data dir, falling back to default userData:', err.message);
  }
}

const log = require('./logger');
const { startBackend, stopBackend, setHealthListener, startHealthMonitor, restartBackend, getHealthState } = require('./python-bridge');
const { resolveWindowColors } = require('./window-bg');
const store = require('./store');
const dataBackup = require('./data-backup');
const dataMigration = require('./data-migration');
const { initAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall } = require('./auto-updater');
const { EroScriptsAPI } = require('./eroscripts-api');
const editorPopout = require('./editor-popout-window');
const audiencePopout = require('./audience-popout-window');
const playerPopout = require('./player-popout-window');

const eroScripts = new EroScriptsAPI();

// Warm the electron-conf ESM import NOW (module load, before whenReady) —
// it was ~1s of the serial initStore cost on the startup trace and doesn't
// touch userData (only `new Conf` inside initStore does, safely after the
// portable redirect above). Resolves in parallel with Chromium init + the
// recovery sweep.
store.preloadModule();

if (IS_PORTABLE) {
  log.info(`[Portable] Running in portable mode — data dir: ${app.getPath('userData')}`);
}

// Enable Chromium's VA-API hardware video decoder on Linux. Chromium
// ships with this off by default on Linux because of historical
// stability issues with broken drivers, but for users who DO have
// working VA-API drivers (intel-media-driver / mesa-va-drivers /
// nvidia-vaapi-driver) this is what gates HEVC and H.264 hardware
// decode in the <video> element. With it off, Linux users fall back to
// software decode and 4K+ HEVC stutters the same way Windows users hit
// without the MS HEVC Video Extension. The switch is a no-op on
// Windows/macOS (Chromium ignores it on those platforms) so leaving
// it unconditional keeps the code simple. Must be called BEFORE
// app.whenReady() — Chromium feature flags are parsed at init.
// Gated by a user setting (player.hwVideoDecode, default ON = prior behaviour)
// so a machine whose VA-API driver is broken can turn it OFF and fall back to
// software decode. Force-using a broken driver (esp. nvidia-vaapi, which
// VaapiIgnoreDriverChecks uses even when it can't actually decode) makes the
// <video> error out — community report (Galm): a H.264 file played in VLC/MPC
// and on an AMD box but failed in FunSync on an NVIDIA/Linux box. The store
// isn't initialised until whenReady and Chromium flags must be set before
// that, so read config.json directly here.
if (process.platform === 'linux') {
  let hwDecode = true;
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
    if (JSON.parse(raw)?.settings?.player?.hwVideoDecode === false) hwDecode = false;
  } catch { /* no config yet → default ON */ }
  if (hwDecode) {
    app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiIgnoreDriverChecks');
  } else {
    // Force software decode. Chromium on Linux can't use NVDEC the way VLC/MPC
    // do, so when VA-API is broken this is the only path that plays at all.
    app.commandLine.appendSwitch('disable-accelerated-video-decode');
  }
}

let mainWindow = null;
// Per-window poll handles for holding the caption buttons visible while the
// cursor is over them (see the update-window-chrome handler). Keyed by
// BrowserWindow id — the pop-outs run the same chrome, so a single shared
// handle would let one window cancel another's hold.
const _captionHoverPolls = new Map();

// Result of the boot-time auto-recovery check, held so the renderer
// can pick it up via IPC and surface a toast on the first paint. Null
// means "no result yet"; { recovered: false } means "config was fine"
// (no toast). Set in app.whenReady before store.initStore().
let _recoveryResult = null;

// Take a pre-action snapshot before a destructive main-process IPC.
// Best-effort: failure is logged but does NOT block the destructive
// op — losing the safety net is regrettable, refusing the user's
// action because of it would be worse. SCOPE-data-backup.md §4.7.
async function _preActionSnapshot(label) {
  try {
    await dataBackup.takeSnapshot({
      userDataDir: app.getPath('userData'),
      config: store.getAll(),
      trigger: dataBackup.TRIGGER.PRE_ACTION,
      label,
    });
    log.info(`[Backup] Pre-action snapshot taken: ${label}`);
  } catch (err) {
    log.warn(`[Backup] Pre-action snapshot failed (${label}):`, err.message);
  }
}

// Disposer for the electron-conf onDidAnyChange subscription. Held so
// before-quit can clean up the listener before the app exits.
let _unsubscribeFromStore = null;

// Resolves when the Python backend has booted (or startBackend gave up —
// it always resolves within 10s). fetchWithTimeout awaits this so backend
// proxy IPC issued while the window is ahead of uvicorn waits instead of
// failing. Null until whenReady kicks the parallel boot off.
let _backendReadyPromise = null;

// Guard for the deferred-quit flow. before-quit fires twice: once when
// we e.preventDefault() to take a final snapshot, and a second time
// after we re-call app.quit(). The flag prevents an infinite loop.
let _finalSnapshotDone = false;

// Single instance lock — prevent multiple copies running at once.
// Also handles the installer/updater trying to relaunch the app.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance — focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  // Show splash screen immediately while main window loads
  const splash = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    icon: path.join(__dirname, '..', 'assets', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  splash.center();

  // Theme-matched window chrome (ScriptPlayer+-style "one surface" look):
  // backgroundColor follows the saved theme so launch/resize never flashes
  // a foreign color, and on Windows the native title bar is replaced by a
  // Window Controls Overlay tinted to the app surface — the nav bar becomes
  // the title bar (drag region + caption-button inset in nav-bar.css).
  // Linux keeps the native frame (WCO overlay is Windows-only in Electron).
  const winColors = resolveWindowColors();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "FunSync Player",
    icon: path.join(__dirname, '..', 'assets', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: winColors.background,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        // chrome = the nav bar's surface (--surface-elevated), NOT the page
        // background — the caption buttons live inside the nav bar.
        color: winColors.chrome,
        symbolColor: winColors.symbol,
        height: 48, // matches .nav-bar height so caption buttons align with it
      },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The device sync-engine timers (setInterval) live in this window.
      // When the detached player window is open, the user foregrounds THAT
      // window and backgrounds this one — Chromium would otherwise throttle
      // these timers and the toy would stutter. Keep them full-rate.
      // (SCOPE-separate-player-window.md §9.5.)
      backgroundThrottling: false,
    },
    frame: true,
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    splash.destroy();
    mainWindow.show();
    // electron-builder's auto-updater doesn't support the portable target
    // (no latest.yml is published for it), so skip it entirely in portable
    // mode — the user updates by replacing the exe. See SCOPE-portable-install.
    if (app.isPackaged && !IS_PORTABLE) {
      initAutoUpdater(mainWindow);
    }
  });

  const _mainWinId = mainWindow.id;
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Drop the caption-hover poll if the window went away mid-hover.
    const poll = _captionHoverPolls.get(_mainWinId);
    if (poll) { clearInterval(poll); _captionHoverPolls.delete(_mainWinId); }
  });

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Always allow the user to toggle DevTools via F12 or Ctrl+Shift+I, even in
  // packaged builds — useful for self-diagnostics (custom-routing logs, etc.).
  // before-input-event fires in the main process before the renderer sees
  // the key, so no application menu / renderer handler needed.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const isI = input.key === 'I' || input.key === 'i';
    const isCtrlShiftI = input.control && input.shift && !input.alt && !input.meta && isI;
    const isF12 = input.key === 'F12';
    if (isCtrlShiftI || isF12) {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

// Custom application menu. Mirrors Electron's default role-based menu
 // but overrides the zoomIn accelerator: the default is
 // `CommandOrControl+Plus`, which Electron parses as the literal `+`
 // character — and on US/UK keyboards that requires Shift+=, so users
 // were forced to press Ctrl+Shift+= to zoom in. Browsers (Chrome,
 // Firefox, Edge) bind to the physical `=` key instead, so Ctrl+= just
 // works without Shift. Match that. Kept Plus as a secondary accelerator
 // for muscle memory; both fire the same role.
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(async () => {
  // Install the custom menu before any window is created so the
  // accelerator is live from the first paint.
  Menu.setApplicationMenu(buildAppMenu());

  // Startup timing — main-process side. Renderer-side is in
  // renderer/js/startup-timer.js. Both end up in main.log via
  // electron-log so we can correlate.
  const _t0 = Date.now();
  log.info(`[Timing main] app.whenReady fired at t=0`);

  // Auto-recovery sweep — MUST run before store.initStore so that if
  // config.json is missing/unparseable we restore it from a snapshot
  // before electron-conf reads it (otherwise electron-conf silently
  // resets to defaults and the user loses their entire library).
  // SCOPE-data-backup.md §4.4 — "before any UI loads".
  const userDataDir = app.getPath('userData');
  const _tRecover = Date.now();
  try {
    _recoveryResult = await dataBackup.verifyAndRecover({ userDataDir });
    if (_recoveryResult.recovered) {
      log.warn(
        `[Backup] Recovered config.json from snapshot ${_recoveryResult.fromSnapshot.filename} (reason: ${_recoveryResult.reason})`
      );
    } else if (_recoveryResult.fellBack) {
      log.warn(`[Backup] No valid snapshot to recover from (${_recoveryResult.reason}). Falling back to defaults.`);
    }
  } catch (err) {
    log.error('[Backup] verifyAndRecover threw — continuing with defaults:', err.message);
    _recoveryResult = { recovered: false };
  }
  log.info(`[Timing main] verifyAndRecover: ${Date.now() - _tRecover}ms`);

  const _tStore = Date.now();
  await store.initStore();
  log.info(`[Timing main] store.initStore: ${Date.now() - _tStore}ms`);

  // Wire snapshot scheduling: every settings write debounces a 60 s
  // snapshot. The blacklist filter inside data-backup keeps high-churn
  // caches (thumbnail/duration/speed) out of the snapshot bytes — but
  // the timer still arms on those writes, which is fine; the snapshot
  // strips them and dedupe-by-hash handles "no real change".
  _unsubscribeFromStore = store.subscribe(() => {
    dataBackup.scheduleSnapshot({
      userDataDir,
      getConfig: () => store.getAll(),
    });
  });

  // Take an immediate snapshot at startup. If recovery just happened,
  // tag it 'post-recovery' so the manifest shows what was restored.
  // Otherwise this is the routine "startup" snapshot from §4.2.
  try {
    const trigger = _recoveryResult.recovered
      ? dataBackup.TRIGGER.RECOVERY
      : dataBackup.TRIGGER.STARTUP;
    await dataBackup.takeSnapshot({
      userDataDir,
      config: store.getAll(),
      trigger,
    });
    // Prune asynchronously — don't block boot on disk I/O.
    dataBackup.pruneOld({ userDataDir }).catch(err => {
      log.warn('[Backup] Prune failed:', err.message);
    });
  } catch (err) {
    log.warn('[Backup] Startup snapshot failed:', err.message);
  }

  // Start the Python backend IN PARALLEL with window creation — it was
  // serially awaited here, putting ~2.1s of interpreter + FastAPI import
  // time between launch and first pixel. Nothing the renderer does in its
  // first seconds needs the backend: library scan is main-process fs, and
  // every backend proxy IPC awaits _backendReadyPromise inside
  // fetchWithTimeout (so early thumbnail requests WAIT for uvicorn instead
  // of failing into the expensive renderer <video>-decode fallback).
  // startBackend always resolves (10s internal timeout), never rejects.
  const _tBackend = Date.now();
  _backendReadyPromise = startBackend().then(() => {
    log.info(`[Timing main] startBackend (parallel with window): ${Date.now() - _tBackend}ms`);
    // Backend health-monitor wiring. Forward state transitions to every
    // renderer window via IPC so the disconnected-banner can react.
    // Started here (not inside startBackend) so manual restarts can
    // re-call startHealthMonitor without coupling through the spawn.
    setHealthListener((state, detail) => {
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('backend-status', { state, detail })
      );
    });
    startHealthMonitor();
  });

  const _tWindow = Date.now();
  createWindow();
  log.info(`[Timing main] createWindow: ${Date.now() - _tWindow}ms`);

  log.info(`[Timing main] total before window opens: ${Date.now() - _t0}ms`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  // Two-pass pattern: first call defers the quit so we can snapshot
  // the final session state to disk; second call (re-fired by our own
  // app.quit() below) falls through normally.
  if (_finalSnapshotDone) {
    stopBackend();
    return;
  }
  event.preventDefault();
  _finalSnapshotDone = true;

  // Drop the listener and any pending debounced snapshot — the QUIT
  // snapshot we're about to take supersedes both.
  if (_unsubscribeFromStore) {
    try { _unsubscribeFromStore(); } catch { /* ignore */ }
    _unsubscribeFromStore = null;
  }
  dataBackup.cancelScheduled();

  try {
    await dataBackup.takeSnapshot({
      userDataDir: app.getPath('userData'),
      config: store.getAll(),
      trigger: dataBackup.TRIGGER.QUIT,
    });
  } catch (err) {
    log.warn('[Backup] Quit snapshot failed:', err.message);
  }

  stopBackend();
  // Re-trigger quit; the guard above lets it through this time.
  app.quit();
});

// Last-chance cleanup — runs even if a renderer crashed, a modal blocked
// before-quit, or the OS sent SIGTERM. stopBackend is idempotent.
app.on('will-quit', () => {
  stopBackend();
});

// --- Global error handlers ---
process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason) => log.error('Unhandled rejection:', reason));

// --- IPC Handlers: App Info ---

ipcMain.handle('get-backend-port', () => {
  const { getBackendPort } = require('./python-bridge');
  return getBackendPort();
});

// Backend health snapshot — used by the renderer banner on first paint
// (the IPC `backend-status` event only fires on transitions, so a fresh
// renderer needs to ask for the current state to know if it should
// already be showing the banner).
ipcMain.handle('get-backend-health', () => {
  return getHealthState();
});

// User-initiated restart from the disconnected banner.
ipcMain.handle('restart-backend', async () => {
  log.info('[Backend] user-initiated restart');
  try {
    await restartBackend();
    return { success: true };
  } catch (err) {
    log.error('[Backend] restart failed:', err.message);
    return { success: false, error: err.message };
  }
});

// "View logs" affordance — opens the electron-log file in the OS's
// default editor. Path resolved at runtime (depends on app userData
// directory which differs between dev and packaged builds).
ipcMain.handle('open-log-file', async () => {
  const { shell } = require('electron');
  const logPath = log.transports?.file?.getFile?.()?.path;
  if (!logPath) return { success: false, error: 'Log file path not available' };
  const err = await shell.openPath(logPath);
  return err ? { success: false, error: err } : { success: true, path: logPath };
});

// Reveal the log folder in the OS file manager — useful when filing a
// bug report so the user can copy / zip / drag the log file into the
// issue. Uses `openPath(dirname)` rather than `showItemInFolder(file)`
// because the latter is fire-and-forget on Linux (returns void, no way
// to detect xdg-utils missing). `openPath` returns an error string when
// the launch fails, so we can surface a toast on Linux when the user's
// system doesn't have a file manager wired up to xdg-open. Slight UX
// trade-off: on Win/Mac, the log file is no longer highlighted; the
// folder just opens.
ipcMain.handle('open-log-folder', async () => {
  const { shell } = require('electron');
  const logPath = log.transports?.file?.getFile?.()?.path;
  if (!logPath) return { success: false, error: 'Log file path not available' };
  const folderPath = path.dirname(logPath);
  const err = await shell.openPath(folderPath);
  return err ? { success: false, error: err, path: folderPath } : { success: true, path: folderPath };
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Portable-mode status for the About section (Nielsen #1 — let the user see
// where their data lives). dataDir is the portable `data/` folder when active.
ipcMain.handle('get-portable-info', () => {
  return { portable: IS_PORTABLE, dataDir: app.getPath('userData') };
});

// Collect a privacy-scrubbed diagnostics bundle for the in-app
// "Report a problem" dialog. Connection flags are passed in by the
// renderer (where the device-manager state actually lives). Log path
// is read defensively — failure here must not block the report path.
//
// Privacy contract (see notes/DESIGN.md and memory/feedback_*):
//   - Never include file paths, user-supplied names, or device keys.
//   - Log tail is best-effort; if a user wants a longer log they can
//     attach the file via "Save to file" → drag into the issue.
ipcMain.handle('collect-diagnostics', async (_event, rendererState) => {
  const os = require('os');
  const logPath = log.transports?.file?.getFile?.()?.path;
  let logTail = '(log unavailable)';
  if (logPath) {
    try {
      const raw = await fs.promises.readFile(logPath, 'utf8');
      // Tolerate CRLF (Windows) and LF (Linux/Mac). Without the regex,
      // Windows log lines would carry a trailing \r into the GitHub
      // issue body — cosmetic, but worth fixing.
      const lines = raw.trim().split(/\r?\n/);
      logTail = lines.slice(-80).join('\n');
    } catch (err) {
      logTail = `(log read failed: ${err.message})`;
    }
  }
  const health = getHealthState?.() || {};
  return {
    app: {
      name: 'FunSync Player',
      version: app.getVersion(),
    },
    platform: {
      os: process.platform,
      release: os.release(),
      arch: os.arch(),
    },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    backend: {
      running: !!health.healthy,
      port: 5123,
    },
    devices: {
      handy: !!rendererState?.handyConnected,
      buttplug: !!rendererState?.buttplugConnected,
      vr: !!rendererState?.vrConnected,
      deviceCount: Number(rendererState?.deviceCount || 0),
    },
    logTail,
  };
});

// Enumerate video files in a directory. Used by the VR Format panel's
// "Apply to all videos in this folder" button. Non-recursive — only
// direct children of `dirPath`. Skips symlinks pointing outside the
// directory (matches the existing library-scan convention; avoids the
// user accidentally bulk-overwriting a parent symlink target's
// settings). Returns `string[]` of absolute paths.
ipcMain.handle('enumerate-folder-videos', async (_event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') return [];
  const VIDEO_EXT_SET = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v']);
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const out = [];
    for (const dent of entries) {
      // Skip directories and symlinks pointing outside this folder.
      if (dent.isDirectory()) continue;
      if (dent.isSymbolicLink()) continue;
      const name = dent.name;
      const dotAt = name.lastIndexOf('.');
      if (dotAt < 0) continue;
      const ext = name.slice(dotAt).toLowerCase();
      if (!VIDEO_EXT_SET.has(ext)) continue;
      out.push(path.join(dirPath, name));
    }
    return out;
  } catch (err) {
    log.warn(`[enumerate-folder-videos] ${dirPath}: ${err?.message}`);
    return [];
  }
});

// Save a text payload to a user-chosen file. Used by the "Report a
// problem" dialog for users who want to attach the report to an issue
// manually (e.g. when logs exceed the GitHub URL budget). Returns
// { success, path } | { cancelled: true } | { success: false, error }.
ipcMain.handle('save-text-file', async (_event, opts) => {
  const { defaultPath = 'report.txt', title = 'Save file', content = '' } = opts || {};
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title,
      defaultPath,
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    await fs.promises.writeFile(result.filePath, String(content), 'utf8');
    return { success: true, path: result.filePath };
  } catch (err) {
    log.error('[save-text-file] failed:', err?.message);
    return { success: false, error: err?.message || 'unknown error' };
  }
});

// Renderer → main log forwarding for the startup-timer (and any other
// callers that need a guaranteed-write path that doesn't depend on the
// console.log forwarding transport, which can break if stdout is closed
// by a parent process). Goes straight to electron-log's file transport.
ipcMain.handle('log-line', (_event, level, message) => {
  if (level === 'error') log.error(message);
  else if (level === 'warn') log.warn(message);
  else log.info(message);
});

// --- IPC Handlers: Data Store ---

ipcMain.handle('get-all-data', () => {
  return store.getAll();
});

ipcMain.handle('get-setting', (_event, path) => {
  return store.getSetting(path);
});

ipcMain.handle('set-setting', (_event, path, value) => {
  store.setSetting(path, value);
});

ipcMain.handle('add-recent-file', (_event, filePath) => {
  store.addRecentFile(filePath);
});

// Playlists
ipcMain.handle('get-playlists', () => {
  return store.getPlaylists();
});

ipcMain.handle('get-playlist', (_event, id) => {
  return store.getPlaylist(id);
});

ipcMain.handle('add-playlist', (_event, name) => {
  return store.addPlaylist(name);
});

ipcMain.handle('rename-playlist', (_event, id, name) => {
  store.renamePlaylist(id, name);
});

ipcMain.handle('set-playlist-loop', (_event, id, loop) => {
  store.setPlaylistLoop(id, loop);
});

ipcMain.handle('set-playlist-shuffle', (_event, id, shuffle) => {
  store.setPlaylistShuffle(id, shuffle);
});

ipcMain.handle('set-playlist-balance', (_event, id, balance) => {
  store.setPlaylistBalance(id, balance);
});

ipcMain.handle('set-playlist-prefer-unwatched', (_event, id, prefer) => {
  store.setPlaylistPreferUnwatched(id, prefer);
});

// Live theme switch → retint the window background + (Windows) title-bar
// overlay so the chrome follows the UI instantly. Theme is passed directly
// rather than re-read from disk: the settings write is fire-and-forget IPC
// and a disk read here could race it.
/**
 * Retint the OS window chrome. `opts` lets the player view override the
 * caption strip (Dave 2026-08-04):
 *   overVideo   — caption background fully transparent so the buttons sit
 *                 directly on the video instead of a solid nav-bar-coloured
 *                 block. Symbols forced white: the video behind them is dark
 *                 regardless of the app theme.
 *   hideSymbols — symbols transparent too, so the buttons fade out together
 *                 with the seek bar when the controls auto-hide.
 * Windows-only; other platforms just get the background colour.
 */
/**
 * Is the OS cursor currently inside the caption-button strip?
 *
 * The caption buttons are drawn by the browser/OS, not the page, so the
 * renderer never receives hover events over them — there is no DOM element
 * to listen on. `screen.getCursorScreenPoint()` reads the pointer directly,
 * which is the only way to answer this. `rect` comes from the renderer's
 * `windowControlsOverlay.getTitlebarAreaRect()` in CSS px relative to the
 * content area, so it maps onto content bounds.
 */
function _cursorOverCaption(win, rect) {
  if (!rect || !win || win.isDestroyed()) return false;
  try {
    const { screen } = require('electron'); // lazily: unavailable before ready
    const b = win.getContentBounds();
    const p = screen.getCursorScreenPoint();
    return p.x >= b.x + rect.x && p.x <= b.x + rect.x + rect.width
        && p.y >= b.y + rect.y && p.y <= b.y + rect.y + rect.height;
  } catch {
    return false;
  }
}

ipcMain.handle('update-window-chrome', (event, theme, opts = {}) => {
  const { colorsForTheme, TITLE_BAR_HEIGHT } = require('./window-bg');
  const colors = colorsForTheme(theme);
  // Target the window that ASKED, not mainWindow — the pop-outs run the same
  // themed overlay and each retints itself (a hardcoded mainWindow here made
  // a pop-out's theme change silently repaint the main window instead).
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win || win.isDestroyed()) return;
  try { win.setBackgroundColor?.(colors.background); } catch { /* best-effort */ }
  if (process.platform !== 'win32') return;

  const TRANSPARENT = '#00000000'; // 8-digit hex: RRGGBBAA
  // Hover scrim. White caption symbols vanish against a white video frame,
  // and we cannot recolour them per-pixel (the buttons are OS-drawn; the API
  // exposes one flat symbol colour). So darken the strip behind them instead.
  //
  // 0.8 alpha is picked for contrast, not taste: over a pure white frame the
  // composite lands at ~0.20 relative luminance, giving white symbols ~4.2:1
  // — clear of the 3:1 WCAG floor for UI components. At the 0.7 the player's
  // top-bar gradient uses it would sit at exactly 3.0:1, i.e. borderline on
  // the worst-case frame.
  const HOVER_SCRIM = '#000000CC';
  const apply = (hideSymbols, scrim = false) => {
    if (win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay?.({
        color: opts.overVideo
          ? (scrim ? HOVER_SCRIM : TRANSPARENT)
          : colors.chrome, // else nav-bar surface, see window-bg.js
        symbolColor: hideSymbols
          ? TRANSPARENT
          : (opts.overVideo ? '#ffffff' : colors.symbol),
        height: TITLE_BAR_HEIGHT,
      });
    } catch { /* overlay not active (e.g. frame fallback) */ }
  };

  // Any new request for THIS window supersedes its pending hover-hold.
  const prev = _captionHoverPolls.get(win.id);
  if (prev) { clearInterval(prev); _captionHoverPolls.delete(win.id); }

  // Hovering the caption strip keeps ALL THREE buttons lit even as the player
  // controls fade (Dave 2026-08-04) — they are one visual group, so hiding
  // them under the cursor reads as the app losing its window controls. Hold
  // them, then poll until the pointer leaves and apply the hide late.
  //
  // This hold is also the ONLY state that needs the scrim. With the controls
  // visible the player's top bar already paints its gradient across the full
  // width, and that shows through the transparent strip — white symbols read
  // fine. It's only here, controls faded but symbols held, that they sit on
  // raw video with nothing behind them.
  if (opts.hideSymbols && _cursorOverCaption(win, opts.captionRect)) {
    apply(false, true);
    const id = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(id); _captionHoverPolls.delete(win.id); return; }
      if (_cursorOverCaption(win, opts.captionRect)) return;
      clearInterval(id);
      _captionHoverPolls.delete(win.id);
      apply(true); // pointer left → symbols and scrim both go
    }, 300);
    _captionHoverPolls.set(win.id, id);
    return;
  }

  apply(!!opts.hideSymbols);
});

ipcMain.handle('set-playlist-video-paths', (_event, id, videoPaths) => {
  store.setPlaylistVideoPaths(id, videoPaths);
});

ipcMain.handle('delete-playlist', async (_event, id) => {
  await _preActionSnapshot('delete-playlist');
  store.deletePlaylist(id);
});

ipcMain.handle('add-video-to-playlist', (_event, id, videoPath) => {
  store.addVideoToPlaylist(id, videoPath);
});

ipcMain.handle('remove-video-from-playlist', (_event, id, videoPath) => {
  store.removeVideoFromPlaylist(id, videoPath);
});

// Categories
ipcMain.handle('get-categories', () => {
  return store.getCategories();
});

ipcMain.handle('add-category', (_event, name, color) => {
  return store.addCategory(name, color);
});

ipcMain.handle('rename-category', (_event, id, name) => {
  store.renameCategory(id, name);
});

ipcMain.handle('delete-category', async (_event, id) => {
  // Category delete is doubly-destructive: it nukes the category AND
  // every video↔category mapping that referenced it. Worth the
  // pre-action snapshot.
  await _preActionSnapshot('delete-category');
  store.deleteCategory(id);
});

// Category Mappings
ipcMain.handle('assign-category', (_event, videoPath, catId) => {
  store.assignCategory(videoPath, catId);
});

ipcMain.handle('unassign-category', (_event, videoPath, catId) => {
  store.unassignCategory(videoPath, catId);
});

ipcMain.handle('get-video-categories', (_event, videoPath) => {
  return store.getVideoCategories(videoPath);
});

ipcMain.handle('get-videos-by-category', (_event, catId) => {
  return store.getVideosByCategory(catId);
});

// Migration
ipcMain.handle('migrate-local-storage', (_event, legacyData) => {
  return dataMigration.migrate(legacyData);
});

// --- IPC Handlers: File Operations ---

// Open file dialog — returns array of { name, path, textContent? }
// Video files get file:// paths (no content transfer needed).
// Text files (funscript, subtitles) get their content read.
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media Files', extensions: ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a'] },
      { name: 'Funscript Files', extensions: ['funscript'] },
      { name: 'Subtitle Files', extensions: ['srt', 'vtt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return [];

  const TEXT_EXTS = ['.funscript', '.srt', '.vtt'];
  const files = [];
  for (const filePath of result.filePaths) {
    const ext = path.extname(filePath).toLowerCase();
    const entry = {
      name: path.basename(filePath),
      path: filePath,
    };
    // Only read content for small text-based files
    if (TEXT_EXTS.includes(ext)) {
      entry.textContent = fs.readFileSync(filePath, 'utf-8');
    }
    files.push(entry);
  }
  return files;
});

// --- IPC Handlers: Backend API Proxies ---

/**
 * fetch() with an AbortController timeout. Every backend call routes
 * through this — a hung Python subprocess (deadlock, infinite loop,
 * blocked on ffmpeg) would otherwise leave the renderer's IPC
 * indefinitely pending and the UI frozen. Better to fail cleanly so
 * the caller can toast "backend timed out" and move on.
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  // Backend boots in parallel with the window (see whenReady). Every
  // backend proxy funnels through here, so gate on backend-ready: an
  // early request WAITS for uvicorn (bounded — startBackend resolves
  // within 10s no matter what) instead of failing fast, which would
  // trip the renderer's expensive <video>-decode thumbnail fallback
  // during the exact seconds we're trying to speed up.
  if (_backendReadyPromise) {
    try { await _backendReadyPromise; } catch { /* proceed; fetch will surface the state */ }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('fetch-metadata', async (_event, videoPath) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/metadata/?video_path=${encodeURIComponent(videoPath)}`;
  try {
    // 20s: ffprobe on very large / slow-disk files can take 5-10s; the
    // rest is network + JSON parse. Anything beyond this is a hung
    // backend, not slow I/O.
    const resp = await fetchWithTimeout(url, {}, 20000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    log.error('Metadata fetch failed:', err.message);
    return null;
  }
});

ipcMain.handle('generate-thumbnails', async (_event, videoPath, interval) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const params = new URLSearchParams({ video_path: videoPath, interval: String(interval || 10) });
  const url = `http://localhost:${port}/thumbnails/generate?${params}`;
  try {
    // 60s: thumbnail generation on a long video can genuinely take
    // 10-30s of ffmpeg wall-time per pass. Hard ceiling at 60s to
    // prevent a stuck ffmpeg from blocking the IPC pipeline forever.
    const resp = await fetchWithTimeout(url, { method: 'POST' }, 60000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    log.error('Thumbnail generation failed:', err.message);
    return null;
  }
});

/**
 * Generate ONE thumbnail for library card display via the backend's
 * ffmpeg, then read the resulting JPEG file and return it as a base64
 * data URL. Replaces the renderer's hidden-<video> decode path which
 * was 2-3 seconds per file because it loaded the entire video just to
 * grab one frame; ffmpeg with `-ss before -i` (fast seek) does the
 * same job in tens of ms.
 *
 * Returns { dataUrl, duration, width, height } or null on failure.
 */
ipcMain.handle('generate-single-thumbnail', async (_event, videoPath, opts = {}) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const params = new URLSearchParams({
    video_path: videoPath,
    seek_pct: String(opts.seekPct ?? 0.1),
    width: String(opts.width ?? 320),
    // Frame-accurate grab for user-picked thumbnail frames ("Set
    // thumbnail frame…") — the default path is keyframe-only + a 10s
    // minimum seek, both of which would silently change the frame.
    exact: String(!!opts.exact),
  });
  const url = `http://localhost:${port}/thumbnails/single?${params}`;
  try {
    // 15s: a single fast-seek thumbnail is ~50-500ms; ceiling protects
    // against a hung ffmpeg.
    const resp = await fetchWithTimeout(url, { method: 'POST' }, 15000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    const meta = await resp.json();
    if (!meta?.path || !fs.existsSync(meta.path)) {
      throw new Error('Backend returned no thumbnail file');
    }
    const bytes = fs.readFileSync(meta.path);
    const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    return { dataUrl, duration: meta.duration, width: meta.width, height: meta.height };
  } catch (err) {
    log.warn(`Single thumbnail failed for ${videoPath}: ${err.message}`);
    return null;
  }
});

/**
 * Remux a non-browser-playable container (e.g. .mkv with H.264/AAC) into
 * MP4 via the backend's ffmpeg, so Chromium's <video> can play it. Returns
 * { path, cached } pointing at a cached temp MP4, or null on failure (the
 * renderer then surfaces the usual "format not supported" error).
 */
ipcMain.handle('remux-video', async (_event, videoPath) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/api/media/remux?video_path=${encodeURIComponent(videoPath)}`;
  try {
    // 10 min ceiling: stream-copy is normally seconds, but a multi-GB file
    // on slow/NAS storage plus an audio transcode can run long. This blocks
    // playback start, so the renderer shows a "Preparing…" toast meanwhile.
    const resp = await fetchWithTimeout(url, { method: 'POST' }, 600000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    const meta = await resp.json();
    if (!meta?.path || !fs.existsSync(meta.path)) {
      throw new Error('Remux produced no file');
    }
    log.info(`[Remux] ${videoPath} → ${meta.path} (cached: ${!!meta.cached})`);
    return { path: meta.path, cached: !!meta.cached };
  } catch (err) {
    log.warn(`[Remux] failed for ${videoPath}: ${err.message}`);
    return null;
  }
});

/**
 * Resolve a remote video PAGE url (e.g. a streaming-site link) to a playable
 * stream via the backend's yt-dlp. Returns { ok, title, isHls, proxyUrl, ... }
 * with proxyUrl made ABSOLUTE (http://localhost:PORT/...) so the renderer can
 * play it directly; or { ok:false, kind, message } so the UI can show a
 * precise error. See SCOPE-remote-video-url.md.
 */
ipcMain.handle('resolve-remote-video', async (_event, pageUrl) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/api/media/resolve?url=${encodeURIComponent(pageUrl)}`;
  try {
    // yt-dlp extraction can take a few seconds (network + site parsing).
    const resp = await fetchWithTimeout(url, { method: 'POST' }, 90000);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const kind = body?.detail?.kind || 'error';
      log.info(`[Remote] resolve ${pageUrl} failed: ${kind}`);
      return { ok: false, kind, message: body?.detail?.message || '' };
    }
    log.info(`[Remote] resolved ${pageUrl} → ${body.isHls ? 'HLS' : 'progressive'} "${body.title}"`);
    return { ok: true, ...body, proxyUrl: `http://localhost:${port}${body.proxyUrl}` };
  } catch (err) {
    log.warn(`[Remote] resolve error for ${pageUrl}: ${err.message}`);
    return { ok: false, kind: 'error', message: err.message };
  }
});

// --- IPC Handlers: Library ---

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('scan-directory', async (_event, dirPathOrPaths, sourceMap) => {
  // Accept a single path or array of paths (multi-source)
  // sourceMap: optional { path: sourceName } mapping for VR content server grouping
  const dirPaths = Array.isArray(dirPathOrPaths) ? dirPathOrPaths : [dirPathOrPaths];
  const dirPath = dirPaths[0]; // for backward compat logging
  const _sourceMap = sourceMap || {};
  const VIDEO_EXTS = ['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac', '.m4a'];
  const FUNSCRIPT_EXT = '.funscript';
  const SUBTITLE_EXTS = ['.srt', '.vtt'];
  const AXIS_SUFFIXES = new Set(['surge','sway','twist','roll','pitch','vib','lube','pump','suction','valve']);

  // Canonicalise a path for cross-source dedup: forward slashes, lowercased
  // drive letter. Matches renderer/js/path-utils.js::canonicalPath so the
  // settings overlap warning and the scan dedup agree on identity.
  const canonicalise = (p) => {
    if (!p) return '';
    let out = String(p).replace(/\\/g, '/');
    while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
  };

  let entries = [];
  const seenPaths = new Set(); // canonical full paths — drops dupes when sources overlap
  const failedPaths = [];
  let rawEntryCount = 0;
  const scanStart = Date.now();
  for (const dp of dirPaths) {
    if (!dp) continue;
    try {
      const dirEntries = await fs.promises.readdir(dp, { withFileTypes: true, recursive: true });
      rawEntryCount += dirEntries.length;
      for (const entry of dirEntries) {
        const parent = entry.parentPath || entry.path || dp;
        const full = canonicalise(path.join(parent, entry.name));
        if (seenPaths.has(full)) continue;
        seenPaths.add(full);
        entries.push(entry);
      }
    } catch (err) {
      log.warn(`[Library] Failed to scan ${dp}: ${err.message}`);
      failedPaths.push(dp);
    }
  }
  const dupesDropped = rawEntryCount - entries.length;
  if (dupesDropped > 0) {
    log.info(`[Library] Scanned ${entries.length} unique entries (${dupesDropped} duplicates dropped from overlapping sources) in ${Date.now() - scanStart}ms from ${dirPaths.length} source(s)`);
  } else {
    log.info(`[Library] Scanned ${entries.length} entries in ${Date.now() - scanStart}ms from ${dirPaths.length} source(s)`);
  }

  // Normalize a basename for matching: lowercase, replace separators with spaces, collapse
  const normalizeName = (name) => name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

  // Helper: get the full path for a recursive dirent
  const entryPath = (entry) => {
    // Node recursive dirent: entry.parentPath or entry.path contains the parent directory
    const parent = entry.parentPath || entry.path || dirPath;
    return path.join(parent, entry.name);
  };

  // Helper: get the directory of an entry (for same-directory matching)
  const entryDir = (entry) => {
    return entry.parentPath || entry.path || dirPath;
  };

  // Pre-compute the set of video basenames (full, including any
  // parenthetical) so funscript classification can distinguish a
  // real-title parenthetical from a variant suffix. Example:
  //   "Title (Nude).mp4" + "Title (Nude).funscript"  → the "(Nude)" is
  //      part of the title; the funscript is that video's PRIMARY.
  //   "Title.mp4" + "Title (Soft).funscript"         → no "Title (Soft)"
  //      video exists; "(Soft)" is a variant label of "Title".
  // Without this, "Title (Nude).funscript" was always classified as a
  // "(Nude)" variant of "Title" and absorbed into "Title.mp4", leaving
  // "Title (Nude).mp4" script-less and hidden under the Matched tab.
  const videoBaseLocal = new Set();  // dir + '\0' + normalizedBase
  const videoBaseGlobal = new Set(); // normalizedBase
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const vext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.includes(vext)) continue;
    const vbase = normalizeName(path.basename(entry.name, vext));
    videoBaseLocal.add(entryDir(entry) + '\0' + vbase);
    videoBaseGlobal.add(vbase);
  }

  // Collect all funscripts with variant/axis classification
  const funscriptList = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== FUNSCRIPT_EXT) continue;

    const nameNoExt = path.basename(entry.name, ext);
    const fullPath = entryPath(entry);

    // Check for axis suffix: "video.vib" -> suffix "vib"
    const dotIdx = nameNoExt.lastIndexOf('.');
    const dotSuffix = dotIdx >= 0 ? nameNoExt.slice(dotIdx + 1).toLowerCase() : null;
    const isAxis = dotSuffix && AXIS_SUFFIXES.has(dotSuffix);

    // Check for parenthesized variant: "video (Soft)" -> label "Soft"
    const parenMatch = nameNoExt.match(/^(.+?)\s*\(([^)]+)\)\s*$/);

    let videoBase, variantLabel;
    let isAmbiguousDotVariant = false;
    if (isAxis) {
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = null; // axis, not a variant
    } else if (parenMatch) {
      const fullBase = normalizeName(nameNoExt);
      const fsDir = entryDir(entry);
      if (videoBaseLocal.has(fsDir + '\0' + fullBase) || videoBaseGlobal.has(fullBase)) {
        // A video whose real title includes the parenthetical exists
        // (e.g. "Title (Nude).mp4"). The parens are part of the title,
        // not a variant suffix — treat this funscript as that video's
        // primary so the video isn't left script-less and hidden.
        videoBase = fullBase;
        variantLabel = null;
      } else {
        // Parenthesized variant — `"Title (Soft).funscript"` with only
        // "Title.mp4" present. Unambiguous user intent; treat as variant.
        videoBase = normalizeName(parenMatch[1]);
        variantLabel = parenMatch[2].trim();
      }
    } else if (dotSuffix && dotIdx > 0) {
      // AMBIGUOUS — could be a real variant ("video.intense.funscript")
      // OR just a filename that happens to contain a dot ("S01.E03.funscript",
      // "Title.2024.funscript"). We can't tell from the name in isolation.
      // Classify provisionally as a variant and let the post-pass below
      // demote it to primary if no sibling funscript exists with the
      // dot-stripped base (i.e., nothing for it to be a "variant of").
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = dotSuffix;
      isAmbiguousDotVariant = true;
    } else {
      videoBase = normalizeName(nameNoExt);
      variantLabel = null; // default/primary
    }

    funscriptList.push({
      name: entry.name,
      path: fullPath,
      dir: entryDir(entry),
      videoBase,
      variantLabel,
      isAxis,
      axisSuffix: isAxis ? dotSuffix : null,
      // Set for funscripts whose variant-ness was inferred from a dot
      // in the filename. Post-pass below demotes to primary when no
      // matching primary sibling exists.
      isAmbiguousDotVariant,
      // Cache the full-name normalisation for the demotion path so we
      // don't recompute it after the maps are built.
      fullNormalisedBase: normalizeName(nameNoExt),
      _used: false,
    });
  }

  // Post-pass: demote ambiguous dot-variants to primaries when no
  // sibling exists with the dot-stripped base. This rescues filenames
  // like "S01.E03.funscript" and "Title.2024.funscript" that the
  // classifier above would otherwise route to a non-existent base.
  // A sibling counts if it's a non-axis funscript in the same dir
  // (preferred) or anywhere (fallback) whose `videoBase` matches the
  // ambiguous variant's `videoBase`.
  const siblingBasesLocal = new Set();
  const siblingBasesGlobal = new Set();
  for (const fs of funscriptList) {
    if (fs.isAxis || fs.isAmbiguousDotVariant) continue;
    siblingBasesLocal.add(fs.dir + '\0' + fs.videoBase);
    siblingBasesGlobal.add(fs.videoBase);
  }
  for (const fs of funscriptList) {
    if (!fs.isAmbiguousDotVariant) continue;
    const localKey = fs.dir + '\0' + fs.videoBase;
    if (siblingBasesLocal.has(localKey) || siblingBasesGlobal.has(fs.videoBase)) {
      // Confirmed variant — a real primary exists. Clear the flag so
      // downstream code can treat the classification as settled.
      fs.isAmbiguousDotVariant = false;
      continue;
    }
    // Demote to primary using the full normalised name. "Title.2024"
    // becomes its own thing, matching "Title.2024.mp4".
    fs.videoBase = fs.fullNormalisedBase;
    fs.variantLabel = null;
    fs.isAmbiguousDotVariant = false;
  }

  // Build two maps: same-directory (preferred) and global (fallback)
  const funscriptMapLocal = new Map(); // dir+base → fs
  const funscriptMapGlobal = new Map(); // base → fs
  for (const fs of funscriptList) {
    const localKey = fs.dir + '\0' + fs.videoBase;
    const globalKey = fs.videoBase;
    if (!fs.isAxis && !fs.variantLabel) {
      if (!funscriptMapLocal.has(localKey)) funscriptMapLocal.set(localKey, fs);
      if (!funscriptMapGlobal.has(globalKey)) funscriptMapGlobal.set(globalKey, fs);
    }
  }
  // Fallback: if no default variant, use first matching
  for (const fs of funscriptList) {
    const localKey = fs.dir + '\0' + fs.videoBase;
    const globalKey = fs.videoBase;
    if (!fs.isAxis) {
      if (!funscriptMapLocal.has(localKey)) funscriptMapLocal.set(localKey, fs);
      if (!funscriptMapGlobal.has(globalKey)) funscriptMapGlobal.set(globalKey, fs);
    }
  }

  // Collect subtitle basenames — local (same-dir) and global maps
  const subtitleMapLocal = new Map();
  const subtitleMapGlobal = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SUBTITLE_EXTS.includes(ext)) {
      const baseName = normalizeName(path.basename(entry.name, ext));
      const dir = entryDir(entry);
      const localKey = dir + '\0' + baseName;
      const sub = { name: entry.name, path: entryPath(entry), dir, _used: false };
      if (!subtitleMapLocal.has(localKey)) subtitleMapLocal.set(localKey, sub);
      if (!subtitleMapGlobal.has(baseName)) subtitleMapGlobal.set(baseName, sub);
    }
  }

  // Build video list with funscript + subtitle + variant pairing
  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) continue;

    const baseName = normalizeName(path.basename(entry.name, ext));
    const dir = entryDir(entry);
    const localKey = dir + '\0' + baseName;

    // Funscript: prefer same directory, fall back to global
    const fsEntry = funscriptMapLocal.get(localKey) || funscriptMapGlobal.get(baseName) || null;
    const funscriptPath = fsEntry ? fsEntry.path : null;
    if (fsEntry) fsEntry._used = true;

    // Subtitle: prefer same directory, fall back to global
    const subEntry = subtitleMapLocal.get(localKey) || subtitleMapGlobal.get(baseName) || null;
    const subtitlePath = subEntry ? subEntry.path : null;
    if (subEntry) subEntry._used = true;

    // Collect variants: same directory first, then global matches
    const variants = [];
    const seenVariantPaths = new Set();
    // Pass 1: same directory
    for (const fs of funscriptList) {
      if (fs.videoBase !== baseName || fs.isAxis || fs.dir !== dir) continue;
      fs._used = true;
      seenVariantPaths.add(fs.path);
      variants.push({ label: fs.variantLabel || 'Default', path: fs.path, name: fs.name });
    }
    // Pass 2: global (other directories) — only if not already found locally
    if (variants.length === 0) {
      for (const fs of funscriptList) {
        if (fs.videoBase !== baseName || fs.isAxis || seenVariantPaths.has(fs.path)) continue;
        fs._used = true;
        variants.push({ label: fs.variantLabel || 'Default', path: fs.path, name: fs.name });
      }
    }
    // Sort: Default first, then alphabetical
    variants.sort((a, b) => {
      if (a.label === 'Default') return -1;
      if (b.label === 'Default') return 1;
      return a.label.localeCompare(b.label);
    });

    // Resolve source name from sourceMap (match longest prefix)
    const fullPath = entryPath(entry);
    let sourceName = '';
    for (const [srcPath, srcName] of Object.entries(_sourceMap)) {
      if (fullPath.startsWith(srcPath) && srcPath.length > sourceName.length) {
        sourceName = srcName;
      }
    }

    videos.push({
      name: entry.name,
      path: fullPath,
      ext,
      hasFunscript: funscriptPath !== null,
      funscriptPath,
      hasSubtitle: subtitlePath !== null,
      subtitlePath,
      // Pass ALL detected variants through, even a single one. The
      // renderer decides whether to SHOW the switcher (it hides the
      // dropdown when the combined auto+manual count is < 2), and it
      // combines these with manually-associated variants — so dropping a
      // lone auto variant here used to hide the switcher for a video that
      // had 1 auto script + 1 manual variant (2 real scripts). It also
      // preserved the real label/path instead of a synthesised "Default".
      variants,
      sourceName: sourceName || path.basename(path.dirname(fullPath)) || 'Library',
      // `dateAdded` is populated in a batched stat pass below. Using `mtimeMs`
      // as a pragmatic "date added" proxy — cross-platform reliable (unlike
      // birthtimeMs on Linux ext4). Users typically want "recently appeared
      // in my folder", which matches mtime for fresh-dropped files.
      dateAdded: 0,
    });
  }

  // Batched stat pass to fill `dateAdded`. Runs all stats in parallel
  // (libuv's thread pool naturally caps concurrency). Typical cost for
  // 1000 videos: ~10-50ms on SSD, ~100-500ms on HDD. Failures fall back
  // to 0 which sorts to the "oldest" end of the list.
  await Promise.all(videos.map(async (v) => {
    try {
      const st = await fs.promises.stat(v.path);
      v.dateAdded = st.mtimeMs || 0;
    } catch {
      v.dateAdded = 0;
    }
  }));

  // Fuzzy match pass: pair unmatched videos with high-confidence funscript matches
  // Uses token overlap (Jaccard index) — same logic as renderer fuzzy-match.js
  const fuzzyTokenize = (s) => s.toLowerCase().replace(/[_.\-()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const fuzzyScore = (a, b) => {
    const tokA = new Set(fuzzyTokenize(a));
    const tokB = new Set(fuzzyTokenize(b));
    if (tokA.size === 0 || tokB.size === 0) return 0;
    let inter = 0;
    for (const t of tokA) if (tokB.has(t)) inter++;
    const union = new Set([...tokA, ...tokB]).size;
    return Math.round((inter / union) * 100);
  };

  for (const video of videos) {
    if (video.hasFunscript) continue; // already matched
    const videoBase = path.basename(video.name, path.extname(video.name));
    let bestFs = null;
    let bestScore = 0;
    for (const fs of funscriptList) {
      if (fs._used || fs.isAxis) continue;
      const fsBase = path.basename(fs.name, '.funscript');
      const score = fuzzyScore(videoBase, fsBase);
      if (score > bestScore) { bestScore = score; bestFs = fs; }
    }
    if (bestFs && bestScore >= 98) {
      video.hasFunscript = true;
      video.funscriptPath = bestFs.path;
      video._fuzzyMatched = true;
      bestFs._used = true;

      // Also collect variants for this fuzzy match
      const fuzzyVariants = [];
      const seenPaths = new Set();
      for (const fs of funscriptList) {
        if (fs.isAxis) continue;
        const fsBase = path.basename(fs.name, '.funscript');
        const s = fuzzyScore(videoBase, fsBase);
        if (s >= 98 && !seenPaths.has(fs.path)) {
          seenPaths.add(fs.path);
          fuzzyVariants.push({ label: fs.variantLabel || 'Default', path: fs.path, name: fs.name });
        }
      }
      if (fuzzyVariants.length > 1) {
        fuzzyVariants.sort((a, b) => a.label === 'Default' ? -1 : b.label === 'Default' ? 1 : a.label.localeCompare(b.label));
        video.variants = fuzzyVariants;
      }
    }
  }

  // Collect unmatched funscripts (not paired to any video)
  const unmatchedFunscripts = [];
  for (const fs of funscriptList) {
    if (!fs._used) {
      unmatchedFunscripts.push({ name: fs.name, path: fs.path });
    }
  }
  unmatchedFunscripts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // Collect unmatched subtitles
  const unmatchedSubtitles = [];
  for (const subEntry of subtitleMapGlobal.values()) {
    if (!subEntry._used) {
      unmatchedSubtitles.push({ name: subEntry.name, path: subEntry.path });
    }
  }
  unmatchedSubtitles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // Collect all funscripts for multi-axis dropdowns
  const allFunscripts = [];
  for (const fs of funscriptList) {
    allFunscripts.push({ name: fs.name, path: fs.path });
  }
  allFunscripts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // Sort alphabetically
  videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  log.info(`[Library] Result: ${videos.length} videos, ${unmatchedFunscripts.length} unmatched fs, ${allFunscripts.length} total fs (${Date.now() - scanStart}ms total)`);

  // Register videos with backend for VR content server (fire-and-forget)
  try {
    const { app } = require('electron');
    const thumbDir = path.join(app.getPath('userData'), 'thumb-cache');
    fetch('http://127.0.0.1:5123/api/media/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos, thumbCacheDir: thumbDir }),
    }).catch(() => {}); // ignore if backend not running
  } catch { /* ignore */ }

  return { videos, unmatchedFunscripts, unmatchedSubtitles, allFunscripts, failedPaths };
});

ipcMain.handle('select-funscript', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Funscript Files', extensions: ['funscript'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { name: path.basename(filePath), path: filePath };
});

ipcMain.handle('select-subtitle', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Subtitle Files', extensions: ['srt', 'vtt'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { name: path.basename(filePath), path: filePath };
});

// ---- Custom thumbnail images (user-uploaded posters, community #217) ----
// Image I/O stays in the main process (renderer is sandboxed). The chosen
// image is decoded via nativeImage, downscaled to tile width, re-encoded as
// JPEG and stored under userData/custom-thumbs keyed by a hash of the video
// path (re-picking overwrites). The renderer displays thumbnails as data
// URLs (CSP img-src allows data:, not file:), so import/read both return one.

const customThumbsDir = () => path.join(app.getPath('userData'), 'custom-thumbs');

ipcMain.handle('select-thumbnail-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      // Uppercase variants included because Linux (GTK) dialog filters are
      // CASE-SENSITIVE — without them a camera's IMG.JPG wouldn't match.
      // Harmless on Windows (case-insensitive there).
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'JPG', 'JPEG', 'PNG', 'WEBP'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { name: path.basename(filePath), path: filePath };
});

ipcMain.handle('import-custom-thumbnail', async (_event, videoPath, imagePath) => {
  try {
    const { nativeImage } = require('electron');
    const crypto = require('crypto');
    const dir = customThumbsDir();
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('md5').update(String(videoPath)).digest('hex');
    // Re-picking may change the extension (jpg → raw png copy etc.) — drop
    // any previous cached file for this video first so no stale sibling
    // lingers.
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${hash}.`)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ } }
    }
    let img = nativeImage.createFromPath(imagePath);
    if (!img.isEmpty()) {
      const size = img.getSize();
      if (size.width > 640) img = img.resize({ width: 640 });
      const jpeg = img.toJPEG(82);
      const outPath = path.join(dir, `${hash}.jpg`);
      fs.writeFileSync(outPath, jpeg);
      return { path: outPath, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
    }
    // Format nativeImage can't decode (e.g. some webp encodes) — copy the
    // raw file; Chromium's <img> still renders it from a data URL.
    const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'img';
    const outPath = path.join(dir, `${hash}.${ext}`);
    fs.copyFileSync(imagePath, outPath);
    const bytes = fs.readFileSync(outPath);
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { path: outPath, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
  } catch (err) {
    log.warn('Custom thumbnail import failed:', err.message);
    return null;
  }
});

// The backend serves custom-thumb images to the phone (F7) — it needs to
// know (and validate against) the same dir the import IPC writes into.
ipcMain.handle('get-custom-thumbs-dir', () => customThumbsDir());

ipcMain.handle('read-custom-thumbnail', async (_event, cachedPath) => {
  try {
    // Only serve files from OUR cache dir — the renderer stores the path in
    // settings, so treat it as untrusted (no arbitrary-file reads).
    const resolved = path.resolve(String(cachedPath));
    if (!resolved.startsWith(path.resolve(customThumbsDir()) + path.sep)) return null;
    if (!fs.existsSync(resolved)) return null;
    const bytes = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
  } catch {
    return null;
  }
});

ipcMain.handle('read-funscript', async (_event, filePath) => {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    // Strip UTF-8 BOM (EF BB BF, U+FEFF) at the I/O boundary. Some
    // scripting tools (Windows editors, older OFS, hand-saved files)
    // write a leading BOM that JSON.parse rejects. Community report
    // 2026-06-01: RyzaMerged.funscript loaded fine in Handyverse but
    // errored here because of the BOM. Strip once, every consumer
    // gets clean content automatically.
    return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  } catch (err) {
    log.error('read-funscript failed:', err.message);
    return null;
  }
});

// Save funscript to file
ipcMain.handle('save-funscript', async (_event, content, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'script.funscript',
    filters: [
      { name: 'Funscript Files', extensions: ['funscript'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  try {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return result.filePath;
  } catch (err) {
    log.error('save-funscript failed:', err.message);
    return null;
  }
});

// Write funscript directly to a known path (for autosave — no dialog)
ipcMain.handle('write-funscript', async (_event, content, filePath) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch (err) {
    log.error('write-funscript failed:', err.message);
    return null;
  }
});

// Backend API proxy — convert funscript to CSV
/**
 * Fetch the backend's computed speed-stats map, keyed by funscriptPath.
 * Returns {} when nothing's computed yet. The renderer polls this after
 * scan to hydrate per-video avgSpeed/maxSpeed without having to read
 * every funscript itself — the backend's `_queue_speed_probes` worker
 * has already done the parsing in a separate process.
 */
ipcMain.handle('get-speed-stats', async () => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/api/media/speed-stats`;
  try {
    const resp = await fetchWithTimeout(url, {}, 5000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    log.warn(`get-speed-stats failed: ${err.message}`);
    return {};
  }
});

/**
 * Fetch the backend's computed video durations, keyed by absolute path.
 * Mirror of `get-speed-stats` — needed because the scan itself doesn't
 * ffprobe (too slow for big libraries) and thumbnail-cache hits skip the
 * capture path that would have populated duration inline. Renderer polls
 * after register to hydrate durations so Sort-by-Duration works without
 * the user having to scroll past every card first.
 */
ipcMain.handle('get-durations', async () => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/api/media/durations`;
  try {
    const resp = await fetchWithTimeout(url, {}, 5000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    log.warn(`get-durations failed: ${err.message}`);
    return {};
  }
});

ipcMain.handle('convert-funscript', async (_event, funscriptContent) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/scripts/convert`;
  try {
    // 15s: conversion is pure CPU / JSON; anything over this is a hang.
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: funscriptContent,
    }, 15000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    log.error('Funscript conversion failed:', err.message);
    return null;
  }
});

// --- Data Export/Import ---

ipcMain.handle('export-data', async () => {
  const { exportData } = require('./data-export');

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export FunSync Backup',
    defaultPath: 'funsync-backup.zip',
    filters: [{ name: 'FunSync Backup', extensions: ['zip'] }],
  });

  if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };

  const configData = store.getAll();
  return exportData(configData, result.filePath);
});

ipcMain.handle('import-data', async () => {
  const { importData, mergeConfig } = require('./data-export');

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import FunSync Backup',
    filters: [{ name: 'FunSync Backup', extensions: ['zip'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'Cancelled' };

  const importResult = await importData(result.filePaths[0], 'merge');
  if (!importResult.success) return importResult;

  // Snapshot the pre-import state — merging an arbitrary backup file
  // can mutate sources, collections, playlists, categories, and even
  // the encrypted Handy key. If the user picks the wrong file, this
  // is the snapshot they'll roll back to.
  await _preActionSnapshot('pre-import');

  // Merge imported config into existing
  const existing = store.getAll();
  const merged = mergeConfig(existing, importResult.config, 'merge');

  // Apply merged settings
  if (merged.settings) {
    for (const [key, value] of Object.entries(merged.settings)) {
      store.setSetting(key, value);
    }
  }

  return { success: true, funscriptCount: (importResult.funscripts || []).length };
});

// --- IPC Handlers: Backup & Recovery ---

// Renderer asks once on first paint whether the just-completed boot
// recovered from a snapshot. Result is cleared after read so a F5 in
// devtools doesn't replay the toast.
ipcMain.handle('backup:get-boot-result', () => {
  const r = _recoveryResult;
  _recoveryResult = { recovered: false }; // consume
  return r;
});

ipcMain.handle('backup:list', async () => {
  try {
    const userDataDir = app.getPath('userData');
    const paths = dataBackup.resolvePaths(userDataDir);
    const manifest = await dataBackup.loadManifest(paths.backupDir);
    // Sort newest first so the UI shows the freshest entry at the top.
    const sorted = [...manifest.snapshots].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return { success: true, snapshots: sorted };
  } catch (err) {
    log.warn('[Backup] list failed:', err.message);
    return { success: false, error: err.message, snapshots: [] };
  }
});

ipcMain.handle('backup:snapshot-now', async () => {
  try {
    const userDataDir = app.getPath('userData');
    // Cancel any pending debounced snapshot — the manual one we're
    // about to take supersedes it (avoids two snapshots within seconds
    // of each other from the same state).
    dataBackup.cancelScheduled();
    const entry = await dataBackup.takeSnapshot({
      userDataDir,
      config: store.getAll(),
      trigger: dataBackup.TRIGGER.MANUAL,
    });
    dataBackup.pruneOld({ userDataDir }).catch(() => {});
    return { success: true, entry };
  } catch (err) {
    log.error('[Backup] manual snapshot failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('backup:restore', async (_event, { subdir, filename }) => {
  // Restore flow:
  //   1. Take a pre-action snapshot ("pre-restore") of current state so
  //      the user can undo a regrettable restore.
  //   2. Read + verify the chosen snapshot (parses + sha256 matches).
  //   3. Atomically replace config.json on disk.
  //   4. Relaunch — electron-conf has the old state cached in memory,
  //      so the only safe way to flip to the restored content is to
  //      restart the process.
  if (!subdir || !filename) {
    return { success: false, error: 'subdir and filename required' };
  }
  if (subdir !== 'snapshots' && subdir !== 'pre-action') {
    return { success: false, error: 'invalid subdir' };
  }
  try {
    const userDataDir = app.getPath('userData');
    const paths = dataBackup.resolvePaths(userDataDir);

    // Step 1: pre-restore snapshot of the current live state.
    await dataBackup.takeSnapshot({
      userDataDir,
      config: store.getAll(),
      trigger: dataBackup.TRIGGER.PRE_ACTION,
      label: 'pre-restore',
    });

    // Step 2: read + verify the chosen snapshot file.
    const snapshotPath = path.join(paths.backupDir, subdir, filename);
    const raw = await fs.promises.readFile(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.config || !parsed?.metadata) {
      return { success: false, error: 'snapshot missing config or metadata' };
    }
    if (parsed.metadata.sha256) {
      // Re-hash the bytes that landed on disk and compare. Mismatched
      // hash = restore would write bad data; refuse instead.
      const expected = parsed.metadata.sha256;
      const actual = require('crypto')
        .createHash('sha256')
        .update(JSON.stringify(parsed.config))
        .digest('hex');
      if (expected !== actual) {
        return { success: false, error: 'snapshot SHA-256 mismatch — refusing restore' };
      }
    }

    // Step 3: atomically replace config.json.
    await dataBackup.atomicWriteFile(
      paths.configPath,
      JSON.stringify(parsed.config, null, 2)
    );

    // Step 4: relaunch. Skip the QUIT snapshot path on the way out by
    // marking the guard — the file we just wrote IS the desired state.
    log.info(`[Backup] Restored from ${subdir}/${filename}; relaunching`);
    _finalSnapshotDone = true;
    if (_unsubscribeFromStore) {
      try { _unsubscribeFromStore(); } catch { /* ignore */ }
      _unsubscribeFromStore = null;
    }
    dataBackup.cancelScheduled();
    // Kill the backend BEFORE app.exit(0). app.exit skips both will-quit
    // and before-quit, so the standard stopBackend() hooks don't fire —
    // leaving an orphan backend racing the relaunched instance for port
    // 5123. The next-startup port sweep would eventually catch it, but
    // killing it here means the relaunch hits a clean port immediately.
    stopBackend();
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (err) {
    log.error('[Backup] restore failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Renderer-callable pre-action snapshot. The renderer calls this
// IMMEDIATELY before a destructive change (reset-defaults, delete-
// source, delete-collection, clear-routing, bulk-remove). Failure is
// logged but does NOT block the destructive op — losing the safety
// net is regrettable, refusing the user's action because of it would
// be worse. Per SCOPE-data-backup.md §4.7.
//
// Label is a short kebab-case operation name (e.g. "reset-defaults",
// "delete-source-Plex"). Sanitised down to filename-safe chars on the
// way through buildSnapshot so a user-supplied source name with
// punctuation can't break the path.
ipcMain.handle('backup:pre-action', async (_event, label) => {
  try {
    const safeLabel = String(label || 'unnamed-action')
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnamed-action';
    const entry = await dataBackup.takeSnapshot({
      userDataDir: app.getPath('userData'),
      config: store.getAll(),
      trigger: dataBackup.TRIGGER.PRE_ACTION,
      label: safeLabel,
    });
    log.info(`[Backup] Pre-action snapshot taken: ${safeLabel}`);
    return { success: true, entry };
  } catch (err) {
    log.warn(`[Backup] Pre-action snapshot failed (${label}):`, err.message);
    return { success: false, error: err.message };
  }
});

// === Editor pop-out window ===========================================
// Per SCOPE-editor-v2.md §5: pop-out takes full ownership (main shows
// only video while pop-out is open), state-sync is IPC-through-main, no
// auto-reopen on app restart. The window module owns the BrowserWindow
// lifecycle; these handlers expose it to the renderer.
ipcMain.handle('editor-popout:open', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, error: 'Main window unavailable' };
  }
  editorPopout.open(mainWindow, store);
  return { success: true };
});

ipcMain.handle('editor-popout:close', () => {
  editorPopout.close();
  return { success: true };
});

ipcMain.handle('editor-popout:status', () => {
  return { open: editorPopout.isOpen() };
});

// State-sync relay. The sender side passes a `direction` so we know
// whether to forward to the parent or to the pop-out — the main process
// is the broker. Single channel keeps the protocol observable in one
// place rather than forking into N typed channels.
ipcMain.handle('editor-popout:relay', (_event, direction, payload) => {
  editorPopout.relay(direction, payload);
  return { success: true };
});

// --- Audience pop-out (SCOPE-audience-broadcast.md §3.3) ---
// Same lifecycle shape as editor-popout. Channel: `audience-popout:event`.
// Bounds key: `audience.popoutBounds`. Room state lives in the main
// renderer's AudienceBridge — closing this window doesn't end the room.
ipcMain.handle('audience-popout:open', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, error: 'Main window unavailable' };
  }
  audiencePopout.open(mainWindow, store);
  return { success: true };
});

ipcMain.handle('audience-popout:close', () => {
  audiencePopout.close();
  return { success: true };
});

ipcMain.handle('audience-popout:status', () => {
  return { open: audiencePopout.isOpen() };
});

ipcMain.handle('audience-popout:relay', (_event, direction, payload) => {
  audiencePopout.relay(direction, payload);
  return { success: true };
});

// --- Player pop-out (SCOPE-separate-player-window.md — detached player) ---
// Same lifecycle shape as audience/editor pop-outs. Channel:
// `player-popout:event`. Bounds key: `player.popoutBounds`.
ipcMain.handle('player-popout:open', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, error: 'Main window unavailable' };
  }
  playerPopout.open(mainWindow, store);
  return { success: true };
});

ipcMain.handle('player-popout:close', () => {
  playerPopout.close();
  return { success: true };
});

ipcMain.handle('player-popout:status', () => {
  return { open: playerPopout.isOpen() };
});

ipcMain.handle('player-popout:relay', (_event, direction, payload) => {
  playerPopout.relay(direction, payload);
  return { success: true };
});

ipcMain.handle('backup:open-folder', async () => {
  const { shell } = require('electron');
  const userDataDir = app.getPath('userData');
  const paths = dataBackup.resolvePaths(userDataDir);
  const err = await shell.openPath(paths.backupDir);
  return err ? { success: false, error: err } : { success: true, path: paths.backupDir };
});

// --- File existence check ---

ipcMain.handle('file-exists', (_event, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
});

/**
 * Batch existence check. One IPC round trip for a whole playlist instead of
 * one per video — a 500-entry playlist on an external drive was 500 invokes,
 * each of which can block on a spun-down or disconnected volume.
 *
 * Returns an array of booleans positionally matching the input. Never throws:
 * an unreadable path is `false`, which is exactly how callers treat it.
 */
ipcMain.handle('files-exist', (_event, filePaths) => {
  if (!Array.isArray(filePaths)) return [];
  return filePaths.map((p) => {
    try {
      return typeof p === 'string' && p.length > 0 && fs.existsSync(p);
    } catch {
      return false;
    }
  });
});

// --- IPC Handlers: Shell ---

ipcMain.handle('open-external', async (_event, url) => {
  const { shell } = require('electron');
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  const { shell } = require('electron');
  if (filePath) shell.showItemInFolder(filePath);
});

// --- IPC Handler: System Locale (for first-launch i18n offer-toast) ---
//
// Renderer calls this at boot to decide whether to surface the
// "language detected" toast. `app.getLocale()` returns Chromium's
// best-guess locale (e.g. `zh-CN`, `en-US`). The renderer's i18n module
// folds the regional variant into the language-base code per the locked
// IMPL-multi-language.md decisions (variant policy = language base).
ipcMain.handle('get-system-locale', () => {
  try { return app.getLocale() || 'en'; } catch { return 'en'; }
});

// --- IPC Handlers: TCode (multi-transport — serial / UDP / WebSocket) ---

const { createTransport } = require('./tcode-transports');

// Module-level handle to the active transport (only one at a time —
// connecting a new transport tears down the previous). Initial value is
// null so the first connect attempt builds a fresh instance.
let tcodeTransport = null;
let tcodeTransportKind = null;

function broadcastTcodeDisconnected() {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tcode-disconnected'));
}

async function tearDownActiveTcodeTransport() {
  if (!tcodeTransport) return;
  try { tcodeTransport.destroy(); } catch {}
  tcodeTransport = null;
  tcodeTransportKind = null;
}

ipcMain.handle('tcode-list-ports', async () => {
  // Serial-specific — UDP and WebSocket transports don't enumerate; the
  // user types the address directly in the connection-panel inputs.
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return ports.map(p => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
    }));
  } catch (err) {
    log.warn('[TCode] Failed to list ports:', err.message);
    return [];
  }
});

/**
 * Unified connect handler. Renderer passes a transport kind plus
 * transport-specific options:
 *   - serial:    { path, baudRate }
 *   - udp:       { host, port }
 *   - websocket: { url }
 *
 * Legacy two-arg form `(portPath, baudRate)` from pre-UDP renderers is
 * still accepted — falls through to the serial branch with default kind.
 */
ipcMain.handle('tcode-connect', async (_event, kindOrPath, optsOrBaud) => {
  // Back-compat: old renderer calls `tcode-connect(path, baudRate)`. The
  // first arg is a string path (not a kind keyword). Map it onto the new
  // shape so the rest of the handler stays uniform.
  let kind;
  let opts;
  if (typeof kindOrPath === 'string'
      && kindOrPath !== 'serial'
      && kindOrPath !== 'udp'
      && kindOrPath !== 'websocket'
      && kindOrPath !== 'ws') {
    kind = 'serial';
    opts = { path: kindOrPath, baudRate: typeof optsOrBaud === 'number' ? optsOrBaud : 115200 };
  } else {
    kind = kindOrPath;
    opts = optsOrBaud || {};
  }

  await tearDownActiveTcodeTransport();
  try {
    tcodeTransport = createTransport(kind, { log });
    tcodeTransportKind = kind;
    tcodeTransport.onDisconnect(() => {
      tcodeTransport = null;
      tcodeTransportKind = null;
      broadcastTcodeDisconnected();
    });
    const result = await tcodeTransport.connect(opts);
    if (!result?.success) {
      // Leave the slot empty so subsequent send() calls don't pretend to
      // be connected.
      await tearDownActiveTcodeTransport();
    }
    return result;
  } catch (err) {
    log.warn('[TCode] Connect error:', err.message);
    await tearDownActiveTcodeTransport();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('tcode-disconnect', async () => {
  await tearDownActiveTcodeTransport();
  log.info('[TCode] Disconnected');
  return { success: true };
});

ipcMain.handle('tcode-send', (_event, command) => {
  if (!tcodeTransport) return false;
  return tcodeTransport.send(command);
});

ipcMain.handle('tcode-status', () => {
  return {
    connected: !!(tcodeTransport && tcodeTransport.connected),
    transport: tcodeTransportKind,
  };
});

// --- IPC Handlers: VR Bridge (TCP) ---

let vrSocket = null;
let vrKeepAliveTimer = null;

ipcMain.handle('vr-connect', async (_event, host, port) => {
  const net = require('net');

  // Clean up existing connection
  if (vrSocket) {
    vrSocket.removeAllListeners();
    vrSocket.destroy();
    vrSocket = null;
  }
  if (vrKeepAliveTimer) {
    clearInterval(vrKeepAliveTimer);
    vrKeepAliveTimer = null;
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let connected = false;
    let buffer = Buffer.alloc(0);

    socket.setTimeout(5000);

    socket.connect(port || 23554, host || '127.0.0.1', () => {
      connected = true;
      resolved = true;
      vrSocket = socket;
      log.info(`[VR] Connected to ${host}:${port}`);

      // Keep-alive: send zero-length packet every 1s (4 bytes of zeros)
      // This matches MultiFunPlayer's protocol — DeoVR/HereSphere drop after 3s of silence
      vrKeepAliveTimer = setInterval(() => {
        if (vrSocket) {
          try {
            vrSocket.write(Buffer.alloc(4, 0)); // [0,0,0,0] = zero-length packet
          } catch { /* ignore write errors */ }
        }
      }, 1000);

      resolve({ success: true });
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse packets: 4-byte LE length + JSON payload
      while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) break; // incomplete packet

        const json = buffer.slice(4, 4 + len).toString('utf-8');
        buffer = buffer.slice(4 + len);

        try {
          const data = JSON.parse(json);
          // Attach a main-process arrival timestamp so the renderer can
          // compute network jitter from the spread between consecutive
          // arrivals. HereSphere/DeoVR send timestamp packets at a
          // ~regular cadence; arrival jitter ≈ network jitter, the
          // best proxy we can derive from a one-way protocol.
          data._arrivalMs = Date.now();
          BrowserWindow.getAllWindows().forEach(w =>
            w.webContents.send('vr-state', data)
          );
        } catch (err) {
          log.debug('[VR] Failed to parse JSON:', err.message);
        }
      }
    });

    let resolved = false;

    socket.on('close', () => {
      if (vrKeepAliveTimer) { clearInterval(vrKeepAliveTimer); vrKeepAliveTimer = null; }
      // Only send disconnected event if we were previously connected
      if (connected) {
        log.info('[VR] Connection closed');
        vrSocket = null;
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('vr-disconnected'));
      }
      connected = false;
    });

    socket.on('error', (err) => {
      // ECONNREFUSED is the EXPECTED state when HereSphere/DeoVR isn't
      // listening on port 23554 (no video playing, headset asleep,
      // timestamp server toggle off, etc.). Demoting to debug so the
      // log isn't full of noise during normal use. Other errors stay
      // at warn because those are genuine network issues users should
      // see (firewall, host unreachable, connection reset, etc.).
      if (err.code === 'ECONNREFUSED') {
        log.debug('[VR] Socket error (expected when no VR app listening):', err.message);
      } else {
        log.warn('[VR] Socket error:', err.message);
      }
      if (!resolved) {
        resolved = true;
        vrSocket = null;
        resolve({ success: false, error: err.message });
      }
    });

    socket.on('timeout', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        vrSocket = null;
        resolve({ success: false, error: 'Connection timed out' });
      }
    });
  });
});

ipcMain.handle('vr-disconnect', () => {
  if (vrSocket) {
    vrSocket.removeAllListeners();
    vrSocket.destroy();
    vrSocket = null;
  }
  if (vrKeepAliveTimer) {
    clearInterval(vrKeepAliveTimer);
    vrKeepAliveTimer = null;
  }
  log.info('[VR] Disconnected');
  return { success: true };
});

ipcMain.handle('vr-send', (_event, jsonStr) => {
  if (!vrSocket) return false;
  try {
    const payload = Buffer.from(jsonStr);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    vrSocket.write(Buffer.concat([header, payload]));
    return true;
  } catch { return false; }
});

// --- IPC Handlers: Autoblow ---

const autoblowApi = require('./autoblow-api.js');

ipcMain.handle('autoblow-connect', async (_event, token) => {
  try {
    const result = await autoblowApi.connect(token);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('autoblow-disconnect', () => {
  autoblowApi.disconnect();
  return { success: true };
});

ipcMain.handle('autoblow-status', () => ({
  connected: autoblowApi.isConnected(),
  deviceType: autoblowApi.getDeviceType(),
}));

ipcMain.handle('autoblow-upload-script', async (_event, funscriptContent) => {
  try {
    await autoblowApi.syncScriptUploadFunscript(funscriptContent);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('autoblow-sync-start', async (_event, startTimeMs) => {
  try {
    await autoblowApi.syncScriptStart(startTimeMs);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('autoblow-sync-stop', async () => {
  try {
    await autoblowApi.syncScriptStop();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('autoblow-sync-offset', async (_event, offsetMs) => {
  try {
    await autoblowApi.syncScriptOffset(offsetMs);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('autoblow-latency', async () => {
  try {
    const latency = await autoblowApi.estimateLatency();
    return { success: true, latency };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- IPC Handlers: Auto-Updater ---

ipcMain.handle('updater-check', () => {
  if (IS_PORTABLE) return; // no auto-update for portable builds
  checkForUpdates();
});

ipcMain.handle('updater-download', () => {
  downloadUpdate();
});

ipcMain.handle('updater-install', () => {
  quitAndInstall();
});

// --- IPC Handlers: EroScripts ---

// Open a child BrowserWindow pointing at the eroscripts login page so
// the user authenticates via the real Discourse UI — TOTP, backup
// codes, AND hardware keys (WebAuthn) all just work because the user
// is in a real browser context. Our previous in-app modal could only
// handle TOTP because WebAuthn requires `navigator.credentials.get()`
// against the secure origin with a user gesture, which Node `fetch`
// can't produce. After login, we read the `_t` session cookie out of
// the partition's cookie jar, verify the session via /session/current,
// and hand the cookie + username back to the renderer.
//
// A dedicated session partition (`persist:eroscripts-login`) keeps
// the cookies out of the main app session and lets `logout` clear
// them cleanly.
ipcMain.handle('eroscripts-login-window', async () => {
  const { session } = require('electron');
  const partition = 'persist:eroscripts-login';
  const sess = session.fromPartition(partition);

  // Force a real Chrome UA on the partition so Cloudflare's bot
  // scoring doesn't serve the "Server is currently experiencing high
  // load" page (which it routes Electron's default UA to in some
  // configs even when actual load is fine). Same UA we already use
  // for our REST API client. Set on the session, not just the window,
  // so the cookie/CSRF preflights also adopt it.
  const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  sess.setUserAgent(CHROME_UA);

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Log in to EroScripts',
    parent: mainWindow,
    modal: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setUserAgent(CHROME_UA);

  return new Promise((resolve) => {
    let settled = false;
    const finalize = (result) => {
      if (settled) return;
      settled = true;
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };

    const tryCaptureSession = async () => {
      if (settled) return;
      try {
        const tCookies = await sess.cookies.get({
          url: 'https://discuss.eroscripts.com',
          name: '_t',
        });
        if (tCookies.length === 0) return;

        // Build full cookie header so /session/current sees everything
        // Discourse expects (cf_clearance + _forum_session + _t).
        const allCookies = await sess.cookies.get({
          url: 'https://discuss.eroscripts.com',
        });
        const cookieHeader = allCookies
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');

        const resp = await fetch(
          'https://discuss.eroscripts.com/session/current.json',
          {
            headers: {
              Cookie: cookieHeader,
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Accept: 'application/json',
            },
          },
        );
        if (!resp.ok) return;
        const text = await resp.text();
        if (text.startsWith('<')) return; // Cloudflare / login redirect
        const data = JSON.parse(text);
        const username = data?.current_user?.username;
        if (!username) return;

        // Adopt the cookies into our API client so subsequent search /
        // download calls go out authenticated. Pass the full cookie
        // string (not just _t) so cf_clearance ride along.
        eroScripts.restoreSession(tCookies[0].value, username);
        eroScripts._sessionCookies = cookieHeader;

        finalize({
          success: true,
          cookie: tCookies[0].value,
          username,
        });
      } catch (err) {
        log.warn('[EroScripts] login-window capture error:', err.message);
      }
    };

    // Catch upstream HTTP 5xx (502/503/504/etc.) on the main-frame
     // load. Discourse + Cloudflare can serve these as bare error
     // pages with a blank-looking body — `did-fail-load` doesn't fire
     // for HTTP errors (only for low-level network failures), so the
     // window would otherwise hang on a white screen forever.
    const onMainFrameCompleted = (details) => {
      if (settled) return;
      if (details.resourceType !== 'mainFrame') return;
      if (details.statusCode >= 500 && details.statusCode < 600) {
        finalize({
          success: false,
          error: `EroScripts is unreachable right now (HTTP ${details.statusCode}) — try again in a few minutes.`,
        });
      }
    };
    sess.webRequest.onCompleted(
      { urls: ['*://discuss.eroscripts.com/*'] },
      onMainFrameCompleted,
    );

    // Detect Discourse's "Server is currently experiencing high load"
    // page (HTTP 200 with a static HTML body — not an error code we can
    // catch via the webRequest hook above). Read the document text
    // after each load and bail with a friendly toast instead of
    // stranding the user on an unusable page.
    const checkHighLoadPage = async () => {
      if (settled) return;
      try {
        const bodyText = await win.webContents.executeJavaScript(
          'document.body && document.body.innerText || ""',
          true,
        );
        if (
          /experiencing high load/i.test(bodyText) ||
          /please try again later/i.test(bodyText)
        ) {
          finalize({
            success: false,
            error:
              'EroScripts is busy right now — try logging in again in a minute or two.',
          });
        }
      } catch {
        /* page may have unloaded — ignore */
      }
    };

    win.webContents.on('did-navigate', tryCaptureSession);
    win.webContents.on('did-navigate-in-page', tryCaptureSession);
    win.webContents.on('did-finish-load', checkHighLoadPage);
    win.on('closed', () =>
      finalize({ success: false, error: 'Login cancelled' }),
    );

    // Already-logged-in case: Discourse redirects /login → / before the
    // user does anything, so kick off a capture attempt right after
    // load too. The above events handle the typical flow; this catches
    // the no-redirect edge case (page already shows logged-in state).
    win.webContents.once('did-finish-load', tryCaptureSession);

    win.loadURL('https://discuss.eroscripts.com/login').catch((err) => {
      log.warn('[EroScripts] login-window loadURL failed:', err.message);
      finalize({
        success: false,
        error: 'Could not open EroScripts login page — check your internet connection',
      });
    });
  });
});

ipcMain.handle('eroscripts-logout', async () => {
  eroScripts.logout();
  // Wipe the login partition so the next login starts clean. Without
  // this, Discourse's `_t` cookie persists in the partition and the
  // child window would silently re-authenticate the previous user.
  try {
    const { session } = require('electron');
    const sess = session.fromPartition('persist:eroscripts-login');
    await sess.clearStorageData({ storages: ['cookies'] });
  } catch (err) {
    log.warn('[EroScripts] logout: failed to clear partition cookies:', err.message);
  }
  return { success: true };
});

ipcMain.handle('eroscripts-restore-session', (_event, cookie, username) => {
  eroScripts.restoreSession(cookie, username);
  return { success: true };
});

ipcMain.handle('eroscripts-status', () => {
  return { loggedIn: eroScripts.isLoggedIn, username: eroScripts.username };
});

ipcMain.handle('eroscripts-validate', async () => {
  return eroScripts.validateSession();
});

ipcMain.handle('eroscripts-search', async (_event, query, page) => {
  return eroScripts.search(query, page);
});

ipcMain.handle('eroscripts-topic', async (_event, topicId) => {
  return eroScripts.getTopicAttachments(topicId);
});

ipcMain.handle('eroscripts-topic-image', async (_event, topicId) => {
  return eroScripts.getTopicImage(topicId);
});

ipcMain.handle('eroscripts-download', async (_event, url, savePath) => {
  return eroScripts.downloadFile(url, savePath);
});
