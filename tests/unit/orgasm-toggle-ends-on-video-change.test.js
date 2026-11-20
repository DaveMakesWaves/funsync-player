/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Block F decision 4 (Dave, 2026-11-19: "4 yes"; also in v0.9.2): a video
// change ends an Orgasm Switch started as a TOGGLE. loadVideo stopped the
// Handy's finisher (FN-01's hsspStop) and an Edge Hold pattern, but the
// switch's own per-tick loop went on driving Buttplug and T-Code on the next
// video until X was pressed again: against Dave's rule that every device
// stops on a video change. It now ends the way a second press ends it
// (finish: every device stops, nothing snaps back to the old script). A
// global hotkey's X is a toggle whatever the setting says (no key-up), so it
// ends the same way. Since pf-fixup (Dave 2026-11-19 ~14:52) a HELD X (hold
// mode) ends the same way too, and letting go of the key afterwards does
// nothing.
//
// The REAL loadVideo / _playFromLibrary / _onOrgasmHold / _finishOrgasm and
// the REAL OrgasmSwitch with app.js's own onActivate / onDeactivate (lifted),
// the REAL HandyManager on the fake SDK, fake Buttplug / T-Code managers
// (the same harness as edge-hold-pattern.test.js). No network; fake key.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, names: new Map(), uploads: [] }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async (content) => {
    await new Promise((r) => setTimeout(r, 0));
    h.uploads.push(content);
    return `https://scripts.local/${h.names.get(content) || `upload${h.uploads.length}`}.csv`;
  },
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { engageHandyFinisher, releaseHandyFinisher, tileFinisherContent } from '../../renderer/js/orgasm-handy-engage.js';
import {
  EDGE_PATTERN_DEFAULTS, edgeHoldAction, normalizePatternSource, patternSourceKey, buildPatternSourceContent,
  isOneShotPattern,
} from '../../renderer/js/pattern-source.js';
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';
import { liftCtorOptions } from './helpers/app-methods.js';
import { patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround } from '../../renderer/js/pattern-choice.js';
import { teardownPlayback, isVideoInPip } from '../../renderer/js/pip-guard.js';
import { shouldEnterMiniplayer } from '../../renderer/js/miniplayer.js';

const SCRIPT_A = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 600, pos: 90 }, { at: 1200, pos: 10 }] });
const SCRIPT_B = JSON.stringify({ actions: [{ at: 0, pos: 90 }, { at: 400, pos: 10 }] });
const FINISHER = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 300, pos: 100 }, { at: 600, pos: 0 }] });
const FIN_KEY = 'C:\\Finishers\\fin.funscript';
h.names.set(SCRIPT_A, 'A');
h.names.set(SCRIPT_B, 'B');
h.names.set(tileFinisherContent(FINISHER), 'FIN');
const A = 'C:\\Lib\\Alpha.mp4';
const B = 'C:\\Lib\\Bravo.mp4';

const settle = async (n = 16) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const METHODS = [
  '_onEdgeHold', '_edgePatternStart', '_edgePatternStop', '_dropEdgePattern', '_makeEdgeLoop',
  '_resumeHandyAfterEdge', '_restoreHandyAfterOrgasm', '_stopAllDevicesIdle',
  '_onOrgasmHold', '_finishOrgasm', '_maybeToastOrgasmDemotion', '_onGlobalShortcut',
  '_uploadAndStartSync', '_tryStartAutoblowSync',
  '_ownVideoPaused', '_noteAutoblowForEdge', '_rearmAutoblowAfterEdge',
  '_onLeaveView', '_teardownPlayback', '_isOurVideoInPip', '_shouldEnterMiniplayer',
  '_patternScriptRange', '_orgasmFollowScriptNow', '_orgasmLibrarySettings', '_orgasmLibrarySource',
];

let Lifted;
let app;
let video;
let manager;
let engine;
let script;
let clock;
let bp;
let tc;
let syncs;

