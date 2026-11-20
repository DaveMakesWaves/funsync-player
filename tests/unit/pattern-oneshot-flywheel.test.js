/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Dave's answers on the pattern library (2026-11-17, evening), Orgasm Switch
// side (the Edge Hold side is in edge-hold-pattern.test.js):
//
//  1. Endings are offered, not hidden. An ending is a one-shot shape: the
//     switch plays it ONCE from the start of the hold and then HOLDS its
//     last position while the key is held (no wrap back to its start); the
//     Handy gets it uploaded as it is (not tiled), so the HSSP plays it once
//     and stops at its end.
//  7. Oscillating (flywheel) machines follow the Orgasm and Edge loops, the
//     way the Buttplug engine drives them from a video's script: the
//     device's oscillate mode ('speed' = the stroke's velocity), its range,
//     cutoff and invert, the Max cap and the ramp-up (counted from the
//     hold's start). They used to sit the loop out.
//
// What is asserted is what the devices are sent: the REAL OrgasmSwitch, the
// REAL ButtplugSync's oscillate path and the REAL app.js methods (lifted),
// on fake managers whose method names are checked against the real ones.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
import { patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround } from '../../renderer/js/pattern-choice.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { HandyManager } from '../../renderer/js/handy-manager.js';
import { interpolatePosition } from '../../renderer/js/handy-hdsp-sync.js';
import {
  resolveOrgasmPlan, parseFinisherActions, collectOrgasmScriptPaths, describeOrgasmEntry,
} from '../../renderer/js/orgasm-plan.js';
import { engageHandyFinisher, releaseHandyFinisher, tileFinisherContent, holdFinisherEnd } from '../../renderer/js/orgasm-handy-engage.js';
import { normalizeAssociation, buildAssociationEntry } from '../../renderer/js/association-shape.js';
import { findMovedFile } from '../../renderer/js/association-rehome.js';
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';
import { orgasmPatternSettings, orgasmPatternKey, buildOrgasmPatternContent } from '../../renderer/js/orgasm-pattern.js';
import {
  orgasmLibrarySettings, patternSourceKey, buildPatternSourceContent, patternSourceLoop, isOneShotPattern,
  clearPatternSourceCache,
} from '../../renderer/js/pattern-source.js';
import { listPatterns, renderPattern, DEFAULT_MAX_SPEED } from '../../renderer/js/pattern-library.js';

const ENDINGS = listPatterns({ loopable: false }).map((p) => p.id);
const LOOP = 'quick-full-strokes';

