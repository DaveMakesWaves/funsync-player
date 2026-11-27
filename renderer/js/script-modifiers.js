// Script Modifiers — pure transformation functions for funscript action arrays
// Each function takes (actions, ...params) and returns a new array. Never mutates input.

// Half / double speed operate on MOVEMENTS, not on point count.
//
// Reported by belgriffinite (thread #261): "It looks like it just adds
// midpoints but doesn't change the actual speed or number of movements."
// Exactly right, and both functions were wrong in complementary ways:
//
//   doubleSpeed inserted each new point at the AVERAGE of the two
//   positions around it, which is a point lying precisely ON the straight
//   line between them. The device interpolates linearly between
//   keyframes, so the stroke it performed was bit-for-bit identical.
//   Measured end to end, the difference in output was 0.0000. It doubled
//   the file size and changed nothing else.
//
//   halfSpeed kept every even-indexed point. On an alternating script
//   every even-indexed point is the SAME end of the stroke, so
//   0, 100, 0, 100, 0 collapsed to 0, 0, 0 — a flat line. It did not
//   halve the speed, it deleted the motion.
//
// The unit that matters is the movement (one turning point to the next),
// so both now work in those terms. Time span and both endpoints are
// preserved by each, which keeps the result aligned to the video.

/**
 * Halve the number of movements over the same stretch of time.
 *
 * Keeps points in PAIRS and drops alternate pairs. Keeping alternate
 * single points is what flattened the script: on up/down content the
 * points at 0, 2, 4 are all the same end of the stroke. Keeping
 * 0, 1, 4, 5, 8, 9 … always retains a real movement.
 *
 * The final kept point is retimed to the original end so the selection
 * still covers the same span. Inputs too short to lose a movement
 * without going flat are returned untouched.
 *
 * @param {Array<{at: number, pos: number}>} actions
 * @returns {Array<{at: number, pos: number}>}
 */
export function halfSpeed(actions) {
  const copy = actions.map(a => ({ at: a.at, pos: a.pos }));
  // Under 4 points there is at most one full up-and-down; removing
  // anything leaves a single position, i.e. no motion at all.
  if (copy.length < 4) return copy;

  const result = [];
  for (let i = 0; i < copy.length; i++) {
    if (Math.floor(i / 2) % 2 === 0) result.push(copy[i]);
  }

  // Guard: never hand back something with no movement in it.
  if (result.length < 2 || result.every(a => a.pos === result[0].pos)) return copy;

  const lastAt = copy[copy.length - 1].at;
  const tail = result[result.length - 1];
  if (tail.at !== lastAt) result[result.length - 1] = { at: lastAt, pos: tail.pos };
  return result;
}

/**
 * Double the number of movements over the same stretch of time.
 *
 * Works a full cycle at a time (three points: out, back, and the start of
 * the next), and fits two compressed copies of that cycle into the span
 * the single cycle used to occupy. That keeps the start point, the end
 * point and the total duration identical while genuinely doubling the
 * stroke count — which is what "double speed" means to a scripter.
 *
 * A trailing half-cycle (even-length input) is carried through unchanged
 * rather than guessed at.
 *
 * @param {Array<{at: number, pos: number}>} actions
 * @returns {Array<{at: number, pos: number}>}
 */
export function doubleSpeed(actions) {
  const copy = actions.map(a => ({ at: a.at, pos: a.pos }));
  // Two points is a single one-way movement — there is no cycle to
  // repeat, and inventing a reversal would change where the stroke ends.
  if (copy.length < 3) return copy;

  const result = [copy[0]];
  let i = 0;
  for (; i + 2 < copy.length; i += 2) {
    const p0 = copy[i], p1 = copy[i + 1], p2 = copy[i + 2];
    const span = p2.at - p0.at;
    if (span <= 0) {           // degenerate timing, pass through untouched
      result.push(p1, p2);
      continue;
    }
    // Two cycles where there was one: out, back, out, back.
    const back = (p0.pos + p2.pos) / 2;
    result.push({ at: p0.at + span * 0.25, pos: p1.pos });
    result.push({ at: p0.at + span * 0.50, pos: back });
    result.push({ at: p0.at + span * 0.75, pos: p1.pos });
    result.push({ at: p2.at, pos: p2.pos });
  }
  // Odd number of segments — the last one has no partner to pair with.
  for (let j = i + 1; j < copy.length; j++) result.push(copy[j]);
  return result;
}

/**
 * Linear remap positions to a new range.
 * @param {Array<{at: number, pos: number}>} actions
 * @param {number} newMin — new minimum position (0-100)
 * @param {number} newMax — new maximum position (0-100)
 * @returns {Array<{at: number, pos: number}>}
 */
