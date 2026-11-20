/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Fill with pattern on a time range that keeps points inside it (fixup-2, 2026-11-17; verifier-2 problem 1: a range
// fill that kept a point at 4.0 s ended the part before it at 3.13 s and glided 869 ms into the point). Each stretch
// between the kept points and the range's edges is fitted like an anchored stretch, and no leg is far longer than the
// pattern's own longest leg at that speed (pattern-fill.js: quickerEntry, the landing floor in pickStretch, the
// partial landing that follows a long leg of the pattern):
//   - property: every pattern x {own speed, 600} x 1-3 kept inner points between seeded random neighbours. One kept
//     point: the drawer's range call (the band's edges, replace and gap mode); two or three: gap mode, the core's way
//     of keeping every point (the drawer marks a range only with at most one point in it). Inside each filled stretch
//     longer than the bound, no gap over max(2 x 1.15 x the pattern's own longest leg, 500 ms) (1.15 = the stretch
//     fit's slowest tempo; a hold between two of the pattern's own points is its pause and is not counted); no leg
//     over 600 u/s or under its minimum; every kept point stays.
//   - the move in out of a kept point far from the pattern's band (real engine);
//   - the landing after a hold of the pattern (fake engine 'hold-top'), stretch and partial;
//   - the reported case.
import { describe, it, expect, beforeAll } from 'vitest';
import { fillRange } from '../../renderer/js/pattern-fill.js';
import { listPatterns, renderPattern, describePattern } from '../../renderer/js/pattern-library.js';
import { fakeRender, fakeDescribe } from './helpers/fake-pattern-engine.js';

const CEILING = 600;
const LONG_MS = 500; // the floor of the bound (pattern-fill.js FILL_LONG_LEG_MS)
const SLOWEST_TEMPO = 1.15; // the stretch fit's slowest tempo (FILL_TEMPO_MAX)
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// The catalogue only: the simple shapes (shape-*, 2026-11-19) are drawn as generatePattern draws them, without the
// engine's start, heading and leg rules; pattern-library-shapes.test.js holds their fills to the hard limits.
const IDS = listPatterns().filter((p) => p.family !== 'simple-shapes').map((p) => p.id);

/** The pattern's own longest leg at a speed: plain 8 s renders (2 seeds; free, from 5 up, 50 up and 95 down), the move in left out. */
function ownLongestLeg(id, speed) {
  let m = 0;
  for (const seed of [1, 2]) {
    for (const start of [null, [5, 1], [50, 1], [95, -1]]) {
      const r = renderPattern(id, { durationMs: 8000, from: 0, maxSpeed: CEILING, seed, ...(speed ? { speed } : {}), ...(start ? { startPos: start[0], startDir: start[1] } : {}) });
      for (let i = 2; i < r.actions.length; i++) m = Math.max(m, r.actions[i].at - r.actions[i - 1].at);
    }
  }
  return m;
}

/** Points before and after a range of 2.5-7.5 s, and k kept points inside it (half of them near an end stop, where the move in to a pattern's band is longest). */
function scenario(rng, k) {
  const t0 = 2000 + Math.floor(rng() * 500), len = 2500 + Math.floor(rng() * 5000), t1 = t0 + len;
  const acts = [];
  for (let t = 0; t < t0 - 100; t += 200 + Math.floor(rng() * 300)) acts.push({ at: t, pos: Math.floor(rng() * 101) });
  const kept = [];
  for (let j = 0; j < k; j++) {
    const pos = rng() < 0.5 ? Math.floor(rng() * 101) : rng() < 0.5 ? Math.floor(rng() * 6) : 95 + Math.floor(rng() * 6);
    kept.push({ at: t0 + Math.round((len * (j + 1)) / (k + 1) + (rng() - 0.5) * 200), pos });
  }
  acts.push(...kept);
  for (let t = t1 + 100 + Math.floor(rng() * 300); t < t1 + 3000; t += 200 + Math.floor(rng() * 300)) acts.push({ at: t, pos: Math.floor(rng() * 101) });
  return { acts, kept, sel: { startMs: t0, endMs: t1 } };
}

const CASES = [];
beforeAll(() => {
  let n = 0;
  for (const id of IDS) {
    const d = describePattern(id);
    for (const speed of [null, CEILING]) {
      const own = ownLongestLeg(id, speed);
      const bound = Math.max(2 * SLOWEST_TEMPO * own, LONG_MS);
      for (let c = 0; c < 12; c++) {
        const rng = mulberry32(0xf111 + n++);
        const k = 1 + (c % 3);
        const mode = k === 1 && c % 2 === 0 ? 'replace' : 'gap';
        const sc = scenario(rng, k);
        const res = fillRange({ actions: sc.acts, selection: sc.sel, patternId: id, options: { speed, maxSpeed: CEILING, seed: 1 + c, mode, endFit: 'stretch' } });
        CASES.push({ id, d, speed, own, bound, k, mode, ...sc, res });
      }
    }
  }
}, 120000);

describe('pattern-fill: a range that keeps points (every pattern, own speed and 600, 1-3 kept points)', () => {
  it('covers every pattern and fills most stretches', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(78);
    expect(CASES.filter((c) => c.res.stretches.length > 0).length).toBeGreaterThan(CASES.length * 0.6);
  });

  it('keeps every kept point as it was', () => {
    for (const c of CASES) {
      for (const p of c.kept) expect(c.res.actions.some((a) => a.at === p.at && a.pos === p.pos), `${c.id} ${p.at}:${p.pos}`).toBe(true);
    }
  });

  it('no gap in a filled stretch is far longer than the pattern\'s own longest leg at that speed', () => {
    const bad = [];
    let checked = 0;
    for (const c of CASES) {
      for (const s of c.res.stretches) {
        if (s.endMs - s.startMs <= c.bound) continue; // the stretch itself is shorter
        const pts = c.res.actions.filter((a) => a.at >= s.startMs && a.at <= s.endMs);
        const ins = new Set(c.res.inserted.map((p) => p.at));
        for (let i = 1; i < pts.length; i++) {
          const g = pts[i].at - pts[i - 1].at;
          // a hold between two of the pattern's own points is its pause, not a glide (a few patterns hold for 1-2 s)
          if (ins.has(pts[i].at) && ins.has(pts[i - 1].at) && Math.abs(pts[i].pos - pts[i - 1].pos) <= 1) continue;
          checked++;
          if (g > c.bound) bad.push(`${c.id} @${c.speed || 'own'} k=${c.k} ${c.mode}: ${pts[i - 1].at}:${pts[i - 1].pos} -> ${pts[i].at}:${pts[i].pos} is ${g} ms (bound ${Math.round(c.bound)}, own longest ${c.own})`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(20000);
  });

  it('no leg it makes is over 600 u/s or under its minimum (100 ms; 50 ms between two inserted points of a buzz pattern)', () => {
    const bad = [];
    for (const c of CASES) {
      const ins = new Set(c.res.inserted.map((p) => p.at));
      const win = c.res.actions.filter((a) => a.at >= c.sel.startMs && a.at <= c.sel.endMs);
      for (let i = 1; i < win.length; i++) {
        const a = win[i - 1], b = win[i];
        if (!ins.has(a.at) && !ins.has(b.at)) continue;
        const dt = b.at - a.at, v = (Math.abs(b.pos - a.pos) / dt) * 1000;
        const min = ins.has(a.at) && ins.has(b.at) && c.d.hasBuzz ? 50 : 100;
        if (dt < min) bad.push(`${c.id}: ${a.at} -> ${b.at} is ${dt} ms`);
        if (v > CEILING + 0.5) bad.push(`${c.id}: ${a.at} -> ${b.at} at ${v.toFixed(1)} u/s`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('pattern-fill: the legs out of and into a kept point', () => {
  it('the move in out of a kept point far from the pattern\'s band is not a slow glide (the rest of the fill moves earlier)', () => {
    for (const [id, top] of [['steady-buzz-base', 96], ['buzz-long-strokes', 96], ['steady-buzz-tip-high', 2]]) {
      const actions = [{ at: 0, pos: 50 }, { at: 1000, pos: 50 }, { at: 4000, pos: top }, { at: 8000, pos: 50 }, { at: 9000, pos: 50 }];
      const res = fillRange({ actions, selection: { startMs: 2000, endMs: 7000 }, patternId: id, options: { maxSpeed: CEILING } });
      const after = res.actions.filter((a) => a.at >= 4000 && a.at <= 7000);
      expect(after[0], id).toEqual({ at: 4000, pos: top });
      const leg = after[1].at - after[0].at;
      // before: 573, 918 and 566 ms (the engine's ease into its band at 150 u/s or less)
      expect(leg, id).toBeLessThanOrEqual(LONG_MS);
      expect((Math.abs(after[1].pos - top) / leg) * 1000, id).toBeLessThanOrEqual(CEILING + 0.5);
      expect(res.actions.filter((a) => a.at > 4000 && a.at <= 7000).length, id).toBeGreaterThan(10);
    }
  });

  it('a landing after a hold of the pattern holds, then lands (stretch and partial; no glide from the top onto the point)', () => {
    const deps = { render: fakeRender, describe: fakeDescribe };
    for (const endFit of ['stretch', 'partial']) {
      // 3650: the hold's end lies 52 ms before the point (too close for a leg): it moves earlier instead of going
      for (const t1 of [3000, 3500, 3650, 6000]) {
        const actions = [{ at: 0, pos: 50 }, { at: 1000, pos: 50 }, { at: t1, pos: 10 }, { at: t1 + 1000, pos: 50 }];
        // join smoothness 0: the landing alone (the blend would ease toward the point's own slow line)
        const res = fillRange({ actions, selection: { startMs: 1000, endMs: t1 }, patternId: 'hold-top', options: { endFit, maxSpeed: CEILING, joinSmoothness: 0 } }, deps);
        const win = res.actions.filter((a) => a.at >= 1000 && a.at <= t1);
        const tag = `${endFit} ${t1}: ${win.map((a) => `${a.at}:${a.pos}`).join(' ')}`;
        expect(win[win.length - 1], tag).toEqual({ at: t1, pos: 10 });
        // the hold (2 s at 90) stays a hold; before, the last leg glided 1.4-2.1 s from the top onto the point
        expect(win[win.length - 2].pos, tag).toBeGreaterThanOrEqual(85);
        expect(t1 - win[win.length - 2].at, tag).toBeLessThanOrEqual(400);
      }
    }
  });

  it('the reported case: a 3.4 s range with one point at 4.0 s, buzz-uneven-long-strokes, own speed and 600', () => {
    const actions = [];
    for (let t = 0; t <= 2000; t += 250) actions.push({ at: t, pos: (t / 250) % 2 ? 100 : 0 });
    actions.push({ at: 4000, pos: 50 });
    for (let t = 6000; t <= 8000; t += 250) actions.push({ at: t, pos: ((t - 6000) / 250) % 2 ? 100 : 0 });
    for (const speed of [null, CEILING]) {
      const res = fillRange({ actions, selection: { startMs: 2300, endMs: 5700 }, patternId: 'buzz-uneven-long-strokes', options: { speed, ramp: speed ? { to: speed } : null, maxSpeed: CEILING, seed: 1 } });
      const win = res.actions.filter((a) => a.at >= 2300 && a.at <= 5700);
      const k = win.findIndex((a) => a.at === 4000);
      expect(win[k], String(speed)).toEqual({ at: 4000, pos: 50 });
      // before: the leg into the point ran 861 / 1,051 ms straight from the last buzz point (the pattern's slow leg cut)
      expect(win[k].at - win[k - 1].at, String(speed)).toBeLessThanOrEqual(LONG_MS);
      const own = ownLongestLeg('buzz-uneven-long-strokes', speed);
      for (let i = 1; i < win.length; i++) {
        expect(win[i].at - win[i - 1].at, `${speed} ${win[i - 1].at}`).toBeLessThanOrEqual(own);
        expect((Math.abs(win[i].pos - win[i - 1].pos) / (win[i].at - win[i - 1].at)) * 1000).toBeLessThanOrEqual(CEILING + 0.5);
      }
    }
  });
});
