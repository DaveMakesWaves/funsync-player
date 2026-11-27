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
 * Standard axis definitions, matching **MultiFunPlayer's TCode v0.3 profile**.
 *
 * MFP is the de-facto reference because it is what scripters name their files
 * against, so its mapping is the one that makes third-party scripts land on the
 * right channel. Verified 2026-08-16 against three sources vendored in the
 * knowledge base (`Device Reference/specs/`): Tempest's official OSR2 firmware,
 * the TCodeESP32 community fork, and MFP's own `DeviceSettings.cs`.
 *
 * Two things this table deliberately does NOT do:
 * - `suction` is not on `V2`. It was, and it drove nothing: a stock OSR2
 *   registers no V2 axis at all. v0.3 puts suction on `A1`.
 * - `lube` and `pump` no longer share `V1`. They collided, last write winning.
 *   v0.3 puts lube on `A2`.
 *
 * `aliases` carries every other spelling seen in the wild — MFP's alternates,
 * the raw channel name (`video.R0.funscript`), and FunSync's own legacy
 * suffixes so existing saved associations keep resolving.
 *
 * **`A0`/`A1` are genuinely contested** between firmwares: Valve/Suck on
 * Tempest builds, Suck/Suck-level on TCodeESP32. We follow Tempest and MFP.
 *
 * @type {AxisInfo[]}
 */
export const AXIS_DEFINITIONS = [
  { suffix: 'surge', tcode: 'L1', label: 'Surge / Forward', aliases: ['forward', 'l1'],   type: 'linear'  },
  { suffix: 'sway',  tcode: 'L2', label: 'Sway / Left',     aliases: ['left', 'l2'],      type: 'linear'  },
  { suffix: 'twist', tcode: 'R0', label: 'Twist / Yaw',     aliases: ['yaw', 'r0'],       type: 'rotate'  },
  { suffix: 'roll',  tcode: 'R1', label: 'Roll',            aliases: ['r1'],              type: 'rotate'  },
  { suffix: 'pitch', tcode: 'R2', label: 'Pitch',           aliases: ['r2'],              type: 'rotate'  },
  { suffix: 'vib',   tcode: 'V0', label: 'Vibe',            aliases: ['vibrate', 'vibe', 'v0'],   type: 'vibrate' },
  { suffix: 'pump',  tcode: 'V1', label: 'Pump',            aliases: ['v1'],              type: 'vibrate' },
  { suffix: 'valve', tcode: 'A0', label: 'Valve',           aliases: ['a0'],              type: 'linear'  },
  { suffix: 'suck',  tcode: 'A1', label: 'Suck / Suction',  aliases: ['suction', 'a1'],   type: 'vibrate' },
  { suffix: 'lube',  tcode: 'A2', label: 'Lube',            aliases: ['a2'],              type: 'vibrate' },
];

/** The short name of each axis in the editor's script list (any spelling in, by its canonical axis). */
const SHORT_LABELS = Object.freeze({
  surge: 'Surge', sway: 'Sway', twist: 'Twist', roll: 'Roll', pitch: 'Pitch',
  vib: 'Vibe', pump: 'Pump', valve: 'Valve', suck: 'Suction', lube: 'Lube',
});

export function axisShortLabel(suffix) {
  const axis = getAxisBySuffix(suffix);
  return axis ? SHORT_LABELS[axis.suffix] || axis.label : String(suffix || '');
}

/**
 * Every accepted spelling for an axis, canonical first.
 * Used for auto-assign probing, which has to look for `.suck.funscript` AND
 * `.suction.funscript` — a scripter's choice of word must not decide whether
 * their file is found.
 *
 * @param {AxisInfo} axis
 * @returns {string[]}
 */
export function axisSuffixVariants(axis) {
  if (!axis) return [];
  return [axis.suffix, ...(axis.aliases || [])];
}

/** Map of lowercase suffix (canonical AND alias) → AxisInfo for fast lookup. */
const _suffixMap = new Map();
for (const axis of AXIS_DEFINITIONS) {
  for (const name of axisSuffixVariants(axis)) _suffixMap.set(name, axis);
}

