// Playlist-level progress — pure helpers over a playlist's paths and the
// resume/watched entries stored against them.
//
// DOM- and settings-free so the rules that are easy to get subtly wrong
// (which video Continue should land on, what "remaining" counts) are
// directly testable. playlists.js and app.js own the wiring.
//
// Community request follow-on, 2026-08-05.

import { isFinished, shouldOfferResume } from './resume-position.js';

/**
 * Where should "Continue" go?
 *
 * The interesting case is a marker sitting on a video that was watched to
 * the end. Playing that again from the start is what the naive "play the
 * last-watched video" rule does, and it's wrong — finishing something is
 * the clearest possible signal you're done with it. So:
 *
 *   1. Marked video not finished                → play it (resuming if it
 *                                                 has a position).
 *   2. Marked video is finished                 → first unwatched AFTER it,
 *                                                 wrapping to the start.
 *   3. No marker                                → first unwatched anywhere.
 *   4. Everything watched                       → the item after the marker
 *                                                 (wrapping), so Continue
 *                                                 still advances instead of
 *                                                 replaying the same video.
 *
 * @param {string[]} videoPaths playlist order
 * @param {string|null} markerPath last-watched path, if any
 * @param {(path: string) => object|null} entryOf resume entry lookup
 * @returns {{path: string, index: number, resume: boolean}|null}
 */
export function pickContinueTarget(videoPaths, markerPath, entryOf) {
  const list = Array.isArray(videoPaths) ? videoPaths : [];
  if (list.length === 0) return null;
  const lookup = typeof entryOf === 'function' ? entryOf : () => null;

  const markerIdx = markerPath ? list.indexOf(markerPath) : -1;

  // 1. Marked video that ISN'T finished → that's where you were, so play
  // it. Resume when it has a position, start it when it doesn't (a marker
  // can outlive its position: play past 10s, seek back under 10s, stop).
  // Only a FINISHED marked video gets skipped, which is the whole point of
  // the rule below.
  if (markerIdx >= 0 && !isFinished(lookup(list[markerIdx]))) {
    return {
      path: list[markerIdx],
      index: markerIdx,
      resume: shouldOfferResume(lookup(list[markerIdx])),
    };
  }

  // 2 & 3. First unwatched, searching forward from just after the marker
  // (or from the start when there is none) and wrapping once.
  const start = markerIdx >= 0 ? markerIdx + 1 : 0;
  for (let i = 0; i < list.length; i += 1) {
    const idx = (start + i) % list.length;
    const entry = lookup(list[idx]);
    if (!isFinished(entry)) {
      return { path: list[idx], index: idx, resume: shouldOfferResume(entry) };
    }
  }

  // 4. Everything watched — advance rather than replay the marked video.
  const idx = markerIdx >= 0 ? (markerIdx + 1) % list.length : 0;
  return { path: list[idx], index: idx, resume: false };
}

/**
 * Counts and time left for a playlist.
 *
 * "Remaining" counts whole unwatched videos plus the unplayed tail of any
 * part-watched one, so a playlist you're 10 minutes into a 1-hour video on
 * reports 50 minutes for it rather than the full hour. Videos with no known
 * duration contribute nothing to the time but still count toward the totals
 * — undercounting time is less misleading than silently dropping items.
 *
 * @param {string[]} videoPaths
 * @param {(path: string) => object|null} entryOf
 * @param {(path: string) => number} durationOf seconds; 0 when unknown
 */
export function summarisePlaylistProgress(videoPaths, entryOf, durationOf) {
  const list = Array.isArray(videoPaths) ? videoPaths : [];
  const lookup = typeof entryOf === 'function' ? entryOf : () => null;
  const durations = typeof durationOf === 'function' ? durationOf : () => 0;

  let watched = 0;
  let inProgress = 0;
  let remainingSeconds = 0;

  for (const path of list) {
    const entry = lookup(path);
    if (isFinished(entry)) {
      watched += 1;
      continue;
    }

    const known = Number(durations(path));
    const duration = Number.isFinite(known) && known > 0
      ? known
      : (Number.isFinite(entry?.duration) ? entry.duration : 0);

    if (shouldOfferResume(entry, duration)) {
      inProgress += 1;
      remainingSeconds += Math.max(0, duration - entry.position);
    } else {
      remainingSeconds += Math.max(0, duration);
    }
  }

  return { watched, inProgress, total: list.length, remainingSeconds };
}

/**
 * Split a list into unwatched-first order for shuffle. Both halves keep
 * their input order; the caller shuffles each independently so the bag
 * model and the balance-by-script draw still apply within a half.
 *
 * Partitioning rather than filtering matters: a marathon that has seen
 * everything must still play, so watched items go to the back instead of
 * being dropped.
 */
export function partitionByWatched(videoPaths, entryOf, pathOf = (v) => v) {
  const list = Array.isArray(videoPaths) ? videoPaths : [];
  const lookup = typeof entryOf === 'function' ? entryOf : () => null;
  const key = typeof pathOf === 'function' ? pathOf : (v) => v;
  const unwatched = [];
  const watched = [];
  for (const item of list) {
    (isFinished(lookup(key(item))) ? watched : unwatched).push(item);
  }
  return { unwatched, watched };
}

/**
 * `2h 15m`, `45m`, `< 1m`. Coarse on purpose — this is a glanceable
 * summary on a tile, not a countdown, and second-precision would imply
 * more accuracy than durations-from-metadata deserve.
 */
export function formatRemaining(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  if (total <= 0) return null;
  // Guard before the minute rounding below: 30s would round UP to "1m",
  // overstating what's left on an almost-finished playlist.
  if (total < 60) return '< 1m';
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  // Rounding minutes can tip to 60 — carry it rather than printing "1h 60m".
  if (m === 60) return `${h + 1}h`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return '< 1m';
}
