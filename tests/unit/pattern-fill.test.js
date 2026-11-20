/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The fill core of the editor's "Fill with pattern" (pattern-fill.js): the joins at both ends, the two end fits,
// replace / gap / outside anchors, the free ends of an empty script, the options and the engine injection.
// Named cases here; the sweep over every pattern is pattern-fill-properties.test.js, the live-preview budget
// pattern-fill-perf.test.js.
import { describe, it, expect, vi } from 'vitest';
import { fillRange, FILL_TEMPO_MIN, FILL_TEMPO_MAX } from '../../renderer/js/pattern-fill.js';
import { renderPattern, describePattern } from '../../renderer/js/pattern-library.js';
import { fakeRender, fakeDescribe } from './helpers/fake-pattern-engine.js';

const fake = { render: fakeRender, describe: fakeDescribe };
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const legsOf = (pts) => pts.slice(1).map((b, i) => ({ a: pts[i], b, dt: b.at - pts[i].at, v: (Math.abs(b.pos - pts[i].pos) / (b.at - pts[i].at)) * 1000 }));
/** The chain [A, fill..., B] around a fill: the inserted points with the kept points that bound them. */
function chainOf(res, t0, t1) {
  return res.actions.filter((a) => a.at >= t0 && a.at <= t1);
}
function expectLegsOk(chain, cap, minLeg = 100) {
  for (const l of legsOf(chain)) {
    expect(l.dt).toBeGreaterThanOrEqual(minLeg);
    expect(l.v).toBeLessThanOrEqual(cap + 0.5);
  }
}

// A stroke script: 10 / 90 turns every 400 ms, then whatever the test puts around the selection.
const strokes = (from, n, lo = 10, hi = 90, leg = 400) => Array.from({ length: n }, (_, i) => ({ at: from + i * leg, pos: i % 2 ? hi : lo }));

