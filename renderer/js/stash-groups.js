// Stash Groups as read-only playlists (Stash "next" lot, appendix (j) row 6;
// Dave's answer 2026-11-19: "Kept in sync"). UNCOMMITTED working-tree code.
//
// stashGroupPlaylists(data, {enabled, videos}) -> the "Stash: <group>"
// playlists the Playlists view shows, DERIVED from main's projection
// (stash-store.js stashData(): `groups: {[groupId]: {name, sceneIds,
// updatedAt}}` and each scene's `groups: [{groupId, sceneIndex}]`, stage
// sn-main's contract) every time they are asked for. Nothing here is stored:
// they never enter the user's playlists, config.json or a backup, so turning
// Stash off or Remove Stash data hides them and deletes nothing the user made.
// Main keeps a group until a COMPLETE sync shows it gone; this only reads.
//
// Rules:
// - Stash on (`enabled === true`), else none. A projection without `groups`
//   (an older library.json) is unknown: no group playlists, nothing else.
// - Stash's order: by each member's `sceneIndex` for that group when every
//   member has one (Stash answers Group.scenes in id order; scene_index is
//   the group's order), else the group's `sceneIds` order as main gave it.
// - A member plays through the library video LINKED to it: a link whose data
//   counts (state ok / gone, the size check stash-tags.js uses), of the
//   data's own server, and, once the library has been scanned, a video the
//   library holds. One video per scene (an `ok` link first, then path order).
//   A scene with no such video is listed as missing (`path: null`): never a
//   guessed file.
// - A group shows only when at least one of its scenes has such a video
//   ("each Stash Group the user's linked videos belong to").
// - Ids stay opaque strings (stash-keys.js): sent back as given, never parsed.
//
// Pure: no DOM, no IPC, nothing written, no module state.

import { compareNames } from './library-search.js';

/** The id a group's playlist goes by in the Playlists view and in play contexts. */
export const STASH_GROUP_PLAYLIST_PREFIX = 'stash-group:';

const MAX_NAME = 500;
const EMPTY = Object.freeze([]);
const TRUSTED_STATES = Object.freeze(['ok', 'gone']);

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function own(map, key) {
  return isPlainObject(map) && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value !== '' ? value : null;
}

function text(value, max = MAX_NAME) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function serverKey(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '').toLowerCase() : '';
}

/** A record of another server than the data's own (a side with none recorded is the data's). */
function otherServer(recordServer, dataServer) {
  const a = serverKey(recordServer);
  const b = serverKey(dataServer);
  return !!(a && b && a !== b);
}

/** `stash-group:<groupId>`, or null for something that is not a group id. */
export function stashGroupPlaylistId(groupId) {
  const id = idOf(groupId);
  return id ? `${STASH_GROUP_PLAYLIST_PREFIX}${id}` : null;
}

/** Is `id` a Stash group playlist's id (never one of the user's playlists)? */
export function isStashGroupPlaylistId(id) {
  return typeof id === 'string' && id.startsWith(STASH_GROUP_PLAYLIST_PREFIX)
    && id.length > STASH_GROUP_PLAYLIST_PREFIX.length;
}

/** The scanned size of each library video, or null when the library has listed none yet. */
function librarySizes(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return null;
  const sizes = new Map();
  for (const v of videos) {
    const p = v?.path;
    if (typeof p !== 'string' || !p || sizes.has(p)) continue;
    sizes.set(p, finite(v.size));
  }
  return sizes;
}

/**
 * sceneId -> the one library path that plays it. Links of another server,
 * links whose data does not count, and (once the library is known) paths
 * the library does not hold are left out.
 */
