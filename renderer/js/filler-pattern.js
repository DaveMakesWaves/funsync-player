// Gap Filler with a pattern from the library (pattern settings unification,
// 2026-11-19; notes/features/DESIGN-pattern-settings-unify.md §5). UNCOMMITTED.
//
// filler-engine.js keeps drawing the six simple shapes exactly as before
// (generatePattern, the slew limiter, the join reserve): an upgraded filler
// plays the same strokes on the same timestamps. Any other library pattern
// comes through here, with the same guarantees:
//   - the joins: a reserve of joinReserveMs (a full 0-100 move at the join
//     speed, 300 u/s by default) is kept free at each edge that has a
//     neighbour, so the straight move from the main script into the pattern
//     and back out of it is never faster than the join speed, wherever the
//     pattern starts or ends (the same worst-case proof as buildGapFiller);
//   - inside the gap the pattern is the pattern-fill core's (pattern-fill.js
//     fillRange over the gap's inner window, both ends free): its minimum
//     legs (50 ms between buzz points, else 100 ms) and the 600 u/s ceiling;
//   - a gap too short for MIN_PATTERN_MS of pattern is left alone (today's
//     "refuse rather than lurch"); a trailing gap eases down to the rest
//     position at no more than the join speed, as before;
//   - every filler point lies strictly inside its gap and carries _filler.
// An ending (a one-shot pattern) plays once from the start of the gap's
// window and then holds its last position until the landing (Dave's open
// question in the design: built like X and Z).
//
// Speed. The pattern is rendered from its seamless loop (pattern-source.js
// patternSourceLoop: one render per settings, cached), tiled across the
// window. That keeps a whole long script fast: a 1 h script with 50 gaps
// costs one loop render plus a linear pass per gap, whatever the pattern.
//
// Pure: no DOM, no settings, no devices. It never imports filler-engine.js
// (which imports it): the join speed and the reserve come in as options.

import { fillRange } from './pattern-fill.js';
import { describePattern, PATTERN_SPEED_CEILING } from './pattern-library.js';
import { isShapeId } from './pattern-library-shapes.js';
import { patternSourceLoop } from './pattern-source.js';

/** u/s: the join speed when none is given (filler-engine.js DEFAULT_MAX_JOIN_SPEED). */
const DEFAULT_JOIN_SPEED = 300;
/** ms: the shortest window of pattern worth playing (filler-engine.js MIN_PATTERN_MS). */
const DEFAULT_MIN_PATTERN_MS = 800;

const clampPos = (p) => Math.max(0, Math.min(100, p));

/** ms reserved at a joined edge so a full 0-100 move stays at or under `maxJoinSpeed` (filler-engine joinReserveMs). */
function reserveFor(maxJoinSpeed) {
  const speed = Number.isFinite(maxJoinSpeed) && maxJoinSpeed > 0 ? maxJoinSpeed : DEFAULT_JOIN_SPEED;
  return Math.ceil((100 / speed) * 1000);
}

/**
 * The pattern's loop as a renderer fillRange can call: the loop (or an
 * ending, once, then held) laid end to end from `from` for `durationMs`.
 * The loop already carries the pattern's speed, range and reverse, so the
 * render options fillRange passes for those are not used again.
 */
function tiledRenderer(loop) {
  return (_id, opts = {}) => {
    const from = Math.round(Number(opts.from) || 0);
    const until = from + Math.max(1, Math.round(Number(opts.durationMs) || 0));
    const src = loop.actions;
    const vibSrc = loop.vib || [];
    const actions = [];
    const vib = [];
    if (loop.once) {
      for (let i = 0; i < src.length; i++) {
        const at = from + src[i].at;
        if (at > until) break;
        actions.push({ at, pos: src[i].pos }); vib.push(i > 0 && !!vibSrc[i]);
      }
      const last = actions[actions.length - 1];
      if (last && last.at < until) { actions.push({ at: until, pos: last.pos }); vib.push(false); }
      return { actions, vib, warnings: loop.warnings || [] };
    }
    const L = loop.loopMs;
    actions.push({ at: from, pos: src[0].pos }); vib.push(false);
    for (let base = from; base < until; base += L) {
      for (let i = 1; i < src.length; i++) {
        const at = base + src[i].at;
        if (at > until) return { actions, vib, warnings: loop.warnings || [] };
        actions.push({ at, pos: src[i].pos }); vib.push(!!vibSrc[i]);
      }
    }
    return { actions, vib, warnings: loop.warnings || [] };
  };
}

