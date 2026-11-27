// One pattern choice for Gap Filler, Orgasm Switch (X) and Edge Hold (Z)
// (Dave, 2026-11-19: "give them all the same options laid out the same way";
// notes/features/DESIGN-pattern-settings-unify.md). UNCOMMITTED.
//
// CONTRACT written by Claude for the pf-engine and pf-ui stages; pf-engine
// filled in the bodies and added exports (SCRATCH pf-engine/contract-notes.txt);
// pf-ui codes against it. Change a signature only by agreement.
//
// The shared shape (every field always present after normalizePatternChoice):
//   {
//     id:        string|null   library pattern id ('shape-sine' etc. for the
//                              simple shapes), null = none chosen yet
//     speed:     number|null   units a second; null = the pattern's own
//     reversed:  boolean
//     rangeMode: 'own' | 'exact' | 'script'
//     min, max:  number|null   0-100, used when rangeMode === 'exact'
//     depthPct:  number|null   1-100, used when rangeMode === 'script'
//     centrePct: number|null   0-100 or null (= the script's own centre)
//   }
// An old value with no rangeMode reads as 'own' when min and max are null,
// else 'exact'. Speeds are units/s ONLY (Dave: "Units/s only").
// One optional field (pf-fixup 2026-11-19): `legacyRate: true` on a simple
// shape read from an 11-17 Generated pattern (player.orgasmPattern): it plays
// at its own rate, above the 600 u/s ceiling every other choice keeps where it
// was set there. Never stored (patternChoiceWrites drops it); the Pattern
// block drops it at the first change by hand.
//
// Storage (design §4). New keys only; the OLD KEYS are never written here:
//   Gap Filler  player.gapFiller.pattern   (old: gapFiller.presetId / custom)
//   X           player.orgasmPatternChoice and player.orgasmSource 'file'|'pattern'
//               (old: player.orgasmPattern, player.orgasmLibraryPattern)
//   Z           player.edgePatternChoice   (old: player.edgePattern; the "when"
//               row player.edgeHoldAction is unchanged)
// A new key that is absent is derived on read from the old ones, so a v0.9.2
// or 11-17 config plays exactly as it did (same positions, same timestamps):
// a BPM becomes the u/s of the same strokes (pattern-library-shapes.js
// shapeSpeed), a filler depth becomes range mode 'script'. No store.js
// default exists for the new keys: absent IS the derived value.
//
// Range mode 'script' ("Follow the script"): the band is depthPct % of the
// script's own range (centred, or centrePct % up it): the whole script for
// Gap Filler (as before), the script within SCRIPT_WINDOW_MS either side of
// now for X and Z. The speed set is the speed on a script that uses the whole
// 0-100 range; on a narrower one the pattern is squeezed into its band with
// the same timing (filler-pattern.js scriptBandSpeed).
//
// Pure: no DOM, no settings store, no devices.

import { describePattern } from './pattern-library.js';
import { isShapeId, shapeIdFor, shapeSpeed } from './pattern-library-shapes.js';
import { FILLER_PRESETS, DEFAULT_PRESET_ID, getPreset, resolveFillerOptions, fillerOldKeysBasis } from './filler-presets.js';
import { normalizeOrgasmPattern, ORGASM_PATTERN_DEFAULTS } from './orgasm-pattern.js';
import {
  normalizePatternSource, normalizePatternChoice, ORGASM_LIBRARY_DEFAULTS, EDGE_PATTERN_DEFAULTS,
  patternSourceLoop, patternSourceKey, buildPatternSourceContent,
  patternBasis, isStaleChoice, canonicalSource,
} from './pattern-source.js';
import { buildGapFiller, DEFAULT_MAX_JOIN_SPEED, joinReserveMs } from './filler-engine.js';
import { buildLibraryGapFiller, depthBand, scriptBandSpeed, NEUTRAL_RANGE } from './filler-pattern.js';
import { computeNaturalRange } from './device-transform-stack.js';