describe('pattern-fill: API and engine injection', () => {
  it('returns the full new action list, the inserted points, the removed count, warnings and stats', () => {
    const actions = [...strokes(0, 4), { at: 1500, pos: 50 }, { at: 2500, pos: 20 }, { at: 6000, pos: 70 }, ...strokes(6400, 3)];
    const res = fillRange({ actions, selection: { startMs: 1200, endMs: 6000 }, patternId: 'quick-full-strokes', options: { seed: 2 } });
    expect(Array.isArray(res.actions)).toBe(true);
    expect(res.inserted.length).toBeGreaterThan(5);
    expect(res.removedCount).toBe(2); // 1500 and 2500; 1200 (A) and 6000 (B) stay
    expect(res.removed).toEqual([{ at: 1500, pos: 50 }, { at: 2500, pos: 20 }]);
    expect(res.warnings).toEqual([]);
    expect(res.stats.points).toBe(res.inserted.length);
    expect(res.stats.cap).toBe(600);
    expect(res.stats.max).toBeLessThanOrEqual(600);
    expect(res.actions.length).toBe(actions.length - 2 + res.inserted.length);
  });

  it('the default renderer is the library engine: the same fill with it injected explicitly', () => {
    const actions = [{ at: 0, pos: 20 }, { at: 1000, pos: 80 }, { at: 9000, pos: 30 }, { at: 9400, pos: 90 }];
    const input = { actions, selection: { startMs: 1000, endMs: 9000 }, patternId: 'slow-tip-strokes', options: { seed: 5 } };
    expect(fillRange(input)).toEqual(fillRange(input, { render: renderPattern, describe: describePattern }));
  });

  it('hands the engine A’s position and heading, the cap, the asked speed, ramp, range, reverse, variation and seed', () => {
    const render = vi.fn(fakeRender);
    const actions = [{ at: 0, pos: 20 }, { at: 1000, pos: 40 }, { at: 1400, pos: 70 }, { at: 6000, pos: 30 }, { at: 6500, pos: 60 }];
    fillRange({
      actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'tri',
      options: { speed: 150, ramp: { to: 250 }, reversed: true, range: { min: 20, max: 80 }, variation: 0.5, seed: 9, maxSpeed: 500 },
    }, { render, describe: fakeDescribe });
    const [id, o] = render.mock.calls[0];
    expect(id).toBe('tri');
    expect(o.from).toBe(1000);
    expect(o.startPos).toBe(40);
    expect(o.startDir).toBe(1); // replace mode: toward the original next point (70)
    expect(o.speed).toBe(150);
    // the render runs past B: the ramp carries on at the selection's slope
    expect(o.ramp.to).toBeCloseTo(150 + (100 * o.durationMs) / 5000, 6);
    expect(o.durationMs).toBeGreaterThan(5000);
    expect(o).toMatchObject({ reversed: true, range: { min: 20, max: 80 }, variation: 0.5, seed: 9, maxSpeed: 500 });
  });

  it('leaves the speed to the pattern when none is asked (no speed, no ramp passed)', () => {
    const render = vi.fn(fakeRender);
    fillRange({ actions: [{ at: 0, pos: 10 }, { at: 3000, pos: 90 }], selection: { startMs: 0, endMs: 3000 }, patternId: 'tri' }, { render, describe: fakeDescribe });
    const o = render.mock.calls[0][1];
    expect(o.speed).toBeUndefined();
    expect(o.ramp).toBeUndefined();
    expect(o.maxSpeed).toBe(600);
  });

  it('never changes the input array or its points (a frozen input works)', () => {
    const actions = Object.freeze(strokes(0, 12).map((a) => Object.freeze(a)));
    const before = JSON.stringify(actions);
    const res = fillRange({ actions, selection: { startMs: 800, endMs: 3600 }, patternId: 'quick-full-strokes' });
    expect(JSON.stringify(actions)).toBe(before);
    expect(res.actions).not.toBe(actions);
    for (const a of res.actions) expect(actions.includes(a)).toBe(false);
  });

  it('an unknown pattern, a missing selection, a throwing engine: the script comes back unchanged with a notice', () => {
    const actions = strokes(0, 6);
    const a = fillRange({ actions, selection: { startMs: 0, endMs: 2000 }, patternId: 'no-such-pattern' });
    expect(a.actions).toEqual(actions);
    expect(a.warnings[0].code).toBe('unknown-pattern');
    const b = fillRange({ actions, selection: null, patternId: 'quick-full-strokes' });
    expect(b.actions).toEqual(actions);
    expect(b.warnings[0].code).toBe('no-selection');
    const c = fillRange({ actions, selection: { startMs: 0, endMs: 2000 }, patternId: 'tri' }, { render: () => { throw new Error('boom'); }, describe: fakeDescribe });
    expect(c.actions).toEqual(actions);
    expect(c.removedCount).toBe(0);
    expect(c.warnings.map((w) => w.code)).toContain('render-failed');
  });
});

