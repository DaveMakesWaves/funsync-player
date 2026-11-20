/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-113 (2026-11-16; also in v0.9.2): the Handy and the Autoblow play an
// UPLOADED script on the device's own clock, so the output limits (a comfort
// and safety floor / ceiling), the gap filler and the Range Extender have to
// be baked into what is uploaded. A local open did that (`_handyUploadContent`,
// `_tryStartAutoblowSync`), but three other routes did not:
//   - a HereSphere / DeoVR headset video (`_onVRVideoChanged`),
//   - a phone's video (`_onRemotePhoneConnected`),
//   - a custom-routing route on the Handy or the Autoblow (`_loadCustomRouting`),
// sent the raw script (the Handy's with only the invert): a floor of 30 still
// let the device go to 0 and 100. And the filler's trailing gap was measured
// against THIS window's video, which is not the video a headset or a phone
// plays (a phone's variant tap goes through `_uploadAndStartSync`).
//
// The REAL app.js methods are lifted (helpers/app-methods.js) with the REAL
// processing functions (extend / fill / invert / clamp), a REAL AutoblowSync,
// REAL playback proxies, and fakes for the two device managers that record
// what each device was sent (no key, no token, nothing leaves the test). What
// is asserted is the uploaded script itself: every position inside the
// limits, the filler out to the end of the video that plays, and byte for
// byte what a LOCAL open of the same script on a video that long uploads.
import { describe, it, expect, vi } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { VRPlaybackProxy } from '../../renderer/js/vr-playback-proxy.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} from '../../renderer/js/device-transform-stack.js';
import { vrDisplayName, funsyncVideoIdFromVRPath } from '../../renderer/js/vr-bridge.js';
import { normalizeAssociation, resolveActiveConfig } from '../../renderer/js/association-shape.js';
import { SOURCE_PLAYER } from '../../renderer/js/audience-bridge.js';

vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

const METHODS = [
  // The routes under test
  '_onVRVideoChanged', '_onRemotePhoneConnected', '_loadCustomRouting',
  // The local route, the reference (a phone's variant tap comes through it too)
  '_uploadAndStartSync', '_tryStartAutoblowSync',
  // The chain every route goes through
  '_handyUploadContent', '_autoblowUploadContent', '_fillerOptionsForUpload',
  '_cutoffFromSettings', '_handyInverted', '_sessionTimelineMs', '_uploadDurationMsFor',
];

const LIMITS = { min: 30, max: 80 };
const BASE_SETTINGS = {
  'handy.cutoff': LIMITS,
  'autoblow.cutoff': LIMITS,
  'handy.inverted': false,
  'player.gapFiller': { enabled: true, presetId: 'steady', thresholdMs: 5000 },
  'player.gapSkip': { mode: 'off' },
  'player.rangeExtender.enabled': false,
  'library.associations': {},
};

// 0 <-> 100 every 250 ms for 10 s, then nothing: on a 60 s video the filler
// has a 50 s trailing gap to fill.
const strokes = (lo, hi, stepMs) => Array.from({ length: 10000 / stepMs + 1 }, (_, i) => ({ at: i * stepMs, pos: i % 2 ? hi : lo }));
const MAIN_RAW = JSON.stringify({ version: '1.0', _label: 'main', actions: strokes(0, 100, 250) });
const ROUTE_RAW = JSON.stringify({ version: '1.0', _label: 'route', actions: strokes(100, 0, 250) });
// A narrow script (40-60): the Range Extender stretches it.
const NARROW_RAW = JSON.stringify({ version: '1.0', _label: 'narrow', actions: strokes(40, 60, 250) });
const LAST_AUTHORED_MS = 10000;

const LOCAL = 'C:\\sandbox\\library\\local.mp4';
const SCENE = 'C:\\sandbox\\library\\scene.mp4';
const SCENE_FS = 'C:\\sandbox\\library\\scene.funscript';
const PHONE = 'C:\\sandbox\\library\\phone.mp4';
const PHONE_FS = 'C:\\sandbox\\library\\phone.funscript';
const NARROW_FS = 'C:\\sandbox\\library\\narrow.funscript';
const ROUTE_FS = 'C:\\sandbox\\library\\scene.route.funscript';
const MAIN_FS = 'C:\\sandbox\\library\\local.funscript';
const ROUTES = [
  { role: 'main', deviceId: 'buttplug:0:Stroker', scriptPath: MAIN_FS },
  { role: 'route', deviceId: 'handy', scriptPath: ROUTE_FS },
  { role: 'route', deviceId: 'autoblow', scriptPath: ROUTE_FS },
];