let clock = 0;
beforeEach(() => {
  clock = 0;
  clearPatternSourceCache();
  // ButtplugSync's ramp-up reads performance.now(); the switch's clock is
  // the same one in the app. Both follow the test's clock here.
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => { vi.restoreAllMocks(); });

// Fakes with the REAL managers' method names (checked below).
function fakeButtplug(devices) {
  const sent = [];
  return {
    sent,
    connected: true,
    devices,
    sendLinear: vi.fn((i, pos, ms) => { sent.push({ kind: 'linear', i, pos, ms }); }),
    sendVibrate: vi.fn((i, v) => { sent.push({ kind: 'vibrate', i, v }); }),
    sendRotate: vi.fn((i, v, cw) => { sent.push({ kind: 'rotate', i, v, cw }); }),
    sendOscillate: vi.fn((i, v) => { sent.push({ kind: 'oscillate', i, v }); }),
    sendScalar: vi.fn((i, v) => { sent.push({ kind: 'scalar', i, v }); }),
    stopAll: vi.fn(async () => { sent.push({ kind: 'stopAll' }); }),
    stopSustainedOutputs: vi.fn(async () => { sent.push({ kind: 'stopSustained' }); }),
  };
}
function fakeTcode() {
  const sent = [];
  return { sent, connected: true, sendAxes: vi.fn((axes) => { sent.push({ ...axes }); }), stop: vi.fn() };
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
const STROKER = { index: 0, name: 'Stroker', canLinear: true };
const VIBE = { index: 1, name: 'Vibe', canVibrate: true };
const MACHINE = { index: 2, name: 'Flywheel machine', canOscillate: true };
const POSITION_MACHINE = { index: 3, name: 'Position machine', canLinear: true, canOscillate: true };

const kinds = (sent, kind, i) => sent.filter((s) => s.kind === kind && (i === undefined || s.i === i));

describe('the fakes mirror the real device classes', () => {
  it('every method the fakes stand in for exists on the real prototypes', () => {
    const has = (Cls, name) => {
      const d = Object.getOwnPropertyDescriptor(Cls.prototype, name);
      return !!d && (typeof d.value === 'function' || typeof d.get === 'function');
    };
    for (const n of ['connected', 'devices', 'sendLinear', 'sendVibrate', 'sendRotate', 'sendOscillate', 'sendScalar', 'stopAll', 'stopSustainedOutputs']) {
      expect(has(ButtplugManager, n), `ButtplugManager.${n}`).toBe(true);
    }
    for (const n of ['connected', 'sendAxes', 'stop']) expect(has(TCodeManager, n), `TCodeManager.${n}`).toBe(true);
    for (const n of ['connected', 'uploadScriptOnly', 'setupScript', 'hsspPlay', 'hsspStop']) {
      expect(has(HandyManager, n), `HandyManager.${n}`).toBe(true);
    }
    expect(typeof ButtplugSync.prototype.oscillateNow).toBe('function');
  });
});

// ---------------------------------------------------------------------------
describe('pattern-source: an ending is one render at its own length, marked once', () => {
  it('every ending: the engine\'s one render (never a cut loop), loopMs at its last action; a loop stays a loop', () => {
    expect(ENDINGS).toHaveLength(6);
    for (const id of ENDINGS) {
      expect(isOneShotPattern(id)).toBe(true);
      const loop = patternSourceLoop({ id });
      expect(loop.once, id).toBe(true);
      const own = renderPattern(id, { seed: 1, maxSpeed: DEFAULT_MAX_SPEED }).actions;
      expect(loop.actions).toEqual(own);
      expect(loop.loopMs).toBe(own.at(-1).at);
      expect(parseFinisherActions(buildPatternSourceContent({ id }))).toEqual(own);
    }
    expect(isOneShotPattern(LOOP)).toBe(false);
    expect(patternSourceLoop({ id: LOOP }).once).toBe(false);
  });

  it('speed, reverse and a range shape an ending as they shape a loop', () => {
    const p = { id: 'sprint-finish', speed: 400, reversed: true, min: 20, max: 60 };
    expect(patternSourceLoop(p).actions).toEqual(renderPattern('sprint-finish', {
      speed: 400, reversed: true, range: { min: 20, max: 60 }, seed: 1, maxSpeed: DEFAULT_MAX_SPEED,
    }).actions);
    expect(patternSourceKey(p)).not.toBe(patternSourceKey({ id: 'sprint-finish' }));
  });
});

// ---------------------------------------------------------------------------
describe('OrgasmSwitch: a one-shot plan plays once, then holds', () => {
  const ending = 'last-stroke-then-still';
  const content = () => buildPatternSourceContent({ id: ending });

  function makeSwitch(devices, opts = {}) {
    const bp = fakeButtplug(devices);
    const tc = fakeTcode();
    const sw = new OrgasmSwitch({ buttplugManager: bp, tcodeManager: tc, now: () => clock, ...opts });
    sw.setTimerImpl(() => 1, () => {});
    return { sw, bp, tc };
  }

  it('Buttplug and T-Code follow it from the start of the hold, stop on its last position, and never wrap back', () => {
    const { sw, bp, tc } = makeSwitch([STROKER, VIBE]);
    expect(sw.loadScript(content(), { once: true })).toBe(true);
    expect(sw.once).toBe(true);
    const actions = parseFinisherActions(content());
    const end = actions.at(-1).at;
    clock = 1000;                     // the hold starts later than 0: its own clock
    sw.activate();
    for (let t = 0; t <= end; t += 40) {
      clock = 1000 + t;
      sw._tick();
      expect(sw.livePosition).toBeCloseTo(interpolatePosition(actions, t), 6);
    }
    clock = 1000 + end + 40;
    sw._tick();                        // past the end: settles
    const last = actions.at(-1).pos;
    expect(kinds(bp.sent, 'linear').at(-1).pos).toBeCloseTo(last, 6);
    expect(tc.sent.map((a) => a.L0).filter((v) => v !== undefined).at(-1)).toBeCloseTo(last, 6);
    // The speed-driven vibrate comes to rest with the stroke.
    expect(kinds(bp.sent, 'vibrate').at(-1).v).toBe(0);
    const sentAtEnd = bp.sent.length;
    const tcAtEnd = tc.sent.length;
    // Held for a long time after: the same position, nothing more is sent.
    for (const t of [end + 150, end + 1000, end + 5000, 3 * end]) {
      clock = 1000 + t;
      sw._tick();
      expect(sw.livePosition).toBeCloseTo(last, 6);
    }
    expect(bp.sent.length).toBe(sentAtEnd);
    expect(tc.sent.length).toBe(tcAtEnd);
    sw.deactivate();
    expect(sw.livePosition).toBeNull();
  });

  it('the same shape as a loop wraps back to its start (the contrast: once is what holds it)', () => {
    const { sw } = makeSwitch([STROKER]);
    sw.loadScript(content());
    expect(sw.once).toBe(false);
    const actions = parseFinisherActions(content());
    const end = actions.at(-1).at;
    sw.activate();
    clock = end + 150;
    sw._tick();
    expect(sw.livePosition).toBeCloseTo(interpolatePosition(actions, 150), 6);
    expect(sw.livePosition).not.toBeCloseTo(actions.at(-1).pos, 0);
    sw.deactivate();
  });

  it('a second hold plays it again from its start', () => {
    const { sw } = makeSwitch([STROKER]);
    sw.loadScript(content(), { once: true });
    const actions = parseFinisherActions(content());
    sw.activate();
    clock = actions.at(-1).at + 500;
    sw._tick();
    sw.deactivate();
    clock = 50000;
    sw.activate();
    expect(sw.livePosition).toBeCloseTo(actions[0].pos, 6);
    clock = 50000 + 300;
    sw._tick();
    expect(sw.livePosition).toBeCloseTo(interpolatePosition(actions, 300), 6);
    sw.deactivate();
  });
});

// ---------------------------------------------------------------------------
describe('flywheel machines follow the loop through the Buttplug engine\'s own oscillate path', () => {
  const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 800, pos: 0 }] });

  function rig({ driver = true, devices = [STROKER, MACHINE, POSITION_MACHINE] } = {}) {
    const bp = fakeButtplug(devices);
    const sync = new ButtplugSync({ videoPlayer: { paused: true }, buttplugManager: bp, funscriptEngine: null });
    const sw = new OrgasmSwitch({
      buttplugManager: bp,
      // As app.js passes it (the X switch and the edge loop).
      oscillate: driver ? (dev, pos, prevPos, ms, startMs) => sync.oscillateNow(dev.index, pos, prevPos, ms, startMs) : undefined,
    });
    sw.setTimerImpl(() => 1, () => {});
    sw.loadScript(SCRIPT);
    return { bp, sync, sw };
  }

  /** What ButtplugSync sends the machine for one step of the video's script. */
  function engineOscillate(pos, prevPos, sinceLastMs, rampStart, setup = () => {}) {
    const bp = fakeButtplug([MACHINE]);
    const sync = new ButtplugSync({ videoPlayer: { paused: true }, buttplugManager: bp, funscriptEngine: null });
    setup(sync);
    sync._rampUpStartTime = rampStart;
    sync._sendToDevices(pos, sinceLastMs, prevPos, { sinceLastMs, emitLinear: false });
    return kinds(bp.sent, 'oscillate', MACHINE.index).at(-1).v;
  }

  it('each tick the machine gets exactly what the engine would send for the same motion: speed mode, the 70% Max cap and the ramp from the hold\'s start', () => {
    const { bp, sw } = rig();
    clock = 5000;                     // the hold starts at 5 s on the shared clock
    sw.activate();
    let prev = sw.livePosition;
    let prevT = 5000;
    const got = [];
    const want = [];
    for (let t = 40; t <= 2400; t += 40) {
      clock = 5000 + t;
      const before = kinds(bp.sent, 'oscillate', MACHINE.index).length;
      sw._tick();
      const after = kinds(bp.sent, 'oscillate', MACHINE.index);
      if (after.length === before) continue;
      got.push(after.at(-1).v);
      want.push(engineOscillate(sw.livePosition, prev, clock - prevT, 5000));
      prev = sw.livePosition;
      prevT = clock;
    }
    expect(got.length).toBeGreaterThan(40);
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
    // The ramp: small at first, then the full (capped) speed of a 250 u/s stroke.
    expect(got[0]).toBeLessThan(5);
    expect(Math.max(...got)).toBeCloseTo(70, 6);
    sw.deactivate();
  });

  it('the device\'s own settings apply: Max, ramp off, invert, range and position mode', () => {
    const { bp, sync, sw } = rig();
    sync.setMaxIntensity(MACHINE.index, 40);
    sync.setRampUp(MACHINE.index, false);
    sw.activate();
    clock = 120;
    sw._tick();
    expect(kinds(bp.sent, 'oscillate', MACHINE.index).at(-1).v).toBeCloseTo(40, 6);   // 250 u/s capped at 40
    sync.setOscillateMode(MACHINE.index, 'position');
    sync.setDeviceRange(MACHINE.index, 0, 50);
    clock = 200;
    sw._tick();
    const pos = interpolatePosition(parseFinisherActions(SCRIPT), 200);
    expect(kinds(bp.sent, 'oscillate', MACHINE.index).at(-1).v).toBeCloseTo(Math.min(40, pos / 2), 6);
    sync.setInverted(MACHINE.index, true);
    clock = 260;
    sw._tick();
    const pos2 = interpolatePosition(parseFinisherActions(SCRIPT), 260);
    expect(kinds(bp.sent, 'oscillate', MACHINE.index).at(-1).v).toBeCloseTo(Math.min(40, (100 - pos2) / 2), 6);
    sw.deactivate();
  });

  it('hardware that is both position and oscillate takes the position, as in the engine (no speed sent)', () => {
    const { bp, sw } = rig();
    sw.activate();
    for (let t = 40; t <= 800; t += 40) { clock = t; sw._tick(); }
    expect(kinds(bp.sent, 'linear', POSITION_MACHINE.index).length).toBeGreaterThan(5);
    expect(kinds(bp.sent, 'oscillate', POSITION_MACHINE.index)).toEqual([]);
    expect(kinds(bp.sent, 'linear', STROKER.index).length).toBeGreaterThan(5);
    sw.deactivate();
  });

  it('a machine never takes a speed while the engine plays a video (playback owns it)', () => {
    const { bp, sync, sw } = rig();
    sync._active = true;
    sw.activate();
    for (let t = 40; t <= 400; t += 40) { clock = t; sw._tick(); }
    expect(kinds(bp.sent, 'oscillate')).toEqual([]);
    sync._active = false;
    sw.deactivate();
  });

  it('with no driver the machines sit the loop out, as they always did', () => {
    const { bp, sw } = rig({ driver: false });
    sw.activate();
    for (let t = 40; t <= 800; t += 40) { clock = t; sw._tick(); }
    expect(kinds(bp.sent, 'oscillate')).toEqual([]);
    expect(kinds(bp.sent, 'linear', POSITION_MACHINE.index)).toEqual([]);
    expect(kinds(bp.sent, 'linear', STROKER.index).length).toBeGreaterThan(5);
    sw.deactivate();
  });

  it('an ending: at its end the machine comes to rest (no motion, no speed) and nothing more is sent', () => {
    const bp = fakeButtplug([MACHINE]);
    const sync = new ButtplugSync({ videoPlayer: { paused: true }, buttplugManager: bp, funscriptEngine: null });
    sync.setRampUp(MACHINE.index, false);
    const sw = new OrgasmSwitch({ buttplugManager: bp, oscillate: (dev, pos, prevPos, ms, startMs) => sync.oscillateNow(dev.index, pos, prevPos, ms, startMs) });
    sw.setTimerImpl(() => 1, () => {});
    const raw = buildPatternSourceContent({ id: 'sprint-finish' });
    sw.loadScript(raw, { once: true });
    const end = parseFinisherActions(raw).at(-1).at;
    sw.activate();
    for (let t = 40; t <= end + 40; t += 40) { clock = t; sw._tick(); }
    const osc = kinds(bp.sent, 'oscillate', MACHINE.index);
    expect(Math.max(...osc.map((s) => s.v))).toBeGreaterThan(20);
    expect(osc.at(-1).v).toBe(0);
    const n = bp.sent.length;
    for (const t of [end + 500, end + 4000]) { clock = t; sw._tick(); }
    expect(bp.sent.length).toBe(n);
    sw.deactivate();
  });
});

