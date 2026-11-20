/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// app.js plays the shared pattern choice (pattern settings unification,
// 2026-11-19): the REAL methods, lifted. X reads player.orgasmSource and
// player.orgasmPatternChoice (else the old keys), Z player.edgePatternChoice
// (else edgePattern), the Gap Filler player.gapFiller.pattern (else presetId
// / custom); "Follow the script" measures the script around now at the
// press, and a band that has not moved keeps its loop (and the Handy's
// cached upload).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import {
  patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround,
} from '../../renderer/js/pattern-choice.js';
import { edgeHoldAction, clearPatternSourceCache, patternSourceLoop } from '../../renderer/js/pattern-source.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import { parseFinisherActions, collectOrgasmScriptPaths } from '../../renderer/js/orgasm-plan.js';
import { normalizeAssociation } from '../../renderer/js/association-shape.js';
import { shapeBpm } from '../../renderer/js/pattern-library-shapes.js';

afterEach(() => { clearPatternSourceCache(); delete globalThis.window; });

const Lifted = liftAppClass(
  ['_reloadOrgasmScripts', '_orgasmLibrarySource', '_orgasmLibrarySettings', '_patternScriptRange',
    '_orgasmFollowScriptNow', '_edgePatternStart', '_fillerOptionsForUpload'],
  {
    patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround, edgeHoldAction,
    parseFinisherActions, collectOrgasmScriptPaths, normalizeAssociation, resolveFillerOptions,
    engageHandyFinisher: vi.fn(), OrgasmSwitch: class {},
  },
);

/** A script that sits high (70-90) for its first minute and uses the whole range after. */
const SCRIPT = [];
for (let t = 0; t < 60000; t += 500) SCRIPT.push({ at: t, pos: (t / 500) % 2 ? 90 : 70 });
for (let t = 60000; t < 180000; t += 500) SCRIPT.push({ at: t, pos: (t / 500) % 2 ? 100 : 0 });

function makeApp(store) {
  const app = new Lifted();
  app.settings = { get: (k) => store[k] };
  app.funscriptEngine = { getAuthoredActions: () => SCRIPT, getActions: () => SCRIPT };
  app.videoPlayer = { video: { currentTime: 10, duration: 180 } };
  app._refreshOrgasmPlan = vi.fn();
  app._getOrgasmEntry = vi.fn(() => null);
  app._recoverOrgasmPaths = vi.fn(async () => false);
  globalThis.window = { funsync: { readFunscript: vi.fn(async () => null) } };
  return app;
}
const loopActions = (app) => app._orgasmActionsCache.get(app._orgasmPatternKey);

describe('X plays the shared choice', () => {
  it('player.orgasmSource wins over the old flags; the file plays with "file", the choice with "pattern"', async () => {
    const store = {
      'player.orgasmPattern': { enabled: true, type: 'square', bpm: 60, min: 0, max: 100 },
      'player.orgasmSource': 'file',
      'player.orgasmPatternChoice': { id: 'shape-triangle', speed: 100, rangeMode: 'exact', min: 10, max: 60 },
    };
    const app = makeApp(store);
    await app._reloadOrgasmScripts();
    expect(app._orgasmPatternKey).toBeNull();
    expect(app._getOrgasmEntry).toHaveBeenCalled();   // the file configuration
    store['player.orgasmSource'] = 'pattern';
    await app._reloadOrgasmScripts();
    expect(app._orgasmPatternKey).toMatch(/shape-triangle/);
    const a = loopActions(app);
    expect(Math.min(...a.map((q) => q.pos))).toBe(10);
    expect(Math.max(...a.map((q) => q.pos))).toBe(60);
    // nothing chosen: the file plays, as the library source with no pattern did
    store['player.orgasmPatternChoice'] = { id: null };
    await app._reloadOrgasmScripts();
    expect(app._orgasmPatternKey).toBeNull();
  });

  it('with no new keys an 11-17 Generated pattern plays as the same shape', async () => {
    const app = makeApp({ 'player.orgasmPattern': { enabled: true, type: 'sawtooth', bpm: 90, min: 20, max: 80 } });
    await app._reloadOrgasmScripts();
    expect(app._orgasmPatternKey).toMatch(/shape-sawtooth/);
    expect(app._orgasmOnce).toBe(false);
  });

  it('"Follow the script": the band is the script around now; pressed where it moved, the finisher is rebuilt; where not, kept', async () => {
    const store = {
      'player.orgasmSource': 'pattern',
      'player.orgasmPatternChoice': { id: 'shape-sine', speed: 60, rangeMode: 'script', depthPct: 100 },
    };
    const app = makeApp(store);
    await app._reloadOrgasmScripts();
    const high = loopActions(app);
    expect(Math.min(...high.map((q) => q.pos))).toBeGreaterThanOrEqual(70);   // 70-90 around 0:10
    const key1 = app._orgasmPatternKey;
    const reload = vi.spyOn(app, '_reloadOrgasmScripts');
    app._orgasmFollowScriptNow();                       // same place: nothing rebuilt
    expect(reload).not.toHaveBeenCalled();
    app.videoPlayer.video.currentTime = 150;            // the whole range around 2:30
    app._orgasmFollowScriptNow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(app._orgasmPatternKey).not.toBe(key1);
    const wide = loopActions(app);
    expect(Math.min(...wide.map((q) => q.pos))).toBe(0);
    expect(Math.max(...wide.map((q) => q.pos))).toBe(100);
    // the same strokes a minute in both bands (the speed is the speed on a whole-range script)
    const turns = (a) => a.filter((q, i) => i > 0 && i < a.length - 1 && q.pos > a[i - 1].pos && q.pos >= a[i + 1].pos).length / a[a.length - 1].at;
    expect(Math.abs(turns(high) / turns(wide) - 1)).toBeLessThan(0.05);
    expect(shapeBpm(60, 100)).toBe(18);
  });
});

