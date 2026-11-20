/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The tag store keys (DESIGN-video-options.md (e), 2026-11-18): their
// defaults, and that they survive a snapshot, a recovery, an export, an
// import (merge and overwrite) and the restore list's summary.
//
// The store runs on the REAL electron-conf (tests/unit/helpers), so "an
// existing install gets the defaults" is checked against the real file
// handling. Every path and tag is synthetic; every folder is a fresh temp dir.
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
const require_ = createRequire(import.meta.url);
const dataBackup = require_('../../electron/data-backup.js');
const dataExport = require_('../../electron/data-export.js');
const { mergeConfig } = dataExport;

const V = 'C:/Library/Clip One.mp4';
const W = 'C:/Library/Clip Two.mp4';
const OFFLINE = 'E:/Offline Drive/Not Scanned.mp4'; // a path not in the library here

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const record = (over = {}) => ({
  tags: ['the-handy'], topicId: 11, topicUrl: 'https://example.invalid/t/x/11', source: 'eroscripts', savedAt: 100, ...over,
});

/** A config as store.getAll() returns it, with the tag maps set. */
function tagConfig(library = {}) {
  return {
    settings: {
      library: {
        associations: {},
        userTags: { [V]: ['pov', 'cosplay'], [OFFLINE]: ['offline-tag'] },
        hiddenTags: { [V]: ['device:the-handy'] },
        scriptTags: { [V]: record() },
        tagSettings: { aliases: { bj: 'blowjob' }, hidden: ['content:len-40'], facetOverrides: { latex: 'content' } },
        showTagsOnCards: true,
        ...library,
      },
    },
    playlists: [],
    categories: [],
    videoCategories: {},
  };
}

const TAG_KEYS = ['userTags', 'hiddenTags', 'scriptTags', 'tagSettings', 'showTagsOnCards'];
const tagPart = (config) => Object.fromEntries(TAG_KEYS.map((k) => [k, config?.settings?.library?.[k]]));

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-tag-data-'));
  h.userData = dir;
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('store defaults: today\'s behaviour, on new and existing installs', () => {
  it('declares the new keys with "no tags" defaults', () => {
    const lib = store.DEFAULTS.settings.library;
    expect(lib.userTags).toEqual({});
    expect(lib.hiddenTags).toEqual({});
    expect(lib.tagSettings).toEqual({ aliases: {}, hidden: [], facetOverrides: {} });
    expect(lib.showTagsOnCards).toBe(false);
    expect(lib.scriptTags).toEqual({}); // unchanged
  });

  it('an existing config.json without them reads them as defaults, and keeps what it had', async () => {
    const old = {
      settings: { library: { scriptTags: { [V]: record() }, tagSettings: { aliases: { a: 'b' } } } },
      playlists: [], categories: [], videoCategories: {},
    };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(old));
    await store.initStore();
    const lib = store.getAll().settings.library;
    expect(lib.userTags).toEqual({});
    expect(lib.hiddenTags).toEqual({});
    expect(lib.showTagsOnCards).toBe(false);
    expect(lib.tagSettings).toEqual({ aliases: { a: 'b' }, hidden: [], facetOverrides: {} });
    expect(lib.scriptTags).toEqual({ [V]: record() });
  });
});

describe('computeSummary counts tags, so the restore list tells a before from an after (V58)', () => {
  it('tagAssignments counts every video→tag link of yours; eroscriptsLinks every post record', () => {
    const s = dataBackup.computeSummary(tagConfig());
    expect(s.tagAssignments).toBe(3);
    expect(s.eroscriptsLinks).toBe(1);
  });

  it('losing one tag from a video with two changes the summary', () => {
    const before = dataBackup.computeSummary(tagConfig());
    const after = dataBackup.computeSummary(tagConfig({ userTags: { [V]: ['pov'], [OFFLINE]: ['offline-tag'] } }));
    expect(after.tagAssignments).toBe(before.tagAssignments - 1);
  });

  it('damaged or missing maps count 0 and never throw', () => {
    for (const junk of [undefined, null, 'x', 5, ['a'], { [V]: 'pov', [W]: null }]) {
      const s = dataBackup.computeSummary(tagConfig({ userTags: junk, scriptTags: junk }));
      expect(s.tagAssignments).toBe(0);
      expect(s.eroscriptsLinks).toBe(0);
    }
    expect(dataBackup.computeSummary(tagConfig({ scriptTags: { [V]: record(), [W]: null, x: [] } })).eroscriptsLinks).toBe(1);
  });

  it('a manifest row from before these counts is recomputed once from its snapshot', async () => {
    const entry = await dataBackup.takeSnapshot({ userDataDir: dir, config: tagConfig(), trigger: dataBackup.TRIGGER.STARTUP });
    const { backupDir } = dataBackup.resolvePaths(dir);
    const manifest = await dataBackup.loadManifest(backupDir);
    // Yesterday's row: categoryAssignments is there, the tag counts are not.
    delete manifest.snapshots[0].summary.tagAssignments;
    delete manifest.snapshots[0].summary.eroscriptsLinks;
    expect(manifest.snapshots[0].summary.categoryAssignments).toBe(0);
    await dataBackup.saveManifest(backupDir, manifest);

    const listed = await dataBackup.loadManifest(backupDir);
    await dataBackup.backfillSummaries(backupDir, listed);
    expect(listed.snapshots[0].summary).toMatchObject({ tagAssignments: 3, eroscriptsLinks: 1 });
    const saved = await dataBackup.loadManifest(backupDir);
    expect(saved.snapshots.find((s) => s.filename === entry.filename).summary.tagAssignments).toBe(3);
  });
});

