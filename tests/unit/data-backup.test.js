// Tests for electron/data-backup.js — Phase 1 pure functions + core
// filesystem ops. Maps to threats T1, T2, T3, T8, T13, T14, T15, T18,
// T19 in SCOPE-data-backup.md §2 (the rest land in their own dedicated
// test files later in the phase).
//
// Pure-function tests run fast and deterministically. Filesystem tests
// use a per-test temp directory so they're hermetic and parallel-safe.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const dataBackup = require_('../../electron/data-backup.js');

// === Helpers ==============================================================

async function makeTempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-backup-test-'));
  return dir;
}

async function rmTempDir(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function fakeConfig() {
  return {
    settings: {
      library: {
        sources: [{ id: 'a', path: '/x' }, { id: 'b', path: '/y' }],
        collections: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
        associations: { '/x/v.mp4': 'script.funscript' },
        manualVariants: { '/x/v.mp4': ['variant1'] },
        customRouting: { dev0: 'L0', dev1: 'R0' },
        speedStatsCache: { '/x/v.mp4': { mean: 12 } }, // BLACKLISTED
        durationCache: { '/x/v.mp4': 1234 },           // BLACKLISTED
        thumbnailCache: { '/x/v.mp4': 'data:...' },    // BLACKLISTED
      },
      handy: { connectionKey: 'eK6Qv3AH' },
    },
    playlists: [{ id: 'p1' }, { id: 'p2' }],
    categories: [{ id: 'cat1' }],
  };
}


// === Pure functions =======================================================

describe('stripBlacklist (T18 + T19)', () => {
  it('removes speedStatsCache, durationCache, thumbnailCache', () => {
    const out = dataBackup.stripBlacklist(fakeConfig());
    expect(out.settings.library.speedStatsCache).toBeUndefined();
    expect(out.settings.library.durationCache).toBeUndefined();
    expect(out.settings.library.thumbnailCache).toBeUndefined();
  });

  it('preserves all non-blacklisted fields', () => {
    const out = dataBackup.stripBlacklist(fakeConfig());
    expect(out.settings.library.sources).toHaveLength(2);
    expect(out.settings.library.collections).toHaveLength(3);
    expect(out.settings.library.customRouting).toEqual({ dev0: 'L0', dev1: 'R0' });
    expect(out.playlists).toHaveLength(2);
    expect(out.categories).toHaveLength(1);
  });

  it('does not mutate the input', () => {
    const cfg = fakeConfig();
    dataBackup.stripBlacklist(cfg);
    expect(cfg.settings.library.speedStatsCache).toBeDefined();
  });

  it('handles missing nested fields gracefully', () => {
    expect(dataBackup.stripBlacklist({})).toEqual({});
    expect(dataBackup.stripBlacklist(null)).toBeNull();
    expect(dataBackup.stripBlacklist({ settings: null })).toEqual({ settings: null });
  });

  it('blacklist contains exactly the expected paths (regression pin)', () => {
    expect(dataBackup.BACKUP_BLACKLIST).toEqual([
      'settings.library.speedStatsCache',
      'settings.library.durationCache',
      'settings.library.thumbnailCache',
    ]);
  });
});

describe('sha256Of', () => {
  it('produces deterministic 64-char hex digests', () => {
    const a = dataBackup.sha256Of({ a: 1, b: 2 });
    const b = dataBackup.sha256Of({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('different content produces different hashes', () => {
    const a = dataBackup.sha256Of({ x: 1 });
    const b = dataBackup.sha256Of({ x: 2 });
    expect(a).not.toBe(b);
  });
});

describe('computeSummary', () => {
  it('counts collections, sources, playlists, categories, routings, assocs, variants', () => {
    const s = dataBackup.computeSummary(fakeConfig());
    expect(s.sources).toBe(2);
    expect(s.collections).toBe(3);
    expect(s.playlists).toBe(2);
    expect(s.categories).toBe(1);
    expect(s.customRoutings).toBe(2);
    expect(s.manualAssociations).toBe(1);
    expect(s.manualVariants).toBe(1);
  });

  it('handles empty config', () => {
    const s = dataBackup.computeSummary({});
    expect(s).toEqual({
      sources: 0, collections: 0, playlists: 0, categories: 0,
      customRoutings: 0, manualAssociations: 0, manualVariants: 0,
    });
  });
});

describe('buildSnapshot', () => {
  it('produces a Windows-safe sortable filename', () => {
    const { filename } = dataBackup.buildSnapshot(
      fakeConfig(), dataBackup.TRIGGER.STARTUP,
      { now: new Date('2026-04-30T14:22:08.412Z') }
    );
    expect(filename).toBe('2026-04-30T14-22-08-412Z.json');
    // No `:` (Windows-illegal) anywhere in the name.
    expect(filename).not.toMatch(/:/);
    // Sortable lexically — first 4 chars are year.
    expect(filename.slice(0, 4)).toBe('2026');
  });

  it('appends label suffix for pre-action snapshots', () => {
    const { filename } = dataBackup.buildSnapshot(
      fakeConfig(), dataBackup.TRIGGER.PRE_ACTION,
      { label: 'reset-defaults', now: new Date('2026-04-30T14:22:08.412Z') }
    );
    expect(filename).toBe('2026-04-30T14-22-08-412Z-reset-defaults.json');
  });

  it('embeds metadata + stripped config in payload', () => {
    const { payload } = dataBackup.buildSnapshot(
      fakeConfig(), dataBackup.TRIGGER.STARTUP
    );
    expect(payload.metadata.schemaVersion).toBe(dataBackup.SCHEMA_VERSION);
    expect(payload.metadata.trigger).toBe('startup');
    expect(payload.metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.metadata.summary.sources).toBe(2);
    expect(payload.config.settings.library.speedStatsCache).toBeUndefined();
    expect(payload.config.settings.library.sources).toHaveLength(2);
  });

  it('hash matches the post-strip config bytes (T3 detection precondition)', () => {
    const { payload } = dataBackup.buildSnapshot(
      fakeConfig(), dataBackup.TRIGGER.STARTUP
    );
    const expected = dataBackup.sha256Of(payload.config);
    expect(payload.metadata.sha256).toBe(expected);
  });
});

describe('applyRetentionPolicy', () => {
  function makeSnap(timestamp, subdir = 'snapshots', extra = {}) {
    return { filename: `${timestamp}.json`, subdir, timestamp, ...extra };
  }

  it('returns empty for empty input', () => {
    expect(dataBackup.applyRetentionPolicy([])).toEqual([]);
  });

  it('keeps all of one bucket per type when input is sparse', () => {
    const now = new Date('2026-04-30T20:00:00Z');
    // Just 5 snapshots, well under any cap
    const fakes = [
      makeSnap('2026-04-30T19:30:00Z'),  // < 1h "now"
      makeSnap('2026-04-30T16:00:00Z'),  // hourly
      makeSnap('2026-04-29T20:00:00Z'),  // daily (1d)
      makeSnap('2026-04-25T20:00:00Z'),  // weekly (5d still daily? — let's see)
      makeSnap('2026-04-15T20:00:00Z'),  // weekly (15d)
    ];
    const kept = dataBackup.applyRetentionPolicy(fakes, now);
    expect(kept).toHaveLength(5);
  });

  it('one-per-hour-bucket dedupe in hourly tier', () => {
    const now = new Date('2026-04-30T20:00:00Z');
    // Three snapshots all in the same hour bucket (hour 18) should
    // collapse to one. Add three other-hour entries (17, 16, 15) so
    // the kept set lands above the floor-of-3 invariant — otherwise
    // the floor would bypass dedup and keep all six.
    const fakes = [
      makeSnap('2026-04-30T18:55:00Z'),
      makeSnap('2026-04-30T18:30:00Z'),
      makeSnap('2026-04-30T18:05:00Z'),
      makeSnap('2026-04-30T17:00:00Z'),
      makeSnap('2026-04-30T16:00:00Z'),
      makeSnap('2026-04-30T15:00:00Z'),
    ];
    const kept = dataBackup.applyRetentionPolicy(fakes, now);
    expect(kept).toHaveLength(4); // 1 from hour-18 + 17 + 16 + 15
    const hour18 = kept.filter(s => s.timestamp.startsWith('2026-04-30T18:'));
    expect(hour18).toHaveLength(1);
    // Should be the most recent of the three (newest first sort).
    expect(hour18[0].timestamp).toBe('2026-04-30T18:55:00Z');
  });

  it('drops snapshots beyond 28 days', () => {
    const now = new Date('2026-04-30T20:00:00Z');
    // Three recent snapshots (so we're above the floor-of-3) plus one
    // ancient — the ancient one should drop.
    const fakes = [
      makeSnap('2026-04-30T19:30:00Z'),  // <1h "now"
      makeSnap('2026-04-30T18:00:00Z'),  // hourly bucket
      makeSnap('2026-04-30T17:00:00Z'),  // hourly bucket
      makeSnap('2026-02-01T20:00:00Z'),  // 88 days old — drop
    ];
    const kept = dataBackup.applyRetentionPolicy(fakes, now);
    expect(kept).toHaveLength(3);
    expect(kept.find(s => s.timestamp === '2026-02-01T20:00:00Z')).toBeUndefined();
  });

  it('1500 hourly snapshots over 62 days yields 35 kept (1+23+7+4)', () => {
    const now = new Date('2026-04-30T20:00:00Z');
    const fakes = [];
    for (let i = 0; i < 1500; i++) {
      const ts = new Date(now.getTime() - i * 3_600_000);
      fakes.push(makeSnap(ts.toISOString()));
    }
    const kept = dataBackup.applyRetentionPolicy(fakes, now);
    // 1 "now" + 23 hourly buckets + 7 daily + 4 weekly = 35
    expect(kept).toHaveLength(35);
  });

  it('keeps pre-action snapshots from last 30 days, drops older', () => {
    const now = new Date('2026-04-30T20:00:00Z');
    const fakes = [
      makeSnap('2026-04-29T20:00:00Z', 'pre-action', { label: 'reset' }),
      makeSnap('2026-04-15T20:00:00Z', 'pre-action', { label: 'delete-source' }),
      makeSnap('2026-03-01T20:00:00Z', 'pre-action', { label: 'old' }), // 60d
    ];
    const kept = dataBackup.applyRetentionPolicy(fakes, now);
    const labels = kept.map(s => s.label).sort();
    expect(labels).toEqual(['delete-source', 'reset']);
  });

  it('floor-of-3 invariant: skips prune if it would leave <3', () => {
    const now = new Date('2026-04-30T20:00:00Z');
    // Two ancient snapshots; without floor they'd both get dropped
    const fakes = [
      makeSnap('2026-01-01T00:00:00Z'),
      makeSnap('2025-06-01T00:00:00Z'),
    ];
    const kept = dataBackup.applyRetentionPolicy(fakes, now);
    // Floor activates: 0 would be kept, but we have 2 — keep both
    expect(kept).toHaveLength(2);
  });

  it('keeps future-dated snapshots (clock-skew paranoia)', () => {
    const now = new Date('2026-04-30T20:00:00Z');
    const fakes = [
      makeSnap('2026-04-30T19:30:00Z'),
      makeSnap('2027-01-01T00:00:00Z'),  // future-dated
    ];
    const kept = dataBackup.applyRetentionPolicy(fakes, now);
    expect(kept).toHaveLength(2);
  });
});


// === Filesystem ops (use a temp dir per test) ============================

describe('takeSnapshot + loadManifest (filesystem integration)', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('writes a snapshot file and updates the manifest', async () => {
    const entry = await dataBackup.takeSnapshot({
      userDataDir: dir,
      config: fakeConfig(),
      trigger: dataBackup.TRIGGER.STARTUP,
    });
    expect(entry).toBeTruthy();
    expect(entry.subdir).toBe('snapshots');
    expect(entry.summary.sources).toBe(2);

    const paths = dataBackup.resolvePaths(dir);
    const filePath = path.join(paths.snapshotsDir, entry.filename);
    const exists = await fsp.stat(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const manifest = await dataBackup.loadManifest(paths.backupDir);
    expect(manifest.snapshots).toHaveLength(1);
    expect(manifest.snapshots[0].filename).toBe(entry.filename);
  });

  it('pre-action snapshots land in pre-action subdir', async () => {
    const entry = await dataBackup.takeSnapshot({
      userDataDir: dir,
      config: fakeConfig(),
      trigger: dataBackup.TRIGGER.PRE_ACTION,
      label: 'reset-defaults',
    });
    expect(entry.subdir).toBe('pre-action');
    expect(entry.label).toBe('reset-defaults');
  });

  it('atomic write leaves no .tmp behind on success (T1)', async () => {
    await dataBackup.takeSnapshot({
      userDataDir: dir,
      config: fakeConfig(),
      trigger: dataBackup.TRIGGER.STARTUP,
    });
    const paths = dataBackup.resolvePaths(dir);
    const entries = await fsp.readdir(paths.snapshotsDir);
    const tmps = entries.filter(e => e.includes('.tmp'));
    expect(tmps).toHaveLength(0);
  });
});

describe('loadManifest self-healing (T13)', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('rebuilds from filesystem when index.json is missing', async () => {
    // Take 2 snapshots normally, then nuke the index.
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.STARTUP,
    });
    await new Promise(r => setTimeout(r, 5)); // ensure distinct timestamp
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.MANUAL,
    });

    const paths = dataBackup.resolvePaths(dir);
    await fsp.unlink(paths.manifestPath);

    const manifest = await dataBackup.loadManifest(paths.backupDir);
    expect(manifest.snapshots).toHaveLength(2);
  });

  it('rebuilds from filesystem when index.json is corrupt', async () => {
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.STARTUP,
    });
    const paths = dataBackup.resolvePaths(dir);
    await fsp.writeFile(paths.manifestPath, 'not json {{{', 'utf8');

    const manifest = await dataBackup.loadManifest(paths.backupDir);
    expect(manifest.snapshots).toHaveLength(1);
  });

  it('skips individual corrupt snapshot files during rebuild', async () => {
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.STARTUP,
    });
    const paths = dataBackup.resolvePaths(dir);
    // Plant a malformed file alongside the good one
    await fsp.writeFile(
      path.join(paths.snapshotsDir, 'corrupt.json'),
      'garbage', 'utf8'
    );
    await fsp.unlink(paths.manifestPath);

    const manifest = await dataBackup.loadManifest(paths.backupDir);
    expect(manifest.snapshots).toHaveLength(1); // good one kept; corrupt skipped
  });
});

