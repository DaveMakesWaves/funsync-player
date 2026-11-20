/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// renderer/js/oshash.js against Stash's own values. A local Stash v0.32.0 test
// install (2026-11-17, notes/features/stash-test-install-2026-11-17.md) hashed
// synthetic files only; tests/fixtures/stash/oshash-vectors.json keeps the
// tiny clip (base64) and the recipe that rebuilds the edge-size files byte for
// byte (the clip, then one MP4 "free" atom of seeded filler up to the size),
// with Stash's oshash for each. The files are rebuilt here in memory (nothing
// is written to disk) and hashed both ways the module offers: the whole
// buffer, and the two reads a caller makes (head, then tail).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { oshash, oshashOfBytes, oshashReads } from '../../renderer/js/oshash.js';

const FIX = JSON.parse(fs.readFileSync('tests/fixtures/stash/oshash-vectors.json', 'utf8'));
const TINY = new Uint8Array(Buffer.from(FIX.tinyClipBase64, 'base64'));

/** The recipe: the tiny clip, then a free atom (4-byte big-endian length, "free", seeded filler) padding it to `size`. */
function tinyClipPlusFreeAtom(size) {
  const out = new Uint8Array(size);
  out.set(TINY, 0);
  const atom = size - TINY.length;
  new DataView(out.buffer).setUint32(TINY.length, atom, false);
  out.set([0x66, 0x72, 0x65, 0x65], TINY.length + 4); // "free"
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

const REBUILT = FIX.vectors.filter((v) => v.rebuild);

describe('oshash equals Stash v0.32.0 on the rebuilt synthetic files', () => {
  it('the fixture is the Stash test install\'s: v0.32.0, the tiny clip and 5 edge sizes either side of 64 / 128 KiB', () => {
    expect(FIX.stashVersion).toBe('v0.32.0');
    expect(TINY.length).toBe(FIX.vectors.find((v) => v.rebuild === 'tinyClip').size);
    expect(REBUILT.map((v) => v.size)).toEqual([2146, 65535, 65536, 65543, 131072, 131079]);
    // the seed is the one the recipe names (0x20261117)
    expect(FIX.freeAtomSeed).toBe(0x20261117);
  });

  for (const v of REBUILT) {
    it(`${v.file} (${v.size} bytes): ${v.stashOshash}`, async () => {
      const bytes = rebuild(v);
      expect(bytes.length).toBe(v.size);
      expect(oshashOfBytes(bytes)).toBe(v.stashOshash);
      // the two reads a caller makes, through a reader over the same bytes
      const reads = [];
      const got = await oshash(v.size, (offset, length) => {
        reads.push([offset, length]);
        return bytes.slice(offset, offset + length);
      });
      expect(got).toBe(v.stashOshash);
      expect(reads).toEqual(oshashReads(v.size).map((r) => [r.offset, r.length]));
    });
  }

  it('the rows not embedded (bigger clips) keep their Stash value as a 16-digit reference', () => {
    const rest = FIX.vectors.filter((v) => !v.rebuild);
    expect(rest.length).toBeGreaterThan(0);
    for (const v of rest) expect(v.stashOshash).toMatch(/^[0-9a-f]{16}$/);
  });
});