describe('snapshots and recovery keep the tag maps', () => {
  it('they are not on the blacklist: a snapshot holds them byte for byte', () => {
    const { payload } = dataBackup.buildSnapshot(tagConfig(), dataBackup.TRIGGER.MANUAL);
    expect(tagPart(payload.config)).toEqual(tagPart(tagConfig()));
    for (const p of dataBackup.BACKUP_BLACKLIST) {
      expect(TAG_KEYS.some((k) => p.endsWith(`.${k}`))).toBe(false);
    }
  });

  it('a corrupt config.json is recovered from the snapshot with every tag map', async () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(tagConfig()));
    await store.initStore();
    await dataBackup.takeSnapshot({ userDataDir: dir, config: store.getAll(), trigger: dataBackup.TRIGGER.STARTUP });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');

    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(tagPart(disk)).toEqual(tagPart(tagConfig()));
  });
});

describe('export and import keep the tag maps', () => {
  it('an export carries them, and Import Backup File puts them back after a loss', async () => {
    const zipPath = path.join(dir, 'tags.funsync-backup');
    expect((await dataExport.exportData(tagConfig(), zipPath)).success).toBe(true);
    const read = await dataExport.importData(zipPath, 'merge');
    expect(tagPart(read.config)).toEqual(tagPart(tagConfig()));

    // Since the export the user lost every tag map and added one tag.
    let live = tagConfig({ userTags: { [W]: ['later'] }, hiddenTags: {}, scriptTags: {}, tagSettings: { aliases: {}, hidden: [], facetOverrides: {} } });
    const fakeStore = { getAll: () => JSON.parse(JSON.stringify(live)), replaceData: (d) => { live = d; } };
    const res = await dataExport.applyImport({ filePath: zipPath, store: fakeStore, relaunch: () => {} });
    expect(res.success).toBe(true);
    expect(live.settings.library.userTags).toEqual({ [W]: ['later'], [V]: ['pov', 'cosplay'], [OFFLINE]: ['offline-tag'] });
    expect(live.settings.library.hiddenTags).toEqual({ [V]: ['device:the-handy'] });
    expect(live.settings.library.scriptTags).toEqual({ [V]: record() });
    expect(live.settings.library.tagSettings).toEqual(tagConfig().settings.library.tagSettings);
  });
});

