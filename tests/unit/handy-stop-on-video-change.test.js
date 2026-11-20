/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FN-01 / FT-115 (also in v0.9.2): any video change stops every device at
// once, including a change to a video with no script.
//
// N run verify-2, 2026-11-16: Long Clip playing with the Handy, then O + a
// video with no funscript: no hsspStop, and the Handy kept stroking the old
// script (also drag-drop, queue Next, Up Next, Play All). loadVideo called
// syncEngine.stop(), which sends nothing, and a source swap fires no
// `pause`. With a script on the new video the old one played on until the
// new upload landed (FT-115); without one, for as long as the user cared to
// watch.
//
// What runs is REAL: app.js's load path (helpers/handy-load-app.js), the
// REAL HandyManager (its HSSP chain, stop pre-emption, upload ordering) and
// the REAL SyncEngine, on a fake SDK that keeps the real SDK's local rules
// (helpers/fake-handy-sdk.js). The device is replayed from the commands the
// SDK was sent: after an hsspPlay leg it runs, after an hsspStop leg it
// stands. Nothing reaches the cloud; the key is the fake TESTKEY01.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, names: new Map() }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  // A cloud upload: a round trip, then a URL naming the script.
  uploadDataToServer: async (content) => {
    await new Promise((r) => setTimeout(r, 0));
    return `https://scripts.local/${h.names.get(content) || 'unknown'}.csv`;
  },
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';

const SCRIPT_A = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 600, pos: 90 }] });
const SCRIPT_B = JSON.stringify({ actions: [{ at: 0, pos: 90 }, { at: 400, pos: 10 }] });
h.names.set(SCRIPT_A, 'A');
h.names.set(SCRIPT_B, 'B');
const A = 'C:\\Lib\\Alpha.mp4';
const B = 'C:\\Lib\\Bravo.mp4';

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let Lifted;
let app;
let video;
let manager;
let engine;
let script;   // what the funscript engine holds now

beforeAll(() => {
  Lifted = makeLoadAppClass({ extra: ['_uploadAndStartSync', '_tryStartAutoblowSync'] });
});

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();   // no 10 s poll in a unit test
  // This fake SDK has no per-name throttle (throttleMs 0), so there is no
  // window for the manager to keep a play / stop out of (block F review fix;
  // pinned with the real 200 ms window in handy-sdk-throttle-stop-wins.test.js).
  // Left on, a stop right after another waited 220 ms of real time and the
  // checks below, made a few ms after the change, raced it.
  manager._hsspSpacingMs = 0;
  ({ app, video } = buildLoadApp(Lifted, { handyManager: manager }));
  script = null;
  app.funscriptEngine = { clear() {}, get isLoaded() { return !!script; }, getRawContent: () => script };
  engine = new SyncEngine({ videoPlayer: app.videoPlayer, handyManager: manager, funscriptEngine: app.funscriptEngine });
  app.syncEngine = engine;
  // A script load runs the app's real Handy upload, as loadFunscript does.
  app.loadFunscript = vi.fn(async (fs) => {
    script = fs.textContent;
    await app._uploadAndStartSync();
  });
});

afterEach(() => {
  engine.stop();
  manager._stopHealthCheck();
});

/** HSSP commands the device took, in order (plays and stops only). */
const hssp = () => h.sdk.calls.filter(([n]) => n === 'hsspPlay' || n === 'hsspStop').map(([n]) => n);
const deviceRunning = () => hssp().at(-1) === 'hsspPlay';
const legsSince = (i) => h.sdk.calls.slice(i).map(([n, arg]) => (n === 'setScript' ? `setScript:${arg.split('/').pop()}` : n));

/** Alpha open and playing with its script on the Handy. */
async function playAlpha() {
  await app._playFromLibrary(fileItem(A), { name: 'a.funscript', textContent: SCRIPT_A }, null, []);
  video.fire('loadeddata');
  await vi.waitFor(() => expect(engine._scriptReady).toBe(true));
  video.play();
  await settle();
  expect(deviceRunning(), 'Alpha plays on the Handy').toBe(true);
}

describe('a video change stops the Handy at once (FN-01 / FT-115)', () => {
  it('to a video with NO script: the device stops and nothing starts it again', async () => {
    await playAlpha();
    const mark = h.sdk.calls.length;

    await app._playFromLibrary(fileItem(B), null, null, []);
    await settle();
    expect(legsSince(mark)).toContain('hsspStop');
    expect(deviceRunning()).toBe(false);

    // Bravo loads and the user presses Play: the old script must not come back.
    video.fire('loadeddata');
    video.play();
    await settle();
    expect(legsSince(mark)).not.toContain('hsspPlay');
    expect(deviceRunning()).toBe(false);
  });

  it('a Play All advance to a video with no script stops it too', async () => {
    await playAlpha();
    app._playQueue = [{ ...fileItem(A), funscriptPath: null }, { ...fileItem(B), funscriptPath: null }];
    app._playQueueIndex = 0;
    const mark = h.sdk.calls.length;

    app._playQueueItem(1);
    await settle();
    video.fire('loadeddata');   // Play All autoplays
    await settle();
    expect(legsSince(mark)).toContain('hsspStop');
    expect(legsSince(mark)).not.toContain('hsspPlay');
    expect(deviceRunning()).toBe(false);
  });

  it('to a video WITH a script: the stop goes before the new setScript, and the new script plays', async () => {
    await playAlpha();
    const mark = h.sdk.calls.length;

    await app._playFromLibrary(fileItem(B), { name: 'b.funscript', textContent: SCRIPT_B }, null, []);
    await vi.waitFor(() => expect(legsSince(mark)).toContain('setScript:B.csv'));
    const legs = legsSince(mark);
    expect(legs.indexOf('hsspStop')).toBeGreaterThan(-1);
    expect(legs.indexOf('hsspStop')).toBeLessThan(legs.indexOf('setScript:B.csv'));
    expect(deviceRunning()).toBe(false);   // stopped until Bravo plays

    video.fire('loadeddata');
    video.play();
    await settle();
    expect(deviceRunning()).toBe(true);
  });

  it('nothing is sent when the device was already stopped (a paused video)', async () => {
    await playAlpha();
    video.pause();
    await settle();
    const stops = h.sdk.sent('hsspStop').length;
    await app._playFromLibrary(fileItem(B), null, null, []);
    await settle();
    expect(h.sdk.sent('hsspStop').length).toBe(stops);
  });

  it('a play still in flight at the change is stopped again when it lands (a stop always wins)', async () => {
    await playAlpha();
    video.pause();
    await settle();
    // Play again; the cloud holds the answer (a slow round trip).
    const held = h.sdk.hold('hsspPlay');
    video.play();
    await settle();
    expect(h.sdk.sent('hsspPlay').length).toBe(2);

    await app._playFromLibrary(fileItem(B), null, null, []);
    await settle();
    const stops = h.sdk.sent('hsspStop').length;
    // The play answers after the change's stop: the device may have taken
    // it last, so the stop has to be asserted again.
    held.resolve({ result: 0 });
    await settle();
    expect(h.sdk.sent('hsspStop').length).toBe(stops + 1);
    expect(deviceRunning()).toBe(false);
  });
});

