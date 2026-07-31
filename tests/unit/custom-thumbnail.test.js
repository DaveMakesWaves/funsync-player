// Custom-thumbnail seek-% resolution (#180a "pick a frame").
//
// resolveThumbSeekPct decides which frame the library tile grabs: the
// user's pinned frame when set, else the default 10% mark. Clamped to a
// safe 0..1 range so a bad stored value can't ask ffmpeg for a negative
// or past-end seek.

import { describe, it, expect } from 'vitest';
import { resolveThumbSeekPct } from '../../renderer/components/library.js';

describe('resolveThumbSeekPct', () => {
  it('defaults to the 10% mark when there is no override', () => {
    expect(resolveThumbSeekPct(undefined)).toBe(0.1);
    expect(resolveThumbSeekPct(null)).toBe(0.1);
    expect(resolveThumbSeekPct({})).toBe(0.1);
  });

  it('uses the pinned seekPct when set', () => {
    expect(resolveThumbSeekPct({ seekPct: 0.42 })).toBe(0.42);
    expect(resolveThumbSeekPct({ seekPct: 0 })).toBe(0);
  });

  it('clamps out-of-range values into 0..0.999', () => {
    expect(resolveThumbSeekPct({ seekPct: -0.5 })).toBe(0);
    expect(resolveThumbSeekPct({ seekPct: 1 })).toBe(0.999);
    expect(resolveThumbSeekPct({ seekPct: 5 })).toBe(0.999);
  });

  it('ignores non-finite / non-number values and falls back to default', () => {
    expect(resolveThumbSeekPct({ seekPct: NaN })).toBe(0.1);
    expect(resolveThumbSeekPct({ seekPct: Infinity })).toBe(0.1);
    expect(resolveThumbSeekPct({ seekPct: '0.5' })).toBe(0.1);
  });
});
