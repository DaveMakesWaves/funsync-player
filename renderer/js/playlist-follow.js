// Following playlists (zaikechi #381, 2026-11-23: "be able to sync a playlist
// with a library/Category/Folder instead of needing to manually add things to
// it"). A playlist can follow ONE rule, stored on it by main (store.js
// setPlaylistFollow):
//   { kind: 'category', categoryId }   every video in that category
//   { kind: 'source',   sourceId }     every video in that library folder
//   { kind: 'folder',   folderPath }   every video under that folder
//
// The members are WRITTEN into the playlist (its videoPaths), not worked out
// each time it is read, so everything that reads a playlist (play options,
// Continue, the cover, the phone, backups, an older build) sees an ordinary
// playlist. The rules for keeping it in step:
// - ADD: a video the rule matches and the playlist lacks goes on the end (in
//   name order), unless the user took it out by hand (`excludedPaths`).
// - REMOVE only on an explicit change: a video unassigned from the followed
//   category (planCategoryUnassign). A video that is merely ABSENT (a drive
//   offline, a file moved) is never removed: absence is never destructive
//   (notes: feedback_absence_is_never_destructive). It shows greyed, as in
//   any playlist.
// - The user's own edits win: a video removed by hand stays out
//   (excludedPaths, kept by data-service.js), one added by hand stays in,
//   the order is theirs (new members go on the end).
//
// Pure: no DOM, no IPC, nothing written here.

import { compareNames } from './library-search.js';

const fold = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Is `path` inside `folder` (or the folder itself)? Compared without case or slash style. */
export function isUnderFolder(path, folder) {
  const f = fold(folder);
  const p = fold(path);
  return !!f && (p === f || p.startsWith(`${f}\\`));
}

/** The folder a rule covers (a source's path, or the folder itself), or null. */
export function ruleFolder(follow, sources) {
  if (follow?.kind === 'folder') return follow.folderPath || null;
  if (follow?.kind === 'source') {
    const src = (Array.isArray(sources) ? sources : []).find((s) => s?.id === follow.sourceId);
    return src?.path || null;
  }
  return null;
}

/**
 * The library videos a rule matches, in name order (paths).
 * @param {object} follow the rule
 * @param {{ videos: object[], sources?: object[], getVideoCategories?: (path: string) => string[] }} ctx
 */
export function ruleMembers(follow, { videos, sources, getVideoCategories } = {}) {
  const list = (Array.isArray(videos) ? videos : []).filter((v) => v?.path && !v._stream);
  let hits = [];
  if (follow?.kind === 'category') {
    const cats = typeof getVideoCategories === 'function' ? getVideoCategories : () => [];
    hits = list.filter((v) => (cats(v.path) || []).includes(follow.categoryId));
  } else {
    const folder = ruleFolder(follow, sources);
    if (!folder) return [];
    hits = list.filter((v) => isUnderFolder(v.path, folder));
  }
  return hits.slice().sort((a, b) => compareNames(a.name || '', b.name || '')).map((v) => v.path);
}

/**
 * What a following playlist gains now: the rule's matches it lacks, minus
 * the ones taken out by hand. Returns null when there is nothing to do
 * (no rule, no scanned library, nothing new).
 */
export function planFollowAdds(playlist, ctx) {
  if (!playlist?.follow) return null;
  if (!Array.isArray(ctx?.videos) || ctx.videos.length === 0) return null; // not scanned: nothing is known
  const have = new Set(Array.isArray(playlist.videoPaths) ? playlist.videoPaths : []);
  const out = new Set(Array.isArray(playlist.excludedPaths) ? playlist.excludedPaths : []);
  const add = ruleMembers(playlist.follow, ctx).filter((p) => !have.has(p) && !out.has(p));
  return add.length ? { playlistId: playlist.id, add } : null;
}

/**
 * A video unassigned from a category: the playlists that follow that
 * category and hold it, which it now leaves (the rule says so; the user
 * did it). `[{ playlistId, remove: [path] }]`.
 */
export function planCategoryUnassign(playlists, categoryId, videoPath) {
  return (Array.isArray(playlists) ? playlists : [])
    .filter((pl) => pl?.follow?.kind === 'category' && pl.follow.categoryId === categoryId
      && Array.isArray(pl.videoPaths) && pl.videoPaths.includes(videoPath))
    .map((pl) => ({ playlistId: pl.id, remove: [videoPath] }));
}

/** A rule's name for people ("Category: Favourite scenes", "Folder: D:\\Clips"). */
export function describeRule(follow, { categories, sources } = {}) {
  if (!follow) return null;
  if (follow.kind === 'category') {
    const cat = (Array.isArray(categories) ? categories : []).find((c) => c?.id === follow.categoryId);
    return { kind: 'category', name: cat?.name || null };
  }
  if (follow.kind === 'source') {
    const src = (Array.isArray(sources) ? sources : []).find((s) => s?.id === follow.sourceId);
    return { kind: 'source', name: src?.name || src?.path || null };
  }
  return { kind: 'folder', name: follow.folderPath || null };
}
