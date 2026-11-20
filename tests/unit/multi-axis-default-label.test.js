/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds its Playback tab as DOM,
 * and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// The option Settings calls "(default)" must be the one the app defaults to
// (app test V37).
//
// `player.preferMultiAxis` flipped from 'single' to 'multi' in electron/
// store.js, but every locale still said "Single axis (default)" and titled
// the reset button "Reset to default (Single axis)". That button resets to
// SETTINGS_DEFAULTS ('multi'), so it did the opposite of what it said and
// opened the "Switch to multi-axis default?" confirm.
//
// The Playback tab is rendered in each of the 8 locales and checked against
// the default store.js actually ships, so the next flip cannot drift again.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

const { DEFAULTS } = await import('../../electron/store.js');
const SHIPPED_DEFAULT = DEFAULTS.settings.player.preferMultiAxis;

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');

// How each locale already marks a default option ("Linear (default)").
const DEFAULT_MARK = {
  en: '(default)',
  de: '(Standard)',
  es: '(predeterminado)',
  fr: '(par défaut)',
  ja: '(デフォルト)',
  ko: '(기본값)',
  ru: '(по умолчанию)',
  zh: '(默认)',
};

beforeEach(() => {
  document.body.innerHTML = '';
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

afterAll(() => _setBundlesForTests('en', EN, EN));

function renderPlaybackTab(locale) {
  _setBundlesForTests(locale, bundle(locale), EN);
  const tab = new SettingsPanel({ settings: new DataService() })._buildPlaybackTab();
  document.body.appendChild(tab);
  return tab;
}

describe('Default playback: the option labelled default is the shipped default (V37)', () => {
  it.each(Object.keys(DEFAULT_MARK))('%s', (locale) => {
    const tab = renderPlaybackTab(locale);
    const mark = DEFAULT_MARK[locale];
    const options = [...tab.querySelectorAll('#sp-prefer-multi option')];
    expect(options.map((o) => o.value).sort()).toEqual(['multi', 'single']);

    const marked = options.filter((o) => o.textContent.includes(mark)).map((o) => o.value);
    expect(marked).toEqual([SHIPPED_DEFAULT]);

    // The reset button names the mode it resets to, and only that one.
    const resetTitle = tab.querySelector('#sp-prefer-multi-reset').title;
    const named = resetTitle.match(/\(([^)]+)\)\s*$/)?.[1];
    expect(named, resetTitle).toBeTruthy();
    const target = options.find((o) => o.value === SHIPPED_DEFAULT).textContent;
    const other = options.find((o) => o.value !== SHIPPED_DEFAULT).textContent;
    expect(target).toContain(named);
    expect(other).not.toContain(named);
  });
});
