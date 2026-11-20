/**
 * The funscript files' own metadata (tags, creator, post link) for the tag
 * engine's `funscript` source (video-tags.js `effectiveTags`, keyed by SCRIPT
 * path; records shaped by `funscriptMetaRecord`). Harvested by the backend
 * during the library scan, from files it already parses (no extra reads).
 *
 * Round 3 (2026-11-18): the stub's contract, now filled. The library filter
 * (stage 3a: library.js, the Filters picker, cards, the dialog's ctx) reads
 * these exports; the harvest is backend/services/script_meta.py, fed by the
 * speed pass in backend/routes/media.py and served by GET
 * /api/media/script-meta (through main's fetchWithTimeout, which waits for
 * the backend to be up: `window.funsync.getScriptMeta`). Keep every export
 * and its meaning; add, never rename.
 *
 *   scriptMetaMap()            -> { [scriptPath]: funscriptMetaRecord }  sync, never null
 *                                 (empty until the first harvest arrives; absence = "unknown",
 *                                 never "no tags", and never clears anything)
 *   getScriptMeta(scriptPath)  -> Promise<funscriptMetaRecord | null>  one script's record
 *                                 (for the dialog's ctx.getScriptMeta)
 *   scriptMetaVersion()        -> number   bumps whenever the map changes (memo keys)
 *   onScriptMetaChanged(cb)    -> () => void  unsubscribe; cb() after each change
 *
 * Added in Round 3 (the app's start-up uses them):
 *
 *   refreshScriptMeta({delayMs}) -> Promise  ask the backend for the harvest and
 *                                 keep asking while its pass is still checking
 *                                 scripts (`pending`), backing off from 2 s to
 *                                 10 s between asks; one loop at a time, a call
 *                                 during it makes it ask once more
 *
 * Rules:
 * - The map is replaced, never edited in place: a new object (frozen, with
 *   frozen records) on every change, so its identity is a memo key too.
 * - Absence is never destructive. A failed or missing answer changes
 *   nothing; a script the answer does not mention keeps its record. Only the
 *   backend's own word that a script was READ and has no usable metadata
 *   (`metadata: null`, or a block funscriptMetaRecord finds nothing in)
 *   removes it: that is the file's answer, not an absence.
 * - Nothing here is persisted: the backend's cache file is the store, and it
 *   is never in config.json or a backup (DESIGN-video-options.md (e)).
 */

import { funscriptMetaRecord } from './video-tags.js';

/**
 * The wait between asks while the backend is still checking scripts: 2 s
 * first, then half as long again each time, up to 10 s. No fixed number of
 * asks (r3-fixup R3R-3: a 2-minute cap dropped every record a long first
 * harvest stored after it, ~2,318 scripts on a slow disk).
 */
const POLL_MS = 2000;
const MAX_POLL_MS = 10000;
const POLL_BACKOFF = 1.5;
/** Give up a refresh after this many failed asks in a row (the backend stopped answering). */
const MAX_FAILURES = 3;
/**
 * Give up after this many answers in a row that show no progress: `pending`
 * not going down and nothing new (a pass stuck on a dead network drive, or
 * a backend with no library yet). About 4.5 minutes at the waits above; the
 * next scan, pairing or backend restart asks again.
 */
const MAX_IDLE_ASKS = 30;

const EMPTY = Object.freeze({});
const listeners = new Set();

let map = EMPTY;
let version = 0;
// Ask only for what changed since the last whole answer from the same
// backend process (a restarted backend has a new cacheId: everything again).
let since = 0;
let cacheId = null;
let polling = null;
let askAgain = false;
let fetcher = null;      // tests: _setScriptMetaFetcherForTests
let sleeper = null;

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms) {
  return sleeper ? sleeper(ms) : new Promise((resolve) => setTimeout(resolve, ms));
}

/** One question to the backend; null when it did not answer. */
async function ask(query) {
  try {
    const fn = fetcher || globalThis.window?.funsync?.getScriptMeta;
    if (typeof fn !== 'function') return null;
    const answer = await fn(query);
    return isPlainObject(answer) && isPlainObject(answer.records) ? answer : null;
  } catch {
    return null;
  }
}

