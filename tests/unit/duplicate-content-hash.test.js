/**
 * @vitest-environment node
 * Real temp files, the REAL electron/content-hash.js and the REAL
 * duplicate-finder.js; no DOM. See notes/CLAUDE.md "Test environments".
 */
// FT-B01 (2026-11-05, new since v0.9.2): "Identical" needs content proof.
//
// Find duplicates called two files Identical when their byte size and
// duration matched. Block A's sandbox had two DIFFERENT videos of 720,304
// bytes and 8 s (first differing byte at 14,251); both were listed as
// Identical and "Select spares in Identical" picked one, with its own
// funscript, for the Recycle Bin. The main process now hashes same-size
// candidates (sha256 of the first, middle and last 1 MiB, the whole file
// under 3 MiB, read-only) and the finder needs the hashes to match.
//
// Real files, because what matters is what is actually on disk: a stubbed
// hash would only repeat our assumption back to us. Every file lives in a
// fresh folder under the OS temp dir (C: on this machine) and is removed
// afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findDuplicates, sameSizeCandidates, TIER } from '../../renderer/js/duplicate-finder.js';

const require_ = createRequire(import.meta.url);
const {
  sampledContentHash, hashFilesSampled, sampleRanges, SAMPLE_BYTES, SAMPLE_WHOLE_BELOW, HASH_CONCURRENCY,
  HASH_TIMEOUT_MS, volumeOf,
} = require_('../../electron/content-hash.js');

const SANDBOX_SIZE = 720_304;      // both block A fixture videos
const SANDBOX_DIFF_AT = 14_251;    // their first differing byte

/** Deterministic pseudo-random bytes, so a failure reproduces exactly. */
function bytes(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

function flipped(buf, at) {
  const out = Buffer.from(buf);
  out[at] ^= 0xff;
  return out;
}

let dir;
const p = (name) => path.join(dir, name);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-ftb01-'));
  const base = bytes(SANDBOX_SIZE, 7);
  fs.writeFileSync(p('Untagged Wide.mp4'), base);
  fs.writeFileSync(p('VR Tagged_180_LR.mp4'), flipped(base, SANDBOX_DIFF_AT));
  fs.writeFileSync(p('Untagged Wide - backup.mp4'), base);

  // Over the whole-file limit, so these are hashed by sample.
  const big = bytes(SAMPLE_WHOLE_BELOW + 2 * SAMPLE_BYTES + 12_345, 99);
  fs.writeFileSync(p('big.mp4'), big);
  fs.writeFileSync(p('big-copy.mp4'), big);
  fs.writeFileSync(p('big-head.mp4'), flipped(big, 10));
  const [, [midStart]] = sampleRanges(big.length);
  fs.writeFileSync(p('big-middle.mp4'), flipped(big, midStart + 500));
  fs.writeFileSync(p('big-tail.mp4'), flipped(big, big.length - 1));
  fs.mkdirSync(p('a folder'));
});

