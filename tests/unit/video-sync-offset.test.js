// Per-video sync offset (Pudknocker #380: "HereSphere sync timing varies per
// file"), C5 of the 2026-11-04 small features.
//
// `library.syncOffsets[path]` is a delta added on top of every device's own
// offset while that video plays. What is asserted is what each device ends up
// scheduling with: the HSTP offset the (mocked) Handy SDK is sent, the offset
// the (stubbed) Autoblow IPC is sent, and the clock the REAL Buttplug and
// T-Code engines schedule against, including a T-Code position actually sent.
// The app.js paths are the REAL methods lifted out of app.js (loadVideo, the
// VR and phone handlers and their teardowns), run against real devices.
//
// jsdom (no docblock): ConnectionPanel, the VR modal and the row build DOM,
// and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
// environments"). No hardware and no real key: the Handy SDK is mocked at
// the path handy-manager.js imports, as handy-manager.test.js does.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const mockHandy = {
  connect: vi.fn().mockResolvedValue({ result: 1 }),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  getClientServerLatency: vi.fn().mockReturnValue({ avgOffset: 10, avgRtd: 50, lastSyncTime: Date.now() }),
  getState: vi.fn().mockReturnValue({ info: { fwVersion: '3.2.0' }, mode: 1, hssp: { scriptSet: true } }),
  setScript: vi.fn().mockResolvedValue({ result: 1 }),
  hsspPlay: vi.fn().mockResolvedValue({ result: 0 }),
  hsspStop: vi.fn().mockResolvedValue(undefined),
  setOffset: vi.fn().mockResolvedValue(undefined),
  getOffset: vi.fn().mockResolvedValue({ offset: 0 }),
  setStrokeZone: vi.fn().mockResolvedValue(undefined),
  setMode: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  API: { get: { connected: vi.fn().mockResolvedValue({ connected: true }) } },
};
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: vi.fn(() => mockHandy),
  getEstimatedServerTime: vi.fn(() => Date.now()),
  uploadDataToServer: vi.fn().mockResolvedValue('https://example.invalid/never-used'),
}));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { VRPlaybackProxy } from '../../renderer/js/vr-playback-proxy.js';
import { Library } from '../../renderer/components/library.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { openVRModal } from '../../renderer/components/vr-modal.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { pickRehomeCandidate } from '../../renderer/js/association-rehome.js';
import { vrDisplayName, funsyncVideoIdFromVRPath } from '../../renderer/js/vr-bridge.js';
import { normalizeAssociation, resolveActiveConfig } from '../../renderer/js/association-shape.js';
import { invertRawScriptContent } from '../../renderer/js/device-transform-stack.js';
import { pathToFileURL } from '../../renderer/js/path-utils.js';
import { SOURCE_PLAYER } from '../../renderer/js/audience-bridge.js';
import {
  clampVideoSyncOffset, videoSyncOffsetOf, withVideoSyncOffset, formatVideoSyncOffset,
  VIDEO_SYNC_OFFSET_STEP_MS,
} from '../../renderer/js/video-sync-offset.js';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';

const require_ = createRequire(import.meta.url);
const { DEFAULTS } = require_('../../electron/store.js');
const { stripBlacklist } = require_('../../electron/data-backup.js');
const { mergeConfig } = require_('../../electron/data-export.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const A = 'C:\\Videos\\scene-a.mp4';
const B = 'C:\\Videos\\scene-b.mp4';
const VR_LOCAL = 'C:\\VR\\heresphere-scene.mp4';

const METHODS = [
  'loadVideo', '_onVRVideoChanged', '_stopVRSync', '_onRemotePhoneConnected', '_onRemotePhoneDisconnected',
  '_videoSyncOffsetPath', '_videoSyncOffsetFor', '_applyVideoSyncOffset', '_settleVRVideoSyncOffset', '_videoSyncOffsetState',
  '_vrVideoSyncOffsetState', '_setVideoSyncOffset', '_planLazyRehome',
  // FT-017: the row shows only while a video plays here, so the view is real.
  '_videoSyncOffsetLive', '_currentView',
];

const quiet = { log() {}, warn() {}, error() {}, debug() {} };
const fakeDocument = { getElementById: () => ({ hidden: false, innerHTML: '', textContent: '', dataset: {} }) };

/** The `window` the lifted methods see; a VR test gives it a script to read. */
const liftedWindow = { funsync: { readFunscript: async () => null } };

const LiftedApp = liftAppClass(METHODS, {
  window: liftedWindow,
  document: fakeDocument,
  console: quiet,
  showToast: () => ({ dismiss() {} }),
  t: (k) => k,
  URL,
  pathToFileURL,
  maybeShowHevcGuidance: () => {},
  isAutoMatch: () => false,
  vrDisplayName,
  funsyncVideoIdFromVRPath,
  normalizeAssociation,
  resolveActiveConfig,
  invertRawScriptContent,
  SOURCE_PLAYER,
  eventBus,
  videoSyncOffsetOf,
  withVideoSyncOffset,
  pickRehomeCandidate,
});

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 120; }
  pause() { this.paused = true; }
}

function fakeSettings(initial = {}) {
  const store = { ...initial };
  return { store, get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }), addRecentFile() {}, getAll: () => ({}) };
}

/** A real Library with no scan behind it, the shape absence-sibling-guards uses. */
function makeLibrary({ videos = [], unavailable = [], scannedRoots = [] } = {}) {
  const lib = Object.create(Library.prototype);
  lib._settings = fakeSettings();
  lib._videos = videos.map((p) => ({ path: p, name: p.split('\\').pop() }));
  lib._unavailablePaths = new Set(unavailable);
  lib._failedScanPaths = new Set();
  lib._scannedSourceRoots = scannedRoots;
  return lib;
}

const tcodeDevice = () => ({ connected: true, sendAxes: vi.fn(), stop: vi.fn(), send: vi.fn() });
const SCRIPT = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }, { at: 3000, pos: 100 }];