/**
 * The pattern over [startMs, endMs] (both ends free): fillRange's points, or
 * [] when nothing fits. `pattern` is { id, speed, reversed, min, max }
 * (pattern-source.js's value; min / max null = the pattern's own place).
 */
export function patternWindow(pattern, startMs, endMs) {
  const loop = patternSourceLoop(pattern);
  if (!loop || !Array.isArray(loop.actions) || loop.actions.length < 2) return [];
  if (!loop.once && !(loop.loopMs > 0)) return [];
  const res = fillRange({
    actions: [],
    selection: { startMs, endMs },
    patternId: pattern.id,
    options: { mode: 'replace', maxSpeed: PATTERN_SPEED_CEILING, seed: 1 },
  }, { render: tiledRenderer(loop), describe: describePattern });
  return Array.isArray(res?.inserted) ? res.inserted : [];
}

/**
 * Filler for ONE gap with a library pattern, joined to whatever sits either
 * side of it (buildGapFiller's contract: posBefore null = a leading gap,
 * posAfter null = a trailing gap).
 *
 * @param {{startMs:number, endMs:number}} gap
 * @param {number|null} posBefore
 * @param {number|null} posAfter
 * @param {object} opts
 *   pattern: { id, speed, reversed, min, max } (a simple shape is refused:
 *   filler-engine.js draws those), maxJoinSpeed (u/s, default 300),
 *   minPatternMs (default 800), restPos (a trailing gap eases there, or null)
 * @returns {Array<{at:number,pos:number,_filler:true}>} [] when the gap cannot be filled safely
 */
export function buildLibraryGapFiller(gap, posBefore, posAfter, opts = {}) {
  const pattern = opts.pattern || null;
  if (!pattern || typeof pattern.id !== 'string' || isShapeId(pattern.id) || !describePattern(pattern.id)) return [];
  const maxJoinSpeed = Number.isFinite(opts.maxJoinSpeed) && opts.maxJoinSpeed > 0 ? opts.maxJoinSpeed : DEFAULT_JOIN_SPEED;
  const minPatternMs = Number.isFinite(opts.minPatternMs) && opts.minPatternMs > 0 ? opts.minPatternMs : DEFAULT_MIN_PATTERN_MS;
  const reserve = reserveFor(maxJoinSpeed);
  const leadIn = posBefore == null ? 0 : reserve;
  const landOut = posAfter == null ? 0 : reserve;
  const start = gap.startMs + leadIn;
  const end = gap.endMs - landOut;
  if (end - start < minPatternMs) return [];

  const body = patternWindow(pattern, start, end).map((a) => ({ at: a.at, pos: a.pos }));
  if (body.length < 2) return [];

  // A trailing gap has no landing target: ease down to the rest position at
  // no more than the join speed, as buildGapFiller does. The travel is timed
  // to the whole position actually written (pf-review PF-R3: timed to an
  // unrounded 72.4 and written as 72, the last leg ran past the join speed).
  const restPos = opts.restPos;
  if (posAfter == null && restPos != null && Number.isFinite(restPos)) {
    const tail = body[body.length - 1];
    const rest = clampPos(Math.round(restPos));
    if (rest !== tail.pos) {
      const travelMs = Math.ceil((Math.abs(rest - tail.pos) / maxJoinSpeed) * 1000);
      const restAt = tail.at + Math.max(1, travelMs);
      // Too close to the video's end to get there at the join speed: it stays where it is.
      if (restAt <= gap.endMs) body.push({ at: restAt, pos: rest });
    }
  }

  return body
    .filter((a) => a.at > gap.startMs && a.at < gap.endMs)
    .map((a) => ({ at: a.at, pos: a.pos, _filler: true }));
}

/** The whole 0-100 range: the script a 'script' range is measured against when there is none. */
export const NEUTRAL_RANGE = Object.freeze({ min: 0, max: 100 });

/**
 * The band `depthPct` % of a script's range `natural` wide, centred on its
 * middle or `centrePct` % up it: filler-engine.js resolveDepth's arithmetic
 * (a range with no width plays the full throw). Not rounded.
 * @returns {{min:number, max:number}}
 */
export function depthBand(natural, depthPct, centrePct = null) {
  const lo = Number(natural?.min), hi = Number(natural?.max);
  const width = hi - lo;
  if (!Number.isFinite(width) || !(width > 0)) return { min: 0, max: 100 };
  const d = Number.isFinite(depthPct) ? depthPct : 100;
  const centre = centrePct == null || !Number.isFinite(centrePct)
    ? (lo + hi) / 2
    : lo + width * (clampPos(centrePct) / 100);
  const half = (width * (Math.max(0, d) / 100)) / 2;
  return { min: clampPos(centre - half), max: clampPos(centre + half) };
}

