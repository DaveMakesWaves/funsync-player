/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel opens through Modal.open() and
 * builds every area as DOM, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Changing the language in Settings must leave you where you were (app test
// V49).
//
// The panel rebuilds itself on `language:changed`, because its strings are
// baked in with t() at render time. To pick the area to rebuild on, the
// handler queried `.settings-panel__tab--active`, a class from the old
// horizontal tab strip. The vertical rail marks its active item with
// `settings-panel__rail-item--active`, so the query always came back empty
// and every language change dropped the user on Sources. The refocus of the
// language picker, gated on staying in Appearance, never ran either.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');

const settingsStub = () => {
  const values = { 'player.language': 'en' };
  return {
    get: (k) => values[k],
    set: (k, v) => { values[k] = v; },
    getAll: () => ({}),
  };
};

let showing = null;

beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

afterEach(async () => {
  // Close the modal so its language:changed subscription is released.
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
  showing = null;
});

afterAll(() => _setBundlesForTests('en', EN, EN));

function open() {
  const panel = new SettingsPanel({ settings: settingsStub() });
  showing = panel.show();
  return panel;
}

const activeArea = () => document.querySelector('.settings-panel__rail-item--active')?.dataset.area;
const visiblePanel = () => document.querySelector('[role="tabpanel"]:not([hidden])')?.id;

function switchToGerman() {
  _setBundlesForTests('de', DE, EN);
  eventBus.emit('language:changed', { locale: 'de' });
}

describe('Settings keeps your place across a language change (V49)', () => {
  it('stays on Appearance and refocuses the language picker', () => {
    open();
    document.querySelector('.settings-panel__rail-item[data-area="appearance"]').click();
    document.querySelector('[data-setting="player.language"]').focus();
    expect(activeArea()).toBe('appearance');

    switchToGerman();

    expect(activeArea()).toBe('appearance');
    expect(visiblePanel()).toBe('settings-tabpanel-appearance');
    // The DOM was rebuilt (German labels), and focus landed on the NEW picker.
    expect(document.querySelector('.modal-title').textContent).toBe(DE.settingsPanel.modalTitle);
    expect(document.activeElement?.matches('[data-setting="player.language"]')).toBe(true);
  });

  it('stays on whichever area was open, not just Appearance', () => {
    open();
    document.querySelector('.settings-panel__rail-item[data-area="data"]').click();

    switchToGerman();

    expect(activeArea()).toBe('data');
    expect(visiblePanel()).toBe('settings-tabpanel-data');
  });

  it('still opens on Sources the first time', () => {
    open();
    expect(activeArea()).toBe('sources');
  });
});
