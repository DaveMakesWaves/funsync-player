'use strict';

// Stash S1 (2026-11-18): the oshash of FunSync's own videos, computed in
// Electron main, and the cache that keeps a second sync from reading
// unchanged files again (notes/features/DESIGN-stash-s1.md (a) step 5.1,
// (b), (c) "fingerprints.json").
//
// THE OSHASH TWIN. renderer/js/oshash.js is an ES module and Electron main
// is CommonJS (the repo has no "type": "module"), so main cannot load it.
// The functions below are the same algorithm, line for line;
// tests/unit/stash-fingerprint.test.js pins them to the renderer module on
// Stash's own vectors (tests/fixtures/stash/oshash-vectors.json) and 1,000
// random sizes. Change one, change both.
//
// The algorithm (Stash's pkg/hash/oshash, the OpenSubtitles hash with
// Stash's small-file rule): a file of 8 bytes or less has no oshash; chunk =
// 64 KiB, or for a smaller file its size rounded DOWN to a multiple of 8;
// sum = size + every 8-byte little-endian word of the first `chunk` bytes
// + every one of the last `chunk` bytes, modulo 2^64; 16 lowercase hex
// digits. Two reads per file, no decode.
//
// THE CACHE. `{[path]: {size, mtimeMs, oshash}}`, kept by Electron main in
// userData/stash/fingerprints.json (derived data: never in a backup,
// rebuilt freely). An entry is used only when BOTH the size and the
// modified time equal the file's stat now; a path alone proves nothing (a
// file replaced in place keeps its path).
//
// READ-ONLY. Files are opened for reading only; nothing here writes,
// renames or deletes a video. All file access goes through an injected `io`
// (`nodeFileIo()` is the real one), so the logic is tested without disks.

const { volumeOf } = require('./content-hash');

// ---------------------------------------------------------------------------
// oshash (the twin of renderer/js/oshash.js)
// ---------------------------------------------------------------------------

/** Bytes read from each end of the file. */
const OSHASH_CHUNK_BYTES = 64 * 1024;

const TWO_32 = 2 ** 32;

/**
 * How many bytes to read from each end of a file of this size.
 *
 * @param {number} fileSize bytes
 * @returns {number}
 * @throws {RangeError} for a size that is not a whole number above 8
 */
function oshashChunkSize(fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`oshash: file size must be a whole number of bytes, got ${fileSize}`);
  }
  if (fileSize <= 8) {
    throw new RangeError(`oshash: a file of 8 bytes or less has no oshash (size ${fileSize})`);
  }
  return fileSize < OSHASH_CHUNK_BYTES ? Math.floor(fileSize / 8) * 8 : OSHASH_CHUNK_BYTES;
}

/**
 * The two reads a caller has to make for a file of this size.
 *
 * @param {number} fileSize
 * @returns {{offset: number, length: number}[]} head first, then tail
 */
function oshashReads(fileSize) {
  const chunk = oshashChunkSize(fileSize);
  return [
    { offset: 0, length: chunk },
    { offset: fileSize - chunk, length: chunk },
  ];
}

function asBytes(data, what) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`oshash: ${what} must be bytes (Uint8Array, ArrayBuffer or a typed array view)`);
}

// Sum of the 8-byte little-endian words, as two 32-bit halves kept in
// doubles. Each half stays under 2^32 * 8192 words < 2^45, well inside a
// double's exact range, so nothing rounds; the carry goes over at the end.
function addWords(bytes, acc) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < bytes.byteLength; i += 8) {
    lo += view.getUint32(i, true);
    hi += view.getUint32(i + 4, true);
  }
  acc.lo += lo;
  acc.hi += hi;
}

/**
 * The oshash from the size and the two chunks already read.
 *
 * @param {number} fileSize bytes
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} head the first `oshashChunkSize(fileSize)` bytes
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} tail the last `oshashChunkSize(fileSize)` bytes
 * @returns {string} 16 lowercase hex digits
 */
