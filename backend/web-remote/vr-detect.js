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

/**
 * @param {string | {name?: string, path?: string} | null | undefined} input
 * @returns {boolean}
 */
export function isVRVideo(input) {
  if (!input) return false;
  const s = typeof input === 'string'
    ? input
    : (input.path || input.name || '');
  return _check(s);
}
