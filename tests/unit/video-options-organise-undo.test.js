/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The Organise section's ticks (DESIGN-video-options.md (b), test plan row
// "Playlist untick and Undo"): an untick removes the video, and its Undo puts
// it back at its ORIGINAL index, not on the end. store.js only appends and
// only takes a pure reorder, so the Undo is an add plus a reorder; the fake
// store keeps both rules. The same for categories (exact array order) and
// libraries (include and exclude lists).

import { describe, it, expect } from 'vitest';
import {
  organiseView, planPlaylistToggle, planPlaylistUndo, planCategoryToggle, planCategoryUndo,
  planCollectionToggle, planCollectionUndo, runOps, reinsertAt,
} from '../../renderer/js/video-options-model.js';
import { makeFakeStore } from './helpers/video-options-fake-store.js';

const V = 'C:\\Videos\\v.mp4';

function playlistStore(paths) {
  return makeFakeStore({ playlists: [{ id: 'p1', name: 'Morning', videoPaths: paths }, { id: 'p2', name: 'Other', videoPaths: ['z'] }] });
}
const pl = (store, id = 'p1') => store.state.playlists.find((p) => p.id === id);

describe('Playlist untick and Undo', () => {
  it('untick removes the video; Undo restores it at its original index', () => {
    const store = playlistStore(['a', V, 'b', 'c']);
    const plan = planPlaylistToggle({ playlist: pl(store), videoPath: V, checked: false });
    expect(plan).toMatchObject({ changed: true, index: 1 });
    runOps(plan.ops, store);
    expect(pl(store).videoPaths).toEqual(['a', 'b', 'c']);
    const undo = planPlaylistUndo(plan, pl(store));
    expect(undo.ok).toBe(true);
    runOps(undo.ops, store);
    expect(pl(store).videoPaths).toEqual(['a', V, 'b', 'c']);
    expect(pl(store, 'p2').videoPaths).toEqual(['z']);
  });

  it('the first and the last place come back too', () => {
    for (const before of [[V, 'a', 'b'], ['a', 'b', V], [V]]) {
      const store = playlistStore(before.slice());
      const plan = planPlaylistToggle({ playlist: pl(store), videoPath: V, checked: false });
      runOps(plan.ops, store);
      runOps(planPlaylistUndo(plan, pl(store)).ops, store);
      expect(pl(store).videoPaths).toEqual(before);
    }
  });

  it('a reorder made since is kept: the video goes back after the one it followed', () => {
    const store = playlistStore(['a', V, 'b', 'c']);
    const plan = planPlaylistToggle({ playlist: pl(store), videoPath: V, checked: false });
    runOps(plan.ops, store);
    pl(store).videoPaths = ['c', 'a', 'b'];
    runOps(planPlaylistUndo(plan, pl(store)).ops, store);
    expect(pl(store).videoPaths).toEqual(['c', 'a', V, 'b']);
  });

  it('when the one before it is gone, it goes back before the one it preceded', () => {
    const store = playlistStore(['a', V, 'b']);
    const plan = planPlaylistToggle({ playlist: pl(store), videoPath: V, checked: false });
    runOps(plan.ops, store);
    pl(store).videoPaths = ['x', 'b'];
    runOps(planPlaylistUndo(plan, pl(store)).ops, store);
    expect(pl(store).videoPaths).toEqual(['x', V, 'b']);
  });

  it('planning writes nothing; a video already back is not added twice; a deleted playlist is reported', () => {
    const store = playlistStore(['a', V]);
    const plan = planPlaylistToggle({ playlist: pl(store), videoPath: V, checked: false });
    expect(store.writes()).toEqual([]);
    expect(planPlaylistUndo(plan, pl(store))).toEqual({ ok: true, ops: [] });
    expect(planPlaylistUndo(plan, null)).toMatchObject({ ok: false, reason: 'gone' });
  });

  it('untick of a video the playlist does not hold changes nothing', () => {
    const plan = planPlaylistToggle({ playlist: { id: 'p1', videoPaths: ['a'] }, videoPath: V, checked: false });
    expect(plan).toMatchObject({ changed: false, ops: [] });
  });

  it('tick appends (as the store does); its Undo takes the video out again', () => {
    const store = playlistStore(['a', 'b']);
    const plan = planPlaylistToggle({ playlist: pl(store), videoPath: V, checked: true });
    runOps(plan.ops, store);
    expect(pl(store).videoPaths).toEqual(['a', 'b', V]);
    runOps(planPlaylistUndo(plan, pl(store)).ops, store);
    expect(pl(store).videoPaths).toEqual(['a', 'b']);
  });
});

