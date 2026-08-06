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

/**
 * Colors for an explicit theme value ('dark' | 'light' | 'system').
 * @returns {{ background: string, symbol: string, dark: boolean }}
 */
function colorsForTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors !== false);
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
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
    const saved = JSON.parse(raw)?.settings?.player?.theme;
    if (saved === 'dark' || saved === 'light' || saved === 'system') theme = saved;
  } catch { /* no config yet → system */ }
  return colorsForTheme(theme);
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
  resolveWindowColors, colorsForTheme, winChromeOptions, TITLE_BAR_HEIGHT,
  DARK_BG, LIGHT_BG, DARK_SYMBOL, LIGHT_SYMBOL,
};
