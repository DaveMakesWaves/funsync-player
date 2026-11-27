/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL KeyboardHandler listens on `document`, the
 * Settings rows are real DOM (KeyCapture), and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Buck Nakkidd (Discord #feature-requests, 2026-11-27): "possible for a hot
// key mapping for zoom or removal of Ctrl+? sucks having to let go of device
// just to zoom in or out". Dave: zoom keys with no Ctrl, and "make a setting
// where users can choose a non coliding hotkey for these".
//
// The REAL KeyboardHandler built from app.js's REAL `_keyboardOptions`
// (lifted), real key presses; the REAL Settings rows (VRZoomKeysSettings)
// driven by clicking a capture box and pressing a key.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import {
  readVRZoomKeys, vrZoomKeyClash, vrZoomStepFor, VR_ZOOM_KEY_DEFAULTS, VR_ZOOM_KEYS_SETTING,
} from '../../renderer/js/vr-zoom-keys.js';
import { VRZoomKeysSettings } from '../../renderer/components/vr-zoom-keys-settings.js';
import { getPlayerShortcutGroups } from '../../renderer/js/keyboard-help.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const KEYBOARD_SRC = fs.readFileSync('renderer/js/keyboard.js', 'utf8');
const STORE_SRC = fs.readFileSync('electron/store.js', 'utf8');

beforeAll(() => _setBundlesForTests('en', EN, EN));

