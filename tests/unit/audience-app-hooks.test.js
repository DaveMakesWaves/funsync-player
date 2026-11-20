/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// #361 — every app.js path that changes the script drives the audience
// room's source, and the room never depends on the streamer's own Handy.
//
// app.js instantiates itself on import, so the REAL methods are lifted out of
// it (tests/unit/helpers/app-methods.js) and run against stubs for what they
// touch that is not under test. The AudienceBridge is REAL, built from the
// REAL options object app.js hands `new AudienceBridge({...})`, with viewer
// HandyManagers faked to the real contract and a keyless uploader that never
// touches the network. What is asserted is what each viewer's device did,
// and what script it was given.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudienceBridge, VIEWER_STATUS, SOURCE_PLAYER } from '../../renderer/js/audience-bridge.js';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
import { makeWorld, makeFakeHandyCtor, makeUploader, deviceOf, landed, urlFor } from './helpers/fake-viewer-handy.js';
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
import { SessionTracker } from '../../renderer/js/session-tracker.js';

const METHODS = [
  'loadVideo', 'loadFunscript', '_loadPlayContent', '_switchVariant',
  '_onVRVideoChanged', '_onRemotePhoneConnected',
  // The REAL teardowns: a VR or phone session ending must end its source.
  '_stopVRSync', '_onRemotePhoneDisconnected', '_cycleVariant', '_refreshCurrentVariantsFromDisk',
  '_givePhoneVariantListBack', // FT-092: the teardown gives the phone's variant list back at once
  '_audienceScriptContent', '_audienceLocalPlayerPlaying', '_fillerOptionsForUpload',
  '_uploadAndStartSync', '_handyUploadContent', '_handyInverted', '_cutoffFromSettings',
  '_autoblowUploadContent', '_sessionTimelineMs', '_uploadDurationMsFor', // FT-113: every cloud upload's chain
  '_editorAllowsReplace', // CB-01's unsaved-edits question (no editor here: no question)
];

/** A raw funscript identified by `label`: narrow (30-70) with a long gap
 *  in the middle, so a Range Extender, an invert, an output limit and a gap
 *  filler would each visibly change it. */
function narrowScript(label) {
  const actions = [];
  for (let at = 0; at <= 4000; at += 500) actions.push({ at, pos: at % 1000 ? 70 : 30 });
  for (let at = 30000; at <= 34000; at += 500) actions.push({ at, pos: at % 1000 ? 70 : 30 });
  return JSON.stringify({ version: '1.0', _label: label, actions });
}

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 120;
    this.playbackRate = 1;
  }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}

function build({ settings: settingsOver = {}, uploader, deps = {} } = {}) {
  const world = makeWorld();
  const up = uploader || makeUploader();
  const toasts = [];
  const showToast = (msg, type) => { toasts.push({ msg, type }); return { dismiss() {} }; };
  const t = (key) => key;
  const fakeWindow = { funsync: { readFunscript: vi.fn(async () => null) } };
  const fakeDocument = { getElementById: () => ({ hidden: false, innerHTML: '', textContent: '', dataset: {} }) };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: fakeDocument, console: quiet,
    showToast, t, stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    vrDisplayName, funsyncVideoIdFromVRPath, normalizeAssociation, resolveActiveConfig,
    RemotePlaybackProxy, pathToFileURL, URL, SOURCE_PLAYER,
    maybeShowHevcGuidance: () => {}, isAutoMatch: () => false,
    ...deps,
  });
  const S = {
    // The streamer's own device preferences — none of them may reach a
    // viewer (Dave, D1 2026-11-04).
    'player.rangeExtender.enabled': true,
    'handy.inverted': true,
    'handy.cutoff': { min: 40, max: 60 },
    // The gap filler is a content choice — it does reach viewers.
    'player.gapFiller': { enabled: true, presetId: 'slowTease', thresholdMs: 5000 },
    'player.gapSkip': { mode: 'off' },
    'library.associations': {},
    ...settingsOver,
  };
  const video = new FakeVideo();
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: () => {}, addRecentFile() {} },
    videoPlayer: { video, duration: NaN, loadSource() {}, clearSubtitles() {} },
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {} },
    funscriptEngine: {
      isLoaded: false,
      clear() {},
      loadContent: vi.fn(async () => ({ filename: 'x', actionCount: 2 })),
      loadFile: vi.fn(async () => ({ filename: 'x', actionCount: 2 })),
      getActions: () => [],
      getChapters: () => [],
      getBookmarks: () => [],
    },
    handyManager: null,          // NO streamer Handy throughout
    autoblowManager: null,
    buttplugSync: null, tcodeSync: null, autoblowSync: null, syncEngine: null, handyHdspSync: null,
    scriptEditor: null, remoteBridge: null, sessionTracker: null, vrBridge: null, library: null,
    _videoLoadGen: 0, _pendingFunscripts: [], _customRoutingActive: false,
    _currentVariants: [], _allVariantsWithManual: [], _activeVariantIndex: 0,
    _remoteActive: false, _playerWindowActive: false, _vrPlayerRef: null,
    // As the constructor sets them.
    _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    // Called by the lifted methods; not under test.
    _maybePushCurrentToHistory() {}, _ensureVideoLoadWatch() {}, _disarmLoadAutoplay() {},
    _stopGapSkip() {}, _startGapSkip() {}, _clearCloudUploadGate() {}, _hideScriptLoadingOverlay() {},
    _showScriptLoadingOverlay() {}, _feedInlineViz() {}, _navigateTo() {}, _updateCategoryDots() {},
    _updateQueuePanelState() {}, _applyVRFlattenForCurrent() {}, _autoMatchEroScripts() {},
    _feedEmbeddedMultiAxis() {}, _showFunscriptBadge: vi.fn(), _refreshEditorScriptList() {},
    _isDeviceOnMainRoute: () => true, _resolveCloudUpload() {},
    _tryStartButtplugSync() {}, _tryStartTCodeSync() {}, _tryStartAutoblowSync: async () => {},
    _updateVariantSelector() {}, _loadMultiAxisScripts() {}, _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {}, _formatActionsDuration: () => '0:00',
    _healManualVariantPath() {}, _markCloudUploadsPending() {},
    _resetCustomRoutingState() {}, _pushRemoteDeviceStatus() {}, _refreshLoopVideoVisibility() {},
  });
  // The REAL options app.js passes, bound to this app.
  const bus = { emit: () => {} };
  const options = liftCtorOptions('AudienceBridge', {
    eventBus: bus,
    HandyManager: makeFakeHandyCtor(world),
    uploadScriptToCloud: up.upload,
  }).call(app);
  app.audienceBridge = new AudienceBridge(options);
  // The local <video>'s audience listeners, as app.js wires them.
  video.addEventListener('playing', () => app.audienceBridge.onPlaying());
  video.addEventListener('pause', () => app.audienceBridge.onPaused());
  return { app, world, uploader: up, video, toasts, fakeWindow, options };
}

