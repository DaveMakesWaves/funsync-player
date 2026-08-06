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
 * Unavailable videos (external drive unplugged) are skipped at every step —
 * Continue must never land on something that can't play. They keep their
 * index, so `index` still refers to a position in the FULL list and a
 * reconnected drive restores the natural target without renumbering.
 *
 * @param {string[]} videoPaths playlist order
 * @param {string|null} markerPath last-watched path, if any
 * @param {(path: string) => object|null} entryOf resume entry lookup
 * @param {(path: string) => boolean} [isAvailable] defaults to all-available
 * @returns {{path: string, index: number, resume: boolean}|null}
 */
export function pickContinueTarget(videoPaths, markerPath, entryOf, isAvailable) {
  const list = Array.isArray(videoPaths) ? videoPaths : [];
  if (list.length === 0) return null;
  const lookup = typeof entryOf === 'function' ? entryOf : () => null;
  const canPlay = typeof isAvailable === 'function' ? isAvailable : () => true;

  // Nothing reachable — say so rather than returning a target that will fail
  // to open. The caller shows "reconnect the drive", not a broken player.
  if (!list.some((p) => canPlay(p))) return null;

  const markerIdx = markerPath ? list.indexOf(markerPath) : -1;

  // 1. Marked video that ISN'T finished → that's where you were, so play
  // it. Resume when it has a position, start it when it doesn't (a marker
  // can outlive its position: play past 10s, seek back under 10s, stop).
  // Only a FINISHED marked video gets skipped, which is the whole point of
  // the rule below.
  if (markerIdx >= 0 && canPlay(list[markerIdx]) && !isFinished(lookup(list[markerIdx]))) {
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
    if (!canPlay(list[idx])) continue;
    const entry = lookup(list[idx]);
    if (!isFinished(entry)) {
      return { path: list[idx], index: idx, resume: shouldOfferResume(entry) };
    }
  }

  // 4. Everything watched — advance rather than replay the marked video.
  // Still constrained to something that can actually play.
  const from = markerIdx >= 0 ? markerIdx + 1 : 0;
  for (let i = 0; i < list.length; i += 1) {
    const idx = (from + i) % list.length;
    if (canPlay(list[idx])) return { path: list[idx], index: idx, resume: false };
  }
  return null;
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
 * Unavailable videos (drive unplugged) still count toward `total` and toward
 * `watched` if they were finished — dropping them would make the tile's counts
 * lurch every time a drive spins down, and the videos genuinely are still in
 * the playlist. What they must NOT do is inflate `remainingSeconds`: time you
 * cannot currently watch isn't time left. They are reported separately as
 * `unavailable` so the UI can explain the discrepancy rather than leave the
 * user to notice the numbers don't add up.
 *
 * @param {string[]} videoPaths
 * @param {(path: string) => object|null} entryOf
 * @param {(path: string) => number} durationOf seconds; 0 when unknown
 * @param {(path: string) => boolean} [isAvailable] defaults to all-available
 */
export function summarisePlaylistProgress(videoPaths, entryOf, durationOf, isAvailable) {
  const list = Array.isArray(videoPaths) ? videoPaths : [];
  const lookup = typeof entryOf === 'function' ? entryOf : () => null;
  const durations = typeof durationOf === 'function' ? durationOf : () => 0;
  const canPlay = typeof isAvailable === 'function' ? isAvailable : () => true;

  let watched = 0;
  let inProgress = 0;
  let remainingSeconds = 0;
  let unavailable = 0;

  for (const path of list) {
    const entry = lookup(path);
    const reachable = canPlay(path);
    if (!reachable) unavailable += 1;
    if (isFinished(entry)) {
      watched += 1;
      continue;
    }
    // Counted in `total` and `unavailable`, but contributes no remaining
    // time and is not "in progress" — you can't progress it right now.
    if (!reachable) continue;

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

  return { watched, inProgress, total: list.length, remainingSeconds, unavailable };
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
export function partitionByWatched(videoPaths, entryOf, pathOf = (v) => v, isAvailable) {
  const list = Array.isArray(videoPaths) ? videoPaths : [];
  const lookup = typeof entryOf === 'function' ? entryOf : () => null;
  const key = typeof pathOf === 'function' ? pathOf : (v) => v;
  const canPlay = typeof isAvailable === 'function' ? isAvailable : () => true;
  const unwatched = [];
  const watched = [];
  for (const item of list) {
    // Unavailable items are DROPPED here, not moved to the back. Unlike a
    // watched video — which must still play in a marathon once the unwatched
    // bag empties — an unreachable file can never play, and leaving it in the
    // bag would surface as a dead entry mid-queue.
    if (!canPlay(key(item))) continue;
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