/** @typedef {'gapFiller'|'orgasm'|'edge'} PatternFeature */

export const PATTERN_FEATURES = Object.freeze(['gapFiller', 'orgasm', 'edge']);
// The shared shape and its one normaliser live in pattern-source.js (design §4:
// "one normaliser for all three, extends normalizePatternSource"), so the
// gap filler's own options (filler-presets.js) can read a choice without
// importing this module back.
export { RANGE_MODES, EMPTY_CHOICE, DEPTH_MIN, DEPTH_MAX, normalizePatternChoice } from './pattern-source.js';
/** Where each feature's choice is stored (settings dot paths, under `settings`). */
export const CHOICE_KEYS = Object.freeze({
  gapFiller: 'player.gapFiller.pattern',
  orgasm: 'player.orgasmPatternChoice',
  edge: 'player.edgePatternChoice',
});
/** The Orgasm Switch's source: 'file' (Configure…) or 'pattern' (the block). */
export const ORGASM_SOURCE_KEY = 'player.orgasmSource';
export const ORGASM_SOURCES = Object.freeze(['file', 'pattern']);
/** ms either side of now that X and Z measure the script's range over in range mode 'script' (Dave's to confirm). */
export const SCRIPT_WINDOW_MS = 30000;
/** ms: the preview / Test sample's default length. */
export const SAMPLE_MS = 8000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- the old keys, read as a choice ----------
/** The band a 'script' choice has on a whole-range script (the reference its speed is measured at). */
const refBand = (depthPct, centrePct) => depthBand(NEUTRAL_RANGE, depthPct ?? 100, centrePct ?? null);
const refWidth = (depthPct, centrePct) => { const b = refBand(depthPct, centrePct); return b.max - b.min; };

/** A filler preset (or Custom's depth fields) as a choice following the script. */
function fillerShapeChoice(type, bpm, depthPct, centrePct) {
  return normalizePatternChoice({
    id: shapeIdFor(type),
    speed: shapeSpeed(bpm, refWidth(depthPct, centrePct)),
    reversed: false,
    rangeMode: 'script',
    depthPct,
    centrePct,
  });
}

/** A preset of FILLER_PRESETS as a choice (also each quick pick's). */
function presetChoice(preset) {
  return fillerShapeChoice(preset.pattern, preset.bpm, preset.depthPct, preset.centrePct);
}

/**
 * `player.gapFiller` without `pattern`, read exactly as filler-presets.js
 * resolveFillerOptions reads it (an unknown preset is the default one;
 * Custom with an absolute band is that band).
 */
function fillerChoiceFromOld(g) {
  const presetId = g.presetId === undefined ? DEFAULT_PRESET_ID : g.presetId;
  const custom = g.custom || null;
  if (presetId === 'custom' && custom) {
    const type = custom.pattern || 'sine';
    const bpm = Number.isFinite(custom.bpm) ? custom.bpm : 20;
    const abs = custom.absolute || null;
    if (abs && Number.isFinite(abs.min) && Number.isFinite(abs.max)) {
      const lo = clamp(Math.min(abs.min, abs.max), 0, 100), hi = clamp(Math.max(abs.min, abs.max), 0, 100);
      return normalizePatternChoice({
        id: shapeIdFor(type), speed: shapeSpeed(bpm, hi - lo), reversed: false, rangeMode: 'exact', min: lo, max: hi,
      });
    }
    return fillerShapeChoice(
      type,
      bpm,
      Number.isFinite(custom.depthPct) ? custom.depthPct : 100,
      Number.isFinite(custom.centrePct) ? custom.centrePct : null,
    );
  }
  return presetChoice(getPreset(presetId));
}

/** A library source value ({ id, speed, reversed, min, max }) as a choice. */
function librarySourceChoice(p) {
  return normalizePatternChoice({
    id: p.id, speed: p.speed, reversed: p.reversed, rangeMode: p.min === null ? 'own' : 'exact', min: p.min, max: p.max,
  });
}

