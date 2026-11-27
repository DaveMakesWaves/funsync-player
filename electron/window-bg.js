// Window chrome colors — every BrowserWindow's backgroundColor (and, on
// Windows, the title-bar overlay) should match the app's surface color so
// launch/resize never flashes a foreign color and the frame reads as one
// piece with the UI (ScriptPlayer+-style premium chrome; Dave 2026-08-04).
//
// The store isn't initialised until whenReady and windows may be created
// before/without it, so this reads config.json directly — same pattern as
// the Linux hw-decode flag at the top of main.js. Falls back to the dark
// theme (the app default) when no config exists yet.

const fs = require('fs');
const path = require('path');
const { app, nativeTheme } = require('electron');

// Must mirror renderer/styles/player.css for each theme:
//   window background   → `--surface-base`   (the page behind everything)
//   title-bar overlay   → `--surface-elevated` (the NAV BAR's background —
//     the caption buttons are embedded IN the nav bar, so they must match
//     ITS surface, not the page. Using surface-base here left the caption
//     strip a visibly different shade; Dave 2026-08-04.)
const DARK_BG = '#1a1a2e';
const LIGHT_BG = '#f5f5f7';
const DARK_CHROME = '#16213e';   // --surface-elevated (dark)
const LIGHT_CHROME = '#ffffff';  // --surface-elevated (light)
const DARK_SYMBOL = '#e0e0e6';   // caption-button glyph color on dark
const LIGHT_SYMBOL = '#333333';
// The Holiday interface style (v0.10.1, renderer/styles/holiday.css): its own
// surfaces, and in Light a pine-green nav bar with white text.
const HOLIDAY = {
  dark: { background: '#0e1915', chrome: '#12231d', symbol: '#ece7dc' },
  light: { background: '#f7f3ec', chrome: '#1d4636', symbol: '#ffffff' },
};

/**
 * Colors for an explicit theme value ('dark' | 'light' | 'system'), and the
 * season ('holiday' for the Holiday interface style, else none).
 * @returns {{ background: string, symbol: string, dark: boolean }}
 */
function colorsForTheme(theme, season = null) {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors !== false);
  if (season === 'holiday') return { ...HOLIDAY[dark ? 'dark' : 'light'], dark };
  return {
    background: dark ? DARK_BG : LIGHT_BG,
    chrome: dark ? DARK_CHROME : LIGHT_CHROME,
    symbol: dark ? DARK_SYMBOL : LIGHT_SYMBOL,
    dark,
  };
}

/**
 * Resolve the window chrome colors from the user's saved theme setting.
 * Disk read — for window CREATION (before/without the store). Live theme
 * switches pass the theme straight to colorsForTheme instead (the settings
 * write is fire-and-forget IPC, so a disk read could race it).
 */
function resolveWindowColors() {
  let theme = 'system';
  let season = null;
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
    const player = JSON.parse(raw)?.settings?.player;
    const saved = player?.theme;
    if (saved === 'dark' || saved === 'light' || saved === 'system') theme = saved;
    season = seasonForStyle(player?.uiStyle);
  } catch { /* no config yet → system */ }
  return colorsForTheme(theme, season);
}

/** The window chrome's season for an Interface style setting. Pure. */
function seasonForStyle(uiStyle) {
  return uiStyle === 'holiday' ? 'holiday' : null;
}

let _chromeSeason; // undefined until read from config.json or told by the renderer

/**
 * The season the window chrome is painted for (v0.10.1). The renderer says it
 * when the Interface style changes (opts.season 'holiday' | 'none'); every
 * other update-window-chrome call (dimmed, over the video, a pop-out's theme)
 * keeps it. Until the renderer says, what config.json says, which is what the
 * windows were created with.
 * @param {{ season?: string }} [opts]
 * @returns {'holiday'|null}
 */
function chromeSeason(opts) {
  if (opts && (opts.season === 'holiday' || opts.season === 'none')) {
    _chromeSeason = opts.season === 'holiday' ? 'holiday' : null;
  }
  if (_chromeSeason === undefined) _chromeSeason = resolveSeason();
  return _chromeSeason;
}

/** Test helper: forget what the renderer said. */
function _resetChromeSeasonForTests() { _chromeSeason = undefined; }

/** The saved Interface style's season, from config.json (a disk read, as above). */
function resolveSeason() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
    return seasonForStyle(JSON.parse(raw)?.settings?.player?.uiStyle);
  } catch {
    return null;
  }
}

/**
 * The page's dialog backdrop is black at 60% (modal.css `.modal-overlay`).
 * The caption buttons are drawn by the OS above the page, so the backdrop
 * never reaches them: they stayed full brightness over a dimmed window
 * (FT-100). This is a colour as it looks under that backdrop.
 */
const BACKDROP_ALPHA = 0.6;

/**
 * `hex` (#rgb or #rrggbb) blended `amount` of the way toward black.
 * @returns {string} #rrggbb
 */
function dimColor(hex, amount = BACKDROP_ALPHA) {
  let h = String(hex || '').replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return hex;
  const keep = 1 - Math.min(1, Math.max(0, amount));
  const out = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * keep));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Title-bar height. Matches `.nav-bar` so caption buttons align with it. */
const TITLE_BAR_HEIGHT = 48;

/**
 * BrowserWindow options for the themed Windows Controls Overlay chrome —
 * the one definition every window uses (main + all three pop-outs), so a
 * pop-out can never drift from the main window's title bar (Dave
 * 2026-08-04: pop-outs should share the main window's top-bar styling).
 *
 * Returns `{}` off Windows, where the native frame is kept.
 *
 * IMPORTANT: `titleBarStyle: 'hidden'` removes the OS title bar, so any
 * window using this MUST provide its own drag region in the renderer
 * (`-webkit-app-region: drag`) or it becomes undraggable.
 *
 * @param {{background: string, chrome: string, symbol: string}} colors
 */
function winChromeOptions(colors) {
  if (process.platform !== 'win32') return {};
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // chrome = the nav bar's surface (--surface-elevated), NOT the page
      // background — the caption buttons live inside the nav bar.
      color: colors.chrome,
      symbolColor: colors.symbol,
      height: TITLE_BAR_HEIGHT,
    },
  };
}

module.exports = {
  resolveWindowColors, resolveSeason, chromeSeason, _resetChromeSeasonForTests, colorsForTheme, seasonForStyle, winChromeOptions, TITLE_BAR_HEIGHT, HOLIDAY,
  DARK_BG, LIGHT_BG, DARK_SYMBOL, LIGHT_SYMBOL, dimColor, BACKDROP_ALPHA,
};
