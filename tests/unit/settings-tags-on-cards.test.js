/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds its Appearance tab as DOM,
 * DataService reads localStorage, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Settings > Appearance > Library "Tags on library cards" (P1, Round 3,
// 2026-11-18; plan §2.2 "Showing tags": off by default, so cards look as
// today). Off on a fresh install through the REAL store.js default merge and
// the REAL DataService; ticking saves `library.showTagsOnCards` and asks for
// the library re-render that every card-shape setting needs. The cards' side
// is library-tags-filter-ui.test.js.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

let diskFile = null;
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

function tagsBox(settings, onLibraryDisplayChanged = () => {}) {
  const tab = new SettingsPanel({ settings, onLibraryDisplayChanged })._buildAppearanceTab();
  document.body.appendChild(tab);
  return tab.querySelector('#sp-card-tags');
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  _setBundlesForTests('en', EN, EN);
});

describe('the Tags on library cards box', () => {
  it('fresh install: unticked, labelled, with its hint, in the Library group', async () => {
    const box = tagsBox(await boot(null));
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(box.closest('#sp-sec-library')).not.toBeNull();
    expect(document.querySelector('label[for="sp-card-tags"]').textContent)
      .toBe(EN.settingsPanel.appearance.tagsOnCardsLabel);
    expect(document.getElementById(box.getAttribute('aria-describedby')).textContent)
      .toBe(EN.settingsPanel.appearance.tagsOnCardsHint);
  });

  it('ticking saves it through to the store and re-renders the library; unticking turns it off again', async () => {
    const settings = await boot(null);
    const rerender = vi.fn();
    const box = tagsBox(settings, rerender);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(store.getSetting('library.showTagsOnCards')).toBe(true);
    expect(settings.get('library.showTagsOnCards')).toBe(true);
    expect(rerender).toHaveBeenCalledTimes(1);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(store.getSetting('library.showTagsOnCards')).toBe(false);
    expect(rerender).toHaveBeenCalledTimes(2);
  });

  it('a stored true shows ticked', async () => {
    const box = tagsBox(await boot({ settings: { library: { showTagsOnCards: true } } }));
    expect(box.checked).toBe(true);
  });

  it('the store default is false, and the settings-panel fallback constant agrees', () => {
    expect(store.DEFAULTS.settings.library.showTagsOnCards).toBe(false);
    const src = fs.readFileSync('renderer/components/settings-panel.js', 'utf8');
    const m = src.match(/'library\.showTagsOnCards':\s*(true|false)/);
    expect(m, 'SETTINGS_DEFAULTS is missing library.showTagsOnCards').not.toBeNull();
    expect(m[1]).toBe('false');
  });
});