function fakeButtplug() {
  const sent = [];
  return {
    sent,
    connected: true,
    devices: [{ index: 0, name: 'Stroker', canLinear: true }, { index: 1, name: 'Vibe', canVibrate: true }],
    sendLinear: vi.fn((i, pos) => { sent.push({ kind: 'linear', i, pos }); }),
    sendVibrate: vi.fn((i, v) => { sent.push({ kind: 'vibrate', i, v }); }),
    sendRotate: vi.fn(),
    stopAll: vi.fn(async () => { sent.push({ kind: 'stopAll' }); }),
    stopSustainedOutputs: vi.fn(async () => { sent.push({ kind: 'stopSustained' }); }),
  };
}
function fakeTcode() {
  const sent = [];
  return { sent, connected: true, sendAxes: vi.fn((axes) => { sent.push({ ...axes }); }), stop: vi.fn(() => { sent.push('DSTOP'); }) };
}
function fakeSync(name, log) {
  return {
    _active: true,
    setVibrationActions: vi.fn(),
    clearAxisActions: vi.fn(),
    start: vi.fn(function start() { this._active = true; log.push(`${name}.start`); }),
    stop: vi.fn(function stop() { this._active = false; log.push(`${name}.stop`); }),
  };
}

beforeAll(() => {
  Lifted = makeLoadAppClass({
    extra: METHODS,
    deps: {
      edgeHoldAction, normalizePatternSource, patternSourceKey, buildPatternSourceContent,
      EDGE_PATTERN_DEFAULTS, isOneShotPattern,
      patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, scriptRangeAround, choiceSource,
      OrgasmSwitch, engageHandyFinisher, releaseHandyFinisher,
      teardownPlayback, isVideoInPip, shouldEnterMiniplayer,
      exitFullscreenForNav: () => {},
    },
  });
});

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  h.uploads = [];
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  manager._hsspSpacingMs = 0;
  manager._setScriptSpacingMs = 0;
  bp = fakeButtplug();
  tc = fakeTcode();
  const log = [];
  syncs = { log, buttplug: fakeSync('buttplug', log), tcode: fakeSync('tcode', log), autoblow: fakeSync('autoblow', log) };
  ({ app, video } = buildLoadApp(Lifted, {
    handyManager: manager,
    buttplugManager: bp,
    tcodeManager: tc,
    deviceSimulator: { orgasmSwitch: null, edgeLoop: null },
  }));
  script = null;
  app.funscriptEngine = { clear() {}, get isLoaded() { return !!script; }, getRawContent: () => script };
  engine = new SyncEngine({ videoPlayer: app.videoPlayer, handyManager: manager, funscriptEngine: app.funscriptEngine });
  app.syncEngine = engine;
  app.loadFunscript = vi.fn(async (fs) => {
    script = fs.textContent;
    await app._uploadAndStartSync();
  });
  clock = 0;
  app._edgeLoop = app._makeEdgeLoop();
  app._edgeLoop._now = () => clock;
  app._edgeLoop.setTimerImpl(() => 1, () => {});
  const options = liftCtorOptions('OrgasmSwitch', { engageHandyFinisher, releaseHandyFinisher }).call(app);
  app.orgasmSwitch = new OrgasmSwitch({ ...options, now: () => clock });
  app.orgasmSwitch.setTimerImpl(() => 1, () => {});
});

afterEach(() => {
  app._edgeLoop?.deactivate();
  app.orgasmSwitch?.deactivate();
  engine.stop();
  manager._stopHealthCheck();
});

const hssp = () => h.sdk.calls.filter(([n]) => n === 'hsspPlay' || n === 'hsspStop').map(([n]) => n);
const deviceRunning = () => hssp().at(-1) === 'hsspPlay';
const legsSince = (i) => h.sdk.calls.slice(i)
  .filter(([n]) => ['setScript', 'hsspPlay', 'hsspStop'].includes(n))
  .map(([n, arg]) => (n === 'setScript' ? `setScript:${String(arg).split('/').pop()}` : n));
