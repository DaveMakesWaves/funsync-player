/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Until this release every Fisheye 180 video was drawn as a vertical mirror
// (Buck Nakkidd, Discord, 2026-11-27), so people turned on the per-video
// Rotate 180° to get it the right way up. With the shader fixed, that 180
// turns a correct picture upside down: it is switched off ONCE on Fisheye
// entries (Dave: "do the migration"), and nothing else is touched. Same
// pattern as editor-max-speed-migration.test.js.
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

const ID = 'fisheyeRotate180Off';
const configPath = () => path.join(h.userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));
const seed = (config) => fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
const launch = () => store.initStore();

const FISH = 'C:\\VR\\Fish.mp4';
const FISH_NEG = 'C:\\VR\\Fish neg.mp4';
const FISH_UPRIGHT = 'C:\\VR\\Fish upright.mp4';
const EQUI = 'C:\\VR\\Equi.mp4';
const FLAT = 'C:\\VR\\Flat.mp4';

const entry = (projection, roll, extra = {}) => ({ projection, eye: 'left', zoom: 1, fov: 95, yaw: 12, pitch: -4, roll, source: 'manual', ...extra });

const withFormats = (vrFormat) => ({
  settings: { player: { volume: 55 }, library: { vrFormat } },
  playlists: [],
  categories: [],
  videoCategories: {},
  _migrated: true,
});

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-fisheye-roll-'));
});
afterEach(() => {
  try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Rotate 180° off on Fisheye videos, once', () => {
  it('a Fisheye entry turned 180° (or -180°) is set back to 0; its other fields and every other entry are kept', async () => {
    seed(withFormats({
      [FISH]: entry('fisheye-180', 180),
      [FISH_NEG]: entry('fisheye-180', -180),
      [FISH_UPRIGHT]: entry('fisheye-180', 0),
      [EQUI]: entry('equirect-180', 180),
      [FLAT]: { projection: 'flat', eye: null, zoom: 1.4, source: 'manual' },
    }));
    await launch();
    const map = onDisk().settings.library.vrFormat;
    expect(map[FISH]).toEqual(entry('fisheye-180', 0));
    expect(map[FISH_NEG]).toEqual(entry('fisheye-180', 0));
    expect(map[FISH_UPRIGHT]).toEqual(entry('fisheye-180', 0));
    expect(map[EQUI], 'Equirect was always drawn right: its 180 is deliberate').toEqual(entry('equirect-180', 180));
    expect(map[FLAT]).toEqual({ projection: 'flat', eye: null, zoom: 1.4, source: 'manual' });
    expect(onDisk()._migrations).toMatchObject({ [ID]: true });
    expect(store.appliedMigrations()).toContain(ID);
  });

  it('a Rotate 180° the user sets afterwards is kept', async () => {
    seed(withFormats({ [FISH]: entry('fisheye-180', 180) }));
    await launch();
    store.setSetting('library.vrFormat', { [FISH]: entry('fisheye-180', 180) });
    await launch();
    expect(store.getSetting('library.vrFormat')[FISH].roll).toBe(180);
    expect(store.appliedMigrations()).not.toContain(ID);
  });

  it('nothing to change (no formats, or none turned): nothing written but the record', async () => {
    seed(withFormats({ [FISH_UPRIGHT]: entry('fisheye-180', 0) }));
    await launch();
    expect(store.appliedMigrations()).not.toContain(ID);
    expect(onDisk().settings.library.vrFormat).toEqual({ [FISH_UPRIGHT]: entry('fisheye-180', 0) });

    fs.rmSync(configPath());
    seed({ settings: { player: { volume: 55 } }, playlists: [], categories: [], videoCategories: {}, _migrated: true });
    await launch();
    expect(store.appliedMigrations()).not.toContain(ID);
  });
});
