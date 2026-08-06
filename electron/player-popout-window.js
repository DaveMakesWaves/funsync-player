// Player pop-out window — a detached BrowserWindow that (from Phase 2b on)
// hosts the actual <video> element so the user can watch on one monitor
// while the library stays browseable in the main window. Owned by the
// main process, which brokers state between the main renderer (library,
// device managers, sync engines) and the player renderer.
//
// Phase 2a (this file's first cut): window shell + lifecycle only. The
// video move + the IPC playback proxy that keeps device sync following
// the detached clock land in 2b/2c. See
// notes/features/SCOPE-separate-player-window.md §9.
//
// Mirrors electron/audience-popout-window.js exactly — same lifecycle,
// same single-channel `{type:'message', payload}` envelope, same
// size-only bounds persistence (position doesn't travel across monitor
// setups). Channel: `player-popout:event`.

const path = require('path');
const { BrowserWindow } = require('electron');

let popoutWindow = null;
let parentWindow = null;
let storeRef = null;

const POPOUT_BOUNDS_KEY = 'player.popoutBounds';
const DEFAULT_BOUNDS = { width: 960, height: 540 }; // 16:9

function isOpen() {
  return !!(popoutWindow && !popoutWindow.isDestroyed());
}

function getWindow() {
  return isOpen() ? popoutWindow : null;
}

function getParent() {
  return parentWindow;
}

function getLastBounds() {
  if (!storeRef) return { ...DEFAULT_BOUNDS };
  const saved = storeRef.getSetting(POPOUT_BOUNDS_KEY);
  if (saved && typeof saved === 'object' && saved.width && saved.height) {
    return saved;
  }
  return { ...DEFAULT_BOUNDS };
}

function persistBounds() {
  if (!isOpen() || !storeRef) return;
  try {
    const bounds = popoutWindow.getBounds();
    storeRef.setSetting(POPOUT_BOUNDS_KEY, {
      width: bounds.width,
      height: bounds.height,
      // Size only — position doesn't travel well across monitor changes
      // (matches editor / audience pop-outs).
    });
  } catch { /* window torn down mid-call — fine */ }
}

/**
 * Open the player pop-out. If already open, focus the existing window
 * (Bring to front). Returns the BrowserWindow.
 *
 * `backgroundThrottling: false` — critical for Phase 2c: the user
 * foregrounds THIS window to watch, backgrounding the main window that
 * holds the sync-engine timers. Chromium would otherwise throttle the
 * player window's own timers too; keeping both un-throttled avoids device
 * stutter. Harmless for the 2a shell. (SCOPE §9.5.)
 *
 * @param {BrowserWindow} parent
 * @param {object} store — electron/store.js for bounds persistence
 */
function open(parent, store) {
  parentWindow = parent;
  storeRef = store;

  if (isOpen()) {
    if (popoutWindow.isMinimized()) popoutWindow.restore();
    popoutWindow.focus();
    return popoutWindow;
  }

  const bounds = getLastBounds();

  // Deliberately NOT a `parent`-child window. A child window on Windows
  // gets no taskbar entry of its own and minimizing it hides it "into"
  // the parent (it vanishes with no way back) — wrong for a player the
  // user puts on a second monitor and minimizes independently. So it's a
  // top-level window with its own taskbar button + normal minimize. The
  // trade-off (no auto-close-with-parent) is handled explicitly below so
  // the window can't orphan and keep the app alive after main closes.
  popoutWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 480,
    minHeight: 270,
    title: 'FunSync Player',
    autoHideMenuBar: true,
    // Theme surface, not black — matches the main window chrome so the
    // pop-out reads as part of the app (the video element paints its own
    // black letterbox; this only shows pre-paint / during resize).
    backgroundColor: require('./window-bg').resolveWindowColors().background,
    // Same themed title-bar overlay as the main window. The renderer supplies
    // the drag region (player-popout.css `.ppo-dragstrip`).
    ...require('./window-bg').winChromeOptions(require('./window-bg').resolveWindowColors()),
    icon: path.join(
      __dirname,
      '..',
      'assets',
      'icons',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png',
    ),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  popoutWindow.loadFile(path.join(__dirname, '..', 'renderer', 'player-popout.html'));

  popoutWindow.on('resize', persistBounds);

  popoutWindow.on('closed', () => {
    popoutWindow = null;
    if (parent && !parent.isDestroyed()) {
      // Main renderer folds playback back into the inline player and
      // re-binds sync to the local <video> (2c). For 2a it just updates
      // the toggle button state.
      parent.webContents.send('player-popout:event', { type: 'closed' });
    }
  });

  // Orphan protection: since this window is top-level (no `parent`), it
  // would otherwise keep the app alive after the user closes the main
  // window (window-all-closed never fires). Close it with the main window.
  if (parent && !parent.isDestroyed()) {
    parent.once('closed', () => { try { close(); } catch { /* already gone */ } });
  }

  if (parent && !parent.isDestroyed()) {
    parent.webContents.send('player-popout:event', { type: 'opened' });
  }

  popoutWindow.webContents.once('did-finish-load', () => {
    if (isOpen()) {
      popoutWindow.webContents.send('player-popout:event', { type: 'opened' });
    }
  });

  return popoutWindow;
}

function close() {
  if (isOpen()) {
    popoutWindow.close();
  }
}

/**
 * Forward a state-sync message between parent and pop-out.
 * `direction` is `'to-popout'` or `'to-parent'`.
 */
function relay(direction, payload) {
  const wrapped = { type: 'message', payload };
  if (direction === 'to-popout' && isOpen()) {
    popoutWindow.webContents.send('player-popout:event', wrapped);
  } else if (direction === 'to-parent' && parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.webContents.send('player-popout:event', wrapped);
  }
}

module.exports = {
  open,
  close,
  isOpen,
  getWindow,
  getParent,
  relay,
};
