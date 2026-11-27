// Embedded multi-axis extractor — handles funscripts that bundle
// pitch/roll/twist/surge data INSIDE a single .funscript file instead
// of distributing across companion files (`video.pitch.funscript`,
// `video.roll.funscript`, etc).
//
// FunSync's companion-file detection (`multi-axis.js::detectCompanionFiles`)
// already covers the OFS-canonical pattern. This module covers the
// FIVE non-canonical embedded formats that show up on EroScripts and
// other forums:
//
// Format A — HereSphere style (`additional_axes`):
//   {
//     "actions": [...],
//     "additional_axes": [
//       { "axis": "twist", "actions": [...] },
//       { "axis": "pitch", "actions": [...] }
//     ]
//   }
//
// Format B — OFS-extended `raw`:
//   {
//     "actions": [...],
//     "raw": {
//       "twist": { "actions": [...] },
//       "pitch": { "actions": [...] }
//     }
//   }
//
// Format C — direct sibling keys:
//   { "actions": [...], "twist": [...], "pitch": {"actions": [...]} }
//
// Format D — inline TCode per action (rare; some OSR2 community drops):
//   {
//     "tcode": "0.3",
//     "actions": [
//       { "at": 100, "pos": 50, "R0": 80, "R1": 30, "R2": 70 }
//     ]
//   }
//
// Format E — `axes` array keyed by TCode id (Iwara / 99DM scripter
// convention, version 1.1 funscripts):
//   {
//     "actions": [...],
//     "axes": [
//       { "id": "R1", "actions": [...] },
//       { "id": "R2", "actions": [...] }
//     ],
//     "version": "1.1"
//   }
// Surfaced via community report 2026-05-30: 99DM's Iwara scripts ship
// in this shape. Detection ordering puts E above C/D (more explicit
// than loose sibling sniffing or inline) but below A/B (which are the
// most widely-documented formats and win precedence ties).
//
// Format F — funscript 2.0 `channels` object, keyed by AXIS NAME:
//   {
//     "version": "funscript@2.0.0-alpha.1",
//     "actions": [...],
//     "channels": {
//       "stroke": { "actions": [...] },
//       "twist":  { "actions": [...], "range": [10, 90] }
//     }
//   }
// Dimava's spec from the Single-file multi-axis RFC (EroScripts topic
// 267449 #34), and what the site's "download as 2.0" button emits since
// MFP v1.33.9 / XTP v0.55b. Requested by dio_likes_jojo (#311), who found
// a 2.0 download played the stroke axis and nothing else.
//
// Two things separate it from Format E: the container is an OBJECT keyed by
// axis NAME rather than an array keyed by TCode id, and a channel may carry
// its own `range: [min, max]`. Per the spec `channels.stroke` OVERRIDES the
// top-level `actions` for multi-axis devices, so it is handled by the caller
// as the main script rather than as a companion axis.
//
// Returns a `Map<suffix, actions>` keyed by the standard FunSync axis
// suffix (matches `multi-axis.js::AXIS_DEFINITIONS`). Suffixes:
// surge / sway / twist / roll / pitch / vib / lube / pump / suction / valve.

/** TCode-axis identifier → suffix mapping, the inverse of multi-axis.js
 *  AXIS_DEFINITIONS (app.js resolves the suffix back to its channel with
 *  `getAxisBySuffix`). R0/R1/R2 are rotation; L1/L2 linear surge/sway;
 *  V0 vibe, V1 pump; A0 valve, A1 suction, A2 lube (TCode v0.3, as MFP).
 *  V1 used to say lube and A1/A2 were missing: when app.js stopped mapping
 *  lube to V1 (block C fix-up, 2026-11-06), a `V1` channel would have moved
 *  to A2, and an `A1` / `A2` one was never read. */
const TCODE_TO_SUFFIX = Object.freeze({
  L0: null,    // L0 IS the main stroke — never extracted as a separate axis
  L1: 'surge',
  L2: 'sway',
  R0: 'twist',
  R1: 'roll',
  R2: 'pitch',
  V0: 'vib',
  V1: 'pump',
  V2: 'suction', // where older tools (and FunSync before 2026-08-16) put suction; plays on A1
  A0: 'valve',
  A1: 'suction',
  A2: 'lube',
});

