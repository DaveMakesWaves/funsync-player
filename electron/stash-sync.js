// StashSync — the user-started Stash sync job (S1), Electron main.
//
// notes/features/DESIGN-stash-s1.md (a) step 5, (b) and (e). Four steps:
//   1. hash   — each library video's oshash (the fingerprint cache reads
//               only new or changed files); a video that cannot be read
//               (offline drive, 8 bytes or less, a read error) is skipped;
//   2. list   — Stash's light scene list, page by page;
//   3. match  — on this PC, no request (electron/stash-match.js);
//   4. details — only for matched scenes that are new or changed since the
//               last sync, one batch of ids at a time through aliased
//               `findScene` (a list query by ids fails WHOLE on one deleted
//               scene, checked 2026-11-18);
// then ONE write of library.json.
//
// Partial-sync rules (e): a failed or partial sync NEVER removes or clears
// anything.
//   - A failure or Cancel before the scene list is complete writes nothing
//     (library.json stays byte for byte).
//   - After the list: the details batches that finished are written, with
//     `lastSync.partial: true`; a link or check whose scene has no data yet
//     waits for the next sync (the video keeps what it had).
//   - "Gone" is decided only from a complete list (every page, and the ids
//     seen add up to the count Stash gave on the first and the last page),
//     or for one scene that Stash answered "not found" for by id.
//   - Scenes, people, studios and tags nothing points to are dropped only at
//     the end of a complete, successful full sync.
//   - A link you made or chose is never replaced by automatic matching, a
//     scene you refused for this file content is never linked, and nothing
//     the matcher leaves out is removed: this file checks all three again at
//     commit time against the newest data, so a choice made while the sync
//     ran is kept too. The refusal guard covers EXISTING links as well
//     (s1-fixup-main, S1RB-3): an automatic link to a scene refused for the
//     file's content (an import brought it back) goes.
//   - A scene that is no longer the one a link was made for (a Stash reset
//     at the same address reuses ids, S1RB-4; stash-match.js sceneChanged)
//     keeps its old record: its new details are not fetched or stored for
//     that link, and the link is marked changed even without data.
//
// It only runs when called: there is no timer and nothing on start-up,
// except main's "Sync with Stash when FunSync starts" (shouldSyncOnStart).
//
// The collaborators are injected (Round 1 builds them in parallel):
//   client.listScenes({page, perPage, signal})
//     → {count, scenes: [{id, updatedAt, files: [{path, size, oshash}]}]}
//   client.sceneDetails(ids, {signal})       (aliased findScene, ≤ batchSize ids)
//     → {[id]: rawScene | null}               null = Stash says no such scene
//   client.scenesByOshash(oshash, {signal})  (Sync this video: EVERY scene with
//     a file of this oshash) → {count, scenes: [light scenes]}
//   fingerprint({path, size, mtimeMs}, {signal}) → {size, mtimeMs, oshash} | null
//   saveFingerprints() → Promise (optional; the cache file, derived data)
//   match({videos, scenes, complete, goneIds, links, check, refused,
//          storedScenes, pathRules, server, now, skipped})
//     → {links: {[path]: link}, check: {[path]: entry}}  (library.json shapes;
//        electron/stash-match.js matchLibrary returns the whole maps)
//   mapScene(rawScene, {now}) → {scene, performers[], studios[] | studio, tags[]}
// (Checked 2026-11-18 against the Round 1 modules as they landed:
// stash-client.js createStashClient, stash-fingerprint.js
// createFingerprinter().fingerprint, stash-match.js matchLibrary,
// stash-map.js mapScene.)
// Every client error should carry `code` (the reason words in (e)); the
// job passes it on and never stores a message.
//
// The "next" lot (2026-11-19, appendix (j) #2, #5, #6, #10; read-only):
//   - The light list also carries what changes in Stash WITHOUT the scene's
//     `updated_at` changing (plays, last play, O-count, Groups and their
//     names, the primary file's phash). A full sync writes those onto every
//     stored scene of this server it listed, so they are fresh although the
//     details are fetched again only for changed scenes.
//   - A full sync also reads Stash's tag list (client.listTags, paged) when
//     the client has it. Only a COMPLETE list replaces the stored tag tree;
//     a failed or partial one changes nothing and never fails the sync
//     (the result says `tags: {ok: false, ...}`).
//   - Groups are rebuilt at every commit (stash-library-file.js
//     refreshGroups); a Group is removed only by a complete, successful full
//     sync, like any other removal here.
//   - Cancel is honoured up to the write (sn-fixup, 2026-11-19, SN-R2): a
//     Cancel pressed while the tag list is read, or while the write waits
//     its turn, makes the run a cancelled, partial one (what finished is
//     written; nothing is removed, no check cleared, no Group dropped) and
//     it is never reported as a success.
//   - A tag whose name FunSync cannot use (over 200 characters, a lone
//     surrogate, "apikey=") is left out of the tag tree, logged once per
//     session; its id still counts, so the list stays complete (sn-fixup,
//     the review's note). A tag with an id that cannot be read still makes
//     the list incomplete.

