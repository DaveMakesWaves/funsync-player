const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('funsync', {
  // Static platform identifier from the main process — used by anything
  // that needs to branch on OS (HEVC codec install guidance, native
  // dialog quirks, etc.) without an IPC roundtrip. Values match
  // Node's `process.platform`: 'win32' | 'linux' | 'darwin' | 'freebsd' | …
  platform: process.platform,
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPortableInfo: () => ipcRenderer.invoke('get-portable-info'),

  // Backend health monitoring — used by the disconnected-banner.
  getBackendHealth: () => ipcRenderer.invoke('get-backend-health'),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  openLogFile: () => ipcRenderer.invoke('open-log-file'),
  // Subscribe to state-change events from the main-process health monitor.
  onBackendStatus: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('backend-status', handler);
    return () => ipcRenderer.removeListener('backend-status', handler);
  },
  // Direct write to main.log via electron-log — used by startup-timer
  // so timing data survives even if the console transport breaks
  // (e.g. parent process closed stdout). Fire-and-forget.
  logLine: (level, message) => ipcRenderer.invoke('log-line', level, message),

  // File handling — native Electron dialog
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),

  // Real filesystem path for a dropped File object.
  //
  // Electron REMOVED the non-standard `File.path` in v32; we are on 41. A
  // dropped video therefore arrived with `path === undefined`, which set
  // `app._currentVideoPath = null` and silently disabled everything keyed on
  // the path — VR format panel, funscript auto-pairing, resume, variations,
  // queue context, screenshots, remux fallback. The video still PLAYED,
  // because playback falls back to a blob URL, so the breakage was invisible.
  // Reported by terijapl (#284) as "Ctrl+Shift+R says no video loaded after
  // drag and drop", which was one visible symptom of about a dozen.
  //
  // `webUtils.getPathForFile` is Electron's supported replacement and must be
  // called from the preload: `webUtils` is not reachable across the context
  // bridge, only its result is. Returns '' for anything without a real path
  // (a File built in-page, a synthetic drop in tests), so callers can treat
  // falsy as "no path" exactly as they did before.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

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
  setPlaylistLoop: (id, loop) => ipcRenderer.invoke('set-playlist-loop', id, loop),
  setPlaylistShuffle: (id, shuffle) => ipcRenderer.invoke('set-playlist-shuffle', id, shuffle),
  setPlaylistBalance: (id, balance) => ipcRenderer.invoke('set-playlist-balance', id, balance),
  setPlaylistPreferUnwatched: (id, prefer) => ipcRenderer.invoke('set-playlist-prefer-unwatched', id, prefer),
  updateWindowChrome: (theme, opts) => ipcRenderer.invoke('update-window-chrome', theme, opts),
  deletePlaylist: (id) => ipcRenderer.invoke('delete-playlist', id),
  addVideoToPlaylist: (id, videoPath) => ipcRenderer.invoke('add-video-to-playlist', id, videoPath),
  removeVideoFromPlaylist: (id, videoPath) => ipcRenderer.invoke('remove-video-from-playlist', id, videoPath),
  setPlaylistVideoPaths: (id, videoPaths) => ipcRenderer.invoke('set-playlist-video-paths', id, videoPaths),

  // Categories
  getCategories: () => ipcRenderer.invoke('get-categories'),
  addCategory: (name, color, icon) => ipcRenderer.invoke('add-category', name, color, icon),
  setCategoryIcon: (id, icon) => ipcRenderer.invoke('set-category-icon', id, icon),
  setCategoryColor: (id, color) => ipcRenderer.invoke('set-category-color', id, color),
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

  // Custom thumbnail images (user-uploaded posters)
  selectThumbnailImage: () => ipcRenderer.invoke('select-thumbnail-image'),
  importCustomThumbnail: (videoPath, imagePath) => ipcRenderer.invoke('import-custom-thumbnail', videoPath, imagePath),
  readCustomThumbnail: (cachedPath) => ipcRenderer.invoke('read-custom-thumbnail', cachedPath),
  getCustomThumbsDir: () => ipcRenderer.invoke('get-custom-thumbs-dir'),

  // Script editor
  saveFunscript: (content, name) => ipcRenderer.invoke('save-funscript', content, name),
  writeFunscript: (content, filePath) => ipcRenderer.invoke('write-funscript', content, filePath),

  // File utilities
  fileExists: (filePath, timeoutMs) => ipcRenderer.invoke('file-exists', filePath, timeoutMs),
  filesExist: (filePaths, timeoutMs) => ipcRenderer.invoke('files-exist', filePaths, timeoutMs),

  // Data export/import
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),

  // Backup & Recovery (rolling snapshots, auto-recovery)
  backupGetBootResult: () => ipcRenderer.invoke('backup:get-boot-result'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupSnapshotNow: () => ipcRenderer.invoke('backup:snapshot-now'),
  backupRestore: (subdir, filename) => ipcRenderer.invoke('backup:restore', { subdir, filename }),
  backupOpenFolder: () => ipcRenderer.invoke('backup:open-folder'),
  backupPreAction: (label) => ipcRenderer.invoke('backup:pre-action', label),

  // Backend API proxies
  fetchMetadata: (videoPath) => ipcRenderer.invoke('fetch-metadata', videoPath),
  generateThumbnails: (videoPath, interval) => ipcRenderer.invoke('generate-thumbnails', videoPath, interval),
  generateSingleThumbnail: (videoPath, opts) => ipcRenderer.invoke('generate-single-thumbnail', videoPath, opts),
  remuxVideo: (videoPath) => ipcRenderer.invoke('remux-video', videoPath),
  resolveRemoteVideo: (pageUrl) => ipcRenderer.invoke('resolve-remote-video', pageUrl),
  getSpeedStats: () => ipcRenderer.invoke('get-speed-stats'),
  getDurations: () => ipcRenderer.invoke('get-durations'),
  convertFunscript: (content) => ipcRenderer.invoke('convert-funscript', content),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  // Diagnostics bundle for the "Report a problem" dialog. Renderer
  // passes its own connection-state snapshot since the device managers
  // live there.
  collectDiagnostics: (rendererState) => ipcRenderer.invoke('collect-diagnostics', rendererState),
  saveFile: (opts) => ipcRenderer.invoke('save-text-file', opts),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  // Non-recursive listing of video files in a directory. Used by the
  // VR Format panel's "Apply to all videos in this folder" button.
  enumerateFolderVideos: (dirPath) => ipcRenderer.invoke('enumerate-folder-videos', dirPath),
  // i18n — read once at boot to drive the first-launch language-offer
  // toast (see notes/features/IMPL-multi-language.md §3).
  getSystemLocale: () => ipcRenderer.invoke('get-system-locale'),

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
  eroscriptsLoginWindow: () => ipcRenderer.invoke('eroscripts-login-window'),
  eroscriptsLogout: () => ipcRenderer.invoke('eroscripts-logout'),
  eroscriptsRestoreSession: (cookie, username) => ipcRenderer.invoke('eroscripts-restore-session', cookie, username),
  eroscriptsStatus: () => ipcRenderer.invoke('eroscripts-status'),
  eroscriptsValidate: () => ipcRenderer.invoke('eroscripts-validate'),
  eroscriptsSearch: (query, page) => ipcRenderer.invoke('eroscripts-search', query, page),
  eroscriptsTopic: (topicId) => ipcRenderer.invoke('eroscripts-topic', topicId),
  eroscriptsTopicImage: (topicId) => ipcRenderer.invoke('eroscripts-topic-image', topicId),
  eroscriptsDownload: (url, savePath) => ipcRenderer.invoke('eroscripts-download', url, savePath),

  // Editor pop-out window
  editorPopoutOpen: () => ipcRenderer.invoke('editor-popout:open'),
  editorPopoutClose: () => ipcRenderer.invoke('editor-popout:close'),
  editorPopoutStatus: () => ipcRenderer.invoke('editor-popout:status'),
  editorPopoutRelay: (direction, payload) => ipcRenderer.invoke('editor-popout:relay', direction, payload),
  onEditorPopoutEvent: (callback) => {
    const handler = (_event, evt) => callback(evt);
    ipcRenderer.on('editor-popout:event', handler);
    return () => ipcRenderer.removeListener('editor-popout:event', handler);
  },

  // Audience pop-out window (SCOPE-audience-broadcast.md §3.3)
  audiencePopoutOpen: () => ipcRenderer.invoke('audience-popout:open'),
  audiencePopoutClose: () => ipcRenderer.invoke('audience-popout:close'),
  audiencePopoutStatus: () => ipcRenderer.invoke('audience-popout:status'),
  audiencePopoutRelay: (direction, payload) => ipcRenderer.invoke('audience-popout:relay', direction, payload),
  onAudiencePopoutEvent: (callback) => {
    const handler = (_event, evt) => callback(evt);
    ipcRenderer.on('audience-popout:event', handler);
    return () => ipcRenderer.removeListener('audience-popout:event', handler);
  },

  // Player pop-out window (SCOPE-separate-player-window.md — detached player)
  playerPopoutOpen: () => ipcRenderer.invoke('player-popout:open'),
  playerPopoutClose: () => ipcRenderer.invoke('player-popout:close'),
  playerPopoutStatus: () => ipcRenderer.invoke('player-popout:status'),
  playerPopoutRelay: (direction, payload) => ipcRenderer.invoke('player-popout:relay', direction, payload),
  onPlayerPopoutEvent: (callback) => {
    const handler = (_event, evt) => callback(evt);
    ipcRenderer.on('player-popout:event', handler);
    return () => ipcRenderer.removeListener('player-popout:event', handler);
  },

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
