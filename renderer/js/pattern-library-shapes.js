// The six simple shapes as library patterns: the "Simple shapes" group of the
// one pattern picker (pattern settings unification, 2026-11-19; Dave: "Fold
// into the library"; notes/features/DESIGN-pattern-settings-unify.md §3).
// UNCOMMITTED.
//
// Ids shape-sine, shape-triangle, shape-sawtooth, shape-square,
// shape-escalating, shape-random, family 'simple-shapes'. pattern-library.js
// merges them into listFamilies / listPatterns / describePattern /
// renderPattern / renderLoop, so every consumer (the pickers, the editor's
// Fill drawer, X, Z, Gap Filler) sees them. They live here, NOT in the
// generated, privacy-guarded pattern-library-data.js.
//
// They are drawn EXACTLY as before:
//   - renderShape (a stretch of time) is script-modifiers.js generatePattern
//     over [from, from + durationMs]: the same positions, the same rate. Only
//     'random' differs: it draws from a seeded stream (same seed, same
//     strokes) where generatePattern uses Math.random, step for step the same
//     algorithm otherwise.
//   - renderShapeLoop (X and Z) is the Orgasm Switch's "Generated pattern"
//     loop (orgasm-pattern.js buildOrgasmPatternContent, built 2026-11-04 to
//     2026-11-17): about 10 s, whole beats, the edge shapes built beat by beat,
//     'escalating' on the exact beat grid. Same positions at an integer BPM.
//   - Square and sawtooth keep their 1 ms instant edges, as v0.9.2 drew them.
//     Gap Filler ramps them with its slew limiter (filler-engine.js, as
//     before), the Fill drawer with fillRange's constraint pass; X and Z play
//     them as the Generated pattern did (no 600 u/s ceiling on those edges).
//   - Every other leg X and Z play keeps the library's 600 u/s ceiling
//     (pf-review PF-R2, 2026-11-19): renderShapeLoop honours `maxSpeed` by
//     playing the loop slower where a leg would pass it (a sine peaks at
//     1.5-2.6x its set speed). `legacyRate` (an 11-17 Generated pattern read
//     from player.orgasmPattern and not changed since) keeps its own rate, as
//     it always played (pf-engine decision 3).
//
// Speed is units a second (Dave: "Units/s only"). A shape's speed is the
// travel of one full cycle (up the band and back) per cycle length:
//   speed = 2 * width * bpm / 60, so bpm = 30 * speed / width,
// with width the band the shape plays in (never under 1 unit: a flat band has
// no rate of its own, and the conversion stays exact both ways). At an
// integer BPM the round trip gives that BPM back exactly (snapped to 1e-9),
// which is what keeps an upgraded setting's strokes on the same timestamps.
//
// Pure: no DOM, no settings, no devices.

import { generatePattern } from './script-modifiers.js';

export const SHAPE_FAMILY = 'simple-shapes';
/** In the order the Settings dropdowns listed them. */
export const SHAPE_TYPES = Object.freeze(['sine', 'triangle', 'sawtooth', 'square', 'escalating', 'random']);
export const SHAPE_IDS = Object.freeze(SHAPE_TYPES.map((t) => `shape-${t}`));
const SHAPE_ID_SET = new Set(SHAPE_IDS);

/** u/s: a shape's own speed (speed: null): 36 strokes a minute across the whole range. */
export const SHAPE_OWN_SPEED = 120;
/** u/s: the speeds a slider offers for a shape (the library's ceiling on top). */
export const SHAPE_SPEED_RANGE = Object.freeze([10, 600]);
/**
 * u/s: the speeds a stored shape choice may hold. Wider than the slider so an
 * upgraded Generated pattern keeps its rate: 300 BPM (its top) across the
 * whole range is 1000 u/s; 20 BPM (its bottom) in a band 1 unit wide (or a
 * flat one) is 0.67 u/s (pf-review PF-R7: a floor of 1 played those at 30 BPM).
 */
export const SHAPE_SPEED_MIN = 0.5;
export const SHAPE_SPEED_MAX = 1000;
/** Strokes a minute a shape is ever drawn at (guards a narrow band at a high speed). */
export const SHAPE_BPM_MIN = 1;
export const SHAPE_BPM_MAX = 600;
/** ms: a renderShape with no durationMs. */
export const SHAPE_DEFAULT_MS = 10000;
/** ms: the loop length X and Z aim for (orgasm-pattern.js ORGASM_PATTERN_LOOP_TARGET_MS). */
export const SHAPE_LOOP_TARGET_MS = 10000;
/** script-modifiers.js's instant edge: 1 ms, never two points on one ms. */
const EDGE_MS = 1;
/** generatePattern's density cap: one point every 50 ms at most. */
const MIN_STEP_MS = 50;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const finiteOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const snap = (x) => Math.round(x * 1e9) / 1e9;

