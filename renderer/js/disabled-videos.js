// Disabled videos (zaikechi #381, 2026-11-23: "Would like to be able to
// 'Disable' a video in the menus, and during playback ... It keeps it visible
// in the library and playlist (maybe grayed out?) but will not auto play it or
// add it to any of the queues unless manually selected. If currently playing
// and user selects to disable them, it skips to the next video ... an option
// to review and manage these in a list. Maybe even options to outright delete").
//
// The rule, in one line: a disabled video is never CHOSEN BY FUNSYNC. It
// still shows (greyed, with a mark), and it plays when the user picks that
// very video (a card click, Play in its dialog, a row in the queue). Every
// automatic choice skips it: Play all / Shuffle all (library, category,
// playlist), Up Next and the end-of-video advance, N / P (they name no
// video), a shuffle's wrap, Continue, a bulk Add to queue, the phone's Play
// all / Shuffle / next.
//
// Stored as `library.disabledVideos: { [videoPath]: disabledAtMs }`
// (electron/store.js default {}): a per-video map like userTags, so a moved
// video takes it along (library.js _rehomeTagMaps) and a deleted one drops it
// (delete-plan.js PER_VIDEO_SETTING_KEYS). Written only here.

export const DISABLED_SETTING = 'library.disabledVideos';

function mapOf(settings) {
  const m = settings?.get?.(DISABLED_SETTING);
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

/** Is this video disabled? */
export function isDisabled(settings, videoPath) {
  if (typeof videoPath !== 'string' || !videoPath) return false;
  return Object.prototype.hasOwnProperty.call(mapOf(settings), videoPath);
}

/** The disabled paths, as a Set (one read per render or per list). */
export function disabledPaths(settings) {
  return new Set(Object.keys(mapOf(settings)));
}

/** How many videos are disabled. */
export function disabledCount(settings) {
  return Object.keys(mapOf(settings)).length;
}

/**
 * Disable a video or enable it again. Writes only when something changes.
 * Returns the new state.
 */
export function setDisabled(settings, videoPath, on, now = Date.now()) {
  if (typeof videoPath !== 'string' || !videoPath || !settings?.set) return false;
  const map = mapOf(settings);
  const has = Object.prototype.hasOwnProperty.call(map, videoPath);
  if (!!on === has) return has;
  const next = { ...map };
  if (on) next[videoPath] = now;
  else delete next[videoPath];
  settings.set(DISABLED_SETTING, next);
  return !!on;
}

/** Enable several at once (the review list's Enable all): one write. Returns how many changed. */
export function enableVideos(settings, paths) {
  const map = mapOf(settings);
  const next = { ...map };
  let changed = 0;
  for (const p of Array.isArray(paths) ? paths : []) {
    if (Object.prototype.hasOwnProperty.call(next, p)) { delete next[p]; changed++; }
  }
  if (changed) settings.set(DISABLED_SETTING, next);
  return changed;
}

/** The paths FunSync may choose by itself: the same order, the disabled ones left out. */
export function withoutDisabled(paths, settings) {
  const off = disabledPaths(settings);
  if (off.size === 0) return Array.isArray(paths) ? paths.slice() : [];
  return (Array.isArray(paths) ? paths : []).filter((p) => !off.has(typeof p === 'string' ? p : p?.path));
}

/**
 * The review list's rows: every disabled video, newest first, with what the
 * library knows of it (`null` video = not in the scanned library now: an
 * offline drive or a moved file; it stays listed and can still be enabled).
 */
export function disabledRows(settings, videos) {
  const byPath = new Map((Array.isArray(videos) ? videos : []).map((v) => [v.path, v]));
  return Object.entries(mapOf(settings))
    .map(([path, at]) => ({ path, at: Number(at) || 0, video: byPath.get(path) || null }))
    .sort((a, b) => b.at - a.at || a.path.localeCompare(b.path, 'en'));
}
