/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const dataExport = require_('../../electron/data-export.js');

// The REAL merge, the one applyImport runs (FT-007). This file used to
// define its own copy of mergeConfig + _deepMerge and test that, so the
// id-before-name match, the category re-pointing and the guards in the real
// function were never exercised here and could regress with every case
// still green.
const { mergeConfig } = dataExport;

/** The settings half of a merge: what the private _deepMerge produces. */
const mergeSettings = (local, imported) =>
  mergeConfig({ settings: local }, { settings: imported }, 'merge').settings;

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

    // FT-007: the cases the copied merge could never see.
    it('a playlist renamed since the export (same id) stays one entry with the new name', () => {
      const local = { ...baseConfig, playlists: [{ id: 'p1', name: 'Faves (renamed)', videoPaths: ['/v/a.mp4'] }] };
      const imported = { playlists: [{ id: 'p1', name: 'Favorites', videoPaths: ['/v/a.mp4'] }] };
      const result = mergeConfig(local, imported, 'merge');
      expect(result.playlists).toEqual([{ id: 'p1', name: 'Faves (renamed)', videoPaths: ['/v/a.mp4'] }]);
    });

    it('a category renamed since the export (same id) stays one entry with the new name', () => {
      const local = { ...baseConfig, categories: [{ id: 'c1', name: 'Action (renamed)', color: '#ff0000' }] };
      const imported = { categories: [{ id: 'c1', name: 'Action', color: '#ff0000' }], videoCategories: { '/v/b.mp4': ['c1'] } };
      const result = mergeConfig(local, imported, 'merge');
      expect(result.categories).toEqual([{ id: 'c1', name: 'Action (renamed)', color: '#ff0000' }]);
      // The backup's assignment names the same id, which exists here.
      expect(result.videoCategories['/v/b.mp4']).toEqual(['c1']);
    });

    it('a same-name category with another id: the backup\'s assignments point at the local one', () => {
      const imported = {
        categories: [{ id: 'c-other', name: 'Action', color: '#0000ff' }],
        videoCategories: { '/v/b.mp4': ['c-other'], '/v/a.mp4': ['c-other'] },
      };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.categories.map((c) => c.id)).toEqual(['c1']);
      // Every assignment names an id that exists after the merge.
      expect(result.videoCategories['/v/b.mp4']).toEqual(['c1']);
      expect(result.videoCategories['/v/a.mp4']).toEqual(['c1']);
    });

    it('a non-array videoCategories value in the backup is ignored, the local one kept', () => {
      const imported = { videoCategories: { '/v/a.mp4': 'c2', '/v/b.mp4': null, '/v/c.mp4': { 0: 'c1' } } };
      const result = mergeConfig(baseConfig, imported, 'merge');
      expect(result.videoCategories).toEqual({ '/v/a.mp4': ['c1'] });
    });

    it('a local config without lists (first launch) takes the backup\'s lists without throwing', () => {
      const imported = {
        playlists: [{ id: 'p9', name: 'Imported', videoPaths: [] }],
        categories: [{ id: 'c9', name: 'Imported cat' }],
        videoCategories: { '/v/z.mp4': ['c9'] },
      };
      const result = mergeConfig({ settings: {} }, imported, 'merge');
      expect(result.playlists.map((p) => p.id)).toEqual(['p9']);
      expect(result.categories.map((c) => c.id)).toEqual(['c9']);
      expect(result.videoCategories).toEqual({ '/v/z.mp4': ['c9'] });
    });
  });

  // FT-008: the plain deep merge let every imported settings value win, so
  // an old backup (made before the key was typed in, or after a log-out)
  // wiped the Handy key, the Autoblow token, the EroScripts login and the
  // whole Audience roster. A credential set here is now kept; the backup only
  // fills an empty slot. The roster is a union by key, local wins.
  describe('mergeConfig — a merge never wipes a credential (FT-008)', () => {
    const local = (settings) => ({ ...baseConfig, settings });
    const SESSION = { cookie: '_t=LOCALCOOKIE', username: 'dave' };

    it('local Handy key + empty imported key keeps the local key', () => {
      const result = mergeConfig(local({ handy: { connectionKey: 'TESTKEY01', defaultOffset: 0 } }),
        { settings: { handy: { connectionKey: '', defaultOffset: -40 } } }, 'merge');
      expect(result.settings.handy.connectionKey).toBe('TESTKEY01');
      // The rest of the section still comes from the backup.
      expect(result.settings.handy.defaultOffset).toBe(-40);
    });

    it('an empty local key is filled from the backup', () => {
      const result = mergeConfig(local({ handy: { connectionKey: '' } }),
        { settings: { handy: { connectionKey: 'xyz' } } }, 'merge');
      expect(result.settings.handy.connectionKey).toBe('xyz');
    });

    it('a local key and a different imported key: the key in use here is kept', () => {
      const result = mergeConfig(local({ handy: { connectionKey: 'TESTKEY01' } }),
        { settings: { handy: { connectionKey: 'OLDKEY99' } } }, 'merge');
      expect(result.settings.handy.connectionKey).toBe('TESTKEY01');
    });

    it('the Autoblow token survives an empty imported token, and an empty one is filled', () => {
      const kept = mergeConfig(local({ autoblow: { token: 'ABTOKEN1', offset: 0 } }),
        { settings: { autoblow: { token: '', offset: 25 } } }, 'merge');
      expect(kept.settings.autoblow).toEqual({ token: 'ABTOKEN1', offset: 25 });
      const filled = mergeConfig(local({ autoblow: { token: '' } }),
        { settings: { autoblow: { token: 'ABTOKEN2' } } }, 'merge');
      expect(filled.settings.autoblow.token).toBe('ABTOKEN2');
    });

    it('an imported null EroScripts session keeps the local login', () => {
      const result = mergeConfig(local({ eroscripts: { session: SESSION } }),
        { settings: { eroscripts: { session: null } } }, 'merge');
      expect(result.settings.eroscripts.session).toEqual(SESSION);
    });

    it('a local log-out (null session) is filled from the backup', () => {
      const imported = { cookie: '_t=FROMBACKUP', username: 'dave' };
      const result = mergeConfig(local({ eroscripts: { session: null } }),
        { settings: { eroscripts: { session: imported } } }, 'merge');
      expect(result.settings.eroscripts.session).toEqual(imported);
    });

    it('a backup whose whole section is null does not take the local key with it', () => {
      const result = mergeConfig(local({ handy: { connectionKey: 'TESTKEY01' }, eroscripts: { session: SESSION } }),
        { settings: { handy: null, eroscripts: null } }, 'merge');
      expect(result.settings.handy.connectionKey).toBe('TESTKEY01');
      expect(result.settings.eroscripts.session).toEqual(SESSION);
    });

    it('Audience viewers: union by key, the local row wins, an empty roster deletes nobody', () => {
      const here = [
        { key: 'VIEWERA1', label: 'Alice', offsetMs: 10 },
        { key: 'VIEWERB2', label: 'Bob', offsetMs: 0 },
      ];
      const fromBackup = [
        { key: 'viewerb2 ', label: 'Bob (old)', offsetMs: 99 }, // same device, pasted differently
        { key: 'VIEWERC3', label: 'Cara', offsetMs: 5 },
        { label: 'no key' },
      ];
      const merged = mergeConfig(local({ audience: { viewers: here, hideKeys: true } }),
        { settings: { audience: { viewers: fromBackup, hideKeys: false } } }, 'merge');
      expect(merged.settings.audience.viewers).toEqual([
        { key: 'VIEWERA1', label: 'Alice', offsetMs: 10 },
        { key: 'VIEWERB2', label: 'Bob', offsetMs: 0 },
        { key: 'VIEWERC3', label: 'Cara', offsetMs: 5 },
      ]);
      // A non-credential setting in the same section still comes from the backup.
      expect(merged.settings.audience.hideKeys).toBe(false);

      const emptied = mergeConfig(local({ audience: { viewers: here } }),
        { settings: { audience: { viewers: [] } } }, 'merge');
      expect(emptied.settings.audience.viewers).toEqual(here);
    });

    it('an empty local roster takes the backup\'s viewers', () => {
      const fromBackup = [{ key: 'VIEWERC3', label: 'Cara', offsetMs: 5 }];
      const result = mergeConfig(local({ audience: { viewers: [] } }),
        { settings: { audience: { viewers: fromBackup } } }, 'merge');
      expect(result.settings.audience.viewers).toEqual(fromBackup);
    });

    it('overwrite mode is the user\'s explicit "replace everything" and is unchanged', () => {
      const result = mergeConfig(local({ handy: { connectionKey: 'TESTKEY01' } }),
        { settings: { handy: { connectionKey: '' } } }, 'overwrite');
      expect(result.settings.handy.connectionKey).toBe('');
    });

    it('Import Backup File (applyImport, a real zip) keeps the key typed in after the export', async () => {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-import-secret-'));
      try {
        // Exported from a fresh install: no key, no login, no viewers.
        const zipPath = path.join(tmp, 'fresh.funsync-backup');
        const fresh = {
          settings: { handy: { connectionKey: '' }, autoblow: { token: '' }, eroscripts: { session: null }, audience: { viewers: [] } },
          playlists: [], categories: [], videoCategories: {},
        };
        expect((await dataExport.exportData(fresh, zipPath)).success).toBe(true);

        // Since then the user set everything up.
        let live = {
          settings: {
            handy: { connectionKey: 'TESTKEY01' },
            autoblow: { token: 'ABTOKEN1' },
            eroscripts: { session: SESSION },
            audience: { viewers: [{ key: 'VIEWERA1', label: 'Alice', offsetMs: 0 }] },
          },
          playlists: [], categories: [], videoCategories: {},
        };
        const store = { getAll: () => JSON.parse(JSON.stringify(live)), replaceData: (d) => { live = d; } };
        const relaunch = vi.fn();
        const res = await dataExport.applyImport({ filePath: zipPath, store, relaunch });

        expect(res.success).toBe(true);
        expect(relaunch).toHaveBeenCalledTimes(1);
        expect(live.settings.handy.connectionKey).toBe('TESTKEY01');
        expect(live.settings.autoblow.token).toBe('ABTOKEN1');
        expect(live.settings.eroscripts.session).toEqual(SESSION);
        expect(live.settings.audience.viewers).toEqual([{ key: 'VIEWERA1', label: 'Alice', offsetMs: 0 }]);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
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
          handy: { connectionKey: 'FAKEKEY1', defaultOffset: -50 },
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
      // Keys and logins are left out unless asked for (2026-11-26; below).
      expect(exported.settings.handy.connectionKey).toBeUndefined();
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
      // Keys are left out unless asked for (2026-11-26); asked for, it is there.
      expect(exported.settings.handy).toEqual({});
      await dataExport.exportData(minimal, path.join(tmpDir, 'backup.zip'), { includeSecrets: true });
      expect((await readZipConfig(path.join(tmpDir, 'backup.zip'))).settings.handy.connectionKey).toBe('k');
    });
  });

  // The private _deepMerge, through the only door it has: the settings half
  // of a real merge.
  describe('settings deep merge', () => {
    it('merges nested objects', () => {
      const a = { x: { y: 1, z: 2 } };
      const b = { x: { z: 3, w: 4 } };
      expect(mergeSettings(a, b)).toEqual({ x: { y: 1, z: 3, w: 4 } });
    });

    it('source overrides target for scalar values', () => {
      expect(mergeSettings({ a: 1 }, { a: 2 }).a).toBe(2);
    });

    it('source overrides target for arrays (no array merge)', () => {
      expect(mergeSettings({ a: [1, 2] }, { a: [3] }).a).toEqual([3]);
    });

    it('adds new keys from source', () => {
      expect(mergeSettings({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    });

    it('does not mutate target', () => {
      const target = { a: { b: 1 } };
      const copy = JSON.parse(JSON.stringify(target));
      mergeSettings(target, { a: { c: 2 } });
      expect(target).toEqual(copy);
    });
  });
});
