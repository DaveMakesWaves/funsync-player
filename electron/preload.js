const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('funsync', {
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  // Direct write to main.log via electron-log — used by startup-timer
  // so timing data survives even if the console transport breaks
  // (e.g. parent process closed stdout). Fire-and-forget.
  logLine: (level, message) => ipcRenderer.invoke('log-line', level, message),

  // File handling — native Electron dialog
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),

  // Data store — all data
  getAllData: () => ipcRenderer.invoke('get-all-data'),
  getSetting: (path) => ipcRenderer.invoke('get-setting', path),
  setSetting: (path, value) => ipcRenderer.invoke('set-setting', path, value),
  addRecentFile: (filePath) => ipcRenderer.invoke('add-recent-file', filePath),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  getPlaylist: (id) => ipcRenderer.invoke('get-playlist', id),
  addPlaylist: (name) => ipcRenderer.invoke('add-playlist', name),
  renamePlaylist: (id, name) => ipcRenderer.invoke('rename-playlist', id, name),
  deletePlaylist: (id) => ipcRenderer.invoke('delete-playlist', id),
  addVideoToPlaylist: (id, videoPath) => ipcRenderer.invoke('add-video-to-playlist', id, videoPath),
  removeVideoFromPlaylist: (id, videoPath) => ipcRenderer.invoke('remove-video-from-playlist', id, videoPath),

  // Categories
  getCategories: () => ipcRenderer.invoke('get-categories'),
  addCategory: (name, color) => ipcRenderer.invoke('add-category', name, color),
  renameCategory: (id, name) => ipcRenderer.invoke('rename-category', id, name),
  deleteCategory: (id) => ipcRenderer.invoke('delete-category', id),

  // Category mappings
  assignCategory: (videoPath, catId) => ipcRenderer.invoke('assign-category', videoPath, catId),
  unassignCategory: (videoPath, catId) => ipcRenderer.invoke('unassign-category', videoPath, catId),
  getVideoCategories: (videoPath) => ipcRenderer.invoke('get-video-categories', videoPath),
  getVideosByCategory: (catId) => ipcRenderer.invoke('get-videos-by-category', catId),

  // Migration
  migrateLocalStorage: (data) => ipcRenderer.invoke('migrate-local-storage', data),

  // Library
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  scanDirectory: (dirPath, sourceMap) => ipcRenderer.invoke('scan-directory', dirPath, sourceMap),
  selectFunscript: () => ipcRenderer.invoke('select-funscript'),
  readFunscript: (filePath) => ipcRenderer.invoke('read-funscript', filePath),
  selectSubtitle: () => ipcRenderer.invoke('select-subtitle'),

  // Script editor
  saveFunscript: (content, name) => ipcRenderer.invoke('save-funscript', content, name),
  writeFunscript: (content, filePath) => ipcRenderer.invoke('write-funscript', content, filePath),

  // File utilities
  fileExists: (filePath) => ipcRenderer.invoke('file-exists', filePath),

  // Data export/import
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),

  // Backend API proxies
  fetchMetadata: (videoPath) => ipcRenderer.invoke('fetch-metadata', videoPath),
  generateThumbnails: (videoPath, interval) => ipcRenderer.invoke('generate-thumbnails', videoPath, interval),
  generateSingleThumbnail: (videoPath, opts) => ipcRenderer.invoke('generate-single-thumbnail', videoPath, opts),
  getSpeedStats: () => ipcRenderer.invoke('get-speed-stats'),
  convertFunscript: (content) => ipcRenderer.invoke('convert-funscript', content),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),

  // TCode Serial
  tcodeListPorts: () => ipcRenderer.invoke('tcode-list-ports'),
  tcodeConnect: (portPath, baudRate) => ipcRenderer.invoke('tcode-connect', portPath, baudRate),
  tcodeDisconnect: () => ipcRenderer.invoke('tcode-disconnect'),
  tcodeSend: (command) => ipcRenderer.invoke('tcode-send', command),
  tcodeStatus: () => ipcRenderer.invoke('tcode-status'),
  onTcodeDisconnected: (callback) => {
    ipcRenderer.on('tcode-disconnected', callback);
    return () => ipcRenderer.removeListener('tcode-disconnected', callback);
  },

  // VR Bridge
  vrConnect: (host, port) => ipcRenderer.invoke('vr-connect', host, port),
  vrDisconnect: () => ipcRenderer.invoke('vr-disconnect'),
  vrSend: (jsonStr) => ipcRenderer.invoke('vr-send', jsonStr),
  onVrState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('vr-state', handler);
    return () => ipcRenderer.removeListener('vr-state', handler);
  },
  onVrDisconnected: (callback) => {
    ipcRenderer.on('vr-disconnected', callback);
    return () => ipcRenderer.removeListener('vr-disconnected', callback);
  },

  // Autoblow
  autoblowConnect: (token) => ipcRenderer.invoke('autoblow-connect', token),
  autoblowDisconnect: () => ipcRenderer.invoke('autoblow-disconnect'),
  autoblowStatus: () => ipcRenderer.invoke('autoblow-status'),
  autoblowUploadScript: (content) => ipcRenderer.invoke('autoblow-upload-script', content),
  autoblowSyncStart: (startTimeMs) => ipcRenderer.invoke('autoblow-sync-start', startTimeMs),
  autoblowSyncStop: () => ipcRenderer.invoke('autoblow-sync-stop'),
  autoblowSyncOffset: (offsetMs) => ipcRenderer.invoke('autoblow-sync-offset', offsetMs),
  autoblowLatency: () => ipcRenderer.invoke('autoblow-latency'),

  // EroScripts
  eroscriptsLogin: (username, password) => ipcRenderer.invoke('eroscripts-login', username, password),
  eroscriptsVerify2FA: (nonce, token, username, password) => ipcRenderer.invoke('eroscripts-verify-2fa', nonce, token, username, password),
  eroscriptsLogout: () => ipcRenderer.invoke('eroscripts-logout'),
  eroscriptsRestoreSession: (cookie, username) => ipcRenderer.invoke('eroscripts-restore-session', cookie, username),
  eroscriptsStatus: () => ipcRenderer.invoke('eroscripts-status'),
  eroscriptsValidate: () => ipcRenderer.invoke('eroscripts-validate'),
  eroscriptsSearch: (query, page) => ipcRenderer.invoke('eroscripts-search', query, page),
  eroscriptsTopic: (topicId) => ipcRenderer.invoke('eroscripts-topic', topicId),
  eroscriptsTopicImage: (topicId) => ipcRenderer.invoke('eroscripts-topic-image', topicId),
  eroscriptsDownload: (url, savePath) => ipcRenderer.invoke('eroscripts-download', url, savePath),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdateEvent: (callback) => {
    const channels = [
      'update:checking',
      'update:available',
      'update:not-available',
      'update:download-progress',
      'update:downloaded',
      'update:error',
    ];
    const handlers = channels.map((ch) => {
      const handler = (_event, data) => callback(ch, data);
      ipcRenderer.on(ch, handler);
      return { channel: ch, handler };
    });
    // Return cleanup function
    return () => {
      for (const { channel, handler } of handlers) {
        ipcRenderer.removeListener(channel, handler);
      }
    };
  },
});
