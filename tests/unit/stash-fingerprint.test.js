/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// electron/stash-fingerprint.js (Stash S1, 2026-11-18): the CommonJS twin of
// renderer/js/oshash.js that Electron main hashes the library with, and the
// fingerprint cache (userData/stash/fingerprints.json) that keeps a second
// sync from reading unchanged files.
//
// The twin is pinned to the renderer module two ways: Stash v0.32.0's own
// values for the six synthetic files tests/fixtures/stash/oshash-vectors.json
// can rebuild byte for byte (in memory, nothing written), and 1,000 random
// sizes where both modules must agree. The cache tests use an in-memory fake
// file system that counts every byte read; one test reads two real fixture
// files through the real fs (read-only).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as renderer from '../../renderer/js/oshash.js';

const require_ = createRequire(import.meta.url);
const twin = require_('../../electron/stash-fingerprint.js');
const {
  oshash, oshashOfBytes, oshashReads, oshashChunkSize, oshashFromChunks, normalizeOshash,
  normalizeFingerprintCache, parseFingerprintCache, serializeFingerprintCache, cachedOshash,
  nodeFileIo, fingerprintVideos, createFingerprinter, FINGERPRINT_CACHE_MAX_BYTES,
} = twin;

const FIX = JSON.parse(fs.readFileSync('tests/fixtures/stash/oshash-vectors.json', 'utf8'));
const TINY = new Uint8Array(Buffer.from(FIX.tinyClipBase64, 'base64'));

