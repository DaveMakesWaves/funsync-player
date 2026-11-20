/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds its tabs as DOM, modal.css
 * is run through jsdom's cascade, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Settings cosmetics (app test V52).
//
//  (a) "Find duplicates…" used class `settings-panel__btn`, which no
//      stylesheet defines, so it rendered as a bare native button next to the
//      styled Snapshot / Export buttons.
//  (b) The Security tab used `settings-panel__row` / `settings-panel__label`,
//      also undefined: the label came out at the base font size with the
//      switch butted against it.
//  (c) A select in a field row could not shrink below its longest option, so
//      the German Edge Hold option pushed the Playback area into a horizontal
//      scrollbar. jsdom has no layout; the overflow itself was measured in
//      the real app. What is checked here is the computed style that lets
//      the select shrink.
//  (e) de.json (and the same batch of strings in fr/es) spelled umlauts and
//      accents as ASCII: "Geraetesimulators", "kraeftig", "ueber",
//      "Opacite", "Que tan solido"...
//
// (d), the "Snapshot taken" toast under the modal backdrop, was not a bug:
// the toast container sits above every backdrop (z-index 2000 vs 1000) and
// was caught mid-fade. Checked live, see UPDATES.md.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');

afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = fs.readFileSync('renderer/styles/modal.css', 'utf8');
  document.head.appendChild(style);
  _setBundlesForTests('en', EN, EN);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

const settings = () => ({ get: () => undefined, set: () => {}, getAll: () => ({}) });

function mount(tab) {
  const panel = new SettingsPanel({ settings: settings() });
  const el = panel[tab]();
  // Inside a real panel content column, as the app mounts it.
  const content = document.createElement('div');
  content.className = 'settings-panel__content';
  content.appendChild(el);
  document.body.appendChild(content);
  return el;
}

const LOOK = ['background-color', 'border-top-style', 'border-top-width', 'border-radius', 'padding-top', 'font-size', 'cursor', 'width'];
const look = (el) => Object.fromEntries(LOOK.map((p) => [p, getComputedStyle(el).getPropertyValue(p)]));

describe('(a) Find duplicates button', () => {
  it('looks like the other Data-tab buttons', () => {
    const tab = mount('_buildDataTab');
    const dupes = tab.querySelector('#sp-find-duplicates');
    const export_ = tab.querySelector('#sp-export');
    expect(look(dupes)).toEqual(look(export_));
    expect(getComputedStyle(dupes).borderTopStyle).toBe('solid');
  });
});

describe('(b) Security tab row', () => {
  it('uses the same label size and row layout as every other setting', () => {
    const security = mount('_buildSecurityTab');
    const label = security.querySelector('.settings-panel__section label');
    const row = label.parentElement;

    const playback = mount('_buildPlaybackTab');
    const refLabel = playback.querySelector('label[for="sp-mini-player"]');
    const refRow = refLabel.parentElement;

    expect(getComputedStyle(label).fontSize).toBe(getComputedStyle(refLabel).fontSize);
    expect(getComputedStyle(label).color).toBe(getComputedStyle(refLabel).color);
    expect(getComputedStyle(row).display).toBe('flex');
    expect(getComputedStyle(row).gap).toBe(getComputedStyle(refRow).gap);
    // The switch is still in the row, after its label.
    expect(row.querySelector('[role="switch"], button')).not.toBeNull();
  });
});

describe('(c) selects in a field row can shrink', () => {
  it('the Edge Hold select is allowed below its longest option', () => {
    const tab = mount('_buildPlaybackTab');
    const select = tab.querySelector('#sp-edge-mode');
    expect(select.parentElement.classList.contains('settings-panel__field')).toBe(true);
    expect(getComputedStyle(select).minWidth).toBe('0px');
    expect(getComputedStyle(select).maxWidth).toBe('100%');
  });
});

describe('(e) no ASCII-spelled umlauts or accents', () => {
  const flat = (o, p = '', out = {}) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') flat(v, `${p}${k}.`, out);
      else out[`${p}${k}`] = String(v);
    }
    return out;
  };
  // Stems that are always written with the mark in that language. A
  // transliteration of any of them is a typing shortcut, never a spelling.
  const BANNED = {
    de: /(?<![A-Za-zÄÖÜäöüß])(ueber|Ueber|fuer|Fuer|Geraet\w*|geraet\w*|Menue|kraeftig\w*|spruehen|ausgeloest|koennen|moechte\w*|waehl\w*|Waehl\w*|zurueck|Zurueck|oeffn\w*|Oeffn\w*|loesch\w*|Loesch\w*|aender\w*|Aender\w*|Schluessel\w*|hinzufueg\w*|Hinzufueg\w*|naechst\w*|Naechst\w*|groess\w*|Groess\w*)(?![A-Za-zÄÖÜäöüß])/,
    fr: /(?<![A-Za-zÀ-ÿ])(etre|definir|Opacite|opacite|apparait|declencher|Retablir|retablir|defaut|video|videos|parametres|Parametres|deja|tres)(?![A-Za-zÀ-ÿ])/,
    es: /(?<![A-Za-zÀ-ÿ])(menu|Que tan|solido|Muestralo|aqui|tambien|despues)(?![A-Za-zÀ-ÿ])/,
  };
  it.each(Object.keys(BANNED))('%s', (locale) => {
    const hits = Object.entries(flat(bundle(locale)))
      .filter(([, v]) => BANNED[locale].test(v))
      .map(([k, v]) => `${k}: ${v.match(BANNED[locale])[0]}`);
    expect(hits).toEqual([]);
  });
});

