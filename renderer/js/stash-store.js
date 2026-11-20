// The renderer's copy of the Stash data, and its calls to Electron main
// (Stash S1, Round 2 stage 2d, 2026-11-18; notes/features/DESIGN-stash-s1.md
// (c) "The renderer's copy and the stash tag source", (a) step 8, (e)).
//
// Main owns userData/stash/library.json and is its only writer. The renderer
// holds a frozen copy of main's projection of it (the design's fields only:
// no fingerprint cache, no key, no URL Stash built) for the tag engine
// (stash-tags.js stashTagRecords, via library-tag-filter.js LibraryTagIndex),
// the video options dialog (stashVideoView) and the seek bar's Stash markers
// (stash-markers.js). Every change (link, choose, refuse, unlink, Undo,
// re-home, sync, remove) is asked of main over IPC; main writes, reports the
// change, and the copy here is replaced.
//
//   stashData()          -> the frozen projection, never null (empty before the first load)
//   stashVersion()       -> number, +1 each time the copy is replaced (memo keys)
//   onStashChanged(cb)   -> () => void  unsubscribe; cb() after each replacement
//   stashLoaded()        -> true once a projection from main was applied
//   stashGroups()        -> the projection's `groups` map (frozen), or null
//                           when it has none (stash-groups.js builds the
//                           read-only "Stash: <group>" playlists from it)
//   initStashStore({isEnabled, isSyncOnStart})
//                        -> Promise<boolean>  once per window: loads the
//                           projection when Stash is on (never a request to
//                           Stash itself), listens for main's change reports,
//                           and loads on the first turn-on of a session.
//   reloadStash()        -> Promise<boolean>  ask main for the projection again
//   stashSyncOnStart(videos) -> after the first library scan of a session,
//                           once: main runs the ONE optional sync when
//                           `settings.stash.syncOnStart` is on (main decides too)
//   stashRelinks(), noteStashRelinks(reply), forgetStashRelinks(undoIds),
//   onStashRelinksChanged(cb) -> this session's re-links by a full sync, each
//                           with main's Undo token (Settings > Sources > Stash
//                           lists them, "Re-linked (n)"); never stored
//   and one wrapper per IPC call (status, settings, key, certificate, test,
//   link, sync, progress, cancel, choose, refuse, unlink, Undo, re-home,
//   search, link a scene, remove, open in Stash), below. The calls and their
//   replies are stage s1-2a-main's (electron/main.js, electron/preload.js):
//   every failure is `{ok: false, code}`, a change answers an `undoId`.
//
// Scene ids in the projection are opaque strings (main: the data's own
// server keeps Stash's raw id, any other server's records are
// `<id>@<server-key>`, references alike), so `data.scenes[link.sceneId]`
// is always the link's own server's scene. Send them back as given.
//
// Rules:
// - Never on its own: nothing here talks to Stash unless the user asked
//   (Sync now, Sync this video, Test, Find in Stash…) or turned on "Sync with
//   Stash when FunSync starts". Loading the projection is a read of main's
//   file, not a request to Stash.
// - Absence is never destructive: a failed, missing or malformed answer
//   leaves the copy as it was. Only a projection main sent replaces it.
// - Turning Stash off clears nothing here (the views read `enabled` and show
//   nothing); turning it on shows the data again at once, with no sync.
// - Nothing is persisted here.

import { eventBus } from './event-bus.js';

/**
 * The preload names (electron/preload.js `window.funsync`), one place
 * (stage s1-2a-main's IPC contract; DESIGN-stash-s1.md (c) lists the calls).
 */
export const STASH_API = Object.freeze({
  data: 'stashGetData',
  onChanged: 'onStashChanged',
  onSettingsChanged: 'onStashSettingsChanged',
  status: 'stashStatus',
  test: 'stashTest',
  link: 'stashLink',
  setOptions: 'stashSetOptions',
  saveKey: 'stashSaveKey',
  removeKey: 'stashRemoveKey',
  trustCertificate: 'stashTrustCertificate',
  forgetCertificate: 'stashForgetCertificate',
  sync: 'stashSync',
  syncOnStart: 'stashSyncOnStart',
  syncVideo: 'stashSyncVideo',
  cancel: 'stashCancel',
  onProgress: 'onStashProgress',
  choose: 'stashChoose',
  refuse: 'stashRefuse',
  unlink: 'stashUnlink',
  undo: 'stashUndo',
  rehome: 'stashRehome',
  search: 'stashSearch',
  linkScene: 'stashLinkScene',
  remove: 'stashRemoveData',
  openScene: 'stashOpenScene',
});

