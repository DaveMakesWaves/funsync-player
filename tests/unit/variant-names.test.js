// FN-03 (Dave 2026-11-16: "variations as a whole need an overhaul the default
// means nothing, the name of the currently assigned script should be
// highlighted but just showing it as default is a pain"; also in v0.9.2).
//
// The library scan labels a script with no label of its own 'Default', and
// every variation list showed that word (translated since 2026-11-07): the
// player's menu and chip, Manage variations, the Associate dialog, the
// pop-out and the phone. It named nothing: "Default" was the video's own
// sidecar even where an association was what played. Now each entry is shown
// by its own label or, unlabelled, its FILE name; the script the video opens
// on is marked "main"; the playing entry is tinted, ticked and announced as
// current (aria-current), so it is not told by colour alone. The DATA keeps
// 'Default' (pins, the pop-out's and the phone's switch match on labels).
//
// The REAL app.js methods (lifted, helpers/app-methods.js) render into a
// jsdom document with the REAL i18n and Modal; renderer/js/variant-names.js
// is the shared rule (the registration and the Associate dialog use it).
// The pop-out's rows are in player-popout-renderer.test.js, the Associate
// dialog's in association-variant-list.test.js, the phone's in
// web-remote-variation-names.test.js and backend/tests/test_remote.py.
//
// jsdom (no docblock): the menu and Modal render into a document.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import {
  variantDisplayName, isUnlabelledVariant, variantFileStem, remoteVariantList, UNLABELLED_VARIANT,
} from '../../renderer/js/variant-names.js';

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { Modal } = await import('../../renderer/components/modal.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const VIDEO = 'C:\\Lib\\Clip.mp4';
const OWN = 'C:\\Lib\\Clip.funscript';
const SOFT = 'C:\\Lib\\Clip (soft).funscript';
const ASSOC = 'C:\\Lib\\Scripts\\Clip Custom Take.funscript';
const HARD = 'C:\\Lib\\Scripts\\Clip hard remix.funscript';
const NAMELESS = 'C:\\Lib\\Scripts\\Clip night edit.funscript';

describe('the naming rule (variant-names.js)', () => {
  it('an entry with its own label is shown by it; an unlabelled one by its file name', () => {
    expect(variantDisplayName({ label: 'soft', path: SOFT, name: 'Clip (soft).funscript' })).toBe('soft');
    expect(variantDisplayName({ label: 'Default', path: OWN, name: 'Clip.funscript' })).toBe('Clip');
    expect(variantDisplayName({ label: '', path: OWN })).toBe('Clip');
    expect(variantDisplayName({ label: '  Default ', path: 'D:/x/Some Take.FUNSCRIPT' })).toBe('Some Take');
    expect(variantDisplayName({ label: 'Default' })).toBe('');
  });

  it('the data word stays the data word', () => {
    expect(UNLABELLED_VARIANT).toBe('Default');
    expect(isUnlabelledVariant({ label: 'Default' })).toBe(true);
    expect(isUnlabelledVariant({ label: 'Defaults' })).toBe(false);
    expect(variantFileStem({ path: 'D:\\a\\b.funscript' })).toBe('b');
  });

  it('app.js names an entry exactly as the shared rule does (the two are kept together)', () => {
    const Lifted = liftAppClass(['_variantLabelText'], { t: (k) => `t:${k}` });
    const app = new Lifted();
    const table = [
      { label: 'soft', path: SOFT, name: 'Clip (soft).funscript' },
      { label: 'Default', path: OWN, name: 'Clip.funscript' },
      { label: 'Default', path: OWN },
      { label: '', name: 'Other.funscript' },
      { label: 'Hard Remix', path: HARD },
      { label: ' Default', path: 'D:/x/Some Take.FUNSCRIPT' },
    ];
    for (const v of table) expect(app._variantLabelText(v)).toBe(variantDisplayName(v));
    // Nothing at all to name: the translated word, the one case left for it.
    expect(app._variantLabelText({ label: 'Default' })).toBe('t:variants.defaultLabel');
  });

  it('the phone\'s list marks the script the video opens on and copies every entry', () => {
    const scanned = [{ label: 'Default', path: OWN, name: 'Clip.funscript' }, { label: 'soft', path: SOFT, name: 'Clip (soft).funscript' }];
    const video = { funscriptPath: OWN, variants: scanned };
    const list = remoteVariantList(video, [{ label: 'Hard Remix', path: HARD, name: 'Clip hard remix.funscript' }]);
    expect(list.map((v) => [v.text, v.main])).toEqual([['Clip', true], ['soft', false], ['Hard Remix', false]]);
    list[0].label = 'changed';
    expect(scanned[0].label).toBe('Default');
    // A hand-added entry is never "main", even when nothing else is listed.
    expect(remoteVariantList({ funscriptPath: null, variants: [] }, [{ label: 'X', path: HARD }])
      .map((v) => v.main)).toEqual([false]);
  });
});

// ---- The player's variation menu and chip ----

let Lifted;
let app;
let relays;
let toasts;
let switched;

beforeAll(() => {
  Lifted = liftAppClass([
    '_updateVariantSelector', '_showVariantDropdown', '_markVariantItemIfMissing', '_variantLabelText', '_streamPlayerWindowData',
    '_showManageVariantsModal', '_cycleVariant',
  ], {
    document, window, t, PLAYERWIN, Modal,
    showToast: (text) => toasts.push(String(text)),
  });
});

function build({ scanned, manual = [], mainPath = OWN, loaded = true, activePath = null }) {
  const store = { 'library.manualVariants': manual.length ? { [VIDEO]: manual } : {} };
  return Object.assign(new Lifted(), {
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    funscriptEngine: {
      isLoaded: loaded, getRawContent: () => (loaded ? '{}' : null),
      getActions: () => [], getChapters: () => [], getBookmarks: () => [],
    },
    videoPlayer: { duration: 60 },
    scriptEditor: { _funscriptPath: mainPath },
    _currentVideoPath: VIDEO,
    _currentVideoName: 'Clip.mp4',
    _currentVariants: scanned,
    _activeVariantPath: activePath,
    _activeVariantIndex: 0,
    _variantsPhoneEpoch: null,
    _videoLoadGen: 7,
    _mainScript: { gen: 7, path: loaded ? mainPath : null },
    _manualVariantsFor: (p) => store['library.manualVariants'][p] || [],
    _getPreferredVariantLabel: () => null,
    _setPreferredVariantLabel: () => {},
    _switchVariant: (i) => switched.push(i),
    _showAddVariantModal: vi.fn(),
    _playerWindowOpen: true,
  });
}

const chipText = () => document.getElementById('variant-btn-label').textContent;
const menuRows = () => [...document.querySelectorAll('#variant-dropdown .variant-selector__item')].map((el) => ({
  name: el.querySelector('.variant-selector__item-label').textContent,
  main: !!el.querySelector('.variant-selector__main-tag'),
  playing: el.getAttribute('aria-current') === 'true',
  tinted: el.classList.contains('variant-selector__item--active'),
  tick: el.querySelector('.variant-selector__check')?.textContent ?? null,
}));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  relays = [];
  toasts = [];
  switched = [];
  document.body.innerHTML = `
    <div id="variant-selector" hidden>
      <button id="variant-btn"><span id="variant-btn-label"></span></button>
      <div id="variant-dropdown" hidden></div>
    </div>`;
  window.funsync = { playerPopoutRelay: (dir, p) => { if (dir === 'to-popout') relays.push(p); } };
});

