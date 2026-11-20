// StashLibraryFile — the Stash data file, userData/stash/library.json (S1).
//
// notes/features/DESIGN-stash-s1.md (c) "library.json", "Re-home on move",
// "Backups and import merge" and (e). Electron main is the ONLY writer of
// this file: the renderer asks main for every change (link, choose, refuse,
// unlink, Undo, re-home, remove) and gets the new data back, so there is no
// renderer whole-map write to race a sync (the V02 lesson).
//
// The rules this module keeps:
//   - Absence is never destructive. A missing file is an empty library that
//     is NOT written until something real is stored. A damaged or oversized
//     file is moved aside (library.damaged-<date>.json), never overwritten,
//     and the empty copy in memory is not written until a sync (or an
//     import) stores real data. A file that cannot be read at all (locked)
//     is left where it is and nothing is written this session.
//   - The previous copy is the way back (s1-fixup-main, 2026-11-19, S1RB-2):
//     when library.json is damaged or missing and library.json.bak is a
//     usable file, the .bak is loaded (status().recovered says so). After a
//     damaged or missing load the .bak is not replaced until this session
//     has written a whole library.json itself (fileKnown), so the user's
//     links, choices and refusals are in at least one file at every moment.
//   - Every write is atomic: a synced .tmp is renamed over library.json, and
//     the version it replaces becomes library.json.bak. A failing write
//     leaves library.json and library.json.bak exactly as they were.
//   - No URL Stash builds is ever stored: a string that carries `apikey=`
//     is left out of everything this module stores or hands to the renderer.
//   - Nothing here holds the API key (electron/stash-secret.js does), and the
//     renderer projection is a whitelist of the design's fields.
//
// Writes run one at a time through a queue, so a user action during a sync
// is applied to the newest data and the sync's commit sees it.
//
// Stash ids are unique only per server (Round 2, 2026-11-18): scenes,
// performers, studios and tags are stored under stash-keys.js recordKey
// (`<id>@<server>`), each with its raw `id` and its `server`; links, checks
// and refusals record their server. The renderer projection turns them into
// opaque ids (stash-keys.js projectedId: the data's own server keeps raw
// ids), so two servers' records can never be mistaken for each other.
//
// The "next" lot (2026-11-19, appendix (j) #2, #3, #5, #6, #10; read-only):
//   - A scene record may carry playCount, lastPlayedAt, oCounter, phash and
//     groups [{id, name, sceneIndex}] (stash-map.js mapSceneActivity). A
//     record without one (an older file) projects WITHOUT it: not known,
//     never "0 plays" or "no Group".
//   - `groups` (optional map): each Stash Group a linked video's scene
//     (link state ok) belongs to, by recordKey, with its name and its scenes
//     in Stash's order (scene_index, then id). Rebuilt by refreshGroups at
//     every sync (and when you link, choose, refuse, unlink or Undo, the
//     last three since sn-fixup SN-R3); a Group goes ONLY when a complete,
//     successful full sync no longer finds it. Read-only playlists
//     "Stash: <name>" in the renderer (Dave: kept in sync). An import
//     (merge) does not take the backup's Groups: they are rebuilt from the
//     merged scenes (sn-fixup SN-R4, see mergeGroups).
//   - `tagTrees` (optional map): per server key, Stash's tags with their
//     aliases and parents from the last COMPLETE tag list. The projection
//     carries `tagRules` (stash-tag-rules.js) only when asked to, which
//     stash-ipc.js does only while Stash is on and "Use Stash's tag aliases
//     and sub-tags" (settings.stash.useTagRules) is ticked.

'use strict';

const fs = require('fs');
const path = require('path');
const { serverKey, sameServer, recordKey, projectedId, parseProjectedId } = require('./stash-keys');
const { buildTagRules } = require('./stash-tag-rules');

