/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel opens through Modal.open() and
 * builds its Playback area as DOM, and the device-simulator applier writes a
 * CSS custom property on document.documentElement (notes/CLAUDE.md
 * "Test environments").
 */
// Settings callbacks that never arrived (app test V71).
//
// app.js handed SettingsPanel `onGapFillerChanged` and
// `onDeviceSimOpacityChanged`, but the constructor never destructured either,
// so both were undefined on the panel and every `if (this.onX) this.onX(…)`
// was skipped. The setting saved and nothing applied it: turning gap filler
// on or off, or changing its pattern, changed nothing until the next video
// was opened, and the device-simulator opacity slider and its reset changed
// nothing until a restart. device-sim-opacity-wiring.test.js was green the
// whole time, because both files did contain the name.
//
// The options here are app.js's own: the `new SettingsPanel({ ... })` literal
// is lifted out of init() and evaluated against an app-shaped object whose
// appliers are the REAL app.js methods, over a REAL FunscriptEngine. What is
// asserted is what the user gets: the actions the devices play, the heatmap
// redraw, the CSS property the simulator widget reads, the next Z press.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { APP_SRC, liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { FunscriptEngine } from '../../renderer/js/funscript-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
// Code only: a comment that mentions a callback is not a call.
const PANEL_CODE = fs.readFileSync('renderer/components/settings-panel.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const constant = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(APP_SRC)[1]);

const LiftedApp = liftAppClass(
  ['_applyFillerSettings', '_fillerOptionsForUpload', '_refreshHeatmap',
    '_applyInlineVizOpacity', '_applyDeviceSimOpacity', '_onEdgeHold'],
  {
    resolveFillerOptions,
    INLINE_VIZ_OPACITY_DEFAULT: constant('INLINE_VIZ_OPACITY_DEFAULT'),
    DEVICE_SIM_OPACITY_DEFAULT: constant('DEVICE_SIM_OPACITY_DEFAULT'),
  },
);

// app.js's `new SettingsPanel({ ... })`, every key and callback as init() builds it.
const appOptions = liftCtorOptions('SettingsPanel', { showToast: vi.fn(), t });

// Strokes for 4 s, a minute of nothing, strokes again: one gap well over the
// 10 s threshold, nowhere near either end of the 70 s video.
const ACTIONS = [];
for (let at = 0; at <= 4000; at += 500) ACTIONS.push({ at, pos: (at / 500) % 2 ? 100 : 0 });
for (let at = 64000; at <= 68000; at += 500) ACTIONS.push({ at, pos: (at / 500) % 2 ? 100 : 0 });
const DURATION_S = 70;

let store;
let showing;

function makeSettings() {
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getAll: () => ({}),
  };
}

