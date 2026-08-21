// Virtual-scroll column count must come from the RENDERED grid, not a
// duplicate of the CSS formula.
//
// Bug, 2026-08-18 (Sylvain-Et-Un, EroScripts #300): at ~7% of window widths
// the JS estimate `floor((clientWidth - 32) / 236)` computed one column FEWER
// than the CSS `repeat(auto-fill, minmax(220px, 1fr))` actually packed —
// auto-fill gets the column gap back for the last track, the formula doesn't
// (mismatch band: `(clientWidth - 32) mod 236 >= 220`). Every virtual row
// boundary was then wrong: content height collapsed when the range re-rendered
// at the bottom, the browser clamped scrollTop, the spacers re-grew the height
// — "the last row flickers in and out and scrolling snaps back to the last
// complete row", with the final partial row unreachable.
//
// Fix: `_measureGridColumns` reads the grid's RESOLVED `gridTemplateColumns`
// tracks (Chromium resolves auto-fill from container width even on an empty
// grid — verified in a live repro) and only falls back to the formula when
// the computed value is unresolved ('none', empty, or still a `repeat()`
// string — which is what jsdom returns, so these tests pin both branches).
//
// These tests drive `_measureGridColumns` directly off the prototype: the
// invariant is "resolved tracks win; the formula is only a fallback".

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const measure = (grid, wrapper) =>
  Library.prototype._measureGridColumns.call(null, grid, wrapper);

const fakeGrid = {};
const wrapperOfWidth = (clientWidth) => ({ clientWidth });

function mockComputedTracks(value) {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ gridTemplateColumns: value });
}

afterEach(() => vi.restoreAllMocks());

describe('Library._measureGridColumns — resolved tracks win', () => {
  it('counts resolved pixel tracks', () => {
    mockComputedTracks('224px 224px 224px 224px 224px');
    expect(measure(fakeGrid, wrapperOfWidth(1201))).toBe(5);
  });

  it('THE BUG: resolved count wins over the formula in the mismatch band', () => {
    // clientWidth 1201 → formula floor(1169/236) = 4, but CSS packs 5.
    mockComputedTracks('224px 224px 224px 224px 224px');
    const formula = Math.floor((1201 - 32) / 236);
    expect(formula).toBe(4); // documents the disagreement this fixes
    expect(measure(fakeGrid, wrapperOfWidth(1201))).toBe(5);
  });
});

describe('Library._measureGridColumns — fallback branches', () => {
  it("falls back to the formula when computed is 'none' (hidden grid)", () => {
    mockComputedTracks('none');
    expect(measure(fakeGrid, wrapperOfWidth(1000))).toBe(4);
  });

  it('falls back when computed is empty', () => {
    mockComputedTracks('');
    expect(measure(fakeGrid, wrapperOfWidth(1000))).toBe(4);
  });

  it('falls back when the value is an unresolved repeat() (jsdom)', () => {
    mockComputedTracks('repeat(auto-fill, minmax(220px, 1fr))');
    expect(measure(fakeGrid, wrapperOfWidth(1000))).toBe(4);
  });

  it('falls back when getComputedStyle throws', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => { throw new Error('detached'); });
    expect(measure(fakeGrid, wrapperOfWidth(1000))).toBe(4);
  });

  it('formula fallback never returns less than 1 column', () => {
    mockComputedTracks('none');
    expect(measure(fakeGrid, wrapperOfWidth(100))).toBe(1);
  });
});