// The fixture's recipe (the same as tests/unit/oshash-stash-vectors.test.js):
// the tiny clip, then one MP4 free atom of seeded filler up to `size`.
function tinyClipPlusFreeAtom(size) {
  const out = new Uint8Array(size);
  out.set(TINY, 0);
  new DataView(out.buffer).setUint32(TINY.length, size - TINY.length, false);
  out.set([0x66, 0x72, 0x65, 0x65], TINY.length + 4);
  let seed = FIX.freeAtomSeed >>> 0;
  for (let i = TINY.length + 8; i < size; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

function rebuild(v) {
  if (v.rebuild === 'tinyClip') return TINY;
  if (v.rebuild === 'tinyClipPlusFreeAtom') return tinyClipPlusFreeAtom(v.size);
  return null;
}

function xorshift(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

const reader = (bytes) => (offset, length) => bytes.slice(offset, offset + length);

describe('stash-fingerprint: the oshash twin equals renderer/js/oshash.js', () => {
  const rebuilt = FIX.vectors.filter((v) => v.rebuild);

  it('the six Stash vectors the fixture can rebuild', () => {
    expect(rebuilt.map((v) => v.size)).toEqual([2146, 65535, 65536, 65543, 131072, 131079]);
  });

  for (const v of rebuilt) {
    it(`${v.file} (${v.size} bytes) gives Stash's ${v.stashOshash}, as the renderer does`, async () => {
      const bytes = rebuild(v);
      expect(oshashOfBytes(bytes)).toBe(v.stashOshash);
      expect(await oshash(v.size, reader(bytes))).toBe(v.stashOshash);
      expect(renderer.oshashOfBytes(bytes)).toBe(v.stashOshash);
    });
  }

  it('1,000 random sizes and contents: both modules give the same hash and ask for the same reads', async () => {
    const next = xorshift(0x5a17_2026);
    const pool = new Uint8Array(300_000 + 4096);
    for (let i = 0; i < pool.length; i += 1) pool[i] = next() & 0xff;
    const sizes = [];
    // the small-file rule's every remainder, and both 64 KiB edges
    for (let n = 9; n <= 72; n += 1) sizes.push(n);
    for (const edge of [65536, 131072]) for (let d = -9; d <= 9; d += 1) sizes.push(edge + d);
    while (sizes.length < 1000) sizes.push(9 + (next() % 300_000));
    expect(sizes.length).toBe(1000);
    for (const size of sizes) {
      const start = next() % 4096;
      const bytes = pool.subarray(start, start + size);
      const want = renderer.oshashOfBytes(bytes);
      expect(oshashOfBytes(bytes), `size ${size}`).toBe(want);
      expect(oshashReads(size), `reads ${size}`).toEqual(renderer.oshashReads(size));
    }
    // and through the async reader for a sample
    for (const size of sizes.slice(0, 50)) {
      const bytes = pool.subarray(0, size);
      expect(await oshash(size, reader(bytes))).toBe(await renderer.oshash(size, reader(bytes)));
    }
  });

  it('sizes past 4 GiB (a virtual file, nothing read but two chunks) agree', async () => {
    const next = xorshift(7);
    const chunk = new Uint8Array(65536);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = next() & 0xff;
    const virtual = () => chunk.slice();
    for (const size of [2 ** 32 - 1, 2 ** 32, 5 * 2 ** 30 + 3, 2 ** 53 - 1]) {
      expect(await oshash(size, virtual)).toBe(await renderer.oshash(size, virtual));
    }
  });

  it('the same errors: 8 bytes or less, a size that is not a whole number, a short read', async () => {
    for (const size of [0, 1, 8, -1, 1.5, NaN, 2 ** 53]) {
      expect(() => oshashChunkSize(size)).toThrow(RangeError);
      expect(() => renderer.oshashChunkSize(size)).toThrow(RangeError);
    }
    const bytes = new Uint8Array(70000);
    await expect(oshash(70000, (o, l) => bytes.slice(o, o + l - 1))).rejects.toThrow(/expected 65536 bytes/);
    await expect(oshash(70000, null)).rejects.toThrow(TypeError);
    expect(() => oshashFromChunks(100, new Uint8Array(96), 'x')).toThrow(TypeError);
  });

  it('exports what the renderer module exports, under the same names', () => {
    for (const name of Object.keys(renderer)) expect(typeof twin[name], name).toBe(typeof renderer[name]);
    expect(twin.OSHASH_CHUNK_BYTES).toBe(renderer.OSHASH_CHUNK_BYTES);
  });
});

describe('stash-fingerprint: normalizeOshash (the one form hashes are compared in)', () => {
  it('lower case, 16 digits; a shorter hex run is the same number, padded', () => {
    expect(normalizeOshash('6B3F3B3EE9E8C31A')).toBe('6b3f3b3ee9e8c31a');
    expect(normalizeOshash(' 6b3f3b3ee9e8c31a ')).toBe('6b3f3b3ee9e8c31a');
    expect(normalizeOshash('1c000')).toBe('000000000001c000');
  });

  it('a piece of a hash never becomes the whole hash; non-hex, longer or non-strings are no hash', () => {
    expect(normalizeOshash('6b3f')).not.toBe('6b3f3b3ee9e8c31a');
    for (const bad of ['', '6b3f3b3ee9e8c31a0', 'xyz', '6b3f 3b3e', null, undefined, 123, {}]) {
      expect(normalizeOshash(bad), String(bad)).toBeNull();
    }
  });
});

// An in-memory file system for fingerprintVideos, counting every read.
function fakeFs(files) {
  const log = { stats: [], opens: [], reads: [], bytes: 0, closes: 0 };
  const io = {
    async stat(path) {
      log.stats.push(path);
      const f = files[path];
      if (!f) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      if (f.statError) throw Object.assign(new Error('denied'), { code: f.statError });
      return { size: f.bytes ? f.bytes.length : f.size, mtimeMs: f.mtimeMs, isFile: () => f.dir !== true };
    },
    async open(path) {
      log.opens.push(path);
      const f = files[path];
      if (f.hang) return new Promise(() => {});
      return {
        async read(offset, length) {
          log.reads.push([path, offset, length]);
          if (f.readError) throw new Error('EIO');
          const out = f.bytes.slice(offset, offset + length - (f.short ? 1 : 0));
          log.bytes += out.length;
          return out;
        },
        async close() { log.closes += 1; },
      };
    },
  };
  return { io, log };
}

function bytesOf(size, seed) {
  const next = xorshift(seed);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = next() & 0xff;
  return out;
}

describe('stash-fingerprint: fingerprintVideos and the cache', () => {
  it('hashes every video, and a second sync reads no bytes from unchanged files', async () => {
    const files = {
      'C:\\lib\\a.mp4': { bytes: bytesOf(200_000, 1), mtimeMs: 1700000000000.25 },
      'C:\\lib\\b.mp4': { bytes: bytesOf(5_000, 2), mtimeMs: 1700000000001 },
    };
    const { io, log } = fakeFs(files);
    const first = await fingerprintVideos(Object.keys(files), { io, cache: {} });
    expect(first.read).toBe(2);
    expect(first.cached).toBe(0);
    expect(first.fingerprints).toEqual([
      { path: 'C:\\lib\\a.mp4', size: 200_000, mtimeMs: 1700000000000.25, oshash: oshashOfBytes(files['C:\\lib\\a.mp4'].bytes) },
      { path: 'C:\\lib\\b.mp4', size: 5_000, mtimeMs: 1700000000001, oshash: oshashOfBytes(files['C:\\lib\\b.mp4'].bytes) },
    ]);
    expect(log.closes).toBe(2);

    // the cache goes through its file (JSON) and back, as main stores it
    const cache = parseFingerprintCache(serializeFingerprintCache(first.cache));
    const before = log.bytes;
    const second = await fingerprintVideos(Object.keys(files), { io, cache });
    expect(log.bytes - before).toBe(0);
    expect(second.read).toBe(0);
    expect(second.cached).toBe(2);
    expect(second.fingerprints).toEqual(first.fingerprints);
  });

  it('a changed modified time (same size) re-reads the file, and so does a changed size', async () => {
    const files = { 'C:\\lib\\a.mp4': { bytes: bytesOf(100_000, 3), mtimeMs: 1000 } };
    const { io, log } = fakeFs(files);
    const first = await fingerprintVideos(['C:\\lib\\a.mp4'], { io });
    // swapped in place: new bytes of the same size, new time
    files['C:\\lib\\a.mp4'] = { bytes: bytesOf(100_000, 4), mtimeMs: 2000 };
    const opensBefore = log.opens.length;
    const second = await fingerprintVideos(['C:\\lib\\a.mp4'], { io, cache: first.cache });
    expect(log.opens.length - opensBefore).toBe(1);
    expect(second.fingerprints[0].oshash).toBe(oshashOfBytes(files['C:\\lib\\a.mp4'].bytes));
    expect(second.fingerprints[0].oshash).not.toBe(first.fingerprints[0].oshash);
    expect(second.cache['C:\\lib\\a.mp4']).toEqual({ size: 100_000, mtimeMs: 2000, oshash: second.fingerprints[0].oshash });

    // a different size with the old time is not trusted either
    files['C:\\lib\\a.mp4'] = { bytes: bytesOf(100_008, 4), mtimeMs: 2000 };
    const third = await fingerprintVideos(['C:\\lib\\a.mp4'], { io, cache: second.cache });
    expect(third.read).toBe(1);
    expect(third.fingerprints[0].size).toBe(100_008);
  });

  it('cachedOshash needs the size AND the modified time, for that path', () => {
    const cache = { 'C:\\a.mp4': { size: 100, mtimeMs: 5, oshash: '0123456789abcdef' } };
    expect(cachedOshash(cache, 'C:\\a.mp4', { size: 100, mtimeMs: 5 })).toBe('0123456789abcdef');
    expect(cachedOshash(cache, 'C:\\a.mp4', { size: 100, mtimeMs: 6 })).toBeNull();
    expect(cachedOshash(cache, 'C:\\a.mp4', { size: 101, mtimeMs: 5 })).toBeNull();
    expect(cachedOshash(cache, 'C:\\b.mp4', { size: 100, mtimeMs: 5 })).toBeNull();
    expect(cachedOshash(cache, 'toString', { size: 100, mtimeMs: 5 })).toBeNull();
  });

  it('skips, never fails on: a missing or unreachable path, a folder, a tiny file, a read error, a short read', async () => {
    const files = {
      'C:\\lib\\ok.mp4': { bytes: bytesOf(1000, 5), mtimeMs: 1 },
      'C:\\lib\\denied.mp4': { statError: 'EACCES', size: 1000, mtimeMs: 1 },
      'C:\\lib\\folder.mp4': { dir: true, size: 0, mtimeMs: 1 },
      'C:\\lib\\tiny.mp4': { bytes: bytesOf(8, 6), mtimeMs: 1 },
      'C:\\lib\\eio.mp4': { bytes: bytesOf(1000, 7), mtimeMs: 1, readError: true },
      'C:\\lib\\shrank.mp4': { bytes: bytesOf(1000, 8), mtimeMs: 1, short: true },
    };
    const { io, log } = fakeFs(files);
    const res = await fingerprintVideos(['C:\\lib\\gone.mp4', ...Object.keys(files)], { io });
    expect(res.fingerprints.map((f) => f.path)).toEqual(['C:\\lib\\ok.mp4']);
    expect(res.skipped).toEqual([
      { path: 'C:\\lib\\gone.mp4', reason: 'missing' },
      { path: 'C:\\lib\\denied.mp4', reason: 'unreachable' },
      { path: 'C:\\lib\\folder.mp4', reason: 'notFile' },
      { path: 'C:\\lib\\tiny.mp4', reason: 'tooSmall' },
      { path: 'C:\\lib\\eio.mp4', reason: 'read' },
      { path: 'C:\\lib\\shrank.mp4', reason: 'read' },
    ]);
    // every opened handle was closed, also after a read error
    expect(log.closes).toBe(log.opens.length);
  });

  it('an offline path is skipped unread; after one timeout the rest of that volume is skipped unread', async () => {
    const files = {
      '\\\\NAS\\share\\a.mp4': { bytes: bytesOf(1000, 9), mtimeMs: 1, hang: true },
      '\\\\NAS\\share\\b.mp4': { bytes: bytesOf(1000, 10), mtimeMs: 1 },
      'C:\\lib\\c.mp4': { bytes: bytesOf(1000, 11), mtimeMs: 1 },
      'E:\\off\\d.mp4': { bytes: bytesOf(1000, 12), mtimeMs: 1 },
    };
    const { io, log } = fakeFs(files);
    const res = await fingerprintVideos(Object.keys(files), {
      io, timeoutMs: 30, isOffline: (p) => p.startsWith('E:'),
    });
    expect(res.skipped).toEqual([
      { path: '\\\\NAS\\share\\a.mp4', reason: 'timeout' },
      { path: '\\\\NAS\\share\\b.mp4', reason: 'offline' },
      { path: 'E:\\off\\d.mp4', reason: 'offline' },
    ]);
    expect(res.fingerprints.map((f) => f.path)).toEqual(['C:\\lib\\c.mp4']);
    expect(log.stats).not.toContain('\\\\NAS\\share\\b.mp4');
    expect(log.stats).not.toContain('E:\\off\\d.mp4');
  });

  it('Cancel stops before the next file and keeps what was hashed; progress counts every file', async () => {
    const files = {};
    for (let i = 0; i < 5; i += 1) files[`C:\\lib\\${i}.mp4`] = { bytes: bytesOf(500, 20 + i), mtimeMs: i };
    const { io } = fakeFs(files);
    const signal = { aborted: false };
    const progress = [];
    const res = await fingerprintVideos(Object.keys(files), {
      io, signal, onProgress: (p) => { progress.push(p); if (p.done === 2) signal.aborted = true; },
    });
    expect(res.cancelled).toBe(true);
    expect(res.fingerprints).toHaveLength(2);
    expect(progress).toEqual([{ done: 1, total: 5 }, { done: 2, total: 5 }]);
  });

  it('the new cache keeps old entries (skipped files too); prune keeps only the videos passed in', async () => {
    const files = {
      'C:\\lib\\a.mp4': { bytes: bytesOf(500, 30), mtimeMs: 1 },
      'C:\\lib\\offline.mp4': { statError: 'EIO', size: 500, mtimeMs: 1 },
    };
    const { io } = fakeFs(files);
    const old = {
      'C:\\lib\\offline.mp4': { size: 500, mtimeMs: 1, oshash: 'aaaaaaaaaaaaaaaa' },
      'C:\\lib\\removed.mp4': { size: 600, mtimeMs: 2, oshash: 'bbbbbbbbbbbbbbbb' },
    };
    const kept = await fingerprintVideos(Object.keys(files), { io, cache: old });
    expect(Object.keys(kept.cache).sort()).toEqual(['C:\\lib\\a.mp4', 'C:\\lib\\offline.mp4', 'C:\\lib\\removed.mp4']);
    const pruned = await fingerprintVideos(Object.keys(files), { io, cache: old, prune: true });
    expect(Object.keys(pruned.cache).sort()).toEqual(['C:\\lib\\a.mp4', 'C:\\lib\\offline.mp4']);
    expect(pruned.cache['C:\\lib\\offline.mp4']).toEqual(old['C:\\lib\\offline.mp4']);
    // the caller's cache object is not changed
    expect(Object.keys(old)).toEqual(['C:\\lib\\offline.mp4', 'C:\\lib\\removed.mp4']);
  });

  it('takes {path} objects or strings, once each; refuses an io without stat/open', async () => {
    const files = { 'C:\\a.mp4': { bytes: bytesOf(100, 40), mtimeMs: 1 } };
    const { io } = fakeFs(files);
    const res = await fingerprintVideos([{ path: 'C:\\a.mp4' }, 'C:\\a.mp4', null, { path: 3 }], { io });
    expect(res.fingerprints).toHaveLength(1);
    await expect(fingerprintVideos(['C:\\a.mp4'], {})).rejects.toThrow(TypeError);
  });
});

describe('stash-fingerprint: createFingerprinter (the per-video function stash-sync.js takes)', () => {
  it('fingerprint({path, size, mtimeMs}, {signal}) gives {size, mtimeMs, oshash}, or null with the reason', async () => {
    const files = {
      'C:\\lib\\a.mp4': { bytes: bytesOf(3000, 60), mtimeMs: 11 },
      'C:\\lib\\tiny.mp4': { bytes: bytesOf(4, 61), mtimeMs: 12 },
    };
    const { io, log } = fakeFs(files);
    const skips = [];
    const fp = createFingerprinter({ io, cache: {}, onSkip: (path, reason) => skips.push([path, reason]) });
    // the scan's size and time are hints only: the file's own stat decides
    expect(await fp.fingerprint({ path: 'C:\\lib\\a.mp4', size: 1, mtimeMs: 1 }, { signal: { aborted: false } }))
      .toEqual({ size: 3000, mtimeMs: 11, oshash: oshashOfBytes(files['C:\\lib\\a.mp4'].bytes) });
    expect(await fp.fingerprint({ path: 'C:\\lib\\tiny.mp4' })).toBeNull();
    expect(skips).toEqual([['C:\\lib\\tiny.mp4', 'tooSmall']]);
    // Cancel: null, and the file is not touched
    const stats = log.stats.length;
    expect(await fp.fingerprint({ path: 'C:\\lib\\a.mp4' }, { signal: { aborted: true } })).toBeNull();
    expect(log.stats.length).toBe(stats);
    // a second call for the same file reads nothing (the cache it keeps)
    const bytes = log.bytes;
    await fp.fingerprint({ path: 'C:\\lib\\a.mp4' });
    expect(log.bytes).toBe(bytes);
    expect(fp.stats()).toEqual({ read: 1, cached: 1, skipped: 1 });
    expect(Object.keys(fp.getCache())).toEqual(['C:\\lib\\a.mp4']);
  });

  it('getCache is a copy; prune keeps only the paths given', async () => {
    const files = { 'C:\\a.mp4': { bytes: bytesOf(100, 62), mtimeMs: 1 } };
    const { io } = fakeFs(files);
    const fp = createFingerprinter({ io, cache: { 'C:\\old.mp4': { size: 100, mtimeMs: 1, oshash: '0123456789abcdef' } } });
    await fp.fingerprint('C:\\a.mp4');
    const copy = fp.getCache();
    delete copy['C:\\a.mp4'];
    expect(Object.keys(fp.getCache()).sort()).toEqual(['C:\\a.mp4', 'C:\\old.mp4']);
    fp.prune([{ path: 'C:\\a.mp4' }]);
    expect(Object.keys(fp.getCache())).toEqual(['C:\\a.mp4']);
    expect(() => createFingerprinter({ io: { stat() {} } })).toThrow(TypeError);
  });
});

describe('stash-fingerprint: the cache file', () => {
  it('a damaged, too big or missing file is an empty cache (rebuilt freely)', () => {
    expect(parseFingerprintCache(null)).toEqual({});
    expect(parseFingerprintCache('{"broken"')).toEqual({});
    expect(parseFingerprintCache('[1,2]')).toEqual({});
    expect(parseFingerprintCache(' '.repeat(FINGERPRINT_CACHE_MAX_BYTES + 1))).toEqual({});
  });

  it('keeps only well-formed entries', () => {
    const raw = {
      'C:\\ok.mp4': { size: 100, mtimeMs: 1.5, oshash: '0123456789abcdef', extra: 'dropped' },
      'C:\\upper.mp4': { size: 100, mtimeMs: 1, oshash: '0123456789ABCDEF' },
      'C:\\short.mp4': { size: 100, mtimeMs: 1, oshash: '6b3f' },
      'C:\\tiny.mp4': { size: 8, mtimeMs: 1, oshash: '0123456789abcdef' },
      'C:\\nan.mp4': { size: 100, mtimeMs: null, oshash: '0123456789abcdef' },
      'C:\\str.mp4': 'nope',
    };
    expect(normalizeFingerprintCache(raw)).toEqual({ 'C:\\ok.mp4': { size: 100, mtimeMs: 1.5, oshash: '0123456789abcdef' } });
    expect(parseFingerprintCache(Buffer.from(JSON.stringify(raw)))).toEqual(normalizeFingerprintCache(raw));
  });
});

describe('stash-fingerprint: nodeFileIo (the real file access)', () => {
  it('hashes two real fixture files read-only, as the in-memory hash does', async () => {
    const io = nodeFileIo();
    const paths = ['tests/fixtures/stash/stash-schema.graphql', 'tests/fixtures/stash/version.response.json'];
    const res = await fingerprintVideos(paths, { io });
    expect(res.skipped).toEqual([]);
    for (const [i, path] of paths.entries()) {
      expect(res.fingerprints[i].oshash).toBe(oshashOfBytes(fs.readFileSync(path)));
      expect(res.fingerprints[i].size).toBe(fs.statSync(path).size);
    }
  });

  it('fills a read the OS returns in pieces, and returns the short count at the end of the file', async () => {
    const data = bytesOf(1000, 50);
    const calls = [];
    const fsp = {
      stat: async () => ({ size: data.length, mtimeMs: 1, isFile: () => true }),
      open: async (path, flags) => {
        calls.push(['open', path, flags]);
        return {
          read: async (buf, off, len, pos) => {
            const n = Math.min(len, 100, Math.max(0, data.length - pos));
            buf.set(data.subarray(pos, pos + n), off);
            return { bytesRead: n };
          },
          close: async () => { calls.push(['close']); },
        };
      },
    };
    const io = nodeFileIo(fsp);
    const file = await io.open('x');
    expect(Array.from(await file.read(0, 992))).toEqual(Array.from(data.subarray(0, 992)));
    expect((await file.read(950, 100)).length).toBe(50);
    await file.close();
    expect(calls).toEqual([['open', 'x', 'r'], ['close']]);
    const res = await fingerprintVideos(['x'], { io });
    expect(res.fingerprints[0].oshash).toBe(oshashOfBytes(data));
  });
});
