// Script Modifiers — pure transformation functions for funscript action arrays
// Each function takes (actions, ...params) and returns a new array. Never mutates input.

/**
 * Keep every other action (preserve first and last).
 * @param {Array<{at: number, pos: number}>} actions
 * @returns {Array<{at: number, pos: number}>}
 */
export function halfSpeed(actions) {
  if (actions.length <= 2) return actions.map(a => ({ at: a.at, pos: a.pos }));
  const result = [];
  for (let i = 0; i < actions.length; i++) {
    if (i === 0 || i === actions.length - 1 || i % 2 === 0) {
      result.push({ at: actions[i].at, pos: actions[i].pos });
    }
  }
  return result;
}

/**
 * Insert midpoints between each pair of actions (doubles density).
 * @param {Array<{at: number, pos: number}>} actions
 * @returns {Array<{at: number, pos: number}>}
 */
export function doubleSpeed(actions) {
  if (actions.length < 2) return actions.map(a => ({ at: a.at, pos: a.pos }));
  const result = [];
  for (let i = 0; i < actions.length; i++) {
    result.push({ at: actions[i].at, pos: actions[i].pos });
    if (i < actions.length - 1) {
      const midAt = Math.round((actions[i].at + actions[i + 1].at) / 2);
      const midPos = Math.round((actions[i].pos + actions[i + 1].pos) / 2);
      result.push({ at: midAt, pos: midPos });
    }
  }
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
 * Generate a pattern of actions.
 * @param {'sine'|'sawtooth'|'square'|'triangle'|'escalating'|'random'} type
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} bpm — beats per minute (one full cycle = one beat)
 * @param {number} min — minimum position (0-100)
 * @param {number} max — maximum position (0-100)
 * @returns {Array<{at: number, pos: number}>}
 */
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
  const range = max - min;
  let t = startMs;

  while (t <= endMs) {
    // Bottom of stroke
    result.push({ at: Math.round(t), pos: min });
    // Top of stroke (end of cycle)
    const topT = Math.min(t + cycleDurationMs, endMs);
    result.push({ at: Math.round(topT), pos: max });
    t += cycleDurationMs;
  }

  return _dedupeByTime(result);
}

function _squarePattern(startMs, endMs, durationMs, cycleDurationMs, minStepMs, min, max) {
  const result = [];
  const halfCycle = cycleDurationMs / 2;
  let t = startMs;

  while (t <= endMs) {
    result.push({ at: Math.round(t), pos: max });
    const midT = Math.min(t + halfCycle, endMs);
    result.push({ at: Math.round(midT), pos: max });
    if (midT < endMs) {
      result.push({ at: Math.round(midT), pos: min });
      const endT = Math.min(t + cycleDurationMs, endMs);
      result.push({ at: Math.round(endT), pos: min });
    }
    t += cycleDurationMs;
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

/** Remove consecutive actions with the same timestamp, keeping the last one. */
function _dedupeByTime(actions) {
  if (actions.length <= 1) return actions;
  const result = [];
  for (let i = 0; i < actions.length; i++) {
    // If the next action has the same timestamp, skip this one
    if (i < actions.length - 1 && actions[i].at === actions[i + 1].at) continue;
    result.push(actions[i]);
  }
  return result;
}
