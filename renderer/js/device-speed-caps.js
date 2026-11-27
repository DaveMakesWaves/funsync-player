/**
 * How fast the devices can really move, in funscript units a second (Dave,
 * 2026-11-24: "the handy 2 and other devices have separate speed caps so the
 * max speed cap should take into account the handy pro 2 overclocking speed
 * and if other devices are able to move faster than that").
 *
 * From notes/features/device-speed-limits-2026-11-17.md (maker figures where
 * there are any): u/s at full stroke = mm/s x 100 / stroke mm. A narrower
 * stroke window gives more u/s from the same motor (capAtWindow).
 *   Handy 1                 400 mm/s, 110 mm  -> 364 u/s
 *   Handy 2                 400 mm/s, 125 mm  -> 320 u/s
 *   Handy 2 Pro             450 mm/s, 125 mm  -> 360 u/s
 *   Handy 2 Pro overclocked 800 mm/s, 125 mm  -> 640 u/s (opt-in on the device; voids its warranty)
 *   Kiiroo Keon family      about 470 u/s at its top speed byte (estimate)
 *   OSR2 / SR6              about 270-540 u/s (community estimate)
 * Nothing found moves faster than the overclocked Handy 2 Pro, so that is the
 * ceiling for what the editor writes: a script outlives the device it was
 * made on, and a move no device can make is only ever cut short.
 */

export const DEVICE_SPEEDS = Object.freeze({
  handy1: { label: 'Handy 1', mmPerSecond: 400, strokeMm: 110 },
  handy2: { label: 'Handy 2', mmPerSecond: 400, strokeMm: 125 },
  handy2Pro: { label: 'Handy 2 Pro', mmPerSecond: 450, strokeMm: 125 },
  handy2ProOverclocked: { label: 'Handy 2 Pro (overclocked)', mmPerSecond: 800, strokeMm: 125 },
});

/** u/s a device reaches with `window` (0-1] of its stroke in use. */
export function capAtWindow(mmPerSecond, strokeMm, window = 1) {
  const w = Math.max(0.05, Math.min(1, Number(window) || 1));
  return Math.round((mmPerSecond * 100) / (strokeMm * w));
}

/** The fastest any supported device moves at full stroke: the overclocked Handy 2 Pro. */
export const FASTEST_DEVICE_CAP = capAtWindow(DEVICE_SPEEDS.handy2ProOverclocked.mmPerSecond, DEVICE_SPEEDS.handy2ProOverclocked.strokeMm);
