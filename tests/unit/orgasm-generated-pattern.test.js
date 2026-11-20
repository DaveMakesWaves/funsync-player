// Orgasm Switch "Generated pattern" source (Downlow87 #373), C6 of the
// 2026-11-04 small features.
//
// Settings > Orgasm Switch > Source = "Generated pattern" makes the finisher a
// pattern from generatePattern instead of the script file(s) chosen with
// Configure…. What is asserted is what the user gets: the funscript the
// pattern becomes, the actions the switch loops, the content the Handy
// finisher UPLOADS (a recording stub, nothing leaves the test), the file
// configuration after switching back, the Settings summary and the phone's
// orgasm-state. The app.js methods are the REAL ones lifted out of app.js;
// the Settings panel and the OrgasmSwitch are REAL, built from the REAL
// options app.js hands them.
//
// jsdom (no docblock): the REAL SettingsPanel builds DOM and i18n.js branches
// on `typeof window` (notes/CLAUDE.md "Test environments").
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
import { patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround } from '../../renderer/js/pattern-choice.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import {
  resolveOrgasmPlan, parseFinisherActions, collectOrgasmScriptPaths, describeOrgasmEntry,
} from '../../renderer/js/orgasm-plan.js';
import { engageHandyFinisher, releaseHandyFinisher, tileFinisherContent } from '../../renderer/js/orgasm-handy-engage.js';
import { normalizeAssociation, buildAssociationEntry } from '../../renderer/js/association-shape.js';
import { findMovedFile } from '../../renderer/js/association-rehome.js';
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';
import { generatePattern } from '../../renderer/js/script-modifiers.js';
import { interpolatePosition } from '../../renderer/js/handy-hdsp-sync.js';
import {
  ORGASM_PATTERN_DEFAULTS, ORGASM_PATTERN_TYPES, normalizeOrgasmPattern, orgasmPatternSettings,
  orgasmPatternKey, orgasmPatternLoopMs, buildOrgasmPatternContent, isOrgasmPatternKey,
} from '../../renderer/js/orgasm-pattern.js';

const require_ = createRequire(import.meta.url);
const { DEFAULTS } = require_('../../electron/store.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const FILE = 'C:\\Finishers\\finish.funscript';
const FILE_CONTENT = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 400, pos: 90 }, { at: 800, pos: 10 }] });

const LiftedApp = liftAppClass(
  ['_reloadOrgasmScripts', '_recoverOrgasmPaths', '_saveOrgasmConfigQuiet', '_refreshOrgasmPlan',
    '_getOrgasmEntry', '_orgasmSummaryText', '_pushRemoteOrgasmState', '_clearOrgasmScript',
    // the shared pattern choice (pattern settings unification, 2026-11-19)
    '_orgasmLibrarySource', '_orgasmLibrarySettings', '_patternScriptRange'],
  {
    patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround,
    orgasmPatternSettings, orgasmPatternKey, buildOrgasmPatternContent,
    parseFinisherActions, collectOrgasmScriptPaths, describeOrgasmEntry, resolveOrgasmPlan,
    normalizeAssociation, buildAssociationEntry, findMovedFile, getAxisBySuffix,
    showToast: () => {}, t,
  },
);

let store;
let showing;

function makeSettings() {
  return { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }), getAll: () => ({}) };
}

/** A Handy that records what the finisher uploads; the upload is a stub. */
function recordingHandy() {
  const calls = [];
  return {
    calls,
    connected: true,
    uploadScriptOnly: vi.fn(async (content) => { calls.push({ kind: 'upload', content }); return 'https://example.invalid/finisher'; }),
    setupScript: vi.fn(async (url) => { calls.push({ kind: 'setup', url }); return true; }),
    hsspPlay: vi.fn(async (ms) => { calls.push({ kind: 'play', ms }); }),
    hsspStop: vi.fn(async () => { calls.push({ kind: 'stop' }); }),
  };
}

