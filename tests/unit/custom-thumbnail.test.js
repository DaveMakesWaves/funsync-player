// Custom-thumbnail seek-% resolution (#180a "pick a frame").
//
// resolveThumbSeekPct decides which frame the library tile grabs: the
// user's pinned frame when set, else the default 10% mark. Clamped to a
// safe 0..1 range so a bad stored value can't ask ffmpeg for a negative
// or past-end seek.

import { describe, it, expect } from 'vitest';
import { resolveThumbSeekPct, thumbRequestOpts, customThumbImagePath } from '../../renderer/components/library.js';

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

// thumbRequestOpts builds the backend request: a user-picked frame must
// request `exact: true` (frame-accurate grab matching the picker's WYSIWYG
// preview) while auto thumbs keep the cheap keyframe fast path. This was
// the "selected frame isn't the thumbnail" bug — the backend's default
// path snaps to the nearest keyframe AND clamps seeks to ≥10s, so the
// generated tile silently differed from the picked frame.
describe('thumbRequestOpts', () => {
  it('requests an exact grab when a frame is pinned', () => {
    expect(thumbRequestOpts({ seekPct: 0.42 })).toEqual({ seekPct: 0.42, exact: true });
    // A pick at the very start (inside the backend's 10s clamp window)
    // still goes through exact so the clamp can't override it.
    expect(thumbRequestOpts({ seekPct: 0 })).toEqual({ seekPct: 0, exact: true });
  });

  it('keeps the fast default path when there is no override', () => {
    expect(thumbRequestOpts(undefined)).toEqual({ seekPct: 0.1, exact: false });
    expect(thumbRequestOpts(null)).toEqual({ seekPct: 0.1, exact: false });
    expect(thumbRequestOpts({})).toEqual({ seekPct: 0.1, exact: false });
  });

  it('treats invalid stored values as no override (fast path)', () => {
    expect(thumbRequestOpts({ seekPct: NaN })).toEqual({ seekPct: 0.1, exact: false });
    expect(thumbRequestOpts({ seekPct: '0.5' })).toEqual({ seekPct: 0.1, exact: false });
  });

  it('clamps a pinned value but stays exact', () => {
    expect(thumbRequestOpts({ seekPct: 5 })).toEqual({ seekPct: 0.999, exact: true });
  });

  it('image-type entries have no frame pin — fast default path as fallback', () => {
    // If the uploaded image file goes missing, the capture path falls
    // through to the frame logic; an image entry must then behave like
    // "no override" (auto 10% frame), not an exact grab.
    expect(thumbRequestOpts({ type: 'image', imagePath: 'C:/x/thumb.jpg' }))
      .toEqual({ seekPct: 0.1, exact: false });
  });
});

// customThumbImagePath resolves the user-uploaded poster (Option B,
// community #217). `{ type: 'image', imagePath }` wins outright in every
// thumb surface; frame pins and legacy `{ seekPct }` entries return null
// here and are handled by thumbRequestOpts.
describe('customThumbImagePath', () => {
  it('returns the cached image path for image-type entries', () => {
    expect(customThumbImagePath({ type: 'image', imagePath: '/data/custom-thumbs/ab.jpg' }))
      .toBe('/data/custom-thumbs/ab.jpg');
  });

  it('returns null for frame pins, legacy entries, and no override', () => {
    expect(customThumbImagePath({ seekPct: 0.4 })).toBeNull();
    expect(customThumbImagePath({ type: 'frame', seekPct: 0.4 })).toBeNull();
    expect(customThumbImagePath(undefined)).toBeNull();
    expect(customThumbImagePath(null)).toBeNull();
    expect(customThumbImagePath({})).toBeNull();
  });

  it('rejects malformed image entries (missing/empty/non-string path)', () => {
    expect(customThumbImagePath({ type: 'image' })).toBeNull();
    expect(customThumbImagePath({ type: 'image', imagePath: '' })).toBeNull();
    expect(customThumbImagePath({ type: 'image', imagePath: 42 })).toBeNull();
  });
});