function oshashFromChunks(fileSize, head, tail) {
  const chunk = oshashChunkSize(fileSize);
  const headBytes = asBytes(head, 'head');
  const tailBytes = asBytes(tail, 'tail');
  if (headBytes.byteLength !== chunk || tailBytes.byteLength !== chunk) {
    throw new RangeError(`oshash: expected ${chunk} bytes from each end, got ${headBytes.byteLength} and ${tailBytes.byteLength}`);
  }
  const acc = { lo: fileSize % TWO_32, hi: Math.floor(fileSize / TWO_32) };
  addWords(headBytes, acc);
  addWords(tailBytes, acc);
  const lo = acc.lo % TWO_32;
  const hi = (acc.hi + Math.floor(acc.lo / TWO_32)) % TWO_32;
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * The oshash of a file, read through a callback.
 *
 * @param {number} fileSize bytes
 * @param {(offset: number, length: number) => (Uint8Array|ArrayBuffer|Promise<Uint8Array|ArrayBuffer>)} readAt
 *   returns exactly `length` bytes starting at `offset` (a short read is an error, not a wrong hash)
 * @returns {Promise<string>}
 */
async function oshash(fileSize, readAt) {
  if (typeof readAt !== 'function') throw new TypeError('oshash: readAt must be a function');
  const [headRead, tailRead] = oshashReads(fileSize);
  const head = await readAt(headRead.offset, headRead.length);
  const tail = await readAt(tailRead.offset, tailRead.length);
  return oshashFromChunks(fileSize, head, tail);
}

/**
 * The oshash of a whole file already in memory (small files, tests).
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {string}
 */
function oshashOfBytes(data) {
  const bytes = asBytes(data, 'data');
  const [headRead, tailRead] = oshashReads(bytes.byteLength);
  return oshashFromChunks(
    bytes.byteLength,
    bytes.subarray(headRead.offset, headRead.offset + headRead.length),
    bytes.subarray(tailRead.offset, tailRead.offset + tailRead.length),
  );
}

/**
 * An oshash in the one form FunSync compares: 16 lowercase hex digits.
 * Stash writes `%016x`; a shorter run of hex digits is the same number and
 * is padded. Anything else (longer, not hex, not a string) is no hash, so a
 * piece of a hash can never equal a whole one (Stash's own INCLUDES search
 * matches substrings, checked 2026-11-18; FunSync compares on this PC).
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeOshash(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{1,16}$/.test(hex)) return null;
  return hex.padStart(16, '0');
}

// ---------------------------------------------------------------------------
// The fingerprint cache
// ---------------------------------------------------------------------------

/** A cache file bigger than this is not parsed (it is rebuilt instead). */
const FINGERPRINT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Longest one file may take (stat, open, two reads) before it is skipped. */
const FINGERPRINT_TIMEOUT_MS = 20000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEntry(entry) {
  return isPlainObject(entry)
    && Number.isSafeInteger(entry.size) && entry.size > 8
    && Number.isFinite(entry.mtimeMs)
    && normalizeOshash(entry.oshash) === entry.oshash;
}

/**
 * A cache read from disk, keeping only well-formed entries. Anything that
 * is not a cache gives an empty one (the cache is derived; a lost entry
 * costs one re-read, a wrong one would cost a wrong match).
 *
 * @param {unknown} raw
 * @returns {Object<string, {size: number, mtimeMs: number, oshash: string}>}
 */
function normalizeFingerprintCache(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [path, entry] of Object.entries(raw)) {
    if (!path || !validEntry(entry)) continue;
    out[path] = { size: entry.size, mtimeMs: entry.mtimeMs, oshash: entry.oshash };
  }
  return out;
}

/**
 * Parse fingerprints.json. Damaged, too big or missing: an empty cache.
 *
 * @param {string|Buffer|null|undefined} text
 * @returns {Object<string, {size: number, mtimeMs: number, oshash: string}>}
 */
function parseFingerprintCache(text) {
  if (text == null) return {};
  if (Buffer.isBuffer(text) && text.length > FINGERPRINT_CACHE_MAX_BYTES) return {};
  const str = typeof text === 'string' ? text : String(text);
  if (str.length > FINGERPRINT_CACHE_MAX_BYTES) return {};
  try {
    return normalizeFingerprintCache(JSON.parse(str));
  } catch {
    return {};
  }
}

/** The cache as the text of fingerprints.json. */
function serializeFingerprintCache(cache) {
  return JSON.stringify(normalizeFingerprintCache(cache));
}