'use strict';

const { scrubSecrets, refreshGroups, storeTagTree } = require('./stash-library-file');
const { serverKey, sameServer, recordKey } = require('./stash-keys');
const { mapSceneActivity, mapTagPage, tagListComplete } = require('./stash-map');
const { MAX_TAGS } = require('./stash-tag-rules');

const USER_BY = Object.freeze(['manual', 'chosen']);
const DEFAULT_PER_PAGE = 1000;
const DEFAULT_BATCH_SIZE = 50;
const OSHASH_RE = /^[0-9a-f]{16}$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const idOf = (v) => ((typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cleanOshash(v) {
  if (typeof v !== 'string') return null;
  const h = v.trim().toLowerCase();
  return OSHASH_RE.test(h) ? h : null;
}

/**
 * "Sync with Stash when FunSync starts": only when Stash is linked and on
 * and the setting is on. Anything missing or of the wrong type is off.
 */
function shouldSyncOnStart(stash) {
  return isPlainObject(stash)
    && stash.enabled === true
    && stash.syncOnStart === true
    && typeof stash.url === 'string'
    && stash.url.trim() !== '';
}

function errorInfo(err, signal) {
  if (signal && signal.aborted) return { code: 'cancelled' };
  const code = err && typeof err.code === 'string' && CODE_RE.test(err.code) ? err.code : 'failed';
  return { code };
}

/** The library's videos, one per path. */
function normalizeVideos(videos) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(videos) ? videos : []) {
    const p = isPlainObject(v) ? v.path : v;
    if (typeof p !== 'string' || p.trim() === '' || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, size: isPlainObject(v) ? num(v.size) : null, mtimeMs: isPlainObject(v) ? num(v.mtimeMs) : null });
  }
  return out;
}

function normalizeListed(s) {
  const id = isPlainObject(s) ? idOf(s.id) : null;
  if (!id) return null;
  const files = Array.isArray(s.files) ? s.files.filter(isPlainObject).map((f) => ({
    path: typeof f.path === 'string' ? f.path : null,
    size: num(f.size),
    oshash: cleanOshash(f.oshash),
  })) : [];
  const updatedAt = typeof s.updatedAt === 'string' ? s.updatedAt : (typeof s.updated_at === 'string' ? s.updated_at : null);
  return { id, updatedAt, files };
}

function cleanRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => isPlainObject(r) && typeof r.local === 'string' && typeof r.stash === 'string')
    .map((r) => ({ local: r.local, stash: r.stash }));
}

function isRefused(refusal, sceneId, oshash, server) {
  if (!isPlainObject(refusal) || !oshash) return false;
  if (cleanOshash(refusal.oshash) !== oshash) return false;
  // Scene ids are per server: a refusal on another Stash refuses nothing here.
  if (!sameServer(refusal.server, server)) return false;
  return Array.isArray(refusal.sceneIds) && refusal.sceneIds.map(String).includes(sceneId);
}

function cleanLinkCandidate(l) {
  if (!isPlainObject(l)) return null;
  const sceneId = idOf(l.sceneId);
  if (!sceneId) return null;
  return { ...clone(l), sceneId };
}

function cleanCheckCandidate(c) {
  if (!isPlainObject(c) || (c.kind !== 'several' && c.kind !== 'pathChanged')) return null;
  const sceneIds = Array.isArray(c.sceneIds) ? c.sceneIds.map(idOf).filter(Boolean) : [];
  if (sceneIds.length === 0) return null;
  return { ...clone(c), sceneIds };
}

/**
 * Scene ids the matcher's answer for these videos points at (links and check
 * candidates). A link whose scene changed under it (sceneChanged) wants no
 * new details: its old record is kept.
 */
function wantedSceneIds(paths, matched) {
  const out = new Set();
  for (const p of paths) {
    const l = isPlainObject(matched.links) ? matched.links[p] : null;
    if (isPlainObject(l) && idOf(l.sceneId) && l.sceneChanged !== true) out.add(idOf(l.sceneId));
    const c = isPlainObject(matched.check) ? matched.check[p] : null;
    if (isPlainObject(c) && Array.isArray(c.sceneIds)) for (const id of c.sceneIds) if (idOf(id)) out.add(idOf(id));
  }
  return out;
}

