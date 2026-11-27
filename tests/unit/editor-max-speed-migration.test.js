/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The editor speed limit's default moved 400 → 640, the fastest any supported
// toy moves (Dave, 2026-11-24: "the settings limit should be the fastest any
// compatable toy can go"). A config made by the build that had 400 holds it
// (electron-conf writes the whole DEFAULTS block into a config it creates;
// found in the hands-on pass): it is moved ONCE, and a 400 the user sets
// afterwards is kept. Same pattern as multi-axis-default-migration.test.js.
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

const ID = 'editorMaxSpeed400to640';
const configPath = () => path.join(h.userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));
const seed = (config) => fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
const launch = () => store.initStore();

const withMax = (maxSpeed) => ({
  settings: {
    player: { volume: 55, theme: 'dark', preferMultiAxis: 'multi' },
    editor: { maxSpeed, minSpeed: 33 },
  },
  playlists: [],
  categories: [],
  videoCategories: {},
  _migrated: true,
});

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-max-speed-'));
});
afterEach(() => {
  try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('editor speed limit 400 → 640, once', () => {
  it('a 400 on disk launches as 640, on disk too; the min is left alone', async () => {
    seed(withMax(400));
    await launch();
    expect(store.getSetting('editor.maxSpeed')).toBe(640);
    const disk = onDisk();
    expect(disk.settings.editor).toEqual({ maxSpeed: 640, minSpeed: 33 });
    expect(disk._migrations).toMatchObject({ [ID]: true });
    expect(store.appliedMigrations()).toContain(ID);
  });

  it('a user who sets 400 again afterwards keeps it', async () => {
    seed(withMax(400));
    await launch();
    store.setSetting('editor.maxSpeed', 400);
    await launch();
    expect(store.getSetting('editor.maxSpeed')).toBe(400);
    expect(store.appliedMigrations()).not.toContain(ID);
  });

  it('any other value is the user\'s; none stored reads the new default', async () => {
    seed(withMax(500));
    await launch();
    expect(store.getSetting('editor.maxSpeed')).toBe(500);
    expect(store.appliedMigrations()).not.toContain(ID);

    fs.rmSync(configPath());
    seed({ settings: { player: { volume: 55 } }, playlists: [], categories: [], videoCategories: {}, _migrated: true });
    await launch();
    expect(store.getSetting('editor.maxSpeed')).toBe(640);
  });
});
