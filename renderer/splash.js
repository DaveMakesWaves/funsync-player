// The start-up splash (Dave, 2026-11-25: "can we just make it a high res
// version of the funsync logo but the heatmap segment is animated like a
// playing video instead of the loading spinner"; mockup E chosen: "scrolling
// timeline with lift"). The round logo is an SVG in splash.html, so it is
// sharp at any display scaling; its 31 bars scroll left past a fixed
// playhead like the script timeline during playback, lit once played, each
// one lifting for a moment as it crosses the playhead.
//
// `frame()` is the pure part (tests/unit/splash.test.js); the drawing below
// runs only in a page.

/** The app icon's own bars (assets/icons/icon.png at 256 px): half-heights in px around y 194.5. */
export const HALVES = Object.freeze([8.5, 9, 8, 6.5, 10, 11, 13, 15, 15.5, 15.5, 15.5, 13.5, 13.5, 8.5, 12, 6.5, 3.5, 3.5, 10.5, 9, 6.5, 4, 10.5, 12, 8, 10.5, 10.5, 10.5, 6, 2.5, 1.5]);
export const X0 = 42;
export const X1 = 214;
export const MID = 194.5;
export const MAX_HALF = 15.5;
export const PLAYHEAD_X = 128;
/** px per ms the bars travel. */
export const SPEED = 0.028;
/** How far either side of the playhead a bar lifts (px), and by how much at most. */
export const LIFT_REACH = 12;
export const LIFT = 0.65;
export const PLAYED_OPACITY = 1;
export const UPCOMING_OPACITY = 0.32;

const STEP = (X1 - X0) / HALVES.length;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * Every bar at time `tMs`: the strip is drawn twice so it wraps without a gap.
 * @returns {{x: number, half: number, opacity: number}[]}
 */
export function frame(tMs) {
  const total = HALVES.length * STEP;
  const off = ((tMs * SPEED) % total + total) % total;
  const out = [];
  for (let i = 0; i < HALVES.length * 2; i++) {
    const h = HALVES[i % HALVES.length] / MAX_HALF;
    const x = X0 + STEP * (i + 0.5) - off;
    const near = 1 - smooth(0, LIFT_REACH, Math.abs(x - PLAYHEAD_X));
    const half = Math.max(1.2, Math.min(1.15, h * (1 + LIFT * near)) * MAX_HALF);
    out.push({ x, half, opacity: x <= PLAYHEAD_X ? PLAYED_OPACITY : UPCOMING_OPACITY });
  }
  return out;
}

/**
 * What main hands the page in its URL (electron/splash-window.js
 * `splashQuery`): the slow-start line, when to show it, and the Linux card.
 */
export function readSplashQuery(search) {
  const q = new URLSearchParams(search || '');
  const slowMs = Number(q.get('slowMs'));
  return {
    slow: (q.get('slow') || '').slice(0, 80),
    slowMs: Number.isFinite(slowMs) && slowMs > 0 ? slowMs : 4000,
    card: q.get('card') === '1',
  };
}

function start() {
  const g = document.querySelector('.bars');
  if (!g) return;
  const opts = readSplashQuery(location.search);
  if (opts.card) document.documentElement.classList.add('card');
  // A start that takes a while says so (Dave, 2026-11-25): only after slowMs,
  // so a quick start never shows it.
  const slow = document.querySelector('.slow');
  if (slow && opts.slow) {
    setTimeout(() => { slow.textContent = opts.slow; slow.classList.add('shown'); }, opts.slowMs);
  }
  const NS = 'http://www.w3.org/2000/svg';
  const width = 2.6;
  const rects = frame(0).map(() => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('width', String(width));
    r.setAttribute('rx', String(width / 2));
    g.appendChild(r);
    return r;
  });
  const draw = (t) => {
    frame(t).forEach((b, i) => {
      const r = rects[i];
      r.setAttribute('x', (b.x - width / 2).toFixed(2));
      r.setAttribute('y', (MID - b.half).toFixed(2));
      r.setAttribute('height', (b.half * 2).toFixed(2));
      r.setAttribute('opacity', String(b.opacity));
    });
  };
  // Reduced motion: one still frame, mid-play.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { draw(1700); return; }
  const loop = (t) => { draw(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

if (typeof document !== 'undefined') start();
