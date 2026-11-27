/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL app.js variant button and dropdown render into
 * a document, with the REAL i18n and the real French bundle (notes/CLAUDE.md
 * "Test environments").
 */
// verify-1 (2026-11-07, cosmetic; also in v0.9.2): the desktop player's
// variant button and dropdown read 'Default' in every language (seen in
// French and German, next to 'Éditeur' / 'Appareils'). The library scan
// (electron/library-scan.js) labels a script with no label of its own
// 'Default', in English, and the player showed the label as it is. That word
// is also what a pin (library.preferredVariants), the pop-out's switch and
// the phone match on, so the DATA keeps it: only the words shown change.
//
// FN-03 (2026-11-16, Dave: "the default means nothing"): the words shown are
// now the script's own FILE name, in every language, with a "main" marker in
// the user's language beside the script the video opens on. These cases
// pinned the translated "Par défaut" and now pin that (updated, not deleted);
// tests/unit/variant-names.test.js has the rest of FN-03.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const FR = bundle('fr');

const VIDEO = 'C:\\sandbox\\library\\Variant Clip.mp4';
const SCANNED = () => [
  { label: 'Default', path: 'C:\\sandbox\\library\\Variant Clip.funscript', name: 'Variant Clip.funscript' },
  { label: 'soft', path: 'C:\\sandbox\\library\\Variant Clip (soft).funscript', name: 'Variant Clip (soft).funscript' },
];

let Lifted;
let app;
let toasts;
let relays;
let pins;

beforeAll(() => {
  Lifted = liftAppClass(['_updateVariantSelector', '_showVariantDropdown', '_markVariantItemIfMissing', '_variantLabelText', '_streamPlayerWindowData'], {
    document, window, t, PLAYERWIN,
    showToast: (text) => toasts.push(String(text)),
  });
});

beforeEach(() => {
  _setBundlesForTests('fr', FR, EN);
  toasts = [];
  relays = [];
  pins = new Map();
  document.body.innerHTML = `
    <div id="variant-selector" hidden>
      <button id="variant-btn"><span id="variant-btn-label"></span></button>
      <div id="variant-dropdown" hidden></div>
    </div>`;
  window.funsync = { playerPopoutRelay: (dir, p) => { if (dir === 'to-popout') relays.push(p); } };
  app = Object.assign(new Lifted(), {
    settings: { get: () => undefined },
    funscriptEngine: {
      isLoaded: true, getRawContent: () => '{}', getActions: () => [], getChapters: () => [], getBookmarks: () => [],
    },
    videoPlayer: { duration: 60 },
    _currentVideoPath: VIDEO,
    _currentVariants: SCANNED(),
    _activeVariantPath: null,
    _activeVariantIndex: 0,
    _manualVariantsFor: () => [],
    _getPreferredVariantLabel: (p) => pins.get(p) ?? null,
    _setPreferredVariantLabel: (p, label) => { if (label) pins.set(p, label); else pins.delete(p); },
    _switchVariant: vi.fn(),
    _showAddVariantModal: vi.fn(),
    _playerWindowOpen: true,
  });
});

describe('the scan\'s unlabelled variant reads in the user\'s language', () => {
  it('the button and the dropdown say "Variant Clip", not "Default" or "Par défaut"; a real label stays as it is', () => {
    app._updateVariantSelector();
    expect(document.getElementById('variant-btn-label').textContent).toBe('Variant Clip');
    app._showVariantDropdown();
    const items = [...document.querySelectorAll('.variant-selector__item-label')].map((el) => el.textContent);
    expect(items).toEqual(['Variant Clip', 'soft']);
    expect(document.body.textContent).not.toContain('Default');
    expect(document.body.textContent).not.toContain(FR.variants.defaultLabel);
    // The marker beside it comes from the bundle (French here).
    const mains = [...document.querySelectorAll('.variant-selector__main-tag')].map((el) => el.textContent);
    expect(mains).toEqual([t('variants.mainTag')]);
  });

  it('starring it still pins the label the data matches on, and the toast says it in French', () => {
    app._updateVariantSelector();
    app._showVariantDropdown();
    document.querySelector('.variant-selector__star').click();
    expect(pins.get(VIDEO)).toBe('Default');
    expect(toasts).toEqual([t('variants.defaultSet', { label: 'Variant Clip' })]);
  });

  it('the player pop-out is sent the shown text beside the label it switches on', () => {
    app._updateVariantSelector();
    app._streamPlayerWindowData();
    const msg = relays.find((m) => m.type === PLAYERWIN.VARIANTS);
    expect(msg.list.map((v) => [v.label, v.text, v.main])).toEqual([['Default', 'Variant Clip', true], ['soft', 'soft', false]]);
    expect(msg.activeLabel).toBe('Default');
    expect(msg.activeIndex).toBe(0);
    expect(msg.mainTag).toBe(t('variants.mainTag'));
  });
});
