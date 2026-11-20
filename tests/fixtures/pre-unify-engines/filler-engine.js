// Filler strokes during script gaps.
//
// lnlytrckr, thread #269: "you already have 'Skip gap', but I've seen other
// players that have a kind of 'slow random stroke during gap' kind of thing.
// Useful for some story-ish vids that start out with a lot of blank script."
//
// Everything here is PURE and works in SCRIPT POSITION SPACE, upstream of
// every per-device transform. That is the whole design:
//
//   generate filler in script space -> merge into the action list ->
//   the existing per-device stack (extend, invert, range, cutoff) runs
//   over authored and filler content identically
//
// which means a user's inversion, range limit and output cutoff apply to
// filler automatically and CANNOT be bypassed, and a join computed between
// script-space positions stays seamless after inversion because both sides
// invert together. Injecting filler downstream of that stack would bypass
// all three at once and is the single most dangerous mistake available here.
//
// See notes/features/SCOPE-gap-filler-and-community-fixes.md.

import { detectGaps } from './gap-filler.js';
import { generatePattern } from './script-modifiers.js';
import { computeNaturalRange } from './device-transform-stack.js';

/**
 * Maximum speed, in position units per second, that filler is allowed to
 * travel — both at the joins and anywhere inside the pattern.
 *
 * This is what stops the "ultrafast jump" when the filler sits at 0 and the
 * main script resumes at 1. It is also what makes the `square` preset usable:
 * a square wave is an instantaneous edge by definition, and unlimited it
 * would slam the device.
 */
export const DEFAULT_MAX_JOIN_SPEED = 300;

/** Shortest pattern worth generating. Below this a gap is left alone. */
export const MIN_PATTERN_MS = 800;

/** Resample grid for the slew limiter. */
const SLEW_STEP_MS = 50;

const clampPos = (p) => Math.max(0, Math.min(100, p));

/**
 * Position of a polyline at time `t`.
 *
 * Duplicate timestamps are real: `_squarePattern` emits two points at the
 * same `at` to express an instant edge. Stepping past zero-length segments
 * makes the later value win, which is the step behaviour a square wants.
 */
function _posAtTime(actions, t) {
  if (t <= actions[0].at) return actions[0].pos;
  const last = actions[actions.length - 1];
  if (t >= last.at) return last.pos;
  for (let i = 0; i < actions.length - 1; i++) {
    const a = actions[i];
    const b = actions[i + 1];
    if (b.at === a.at) continue;            // instant edge, skip to the next
    if (t >= a.at && t <= b.at) {
      return a.pos + ((t - a.at) / (b.at - a.at)) * (b.pos - a.pos);
    }
  }
  return last.pos;
}

/** Drop points that lie on the straight line between their neighbours. */
function _simplify(actions, epsilon = 0.5) {
  if (actions.length <= 2) return actions;
  const out = [actions[0]];
  for (let i = 1; i < actions.length - 1; i++) {
    const prev = out[out.length - 1];
    const next = actions[i + 1];
    const span = next.at - prev.at;
    const expected = span === 0
      ? prev.pos
      : prev.pos + ((actions[i].at - prev.at) / span) * (next.pos - prev.pos);
    if (Math.abs(actions[i].pos - expected) > epsilon) out.push(actions[i]);
  }
  out.push(actions[actions.length - 1]);
  return out;
}

/**
 * Cap how fast a pattern may move.
 *
 * Implemented as a resample-and-slew rather than a per-segment speed clamp,
 * because a per-segment clamp cannot express what to do with the ZERO-LENGTH
 * segments a square wave produces (an instant edge has infinite speed and no
 * time to slow down in). Resampling onto a fixed grid and moving at most
 * `max * dt` per step turns those edges into ramps and leaves any pattern
 * already within the limit untouched.
 *
 * @param {Array<{at:number,pos:number}>} actions
 * @param {number} maxUnitsPerSec
 * @param {number} [stepMs]
 * @returns {Array<{at:number,pos:number}>}
 */
export function limitSlewRate(actions, maxUnitsPerSec, stepMs = SLEW_STEP_MS) {
  const src = (Array.isArray(actions) ? actions : []).filter(
    (a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos),
  );
  if (src.length < 2) return src.map((a) => ({ at: a.at, pos: a.pos }));
  if (!Number.isFinite(maxUnitsPerSec) || maxUnitsPerSec <= 0) {
    return src.map((a) => ({ at: a.at, pos: a.pos }));
  }

  const start = src[0].at;
  const end = src[src.length - 1].at;
  if (end <= start) return src.map((a) => ({ at: a.at, pos: a.pos }));

  const maxPerStep = maxUnitsPerSec * (stepMs / 1000);
  let cur = src[0].pos;
  const out = [{ at: start, pos: cur }];

  for (let t = start + stepMs; t < end; t += stepMs) {
    const target = _posAtTime(src, t);
    const delta = target - cur;
    cur += Math.max(-maxPerStep, Math.min(maxPerStep, delta));
    out.push({ at: t, pos: cur });
  }

  // Final sample. Move toward the true end position but never faster than
  // the limit, so the last segment obeys the cap like every other one.
  const tailMs = end - out[out.length - 1].at;
  if (tailMs > 0) {
    const target = src[src.length - 1].pos;
    const allowed = maxUnitsPerSec * (tailMs / 1000);
    const delta = target - cur;
    cur += Math.max(-allowed, Math.min(allowed, delta));
    out.push({ at: end, pos: cur });
  }

  return _simplify(out).map((a) => ({
    at: Math.round(a.at),
    pos: Math.round(clampPos(a.pos)),
  }));
}