describe('pattern-fill: the start joins where A is heading', () => {
  // A in the middle of the band, the script rising into it / leaving it upward
  it('A mid-band heading up: the first leg goes up (replace: toward the original next point)', () => {
    const actions = [{ at: 0, pos: 20 }, { at: 1000, pos: 45 }, { at: 1300, pos: 80 }, { at: 6000, pos: 50 }, { at: 6400, pos: 10 }];
    for (const id of ['quick-full-strokes', 'tip-strokes-long-short', 'stuttering-middle-strokes']) {
      const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: id, options: { seed: 3 } });
      expect(res.inserted[0].pos).toBeGreaterThan(45);
    }
  });

  it('A mid-band heading down (falling into it): the first leg goes down', () => {
    const actions = [{ at: 0, pos: 90 }, { at: 1000, pos: 55 }, { at: 6000, pos: 50 }, { at: 6400, pos: 10 }];
    // gap mode reads the heading from the leg INTO A (90 -> 55: down)
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes', options: { mode: 'gap', seed: 1 } });
    expect(res.inserted.length).toBeGreaterThan(0);
    expect(res.inserted[0].pos).toBeLessThan(55);
  });

  it('rising into the top of the band (A at the top heading up): the pattern turns at once, the first leg goes down', () => {
    const actions = [{ at: 0, pos: 30 }, { at: 1000, pos: 90 }, { at: 1300, pos: 100 }, { at: 6000, pos: 50 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes', options: { seed: 2 } });
    expect(res.inserted[0].pos).toBeLessThan(90);
  });

  it('falling into the bottom (A at the bottom heading down): the first leg goes up', () => {
    const actions = [{ at: 0, pos: 70 }, { at: 1000, pos: 10 }, { at: 1300, pos: 0 }, { at: 6000, pos: 50 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes', options: { seed: 2 } });
    expect(res.inserted[0].pos).toBeGreaterThan(10);
  });

  it('an engine that sets off the wrong way is corrected: the fill starts at the first turn ahead of A', () => {
    // naive-tri heads for the turn nearest startPos (40 -> 10, down) whatever the heading; A heads up
    const actions = [{ at: 0, pos: 10 }, { at: 1000, pos: 40 }, { at: 1300, pos: 70 }, { at: 6000, pos: 50 }, { at: 6400, pos: 10 }];
    const naive = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'naive-tri', options: { joinSmoothness: 0 } }, fake);
    expect(fakeRender('naive-tri', { durationMs: 2000, from: 1000, startPos: 40, startDir: 1 }).actions[1].pos).toBeLessThan(40);
    expect(naive.inserted[0].pos).toBeGreaterThan(40);
    expect(naive.inserted[0].pos).toBeGreaterThanOrEqual(85); // the top turn
    // reached at the pattern's own leg speed (200 u/s: 50 units in about 250 ms), not after a wasted stroke
    expect(naive.inserted[0].at - 1000).toBeLessThan(400);
    expectLegsOk(chainOf(naive, 1000, 6000), 600);
  });

  it('a flat neighbour (the script holds at A): no heading, and join smoothness eases out of the hold', () => {
    const actions = [{ at: 0, pos: 50 }, { at: 1000, pos: 50 }, { at: 1300, pos: 50 }, { at: 9000, pos: 50 }, { at: 9300, pos: 50 }];
    const render = vi.fn(fakeRender);
    const sharp = fillRange({ actions, selection: { startMs: 1000, endMs: 9000 }, patternId: 'tri', options: { joinSmoothness: 0 } }, { render, describe: fakeDescribe });
    expect(render.mock.calls[0][1].startDir).toBeUndefined();
    const soft = fillRange({ actions, selection: { startMs: 1000, endMs: 9000 }, patternId: 'tri', options: { joinSmoothness: 1 } }, fake);
    // the first stroke is shallower with the blend (eased from the hold at 50 into the pattern), the same times
    expect(soft.inserted[0].at).toBe(sharp.inserted[0].at);
    expect(Math.abs(soft.inserted[0].pos - 50)).toBeLessThan(Math.abs(sharp.inserted[0].pos - 50));
    // and the middle of the fill is the pattern itself
    const mid = (r) => r.inserted.filter((p) => p.at > 3000 && p.at < 7000);
    expect(mid(soft)).toEqual(mid(sharp));
  });
});

