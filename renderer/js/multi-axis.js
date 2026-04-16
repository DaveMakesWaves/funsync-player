// MultiAxis — Detection and management of multi-axis funscript companion files
// Follows the TCode specification axis naming convention

/**
 * @typedef {Object} AxisInfo
 * @property {string} suffix — file suffix (e.g. 'twist', 'surge')
 * @property {string} tcode — TCode axis identifier (e.g. 'R0', 'L1')
 * @property {string} label — human-readable label (e.g. 'Twist', 'Surge')
 * @property {'linear'|'rotate'|'vibrate'} type — device feature type
 */

/**
 * Standard axis definitions from the TCode specification.
 * @type {AxisInfo[]}
 */
export const AXIS_DEFINITIONS = [
  { suffix: 'surge',   tcode: 'L1', label: 'Surge',   type: 'linear'  },
  { suffix: 'sway',    tcode: 'L2', label: 'Sway',    type: 'linear'  },
  { suffix: 'twist',   tcode: 'R0', label: 'Twist',   type: 'rotate'  },
  { suffix: 'roll',    tcode: 'R1', label: 'Roll',    type: 'rotate'  },
  { suffix: 'pitch',   tcode: 'R2', label: 'Pitch',   type: 'rotate'  },
  { suffix: 'vib',     tcode: 'V0', label: 'Vibe',    type: 'vibrate' },
  { suffix: 'lube',    tcode: 'V1', label: 'Lube',    type: 'vibrate' },
  { suffix: 'pump',    tcode: 'V1', label: 'Pump',    type: 'vibrate' },
  { suffix: 'suction', tcode: 'V2', label: 'Suction', type: 'vibrate' },
  { suffix: 'valve',   tcode: 'A0', label: 'Valve',   type: 'linear'  },
];

/** Map of lowercase suffix → AxisInfo for fast lookup. */
const _suffixMap = new Map(AXIS_DEFINITIONS.map(a => [a.suffix, a]));

/**
 * Parse an axis suffix from a funscript filename.
 * Returns null for primary axis files (no suffix) or non-funscript files.
 *
 * @param {string} filename — e.g. 'video.twist.funscript'
 * @returns {AxisInfo|null} parsed axis info, or null if primary/default axis
 */
export function parseAxisSuffix(filename) {
  if (!filename) return null;

  const lower = filename.toLowerCase();
  if (!lower.endsWith('.funscript')) return null;

  // Strip .funscript extension
  const base = lower.slice(0, -'.funscript'.length);

  // Look for a known suffix before .funscript
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx < 0) return null; // no suffix → primary axis

  const suffix = base.slice(dotIdx + 1);
  return _suffixMap.get(suffix) || null;
}

/**
 * Get the base name (without axis suffix and .funscript extension) from a funscript path.
 * E.g. 'C:/videos/MyVideo.twist.funscript' → 'MyVideo'
 *
 * @param {string} filepath — full path or filename
 * @returns {string} base name
 */
export function getBaseName(filepath) {
  if (!filepath) return '';

  // Extract filename from path
  const filename = filepath.split(/[\\/]/).pop() || '';
  const lower = filename.toLowerCase();

  if (!lower.endsWith('.funscript')) return filename;

  // Strip .funscript
  let base = filename.slice(0, -'.funscript'.length);

  // Strip known axis suffix if present
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx >= 0) {
    const suffix = base.slice(dotIdx + 1).toLowerCase();
    if (_suffixMap.has(suffix)) {
      base = base.slice(0, dotIdx);
    }
  }

  return base;
}

/**
 * Detect companion axis files from a list of filenames in the same directory.
 * Given a primary funscript (e.g. 'video.funscript'), finds all companion axes.
 *
 * @param {string} primaryPath — path to the primary .funscript file
 * @param {string[]} allFiles — all filenames in the same directory
 * @returns {Array<{path: string, axis: AxisInfo}>} detected companion files
 */
export function detectCompanionFiles(primaryPath, allFiles) {
  if (!primaryPath || !allFiles || allFiles.length === 0) return [];

  const primaryBase = getBaseName(primaryPath).toLowerCase();
  if (!primaryBase) return [];

  const companions = [];

  for (const file of allFiles) {
    const lower = file.toLowerCase();
    if (!lower.endsWith('.funscript')) continue;

    // Skip the primary file itself
    const filename = file.split(/[\\/]/).pop() || '';
    const fileBase = getBaseName(filename).toLowerCase();

    if (fileBase !== primaryBase) continue;

    const axis = parseAxisSuffix(filename);
    if (axis) {
      companions.push({ path: file, axis });
    }
  }

  return companions;
}

/**
 * Build a display path for a companion axis file.
 * Given a video path, returns the expected funscript path for a given axis.
 *
 * @param {string} videoPath — e.g. 'C:/videos/MyVideo.mp4'
 * @param {string} suffix — axis suffix (e.g. 'twist', 'surge')
 * @returns {string} expected companion path
 */
export function buildCompanionPath(videoPath, suffix) {
  if (!videoPath) return '';
  return videoPath.replace(/\.[^/.]+$/, '') + '.' + suffix + '.funscript';
}

/**
 * Generate axis badge labels for display (e.g. on library cards).
 * Returns labels for all detected companion axes.
 *
 * @param {Array<{axis: AxisInfo}>} companions — from detectCompanionFiles
 * @returns {string[]} badge labels (e.g. ['Twist', 'Surge', 'Vibe'])
 */
export function getAxisBadges(companions) {
  if (!companions || companions.length === 0) return [];
  return companions.map(c => c.axis.label);
}

/**
 * Map an axis type to the appropriate Buttplug device feature.
 *
 * @param {string} tcode — TCode axis identifier (e.g. 'R0', 'L1', 'V0')
 * @returns {'linear'|'rotate'|'vibrate'} device feature type
 */
export function tcodeToFeature(tcode) {
  if (!tcode) return 'linear';
  const prefix = tcode.charAt(0).toUpperCase();
  switch (prefix) {
    case 'L': return 'linear';
    case 'R': return 'rotate';
    case 'V': return 'vibrate';
    case 'A': return 'linear';
    default: return 'linear';
  }
}
