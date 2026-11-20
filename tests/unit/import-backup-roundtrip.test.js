// Import Backup File, end to end, against the REAL electron-conf (V02).
//
// jsdom on purpose (no node docblock): the renderer half is the real
// DataService, which reads localStorage at init. See notes/CLAUDE.md
// "Test environments".
//
// The bug had two halves, both in v0.9.2:
//   1. the 'import-data' handler merged playlists, categories and category
//      assignments, then wrote back only `merged.settings`;
//   2. nothing reloaded the renderer, whose DataService answers every read
//      from its boot-time cache and writes whole maps back. The next
//      association edit wrote the pre-import map over the imported entries.
// So this test replays the tester's repro: export, delete a playlist, a
// category and an association, import, then make an ordinary association
// edit, and checks the store on DISK after each step.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});

const store = await import('../../electron/store.js');
const { DataService } = await import('../../renderer/js/data-service.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');
const { _setBundlesForTests, _resetForTests } = await import('../../renderer/js/i18n.js');
const { makeResumeEntry } = await import('../../renderer/js/resume-position.js');
const require_ = createRequire(import.meta.url);
const dataExport = require_('../../electron/data-export.js');
const en = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const de = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

const UNTAGGED = 'D:\\lib\\Untagged Wide.mp4';
const COMPANION = 'D:\\lib\\Companion.mp4';
const ALPHA = 'D:\\lib\\Alpha Scene.mp4';
const SQUARE = 'D:\\lib\\Square OU.mp4';

const onDisk = () => JSON.parse(fs.readFileSync(path.join(h.userData, 'config.json'), 'utf8'));

/**
 * A renderer: the real DataService with window.funsync wired straight to
 * the store, the way preload + main's IPC handlers wire it in the app.
 */
async function bootRenderer() {
  Object.assign(globalThis.funsync, {
    getAllData: async () => store.getAll(),
    setSetting: async (p, v) => store.setSetting(p, v),
    deletePlaylist: async (id) => store.deletePlaylist(id),
    renamePlaylist: async (id, name) => store.renamePlaylist(id, name),
    deleteCategory: async (id) => store.deleteCategory(id),
    renameCategory: async (id, name) => store.renameCategory(id, name),
    assignCategory: async (p, id) => store.assignCategory(p, id),
    unassignCategory: async (p, id) => store.unassignCategory(p, id),
  });
  const ds = new DataService();
  await ds.init();
  return ds;
}

/** What library.js does for every association edit: read the map, write it whole. */
function associate(ds, videoPath, scriptPath) {
  const map = { ...(ds.get('library.associations') || {}) };
  map[videoPath] = { single: scriptPath };
  ds.set('library.associations', map);
}

function unassociate(ds, videoPath) {
  const map = { ...(ds.get('library.associations') || {}) };
  delete map[videoPath];
  ds.set('library.associations', map);
}

