/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The live preview's budget (DESIGN-pattern-library.md §f): the drawer redraws its ghost on every slider move, so
// one fillRange on a 30 s selection must stay under ~16 ms (p95 over all patterns). The design names four patterns
// whose engine render alone is slower on long windows; they are allowed 50 ms. Each pattern is timed as the median of
// repeated runs after a warm-up, so one slow tick does not fail it. The engine's own render of the same window is
// timed alongside: the fill core adds little to it (one render in the common case, a little arithmetic around it).
import { describe, it, expect, beforeAll } from 'vitest';
import { fillRange } from '../../renderer/js/pattern-fill.js';
import { listPatterns, renderPattern } from '../../renderer/js/pattern-library.js';

/** The design's named slow patterns (buzz over frantic base strokes, tiny base strokes and short tip strokes; flutters at both ends). */
const SLOW = ['buzz-frantic-base-strokes', 'buzz-tiny-base-strokes', 'buzz-short-tip-strokes', 'fast-strokes-flutter-both-ends'];
const BUDGET_MS = 16;
/** The share of the reference workload (see the p95 test) the p95 may take on a loaded machine. */
const LOAD_SHARE = 0.15;
const SLOW_BUDGET_MS = 50;
const REPEATS = 5;

// A 30 s selection between stroke neighbours, replace mode, stretch end fit: the drawer's default and heaviest path.
const ACTIONS = [{ at: 0, pos: 20 }, { at: 400, pos: 80 }, { at: 1000, pos: 30 }, { at: 1500, pos: 75 }, { at: 16000, pos: 40 }, { at: 31000, pos: 70 }, { at: 31400, pos: 10 }];
const SELECTION = { startMs: 1000, endMs: 31000 };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const timeIt = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

const ROWS = [];
beforeAll(() => {
  // the catalogue (the simple shapes are a few cheap points each: pattern-library-shapes.test.js)
  const ids = listPatterns().filter((p) => p.family !== 'simple-shapes').map((p) => p.id);
  const fill = (id) => fillRange({ actions: ACTIONS, selection: SELECTION, patternId: id, options: { seed: 3 } });
  const raw = (id) => renderPattern(id, { durationMs: 30000, from: 1000, startPos: 30, startDir: 1, seed: 3 });
  for (const id of ids) { fill(id); fill(id); raw(id); } // warm up
  for (const id of ids) {
    const f = [], r = [];
    for (let k = 0; k < REPEATS; k++) { f.push(timeIt(() => fill(id))); r.push(timeIt(() => raw(id))); }
    ROWS.push({ id, fill: median(f), raw: median(r) });
  }
}, 120000);

describe('pattern-fill: live preview performance (30 s selection)', () => {
  it('names patterns that exist', () => {
    const ids = new Set(ROWS.map((r) => r.id));
    expect(ROWS.length).toBe(78);
    for (const id of SLOW) expect(ids.has(id), id).toBe(true);
  });

  // Load-tolerant (fix-up 2026-11-17), like the engine's own budget test: the design's 16 ms holds on a quiet machine,
  // and the bound grows with a reference workload measured in the same rounds (the engine's own render of every
  // ordinary pattern, summed), so a loaded machine slows both alike. Measured warm on node: p95 4.5-4.8 ms against a
  // reference of 104-111 ms (0.043 of it). The bound is 0.15 of it, so the fill alone would have to get about 3.5x
  // slower to fail; the ratio test below catches a smaller slowdown of the fill core.
  it(`p95 over all other patterns stays under ${BUDGET_MS} ms, or ${LOAD_SHARE} of the reference on a loaded machine`, () => {
    const ordinary = ROWS.filter((r) => !SLOW.includes(r.id));
    const t = ordinary.map((r) => r.fill).sort((a, b) => a - b);
    const p95 = t[Math.min(t.length - 1, Math.floor(t.length * 0.95))];
    const reference = ordinary.reduce((sum, r) => sum + r.raw, 0);
    expect(p95, `p95 ${p95.toFixed(1)} ms, reference ${reference.toFixed(1)} ms`).toBeLessThan(Math.max(BUDGET_MS, LOAD_SHARE * reference));
  });

  it(`the four named slow patterns stay within their ${SLOW_BUDGET_MS} ms allowance (or within 25% of the engine's own render when that alone is slower on this machine)`, () => {
    for (const id of SLOW) {
      const r = ROWS.find((x) => x.id === id);
      expect(r.fill, `${id}: fill ${r.fill.toFixed(1)} ms, engine ${r.raw.toFixed(1)} ms`).toBeLessThanOrEqual(Math.max(SLOW_BUDGET_MS, 1.25 * r.raw + 2));
    }
  });

  it('the fill core adds little to the engine render: median over patterns within 1.3x + 1 ms', () => {
    const ratio = median(ROWS.map((r) => r.fill / (r.raw + 1)));
    expect(ratio).toBeLessThan(1.3);
  });
});
