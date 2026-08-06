// Resume position — pure helpers for "continue where you left off".
//
// Kept free of DOM and settings access so the threshold rules (the part
// that decides whether a resume feels helpful or annoying) are directly
// testable. app.js owns persistence; playlists.js / library.js own display.
//
// Community request, EroScripts 2026-08-05.

/**
 * Below this, a position is a glance rather than a watch. Without it,
 * opening a video for three seconds leaves a resume marker and earns a
 * modal next time.
 */
export const MIN_RECORD_SECONDS = 10;

/**
 * Trailing zone treated as "finished". Whichever is LARGER of these two
 * wins, so a 2-minute clip isn't declared finished with 30s to go, and a
 * 3-hour film isn't asked to reach 99.7%.
 */
export const END_TAIL_SECONDS = 30;
export const END_TAIL_FRACTION = 0.05;

/**
 * Minimum gap between persisted writes.
 *
 * This is the app's only CONTINUOUS background writer, and each write goes
 * renderer → IPC → electron-conf, which serialises and atomically rewrites
 * the WHOLE config file — associations, thumbnails, VR overrides and all.
 * On a large library that file is not small, so the interval is the main
 * lever on how much disk churn playback causes.
 *
 * 15s rather than something tighter because every way a session normally
 * ends (pause, video change, natural end, window close) forces a write
 * anyway. Only a crash or a kill loses anything, and it loses at most this.
 */
export const RESUME_WRITE_INTERVAL_MS = 15000;

/**
 * Don't rewrite the store for a position that has barely moved. Guards the
 * paused-but-ticking and seek-scrub cases, where the throttle above would
 * otherwise still let a stream of near-identical writes through.
 */
export const RESUME_MIN_DELTA_SECONDS = 3;

/**
 * The time past which a video counts as finished. Positions at or beyond
 * this are not recorded, and any existing entry is cleared — otherwise
 * every completed video resumes at its own credits.
 *
 * @param {number} duration
 * @returns {number} seconds; 0 when the duration isn't usable yet
 */
export function endThreshold(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const tail = Math.max(END_TAIL_SECONDS, duration * END_TAIL_FRACTION);
  // Floor at the halfway mark. Without it, any video shorter than the tail
  // (a 20s loop, say) gets a threshold of 0 and is therefore "finished" at
  // position 0 — so a playlist of short clips would show every one of them
  // watched the moment it loaded.
  return Math.max(duration - tail, duration * 0.5);
}

/**
 * Is this position worth persisting?
 *
 * @param {number} position current playback time, seconds
 * @param {number} duration total length, seconds
 */
export function shouldRecordPosition(position, duration) {
  if (!Number.isFinite(position) || !Number.isFinite(duration)) return false;
  if (duration <= 0) return false;
  if (position < MIN_RECORD_SECONDS) return false;
  // A duration shorter than the minimum can never produce a valid
  // position — short loops shouldn't accumulate entries at all.
  if (duration <= MIN_RECORD_SECONDS) return false;
  return position < endThreshold(duration);
}

/**
 * Should we offer to resume this entry?
 *
 * Re-validates rather than trusting what was stored: the file may have
 * been replaced since (same path, different length), in which case a
 * stale position could land past the end of the new video.
 *
 * @param {{position: number, duration?: number}|null|undefined} entry
 * @param {number} [duration] current known duration; falls back to the
 *   duration recorded alongside the entry
 */
export function shouldOfferResume(entry, duration) {
  if (!entry || !Number.isFinite(entry.position)) return false;
  const dur = Number.isFinite(duration) && duration > 0
    ? duration
    : entry.duration;
  if (!Number.isFinite(dur) || dur <= 0) return false;
  return shouldRecordPosition(entry.position, dur);
}

/**
 * Progress through the video, 0..1, for the card progress bar. Returns 0
 * when there's nothing meaningful to draw so callers can skip rendering.
 */
export function resumeProgressFraction(entry, duration) {
  if (!entry || !Number.isFinite(entry.position)) return 0;
  const dur = Number.isFinite(duration) && duration > 0
    ? duration
    : entry.duration;
  if (!Number.isFinite(dur) || dur <= 0) return 0;
  const frac = entry.position / dur;
  if (!Number.isFinite(frac) || frac <= 0) return 0;
  return Math.min(1, frac);
}

/**
 * `12:34`, or `1:02:03` once past an hour. Hours are only shown when
 * present so short clips don't read `0:12:34`.
 */
export function formatResumeTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Build the stored entry. `updatedAt` doubles as the "last played" stamp,
 * which finally gives `library-search.js`'s long-dead `lastPlayed` sort
 * something real to read.
 *
 * @param {number} position
 * @param {number} duration
 * @param {number} now epoch ms — passed in rather than read from Date so
 *   callers and tests stay deterministic
 *
 * Deliberately carries NO watched mark. Recording a position means the
 * video is in progress, which is the opposite of finished — see
 * `isFinished` for why the two are mutually exclusive.
 */
export function makeResumeEntry(position, duration, now) {
  return {
    position: Math.max(0, Math.round(position * 10) / 10),
    duration: Math.round(duration * 10) / 10,
    updatedAt: now,
  };
}

/**
 * Entry for a video watched to the end. Deliberately carries NO position:
 * a finished video must not resume, and every position-shaped predicate
 * (`shouldOfferResume`, `resumeProgressFraction`) already returns false or
 * 0 without one, so the watched state needs no special-casing there.
 *
 * The duration is kept so playlist totals can still count it.
 */
export function makeFinishedEntry(duration, now) {
  return {
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : 0,
    updatedAt: now,
    finished: true,
  };
}

/**
 * Has this video been watched to the end, with nothing in progress since?
 *
 * "Watched" and "in progress" are MUTUALLY EXCLUSIVE. Starting a real
 * rewatch (getting past the 10s minimum) clears the watched mark, because
 * a video you are 20 minutes into is not one you are done with.
 *
 * An earlier version kept the mark sticky so both facts could be stored.
 * That read well in the abstract and was wrong in use: every consumer here
 * tests `isFinished` first, so a part-rewatched video showed a watched tick
 * instead of its progress bar, counted as watched in the playlist summary,
 * got sent to the back by unwatched-first shuffle, and — worst — was
 * SKIPPED by Continue while the user was actively part-way through it.
 *
 * A glance under the 10s minimum does NOT un-watch: peeking at something
 * you have seen shouldn't undo having seen it.
 */
export function isFinished(entry) {
  return !!entry?.finished;
}
