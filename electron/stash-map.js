'use strict';

// Stash S1 (2026-11-18): Stash's GraphQL answers turned into the records
// FunSync keeps in userData/stash/library.json
// (notes/features/DESIGN-stash-s1.md (c) "library.json").
//
// Pure: no I/O, no clock (the caller passes `now`). Every value from Stash
// is untrusted text and is checked here, once, before it is stored:
//
// - A name (tag, performer, studio, marker tag) longer than 200 characters,
//   or text that is not well-formed (a lone UTF-16 surrogate), is LEFT OUT,
//   never cut into another name. At most 200 tags, 100 performers and 500
//   markers per scene, 10 URLs. `details` is display text only and is cut
//   at 2,000 characters (never inside a surrogate pair).
// - Ids are short [A-Za-z0-9_-] strings. A scene id goes into
//   "<address>/scenes/<id>" (Open in Stash) and every id is a map key, so
//   an id like "../x" or "__proto__" is refused, and the object holding it
//   with it.
// - Nothing Stash BUILT is stored: no `paths` (with a key, `paths.funscript`
//   carries "?apikey=<key>"), no `sceneStreams`, no image URLs. The mapper
//   copies named fields only, and any string containing "apikey=" is left
//   out wherever it appears.
// - The scene's own `urls` and the stash-box `endpoint`s are stored as text
//   only; FunSync never fetches them.
//
// Markers (Dave, 2026-11-18: seek-bar chapters are IN S1) keep their title,
// start, end (null when Stash has none), primary tag and other tags, sorted
// by start. The tags are embedded as {id, name} so a marker can be drawn
// without the scene's tag list.
//
// The "next" lot (2026-11-19, DESIGN-stash-s1.md appendix (j) #2, #3, #5,
// #6, #10; read-only): the play count, the last play, the O-count, the
// scene's Groups with its place in each, and the primary file's phash
// (mapSceneActivity), and Stash's tags with their aliases and parents
// (mapTagPage). A field Stash did not send is LEFT OUT of the record, never
// filled with 0, [] or null: an absent field means "not known" (an older
// library.json, or an answer to an older document), where 0 plays, no
// Groups and "no phash" are things Stash said.