/** The width a speed is measured at: never under 1 unit. */
const widthOf = (band) => Math.max(1, (band ? band.max - band.min : 100));

/**
 * A 'script' choice made concrete for one script: the band (whole numbers)
 * and the speed that keeps the timing the choice has on a whole-range
 * script. The speed set is the speed on a script that uses the whole 0-100
 * range; on a narrower one the pattern is squeezed into the script's band
 * with the same timing (so it plays proportionally slower in u/s). That is
 * what keeps an upgraded filler's strokes per minute exactly as they were.
 * @param {{id:string, speed:number|null, depthPct:number|null, centrePct:number|null}} choice
 * @param {{min:number,max:number}} band  the band on this script (depthBand or resolveDepth)
 * @returns {{min:number, max:number, speed:number|null}}
 */
export function scriptBandSpeed(choice, band) {
  const min = Math.round(clampPos(Math.min(band.min, band.max)));
  const max = Math.round(clampPos(Math.max(band.min, band.max)));
  const ref = depthBand(NEUTRAL_RANGE, choice.depthPct ?? 100, choice.centrePct ?? null);
  const own = describePattern(choice.id)?.speed;
  const base = Number.isFinite(choice.speed) && choice.speed > 0 ? choice.speed : own;
  if (!(base > 0)) return { min, max, speed: null };
  const refW = widthOf(ref), w = widthOf({ min, max });
  return { min, max, speed: w === refW ? base : (base * w) / refW };
}

/**
 * Filler for every gap with a library pattern: what filler-engine.js
 * buildFillerActions hands over when the chosen pattern is not a simple
 * shape. `gaps` come from detectGaps.
 *
 * @param {Array<{at:number,pos:number}>} authored  the script (sorted)
 * @param {Array<{startMs:number,endMs:number}>} gaps
 * @param {object} opts
 *   library: { id, speed, reversed, rangeMode, min, max, depthPct, centrePct } (pattern-choice.js's choice),
 *   scriptBand: (depthPct, centrePct) => { min, max } (filler-engine.js resolveDepth over this script),
 *   maxJoinSpeed, minPatternMs
 * The rest position of a trailing gap is the band's bottom (in range mode
 * 'own' the lowest place of the pattern's own loop as it plays, reversed
 * included).
 * @returns {Array<{at:number,pos:number,_filler:true}>}
 */
export function buildLibraryFillerActions(authored, gaps, opts = {}) {
  const list = Array.isArray(authored) ? authored : [];
  const lib = opts.library || {};
  const { maxJoinSpeed, minPatternMs } = opts;
  if (typeof lib.id !== 'string') return [];
  let band = null;
  let speed = Number.isFinite(lib.speed) && lib.speed > 0 ? lib.speed : null;
  if (lib.rangeMode === 'exact' && Number.isFinite(lib.min) && Number.isFinite(lib.max)) {
    band = { min: Math.min(lib.min, lib.max), max: Math.max(lib.min, lib.max) };
  } else if (lib.rangeMode === 'script') {
    const raw = typeof opts.scriptBand === 'function'
      ? opts.scriptBand(lib.depthPct ?? 100, lib.centrePct ?? null)
      : depthBand(NEUTRAL_RANGE, lib.depthPct ?? 100, lib.centrePct ?? null);
    const s = scriptBandSpeed(lib, raw);
    band = { min: s.min, max: s.max };
    speed = s.speed;
  }
  const id = lib.id;
  const pattern = { id, speed, reversed: lib.reversed === true, min: band ? band.min : null, max: band ? band.max : null };
  // The rest is the bottom of where it plays: the band's, or in range mode
  // 'own' the lowest place of its own loop as it plays. A reversed pattern
  // plays mirrored, so the catalogue's range[0] was the far side of it
  // (pf-review PF-R4: it played 1-28 and then climbed to 72 to rest).
  let restPos = band ? band.min : null;
  if (restPos === null) {
    const loop = patternSourceLoop(pattern);
    restPos = loop && loop.actions.length
      ? loop.actions.reduce((lo, a) => Math.min(lo, a.pos), 100)
      : (describePattern(id)?.range?.[0] ?? 0);
  }
  const out = [];
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    let before = null;
    let after = null;
    for (const a of list) {
      if (a.at <= gap.startMs) before = a;
      else if (a.at >= gap.endMs) { after = a; break; }
    }
    out.push(...buildLibraryGapFiller(gap, before ? before.pos : null, after ? after.pos : null, {
      pattern, maxJoinSpeed, minPatternMs, restPos,
    }));
  }
  return out;
}
