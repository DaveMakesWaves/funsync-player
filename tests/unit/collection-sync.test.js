// Tests for the Sync-with-Source collection helpers. These are pure
// functions — no DOM, no settings — so they're cheap to exhaustively
// cover, which matters because the membership semantics gate what
// users see in every synced collection.

import { describe, it, expect } from 'vitest';
import {
  resolveSyncFolder,
  isSynced,
  expandSyncedMembership,
  freezeSyncedCollection,
  convertSourceIdToFolderPath,
  addVideoToCollection,
  removeVideoFromCollection,
} from '../../renderer/js/collection-sync.js';

// Minimal fake folderIndex + descendantsOf — the helpers accept
// descendantsOf as a function, so we can mock it without the real
// folder-index module.
const makeIndex = (treeByFolder) => ({
  get: (key) => treeByFolder[key] ? { videos: treeByFolder[key].map(p => ({ path: p })) } : null,
});
const mockDescendants = (index, folder) => {
  const node = index?.get?.(folder);
  return node?.videos || [];
};

const unsynced = { id: 'A', name: 'Plain', videoPaths: ['/a.mp4', '/b.mp4'] };
const syncedById = {
  id: 'B',
  name: 'Synced-by-id',
  videoPaths: [],
  syncSource: { sourceId: 'src-1' },
};
const syncedByPath = {
  id: 'C',
  name: 'Synced-by-path',
  videoPaths: [],
  syncSource: { folderPath: '/videos/creatorX' },
};

describe('isSynced', () => {
  it('returns false for legacy collections', () => {
    expect(isSynced(unsynced)).toBe(false);
    expect(isSynced({})).toBe(false);
    expect(isSynced(null)).toBe(false);
  });

  it('returns true when syncSource has a sourceId or folderPath', () => {
    expect(isSynced(syncedById)).toBe(true);
    expect(isSynced(syncedByPath)).toBe(true);
  });

  it('returns false when syncSource is an empty object', () => {
    expect(isSynced({ syncSource: {} })).toBe(false);
  });
});

describe('resolveSyncFolder', () => {
  const sources = [
    { id: 'src-1', path: '/videos/real' },
    { id: 'src-2', path: '/videos/animation' },
  ];

  it('returns null for legacy collections', () => {
    expect(resolveSyncFolder(unsynced, sources)).toBeNull();
  });

  it('resolves sourceId to the source\'s path', () => {
    // canonicalPath lowercases + forward-slashes; accept exact match
    expect(resolveSyncFolder(syncedById, sources)).toBe('/videos/real');
  });

  it('returns null when sourceId references a deleted source', () => {
    expect(resolveSyncFolder(syncedById, [])).toBeNull();
  });

  it('returns the folderPath directly when set', () => {
    expect(resolveSyncFolder(syncedByPath, sources)).toBe('/videos/creatorX');
  });

  it('normalises Windows-style paths (canonicalPath)', () => {
    const col = { syncSource: { folderPath: 'C:\\Videos\\Pack' } };
    expect(resolveSyncFolder(col, [])).toBe('c:/Videos/Pack');
  });
});

describe('expandSyncedMembership', () => {
  const sources = [{ id: 'src-1', path: '/videos/real' }];
  const index = makeIndex({
    '/videos/real': ['/videos/real/a.mp4', '/videos/real/b.mp4', '/videos/real/c.mp4'],
  });

  it('returns frozen videoPaths for unsynced collections', () => {
    const members = expandSyncedMembership(unsynced, sources, index, mockDescendants);
    expect([...members].sort()).toEqual(['/a.mp4', '/b.mp4']);
  });

  it('returns all descendants for synced collection with no excludes', () => {
    const members = expandSyncedMembership(syncedById, sources, index, mockDescendants);
    expect(members.size).toBe(3);
    expect(members.has('/videos/real/a.mp4')).toBe(true);
  });

  it('subtracts excludedPaths from auto-members', () => {
    const col = { ...syncedById, excludedPaths: ['/videos/real/b.mp4'] };
    const members = expandSyncedMembership(col, sources, index, mockDescendants);
    expect(members.has('/videos/real/b.mp4')).toBe(false);
    expect(members.size).toBe(2);
  });

  it('adds videoPaths additive-include list on top of auto-members', () => {
    const col = { ...syncedById, videoPaths: ['/other/bonus.mp4'] };
    const members = expandSyncedMembership(col, sources, index, mockDescendants);
    expect(members.has('/other/bonus.mp4')).toBe(true);
    expect(members.size).toBe(4);
  });

  it('re-includes an excluded video if it\'s also in the additive list', () => {
    // Edge case: user excluded a video, then explicitly added it back.
    // Additive-include takes priority.
    const col = {
      ...syncedById,
      excludedPaths: ['/videos/real/b.mp4'],
      videoPaths: ['/videos/real/b.mp4'],
    };
    const members = expandSyncedMembership(col, sources, index, mockDescendants);
    expect(members.has('/videos/real/b.mp4')).toBe(true);
  });

  it('falls back to additive list when sync source is unresolvable', () => {
    // sourceId references a deleted source — auto-members are empty but
    // manually added videos still show.
    const col = { ...syncedById, videoPaths: ['/other/bonus.mp4'] };
    const members = expandSyncedMembership(col, [], index, mockDescendants);
    expect(members.size).toBe(1);
    expect(members.has('/other/bonus.mp4')).toBe(true);
  });

  it('returns empty set when folder exists but has no videos', () => {
    const emptyIndex = makeIndex({ '/videos/real': [] });
    const members = expandSyncedMembership(syncedById, sources, emptyIndex, mockDescendants);
    expect(members.size).toBe(0);
  });
});