function freezeRecord(record) {
  for (const value of Object.values(record)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze(record);
}

function sameRecord(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function notify() {
  for (const cb of [...listeners]) {
    try { cb(); } catch (err) { console.warn('[ScriptMeta] a listener failed', err); }
  }
}

/**
 * Merge the backend's records `{scriptPath: {metadata, readAt}}` into the
 * map. Returns true when the map changed (and listeners were told).
 */
function applyRecords(records) {
  if (!isPlainObject(records)) return false;
  let next = null;
  for (const [path, rec] of Object.entries(records)) {
    if (!path || !isPlainObject(rec) || !own(rec, 'metadata')) continue;
    const readAt = Number.isFinite(rec.readAt) ? rec.readAt : null;
    const record = isPlainObject(rec.metadata) ? funscriptMetaRecord(rec.metadata, readAt) : null;
    const had = own(map, path);
    if (!record) {
      // Read, and nothing usable in it (the file's own answer).
      if (had) {
        next ??= { ...map };
        delete next[path];
      }
      continue;
    }
    if (had && sameRecord(map[path], record)) continue;
    next ??= { ...map };
    next[path] = freezeRecord(record);
  }
  if (!next) return false;
  map = Object.freeze(next);
  version += 1;
  notify();
  return true;
}

export function scriptMetaMap() { return map; }

/**
 * One script's record, asked of the backend now (it reads the file again
 * only when it changed), falling back to what the map holds when the
 * backend does not answer.
 */
export async function getScriptMeta(scriptPath) {
  if (typeof scriptPath !== 'string' || !scriptPath) return null;
  const answer = await ask({ paths: [scriptPath] });
  if (answer && own(answer.records, scriptPath)) {
    applyRecords({ [scriptPath]: answer.records[scriptPath] });
  }
  return own(map, scriptPath) ? map[scriptPath] : null;
}

export function scriptMetaVersion() { return version; }

export function onScriptMetaChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Load the harvest: ask, merge, and ask again while the backend's pass is
 * still checking scripts (`pending` > 0) or has no library yet, waiting 2 s
 * and backing off to 10 s between asks. It stops when the pass is done
 * (`pending` 0 with a library registered), when the backend stops answering
 * (MAX_FAILURES in a row), or after MAX_IDLE_ASKS answers with no progress.
 * One loop at a time; a call while it runs makes it ask once more before it
 * stops (a scan or a pairing that landed meanwhile).
 *
 * @param {{delayMs?: number}} [options] wait first (a registration on its way)
 * @returns {Promise<void>}
 */
export function refreshScriptMeta({ delayMs = 0 } = {}) {
  if (polling) {
    askAgain = true;
    return polling;
  }
  const run = (async () => {
    if (delayMs > 0) await sleep(delayMs);
    let failures = 0;
    let idle = 0;
    let lastPending = Infinity;
    let wait = POLL_MS;
    for (;;) {
      askAgain = false;
      const answer = await ask(cacheId ? { since, cache: cacheId } : {});
      if (answer) {
        failures = 0;
        const changed = applyRecords(answer.records);
        if (typeof answer.cacheId === 'string' && answer.cacheId) cacheId = answer.cacheId;
        if (Number.isSafeInteger(answer.seq) && answer.seq >= 0) since = answer.seq;
        const pending = Number(answer.pending) || 0;
        const registered = Number(answer.registered) || 0;
        if (pending === 0 && registered > 0 && !askAgain) return;
        if (changed || pending < lastPending) idle = 0;
        else if (++idle >= MAX_IDLE_ASKS && !askAgain) return;
        lastPending = pending;
      } else if (++failures >= MAX_FAILURES && !askAgain) {
        return;
      }
      await sleep(wait);
      wait = Math.min(MAX_POLL_MS, Math.round(wait * POLL_BACKOFF));
    }
  })().catch((err) => {
    console.warn('[ScriptMeta] loading the harvest failed', err);
  }).finally(() => {
    if (polling === run) polling = null;
  });
  polling = run;
  return run;
}

/** Tests: forget everything (a fresh window). */
export function _resetScriptMetaStoreForTests() {
  map = EMPTY;
  version = 0;
  since = 0;
  cacheId = null;
  polling = null;
  askAgain = false;
  fetcher = null;
  sleeper = null;
  listeners.clear();
}

/** Tests: answer the backend's questions (`(query) => answer`) and the waits. */
export function _setScriptMetaFetcherForTests(fn, sleepFn = null) {
  fetcher = typeof fn === 'function' ? fn : null;
  sleeper = typeof sleepFn === 'function' ? sleepFn : null;
}
