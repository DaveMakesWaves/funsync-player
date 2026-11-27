/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Library > Select > Assign category writes the whole selection in ONE
// config.json write (TODO triage 2026-11-23, perf, also in v0.9.2): one
// assignCategory per video rewrote the file each time, 7-14 ms apiece. The
// REAL store on the REAL electron-conf (as backup-autosave.test.js), counted
// with store.subscribe; and the DataService cache and the library's use.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});
const store = await import('../../electron/store.js');

const PATHS = ['C:\\V\\a.mp4', 'C:\\V\\b.mp4', 'C:\\V\\c.mp4'];

describe('store.assignCategoryToVideos', () => {
  let writes;
  let unsubscribe;
  let catId;
  beforeEach(async () => {
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-bulkcat-'));
    await store.initStore();
    catId = store.addCategory('Favs', '#4caf50').id;
    store.assignCategory(PATHS[0], catId); // one already has it
    writes = 0;
    unsubscribe = store.subscribe(() => { writes += 1; });
  });
  afterEach(() => unsubscribe?.());

  it('one write for the whole selection; a video that has it keeps one copy', () => {
    store.assignCategoryToVideos(PATHS, catId);
    expect(writes).toBe(1);
    const map = store.getAll().videoCategories;
    for (const p of PATHS) expect(map[p]).toEqual([catId]);
  });

  it('nothing new: no write at all; junk entries skipped', () => {
    store.assignCategoryToVideos([PATHS[0], '', null, 7], catId);
    expect(writes).toBe(0);
    store.assignCategoryToVideos('not a list', catId);
    store.assignCategoryToVideos(PATHS, '');
    expect(writes).toBe(0);
  });
});

describe('the renderer side', () => {
  it('DataService updates its cache and sends ONE call', async () => {
    const { DataService } = await import('../../renderer/js/data-service.js');
    const sent = [];
    globalThis.window = { funsync: { assignCategoryToVideos: (p, c) => sent.push([p, c]) } };
    const ds = Object.create(DataService.prototype);
    ds._cache = { videoCategories: { [PATHS[0]]: ['cat1'] } };
    ds.assignCategoryToVideos(PATHS, 'cat1');
    expect(sent).toEqual([[PATHS, 'cat1']]);
    for (const p of PATHS) expect(ds._cache.videoCategories[p]).toEqual(['cat1']);
    delete globalThis.window;
  });

  it('the library\'s bulk assign uses it; wired through main and preload', () => {
    const lib = fs.readFileSync('renderer/components/library.js', 'utf8');
    expect(lib).toContain('this._settings.assignCategoryToVideos([...this._selectedPaths], selectedId);');
    expect(fs.readFileSync('electron/main.js', 'utf8')).toMatch(/ipcMain\.handle\('assign-category-to-videos', \(_event, videoPaths, catId\) => \{\r?\n\s+store\.assignCategoryToVideos\(videoPaths, catId\);/);
    expect(fs.readFileSync('electron/preload.js', 'utf8')).toContain("assignCategoryToVideos: (videoPaths, catId) => ipcRenderer.invoke('assign-category-to-videos', videoPaths, catId),");
  });
});
