/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Property sweep of the fill core (pattern-fill.js) with the real library engine: every pattern x speeds {low, own,
// high} x reversed x both end fits x both modes, each between seeded random neighbours (positions 0-100, legs
// 60-1500 ms, some flats; some selections are time ranges that do not start or end on a point, some scripts are
// empty). The design's invariants (DESIGN-pattern-library.md §f):
//   I1 the fill lies inside the selection, the result is sorted with unique whole ms and whole positions 0-100
//   I2 replace never touches a point outside the selection (and keeps A and B); gap mode never changes a point
//   I3 every leg the fill makes is at least 100 ms (50 ms only between two buzz points of the pattern)
//   I4 every such leg is at most the cap (+0.5 for rounding)
//   I5 the start carries on the way A is heading (unless A is at the band edge it heads for), or is flat within 3
//   I6 a stretch end arrives the way B wants (when the pattern has points on that side of B)
//   I7 the same seed gives the same fill, another seed (almost always) another
//   I8 reversed between mirrored neighbours is the exact mirror of the plain fill
// plus: the input array is never changed.
import { describe, it, expect, beforeAll } from 'vitest';
import { fillRange } from '../../renderer/js/pattern-fill.js';
import { listPatterns, describePattern } from '../../renderer/js/pattern-library.js';

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
// The catalogue only: the simple shapes (shape-*, 2026-11-19) are drawn as generatePattern draws them, without the
// engine's start, heading and leg rules; pattern-library-shapes.test.js holds their fills to the hard limits.
const IDS = listPatterns().filter((p) => p.family !== 'simple-shapes').map((p) => p.id);

/** Random neighbours and a selection. kind: 'points' (the selection runs from point i0 to point i1), 'range' (a time range), 'empty'. */
function scenario(rng, mode, kind) {
  if (kind === 'empty') return { acts: [], sel: { startMs: 500, endMs: 500 + 2000 + Math.floor(rng() * 9000) }, i0: -1, i1: -1 };
  const acts = [];
  let t = Math.floor(rng() * 400);
  const n = 8 + Math.floor(rng() * 10);
  for (let i = 0; i < n; i++) {
    acts.push({ at: t, pos: i && rng() < 0.15 ? acts[i - 1].pos : Math.floor(rng() * 101) });
    t += 60 + Math.floor(rng() * 1441);
  }
  const i0 = 1 + Math.floor(rng() * (n - 4)), i1 = Math.min(n - 2, i0 + 1 + Math.floor(rng() * 4));
  if (mode === 'gap') { const gap = 1500 + Math.floor(rng() * 6000); for (let k = i0 + 1; k < n; k++) acts[k].at += gap; }
  if (kind === 'range') {
    const a = acts[i0].at + 1 + Math.floor(rng() * 50), b = acts[i1].at + 1 + Math.floor(rng() * 50);
    return { acts, sel: { startMs: a, endMs: Math.max(a + 1, b) }, i0: -1, i1: -1 };
  }
  return { acts, sel: { startMs: acts[i0].at, endMs: acts[i1].at }, i0, i1 };
}

const CASES = [];
beforeAll(() => {
  let k = 0;
  for (const id of IDS) {
    const d = describePattern(id);
    for (const speed of [d.speedRange[0], null, d.speedRange[1]]) {
      for (const reversed of [false, true]) {
        for (const endFit of ['stretch', 'partial']) {
          for (const mode of ['replace', 'gap']) {
            const rng = mulberry32(0x5eed + k++);
            const kind = k % 11 === 0 ? 'empty' : k % 5 === 0 ? 'range' : 'points';
            const sc = scenario(rng, mode, kind);
            const options = { speed, reversed, endFit, mode, seed: 1 + (k % 7), joinSmoothness: [0.5, 0, 1, 0.3][Math.floor(rng() * 4)] };
            const input = sc.acts.map((a) => ({ ...a }));
            const snapshot = JSON.stringify(input);
            const res = fillRange({ actions: input, selection: sc.sel, patternId: id, options });
            CASES.push({ id, d, options, kind, ...sc, input, snapshot, res });
          }
        }
      }
    }
  }
});

describe('pattern-fill properties (every pattern x speeds x reversed x end fit x mode, random neighbours)', () => {
  it('covers every pattern, and fills most cases', () => {
    expect(CASES.length).toBe(IDS.length * 3 * 2 * 2 * 2);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(78);
    expect(CASES.filter((c) => c.res.inserted.length > 0).length).toBeGreaterThan(CASES.length * 0.8);
  });

  it('never changes the input array', () => {
    for (const c of CASES) expect(JSON.stringify(c.input), c.id).toBe(c.snapshot);
  });

  // Fix-up 2026-11-17 (review-1): the partial end fit could pop every rendered point, and the selected points were
  // then removed with nothing in their place and no word. Absence is never destructive.
  it('I9: a fill that removes points always inserts points of the pattern; one that inserts none changes nothing', () => {
    const bad = [];
    for (const c of CASES) {
      if (c.res.removed.length && !c.res.inserted.length) bad.push(`${c.id}: removed ${c.res.removed.length}, inserted 0`);
      if (c.res.removedCount !== c.res.removed.length) bad.push(`${c.id}: removedCount ${c.res.removedCount} vs ${c.res.removed.length}`);
      if (!c.res.inserted.length && JSON.stringify(c.res.actions) !== JSON.stringify(c.acts)) bad.push(`${c.id}: nothing inserted but the script changed`);
      if (!c.res.inserted.length && !c.res.warnings.length) bad.push(`${c.id}: nothing inserted and no warning`);
    }
    expect(bad).toEqual([]);
  });

  // Each check collects what breaks it and asserts once: the sweep makes over 100,000 point checks.
  it('I1: sorted, unique whole ms, whole positions 0-100; every inserted point inside the selection', () => {
    const bad = [];
    for (const c of CASES) {
      const out = c.res.actions;
      for (let i = 1; i < out.length; i++) if (!(out[i].at > out[i - 1].at)) bad.push(`${c.id}: ${out[i - 1].at} then ${out[i].at}`);
      for (const a of out) if (!Number.isInteger(a.at) || !Number.isInteger(a.pos) || a.pos < 0 || a.pos > 100) bad.push(`${c.id}: ${JSON.stringify(a)}`);
      const strict = c.kind === 'points';
      for (const p of c.res.inserted) {
        const inside = strict ? p.at > c.sel.startMs && p.at < c.sel.endMs : p.at >= c.sel.startMs && p.at <= c.sel.endMs;
        if (!inside) bad.push(`${c.id}: inserted ${p.at} outside ${c.sel.startMs}-${c.sel.endMs}`);
      }
      if (out.length !== c.acts.length - c.res.removedCount + c.res.inserted.length) bad.push(`${c.id}: count`);
    }
    expect(bad).toEqual([]);
  });

  it('I2: replace never touches a point outside the selection and keeps A and B; gap mode never changes a point', () => {
    const key = (a) => `${a.at}:${a.pos}`;
    const bad = [];
    for (const c of CASES) {
      const out = new Set(c.res.actions.map(key));
      for (const a of c.acts) {
        const outside = a.at < c.sel.startMs || a.at > c.sel.endMs;
        if ((outside || c.options.mode === 'gap') && !out.has(key(a))) bad.push(`${c.id} (${c.options.mode}): lost ${key(a)}`);
      }
      if (c.options.mode === 'replace' && c.i0 >= 0) {
        for (const i of [c.i0, c.i1]) if (!out.has(key(c.acts[i]))) bad.push(`${c.id}: anchor ${key(c.acts[i])} lost`);
      }
      if (c.options.mode === 'gap' && c.res.removedCount !== 0) bad.push(`${c.id}: gap mode removed ${c.res.removedCount}`);
    }
    expect(bad).toEqual([]);
  });

  it('I3 / I4: every leg the fill makes keeps its minimum (100 ms; 50 ms between buzz points) and the cap', () => {
    const bad = [];
    let legs = 0;
    for (const c of CASES) {
      if (c.res.warnings.some((w) => w.code === 'join-too-fast')) continue; // checked by its own test
      const ins = new Set(c.res.inserted.map((p) => p.at));
      const win = c.res.actions.filter((a) => a.at >= c.sel.startMs && a.at <= c.sel.endMs);
      const cap = c.res.stats.cap;
      for (let i = 1; i < win.length; i++) {
        const a = win[i - 1], b = win[i];
        if (!ins.has(a.at) && !ins.has(b.at)) continue; // the script's own leg
        const dt = b.at - a.at, v = (Math.abs(b.pos - a.pos) / dt) * 1000;
        const between = ins.has(a.at) && ins.has(b.at);
        const min = between && c.d.hasBuzz ? 50 : 100;
        legs++;
        if (dt < min) bad.push(`${c.id}: leg ${a.at}->${b.at} is ${dt} ms (min ${min})`);
        if (v > cap + 0.5) bad.push(`${c.id}: leg ${a.at}->${b.at} at ${v.toFixed(1)} u/s (cap ${cap})`);
      }
    }
    expect(bad).toEqual([]);
    expect(legs).toBeGreaterThan(20000);
  });

  it('I5: the first leg carries on the way A is heading (A not at the band edge it heads for), or is flat within 3', () => {
    let checked = 0;
    for (const c of CASES) {
      if (c.kind !== 'points' || c.options.mode !== 'replace' || !c.res.inserted.length) continue;
      const A = c.acts[c.i0], next = c.acts[c.i0 + 1], prev = c.acts[c.i0 - 1];
      const out = next.pos - A.pos, into = A.pos - prev.pos;
      const h = Math.abs(out) >= 1 ? sgn(out) : Math.abs(into) >= 1 ? sgn(into) : 0;
      if (!h) continue;
      // the pattern's band, read from the middle half of the fill (away from the move in and the blends)
      const W = c.sel.endMs - c.sel.startMs;
      const ps = c.res.inserted.filter((p) => p.at > c.sel.startMs + W / 4 && p.at < c.sel.endMs - W / 4).map((p) => p.pos);
      if (ps.length < 3) continue;
      const lo = Math.min(...ps), hi = Math.max(...ps);
      if (h > 0 ? A.pos >= hi - 10 : A.pos <= lo + 10) continue;
      const d = c.res.inserted[0].pos - A.pos;
      expect(sgn(d) === h || Math.abs(d) <= 3, `${c.id} A=${A.pos} h=${h} first=${c.res.inserted[0].pos}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('I6: a stretch end arrives the way B wants, with tempo 0.87-1.15', () => {
    let checked = 0;
    for (const c of CASES) {
      if (c.kind !== 'points' || c.options.mode !== 'replace' || c.options.endFit !== 'stretch' || !(c.options.joinSmoothness > 0)) continue;
      const s = c.res.stretches[0];
      if (!s || s.endFit !== 'stretch') continue;
      expect(s.tempo >= 0.87 && s.tempo <= 1.15, c.id).toBe(true);
      const B = c.acts[c.i1], before = c.acts[c.i1 - 1], after = c.acts[c.i1 + 1];
      const into = B.pos - before.pos, out = after.pos - B.pos;
      const ad = Math.abs(into) >= 1 ? sgn(into) : Math.abs(out) >= 1 ? -sgn(out) : 0;
      if (!ad || (ad > 0 && B.pos <= 0) || (ad < 0 && B.pos >= 100)) continue;
      if (!c.res.inserted.some((p) => sgn(B.pos - p.pos) === ad)) continue; // B lies outside the pattern's band
      const last = c.res.inserted[c.res.inserted.length - 1];
      const d = B.pos - last.pos;
      expect(sgn(d) === ad || d === 0, `${c.id} B=${B.pos} ad=${ad} last=${last.pos}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('I7: the same inputs and seed give the same fill; another seed almost always another one', () => {
    let differ = 0, total = 0;
    for (let i = 0; i < CASES.length; i += 11) {
      const c = CASES[i];
      if (!c.res.inserted.length) continue;
      const again = fillRange({ actions: c.acts, selection: c.sel, patternId: c.id, options: c.options });
      expect(again, c.id).toEqual(c.res);
      const other = fillRange({ actions: c.acts, selection: c.sel, patternId: c.id, options: { ...c.options, seed: c.options.seed + 1000 } });
      total++;
      if (JSON.stringify(other.inserted) !== JSON.stringify(c.res.inserted)) differ++;
    }
    expect(total).toBeGreaterThan(120);
    expect(differ / total).toBeGreaterThan(0.9);
  });

  it('I8: reversed between mirrored neighbours is the exact mirror of the plain fill', () => {
    let checked = 0;
    for (let i = 0; i < CASES.length; i += 7) {
      const c = CASES[i];
      const mirrored = c.acts.map((a) => ({ at: a.at, pos: 100 - a.pos }));
      const m = fillRange({ actions: mirrored, selection: c.sel, patternId: c.id, options: { ...c.options, reversed: !c.options.reversed } });
      expect(m.actions.map((a) => ({ at: a.at, pos: 100 - a.pos })), c.id).toEqual(c.res.actions);
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
  });
});

// Fix-up 2026-11-17 (review-1 nit): the sweep above never used anchors 'outside', a ramp, a range, maxSpeed or a
// variation other than 1. A second, smaller sweep with those, for the invariants that hold whatever the options:
// I1 (sorted, whole, 0-100, inside the selection), I3 / I4 (the minimum leg and the cap), I9 (nothing removed
// without a pattern point put in; nothing put in = nothing changed), and no point outside the selection lost.
describe('pattern-fill properties with the other options (anchors outside, ramp, range, maxSpeed, variation)', () => {
  const WIDE = [];
  beforeAll(() => {
    let k = 0;
    for (const id of IDS) {
      const d = describePattern(id);
      for (let r = 0; r < 6; r++) {
        const rng = mulberry32(0xabc + k++);
        const { acts, sel } = scenario(rng, 'replace', 'points');
        const lo = Math.floor(rng() * 60);
        const options = {
          anchors: r % 2 ? 'outside' : 'keep',
          endFit: r % 3 ? 'stretch' : 'partial',
          ramp: r % 3 === 1 ? { to: d.speedRange[1] } : null,
          range: r % 4 === 2 ? { min: lo, max: Math.min(100, lo + 10 + Math.floor(rng() * (90 - lo))) } : null,
          maxSpeed: r % 5 === 3 ? 250 : undefined,
          variation: [0, 0.5, 1, 2][r % 4],
          seed: r,
        };
        WIDE.push({ id, options, acts, sel, res: fillRange({ actions: acts, selection: sel, patternId: id, options }) });
      }
    }
  });

  it('holds I1, I3 / I4, I9 and keeps every point outside the selection', () => {
    const bad = [];
    const key = (a) => `${a.at}:${a.pos}`;
    for (const c of WIDE) {
      const out = c.res.actions;
      const tag = `${c.id} ${JSON.stringify(c.options)}`;
      for (let i = 1; i < out.length; i++) if (!(out[i].at > out[i - 1].at)) bad.push(`${tag}: order`);
      for (const a of out) if (!Number.isInteger(a.at) || !Number.isInteger(a.pos) || a.pos < 0 || a.pos > 100) bad.push(`${tag}: ${key(a)}`);
      for (const p of c.res.inserted) if (p.at < c.sel.startMs || p.at > c.sel.endMs) bad.push(`${tag}: inserted ${p.at} outside`);
      if (c.res.removed.length && !c.res.inserted.length) bad.push(`${tag}: removed without inserting`);
      if (!c.res.inserted.length && JSON.stringify(out) !== JSON.stringify(c.acts)) bad.push(`${tag}: nothing inserted but changed`);
      const have = new Set(out.map(key));
      for (const a of c.acts) if ((a.at < c.sel.startMs || a.at > c.sel.endMs) && !have.has(key(a))) bad.push(`${tag}: lost ${key(a)}`);
      if (c.res.warnings.some((w) => w.code === 'join-too-fast')) continue;
      const ins = new Set(c.res.inserted.map((p) => p.at));
      const chain = out.filter((a) => a.at >= c.sel.startMs && a.at <= c.sel.endMs);
      for (let i = 1; i < chain.length; i++) {
        if (!ins.has(chain[i].at) && !ins.has(chain[i - 1].at)) continue;
        const dt = chain[i].at - chain[i - 1].at;
        if (dt < 50) bad.push(`${tag}: a ${dt} ms leg`);
        if ((Math.abs(chain[i].pos - chain[i - 1].pos) / dt) * 1000 > c.res.stats.cap + 0.5) bad.push(`${tag}: over the cap`);
      }
    }
    expect(WIDE.length).toBe(IDS.length * 6);
    expect(WIDE.filter((c) => c.res.inserted.length).length).toBeGreaterThan(WIDE.length * 0.8);
    expect(bad).toEqual([]);
  });
});
