// Orgasm Switch source "Pattern from the library" (next major, design
// DESIGN-pattern-library.md §d).
//
// Settings > Playback > Orgasm Switch > Source gets a third value, "Pattern
// from the library", with its rows (group + pattern picker, Speed with its
// value, Reverse, Range). Since Dave's answers (2026-11-17) the picker
// starts on "Choose a pattern…" (no default: the file plays until one is
// chosen) and offers the endings too, marked "plays once, then holds"
// (their one-shot play is tested in pattern-endings-oneshot.test.js). What is asserted is
// what the user gets: the select and the rows, what is saved, the loop the
// REAL OrgasmSwitch plays (from the REAL options app.js hands it, through
// the REAL plan resolver) on fake Buttplug / T-Code devices, what the Handy
// finisher UPLOADS (a recording stub, nothing leaves the test), the summary
// line, the phone's orgasm-state, every trigger (X, the global hotkey, the
// phone) and the file configuration after switching back. The app.js
// methods are the REAL ones lifted out of app.js.
//
// jsdom (no docblock): the REAL SettingsPanel builds DOM and i18n.js branches
// on `typeof window` (notes/CLAUDE.md "Test environments").
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
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
import { orgasmPatternSettings, orgasmPatternKey, buildOrgasmPatternContent, isOrgasmPatternKey } from '../../renderer/js/orgasm-pattern.js';
import {
  ORGASM_LIBRARY_DEFAULTS, orgasmLibrarySettings, patternSourceKey, buildPatternSourceContent, patternSpeedBounds,
  clearPatternSourceCache, isOneShotPattern,
} from '../../renderer/js/pattern-source.js';
import { listPatterns, listFamilies, describePattern } from '../../renderer/js/pattern-library.js';
import { patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround } from '../../renderer/js/pattern-choice.js';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { HandyManager } from '../../renderer/js/handy-manager.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const FILE = 'C:\\Finishers\\finish.funscript';
const FILE_CONTENT = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 400, pos: 90 }, { at: 800, pos: 10 }] });
const ENDINGS = listPatterns({ loopable: false }).map((p) => p.id);

