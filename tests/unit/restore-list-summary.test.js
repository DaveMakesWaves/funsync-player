// Restore From Backup must let the user find the snapshot that still has
// the lost data (V58).
//
// jsdom on purpose (no node docblock): settings-panel.js imports i18n.js,
// which branches on `typeof window`. See notes/CLAUDE.md "Test environments".
//
// The tester lost category assignments (V01), opened Restore From Backup and
// got rows like "16 KB · 3 sources, 2 playlists" vs "15 KB · 3 sources, 2
// playlists": the summary never counted category assignments at all, and the
// association and category counts it did compute were never shown. So the
// snapshot from before the loss and the one after it read the same.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _setBundlesForTests, _resetForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

const require_ = createRequire(import.meta.url);
const dataBackup = require_('../../electron/data-backup.js');
const en = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const format = (summary) => SettingsPanel.prototype._formatSnapshotSummary.call(null, summary);

function libraryConfig({ withAssignments }) {
  return {
    settings: {
      library: {
        sources: [{ id: 's1', path: 'D:\\lib' }],
        associations: { 'D:\\lib\\a.mp4': { single: 'D:\\lib\\a.funscript' } },
      },
    },
    playlists: [{ id: 'p1', name: 'E Test List', videoPaths: [] }],
    categories: [{ id: 'c1', name: 'E Cat', color: '#3498db' }],
    videoCategories: withAssignments
      ? { 'D:\\lib\\a.mp4': ['c1'], 'D:\\lib\\b.mp4': ['c1'] }
      : {},
  };
}

describe('restore list rows tell a pre-loss snapshot from a post-loss one', () => {
  beforeEach(() => { _setBundlesForTests('en', en, en); });
  afterEach(() => { _resetForTests(); });

  it('a V01-style loss (only the category assignments gone) changes the row', () => {
    const before = format(dataBackup.computeSummary(libraryConfig({ withAssignments: true })));
    const after = format(dataBackup.computeSummary(libraryConfig({ withAssignments: false })));
    expect(before).not.toBe(after);
    expect(before).toContain('2 category assignments');
    expect(after).not.toContain('category assignment');
  });

  it('shows categories and associations, which were computed but never rendered', () => {
    const row = format(dataBackup.computeSummary(libraryConfig({ withAssignments: true })));
    expect(row).toContain('1 category');
    expect(row).toContain('1 association');
    expect(row).toContain('1 source');
    expect(row).toContain('1 playlist');
  });

  it('still says "empty" for an empty snapshot', () => {
    expect(format({})).toBe(en.settingsPanel.data.summaryEmpty);
    expect(format(undefined)).toBe(en.settingsPanel.data.summaryEmpty);
  });
});

// The tags you add and the EroScripts post links (video options, 2026-11-18)
// are counted by computeSummary (tagAssignments, eroscriptsLinks); the row
// must show them, or a snapshot from before a tag loss reads the same as one
// from after it (the V58 rule again).
describe('restore list rows count your tags and EroScripts post links', () => {
  const VIDEO_A = '/lib/a.mp4';
  const VIDEO_B = '/lib/b.mp4';
  const RECORD = { tags: [{ id: 1, name: 'pov' }], topicId: 7, source: 'eroscripts', savedAt: 1 };
  const tagConfig = ({ userTags = {}, scriptTags = {} } = {}) => ({
    settings: { library: { sources: [{ id: 's1', path: '/lib' }], userTags, scriptTags } },
  });

  beforeEach(() => { _setBundlesForTests('en', en, en); });
  afterEach(() => { _resetForTests(); });

  it('losing one tag of a video that has two changes the row', () => {
    const before = format(dataBackup.computeSummary(tagConfig({ userTags: { [VIDEO_A]: ['pov', 'vr'], [VIDEO_B]: ['solo'] } })));
    const after = format(dataBackup.computeSummary(tagConfig({ userTags: { [VIDEO_A]: ['pov'], [VIDEO_B]: ['solo'] } })));
    expect(before).toContain('3 tags you added');
    expect(after).toContain('2 tags you added');
    expect(before).not.toBe(after);
  });

  it('shows the EroScripts post links, and losing one changes the row', () => {
    const before = format(dataBackup.computeSummary(tagConfig({ scriptTags: { [VIDEO_A]: RECORD, [VIDEO_B]: RECORD } })));
    const after = format(dataBackup.computeSummary(tagConfig({ scriptTags: { [VIDEO_A]: RECORD } })));
    expect(before).toContain('2 EroScripts post links');
    expect(after).toContain('1 EroScripts post link');
    expect(after).not.toContain('links');
    expect(before).not.toBe(after);
  });

  it('a row from before tags (no such counts) and a row with none say nothing about tags', () => {
    const old = format({ sources: 1 });
    const none = format(dataBackup.computeSummary(tagConfig()));
    for (const row of [old, none]) {
      expect(row).toBe('1 source');
      expect(row).not.toMatch(/tag|EroScripts/);
    }
  });

  it('is in the active language', () => {
    const de = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
    _setBundlesForTests('de', de, en);
    const row = format({ tagAssignments: 2, eroscriptsLinks: 1 });
    expect(row).toBe('2 selbst hinzugefügte Tags, 1 EroScripts-Beitragslink');
  });
});