// ---------------------------------------------------------------------------
describe('the Handy: an ending is uploaded as it is, never tiled', () => {
  it('once: the upload is the one-shot script with its end held, then setup and play from 0', async () => {
    // Its last position is carried on (holdFinisherEnd): a Handy left at the
    // END of an HSSP script went to the last point's raw position, under the
    // stroke zone (device session 2026-11-20, step 37).
    const handy = recordingHandy();
    const content = buildPatternSourceContent({ id: 'plunge-finish' });
    const status = await engageHandyFinisher({ handyManager: handy, content, cachedUrl: null, cutoff: null, once: true, isCurrent: () => true });
    expect(status).toBe('looping');
    expect(handy.calls.map((c) => c.kind)).toEqual(['upload', 'setup', 'play']);
    expect(handy.calls[0].content).toBe(holdFinisherEnd(content));
    expect(handy.calls[2].ms).toBe(0);
  });

  it('a loop (once not set) is tiled as before', async () => {
    const handy = recordingHandy();
    const content = buildPatternSourceContent({ id: 'plunge-finish' });
    await engageHandyFinisher({ handyManager: handy, content, cachedUrl: null, cutoff: null, isCurrent: () => true });
    expect(handy.calls[0].content).toBe(tileFinisherContent(content));
    expect(JSON.parse(handy.calls[0].content).actions.length).toBeGreaterThan(parseFinisherActions(content).length);
  });
});