class FakeVideo extends EventTarget {
  constructor(duration) { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = duration; this.playbackRate = 1; }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { this.paused = true; }
}

/** This window's video is `localDurationSec` long (a DIFFERENT video from a headset's or phone's). */
function build({ settings = {}, localDurationSec = 20 } = {}) {
  const S = { ...BASE_SETTINGS, ...settings };
  const disk = {
    [MAIN_FS]: MAIN_RAW, [SCENE_FS]: MAIN_RAW, [PHONE_FS]: MAIN_RAW, [NARROW_FS]: NARROW_RAW, [ROUTE_FS]: ROUTE_RAW,
  };
  const failures = [];
  const toasts = [];
  const record = (...args) => failures.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  const fakeWindow = { funsync: { readFunscript: vi.fn(async (p) => disk[p] ?? null) } };
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: { getElementById: () => null },
    console: { log() {}, debug() {}, info() {}, warn: record, error: record },
    showToast: (msg, level) => { toasts.push([msg, level]); return { dismiss() {} }; }, t: (k) => k,
    stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    vrDisplayName, funsyncVideoIdFromVRPath, normalizeAssociation, resolveActiveConfig,
    RemotePlaybackProxy, SOURCE_PLAYER,
  });

  const video = new FakeVideo(localDurationSec);
  const videoPlayer = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
  };
  // The two cloud devices, fakes shaped like the real managers (checked
  // below): what each was asked to play.
  const handySent = [];
  const handyManager = {
    connected: true,
    uploadSeq: 0,
    _lastCloudUrl: null,
    uploadAndSetScript: vi.fn(async function (c) { this.uploadSeq++; handySent.push(c); return true; }),
    hsspStop: vi.fn(async () => true),
  };
  const autoblowSent = [];
  const autoblowManager = {
    connected: true,
    uploadScript: vi.fn(async (c) => { autoblowSent.push(c); return true; }),
    syncStart: vi.fn(async () => true),
    syncStop: vi.fn(async () => true),
  };
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; } },
    videoPlayer,
    funscriptEngine: {
      isLoaded: false, _raw: null,
      loadContent: vi.fn(async function (c) { JSON.parse(c); this.isLoaded = true; this._raw = c; return { filename: 'x', actionCount: 2 }; }),
      getRawContent() { return this._raw; },
      getActions() { return this._raw ? JSON.parse(this._raw).actions : []; },
      getChapters: () => [], getBookmarks: () => [],
    },
    handyManager,
    syncEngine: {
      _active: false, _scriptReady: false, player: videoPlayer,
      start() { this._active = true; }, stop() { this._active = false; },
      resync: async () => true,
    },
    autoblowManager,
    autoblowSync: new AutoblowSync({ videoPlayer, autoblowManager }),
    buttplugSync: null, tcodeSync: null, buttplugManager: null, tcodeManager: null, handyHdspSync: null,
    audienceBridge: null, scriptEditor: null, sessionTracker: null, orgasmSwitch: null,
    remoteBridge: { connected: true, sendToPhone() {} },
    vrBridge: null, library: null,
    _videoLoadGen: 0, _vrMatchGeneration: 0, _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    _currentVariants: [], _activeVariantIndex: 0, _activeVariantPath: null,
    _currentVideoPath: LOCAL, _remoteActive: false, _vrPlayerRef: null,
    _customRoutingActive: false, _engineHeldByRemote: false,
    // Stand-ins for what these routes call that is not under test.
    _stopVRSync() {}, _settleVRVideoSyncOffset(p) { this._vrSyncOffsetPath = p || null; },
    _stashLocalScriptBeforeRemote() {}, _resetCustomRoutingState() {}, _clearLocalAxesForRemote() {},
    _applyVideoSyncOffset() {}, _pushRemoteDeviceStatus() {}, _refreshLoopVideoVisibility() {},
    _updateVariantSelector() {}, _phonePinnedVariant: () => null,
    _readRouteScript: async (route) => (disk[route.scriptPath] ? { content: disk[route.scriptPath] } : null),
    _applyCustomRoutingAssignments: () => [], _reportCustomRoutingMismatches() {}, _persistCustomRoutes() {},
    _findKnownDeviceForRoute: () => null,
    _resolveCloudUpload() {},
  });
  return { app, handySent, autoblowSent, failures, toasts, settings: S, disk };
}