/**
 * The Generated pattern ({ type, bpm, min, max }) as the same shape at the
 * same strokes a minute, at its own rate (`legacyRate`: no 600 u/s ceiling
 * on it, as it always played; pf-engine decision 3, kept by pf-fixup). The
 * mark is never stored: a change in the drawer makes it a new choice.
 */
function generatedChoice(op) {
  return normalizePatternChoice({
    id: shapeIdFor(op.type), speed: shapeSpeed(op.bpm, op.max - op.min), reversed: false, rangeMode: 'exact', min: op.min, max: op.max,
    legacyRate: true,
  });
}

const isDefaultGenerated = (op) => ['type', 'bpm', 'min', 'max'].every((k) => op[k] === ORGASM_PATTERN_DEFAULTS[k]);

/**
 * X without `orgasmPatternChoice`. The source in use first, as app.js
 * played it: the Generated pattern when it is on (it won over the library
 * when both were on), else the library source when it is on (with no
 * pattern chosen: none, as before). With the script file in use, what the
 * block shows: the library pattern if one was picked, else a Generated
 * pattern that was changed from its defaults, else nothing.
 */
function orgasmChoiceFromOld(pl) {
  const op = normalizeOrgasmPattern(pl.orgasmPattern);
  const lib = normalizePatternSource(pl.orgasmLibraryPattern, ORGASM_LIBRARY_DEFAULTS);
  if (op.enabled) return generatedChoice(op);
  if (lib.enabled) return librarySourceChoice(lib);
  if (lib.id !== null) return librarySourceChoice(lib);
  if (!isDefaultGenerated(op)) return generatedChoice(op);
  return normalizePatternChoice(null);
}

/**
 * The fingerprint of a feature's OLD keys as they are in `player` now
 * (pf-review PF-R6): written into each new value as `basis`; a stored value
 * whose basis no longer matches was written over old keys that an older
 * build or a merge import has changed since, and those old keys win.
 * @param {PatternFeature} feature
 * @param {object} player  settings.player
 * @returns {string|null}
 */
export function oldKeysBasis(feature, player) {
  const pl = isObj(player) ? player : {};
  if (feature === 'gapFiller') return fillerOldKeysBasis(isObj(pl.gapFiller) ? pl.gapFiller : {});
  if (feature === 'orgasm') {
    return patternBasis({
      orgasmPattern: normalizeOrgasmPattern(pl.orgasmPattern),
      orgasmLibraryPattern: canonicalSource(pl.orgasmLibraryPattern),
    });
  }
  if (feature === 'edge') return patternBasis({ edgePattern: canonicalSource(pl.edgePattern) });
  return null;
}

/** X's stored choice, unless the old keys changed after it was written. */
const orgasmStored = (pl) => (isObj(pl.orgasmPatternChoice) && !isStaleChoice(pl.orgasmPatternChoice, oldKeysBasis('orgasm', pl))
  ? pl.orgasmPatternChoice : null);

/**
 * The choice a feature uses now, read from `settings.player` (derives it
 * from the OLD keys when the new ones are absent: gapFiller.presetId/custom,
 * orgasmPattern, orgasmLibraryPattern, edgePattern; and when the old keys
 * were changed after the new one was written, PF-R6). Never writes.
 * @param {PatternFeature} feature
 * @param {object} player  settings.player
 * @returns {object} the shared shape
 */