describe('verifyAndRecover (T2 + T3 + T8)', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('returns recovered=false when config.json is healthy', async () => {
    const paths = dataBackup.resolvePaths(dir);
    await fsp.writeFile(paths.configPath, JSON.stringify(fakeConfig()), 'utf8');
    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(false);
  });

  it('recovers from latest snapshot when config.json is missing', async () => {
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.STARTUP,
    });
    // No config.json on disk
    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(true);
    expect(result.fromSnapshot).toBeTruthy();
    expect(result.reason).toContain('missing');

    // Verify config.json was written with snapshot's content
    const paths = dataBackup.resolvePaths(dir);
    const restored = JSON.parse(await fsp.readFile(paths.configPath, 'utf8'));
    expect(restored.settings.library.sources).toHaveLength(2);
  });

  it('recovers when config.json is unparseable (T2)', async () => {
    const paths = dataBackup.resolvePaths(dir);
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.STARTUP,
    });
    await fsp.writeFile(paths.configPath, '{ "trunc', 'utf8'); // mid-write truncation

    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(true);
    expect(result.reason).toContain('unparseable');
  });

  it('recovers when config.json is empty (0 bytes)', async () => {
    const paths = dataBackup.resolvePaths(dir);
    await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.STARTUP,
    });
    await fsp.writeFile(paths.configPath, '', 'utf8');

    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(true);
    expect(result.reason).toContain('empty');
  });

  it('skips snapshots with bad SHA-256 and tries the next (T3 + T15)', async () => {
    // Take 2 snapshots, corrupt the newer one's hash, verify recovery
    // falls through to the older one.
    const a = await dataBackup.takeSnapshot({
      userDataDir: dir, config: fakeConfig(), trigger: dataBackup.TRIGGER.STARTUP,
    });
    await new Promise(r => setTimeout(r, 5));
    const b = await dataBackup.takeSnapshot({
      userDataDir: dir, config: { ...fakeConfig(), playlists: [{ id: 'newer' }] },
      trigger: dataBackup.TRIGGER.MANUAL,
    });

    // Corrupt b's body so its SHA mismatches
    const paths = dataBackup.resolvePaths(dir);
    const bPath = path.join(paths.snapshotsDir, b.filename);
    const parsed = JSON.parse(await fsp.readFile(bPath, 'utf8'));
    parsed.config.playlists = [{ id: 'tampered' }];
    await fsp.writeFile(bPath, JSON.stringify(parsed), 'utf8');

    // Wipe live config and recover
    try { await fsp.unlink(paths.configPath); } catch { /* ok */ }
    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });

    expect(result.recovered).toBe(true);
    // Should have fallen through to snapshot `a`, not the tampered `b`
    expect(result.fromSnapshot.filename).toBe(a.filename);
    const restored = JSON.parse(await fsp.readFile(paths.configPath, 'utf8'));
    expect(restored.playlists.find(p => p.id === 'tampered')).toBeUndefined();
  });

  it('falls back when no valid snapshot exists', async () => {
    // No snapshots, no config — fresh-machine scenario.
    const result = await dataBackup.verifyAndRecover({ userDataDir: dir });
    expect(result.recovered).toBe(false);
    expect(result.fellBack).toBe(true);
  });
});

