/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// renderer/js/oshash.js: Stash's file fingerprint (groundwork for the Stash
// stages of the next major, 2026-11-17; nothing in the app uses it yet).
//
// Where the expected values come from, since no real Stash was available:
//   1. refOshash below, a second implementation written independently of
//      the module (BigInt and DataView.getBigUint64 over the whole buffer;
//      the module adds 32-bit halves in doubles over two chunks);
//   2. PYTHON_VECTORS, computed ONCE on 2026-11-17 by a third implementation
//      in Python (struct.unpack('<NQ') sums, Stash's small-file rule) over
//      the same synthetic buffers, and pasted here;
//   3. two values worked out by hand (all-zero and all-0xFF files).
// Every buffer is synthetic. The vectors still need confirming against a
// hash computed by a real Stash (see the module header).
import { describe, it, expect } from 'vitest';
import {
  OSHASH_CHUNK_BYTES,
  oshashChunkSize,
  oshashReads,
  oshashFromChunks,
  oshash,
  oshashOfBytes,
} from '../../renderer/js/oshash.js';

// byte i = the top byte of (i * 2654435761) mod 2^32 (Knuth's multiplicative
// hash): cheap, deterministic, and the same in Python.
function gen(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.imul(i, 2654435761) >>> 24;
  return out;
}

// The independent reference: Stash's rules, written from the description,
// with BigInt arithmetic over the whole in-memory file.
function refOshash(bytes) {
  const size = bytes.length;
  if (size <= 8) throw new Error('too small');
  const chunk = size < 65536 ? Math.floor(size / 8) * 8 : 65536;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = BigInt(size);
  for (let i = 0; i < chunk; i += 8) sum += view.getBigUint64(i, true);
  for (let i = size - chunk; i < size; i += 8) sum += view.getBigUint64(i, true);
  return BigInt.asUintN(64, sum).toString(16).padStart(16, '0');
}

// Computed once with Python on 2026-11-17 (the script, not kept in the repo:
// gen(n) = bytes(((i * 2654435761) & 0xFFFFFFFF) >> 24 for i in range(n));
// chunk = 65536 if size >= 65536 else size // 8 * 8; sum of
// struct.unpack('<%dQ') over head and tail, plus size, & 0xFFFFFFFFFFFFFFFF).
const PYTHON_VECTORS = [
  [9, '4508cc905316daa7'],
  [16, '32b83fc74cd65bf2'],
  [17, '6df57c038a11992f'],
  [100, '224e7aa4ccf925a8'],
  [4096, 'cef20f3a577ab1be'],
  [65535, '3f98f859b11754d0'],
  [65536, 'bbe3f828406170aa'],
  [65537, 'aacfee1034515899'],
  [131072, 'dafd1d43648683c7'],
  [131073, 'c9ef07354f767cb6'],
  [200000, '89adc5f30f3445b5'],
  [1000003, '0c2e4a748fc3fc39'],
];

// A reader over an in-memory buffer, recording what it was asked for.
function memoryReader(bytes, calls = []) {
  return (offset, length) => {
    calls.push([offset, length]);
    return bytes.slice(offset, offset + length);
  };
}

describe('oshash: known vectors', () => {
  for (const [size, hash] of PYTHON_VECTORS) {
    it(`${size} bytes: matches Python and the BigInt reference`, async () => {
      const bytes = gen(size);
      expect(refOshash(bytes)).toBe(hash);
      expect(oshashOfBytes(bytes)).toBe(hash);
      expect(await oshash(size, memoryReader(bytes))).toBe(hash);
    });
  }

  it('an all-zero file hashes to its size', () => {
    expect(oshashOfBytes(new Uint8Array(65536))).toBe('0000000000010000');
    expect(oshashOfBytes(new Uint8Array(100))).toBe('0000000000000064');
  });

  it('the sum wraps at 2^64 (all 0xFF bytes)', () => {
    // 16384 words of 2^64 - 1, plus 131072: -16384 + 131072 = 114688 = 0x1c000.
    expect(oshashOfBytes(new Uint8Array(131072).fill(0xff))).toBe('000000000001c000');
  });
});