export function readPatternChoice(feature, player) {
  const pl = isObj(player) ? player : {};
  if (feature === 'gapFiller') {
    const g = isObj(pl.gapFiller) ? pl.gapFiller : {};
    if (isObj(g.pattern) && !isStaleChoice(g.pattern, oldKeysBasis('gapFiller', pl))) return normalizePatternChoice(g.pattern);
    return fillerChoiceFromOld(g);
  }
  if (feature === 'orgasm') {
    const stored = orgasmStored(pl);
    if (stored) return normalizePatternChoice(stored);
    return orgasmChoiceFromOld(pl);
  }
  if (feature === 'edge') {
    if (isObj(pl.edgePatternChoice) && !isStaleChoice(pl.edgePatternChoice, oldKeysBasis('edge', pl))) {
      return normalizePatternChoice(pl.edgePatternChoice);
    }
    return librarySourceChoice(normalizePatternSource(pl.edgePattern, EDGE_PATTERN_DEFAULTS));
  }
  return normalizePatternChoice(null);
}

/**
 * The part of `settings.player` the three blocks read, built from a getter
 * of dot paths (DataService's `get`, or a test's flat map): the new keys and
 * the old ones. `player.gapFiller.pattern` is read on its own too, so a
 * getter that keeps dot paths flat still sees it.
 * @param {(path: string) => any} get
 * @returns {object} a `player`-shaped object for readPatternChoice / readOrgasmSource
 */
export function patternChoicePlayer(get) {
  const g = typeof get === 'function' ? get : () => undefined;
  const filler = g('player.gapFiller');
  const fillerPattern = g('player.gapFiller.pattern');
  const gapFiller = isObj(filler) ? filler : {};
  return {
    gapFiller: isObj(fillerPattern) && !isObj(gapFiller.pattern) ? { ...gapFiller, pattern: fillerPattern } : gapFiller,
    orgasmSource: g('player.orgasmSource'),
    orgasmPatternChoice: g('player.orgasmPatternChoice'),
    orgasmPattern: g('player.orgasmPattern'),
    orgasmLibraryPattern: g('player.orgasmLibraryPattern'),
    edgePatternChoice: g('player.edgePatternChoice'),
    edgePattern: g('player.edgePattern'),
  };
}

/**
 * Orgasm Switch source: 'file' | 'pattern' (player.orgasmSource, else
 * derived from the old keys: the Generated pattern or the library source
 * on = 'pattern').
 * @param {object} player
 * @returns {'file'|'pattern'}
 */
export function readOrgasmSource(player) {
  const pl = isObj(player) ? player : {};
  // The stored source, unless X's old keys changed after its choice was
  // written (PF-R6): then they say the source too, as they did before.
  const stale = isObj(pl.orgasmPatternChoice) && !orgasmStored(pl);
  if (ORGASM_SOURCES.includes(pl.orgasmSource) && !stale) return pl.orgasmSource;
  if (isObj(pl.orgasmPattern) && pl.orgasmPattern.enabled === true) return 'pattern';
  if (isObj(pl.orgasmLibraryPattern) && pl.orgasmLibraryPattern.enabled === true) return 'pattern';
  return 'file';
}

/**
 * X's pattern when the source is 'pattern' AND a pattern is chosen, else
 * null (then the script file(s) set with Configure… play, as with the
 * library source and no pattern before).
 * @returns {object|null} the shared shape
 */
export function orgasmChoiceInUse(player) {
  if (readOrgasmSource(player) !== 'pattern') return null;
  const c = readPatternChoice('orgasm', player);
  return c.id !== null ? c : null;
}

/**
 * What to write for a changed choice: a list of { key, value } settings
 * writes (dot paths under settings, e.g. 'player.gapFiller.pattern').
 * NEVER includes an old key (gapFiller.presetId / custom, orgasmPattern):
 * a downgrade to v0.9.2 must find them as they were.
 * @param {PatternFeature} feature
 * @param {object} choice  the shared shape
 * @param {object} player  current settings.player (to keep sibling fields)
 * @returns {{key: string, value: any}[]}
 */
export function patternChoiceWrites(feature, choice, player) {
  const key = CHOICE_KEYS[feature];
  if (!key) return [];
  // An upgraded Generated pattern's `legacyRate` belongs to the old key it
  // was read from: a stored choice is a new one (the 600 u/s ceiling holds).
  const { legacyRate, ...value } = normalizePatternChoice(choice); // eslint-disable-line no-unused-vars
  // What the old keys say now, so a later change to them (a downgraded
  // build, a merge import) is seen and wins (PF-R6).
  return [{ key, value: { ...value, basis: oldKeysBasis(feature, player) } }];
}