/**
 * Resolve any accepted spelling to its axis definition.
 *
 * Saved associations are keyed by whatever suffix was canonical when they were
 * written, so this must stay alias-aware or old configs silently lose axes.
 *
 * @param {string} suffix — canonical name, alias, or raw channel
 * @returns {AxisInfo|null}
 */
export function getAxisBySuffix(suffix) {
  if (!suffix) return null;
  return _suffixMap.get(String(suffix).toLowerCase()) || null;
}

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
 * Build a reusable base-name → companions index over a whole script list.
 *
 * `detectCompanionFiles` re-walks the ENTIRE list for every primary it is
 * asked about, lower-casing and splitting each path as it goes. One call is
 * cheap; a call per video is not. `_countAutoPromotionEligible` did exactly
 * that from a `change` handler on the settings dropdown, so on stingray's
 * library it blocked the renderer long enough to look like a hang before the
 * confirmation dialog appeared at all (2026-08-24: "the app freezes for a few
 * seconds"). 104 videos × 135 scripts is only 14k, but the same loop runs on
 * every scan, and libraries an order of magnitude larger are normal.
 *
 * Build once, look up per video: O(F) instead of O(V × F).
 *
 * @param {string[]} allFiles — every known funscript path
 * @returns {Map<string, Array<{path: string, axis: AxisInfo}>>} keyed by
 *   lowercase base name (suffix and extension stripped)
 */
export function buildCompanionIndex(allFiles) {
  const index = new Map();
  if (!allFiles) return index;

  for (const file of allFiles) {
    if (!file) continue;
    const filename = file.split(/[\\/]/).pop() || '';
    const axis = parseAxisSuffix(filename);
    // Primary files and non-funscripts carry no axis, and only companions
    // are ever looked up here — skipping them keeps the index small and
    // means a hit is already the answer, with no filtering at lookup time.
    if (!axis) continue;

    const base = getBaseName(filename).toLowerCase();
    if (!base) continue;

    const bucket = index.get(base);
    if (bucket) bucket.push({ path: file, axis });
    else index.set(base, [{ path: file, axis }]);
  }

  return index;
}

/**
 * Companion lookup against a prebuilt index. Same return shape and same
 * matching rule as `detectCompanionFiles` — pinned by a test that runs both
 * over the same inputs — so the two cannot quietly diverge.
 *
 * @param {string} primaryPath — path to the primary .funscript file
 * @param {Map<string, Array<{path: string, axis: AxisInfo}>>} index
 * @returns {Array<{path: string, axis: AxisInfo}>}
 */
export function detectCompanionFilesIndexed(primaryPath, index) {
  if (!primaryPath || !index || index.size === 0) return [];
  const primaryBase = getBaseName(primaryPath).toLowerCase();
  if (!primaryBase) return [];
  return index.get(primaryBase) || [];
}

/**
 * The companion axis files that sit beside one script in its own folder:
 * `<stem>.<axis>.funscript` next to `<stem>.funscript`, matched as
 * `detectCompanionFiles` matches them (any case, every spelling in
 * AXIS_DEFINITIONS). A script variant plays with these ("Title (muted).vib
 * .funscript" beside "Title (muted).funscript": app.js `_multiAxisForScript`,
 * TODO 2026-11-20), and the scan claims the same files for its video
 * (electron/library-scan.js). Another folder's file of that name belongs to
 * another copy of the script, so only the script's own folder counts.
 *
 * @param {string} scriptPath — the script (a variant) the axes go with
 * @param {string[]} allFiles — every known funscript path
 * @returns {Object<string, string>} canonical axis suffix → path, the first
 *   file found per axis
 */
export function sameFolderCompanions(scriptPath, allFiles) {
  const out = {};
  if (!scriptPath || !Array.isArray(allFiles) || allFiles.length === 0) return out;
  const folderOf = (p) => {
    const s = String(p).replace(/\\/g, '/');
    return s.slice(0, Math.max(0, s.lastIndexOf('/'))).toLowerCase();
  };
  const folder = folderOf(scriptPath);
  for (const c of detectCompanionFiles(scriptPath, allFiles)) {
    if (folderOf(c.path) !== folder) continue;
    if (!out[c.axis.suffix]) out[c.axis.suffix] = c.path;
  }
  return out;
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