export function remapRange(actions, newMin, newMax) {
  if (actions.length === 0) return [];
  let oldMin = 100, oldMax = 0;
  for (const a of actions) {
    if (a.pos < oldMin) oldMin = a.pos;
    if (a.pos > oldMax) oldMax = a.pos;
  }
  const oldRange = oldMax - oldMin;
  const newRange = newMax - newMin;
  return actions.map(a => {
    const normalized = oldRange > 0 ? (a.pos - oldMin) / oldRange : 0.5;
    const pos = Math.round(Math.max(0, Math.min(100, newMin + normalized * newRange)));
    return { at: a.at, pos };
  });
}

/**
 * Shift all timestamps by deltaMs, clamping to >= 0.
 * @param {Array<{at: number, pos: number}>} actions
 * @param {number} deltaMs — milliseconds to shift (positive = later, negative = earlier)
 * @returns {Array<{at: number, pos: number}>}
 */
export function offsetTime(actions, deltaMs) {
  return actions.map(a => ({
    at: Math.max(0, Math.round(a.at + deltaMs)),
    pos: a.pos,
  }));
}

/**
 * Remove pauses by collapsing clusters where gaps exceed threshold.
 * Keeps first and last action of each cluster.
 * @param {Array<{at: number, pos: number}>} actions — sorted by time
 * @param {number} maxGapMs — gap threshold in ms
 * @returns {Array<{at: number, pos: number}>}
 */
export function removePauses(actions, maxGapMs) {
  if (actions.length <= 1) return actions.map(a => ({ at: a.at, pos: a.pos }));

  // Find clusters separated by gaps > maxGapMs
  const clusters = [];
  let cluster = [actions[0]];
  for (let i = 1; i < actions.length; i++) {
    if (actions[i].at - actions[i - 1].at > maxGapMs) {
      clusters.push(cluster);
      cluster = [actions[i]];
    } else {
      cluster.push(actions[i]);
    }
  }
  clusters.push(cluster);

  if (clusters.length <= 1) {
    return actions.map(a => ({ at: a.at, pos: a.pos }));
  }

  // Reassemble: keep original timestamps within each cluster,
  // but shift each cluster to close the gaps
  const result = [];
  let timeOffset = 0;
  for (let c = 0; c < clusters.length; c++) {
    const clust = clusters[c];
    if (c === 0) {
      for (const a of clust) {
        result.push({ at: a.at, pos: a.pos });
      }
      timeOffset = clust[clust.length - 1].at;
    } else {
      // Place this cluster right after the previous one with a small gap
      const internalOffset = clust[0].at;
      const smallGap = Math.min(maxGapMs, 100); // keep a small gap between clusters
      for (const a of clust) {
        result.push({ at: Math.round(timeOffset + smallGap + (a.at - internalOffset)), pos: a.pos });
      }
      timeOffset = result[result.length - 1].at;
    }
  }
  return result;
}

/**
 * Reverse the timeline and mirror positions (100 - pos).
 * @param {Array<{at: number, pos: number}>} actions — sorted by time
 * @returns {Array<{at: number, pos: number}>}
 */
export function reverseActions(actions) {
  if (actions.length === 0) return [];
  const firstAt = actions[0].at;
  const lastAt = actions[actions.length - 1].at;
  const totalDuration = lastAt - firstAt;
  const result = [];
  for (let i = actions.length - 1; i >= 0; i--) {
    result.push({
      at: Math.round(firstAt + (totalDuration - (actions[i].at - firstAt))),
      pos: 100 - actions[i].pos,
    });
  }
  return result;
}

/**
 * Range Extend / Compress: scale every timestamp away from the first action
 * (factor > 1 stretches, factor < 1 compresses). Positions are unchanged.
 *
 * This used to be a loop in the editor's modal that called updateAction once
 * per point over indices computed BEFORE the loop. updateAction re-sorts, so
 * as soon as one stretched point overtook the next, the remaining indices
 * named the wrong points: 4 points at 0/100/200/300 ×2 came out 0, 200, 300,
 * 800 (one point scaled twice, another not at all). As a pure function every
 * new time comes from the original one, and a positive factor keeps the order.
 *
 * Note OFS's "Range extend" stretches POSITIONS per stroke; FunSync's scales
 * TIME. The name is kept (Dave, 2026-11-04).
 *
 * @param {Array<{at: number, pos: number}>} actions — sorted by time
 * @param {number} factor — time scale, > 0
 * @returns {Array<{at: number, pos: number}>}
 */