const LiftedApp = liftAppClass(
  ['_reloadOrgasmScripts', '_orgasmLibrarySource', '_orgasmLibrarySettings', '_recoverOrgasmPaths',
    '_saveOrgasmConfigQuiet', '_refreshOrgasmPlan', '_getOrgasmEntry', '_orgasmSummaryText',
    '_pushRemoteOrgasmState', '_clearOrgasmScript', '_onOrgasmHold', '_finishOrgasm',
    '_maybeToastOrgasmDemotion', '_onGlobalShortcut',
    // the shared pattern choice (pattern settings unification, 2026-11-19)
    '_patternScriptRange', '_orgasmFollowScriptNow'],
  {
    patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround,
    orgasmPatternSettings, orgasmPatternKey, buildOrgasmPatternContent,
    orgasmLibrarySettings, patternSourceKey, buildPatternSourceContent, isOneShotPattern,
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

// Fakes with the REAL managers' method names (checked against the
// prototypes below), recording what the finisher sends. No device, no cloud.
function fakeButtplug() {
  const sent = [];
  return {
    sent,
    connected: true,
    devices: [{ index: 0, name: 'Stroker', canLinear: true }, { index: 1, name: 'Vibe', canVibrate: true }],
    sendLinear: vi.fn((i, pos, ms) => { sent.push({ kind: 'linear', i, pos, ms }); }),
    sendVibrate: vi.fn((i, v) => { sent.push({ kind: 'vibrate', i, v }); }),
    sendRotate: vi.fn(),
    stopAll: vi.fn(async () => {}),
    stopSustainedOutputs: vi.fn(async () => {}),
  };
}
function fakeTcode() {
  const sent = [];
  return { sent, connected: true, sendAxes: vi.fn((axes) => { sent.push(axes); }), stop: vi.fn() };
}
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

function makeApp({ handy = null, remote = null, buttplug = null, tcode = null } = {}) {
  const app = new LiftedApp();
  app.settings = makeSettings();
  app.handyManager = handy;
  app.buttplugManager = buttplug;
  app.tcodeManager = tcode;
  app.remoteBridge = remote;
  app.library = { getAllFunscriptPaths: () => [FILE], _safeToPrune: async () => true };
  app._recoverOrgasmPaths = vi.fn(app._recoverOrgasmPaths.bind(app));
  // The REAL OrgasmSwitch, from the REAL options app.js passes it; its loop
  // runs on a clock and timer the test drives.
  const options = liftCtorOptions('OrgasmSwitch', { engageHandyFinisher, releaseHandyFinisher }).call(app);
  app.clock = 0;
  app.orgasmSwitch = new OrgasmSwitch({ ...options, now: () => app.clock });
  app.orgasmSwitch.setTimerImpl(() => 1, () => {});
  app._cutoffFromSettings = () => null;
  app._handyInverted = () => false;
  app._restoreHandyAfterOrgasm = vi.fn();
  app._stopAllDevicesIdle = () => {};
  app._playerWindowPlayback = () => false;
  // The Settings panel's Playback area needs these to render.
  app.funscriptEngine = { isLoaded: false, getActions: () => [], hasFiller: false };
  app.videoPlayer = { duration: 0, video: { duration: 0 } };
  app.buttplugSync = { reloadActions() {}, _active: false, start: vi.fn(), stop: vi.fn() };
  app.tcodeSync = { reloadActions() {}, _active: false, start: vi.fn(), stop: vi.fn() };
  app.progressBar = { renderHeatmap() {} };
  return app;
}

const fileEntry = () => buildAssociationEntry('single', FILE, null, null);
const flush = () => new Promise((r) => setTimeout(r, 0));
const loopOf = (p) => parseFinisherActions(buildPatternSourceContent(p));

beforeEach(() => {
  store = {};
  showing = null;
  clearPatternSourceCache();
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
describe('the fakes mirror the real device classes', () => {
  it('every method the fakes stand in for exists on the real prototypes', () => {
    const has = (Cls, name) => {
      const d = Object.getOwnPropertyDescriptor(Cls.prototype, name);
      return !!d && (typeof d.value === 'function' || typeof d.get === 'function');
    };
    for (const n of ['connected', 'devices', 'sendLinear', 'sendVibrate', 'sendRotate', 'stopAll', 'stopSustainedOutputs']) {
      expect(has(ButtplugManager, n), `ButtplugManager.${n}`).toBe(true);
    }
    for (const n of ['connected', 'sendAxes', 'stop']) expect(has(TCodeManager, n), `TCodeManager.${n}`).toBe(true);
    for (const n of ['connected', 'uploadScriptOnly', 'setupScript', 'hsspPlay', 'hsspStop']) {
      expect(has(HandyManager, n), `HandyManager.${n}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('app.js plays a library pattern as the finisher', () => {
  it('off by default: the file plays, as today', async () => {
    const app = makeApp();
    store['player.orgasmConfig'] = fileEntry();
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch._actions).toEqual(parseFinisherActions(FILE_CONTENT));
    store['player.orgasmLibraryPattern'] = { ...ORGASM_LIBRARY_DEFAULTS };   // the stored default
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch._actions).toEqual(parseFinisherActions(FILE_CONTENT));
  });

  it('on: both caches hold the loop under its synthetic key, the REAL plan plays it, no file is read or recovered', async () => {
    const app = makeApp({ buttplug: fakeButtplug(), tcode: fakeTcode() });
    store['player.orgasmConfig'] = fileEntry();
    store['player.orgasmScript'] = FILE;
    const p = { enabled: true, id: 'quick-full-strokes', speed: 240, reversed: true, min: 10, max: 80 };
    store['player.orgasmLibraryPattern'] = p;
    await app._reloadOrgasmScripts();

    const key = patternSourceKey(p);
    expect(isOrgasmPatternKey(key)).toBe(true);
    expect([...app._orgasmContentCache.keys()]).toEqual([key]);
    expect(app._orgasmContentCache.get(key)).toBe(buildPatternSourceContent(p));
    expect(app._orgasmActionsCache.get(key)).toEqual(loopOf(p));
    expect(app._orgasmPlan).toMatchObject({ mode: 'single', loopMs: loopOf(p).at(-1).at });
    expect(app.orgasmSwitch._actions).toEqual(loopOf(p));
    expect(window.funsync.readFunscript).not.toHaveBeenCalled();
    expect(app._recoverOrgasmPaths).not.toHaveBeenCalled();
    expect(app.settings.set).not.toHaveBeenCalledWith('player.orgasmConfig', expect.anything());
    expect(app.settings.set).not.toHaveBeenCalledWith('player.orgasmScript', expect.anything());
  });

  it('X drives the fake Buttplug and T-Code devices along the loop, wrapping on loopMs', async () => {
    const bp = fakeButtplug();
    const tc = fakeTcode();
    const app = makeApp({ buttplug: bp, tcode: tc });
    const p = { enabled: true, id: 'slow-tip-strokes', speed: null, reversed: false, min: null, max: null };
    store['player.orgasmLibraryPattern'] = p;
    await app._reloadOrgasmScripts();
    const loop = loopOf(p);
    const loopMs = loop.at(-1).at;

    app._onOrgasmHold(true);                   // X down (hold mode)
    expect(app.orgasmSwitch.active).toBe(true);
    const at = (ms) => { app.clock = ms; app.orgasmSwitch._tick(); };
    for (const ms of [0, 150, 400, loopMs / 2, loopMs - 1, loopMs + 150]) at(ms);
    app._onOrgasmHold(false);                  // X up
    expect(app.orgasmSwitch.active).toBe(false);

    const linear = bp.sent.filter((s) => s.kind === 'linear').map((s) => s.pos);
    const l0 = tc.sent.map((a) => a.L0).filter((v) => v !== undefined);
    expect(linear[0]).toBeCloseTo(loop[0].pos, 6);
    expect(l0[0]).toBeCloseTo(loop[0].pos, 6);
    // After the wrap it is where it was 150 ms into the loop.
    expect(linear.at(-1)).toBeCloseTo(linear[1], 6);
    expect(bp.sent.some((s) => s.kind === 'vibrate')).toBe(true);   // the vibe rides it too
    // Every position stays inside the pattern's own place.
    const [lo, hi] = describePattern('slow-tip-strokes').range;
    for (const v of [...linear, ...l0]) { expect(v).toBeGreaterThanOrEqual(lo - 1); expect(v).toBeLessThanOrEqual(hi + 1); }
  });

  it('the Handy finisher uploads the loop as funscript JSON, tiled within the cap, and loops it', async () => {
    const handy = recordingHandy();
    const app = makeApp({ handy });
    const p = { enabled: true, id: 'buzz-long-strokes', speed: null, reversed: false, min: null, max: null };
    store['player.orgasmLibraryPattern'] = p;
    await app._reloadOrgasmScripts();

    expect(app.orgasmSwitch.activate()).toBe('activated');   // X pressed
    await app._orgasmEngagePromise;
    app.orgasmSwitch.deactivate();

    const upload = handy.calls.find((c) => c.kind === 'upload');
    expect(upload.content).toBe(tileFinisherContent(buildPatternSourceContent(p)));
    const uploaded = JSON.parse(upload.content).actions;
    expect(uploaded.length).toBeLessThanOrEqual(8000);
    expect(uploaded.length).toBeGreaterThan(loopOf(p).length);
    expect(handy.calls.map((c) => c.kind).slice(0, 3)).toEqual(['upload', 'setup', 'play']);
    // The upload is cached under the loop's key: a second X uploads nothing.
    expect(app._orgasmCloudUrlCutoffKey).toContain(patternSourceKey(p));
    await flush();                      // the release's stop has landed
    handy.calls.length = 0;
    expect(app.orgasmSwitch.activate()).toBe('activated');
    await app._orgasmEngagePromise;
    app.orgasmSwitch.deactivate();
    expect(handy.calls.map((c) => c.kind).slice(0, 2)).toEqual(['setup', 'play']);
  });

  it('every trigger plays it: X, the global hotkey (press to toggle) and the phone\'s button', async () => {
    const app = makeApp({ buttplug: fakeButtplug() });
    store['player.orgasmLibraryPattern'] = { enabled: true, id: 'quick-full-strokes' };
    await app._reloadOrgasmScripts();

    app._onOrgasmHold(true);                       // keyboard X / the phone's hold (same handler)
    expect(app.orgasmSwitch.active).toBe(true);
    expect(app.orgasmSwitch._actions).toEqual(loopOf({ id: 'quick-full-strokes' }));
    app._onOrgasmHold(false);
    expect(app.orgasmSwitch.active).toBe(false);

    app._onGlobalShortcut('orgasm');               // global hotkey: toggle on
    expect(app.orgasmSwitch.active).toBe(true);
    app._onGlobalShortcut('orgasm');               // and off (finish)
    expect(app.orgasmSwitch.active).toBe(false);
  });

  it('no pattern chosen (the default since 2026-11-17) or an unknown id: the library source does nothing, the file plays as today', async () => {
    const app = makeApp();
    store['player.orgasmConfig'] = fileEntry();
    for (const id of [null, undefined, 'no-such-pattern']) {
      store['player.orgasmLibraryPattern'] = { enabled: true, id };
      await app._reloadOrgasmScripts();
      expect(app.orgasmSwitch.configured).toBe(true);
      expect(app.orgasmSwitch._actions).toEqual(parseFinisherActions(FILE_CONTENT));
      expect(app.orgasmSwitch.once).toBe(false);
      expect(app._orgasmSummaryText()).toEqual([{ label: null, name: 'finish.funscript', missing: false }]);
    }
    // No file either: no finisher, as today with no file set.
    delete store['player.orgasmConfig'];
    store['player.orgasmLibraryPattern'] = { ...ORGASM_LIBRARY_DEFAULTS, enabled: true };
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.configured).toBe(false);
  });

  // Fix-up 2026-11-17 (review-1): a library pattern that could not be built
  // fell through to the file configuration and played its older script.
  it('the narrowest range plays a widened loop, and a loop that cannot be built leaves X unconfigured: never the file\'s older script', async () => {
    const app = makeApp();
    store['player.orgasmConfig'] = fileEntry();
    // Mixed flutters at the tip in a 5-unit band used to give a 1-action loop.
    const narrow = { enabled: true, id: 'mixed-flutters-tip', speed: 172, reversed: false, min: 20, max: 25 };
    store['player.orgasmLibraryPattern'] = narrow;
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.configured).toBe(true);
    expect(app.orgasmSwitch._actions).toEqual(loopOf(narrow));
    expect(app.orgasmSwitch._actions.length).toBeGreaterThan(2);
    expect(window.funsync.readFunscript).not.toHaveBeenCalled();
    // The engine gives nothing at all (a fault): no finisher, and no file read.
    app._orgasmLibrarySource = () => null;
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.configured).toBe(false);
    expect(app._orgasmPlan).toBeFalsy();
    expect(window.funsync.readFunscript).not.toHaveBeenCalled();
    expect(app._recoverOrgasmPaths).not.toHaveBeenCalled();
    expect(store['player.orgasmConfig']).toEqual(fileEntry());   // the file configuration is kept for switching back
  });

  it('a hand-edited file with both sources on plays the generated shape (as an older build would)', async () => {
    const app = makeApp();
    store['player.orgasmPattern'] = { enabled: true, type: 'sine', bpm: 120, min: 0, max: 100 };
    store['player.orgasmLibraryPattern'] = { enabled: true, id: 'quick-full-strokes' };
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch._actions).toEqual(parseFinisherActions(buildOrgasmPatternContent(store['player.orgasmPattern'])));
    // the same simple shape since 2026-11-19 (pattern-choice-upgrade.test.js: the same strokes)
    expect(app._orgasmSummaryText()).toEqual([t('settingsPanel.playback.orgasmSummaryLibrary', { name: t('patterns.shape-sine.name') })]);
  });

  it('switching back to "Script file" plays the file again, its configuration exactly as it was', async () => {
    const app = makeApp();
    store['player.orgasmConfig'] = fileEntry();
    store['player.orgasmScript'] = FILE;
    const before = JSON.stringify({ c: store['player.orgasmConfig'], s: store['player.orgasmScript'] });
    store['player.orgasmLibraryPattern'] = { enabled: true, id: 'quick-full-strokes' };
    await app._reloadOrgasmScripts();
    store['player.orgasmLibraryPattern'] = { ...store['player.orgasmLibraryPattern'], enabled: false };
    await app._reloadOrgasmScripts();
    expect(JSON.stringify({ c: store['player.orgasmConfig'], s: store['player.orgasmScript'] })).toBe(before);
    expect(app.orgasmSwitch._actions).toEqual(parseFinisherActions(FILE_CONTENT));
    expect(app._orgasmSummaryText()).toEqual([{ label: null, name: 'finish.funscript', missing: false }]);
  });

  it('the summary reads "Pattern: <name>"', () => {
    const app = makeApp();
    store['player.orgasmLibraryPattern'] = { enabled: true, id: 'quick-full-strokes' };
    expect(app._orgasmSummaryText()).toEqual(['Pattern: Quick full strokes']);
    store['player.orgasmLibraryPattern'].id = 'slow-tip-strokes';
    expect(app._orgasmSummaryText()).toEqual([`Pattern: ${EN.patterns['slow-tip-strokes'].name}`]);
  });

  it('the phone\'s orgasm button follows it: configured with the pattern, unconfigured without', async () => {
    const sent = [];
    const app = makeApp({ remote: { connected: true, sendToPhone: (m) => sent.push(m) } });
    await app._reloadOrgasmScripts();
    expect(sent.at(-1)).toMatchObject({ type: 'orgasm-state', configured: false });
    store['player.orgasmLibraryPattern'] = { enabled: true, id: 'quick-full-strokes' };
    await app._reloadOrgasmScripts();
    expect(sent.at(-1)).toMatchObject({ type: 'orgasm-state', configured: true, active: false });
  });
});

// ---------------------------------------------------------------------------
// Settings > Orgasm Switch > Source: since the pattern settings unification
// (2026-11-19) it is "Script file" / "Pattern", the pattern in the ONE block
// shared with Gap Filler and Edge Hold, saved through pattern-choice.js
// (`player.orgasmSource` and patternChoiceWrites, never the v0.9.2
// `orgasmLibraryPattern` / `orgasmPattern`). The picker (every pattern, the
// endings marked), each row, persistence and "back to Script file" are pinned
// in pattern-block.test.js and pattern-block-settings.test.js; the engine
// tests above still play a stored v0.9.2 library pattern as before.