const lastScript = () => h.sdk.calls.filter(([n]) => n === 'setScript').map(([, a]) => String(a).split('/').pop()).at(-1);

async function playAlpha() {
  await app._playFromLibrary(fileItem(A), { name: 'a.funscript', textContent: SCRIPT_A }, null, []);
  video.fire('loadeddata');
  await vi.waitFor(() => expect(engine._scriptReady).toBe(true));
  video.play();
  await settle();
  expect(deviceRunning(), 'Alpha plays on the Handy').toBe(true);
  app.buttplugSync = syncs.buttplug;
  app.tcodeSync = syncs.tcode;
  app.autoblowSync = syncs.autoblow;
  for (const s of [syncs.buttplug, syncs.tcode, syncs.autoblow]) s._active = true;
  syncs.log.length = 0;
}

function configureX(mode) {
  app._settingsMap.set('player.orgasmSwitchMode', mode);
  app._orgasmPlan = { mode: 'single', handyPath: FIN_KEY };
  app._orgasmContentCache = new Map([[FIN_KEY, FINISHER]]);
  expect(app.orgasmSwitch.loadScript(FINISHER)).toBe(true);
}

/** One tick of the finisher's loop at time t: what it sends the local devices. */
function tickFinisher(t) {
  bp.sent.length = 0;
  tc.sent.length = 0;
  clock = t;
  app.orgasmSwitch._tick();
  return { bp: bp.sent.filter((s) => s.kind === 'linear' || s.kind === 'vibrate'), tc: tc.sent.filter((s) => typeof s === 'object') };
}

const openBravo = () => app._playFromLibrary(fileItem(B), { name: 'b.funscript', textContent: SCRIPT_B }, null, []);

describe('a video change ends an Orgasm Switch started as a toggle (Dave 2026-11-19, decision 4)', () => {
  it('toggle mode: the loop stops driving Buttplug / T-Code, every device stops, the Handy gets the new video\'s script', async () => {
    await playAlpha();
    configureX('toggle');
    app._onOrgasmHold(true);
    app._onOrgasmHold(false);                    // the release is ignored in toggle mode
    await settle();
    expect(app.orgasmSwitch.active).toBe(true);
    expect(tickFinisher(1000).bp.length, 'the finisher drives the Buttplug toy').toBeGreaterThan(0);

    const mark = h.sdk.calls.length;
    bp.sent.length = 0;
    tc.sent.length = 0;
    const load = openBravo();                    // N, a library open, a queue advance: all load here
    expect(app.orgasmSwitch.active, 'the finisher ended with the video').toBe(false);
    expect(bp.sent.map((s) => s.kind)).toContain('stopAll');
    expect(tc.stop).toHaveBeenCalled();
    await load;
    await settle();

    const after = tickFinisher(5000);
    expect(after.bp, 'nothing drives the Buttplug toy after the video change').toEqual([]);
    expect(after.tc).toEqual([]);
    const legs = legsSince(mark);
    expect(legs[0]).toBe('hsspStop');
    expect(legs).not.toContain('setScript:FIN.csv');
    expect(legs).not.toContain('setScript:A.csv');   // nothing snaps back to the old script
    expect(lastScript()).toBe('B.csv');
  });

  it('the next X press starts it again, as after any toggle-off', async () => {
    await playAlpha();
    configureX('toggle');
    app._onOrgasmHold(true);
    await settle();
    await openBravo();
    await settle();
    expect(app.orgasmSwitch.active).toBe(false);
    app._onOrgasmHold(true);
    expect(app.orgasmSwitch.active).toBe(true);
  });

  it('the global hotkey\'s X (a toggle whatever the setting says) ends the same way', async () => {
    await playAlpha();
    configureX('hold');
    app._onGlobalShortcut('orgasm');
    await settle();
    expect(app.orgasmSwitch.active).toBe(true);
    await openBravo();
    await settle();
    expect(app.orgasmSwitch.active).toBe(false);
    expect(tickFinisher(5000).bp).toEqual([]);
  });

});

