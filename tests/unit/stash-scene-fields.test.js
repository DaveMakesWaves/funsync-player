/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash's numbers for the library (Stash "next" lot, stage sn-library,
// 2026-11-19; DESIGN-stash-s1.md (j) #2, #3, #10): renderer/js/stash-scene-
// fields.js over the seeded test Stash's scenes in the lot's data contract
// (tests/helpers/stash-next-fixtures.js). Asserted: only a linked video
// whose link counts has fields; unknown is null, never 0 plays; the filter
// keeps exactly the videos Stash rates N stars or more / marks organised.
import { describe, it, expect } from 'vitest';
import {
  stashSceneFields, stashFieldsIndex, applyStashFilter, stashFilterActive, emptyStashFilter,
  stashActivity, STASH_STAR,
} from '../../renderer/js/stash-scene-fields.js';
import { P, SERVER, snProjection, snVideos } from '../helpers/stash-next-fixtures.js';

const VIDEOS = snVideos();
const sizeOf = (path) => VIDEOS.find((v) => v.path === path).size;
const fieldsOf = (data, path, size = sizeOf(path)) => stashSceneFields(data, path, { size, enabled: true });

describe('stashSceneFields: the linked scene\'s numbers', () => {
  it('reads the seeded values (rating, organised, plays, last played, O-count, phash)', () => {
    const f = fieldsOf(snProjection(), P.large);
    expect(f).toMatchObject({
      sceneId: '2', rating100: 100, organized: true, playCount: 5,
      lastPlayedAt: '2026-11-17T21:45:00Z', lastPlayedMs: Date.parse('2026-11-17T21:45:00Z'),
      oCounter: 3, phash: 'ab63cd1cc33c3343',
    });
    expect(fieldsOf(snProjection(), P.tiny)).toMatchObject({ rating100: 20, organized: true, playCount: 0, lastPlayedAt: null, phash: null });
  });

  it('Stash off (enabled not exactly true) gives nothing', () => {
    const data = snProjection();
    expect(stashSceneFields(data, P.large, { size: sizeOf(P.large) })).toBeNull();
    expect(stashSceneFields(data, P.large, { size: sizeOf(P.large), enabled: 'true' })).toBeNull();
    expect(stashFieldsIndex(data, VIDEOS, { enabled: false }).size).toBe(0);
  });

  it('an unlinked video has none', () => {
    expect(fieldsOf(snProjection({ unlinked: [P.mid] }), P.mid)).toBeNull();
  });

  it('the trust check: a file whose size differs from the link\'s shows none of the old scene\'s numbers', () => {
    const data = snProjection();
    expect(fieldsOf(data, P.large, sizeOf(P.large) + 1)).toBeNull();
    // An unknown size on either side is trusted (stash-tags.js's rule).
    expect(fieldsOf(data, P.large, null)).not.toBeNull();
  });

  it('a link in another state than ok / gone counts for nothing; gone keeps its data', () => {
    const base = snProjection();
    const withState = (state) => snProjection({ links: { [P.large]: { ...base.links[P.large], state } } });
    expect(fieldsOf(withState('changed'), P.large)).toBeNull();
    expect(fieldsOf(withState('gone'), P.large)?.rating100).toBe(100);
  });

  it('a scene from another server than the link\'s is not this link\'s scene', () => {
    const data = snProjection({ scenes: { 2: { server: 'http://192.168.1.20:9999' } } });
    expect(fieldsOf(data, P.large)).toBeNull();
    expect(snProjection().links[P.large].server).toBe(SERVER);
  });

  it('an older library.json (no plays, O-count or phash) is unknown, never "0 plays"', () => {
    const f = fieldsOf(snProjection({ omitNext: true }), P.large);
    expect(f).toMatchObject({ rating100: 100, organized: true, playCount: null, lastPlayedAt: null, oCounter: null, phash: null });
    expect(stashActivity(f)).toEqual({ plays: null, lastPlayed: null, oCount: null });
  });

  it('malformed values are unknown (no NaN, no negative counts, no odd phash)', () => {
    const data = snProjection({ scenes: { 2: { rating100: 'high', playCount: -1, oCounter: 1.5, lastPlayedAt: 'yesterday', phash: 'zz63cd1cc33c3343' } } });
    expect(fieldsOf(data, P.large)).toMatchObject({ rating100: null, playCount: null, oCounter: null, lastPlayedAt: null, lastPlayedMs: null, phash: null });
  });

  it('a path like __proto__ is never looked up on the prototype', () => {
    expect(stashSceneFields(snProjection(), '__proto__', { enabled: true })).toBeNull();
    expect(stashSceneFields(snProjection(), 'constructor', { enabled: true })).toBeNull();
  });
});

describe('the library filter: "Rated N stars or more" and "Organised in Stash"', () => {
  const index = stashFieldsIndex(snProjection(), VIDEOS, { enabled: true });
  const kept = (state) => applyStashFilter(VIDEOS, state, index).map((v) => v.path).sort();

  it('20 rating points per star: 4 stars keeps 80 and 100, never an unrated video', () => {
    expect(STASH_STAR).toBe(20);
    expect(kept({ minStars: 4 })).toEqual([P.large, P.edge131072, P.small].sort());
    expect(kept({ minStars: 5 })).toEqual([P.large]);
    expect(kept({ minStars: 1 })).toEqual([P.large, P.mid, P.tiny, P.small, P.edge131072].sort());
  });

  it('organised keeps only the scenes Stash marks organised', () => {
    expect(kept({ organized: true })).toEqual([P.large, P.tiny, P.small].sort());
  });

  it('both: rated 3 stars or more AND organised', () => {
    expect(kept({ minStars: 3, organized: true })).toEqual([P.large, P.small].sort());
  });

  it('an unlinked video never passes a Stash filter', () => {
    const idx = stashFieldsIndex(snProjection({ unlinked: [P.large] }), VIDEOS, { enabled: true });
    expect(applyStashFilter(VIDEOS, { minStars: 1 }, idx).map((v) => v.path)).not.toContain(P.large);
  });

  it('no filter lets every video through, in order', () => {
    expect(stashFilterActive(emptyStashFilter())).toBe(false);
    expect(applyStashFilter(VIDEOS, emptyStashFilter(), index)).toBe(VIDEOS);
    expect(stashFilterActive({ minStars: 7 })).toBe(false);
  });
});

describe('stashActivity: the dialog\'s lines', () => {
  const data = snProjection();
  it('plays, a date and an O-count when Stash has them', () => {
    expect(stashActivity(fieldsOf(data, P.large))).toEqual({
      plays: 5, lastPlayed: { at: '2026-11-17T21:45:00Z', ms: Date.parse('2026-11-17T21:45:00Z') }, oCount: 3,
    });
  });
  it('"never" only when Stash counts no plays', () => {
    expect(stashActivity(fieldsOf(data, P.edge131072))).toEqual({ plays: 0, lastPlayed: 'never', oCount: 2 });
    // Plays without a date: unknown, not "never".
    const odd = snProjection({ scenes: { 3: { lastPlayedAt: null } } });
    expect(stashActivity(fieldsOf(odd, P.mid)).lastPlayed).toBeNull();
  });
  it('no fields, no lines', () => {
    expect(stashActivity(null)).toBeNull();
  });
});
