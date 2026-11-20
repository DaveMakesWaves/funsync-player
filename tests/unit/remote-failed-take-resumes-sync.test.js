/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Block C fix-up (2026-11-06, real-app verifier 2; also in v0.9.2): after a
// phone session whose script the desktop could not read, the local devices
// stayed silent. `_onRemotePhoneDisconnected` stops every sync engine, and
// `_restoreLocalScriptAfterRemote` (R4-04) returned at once because the
// phone never took the engine (`_engineHeldByRemote` false), so nothing
// started them again: Play on the desktop for 2.5 s sent 0 commands until
// the video was opened again. A headset video with no script, or a headset
// link that dropped before any, did the same through `_stopVRSync`.
//
// The REAL teardown, restore and `_tryStart*` methods are lifted out of
// app.js (helpers/app-methods.js); the Buttplug engine is the REAL
// ButtplugSync on a fake clock, so what is asserted is what the user sees:
// does a local Play send the device anything. The Handy / T-Code / Autoblow
// engines are recorders (started or not, on which player).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} from '../../renderer/js/device-transform-stack.js';
import { vrDisplayName, funsyncVideoIdFromVRPath } from '../../renderer/js/vr-bridge.js';
import { normalizeAssociation, resolveActiveConfig } from '../../renderer/js/association-shape.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { pathToFileURL } from '../../renderer/js/path-utils.js';
import { SOURCE_PLAYER } from '../../renderer/js/audience-bridge.js';
import { extractEmbeddedAxes } from '../../renderer/js/embedded-multi-axis.js';
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';

const METHODS = [
  '_onVRVideoChanged', '_onRemotePhoneConnected', '_stopVRSync', '_onRemotePhoneDisconnected',
  '_stashLocalScriptBeforeRemote', '_restoreLocalScriptAfterRemote',
  '_noteSyncStoppedByRemoteTeardown', '_resumeLocalSyncAfterRemote',
  '_tryStartButtplugSync', '_tryStartTCodeSync', '_tryStartAutoblowSync',
  '_fillerOptionsForUpload', '_cutoffFromSettings',
  '_handyUploadContent', '_autoblowUploadContent', '_handyInverted', '_sessionTimelineMs', '_uploadDurationMsFor', // FT-113
  '_clearLocalAxesForRemote', '_resetCustomRoutingState',
];

// A 250 ms stroke script, 0 <-> 100 for 10 s.
const ACTIONS = Array.from({ length: 41 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 100 : 0 }));
const ALPHA_RAW = JSON.stringify({ version: '1.0', actions: ACTIONS });
const ALPHA = 'C:\\v\\alpha.mp4';
const ALPHA_FS = 'C:\\v\\alpha.funscript';
const PHONE = 'C:\\v\\bravo.mp4';

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 60; this.playbackRate = 1; }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}

/** A sync engine that records whether it runs and on which player. */
function recorder(extra = {}) {
  return {
    _active: false, player: null, starts: 0,
    start() { this._active = true; this.starts++; },
    stop() { this._active = false; },
    reloadActions() {}, clearAxisActions() {}, setAxisActions() {},
    ...extra,
  };
}

function build({ handy = true, autoblow = true } = {}) {
  const disk = { [ALPHA_FS]: ALPHA_RAW };
  const fakeWindow = {
    funsync: {
      readFunscript: vi.fn(async (p) => disk[p] ?? null),
      writeFunscript: vi.fn(async () => { throw new Error('nothing may be written'); }),
    },
  };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: { getElementById: () => null }, console: quiet,
    showToast: () => ({ dismiss() {} }), t: (k) => k,
    stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    vrDisplayName, funsyncVideoIdFromVRPath, normalizeAssociation, resolveActiveConfig,
    RemotePlaybackProxy, pathToFileURL, URL, SOURCE_PLAYER, extractEmbeddedAxes, getAxisBySuffix,
    maybeShowHevcGuidance: () => {}, isAutoMatch: () => false,
  });

  const video = new FakeVideo();
  const videoPlayer = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
    loadSource() {}, clearSubtitles() {},
  };
  const funscriptEngine = {
    isLoaded: true,
    _raw: ALPHA_RAW,
    getRawContent() { return this._raw; },
    getActions() { return this.isLoaded ? JSON.parse(this._raw).actions : []; },
    getChapters: () => [], getBookmarks: () => [],
    loadContent: vi.fn(async function (content) { JSON.parse(content); this.isLoaded = true; this._raw = content; return { actionCount: 2 }; }),
    clear() { this.isLoaded = false; this._raw = null; },
  };
  const sent = [];
  const buttplugManager = {
    connected: true,
    devices: [{ index: 0, name: 'Stroker', canLinear: true, canVibrate: false, canRotate: false, canScalar: false, canOscillate: false }],
    sendLinear: vi.fn((index, pos) => { sent.push({ index, pos }); return Promise.resolve({ ok: true }); }),
    sendVibrate: vi.fn(), sendRotate: vi.fn(), sendScalar: vi.fn(), sendOscillate: vi.fn(),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
  const buttplugSync = new ButtplugSync({ buttplugManager, videoPlayer, funscriptEngine });
  buttplugSync.setRampUp(0, false);

  const app = Object.assign(new Lifted(), {
    settings: { get: () => undefined, set: () => {} },
    videoPlayer, funscriptEngine,
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, renderHeatmap() {} },
    handyManager: handy ? { connected: true, hsspStop: vi.fn(), uploadAndSetScript: vi.fn(async () => true) } : null,
    syncEngine: recorder({ _scriptReady: true }),
    buttplugManager, buttplugSync,
    tcodeManager: { connected: true },
    tcodeSync: recorder(),
    autoblowManager: autoblow ? { connected: true } : null,
    autoblowSync: recorder({
      scriptReady: true,
      uploadScript: vi.fn(async function () { this.scriptReady = true; return true; }),
      stop() { this._active = false; this.scriptReady = false; },
    }),
    audienceBridge: null, handyHdspSync: null, scriptEditor: null, connectionPanel: null,
    remoteBridge: { sendToPhone() {}, connected: true }, sessionTracker: null, vrBridge: null,
    library: {
      _videosByPath: new Map([[PHONE, { name: 'bravo', hasFunscript: true, funscriptPath: 'C:\\v\\gone.funscript' }]]),
      ensureScanned: async () => {}, _videos: [{}], resolveVRVideo: async () => null, getVideoByPath: () => null,
    },
    _videoLoadGen: 1, _customRoutingActive: false, _currentCustomRoutes: null,
    _currentVariants: [], _activeVariantIndex: 0, _variantsPhoneEpoch: null,
    _remoteActive: false, _vrPlayerRef: null, _remotePhoneEpoch: 0, _engineHeldByRemote: false,
    _currentVideoPath: ALPHA, _currentVideoName: 'alpha.mp4', _currentFunscriptPath: ALPHA_FS,
    _resolveCloudUpload() {}, _isDeviceOnMainRoute: () => false,
    _refreshLoopVideoVisibility() {}, _applyVideoSyncOffset() {}, _pushRemoteDeviceStatus() {},
    _updateVariantSelector() {}, _stopGapSkip() {}, _settleVRVideoSyncOffset() {},
  });

  // Alpha open and paused, every device engine running on this window's
  // player, as a library open leaves them.
  for (const e of [app.syncEngine, app.tcodeSync, app.autoblowSync]) { e.player = videoPlayer; e.start(); }
  if (!handy) app.syncEngine.stop();
  if (!autoblow) app.autoblowSync.stop();
  app._tryStartButtplugSync();
  expect(buttplugSync._active).toBe(true);
  return { app, video, sent, buttplugSync };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Play this window's video for `ms` on the fake clock: what reached the stroker. */
