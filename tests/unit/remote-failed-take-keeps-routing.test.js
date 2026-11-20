/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// C-06 (2026-11-06, probably also in v0.9.2): a phone or VR session that
// never took the engine still cleared this window's custom routing.
// `_onRemotePhoneConnected` ran `_resetCustomRoutingState()` BEFORE it read the
// phone video's script, and `_onVRVideoChanged` through `_stopVRSync` before
// it matched one. When the read failed or the headset's video had no script,
// the engine was never taken (`_engineHeldByRemote` stayed false), so the
// session's end restored nothing (R4-04's restore runs for a taken engine) and
// a custom-routed local video played its main stroke only until it was opened
// again. Every headset link that dropped (FT-054's flapping) did the same.
//
// The REAL app.js methods are lifted (helpers/app-methods.js) with the same
// stand-ins as remote-session-end-restores-script.test.js; the routing is
// what `_loadCustomRouting` leaves on the engines (a stand-in that writes
// exactly that, so the restore can put it back). What is asserted is the
// routing the devices play under: routing on, which device is assigned to
// which route axis, and the route scripts on each engine.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
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

const METHODS = [
  'loadVideo', 'loadFunscript', '_loadPlayContent',
  '_onVRVideoChanged', '_onRemotePhoneConnected', '_stopVRSync', '_onRemotePhoneDisconnected',
  '_stashLocalScriptBeforeRemote', '_restoreLocalScriptAfterRemote',
  '_audienceScriptContent', '_audienceLocalPlayerPlaying', '_fillerOptionsForUpload',
  '_uploadAndStartSync', '_handyUploadContent', '_handyInverted', '_cutoffFromSettings',
  '_editorAllowsReplace',
  '_clearLocalAxesForRemote', '_resetCustomRoutingState',
];

const script = (label) => JSON.stringify({ version: '1.0', _label: label, actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }] });
const labelOf = (content) => { try { return JSON.parse(content)._label; } catch { return null; } };

const ALPHA = 'C:\\v\\alpha.mp4';
const ALPHA_FS = 'C:\\v\\alpha.funscript';
const ALPHA_ROUTE = 'C:\\v\\alpha.vibe-route.funscript';
const PHONE = 'C:\\v\\bravo.mp4';
// Alpha's custom routing: main on the stroker (device 0), its own script on a vibrator (device 1).
const ROUTES = [
  { role: 'main', deviceId: 'buttplug:0:Stroker', scriptPath: ALPHA_FS },
  { role: 'route', deviceId: 'buttplug:1:Vibe', scriptPath: ALPHA_ROUTE },
];
const ROUTE_ACTIONS = [{ at: 0, pos: 0 }, { at: 700, pos: 100 }];

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 120; this.playbackRate = 1; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

/** A multi-axis engine with routing state, as ButtplugSync / TCodeSync hold it. */
function engine() {
  const axes = new Map();
  return {
    _active: false, player: null, axes,
    _customRoutingActive: false, _axisAssignmentMap: new Map(), vibration: null,
    setAxisActions: vi.fn((tc, actions) => { if (actions) axes.set(tc, actions); else axes.delete(tc); }),
    clearAxisActions: vi.fn(() => axes.clear()),
    setVibrationActions: vi.fn(function (a) { this.vibration = a; }),
    reloadActions() {}, start() { this._active = true; }, stop() { this._active = false; },
  };
}

