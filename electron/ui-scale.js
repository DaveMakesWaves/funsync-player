// UI scale: Settings > Appearance > Interface size, and the View menu's
// Ctrl+= / Ctrl+- / Ctrl+0 (Pudknocker, EroScripts #372; app test V79).
//
// One value, `settings.player.uiScale` (a percentage, DEFAULTS in store.js),
// is the main window's zoom. Main owns it:
//   - createWindow() opens the window at it (`webPreferences.zoomFactor`),
//     which Electron applies when the page commits, before its first paint,
//     so a saved 125% never shows a frame at 100% first;
//   - the View menu's zoom keys step through UI_SCALE_STEPS and SAVE the
//     step, then tell the renderer (`ui-scale-changed`) so DataService and an
//     open Settings panel show it; Ctrl+0 goes back to 100%, the default;
//   - a change in Settings arrives through `set-setting` and is applied here.
//
// The caption-button strip (Windows Controls Overlay) is sized in screen
// pixels while the nav bar it sits in is 48 CSS px, so its height follows
// the zoom (titleBarHeightFor). Without that, 80% left the buttons hanging
// below the nav bar over the page, and 125% left a gap under them.
//
// Only the MAIN window is scaled and saved. In a pop-out (player, editor,
// audience) or DevTools the keys still zoom that window the way Electron's
// built-in zoom roles did (half a zoom level a press, back to 100% on
// Ctrl+0), for that session only. The web remote is a page on the phone and
// is not affected. A VR video in the player keeps Ctrl+= / Ctrl+- / Ctrl+0
// for its own zoom: keyboard.js preventDefaults them there, so the menu
// accelerator never fires (V45).

const UI_SCALE_STEPS = Object.freeze([80, 90, 100, 110, 125, 150]);
const DEFAULT_UI_SCALE = 100;
const UI_SCALE_SETTING = 'player.uiScale';
// Chromium's zoom step for one press of the built-in zoom roles.
const ROLE_ZOOM_LEVEL_STEP = 0.5;

/** Any stored value as one of UI_SCALE_STEPS: the nearest, or the default. */
function normalizeUiScale(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return DEFAULT_UI_SCALE;
  let best = UI_SCALE_STEPS[0];
  for (const s of UI_SCALE_STEPS) {
    if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  }
  return best;
}

/** The step after `current` in `dir` (+1 larger, -1 smaller, 0 = the default). Clamped at both ends. */
function stepUiScale(current, dir) {
  if (!dir) return DEFAULT_UI_SCALE;
  const i = UI_SCALE_STEPS.indexOf(normalizeUiScale(current));
  const j = Math.min(UI_SCALE_STEPS.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)));
  return UI_SCALE_STEPS[j];
}

/**
 * @param {object} deps
 * @param {{getSetting: Function, setSetting: Function}} deps.store  electron/store.js
 * @param {() => (Electron.BrowserWindow|null)} deps.getMainWindow
 * @param {() => (Electron.WebContents|null)} deps.getFocusedWebContents  webContents.getFocusedWebContents
 * @param {(wc: Electron.WebContents) => (Electron.BrowserWindow|null)} deps.fromWebContents  BrowserWindow.fromWebContents
 * @param {number} deps.titleBarHeight  window-bg.js TITLE_BAR_HEIGHT (CSS px of the nav bar)
 * @param {boolean} [deps.hasTitleBarOverlay]  Windows only
 * @param {{info: Function, warn: Function}} [deps.log]
 */