/**
 * Scenes nothing points to, and the people, studios and tags no scene points
 * to, go. Records are keyed by server and id (stash-keys.js recordKey); an
 * entry with no server recorded belongs to `serverUrl` (the one synced).
 */
function pruneUnreferenced(d, serverUrl = null) {
  const own = (e) => (typeof e.server === 'string' && e.server ? e.server : serverUrl);
  const sceneRefs = new Set();
  for (const l of Object.values(d.links)) {
    if (isPlainObject(l) && idOf(l.sceneId)) sceneRefs.add(recordKey(own(l), idOf(l.sceneId)));
  }
  for (const map of [d.check, d.refused]) {
    for (const e of Object.values(map)) {
      if (isPlainObject(e) && Array.isArray(e.sceneIds)) for (const id of e.sceneIds) if (idOf(id)) sceneRefs.add(recordKey(own(e), idOf(id)));
    }
  }
  for (const key of Object.keys(d.scenes)) if (!sceneRefs.has(key)) delete d.scenes[key];

  const performers = new Set();
  const studios = new Set();
  const tags = new Set();
  const addAll = (set, srv, list) => { if (Array.isArray(list)) for (const id of list) if (idOf(id)) set.add(recordKey(srv, idOf(id))); };
  for (const s of Object.values(d.scenes)) {
    if (!isPlainObject(s)) continue;
    const srv = own(s);
    addAll(performers, srv, s.performerIds);
    addAll(tags, srv, s.tagIds);
    if (idOf(s.studioId)) studios.add(recordKey(srv, idOf(s.studioId)));
    if (Array.isArray(s.markers)) {
      for (const m of s.markers) {
        if (!isPlainObject(m)) continue;
        for (const t of [m.tag, ...(Array.isArray(m.tags) ? m.tags : [])]) if (isPlainObject(t) && idOf(t.id)) tags.add(recordKey(srv, idOf(t.id)));
      }
    }
  }
  for (const key of [...studios]) {
    const studio = isPlainObject(d.studios[key]) ? d.studios[key] : null;
    const pid = studio ? (idOf(studio.parentId) || (isPlainObject(studio.parent) ? idOf(studio.parent.id) : null)) : null;
    if (pid) studios.add(recordKey(own(studio), pid));
  }
  for (const [key, keep] of [['performers', performers], ['studios', studios], ['tags', tags]]) {
    for (const id of Object.keys(d[key])) if (!keep.has(id)) delete d[key][id];
  }
}

function countsFor(d, hashed, skippedCount) {
  const counts = { linked: 0, check: 0, notInStash: 0, gone: 0, changed: 0, skipped: skippedCount };
  for (const v of hashed) {
    const l = isPlainObject(d.links[v.path]) ? d.links[v.path] : null;
    const c = hasOwn(d.check, v.path);
    if (l) {
      if (l.state === 'gone') counts.gone++;
      else if (l.state === 'changed') counts.changed++;
      else counts.linked++;
    }
    if (c) counts.check++;
    if (!l && !c) counts.notInStash++;
  }
  return counts;
}

/**
 * @param {object} deps — see the header comment
 * @param {object} deps.library — a createStashLibraryFile() instance
 */
