/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds its dialog as DOM and
 * i18n.js / settings-panel.js branch on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// Long hints fold (design review, 2026-11-23; DESIGN.md §1.8, §2.14; Nielsen
// #8): 13 of 82 settings hints ran over 200 characters, the global hotkeys
// hint 558. A hint wider than HINT_FOLD_UNITS now shows two lines and a
// "More" button; "Less" folds it again. The text stays in the DOM, so the
// settings search still finds words in the folded part, and while a search
// runs every fold opens (modal.css).
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel, hintWidthUnits, HINT_FOLD_UNITS } from '../../renderer/components/settings-panel.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const JA = bundle('ja');

let showing = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(async () => {
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
  showing = null;
});
afterAll(() => _setBundlesForTests('en', EN, EN));
beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

async function open() {
  const store = {};
  const panel = new SettingsPanel({ settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getAll: () => ({}) } });
  showing = panel.show();
  await flush();
  return panel;
}

const hotkeyHint = () => [...document.querySelectorAll('.settings-panel__hint')]
  .find((h) => h.textContent === EN.settingsPanel.playback.globalHotkeysHint);

describe('long settings hints fold behind More', () => {
  it('the 558-character global hotkeys hint folds; a short hint does not', async () => {
    await open();
    const hint = hotkeyHint();
    expect(hint).toBeTruthy();
    expect(hint.classList.contains('settings-panel__hint--folded')).toBe(true);
    const more = hint.nextElementSibling;
    expect(more.className).toBe('settings-panel__hint-more');
    expect(more.tagName).toBe('BUTTON');
    expect(more.getAttribute('aria-controls')).toBe(hint.id);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.textContent).toBe('More');
    // The whole text is still there (search, screen readers).
    expect(hint.textContent).toBe(EN.settingsPanel.playback.globalHotkeysHint);
    const short = [...document.querySelectorAll('.settings-panel__hint')].find((h) => h.textContent.length > 0 && h.textContent.length < 80);
    expect(short.classList.contains('settings-panel__hint--folded')).toBe(false);
    expect(short.nextElementSibling?.className).not.toBe('settings-panel__hint-more');
  });

  it('More opens it, Less folds it again', async () => {
    await open();
    const hint = hotkeyHint();
    const more = hint.nextElementSibling;
    more.click();
    expect(hint.classList.contains('settings-panel__hint--folded')).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.textContent).toBe('Less');
    more.click();
    expect(hint.classList.contains('settings-panel__hint--folded')).toBe(true);
    expect(more.textContent).toBe('More');
  });

  it('the search still finds a word that sits in the folded part, and "more" is not a word of every long hint', async () => {
    const panel = await open();
    // A word near the end of the long hint, well past two lines.
    panel._runSearch('F13');
    const hits = [...document.querySelectorAll('.settings-panel__content--searching')];
    expect(hits.length).toBe(1);
    const visibleHint = hotkeyHint();
    expect(visibleHint.closest('.settings-panel__search-hidden')).toBeNull();
    const items = panel._collectSearchItems();
    expect(items.some((it) => /\bMore\b/.test(it.text) && it.text.includes(EN.settingsPanel.playback.globalHotkeysHint.slice(0, 40)))).toBe(false);
  });

  it('every fold is per hint, counted in screen width (CJK characters count double)', () => {
    expect(hintWidthUnits('abc')).toBe(3);
    expect(hintWidthUnits('日本語')).toBe(6);
    expect(hintWidthUnits('한국어')).toBe(6);
    // The Japanese global hotkeys hint is shorter in characters but folds too.
    expect(JA.settingsPanel.playback.globalHotkeysHint.length).toBeLessThan(EN.settingsPanel.playback.globalHotkeysHint.length);
    expect(hintWidthUnits(JA.settingsPanel.playback.globalHotkeysHint)).toBeGreaterThan(HINT_FOLD_UNITS);
  });

  it('the CSS folds to two lines and opens every fold while searching', () => {
    const css = fs.readFileSync('renderer/styles/modal.css', 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\.settings-panel__hint--folded \{[^}]*-webkit-line-clamp: 2;/);
    expect(css).toMatch(/\.settings-panel__content--searching \.settings-panel__hint--folded \{[^}]*-webkit-line-clamp: unset;/);
    expect(css).toMatch(/\.settings-panel__content--searching \.settings-panel__hint-more \{ display: none; \}/);
  });
});