export function rangeExtend(actions, factor) {
  const copy = actions.map(a => ({ at: a.at, pos: a.pos }));
  // A non-positive factor would reverse or collapse the order; hand the input
  // back so applyModifier reports "Nothing changed" instead of scrambling it.
  if (copy.length < 2 || !Number.isFinite(factor) || factor <= 0) return copy;
  const anchor = copy[0].at;
  return copy.map(a => ({ at: Math.round(anchor + (a.at - anchor) * factor), pos: a.pos }));
}

/**
 * Generate a pattern of actions.
 * @param {'sine'|'sawtooth'|'square'|'triangle'|'escalating'|'random'} type
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} bpm — beats per minute (one full cycle = one beat)
 * @param {number} min — minimum position (0-100)
 * @param {number} max — maximum position (0-100)
 * @returns {Array<{at: number, pos: number}>}
 */
/**
 * Width of an "instant" edge in a step waveform. One millisecond rather than
 * zero: a zero-length segment means two actions on the same timestamp, which
 * is ambiguous for anything that interpolates and is awkward in a saved
 * funscript. At 1ms the edge is instant for every practical purpose, and the
 * filler's slew limiter ramps it exactly as it would a true vertical.
 */
const EDGE_MS = 1;

export function generatePattern(type, startMs, endMs, bpm, min = 0, max = 100) {
  if (endMs <= startMs || bpm <= 0) return [];

  const cycleDurationMs = 60000 / bpm;
  // Cap density at ~20 points/sec to prevent runaway output
  const minStepMs = 50;
  const durationMs = endMs - startMs;

  const generators = {
    sine: _sinePattern,
    sawtooth: _sawtoothPattern,
    square: _squarePattern,
    triangle: _trianglePattern,
    escalating: _escalatingPattern,
    random: _randomPattern,
  };

  const gen = generators[type] || generators.sine;
  return gen(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max);
}

function _sinePattern(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max) {
  const result = [];
  const pointsPerCycle = Math.max(8, Math.min(20, Math.floor(cycleDurationMs / minStepMs)));
  const stepMs = Math.max(minStepMs, cycleDurationMs / pointsPerCycle);
  const range = max - min;

  for (let t = startMs; t <= endMs; t += stepMs) {
    const phase = ((t - startMs) / cycleDurationMs) * Math.PI * 2;
    const normalized = (Math.sin(phase) + 1) / 2; // 0 to 1
    result.push({ at: Math.round(t), pos: Math.round(min + normalized * range) });
  }
  // Ensure we include the end point
  if (result.length > 0 && result[result.length - 1].at < Math.round(endMs)) {
    const phase = ((endMs - startMs) / cycleDurationMs) * Math.PI * 2;
    const normalized = (Math.sin(phase) + 1) / 2;
    result.push({ at: Math.round(endMs), pos: Math.round(min + normalized * range) });
  }
  return result;
}

function _sawtoothPattern(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max) {
  const result = [];
  let t = startMs;

  // Ramp up across the cycle, then drop back in EDGE_MS. The drop is the
  // NEXT iteration's opening point one millisecond later, which is what makes
  // it a saw rather than a triangle.
  while (t < endMs) {
    const topT = Math.min(t + cycleDurationMs, endMs);
    result.push({ at: Math.round(t), pos: min });
    if (topT > t) result.push({ at: Math.round(topT), pos: max });
    t = topT + EDGE_MS;
  }

  return _dedupeByTime(result);
}

function _squarePattern(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max) {
  const result = [];
  const halfCycle = cycleDurationMs / 2;
  let t = startMs;
  let high = true;

  // Two points per half cycle — the start and the end of the HOLD — and the
  // next half cycle opens EDGE_MS later at the opposite position. The hold is
  // what makes it square; without it this is a triangle wave.
  while (t < endMs) {
    const holdEnd = Math.min(t + halfCycle, endMs);
    const pos = high ? max : min;
    result.push({ at: Math.round(t), pos });
    if (holdEnd > t) result.push({ at: Math.round(holdEnd), pos });
    t = holdEnd + EDGE_MS;
    high = !high;
  }

  return _dedupeByTime(result);
}

function _trianglePattern(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max) {
  const result = [];
  const quarterCycle = cycleDurationMs / 4;
  let t = startMs;

  while (t <= endMs) {
    const mid = Math.round((min + max) / 2);
    result.push({ at: Math.round(t), pos: mid });
    const peakT = Math.min(t + quarterCycle, endMs);
    result.push({ at: Math.round(peakT), pos: max });
    const midT = Math.min(t + 2 * quarterCycle, endMs);
    if (midT > peakT) result.push({ at: Math.round(midT), pos: mid });
    const valleyT = Math.min(t + 3 * quarterCycle, endMs);
    if (valleyT > midT) result.push({ at: Math.round(valleyT), pos: min });
    t += cycleDurationMs;
  }

  // Ensure end point
  if (result.length > 0 && result[result.length - 1].at < Math.round(endMs)) {
    const mid = Math.round((min + max) / 2);
    result.push({ at: Math.round(endMs), pos: mid });
  }

  return _dedupeByTime(result);
}