describe('Category tick and untick, with Undo restoring the exact array', () => {
  const cat = { id: 'X', name: 'Blowjob' };
  const cats = (store) => store.state.videoCategories;

  it('[a, X, b]: untick X, Undo gives [a, X, b] back, not [a, b, X]', () => {
    const store = makeFakeStore({ videoCategories: { [V]: ['a', 'X', 'b'], other: ['X'] } });
    const plan = planCategoryToggle({ videoPath: V, categoryIds: cats(store)[V], category: cat, checked: false });
    runOps(plan.ops, store);
    expect(cats(store)[V]).toEqual(['a', 'b']);
    const undo = planCategoryUndo(plan, cats(store)[V]);
    runOps(undo.ops, store);
    expect(JSON.stringify(cats(store)[V])).toBe(JSON.stringify(['a', 'X', 'b']));
    expect(cats(store).other).toEqual(['X']);
  });

  it('the only category: the key goes, and Undo brings it back', () => {
    const store = makeFakeStore({ videoCategories: { [V]: ['X'] } });
    const plan = planCategoryToggle({ videoPath: V, categoryIds: cats(store)[V], category: cat, checked: false });
    runOps(plan.ops, store);
    expect(V in cats(store)).toBe(false);
    runOps(planCategoryUndo(plan, cats(store)[V]).ops, store);
    expect(cats(store)[V]).toEqual(['X']);
  });

  it('tick then Undo: back to no key at all', () => {
    const store = makeFakeStore({ videoCategories: {} });
    const plan = planCategoryToggle({ videoPath: V, categoryIds: cats(store)[V], category: cat, checked: true });
    runOps(plan.ops, store);
    expect(cats(store)[V]).toEqual(['X']);
    runOps(planCategoryUndo(plan, cats(store)[V]).ops, store);
    expect(JSON.stringify(cats(store))).toBe('{}');
  });

  it('another category ticked since stays ticked after the Undo', () => {
    const store = makeFakeStore({ videoCategories: { [V]: ['a', 'X'] } });
    const plan = planCategoryToggle({ videoPath: V, categoryIds: cats(store)[V], category: cat, checked: false });
    runOps(plan.ops, store);
    store.assignCategory(V, 'c');
    runOps(planCategoryUndo(plan, cats(store)[V]).ops, store);
    expect(cats(store)[V]).toEqual(['a', 'X', 'c']);
  });
});

describe('Libraries (collections) tick and untick', () => {
  const descendantsOf = (index, folder) => index.get(folder) || [];

  it('a plain library: untick and Undo put the path back where it was', () => {
    const before = { id: 'c1', name: 'Gym', videoPaths: ['a', V, 'b'] };
    const store = makeFakeStore({ library: { collections: [before] } });
    const cols = () => store.state.library.collections;
    const plan = planCollectionToggle({ collection: cols()[0], videoPath: V, checked: false });
    runOps(plan.ops, store);
    expect(cols()[0].videoPaths).toEqual(['a', 'b']);
    runOps(planCollectionUndo(plan, cols()[0]).ops, store);
    expect(JSON.stringify(cols()[0])).toBe(JSON.stringify(before));
  });

  it('a synced library: untick excludes the video; Undo removes the exclusion and the key it added', () => {
    const before = { id: 'c2', name: 'Archive', videoPaths: [], syncSource: { folderPath: 'c:/Videos' } };
    const folderIndex = new Map([['c:/Videos', [{ path: V }, { path: 'C:\\Videos\\w.mp4' }]]]);
    const store = makeFakeStore({ library: { collections: [before] } });
    const cols = () => store.state.library.collections;
    expect(organiseView({ videoPath: V, collections: cols(), folderIndex, descendantsOf }).collections[0])
      .toMatchObject({ checked: true, synced: true });
    const plan = planCollectionToggle({ collection: cols()[0], videoPath: V, checked: false, folderIndex, descendantsOf });
    runOps(plan.ops, store);
    expect(cols()[0].excludedPaths).toEqual([V]);
    expect(organiseView({ videoPath: V, collections: cols(), folderIndex, descendantsOf }).collections[0].checked).toBe(false);
    runOps(planCollectionUndo(plan, cols()[0]).ops, store);
    expect(JSON.stringify(cols()[0])).toBe(JSON.stringify(before));
  });

  it('tick of a plain library, then Undo', () => {
    const before = { id: 'c1', name: 'Gym' };
    const store = makeFakeStore({ library: { collections: [before] } });
    const cols = () => store.state.library.collections;
    const plan = planCollectionToggle({ collection: cols()[0], videoPath: V, checked: true });
    runOps(plan.ops, store);
    expect(cols()[0].videoPaths).toEqual([V]);
    runOps(planCollectionUndo(plan, cols()[0]).ops, store);
    expect(JSON.stringify(cols()[0])).toBe(JSON.stringify(before));
    expect(planCollectionUndo(plan, null)).toMatchObject({ ok: false, reason: 'gone' });
  });
});

describe('reinsertAt', () => {
  it('is the old order exactly when nothing else changed', () => {
    const before = ['a', 'b', 'c', 'd'];
    for (const item of before) {
      expect(reinsertAt(before, before.filter((x) => x !== item), item)).toEqual(before);
    }
  });

  it('falls back to the old index, clamped, when no neighbour is left', () => {
    expect(reinsertAt(['a', 'b', 'v', 'c'], ['x', 'y', 'z', 'w'], 'v')).toEqual(['x', 'y', 'v', 'z', 'w']);
    expect(reinsertAt(['a', 'b', 'v'], [], 'v')).toEqual(['v']);
    expect(reinsertAt(['a'], ['a'], 'a')).toEqual(['a']);
  });
});
