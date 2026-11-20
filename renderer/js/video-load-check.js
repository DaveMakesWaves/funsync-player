// Helpers for the inline player's load-outcome checks (app.js
// `_onVideoError`, `_checkVideoTrackDecodes`). Pure functions, so the
// decisions can be tested without the whole app.
//
// App test 2026-11-02, forum #368:
//   V08 — a decode failure left nothing in the log; the codec only ever
//         reached a toast. `describeVideoCodec` is the one string both use.
//   V09 — an HEVC 4:4:4 track played as audio over black: Chromium dropped
//         the video track without raising a MediaError. The app now notices
//         a track that never decodes, and these helpers keep it from
//         mistaking a music file (no video, or only cover art) for one.

// Containers that are audio by nature. A video track is not expected, so a
// zero-width picture is normal and not worth even a metadata probe.
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'wma']);

// ffprobe reports embedded cover art (an "attached picture") as a VIDEO
// stream with an image codec. Chromium ignores it and plays the audio, which
// is correct, so a file whose only "video" is an image is treated as audio.
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp', 'tiff', 'jpeg2000', 'jpegls']);

/** Seconds of actual playback after which a track with no frames is broken. */
export const NO_FRAMES_GRACE_SEC = 2;

/**
 * "HEVC Rext yuv444p" from the backend's ffprobe metadata, or '' when there
 * is nothing to name (no metadata, no video stream, ffprobe unavailable).
 *
 * @param {object|null|undefined} meta  /metadata response
 * @returns {string}
 */
export function describeVideoCodec(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (meta.codec && meta.codec !== 'unknown') parts.push(String(meta.codec).toUpperCase());
  if (meta.profile) parts.push(String(meta.profile));
  if (meta.pixFmt) parts.push(String(meta.pixFmt));
  return parts.join(' ').trim();
}

/**
 * Does the probed file carry a real video stream, as opposed to none at all
 * or only cover art? `false` for missing metadata too: "unknown" must never
 * turn into a claim that the user's video is broken.
 *
 * @param {object|null|undefined} meta  /metadata response
 * @returns {boolean}
 */
export function hasRealVideoStream(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const codec = String(meta.codec || '').toLowerCase();
  if (!codec || codec === 'unknown') return false;
  return !IMAGE_CODECS.has(codec);
}

/**
 * @param {string|null|undefined} path
 * @returns {boolean} true for an audio container (by extension)
 */
export function isAudioPath(path) {
  if (typeof path !== 'string') return false;
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return !!m && AUDIO_EXTENSIONS.has(m[1].toLowerCase());
}

/**
 * Seconds this element has actually PLAYED since its current source loaded,
 * from `video.played`. Seeking and sitting paused add nothing, and a resume
 * seek to 10:00 does not count as ten minutes of playback, which is why
 * `currentTime` cannot be used for this.
 *
 * @param {{played?: {length: number, start: Function, end: Function}}} video
 * @returns {number}
 */
export function playedSeconds(video) {
  const ranges = video?.played;
  if (!ranges || typeof ranges.length !== 'number') return 0;
  let total = 0;
  for (let i = 0; i < ranges.length; i++) {
    const span = Number(ranges.end(i)) - Number(ranges.start(i));
    if (Number.isFinite(span) && span > 0) total += span;
  }
  return total;
}