const settle = () => vi.runAllTimersAsync();

async function openWithViewers(ctx, keys = ['A', 'B']) {
  ctx.app.audienceBridge.openRoom();
  for (const key of keys) {
    const p = ctx.app.audienceBridge.addViewer({ key });
    await settle();
    await p;
  }
}

/** A VR bridge as _onVRVideoChanged / _stopVRSync use it. `connected:
 *  false` so the session-card poll the real _stopVRSync re-arms clears
 *  itself on its first tick instead of running forever under fake timers. */
function fakeVrBridge() {
  return { proxy: Object.assign(new EventTarget(), { currentTime: 0, paused: false, duration: 100 }), connected: false };
}

/** A library that resolves every VR report to `label`'s video + script. */
function vrLibrary(ctx, label) {
  ctx.app.library = {
    ensureScanned: async () => {},
    _videos: [{}],
    resolveVRVideo: async () => ({ hasFunscript: true, funscriptPath: `C:\\v\\${label}.funscript`, path: `C:\\v\\${label}.mp4`, name: label }),
  };
  ctx.fakeWindow.funsync.readFunscript = vi.fn(async (p) => narrowScript(p.split('\\').pop().replace('.funscript', '')));
}

const playsSent = (ctx) => ctx.world.sent.filter((e) => e.kind === 'play');

/** Load `label` the way a library click does: a new video, then its script. */
async function openVideo(ctx, label) {
  ctx.app.loadVideo({ name: `${label}.mp4`, path: `C:\\v\\${label}.mp4`, _isPathBased: true }, { autoPlay: false });
  ctx.app.loadFunscript({ textContent: narrowScript(label), name: `${label}.funscript` });
  await settle();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('app.js hands the bridge what it needs, and nothing of the streamer', () => {
  it('the bridge options carry the keyless uploader and no streamer cloud URL', () => {
    const ctx = build();
    expect(ctx.options.uploadScript).toBe(ctx.uploader.upload);
    expect('getCurrentScriptUrl' in ctx.options).toBe(false);
  });

  it('a library video plays on every viewer with NO streamer Handy connected', async () => {
    const ctx = build();
    await openWithViewers(ctx);
    await openVideo(ctx, 'first');
    ctx.video.play();
    await settle();
    for (const k of ['A', 'B']) {
      expect(deviceOf(ctx.world, k)).toMatchObject({ playing: true, playUrl: urlFor('first') });
    }
  });

  it('viewers get the script plus the gap filler — never the streamer\'s Range Extender, output limits or Handy invert', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    const raw = narrowScript('d1');
    ctx.app.loadVideo({ name: 'd1.mp4', path: 'C:\\v\\d1.mp4', _isPathBased: true }, { autoPlay: false });
    ctx.app.loadFunscript({ textContent: raw, name: 'd1.funscript' });
    await settle();
    expect(ctx.uploader.uploads.length).toBe(1);
    const sent = JSON.parse(ctx.uploader.uploads[0].content).actions;
    const authored = JSON.parse(raw).actions;
    // Every authored point reaches the viewer exactly as written: not
    // stretched to 0-100, not flipped, not clamped to 40-60.
    for (const a of authored) {
      expect(sent.find((s) => s.at === a.at)).toEqual({ at: a.at, pos: a.pos });
    }
    // The 26 s gap is filled.
    expect(sent.some((s) => s.at > 4000 && s.at < 30000)).toBe(true);
    // The streamer's own upload of the same script is a different script.
    expect(ctx.app._handyUploadContent(raw)).not.toBe(ctx.uploader.uploads[0].content);
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('d1'));
  });

  it('with the gap filler off, viewers get the script exactly as authored', async () => {
    const ctx = build({ settings: { 'player.gapFiller': { enabled: false } } });
    await openWithViewers(ctx, ['A']);
    const raw = narrowScript('plain');
    ctx.app.loadVideo({ name: 'plain.mp4', path: 'C:\\v\\plain.mp4', _isPathBased: true }, { autoPlay: false });
    ctx.app.loadFunscript({ textContent: raw, name: 'plain.funscript' });
    await settle();
    expect(ctx.uploader.uploads[0].content).toBe(raw);
  });
});