function linkedPaths(data, sizes) {
  const dataServer = data.server?.url;
  const best = new Map(); // sceneId -> {path, ok}
  for (const [path, link] of Object.entries(isPlainObject(data.links) ? data.links : {})) {
    if (!path || !isPlainObject(link) || !TRUSTED_STATES.includes(link.state)) continue;
    if (otherServer(link.server, dataServer)) continue;
    const sceneId = idOf(link.sceneId);
    if (!sceneId) continue;
    if (sizes && !sizes.has(path)) continue;
    const scanned = sizes ? sizes.get(path) : null;
    const linked = finite(link.fp?.size);
    if (scanned != null && linked != null && scanned !== linked) continue;
    const ok = link.state === 'ok';
    const have = best.get(sceneId);
    if (!have || (ok && !have.ok) || (ok === have.ok && path < have.path)) best.set(sceneId, { path, ok });
  }
  return best;
}

/** The scene's place in group `groupId` (its `sceneIndex`), or null. */
function sceneIndexIn(data, sceneId, groupId) {
  const scene = own(data.scenes, sceneId);
  if (!isPlainObject(scene) || !Array.isArray(scene.groups)) return null;
  for (const g of scene.groups) {
    if (isPlainObject(g) && idOf(g.groupId) === groupId) return finite(g.sceneIndex);
  }
  return null;
}

/** The group's scene ids in Stash's order (see the header). */
function orderedSceneIds(data, groupId, group) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(group.sceneIds) ? group.sceneIds : []) {
    const id = idOf(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const indexed = ids.map((id, at) => ({ id, at, index: sceneIndexIn(data, id, groupId) }));
  if (indexed.length > 1 && indexed.every((x) => x.index !== null)) {
    indexed.sort((a, b) => (a.index - b.index) || (a.at - b.at));
  }
  return indexed.map((x) => x.id);
}

/**
 * @param {object} data stash-store.js stashData()
 * @param {{enabled?: boolean, videos?: Array<{path: string, size?: number}>|null}} [options]
 *   `videos`: the library's scanned videos (none yet: links are taken as they are)
 * @returns {ReadonlyArray<{id: string, groupId: string, name: string, updatedAt: string|null,
 *   entries: ReadonlyArray<{sceneId: string, path: string|null, title: string}>,
 *   videoPaths: ReadonlyArray<string>, missing: number, readOnly: true}>}
 *   sorted by name; frozen; empty when off or when there are none
 */
export function stashGroupPlaylists(data, { enabled, videos } = {}) {
  if (enabled !== true || !isPlainObject(data) || !isPlainObject(data.groups)) return EMPTY;
  const sizes = librarySizes(videos);
  const paths = linkedPaths(data, sizes);
  const dataServer = data.server?.url;
  const out = [];
  for (const [rawId, group] of Object.entries(data.groups)) {
    const groupId = idOf(rawId);
    if (!groupId || !isPlainObject(group)) continue;
    if (otherServer(group.server, dataServer)) continue;
    const entries = [];
    const videoPaths = [];
    // A path links one scene, so no path can come twice.
    for (const sceneId of orderedSceneIds(data, groupId, group)) {
      const path = paths.get(sceneId)?.path ?? null;
      if (path) videoPaths.push(path);
      entries.push(Object.freeze({ sceneId, path, title: text(own(data.scenes, sceneId)?.title) }));
    }
    if (videoPaths.length === 0) continue;
    out.push(Object.freeze({
      id: stashGroupPlaylistId(groupId),
      groupId,
      name: text(group.name),
      updatedAt: typeof group.updatedAt === 'string' ? group.updatedAt : null,
      entries: Object.freeze(entries),
      videoPaths: Object.freeze(videoPaths),
      missing: entries.length - videoPaths.length,
      readOnly: true,
    }));
  }
  out.sort((a, b) => compareNames(a.name, b.name) || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
  return Object.freeze(out);
}

/** One group's playlist by its playlist id (`stash-group:<groupId>`), or null. */
export function stashGroupPlaylist(data, playlistId, options) {
  if (!isStashGroupPlaylistId(playlistId)) return null;
  return stashGroupPlaylists(data, options).find((pl) => pl.id === playlistId) || null;
}
