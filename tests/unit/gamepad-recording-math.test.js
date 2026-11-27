/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Gamepad recording, the pure parts (editor work list 2.6, 2026-11-24): the
// stick to a position, a take's samples to keyframes, and the take landing
// on an axis as one undo step. Every expectation is on what lands (the
// points, the error against what the stick did, the undo history), not on
// how the code gets there.
import { describe, it, expect } from 'vitest';
import {
  stickToPos, normalizeSamples, turningPoints, samplesToActions, interpolateAt,
  maxDeviation, mergeRecorded, landTake, takeToKeyframes,
  DEFAULT_DEADZONE, DEFAULT_EPSILON,
} from '../../renderer/js/gamepad-recording-math.js';
import { EditableScript } from '../../renderer/js/editable-script.js';

/** Samples of f(tMs) every `stepMs` from 0 to `durMs` (inclusive). */
function sample(f, durMs, stepMs) {
  const out = [];
  for (let i = 0; i * stepMs <= durMs + 1e-9; i++) {
    const at = i * stepMs;
    out.push({ at, pos: f(at) });
  }
  return out;
}

/** A triangle wave between lo and hi with `periodMs` (starts at lo). */
const triangle = (lo, hi, periodMs) => (t) => {
  const ph = (t % periodMs) / periodMs;
  return ph < 0.5 ? lo + (hi - lo) * (ph * 2) : hi - (hi - lo) * ((ph - 0.5) * 2);
};

describe('stickToPos: a stick value to a position', () => {
  it('rests at 50, full travel reaches 0 and 100', () => {
    expect(stickToPos(0)).toBe(50);
    expect(stickToPos(1)).toBe(100);
    expect(stickToPos(-1)).toBe(0);
  });

  it('reads anything inside the deadzone as the centre', () => {
    expect(stickToPos(DEFAULT_DEADZONE * 0.99)).toBe(50);
    expect(stickToPos(-DEFAULT_DEADZONE)).toBe(50);
    expect(stickToPos(0.3, { deadzone: 0.35 })).toBe(50);
  });

  it('stretches the travel left outside the deadzone back to the full range', () => {
    // 0.55 with a 0.1 deadzone is half of the remaining 0.9 of travel.
    expect(stickToPos(0.55, { deadzone: 0.1 })).toBeCloseTo(75, 9);
    expect(stickToPos(-0.55, { deadzone: 0.1 })).toBeCloseTo(25, 9);
    expect(stickToPos(1, { deadzone: 0.5 })).toBe(100);
  });

  it('a vertical axis reads up as 100 (the Gamepad API gives -1 at the top)', () => {
    expect(stickToPos(-1, { up: true })).toBe(100);
    expect(stickToPos(1, { up: true })).toBe(0);
  });

  it('invert flips the result, on top of the vertical flip', () => {
    expect(stickToPos(1, { invert: true })).toBe(0);
    expect(stickToPos(-1, { up: true, invert: true })).toBe(0);
  });

  it('clamps out-of-range and junk values', () => {
    expect(stickToPos(3)).toBe(100);
    expect(stickToPos(-7)).toBe(0);
    expect(stickToPos(undefined)).toBe(50);
    expect(stickToPos(NaN)).toBe(50);
  });
});

describe('normalizeSamples', () => {
  it('whole ms and positions, in time order, the newest reading on a shared time', () => {
    const out = normalizeSamples([
      { at: 20.4, pos: 10.6 }, { at: 10, pos: 5 }, { at: 19.6, pos: 99 }, { at: 30, pos: 120 }, { at: NaN, pos: 1 },
    ]);
    // 20.4 and 19.6 both round to 20; the later sample in the list wins.
    expect(out).toEqual({ at: [10, 20, 30], pos: [5, 99, 100] });
  });
});

describe('turningPoints', () => {
  it('finds each reversal at the extreme sample itself', () => {
    const pos = [0, 20, 40, 60, 40, 20, 0, 30, 70];
    expect(turningPoints(pos, 5)).toEqual([3, 6]);
  });

  it('ignores a wobble smaller than the threshold', () => {
    const pos = [0, 20, 40, 39, 41, 60, 58, 80];
    expect(turningPoints(pos, 5)).toEqual([]);
  });

  it('takes the FIRST sample of a flat top', () => {
    const pos = [0, 50, 100, 100, 100, 50, 0];
    expect(turningPoints(pos, 5)).toEqual([2]);
  });
});