describe('every script-changing path drives the room source', () => {
  it('a new video stops viewers playing the old one, and they never play the old script on it', async () => {
    const ctx = build();
    await openWithViewers(ctx);
    await openVideo(ctx, 'old');
    ctx.video.play();
    await settle();
    // A dropped video with no script (no loadFunscript follows).
    ctx.app.loadVideo({ name: 'drop.mp4', path: 'C:\\v\\drop.mp4', _isPathBased: true }, { autoPlay: false });
    await settle();
    ctx.video.play();
    await settle();
    for (const k of ['A', 'B']) {
      expect(deviceOf(ctx.world, k).playing).toBe(false);
      expect(ctx.app.audienceBridge.getViewerStatus(k)).toBe(VIEWER_STATUS.WAITING);
    }
  });

  it('a funscript dropped on its own mid-play (no loadVideo) stops viewers, sets it up, and plays it', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'old');
    ctx.video.play();
    await settle();
    const before = landed(ctx.world, 'A').length;
    ctx.app.loadFunscript({ textContent: narrowScript('dropped'), name: 'dropped.funscript' });
    await settle();
    expect(landed(ctx.world, 'A').slice(before)).toEqual(['stop', 'setup', 'play']);
    expect(deviceOf(ctx.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('dropped') });
  });

  it('a library video with no main script (companions only) leaves viewers stopped with "No script"', async () => {
    const ctx = build();
    await openWithViewers(ctx);
    await openVideo(ctx, 'old');
    ctx.video.play();
    await settle();
    ctx.app.loadVideo({ name: 'axes.mp4', path: 'C:\\v\\axes.mp4', _isPathBased: true }, { autoPlay: false });
    await ctx.app._loadPlayContent({ path: 'C:\\v\\axes.mp4' }, { textContent: null, _multiAxis: { axes: { twist: 'C:\\v\\axes.twist.funscript' } } }, null, []);
    await settle();
    for (const k of ['A', 'B']) {
      expect(ctx.app.audienceBridge.getViewerStatus(k)).toBe(VIEWER_STATUS.NO_SCRIPT);
      expect(deviceOf(ctx.world, k).playing).toBe(false);
    }
  });

  it('a variant switch whose read fails leaves viewers on the variant still playing; a good one moves them', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'main');
    ctx.video.play();
    await settle();
    ctx.app._allVariantsWithManual = [
      { path: 'C:\\v\\main.funscript', label: 'Main' },
      { path: 'C:\\v\\main.soft.funscript', label: 'Soft', name: 'main.soft.funscript' },
    ];
    ctx.app._activeVariantIndex = 0;
    const before = landed(ctx.world, 'A').length;
    ctx.app._readScriptResilient = async () => null;
    await ctx.app._switchVariant(1);
    await settle();
    expect(landed(ctx.world, 'A').length).toBe(before);     // nothing sent
    expect(deviceOf(ctx.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('main') });

    ctx.app._activeVariantIndex = 0;
    ctx.app._readScriptResilient = async () => ({ content: narrowScript('soft') });
    await ctx.app._switchVariant(1);
    await settle();
    expect(deviceOf(ctx.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('soft') });
  });

  it('a variant that reads but fails to load leaves viewers stopped, never on the old variant, reading "Couldn\'t load the script"', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'main');
    ctx.video.play();
    await settle();
    ctx.app._allVariantsWithManual = [
      { path: 'C:\\v\\main.funscript', label: 'Main' },
      { path: 'C:\\v\\main.bad.funscript', label: 'Bad', name: 'main.bad.funscript' },
    ];
    ctx.app._activeVariantIndex = 0;
    ctx.app._readScriptResilient = async () => ({ content: '{"actions":[' });
    ctx.app.funscriptEngine.loadContent = vi.fn(async () => { throw new Error('bad json'); });
    await ctx.app._switchVariant(1);
    await settle();
    expect(deviceOf(ctx.world, 'A').playing).toBe(false);
    // The video HAS a script; it just could not be loaded. "No script for
    // this video" would send the streamer looking for a missing file.
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.SCRIPT_FAILED);
  });

  it('a VR video change that returns early (no library) stops viewers with "No script"', async () => {
    const ctx = build();
    await openWithViewers(ctx);
    await openVideo(ctx, 'local');
    ctx.video.play();
    await settle();
    await ctx.app._onVRVideoChanged('scene', 'http://quest/scene.mp4');
    await settle();
    for (const k of ['A', 'B']) {
      expect(deviceOf(ctx.world, k).playing).toBe(false);
      expect(ctx.app.audienceBridge.getViewerStatus(k)).toBe(VIEWER_STATUS.NO_SCRIPT);
    }
  });

  it('a VR video with a script: viewers get it set up, and stay stopped while VR drives playback', async () => {
    const ctx = build();
    await openWithViewers(ctx);
    ctx.app.library = {
      ensureScanned: async () => {},
      _videos: [{}],
      resolveVRVideo: async () => ({ hasFunscript: true, funscriptPath: 'C:\\v\\scene.funscript', path: 'C:\\v\\scene.mp4', name: 'scene' }),
    };
    ctx.app.vrBridge = fakeVrBridge();
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('scene'));
    await ctx.app._onVRVideoChanged('scene', 'C:\\v\\scene.mp4');
    await settle();
    // Not READY (green): a phone's or headset's script is never played by viewers, and "Ready" read as "will play" (verify-2, 2026-11-07).
    for (const k of ['A', 'B']) expect(ctx.app.audienceBridge.getViewerStatus(k)).toBe(VIEWER_STATUS.REMOTE_HELD);
    // The inline element playing is not the active player while VR is.
    ctx.video.play();
    await settle();
    expect(ctx.world.sent.filter((e) => e.kind === 'play')).toEqual([]);
  });

  it('a phone video with no script stops viewers with "No script"; with a script they stay stopped while the phone drives', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    ctx.video.play();
    await settle();
    ctx.app.remoteBridge = { sendToPhone() {}, connected: true };
    const videos = new Map([
      ['C:\\v\\none.mp4', { name: 'none', hasFunscript: false }],
      ['C:\\v\\phone.mp4', { name: 'phone', hasFunscript: true, funscriptPath: 'C:\\v\\phone.funscript', variants: [] }],
    ]);
    ctx.app.library = { _videosByPath: videos };
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', 'C:\\v\\none.mp4');
    await settle();
    expect(deviceOf(ctx.world, 'A').playing).toBe(false);
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);

    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await settle();
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('phone'));
    expect(ctx.app._remoteActive).toBe(true);
    ctx.video.play();
    await settle();
    expect(deviceOf(ctx.world, 'A').playing).toBe(false);
  });
});