function makeApp({ handy = null, remote = null } = {}) {
  const app = new LiftedApp();
  app.settings = makeSettings();
  app.handyManager = handy;
  app.buttplugManager = null;
  app.tcodeManager = null;
  app.remoteBridge = remote;
  app.library = { getAllFunscriptPaths: () => [FILE], _safeToPrune: async () => true };
  app._recoverOrgasmPaths = vi.fn(app._recoverOrgasmPaths.bind(app));
  // The REAL OrgasmSwitch, from the REAL options app.js passes it.
  const options = liftCtorOptions('OrgasmSwitch', { engageHandyFinisher, releaseHandyFinisher }).call(app);
  app.orgasmSwitch = new OrgasmSwitch(options);
  app._cutoffFromSettings = () => null;
  app._handyInverted = () => false;
  app._restoreHandyAfterOrgasm = () => {};
  app._stopAllDevicesIdle = () => {};
  // The Settings panel's Playback area needs these to render.
  app.funscriptEngine = { isLoaded: false, getActions: () => [], hasFiller: false };
  app.videoPlayer = { duration: 0, video: { duration: 0 } };
  app.buttplugSync = { reloadActions() {} };
  app.tcodeSync = { reloadActions() {} };
  app.progressBar = { renderHeatmap() {} };
  return app;
}

const fileEntry = () => buildAssociationEntry('single', FILE, null, null);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store = {};
  showing = null;
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  window.funsync = {
    setSetting: () => {},
    onGlobalShortcut: () => {},
    setGlobalShortcuts: async () => [],
    convertFunscript: async () => null,
    readFunscript: vi.fn(async (p) => (p === FILE ? FILE_CONTENT : null)),
  };
});
afterEach(async () => {
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
});
afterAll(() => _setBundlesForTests('en', EN, EN));