describe('pattern-fill: the end lands on B', () => {
  it('stretch: tempo within 0.87-1.15, the last leg arrives the way B wants (rising into B, which falls after)', () => {
    // gap mode reads B's arrival from the leg that leaves it, as a turn: B -> down after it, so arrive going up
    const actions = [{ at: 0, pos: 20 }, { at: 1000, pos: 50 }, { at: 7000, pos: 70 }, { at: 7400, pos: 10 }];
    for (const seed of [1, 2, 3, 4]) {
      const res = fillRange({ actions, selection: { startMs: 1000, endMs: 7000 }, patternId: 'quick-full-strokes', options: { mode: 'gap', seed } });
      expect(res.stretches[0].endFit).toBe('stretch');
      expect(res.stretches[0].tempo).toBeGreaterThanOrEqual(FILL_TEMPO_MIN);
      expect(res.stretches[0].tempo).toBeLessThanOrEqual(FILL_TEMPO_MAX);
      expect(res.stats.tempo).toBe(res.stretches[0].tempo);
      const last = res.inserted[res.inserted.length - 1];
      expect(last.pos).toBeLessThan(70); // arrives going up
      expectLegsOk(chainOf(res, 1000, 7000), 600);
    }
  });

  it('stretch: falling into B, which rises after it', () => {
    const actions = [{ at: 0, pos: 20 }, { at: 1000, pos: 50 }, { at: 7000, pos: 30 }, { at: 7400, pos: 95 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 7000 }, patternId: 'quick-full-strokes', options: { mode: 'gap', seed: 1 } });
    expect(res.stretches[0].endFit).toBe('stretch');
    expect(res.inserted[res.inserted.length - 1].pos).toBeGreaterThan(30);
  });

  it('stretch lands whole strokes: the point before B is a turn of the pattern, scaled, not a cut-off stroke', () => {
    const actions = [{ at: 0, pos: 10 }, { at: 1000, pos: 10 }, { at: 1400, pos: 90 }, { at: 6000, pos: 90 }, { at: 6400, pos: 10 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'tri', options: { joinSmoothness: 0 } }, fake);
    expect(res.stretches[0].endFit).toBe('stretch');
    const last = res.inserted[res.inserted.length - 1];
    expect(last.pos).toBeLessThanOrEqual(14); // a bottom turn, then the last stroke up into B at 90
  });

  it('partial: the tempo stays and the fill is the plain render cut before B (minus a last point too close to B)', () => {
    const render = vi.fn(fakeRender);
    const actions = [{ at: 0, pos: 10 }, { at: 1000, pos: 10 }, { at: 1400, pos: 90 }, { at: 6100, pos: 50 }, { at: 6400, pos: 10 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6100 }, patternId: 'tri', options: { endFit: 'partial', joinSmoothness: 0 } }, { render, describe: fakeDescribe });
    expect(res.stretches[0]).toMatchObject({ endFit: 'partial', tempo: null });
    expect(res.warnings).toEqual([]);
    const rendered = render.mock.results[0].value.actions.filter((a) => a.at > 1000 && a.at < 6100);
    expect(rendered.slice(0, res.inserted.length)).toEqual(res.inserted);
    const last = res.inserted[res.inserted.length - 1];
    expect(6100 - last.at).toBeGreaterThanOrEqual(100);
  });

  it('stretch with no landing in reach falls back to partial and says so', () => {
    // a 2 s wait at the top: 3.2 s cannot be fitted to whole strokes within 0.87-1.15
    const actions = [{ at: 0, pos: 10 }, { at: 1000, pos: 10 }, { at: 1400, pos: 90 }, { at: 4200, pos: 20 }, { at: 4600, pos: 80 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 4200 }, patternId: 'hold-top', options: { seed: 1 } }, fake);
    expect(res.stretches[0].endFit).toBe('partial');
    expect(res.warnings.map((w) => w.code)).toContain('end-fit-partial');
    expectLegsOk(chainOf(res, 1000, 4200), 600);
  });

  it('a neighbour very close to the selection edge: the joins still keep the minimum leg and the cap, the neighbours stay', () => {
    // 20 ms into A and 30 ms out of B, steep both
    const actions = [{ at: 980, pos: 0 }, { at: 1000, pos: 100 }, { at: 1600, pos: 0 }, { at: 5000, pos: 0 }, { at: 5030, pos: 100 }];
    for (const id of ['quick-full-strokes', 'buzz-tiny-base-strokes', 'fast-tip-flicks']) {
      for (const endFit of ['stretch', 'partial']) {
        const res = fillRange({ actions, selection: { startMs: 1000, endMs: 5000 }, patternId: id, options: { endFit } });
        expect(res.actions[0]).toEqual({ at: 980, pos: 0 });
        expect(res.actions[res.actions.length - 1]).toEqual({ at: 5030, pos: 100 });
        const chain = chainOf(res, 1000, 5000);
        expect(chain[0]).toEqual({ at: 1000, pos: 100 });
        expect(chain[chain.length - 1]).toEqual({ at: 5000, pos: 0 });
        // the join legs (to A and to B) are ordinary legs: 100 ms
        expect(chain[1].at - 1000).toBeGreaterThanOrEqual(100);
        expect(5000 - chain[chain.length - 2].at).toBeGreaterThanOrEqual(100);
        for (const l of legsOf(chain)) { expect(l.dt).toBeGreaterThanOrEqual(50); expect(l.v).toBeLessThanOrEqual(600.5); }
      }
    }
  });
});