// Review of #361 (2026-11-04): the room's source outlived a VR or phone
// session. Once the headset or the phone let go, the local video's next
// play started viewers on the script of the video the headset or the phone
// had been playing, at the local video's time — the hard rule broken by a
// path no test drove. These run the REAL teardowns.
describe('a VR or phone source ends with its session', () => {
  it('VR disconnects, then the local video plays: viewers never play the headset\'s script, and read "No script"', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    vrLibrary(ctx, 'scene');
    ctx.app.vrBridge = fakeVrBridge();
    await ctx.app._onVRVideoChanged('scene', 'C:\\v\\scene.mp4');
    await settle();
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('scene'));    // set up, stopped
    ctx.app._stopVRSync();                                          // vrBridge.onDisconnect
    await settle();
    expect(ctx.app._vrPlayerRef).toBe(null);
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);
    ctx.video.currentTime = 42;
    ctx.video.play();
    await settle();
    expect(playsSent(ctx)).toEqual([]);
    expect(deviceOf(ctx.world, 'A').playing).toBe(false);
  });

  it('a second VR video while the first is bound: its own script is still set up (its source begins after the teardown)', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    vrLibrary(ctx, 'one');
    ctx.app.vrBridge = fakeVrBridge();
    await ctx.app._onVRVideoChanged('one', 'C:\\v\\one.mp4');
    await settle();
    expect(ctx.app._vrPlayerRef).not.toBe(null);
    vrLibrary(ctx, 'two');
    await ctx.app._onVRVideoChanged('two', 'C:\\v\\two.mp4');
    await settle();
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('two'));
    // Not READY (green): a phone's or headset's script is never played by viewers, and "Ready" read as "will play" (verify-2, 2026-11-07).
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.REMOTE_HELD);
  });

  it('the phone disconnects, then the local video plays: viewers never play the phone\'s script, and read "No script"', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    ctx.app.remoteBridge = { sendToPhone() {}, connected: true };
    ctx.app.library = { _videosByPath: new Map([['C:\\v\\phone.mp4', { name: 'phone', hasFunscript: true, funscriptPath: 'C:\\v\\phone.funscript', variants: [] }]]) };
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await settle();
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('phone'));
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);
    ctx.video.play();
    await settle();
    expect(playsSent(ctx)).toEqual([]);
    expect(deviceOf(ctx.world, 'A').playing).toBe(false);
  });

  it('a phone load still in flight when the phone disconnects never sets the phone\'s script up afterwards', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    ctx.app.remoteBridge = { sendToPhone() {}, connected: true };
    ctx.app.library = { _videosByPath: new Map([['C:\\v\\phone.mp4', { name: 'phone', hasFunscript: true, funscriptPath: 'C:\\v\\phone.funscript', variants: [] }]]) };
    ctx.fakeWindow.funsync.readFunscript = vi.fn(() => new Promise((r) => setTimeout(() => r(narrowScript('phone')), 1000)));
    const loading = ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await vi.advanceTimersByTimeAsync(100);
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    await loading;
    expect(ctx.world.sent.filter((e) => e.kind === 'setup')).toEqual([]);
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);
  });

  it('the local video played while the phone\'s session is still being prepared: viewers do not play the phone\'s script', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    ctx.app.remoteBridge = { sendToPhone() {}, connected: true };
    ctx.app.library = { _videosByPath: new Map([['C:\\v\\phone.mp4', { name: 'phone', hasFunscript: true, funscriptPath: 'C:\\v\\phone.funscript', variants: [] }]]) };
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    // A slow device upload holds the phone path between its setScript and
    // `_remoteActive = true`: the inline player is still "the" player then.
    ctx.app.autoblowManager = { connected: true };
    ctx.app.autoblowSync = { _active: false, uploadScript: () => new Promise((r) => setTimeout(r, 3000)), start() {}, stop() {} };
    const connecting = ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('phone'));
    expect(ctx.app._remoteActive).toBe(false);
    ctx.video.play();
    await settle();
    await connecting;
    expect(playsSent(ctx)).toEqual([]);
  });

  it('a variant tapped on the phone ends with the phone session: the local video then never plays it', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    ctx.app.remoteBridge = { sendToPhone() {}, connected: true };
    ctx.app.library = { _videosByPath: new Map([['C:\\v\\phone.mp4', { name: 'phone', hasFunscript: true, funscriptPath: 'C:\\v\\phone.funscript', variants: [] }]]) };
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await settle();
    ctx.app._allVariantsWithManual = [
      { path: 'C:\\v\\phone.funscript', label: 'Main' },
      { path: 'C:\\v\\phone.soft.funscript', label: 'Soft', name: 'phone.soft.funscript' },
    ];
    ctx.app._activeVariantIndex = 0;
    ctx.app._readScriptResilient = async () => ({ content: narrowScript('phonesoft') });
    await ctx.app._switchVariant(1);
    await settle();
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('phonesoft'));
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    ctx.video.play();
    await settle();
    expect(playsSent(ctx)).toEqual([]);
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);
  });
});