describe('pruneOld (T14 floor invariant)', () => {
  let dir;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rmTempDir(dir); });

  it('deletes the snapshots no longer in the kept set', async () => {
    // Create 5 same-hour-bucket snapshots (dedupe to 1) plus 3
    // distinct-hour snapshots that survive — total kept = 4, above
    // the floor-of-3 invariant so the prune actually fires. Use a
    // fixed `now` so the test is deterministic regardless of when it
    // runs (hour-bucket math against Date.now() can flake near
    // the top of an hour).
    const paths = dataBackup.resolvePaths(dir);
    const subdir = path.join(paths.backupDir, 'snapshots');
    await fsp.mkdir(subdir, { recursive: true });
    const now = new Date('2026-04-30T20:00:00Z');

    // 5 snapshots all in the 17:00 hour bucket (1-min spacing)
    for (let i = 0; i < 5; i++) {
      const ts = new Date(`2026-04-30T17:${String(10 + i).padStart(2, '0')}:00Z`);
      const { payload, filename } = dataBackup.buildSnapshot(
        fakeConfig(), dataBackup.TRIGGER.STARTUP, { now: ts }
      );
      await fsp.writeFile(path.join(subdir, filename), JSON.stringify(payload), 'utf8');
    }
    // 3 distinct-hour snapshots: 14:00, 15:00, 16:00
    for (let h = 14; h <= 16; h++) {
      const ts = new Date(`2026-04-30T${String(h).padStart(2, '0')}:00:00Z`);
      const { payload, filename } = dataBackup.buildSnapshot(
        fakeConfig(), dataBackup.TRIGGER.STARTUP, { now: ts }
      );
      await fsp.writeFile(path.join(subdir, filename), JSON.stringify(payload), 'utf8');
    }
    // Build manifest from the filesystem
    await dataBackup.saveManifest(
      paths.backupDir,
      await dataBackup.rebuildManifestFromFs(paths.backupDir)
    );

    const result = await dataBackup.pruneOld({ userDataDir: dir, now });
    expect(result.kept).toBe(4);    // 1 dedup of hour-17 + 14 + 15 + 16
    expect(result.deleted).toBe(4); // the 4 redundant hour-17 entries

    const remaining = await fsp.readdir(path.join(paths.backupDir, 'snapshots'));
    expect(remaining).toHaveLength(4);
  });

  it('does not delete when floor would be violated', async () => {
    // 2 ancient snapshots that would both fall outside retention.
    // Floor invariant: never leave fewer than 3, so keep both.
    const paths = dataBackup.resolvePaths(dir);
    const subdir = path.join(paths.backupDir, 'snapshots');
    await fsp.mkdir(subdir, { recursive: true });

    const ancient1 = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const ancient2 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    for (const ts of [ancient1, ancient2]) {
      const { payload, filename } = dataBackup.buildSnapshot(
        fakeConfig(), dataBackup.TRIGGER.STARTUP, { now: ts }
      );
      await fsp.writeFile(path.join(subdir, filename), JSON.stringify(payload), 'utf8');
    }
    await dataBackup.saveManifest(
      paths.backupDir,
      await dataBackup.rebuildManifestFromFs(paths.backupDir)
    );

    const result = await dataBackup.pruneOld({ userDataDir: dir });
    expect(result.kept).toBe(2); // floor activated
    expect(result.deleted).toBe(0);
  });
});