function build() {
  const disk = { [ALPHA_FS]: script('alpha'), 'bravo.funscript': script('bravo'), scene: script('scene'), 'not-json': 'this is not a funscript' };
  const fakeWindow = {
    funsync: {
      readFunscript: vi.fn(async (p) => disk[p] ?? null),
      writeFunscript: vi.fn(async () => { throw new Error('nothing may be written'); }),
      saveFunscript: vi.fn(async () => { throw new Error('nothing may be written'); }),
    },
  };
  const fakeDocument = { getElementById: () => ({ hidden: false, innerHTML: '', textContent: '', dataset: {} }) };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: fakeDocument, console: quiet,
    showToast: () => ({ dismiss() {} }), t: (k) => k,
    stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    vrDisplayName, funsyncVideoIdFromVRPath, normalizeAssociation, resolveActiveConfig,
    RemotePlaybackProxy, pathToFileURL, URL, SOURCE_PLAYER, extractEmbeddedAxes,
    maybeShowHevcGuidance: () => {}, isAutoMatch: () => false,
  });
  const S = { 'player.gapFiller': { enabled: false }, 'player.gapSkip': { mode: 'off' }, 'library.associations': {} };
  const loaded = [];
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: () => {}, addRecentFile() {} },
    videoPlayer: { video: new FakeVideo(), duration: NaN, loadSource() {}, clearSubtitles() {} },
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {}, renderHeatmap() {} },
    funscriptEngine: {
      isLoaded: false,
      _raw: null,
      clear() { this.isLoaded = false; this._raw = null; loaded.push('(cleared)'); },
      // As the real FunscriptEngine: a script that is not JSON throws before anything changes.
      loadContent: vi.fn(async function (content) {
        try { JSON.parse(content); } catch (e) { throw new Error(`Invalid funscript JSON: ${e.message}`); }
        this.isLoaded = true; this._raw = content; loaded.push(labelOf(content));
        return { filename: 'x', actionCount: 2 };
      }),
      loadFile: vi.fn(async function () { this.isLoaded = true; return { filename: 'x', actionCount: 2 }; }),
      getRawContent() { return this._raw; },
      getActions: () => [],
      getChapters: () => [],
      getBookmarks: () => [],
    },
    handyManager: { connected: true, uploadAndSetScript: vi.fn(async () => true), hsspStop: vi.fn() },
    syncEngine: { _active: false, _scriptReady: false, player: null, start: vi.fn(), stop: vi.fn() },
    buttplugSync: engine(),
    buttplugManager: { connected: true, devices: [], stopAll() {} },
    tcodeSync: engine(),
    tcodeManager: { connected: true },
    autoblowManager: null, audienceBridge: null, autoblowSync: null, handyHdspSync: null,
    scriptEditor: null, remoteBridge: { sendToPhone() {}, connected: true }, sessionTracker: null, vrBridge: null, library: null,
    _videoLoadGen: 0, _pendingFunscripts: [], _customRoutingActive: false,
    _currentVariants: [], _allVariantsWithManual: [], _activeVariantIndex: 0,
    _remoteActive: false, _playerWindowActive: false, _vrPlayerRef: null,
    _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    _engineHeldByRemote: false,
    _maybePushCurrentToHistory() {}, _ensureVideoLoadWatch() {}, _disarmLoadAutoplay() {},
    _stopGapSkip() {}, _startGapSkip() {}, _clearCloudUploadGate() {}, _hideScriptLoadingOverlay() {},
    _showScriptLoadingOverlay() {}, _feedInlineViz() {}, _navigateTo() {}, _updateCategoryDots() {},
    _updateQueuePanelState() {}, _applyVRFlattenForCurrent() {}, _autoMatchEroScripts() {},
    _feedEmbeddedMultiAxis() {}, _showFunscriptBadge() {}, _refreshEditorScriptList() {},
    _isDeviceOnMainRoute: () => true, _resolveCloudUpload() {},
    _tryStartButtplugSync() {}, _tryStartTCodeSync() {}, _tryStartAutoblowSync: async () => {},
    _updateVariantSelector() {}, _loadMultiAxisScripts: async () => {}, _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {}, _formatActionsDuration: () => '0:00',
    _healManualVariantPath() {}, _markCloudUploadsPending() {},
    _pushRemoteDeviceStatus() {}, _refreshLoopVideoVisibility() {},
    _settleVRVideoSyncOffset() {}, _applyVideoSyncOffset() {},
    // What the real _loadCustomRouting leaves for ROUTES: routing on, the
    // vibrator on CR1 with its own script on both engines.
    _loadCustomRouting: vi.fn(async function (routes, videoPath) {
      this._currentCustomRoutes = routes;
      this._currentCustomRoutingVideoPath = videoPath;
      this.buttplugSync._customRoutingActive = true;
      this.buttplugSync.setAxisActions('CR1', ROUTE_ACTIONS);
      this.tcodeSync.setAxisActions('CR1', ROUTE_ACTIONS);
      this.buttplugSync._axisAssignmentMap.set(0, 'L0');
      this.buttplugSync._axisAssignmentMap.set(1, 'CR1');
    }),
  });
  return { app, fakeWindow, disk, loaded };
}

/** What the devices play under: Alpha's routing, or none. */
function routing(app) {
  return {
    app: app._customRoutingActive,
    buttplug: app.buttplugSync._customRoutingActive,
    assigned: Object.fromEntries(app.buttplugSync._axisAssignmentMap),
    buttplugAxes: [...app.buttplugSync.axes.keys()],
    tcodeAxes: [...app.tcodeSync.axes.keys()],
  };
}
const ROUTED = { app: true, buttplug: true, assigned: { 0: 'L0', 1: 'CR1' }, buttplugAxes: ['CR1'], tcodeAxes: ['CR1'] };
const NOT_ROUTED = { app: false, buttplug: false, assigned: {}, buttplugAxes: [], tcodeAxes: [] };

const settle = () => vi.runAllTimersAsync();

/** Alpha opened from the library with its custom routing, as `_playFromLibrary` loads it. */
async function openRoutedAlpha(ctx) {
  const app = ctx.app;
  app.loadVideo({ name: 'alpha.mp4', path: ALPHA, _isPathBased: true }, { autoPlay: false });
  app.loadFunscript({ textContent: script('alpha'), name: 'alpha.funscript', _funscriptPath: ALPHA_FS });
  await settle();
  app._customRoutingActive = true;
  await app._loadCustomRouting(ROUTES, ALPHA);
  app._loadCustomRouting.mockClear();
  expect(routing(app)).toEqual(ROUTED);
}