/** A headset reporting `durationSec` (0: not yet), matched to a library video `libraryDurationSec` long. */
async function headsetPlays(ctx, { durationSec = 60, libraryDurationSec = 45, associations = {}, funscriptPath = SCENE_FS } = {}) {
  const proxy = new VRPlaybackProxy();
  proxy.updateFromVR({ currentTime: 0, duration: durationSec, playerState: 1, playbackSpeed: 1 });
  proxy._trackerHooked = true;   // no session-tracker poll in a test
  ctx.app.vrBridge = { proxy, connected: false };
  ctx.settings['library.associations'] = associations;
  ctx.app.library = {
    ensureScanned: async () => {},
    _videos: [{}],
    resolveVRVideo: async () => ({
      name: 'scene', path: SCENE, hasFunscript: true, funscriptPath,
      ...(libraryDurationSec ? { duration: libraryDurationSec } : {}),
    }),
    getVideoByPath: () => null,
  };
  await ctx.app._onVRVideoChanged('scene', 'C:\\headset\\scene.mp4');
}

/** A phone opens its library video (`libraryDurationSec` long, 0: not known yet). */
async function phonePlays(ctx, { libraryDurationSec = 60, funscriptPath = PHONE_FS } = {}) {
  const entry = {
    name: 'phone', path: PHONE, hasFunscript: true, funscriptPath, variants: [],
    ...(libraryDurationSec ? { duration: libraryDurationSec } : {}),
  };
  ctx.app.library = {
    _videosByPath: new Map([[PHONE, entry]]),
    getVideoByPath: (p) => (p === PHONE ? entry : null),
  };
  await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', PHONE);
}

/** What a LOCAL open of `raw` on a `durationSec` video uploads to the Handy and the Autoblow. */
async function localUploads(raw, durationSec, settings = {}) {
  const ctx = build({ settings, localDurationSec: durationSec });
  ctx.app.funscriptEngine.isLoaded = true;
  ctx.app.funscriptEngine._raw = raw;
  await ctx.app._uploadAndStartSync();
  await ctx.app._tryStartAutoblowSync();
  expectNoFailures(ctx);
  return { handy: ctx.handySent.at(-1), autoblow: ctx.autoblowSent.at(-1) };
}

const actionsOf = (content) => JSON.parse(content).actions;
const positions = (content) => actionsOf(content).map((a) => a.pos);
const lastAt = (content) => actionsOf(content).at(-1).at;
const labelOf = (content) => JSON.parse(content)._label;

/** Every position inside the output limits. */
function expectWithinLimits(content) {
  const ps = positions(content);
  expect(Math.min(...ps)).toBeGreaterThanOrEqual(LIMITS.min);
  expect(Math.max(...ps)).toBeLessThanOrEqual(LIMITS.max);
}

/** The gap filler runs on to (just short of) `endMs`, and not past it. */
function expectFilledTo(content, endMs) {
  expect(lastAt(content)).toBeGreaterThan(endMs - 10000);
  expect(lastAt(content)).toBeLessThanOrEqual(endMs);
  expect(actionsOf(content).filter((a) => a.at > LAST_AUTHORED_MS).length).toBeGreaterThan(10);
}

/** No route swallowed an error in its catch (a lift gap would show here first). */
function expectNoFailures(ctx) {
  expect(ctx.failures).toEqual([]);
  expect(ctx.toasts.filter(([, level]) => level === 'error')).toEqual([]);
}

describe('the fakes have the real classes\' shape', () => {
  it('every device method and field the fakes provide exists on the real class', () => {
    for (const m of ['uploadAndSetScript', 'hsspStop']) expect(typeof HandyManager.prototype[m]).toBe('function');
    for (const g of ['connected', 'uploadSeq']) {
      expect(typeof Object.getOwnPropertyDescriptor(HandyManager.prototype, g)?.get).toBe('function');
    }
    for (const m of ['uploadScript', 'syncStart', 'syncStop']) expect(typeof AutoblowManager.prototype[m]).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(AutoblowManager.prototype, 'connected')?.get).toBe('function');
    for (const m of ['start', 'stop', 'resync']) expect(typeof SyncEngine.prototype[m]).toBe('function');
  });
});

