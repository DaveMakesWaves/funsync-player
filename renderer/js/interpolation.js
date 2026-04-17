// Interpolation — PCHIP, Makima, Linear, and Step interpolation for funscript playback
// Pure functions, no side effects, fully testable.

/**
 * Binary search for the interval containing timeMs.
 * Returns index i such that actions[i].at <= timeMs < actions[i+1].at.
 * Returns -1 if timeMs is before the first action.
 * Returns actions.length - 1 if timeMs is at or past the last action.
 * @param {Array<{at: number}>} actions — sorted by time
 * @param {number} timeMs
 * @returns {number}
 */
export function findInterval(actions, timeMs) {
  if (!actions || actions.length === 0) return -1;
  if (timeMs < actions[0].at) return -1;
  if (timeMs >= actions[actions.length - 1].at) return actions.length - 1;

  let lo = 0;
  let hi = actions.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (actions[mid].at <= timeMs) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Linear interpolation between two points.
 * @param {Array<{at: number, pos: number}>} actions
 * @param {number} timeMs
 * @returns {number|null} position 0-100, or null if out of range
 */
export function linearInterpolate(actions, timeMs) {
  if (!actions || actions.length === 0) return null;
  if (actions.length === 1) return actions[0].pos;

  const i = findInterval(actions, timeMs);
  if (i < 0) return actions[0].pos;
  if (i >= actions.length - 1) return actions[actions.length - 1].pos;

  const a = actions[i];
  const b = actions[i + 1];
  const dt = b.at - a.at;
  if (dt <= 0) return a.pos;

  const t = (timeMs - a.at) / dt;
  return a.pos + t * (b.pos - a.pos);
}

/**
 * Step interpolation — hold the previous value until the next action.
 * Best for vibration axes where instant on/off transitions are desired.
 * @param {Array<{at: number, pos: number}>} actions
 * @param {number} timeMs
 * @returns {number|null}
 */
export function stepInterpolate(actions, timeMs) {
  if (!actions || actions.length === 0) return null;

  const i = findInterval(actions, timeMs);
  if (i < 0) return 0; // before first action — off
  return actions[i].pos;
}

/**
 * PCHIP (Piecewise Cubic Hermite Interpolating Polynomial) — Fritsch-Carlson method.
 * Shape-preserving, monotone, no overshoot. The gold standard for funscript smoothing.
 *
 * @param {Array<{at: number, pos: number}>} actions — sorted by time, length >= 2
 * @param {number} timeMs
 * @returns {number|null} position 0-100, or null if out of range
 */
export function pchipInterpolate(actions, timeMs) {
  if (!actions || actions.length === 0) return null;
  if (actions.length === 1) return actions[0].pos;
  if (actions.length === 2) return linearInterpolate(actions, timeMs);

  const i = findInterval(actions, timeMs);
  if (i < 0) return actions[0].pos;
  if (i >= actions.length - 1) return actions[actions.length - 1].pos;

  const n = actions.length;

  // Compute slopes between consecutive points
  const h = actions[i + 1].at - actions[i].at;
  if (h <= 0) return actions[i].pos;

  // Get derivatives at points i and i+1
  const di = _pchipDerivative(actions, i);
  const di1 = _pchipDerivative(actions, i + 1);

  // Normalize t to [0, 1] within this interval
  const t = (timeMs - actions[i].at) / h;

  // Evaluate cubic Hermite
  const p0 = actions[i].pos;
  const p1 = actions[i + 1].pos;
  const result = _hermite(t, p0, p1, di * h, di1 * h);

  return clamp(result, 0, 100);
}

/**
 * Compute PCHIP derivative at point k using Fritsch-Carlson rules.
 * @param {Array<{at: number, pos: number}>} actions
 * @param {number} k — index
 * @returns {number} derivative (slope) at point k
 */
function _pchipDerivative(actions, k) {
  const n = actions.length;

  // Endpoint: one-sided
  if (k === 0) {
    return _endpointDerivative(actions, 0, 1);
  }
  if (k === n - 1) {
    return _endpointDerivative(actions, n - 1, n - 2);
  }

  // Interior point: weighted harmonic mean of adjacent slopes
  const h0 = actions[k].at - actions[k - 1].at;
  const h1 = actions[k + 1].at - actions[k].at;
  if (h0 <= 0 || h1 <= 0) return 0;

  const delta0 = (actions[k].pos - actions[k - 1].pos) / h0;
  const delta1 = (actions[k + 1].pos - actions[k].pos) / h1;

  // If slopes have different signs or either is zero → derivative is zero (prevents overshoot)
  if (delta0 * delta1 <= 0) return 0;

  // Weighted harmonic mean
  const w1 = 2 * h1 + h0;
  const w2 = h1 + 2 * h0;
  return (w1 + w2) / (w1 / delta0 + w2 / delta1);
}

/**
 * One-sided derivative for endpoint.
 */
function _endpointDerivative(actions, k, adj) {
  const h = actions[adj].at - actions[k].at;
  if (h === 0) return 0;
  return (actions[adj].pos - actions[k].pos) / h;
}

/**
 * Makima (Modified Akima) interpolation.
 * Less aggressive flattening than PCHIP, slight overshoot allowed.
 * Better for oscillatory motion patterns.
 *
 * @param {Array<{at: number, pos: number}>} actions — sorted, length >= 2
 * @param {number} timeMs
 * @returns {number|null}
 */
export function makimaInterpolate(actions, timeMs) {
  if (!actions || actions.length === 0) return null;
  if (actions.length === 1) return actions[0].pos;
  if (actions.length <= 3) return linearInterpolate(actions, timeMs);

  const i = findInterval(actions, timeMs);
  if (i < 0) return actions[0].pos;
  if (i >= actions.length - 1) return actions[actions.length - 1].pos;

  const h = actions[i + 1].at - actions[i].at;
  if (h <= 0) return actions[i].pos;

  const di = _makimaDerivative(actions, i);
  const di1 = _makimaDerivative(actions, i + 1);

  const t = (timeMs - actions[i].at) / h;
  const p0 = actions[i].pos;
  const p1 = actions[i + 1].pos;
  const result = _hermite(t, p0, p1, di * h, di1 * h);

  return clamp(result, 0, 100);
}

/**
 * Compute Makima derivative at point k.
 * Uses weighted average based on adjacent slope differences.
 */
function _makimaDerivative(actions, k) {
  const n = actions.length;

  // Need at least 2 points on each side for full Makima
  // Fall back to simple for near-boundary points
  if (k <= 1 || k >= n - 2) {
    return _pchipDerivative(actions, k); // reuse PCHIP for endpoints
  }

  // Compute 4 surrounding slopes
  const d = [];
  for (let j = k - 2; j < k + 2; j++) {
    const h = actions[j + 1].at - actions[j].at;
    d.push(h > 0 ? (actions[j + 1].pos - actions[j].pos) / h : 0);
  }

  // Weights based on slope differences
  const w1 = Math.abs(d[3] - d[2]) + Math.abs(d[3] + d[2]) / 2;
  const w2 = Math.abs(d[1] - d[0]) + Math.abs(d[1] + d[0]) / 2;

  if (w1 + w2 === 0) return (d[1] + d[2]) / 2;

  return (w1 * d[1] + w2 * d[2]) / (w1 + w2);
}

/**
 * Evaluate cubic Hermite polynomial.
 * @param {number} t — normalized time [0, 1]
 * @param {number} p0 — value at start
 * @param {number} p1 — value at end
 * @param {number} m0 — scaled derivative at start (d * h)
 * @param {number} m1 — scaled derivative at end (d * h)
 * @returns {number}
 */
function _hermite(t, p0, p1, m0, m1) {
  const t2 = t * t;
  const t3 = t2 * t;

  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

/**
 * Clamp value to [min, max].
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Apply speed limiting to a target position.
 * @param {number} targetPos — desired position 0-100
 * @param {number} lastPos — previous sent position
 * @param {number} deltaMs — time since last send
 * @param {number} maxSpeed — maximum speed in pos-units per second (0 = no limit)
 * @returns {number} clamped position
 */
export function applySpeedLimit(targetPos, lastPos, deltaMs, maxSpeed) {
  if (maxSpeed <= 0 || deltaMs <= 0) return targetPos;

  const maxDelta = (maxSpeed * deltaMs) / 1000;
  const actualDelta = Math.abs(targetPos - lastPos);

  if (actualDelta <= maxDelta) return targetPos;

  const direction = targetPos > lastPos ? 1 : -1;
  return lastPos + direction * maxDelta;
}

/**
 * Get the interpolation function by name.
 * @param {'linear'|'pchip'|'makima'|'step'} mode
 * @returns {Function}
 */
export function getInterpolator(mode) {
  switch (mode) {
    case 'pchip': return pchipInterpolate;
    case 'makima': return makimaInterpolate;
    case 'step': return stepInterpolate;
    case 'linear':
    default: return linearInterpolate;
  }
}
