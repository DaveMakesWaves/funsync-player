// Video options — the data behind the per-video dialog, as pure view models
// and plans (DESIGN-video-options.md (b), (d); build stage 1d).
//
// Every function here takes what it needs as arguments and returns plain
// data. Nothing reads the store, touches the DOM or calls IPC. A change is a
// PLAN: it says what it would write (`ops`) and carries the snapshot its Undo
// needs. Planning writes nothing, so a Cancel or an Escape on a confirm
// changes nothing. `runOps` is the one place that writes, through the store
// the caller hands it (dataService in the app, a fake in the tests).
//
// Unpair funscript (Dave, 2026-11-17, answer 1): offered only when a separate
// script was added by hand as the main script, never for a pairing FunSync
// made by file name. The association keeps three slots side by side (single,
// multi-axis, custom routing; association-shape.js), so the plan says, per
// slot, what is held there, whether you made it, and what Unpair does to it:
//   - the pairing that plays (the active slot) is removed. When that is a
//     multi-axis set or a custom routing you made, the confirm names it;
//   - a multi-axis set or custom routing you saved in another slot is KEPT
//     (Change… can use it again). Unpair never clears one silently;
//   - FunSync's own leftovers (an auto-paired multi-axis slot, the video's
//     own script carried into the single slot) go with it.
// Undo writes back a deep copy of the entry as it was, so
// `associations[path]` is JSON-equal to before, every slot and the mirror
// fields included. It refuses only when a pairing you made since would be
// overwritten.
//
// Remove a set (fixup-ui, 2026-11-18): the pair dialog's ✕ that cleared every
// slot with no confirm is gone (Dave), so a Multi Axis set or Custom Routing
// you made is removed from the Script section's Saved pairings instead
// (`planRemoveSet`), with the same confirm-then-ops and exact Undo.

import { normalizeAssociation, buildAssociationEntry, resolveActiveConfig } from './association-shape.js';
import { canonicalPath } from './path-utils.js';
import { remoteVariantList } from './variant-names.js';
import { isFinished, resumeProgressFraction, formatResumeTime } from './resume-position.js';
import { isVRVideo } from './vr-detect.js';
import { isSynced, expandSyncedMembership, addVideoToCollection, removeVideoFromCollection } from './collection-sync.js';
import { isAutoHubRecord } from './eroscripts-hub.js';

/** Rail order, most used first (design (b)). */
export const SECTIONS = Object.freeze(['organise', 'tags', 'script', 'subtitles', 'playback', 'thumbnail', 'vr', 'file']);