describe('backfillSummaries gives snapshots from older versions the new counts', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-restore-list-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('recomputes a summary that lacks categoryAssignments and saves it once', async () => {
    const entry = await dataBackup.takeSnapshot({
      userDataDir: dir, config: libraryConfig({ withAssignments: true }), trigger: dataBackup.TRIGGER.STARTUP,
    });
    const { backupDir } = dataBackup.resolvePaths(dir);
    // Make it look like a v0.9.2 manifest row: no categoryAssignments.
    const manifest = await dataBackup.loadManifest(backupDir);
    delete manifest.snapshots[0].summary.categoryAssignments;
    await dataBackup.saveManifest(backupDir, manifest);

    const listed = await dataBackup.loadManifest(backupDir);
    await dataBackup.backfillSummaries(backupDir, listed);
    expect(listed.snapshots[0].summary.categoryAssignments).toBe(2);

    const saved = await dataBackup.loadManifest(backupDir);
    expect(saved.snapshots.find((s) => s.filename === entry.filename).summary.categoryAssignments).toBe(2);
  });

  it('leaves a row alone when its snapshot file cannot be read', async () => {
    const entry = await dataBackup.takeSnapshot({
      userDataDir: dir, config: libraryConfig({ withAssignments: true }), trigger: dataBackup.TRIGGER.STARTUP,
    });
    const { backupDir, snapshotsDir } = dataBackup.resolvePaths(dir);
    const manifest = await dataBackup.loadManifest(backupDir);
    delete manifest.snapshots[0].summary.categoryAssignments;
    await dataBackup.saveManifest(backupDir, manifest);
    fs.writeFileSync(path.join(snapshotsDir, entry.filename), '{ corrupt');

    const listed = await dataBackup.loadManifest(backupDir);
    await dataBackup.backfillSummaries(backupDir, listed);
    expect(listed.snapshots[0].summary.categoryAssignments).toBeUndefined();
    expect(listed.snapshots[0].summary.playlists).toBe(1);
  });

  it('does not drop a snapshot that was added while it was reading', async () => {
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: libraryConfig({ withAssignments: true }), trigger: dataBackup.TRIGGER.STARTUP,
    });
    const { backupDir } = dataBackup.resolvePaths(dir);
    const stale = await dataBackup.loadManifest(backupDir);
    delete stale.snapshots[0].summary.categoryAssignments;
    await dataBackup.saveManifest(backupDir, stale);
    const listed = await dataBackup.loadManifest(backupDir);

    // A debounced snapshot lands after the list was loaded.
    await new Promise((r) => setTimeout(r, 5));
    const late = await dataBackup.takeSnapshot({
      userDataDir: dir, config: libraryConfig({ withAssignments: false }), trigger: dataBackup.TRIGGER.DEBOUNCED,
    });

    await dataBackup.backfillSummaries(backupDir, listed);
    const saved = await dataBackup.loadManifest(backupDir);
    expect(saved.snapshots.map((s) => s.filename)).toContain(late.filename);
    expect(saved.snapshots).toHaveLength(2);
  });
});
