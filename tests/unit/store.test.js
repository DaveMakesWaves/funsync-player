// Unit tests for electron/store.js — main process data store
// We mock electron-conf with an in-memory Map-based implementation
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory Conf mock
class MockConf {
  constructor({ defaults }) {
    this._data = JSON.parse(JSON.stringify(defaults));
  }

  get(path) {
    const keys = path.split('.');
    let value = this._data;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return undefined;
      value = value[key];
    }
    // Return a deep clone to mimic file-based store behavior
    return value !== undefined ? JSON.parse(JSON.stringify(value)) : undefined;
  }

  set(path, value) {
    const keys = path.split('.');
    let obj = this._data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in obj) || typeof obj[keys[i]] !== 'object') {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = JSON.parse(JSON.stringify(value));
  }
}

// We need to mock the dynamic import of electron-conf before importing store
vi.mock('electron-conf', () => ({
  default: MockConf,
}));

// No crypto mock needed — we just check IDs are truthy strings

// Import store after mocks
const store = await import('../../electron/store.js');

describe('store', () => {
  beforeEach(async () => {
    // Re-init the store to get a fresh conf instance
    await store.initStore();
  });

  describe('getSetting / setSetting', () => {
    it('gets default value', () => {
      expect(store.getSetting('player.volume')).toBe(80);
    });

    it('sets and gets a value', () => {
      store.setSetting('player.volume', 50);
      expect(store.getSetting('player.volume')).toBe(50);
    });

    it('returns undefined for missing key', () => {
      expect(store.getSetting('nonexistent.path')).toBeUndefined();
    });
  });

  describe('getAll()', () => {
    it('returns deep clone of all data', () => {
      const data = store.getAll();
      expect(data.settings).toBeDefined();
      expect(data.playlists).toEqual([]);
      expect(data.categories).toEqual([]);
      expect(data.videoCategories).toEqual({});

      // Verify it's a deep clone (mutating returned data doesn't affect store)
      data.playlists.push({ id: 'fake' });
      expect(store.getPlaylists()).toEqual([]);
    });
  });

  describe('addRecentFile', () => {
    it('adds a file and deduplicates', () => {
      store.addRecentFile('/a.mp4');
      store.addRecentFile('/b.mp4');
      store.addRecentFile('/a.mp4'); // dedup — moves to front
      const recent = store.getSetting('player.recentFiles');
      expect(recent[0]).toBe('/a.mp4');
      expect(recent.length).toBe(2);
    });

    it('caps at 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        store.addRecentFile(`/video${i}.mp4`);
      }
      expect(store.getSetting('player.recentFiles').length).toBe(20);
    });
  });

  describe('playlists', () => {
    it('addPlaylist returns playlist with UUID', () => {
      const pl = store.addPlaylist('Test');
      expect(typeof pl.id).toBe('string');
      expect(pl.id.length).toBeGreaterThan(0);
      expect(pl.name).toBe('Test');
      expect(pl.videoPaths).toEqual([]);
      expect(store.getPlaylists().length).toBe(1);
    });

    it('getPlaylist finds by id', () => {
      const pl = store.addPlaylist('Test');
      expect(store.getPlaylist(pl.id).name).toBe('Test');
    });

    it('getPlaylist returns null for missing id', () => {
      expect(store.getPlaylist('nonexistent')).toBeNull();
    });

    it('deletePlaylist removes it', () => {
      const pl = store.addPlaylist('Del');
      store.deletePlaylist(pl.id);
      expect(store.getPlaylists().length).toBe(0);
    });

    it('renamePlaylist changes name', () => {
      const pl = store.addPlaylist('Old');
      store.renamePlaylist(pl.id, 'New');
      expect(store.getPlaylist(pl.id).name).toBe('New');
    });

    it('addVideoToPlaylist deduplicates', () => {
      const pl = store.addPlaylist('Test');
      store.addVideoToPlaylist(pl.id, '/v.mp4');
      store.addVideoToPlaylist(pl.id, '/v.mp4');
      expect(store.getPlaylist(pl.id).videoPaths.length).toBe(1);
    });

    it('removeVideoFromPlaylist works', () => {
      const pl = store.addPlaylist('Test');
      store.addVideoToPlaylist(pl.id, '/a.mp4');
      store.addVideoToPlaylist(pl.id, '/b.mp4');
      store.removeVideoFromPlaylist(pl.id, '/a.mp4');
      expect(store.getPlaylist(pl.id).videoPaths).toEqual(['/b.mp4']);
    });
  });

  describe('categories', () => {
    it('addCategory returns category with UUID', () => {
      const cat = store.addCategory('Action', '#ff0000');
      expect(typeof cat.id).toBe('string');
      expect(cat.id.length).toBeGreaterThan(0);
      expect(cat.name).toBe('Action');
      expect(cat.color).toBe('#ff0000');
    });

    it('deleteCategory cascades videoCategories cleanup', () => {
      const cat = store.addCategory('Test', '#000');
      store.assignCategory('/v.mp4', cat.id);
      store.deleteCategory(cat.id);
      expect(store.getCategories().length).toBe(0);
      expect(store.getVideoCategories('/v.mp4')).toEqual([]);
    });

    it('renameCategory changes name', () => {
      const cat = store.addCategory('Old', '#000');
      store.renameCategory(cat.id, 'New');
      expect(store.getCategories().find((c) => c.id === cat.id).name).toBe('New');
    });
  });

  describe('category mappings', () => {
    it('assignCategory and getVideoCategories', () => {
      const cat = store.addCategory('G', '#0f0');
      store.assignCategory('/v.mp4', cat.id);
      expect(store.getVideoCategories('/v.mp4')).toContain(cat.id);
    });

    it('assignCategory deduplicates', () => {
      const cat = store.addCategory('G', '#0f0');
      store.assignCategory('/v.mp4', cat.id);
      store.assignCategory('/v.mp4', cat.id);
      expect(store.getVideoCategories('/v.mp4').length).toBe(1);
    });

    it('unassignCategory removes and cleans empty', () => {
      const cat = store.addCategory('G', '#0f0');
      store.assignCategory('/v.mp4', cat.id);
      store.unassignCategory('/v.mp4', cat.id);
      expect(store.getVideoCategories('/v.mp4')).toEqual([]);
    });

    it('getVideosByCategory returns matching paths', () => {
      const cat = store.addCategory('G', '#0f0');
      store.assignCategory('/a.mp4', cat.id);
      store.assignCategory('/b.mp4', cat.id);
      const paths = store.getVideosByCategory(cat.id);
      expect(paths).toContain('/a.mp4');
      expect(paths).toContain('/b.mp4');
    });
  });

  describe('migration', () => {
    it('isMigrated returns false initially', () => {
      expect(store.isMigrated()).toBe(false);
    });

    it('migrateFromLegacy sets data and marks migrated', () => {
      store.migrateFromLegacy({
        handy: { connectionKey: 'test123' },
        player: { volume: 42 },
        playlists: [{ id: 'p1', name: 'My List', createdAt: 1000, videoPaths: ['/v.mp4'] }],
        categories: [{ id: 'c1', name: 'Action', color: '#ff0000' }],
        videoCategories: { '/v.mp4': ['c1'] },
      });

      expect(store.isMigrated()).toBe(true);
      expect(store.getSetting('handy.connectionKey')).toBe('test123');
      expect(store.getSetting('player.volume')).toBe(42);
      expect(store.getPlaylists()).toHaveLength(1);
      expect(store.getPlaylists()[0].name).toBe('My List');
      expect(store.getCategories()).toHaveLength(1);
      expect(store.getVideoCategories('/v.mp4')).toEqual(['c1']);
    });

    it('migrateFromLegacy handles null data', () => {
      store.migrateFromLegacy(null);
      // Should not throw, should not corrupt
      expect(store.getPlaylists()).toEqual([]);
    });
  });
});
