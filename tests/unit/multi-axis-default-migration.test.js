/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// "Multi-axis when available" reaches existing installs: a preferMultiAxis of
// 'single' left on disk by v0.5.1 - v0.9.2 is moved to 'multi' ONCE, and a
// user who picks Single afterwards keeps it (Dave, 2026-11-20: "make multi
// axis default for scripts that have multi axis available").
//
// Those releases wrote their whole DEFAULTS block (with 'single') into every
// config they created, and the read-time default merge only fills ABSENT keys,
// so the 'multi' default never reached them. Same pattern and trade-off as the
// T-Code 25 → 60 Hz migration (tcode-rate-migration.test.js).
//
// These run the REAL store.js on the REAL electron-conf against a config.json
// in a temp userData dir: each initStore() is one app launch.
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

const ID = 'preferMultiAxisSingleToMulti';
const configPath = () => path.join(h.userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));
const seed = (config) => fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
const launch = () => store.initStore();
/** What Settings > Playback's Default playback select and library.js read. */
const shownMode = () => store.getAll().settings.player.preferMultiAxis;

// A v0.9.2 config: that release wrote preferMultiAxis 'single' into it. One
// video is already set by hand to single, one to multi: neither may change.
const V092_CONFIG = {
  settings: {
    handy: { connectionKey: '', defaultOffset: 0 },
    player: { volume: 55, theme: 'dark', preferMultiAxis: 'single', gapSkipMode: 'off' },
    library: {
      sources: [{ id: 's1', name: 'Lib', path: 'C:/lib', enabled: true }],
      associations: {
        'C:/lib/a.mp4': { active: 'single', single: 'C:/lib/a.funscript', multi: null, custom: null },
        'C:/lib/b.mp4': {
          active: 'multi',
          single: null,
          multi: { main: 'C:/lib/b.funscript', axes: { pitch: 'C:/lib/b.pitch.funscript' }, buttplugVib: false },
          custom: null,
        },
      },
    },
  },
  playlists: [],
  categories: [],
  videoCategories: {},
  _migrated: true,
};

const withMode = (mode) => ({
  ...V092_CONFIG,
  settings: { ...V092_CONFIG.settings, player: { ...V092_CONFIG.settings.player, preferMultiAxis: mode } },
});

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-multi-default-'));
});
afterEach(() => {
  try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Default playback Single → Multi-axis when available, once (v0.10.1)', () => {
  it('a v0.9.2 config with Single launches with Multi, on disk too, and nothing else changes', async () => {
    seed(V092_CONFIG);
    await launch();

    expect(shownMode()).toBe('multi');
    expect(store.getSetting('player.preferMultiAxis')).toBe('multi');
    const disk = onDisk();
    expect(disk.settings.player).toEqual({ ...V092_CONFIG.settings.player, preferMultiAxis: 'multi' });
    expect(disk._migrations).toMatchObject({ [ID]: true });
    expect(store.appliedMigrations()).toEqual([ID]);
    // The per-video choices are the user's: the migration touches none.
    expect(disk.settings.library.associations).toEqual(V092_CONFIG.settings.library.associations);
    expect(disk.settings.handy).toEqual(V092_CONFIG.settings.handy);
  });

  it('a user who picks Single again afterwards keeps it on every later launch', async () => {
    seed(V092_CONFIG);
    await launch();
    expect(shownMode()).toBe('multi');

    store.setSetting('player.preferMultiAxis', 'single'); // the select's change handler
    await launch();
    expect(shownMode()).toBe('single');
    expect(store.appliedMigrations()).toEqual([]);

    await launch();
    expect(shownMode()).toBe('single');
    expect(onDisk().settings.player.preferMultiAxis).toBe('single');
  });

  it('Multi already on disk is left alone, and the migration is still spent', async () => {
    seed(withMode('multi'));
    await launch();
    expect(shownMode()).toBe('multi');
    expect(store.appliedMigrations()).toEqual([]);
    expect(onDisk()._migrations).toMatchObject({ [ID]: true });

    // Spent: a later pick of Single is not migrated either.
    store.setSetting('player.preferMultiAxis', 'single');
    await launch();
    expect(shownMode()).toBe('single');
  });

  it('a config from before the key existed reads the Multi default and gains no key', async () => {
    const { preferMultiAxis, ...player } = V092_CONFIG.settings.player;
    seed({ ...V092_CONFIG, settings: { ...V092_CONFIG.settings, player } });
    await launch();
    expect(shownMode()).toBe('multi');
    expect(onDisk().settings.player.preferMultiAxis).toBeUndefined();
    expect(onDisk()._migrations).toMatchObject({ [ID]: true });
  });

  it('a fresh install records the migration as spent, so its own later pick of Single stays', async () => {
    expect(fs.existsSync(configPath())).toBe(false);
    await launch();
    expect(shownMode()).toBe('multi');
    expect(onDisk()._migrations).toMatchObject({ [ID]: true });

    store.setSetting('player.preferMultiAxis', 'single');
    await launch();
    expect(shownMode()).toBe('single');
  });

  it('a v0.8.0 config gets both migrations in one launch', async () => {
    const v080 = withMode('single');
    v080.settings = { ...v080.settings, tcode: { transport: 'serial', updateRateHz: 25 } };
    seed(v080);
    await launch();
    expect(shownMode()).toBe('multi');
    expect(store.getAll().settings.tcode.updateRateHz).toBe(60);
    expect(store.appliedMigrations()).toEqual(expect.arrayContaining(['tcodeUpdateRate25to60', ID]));
    expect(store.appliedMigrations()).toHaveLength(2);
  });

  it('the record travels in a snapshot, so a restore does not undo a later pick of Single', async () => {
    seed(V092_CONFIG);
    await launch();
    store.setSetting('player.preferMultiAxis', 'single');

    const snapshot = store.getAll();
    expect(snapshot._migrations).toMatchObject({ [ID]: true });
    fs.writeFileSync(configPath(), JSON.stringify(snapshot, null, 2));
    await launch();
    expect(shownMode()).toBe('single');
  });

  it('a restore of a v0.9.2-era snapshot (no record) is migrated like the install it came from', async () => {
    seed(V092_CONFIG);
    await launch();
    fs.writeFileSync(configPath(), JSON.stringify(V092_CONFIG, null, 2));
    await launch();
    expect(shownMode()).toBe('multi');
  });
});
