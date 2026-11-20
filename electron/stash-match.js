'use strict';

// Stash S1 (2026-11-18): which Stash scene is each library video?
// notes/features/DESIGN-stash-s1.md (b). A pure function: no I/O, inputs
// never changed (new maps come back). Pass `server` (the address links
// record) and `now`; without `now` it reads the clock once.
//
// The rules, in order, for each video fingerprinted in this sync:
//   1. A link you made or chose (`by: 'manual'` or `'chosen'`) is kept.
//      Automatic matching never replaces it; its fingerprint is renewed when
//      the file is still the same content (or still a file of that scene).
//   2. Its oshash equals a file of exactly ONE Stash scene: linked
//      (`by: 'oshash'`). A scene with several files is still one scene.
//      Hashes are compared WHOLE on this PC (Stash's own multi-hash search
//      matches pieces of a hash, checked 2026-11-18).
//   3. Its oshash equals files of two or more scenes: a check (`several`),
//      nothing new linked; an existing link to one of them is kept.
//   4. No oshash match, but a Stash file has the same path (separator- and,
//      for Windows-style paths, case-blind, after the path rules): a check
//      (`pathChanged`), never a link. A path match with other content is
//      exactly the swapped-file case.
//   5. Nothing matches: not in Stash; an existing link is kept.
//   - A scene refused for this video is never offered or linked again while
//     the file has the oshash the refusal stored; refusals are never removed
//     here (only the user's Undo does that). An AUTOMATIC link that such a
//     refusal covers (brought back by an import, s1-fixup-main S1RB-3) is
//     dropped, so a sync heals it; a link you made or chose is yours.
//   - A link is trusted only while its scene is still that scene (S1RB-4):
//     scene ids are unique per Stash DATABASE, and a Stash reset or
//     reinstalled at the same address hands the same ids to other scenes.
//     When the listed scene with the link's id has files with an oshash and
//     none of them is a file the link knows (`sceneHashes`, the scene's
//     files when it was linked; else the link's own fingerprint, or the
//     stored scene record), the link is marked `changed` with
//     `sceneChanged: true`: its data stays hidden, it is never "ok", and
//     its scene is not re-fetched over the old record.
//   - Identical copies (two library files, one oshash) are each matched on
//     their own, so both link to the scene.
//   - Stash ids are unique only per server (Round 2): a check and a refusal
//     record the server they are about, a refusal counts only for its own
//     server, and stored scenes are looked up by server and id
//     (stash-keys.js recordKey).
//
// Gone, changed, partial:
//   - `gone` is decided only from a COMPLETE list (or for one scene that
//     Stash answered null for, `goneIds`, as "Sync this video" does). The
//     link and its data are kept.
//   - `changed`: the file's content is no longer the link's fingerprint and
//     the new content is not in the linked scene. The link and its old
//     fingerprint are kept (the read-time size check keeps its data hidden).
//   - With an INCOMPLETE list (Cancel, a failed page, "Sync this video",
//     which sees one scene per hash) the matcher only adds: it never
//     re-links an existing link, never replaces or removes a check, never
//     marks anything gone. A second scene with the same file may sit on a
//     page it did not see.
//   - Only the videos passed in are touched: a video that was skipped (an
//     offline drive, a read error) keeps its link and check as they were.

const { normalizeOshash } = require('./stash-fingerprint');
const { stashId, compareIds, mapListScene } = require('./stash-map');
const { serverKey, sameServer, recordKey } = require('./stash-keys');

