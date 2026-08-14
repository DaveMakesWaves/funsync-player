// Turning repeated latency probes into a value worth storing.
//
// myopiic, thread #270: "Option to set latency automatically from tested
// result." The measurement already existed (AutoblowManager.estimateLatency)
// and was displayed and then thrown away; this is the missing half.
//
// A single round trip over a cloud API is noisy, and one unlucky sample
// written into a user's sync offset is worse than not offering the feature at
// all — it silently makes their sync wrong and they have no reason to suspect
// the button. So: several samples, and the MEDIAN rather than the mean, since
// one 900ms outlier drags a mean badly and moves a median not at all.

/** Samples below this are treated as a failed probe, not a fast one. */
const MIN_PLAUSIBLE_MS = 1;

/** Samples above this are treated as a stall, not a measurement. */
const MAX_PLAUSIBLE_MS = 5000;

/**
 * Median of a set of latency probes, ignoring failures and implausible
 * readings.
 *
 * @param {number[]} samples
 * @returns {number} median in ms, or 0 when nothing usable came back
 */
export function medianLatency(samples) {
  const usable = (Array.isArray(samples) ? samples : [])
    .filter((s) => Number.isFinite(s) && s >= MIN_PLAUSIBLE_MS && s <= MAX_PLAUSIBLE_MS)
    .sort((a, b) => a - b);

  if (usable.length === 0) return 0;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2
    ? Math.round(usable[mid])
    : Math.round((usable[mid - 1] + usable[mid]) / 2);
}

/**
 * Whether a measurement is worth writing into a user's stored offset.
 *
 * `estimateLatency()` returns 0 both when disconnected and on any error, so
 * 0 means "no reading" and must never overwrite a value the user tuned by
 * hand.
 *
 * @param {number} measured
 * @returns {boolean}
 */
export function isApplicableLatency(measured) {
  return Number.isFinite(measured)
    && measured >= MIN_PLAUSIBLE_MS
    && measured <= MAX_PLAUSIBLE_MS;
}

/**
 * Clamp a measurement into the offset slider's range so applying it can
 * never store a value the UI cannot represent or the user cannot undo.
 *
 * @param {number} measured
 * @param {number} [limit] — slider bound, mirrors #ab-offset min/max
 */
export function clampToOffsetRange(measured, limit = 1000) {
  if (!Number.isFinite(measured)) return 0;
  return Math.max(-limit, Math.min(limit, Math.round(measured)));
}