/** The write for X's source ('file' unless literally 'pattern'). Never an old key. */
export function orgasmSourceWrites(source) {
  return [{ key: ORGASM_SOURCE_KEY, value: source === 'pattern' ? 'pattern' : 'file' }];
}

/**
 * The built-in quick picks (Gap Filler's presets, now for all three), each a
 * full choice in units/s.
 * @returns {{id: string, labelKey: string, choice: object}[]}
 */
export function listQuickPicks() {
  return FILLER_PRESETS.map((p) => ({ id: p.id, labelKey: p.labelKey, choice: presetChoice(p) }));
}

const near = (a, b, tol = 0.5) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);

/** Do two normalised choices play the same (the fields their range mode uses; speeds within half a unit)? */
export function sameChoice(a, b) {
  const x = normalizePatternChoice(a), y = normalizePatternChoice(b);
  if (x.id !== y.id || x.reversed !== y.reversed || x.rangeMode !== y.rangeMode || !near(x.speed, y.speed)) return false;
  if (x.rangeMode === 'exact') return x.min === y.min && x.max === y.max;
  if (x.rangeMode === 'script') return near(x.depthPct, y.depthPct) && near(x.centrePct, y.centrePct);
  return true;
}

/**
 * The quick pick a choice equals, or 'custom'.
 * @param {object} choice
 * @returns {string}
 */
export function quickPickIdFor(choice) {
  const hit = listQuickPicks().find((q) => sameChoice(choice, q.choice));
  return hit ? hit.id : 'custom';
}

// ---------- making a choice concrete ----------
const validRange = (r) => isObj(r) && Number.isFinite(r.min) && Number.isFinite(r.max);

/**
 * The script's own range around `nowMs`: the lowest and highest position
 * within `windowMs` either side (X and Z, range mode 'script'). Fewer than
 * two points there: the whole script's. No script: null (the caller then
 * measures against the whole 0-100 range).
 * @returns {{min:number,max:number}|null}
 */
export function scriptRangeAround(actions, nowMs, windowMs = SCRIPT_WINDOW_MS) {
  const list = Array.isArray(actions) ? actions.filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos)) : [];
  if (!list.length) return null;
  const t = Number.isFinite(nowMs) ? nowMs : 0;
  const w = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : SCRIPT_WINDOW_MS;
  const near2 = list.filter((a) => a.at >= t - w && a.at <= t + w);
  return computeNaturalRange(near2.length >= 2 ? near2 : list);
}

/**
 * The choice as the concrete value pattern-source.js plays (X, Z, the
 * preview): { id, speed, reversed, min, max } with the band worked out
 * (min / max null = the pattern's own place), or null when no pattern is
 * chosen. scriptRange: the script's range for 'script' (default 0-100).
 */
export function resolveChoice(choice, { scriptRange = null } = {}) {
  const c = normalizePatternChoice(choice);
  if (c.id === null) return null;
  // An upgraded Generated pattern's own rate (normalizePatternChoice keeps the mark on a shape only).
  const rate = c.legacyRate === true ? { legacyRate: true } : {};
  if (c.rangeMode === 'exact') return { id: c.id, speed: c.speed, reversed: c.reversed, min: c.min, max: c.max, ...rate };
  if (c.rangeMode === 'script') {
    const s = scriptBandSpeed(c, depthBand(validRange(scriptRange) ? scriptRange : NEUTRAL_RANGE, c.depthPct, c.centrePct));
    return { id: c.id, speed: s.speed, reversed: c.reversed, min: s.min, max: s.max, ...rate };
  }
  return { id: c.id, speed: c.speed, reversed: c.reversed, min: null, max: null, ...rate };
}