function createUiScale({
  store, getMainWindow, getFocusedWebContents, fromWebContents, titleBarHeight,
  hasTitleBarOverlay = process.platform === 'win32', log = null,
}) {
  const saved = () => normalizeUiScale(store.getSetting(UI_SCALE_SETTING));
  const liveMain = () => {
    const w = getMainWindow();
    return w && !w.isDestroyed() ? w : null;
  };
  const zoomOf = (win) => {
    try { return win?.webContents?.getZoomFactor?.() || 1; } catch { return 1; }
  };

  /** Overlay height (screen px) that matches a nav bar of `titleBarHeight` CSS px at this window's zoom. */
  function titleBarHeightFor(win) {
    return Math.round(titleBarHeight * zoomOf(win));
  }

  function syncTitleBar(win) {
    if (!hasTitleBarOverlay || !win || win.isDestroyed()) return;
    try { win.setTitleBarOverlay?.({ height: titleBarHeightFor(win) }); } catch { /* overlay not active */ }
  }

  /** Zoom the main window to `value` and save it. Returns the step applied. */
  function apply(value, { notifyRenderer = false } = {}) {
    const scale = normalizeUiScale(value);
    if (store.getSetting(UI_SCALE_SETTING) !== scale) store.setSetting(UI_SCALE_SETTING, scale);
    const win = liveMain();
    if (win) {
      try { win.webContents.setZoomFactor(scale / 100); } catch { /* window going away */ }
      syncTitleBar(win);
      if (notifyRenderer) {
        try { win.webContents.send('ui-scale-changed', scale); } catch { /* ignore */ }
      }
    }
    return scale;
  }

  /** What one press of a View-menu zoom key does. `kind`: 'in' | 'out' | 'reset'. */
  function menuZoom(kind) {
    const wc = getFocusedWebContents?.() || null;
    const main = liveMain();
    if (main && (!wc || wc === main.webContents)) {
      const before = saved();
      const next = stepUiScale(before, kind === 'in' ? 1 : kind === 'out' ? -1 : 0);
      // Even when the step does not move (already at 150%), re-send so the
      // window and the setting can never disagree.
      apply(next, { notifyRenderer: true });
      if (next !== before) log?.info?.(`[UI scale] ${before}% -> ${next}% (View menu)`);
      return next;
    }
    if (!wc) return null;
    // A pop-out or DevTools: the built-in roles' behaviour, not saved.
    try {
      if (kind === 'reset') wc.setZoomLevel(0);
      else wc.setZoomLevel(wc.getZoomLevel() + (kind === 'in' ? ROLE_ZOOM_LEVEL_STEP : -ROLE_ZOOM_LEVEL_STEP));
    } catch { /* ignore */ }
    syncTitleBar(fromWebContents?.(wc) || null);
    return null;
  }

  /**
   * The View menu's zoom items. Labels match Electron's built-in roles (the
   * menu bar is hidden; these are for its accelerators). Ctrl+= rather than
   * Ctrl+Plus: Electron reads "Plus" as the `+` character, which needs Shift
   * on US/UK layouts, while browsers zoom on the physical = key.
   */
  function menuItems() {
    return [
      { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => menuZoom('reset') },
      { label: 'Zoom In', accelerator: 'CommandOrControl+=', click: () => menuZoom('in') },
      { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => menuZoom('out') },
    ];
  }

  /** For createWindow(): the saved scale as BrowserWindow options. */
  function windowOptions() {
    const scale = saved();
    return {
      scale,
      zoomFactor: scale / 100,
      titleBarHeight: Math.round(titleBarHeight * (scale / 100)),
    };
  }

  /** `set-setting` from a renderer (Settings > Appearance). */
  function onSettingWritten(path, value) {
    if (path !== UI_SCALE_SETTING) return;
    const scale = apply(value);
    // A value that was not a step is saved as the step it became; tell the
    // renderer so its cache does not keep the raw one.
    if (scale !== value) {
      const win = liveMain();
      try { win?.webContents.send('ui-scale-changed', scale); } catch { /* ignore */ }
    }
  }

  return { apply, menuZoom, menuItems, windowOptions, onSettingWritten, titleBarHeightFor, syncTitleBar };
}

module.exports = {
  UI_SCALE_STEPS, DEFAULT_UI_SCALE, UI_SCALE_SETTING, normalizeUiScale, stepUiScale, createUiScale,
};
