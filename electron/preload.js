const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('funsync', {
  // Static platform identifier from the main process — used by anything
  // that needs to branch on OS (HEVC codec install guidance, native
  // dialog quirks, etc.) without an IPC roundtrip. Values match
  // Node's `process.platform`: 'win32' | 'linux' | 'darwin' | 'freebsd' | …
  platform: process.platform,
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),

  // Global hotkeys (Eroto #316). `setGlobalShortcuts` returns a per-action
  // {ok} so the settings UI can tell the user which binding another
  // application already owns, rather than showing a key that does nothing.
  setGlobalShortcuts: (bindings) => ipcRenderer.invoke('set-global-shortcuts', bindings),
  onGlobalShortcut: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('global-shortcut', handler);
    return () => ipcRenderer.removeListener('global-shortcut', handler);
  },
  // Duplicate finder. `trashVideoFiles` is the app's only destructive file
  // operation — it moves to the OS Recycle Bin and returns a per-path result,
  // never a bare boolean, so the UI can report what actually happened.
  statVideoFiles: (paths) => ipcRenderer.invoke('stat-video-files', paths),
  // Read-only sampled sha256 per path, for the "Identical" tier (FT-B01).
  hashVideoFiles: (paths) => ipcRenderer.invoke('hash-video-files', paths),
  trashVideoFiles: (paths) => ipcRenderer.invoke('trash-video-files', paths),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPortableInfo: () => ipcRenderer.invoke('get-portable-info'),

  // Interface size (V79). The steps Settings > Appearance offers come from
  // the module main applies them with, so the two cannot drift. Main sends
  // `ui-scale-changed` after the View menu's zoom keys saved a new step.
  uiScaleSteps: [...require('./ui-scale').UI_SCALE_STEPS],
  uiScaleDefault: require('./ui-scale').DEFAULT_UI_SCALE,
  onUiScaleChanged: (cb) => {
    const handler = (_e, scale) => cb(scale);
    ipcRenderer.on('ui-scale-changed', handler);
    return () => ipcRenderer.removeListener('ui-scale-changed', handler);
  },

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
  addVideosToPlaylist: (id, videoPaths) => ipcRenderer.invoke('add-videos-to-playlist', id, videoPaths),
  removeVideosFromPlaylist: (id, videoPaths) => ipcRenderer.invoke('remove-videos-from-playlist', id, videoPaths),
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
  // `{ multiple: true }`: several files, answered as a list (N-04).
  // `{ defaultPath }`: open at that script's folder, or its nearest existing
  // parent (Locate, 2026-11-18; main validates it).
  selectFunscript: (opts) => ipcRenderer.invoke('select-funscript', opts),
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
  // `opts.why`: each answer is `{ status, why }` instead, telling a timeout
  // from a denial (R4-14); without it the tri-state array as always.
  filesExist: (filePaths, timeoutMs, opts) => ipcRenderer.invoke('files-exist', filePaths, timeoutMs, opts),
  dirsListable: (dirPaths, timeoutMs) => ipcRenderer.invoke('dirs-listable', dirPaths, timeoutMs),

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
  // Import and Restore relaunch with app.exit, which skips beforeunload, so
  // main asks first: stop playback and every device, then answer with the
  // same token (electron/relaunch-stop.js).
  onStopForRelaunch: (cb) => {
    const handler = (_e, token) => cb(token);
    ipcRenderer.on('app:stop-for-relaunch', handler);
    return () => ipcRenderer.removeListener('app:stop-for-relaunch', handler);
  },
  stoppedForRelaunch: (token) => ipcRenderer.send('app:stopped-for-relaunch', token),
  // Unsaved script-editor edits on the way out (R3-19): the editor reports
  // when it turns dirty or clean; while dirty, main asks before a close,
  // quit, reload, update install or relaunch. The renderer acknowledges at
  // once, then answers with the user's choice (electron/unsaved-edits-guard.js).
  editorDirtyChanged: (dirty) => ipcRenderer.send('editor:dirty-state', dirty === true),
  onConfirmUnsavedBeforeExit: (cb) => {
    const handler = (_e, token, reason, expiresAt) => cb(token, reason, expiresAt);
    ipcRenderer.on('app:confirm-unsaved', handler);
    return () => ipcRenderer.removeListener('app:confirm-unsaved', handler);
  },
  // Main went ahead without this page's answer (it was busy past main's
  // 10 s, or unresponsive): that question is withdrawn (R4 fix-up).
  onConfirmUnsavedExpired: (cb) => {
    const handler = (_e, token) => cb(token);
    ipcRenderer.on('app:confirm-unsaved-expired', handler);
    return () => ipcRenderer.removeListener('app:confirm-unsaved-expired', handler);
  },
  confirmUnsavedAck: (token) => ipcRenderer.send('app:confirm-unsaved-ack', token),
  confirmUnsavedAnswer: (token, go) => ipcRenderer.send('app:confirm-unsaved-answer', token, go !== false),
  // The unsaved-edits question is about to open in the main window for an
  // action from another window: bring the main window forward (R3-21).
  bringMainWindowForward: () => ipcRenderer.send('main-window:bring-forward'),

  // Backend API proxies
  fetchMetadata: (videoPath) => ipcRenderer.invoke('fetch-metadata', videoPath),
  generateThumbnails: (videoPath, interval) => ipcRenderer.invoke('generate-thumbnails', videoPath, interval),
  generateSingleThumbnail: (videoPath, opts) => ipcRenderer.invoke('generate-single-thumbnail', videoPath, opts),
  remuxVideo: (videoPath) => ipcRenderer.invoke('remux-video', videoPath),
  resolveRemoteVideo: (pageUrl) => ipcRenderer.invoke('resolve-remote-video', pageUrl),
  getSpeedStats: () => ipcRenderer.invoke('get-speed-stats'),
  getDurations: () => ipcRenderer.invoke('get-durations'),
  // The funscript metadata harvest (P1 tags): {paths?, since?, cache?} -> answer | null.
  getScriptMeta: (query) => ipcRenderer.invoke('get-script-meta', query),
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
  eroscriptsCheckSession: (opts) => ipcRenderer.invoke('eroscripts-check-session', { force: opts?.force === true }),
  eroscriptsSearch: (query, page) => ipcRenderer.invoke('eroscripts-search', query, page),
  eroscriptsTopic: (topicId) => ipcRenderer.invoke('eroscripts-topic', topicId),
  eroscriptsTopicMeta: (topicId) => ipcRenderer.invoke('eroscripts-topic-meta', topicId),
  eroscriptsTopicImage: (topicId) => ipcRenderer.invoke('eroscripts-topic-image', topicId),
  eroscriptsDownload: (url, savePath, opts) => ipcRenderer.invoke('eroscripts-download', url, savePath, opts),
  // After a Cancel: main drops the bytes a look fetched for this URL (R4-09).
  eroscriptsForgetDownload: (url) => ipcRenderer.invoke('eroscripts-forget-download', url),
  // The Save dialog for a download, and nothing else: writes no file (R3-01).
  pickDownloadSavePath: (suggestedName) => ipcRenderer.invoke('pick-download-save-path', suggestedName),

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
  playerPopoutReveal: () => ipcRenderer.invoke('player-popout:reveal'),
  playerPopoutRelay: (direction, payload) => ipcRenderer.invoke('player-popout:relay', direction, payload),
  onPlayerPopoutEvent: (callback) => {
    const handler = (_event, evt) => callback(evt);
    ipcRenderer.on('player-popout:event', handler);
    return () => ipcRenderer.removeListener('player-popout:event', handler);
  },

  // Stash S1 (notes/features/DESIGN-stash-s1.md; main: electron/stash-ipc.js).
  // Every call returns plain JSON and never the API key. Main is the only
  // writer of the Stash data and of settings.stash.url / .trustedCert, and
  // tells the page: onStashChanged({rev}) after every data write (reload with
  // stashGetData), onStashSettingsChanged(block) after a settings write,
  // onStashProgress({kind, step, done, total}) during a sync and
  // ({kind, step: 'finished', result}) at its end.
  stashStatus: () => ipcRenderer.invoke('stash-status'),
  stashGetData: () => ipcRenderer.invoke('stash-get-data'),
  stashTest: (opts) => ipcRenderer.invoke('stash-test', opts),
  stashLink: (opts) => ipcRenderer.invoke('stash-link', opts),
  stashSetOptions: (opts) => ipcRenderer.invoke('stash-set-options', opts),
  stashSaveKey: (apiKey) => ipcRenderer.invoke('stash-save-key', apiKey),
  stashRemoveKey: () => ipcRenderer.invoke('stash-remove-key'),
  stashTrustCertificate: (opts) => ipcRenderer.invoke('stash-trust-certificate', opts),
  stashForgetCertificate: () => ipcRenderer.invoke('stash-forget-certificate'),
  stashSync: (opts) => ipcRenderer.invoke('stash-sync', opts),
  stashSyncOnStart: (opts) => ipcRenderer.invoke('stash-sync-on-start', opts),
  stashSyncVideo: (video) => ipcRenderer.invoke('stash-sync-video', video),
  stashCancel: () => ipcRenderer.invoke('stash-cancel'),
  stashSearch: (opts) => ipcRenderer.invoke('stash-search', opts),
  stashLinkScene: (opts) => ipcRenderer.invoke('stash-link-scene', opts),
  stashChoose: (opts) => ipcRenderer.invoke('stash-choose', opts),
  stashRefuse: (opts) => ipcRenderer.invoke('stash-refuse', opts),
  stashUnlink: (opts) => ipcRenderer.invoke('stash-unlink', opts),
  stashUndo: (undoId) => ipcRenderer.invoke('stash-undo', undoId),
  stashRehome: (moves) => ipcRenderer.invoke('stash-rehome', moves),
  stashRemoveData: () => ipcRenderer.invoke('stash-remove-data'),
  stashOpenScene: (opts) => ipcRenderer.invoke('stash-open-scene', opts),
  onStashChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('stash-changed', handler);
    return () => ipcRenderer.removeListener('stash-changed', handler);
  },
  onStashProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('stash-progress', handler);
    return () => ipcRenderer.removeListener('stash-progress', handler);
  },
  onStashSettingsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('stash-settings-changed', handler);
    return () => ipcRenderer.removeListener('stash-settings-changed', handler);
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
