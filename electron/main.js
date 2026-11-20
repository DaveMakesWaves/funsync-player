const { app, BrowserWindow, ipcMain, dialog, Menu, globalShortcut, shell, webContents } = require('electron');
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
const {
  setRedactionEnabled, applyRedactionSetting, ensureLogFilesRedacted, rotatedLogPath,
  redactSecrets, noteSecretSetting, SECRET_SETTING_PATHS,
} = require('./log-redact');
const { startBackend, stopBackend, setHealthListener, startHealthMonitor, restartBackend, getHealthState, getHealthDetail } = require('./python-bridge');
const { resolveWindowColors } = require('./window-bg');
const store = require('./store');
const dataBackup = require('./data-backup');
const dataMigration = require('./data-migration');
const { initAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall } = require('./auto-updater');
const { EroScriptsAPI, EROSCRIPTS_USER_AGENT, installForumUserAgent } = require('./eroscripts-api');
const editorPopout = require('./editor-popout-window');
const audiencePopout = require('./audience-popout-window');
const playerPopout = require('./player-popout-window');
const { askRendererToStop, holdCloseForStop, QUIT_STOP_TIMEOUT_MS } = require('./relaunch-stop');
const { createUnsavedEditsGuard, bringToFront, resetUnlessQuitStarts } = require('./unsaved-edits-guard');
const { scanLibrary, rootListable } = require('./library-scan');
const { createStashService, STASH_IPC_CHANNELS } = require('./stash-ipc');
const { createStashSecret } = require('./stash-secret');
const { createStashLibraryFile } = require('./stash-library-file');

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

// Settings > Appearance > Interface size, kept in step with the View menu's
// zoom keys (Pudknocker #372, V79). Main window only; see electron/ui-scale.js.
const uiScale = require('./ui-scale').createUiScale({
  store,
  getMainWindow: () => mainWindow,
  getFocusedWebContents: () => webContents.getFocusedWebContents(),
  fromWebContents: (wc) => BrowserWindow.fromWebContents(wc),
  titleBarHeight: require('./window-bg').TITLE_BAR_HEIGHT,
  log,
});

// Per-window poll handles for holding the caption buttons visible while the
// cursor is over them (see the update-window-chrome handler). Keyed by
// BrowserWindow id — the pop-outs run the same chrome, so a single shared
// handle would let one window cancel another's hold.
const _captionHoverPolls = new Map();
// Per-window: is a dialog's backdrop up (FT-100)? Keyed like the polls.
const _captionDimmed = new Map();

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

// Disposer for the store-change subscription that arms debounced
// snapshots. Held so before-quit can clean up the listener before the
// app exits.
let _unsubscribeFromStore = null;

// Relaunch after config.json was replaced underneath the running app
// (Restore From Backup, Import Backup File). Every in-memory copy of the
// old config, above all the renderer's DataService cache, would otherwise
// keep writing the old state back over the new one.
//
// Skips the QUIT snapshot by marking the guard: the file on disk IS the
// desired state. Kills the backend BEFORE app.exit(0), because app.exit
// skips both will-quit and before-quit, so the standard stopBackend()
// hooks don't fire, leaving an orphan backend racing the relaunched
// instance for port 5123. The next-startup port sweep would eventually
// catch it, but killing it here means the relaunch hits a clean port.
function _relaunchWithConfigOnDisk() {
  _finalSnapshotDone = true;
  // Callers stop playback and devices first (_stopPlaybackBeforeRelaunch):
  // app.exit skips the renderer's beforeunload, which is where that
  // normally happens.
  if (_unsubscribeFromStore) {
    try { _unsubscribeFromStore(); } catch { /* ignore */ }
    _unsubscribeFromStore = null;
  }
  dataBackup.cancelScheduled();
  stopBackend();
  app.relaunch();
  app.exit(0);
}

// Have the main window pause playback and stop every device (Handy HSSP,
// Buttplug, T-Code, Autoblow, audience room) before a relaunch, and wait
// for it, bounded. Without this a Handy kept playing the script on its own
// after Import or Restore. See electron/relaunch-stop.js.
async function _stopPlaybackBeforeRelaunch() {
  const startedAt = Date.now();
  const outcome = await askRendererToStop({
    webContents: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null,
    ipcMain,
  });
  const line = `[Backup] Stop playback and devices before relaunch: ${outcome} (${Date.now() - startedAt} ms)`;
  if (outcome === 'stopped') log.info(line);
  else log.warn(line);
}

// Closing the main window with an audience room open (its pop-out is open
// exactly while a room is): stop every viewer's device first, bounded. The
// window X never reaches before-quit while this window is alive, so this is
// the quit path that matters most (#361). See relaunch-stop.js. Installed
// after each createWindow().
function _holdMainWindowCloseForAudienceStop() {
  if (!mainWindow) return;
  _quitStopGuard = holdCloseForStop({
    win: mainWindow,
    ipcMain,
    // Not while the unsaved-edits question holds this close (R3-19): a
    // Cancel there must not have stopped the room's devices.
    shouldStop: () => audiencePopout.isOpen() && !_unsavedEdits.asking(),
    onOutcome: (outcome, ms) => {
      const line = `[Audience] Stop devices before closing with a room open: ${outcome} (${ms} ms)`;
      if (outcome === 'stopped') log.info(line);
      else log.warn(line);
    },
  });
}

// Resolves when the Python backend has booted (or startBackend gave up —
// it always resolves within 10s). fetchWithTimeout awaits this so backend
// proxy IPC issued while the window is ahead of uvicorn waits instead of
// failing. Null until whenReady kicks the parallel boot off.
let _backendReadyPromise = null;

// Guard for the deferred-quit flow. before-quit fires twice: once when
// we e.preventDefault() to take a final snapshot, and a second time
// after we re-call app.quit(). The flag prevents an infinite loop.
let _finalSnapshotDone = false;

// Holds the main window's close for a device stop while an audience room is
// open; before-quit marks it stopped so a quit is never held twice.
let _quitStopGuard = null;

