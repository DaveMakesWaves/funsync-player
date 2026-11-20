/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A T-Code update rate of 25 Hz left on disk by v0.8.0 is moved to 60 Hz
// once, and never again (app test V77, found verifying EroScripts #204 Evicol).
//
// 25 Hz was the default only in v0.8.0 (fresh installs Jul 31 - Aug 6 2026)
// and is the rate that aliased fast vibration on an SR6/OSR2. 0.9.0 fixed that
// with keyframe output and made 60 the default, but electron-conf wrote the
// whole DEFAULTS block into every config it created, and the read-time default
// merge only fills ABSENT keys, so those installs kept 25 and the dropdown
// showed it. store.js now runs a one-time migration and records that it ran in
// `_migrations`, so a user who picks 25 afterwards keeps it.
//
// These run the REAL store.js on the REAL electron-conf (tests/unit/helpers/
// real-electron-conf.js) against a config.json in a temp userData dir: each
// initStore() is one app launch, reading the file the last one left.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});

const store = await import('../../electron/store.js');

const configPath = () => path.join(h.userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));
/** What config.json holds before a launch (an install from some earlier version). */
const seed = (config) => fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
/** One app launch: electron-conf reads config.json, the migrations run. */
const launch = () => store.initStore();
/** What the Devices panel's T-Code dropdown reads: settings from getAll(). */
const shownRate = () => store.getAll().settings.tcode.updateRateHz;

// A v0.8.0 fresh-install config: electron-conf wrote that version's DEFAULTS.
const V080_CONFIG = {
  settings: {
    handy: { connectionKey: 'abc', defaultOffset: 0, slideMin: 0, slideMax: 100 },
    player: { volume: 55, theme: 'dark' },
    library: { sources: [{ id: 's1', name: 'Lib', path: 'C:/lib', enabled: true }] },
    tcode: {
      transport: 'serial', port: 'COM4', baudRate: 115200, udpHost: '', udpPort: 0, wsUrl: '',
      precision: 3, updateRateHz: 25, axisRanges: { L0: { min: 10, max: 90 } }, axisEnabled: {},
    },
  },
  playlists: [{ id: 'p1', name: 'Mix', createdAt: 1, videoPaths: ['C:/lib/a.mp4'] }],
  categories: [],
  videoCategories: {},
  _migrated: true,
};

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-tcode-rate-'));
});
afterEach(() => {
  try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('T-Code 25 Hz → 60 Hz, once (V77)', () => {
  it('a v0.8.0 config with 25 Hz launches at 60 Hz, on disk too, and nothing else changes', async () => {
    seed(V080_CONFIG);
    await launch();

    expect(shownRate()).toBe(60);
    expect(store.getSetting('tcode.updateRateHz')).toBe(60);
    const disk = onDisk();
    expect(disk.settings.tcode.updateRateHz).toBe(60);
    expect(disk._migrations).toEqual({ tcodeUpdateRate25to60: true });
    expect(store.appliedMigrations()).toEqual(['tcodeUpdateRate25to60']);
    // Everything else in the file is as it was.
    expect(disk.settings.tcode).toEqual({ ...V080_CONFIG.settings.tcode, updateRateHz: 60 });
    expect(disk.settings.handy).toEqual(V080_CONFIG.settings.handy);
    expect(disk.playlists).toEqual(V080_CONFIG.playlists);
  });

  it('a user who picks 25 again afterwards keeps it on every later launch', async () => {
    seed(V080_CONFIG);
    await launch();
    expect(shownRate()).toBe(60);

    store.setSetting('tcode.updateRateHz', 25); // the dropdown's change handler
    await launch();
    expect(shownRate()).toBe(25);
    expect(store.appliedMigrations()).toEqual([]);

    await launch();
    expect(shownRate()).toBe(25);
    expect(onDisk().settings.tcode.updateRateHz).toBe(25);
  });

  for (const rate of [33, 50, 60]) {
    it(`${rate} Hz is the user's and is left alone, and the migration is still spent`, async () => {
      seed({ ...V080_CONFIG, settings: { ...V080_CONFIG.settings, tcode: { ...V080_CONFIG.settings.tcode, updateRateHz: rate } } });
      await launch();
      expect(shownRate()).toBe(rate);
      expect(store.appliedMigrations()).toEqual([]);
      expect(onDisk()._migrations).toEqual({ tcodeUpdateRate25to60: true });

      // Spent: a later pick of 25 is not migrated either.
      store.setSetting('tcode.updateRateHz', 25);
      await launch();
      expect(shownRate()).toBe(25);
    });
  }

  it('a config from before the key existed reads the 60 Hz default and gains no key', async () => {
    const { tcode, ...rest } = V080_CONFIG.settings;
    seed({ ...V080_CONFIG, settings: rest });
    await launch();
    expect(shownRate()).toBe(60);
    expect(onDisk().settings.tcode).toBeUndefined();
    expect(onDisk()._migrations).toEqual({ tcodeUpdateRate25to60: true });
  });

  it('a fresh install records the migration as spent, so its own later pick of 25 stays', async () => {
    expect(fs.existsSync(configPath())).toBe(false);
    await launch();
    expect(shownRate()).toBe(60);
    expect(onDisk()._migrations).toEqual({ tcodeUpdateRate25to60: true });

    store.setSetting('tcode.updateRateHz', 25);
    await launch();
    expect(shownRate()).toBe(25);
  });

  it('the record travels in a snapshot, so a restore does not undo a later pick of 25', async () => {
    seed(V080_CONFIG);
    await launch();
    store.setSetting('tcode.updateRateHz', 25);

    // A snapshot is getAll(); Restore (and launch-time recovery) writes its
    // config back as the whole config.json, then relaunches.
    const snapshot = store.getAll();
    expect(snapshot._migrations).toEqual({ tcodeUpdateRate25to60: true });
    fs.writeFileSync(configPath(), JSON.stringify(snapshot, null, 2));
    await launch();
    expect(shownRate()).toBe(25);
  });

  it('a restore of a v0.8.0-era snapshot (no record) is migrated like the install it came from', async () => {
    seed(V080_CONFIG);
    await launch();
    // An old snapshot from before the upgrade, holding the 0.8.0 default.
    fs.writeFileSync(configPath(), JSON.stringify(V080_CONFIG, null, 2));
    await launch();
    expect(shownRate()).toBe(60);
  });
});
