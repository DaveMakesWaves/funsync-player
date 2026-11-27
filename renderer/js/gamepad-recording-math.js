// Gamepad recording: the pure parts (editor work list 2.6, 2026-11-24).
//
// OpenFunscripter's recording mode records two axes at once from a
// controller (src/OFS_ScriptingMode.cpp, RecordingMode::twoAxisRecording):
// left stick X goes to the roll script and Y to the pitch script, one point
// per app frame while the video plays, and its Simplify (Ramer-Douglas-
// Peucker, src/UI/OFS_SpecialFunctions.cpp) is a separate manual step. A
// point per frame is 60 points a second per axis, which nobody can edit, so
// FunSync reduces each take to keyframes as it lands. What lives here:
//
//   stickToPos        a raw stick value (-1..1) to a funscript position.
//   samplesToActions  a take's samples to keyframes (RDP, turning points kept).
//   mergeRecorded     the take replaces what the axis had in [t0, t1].
//   landTake          the same on an EditableScript, as ONE undo step.
//
// No DOM, no timers: the recorder (gamepad-recorder.js) owns those.

/** Stick travel ignored around the centre (fraction of full travel). OFS uses
 *  1750 / 32767 (~0.05); worn pads drift further than that at rest, and a
 *  drifting stick would record a wobble into every quiet stretch. */
export const DEFAULT_DEADZONE = 0.1;

/** How far (in positions, 0-100) a keyframe line may stray from what the
 *  stick did. 2 is the editor's own Simplify default (EditableScript.simplify). */
export const DEFAULT_EPSILON = 2;

/** No two keyframes closer than this. One frame at 30 fps, the editor's own
 *  fallback frame (ScriptEditor._frameDurationMs); pass the video's frame. */
export const DEFAULT_MIN_INTERVAL_MS = 1000 / 30;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A raw stick axis value to a position, centred as OFS's controller mode is
 * by default ("Center": rest = 50, full travel = 0 or 100). Inside the
 * deadzone the stick reads as centred; outside it the remaining travel is
 * stretched back to the full range (OFS does the same), so a full push
 * still reaches 0 / 100.
 *
 * @param {number} raw — Gamepad API axis value, -1..1
 * @param {object} [o]
 * @param {number} [o.deadzone] — 0..0.95
 * @param {boolean} [o.up] — a vertical axis: the Gamepad API reads -1 at the
 *   top, and up must be 100 (OFS negates Y the same way)
 * @param {boolean} [o.invert] — the user's own flip, on top of `up`
 * @returns {number} 0..100 (not rounded: samplesToActions rounds once)
 */
export function stickToPos(raw, { deadzone = DEFAULT_DEADZONE, up = false, invert = false } = {}) {
  let v = Number(raw);
  if (!Number.isFinite(v)) v = 0;
  v = clamp(v, -1, 1);
  const dz = clamp(Number(deadzone) || 0, 0, 0.95);
  const m = Math.abs(v);
  v = m <= dz ? 0 : Math.sign(v) * ((m - dz) / (1 - dz));
  if (up) v = -v;
  if (invert) v = -v;
  return clamp(50 + 50 * v, 0, 100);
}

/**
 * Samples to parallel arrays of whole ms / whole positions in time order,
 * one per time (of samples on one time the last wins: the newest stick
 * reading). A funscript holds whole numbers only, so the simplification
 * works on what can be written and its error bound holds for the file.
 * @param {Array<{at:number,pos:number}>} samples
 * @returns {{at:number[], pos:number[]}}
 */
export function normalizeSamples(samples) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(Number(s.at)) && Number.isFinite(Number(s.pos)))
    .map((s, i) => ({ at: Math.round(Number(s.at)), pos: Math.round(clamp(Number(s.pos), 0, 100)), i }));
  list.sort((a, b) => a.at - b.at || a.i - b.i);
  const at = [];
  const pos = [];
  for (const s of list) {
    if (at.length && at[at.length - 1] === s.at) { pos[pos.length - 1] = s.pos; continue; }
    at.push(s.at);
    pos.push(s.pos);
  }
  return { at, pos };
}

/**
 * The turning points: where the motion reverses after travelling at least
 * `threshold` (a zigzag with hysteresis, so stick jitter smaller than the
 * threshold makes none). Each is the sample AT the extreme (the first one of
 * a plateau), so a stroke's top and bottom land on the exact position the
 * stick reached. Plain RDP can pick a sample next to the peak instead,
 * which shaves the stroke. Indices, ascending, never the first or last.
 * @param {number[]} pos
 * @param {number} threshold
 * @returns {number[]}
 */
