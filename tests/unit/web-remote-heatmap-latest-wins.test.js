/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// verify-2, 2026-11-07 (new since v0.9.2, found by reading): on the phone,
// the first heatmap load (the main script, web-remote/app.js on opening the
// player) and the one E-09's start-of-session `variant-changed` triggers (the
// pinned variant's script) race, and loadHeatmap had no stale-response
// guard. On a slow LAN with a big main script the main heatmap could land
// last while the chip named the pinned variant.
//
// The REAL loadHeatmap is lifted out of the phone's app.js (it is a
// top-level function in a page module that runs on import) and run with a
// fetch whose answers land in the order a test chooses. What is asserted is
// which script's bins end up drawn on the canvas.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const SRC = fs.readFileSync('backend/web-remote/app.js', 'utf8');

/** `async function loadHeatmap(...) { ... }`: from its line to the next top-level `}`. */
function liftTopLevel(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = SRC.indexOf('\n}\n', start);
  return SRC.slice(start, end + 2);
}

function rig() {
  const pending = new Map(); // url -> resolve
  const drawn = [];
  const frames = [];
  const fetch = (url) => new Promise((resolve) => {
    // The actions carry their url, so the drawn bins say which script they are.
    const actions = Object.assign([{ at: 0, pos: 0 }, { at: 1, pos: 1 }], { url });
    pending.set(url, () => resolve({ ok: true, json: async () => ({ actions }) }));
  });
  // eslint-disable-next-line no-new-func
  const loadHeatmap = new Function('fetch', 'computeBins', 'renderBins', 'requestAnimationFrame',
    `${liftTopLevel('loadHeatmap')}\nreturn loadHeatmap;`)(
    fetch,
    (actions) => ({ actions }),
    (canvas, bins) => drawn.push(bins.actions.url),
    (fn) => frames.push(fn),
  );
  const land = async (url) => { pending.get(url)(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  return { loadHeatmap, land, flushFrames, drawn };
}

describe('the phone heatmap shows the script asked for last', () => {
  it('main script asked first, pinned variant second, main lands LAST: the variant is drawn', async () => {
    const r = rig();
    const canvas = {};
    const first = r.loadHeatmap(canvas, '/api/media/script/v1');
    const second = r.loadHeatmap(canvas, '/api/media/script/v1?variant=soft');
    await r.land('/api/media/script/v1?variant=soft');
    await r.land('/api/media/script/v1');
    await Promise.all([first, second]);
    r.flushFrames();
    expect(r.drawn).toEqual(['/api/media/script/v1?variant=soft']);
  });

  it('a newer ask arriving between a fetch and its frame: the old frame draws nothing', async () => {
    const r = rig();
    const canvas = {};
    const first = r.loadHeatmap(canvas, '/a');
    await r.land('/a');
    await first;
    const second = r.loadHeatmap(canvas, '/b'); // before /a's frame ran
    r.flushFrames();
    await r.land('/b');
    await second;
    r.flushFrames();
    expect(r.drawn).toEqual(['/b']);
  });

  it('two canvases do not cancel each other', async () => {
    const r = rig();
    const a = r.loadHeatmap({}, '/x');
    const b = r.loadHeatmap({}, '/y');
    await r.land('/y');
    await r.land('/x');
    await Promise.all([a, b]);
    r.flushFrames();
    expect(r.drawn.sort()).toEqual(['/x', '/y']);
  });
});
