/**
 * @vitest-environment jsdom
 * jsdom on purpose: the theme manager writes <html> attributes, the snow layer
 * is DOM, and the REAL settings panel builds the Interface style rows
 * (notes/CLAUDE.md "Test environments").
 */
// The Holiday interface style (v0.10.1, Dave 2026-11-21: "modern classic
// holiday", "unobtrusive snow animations", "a santa hat on the logo", "gold
// ring on the logo small red and green touches, as it is optional", and "it
// should be toggleable on and off anyway from the appearance settings").
//
// What runs is REAL: renderer/js/holiday.js, theme-manager.js's initTheme with
// the shared event bus, electron/window-bg.js's colours and season, and the
// settings panel's Appearance section. Asserted: the <html> attributes, the
// snow layer, what the window chrome is told, the colours main paints, and
// what the Settings rows show and save. What CSS then shows (snow hidden over
// a video, under reduced motion and with the switch off) was checked in the
// sandbox app (notes/UPDATES.md); its rules are pinned at the end.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { styleAttributes, snowFlakes, mountSnow, applySeason, applySnowSetting, SNOW_FLAKES } = await import('../../renderer/js/holiday.js');
const { initTheme, applyStyle, resolveStyle, _resetForTests } = await import('../../renderer/js/theme-manager.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

// initTheme subscribes to the shared bus and nothing unsubscribes it; each
// test's own listeners are taken off after it, or a later test's settings
// change would also run an earlier test's data service.
let busBefore;

function dataService(initial = {}) {
  const store = { ...initial };
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; eventBus.emit('settings:changed', { path: k, value: v }); },
  };
}

beforeEach(() => {
  busBefore = new Set(eventBus._handlers.get('settings:changed') || []);
  document.documentElement.removeAttribute('data-style');
  document.documentElement.removeAttribute('data-season');
  document.documentElement.removeAttribute('data-snow');
  document.body.innerHTML = '';
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.funsync = { updateWindowChrome: vi.fn() };
});
afterEach(() => {
  for (const h of eventBus._handlers.get('settings:changed') || []) if (!busBefore.has(h)) eventBus.off('settings:changed', h);
  _resetForTests();
  delete window.funsync;
});

describe('Holiday is Modern plus its own palette', () => {
  it('styleAttributes: each Interface style setting and what <html> carries', () => {
    expect(styleAttributes('holiday')).toEqual({ style: 'modern', season: 'holiday' });
    expect(styleAttributes('modern')).toEqual({ style: 'modern', season: null });
    expect(styleAttributes('classic')).toEqual({ style: 'classic', season: null });
    expect(styleAttributes('bogus')).toEqual({ style: 'classic', season: null });
    expect(resolveStyle('holiday')).toBe('holiday');
  });

  it('applyStyle: Holiday sets data-style="modern" + data-season and mounts the snow once; Classic takes the season off', () => {
    applyStyle('holiday');
    expect(document.documentElement.dataset.style).toBe('modern');
    expect(document.documentElement.dataset.season).toBe('holiday');
    expect(document.querySelectorAll('.holiday-snow')).toHaveLength(1);
    expect(document.querySelector('.holiday-snow').children).toHaveLength(SNOW_FLAKES);
    expect(document.querySelector('.holiday-snow').getAttribute('aria-hidden')).toBe('true');

    applyStyle('holiday');
    expect(document.querySelectorAll('.holiday-snow')).toHaveLength(1);

    applyStyle('classic');
    expect(document.documentElement.dataset.style).toBe('classic');
    expect(document.documentElement.dataset.season).toBeUndefined();
  });

  it('a pop-out takes the palette but never the snow', () => {
    applySeason('holiday', document, { snow: false });
    expect(document.documentElement.dataset.season).toBe('holiday');
    expect(document.querySelector('.holiday-snow')).toBeNull();
  });
});