afterAll(() => {
  if (!dir) return;
  for (const f of fs.readdirSync(dir)) {
    try { fs.chmodSync(path.join(dir, f), 0o666); } catch { /* best effort */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the block A sandbox pair, as real files (FT-B01)', () => {
  it('two same-size files whose bytes differ at 14,251 hash differently', async () => {
    const a = await sampledContentHash(p('Untagged Wide.mp4'));
    const b = await sampledContentHash(p('VR Tagged_180_LR.mp4'));
    expect(fs.statSync(p('Untagged Wide.mp4')).size).toBe(fs.statSync(p('VR Tagged_180_LR.mp4')).size);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('end to end: the differing pair is NOT Identical, the byte copy IS', async () => {
    // What the duplicates modal does: stat, hash the same-size candidates in
    // the main process, attach the hashes, find. Same runtime for all three,
    // as the sandbox reported (8 s each).
    const entries = ['Untagged Wide.mp4', 'VR Tagged_180_LR.mp4', 'Untagged Wide - backup.mp4'].map((name) => ({
      path: p(name),
      name,
      duration: 8,
      hasFunscript: name.startsWith('VR '),
      size: fs.statSync(p(name)).size,
    }));
    const candidates = sameSizeCandidates(entries);
    expect(candidates.sort()).toEqual(entries.map((e) => e.path).sort());
    const hashes = await hashFilesSampled(candidates);
    for (const e of entries) e.contentHash = hashes[e.path]?.hash ?? null;

    const groups = findDuplicates(entries);
    const identical = groups.filter((g) => g.tier === TIER.IDENTICAL);
    expect(identical).toHaveLength(1);
    expect(identical[0].members.map((m) => m.name).sort())
      .toEqual(['Untagged Wide - backup.mp4', 'Untagged Wide.mp4']);
    // The scripted, different video is in no Identical group, so "Select
    // spares in Identical" can never tick it.
    const spares = identical.flatMap((g) => g.members.filter((m) => m.path !== g.keeperPath).map((m) => m.path));
    expect(spares).not.toContain(p('VR Tagged_180_LR.mp4'));
    expect(spares).toHaveLength(1);
  });

  it('without the hashes (the old evidence) the differing pair was Identical: the hole this closes', () => {
    // Documents the failure mode with the inputs the old code saw. With no
    // contentHash the fixed finder refuses Identical; the old one did not.
    const groups = findDuplicates(['Untagged Wide.mp4', 'VR Tagged_180_LR.mp4'].map((name) => ({
      path: p(name), name, duration: 8, hasFunscript: false, size: SANDBOX_SIZE,
    })));
    expect(groups.some((g) => g.tier === TIER.IDENTICAL)).toBe(false);
  });
});

describe('sampled hash of large files', () => {
  it('samples first, middle and last 1 MiB above 3 MiB, the whole file below', () => {
    expect(sampleRanges(SANDBOX_SIZE)).toEqual([[0, SANDBOX_SIZE]]);
    expect(sampleRanges(SAMPLE_WHOLE_BELOW - 1)).toEqual([[0, SAMPLE_WHOLE_BELOW - 1]]);
    const n = 10 * SAMPLE_BYTES + 3;
    expect(sampleRanges(n)).toEqual([
      [0, SAMPLE_BYTES],
      [Math.floor((n - SAMPLE_BYTES) / 2), SAMPLE_BYTES],
      [n - SAMPLE_BYTES, SAMPLE_BYTES],
    ]);
    expect(sampleRanges(0)).toEqual([]);
  });

  it('a byte-identical large copy matches; a change in any sampled region does not', async () => {
    const h = await hashFilesSampled(['big.mp4', 'big-copy.mp4', 'big-head.mp4', 'big-middle.mp4', 'big-tail.mp4'].map(p));
    const of = (name) => h[p(name)].hash;
    expect(of('big.mp4')).toMatch(/^[0-9a-f]{64}$/);
    expect(of('big-copy.mp4')).toBe(of('big.mp4'));
    expect(of('big-head.mp4')).not.toBe(of('big.mp4'));
    expect(of('big-middle.mp4')).not.toBe(of('big.mp4'));
    expect(of('big-tail.mp4')).not.toBe(of('big.mp4'));
  });
});

describe('hashFilesSampled: read-only, no proof when it cannot read', () => {
  it('missing files, folders and bad entries come back as no hash, never a throw', async () => {
    const out = await hashFilesSampled([p('does-not-exist.mp4'), p('a folder'), '', 42, null, p('Untagged Wide.mp4')]);
    expect(out[p('does-not-exist.mp4')]).toEqual({ hash: null });
    expect(out[p('a folder')]).toEqual({ hash: null });
    expect(Object.keys(out).sort()).toEqual([p('a folder'), p('does-not-exist.mp4'), p('Untagged Wide.mp4')].sort());
    expect(out[p('Untagged Wide.mp4')].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashFilesSampled('not an array')).toEqual({});
    expect(await hashFilesSampled(undefined)).toEqual({});
  });

  it('hashes a READ-ONLY file and leaves its bytes and mtime untouched', async () => {
    const f = p('Untagged Wide - backup.mp4');
    const before = fs.readFileSync(f);
    const mtime = fs.statSync(f).mtimeMs;
    fs.chmodSync(f, 0o444);   // opening for write would now fail
    try {
      const h = await sampledContentHash(f);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.chmodSync(f, 0o666);
    }
    expect(fs.readFileSync(f).equals(before)).toBe(true);
    expect(fs.statSync(f).mtimeMs).toBe(mtime);
  });

  it('never runs more than the concurrency bound at once, and hashes each path once', async () => {
    let inFlight = 0; let peak = 0; const calls = [];
    const hashFn = async (file) => {
      calls.push(file);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return `h-${file}`;
    };
    const list = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const out = await hashFilesSampled([...list, 'f3', 'f3'], { hashFn });
    expect(peak).toBeLessThanOrEqual(HASH_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(calls.filter((c) => c === 'f3')).toHaveLength(1);
    expect(Object.keys(out)).toHaveLength(20);
  });

  it('a hash function that throws gives that path no hash and does not stop the batch', async () => {
    const out = await hashFilesSampled(['ok', 'bad'], {
      hashFn: async (f) => { if (f === 'bad') throw new Error('EBUSY'); return 'h'; },
    });
    expect(out).toEqual({ ok: { hash: 'h' }, bad: { hash: null } });
  });
});

// CB-18 (2026-11-05, found verifying block B; new since v0.9.2): the
// hash-video-files IPC had no timeout, and the Find duplicates dialog waits
// for it. A read on a dead network share can hang for minutes, so one such
// file would hang the dialog. Now each file has a deadline (no hash past it:
// not proven identical), and the rest of a share that timed out is not read.
// The hanging read is a hash function that never settles; the deadline is cut
// to 60 ms so the test runs in real time.
describe('hashFilesSampled: a hung read cannot hang Find duplicates (CB-18)', () => {
  const NAS = (n) => `\\\\nas\\videos\\${n}.mp4`;
  const LOCAL = (n) => `C:\\Lib\\${n}.mp4`;
  const hangsOnNas = (calls) => (file) => {
    calls.push(file);
    return file.startsWith('\\\\nas') ? new Promise(() => {}) : Promise.resolve(`h-${file}`);
  };

  it('a file that never answers has no hash once its time is up; the others still hash', async () => {
    const calls = [];
    const started = Date.now();
    const out = await hashFilesSampled([NAS('a'), LOCAL('b'), LOCAL('c')], { hashFn: hangsOnNas(calls), timeoutMs: 60 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(out[NAS('a')]).toEqual({ hash: null, timedOut: true });
    expect(out[LOCAL('b')]).toEqual({ hash: `h-${LOCAL('b')}` });
    expect(out[LOCAL('c')]).toEqual({ hash: `h-${LOCAL('c')}` });
  }, 3000);

  it('the rest of a share that timed out is not read: at most one hung read per worker', async () => {
    const calls = [];
    const nas = Array.from({ length: 12 }, (_, i) => NAS(`clip ${i}`));
    const out = await hashFilesSampled([...nas, LOCAL('x'), LOCAL('y')], { hashFn: hangsOnNas(calls), timeoutMs: 60 });
    expect(calls.filter((f) => f.startsWith('\\\\nas')).length).toBeLessThanOrEqual(HASH_CONCURRENCY);
    expect(nas.every((f) => out[f].hash === null)).toBe(true);
    expect(out[LOCAL('x')].hash).toBe(`h-${LOCAL('x')}`);
    expect(out[LOCAL('y')].hash).toBe(`h-${LOCAL('y')}`);
  }, 3000);

  it('a slow file that answers in time still hashes; the default deadline is generous (20 s)', async () => {
    const out = await hashFilesSampled([LOCAL('slow')], {
      hashFn: () => new Promise((r) => setTimeout(() => r('late but fine'), 20)),
      timeoutMs: 500,
    });
    expect(out[LOCAL('slow')]).toEqual({ hash: 'late but fine' });
    expect(HASH_TIMEOUT_MS).toBeGreaterThanOrEqual(20000);
  });

  it('volumes: a UNC share, a drive, the first two folders elsewhere', () => {
    expect(volumeOf('\\\\NAS\\Videos\\a\\b.mp4')).toBe('//nas/videos');
    expect(volumeOf('D:\\Lib\\x.mp4')).toBe('d:');
    expect(volumeOf('d:/Other/y.mp4')).toBe('d:');
    expect(volumeOf('/mnt/nas/z.mp4')).toBe('/mnt/nas');
  });
});
