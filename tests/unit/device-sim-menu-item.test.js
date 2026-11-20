/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL DeviceSimulator builds its widget as DOM, the
 * REAL KeyboardHandler listens on `document`, and the menu item is the one
 * in the real index.html (notes/CLAUDE.md "Test environments").
 */
// A "Device simulator" item in the player's ⋮ menu, next to the TL / HM
// items (zaikechi, EroScripts #381). Until now the D key was the only way to
// show the stroke indicator.
//
// The invariant: the item's tick says whether the simulator is ON SCREEN,
// whoever toggled it. The D key and the menu both work, and after any mix of
// the two the tick and the widget agree. It is remembered across restarts
// like the TL / HM toggles beside it (`player.deviceSimulatorVisible`, off by
// default; Dave 2026-11-04), shows without a script, and is not in the player
// pop-out, which has no simulator.
//
// Wired by app.js's own `_wireDeviceSimMenuItem` (lifted), over the real
// widget and the real D key.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { DeviceSimulator } from '../../renderer/components/device-simulator.js';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';
import { createRequire } from 'node:module';

const { DEFAULTS } = createRequire(import.meta.url)('../../electron/store.js');

const INDEX = fs.readFileSync('renderer/index.html', 'utf8');
const POPOUT = fs.readFileSync('renderer/player-popout.html', 'utf8');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

/** The real ⋮ menu from index.html, mounted on its own. */
function mountOverflowMenu() {
  const doc = new DOMParser().parseFromString(INDEX, 'text/html');
  const menu = doc.getElementById('controls-overflow-menu');
  document.body.appendChild(document.importNode(menu, true));
}

const Lifted = liftAppClass(['_wireDeviceSimMenuItem'], {});

// ONE keyboard handler for the file: it binds to `document` and cannot be
// unbound. It reads its simulator from the field, so each test swaps it in.
const keys = new KeyboardHandler({ videoPlayer: {} });

let sim;
let item;

/** `store`: the saved settings this launch starts from (none = no settings object). */
function setup({ store } = {}) {
  document.body.innerHTML = '<div id="app"></div>';
  mountOverflowMenu();
  sim = new DeviceSimulator({
    videoPlayer: { currentTime: 0 },
    funscriptEngine: { isLoaded: false, getPositionAt: () => 50 },
  });
  keys.deviceSimulator = sim;
  const app = new Lifted();
  app.deviceSimulator = sim;
  if (store) app.settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  app._wireDeviceSimMenuItem();
  item = document.getElementById('btn-device-sim');
}

const pressD = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }));
const widget = () => document.querySelector('.device-sim');
const ticked = () => item.getAttribute('aria-checked');

beforeAll(() => {
  // jsdom has rAF; the simulator only needs it to schedule frames.
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 16);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
});

beforeEach(() => setup());