function _escalatingPattern(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max) {
  const result = [];
  const totalCycles = Math.max(1, Math.floor(durationMs / cycleDurationMs));
  const range = max - min;

  for (let c = 0; c < totalCycles; c++) {
    const cycleStart = startMs + c * cycleDurationMs;
    if (cycleStart > endMs) break;
    const cycleEnd = Math.min(cycleStart + cycleDurationMs, endMs);
    const progress = c / Math.max(1, totalCycles - 1);
    const cycleMax = Math.round(min + range * progress);
    const cycleMin = min;

    // Bottom then top
    result.push({ at: Math.round(cycleStart), pos: cycleMin });
    const halfT = Math.round((cycleStart + cycleEnd) / 2);
    result.push({ at: halfT, pos: cycleMax });
    result.push({ at: Math.round(cycleEnd), pos: cycleMin });
  }

  return _dedupeByTime(result);
}

function _randomPattern(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max) {
  const result = [];
  const stepMs = Math.max(minStepMs, cycleDurationMs / 2);
  const range = max - min;

  for (let t = startMs; t <= endMs; t += stepMs) {
    const pos = Math.round(min + Math.random() * range);
    result.push({ at: Math.round(t), pos });
  }

  // Ensure end point
  if (result.length > 0 && result[result.length - 1].at < Math.round(endMs)) {
    result.push({ at: Math.round(endMs), pos: Math.round(min + Math.random() * range) });
  }

  return result;
}

/**
 * Remove consecutive actions that share a timestamp AND a position.
 *
 * It used to drop any point whose neighbour shared its timestamp, keeping the
 * later one. But in a step waveform the two points of a same-instant pair are
 * not duplicates: the first ENDS A FLAT HOLD and the second starts the edge.
 * Dropping the first deleted every hold, which silently turned `square` into a
 * triangle wave and `sawtooth` into an almost flat line — in the gap filler
 * and in the editor's Generate Pattern alike (Dave, 2026-08-21).
 *
 * The generators now separate their edges by EDGE_MS instead of stacking them
 * on one timestamp, so nothing depends on that behaviour any more, and this
 * only removes points that are genuinely identical.
 */
function _dedupeByTime(actions) {
  if (actions.length <= 1) return actions;
  const result = [];
  for (let i = 0; i < actions.length; i++) {
    const next = actions[i + 1];
    if (next && next.at === actions[i].at && next.pos === actions[i].pos) continue;
    result.push(actions[i]);
  }
  return result;
}

/**
 * Fade a stretch in or out (editor work list 4.4, 2026-11-24; FunGen 2 has
 * the same tool). Fade in: the stroke depth grows from nothing to full across
 * the points' time span; fade out: it shrinks from full to nothing. Every
 * point keeps its time; its distance from the stretch's centre line (halfway
 * between its lowest and highest point) is scaled by how far through the
 * span it is. Fewer than two points, or a span of 0 ms, come back unchanged.
 *
 * @param {Array<{at: number, pos: number}>} actions — sorted by time
 * @param {'in'|'out'} direction
 * @returns {Array<{at: number, pos: number}>}
 */
export function fadeDepth(actions, direction = 'in') {
  const copy = actions.map(a => ({ at: a.at, pos: a.pos }));
  if (copy.length < 2) return copy;
  const t0 = copy[0].at;
  const span = copy[copy.length - 1].at - t0;
  if (!(span > 0)) return copy;
  let lo = 100;
  let hi = 0;
  for (const a of copy) { lo = Math.min(lo, a.pos); hi = Math.max(hi, a.pos); }
  const mid = (lo + hi) / 2;
  return copy.map((a) => {
    const through = (a.at - t0) / span;
    const k = direction === 'out' ? 1 - through : through;
    return { at: a.at, pos: Math.round(Math.max(0, Math.min(100, mid + (a.pos - mid) * k))) };
  });
}

/** Fade in: Modify > Fade in (the whole script, or the selection). */
export function fadeIn(actions) { return fadeDepth(actions, 'in'); }

/** Fade out: Modify > Fade out (the whole script, or the selection). */
export function fadeOut(actions) { return fadeDepth(actions, 'out'); }

