// Stash's numbers for the library: rating, organised, plays, last played,
// O-count and the picture fingerprint (phash) of the scene a video is
// LINKED to (Stash "next" lot, stage sn-library, 2026-11-19;
// notes/features/DESIGN-stash-s1.md appendix (j) rows #2, #3, #10; the
// shared data contract in the lot's RULES-S1-NEXT.txt).
//
// What reads it:
// - library-search.js sortVideos: "Stash rating" and "Stash last played"
//   (stashFieldsIndex: path -> fields, one pass over the library);
// - library.js's Filters picker: "Rated N stars or more" and "Organised in
//   Stash" (applyStashFilter);
// - the video options dialog's File > Stash block: plays, last played and
//   O-count (stashActivity);
// - the duplicate finder's "Looks the same (Stash)" tier (the phash).
//
// The data is the renderer's copy of main's projection (stash-store.js
// stashData()), already synced: nothing here asks Stash anything. A video
// has fields only when
// - Stash is on (`enabled === true`);
// - its link's data counts: state `ok` or `gone` (a scene gone from Stash
//   keeps its data, as its tags do) and the trust check, the link's
//   fingerprint size against the size FunSync saw (unknown on either side
//   is trusted), exactly stash-tags.js's rule, so a swapped file shows none
//   of the old file's Stash numbers;
// - the scene is the link's own server's (main's opaque ids make that so;
//   a scene that names another server than the link's gives nothing, as in
//   stash-markers.js).
// Every new field is optional: an older library.json lacks it, and a field
// that is missing or malformed is `null` (unknown), never 0 plays or "not
// organised".
//
// Pure: no DOM, no IPC, nothing written, no module state.

import { TRUSTED_STATES } from './stash-tags.js';

/** Stash's five-star view: rating100 per star (100 = 5 stars). */
export const STASH_STAR = 20;
export const STASH_MAX_STARS = 5;