/**
 * X's finisher / Z's pattern for a choice: { key, content, once, loop,
 * pattern } (the seam app.js already plays: a synthetic key with the
 * Generated pattern's prefix, the funscript JSON, an ending's `once`, the
 * cached loop), or null when nothing is chosen or it cannot be rendered.
 */
export function choiceSource(choice, { scriptRange = null } = {}) {
  const pattern = resolveChoice(choice, { scriptRange });
  if (!pattern) return null;
  const loop = patternSourceLoop(pattern);
  if (!loop) return null;
  const content = buildPatternSourceContent(pattern);
  if (!content) return null;
  return { key: patternSourceKey(pattern), content, once: loop.once === true, loop, pattern };
}

/**
 * The options the gap filler's engine takes (filler-engine.js
 * buildFillerActions / applyFiller / fillRawScriptContent), from
 * `player.gapFiller`: its choice (the new `pattern`, else derived from
 * presetId / custom) handed to filler-presets.js resolveFillerOptions as
 * `pattern`, plus the "when" values passed in. A simple shape gives exactly
 * the fields resolveFillerOptions always gave (pattern, bpm, depthPct,
 * centrePct, absoluteDepth) and `reversed`; any other pattern gives
 * `library` (the choice). No pattern chosen: enabled false.
 * (app.js calls resolveFillerOptions itself, with `pattern: filler.pattern`:
 * absent, it reads the old keys exactly as v0.9.2 did.)
 * @param {object} gapFiller  settings.player.gapFiller
 * @param {{enabled?:boolean, thresholdMs?:number, totalDurationMs?:number, maxJoinSpeed?:number}} [extras]
 */
export function resolveGapFillerOptions(gapFiller, extras = {}) {
  const g = isObj(gapFiller) ? gapFiller : {};
  return resolveFillerOptions({
    enabled: extras.enabled !== undefined ? extras.enabled : g.enabled === true,
    thresholdMs: extras.thresholdMs !== undefined ? extras.thresholdMs : (g.thresholdMs || 10000),
    totalDurationMs: extras.totalDurationMs || 0,
    maxJoinSpeed: extras.maxJoinSpeed !== undefined ? extras.maxJoinSpeed : g.maxJoinSpeed,
    pattern: readPatternChoice('gapFiller', { gapFiller: g }),
  });
}

// ---------- the preview and the Test button ----------
/** A loop laid end to end over [0, durationMs]; an ending played once and then held. */
function tileLoop(loop, durationMs) {
  const src = loop.actions;
  const out = [];
  if (loop.once) {
    for (const a of src) { if (a.at > durationMs) break; out.push({ at: a.at, pos: a.pos }); }
    const last = out[out.length - 1];
    if (last && last.at < durationMs) out.push({ at: durationMs, pos: last.pos });
    return out;
  }
  out.push({ at: 0, pos: src[0].pos });
  for (let base = 0; base < durationMs; base += loop.loopMs) {
    for (let i = 1; i < src.length; i++) {
      const at = base + src[i].at;
      if (at > durationMs) return out;
      out.push({ at, pos: src[i].pos });
    }
  }
  return out;
}

/** The Gap Filler's own output for an `durationMs` gap with a neighbour either side at the band's middle. */
function gapFillerSample(c, durationMs, scriptRange, maxJoinSpeed) {
  const join = Number.isFinite(maxJoinSpeed) && maxJoinSpeed > 0 ? maxJoinSpeed : DEFAULT_MAX_JOIN_SPEED;
  const gap = { startMs: 0, endMs: durationMs };
  if (isShapeId(c.id)) {
    const o = resolveGapFillerOptions({ pattern: c }, { enabled: true });
    const band = o.absoluteDepth || depthBand(scriptRange, o.depthPct, o.centrePct);
    const mid = Math.round((band.min + band.max) / 2);
    const actions = buildGapFiller(gap, mid, mid, {
      pattern: o.pattern, bpm: o.bpm, min: band.min, max: band.max, maxJoinSpeed: join, reversed: o.reversed,
    });
    return { actions: actions.map((a) => ({ at: a.at, pos: a.pos })), warnings: [] };
  }
  const p = resolveChoice(c, { scriptRange });
  const loop = patternSourceLoop(p);
  const lo = p.min !== null ? p.min : (describePattern(p.id)?.range?.[0] ?? 0);
  const hi = p.max !== null ? p.max : (describePattern(p.id)?.range?.[1] ?? 100);
  const mid = Math.round((lo + hi) / 2);
  const actions = buildLibraryGapFiller(gap, mid, mid, { pattern: p, maxJoinSpeed: join });
  return { actions: actions.map((a) => ({ at: a.at, pos: a.pos })), warnings: loop ? loop.warnings.slice() : [] };
}

