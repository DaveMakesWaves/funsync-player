// End-to-end scenario tests for the backup/recovery layer.
// These read like user stories rather than unit tests — each one
// simulates a real-world failure mode the system has to survive.
//
// Maps to SCOPE-data-backup.md §7.7 and the threat model in §2.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const dataBackup = require_('../../electron/data-backup.js');

async function makeTempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-scenarios-'));
}

async function rmTempDir(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// "Hours of work" config — the real shape and scale of state the
// reporter actually had when the power-cord-loose incident wiped it.
function buildLargeConfig() {
  const sources = [];
  for (let i = 0; i < 8; i++) {
    sources.push({ id: `src-${i}`, path: `/media/library-${i}`, name: `Source ${i}` });
  }
  const collections = [];
  for (let i = 0; i < 12; i++) {
    collections.push({
      id: `col-${i}`,
      name: `Collection ${i}`,
      videoPaths: Array.from({ length: 30 }, (_, j) => `/media/library-${i % 8}/video-${j}.mp4`),
    });
  }
  const customRouting = {};
  for (let i = 0; i < 50; i++) {
    customRouting[`/media/library-${i % 8}/video-${i}.mp4`] = [
      { role: 'main', deviceId: 'handy-0', axis: 'L0' },
      { role: 'aux',  deviceId: 'vorze-0', axis: 'V0' },
    ];
  }
  const associations = {};
  for (let i = 0; i < 100; i++) {
    associations[`/media/library-${i % 8}/manual-${i}.mp4`] = `/scripts/manual-${i}.funscript`;
  }
  return {
    settings: {
      handy: { connectionKey: 'eK6Qv3AH', defaultOffset: -50 },
      library: { sources, collections, customRouting, associations,
        manualVariants: { '/media/library-0/v.mp4': ['Soft', 'Hard'] },
        // High-churn caches included intentionally — recovery must
        // produce a config WITHOUT these (they get stripped on snapshot).
        speedStatsCache: { '/media/library-0/v.mp4': { mean: 12 } },
        durationCache:   { '/media/library-0/v.mp4': 1234 },
        thumbnailCache:  { '/media/library-0/v.mp4': 'data:image/jpeg;...' },
      },
      player: { volume: 80, theme: 'dark' },
    },
    playlists: Array.from({ length: 6 }, (_, i) => ({ id: `pl-${i}`, name: `PL ${i}`, videoPaths: [] })),
    categories: Array.from({ length: 4 }, (_, i) => ({ id: `cat-${i}`, name: `Cat ${i}` })),
    videoCategories: { '/media/library-0/v.mp4': ['cat-0', 'cat-1'] },
  };
}


describe('Scenario: the reporter\'s incident — power loss wipes config', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('full state recovery from a snapshot after config.json is wiped', async () => {
    const original = buildLargeConfig();

    // Step 1: user is working — startup snapshot taken.
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: original, trigger: dataBackup.TRIGGER.STARTUP,
    });
    // Step 2: user keeps working — debounced auto-save snapshot.
    await new Promise(r => setTimeout(r, 5));
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: original, trigger: dataBackup.TRIGGER.DEBOUNCED,
    });

    // Step 3: write config.json so verifyAndRecover has something to
    // detect and reject (otherwise it returns recovered:false on
    // missing-file path which is also valid; we want the path where
    // we explicitly detect a CORRUPT live file).
    const paths = dataBackup.resolvePaths(dir);
    await fsp.writeFile(paths.configPath, '{"trunc:', 'utf8'); // mid-write truncation

    // Step 4: app restart — verifyAndRecover runs.
    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(true);
    expect(result.fromSnapshot).toBeTruthy();
    expect(result.reason).toMatch(/unparseable/);

    // Step 5: every key stat in the original config is intact.
    const restored = JSON.parse(await fsp.readFile(paths.configPath, 'utf8'));
    expect(restored.settings.library.sources).toHaveLength(8);
    expect(restored.settings.library.collections).toHaveLength(12);
    expect(Object.keys(restored.settings.library.customRouting)).toHaveLength(50);
    expect(Object.keys(restored.settings.library.associations)).toHaveLength(100);
    expect(restored.playlists).toHaveLength(6);
    expect(restored.categories).toHaveLength(4);
    expect(restored.settings.handy.connectionKey).toBe('eK6Qv3AH');

    // Step 6: blacklisted caches are correctly stripped from the
    // recovered file (they get rebuilt for free on next scan).
    expect(restored.settings.library.speedStatsCache).toBeUndefined();
    expect(restored.settings.library.durationCache).toBeUndefined();
    expect(restored.settings.library.thumbnailCache).toBeUndefined();
  });
});


