/**
 * @vitest-environment jsdom
 * jsdom on purpose: the binding rows are real DOM (KeyCapture buttons),
 * settings-panel.js and i18n.js branch on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// V47 (app test 2026-11-02): global hotkeys shipped with main-process
// registration and a renderer handler, but nothing in Settings could set a
// binding, and a binding hand-edited into config.json was registered only
// at boot. These drive the REAL rows (GlobalHotkeysSettings in Settings >
// Playback) with real key presses, through the REAL DataService and event
// bus, into app.js's REAL wiring (lifted `_wireGlobalShortcuts` /
// `_applyGlobalShortcuts`), and assert what the main process is asked to
// register.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { createRequire } from 'node:module';
import { GlobalHotkeysSettings, _resetRegistrationForTests } from '../../renderer/components/global-hotkeys-settings.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import {
  bindingToAccelerator, acceleratorToBinding, hotkeyRisk, sameAccelerator, letterForCode, registrationOf,
} from '../../renderer/js/global-hotkeys.js';
import { liftAppClass } from './helpers/app-methods.js';

const require = createRequire(import.meta.url);
const { createGlobalShortcuts } = require('../../electron/global-shortcuts.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const STORE_SRC = fs.readFileSync('electron/store.js', 'utf8');

let funsync;
let toasts;

beforeAll(() => {
  _setBundlesForTests('en', EN, EN);
});

beforeEach(() => {
  document.body.innerHTML = '<div id="toast-container"></div>';
  // No registration answer carried over from an earlier test's app (CB-19).
  _resetRegistrationForTests();
  toasts = [];
  funsync = {
    setSetting: vi.fn(),
    // The main process answers every binding it was given (see
    // electron/global-shortcuts.js); here everything registers.
    setGlobalShortcuts: vi.fn(async (b) => Object.entries(b).map(([action, accelerator]) => ({ action, accelerator, ok: true }))),
    onGlobalShortcut: vi.fn(),
  };
  window.funsync = funsync;
});

/** A real DataService, as app.js's `this.settings` is. */
function makeSettings(globalShortcuts) {
  const ds = new DataService();
  if (globalShortcuts !== undefined) ds._cache.settings.player.globalShortcuts = globalShortcuts;
  return ds;
}

function mountRows(settings) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  new GlobalHotkeysSettings({ element: mount, settings });
  return document.querySelector('.global-hotkeys');
}

const row = (action) => document.querySelector(`.global-hotkeys__row[data-action="${action}"]`);
const box = (action) => row(action).querySelector('.key-capture');
const clearBtn = (action) => row(action).querySelector('.global-hotkeys__clear');