/** Stash S1 record limits. */
const LIMITS = Object.freeze({
  name: 200,
  text: 200,
  title: 500,
  details: 2000,
  url: 2048,
  path: 4096,
  date: 10,
  stamp: 64,
  tagsPerScene: 200,
  performersPerScene: 100,
  markersPerScene: 500,
  urlsPerScene: 10,
  filesPerScene: 50,
  stashIdsPerItem: 20,
  tagsPerMarker: 50,
  // The "next" lot (2026-11-19).
  count: 1e9,
  groupsPerScene: 100,
  sceneIndex: 1e9,
  aliasesPerTag: 50,
  parentsPerTag: 50,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const API_KEY_RE = /apikey=/i;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const { normalizeOshash } = require('./stash-fingerprint');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

/** A string with no lone UTF-16 surrogate (video-tags.js isWellFormedText's twin). */
function isWellFormedText(text) {
  if (typeof text !== 'string') return false;
  return typeof text.isWellFormed === 'function' ? text.isWellFormed() : !LONE_SURROGATE_RE.test(text);
}

/**
 * A Stash id (scene, performer, studio, tag, marker), or null. Stash sends
 * numeric strings; a number is accepted and turned into one.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function stashId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof id !== 'string' || !ID_RE.test(id) || FORBIDDEN_IDS.has(id)) return null;
  return id;
}

/**
 * Text that may be stored: a well-formed string of at most `max`
 * characters after trimming, not empty, with no "apikey=" in it. Anything
 * else is null (left out, never cut).
 */
function cleanText(value, max, { trim = true } = {}) {
  if (typeof value !== 'string' || !isWellFormedText(value)) return null;
  const text = trim ? value.trim() : value;
  if (!text || text.length > max || API_KEY_RE.test(text)) return null;
  return text;
}

/** Display text cut at `max` characters, never inside a surrogate pair. */
function cutText(value, max) {
  if (typeof value !== 'string' || !isWellFormedText(value)) return null;
  let text = value.trim();
  if (!text || API_KEY_RE.test(text)) return null;
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return text;
}

function nonNegative(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function stashIdsOf(value) {
  const out = [];
  const seen = new Set();
  for (const item of asList(value)) {
    if (!isPlainObject(item)) continue;
    const endpoint = cleanText(item.endpoint, LIMITS.url);
    const id = cleanText(item.stash_id ?? item.stashId, LIMITS.text);
    if (!endpoint || !id) continue;
    const key = `${endpoint}\n${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ endpoint, stashId: id });
    if (out.length >= LIMITS.stashIdsPerItem) break;
  }
  return out;
}

/** {id, name} for a tag, or null (a bad id or name leaves the tag out). */
function mapTag(raw) {
  if (!isPlainObject(raw)) return null;
  const id = stashId(raw.id);
  const name = cleanText(raw.name, LIMITS.name);
  return id && name ? { id, name } : null;
}

/** {id, name, disambiguation, stashIds} for a performer, or null. */
function mapPerformer(raw) {
  if (!isPlainObject(raw)) return null;
  const id = stashId(raw.id);
  const name = cleanText(raw.name, LIMITS.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    disambiguation: cleanText(raw.disambiguation, LIMITS.name) || '',
    stashIds: stashIdsOf(raw.stash_ids ?? raw.stashIds),
  };
}

/** {id, name, parent (its name), parentId, stashIds} for a studio, or null. */
function mapStudio(raw) {
  if (!isPlainObject(raw)) return null;
  const id = stashId(raw.id);
  const name = cleanText(raw.name, LIMITS.name);
  if (!id || !name) return null;
  const parentRaw = isPlainObject(raw.parent_studio) ? raw.parent_studio : null;
  const parentId = parentRaw ? stashId(parentRaw.id) : null;
  const parent = parentRaw && parentId ? cleanText(parentRaw.name, LIMITS.name) : null;
  return {
    id,
    name,
    parent: parent || null,
    parentId: parent ? parentId : null,
    stashIds: stashIdsOf(raw.stash_ids ?? raw.stashIds),
  };
}

/** The oshash of a Stash file: the `oshash` alias, else its fingerprints list. */
function fileOshash(raw) {
  const direct = normalizeOshash(raw.oshash);
  if (direct) return direct;
  for (const fp of asList(raw.fingerprints)) {
    if (isPlainObject(fp) && fp.type === 'oshash') return normalizeOshash(fp.value);
  }
  return null;
}

/**
 * A phash as FunSync keeps it: 16 lower-case hex digits, or null. Stash
 * writes a phash as hex without leading zeros, so a shorter one is padded
 * (the same 64 bits). Anything else (a number, longer, not hex) is null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizePhash(value) {
  if (typeof value !== 'string') return null;
  const h = value.trim().toLowerCase();
  return /^[0-9a-f]{1,16}$/.test(h) ? h.padStart(16, '0') : null;
}

/**
 * The phash of a Stash file: `undefined` when the answer did not ask for
 * it (neither the `phash` alias nor a fingerprints list is there), else
 * the phash or null (Stash has none for this file).
 */
function filePhash(raw) {
  if (!isPlainObject(raw)) return undefined;
  if (Object.prototype.hasOwnProperty.call(raw, 'phash')) return normalizePhash(raw.phash);
  if (!Array.isArray(raw.fingerprints)) return undefined;
  for (const fp of raw.fingerprints) {
    if (isPlainObject(fp) && fp.type === 'phash') return normalizePhash(fp.value);
  }
  return null;
}

/** {path, size, duration, oshash} for a Stash video file, or null. */
function mapFile(raw, { withDuration = true } = {}) {
  if (!isPlainObject(raw)) return null;
  // A path is kept exactly as Stash spells it (not trimmed): it is compared.
  const path = cleanText(raw.path, LIMITS.path, { trim: false });
  if (!path || !path.trim()) return null;
  const size = Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : null;
  const out = { path, size, oshash: fileOshash(raw) };
  if (withDuration) out.duration = nonNegative(raw.duration);
  return out;
}

function filesOf(value, opts) {
  const out = [];
  for (const raw of asList(value)) {
    const file = mapFile(raw, opts);
    if (file) out.push(file);
    if (out.length >= LIMITS.filesPerScene) break;
  }
  return out;
}

/** A marker: {id, title, seconds, endSeconds, tag, tags}, or null. */
function mapMarker(raw) {
  if (!isPlainObject(raw)) return null;
  const id = stashId(raw.id);
  const seconds = nonNegative(raw.seconds);
  if (!id || seconds === null) return null;
  const end = nonNegative(raw.end_seconds ?? raw.endSeconds);
  const tags = [];
  const seen = new Set();
  for (const t of asList(raw.tags)) {
    const tag = mapTag(t);
    if (!tag || seen.has(tag.id)) continue;
    seen.add(tag.id);
    tags.push(tag);
    if (tags.length >= LIMITS.tagsPerMarker) break;
  }
  return {
    id,
    title: cleanText(raw.title, LIMITS.name) || '',
    seconds,
    endSeconds: end !== null && end > seconds ? end : null,
    tag: mapTag(raw.primary_tag ?? raw.primaryTag),
    tags,
  };
}

function markersOf(value) {
  const seen = new Set();
  const out = [];
  for (const raw of asList(value)) {
    const marker = mapMarker(raw);
    if (!marker || seen.has(marker.id)) continue;
    seen.add(marker.id);
    out.push(marker);
  }
  out.sort((a, b) => a.seconds - b.seconds || compareIds(a.id, b.id));
  return out.slice(0, LIMITS.markersPerScene);
}

function urlsOf(raw) {
  const list = Array.isArray(raw.urls) ? raw.urls : (typeof raw.url === 'string' ? [raw.url] : []);
  const out = [];
  for (const value of list) {
    const url = cleanText(value, LIMITS.url);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= LIMITS.urlsPerScene) break;
  }
  return out;
}

/** A count Stash keeps (plays, O): a whole number 0..1e9, else null. */
function countOf(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= LIMITS.count ? value : null;
}

/**
 * A moment as an ISO string in UTC (`2026-11-17T21:45:00.000Z`), so two
 * are compared as text the right way whatever offset Stash wrote. null for
 * anything that is not a date and time.
 */
function isoStamp(value) {
  if (typeof value !== 'string' || value.length > LIMITS.stamp) return null;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * One of a scene's Groups (`{scene_index, group {id name}}`): {id, name,
 * sceneIndex}, or null. A Group with a bad id or no usable name is left out
 * (it would be a playlist with no title). `sceneIndex` is the scene's place
 * in the Group, or null when Stash has none.
 */
function mapGroupRef(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.group)) return null;
  const id = stashId(raw.group.id);
  const name = cleanText(raw.group.name, LIMITS.name);
  if (!id || !name) return null;
  const index = raw.scene_index ?? raw.sceneIndex;
  return {
    id,
    name,
    sceneIndex: Number.isSafeInteger(index) && Math.abs(index) <= LIMITS.sceneIndex ? index : null,
  };
}

/**
 * What changes in Stash without the scene's `updated_at` changing (the
 * light list reads it on every full sync) and what the next lot shows: only
 * the fields the answer HAS, each checked:
 *   playCount, oCounter  a count, or left out when Stash sent none (null)
 *   lastPlayedAt         an ISO stamp in UTC, or null (never played)
 *   groups               [{id, name, sceneIndex}] (at most 100), or left out
 *   phash                the PRIMARY (first) file's phash, or null
 *
 * @param {unknown} raw a Scene from the light list or the details
 * @returns {{playCount?: number, lastPlayedAt?: string|null, oCounter?: number, groups?: object[], phash?: string|null}}
 */
function mapSceneActivity(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  if (has('play_count') && countOf(raw.play_count) !== null) out.playCount = raw.play_count;
  if (has('o_counter') && countOf(raw.o_counter) !== null) out.oCounter = raw.o_counter;
  if (has('last_played_at')) {
    if (raw.last_played_at === null) out.lastPlayedAt = null;
    else {
      const stamp = isoStamp(raw.last_played_at);
      if (stamp) out.lastPlayedAt = stamp;
    }
  }
  if (Array.isArray(raw.groups)) {
    const groups = [];
    const seen = new Set();
    for (const g of raw.groups) {
      const ref = mapGroupRef(g);
      if (!ref || seen.has(ref.id)) continue;
      seen.add(ref.id);
      groups.push(ref);
      if (groups.length >= LIMITS.groupsPerScene) break;
    }
    out.groups = groups;
  }
  if (Array.isArray(raw.files)) {
    // Stash lists the primary file first.
    const phash = raw.files.length === 0 ? null : filePhash(raw.files[0]);
    if (phash !== undefined) out.phash = phash;
  }
  return out;
}

/**
 * One tag of Stash's tag list: {id, name, aliases, parentIds}, or null. An
 * alias that is not usable text (or spells the tag's own name) is left out,
 * as is a parent with a bad id (or the tag itself).
 */
function mapTagNode(raw) {
  const tag = mapTag(raw);
  if (!tag) return null;
  const aliases = [];
  const seenAliases = new Set([tag.name.toLowerCase()]);
  for (const a of asList(raw.aliases)) {
    const alias = cleanText(a, LIMITS.name);
    if (!alias || seenAliases.has(alias.toLowerCase())) continue;
    seenAliases.add(alias.toLowerCase());
    aliases.push(alias);
    if (aliases.length >= LIMITS.aliasesPerTag) break;
  }
  const parentIds = [];
  for (const p of asList(raw.parents)) {
    const pid = isPlainObject(p) ? stashId(p.id) : null;
    if (!pid || pid === tag.id || parentIds.includes(pid)) continue;
    parentIds.push(pid);
    if (parentIds.length >= LIMITS.parentsPerTag) break;
  }
  return { id: tag.id, name: tag.name, aliases, parentIds };
}

/**
 * One page of `findTags` (FunSyncTagList): Stash's `count`, the tags, how
 * many were dropped (a tag whose id cannot be read: it keeps the list from
 * passing as complete; tagListComplete), and the ids of the tags `skipped`
 * (a readable id, but a name FunSync cannot use: over 200 characters, a
 * lone surrogate, "apikey="). A skipped tag is left out of the tree, but
 * its id counts, so one odd name never makes the whole list incomplete
 * (sn-fixup, 2026-11-19, the review's note).
 *
 * @param {unknown} findTags
 * @returns {{count: number|null, tags: object[], dropped: number, skipped: string[]}}
 */
function mapTagPage(findTags) {
  const page = isPlainObject(findTags) ? findTags : {};
  const tags = [];
  const skipped = [];
  let dropped = 0;
  for (const raw of asList(page.tags)) {
    const tag = mapTagNode(raw);
    if (tag) { tags.push(tag); continue; }
    const id = isPlainObject(raw) ? stashId(raw.id) : null;
    if (id) skipped.push(id); else dropped += 1;
  }
  const count = Number.isSafeInteger(page.count) && page.count >= 0 ? page.count : null;
  return { count, tags, dropped, skipped };
}

/**
 * Is a tag list every tag Stash has? The scene list's rule
 * (sceneListComplete), with the ids of the tags skipped for their name
 * (mapTagPage) counted as seen.
 */
function tagListComplete({ allPagesFetched, firstCount, lastCount, tags, dropped = 0, skipped = [] } = {}) {
  const seen = [...asList(tags), ...asList(skipped).filter((id) => typeof id === 'string' && id).map((id) => ({ id }))];
  return sceneListComplete({ allPagesFetched, firstCount, lastCount, scenes: seen, dropped });
}

/** Ids in Stash's numeric order where they are numbers. */
function compareIds(a, b) {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One scene of the light list a full sync reads (`id updated_at files {path
 * size oshash}`): what the matcher needs, nothing else.
 *
 * @param {unknown} raw
 * @returns {{id: string, updatedAt: string|null, files: {path: string, size: number|null, oshash: string|null}[]}|null}
 */
function mapListScene(raw) {
  if (!isPlainObject(raw)) return null;
  const id = stashId(raw.id);
  if (!id) return null;
  return {
    id,
    updatedAt: cleanText(raw.updated_at ?? raw.updatedAt, LIMITS.stamp),
    files: filesOf(raw.files, { withDuration: false }),
  };
}

/**
 * One page of `findScenes` (the light list): Stash's `count` and the scenes.
 * A scene with a bad id is dropped and counted in `dropped`, so the page's
 * ids no longer add up to `count` and the list cannot pass as complete.
 *
 * @param {unknown} findScenes the `findScenes` object of the answer
 * @returns {{count: number|null, scenes: object[], dropped: number}}
 */
function mapScenePage(findScenes) {
  const page = isPlainObject(findScenes) ? findScenes : {};
  const scenes = [];
  let dropped = 0;
  for (const raw of asList(page.scenes)) {
    const scene = mapListScene(raw);
    if (scene) scenes.push(scene); else dropped += 1;
  }
  const count = Number.isSafeInteger(page.count) && page.count >= 0 ? page.count : null;
  return { count, scenes, dropped };
}

/**
 * Is a light list every scene Stash has? Every page was fetched, Stash
 * reported the same `count` on the first and the last page, and the
 * distinct ids seen add up to it. Only a complete list may mark a link
 * "gone" (DESIGN (b)).
 *
 * @param {{allPagesFetched: boolean, firstCount: number|null, lastCount: number|null, scenes: {id: string}[], dropped?: number}} list
 * @returns {boolean}
 */
function sceneListComplete({ allPagesFetched, firstCount, lastCount, scenes, dropped = 0 } = {}) {
  if (allPagesFetched !== true || dropped) return false;
  if (!Number.isSafeInteger(firstCount) || firstCount !== lastCount) return false;
  const ids = new Set(asList(scenes).map((s) => (isPlainObject(s) ? s.id : null)).filter(Boolean));
  return ids.size === firstCount;
}

/**
 * One scene's details, mapped to the stored record, with the performers,
 * studio and tags it refers to as lists (library.json stores them once by
 * id; stash-library-file.js storeRecords takes this shape).
 *
 * @param {unknown} raw a Scene from `findScene` / `findScenes`
 * @param {{now: number}} opts `now` becomes `fetchedAt`
 * @returns {{scene: object, performers: object[], studios: object[], tags: object[]}|null}
 */
function mapScene(raw, { now } = {}) {
  if (!isPlainObject(raw)) return null;
  const id = stashId(raw.id);
  if (!id) return null;

  // Seen ids are kept in Sets: an id such as "toString" must not look
  // already present through a plain object's prototype.
  const performers = [];
  const performerIds = [];
  const seenPerformers = new Set();
  for (const p of asList(raw.performers)) {
    const performer = mapPerformer(p);
    if (!performer || seenPerformers.has(performer.id)) continue;
    seenPerformers.add(performer.id);
    performers.push(performer);
    performerIds.push(performer.id);
    if (performerIds.length >= LIMITS.performersPerScene) break;
  }

  const tags = [];
  const tagIds = [];
  const seenTags = new Set();
  for (const t of asList(raw.tags)) {
    const tag = mapTag(t);
    if (!tag || seenTags.has(tag.id)) continue;
    seenTags.add(tag.id);
    tags.push(tag);
    tagIds.push(tag.id);
    if (tagIds.length >= LIMITS.tagsPerScene) break;
  }

  const studio = mapStudio(raw.studio);

  const rating = raw.rating100;
  const date = typeof raw.date === 'string' && DATE_RE.test(raw.date) ? raw.date : null;
  const scene = {
    id,
    title: cleanText(raw.title, LIMITS.title),
    code: cleanText(raw.code, LIMITS.text),
    date,
    director: cleanText(raw.director, LIMITS.name),
    details: cutText(raw.details, LIMITS.details),
    urls: urlsOf(raw),
    rating100: Number.isInteger(rating) && rating >= 0 && rating <= 100 ? rating : null,
    organized: raw.organized === true,
    studioId: studio ? studio.id : null,
    performerIds,
    tagIds,
    markers: markersOf(raw.scene_markers ?? raw.markers),
    stashIds: stashIdsOf(raw.stash_ids ?? raw.stashIds),
    files: filesOf(raw.files),
    updatedAt: cleanText(raw.updated_at ?? raw.updatedAt, LIMITS.stamp),
    fetchedAt: Number.isFinite(now) ? now : null,
    // The next lot: only what the answer has (absent = not known).
    ...mapSceneActivity(raw),
  };
  return { scene, performers, studios: studio ? [studio] : [], tags };
}

/**
 * Several scenes' details (a list, or the values of an aliased answer where
 * a missing scene is null) merged into the four maps library.json keeps.
 * Nulls and scenes that fail mapScene are skipped; which ids came back
 * null is the caller's to read from its own aliases.
 *
 * @param {Array<unknown>|Object<string, unknown>} raws
 * @param {{now: number}} opts
 * @returns {{scenes: object, performers: object, studios: object, tags: object}}
 */
function mapScenes(raws, opts = {}) {
  const list = Array.isArray(raws) ? raws : (isPlainObject(raws) ? Object.values(raws) : []);
  const out = { scenes: {}, performers: {}, studios: {}, tags: {} };
  for (const raw of list) {
    const mapped = mapScene(raw, opts);
    if (!mapped) continue;
    out.scenes[mapped.scene.id] = mapped.scene;
    for (const key of ['performers', 'studios', 'tags']) {
      for (const rec of mapped[key]) out[key][rec.id] = rec;
    }
  }
  return out;
}

/**
 * Every string inside `value` that contains "apikey=" (any case), with its
 * path. Empty for anything this module produced; the sync and the tests use
 * it to prove no URL Stash built was stored.
 *
 * @param {unknown} value
 * @returns {string[]} paths such as "scenes.1.urls.0"
 */
function findApiKeyStrings(value) {
  const hits = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (API_KEY_RE.test(node)) hits.push(path);
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
    } else if (node && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        if (API_KEY_RE.test(key)) hits.push(path ? `${path}.${key}` : key);
        walk(item, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(value, '');
  return hits;
}

module.exports = {
  LIMITS,
  stashId,
  compareIds,
  isWellFormedText,
  mapTag,
  mapPerformer,
  mapStudio,
  mapMarker,
  mapFile,
  mapListScene,
  mapScenePage,
  sceneListComplete,
  mapScene,
  mapScenes,
  findApiKeyStrings,
  normalizePhash,
  isoStamp,
  mapGroupRef,
  mapSceneActivity,
  mapTagNode,
  mapTagPage,
  tagListComplete,
};
