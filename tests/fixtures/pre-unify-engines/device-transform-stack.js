// Per-device position transformation pipeline.
//
// Single source of truth for the order in which raw script values get
// transformed before being sent to a device. Every sync engine (Handy,
// Buttplug, TCode, Autoblow) routes its per-tick position through
// `applyDeviceStack` so the composition order is identical everywhere.
//
// Order (matches SCOPE-device-settings-expansion.md §2):
//
//   raw script value (0-100)
//       ↓
//   [1] applyExtender    — Range Extender (script-side stretch)
//       ↓
//   [2] applyInvert      — script-side direction flip
//       ↓
//   [3] applyRange       — user's device range remap (rescale into window)
//       ↓
//   [4] applyCutoff      — user's hard floor/ceiling clamp (pin out-of-band)
//       ↓
//   [5] applySafetyCap   — hardware safety limit (e-stim max intensity)
//       ↓
//   output (0-100)
//
// NOTE on [3] vs [4]: applyRange RESCALES the whole 0-100 stroke into a
// window (pos 10 with 20-100 → 28). applyCutoff CLAMPS — it pins values
// outside [min,max] to the boundary and leaves the rest untouched (pos 10
// with floor 20 → 20, pos 50 → 50). They are deliberately separate
// controls: "Range" compresses, "Output limits" floor/ceiling clips. See
// SCOPE-device-cutoff-threshold.md §1.
//
// Speed limit + transport precision encoding live in the sync engines
// themselves; they operate on stroke deltas / send-format, not on the
// position value, so they're out of this stack's scope.
//
// Each step is a pure function — no I/O, no side effects, no exceptions
// on bad input (defensive clamps instead). Property tests in
// `tests/unit/device-transform-stack.test.js` pin the order and the
// no-op-at-defaults invariant.

/** Clamp a value into [0, 100]. NaN / undefined → 0. */
function clamp01(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/**
 * Stretch a narrow-range script to fill 0-100. Used when a script's
 * action positions cluster in a sub-range (e.g. all between 30 and 70)
 * and the user wants the device to use its full configured range.
 *
 * Skipped if disabled, if the script's natural range is already wider
 * than `thresholdPct`, or if the natural width is zero (degenerate
 * scripts like a single action or all-same-position).
 *
 * @param {number} rawPos              — clamped 0-100 input
 * @param {{min:number, max:number}|null} natural — script's observed range
 * @param {boolean} enabled
 * @param {number} thresholdPct        — only stretch if natural width < this
 * @returns {number}
 */
export function applyExtender(rawPos, natural, enabled, thresholdPct) {
  if (!enabled) return rawPos;
  if (!natural || typeof natural !== 'object') return rawPos;
  const min = Number.isFinite(natural.min) ? natural.min : 0;
  const max = Number.isFinite(natural.max) ? natural.max : 100;
  const naturalWidth = max - min;
  if (naturalWidth <= 0) return rawPos;
  const thr = Number.isFinite(thresholdPct) ? thresholdPct : 80;
  if (naturalWidth >= thr) return rawPos;
  // Clamp the source value into the natural range before remapping so
  // an out-of-band action (script bug) doesn't blow past the stretched
  // output bounds.
  const clamped = Math.max(min, Math.min(max, rawPos));
  return ((clamped - min) / naturalWidth) * 100;
}

/**
 * Flip the position around the midpoint (100 - pos). Used by Buttplug
 * per-device invert and TCode per-axis invert. Identity when `inverted`
 * is false / undefined.
 */
export function applyInvert(rawPos, inverted) {
  if (!inverted) return rawPos;
  return 100 - clamp01(rawPos);
}

/**
 * Linearly remap 0-100 into the user's configured min-max window.
 * Used by Handy stroke range, TCode per-axis range, Buttplug per-device
 * range. Defensive against degenerate ranges (min >= max → no-op);
 * never silently swaps min and max because that's a hidden behaviour
 * change the user wouldn't expect.
 *
 * @param {number} rawPos
 * @param {{min:number, max:number}|null|undefined} range
 * @returns {number}
 */
export function applyRange(rawPos, range) {
  if (!range || typeof range !== 'object') return rawPos;
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) return rawPos;
  // Clamp the range itself to [0, 100] before applying — a config that
  // somehow stored min=-50 shouldn't push the output below 0.
  const min = Math.max(0, Math.min(100, range.min));
  const max = Math.max(0, Math.min(100, range.max));
  if (min === 0 && max === 100) return rawPos;     // no-op at defaults
  if (min >= max) return rawPos;                   // degenerate, refuse to apply
  const p = clamp01(rawPos) / 100;
  return min + (max - min) * p;
}

