// The device simulator's other axes, the maths (editor work list 2.5,
// 2026-11-24). Pure: no DOM, so node tests run it as it ships.
//
// A video can carry more than the stroke: surge L1, sway L2, twist R0, roll
// R1, pitch R2, and vibe / pump / valve / suction / lube (multi-axis.js
// AXIS_DEFINITIONS). The simulator showed the stroke alone. It now shows the
// axes the video has, in the look chosen on its right-click menu: the 3D
// receiver (sim-receiver-3d.js, the default, Dave 2026-11-24) or one of three
// lighter 2D looks for a PC that struggles with 3D (sim-axes-view.js).
// Every look takes its ranges and directions from SIM_MOTION below, so they
// all move the same way.
import { AXIS_DEFINITIONS, getAxisBySuffix } from './multi-axis.js';

/**
 * Where each axis puts the receiver at 0 and at 100 (its rest is 50, the
 * middle): OFS's own numbers, so people moving over from OpenFunscripter
 * see the same motion (Dave 2026-11-24: "less of a visual learning curve").
 * From OFS_Simulator3D (Godot), Simulator3D.cs, in its units: a cylinder of
 * radius 0.5 and height 1.75, x to the right, y up, z toward its camera
 * (which looks straight on from +z, our Front view). ONE place, so a range
 * or a direction is changed for every look at once; swap a pair to turn an
 * axis round.
 *   - stroke L0: y from -1 to 1 (Lerp(-1, 1));
 *   - surge L1:  x from -0.5 to 0.5, 100 = to the right;
 *   - sway L2:   z from 0.5 to -0.5 (reversed), 100 = away from the camera;
 *   - pitch R2:  GlobalRotate(Right) from 45° to -45°: 0 = the top toward
 *                the camera, 100 = away from it;
 *   - roll R1:   GlobalRotate(Forward) from -45° to 45°: 100 = the top
 *                leaning to the right;
 *   - twist R0:  RotateObjectLocal(Up) from -120° to 120°: 100 = the front
 *                turned to the right (anticlockwise seen from above).
 * The rotations turn the receiver about its own centre: twist about its own
 * axis first, then pitch and roll about the world's axes.
 */
export const SIM_MOTION = Object.freeze({
  STROKE_Y: Object.freeze([-1, 1]),
  SURGE_X: Object.freeze([-0.5, 0.5]),
  SWAY_Z: Object.freeze([0.5, -0.5]),
  PITCH_DEG: Object.freeze([45, -45]),
  ROLL_DEG: Object.freeze([-45, 45]),
  TWIST_DEG: Object.freeze([-120, 120]),
  /** OFS's receiver, the unit the offsets above are in. */
  OFS_RADIUS: 0.5,
  OFS_HALF_HEIGHT: 0.875,
});

/** The axes that move the receiver (besides the stroke). */
export const SIM_RECEIVER_AXES = Object.freeze(['surge', 'sway', 'twist', 'roll', 'pitch']);

/** Every axis the simulator can show, canonical suffixes, in AXIS_DEFINITIONS order. */
export const SIM_AXIS_ORDER = Object.freeze(AXIS_DEFINITIONS.map((a) => a.suffix));

/** Index of each canonical suffix in SIM_AXIS_ORDER (the per-frame arrays are indexed by it). */
export const SIM_AXIS_INDEX = Object.freeze(Object.fromEntries(SIM_AXIS_ORDER.map((s, i) => [s, i])));

const DEG = Math.PI / 180;
const clampPos = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50);

/**
 * One axis at `timeMs`, written into `outPos[i]` / `outSpeed[i]` (no object
 * per call: this runs per axis per frame). The position is linear between
 * the two points around the time, as FunscriptEngine.getPositionAt
 * interpolates the stroke (the first point's before the script, the last's
 * after it); the speed is that stretch's, in units per ms (0 outside the
 * script), for the speed colours. Points are expected sorted by time, as the
 * engines and the editor keep them.
 * @returns {boolean} false for no points or no time (nothing written)
 */
export function sampleAxisInto(actions, timeMs, outPos, outSpeed, i) {
  if (!Array.isArray(actions) || actions.length === 0 || !Number.isFinite(timeMs)) return false;
  const n = actions.length;
  const first = actions[0];
  const last = actions[n - 1];
  if (n === 1 || timeMs <= first.at) { outPos[i] = clampPos(first.pos); outSpeed[i] = 0; return true; }
  if (timeMs >= last.at) { outPos[i] = clampPos(last.pos); outSpeed[i] = 0; return true; }
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (actions[mid].at <= timeMs) lo = mid;
    else hi = mid;
  }
  const a = actions[lo];
  const b = actions[hi];
  const dt = b.at - a.at;
  if (!(dt > 0)) { outPos[i] = clampPos(b.pos); outSpeed[i] = 0; return true; }
  outPos[i] = clampPos(a.pos + ((timeMs - a.at) / dt) * (b.pos - a.pos));
  outSpeed[i] = Math.abs(b.pos - a.pos) / dt;
  return true;
}

