// When to load during a scroll, and in what order.
//
// Community report #198 (Hikikomori): the app hangs when scrolling fast on a
// large library spanning several drives. Dave, 2026-08-06: scrolling is janky
// and thumbnails haven't loaded.
//
// The library already had the standard defences — virtual scrolling, an
// RAF-throttled passive scroll handler, a 4-way concurrency gate, in-flight
// dedup, and a skip for cards that scrolled away before their turn. What it
// did NOT have is anything in this file:
//
//   1. Loading was gated on a BINARY "are we scrolling" flag with a 150ms
//      settle timer. Continuous slow scrolling — a trackpad, or dragging the
//      scrollbar — reset that timer forever, so nothing loaded at all until
//      you came to a complete stop. That is the "haven't loaded yet" half.
//
//   2. The queue was FIFO in DOM order, so the overscan rows ABOVE the
//      viewport were fetched before the row you were actually looking at.
//
//   3. A slow path (a spun-down or disconnected USB drive) held one of the
//      four concurrency slots for the backend's full 30s ffmpeg timeout. Four
//      of those and the queue stops dead — which is the hang, and why it only
//      showed up on a MULTI-DRIVE library.
//
// Pure functions, no DOM, so the rules are directly testable.

/**
 * Below this speed a scroll is a "read", not a "fling", and loading during it
 * is what the user wants. Expressed in CSS px per animation frame: at 60fps,
 * 40px/frame is ~2400px/s, roughly a fast trackpad drag but well under a
 * flick. Above it the frames are better spent on the scroll itself.
 */
export const SLOW_SCROLL_PX_PER_FRAME = 40;

/**
 * A slot held longer than this is presumed blocked on a sleeping or absent
 * volume rather than working. The slot is RELEASED — the request itself is
 * left running so its result still populates the cache if it ever lands.
 *
 * Chosen well under the backend's 30s ffmpeg timeout: the point is to stop one
 * unresponsive drive from stalling the other three slots, not to give up on
 * the file.
 */
export const SLOT_STALL_MS = 4000;

/**
 * Should loads be deferred right now?
 *
 * The old behaviour is the `velocity >= threshold` branch. The new part is
 * that a slow, continuous scroll returns false — it loads as it goes.
 *
 * @param {number} pxPerFrame most recent scroll delta per frame (any sign)
 * @param {number} [threshold]
 */
export function shouldDeferLoads(pxPerFrame, threshold = SLOW_SCROLL_PX_PER_FRAME) {
  const v = Math.abs(Number(pxPerFrame) || 0);
  return v >= threshold;
}

/**
 * Smooth the per-frame delta so one stuttery frame doesn't flip the decision.
 * Exponential moving average, weighted toward the newest sample so that
 * stopping is noticed quickly (the user expects loads to start promptly when
 * they stop) while a single dropped frame mid-drag doesn't read as a fling.
 *
 * @param {number} previous smoothed value so far
 * @param {number} sample newest per-frame delta
 * @param {number} [weight] 0..1, share given to the new sample
 */
export function smoothVelocity(previous, sample, weight = 0.6) {
  const prev = Number.isFinite(previous) ? previous : 0;
  const next = Number.isFinite(sample) ? sample : 0;
  const w = Math.min(1, Math.max(0, weight));
  return prev * (1 - w) + next * w;
}

/**
 * Order pending loads nearest-to-viewport-centre first.
 *
 * Fetching in DOM order means the overscan rows above the viewport are served
 * before the row under the user's eyes. Sorting by distance from the centre
 * costs one pass and makes the cards being LOOKED AT fill first, which is the
 * whole of the perceived-speed difference.
 *
 * Stable for equal distances, so items keep DOM order within a row.
 *
 * @param {Array<{top: number}>} items each carrying its captured offsetTop
 * @param {number} viewportCentre scrollTop + clientHeight / 2
 * @returns {Array} a new array, nearest first
 */
export function prioritiseByDistance(items, viewportCentre) {
  const list = Array.isArray(items) ? items.slice() : [];
  const centre = Number(viewportCentre) || 0;
  return list
    .map((item, i) => ({ item, i, d: Math.abs((Number(item?.top) || 0) - centre) }))
    .sort((a, b) => (a.d - b.d) || (a.i - b.i))
    .map((x) => x.item);
}

/**
 * Split work into frame-sized chunks.
 *
 * The scroll-end drain kicked off every deferred speed-stat in one synchronous
 * loop — at exactly the moment the main thread should be free for the browser
 * to paint the newly-settled view. Chunking spreads it across frames.
 *
 * @param {Array} items
 * @param {number} size
 * @returns {Array[]}
 */
export function chunk(items, size = 8) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}
