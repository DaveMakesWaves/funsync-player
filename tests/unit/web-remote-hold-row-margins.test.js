/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Phone player (backend/web-remote): the Orgasm + Edge hold row ran edge to
// edge while the "Connected devices" pill above it keeps 16 px side margins
// (verifier-2: in a 396 px viewport the pills spanned x 0-187 and 197-396).
// The row now has the pill's side margins (fixup-2, 2026-11-17).
//
// jsdom lays nothing out, so this resolves the stylesheet itself for a phone
// held upright at 360 and 414 px: the rules outside @media plus the @media
// blocks that apply at that size, in order, and the side margins and padding
// they leave on the player column, the device pill, the row and its buttons.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const CSS = fs.readFileSync('backend/web-remote/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const APP = fs.readFileSync('backend/web-remote/app.js', 'utf8');

/** Top-level rules and those inside @media blocks: [{ selectors, decls, media }]. @keyframes and others are skipped. */
function parse(css) {
  const out = [];
  let i = 0;
  const block = (from) => { // index of the matching '}' for the '{' at `from`
    let d = 0;
    for (let k = from; k < css.length; k++) { if (css[k] === '{') d++; else if (css[k] === '}' && --d === 0) return k; }
    return css.length;
  };
  const rulesIn = (text, media) => {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selectors: m[1].split(',').map((s) => s.trim()), decls: m[2], media });
  };
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    const close = block(open);
    if (head.startsWith('@media')) rulesIn(css.slice(open + 1, close), head.slice(6).trim());
    else if (!head.startsWith('@')) rulesIn(css.slice(i, close + 1), null);
    i = close + 1;
  }
  return out;
}
const RULES = parse(CSS);

/** Does a media query apply to a phone held upright, `width` px wide (780 px tall, touch, motion allowed)? */
function applies(media, width) {
  if (!media) return true;
  const env = { width, height: 780 };
  return media.split(',').some((q) => q.split(/\band\b/).every((part) => {
    const f = /\(\s*([a-z-]+)\s*:\s*([^)]+)\)/.exec(part.trim());
    if (!f) return part.trim() === 'screen' || part.trim() === 'all';
    const [, name, raw] = f, v = raw.trim(), n = parseFloat(v);
    switch (name) {
      case 'min-width': return env.width >= n;
      case 'max-width': return env.width <= n;
      case 'min-height': return env.height >= n;
      case 'max-height': return env.height <= n;
      case 'orientation': return v === (env.height >= env.width ? 'portrait' : 'landscape');
      case 'hover': return v === 'none';
      case 'pointer': return v === 'coarse';
      default: return false; // prefers-reduced-motion, prefers-color-scheme...: not the case looked at here
    }
  }));
}

const px = (v) => (v === 'auto' ? 'auto' : parseFloat(v) || 0);
/** The left / right of `prop` (margin or padding) for an element matching `selector` at `width`, rules in source order. */
function sides(selector, prop, width) {
  let left = 0, right = 0;
  for (const r of RULES) {
    if (!r.selectors.includes(selector) || !applies(r.media, width)) continue;
    for (const d of r.decls.split(';')) {
      const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*(!important)?\s*$/.exec(d);
      if (!m) continue;
      const [, name, value] = m;
      if (name === prop) {
        const p = value.split(/\s+/);
        const [, r1 = p[0], , l1 = r1] = p;
        right = px(r1); left = px(l1);
      } else if (name === `${prop}-left`) left = px(value);
      else if (name === `${prop}-right`) right = px(value);
      else if (name === `${prop}-inline`) { const p = value.split(/\s+/); left = px(p[0]); right = px(p[1] ?? p[0]); }
    }
  }
  return { left, right };
}

/** Where a block-level child of the player column starts and ends at `width` (its side margins, the column's padding). */
function span(selector, width) {
  const col = sides('.player', 'padding', width);
  const m = sides(selector, 'margin', width);
  return { x0: col.left + m.left, x1: width - col.right - m.right };
}

describe('phone player: the Orgasm + Edge row has the device pill\'s side margins', () => {
  it('the row and the pill are children of the player column, in that order', () => {
    expect(APP).toMatch(/pill\.className = 'player__sync-pill';[\s\S]*?wrap\.appendChild\(pill\)/);
    expect(APP).toMatch(/holdRow\.className = 'player__hold-row';[\s\S]*?holdRow\.appendChild\(orgasmBtn\);[\s\S]*?wrap\.appendChild\(holdRow\)/);
  });

  for (const width of [360, 414]) {
    it(`at ${width} px the row spans the same x as the "Connected devices" pill (16 px each side)`, () => {
      const pill = span('.player__sync-pill', width);
      const row = span('.player__hold-row', width);
      expect(pill).toEqual({ x0: 16, x1: width - 16 });
      expect(row).toEqual(pill);
      // the pills in the row add no side margin of their own
      for (const sel of ['.player__orgasm-btn', '.player__edge-btn', '.player__hold-row > button']) {
        const m = sides(sel, 'margin', width);
        expect(m, sel).toEqual({ left: 0, right: 0 });
      }
    });
  }
});