/** settings paths that carry the Stash on/off switch. */
export function isStashSettingPath(path) {
  return path === 'stash' || path === 'stash.enabled';
}

const MAP_KEYS = ['links', 'check', 'refused', 'scenes', 'performers', 'studios', 'tags'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function emptyData() {
  return deepFreeze({
    v: 1, rev: 0, server: null, lastSync: null,
    links: {}, check: {}, refused: {}, scenes: {}, performers: {}, studios: {}, tags: {},
  });
}

const EMPTY = emptyData();
const listeners = new Set();

let data = EMPTY;
let version = 0;
let loaded = false;
let loading = null;
let loadAgain = false;
// Main's change reports carry the data's `rev` (main bumps it on every
// write). The newest one heard, whether one came while a read ran, and how
// many reports were acted on (invoke() reads them; s1-review-a RA-S1-7).
let announcedRev = null;
let reportAgain = false;
let reports = 0;
let initialized = false;
let firstLoad = null;
let enabledFn = () => false;
let syncOnStartFn = () => false;
let syncedOnStart = false;
let api = null;              // tests: _setStashApiForTests
let unsubscribers = [];

/** The preload function for one call, or null when it is not there. */
function call(name) {
  const host = api || globalThis.window?.funsync;
  const fn = host?.[STASH_API[name]];
  return typeof fn === 'function' ? fn.bind(host) : null;
}

function enabledNow() {
  try { return enabledFn() === true; } catch { return false; }
}

function notify() {
  for (const cb of [...listeners]) {
    try { cb(); } catch (err) { console.warn('[Stash] a listener failed', err); }
  }
}

/** Is `value` a projection of library.json (not an error reply)? */
export function isStashProjection(value) {
  if (!isPlainObject(value)) return false;
  return MAP_KEYS.every((k) => value[k] === undefined || isPlainObject(value[k]))
    && isPlainObject(value.links);
}

/**
 * Replace the copy with a projection main sent. Returns true when the copy
 * changed (and listeners were told). A malformed answer changes nothing.
 * Main bumps `rev` on every write (Remove and its Undo included), so the
 * same `rev` again is the same data: nothing to compare, nothing to re-index
 * (RA-S1-7: this used to stringify both copies, megabytes each).
 */
function applyProjection(next) {
  if (!isStashProjection(next)) return false;
  if (loaded && Number.isInteger(next.rev) && next.rev === data.rev) return false;
  const copy = structuredClone(next);
  for (const k of MAP_KEYS) if (!isPlainObject(copy[k])) copy[k] = {};
  data = deepFreeze(copy);
  loaded = true;
  version += 1;
  notify();
  return true;
}

export function stashData() { return data; }
export function stashVersion() { return version; }
export function stashLoaded() { return loaded; }

/**
 * The projection's Stash groups (stage sn-main's contract, Stash "next" lot
 * #6): `{[groupId]: {name, sceneIds: [sceneId in Stash's order], updatedAt}}`,
 * frozen with the copy. null when the data carries no groups map (an older
 * library.json, or none loaded): unknown, never "in no group". The playlists
 * built from it (stash-groups.js) are derived on every read, never stored.
 */
export function stashGroups() {
  return isPlainObject(data.groups) ? data.groups : null;
}

export function onStashChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Ask main for the projection and apply it. One ask at a time; a call
 * while one runs makes it ask once more. Resolves true when the copy
 * changed. A failed ask keeps the copy.
 */
export function reloadStash() {
  if (loading) {
    loadAgain = true;
    return loading;
  }
  const run = (async () => {
    let changed = false;
    do {
      loadAgain = false;
      reportAgain = false;
      const fn = call('data');
      if (!fn) break;
      try {
        if (applyProjection(await fn())) changed = true;
      } catch (err) {
        console.warn('[Stash] could not read the Stash data from main', err?.message || err);
      }
      // A report that came while this read ran asks again only for a newer
      // rev than the one just read (most reads already return it).
    } while (loadAgain || (reportAgain && !haveRev(announcedRev)));
    return changed;
  })().finally(() => {
    if (loading === run) loading = null;
  });
  loading = run;
  return run;
}

/** Is the copy main's data at `rev` (a number) already? */
function haveRev(rev) {
  return loaded && Number.isInteger(rev) && rev === data.rev;
}

/**
 * Main reported a change: apply the projection it sent, or ask for it. A
 * report `{rev}` the copy already has asks nothing; one that comes while a
 * read runs joins it (and asks again only if that read was older). One ask
 * per change, never two (RA-S1-7).
 */
function onMainChanged(payload) {
  const projection = isPlainObject(payload) && isStashProjection(payload.data) ? payload.data
    : (isStashProjection(payload) ? payload : null);
  if (projection) {
    applyProjection(projection);
    return;
  }
  if (!(loaded || enabledNow())) return;
  reports += 1;
  const rev = isPlainObject(payload) && Number.isInteger(payload.rev) ? payload.rev : null;
  if (rev === null) {
    reloadStash();
    return;
  }
  announcedRev = rev; // reports arrive in order: the latest is main's data now
  if (haveRev(rev)) return;
  if (loading) {
    reportAgain = true;
    return;
  }
  reloadStash();
}

/**
 * Once per window, at start-up. Loads the projection only when Stash is on
 * (`settings.stash.enabled === true`); this reads main's file and sends
 * nothing to Stash. Afterwards main's change reports replace the copy, and
 * the first turn-on of a session loads it.
 *
 * @param {{isEnabled?: () => boolean, isSyncOnStart?: () => boolean}} [options]
 * @returns {Promise<boolean>}
 */
export function initStashStore({ isEnabled, isSyncOnStart } = {}) {
  if (initialized) return firstLoad;
  initialized = true;
  enabledFn = typeof isEnabled === 'function' ? isEnabled : () => false;
  syncOnStartFn = typeof isSyncOnStart === 'function' ? isSyncOnStart : () => false;
  const subscribe = call('onChanged');
  if (subscribe) {
    try {
      const off = subscribe((payload) => onMainChanged(payload));
      if (typeof off === 'function') unsubscribers.push(off);
    } catch (err) {
      console.warn('[Stash] could not listen for Stash data changes', err?.message || err);
    }
  }
  unsubscribers.push(eventBus.on('settings:changed', ({ path } = {}) => {
    if (isStashSettingPath(path) && !loaded && enabledNow()) reloadStash();
  }));
  firstLoad = enabledNow() ? reloadStash() : Promise.resolve(false);
  return firstLoad;
}

/**
 * "Sync with Stash when FunSync starts" (off by default): after the first
 * library scan of a session, ONCE, main is asked to run its one start-up
 * sync (`stashSyncOnStart`; main runs it only when Stash is on, linked and
 * the setting is on, once per session). The renderer asks only when its own
 * settings say Stash is on and the setting is exactly true, so a start-up
 * with it off sends main nothing about a sync at all. Later scans never ask.
 * Returns main's reply promise, or null when nothing was asked.
 *
 * @param {Array<{path: string, size?: number, dateAdded?: number}>} videos
 */
export function stashSyncOnStart(videos) {
  if (syncedOnStart || !Array.isArray(videos) || videos.length === 0) return null;
  syncedOnStart = true;
  let wanted = false;
  try { wanted = enabledNow() && syncOnStartFn() === true; } catch { wanted = false; }
  if (!wanted) return null;
  // Its re-links (each with main's Undo token) wait in Settings' Stash
  // block, "Re-linked (n)", until the user looks (RA-S1-1).
  return invoke('syncOnStart', [{ videos: stashSyncVideos(videos) }], { changes: true })
    .then((reply) => { noteStashRelinks(reply); return reply; });
}

// ---------------------------------------------------------------------------
// This session's re-links (s1-review-a RA-S1-1). A FULL sync (Settings > Sync
// now, the start-up sync) may re-link a video to a new unique match (scenes
// merged in Stash, a changed file); main answers each with an Undo token
// (`relinked: [{path, from, to, undoId}]`). They are kept here, for this
// window only (never stored), so Settings' Stash block can list them with
// an Undo each, however the sync was started and whether or not Settings
// was open. The newest re-link of a video replaces an older one: only that
// one is still the video's link.
// ---------------------------------------------------------------------------

/** At most this many re-links are kept (the newest). */
export const MAX_STASH_RELINKS = 1000;

let relinks = Object.freeze([]);
const relinkListeners = new Set();

function notifyRelinks() {
  for (const cb of [...relinkListeners]) {
    try { cb(); } catch (err) { console.warn('[Stash] a re-link listener failed', err); }
  }
}

/**
 * Keep the re-links of a sync's reply. Returns the entries of THIS reply
 * that are kept (each with its Undo token), in the reply's order.
 *
 * @param {{relinked?: Array<{path: string, from?: string, to?: string, undoId?: string}>}} reply
 * @returns {Array<{path: string, from: string|null, to: string|null, undoId: string, at: number}>}
 */
export function noteStashRelinks(reply, { now = Date.now } = {}) {
  const list = isPlainObject(reply) && Array.isArray(reply.relinked) ? reply.relinked : [];
  const at = typeof now === 'function' ? now() : Date.now();
  const added = [];
  const seen = new Set(relinks.map((r) => r.undoId));
  for (const r of list) {
    if (!isPlainObject(r) || typeof r.path !== 'string' || !r.path) continue;
    if (typeof r.undoId !== 'string' || !r.undoId) continue;
    const entry = Object.freeze({
      path: r.path,
      from: r.from == null ? null : String(r.from),
      to: r.to == null ? null : String(r.to),
      undoId: r.undoId,
      at,
    });
    if (seen.has(entry.undoId)) {
      const known = relinks.find((x) => x.undoId === entry.undoId);
      if (known) added.push(known);
      continue;
    }
    seen.add(entry.undoId);
    added.push(entry);
  }
  const fresh = added.filter((e) => !relinks.includes(e));
  if (fresh.length === 0) return added;
  const paths = new Set(fresh.map((e) => e.path));
  const kept = relinks.filter((e) => !paths.has(e.path));
  relinks = Object.freeze([...kept, ...fresh].slice(-MAX_STASH_RELINKS));
  notifyRelinks();
  return added.filter((e) => relinks.includes(e));
}

/** This session's re-links, oldest first (frozen). */
export function stashRelinks() { return relinks; }

/** Drop re-links by their Undo token (undone, or no longer undoable). */
export function forgetStashRelinks(undoIds) {
  const drop = new Set(Array.isArray(undoIds) ? undoIds : [undoIds]);
  const next = relinks.filter((e) => !drop.has(e.undoId));
  if (next.length === relinks.length) return;
  relinks = Object.freeze(next);
  notifyRelinks();
}

/** cb() when the re-link list changed; returns an unsubscribe. */
export function onStashRelinksChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  relinkListeners.add(cb);
  return () => relinkListeners.delete(cb);
}

