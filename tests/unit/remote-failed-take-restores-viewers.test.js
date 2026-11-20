/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// verify-2, 2026-11-07 (new since v0.9.2): a phone that leaves before its
// script took the engine left Audience viewers on "No script" for the local
// video still on screen. Repro: room with a viewer, Echo Variants open here,
// the phone taps another scripted video, its read is slow, the phone window
// closes during the read. The room's source became "no script", titled with
// the PHONE's video. A local Space then restarted the streamer's own devices
// (block C's `_resumeLocalSyncAfterRemote`) but never the viewers, until
// another video was opened. `_restoreLocalScriptAfterRemote` returns early
// when the engine was never taken, and that path began no LOCAL source
// again (R4-04 covered only the taken-engine case).
//
// The REAL phone connect / disconnect / restore methods are lifted out of
// app.js (helpers/app-methods.js), the room is the REAL AudienceBridge built
// from the REAL options app.js hands it, with viewer HandyManagers faked to
// the real contract. What is asserted is the script each viewer's device
// holds, and whether it plays.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
import { makeWorld, makeFakeHandyCtor, deviceOf } from './helpers/fake-viewer-handy.js';
import { AudienceBridge, SOURCE_PLAYER, VIEWER_STATUS } from '../../renderer/js/audience-bridge.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import { invertRawScriptContent } from '../../renderer/js/device-transform-stack.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { vrDisplayName, funsyncVideoIdFromVRPath } from '../../renderer/js/vr-bridge.js';

const METHODS = [
  '_onRemotePhoneConnected', '_onRemotePhoneDisconnected', '_stopVRSync', '_onVRVideoChanged',
  '_stashLocalScriptBeforeRemote', '_restoreLocalScriptAfterRemote', '_restoreLocalAudienceSource',
  '_noteSyncStoppedByRemoteTeardown', '_resumeLocalSyncAfterRemote', '_givePhoneVariantListBack',
  '_clearLocalAxesForRemote', '_resetCustomRoutingState',
  '_audienceScriptContent', '_audienceLocalPlayerPlaying', '_fillerOptionsForUpload',
];

const ECHO = 'C:\\sandbox\\library\\Echo Variants.mp4';
const ECHO_FS = 'C:\\sandbox\\library\\Echo Variants.funscript';
const CLIP = 'C:\\sandbox\\library\\Variant Clip.mp4';
const CLIP_FS = 'C:\\sandbox\\library\\Variant Clip.funscript';
const script = (p) => JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 300, pos: p }, { at: 600, pos: 10 }, { at: 900, pos: 90 }] });
const ECHO_RAW = script(80);

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 60; this.playbackRate = 1; }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}

let uploads;
let readGate;

function build() {
  const disk = { [ECHO_FS]: ECHO_RAW, [CLIP_FS]: script(30) };
  readGate = null;
  const fakeWindow = {
    funsync: {
      // The phone's read can be held (the slow read of the repro).
      readFunscript: vi.fn(async (p) => {
        if (p === CLIP_FS && readGate) await readGate.promise;
        return disk[p] ?? null;
      }),
      writeFunscript: vi.fn(async () => { throw new Error('nothing may be written'); }),
    },
  };
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: { getElementById: () => null }, console: quiet,
    showToast: () => ({ dismiss() {} }), t: (k) => k,
    stripBOM, fillRawScriptContent, resolveFillerOptions, invertRawScriptContent,
    RemotePlaybackProxy, SOURCE_PLAYER, vrDisplayName, funsyncVideoIdFromVRPath,
  });
  const video = new FakeVideo();
  const videoPlayer = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
  };
  // Echo Variants' script is in the engine, as its library open left it.
  const funscriptEngine = {
    isLoaded: true,
    _raw: ECHO_RAW,
    getRawContent() { return this._raw; },
    getActions() { return JSON.parse(this._raw).actions; },
    loadContent: vi.fn(async function (content) { JSON.parse(content); this._raw = content; this.isLoaded = true; return { actionCount: 4 }; }),
    clear() { this.isLoaded = false; this._raw = null; },
  };
  const S = { 'player.gapFiller': { enabled: false } };
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: () => {} },
    videoPlayer, funscriptEngine,
    handyManager: null, autoblowManager: null, buttplugManager: null, tcodeManager: null,
    syncEngine: null, buttplugSync: null, tcodeSync: null, autoblowSync: null, handyHdspSync: null,
    remoteBridge: { sendToPhone() {}, connected: true }, sessionTracker: null, vrBridge: null,
    library: {
      _videosByPath: new Map([[CLIP, { name: 'Variant Clip.mp4', hasFunscript: true, funscriptPath: CLIP_FS, variants: [] }]]),
      getVideoByPath: () => null,
    },
    progressBar: null, scriptEditor: null,
    _videoLoadGen: 3, _customRoutingActive: false, _currentVariants: [], _activeVariantIndex: 0,
    _variantsPhoneEpoch: null, _remoteActive: false, _vrPlayerRef: null, _remotePhoneEpoch: 0,
    _engineHeldByRemote: false, _playerWindowActive: false,
    _currentVideoPath: ECHO, _currentVideoName: 'Echo Variants.mp4', _currentFunscriptPath: ECHO_FS,
    _refreshLoopVideoVisibility() {}, _applyVideoSyncOffset() {}, _pushRemoteDeviceStatus() {},
    _updateVariantSelector() {}, _settleVRVideoSyncOffset() {}, _phonePinnedVariant: () => null,
  });
  const world = makeWorld();
  uploads = [];
  const upload = async (content) => { uploads.push(content); return `https://scripts.test/${uploads.length}`; };
  const options = liftCtorOptions('AudienceBridge', {
    eventBus: { emit() {} }, HandyManager: makeFakeHandyCtor(world), uploadScriptToCloud: upload,
  }).call(app);
  app.audienceBridge = new AudienceBridge(options);
  video.addEventListener('playing', () => app.audienceBridge.onPlaying());
  video.addEventListener('pause', () => app.audienceBridge.onPaused());
  return { app, world, video };
}