// ---------------------------------------------------------------------------
describe('app.js: X with an ending from the library, and machines on X', () => {
  const LiftedApp = liftAppClass(
    ['_reloadOrgasmScripts', '_orgasmLibrarySource', '_orgasmLibrarySettings', '_recoverOrgasmPaths',
      '_saveOrgasmConfigQuiet', '_refreshOrgasmPlan', '_getOrgasmEntry', '_pushRemoteOrgasmState',
      '_onOrgasmHold', '_maybeToastOrgasmDemotion',
      // the shared pattern choice (pattern settings unification, 2026-11-19)
      '_patternScriptRange', '_orgasmFollowScriptNow'],
    {
      patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround,
      orgasmPatternSettings, orgasmPatternKey, buildOrgasmPatternContent,
      orgasmLibrarySettings, patternSourceKey, buildPatternSourceContent, isOneShotPattern,
      parseFinisherActions, collectOrgasmScriptPaths, describeOrgasmEntry, resolveOrgasmPlan,
      normalizeAssociation, buildAssociationEntry, findMovedFile, getAxisBySuffix,
      showToast: () => {}, t: (k) => k,
    },
  );
  let store;

  function makeApp({ handy = null, buttplug = null, tcode = null } = {}) {
    const app = new LiftedApp();
    app.settings = { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
    app.handyManager = handy;
    app.buttplugManager = buttplug;
    app.tcodeManager = tcode;
    app.remoteBridge = null;
    app.library = { getAllFunscriptPaths: () => [], _safeToPrune: async () => true };
    const options = liftCtorOptions('OrgasmSwitch', { engageHandyFinisher, releaseHandyFinisher }).call(app);
    app.orgasmSwitch = new OrgasmSwitch({ ...options, now: () => clock });
    app.orgasmSwitch.setTimerImpl(() => 1, () => {});
    app._cutoffFromSettings = () => null;
    app._handyInverted = () => false;
    app._restoreHandyAfterOrgasm = vi.fn(async () => {});
    app._stopAllDevicesIdle = () => {};
    app._playerWindowPlayback = () => false;
    app.tcodeSync = { _active: false, start: vi.fn(), stop: vi.fn() };
    // A real Buttplug engine with no video: the switch drives the machine
    // through its oscillate path.
    app.buttplugSync = buttplug ? new ButtplugSync({ videoPlayer: { paused: true }, buttplugManager: buttplug, funscriptEngine: null }) : null;
    return app;
  }
  beforeEach(() => { store = {}; });

  it('X plays the ending once and holds it; letting go restores as for any pattern', async () => {
    const bp = fakeButtplug([STROKER, VIBE]);
    const app = makeApp({ buttplug: bp, tcode: fakeTcode() });
    const p = { enabled: true, id: 'last-stroke-then-still', speed: null, reversed: false, min: null, max: null };
    store['player.orgasmLibraryPattern'] = p;
    await app._reloadOrgasmScripts();
    expect(app._orgasmPlan.once).toBe(true);
    expect(app.orgasmSwitch.once).toBe(true);
    const actions = parseFinisherActions(buildPatternSourceContent(p));
    const end = actions.at(-1).at;

    app._onOrgasmHold(true);
    for (let t = 40; t <= end + 3000; t += 40) { clock = t; app.orgasmSwitch._tick(); }
    expect(app.orgasmSwitch.livePosition).toBeCloseTo(actions.at(-1).pos, 6);
    expect(kinds(bp.sent, 'linear').at(-1).pos).toBeCloseTo(actions.at(-1).pos, 6);
    app._onOrgasmHold(false);
    expect(app.orgasmSwitch.active).toBe(false);
    expect(bp.stopSustainedOutputs).toHaveBeenCalled();
  });

  it('switching to a loop pattern makes the switch loop again', async () => {
    const app = makeApp({ buttplug: fakeButtplug([STROKER]) });
    store['player.orgasmLibraryPattern'] = { enabled: true, id: 'sprint-finish' };
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.once).toBe(true);
    store['player.orgasmLibraryPattern'] = { enabled: true, id: LOOP };
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.once).toBe(false);
    expect(app._orgasmPlan.once).toBeUndefined();
  });

  it('the Handy gets the ending untiled, under its own cache key', async () => {
    const handy = recordingHandy();
    const app = makeApp({ handy });
    const p = { enabled: true, id: 'plunge-finish' };
    store['player.orgasmLibraryPattern'] = p;
    await app._reloadOrgasmScripts();
    expect(app.orgasmSwitch.activate()).toBe('activated');
    expect(await app._orgasmEngagePromise).toBe('looping');
    const upload = handy.calls.find((c) => c.kind === 'upload');
    expect(upload.content).toBe(holdFinisherEnd(buildPatternSourceContent(p)));   // untiled, its end held
    expect(handy.calls.map((c) => c.kind)).toEqual(['upload', 'setup', 'play']);
    expect(app._orgasmCloudUrlCutoffKey.startsWith(`once-v1|${patternSourceKey(p)}|`)).toBe(true);
    app.orgasmSwitch.deactivate();
    await app._orgasmReleasePromise;
    expect(handy.calls.at(-1).kind).toBe('stop');
    expect(app._restoreHandyAfterOrgasm).toHaveBeenCalledTimes(1);
  });

  it('a flywheel machine follows X\'s loop, and the release zeroes it with the other sustained outputs', async () => {
    const bp = fakeButtplug([STROKER, MACHINE]);
    const app = makeApp({ buttplug: bp });
    store['player.orgasmLibraryPattern'] = { enabled: true, id: LOOP };
    await app._reloadOrgasmScripts();
    clock = 1000;
    app._onOrgasmHold(true);
    for (let t = 1040; t <= 4000; t += 40) { clock = t; app.orgasmSwitch._tick(); }
    const osc = kinds(bp.sent, 'oscillate', MACHINE.index);
    expect(osc.length).toBeGreaterThan(20);
    expect(Math.max(...osc.map((s) => s.v))).toBeGreaterThan(30);
    expect(Math.max(...osc.map((s) => s.v))).toBeLessThanOrEqual(70);   // the default Max cap
    const n = bp.sent.length;
    app._onOrgasmHold(false);
    expect(bp.sent.slice(n).map((s) => s.kind)).toContain('stopSustained');
    clock = 6000;
    app.orgasmSwitch._tick();
    expect(kinds(bp.sent.slice(n), 'oscillate')).toEqual([]);
  });
});
