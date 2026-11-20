// Orgasm Switch "Generated pattern" source (Downlow87 #373).
//
// `player.orgasmPattern` = { enabled, type, bpm, min, max }. Off (the default)
// the finisher is the script file(s) chosen with Configure…, exactly as
// before. On, app.js `_reloadOrgasmScripts` seeds the switch's two caches
// under ONE synthetic key with the pattern below, and the rest of the switch
// cannot tell the difference: the plan resolver sees a single-script entry,
// the per-tick loop drives Buttplug / T-Code from the parsed actions, and the
// Handy finisher uploads the raw funscript JSON (tiled, like a file's). The
// file configuration is never read or written while it is on, so switching
// back finds it untouched.
//
// Pure: no DOM, no settings, no devices.

import { generatePattern } from './script-modifiers.js';

/** generatePattern's types, in the Settings dropdown's order. */
export const ORGASM_PATTERN_TYPES = ['sine', 'triangle', 'sawtooth', 'square', 'escalating', 'random'];

/** MUST match `player.orgasmPattern` in electron/store.js DEFAULTS. */
export const ORGASM_PATTERN_DEFAULTS = Object.freeze({
  enabled: false,
  type: 'sine',
  bpm: 120,
  min: 0,
  max: 100,
});

export const ORGASM_PATTERN_BPM_MIN = 20;
export const ORGASM_PATTERN_BPM_MAX = 300;

/**
 * Loop length the pattern is generated over: about 10 s, rounded to a whole
 * number of beats so the wrap (`elapsed % loopMs`, and the Handy's tiled
 * upload) lands on the same phase the loop started on.
 */
export const ORGASM_PATTERN_LOOP_TARGET_MS = 10000;

/** Prefix of the synthetic cache key. Not a path any file can have. */
export const ORGASM_PATTERN_KEY_PREFIX = 'funsync-generated-pattern:';