describe('mergeConfig (merge): the tag rules', () => {
  const merge = (local, backup) => mergeConfig(deepFreeze(local), deepFreeze(backup), 'merge').settings.library;

  it('userTags and hiddenTags: union per path, this machine\'s order first; no path is dropped', () => {
    const lib = merge(
      tagConfig({ userTags: { [V]: ['pov', 'cosplay'], [OFFLINE]: ['offline-tag'] }, hiddenTags: { [V]: ['content:a'] } }),
      tagConfig({ userTags: { [V]: ['latex', 'pov'], [W]: ['backup-only'] }, hiddenTags: { [V]: ['content:b', 'content:a'], [W]: ['content:c'] } }),
    );
    expect(lib.userTags).toEqual({ [V]: ['pov', 'cosplay', 'latex'], [OFFLINE]: ['offline-tag'], [W]: ['backup-only'] });
    expect(lib.hiddenTags).toEqual({ [V]: ['content:a', 'content:b'], [W]: ['content:c'] });
  });

  it('a backup without the maps, or with them in the wrong shape, changes nothing here', () => {
    const local = tagConfig();
    for (const junk of [undefined, null, [], ['pov'], 'pov', 7]) {
      const backup = tagConfig({ userTags: junk, hiddenTags: junk, scriptTags: junk, tagSettings: junk });
      const lib = merge(local, backup);
      for (const k of ['userTags', 'hiddenTags', 'scriptTags', 'tagSettings']) {
        expect(lib[k]).toEqual(local.settings.library[k]);
      }
    }
    // No library block, or no settings at all, in the backup.
    expect(tagPart(mergeConfig(local, { settings: { player: {} } }, 'merge'))).toEqual(tagPart(local));
    expect(tagPart(mergeConfig(local, { playlists: [] }, 'merge'))).toEqual(tagPart(local));
  });

  it('a damaged entry is skipped on either side, never written over', () => {
    const lib = merge(
      tagConfig({ userTags: { [V]: 'hand-edited', [W]: ['ok'] } }),
      tagConfig({ userTags: { [V]: ['pov'], [W]: [null, { x: 1 }, 'new', 'ok'], [OFFLINE]: 'junk' } }),
    );
    expect(lib.userTags).toEqual({ [V]: 'hand-edited', [W]: ['ok', 'new'] });
  });

  it('this machine without any tag map takes the backup\'s, and the backup object is not written through', () => {
    const local = { settings: { player: { volume: 50 } }, playlists: [], categories: [], videoCategories: {} };
    const backup = deepFreeze(tagConfig());
    const merged = mergeConfig(local, backup, 'merge');
    expect(tagPart(merged)).toEqual(tagPart(backup));
    expect(merged.settings.library).not.toBe(backup.settings.library);
  });

  it('scriptTags: the newer record (fetchedAt, else savedAt) wins whole; a tie keeps this machine\'s', () => {
    const mineNew = record({ tags: ['osr2'], fetchedAt: 500, title: 'Mine' });
    const theirsOld = record({ tags: ['sr6', 'pov'], fetchedAt: 400, stale: true });
    const mineOld = record({ tags: ['a'], savedAt: 100 });
    const theirsNew = record({ tags: ['b'], savedAt: 50, fetchedAt: 300 });
    const tieMine = record({ tags: ['tie-mine'], savedAt: 9 });
    const tieTheirs = record({ tags: ['tie-theirs'], savedAt: 9, creator: 'x' });
    const lib = merge(
      tagConfig({ scriptTags: { [V]: mineNew, [W]: mineOld, tie: tieMine, [OFFLINE]: record({ tags: ['kept'] }) } }),
      tagConfig({ scriptTags: { [V]: theirsOld, [W]: theirsNew, tie: tieTheirs, added: record({ tags: ['new'] }), junk: 'x' } }),
    );
    // Whole records only: never the deep merge's mix of two posts' fields.
    expect(lib.scriptTags).toEqual({
      [V]: mineNew, [W]: theirsNew, tie: tieMine, [OFFLINE]: record({ tags: ['kept'] }), added: record({ tags: ['new'] }),
    });
  });

  it('tagSettings: aliases and facetOverrides union with this machine winning a clash; hidden union', () => {
    const lib = merge(
      tagConfig({ tagSettings: { aliases: { bj: 'blowjob', a: 'mine' }, hidden: ['content:x'], facetOverrides: { latex: 'content' } } }),
      tagConfig({ tagSettings: { aliases: { a: 'theirs', c: 'd' }, hidden: ['content:y', 'content:x'], facetOverrides: { latex: 'device', vac: 'device' } } }),
    );
    expect(lib.tagSettings).toEqual({
      aliases: { a: 'mine', c: 'd', bj: 'blowjob' },
      hidden: ['content:x', 'content:y'],
      facetOverrides: { latex: 'content', vac: 'device' },
    });
  });

  it('showTagsOnCards follows the other settings: the backup\'s value', () => {
    expect(merge(tagConfig({ showTagsOnCards: false }), tagConfig({ showTagsOnCards: true })).showTagsOnCards).toBe(true);
    expect(merge(tagConfig({ showTagsOnCards: true }), { settings: { library: {} } }).showTagsOnCards).toBe(true);
  });

  it('never writes to either input', () => {
    const local = deepFreeze(tagConfig());
    const backup = deepFreeze(tagConfig({ userTags: { [W]: ['x'] } }));
    expect(() => mergeConfig(local, backup, 'merge')).not.toThrow();
  });
});

describe('mergeConfig (overwrite): the backup replaces, except a tag map it does not have', () => {
  it('a backup with the maps replaces them, an empty map included', () => {
    const backup = tagConfig({ userTags: {}, hiddenTags: { [W]: ['content:z'] } });
    expect(tagPart(mergeConfig(tagConfig(), deepFreeze(backup), 'overwrite'))).toEqual(tagPart(backup));
  });

  it('a backup from before tags keeps this machine\'s maps (unknown is not "no tags")', () => {
    const local = tagConfig();
    const backup = deepFreeze({ settings: { library: { associations: { [W]: { single: 'C:/Library/Clip Two.funscript' } } } }, playlists: [] });
    const out = mergeConfig(local, backup, 'overwrite');
    for (const k of ['userTags', 'hiddenTags', 'scriptTags', 'tagSettings']) {
      expect(out.settings.library[k]).toEqual(local.settings.library[k]);
    }
    expect(out.settings.library.associations).toEqual(backup.settings.library.associations);
    expect(out.settings.library.showTagsOnCards).toBeUndefined(); // a display setting: replaced like the rest
    expect(out.playlists).toEqual([]);
    expect(backup.settings.library.userTags).toBeUndefined(); // not written through
  });
});
