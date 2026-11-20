// Stash data as tags, and the video options dialog's view of one video's
// Stash link (Stash S1, Round 1 stage 1d, 2026-11-18;
// notes/features/DESIGN-stash-s1.md (c) "The renderer's copy and the stash
// tag source", "Performers and studios split by Stash ID").
//
// The data is Electron main's stash/library.json as the renderer's store
// hands it over (renderer/js/stash-store.js stashData(): a frozen copy, never
// null). This module only reads it:
//
// - stashTagRecords(data, {videos, enabled}): the engine's `stash` source
//   (video-tags.js effectiveTags), keyed by VIDEO path. A link counts while
//   its state is `ok` or `gone` (a scene gone from Stash keeps its tags, as
//   a 404'd EroScripts post does) and its fingerprint's size equals the size
//   the library scan saw (the trust check: a swapped file shows none of the
//   old file's Stash data; the record stays). An unknown size on either side
//   is trusted. `enabled` must be `true`: Stash turned off (or never set up)
//   gives nothing.
// - nameIdentities(data, {enabled}): `facet:name-slug` -> the ONE identity
//   the Stash data has for that name. A name with two identities, or with an
//   identity and a Stash entry with none, is left out, so a bare name (a
//   funscript's performer, one you typed) is never pinned to the wrong person.
// - stashIdentity(entity): a performer's or studio's identity: its Stash ID
//   (StashDB's endpoint first, then by endpoint address), else
//   `d-<disambiguation>`, else null (it then merges by name like any source).
// - stashVideoView(data, path, {size, duration, enabled}): what the dialog's
//   File > Stash block and the Tags section's Stash row show.
// - stashTagRuleSet(data, {enabled, useTagRules}) (Stash "next" lot,
//   sn-tags, 2026-11-19): Stash's tag aliases and sub-tags (main's
//   `tagRules`, built from Tag.aliases / parents / children) and its tag
//   names, checked and capped, for video-tags.js compileTagRules (the alias
//   layer) and library-tag-filter.js (sub-tags). null unless Stash is on AND
//   "Use Stash's tag aliases and sub-tags" (`stash.useTagRules`) is on AND
//   main sent `tagRules`: off, nothing about tags changes.
//
// Rules kept here: pure, no DOM, no IPC, no fetch, nothing written, no module
// state. Absence is never destructive: a missing scene, tag or person adds
// nothing. Nothing here builds a URL, and no URL Stash made is copied into a
// record (the key could ride in one). Text is returned as data; the UI shows
// it with textContent.

import {
  displayForm, isWellFormedText, nameSlug, tagIdentity,
} from './video-tags.js';

/** StashDB's host: its Stash ID comes first when a person has several. */
export const STASHDB_HOST = 'stashdb.org';

/** Link states whose data counts (a gone scene keeps its tags). */
export const TRUSTED_STATES = Object.freeze(['ok', 'gone']);

// The mapper's limits (DESIGN-stash-s1.md (c) "Limits"), applied again here
// so a hand-edited or older file cannot flood the index.
const MAX_NAME = 200;
const MAX_TAGS = 200;
const MAX_PERFORMERS = 100;
const MAX_MARKERS = 500;
const MAX_URLS = 10;
const MAX_DETAILS = 2000;
const MAX_COPIES = 20;
const MAX_CANDIDATES = 50;
const DURATION_FLAG_SECONDS = 2;

const EMPTY_RECORDS = Object.freeze({});
const EMPTY_IDS = Object.freeze(new Map());

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function own(map, key) {
  if (!isPlainObject(map) || (typeof key !== 'string' && typeof key !== 'number')) return undefined;
  const k = String(key);
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
}

// An own property even for a path like `__proto__` (never a prototype write).
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

// Text the UI may show: a well-formed string, trimmed, at most `max` long.
function text(value, max = MAX_NAME) {
  if (typeof value !== 'string' || !isWellFormedText(value)) return null;
  const t = displayForm(value);
  return t && t.length <= max ? t : null;
}