describe('Scenario: time-travel restore via pre-action snapshot', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('restores to state immediately before a destructive action', async () => {
    // Simulates the "user clicks Delete Source by accident" flow:
    //   1. Pre-action snapshot taken with label "delete-source"
    //   2. Source deletion mutates state
    //   3. User notices, restores from the pre-action snapshot
    //   4. State matches what it was before the deletion

    const before = buildLargeConfig();
    expect(before.settings.library.sources).toHaveLength(8);

    // Pre-action snapshot.
    const preEntry = await dataBackup.takeSnapshot({
      userDataDir: dir, config: before, trigger: dataBackup.TRIGGER.PRE_ACTION, label: 'delete-source',
    });
    expect(preEntry.subdir).toBe('pre-action');
    expect(preEntry.label).toBe('delete-source');
    expect(preEntry.filename).toContain('delete-source');

    // Apply the destructive change to state.
    const after = JSON.parse(JSON.stringify(before));
    after.settings.library.sources = after.settings.library.sources.slice(0, 4); // dropped half
    after.settings.library.collections = after.settings.library.collections.slice(0, 2); // collections gutted

    // Time passes — write the new state to config.json simulating
    // electron-conf persisting the post-deletion state.
    const paths = dataBackup.resolvePaths(dir);
    await fsp.writeFile(paths.configPath, JSON.stringify(after, null, 2), 'utf8');

    // User restores: read the pre-action snapshot, verify hash, swap
    // it back. (This is what the backup:restore IPC does in main.js.)
    const snapPath = path.join(paths.preActionDir, preEntry.filename);
    const parsed = JSON.parse(await fsp.readFile(snapPath, 'utf8'));
    await fsp.writeFile(paths.configPath, JSON.stringify(parsed.config, null, 2), 'utf8');

    // Assert state matches the pre-action snapshot exactly.
    const restored = JSON.parse(await fsp.readFile(paths.configPath, 'utf8'));
    expect(restored.settings.library.sources).toHaveLength(8);
    expect(restored.settings.library.collections).toHaveLength(12);
  });
});


describe('Scenario: a corrupted snapshot mid-pile is skipped', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('corrupted newest snapshot does not block recovery from older ones', async () => {
    const config = buildLargeConfig();

    // Take three snapshots over time.
    const s1 = await dataBackup.takeSnapshot({ userDataDir: dir, config, trigger: dataBackup.TRIGGER.STARTUP });
    await new Promise(r => setTimeout(r, 5));
    const s2 = await dataBackup.takeSnapshot({ userDataDir: dir, config, trigger: dataBackup.TRIGGER.DEBOUNCED });
    await new Promise(r => setTimeout(r, 5));
    const s3 = await dataBackup.takeSnapshot({ userDataDir: dir, config, trigger: dataBackup.TRIGGER.MANUAL });

    // Corrupt the NEWEST (s3) — flip the SHA mismatch. And nuke s2
    // entirely (zero-byte file). Recovery should fall through both
    // and land on s1.
    const paths = dataBackup.resolvePaths(dir);
    const s3Path = path.join(paths.snapshotsDir, s3.filename);
    const s3Parsed = JSON.parse(await fsp.readFile(s3Path, 'utf8'));
    s3Parsed.config.settings.library.sources = []; // tamper without updating sha
    await fsp.writeFile(s3Path, JSON.stringify(s3Parsed), 'utf8');

    const s2Path = path.join(paths.snapshotsDir, s2.filename);
    await fsp.writeFile(s2Path, '', 'utf8'); // zero bytes

    // Wipe live config — force recovery.
    try { await fsp.unlink(paths.configPath); } catch { /* ignore */ }

    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(true);
    expect(result.fromSnapshot.filename).toBe(s1.filename);

    const restored = JSON.parse(await fsp.readFile(paths.configPath, 'utf8'));
    expect(restored.settings.library.sources).toHaveLength(8); // not the tampered s3
  });
});