/**
 * Hard floor/ceiling clamp on the output value. Distinct from applyRange:
 * this PINS out-of-band values to the boundary and leaves in-band values
 * untouched (a true clamp), whereas applyRange linearly rescales the whole
 * 0-100 input into the window. This is F4NTY's "commands below 20 are
 * ignored" request — see SCOPE-device-cutoff-threshold.md.
 *
 * Applied AFTER invert + range so "the device never physically goes below
 * the floor" holds regardless of the other transforms.
 *
 * @param {number} rawPos
 * @param {{min:number, max:number}|null|undefined} cutoff
 * @returns {number}
 */
export function applyCutoff(rawPos, cutoff) {
  if (!cutoff || typeof cutoff !== 'object') return rawPos;
  if (!Number.isFinite(cutoff.min) || !Number.isFinite(cutoff.max)) return rawPos;
  const floor = Math.max(0, Math.min(100, cutoff.min));
  const ceil = Math.max(0, Math.min(100, cutoff.max));
  if (floor === 0 && ceil === 100) return rawPos;  // no-op at defaults
  if (floor >= ceil) return rawPos;                // degenerate, refuse (UI prevents this)
  return Math.min(ceil, Math.max(floor, clamp01(rawPos)));
}

/**
 * Hard-clip intensity to a safety cap (e-stim max intensity). Already
 * existed in buttplug-sync.js as inline logic; lifted here so the order
 * in `applyDeviceStack` is explicit and the composition is testable.
 *
 * `maxIntensity` is a percentage 0-100. Cap is a CLIP (not a remap) —
 * intentionally hard so the user sees a clipped ceiling rather than
 * proportional scaling that might encourage them to set it lower than
 * they meant.
 */
export function applySafetyCap(rawPos, maxIntensity) {
  if (!Number.isFinite(maxIntensity)) return rawPos;
  if (maxIntensity >= 100 || maxIntensity <= 0) return rawPos;
  return Math.min(rawPos, maxIntensity);
}

/**
 * Canonical per-device transform pipeline. Every sync engine call site
 * uses this so the composition order can never drift between Handy,
 * Buttplug, TCode, or Autoblow.
 *
 * @param {number} rawPos      — interpolator output, 0-100
 * @param {object} ctx
 * @param {{min,max}|null}    [ctx.natural]       — script's observed range (for extender)
 * @param {object|null}       [ctx.extender]      — { enabled, thresholdPct }
 * @param {boolean}           [ctx.inverted]
 * @param {{min,max}|null}    [ctx.range]
 * @param {{min,max}|null}    [ctx.cutoff]        — hard floor/ceiling clamp
 * @param {number}            [ctx.maxIntensity]  — e-stim safety, 0-100
 * @returns {number} transformed position, guaranteed 0-100
 */
export function applyDeviceStack(rawPos, ctx) {
  let v = clamp01(rawPos);
  if (ctx) {
    v = applyExtender(v, ctx.natural, !!ctx.extender?.enabled, ctx.extender?.thresholdPct);
    v = applyInvert(v, ctx.inverted);
    v = applyRange(v, ctx.range);
    v = applyCutoff(v, ctx.cutoff);
    v = applySafetyCap(v, ctx.maxIntensity);
  }
  // Final clamp guards against any future stage producing out-of-bounds.
  return clamp01(v);
}

// Internal helper, exported for direct test coverage. Not part of the
// public contract — callers should use `applyDeviceStack`.
export { clamp01 };

// --- Range Extender support ---
//
// Threshold = 80% per design decision: scripts whose natural width is
// less than this get stretched to fill 0-100. Fixed (not configurable)
// for v0.7.x — see SCOPE-device-settings-expansion.md §9 question 2.
// If a future need surfaces, exposing this in settings is one line.
export const RANGE_EXTENDER_THRESHOLD_PCT = 80;

/**
 * Compute the observed min/max `pos` across an action array. Returned
 * range is what `applyExtender` uses to decide whether (and how) to
 * stretch.
 *
 * Edge cases:
 *   - empty / non-array → defaults to {min:0, max:100} (no stretch)
 *   - single action / all-same-pos → returns the degenerate range;
 *     `applyExtender` skips stretch when width == 0 to avoid div-by-zero
 *   - action.pos out of [0,100] (malformed script) → clamped to [0,100]
 *     before measuring; final range guaranteed in bounds
 *
 * O(n) single pass.
 */
