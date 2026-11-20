/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds its Appearance tab as DOM,
 * DataService reads localStorage, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// FT-102 (Pudknocker #372): Settings > Appearance > Library "One-video
// folders" box. Off on a fresh install, through the REAL store.js read-time
// default merge and the REAL DataService cache; ticking it saves
// `library.folderScriptsAsVariants` and rescans the library the way a source
// change does (the pairing is the scan's, so nothing else would show it).
// The scan side is library-scan-folder-variants.test.js.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

let diskFile = null;
// electron-conf: seeds a missing file from `defaults`, merges top-level keys
// otherwise (node_modules/electron-conf/dist/main.mjs), as mini-player-default-off.
class MockConf {
  constructor({ defaults }) {
    const file = diskFile ? JSON.parse(JSON.stringify(diskFile)) : {};
    this._data = { ...JSON.parse(JSON.stringify(defaults)), ...file };
  }
  get(p) {
    let v = this._data;
    for (const k of p.split('.')) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[k];
    }
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  set(p, value) {
    const keys = p.split('.');
    let o = this._data;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
    o[keys.at(-1)] = JSON.parse(JSON.stringify(value));
  }
}
vi.mock('electron-conf', () => ({ default: MockConf }));
const store = await import('../../electron/store.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));

async function boot(file) {
  diskFile = file;
  await store.initStore();
  window.funsync = {
    getAllData: async () => store.getAll(),
    setSetting: (p, value) => store.setSetting(p, value),
    onGlobalShortcut: () => {},
    setGlobalShortcuts: async () => [],
  };
  const settings = new DataService();
  await settings.init();
  return settings;
}

function folderBox(settings, onSourcesChanged = () => {}) {
  const tab = new SettingsPanel({ settings, onSourcesChanged })._buildAppearanceTab();
  document.body.appendChild(tab);
  return tab.querySelector('#sp-folder-variants');
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  _setBundlesForTests('en', EN, EN);
});

describe('FT-102: the One-video folders box', () => {
  it('fresh install: unticked, labelled, with its hint in the Library group', async () => {
    const box = folderBox(await boot(null));
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(box.closest('#sp-sec-library')).not.toBeNull();
    const label = document.querySelector('label[for="sp-folder-variants"]');
    expect(label.textContent).toBe(EN.settingsPanel.appearance.folderScriptsAsVariantsLabel);
    expect(document.getElementById(box.getAttribute('aria-describedby')).textContent)
      .toBe(EN.settingsPanel.appearance.folderScriptsAsVariantsHint);
  });

  it('a config from before the key existed is off too', async () => {
    const box = folderBox(await boot({ settings: { library: { directory: 'C:\\Lib' } } }));
    expect(box.checked).toBe(false);
  });

  it('ticking saves it through to the store and rescans; unticking turns it off and rescans again', async () => {
    const settings = await boot(null);
    const rescans = vi.fn();
    const box = folderBox(settings, rescans);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(store.getSetting('library.folderScriptsAsVariants')).toBe(true);
    expect(settings.get('library.folderScriptsAsVariants')).toBe(true);
    expect(rescans).toHaveBeenCalledTimes(1);

    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(store.getSetting('library.folderScriptsAsVariants')).toBe(false);
    expect(rescans).toHaveBeenCalledTimes(2);
  });

  it('a stored true shows ticked', async () => {
    const box = folderBox(await boot({ settings: { library: { folderScriptsAsVariants: true } } }));
    expect(box.checked).toBe(true);
  });
});