describe('the theme manager follows Settings', () => {
  it('a saved Holiday applies at start; switching to Classic and back retints the window chrome each time', () => {
    const ds = dataService({ 'player.theme': 'light', 'player.uiStyle': 'holiday' });
    initTheme(ds);
    expect(document.documentElement.dataset.season).toBe('holiday');
    expect(document.documentElement.dataset.snow).toBe('on');
    expect(window.funsync.updateWindowChrome).toHaveBeenLastCalledWith('light', { season: 'holiday' });

    ds.set('player.uiStyle', 'classic');
    expect(document.documentElement.dataset.season).toBeUndefined();
    expect(window.funsync.updateWindowChrome).toHaveBeenLastCalledWith('light', { season: 'none' });

    ds.set('player.uiStyle', 'holiday');
    expect(document.documentElement.dataset.season).toBe('holiday');
    expect(window.funsync.updateWindowChrome).toHaveBeenLastCalledWith('light', { season: 'holiday' });
  });

  it('Classic to Modern does not retint (no season change)', () => {
    const ds = dataService({ 'player.theme': 'dark', 'player.uiStyle': 'classic' });
    initTheme(ds);
    window.funsync.updateWindowChrome.mockClear();
    ds.set('player.uiStyle', 'modern');
    expect(window.funsync.updateWindowChrome).not.toHaveBeenCalled();
  });

  it('"Falling snow" off writes data-snow="off"; on again, "on"', () => {
    const ds = dataService({ 'player.uiStyle': 'holiday' });
    initTheme(ds);
    ds.set('player.holidaySnow', false);
    expect(document.documentElement.dataset.snow).toBe('off');
    ds.set('player.holidaySnow', true);
    expect(document.documentElement.dataset.snow).toBe('on');
    applySnowSetting(undefined);
    expect(document.documentElement.dataset.snow).toBe('on'); // the default (store.js) is on
  });
});

describe('the snow', () => {
  it('the same flakes every launch, few and small: 2-5 px, 16-32 s to fall, already falling at start', () => {
    const a = snowFlakes();
    expect(a).toEqual(snowFlakes());
    expect(a).toHaveLength(SNOW_FLAKES);
    for (const f of a) {
      expect(parseFloat(f.s)).toBeGreaterThanOrEqual(2);
      expect(parseFloat(f.s)).toBeLessThanOrEqual(5);
      expect(parseFloat(f.d)).toBeGreaterThanOrEqual(16);
      expect(parseFloat(f.d)).toBeLessThanOrEqual(32);
      expect(parseFloat(f.delay)).toBeLessThanOrEqual(0);
      expect(parseFloat(f.o)).toBeLessThanOrEqual(0.8);
    }
  });

  it('mountSnow with no page body does nothing', () => {
    expect(mountSnow({ body: null })).toBeNull();
  });
});

describe('the window chrome matches the Holiday nav bar (electron/window-bg.js)', () => {
  const electronPath = require_.resolve('electron');
  let windowBg;
  beforeEach(() => {
    require_.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
      exports: { app: { getPath: () => '/nonexistent' }, nativeTheme: { shouldUseDarkColors: true } } };
    delete require_.cache[require_.resolve('../../electron/window-bg.js')];
    windowBg = require_('../../electron/window-bg.js');
  });
  afterEach(() => {
    delete require_.cache[electronPath];
    delete require_.cache[require_.resolve('../../electron/window-bg.js')];
  });

  it('Holiday dark and light have their own surfaces; light\'s caption strip is the pine-green nav bar', () => {
    expect(windowBg.colorsForTheme('dark', 'holiday')).toMatchObject({ background: '#0e1915', chrome: '#12231d', dark: true });
    expect(windowBg.colorsForTheme('light', 'holiday')).toMatchObject({ background: '#f7f3ec', chrome: '#1d4636', symbol: '#ffffff', dark: false });
    expect(windowBg.colorsForTheme('dark', null).chrome).toBe('#16213e'); // unchanged without the season
  });

  it('the season is remembered across calls that do not say it, and read from config until told', () => {
    windowBg._resetChromeSeasonForTests();
    expect(windowBg.chromeSeason({})).toBeNull();               // no config here: none
    expect(windowBg.chromeSeason({ season: 'holiday' })).toBe('holiday');
    expect(windowBg.chromeSeason({ dimmed: true })).toBe('holiday');
    expect(windowBg.chromeSeason({ season: 'none' })).toBeNull();
    expect(windowBg.seasonForStyle('holiday')).toBe('holiday');
    expect(windowBg.seasonForStyle('modern')).toBeNull();
  });
});

