const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('./logger');
const { startBackend, stopBackend, setHealthListener, startHealthMonitor, restartBackend, getHealthState } = require('./python-bridge');
const store = require('./store');
const dataBackup = require('./data-backup');
const dataMigration = require('./data-migration');
const { initAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall } = require('./auto-updater');
const { EroScriptsAPI } = require('./eroscripts-api');

const eroScripts = new EroScriptsAPI();

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
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiIgnoreDriverChecks');
}

let mainWindow = null;

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

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "FunSync Player",
    icon: path.join(__dirname, '..', 'assets', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: "#1a1a2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    frame: true,
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    splash.destroy();
    mainWindow.show();
    if (app.isPackaged) {
      initAutoUpdater(mainWindow);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
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

  const _tBackend = Date.now();
  await startBackend();
  log.info(`[Timing main] startBackend (Python spawn + uvicorn boot): ${Date.now() - _tBackend}ms`);

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

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
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
      { name: 'Media Files', extensions: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'mp3', 'wav', 'ogg', 'flac'] },
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
  const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac'];
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
    if (isAxis) {
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = null; // axis, not a variant
    } else if (parenMatch) {
      videoBase = normalizeName(parenMatch[1]);
      variantLabel = parenMatch[2].trim();
    } else if (dotSuffix && dotIdx > 0) {
      // Dot-separated variant: "video.intense" (not a known axis)
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = dotSuffix;
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
      _used: false,
    });
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
      variants: variants.length > 1 ? variants : [],
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

ipcMain.handle('read-funscript', async (_event, filePath) => {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
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

// --- IPC Handlers: TCode Serial ---

let tcodePort = null; // active SerialPort instance

ipcMain.handle('tcode-list-ports', async () => {
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

ipcMain.handle('tcode-connect', async (_event, portPath, baudRate = 115200) => {
  try {
    if (tcodePort) {
      tcodePort.removeAllListeners();
      if (tcodePort.isOpen) tcodePort.close();
      tcodePort = null;
    }
    const { SerialPort } = require('serialport');
    tcodePort = new SerialPort({
      path: portPath,
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    });

    return new Promise((resolve) => {
      tcodePort.open((err) => {
        if (err) {
          log.warn('[TCode] Open failed:', err.message);
          tcodePort = null;
          resolve({ success: false, error: err.message });
        } else {
          log.info(`[TCode] Connected to ${portPath} @ ${baudRate}`);

          tcodePort.on('close', () => {
            log.info('[TCode] Port closed');
            tcodePort = null;
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tcode-disconnected'));
          });

          tcodePort.on('error', (e) => {
            log.warn('[TCode] Port error:', e.message);
          });

          resolve({ success: true });
        }
      });
    });
  } catch (err) {
    log.warn('[TCode] Connect error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('tcode-disconnect', () => {
  if (tcodePort && tcodePort.isOpen) {
    tcodePort.close();
    tcodePort = null;
    log.info('[TCode] Disconnected');
  }
  return { success: true };
});

ipcMain.handle('tcode-send', (_event, command) => {
  if (!tcodePort || !tcodePort.isOpen) return false;
  try {
    tcodePort.write(command);
    return true;
  } catch (err) {
    log.debug('[TCode] Write error:', err.message);
    return false;
  }
});

ipcMain.handle('tcode-status', () => {
  return { connected: !!(tcodePort && tcodePort.isOpen) };
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