function clampInt(value, lo, hi, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * The stored value made safe to use. Anything missing or out of range falls
 * back to (or is clamped into) the defaults; `enabled` is on only when it is
 * literally `true`, so a missing or broken setting is the script file.
 * @param {*} raw — `player.orgasmPattern`
 */
export function normalizeOrgasmPattern(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = ORGASM_PATTERN_DEFAULTS;
  const type = ORGASM_PATTERN_TYPES.includes(r.type) ? r.type : d.type;
  const bpm = clampInt(r.bpm, ORGASM_PATTERN_BPM_MIN, ORGASM_PATTERN_BPM_MAX, d.bpm);
  let min = clampInt(r.min, 0, 100, d.min);
  let max = clampInt(r.max, 0, 100, d.max);
  // The Settings sliders keep min <= max; a hand-edited config might not.
  if (min > max) [min, max] = [max, min];
  return { enabled: r.enabled === true, type, bpm, min, max };
}

/** The normalised pattern when it is the source, else null (script file). */
export function orgasmPatternSettings(raw) {
  const p = normalizeOrgasmPattern(raw);
  return p.enabled ? p : null;
}

/** The beat length and the whole number of beats in one loop. */
function beatGrid(bpm) {
  const beatMs = 60000 / clampInt(bpm, ORGASM_PATTERN_BPM_MIN, ORGASM_PATTERN_BPM_MAX, ORGASM_PATTERN_DEFAULTS.bpm);
  const beats = Math.max(1, Math.round(ORGASM_PATTERN_LOOP_TARGET_MS / beatMs));
  return { beatMs, beats };
}

/** Whole-beat loop length near ORGASM_PATTERN_LOOP_TARGET_MS, in ms. */
export function orgasmPatternLoopMs(bpm) {
  const { beatMs, beats } = beatGrid(bpm);
  return Math.round(beats * beatMs);
}

/**
 * The synthetic key both caches use for this pattern. It names every value
 * that shapes the content, so the Handy's cached upload (keyed by it) is
 * never reused for a different pattern.
 */
export function orgasmPatternKey(pattern) {
  const p = normalizeOrgasmPattern(pattern);
  return `${ORGASM_PATTERN_KEY_PREFIX}${p.type}/${p.bpm}bpm/${p.min}-${p.max}`;
}

/** True for a key made by orgasmPatternKey (never a file path). */
export function isOrgasmPatternKey(key) {
  return typeof key === 'string' && key.startsWith(ORGASM_PATTERN_KEY_PREFIX);
}

/**
 * Shapes with an instant edge: sawtooth's drop and square's flips.
 * generatePattern puts each edge EDGE_MS AFTER the beat it ends, so over a
 * whole loop the beats slide a millisecond per edge, the last one is cut
 * short, and the loop ends on the far side of its own wrap edge (the saw at
 * the top, the square low). The Handy's tiled upload keeps one point per
 * timestamp, so the wrap edge was lost there: a hold at the top of every
 * saw loop and a slow ramp in every square one, while Buttplug and T-Code
 * (`elapsed % loopMs`) jumped (review 2026-11-04). These shapes are built
 * from ONE generated beat instead, repeated on the exact beat grid.
 */
const EDGE_SHAPES = new Set(['sawtooth', 'square']);
/** script-modifiers.js's instant edge: 1 ms, never two points on one ms. */
const EDGE_MS = 1;

/**
 * An edge shape's loop: generatePattern's own beat, beat after beat, with
 * each beat's last point pulled EDGE_MS early so the edge back to its first
 * position falls inside the beat. The loop then ends on its first position,
 * one EDGE_MS after the last beat's end, exactly like every other beat.
 */
function edgeShapeLoop(p) {
  const { beatMs, beats } = beatGrid(p.bpm);
  const out = [];
  for (let k = 0; k < beats; k++) {
    const start = Math.round(k * beatMs);
    const len = Math.round((k + 1) * beatMs) - start;
    const beat = generatePattern(p.type, 0, len, p.bpm, p.min, p.max);
    beat[beat.length - 1] = { at: len - EDGE_MS, pos: beat[beat.length - 1].pos };
    for (const a of beat) out.push({ at: start + a.at, pos: a.pos });
  }
  out.push({ at: Math.round(beats * beatMs), pos: out[0].pos });
  return out;
}

/**
 * 'escalating' ("Building") on the exact beat grid (FT-016): `beats` cycles,
 * cycle k from Math.round(k * beatMs), bottom, then a top of
 * min + range * (k + 1) / beats at the half beat, and the loop closing on its
 * first position at orgasmPatternLoopMs. generatePattern's own escalating
 * floors its cycle count over the ROUNDED loop length, so whenever
 * Math.round(beats * beatMs) rounds down it fits one cycle fewer: 121 of the
 * 281 BPMs lost the last (strongest) beat, and the loop ended early (21 BPM
 * by 2857 ms: flat, full, flat, full instead of flat, half, full). Its
 * timestamps are kept (Math.round of the unrounded grid).
 *
 * Its positions are not (CB-16): generatePattern climbs k / (beats - 1), so
 * its first beat tops out at min and the finisher sat flat for a whole beat
 * after every wrap (1.1 s at 55 BPM, 2.9 s at 21 BPM). (k + 1) / beats
 * starts every loop on its smallest stroke and still ends it at max.
 */
function escalatingLoop(p) {
  const { beatMs, beats } = beatGrid(p.bpm);
  const range = p.max - p.min;
  const out = [];
  for (let k = 0; k < beats; k++) {
    const progress = (k + 1) / beats;
    out.push({ at: Math.round(k * beatMs), pos: p.min });
    out.push({ at: Math.round((k + 0.5) * beatMs), pos: Math.round(p.min + range * progress) });
  }
  out.push({ at: Math.round(beats * beatMs), pos: p.min });
  return out;
}

/**
 * Every other shape, generated over the whole loop. One action per
 * timestamp: `triangle` can end with a second point on the loop's last
 * millisecond (its next cycle's peak, clamped to the end); the first one
 * there is the wave's own value, so the later ones are dropped. The loop
 * ends on its first position: sine and triangle already do (to within
 * rounding), `random` ends anywhere, so its last stroke goes back to where
 * the loop starts. generatePattern itself is left alone: the editor and the
 * gap filler share it.
 */
function wholeLoop(p) {
  const actions = generatePattern(p.type, 0, orgasmPatternLoopMs(p.bpm), p.bpm, p.min, p.max)
    .filter((a, i, all) => i === 0 || a.at > all[i - 1].at);
  const last = actions.length - 1;
  if (last > 0 && actions[last].pos !== actions[0].pos) actions[last] = { at: actions[last].at, pos: actions[0].pos };
  return actions;
}

/**
 * The pattern as a funscript JSON string: what a finisher file would hold.
 * Its last action is on its first position, so the per-tick loop
 * (`elapsed % loopMs`) and the Handy's tiled upload (tileFinisherContent,
 * which keeps one point per timestamp) play the same wrap.
 * @returns {string}
 */
export function buildOrgasmPatternContent(pattern) {
  const p = normalizeOrgasmPattern(pattern);
  const actions = EDGE_SHAPES.has(p.type) ? edgeShapeLoop(p)
    : p.type === 'escalating' ? escalatingLoop(p)
      : wholeLoop(p);
  return JSON.stringify({ version: '1.0', inverted: false, range: 100, actions });
}