describe('Import Backup File restores what export saved (V02)', () => {
  let zipPath;
  let catId;
  let listId;

  beforeEach(async () => {
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-import-'));
    zipPath = path.join(h.userData, 'export.zip');
    await store.initStore();

    const list = store.addPlaylist('E Test List');
    store.addVideoToPlaylist(list.id, ALPHA);
    listId = list.id;
    const cat = store.addCategory('E Cat', '#3498db');
    catId = cat.id;
    store.assignCategory(ALPHA, catId);
    store.assignCategory(UNTAGGED, catId);
    store.setSetting('library.associations', {
      [COMPANION]: { single: 'D:\\lib\\Companion.funscript' },
      [UNTAGGED]: { single: 'D:\\lib\\Untagged Wide.funscript' },
    });

    const exported = await dataExport.exportData(store.getAll(), zipPath);
    expect(exported.success).toBe(true);
  });

  afterEach(() => {
    try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('brings back a deleted playlist, category, assignments and association, and a later edit keeps them', async () => {
    // The user deletes things through the running app.
    const before = await bootRenderer();
    before.deletePlaylist(listId);
    before.deleteCategory(catId);
    unassociate(before, UNTAGGED);
    expect(onDisk().playlists).toEqual([]);
    expect(onDisk().videoCategories).toEqual({});

    const relaunch = vi.fn();
    const result = await dataExport.applyImport({ filePath: zipPath, store, relaunch });
    expect(result.success).toBe(true);

    // Everything the export held is back in config.json.
    const disk = onDisk();
    expect(disk.playlists.map((p) => p.name)).toEqual(['E Test List']);
    expect(disk.playlists[0].videoPaths).toEqual([ALPHA]);
    expect(disk.categories.map((c) => c.name)).toEqual(['E Cat']);
    expect(disk.videoCategories).toEqual({ [ALPHA]: [catId], [UNTAGGED]: [catId] });
    expect(Object.keys(disk.settings.library.associations).sort()).toEqual([COMPANION, UNTAGGED].sort());

    // And the app is relaunched, so no renderer keeps its pre-import cache.
    expect(relaunch).toHaveBeenCalledTimes(1);

    // After the relaunch: a fresh main process and a fresh renderer.
    await store.initStore();
    const after = await bootRenderer();
    expect(after.getPlaylists().map((p) => p.name)).toEqual(['E Test List']);
    expect(after.getCategories().map((c) => c.id)).toEqual([catId]);
    expect(after.getVideosByCategory(catId).sort()).toEqual([ALPHA, UNTAGGED].sort());
    expect(after.get('library.associations')[UNTAGGED]).toBeTruthy();

    // The tester's last step: an ordinary association edit on another video.
    associate(after, SQUARE, 'D:\\lib\\Zulu Last.funscript');
    const assoc = onDisk().settings.library.associations;
    expect(Object.keys(assoc).sort()).toEqual([COMPANION, SQUARE, UNTAGGED].sort());
  });

  it('writes nothing and does not relaunch when the file is not a backup', async () => {
    const bogus = path.join(h.userData, 'not-a-backup.zip');
    fs.writeFileSync(bogus, 'definitely not a zip');
    const snapshot = JSON.stringify(onDisk());
    const relaunch = vi.fn();
    const beforeWrite = vi.fn();
    const stopPlayback = vi.fn();

    const result = await dataExport.applyImport({ filePath: bogus, store, stopPlayback, beforeWrite, relaunch });

    expect(result.success).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
    expect(beforeWrite).not.toHaveBeenCalled();
    // Picking the wrong file must not pause the user's video either.
    expect(stopPlayback).not.toHaveBeenCalled();
    expect(JSON.stringify(onDisk())).toBe(snapshot);
  });

  it('stops playback and every device before it reads, writes or relaunches, and keeps what the renderer saved while stopping', async () => {
    // The relaunch is app.exit(), which skips the renderer's beforeunload
    // device stop: a Handy in HSSP kept playing the script on its own.
    const ds = await bootRenderer();
    const order = [];
    const resume = { [SQUARE]: makeResumeEntry(123, 600, Date.now()) };
    let devicesAnswered;
    const stopPlayback = vi.fn(() => {
      order.push('stop');
      // Pausing saves the resume position, as the real renderer does.
      ds.set('library.resumePositions', resume);
      return new Promise((resolve) => { devicesAnswered = resolve; });
    });
    const beforeWrite = vi.fn(async () => { order.push('snapshot'); });
    const relaunch = vi.fn(() => { order.push('relaunch'); });

    const pending = dataExport.applyImport({ filePath: zipPath, store, stopPlayback, beforeWrite, relaunch });
    await vi.waitFor(() => expect(stopPlayback).toHaveBeenCalledTimes(1));
    // Still waiting on the devices: nothing snapshotted, written or relaunched.
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['stop']);

    devicesAnswered();
    expect((await pending).success).toBe(true);
    expect(order).toEqual(['stop', 'snapshot', 'relaunch']);
    expect(onDisk().settings.library.resumePositions[SQUARE]).toEqual(resume[SQUARE]);
  });

  it('takes the pre-import snapshot BEFORE anything is written', async () => {
    store.deletePlaylist(listId);
    let playlistsSeenBySnapshot = null;
    const beforeWrite = vi.fn(async () => { playlistsSeenBySnapshot = store.getAll().playlists; });

    await dataExport.applyImport({ filePath: zipPath, store, beforeWrite, relaunch: () => {} });

    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(playlistsSeenBySnapshot).toEqual([]);
    expect(onDisk().playlists).toHaveLength(1);
  });

  it('leaves poster entries alone when the backup carries no images (pre-V59 exports)', async () => {
    const oldPath = 'C:\\Users\\someone\\AppData\\Roaming\\funsync-player\\custom-thumbs\\abc.jpg';
    store.setSetting('library.customThumbnails', { [ALPHA]: { type: 'image', imagePath: oldPath } });
    const oldZip = path.join(h.userData, 'old-export.zip');
    await dataExport.exportData(store.getAll(), oldZip); // no customThumbsDir: what v0.9.2 wrote
    store.setSetting('library.customThumbnails', {});

    const result = await dataExport.applyImport({
      filePath: oldZip, store, customThumbsDir: path.join(h.userData, 'custom-thumbs'), relaunch: () => {},
    });
    expect(result.success).toBe(true);
    expect(onDisk().settings.library.customThumbnails[ALPHA]).toEqual({ type: 'image', imagePath: oldPath });
  });

  it('re-points assignments at a same-named category that already exists here', async () => {
    // Another machine: the user re-created "E Cat" by hand, so it has a
    // different id than the one in the backup.
    store.deleteCategory(catId);
    const local = store.addCategory('E Cat', '#ff0000');

    await dataExport.applyImport({ filePath: zipPath, store, relaunch: () => {} });

    const disk = onDisk();
    expect(disk.categories.map((c) => c.id)).toEqual([local.id]);
    expect(disk.videoCategories[ALPHA]).toEqual([local.id]);
    expect(disk.videoCategories[UNTAGGED]).toEqual([local.id]);
  });

  it('a playlist and a category renamed since the export stay one entry each, and tidying up deletes nothing else', async () => {
    // The realistic V01 recovery: things were renamed after the export, then
    // category assignments were lost, and the older backup is imported to
    // get them back. Ids are random UUIDs, so the backup's "E Test List" IS
    // today's "Faves 2026". Matching by name alone brought the old name
    // back as a second row with the SAME id.
    const ds = await bootRenderer();
    ds.renamePlaylist(listId, 'Faves 2026');
    ds.renameCategory(catId, 'Favourites');
    ds.unassignCategory(ALPHA, catId); // the loss being recovered

    const result = await dataExport.applyImport({ filePath: zipPath, store, relaunch: () => {} });
    expect(result.success).toBe(true);

    const disk = onDisk();
    expect(disk.playlists.map((p) => [p.id, p.name])).toEqual([[listId, 'Faves 2026']]);
    expect(disk.categories.map((c) => [c.id, c.name])).toEqual([[catId, 'Favourites']]);
    expect(disk.videoCategories[ALPHA]).toEqual([catId]); // recovered, on the renamed category

    // After the relaunch the user tidies up: a row still carrying the OLD
    // name looks like a stale copy from the backup, so they delete it.
    // Deletes go by id, so that row would take the renamed playlist and
    // category, and every assignment to the category, with it.
    await store.initStore();
    const after = await bootRenderer();
    for (const p of after.getPlaylists().filter((x) => x.name === 'E Test List')) after.deletePlaylist(p.id);
    for (const c of after.getCategories().filter((x) => x.name === 'E Cat')) after.deleteCategory(c.id);

    const tidied = onDisk();
    expect(tidied.playlists.map((p) => p.name)).toEqual(['Faves 2026']);
    expect(tidied.playlists[0].videoPaths).toEqual([ALPHA]);
    expect(tidied.categories.map((c) => c.name)).toEqual(['Favourites']);
    expect(tidied.videoCategories).toEqual({ [ALPHA]: [catId], [UNTAGGED]: [catId] });
  });
});

describe('a failed import says why (V02)', () => {
  // Restore From Backup always named the reason; Import showed a bare
  // "Import failed", so a file that is not a backup and a broken backup
  // looked the same.
  let dir;
  const toasts = () => [...document.querySelectorAll('#toast-container .toast__body')].map((el) => el.textContent);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-import-fail-'));
    document.body.innerHTML = '<div id="toast-container"></div>';
    _setBundlesForTests('en', en, en);
  });

  afterEach(() => {
    _resetForTests();
    document.body.innerHTML = '';
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function importAndToast(filePath) {
    const result = await dataExport.applyImport({ filePath, store, relaunch: vi.fn() });
    SettingsPanel.prototype._showImportFailure.call(null, result);
  }

  it('names the reason for a file that is not a zip, and for a zip with no config.json', async () => {
    const notZip = path.join(dir, 'holiday.zip');
    fs.writeFileSync(notZip, 'definitely not a zip');
    const JSZip = require_('jszip');
    const noConfig = path.join(dir, 'other-app-backup.zip');
    const zip = new JSZip();
    zip.file('metadata.json', '{}');
    fs.writeFileSync(noConfig, await zip.generateAsync({ type: 'nodebuffer' }));

    await importAndToast(notZip);
    await importAndToast(noConfig);

    expect(toasts()).toEqual([
      'Import failed: Invalid backup: not a zip file',
      'Import failed: Invalid backup: missing config.json',
    ]);
    expect([...document.querySelectorAll('#toast-container .toast')].every((el) => el.classList.contains('toast--error'))).toBe(true);
  });

  it('in the user\'s language', async () => {
    _setBundlesForTests('de', de, en);
    const notZip = path.join(dir, 'holiday.zip');
    fs.writeFileSync(notZip, 'definitely not a zip');
    await importAndToast(notZip);
    expect(toasts()).toEqual(['Import fehlgeschlagen: Invalid backup: not a zip file']);
  });

  it('a cancelled file picker is not an error', () => {
    SettingsPanel.prototype._showImportFailure.call(null, { success: false, error: 'Cancelled' });
    expect(toasts()).toEqual([en.settingsPanel.data.importCancelled]);
  });
});

describe('uploaded poster images travel with the backup (V59)', () => {
  // Machine A exports; machine B (a different userData) imports. The config
  // only ever held a path into A's custom-thumbs folder, so before this the
  // poster silently fell back to the auto frame on B.
  const VIDEO = 'D:\\lib\\Alpha Scene.mp4';
  const FRAME_VIDEO = 'D:\\lib\\Zulu Last.mp4';
  const NAME = '0123456789abcdef0123456789abcdef.jpg';
  const POSTER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
  let machineA;
  let machineB;
  let zip;
  let thumbsB;

  beforeEach(async () => {
    machineA = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-thumbs-a-'));
    machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-thumbs-b-'));
    const thumbsA = path.join(machineA, 'custom-thumbs');
    thumbsB = path.join(machineB, 'custom-thumbs');
    fs.mkdirSync(thumbsA);
    fs.writeFileSync(path.join(thumbsA, NAME), POSTER);
    // Something that is NOT in custom-thumbs, referenced by a tampered entry.
    fs.writeFileSync(path.join(machineA, 'private.jpg'), Buffer.from('not yours'));

    const config = {
      settings: {
        library: {
          customThumbnails: {
            [VIDEO]: { type: 'image', imagePath: path.join(thumbsA, NAME) },
            [FRAME_VIDEO]: { seekPct: 30 },
            'D:\\lib\\Tampered.mp4': { type: 'image', imagePath: path.join(machineA, 'private.jpg') },
          },
        },
      },
      playlists: [], categories: [], videoCategories: {},
    };
    zip = path.join(machineA, 'export.zip');
    const exported = await dataExport.exportData(config, zip, { customThumbsDir: thumbsA });
    expect(exported.success).toBe(true);

    h.userData = machineB;
    await store.initStore();
  });

  afterEach(() => {
    for (const d of [machineA, machineB]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('bundles the image, restores it on the other machine and points the entry at it', async () => {
    const result = await dataExport.applyImport({ filePath: zip, store, customThumbsDir: thumbsB, relaunch: () => {} });
    expect(result.success).toBe(true);

    expect(fs.readFileSync(path.join(thumbsB, NAME)).equals(POSTER)).toBe(true);
    const thumbs = onDisk().settings.library.customThumbnails;
    expect(thumbs[VIDEO]).toEqual({ type: 'image', imagePath: path.join(thumbsB, NAME) });
    expect(thumbs[FRAME_VIDEO]).toEqual({ seekPct: 30 });
  });

  it('never bundles a file from outside custom-thumbs', async () => {
    const JSZip = require_('jszip');
    const archive = await JSZip.loadAsync(fs.readFileSync(zip));
    const names = Object.keys(archive.files).filter((n) => !archive.files[n].dir);
    expect(names.sort()).toEqual(['config.json', `custom-thumbs/${NAME}`, 'metadata.json'].sort());
  });

  it('never overwrites a poster already on this machine', async () => {
    const mine = Buffer.from('my own poster for the same video');
    fs.mkdirSync(thumbsB, { recursive: true });
    fs.writeFileSync(path.join(thumbsB, NAME), mine);

    await dataExport.applyImport({ filePath: zip, store, customThumbsDir: thumbsB, relaunch: () => {} });

    expect(fs.readFileSync(path.join(thumbsB, NAME)).equals(mine)).toBe(true);
    const entry = onDisk().settings.library.customThumbnails[VIDEO];
    expect(path.dirname(entry.imagePath)).toBe(thumbsB);
    expect(path.basename(entry.imagePath)).not.toBe(NAME);
    expect(fs.readFileSync(entry.imagePath).equals(POSTER)).toBe(true);
  });
});