describe('the player pop-out (FN-01)', () => {
  async function popOutPlayingAlpha() {
    await playAlpha();
    app._activatePlayerWindow();   // the take-over: the pop-out owns playback
    expect(app._playerWindowActive).toBe(true);
    app._playerWinProxy.updateState({ paused: false, at: 4000 });
    await settle();
    expect(deviceRunning(), 'Alpha plays on the Handy from the pop-out').toBe(true);
  }

  it('a video with no script opened into the pop-out never plays the old script', async () => {
    await popOutPlayingAlpha();
    const mark = h.sdk.calls.length;

    await app._playFromLibrary(fileItem(B), null, null, []);
    await settle();
    // The pop-out loads Bravo and plays it.
    app._playerWinProxy.updateState({ paused: false, at: 0 });
    await settle();
    expect(legsSince(mark)).not.toContain('hsspPlay');
    expect(deviceRunning()).toBe(false);
  });

  it('the same video opened again (its script already on the device) leaves the device stopped when it loads paused', async () => {
    await popOutPlayingAlpha();

    await app._playFromLibrary(fileItem(A), { name: 'a.funscript', textContent: SCRIPT_A }, null, []);
    await settle();
    expect(deviceRunning()).toBe(false);
  });
});

describe('Buttplug, T-Code and the Autoblow stop on a video change too', () => {
  it('each engine\'s own stop() reaches its device (stopAll / stop / syncStop)', async () => {
    const actions = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }];
    const fsEngine = { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions };
    const buttplugManager = {
      connected: true, devices: [],
      sendLinear: vi.fn(), sendVibrate: vi.fn(), sendRotate: vi.fn(), sendScalar: vi.fn(), sendOscillate: vi.fn(),
      stopAll: vi.fn(async () => {}),
    };
    const tcodeManager = { connected: true, stop: vi.fn(), sendMove: vi.fn(), sendAxisMove: vi.fn() };
    const autoblowManager = { connected: true, syncStop: vi.fn(async () => true), syncStart: vi.fn(async () => true) };
    app.buttplugSync = new ButtplugSync({ videoPlayer: app.videoPlayer, buttplugManager, funscriptEngine: fsEngine });
    app.tcodeSync = new TCodeSync({ videoPlayer: app.videoPlayer, tcodeManager, funscriptEngine: fsEngine });
    app.autoblowSync = new AutoblowSync({ videoPlayer: app.videoPlayer, autoblowManager });
    for (const e of [app.buttplugSync, app.tcodeSync, app.autoblowSync]) e.start();
    buttplugManager.stopAll.mockClear();
    tcodeManager.stop.mockClear();
    autoblowManager.syncStop.mockClear();

    app.loadVideo(fileItem(B), { autoPlay: false, skipViewSwitch: true });

    expect(buttplugManager.stopAll).toHaveBeenCalled();
    expect(tcodeManager.stop).toHaveBeenCalled();
    expect(autoblowManager.syncStop).toHaveBeenCalled();
    app.buttplugSync.stop(); app.tcodeSync.stop();
  });

  it('an Autoblow upload that lands after the change does not start the old script on the new video', async () => {
    let finish;
    const autoblowManager = {
      connected: true,
      syncStop: vi.fn(async () => true),
      syncStart: vi.fn(async () => true),
      uploadScript: vi.fn(() => new Promise((r) => { finish = r; })),
    };
    app.autoblowManager = autoblowManager;
    app.autoblowSync = new AutoblowSync({ videoPlayer: app.videoPlayer, autoblowManager });
    app.loadVideo(fileItem(A), { autoPlay: false, skipViewSwitch: true });
    script = SCRIPT_A;
    const upload = app._tryStartAutoblowSync();
    await settle();

    app.loadVideo(fileItem(B), { autoPlay: false, skipViewSwitch: true });   // no script
    script = null;
    finish(true);
    await upload;
    video.fire('loadeddata');
    video.play();
    await settle();

    expect(app.autoblowSync._active).toBe(false);
    expect(app.autoblowSync.scriptReady).toBe(false);
    expect(autoblowManager.syncStart).not.toHaveBeenCalled();
  });
});
