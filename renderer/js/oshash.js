// oshash: the file fingerprint Stash computes for every file it scans, and
// the one stash-box servers (StashDB and the others) look scenes up by.
//
// GROUNDWORK, NOT WIRED (2026-11-17). Nothing in the app imports this yet. It
// is for the Stash stages of the next major
// (notes/features/PLAN-next-major-2026-11.md §4.2): matching FunSync's own
// videos to a Stash library, or to a stash-box, with no path mapping.
//
// The algorithm (Stash's pkg/hash/oshash, the OpenSubtitles hash with Stash's
// small-file rule):
//   - a file of 8 bytes or less has no oshash (an error);
//   - chunk = 64 KiB, or for a smaller file its size rounded DOWN to a
//     multiple of 8;
//   - read `chunk` bytes from the start (head) and `chunk` bytes ending at
//     the end of the file (tail; for a small file the two overlap);
//   - sum = file size + every 8-byte little-endian unsigned word of the head
//     + every one of the tail, modulo 2^64;
//   - the result is 16 lowercase hex digits, zero-padded.
// Two 64 KiB reads per file, no decode and no ffmpeg. It reads no file
// itself: the caller hands it the bytes, or a reader (fs in Electron main,
// a File slice in a renderer), so the module stays renderer-safe.
//
// CONFIRMED AGAINST STASH v0.32.0 ON 2026-11-17. A local test install
// hashed nine synthetic files (2,146 bytes to 7.4 MB, sizes either side of
// 64 KiB and 128 KiB) and this code gave the same oshash for every one
// (notes/features/stash-test-install-2026-11-17.md, vectors in
// tests/fixtures/stash/oshash-vectors.json). tests/unit/oshash.test.js
// checks this code against a second, independent BigInt implementation and
// against values computed once with Python, all on synthetic buffers.

/** Bytes read from each end of the file. */
export const OSHASH_CHUNK_BYTES = 64 * 1024;

const TWO_32 = 2 ** 32;

/**
 * How many bytes to read from each end of a file of this size.
 *
 * @param {number} fileSize bytes
 * @returns {number}
 * @throws {RangeError} for a size that is not a whole number above 8
 */
export function oshashChunkSize(fileSize) {
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
export function oshashReads(fileSize) {
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
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} head the first
 *   `oshashChunkSize(fileSize)` bytes
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} tail the last
 *   `oshashChunkSize(fileSize)` bytes
 * @returns {string} 16 lowercase hex digits
 */
export function oshashFromChunks(fileSize, head, tail) {
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
 *   returns exactly `length` bytes starting at `offset` (a short read, say a
 *   file that shrank, is an error rather than a wrong hash)
 * @returns {Promise<string>}
 */
export async function oshash(fileSize, readAt) {
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
export function oshashOfBytes(data) {
  const bytes = asBytes(data, 'data');
  const [headRead, tailRead] = oshashReads(bytes.byteLength);
  return oshashFromChunks(
    bytes.byteLength,
    bytes.subarray(headRead.offset, headRead.offset + headRead.length),
    bytes.subarray(tailRead.offset, tailRead.offset + tailRead.length),
  );
}
