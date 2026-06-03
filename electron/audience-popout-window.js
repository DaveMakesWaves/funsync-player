// Audience pop-out window — separate BrowserWindow that hosts the
// audience-room management UI. Owned by the main process so it can
// broker state-sync messages between the main renderer (which owns
// AudienceBridge + SDK sessions) and the pop-out renderer (the
// management surface).
//
// Mirrors the editor-popout-window pattern (locked in SCOPE §3.3) —
// same lifecycle shape, same single-channel event envelope, same
// bounds persistence rule (size only, not position; multi-monitor
// users move setups around).
//
// Lifecycle:
//   - `open(parent, store)` — creates the window if not open, restores
//     bounds, broadcasts `audience-popout:event { type: 'opened' }`.
//     Idempotent — second call just focuses the existing window
//     (matches the SCOPE's "Bring to front" semantics, AB-23).
//   - `close()` — destroys the window. Room stays alive in the main
//     renderer per AB-19; closing the window only hides the management
//     UI, doesn't end the room.
//   - `relay(direction, payload)` — single broker for state-sync
//     messages. Same envelope shape as editor-popout for consistency.

const path = require('path');
const { BrowserWindow } = require('electron');

let popoutWindow = null;
let parentWindow = null;
let storeRef = null;

const POPOUT_BOUNDS_KEY = 'audience.popoutBounds';
const DEFAULT_BOUNDS = { width: 720, height: 600 };

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
      // Size only — see editor-popout-window.js for the multi-monitor
      // rationale. Position doesn't travel well.
    });
  } catch { /* window torn down mid-call — fine */ }
}

/**
 * Open the audience-room pop-out. If already open, focus the existing
 * window (Bring to front, AB-23). Returns the BrowserWindow.
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

  popoutWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 480,
    minHeight: 400,
    title: 'FunSync — Audience Room',
    parent,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a2e',
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
    },
  });

  popoutWindow.loadFile(path.join(__dirname, '..', 'renderer', 'audience-room.html'));

  popoutWindow.on('resize', persistBounds);

  popoutWindow.on('closed', () => {
    popoutWindow = null;
    if (parent && !parent.isDestroyed()) {
      // Closing the window does NOT end the room (AB-19). Main renderer
      // just updates its tab UI to show "Bring to front" instead of
      // "Create Room". Room state stays in AudienceBridge.
      parent.webContents.send('audience-popout:event', { type: 'closed' });
    }
  });

  if (parent && !parent.isDestroyed()) {
    parent.webContents.send('audience-popout:event', { type: 'opened' });
  }

  popoutWindow.webContents.once('did-finish-load', () => {
    if (isOpen()) {
      popoutWindow.webContents.send('audience-popout:event', { type: 'opened' });
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
    popoutWindow.webContents.send('audience-popout:event', wrapped);
  } else if (direction === 'to-parent' && parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.webContents.send('audience-popout:event', wrapped);
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