// Review of #361, round 2 (2026-11-04). Whose variant a switch is used to come
// from `_remoteActive`, which is false while the phone's session is still
// being prepared AND once the phone has let go; and the phone video's variant
// list stays on the desktop after the phone goes. So one V press after the
// phone left started viewers on the phone video's variant at the local
// video's time. And a phone that let go mid-load left `_remoteActive` true:
// rows read Ready (green) on every later local video, and no viewer played.
describe('the phone\'s variant list and a phone load outlive nothing', () => {
  const PHONE_VARIANTS = [
    { path: 'C:\\v\\phone.funscript', label: 'Main' },
    { path: 'C:\\v\\phone.soft.funscript', label: 'Soft', name: 'phone.soft.funscript' },
  ];
  function phoneLibrary(ctx) {
    ctx.app.remoteBridge = { sendToPhone() {}, connected: true };
    ctx.app.library = { _videosByPath: new Map([['C:\\v\\phone.mp4', { name: 'phone', hasFunscript: true, funscriptPath: 'C:\\v\\phone.funscript', variants: PHONE_VARIANTS }]]) };
    // As the real _updateVariantSelector builds it (no manual variants here):
    // the list on screen is the one `_currentVariants` holds, which the
    // phone's teardown gives back (FT-092).
    ctx.app._updateVariantSelector = function () { this._allVariantsWithManual = [...this._currentVariants]; };
    ctx.app._allVariantsWithManual = PHONE_VARIANTS.slice();
    ctx.app._readScriptResilient = async () => ({ content: narrowScript('phonesoft') });
  }
  const uploadedLabels = (ctx) => ctx.uploader.uploads.map((u) => JSON.parse(u.content)._label);

  it('the phone disconnects, then the streamer presses V on the desktop: viewers never play the phone video\'s variant on the local video', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    phoneLibrary(ctx);
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await settle();
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    // The desktop no longer offers the phone video's variants (FT-092): the
    // local video has none, so V does nothing. Until FT-092 this test pinned
    // the old behaviour as correct (`_activeVariantIndex` 1, "the streamer's
    // switch still happens"): the phone's Soft loaded onto the streamer's own
    // engine and devices after the phone had gone.
    ctx.app._activeVariantIndex = 0;
    ctx.app._cycleVariant(1);
    await settle();
    expect(ctx.app._activeVariantIndex).toBe(0);
    expect(ctx.app._allVariantsWithManual).toEqual([]);
    expect(ctx.app.funscriptEngine.loadContent).not.toHaveBeenCalledWith(narrowScript('phonesoft'), expect.anything());
    ctx.video.currentTime = 42;
    ctx.video.play();
    await settle();
    expect(playsSent(ctx)).toEqual([]);
    expect(deviceOf(ctx.world, 'A').playing).toBe(false);
    expect(uploadedLabels(ctx)).not.toContain('phonesoft');
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);
  });

  it('a variant switched while the phone\'s session is still being prepared is the phone\'s, and ends with it; the load then stops', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    phoneLibrary(ctx);
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    // A slow device upload holds the phone path before `_remoteActive = true`.
    ctx.app.autoblowManager = { connected: true };
    ctx.app.autoblowSync = { _active: false, uploadScript: () => new Promise((r) => setTimeout(r, 3000)), start() {}, stop() {} };
    const connecting = ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.app._remoteActive).toBe(false);
    ctx.app._activeVariantIndex = 0;
    await ctx.app._switchVariant(1);
    await vi.advanceTimersByTimeAsync(500);      // the upload still holds the phone path
    expect(ctx.app._remoteActive).toBe(false);
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('phonesoft'));   // set up, stopped
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    await connecting;
    expect(ctx.app._remoteActive).toBe(false);
    ctx.video.play();
    await settle();
    expect(playsSent(ctx)).toEqual([]);
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);
  });

  it('a phone that disconnects mid-load leaves nothing behind: the next local video plays on every viewer', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    phoneLibrary(ctx);
    ctx.fakeWindow.funsync.readFunscript = vi.fn(() => new Promise((r) => setTimeout(() => r(narrowScript('phone')), 1000)));
    const loading = ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await vi.advanceTimersByTimeAsync(100);
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    await loading;
    expect(ctx.app._remoteActive).toBe(false);
    // The streamer's own engine was not loaded with the phone's script after
    // the phone had gone.
    expect(ctx.app.funscriptEngine.loadContent).not.toHaveBeenCalledWith(narrowScript('phone'), expect.anything());

    await openVideo(ctx, 'later');
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.READY);
    ctx.video.play();
    await settle();
    expect(deviceOf(ctx.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('later') });
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.PLAYING);
  });

  const LOCAL_VARIANTS = [
    { path: 'C:\\v\\local.funscript', label: 'Main' },
    { path: 'C:\\v\\local.soft.funscript', label: 'Soft', name: 'local.soft.funscript' },
  ];
  /** A phone session that has come and gone; the desktop keeps its list. */
  async function phoneCameAndWent(ctx) {
    phoneLibrary(ctx);
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await settle();
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
  }
  async function pressVForLocalSoftAndPlay(ctx) {
    ctx.app._allVariantsWithManual = LOCAL_VARIANTS.slice();
    ctx.app._activeVariantIndex = 0;
    ctx.app._readScriptResilient = async () => ({ content: narrowScript('localsoft') });
    ctx.app._cycleVariant(1);
    await settle();
    ctx.video.play();
    await settle();
  }

  it('after a phone session, the next local video\'s own variants are its own again: V plays them on viewers', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await phoneCameAndWent(ctx);
    await openVideo(ctx, 'local');               // loadVideo: a new list, the local video's
    await pressVForLocalSoftAndPlay(ctx);
    expect(deviceOf(ctx.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('localsoft') });
  });

  it('the variant menu\'s rescan of the local video\'s folder gives the list back to the local video', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    await phoneCameAndWent(ctx);
    ctx.app._currentVideoPath = 'C:\\v\\local.mp4';
    ctx.fakeWindow.funsync.scanDirectory = vi.fn(async () => ({ videos: [{ path: 'C:\\v\\local.mp4', variants: LOCAL_VARIANTS }] }));
    expect(await ctx.app._refreshCurrentVariantsFromDisk()).toBe(true);
    await pressVForLocalSoftAndPlay(ctx);
    expect(deviceOf(ctx.world, 'A')).toMatchObject({ playing: true, playUrl: urlFor('localsoft') });
  });

  it('a phone variant tapped while the phone still drives is still the phone\'s (the phone\'s own path is unchanged)', async () => {
    const ctx = build();
    await openWithViewers(ctx, ['A']);
    phoneLibrary(ctx);
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async () => narrowScript('phone'));
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id2', 'C:\\v\\phone.mp4');
    await settle();
    expect(ctx.app._remoteActive).toBe(true);
    ctx.app._activeVariantIndex = 0;
    await ctx.app._switchVariant(1);
    await settle();
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('phonesoft'));
    expect(ctx.app.audienceBridge.source).toMatchObject({ player: SOURCE_PLAYER.PHONE, kind: 'script' });
  });
});