async function playLocally(ctx, ms = 2500) {
  ctx.sent.length = 0;
  ctx.video.currentTime = 0.1;
  await ctx.video.play();
  for (let t = 0; t < ms; t += 40) {
    ctx.video.currentTime += 0.04;
    await vi.advanceTimersByTimeAsync(40);
  }
  ctx.video.pause();
  return ctx.sent.length;
}

const running = (app) => ({
  handy: app.syncEngine._active,
  buttplug: app.buttplugSync._active,
  tcode: app.tcodeSync._active,
  autoblow: app.autoblowSync._active,
});
const ALL = { handy: true, buttplug: true, tcode: true, autoblow: true };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('a phone session that never took the engine gives the devices back to this window', () => {
  it('the phone video\'s script cannot be read: after phone Back, a local Play drives the stroker again', async () => {
    const ctx = build();
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id', PHONE);
    expect(ctx.app._engineHeldByRemote).toBe(false);
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();

    expect(running(ctx.app)).toEqual(ALL);
    for (const e of [ctx.app.syncEngine, ctx.app.tcodeSync, ctx.app.autoblowSync, ctx.buttplugSync]) {
      expect(e.player).toBe(ctx.app.videoPlayer);
    }
    expect(await playLocally(ctx)).toBeGreaterThan(0);
    // The Autoblow's stop() dropped its script: this window's went up again.
    expect(ctx.app.autoblowSync.uploadScript).toHaveBeenCalledTimes(1);
  });

  it('an engine that was not running before the session is not started by its end', async () => {
    const ctx = build({ handy: false, autoblow: false });
    ctx.app.handyManager = { connected: true, hsspStop: vi.fn() }; // connected later, never armed
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id', PHONE);
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    expect(running(ctx.app)).toEqual({ handy: false, buttplug: true, tcode: true, autoblow: false });
    expect(ctx.app.autoblowSync.uploadScript).not.toHaveBeenCalled();
  });

  it('a new phone session that starts meanwhile keeps the devices (no resume under it)', async () => {
    const ctx = build();
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id', PHONE);
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    ctx.app._remoteActive = true;             // another phone took over in the same tick
    await settle();
    expect(running(ctx.app)).toEqual({ handy: false, buttplug: false, tcode: false, autoblow: false });
  });
});

describe('a headset session that never took the engine does the same', () => {
  it('the headset link drops before any video: a local Play drives the stroker', async () => {
    const ctx = build();
    ctx.app._stopVRSync();   // the bridge's onDisconnect
    await settle();
    expect(running(ctx.app)).toEqual(ALL);
    expect(await playLocally(ctx)).toBeGreaterThan(0);
  });

  it('a headset video with no script, then the disconnect: the engines the first stop halted come back', async () => {
    const ctx = build();
    ctx.app.vrBridge = { proxy: Object.assign(new EventTarget(), { currentTime: 0, paused: false, duration: 100 }), connected: false };
    await ctx.app._onVRVideoChanged('scene', 'C:\\v\\scene.mp4');   // matches no library video
    await settle();
    expect(ctx.app._engineHeldByRemote).toBe(false);
    ctx.app._stopVRSync();
    await settle();
    expect(running(ctx.app)).toEqual(ALL);
    expect(await playLocally(ctx)).toBeGreaterThan(0);
  });
});