const PHASH = /^[0-9a-f]{16}$/i;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function own(map, key) {
  if (!isPlainObject(map) || typeof key !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value ? value : null;
}

function sameServer(a, b) {
  const canon = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return canon(a) === canon(b);
}

/** Does this link's data count for a file of `size` (null: unknown)? */
function trusted(link, size) {
  if (!isPlainObject(link) || !TRUSTED_STATES.includes(link.state)) return false;
  const linked = finite(link.fp?.size);
  return size == null || linked == null || linked === size;
}

/**
 * One scene's fields as the library reads them (all `null` when unknown).
 *
 * @param {object} scene a scene of main's projection
 * @param {string} sceneId
 * @returns {{sceneId: string, rating100: number|null, organized: boolean|null,
 *   playCount: number|null, lastPlayedAt: string|null, lastPlayedMs: number|null,
 *   oCounter: number|null, phash: string|null}}
 */
export function sceneFields(scene, sceneId) {
  const rating = finite(scene?.rating100);
  const lastMs = typeof scene?.lastPlayedAt === 'string' ? Date.parse(scene.lastPlayedAt) : NaN;
  const phash = typeof scene?.phash === 'string' && PHASH.test(scene.phash) ? scene.phash.toLowerCase() : null;
  return Object.freeze({
    sceneId,
    rating100: rating != null && rating >= 0 && rating <= 100 ? rating : null,
    organized: typeof scene?.organized === 'boolean' ? scene.organized : null,
    playCount: count(scene?.playCount),
    lastPlayedAt: Number.isFinite(lastMs) ? scene.lastPlayedAt : null,
    lastPlayedMs: Number.isFinite(lastMs) ? lastMs : null,
    oCounter: count(scene?.oCounter),
    phash,
  });
}

/**
 * The fields of the scene `path` is linked to, or null (Stash off, no link,
 * a link whose data does not count, no such scene, another server's scene).
 *
 * @param {object} data stash-store.js stashData()
 * @param {string} path the video's path
 * @param {{size?: number|null, enabled?: boolean}} [options] `size` the size FunSync saw
 * @returns {ReturnType<typeof sceneFields>|null}
 */
export function stashSceneFields(data, path, { size, enabled } = {}) {
  if (enabled !== true || !isPlainObject(data) || typeof path !== 'string' || !path) return null;
  const link = own(data.links, path);
  if (!trusted(link, finite(size))) return null;
  const sceneId = idOf(link.sceneId);
  const scene = sceneId ? own(data.scenes, sceneId) : undefined;
  if (!isPlainObject(scene)) return null;
  const sceneServer = typeof scene.server === 'string' && scene.server ? scene.server : null;
  if (sceneServer && typeof link.server === 'string' && link.server && !sameServer(sceneServer, link.server)) return null;
  return sceneFields(scene, sceneId);
}

/**
 * path -> fields for every library video that has them (one pass; the
 * library's sorts and filters read it). Empty while Stash is off.
 *
 * @param {object} data stash-store.js stashData()
 * @param {Array<{path: string, size?: number}>} videos the library's videos
 * @param {{enabled?: boolean}} [options]
 * @returns {Map<string, ReturnType<typeof sceneFields>>}
 */
export function stashFieldsIndex(data, videos, { enabled } = {}) {
  const index = new Map();
  if (enabled !== true || !isPlainObject(data) || !isPlainObject(data.links) || !Array.isArray(videos)) return index;
  for (const v of videos) {
    const path = v?.path;
    if (typeof path !== 'string' || !path || index.has(path)) continue;
    const fields = stashSceneFields(data, path, { size: v.size, enabled });
    if (fields) index.set(path, fields);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The Filters picker's Stash section (session-only, like the other filters)
// ---------------------------------------------------------------------------

/** No Stash filter: any rating, organised or not. */
export function emptyStashFilter() {
  return { minStars: 0, organized: false };
}

/** The stars a filter asks for: a whole number 1-5, else 0 (any rating). */
export function stashMinStars(state) {
  const n = state?.minStars;
  return Number.isInteger(n) && n >= 1 && n <= STASH_MAX_STARS ? n : 0;
}

/** Does the Stash filter hide anything? */
export function stashFilterActive(state) {
  return stashMinStars(state) > 0 || state?.organized === true;
}

/**
 * The videos the Stash filter lets through: "Rated N stars or more" keeps a
 * linked video whose rating100 is at least N × 20 (an unrated or unlinked
 * video is not rated N stars); "Organised in Stash" keeps a linked video
 * Stash marks organised. Order kept.
 *
 * @param {Array<{path: string}>} videos
 * @param {{minStars?: number, organized?: boolean}} state
 * @param {Map<string, object>} index stashFieldsIndex's
 */
export function applyStashFilter(videos, state, index) {
  if (!Array.isArray(videos)) return [];
  if (!stashFilterActive(state)) return videos;
  const min = stashMinStars(state) * STASH_STAR;
  const organized = state?.organized === true;
  return videos.filter((v) => {
    const f = index instanceof Map ? index.get(v?.path) : null;
    if (!f) return false;
    if (min > 0 && !(f.rating100 != null && f.rating100 >= min)) return false;
    if (organized && f.organized !== true) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// The video options dialog's lines
// ---------------------------------------------------------------------------

/**
 * What the dialog shows of Stash's activity for one linked video. Each part
 * is null when unknown (its line is hidden):
 * - `plays`: Stash's play count;
 * - `lastPlayed`: `{at, ms}` when Stash has a date; `'never'` when Stash
 *   says the scene was never played (a play count of 0 and no date); null
 *   otherwise (no count, or plays without a date: unknown, not "never");
 * - `oCount`: Stash's O-counter.
 *
 * @param {ReturnType<typeof sceneFields>|null} fields
 * @returns {{plays: number|null, lastPlayed: {at: string, ms: number}|'never'|null, oCount: number|null}|null}
 */
export function stashActivity(fields) {
  if (!fields) return null;
  let lastPlayed = null;
  if (fields.lastPlayedMs != null) lastPlayed = { at: fields.lastPlayedAt, ms: fields.lastPlayedMs };
  else if (fields.playCount === 0) lastPlayed = 'never';
  return { plays: fields.playCount, lastPlayed, oCount: fields.oCounter };
}