// (f) FT-039: at 125% on a 1280x800 screen Settings showed one scrollbar
// inside another. The dialog body (overflow-y: auto, every dialog) scrolled
// as well as the content column, because the rail (~430 px with Playback's
// section links) plus the Done button were taller than the body could hold,
// and the Done button scrolled out of view. Measured live 2026-11-05 at
// 1024x640 CSS px: body 518 in 478, two nested scrollers. Settings now opens
// with its own panel class; jsdom has no layout, so this checks the computed
// styles that make the body a non-scrolling flex column (the live
// measurement is in UPDATES.md and is the verifier's).
describe('(f) Settings has its own dialog layout (FT-039)', () => {
  const css = (el, p) => getComputedStyle(el).getPropertyValue(p);

  it('opens with modal-panel--settings: the body never scrolls, the content column and the rail can', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="app"></div><div id="toast-container"></div>');
    const closed = new SettingsPanel({ settings: settings() }).show();
    const panel = document.querySelector('.modal-panel');
    expect(panel.classList.contains('modal-panel--settings')).toBe(true);

    const body = panel.querySelector('.modal-body');
    expect(css(body, 'overflow-y')).toBe('hidden');
    expect(css(body, 'display')).toBe('flex');
    expect(css(body, 'flex-direction')).toBe('column');
    expect(css(body, 'min-height')).toBe('0px');
    expect(css(panel, 'max-height')).toBe('92vh');

    const layout = panel.querySelector('.settings-panel__layout');
    expect(css(layout, 'min-height')).not.toBe('320px'); // never taller than a short window
    expect(css(layout, 'flex-shrink')).toBe('1');
    expect(css(panel.querySelector('.settings-panel__rail'), 'overflow-y')).toBe('auto');
    expect(css(panel.querySelector('.settings-panel__rail'), 'position')).toBe('static');
    const content = panel.querySelector('.settings-panel__content');
    expect(css(content, 'overflow-y')).toBe('auto');
    expect(css(content, 'min-height')).toBe('0px');
    expect(css(panel.querySelector('.settings-panel__done-btn'), 'flex-shrink')).toBe('0');

    panel.querySelector('.modal-close-btn').click();
    await closed;
  });

  it('every other dialog keeps the plain scrolling body and 85vh', async () => {
    const { Modal } = await import('../../renderer/components/modal.js');
    const answer = Modal.confirm('Title', 'Message');
    const panel = document.querySelector('.modal-panel');
    expect(panel.className).toBe('modal-panel');
    expect(css(panel.querySelector('.modal-body'), 'overflow-y')).toBe('auto');
    expect(css(panel, 'max-height')).toBe('85vh');
    panel.querySelector('.modal-close-btn').click();
    expect(await answer).toBe(null);
  });
});

// (g) FT-040: the German Edge Hold option "Drücken zum Anhalten (erneut
// drücken zum Fortsetzen)" was cut off in its select, and so were both French
// options, the Spanish "Pulsar…" one and both Russian ones. Measured live
// 2026-11-05 (canvas measureText with the select's font, plus its padding, at
// 100% and 125%): the old text needed up to 382 px in selects of 305-353 px;
// the short forms need at most 270 px in 226-290 px. The full explanation is
// in edgeModeHint. jsdom has no layout, so the guard here is length: every
// locale's options stay within the longest that measured to fit.
describe('(g) Edge Hold options fit their select in every locale (FT-040)', () => {
  const OLD = {
    de: ['Halten zum Edgen (beim Loslassen weiter)', 'Drücken zum Anhalten (erneut drücken zum Fortsetzen)'],
    fr: ['Maintenir pour edger (reprise au relâchement)', 'Appuyer pour arrêter (appuyer de nouveau pour reprendre)'],
    es: ['Mantener para edging (reanuda al soltar)', 'Pulsar para parar (pulsa otra vez para reanudar)'],
    ru: ['Удерживать для паузы (возобновление при отпускании)', 'Нажать для паузы (нажать снова для возобновления)'],
  };
  it.each(['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'])('%s', (l) => {
    _setBundlesForTests(l, bundle(l), EN);
    const tab = mount('_buildPlaybackTab');
    const texts = [...tab.querySelectorAll('#sp-edge-mode option')].map((o) => o.textContent);
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text.length, text).toBeLessThanOrEqual(37);
    if (OLD[l]) expect(texts).not.toEqual(OLD[l]);
    // The full sentence is still there for whoever needs it.
    expect(tab.querySelector('#sp-edge-mode-hint').textContent.length).toBeGreaterThan(40);
  });
});
