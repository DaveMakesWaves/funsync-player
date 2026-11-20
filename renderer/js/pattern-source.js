// A pattern from the library as a looping finisher: the Orgasm Switch's
// "Pattern from the library" source and Edge Hold's "Play a pattern" mode.
//
// `player.orgasmLibraryPattern` = { enabled, id, speed, reversed, min, max }
// and `player.edgePattern` = { id, speed, reversed, min, max } (no enabled:
// `player.edgeHoldAction` says when it plays). `speed: null` is the
// pattern's own speed; `min` / `max: null` is the pattern's own place.
// `id: null` is "no pattern chosen" (Dave, 2026-11-17: no default until the
// user sets one): the library source then plays nothing of its own and
// Edge's pattern mode stops the devices as "stop" does.
//
// An ending (the library's one-shot shapes, kind 'event') is offered too
// (Dave, same evening: "dont hide them"). It is never looped: it is rendered
// once at its own length and marked `once`, so the switch plays it from the
// start of the hold and then holds its last position, and the Handy gets it
// untiled (orgasm-handy-engage.js).
//
// The loop is the engine's `renderLoop` (pattern-library.js): it starts and
// ends on a bottom turn at the same position, so repeating it
// (`elapsed % loopMs` in OrgasmSwitch, the Handy's tiled upload in
// orgasm-handy-engage.js) has no jump at the wrap. It is handed on as a
// funscript JSON string under a synthetic key with the generated pattern's
// `funsync-generated-pattern:` prefix, so every "this is not a file" check
// (`isOrgasmPatternKey`: nothing to read, nothing to recover) holds as it is.
//
// Pure: no DOM, no settings, no devices. The renders are cached per key (the
// heavy buzz loops take 60-80 ms), a few at a time.
//
// Since the pattern settings unification (2026-11-19) the same seam plays the
// six simple shapes (shape-sine etc., pattern-library-shapes.js) and the
// shared choice of pattern-choice.js: resolveChoice turns a choice into the
// { id, speed, reversed, min, max } value read here, with a concrete band.
// A shape's speed is kept as given (1-1000 u/s, not rounded): an upgraded
// Generated pattern keeps its exact rate and timestamps.

import {
  PATTERN_ENGINE_VERSION, DEFAULT_MAX_SPEED, hasPattern, describePattern, renderLoop, renderPattern,
} from './pattern-library.js';
import { isShapeId, SHAPE_SPEED_MIN, SHAPE_SPEED_MAX } from './pattern-library-shapes.js';
import { ORGASM_PATTERN_KEY_PREFIX } from './orgasm-pattern.js';

/** The Orgasm Switch's library source. MUST match `player.orgasmLibraryPattern` in electron/store.js DEFAULTS. */
export const ORGASM_LIBRARY_DEFAULTS = Object.freeze({
  enabled: false,
  id: null,
  speed: null,
  reversed: false,
  min: null,
  max: null,
});

/** Edge Hold's pattern. MUST match `player.edgePattern` in electron/store.js DEFAULTS. */
export const EDGE_PATTERN_DEFAULTS = Object.freeze({
  id: null,
  speed: null,
  reversed: false,
  min: null,
  max: null,
});

/** `player.edgeHoldAction`: 'stop' (the default, Edge Hold as it always was) or 'pattern'. */
export const EDGE_HOLD_ACTIONS = Object.freeze(['stop', 'pattern']);

/** Slowest speed a slider offers (u/s). */
const SPEED_FLOOR = 10;

/** How many rendered loops are kept (a slider dragged across many values must not grow memory). */
const CACHE_SIZE = 12;

const cache = new Map();

/** A loopable pattern of the library (the 6 endings are one-shot shapes, never a loop). */
export function isLoopablePattern(id) {
  return hasPattern(id) && describePattern(id)?.loopable === true;
}

/** An ending: a one-shot shape that plays once and then holds its last position. */
export function isOneShotPattern(id) {
  return hasPattern(id) && describePattern(id)?.loopable === false;
}

/**
 * The Speed slider's bounds for pattern `id`: its typical speed range,
 * never past DEFAULT_MAX_SPEED (600 u/s) and always holding its own speed.
 * Whole u/s. null for an unknown id. The slider's top is the speed asked
 * for, not a leg's limit: the engine's own cap is 1.5x the asked speed
 * when that is higher, so the loop is rendered with maxSpeed 600 as well
 * (patternSourceLoop), and no leg of it passes 600 u/s.
 * @returns {{ min: number, max: number, own: number } | null}
 */
