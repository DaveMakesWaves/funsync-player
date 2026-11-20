// Filler presets — named speed/pattern/depth combinations for gap filler.
//
// Depth is a PERCENTAGE OF THE AUTHORED SCRIPT'S NATURAL RANGE, never an
// absolute 0-100 band. See resolveDepth() in filler-engine.js for why.
//
// All of these are deliberately gentler than main-script content: this plays
// during downtime, and on Buttplug devices running in 'speed' mode the BPM
// translates directly into vibration intensity, so a "gentle" preset has to
// actually be gentle rather than merely shallow.
//
// Since the pattern settings unification (2026-11-19) these are the Quick
// picks of all three pattern blocks (pattern-choice.js listQuickPicks, in
// units a second), and the filler's pattern is the shared choice
// `player.gapFiller.pattern` when it is there (resolveFillerOptions'
// `pattern`); without it the old presetId / custom are read exactly as
// v0.9.2 read them.

import { normalizePatternChoice, patternBasis, isStaleChoice } from './pattern-source.js';
import { isShapeId, shapeTypeOf, shapeBpm, SHAPE_OWN_SPEED } from './pattern-library-shapes.js';
import { depthBand, NEUTRAL_RANGE } from './filler-pattern.js';

/**
 * @typedef {object} FillerPreset
 * @property {string} id
 * @property {string} labelKey    i18n key
 * @property {string} pattern     generatePattern() type
 * @property {number} bpm
 * @property {number} depthPct    percentage of the authored natural range
 * @property {number|null} centrePct  null = centre of the authored range
 */

/** @type {FillerPreset[]} */
export const FILLER_PRESETS = [
  {
    id: 'slowTease',
    labelKey: 'filler.preset.slowTease',
    pattern: 'sine',
    bpm: 20,
    depthPct: 60,
    centrePct: null,
  },
  {
    id: 'gentle',
    labelKey: 'filler.preset.gentle',
    pattern: 'sine',
    bpm: 30,
    depthPct: 80,
    centrePct: null,
  },
  {
    id: 'steady',
    labelKey: 'filler.preset.steady',
    pattern: 'triangle',
    bpm: 40,
    depthPct: 100,
    centrePct: null,
  },
  {
    id: 'building',
    labelKey: 'filler.preset.building',
    pattern: 'escalating',
    bpm: 35,
    depthPct: 100,
    centrePct: null,
  },
  {
    id: 'drift',
    labelKey: 'filler.preset.drift',
    pattern: 'random',
    bpm: 25,
    depthPct: 60,
    centrePct: null,
  },
  {
    // Square is an instantaneous edge by definition. It is only shippable
    // because every filler run goes through the slew-rate limiter, which
    // turns those edges into ramps. Never bypass the limiter for this one.
    id: 'pulse',
    labelKey: 'filler.preset.pulse',
    pattern: 'square',
    bpm: 25,
    depthPct: 60,
    centrePct: null,
  },
];

export const DEFAULT_PRESET_ID = 'slowTease';

/** Look a preset up by id, falling back to the default rather than throwing. */
export function getPreset(id) {
  return FILLER_PRESETS.find((p) => p.id === id)
    || FILLER_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID);
}

/**
 * The fingerprint of what the OLD Gap Filler keys say about the pattern
 * (pf-review PF-R6): the preset (absent = the default), and the Custom fields
 * only when the preset is Custom, each read with the defaults the engine
 * reads it with. v0.9.2 rewrites `custom` from its form at every save,
 * whatever the preset, and writes the default preset out: neither changes
 * this. pattern-choice.js stores it as `gapFiller.pattern.basis`.
 * @param {object} gapFiller  settings.player.gapFiller (or { presetId, custom })
 * @returns {string}
 */