const FILE_NAME = 'library.json';
const BAK_NAME = 'library.json.bak';
/** A file over this is refused on load (moved aside), as the design says. */
const MAX_BYTES = 64 * 1024 * 1024;
const VERSION = 1;
const VIDEO_MAPS = Object.freeze(['links', 'check', 'refused']);
const RECORD_MAPS = Object.freeze(['scenes', 'performers', 'studios', 'tags']);
// The next lot's maps: optional (an older file has none), never required.
const NEXT_MAPS = Object.freeze(['groups', 'tagTrees']);
const USER_BY = Object.freeze(['manual', 'chosen']);
const LINK_BY = Object.freeze(['oshash', 'chosen', 'manual']);
const LINK_STATES = Object.freeze(['ok', 'gone', 'changed']);
const CHECK_KINDS = Object.freeze(['several', 'pathChanged']);
const SECRET_IN_TEXT = /apikey=/i;
const OSHASH_RE = /^[0-9a-f]{16}$/;
const PHASH_RE = /^[0-9a-f]{16}$/;
// A Group id as stash-map.js stashId keeps it (a hand edit may hold anything).
const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const REMOVED_NAME_RE = /^library\.removed-[0-9T-]+\.json(?:\.bak)?$/;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const idOf = (v) => ((typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : null);
const timeOf = (v) => (Number.isFinite(v) ? v : -Infinity);
const groupIdOf = (v) => { const id = idOf(v); return id && GROUP_ID_RE.test(id) && !FORBIDDEN_IDS.has(id) ? id : null; };
const pad = (n) => String(n).padStart(2, '0');

function emptyData() {
  return {
    v: VERSION, rev: 0, server: null, lastSync: null,
    links: {}, check: {}, refused: {}, scenes: {}, performers: {}, studios: {}, tags: {},
  };
}

/**
 * A copy of `value` without any string that carries `apikey=` (an array
 * item, or an object field, is left out; so is an object key that carries
 * it). With a key, Stash puts `?apikey=<key>` into the URLs it builds; S1
 * never asks for them, and this keeps one from being stored if it ever did.
 */
function scrubSecrets(value) {
  if (typeof value === 'string') return SECRET_IN_TEXT.test(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(scrubSecrets).filter((v) => v !== undefined);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_IN_TEXT.test(k)) continue;
      const clean = scrubSecrets(v);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
  return value;
}

/** A JSON copy of outside data with the secret-carrying strings left out. */
const cleanCopy = (v) => scrubSecrets(clone(v));

/** A file this version can read: `v: 1` and every map an object. */
function isUsableData(d) {
  if (!isPlainObject(d) || d.v !== VERSION) return false;
  for (const key of [...VIDEO_MAPS, ...RECORD_MAPS]) {
    if (d[key] !== undefined && !isPlainObject(d[key])) return false;
  }
  return true;
}

/** Fill what a usable file lacks; every other field is kept as it was. */
function normalizeLoaded(d) {
  const out = d;
  for (const key of [...VIDEO_MAPS, ...RECORD_MAPS]) if (!isPlainObject(out[key])) out[key] = {};
  // The next lot's maps stay absent in an older file (not known); one that
  // is not a map is not read (the next sync builds it again).
  for (const key of NEXT_MAPS) if (out[key] !== undefined && !isPlainObject(out[key])) delete out[key];
  if (!Number.isInteger(out.rev) || out.rev < 0) out.rev = 0;
  if (out.server === undefined) out.server = null;
  if (out.lastSync === undefined) out.lastSync = null;
  return out;
}

function cleanOshash(v) {
  if (typeof v !== 'string') return null;
  const h = v.trim().toLowerCase();
  return OSHASH_RE.test(h) ? h : null;
}

/** A fingerprint `{size, mtimeMs, oshash}`; any unknown part is null. */
function cleanFp(fp) {
  if (!isPlainObject(fp)) return null;
  return { size: num(fp.size), mtimeMs: num(fp.mtimeMs), oshash: cleanOshash(fp.oshash) };
}

const cleanIdList = (list) => (Array.isArray(list) ? list.map(idOf).filter(Boolean) : []);

/** A count from the file (plays, O): a whole number >= 0, else null. */
const countOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Group scene order: Stash's scene_index (none last), then the scene id. */
function compareMembers(a, b) {
  const ai = Number.isSafeInteger(a.sceneIndex) ? a.sceneIndex : Infinity;
  const bi = Number.isSafeInteger(b.sceneIndex) ? b.sceneIndex : Infinity;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const na = /^\d+$/.test(a.sceneId) ? Number(a.sceneId) : NaN;
  const nb = /^\d+$/.test(b.sceneId) ? Number(b.sceneId) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.sceneId < b.sceneId ? -1 : a.sceneId > b.sceneId ? 1 : 0;
}

/**
 * Rebuild `d.groups` for ONE server (the next lot, #6) from the scenes its
 * links point at (state ok): each Group with its name and its scenes in
 * Stash's order. `updatedAt` moves only when the name or the order
 * changed; `seenAt` is this run. A Group of this server that no linked
 * scene has now is removed only when `complete` (a complete, successful
 * full sync); otherwise it is kept exactly as it was. Other servers' Groups
 * are never touched. Writes `d.groups` only when there is a Group to keep.
 *
 * @param {object} d the library data (a draft)
 * @param {string|null} serverUrl
 * @param {number} at
 * @param {{complete?: boolean}} [opts]
 */
function refreshGroups(d, serverUrl, at, { complete = false } = {}) {
  const dataServer = isPlainObject(d.server) ? str(d.server.url) : null;
  const sceneIds = new Set();
  for (const l of Object.values(isPlainObject(d.links) ? d.links : {})) {
    if (!isPlainObject(l) || !idOf(l.sceneId)) continue;
    if ((l.state ?? 'ok') !== 'ok') continue;
    if (!sameServer(str(l.server) ?? dataServer, serverUrl)) continue;
    sceneIds.add(idOf(l.sceneId));
  }
  const found = new Map(); // group id -> {name, nameAt, members}
  let known = false;       // some linked scene's record says which Groups it is in
  for (const sceneId of sceneIds) {
    const rec = isPlainObject(d.scenes) ? d.scenes[recordKey(serverUrl, sceneId)] : null;
    if (!isPlainObject(rec) || !Array.isArray(rec.groups)) continue;
    known = true;
    const recAt = Math.max(timeOf(rec.activityAt), timeOf(rec.fetchedAt));
    for (const g of rec.groups) {
      const gid = isPlainObject(g) ? groupIdOf(g.id) : null;
      const name = isPlainObject(g) ? str(g.name) : null;
      if (!gid || !name) continue;
      let entry = found.get(gid);
      if (!entry) { entry = { name, nameAt: recAt, members: [] }; found.set(gid, entry); }
      if (recAt > entry.nameAt) { entry.name = name; entry.nameAt = recAt; }
      if (!entry.members.some((m) => m.sceneId === sceneId)) {
        entry.members.push({ sceneId, sceneIndex: Number.isSafeInteger(g.sceneIndex) ? g.sceneIndex : null });
      }
    }
  }
  const groups = isPlainObject(d.groups) ? d.groups : {};
  for (const [gid, entry] of found) {
    const key = recordKey(serverUrl, gid);
    if (!key) continue;
    const order = entry.members.sort(compareMembers).map((m) => m.sceneId);
    const prev = isPlainObject(groups[key]) ? groups[key] : null;
    const same = !!prev && prev.name === entry.name && Array.isArray(prev.sceneIds)
      && prev.sceneIds.length === order.length && prev.sceneIds.every((x, i) => String(x) === order[i]);
    groups[key] = {
      id: gid,
      server: serverUrl,
      name: entry.name,
      sceneIds: order,
      updatedAt: same && Number.isFinite(prev.updatedAt) ? prev.updatedAt : at,
      seenAt: at,
    };
  }
  if (complete) {
    for (const [key, g] of Object.entries(groups)) {
      if (!isPlainObject(g)) continue;
      const own = str(g.server) ?? parseProjectedId(key)?.server ?? null;
      if (serverKey(own) !== serverKey(serverUrl)) continue;
      if (!found.has(idOf(g.id) ?? parseProjectedId(key)?.id)) delete groups[key];
    }
  }
  // Absent stays absent (not known) until a linked scene's record says.
  if (known || Object.keys(groups).length || isPlainObject(d.groups)) d.groups = groups;
}

/**
 * Keep a COMPLETE tag list of one server (stash-map.js mapTagPage's tags):
 * it replaces that server's tree, and only that server's.
 */
function storeTagTree(d, serverUrl, tags, at) {
  const out = {};
  for (const t of Array.isArray(tags) ? tags : []) {
    const id = isPlainObject(t) ? idOf(t.id) : null;
    if (!id || id.includes('@') || hasOwn(out, id) || typeof t.name !== 'string') continue;
    out[id] = {
      name: t.name,
      aliases: Array.isArray(t.aliases) ? t.aliases.filter((a) => typeof a === 'string') : [],
      parentIds: cleanIdList(t.parentIds),
    };
  }
  const trees = isPlainObject(d.tagTrees) ? d.tagTrees : {};
  trees[serverKey(serverUrl)] = { server: serverUrl, at, tags: out };
  d.tagTrees = trees;
}

/** The oshashes of a scene's files (a link's `sceneHashes`, S1RB-4), at most 50. */
function fileHashes(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const h = isPlainObject(f) ? cleanOshash(f.oshash) : null;
    if (h && !out.includes(h)) out.push(h);
    if (out.length >= 50) break;
  }
  return out;
}

// --- The renderer projection: the design's fields, nothing else ---

function projStashIds(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isPlainObject).map((s) => ({ endpoint: str(s.endpoint), stashId: str(s.stashId) }));
}

// Every id the projection hands over is stash-keys.js projectedId: raw for
// the data's own server (`current`), `<id>@<server>` for any other. `pid`
// below is that function with `current` bound.

/** The server a stored record came from: its own `server`, else the one its key names. */
function recordServer(rec, key) {
  const own = str(rec.server);
  if (own) return own;
  const parsed = parseProjectedId(key);
  return parsed ? parsed.server : null;
}

/** A record's raw Stash id: its own `id`, else the one its key starts with. */
function recordRawId(rec, key) {
  const own = idOf(rec.id);
  if (own) return parseProjectedId(own)?.id || null;
  const parsed = parseProjectedId(key);
  return parsed ? parsed.id : null;
}

function projNamed(v, srv, pid) {
  if (typeof v === 'string') return v;
  if (isPlainObject(v)) return { id: pid(srv, v.id), name: str(v.name) };
  return null;
}

const projIdList = (list, srv, pid) => cleanIdList(list).map((id) => pid(srv, id)).filter(Boolean);

function projLink(l, pid) {
  if (!isPlainObject(l) || !pid(l.server, l.sceneId)) return null;
  const out = {
    sceneId: pid(l.server, l.sceneId),
    server: str(l.server),
    by: LINK_BY.includes(l.by) ? l.by : 'oshash',
    fp: cleanFp(l.fp),
    linkedAt: num(l.linkedAt),
    state: LINK_STATES.includes(l.state) ? l.state : 'ok',
  };
  if (l.verify === true) out.verify = true;
  // The Stash scene with this id no longer holds this video's file (S1RB-4).
  if (l.sceneChanged === true && out.state === 'changed') out.sceneChanged = true;
  return out;
}

function projCheck(c, pid) {
  if (!isPlainObject(c) || !CHECK_KINDS.includes(c.kind)) return null;
  return {
    kind: c.kind, sceneIds: projIdList(c.sceneIds, c.server, pid), fp: cleanFp(c.fp), seenAt: num(c.seenAt), server: str(c.server),
  };
}

function projRefused(r, pid) {
  if (!isPlainObject(r)) return null;
  return { oshash: cleanOshash(r.oshash), sceneIds: projIdList(r.sceneIds, r.server, pid), at: num(r.at), server: str(r.server) };
}

