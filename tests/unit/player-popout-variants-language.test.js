/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Block F verify-1 (2026-11-16, FN-03, cosmetic, new since v0.9.2): with the
// player pop-out open, a live language switch translated the window's
// controls but its variation menu kept the old word for "main" until the
// window was reopened. The menu's word comes from main (`mainTag` in the
// VARIANTS message, FN-03), and a switch sent the window only the new locale.
// Now main sends the variation list again, after the locale, in the new
// language. The pop-out's side (it paints `mainTag` as sent) is pinned in
// player-popout-renderer.test.js.
//
// The REAL app.js methods (lifted: the language hook, _streamPlayerWindowData,
// _variantLabelText) on the REAL event bus; the relay is recorded. Asserted:
// what the window is sent, in order.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { APP_SRC, liftMethod } from './helpers/app-methods.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const WORDS = { en: 'main', de: 'Hauptskript' };
let lang = 'en';
const t = (k) => (k === 'variants.mainTag' ? WORDS[lang] : k);

const METHODS = ['_wirePlayerChromeLanguage', '_retranslatePlayerChrome', '_streamPlayerWindowData', '_variantLabelText'];
const sent = [];
const fakeWindow = { funsync: { playerPopoutRelay: (dir, msg) => { if (dir === 'to-popout') sent.push(msg); } } };
// eslint-disable-next-line no-new-func
// The main window's own chrome is not under test here: no element is found.
const fakeDocument = { getElementById: () => null };
const Lifted = new Function('eventBus', 'PLAYERWIN', 't', 'window', 'document',
  `return class { ${METHODS.map((n) => liftMethod(APP_SRC, n)).join('\n\n')} };`,
)(eventBus, PLAYERWIN, t, fakeWindow, fakeDocument);

let saved;
let app;

beforeEach(() => {
  saved = eventBus._handlers;
  eventBus._handlers = new Map();
  sent.length = 0;
  lang = 'en';
  app = Object.assign(new Lifted(), {
    videoPlayer: { duration: 60, refreshLabels() {} },
    funscriptEngine: { isLoaded: false },
    _updatePlayerWindowButton() {},
    _updatePlayerSyncChip() {},
    _getConnectedDeviceCount: () => 0,
    _allVariantsWithManual: [
      { label: 'Default', path: 'C:/v/Paren Clip.funscript', name: 'Paren Clip.funscript' },
      { label: 'Soft', path: 'C:/v/Paren Clip (Soft).funscript', name: 'Paren Clip (Soft).funscript' },
    ],
    _mainVariantIndex: 0,
    _activeVariantIndex: 1,
    _activeVariantPath: 'C:/v/Paren Clip (Soft).funscript',
    _playerWindowOpen: true,
  });
  app._wirePlayerChromeLanguage();
});

afterEach(() => {
  eventBus._handlers = saved;
});

describe('a live language switch reaches the pop-out\'s variation menu', () => {
  it('the locale goes first, then the list again with the new word for "main", nothing else changed', () => {
    lang = 'de';
    eventBus.emit('language:changed', { locale: 'de' });
    expect(sent.map((m) => m.type)).toEqual([PLAYERWIN.LOCALE, PLAYERWIN.VARIANTS]);
    const variants = sent[1];
    expect(variants.mainTag).toBe('Hauptskript');
    expect(variants.list.map((v) => [v.text, v.main])).toEqual([['Paren Clip', true], ['Soft', false]]);
    expect(variants.activeIndex).toBe(1);
  });

  it('this window\'s chip: with hand-added variations none of which plays (index -1), "No script" is said again in the new language', () => {
    const chip = { textContent: 'syncChip.noScript@en' };
    fakeDocument.getElementById = (id) => (id === 'variant-btn-label' ? chip : null);
    app._activeVariantIndex = -1;
    app._activeVariantPath = null;
    lang = 'de';
    eventBus.emit('language:changed', { locale: 'de' });
    fakeDocument.getElementById = () => null;
    expect(chip.textContent).toBe('syncChip.noScript');
  });

  it('control: no pop-out open, nothing is sent', () => {
    app._playerWindowOpen = false;
    lang = 'de';
    eventBus.emit('language:changed', { locale: 'de' });
    expect(sent).toEqual([]);
  });
});