export function fillerOldKeysBasis(gapFiller) {
  const g = gapFiller && typeof gapFiller === 'object' ? gapFiller : {};
  const presetId = g.presetId === undefined || g.presetId === null || g.presetId === '' ? DEFAULT_PRESET_ID : String(g.presetId);
  const c = presetId === 'custom' && g.custom && typeof g.custom === 'object' ? g.custom : null;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const a = c && c.absolute && typeof c.absolute === 'object' ? c.absolute : null;
  return patternBasis({
    presetId,
    custom: c ? {
      pattern: typeof c.pattern === 'string' && c.pattern ? c.pattern : 'sine',
      bpm: num(c.bpm, 20),
      depthPct: num(c.depthPct, 100),
      centrePct: num(c.centrePct, null),
      absolute: a && Number.isFinite(a.min) && Number.isFinite(a.max) ? { min: a.min, max: a.max } : null,
    } : null,
  });
}

/**
 * Turn stored settings into the options object filler-engine expects.
 * `custom` bypasses the preset table entirely and may set an absolute depth.
 *
 * @param {object} settings
 * @returns {object} options for buildFillerActions()
 */
export function resolveFillerOptions(settings = {}) {
  const {
    enabled = false,
    presetId = DEFAULT_PRESET_ID,
    thresholdMs = 10000,
    totalDurationMs = 0,
    maxJoinSpeed,
    custom = null,
    pattern = null,
  } = settings;

  // The shared choice (pattern-choice.js), when there is one, unless the old
  // keys were changed after it was written (a downgraded build, a merge
  // import): then they play, as that build played them (PF-R6).
  if (pattern && typeof pattern === 'object' && !Array.isArray(pattern)
    && !isStaleChoice(pattern, fillerOldKeysBasis({ presetId, custom }))) {
    return { enabled, thresholdMs, totalDurationMs, maxJoinSpeed, ...choiceFillerOptions(pattern, enabled) };
  }

  if (presetId === 'custom' && custom) {
    return {
      enabled,
      thresholdMs,
      totalDurationMs,
      maxJoinSpeed,
      pattern: custom.pattern || 'sine',
      bpm: Number.isFinite(custom.bpm) ? custom.bpm : 20,
      depthPct: Number.isFinite(custom.depthPct) ? custom.depthPct : 100,
      centrePct: Number.isFinite(custom.centrePct) ? custom.centrePct : null,
      absoluteDepth: custom.absolute || null,
    };
  }

  const preset = getPreset(presetId);
  return {
    enabled,
    thresholdMs,
    totalDurationMs,
    maxJoinSpeed,
    pattern: preset.pattern,
    bpm: preset.bpm,
    depthPct: preset.depthPct,
    centrePct: preset.centrePct,
    absoluteDepth: null,
  };
}

/**
 * A choice of the shared pattern block (pattern-choice.js) as the engine's
 * options. A simple shape: the fields above, its speed turned back into
 * strokes a minute at the band it is measured on (range 'script': the
 * script's band on a whole-range script, which keeps the timing the same on
 * every script, exactly as a BPM did; 'exact': its band; 'own': 0-100), and
 * `reversed`. Any other pattern: `library` (the choice; filler-engine.js
 * hands it to filler-pattern.js). No pattern chosen: enabled false.
 * @param {object} raw  the choice
 * @param {boolean} enabled
 */
export function choiceFillerOptions(raw, enabled = true) {
  const c = normalizePatternChoice(raw);
  if (c.id === null) return { enabled: false };
  if (!isShapeId(c.id)) return { enabled, library: c };
  const type = shapeTypeOf(c.id);
  const speed = c.speed !== null ? c.speed : SHAPE_OWN_SPEED;
  if (c.rangeMode === 'script') {
    const ref = depthBand(NEUTRAL_RANGE, c.depthPct, c.centrePct);
    return {
      enabled,
      pattern: type,
      bpm: shapeBpm(speed, ref.max - ref.min),
      depthPct: c.depthPct,
      centrePct: c.centrePct,
      absoluteDepth: null,
      reversed: c.reversed,
    };
  }
  const lo = c.rangeMode === 'exact' ? c.min : 0;
  const hi = c.rangeMode === 'exact' ? c.max : 100;
  return {
    enabled,
    pattern: type,
    bpm: shapeBpm(speed, hi - lo),
    depthPct: 100,
    centrePct: null,
    absoluteDepth: { min: lo, max: hi },
    reversed: c.reversed,
  };
}
