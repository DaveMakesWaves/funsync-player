/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Tests for the funscript-metadata time-parse helper.
// SCOPE: notes/features/SCOPE-chapters-bookmarks.md §6 edge-case matrix.

import { describe, it, expect } from 'vitest';
import { parseFunscriptTime } from '../../renderer/js/funscript-time.js';

describe('parseFunscriptTime — number passthrough', () => {
  it('returns finite non-negative numbers as-is (rounded)', () => {
    expect(parseFunscriptTime(0)).toBe(0);
    expect(parseFunscriptTime(12345)).toBe(12345);
    expect(parseFunscriptTime(12345.7)).toBe(12346);
  });

  it('returns null for negative numbers', () => {
    expect(parseFunscriptTime(-1)).toBe(null);
    expect(parseFunscriptTime(-12345)).toBe(null);
  });

  it('returns null for NaN / Infinity', () => {
    expect(parseFunscriptTime(NaN)).toBe(null);
    expect(parseFunscriptTime(Infinity)).toBe(null);
    expect(parseFunscriptTime(-Infinity)).toBe(null);
  });
});

describe('parseFunscriptTime — TimeSpan strings', () => {
  it('parses HH:MM:SS.mmm', () => {
    expect(parseFunscriptTime('00:00:42.500')).toBe(42500);
    expect(parseFunscriptTime('01:23:45.678')).toBe(1 * 3600000 + 23 * 60000 + 45 * 1000 + 678);
  });

  it('parses HH:MM:SS without fractional', () => {
    expect(parseFunscriptTime('00:00:42')).toBe(42000);
    expect(parseFunscriptTime('01:00:00')).toBe(3600000);
  });

  it('parses MM:SS.mmm (no hours)', () => {
    expect(parseFunscriptTime('42:30.250')).toBe(42 * 60000 + 30 * 1000 + 250);
  });

  it('parses MM:SS without fractional', () => {
    expect(parseFunscriptTime('0:42')).toBe(42000);
    expect(parseFunscriptTime('5:30')).toBe(330000);
  });

  it('pads short fractional to milliseconds', () => {
    // ".5" should be 500ms, not 5ms
    expect(parseFunscriptTime('0:00:00.5')).toBe(500);
    expect(parseFunscriptTime('0:00:00.50')).toBe(500);
    expect(parseFunscriptTime('0:00:00.500')).toBe(500);
  });

  it('truncates long fractional past 3 digits', () => {
    // ".500999" → 500ms (round-down truncation)
    expect(parseFunscriptTime('0:00:00.500999')).toBe(500);
  });

  it('strips leading/trailing whitespace', () => {
    expect(parseFunscriptTime('  00:00:42.500  ')).toBe(42500);
  });
});

describe('parseFunscriptTime — string-encoded numbers', () => {
  it('coerces digit-only strings', () => {
    expect(parseFunscriptTime('12345')).toBe(12345);
    expect(parseFunscriptTime('0')).toBe(0);
  });

  it('coerces decimal-only strings (rounded)', () => {
    expect(parseFunscriptTime('12345.6')).toBe(12346);
  });

  it('returns null for negative digit strings', () => {
    expect(parseFunscriptTime('-1')).toBe(null);
  });

  it('returns null for non-numeric, non-time strings', () => {
    expect(parseFunscriptTime('hello')).toBe(null);
    expect(parseFunscriptTime('not-a-time')).toBe(null);
    expect(parseFunscriptTime('12:abc')).toBe(null);
  });
});

describe('parseFunscriptTime — malformed input', () => {
  it('returns null for empty / whitespace strings', () => {
    expect(parseFunscriptTime('')).toBe(null);
    expect(parseFunscriptTime('   ')).toBe(null);
  });

  it('returns null for null / undefined', () => {
    expect(parseFunscriptTime(null)).toBe(null);
    expect(parseFunscriptTime(undefined)).toBe(null);
  });

  it('returns null for non-string non-number types', () => {
    expect(parseFunscriptTime({})).toBe(null);
    expect(parseFunscriptTime([])).toBe(null);
    expect(parseFunscriptTime(true)).toBe(null);
  });

  it('returns null for malformed time strings (out-of-range seconds/minutes)', () => {
    expect(parseFunscriptTime('0:0:90')).toBe(null);  // 90 seconds
    expect(parseFunscriptTime('0:90:0')).toBe(null);  // 90 minutes
    expect(parseFunscriptTime('25:60:00')).toBe(null);
  });
});