/** sampleAxisInto as a value: `{pos, speed}` or null (tests, one-off reads). */
export function sampleAxis(actions, timeMs) {
  const pos = [0];
  const speed = [0];
  return sampleAxisInto(actions, timeMs, pos, speed, 0) ? { pos: pos[0], speed: speed[0] } : null;
}

/**
 * The axes a source has, in SIM_AXIS_ORDER. `source(suffix)` is asked once
 * per canonical suffix and answers that axis's points or null; an axis with
 * no points is left out. A source that throws counts as having none.
 * @param {(suffix: string) => Array<{at: number, pos: number}>|null} source
 * @returns {Array<{suffix: string, actions: Array<{at: number, pos: number}>}>}
 */
export function collectSimAxes(source) {
  const out = [];
  if (typeof source !== 'function') return out;
  for (const suffix of SIM_AXIS_ORDER) {
    let actions = null;
    try { actions = source(suffix); } catch { actions = null; }
    if (Array.isArray(actions) && actions.length > 0) out.push({ suffix, actions });
  }
  return out;
}

/**
 * A source over fixed data: a Map or a plain object of suffix → points,
 * under any spelling AXIS_DEFINITIONS accepts (`vibe`, `R0`, `suction` …).
 * The first spelling found for an axis wins.
 * @param {Map<string, Array>|Object<string, Array>|null} axes
 * @returns {(suffix: string) => Array|null}
 */
export function axisSourceFrom(axes) {
  const byAxis = new Map();
  const entries = axes instanceof Map ? [...axes] : Object.entries(axes || {});
  for (const [key, actions] of entries) {
    const canon = getAxisBySuffix(key)?.suffix;
    if (canon && !byAxis.has(canon) && Array.isArray(actions)) byAxis.set(canon, actions);
  }
  return (suffix) => byAxis.get(getAxisBySuffix(suffix)?.suffix) || null;
}

/** Centred on 50 (the receiver axes, whose rest is the middle) or filled from 0. */
export function isCentredAxis(suffix) {
  return SIM_RECEIVER_AXES.includes(getAxisBySuffix(suffix)?.suffix);
}

/**
 * The receiver's pose from the positions, with SIM_MOTION's ranges, in
 * OFS's units: `x` (surge), `y` (stroke) and `z` (sway) offsets of its
 * centre, and `pitch` (about the world's right, +x), `roll` (about the
 * world's forward, -z) and `twist` (about its own up) in radians, each the
 * angle OFS turns by. An axis the video does not have rests at 50. `stroke`
 * is the bar's position as drawn (flipped already), so the receiver moves
 * as the bar does. Written into `out` when given (the per-frame path
 * allocates nothing). Each look scales the offsets to its own model
 * (SIM_MOTION.OFS_RADIUS / OFS_HALF_HEIGHT).
 * @param {{surge?: number, sway?: number, twist?: number, roll?: number, pitch?: number}} values 0-100
 * @param {number} stroke 0-100
 */
export function simPose(values = {}, stroke = 50, out = {}) {
  const M = SIM_MOTION;
  const f = (v) => clampPos(Number.isFinite(v) ? v : 50) / 100;
  const lerp = (pair, t) => pair[0] + (pair[1] - pair[0]) * t;
  out.x = lerp(M.SURGE_X, f(values.surge));
  out.y = lerp(M.STROKE_Y, f(stroke));
  out.z = lerp(M.SWAY_Z, f(values.sway));
  out.pitch = lerp(M.PITCH_DEG, f(values.pitch)) * DEG;
  out.roll = lerp(M.ROLL_DEG, f(values.roll)) * DEG;
  out.twist = lerp(M.TWIST_DEG, f(values.twist)) * DEG;
  return out;
}

/**
 * Turn a point (or a direction, `withMove` false) of the receiver's own
 * model by a pose: twist about its own up, then pitch about the world's
 * right, then roll about the world's forward (-z), as OFS turns its
 * receiver; then move it by the pose's offsets times `scaleXZ` / `scaleY`.
 * `out` is written and returned.
 */
export function poseApply(pose, px, py, pz, out, scaleXZ = 1, scaleY = 1, withMove = true) {
  // RotateObjectLocal(Up, twist): about +y.
  let c = Math.cos(pose.twist); let s = Math.sin(pose.twist);
  let x = px * c + pz * s;
  let y = py;
  let z = -px * s + pz * c;
  // GlobalRotate(Right, pitch): about +x.
  c = Math.cos(pose.pitch); s = Math.sin(pose.pitch);
  const y1 = y * c - z * s;
  z = y * s + z * c;
  y = y1;
  // GlobalRotate(Forward, roll): about -z, so about +z by -roll.
  c = Math.cos(-pose.roll); s = Math.sin(-pose.roll);
  const x1 = x * c - y * s;
  y = x * s + y * c;
  x = x1;
  if (withMove) {
    x += pose.x * scaleXZ;
    y += pose.y * scaleY;
    z += pose.z * scaleXZ;
  }
  out.x = x; out.y = y; out.z = z;
  return out;
}

