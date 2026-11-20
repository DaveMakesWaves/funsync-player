'use strict';

// Content proof for the duplicate finder's "Identical" tier (FT-B01).
//
// "Identical" used to mean same byte size and same duration. Block A's
// sandbox had two DIFFERENT videos of 720,304 bytes and 8 s each (first
// differing byte at 14,251), listed them as Identical, and "Select spares in
// Identical" picked one, with its own funscript, for the Recycle Bin. Size
// and runtime are not content, so the tier now needs a hash of the bytes.
//
// A sampled hash, not a full one: a duplicate scan of a big library must not
// read hundreds of gigabytes. Files under SAMPLE_WHOLE_BELOW are hashed whole;
// bigger ones hash their first, middle and last SAMPLE_BYTES. The renderer
// asks only for files that share an exact byte size with another file, which
// in a real library is a small set.
//
// READ-ONLY. Every file is opened with flag 'r' and only read; nothing here
// writes, renames or deletes. A path that is missing, unreadable, not a
// regular file or offline comes back as `hash: null`, which the finder reads
// as "no proof" (never "different", never "identical").

const fs = require('fs');
const crypto = require('crypto');

/** Bytes read from each of the start, middle and end of a large file. */
const SAMPLE_BYTES = 1024 * 1024;
/** Files smaller than this are hashed whole. */
const SAMPLE_WHOLE_BELOW = 3 * SAMPLE_BYTES;
/** Files hashed at once: enough to overlap disk latency, not enough to thrash a spinning drive. */
const HASH_CONCURRENCY = 3;
/**
 * Longest one file may take (CB-18). A read on a dead network share can hang
 * for minutes, and the Find duplicates dialog waited on the whole batch. Past
 * this the file has no hash: not proven identical, never "different".
 */
const HASH_TIMEOUT_MS = 20000;
const TIMED_OUT = Symbol('timed out');

/**
 * The volume a path lives on: a UNC share (`//server/share`), a drive
 * (`c:`), else its first two folders (`/mnt/nas`). Once a read on a volume
 * has timed out, the rest of that volume's files are not read at all: an
 * abandoned read still holds one of libuv's few file-system threads until
 * the OS gives up, and every read started on a dead share would hold another.
 */
function volumeOf(filePath) {
  const s = String(filePath).replace(/\\/g, '/');
  const unc = /^\/\/[^/]+\/[^/]+/.exec(s);
  if (unc) return unc[0].toLowerCase();
  const drive = /^[A-Za-z]:/.exec(s);
  if (drive) return drive[0].toLowerCase();
  return s.split('/').slice(0, 3).join('/');
}

/**
 * Byte ranges hashed for a file of `size` bytes, as [start, length] pairs.
 * Pure, so the sampling layout can be tested without a file.
 */
function sampleRanges(size) {
  if (!Number.isFinite(size) || size <= 0) return [];
  if (size < SAMPLE_WHOLE_BELOW) return [[0, size]];
  const mid = Math.floor((size - SAMPLE_BYTES) / 2);
  return [[0, SAMPLE_BYTES], [mid, SAMPLE_BYTES], [size - SAMPLE_BYTES, SAMPLE_BYTES]];
}

/**
 * sha256 (hex) of a file's sampled content, or null when it cannot be read.
 * The size is part of the digest, so two files can only match at equal size.
 */
async function sampledContentHash(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0) return null;
    const hash = crypto.createHash('sha256');
    hash.update(`size:${st.size};`);
    for (const [start, length] of sampleRanges(st.size)) {
      const buf = Buffer.alloc(length);
      let off = 0;
      while (off < length) {
        const { bytesRead } = await fh.read(buf, off, length - off, start + off);
        if (bytesRead === 0) return null;   // file shrank under us: no proof
        off += bytesRead;
      }
      hash.update(buf);
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch { /* already closed */ } }
  }
}

/**
 * Hash a batch of paths with bounded concurrency. Same input rules as the
 * neighbouring `stat-video-files` IPC: a non-array is an empty batch, and
 * non-string or empty entries are skipped. Duplicates in the input are
 * hashed once.
 *
 * Bounded (CB-18): a file that takes longer than `timeoutMs` comes back
 * `{ hash: null, timedOut: true }`, and the rest of its volume is not read
 * (`volumeOf`), so a hung share costs at most one timeout per worker
 * instead of hanging the dialog. Still read-only: nothing is written.
 *
 * @returns {Promise<Record<string, {hash: string|null, timedOut?: true}>>}
 */
async function hashFilesSampled(paths, {
  concurrency = HASH_CONCURRENCY, hashFn = sampledContentHash, timeoutMs = HASH_TIMEOUT_MS,
} = {}) {
  const list = Array.isArray(paths) ? paths : [];
  const unique = [...new Set(list.filter((p) => typeof p === 'string' && p))];
  const out = {};
  const stalled = new Set(); // volumes a read timed out on
  let next = 0;
  const width = Math.max(1, Math.min(Number(concurrency) || 1, unique.length));
  const worker = async () => {
    while (next < unique.length) {
      const p = unique[next++];
      const volume = volumeOf(p);
      if (stalled.has(volume)) { out[p] = { hash: null, timedOut: true }; continue; }
      let timer = null;
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
      let hash = null;
      try {
        hash = await Promise.race([Promise.resolve().then(() => hashFn(p)), deadline]);
      } catch {
        hash = null;
      } finally {
        clearTimeout(timer);
      }
      if (hash === TIMED_OUT) {
        stalled.add(volume);
        out[p] = { hash: null, timedOut: true };
        continue;
      }
      out[p] = { hash: typeof hash === 'string' && hash ? hash : null };
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

module.exports = {
  SAMPLE_BYTES,
  SAMPLE_WHOLE_BELOW,
  HASH_CONCURRENCY,
  HASH_TIMEOUT_MS,
  volumeOf,
  sampleRanges,
  sampledContentHash,
  hashFilesSampled,
};