/**
 * The cached oshash for a file, or null. Used only when the size AND the
 * modified time equal the stat taken now.
 *
 * @param {object} cache
 * @param {string} path
 * @param {{size: number, mtimeMs: number}} stat
 * @returns {string|null}
 */
function cachedOshash(cache, path, stat) {
  if (!isPlainObject(cache) || !stat || !Object.prototype.hasOwnProperty.call(cache, path)) return null;
  const entry = cache[path];
  if (!validEntry(entry)) return null;
  return entry.size === stat.size && entry.mtimeMs === stat.mtimeMs ? entry.oshash : null;
}

/**
 * The real file access, over `fs.promises` (injectable for tests). Opens
 * read-only; `read` returns fewer bytes than asked only at the end of the
 * file, which the hash then refuses (a file that shrank mid-sync).
 *
 * @param {typeof import('fs').promises} [fsp]
 */
function nodeFileIo(fsp = require('fs').promises) {
  return {
    stat: (path) => fsp.stat(path),
    async open(path) {
      const handle = await fsp.open(path, 'r');
      return {
        async read(offset, length) {
          const buf = Buffer.alloc(length);
          let got = 0;
          while (got < length) {
            const { bytesRead } = await handle.read(buf, got, length - got, offset + got);
            if (!bytesRead) break;
            got += bytesRead;
          }
          return buf.subarray(0, got);
        },
        close: () => handle.close(),
      };
    },
  };
}

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const TIMED_OUT = Symbol('timed out');

function pathOf(video) {
  if (typeof video === 'string') return video;
  return isPlainObject(video) && typeof video.path === 'string' ? video.path : null;
}

/** Hash one file through `io`: stat, cache, then open and two reads. */
async function fingerprintOne(path, io, cache) {
  let stat;
  try {
    stat = await io.stat(path);
  } catch (err) {
    return { skip: ABSENT_CODES.has(err && err.code) ? 'missing' : 'unreachable' };
  }
  if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) return { skip: 'notFile' };
  const size = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  if (!Number.isSafeInteger(size) || !Number.isFinite(mtimeMs)) return { skip: 'unreachable' };
  if (size <= 8) return { skip: 'tooSmall' };
  const hit = cachedOshash(cache, path, { size, mtimeMs });
  if (hit) return { fingerprint: { path, size, mtimeMs, oshash: hit }, cached: true };
  let file;
  try {
    file = await io.open(path);
    const hash = await oshash(size, (offset, length) => file.read(offset, length));
    return { fingerprint: { path, size, mtimeMs, oshash: hash }, cached: false };
  } catch {
    return { skip: 'read' };
  } finally {
    if (file && typeof file.close === 'function') {
      try { await file.close(); } catch { /* closing a read-only handle: nothing to lose */ }
    }
  }
}