// Unsaved script-editor edits (autosave off): asked about before the main
// window closes, the app quits, a window reloads, an update installs or
// Import / Restore relaunches; they were dropped without a word (R3-19, also
// in v0.9.2). The renderer answers with the CB-01 question. See
// electron/unsaved-edits-guard.js.
const _unsavedEdits = createUnsavedEditsGuard({ ipcMain, log });

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
  // The saved interface size (V79), applied by Electron when the page
  // commits, before its first paint: no frame at 100% before a jump.
  const scaleOpts = uiScale.windowOptions();
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
        // matches .nav-bar height (48 CSS px) at the window's zoom, so the
        // caption buttons align with it at any interface size (V79)
        height: scaleOpts.titleBarHeight,
      },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      zoomFactor: scaleOpts.zoomFactor,
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
    // What the first frame was drawn at, so a report of a wrong size can
    // be told apart from a late apply.
    if (scaleOpts.scale !== 100) {
      log.info(`[UI scale] Window shown at ${Math.round(mainWindow.webContents.getZoomFactor() * 100)}% (saved ${scaleOpts.scale}%)`);
    }
    mainWindow.show();
    // electron-builder's auto-updater doesn't support the portable target
    // (no latest.yml is published for it), so skip it entirely in portable
    // mode — the user updates by replacing the exe. See SCOPE-portable-install.
    if (app.isPackaged && !IS_PORTABLE) {
      // The detached player window shows the update notices too (FT-101).
      initAutoUpdater(mainWindow, { getExtraWindows: () => [playerPopout.getWindow()] });
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

// View > Reload / Force Reload (Ctrl+R / Ctrl+Shift+R) in the focused
// window. The main window's page holds the script editor, so a reload of it
// asks about unsaved edits first; Cancel keeps the page (R3-19). Pop-outs
// hold no edits of their own and reload at once, as with the roles.
async function _reloadWindow(win, ignoreCache) {
  if (!win || win.isDestroyed()) return;
  if (win === mainWindow && !(await _unsavedEdits.confirm('reloading the window'))) return;
  if (win.isDestroyed()) return;
  if (ignoreCache) win.webContents.reloadIgnoringCache();
  else win.webContents.reload();
}

// Custom application menu. Mirrors Electron's default role-based menu
 // but overrides the zoomIn accelerator: the default is
 // `CommandOrControl+Plus`, which Electron parses as the literal `+`
 // character — and on US/UK keyboards that requires Shift+=, so users
 // were forced to press Ctrl+Shift+= to zoom in. Browsers (Chrome,
 // Firefox, Edge) bind to the physical `=` key instead, so Ctrl+= just
 // works without Shift. Match that. The zoom items now come from
 // electron/ui-scale.js, which keeps them in step with the saved interface
 // size (V79).
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Not the built-in roles: a reload of the main window asks about
        // unsaved editor edits first, as a close does (R3-19). Same labels
        // and keys as the roles.
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (_item, win) => _reloadWindow(win, false) },
        { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: (_item, win) => _reloadWindow(win, true) },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Actual Size / Zoom In / Zoom Out. Not the built-in roles: in the
        // main window each press steps Settings > Appearance > Interface
        // size and saves it (V79); in a pop-out they still zoom that window.
        ...uiScale.menuItems(),
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
    } else if (_recoveryResult.fresh) {
      log.info('[Backup] No config.json and no backup history: first launch, starting with defaults.');
    }
  } catch (err) {
    log.error('[Backup] verifyAndRecover threw — continuing with defaults:', err.message);
    _recoveryResult = { recovered: false };
  }
  log.info(`[Timing main] verifyAndRecover: ${Date.now() - _tRecover}ms`);

  const _tStore = Date.now();
  await store.initStore();
  log.info(`[Timing main] store.initStore: ${Date.now() - _tStore}ms`);
  // A one-time migration rewrote a stored value (store.js MIGRATIONS), e.g.
  // T-Code 25 Hz → 60 Hz. Logged so a changed setting can be explained.
  const _migrationsApplied = store.appliedMigrations();
  if (_migrationsApplied.length > 0) {
    log.info(`[Store] One-time migrations applied: ${_migrationsApplied.join(', ')}`);
  }

  // Apply the saved log-redaction preference now the store is readable.
  // logger.js is required long before this point, so it starts with
  // redaction off and picks up the user's choice here.
  setRedactionEnabled(store.getSetting('security.hideLogFileNames'));
  // The stored keys, token and cookie, masked on every log line (FT-010).
  for (const p of SECRET_SETTING_PATHS) noteSecretSetting(p, store.getSetting(p));
  // Stash: read its data file and key file (masked from here on). No request.
  stash.init();

  // Wire snapshot scheduling: every store write debounces a 60 s
  // snapshot. store.subscribe() hears the store's own writes rather than
  // electron-conf's onDidAnyChange, which missed nested and in-place
  // writes, i.e. almost all of them (V05). The blacklist filter inside
  // data-backup keeps high-churn caches (thumbnail/duration/speed) out of
  // the snapshot bytes; the timer still arms on those writes, which is
  // fine: the snapshot strips them, and a debounced snapshot whose hash
  // matches the newest one is skipped.
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

  // Forum images the windows load themselves (search thumbnails, avatars)
  // send the EroScripts User-Agent too, on the session every window uses;
  // other hosts keep theirs (review-b RB-3). Before the first window.
  try {
    const { session } = require('electron');
    installForumUserAgent(session.defaultSession);
  } catch (err) {
    log.warn('[EroScripts] forum User-Agent hook not set:', err?.message || err);
  }

  const _tWindow = Date.now();
  createWindow();
  // Before the audience hold: the unsaved-edits question decides first (R3-19).
  _unsavedEdits.attach(mainWindow);
  _holdMainWindowCloseForAudienceStop();
  log.info(`[Timing main] createWindow: ${Date.now() - _tWindow}ms`);

  log.info(`[Timing main] total before window opens: ${Date.now() - _t0}ms`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      _unsavedEdits.attach(mainWindow);
      _holdMainWindowCloseForAudienceStop();
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
  // Unsaved editor edits are asked about first (R3-19): Cancel, or a
  // question already open (a second Ctrl+Q, a close), keeps the app running,
  // with nothing below done yet. A renderer that cannot ask lets it go.
  if (!(await _unsavedEdits.confirm('quitting'))) return;
  _finalSnapshotDone = true;

  // An audience room is open: stop every viewer's device before quitting,
  // bounded (#361, research §4.11). Their Handys play on their own clocks,
  // and beforeunload alone may never get the stops out.
  if (audiencePopout.isOpen() && mainWindow && !mainWindow.isDestroyed() && !_quitStopGuard?.stopped()) {
    _quitStopGuard?.markStopped();
    const startedAt = Date.now();
    const outcome = await askRendererToStop({
      webContents: mainWindow.webContents,
      ipcMain,
      timeoutMs: QUIT_STOP_TIMEOUT_MS,
    });
    const line = `[Audience] Stop devices before quitting with a room open: ${outcome} (${Date.now() - startedAt} ms)`;
    if (outcome === 'stopped') log.info(line);
    else log.warn(line);
  }

  // Stash: stop a running sync (it writes what finished), finish a pending
  // Remove Stash data, wait for the last write. Bounded.
  await Promise.race([stash.shutdown(), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => {});

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
  // The page never answered the unsaved-edits question (hung): its window
  // would hold the quit until the page recovered, frozen and with no backend
  // (R3 fix-up, verifier 1: open 26 s after a 25 s busy loop). Closed for good.
  if (_unsavedEdits.rendererHung() && mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
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

// --- Global hotkeys -------------------------------------------------------
//
// Opt-in OS-wide accelerators for play/pause, Orgasm Switch and Edge Hold
// (Eroto, EroScripts #316). See electron/global-shortcuts.js for why they
// live here and how a failure is reported (taken vs invalid, V48).
const { createGlobalShortcuts } = require('./global-shortcuts');
const globalHotkeys = createGlobalShortcuts({
  globalShortcut,
  log,
  onFire: (action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('global-shortcut', action);
    }
  },
});

ipcMain.handle('set-global-shortcuts', (_e, bindings) => globalHotkeys.apply(bindings || {}));

// --- Stash S1 (notes/features/DESIGN-stash-s1.md) ---------------------------
// Every `stash-*` channel is answered by electron/stash-ipc.js, and only
// there (no reply ever carries the API key: secret-settings-parity.test.js).
// The data file and the key live under userData/stash, main their only
// writer. Nothing is sent to Stash at start-up: init() reads two local files.
const stashLibrary = createStashLibraryFile({ dir: path.join(app.getPath('userData'), 'stash'), log });
const stash = createStashService({
  userDataDir: app.getPath('userData'),
  store,
  secret: createStashSecret({ userDataDir: app.getPath('userData') }),
  library: stashLibrary,
  send: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  },
  openExternal: (url) => shell.openExternal(url),
  log,
});
for (const channel of STASH_IPC_CHANNELS) {
  ipcMain.handle(channel, (_event, ...args) => stash.handlers[channel](...args));
}

// Electron does not release these on quit by itself.
app.on('will-quit', () => globalHotkeys.unregisterAll());

ipcMain.handle('get-backend-port', () => {
  const { getBackendPort } = require('./python-bridge');
  return getBackendPort();
});

// Backend health snapshot — used by the renderer banner on first paint
// (the IPC `backend-status` event only fires on transitions, so a fresh
// renderer needs to ask for the current state to know if it should
// already be showing the banner).
ipcMain.handle('get-backend-health', () => {
  // Detail as well as state: the renderer subscribes AFTER startBackend has
  // already run, so a 'backend executable missing' emitted during startup
  // would otherwise be lost and the user would get the generic message.
  return { state: getHealthState(), detail: getHealthDetail() };
});

// User-initiated restart from the disconnected banner.
ipcMain.handle('restart-backend', async () => {
  log.info('[Backend] user-initiated restart');
  _thumbFailed.clear(); // a fixed backend gets every thumbnail asked again
  try {
    await restartBackend();
    return { success: true };
  } catch (err) {
    log.error('[Backend] restart failed:', err.message);
    return { success: false, error: err.message };
  }
});

// The log files a user can be handed: the live main.log and the one rotated
// copy electron-log keeps beside it (main.old.log).
function _logFilePaths() {
  const current = log.transports?.file?.getFile?.()?.path;
  return current ? [current, rotatedLogPath(current)] : [];
}

// After "Hide file names in logs" rewrote the files on disk (V56).
function _reportLogRewrite(results, t0) {
  if (!results) return;
  // electron-log tracks main.log's size as its first stat plus the bytes it
  // has written since. A rewrite makes that stale, so make it stat again,
  // or the next rotation fires early.
  try { log.transports.file.getFile().reset(); } catch { /* best effort */ }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    log.warn(`[Logs] Could not hide file names in ${failed.length} existing log file(s): ${failed.map((r) => r.error).join('; ')}`);
  } else {
    const changed = results.filter((r) => r.changed).length;
    log.info(`[Logs] Hid file names in the existing log (${changed} file(s) rewritten, ${Date.now() - t0}ms)`);
  }
}

