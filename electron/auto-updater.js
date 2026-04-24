// Auto-updater — checks GitHub Releases for new versions
const { autoUpdater } = require('electron-updater');
const log = require('./logger');

let _mainWindow = null;

/**
 * Initialize auto-updater. Call once after the main window is created.
 * @param {BrowserWindow} mainWindow
 */
function initAutoUpdater(mainWindow) {
  _mainWindow = mainWindow;

  // Log to electron-log
  autoUpdater.logger = log;

  // Don't auto-download — let the user decide
  autoUpdater.autoDownload = false;

  // Don't auto-install on quit either — the user controls every step of
  // the update flow (download + install). Closing the app without clicking
  // "Restart Now" leaves the downloaded update cached; next launch the
  // renderer shows the update-available toast again, Download short-
  // circuits (electron-updater returns the cached artifact), and the user
  // can install on their own schedule.
  autoUpdater.autoInstallOnAppQuit = false;

  // --- Events ---

  autoUpdater.on('checking-for-update', () => {
    log.info('[AutoUpdater] Checking for update...');
    _send('update:checking');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[AutoUpdater] Update available:', info.version);
    _send('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('[AutoUpdater] Up to date:', info.version);
    _send('update:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    _send('update:download-progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[AutoUpdater] Update downloaded:', info.version);
    _send('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    log.error('[AutoUpdater] Error:', err.message);
    _send('update:error', { message: err.message });
  });

  // Check for updates after a short delay (let the app finish loading)
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
}

/**
 * Check for updates (silent — no error dialogs).
 */
function checkForUpdates() {
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    log.warn('[AutoUpdater] Check failed:', err.message);
  }
}

/**
 * Start downloading the available update.
 */
function downloadUpdate() {
  try {
    autoUpdater.downloadUpdate();
  } catch (err) {
    log.error('[AutoUpdater] Download failed:', err.message);
  }
}

/**
 * Quit and install the downloaded update.
 */
function quitAndInstall() {
  autoUpdater.quitAndInstall(false, true);
}

/**
 * Send an event to the renderer process.
 */
function _send(channel, data) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send(channel, data);
  }
}

module.exports = { initAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall };
