// Script backups: the version of a .funscript on disk is kept before FunSync
// overwrites it, and the editor's "Restore an earlier version…" lists them
// (editor work list 3.1, 2026-11-24).
//
// Where: <userData>/script-backups/<sha1 of the normalised path>/, one file
// per kept version (<compact ISO time>.funscript) plus index.json
// {path, entries: [{id, at, size, points}]}. userData, never the script's own
// folder: the user's library drives are written only when the user saves, and
// a backup next to a script would show up in the library scan as a variant.
// Portable builds point userData at their data dir, so backups travel with it.
//
// When: the first overwrite of a path in this app session always keeps the
// old version; after that only when this session's newest backup of that path
// is 10 minutes old or more. Autosave writes every few seconds, so a backup
// per write would push the morning's version out of the 20 kept within
// minutes; a long session still gets a checkpoint every 10 minutes.
//
// Rules (lessons kept in the repo memory):
// - A failing backup never blocks or fails the write: every failure is a
//   warning in main.log and the write goes ahead.
// - Absence is never destructive: index.json is a cache. The folder's own
//   files are the truth, so a lost or damaged index loses no version, and a
//   version whose file was written before a crash (no index entry yet) still
//   lists.
// - Pruning keeps the newest 20 per script and deletes only files in that
//   script's own folder whose names are backup ids (never index.json, never
//   anything else).
const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const FOLDER_NAME = 'script-backups';
const INDEX_FILE = 'index.json';
const KEEP_PER_SCRIPT = 20;
const CHECKPOINT_MS = 10 * 60 * 1000;
// After a failed backup, the next tries of that path wait this long, so an
// unwritable userData means one warning a minute, not one per autosave.
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
// A script this large is not a funscript anyone hand-edits; reading it twice
// per checkpoint is not worth it. Skipped with a warning, the write goes on.
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const SCRIPT_EXT_RE = /\.funscript$/i;
// A backup id: compact ISO time (UTC, milliseconds), and a counter when two
// land in the same millisecond. Nothing else ever names a backup, so a read
// or a prune can never reach outside the script's own folder.
const ID_RE = /^\d{8}T\d{9}Z(?:-\d{1,3})?$/;