// "View logs" affordance — opens the electron-log file in the OS's
// default editor. Path resolved at runtime (depends on app userData
// directory which differs between dev and packaged builds).
//
// With "Hide file names in logs" on, the files are swept first (once per
// session), so the log the user is about to read or paste holds no name
// written before the toggle, or by an older version (V56).
ipcMain.handle('open-log-file', async () => {
  const { shell } = require('electron');
  const logPath = log.transports?.file?.getFile?.()?.path;
  if (!logPath) return { success: false, error: 'Log file path not available' };
  const t0 = Date.now();
  _reportLogRewrite(ensureLogFilesRedacted(_logFilePaths()), t0);
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
  const t0 = Date.now();
  _reportLogRewrite(ensureLogFilesRedacted(_logFilePaths()), t0);
  const folderPath = path.dirname(logPath);
  const err = await shell.openPath(folderPath);
  return err ? { success: false, error: err, path: folderPath } : { success: true, path: folderPath };
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Portable-mode status for the About section (Nielsen #1 — let the user see
// where their data lives). dataDir is the portable `data/` folder when active.
// --- Duplicate finder -----------------------------------------------------
//
// pallokala2 (#330) wants duplicates found so he can get disk space back, so
// the renderer needs real byte sizes, and the end of the flow deletes files.
// Both halves live here because the renderer has no filesystem access.

/**
 * Stat a batch of video paths. Missing/unreadable files come back with
 * `size: null` rather than throwing — a library always has a few dead paths
 * and one of them must not abort the whole scan.
 */
ipcMain.handle('stat-video-files', async (_event, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  const out = {};
  for (const p of list) {
    if (typeof p !== 'string' || !p) continue;
    try {
      const st = await fs.promises.stat(p);
      out[p] = st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : { size: null };
    } catch {
      out[p] = { size: null };
    }
  }
  return out;
});

/**
 * Sampled content hash for the "Identical" tier (FT-B01): same size and
 * runtime is not proof of the same bytes. READ-ONLY (electron/content-hash.js
 * opens with 'r' and only reads); unreadable files come back `hash: null`.
 * The renderer sends only files that share an exact size with another one.
 */
ipcMain.handle('hash-video-files', async (_event, paths) => {
  const { hashFilesSampled } = require('./content-hash');
  return hashFilesSampled(Array.isArray(paths) ? paths : []);
});

/**
 * Move files to the OS Recycle Bin / Trash.
 *
 * `shell.trashItem`, never `fs.unlink`. This is the only destructive action in
 * the app and it is driven by a heuristic, so it MUST be recoverable by the
 * user without us: a wrong batch is undone from the Recycle Bin. Permanent
 * deletion is deliberately not implemented.
 *
 * Guards, in order of what they prevent:
 *   - non-strings and empties, which would throw
 *   - anything that is not a regular FILE, so a bad path can never take a
 *     directory with it
 *   - per-file try/catch, so one locked or missing file does not abandon the
 *     rest of the batch half-done with no report of what happened
 *
 * Returns a per-path result so the UI can say exactly what did and did not go.
 */
ipcMain.handle('trash-video-files', async (_event, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  const results = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p) {
      results.push({ path: String(p), ok: false, error: 'invalid path' });
      continue;
    }
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) {
        results.push({ path: p, ok: false, error: 'not a file' });
        continue;
      }
      await shell.trashItem(p);
      log.info(`[Duplicates] Moved to trash: ${p}`);
      results.push({ path: p, ok: true, size: st.size });
    } catch (err) {
      log.warn(`[Duplicates] Could not trash ${p}: ${err.message}`);
      results.push({ path: p, ok: false, error: err.message });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  log.info(`[Duplicates] Trash batch: ${results.length - failed} moved, ${failed} failed`);
  return results;
});

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
    // The tail can reach back into lines from before the toggle (V56).
    const t0 = Date.now();
    _reportLogRewrite(ensureLogFilesRedacted(_logFilePaths()), t0);
    try {
      const raw = await fs.promises.readFile(logPath, 'utf8');
      // Tolerate CRLF (Windows) and LF (Linux/Mac). Without the regex,
      // Windows log lines would carry a trailing \r into the GitHub
      // issue body — cosmetic, but worth fixing.
      const lines = raw.trim().split(/\r?\n/);
      // Goes into a GitHub issue body. Lines written before this version, or
      // before a key was registered, are masked here too (FT-010).
      logTail = redactSecrets(lines.slice(-80).join('\n'));
    } catch (err) {
      logTail = `(log read failed: ${err.message})`;
    }
  }
  // getHealthState() is a string ('unknown' | 'running' | 'down' |
  // 'restarting'). This read `.healthy` off it, so every report said
  // "Backend: not running" (R3-07, also in v0.9.2).
  const healthState = getHealthState?.();
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
      running: healthState === 'running',
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
  // settings.stash: main owns the address and the trusted certificate
  // (electron/stash-ipc.js checks and writes the block, then tells the page).
  if (stash.ownsSetting(path)) {
    stash.applySettingWrite(path, value);
    return;
  }
  store.setSetting(path, value);
  // A new Handy key, Autoblow token, EroScripts login or Audience viewer is
  // masked in the log from this write on (FT-010).
  noteSecretSetting(path, value);
  // Keep the log redactor in step the moment the toggle moves, so a user who
  // enables it before grabbing a log does not have to restart first.
  // NB: store.setSetting prefixes 'settings.' itself, so the path that
  // arrives here is unprefixed. Getting this wrong makes the toggle a no-op
  // that still looks saved in the UI.
  if (path === 'security.hideLogFileNames') {
    // Switching it ON also rewrites the lines already in main.log and
    // main.old.log, not just the ones written from now on (V56).
    const t0 = Date.now();
    _reportLogRewrite(applyRedactionSetting(value, _logFilePaths()), t0);
  }
  // Settings > Appearance > Interface size zooms the main window at once (V79).
  uiScale.onSettingWritten(path, value);
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
    // CSS px are screen px times the window's zoom (interface size, V79).
    const z = win.webContents?.getZoomFactor?.() || 1;
    return p.x >= b.x + rect.x * z && p.x <= b.x + (rect.x + rect.width) * z
        && p.y >= b.y + rect.y * z && p.y <= b.y + (rect.y + rect.height) * z;
  } catch {
    return false;
  }
}

