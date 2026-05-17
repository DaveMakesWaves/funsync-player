// VR detection for library filtering.
//
// Optimized for recall: the user selects the VR filter because they want to
// narrow a library *down* to VR content. Missing real VR files is worse than
// occasionally including a non-VR one that happens to have a matching token.
//
// Detects via:
//   1. Strong projection/stereo tokens (sbs, tb, ou, lr, 3dh, 3dv, mkx200, ...)
//   2. VR resolution tags (VR180, VR360, VR200, 8KVR, VR7K, 180VR, ...)
//   3. Known Japanese VR studio catalog prefixes (SIVR-123, KAVR123, [SIVR-456])
//   4. Broad XXVR-### / VRXX-### studio-code fallback
//   5. Bare "VR" as its own whitespace/punctuation-delimited token
//
// All checks run against the full path string so folder-based organization
// (e.g. `Downloads/VR/movie.mp4`) is picked up too.

// Studio catalog — mirrors backend/routes/vr_api.py VR_STUDIO_FORMATS keys.
const VR_STUDIO_CODES = new Set([
  // Japanese (fisheye-default)
  'SIVR','KAVR','SAVR','DSVR','PRVR','IPVR','MDVR','WAVR','NHVR','EBVR',
  'HNVR','MTVR','ATVR','EXVR','WPVR','PXVR','TMAVR','FSVR','UNVR','DOVR',
  'JUVR','MXVR','KMVR','VRKM','BIKMVR','CBIKMVR','KIWVR','VRSP','URVRSP',
  'AVOPVR','GOPJ','CJVR',
  // Western (mostly equirect 180 SBS)
  'WANKZVR','NAVR','NAUGHTYAMERICAVR','BADOINKVR','BAVR','MILFVR','POVR',
  'SINSVR','REALJAMVR','RJVR','CZECHVR','CZECHVRCASTING','CZECHVRFETISH',
  'CZECHVRNETWORK','TMWVRNET','VIRTUALREALPORN','VRP','LETHALHARDCOREVR',
  'LHVR','SLRORIGINALS','DARKROOMVR','SWEETLIFEVR','HOLOGIRLSVR','STASYQVR',
  'VRALLURE','VRHUSH','GROOBYVR','GROVR','KINKVR','18VR','EVILANGELVR',
  'EAVR','METAVERSEVR','ZEXYVR','REALHOTVR','VRLATINA','PORNHATVR',
  'COSPLAYBABESVR','VRTRANSTASTY',
  // Western (fisheye)
  'VRBANGERS','VRB','VRCONK',
  // Rip-group / obfuscated (mapped to dome in backend)
  'VRBTS','VRBTNS','VRBS','VRBANS',
]);

// Character class matching any common filename separator.
// Using String.raw so the regex source reads literally.
const SEP = String.raw`[_\-. /\\\[\]()]`;

// Projection / stereo format tokens — if any of these appear as a whole token,
// the file is treated as VR.
const STRONG_TOKENS = [
  'sbs','tb','ou','lr',
  '3dh','3dv','mono180','mono360',
  'mkx200','mkx220','rf52','fisheye190','vrca220',
  'fb360','eac360','eac',
  '180x180','360x180',
];

const STRONG_RE = new RegExp(
  `(?:^|${SEP})(?:${STRONG_TOKENS.join('|')})(?=${SEP}|$)`,
  'i'
);

// Numeric VR tags: VR180, VR360, VR200, 180VR, 360VR, VR8K, 8KVR, ...
const VR_TAG_RE = new RegExp(
  `(?:^|${SEP})(?:VR\\d{2,4}|\\d{2,4}VR|VR\\d+K|\\d+KVR)(?=${SEP}|$)`,
  'i'
);

// Bare "VR" as its own token.
const BARE_VR_RE = new RegExp(
  `(?:^|${SEP})VR(?=${SEP}|$)`,
  'i'
);

// Broad XXVR-### / VRXX-### fallback for unlisted studios.
const STUDIO_FALLBACK_RE = new RegExp(
  `(?:^|${SEP})(?:[A-Z]{1,8}VR[A-Z]{0,3}|VR[A-Z]{1,4})${SEP}*\\d{2,5}`,
  'i'
);

const SPLIT_RE = new RegExp(`${SEP}+`);
const STUDIO_COMBO_RE = /^([A-Z]{2,8})(\d{2,5})$/;

// Per-video manual override store. Keyed by video path; value is 'vr' or
// 'flat' (no entry = use heuristic). Wired by `setOverrideStore(getter)`
// at app boot — tested by passing different getters in unit tests.
// Default getter returns null (no override) so call sites that pass a
// raw string (no path) keep their existing behaviour.
let _overrideGetter = () => null;

/**
 * Register a getter that returns the manual VR override for a given path.
 * The getter receives a path string and should return `'vr'`, `'flat'`,
 * or `null` / `undefined` if no override is set.
 *
 * Called once at app boot (renderer/js/app.js) and again whenever the
 * web-remote receives a fresh override map from the backend. Idempotent.
 *
 * @param {(path: string) => 'vr' | 'flat' | null | undefined} getter
 */
export function setOverrideStore(getter) {
  _overrideGetter = (typeof getter === 'function') ? getter : () => null;
}