describe('FT-113: the reference, a local open', () => {
  it('the Handy and the Autoblow get the limits and the filler, to the local video\'s end', async () => {
    const local = await localUploads(MAIN_RAW, 60);
    for (const content of [local.handy, local.autoblow]) {
      expectWithinLimits(content);
      expectFilledTo(content, 60000);
    }
  });
});

describe('FT-113: a headset\'s video gets what a local open of it gets', () => {
  it('the Handy and the Autoblow: limits, filler to the HEADSET video\'s end (not this window\'s 20 s)', async () => {
    const ctx = build({ localDurationSec: 20 });
    await headsetPlays(ctx, { durationSec: 60, libraryDurationSec: 45 });
    expectNoFailures(ctx);
    const local = await localUploads(MAIN_RAW, 60);
    expect(ctx.handySent).toHaveLength(1);
    expect(ctx.autoblowSent).toHaveLength(1);
    expect(ctx.handySent[0]).toBe(local.handy);
    expect(ctx.autoblowSent[0]).toBe(local.autoblow);
    expectWithinLimits(ctx.handySent[0]);
    expectFilledTo(ctx.handySent[0], 60000);
    expectWithinLimits(ctx.autoblowSent[0]);
    expectFilledTo(ctx.autoblowSent[0], 60000);
  });

  it('the headset has not said how long its video is yet: the library\'s length for it', async () => {
    const ctx = build({ localDurationSec: 20 });
    await headsetPlays(ctx, { durationSec: 0, libraryDurationSec: 45 });
    expectNoFailures(ctx);
    const local = await localUploads(MAIN_RAW, 45);
    expect(ctx.handySent[0]).toBe(local.handy);
    expect(ctx.autoblowSent[0]).toBe(local.autoblow);
    expectFilledTo(ctx.handySent[0], 45000);
  });

  it('no length known anywhere: no trailing filler, never this window\'s video\'s length; limits still hold', async () => {
    const ctx = build({ localDurationSec: 20 });
    await headsetPlays(ctx, { durationSec: 0, libraryDurationSec: 0 });
    expectNoFailures(ctx);
    for (const content of [ctx.handySent[0], ctx.autoblowSent[0]]) {
      expectWithinLimits(content);
      expect(lastAt(content)).toBe(LAST_AUTHORED_MS);
    }
  });

  it('Handy invert on: flipped, then clamped, as a local open (a floor still holds on the flipped script)', async () => {
    const ctx = build({ settings: { 'handy.inverted': true } });
    await headsetPlays(ctx, { durationSec: 60 });
    expectNoFailures(ctx);
    const local = await localUploads(MAIN_RAW, 60, { 'handy.inverted': true });
    expect(ctx.handySent[0]).toBe(local.handy);
    expectWithinLimits(ctx.handySent[0]);
    // The Autoblow has no invert: its upload is the un-flipped one.
    expect(ctx.autoblowSent[0]).toBe(local.autoblow);
  });

  it('Range Extender on: a narrow headset script is stretched as a local open stretches it, then clamped', async () => {
    const settings = { 'player.rangeExtender.enabled': true, 'player.gapFiller': { enabled: false } };
    const ctx = build({ settings });
    await headsetPlays(ctx, { durationSec: 60, funscriptPath: NARROW_FS });
    expectNoFailures(ctx);
    const local = await localUploads(NARROW_RAW, 60, settings);
    expect(ctx.handySent[0]).toBe(local.handy);
    expect(ctx.autoblowSent[0]).toBe(local.autoblow);
    // Stretched out of 40-60 (the raw script), up to the limits.
    expect(Math.min(...positions(ctx.handySent[0]))).toBe(LIMITS.min);
    expect(Math.max(...positions(ctx.handySent[0]))).toBe(LIMITS.max);
  });
});