/** Lowercase name (any of: suffix name, alternative spelling, full label)
 *  → canonical suffix. */
const NAME_ALIASES = Object.freeze({
  surge: 'surge',
  sway: 'sway',
  twist: 'twist', rotate: 'twist',
  roll: 'roll',
  pitch: 'pitch',
  vib: 'vib', vibrate: 'vib', vibration: 'vib', vibe: 'vib', // vibe: RFC #64's own example name
  lube: 'lube',
  pump: 'pump',
  suction: 'suction', suck: 'suction',
  valve: 'valve',
});

/** A funscript's `actions` array element. */
function isValidActionArray(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every(a =>
    a && typeof a === 'object' && Number.isFinite(a.at)
  );
}

/** Coerce an alternative axis name into our canonical suffix. */
function normaliseAxisName(name) {
  if (typeof name !== 'string') return null;
  return NAME_ALIASES[name.toLowerCase().trim()] || null;
}

/**
 * Extract embedded multi-axis data from a parsed funscript object.
 *
 * @param {object} parsed — already-JSON.parsed funscript content
 * @returns {Map<string, Array<{at:number, pos:number}>>} suffix → actions
 */
export function extractEmbeddedAxes(parsed) {
  const out = new Map();
  if (!parsed || typeof parsed !== 'object') return out;

  // --- Format A: `additional_axes` array (HereSphere) ----------------
  if (Array.isArray(parsed.additional_axes)) {
    for (const entry of parsed.additional_axes) {
      if (!entry || typeof entry !== 'object') continue;
      const suffix = normaliseAxisName(entry.axis);
      if (!suffix) continue;
      if (isValidActionArray(entry.actions)) {
        out.set(suffix, entry.actions);
      }
    }
  }

  // --- Format B: `raw` object (OFS-extended) -------------------------
  if (parsed.raw && typeof parsed.raw === 'object' && !Array.isArray(parsed.raw)) {
    for (const [key, val] of Object.entries(parsed.raw)) {
      const suffix = normaliseAxisName(key);
      if (!suffix) continue;
      if (val && typeof val === 'object' && isValidActionArray(val.actions)) {
        // Don't overwrite — Format A wins if both happen to be present.
        if (!out.has(suffix)) out.set(suffix, val.actions);
      }
    }
  }

  // --- Format E: `axes` array of {id, actions} -----------------------
  // Iwara / 99DM scripter convention; TCode IDs sit directly in the
  // entry's `id` field. L0 is silently ignored — it's the main stroke,
  // already covered by parsed.actions and never extracted as a separate
  // axis (matches the TCODE_TO_SUFFIX `L0: null` convention).
  if (Array.isArray(parsed.axes)) {
    for (const entry of parsed.axes) {
      if (!entry || typeof entry !== 'object') continue;
      // Defensive: id may be lowercase in some hand-edited files.
      const rawId = typeof entry.id === 'string' ? entry.id.toUpperCase() : null;
      if (!rawId || !(rawId in TCODE_TO_SUFFIX)) continue;
      const suffix = TCODE_TO_SUFFIX[rawId];
      if (!suffix) continue;                  // covers L0 (null in the map)
      if (!isValidActionArray(entry.actions)) continue;
      // Earlier-format precedence — Format A/B win if both present.
      if (out.has(suffix)) continue;
      out.set(suffix, entry.actions);
    }
  }

  // --- Format F: funscript 2.0 `channels` object -------------------
  // Placed after E and before C: it is as explicit as E (a named container
  // that can only mean multi-axis) and must beat C, whose sibling-key
  // sniffing would otherwise never see these because they are nested.
  if (parsed.channels && typeof parsed.channels === 'object' && !Array.isArray(parsed.channels)) {
    for (const [name, channel] of Object.entries(parsed.channels)) {
      // `stroke` is the main axis, not a companion — see the header note.
      if (typeof name === 'string' && name.toLowerCase().trim() === 'stroke') continue;
      const suffix = normaliseAxisName(name) || normaliseAxisName(TCODE_TO_SUFFIX[name] || '');
      if (!suffix) continue;
      // A channel is `{ actions, range? }`; tolerate a bare array too, since
      // the format is still alpha and writers vary.
      const actions = Array.isArray(channel) ? channel : channel?.actions;
      if (!isValidActionArray(actions)) continue;
      if (!out.has(suffix)) out.set(suffix, actions);
    }
  }

  // --- Format C: direct sibling keys --------------------------------
  // Walk top-level keys; skip the standard funscript fields. Anything
  // that looks like an axis name gets considered.
  const SKIP = new Set([
    'actions', 'version', 'inverted', 'range', 'metadata', 'raw',
    'additional_axes', 'tcode', 'axes',
    // Backend-cached / FunSync-internal fields — never axis data.
    'cachedAt', '_sourcePath', 'csvHash',
  ]);
  for (const [key, val] of Object.entries(parsed)) {
    if (SKIP.has(key)) continue;
    const suffix = normaliseAxisName(key);
    if (!suffix) continue;
    if (out.has(suffix)) continue; // earlier-format precedence
    // Either `key: [actions]` or `key: { actions: [...] }`.
    if (isValidActionArray(val)) {
      out.set(suffix, val);
    } else if (val && typeof val === 'object' && isValidActionArray(val.actions)) {
      out.set(suffix, val.actions);
    }
  }

  // --- Format D: inline TCode keys on each action --------------------
  // If any action object has TCode axis keys (R0, R1, R2, L1, L2, V0,
  // V1, V2, A0), pull those into separate arrays. Tagged-union per
  // action — we only emit an axis array if at least one action carries
  // that axis. `pos` (and `L0`) belong to the main stroke and are
  // ignored here.
  if (isValidActionArray(parsed.actions)) {
    const inlineByTcode = new Map(); // tcode → [{at, pos}]
    for (const a of parsed.actions) {
      for (const [k, v] of Object.entries(a)) {
        if (k === 'at' || k === 'pos' || k === 'L0') continue;
        if (!(k in TCODE_TO_SUFFIX)) continue;
        const suffix = TCODE_TO_SUFFIX[k];
        if (!suffix) continue;
        if (typeof v !== 'number') continue;
        if (!inlineByTcode.has(suffix)) inlineByTcode.set(suffix, []);
        inlineByTcode.get(suffix).push({ at: a.at, pos: v });
      }
    }
    for (const [suffix, actions] of inlineByTcode) {
      if (actions.length < 2) continue;
      // Sort by time (input order isn't guaranteed)
      actions.sort((x, y) => x.at - y.at);
      // Don't overwrite earlier-format extractions; Format D is a
      // last-resort path used when no sibling/raw/additional_axes data
      // was present.
      if (!out.has(suffix)) out.set(suffix, actions);
    }
  }

  return out;
}

