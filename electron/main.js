const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('./logger');
const { startBackend, stopBackend } = require('./python-bridge');
const store = require('./store');
const dataMigration = require('./data-migration');
const { initAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall } = require('./auto-updater');
const { EroScriptsAPI } = require('./eroscripts-api');

const eroScripts = new EroScriptsAPI();

let mainWindow = null;

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

app.whenReady().then(async () => {
  // Startup timing — main-process side. Renderer-side is in
  // renderer/js/startup-timer.js. Both end up in main.log via
  // electron-log so we can correlate.
  const _t0 = Date.now();
  log.info(`[Timing main] app.whenReady fired at t=0`);

  const _tStore = Date.now();
  await store.initStore();
  log.info(`[Timing main] store.initStore: ${Date.now() - _tStore}ms`);

  const _tBackend = Date.now();
  await startBackend();
  log.info(`[Timing main] startBackend (Python spawn + uvicorn boot): ${Date.now() - _tBackend}ms`);

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

app.on('before-quit', () => {
  stopBackend();
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

ipcMain.handle('delete-playlist', (_event, id) => {
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

ipcMain.handle('delete-category', (_event, id) => {
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
      log.warn('[VR] Socket error:', err.message);
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

ipcMain.handle('eroscripts-login', async (_event, username, password) => {
  return eroScripts.login(username, password);
});

ipcMain.handle('eroscripts-verify-2fa', async (_event, nonce, token, username, password) => {
  return eroScripts.verify2FA(nonce, token, username, password);
});

ipcMain.handle('eroscripts-logout', () => {
  eroScripts.logout();
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