/** Click the row's box, then press a key the way a user does. */
function bind(action, init) {
  box(action).click();
  box(action).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

const toastTexts = () => [...document.querySelectorAll('.toast__body')].map((n) => n.textContent);

// --- app.js wiring, lifted -------------------------------------------------

const Lifted = liftAppClass(['_wireGlobalShortcuts', '_applyGlobalShortcuts', '_onGlobalShortcut'], {
  window: { get funsync() { return funsync; } },
  eventBus,
  showToast: (message, type) => toasts.push({ message, type }),
  t,
  console: { warn: () => {} },
});

// Each booted app subscribes to the shared event bus; drop those after each
// test, so an earlier test's app can never answer a later test's change.
let unsubscribe = [];
afterEach(() => {
  for (const off of unsubscribe) off();
  unsubscribe = [];
});

function bootApp(settings) {
  const app = new Lifted();
  app.settings = settings;
  const realOn = eventBus.on.bind(eventBus);
  const spy = vi.spyOn(eventBus, 'on').mockImplementation((event, fn) => {
    const off = realOn(event, fn);
    unsubscribe.push(off);
    return off;
  });
  app._wireGlobalShortcuts();
  spy.mockRestore();
  return app;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('V47: Settings has a binding row for each global hotkey', () => {
  it('lists play/pause, Orgasm Switch, Edge Hold and Stop all devices, each with a capture box', () => {
    mountRows(makeSettings());
    const labels = [...document.querySelectorAll('.global-hotkeys__label')].map((n) => n.textContent);
    // Stop all devices joined 2026-11-23 (DESIGN.md §2.15), unbound like the rest.
    expect(labels).toEqual(['Play / pause', 'Orgasm Switch', 'Edge Hold', 'Stop all devices']);
    for (const action of ['playPause', 'orgasm', 'edge', 'stopAll']) {
      expect(box(action).getAttribute('aria-label')).toBe(row(action).querySelector('.global-hotkeys__label').textContent);
      expect(clearBtn(action).hidden).toBe(true); // nothing bound yet
    }
  });

  it('shows a binding that is already saved (a hand-edited config included)', () => {
    mountRows(makeSettings({ playPause: 'CommandOrControl+Shift+P', edge: 'F9' }));
    expect(box('playPause').textContent).toBe('Ctrl+Shift+P');
    expect(box('edge').textContent).toBe('F9');
    expect(clearBtn('playPause').hidden).toBe(false);
    expect(clearBtn('orgasm').hidden).toBe(true);
  });

  it('is in the Keyboard area of the REAL Settings panel (since the 2026-11-23 re-sort)', async () => {
    const panel = new SettingsPanel({ settings: makeSettings({ orgasm: 'Ctrl+Alt+O' }) });
    const tab = panel._buildPlaybackTab();
    document.body.appendChild(tab);
    const section = tab.querySelector('#sp-sec-global-hotkeys');
    expect(section).toBeTruthy();
    expect(section.querySelector('.settings-panel__section-header').textContent).toBe('Global hotkeys');
    expect(section.querySelectorAll('.global-hotkeys__row')).toHaveLength(4);
    expect(section.querySelector('[data-action="orgasm"] .key-capture').textContent).toBe('Ctrl+Alt+O');
    const keyboard = panel._railAreas().find((a) => a.id === 'keyboard');
    expect(keyboard.sections.map((g) => g.id)).toContain('sp-sec-global-hotkeys');
    await flush(); // let the tab's deferred wiring run against the DOM
  });

  it('the setting has a real default in electron/store.js', () => {
    // Settings defaults live in store.js; DataService seeds its cache from it.
    expect(STORE_SRC).toMatch(/globalShortcuts:\s*\{\s*\}/);
  });
});

describe('V47: a binding set in Settings is registered at once, no restart', () => {
  it('boot registers the saved bindings, then each change re-registers', async () => {
    const settings = makeSettings({});
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(funsync.setGlobalShortcuts).toHaveBeenCalledTimes(1);
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({});

    bind('playPause', { code: 'KeyP', key: 'P', ctrlKey: true, altKey: true, shiftKey: true });
    await flush();
    expect(funsync.setGlobalShortcuts).toHaveBeenCalledTimes(2);
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({ playPause: 'Ctrl+Alt+Shift+P' });
    // Persisted through the normal settings path, so it survives a restart.
    expect(funsync.setSetting).toHaveBeenLastCalledWith('player.globalShortcuts', { playPause: 'Ctrl+Alt+Shift+P' });
    expect(box('playPause').textContent).toBe('Ctrl+Alt+Shift+P');
    expect(clearBtn('playPause').hidden).toBe(false);
  });

  it('the remove button unbinds it from the OS straight away', async () => {
    const settings = makeSettings({ playPause: 'Ctrl+Alt+P', edge: 'F9' });
    bootApp(settings);
    mountRows(settings);
    clearBtn('playPause').click();
    await flush();
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({ edge: 'F9' });
    expect(settings.get('player.globalShortcuts')).toEqual({ edge: 'F9' });
    expect(clearBtn('playPause').hidden).toBe(true);
  });

  it('a global hotkey firing still reaches the same action as the in-app key', () => {
    const app = bootApp(makeSettings({}));
    const fired = funsync.onGlobalShortcut.mock.calls[0][0];
    app._playerWindowPlayback = () => false;
    app.videoPlayer = { togglePlay: vi.fn() };
    fired('playPause');
    expect(app.videoPlayer.togglePlay).toHaveBeenCalledTimes(1);
  });
});

describe('V47: what can be bound', () => {
  it('a bare letter is refused: it would stop that key typing in every other app', async () => {
    const settings = makeSettings({});
    bootApp(settings);
    mountRows(settings);
    bind('orgasm', { code: 'KeyO', key: 'o' });
    bind('orgasm', { code: 'KeyO', key: 'O', shiftKey: true });
    await flush();
    expect(settings.get('player.globalShortcuts')).toEqual({});
    expect(funsync.setGlobalShortcuts).toHaveBeenCalledTimes(1); // boot only
    expect(toastTexts().some((s) => /^O takes that key away from typing in every other app/.test(s))).toBe(true);
    expect(toastTexts().some((s) => /^Shift\+O takes that key away from typing/.test(s))).toBe(true);
    expect(clearBtn('orgasm').hidden).toBe(true);
  });

  it('F13-F24 or a media key may stand alone', async () => {
    const settings = makeSettings({});
    mountRows(settings);
    bind('edge', { code: 'F13', key: 'F13' });
    bind('playPause', { code: 'MediaPlayPause', key: 'MediaPlayPause' });
    expect(settings.get('player.globalShortcuts')).toEqual({ edge: 'F13', playPause: 'MediaPlayPause' });
  });

  it('a key with no accelerator form is refused before it is saved', () => {
    const settings = makeSettings({});
    mountRows(settings);
    bind('edge', { code: 'IntlRo', key: 'ro', ctrlKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({});
    expect(toastTexts().some((s) => /isn't a valid key combination/.test(s))).toBe(true);
  });

  it('one key, one action: binding a key already used moves it', () => {
    const settings = makeSettings({ playPause: 'Ctrl+Alt+Shift+P' });
    mountRows(settings);
    bind('edge', { code: 'KeyP', key: 'P', altKey: true, ctrlKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ edge: 'Ctrl+Alt+Shift+P' });
    expect(box('playPause').classList.contains('key-capture--empty')).toBe(true);
  });
});

describe('accelerator conversion', () => {
  it('maps KeyboardEvent.code to Electron accelerator keys', () => {
    const acc = (code, mods = {}) => bindingToAccelerator({ code, mods });
    expect(acc('KeyP', { ctrl: true, alt: true })).toBe('Ctrl+Alt+P');
    expect(acc('Digit5', { ctrl: true, shift: true })).toBe('Ctrl+Shift+5');
    expect(acc('F12')).toBe('F12');
    expect(acc('Numpad7', { alt: true })).toBe('Alt+num7');
    expect(acc('ArrowUp', { ctrl: true })).toBe('Ctrl+Up');
    expect(acc('Equal', { ctrl: true })).toBe('Ctrl+=');
    expect(acc('MediaTrackNext')).toBe('MediaNextTrack');
    expect(acc('IntlBackslash', { ctrl: true })).toBe(null);
    expect(acc(undefined)).toBe(null);
  });

  it('reads back every accelerator it writes', () => {
    for (const [code, mods] of [
      ['KeyP', { ctrl: true, alt: true }], ['Digit0', { alt: true }], ['F9', {}],
      ['Numpad3', { ctrl: true }], ['Space', { ctrl: true, shift: true }],
      ['Minus', { alt: true }], ['MediaPlayPause', {}], ['ArrowLeft', { ctrl: true }],
    ]) {
      const accel = bindingToAccelerator({ code, mods });
      const back = acceleratorToBinding(accel);
      expect(bindingToAccelerator(back), accel).toBe(accel);
    }
  });

  it('reads Electron spellings a hand-edited config may hold, and shows anything else verbatim', () => {
    expect(acceleratorToBinding('CmdOrCtrl+Shift+K')).toEqual({ code: 'KeyK', mods: { ctrl: true, shift: true } });
    expect(acceleratorToBinding('Control+Option+F2')).toEqual({ code: 'F2', mods: { ctrl: true, alt: true } });
    expect(acceleratorToBinding('Super+K')).toEqual({ code: 'Super+K', mods: {} });
    expect(acceleratorToBinding('Ctrl++')).toEqual({ code: 'Ctrl++', mods: {} });
    expect(acceleratorToBinding('')).toBe(null);
  });

  it('treats modifier order and case as the same accelerator', () => {
    expect(sameAccelerator('alt+ctrl+p', 'Ctrl+Alt+P')).toBe(true);
    expect(sameAccelerator('CommandOrControl+P', 'Ctrl+P')).toBe(true);
    expect(sameAccelerator('Ctrl+P', 'Ctrl+Shift+P')).toBe(false);
    expect(sameAccelerator(undefined, 'Ctrl+P')).toBe(false);
  });
});

// --- V73 -------------------------------------------------------------------
// The V47 rule refused a bare letter because a system-wide registration
// "would stop that key working in every other app", then accepted chords
// with exactly the same harm, because Windows RegisterHotKey grants them:
// Ctrl+C / V / X / Z / Y / A / S (copy, paste, undo, save gone from every
// app while FunSync runs), Ctrl+Left/Right, bare F2/F3/F5, and AltGr
// characters: AltGr arrives as Ctrl+Alt, so German AltGr+Q ("@") was
// captured and saved as Ctrl+Alt+Q.

/** What a capture sees for a chord, as KeyCapture builds it. */
const chord = (code, mods = '') => ({
  code,
  mods: { ctrl: mods.includes('c'), alt: mods.includes('a'), shift: mods.includes('s') },
});

describe('V73: the rule refuses every everyday key and chord', () => {
  it('copy, paste, cut, undo, redo, select all and save are refused', () => {
    for (const k of ['C', 'V', 'X', 'Z', 'Y', 'A', 'S']) {
      expect(hotkeyRisk(chord(`Key${k}`, 'c')), `Ctrl+${k}`).toBe('appShortcut');
    }
  });

  it('any one modifier plus a key is an app shortcut (Ctrl+W, Alt+F4, Ctrl+F4, Alt+D, Ctrl+1, Ctrl+=)', () => {
    expect(hotkeyRisk(chord('KeyW', 'c'))).toBe('appShortcut');
    expect(hotkeyRisk(chord('F4', 'a'))).toBe('appShortcut');
    expect(hotkeyRisk(chord('F4', 'c'))).toBe('appShortcut');
    expect(hotkeyRisk(chord('KeyD', 'a'))).toBe('appShortcut');
    expect(hotkeyRisk(chord('Digit1', 'c'))).toBe('appShortcut');
    expect(hotkeyRisk(chord('Equal', 'c'))).toBe('appShortcut');
    expect(hotkeyRisk(chord('Numpad5', 'c'))).toBe('appShortcut');
  });

  it('the everyday Ctrl+Shift chords are refused, the same keys with Ctrl+Alt+Shift are not', () => {
    for (const code of ['KeyC', 'KeyV', 'KeyZ', 'KeyS', 'KeyN', 'KeyT', 'KeyW', 'Equal']) {
      expect(hotkeyRisk(chord(code, 'cs')), `Ctrl+Shift+${code}`).toBe('appShortcut');
      expect(hotkeyRisk(chord(code, 'cas')), `Ctrl+Alt+Shift+${code}`).toBe(null);
    }
  });

  it('cursor, editing and screenshot keys are refused with every modifier', () => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
      'Backspace', 'Delete', 'Insert', 'Tab', 'Enter', 'Space', 'PrintScreen'];
    for (const code of keys) {
      for (const mods of ['', 's', 'c', 'a', 'cs', 'ca', 'as', 'cas']) {
        expect(hotkeyRisk(chord(code, mods)), `${mods}+${code}`).toBe('cursorEdit');
      }
    }
  });

  it('F1-F12 alone, with Shift or with one modifier are refused; F13-F24 may stand alone', () => {
    for (let n = 1; n <= 12; n++) {
      expect(hotkeyRisk(chord(`F${n}`)), `F${n}`).toBe('appShortcut');
      expect(hotkeyRisk(chord(`F${n}`, 's')), `Shift+F${n}`).toBe('appShortcut');
    }
    expect(hotkeyRisk(chord('F5', 'c'))).toBe('appShortcut');
    for (let n = 13; n <= 24; n++) expect(hotkeyRisk(chord(`F${n}`)), `F${n}`).toBe(null);
    expect(hotkeyRisk(chord('F13', 'cs'))).toBe(null);
  });

  it('media and volume keys may stand alone', () => {
    for (const code of ['MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaStop',
      'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute']) {
      expect(hotkeyRisk(chord(code)), code).toBe(null);
    }
  });

  it('a letter, digit, symbol or numpad key without Ctrl or Alt types: refused', () => {
    expect(hotkeyRisk(chord('KeyP'))).toBe('typing');
    expect(hotkeyRisk(chord('KeyP', 's'))).toBe('typing');
    expect(hotkeyRisk(chord('Digit5'))).toBe('typing');
    expect(hotkeyRisk(chord('Minus', 's'))).toBe('typing');
    expect(hotkeyRisk(chord('Numpad5'))).toBe('typing');
    expect(hotkeyRisk(chord('NumpadAdd'))).toBe('typing');
  });

  it('German AltGr characters arrive as Ctrl+Alt and are refused; adding Shift is accepted', () => {
    // Chromium on Windows reports AltGr as ctrlKey + altKey; code is the
    // physical key. German QWERTZ: AltGr+Q @, E €, M µ, 2 ², 7 {, 8 [, 9 ],
    // 0 }, ß \ (code Minus), + ~ (code BracketRight).
    const german = [['KeyQ', '@'], ['KeyE', '€'], ['KeyM', 'µ'], ['Digit2', '²'], ['Digit7', '{'],
      ['Digit8', '['], ['Digit9', ']'], ['Digit0', '}'], ['Minus', '\\'], ['BracketRight', '~']];
    for (const [code, typed] of german) {
      expect(hotkeyRisk(chord(code, 'ca')), `AltGr+${code} (${typed})`).toBe('altGr');
      expect(hotkeyRisk(chord(code, 'cas')), `Ctrl+Alt+Shift+${code}`).toBe(null);
    }
    // No AltGr characters on F-keys or the numpad.
    expect(hotkeyRisk(chord('F9', 'ca'))).toBe(null);
    expect(hotkeyRisk(chord('Numpad5', 'ca'))).toBe(null);
  });

  it('two modifiers with a letter, digit or F-key are accepted', () => {
    expect(hotkeyRisk(chord('F9', 'cs'))).toBe(null); // Ctrl+Shift+F9
    expect(hotkeyRisk(chord('KeyP', 'cs'))).toBe(null);
    expect(hotkeyRisk(chord('KeyP', 'as'))).toBe(null);
    expect(hotkeyRisk(chord('KeyP', 'cas'))).toBe(null);
    expect(hotkeyRisk(chord('Digit3', 'as'))).toBe(null);
  });

  it('judges a saved accelerator the same way, and shows a hand-edited one it cannot read unjudged', () => {
    expect(hotkeyRisk(acceleratorToBinding('CommandOrControl+C'))).toBe('appShortcut');
    expect(hotkeyRisk(acceleratorToBinding('Ctrl+Alt+Q'))).toBe('altGr');
    expect(hotkeyRisk(acceleratorToBinding('F5'))).toBe('appShortcut');
    expect(hotkeyRisk(acceleratorToBinding('Ctrl+Alt+Shift+P'))).toBe(null);
    expect(hotkeyRisk(acceleratorToBinding('Super+K'))).toBe(null);
    expect(hotkeyRisk(null)).toBe(null);
  });
});

describe('V73: Settings refuses an everyday key, saying why, and never drops a saved one', () => {
  it('a refused key is not saved or registered, and the toast names why', async () => {
    const settings = makeSettings({});
    bootApp(settings);
    mountRows(settings);
    await flush();

    bind('playPause', { code: 'KeyC', key: 'c', ctrlKey: true });
    bind('orgasm', { code: 'KeyQ', key: '@', ctrlKey: true, altKey: true }); // German AltGr+Q
    bind('edge', { code: 'F5', key: 'F5' });
    bind('edge', { code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true });
    await flush();

    expect(settings.get('player.globalShortcuts')).toEqual({});
    expect(funsync.setSetting).not.toHaveBeenCalled();
    expect(funsync.setGlobalShortcuts).toHaveBeenCalledTimes(1); // boot only
    for (const action of ['playPause', 'orgasm', 'edge', 'stopAll']) {
      expect(box(action).classList.contains('key-capture--empty'), action).toBe(true);
      expect(clearBtn(action).hidden).toBe(true);
    }
    const texts = toastTexts();
    expect(texts.some((s) => /^Ctrl\+C is a shortcut other apps use \(copy, paste/.test(s))).toBe(true);
    expect(texts.some((s) => /Ctrl\+Alt is AltGr, so Ctrl\+Alt\+Q can stop a character such as @/.test(s))).toBe(true);
    expect(texts.some((s) => /^F5 is a shortcut other apps use/.test(s))).toBe(true);
    // A key name, not the raw KeyboardEvent.code 'ArrowLeft' (FT-014).
    expect(texts.some((s) => /^Ctrl\+Left Arrow is a cursor, editing or screenshot key/.test(s))).toBe(true);
  });

  it('a refused key leaves the row as it was saved', () => {
    const settings = makeSettings({ playPause: 'Ctrl+Alt+Shift+P' });
    mountRows(settings);
    bind('playPause', { code: 'KeyV', key: 'v', ctrlKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+P' });
    expect(box('playPause').textContent).toBe('Ctrl+Alt+Shift+P');
  });

  it('Ctrl+Shift+F9 and a media key are accepted and registered', async () => {
    const settings = makeSettings({});
    bootApp(settings);
    mountRows(settings);
    bind('edge', { code: 'F9', key: 'F9', ctrlKey: true, shiftKey: true });
    bind('playPause', { code: 'MediaPlayPause', key: 'MediaPlayPause' });
    await flush();
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({ edge: 'Ctrl+Shift+F9', playPause: 'MediaPlayPause' });
    expect(toastTexts()).toEqual([]);
  });

  it('a binding saved before the rule is kept, still registered, and flagged with the reason', async () => {
    const saved = { playPause: 'Ctrl+C', orgasm: 'Ctrl+Alt+Q', edge: 'Ctrl+Alt+Shift+P' };
    const settings = makeSettings({ ...saved });
    bootApp(settings);
    mountRows(settings);
    await flush();

    // Nothing rewritten or dropped, and the OS is still asked for all three.
    expect(funsync.setSetting).not.toHaveBeenCalled();
    expect(settings.get('player.globalShortcuts')).toEqual(saved);
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith(saved);
    expect(box('playPause').textContent).toBe('Ctrl+C');
    expect(clearBtn('playPause').hidden).toBe(false);

    const warning = (action) => document.getElementById(`global-hotkeys-warning-${action}`);
    expect(warning('playPause').hidden).toBe(false);
    expect(warning('playPause').textContent).toMatch(/^Still active as saved\. Ctrl\+C is a shortcut other apps use/);
    expect(box('playPause').getAttribute('aria-describedby')).toBe('global-hotkeys-warning-playPause');
    expect(warning('orgasm').hidden).toBe(false);
    expect(warning('orgasm').textContent).toMatch(/AltGr, so Ctrl\+Alt\+Q can stop a character/);
    expect(warning('edge').hidden).toBe(true);
    expect(box('edge').hasAttribute('aria-describedby')).toBe(false);

    // Replacing it with a safe key, or removing it, clears the flag.
    bind('playPause', { code: 'KeyK', key: 'K', ctrlKey: true, altKey: true, shiftKey: true });
    expect(warning('playPause').hidden).toBe(true);
    expect(box('playPause').hasAttribute('aria-describedby')).toBe(false);
    clearBtn('orgasm').click();
    expect(warning('orgasm').hidden).toBe(true);
    await flush();
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({ playPause: 'Ctrl+Alt+Shift+K', edge: 'Ctrl+Alt+Shift+P' });
  });
});

// --- FT-012 -------------------------------------------------------------------
// KeyboardEvent.code is the US position of the physical key: on German QWERTZ
// the key labelled Z is 'KeyY'. The capture built the accelerator from the
// code, so pressing Ctrl+Alt+Shift+Z saved 'Ctrl+Alt+Shift+Y', and Electron
// registered the virtual key of Y: the key LABELLED Y. The hotkey landed on a
// different key from the one pressed. AZERTY moves A/Q and Z/W the same way.

/** navigator.keyboard as Chromium has it, with a layout map from `{code: char}`. */
function stubLayout(chars) {
  const map = new Map(Object.entries(chars));
  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: { getLayoutMap: vi.fn(async () => map) },
  });
}
const QWERTZ = { KeyY: 'z', KeyZ: 'y', KeyQ: 'q', KeyP: 'p', Digit1: '1', Minus: 'ß' };
const AZERTY = { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', KeyM: ',', Semicolon: 'm', Digit1: '&' };
const US = { KeyY: 'y', KeyZ: 'z', KeyQ: 'q', KeyA: 'a', Digit1: '1' };

describe('FT-012: a letter hotkey is the letter on the key pressed, on any layout', () => {
  afterEach(() => { delete navigator.keyboard; });

  it('German QWERTZ: the key labelled Z (code KeyY) saves and registers Z, and the row shows Z', async () => {
    stubLayout(QWERTZ);
    const settings = makeSettings({});
    bootApp(settings);
    mountRows(settings);
    await flush(); // the layout map is read when the section builds

    bind('playPause', { code: 'KeyY', key: 'Z', ctrlKey: true, altKey: true, shiftKey: true });
    await flush();
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+Z' });
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({ playPause: 'Ctrl+Alt+Shift+Z' });
    expect(box('playPause').textContent).toBe('Ctrl+Alt+Shift+Z');

    // ...and the key labelled Y (code KeyZ) is Y.
    bind('edge', { code: 'KeyZ', key: 'Y', ctrlKey: true, altKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+Z', edge: 'Ctrl+Alt+Shift+Y' });
  });

  it('without the Keyboard API, the event key gives the same letter', async () => {
    delete navigator.keyboard;
    const settings = makeSettings({});
    mountRows(settings);
    await flush();
    bind('playPause', { code: 'KeyY', key: 'z', ctrlKey: true, altKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+Z' });
  });

  it('a layout map that refuses falls back to the event key', async () => {
    Object.defineProperty(navigator, 'keyboard', {
      configurable: true,
      value: { getLayoutMap: () => Promise.reject(new Error('NotAllowedError')) },
    });
    const settings = makeSettings({});
    mountRows(settings);
    await flush();
    bind('orgasm', { code: 'KeyY', key: 'Z', ctrlKey: true, altKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ orgasm: 'Ctrl+Alt+Shift+Z' });
  });

  it('US layout: unchanged', async () => {
    stubLayout(US);
    const settings = makeSettings({});
    mountRows(settings);
    await flush();
    bind('playPause', { code: 'KeyY', key: 'Y', ctrlKey: true, altKey: true, shiftKey: true });
    bind('edge', { code: 'KeyP', key: 'P', ctrlKey: true, altKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+Y', edge: 'Ctrl+Alt+Shift+P' });
  });

  it('French AZERTY: KeyQ is A, KeyW is Z, and a digit still saves its digit', async () => {
    stubLayout(AZERTY);
    const settings = makeSettings({});
    mountRows(settings);
    await flush();
    bind('playPause', { code: 'KeyQ', key: 'A', ctrlKey: true, altKey: true, shiftKey: true });
    bind('orgasm', { code: 'KeyW', key: 'Z', ctrlKey: true, altKey: true, shiftKey: true });
    // Digit1 types '&' on AZERTY; the digit key keeps its code ('1' is VK_1 there too).
    bind('edge', { code: 'Digit1', key: '1', ctrlKey: true, altKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({
      playPause: 'Ctrl+Alt+Shift+A', orgasm: 'Ctrl+Alt+Shift+Z', edge: 'Ctrl+Alt+Shift+1',
    });
  });

  it('the risk rule judges the key that is actually taken: on QWERTZ Ctrl+Shift on the Z key is redo', async () => {
    stubLayout(QWERTZ);
    const settings = makeSettings({});
    mountRows(settings);
    await flush();
    bind('playPause', { code: 'KeyY', key: 'Z', ctrlKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({});
    expect(toastTexts().some((s) => /^Ctrl\+Shift\+Z is a shortcut other apps use/.test(s))).toBe(true);
    // The key labelled Y with Ctrl+Shift is not an everyday chord.
    bind('playPause', { code: 'KeyZ', key: 'Y', ctrlKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Shift+Y' });
  });

  it('a Cyrillic layout keeps the US-position letter (Windows keeps those virtual keys there)', async () => {
    stubLayout({ KeyY: 'н', KeyZ: 'я' });
    const settings = makeSettings({});
    mountRows(settings);
    await flush();
    bind('playPause', { code: 'KeyY', key: 'Н', ctrlKey: true, altKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+Y' });
  });

  it('a saved accelerator is never rewritten by the layout', async () => {
    stubLayout(QWERTZ);
    const settings = makeSettings({ playPause: 'Ctrl+Alt+Shift+Y' });
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(funsync.setSetting).not.toHaveBeenCalled();
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+Y' });
    expect(box('playPause').textContent).toBe('Ctrl+Alt+Shift+Y');
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({ playPause: 'Ctrl+Alt+Shift+Y' });
  });

  it('letterForCode: a layout letter, else the key, else nothing; only for letter keys', () => {
    const map = new Map(Object.entries(QWERTZ));
    expect(letterForCode('KeyY', map, 'q')).toBe('Z'); // the map wins
    expect(letterForCode('KeyY', null, 'z')).toBe('Z');
    expect(letterForCode('KeyY', null, 'Z')).toBe('Z');
    expect(letterForCode('KeyY', new Map([['KeyY', 'н']]), 'н')).toBe(null);
    expect(letterForCode('KeyQ', null, '@')).toBe(null); // AltGr character
    expect(letterForCode('KeyQ', { get() { throw new Error('x'); } }, 'q')).toBe('Q');
    expect(letterForCode('Digit1', new Map([['Digit1', '&']]), '1')).toBe(null);
    expect(letterForCode('Minus', map, 'ß')).toBe(null);
    expect(letterForCode('F5', map, 'F5')).toBe(null);
    expect(letterForCode(undefined, map, 'a')).toBe(null);
  });
});

// --- FT-013 -------------------------------------------------------------------
// acceleratorToBinding did not know Electron's 'Plus' (the '+' key, i.e. Shift
// on '='), so a saved 'Ctrl+Plus', the zoom-in chord, came back raw and
// unjudged: registered with no warning. 'Esc' / 'Escape' likewise.

describe('FT-013: Electron names a saved binding may use are read and judged', () => {
  const warning = (action) => document.getElementById(`global-hotkeys-warning-${action}`);

  it("a saved 'Ctrl+Plus' or 'CommandOrControl+Plus' is flagged and stays registered", async () => {
    const saved = { playPause: 'Ctrl+Plus', orgasm: 'CommandOrControl+Plus' };
    const settings = makeSettings({ ...saved });
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(funsync.setSetting).not.toHaveBeenCalled();
    expect(settings.get('player.globalShortcuts')).toEqual(saved);
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith(saved);
    for (const action of ['playPause', 'orgasm']) {
      expect(warning(action).hidden, action).toBe(false);
      expect(warning(action).textContent).toMatch(/^Still active as saved\. Ctrl\+Shift\+= is a shortcut other apps use/);
      expect(box(action).textContent).toBe('Ctrl+Shift+=');
    }
  });

  it("'Ctrl+Alt+Shift+Plus' is safe and shows no warning", () => {
    mountRows(makeSettings({ edge: 'Ctrl+Alt+Shift+Plus' }));
    expect(warning('edge').hidden).toBe(true);
    expect(box('edge').textContent).toBe('Ctrl+Alt+Shift+=');
  });

  // Rewritten for CB-19: this used to mount the rows with no registration
  // answer and expect "Still active as saved." for Ctrl+Esc, i.e. it pinned
  // the row guessing. With the OS's answer, a registered Esc binding says
  // it is active; with none, the row names the reason and claims nothing.
  it("a saved 'Ctrl+Esc' or 'Escape' is flagged as a key other apps use", async () => {
    const settings = makeSettings({ playPause: 'Ctrl+Esc', edge: 'Escape' });
    mountRows(settings);
    expect(warning('playPause').hidden).toBe(false);
    expect(warning('playPause').textContent).toMatch(/^Ctrl\+Esc is a cursor, editing or screenshot key/);
    expect(warning('edge').hidden).toBe(false);
    bootApp(settings); // everything registers in this file's fake main process
    await flush();
    expect(warning('playPause').textContent).toMatch(/^Still active as saved\. Ctrl\+Esc is a cursor, editing or screenshot key/);
    expect(warning('edge').textContent).toMatch(/^Still active as saved\. Esc is a cursor, editing or screenshot key/);
  });

  it('the parser reads them the way Electron registers them', () => {
    expect(acceleratorToBinding('Ctrl+Plus')).toEqual({ code: 'Equal', mods: { ctrl: true, shift: true } });
    expect(acceleratorToBinding('CommandOrControl+Plus')).toEqual({ code: 'Equal', mods: { ctrl: true, shift: true } });
    expect(hotkeyRisk(acceleratorToBinding('Ctrl+Plus'))).toBe('appShortcut');
    expect(hotkeyRisk(acceleratorToBinding('Plus'))).toBe('typing');
    expect(hotkeyRisk(acceleratorToBinding('Ctrl+Alt+Shift+Plus'))).toBe(null);
    expect(sameAccelerator('Ctrl+Plus', 'Ctrl+Shift+=')).toBe(true);
    expect(acceleratorToBinding('Ctrl+Esc')).toEqual({ code: 'Escape', mods: { ctrl: true } });
    expect(acceleratorToBinding('Escape')).toEqual({ code: 'Escape', mods: {} });
    expect(hotkeyRisk(acceleratorToBinding('Ctrl+Shift+Esc'))).toBe('cursorEdit');
  });
});

// --- CB-19 --------------------------------------------------------------------
// A saved risky binding the OS refused still read "Still active as saved.":
// the row judged the key and never looked at the registration result. Block B
// verifier: `edge = 'Ctrl+Escape'` (Windows owns Ctrl+Esc) toasted "already
// used by another app", isRegistered was false, and the row said active.
// Here the REAL electron/global-shortcuts.js answers through app.js's REAL
// `_applyGlobalShortcuts` (lifted), against a fake globalShortcut that keeps
// Electron's contract: false for a combination someone else owns, a throw
// for one it cannot parse.

describe('CB-19: a row says what the OS made of the binding', () => {
  const warning = (action) => document.getElementById(`global-hotkeys-warning-${action}`);

  function realMain({ heldElsewhere = [], unparsable = [] } = {}) {
    const owned = new Set();
    const globalShortcut = {
      register: vi.fn((accel) => {
        if (unparsable.includes(accel)) throw new TypeError(`conversion failure from ${accel}`);
        if (heldElsewhere.includes(accel) || owned.has(accel)) return false;
        owned.add(accel);
        return true;
      }),
      unregister: vi.fn((accel) => { owned.delete(accel); }),
      isRegistered: (accel) => owned.has(accel),
    };
    const hotkeys = createGlobalShortcuts({ globalShortcut, log: { warn: () => {} }, onFire: () => {} });
    funsync.setGlobalShortcuts = vi.fn(async (b) => hotkeys.apply(b));
    return globalShortcut;
  }

  it("Ctrl+Escape, refused by Windows, reads 'Not active', never 'Still active as saved'", async () => {
    const os = realMain({ heldElsewhere: ['Ctrl+Escape'] });
    const settings = makeSettings({ edge: 'Ctrl+Escape' });
    bootApp(settings);
    await flush();
    mountRows(settings); // Settings opened after the boot registration answered
    expect(os.isRegistered('Ctrl+Escape')).toBe(false);
    expect(warning('edge').hidden).toBe(false);
    expect(warning('edge').textContent).toBe('Not active: the system or another app already uses Ctrl+Esc. Pick a different hotkey.');
    expect(warning('edge').textContent).not.toMatch(/Still active/);
    expect(box('edge').getAttribute('aria-describedby')).toBe('global-hotkeys-warning-edge');
    // Kept as saved (refusing is never destructive), and the toast still says it.
    expect(settings.get('player.globalShortcuts')).toEqual({ edge: 'Ctrl+Escape' });
    expect(toasts.map((x) => x.message)).toEqual(['Ctrl+Escape is already used by another app — pick a different hotkey']);
  });

  it('a safe binding another app holds is flagged too (it used to show nothing)', async () => {
    realMain({ heldElsewhere: ['Ctrl+Alt+Shift+M'] });
    const settings = makeSettings({ orgasm: 'Ctrl+Alt+Shift+M', edge: 'F13' });
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(warning('orgasm').hidden).toBe(false);
    expect(warning('orgasm').textContent).toBe('Not active: the system or another app already uses Ctrl+Alt+Shift+M. Pick a different hotkey.');
    expect(warning('edge').hidden).toBe(true); // registered and safe: nothing to say
  });

  it("a hand-edited accelerator Electron cannot parse reads 'isn't a valid key combination'", async () => {
    realMain({ unparsable: ['Ctrl+Foo'] });
    const settings = makeSettings({ playPause: 'Ctrl+Foo' });
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(warning('playPause').textContent).toBe("Not active: Ctrl+Foo isn't a valid key combination. Pick a different hotkey.");
  });

  it('a risky binding the OS did take still reads "Still active as saved."', async () => {
    const os = realMain();
    const settings = makeSettings({ playPause: 'Ctrl+C' });
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(os.isRegistered('Ctrl+C')).toBe(true);
    expect(warning('playPause').textContent).toMatch(/^Still active as saved\. Ctrl\+C is a shortcut other apps use/);
  });

  it('rows open before the answer claim nothing, then repaint to it without reopening Settings', async () => {
    realMain({ heldElsewhere: ['Ctrl+Escape'] });
    const settings = makeSettings({ edge: 'Ctrl+Escape', playPause: 'Ctrl+C' });
    mountRows(settings);
    // No answer yet: the reason only, no claim either way.
    expect(warning('edge').textContent).toMatch(/^Ctrl\+Esc is a cursor, editing or screenshot key/);
    expect(warning('playPause').textContent).toMatch(/^Ctrl\+C is a shortcut other apps use/);
    bootApp(settings);
    await flush();
    expect(warning('edge').textContent).toMatch(/^Not active: /);
    expect(warning('playPause').textContent).toMatch(/^Still active as saved\. /);
  });

  it('binding the refused row to a key the OS takes clears the line once the OS answers', async () => {
    realMain({ heldElsewhere: ['Ctrl+Escape'] });
    const settings = makeSettings({ edge: 'Ctrl+Escape' });
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(warning('edge').hidden).toBe(false);
    bind('edge', { code: 'KeyE', key: 'E', ctrlKey: true, altKey: true, shiftKey: true });
    await flush();
    expect(funsync.setGlobalShortcuts).toHaveBeenLastCalledWith({ edge: 'Ctrl+Alt+Shift+E' });
    expect(warning('edge').hidden).toBe(true);
    expect(box('edge').hasAttribute('aria-describedby')).toBe(false);
  });

  it('a failed registration call leaves no claim behind', async () => {
    const settings = makeSettings({ playPause: 'Ctrl+C' });
    bootApp(settings);
    mountRows(settings);
    await flush();
    expect(warning('playPause').textContent).toMatch(/^Still active as saved\. /);
    funsync.setGlobalShortcuts = vi.fn(async () => { throw new Error('IPC gone'); });
    settings.set('player.globalShortcuts', { playPause: 'Ctrl+C' });
    await flush();
    expect(warning('playPause').textContent).toMatch(/^Ctrl\+C is a shortcut other apps use/);
  });

  it('in German the refusal is German', async () => {
    const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
    _setBundlesForTests('de', DE, EN);
    try {
      realMain({ heldElsewhere: ['Ctrl+Escape'] });
      const settings = makeSettings({ edge: 'Ctrl+Escape' });
      bootApp(settings);
      mountRows(settings);
      await flush();
      expect(warning('edge').textContent).toBe('Nicht aktiv: Strg+Esc wird bereits vom System oder einer anderen App verwendet. Wähle eine andere Tastenkombination.');
    } finally {
      _setBundlesForTests('en', EN, EN);
    }
  });

  it('registrationOf reads the answer for that action and that accelerator only', () => {
    const results = [
      { action: 'playPause', accelerator: 'Ctrl+Alt+Shift+P', ok: true },
      { action: 'orgasm', accelerator: 'Ctrl+Escape', ok: false, reason: 'taken' },
      { action: 'edge', accelerator: 'Ctrl+Foo', ok: false, reason: 'invalid' },
    ];
    expect(registrationOf(results, 'playPause', 'Ctrl+Alt+Shift+P')).toBe('active');
    expect(registrationOf(results, 'orgasm', 'Ctrl+Escape')).toBe('taken');
    expect(registrationOf(results, 'edge', 'Ctrl+Foo')).toBe('invalid');
    // A change still on its way to the main process: not known yet.
    expect(registrationOf(results, 'playPause', 'Ctrl+Alt+Shift+K')).toBe(null);
    expect(registrationOf(results, 'edge', 'Ctrl+Alt+Shift+P')).toBe(null);
    expect(registrationOf(null, 'playPause', 'Ctrl+Alt+Shift+P')).toBe(null);
  });
});

// --- FT-014 -------------------------------------------------------------------

describe('FT-014: the rows and the risk toasts name keys in the active language', () => {
  const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
  afterEach(() => _setBundlesForTests('en', EN, EN));

  it('German: a refused Ctrl+C toasts "Strg+C", and a saved binding shows Strg / Umschalt', () => {
    _setBundlesForTests('de', DE, EN);
    const settings = makeSettings({ orgasm: 'Ctrl+Alt+Shift+P', edge: 'MediaNextTrack' });
    mountRows(settings);
    bind('playPause', { code: 'KeyC', key: 'c', ctrlKey: true });
    expect(toastTexts().some((s) => /^Strg\+C ist ein Tastenkürzel, das andere Apps verwenden/.test(s))).toBe(true);
    expect(box('orgasm').textContent).toBe('Strg+Alt+Umschalt+P');
    expect(box('edge').textContent).toBe('Nächster Titel');
    // Stored and registered in English, whatever the display language.
    expect(settings.get('player.globalShortcuts')).toEqual({ orgasm: 'Ctrl+Alt+Shift+P', edge: 'MediaNextTrack' });
  });

  it('a German capture saves the English accelerator and shows the German label', () => {
    _setBundlesForTests('de', DE, EN);
    const settings = makeSettings({});
    mountRows(settings);
    bind('playPause', { code: 'KeyP', key: 'P', ctrlKey: true, altKey: true, shiftKey: true });
    expect(settings.get('player.globalShortcuts')).toEqual({ playPause: 'Ctrl+Alt+Shift+P' });
    expect(box('playPause').textContent).toBe('Strg+Alt+Umschalt+P');
  });

  it('the Playback area of the REAL Settings panel, built in German, shows German key names', async () => {
    _setBundlesForTests('de', DE, EN);
    const panel = new SettingsPanel({ settings: makeSettings({ orgasm: 'Ctrl+Alt+O' }) });
    const tab = panel._buildPlaybackTab();
    document.body.appendChild(tab);
    expect(tab.querySelector('[data-action="orgasm"] .key-capture').textContent).toBe('Strg+Alt+O');
    await flush();
  });
});