/**
 * Turn a preset's depth into concrete min/max positions.
 *
 * Depth is a PERCENTAGE OF THE AUTHORED SCRIPT'S NATURAL RANGE, not an
 * absolute 0-100 band. The range extender stretches narrow scripts per tick
 * using a factor derived from authored content; filler generated at a fixed
 * 0-100 inside a script that lives between 40 and 60 would be stretched by a
 * factor it is not part of and end up clamped and misshapen. Working in the
 * script's own range also just sounds right — filler should feel like it
 * belongs to the script rather than to the settings panel.
 *
 * @param {Array} authoredActions
 * @param {{depthPct?: number, centrePct?: number|null, absolute?: {min:number,max:number}|null}} opts
 * @returns {{min: number, max: number}}
 */
export function resolveDepth(authoredActions, opts = {}) {
  const { depthPct = 100, centrePct = null, absolute = null } = opts;
  if (absolute && Number.isFinite(absolute.min) && Number.isFinite(absolute.max)) {
    const lo = clampPos(Math.min(absolute.min, absolute.max));
    const hi = clampPos(Math.max(absolute.min, absolute.max));
    return { min: lo, max: hi };
  }
  const natural = computeNaturalRange(authoredActions);
  const width = natural.max - natural.min;
  if (!(width > 0)) return { min: 0, max: 100 };   // degenerate, use full throw

  const centre = centrePct == null
    ? (natural.min + natural.max) / 2
    : natural.min + width * (clampPos(centrePct) / 100);
  const half = (width * (Math.max(0, depthPct) / 100)) / 2;
  return { min: clampPos(centre - half), max: clampPos(centre + half) };
}

/**
 * Time reserved either side of a filler run so the device can travel between
 * the main script and the filler without exceeding the speed cap.
 *
 * Deliberately computed from the WORST CASE (a full 0-to-100 move) rather
 * than the actual position delta. Using the real delta creates a circular
 * dependency — the reserve depends on the pattern's first position, which
 * depends on where the pattern is allowed to start — and resolving it needs
 * an iterative fit that may not converge. A worst-case reserve is a single
 * pass and makes the join speed provably within the cap for ANY pattern
 * start or end position, at a cost of a few hundred ms in a gap that is
 * seconds long.
 */
export function joinReserveMs(maxJoinSpeed = DEFAULT_MAX_JOIN_SPEED) {
  const speed = Number.isFinite(maxJoinSpeed) && maxJoinSpeed > 0
    ? maxJoinSpeed
    : DEFAULT_MAX_JOIN_SPEED;
  return Math.ceil((100 / speed) * 1000);
}

/**
 * Build filler for ONE gap, joined to whatever sits either side of it.
 *
 * @param {{startMs:number, endMs:number}} gap
 * @param {number|null} posBefore — position of the action ending the gap's
 *   left edge, or null for a leading gap (nothing precedes it)
 * @param {number|null} posAfter — position of the action resuming after the
 *   gap, or null for a trailing gap (nothing follows it)
 * @param {object} opts
 * @returns {Array<{at:number,pos:number,_filler:true}>} empty when the gap
 *   cannot be filled safely
 */
export function buildGapFiller(gap, posBefore, posAfter, opts = {}) {
  const {
    pattern = 'sine',
    bpm = 20,
    min = 0,
    max = 100,
    maxJoinSpeed = DEFAULT_MAX_JOIN_SPEED,
    restPos = null,
  } = opts;

  const reserve = joinReserveMs(maxJoinSpeed);
  // Only constrained edges need a reserve. A leading gap has nothing before
  // it and a trailing gap has nothing after it.
  const leadIn = posBefore == null ? 0 : reserve;
  const landOut = posAfter == null ? 0 : reserve;

  const interiorStart = gap.startMs + leadIn;
  const interiorEnd = gap.endMs - landOut;

  // Refuse rather than lurch. An unfilled gap is today's behaviour and is
  // harmless; a gap filled with a violent jump into or out of it is not.
  if (interiorEnd - interiorStart < MIN_PATTERN_MS) return [];

  const raw = generatePattern(pattern, interiorStart, interiorEnd, bpm, min, max);
  if (!raw || raw.length < 2) return [];

  const limited = limitSlewRate(raw, maxJoinSpeed);
  if (limited.length < 2) return [];

  // Trailing gaps have no landing target, so ease down to a rest position
  // instead of stopping mid-stroke and holding there.
  if (posAfter == null && restPos != null) {
    const tail = limited[limited.length - 1];
    const travelMs = Math.ceil((Math.abs(restPos - tail.pos) / maxJoinSpeed) * 1000);
    const restAt = Math.min(gap.endMs, tail.at + Math.max(1, travelMs));
    if (restAt > tail.at) limited.push({ at: restAt, pos: clampPos(restPos) });
  }

  return limited
    // Strictly inside the gap. Sharing a timestamp with a main-script action
    // would put two positions at one instant and let sort order decide which
    // the device sees.
    .filter((a) => a.at > gap.startMs && a.at < gap.endMs)
    .map((a) => ({ at: a.at, pos: a.pos, _filler: true }));
}

