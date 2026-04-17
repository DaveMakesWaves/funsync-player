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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "FunSync Player",
    icon: path.join(__dirname, '..', 'assets', 'icons', 'icon.ico'),
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
}

app.whenReady().then(async () => {
  await store.initStore();
  log.info('Data store initialized');

  await startBackend();
  createWindow();

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

ipcMain.handle('fetch-metadata', async (_event, videoPath) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/metadata/?video_path=${encodeURIComponent(videoPath)}`;
  try {
    const resp = await fetch(url);
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
    const resp = await fetch(url, { method: 'POST' });
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    log.error('Thumbnail generation failed:', err.message);
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

ipcMain.handle('scan-directory', async (_event, dirPath) => {
  const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac'];
  const FUNSCRIPT_EXT = '.funscript';
  const SUBTITLE_EXTS = ['.srt', '.vtt'];
  const AXIS_SUFFIXES = new Set(['surge','sway','twist','roll','pitch','vib','lube','pump','suction','valve']);

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    log.error('scan-directory failed:', err.message);
    return { videos: [], unmatchedFunscripts: [], unmatchedSubtitles: [] };
  }

  // Normalize a basename for matching: lowercase, replace separators with spaces, collapse
  const normalizeName = (name) => name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

  // Collect all funscripts with variant/axis classification
  const funscriptList = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== FUNSCRIPT_EXT) continue;

    const nameNoExt = path.basename(entry.name, ext); // e.g. "video", "video.vib", "video (Soft)", "video.intense"
    const fullPath = path.join(dirPath, entry.name);

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
      videoBase,
      variantLabel,
      isAxis,
      axisSuffix: isAxis ? dotSuffix : null,
      _used: false,
    });
  }

  // Build a map of normalized video base -> primary funscript (for backward compat)
  const funscriptMap = new Map();
  for (const fs of funscriptList) {
    if (!fs.isAxis && !fs.variantLabel && !funscriptMap.has(fs.videoBase)) {
      funscriptMap.set(fs.videoBase, fs);
    }
  }
  // If no default variant, use the first matching funscript
  for (const fs of funscriptList) {
    if (!fs.isAxis && !funscriptMap.has(fs.videoBase)) {
      funscriptMap.set(fs.videoBase, fs);
    }
  }

  // Collect subtitle basenames for matching
  const subtitleMap = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SUBTITLE_EXTS.includes(ext)) {
      const baseName = normalizeName(path.basename(entry.name, ext));
      // If multiple subtitle files match the same base name, keep the first
      if (!subtitleMap.has(baseName)) {
        subtitleMap.set(baseName, { name: entry.name, path: path.join(dirPath, entry.name), _used: false });
      }
    }
  }

  // Build video list with funscript + subtitle + variant pairing
  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) continue;

    const baseName = normalizeName(path.basename(entry.name, ext));

    const fsEntry = funscriptMap.get(baseName);
    const funscriptPath = fsEntry ? fsEntry.path : null;
    if (fsEntry) fsEntry._used = true;

    const subEntry = subtitleMap.get(baseName);
    const subtitlePath = subEntry ? subEntry.path : null;
    if (subEntry) subEntry._used = true;

    // Collect variants for this video (non-axis funscripts sharing the base name)
    const variants = [];
    for (const fs of funscriptList) {
      if (fs.videoBase !== baseName || fs.isAxis) continue;
      fs._used = true;
      variants.push({
        label: fs.variantLabel || 'Default',
        path: fs.path,
        name: fs.name,
      });
    }
    // Sort: Default first, then alphabetical
    variants.sort((a, b) => {
      if (a.label === 'Default') return -1;
      if (b.label === 'Default') return 1;
      return a.label.localeCompare(b.label);
    });

    videos.push({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      ext,
      hasFunscript: funscriptPath !== null,
      funscriptPath,
      hasSubtitle: subtitlePath !== null,
      subtitlePath,
      variants: variants.length > 1 ? variants : [],
    });
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
  for (const subEntry of subtitleMap.values()) {
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
  return { videos, unmatchedFunscripts, unmatchedSubtitles, allFunscripts };
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
    return fs.readFileSync(filePath, 'utf-8');
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
ipcMain.handle('convert-funscript', async (_event, funscriptContent) => {
  const { getBackendPort } = require('./python-bridge');
  const port = getBackendPort();
  const url = `http://localhost:${port}/scripts/convert`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: funscriptContent,
    });
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
