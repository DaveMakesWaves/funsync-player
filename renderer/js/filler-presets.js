// Filler presets — named speed/pattern/depth combinations for gap filler.
//
// Depth is a PERCENTAGE OF THE AUTHORED SCRIPT'S NATURAL RANGE, never an
// absolute 0-100 band. See resolveDepth() in filler-engine.js for why.
//
// All of these are deliberately gentler than main-script content: this plays
// during downtime, and on Buttplug devices running in 'speed' mode the BPM
// translates directly into vibration intensity, so a "gentle" preset has to
// actually be gentle rather than merely shallow.

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
  } = settings;

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