describe('freezeSyncedCollection', () => {
  const sources = [{ id: 'src-1', path: '/videos/real' }];
  const index = makeIndex({
    '/videos/real': ['/videos/real/a.mp4', '/videos/real/b.mp4'],
  });

  it('writes current membership to videoPaths and clears syncSource', () => {
    const col = {
      ...syncedById,
      excludedPaths: ['/videos/real/b.mp4'],
      videoPaths: ['/other/bonus.mp4'],
    };
    const frozen = freezeSyncedCollection(col, sources, index, mockDescendants);
    expect(frozen.syncSource).toBeUndefined();
    expect(frozen.excludedPaths).toBeUndefined();
    expect(new Set(frozen.videoPaths)).toEqual(new Set(['/videos/real/a.mp4', '/other/bonus.mp4']));
  });

  it('returns a new object — no mutation of input', () => {
    const col = { ...syncedById, excludedPaths: ['/videos/real/a.mp4'] };
    const frozen = freezeSyncedCollection(col, sources, index, mockDescendants);
    expect(col.syncSource).toBeDefined(); // original unchanged
    expect(frozen).not.toBe(col);
  });

  it('is a no-op shape for already-unsynced collections', () => {
    const frozen = freezeSyncedCollection(unsynced, sources, index, mockDescendants);
    expect(new Set(frozen.videoPaths)).toEqual(new Set(unsynced.videoPaths));
    expect(frozen.syncSource).toBeUndefined();
  });
});

describe('convertSourceIdToFolderPath', () => {
  it('converts sourceId to folderPath using the snapshotted path', () => {
    const converted = convertSourceIdToFolderPath(syncedById, '/videos/real');
    expect(converted.syncSource.sourceId).toBeUndefined();
    expect(converted.syncSource.folderPath).toBe('/videos/real');
  });

  it('leaves non-sourceId collections untouched', () => {
    expect(convertSourceIdToFolderPath(syncedByPath, '/videos/real')).toBe(syncedByPath);
    expect(convertSourceIdToFolderPath(unsynced, '/videos/real')).toBe(unsynced);
  });

  it('normalises the snapshotted path', () => {
    const converted = convertSourceIdToFolderPath(syncedById, 'C:\\Videos\\Real');
    expect(converted.syncSource.folderPath).toBe('c:/Videos/Real');
  });
});

describe('addVideoToCollection', () => {
  const sources = [{ id: 'src-1', path: '/videos/real' }];
  const index = makeIndex({
    '/videos/real': ['/videos/real/a.mp4', '/videos/real/b.mp4'],
  });

  it('appends to videoPaths for unsynced collections', () => {
    const { changed, col } = addVideoToCollection(unsynced, '/c.mp4', sources, index, mockDescendants);
    expect(changed).toBe(true);
    expect(col.videoPaths).toContain('/c.mp4');
  });

  it('is idempotent for already-present videos', () => {
    const { changed } = addVideoToCollection(unsynced, '/a.mp4', sources, index, mockDescendants);
    expect(changed).toBe(false);
  });

  it('for synced: un-excludes if the video was previously excluded', () => {
    const col = { ...syncedById, excludedPaths: ['/videos/real/b.mp4'] };
    const { changed, col: next } = addVideoToCollection(col, '/videos/real/b.mp4', sources, index, mockDescendants);
    expect(changed).toBe(true);
    expect(next.excludedPaths).toEqual([]);
  });

  it('for synced: no-op when video is already in auto-membership', () => {
    const { changed } = addVideoToCollection(syncedById, '/videos/real/a.mp4', sources, index, mockDescendants);
    expect(changed).toBe(false);
  });

  it('for synced: appends to videoPaths when video is outside sync scope', () => {
    const { changed, col } = addVideoToCollection(syncedById, '/other/bonus.mp4', sources, index, mockDescendants);
    expect(changed).toBe(true);
    expect(col.videoPaths).toContain('/other/bonus.mp4');
  });
});

describe('removeVideoFromCollection', () => {
  const sources = [{ id: 'src-1', path: '/videos/real' }];
  const index = makeIndex({
    '/videos/real': ['/videos/real/a.mp4', '/videos/real/b.mp4'],
  });

  it('removes from videoPaths for unsynced collections', () => {
    const { changed, col } = removeVideoFromCollection(unsynced, '/a.mp4', sources, index, mockDescendants);
    expect(changed).toBe(true);
    expect(col.videoPaths).not.toContain('/a.mp4');
  });

  it('for synced: adds to excludedPaths when video is in auto-membership', () => {
    const { changed, col } = removeVideoFromCollection(syncedById, '/videos/real/a.mp4', sources, index, mockDescendants);
    expect(changed).toBe(true);
    expect(col.excludedPaths).toContain('/videos/real/a.mp4');
  });

  it('for synced: removes from additive include list when video was manually added', () => {
    const col = { ...syncedById, videoPaths: ['/other/bonus.mp4'] };
    const { changed, col: next } = removeVideoFromCollection(col, '/other/bonus.mp4', sources, index, mockDescendants);
    expect(changed).toBe(true);
    expect(next.videoPaths).not.toContain('/other/bonus.mp4');
  });

  it('for synced: no-op when video is not in scope and not in include list', () => {
    const { changed } = removeVideoFromCollection(syncedById, '/random/nowhere.mp4', sources, index, mockDescendants);
    expect(changed).toBe(false);
  });
});