/**
 * Serialise a `Map<suffix, actions>` from `extractEmbeddedAxes` into
 * separate `.funscript`-shaped objects per axis. Caller writes each to
 * disk as `<videoStem>.<suffix>.funscript` to convert an embedded
 * multi-axis file into the canonical companion-file layout.
 *
 * @param {Map<string, Array>} extracted
 * @returns {Array<{ suffix: string, content: object }>}
 */
export function buildCompanionFiles(extracted) {
  const out = [];
  for (const [suffix, actions] of extracted) {
    out.push({
      suffix,
      content: {
        version: '1.0',
        actions: actions.map(a => ({ at: a.at, pos: a.pos })),
      },
    });
  }
  return out;
}

/**
 * Build a `library.associations[path].axes` map (suffix → path) from
 * the extracted suffixes and a video path. Used after writing the
 * companion files to register them so FunSync picks them up on next
 * load like any other multi-axis setup.
 *
 * @param {string} videoPath
 * @param {Iterable<string>} suffixes
 * @returns {Object} { [suffix]: companionFunscriptPath }
 */
export function companionPathMap(videoPath, suffixes) {
  if (!videoPath) return {};
  // Mirror multi-axis.js::buildCompanionPath but inlined to keep this
  // module self-contained (avoids a runtime dep on multi-axis.js).
  const dot = videoPath.lastIndexOf('.');
  const stem = dot >= 0 ? videoPath.slice(0, dot) : videoPath;
  const out = {};
  for (const s of suffixes) {
    out[s] = `${stem}.${s}.funscript`;
  }
  return out;
}