describe('Z plays the shared choice', () => {
  function edgeApp(store) {
    const app = makeApp({ 'player.edgeHoldAction': 'pattern', ...store });
    app._edgeLoop = { loadScript: vi.fn(() => true), activate: vi.fn() };
    app._pushRemoteEdgeState = vi.fn();
    return app;
  }

  it('player.edgePatternChoice wins over edgePattern; a simple shape plays', () => {
    const app = edgeApp({ 'player.edgePattern': { id: 'quick-full-strokes' }, 'player.edgePatternChoice': { id: 'shape-square', speed: 80, rangeMode: 'exact', min: 30, max: 70 } });
    expect(app._edgePatternStart()).toBe(true);
    const content = app._edgeLoop.loadScript.mock.calls[0][0];
    const a = parseFinisherActions(content);
    expect(new Set(a.map((q) => q.pos))).toEqual(new Set([30, 70]));
    expect(app._edgeLoop.loadScript.mock.calls[0][1]).toEqual({ once: false });
  });

  it('none chosen in the new key: Z stops, whatever edgePattern holds; absent: edgePattern as stored', () => {
    const none = edgeApp({ 'player.edgePattern': { id: 'quick-full-strokes' }, 'player.edgePatternChoice': { id: null } });
    expect(none._edgePatternStart()).toBe(false);
    const old = edgeApp({ 'player.edgePattern': { id: 'quick-full-strokes', speed: 200, min: null, max: null } });
    expect(old._edgePatternStart()).toBe(true);
    expect(old._edgeLoop.loadScript.mock.calls[0][0]).toBe(choiceSource({ id: 'quick-full-strokes', speed: 200 }).content);
  });

  it('"Follow the script" measures around now at the press', () => {
    const app = edgeApp({ 'player.edgePatternChoice': { id: 'shape-sine', speed: 60, rangeMode: 'script', depthPct: 50 } });
    app.videoPlayer.video.currentTime = 20;
    app._edgePatternStart();
    const a = parseFinisherActions(app._edgeLoop.loadScript.mock.calls[0][0]);
    expect(Math.min(...a.map((q) => q.pos))).toBeGreaterThanOrEqual(75);   // 50 % of 70-90 = 75-85
    expect(Math.max(...a.map((q) => q.pos))).toBeLessThanOrEqual(85);
    expect(patternSourceLoop).toBeTypeOf('function');
  });
});

describe('the Gap Filler reads the shared choice for every device path', () => {
  it('player.gapFiller.pattern wins; without it presetId / custom as before', () => {
    const app = makeApp({
      'player.gapFiller': { enabled: true, presetId: 'gentle', thresholdMs: 10000, pattern: { id: 'slow-tip-strokes', rangeMode: 'script', depthPct: 40 } },
      'player.gapSkip': { mode: 'off' },
    });
    const o = app._fillerOptionsForUpload(200000);
    expect(o.library).toMatchObject({ id: 'slow-tip-strokes', depthPct: 40 });
    expect(o).toMatchObject({ enabled: true, thresholdMs: 10000, totalDurationMs: 200000 });
    const old = makeApp({ 'player.gapFiller': { enabled: true, presetId: 'gentle', thresholdMs: 10000 }, 'player.gapSkip': { mode: 'off' } });
    expect(old._fillerOptionsForUpload(200000)).toEqual(resolveFillerOptions({ enabled: true, presetId: 'gentle', thresholdMs: 10000, totalDurationMs: 200000 }));
    // a getter that keeps the dot path flat still finds the new key
    const flat = makeApp({ 'player.gapFiller': { enabled: true, presetId: 'gentle' }, 'player.gapFiller.pattern': { id: 'shape-random', speed: 30 }, 'player.gapSkip': {} });
    expect(flat._fillerOptionsForUpload(1000)).toMatchObject({ pattern: 'random' });
  });
});