describe('pattern-fill: replace, outside anchors and gap mode', () => {
  const script = [{ at: 0, pos: 10 }, { at: 500, pos: 90 }, { at: 1000, pos: 10 }, { at: 1500, pos: 90 }, { at: 2000, pos: 10 }, { at: 2500, pos: 90 }, { at: 6000, pos: 20 }, { at: 6400, pos: 80 }];

  it('replace keeps the first and last selected points as anchors and drops the points between them', () => {
    const res = fillRange({ actions: script, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes' });
    expect(res.removed).toEqual([{ at: 1500, pos: 90 }, { at: 2000, pos: 10 }, { at: 2500, pos: 90 }]);
    for (const p of [script[0], script[1], script[2], script[6], script[7]]) expect(res.actions).toContainEqual(p);
    for (const p of res.inserted) { expect(p.at).toBeGreaterThan(1000); expect(p.at).toBeLessThan(6000); }
  });

  it('anchors "outside" replaces the selected points too and joins the points around the selection', () => {
    const res = fillRange({ actions: script, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes', options: { anchors: 'outside' } });
    expect(res.removedCount).toBe(5);
    expect(res.removed.map((p) => p.at)).toEqual([1000, 1500, 2000, 2500, 6000]);
    expect(res.actions[0]).toEqual(script[0]);
    expect(res.actions[1]).toEqual(script[1]);
    expect(res.actions[res.actions.length - 1]).toEqual(script[7]);
    // the fill starts on the line the kept neighbours make at the selection's start (500/90 -> 6400/80)
    expect(res.inserted[0].at).toBe(1000);
    expect(res.inserted[0].pos).toBe(89);
    for (const p of res.inserted) { expect(p.at).toBeGreaterThanOrEqual(1000); expect(p.at).toBeLessThanOrEqual(6000); }
    expectLegsOk(res.actions.filter((a) => a.at >= 1000 && a.at <= 6000), 600);
  });

  it('gap mode never moves or removes a point and fills only the empty stretches long enough', () => {
    const res = fillRange({ actions: script, selection: { startMs: 0, endMs: 6400 }, patternId: 'quick-full-strokes', options: { mode: 'gap' } });
    expect(res.removedCount).toBe(0);
    for (const p of script) expect(res.actions).toContainEqual(p);
    expect(res.stretches.map((s) => [s.startMs, s.endMs])).toEqual([[2500, 6000]]);
    for (const p of res.inserted) { expect(p.at).toBeGreaterThan(2500); expect(p.at).toBeLessThan(6000); }
  });

  it('gap mode: each stretch is filled on its own with seed + its index; none long enough gives no points and no-gap', () => {
    const two = [{ at: 0, pos: 10 }, { at: 400, pos: 90 }, { at: 5400, pos: 10 }, { at: 5800, pos: 90 }, { at: 10800, pos: 10 }];
    const res = fillRange({ actions: two, selection: { startMs: 0, endMs: 10800 }, patternId: 'quick-full-strokes', options: { mode: 'gap', seed: 4 } });
    expect(res.stretches.length).toBe(2);
    const first = res.inserted.filter((p) => p.at < 5400).map((p) => ({ at: p.at - 400, pos: p.pos }));
    const second = res.inserted.filter((p) => p.at > 5800).map((p) => ({ at: p.at - 5800, pos: p.pos }));
    expect(second).not.toEqual(first); // the same shape of gap, another seed
    const none = fillRange({ actions: script.slice(0, 6), selection: { startMs: 0, endMs: 2500 }, patternId: 'quick-full-strokes', options: { mode: 'gap' } });
    expect(none.inserted).toEqual([]);
    expect(none.actions).toEqual(script.slice(0, 6));
    expect(none.warnings.map((w) => w.code)).toEqual(['no-gap']);
  });

  it('a window shorter than two minimum legs gives no points, too-short, and keeps every point (replace mode)', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 80, pos: 40 }, { at: 150, pos: 50 }, { at: 400, pos: 0 }];
    const res = fillRange({ actions, selection: { startMs: 0, endMs: 150 }, patternId: 'quick-full-strokes' });
    expect(res.inserted).toEqual([]);
    expect(res.removedCount).toBe(0);
    expect(res.actions).toEqual(actions);
    expect(res.warnings.map((w) => w.code)).toEqual(['too-short']);
  });

  // Fix-up 2026-11-17 (review-1): the partial end fit popped every rendered point (the last one sat under a minimum
  // leg from B), the stretch still counted as filled, and the selected inner point was removed with nothing inserted
  // and no warning. A stretch now counts only when a point of the pattern made it in.
  it('a window the pattern cannot fit (partial end, every point popped): too-short, and the selected points stay', () => {
    const actions = [{ at: 0, pos: 10 }, { at: 1000, pos: 20 }, { at: 1250, pos: 80 }, { at: 1500, pos: 30 }, { at: 3000, pos: 0 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 1500 }, patternId: 'quick-full-strokes', options: { endFit: 'partial' } });
    expect(res.inserted).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.removedCount).toBe(0);
    expect(res.actions).toEqual(actions);
    expect(res.warnings.map((w) => w.code)).toContain('too-short');
  });

  it('the same with stretch falling back to partial (slow tip strokes on 1 s): the points stay, and it says so', () => {
    const actions = [{ at: 0, pos: 10 }, { at: 1000, pos: 20 }, { at: 1250, pos: 80 }, { at: 1500, pos: 30 }, { at: 2000, pos: 30 }, { at: 3000, pos: 0 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 2000 }, patternId: 'slow-tip-strokes' });
    expect(res.inserted).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.actions).toEqual(actions);
    expect(res.warnings.map((w) => w.code)).toContain('too-short');
  });

  it('anchors "outside" with no room for the pattern: the selection is not flattened to its two edge points', () => {
    // It used to remove the three selected points and insert only the two edge points on the script's line.
    const actions = [{ at: 0, pos: 10 }, { at: 1000, pos: 20 }, { at: 1250, pos: 80 }, { at: 1500, pos: 30 }, { at: 3000, pos: 0 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 1300 }, patternId: 'quick-full-strokes', options: { endFit: 'partial', anchors: 'outside' } });
    expect(res.inserted).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.actions).toEqual(actions);
    expect(res.warnings.map((w) => w.code)).toContain('too-short');
    // With room it fills, and a point of the pattern lies between the two edge points.
    const ok = fillRange({ actions, selection: { startMs: 900, endMs: 1600 }, patternId: 'slow-tip-strokes', options: { endFit: 'partial', anchors: 'outside' } });
    expect(ok.inserted.length).toBeGreaterThan(2);
    expect(ok.removed.length).toBe(3);
  });
});