describe('Settings > Appearance > Interface style', () => {
  async function appearanceTab(initial) {
    _setBundlesForTests('en', EN, EN);
    window.funsync = { ...window.funsync, setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
    const store = { ...initial };
    const settings = { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }), getAll: () => ({}) };
    const tab = new SettingsPanel({ settings })._buildAppearanceTab();
    document.body.appendChild(tab);
    return { tab, settings, store, EN };
  }

  it('Holiday is the third option; its "Falling snow" row shows only while Holiday is chosen, and saves', async () => {
    const { tab, settings, store, EN } = await appearanceTab({ 'player.uiStyle': 'classic' });
    const radios = [...tab.querySelectorAll('input[name=uiStyle]')];
    expect(radios.map((r) => r.value)).toEqual(['classic', 'modern', 'holiday']);
    expect(radios[2].closest('label').textContent).toContain(EN.settingsPanel.appearance.styleHoliday);
    const row = tab.querySelector('#sp-holiday-snow-field');
    expect(row.hidden).toBe(true);

    radios[2].checked = true;
    radios[2].dispatchEvent(new Event('change', { bubbles: true }));
    expect(settings.set).toHaveBeenCalledWith('player.uiStyle', 'holiday');
    expect(row.hidden).toBe(false);

    const snow = tab.querySelector('#sp-holiday-snow');
    expect(snow.checked).toBe(true);                   // default on (store.js)
    snow.checked = false;
    snow.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store['player.holidaySnow']).toBe(false);

    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(row.hidden).toBe(true);
  });

  it('opened with Holiday saved: Holiday is checked, the snow row shows its saved state', async () => {
    const { tab } = await appearanceTab({ 'player.uiStyle': 'holiday', 'player.holidaySnow': false });
    expect(tab.querySelector('input[name=uiStyle][value=holiday]').checked).toBe(true);
    expect(tab.querySelector('#sp-holiday-snow-field').hidden).toBe(false);
    expect(tab.querySelector('#sp-holiday-snow').checked).toBe(false);
  });
});

describe('holiday.css keeps the snow off videos and off for reduced motion (rules checked live in the sandbox)', () => {
  const CSS = fs.readFileSync('renderer/styles/holiday.css', 'utf8').replace(/\r\n/g, '\n');
  it('hidden while the player container is on screen (the player, or the docked mini player)', () => {
    expect(CSS).toMatch(/:root\[data-season="holiday"\]:has\(#player-container:not\(\[hidden\]\)\) \.holiday-snow \{ display: none; \}/);
  });
  it('hidden under prefers-reduced-motion, and with "Falling snow" off', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n\s+:root\[data-season="holiday"\] \.holiday-snow \{ display: none; \}/);
    expect(CSS).toMatch(/:root\[data-season="holiday"\]:not\(\[data-snow="off"\]\) \.holiday-snow \{/);
  });
  it('every colour rule is scoped to Holiday: Classic and Modern are untouched', () => {
    const selectors = CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/^[^{}@\n][^{}]*(?=\{)/gm).map((s) => s.trim()).filter((s) => !/^(from|to)$/.test(s));
    const unscoped = selectors.filter((s) => !s.includes('[data-season="holiday"]'));
    expect(unscoped.sort()).toEqual(['.holiday-snow', '.holiday-snow i', '.nav-bar__holiday-logo'].sort());
  });
});