/**
 * The heatmap's speed colour (heatmap-palette.js heatmapSpeedToColor, the
 * same stops) as numbers into `out` [r, g, b], for the 3D receiver, which
 * shades its colour and so needs the parts. Pinned to the palette by a test.
 * @param {number} speed units per ms
 */
export function heatRgbInto(speed, out) {
  const n = Math.min(Math.max(Number.isFinite(speed) ? speed : 0, 0) / 0.5, 1);
  let r; let g; let b;
  if (n < 0.25) { const t = n / 0.25; r = 0; g = Math.round(t * 200); b = Math.round(255 - t * 55); }
  else if (n < 0.5) { const t = (n - 0.25) / 0.25; r = 0; g = Math.round(200 + t * 55); b = Math.round(200 - t * 200); }
  else if (n < 0.75) { const t = (n - 0.5) / 0.25; r = Math.round(t * 255); g = 255; b = 0; }
  else { const t = (n - 0.75) / 0.25; r = 255; g = Math.round(255 - t * 255); b = 0; }
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}

// ---- The "Drawing and numbers" look: a line drawing of the receiver ----

/**
 * The line drawing's camera: the 3D receiver's three-quarter view
 * (sim-receiver-3d.js SIM3D_VIEWS.quarter), so switching looks keeps the
 * same picture of the motion.
 */
export const SIM_DRAWING_VIEW = Object.freeze({ yaw: -35, elevation: 22 });
/**
 * The line drawing's receiver, in its own units: squat (OFS's is 3.5 radii
 * tall), so it reads at 88 px; the offsets are OFS's scaled to it.
 */
export const SIM_DRAWING_SHAPE = Object.freeze({ length: 0.8, radius: 0.25, segments: 32 });

function rotX(p, a) {
  const c = Math.cos(a); const s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}
function rotY(p, a) {
  const c = Math.cos(a); const s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

/**
 * The line drawing's receiver for a pose (simPose), as seen by its camera:
 * screen units centred on 0 (x right, y DOWN, as a canvas), each point
 * flagged `front` when it is on the near side of its ring.
 *   - `top` / `bottom`: the two rings;
 *   - `sides`: the two outline lines joining them (none when it points at the camera);
 *   - `topCentre`, `bottomCentre`;
 *   - `marker`: the point on the top ring that twist turns (at rest: the side facing the viewer).
 * Redrawn only when a value changes, so it allocates freely.
 */
export function projectReceiver(pose) {
  const { length, radius, segments } = SIM_DRAWING_SHAPE;
  const half = length / 2;
  const yaw = SIM_DRAWING_VIEW.yaw * DEG;
  const elev = SIM_DRAWING_VIEW.elevation * DEG;
  const sXZ = radius / SIM_MOTION.OFS_RADIUS;
  const sY = half / SIM_MOTION.OFS_HALF_HEIGHT;
  const toView = (p) => {
    const q = poseApply(pose, p.x, p.y, p.z, {}, sXZ, sY);
    return rotX(rotY(q, yaw), elev);
  };
  const screen = (q) => ({ x: q.x, y: -q.y });
  const ring = (y) => {
    const c = toView({ x: 0, y, z: 0 });
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * 2 * Math.PI;
      const q = toView({ x: radius * Math.sin(a), y, z: radius * Math.cos(a) });
      pts.push({ ...screen(q), front: q.z >= c.z - 1e-9 });
    }
    return { centre: screen(c), pts };
  };
  const top = ring(half);
  const bottom = ring(-half);
  // The outline: the ring points furthest either side of the axis on screen.
  const ax = top.centre.x - bottom.centre.x;
  const ay = top.centre.y - bottom.centre.y;
  const len = Math.hypot(ax, ay);
  const sides = [];
  if (len > 1e-6) {
    const nx = -ay / len;
    const ny = ax / len;
    let iMax = 0; let iMin = 0; let dMax = -Infinity; let dMin = Infinity;
    top.pts.forEach((p, i) => {
      const d = (p.x - top.centre.x) * nx + (p.y - top.centre.y) * ny;
      if (d > dMax) { dMax = d; iMax = i; }
      if (d < dMin) { dMin = d; iMin = i; }
    });
    sides.push([top.pts[iMax], bottom.pts[iMax]], [top.pts[iMin], bottom.pts[iMin]]);
  }
  const mq = toView({ x: 0, y: half, z: radius });
  const tc = toView({ x: 0, y: half, z: 0 });
  return {
    top: top.pts,
    bottom: bottom.pts,
    sides,
    topCentre: top.centre,
    bottomCentre: bottom.centre,
    marker: { ...screen(mq), front: mq.z >= tc.z - 1e-9 },
  };
}