describe('samplesToActions: a take to keyframes', () => {
  it('reduces a sine to far fewer points, every sample within epsilon of the result', () => {
    // 1 Hz, full travel, 4 s at 60 readings a second.
    const samples = sample((t) => 50 + 50 * Math.sin((2 * Math.PI * t) / 1000), 4000, 1000 / 60);
    const actions = samplesToActions(samples, { epsilon: 2 });
    expect(samples.length).toBe(241);
    expect(actions.length).toBeLessThan(samples.length / 4);
    expect(maxDeviation(samples, actions)).toBeLessThanOrEqual(2);
    // Whole numbers, ascending, inside 0-100.
    for (let i = 0; i < actions.length; i++) {
      expect(Number.isInteger(actions[i].at)).toBe(true);
      expect(Number.isInteger(actions[i].pos)).toBe(true);
      expect(actions[i].pos).toBeGreaterThanOrEqual(0);
      expect(actions[i].pos).toBeLessThanOrEqual(100);
      if (i) expect(actions[i].at).toBeGreaterThan(actions[i - 1].at);
    }
  });

  it('keeps every top and bottom at full travel, within one reading of when the stick got there', () => {
    // Rounded to whole positions, a sine's top is a short flat run of 100s
    // (233, 250, 267 ms): the stroke must still reach 100 there, not stop
    // short on a sample beside it.
    const samples = sample((t) => 50 + 50 * Math.sin((2 * Math.PI * t) / 1000), 4000, 1000 / 60);
    const actions = samplesToActions(samples, { epsilon: 2 });
    const near = (ms, pos) => actions.some((a) => a.pos === pos && Math.abs(a.at - ms) <= 17);
    for (const peak of [250, 1250, 2250, 3250]) expect(near(peak, 100)).toBe(true);
    for (const dip of [750, 1750, 2750, 3750]) expect(near(dip, 0)).toBe(true);
  });

  it('a triangle needs nothing but its corners and its ends', () => {
    const samples = sample(triangle(10, 90, 1000), 3000, 1000 / 60);
    const actions = samplesToActions(samples, { epsilon: DEFAULT_EPSILON });
    expect(actions).toEqual([
      { at: 0, pos: 10 }, { at: 500, pos: 90 }, { at: 1000, pos: 10 }, { at: 1500, pos: 90 },
      { at: 2000, pos: 10 }, { at: 2500, pos: 90 }, { at: 3000, pos: 10 },
    ]);
  });

  it('stick jitter below epsilon adds no points', () => {
    const base = triangle(10, 90, 1000);
    // ±1 of wobble on the slopes; the corners (every 30th reading) stay
    // clean, so where the points must be is known.
    const samples = [];
    for (let i = 0; i <= 180; i++) {
      const at = (i * 1000) / 60;
      samples.push({ at, pos: base(at) + (i % 30 === 0 ? 0 : (i % 3) - 1) });
    }
    const actions = samplesToActions(samples, { epsilon: 2 });
    expect(actions.map((a) => a.at)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000]);
    expect(maxDeviation(samples, actions)).toBeLessThanOrEqual(2);
  });

  it('a stick held still is two points, its first and its last', () => {
    const samples = sample(() => 50, 2000, 1000 / 60);
    expect(samplesToActions(samples)).toEqual([{ at: 0, pos: 50 }, { at: 2000, pos: 50 }]);
  });

  it('a hold between two moves keeps both of its ends', () => {
    // Up to 80 by 500, held to 1500, back down to 20 by 2000.
    const f = (t) => (t <= 500 ? 20 + (60 * t) / 500 : t <= 1500 ? 80 : 80 - (60 * (t - 1500)) / 500);
    const samples = sample(f, 2000, 1000 / 60);
    const actions = samplesToActions(samples, { epsilon: 2 });
    expect(actions).toContainEqual({ at: 500, pos: 80 });
    expect(actions).toContainEqual({ at: 1500, pos: 80 });
    expect(maxDeviation(samples, actions)).toBeLessThanOrEqual(2);
  });

  it('never puts two points closer than the minimum interval', () => {
    // A 50 Hz buzz read 200 times a second: a turning point every 10 ms.
    const samples = sample((t) => ((Math.round(t / 10) % 2) ? 70 : 30), 1000, 5);
    const actions = samplesToActions(samples, { epsilon: 2, minIntervalMs: 1000 / 30 });
    for (let i = 1; i < actions.length; i++) expect(actions[i].at - actions[i - 1].at).toBeGreaterThanOrEqual(33);
    expect(actions[0].at).toBe(0);
    expect(actions[actions.length - 1].at).toBe(1000);
  });

  it('frame starts rounded to whole ms (33 and 34 ms apart at 29.97 fps) all pass', () => {
    const frame = 1001 / 30;
    const samples = [];
    for (let i = 0; i < 30; i++) samples.push({ at: Math.round(i * frame), pos: i % 2 ? 90 : 10 });
    const actions = samplesToActions(samples, { epsilon: 2, minIntervalMs: frame });
    expect(actions.length).toBe(30);
  });

  it('snap puts the keyframes on the grid it gives, one per time', () => {
    const samples = sample((t) => 50 + 50 * Math.sin((2 * Math.PI * t) / 1000), 2000, 1000 / 60);
    const snap = (ms) => Math.round(ms / 40) * 40;
    const actions = samplesToActions(samples, { epsilon: 2, minIntervalMs: 40, snap });
    expect(actions.length).toBeGreaterThan(4);
    for (let i = 0; i < actions.length; i++) {
      expect(actions[i].at % 40).toBe(0);
      if (i) expect(actions[i].at).toBeGreaterThan(actions[i - 1].at);
    }
  });

  it('no samples is no points; one sample is one point', () => {
    expect(samplesToActions([])).toEqual([]);
    expect(samplesToActions(null)).toEqual([]);
    expect(samplesToActions([{ at: 12.4, pos: 33.3 }])).toEqual([{ at: 12, pos: 33 }]);
  });
});