function projScene(s, key, pid) {
  if (!isPlainObject(s)) return null;
  const srv = recordServer(s, key);
  const id = pid(srv, recordRawId(s, key));
  if (!id) return null;
  return {
    id,
    title: str(s.title),
    code: str(s.code),
    date: str(s.date),
    director: str(s.director),
    details: str(s.details),
    urls: Array.isArray(s.urls) ? s.urls.filter((u) => typeof u === 'string') : [],
    rating100: num(s.rating100),
    organized: s.organized === true,
    studioId: idOf(s.studioId) ? pid(srv, s.studioId) : null,
    performerIds: projIdList(s.performerIds, srv, pid),
    tagIds: projIdList(s.tagIds, srv, pid),
    markers: Array.isArray(s.markers) ? s.markers.filter(isPlainObject).map((m) => ({
      id: idOf(m.id) ? pid(srv, m.id) : null, title: str(m.title), seconds: num(m.seconds), endSeconds: num(m.endSeconds),
      tag: projNamed(m.tag, srv, pid),
      tags: Array.isArray(m.tags) ? m.tags.map((t) => projNamed(t, srv, pid)).filter(Boolean) : [],
    })) : [],
    stashIds: projStashIds(s.stashIds),
    files: Array.isArray(s.files) ? s.files.filter(isPlainObject).map((f) => ({
      path: str(f.path), size: num(f.size), duration: num(f.duration), oshash: cleanOshash(f.oshash),
    })) : [],
    updatedAt: str(s.updatedAt),
    fetchedAt: num(s.fetchedAt),
    server: srv,
    // The next lot: only what the record has (absent = not known).
    ...projActivity(s, srv, pid),
  };
}

/** A scene record's next-lot fields that it HAS, each checked again. */
function projActivity(s, srv, pid) {
  const out = {};
  if (hasOwn(s, 'playCount') && countOf(s.playCount) !== null) out.playCount = s.playCount;
  if (hasOwn(s, 'oCounter') && countOf(s.oCounter) !== null) out.oCounter = s.oCounter;
  if (hasOwn(s, 'lastPlayedAt')) {
    if (s.lastPlayedAt === null) out.lastPlayedAt = null;
    else if (typeof s.lastPlayedAt === 'string' && STAMP_RE.test(s.lastPlayedAt)) out.lastPlayedAt = s.lastPlayedAt;
  }
  if (hasOwn(s, 'phash')) {
    if (s.phash === null) out.phash = null;
    else if (typeof s.phash === 'string' && PHASH_RE.test(s.phash)) out.phash = s.phash;
  }
  if (Array.isArray(s.groups)) {
    out.groups = s.groups.filter(isPlainObject).map((g) => ({
      groupId: groupIdOf(g.id) ? pid(srv, g.id) : null,
      sceneIndex: Number.isSafeInteger(g.sceneIndex) ? g.sceneIndex : null,
    })).filter((g) => g.groupId);
  }
  return out;
}

/** A stored Group: {id, name, sceneIds (Stash's order), updatedAt, server}. */
function projGroup(g, key, pid) {
  if (!isPlainObject(g)) return null;
  const srv = recordServer(g, key);
  const raw = groupIdOf(recordRawId(g, key));
  const id = raw ? pid(srv, raw) : null;
  const name = str(g.name);
  if (!id || !name) return null;
  return { id, name, sceneIds: projIdList(g.sceneIds, srv, pid), updatedAt: num(g.updatedAt), server: srv };
}

function projPerformer(p, key, pid) {
  if (!isPlainObject(p)) return null;
  const id = pid(recordServer(p, key), recordRawId(p, key));
  return id ? { id, name: str(p.name), disambiguation: str(p.disambiguation), stashIds: projStashIds(p.stashIds) } : null;
}

function projStudio(s, key, pid) {
  if (!isPlainObject(s)) return null;
  const srv = recordServer(s, key);
  const id = pid(srv, recordRawId(s, key));
  if (!id) return null;
  return {
    id, name: str(s.name), parent: projNamed(s.parent, srv, pid), parentId: idOf(s.parentId) ? pid(srv, s.parentId) : null,
    stashIds: projStashIds(s.stashIds),
  };
}

function projTag(t, key, pid) {
  if (!isPlainObject(t)) return null;
  const id = pid(recordServer(t, key), recordRawId(t, key));
  return id ? { id, name: str(t.name) } : null;
}

/** Video maps (links, check, refused) stay keyed by path. */
function projMap(map, fn, pid) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const p = fn(value, pid);
    if (p) out[key] = p;
  }
  return out;
}

/** Record maps are re-keyed by the projected id. */
function projRecords(map, fn, pid) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const p = fn(value, key, pid);
    if (p) out[p.id] = p;
  }
  return out;
}

function projLastSync(ls) {
  if (!isPlainObject(ls)) return null;
  const c = isPlainObject(ls.counts) ? ls.counts : {};
  const counts = {};
  for (const k of ['linked', 'check', 'notInStash', 'gone', 'changed', 'skipped']) counts[k] = num(c[k]) ?? 0;
  return {
    at: num(ls.at),
    kind: ls.kind === 'video' ? 'video' : 'full',
    ok: ls.ok === true,
    partial: ls.partial === true,
    error: str(ls.error),
    counts,
  };
}

/**
 * The renderer's copy of the Stash data: only the fields the design lists,
 * with any `apikey=` string left out. No fingerprint cache and no key exist
 * in this module, so neither can reach the renderer through it.
 *
 * The next lot: `groups` when the file has the map (absent: not known), and
 * `tagRules` only with `{tagRules: true}` (the opt-in, decided by the
 * caller), from the tag tree of the data's own server ({aliases: {},
 * children: {}} until a sync brought one). `rulesMemo` (an object the
 * caller keeps): the rules are built again only when that tree changed
 * (sn-fixup SN-R5; see projTagRules).
 */
function buildProjection(d, { tagRules = false, rulesMemo = null } = {}) {
  const server = isPlainObject(d.server) ? { url: str(d.server.url), version: str(d.server.version) } : null;
  const current = server ? server.url : null;
  const pid = (srv, id) => projectedId(srv, idOf(id), current);
  const out = scrubSecrets({
    v: VERSION,
    rev: Number.isInteger(d.rev) ? d.rev : 0,
    server,
    lastSync: projLastSync(d.lastSync),
    links: projMap(d.links, projLink, pid),
    check: projMap(d.check, projCheck, pid),
    refused: projMap(d.refused, projRefused, pid),
    scenes: projRecords(d.scenes, projScene, pid),
    performers: projRecords(d.performers, projPerformer, pid),
    studios: projRecords(d.studios, projStudio, pid),
    tags: projRecords(d.tags, projTag, pid),
    ...(isPlainObject(d.groups) ? { groups: projRecords(d.groups, projGroup, pid) } : {}),
  });
  // Scrubbed by projTagRules itself (once per tree with a memo).
  if (tagRules === true) out.tagRules = projTagRules(d, current, rulesMemo);
  return out;
}

/**
 * The tag rules of the data's own server (stash-tag-rules.js buildTagRules).
 * The tree changes only when a sync (or an import) stores a new one, while
 * the projection is rebuilt on every change (a link, an Undo, a sync), so
 * with a `memo` the rules are built once per tree (sn-fixup, 2026-11-19,
 * SN-R5): the key is the server, the tree's `at` (when it was read) and
 * its size. Read-only: the projection is scrubbed and cloned after this.
 * The rules of a stored tree carry that key as `stamp` (a string; the
 * renderer reuses its compiled rules while it is the same,
 * stash-tags.js tagRuleSetStamp); no tree: no stamp.
 */