// ---------------------------------------------------------------------------
describe('the generated pattern', () => {
  it('defaults OFF (the script file, today), and the store default matches the module', () => {
    expect(DEFAULTS.settings.player.orgasmPattern).toEqual({ ...ORGASM_PATTERN_DEFAULTS });
    expect(orgasmPatternSettings(DEFAULTS.settings.player.orgasmPattern)).toBeNull();
    expect(orgasmPatternSettings(undefined)).toBeNull();
    expect(orgasmPatternSettings({ enabled: 'yes' })).toBeNull();   // only `true` turns it on
  });

  it('is valid funscript JSON holding generatePattern\'s shape for the chosen pattern, one action per instant', () => {
    // The shapes without an instant edge are generated over the whole loop.
    // (Sawtooth and square repeat one generated beat: the next describe.)
    // Building is not here any more: generatePattern's escalating starts on a
    // flat beat, which the finisher held at every wrap (CB-16); its own
    // shape is pinned by the two Building tests below.
    for (const type of ['sine', 'triangle']) {
      for (const bpm of [150, 180]) {
        const json = JSON.parse(buildOrgasmPatternContent({ enabled: true, type, bpm, min: 20, max: 80 }));
        const generated = generatePattern(type, 0, orgasmPatternLoopMs(bpm), bpm, 20, 80);
        expect(json.version).toBe('1.0');
        // Every timestamp the generator chose is there, each exactly once,
        // with the generator's first position for it.
        expect(json.actions.map((a) => a.at)).toEqual([...new Set(generated.map((a) => a.at))]);
        for (const a of json.actions) expect(a.pos, `${type} ${bpm} @${a.at}`).toBe(generated.find((g) => g.at === a.at).pos);
      }
    }
    for (const type of ORGASM_PATTERN_TYPES) {
      const p = { enabled: true, type, bpm: 150, min: 20, max: 80 };
      const json = JSON.parse(buildOrgasmPatternContent(p));
      const actions = parseFinisherActions(JSON.stringify(json));
      expect(actions, type).not.toBeNull();                         // a usable finisher
      expect(actions.every((a) => a.pos >= 20 && a.pos <= 80), type).toBe(true);
      expect(actions.at(-1).at).toBe(orgasmPatternLoopMs(150));
    }
    const random = parseFinisherActions(buildOrgasmPatternContent({ enabled: true, type: 'random', min: 30, max: 60 }));
    expect(random.every((a) => a.pos >= 30 && a.pos <= 60)).toBe(true);
  });

  it('loops on a whole beat, so the wrap lands where the loop started', () => {
    expect(orgasmPatternLoopMs(120)).toBe(10000);          // 20 beats of 500 ms
    expect(orgasmPatternLoopMs(70) % (60000 / 70)).toBeLessThan(1);
    for (const type of ORGASM_PATTERN_TYPES) {
      for (const bpm of [20, 70, 120, 299]) {
        const actions = JSON.parse(buildOrgasmPatternContent({ enabled: true, type, bpm })).actions;
        expect(actions.at(-1).pos, `${type} ${bpm}`).toBe(actions[0].pos);
      }
    }
  });

  // FT-016 (2026-11-05, new since v0.9.2): 'Building' dropped its last beat
  // at 121 of the 281 BPMs. It was generatePattern over the ROUNDED loop
  // length, and generatePattern floors its cycle count, so whenever
  // Math.round(beats * beatMs) rounded down one cycle (the strongest) was
  // lost and the loop ended early: 21 BPM by 2857 ms, 43 BPM by 1395 ms.
  it('Building has every beat at every BPM 20-300: one cycle per beat on the grid, climbing to max, closing at the loop length', () => {
    const short = [];
    for (let bpm = 20; bpm <= 300; bpm++) {
      for (const [min, max] of [[0, 100], [10, 90]]) {
        const actions = JSON.parse(buildOrgasmPatternContent({ enabled: true, type: 'escalating', bpm, min, max })).actions;
        const beatMs = 60000 / bpm;
        const beats = Math.max(1, Math.round(10000 / beatMs));
        const where = `${bpm} BPM ${min}-${max}`;
        if (actions.at(-1).at !== orgasmPatternLoopMs(bpm)) { short.push(where); continue; }
        // A bottom on every beat of the grid, and the wrap on the first one.
        const bottoms = Array.from({ length: beats + 1 }, (_, k) => Math.round(k * beatMs));
        for (const at of bottoms) {
          expect(actions.find((a) => a.at === at)?.pos, `${where} bottom @${at}`).toBe(min);
        }
        // Exactly one top inside each beat, never falling, the last one at max.
        const tops = [];
        for (let k = 0; k < beats; k++) {
          const inside = actions.filter((a) => a.at > bottoms[k] && a.at < bottoms[k + 1]);
          expect(inside, `${where} beat ${k}`).toHaveLength(1);
          tops.push(inside[0].pos);
        }
        expect(tops, where).toHaveLength(beats);
        expect(tops.every((pos, i) => i === 0 || pos >= tops[i - 1]), `${where} climbs`).toBe(true);
        expect(tops.at(-1), where).toBe(max);
        expect(actions, where).toHaveLength(2 * beats + 1);
      }
    }
    expect(short, 'loops that end before orgasmPatternLoopMs').toEqual([]);
  });

  // CB-16 (2026-11-05, found verifying block B; new since v0.9.2): Building's
  // first beat of every loop was flat, seen live at each wrap: about 1.1 s at
  // the bottom at 55 BPM, 2.9 s at 21 BPM. Its climb ran k / (beats - 1), so
  // beat 0 topped out at min. What is measured is what the device does: the
  // REAL OrgasmSwitch's per-tick loop, millisecond by millisecond, through
  // the wrap.
  it('Building never sits at the bottom through the wrap: the first beat of every loop moves', () => {
    const flat = [];
    for (let bpm = 20; bpm <= 300; bpm++) {
      const raw = buildOrgasmPatternContent({ enabled: true, type: 'escalating', bpm, min: 0, max: 100 });
      const loopMs = JSON.parse(raw).actions.at(-1).at;
      const beatMs = 60000 / bpm;
      let clock = 0;
      const sw = new OrgasmSwitch({ now: () => clock });
      sw.setTimerImpl(() => 1, () => {});
      sw.loadScript(raw);
      sw.activate();
      // The longest run at the bottom from the last beat into the second
      // loop's second beat. Only the instant of the bottom itself may be there.
      let run = 0;
      let longest = 0;
      let peakAfterWrap = 0;
      for (let t = Math.floor(loopMs - beatMs); t <= Math.ceil(loopMs + 2 * beatMs); t++) {
        clock = t;
        sw._tick();
        const pos = sw._livePos;
        run = pos <= 1e-6 ? run + 1 : 0;
        longest = Math.max(longest, run);
        if (t > loopMs && t < loopMs + beatMs) peakAfterWrap = Math.max(peakAfterWrap, pos);
      }
      if (longest > 2 || peakAfterWrap <= 0) flat.push(`${bpm} BPM: ${longest} ms at 0, first beat peaks at ${peakAfterWrap}`);
    }
    expect(flat).toEqual([]);
  });

  it('Building still climbs to max on the last beat, starting from its smallest stroke', () => {
    for (const [bpm, min, max] of [[55, 0, 100], [21, 0, 100], [120, 10, 90]]) {
      const actions = JSON.parse(buildOrgasmPatternContent({ enabled: true, type: 'escalating', bpm, min, max })).actions;
      const tops = actions.filter((_, i) => i % 2 === 1).map((a) => a.pos);
      const beats = tops.length;
      expect(tops[0], `${bpm} BPM first stroke`).toBe(Math.round(min + (max - min) / beats));
      expect(tops.at(-1), `${bpm} BPM last stroke`).toBe(max);
    }
  });

  it('normalises a hand-edited or broken value instead of failing', () => {
    expect(normalizeOrgasmPattern({ enabled: true, type: 'zigzag', bpm: 9999, min: 90, max: 10 }))
      .toEqual({ enabled: true, type: 'sine', bpm: 300, min: 10, max: 90 });
    expect(ORGASM_PATTERN_TYPES).toEqual(['sine', 'triangle', 'sawtooth', 'square', 'escalating', 'random']);
  });

  it('every field that shapes the content changes the key (the Handy upload cache is keyed on it)', () => {
    const base = { type: 'sine', bpm: 120, min: 0, max: 100 };
    const keys = new Set([base, { ...base, type: 'square' }, { ...base, bpm: 125 }, { ...base, min: 5 }, { ...base, max: 95 }]
      .map(orgasmPatternKey));
    expect(keys.size).toBe(5);
    expect([...keys].every(isOrgasmPatternKey)).toBe(true);
    expect(isOrgasmPatternKey(FILE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The review of 2026-11-04 measured the Handy's tiled Sawtooth holding at the
// top for 500 ms at every wrap (3 s at 20 BPM) and its Square ramping over
// 250 ms, while Buttplug / T-Code jumped: tileFinisherContent keeps one point
// per timestamp, and those loops ended on the far side of their wrap edge.
describe('the loop joins up on every device, every wrap', () => {
  const BPMS = [20, 35, 70, 120, 133, 150, 199, 250, 299, 300];

  /** What the Handy plays: the upload, tiled exactly as the finisher sends it. */
  const handyPlays = (raw) => JSON.parse(tileFinisherContent(raw)).actions;

  /** The REAL OrgasmSwitch's tick (Buttplug / T-Code) on a clock we set. */
  function tickLoop(raw) {
    let clock = 0;
    const sw = new OrgasmSwitch({ now: () => clock });
    sw.setTimerImpl(() => 1, () => {});
    expect(sw.loadScript(raw)).toBe(true);
    expect(sw.activate()).toBe('activated');
    return (t) => { clock = t; sw._tick(); return sw._livePos; };
  }

  it('the Handy\'s tiled upload and the per-tick loop are at the same position at every millisecond, through two wraps', () => {
    for (const type of ORGASM_PATTERN_TYPES) {
      for (const bpm of BPMS) {
        const raw = buildOrgasmPatternContent({ enabled: true, type, bpm, min: 10, max: 90 });
        const loopMs = JSON.parse(raw).actions.at(-1).at;
        const tiled = handyPlays(raw);
        const tick = tickLoop(raw);
        let firstMiss = null;
        for (let t = 0; t <= 2 * loopMs + 60000 / bpm && firstMiss === null; t++) {
          const handy = interpolatePosition(tiled, t);
          const local = tick(t);
          if (Math.abs(handy - local) > 1e-6) firstMiss = { t, handy, local };
        }
        expect(firstMiss, `${type} ${bpm} BPM`).toBeNull();
      }
    }
  });

  it('Sawtooth keeps its shape on the Handy across the wrap: a one-beat ramp, an instant drop, never a hold', () => {
    for (const bpm of BPMS) {
      const beatMs = 60000 / bpm;
      const raw = buildOrgasmPatternContent({ enabled: true, type: 'sawtooth', bpm, min: 10, max: 90 });
      const loopMs = JSON.parse(raw).actions.at(-1).at;
      const tiled = handyPlays(raw).filter((a) => a.at <= 3 * loopMs);
      for (let i = 1; i < tiled.length; i++) {
        const dt = tiled[i].at - tiled[i - 1].at;
        const where = `${bpm} BPM @${tiled[i - 1].at}`;
        expect(tiled[i].pos, where).not.toBe(tiled[i - 1].pos);           // never a hold
        expect([10, 90]).toContain(tiled[i].pos);
        if (tiled[i].pos < tiled[i - 1].pos) expect(dt, where).toBe(1);   // the drop is instant
        else expect(Math.abs(dt - beatMs), where).toBeLessThanOrEqual(2); // the ramp takes a beat
      }
    }
  });

  it('Square keeps its shape on the Handy across the wrap: half-beat holds and instant flips, never a ramp', () => {
    for (const bpm of BPMS) {
      const beatMs = 60000 / bpm;
      const raw = buildOrgasmPatternContent({ enabled: true, type: 'square', bpm, min: 10, max: 90 });
      const loopMs = JSON.parse(raw).actions.at(-1).at;
      const tiled = handyPlays(raw).filter((a) => a.at <= 3 * loopMs);
      for (let i = 1; i < tiled.length; i++) {
        const dt = tiled[i].at - tiled[i - 1].at;
        const where = `${bpm} BPM @${tiled[i - 1].at}`;
        expect([10, 90]).toContain(tiled[i].pos);
        if (tiled[i].pos === tiled[i - 1].pos) expect(Math.abs(dt - beatMs / 2), where).toBeLessThanOrEqual(3);
        else expect(dt, where).toBe(1);                                    // a flip is instant
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('app.js plays it, and switching back restores the file untouched', () => {
  it('enabled: the switch loops the pattern, no file is read and nothing is "recovered"', async () => {
    const app = makeApp();
    store['player.orgasmConfig'] = fileEntry();
    store['player.orgasmScript'] = FILE;
    store['player.orgasmPattern'] = { enabled: true, type: 'square', bpm: 100, min: 10, max: 70 };
    await app._reloadOrgasmScripts();

    expect(app.orgasmSwitch.configured).toBe(true);
    const expected = parseFinisherActions(buildOrgasmPatternContent(store['player.orgasmPattern']));
    expect(app.orgasmSwitch._actions).toEqual(expected);
    expect(app._orgasmPlan.loopMs).toBe(orgasmPatternLoopMs(100));
    expect(window.funsync.readFunscript).not.toHaveBeenCalled();
    expect(app._recoverOrgasmPaths).not.toHaveBeenCalled();
    expect(app.settings.set).not.toHaveBeenCalledWith('player.orgasmConfig', expect.anything());
    expect(app.settings.set).not.toHaveBeenCalledWith('player.orgasmScript', expect.anything());
  });

  it('works with NO script file configured at all (the switch was unconfigured before)', async () => {
    const app = makeApp();
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.configured).toBe(false);
    store['player.orgasmPattern'] = { enabled: true, type: 'sine', bpm: 120, min: 0, max: 100 };
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.configured).toBe(true);
    expect(app.orgasmSwitch.activate()).toBe('activated');
    app.orgasmSwitch.deactivate();
  });

  it('the Handy finisher uploads the pattern as funscript JSON (tiled) and loops it', async () => {
    const handy = recordingHandy();
    const app = makeApp({ handy });
    store['player.orgasmPattern'] = { enabled: true, type: 'triangle', bpm: 180, min: 15, max: 85 };
    await app._reloadOrgasmScripts();

    expect(app.orgasmSwitch.activate()).toBe('activated');   // X pressed
    await app._orgasmEngagePromise;
    app.orgasmSwitch.deactivate();

    const upload = handy.calls.find((c) => c.kind === 'upload');
    expect(upload).toBeTruthy();
    const pattern = buildOrgasmPatternContent(store['player.orgasmPattern']);
    expect(upload.content).toBe(tileFinisherContent(pattern));
    const uploaded = JSON.parse(upload.content).actions;
    const once = JSON.parse(pattern).actions;
    expect(uploaded.length).toBeGreaterThan(once.length);    // tiled into a long loop
    expect(uploaded.slice(0, once.length)).toEqual(once);
    expect(handy.calls.map((c) => c.kind).slice(0, 3)).toEqual(['upload', 'setup', 'play']);
  });

  it('switching back to "Script file" plays the file again, its configuration exactly as it was', async () => {
    const app = makeApp();
    store['player.orgasmConfig'] = fileEntry();
    store['player.orgasmScript'] = FILE;
    const before = JSON.stringify({ c: store['player.orgasmConfig'], s: store['player.orgasmScript'] });

    store['player.orgasmPattern'] = { enabled: true, type: 'sine', bpm: 120, min: 0, max: 100 };
    await app._reloadOrgasmScripts();
    store['player.orgasmPattern'] = { ...store['player.orgasmPattern'], enabled: false };
    await app._reloadOrgasmScripts();

    expect(JSON.stringify({ c: store['player.orgasmConfig'], s: store['player.orgasmScript'] })).toBe(before);
    expect(app.orgasmSwitch._actions).toEqual(parseFinisherActions(FILE_CONTENT));
    expect(app._orgasmSummaryText()).toEqual([{ label: null, name: 'finish.funscript', missing: false }]);
  });

  // Since the pattern settings unification (2026-11-19) the stored pattern is
  // the same simple shape and reads as any pattern does ("Pattern: Sine"):
  // units a second only, no BPM line.
  it('the Settings summary names the shape it plays: "Pattern: Sine"', async () => {
    const app = makeApp();
    store['player.orgasmPattern'] = { enabled: true, type: 'sine', bpm: 120, min: 0, max: 100 };
    expect(app._orgasmSummaryText()).toEqual([t('settingsPanel.playback.orgasmSummaryLibrary', { name: t('patterns.shape-sine.name') })]);
    store['player.orgasmPattern'].type = 'escalating';
    expect(app._orgasmSummaryText()).toEqual([t('settingsPanel.playback.orgasmSummaryLibrary', { name: t('patterns.shape-escalating.name') })]);
  });

  it('the phone\'s orgasm button follows it: configured with the pattern, unconfigured without', async () => {
    const sent = [];
    const app = makeApp({ remote: { connected: true, sendToPhone: (m) => sent.push(m) } });
    await app._reloadOrgasmScripts();
    expect(sent.at(-1)).toMatchObject({ type: 'orgasm-state', configured: false });
    store['player.orgasmPattern'] = { enabled: true, type: 'sine', bpm: 120, min: 0, max: 100 };
    await app._reloadOrgasmScripts();
    expect(sent.at(-1)).toMatchObject({ type: 'orgasm-state', configured: true, active: false });
  });
});

// ---------------------------------------------------------------------------
describe('Settings > Orgasm Switch > Source', () => {
  const appOptions = liftCtorOptions('SettingsPanel', { showToast: vi.fn(), t });

  async function openPlayback(app) {
    const panel = new SettingsPanel(appOptions.call(app));
    showing = panel.show();
    document.querySelector('.settings-panel__rail-item[data-area="playback"]').click();
    await flush();
    return panel;
  }
  const $ = (sel) => document.querySelector(sel);
  const summary = () => [...$('#sp-orgasm-script-name').querySelectorAll('.settings-panel__value-line')].map((l) => l.textContent);
  const choose = async (sel, value) => {
    $(sel).value = value;
    $(sel).dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  };

  it('opens on "Script file" with the file row showing and the pattern rows hidden (today)', async () => {
    const app = makeApp();
    store['player.orgasmConfig'] = fileEntry();
    await app._reloadOrgasmScripts();
    await openPlayback(app);
    expect($('#sp-orgasm-source').value).toBe('file');
    expect($('#sp-orgasm-file-row').hidden).toBe(false);
    expect($('#sp-orgasm-pattern-rows').hidden).toBe(true);
    expect(summary()).toEqual(['finish.funscript']);
  });

  // "Generated pattern" (its Shape / BPM / Lowest / Highest rows) is gone
  // from Settings since the pattern settings unification (2026-11-19): its
  // shapes are the library's Simple shapes in the ONE Pattern block, Units/s
  // only. What these rows promised (saving, Lowest never passing Highest,
  // the file kept for switching back) is pinned for the block in
  // pattern-block.test.js and pattern-block-settings.test.js; the engine
  // tests above still play the stored v0.9.2 `orgasmPattern` as before.

});