describe('interpolateAt', () => {
  it('the line between points, the end positions outside them', () => {
    const a = [{ at: 0, pos: 0 }, { at: 100, pos: 100 }, { at: 200, pos: 50 }];
    expect(interpolateAt(a, 50)).toBe(50);
    expect(interpolateAt(a, 150)).toBe(75);
    expect(interpolateAt(a, -10)).toBe(0);
    expect(interpolateAt(a, 999)).toBe(50);
    expect(interpolateAt([], 5)).toBe(null);
  });
});

describe('mergeRecorded: the take replaces [t0, t1]', () => {
  const existing = [
    { at: 0, pos: 10 }, { at: 1000, pos: 20 }, { at: 1500, pos: 30 }, { at: 2000, pos: 40 }, { at: 3000, pos: 50 },
  ];

  it('removes everything from t0 to t1 inclusive, keeps the rest, puts the take in', () => {
    const out = mergeRecorded(existing, [{ at: 1000, pos: 90 }, { at: 1700, pos: 80 }, { at: 2000, pos: 70 }], 1000, 2000);
    expect(out).toEqual([
      { at: 0, pos: 10 }, { at: 1000, pos: 90 }, { at: 1700, pos: 80 }, { at: 2000, pos: 70 }, { at: 3000, pos: 50 },
    ]);
  });

  it('a point inside the range with no recorded point on its time still goes', () => {
    const out = mergeRecorded(existing, [{ at: 1200, pos: 60 }, { at: 1800, pos: 61 }], 1100, 1900);
    expect(out.map((p) => p.at)).toEqual([0, 1000, 1200, 1800, 2000, 3000]);
  });

  it('an empty take changes nothing (it never deletes what it would have replaced)', () => {
    expect(mergeRecorded(existing, [], 1000, 2000)).toEqual(existing);
  });

  it('ignores take points outside [t0, t1] and leaves its input alone', () => {
    const copy = JSON.parse(JSON.stringify(existing));
    const out = mergeRecorded(existing, [{ at: 500, pos: 1 }, { at: 1200, pos: 60 }, { at: 2500, pos: 1 }], 1100, 1900);
    expect(out).toEqual([{ at: 0, pos: 10 }, { at: 1000, pos: 20 }, { at: 1200, pos: 60 }, { at: 2000, pos: 40 }, { at: 3000, pos: 50 }]);
    expect(existing).toEqual(copy);
    expect(out[0]).not.toBe(existing[0]);
  });

  it('works on an empty axis (a new one)', () => {
    expect(mergeRecorded([], [{ at: 5, pos: 50 }, { at: 40, pos: 60 }], 5, 40)).toEqual([{ at: 5, pos: 50 }, { at: 40, pos: 60 }]);
  });
});

