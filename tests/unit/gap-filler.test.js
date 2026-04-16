import { describe, it, expect } from 'vitest';
import { detectGaps, fillGap, fillGaps } from '../../renderer/js/gap-filler.js';

describe('gap-filler', () => {
  describe('detectGaps', () => {
    it('returns empty for empty actions', () => {
      expect(detectGaps([], 1000)).toEqual([]);
    });

    it('returns empty for null actions', () => {
      expect(detectGaps(null, 1000)).toEqual([]);
    });

    it('returns empty when no gaps exceed threshold', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 500, pos: 50 },
        { at: 1000, pos: 100 },
      ];
      expect(detectGaps(actions, 2000)).toEqual([]);
    });

    it('detects a single gap', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
        { at: 10000, pos: 0 },
        { at: 11000, pos: 100 },
      ];
      const gaps = detectGaps(actions, 2000);
      expect(gaps.length).toBe(1);
      expect(gaps[0]).toEqual({ startMs: 1000, endMs: 10000, durationMs: 9000 });
    });

    it('detects multiple gaps', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
        // gap 1: 1000 to 10000
        { at: 10000, pos: 0 },
        { at: 11000, pos: 100 },
        // gap 2: 11000 to 30000
        { at: 30000, pos: 50 },
      ];
      const gaps = detectGaps(actions, 5000);
      expect(gaps.length).toBe(2);
      expect(gaps[0].startMs).toBe(1000);
      expect(gaps[1].startMs).toBe(11000);
    });

    it('detects trailing gap when totalDurationMs provided', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
      ];
      const gaps = detectGaps(actions, 5000, 60000);
      expect(gaps.length).toBe(1);
      expect(gaps[0]).toEqual({ startMs: 1000, endMs: 60000, durationMs: 59000 });
    });

    it('detects gap for single action with totalDurationMs', () => {
      const actions = [{ at: 0, pos: 50 }];
      const gaps = detectGaps(actions, 1000, 10000);
      expect(gaps.length).toBe(1);
      expect(gaps[0].durationMs).toBe(10000);
    });

    it('does not detect trailing gap when it is smaller than threshold', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 9500, pos: 100 },
      ];
      const gaps = detectGaps(actions, 1000, 10000);
      // Internal gap: 9500ms > 1000 → detected
      // Trailing: 10000 - 9500 = 500ms < 1000 → not detected
      expect(gaps.length).toBe(1);
      expect(gaps[0].startMs).toBe(0);
    });

    it('returns gap for empty actions with totalDurationMs', () => {
      const gaps = detectGaps([], 1000, 30000);
      expect(gaps.length).toBe(1);
      expect(gaps[0]).toEqual({ startMs: 0, endMs: 30000, durationMs: 30000 });
    });

    it('handles exact threshold gap', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 5000, pos: 100 },
      ];
      const gaps = detectGaps(actions, 5000);
      expect(gaps.length).toBe(1);
      expect(gaps[0].durationMs).toBe(5000);
    });
  });

  describe('fillGap', () => {
    it('returns generated actions for a gap', () => {
      const result = fillGap(1000, 5000, 'sine', 60, 0, 100);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].at).toBe(1000);
      expect(result[result.length - 1].at).toBeLessThanOrEqual(5000);
    });

    it('respects min/max positions', () => {
      const result = fillGap(0, 3000, 'sawtooth', 60, 20, 80);
      for (const a of result) {
        expect(a.pos).toBeGreaterThanOrEqual(20);
        expect(a.pos).toBeLessThanOrEqual(80);
      }
    });

    it('returns empty for zero-length gap', () => {
      const result = fillGap(1000, 1000, 'sine', 60);
      expect(result).toEqual([]);
    });

    it('returns empty for invalid bpm', () => {
      expect(fillGap(0, 5000, 'sine', 0)).toEqual([]);
      expect(fillGap(0, 5000, 'sine', -1)).toEqual([]);
    });
  });

  describe('fillGaps', () => {
    it('fills multiple gaps', () => {
      const gaps = [
        { startMs: 1000, endMs: 3000 },
        { startMs: 8000, endMs: 10000 },
      ];
      const result = fillGaps(gaps, 'sine', 120, 0, 100);
      expect(result.length).toBeGreaterThan(0);
      // Should have actions in both ranges
      const firstRange = result.filter(a => a.at >= 1000 && a.at <= 3000);
      const secondRange = result.filter(a => a.at >= 8000 && a.at <= 10000);
      expect(firstRange.length).toBeGreaterThan(0);
      expect(secondRange.length).toBeGreaterThan(0);
    });

    it('returns sorted actions', () => {
      const gaps = [
        { startMs: 8000, endMs: 10000 },
        { startMs: 1000, endMs: 3000 },
      ];
      const result = fillGaps(gaps, 'triangle', 60, 0, 100);
      for (let i = 1; i < result.length; i++) {
        expect(result[i].at).toBeGreaterThanOrEqual(result[i - 1].at);
      }
    });

    it('returns empty for empty gaps array', () => {
      expect(fillGaps([], 'sine', 60)).toEqual([]);
    });
  });
});