function createStashSync({
  library, client, fingerprint, saveFingerprints, match, mapScene,
  mapActivity = mapSceneActivity,
  now = Date.now, log = console, perPage = DEFAULT_PER_PAGE, batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (!library || !client || typeof fingerprint !== 'function' || typeof match !== 'function' || typeof mapScene !== 'function') {
    throw new Error('createStashSync: library, client, fingerprint, match and mapScene are required');
  }
  const info = (msg) => { try { (log.info || (() => {})).call(log, msg); } catch { /* never breaks a sync */ } };
  const warn = (msg) => { try { (log.warn || log.info || (() => {})).call(log, msg); } catch { /* never breaks a sync */ } };

  let job = null;
  const loggedSkippedTags = new Set(); // tags left out for their name, logged once (sn-fixup)

  function start(kind, fn) {
    if (job) return Promise.resolve({ ok: false, kind, written: false, error: { code: 'busy' } });
    const controller = new AbortController();
    const current = { kind, controller, promise: null };
    job = current;
    current.promise = (async () => {
      try {
        return await fn(controller.signal);
      } catch (err) {
        warn(`[Stash] Sync failed: ${err?.message || err}`);
        return { ok: false, kind, written: false, error: { code: 'failed' } };
      } finally {
        if (job === current) job = null;
      }
    })();
    return current.promise;
  }

  function makeProgress(onProgress, kind) {
    return (step, done, total) => {
      if (typeof onProgress !== 'function') return;
      try { onProgress({ kind, step, done, total }); } catch { /* a progress listener never stops the job */ }
    };
  }

  async function hashAll(list, signal, progress) {
    const hashed = [];
    const skipped = [];
    progress('hash', 0, list.length);
    for (let i = 0; i < list.length; i++) {
      if (signal.aborted) return { hashed, skipped, stopped: true };
      const v = list[i];
      let fp = null;
      try {
        fp = await fingerprint({ ...v }, { signal });
      } catch {
        if (signal.aborted) return { hashed, skipped, stopped: true };
        fp = null;
      }
      const oshash = isPlainObject(fp) ? cleanOshash(fp.oshash) : null;
      if (oshash) hashed.push({ path: v.path, size: num(fp.size), mtimeMs: num(fp.mtimeMs), oshash });
      else skipped.push(v.path);
      progress('hash', i + 1, list.length);
    }
    return { hashed, skipped, stopped: false };
  }

  async function saveFp() {
    if (typeof saveFingerprints !== 'function') return;
    try { await saveFingerprints(); } catch (err) { warn(`[Stash] Could not save the fingerprint cache: ${err?.message || err}`); }
  }

  /**
   * Every page of the light list. Throws on a failed page or Cancel. The
   * list is complete only when every page came back and the ids seen add up
   * to the count Stash gave on the first and on the last page.
   */
  async function listAll(signal, progress) {
    const scenes = [];
    const seen = new Set();
    // id -> the next lot's fields the list gave (stash-map.js mapSceneActivity).
    const extras = new Map();
    let firstCount = null;
    let lastCount = null;
    let pages = 1;
    progress('list', 0, pages);
    for (let page = 1; page <= pages; page++) {
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      const res = await client.listScenes({ page, perPage, signal });
      const count = isPlainObject(res) ? res.count : undefined;
      if (!Number.isInteger(count) || count < 0 || !Array.isArray(res.scenes)) {
        throw Object.assign(new Error('bad scene list'), { code: 'bad-response' });
      }
      if (page === 1) {
        firstCount = count;
        pages = Math.max(1, Math.ceil(count / perPage));
      }
      lastCount = count;
      for (const raw of res.scenes) {
        const s = normalizeListed(raw);
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        scenes.push(s);
        let extra = null;
        try { extra = mapActivity(raw); } catch { extra = null; }
        if (isPlainObject(extra) && Object.keys(extra).length) extras.set(s.id, extra);
      }
      progress('list', page, pages);
    }
    const complete = firstCount === lastCount && seen.size === firstCount;
    return { scenes, complete, count: firstCount, extras };
  }

  /**
   * Stash's whole tag list (the next lot, #5), page by page. Never throws:
   * `{complete, tags, error}`; only a complete list may be stored. A list
   * longer than MAX_TAGS is not read past it (and is not complete).
   */
  async function listTags(signal) {
    if (typeof client.listTags !== 'function') return null;
    const tags = [];
    const seen = new Set();
    const skipped = []; // ids of tags left out for their name (counted as seen)
    let firstCount = null;
    let lastCount = null;
    let dropped = 0;
    let pages = 1;
    try {
      for (let page = 1; page <= pages; page++) {
        if (signal.aborted) return { complete: false, tags: [], error: { code: 'cancelled' } };
        const res = await client.listTags({ page, perPage, signal });
        const mapped = mapTagPage(isPlainObject(res) ? res : null);
        if (mapped.count === null || !Array.isArray(res.tags)) {
          return { complete: false, tags: [], error: { code: 'bad-response' } };
        }
        if (page === 1) {
          firstCount = mapped.count;
          if (firstCount > MAX_TAGS) return { complete: false, tags: [], error: { code: 'too-many' } };
          pages = Math.max(1, Math.ceil(firstCount / perPage));
        }
        lastCount = mapped.count;
        dropped += mapped.dropped;
        for (const t of mapped.tags) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          tags.push(t);
        }
        for (const id of Array.isArray(mapped.skipped) ? mapped.skipped : []) {
          if (seen.has(id)) continue;
          seen.add(id);
          skipped.push(id);
        }
      }
    } catch (err) {
      return { complete: false, tags: [], error: errorInfo(err, signal) };
    }
    const complete = tagListComplete({ allPagesFetched: true, firstCount, lastCount, tags, dropped, skipped });
    // Once per session per tag: which tags were left out for their name.
    const fresh = skipped.filter((id) => !loggedSkippedTags.has(id));
    if (fresh.length) {
      for (const id of fresh) loggedSkippedTags.add(id);
      info(`[Stash] ${fresh.length} tag(s) with a name FunSync cannot use were left out of the tag list (ids: ${fresh.slice(0, 20).join(', ')}${fresh.length > 20 ? ', ...' : ''})`);
    }
    return { complete, tags: complete ? tags : [], error: complete ? null : { code: 'incomplete' } };
  }

  /** Details one batch at a time; a failed batch or Cancel ends the step. */
  async function fetchDetails(ids, signal, progress) {
    const records = new Map();
    const nulls = new Set();
    let error = null;
    let done = 0;
    progress('details', 0, ids.length);
    for (let i = 0; i < ids.length; i += batchSize) {
      if (signal.aborted) { error = { code: 'cancelled' }; break; }
      const batch = ids.slice(i, i + batchSize);
      let res;
      try {
        res = await client.sceneDetails(batch, { signal });
      } catch (err) {
        error = errorInfo(err, signal);
        break;
      }
      for (const id of batch) {
        const raw = isPlainObject(res) ? res[id] : undefined;
        if (raw === null) { nulls.add(id); continue; }
        if (!isPlainObject(raw)) continue; // no answer for it: neither data nor a definite "not found"
        let mapped;
        try {
          mapped = mapScene(raw, { now: now() });
        } catch (err) {
          warn(`[Stash] Could not read scene ${id}: ${err?.message || err}`);
          continue;
        }
        if (!isPlainObject(mapped) || !isPlainObject(mapped.scene) || idOf(mapped.scene.id) !== id) continue;
        records.set(id, mapped);
      }
      done += batch.length;
      progress('details', done, ids.length);
    }
    return { records, nulls, error, done, total: ids.length };
  }

  /**
   * The commit, run by the library on its newest data. Returns what the
   * job reports back.
   */
  function commit(d, ctx) {
    const { hashed, skippedCount, matched, listComplete, details, server, kind, at, full, partial, error, guardChecks } = ctx;
    const relinked = [];
    const serverUrl = server.url;

    // Records of scenes that changed under a link (and nothing else here
    // wants) keep their old data (S1RB-4).
    const wantedNow = wantedSceneIds(hashed.map((v) => v.path), matched);
    const keepOld = new Set();
    for (const v of hashed) {
      const l = isPlainObject(matched.links) ? matched.links[v.path] : null;
      if (isPlainObject(l) && l.sceneChanged === true && idOf(l.sceneId) && !wantedNow.has(idOf(l.sceneId))) keepOld.add(idOf(l.sceneId));
    }
    for (const [id, mapped] of details.records) if (!keepOld.has(id)) storeMapped(d, mapped, at, serverUrl);
    // The light list's fresh plays, O-count, Groups and phash onto the
    // stored scenes it listed whose details were not fetched again just now.
    if (ctx.extras instanceof Map) {
      for (const [id, extra] of ctx.extras) {
        if (keepOld.has(id) || details.records.has(id)) continue;
        const rec = d.scenes[recordKey(serverUrl, id)];
        if (!isPlainObject(rec) || !isPlainObject(extra)) continue;
        Object.assign(rec, scrubSecrets(clone(extra)));
        rec.activityAt = at;
      }
    }
    // This server's scene (stored by server and id, stash-keys.js recordKey).
    const available = (id) => isPlainObject(d.scenes[recordKey(serverUrl, id)]) && !details.nulls.has(id);
    const isThisServer = (e) => isPlainObject(e) && sameServer(e.server, serverUrl);

    for (const video of hashed) {
      const p = video.path;
      const before = { path: p };
      for (const key of ['links', 'check', 'refused']) before[key] = hasOwn(d[key], p) ? clone(d[key][p]) : null;
      const ol = isPlainObject(d.links[p]) ? d.links[p] : null;
      const unreadable = hasOwn(d.links, p) && !ol;
      let next = hasOwn(d.links, p) ? d.links[p] : undefined; // default: as it is (never removed)
      const nl = unreadable ? null : cleanLinkCandidate(isPlainObject(matched.links) ? matched.links[p] : null);

      if (nl) {
        // The same scene: the same id on the same server (ids are per server).
        const sameScene = !!ol && idOf(ol.sceneId) === nl.sceneId && isThisServer(ol)
          && serverKey(nl.server || serverUrl) === serverKey(serverUrl);
        const userLink = !!ol && USER_BY.includes(ol.by);
        if (userLink && !sameScene) {
          // Your link or choice wins: automatic matching never replaces it.
        } else if (isRefused(d.refused[p], nl.sceneId, video.oshash, serverUrl)) {
          // Refused for this file content (also while this sync ran).
        } else if (guardChecks && !ol && hasOwn(d.check, p)) {
          // One video's sync is not the full list: an open check waits for
          // your choice or a full sync (the matcher's own rule too).
        } else if (nl.state === 'gone') {
          if (listComplete && sameScene) next = { ...ol, state: 'gone' };
        } else if (!available(nl.sceneId) && !(nl.state === 'changed' && sameScene)) {
          // No data for that scene yet (deleted after the list, or its batch did not finish).
          // (A link marked changed needs none: it only hides its data.)
        } else {
          const link = { ...nl, server: typeof nl.server === 'string' && nl.server ? nl.server : serverUrl };
          if (!Number.isFinite(link.linkedAt)) link.linkedAt = sameScene && Number.isFinite(ol.linkedAt) ? ol.linkedAt : at;
          if (sameScene && userLink) { link.by = ol.by; if (Number.isFinite(ol.linkedAt)) link.linkedAt = ol.linkedAt; }
          if (!link.state) link.state = 'ok';
          if (isPlainObject(link.fp) && cleanOshash(link.fp.oshash) === video.oshash) delete link.verify;
          next = link;
          if (ol && !sameScene) relinked.push({ path: p, from: idOf(ol.sceneId), to: nl.sceneId, undo: before });
        }
      }
      // Stash answered "no such scene" for it, by id: gone, its data kept.
      if (isThisServer(next) && details.nulls.has(idOf(next.sceneId))) next = { ...next, state: 'gone' };
      // An automatic link to a scene refused for this content goes (an
      // import brought it back): the refusal was your word.
      if (isThisServer(next) && !USER_BY.includes(next.by) && isRefused(d.refused[p], idOf(next.sceneId), video.oshash, serverUrl)) {
        delete d.links[p];
        next = undefined;
        info('[Stash] A link to a scene refused for this file was dropped');
      }
      if (next !== undefined) d.links[p] = next;

      const nc = cleanCheckCandidate(isPlainObject(matched.check) ? matched.check[p] : null);
      const nowLinkedByYou = isPlainObject(d.links[p]) && USER_BY.includes(d.links[p].by);
      if (nc) {
        const ids = nc.sceneIds.filter((id) => !isRefused(d.refused[p], id, video.oshash, serverUrl));
        if (!nowLinkedByYou && ids.length > 0 && ids.every(available) && !(hasOwn(d.check, p) && !isPlainObject(d.check[p]))) {
          d.check[p] = { ...nc, sceneIds: ids, server: typeof nc.server === 'string' && nc.server ? nc.server : serverUrl };
        }
      } else if (full && !partial && listComplete && isPlainObject(d.check[p])) {
        delete d.check[p]; // resolved: only a complete, successful sync clears it
      }
    }

    if (full && !partial && listComplete) pruneUnreferenced(d, serverUrl);
    // Groups as read-only playlists: removed only by a complete, successful full sync.
    refreshGroups(d, serverUrl, at, { complete: !!(full && !partial && listComplete) });
    if (ctx.tagList && ctx.tagList.complete) storeTagTree(d, serverUrl, ctx.tagList.tags, at);

    const counts = countsFor(d, hashed, skippedCount);
    if (kind === 'full' || !isPlainObject(d.lastSync) || d.lastSync.kind !== 'full') {
      d.lastSync = { at, kind, ok: !partial && !error, partial, error: error ? error.code : null, counts };
    }
    if (serverUrl) d.server = { url: serverUrl, version: typeof server.version === 'string' ? server.version : null };
    return { counts, relinked };
  }

  // Stored under server and id (stash-keys.js recordKey): a sync of one
  // Stash never overwrites another Stash's scene, person, studio or tag that
  // happens to have the same id.
  function storeMapped(d, mapped, at, serverUrl) {
    const clean = scrubSecrets(clone(mapped));
    if (!isPlainObject(clean) || !isPlainObject(clean.scene) || !idOf(clean.scene.id)) return;
    const id = idOf(clean.scene.id);
    const server = serverUrl || (typeof clean.scene.server === 'string' ? clean.scene.server : null);
    const sceneKey = recordKey(server, id);
    if (!sceneKey) return;
    d.scenes[sceneKey] = { ...clean.scene, id, fetchedAt: at, server };
    const studios = Array.isArray(clean.studios) ? clean.studios : (isPlainObject(clean.studio) ? [clean.studio] : []);
    for (const [key, list] of [['performers', clean.performers], ['studios', studios], ['tags', clean.tags]]) {
      for (const rec of Array.isArray(list) ? list : []) {
        const rid = isPlainObject(rec) ? idOf(rec.id) : null;
        const rkey = rid ? recordKey(server, rid) : null;
        if (rkey) d[key][rkey] = { ...rec, id: rid, fetchedAt: at, server };
      }
    }
  }

  function cleanServer(server) {
    return {
      url: isPlainObject(server) && typeof server.url === 'string' ? server.url : null,
      version: isPlainObject(server) && typeof server.version === 'string' ? server.version : null,
    };
  }

  function notWritten(kind, error, extra = {}) {
    return { ok: false, kind, written: false, partial: true, cancelled: error.code === 'cancelled', error, ...extra };
  }

  async function writeResult(ctx, progress) {
    progress('write', 0, 1);
    let report = null;
    const res = await library.applySync((d) => {
      // Cancel pressed while this write waited its turn (SN-R2): a
      // cancelled, partial run (what finished is written, nothing removed).
      if (ctx.signal && ctx.signal.aborted && !ctx.error) {
        ctx.error = { code: 'cancelled' };
        ctx.partial = true;
      }
      report = commit(d, ctx);
      return {};
    });
    progress('write', 1, 1);
    if (!res || res.ok !== true) {
      return notWritten(ctx.kind, { code: res && typeof res.error === 'string' ? res.error : 'write-failed' }, { details: { done: ctx.details.done, total: ctx.details.total } });
    }
    return {
      ok: !ctx.partial && !ctx.error,
      kind: ctx.kind,
      written: true,
      partial: ctx.partial,
      cancelled: !!ctx.error && ctx.error.code === 'cancelled',
      complete: ctx.listComplete,
      error: ctx.error,
      counts: report.counts,
      relinked: report.relinked,
      details: { done: ctx.details.done, total: ctx.details.total },
      tags: ctx.tagList ? { ok: ctx.tagList.complete === true, count: ctx.tagList.complete ? ctx.tagList.tags.length : null, error: ctx.tagList.error || null } : null,
    };
  }

  // --- Sync now ---

  async function fullSync({ videos, server, pathRules, onProgress } = {}, signal) {
    const kind = 'full';
    const progress = makeProgress(onProgress, kind);
    const srv = cleanServer(server);
    const list = normalizeVideos(videos);
    info(`[Stash] Sync started: ${list.length} videos`);

    const { hashed, skipped, stopped } = await hashAll(list, signal, progress);
    await saveFp();
    if (stopped) return notWritten(kind, { code: 'cancelled' }, { step: 'hash' });

    let listing;
    try {
      listing = await listAll(signal, progress);
    } catch (err) {
      const error = errorInfo(err, signal);
      info(`[Stash] Sync stopped while reading the scene list (${error.code}); nothing was changed`);
      return notWritten(kind, error, { step: 'list' });
    }

    progress('match', 0, 1);
    const current = library.snapshot();
    let matched;
    try {
      matched = match({
        videos: hashed.map((v) => ({ ...v })),
        scenes: clone(listing.scenes),
        complete: listing.complete,
        links: current.links,
        check: current.check,
        refused: current.refused,
        storedScenes: current.scenes,
        pathRules: cleanRules(pathRules),
        server: srv.url || '',
        now: now(),
        skipped: skipped.length,
      });
    } catch (err) {
      warn(`[Stash] Matching failed: ${err?.message || err}`);
      return notWritten(kind, { code: 'match-failed' }, { step: 'match' });
    }
    if (!isPlainObject(matched)) matched = {};
    progress('match', 1, 1);

    const listedById = new Map(listing.scenes.map((s) => [s.id, s]));
    const need = [...wantedSceneIds(hashed.map((v) => v.path), matched)].filter((id) => {
      const listed = listedById.get(id);
      if (!listed) return false;
      const stored = current.scenes[recordKey(srv.url, id)];
      return !isPlainObject(stored) || stored.updatedAt !== listed.updatedAt;
    });
    const details = await fetchDetails(need, signal, progress);

    let error = details.error;
    // Stash's tags (aliases, parents): after the details, never when they
    // stopped (a failing or cancelled Stash would fail here too).
    const tagList = error ? null : await listTags(signal);
    if (tagList && !tagList.complete) info(`[Stash] The tag list was not read whole (${tagList.error ? tagList.error.code : 'incomplete'}); the stored one is kept`);
    // A Cancel pressed while the tag list was read is a Cancel (SN-R2).
    if (!error && signal.aborted) error = { code: 'cancelled' };
    const result = await writeResult({
      kind,
      full: true,
      hashed,
      skippedCount: skipped.length,
      matched,
      listComplete: listing.complete,
      extras: listing.extras,
      tagList,
      details,
      server: srv,
      at: now(),
      partial: !!error,
      error,
      guardChecks: false,
      signal,
    }, progress);
    info(`[Stash] Sync ${result.ok ? 'done' : (result.written ? 'stopped' : 'failed')}: `
      + (result.counts
        ? `${result.counts.linked} linked · ${result.counts.check} need a check · ${result.counts.notInStash} not in Stash · ${result.counts.skipped} skipped`
        : 'nothing written')
      + ((result.written ? result.error : error) ? ` (${(result.written ? result.error : error).code}; nothing was removed)` : ''));
    return result;
  }

  // --- Sync this video ---

  async function videoSync({ video, server, pathRules, onProgress } = {}, signal) {
    const kind = 'video';
    const progress = makeProgress(onProgress, kind);
    const srv = cleanServer(server);
    const [v] = normalizeVideos([video]);
    if (!v) return notWritten(kind, { code: 'bad-input' });

    const { hashed, stopped } = await hashAll([v], signal, progress);
    await saveFp();
    if (stopped) return notWritten(kind, { code: 'cancelled' }, { step: 'hash' });
    if (hashed.length === 0) return { ok: false, kind, written: false, partial: false, cancelled: false, skipped: true, error: { code: 'skipped' } };
    const h = hashed[0];

    const current = library.snapshot();
    const ol = isPlainObject(current.links[h.path]) ? current.links[h.path] : null;
    // Only a link to THIS server's scene is asked about by id (ids are per server).
    const linkedId = ol && sameServer(ol.server, srv.url) ? idOf(ol.sceneId) : null;
    let scenes = [];
    let details;
    try {
      // Every scene with a file of this oshash (two means "several"), then
      // their details and the linked scene's, by id, in one batch.
      progress('list', 0, 1);
      const found = await client.scenesByOshash(h.oshash, { signal });
      scenes = (isPlainObject(found) && Array.isArray(found.scenes) ? found.scenes : []).map(normalizeListed).filter(Boolean);
      progress('list', 1, 1);
      const ids = [...new Set([...scenes.map((s) => s.id), ...(linkedId ? [linkedId] : [])])].slice(0, batchSize);
      details = await fetchDetails(ids, signal, progress);
      if (details.error) throw Object.assign(new Error(details.error.code), { code: details.error.code });
      // The linked scene as Stash has it now, so the matcher can tell whether
      // it is still the scene this video was linked to (S1RB-4).
      const linkedNow = linkedId ? details.records.get(linkedId) : null;
      if (linkedNow && isPlainObject(linkedNow.scene) && !scenes.some((x) => x.id === linkedId)) {
        const listed = normalizeListed({ id: linkedId, updatedAt: linkedNow.scene.updatedAt, files: linkedNow.scene.files });
        if (listed) scenes.push(listed);
      }
    } catch (err) {
      const error = errorInfo(err, signal);
      info(`[Stash] Sync this video stopped (${error.code}); nothing was changed`);
      return notWritten(kind, error, { step: 'list' });
    }

    let matched;
    try {
      progress('match', 0, 1);
      matched = match({
        videos: [{ ...h }],
        scenes,
        complete: false, // one video's view of Stash is never a complete list
        goneIds: [...details.nulls],
        links: current.links,
        check: current.check,
        refused: current.refused,
        storedScenes: current.scenes,
        pathRules: cleanRules(pathRules),
        server: srv.url || '',
        now: now(),
        skipped: 0,
      });
      progress('match', 1, 1);
    } catch (err) {
      warn(`[Stash] Matching failed: ${err?.message || err}`);
      return notWritten(kind, { code: 'match-failed' }, { step: 'match' });
    }
    if (!isPlainObject(matched)) matched = {};

    return writeResult({
      kind,
      full: false,
      hashed: [h],
      skippedCount: 0,
      matched,
      listComplete: false,
      details,
      server: srv,
      at: now(),
      partial: false,
      error: null,
      guardChecks: true,
      signal,
    }, progress);
  }

  return {
    /** Sync now: `{videos: [{path, size?, mtimeMs?}], server: {url, version}, pathRules, onProgress}`. */
    run: (opts) => start('full', (signal) => fullSync(opts, signal)),
    /** Sync this video: `{video: {path, size?, mtimeMs?}, server, pathRules, onProgress}`. */
    runVideo: (opts) => start('video', (signal) => videoSync(opts, signal)),
    /** Cancel: the job stops at its next step and writes what finished (after the list). */
    cancel() {
      if (!job) return false;
      job.controller.abort();
      return true;
    },
    isRunning: () => !!job,
    /** Resolves when no job runs (FunSync closing: cancel(), then await this). */
    whenIdle: () => (job ? job.promise.then(() => {}, () => {}) : Promise.resolve()),
  };
}

module.exports = {
  DEFAULT_PER_PAGE,
  DEFAULT_BATCH_SIZE,
  createStashSync,
  shouldSyncOnStart,
  pruneUnreferenced,
};
