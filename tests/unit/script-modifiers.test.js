/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
import { describe, it, expect } from 'vitest';
import {
  halfSpeed,
  doubleSpeed,
  remapRange,
  offsetTime,
  removePauses,
  reverseActions,
  generatePattern,
} from '../../renderer/js/script-modifiers.js';

describe('script-modifiers', () => {
  const sampleActions = [
    { at: 0, pos: 0 },
    { at: 1000, pos: 100 },
    { at: 2000, pos: 0 },
    { at: 3000, pos: 100 },
    { at: 4000, pos: 0 },
  ];

  // --- Half / double speed -------------------------------------------
  //
  // Reported by belgriffinite (thread #261): double speed "just adds
  // midpoints but doesn't change the actual speed or number of movements".
  // He was right, and the tests that used to live here are the reason it
  // survived: they asserted POINT COUNTS and which indices were kept,
  // which is precisely the broken behaviour, pinned as correct.
  //
  // What matters to a user is the MOVEMENT the device performs. These
  // tests measure that instead, by counting position changes and by
  // interpolating the output the way a device does.

  /** Movements = position changes. This is what "number of strokes" means. */
  const movements = (acts) => {
    let n = 0;
    for (let i = 1; i < acts.length; i++) if (acts[i].pos !== acts[i - 1].pos) n++;
    return n;
  };

  /** Linear interpolation, i.e. what the hardware actually does between keyframes. */
  const posAt = (acts, t) => {
    if (t <= acts[0].at) return acts[0].pos;
    const last = acts[acts.length - 1];
    if (t >= last.at) return last.pos;
    for (let i = 0; i < acts.length - 1; i++) {
      const a = acts[i], b = acts[i + 1];
      if (t >= a.at && t <= b.at) {
        const dt = b.at - a.at;
        return dt === 0 ? a.pos : a.pos + ((t - a.at) / dt) * (b.pos - a.pos);
      }
    }
    return last.pos;
  };

  /** Largest difference in commanded position across the whole span. */
  const motionDelta = (x, y) => {
    const end = Math.max(x[x.length - 1].at, y[y.length - 1].at);
    let worst = 0;
    for (let t = 0; t <= end; t += 5) worst = Math.max(worst, Math.abs(posAt(x, t) - posAt(y, t)));
    return worst;
  };

  const span = (acts) => acts[acts.length - 1].at - acts[0].at;

  // 0, 100, 0, 100, 0 — the ordinary shape of a stroking script, and the
  // shape both functions handled worst.
  const alternating = (n, step = 500) =>
    Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 100 : 0 }));

  describe('halfSpeed', () => {
    it('actually halves the number of movements', () => {
      const input = alternating(9);           // 8 movements
      const result = halfSpeed(input);
      expect(movements(input)).toBe(8);
      expect(movements(result)).toBeLessThanOrEqual(4);
      expect(movements(result)).toBeGreaterThan(0);
    });

    // THE REGRESSION. Keeping every even-indexed point looks reasonable
    // until you notice that on alternating content every even-indexed
    // point is the SAME end of the stroke. 0,100,0,100,0 became 0,0,0.
    it('never flattens an alternating script to a dead line', () => {
      for (const n of [4, 5, 6, 7, 8, 9, 12, 21]) {
        const result = halfSpeed(alternating(n));
        const positions = new Set(result.map(a => a.pos));
        expect(positions.size, `${n} points collapsed to one position`).toBeGreaterThan(1);
        expect(movements(result), `${n} points lost all movement`).toBeGreaterThan(0);
      }
    });

    it('keeps the script aligned to the video: same span, same endpoints', () => {
      const input = alternating(9);
      const result = halfSpeed(input);
      expect(result[0].at).toBe(input[0].at);
      expect(result[0].pos).toBe(input[0].pos);
      expect(span(result)).toBe(span(input));
      expect(result[result.length - 1].at).toBe(input[input.length - 1].at);
    });

    it('leaves scripts too short to thin out alone', () => {
      expect(halfSpeed([])).toEqual([]);
      expect(halfSpeed([{ at: 0, pos: 50 }])).toEqual([{ at: 0, pos: 50 }]);
      // A single one-way move cannot lose a movement and still be motion.
      const two = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
      expect(halfSpeed(two)).toEqual(two);
      const three = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }];
      expect(halfSpeed(three)).toEqual(three);
    });

    it('handles uneven timing without inventing points', () => {
      const input = [
        { at: 0, pos: 10 }, { at: 300, pos: 90 }, { at: 1100, pos: 20 },
        { at: 1400, pos: 80 }, { at: 2600, pos: 5 },
      ];
      const result = halfSpeed(input);
      expect(result.length).toBeLessThan(input.length);
      expect(movements(result)).toBeGreaterThan(0);
      // Every position it emits came from the original, nothing synthesised.
      const originals = new Set(input.map(a => a.pos));
      for (const a of result) expect(originals.has(a.pos)).toBe(true);
    });

    it('does not mutate input', () => {
      const copy = sampleActions.map(a => ({ ...a }));
      halfSpeed(copy);
      expect(copy).toEqual(sampleActions);
    });
  });

  describe('doubleSpeed', () => {
    // THE REGRESSION bel reported. The old version put each inserted point
    // at the average of its neighbours, which sits exactly on the line
    // between them, so the device performed an identical stroke. This
    // asserts on the interpolated output, which is the only thing that
    // could have caught it.
    it('changes the motion, not just the point count', () => {
      const input = alternating(5);
      const result = doubleSpeed(input);
      expect(result.length).toBeGreaterThan(input.length);
      expect(motionDelta(input, result)).toBeGreaterThan(20);
    });

    it('actually doubles the number of movements', () => {
      for (const n of [3, 5, 7, 9]) {
        const input = alternating(n);
        const result = doubleSpeed(input);
        expect(movements(result), `${n} points`).toBe(movements(input) * 2);
      }
    });

    it('keeps the script aligned to the video: same span, same endpoints', () => {
      for (const n of [3, 4, 5, 6, 9]) {
        const input = alternating(n);
        const result = doubleSpeed(input);
        expect(result[0]).toEqual(input[0]);
        expect(result[result.length - 1].at).toBe(input[input.length - 1].at);
        expect(result[result.length - 1].pos).toBe(input[input.length - 1].pos);
        expect(span(result)).toBe(span(input));
      }
    });

    it('emits strictly increasing, in-range points', () => {
      const input = [
        { at: 0, pos: 10 }, { at: 300, pos: 90 }, { at: 1100, pos: 20 },
        { at: 1400, pos: 80 }, { at: 2600, pos: 5 },
      ];
      const result = doubleSpeed(input);
      for (let i = 1; i < result.length; i++) {
        expect(result[i].at).toBeGreaterThan(result[i - 1].at);
      }
      for (const a of result) {
        expect(a.pos).toBeGreaterThanOrEqual(0);
        expect(a.pos).toBeLessThanOrEqual(100);
      }
    });

    it('leaves scripts with no full cycle alone', () => {
      expect(doubleSpeed([])).toEqual([]);
      expect(doubleSpeed([{ at: 0, pos: 50 }])).toEqual([{ at: 0, pos: 50 }]);
      // One-way move: repeating it would change where the stroke ends.
      const two = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
      expect(doubleSpeed(two)).toEqual(two);
    });

    it('survives zero-length and duplicated timestamps', () => {
      const degenerate = [
        { at: 0, pos: 0 }, { at: 0, pos: 100 }, { at: 0, pos: 0 }, { at: 500, pos: 100 },
      ];
      expect(() => doubleSpeed(degenerate)).not.toThrow();
      const result = doubleSpeed(degenerate);
      expect(result.length).toBeGreaterThanOrEqual(degenerate.length);
      for (const a of result) expect(Number.isFinite(a.at)).toBe(true);
    });

    it('does not mutate input', () => {
      const copy = sampleActions.map(a => ({ ...a }));
      doubleSpeed(copy);
      expect(copy).toEqual(sampleActions);
    });
  });

  describe('half and double are opposites', () => {
    it('double then half lands back near the original movement count', () => {
      const input = alternating(9);
      const round = halfSpeed(doubleSpeed(input));
      expect(movements(round)).toBeGreaterThanOrEqual(movements(input) - 2);
      expect(movements(round)).toBeLessThanOrEqual(movements(input) + 2);
      expect(span(round)).toBe(span(input));
    });

    it('neither ever produces a script the device cannot play', () => {
      const shapes = [alternating(4), alternating(5), alternating(12),
        [{ at: 0, pos: 50 }, { at: 100, pos: 50 }, { at: 200, pos: 50 }, { at: 300, pos: 50 }]];
      for (const input of shapes) {
        for (const fn of [halfSpeed, doubleSpeed]) {
          const out = fn(input);
          expect(out.length).toBeGreaterThan(0);
          for (const a of out) {
            expect(Number.isFinite(a.at)).toBe(true);
            expect(Number.isFinite(a.pos)).toBe(true);
          }
          for (let i = 1; i < out.length; i++) {
            expect(out[i].at).toBeGreaterThanOrEqual(out[i - 1].at);
          }
        }
      }
    });
  });

  describe('remapRange', () => {
    it('returns empty for empty input', () => {
      expect(remapRange([], 0, 100)).toEqual([]);
    });

    it('remaps positions to new range', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 50 },
        { at: 2000, pos: 100 },
      ];
      const result = remapRange(actions, 20, 80);
      expect(result[0].pos).toBe(20);
      expect(result[1].pos).toBe(50); // midpoint stays midpoint
      expect(result[2].pos).toBe(80);
    });

    it('preserves timestamps', () => {
      const actions = [{ at: 500, pos: 25 }, { at: 1500, pos: 75 }];
      const result = remapRange(actions, 0, 100);
      expect(result[0].at).toBe(500);
      expect(result[1].at).toBe(1500);
    });

    it('clamps positions to 0-100', () => {
      const actions = [{ at: 0, pos: 50 }];
      const result = remapRange(actions, -10, 110);
      // Single action with pos=50 and same min/max → normalized to 0.5
      expect(result[0].pos).toBeGreaterThanOrEqual(0);
      expect(result[0].pos).toBeLessThanOrEqual(100);
    });

    it('handles single action (all same position)', () => {
      const actions = [{ at: 0, pos: 50 }];
      const result = remapRange(actions, 30, 70);
      // When oldRange is 0, normalized = 0.5
      expect(result[0].pos).toBe(50); // 30 + 0.5 * 40 = 50
    });

    it('does not mutate input', () => {
      const copy = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
      remapRange(copy, 20, 80);
      expect(copy[0].pos).toBe(0);
    });
  });

  describe('offsetTime', () => {
    it('shifts timestamps forward', () => {
      const actions = [{ at: 1000, pos: 50 }, { at: 2000, pos: 75 }];
      const result = offsetTime(actions, 500);
      expect(result[0].at).toBe(1500);
      expect(result[1].at).toBe(2500);
    });

    it('shifts timestamps backward, clamped to 0', () => {
      const actions = [{ at: 500, pos: 50 }, { at: 2000, pos: 75 }];
      const result = offsetTime(actions, -1000);
      expect(result[0].at).toBe(0); // 500 - 1000 → clamped to 0
      expect(result[1].at).toBe(1000);
    });

    it('preserves positions', () => {
      const actions = [{ at: 1000, pos: 33 }];
      const result = offsetTime(actions, 500);
      expect(result[0].pos).toBe(33);
    });

    it('does not mutate input', () => {
      const copy = [{ at: 1000, pos: 50 }];
      offsetTime(copy, 500);
      expect(copy[0].at).toBe(1000);
    });

    it('returns empty for empty input', () => {
      expect(offsetTime([], 1000)).toEqual([]);
    });
  });

  describe('removePauses', () => {
    it('returns copy for 0-1 actions', () => {
      expect(removePauses([], 1000)).toEqual([]);
      expect(removePauses([{ at: 0, pos: 50 }], 1000)).toEqual([{ at: 0, pos: 50 }]);
    });

    it('returns copy when no gaps exceed threshold', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 500, pos: 50 },
        { at: 1000, pos: 100 },
      ];
      const result = removePauses(actions, 1000);
      expect(result).toEqual(actions);
    });

    it('collapses gaps exceeding threshold', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
        // 9000ms gap
        { at: 10000, pos: 0 },
        { at: 11000, pos: 100 },
      ];
      const result = removePauses(actions, 2000);
      // The gap should be compressed
      expect(result.length).toBe(4);
      expect(result[2].at - result[1].at).toBeLessThanOrEqual(2000);
    });

    it('preserves internal timing within clusters', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 500, pos: 50 },
        { at: 1000, pos: 100 },
        // Big gap
        { at: 50000, pos: 0 },
        { at: 50500, pos: 50 },
      ];
      const result = removePauses(actions, 2000);
      // Internal spacing within second cluster should be preserved
      const cluster2Start = result[3].at;
      expect(result[4].at - cluster2Start).toBe(500);
    });

    it('does not mutate input', () => {
      const copy = [{ at: 0, pos: 0 }, { at: 10000, pos: 100 }];
      removePauses(copy, 1000);
      expect(copy[1].at).toBe(10000);
    });
  });

  describe('reverseActions', () => {
    it('returns empty for empty input', () => {
      expect(reverseActions([])).toEqual([]);
    });

    it('reverses timeline and mirrors positions', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
        { at: 2000, pos: 50 },
      ];
      const result = reverseActions(actions);
      expect(result.length).toBe(3);
      // Reversed: last becomes first, positions mirrored
      expect(result[0]).toEqual({ at: 0, pos: 50 });    // was at:2000, pos:50 → 100-50=50
      expect(result[1]).toEqual({ at: 1000, pos: 0 });   // was at:1000, pos:100 → 100-100=0
      expect(result[2]).toEqual({ at: 2000, pos: 100 }); // was at:0, pos:0 → 100-0=100
    });

    it('preserves duration', () => {
      const actions = [
        { at: 1000, pos: 25 },
        { at: 3000, pos: 75 },
      ];
      const result = reverseActions(actions);
      const originalDuration = actions[actions.length - 1].at - actions[0].at;
      const resultDuration = result[result.length - 1].at - result[0].at;
      expect(resultDuration).toBe(originalDuration);
    });

    it('is its own inverse (applying twice returns original)', () => {
      const actions = [
        { at: 0, pos: 10 },
        { at: 1000, pos: 90 },
        { at: 2000, pos: 30 },
      ];
      const result = reverseActions(reverseActions(actions));
      expect(result).toEqual(actions);
    });

    it('does not mutate input', () => {
      const copy = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
      reverseActions(copy);
      expect(copy[0].pos).toBe(0);
    });
  });

  describe('generatePattern', () => {
    it('returns empty for invalid params', () => {
      expect(generatePattern('sine', 1000, 500, 60)).toEqual([]); // end < start
      expect(generatePattern('sine', 0, 1000, 0)).toEqual([]);    // bpm = 0
      expect(generatePattern('sine', 0, 1000, -10)).toEqual([]);   // bpm < 0
    });

    it('generates sine pattern within time range', () => {
      const result = generatePattern('sine', 0, 2000, 60, 0, 100);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].at).toBe(0);
      expect(result[result.length - 1].at).toBeLessThanOrEqual(2000);
      // All positions should be within min/max
      for (const a of result) {
        expect(a.pos).toBeGreaterThanOrEqual(0);
        expect(a.pos).toBeLessThanOrEqual(100);
      }
    });

    it('generates sawtooth pattern', () => {
      const result = generatePattern('sawtooth', 0, 2000, 60, 10, 90);
      expect(result.length).toBeGreaterThan(0);
      for (const a of result) {
        expect(a.pos).toBeGreaterThanOrEqual(10);
        expect(a.pos).toBeLessThanOrEqual(90);
      }
    });

    it('generates square pattern', () => {
      const result = generatePattern('square', 0, 2000, 60, 0, 100);
      expect(result.length).toBeGreaterThan(0);
      // Square wave should only have min and max positions
      for (const a of result) {
        expect([0, 100]).toContain(a.pos);
      }
    });

    // The shape tests below exist because the two above do not test the shape
    // (Dave, 2026-08-21). "Only min and max positions" is just as true of a
    // TRIANGLE wave — its corners are min and max — and the sawtooth test only
    // checks bounds. Both passed for months while `_dedupeByTime` deleted the
    // point that ended each flat hold, leaving square as a triangle and
    // sawtooth as a near-flat line, in the gap filler and the editor alike.
    const sampleWave = (actions, from, to, n = 400) => {
      const at = (t) => {
        let i = 0;
        while (i + 1 < actions.length && actions[i + 1].at <= t) i++;
        const a = actions[i];
        const b = actions[Math.min(i + 1, actions.length - 1)];
        if (!b || b.at === a.at) return a.pos;
        return a.pos + ((t - a.at) / (b.at - a.at)) * (b.pos - a.pos);
      };
      return Array.from({ length: n }, (_, i) => at(from + (i / (n - 1)) * (to - from)));
    };

    it('square HOLDS at each level rather than ramping between them', () => {
      const result = generatePattern('square', 0, 8000, 25, 0, 100);
      const vals = sampleWave(result, 0, 8000);
      const atRail = vals.filter((v) => v <= 2 || v >= 98).length / vals.length;
      // A square spends nearly all its time at one rail or the other. The
      // triangle this used to produce spends nearly none.
      expect(atRail).toBeGreaterThan(0.9);
    });

    it('square keeps a flat hold in its action list', () => {
      // Two consecutive points at the same position and different times IS
      // the hold. Deleting one of them is what broke the shape.
      const result = generatePattern('square', 0, 8000, 25, 0, 100);
      const holds = result.filter((a, i) => i > 0 && result[i - 1].pos === a.pos && a.at > result[i - 1].at);
      expect(holds.length).toBeGreaterThan(2);
    });

    it('square alternates rails instead of sitting on one', () => {
      const result = generatePattern('square', 0, 8000, 25, 0, 100);
      const levels = [...new Set(result.map((a) => a.pos))].sort((a, b) => a - b);
      expect(levels).toEqual([0, 100]);
      const flips = result.filter((a, i) => i > 0 && result[i - 1].pos !== a.pos).length;
      expect(flips).toBeGreaterThan(2);
    });

    it('sawtooth ramps one way and resets sharply', () => {
      const result = generatePattern('sawtooth', 0, 8000, 25, 0, 100);
      const vals = sampleWave(result, 0, 8000);
      const deltas = vals.slice(1).map((v, i) => v - vals[i]);
      const rises = deltas.filter((d) => d > 0);
      const drops = deltas.filter((d) => d < 0);
      // Many small rises, few big drops — that asymmetry IS the sawtooth.
      expect(rises.length).toBeGreaterThan(drops.length * 5);
      expect(Math.abs(Math.min(...deltas))).toBeGreaterThan(Math.max(...rises) * 5);
    });

    it('sawtooth actually travels the full range each cycle', () => {
      // The broken version emitted min, min, min... and only reached max once,
      // at the very end: a flat line that moved no device.
      const result = generatePattern('sawtooth', 0, 8000, 25, 0, 100);
      const vals = sampleWave(result, 0, 8000);
      expect(Math.max(...vals)).toBeGreaterThan(95);
      expect(Math.min(...vals)).toBeLessThan(5);
      const reachedTop = result.filter((a) => a.pos >= 95).length;
      expect(reachedTop).toBeGreaterThan(2);
    });

    it('no two actions share a timestamp', () => {
      // Step edges are EDGE_MS wide rather than stacked on one instant, so a
      // generated pattern is safe to save and to interpolate.
      for (const type of ['sine', 'sawtooth', 'square', 'triangle', 'escalating', 'random']) {
        const result = generatePattern(type, 0, 8000, 25, 0, 100);
        const times = result.map((a) => a.at);
        expect(new Set(times).size, type).toBe(times.length);
      }
    });

    it('every pattern moves — none is a flat line', () => {
      for (const type of ['sine', 'sawtooth', 'square', 'triangle', 'escalating', 'random']) {
        const result = generatePattern(type, 0, 8000, 25, 0, 100);
        const positions = result.map((a) => a.pos);
        expect(Math.max(...positions) - Math.min(...positions), type).toBeGreaterThan(50);
      }
    });

    it('generates triangle pattern', () => {
      const result = generatePattern('triangle', 0, 2000, 60, 0, 100);
      expect(result.length).toBeGreaterThan(0);
    });

    it('generates escalating pattern', () => {
      const result = generatePattern('escalating', 0, 4000, 60, 0, 100);
      expect(result.length).toBeGreaterThan(0);
      // Escalating should have increasing peak values
    });

    it('generates random pattern', () => {
      const result = generatePattern('random', 0, 2000, 120, 20, 80);
      expect(result.length).toBeGreaterThan(0);
      for (const a of result) {
        expect(a.pos).toBeGreaterThanOrEqual(20);
        expect(a.pos).toBeLessThanOrEqual(80);
      }
    });

    it('respects min/max position constraints', () => {
      const result = generatePattern('sine', 0, 5000, 120, 25, 75);
      for (const a of result) {
        expect(a.pos).toBeGreaterThanOrEqual(25);
        expect(a.pos).toBeLessThanOrEqual(75);
      }
    });

    it('caps density at ~20 points/sec for high BPM', () => {
      // Very high BPM shouldn't produce more than 20 pts/sec
      const result = generatePattern('sine', 0, 1000, 600, 0, 100);
      expect(result.length).toBeLessThanOrEqual(25); // ~20/sec + some tolerance
    });

    it('defaults unknown pattern type to sine', () => {
      const result = generatePattern('unknown_pattern', 0, 1000, 60, 0, 100);
      expect(result.length).toBeGreaterThan(0);
    });

    it('uses default min=0, max=100', () => {
      const result = generatePattern('sine', 0, 2000, 60);
      expect(result.length).toBeGreaterThan(0);
      for (const a of result) {
        expect(a.pos).toBeGreaterThanOrEqual(0);
        expect(a.pos).toBeLessThanOrEqual(100);
      }
    });

    it('handles offset start time', () => {
      const result = generatePattern('sine', 5000, 7000, 60, 0, 100);
      expect(result[0].at).toBe(5000);
      expect(result[result.length - 1].at).toBeLessThanOrEqual(7000);
    });
  });
});