/** The library both remote paths and the restore read. */
function library({ phoneScript = 'bravo.funscript', vrMatch } = {}) {
  return {
    _videosByPath: new Map([[PHONE, { name: 'bravo', hasFunscript: !!phoneScript, funscriptPath: phoneScript }]]),
    ensureScanned: async () => {},
    _videos: [{}],
    resolveVRVideo: async () => vrMatch,
    getVideoByPath: (p) => (p === ALPHA ? { path: ALPHA, _customRouting: ROUTES } : null),
  };
}

async function phoneSession(ctx, lib) {
  ctx.app.library = lib;
  await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id', PHONE);
  await settle();
}
async function phoneEnds(ctx) {
  ctx.app._onRemotePhoneDisconnected('192.168.1.5');
  await settle();
}

async function headsetVideo(ctx, lib) {
  ctx.app.library = lib;
  // `connected: false` so the session-tracker poll a headset script starts
  // clears itself on its first tick (as in the R4-04 tests).
  ctx.app.vrBridge = ctx.app.vrBridge || { proxy: Object.assign(new EventTarget(), { currentTime: 0, paused: false, duration: 100 }), connected: false };
  await ctx.app._onVRVideoChanged('scene', 'C:\\v\\scene.mp4');
  await settle();
}
async function headsetDisconnects(ctx) {
  ctx.app._stopVRSync(); // the bridge's onDisconnect
  await settle();
}

const SCENE = { hasFunscript: true, funscriptPath: 'scene', path: 'C:\\v\\scene.mp4', name: 'scene' };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('C-06: a phone session that never took the engine leaves this window\'s routing alone', () => {
  it('the phone video\'s script cannot be read: routed during the session and after it', async () => {
    const ctx = build();
    await openRoutedAlpha(ctx);
    await phoneSession(ctx, library({ phoneScript: 'gone.funscript' }));
    expect(ctx.app._engineHeldByRemote).toBe(false);
    expect(routing(ctx.app)).toEqual(ROUTED);
    await phoneEnds(ctx);
    expect(routing(ctx.app)).toEqual(ROUTED);
    expect(ctx.loaded.at(-1)).toBe('alpha');
  });

  it('the phone video\'s script is not a funscript: the same', async () => {
    const ctx = build();
    await openRoutedAlpha(ctx);
    await phoneSession(ctx, library({ phoneScript: 'not-json' }));
    expect(routing(ctx.app)).toEqual(ROUTED);
    await phoneEnds(ctx);
    expect(routing(ctx.app)).toEqual(ROUTED);
  });

  it('a phone script that takes the engine still clears it for the session, and the end puts it back', async () => {
    const ctx = build();
    await openRoutedAlpha(ctx);
    await phoneSession(ctx, library());
    expect(ctx.loaded.at(-1)).toBe('bravo');
    expect(routing(ctx.app)).toEqual(NOT_ROUTED);   // the phone's main stroke drives every device
    await phoneEnds(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(routing(ctx.app)).toEqual(ROUTED);
    expect(ctx.fakeWindow.funsync.writeFunscript).not.toHaveBeenCalled();
  });
});

describe('C-06: a headset video that never took the engine leaves this window\'s routing alone', () => {
  for (const [what, match] of [
    ['matches no library video', null],
    ['has no script', { ...SCENE, hasFunscript: false, funscriptPath: null }],
    ['has a script that cannot be read', { ...SCENE, funscriptPath: 'gone.funscript' }],
    ['has a script that is not a funscript', { ...SCENE, funscriptPath: 'not-json' }],
  ]) {
    it(`the headset's video ${what}: routed while it plays and after the headset disconnects`, async () => {
      const ctx = build();
      await openRoutedAlpha(ctx);
      await headsetVideo(ctx, library({ vrMatch: match }));
      expect(ctx.app._engineHeldByRemote).toBe(false);
      expect(routing(ctx.app)).toEqual(ROUTED);
      await headsetDisconnects(ctx);
      expect(routing(ctx.app)).toEqual(ROUTED);
    });
  }

  it('a headset link that drops before any video: routing kept', async () => {
    const ctx = build();
    await openRoutedAlpha(ctx);
    await headsetDisconnects(ctx);
    expect(routing(ctx.app)).toEqual(ROUTED);
  });

  it('a headset script that takes the engine clears it; the next headset video without one keeps it cleared; the disconnect puts it back', async () => {
    const ctx = build();
    await openRoutedAlpha(ctx);
    await headsetVideo(ctx, library({ vrMatch: SCENE }));
    expect(ctx.loaded.at(-1)).toBe('scene');
    expect(routing(ctx.app)).toEqual(NOT_ROUTED);
    await headsetVideo(ctx, library({ vrMatch: null }));   // the next headset video: no match
    expect(routing(ctx.app)).toEqual(NOT_ROUTED);           // the engine is still the headset's
    await headsetDisconnects(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(routing(ctx.app)).toEqual(ROUTED);
  });
});