// === Debounced scheduler ==================================================

describe('scheduleSnapshot (debounce)', () => {
  let dir;
  beforeEach(async () => {
    dir = await makeTempDir();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    dataBackup.cancelScheduled();
    vi.useRealTimers();
    await rmTempDir(dir);
  });

  it('coalesces rapid-fire calls into one snapshot', async () => {
    let calls = 0;
    const getConfig = () => { calls++; return fakeConfig(); };

    // Five rapid calls within the debounce window
    for (let i = 0; i < 5; i++) {
      dataBackup.scheduleSnapshot({ userDataDir: dir, getConfig });
    }

    // Before the window elapses: getConfig hasn't been called yet
    // (the timer fires it at the END, not the start).
    expect(calls).toBe(0);

    // Advance past the window + drain microtasks
    await vi.advanceTimersByTimeAsync(dataBackup.DEBOUNCE_MS + 10);

    expect(calls).toBe(1);
  });

  it('cancelScheduled prevents the pending snapshot from firing', async () => {
    let fired = false;
    dataBackup.scheduleSnapshot({
      userDataDir: dir,
      getConfig: () => fakeConfig(),
      onSnapshot: () => { fired = true; },
    });
    dataBackup.cancelScheduled();
    await vi.advanceTimersByTimeAsync(dataBackup.DEBOUNCE_MS + 10);
    expect(fired).toBe(false);
  });
});


// === Constants regression pins ============================================

describe('locked constants', () => {
  it('DEBOUNCE_MS is 60_000', () => {
    expect(dataBackup.DEBOUNCE_MS).toBe(60_000);
  });
  it('retention pyramid is 24/7/4 + 30d pre-action + floor 3', () => {
    expect(dataBackup.RETENTION).toEqual({
      hourly: 24, daily: 7, weekly: 4, preActionDays: 30, minTotalFloor: 3,
    });
  });
});
