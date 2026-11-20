/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The duplicate finder's "Looks the same (Stash)" tier (Stash "next" lot,
// stage sn-library, 2026-11-19; DESIGN-stash-s1.md (j) #2). The seeded test
// Stash has synthetic_large.mkv and its re-encode synthetic_large_reencode.mp4
// with the same phash (ab63cd1cc33c3343; tests/fixtures/stash/README.md) and
// different sizes and containers. FunSync alone calls that pair Likely (same
// runtime, similar names); renamed, FunSync finds nothing, and Stash's phash
// still does. Asserted: the tier, its rank, that it is never Identical, and
// that a video without a linked phash is never in it.
import { describe, it, expect } from 'vitest';
import { findDuplicates, TIER } from '../../renderer/js/duplicate-finder.js';
import { stashSceneFields } from '../../renderer/js/stash-scene-fields.js';
import { P, snProjection, snVideos } from '../helpers/stash-next-fixtures.js';

const DATA = snProjection();

/** The re-encode as a user may have it: renamed, so its name says nothing. */
const RENAMED = 'zz_export_7731.mp4';

/** The modal's entries: the library video, its size, and its linked scene's phash (Stash on). */
function entries({ data = DATA, enabled = true, renamed = false } = {}) {
  return snVideos().map((v) => {
    const name = renamed && v.path === P.reencode ? RENAMED : v.name;
    const e = { path: v.path, name, duration: v.duration, hasFunscript: false, size: v.size, contentHash: null };
    const f = stashSceneFields(data, v.path, { size: v.size, enabled });
    if (f) {
      e.stashSceneId = f.sceneId;
      if (f.phash) e.stashPhash = f.phash;
    }
    return e;
  });
}

const groupOf = (groups, path) => groups.find((g) => g.members.some((m) => m.path === path));

describe('"Looks the same (Stash)": equal phashes of linked scenes', () => {
  it('the re-encode and its original: "Looks the same (Stash)" (FunSync alone says only Likely)', () => {
    expect(groupOf(findDuplicates(entries({ enabled: false })), P.reencode).tier).toBe(TIER.LIKELY);
    const groups = findDuplicates(entries());
    const stash = groups.filter((g) => g.tier === TIER.STASH);
    expect(stash).toHaveLength(1);
    expect(stash[0].members.map((m) => m.path).sort()).toEqual([P.large, P.reencode].sort());
    // The bigger copy is the suggested keeper (pickKeeper's rule), nothing else.
    expect(stash[0].keeperPath).toBe(P.large);
  });

  it('a renamed re-encode: only Stash finds it; without Stash (off, or no phash) it is no duplicate', () => {
    const g = groupOf(findDuplicates(entries({ renamed: true })), P.reencode);
    expect(g.tier).toBe(TIER.STASH);
    expect(g.members.map((m) => m.path).sort()).toEqual([P.large, P.reencode].sort());
    expect(groupOf(findDuplicates(entries({ enabled: false, renamed: true })), P.reencode)).toBeUndefined();
    const noPhash = snProjection({ scenes: { 10: { phash: null } } });
    expect(groupOf(findDuplicates(entries({ data: noPhash, renamed: true })), P.reencode)).toBeUndefined();
  });

  it('an unlinked video is never in the tier, whatever its scene\'s phash', () => {
    const data = snProjection({ unlinked: [P.reencode] });
    expect(groupOf(findDuplicates(entries({ data, renamed: true })), P.reencode)).toBeUndefined();
    expect(groupOf(findDuplicates(entries({ data })), P.reencode).tier).toBe(TIER.LIKELY);
  });

  it('is never Identical: equal phashes are not proof of the bytes', () => {
    const list = entries();
    const groups = findDuplicates(list);
    expect(groups.some((g) => g.tier === TIER.IDENTICAL)).toBe(false);
  });

  it('a byte copy that also shares the phash stays Identical (the stronger evidence wins)', () => {
    const large = entries().find((e) => e.path === P.large);
    const copy = { ...large, path: 'C:\\Lib\\Copies\\synthetic_large.mkv', contentHash: 'same' };
    const groups = findDuplicates([{ ...large, contentHash: 'same' }, copy]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tier).toBe(TIER.IDENTICAL);
  });

  it('outranks Likely: a pair with the same phash and the same runtime and name is "Looks the same (Stash)"', () => {
    const a = { path: 'C:\\L\\Film 4K.mp4', name: 'Film 4K.mp4', duration: 600, size: 4000, stashPhash: 'AB63CD1CC33C3343' };
    const b = { path: 'C:\\L\\Film 1080p.mp4', name: 'Film 1080p.mp4', duration: 600, size: 1000, stashPhash: 'ab63cd1cc33c3343' };
    expect(findDuplicates([a, b]).map((g) => g.tier)).toEqual([TIER.STASH]);
    const { stashPhash: _a, ...a2 } = a;
    const { stashPhash: _b, ...b2 } = b;
    expect(findDuplicates([a2, b2]).map((g) => g.tier)).toEqual([TIER.LIKELY]);
  });

  it('sorts between Identical and Likely', () => {
    const byte = [
      { path: 'C:\\L\\x.mp4', name: 'x.mp4', size: 10, duration: 5, contentHash: 'h' },
      { path: 'C:\\L\\x copy.mp4', name: 'x copy.mp4', size: 10, duration: 5, contentHash: 'h' },
    ];
    const likely = [
      { path: 'C:\\L\\Movie Night 4K.mp4', name: 'Movie Night 4K.mp4', duration: 900, size: 50 },
      { path: 'C:\\L\\Movie Night 1080p.mp4', name: 'Movie Night 1080p.mp4', duration: 900, size: 20 },
    ];
    const tiers = findDuplicates([...entries(), ...byte, ...likely]).map((g) => g.tier);
    expect(tiers).toEqual([TIER.IDENTICAL, TIER.STASH, TIER.LIKELY]);
  });

  it('a malformed phash groups nothing', () => {
    const a = { path: 'C:\\L\\a.mp4', name: 'a.mp4', size: 1, stashPhash: 'not-a-phash' };
    const b = { path: 'C:\\L\\b.mp4', name: 'b.mp4', size: 2, stashPhash: 'not-a-phash' };
    expect(findDuplicates([a, b])).toEqual([]);
  });
});

describe("Stash's own duplicate sets (when the synced data carries them)", () => {
  it('videos linked to scenes of one set are "Looks the same (Stash)"', () => {
    const list = entries({ data: snProjection({ scenes: { 2: { phash: null }, 10: { phash: null } } }), renamed: true });
    expect(groupOf(findDuplicates(list), P.reencode)).toBeUndefined();
    const groups = findDuplicates(list, { stashSceneSets: [['2', '10']] });
    const g = groupOf(groups, P.reencode);
    expect(g.tier).toBe(TIER.STASH);
    expect(g.members.map((m) => m.path).sort()).toEqual([P.large, P.reencode].sort());
  });

  it('a set naming scenes no video is linked to adds nothing; junk is ignored', () => {
    const list = entries({ data: snProjection({ scenes: { 2: { phash: null }, 10: { phash: null } } }), renamed: true });
    expect(findDuplicates(list, { stashSceneSets: [['98', '99'], 'junk', [null, 7]] }).some((g) => g.tier === TIER.STASH)).toBe(false);
  });
});