ipcMain.handle('update-window-chrome', (event, theme, opts = {}) => {
  const { colorsForTheme } = require('./window-bg');
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
  // Under a dialog's backdrop (FT-100, also in v0.9.2): the backdrop dims the
  // page, but the OS draws the caption buttons above it, so they stayed
  // bright over a dimmed window. Dimmed, the strip is transparent (the
  // dimmed nav bar shows through) and the symbols are blended as the
  // backdrop blends the page. Remembered per window, so a call that does not
  // say (the theme manager's retint while Settings is open) keeps it.
  if (typeof opts.dimmed === 'boolean') _captionDimmed.set(win.id, opts.dimmed);
  const dimmed = _captionDimmed.get(win.id) === true;
  const symbol = (c) => (dimmed ? require('./window-bg').dimColor(c) : c);
  const apply = (hideSymbols, scrim = false) => {
    if (win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay?.({
        color: opts.overVideo
          ? (scrim ? HOVER_SCRIM : TRANSPARENT)
          : (dimmed ? TRANSPARENT : colors.chrome), // else nav-bar surface, see window-bg.js
        symbolColor: hideSymbols
          ? TRANSPARENT
          : symbol(opts.overVideo ? '#ffffff' : colors.symbol),
        // At the window's zoom, or this reset a scaled caption strip to
        // 48 px on every view change (V79).
        height: uiScale.titleBarHeightFor(win),
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
  // The order stored (unchanged when refused): the renderer's cache follows it (CB-14).
  return store.setPlaylistVideoPaths(id, videoPaths);
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

// Several at once, one config.json write (a playlist's Select-mode Remove
// and its Undo, FT-104).
ipcMain.handle('add-videos-to-playlist', (_event, id, videoPaths) => {
  store.addVideosToPlaylist(id, videoPaths);
});

ipcMain.handle('remove-videos-from-playlist', (_event, id, videoPaths) => {
  store.removeVideosFromPlaylist(id, videoPaths);
});

// Categories
ipcMain.handle('get-categories', () => {
  return store.getCategories();
});

ipcMain.handle('add-category', (_event, name, color, icon) => {
  return store.addCategory(name, color, icon);
});

ipcMain.handle('set-category-icon', (_event, id, icon) => {
  store.setCategoryIcon(id, icon);
});

ipcMain.handle('set-category-color', (_event, id, color) => {
  store.setCategoryColor(id, color);
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
/**
 * Pull FastAPI's `detail` off a failed response so the log says WHY.
 *
 * The backend already knows exactly what went wrong — "ffmpeg not found",
 * "Video has no duration", the raw ffmpeg stderr — and puts it in the body.
 * This end used to log only the status code, so Sylvain-Et-Un's log carried
 * 103 identical `Backend returned 500` lines and not one word of the reason
 * (2026-08-24). Best-effort by design: a body that isn't JSON must never turn
 * an already-failed request into a second failure.
 *
 * @returns {Promise<string>} ` — <detail>`, or '' if there is nothing to add
 */
async function _errorDetail(resp) {
  try {
    const body = await resp.json();
    // One log line: a detail with line breaks (ffmpeg's stderr is several
    // lines) split the warning, and its later lines carried no timestamp or
    // level, so a grep for [warn] missed the cause (E2-04). The backend sends
    // one line since E-11 (ffmpeg.py `_one_line`); this holds for any detail.
    const detail = typeof body?.detail === 'string' ? body.detail.replace(/\s+/g, ' ').trim() : '';
    if (!detail) return '';
    // Keep the END: ffmpeg prints the cause last. Keeping the first 400
    // characters logged its version/build banner and never the error (app
    // test V32). The backend now sends only the stderr tail; this is the
    // belt to that brace.
    return ` — ${detail.length > 400 ? `…${detail.slice(-400)}` : detail}`;
  } catch {
    return '';
  }
}

// One escalated line per session when thumbnails are failing WHOLESALE, so a
// total outage does not have to be inferred by counting warnings. Sylvain's
// log had 103 failures and 0 successes and still read as routine.
// "Wholesale" means not one success this session: ten failures in a row
// after hundreds of good thumbnails (a folder of clips ffmpeg cannot read)
// is per-file trouble, and the per-file warnings already say so. Claiming
// "no successes" there sent the reader after the wrong cause (app test V33).
let _thumbFailStreak = 0;
let _thumbSuccessCount = 0;
let _thumbOutageLogged = false;
const THUMB_OUTAGE_STREAK = 10;

// A clip whose thumbnail the BACKEND failed (a 500: ffmpeg / ffprobe cannot
// read the file) is not asked again for THUMB_FAIL_TTL_MS while its size and
// mtime are the same. The library asks again on every grid render, so a
// corrupt sandbox clip went to ffprobe 11 times in 6 minutes, each a 500 and a
// warning (verify-2, 2026-11-07; also in v0.9.2; FT-085 covered only the
// backend's /api/media/thumb). Not remembered: a backend that did not answer
// (timeout, not running) and a user-picked frame (`exact`). An edited or
// replaced file, the TTL and a backend restart all try again. Nothing is
// written or deleted: the card shows its placeholder.
const THUMB_FAIL_TTL_MS = 10 * 60 * 1000;
const _thumbFailed = new Map(); // key -> { size, mtimeMs, at }

async function _thumbFileStamp(p) {
  try {
    const s = await fs.promises.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

ipcMain.handle('generate-single-thumbnail', async (_event, videoPath, opts = {}) => {
  const failKey = opts.exact ? null : `${videoPath}|${opts.seekPct ?? 0.1}|${opts.width ?? 320}`;
  const known = failKey ? _thumbFailed.get(failKey) : null;
  if (known) {
    const stamp = await _thumbFileStamp(videoPath);
    if (stamp && stamp.size === known.size && stamp.mtimeMs === known.mtimeMs
        && Date.now() - known.at < THUMB_FAIL_TTL_MS) {
      return null;
    }
    _thumbFailed.delete(failKey);
  }
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
    if (!resp.ok) {
      const failed = new Error(`Backend returned ${resp.status}${await _errorDetail(resp)}`);
      failed.backendStatus = resp.status;
      throw failed;
    }
    const meta = await resp.json();
    if (!meta?.path || !fs.existsSync(meta.path)) {
      throw new Error('Backend returned no thumbnail file');
    }
    const bytes = fs.readFileSync(meta.path);
    const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    _thumbFailStreak = 0;
    _thumbSuccessCount++;
    if (failKey) _thumbFailed.delete(failKey);
    return { dataUrl, duration: meta.duration, width: meta.width, height: meta.height };
  } catch (err) {
    log.warn(`Single thumbnail failed for ${videoPath}: ${err.message}`);
    if (failKey && err.backendStatus === 500) {
      const stamp = await _thumbFileStamp(videoPath);
      if (stamp) _thumbFailed.set(failKey, { ...stamp, at: Date.now() });
    }
    _thumbFailStreak++;
    if (_thumbFailStreak >= THUMB_OUTAGE_STREAK && _thumbSuccessCount === 0 && !_thumbOutageLogged) {
      _thumbOutageLogged = true;
      log.error(`[Thumbnails] ${_thumbFailStreak} consecutive failures with no successes — `
        + 'thumbnail generation is broken for this whole library, not for one file. '
        + 'Check the [ffmpeg] line near the top of this log: if it says bundled=false, '
        + 'the backend is relying on ffmpeg being on PATH and cannot find it. '
        + `Last error: ${err.message}`);
    }
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
  // The walk and every pairing pass live in library-scan.js, where tests can
  // run them against real folders. Only the backend registration stays here.
  // Settings > Library "One-video folders" (FT-102) is read here, not passed
  // by each caller, so every scan (the library, a folder rescan for the
  // variant menu, an opened file) pairs the same way.
  // No backend registration here (block E2 verify-2, also in v0.9.2). A
  // registration REPLACES the backend's whole video list, and this handler
  // also answers partial scans: the player's variant menu rescans one
  // folder on every open, the collection dialog one source. Each of those
  // left the phone, its playlists and DeoVR / HereSphere with that folder's
  // videos only (40 -> 1 for a one-video folder) until the next full
  // registration. The library registers its own full scan, with the user's
  // associations applied and a retry while the backend boots
  // (library.js `_registerWithBackend`), and the backend has its thumb-cache
  // folder from `--user-data-dir` at startup (main.py).
  return scanLibrary(dirPathOrPaths, sourceMap, {
    log,
    folderScriptsAsVariants: store.getSetting('library.folderScriptsAsVariants') === true,
  });
});

// `{ multiple: true }` (N-04, the variation pickers' Browse...): several
// files, answered as a list. Every other caller asks for one file and gets
// one `{ name, path }`, as before. null when cancelled either way.
// `{ defaultPath }` (Locate, 2026-11-18): the stored path of a script that is
// not found; the picker opens in its folder, or the nearest parent folder
// that exists (dialog-default-path.js: read-only, a plain absolute path
// string only, nothing is created). Anything else opens where it always did.
ipcMain.handle('select-funscript', async (_event, opts) => {
  const multiple = opts?.multiple === true;
  let defaultPath;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'defaultPath')) {
    const { nearestExistingFolder } = require('./dialog-default-path');
    defaultPath = (await nearestExistingFolder(opts.defaultPath)) || undefined;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [
      { name: 'Funscript Files', extensions: ['funscript'] },
    ],
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  if (multiple) return result.filePaths.map((p) => ({ name: path.basename(p), path: p }));
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
    // A missing file is usually not a failure. Renderers PROBE with this:
    // playlist, category and library cards read the sibling `<video>.funscript`
    // of every entry to decide on a badge, so every scriptless video and every
    // video on an unplugged drive missed here, and each miss went to the log
    // as an error. Opening one playlist wrote a screenful of `[error]` lines
    // that were all expected (V57, app test 2026-11-02), and logs are triaged
    // by grepping for `[error]`. This handler cannot tell a probe from a read
    // that expected a script, so a miss is logged at debug: still in the file
    // for a "my script didn't load" report, just not dressed as a failure.
    // Any other failure (permissions, a locked or unreadable file) is still
    // an error.
    if (err && err.code === 'ENOENT') {
      log.debug('read-funscript: no file:', err.message);
    } else {
      log.error('read-funscript failed:', err.message);
    }
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
    // Windows and macOS always ask before an existing file is replaced;
    // Linux (GTK) only when told to (R3-01).
    properties: ['showOverwriteConfirmation'],
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

// Where should an EroScripts download go? The dialog ONLY: nothing is
// written here (R3-01, the empty write also in v0.9.2). The panel used
// save-funscript('') to pick, which wrote an empty file at the chosen path at
// once: an existing script there was emptied before the download started, and
// a failed download left a 0-byte file. The download IPC writes only after it
// has the bytes, and the panel's own "Replace <name>?" (old file to the
// Recycle Bin) decides about a file already there.
// Returns the chosen absolute path (ending in the download's extension), or
// null when cancelled.
ipcMain.handle('pick-download-save-path', async (_event, suggestedName) => {
  const name = typeof suggestedName === 'string' && suggestedName.trim()
    ? suggestedName.split(/[\\/]/).pop()
    : 'script.funscript';
  const ext = /\.zip$/i.test(name) ? 'zip' : 'funscript';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: name || 'script.funscript',
    filters: [ext === 'zip'
      ? { name: 'Zip archive', extensions: ['zip'] }
      : { name: 'Funscript Files', extensions: ['funscript'] }],
    properties: ['showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return null;
  // GTK does not add the filter's extension to a typed name; a download keeps
  // its type (the download IPC accepts only .funscript / .zip paths). The
  // path as the OS spells it (R4-11): `shell.trashItem` rejects a
  // forward-slash Windows path, so Replace would fail on one.
  const picked = path.normalize(result.filePath);
  return picked.toLowerCase().endsWith(`.${ext}`) ? picked : `${picked}.${ext}`;
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
 * The funscript metadata harvest (P1 tags, Round 3, 2026-11-18): each paired
 * script's own metadata block, which the backend's speed pass reads from the
 * files it already parses (backend/services/script_meta.py). The renderer's
 * store (renderer/js/script-meta-store.js) asks for all of it after a scan,
 * then only for what changed (`since` + `cache`, both from the last answer),
 * and the video options dialog asks for one script (`paths`). Through
 * fetchWithTimeout, so a question asked while the backend boots waits for
 * it. Null when the backend does not answer: the store then keeps what it
 * has (absence is never destructive).
 */
ipcMain.handle('get-script-meta', async (_event, query = {}) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const params = new URLSearchParams();
  const paths = Array.isArray(query?.paths) ? query.paths : [];
  for (const p of paths.slice(0, 50)) {
    if (typeof p === 'string' && p) params.append('path', p);
  }
  if (Number.isSafeInteger(query?.since) && query.since > 0) params.set('since', String(query.since));
  if (typeof query?.cache === 'string' && /^[0-9a-f]{1,64}$/.test(query.cache)) params.set('cache', query.cache);
  const qs = params.toString();
  const url = `http://localhost:${port}/api/media/script-meta${qs ? `?${qs}` : ''}`;
  try {
    const resp = await fetchWithTimeout(url, {}, 10000);
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    log.warn(`get-script-meta failed: ${err.message}`);
    return null;
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
  // customThumbsDir: uploaded poster images ride along in the zip (V59).
  // stashDir: the Stash data file only (never the key or the fingerprints).
  return exportData(configData, result.filePath, {
    customThumbsDir: customThumbsDir(),
    stashDir: path.join(app.getPath('userData'), 'stash'),
  });
});

ipcMain.handle('import-data', async () => {
  const { applyImport } = require('./data-export');

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import FunSync Backup',
    filters: [{ name: 'FunSync Backup', extensions: ['zip'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'Cancelled' };

  // The import ends in a relaunch (app.exit, which skips before-quit):
  // unsaved editor edits are asked about first; Cancel imports nothing
  // (R3-19).
  if (!(await _unsavedEdits.confirm('importing a backup'))) return { success: false, error: 'Cancelled' };

  // Merges the backup into the live config (settings, playlists,
  // categories, category assignments, custom thumbnail images), writes it
  // in one go, then relaunches. The relaunch is what makes the import
  // stick: the renderer answers every read from a boot-time cache and
  // writes whole maps back from it, so without a fresh boot the next
  // association edit would write the pre-import map over the import (V02).
  // An import that fails stays in this app with the edits as they were: the
  // next close or quit asks again (R4-17).
  let imported;
  try {
    imported = await applyImport({
      filePath: result.filePaths[0],
      store,
      customThumbsDir: customThumbsDir(),
      // The backup's Stash data is merged through main's own instance (its
      // only writer); a backup never brings an API key in.
      stashLibrary,
      // Once the file is known to be a backup, before anything is read or
      // written: the relaunch below would otherwise leave devices running.
      stopPlayback: _stopPlaybackBeforeRelaunch,
      // Snapshot the pre-import state — merging an arbitrary backup file
      // can mutate sources, collections, playlists, categories, and even
      // the encrypted Handy key. If the user picks the wrong file, this
      // is the snapshot they'll roll back to.
      beforeWrite: () => _preActionSnapshot('pre-import'),
      relaunch: () => {
        log.info('[Backup] Imported a backup file; relaunching');
        _relaunchWithConfigOnDisk();
      },
    });
  } catch (err) {
    _unsavedEdits.reset('Importing a backup');
    throw err;
  }
  if (!imported?.success) _unsavedEdits.reset('Importing a backup');
  return imported;
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
    // Snapshots from before the category-assignment count existed get it
    // now (one read each, once), so every row can show it (V58).
    await dataBackup.backfillSummaries(paths.backupDir, manifest);
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
  // The restore ends in a relaunch (app.exit, which skips before-quit):
  // unsaved editor edits are asked about first; Cancel restores nothing
  // (R3-19).
  if (!(await _unsavedEdits.confirm('restoring a backup'))) {
    return { success: false, error: 'Cancelled', cancelled: true };
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
    // A restore that stops here stays in this app with the edits as they
    // were: the next close or quit asks again (R4-17).
    if (!parsed?.config || !parsed?.metadata) {
      _unsavedEdits.reset('Restoring a backup');
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
        _unsavedEdits.reset('Restoring a backup');
        return { success: false, error: 'snapshot SHA-256 mismatch — refusing restore' };
      }
    }

    // The snapshot is good, so the relaunch below will happen: stop
    // playback and every device now. app.exit skips the renderer's
    // beforeunload, which would otherwise have done it.
    await _stopPlaybackBeforeRelaunch();

    // Step 3: atomically replace config.json.
    await dataBackup.atomicWriteFile(
      paths.configPath,
      JSON.stringify(parsed.config, null, 2)
    );

    // Step 4: relaunch.
    log.info(`[Backup] Restored from ${subdir}/${filename}; relaunching`);
    _relaunchWithConfigOnDisk();
    return { success: true };
  } catch (err) {
    log.error('[Backup] restore failed:', err.message);
    _unsavedEdits.reset('Restoring a backup');
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

// Restore + raise the pop-out for a video the user just asked for (V16),
// without taking keyboard focus from the main window.
ipcMain.handle('player-popout:reveal', () => {
  return { success: playerPopout.reveal() };
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

// The check itself is `pathReachable` in path-status.js, where tests run it on
// real folders and a real deny ACL (FT-002). Three answers: `true` present,
// `false` definitely absent (ENOENT / ENOTDIR only), `null` unknown (timed
// out, permission denied, busy, any other error). It used to fold every error
// into `false`, so a script in a folder whose listing is denied (EPERM) read
// as deleted and `library._safeToPrune` pruned its association. Required here
// rather than at the top so tests/unit/path-status.test.js can lift this whole
// section, require included, and run what main.js really runs.
const { pathReachable, pathStatusDetail } = require('./path-status');

ipcMain.handle('file-exists', async (_event, filePath, timeoutMs) => {
  // Collapses the unknown/timeout case to `false` for backwards
  // compatibility: every caller of this singular form treats the result as a
  // plain boolean, and they are probing individual scripts and videos rather
  // than deciding whether a whole library is reachable. The batch form below
  // preserves the distinction, because that IS the library decision.
  // Audited for FT-002 (2026-11-05), when a permission error joined the
  // unknown case: every caller acts only on `true` (heal a script beside its
  // video, offer an Orgasm axis file, an older bridge's display probe), so a
  // collapsed unknown costs a missed heal, never data. Anything that may
  // delete or lock must ask `files-exist`.
  const r = await pathReachable(filePath, Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined);
  return r === true;
});

/**
 * Batch existence check. One IPC round trip for a whole playlist instead of
 * one per video — a 500-entry playlist on an external drive was 500 invokes,
 * each of which can block on a spun-down or disconnected volume.
 *
 * Returns an array positionally matching the input, each entry `true`
 * (present), `false` (definitely absent: ENOENT / ENOTDIR) or **`null`
 * (unknown: timed out, permission denied, any other error)**. Never throws.
 *
 * The null is deliberate and every caller depends on it: the source
 * reachability probe (locks only on `false`), `library._pathStatus` (which
 * every prune asks), the playlist/category availability probe (greys only on
 * `false`), the missing-video check on a load error and Extract's
 * do-not-overwrite check. Collapsing a timeout to `false` here is what let a
 * busy app declare every source unreachable and lock the whole library
 * (2026-08-26); collapsing EPERM did the same to one association (FT-002).
 *
 * `opts.why` (R4-14): each entry is `{ status, why }` instead, `status` the
 * same tri-state and `why` 'denied' / 'timeout' / 'error' for a null (null
 * otherwise), so a notice can tell a slow share from a locked folder. Only
 * a caller that words the answer asks for it; nothing acts on `why`.
 */
ipcMain.handle('files-exist', async (_event, filePaths, timeoutMs, opts) => {
  if (!Array.isArray(filePaths)) return [];
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined;
  // Concurrent, not sequential: one slow path must not delay the rest, and the
  // whole batch shares roughly one timeout rather than N of them in series.
  if (opts?.why === true) return Promise.all(filePaths.map((p) => pathStatusDetail(p, budget)));
  return Promise.all(filePaths.map((p) => pathReachable(p, budget)));
});

/**
 * Can each source folder still be LISTED (open it, read one entry)? Same
 * shape as `files-exist`: positional, `true` / `false` / `null` (timed out),
 * never throws. Recheck asks this for the sources the existence probe passed,
 * because a folder whose listing is denied passes `fs.access` and fails only
 * the scan (V04, V82). See `rootListable` in library-scan.js.
 */
ipcMain.handle('dirs-listable', async (_event, dirPaths, timeoutMs) => {
  if (!Array.isArray(dirPaths)) return [];
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined;
  return Promise.all(dirPaths.map((p) => rootListable(p, { timeoutMs: budget })));
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
//
// The socket lifecycle lives in vr-socket.js so it can be tested without
// Electron or a headset. See the header there: a dead connect attempt used to
// be able to clear a LIVE connection's keep-alive timer, and three seconds of
// keep-alive silence is how HereSphere drops a link.

const { VRSocketLink } = require('./vr-socket.js');

const vrLink = new VRSocketLink({
  createSocket: () => new (require('net').Socket)(),
  broadcast: (channel, payload) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload));
  },
  log,
});

ipcMain.handle('vr-connect', (_event, host, port) => vrLink.connect(host, port));

ipcMain.handle('vr-disconnect', () => vrLink.disconnect());

ipcMain.handle('vr-send', (_event, jsonStr) => vrLink.send(jsonStr));

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

ipcMain.handle('updater-install', async () => {
  // Restart Now quits to install. Unsaved editor edits are asked about
  // BEFORE the installer starts: once it runs it closes the app whatever
  // the answer (R3-19). Cancel leaves the update toast up for later.
  if (!(await _unsavedEdits.confirm('installing the update'))) return { cancelled: true };
  // An installer that does not start (nothing downloaded, a spawn error)
  // leaves the app open with the edits as they were: when no quit begins,
  // the next close or quit asks again (R4-17).
  resetUnlessQuitStarts(_unsavedEdits, app);
  try {
    quitAndInstall();
  } catch (err) {
    log.warn('[Updater] quitAndInstall failed:', err?.message || err);
    _unsavedEdits.reset('Installing the update');
  }
  return { cancelled: false };
});

// The renderer is about to ask the unsaved-edits question for an action that
// came from another window (the detached player's N / P or Up Next, the
// editor pop-out's script list) or while this window is minimised or behind:
// bring it to the front so the question is seen (R3-21).
ipcMain.on('main-window:bring-forward', (event) => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
    bringToFront(mainWindow);
  }
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

  // A Chrome UA on the partition so Cloudflare's bot scoring doesn't
  // serve the "Server is currently experiencing high load" page (which it
  // routes Electron's default UA to in some configs even when actual load
  // is fine). It is the SAME string the REST client sends (the real
  // Chromium UA plus FunSyncPlayer/<version>, eroscripts-api.js; Dave,
  // 2026-11-18): Cloudflare ties cf_clearance to the UA that earned it.
  // Set once, on the session, before the window exists: the window's
  // webContents takes it from there, and so does every later request of
  // this session (the cookie/CSRF preflights too).
  sess.setUserAgent(EROSCRIPTS_USER_AGENT);

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

        // The same User-Agent as the window above and every request of
        // eroscripts-api.js (Dave, 2026-11-18).
        const resp = await fetch(
          'https://discuss.eroscripts.com/session/current.json',
          {
            headers: {
              Cookie: cookieHeader,
              'User-Agent': EROSCRIPTS_USER_AGENT,
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

// The session check (Dave, 2026-11-18): is the saved login cookie still good?
// Asked when the EroScripts panel, the inline search or the Tags section
// opens (a kept answer, so opening again sends nothing) and, with
// `{force: true}`, after a request came back 401 / 403. Main only answers
// ('valid' / 'expired' / 'unknown' / 'loggedOut'); the renderer acts on a
// definite 'expired' (the panel's handleSessionExpired).
ipcMain.handle('eroscripts-check-session', async (_event, opts) => {
  return eroScripts.checkSession({ force: opts?.force === true });
});

ipcMain.handle('eroscripts-search', async (_event, query, page) => {
  return eroScripts.search(query, page);
});

ipcMain.handle('eroscripts-topic', async (_event, topicId) => {
  return eroScripts.getTopicAttachments(topicId);
});

// "Get tags from EroScripts" for one video: one GET /t/{id}.json, logged in
// only. Main fetches and returns; the renderer writes the record.
ipcMain.handle('eroscripts-topic-meta', async (_event, topicId) => {
  return eroScripts.getTopicMeta(topicId);
});

ipcMain.handle('eroscripts-topic-image', async (_event, topicId) => {
  return eroScripts.getTopicImage(topicId);
});

// An existing, different file is replaced only on `{ replace: true }`, and
// then goes to the Recycle Bin first (shell.trashItem, as Find duplicates).
// `{ checkOnly: true }` fetches and looks, writing nothing (R3-03).
// The arguments are checked first (R3-04, like trash-video-files): the URL
// must be on the EroScripts origin (or an attachment the forum gave us), the
// path an absolute .funscript / .zip path; anything else writes nothing.
ipcMain.handle('eroscripts-download', async (_event, url, savePath, opts) => {
  const refused = eroScripts.checkDownloadRequest(url, savePath);
  if (refused) {
    log.warn(`[EroScripts] Download refused: ${refused}`);
    return { success: false, refused: true, error: refused };
  }
  return eroScripts.downloadFile(url, savePath, {
    replace: opts?.replace === true,
    checkOnly: opts?.checkOnly === true,
    trashItem: (p) => shell.trashItem(p),
  });
});

// The user answered Cancel after a look: the bytes it fetched need not wait
// in main for a write (R4-09). Writes nothing; an unknown URL is a no-op.
ipcMain.handle('eroscripts-forget-download', async (_event, url) => {
  return eroScripts.forgetDownload(url);
});