async function makeApp() {
  const app = new LiftedApp();
  app.settings = makeSettings();
  app.funscriptEngine = new FunscriptEngine({ backendPort: 5123 });
  await app.funscriptEngine.loadContent(JSON.stringify({ actions: ACTIONS.map((a) => ({ ...a })) }), 'Gap Clip.funscript');
  app.videoPlayer = { duration: DURATION_S, video: { duration: DURATION_S } };
  app.buttplugSync = { reloadActions: vi.fn() };
  app.tcodeSync = { reloadActions: vi.fn() };
  app.progressBar = { renderHeatmap: vi.fn() };
  // Read by getOrgasmScriptName while Playback renders; no finisher configured.
  app._orgasmSummaryText = () => [];
  return app;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Open Settings the way the nav-bar gear does, then go to Playback. */
async function openPlayback(app) {
  const panel = new SettingsPanel(appOptions.call(app));
  showing = panel.show();
  document.querySelector('.settings-panel__rail-item[data-area="playback"]').click();
  await flush(); // Playback wires its controls on a 0 ms timer after mount
  return panel;
}

const fillerOf = (engine) => engine.getActions().filter((a) => a._filler);

beforeEach(() => {
  store = {};
  showing = null;
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--device-sim-opacity');
  _setBundlesForTests('en', EN, EN);
  window.funsync = {
    setSetting: () => {},
    onGlobalShortcut: () => {},
    setGlobalShortcuts: async () => [],
    convertFunscript: async () => null,
  };
});

afterEach(async () => {
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
});

afterAll(() => _setBundlesForTests('en', EN, EN));

describe('Settings changes apply at once (V71)', () => {
  it('turning gap filler on fills the gap the devices play, and off takes it out again', async () => {
    const app = await makeApp();
    const engine = app.funscriptEngine;
    await openPlayback(app);
    expect(engine.hasFiller).toBe(false);

    document.querySelector('#sp-filler-enabled').click();

    expect(store['player.gapFiller'].enabled).toBe(true);
    expect(engine.hasFiller).toBe(true);
    const filler = fillerOf(engine);
    expect(filler.length).toBeGreaterThan(0);
    expect(filler.every((a) => a.at > 4000 && a.at < 64000)).toBe(true);
    // The tick engines re-read the list and the seek-bar heatmap redraws from it.
    expect(app.buttplugSync.reloadActions).toHaveBeenCalled();
    expect(app.tcodeSync.reloadActions).toHaveBeenCalled();
    expect(app.progressBar.renderHeatmap).toHaveBeenLastCalledWith(engine.getActions(), DURATION_S);

    document.querySelector('#sp-filler-enabled').click();

    expect(store['player.gapFiller'].enabled).toBe(false);
    expect(engine.hasFiller).toBe(false);
    expect(engine.getActions()).toHaveLength(ACTIONS.length);
    expect(app.progressBar.renderHeatmap).toHaveBeenLastCalledWith(engine.getActions(), DURATION_S);
  });

  it('changing the filler pattern while it is on applies at once: what plays is what a fresh load of the new settings plays', async () => {
    // Since the pattern settings unification (2026-11-19) the pattern is the
    // shared Pattern block's (no preset select), saved through
    // pattern-choice.js under `player.gapFiller.pattern`, so the store here
    // is DataService's shape: dotted paths into one object.
    const data = { player: { gapFiller: { enabled: true, presetId: 'slowTease' } } };
    const nested = {
      get: (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data),
      set: (path, v) => {
        const keys = path.split('.');
        let o = data;
        for (const k of keys.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
        o[keys.at(-1)] = v;
      },
      getAll: () => data,
    };
    const app = await makeApp();
    app.settings = nested;
    app._applyFillerSettings(); // what the video load did
    expect(fillerOf(app.funscriptEngine)).not.toEqual([]);
    await openPlayback(app);
    const reloads = app.buttplugSync.reloadActions.mock.calls.length;
    const heatmaps = app.progressBar.renderHeatmap.mock.calls.length;

    // "Set pattern…" opens the shared drawer; the choice applies on Apply.
    document.querySelector('#sp-filler-pattern-set').click();
    const family = document.querySelector('#sp-filler-pattern-family');
    family.value = '';
    family.dispatchEvent(new Event('change', { bubbles: true }));
    const pattern = document.querySelector('#sp-filler-pattern-id');
    pattern.value = 'quick-full-strokes';
    pattern.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.buttplugSync.reloadActions.mock.calls.length).toBe(reloads);   // a draft changes nothing
    document.querySelector('#sp-filler-pattern-drawer-apply').click();

    // Applied now, not at the next video: the devices re-read, the bar redraws...
    expect(app.buttplugSync.reloadActions.mock.calls.length).toBeGreaterThan(reloads);
    expect(app.tcodeSync.reloadActions).toHaveBeenCalled();
    expect(app.progressBar.renderHeatmap.mock.calls.length).toBeGreaterThan(heatmaps);
    // ...and what plays is exactly what a fresh load of the saved settings plays.
    const fresh = await makeApp();
    fresh.settings = nested;
    fresh._applyFillerSettings();
    expect(fillerOf(app.funscriptEngine)).toEqual(fillerOf(fresh.funscriptEngine));
    // v0.9.2's preset is never rewritten.
    expect(data.player.gapFiller.presetId).toBe('slowTease');
  });

  it('the device-simulator opacity slider applies while it moves, and its reset puts it back', async () => {
    const app = await makeApp();
    await openPlayback(app);
    const root = document.documentElement.style;
    const slider = document.querySelector('#sp-device-sim-opacity');
    const reset = document.querySelector('#sp-device-sim-opacity-reset');

    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(store['player.deviceSimOpacity']).toBe(40);
    expect(root.getPropertyValue('--device-sim-opacity')).toBe('0.4');
    expect(reset.hidden).toBe(false);

    reset.click();

    expect(store['player.deviceSimOpacity']).toBe(80);
    expect(root.getPropertyValue('--device-sim-opacity')).toBe('0.8');
  });

  it('an opacity ↻ reset keeps focus inside Settings (it hides itself on click)', async () => {
    // Found by the V71 verify (2026-11-04, also in v0.9.2): the reset hid the
    // focused button, focus fell to <body>, and Space then played the video
    // behind the open dialog. The other ↻ resets already focused their field.
    const app = await makeApp();
    await openPlayback(app);
    for (const id of ['sp-device-sim-opacity', 'sp-inline-viz-opacity']) {
      const slider = document.querySelector(`#${id}`);
      const reset = document.querySelector(`#${id}-reset`);
      if (!slider || !reset) continue;
      slider.value = '40';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      expect(reset.hidden).toBe(false);
      reset.focus();
      reset.click();
      expect(reset.hidden, id).toBe(true);
      expect(document.activeElement, id).toBe(slider);
      expect(document.activeElement.closest('[aria-modal="true"]'), id).not.toBeNull();
    }
  });

  it('Edge Hold mode needs no callback: the next Z press reads the new mode', async () => {
    // The panel used to call an onEdgeHoldModeChanged that nothing passed or
    // stored. It is gone because _onEdgeHold reads the setting on every press.
    const app = await makeApp();
    app._stopAllDevicesIdle = () => {};
    await openPlayback(app);
    const mode = document.querySelector('#sp-edge-mode');
    mode.value = 'toggle';
    mode.dispatchEvent(new Event('change', { bubbles: true }));

    app._onEdgeHold(true);   // Z down
    app._onEdgeHold(false);  // Z up: ignored in toggle mode
    expect(app._edgeActive).toBe(true);
    app._onEdgeHold(true);   // the second press releases it
    expect(app._edgeActive).toBe(false);
  });
});

describe('every callback crosses the app.js → SettingsPanel seam (V71 guard)', () => {
  it('the constructor keeps every option app.js passes', async () => {
    const real = appOptions.call(await makeApp());
    // A distinct marker per key, so "kept" means "this exact value is on the panel".
    const marked = Object.fromEntries(Object.entries(real).map(([k, v]) => [
      k, typeof v === 'function' ? Object.defineProperty(() => {}, 'name', { value: k }) : v,
    ]));
    const panel = new SettingsPanel(marked);
    const held = new Set(Object.values(panel));
    const dropped = Object.keys(marked).filter((k) => !held.has(marked[k]));
    expect(dropped, 'app.js passes these, the SettingsPanel constructor drops them').toEqual([]);
  });

  it('every callback the panel holds is one app.js wires', async () => {
    const real = appOptions.call(await makeApp());
    const panel = new SettingsPanel(real);
    const passed = new Set(Object.values(real));
    const unwired = Object.keys(panel)
      .filter((k) => /^_?(on|get)[A-Z]/.test(k))
      .filter((k) => !passed.has(panel[k]));
    expect(unwired, 'the panel stores these, app.js never passes them').toEqual([]);
  });

  it('every callback the panel calls is one its constructor stores', async () => {
    const panel = new SettingsPanel(appOptions.call(await makeApp()));
    const called = [...new Set([...PANEL_CODE.matchAll(/this\.(_?(?:on|get)[A-Z]\w*)/g)].map((m) => m[1]))]
      .filter((name) => typeof SettingsPanel.prototype[name] !== 'function');
    expect(called.length).toBeGreaterThan(10);
    const neverStored = called.filter((name) => !Object.hasOwn(panel, name));
    expect(neverStored, 'settings-panel.js calls these, nothing ever sets them').toEqual([]);
  });
});