// Every KeyboardHandler binds to `document` for good: take each test's off.
let added = [];
let realAdd;
beforeEach(() => {
  added = [];
  realAdd = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    added.push([type, fn, opts]);
    realAdd(type, fn, opts);
  });
  document.body.innerHTML = '<div id="toast-container"></div>';
});
afterEach(() => {
  for (const [type, fn, opts] of added) document.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

function fakeSettings(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { get: (k) => map.get(k), set: vi.fn((k, v) => map.set(k, v)), map };
}

const Lifted = liftAppClass(['_keyboardOptions', '_currentView'], { readVRZoomKeys, VR_ZOOM_KEYS_SETTING });

function makeApp({ view = 'player', stereo = 'sbs-half', path = 'C:\\VR\\Scene_180_LR.mp4', settings = fakeSettings(), editorOpen = false } = {}) {
  const app = new Lifted();
  Object.assign(app, {
    videoPlayer: {
      video: { volume: 0.5 }, duration: 300, isVRProjecting: true,
      togglePlay: vi.fn(), skip: vi.fn(), seek: vi.fn(), setVolume: vi.fn(), toggleMute: vi.fn(),
      toggleFullscreen: vi.fn(), captureScreenshot: vi.fn(), toggleInfoOverlay: vi.fn(),
      setLoopPoint: vi.fn(), clearAbLoop: vi.fn(), cycleAspectRatio: vi.fn(), cyclePlaybackRate: vi.fn(),
    },
    settings,
    scriptEditor: editorOpen ? { isOpen: true } : null,
    connectionPanel: null,
    dragDrop: { _openNativeDialog: vi.fn() },
    queuePanel: null,
    _navStack: view === 'library' ? ['library'] : ['library', view],
    _currentStereoFormat: stereo,
    _currentVideoPath: path,
    _navigateTo: vi.fn(),
    _toggleQueuePanel: vi.fn(),
    _jumpChapter: vi.fn(),
    _jumpBookmark: vi.fn(),
    _playNext: vi.fn(),
    _playPrev: vi.fn(),
    _playerWindowPlayback: vi.fn(() => false),
  });
  return app;
}

function wire(app) {
  const handler = new KeyboardHandler(app._keyboardOptions());
  if (app.scriptEditor) handler.scriptEditor = app.scriptEditor;
  handler.onVRZoom = vi.fn();
  handler.onVRZoomReset = vi.fn();
  return handler;
}

function key(keyName, code, init = {}) {
  const e = new KeyboardEvent('keydown', { key: keyName, code, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
}

describe('a VR video zooms on one key, no Ctrl', () => {
  it('= zooms in, the "+" key (Shift+=) too, - zooms out, and the numpad + / - as well; the page keeps none of them', () => {
    const kb = wire(makeApp());
    for (const [k, code, init, step] of [
      ['=', 'Equal', {}, 1], ['+', 'Equal', { shiftKey: true }, 1], ['-', 'Minus', {}, -1],
      ['+', 'NumpadAdd', {}, 1], ['-', 'NumpadSubtract', {}, -1],
    ]) {
      kb.onVRZoom.mockClear();
      const e = key(k, code, init);
      expect(kb.onVRZoom, `${code}${init.shiftKey ? ' with Shift' : ''}`).toHaveBeenCalledWith(step);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it('Ctrl+= is still one zoom step (the Ctrl keys answer first), Ctrl+0 still resets', () => {
    const kb = wire(makeApp());
    key('=', 'Equal', { ctrlKey: true });
    expect(kb.onVRZoom).toHaveBeenCalledTimes(1);
    key('0', 'Digit0', { ctrlKey: true });
    expect(kb.onVRZoomReset).toHaveBeenCalledTimes(1);
  });

  it('only with a VR video open in the player and the editor closed: elsewhere = and - are left alone', () => {
    for (const app of [
      makeApp({ view: 'library' }),
      makeApp({ stereo: null }),                     // a flat video
      makeApp({ editorOpen: true }),                 // the editor's own + / - zoom its timeline
    ]) {
      const kb = wire(app);
      const e = key('=', 'Equal');
      expect(kb.onVRZoom).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it('the keys chosen in Settings zoom instead of the defaults; a removed key zooms nothing', () => {
    const settings = fakeSettings({ [VR_ZOOM_KEYS_SETTING]: { in: { code: 'KeyT', mods: {} }, out: null } });
    const kb = wire(makeApp({ settings }));
    key('t', 'KeyT');
    expect(kb.onVRZoom).toHaveBeenCalledWith(1);
    kb.onVRZoom.mockClear();
    key('=', 'Equal');
    key('-', 'Minus');
    expect(kb.onVRZoom, 'the old keys and the removed one do nothing').not.toHaveBeenCalled();
    key('-', 'NumpadSubtract');
    expect(kb.onVRZoom, 'the numpad still zooms').toHaveBeenCalledWith(-1);
  });
});

describe('a zoom key never collides with another key', () => {
  // Every single letter the player's handler has a case for, read from
  // keyboard.js itself, so a player key added later is refused here too.
  const playerLetters = [...new Set([...KEYBOARD_SRC.matchAll(/case '([a-zA-Z])':/g)].map((m) => m[1].toUpperCase()))];

  it(`every letter the player uses is refused, bare, with Shift or with Alt (${playerLetters.join('')})`, () => {
    expect(playerLetters.length).toBeGreaterThan(15);
    for (const c of playerLetters) {
      for (const mods of [{}, { shift: true }, { alt: true }]) {
        expect(vrZoomKeyClash({ code: `Key${c}`, mods }), `Key${c} ${JSON.stringify(mods)}`).toBe('player');
      }
    }
  });

  it('chapters, speed and help (, . ?), Alt+1/2/3, moving-around and system keys, Ctrl shortcuts and the other zoom key are refused', () => {
    expect(vrZoomKeyClash({ code: 'Comma', mods: {} })).toBe('player');
    expect(vrZoomKeyClash({ code: 'Period', mods: { shift: true } })).toBe('player');
    expect(vrZoomKeyClash({ code: 'Slash', mods: { shift: true } })).toBe('player');
    expect(vrZoomKeyClash({ code: 'Digit2', mods: { alt: true } })).toBe('player');
    for (const code of ['Space', 'Escape', 'ArrowUp', 'Home', 'Enter', 'Tab', 'F11', 'Backspace']) {
      expect(vrZoomKeyClash({ code, mods: {} }), code).toBe('system');
    }
    expect(vrZoomKeyClash({ code: 'KeyT', mods: { ctrl: true } })).toBe('menu');
    expect(vrZoomKeyClash({ code: 'Minus', mods: {} }, { other: { code: 'Minus', mods: {} } })).toBe('same');
  });

  it('free keys can be chosen: the defaults, unused letters, digits, Alt combos', () => {
    expect(vrZoomKeyClash(VR_ZOOM_KEY_DEFAULTS.in, { other: VR_ZOOM_KEY_DEFAULTS.out })).toBe(null);
    expect(vrZoomKeyClash(VR_ZOOM_KEY_DEFAULTS.out, { other: VR_ZOOM_KEY_DEFAULTS.in })).toBe(null);
    for (const code of ['KeyC', 'KeyT', 'KeyU', 'KeyW', 'KeyY', 'Digit5', 'BracketLeft', 'BracketRight']) {
      expect(vrZoomKeyClash({ code, mods: {} }), code).toBe(null);
    }
    expect(vrZoomKeyClash({ code: 'Digit5', mods: { alt: true } })).toBe(null);
  });

  it('the defaults are in the store (and match the module), and nothing stored reads as them', () => {
    expect(STORE_SRC).toContain("vrZoomKeys: { in: { code: 'Equal', mods: {} }, out: { code: 'Minus', mods: {} } },");
    expect(readVRZoomKeys(undefined)).toEqual({ in: VR_ZOOM_KEY_DEFAULTS.in, out: VR_ZOOM_KEY_DEFAULTS.out });
    expect(readVRZoomKeys({ in: null }).in).toBe(null);
  });

  it('a step needs Ctrl and Alt as bound: Ctrl+= is not the bare = key', () => {
    const keys = readVRZoomKeys(undefined);
    expect(vrZoomStepFor({ code: 'Equal', ctrlKey: true }, keys)).toBe(0);
    expect(vrZoomStepFor({ code: 'Equal', altKey: true }, keys)).toBe(0);
    expect(vrZoomStepFor({ code: 'Equal' }, keys)).toBe(1);
  });
});

describe('Settings > Keyboard > VR zoom keys', () => {
  function mount(settings) {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    new VRZoomKeysSettings({ element: slot, settings });
  }
  const row = (action) => document.querySelector(`.vr-zoom-keys__row[data-action="${action}"]`);
  const box = (action) => row(action).querySelector('.key-capture');
  const press = (action, init) => {
    box(action).click();
    box(action).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  };
  const toastTexts = () => [...document.querySelectorAll('.toast__body')].map((n) => n.textContent);

  it('shows the defaults; a free key is saved at once and zooms', () => {
    const settings = fakeSettings();
    mount(settings);
    expect(box('in').textContent).toBe('=');
    expect(box('out').textContent).toBe('-');
    press('in', { key: 't', code: 'KeyT' });
    expect(settings.map.get(VR_ZOOM_KEYS_SETTING)).toEqual({
      in: { code: 'KeyT', mods: { shift: false, ctrl: false, alt: false } },
      out: VR_ZOOM_KEY_DEFAULTS.out,
    });
    expect(box('in').textContent).toBe('T');
  });

  it('a key the player uses is refused with the reason, and the row keeps its key', () => {
    const settings = fakeSettings();
    mount(settings);
    press('in', { key: 'f', code: 'KeyF' });
    expect(settings.set).not.toHaveBeenCalled();
    expect(box('in').textContent).toBe('=');
    expect(toastTexts().join(' ')).toContain('F already does something in the player');
    press('out', { key: 'o', code: 'KeyO', ctrlKey: true });
    expect(toastTexts().join(' ')).toContain('is a menu shortcut');
    press('out', { key: '=', code: 'Equal' });
    expect(toastTexts().join(' ')).toContain('is already the other zoom key');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('back to the default key, and no key at all', () => {
    const settings = fakeSettings({ [VR_ZOOM_KEYS_SETTING]: { in: { code: 'KeyT', mods: {} }, out: VR_ZOOM_KEY_DEFAULTS.out } });
    mount(settings);
    row('in').querySelector('.vr-zoom-keys__reset').click();
    expect(readVRZoomKeys(settings.map.get(VR_ZOOM_KEYS_SETTING)).in).toEqual({ code: 'Equal', mods: { shift: false, ctrl: false, alt: false } });
    row('out').querySelector('.vr-zoom-keys__clear').click();
    expect(settings.map.get(VR_ZOOM_KEYS_SETTING).out).toBe(null);
    expect(box('out').classList.contains('key-capture--empty')).toBe(true);
  });

  it('the ? overlay lists the keys bound, or drops the row when there are none', () => {
    const label = EN.kbd.vrZoomKeys;
    const rowsOf = (groups) => groups.flatMap((g) => g.rows).filter((r) => r[1] === label);
    expect(rowsOf(getPlayerShortcutGroups({ vrZoomKeys: readVRZoomKeys(undefined) }))[0][0]).toBe('= / -');
    expect(rowsOf(getPlayerShortcutGroups({ vrZoomKeys: { in: { code: 'KeyT', mods: {} }, out: null } }))[0][0]).toBe('T');
    expect(rowsOf(getPlayerShortcutGroups({ vrZoomKeys: { in: null, out: null } }))).toEqual([]);
  });
});