/** Links the user made: automatic matching never replaces them. */
const BY_USER = new Set(['manual', 'chosen']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function cloneMap(value) {
  if (!isPlainObject(value)) return {};
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

// ---------------------------------------------------------------------------
// Addresses and paths
// ---------------------------------------------------------------------------

// serverKey and sameServer (a link with no server recorded is taken as the
// one being synced) live in stash-keys.js, shared with the library file.

/** A Windows-style path: a drive letter, a UNC share, or a backslash. */
function isWindowsStyle(path) {
  return typeof path === 'string' && (/^[A-Za-z]:([\\/]|$)/.test(path) || /^[\\/]{2}[^\\/]/.test(path) || path.includes('\\'));
}

/** Forward slashes, NFC, repeated slashes collapsed (a UNC "//" kept), no trailing slash. */
function slashPath(path) {
  const s = String(path).normalize('NFC').replace(/\\/g, '/').replace(/(?<!^)\/{2,}/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/**
 * The form two paths are compared in: separator-blind, and case-blind when
 * `fold` (a Windows-style local path).
 */
function pathKey(path, fold) {
  const s = slashPath(path);
  return fold ? s.toLowerCase() : s;
}

/**
 * Path rules, checked: pairs of folder prefixes ("this folder in FunSync is
 * that folder in Stash"), longest Stash prefix first. A rule with an empty
 * side is ignored.
 *
 * @param {unknown} pathRules [{local, stash}]
 * @returns {{local: string, stash: string, fold: boolean}[]}
 */
function compileRules(pathRules) {
  const out = [];
  for (const rule of asList(pathRules)) {
    if (!isPlainObject(rule) || typeof rule.local !== 'string' || typeof rule.stash !== 'string') continue;
    if (!rule.local.trim() || !rule.stash.trim()) continue;
    const local = slashPath(rule.local.trim());
    const stash = slashPath(rule.stash.trim());
    out.push({
      local: local === '/' ? '' : local,
      stash: stash === '/' ? '' : stash,
      fold: isWindowsStyle(rule.local) || isWindowsStyle(rule.stash),
    });
  }
  return out.sort((a, b) => b.stash.length - a.stash.length);
}

/**
 * A Stash file path as FunSync would see it: the first (longest) rule whose
 * Stash folder holds it swaps that folder for the local one, on a folder
 * boundary only ("/data/videos" never matches "/data/videos2"). Without a
 * matching rule the path is returned as it is (in forward slashes).
 *
 * @param {string} stashPath
 * @param {{local: string, stash: string, fold: boolean}[]} rules from compileRules
 * @returns {string}
 */
function mapStashPath(stashPath, rules) {
  const s = slashPath(stashPath);
  for (const rule of rules) {
    const hay = rule.fold ? s.toLowerCase() : s;
    const prefix = rule.fold ? rule.stash.toLowerCase() : rule.stash;
    if (hay === prefix || hay.startsWith(`${prefix}/`)) return rule.local + s.slice(rule.stash.length);
  }
  return s;
}

// ---------------------------------------------------------------------------
// The scene list index
// ---------------------------------------------------------------------------

function addTo(map, key, id) {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(id);
}

function buildIndex(scenes, rules) {
  const byId = new Map();
  const byOshash = new Map();
  const byPath = new Map();
  const byPathFolded = new Map();
  for (const raw of asList(scenes)) {
    // Light scenes as the client returns them (`updated_at`, an `oshash`
    // alias or a `fingerprints` list) or already mapped: one form here.
    const scene = mapListScene(raw);
    if (!scene) continue;
    const { id } = scene;
    byId.set(id, scene);
    for (const file of scene.files) {
      if (file.oshash) addTo(byOshash, file.oshash, id);
      const local = mapStashPath(file.path, rules);
      addTo(byPath, pathKey(local, false), id);
      addTo(byPathFolded, pathKey(local, true), id);
    }
  }
  return { byId, byOshash, byPath, byPathFolded };
}

function sortedIds(set) {
  return set ? [...set].sort(compareIds) : [];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function videoOf(raw) {
  if (!isPlainObject(raw) || typeof raw.path !== 'string' || !raw.path) return null;
  const hash = normalizeOshash(raw.oshash);
  if (!hash) return null;
  const size = Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : null;
  const mtimeMs = Number.isFinite(raw.mtimeMs) ? raw.mtimeMs : null;
  return { path: raw.path, size, mtimeMs, oshash: hash };
}

function fpOf(video) {
  return { size: video.size, mtimeMs: video.mtimeMs, oshash: video.oshash };
}

/** The distinct oshashes of a scene's files (at most 50). */
function hashesOf(files) {
  const out = [];
  for (const file of asList(files)) {
    const h = isPlainObject(file) ? normalizeOshash(file.oshash) : null;
    if (h && !out.includes(h)) out.push(h);
    if (out.length >= 50) break;
  }
  return out;
}

/** Is the file still the content the link was made for? */
function sameContent(fp, video) {
  if (!isPlainObject(fp)) return false;
  const hash = normalizeOshash(fp.oshash);
  if (hash) return hash === video.oshash;
  // A link made before the file was hashed (Find in Stash): the size decides.
  return Number.isSafeInteger(fp.size) && fp.size === video.size;
}

function refusedIdsFor(entry, hash, server) {
  // A refusal is about one server's scenes: scene 12 refused on another
  // Stash says nothing about this one's scene 12.
  if (!isPlainObject(entry) || normalizeOshash(entry.oshash) !== hash || !sameServer(entry.server, server)) return new Set();
  return new Set(asList(entry.sceneIds).map(stashId).filter(Boolean));
}

/**
 * Match the library's fingerprinted videos to Stash's scene list.
 *
 * "Sync this video" is the same call with one video, the scenes Stash
 * returned for its hash and its linked id, `complete: false`, and
 * `goneIds: [id]` when `findScene` answered null for the linked scene.
 *
 * @param {object} input
 * @param {{path: string, size: number, mtimeMs: number, oshash: string}[]} input.videos
 *   the videos fingerprinted in this sync (skipped ones are left out)
 * @param {{id: string, updatedAt: string|null, files: {path: string, size: number|null, oshash: string|null}[]}[]} input.scenes
 *   Stash's light scene list (stash-map.js mapListScene)
 * @param {boolean} input.complete the list is every scene Stash has (stash-map.js sceneListComplete)
 * @param {string[]} [input.goneIds] scenes Stash answered null for (a definite "deleted")
 * @param {object} [input.links] library.json `links`
 * @param {object} [input.check] library.json `check`
 * @param {object} [input.refused] library.json `refused`
 * @param {object} [input.storedScenes] library.json `scenes`, keyed by stash-keys.js
 *   recordKey (server and id), to pick the details to fetch
 * @param {{local: string, stash: string}[]} [input.pathRules] settings.stash.pathRules
 * @param {string} input.server the Stash address being synced
 * @param {number} input.now epoch ms, for `linkedAt` and `seenAt`
 * @param {number} [input.skipped] videos the fingerprint step skipped (for the counts)
 * @returns {{links: object, check: object, refused: object,
 *   relinked: {path: string, from: object, to: object}[],
 *   fetch: string[],
 *   outcome: Object<string, 'linked'|'check'|'changed'|'gone'|'notInStash'>,
 *   counts: {linked: number, check: number, notInStash: number, gone: number, changed: number, skipped: number}}}
 */
function matchLibrary(input = {}) {
  const complete = input.complete === true;
  const server = typeof input.server === 'string' ? input.server : '';
  // `now` is passed in (tests, the sync's own clock); the clock is only a fallback.
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const links = cloneMap(input.links);
  const check = cloneMap(input.check);
  const refused = cloneMap(input.refused);
  const index = buildIndex(input.scenes, compileRules(input.pathRules));
  const goneSet = new Set(asList(input.goneIds).map(stashId).filter(Boolean));
  const isGone = (id) => goneSet.has(id) || (complete && !index.byId.has(id));

  const relinked = [];
  const outcome = {};
  const counts = {
    linked: 0, check: 0, notInStash: 0, gone: 0, changed: 0,
    skipped: Number.isSafeInteger(input.skipped) && input.skipped > 0 ? input.skipped : 0,
  };

  const storedScenes = isPlainObject(input.storedScenes) ? input.storedScenes : {};

  const newLink = (sceneId, video) => {
    const listed = index.byId.get(sceneId);
    const sceneHashes = listed ? hashesOf(listed.files) : [];
    return {
      sceneId, server, by: 'oshash', fp: fpOf(video), linkedAt: now, state: 'ok',
      ...(sceneHashes.length ? { sceneHashes } : {}),
    };
  };

  /**
   * Is the listed scene with this link's id still the scene it was linked
   * to? 'same', 'different', or 'unknown' (not listed, or no oshash to
   * compare on either side: trusted as before).
   */
  const sceneIdentity = (link, video) => {
    const listed = index.byId.get(link.sceneId);
    if (!listed) return 'unknown';
    const now_ = hashesOf(listed.files);
    if (now_.length === 0) return 'unknown';
    if (now_.includes(video.oshash)) return 'same';
    let known = Array.isArray(link.sceneHashes) ? hashesOf(link.sceneHashes.map((h) => ({ oshash: h }))) : [];
    if (known.length === 0 && !BY_USER.has(link.by)) {
      // An automatic link was made for a file of that scene: its fingerprint.
      const h = normalizeOshash(link.fp && link.fp.oshash);
      if (h) known = [h];
    }
    if (known.length === 0) {
      // A link made before scenes' files were kept with it: the stored record.
      const key = recordKey(server, link.sceneId);
      const rec = key && hasOwn(storedScenes, key) ? storedScenes[key] : null;
      known = isPlainObject(rec) ? hashesOf(rec.files) : [];
    }
    if (known.length === 0) return 'unknown';
    return now_.some((h) => known.includes(h)) ? 'same' : 'different';
  };

  const sceneState = (link) => {
    if (isGone(link.sceneId)) return 'gone';
    if (index.byId.has(link.sceneId)) return 'ok';
    return link.state === 'gone' ? 'gone' : 'ok';
  };

  // An existing link of this server, kept: renewed when the file is still
  // its content (or still a file of its scene), else marked changed.
  const keepLink = (path, link, video, candidates) => {
    const next = { ...link };
    delete next.verify;
    const identity = sceneIdentity(link, video);
    if (identity === 'different') {
      // Another scene has this id now: never "ok", never re-pointed; the
      // old fingerprint and record are kept, the data stays hidden.
      next.state = 'changed';
      next.sceneChanged = true;
    } else if (sameContent(link.fp, video) || candidates.includes(link.sceneId)) {
      next.fp = fpOf(video);
      next.state = sceneState(link);
      delete next.sceneChanged;
      const listed = index.byId.get(link.sceneId);
      const sceneHashes = listed ? hashesOf(listed.files) : [];
      if (sceneHashes.length) next.sceneHashes = sceneHashes;
    } else {
      next.state = 'changed';
      delete next.sceneChanged;
    }
    links[path] = next;
  };

  const setCheck = (path, kind, sceneIds, video) => {
    // A partial list never replaces a check: the full list may hold more.
    if (!complete && hasOwn(check, path)) return;
    check[path] = { kind, sceneIds, fp: fpOf(video), seenAt: now, server };
  };

  const seen = new Set();
  for (const raw of asList(input.videos)) {
    const video = videoOf(raw);
    if (!video) { counts.skipped += 1; continue; }
    const { path } = video;
    if (seen.has(path)) continue;
    seen.add(path);

    const stored = links[path];
    let link = isPlainObject(stored) && stashId(stored.sceneId) ? stored : null;
    let own = Boolean(link) && sameServer(link.server, server);
    const refusedIds = refusedIdsFor(refused[path], video.oshash, server);
    const candidates = sortedIds(index.byOshash.get(video.oshash)).filter((id) => !refusedIds.has(id));
    if (link && own && !BY_USER.has(link.by) && refusedIds.has(stashId(link.sceneId))) {
      // An automatic link to a scene you refused for this content (an
      // import brought it back): it goes, as the refusal said.
      delete links[path];
      link = null;
      own = false;
    }

    if (link && BY_USER.has(link.by)) {
      // Rule 1: yours. Kept as it is; renewed or marked changed if it is this server's.
      if (own) keepLink(path, link, video, candidates);
      delete check[path];
    } else if (candidates.length === 1) {
      // Rule 2: one scene has this exact file.
      const [sceneId] = candidates;
      if (own && link.sceneId === sceneId) {
        keepLink(path, link, video, candidates);
        if (complete) delete check[path];
      } else if (!link) {
        if (complete || !hasOwn(check, path)) {
          links[path] = newLink(sceneId, video);
          delete check[path];
        }
      } else if (complete) {
        // Another scene (merged in Stash, a changed file, another server): re-linked, with Undo.
        const to = newLink(sceneId, video);
        relinked.push({ path, from: link, to });
        links[path] = to;
        delete check[path];
      } else if (own) {
        keepLink(path, link, video, candidates);
      }
    } else if (candidates.length > 1) {
      // Rule 3: several scenes have this exact file. Yours to pick.
      if (own) keepLink(path, link, video, candidates);
      setCheck(path, 'several', candidates, video);
    } else {
      // Rules 4 and 5: no file in Stash has this content.
      if (own) keepLink(path, link, video, candidates);
      const holds = own && links[path].state === 'ok';
      const fold = isWindowsStyle(path);
      const pathIds = holds ? [] : sortedIds((fold ? index.byPathFolded : index.byPath).get(pathKey(path, fold)))
        .filter((id) => !refusedIds.has(id));
      if (pathIds.length) setCheck(path, 'pathChanged', pathIds, video);
      else if (complete) delete check[path];
    }

    const final = links[path];
    const finalOwn = isPlainObject(final) && stashId(final.sceneId) && sameServer(final.server, server);
    let result = 'notInStash';
    if (hasOwn(check, path)) result = 'check';
    else if (finalOwn && final.state === 'changed') result = 'changed';
    else if (finalOwn && final.state === 'gone') result = 'gone';
    else if (finalOwn) result = 'linked';
    outcome[path] = result;
    counts[result] += 1;
  }

  // Details to fetch: scenes of this server's links and of open checks that
  // are in the list and new or changed since they were stored.
  const wanted = new Set();
  for (const link of Object.values(links)) {
    if (!isPlainObject(link) || !sameServer(link.server, server) || link.sceneChanged === true) continue;
    const id = stashId(link.sceneId);
    if (id && index.byId.has(id)) wanted.add(id);
  }
  for (const entry of Object.values(check)) {
    if (!isPlainObject(entry) || !sameServer(entry.server, server)) continue;
    for (const raw of asList(entry.sceneIds)) {
      const id = stashId(raw);
      if (id && index.byId.has(id)) wanted.add(id);
    }
  }
  const fetch = [...wanted].filter((id) => {
    const listed = index.byId.get(id).updatedAt;
    // Stored scenes are keyed by server and id (stash-keys.js recordKey).
    const key = recordKey(server, id);
    const have = key && hasOwn(storedScenes, key) ? storedScenes[key] : null;
    return !isPlainObject(have) || listed == null || have.updatedAt !== listed;
  }).sort(compareIds);

  return { links, check, refused, relinked, fetch, outcome, counts };
}

/**
 * The other library files linked with the same content as this one (the
 * "Another file in your library is the same video" line).
 *
 * @param {object} links library.json `links`
 * @param {string} path
 * @returns {string[]}
 */
function sameContentPaths(links, path) {
  if (!isPlainObject(links) || !hasOwn(links, path) || !isPlainObject(links[path])) return [];
  const hash = normalizeOshash(links[path].fp && links[path].fp.oshash);
  if (!hash) return [];
  const out = [];
  for (const [other, link] of Object.entries(links)) {
    if (other === path || !isPlainObject(link) || !isPlainObject(link.fp)) continue;
    if (normalizeOshash(link.fp.oshash) === hash && link.sceneId === links[path].sceneId
      && serverKey(link.server) === serverKey(links[path].server)) out.push(other);
  }
  return out.sort();
}

module.exports = {
  BY_USER,
  serverKey,
  sameServer,
  isWindowsStyle,
  pathKey,
  compileRules,
  mapStashPath,
  matchLibrary,
  sameContentPaths,
};