describe('viewer content is built only when a viewer needs it', () => {
  it('with no room open, loading scripts builds nothing for viewers; the first viewer to join gets it built once', async () => {
    const fill = vi.fn(fillRawScriptContent);
    const ctx = build({ deps: { fillRawScriptContent: fill } });
    await openVideo(ctx, 'quiet');
    ctx.app.loadFunscript({ textContent: narrowScript('quiet2'), name: 'quiet2.funscript' });
    await settle();
    expect(fill).not.toHaveBeenCalled();
    await openWithViewers(ctx, ['A', 'B']);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(ctx.uploader.uploads.length).toBe(1);
    for (const k of ['A', 'B']) expect(deviceOf(ctx.world, k).url).toBe(urlFor('quiet2'));
  });

  it('a viewer-content build that throws never breaks the streamer\'s own load; viewers read "Couldn\'t load the script"', async () => {
    const ctx = build({ deps: { fillRawScriptContent: () => { throw new Error('filler blew up'); } } });
    await openWithViewers(ctx, ['A']);
    ctx.app.loadVideo({ name: 'boom.mp4', path: 'C:\\v\\boom.mp4', _isPathBased: true }, { autoPlay: false });
    ctx.app.loadFunscript({ textContent: narrowScript('boom'), name: 'boom.funscript' });
    await settle();
    expect(ctx.toasts.filter((x) => x.msg === 'toast.scriptLoadFailed')).toEqual([]);
    expect(ctx.app._showFunscriptBadge).toHaveBeenCalled();
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.SCRIPT_FAILED);
    expect(ctx.uploader.uploads).toEqual([]);
  });
});