/**
 * Build filler for every qualifying gap in a script.
 *
 * @param {Array<{at:number,pos:number}>} authoredActions — sorted
 * @param {object} opts
 * @param {number} opts.thresholdMs — minimum gap length to fill
 * @param {number} [opts.totalDurationMs] — enables leading/trailing gaps
 * @returns {Array<{at:number,pos:number,_filler:true}>}
 */
export function buildFillerActions(authoredActions, opts = {}) {
  const authored = Array.isArray(authoredActions) ? authoredActions : [];
  const {
    thresholdMs = 10000,
    totalDurationMs = 0,
    pattern = 'sine',
    bpm = 20,
    depthPct = 100,
    centrePct = null,
    absoluteDepth = null,
    maxJoinSpeed = DEFAULT_MAX_JOIN_SPEED,
  } = opts;

  if (!(thresholdMs > 0)) return [];

  const gaps = detectGaps(authored, thresholdMs, totalDurationMs);
  if (!gaps.length) return [];

  const depth = resolveDepth(authored, {
    depthPct,
    centrePct,
    absolute: absoluteDepth,
  });

  const out = [];
  for (const gap of gaps) {
    // Which authored actions bound this gap? A leading gap has nothing
    // before it; a trailing gap has nothing after it.
    const before = authored.filter((a) => a.at <= gap.startMs).pop() || null;
    const after = authored.find((a) => a.at >= gap.endMs) || null;

    out.push(...buildGapFiller(
      gap,
      before ? before.pos : null,
      after ? after.pos : null,
      {
        pattern,
        bpm,
        min: depth.min,
        max: depth.max,
        maxJoinSpeed,
        restPos: depth.min,
      },
    ));
  }
  return out;
}

/**
 * Merge filler into the authored list.
 *
 * The authored actions are returned untouched and complete — filler is only
 * ever ADDED, and only inside gaps. Nothing is written to disk; this is a
 * playback and upload-time transform over a copy.
 */
export function mergeFiller(authoredActions, fillerActions) {
  const authored = Array.isArray(authoredActions) ? authoredActions : [];
  const filler = Array.isArray(fillerActions) ? fillerActions : [];
  if (!filler.length) return authored.map((a) => ({ ...a }));
  return [...authored.map((a) => ({ ...a })), ...filler.map((a) => ({ ...a }))]
    .sort((a, b) => a.at - b.at);
}

/**
 * Bake filler into raw funscript JSON for cloud upload.
 *
 * Handy HSSP and Autoblow/Vacuglide upload the script and play it from the
 * device's own clock — there is no per-tick hook to inject through, which is
 * the same reason the extender and cutoff are applied at upload time. Without
 * this, the tick-driven devices (T-Code, Buttplug, Handy HDSP) would get
 * filler and the two most popular devices would silently get none.
 *
 * ORDER MATTERS at the call site: extend -> fill -> clamp.
 *   - the extender runs first because it measures the AUTHORED natural range,
 *     which filler would corrupt
 *   - the cutoff runs last so filler obeys the same comfort limit as the
 *     main script
 * Running after the extender also means filler joins to post-extender
 * positions, which is what keeps joins seamless when the extender is on.
 *
 * Lives here rather than in device-transform-stack.js to keep the dependency
 * one-way — this module already imports from there, and the reverse would be
 * a cycle.
 *
 * @param {string} rawContent — funscript JSON
 * @param {object|null} fillerOptions
 * @returns {string} JSON with filler merged, or the original string on no-op
 */
export function fillRawScriptContent(rawContent, fillerOptions) {
  if (typeof rawContent !== 'string' || rawContent.length === 0) return rawContent;
  if (!fillerOptions || !fillerOptions.enabled) return rawContent;
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }
  if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    return rawContent;
  }
  const merged = applyFiller(parsed.actions, fillerOptions);
  if (!merged.some((a) => a._filler)) return rawContent;   // nothing qualified
  return JSON.stringify({
    ...parsed,
    // Strip the marker — this is going to a device, not back into our engine.
    actions: merged.map((a) => ({ at: a.at, pos: a.pos })),
  });
}

/**
 * One-shot: authored actions in, filler-merged actions out.
 * Returns the input unchanged when disabled or when nothing qualifies.
 */
export function applyFiller(authoredActions, opts = {}) {
  if (!opts || opts.enabled === false) {
    return (Array.isArray(authoredActions) ? authoredActions : []).map((a) => ({ ...a }));
  }
  const filler = buildFillerActions(authoredActions, opts);
  return mergeFiller(authoredActions, filler);
}
