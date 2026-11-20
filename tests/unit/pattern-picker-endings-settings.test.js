// Settings side of Dave's pattern answers (2026-11-17, evening; follow-oe):
// the Orgasm "Pattern from the library" picker and the Edge pattern picker
// offer the endings, marked "plays once, then holds" and explained when one
// is chosen; with no pattern chosen each says what happens instead; and a
// range too narrow for the pattern, which the engine plays wider
// (range-widened), gets a short note under the range rows. The Settings
// panel is the REAL one, built from the REAL options app.js hands it.
//
// jsdom (no docblock): the REAL SettingsPanel builds DOM and i18n.js
// branches on `typeof window` (notes/CLAUDE.md "Test environments").
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';

const SETTINGS = vi.hoisted(() => ({}));
vi.mock('../../renderer/js/data-service.js', () => ({
  dataService: { get: (key) => SETTINGS[key], set: (key, v) => { SETTINGS[key] = v; } },
}));

import { liftCtorOptions } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { patternSourceLoop, clearPatternSourceCache, buildPatternSourceContent } from '../../renderer/js/pattern-source.js';
import { DeviceSimulator } from '../../renderer/components/device-simulator.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { parseFinisherActions } from '../../renderer/js/orgasm-plan.js';
import { interpolatePosition } from '../../renderer/js/handy-hdsp-sync.js';
import { listPatterns } from '../../renderer/js/pattern-library.js';

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const BUNDLES = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));
const EN = BUNDLES.en;
const ENDINGS = listPatterns({ loopable: false }).map((p) => p.id);
// Mixed flutters at the tip in a 5-unit band: the engine widens it.
const NARROW = { id: 'mixed-flutters-tip', speed: 172, reversed: false, min: 20, max: 25 };

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
const appOptions = liftCtorOptions('SettingsPanel', { showToast: vi.fn(), t });
async function openPlayback(app) {
  const panel = new SettingsPanel(appOptions.call(app));
  showing = panel.show();
  document.querySelector('.settings-panel__rail-item[data-area="playback"]').click();
  await flush();
  return panel;
}
const widenedTo = (p) => patternSourceLoop(p).warnings.find((w) => w.code === 'range-widened').values.to;

beforeEach(() => {
  store = {};
  showing = null;
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  document.body.innerHTML = '';
  clearPatternSourceCache();
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

describe('the endings are offered and marked', () => {
  // The Edge picker's endings (marked, explained, their group listing them
  // all) are pinned for the ONE Pattern block of all three features since
  // the pattern settings unification (2026-11-19): pattern-block.test.js
  // and pattern-block-settings.test.js.

  it('every locale has the mark, the hold explanation, the placeholder and the notes, each in its own words', () => {
    const keys = [
      ['patterns', 'ui', 'oneShotName'], ['patterns', 'ui', 'oneShotHint'], ['patterns', 'ui', 'choosePattern'],
      ['settingsPanel', 'playback', 'patternRangeWidened'], ['settingsPanel', 'playback', 'orgasmLibraryNone'],
      ['settingsPanel', 'playback', 'edgePatternNone'],
    ];
    for (const path of keys) {
      const en = path.reduce((o, k) => o[k], EN);
      for (const l of LOCALES) {
        const v = path.reduce((o, k) => o?.[k], BUNDLES[l]);
        expect(typeof v, `${l}:${path.join('.')}`).toBe('string');
        if (l !== 'en') expect(v, `${l}:${path.join('.')}`).not.toBe(en);
      }
    }
    for (const l of LOCALES) {
      expect(BUNDLES[l].patterns.ui.oneShotName).toContain('{name}');
      expect(BUNDLES[l].settingsPanel.playback.patternRangeWidened).toContain('{lo}');
      expect(BUNDLES[l].settingsPanel.playback.patternRangeWidened).toContain('{hi}');
    }
  });
});

// "A range too narrow for the pattern says it plays wider" (the note under
// the range rows, the band it plays, in the locale in use; no note for a
// normal range or no pattern) is pinned for the ONE Pattern block of Gap
// Filler, Orgasm Switch and Edge Hold since the pattern settings
// unification (2026-11-19): pattern-block.test.js and
// pattern-block-settings.test.js.

describe('the device simulator shows an ending play once and hold', () => {
  it('during the hold it follows the ending, then stays on its last position; after the release it shows the script again', () => {
    if (!document.getElementById('app')) {
      const root = document.createElement('div');
      root.id = 'app';
      document.body.appendChild(root);
    }
    const sim = new DeviceSimulator({
      videoPlayer: { video: document.createElement('video'), currentTime: 0, paused: true },
      funscriptEngine: { isLoaded: true, getPositionAt: () => 50 },
    });
    const raw = buildPatternSourceContent({ id: 'plunge-finish' });
    const actions = parseFinisherActions(raw);
    const end = actions.at(-1).at;
    let clock = 0;
    for (const prop of ['edgeLoop', 'orgasmSwitch']) {
      const loop = new OrgasmSwitch({ now: () => clock });
      loop.setTimerImpl(() => 1, () => {});
      loop.loadScript(raw, { once: true });
      sim.edgeLoop = null;
      sim.orgasmSwitch = null;
      sim[prop] = loop;
      clock = 0;
      loop.activate();
      clock = Math.round(end / 2);
      loop._tick();
      expect(sim.getPosition()).toBeCloseTo(interpolatePosition(actions, Math.round(end / 2)), 6);
      for (const t of [end + 40, end + 2000, end * 3]) {
        clock = t;
        loop._tick();
        expect(sim.getPosition(), prop).toBeCloseTo(actions.at(-1).pos, 6);
      }
      loop.deactivate();
      expect(sim.getPosition()).toBe(50);
    }
    sim.hide();
    document.querySelector('.device-sim')?.remove();
  });
});