/** Is `id` one of the six simple shapes? */
export function isShapeId(id) {
  return typeof id === 'string' && SHAPE_ID_SET.has(id);
}

/** 'sine' for 'shape-sine'; null for anything else. */
export function shapeTypeOf(id) {
  return isShapeId(id) ? id.slice(6) : null;
}

/** 'shape-sine' for 'sine'; an unknown type is sine (generatePattern's own fallback). */
export function shapeIdFor(type) {
  return SHAPE_TYPES.includes(type) ? `shape-${type}` : 'shape-sine';
}

/** The width a speed converts at: the band's, never under 1 unit. */
export function shapeWidth(lo, hi) {
  const w = Math.abs(finiteOr(hi, 100) - finiteOr(lo, 0));
  return Math.max(1, w);
}

/** Strokes a minute for `speed` u/s across a band `width` wide (clamped to the shape limits). */
export function shapeBpm(speed, width) {
  const v = finiteOr(Number(speed), SHAPE_OWN_SPEED);
  const bpm = (30 * (v > 0 ? v : SHAPE_OWN_SPEED)) / Math.max(1, finiteOr(width, 100));
  return clamp(snap(bpm), SHAPE_BPM_MIN, SHAPE_BPM_MAX);
}

/** u/s for `bpm` strokes a minute across a band `width` wide: the inverse of shapeBpm. */
export function shapeSpeed(bpm, width) {
  return (finiteOr(Number(bpm), 0) * Math.max(1, finiteOr(width, 100))) / 30;
}

/** What a picker or a slider needs to know about a shape, or null (the shape of describePattern's answer). */
export function describeShape(id) {
  if (!isShapeId(id)) return null;
  return {
    id,
    family: SHAPE_FAMILY,
    kind: 'cycle',
    loopable: true,
    hasBuzz: false,
    speed: SHAPE_OWN_SPEED,
    speedRange: [SHAPE_SPEED_RANGE[0], SHAPE_SPEED_RANGE[1]],
    range: [0, 100],
    strokeMs: Math.round(60000 / shapeBpm(SHAPE_OWN_SPEED, 100)),
    nameKey: `patterns.${id}.name`,
    descKey: `patterns.${id}.desc`,
  };
}

/** A { min, max } or [lo, hi] range as whole numbers 0-100 in order; [0, 100] when not given. */
export function shapeBand(range) {
  if (range === undefined || range === null) return [0, 100];
  const lo = Number(Array.isArray(range) ? range[0] : range.min);
  const hi = Number(Array.isArray(range) ? range[1] : range.max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100];
  const a = clamp(Math.round(Math.min(lo, hi)), 0, 100);
  const b = clamp(Math.round(Math.max(lo, hi)), 0, 100);
  return [a, b];
}

// ---------- seeded random (the library's own streams: mulberry32 + FNV-1a) ----------
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
/** A seeded stream of numbers in [0, 1): the same seed gives the same strokes. */
export function shapeRng(seed = 1, salt = 'shape-random') {
  const r = mulberry32(hash32(`${seed}|${salt}`));
  r();
  return r;
}

/**
 * generatePattern's 'random', with the stream passed in: a point every half
 * cycle (at least 50 ms apart) at a random place in the band, and the end
 * point. Step for step script-modifiers.js _randomPattern.
 */
export function randomShapeActions(startMs, endMs, bpm, min, max, rng = Math.random) {
  if (endMs <= startMs || bpm <= 0) return [];
  const cycleDurationMs = 60000 / bpm;
  const result = [];
  const stepMs = Math.max(MIN_STEP_MS, cycleDurationMs / 2);
  const range = max - min;
  for (let t = startMs; t <= endMs; t += stepMs) {
    result.push({ at: Math.round(t), pos: Math.round(min + rng() * range) });
  }
  if (result.length > 0 && result[result.length - 1].at < Math.round(endMs)) {
    result.push({ at: Math.round(endMs), pos: Math.round(min + rng() * range) });
  }
  return result;
}