function _check(s) {
  if (!s) return false;
  const stem = s.replace(/\.[^./\\]+$/, ''); // strip trailing extension

  if (STRONG_RE.test(stem)) return true;
  if (VR_TAG_RE.test(stem)) return true;
  if (BARE_VR_RE.test(stem)) return true;
  if (STUDIO_FALLBACK_RE.test(stem)) return true;

  // Known studio prefixes via tokenization — catches SIVR178 (no dash) too.
  const tokens = stem.split(SPLIT_RE);
  for (const tok of tokens) {
    if (!tok) continue;
    const upper = tok.toUpperCase();
    if (VR_STUDIO_CODES.has(upper)) return true;
    const m = upper.match(STUDIO_COMBO_RE);
    if (m && VR_STUDIO_CODES.has(m[1])) return true;
  }

  return false;
}

// Stereo-layout tokens for the "show as flat" feature (Monoinc 2026-05-17).
// When the user is on a desktop monitor (not in a headset), an SBS / TB
// VR video looks squished — half the image width / height = wrong aspect
// for that eye. The flat-view feature crops to one eye and rescales.
//
// Detection is filename-based using the HereSphere / DeoVR token
// conventions. Half-SBS vs full-SBS is distinguished by the `F` suffix
// (HereSphere convention) — full means each eye is already at the
// container's natural aspect; half means the eye is horizontally
// compressed and needs a 2× horizontal scale-up.
const STEREO_SBS_HALF = /(?:^|[_\-. \/\\])(?:sbs|lr|3dh|180x180|180_lr|180_sbs|mono180)(?=$|[_\-. \/\\])/i;
const STEREO_SBS_FULL = /(?:^|[_\-. \/\\])(?:sbsf|lrf|sbs_full|fullsbs|180x360)(?=$|[_\-. \/\\])/i;
const STEREO_TB_HALF  = /(?:^|[_\-. \/\\])(?:tb|ou|3dv|tb_half)(?=$|[_\-. \/\\])/i;
const STEREO_TB_FULL  = /(?:^|[_\-. \/\\])(?:tbf|ouf|tb_full)(?=$|[_\-. \/\\])/i;
// Fisheye / equirect / mkx projections — non-planar, naive crop would
// still look distorted. We DETECT them so the UI can disable the flatten
// affordance for these inputs (extension point for v2: WebGL shader).
const STEREO_NONPLANAR = /(?:^|[_\-. \/\\])(?:mkx\d+|rf52|fisheye\d+|vrca\d+|eac|eac360|fb360|360x180|mono360)(?=$|[_\-. \/\\])/i;

/**
 * Classify the stereo packing of a VR file by filename + path.
 *
 * Returns one of:
 *   - 'sbs-half'   — side-by-side, each eye horizontally compressed (most common)
 *   - 'sbs-full'   — side-by-side, each eye full-aspect (HereSphere `_LRF` etc.)
 *   - 'tb-half'    — top-bottom, each eye vertically compressed
 *   - 'tb-full'    — top-bottom full-aspect
 *   - 'nonplanar'  — fisheye / equirect / mkx — flatten is meaningless without 3D unproject
 *   - null         — couldn't determine; treat as mono or skip flatten
 *
 * Filename tokens (HereSphere/DeoVR convention) win over aspect-ratio
 * heuristics because the container's reported aspect is often wrong on
 * VR rips. Aspect-fallback intentionally NOT implemented in v1 — the
 * token approach is precise enough for the user's reported case and
 * a false aspect-heuristic guess (e.g. "this 32:9 movie is full-SBS")
 * would corrupt non-VR ultrawide content.
 *
 * @param {string | {name?: string, path?: string} | null | undefined} input
 * @returns {'sbs-half'|'sbs-full'|'tb-half'|'tb-full'|'nonplanar'|null}
 */
export function classifyStereoFormat(input) {
  if (!input) return null;
  const s = typeof input === 'string' ? input : (input.path || input.name || '');
  if (!s) return null;
  const stem = s.replace(/\.[^./\\]+$/, '');
  // Check for projection-bearing tokens first — these often co-exist
  // with stereo tokens (e.g. `_mkx200_sbs`); the projection is the
  // load-bearing fact (no flatten possible).
  if (STEREO_NONPLANAR.test(stem)) return 'nonplanar';
  // FULL takes priority over HALF (the F-suffix tokens are a superset).
  if (STEREO_SBS_FULL.test(stem)) return 'sbs-full';
  if (STEREO_TB_FULL.test(stem)) return 'tb-full';
  if (STEREO_SBS_HALF.test(stem)) return 'sbs-half';
  if (STEREO_TB_HALF.test(stem)) return 'tb-half';
  return null;
}

/**
 * Convenience: is this format flat-flattenable via simple crop+scale?
 * False for nonplanar (fisheye/equirect) and null (no detection).
 */
export function isFlattenableStereo(format) {
  return format === 'sbs-half' || format === 'sbs-full'
      || format === 'tb-half' || format === 'tb-full';
}

/**
 * @param {string | {name?: string, path?: string} | null | undefined} input
 * @returns {boolean}
 */
export function isVRVideo(input) {
  if (!input) return false;
  // Per-video override (set via the kebab menu) wins over the heuristic
   // in both directions — `'vr'` flips a heuristic-flat file to VR,
   // `'flat'` clears a heuristic-VR false positive. Only consulted when
   // the caller passed an object with a `path`; raw-string callers
   // (filename-only checks in tests / web-remote display code) skip the
   // lookup and hit the heuristic directly.
  if (input && typeof input === 'object' && input.path) {
    const override = _overrideGetter(input.path);
    if (override === 'vr') return true;
    if (override === 'flat') return false;
  }
  const s = typeof input === 'string'
    ? input
    : (input.path || input.name || '');
  return _check(s);
}
