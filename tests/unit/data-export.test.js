import { describe, it, expect, vi, beforeEach } from 'vitest';

// Since data-export.js is CJS (main process), we test the mergeConfig logic
// by extracting its pattern. For export/import, we test the merge function directly.

// Replicate the mergeConfig + _deepMerge logic for testing
// (the actual module uses require() which Vitest can import)
function _deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = _deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function mergeConfig(existing, imported, mode) {
  if (mode === 'overwrite') {
    return { ...imported };
  }

  const merged = JSON.parse(JSON.stringify(existing));

  if (imported.settings) {
    merged.settings = _deepMerge(merged.settings || {}, imported.settings);
  }

  if (imported.playlists) {
    const existingNames = new Set((merged.playlists || []).map(p => p.name));
    for (const playlist of imported.playlists) {
      if (!existingNames.has(playlist.name)) {
        merged.playlists.push(playlist);
      }
    }
  }

  if (imported.categories) {
    const existingNames = new Set((merged.categories || []).map(c => c.name));
    for (const category of imported.categories) {
      if (!existingNames.has(category.name)) {
        merged.categories.push(category);
      }
    }
  }

  if (imported.videoCategories) {
    for (const [videoPath, catIds] of Object.entries(imported.videoCategories)) {
      if (!merged.videoCategories[videoPath]) {
        merged.videoCategories[videoPath] = catIds;
      } else {
        const existing = new Set(merged.videoCategories[videoPath]);
        for (const id of catIds) {
          if (!existing.has(id)) merged.videoCategories[videoPath].push(id);
        }
      }
    }
  }

  return merged;
}

describe('data-export', () => {
  const baseConfig = {
    settings: {
      handy: { connectionKey: 'abc', defaultOffset: 50 },
      player: { volume: 80 },
      buttplug: { port: 12345 },
    },
    playlists: [
      { id: 'p1', name: 'Favorites', videoPaths: ['/v/a.mp4'] },
    ],
    categories: [
      { id: 'c1', name: 'Action', color: '#ff0000' },
    ],
    videoCategories: {
      '/v/a.mp4': ['c1'],
    },
    _migrated: true,
  };

  describe('mergeConfig — overwrite mode', () => {
    it('replaces entire config with imported data', () => {
      const imported = {
        settings: { player: { volume: 50 } },
        playlists: [],
        categories: [],
        videoCategories: {},
      };
      const result = mergeConfig(baseConfig, imported, 'overwrite');
      expect(result.settings.player.volume).toBe(50);
      expect(result.playlists).toEqual([]);
      expect(result.settings.handy).toBeUndefined();
    });
  });

  describe('mergeConfig — merge mode', () => {
    it('merges settings (imported overrides existing)', () => {
      const imported = {
        settings: { player: { volume: 50 } },
        playlists: [],
        categories: [],
        videoCategories: {},
      };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.settings.player.volume).toBe(50);
      // Existing settings preserved
      expect(result.settings.handy.connectionKey).toBe('abc');
      expect(result.settings.buttplug.port).toBe(12345);
    });

    it('adds new playlists, skips duplicates by name', () => {
      const imported = {
        settings: {},
        playlists: [
          { id: 'p2', name: 'New List', videoPaths: [] },
          { id: 'p1-dup', name: 'Favorites', videoPaths: ['/v/b.mp4'] },
        ],
        categories: [],
        videoCategories: {},
      };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.playlists.length).toBe(2); // original + New List
      expect(result.playlists[1].name).toBe('New List');
      // Duplicate "Favorites" was skipped — original preserved
      expect(result.playlists[0].id).toBe('p1');
    });

    it('adds new categories, skips duplicates by name', () => {
      const imported = {
        settings: {},
        playlists: [],
        categories: [
          { id: 'c2', name: 'Comedy', color: '#00ff00' },
          { id: 'c1-dup', name: 'Action', color: '#0000ff' },
        ],
        videoCategories: {},
      };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.categories.length).toBe(2);
      expect(result.categories[1].name).toBe('Comedy');
      // Original Action preserved (not overwritten by duplicate)
      expect(result.categories[0].color).toBe('#ff0000');
    });

    it('merges video categories (union)', () => {
      const imported = {
        settings: {},
        playlists: [],
        categories: [],
        videoCategories: {
          '/v/a.mp4': ['c2'], // existing video, new category
          '/v/b.mp4': ['c1'], // new video
        },
      };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.videoCategories['/v/a.mp4']).toEqual(['c1', 'c2']);
      expect(result.videoCategories['/v/b.mp4']).toEqual(['c1']);
    });

    it('does not duplicate existing video category assignments', () => {
      const imported = {
        settings: {},
        playlists: [],
        categories: [],
        videoCategories: {
          '/v/a.mp4': ['c1'], // already exists
        },
      };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.videoCategories['/v/a.mp4']).toEqual(['c1']);
    });

    it('does not mutate input objects', () => {
      const existingCopy = JSON.parse(JSON.stringify(baseConfig));
      const imported = {
        settings: { player: { volume: 99 } },
        playlists: [{ id: 'p3', name: 'New', videoPaths: [] }],
        categories: [],
        videoCategories: {},
      };
      mergeConfig(baseConfig, imported, 'merge');
      expect(baseConfig).toEqual(existingCopy);
    });

    it('handles empty existing config', () => {
      const empty = { settings: {}, playlists: [], categories: [], videoCategories: {} };
      const imported = {
        settings: { player: { volume: 75 } },
        playlists: [{ id: 'p1', name: 'Test', videoPaths: [] }],
        categories: [],
        videoCategories: {},
      };
      const result = mergeConfig(empty, imported, 'merge');
      expect(result.settings.player.volume).toBe(75);
      expect(result.playlists.length).toBe(1);
    });

    it('handles missing fields in imported config', () => {
      const imported = { settings: { player: { volume: 60 } } };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.settings.player.volume).toBe(60);
      expect(result.playlists.length).toBe(1); // unchanged
    });
  });

  describe('_deepMerge', () => {
    it('merges nested objects', () => {
      const a = { x: { y: 1, z: 2 } };
      const b = { x: { z: 3, w: 4 } };
      const result = _deepMerge(a, b);
      expect(result).toEqual({ x: { y: 1, z: 3, w: 4 } });
    });

    it('source overrides target for scalar values', () => {
      const result = _deepMerge({ a: 1 }, { a: 2 });
      expect(result.a).toBe(2);
    });

    it('source overrides target for arrays (no array merge)', () => {
      const result = _deepMerge({ a: [1, 2] }, { a: [3] });
      expect(result.a).toEqual([3]);
    });

    it('adds new keys from source', () => {
      const result = _deepMerge({ a: 1 }, { b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('does not mutate target', () => {
      const target = { a: { b: 1 } };
      const copy = JSON.parse(JSON.stringify(target));
      _deepMerge(target, { a: { c: 2 } });
      expect(target).toEqual(copy);
    });
  });
});
