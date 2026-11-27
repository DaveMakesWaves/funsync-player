// Pure helpers for a streamed video (2026-11-23, the streaming UX pass).
//
// streamOffsetKey: the key a stream's own sync offset is kept under in
// `library.syncOffsets` (a stream has no file path; `_currentVideoPath` is
// null for it, and too much keys off that to give it one).
//
// streamCutWarning: is this copy the cut the script was made for? A script
// that runs past the stream's end, or a script whose own recorded length
// differs from the stream's, most likely belongs to another cut (an intro
// added or trimmed), which no clock can fix: the user needs to be told.

// Query parameters that never pick the video: tracking, timestamps, and the
// signatures / expiries of a direct link (they change on every visit).
const NOISE_PARAMS = new Set([
  'from', 'ref', 'ref_src', 'fbclid', 'gclid', 'si', 'feature', 't', 'start', 'time_continue',
  'sig', 'signature', 'expires', 'exp', 'token', 'auth', 'key-pair-id', 'policy', 'hdnts',
  'v-acctoken', 'download', 'download_filename', 'rnd', 'br', 'rand',
]);

/**
 * "stream:<host><path>[?<params>]": "www." dropped, a trailing slash
 * dropped, EroSync's /embed/<id> and /videos/<id> one video, the fragment
 * dropped, and of the query only what picks the video, sorted (2026-11-23:
 * the query was dropped whole, so every youtube.com/watch?v=… and every
 * pornhub.com/view_video.php?viewkey=… was one key). Null for anything that
 * is not http(s).
 */
export function streamOffsetKey(pageUrl) {
  let u;
  try { u = new URL(String(pageUrl || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.replace(/\/+$/, '') || '/';
  if (host === 'erosync.net') path = path.replace(/^\/embed\//, '/videos/');
  const keep = [...u.searchParams.entries()]
    .filter(([k]) => { const n = k.toLowerCase(); return !NOISE_PARAMS.has(n) && !n.startsWith('utm_') && !n.startsWith('x-amz-'); })
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const query = keep.length ? `?${new URLSearchParams(keep).toString()}` : '';
  return `stream:${host}${path}${query}`;
}

/**
 * A funscript's recorded length in seconds, or null. OFS writes seconds;
 * a value too large for seconds (over 10 hours) is taken as milliseconds.
 */
export function metaDurationSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 36_000 ? n / 1000 : n;
}

/**
 * {kind: 'pastEnd', scriptS, videoS} when the script's last action is more
 * than a second past the stream's end; {kind: 'length', diffS} (stream minus
 * script, seconds) when the script records a length more than 3 s from the
 * stream's; else null. Unknown lengths give null.
 */
export function streamCutWarning({ scriptEndMs, metaDurationS, videoDurationS }) {
  const video = Number(videoDurationS);
  if (!Number.isFinite(video) || video <= 0) return null;
  const end = Number(scriptEndMs) / 1000;
  if (Number.isFinite(end) && end > video + 1) return { kind: 'pastEnd', scriptS: end, videoS: video };
  const meta = metaDurationSeconds(metaDurationS);
  if (meta && Math.abs(video - meta) > 3) return { kind: 'length', diffS: video - meta };
  return null;
}

/** 74 → "1:14", 3725 → "1:02:05". */
export function clockText(seconds) {
  const s = Math.max(0, Math.round(Math.abs(Number(seconds) || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