function projTagRules(d, current, memo = null) {
  const trees = isPlainObject(d.tagTrees) ? d.tagTrees : {};
  const tree = current ? trees[serverKey(current)] : null;
  const tags = isPlainObject(tree) && isPlainObject(tree.tags) ? tree.tags : null;
  if (!tags) return buildTagRules({});
  const key = `${serverKey(current)}|${String(tree.at)}|${Object.keys(tags).length}`;
  if (isPlainObject(memo) && memo.key === key && memo.value) return memo.value;
  const value = scrubSecrets({ ...buildTagRules(tags), stamp: key });
  if (isPlainObject(memo)) { memo.key = key; memo.value = value; memo.builds = (memo.builds || 0) + 1; }
  return value;
}

// --- Import merge (design (c) "Backups and import merge") ---

/**
 * Is `link` (of path p) a scene `refusal` refuses? The same server and the
 * scene listed, for the same file content (a link with no oshash recorded is
 * taken as that content: it cannot prove otherwise).
 */
function refusedLink(refusal, link, dataServer) {
  if (!isPlainObject(refusal) || !isPlainObject(link) || !idOf(link.sceneId)) return false;
  const srv = str(link.server) ?? dataServer;
  if (serverKey(refusal.server ?? srv) !== serverKey(srv)) return false;
  const hash = cleanOshash(link.fp?.oshash);
  if (hash && hash !== cleanOshash(refusal.oshash)) return false;
  return cleanIdList(refusal.sceneIds).includes(idOf(link.sceneId));
}

/**
 * Merge a backup's Stash data into this machine's, in place:
 * - refused: a union (same file content: the scene lists join; a refusal of
 *   other file content leaves this machine's as it is), applied FIRST;
 * - links: per video path the newer `linkedAt` wins (a tie keeps this
 *   machine's), except that a link you made or chose here beats an imported
 *   automatic one. A refusal wins over a link (S1RB-3): an imported link to a
 *   scene refused for that file content is never taken, and an automatic
 *   link here that the merged refusals cover goes (a link you made or chose
 *   here stays: it is your later word);
 * - check: this machine's (the next sync recomputes it); with
 *   `{checks: true}` (Undo of Remove) the incoming one fills a path that
 *   has neither a check nor a link here;
 * - scenes, performers, studios, tags: a union by id, the newer `fetchedAt`
 *   winning (a tie keeps this machine's);
 * - tagTrees: a union by server, the newer `at` winning;
 * - groups: NOT taken from the backup; rebuilt from the merged links and
 *   scenes (mergeGroups, sn-fixup SN-R4). `confirmSince` (an import: this
 *   machine's last full sync) holds back a Group only the backup's older
 *   scene records name;
 * - server, lastSync: this machine's (the backup's server fills an empty one).
 * An entry here that cannot be read is never overwritten. Anything else in
 * the backup's file is ignored.
 */
function mergeLibraryData(local, incoming, { checks = false, at = Date.now(), confirmSince = null } = {}) {
  const groupsBefore = new Set(isPlainObject(local.groups) ? Object.keys(local.groups) : []);
  const refused = isPlainObject(incoming.refused) ? incoming.refused : {};
  for (const [p, inc] of Object.entries(refused)) {
    if (!isPlainObject(inc)) continue;
    if (!hasOwn(local.refused, p)) { local.refused[p] = inc; continue; }
    const mine = local.refused[p];
    if (!isPlainObject(mine) || cleanOshash(mine.oshash) !== cleanOshash(inc.oshash)) continue;
    // Scene ids are per server: refusals of two servers do not join.
    if (serverKey(mine.server ?? inc.server) !== serverKey(inc.server ?? mine.server)) continue;
    const ids = cleanIdList(mine.sceneIds);
    for (const id of cleanIdList(inc.sceneIds)) if (!ids.includes(id)) ids.push(id);
    local.refused[p] = { ...mine, sceneIds: ids, at: Math.max(timeOf(mine.at), timeOf(inc.at)) };
    if (!Number.isFinite(local.refused[p].at)) delete local.refused[p].at;
  }

  const dataServer = isPlainObject(local.server) ? str(local.server.url)
    : (isPlainObject(incoming.server) ? str(incoming.server.url) : null);
  const links = isPlainObject(incoming.links) ? incoming.links : {};
  for (const [p, inc] of Object.entries(links)) {
    if (!isPlainObject(inc) || !idOf(inc.sceneId)) continue;
    // A scene refused for this file content is never brought back.
    if (refusedLink(local.refused[p], inc, dataServer)) continue;
    if (!hasOwn(local.links, p)) { local.links[p] = inc; continue; }
    const mine = local.links[p];
    if (!isPlainObject(mine)) continue;
    if (USER_BY.includes(mine.by) && !USER_BY.includes(inc.by)) continue;
    if (timeOf(inc.linkedAt) > timeOf(mine.linkedAt)) local.links[p] = inc;
  }
  // An automatic link here that a refusal (now) covers goes.
  for (const [p, mine] of Object.entries(local.links)) {
    if (isPlainObject(mine) && !USER_BY.includes(mine.by) && refusedLink(local.refused[p], mine, dataServer)) delete local.links[p];
  }

  if (checks) {
    const inChecks = isPlainObject(incoming.check) ? incoming.check : {};
    for (const [p, inc] of Object.entries(inChecks)) {
      if (isPlainObject(inc) && !hasOwn(local.check, p) && !hasOwn(local.links, p)) local.check[p] = inc;
    }
  }

  for (const key of RECORD_MAPS) {
    const map = isPlainObject(incoming[key]) ? incoming[key] : {};
    for (const [id, inc] of Object.entries(map)) {
      if (!isPlainObject(inc)) continue;
      if (!hasOwn(local[key], id)) { local[key][id] = inc; continue; }
      const mine = local[key][id];
      if (!isPlainObject(mine)) continue;
      if (timeOf(inc.fetchedAt) > timeOf(mine.fetchedAt)) local[key][id] = inc;
    }
  }

  // The tag trees: a union, the newer one (by when it was read) winning (a
  // tie keeps this machine's). The Groups are not merged (mergeGroups).
  for (const [key, stamp] of [['tagTrees', 'at']]) {
    if (!isPlainObject(incoming[key])) continue;
    if (local[key] !== undefined && !isPlainObject(local[key])) continue;
    const mineMap = isPlainObject(local[key]) ? local[key] : {};
    for (const [id, inc] of Object.entries(incoming[key])) {
      if (!isPlainObject(inc)) continue;
      const mine = mineMap[id];
      if (!hasOwn(mineMap, id) || (isPlainObject(mine) && timeOf(inc[stamp]) > timeOf(mine[stamp]))) mineMap[id] = inc;
    }
    if (Object.keys(mineMap).length) local[key] = mineMap;
  }

  if (!isPlainObject(local.server) && isPlainObject(incoming.server)) local.server = incoming.server;
  mergeGroups(local, groupsBefore, { at, since: Number.isFinite(confirmSince) ? confirmSince : -Infinity });
  return local;
}

/**
 * The Groups after a merge (sn-fixup, 2026-11-19, SN-R4). A Group is
 * derived from the linked scenes' records, so a backup's `groups` map is
 * never taken as it is: that put back a Group a complete sync here had
 * removed because it was gone in Stash. Instead this machine's Groups are
 * rebuilt from the merged links and scene records (refreshGroups for every
 * server a link names, never complete: nothing is removed). A Group this
 * machine did not have (`before`) is kept only when one of its scenes'
 * records is newer than `since` (this machine's last full sync): one that
 * only the backup's older records name waits for the next sync to find it
 * again (it may be one that sync removed). Chosen over remembering removed
 * Groups: no new stored state, and the worst case is a real Group shown one
 * sync later, never a deleted one shown again.
 */