async function connectedHandy() {
  const handy = new HandyManager();
  await handy.init();
  await handy.connect('not-a-real-key');
  return handy;
}

async function connectedAutoblow() {
  window.funsync.autoblowConnect.mockResolvedValueOnce({ success: true, deviceType: 'autoblow-ultra', deviceInfo: {} });
  const ab = new AutoblowManager();
  await ab.connect('not-a-real-token');
  return ab;
}

/** The offset an engine schedules with: real time minus the time it uses. */
const engineOffset = (engine) => Math.round(engine.player.currentTime * 1000 - engine._currentTimeMs());
const handySent = () => mockHandy.setOffset.mock.calls.map((c) => c[0]);
const autoblowSent = () => window.funsync.autoblowSyncOffset.mock.calls.map((c) => c[0]);

/**
 * The app with the REAL lifted methods and real devices. Globals: Handy 50,
 * Buttplug -80, T-Code -20, Autoblow 120, VR -100 (all user-tuned values).
 */
async function build({ offsets, library, extraSettings = {} } = {}) {
  const settings = fakeSettings({
    'handy.defaultOffset': 50,
    'buttplug.defaultOffset': -80,
    'tcode.defaultOffset': -20,
    'autoblow.offset': 120,
    'vr.offset': -100,
    'library.associations': {},
    ...(offsets !== undefined ? { 'library.syncOffsets': offsets } : {}),
    ...extraSettings,
  });
  const video = new FakeVideo();
  const videoPlayer = { video, currentTime: 0, paused: true, duration: 120, loadSource() {}, clearSubtitles() {} };
  const engPlayer = () => ({ video: { addEventListener() {}, removeEventListener() {} }, currentTime: 0, paused: true, duration: 120 });
  const buttplugSync = new ButtplugSync({
    videoPlayer: engPlayer(),
    buttplugManager: { connected: true, devices: [], stopAll() {} },
    funscriptEngine: { isLoaded: true, getActions: () => SCRIPT },
  });
  const tcode = tcodeDevice();
  const tcodeSync = new TCodeSync({
    videoPlayer: engPlayer(), tcodeManager: tcode, funscriptEngine: { isLoaded: true, getActions: () => SCRIPT },
  });
  // Boot, as app.js init() does: each engine gets its saved global.
  buttplugSync.setOffsetMs(settings.get('buttplug.defaultOffset'));
  tcodeSync.setOffsetMs(settings.get('tcode.defaultOffset'));
  const handyManager = await connectedHandy();
  await handyManager.setOffset(settings.get('handy.defaultOffset'));   // _onHandyConnected
  const autoblowManager = await connectedAutoblow();
  mockHandy.setOffset.mockClear();
  window.funsync.autoblowSyncOffset.mockClear();

  const app = Object.assign(new LiftedApp(), {
    settings, videoPlayer, buttplugSync, tcodeSync, handyManager, autoblowManager,
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {} },
    funscriptEngine: { isLoaded: true, clear() {}, getActions: () => [], async loadContent() {} },
    library: library || null,
    syncEngine: null, handyHdspSync: null, autoblowSync: null, buttplugManager: null,
    scriptEditor: null, remoteBridge: { connected: false, sendToPhone() {} }, sessionTracker: null,
    audienceBridge: null, connectionPanel: null, orgasmSwitch: null,
    vrBridge: { proxy: new VRPlaybackProxy(), connected: false },
    _videoLoadGen: 0, _pendingFunscripts: [], _currentVideoPath: null,
    _videoSyncOffsetMs: 0, _vrSyncOffsetPath: null, _vrSyncOffsetActive: false,
    _phoneSyncOffsetPath: null, _phoneSyncOffsetActive: false,
    _remoteActive: false, _remotePhoneEpoch: 0, _vrPlayerRef: null,
    // Called by the lifted methods; not under test.
    _maybePushCurrentToHistory() {}, _ensureVideoLoadWatch() {}, _disarmLoadAutoplay() {},
    _stopGapSkip() {}, _clearCloudUploadGate() {}, _hideScriptLoadingOverlay() {}, _feedInlineViz() {},
    // Moves the nav stack as the real one does (loadVideo opens the player view).
    _navStack: ['library'],
    _navigateTo(view) { this._navStack = view === 'player' ? [...this._navStack, view] : [view]; },
    _updateCategoryDots() {}, _updateQueuePanelState() {}, _applyVRFlattenForCurrent() {},
    _autoMatchEroScripts() {}, _resetCustomRoutingState() {}, _refreshLoopVideoVisibility() {},
    _handyInverted() { return false; }, _pushRemoteDeviceStatus() {},
  });
  app.vrBridge.proxy.setOffset(settings.get('vr.offset'));
  app.vrBridge.proxy._trackerHooked = true;   // no session-tracker poll in a test
  // The VR takeover uploads the headset's script; a stub, nothing leaves the test.
  handyManager.uploadAndSetScript = vi.fn(async () => true);
  return { app, settings, buttplugSync, tcodeSync, tcode, handyManager, autoblowManager };
}

/**
 * The headset reports videos the library matches: `scripted` ones have a
 * funscript (the headset's script then drives the devices), the rest do not.
 */
function vrLibrary(videos, { scripted = [] } = {}) {
  const library = makeLibrary({ videos });
  library.ensureScanned = async () => {};
  library.resolveVRVideo = async (_name, raw) => {
    const path = videos.find((p) => raw.endsWith(p.split('\\').pop()));
    if (!path) return null;
    const hasFunscript = scripted.includes(path);
    return { path, name: path.split('\\').pop(), hasFunscript, funscriptPath: hasFunscript ? path.replace(/\.mp4$/, '.funscript') : null };
  };
  liftedWindow.funsync.readFunscript = async () => JSON.stringify({ actions: SCRIPT });
  return library;
}
const headset = (app, path) => app._onVRVideoChanged(path.split('\\').pop(), `http://192.168.1.20:5123/heresphere/stream/${path.split('\\').pop()}`);