/**
 * Render what the choice plays, for the preview and the Test button.
 * @param {object} choice
 * @param {{ durationMs?: number, scriptRange?: {min:number,max:number}|null,
 *           feature?: PatternFeature, maxJoinSpeed?: number }} [opts]
 *   durationMs defaults to 8000; scriptRange is used by rangeMode 'script'
 *   (the preview passes a neutral 0-100 range when there is no script).
 *   feature 'gapFiller' (optional, added by pf-engine): the Gap Filler's own
 *   output for a gap that long with a neighbour either side (its joins at no
 *   more than maxJoinSpeed, default 300 u/s, and square / sawtooth ramped,
 *   as filler-preview.js drew it); otherwise X's / Z's loop laid end to end
 *   (an ending: once, then held).
 * @returns {{ actions: {at:number,pos:number}[], warnings: Array<{code:string, values?:object}> }}
 *   warnings: renderLoop's ({ code: 'range-widened', values: { from, to } }),
 *   or { code: 'no-pattern' } / { code: 'render-failed' } with no actions.
 */
export function renderPatternSample(choice, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const durationMs = Number.isFinite(o.durationMs) && o.durationMs > 0 ? Math.round(o.durationMs) : SAMPLE_MS;
  const c = normalizePatternChoice(choice);
  if (c.id === null) return { actions: [], warnings: [{ code: 'no-pattern' }] };
  const scriptRange = validRange(o.scriptRange) ? o.scriptRange : NEUTRAL_RANGE;
  try {
    if (o.feature === 'gapFiller') return gapFillerSample(c, durationMs, scriptRange, o.maxJoinSpeed);
    const src = choiceSource(c, { scriptRange });
    if (!src) return { actions: [], warnings: [{ code: 'render-failed' }] };
    return { actions: tileLoop(src.loop, durationMs), warnings: src.loop.warnings.slice() };
  } catch (err) {
    return { actions: [], warnings: [{ code: 'render-failed', values: { message: String(err?.message || err) } }] };
  }
}

/**
 * The band a sample plays in when the engine widened the one asked for
 * (renderLoop's range-widened: a range under 5 units, or one the pattern
 * cannot move in), as [lo, hi] whole numbers; null when it plays the band
 * asked for, when the choice has no band of its own (range mode 'own'), or
 * when the engine gave no numbers. The block's note under the range rows and
 * the summary row's note both read it, so they name the same band.
 * @param {object} choice
 * @param {Array} warnings  renderPatternSample's
 * @param {{at:number,pos:number}[]} [actions]  the sample (an old bare 'range-widened' is named from where it goes)
 * @returns {[number, number]|null}
 */
export function widenedBand(choice, warnings, actions = []) {
  if (normalizePatternChoice(choice).rangeMode === 'own') return null;
  for (const w of Array.isArray(warnings) ? warnings : []) {
    if (w && typeof w === 'object' && w.code === 'range-widened' && Array.isArray(w.values?.to)) {
      return [Math.round(w.values.to[0]), Math.round(w.values.to[1])];
    }
    if (w === 'range-widened' && Array.isArray(actions) && actions.length) {
      const pos = actions.map((a) => a.pos);
      return [Math.round(Math.min(...pos)), Math.round(Math.max(...pos))];
    }
  }
  return null;
}

