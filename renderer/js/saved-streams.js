// Saved streams: a page link and its script kept in the library like a video
// (Dave, 2026-11-23; notes/features/SCOPE-saved-streams.md). Pure helpers over
// `library.streams` (config.json, an array) and the library's video objects.
//
// A saved stream's path is its key, `stream:<host><path>` (stream-session.js
// streamOffsetKey: the per-video sync offset already uses it), so everything
// keyed by a video's path (playlists, categories, tags, resume, watched, the
// offset) works for it unchanged. Its stream ADDRESS is never kept: it
// expires, and every play looks the page up again.

import { streamOffsetKey } from './stream-session.js';

export const SETTING_STREAMS = 'library.streams';
/** The Load URL / Watch tick (on unless the user turned it off). */
export const SETTING_SAVE_STREAMS = 'player.saveStreams';

/** Is this a saved stream's path? */
export function isStreamPath(path) {
  return typeof path === 'string' && path.startsWith('stream:');
}

/**
 * A record from what Load URL / Watch know, or null without a usable page.
 * @param {{pageUrl, title?, site?, duration?, scriptPath?, axes?, topicId?, now?}} o
 */
export function streamEntryFrom({ pageUrl, title = '', site = '', duration = null, scriptPath = null, axes = null, topicId = null, now = Date.now() }) {
  const key = streamOffsetKey(pageUrl);
  if (!key) return null;
  const cleanAxes = axes && typeof axes === 'object'
    ? Object.fromEntries(Object.entries(axes).filter(([s, p]) => typeof s === 'string' && typeof p === 'string' && p))
    : null;
  return {
    key,
    pageUrl: String(pageUrl),
    title: String(title || '').trim() || key.slice('stream:'.length),
    site: String(site || ''),
    duration: Number(duration) > 0 ? Number(duration) : null,
    scriptPath: typeof scriptPath === 'string' && scriptPath ? scriptPath : null,
    axes: cleanAxes && Object.keys(cleanAxes).length ? cleanAxes : null,
    topicId: Number.isInteger(topicId) ? topicId : null,
    addedAt: now,
  };
}

/** The list with `entry` in it: a stream already saved is updated in place (its added time kept). */
export function upsertStream(list, entry) {
  const arr = Array.isArray(list) ? list.filter((e) => e && typeof e.key === 'string') : [];
  if (!entry?.key) return arr;
  const i = arr.findIndex((e) => e.key === entry.key);
  if (i < 0) return [...arr, entry];
  const old = arr[i];
  const merged = {
    ...old,
    ...entry,
    addedAt: old.addedAt ?? entry.addedAt,
    // A re-save without a script keeps the one it had.
    scriptPath: entry.scriptPath ?? old.scriptPath ?? null,
    axes: entry.axes ?? old.axes ?? null,
    duration: entry.duration ?? old.duration ?? null,
  };
  return arr.map((e, j) => (j === i ? merged : e));
}

/** The list without `key`. */
export function removeStream(list, key) {
  return (Array.isArray(list) ? list : []).filter((e) => e?.key !== key);
}

/**
 * A saved stream as a library video: `path` is its key, `_stream` marks it
 * (the card's link icon, the Streams chip, no file actions), its script is a
 * real file.
 */
export function streamToVideo(entry) {
  if (!entry?.key) return null;
  return {
    path: entry.key,
    name: entry.title,
    _stream: true,
    pageUrl: entry.pageUrl,
    site: entry.site || '',
    duration: entry.duration || null,
    hasFunscript: !!entry.scriptPath,
    funscriptPath: entry.scriptPath || null,
    _multiAxis: entry.axes ? { axes: { ...entry.axes } } : null,
    size: 0,
    mtime: entry.addedAt || 0,
    addedAt: entry.addedAt || 0,
  };
}

/** Every saved stream as library videos, in the order saved. */
export function streamVideos(list) {
  return (Array.isArray(list) ? list : []).map(streamToVideo).filter(Boolean);
}
