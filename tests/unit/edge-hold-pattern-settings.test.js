// Edge Hold "Play a pattern", the parts a user sees (next major, design
// DESIGN-pattern-library.md §e): Settings > Playback > Edge Hold gets "While
// Edge Hold is on: Stop the devices / Play a pattern" and, for the pattern,
// the same pattern rows as the Orgasm source; the ? overlay's Z row says
// what Z does; the device simulator follows the edge loop as it follows the
// Orgasm Switch. The Settings panel is the REAL one, built from the REAL
// options app.js hands it; the simulator and the loop are REAL too.
//
// jsdom (no docblock): the REAL SettingsPanel and DeviceSimulator build DOM
// and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';

const SETTINGS = vi.hoisted(() => ({}));
vi.mock('../../renderer/js/data-service.js', () => ({
  dataService: { get: (key) => SETTINGS[key], set: (key, v) => { SETTINGS[key] = v; } },
}));

import { liftCtorOptions } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { DeviceSimulator } from '../../renderer/components/device-simulator.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { getPlayerShortcutGroups } from '../../renderer/js/keyboard-help.js';
import { EDGE_PATTERN_DEFAULTS, buildPatternSourceContent, patternSpeedBounds } from '../../renderer/js/pattern-source.js';
import { listPatterns } from '../../renderer/js/pattern-library.js';
import { interpolatePosition } from '../../renderer/js/handy-hdsp-sync.js';
import { parseFinisherActions } from '../../renderer/js/orgasm-plan.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

let store;
let showing;

function makeApp() {
  return {
    settings: { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }), getAll: () => ({}) },
    funscriptEngine: { isLoaded: false, getActions: () => [], hasFiller: false },
    videoPlayer: { duration: 0, video: { duration: 0 } },
    buttplugSync: { reloadActions() {} },
    tcodeSync: { reloadActions() {} },
    progressBar: { renderHeatmap() {} },
    _orgasmSummaryText: () => [],
    _reloadOrgasmScripts: async () => {},
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (sel) => document.querySelector(sel);
const choose = async (sel, value) => {
  $(sel).value = value;
  $(sel).dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

beforeEach(() => {
  store = {};
  showing = null;
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  window.funsync = {
    setSetting: () => {},
    onGlobalShortcut: () => {},
    setGlobalShortcuts: async () => [],
    convertFunscript: async () => null,
    readFunscript: async () => null,
  };
});
afterEach(async () => {
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
});
afterAll(() => _setBundlesForTests('en', EN, EN));

describe('Settings > Playback > Edge Hold', () => {
  const appOptions = liftCtorOptions('SettingsPanel', { showToast: vi.fn(), t });
  async function openPlayback(app) {
    const panel = new SettingsPanel(appOptions.call(app));
    showing = panel.show();
    document.querySelector('.settings-panel__rail-item[data-area="playback"]').click();
    await flush();
    return panel;
  }

  it('offers "Stop the devices" (the default, today) and "Play a pattern"; opens on stop with the rows hidden and nothing written', async () => {
    const app = makeApp();
    await openPlayback(app);
    const sel = $('#sp-sec-edge #sp-edge-action');
    expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([
      ['stop', 'Stop the devices'], ['pattern', 'Play a pattern'],
    ]);
    expect(sel.value).toBe('stop');
    expect($('#sp-edge-action-hint').textContent).toBe(EN.settingsPanel.playback.edgeActionHint);
    expect($('#sp-edge-pattern-rows').hidden).toBe(true);
    expect($('#sp-sec-edge #sp-edge-mode')).not.toBeNull();       // the hold / toggle choice is still there
    expect(app.settings.set).not.toHaveBeenCalledWith('player.edgeHoldAction', expect.anything());
    expect(app.settings.set).not.toHaveBeenCalledWith('player.edgePattern', expect.anything());
  });

  // Since the pattern settings unification (2026-11-19) the rows are the
  // shared Pattern block and save through pattern-choice.js
  // patternChoiceWrites, never into `player.edgePattern` (v0.9.2's key,
  // kept as stored). "Play a pattern" / "Stop the devices", the
  // "Choose a pattern…" start, the note, every row and the old key left
  // untouched: pattern-block-settings.test.js and pattern-block.test.js.

  it('a broken stored value opens safely: an unknown mode is "stop", an unknown pattern is none chosen', async () => {
    const app = makeApp();
    store['player.edgeHoldAction'] = 'sometimes';
    store['player.edgePattern'] = { id: 'gone', speed: 'x' };
    await openPlayback(app);
    expect($('#sp-edge-action').value).toBe('stop');
    // The pattern's summary row (the picker is in the "Set pattern…" drawer since 2026-11-19).
    expect($('#sp-edge-pattern-summary').classList.contains('pattern-summary__text--none')).toBe(true);
    expect($('#sp-edge-pattern-summary-graph').hidden).toBe(true);
    expect(app.settings.set).not.toHaveBeenCalledWith('player.edgePattern', expect.anything());
  });
});

describe('the ? overlay\'s Z row says what Z does', () => {
  const rowFor = (key) => getPlayerShortcutGroups().flatMap((g) => g.rows).find(([keys]) => keys === key);

  it('stop (default): as before; pattern with one chosen: "play the edge pattern", in both hold and toggle', () => {
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHold'));
    SETTINGS['player.edgeHoldAction'] = 'pattern';
    // No pattern chosen yet (the default since 2026-11-17): Z stops, and says so.
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHold'));
    SETTINGS['player.edgePattern'] = { id: 'no-such-pattern' };
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHold'));
    SETTINGS['player.edgePattern'] = { id: 'slow-tip-strokes' };
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHoldPattern'));
    expect(rowFor('Z')[1]).toBe('Edge hold — play the edge pattern, video keeps playing');
    SETTINGS['player.edgeHoldMode'] = 'toggle';
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHoldPatternToggle'));
    SETTINGS['player.edgeHoldAction'] = 'stop';
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHoldToggle'));
  });
});

describe('the device simulator follows the edge loop', () => {
  it('while the loop plays, the indicator shows the loop\'s position, not the video\'s', () => {
    if (!document.getElementById('app')) {
      const root = document.createElement('div');
      root.id = 'app';
      document.body.appendChild(root);
    }
    const sim = new DeviceSimulator({
      videoPlayer: { video: document.createElement('video'), currentTime: 0, paused: true },
      funscriptEngine: { isLoaded: true, getPositionAt: () => 50 },
    });
    const raw = buildPatternSourceContent({ ...EDGE_PATTERN_DEFAULTS, id: 'slow-tip-strokes' });
    let clock = 0;
    const loop = new OrgasmSwitch({ now: () => clock });
    loop.setTimerImpl(() => 1, () => {});
    loop.loadScript(raw);
    sim.edgeLoop = loop;
    expect(sim.getPosition()).toBe(50);                 // not playing: the script
    loop.activate();
    clock = 777;
    loop._tick();
    expect(sim.getPosition()).toBeCloseTo(interpolatePosition(parseFinisherActions(raw), 777), 6);
    loop.deactivate();
    expect(sim.getPosition()).toBe(50);
    sim.hide();
    document.querySelector('.device-sim')?.remove();
  });
});