export function turningPoints(pos, threshold) {
  const out = [];
  const n = pos.length;
  if (n < 3 || !(threshold > 0)) return out;
  let dir = 0;
  let ext = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < n; i++) {
    const p = pos[i];
    if (dir === 0) {
      if (p > pos[hi]) hi = i;
      if (p < pos[lo]) lo = i;
      if (pos[hi] - pos[lo] >= threshold) {
        if (hi > lo) { if (lo > 0) out.push(lo); dir = 1; ext = hi; } else { if (hi > 0) out.push(hi); dir = -1; ext = lo; }
      }
    } else if (dir > 0) {
      if (p > pos[ext]) ext = i;
      else if (pos[ext] - p >= threshold) { out.push(ext); dir = -1; ext = i; }
    } else if (p < pos[ext]) {
      ext = i;
    } else if (p - pos[ext] >= threshold) {
      out.push(ext); dir = 1; ext = i;
    }
  }
  return out;
}

/**
 * Ramer-Douglas-Peucker between two kept samples, marking more in `keep`.
 * The distance is VERTICAL (the position error at that sample's time), not
 * perpendicular: what a device plays is the line's position at each moment,
 * and a perpendicular distance mixes ms with positions (the editor's Simplify
 * rescales time to make them comparable; this needs no scale). Iterative, so
 * a long take cannot overflow the stack.
 */
function rdpVertical(at, pos, first, last, epsilon, keep) {
  const stack = [first, last];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    if (b - a < 2) continue;
    const t0 = at[a];
    const p0 = pos[a];
    const slope = (pos[b] - p0) / (at[b] - t0);
    let worst = -1;
    let dmax = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(pos[i] - (p0 + slope * (at[i] - t0)));
      if (d > dmax) { dmax = d; worst = i; }
    }
    if (dmax > epsilon) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
}

/**
 * A take's samples to keyframes.
 *
 *  1. Whole ms and positions, one sample per time (normalizeSamples).
 *  2. The first and last sample and every turning point are kept.
 *  3. RDP between each pair of those: every sample is then within `epsilon`
 *     of the line through the keyframes (the bound the tests check).
 *  4. With `snap`, keyframe times go through it (the editor's snapTime, to
 *     put them on frame starts).
 *  5. No two keyframes closer than `minIntervalMs`: of two too close, the
 *     turning point (or the take's last point) stays. Rounded down to whole
 *     ms, as frame starts rounded to whole ms are 33 and 34 ms apart at
 *     29.97 fps and both must pass. This is the one step that can stray past
 *     epsilon; it only ever drops a point within a frame of a kept one.
 *
 * @param {Array<{at:number,pos:number}>} samples
 * @param {object} [o]
 * @param {number} [o.epsilon]
 * @param {number} [o.minIntervalMs]
 * @param {(ms:number)=>number} [o.snap]
 * @returns {Array<{at:number,pos:number}>} whole numbers, ascending, no two on one time
 */
export function samplesToActions(samples, { epsilon = DEFAULT_EPSILON, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, snap = null } = {}) {
  const { at, pos } = normalizeSamples(samples);
  const n = at.length;
  if (n === 0) return [];
  if (n === 1) return [{ at: snapped(at[0], snap), pos: pos[0] }];
  const eps = Math.max(0, Number(epsilon) || 0);

  const keep = new Uint8Array(n);
  const forced = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  forced[0] = 1; forced[n - 1] = 1;
  for (const i of turningPoints(pos, Math.max(eps, 1))) { keep[i] = 1; forced[i] = 1; }
  let prev = 0;
  for (let i = 1; i < n; i++) {
    if (!forced[i]) continue;
    rdpVertical(at, pos, prev, i, eps, keep);
    prev = i;
  }

  const minGap = Math.max(1, Math.floor(Number(minIntervalMs) || 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const point = { at: snapped(at[i], snap), pos: pos[i], forced: forced[i] === 1 };
    const last = out[out.length - 1];
    if (!last || point.at - last.at >= minGap) { out.push(point); continue; }
    // Too close to the one before. The take's first point always stays;
    // otherwise its last point or a turning point replaces a plain one.
    const isEnd = i === n - 1;
    if (out.length > 1 && (isEnd || (point.forced && !last.forced))) out[out.length - 1] = point;
  }
  return out.map(({ at: t, pos: p }) => ({ at: t, pos: p }));
}

function snapped(ms, snap) {
  if (typeof snap !== 'function') return ms;
  const v = Number(snap(ms));
  return Number.isFinite(v) ? Math.round(v) : ms;
}

/**
 * The position the line through `actions` (ascending) gives at `at`; the
 * first / last position outside them; null with no actions.
 */
export function interpolateAt(actions, at) {
  const n = actions.length;
  if (n === 0) return null;
  if (at <= actions[0].at) return actions[0].pos;
  if (at >= actions[n - 1].at) return actions[n - 1].pos;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (actions[mid].at <= at) lo = mid; else hi = mid;
  }
  const a = actions[lo];
  const b = actions[hi];
  return a.pos + ((b.pos - a.pos) * (at - a.at)) / (b.at - a.at);
}

/**
 * The largest vertical distance between the samples (normalised as
 * samplesToActions sees them) and the keyframes' line. 0 for none.
 */
export function maxDeviation(samples, actions) {
  const { at, pos } = normalizeSamples(samples);
  let worst = 0;
  for (let i = 0; i < at.length; i++) {
    const v = interpolateAt(actions, at[i]);
    if (v !== null) worst = Math.max(worst, Math.abs(pos[i] - v));
  }
  return worst;
}