describe('Device simulator in the ⋮ menu (#381)', () => {
  it('sits right after the TL / HM items as a checkbox item, unticked, with the simulator hidden', () => {
    const ids = [...document.querySelectorAll('#controls-overflow-menu > button')].map((b) => b.id);
    expect(ids.slice(ids.indexOf('btn-inline-tl'), ids.indexOf('btn-inline-tl') + 3))
      .toEqual(['btn-inline-tl', 'btn-inline-hm', 'btn-device-sim']);
    expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    expect(ticked()).toBe('false');
    expect(widget().hidden).toBe(true);
    // Shown whenever the menu is: not tied to a script being loaded.
    expect(item.hidden).toBe(false);
  });

  it('a click shows the simulator and ticks the item; a second click hides it and unticks', () => {
    item.click();
    expect(widget().hidden).toBe(false);
    expect(ticked()).toBe('true');
    item.click();
    expect(widget().hidden).toBe(true);
    expect(ticked()).toBe('false');
  });

  it('the D key keeps the tick right', () => {
    pressD();
    expect(widget().hidden).toBe(false);
    expect(ticked()).toBe('true');
    pressD();
    expect(widget().hidden).toBe(true);
    expect(ticked()).toBe('false');
  });

  it('after any mix of D and the menu, the tick and the widget agree', () => {
    const steps = [pressD, () => item.click(), () => item.click(), pressD, pressD, () => item.click()];
    for (const step of steps) {
      step();
      expect(ticked()).toBe(String(!widget().hidden));
      expect(ticked()).toBe(String(sim.isVisible));
    }
  });

  it('is remembered: every show or hide, by the menu or the D key, saves player.deviceSimulatorVisible', () => {
    const store = {};
    setup({ store });
    item.click();
    expect(store['player.deviceSimulatorVisible']).toBe(true);
    pressD();
    expect(store['player.deviceSimulatorVisible']).toBe(false);
    pressD();
    expect(store['player.deviceSimulatorVisible']).toBe(true);
  });

  it('comes back on screen and ticked at launch when it was left on; off or never set, it stays hidden', () => {
    setup({ store: { 'player.deviceSimulatorVisible': true } });
    expect(widget().hidden).toBe(false);
    expect(ticked()).toBe('true');
    setup({ store: { 'player.deviceSimulatorVisible': false } });
    expect(widget().hidden).toBe(true);
    expect(ticked()).toBe('false');
    setup({ store: {} });
    expect(widget().hidden).toBe(true);
    expect(ticked()).toBe('false');
  });

  it('launching does not write the setting (only a real toggle does)', () => {
    const store = { 'player.deviceSimulatorVisible': true };
    const writes = [];
    setup({ store: new Proxy(store, { set(t, k, v) { writes.push(k); t[k] = v; return true; } }) });
    expect(writes).toEqual([]);
  });

  it('the store default is off, so a first launch looks as it always has', () => {
    expect(DEFAULTS.settings.player.deviceSimulatorVisible).toBe(false);
  });

  it('shows only over the player view: on in the Library it stays on (ticked) but is not drawn there (real player.css)', () => {
    // TODO.md: "stays visible over the Library and Playlists views once shown
    // with D". Remembered across restarts, it would have sat over the Library
    // at every launch.
    const style = document.createElement('style');
    style.textContent = fs.readFileSync('renderer/styles/player.css', 'utf8');
    document.head.appendChild(style);
    try {
      const appEl = document.getElementById('app');
      item.click();
      expect(sim.isVisible).toBe(true);
      expect(ticked()).toBe('true');
      for (const view of ['library', 'playlists', 'categories']) {
        appEl.dataset.view = view;
        expect(getComputedStyle(widget()).display, view).toBe('none');
      }
      delete appEl.dataset.view;                     // boot, before any view is entered
      expect(getComputedStyle(widget()).display).toBe('none');
      appEl.dataset.view = 'player';
      expect(getComputedStyle(widget()).display).toBe('flex');
      item.click();                                  // off is off on the player too
      expect(getComputedStyle(widget()).display).toBe('none');
    } finally {
      style.remove();
    }
  });

  it('works with no settings object at all (nothing to save, nothing throws)', () => {
    expect(() => { item.click(); item.click(); }).not.toThrow();
  });

  it('is labelled in every locale and the opacity hint now names the menu', () => {
    expect(item.textContent.trim()).toBe(EN.player.deviceSimulator);
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const b = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
      expect(b.player.deviceSimulator, l).toBeTruthy();
      expect(b.settingsPanel.playback.deviceSimOpacityHint, l).toMatch(/⋮/);
    }
  });

  it('is not in the player pop-out, which has no simulator', () => {
    const doc = new DOMParser().parseFromString(POPOUT, 'text/html');
    expect(doc.getElementById('btn-inline-hm')).not.toBeNull(); // sanity: same menu shape
    expect(doc.getElementById('btn-device-sim')).toBeNull();
    expect(fs.readFileSync('renderer/player-popout.js', 'utf8')).not.toMatch(/btn-device-sim|DeviceSimulator/);
  });
});