function mergeGroups(d, before, { at, since = -Infinity } = {}) {
  const dataSrv = isPlainObject(d.server) ? str(d.server.url) : null;
  const servers = new Map();
  if (dataSrv) servers.set(serverKey(dataSrv), dataSrv);
  for (const l of Object.values(isPlainObject(d.links) ? d.links : {})) {
    const srv = isPlainObject(l) ? (str(l.server) ?? dataSrv) : null;
    if (srv && !servers.has(serverKey(srv))) servers.set(serverKey(srv), srv);
  }
  for (const srv of servers.values()) refreshGroups(d, srv, at);
  if (!isPlainObject(d.groups) || since === -Infinity) return;
  for (const [key, g] of Object.entries(d.groups)) {
    if (before.has(key) || !isPlainObject(g)) continue;
    const srv = str(g.server) ?? dataSrv;
    let newest = -Infinity;
    for (const sceneId of cleanIdList(g.sceneIds)) {
      const rec = isPlainObject(d.scenes) ? d.scenes[recordKey(srv, sceneId)] : null;
      if (isPlainObject(rec)) newest = Math.max(newest, timeOf(rec.activityAt), timeOf(rec.fetchedAt));
    }
    if (!(newest > since)) delete d.groups[key];
  }
}

/** The backup's file, the known fields only (overwrite import). */
function wholeLibraryData(incoming) {
  const out = emptyData();
  for (const key of [...VIDEO_MAPS, ...RECORD_MAPS, ...NEXT_MAPS]) if (isPlainObject(incoming[key])) out[key] = incoming[key];
  if (isPlainObject(incoming.server)) out.server = incoming.server;
  if (isPlainObject(incoming.lastSync)) out.lastSync = incoming.lastSync;
  return out;
}