/** 2026-11-24T14:02:05.123Z → 20261124T140205123Z */
function compactIso(ms) {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

/** The time a backup id names, in ms, or null. */
function idTime(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(String(id));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return Number.isFinite(ms) ? ms : null;
}

const stripBom = (text) => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

/** How many points the main axis has, or null for a file that is not a readable funscript. */
function countPoints(bytes) {
  try {
    const parsed = JSON.parse(stripBom(Buffer.from(bytes).toString('utf8')));
    return Array.isArray(parsed?.actions) ? parsed.actions.length : null;
  } catch {
    return null;
  }
}

/** Newest first; the id breaks a tie (it carries the same-millisecond counter). */
function byNewest(a, b) {
  if (b.at !== a.at) return b.at - a.at;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

/**
 * @param {object} deps
 * @param {() => string} deps.getUserDataDir asked on every call: portable
 *   mode moves userData before anything reads it, and tests hand in a temp dir
 * @param {{warn: Function, info?: Function}} [deps.log] electron-log in main
 * @param {object} [deps.fsp] fs.promises (a fake in failure tests)
 * @param {object} [deps.pathImpl] path, or path.win32 / path.posix in tests
 * @param {string} [deps.platform] process.platform
 * @param {() => number} [deps.now]
 */
function createScriptBackups({
  getUserDataDir,
  log = console,
  fsp = nodeFs.promises,
  pathImpl = nodePath,
  platform = process.platform,
  now = Date.now,
} = {}) {
  if (typeof getUserDataDir !== 'function') throw new Error('createScriptBackups needs getUserDataDir');

  // This app session's newest backup per script key (ms). Not on disk on
  // purpose: "first overwrite in a session" means a fresh launch backs up again.
  const sessionLast = new Map();
  const retryAfter = new Map();
  // One backup at a time per script: autosave and Save can land together,
  // and two index writes racing would drop an entry from the cache.
  const chains = new Map();

  const warn = (...args) => { try { log.warn(...args); } catch { /* logging never breaks a write */ } };

  /** An absolute .funscript path, or null. A `stream:` key or a relative path is never a file to back up. */
  function scriptPath(filePath) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return null;
    if (!SCRIPT_EXT_RE.test(filePath) || !pathImpl.isAbsolute(filePath)) return null;
    return filePath;
  }

  /**
   * The folder name for a path: sha1 of the normalised path, lower-cased
   * where the file system ignores case (Windows, macOS), so C:\Lib\a.funscript
   * and c:/lib/A.funscript share their versions. Linux keeps the case: there
   * those are two different scripts.
   */
  function keyOf(filePath) {
    let p = pathImpl.normalize(pathImpl.resolve(filePath));
    const root = pathImpl.parse(p).root;
    while (p.length > root.length && /[\\/]$/.test(p)) p = p.slice(0, -1);
    if (platform !== 'linux') p = p.toLowerCase();
    return crypto.createHash('sha1').update(p, 'utf8').digest('hex');
  }

  const folderOf = (key) => pathImpl.join(getUserDataDir(), FOLDER_NAME, key);
  const fileOf = (dir, id) => pathImpl.join(dir, `${id}.funscript`);

  async function readIndex(dir) {
    try {
      const parsed = JSON.parse(stripBom(await fsp.readFile(pathImpl.join(dir, INDEX_FILE), 'utf8')));
      return parsed && typeof parsed === 'object' && Array.isArray(parsed.entries) ? parsed : null;
    } catch {
      return null; // none yet, or damaged: the files below are the truth
    }
  }

  /**
   * Every version in a script's folder, newest first: the files themselves,
   * with size and points from index.json where it has them (read from the
   * file where it does not: a damaged index, or a crash before its write).
   */
  async function scan(dir) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return { index: null, entries: [] };
      throw err;
    }
    const index = await readIndex(dir);
    const cached = new Map();
    for (const e of index?.entries || []) {
      if (e && typeof e.id === 'string' && ID_RE.test(e.id)) cached.set(e.id, e);
    }
    const entries = [];
    for (const name of names) {
      if (!name.endsWith('.funscript')) continue;
      const id = name.slice(0, -'.funscript'.length);
      if (!ID_RE.test(id)) continue;
      let stat;
      try {
        stat = await fsp.lstat(fileOf(dir, id));
      } catch {
        continue; // gone between the listing and now
      }
      if (!stat.isFile()) continue;
      const known = cached.get(id);
      let points = known && known.size === stat.size && (Number.isInteger(known.points) || known.points === null)
        ? known.points : undefined;
      if (points === undefined) {
        try { points = countPoints(await fsp.readFile(fileOf(dir, id))); } catch { points = null; }
      }
      entries.push({ id, at: idTime(id), size: stat.size, points });
    }
    entries.sort(byNewest);
    return { index, entries };
  }

  async function writeIndex(dir, data) {
    const target = pathImpl.join(dir, INDEX_FILE);
    // Never a name a backup id could have, so a half-written tmp never lists.
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, target);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch { /* nothing to clean */ }
      throw err;
    }
  }

  async function backupNow(filePath, key, newContent) {
    const at = now();
    const last = sessionLast.get(key);
    if (last !== undefined && at - last < CHECKPOINT_MS) return { backedUp: false, reason: 'recent' };
    const retry = retryAfter.get(key);
    if (retry !== undefined && at < retry) return { backedUp: false, reason: 'retry-later' };

    let old;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return { backedUp: false, reason: 'not-a-file' };
      if (stat.size > MAX_BACKUP_BYTES) {
        warn(`[ScriptBackups] Not keeping a copy of a ${stat.size}-byte script (over ${MAX_BACKUP_BYTES}): ${filePath}`);
        return { backedUp: false, reason: 'too-large' };
      }
      old = await fsp.readFile(filePath);
    } catch (err) {
      // Nothing on disk yet: a new script, nothing to keep.
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { backedUp: false, reason: 'absent' };
      throw err;
    }
    const next = Buffer.isBuffer(newContent) ? newContent : Buffer.from(String(newContent ?? ''), 'utf8');
    if (old.equals(next)) return { backedUp: false, reason: 'unchanged' };

    const dir = folderOf(key);
    await fsp.mkdir(dir, { recursive: true });
    const { entries } = await scan(dir);
    const taken = new Set(entries.map((e) => e.id));
    let id = compactIso(at);
    for (let n = 1; taken.has(id) && n < 1000; n++) id = `${compactIso(at)}-${n}`;
    if (taken.has(id)) throw new Error('no free backup name');
    // 'wx': a version already kept is never written over.
    await fsp.writeFile(fileOf(dir, id), old, { flag: 'wx' });

    const all = [{ id, at: idTime(id), size: old.length, points: countPoints(old) }, ...entries].sort(byNewest);
    const keep = all.slice(0, KEEP_PER_SCRIPT);
    const drop = all.slice(KEEP_PER_SCRIPT);
    try {
      await writeIndex(dir, { path: filePath, entries: keep });
    } catch (err) {
      // The version is kept (its file is the truth); only the cache is stale.
      warn(`[ScriptBackups] index.json not updated for ${filePath}: ${err?.message}`);
    }
    for (const e of drop) {
      if (!ID_RE.test(e.id)) continue;
      try { await fsp.unlink(fileOf(dir, e.id)); } catch (err) {
        if (err?.code !== 'ENOENT') warn(`[ScriptBackups] Could not remove an old version ${e.id}: ${err?.message}`);
      }
    }
    sessionLast.set(key, at);
    retryAfter.delete(key);
    return { backedUp: true, id };
  }

  /**
   * Keep the version of `filePath` on disk before `newContent` replaces it.
   * Await it before the write; it never throws and never rejects.
   * @returns {Promise<{backedUp: boolean, id?: string, reason?: string}>}
   */
  async function backupBeforeWrite(filePath, newContent) {
    const p = scriptPath(filePath);
    if (!p) return { backedUp: false, reason: 'not-a-script' };
    let key;
    try {
      key = keyOf(p);
    } catch (err) {
      warn(`[ScriptBackups] Backup skipped for ${filePath}: ${err?.message}`);
      return { backedUp: false, reason: 'error' };
    }
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(() => backupNow(p, key, newContent)).catch((err) => {
      retryAfter.set(key, now() + RETRY_AFTER_FAILURE_MS);
      warn(`[ScriptBackups] Backup failed; the write goes ahead without one: ${filePath}: ${err?.message}`);
      return { backedUp: false, reason: 'error' };
    });
    chains.set(key, run);
    try {
      return await run;
    } finally {
      if (chains.get(key) === run) chains.delete(key);
    }
  }

  /**
   * The kept versions of a script, newest first: [{id, at, size, points}]
   * (`at` in ms; `points` null for a version that is not a readable
   * funscript). [] for none, for anything that is not an absolute .funscript
   * path, and when the folder cannot be read.
   */
  async function listBackups(filePath) {
    const p = scriptPath(filePath);
    if (!p) return [];
    try {
      const { entries } = await scan(folderOf(keyOf(p)));
      return entries.map(({ id, at, size, points }) => ({ id, at, size, points }));
    } catch (err) {
      warn(`[ScriptBackups] Could not list the versions of ${filePath}: ${err?.message}`);
      return [];
    }
  }

  /**
   * One kept version's text (BOM stripped, like read-funscript), or null.
   * The id must be a backup id AND one of that path's own versions: a name
   * from elsewhere, a path, or ".." never reaches a file.
   */
  async function readBackup(filePath, id) {
    const p = scriptPath(filePath);
    if (!p || typeof id !== 'string' || !ID_RE.test(id)) return null;
    try {
      const dir = folderOf(keyOf(p));
      const { entries } = await scan(dir);
      const entry = entries.find((e) => e.id === id);
      if (!entry) return null;
      if (entry.size > MAX_BACKUP_BYTES) return null;
      return stripBom(await fsp.readFile(fileOf(dir, entry.id), 'utf8'));
    } catch (err) {
      warn(`[ScriptBackups] Could not read version ${id} of ${filePath}: ${err?.message}`);
      return null;
    }
  }

  return { backupBeforeWrite, listBackups, readBackup, keyOf, folderOf };
}

module.exports = {
  createScriptBackups,
  compactIso,
  idTime,
  countPoints,
  FOLDER_NAME,
  INDEX_FILE,
  KEEP_PER_SCRIPT,
  CHECKPOINT_MS,
  MAX_BACKUP_BYTES,
  ID_RE,
};