/**
 * Make an axis from the stroke (editor work list 2.4, 2026-11-24). The usual
 * way to script roll or pitch by hand in OpenFunscripter is to copy the
 * stroke into the axis and shift it in time; MultiFunPlayer can link an
 * unscripted axis to the stroke for the same reason. One step here: every
 * stroke point, moved by `shiftMs`, its distance from the middle scaled by
 * `scalePct` around `centre`, upside down with `invert`. Points shifted
 * before 0 are dropped; positions are whole numbers within 0-100.
 *
 * @param {Array<{at: number, pos: number}>} stroke — the main script, in time order
 * @param {{shiftMs?: number, scalePct?: number, centre?: number, invert?: boolean}} [opts]
 * @returns {Array<{at: number, pos: number}>}
 */
export function axisFromStroke(stroke, { shiftMs = 0, scalePct = 100, centre = 50, invert = false } = {}) {
  const shift = Number.isFinite(shiftMs) ? Math.round(shiftMs) : 0;
  const scale = (Number.isFinite(scalePct) ? scalePct : 100) / 100 * (invert ? -1 : 1);
  const mid = Number.isFinite(centre) ? centre : 50;
  const out = [];
  for (const a of stroke || []) {
    const at = Math.round(a.at + shift);
    if (at < 0) continue;
    out.push({ at, pos: Math.round(Math.max(0, Math.min(100, mid + (a.pos - 50) * scale))) });
  }
  return out;
}

/**
 * A quarter of the stroke's typical cycle in ms (half the median time between
 * points): the shift that puts a roll a quarter turn after the stroke, the
 * starting value of Make from the stroke. 0 with fewer than two points.
 */
export function quarterCycleMs(stroke) {
  const gaps = [];
  for (let i = 1; i < (stroke || []).length; i++) {
    const d = stroke[i].at - stroke[i - 1].at;
    if (d > 0) gaps.push(d);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return Math.round(gaps[Math.floor(gaps.length / 2)] / 2);
}

/**
 * Vibrate between points (Dave, 2026-11-24: OFS has an add-on that fills the
 * space between two points with vibration; "can we one up them ... with a
 * slider to make the vibration movements larger or smaller"). Every gap
 * between neighbouring points of the run gets small up-and-down moves around
 * the straight line between them; the points themselves stay.
 * What it adds over a plain filler: the size is a slider (peak to peak, in
 * units), the rate is moves per second, Taper eases the size in and out over
 * the first and last quarter of each gap (no jolt at the joins), and a speed
 * cap: with `maxSpeed` (units/s) the moves are spaced so none is faster than
 * the device limit (the editor's max speed), instead of a buzz the Handy
 * cannot follow. Positions stay within 0-100, whole numbers, times whole ms.
 *
 * @param {Array<{at:number,pos:number}>} actions — a run of points, in time order
 * @param {{size?:number, rate?:number, taper?:boolean, maxSpeed?:number}} [opts]
 * @returns {Array<{at:number,pos:number}>} the run with the vibration added
 */
export function vibrateBetween(actions, { size = 12, rate = 8, taper = true, maxSpeed = 0 } = {}) {
  const pts = (actions || []).map((a) => ({ at: a.at, pos: a.pos })).sort((a, b) => a.at - b.at);
  const depth = Math.max(1, Math.min(100, Number(size) || 12));
  const perSecond = Math.max(1, Math.min(60, Number(rate) || 8));
  const spacing = vibrateSpacingMs(depth, perSecond, maxSpeed);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    if (i === pts.length - 1) break;
    const a = pts[i];
    const b = pts[i + 1];
    const gap = b.at - a.at;
    const n = Math.floor(gap / spacing) - 1;            // points that fit, one spacing from each end
    if (n < 1) continue;
    const step = gap / (n + 1);
    for (let k = 1; k <= n; k++) {
      const f = (step * k) / gap;
      const line = a.pos + (b.pos - a.pos) * f;
      let half = depth / 2;
      if (taper) half *= Math.min(1, Math.min(f, 1 - f) / 0.25);
      const pos = line + (k % 2 ? half : -half);
      out.push({ at: Math.round(a.at + step * k), pos: Math.round(Math.max(0, Math.min(100, pos))) });
    }
  }
  return out;
}

/**
 * The time between vibration points: one move per 1/rate s, longer when the
 * move would be faster than `maxSpeed` units/s (0 = no cap). Never under 20 ms.
 */
export function vibrateSpacingMs(size, rate, maxSpeed = 0) {
  let ms = 1000 / Math.max(1, rate);
  if (maxSpeed > 0) ms = Math.max(ms, (size * 1000) / maxSpeed);
  return Math.max(20, ms);
}