// A path, a hash, an address: as given (no whitespace folding), when usable.
function plain(value, max) {
  return typeof value === 'string' && value && value.length <= max && isWellFormedText(value) ? value : null;
}

function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value && value.length <= MAX_NAME && isWellFormedText(value) ? value : null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hostOf(endpoint) {
  if (typeof endpoint !== 'string') return '';
  try { return new URL(endpoint).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * A performer's or studio's identity (Dave, 2026-11-18: same-name people
 * are kept apart by Stash ID): its Stash ID, lower case, with StashDB's
 * first when there are several, then by endpoint address; with none, a
 * disambiguation as `d-<slug>`; else null.
 *
 * @param {{stashIds?: {endpoint: string, stashId: string}[], disambiguation?: string}} entity
 * @returns {string|null}
 */
export function stashIdentity(entity) {
  if (!isPlainObject(entity)) return null;
  const ids = list(entity.stashIds)
    .filter((s) => isPlainObject(s) && tagIdentity(s.stashId))
    .map((s) => ({ endpoint: typeof s.endpoint === 'string' ? s.endpoint : '', id: tagIdentity(s.stashId) }));
  ids.sort((a, b) => {
    const ad = hostOf(a.endpoint) === STASHDB_HOST ? 0 : 1;
    const bd = hostOf(b.endpoint) === STASHDB_HOST ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (a.endpoint !== b.endpoint) return a.endpoint < b.endpoint ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (ids.length) return ids[0].id;
  const dis = text(entity.disambiguation);
  return dis ? tagIdentity(`d-${dis}`) : null;
}

// One person or studio as the engine's record item, or null.
function personItem(id, entity, withDisambiguation) {
  if (!isPlainObject(entity)) return null;
  const name = text(entity.name);
  if (!name || !nameSlug(name)) return null;
  const item = { id, name };
  const identity = stashIdentity(entity);
  if (identity) item.identity = identity;
  if (withDisambiguation) {
    const dis = text(entity.disambiguation);
    if (dis) item.disambiguation = dis;
  }
  return Object.freeze(item);
}

// The scanned size of each library video, when the scan gave one.
function sizesOf(videos) {
  const sizes = new Map();
  for (const v of list(videos)) {
    const p = v?.path;
    if (typeof p !== 'string' || !p || sizes.has(p)) continue;
    sizes.set(p, finite(v.size));
  }
  return sizes;
}

// Does this link's data count for a file of `size` (null: unknown)?
function trusted(link, size) {
  if (!isPlainObject(link) || !TRUSTED_STATES.includes(link.state)) return false;
  const linked = finite(link.fp?.size);
  return size == null || linked == null || linked === size;
}

// The record one scene gives (null when it gives no tag at all).
function sceneRecord(data, scene) {
  if (!isPlainObject(scene)) return null;
  const tags = [];
  const seenTags = new Set();
  for (const raw of list(scene.tagIds)) {
    if (tags.length >= MAX_TAGS) break;
    const id = idOf(raw);
    if (!id || seenTags.has(id)) continue;
    const name = text(own(data.tags, id)?.name);
    if (!name) continue;
    seenTags.add(id);
    tags.push(Object.freeze({ id, name }));
  }
  const performers = [];
  const seenPeople = new Set();
  for (const raw of list(scene.performerIds)) {
    if (performers.length >= MAX_PERFORMERS) break;
    const id = idOf(raw);
    if (!id || seenPeople.has(id)) continue;
    const item = personItem(id, own(data.performers, id), true);
    if (!item) continue;
    seenPeople.add(id);
    performers.push(item);
  }
  const studioId = idOf(scene.studioId);
  const studio = studioId ? personItem(studioId, own(data.studios, studioId), false) : null;
  if (!tags.length && !performers.length && !studio) return null;
  const record = { tags: Object.freeze(tags), performers: Object.freeze(performers) };
  if (studio) record.studio = studio;
  return Object.freeze(record);
}

/**
 * The engine's `stash` source: `{[videoPath]: {tags: [{id, name}],
 * performers: [{id, name, identity?, disambiguation?}], studio?: {id, name,
 * identity?}}}`. Only links whose state is `ok` or `gone` and whose
 * fingerprint size equals the scanned size (unknown: trusted); only the
 * videos in `videos` when a list is given. `enabled` must be `true`.
 *
 * @param {object} data stash/library.json as the renderer holds it
 * @param {{videos?: {path: string, size?: number}[], enabled?: boolean}} [options]
 * @returns {Object<string, object>} frozen records; `{}` when off or empty
 */
export function stashTagRecords(data, { videos, enabled } = {}) {
  if (enabled !== true || !isPlainObject(data) || !isPlainObject(data.links)) return EMPTY_RECORDS;
  const sizes = Array.isArray(videos) ? sizesOf(videos) : null;
  const out = {};
  const byScene = new Map();
  for (const [path, link] of Object.entries(data.links)) {
    if (!path || (sizes && !sizes.has(path))) continue;
    if (!trusted(link, sizes ? sizes.get(path) : null)) continue;
    const sceneId = idOf(link.sceneId);
    if (!sceneId) continue;
    let record = byScene.get(sceneId);
    if (record === undefined) {
      record = sceneRecord(data, own(data.scenes, sceneId));
      byScene.set(sceneId, record);
    }
    if (record) setOwn(out, path, record);
  }
  return Object.freeze(out);
}

/**
 * `facet:name-slug` -> the one identity the Stash data has for that name,
 * for the bare-name join (effectiveTags `options.nameIds`). A name Stash has
 * twice (two identities, or one with an identity and one with none) is left
 * out. Empty unless `enabled` is `true`.
 *
 * @param {object} data
 * @param {{enabled?: boolean}} [options]
 * @returns {Map<string, string>}
 */
export function nameIdentities(data, { enabled } = {}) {
  if (enabled !== true || !isPlainObject(data)) return EMPTY_IDS;
  const seen = new Map(); // facet:slug -> Set of identities ('' = none)
  const add = (facet, entity) => {
    if (!isPlainObject(entity)) return;
    const name = text(entity.name);
    const slug = name ? nameSlug(name) : '';
    if (!slug) return;
    const mark = `${facet}:${slug}`;
    if (!seen.has(mark)) seen.set(mark, new Set());
    seen.get(mark).add(stashIdentity(entity) || '');
  };
  for (const entity of Object.values(isPlainObject(data.performers) ? data.performers : {})) add('performer', entity);
  for (const entity of Object.values(isPlainObject(data.studios) ? data.studios : {})) add('studio', entity);
  const out = new Map();
  for (const [mark, ids] of seen) {
    if (ids.size !== 1) continue;
    const [only] = ids;
    if (only) out.set(mark, only);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stash's tag aliases and sub-tags (sn-tags)
// ---------------------------------------------------------------------------

/** At most this many aliases, parents, children per parent and names are read. */
export const MAX_TAG_RULE_ALIASES = 20000;
export const MAX_TAG_RULE_PARENTS = 20000;
export const MAX_TAG_RULE_CHILDREN = 2000;
export const MAX_TAG_RULE_NAMES = 20000;
const MAX_RULE_TEXT = 512;

// A rule's text (an alias slug, a tag key): a well-formed string, at most
// 512 long, not blank.
function ruleText(value) {
  if (typeof value !== 'string' || value.length > MAX_RULE_TEXT || !isWellFormedText(value)) return null;
  return value.trim() ? value : null;
}

const byFirst = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Stash's tag aliases, sub-tags and tag names, as the tag engine reads them:
 * `{aliases: [[aliasSlug, canonicalTagKey]], children: [[parentTagKey,
 * [childTagKey…]]], names: [tag name…]}`, sorted, frozen. The names are the
 * Stash tags this data holds (`data.tags`) and, when main sends them,
 * `tagRules.names` (a key -> name map or a list), so an aliased tag and a
 * parent no video has show Stash's spelling.
 *
 * null unless `enabled` and `useTagRules` are both `true` and the data has
 * `tagRules` (an older library.json has none: unknown, so nothing changes).
 *
 * @param {object} data stash/library.json as the renderer holds it
 * @param {{enabled?: boolean, useTagRules?: boolean}} [options]
 * @returns {{aliases: Array<[string, string]>, children: Array<[string, string[]]>, names: string[]}|null}
 */
export function stashTagRuleSet(data, { enabled, useTagRules } = {}) {
  if (enabled !== true || useTagRules !== true || !isPlainObject(data) || !isPlainObject(data.tagRules)) return null;
  const input = data.tagRules;
  const aliases = [];
  if (isPlainObject(input.aliases)) {
    for (const [from, to] of Object.entries(input.aliases)) {
      if (aliases.length >= MAX_TAG_RULE_ALIASES) break;
      const f = ruleText(from);
      const target = ruleText(to);
      if (f && target) aliases.push(Object.freeze([f, target]));
    }
  }
  const children = [];
  if (isPlainObject(input.children)) {
    for (const [parent, kids] of Object.entries(input.children)) {
      if (children.length >= MAX_TAG_RULE_PARENTS) break;
      const p = ruleText(parent);
      if (!p) continue;
      const kidKeys = [...new Set(list(kids).map(ruleText).filter((k) => k && k !== p))].slice(0, MAX_TAG_RULE_CHILDREN);
      if (kidKeys.length) children.push(Object.freeze([p, Object.freeze(kidKeys)]));
    }
  }
  const names = new Set();
  const addName = (value) => {
    if (names.size >= MAX_TAG_RULE_NAMES) return;
    const name = text(value);
    if (name) names.add(name);
  };
  for (const tag of Object.values(isPlainObject(data.tags) ? data.tags : {})) addName(isPlainObject(tag) ? tag.name : null);
  if (isPlainObject(input.names)) for (const name of Object.values(input.names)) addName(name);
  else for (const name of list(input.names)) addName(name);
  return Object.freeze({
    aliases: Object.freeze(aliases.sort(byFirst)),
    children: Object.freeze(children.sort(byFirst)),
    names: Object.freeze([...names].sort()),
  });
}

/**
 * A cheap stamp of what stashTagRuleSet would build from `data` (sn-fixup,
 * 2026-11-19, SN-R5): main's `tagRules.stamp` (the tag tree's server, when
 * it was read and its size; main builds the rules once per tree) and the
 * names of the Stash tags the data holds. Equal stamps: an equal set. null
 * when the data carries no stamp (then compare the sets, sameTagRuleSet).
 *
 * @param {object} data stash/library.json as the renderer holds it
 * @param {{enabled?: boolean, useTagRules?: boolean}} [options]
 * @returns {string|null}
 */
export function tagRuleSetStamp(data, { enabled, useTagRules } = {}) {
  if (enabled !== true || useTagRules !== true || !isPlainObject(data) || !isPlainObject(data.tagRules)) return null;
  const stamp = data.tagRules.stamp;
  if (typeof stamp !== 'string' || !stamp) return null;
  const names = [];
  for (const tag of Object.values(isPlainObject(data.tags) ? data.tags : {})) names.push(isPlainObject(tag) ? String(tag.name ?? '') : '');
  return `${stamp}\u0001${names.join('\u0000')}`;
}

/**
 * Do two stashTagRuleSet results hold the same rules? (null equals null.)
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
export function sameTagRuleSet(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const samePairs = (x, y, inner) => Array.isArray(x) && Array.isArray(y) && x.length === y.length
    && x.every((item, i) => inner(item, y[i]));
  const sameList = (x, y) => samePairs(x, y, (p, q) => p === q);
  return samePairs(a.aliases, b.aliases, (p, q) => p[0] === q[0] && p[1] === q[1])
    && samePairs(a.children, b.children, (p, q) => p[0] === q[0] && sameList(p[1], q[1]))
    && sameList(a.names, b.names);
}

// ---------------------------------------------------------------------------
// The dialog's view model
// ---------------------------------------------------------------------------

function sameServer(a, b) {
  const canon = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return canon(a) === canon(b);
}

function baseName(path) {
  const p = typeof path === 'string' ? path : '';
  return p.split(/[\\/]/).pop() || '';
}

function cutText(value, max) {
  if (typeof value !== 'string' || !isWellFormedText(value)) return null;
  const t = value.trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return isWellFormedText(cut) ? cut : cut.slice(0, -1);
}

function sceneView(data, scene) {
  if (!isPlainObject(scene)) return null;
  const record = sceneRecord(data, scene);
  const studioId = idOf(scene.studioId);
  const studioEntity = studioId ? own(data.studios, studioId) : null;
  const rating = finite(scene.rating100);
  return {
    id: idOf(scene.id),
    title: text(scene.title, 500),
    code: text(scene.code),
    date: text(scene.date, 40),
    director: text(scene.director),
    details: cutText(scene.details, MAX_DETAILS),
    urls: list(scene.urls).map((u) => text(u, 2048)).filter(Boolean).slice(0, MAX_URLS),
    rating100: rating != null && rating >= 0 && rating <= 100 ? rating : null,
    organized: scene.organized === true,
    studio: record?.studio
      ? { id: record.studio.id, name: record.studio.name, parent: text(isPlainObject(studioEntity?.parent) ? studioEntity.parent.name : studioEntity?.parent) }
      : null,
    performers: record ? record.performers.map((p) => ({ id: p.id, name: p.name, disambiguation: p.disambiguation || null })) : [],
    tags: record ? record.tags.map((t) => ({ id: t.id, name: t.name })) : [],
    markers: list(scene.markers)
      .filter((m) => isPlainObject(m) && finite(m.seconds) != null && m.seconds >= 0)
      .slice(0, MAX_MARKERS)
      .map((m) => {
        const end = finite(m.endSeconds);
        return {
          id: idOf(m.id),
          title: text(m.title),
          seconds: m.seconds,
          endSeconds: end != null && end >= m.seconds ? end : null,
          tag: text(isPlainObject(m.tag) ? m.tag.name : m.tag),
        };
      })
      .sort((a, b) => a.seconds - b.seconds),
    files: list(scene.files).filter(isPlainObject).map((f) => ({
      path: plain(f.path, 4096),
      name: baseName(plain(f.path, 4096)),
      size: finite(f.size),
      duration: finite(f.duration),
      oshash: plain(f.oshash, 64),
    })),
    updatedAt: text(scene.updatedAt, 64),
    fetchedAt: finite(scene.fetchedAt) ?? text(scene.fetchedAt, 64),
  };
}

function candidateView(data, sceneId, oshash, duration) {
  const scene = sceneView(data, own(data.scenes, sceneId));
  const files = scene ? scene.files : [];
  const file = files.find((f) => oshash && f.oshash === oshash) || files[0] || null;
  const diff = duration != null && file?.duration != null ? Math.abs(file.duration - duration) : null;
  return {
    sceneId,
    title: scene?.title ?? null,
    date: scene?.date ?? null,
    studio: scene?.studio?.name ?? null,
    fileName: file?.name || null,
    duration: file?.duration ?? null,
    durationDiff: diff,
    durationFlag: diff != null && diff > DURATION_FLAG_SECONDS,
  };
}

/**
 * What the dialog shows for one video (File > Stash, and the Tags
 * section's Stash row). null when Stash is off (`enabled` not `true`), the
 * data is missing or the path is empty: the dialog then shows no Stash at
 * all.
 *
 * `state`, in this order:
 * - `check`: a sync could not decide (two scenes have this exact file, or
 *   Stash has a file at this path with other content); `check.candidates`
 *   lists them (title, date, studio, file name, the duration difference
 *   against `duration`, flagged above 2 s). A link kept from before is in
 *   `link`.
 * - `changed`: linked, but the file changed since (the size the scan saw
 *   differs, or the sync marked it): its data is hidden until the next sync.
 * - `gone`: the scene is gone from Stash; its data is kept and still counts.
 * - `linked`: linked and trusted.
 * - `refused`: you said this file is not that scene (Not this scene / None
 *   of these); `refused.scenes` names them.
 * - `notInStash`: a sync ran and found nothing; `notSynced`: no sync yet.
 *
 * @param {object} data stash/library.json as the renderer holds it
 * @param {string} path the video's path
 * @param {{size?: number, duration?: number, enabled?: boolean}} [options]
 *   `size` the scanned size (the trust check), `duration` FunSync's own (s)
 * @returns {object|null}
 */
export function stashVideoView(data, path, { size, duration, enabled } = {}) {
  if (enabled !== true || !isPlainObject(data) || typeof path !== 'string' || !path) return null;
  const scanned = finite(size);
  const ownDuration = finite(duration);
  const linkRaw = own(data.links, path);
  const link = isPlainObject(linkRaw) ? linkRaw : null;
  const checkRaw = own(data.check, path);
  const check = isPlainObject(checkRaw) ? checkRaw : null;
  const refusedRaw = own(data.refused, path);
  const refused = isPlainObject(refusedRaw) ? refusedRaw : null;
  const serverUrl = plain(data.server?.url, 2048);
  const lastSync = isPlainObject(data.lastSync)
    ? { at: data.lastSync.at ?? null, kind: text(data.lastSync.kind, 16), ok: data.lastSync.ok === true, partial: data.lastSync.partial === true }
    : null;

  const view = {
    state: 'notSynced',
    link: null,
    scene: null,
    hidden: false,
    counts: { tags: 0, performers: 0, studio: 0 },
    check: null,
    refused: null,
    copies: [],
    lastSync,
    server: serverUrl ? { url: serverUrl, version: text(data.server?.version, 64) } : null,
  };

  if (link) {
    const sceneId = idOf(link.sceneId);
    const ok = trusted(link, scanned);
    view.link = {
      sceneId,
      by: text(link.by, 16),
      state: text(link.state, 16),
      linkedAt: link.linkedAt ?? null,
      server: plain(link.server, 2048),
      otherServer: !!(link.server && serverUrl && !sameServer(link.server, serverUrl)),
      verify: link.verify === true,
      // s1-fixup-main (S1RB-4): the scene with this id no longer holds this
      // file (a Stash reset or rescan reused the id); the state is 'changed'.
      ...(link.sceneChanged === true ? { sceneChanged: true } : {}),
    };
    view.scene = sceneId ? sceneView(data, own(data.scenes, sceneId)) : null;
    view.hidden = !ok;
    if (ok && view.scene) {
      view.counts = { tags: view.scene.tags.length, performers: view.scene.performers.length, studio: view.scene.studio ? 1 : 0 };
    }
    view.state = !ok ? 'changed' : (link.state === 'gone' ? 'gone' : 'linked');
    const oshash = plain(link.fp?.oshash, 64);
    if (sceneId && oshash && isPlainObject(data.links)) {
      view.copies = Object.entries(data.links)
        .filter(([p, l]) => p !== path && isPlainObject(l) && idOf(l.sceneId) === sceneId
          && TRUSTED_STATES.includes(l.state) && plain(l.fp?.oshash, 64) === oshash)
        .map(([p]) => p)
        .sort()
        .slice(0, MAX_COPIES);
    }
  }

  if (check) {
    const oshash = plain(check.fp?.oshash, 64);
    const ids = [...new Set(list(check.sceneIds).map(idOf).filter(Boolean))].slice(0, MAX_CANDIDATES);
    view.check = {
      kind: check.kind === 'pathChanged' ? 'pathChanged' : 'several',
      candidates: ids.map((id) => candidateView(data, id, oshash, ownDuration)),
    };
    view.state = 'check';
  }

  if (refused) {
    const ids = [...new Set(list(refused.sceneIds).map(idOf).filter(Boolean))].slice(0, MAX_CANDIDATES);
    view.refused = {
      at: refused.at ?? null,
      scenes: ids.map((id) => ({ id, title: text(own(data.scenes, id)?.title, 500) })),
    };
    if (!link && !check) view.state = 'refused';
  }

  if (!link && !check && !refused) view.state = lastSync?.at != null ? 'notInStash' : 'notSynced';
  return view;
}