describe('oshash: agrees with the reference on many synthetic files', () => {
  it('every size from 9 to 600 bytes, and around the 64 KiB edges', () => {
    const sizes = [];
    for (let n = 9; n <= 600; n += 1) sizes.push(n);
    for (const edge of [65536, 131072]) for (let d = -9; d <= 9; d += 1) sizes.push(edge + d);
    const big = gen(131072 + 9);
    for (const size of sizes) {
      const bytes = big.subarray(0, size);
      expect(oshashOfBytes(bytes), `size ${size}`).toBe(refOshash(bytes));
    }
  });

  it('random contents (seeded), any size', () => {
    let state = 0x2545f491;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let round = 0; round < 40; round += 1) {
      const size = 9 + (next() % 300000);
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) bytes[i] = next() & 0xff;
      expect(oshashOfBytes(bytes), `size ${size}`).toBe(refOshash(bytes));
    }
  });
});

describe('oshash: reads', () => {
  it('reads 64 KiB from each end of a big file, and nothing else', async () => {
    const bytes = gen(1000003);
    const calls = [];
    await oshash(bytes.length, memoryReader(bytes, calls));
    expect(calls).toEqual([[0, 65536], [1000003 - 65536, 65536]]);
    expect(OSHASH_CHUNK_BYTES).toBe(65536);
  });

  it('reads the size rounded down to 8 from each end of a small file (never 64 KiB)', () => {
    expect(oshashChunkSize(100)).toBe(96);
    expect(oshashChunkSize(9)).toBe(8);
    expect(oshashChunkSize(65535)).toBe(65528);
    expect(oshashChunkSize(65536)).toBe(65536);
    expect(oshashReads(100)).toEqual([{ offset: 0, length: 96 }, { offset: 4, length: 96 }]);
  });

  it('handles sizes past 4 GiB without reading them (a zero-filled virtual file)', async () => {
    const zeros = (offset, length) => new Uint8Array(length);
    expect(await oshash(5 * 2 ** 30, zeros)).toBe('0000000140000000');
    expect(await oshash(2 ** 53 - 1, zeros)).toBe('001fffffffffffff');
  });

  it('takes an async reader, ArrayBuffers and typed-array views', async () => {
    const bytes = gen(70000);
    const expected = refOshash(bytes);
    expect(await oshash(bytes.length, async (o, l) => bytes.slice(o, o + l).buffer)).toBe(expected);
    const padded = new Uint8Array(bytes.length + 16);
    padded.set(bytes, 16);
    expect(oshashOfBytes(new DataView(padded.buffer, 16))).toBe(expected);
    const [h, t] = oshashReads(bytes.length);
    expect(oshashFromChunks(bytes.length, bytes.subarray(h.offset, h.offset + h.length), bytes.subarray(t.offset, t.offset + t.length))).toBe(expected);
  });
});

describe('oshash: errors', () => {
  it('a file of 8 bytes or less has no oshash', async () => {
    for (const size of [0, 1, 7, 8]) {
      expect(() => oshashChunkSize(size)).toThrow(RangeError);
      expect(() => oshashOfBytes(new Uint8Array(size))).toThrow(/8 bytes or less/);
    }
    await expect(oshash(8, () => new Uint8Array(8))).rejects.toThrow(RangeError);
  });

  it('a size that is not a whole number of bytes is refused', () => {
    for (const size of [-1, 1.5, NaN, Infinity, '100', null, 2 ** 53]) {
      expect(() => oshashChunkSize(size)).toThrow(RangeError);
    }
  });

  it('a short read (a file that shrank) is an error, not a wrong hash', async () => {
    const bytes = gen(70000);
    await expect(oshash(bytes.length, (o, l) => bytes.slice(o, o + l - 1))).rejects.toThrow(/expected 65536 bytes/);
    await expect(oshash(bytes.length, () => 'not bytes')).rejects.toThrow(TypeError);
    await expect(oshash(bytes.length, null)).rejects.toThrow(TypeError);
  });
});