// Fix-up 2026-11-17 (review-1, from the fill sub-review): dirty input never reaches the inserted points.
describe('pattern-fill: dirty input', () => {
  it('a selection reaching before 0: no inserted point has a negative time', () => {
    const res = fillRange({ actions: [], selection: { startMs: -500, endMs: 1500 }, patternId: 'quick-full-strokes' });
    expect(res.inserted.length).toBeGreaterThan(0);
    expect(Math.min(...res.inserted.map((p) => p.at))).toBe(0);
  });

  it('an anchor outside 0-100 (EditableScript keeps raw positions): the fill plans with it held to 0-100, and it stays as it was', () => {
    const actions = [{ at: 0, pos: 50 }, { at: 1000, pos: 400 }, { at: 4000, pos: 30 }, { at: 5000, pos: 60 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 4000 }, patternId: 'quick-full-strokes' });
    expect(res.inserted.length).toBeGreaterThan(2);
    for (const p of res.inserted) {
      expect(Number.isInteger(p.pos)).toBe(true);
      expect(p.pos).toBeGreaterThanOrEqual(0);
      expect(p.pos).toBeLessThanOrEqual(100);
    }
    expect(res.actions).toContainEqual({ at: 1000, pos: 400 });
  });

  it('a point with no position or no time: no NaN anywhere in the fill, and the point comes back untouched', () => {
    const actions = [{ at: 0, pos: 50 }, { at: 1000 }, { at: 2200, pos: 'x' }, { at: 4000, pos: 30 }, { at: 5000, pos: 60 }, { pos: 20 }];
    const res = fillRange({ actions, selection: { startMs: 500, endMs: 4500 }, patternId: 'quick-full-strokes' });
    expect(res.inserted.length).toBeGreaterThan(2);
    for (const p of res.inserted) {
      expect(Number.isFinite(p.at)).toBe(true);
      expect(Number.isFinite(p.pos)).toBe(true);
    }
    expect(res.actions).toContainEqual({ at: 1000, pos: undefined });
    expect(res.actions).toContainEqual({ at: 2200, pos: 'x' });
    expect(res.actions).toContainEqual({ at: undefined, pos: 20 });
  });

  it('a free end after a start moved to A’s heading still reaches the selection’s end (within a stroke)', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 1000, pos: 50 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 7000 }, patternId: 'pause-at-top', options: { reversed: true } });
    expect(res.stretches[0].endFit).toBe('free');
    const last = res.inserted[res.inserted.length - 1];
    expect(7000 - last.at).toBeLessThanOrEqual(describePattern('pause-at-top').strokeMs);
    expect(last.at).toBeLessThanOrEqual(7000);
  });
});

