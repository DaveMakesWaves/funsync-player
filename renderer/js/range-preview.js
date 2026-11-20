// range-preview — rate-limit live device jogs driven by a dragged slider.
//
// Why this exists: the range sliders commit on `input`, which fires on every
// pixel of a drag. Feeding that straight to a device is how you flood a serial
// link or a Bluetooth stack and end up BEHIND the user's finger — the exact
// opposite of the real-time feedback the feature is for (stingray, 2026-08-24:
// "I use the feedback of realtime to determine the position of the device").
//
// The rule is leading-edge plus a trailing catch-up: the first move goes out
// immediately so the device responds the instant you start dragging, and the
// LAST value always goes out too, so wherever you let go is where the device
// ends up. A plain throttle drops the trailing value and leaves the device
// resting somewhere the slider is no longer pointing at, which reads as a bug.
//
// Timers are injectable so the behaviour is testable without real time.

export const DEFAULT_PREVIEW_INTERVAL_MS = 80;

/**
 * @param {(value: any) => void} send — called with the value to push
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs] minimum gap between sends
 * @param {() => number} [opts.now]
 * @param {(fn: Function, ms: number) => any} [opts.setTimeout]
 * @param {(handle: any) => void} [opts.clearTimeout]
 * @returns {{request: Function, cancel: Function, intervalMs: number}}
 */
export function createRangePreview(send, opts = {}) {
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs >= 0
    ? opts.intervalMs
    : DEFAULT_PREVIEW_INTERVAL_MS;
  const now = opts.now || (() => Date.now());
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h));

  let lastSentAt = -Infinity;
  let pending = null;   // { value } — boxed so a legitimately falsy value works
  let timer = null;

  const fire = (value) => {
    lastSentAt = now();
    send(value);
  };

  const flush = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    fire(value);
  };

  return {
    /** Ask for `value` to reach the device, subject to the rate limit. */
    request(value) {
      const elapsed = now() - lastSentAt;
      if (elapsed >= intervalMs) {
        // Leading edge — go now, and drop any queued value, which is by
        // definition older than this one.
        pending = null;
        if (timer !== null) { clearT(timer); timer = null; }
        fire(value);
        return;
      }
      // Too soon. Remember the newest value and make sure exactly one
      // trailing send is scheduled for it.
      pending = { value };
      if (timer === null) timer = setT(flush, intervalMs - elapsed);
    },

    /** Drop anything queued — e.g. the panel closed mid-drag. */
    cancel() {
      pending = null;
      if (timer !== null) { clearT(timer); timer = null; }
    },

    intervalMs,
  };
}
