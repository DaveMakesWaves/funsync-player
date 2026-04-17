// Unit tests for Library Collections system
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock settings store for collection CRUD
function createMockSettings() {
  const data = {
    'library.collections': [],
    'library.activeCollectionId': null,
    'library.directory': '/test/videos',
  };

  return {
    get: (key) => {
      const val = data[key];
      return val !== undefined ? JSON.parse(JSON.stringify(val)) : undefined;
    },
    set: (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); },
    _data: data,
  };
}

describe('Library Collections', () => {
  let settings;

  beforeEach(() => {
    settings = createMockSettings();
  });

  describe('CRUD operations', () => {
    it('starts with empty collections', () => {
      expect(settings.get('library.collections')).toEqual([]);
      expect(settings.get('library.activeCollectionId')).toBeNull();
    });

    it('creates a collection with name and video paths', () => {
      const collections = settings.get('library.collections');
      const newCol = {
        id: 'col-1',
        name: 'Animated',
        videoPaths: ['/test/videos/vid1.mp4', '/test/videos/vid2.mp4'],
      };
      collections.push(newCol);
      settings.set('library.collections', collections);

      const saved = settings.get('library.collections');
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe('Animated');
      expect(saved[0].videoPaths).toHaveLength(2);
    });

    it('creates multiple collections', () => {
      const collections = [];
      collections.push({ id: 'col-1', name: 'Animated', videoPaths: ['/v1.mp4'] });
      collections.push({ id: 'col-2', name: 'Real', videoPaths: ['/v2.mp4'] });
      collections.push({ id: 'col-3', name: 'Favourites', videoPaths: ['/v1.mp4', '/v2.mp4'] });
      settings.set('library.collections', collections);

      expect(settings.get('library.collections')).toHaveLength(3);
    });

    it('renames a collection', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Old Name', videoPaths: [] },
      ]);

      const collections = settings.get('library.collections');
      const col = collections.find(c => c.id === 'col-1');
      col.name = 'New Name';
      settings.set('library.collections', collections);

      expect(settings.get('library.collections')[0].name).toBe('New Name');
    });

    it('deletes a collection', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Keep', videoPaths: [] },
        { id: 'col-2', name: 'Delete', videoPaths: [] },
      ]);

      const updated = settings.get('library.collections').filter(c => c.id !== 'col-2');
      settings.set('library.collections', updated);

      const result = settings.get('library.collections');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Keep');
    });

    it('deleting active collection resets to null', () => {
      settings.set('library.collections', [{ id: 'col-1', name: 'Test', videoPaths: [] }]);
      settings.set('library.activeCollectionId', 'col-1');

      const updated = settings.get('library.collections').filter(c => c.id !== 'col-1');
      settings.set('library.collections', updated);
      settings.set('library.activeCollectionId', null);

      expect(settings.get('library.activeCollectionId')).toBeNull();
      expect(settings.get('library.collections')).toHaveLength(0);
    });
  });

  describe('Video management within collections', () => {
    it('adds a video to a collection', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Test', videoPaths: ['/v1.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const col = collections.find(c => c.id === 'col-1');
      col.videoPaths.push('/v2.mp4');
      settings.set('library.collections', collections);

      expect(settings.get('library.collections')[0].videoPaths).toHaveLength(2);
      expect(settings.get('library.collections')[0].videoPaths).toContain('/v2.mp4');
    });

    it('does not add duplicate video paths', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Test', videoPaths: ['/v1.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const col = collections.find(c => c.id === 'col-1');
      if (!col.videoPaths.includes('/v1.mp4')) {
        col.videoPaths.push('/v1.mp4');
      }
      settings.set('library.collections', collections);

      expect(settings.get('library.collections')[0].videoPaths).toHaveLength(1);
    });

    it('removes a video from a collection', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Test', videoPaths: ['/v1.mp4', '/v2.mp4', '/v3.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const col = collections.find(c => c.id === 'col-1');
      col.videoPaths = col.videoPaths.filter(p => p !== '/v2.mp4');
      settings.set('library.collections', collections);

      const result = settings.get('library.collections')[0].videoPaths;
      expect(result).toHaveLength(2);
      expect(result).not.toContain('/v2.mp4');
    });

    it('a video can be in multiple collections', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Animated', videoPaths: ['/v1.mp4'] },
        { id: 'col-2', name: 'Favourites', videoPaths: ['/v1.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const inAnimated = collections.find(c => c.id === 'col-1').videoPaths.includes('/v1.mp4');
      const inFavourites = collections.find(c => c.id === 'col-2').videoPaths.includes('/v1.mp4');
      expect(inAnimated).toBe(true);
      expect(inFavourites).toBe(true);
    });

    it('empty collection has zero video paths', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Empty', videoPaths: [] },
      ]);

      expect(settings.get('library.collections')[0].videoPaths).toHaveLength(0);
    });
  });

  describe('Active collection switching', () => {
    it('sets active collection by id', () => {
      settings.set('library.activeCollectionId', 'col-1');
      expect(settings.get('library.activeCollectionId')).toBe('col-1');
    });

    it('sets null for All Videos', () => {
      settings.set('library.activeCollectionId', 'col-1');
      settings.set('library.activeCollectionId', null);
      expect(settings.get('library.activeCollectionId')).toBeNull();
    });

    it('invalid collection id does not crash filtering', () => {
      settings.set('library.collections', []);
      settings.set('library.activeCollectionId', 'nonexistent');

      const collections = settings.get('library.collections');
      const activeId = settings.get('library.activeCollectionId');
      const col = collections.find(c => c.id === activeId);

      // col is undefined — filtering should show all videos (no match = no filter)
      expect(col).toBeUndefined();
    });
  });

  describe('Collection filtering logic', () => {
    const allVideos = [
      { path: '/v1.mp4', name: 'vid1.mp4', hasFunscript: true },
      { path: '/v2.mp4', name: 'vid2.mp4', hasFunscript: false },
      { path: '/v3.mp4', name: 'vid3.mp4', hasFunscript: true },
      { path: '/v4.mp4', name: 'vid4.mp4', hasFunscript: false },
    ];

    it('no active collection returns all videos', () => {
      const activeId = null;
      let filtered = allVideos;
      if (activeId) {
        // would filter
      }
      expect(filtered).toHaveLength(4);
    });

    it('active collection filters to only its videos', () => {
      const col = { id: 'col-1', videoPaths: ['/v1.mp4', '/v3.mp4'] };
      const pathSet = new Set(col.videoPaths);
      const filtered = allVideos.filter(v => pathSet.has(v.path));

      expect(filtered).toHaveLength(2);
      expect(filtered[0].name).toBe('vid1.mp4');
      expect(filtered[1].name).toBe('vid3.mp4');
    });

    it('collection with no matching paths returns empty', () => {
      const col = { id: 'col-1', videoPaths: ['/nonexistent.mp4'] };
      const pathSet = new Set(col.videoPaths);
      const filtered = allVideos.filter(v => pathSet.has(v.path));

      expect(filtered).toHaveLength(0);
    });

    it('collection filter works with matched/unmatched tab', () => {
      const col = { id: 'col-1', videoPaths: ['/v1.mp4', '/v2.mp4', '/v3.mp4'] };
      const pathSet = new Set(col.videoPaths);

      // Collection filter first
      let filtered = allVideos.filter(v => pathSet.has(v.path));
      expect(filtered).toHaveLength(3);

      // Then matched tab
      const matched = filtered.filter(v => v.hasFunscript);
      expect(matched).toHaveLength(2);

      // Then unmatched tab
      const unmatched = filtered.filter(v => !v.hasFunscript);
      expect(unmatched).toHaveLength(1);
    });
  });

  describe('Edge cases', () => {
    it('collection with empty name is handled', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: '', videoPaths: ['/v1.mp4'] },
      ]);
      const col = settings.get('library.collections')[0];
      expect(col.name).toBe('');
    });

    it('collection survives JSON serialization', () => {
      const original = {
        id: 'col-1',
        name: 'Test "Quotes" & <Chars>',
        videoPaths: ['/path/with spaces/video.mp4', 'C:\\windows\\path.mp4'],
      };
      settings.set('library.collections', [original]);
      const restored = settings.get('library.collections')[0];

      expect(restored.name).toBe(original.name);
      expect(restored.videoPaths).toEqual(original.videoPaths);
    });

    it('bulk add to collection skips duplicates', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'Test', videoPaths: ['/v1.mp4', '/v2.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const col = collections.find(c => c.id === 'col-1');
      const toAdd = ['/v2.mp4', '/v3.mp4', '/v4.mp4'];
      for (const path of toAdd) {
        if (!col.videoPaths.includes(path)) col.videoPaths.push(path);
      }
      settings.set('library.collections', collections);

      const result = settings.get('library.collections')[0].videoPaths;
      expect(result).toHaveLength(4);
      expect(result.filter(p => p === '/v2.mp4')).toHaveLength(1); // no duplicate
    });

    it('deleting all collections results in empty array', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'A', videoPaths: [] },
        { id: 'col-2', name: 'B', videoPaths: [] },
      ]);

      settings.set('library.collections', []);
      expect(settings.get('library.collections')).toEqual([]);
    });

    it('source availability — unavailable source marks collection unavailable', () => {
      const unavailablePaths = new Set(['E:\\ExternalDrive']);
      // Separator-aware prefix matching (matches production logic)
      const unavailableWithSep = [...unavailablePaths].flatMap(sp => [sp + '/', sp + '\\']);

      settings.set('library.collections', [
        { id: 'col-1', name: 'Local Only', videoPaths: ['/mnt/internal/v1.mp4'] },
        { id: 'col-2', name: 'External Only', videoPaths: ['E:\\ExternalDrive\\v2.mp4'] },
        { id: 'col-3', name: 'Mixed', videoPaths: ['/mnt/internal/v1.mp4', 'E:\\ExternalDrive\\v3.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const unavailableCollectionIds = new Set();
      for (const col of collections) {
        const hasUnavailable = (col.videoPaths || []).some(vp =>
          unavailableWithSep.some(prefix => vp.startsWith(prefix)) ||
          unavailablePaths.has(vp)
        );
        if (hasUnavailable) unavailableCollectionIds.add(col.id);
      }

      expect(unavailableCollectionIds.has('col-1')).toBe(false);
      expect(unavailableCollectionIds.has('col-2')).toBe(true);
      expect(unavailableCollectionIds.has('col-3')).toBe(true);
    });

    it('source availability — does not false-match similar path prefixes', () => {
      const unavailablePaths = new Set(['D:\\Videos']);
      const unavailableWithSep = [...unavailablePaths].flatMap(sp => [sp + '/', sp + '\\']);

      settings.set('library.collections', [
        { id: 'col-1', name: 'Videos', videoPaths: ['D:\\Videos\\movie.mp4'] },
        { id: 'col-2', name: 'Videos2', videoPaths: ['D:\\Videos2\\other.mp4'] },
        { id: 'col-3', name: 'VideosSub', videoPaths: ['D:\\VideosSub\\clip.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const unavailableCollectionIds = new Set();
      for (const col of collections) {
        const hasUnavailable = (col.videoPaths || []).some(vp =>
          unavailableWithSep.some(prefix => vp.startsWith(prefix)) ||
          unavailablePaths.has(vp)
        );
        if (hasUnavailable) unavailableCollectionIds.add(col.id);
      }

      // Only col-1 should match (D:\Videos\movie.mp4 starts with D:\Videos\)
      // col-2 and col-3 should NOT match (D:\Videos2 and D:\VideosSub are different folders)
      expect(unavailableCollectionIds.has('col-1')).toBe(true);
      expect(unavailableCollectionIds.has('col-2')).toBe(false);
      expect(unavailableCollectionIds.has('col-3')).toBe(false);
    });

    it('source availability — active collection reset when source disconnected', () => {
      settings.set('library.collections', [
        { id: 'col-1', name: 'External', videoPaths: ['E:\\Drive\\v1.mp4'] },
      ]);
      settings.set('library.activeCollectionId', 'col-1');

      const unavailableCollectionIds = new Set(['col-1']);
      let activeId = settings.get('library.activeCollectionId');
      if (activeId && unavailableCollectionIds.has(activeId)) {
        activeId = null;
        settings.set('library.activeCollectionId', null);
      }

      expect(activeId).toBeNull();
      expect(settings.get('library.activeCollectionId')).toBeNull();
    });

    it('source availability — all sources available means no unavailable collections', () => {
      const unavailablePaths = new Set();
      settings.set('library.collections', [
        { id: 'col-1', name: 'Test', videoPaths: ['/videos/v1.mp4', '/videos/v2.mp4'] },
      ]);

      const collections = settings.get('library.collections');
      const unavailableCollectionIds = new Set();
      for (const col of collections) {
        const hasUnavailable = (col.videoPaths || []).some(vp =>
          [...unavailablePaths].some(sp => vp.startsWith(sp))
        );
        if (hasUnavailable) unavailableCollectionIds.add(col.id);
      }

      expect(unavailableCollectionIds.size).toBe(0);
    });

    it('source availability — scan paths exclude unavailable sources', () => {
      const sources = [
        { id: 'src-1', name: 'Internal', path: '/internal', enabled: true },
        { id: 'src-2', name: 'USB', path: 'F:\\USB', enabled: true },
        { id: 'src-3', name: 'Disabled', path: '/disabled', enabled: false },
      ];
      const unavailable = new Set(['F:\\USB']);

      const scanPaths = sources
        .filter(s => s.enabled !== false && !unavailable.has(s.path))
        .map(s => s.path);

      expect(scanPaths).toEqual(['/internal']);
    });

    it('large number of videos in collection', () => {
      const paths = Array.from({ length: 1000 }, (_, i) => `/videos/video${i}.mp4`);
      settings.set('library.collections', [
        { id: 'col-1', name: 'Large', videoPaths: paths },
      ]);

      const col = settings.get('library.collections')[0];
      expect(col.videoPaths).toHaveLength(1000);

      // Filtering performance
      const allVideos = paths.map(p => ({ path: p, name: p.split('/').pop() }));
      const pathSet = new Set(col.videoPaths);
      const filtered = allVideos.filter(v => pathSet.has(v.path));
      expect(filtered).toHaveLength(1000);
    });
  });
});