// FT-092 (2026-11-07; also in v0.9.2). After a phone session the desktop kept
// the phone video's variant list until the script restore's first await
// (R4-04), or for good under a headset that took over, and a pick from it
// loaded the phone video's script onto the STREAMER's own engine, Handy and
// Autoblow; a pick still being read when the phone let go did the same. And
// a second connect from the same phone (another video picked before the first
// was ready) skips startSession, so the first load was never told to stop and
// its read and uploads could land after the second's. Asserted on what the
// streamer's own engine was loaded with and what its Handy was sent.
describe('FT-092: nothing of a phone session reaches the streamer\'s devices once it is over', () => {
  const IP = '192.168.1.5';
  const PHONE_VARIANTS = [
    { path: 'C:\\v\\phone.funscript', label: 'Main' },
    { path: 'C:\\v\\phone.soft.funscript', label: 'Soft', name: 'phone.soft.funscript' },
  ];
  const labelOf = (c) => { try { return JSON.parse(c)._label; } catch { return null; } };

  /** The streamer's own engine, Handy and Autoblow, recording (fakes, no key). */
  function streamerDevices(ctx) {
    const rec = { engine: [], handy: [], abStops: 0 };
    const engine = ctx.app.funscriptEngine;
    engine.loadContent = vi.fn(async function (content) {
      this.isLoaded = true; this._raw = content; rec.engine.push(labelOf(content));
      return { filename: 'x', actionCount: 2 };
    });
    engine.getRawContent = function () { return this._raw || null; };
    ctx.app.handyManager = {
      connected: true,
      uploadAndSetScript: vi.fn(async (c) => { rec.handy.push(labelOf(c)); return true; }),
      hsspStop: vi.fn(async () => true),
    };
    ctx.app.syncEngine = { _active: false, _scriptReady: false, player: null, start() { this._active = true; }, stop() { this._active = false; } };
    ctx.app.autoblowManager = { connected: true };
    ctx.app.autoblowSync = {
      _active: false, player: null,
      uploadScript: vi.fn(async () => true),
      start() { this._active = true; },
      stop() { this._active = false; rec.abStops++; },
    };
    ctx.app._tryStartAutoblowSync = vi.fn(async () => {});
    return rec;
  }

  function phoneSession(ctx, videos = { 'C:\\v\\phone.mp4': { name: 'phone', hasFunscript: true, funscriptPath: 'C:\\v\\phone.funscript', variants: PHONE_VARIANTS } }) {
    ctx.app.remoteBridge = { sendToPhone() {}, connected: true };
    ctx.app.library = { _videosByPath: new Map(Object.entries(videos)) };
    ctx.app.sessionTracker = new SessionTracker({ settings: ctx.app.settings });
    // As the real _updateVariantSelector builds it (no manual variants here).
    ctx.app._updateVariantSelector = function () { this._allVariantsWithManual = [...this._currentVariants]; };
    ctx.fakeWindow.funsync.readFunscript = vi.fn(async (p) => narrowScript(p.split('\\').pop().replace('.funscript', '')));
  }

  it('V after the phone left loads nothing on the streamer\'s devices: the list on screen is this window\'s again at once', async () => {
    const ctx = build();
    const rec = streamerDevices(ctx);
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    phoneSession(ctx);
    await ctx.app._onRemotePhoneConnected(IP, 'id2', 'C:\\v\\phone.mp4');
    await settle();
    expect(ctx.app._allVariantsWithManual.map((v) => v.label)).toEqual(['Main', 'Soft']);
    ctx.app._readScriptResilient = vi.fn(async () => ({ content: narrowScript('phonesoft') }));
    ctx.app._onRemotePhoneDisconnected(IP);
    // The teardown's own stop of the Autoblow is counted from here.
    const stopsBefore = rec.abStops;
    ctx.app._tryStartAutoblowSync.mockClear();
    // Given back in the teardown itself, before anything can be picked.
    expect(ctx.app._allVariantsWithManual).toEqual([]);
    expect(ctx.app._variantsPhoneEpoch).toBe(null);
    ctx.app._cycleVariant(1);
    await ctx.app._switchVariant(1);
    await settle();
    expect(ctx.app._readScriptResilient).not.toHaveBeenCalled();
    expect(rec.engine).not.toContain('phonesoft');
    expect(rec.handy).not.toContain('phonesoft');
    expect(rec.abStops).toBe(stopsBefore);
    expect(ctx.app._tryStartAutoblowSync).not.toHaveBeenCalled();
  });

  it('a phone variant still being read when the phone lets go loads nothing on the streamer\'s devices', async () => {
    const ctx = build();
    const rec = streamerDevices(ctx);
    await openWithViewers(ctx, ['A']);
    await openVideo(ctx, 'local');
    phoneSession(ctx);
    await ctx.app._onRemotePhoneConnected(IP, 'id2', 'C:\\v\\phone.mp4');
    await settle();
    expect(ctx.app._remoteActive).toBe(true);
    // The phone taps Soft; its read is slow.
    ctx.app._readScriptResilient = () => new Promise((r) => setTimeout(() => r({ content: narrowScript('phonesoft') }), 1000));
    const switching = ctx.app._switchVariant(1);
    await vi.advanceTimersByTimeAsync(100);
    ctx.app._onRemotePhoneDisconnected(IP);
    // The teardown's own stop of the Autoblow is counted from here.
    const stopsBefore = rec.abStops;
    ctx.app._tryStartAutoblowSync.mockClear();
    await settle();
    await switching;
    expect(rec.engine).not.toContain('phonesoft');
    expect(rec.handy).not.toContain('phonesoft');
    expect(rec.abStops).toBe(stopsBefore);
    expect(ctx.app._tryStartAutoblowSync).not.toHaveBeenCalled();
    // This window's own list and pick (the local video has one script).
    expect(ctx.app._activeVariantIndex).toBe(0);
    expect(ctx.app._allVariantsWithManual).toEqual([]);
    // Viewers read the phone's source ending, not a phone variant set up.
    expect(ctx.app.audienceBridge.getViewerStatus('A')).toBe(VIEWER_STATUS.NO_SCRIPT);
    expect(deviceOf(ctx.world, 'A').url).not.toBe(urlFor('phonesoft'));
  });

  it('a second connect from the same phone supersedes the first load: the engine and the Handy end on the second video', async () => {
    const ctx = build();
    const rec = streamerDevices(ctx);
    await openWithViewers(ctx, ['A']);
    phoneSession(ctx, {
      'C:\\v\\first.mp4': { name: 'first', hasFunscript: true, funscriptPath: 'C:\\v\\first.funscript', variants: [] },
      'C:\\v\\second.mp4': { name: 'second', hasFunscript: true, funscriptPath: 'C:\\v\\second.funscript', variants: [] },
    });
    // The first video's script is slow to read; the second's is quick.
    ctx.fakeWindow.funsync.readFunscript = vi.fn((p) => {
      const content = narrowScript(p.split('\\').pop().replace('.funscript', ''));
      return p.includes('first') ? new Promise((r) => setTimeout(() => r(content), 2000)) : Promise.resolve(content);
    });
    const first = ctx.app._onRemotePhoneConnected(IP, 'id-first', 'C:\\v\\first.mp4');
    await vi.advanceTimersByTimeAsync(100);
    // The same phone, so no new session: the epoch alone never moves.
    const second = ctx.app._onRemotePhoneConnected(IP, 'id-second', 'C:\\v\\second.mp4');
    await settle();
    await Promise.all([first, second]);
    expect(rec.engine.at(-1)).toBe('second');
    expect(rec.engine).not.toContain('first');
    expect(rec.handy).toEqual(['second']);
    expect(ctx.app._activeVariantPath).toBe('C:\\v\\second.funscript');
    expect(ctx.app._remoteActive).toBe(true);
    expect(deviceOf(ctx.world, 'A').url).toBe(urlFor('second'));
  });
});
