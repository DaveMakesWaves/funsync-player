/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Edge Hold "Play a pattern" (next major, DESIGN-pattern-library.md §e):
// `player.edgeHoldAction: 'pattern'` makes Z play `player.edgePattern` on its
// own clock instead of stopping the devices, and its release restores the way
// the Orgasm Switch's release does. 'stop' (the default) is Z as it always
// was.
//
// What runs is REAL: app.js's Edge and Orgasm methods and its load path
// (helpers/handy-load-app.js), the REAL OrgasmSwitch for both loops (X's from
// the REAL options app.js passes it), the REAL engage / release sequences,
// the REAL HandyManager (its HSSP chain, uploads, stop pre-emption) and the
// REAL SyncEngine on a fake SDK that keeps the real SDK's local rules
// (helpers/fake-handy-sdk.js). Buttplug, T-Code and the Autoblow are
// recording fakes with the real classes' method names (checked against the
// prototypes). Nothing reaches a cloud; the key is the fake TESTKEY01.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, names: new Map(), uploads: [], failUpload: false, failBuild: false }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  // A cloud upload: a round trip, then a URL naming the script.
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
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { engageHandyFinisher, releaseHandyFinisher, tileFinisherContent, holdFinisherEnd, HOLD_END_MS } from '../../renderer/js/orgasm-handy-engage.js';
import { parseFinisherActions } from '../../renderer/js/orgasm-plan.js';
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
// A chosen pattern: since Dave's answer (2026-11-17) there is no default one.
const EDGE = { ...EDGE_PATTERN_DEFAULTS, id: 'slow-tip-strokes' };
h.names.set(SCRIPT_A, 'A');
h.names.set(SCRIPT_B, 'B');
h.names.set(tileFinisherContent(FINISHER), 'FIN');
h.names.set(tileFinisherContent(buildPatternSourceContent(EDGE)), 'EDGE');
const A = 'C:\\Lib\\Alpha.mp4';
const B = 'C:\\Lib\\Bravo.mp4';

const settle = async (n = 16) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const EDGE_METHODS = [
  '_onEdgeHold', '_edgePatternStart', '_edgePatternStop', '_dropEdgePattern', '_makeEdgeLoop',
  '_resumeHandyAfterEdge', '_restoreHandyAfterOrgasm', '_stopAllDevicesIdle',
  '_onOrgasmHold', '_finishOrgasm', '_maybeToastOrgasmDemotion', '_onGlobalShortcut', '_stopForRelaunch',
  '_uploadAndStartSync', '_tryStartAutoblowSync',
  // Fix-up 2026-11-17: a release on a paused video, the Autoblow's restart.
  '_ownVideoPaused', '_noteAutoblowForEdge', '_rearmAutoblowAfterEdge',
  // Live fix-up 2026-11-17: leaving the player (Back) during a hold.
  '_onLeaveView', '_teardownPlayback', '_isOurVideoInPip', '_shouldEnterMiniplayer',
  // the shared pattern choice (pattern settings unification, 2026-11-19)
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

// Recording fakes with the REAL classes' method names.
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
    extra: EDGE_METHODS,
    deps: {
      edgeHoldAction,
      normalizePatternSource,
      patternSourceKey,
      buildPatternSourceContent: (p) => (h.failBuild ? null : buildPatternSourceContent(p)),
      EDGE_PATTERN_DEFAULTS,
      isOneShotPattern,
      // the shared pattern choice (pattern settings unification, 2026-11-19)
      patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, scriptRangeAround,
      choiceSource: (c, o) => (h.failBuild ? null : choiceSource(c, o)),
      OrgasmSwitch,
      engageHandyFinisher,
      releaseHandyFinisher,
      // The REAL leave path's helpers (pip-guard.js, miniplayer.js); no OS fullscreen here.
      teardownPlayback,
      isVideoInPip,
      shouldEnterMiniplayer,
      exitFullscreenForNav: () => {},
    },
  });
});

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  h.uploads = [];
  h.failUpload = false;
  h.failBuild = false;
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  manager._hsspSpacingMs = 0;   // see handy-stop-on-video-change.test.js
  // And the setScript spacing (220 ms of wall clock): a release's restore
  // and the next engage are seconds apart on a device, and with the real
  // spacing the legs after one settle() depended on how loaded the machine
  // was (fix-up 2026-11-17; handy-hdsp-return-to-1x.test.js does the same).
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
  // Both loops run on a clock the test sets; their timers never fire alone.
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

/** HSSP commands the device took, in order. */
const hssp = () => h.sdk.calls.filter(([n]) => n === 'hsspPlay' || n === 'hsspStop').map(([n]) => n);
const deviceRunning = () => hssp().at(-1) === 'hsspPlay';
const legsSince = (i) => h.sdk.calls.slice(i)
  .filter(([n]) => ['setScript', 'hsspPlay', 'hsspStop'].includes(n))
  .map(([n, arg]) => (n === 'setScript' ? `setScript:${String(arg).split('/').pop()}` : n));