/**
 * The axis after a take: every point in [t0, t1] (both ends included) goes,
 * the take's points go in, everything outside stays. A new array of new
 * objects, ascending. An empty take changes nothing: a take never deletes
 * the points it would have replaced (EditableScript.replaceRange's rule).
 * Take points outside [t0, t1] are ignored, so the edges mean one thing.
 *
 * @param {Array<{at:number,pos:number}>} existing
 * @param {Array<{at:number,pos:number}>} recorded
 * @param {number} t0
 * @param {number} t1
 * @returns {Array<{at:number,pos:number}>}
 */
export function mergeRecorded(existing, recorded, t0, t1) {
  const old = (Array.isArray(existing) ? existing : []).map((p) => ({ at: p.at, pos: p.pos }));
  old.sort((a, b) => a.at - b.at);
  const a = Number(t0);
  const b = Number(t1);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return old;
  const byAt = new Map();
  for (const p of Array.isArray(recorded) ? recorded : []) {
    if (!p || !Number.isFinite(Number(p.at)) || !Number.isFinite(Number(p.pos))) continue;
    const at = Math.round(Number(p.at));
    if (at < a || at > b) continue;
    byAt.set(at, { at, pos: Math.round(clamp(Number(p.pos), 0, 100)) });
  }
  if (byAt.size === 0) return old;
  const fresh = [...byAt.values()].sort((x, y) => x.at - y.at);
  const kept = old.filter((p) => p.at < a || p.at > b);
  const out = [];
  let k = 0;
  for (const p of fresh) {
    while (k < kept.length && kept[k].at < p.at) out.push(kept[k++]);
    out.push(p);
  }
  while (k < kept.length) out.push(kept[k++]);
  return out;
}

/**
 * Put a recording's takes on one axis as ONE undo step (FunSync's undo is
 * per axis, Dave 2026-11-24, so a two-axis recording is one step on each).
 * Takes apply in order, a later one winning where they overlap (a seek back
 * into a stretch recorded a moment earlier), exactly as mergeRecorded.
 * Duck-typed on EditableScript: beginBatch / deleteActions / insertActions /
 * endBatch. The recorded points become the selection and the "New points"
 * record (insertActions); a take that changes nothing leaves no undo step
 * (endBatch drops it).
 *
 * @param {import('./editable-script.js').EditableScript} es
 * @param {Array<{t0:number,t1:number,actions:Array<{at:number,pos:number}>}>} segments
 * @returns {{changed:boolean, created:number, removed:number}}
 */
export function landTake(es, segments) {
  const usable = (Array.isArray(segments) ? segments : []).filter((s) => s
    && Number.isFinite(Number(s.t0)) && Number.isFinite(Number(s.t1)) && Number(s.t1) >= Number(s.t0)
    && Array.isArray(s.actions) && s.actions.length > 0);
  const none = { changed: false, created: 0, removed: 0 };
  if (!es || usable.length === 0) return none;

  const before = es.actions.map((p) => ({ at: p.at, pos: p.pos }));
  let after = before;
  for (const s of usable) after = mergeRecorded(after, s.actions, s.t0, s.t1);
  const inside = (at) => usable.some((s) => at >= Number(s.t0) && at <= Number(s.t1));
  const doomed = new Set();
  es.actions.forEach((p, i) => { if (inside(p.at)) doomed.add(i); });
  const fresh = after.filter((p) => inside(p.at));
  if (fresh.length === 0) return none;

  es.beginBatch();
  try {
    if (doomed.size) es.deleteActions(doomed);
    es.insertActions(fresh);
  } finally {
    es.endBatch();
  }
  const now = es.actions;
  const changed = now.length !== before.length || now.some((p, i) => p.at !== before[i].at || p.pos !== before[i].pos);
  return { changed, created: changed ? fresh.length : 0, removed: changed ? doomed.size : 0 };
}

/**
 * One take (the recorder's) to what lands on each axis: keyframes for A and
 * for B, and the range they replace. The range is the take's own, in whole
 * ms, widened to take in any keyframe a `snap` moved just outside it (a frame
 * start before the first sample): mergeRecorded ignores points outside its
 * range, and the take's first point must not be one of them.
 * `opts` go to samplesToActions.
 * @param {{t0:number,t1:number,a:Array,b:Array}} take
 * @returns {{t0:number,t1:number,a:Array<{at:number,pos:number}>,b:Array<{at:number,pos:number}>}|null}
 */
export function takeToKeyframes(take, opts = {}) {
  if (!take || !Number.isFinite(take.t0) || !Number.isFinite(take.t1)) return null;
  const a = samplesToActions(take.a, opts);
  const b = samplesToActions(take.b, opts);
  const ends = [Math.round(take.t0), Math.round(take.t1)];
  for (const list of [a, b]) if (list.length) ends.push(list[0].at, list[list.length - 1].at);
  return { t0: Math.min(...ends), t1: Math.max(...ends), a, b };
}
