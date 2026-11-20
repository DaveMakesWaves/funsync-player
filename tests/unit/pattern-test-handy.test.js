/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// pf-fixup item 4 (2026-11-19): with only a Handy connected, Settings' Test
// (Gap Filler, Orgasm Switch, Edge Hold) said "Connect a device first". It now
// plays the sample on the Handy through the existing engage path (the
// Orgasm Switch's: upload with cutoff and invert baked in, setScript,
// hsspPlay), never while a video plays or X / Z / a session owns the Handy,
// and ends on Stop, at its end, when a video starts or changes, and when X is
// pressed. At the end the Handy stops and gets this video's script back, the
// main engine listening again (the video is paused: nothing moves until play).
//
// The REAL _startFillerTest / _startHandyTest / _endHandyTest /
// _restoreHandyAfterTest, the REAL load path, _onOrgasmHold and the REAL
// OrgasmSwitch with app.js's own options (lifted), the REAL HandyManager on
// the fake SDK, the REAL SyncEngine and FillerTestPlayer (its clock driven by
// the test). No network; fake key.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, names: new Map(), uploads: [], failUpload: false }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async (content) => {
    await new Promise((r) => setTimeout(r, 0));
    if (h.failUpload) throw new Error('upload refused (test)');
    h.uploads.push(content);
    return `https://scripts.local/${h.names.get(content) || `upload${h.uploads.length}`}.csv`;
  },
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { FillerTestPlayer } from '../../renderer/js/filler-test-player.js';
import { engageHandyFinisher, releaseHandyFinisher, tileFinisherContent, HOLD_END_MS } from '../../renderer/js/orgasm-handy-engage.js';
import {
  EDGE_PATTERN_DEFAULTS, edgeHoldAction, normalizePatternSource, patternSourceKey, buildPatternSourceContent, isOneShotPattern,
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
/** A Gap Filler-shaped sample: its first point after the join (300 ms), 8 s long. */
const SAMPLE = [];
for (let at = 300; at <= 8000; at += 400) SAMPLE.push({ at, pos: SAMPLE.length % 2 ? 30 : 70 });

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const METHODS = [
  '_onEdgeHold', '_edgePatternStart', '_edgePatternStop', '_dropEdgePattern', '_makeEdgeLoop',
  '_resumeHandyAfterEdge', '_restoreHandyAfterOrgasm', '_stopAllDevicesIdle',
  '_onOrgasmHold', '_finishOrgasm', '_maybeToastOrgasmDemotion', '_onGlobalShortcut',
  '_uploadAndStartSync', '_tryStartAutoblowSync',
  '_ownVideoPaused', '_noteAutoblowForEdge', '_rearmAutoblowAfterEdge',
  '_onLeaveView', '_teardownPlayback', '_isOurVideoInPip', '_shouldEnterMiniplayer',
  '_patternScriptRange', '_orgasmFollowScriptNow', '_orgasmLibrarySettings', '_orgasmLibrarySource',
  '_startFillerTest', '_handyTestBusy', '_startHandyTest', '_endHandyTest', '_restoreHandyAfterTest',
];

let Lifted;
let app;
let video;
let manager;
let engine;
let script;
let clock;

beforeAll(() => {
  Lifted = makeLoadAppClass({
    extra: METHODS,
    deps: {
      edgeHoldAction, normalizePatternSource, patternSourceKey, buildPatternSourceContent,
      EDGE_PATTERN_DEFAULTS, isOneShotPattern,
      patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, scriptRangeAround, choiceSource,
      OrgasmSwitch, engageHandyFinisher, releaseHandyFinisher, FillerTestPlayer,
      teardownPlayback, isVideoInPip, shouldEnterMiniplayer,
      exitFullscreenForNav: () => {},
    },
  });
});

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  h.uploads = [];
  h.failUpload = false;
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  manager._hsspSpacingMs = 0;
  manager._setScriptSpacingMs = 0;
  ({ app, video } = buildLoadApp(Lifted, {
    handyManager: manager,
    // Only the Handy: nothing local is connected.
    buttplugManager: { connected: false, stopAll: vi.fn(), stopSustainedOutputs: vi.fn() },
    tcodeManager: { connected: false, stop: vi.fn() },
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
  // The test's own clock: the run is driven tick by tick.
  app._fillerTest = new FillerTestPlayer({ now: () => clock, setInterval: () => 1, clearInterval: () => {} });
  app._edgeLoop = app._makeEdgeLoop();
  app._edgeLoop._now = () => clock;
  app._edgeLoop.setTimerImpl(() => 1, () => {});
  const options = liftCtorOptions('OrgasmSwitch', { engageHandyFinisher, releaseHandyFinisher }).call(app);
  app.orgasmSwitch = new OrgasmSwitch({ ...options, now: () => clock });
  app.orgasmSwitch.setTimerImpl(() => 1, () => {});
});

afterEach(() => {
  app._fillerTest?.stop();
  app.orgasmSwitch?.deactivate();
  engine.stop();
  manager._stopHealthCheck();
});

const legsSince = (i) => h.sdk.calls.slice(i)
  .filter(([n]) => ['setScript', 'hsspPlay', 'hsspStop'].includes(n))
  .map(([n, arg]) => (n === 'setScript' ? `setScript:${String(arg).split('/').pop()}` : n));
const toasts = () => globalThis.__liftedToasts || [];

/** Alpha loaded and played on the Handy, then paused: where a person opens Settings. */
async function alphaPaused() {
  await app._playFromLibrary(fileItem(A), { name: 'a.funscript', textContent: SCRIPT_A }, null, []);
  video.fire('loadeddata');
  await vi.waitFor(() => expect(engine._scriptReady).toBe(true));
  video.play();
  await settle();
  video.pause();
  await settle();
  expect(engine._active).toBe(true);
}
function startTest() {
  const hooks = { onProgress: vi.fn(), onEnd: vi.fn() };
  return { hooks, status: app._startFillerTest(SAMPLE, hooks) };
}

describe('Test plays on the Handy (pf-fixup item 4)', () => {
  it('only a Handy: it plays the sample from its first point; the playhead starts when the Handy does', async () => {
    await alphaPaused();
    const mark = h.sdk.calls.length;
    const { status, hooks } = startTest();
    expect(status).toBe('started');
    expect(app._fillerTest.running, 'the playhead waits for the Handy').toBe(false);
    expect(engine._active, 'the main engine steps aside').toBe(false);
    await settle();
    const legs = legsSince(mark);
    expect(legs).toEqual([`setScript:upload${h.uploads.length}.csv`, 'hsspPlay']);
    // The sample from its first point, played once, its last position held
    // until the Test's own stop (holdFinisherEnd, 2026-11-20: a Handy at the
    // END of an HSSP script went to the last point's raw position).
    const up = JSON.parse(h.uploads.at(-1)).actions;
    const last = SAMPLE.at(-1);
    expect(up[0].at).toBe(0);
    expect(up.map((a) => a.at)).toEqual([...SAMPLE.map((a) => a.at - 300), last.at - 300 + HOLD_END_MS]);
    expect(up.map((a) => a.pos)).toEqual([...SAMPLE.map((a) => a.pos), last.pos]);
    expect(app._fillerTest.running).toBe(true);
    clock = 1000;
    app._fillerTest._tick();
    expect(hooks.onProgress).toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it('Stop: the Handy stops and gets this video\'s script back, nothing plays under the paused video; play then plays the video\'s script', async () => {
    await alphaPaused();
    const { hooks } = startTest();
    await settle();
    const mark = h.sdk.calls.length;
    app._fillerTest.stop();                       // the block's Stop / the drawer closed / Settings closed
    await settle();
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:A.csv']);
    expect(engine._active).toBe(true);
    expect(engine._scriptReady).toBe(true);
    const mark2 = h.sdk.calls.length;
    video.play();
    await settle();
    expect(legsSince(mark2)).toEqual(['hsspPlay']);
    expect(h.sdk.calls.filter(([n]) => n === 'setScript').at(-1)[1]).toMatch(/A\.csv$/);
  });

  it('the run\'s own end: the same restore', async () => {
    await alphaPaused();
    const { hooks } = startTest();
    await settle();
    const mark = h.sdk.calls.length;
    clock = 9000;
    app._fillerTest._tick();
    await settle();
    expect(hooks.onEnd).toHaveBeenCalled();
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:A.csv']);
    expect(engine._active).toBe(true);
  });

  it('never while a video plays, X or Z holds, or a session owns the Handy: "busy", nothing sent', async () => {
    await alphaPaused();
    video.play();
    await settle();
    let mark = h.sdk.calls.length;
    expect(startTest().status).toBe('busy');
    video.pause();
    await settle();
    for (const [flag, value] of [['_edgeActive', true], ['_playerWindowActive', true], ['_remoteActive', true], ['_vrPlayerRef', {}]]) {
      app[flag] = value;
      mark = h.sdk.calls.length;
      expect(startTest().status, flag).toBe('busy');
      expect(legsSince(mark), flag).toEqual([]);
      app[flag] = flag === '_vrPlayerRef' ? null : false;
    }
    expect(h.uploads.length).toBe(1);             // Alpha's own upload only
  });

  it('a video started under the test ends it, and the Handy plays the video\'s script', async () => {
    await alphaPaused();
    const { hooks } = startTest();
    await settle();
    const mark = h.sdk.calls.length;
    video.play();
    await settle();
    expect(hooks.onEnd).toHaveBeenCalled();
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:A.csv', 'hsspPlay']);
    expect(engine._active).toBe(true);
  });

  it('a video change ends it: no restore of the old script, the new video\'s script is set', async () => {
    await alphaPaused();
    const { hooks } = startTest();
    await settle();
    const mark = h.sdk.calls.length;
    await app._playFromLibrary(fileItem(B), { name: 'b.funscript', textContent: SCRIPT_B }, null, []);
    await settle();
    expect(hooks.onEnd).toHaveBeenCalled();
    const legs = legsSince(mark);
    expect(legs[0]).toBe('hsspStop');
    expect(legs).not.toContain('setScript:A.csv');
    expect(h.sdk.calls.filter(([n]) => n === 'setScript').at(-1)[1]).toMatch(/B\.csv$/);
  });

  it('X pressed during the test: the test ends, X\'s finisher plays, nothing restores the main script under it', async () => {
    await alphaPaused();
    app._settingsMap.set('player.orgasmSwitchMode', 'hold');
    app._orgasmPlan = { mode: 'single', handyPath: FIN_KEY };
    app._orgasmContentCache = new Map([[FIN_KEY, FINISHER]]);
    expect(app.orgasmSwitch.loadScript(FINISHER)).toBe(true);
    const { hooks } = startTest();
    await settle();
    const mark = h.sdk.calls.length;
    app._onOrgasmHold(true);
    expect(hooks.onEnd).toHaveBeenCalled();
    await settle();
    // X goes straight to its finisher: the test's end gives way (no stop and no main script in between)
    expect(legsSince(mark)).toEqual(['setScript:FIN.csv', 'hsspPlay']);
    app._onOrgasmHold(false);                     // X's own release brings the script back
    await settle();
    expect(h.sdk.calls.filter(([n]) => n === 'setScript').at(-1)[1]).toMatch(/A\.csv$/);
  });

  it('the cutoff and the invert are baked into the upload, as for the finisher', async () => {
    await alphaPaused();
    app._cutoffFromSettings = () => ({ min: 20, max: 80 });
    app._handyInverted = () => true;
    startTest();
    await settle();
    const up = JSON.parse(h.uploads.at(-1)).actions.map((a) => a.pos);
    expect(Math.min(...up)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...up)).toBeLessThanOrEqual(80);
    expect(up[0]).not.toBe(SAMPLE[0].pos);        // 70, inverted to 30, clamped to the band
  });

  it('the Handy cannot play it (upload refused): it says so; with only a Handy the run ends', async () => {
    await alphaPaused();
    h.failUpload = true;
    const { status, hooks } = startTest();
    expect(status).toBe('started');
    await settle();
    expect(toasts().map((x) => x.key)).toContain('toast.patternTestHandyFailed');
    expect(hooks.onEnd).toHaveBeenCalled();
    expect(app._fillerTest.running).toBe(false);
    expect(engine._active).toBe(true);           // the main engine listens again
  });

  it('no video loaded: it plays and stops; nothing to restore, the engine stays as it was', async () => {
    const mark = h.sdk.calls.length;
    const { hooks } = startTest();
    await settle();
    expect(legsSince(mark)).toEqual([`setScript:upload${h.uploads.length}.csv`, 'hsspPlay']);
    app._fillerTest.stop();
    await settle();
    expect(hooks.onEnd).toHaveBeenCalled();
    expect(legsSince(mark).slice(2)).toEqual(['hsspStop']);
    expect(engine._active).toBe(false);
  });

  it('nothing connected at all: "Connect a device first", as before', () => {
    manager._connected = false;
    expect(startTest().status).toBe('no-devices');
  });
});