function withTimeout(promise, ms) {
  if (!(ms > 0) || !Number.isFinite(ms)) return promise;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A fingerprint function for one sync, over one cache: the shape
 * electron/stash-sync.js takes (`fingerprint(video, {signal}) → {size,
 * mtimeMs, oshash} | null`, null = skipped), with the cache to save after.
 *
 * - A file whose size and modified time equal its cache entry is not read.
 * - A missing or unreachable path, a file of 8 bytes or less, a read error,
 *   a file that takes longer than `timeoutMs`, or a path `isOffline` names
 *   is SKIPPED (null; `onSkip(path, reason)` says why). After one timeout,
 *   the rest of that volume's files are skipped unread: a read on a dead
 *   share holds one of libuv's few file threads until the OS gives up.
 * - An aborted `signal` (Cancel) returns null without touching the file.
 * - `getCache()` is a new object: every entry of `cache`, updated for the
 *   files hashed since; skipped files keep their old entry. `prune(paths)`
 *   keeps only those paths (a full sync passes the whole library, so
 *   removed videos drop out).
 *
 * @param {object} opts
 * @param {{stat: Function, open: Function}} opts.io see nodeFileIo()
 * @param {object} [opts.cache] the loaded fingerprint cache
 * @param {(path: string) => boolean} [opts.isOffline]
 * @param {(path: string, reason: string) => void} [opts.onSkip]
 * @param {number} [opts.timeoutMs]
 */
function createFingerprinter(opts = {}) {
  const { io, isOffline, onSkip, timeoutMs = FINGERPRINT_TIMEOUT_MS } = opts;
  if (!io || typeof io.stat !== 'function' || typeof io.open !== 'function') {
    throw new TypeError('stash-fingerprint: io must have stat() and open()');
  }
  let entries = normalizeFingerprintCache(opts.cache);
  const deadVolumes = new Set();
  const stats = { read: 0, cached: 0, skipped: 0 };

  async function fingerprint(video, { signal } = {}) {
    const path = pathOf(video);
    if (!path || (signal && signal.aborted)) return null;
    const volume = volumeOf(path);
    let result;
    if (deadVolumes.has(volume) || (typeof isOffline === 'function' && isOffline(path))) {
      result = { skip: 'offline' };
    } else {
      result = await withTimeout(fingerprintOne(path, io, entries), timeoutMs);
      if (result === TIMED_OUT) {
        deadVolumes.add(volume);
        result = { skip: 'timeout' };
      }
    }
    if (!result.fingerprint) {
      stats.skipped += 1;
      if (typeof onSkip === 'function') onSkip(path, result.skip);
      return null;
    }
    const { size, mtimeMs, oshash: hash } = result.fingerprint;
    entries[path] = { size, mtimeMs, oshash: hash };
    if (result.cached) stats.cached += 1; else stats.read += 1;
    return { size, mtimeMs, oshash: hash };
  }

  return {
    fingerprint,
    getCache: () => ({ ...entries }),
    prune(paths) {
      const keep = new Set(Array.isArray(paths) ? paths.map(pathOf).filter(Boolean) : []);
      entries = Object.fromEntries(Object.entries(entries).filter(([path]) => keep.has(path)));
    },
    stats: () => ({ ...stats }),
  };
}

/**
 * Fingerprint a list of videos, one file at a time (createFingerprinter's
 * rules). `signal.aborted` (Cancel) stops before the next file; what was
 * hashed is returned with `cancelled: true`. With `prune`, the returned
 * cache keeps only the entries for `videos`.
 *
 * @param {Array<string|{path: string}>} videos
 * @param {object} opts createFingerprinter's, plus:
 * @param {boolean} [opts.prune]
 * @param {{aborted: boolean}} [opts.signal]
 * @param {(progress: {done: number, total: number}) => void} [opts.onProgress]
 * @returns {Promise<{fingerprints: {path: string, size: number, mtimeMs: number, oshash: string}[],
 *   skipped: {path: string, reason: string}[], cache: object, read: number, cached: number, cancelled: boolean}>}
 */
async function fingerprintVideos(videos, opts = {}) {
  const { signal, onProgress, prune = false } = opts;
  const skipped = [];
  const fingerprinter = createFingerprinter({
    ...opts,
    onSkip: (path, reason) => skipped.push({ path, reason }),
  });
  const paths = [];
  const seen = new Set();
  for (const video of Array.isArray(videos) ? videos : []) {
    const path = pathOf(video);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  const fingerprints = [];
  let cancelled = false;
  let done = 0;
  for (const path of paths) {
    if (signal && signal.aborted) { cancelled = true; break; }
    const fp = await fingerprinter.fingerprint(path);
    if (fp) fingerprints.push({ path, ...fp });
    done += 1;
    if (typeof onProgress === 'function') onProgress({ done, total: paths.length });
  }

  if (prune) fingerprinter.prune(paths);
  const { read, cached } = fingerprinter.stats();
  return { fingerprints, skipped, cache: fingerprinter.getCache(), read, cached, cancelled };
}

module.exports = {
  OSHASH_CHUNK_BYTES,
  FINGERPRINT_CACHE_MAX_BYTES,
  FINGERPRINT_TIMEOUT_MS,
  oshashChunkSize,
  oshashReads,
  oshashFromChunks,
  oshash,
  oshashOfBytes,
  normalizeOshash,
  normalizeFingerprintCache,
  parseFingerprintCache,
  serializeFingerprintCache,
  cachedOshash,
  nodeFileIo,
  createFingerprinter,
  fingerprintVideos,
};
