// The Holiday interface style (Settings > Appearance > Interface style;
// v0.10.1, Dave 2026-11-21: "modern classic holiday", "unobtrusive snow
// animations", "a santa hat on the logo", "gold ring on the logo small red and
// green touches, as it is optional").
//
// - styleAttributes(setting): what <html> carries for each Interface style
//   setting. Holiday is Modern's corners, depth and motion with its own
//   palette on top, so it is data-style="modern" plus data-season="holiday";
//   renderer/styles/holiday.css is scoped to [data-season="holiday"] and does
//   nothing otherwise. Works in Dark and in Light.
// - snowFlakes(count, seed): the falling snow, the same every launch (a seeded
//   list, not Math.random, so a test can pin it).
// - mountSnow(doc): puts the snow layer in the page ONCE. Whether it shows is
//   CSS only (holiday.css): Holiday on, "Falling snow" on (data-snow), no
//   video on screen (the player or the docked mini player), and the OS not
//   asking for reduced motion. The flakes move by CSS transform only.

export const HOLIDAY_STYLE = 'holiday';

/** How many flakes fall at once. Few and small on purpose: unobtrusive. */
export const SNOW_FLAKES = 28;

/**
 * The <html> attributes for an Interface style setting. Pure.
 * @param {unknown} setting 'classic' | 'modern' | 'holiday' (anything else: classic)
 * @returns {{ style: 'classic'|'modern', season: 'holiday'|null }}
 */
export function styleAttributes(setting) {
  if (setting === HOLIDAY_STYLE) return { style: 'modern', season: 'holiday' };
  return { style: setting === 'modern' ? 'modern' : 'classic', season: null };
}

/**
 * The flakes: where each falls, how big, how see-through, how slow, and how
 * far it drifts sideways. Deterministic for a seed. Pure.
 * @param {number} [count]
 * @param {number} [seed]
 * @returns {{ x: string, s: string, o: string, d: string, delay: string, dx: string }[]}
 */
export function snowFlakes(count = SNOW_FLAKES, seed = 11) {
  let state = seed >>> 0 || 1;
  const rnd = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296;
  };
  const out = [];
  for (let i = 0; i < count; i++) {
    const duration = 16 + rnd() * 16;                 // 16-32 s from top to bottom
    out.push({
      x: `${(rnd() * 100).toFixed(2)}%`,
      s: `${(2 + rnd() * 3).toFixed(1)}px`,            // 2-5 px
      o: (0.35 + rnd() * 0.45).toFixed(2),             // 0.35-0.8
      d: `${duration.toFixed(1)}s`,
      delay: `${(-rnd() * duration).toFixed(1)}s`,     // already falling at start
      dx: `${Math.round((rnd() - 0.5) * 80)}px`,       // ±40 px of drift
    });
  }
  return out;
}

/**
 * Put the snow layer in the page, once. Returns the layer.
 * @param {Document} [doc]
 * @returns {HTMLElement|null}
 */
export function mountSnow(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc?.body) return null;
  const existing = doc.querySelector('.holiday-snow');
  if (existing) return existing;
  const layer = doc.createElement('div');
  layer.className = 'holiday-snow';
  layer.setAttribute('aria-hidden', 'true');
  for (const f of snowFlakes()) {
    const flake = doc.createElement('i');
    flake.style.setProperty('--x', f.x);
    flake.style.setProperty('--s', f.s);
    flake.style.setProperty('--o', f.o);
    flake.style.setProperty('--d', f.d);
    flake.style.setProperty('--delay', f.delay);
    flake.style.setProperty('--dx', f.dx);
    layer.appendChild(flake);
  }
  doc.body.appendChild(layer);
  return layer;
}

/**
 * Apply an Interface style setting's season to <html>: data-season set for
 * Holiday (and the snow layer mounted, unless opts.snow is false: the
 * pop-out windows take the palette but no snow), removed otherwise. Side
 * effect only.
 * @param {'holiday'|null} season
 * @param {Document} [doc]
 * @param {{ snow?: boolean }} [opts]
 */
export function applySeason(season, doc = (typeof document !== 'undefined' ? document : null), { snow = true } = {}) {
  const root = doc?.documentElement;
  if (!root) return;
  if (season === 'holiday') {
    root.dataset.season = 'holiday';
    if (snow) mountSnow(doc);
  } else {
    delete root.dataset.season;
  }
}

/**
 * "Falling snow" (player.holidaySnow, default on): data-snow="off" hides it.
 * @param {unknown} setting
 * @param {Document} [doc]
 */
export function applySnowSetting(setting, doc = (typeof document !== 'undefined' ? document : null)) {
  const root = doc?.documentElement;
  if (!root) return;
  root.dataset.snow = setting === false ? 'off' : 'on';
}