export function patternSpeedBounds(id) {
  const d = describePattern(id);
  if (!d) return null;
  const own = Math.round(d.speed);
  const min = Math.max(SPEED_FLOOR, Math.min(Math.floor(d.speedRange[0]), own));
  const max = Math.min(DEFAULT_MAX_SPEED, Math.max(Math.ceil(d.speedRange[1]), own));
  return { min, max: Math.max(min, max), own: Math.min(Math.max(own, min), max) };
}

/**
 * The stored value made safe to use. An unknown or missing id is the
 * default id, which is null ("no pattern chosen"); an ending is kept (it
 * plays once, see patternSourceLoop); a speed outside the slider's bounds is
 * clamped into them; `reversed` (and `enabled`, when the defaults carry it)
 * is on only when it is literally `true`; a range is two whole numbers 0-100
 * in order, or both null (the pattern's own place).
 * @param {*} raw — `player.orgasmLibraryPattern` or `player.edgePattern`
 * @param {object} [defaults] — ORGASM_LIBRARY_DEFAULTS or EDGE_PATTERN_DEFAULTS
 */
export function normalizePatternSource(raw, defaults = EDGE_PATTERN_DEFAULTS) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = defaults && typeof defaults === 'object' ? defaults : EDGE_PATTERN_DEFAULTS;
  const id = hasPattern(r.id) ? r.id
    : (hasPattern(d.id) ? d.id : null);
  let speed = null;
  if (id !== null && r.speed !== null && r.speed !== undefined && r.speed !== '') {
    const n = Number(r.speed);
    const b = patternSpeedBounds(id);
    // A simple shape keeps its speed as given (an upgraded 40 BPM triangle is
    // 133.33 u/s: rounded, its strokes would drift off their timestamps).
    // A speed of 0 or less is no speed: the shape's own (pattern-choice.js reads it the same way).
    if (isShapeId(id)) speed = Number.isFinite(n) && n > 0 ? Math.max(SHAPE_SPEED_MIN, Math.min(SHAPE_SPEED_MAX, n)) : null;
    else if (Number.isFinite(n) && b) speed = Math.max(b.min, Math.min(b.max, Math.round(n)));
  }
  let min = null;
  let max = null;
  const lo = r.min === null || r.min === undefined || r.min === '' ? NaN : Number(r.min);
  const hi = r.max === null || r.max === undefined || r.max === '' ? NaN : Number(r.max);
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    min = Math.max(0, Math.min(100, Math.round(lo)));
    max = Math.max(0, Math.min(100, Math.round(hi)));
    // The Settings sliders keep min <= max; a hand-edited config might not.
    if (min > max) [min, max] = [max, min];
  }
  const out = { id, speed, reversed: r.reversed === true, min, max };
  if ('enabled' in d) return { enabled: r.enabled === true, ...out };
  return out;
}

// ---------- the shared choice (pattern-choice.js; one normaliser for all three) ----------
/** pattern-choice.js's range modes: the pattern's own place, an exact band, or a share of the script's range. */
export const RANGE_MODES = Object.freeze(['own', 'exact', 'script']);
/** The shared choice with nothing chosen (pattern-choice.js documents every field). */
export const EMPTY_CHOICE = Object.freeze({
  id: null, speed: null, reversed: false, rangeMode: 'own',
  min: null, max: null, depthPct: null, centrePct: null,
});
/** Depth % bounds of range mode 'script'. */
export const DEPTH_MIN = 1;
export const DEPTH_MAX = 100;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampTo = (x, a, b) => Math.max(a, Math.min(b, x));
const numOrNaN = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Normalise any stored or edited value to the shared shape.
 * An unknown id is null; a simple shape's speed is kept as given within
 * 1-1000 u/s (not rounded: an upgraded BPM keeps its exact rate); a library
 * pattern's speed is a whole number within its slider's bounds (as
 * normalizePatternSource always held it); min / max are whole numbers 0-100
 * in order, or both null; rangeMode 'exact' needs both, else it is 'own';
 * depthPct is 1-100 (100 when 'script' has none); centrePct 0-100 or null.
 * @param {object|null|undefined} raw
 * @returns {object} a new object in the shared shape
 */