describe('FT-113: a phone\'s video gets what a local open of it gets', () => {
  it('the Handy and the Autoblow: limits, filler to the PHONE video\'s end (the library\'s length; the proxy was just reset)', async () => {
    const ctx = build({ localDurationSec: 20 });
    await phonePlays(ctx, { libraryDurationSec: 60 });
    expectNoFailures(ctx);
    const local = await localUploads(MAIN_RAW, 60);
    expect(ctx.handySent).toEqual([local.handy]);
    expect(ctx.autoblowSent).toEqual([local.autoblow]);
    expectWithinLimits(ctx.handySent[0]);
    expectFilledTo(ctx.handySent[0], 60000);
    expectWithinLimits(ctx.autoblowSent[0]);
    expectFilledTo(ctx.autoblowSent[0], 60000);
  });

  it('a re-upload while the phone drives (its variant tap runs _uploadAndStartSync / _tryStartAutoblowSync): the phone video\'s timeline, not this window\'s', async () => {
    const ctx = build({ localDurationSec: 20 });
    await phonePlays(ctx, { libraryDurationSec: 0 });
    // The engines are on the phone's proxy now; the phone reports its length.
    expect(ctx.app.syncEngine.player.video).toBe(ctx.app._remoteProxy);
    expect(ctx.app.autoblowSync.player.video).toBe(ctx.app._remoteProxy);
    ctx.app._remoteProxy.updateState({ at: 0, paused: true, duration: 60 });
    ctx.app.funscriptEngine._raw = ROUTE_RAW;   // the variant tapped
    ctx.app.autoblowSync._scriptReady = false;  // as _switchVariant leaves it
    await ctx.app._uploadAndStartSync();
    await ctx.app._tryStartAutoblowSync();
    expectNoFailures(ctx);
    const local = await localUploads(ROUTE_RAW, 60);
    expect(labelOf(ctx.handySent.at(-1))).toBe('route');
    expect(ctx.handySent.at(-1)).toBe(local.handy);
    expect(ctx.autoblowSent.at(-1)).toBe(local.autoblow);
    expectFilledTo(ctx.handySent.at(-1), 60000);
    expectWithinLimits(ctx.autoblowSent.at(-1));
  });
});

describe('FT-113: a custom-routing route on the Handy or the Autoblow', () => {
  it('this window\'s video: the route\'s uploads are what a local open of the route script uploads', async () => {
    const ctx = build({ localDurationSec: 60 });
    await ctx.app._loadCustomRouting(ROUTES, LOCAL);
    expectNoFailures(ctx);
    const local = await localUploads(ROUTE_RAW, 60);
    expect(ctx.handySent).toEqual([local.handy]);
    expect(ctx.autoblowSent).toEqual([local.autoblow]);
    expectWithinLimits(ctx.handySent[0]);
    expectFilledTo(ctx.handySent[0], 60000);
    expectWithinLimits(ctx.autoblowSent[0]);
  });

  it('a headset video with custom routing: the routes fill to the headset video\'s end', async () => {
    const ctx = build({ localDurationSec: 20 });
    await headsetPlays(ctx, { durationSec: 60, associations: { [SCENE]: { mode: 'custom', routes: ROUTES } } });
    expectNoFailures(ctx);
    const local = await localUploads(ROUTE_RAW, 60);
    // The headset's main script first, then the routes' (the Handy and the
    // Autoblow are not on the main route).
    expect(ctx.handySent.map(labelOf)).toEqual(['main', 'route']);
    expect(ctx.autoblowSent.map(labelOf)).toEqual(['main', 'route']);
    expect(ctx.handySent[1]).toBe(local.handy);
    expect(ctx.autoblowSent[1]).toBe(local.autoblow);
    for (const content of [...ctx.handySent, ...ctx.autoblowSent]) {
      expectWithinLimits(content);
      expectFilledTo(content, 60000);
    }
  });
});

describe('FT-113: no limits and no filler set: every route still uploads what it did', () => {
  it('the headset, the phone and a route send the script as read (only the Handy invert, which is off)', async () => {
    const settings = { 'handy.cutoff': { min: 0, max: 100 }, 'autoblow.cutoff': { min: 0, max: 100 }, 'player.gapFiller': { enabled: false } };
    const vr = build({ settings });
    await headsetPlays(vr, { durationSec: 60 });
    const phone = build({ settings });
    await phonePlays(phone, { libraryDurationSec: 60 });
    const route = build({ settings, localDurationSec: 60 });
    await route.app._loadCustomRouting(ROUTES, LOCAL);
    for (const ctx of [vr, phone, route]) expectNoFailures(ctx);
    expect(vr.handySent).toEqual([MAIN_RAW]);
    expect(vr.autoblowSent).toEqual([MAIN_RAW]);
    expect(phone.handySent).toEqual([MAIN_RAW]);
    expect(phone.autoblowSent).toEqual([MAIN_RAW]);
    expect(route.handySent).toEqual([ROUTE_RAW]);
    expect(route.autoblowSent).toEqual([ROUTE_RAW]);
  });
});
