/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Scroll-load policy — community #198 (Hikikomori): the app hangs when
// scrolling fast on a large library spanning several drives, and Dave's report
// that scrolling is janky with thumbnails not loaded.
//
// The three rules these pin, each targeting a distinct half of the report:
//   1. A SLOW continuous scroll must still load. The old binary "are we
//      scrolling" flag plus a 150ms settle timer meant a trackpad drag reset
//      the timer forever and nothing loaded until a full stop.
//   2. Load nearest the viewport centre first, not in DOM order — the overscan
//      rows above the viewport were being served before the visible row.
//   3. Work gets chunked rather than dumped in one synchronous burst.
import { describe, it, expect } from 'vitest';
import {
  shouldDeferLoads,
  smoothVelocity,
  prioritiseByDistance,
  chunk,
  SLOW_SCROLL_PX_PER_FRAME,
  SLOT_STALL_MS,
} from '../../renderer/js/scroll-load-policy.js';

describe('shouldDeferLoads', () => {
  it('does NOT defer a slow scroll — the reported "nothing loads" case', () => {
    expect(shouldDeferLoads(0)).toBe(false);
    expect(shouldDeferLoads(5)).toBe(false);
    expect(shouldDeferLoads(SLOW_SCROLL_PX_PER_FRAME - 1)).toBe(false);
  });

  it('defers a fling', () => {
    expect(shouldDeferLoads(SLOW_SCROLL_PX_PER_FRAME)).toBe(true);
    expect(shouldDeferLoads(400)).toBe(true);
  });

  it('is direction-agnostic — scrolling up floods just as easily', () => {
    expect(shouldDeferLoads(-400)).toBe(true);
    expect(shouldDeferLoads(-5)).toBe(false);
  });

  it('treats junk input as stationary rather than as a fling', () => {
    expect(shouldDeferLoads(NaN)).toBe(false);
    expect(shouldDeferLoads(undefined)).toBe(false);
  });
});

describe('smoothVelocity', () => {
  it('weights the newest sample so a stop is noticed quickly', () => {
    // One stationary frame after a fling should already read as slow-ish.
    const afterStop = smoothVelocity(100, 0);
    expect(afterStop).toBeLessThan(100);
    expect(smoothVelocity(afterStop, 0)).toBeLessThan(afterStop);
  });

  it('does not let a single dropped frame read as a fling', () => {
    // Steady slow drag with one jumpy frame.
    let v = 0;
    for (const s of [8, 8, 8, 60, 8]) v = smoothVelocity(v, s);
    expect(shouldDeferLoads(v)).toBe(false);
  });

  it('converges upward on a sustained fling', () => {
    let v = 0;
    for (let i = 0; i < 5; i += 1) v = smoothVelocity(v, 200);
    expect(shouldDeferLoads(v)).toBe(true);
  });

  it('survives non-finite input', () => {
    expect(Number.isFinite(smoothVelocity(undefined, NaN))).toBe(true);
  });
});

describe('prioritiseByDistance', () => {
  it('serves the viewport centre before the overscan rows', () => {
    const items = [
      { id: 'above', top: 0 },
      { id: 'centre', top: 1000 },
      { id: 'below', top: 1800 },
    ];
    const order = prioritiseByDistance(items, 1000).map((i) => i.id);
    expect(order[0]).toBe('centre');
  });

  it('treats above and below the centre alike at equal distance', () => {
    const items = [{ id: 'a', top: 900 }, { id: 'b', top: 1100 }];
    const order = prioritiseByDistance(items, 1000).map((i) => i.id);
    // Equal distance → stable, so DOM order decides.
    expect(order).toEqual(['a', 'b']);
  });

  it('is stable for ties so cards in a row keep DOM order', () => {
    const items = [
      { id: 'r1c1', top: 500 }, { id: 'r1c2', top: 500 }, { id: 'r1c3', top: 500 },
    ];
    expect(prioritiseByDistance(items, 500).map((i) => i.id))
      .toEqual(['r1c1', 'r1c2', 'r1c3']);
  });

  it('does not mutate the input', () => {
    const items = [{ id: 'a', top: 900 }, { id: 'b', top: 100 }];
    prioritiseByDistance(items, 0);
    expect(items[0].id).toBe('a');
  });

  it('tolerates missing tops rather than dropping the entry', () => {
    const items = [{ id: 'a' }, { id: 'b', top: 50 }];
    expect(prioritiseByDistance(items, 50)).toHaveLength(2);
  });
});

describe('chunk', () => {
  it('splits work into frame-sized batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('never returns a zero-size batch, which would loop forever', () => {
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });

  it('handles an empty list', () => {
    expect(chunk([], 4)).toEqual([]);
  });
});

describe('SLOT_STALL_MS', () => {
  // The backend's ffmpeg subprocess timeout is 30s. Releasing the slot must
  // happen well before that or three healthy drives sit behind one asleep.
  it('is comfortably under the backend ffmpeg timeout', () => {
    expect(SLOT_STALL_MS).toBeGreaterThan(1000);
    expect(SLOT_STALL_MS).toBeLessThan(30000);
  });
});