const lastScript = () => h.sdk.calls.filter(([n]) => n === 'setScript').map(([, a]) => String(a).split('/').pop()).at(-1);
const edgeLoopActions = (p = EDGE) => parseFinisherActions(buildPatternSourceContent(normalizePatternSource(p, EDGE_PATTERN_DEFAULTS)));

/** Alpha open and playing with its script on the Handy; Buttplug, T-Code and the Autoblow engines running. */
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

/** The edge loop's tick at time t: what the local devices are sent. */
function tickEdge(t) {
  clock = t;
  app._edgeLoop._tick();
}

function usePattern(extra = {}) {
  app._settingsMap.set('player.edgeHoldAction', 'pattern');
  app._settingsMap.set('player.edgePattern', { ...EDGE, ...extra });
}

/** X configured with a finisher file (the plan code is orgasm-plan's, tested on its own). */
function configureX() {
  app._orgasmPlan = { mode: 'single', handyPath: FIN_KEY };
  app._orgasmContentCache = new Map([[FIN_KEY, FINISHER]]);
  expect(app.orgasmSwitch.loadScript(FINISHER)).toBe(true);
}

// ---------------------------------------------------------------------------
describe('the fakes mirror the real classes', () => {
  it('every method they stand in for exists on the real prototypes', () => {
    const has = (Cls, name) => {
      const d = Object.getOwnPropertyDescriptor(Cls.prototype, name);
      return !!d && (typeof d.value === 'function' || typeof d.get === 'function');
    };
    for (const n of ['connected', 'devices', 'sendLinear', 'sendVibrate', 'sendRotate', 'stopAll', 'stopSustainedOutputs']) expect(has(ButtplugManager, n), n).toBe(true);
    for (const n of ['connected', 'sendAxes', 'stop']) expect(has(TCodeManager, n), n).toBe(true);
    for (const Cls of [ButtplugSync, TCodeSync, AutoblowSync]) for (const n of ['start', 'stop']) expect(has(Cls, n), `${Cls.name}.${n}`).toBe(true);
    for (const n of ['setVibrationActions', 'clearAxisActions']) expect(has(ButtplugSync, n), n).toBe(true);
    expect(has(TCodeSync, 'clearAxisActions')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('"stop" (the default) is Edge Hold as it always was', () => {
  it('no setting: Z stops every device and the Handy, plays nothing, and release resumes the main script', async () => {
    await playAlpha();
    const mark = h.sdk.calls.length;
    const uploads = h.uploads.length;
    app._onEdgeHold(true);
    await settle();
    expect(app._edgeLoop.active).toBe(false);
    expect(syncs.log).toEqual(['buttplug.stop', 'tcode.stop', 'autoblow.stop']);
    expect(bp.stopAll).toHaveBeenCalled();
    expect(legsSince(mark)).toEqual(['hsspStop']);
    expect(h.uploads.length).toBe(uploads);
    app._onEdgeHold(false);
    await settle();
    expect(syncs.log.slice(3)).toEqual(['buttplug.start', 'tcode.start', 'autoblow.start']);
    expect(legsSince(mark)).toEqual(['hsspStop', 'hsspPlay']);   // no new script: it never left the device
    expect(lastScript()).toBe('A.csv');
  });

  it('a stored "stop" (or anything not "pattern") is the same', async () => {
    await playAlpha();
    app._settingsMap.set('player.edgeHoldAction', 'Pattern');
    app._settingsMap.set('player.edgePattern', { ...EDGE });
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    await settle();
    expect(app._edgeLoop.active).toBe(false);
    expect(legsSince(mark)).toEqual(['hsspStop']);
    app._onEdgeHold(false);
  });
});

// ---------------------------------------------------------------------------
describe('"Play a pattern": Z plays the pattern, release restores like the finisher', () => {
  it('hold: the engines are stopped and recorded, the local devices and the Handy play the loop; release restores them all', async () => {
    await playAlpha();
    usePattern();
    const mark = h.sdk.calls.length;
    bp.sent.length = 0;
    tc.sent.length = 0;
    app._onEdgeHold(true);                                  // Z down (its first tick is at once)
    expect(app._edgeActive).toBe(true);
    expect(app._edgeLoop.active).toBe(true);
    expect(app._edgeStoppedEngines).toEqual(['buttplug', 'tcode', 'autoblow', 'handy']);
    expect(syncs.log).toEqual(['buttplug.stop', 'tcode.stop', 'autoblow.stop']);
    expect(app.deviceSimulator.edgeLoop).toBe(app._edgeLoop);   // the simulator follows it

    // The local devices ride the loop on its own clock (Buttplug linear +
    // vibrate, T-Code L0 only: multi-axis channels rest).
    const loop = edgeLoopActions();
    for (const t of [200, 400, 600]) tickEdge(t);
    const linear = bp.sent.filter((s) => s.kind === 'linear').map((s) => s.pos);
    expect(linear[0]).toBeCloseTo(loop[0].pos, 6);
    expect(tc.sent[0].L0).toBeCloseTo(loop[0].pos, 6);
    expect(new Set(linear).size).toBeGreaterThan(1);
    expect(bp.sent.some((s) => s.kind === 'vibrate')).toBe(true);
    expect(tc.sent.every((a) => typeof a === 'object' && Object.keys(a).join() === 'L0')).toBe(true);

    // The Handy: the tiled loop uploaded, set and played. No stop first.
    await settle();
    expect(legsSince(mark)).toEqual(['setScript:EDGE.csv', 'hsspPlay']);
    expect(h.uploads.at(-1)).toBe(tileFinisherContent(buildPatternSourceContent(EDGE)));
    expect(JSON.parse(h.uploads.at(-1)).actions.length).toBeLessThanOrEqual(8000);
    expect(deviceRunning()).toBe(true);

    // Z up: the loop stops, sustained outputs are zeroed, the engines restart,
    // and the Handy stops the loop then gets the main script back.
    app._onEdgeHold(false);
    expect(app._edgeActive).toBe(false);
    expect(app._edgeLoop.active).toBe(false);
    expect(bp.stopSustainedOutputs).toHaveBeenCalled();
    expect(syncs.log.slice(3)).toEqual(['buttplug.start', 'tcode.start', 'autoblow.start']);
    await settle();
    expect(legsSince(mark)).toEqual(['setScript:EDGE.csv', 'hsspPlay', 'hsspStop', 'setScript:A.csv', 'hsspPlay']);
    expect(lastScript()).toBe('A.csv');
    expect(deviceRunning()).toBe(true);
    bp.sent.length = 0;
    tickEdge(800);
    expect(bp.sent).toEqual([]);                            // nothing drives them after release
  });

  it('the Handy upload is cached per loop, cutoff and invert: the next hold sets it again without uploading', async () => {
    await playAlpha();
    usePattern();
    const uploads = h.uploads.length;
    app._onEdgeHold(true);
    await settle();
    app._onEdgeHold(false);
    await settle();
    expect(h.uploads.length).toBe(uploads + 1);
    expect(app._edgeCloudUrlKey).toBe(`tiled-v2|${patternSourceKey(EDGE)}|null|inv=0`);
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    await settle();
    expect(h.uploads.length).toBe(uploads + 1);
    expect(legsSince(mark)).toEqual(['setScript:EDGE.csv', 'hsspPlay']);
    app._onEdgeHold(false);
    await settle();
    // Another pattern is another upload.
    usePattern({ speed: 60 });
    app._onEdgeHold(true);
    await settle();
    expect(h.uploads.length).toBe(uploads + 2);
    app._onEdgeHold(false);
    await settle();
  });

  it('toggle mode: the key release is ignored, the next press restores', async () => {
    await playAlpha();
    usePattern();
    app._settingsMap.set('player.edgeHoldMode', 'toggle');
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    app._onEdgeHold(false);                                 // key up: ignored
    expect(app._edgeLoop.active).toBe(true);
    await settle();
    app._onEdgeHold(true);                                  // second press
    expect(app._edgeLoop.active).toBe(false);
    await settle();
    expect(legsSince(mark)).toEqual(['setScript:EDGE.csv', 'hsspPlay', 'hsspStop', 'setScript:A.csv', 'hsspPlay']);
  });

  it('the global hotkey toggles it the same way (whatever the in-app mode)', async () => {
    await playAlpha();
    usePattern();
    app._onGlobalShortcut('edge');
    expect(app._edgeLoop.active).toBe(true);
    await settle();
    app._onGlobalShortcut('edge');
    expect(app._edgeLoop.active).toBe(false);
    await settle();
    expect(lastScript()).toBe('A.csv');
    expect(deviceRunning()).toBe(true);
  });

  it('plays with the video paused, as X does, and its release does to the Handy exactly what X\'s does: the main script back, the device stopped', async () => {
    await playAlpha();
    configureX();
    video.pause();
    await settle();
    // X from paused: the legs after its release.
    app._onOrgasmHold(true);
    await settle();
    let mark = h.sdk.calls.length;
    app._onOrgasmHold(false);
    await settle();
    const afterX = legsSince(mark);
    // Nothing starts under a paused picture (fix-up 2026-11-17; X used to
    // end with an hsspPlay here, a forced anchor whatever paused said).
    expect(afterX).toEqual(['hsspStop', 'setScript:A.csv']);
    expect(deviceRunning()).toBe(false);

    usePattern();
    app._onEdgeHold(true);
    expect(app._edgeLoop.active).toBe(true);
    bp.sent.length = 0;
    tickEdge(0);
    tickEdge(300);
    expect(bp.sent.filter((s) => s.kind === 'linear').length).toBeGreaterThan(0);   // moving though paused
    await settle();
    expect(deviceRunning()).toBe(true);                      // the Handy plays the loop too
    mark = h.sdk.calls.length;
    app._onEdgeHold(false);
    await settle();
    expect(legsSince(mark)).toEqual(afterX);                 // the finisher's restore, step for step
    expect(deviceRunning()).toBe(false);                     // stopped under the paused picture
    expect(engine._active).toBe(true);                       // and listening: play anchors it
    mark = h.sdk.calls.length;
    video.play();
    await settle();
    expect(legsSince(mark)).toEqual(['hsspPlay']);
    expect(lastScript()).toBe('A.csv');
    expect(deviceRunning()).toBe(true);
  });

  it('an unknown pattern id is no pattern (the default): Z stops the devices, as in "stop"', async () => {
    await playAlpha();
    usePattern({ id: 'no-such-pattern' });
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    await settle();
    expect(app._edgeLoop.active).toBe(false);
    expect(legsSince(mark)).toEqual(['hsspStop']);
    expect(bp.stopAll).toHaveBeenCalled();
    app._onEdgeHold(false);
    await settle();
    expect(legsSince(mark)).toEqual(['hsspStop', 'hsspPlay']);
  });

  it('no pattern can be built: Z stops the devices, as in "stop"', async () => {
    await playAlpha();
    usePattern();
    h.failBuild = true;
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    await settle();
    expect(app._edgeLoop.active).toBe(false);
    expect(legsSince(mark)).toEqual(['hsspStop']);
    expect(bp.stopAll).toHaveBeenCalled();
    app._onEdgeHold(false);
    await settle();
    expect(legsSince(mark)).toEqual(['hsspStop', 'hsspPlay']);
  });

  it('the Handy upload fails: the Handy rests (as in "stop"), the local devices still play; release restores', async () => {
    await playAlpha();
    usePattern();
    h.failUpload = true;
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    await settle();
    expect(app._edgeLoop.active).toBe(true);
    expect(legsSince(mark)).toEqual(['hsspStop']);
    expect(deviceRunning()).toBe(false);
    app._onEdgeHold(false);
    await settle();
    expect(lastScript()).toBe('A.csv');
    expect(deviceRunning()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('X and Z together', () => {
  it('X during a pattern hold: Z is released without its Handy restore, and X\'s engage waits for the release', async () => {
    await playAlpha();
    configureX();
    usePattern();
    app._onEdgeHold(true);
    await settle();
    const mark = h.sdk.calls.length;
    app._onOrgasmHold(true);                                // X down while Z holds
    expect(app._edgeActive).toBe(false);
    expect(app._edgeLoop.active).toBe(false);
    expect(app.orgasmSwitch.active).toBe(true);
    // Z restarted the engines it stopped, so X records and stops them.
    expect(app._orgasmStoppedEngines).toEqual(['buttplug', 'tcode']);
    await settle();
    // The edge loop is stopped BEFORE the finisher is set, and the main
    // script is never set in between.
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:FIN.csv', 'hsspPlay']);
    app._onOrgasmHold(false);                               // X up: the finisher's own restore
    await settle();
    expect(lastScript()).toBe('A.csv');
    expect(deviceRunning()).toBe(true);
  });

  it('X during a pattern hold with the finisher already uploaded: the edge loop still stops before the finisher is set', async () => {
    await playAlpha();
    configureX();
    app._onOrgasmHold(true);                                // a first X uploads and caches the finisher
    await settle();
    app._onOrgasmHold(false);
    await settle();
    usePattern();
    app._onEdgeHold(true);
    await settle();
    const mark = h.sdk.calls.length;
    app._onOrgasmHold(true);                                // its engage needs no upload now
    await settle();
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:FIN.csv', 'hsspPlay']);
    app._onOrgasmHold(false);
    await settle();
  });

  it('X straight after Z\'s release: X waits for Z\'s Handy sequence and the main engine does not run under the finisher', async () => {
    await playAlpha();
    configureX();
    usePattern();
    app._onEdgeHold(true);
    await settle();
    const mark = h.sdk.calls.length;
    app._onEdgeHold(false);                                 // Z up
    app._onOrgasmHold(true);                                // X at once
    await settle();
    const legs = legsSince(mark);
    expect(legs.at(-2)).toBe('setScript:FIN.csv');
    expect(legs.at(-1)).toBe('hsspPlay');
    expect(legs[0]).toBe('hsspStop');
    expect(legs.filter((l) => l === 'setScript:A.csv')).toEqual([]);   // Z's restore skipped: X owns the Handy
    expect(engine._active).toBe(false);
    app._onOrgasmHold(false);
    await settle();
    expect(lastScript()).toBe('A.csv');
  });

  it('Z during X is refused: nothing is uploaded or set, the finisher plays on', async () => {
    await playAlpha();
    configureX();
    usePattern();
    app._onOrgasmHold(true);
    await settle();
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    await settle();
    expect(app._edgeActive).toBeFalsy();
    expect(app._edgeLoop.active).toBe(false);
    expect(legsSince(mark)).toEqual([]);
    expect(app.orgasmSwitch.active).toBe(true);
    app._onOrgasmHold(false);
    await settle();
  });
});

// ---------------------------------------------------------------------------
describe('a video change during a pattern hold stops every device (FN-01)', () => {
  it('the loop stops at once, the Handy stops and gets the new video\'s script, and Z is off', async () => {
    await playAlpha();
    usePattern();
    app._onEdgeHold(true);                                  // Z held
    await settle();
    const mark = h.sdk.calls.length;
    bp.sent.length = 0;
    const load = app._playFromLibrary(fileItem(B), { name: 'b.funscript', textContent: SCRIPT_B }, null, []);
    expect(app._edgeLoop.active).toBe(false);
    expect(app._edgeActive).toBe(false);
    expect(bp.sent.map((s) => s.kind)).toContain('stopAll');
    expect(tc.stop).toHaveBeenCalled();
    await load;
    await settle();
    const legs = legsSince(mark);
    expect(legs[0]).toBe('hsspStop');
    expect(legs).not.toContain('setScript:A.csv');          // no restore of the OLD script
    expect(legs).not.toContain('setScript:EDGE.csv');
    expect(lastScript()).toBe('B.csv');
    // The held Z key comes up later: nothing to restore, nothing restarts.
    syncs.log.length = 0;
    const before = h.sdk.calls.length;
    app._onEdgeHold(false);
    await settle();
    expect(legsSince(before)).toEqual([]);
    expect(syncs.log).toEqual([]);
    bp.sent.length = 0;
    tickEdge(5000);
    expect(bp.sent).toEqual([]);
  });

  it('a video change while the Handy engage is still in flight never plays the loop afterwards', async () => {
    await playAlpha();
    usePattern();
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);                                  // engage starts (upload in flight)
    await app._playFromLibrary(fileItem(B), { name: 'b.funscript', textContent: SCRIPT_B }, null, []);
    await settle(30);
    const legs = legsSince(mark);
    expect(legs).not.toContain('setScript:EDGE.csv');
    expect(lastScript()).toBe('B.csv');
  });

  it('a relaunch during a pattern hold stops the loop with every device', async () => {
    await playAlpha();
    usePattern();
    app._onEdgeHold(true);
    await settle();
    await app._stopForRelaunch();
    expect(app._edgeLoop.active).toBe(false);
    expect(app._edgeActive).toBe(false);
    expect(deviceRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix-up 2026-11-17 (review-1's blocker, TODO "Found while orgasm-edge"):
// nothing starts under this window's own PAUSED video. Every release (X held,
// Z "stop", Z "pattern") put the main script back and then forced an anchor
// (resync() plays whatever `paused` says), so the Handy stroked the video's
// script under a paused picture until the next play and pause.
describe('a release on a paused video leaves the Handy stopped (X, Z "stop", Z "pattern")', () => {
  it('Z "stop": the release sends nothing, and the next play anchors the main script', async () => {
    await playAlpha();
    video.pause();
    await settle();
    expect(deviceRunning()).toBe(false);
    app._onEdgeHold(true);
    await settle();
    const mark = h.sdk.calls.length;
    app._onEdgeHold(false);
    await settle(40);
    expect(legsSince(mark)).toEqual([]);
    expect(deviceRunning()).toBe(false);
    expect(engine._active).toBe(true);                      // listening for the next play
    video.play();
    await settle();
    expect(legsSince(mark)).toEqual(['hsspPlay']);
    expect(deviceRunning()).toBe(true);
  });

  it('Z "pattern": the loop stops, the main script is set back, and the device stays stopped', async () => {
    await playAlpha();
    video.pause();
    await settle();
    usePattern();
    app._onEdgeHold(true);
    await settle();
    expect(deviceRunning()).toBe(true);                     // the loop plays under the paused video (design Q5)
    const mark = h.sdk.calls.length;
    app._onEdgeHold(false);
    await settle(40);
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:A.csv']);
    expect(deviceRunning()).toBe(false);
    video.play();
    await settle();
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:A.csv', 'hsspPlay']);
    expect(deviceRunning()).toBe(true);
  });

  it('X held: the finisher stops, the main script is set back, and the device stays stopped', async () => {
    await playAlpha();
    configureX();
    video.pause();
    await settle();
    app._onOrgasmHold(true);
    await settle();
    expect(deviceRunning()).toBe(true);
    const mark = h.sdk.calls.length;
    app._onOrgasmHold(false);
    await settle(40);
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:A.csv']);
    expect(deviceRunning()).toBe(false);
  });

  it('a phone driving playback keeps the forced anchor: its proxy can read paused while it buffers', async () => {
    await playAlpha();
    usePattern();
    app._onEdgeHold(true);
    await settle();
    // The phone took playback over during the hold; its proxy still reads
    // paused (mid-buffer) while the phone plays.
    const proxy = new RemotePlaybackProxy();
    engine.player = proxy.asVideoPlayerWrapper();
    app._remoteActive = true;
    expect(proxy.paused).toBe(true);
    const mark = h.sdk.calls.length;
    app._onEdgeHold(false);
    await settle(40);
    expect(legsSince(mark)).toEqual(['hsspStop', 'setScript:A.csv', 'hsspPlay']);
  });

  it('a playing video still gets the forced anchor on release (unchanged)', async () => {
    await playAlpha();
    const mark = h.sdk.calls.length;
    app._onEdgeHold(true);
    await settle();
    app._onEdgeHold(false);
    await settle(40);
    expect(legsSince(mark)).toEqual(['hsspStop', 'hsspPlay']);
    expect(deviceRunning()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix-up 2026-11-17 (review-1's major): a Z press while a restore is still on
// its way. The restore's setScript can take seconds on the cloud; a press in
// that window used to leave the main SyncEngine running under the loop, so a
// seek sent hsspPlay at video time onto the loop and a pause stopped the
// Handy while the loop played on everywhere else.
describe('Z pressed while a restore is still on its way', () => {
  /** A seek and a pause during the hold: the Handy is sent nothing. */
  async function mainEngineIsQuiet() {
    const mark = h.sdk.calls.length;
    video.currentTime = 30;
    video.fire('seeked');
    await settle(20);
    video.pause();
    await settle(20);
    expect(legsSince(mark)).toEqual([]);
    expect(app._edgeLoop.active).toBe(true);
    expect(deviceRunning()).toBe(true);
  }

  it('a re-press during the last Z release\'s restore: the loop plays and the main engine is stopped', async () => {
    await playAlpha();
    usePattern();
    app._onEdgeHold(true);
    await settle();
    const held = h.sdk.hold('setScript');                   // the restore's setScript (main script) hangs
    app._onEdgeHold(false);
    await settle();
    app._onEdgeHold(true);                                  // pressed again meanwhile
    await settle();
    held.resolve({ result: 1 });
    await settle(40);
    expect(app._edgeLoop.active).toBe(true);
    expect(engine._active).toBe(false);
    expect(lastScript()).toBe('EDGE.csv');
    await mainEngineIsQuiet();
    app._onEdgeHold(false);
    await settle(40);
    expect(lastScript()).toBe('A.csv');
  });

  it('Z right after X\'s release, X\'s restore still on its way: Z waits for it, and the main engine is stopped', async () => {
    await playAlpha();
    configureX();
    usePattern();
    app._onOrgasmHold(true);
    await settle();
    const held = h.sdk.hold('setScript');                   // X's restore of the main script hangs
    app._onOrgasmHold(false);
    await settle();
    app._onEdgeHold(true);
    await settle();
    held.resolve({ result: 1 });
    await settle(40);
    expect(app._edgeLoop.active).toBe(true);
    expect(engine._active).toBe(false);
    expect(lastScript()).toBe('EDGE.csv');
    const scripts = h.sdk.calls.filter(([n]) => n === 'setScript').map(([, a]) => String(a).split('/').pop());
    expect(scripts.slice(-2)).toEqual(['A.csv', 'EDGE.csv']);   // X's restore first, then the loop
    await mainEngineIsQuiet();
    app._onEdgeHold(false);
    await settle(40);
  });
});

// ---------------------------------------------------------------------------
// Fix-up 2026-11-17 (TODO "Found while orgasm-edge", also in v0.9.2): Edge
// Hold never restarted the Autoblow. AutoblowSync.stop() forgets that the
// script is uploaded, so the release's start() sent nothing and the Autoblow
// sat out the rest of the video. The REAL AutoblowSync here, on a recording
// manager with the real AutoblowManager's method names.
describe('the Autoblow comes back after an Edge release', () => {
  let ab;
  let abSent;

  async function withRealAutoblow() {
    abSent = [];
    const manager = {
      connected: true,
      uploadScript: vi.fn(async () => true),
      syncStart: vi.fn(async (ms) => { abSent.push(`start@${Math.round(ms)}`); }),
      syncStop: vi.fn(async () => { abSent.push('stop'); }),
    };
    ab = new AutoblowSync({ videoPlayer: app.videoPlayer, autoblowManager: manager });
    expect(await ab.uploadScript(SCRIPT_A)).toBe(true);
    app.autoblowSync = ab;
    ab.start();
    abSent.length = 0;
  }

  afterEach(() => { ab?.stop(); ab = null; });

  it('the recording manager has the real AutoblowManager\'s methods', () => {
    for (const n of ['uploadScript', 'syncStart', 'syncStop']) {
      expect(typeof AutoblowManager.prototype[n], n).toBe('function');
    }
  });

  for (const mode of ['stop', 'pattern']) {
    it(`Z "${mode}": the Autoblow stops on the press and plays on from the current time on release`, async () => {
      await playAlpha();
      await withRealAutoblow();
      if (mode === 'pattern') usePattern();
      app._onEdgeHold(true);
      await settle();
      expect(abSent).toEqual(['stop']);
      video.currentTime = 7;
      app._onEdgeHold(false);
      await settle();
      expect(abSent).toEqual(['stop', 'start@7000']);
      expect(ab._active).toBe(true);
      // And it follows the video again: a pause stops it, a play starts it.
      video.pause();
      await settle();
      video.play();
      await settle();
      expect(abSent.slice(2)).toEqual(['stop', 'start@7000']);
    });

    it(`Z "${mode}" on a paused video: the release starts nothing; the next play does`, async () => {
      await playAlpha();
      await withRealAutoblow();
      video.pause();
      await settle();
      abSent.length = 0;
      if (mode === 'pattern') usePattern();
      app._onEdgeHold(true);
      await settle();
      app._onEdgeHold(false);
      await settle();
      expect(abSent.filter((s) => s.startsWith('start'))).toEqual([]);
      video.play();
      await settle();
      expect(abSent.at(-1)).toMatch(/^start@/);
    });
  }

  it('a video change during the hold: the old upload is not marked ready again', async () => {
    await playAlpha();
    await withRealAutoblow();
    app._onEdgeHold(true);                                  // "stop" mode
    await settle();
    app._videoLoadGen = (app._videoLoadGen || 0) + 1;       // another video loaded meanwhile
    app._onEdgeHold(false);
    await settle();
    expect(ab.scriptReady).toBe(false);
    expect(abSent.filter((s) => s.startsWith('start'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live fix-up 2026-11-17 (live verifier: Back to the library during a Z
// pattern hold stopped the Handy, but Buttplug played the edge loop on in the
// library until Z came up). Leaving the player tears playback down
// (_onLeaveView -> teardownPlayback, the REAL path: the mini player is off),
// and a loop on its own clock ends there with every device, as on a video
// change (FN-01). X's finisher had the same hole and ends the same way (its
// finish stop, as on a relaunch).
describe('leaving the player during a hold stops every device', () => {
  it('Back during a Z pattern hold: the loop stops with every device, Z is off, and the late key-up restarts nothing', async () => {
    await playAlpha();
    usePattern();
    app._onEdgeHold(true);                                  // Z held
    await settle();
    expect(app._edgeLoop.active).toBe(true);
    bp.sent.length = 0;
    app._onLeaveView('player');                             // Back
    expect(app._edgeLoop.active).toBe(false);
    expect(app._edgeActive).toBe(false);
    expect(bp.sent.map((s) => s.kind)).toContain('stopAll');
    await settle();
    expect(deviceRunning()).toBe(false);
    bp.sent.length = 0;
    tc.sent.length = 0;
    tickEdge(5000);                                         // the loop's next tick sends nothing
    expect(bp.sent).toEqual([]);
    expect(tc.sent).toEqual([]);
    syncs.log.length = 0;
    const before = h.sdk.calls.length;
    app._onEdgeHold(false);                                 // Z comes up in the library
    await settle();
    expect(legsSince(before)).toEqual([]);
    expect(syncs.log).toEqual([]);
  });

  it('Back during an X hold: the finisher stops with every device, and the late key-up restarts nothing', async () => {
    await playAlpha();
    configureX();
    app._onOrgasmHold(true);                                // X held
    await settle();
    expect(app.orgasmSwitch.active).toBe(true);
    app._onLeaveView('player');                             // Back
    expect(app.orgasmSwitch.active).toBe(false);
    await settle();
    expect(deviceRunning()).toBe(false);
    bp.sent.length = 0;
    tc.sent.length = 0;
    clock = 5000;
    app.orgasmSwitch._tick();                               // the finisher's next tick sends nothing
    expect(bp.sent).toEqual([]);
    expect(tc.sent).toEqual([]);
    syncs.log.length = 0;
    const before = h.sdk.calls.length;
    app._onOrgasmHold(false);                               // X comes up in the library
    await settle();
    expect(legsSince(before)).toEqual([]);
    expect(syncs.log).toEqual([]);
  });

  it('Z "stop": Back during a hold leaves the Handy stopped, and the late key-up plays nothing (unchanged)', async () => {
    await playAlpha();
    app._onEdgeHold(true);
    await settle();
    app._onLeaveView('player');
    await settle();
    expect(deviceRunning()).toBe(false);
    const before = h.sdk.calls.length;
    app._onEdgeHold(false);
    await settle();
    expect(legsSince(before)).toEqual([]);
    expect(deviceRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dave's answers (2026-11-17, evening; follow-oe): an ending plays once and
// then holds; a flywheel machine follows the Edge pattern; no pattern
// chosen behaves as "stop" (the 'unknown id' test above).
describe('Z with an ending, and a flywheel machine on Z', () => {
  const END = { ...EDGE_PATTERN_DEFAULTS, id: 'last-stroke-then-still' };

  it('an ending plays once from the press, then holds its last position; the Handy gets it untiled; release restores as for any pattern', async () => {
    h.names.set(holdFinisherEnd(buildPatternSourceContent(END)), 'END');   // what the Handy gets: the ending, its end held
    await playAlpha();
    usePattern({ id: END.id });
    const mark = h.sdk.calls.length;
    bp.sent.length = 0;
    tc.sent.length = 0;
    clock = 1000;
    app._onEdgeHold(true);
    expect(app._edgeLoop.active).toBe(true);
    expect(app._edgeLoop.once).toBe(true);
    const actions = edgeLoopActions(END);
    const end = actions.at(-1).at;
    for (let t = 40; t <= end + 3000; t += 40) tickEdge(1000 + t);
    const last = actions.at(-1).pos;
    expect(app._edgeLoop.livePosition).toBeCloseTo(last, 6);
    expect(bp.sent.filter((s) => s.kind === 'linear').at(-1).pos).toBeCloseTo(last, 6);
    expect(tc.sent.map((a) => a.L0).filter((v) => v !== undefined).at(-1)).toBeCloseTo(last, 6);
    await settle();
    // One play, not tiled, its last position held while Z is (2026-11-20:
    // a Handy at the END of an HSSP script went to the last point's raw
    // position, under the stroke zone; holdFinisherEnd).
    expect(h.uploads.at(-1)).toBe(holdFinisherEnd(buildPatternSourceContent(END)));
    const upActs = JSON.parse(h.uploads.at(-1)).actions;
    const endActs = JSON.parse(buildPatternSourceContent(END)).actions;
    expect(upActs).toHaveLength(endActs.length + 1);
    expect(upActs.at(-1)).toEqual({ ...endActs.at(-1), at: endActs.at(-1).at + HOLD_END_MS });
    expect(legsSince(mark)).toEqual(['setScript:END.csv', 'hsspPlay']);
    expect(app._edgeCloudUrlKey.startsWith(`once-v1|${patternSourceKey(END)}|`)).toBe(true);
    app._onEdgeHold(false);
    expect(app._edgeLoop.active).toBe(false);
    expect(bp.stopSustainedOutputs).toHaveBeenCalled();
    await settle();
    expect(legsSince(mark)).toEqual(['setScript:END.csv', 'hsspPlay', 'hsspStop', 'setScript:A.csv', 'hsspPlay']);
  });

  function addMachine() {
    bp.devices.push({ index: 2, name: 'Machine', canOscillate: true });
    bp.sendOscillate = vi.fn((i, v) => { bp.sent.push({ kind: 'oscillate', i, v }); });
    // The app's engine is a recording fake here; its oscillate path is the
    // REAL ButtplugSync's (refused while the engine plays, as the real one).
    const real = new ButtplugSync({ videoPlayer: { paused: true }, buttplugManager: bp, funscriptEngine: null });
    real.setRampUp(2, false);
    syncs.buttplug.oscillateNow = (...a) => { real._active = syncs.buttplug._active; return real.oscillateNow(...a); };
  }
  const oscillates = () => bp.sent.filter((s) => s.kind === 'oscillate');

  it('a flywheel machine follows the Edge pattern; the release zeroes it before the engines restart', async () => {
    await playAlpha();
    addMachine();
    usePattern();
    bp.sent.length = 0;
    app._onEdgeHold(true);
    for (let t = 40; t <= 3000; t += 40) tickEdge(t);
    const speeds = oscillates().map((s) => s.v);
    expect(speeds.length).toBeGreaterThan(20);
    expect(Math.max(...speeds)).toBeGreaterThan(5);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(70);                 // the engine's default Max cap
    bp.sent.length = 0;
    app._onEdgeHold(false);
    expect(bp.sent.map((s) => s.kind)).toEqual(['stopSustained']);
    expect(syncs.log.slice(-3)).toEqual(['buttplug.start', 'tcode.start', 'autoblow.start']);
    tickEdge(4000);
    expect(oscillates()).toEqual([]);
    await settle();
  });

  it('"stop" mode leaves the machine stopped, as before', async () => {
    await playAlpha();
    addMachine();
    app._settingsMap.set('player.edgeHoldAction', 'stop');
    bp.sent.length = 0;
    app._onEdgeHold(true);
    for (let t = 40; t <= 1000; t += 40) tickEdge(t);
    expect(oscillates()).toEqual([]);
    expect(bp.sent.map((s) => s.kind)).toContain('stopSustained');
    app._onEdgeHold(false);
    await settle();
  });

  it('a video change during the hold (FN-01): the machine stops with every device and nothing drives it after', async () => {
    await playAlpha();
    addMachine();
    usePattern();
    app._onEdgeHold(true);
    for (let t = 40; t <= 1000; t += 40) tickEdge(t);
    expect(oscillates().length).toBeGreaterThan(5);
    bp.sent.length = 0;
    const load = app._playFromLibrary(fileItem(B), { name: 'b.funscript', textContent: SCRIPT_B }, null, []);
    expect(app._edgeLoop.active).toBe(false);
    expect(bp.sent.map((s) => s.kind)).toEqual(expect.arrayContaining(['stopAll', 'stopSustained']));
    await load;
    await settle();
    bp.sent.length = 0;
    tickEdge(5000);
    app._onEdgeHold(false);
    expect(oscillates()).toEqual([]);
  });
});