/** The shape's actions over [startMs, endMs] at `bpm` in [min, max]: generatePattern's, 'random' from `rng`. */
export function shapeActions(type, startMs, endMs, bpm, min, max, rng = Math.random) {
  if (type === 'random') return randomShapeActions(startMs, endMs, bpm, min, max, rng);
  return generatePattern(type, startMs, endMs, bpm, min, max);
}

const mirrorIn = (actions, lo, hi) => actions.map((a) => ({ at: a.at, pos: lo + hi - a.pos }));

/**
 * Render shape `id` over a stretch of time (renderPattern's options; the ones
 * a shape has no use for are ignored: startPos, startDir, ramp, variation,
 * maxSpeed, allowFast). durationMs (default 10 s), from (default 0), speed
 * (u/s, default SHAPE_OWN_SPEED), range ({ min, max }, default 0-100),
 * reversed (mirrored inside the band), seed ('random' only, default 1).
 * Returns { actions, vib, warnings, params } (no stats: pattern-library.js
 * measures them), or null for an id that is not a shape.
 */
export function renderShape(id, opts = {}) {
  const type = shapeTypeOf(id);
  if (!type) return null;
  const o = opts || {};
  const from = Math.round(finiteOr(o.from, 0));
  const dur = o.durationMs !== undefined && o.durationMs !== null ? Number(o.durationMs) : SHAPE_DEFAULT_MS;
  const until = from + Math.round(dur);
  const [lo, hi] = shapeBand(o.range);
  const asked = o.speed !== undefined && o.speed !== null ? Number(o.speed) : NaN;
  const speed = asked > 0 && Number.isFinite(asked) ? asked : SHAPE_OWN_SPEED;
  const bpm = shapeBpm(speed, hi - lo);
  const seed = o.seed !== undefined && o.seed !== null && o.seed !== '' ? o.seed : 1;
  let actions = shapeActions(type, from, until, bpm, lo, hi, shapeRng(seed))
    .map((a) => ({ at: a.at, pos: clamp(Math.round(a.pos), 0, 100) }));
  if (o.reversed) actions = mirrorIn(actions, lo, hi);
  return {
    actions,
    vib: actions.map(() => false),
    warnings: [],
    params: { from, until, band: [lo, hi], startBand: [lo, hi], seed, bpm, target: speed },
  };
}

// ---------- the loop X and Z play (orgasm-pattern.js's, at any BPM) ----------
/** The beat length and the whole number of beats in one loop near the target. */
function beatGrid(bpm, targetMs) {
  const beatMs = 60000 / bpm;
  const beats = Math.max(1, Math.round(targetMs / beatMs));
  return { beatMs, beats };
}

/** sawtooth / square: generatePattern's own beat, beat after beat, its last point pulled EDGE_MS early. */
function edgeShapeLoop(type, bpm, min, max, targetMs) {
  const { beatMs, beats } = beatGrid(bpm, targetMs);
  const out = [];
  for (let k = 0; k < beats; k++) {
    const start = Math.round(k * beatMs);
    const len = Math.round((k + 1) * beatMs) - start;
    const beat = generatePattern(type, 0, len, bpm, min, max);
    beat[beat.length - 1] = { at: len - EDGE_MS, pos: beat[beat.length - 1].pos };
    for (const a of beat) out.push({ at: start + a.at, pos: a.pos });
  }
  out.push({ at: Math.round(beats * beatMs), pos: out[0].pos });
  return out;
}

/** 'escalating' on the exact beat grid: beat k tops out at min + range * (k + 1) / beats. */
function escalatingLoop(bpm, min, max, targetMs) {
  const { beatMs, beats } = beatGrid(bpm, targetMs);
  const range = max - min;
  const out = [];
  for (let k = 0; k < beats; k++) {
    const progress = (k + 1) / beats;
    out.push({ at: Math.round(k * beatMs), pos: min });
    out.push({ at: Math.round((k + 0.5) * beatMs), pos: Math.round(min + range * progress) });
  }
  out.push({ at: Math.round(beats * beatMs), pos: min });
  return out;
}

/** sine, triangle, random: drawn over the whole loop, one point per ms, the last back on the first position. */
function wholeLoop(type, bpm, min, max, targetMs, rng) {
  const { beatMs, beats } = beatGrid(bpm, targetMs);
  const actions = shapeActions(type, 0, Math.round(beats * beatMs), bpm, min, max, rng)
    .filter((a, i, all) => i === 0 || a.at > all[i - 1].at);
  const last = actions.length - 1;
  if (last > 0 && actions[last].pos !== actions[0].pos) actions[last] = { at: actions[last].at, pos: actions[0].pos };
  return actions;
}