export function computeNaturalRange(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { min: 0, max: 100 };
  }
  let min = 100;
  let max = 0;
  for (const a of actions) {
    // Skip null/undefined entries AND actions with non-finite pos
    // (NaN, Infinity). `typeof NaN === 'number'`, so the isFinite
    // check is the only reliable guard; without it, malformed actions
    // get clamp01'd to 0 and silently corrupt the natural range.
    if (!a || !Number.isFinite(a.pos)) continue;
    const p = clamp01(a.pos);
    if (p < min) min = p;
    if (p > max) max = p;
  }
  // Degenerate: no valid actions at all → defaults
  if (min > max) return { min: 0, max: 100 };
  return { min, max };
}

/**
 * Pre-process raw funscript JSON content for cloud upload (Handy HSSP,
 * Autoblow). Returns the content with `actions[].pos` stretched if the
 * extender is enabled AND the script is narrow.
 *
 * Cloud devices upload the script once and play it server-side, so
 * per-tick `applyExtender` doesn't reach them. This helper applies the
 * same transformation at upload time so the user gets uniform behaviour
 * regardless of device class (Nielsen #4 consistency).
 *
 * Only the main `actions` array is transformed — Handy HSSP and
 * Autoblow are single-axis. Embedded multi-axis arrays (additional_axes,
 * raw.*, etc.) are left intact because their per-axis natural ranges
 * are tracked separately by the multi-axis sync engines for per-tick
 * extension.
 *
 * Returns the original content string unchanged if:
 *   - extender disabled
 *   - content is not valid JSON
 *   - content has no `actions` array
 *   - script's natural width >= threshold (no stretch needed)
 *
 * @param {string} rawContent — funscript JSON
 * @param {boolean} enabled
 * @returns {string} possibly-stretched JSON, or original string on no-op
 */
export function extendRawScriptContent(rawContent, enabled) {
  if (!enabled) return rawContent;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return rawContent;
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }
  if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    return rawContent;
  }
  const natural = computeNaturalRange(parsed.actions);
  const width = natural.max - natural.min;
  if (width <= 0 || width >= RANGE_EXTENDER_THRESHOLD_PCT) {
    // Already wide enough OR degenerate — no transformation. Return
    // the original string to preserve any whitespace / key ordering
    // that mattered to the source author.
    return rawContent;
  }
  const stretched = {
    ...parsed,
    actions: parsed.actions.map((a) => {
      if (!a || typeof a.pos !== 'number') return a;
      return { ...a, pos: applyExtender(a.pos, natural, true, RANGE_EXTENDER_THRESHOLD_PCT) };
    }),
  };
  return JSON.stringify(stretched);
}

/**
 * Pre-clamp raw funscript JSON content with a floor/ceiling cutoff for
 * cloud upload (Handy HSSP, Autoblow). Cloud devices play the script
 * server-side, so the per-tick `applyCutoff` doesn't reach them — this
 * applies the SAME hard clamp to each action's `pos` at upload time so a
 * floor behaves identically on a Handy as it does on a local Buttplug
 * device (Nielsen #4 consistency).
 *
 * Deliberately NOT Handy's native `setStrokeZone`: that is a REMAP
 * (rescales the full range into the zone), which is different behaviour
 * from the clamp the user asked for. Pre-clamping the content gives true
 * clamp semantics on cloud devices.
 *
 * Returns the original content string unchanged if: cutoff is a no-op
 * (0/100 or degenerate), content isn't valid JSON, or there's no actions
 * array — preserving the source author's whitespace / key ordering.
 *
 * @param {string} rawContent — funscript JSON
 * @param {{min:number, max:number}|null} cutoff
 * @returns {string} possibly-clamped JSON, or original string on no-op
 */
export function clampRawScriptContent(rawContent, cutoff) {
  if (typeof rawContent !== 'string' || rawContent.length === 0) return rawContent;
  if (!cutoff || !Number.isFinite(cutoff.min) || !Number.isFinite(cutoff.max)) return rawContent;
  const floor = Math.max(0, Math.min(100, cutoff.min));
  const ceil = Math.max(0, Math.min(100, cutoff.max));
  if (floor === 0 && ceil === 100) return rawContent;  // no-op at defaults
  if (floor >= ceil) return rawContent;                // degenerate, refuse
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }
  if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    return rawContent;
  }
  const clamped = {
    ...parsed,
    actions: parsed.actions.map((a) => {
      if (!a || typeof a.pos !== 'number') return a;
      return { ...a, pos: applyCutoff(a.pos, { min: floor, max: ceil }) };
    }),
  };
  return JSON.stringify(clamped);
}