export function normalizePatternChoice(raw) {
  const r = isObj(raw) ? raw : {};
  const id = hasPattern(r.id) ? r.id : null;
  let speed = null;
  if (id !== null) {
    const n = numOrNaN(r.speed);
    if (isShapeId(id)) {
      if (Number.isFinite(n) && n > 0) speed = clampTo(n, SHAPE_SPEED_MIN, SHAPE_SPEED_MAX);
    } else if (Number.isFinite(n)) {
      const b = patternSpeedBounds(id);
      if (b) speed = clampTo(Math.round(n), b.min, b.max);
    }
  }
  let min = null;
  let max = null;
  const lo = numOrNaN(r.min), hi = numOrNaN(r.max);
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    min = clampTo(Math.round(lo), 0, 100);
    max = clampTo(Math.round(hi), 0, 100);
    if (min > max) [min, max] = [max, min];
  }
  let rangeMode = RANGE_MODES.includes(r.rangeMode) ? r.rangeMode : (min !== null ? 'exact' : 'own');
  if (rangeMode === 'exact' && min === null) rangeMode = 'own';
  const d = numOrNaN(r.depthPct);
  let depthPct = Number.isFinite(d) ? clampTo(d, DEPTH_MIN, DEPTH_MAX) : null;
  if (rangeMode === 'script' && depthPct === null) depthPct = 100;
  const c = numOrNaN(r.centrePct);
  const centrePct = Number.isFinite(c) ? clampTo(c, 0, 100) : null;
  const out = { id, speed, reversed: r.reversed === true, rangeMode, min, max, depthPct, centrePct };
  // An 11-17 Generated pattern read from player.orgasmPattern keeps its own
  // rate, above the 600 u/s ceiling where it was set there (pf-engine
  // decision 3; pf-fixup 2026-11-19): only on a simple shape, only while it
  // is the value derived from the old key (pattern-choice.js never stores it,
  // and the Pattern block drops it at the first change by hand).
  if (r.legacyRate === true && isShapeId(id)) out.legacyRate = true;
  return out;
}

// ---------- which wins after a downgrade or a merge import (pf-review PF-R6) ----------
// A new value (gapFiller.pattern, orgasmPatternChoice, edgePatternChoice)
// carries `basis`: a fingerprint of what the OLD keys it was written over
// said then. An older build (v0.9.2 after a downgrade, an 11-17 build) or a
// merge import of an older backup changes only the old keys; on the next
// read their fingerprint no longer matches, so they win and the new value
// is left alone, unused, until the next Apply writes a fresh one. A value
// without `basis` (written before this rule) wins as before.

/** FNV-1a, 32 bits, as 8 hex digits. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The fingerprint of a plain value built in a fixed key order (the callers canonicalise first). */
export function patternBasis(data) {
  return `b1:${fnv1a(JSON.stringify(data === undefined ? null : data))}`;
}

/** Was the stored value `raw` written over old keys that say something else now (basisNow)? */
export function isStaleChoice(raw, basisNow) {
  return isObj(raw) && typeof raw.basis === 'string' && raw.basis !== basisNow;
}

/**
 * A library source as stored (player.orgasmLibraryPattern / edgePattern),
 * canonicalised for the fingerprint: absent reads as the defaults; nothing
 * clamped to the catalogue, so a later catalogue never changes it.
 */
export function canonicalSource(raw) {
  const r = isObj(raw) ? raw : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    enabled: r.enabled === true,
    id: typeof r.id === 'string' && r.id ? r.id : null,
    speed: num(r.speed),
    reversed: r.reversed === true,
    min: num(r.min),
    max: num(r.max),
  };
}

/** Does `pattern` (a choice, or resolveChoice's value) keep an upgraded Generated pattern's own rate? */
const keepsLegacyRate = (pattern, id) => isObj(pattern) && pattern.legacyRate === true && isShapeId(id);


/**
 * The Orgasm Switch's library pattern when it is the source AND a pattern is
 * chosen, else null. With no pattern chosen the library source does nothing:
 * the switch plays its other sources exactly as before.
 */
export function orgasmLibrarySettings(raw) {
  const p = normalizePatternSource(raw, ORGASM_LIBRARY_DEFAULTS);
  return p.enabled && p.id !== null ? p : null;
}