/**
 * One loop of shape `type` at `bpm` in [min, max]: what orgasm-pattern.js
 * buildOrgasmPatternContent holds for the same type, BPM and range (there the
 * BPM is a whole number 20-300; here any BPM the shape limits allow). First
 * action at 0, the last at the loop's length on the first one's position.
 */
export function shapeLoopActions(type, bpm, min, max, rng = Math.random, targetMs = SHAPE_LOOP_TARGET_MS) {
  const b = clamp(finiteOr(Number(bpm), 60), SHAPE_BPM_MIN, SHAPE_BPM_MAX);
  if (type === 'sawtooth' || type === 'square') return edgeShapeLoop(type, b, min, max, targetMs);
  if (type === 'escalating') return escalatingLoop(b, min, max, targetMs);
  return wholeLoop(SHAPE_TYPES.includes(type) ? type : 'sine', b, min, max, targetMs, rng);
}

/** The shapes whose 1 ms edges are instant by design (pf-engine decision 2: no ceiling on them). */
const EDGE_TYPES = new Set(['sawtooth', 'square']);

/**
 * The fastest leg of `actions` in units a second. For square and sawtooth
 * (`type`) their instant 1 ms edges are left out: they are jumps, not strokes.
 * @param {{at:number,pos:number}[]} actions
 * @param {string|null} [type] a shape type ('sine' etc.)
 * @returns {number}
 */
export function shapeFastestLeg(actions, type = null) {
  const list = Array.isArray(actions) ? actions : [];
  const edges = EDGE_TYPES.has(type);
  let fastest = 0;
  for (let i = 1; i < list.length; i++) {
    const dt = list[i].at - list[i - 1].at;
    if (!(dt > 0) || (edges && dt <= EDGE_MS)) continue;
    const v = (Math.abs(list[i].pos - list[i - 1].pos) / dt) * 1000;
    if (v > fastest) fastest = v;
  }
  return fastest;
}

/**
 * renderLoop for a shape: { actions, vib, loopMs, fallback: false, warnings: [] },
 * or null for an id that is not a shape. Options: speed (u/s), range, reversed,
 * seed ('random'), targetMs (default 10 s), maxSpeed (u/s: no leg faster;
 * pattern-source.js passes the library's 600), legacyRate (true: maxSpeed is
 * not applied, an upgraded Generated pattern's own rate).
 * maxSpeed never touches square's and sawtooth's instant edges (they stay
 * instant, as the Generated pattern played them); any other leg that would
 * pass it makes the whole loop play slower: fewer strokes a minute, the same
 * shape in the same band (pf-review PF-R2, 2026-11-19).
 */
export function renderShapeLoop(id, opts = {}) {
  const type = shapeTypeOf(id);
  if (!type) return null;
  const o = opts || {};
  const [lo, hi] = shapeBand(o.range);
  const asked = o.speed !== undefined && o.speed !== null ? Number(o.speed) : NaN;
  const speed = asked > 0 && Number.isFinite(asked) ? asked : SHAPE_OWN_SPEED;
  const seed = o.seed !== undefined && o.seed !== null && o.seed !== '' ? o.seed : 1;
  const target = clamp(finiteOr(o.targetMs, SHAPE_LOOP_TARGET_MS), 2000, 60000);
  const draw = (b) => {
    const drawn = shapeLoopActions(type, b, lo, hi, shapeRng(seed), target)
      .map((a) => ({ at: a.at, pos: clamp(Math.round(a.pos), 0, 100) }));
    return o.reversed ? mirrorIn(drawn, lo, hi) : drawn;
  };
  let bpm = shapeBpm(speed, hi - lo);
  let actions = draw(bpm);
  const ceiling = Number(o.maxSpeed);
  if (o.legacyRate !== true && Number.isFinite(ceiling) && ceiling > 0) {
    // Legs scale with the rate, give or take a whole-ms timestamp, so one or
    // two passes land under it; each pass is at least 1 % slower, so it ends.
    for (let pass = 0; pass < 60 && bpm > SHAPE_BPM_MIN; pass++) {
      const fastest = shapeFastestLeg(actions, type);
      if (fastest <= ceiling) break;
      bpm = Math.max(SHAPE_BPM_MIN, bpm * Math.min(0.99, ceiling / fastest));
      actions = draw(bpm);
    }
  }
  return {
    actions,
    vib: actions.map(() => false),
    loopMs: actions[actions.length - 1].at,
    fallback: false,
    warnings: [],
  };
}