/** Store keys the plans write. */
export const KEYS = Object.freeze({
  associations: 'library.associations',
  subtitleAssociations: 'library.subtitleAssociations',
  manualVariants: 'library.manualVariants',
  preferredVariants: 'library.preferredVariants',
  resumePositions: 'library.resumePositions',
  customThumbnails: 'library.customThumbnails',
  manualVRType: 'library.manualVRType',
  collections: 'library.collections',
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(map, key) {
  return isPlainObject(map) && typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);
}

/** A JSON copy: what the store would hold. `undefined` stays `undefined`. */
export function deepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Same file, as the library compares script paths (path-utils canonicalPath). */
function samePath(a, b) {
  if (!a || !b) return false;
  return canonicalPath(a) === canonicalPath(b);
}

/** The file name of a path ('' for none). */
export function fileName(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

/** Folder of a path ('' for a bare name). */
function folderOf(p) {
  const s = String(p || '');
  const at = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return at > 0 ? s.slice(0, at) : '';
}

/**
 * `current` with `item` put back where it was in `before`: right after the
 * nearest earlier neighbour that is still there, else right before the
 * nearest later one, else at its old index (clamped). With nothing else
 * changed this is `before` exactly. The same rule as the playlist view's
 * `reinsertRemoved` (playlists.js), for one item.
 */
export function reinsertAt(before, current, item) {
  const list = Array.isArray(current) ? current.slice() : [];
  if (list.includes(item)) return list;
  const prev = Array.isArray(before) ? before : [];
  const index = prev.indexOf(item);
  let at = -1;
  if (index >= 0) {
    for (let j = index - 1; j >= 0 && at < 0; j--) {
      const k = list.indexOf(prev[j]);
      if (k >= 0) at = k + 1;
    }
    for (let j = index + 1; j < prev.length && at < 0; j++) {
      const k = list.indexOf(prev[j]);
      if (k >= 0) at = k;
    }
  }
  if (at < 0) at = index >= 0 ? Math.min(index, list.length) : list.length;
  list.splice(at, 0, item);
  return list;
}

// ---------------------------------------------------------------------------
// Writes: plans carry ops, runOps applies them
// ---------------------------------------------------------------------------

const MAP_OPS = new Set(['setEntry', 'deleteEntry']);

/**
 * Apply a plan's ops through `store`. Map ops (`setEntry`, `deleteEntry`)
 * read the map at `key`, change one path in a COPY and set it back; several
 * in a row on one key are one write. A map that is there but is not an object
 * (a damaged config) is left alone: absence is never destructive, and neither
 * is damage. The rest call the store's own methods (dataService):
 *   addVideoToPlaylist(id, path), removeVideoFromPlaylist(id, path),
 *   setPlaylistVideoPaths(id, order), assignCategory(path, catId),
 *   unassignCategory(path, catId), and setCollectionFields, which rewrites
 *   one entry of `library.collections`.
 *
 * @param {Array<object>} ops
 * @param {{get: Function, set: Function}} store
 * @returns {{applied: number, skipped: number}}
 */
export function runOps(ops, store) {
  const list = Array.isArray(ops) ? ops : [];
  let applied = 0;
  let skipped = 0;
  let i = 0;
  while (i < list.length) {
    const op = list[i];
    if (MAP_OPS.has(op?.op)) {
      const key = op.key;
      let n = 0;
      while (i + n < list.length && MAP_OPS.has(list[i + n]?.op) && list[i + n].key === key) n++;
      const stored = store.get(key);
      if (stored != null && !isPlainObject(stored)) {
        skipped += n;
      } else {
        const map = { ...(stored || {}) };
        for (let k = 0; k < n; k++) {
          const o = list[i + k];
          if (o.op === 'setEntry') map[o.path] = deepCopy(o.value);
          else delete map[o.path];
        }
        store.set(key, map);
        applied += n;
      }
      i += n;
      continue;
    }
    switch (op?.op) {
      case 'addVideoToPlaylist': store.addVideoToPlaylist(op.id, op.path); break;
      case 'removeVideoFromPlaylist': store.removeVideoFromPlaylist(op.id, op.path); break;
      case 'setPlaylistVideoPaths': store.setPlaylistVideoPaths(op.id, op.order.slice()); break;
      case 'assignCategory': store.assignCategory(op.path, op.catId); break;
      case 'unassignCategory': store.unassignCategory(op.path, op.catId); break;
      case 'setCollectionFields': {
        const cols = store.get(KEYS.collections);
        if (!Array.isArray(cols)) { skipped++; i++; continue; }
        store.set(KEYS.collections, cols.map((c) => {
          if (c?.id !== op.id) return c;
          const next = { ...c, ...deepCopy(op.set || {}) };
          for (const f of op.unset || []) delete next[f];
          return next;
        }));
        break;
      }
      default:
        throw new Error(`video-options-model: unknown op ${op?.op}`);
    }
    applied++;
    i++;
  }
  return { applied, skipped };
}

/**
 * Change one entry of a path-keyed map (`next` undefined deletes it). The
 * plan keeps the entry as it was, deep-copied, for its Undo.
 */
export function planEntryChange({ key, map, path, next } = {}) {
  const had = hasOwn(map, path);
  const before = had ? deepCopy(map[path]) : undefined;
  const after = deepCopy(next);
  const hasAfter = after !== undefined;
  const changed = !!path && (had !== hasAfter || (had && !jsonEqual(before, after)));
  let ops = [];
  if (changed) ops = hasAfter ? [{ op: 'setEntry', key, path, value: after }] : [{ op: 'deleteEntry', key, path }];
  return { key, path, had, before, hasAfter, after, changed, ops };
}

/**
 * Undo an entry change: write back the entry as it was (or delete it when
 * there was none). Only when the entry is still as the change left it, or
 * `allowIf(current, has)` says what is there now may be replaced; anything
 * else is a newer choice, and Undo then refuses (`reason: 'changed'`).
 */
export function planEntryUndo(plan, currentMap, { allowIf } = {}) {
  if (!plan?.changed) return { ok: true, ops: [] };
  const has = hasOwn(currentMap, plan.path);
  const current = has ? currentMap[plan.path] : undefined;
  const asLeft = has === plan.hasAfter && (!has || jsonEqual(current, plan.after));
  if (!asLeft && !(typeof allowIf === 'function' && allowIf(current, has))) {
    return { ok: false, reason: 'changed', ops: [] };
  }
  const ops = plan.had
    ? [{ op: 'setEntry', key: plan.key, path: plan.path, value: deepCopy(plan.before) }]
    : [{ op: 'deleteEntry', key: plan.key, path: plan.path }];
  return { ok: true, ops };
}

// ---------------------------------------------------------------------------
// Organise: playlists, categories, libraries
// ---------------------------------------------------------------------------

/**
 * Which playlists, categories and libraries hold the video, as ticks.
 *
 * @param {object} o
 * @param {string} o.videoPath
 * @param {Array<{id, name, videoPaths}>} [o.playlists]
 * @param {Array<{id, name, color, icon}>} [o.categories]
 * @param {string[]} [o.categoryIds] videoCategories[videoPath]
 * @param {Array<object>} [o.collections] library.collections
 * @param {(col) => Set<string>} [o.membersOf] a library's members; defaults
 *   to collection-sync's rule with `sources`, `folderIndex`, `descendantsOf`
 */
export function organiseView({
  videoPath, playlists = [], categories = [], categoryIds = [], collections = [],
  membersOf, sources, folderIndex, descendantsOf,
} = {}) {
  const ids = new Set(Array.isArray(categoryIds) ? categoryIds : []);
  const members = typeof membersOf === 'function'
    ? membersOf
    : (col) => expandSyncedMembership(col, sources, folderIndex && descendantsOf ? folderIndex : null, descendantsOf);
  const pls = (Array.isArray(playlists) ? playlists : []).filter(Boolean).map((p) => {
    const paths = Array.isArray(p.videoPaths) ? p.videoPaths : [];
    const index = paths.indexOf(videoPath);
    return { id: p.id, name: p.name, checked: index >= 0, index };
  });
  const cats = (Array.isArray(categories) ? categories : []).filter(Boolean).map((c) => ({
    id: c.id, name: c.name, color: c.color || null, icon: c.icon || null, checked: ids.has(c.id),
  }));
  const cols = (Array.isArray(collections) ? collections : []).filter(Boolean).map((c) => ({
    id: c.id, name: c.name, synced: isSynced(c), checked: !!members(c)?.has?.(videoPath),
  }));
  return {
    playlists: pls,
    categories: cats,
    collections: cols,
    counts: {
      playlists: pls.filter((p) => p.checked).length,
      categories: cats.filter((c) => c.checked).length,
      collections: cols.filter((c) => c.checked).length,
    },
  };
}

/** Tick (`checked` true) or untick a playlist. Untick keeps the index for Undo. */
export function planPlaylistToggle({ playlist, videoPath, checked } = {}) {
  const paths = Array.isArray(playlist?.videoPaths) ? playlist.videoPaths : [];
  const index = paths.indexOf(videoPath);
  const kind = checked ? 'playlist-tick' : 'playlist-untick';
  const base = { kind, playlistId: playlist?.id, name: playlist?.name ?? '', videoPath, index, before: paths.slice() };
  if (!playlist || !videoPath || (checked ? index >= 0 : index < 0)) return { ...base, changed: false, ops: [] };
  const op = checked ? 'addVideoToPlaylist' : 'removeVideoFromPlaylist';
  return { ...base, changed: true, ops: [{ op, id: playlist.id, path: videoPath }] };
}

/**
 * Undo a playlist tick or untick against the playlist as it is NOW. An
 * untick's video goes back to its old index (store.js adds at the end, so
 * the add is followed by a pure reorder); a reorder or another change made
 * since is kept. A playlist deleted since gives `reason: 'gone'`.
 */
export function planPlaylistUndo(plan, currentPlaylist) {
  if (!plan?.changed) return { ok: true, ops: [] };
  if (!currentPlaylist) return { ok: false, reason: 'gone', ops: [] };
  const id = plan.playlistId;
  const path = plan.videoPath;
  const cur = Array.isArray(currentPlaylist.videoPaths) ? currentPlaylist.videoPaths : [];
  if (plan.kind === 'playlist-tick') {
    return { ok: true, ops: cur.includes(path) ? [{ op: 'removeVideoFromPlaylist', id, path }] : [] };
  }
  if (cur.includes(path)) return { ok: true, ops: [] };
  const order = reinsertAt(plan.before, cur, path);
  const ops = [{ op: 'addVideoToPlaylist', id, path }];
  if (order.indexOf(path) !== cur.length) ops.push({ op: 'setPlaylistVideoPaths', id, order });
  return { ok: true, ops };
}

/** Tick or untick a category on the video. */
export function planCategoryToggle({ videoPath, categoryIds, category, checked } = {}) {
  const ids = Array.isArray(categoryIds) ? categoryIds : [];
  const catId = category?.id;
  const index = ids.indexOf(catId);
  const kind = checked ? 'category-tick' : 'category-untick';
  const base = { kind, catId, name: category?.name ?? '', videoPath, index, before: ids.slice() };
  if (!videoPath || catId == null || (checked ? index >= 0 : index < 0)) return { ...base, changed: false, ops: [] };
  return { ...base, changed: true, ops: [{ op: checked ? 'assignCategory' : 'unassignCategory', path: videoPath, catId }] };
}

/**
 * Undo a category tick or untick. The store only appends (assign) and
 * filters (unassign), so putting an id back in its old place unassigns the
 * ids after that place and assigns them again in order:
 * [a, b] → [a, X, b] is unassign b, assign X, assign b.
 */
export function planCategoryUndo(plan, currentIds) {
  if (!plan?.changed) return { ok: true, ops: [] };
  const cur = Array.isArray(currentIds) ? currentIds : [];
  const path = plan.videoPath;
  if (plan.kind === 'category-tick') {
    return { ok: true, ops: cur.includes(plan.catId) ? [{ op: 'unassignCategory', path, catId: plan.catId }] : [] };
  }
  if (cur.includes(plan.catId)) return { ok: true, ops: [] };
  const target = reinsertAt(plan.before, cur, plan.catId);
  let p = 0;
  while (p < cur.length && cur[p] === target[p]) p++;
  const ops = [
    ...cur.slice(p).map((catId) => ({ op: 'unassignCategory', path, catId })),
    ...target.slice(p).map((catId) => ({ op: 'assignCategory', path, catId })),
  ];
  return { ok: true, ops };
}

/**
 * Tick or untick a library (collection). A synced library's membership is
 * its folder plus an include list minus an exclude list (collection-sync.js),
 * so a change may touch either list; the plan notes which, for its Undo.
 */
export function planCollectionToggle({ collection, videoPath, checked, sources, folderIndex, descendantsOf } = {}) {
  const kind = checked ? 'collection-tick' : 'collection-untick';
  const base = { kind, collectionId: collection?.id, name: collection?.name ?? '', videoPath };
  if (!collection || !videoPath) return { ...base, changed: false, edits: [], ops: [] };
  const fn = checked ? addVideoToCollection : removeVideoFromCollection;
  const index = folderIndex && descendantsOf ? folderIndex : null;
  const { changed, col } = fn(collection, videoPath, sources, index, descendantsOf);
  if (!changed) return { ...base, changed: false, edits: [], ops: [] };
  const edits = [];
  const set = {};
  for (const field of ['videoPaths', 'excludedPaths']) {
    const before = Array.isArray(collection[field]) ? collection[field] : null;
    const after = Array.isArray(col[field]) ? col[field] : null;
    if (jsonEqual(before, after)) continue;
    const added = !!after?.includes(videoPath) && !before?.includes(videoPath);
    edits.push({ field, change: added ? 'added' : 'removed', before: before ? before.slice() : null });
    set[field] = after ? after.slice() : [];
  }
  return { ...base, changed: true, edits, ops: [{ op: 'setCollectionFields', id: collection.id, set, unset: [] }] };
}

/** Undo a library tick or untick, touching only this video in each list. */
export function planCollectionUndo(plan, currentCollection) {
  if (!plan?.changed) return { ok: true, ops: [] };
  if (!currentCollection) return { ok: false, reason: 'gone', ops: [] };
  const path = plan.videoPath;
  const set = {};
  const unset = [];
  for (const e of plan.edits || []) {
    const cur = Array.isArray(currentCollection[e.field]) ? currentCollection[e.field] : null;
    if (e.change === 'added') {
      if (!cur?.includes(path)) continue;
      const next = cur.filter((p) => p !== path);
      if (next.length === 0 && e.before === null) unset.push(e.field);
      else set[e.field] = next;
    } else if (!cur?.includes(path)) {
      set[e.field] = reinsertAt(e.before || [], cur || [], path);
    }
  }
  const ops = Object.keys(set).length || unset.length
    ? [{ op: 'setCollectionFields', id: plan.collectionId, set, unset }] : [];
  return { ok: true, ops };
}

// ---------------------------------------------------------------------------
// Script: the association's slots, the pairing, Unpair
// ---------------------------------------------------------------------------

function axisPaths(multi) {
  return Object.values(isPlainObject(multi?.axes) ? multi.axes : {}).filter((p) => typeof p === 'string' && p);
}

/**
 * The three slots of `associations[videoPath]`, in any stored shape:
 * what each holds, whether it is the one that plays, and whether you made
 * it. A slot is `held` when it has anything in it, `applied` when the
 * library would play it (association-shape `hasConfigForMode`, and a custom
 * routing needs its main route's script, as `_applyManualAssociations`).
 *   single  you made it when it is the active slot (every single write is a
 *           user action), or when it holds a script other than the video's
 *           own and other than an auto-paired multi-axis main (those are
 *           FunSync's carry-overs);
 *   multi   you made it unless `autoAssigned` (FunSync paired the axis files
 *           by name, V41);
 *   custom  always yours: only the Associate dialog makes one.
 *
 * @param {*} raw associations[videoPath]
 * @param {{ownScriptPath?: string|null}} [o] the script the scan paired by name
 */
export function associationSlots(raw, { ownScriptPath = null } = {}) {
  const entry = normalizeAssociation(raw);
  const active = raw == null ? null : entry.active;
  const multi = isPlainObject(entry.multi) ? entry.multi : null;
  const routes = Array.isArray(entry.custom?.routes) ? entry.custom.routes.filter(Boolean) : [];
  const autoMulti = !!multi?.autoAssigned;

  const single = typeof entry.single === 'string' && entry.single ? entry.single : null;
  const singleHand = !!single && (active === 'single'
    || (!samePath(single, ownScriptPath) && !(autoMulti && samePath(single, multi.main))));

  const axes = axisPaths(multi);
  const multiMain = typeof multi?.main === 'string' && multi.main ? multi.main : null;
  const multiHeld = !!multiMain || axes.length > 0;

  const mainRoute = routes.find((r) => r.role === 'main');
  const customMain = typeof mainRoute?.scriptPath === 'string' && mainRoute.scriptPath ? mainRoute.scriptPath : null;
  const routeScripts = [...new Set(routes.map((r) => r.scriptPath).filter((p) => typeof p === 'string' && p))];
  // A single slot that does not play and only repeats a set's main script
  // is that set's carry-over (the library's scan back-fills it so Change…
  // can go back to single; library.js `_applyManualAssociations`), not a
  // pairing of its own. Display only: `hand` and every plan stay as they are.
  const carryOver = !!single && active !== 'single'
    && (samePath(single, multiMain) || samePath(single, customMain));

  return [
    {
      slot: 'single', active: active === 'single', held: !!single, applied: !!single,
      hand: singleHand, auto: false, main: single, paths: single ? [single] : [], carryOver,
    },
    {
      slot: 'multi', active: active === 'multi', held: multiHeld, applied: multiHeld,
      hand: multiHeld && !autoMulti, auto: multiHeld && autoMulti, main: multiMain,
      axisCount: axes.length, paths: multiMain ? [multiMain, ...axes] : axes,
    },
    {
      slot: 'custom', active: active === 'custom', held: routes.length > 0, applied: !!customMain,
      hand: routes.length > 0, auto: false, main: customMain,
      routeCount: routes.length, paths: routeScripts,
    },
  ];
}

/** Names of the slots you made ('single' | 'multi' | 'custom'). */
export function handMadeSlots(raw, { ownScriptPath = null } = {}) {
  if (raw == null) return [];
  return associationSlots(raw, { ownScriptPath }).filter((s) => s.held && s.hand).map((s) => s.slot);
}

/**
 * How the video's script is paired.
 *   kind: 'single' | 'multi' | 'custom' (you made it), 'auto-multi' (FunSync
 *   paired the script and its axis files by name), 'by-name', 'folder' (the
 *   first script of a one-video folder, FT-102), 'stream' (a saved stream's
 *   own script, picked when the link was saved), 'none'.
 */
function pairingOf(slots, input) {
  const playing = slots.find((s) => s.active && s.applied);
  if (playing) {
    if (playing.slot === 'multi' && playing.auto) return { kind: 'auto-multi', hand: false, main: playing.main };
    return { kind: playing.slot, hand: true, main: playing.main };
  }
  const shown = input.funscriptPath || null;
  // A saved stream's script was picked when its link was saved (Load from
  // URL, EroScripts Watch), never matched by a file name: it said "Paired by
  // name" and "Rename or move the .funscript to unpair it", which would only
  // have broken another video's pairing (test day 2026-11-26, B101). A
  // script chosen with Change… is an association and is caught above.
  if (shown && /^stream:/.test(String(input.videoPath || ''))) return { kind: 'stream', hand: false, main: shown };
  if (input.folderVariantMain && shown) return { kind: 'folder', hand: false, main: shown };
  const own = input.ownScriptPath !== undefined ? input.ownScriptPath : shown;
  if (own || shown) return { kind: 'by-name', hand: false, main: own || shown };
  return { kind: 'none', hand: false, main: null };
}

/** The script the scan paired by name: given, or what plays when no pairing you made does. */
function ownOf(input, pairing) {
  if (input.ownScriptPath !== undefined) return input.ownScriptPath || null;
  if (pairing.hand || input.folderVariantMain) return null;
  return input.funscriptPath || null;
}

/**
 * What the EroScripts record (library.scriptTags[videoPath]) says about the
 * script the video has now:
 *   'none'            no record;
 *   'unknown'         the record does not name its script (the records saved
 *                     before record v2): its tags count, as video-tags.js does;
 *   'applies'         it names this script;
 *   'another-script'  it names another script, or the video has none now: its
 *                     tags do not show. Ignored, never deleted: an Undo brings
 *                     them back with no write.
 */
export function eroscriptsRecordState(record, scriptPath) {
  if (!isPlainObject(record)) return 'none';
  if (typeof record.scriptPath !== 'string' || !record.scriptPath) return 'unknown';
  // No script now. A post the VIDEO came from (the EroScripts tab's download,
  // `videoFromPost`) still applies: the video is that post's, whether its
  // script never came (the post had none, or it did not save) or is gone
  // (Dave, 2026-11-25: "when downloading a video and script to the libary
  // why doesnt it also get the tags?"; reproduced: Video options showed
  // none, "This video has no script"). A post only a SCRIPT came from (Get
  // Script, a link, a search) was about that script: set aside, as after an
  // Unpair.
  if (!scriptPath) return record.videoFromPost === true ? 'applies' : 'another-script';
  const fold = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return fold(record.scriptPath) === fold(scriptPath) ? 'applies' : 'another-script';
}

/**
 * The record to hand the tag merge (video-tags.js `effectiveTags`), or null
 * when it names another script. `effectiveTags` already ignores a record
 * about another script, but takes a missing `scriptPath` as UNKNOWN and then
 * shows the tags; a video left with no script after Unpair needs this.
 * Null too for a record about a creator's index / hub post you did not pick
 * (eroscripts-hub.js, Dave 2026-11-19): a hub's tags are never the video's.
 * The record is kept as it is; the next post you link replaces it.
 */
export function eroscriptsRecordForTags(record, scriptPath) {
  if (isAutoHubRecord(record)) return null;
  return eroscriptsRecordState(record, scriptPath) === 'another-script' ? null : (record ?? null);
}

/** Why Unpair is not offered, as the line to show instead (null: say nothing). */
const NOT_OFFERED_KEY = Object.freeze({
  'by-name': 'videoOptions.script.unpair.byName',
  'auto-multi': 'videoOptions.script.unpair.autoMulti',
  folder: 'videoOptions.script.unpair.folder',
  'own-script': 'videoOptions.script.unpair.ownScript',
  stream: 'videoOptions.script.unpair.stream',
  'no-main': 'videoOptions.script.unpair.noMain',
  none: null,
});

/** The pairing line's key per kind (`videoOptions.script.pairing.*`). */
const PAIRING_KEY = Object.freeze({
  none: 'none', 'by-name': 'byName', folder: 'folder', 'auto-multi': 'autoMulti',
  single: 'single', multi: 'multi', custom: 'custom', stream: 'stream',
});

function unpairOffer(pairing, own) {
  if (!pairing.hand) return { offered: false, reason: pairing.kind === 'auto-multi' ? 'auto-multi' : pairing.kind };
  if (!pairing.main) return { offered: false, reason: 'no-main' };
  if (own && samePath(pairing.main, own)) return { offered: false, reason: 'own-script' };
  return { offered: true, reason: 'hand-added' };
}

/**
 * The Script section's data.
 *
 * @param {object} input
 * @param {string} input.videoPath
 * @param {*} input.association associations[videoPath], any shape, or undefined
 * @param {string|null} [input.ownScriptPath] the script the scan paired by
 *   name (library: `video._ownFunscriptPath`); left out, it is what plays when
 *   no pairing you made does
 * @param {string|null} [input.funscriptPath] what the video plays now
 * @param {boolean} [input.folderVariantMain] `video._folderVariantMain`
 * @param {string|null} [input.fallbackFrom] `video._assocFallbackFrom`: your
 *   script cannot be read, the video plays its own for now (R4-06)
 * @param {true|false|null} [input.mainStatus] the library's `_pathStatus`
 *   answer for the main script: false only on PROVEN absence, null unknown
 *   (offline, timed out). Left out: not checked, and no status is shown.
 * @param {object} [input.scriptTagRecord] library.scriptTags[videoPath]
 */
export function scriptView(input = {}) {
  const prelim = associationSlots(input.association, { ownScriptPath: input.ownScriptPath ?? null });
  const pairing = pairingOf(prelim, input);
  const own = ownOf(input, pairing);
  const slots = associationSlots(input.association, { ownScriptPath: own });
  const status = pairing.main && input.mainStatus !== undefined ? statusWord(input.mainStatus) : null;
  const offer = unpairOffer(pairing, own);
  const active = slots.find((s) => s.active && s.applied);
  return {
    videoPath: input.videoPath,
    pairing: { kind: pairing.kind, hand: pairing.hand, labelKey: `videoOptions.script.pairing.${PAIRING_KEY[pairing.kind]}` },
    main: pairing.main ? { path: pairing.main, name: fileName(pairing.main) } : null,
    status,
    statusKey: status === 'missing' || status === 'unknown' ? `videoOptions.script.status.${status}` : null,
    fallback: input.fallbackFrom ? { from: input.fallbackFrom, playing: input.funscriptPath || null } : null,
    mode: {
      kind: active ? active.slot : null,
      axisCount: active?.slot === 'multi' ? active.axisCount : 0,
      routeCount: active?.slot === 'custom' ? active.routeCount : 0,
    },
    slots,
    ownScriptPath: own,
    unpair: {
      offered: offer.offered,
      reason: offer.reason,
      explanationKey: offer.offered ? null : (NOT_OFFERED_KEY[offer.reason] ?? null),
    },
    eroscripts: { state: eroscriptsRecordState(input.scriptTagRecord, pairing.main) },
  };
}

function statusWord(answer) {
  if (answer === true) return 'present';
  if (answer === false) return 'missing';
  return 'unknown';
}

/**
 * The Unpair plan: what Unpair would do to each slot, the entry it leaves
 * (or none), what plays next, and the snapshot its Undo writes back. Pure:
 * nothing changes until the caller runs `plan.ops` after the confirm.
 *
 * Per slot, `change` is:
 *   'remove'  the pairing that plays, or FunSync's leftover beside it (an
 *             auto-paired multi-axis slot, the video's own script or the
 *             unpaired script carried into the single slot);
 *   'keep'    a single script, multi-axis set or custom routing you saved in
 *             another slot: it stays, for Change… to use again;
 *   'empty'   nothing there.
 * No slot kept: the whole entry goes, mirrors included (as the old ⋮
 * menu's Remove did). Something kept: the entry stays with
 * `active: null`, so nothing it holds plays.
 *
 * @param {object} input as scriptView
 */
export function planUnpair(input = {}) {
  const view = scriptView(input);
  const videoPath = input.videoPath;
  const raw = input.association;
  const base = {
    kind: 'unpair', videoPath, offered: view.unpair.offered, reason: view.unpair.reason,
    explanationKey: view.unpair.explanationKey,
  };
  if (!view.unpair.offered || !videoPath) {
    return { ...base, offered: false, slots: view.slots.map((s) => ({ ...s, change: null })), ops: [] };
  }
  const target = view.main.path;
  const slots = view.slots.map((s) => {
    let change;
    if (!s.held) change = 'empty';
    else if (s.active) change = 'remove';
    else if (s.slot === 'single') change = !s.hand || samePath(s.main, target) ? 'remove' : 'keep';
    else if (s.slot === 'multi') change = s.hand ? 'keep' : 'remove';
    else change = 'keep';
    return { ...s, change };
  });
  const keep = (slot) => slots.find((s) => s.slot === slot).change === 'keep';
  const entry = normalizeAssociation(raw);
  const kept = slots.some((s) => s.change === 'keep');
  const next = kept
    ? buildAssociationEntry(
      null,
      keep('single') ? entry.single : null,
      keep('multi') ? deepCopy(entry.multi) : null,
      keep('custom') ? deepCopy(entry.custom) : null,
    )
    : undefined;
  // Offered means a pairing you made plays, so `raw` is there.
  const change = planEntryChange({ key: KEYS.associations, map: { [videoPath]: raw }, path: videoPath, next });
  const own = view.ownScriptPath;
  const active = slots.find((s) => s.active);
  return {
    ...base,
    ownScriptPath: own,
    target: { slot: active.slot, path: target, name: fileName(target) },
    slots,
    removesHandMadeSet: active.slot === 'multi' || active.slot === 'custom',
    keeps: slots.filter((s) => s.change === 'keep').map((s) => s.slot),
    deletesEntry: !kept,
    next: deepCopy(next) ?? null,
    playsNext: own ? { kind: 'own', path: own, name: fileName(own) } : { kind: 'none', path: null, name: '' },
    snapshot: { key: KEYS.associations, path: videoPath, had: change.had, entry: change.before },
    change,
    ops: change.ops,
    writes: [KEYS.associations],
    // Your script could not be read and the video played its own meanwhile
    // (R4-06): its Undo puts that back too, not only the store.
    fallbackFrom: input.fallbackFrom || null,
  };
}

/**
 * The confirm's words, as i18n keys and params (design (d)): the question,
 * what plays next, then one line for each set you made that Unpair removes
 * or keeps.
 */
export function unpairConfirmMessages(plan) {
  if (!plan?.offered) return null;
  const lines = [
    { key: 'videoOptions.script.unpair.confirmQuestion', params: { name: plan.target.name } },
    plan.playsNext.kind === 'own'
      ? { key: 'videoOptions.script.unpair.nextOwn', params: { name: plan.playsNext.name } }
      : { key: 'videoOptions.script.unpair.nextNone', params: {} },
  ];
  for (const s of plan.slots) {
    // A carry-over single is the set's own main script: the set's line says it.
    if (!s.hand || s.carryOver) continue;
    if (s.change === 'remove' && s.active && s.slot === 'multi') {
      lines.push({ key: 'videoOptions.script.unpair.removesMulti', params: { count: s.axisCount } });
    } else if (s.change === 'remove' && s.active && s.slot === 'custom') {
      lines.push({ key: 'videoOptions.script.unpair.removesCustom', params: { count: s.routeCount } });
    } else if (s.change === 'keep' && s.slot === 'single') {
      lines.push({ key: 'videoOptions.script.unpair.keepsSingle', params: { name: fileName(s.main) } });
    } else if (s.change === 'keep' && s.slot === 'multi') {
      lines.push({ key: 'videoOptions.script.unpair.keepsMulti', params: { count: s.axisCount } });
    } else if (s.change === 'keep' && s.slot === 'custom') {
      lines.push({ key: 'videoOptions.script.unpair.keepsCustom', params: { count: s.routeCount } });
    }
  }
  return {
    titleKey: 'videoOptions.script.unpair.confirmTitle',
    confirmKey: 'videoOptions.script.unpair.confirmButton',
    lines,
    doneMessage: { key: 'videoOptions.script.unpair.done', params: { name: plan.target.name } },
  };
}

/**
 * Undo an Unpair against the associations map as it is NOW. Writes back the
 * entry exactly as it was (JSON-equal, every slot and mirror field). Refuses
 * (`reason: 'changed'`) only when the entry now holds a pairing you made
 * since: that newer choice wins. FunSync's own re-pairing since (an
 * auto-paired multi-axis slot) does not block it. `reapply` is the active
 * config again, for the library's apply path (`_syncVideoStateForActive`).
 */
export function planUnpairUndo(plan, currentAssociations) {
  if (!plan?.offered || !plan.change) return { ok: false, reason: 'nothing', ops: [] };
  const left = normalizeAssociation(plan.change.after ?? null);
  const undo = planEntryUndo(plan.change, currentAssociations, {
    // Every slot you made that is there now was there when Unpair left the
    // entry: nothing of yours is newer than the Unpair. An entry it left that
    // is gone now was removed by you since (Unpair, Remove: nothing else
    // deletes one, Dave 2026-11-18 "Stop pruning"): that newer choice wins
    // too, so an older Undo (a toast still up) never writes back over it.
    allowIf: (current, has) => {
      if (!has) return false;
      const now = normalizeAssociation(current);
      return handMadeSlots(current, { ownScriptPath: plan.ownScriptPath })
        .every((slot) => jsonEqual(now[slot], left[slot]));
    },
  });
  if (!undo.ok) return { ...undo, message: { key: 'videoOptions.script.unpair.undoChanged', params: {} } };
  const resolved = resolveActiveConfig(normalizeAssociation(plan.snapshot.entry));
  return {
    ...undo,
    reapply: resolved ? { kind: resolved.kind, config: deepCopy(resolved.config) } : null,
    message: { key: 'videoOptions.script.unpair.undone', params: { name: plan.target.name } },
  };
}

/**
 * Remove a Multi Axis set, a Custom Routing or a single script you made
 * (the Script section's Saved pairings list). The pair dialog's ✕ that
 * cleared every slot with no confirm and no Undo is gone (Dave, 2026-11-18),
 * so this is where one goes away. Offered for one you made that Unpair does
 * not already cover:
 *   - a single script you saved that does not play (Dave, 2026-11-18, "Yes,
 *     add Remove"): only the single slot goes, what plays does not change.
 *     Not the playing single (that is Unpair), not the video's own script
 *     (Dave's Round 1 answer 2), not a set's carry-over;
 *   - a saved one (not the active slot): only that slot goes, what plays
 *     does not change;
 *   - the active one when Unpair is not offered (its main script is the
 *     video's own, Dave's Round 1 answer 2, or it has no main script): it
 *     goes with FunSync's leftovers as an Unpair's would, another set you
 *     made is kept, and the video plays its own script.
 * An entry left with nothing in it goes. Same plan shape as `planUnpair`,
 * so the library's in-memory side and `planUnpairUndo` apply to it.
 *
 * @param {object} input as scriptView
 * @param {'single'|'multi'|'custom'} slotName
 */
export function planRemoveSet(input = {}, slotName) {
  const view = scriptView(input);
  const videoPath = input.videoPath;
  const slot = view.slots.find((s) => s.slot === slotName);
  const coveredByUnpair = !!slot?.active && view.unpair.offered;
  const singleNotOffered = slotName === 'single'
    && (!!slot?.active || !!slot?.carryOver || samePath(slot?.main, view.ownScriptPath));
  const offered = !!videoPath && !!slot?.held && !!slot.hand && !coveredByUnpair && !singleNotOffered;
  const base = { kind: 'removeSet', videoPath, slot: slotName, offered };
  if (!offered) return { ...base, ops: [] };

  const playing = slot.active;
  const slots = view.slots.map((s) => {
    let change;
    if (!s.held) change = 'empty';
    else if (s.slot === slotName) change = 'remove';
    else if (!playing) change = 'keep';
    else if (s.slot === 'single') change = s.hand && !samePath(s.main, slot.main) ? 'keep' : 'remove';
    else change = s.hand ? 'keep' : 'remove';
    return { ...s, change };
  });
  const keep = (name) => slots.find((s) => s.slot === name).change === 'keep';
  const entry = normalizeAssociation(input.association);
  const kept = slots.some((s) => s.change === 'keep');
  const next = kept
    ? buildAssociationEntry(
      playing ? null : entry.active,
      keep('single') ? entry.single : null,
      keep('multi') ? deepCopy(entry.multi) : null,
      keep('custom') ? deepCopy(entry.custom) : null,
    )
    : undefined;
  const change = planEntryChange({ key: KEYS.associations, map: { [videoPath]: input.association }, path: videoPath, next });
  const own = view.ownScriptPath;
  let words = { key: 'videoOptions.script.modeCustom', params: { count: slot.routeCount } };
  if (slotName === 'multi') words = { key: 'videoOptions.script.slot.multi', params: { count: slot.axisCount } };
  else if (slotName === 'single') words = { key: 'videoOptions.script.slot.single', params: { name: fileName(slot.main) } };
  return {
    ...base,
    playing,
    ownScriptPath: own,
    target: { slot: slotName, path: slot.main, name: slot.main ? fileName(slot.main) : '', words },
    slots,
    axisCount: slot.axisCount || 0,
    routeCount: slot.routeCount || 0,
    keeps: slots.filter((s) => s.change === 'keep').map((s) => s.slot),
    deletesEntry: !kept,
    next: deepCopy(next) ?? null,
    playsNext: !playing ? { kind: 'same', path: null, name: '' }
      : own ? { kind: 'own', path: own, name: fileName(own) } : { kind: 'none', path: null, name: '' },
    snapshot: { key: KEYS.associations, path: videoPath, had: change.had, entry: change.before },
    change,
    ops: change.ops,
    writes: [KEYS.associations],
    fallbackFrom: input.fallbackFrom || null,
  };
}

/** The Remove-a-set confirm's words, as i18n keys and params. */
export function removeSetConfirmMessages(plan) {
  if (!plan?.offered) return null;
  const k = plan.slot;
  const question = {
    single: { key: 'videoOptions.script.removeSet.singleQuestion', params: { name: plan.target.name } },
    multi: { key: 'videoOptions.script.removeSet.multiQuestion', params: { count: plan.axisCount } },
    custom: { key: 'videoOptions.script.removeSet.customQuestion', params: { count: plan.routeCount } },
  }[k];
  const lines = [question];
  if (plan.playsNext.kind === 'same') lines.push({ key: 'videoOptions.script.removeSet.playsSame', params: {} });
  else if (plan.playsNext.kind === 'own') lines.push({ key: 'videoOptions.script.unpair.nextOwn', params: { name: plan.playsNext.name } });
  else lines.push({ key: 'videoOptions.script.unpair.nextNone', params: {} });
  if (plan.playing) {
    for (const s of plan.slots) {
      if (s.change !== 'keep' || !s.hand || s.carryOver) continue;
      if (s.slot === 'single') lines.push({ key: 'videoOptions.script.unpair.keepsSingle', params: { name: fileName(s.main) } });
      else if (s.slot === 'multi') lines.push({ key: 'videoOptions.script.unpair.keepsMulti', params: { count: s.axisCount } });
      else lines.push({ key: 'videoOptions.script.unpair.keepsCustom', params: { count: s.routeCount } });
    }
  }
  return {
    titleKey: `videoOptions.script.removeSet.${k}Title`,
    confirmKey: 'common.remove',
    lines,
    doneMessage: { key: `videoOptions.script.removeSet.${k}Done`, params: k === 'single' ? { name: plan.target.name } : {} },
  };
}

/**
 * Undo a set's removal: the entry back JSON-equal, as `planUnpairUndo` (a
 * pairing you made since wins). `reapply` is what plays again when the set
 * was the playing one.
 */
export function planRemoveSetUndo(plan, currentAssociations) {
  const undo = planUnpairUndo(plan, currentAssociations);
  if (!undo.ok) return undo;
  return {
    ...undo,
    message: {
      key: `videoOptions.script.removeSet.${plan.slot}Undone`,
      params: plan.slot === 'single' ? { name: plan.target.name } : {},
    },
  };
}

// ---------------------------------------------------------------------------
// Script: Locate a script that is not found (Dave, 2026-11-18)
// ---------------------------------------------------------------------------

/** `raw` (any stored shape) with the playing slot's main script `from` → `to`; nothing else. */
function withMainScriptReplaced(raw, slot, from, to) {
  if (typeof raw === 'string') return to;
  const copy = deepCopy(raw);
  const routesSwap = (routes) => {
    for (const r of Array.isArray(routes) ? routes : []) {
      if (r?.role !== 'main' || !samePath(r.scriptPath, from)) continue;
      // The route's file name says which file it is: it follows the path.
      if (typeof r.scriptName === 'string' && r.scriptName === fileName(r.scriptPath)) r.scriptName = fileName(to);
      r.scriptPath = to;
    }
  };
  if (isPlainObject(copy) && 'active' in copy) {
    if (slot === 'single') copy.single = to;
    else if (slot === 'multi' && isPlainObject(copy.multi)) {
      copy.multi.main = to;
      if (samePath(copy.main, from)) copy.main = to;            // the mirror
    } else if (slot === 'custom' && isPlainObject(copy.custom)) {
      routesSwap(copy.custom.routes);
      routesSwap(copy.routes);                                    // the mirror
    }
    return copy;
  }
  // Shapes from before the three slots.
  if (copy?.mode === 'custom') routesSwap(copy.routes);
  else if (isPlainObject(copy) && samePath(copy.main, from)) copy.main = to;
  return copy;
}

/**
 * Can the playing pairing's script be located? Only when it is stored in the
 * association (its playing slot holds the script the section names): a
 * pairing by file name or a folder's first script has nothing stored.
 * @param {object} input as scriptView
 */
export function canLocateMain(input = {}) {
  const view = scriptView(input);
  const from = view.main?.path || null;
  const playing = view.slots.find((s) => s.active && s.applied);
  return !!input.videoPath && !!from && input.association != null && !!playing && samePath(playing.main, from);
}

/**
 * Locate the playing pairing's script: the file you pick replaces only that
 * path (the playing slot's main script: the single script, the Multi Axis
 * set's main, or the Custom Routing's main route), every other field kept.
 * Offered only for a pairing stored in the association (a pairing by name
 * has nothing stored to change). `reapply` is the new active config for the
 * library's apply path; Undo with `planLocateUndo`.
 *
 * @param {object} input as scriptView
 * @param {string} to the file picked
 */
export function planLocateMain(input = {}, to) {
  const view = scriptView(input);
  const videoPath = input.videoPath;
  const from = view.main?.path || null;
  const playing = view.slots.find((s) => s.active && s.applied);
  const base = { kind: 'locate', what: 'main', videoPath, from, to: to || null };
  if (!canLocateMain(input) || typeof to !== 'string' || !to || samePath(from, to)) {
    return { ...base, offered: false, ops: [] };
  }
  const next = withMainScriptReplaced(input.association, playing.slot, from, to);
  const change = planEntryChange({ key: KEYS.associations, map: { [videoPath]: input.association }, path: videoPath, next });
  const resolved = resolveActiveConfig(normalizeAssociation(next));
  return {
    ...base,
    offered: change.changed,
    slot: playing.slot,
    name: fileName(from),
    newName: fileName(to),
    change,
    ops: change.ops,
    reapply: resolved ? { kind: resolved.kind, config: deepCopy(resolved.config) } : null,
    writes: [KEYS.associations],
  };
}

/**
 * Locate a variation you added: the picked file replaces its `path` (and
 * its `name`, when that was the old file's name); its label and every other
 * variation are kept.
 */
export function planLocateVariation({ videoPath, manualVariants, from, to } = {}) {
  const base = { kind: 'locate', what: 'variation', videoPath, from: from || null, to: to || null };
  const list = isPlainObject(manualVariants) && Array.isArray(manualVariants[videoPath]) ? manualVariants[videoPath] : null;
  const at = list ? list.findIndex((v) => samePath(v?.path, from)) : -1;
  if (at < 0 || typeof to !== 'string' || !to || samePath(from, to)) return { ...base, offered: false, ops: [] };
  const next = deepCopy(list);
  if (typeof next[at].name === 'string' && next[at].name === fileName(list[at].path)) next[at].name = fileName(to);
  next[at].path = to;
  const change = planEntryChange({ key: KEYS.manualVariants, map: manualVariants, path: videoPath, next });
  return { ...base, offered: change.changed, name: fileName(from), newName: fileName(to), change, ops: change.ops, writes: [KEYS.manualVariants] };
}

/**
 * Undo a Locate: the entry back JSON-equal, only while it is as the Locate
 * left it (anything since is a newer choice of yours). `reapply` (main) is
 * the old active config.
 */
export function planLocateUndo(plan, currentMap) {
  if (!plan?.offered || !plan.change) return { ok: false, reason: 'nothing', ops: [] };
  const undo = planEntryUndo(plan.change, currentMap);
  if (!undo.ok) return { ...undo, message: { key: 'videoOptions.live.undoChanged', params: {} } };
  const resolved = plan.what === 'main' ? resolveActiveConfig(normalizeAssociation(plan.change.before)) : null;
  return {
    ...undo,
    reapply: resolved ? { kind: resolved.kind, config: deepCopy(resolved.config) } : null,
    message: { key: 'videoOptions.script.locate.undone', params: { name: plan.name } },
  };
}

// ---------------------------------------------------------------------------
// Script: variations
// ---------------------------------------------------------------------------

/**
 * The Variations block: the menu's own list (variant-names.js
 * `remoteVariantList`), each entry marked by where it came from ('folder':
 * the scan or the association; 'added': `library.manualVariants`, which
 * Remove can take out), which one plays first, and whether "Random variant on
 * play" overrides the pin (variant-select.js: random beats the pin).
 *
 * @param {object} o
 * @param {{path, variants, funscriptPath}} o.video
 * @param {Array} [o.manual] manualVariants[video.path]
 * @param {string|null} [o.preferredLabel] preferredVariants[video.path]
 * @param {boolean} [o.randomOn] player.randomVariantOnPlay
 */
export function variationsView({ video, manual = [], preferredLabel = null, randomOn = false } = {}) {
  const list = remoteVariantList(video || {}, Array.isArray(manual) ? manual : []);
  const basePaths = new Set((Array.isArray(video?.variants) ? video.variants : []).filter(Boolean).map((v) => v.path));
  const ownList = Array.isArray(video?.variants) && video.variants.length > 0;
  const pin = typeof preferredLabel === 'string' && preferredLabel.trim() ? preferredLabel.trim() : null;
  const pinAt = pin ? list.findIndex((v) => String(v.label || '').trim() === pin) : -1;
  const playFirst = list.length === 0 ? -1 : (pinAt > 0 ? pinAt : 0);
  const items = list.map((v, i) => {
    const added = ownList ? !basePaths.has(v.path) : i > 0 || !v.main;
    return {
      ...v,
      source: added ? 'added' : 'folder',
      removable: added && (manual || []).some((m) => m?.path === v.path),
      pinned: i === pinAt,
      playFirst: i === playFirst,
    };
  });
  return { items, pinnedLabel: pin, pinFound: pinAt >= 0, playFirst, randomOverridesPin: !!randomOn && !!pin };
}

/** Remove a variation you added (Undo restores the exact array). */
export function planRemoveVariation({ videoPath, manualVariants, path } = {}) {
  const list = hasOwn(manualVariants, videoPath) && Array.isArray(manualVariants[videoPath]) ? manualVariants[videoPath] : [];
  if (!path || !list.some((v) => v?.path === path)) {
    return { kind: 'variation-remove', name: fileName(path), key: KEYS.manualVariants, path: videoPath, changed: false, ops: [] };
  }
  const rest = list.filter((v) => v?.path !== path);
  return {
    kind: 'variation-remove',
    name: fileName(path),
    ...planEntryChange({ key: KEYS.manualVariants, map: manualVariants, path: videoPath, next: rest.length ? rest : undefined }),
  };
}

/** Pin (a label) or clear (null) the variation that plays first. */
export function planPlayFirst({ videoPath, preferredVariants, label } = {}) {
  return { kind: 'play-first', ...planEntryChange({ key: KEYS.preferredVariants, map: preferredVariants, path: videoPath, next: label || undefined }) };
}

// ---------------------------------------------------------------------------
// Subtitles, Playback, Thumbnail, VR, File
// ---------------------------------------------------------------------------

/** Unpair the subtitle you chose (`subtitleAssociations[path]`), with Undo. */
export function planUnpairSubtitle({ videoPath, subtitleAssociations } = {}) {
  const had = hasOwn(subtitleAssociations, videoPath);
  const change = planEntryChange({ key: KEYS.subtitleAssociations, map: subtitleAssociations, path: videoPath, next: undefined });
  const sub = had ? subtitleAssociations[videoPath] : null;
  return { kind: 'subtitle-unpair', offered: change.changed, name: typeof sub === 'string' ? fileName(sub) : '', ...change };
}

/**
 * Progress: "Watched to 12:40 of 34:12", "Watched" or "Not started".
 * @param {{entry?: object, duration?: number}} o resumePositions[path] and a known duration
 */
export function progressView({ entry, duration } = {}) {
  if (!isPlainObject(entry)) return { state: 'not-started', canReset: false };
  if (isFinished(entry)) return { state: 'watched', canReset: true };
  const fraction = resumeProgressFraction(entry, duration);
  if (fraction > 0) {
    const dur = Number.isFinite(duration) && duration > 0 ? duration : entry.duration;
    return {
      state: 'in-progress', canReset: true, fraction, percent: Math.round(fraction * 100),
      position: entry.position, duration: dur,
      positionText: formatResumeTime(entry.position), durationText: formatResumeTime(dur),
    };
  }
  return { state: 'not-started', canReset: true };
}

/** Reset progress: drops the entry; Undo puts the exact entry back. */
export function planResetProgress({ videoPath, resumePositions } = {}) {
  return { kind: 'progress-reset', ...planEntryChange({ key: KEYS.resumePositions, map: resumePositions, path: videoPath, next: undefined }) };
}

/** Reset thumbnail: drops the map entry only (the image file stays), so Undo can put it back. */
export function planResetThumbnail({ videoPath, customThumbnails } = {}) {
  return { kind: 'thumbnail-reset', ...planEntryChange({ key: KEYS.customThumbnails, map: customThumbnails, path: videoPath, next: undefined }) };
}

/**
 * VR: Automatic / VR / Flat, what detection decided, and the format line.
 * `detect` is the file-name heuristic (vr-detect.js on the path string, which
 * skips the override store).
 */
export function vrView({ videoPath, manualVRType, vrFormat, detect } = {}) {
  const heuristic = typeof detect === 'function' ? detect : (p) => isVRVideo(String(p || ''));
  const override = hasOwn(manualVRType, videoPath) ? manualVRType[videoPath] : null;
  const mode = override === 'vr' || override === 'flat' ? override : 'auto';
  const detected = !!heuristic(videoPath);
  const fmt = hasOwn(vrFormat, videoPath) && isPlainObject(vrFormat[videoPath]) ? vrFormat[videoPath] : null;
  return {
    mode,
    detected,
    isVR: mode === 'auto' ? detected : mode === 'vr',
    format: fmt ? {
      projection: typeof fmt.projection === 'string' ? fmt.projection : 'flat',
      eye: fmt.eye === 'right' || fmt.eye === 'left' ? fmt.eye : null,
      zoom: Number.isFinite(fmt.zoom) ? fmt.zoom : 1,
    } : null,
  };
}

/** Pick Automatic (deletes the override), VR or Flat; Undo restores the exact entry. */
export function planSetVRMode({ videoPath, manualVRType, mode } = {}) {
  const next = mode === 'vr' || mode === 'flat' ? mode : undefined;
  return { kind: 'vr-mode', mode: next || 'auto', ...planEntryChange({ key: KEYS.manualVRType, map: manualVRType, path: videoPath, next }) };
}

/** File facts. `size` in bytes when known. */
export function fileView({ path, size, source } = {}) {
  return {
    path: path || '',
    name: fileName(path),
    folder: folderOf(path),
    size: Number.isFinite(size) && size >= 0 ? size : null,
    source: source || null,
  };
}