describe('a video change ends a HELD Orgasm Switch too (Dave 2026-11-19 ~14:52, pf-fixup)', () => {
  it("hold mode: the loop stops driving Buttplug / T-Code, every device stops, the Handy gets the new video's script", async () => {
    await playAlpha();
    configureX('hold');
    app._onOrgasmHold(true);                     // X held down
    await settle();
    expect(app.orgasmSwitch.active).toBe(true);
    expect(tickFinisher(1000).bp.length, 'the finisher drives the Buttplug toy').toBeGreaterThan(0);

    const mark = h.sdk.calls.length;
    bp.sent.length = 0;
    tc.sent.length = 0;
    const load = openBravo();
    expect(app.orgasmSwitch.active, 'the held finisher ended with the video').toBe(false);
    expect(bp.sent.map((s) => s.kind)).toContain('stopAll');
    expect(tc.stop).toHaveBeenCalled();
    await load;
    await settle();

    const after = tickFinisher(5000);
    expect(after.bp, 'nothing drives the Buttplug toy after the video change').toEqual([]);
    expect(after.tc).toEqual([]);
    const legs = legsSince(mark);
    expect(legs[0]).toBe('hsspStop');
    expect(legs).not.toContain('setScript:FIN.csv');
    expect(legs).not.toContain('setScript:A.csv');   // nothing snaps back to the old script
    expect(lastScript()).toBe('B.csv');
  });

  it('letting go of X after the video change does nothing: no device command, no engine restarted, nothing snaps back', async () => {
    await playAlpha();
    configureX('hold');
    app._onOrgasmHold(true);
    await settle();
    await openBravo();
    await settle();
    expect(app.orgasmSwitch.active).toBe(false);

    const mark = h.sdk.calls.length;
    bp.sent.length = 0;
    tc.sent.length = 0;
    const tcStops = tc.stop.mock.calls.length;
    const engines = syncs.log.length;
    const script = lastScript();
    app._onOrgasmHold(false);                    // the key comes up on the new video
    await settle();
    expect(app.orgasmSwitch.active).toBe(false);
    expect(h.sdk.calls.slice(mark).map(([n]) => n), 'the Handy hears nothing').toEqual([]);
    expect(bp.sent).toEqual([]);
    expect(tc.sent).toEqual([]);
    expect(tc.stop.mock.calls.length).toBe(tcStops);
    expect(syncs.log.slice(engines), 'no engine restarted by the release').toEqual([]);
    expect(lastScript()).toBe(script);
  });

  it('the next X press on the new video holds as usual, and its release lets go', async () => {
    await playAlpha();
    configureX('hold');
    app._onOrgasmHold(true);
    await settle();
    await openBravo();
    await settle();
    app._onOrgasmHold(false);                    // the old press's key-up: nothing
    app._onOrgasmHold(true);                     // a new hold
    expect(app.orgasmSwitch.active).toBe(true);
    app._onOrgasmHold(false);
    expect(app.orgasmSwitch.active).toBe(false);
  });

  it('a hold after an earlier toggle ends the same way (the toggle mark plays no part any more)', async () => {
    await playAlpha();
    configureX('toggle');
    app._onOrgasmHold(true);
    await settle();
    app._onOrgasmHold(true);                     // toggled off
    await settle();
    app._settingsMap.set('player.orgasmSwitchMode', 'hold');
    app._onOrgasmHold(true);                     // now held
    await settle();
    await openBravo();
    await settle();
    expect(app.orgasmSwitch.active).toBe(false);
    expect(tickFinisher(5000).bp).toEqual([]);
  });
});