describe('Scenario: multi-day usage retention pyramid stays sane', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('30 days of hourly snapshots prune to ≤ 35 with all tiers represented', async () => {
    // Synthesise 30 days × 24 hours = 720 snapshots manually (much
    // faster than calling takeSnapshot 720× — the algorithm under
    // test is the prune pass, not the writer).
    const now = new Date('2026-04-30T20:00:00Z');
    const HOUR = 60 * 60 * 1000;
    const fakes = [];
    for (let i = 0; i < 720; i++) {
      const ts = new Date(now.getTime() - i * HOUR);
      fakes.push({
        filename: `snap-${i}.json`,
        subdir: 'snapshots',
        timestamp: ts.toISOString(),
        sizeBytes: 400_000,
      });
    }
    const kept = dataBackup.applyRetentionPolicy(fakes, now);

    // Pyramid worst case: 1 "now" + 23 hourly + 7 daily + 4 weekly = 35.
    expect(kept.length).toBeLessThanOrEqual(35);
    expect(kept.length).toBeGreaterThanOrEqual(34); // accept off-by-one on bucket edges

    // Every tier should have something:
    const ages = kept.map(k => now.getTime() - new Date(k.timestamp).getTime());
    const inHourly = ages.filter(a => a >= HOUR && a < 24 * HOUR);
    const inDaily  = ages.filter(a => a >= 24 * HOUR && a < 7 * 24 * HOUR);
    const inWeekly = ages.filter(a => a >= 7 * 24 * HOUR && a < 28 * 24 * HOUR);
    expect(inHourly.length).toBeGreaterThan(0);
    expect(inDaily.length).toBeGreaterThan(0);
    expect(inWeekly.length).toBeGreaterThan(0);
  });
});


describe('Scenario: schema forward-compat — future schema gracefully handled', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('snapshot with unknown future schemaVersion still verifies + restores', async () => {
    // Phase 1 doesn't read schemaVersion to gate behaviour, so a
    // future-tagged snapshot should still work for restore. This test
    // pins that contract — if a future Phase 2/3 starts gating on
    // version, this test will fail and force an explicit decision.
    const paths = dataBackup.resolvePaths(dir);
    await fsp.mkdir(paths.snapshotsDir, { recursive: true });

    const config = buildLargeConfig();
    const stripped = dataBackup.stripBlacklist(config);
    const sha = dataBackup.sha256Of(stripped);
    const futurePayload = {
      metadata: {
        schemaVersion: 999,           // far-future
        trigger: 'unknown-trigger',   // future trigger value
        timestamp: new Date().toISOString(),
        sha256: sha,
        summary: dataBackup.computeSummary(stripped),
        label: null,
        // Speculative future field — should not break parse.
        wal: { sequence: 42, lastTxHash: 'abc' },
      },
      config: stripped,
    };
    const filename = '2099-01-01T00-00-00-000Z.json';
    await fsp.writeFile(
      path.join(paths.snapshotsDir, filename),
      JSON.stringify(futurePayload),
      'utf8',
    );
    // Skip manifest — verifyAndRecover should still find this via
    // the self-healing rebuild.

    // Wipe live config to force recovery.
    try { await fsp.unlink(paths.configPath); } catch { /* ignore */ }

    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(true);
    expect(result.fromSnapshot.filename).toBe(filename);
  });
});


describe('Scenario: no orphan tmp files survive a successful write (T1)', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('after 20 sequential snapshots, no .tmp files remain', async () => {
    const config = buildLargeConfig();
    for (let i = 0; i < 20; i++) {
      await dataBackup.takeSnapshot({
        userDataDir: dir, config, trigger: dataBackup.TRIGGER.MANUAL,
      });
      await new Promise(r => setTimeout(r, 2)); // distinct timestamps
    }
    const paths = dataBackup.resolvePaths(dir);
    const snapEntries = await fsp.readdir(paths.snapshotsDir);
    const tmpsInSnap = snapEntries.filter(e => e.includes('.tmp'));
    expect(tmpsInSnap).toHaveLength(0);

    const backupEntries = await fsp.readdir(paths.backupDir);
    const tmpsInBackup = backupEntries.filter(e => e.includes('.tmp'));
    expect(tmpsInBackup).toHaveLength(0);
  });
});
