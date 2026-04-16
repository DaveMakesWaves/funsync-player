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

  describe('halfSpeed', () => {
    it('returns copy for 0-2 actions', () => {
      expect(halfSpeed([])).toEqual([]);
      expect(halfSpeed([{ at: 0, pos: 50 }])).toEqual([{ at: 0, pos: 50 }]);
      expect(halfSpeed([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }])).toEqual([
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
      ]);
    });

    it('keeps every other action plus first and last', () => {
      const result = halfSpeed(sampleActions);
      expect(result.length).toBeLessThan(sampleActions.length);
      expect(result[0]).toEqual(sampleActions[0]);
      expect(result[result.length - 1]).toEqual(sampleActions[sampleActions.length - 1]);
    });

    it('preserves first and last', () => {
      const result = halfSpeed(sampleActions);
      expect(result[0].at).toBe(0);
      expect(result[result.length - 1].at).toBe(4000);
    });

    it('does not mutate input', () => {
      const copy = sampleActions.map(a => ({ ...a }));
      halfSpeed(copy);
      expect(copy).toEqual(sampleActions);
    });

    it('keeps even-indexed actions plus first and last', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 10 },
        { at: 2000, pos: 20 },
        { at: 3000, pos: 30 },
        { at: 4000, pos: 40 },
        { at: 5000, pos: 50 },
        { at: 6000, pos: 60 },
      ];
      const result = halfSpeed(actions);
      // Indices 0, 2, 4, 6 kept (even), plus last (6 is already even)
      expect(result.map(a => a.at)).toEqual([0, 2000, 4000, 6000]);
    });
  });

  describe('doubleSpeed', () => {
    it('returns copy for 0-1 actions', () => {
      expect(doubleSpeed([])).toEqual([]);
      expect(doubleSpeed([{ at: 0, pos: 50 }])).toEqual([{ at: 0, pos: 50 }]);
    });

    it('inserts midpoints between each pair', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
      ];
      const result = doubleSpeed(actions);
      expect(result.length).toBe(3);
      expect(result[0]).toEqual({ at: 0, pos: 0 });
      expect(result[1]).toEqual({ at: 500, pos: 50 });
      expect(result[2]).toEqual({ at: 1000, pos: 100 });
    });

    it('roughly doubles the action count', () => {
      const result = doubleSpeed(sampleActions);
      expect(result.length).toBe(sampleActions.length * 2 - 1);
    });

    it('does not mutate input', () => {
      const copy = sampleActions.map(a => ({ ...a }));
      doubleSpeed(copy);
      expect(copy).toEqual(sampleActions);
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