/** 'pattern' only when `player.edgeHoldAction` literally says so; anything else is 'stop' (today). */
export function edgeHoldAction(raw) {
  return raw === 'pattern' ? 'pattern' : 'stop';
}

/**
 * The synthetic key both Orgasm caches (and the Handy upload caches) use
 * for this loop. It names every value that shapes the content, plus the
 * engine version, so a cached upload is never reused for another loop.
 */
export function patternSourceKey(pattern) {
  const p = normalizePatternSource(pattern);
  if (p.id === null) return null;
  const speed = p.speed === null ? 'own' : String(p.speed);
  const range = p.min === null ? 'own' : `${p.min}-${p.max}`;
  // `/g`: an upgraded Generated pattern at its own rate (no ceiling), not the same loop.
  const rate = keepsLegacyRate(pattern, p.id) ? '/g' : '';
  return `${ORGASM_PATTERN_KEY_PREFIX}library/v${PATTERN_ENGINE_VERSION}/${p.id}/${speed}/${p.reversed ? 'r' : 'n'}/${range}/s1${rate}`;
}

/**
 * The loop for this pattern: { actions, loopMs, warnings, once }, first
 * action at 0. A loop's last action is at loopMs on the first one's
 * position (once: false). An ending is rendered once at its own length
 * (once: true, loopMs = its last action): the caller plays it once and
 * holds its end. Cached per key. null when no pattern is chosen or the
 * engine cannot render it.
 */
export function patternSourceLoop(pattern) {
  const p = normalizePatternSource(pattern);
  if (p.id === null) return null;
  const legacyRate = keepsLegacyRate(pattern, p.id);
  const key = patternSourceKey(legacyRate ? { ...p, legacyRate } : p);
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key); // most recently used goes last
    cache.set(key, hit);
    return hit.loop;
  }
  const once = isOneShotPattern(p.id);
  const opts = {
    speed: p.speed === null ? undefined : p.speed,
    reversed: p.reversed,
    range: p.min === null ? undefined : { min: p.min, max: p.max },
    seed: 1,
    // A hard ceiling (fix-up 2026-11-17): left to the engine, the cap is
    // 1.5x the asked speed, and the slider's top gave legs of 770-900 u/s.
    // The simple shapes keep it too (PF-R2, 2026-11-19), all but square's
    // and sawtooth's instant edges and an upgraded Generated pattern's rate.
    maxSpeed: DEFAULT_MAX_SPEED,
    legacyRate,
  };
  // An ending: one render at its own length, never cut into a loop.
  const res = once ? renderPattern(p.id, opts) : renderLoop(p.id, opts);
  const loopMs = once ? res?.actions?.[res.actions.length - 1]?.at : res?.loopMs;
  if (!res || !Array.isArray(res.actions) || res.actions.length < 2 || !(loopMs > 0)) return null;
  // `warnings`: a range too narrow for the pattern was widened (renderLoop).
  // `vib`: which legs are buzz legs (the gap filler's fill keeps their 50 ms minimum, filler-pattern.js).
  const loop = Object.freeze({ actions: res.actions, loopMs, warnings: res.warnings || [], once, vib: Array.isArray(res.vib) ? res.vib : res.actions.map(() => false) });
  const content = JSON.stringify({ version: '1.0', inverted: false, range: 100, actions: res.actions });
  cache.set(key, { loop, content });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return loop;
}

/**
 * The loop as a funscript JSON string: what a finisher file would hold.
 * Its last action is on its first position, so the per-tick loop
 * (`elapsed % loopMs`) and the Handy's tiled upload (tileFinisherContent,
 * capped at 8,000 actions) play the same seamless wrap. null when the
 * pattern cannot be rendered (the caller then behaves as before).
 * @returns {string|null}
 */
export function buildPatternSourceContent(pattern) {
  const loop = patternSourceLoop(pattern);
  if (!loop) return null;
  return cache.get(patternSourceKey(pattern))?.content ?? null;
}

/** The pattern's name key for t(): `patterns.<id>.name`; null when none is chosen. */
export function patternNameKey(pattern) {
  const id = normalizePatternSource(pattern).id;
  return id === null ? null : `patterns.${id}.name`;
}

/** Tests: forget every cached render. */
export function clearPatternSourceCache() {
  cache.clear();
}

/** Tests: how many renders are cached. */
export function patternSourceCacheSize() {
  return cache.size;
}