const open = (app, path) => app.loadVideo({ name: path.split('\\').pop(), path, _isPathBased: true }, { autoPlay: false });

/**
 * Every device's effective offset right now, in that device's own units.
 * The Autoblow's runs the other way (its API adds it to the script time, so
 * positive is earlier there): a delta goes into it negated.
 */
function effective({ buttplugSync, tcodeSync, handyManager, autoblowManager }) {
  return {
    buttplug: engineOffset(buttplugSync),
    tcode: engineOffset(tcodeSync),
    handy: handyManager._globalOffsetMs - handyManager._videoOffsetMs,
    autoblow: autoblowManager._globalOffsetMs - autoblowManager._videoOffsetMs,
  };
}
const GLOBALS = { buttplug: -80, tcode: -20, handy: 50, autoblow: 120 };
/** Every device moved by a delta of `d` (negative = earlier on every one). */
const plus = (d) => Object.fromEntries(Object.entries(GLOBALS).map(([k, v]) => [k, k === 'autoblow' || k === 'handy' ? v - d : v + d]));

beforeEach(() => {
  vi.clearAllMocks();
  liftedWindow.funsync.readFunscript = async () => null;
  _setBundlesForTests('en', EN, EN);
});
afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
});
afterAll(() => _setBundlesForTests('en', EN, EN));

