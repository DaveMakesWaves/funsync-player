// The start-up splash's main-process side (Dave, 2026-11-25: the round logo
// with its bars playing; then "1,2,4,5" of the polish list):
//   1. it fades out over the main window instead of vanishing;
//   2. a start that takes longer than SLOW_MS says so under the logo, in the
//      saved language (the splash page has no i18n of its own: the line is
//      handed to it in the URL);
//   4. on Linux it is drawn on a solid navy window: some Linux desktops
//      cannot show a see-through window and would put the circle on a black
//      square (not checked on a Linux desktop here; the safe choice);
//   5. it fades in (renderer/splash.html).
'use strict';

const SPLASH_SIZE = 300;           // the circle
const SPLASH_LINE = 40;            // room under it for the slow-start line
const SLOW_MS = 4000;
const FADE_MS = 200;
const NAVY = '#1a1a2e';
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];

/** The slow-start line in `locale` (renderer/locales/*.json `splash.slow`), English when that has none. */
function splashSlowText(locale) {
  const pick = (loc) => {
    try {
      const s = require(`../renderer/locales/${loc}.json`)?.splash?.slow;
      return typeof s === 'string' && s.trim() ? s : null;
    } catch { return null; }
  };
  return pick(LOCALES.includes(locale) ? locale : 'en') || pick('en') || 'Starting FunSync…';
}

/** The splash window's options for this platform. */
function splashWindowOptions(platform, icon) {
  const linux = platform === 'linux';
  return {
    width: SPLASH_SIZE,
    height: SPLASH_SIZE + SPLASH_LINE,
    frame: false,
    transparent: !linux,
    ...(linux ? { backgroundColor: NAVY } : {}),
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    icon,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  };
}

/** What the page is told (renderer/splash.js reads it). */
function splashQuery({ locale, platform }) {
  return { slow: splashSlowText(locale), slowMs: String(SLOW_MS), card: platform === 'linux' ? '1' : '0' };
}

/**
 * Fade the splash out and close it. The main window shows under it first,
 * so the two cross over. Anything going wrong closes it at once.
 */
function fadeOutSplash(splash, { setTimer = setTimeout } = {}) {
  if (!splash || splash.isDestroyed?.()) return;
  const close = () => { try { if (!splash.isDestroyed()) splash.destroy(); } catch { /* gone */ } };
  try {
    Promise.resolve(splash.webContents.executeJavaScript("document.documentElement.classList.add('leaving'); true"))
      .catch(close);
    setTimer(close, FADE_MS + 40);
  } catch {
    close();
  }
}

module.exports = { splashSlowText, splashWindowOptions, splashQuery, fadeOutSplash, SPLASH_SIZE, SPLASH_LINE, SLOW_MS, FADE_MS };
