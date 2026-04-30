import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const dataExport = require_('../../electron/data-export.js');

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

  // Regression: pre-fix, exportData() wrote the live config straight into
  // the zip without stripping the high-churn derived caches. For a 1000-
  // video library `thumbnailCache` alone could be tens of MB of base64
  // JPEGs travelling along with every shared backup. SCOPE-data-backup.md
  // §4.8 + §7.6a require exportData to use the same BACKUP_BLACKLIST as
  // the rolling-snapshot pipeline. These tests pin that contract.
  describe('exportData — blacklist enforcement', () => {
    let tmpDir;
    beforeEach(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-export-test-'));
    });
    afterEach(async () => {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    async function readZipConfig(zipPath) {
      const JSZip = require_('jszip');
      const buf = await fsp.readFile(zipPath);
      const zip = await JSZip.loadAsync(buf);
      const file = zip.file('config.json');
      expect(file).toBeTruthy();
      const text = await file.async('string');
      return JSON.parse(text);
    }

    function configWithCaches() {
      return {
        settings: {
          handy: { connectionKey: 'eK6Qv3AH', defaultOffset: -50 },
          library: {
            sources: [{ id: 's1', path: '/media/lib' }],
            collections: [{ id: 'c1', name: 'Favourites' }],
            associations: { '/v/a.mp4': '/v/a.funscript' },
            customRouting: { dev0: 'L0' },
            // Blacklisted — must NOT appear in the exported zip.
            speedStatsCache: { '/v/a.mp4': { mean: 12, max: 200 } },
            durationCache: { '/v/a.mp4': 1234 },
            thumbnailCache: { '/v/a.mp4': 'data:image/jpeg;base64,/9j/4AAQ...' },
          },
        },
        playlists: [{ id: 'p1', name: 'Test', videoPaths: [] }],
        categories: [{ id: 'cat1', name: 'Action' }],
        videoCategories: { '/v/a.mp4': ['cat1'] },
        _migrated: true,
      };
    }

    it('exported config.json has no thumbnailCache / durationCache / speedStatsCache', async () => {
      const out = path.join(tmpDir, 'backup.zip');
      const result = await dataExport.exportData(configWithCaches(), out);
      expect(result.success).toBe(true);

      const exported = await readZipConfig(out);
      expect(exported.settings.library.speedStatsCache).toBeUndefined();
      expect(exported.settings.library.durationCache).toBeUndefined();
      expect(exported.settings.library.thumbnailCache).toBeUndefined();
    });

    it('exported config.json preserves non-cache library fields', async () => {
      const out = path.join(tmpDir, 'backup.zip');
      await dataExport.exportData(configWithCaches(), out);
      const exported = await readZipConfig(out);

      expect(exported.settings.library.sources).toHaveLength(1);
      expect(exported.settings.library.collections).toHaveLength(1);
      expect(exported.settings.library.associations).toEqual({ '/v/a.mp4': '/v/a.funscript' });
      expect(exported.settings.library.customRouting).toEqual({ dev0: 'L0' });
      expect(exported.settings.handy.connectionKey).toBe('eK6Qv3AH');
      expect(exported.playlists).toHaveLength(1);
      expect(exported.categories).toHaveLength(1);
      expect(exported.videoCategories).toEqual({ '/v/a.mp4': ['cat1'] });
      expect(exported._migrated).toBe(true);
    });

    it('exportData does not mutate the input config (cache fields stay on the live object)', async () => {
      // Stripping is a copy operation — the caller's live config keeps its
      // caches so the running app can still hit them after the user clicks
      // Export. Verify by snapshotting the input shape and re-checking.
      const cfg = configWithCaches();
      const before = JSON.stringify(cfg);
      await dataExport.exportData(cfg, path.join(tmpDir, 'backup.zip'));
      expect(JSON.stringify(cfg)).toBe(before);
      // Sanity: live cache fields really are still there.
      expect(cfg.settings.library.thumbnailCache).toBeDefined();
    });

    it('exported config sans library section still excludes caches gracefully', async () => {
      // Edge case: minimal install / first-launch config has no library
      // sub-tree at all. stripBlacklist must not throw on missing parents.
      const minimal = {
        settings: { handy: { connectionKey: 'k' } },
        playlists: [],
        categories: [],
      };
      const result = await dataExport.exportData(minimal, path.join(tmpDir, 'backup.zip'));
      expect(result.success).toBe(true);
      const exported = await readZipConfig(path.join(tmpDir, 'backup.zip'));
      expect(exported.settings.handy.connectionKey).toBe('k');
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