/** The library's videos as the sync needs them: path, size, modified time. */
export function stashSyncVideos(videos) {
  const out = [];
  for (const v of Array.isArray(videos) ? videos : []) {
    if (typeof v?.path !== 'string' || !v.path) continue;
    const item = { path: v.path };
    if (Number.isFinite(v.size)) item.size = v.size;
    const mtime = Number.isFinite(v.mtimeMs) ? v.mtimeMs : v.dateAdded;
    if (Number.isFinite(mtime) && mtime > 0) item.mtimeMs = mtime;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The IPC calls (stage s1-2a-main's contract). Each resolves main's reply,
// or `{ok: false, code: 'unavailable'}` when the call is not there or threw.
// A reply that carries a projection (`data`) replaces the copy at once; any
// other successful change reads main's data again (main's change report
// does too; the two reads share one ask and an unchanged answer is no
// change).
// ---------------------------------------------------------------------------

const UNAVAILABLE = Object.freeze({ ok: false, code: 'unavailable' });

async function invoke(name, args, { changes = false } = {}) {
  const fn = call(name);
  if (!fn) return UNAVAILABLE;
  const reportsBefore = reports;
  let reply;
  try {
    reply = await fn(...args);
  } catch (err) {
    console.warn(`[Stash] ${STASH_API[name]} failed`, err?.message || err);
    return UNAVAILABLE;
  }
  if (changes && isPlainObject(reply)) {
    if (isStashProjection(reply.data)) {
      applyProjection(reply.data);
    } else if (reply.ok !== false) {
      // Main reports its write before it answers (ordered IPC): that
      // report's read is this change's read; wait for it rather than ask
      // a second time (RA-S1-7). No report heard (nothing written, or an
      // older main): read once.
      if (reports !== reportsBefore) {
        if (loading) await loading;
      } else {
        await reloadStash();
      }
    }
  }
  return reply ?? UNAVAILABLE;
}

function subscribeTo(name, cb) {
  const fn = call(name);
  if (!fn || typeof cb !== 'function') return () => {};
  try {
    const off = fn(cb);
    return typeof off === 'function' ? off : () => {};
  } catch {
    return () => {};
  }
}

/** The link's state for Settings (settings, key storage, library, sync); never the key. */
export function stashStatus() { return invoke('status', []); }
/** Test connection: `{address, apiKey?}` (apiKey undefined = the saved key, '' = none). */
export function testStash(options) { return invoke('test', [options]); }
/** Link Stash: `{address, apiKey?}`; runs a Test, saves the address (and a new key in main). */
export function linkStash(options) { return invoke('link', [options], { changes: true }); }
/** Turn off / on, "Sync when FunSync starts", path rules: `{enabled?, syncOnStart?, pathRules?}`. */
export function setStashOptions(options) { return invoke('setOptions', [options]); }
/** Save a new API key (main only; the reply says how it is kept, never the key). */
export function saveStashKey(apiKey) { return invoke('saveKey', [apiKey]); }
/** Remove the saved API key. */
export function removeStashKey() { return invoke('removeKey', []); }
/** "Trust this certificate": `{address, fingerprint256}` as the Test reply showed it. */
export function trustStashCertificate(options) { return invoke('trustCertificate', [options]); }
/** Forget a trusted certificate. */
export function forgetStashCertificate() { return invoke('forgetCertificate', []); }
/** Main changed `settings.stash` (cb gets the whole block); returns an unsubscribe. */
export function onStashSettingsChanged(cb) { return subscribeTo('onSettingsChanged', cb); }
/** Sync now: one full sync of the library's videos. */
export function syncStash({ videos } = {}) {
  return invoke('sync', [{ videos: stashSyncVideos(videos) }], { changes: true })
    .then((reply) => { noteStashRelinks(reply); return reply; });
}
/** Sync this video (the dialog): `{path, size?, mtimeMs?}`. */
export function syncStashVideo(video) {
  const [item] = stashSyncVideos([video]);
  if (!item) return Promise.resolve(UNAVAILABLE);
  return invoke('syncVideo', [item], { changes: true });
}
/** Cancel the sync that runs (the finished batches are kept). */
export function cancelStashSync() { return invoke('cancel', []); }
/** Sync progress, `cb({kind, step, done, total})` (`step: 'finished'` with the result); returns an unsubscribe. */
export function onStashProgress(cb) { return subscribeTo('onProgress', cb); }
/** Use this scene / Use it anyway: `by: 'chosen'`. Reply: `{ok, undoId}`. */
export function chooseStashScene(path, sceneId) { return invoke('choose', [{ path, sceneId }], { changes: true }); }
/**
 * Not this scene / None of these / Ignore: `target` 'link' or 'check'.
 * `sceneId`: the scene "Not this scene…" named (RA-S1-3); main refuses only
 * that one, keeps a link that changed meanwhile (`linkChanged: true,
 * linkedSceneId`), or answers 'changed-since'. Reply: `{ok, undoId}`.
 */
export function refuseStashScene(path, target, sceneId) {
  const input = sceneId === undefined || sceneId === null ? { path, target } : { path, target, sceneId };
  return invoke('refuse', [input], { changes: true });
}
/** Unlink; with `sceneId` (the link shown) main answers 'changed-since' if it is another one now. Reply: `{ok, undoId}`. */
export function unlinkStashVideo(path, sceneId) {
  return invoke('unlink', [sceneId === undefined || sceneId === null ? { path } : { path, sceneId }], { changes: true });
}
/** A Find in Stash… pick: `by: 'manual'`. Reply: `{ok, undoId}`. */
export function linkStashScene(path, sceneId) { return invoke('linkScene', [{ path, sceneId }], { changes: true }); }
/** Undo any change above, a sync's re-link, or Remove (`undoId` exactly as main gave it). */
export function undoStash(undoId) { return invoke('undo', [undoId], { changes: true }); }
/** The scan's re-home: `[{from, to, keepSource}]`, one call. */
export function rehomeStash(moves) { return invoke('rehome', [moves], { changes: true }); }
/** Find in Stash…: one search per press (`q`), never as you type. */
export function searchStash(q) { return invoke('search', [{ q }]); }
/** Remove Stash data… (the reply's `undoId` puts it back within `undoMs`). */
export function removeStashData() { return invoke('remove', [], { changes: true }); }
/** Open in Stash: main opens `<address>/scenes/<id>` in the browser; the URL never comes back. */
export function openStashScene(path, sceneId) {
  return invoke('openScene', [sceneId === undefined ? { path } : { path, sceneId }]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Tests: forget everything (a fresh window). */
export function _resetStashStoreForTests() {
  for (const off of unsubscribers) { try { off(); } catch { /* gone */ } }
  unsubscribers = [];
  data = EMPTY;
  version = 0;
  loaded = false;
  loading = null;
  loadAgain = false;
  announcedRev = null;
  reportAgain = false;
  reports = 0;
  relinks = Object.freeze([]);
  relinkListeners.clear();
  initialized = false;
  firstLoad = null;
  enabledFn = () => false;
  syncOnStartFn = () => false;
  syncedOnStart = false;
  api = null;
  listeners.clear();
}

/** Tests: the `window.funsync` object the calls go to. */
export function _setStashApiForTests(fake) {
  api = isPlainObject(fake) ? fake : null;
}
