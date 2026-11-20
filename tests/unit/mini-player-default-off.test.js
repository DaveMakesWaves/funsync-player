/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds its Playback tab as DOM,
 * DataService reads localStorage, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// The mini player defaults OFF (app test V54).
//
// Dave told lr_x3 publicly that leaving the player would stop the video
// unless you asked for the corner mini player. store.js still shipped
// `miniPlayer: true` and every reader treated anything but an explicit false
// as ON, so Back kept the video, and the device, running.
//
// These run the whole read path the app uses: a config file as electron-conf
// would leave it -> the REAL store.getAll() (with its read-time default merge)
// -> the REAL DataService cache -> the REAL App._shouldEnterMiniplayer lifted
// from app.js, and the REAL Settings checkbox. What is asserted is whether
// leaving a playing video docks it, and whether the box shows ticked.
//
// A value already on disk is a user's choice and must survive: installs first
// run on 0.8.0-0.9.2 carry an auto-written `true` that cannot be told apart
// from a deliberate one, so they keep it (decision recorded in UPDATES.md).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { shouldEnterMiniplayer } from '../../renderer/js/miniplayer.js';
import { liftAppClass } from './helpers/app-methods.js';

// What config.json holds before the app starts. `null` = no file (first run).
let diskFile = null;

// electron-conf seeds a missing file from `defaults`, and otherwise merges
// them SHALLOWLY (top-level keys only), so a `settings` object already in the
// file is taken as-is. This mirrors that constructor
// (node_modules/electron-conf/dist/main.mjs).
class MockConf {
  constructor({ defaults }) {
    const file = diskFile ? JSON.parse(JSON.stringify(diskFile)) : {};
    this._data = { ...JSON.parse(JSON.stringify(defaults)), ...file };
  }
  get(path) {
    let v = this._data;
    for (const k of path.split('.')) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[k];
    }
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  set(path, value) {
    const keys = path.split('.');
    let o = this._data;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
    o[keys.at(-1)] = JSON.parse(JSON.stringify(value));
  }
}
vi.mock('electron-conf', () => ({ default: MockConf }));
const store = await import('../../electron/store.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));

const LiftedApp = liftAppClass(['_shouldEnterMiniplayer'], { shouldEnterMiniplayer });

/** Boot the store + DataService exactly as the app does, from `file`. */
async function boot(file) {
  diskFile = file;
  await store.initStore();
  window.funsync = {
    getAllData: async () => store.getAll(),
    setSetting: (path, value) => store.setSetting(path, value),
    onGlobalShortcut: () => {},
    setGlobalShortcuts: async () => [],
  };
  const settings = new DataService();
  await settings.init();
  return settings;
}

/** Would pressing Back on a PLAYING video dock it into the corner? */
function docksOnLeave(settings) {
  const app = new LiftedApp();
  app.settings = settings;
  app.videoPlayer = { video: { currentSrc: 'file:///v.mp4', paused: false, ended: false } };
  return app._shouldEnterMiniplayer();
}

function miniPlayerCheckbox(settings) {
  const tab = new SettingsPanel({ settings })._buildPlaybackTab();
  document.body.appendChild(tab);
  return tab.querySelector('#sp-mini-player');
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  _setBundlesForTests('en', EN, EN);
});

describe('mini player defaults OFF (V54)', () => {
  it('fresh install: Back stops the video and the box is unticked', async () => {
    const settings = await boot(null);
    expect(docksOnLeave(settings)).toBe(false);
    expect(miniPlayerCheckbox(settings).checked).toBe(false);
  });

  it('a config from before the key existed is off too (read-time default merge)', async () => {
    const settings = await boot({ settings: { player: { volume: 55 } } });
    expect(docksOnLeave(settings)).toBe(false);
    expect(miniPlayerCheckbox(settings).checked).toBe(false);
  });

  it('a key missing from the cache entirely reads as off, not on', () => {
    // The fallback path: nothing in the cache at all (DataService before
    // init, or a settings object without the key). `!== false` read this as
    // ON; only an explicit true may dock.
    const empty = { get: () => undefined, set: () => {} };
    expect(docksOnLeave(empty)).toBe(false);
    expect(miniPlayerCheckbox(empty).checked).toBe(false);
  });

  it('a stored true is the user\'s choice and still docks', async () => {
    const settings = await boot({ settings: { player: { volume: 55, miniPlayer: true } } });
    expect(docksOnLeave(settings)).toBe(true);
    expect(miniPlayerCheckbox(settings).checked).toBe(true);
  });

  it('a stored false stays off', async () => {
    const settings = await boot({ settings: { player: { miniPlayer: false } } });
    expect(docksOnLeave(settings)).toBe(false);
  });

  it('ticking the box turns it on and persists through to the store', async () => {
    const settings = await boot(null);
    const box = miniPlayerCheckbox(settings);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(docksOnLeave(settings)).toBe(true);
    expect(store.getSetting('player.miniPlayer')).toBe(true);

    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(docksOnLeave(settings)).toBe(false);
    expect(store.getSetting('player.miniPlayer')).toBe(false);
  });

  it('the settings-panel fallback constant agrees with the store default', () => {
    // SETTINGS_DEFAULTS is only a fallback, but the two drifting is how
    // preferMultiAxis shipped wrong twice.
    const src = fs.readFileSync('renderer/components/settings-panel.js', 'utf8');
    const m = src.match(/'player\.miniPlayer':\s*(true|false)/);
    expect(m, 'SETTINGS_DEFAULTS is missing player.miniPlayer').not.toBeNull();
    expect(m[1] === 'true').toBe(store.DEFAULTS.settings.player.miniPlayer);
    expect(store.DEFAULTS.settings.player.miniPlayer).toBe(false);
  });
});
