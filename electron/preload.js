const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('funsync', {
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

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
  scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  selectFunscript: () => ipcRenderer.invoke('select-funscript'),
  readFunscript: (filePath) => ipcRenderer.invoke('read-funscript', filePath),

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
  convertFunscript: (content) => ipcRenderer.invoke('convert-funscript', content),
});
