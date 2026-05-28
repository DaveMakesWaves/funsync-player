// Editor pop-out window — separate BrowserWindow that hosts the script
// editor on a second monitor. Owned by the main process so it can broker
// state-sync messages between the main renderer and the pop-out renderer
// (the locked decision in `notes/features/SCOPE-editor-v2.md` §5.4 was
// IPC-through-main rather than BroadcastChannel / SharedWorker).
//
// Lifecycle:
//   - `open(parent, store)` — creates the window if not already open,
//     restores last-saved bounds, broadcasts an `editor-popout:opened`
//     event to the parent so the parent can collapse its editor panel
//     and free the screen for video playback (locked decision §5.3 — the
//     pop-out takes full ownership; main shows only the video).
//   - `close()` — destroys the window. The `closed` listener notifies
//     the parent so the editor docks back.
//   - `relay(direction, payload)` — forwards a message from one side to
//     the other. Used for state-sync messages whose ordering matters
//     (edits, undo/redo, viewport changes).
//
// Locked decision §5.5: do NOT auto-reopen on app restart. The pop-out
// is on-demand each launch — `getLastBounds` persists size and position
// across opens within a session for convenience, but the open state
// itself is intentionally not persisted.

const path = require('path');
const { BrowserWindow } = require('electron');

let popoutWindow = null;
let parentWindow = null;
let storeRef = null;

const POPOUT_BOUNDS_KEY = 'editor.popoutBounds';
const DEFAULT_BOUNDS = { width: 1100, height: 700 };

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
      // Don't persist x/y — multi-monitor users move setups around;
      // restoring at last-saved coords on a setup that no longer has
      // that monitor lands the window off-screen. Size travels well;
      // position doesn't.
    });
  } catch { /* window torn down mid-call — fine */ }
}

/**
 * Open the editor pop-out. If already open, focus the existing window
 * instead of creating a new one. Returns the BrowserWindow.
 *
 * @param {BrowserWindow} parent — main window (used as parent for
 *   parent-child relationship + to receive open/close notifications).
 * @param {object} store — `electron/store.js` for bounds persistence.
 */
function open(parent, store) {
  parentWindow = parent;
  storeRef = store;

  if (isOpen()) {
    popoutWindow.focus();
    return popoutWindow;
  }

  const bounds = getLastBounds();

  popoutWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 600,
    minHeight: 400,
    title: 'FunSync — Script Editor',
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

  popoutWindow.loadFile(path.join(__dirname, '..', 'renderer', 'editor-popout.html'));

  popoutWindow.on('resize', persistBounds);

  popoutWindow.on('closed', () => {
    popoutWindow = null;
    if (parent && !parent.isDestroyed()) {
      // Tell the parent so it can re-show the docked editor panel.
      // All lifecycle events ride on the single `editor-popout:event`
      // channel so the renderer-side subscription is one listener.
      parent.webContents.send('editor-popout:event', { type: 'closed' });
    }
  });

  if (parent && !parent.isDestroyed()) {
    parent.webContents.send('editor-popout:event', { type: 'opened' });
  }

  // When the pop-out window finishes loading, tell IT that it opened
  // too. This lets the pop-out-side bootstrap know when to start
  // requesting initial state from the parent. Without this the pop-out
  // would have to poll or guess.
  popoutWindow.webContents.once('did-finish-load', () => {
    if (isOpen()) {
      popoutWindow.webContents.send('editor-popout:event', { type: 'opened' });
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
 * Forward a state-sync message between the parent and the pop-out.
 * `direction` is `'to-popout'` or `'to-parent'`. `payload` is whatever
 * the renderers want to ferry — actions diff, viewport range, time
 * tick, edit op, etc. Single broker so message ordering is preserved
 * and we get a natural dev-time observability point (a console.log
 * here logs the entire wire).
 */
function relay(direction, payload) {
  // Wrap the payload in a `{ type: 'message', payload }` envelope so
  // every event on the renderer side shares the same shape. The
  // listener in script-editor.js / editor-popout.js disambiguates on
  // `event.type`, not on channel name.
  const wrapped = { type: 'message', payload };
  if (direction === 'to-popout' && isOpen()) {
    popoutWindow.webContents.send('editor-popout:event', wrapped);
  } else if (direction === 'to-parent' && parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.webContents.send('editor-popout:event', wrapped);
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