afterEach(() => {
  document.querySelector('.modal-close-btn')?.click();
  delete window.funsync;
});

const SCANNED = () => [
  { label: 'Default', path: OWN, name: 'Clip.funscript' },
  { label: 'soft', path: SOFT, name: 'Clip (soft).funscript' },
];
const MANUAL = () => [
  { label: 'Hard Remix', path: HARD, name: 'Clip hard remix.funscript' },
  // A hand-added name that is the data word itself: named by its file too.
  { label: 'Default', path: NAMELESS, name: 'Clip night edit.funscript' },
];

describe('FN-03: the player\'s menu and chip name every script and mark the one that plays', () => {
  it('the sidecar is named by its file and marked main; no entry reads "Default"', () => {
    app = build({ scanned: SCANNED(), manual: MANUAL() });
    app._updateVariantSelector();
    app._showVariantDropdown();
    expect(chipText()).toBe('Clip');
    expect(menuRows().map((r) => [r.name, r.main])).toEqual([
      ['Clip', true], ['soft', false], ['Hard Remix', false], ['Clip night edit', false],
    ]);
    expect(document.getElementById('variant-dropdown').textContent).not.toContain('Default');
    expect(document.querySelector('.variant-selector__main-tag').textContent).toBe(t('variants.mainTag'));
  });

  it('the playing entry is tinted, ticked and announced as current; the others are not', () => {
    app = build({ scanned: SCANNED(), manual: MANUAL(), activePath: HARD });
    app._updateVariantSelector();
    app._showVariantDropdown();
    expect(chipText()).toBe('Hard Remix');
    expect(menuRows().map((r) => [r.name, r.playing, r.tinted, r.tick])).toEqual([
      ['Clip', false, false, ''], ['soft', false, false, ''], ['Hard Remix', true, true, '✓'], ['Clip night edit', false, false, ''],
    ]);
  });

  it('an association over the sidecar: the association is main, the sidecar named by its file', () => {
    app = build({
      scanned: [{ label: 'Clip Custom Take', path: ASSOC, name: 'Clip Custom Take.funscript' }, ...SCANNED()],
      mainPath: ASSOC,
    });
    app._updateVariantSelector();
    app._showVariantDropdown();
    expect(menuRows().map((r) => [r.name, r.main, r.playing])).toEqual([
      ['Clip Custom Take', true, true], ['Clip', false, false], ['soft', false, false],
    ]);
  });

  it('no list from the scan (a fuzzy-paired script): the script it opened on, by its file, main, in French too', () => {
    // French: the entry the menu makes up for it was labelled with the
    // TRANSLATED word, which the naming rule did not know as the data word.
    _setBundlesForTests('fr', JSON.parse(fs.readFileSync('renderer/locales/fr.json', 'utf8')), EN);
    app = build({ scanned: [], manual: [MANUAL()[0]], mainPath: 'C:\\Lib\\Clip HD.funscript' });
    app._updateVariantSelector();
    app._showVariantDropdown();
    expect(chipText()).toBe('Clip HD');
    expect(menuRows().map((r) => [r.name, r.main])).toEqual([['Clip HD', true], ['Hard Remix', false]]);
    // The made-up entry carries the data word, so a pin on it matches.
    expect(app._allVariantsWithManual[0].label).toBe('Default');
  });

  it('a main script that is in no entry (a multi-axis main) marks none', () => {
    app = build({ scanned: SCANNED(), mainPath: 'C:\\Lib\\Multi Main.funscript' });
    app._updateVariantSelector();
    app._showVariantDropdown();
    expect(menuRows().some((r) => r.main)).toBe(false);
  });

  it('nothing to name (no script, no variation): the chip says so, not "Default"', () => {
    app = build({ scanned: [], loaded: false });
    app._updateVariantSelector();
    expect(chipText()).toBe(t('syncChip.noScript'));
    expect(chipText()).not.toBe(EN.variants.defaultLabel);
  });

  it('the pop-out is sent each entry\'s name, its main mark, the word for it and the playing place', () => {
    app = build({ scanned: SCANNED(), manual: MANUAL(), activePath: SOFT });
    app._updateVariantSelector();
    app._streamPlayerWindowData();
    const msg = relays.find((m) => m.type === PLAYERWIN.VARIANTS);
    expect(msg.list.map((v) => [v.label, v.text, v.main])).toEqual([
      ['Default', 'Clip', true], ['soft', 'soft', false], ['Hard Remix', 'Hard Remix', false], ['Default', 'Clip night edit', false],
    ]);
    expect(msg.activeIndex).toBe(1);
    expect(msg.mainTag).toBe(t('variants.mainTag'));
  });

  it('V / Shift+V still step through the list in its order', () => {
    app = build({ scanned: SCANNED(), manual: MANUAL() });
    app._updateVariantSelector();
    app._cycleVariant(1);
    app._cycleVariant(-1);
    expect(switched).toEqual([1, 3]);
  });
});

describe('FN-03: Manage variations names each hand-added one and marks the one that plays', () => {
  it('the playing variation is tinted, ticked and current; a hand-added "Default" is named by its file', async () => {
    app = build({ scanned: SCANNED(), manual: MANUAL(), activePath: HARD });
    app._updateVariantSelector();
    const done = app._showManageVariantsModal();
    await new Promise((r) => setTimeout(r, 0));
    const rows = [...document.querySelectorAll('.modal-body .modal-list-item')].map((row) => ({
      name: row.querySelector('.modal-list-item-label').textContent,
      playing: row.getAttribute('aria-current') === 'true',
      tick: row.querySelector('.variant-selector__check')?.textContent ?? null,
    }));
    expect(rows).toEqual([
      { name: 'Hard Remix', playing: true, tick: '✓' },
      { name: 'Clip night edit', playing: false, tick: '' },
    ]);
    document.querySelector('.modal-close-btn').click();
    await done;
  });
});