describe('landTake: on an EditableScript as one undo step', () => {
  const start = () => {
    const es = new EditableScript();
    es.loadFromData({ actions: [{ at: 0, pos: 10 }, { at: 1000, pos: 20 }, { at: 1500, pos: 30 }, { at: 2000, pos: 40 }, { at: 3000, pos: 50 }] });
    return es;
  };

  it('lands what mergeRecorded gives, as one undo step, recorded points selected', () => {
    const es = start();
    const take = [{ at: 1000, pos: 90 }, { at: 1700, pos: 80 }, { at: 2000, pos: 70 }];
    const expected = mergeRecorded(es.actions, take, 1000, 2000);
    const r = landTake(es, [{ t0: 1000, t1: 2000, actions: take }]);
    expect(r).toEqual({ changed: true, created: 3, removed: 3 });
    expect(es.actions).toEqual(expected);
    expect(es.dirty).toBe(true);
    expect([...es.selectedIndices].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(es.getCreatedActions()).toEqual(take);

    expect(es.undo()).toBe(true);
    expect(es.actions.map((p) => p.at)).toEqual([0, 1000, 1500, 2000, 3000]);
    expect(es.dirty).toBe(false);
    expect(es.canUndo).toBe(false); // ONE step: nothing older to undo
    expect(es.redo()).toBe(true);
    expect(es.actions).toEqual(expected);
  });

  it('a take that matches the axis leaves no undo step and stays clean', () => {
    const es = start();
    const r = landTake(es, [{ t0: 1000, t1: 1500, actions: [{ at: 1000, pos: 20 }, { at: 1500, pos: 30 }] }]);
    expect(r.changed).toBe(false);
    expect(es.canUndo).toBe(false);
    expect(es.dirty).toBe(false);
  });

  it('an empty take touches nothing', () => {
    const es = start();
    expect(landTake(es, [{ t0: 1000, t1: 2000, actions: [] }])).toEqual({ changed: false, created: 0, removed: 0 });
    expect(es.actions.length).toBe(5);
    expect(es.canUndo).toBe(false);
  });

  it('several takes are still one step, a later one winning where they overlap', () => {
    const es = start();
    const first = { t0: 1000, t1: 2000, actions: [{ at: 1000, pos: 90 }, { at: 1500, pos: 91 }, { at: 2000, pos: 92 }] };
    const again = { t0: 1200, t1: 1600, actions: [{ at: 1200, pos: 5 }, { at: 1600, pos: 6 }] };
    let expected = mergeRecorded(es.actions, first.actions, first.t0, first.t1);
    expected = mergeRecorded(expected, again.actions, again.t0, again.t1);
    landTake(es, [first, again]);
    expect(es.actions).toEqual(expected);
    expect(es.actions.find((p) => p.at === 1500)).toBeUndefined();
    es.undo();
    expect(es.canUndo).toBe(false);
    expect(es.actions.length).toBe(5);
  });

  it('round-trips through exportState / importState, as an axis kept in memory does', () => {
    // The editor keeps an axis that is not on screen as exportState() in
    // _undoCache; a take for it lands on a scratch EditableScript and goes back.
    const kept = start().exportState();
    const scratch = new EditableScript();
    scratch.importState(kept);
    landTake(scratch, [{ t0: 1000, t1: 2000, actions: [{ at: 1100, pos: 77 }] }]);
    const back = new EditableScript();
    back.importState(scratch.exportState());
    expect(back.dirty).toBe(true);
    expect(back.actions.map((p) => p.at)).toEqual([0, 1100, 3000]);
    back.undo();
    expect(back.actions.map((p) => p.at)).toEqual([0, 1000, 1500, 2000, 3000]);
    expect(back.dirty).toBe(false);
  });
});

describe('takeToKeyframes', () => {
  it('both axes reduced over the take range, in whole ms', () => {
    const a = sample(triangle(10, 90, 1000), 1000, 1000 / 60).map((s) => ({ at: s.at + 5000.4, pos: s.pos }));
    const b = a.map((s) => ({ at: s.at, pos: 100 - s.pos }));
    const k = takeToKeyframes({ t0: a[0].at, t1: a[a.length - 1].at, a, b });
    expect(k.t0).toBe(5000);
    expect(k.t1).toBe(6000);
    expect(k.a).toEqual([{ at: 5000, pos: 10 }, { at: 5500, pos: 90 }, { at: 6000, pos: 10 }]);
    expect(k.b).toEqual([{ at: 5000, pos: 90 }, { at: 5500, pos: 10 }, { at: 6000, pos: 90 }]);
  });

  it('widens the range to a keyframe that snap moved before the first sample', () => {
    const a = [{ at: 1030, pos: 10 }, { at: 1100, pos: 50 }, { at: 1170, pos: 90 }];
    const k = takeToKeyframes({ t0: 1030, t1: 1170, a, b: a }, { snap: (ms) => Math.floor(ms / 40) * 40, minIntervalMs: 1 });
    expect(k.a[0].at).toBe(1000);
    expect(k.t0).toBe(1000);
    // So nothing is lost when it lands.
    expect(mergeRecorded([], k.a, k.t0, k.t1)).toEqual(k.a);
  });

  it('null for a take with no range', () => {
    expect(takeToKeyframes(null)).toBe(null);
    expect(takeToKeyframes({ t0: null, t1: null, a: [], b: [] })).toBe(null);
  });
});