/** The point at 300 ms of the script on the viewer's device, or null. */
function viewerPointAt300(ctx) {
  const url = deviceOf(ctx.world, 'VIEWERKEY01').url;
  const n = Number(String(url || '').split('/').pop());
  if (!n) return null;
  return JSON.parse(uploads[n - 1]).actions.find((a) => a.at === 300)?.pos ?? null;
}

async function openRoomWithEcho(ctx) {
  ctx.app.audienceBridge.openRoom();
  const p = ctx.app.audienceBridge.addViewer({ key: 'VIEWERKEY01' });
  await vi.runAllTimersAsync();
  await p;
  // Echo's own load gave the room its script (what loadFunscript does).
  const token = ctx.app.audienceBridge.beginSource({ title: 'Echo Variants.funscript', player: SOURCE_PLAYER.LOCAL });
  ctx.app.audienceBridge.setScript(token, { content: () => ctx.app._audienceScriptContent(ECHO_RAW), title: 'Echo Variants.funscript' });
  await vi.runAllTimersAsync();
  expect(viewerPointAt300(ctx)).toBe(80);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('a phone that leaves before its script took the engine gives viewers this window\'s script back', () => {
  it('closed during a slow read: viewers are set up with Echo again, and a local Play plays them', async () => {
    const ctx = build();
    await openRoomWithEcho(ctx);
    let release;
    readGate = { promise: new Promise((r) => { release = r; }) };
    const connecting = ctx.app._onRemotePhoneConnected('192.168.1.5', 'clip', CLIP);
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.app.audienceBridge.source.player).toBe(SOURCE_PLAYER.PHONE);

    ctx.app._onRemotePhoneDisconnected('192.168.1.5'); // the phone window closes mid-read
    await vi.runAllTimersAsync();
    release();
    await connecting;
    await vi.runAllTimersAsync();

    expect(ctx.app._engineHeldByRemote).toBe(false);
    const src = ctx.app.audienceBridge.source;
    expect(src.player).toBe(SOURCE_PLAYER.LOCAL);
    expect(src.kind).toBe('script');
    expect(src.title).toBe('Echo Variants.funscript');
    expect(viewerPointAt300(ctx)).toBe(80);
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(false); // this window is paused

    ctx.video.play(); // a local Space
    await vi.runAllTimersAsync();
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);
    expect(ctx.app.audienceBridge.getViewerStatus('VIEWERKEY01')).toBe(VIEWER_STATUS.PLAYING);
  });

  it('the phone video has no script at all: the same, Echo comes back for the viewers', async () => {
    const ctx = build();
    await openRoomWithEcho(ctx);
    ctx.app.library._videosByPath.set(CLIP, { name: 'Variant Clip.mp4', hasFunscript: false });
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'clip', CLIP);
    expect(ctx.app.audienceBridge.source.kind).toBe('no-script');
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await vi.runAllTimersAsync();
    expect(ctx.app.audienceBridge.source.kind).toBe('script');
    expect(ctx.app.audienceBridge.source.title).toBe('Echo Variants.funscript');
    ctx.video.play();
    await vi.runAllTimersAsync();
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);
  });

  it('this window has no script: the room stays on no script (nothing is made up)', async () => {
    const ctx = build();
    await openRoomWithEcho(ctx);
    ctx.app.funscriptEngine.clear();
    ctx.app.library._videosByPath.set(CLIP, { name: 'Variant Clip.mp4', hasFunscript: false });
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'clip', CLIP);
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await vi.runAllTimersAsync();
    expect(ctx.app.audienceBridge.source.kind).toBe('no-script');
  });

  it('another phone takes over before the restore: its source is left alone', async () => {
    const ctx = build();
    await openRoomWithEcho(ctx);
    ctx.app.library._videosByPath.set(CLIP, { name: 'Variant Clip.mp4', hasFunscript: false });
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'clip', CLIP);
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    // The next phone connects in the same turn, before the restore's first look.
    const next = ctx.app._onRemotePhoneConnected('192.168.1.6', 'clip', CLIP);
    await vi.runAllTimersAsync();
    await next;
    expect(ctx.app.audienceBridge.source.player).toBe(SOURCE_PLAYER.PHONE);
  });
});
