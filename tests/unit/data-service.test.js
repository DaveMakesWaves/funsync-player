// Unit tests for DataService — cache-first renderer data access
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataService } from '../../renderer/js/data-service.js';

describe('DataService', () => {
  let ds;

  beforeEach(() => {
    // Reset all IPC mocks
    Object.keys(window.funsync).forEach((key) => {
      if (typeof window.funsync[key]?.mockClear === 'function') {
        window.funsync[key].mockClear();
      }
    });
    localStorage.clear();
    ds = new DataService();
  });

  describe('init()', () => {
    it('loads data from main process', async () => {
      await ds.init();
      expect(window.funsync.getAllData).toHaveBeenCalledTimes(1);
      expect(ds.get('player.volume')).toBe(80);
    });

    it('triggers migration when localStorage has legacy data', async () => {
      localStorage.setItem('funsync-settings', JSON.stringify({ player: { volume: 42 } }));
      await ds.init();
      expect(window.funsync.migrateLocalStorage).toHaveBeenCalledTimes(1);
      // localStorage should be cleared after migration
      expect(localStorage.getItem('funsync-settings')).toBeNull();
    });

    it('skips migration when no legacy data', async () => {
      await ds.init();
      expect(window.funsync.migrateLocalStorage).not.toHaveBeenCalled();
    });
  });

  describe('get() / set()', () => {
    beforeEach(async () => {
      await ds.init();
    });

    it('reads default value from cache', () => {
      expect(ds.get('handy.connectionKey')).toBe('');
    });

    it('returns undefined for missing path', () => {
      expect(ds.get('nonexistent.deep.path')).toBeUndefined();
    });

    it('sets value in cache and fires IPC', () => {
      ds.set('player.volume', 50);
      expect(ds.get('player.volume')).toBe(50);
      expect(window.funsync.setSetting).toHaveBeenCalledWith('player.volume', 50);
    });

    it('creates intermediate objects on set', () => {
      ds.set('custom.nested.value', 42);
      expect(ds.get('custom.nested.value')).toBe(42);
    });
  });

  describe('addRecentFile()', () => {
    beforeEach(async () => {
      await ds.init();
    });

    it('adds file to recent list', () => {
      ds.addRecentFile('/video.mp4');
      expect(ds.get('player.recentFiles')).toContain('/video.mp4');
      expect(window.funsync.addRecentFile).toHaveBeenCalledWith('/video.mp4');
    });

    it('deduplicates', () => {
      ds.addRecentFile('/video.mp4');
      ds.addRecentFile('/other.mp4');
      ds.addRecentFile('/video.mp4');
      const recent = ds.get('player.recentFiles');
      expect(recent[0]).toBe('/video.mp4');
      expect(recent.filter((f) => f === '/video.mp4').length).toBe(1);
    });

    it('caps at 20', () => {
      for (let i = 0; i < 25; i++) {
        ds.addRecentFile(`/video${i}.mp4`);
      }
      expect(ds.get('player.recentFiles').length).toBe(20);
    });
  });

  describe('playlists', () => {
    beforeEach(async () => {
      await ds.init();
    });

    it('starts with empty playlists', () => {
      expect(ds.getPlaylists()).toEqual([]);
    });

    it('addPlaylist is async and returns from IPC', async () => {
      const pl = await ds.addPlaylist('My Playlist');
      expect(pl.name).toBe('My Playlist');
      expect(pl.id).toBeTruthy();
      expect(window.funsync.addPlaylist).toHaveBeenCalledWith('My Playlist');
      // Cache should be updated
      expect(ds.getPlaylists().length).toBe(1);
    });

    it('getPlaylist returns by id', async () => {
      const pl = await ds.addPlaylist('Test');
      expect(ds.getPlaylist(pl.id)).toBeTruthy();
      expect(ds.getPlaylist(pl.id).name).toBe('Test');
    });

    it('returns null for missing playlist', () => {
      expect(ds.getPlaylist('nonexistent')).toBeNull();
    });

    it('deletes a playlist', async () => {
      const pl = await ds.addPlaylist('To Delete');
      ds.deletePlaylist(pl.id);
      expect(ds.getPlaylists().length).toBe(0);
      expect(window.funsync.deletePlaylist).toHaveBeenCalledWith(pl.id);
    });

    it('renames a playlist', async () => {
      const pl = await ds.addPlaylist('Original');
      ds.renamePlaylist(pl.id, 'Renamed');
      expect(ds.getPlaylist(pl.id).name).toBe('Renamed');
      expect(window.funsync.renamePlaylist).toHaveBeenCalledWith(pl.id, 'Renamed');
    });

    it('adds video to playlist (dedup)', async () => {
      const pl = await ds.addPlaylist('Test');
      ds.addVideoToPlaylist(pl.id, '/video.mp4');
      ds.addVideoToPlaylist(pl.id, '/video.mp4');
      expect(ds.getPlaylist(pl.id).videoPaths).toEqual(['/video.mp4']);
      expect(window.funsync.addVideoToPlaylist).toHaveBeenCalledWith(pl.id, '/video.mp4');
    });

    it('removes video from playlist', async () => {
      const pl = await ds.addPlaylist('Test');
      ds.addVideoToPlaylist(pl.id, '/a.mp4');
      ds.addVideoToPlaylist(pl.id, '/b.mp4');
      ds.removeVideoFromPlaylist(pl.id, '/a.mp4');
      expect(ds.getPlaylist(pl.id).videoPaths).toEqual(['/b.mp4']);
    });
  });

  describe('categories', () => {
    beforeEach(async () => {
      await ds.init();
    });

    it('starts with empty categories', () => {
      expect(ds.getCategories()).toEqual([]);
    });

    it('addCategory is async and returns from IPC', async () => {
      const cat = await ds.addCategory('Action', '#ff0000');
      expect(cat.name).toBe('Action');
      expect(cat.color).toBe('#ff0000');
      expect(cat.id).toBeTruthy();
      expect(ds.getCategories().length).toBe(1);
    });

    it('deletes category and cleans up mappings', async () => {
      const cat = await ds.addCategory('Test', '#000');
      ds.assignCategory('/video.mp4', cat.id);
      ds.deleteCategory(cat.id);
      expect(ds.getCategories().length).toBe(0);
      expect(ds.getVideoCategories('/video.mp4')).toEqual([]);
    });

    it('renames category', async () => {
      const cat = await ds.addCategory('Old', '#000');
      ds.renameCategory(cat.id, 'New');
      expect(ds.getCategories().find((c) => c.id === cat.id).name).toBe('New');
    });
  });

  describe('category mappings', () => {
    let catId;

    beforeEach(async () => {
      await ds.init();
      const cat = await ds.addCategory('Genre', '#00ff00');
      catId = cat.id;
    });

    it('assigns category to video', () => {
      ds.assignCategory('/video.mp4', catId);
      expect(ds.getVideoCategories('/video.mp4')).toContain(catId);
    });

    it('does not duplicate assignment', () => {
      ds.assignCategory('/video.mp4', catId);
      ds.assignCategory('/video.mp4', catId);
      expect(ds.getVideoCategories('/video.mp4').length).toBe(1);
    });

    it('unassigns category', () => {
      ds.assignCategory('/video.mp4', catId);
      ds.unassignCategory('/video.mp4', catId);
      expect(ds.getVideoCategories('/video.mp4')).toEqual([]);
    });

    it('returns empty for unknown video', () => {
      expect(ds.getVideoCategories('/unknown.mp4')).toEqual([]);
    });

    it('gets videos by category', () => {
      ds.assignCategory('/v1.mp4', catId);
      ds.assignCategory('/v2.mp4', catId);
      const paths = ds.getVideosByCategory(catId);
      expect(paths).toContain('/v1.mp4');
      expect(paths).toContain('/v2.mp4');
    });

    it('supports multiple categories per video', async () => {
      const cat2 = await ds.addCategory('Action', '#ff0000');
      ds.assignCategory('/video.mp4', catId);
      ds.assignCategory('/video.mp4', cat2.id);
      expect(ds.getVideoCategories('/video.mp4').length).toBe(2);
    });
  });
});
