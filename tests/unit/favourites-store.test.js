/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Main's half of Favourites and following playlists (zaikechi #381,
// 2026-11-23): electron/store.js ensureFavouritesPlaylist (a fixed id, made
// once, never deleted), setPlaylistFollow (only the three rule shapes) and
// setPlaylistExcluded; and a backup's Favourites joining this machine's on a
// merge import (electron/data-export.js mergeConfig), never skipped.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

class MockConf {
  constructor({ defaults }) { this._data = JSON.parse(JSON.stringify(defaults)); }
  get(path) {
    let v = this._data;
    for (const k of path.split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
    return v !== undefined ? JSON.parse(JSON.stringify(v)) : undefined;
  }
  set(path, value) {
    const keys = path.split('.');
    let o = this._data;
    for (let i = 0; i < keys.length - 1; i++) { if (typeof o[keys[i]] !== 'object' || o[keys[i]] == null) o[keys[i]] = {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = JSON.parse(JSON.stringify(value));
  }
}
vi.mock('electron-conf', () => ({ default: MockConf }));

const store = await import('../../electron/store.js');
const { mergeConfig } = createRequire(import.meta.url)('../../electron/data-export.js');

beforeEach(async () => { await store.initStore(); });

describe('the Favourites playlist (main)', () => {
  it('is made once, with the fixed id, first in the list, in the name given', () => {
    store.addPlaylist('Mine');
    const a = store.ensureFavouritesPlaylist('Favoriten');
    const b = store.ensureFavouritesPlaylist('Something else');
    expect(a).toMatchObject({ id: 'favourites', name: 'Favoriten', system: 'favourites', videoPaths: [] });
    expect(b.name).toBe('Favoriten');
    expect(store.getPlaylists().map((p) => p.id)).toEqual(['favourites', expect.any(String)]);
    expect(store.getPlaylists().filter((p) => p.id === 'favourites')).toHaveLength(1);
  });

  it('is never deleted (it IS the favourites); other playlists still are', () => {
    store.ensureFavouritesPlaylist('Favourites');
    store.addVideoToPlaylist('favourites', 'C:\\v\\a.mp4');
    const other = store.addPlaylist('Other');
    store.deletePlaylist('favourites');
    store.deletePlaylist(other.id);
    expect(store.getPlaylists().map((p) => p.id)).toEqual(['favourites']);
    expect(store.getPlaylist('favourites').videoPaths).toEqual(['C:\\v\\a.mp4']);
  });

  it('a blank name gets "Favourites"', () => {
    expect(store.ensureFavouritesPlaylist('   ').name).toBe('Favourites');
  });

  it('follows the language while it has a built-in name (B008: a first launch makes it before the language is chosen)', () => {
    // Test day 2026-11-24: German chosen at first launch, the playlist stayed "Favourites".
    store.ensureFavouritesPlaylist('Favourites');
    store.addVideoToPlaylist('favourites', 'C:\\v\\a.mp4');
    expect(store.ensureFavouritesPlaylist('Favoriten').name).toBe('Favoriten');
    expect(store.ensureFavouritesPlaylist('お気に入り').name).toBe('お気に入り');
    expect(store.getPlaylist('favourites')).toMatchObject({ name: 'お気に入り', videoPaths: ['C:\\v\\a.mp4'] });
  });

  it('a name the user gave it is kept, whatever the language', () => {
    store.ensureFavouritesPlaylist('Favourites');
    store.renamePlaylist('favourites', 'My loves');
    expect(store.ensureFavouritesPlaylist('Favoriten').name).toBe('My loves');
  });
});

describe('following playlists (main)', () => {
  it('keeps only the three rule shapes; null stops following and drops the exclusions', () => {
    const pl = store.addPlaylist('Follows');
    expect(store.setPlaylistFollow(pl.id, { kind: 'category', categoryId: 'c1', extra: 'x' })).toEqual({ kind: 'category', categoryId: 'c1' });
    expect(store.setPlaylistFollow(pl.id, { kind: 'folder', folderPath: ' C:\\Lib\\Sub ' })).toEqual({ kind: 'folder', folderPath: 'C:\\Lib\\Sub' });
    store.setPlaylistExcluded(pl.id, ['C:\\x.mp4', 'C:\\x.mp4', 7]);
    expect(store.getPlaylist(pl.id).excludedPaths).toEqual(['C:\\x.mp4']);
    expect(store.setPlaylistFollow(pl.id, { kind: 'url', url: 'http://x' })).toBeNull();
    const after = store.getPlaylist(pl.id);
    expect(after.follow).toBeUndefined();
    expect(after.excludedPaths).toBeUndefined();
  });

  it('Favourites never follows anything; an unknown playlist answers undefined', () => {
    store.ensureFavouritesPlaylist('Favourites');
    expect(store.setPlaylistFollow('favourites', { kind: 'category', categoryId: 'c1' })).toBeUndefined();
    expect(store.setPlaylistFollow('nope', { kind: 'category', categoryId: 'c1' })).toBeUndefined();
  });
});

describe('a merge import of a backup', () => {
  it("adds the backup's favourites to this machine's (a union, in order), never a second Favourites", () => {
    const existing = { settings: {}, playlists: [{ id: 'favourites', name: 'Favourites', videoPaths: ['A', 'B'] }], categories: [], videoCategories: {} };
    const imported = { settings: {}, playlists: [{ id: 'favourites', name: 'Favoris', videoPaths: ['B', 'C'] }, { id: 'p2', name: 'Other', videoPaths: ['D'] }] };
    const out = mergeConfig(existing, imported, 'merge');
    expect(out.playlists.filter((p) => p.id === 'favourites')).toEqual([{ id: 'favourites', name: 'Favourites', videoPaths: ['A', 'B', 'C'] }]);
    expect(out.playlists.map((p) => p.id)).toEqual(['favourites', 'p2']);
  });

  it('a backup with Favourites onto a machine without one brings it as it is', () => {
    const out = mergeConfig({ settings: {}, playlists: [], categories: [], videoCategories: {} },
      { settings: {}, playlists: [{ id: 'favourites', name: 'Favourites', videoPaths: ['A'] }] }, 'merge');
    expect(out.playlists).toEqual([{ id: 'favourites', name: 'Favourites', videoPaths: ['A'] }]);
  });
});