// --- The file ---

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localStamp(ms) {
  const d = new Date(ms);
  return `${localDate(ms)}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const validPath = (p) => (typeof p === 'string' && p.trim() !== '' ? p : null);

/**
 * @param {object} opts
 * @param {string} opts.dir — userData/stash
 * @param {object} [opts.fsImpl] — fs.promises (tests inject failures)
 * @param {() => number} [opts.now]
 * @param {{info?: Function, warn?: Function}} [opts.log]
 * @param {number} [opts.maxBytes]
 */
function createStashLibraryFile({ dir, fsImpl = fs.promises, now = Date.now, log = console, maxBytes = MAX_BYTES } = {}) {
  if (typeof dir !== 'string' || !dir) throw new Error('createStashLibraryFile: dir is required');
  const file = path.join(dir, FILE_NAME);
  const bak = path.join(dir, BAK_NAME);
  const warn = (msg) => { try { (log.warn || log.info || (() => {})).call(log, msg); } catch { /* logging never breaks a write */ } };

  let data = emptyData();
  let state = 'unloaded'; // 'unloaded' | 'empty' | 'loaded'
  let damaged = null;     // { as, reason }: the file read at start was set aside (as: null = it could not be)
  let blocked = false;    // a file we could not read is still at library.json: never write over it
  let recovered = null;   // { from: 'library.json.bak', reason }: library.json was damaged or missing; the .bak was loaded
  let fileKnown = false;  // library.json on disk is one this session read or wrote whole (only that may become the .bak)
  let queue = Promise.resolve();
  let projection = null;
  const rulesMemo = { key: null, value: null, builds: 0 }; // projTagRules, once per tag tree (SN-R5)
  const listeners = new Set();

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.then(() => {}, () => {});
    return run;
  }

  function changed() {
    projection = null;
    for (const cb of [...listeners]) {
      try { cb(); } catch (err) { warn(`[Stash] change listener threw: ${err?.message || err}`); }
    }
  }

  async function exists(p) {
    try { await fsImpl.stat(p); return true; } catch (err) { return !(err && err.code === 'ENOENT'); }
  }

  async function safeUnlink(p) {
    try { await fsImpl.unlink(p); } catch { /* best effort */ }
  }

  async function readCurrent(target = file) {
    let stat;
    try {
      stat = await fsImpl.stat(target);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unreadable', reason: 'unreadable' };
    }
    if (typeof stat.isFile === 'function' && !stat.isFile()) return { kind: 'unreadable', reason: 'not-a-file' };
    if (stat.size > maxBytes) return { kind: 'damaged', reason: 'too-large' };
    let text;
    try {
      text = await fsImpl.readFile(target, 'utf8');
    } catch {
      return { kind: 'unreadable', reason: 'unreadable' };
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return { kind: 'damaged', reason: 'too-large' };
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      return { kind: 'damaged', reason: 'not-json' };
    }
    if (!isUsableData(parsed)) return { kind: 'damaged', reason: 'wrong-shape' };
    return { kind: 'ok', data: normalizeLoaded(parsed) };
  }

  /** library.json → library.damaged-<date>[-n].json. Null when it could not be moved. */
  async function moveAside() {
    const stamp = localDate(now());
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? `library.damaged-${stamp}.json` : `library.damaged-${stamp}-${i}.json`;
      const target = path.join(dir, name);
      if (await exists(target)) continue;
      try {
        await fsImpl.rename(file, target);
        return name;
      } catch (err) {
        warn(`[Stash] Could not move the damaged library.json aside: ${err?.message || err}`);
        return null;
      }
    }
    return null;
  }

  async function writeSynced(target, text) {
    const fh = await fsImpl.open(target, 'w');
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /**
   * Atomic write with one backup: the new text goes to a synced .tmp, the
   * current file is copied to .bak.tmp, the .tmp is renamed over
   * library.json, and only then does .bak.tmp become .bak. A failure before
   * the rename leaves library.json and library.json.bak as they were.
   */
  async function writeAtomic(text) {
    await fsImpl.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    const bakTmp = `${bak}.tmp`;
    try {
      await writeSynced(tmp, text);
    } catch (err) {
      await safeUnlink(tmp);
      throw err;
    }
    let haveOld = false;
    try {
      // Only a library.json this session read or wrote whole replaces the
      // .bak (S1RB-2): after a damaged or missing load the .bak is the last
      // good copy until this session has written library.json itself.
      if (!fileKnown) throw Object.assign(new Error('not a known file'), { code: 'ENOENT' });
      await fsImpl.copyFile(file, bakTmp);
      haveOld = true;
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) {
        // No copy of the current file, no replacing it.
        await safeUnlink(tmp);
        await safeUnlink(bakTmp);
        throw err;
      }
    }
    try {
      await fsImpl.rename(tmp, file);
    } catch (err) {
      await safeUnlink(tmp);
      if (haveOld) await safeUnlink(bakTmp);
      throw err;
    }
    if (haveOld) {
      try {
        await fsImpl.rename(bakTmp, bak);
      } catch (err) {
        warn(`[Stash] Could not keep library.json.bak: ${err?.message || err}`);
        await safeUnlink(bakTmp);
      }
    }
  }

  /**
   * Run `mutator` on a copy of the data and write the copy once. The copy
   * becomes the data only after the write succeeded, so memory and disk
   * never part. The mutator returns `{ok: false, error}` to change nothing,
   * `{write: false}` when nothing changed, or extra result fields.
   *
   * origin 'user': refused while the file read at start is damaged (the
   * empty copy waits for a sync) or could not be read. 'sync' and 'import'
   * store real data, so they may write once a damaged file is set aside.
   */
  function update(mutator, { origin = 'user' } = {}) {
    return enqueue(() => applyNow(mutator, origin));
  }

  /** update()'s body, for a caller already in the queue. */
  async function applyNow(mutator, origin) {
    if (state === 'unloaded') return { ok: false, error: 'not-loaded' };
    if (blocked) return { ok: false, error: 'damaged' };
    // The empty copy after a damage waits for a sync; a copy recovered
    // from the .bak is real data, so your own changes may be written.
    if (damaged && !recovered && origin === 'user') return { ok: false, error: 'damaged' };
    const draft = clone(data);
    let result;
    try {
      result = mutator(draft) || {};
    } catch (err) {
      warn(`[Stash] Could not apply a change: ${err?.message || err}`);
      return { ok: false, error: 'failed' };
    }
    if (result.ok === false) return result;
    if (result.write === false) {
      const { write: _skip, ...rest } = result;
      return { ok: true, written: false, rev: data.rev, ...rest };
    }
    draft.rev = (Number.isInteger(data.rev) ? data.rev : 0) + 1;
    const text = JSON.stringify(draft);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      // Never write a file the next start would refuse (and set aside).
      warn('[Stash] The Stash data would pass the size limit; nothing was written');
      return { ok: false, error: 'too-large' };
    }
    try {
      await writeAtomic(text);
    } catch (err) {
      warn(`[Stash] Could not write library.json: ${err?.message || err}`);
      return { ok: false, error: 'write-failed' };
    }
    data = draft;
    state = 'loaded';
    fileKnown = true;
    if (origin !== 'user') damaged = null;
    changed();
    return { ok: true, written: true, rev: data.rev, ...result };
  }

  /** The exact before-state of one video's entries, for Undo. */
  function undoEntry(d, p) {
    const out = { path: p };
    for (const key of VIDEO_MAPS) out[key] = hasOwn(d[key], p) ? clone(d[key][p]) : null;
    return out;
  }

  // --- Public API ---

  /** Read the file once at start. Never writes, except moving a damaged file aside. */
  function load() {
    return enqueue(async () => {
      const got = await readCurrent();
      damaged = null;
      blocked = false;
      recovered = null;
      fileKnown = false;
      if (got.kind === 'ok') {
        data = got.data;
        state = 'loaded';
        fileKnown = true;
      } else if (got.kind === 'missing') {
        data = emptyData();
        state = 'empty';
        await recoverFromBak('missing');
      } else if (got.kind === 'unreadable') {
        data = emptyData();
        state = 'empty';
        damaged = { as: null, reason: got.reason };
        blocked = true;
        warn(`[Stash] library.json could not be read (${got.reason}); it is left as it is and nothing is written this session`);
      } else {
        const as = await moveAside();
        data = emptyData();
        state = 'empty';
        damaged = { as, reason: got.reason };
        blocked = !as;
        warn(`[Stash] library.json was damaged (${got.reason}); ${as ? `kept aside as ${as}` : 'it could not be moved aside and is left as it is'}`);
        if (as) await recoverFromBak(got.reason);
      }
      changed();
      return status();
    });
  }

  /**
   * library.json is damaged (and set aside) or missing: load the previous
   * copy, library.json.bak, when it is a usable file. Nothing is written;
   * state stays 'empty' (no library.json) until the next write, which
   * leaves the .bak as it is (fileKnown is false).
   */
  async function recoverFromBak(reason) {
    const got = await readCurrent(bak);
    if (got.kind !== 'ok') return;
    data = got.data;
    recovered = { from: BAK_NAME, reason };
    warn(`[Stash] library.json was ${reason === 'missing' ? 'missing' : 'damaged'}; the previous copy (${BAK_NAME}) is used`);
  }

  function status() {
    return {
      state,
      rev: Number.isInteger(data.rev) ? data.rev : 0,
      damaged: damaged ? { ...damaged } : null,
      recovered: recovered ? { ...recovered } : null,
      writable: state !== 'unloaded' && !blocked,
      server: isPlainObject(data.server) ? { url: str(data.server.url), version: str(data.server.version) } : null,
      lastSync: projLastSync(data.lastSync),
      counts: {
        links: Object.keys(data.links || {}).length,
        check: Object.keys(data.check || {}).length,
        refused: Object.keys(data.refused || {}).length,
        scenes: Object.keys(data.scenes || {}).length,
      },
    };
  }

  /** A deep copy of the stored data, for main-process readers (the sync job). */
  function snapshot() {
    return clone(data);
  }

  /**
   * The renderer's copy (see buildProjection). Cached until the next change.
   * `{tagRules: true}`: with the tag rules (the caller checked the opt-in).
   */
  function getProjection({ tagRules = false } = {}) {
    const withRules = tagRules === true;
    if (!projection || projection.withRules !== withRules) {
      projection = { withRules, value: buildProjection(data, { tagRules: withRules, rulesMemo }) };
    }
    return clone(projection.value);
  }

  /**
   * The projection changes without the data changing (the tag-rules opt-in
   * was switched): `rev` moves on in memory and the change listeners hear
   * it, so a renderer that skips a `rev` it has asks again. Nothing is
   * written; the next write continues from this `rev`.
   */
  function touch() {
    return enqueue(async () => {
      if (state === 'unloaded') return { ok: false, error: 'not-loaded' };
      data.rev = (Number.isInteger(data.rev) ? data.rev : 0) + 1;
      changed();
      return { ok: true, rev: data.rev };
    });
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }

  /**
   * Store mapped Stash records: `{scene, performers[], studios[] | studio,
   * tags[]}` (electron/stash-map.js). Each is stored under its server and id
   * (stash-keys.js recordKey), with `fetchedAt` and the server it came from.
   */
  function storeRecords(d, mapped, at, serverUrl) {
    const clean = cleanCopy(mapped);
    if (!isPlainObject(clean) || !isPlainObject(clean.scene) || !idOf(clean.scene.id)) return null;
    const id = idOf(clean.scene.id);
    const server = str(serverUrl) ?? str(clean.scene.server);
    const sceneKey = recordKey(server, id);
    if (!sceneKey) return null;
    d.scenes[sceneKey] = { ...clean.scene, id, fetchedAt: at, server };
    const studios = Array.isArray(clean.studios) ? clean.studios : (isPlainObject(clean.studio) ? [clean.studio] : []);
    for (const [key, list] of [['performers', clean.performers], ['studios', studios], ['tags', clean.tags]]) {
      for (const rec of Array.isArray(list) ? list : []) {
        const rid = isPlainObject(rec) ? idOf(rec.id) : null;
        const rkey = rid ? recordKey(server, rid) : null;
        if (rkey) d[key][rkey] = { ...rec, id: rid, fetchedAt: at, server };
      }
    }
    return id;
  }

  /** The server a projected id names (null: the data's own), resolved against `entryServer`. */
  function resolveId(value, entryServer) {
    const parsed = parseProjectedId(value);
    if (!parsed || !idOf(parsed.id)) return null;
    if (parsed.server && parsed.server !== serverKey(entryServer)) return null;
    return parsed.id;
  }

  /**
   * Rebuild the Groups (refreshGroups, never complete: nothing is removed)
   * of every server these link entries name (null: the data's own), after
   * a user action changed which scenes are linked (sn-fixup, 2026-11-19,
   * SN-R3: unlink, refuse, restore; link and choose did already). A Group
   * then lists only scenes a video is linked to now; one with no linked
   * scene left stays stored (the renderer hides it) until a complete sync.
   */
  function regroup(d, ...entries) {
    const dataSrv = isPlainObject(d.server) ? str(d.server.url) : null;
    const done = new Set();
    for (const e of entries) {
      const srv = (isPlainObject(e) ? str(e.server) : null) ?? dataSrv;
      if (!srv || done.has(serverKey(srv))) continue;
      done.add(serverKey(srv));
      refreshGroups(d, srv, now());
    }
  }

  /**
   * Find in Stash…: link a video to a scene by hand (`by: 'manual'`).
   * `records` are the picked scene's mapped records. A refusal of that scene
   * for this video is lifted (your explicit choice). Returns `{undo}`.
   */
  function link(videoPath, { sceneId, fp, server } = {}, records = null) {
    const p = validPath(videoPath);
    const id = idOf(sceneId);
    if (!p || !id || id.includes('@')) return Promise.resolve({ ok: false, error: 'bad-input' });
    return update((d) => {
      const undo = undoEntry(d, p);
      const srv = str(server) ?? (isPlainObject(d.server) ? str(d.server.url) : null);
      // The first data stored names the server the data belongs to.
      if (!isPlainObject(d.server) && srv) d.server = { url: srv, version: null };
      if (records) storeRecords(d, records, now(), srv);
      const sceneHashes = fileHashes(isPlainObject(records) && isPlainObject(records.scene) ? records.scene.files : null);
      d.links[p] = {
        sceneId: id,
        server: srv,
        by: 'manual',
        fp: cleanFp(fp),
        linkedAt: now(),
        state: 'ok',
        ...(sceneHashes.length ? { sceneHashes } : {}),
      };
      delete d.check[p];
      if (records) refreshGroups(d, srv, now());
      const r = d.refused[p];
      if (isPlainObject(r) && serverKey(r.server ?? srv) === serverKey(srv)
          && Array.isArray(r.sceneIds) && r.sceneIds.map(String).includes(id)) {
        const rest = r.sceneIds.filter((x) => String(x) !== id);
        if (rest.length) d.refused[p] = { ...r, sceneIds: rest };
        else delete d.refused[p];
      }
      return { undo };
    });
  }

  /**
   * "Use this scene" / "Use it anyway": one of the video's check candidates
   * (`by: 'chosen'`). `sceneId` as the projection gave it.
   */
  function choose(videoPath, sceneId) {
    const p = validPath(videoPath);
    if (!p || !idOf(sceneId)) return Promise.resolve({ ok: false, error: 'bad-input' });
    return update((d) => {
      const c = d.check[p];
      if (!isPlainObject(c)) return { ok: false, error: 'not-a-candidate' };
      const srv = str(c.server) ?? (isPlainObject(d.server) ? str(d.server.url) : null);
      const id = resolveId(sceneId, srv);
      if (!id || !cleanIdList(c.sceneIds).includes(id)) return { ok: false, error: 'not-a-candidate' };
      const undo = undoEntry(d, p);
      const rec = d.scenes[recordKey(srv, id)];
      const sceneHashes = fileHashes(isPlainObject(rec) ? rec.files : null);
      d.links[p] = {
        sceneId: id,
        server: srv,
        by: 'chosen',
        fp: cleanFp(c.fp),
        linkedAt: now(),
        state: 'ok',
        ...(sceneHashes.length ? { sceneHashes } : {}),
      };
      delete d.check[p];
      if (isPlainObject(rec) && Array.isArray(rec.groups)) refreshGroups(d, srv, now());
      return { undo };
    });
  }

  /**
   * "Not this scene" (target 'link': the linked scene) or "None of these" /
   * "Ignore" (target 'check': every candidate). The refusal stores the file
   * content's oshash, so a changed file can be offered again. A link to a
   * refused scene goes; a check whose candidates are all refused goes.
   *
   * `sceneId` (a projected id) is the scene the confirm NAMED (RA-S1-3).
   * When the link changed meanwhile, only that scene is refused (for this
   * file's content) and the current link is left exactly as it is; the
   * result says `linkChanged` and the scene linked now. `oshash` is the
   * file's content hashed by main now, used only when the entry has none
   * (a Find in Stash… link made while hashing failed).
   */
  function refuse(videoPath, { target, sceneId = null, oshash: hashNow = null } = {}) {
    const p = validPath(videoPath);
    if (!p) return Promise.resolve({ ok: false, error: 'bad-input' });
    const named = sceneId === null || sceneId === undefined ? null : parseProjectedId(sceneId);
    if ((sceneId !== null && sceneId !== undefined) && (!named || !idOf(named.id) || target === 'check')) {
      return Promise.resolve({ ok: false, error: 'bad-input' });
    }
    return update((d) => {
      const l = isPlainObject(d.links[p]) ? d.links[p] : null;
      const c = isPlainObject(d.check[p]) ? d.check[p] : null;
      const dataSrv = isPlainObject(d.server) ? str(d.server.url) : null;
      const which = named ? 'link' : (target === 'link' || target === 'check' ? target : (l ? 'link' : 'check'));
      let src = which === 'link' ? l : c;
      let sceneIds = null;
      let srv = null;
      let linkChanged = false;
      if (named) {
        const namedKey = named.server || serverKey(dataSrv);
        const lSrv = l ? (str(l.server) ?? dataSrv) : null;
        if (!(l && idOf(l.sceneId) === named.id && serverKey(lSrv) === namedKey)) {
          // Changed under the confirm: refuse only the scene it named.
          linkChanged = true;
          src = l || c;
          if (!src) return { ok: false, error: 'changed-since' };
          sceneIds = [named.id];
          const cSrv = c ? (str(c.server) ?? dataSrv) : null;
          srv = [lSrv, cSrv, dataSrv].find((x) => x && serverKey(x) === namedKey) ?? (named.server || dataSrv);
        }
      }
      if (!src) return { ok: false, error: 'nothing-to-refuse' };
      if (!sceneIds) sceneIds = which === 'link' ? cleanIdList([src.sceneId]) : cleanIdList(src.sceneIds);
      const oshash = cleanOshash(src.fp?.oshash) || cleanOshash(hashNow);
      if (!oshash || sceneIds.length === 0) return { ok: false, error: 'no-fingerprint' };
      // A refusal is about one server's scenes (ids are unique per server).
      if (!srv) srv = str(src.server) ?? dataSrv;
      const undo = undoEntry(d, p);
      const prev = d.refused[p];
      const samePrev = isPlainObject(prev) && cleanOshash(prev.oshash) === oshash && serverKey(prev.server ?? srv) === serverKey(srv);
      const ids = samePrev ? cleanIdList(prev.sceneIds) : [];
      for (const id of sceneIds) if (!ids.includes(id)) ids.push(id);
      d.refused[p] = { oshash, sceneIds: ids, at: now(), server: srv };
      const sameSrv = (e) => serverKey(e.server ?? srv) === serverKey(srv);
      // A link that changed under the confirm is left as it is.
      if (!linkChanged && l && sameSrv(l) && ids.includes(idOf(l.sceneId))) {
        delete d.links[p];
        regroup(d, l);
      }
      if (c && sameSrv(c) && cleanIdList(c.sceneIds).every((id) => ids.includes(id))) delete d.check[p];
      if (!linkChanged) return { undo };
      return { undo, linkChanged: true, linkedSceneId: l ? projectedId(l.server, idOf(l.sceneId), dataSrv) : null };
    });
  }

  /**
   * Unlink (a gone scene, or any link). Returns `{undo}`. With `sceneId`
   * (the scene the page showed, projected), a link that names another scene
   * now is left alone: 'changed-since'.
   */
  function unlink(videoPath, { sceneId = null } = {}) {
    const p = validPath(videoPath);
    if (!p) return Promise.resolve({ ok: false, error: 'bad-input' });
    const named = sceneId === null || sceneId === undefined ? null : parseProjectedId(sceneId);
    if ((sceneId !== null && sceneId !== undefined) && (!named || !idOf(named.id))) return Promise.resolve({ ok: false, error: 'bad-input' });
    return update((d) => {
      if (!hasOwn(d.links, p)) return { ok: false, error: 'not-linked' };
      if (named) {
        const l = isPlainObject(d.links[p]) ? d.links[p] : null;
        const dataSrv = isPlainObject(d.server) ? str(d.server.url) : null;
        const same = l && idOf(l.sceneId) === named.id && serverKey(str(l.server) ?? dataSrv) === (named.server || serverKey(dataSrv));
        if (!same) return { ok: false, error: 'changed-since' };
      }
      const undo = undoEntry(d, p);
      const gone = d.links[p];
      delete d.links[p];
      regroup(d, gone);
      return { undo };
    });
  }

  /**
   * Undo: put one video's link, check and refusal back exactly as `undo`
   * (from link / choose / refuse / unlink / a sync's re-link) holds them;
   * null means "there was none".
   */
  function restore(undo) {
    const p = isPlainObject(undo) ? validPath(undo.path) : null;
    if (!p) return Promise.resolve({ ok: false, error: 'bad-input' });
    for (const key of VIDEO_MAPS) {
      if (hasOwn(undo, key) && undo[key] !== null && !isPlainObject(undo[key])) return Promise.resolve({ ok: false, error: 'bad-input' });
    }
    return update((d) => {
      const linkBefore = d.links[p];
      for (const key of VIDEO_MAPS) {
        if (!hasOwn(undo, key)) continue;
        if (undo[key] === null) delete d[key][p];
        else d[key][p] = cleanCopy(undo[key]);
      }
      if (hasOwn(undo, 'links')) regroup(d, linkBefore, d.links[p]);
      return {};
    });
  }

  /**
   * Scan-time re-home (`stash-rehome`): `[{from, to, keepSource}]` from the
   * same plan as the video's other tag data. The link, check and refusal
   * move together; the link is marked `verify: true` (re-hashed and
   * confirmed at the next sync). A destination that already has Stash data
   * is never overwritten; `keepSource` keeps the original (absence unproven).
   * One write for the whole list.
   */
  function rehome(moves) {
    const list = (Array.isArray(moves) ? moves : [])
      .filter((m) => isPlainObject(m) && validPath(m.from) && validPath(m.to) && m.from !== m.to);
    if (list.length === 0) return Promise.resolve({ ok: true, moved: 0, written: false });
    return update((d) => {
      let moved = 0;
      for (const { from, to, keepSource } of list) {
        if (!VIDEO_MAPS.some((k) => hasOwn(d[k], from))) continue;
        if (VIDEO_MAPS.some((k) => hasOwn(d[k], to))) continue;
        for (const k of VIDEO_MAPS) {
          if (!hasOwn(d[k], from)) continue;
          const entry = clone(d[k][from]);
          if (k === 'links' && isPlainObject(entry)) entry.verify = true;
          d[k][to] = entry;
          if (!keepSource) delete d[k][from];
        }
        moved++;
      }
      return moved ? { moved } : { write: false, moved: 0 };
    });
  }

  /** The sync job's one write (electron/stash-sync.js). */
  function applySync(mutator) {
    return update(mutator, { origin: 'sync' });
  }

  /** Import, merge mode (see mergeLibraryData). */
  function mergeImported(imported) {
    if (!isUsableData(imported)) return Promise.resolve({ ok: false, error: 'not-stash-data' });
    const incoming = cleanCopy(imported);
    return update((d) => {
      // This machine's last full sync: a Group only older records name waits for the next one (SN-R4).
      const ls = isPlainObject(d.lastSync) ? d.lastSync : null;
      const confirmSince = ls && ls.kind === 'full' && Number.isFinite(ls.at) ? ls.at : null;
      mergeLibraryData(d, incoming, { at: now(), confirmSince });
      return {};
    }, { origin: 'import' });
  }

  /** Import, overwrite mode: the backup's file replaces this one (the old one becomes .bak). */
  function replaceImported(imported) {
    if (!isUsableData(imported)) return Promise.resolve({ ok: false, error: 'not-stash-data' });
    const incoming = wholeLibraryData(cleanCopy(imported));
    return update((d) => {
      for (const key of Object.keys(d)) delete d[key];
      Object.assign(d, incoming);
      return {};
    }, { origin: 'import' });
  }

  /**
   * Remove Stash data…: library.json and its .bak are moved aside as
   * library.removed-<stamp>.json(.bak); the data in memory is empty.
   * `undoRemove(undo)` puts them back (when nothing new was written since),
   * `discardRemoved(undo)` deletes the set-aside files once Undo has passed.
   */
  function removeAll() {
    return enqueue(async () => {
      const stamp = localStamp(now());
      const removed = {};
      for (const [src, key, name] of [[file, 'file', `library.removed-${stamp}.json`], [bak, 'bak', `library.removed-${stamp}.json.bak`]]) {
        if (!(await exists(src))) continue;
        try {
          await fsImpl.rename(src, path.join(dir, name));
          removed[key] = name;
        } catch (err) {
          warn(`[Stash] Could not remove the Stash data: ${err?.message || err}`);
          if (removed.file) { try { await fsImpl.rename(path.join(dir, removed.file), file); } catch { /* left aside, named */ } }
          return { ok: false, error: 'remove-failed' };
        }
      }
      const rev = (Number.isInteger(data.rev) ? data.rev : 0) + 1;
      data = emptyData();
      data.rev = rev;
      state = 'empty';
      damaged = null;
      blocked = false;
      recovered = null;
      fileKnown = false;
      changed();
      return { ok: true, undo: { removed } };
    });
  }

  function removedNames(undo) {
    const r = isPlainObject(undo) && isPlainObject(undo.removed) ? undo.removed : {};
    const out = {};
    for (const key of ['file', 'bak']) {
      if (typeof r[key] === 'string' && REMOVED_NAME_RE.test(r[key])) out[key] = r[key];
    }
    return out;
  }

  /**
   * Undo of Remove Stash data. When nothing was written since, the set-aside
   * files go back as they were. When something was (a sync, a re-home), the
   * removed data is merged into the current data (mergeLibraryData, with its
   * checks), so neither is lost, and the set-aside files are deleted only
   * after that write. A failure leaves every file where it is.
   */
  function undoRemove(undo) {
    const names = removedNames(undo);
    return enqueue(async () => {
      if (await exists(file)) {
        if (!names.file) return { ok: false, error: 'changed-since' };
        const got = await readCurrent(path.join(dir, names.file));
        if (got.kind !== 'ok') return { ok: false, error: 'changed-since' };
        const incoming = cleanCopy(got.data);
        const res = await applyNow((d) => { mergeLibraryData(d, incoming, { checks: true, at: now() }); return {}; }, 'import');
        if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'restore-failed' };
        for (const name of Object.values(names)) await safeUnlink(path.join(dir, name));
        return { ok: true, merged: true };
      }
      const movedBack = [];
      try {
        if (names.file) { await fsImpl.rename(path.join(dir, names.file), file); movedBack.push([names.file, file]); }
        if (names.bak && !(await exists(bak))) { await fsImpl.rename(path.join(dir, names.bak), bak); movedBack.push([names.bak, bak]); }
      } catch (err) {
        warn(`[Stash] Could not put the Stash data back: ${err?.message || err}`);
        // Back where they were set aside, so a second Undo finds them.
        for (const [name, from] of movedBack.reverse()) { try { await fsImpl.rename(from, path.join(dir, name)); } catch { /* left in place, named */ } }
        return { ok: false, error: 'restore-failed' };
      }
      const got = await readCurrent();
      if (got.kind === 'ok') {
        const rev = Math.max(Number.isInteger(data.rev) ? data.rev : 0, got.data.rev) + 1;
        data = got.data;
        data.rev = rev;
        state = 'loaded';
        fileKnown = true;
        recovered = null;
      }
      changed();
      return { ok: true };
    });
  }

  function discardRemoved(undo) {
    const names = removedNames(undo);
    return enqueue(async () => {
      for (const name of Object.values(names)) await safeUnlink(path.join(dir, name));
      return { ok: true };
    });
  }

  /** Wait for every queued write (FunSync closing). */
  function idle() {
    return enqueue(async () => {});
  }

  return {
    file,
    load,
    status,
    snapshot,
    projection: getProjection,
    /** How many times the tag rules were built (tests: once per tag tree, SN-R5). */
    tagRuleBuilds: () => rulesMemo.builds,
    touch,
    onChange,
    link,
    choose,
    refuse,
    unlink,
    restore,
    rehome,
    applySync,
    mergeImported,
    replaceImported,
    removeAll,
    undoRemove,
    discardRemoved,
    idle,
  };
}

module.exports = {
  FILE_NAME,
  BAK_NAME,
  MAX_BYTES,
  VERSION,
  createStashLibraryFile,
  emptyData,
  isUsableData,
  scrubSecrets,
  buildProjection,
  mergeLibraryData,
  cleanFp,
  cleanOshash,
  fileHashes,
  refreshGroups,
  storeTagTree,
};