describe('pattern-fill: no neighbour on one or both sides', () => {
  it('an empty script: the fill covers the selection, starting and ending where the pattern likes', () => {
    const res = fillRange({ actions: [], selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes' });
    expect(res.inserted[0].at).toBe(1000);
    expect(res.inserted[res.inserted.length - 1].at).toBe(6000);
    expect(res.actions).toEqual(res.inserted);
    expect(res.stretches[0].endFit).toBe('free');
    expectLegsOk(res.actions, 600);
  });

  it('past the end of the script: the fill starts from the last point’s position (the device holds there)', () => {
    const actions = strokes(0, 5); // ends at 1600 / 10
    const res = fillRange({ actions, selection: { startMs: 3000, endMs: 8000 }, patternId: 'quick-full-strokes' });
    expect(res.inserted[0]).toEqual({ at: 3000, pos: 10 });
    expect(res.actions.slice(0, 5)).toEqual(actions);
    expectLegsOk(res.actions.filter((a) => a.at >= 3000), 600);
  });

  it('before the first point: the fill ends on the first point’s position, which stays', () => {
    const actions = strokes(9000, 4);
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes' });
    expect(res.inserted[res.inserted.length - 1]).toEqual({ at: 6000, pos: 10 });
    expect(res.actions.slice(-4)).toEqual(actions);
  });

  it('a selection inside a long segment: the fill sits on that segment’s line at both edges', () => {
    const actions = [{ at: 0, pos: 50 }, { at: 9000, pos: 20 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes' });
    expect(res.inserted[0]).toEqual({ at: 1000, pos: 47 });
    expect(res.inserted[res.inserted.length - 1]).toEqual({ at: 6000, pos: 30 });
    expect(res.actions[0]).toEqual(actions[0]);
    expect(res.actions[res.actions.length - 1]).toEqual(actions[1]);
  });

  it('a selection edge 30 ms after a point: the edge point moves to a full minimum leg after it, on the same line', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 1000, pos: 20 }, { at: 9000, pos: 100 }];
    const res = fillRange({ actions, selection: { startMs: 1030, endMs: 6000 }, patternId: 'quick-full-strokes' });
    expect(res.inserted[0]).toEqual({ at: 1100, pos: 21 }); // 20 + 80 * 100 / 8000
    expect(res.actions.slice(0, 2)).toEqual(actions.slice(0, 2));
    expectLegsOk(res.actions.filter((a) => a.at >= 1000 && a.at <= 6000), 600);
  });

  it('positions round symmetrically about 50: a half-way edge (0.5) mirrors exactly', () => {
    // the start edge sits half way along 0 -> 1, at 0.5 (49.5 below the middle); mirrored, 99.5
    const plain = fillRange({ actions: [{ at: 0, pos: 0 }, { at: 10000, pos: 1 }], selection: { startMs: 5000, endMs: 9000 }, patternId: 'quick-full-strokes' });
    const mirrored = fillRange({ actions: [{ at: 0, pos: 100 }, { at: 10000, pos: 99 }], selection: { startMs: 5000, endMs: 9000 }, patternId: 'quick-full-strokes', options: { reversed: true } });
    expect(plain.inserted[0].at).toBe(5000);
    expect(mirrored.actions.map((a) => ({ at: a.at, pos: 100 - a.pos }))).toEqual(plain.actions);
  });

  it('one point in the selection: it stays, and both sides of it are filled', () => {
    const actions = [{ at: 0, pos: 50 }, { at: 3000, pos: 80 }, { at: 9000, pos: 20 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 6000 }, patternId: 'quick-full-strokes' });
    expect(res.actions).toContainEqual({ at: 3000, pos: 80 });
    expect(res.stretches.map((s) => [s.startMs, s.endMs])).toEqual([[1000, 3000], [3000, 6000]]);
    expect(res.removedCount).toBe(0);
  });
});