// ---------- the summary graph's window ----------
/** ms: the shortest stretch of a pattern a summary graph shows (a shorter loop is drawn again to fill it). */
export const SUMMARY_MIN_MS = 4000;
/**
 * ms: the longest. Every loop of the library fits (renderLoop's are at most
 * 2x its 10 s target); a slower one, or a long ending (up to ~57 s), shows
 * its first 20 s. On the 240 px graph that is 12 px a second, about the
 * densest that still reads as strokes.
 */
export const SUMMARY_MAX_MS = 20000;

/**
 * How long a sample must be to show the whole pattern once (TODO 2026-11-19:
 * the summary showed the first 4 s, so a pattern that builds up, the
 * upgraded Crescendo / Building preset, drew a flat line): one loop of what
 * X and Z play (an ending: once through; a simple shape: its whole beats
 * near 10 s, the build of 'escalating' included), held to SUMMARY_MIN_MS -
 * SUMMARY_MAX_MS. For the Gap Filler (feature 'gapFiller') its joins either
 * side are added, so the pattern between them is that long. SUMMARY_MIN_MS
 * when nothing is chosen or nothing can be rendered.
 * @param {object} choice
 * @param {{ scriptRange?: {min:number,max:number}|null, feature?: PatternFeature, maxJoinSpeed?: number }} [opts]
 * @returns {number} ms
 */
export function representativeMs(choice, opts = {}) {
  const o = isObj(opts) ? opts : {};
  let body = SUMMARY_MIN_MS;
  try {
    const p = resolveChoice(choice, { scriptRange: validRange(o.scriptRange) ? o.scriptRange : NEUTRAL_RANGE });
    const loop = p ? patternSourceLoop(p) : null;
    if (loop && loop.loopMs > 0) body = clamp(Math.round(loop.loopMs), SUMMARY_MIN_MS, SUMMARY_MAX_MS);
  } catch { /* nothing to measure: the shortest */ }
  if (o.feature !== 'gapFiller') return body;
  const join = Number.isFinite(o.maxJoinSpeed) && o.maxJoinSpeed > 0 ? o.maxJoinSpeed : DEFAULT_MAX_JOIN_SPEED;
  return body + 2 * joinReserveMs(join);
}

/** ms: a leg this short is an instant jump (square's and sawtooth's 1 ms edges), not a stroke. */
export const INSTANT_LEG_MS = 1;

/**
 * Average and peak speed of a rendered sample, units a second (rounded):
 * the plain mean of the moving legs and the fastest (library-search.js
 * computeSpeedStats, as the Gap Filler preview always showed), as they are
 * (pf-review PF-R2, 2026-11-19: the 600 cap here read "peak 600" for a sine
 * that sent 880). An instant jump (a leg of INSTANT_LEG_MS or less: square's
 * and sawtooth's edges in X and Z) has no speed to show: it is counted in
 * `instant`, outside the average and the peak, and the preview says so.
 * @param {{at:number,pos:number}[]} actions
 * @returns {{ avg: number, peak: number, instant: number }}
 */
export function patternStats(actions) {
  if (!Array.isArray(actions) || actions.length < 2) return { avg: 0, peak: 0, instant: 0 };
  let total = 0, peak = 0, n = 0, instant = 0;
  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1], b = actions[i];
    if (!a || !b) continue;
    const dt = b.at - a.at;
    if (!(dt > 0)) continue;
    const dp = Math.abs(b.pos - a.pos);
    if (!(dp > 0)) continue;
    if (dt <= INSTANT_LEG_MS) { instant++; continue; }
    const v = (dp / dt) * 1000;
    total += v; n++;
    if (v > peak) peak = v;
  }
  return { avg: n ? Math.round(total / n) : 0, peak: Math.round(peak), instant };
}