// ---------------------------------------------------------------------------
describe('the stored value', () => {
  it('reads 0 for a missing entry, a missing map and junk, and clamps to ±1000 ms', () => {
    expect(videoSyncOffsetOf(undefined, A)).toBe(0);
    expect(videoSyncOffsetOf({}, A)).toBe(0);
    expect(videoSyncOffsetOf({ [A]: 'abc' }, A)).toBe(0);
    expect(videoSyncOffsetOf({ [A]: 40 }, A)).toBe(40);
    expect(clampVideoSyncOffset(5000)).toBe(1000);
    expect(clampVideoSyncOffset(-5000)).toBe(-1000);
    expect(Object.is(clampVideoSyncOffset(-0.2), 0)).toBe(true);
    expect(formatVideoSyncOffset(20)).toBe('+20 ms');
    expect(formatVideoSyncOffset(-30)).toBe('-30 ms');
  });

  it('writing one video never touches another entry, and a Reset stores 0 rather than deleting', () => {
    const map = { [A]: 40, [B]: -20 };
    expect(withVideoSyncOffset(map, A, 0)).toEqual({ [A]: 0, [B]: -20 });
    expect(map).toEqual({ [A]: 40, [B]: -20 }); // a copy, the input is untouched
  });

  it('the store default is an empty map (no video has a delta: today)', () => {
    expect(DEFAULTS.settings.library.syncOffsets).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe('each device gets its own offset plus the video delta', () => {
  it('Buttplug and T-Code schedule at real time minus (global + delta); setting the global keeps the delta', () => {
    const player = { video: { addEventListener() {}, removeEventListener() {} }, currentTime: 10, paused: true, duration: 60 };
    const bp = new ButtplugSync({ videoPlayer: player, buttplugManager: { connected: true }, funscriptEngine: { isLoaded: true, getActions: () => SCRIPT } });
    const tc = new TCodeSync({ videoPlayer: player, tcodeManager: tcodeDevice(), funscriptEngine: { isLoaded: true, getActions: () => SCRIPT } });
    for (const eng of [bp, tc]) {
      eng.setOffsetMs(-80);
      expect(eng._currentTimeMs()).toBe(10080);           // no delta: exactly today
      eng.setVideoOffsetMs(-30);
      expect(eng._currentTimeMs()).toBe(10110);
      eng.setOffsetMs(-50);                                // the global slider moves
      expect(eng._currentTimeMs()).toBe(10080);           // -50 + -30
      expect(eng.getOffsetMs()).toBe(-50);                 // still reports the GLOBAL
      eng.setVideoOffsetMs(0);
      expect(eng._currentTimeMs()).toBe(10050);
    }
  });

  it('T-Code sends the position at the shifted time (a -200 ms delta plays 200 ms ahead)', () => {
    const send = (delta) => {
      const tcode = tcodeDevice();
      const sync = new TCodeSync({
        videoPlayer: { video: { addEventListener() {}, removeEventListener() {} }, currentTime: 0.3, paused: false, duration: 60 },
        tcodeManager: tcode,
        funscriptEngine: { isLoaded: true, getActions: () => SCRIPT },
      });
      sync.setVideoOffsetMs(delta);
      sync.start();
      sync._tick();
      sync.stop();
      return tcode.sendAxes.mock.calls[0][0].L0;
    };
    expect(send(0)).toBeCloseTo(30, 5);      // 300 ms into a 0→100 stroke over 1 s
    expect(send(-200)).toBeCloseTo(50, 5);   // as if at 500 ms
  });

  it('the Handy gets global - delta (positive HSTP offset is earlier, measured on hardware), once per change, and a reconnect re-sends both', async () => {
    const handy = await connectedHandy();
    await handy.setOffset(50);
    expect(handySent()).toEqual([50]);                    // no delta: exactly today
    await handy.setVideoOffset(30, 50);
    expect(handySent()).toEqual([50, 20]);                // 50 - 30: 30 ms later
    await handy.setVideoOffset(30, 50);                   // unchanged: no API call
    expect(handySent()).toEqual([50, 20]);
    await handy.setOffset(60);                             // the global slider
    expect(handySent()).toEqual([50, 20, 30]);
    await handy.setVideoOffset(0, 60);                     // the next video has none
    expect(handySent()).toEqual([50, 20, 30, 60]);
  });

  it('a disconnected Handy keeps the delta for the global the next connect sends', async () => {
    const handy = new HandyManager();
    await handy.init();
    await handy.setVideoOffset(-40, 50);
    expect(handySent()).toEqual([]);
    await handy.connect('not-a-real-key');
    await handy.setOffset(50);                             // what every connect does
    expect(handySent()).toEqual([90]);                     // 50 + 40
  });

  it('the Autoblow gets global - delta (positive is earlier there); a connect sends nothing without a delta (today) and the global with it', async () => {
    const ab = await connectedAutoblow();
    expect(autoblowSent()).toEqual([]);                    // a bare manager knows no saved global (app.js passes savedOffsetState)
    await ab.syncOffset(120);
    await ab.setVideoOffset(-20, 120);                     // 20 ms earlier
    await ab.setVideoOffset(-20, 120);
    expect(autoblowSent()).toEqual([120, 140]);
    await ab.disconnect();
    window.funsync.autoblowSyncOffset.mockClear();
    window.funsync.autoblowConnect.mockResolvedValueOnce({ success: true, deviceType: 'autoblow-ultra', deviceInfo: {} });
    await ab.connect('not-a-real-token');
    expect(autoblowSent()).toEqual([140]);
  });

  // Review 2026-11-04: a connect only sent when THIS video had a delta, so
  // the device could keep a previous video's. Built from the REAL options
  // app.js hands `new AutoblowManager({...})`.
  const autoblowFromApp = (store, settings = fakeSettings(store)) => new AutoblowManager(
    liftCtorOptions('AutoblowManager').call({ settings }),
  );
  const reconnect = async (ab) => {
    window.funsync.autoblowConnect.mockResolvedValueOnce({ success: true, deviceType: 'autoblow-ultra', deviceInfo: {} });
    await ab.connect('not-a-real-token');
  };

  it('the Autoblow: a delta taken off while disconnected is taken off on the next connect', async () => {
    const ab = autoblowFromApp({ 'autoblow.offset': 120, 'library.syncOffsets': { [A]: 50 } });
    await reconnect(ab);
    await ab.setVideoOffset(50, 120);                      // video A
    await ab.disconnect();
    await ab.setVideoOffset(0, 120);                       // video B (no entry), while disconnected
    window.funsync.autoblowSyncOffset.mockClear();
    await reconnect(ab);
    expect(autoblowSent()).toEqual([120]);                 // not left at A's 70
    await ab.setVideoOffset(0, 120);
    expect(autoblowSent()).toEqual([120]);                 // and nothing more for the same delta
  });

  it('the Autoblow: with per-video offsets saved, a fresh session\'s connect sends global + delta (an earlier one may have left a delta)', async () => {
    const ab = autoblowFromApp({ 'autoblow.offset': 120, 'library.syncOffsets': { [A]: 50 } });
    await ab.setVideoOffset(0, 120);                       // a video with no entry, before connecting
    await reconnect(ab);
    expect(autoblowSent()).toEqual([120]);
  });

  it('the Autoblow: a connect sends the SAVED global, even when the slider moved while disconnected', async () => {
    const settings = fakeSettings({ 'autoblow.offset': 120, 'library.syncOffsets': { [A]: 50 } });
    const ab = autoblowFromApp(null, settings);
    await ab.setVideoOffset(50, 120);                      // video A loaded, device not connected
    settings.set('autoblow.offset', 200);                  // the Autoblow tab saves; nothing is sent
    await reconnect(ab);
    expect(autoblowSent()).toEqual([150]);                 // the saved 200, with A's +50 (later)
  });

  // FT-052 (2026-11-06): this test used to pin "a connect still sends
  // nothing" without per-video offsets, which is the bug: the saved
  // `autoblow.offset` then never reached the device on connect.
  it('the Autoblow: without per-video offsets a connect sends the saved global, once', async () => {
    for (const offsets of [undefined, {}]) {
      window.funsync.autoblowSyncOffset.mockClear();
      const ab = autoblowFromApp({ 'autoblow.offset': 120, ...(offsets ? { 'library.syncOffsets': offsets } : {}) });
      await ab.setVideoOffset(0, 120);
      await reconnect(ab);
      await ab.setVideoOffset(0, 120);
      expect(autoblowSent()).toEqual([120]);   // the connect's; no delta, nothing more
    }
  });
});

// ---------------------------------------------------------------------------
describe('app.js applies it on load and restores it on the next video', () => {
  it('no entries: loading videos sends no Handy or Autoblow offset and every engine keeps its global (today)', async () => {
    const ctx = await build({});
    open(ctx.app, A);
    open(ctx.app, B);
    await Promise.resolve();
    expect(handySent()).toEqual([]);
    expect(autoblowSent()).toEqual([]);
    expect(effective(ctx)).toEqual(GLOBALS);
    expect(ctx.settings.set).not.toHaveBeenCalledWith('library.syncOffsets', expect.anything());
  });

  it('video A plays with its delta on every device; video B (none) puts the globals back', async () => {
    const ctx = await build({ offsets: { [A]: -40 } });
    open(ctx.app, A);
    await Promise.resolve();
    expect(effective(ctx)).toEqual(plus(-40));
    expect(handySent()).toEqual([90]);                     // 50 + 40: positive is earlier on the Handy too
    expect(autoblowSent()).toEqual([160]);                 // 120 + 40: positive is earlier there
    open(ctx.app, B);
    await Promise.resolve();
    expect(effective(ctx)).toEqual(GLOBALS);
    expect(handySent()).toEqual([90, 50]);
    expect(autoblowSent()).toEqual([160, 120]);
  });

  it('a global slider moved while A plays edits the global, and A keeps its delta', async () => {
    const ctx = await build({ offsets: { [A]: -40 } });
    open(ctx.app, A);
    await Promise.resolve();
    // What the Sync tab / Handy tab / phone do: save the global, send it.
    ctx.settings.set('handy.defaultOffset', 70);
    await ctx.handyManager.setOffset(70);
    ctx.buttplugSync.setOffsetMs(-60);
    expect(ctx.settings.get('handy.defaultOffset')).toBe(70);
    expect(handySent().at(-1)).toBe(110);                  // 70 + 40
    expect(engineOffset(ctx.buttplugSync)).toBe(-100);     // -60 - 40
  });

  it('VR: the headset video\'s delta is keyed by its matched LOCAL path, applied once, and ends with the VR video', async () => {
    const library = vrLibrary([A, VR_LOCAL], { scripted: [VR_LOCAL] });
    const ctx = await build({ offsets: { [A]: -40, [VR_LOCAL]: 60 }, library });
    open(ctx.app, A);
    await Promise.resolve();
    await headset(ctx.app, VR_LOCAL);
    expect(effective(ctx)).toEqual(plus(60));
    expect(handySent()).toEqual([90, -10]);                  // A's (50 + 40), then the headset's (50 - 60): one update
    expect(autoblowSent()).toEqual([160, 60]);
    // In VR the engines read the VR proxy, which already takes vr.offset off.
    // The delta is NOT added there as well: a device sees vr + global + delta.
    const proxy = ctx.app.vrBridge.proxy;
    proxy.currentTime = 10;
    ctx.buttplugSync.player = { video: proxy, get currentTime() { return proxy.currentTime; } };
    expect(ctx.buttplugSync._currentTimeMs()).toBe(10000 + 100 + 80 - 60);
    expect(proxy._offsetMs).toBe(-100);
    expect(ctx.app._vrVideoSyncOffsetState()).toEqual({ path: VR_LOCAL, ms: 60 });

    ctx.app._stopVRSync();                                  // disconnect / next VR video
    expect(effective(ctx)).toEqual(plus(-40));              // the local video's again
    expect(ctx.app._vrVideoSyncOffsetState()).toBeNull();
  });

  it('VR: a headset video that drives nothing (not in the library, or no script) leaves the local video\'s delta', async () => {
    // Review 2026-11-04: the VR flag used to be set before the "drives
    // anything?" check, so every local video then played at 0 (or at the
    // headset video's delta) for as long as HereSphere stayed connected.
    const VR_PLAIN = 'C:\\VR\\no-script.mp4';
    const library = vrLibrary([A, B, VR_LOCAL, VR_PLAIN], { scripted: [VR_LOCAL] });
    const ctx = await build({ offsets: { [A]: -40, [B]: 25, [VR_LOCAL]: 60, [VR_PLAIN]: 30 }, library });
    open(ctx.app, A);
    await ctx.app._onVRVideoChanged('unknown', 'http://192.168.1.20/unknown.mp4');   // no library match
    expect(effective(ctx)).toEqual(plus(-40));
    expect(ctx.app._videoSyncOffsetState()).toEqual({ path: A, ms: -40 });
    expect(ctx.app._vrVideoSyncOffsetState()).toBeNull();

    await headset(ctx.app, VR_LOCAL);                         // a scripted one takes the devices
    expect(effective(ctx)).toEqual(plus(60));
    await headset(ctx.app, VR_PLAIN);                         // matched, but no script: lets go
    expect(effective(ctx)).toEqual(plus(-40));
    expect(ctx.app._videoSyncOffsetState()).toEqual({ path: A, ms: -40 });
    expect(ctx.app._vrVideoSyncOffsetState()).toBeNull();

    open(ctx.app, B);                                         // HereSphere still connected
    expect(effective(ctx)).toEqual(plus(25));
    expect(ctx.app._videoSyncOffsetState()).toEqual({ path: B, ms: 25 });
  });

  it('VR: a headset video whose script cannot be read leaves the local video\'s delta', async () => {
    const VR_B = 'C:\\VR\\scene-b-vr.mp4';
    const library = vrLibrary([A, VR_LOCAL, VR_B], { scripted: [VR_LOCAL, VR_B] });
    const ctx = await build({ offsets: { [A]: -40, [VR_LOCAL]: 60, [VR_B]: 70 }, library });
    open(ctx.app, A);
    // Read returns nothing, then read throws (the catch).
    for (const read of [async () => null, async () => { throw new Error('EBUSY'); }]) {
      liftedWindow.funsync.readFunscript = async () => JSON.stringify({ actions: SCRIPT });
      await headset(ctx.app, VR_LOCAL);                       // a scripted one drives the devices
      expect(effective(ctx)).toEqual(plus(60));
      liftedWindow.funsync.readFunscript = read;
      await headset(ctx.app, VR_B);
      expect(effective(ctx)).toEqual(plus(-40));
      expect(ctx.app._vrVideoSyncOffsetState()).toBeNull();
    }
  });

  it('VR: changing headset videos sends one offset update, or none when the delta is the same', async () => {
    // Review 2026-11-04: _stopVRSync put the local video's delta back and
    // the next headset video then sent its own, two unordered cloud PUTs.
    const VR_C = 'C:\\VR\\scene-c.mp4';
    const VR_D = 'C:\\VR\\scene-d.mp4';
    const library = vrLibrary([A, VR_LOCAL, VR_C, VR_D], { scripted: [VR_LOCAL, VR_C, VR_D] });
    const ctx = await build({ offsets: { [A]: 50, [VR_LOCAL]: 30, [VR_C]: 30, [VR_D]: -20 }, library });
    open(ctx.app, A);
    await headset(ctx.app, VR_LOCAL);
    expect(handySent()).toEqual([0, 20]);                     // A (50 - 50), then the headset's (50 - 30)
    expect(autoblowSent()).toEqual([70, 90]);                 // 120 - 50, 120 - 30
    await headset(ctx.app, VR_C);                             // same delta: nothing at all
    expect(handySent()).toEqual([0, 20]);
    expect(autoblowSent()).toEqual([70, 90]);
    await headset(ctx.app, VR_D);                             // a different one: exactly one update
    expect(handySent()).toEqual([0, 20, 70]);
    expect(autoblowSent()).toEqual([70, 90, 140]);
    expect(effective(ctx)).toEqual(plus(-20));
  });

  // Verify 2026-11-04 (shot 36): a headset video still loading when the
  // headset disconnected (or the phone took over) went on to put its delta
  // on the devices after the session was over, and every later local video
  // then played with it, the Sync tab's row editing the headset video's.
  it('VR: a headset that disconnects, or is taken over, while its video loads leaves no delta behind', async () => {
    const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };
    for (const stage of ['scan', 'match', 'read', 'load']) {
      for (const phoneTookOver of [false, true]) {
        const library = vrLibrary([A, B, VR_LOCAL], { scripted: [VR_LOCAL] });
        const ctx = await build({ offsets: { [A]: -40, [B]: 25, [VR_LOCAL]: 300 }, library });
        open(ctx.app, A);
        const g = gate();
        const match = library.resolveVRVideo;
        if (stage === 'scan') library.ensureScanned = async () => { await g.wait; };
        if (stage === 'match') library.resolveVRVideo = async (...a) => { await g.wait; return match(...a); };
        if (stage === 'read') liftedWindow.funsync.readFunscript = async () => { await g.wait; return JSON.stringify({ actions: SCRIPT }); };
        if (stage === 'load') ctx.app.funscriptEngine.loadContent = async () => { await g.wait; };

        const loading = headset(ctx.app, VR_LOCAL);
        ctx.app._remoteActive = phoneTookOver;
        ctx.app._stopVRSync();                                // vrBridge.onDisconnect, or the mutex takeover
        g.open();
        await loading;

        const where = `${stage}, ${phoneTookOver ? 'phone took over' : 'disconnected'}`;
        expect(effective(ctx), where).toEqual(plus(-40));     // A's, not the headset video's 300
        expect(ctx.app._videoSyncOffsetState(), where).toEqual({ path: A, ms: -40 });
        expect(ctx.app._vrVideoSyncOffsetState(), where).toBeNull();
        ctx.app._remoteActive = false;
        open(ctx.app, B);                                     // the next local video: its own
        expect(effective(ctx), where).toEqual(plus(25));
        expect(ctx.app._videoSyncOffsetState(), where).toEqual({ path: B, ms: 25 });
      }
    }
  });

  it('VR: a scan or match that throws leaves the local video\'s delta, not the last headset video\'s', async () => {
    const VR_B = 'C:\\VR\\scene-b-vr.mp4';
    for (const stage of ['scan', 'match']) {
      const library = vrLibrary([A, VR_LOCAL, VR_B], { scripted: [VR_LOCAL, VR_B] });
      const ctx = await build({ offsets: { [A]: -40, [VR_LOCAL]: 60, [VR_B]: 70 }, library });
      open(ctx.app, A);
      await headset(ctx.app, VR_LOCAL);
      expect(effective(ctx)).toEqual(plus(60));
      if (stage === 'scan') library.ensureScanned = async () => { throw new Error('scan failed'); };
      else library.resolveVRVideo = async () => { throw new Error('backend unreachable'); };
      await expect(headset(ctx.app, VR_B), stage).rejects.toThrow();   // the error carries on, as before
      expect(effective(ctx), stage).toEqual(plus(-40));
      expect(ctx.app._vrVideoSyncOffsetState(), stage).toBeNull();
    }
  });

  it('the phone: its video\'s delta while it drives the devices, the local one\'s after it lets go', async () => {
    const library = makeLibrary({ videos: [A, B] });
    const ctx = await build({ offsets: { [A]: -40, [B]: 25 }, library });
    open(ctx.app, A);
    await ctx.app._onRemotePhoneConnected('192.168.1.30', 'vid-b', B);
    expect(effective(ctx)).toEqual(plus(25));
    ctx.app._onRemotePhoneDisconnected('192.168.1.30');
    expect(effective(ctx)).toEqual(plus(-40));
  });
});

// ---------------------------------------------------------------------------
describe('absence is never destructive, and a moved video keeps its delta', () => {
  it('a moved video takes its delta when the old file is provably gone (the old key goes)', async () => {
    const OLD = 'C:\\Old\\scene-a.mp4';
    const library = makeLibrary({ videos: [A], scannedRoots: ['C:\\Old', 'C:\\Videos'] });
    const ctx = await build({ offsets: { [OLD]: -40 }, library });
    open(ctx.app, A);
    expect(effective(ctx)).toEqual(plus(-40));
    expect(ctx.settings.store['library.syncOffsets']).toEqual({ [A]: -40 });
  });

  it('an OFFLINE drive\'s entry is not a candidate: nothing moves, nothing is deleted', async () => {
    const OFFLINE = 'E:\\VR\\scene-a.mp4';
    const library = makeLibrary({ videos: [A], unavailable: ['E:\\VR'] });
    const ctx = await build({ offsets: { [OFFLINE]: -40 }, library });
    open(ctx.app, A);
    expect(effective(ctx)).toEqual(GLOBALS);
    expect(ctx.settings.store['library.syncOffsets']).toEqual({ [OFFLINE]: -40 });
    expect(ctx.settings.set).not.toHaveBeenCalledWith('library.syncOffsets', expect.anything());
  });

  it('an unproven absence (source removed, not walked) copies and keeps the original', async () => {
    const OLD = 'F:\\Removed\\scene-a.mp4';
    const library = makeLibrary({ videos: [A], scannedRoots: ['C:\\Videos'] });
    const ctx = await build({ offsets: { [OLD]: -40 }, library });
    open(ctx.app, A);
    expect(ctx.settings.store['library.syncOffsets']).toEqual({ [OLD]: -40, [A]: -40 });
  });

  it('two same-named entries are ambiguous: neither is taken', async () => {
    const library = makeLibrary({ videos: [A], scannedRoots: ['C:\\'] });
    const map = { 'C:\\One\\scene-a.mp4': 10, 'C:\\Two\\scene-a.mp4': 20 };
    const ctx = await build({ offsets: { ...map }, library });
    open(ctx.app, A);
    expect(effective(ctx)).toEqual(GLOBALS);
    expect(ctx.settings.store['library.syncOffsets']).toEqual(map);
  });

  it('a missing file never drops entries: loading and resetting one video leaves every other entry as it was', async () => {
    const GONE = 'D:\\Unplugged\\other.mp4';
    const library = makeLibrary({ videos: [A], unavailable: ['D:\\Unplugged'] });
    const ctx = await build({ offsets: { [GONE]: 70, [A]: -40 }, library });
    open(ctx.app, A);
    ctx.app._setVideoSyncOffset(0);
    open(ctx.app, B);
    expect(ctx.settings.store['library.syncOffsets']).toEqual({ [GONE]: 70, [A]: 0 });
  });

  it('a Reset sticks: a same-named copy kept elsewhere does not bring the old delta back', async () => {
    const OLD = 'F:\\Removed\\scene-a.mp4';
    const library = makeLibrary({ videos: [A], scannedRoots: ['C:\\Videos'] });
    const ctx = await build({ offsets: { [OLD]: -40 }, library });
    open(ctx.app, A);                       // re-homed as a copy
    ctx.app._setVideoSyncOffset(0);         // the user resets this video
    open(ctx.app, B);
    open(ctx.app, A);
    expect(effective(ctx)).toEqual(GLOBALS);
  });

  it('backups and exports carry the map, and an import merges it', () => {
    const config = { settings: { library: { syncOffsets: { [A]: -40 }, durationCache: { x: 1 } } } };
    expect(stripBlacklist(config).settings.library.syncOffsets).toEqual({ [A]: -40 });
    const merged = mergeConfig({ settings: { library: { syncOffsets: { [B]: 25 } } } }, config, 'merge');
    expect(merged.settings.library.syncOffsets).toEqual({ [A]: -40, [B]: 25 });
  });
});

// ---------------------------------------------------------------------------
describe('the "This video" rows', () => {
  async function syncTab(ctx) {
    document.body.innerHTML = '<div id="app"></div>';
    // The REAL options app.js hands `new ConnectionPanel({...})`.
    const options = liftCtorOptions('ConnectionPanel').call(ctx.app);
    const panel = new ConnectionPanel(options);
    ctx.app.connectionPanel = panel;
    panel.show();
    panel._switchTab('sync');
    return panel;
  }
  const section = (panel) => panel._panel.querySelector('#sync-video-offset-section');
  const press = (root, cls) => root.querySelector(`.${cls}`).dispatchEvent(new MouseEvent('click', { bubbles: true }));

  it('Sync tab: hidden with no video; with one, − saves and applies, Reset puts it back', async () => {
    const ctx = await build({});
    const panel = await syncTab(ctx);
    expect(section(panel).hidden).toBe(true);

    open(ctx.app, A);
    expect(section(panel).hidden).toBe(false);
    expect(section(panel).querySelector('.video-sync-offset__value').textContent).toBe('0 ms');
    press(section(panel), 'video-sync-offset__earlier');
    press(section(panel), 'video-sync-offset__earlier');
    await Promise.resolve();
    expect(ctx.settings.store['library.syncOffsets']).toEqual({ [A]: -2 * VIDEO_SYNC_OFFSET_STEP_MS });
    expect(effective(ctx)).toEqual(plus(-20));
    expect(section(panel).querySelector('.video-sync-offset__value').textContent).toBe('-20 ms');

    press(section(panel), 'video-sync-offset__reset');
    await Promise.resolve();
    expect(effective(ctx)).toEqual(GLOBALS);
    expect(section(panel).querySelector('.video-sync-offset__reset').disabled).toBe(true);
    panel.hide?.();
  });

  // Verify 2026-11-04: the Autoblow was sent global + delta, but its API
  // adds the offset to the script time, so "earlier" made it LATER, and no
  // one per-video value could fix a video for an Autoblow and a Buttplug
  // device at once. What is compared is each device's script time at the
  // same video time, worked out by that device's own rule.
  it('Sync tab: one "earlier" press moves every device\'s script the same way, the Autoblow included', async () => {
    const ctx = await build({});
    open(ctx.app, A);
    const panel = await syncTab(ctx);
    const T = 10000;                                       // video time, ms
    const sentHandy = () => handySent().at(-1) ?? GLOBALS.handy;
    const sentAutoblow = () => autoblowSent().at(-1) ?? GLOBALS.autoblow;
    const scriptTimeAt = () => {
      ctx.buttplugSync.player.currentTime = T / 1000;
      ctx.tcodeSync.player.currentTime = T / 1000;
      return {
        // The app schedules these itself (`_currentTimeMs`).
        buttplug: ctx.buttplugSync._currentTimeMs(),
        tcode: ctx.tcodeSync._currentTimeMs(),
        // HSTP, measured on Dave's Handy 2026-11-05: a positive offset
        // plays the script earlier (the vendored v2 spec's reading).
        handy: T + sentHandy(),
        // Autoblow API v1: the offset "will get added to syncScriptCurrentTime".
        autoblow: T + sentAutoblow(),
      };
    };
    const before = scriptTimeAt();
    expect(section(panel).querySelector('.video-sync-offset__earlier').getAttribute('aria-label'))
      .toBe(t('videoSyncOffset.earlier', { ms: VIDEO_SYNC_OFFSET_STEP_MS }));
    press(section(panel), 'video-sync-offset__earlier');
    await Promise.resolve();
    const after = scriptTimeAt();
    const ahead = Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]));
    // Every script runs 10 ms ahead of the video: the device moves earlier.
    expect(ahead).toEqual({ buttplug: 10, tcode: 10, handy: 10, autoblow: 10 });
    expect(autoblowSent()).toEqual([GLOBALS.autoblow + VIDEO_SYNC_OFFSET_STEP_MS]);
    panel.hide?.();
  });

  it('Sync tab: the Handy row\'s slider still sets the GLOBAL value, labelled for all videos', async () => {
    const ctx = await build({ offsets: { [A]: -40 } });
    open(ctx.app, A);
    const panel = await syncTab(ctx);
    expect(panel._panel.querySelector('[data-i18n="connection.sync.perDeviceOffsets"]').textContent)
      .toBe(t('connection.sync.perDeviceOffsets'));
    expect(t('connection.sync.perDeviceOffsets')).toMatch(/all videos/);
    const slider = panel._panel.querySelector('#sync-device-rows input[type="range"]');
    slider.value = '80';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.settings.get('handy.defaultOffset')).toBe(80);
    expect(ctx.settings.store['library.syncOffsets']).toEqual({ [A]: -40 });
    expect(handySent().at(-1)).toBe(120);                  // 80 + 40
    panel.hide?.();
  });

  // Hardware 2026-11-05 (Dave's Handy, fw 4.2.1): a POSITIVE HSTP offset
  // fires the Handy EARLIER. The suggestion is worked out in "negative =
  // earlier", so unconverted, Apply made the Handy fire LATER by the very
  // latency it meant to cancel.
  it('Sync tab: the Handy row suggests and applies in the Handy\'s own convention (positive = earlier)', async () => {
    const ctx = await build({});
    ctx.handyManager._syncQuality = { avgRtd: 120 };       // one way: 60 ms to cancel
    open(ctx.app, A);
    const panel = await syncTab(ctx);
    const row = panel._panel.querySelector('#sync-device-rows .connection-panel__section');
    expect(row.textContent).toContain(t('connection.sync.deviceHandy'));
    expect(row.textContent).toContain(t('connection.sync.suggested', { ms: 60 }));
    const apply = [...row.querySelectorAll('button')].find((b) => b.textContent === t('connection.btn.apply'));
    apply.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.settings.get('handy.defaultOffset')).toBe(60);
    expect(handySent().at(-1)).toBe(60);                   // 60 ms EARLIER on the Handy
    panel.hide?.();
  });

  it('Sync tab: the per-device hint says which way each device goes, in every locale', () => {
    expect(t('connection.sync.perDeviceHint')).toMatch(/Handy and Autoblow a positive value/);
    for (const l of ['de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const b = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
      expect(b.connection.sync.perDeviceHint, l).toMatch(/Handy/);
      expect(b.connection.sync.perDeviceHint, l).toMatch(/Autoblow/);
      expect(b.connection.sync.perDeviceHint, l).not.toBe(EN.connection.sync.perDeviceHint);
    }
  });

  it('Sync tab in VR: a device row\'s "effective" total includes this video\'s delta, and follows a Reset', async () => {
    // Review 2026-11-04: it summed only the device's and the VR offset.
    const library = vrLibrary([A, VR_LOCAL], { scripted: [VR_LOCAL] });
    const ctx = await build({ offsets: { [VR_LOCAL]: 60 }, library });
    ctx.app.vrBridge.connected = true;
    await headset(ctx.app, VR_LOCAL);
    const panel = await syncTab(ctx);
    const total = () => panel._panel.querySelector('#sync-device-rows .connection-panel__sync-row-total').textContent;
    // The line counts negative = earlier. The Handy's own +50 fires it 50 ms
    // early (hardware 2026-11-05), so it shows as -50; VR -100, this video
    // +60: -90, what the Handy really runs at. Before, it showed +10.
    expect(total()).toBe(t('connection.sync.vrModeTotalVideo', { device: '-50', vr: '-100', thisVideo: '+60', total: '-90' }));
    press(section(panel), 'video-sync-offset__reset');
    await Promise.resolve();
    expect(total()).toBe(t('connection.sync.vrModeTotal', { device: '-50', vr: '-100', total: '-150' }));
    panel.hide?.();
  });

  it('VR modal: shows only the headset\'s matched video, and + applies to every device', async () => {
    const library = vrLibrary([A, VR_LOCAL], { scripted: [VR_LOCAL] });
    const ctx = await build({ library });
    open(ctx.app, A);
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '192.168.1.10' }) }));
    const bridge = {
      linkState: 'receiving', host: '192.168.1.20', connected: true, proxy: ctx.app.vrBridge.proxy,
      onConnect: null, onDisconnect: null, onVideoChanged: null,
      connect: vi.fn(async () => true), disconnect: vi.fn(async () => {}),
    };
    openVRModal({
      settings: ctx.settings,
      vrBridge: bridge,
      // What app.js passes (onVRClick).
      videoSyncOffset: { get: () => ctx.app._vrVideoSyncOffsetState(), set: (ms) => ctx.app._setVideoSyncOffset(ms) },
    });
    await vi.waitFor(() => expect(document.querySelector('#vr-video-offset-mount')).not.toBeNull());
    const row = () => document.querySelector('#vr-video-offset-mount .video-sync-offset');
    expect(row().hidden).toBe(true);                       // a LOCAL video is loaded, not a VR one

    await ctx.app._onVRVideoChanged('heresphere scene', 'http://192.168.1.20/heresphere-scene.mp4');
    expect(row().hidden).toBe(false);                      // refreshed by app.js's event
    press(row(), 'video-sync-offset__later');
    await Promise.resolve();
    expect(ctx.settings.store['library.syncOffsets']).toEqual({ [VR_LOCAL]: VIDEO_SYNC_OFFSET_STEP_MS });
    expect(effective(ctx)).toEqual(plus(VIDEO_SYNC_OFFSET_STEP_MS));
    expect(t('vrModal.offset')).toMatch(/all videos/);

    bridge.__vrModalCleanup?.();
    delete globalThis.fetch;
  });
});