describe('pattern-fill: options', () => {
  const around = [{ at: 0, pos: 10 }, { at: 1000, pos: 10 }, { at: 1400, pos: 90 }, { at: 21000, pos: 10 }, { at: 21400, pos: 90 }];

  it('the speed ramp builds across the selection', () => {
    const res = fillRange({ actions: around, selection: { startMs: 1000, endMs: 21000 }, patternId: 'quick-full-strokes', options: { speed: 100, ramp: { to: 350 } } });
    const mean = (pts) => { const l = legsOf(pts).filter((x) => x.v > 0); return l.reduce((s, x) => s + x.v, 0) / l.length; };
    const first = mean(res.inserted.filter((p) => p.at < 7000)), last = mean(res.inserted.filter((p) => p.at > 15000));
    expect(first).toBeLessThan(160);
    expect(last).toBeGreaterThan(260);
    expect(res.stats.speed).toEqual({ from: 100, to: 350 });
  });

  it('maxSpeed holds every leg, the joins included', () => {
    const res = fillRange({ actions: around, selection: { startMs: 1000, endMs: 21000 }, patternId: 'frantic-long-strokes', options: { maxSpeed: 150 } });
    expect(res.stats.cap).toBe(150);
    expectLegsOk(chainOf(res, 1000, 21000), 150);
  });

  it('a join that no fill can make under the cap says join-too-fast', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 1000, pos: 0 }, { at: 1600, pos: 100 }, { at: 2000, pos: 100 }];
    const res = fillRange({ actions, selection: { startMs: 1000, endMs: 1600 }, patternId: 'quick-full-strokes', options: { maxSpeed: 100 } });
    expect(res.warnings.map((w) => w.code)).toContain('join-too-fast');
  });

  it('minLegMs: no leg of the fill is shorter', () => {
    // At 450 u/s the plain fill has legs well under 200 ms (about 107), so this depends on the option (fix-up
    // 2026-11-17: at the pattern's own speed the shortest leg was already 210 ms, and the test passed without it).
    const opts = { speed: 450 };
    const shortest = (res) => Math.min(...legsOf(chainOf(res, 1000, 21000)).map((l) => l.dt));
    const plain = fillRange({ actions: around, selection: { startMs: 1000, endMs: 21000 }, patternId: 'fast-tip-flicks', options: opts });
    expect(shortest(plain)).toBeLessThan(200);
    const res = fillRange({ actions: around, selection: { startMs: 1000, endMs: 21000 }, patternId: 'fast-tip-flicks', options: { ...opts, minLegMs: 200 } });
    expect(res.inserted.length).toBeGreaterThan(10);
    expect(shortest(res)).toBeGreaterThanOrEqual(200);
    expectLegsOk(chainOf(res, 1000, 21000), res.stats.cap, 200);
  });

  it('variation 0: the middle of the fill repeats whole cycles (times within 1 ms, positions within 1)', () => {
    const res = fillRange({ actions: around, selection: { startMs: 1000, endMs: 21000 }, patternId: 'quick-full-strokes', options: { variation: 0, joinSmoothness: 0 } });
    const mid = res.inserted.filter((p) => p.at > 5000 && p.at < 17000);
    const legs = legsOf(mid);
    for (let i = 2; i < legs.length; i++) {
      expect(Math.abs(legs[i].dt - legs[i - 2].dt)).toBeLessThanOrEqual(1);
      expect(Math.abs(legs[i].b.pos - legs[i - 2].b.pos)).toBeLessThanOrEqual(1);
    }
  });

  it('the same seed gives the same fill; another seed another one', () => {
    const input = (seed) => ({ actions: around, selection: { startMs: 1000, endMs: 21000 }, patternId: 'uneven-long-strokes', options: { seed } });
    expect(fillRange(input(3))).toEqual(fillRange(input(3)));
    expect(fillRange(input(4)).inserted).not.toEqual(fillRange(input(3)).inserted);
  });
});
