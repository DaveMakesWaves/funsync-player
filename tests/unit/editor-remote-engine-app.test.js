/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R3-20 (also in v0.9.2), app.js's half: with a phone or VR session
// driving, the shared funscript engine holds THAT video's script while the
// editor's path is still this window's video's. The editor's own half
// (tests/unit/editor-remote-engine.test.js) keeps off an engine that
// `engineHeldByRemote()` says is not this window's; this file checks that
// app.js says so on every path that loads the engine.
//
// The REAL methods are lifted out of app.js (helpers/app-methods.js), with
// the same stand-ins as audience-app-hooks.test.js, and the REAL options
// object app.js hands `new ScriptEditor({...})`. What is asserted is what the
// editor is told.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
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

const METHODS = [
  'loadVideo', 'loadFunscript', '_loadPlayContent',
  '_onVRVideoChanged', '_onRemotePhoneConnected', '_stopVRSync', '_onRemotePhoneDisconnected',
  '_stashLocalScriptBeforeRemote', '_restoreLocalScriptAfterRemote', // R4-04
  '_audienceScriptContent', '_audienceLocalPlayerPlaying', '_fillerOptionsForUpload',
  '_uploadAndStartSync', '_handyUploadContent', '_handyInverted', '_cutoffFromSettings',
  '_editorAllowsReplace',
];

const script = (label) => JSON.stringify({ version: '1.0', _label: label, actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }] });

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 120; this.playbackRate = 1; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

function build() {
  const fakeWindow = { funsync: { readFunscript: vi.fn(async (p) => script(p)) } };
  const fakeDocument = { getElementById: () => ({ hidden: false, innerHTML: '', textContent: '', dataset: {} }) };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: fakeDocument, console: quiet,
    showToast: () => ({ dismiss() {} }), t: (k) => k, stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    vrDisplayName, funsyncVideoIdFromVRPath, normalizeAssociation, resolveActiveConfig,
    RemotePlaybackProxy, pathToFileURL, URL, SOURCE_PLAYER,
    maybeShowHevcGuidance: () => {}, isAutoMatch: () => false,
  });
  const S = { 'player.gapFiller': { enabled: false }, 'player.gapSkip': { mode: 'off' }, 'library.associations': {} };
  const loaded = [];
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: () => {}, addRecentFile() {} },
    videoPlayer: { video: new FakeVideo(), duration: NaN, loadSource() {}, clearSubtitles() {} },
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {} },
    funscriptEngine: {
      isLoaded: false,
      clear() { this.isLoaded = false; loaded.push('(cleared)'); },
      loadContent: vi.fn(async function (content) { this.isLoaded = true; this._raw = content; loaded.push(JSON.parse(content)._label); return { filename: 'x', actionCount: 2 }; }),
      loadFile: vi.fn(async function () { this.isLoaded = true; return { filename: 'x', actionCount: 2 }; }),
      getRawContent() { return this._raw || null; },
      getActions: () => [],
      getChapters: () => [],
      getBookmarks: () => [],
    },
    handyManager: null, autoblowManager: null, audienceBridge: null,
    buttplugSync: null, tcodeSync: null, autoblowSync: null, syncEngine: null, handyHdspSync: null,
    scriptEditor: null, remoteBridge: { sendToPhone() {}, connected: true }, sessionTracker: null, vrBridge: null, library: null,
    _videoLoadGen: 0, _pendingFunscripts: [], _customRoutingActive: false,
    _currentVariants: [], _allVariantsWithManual: [], _activeVariantIndex: 0,
    _remoteActive: false, _playerWindowActive: false, _vrPlayerRef: null,
    _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    _engineHeldByRemote: false, // as the constructor sets it
    _maybePushCurrentToHistory() {}, _ensureVideoLoadWatch() {}, _disarmLoadAutoplay() {},
    _stopGapSkip() {}, _startGapSkip() {}, _clearCloudUploadGate() {}, _hideScriptLoadingOverlay() {},
    _showScriptLoadingOverlay() {}, _feedInlineViz() {}, _navigateTo() {}, _updateCategoryDots() {},
    _updateQueuePanelState() {}, _applyVRFlattenForCurrent() {}, _autoMatchEroScripts() {},
    _feedEmbeddedMultiAxis() {}, _showFunscriptBadge() {}, _refreshEditorScriptList() {},
    _isDeviceOnMainRoute: () => true, _resolveCloudUpload() {},
    _tryStartButtplugSync() {}, _tryStartTCodeSync() {}, _tryStartAutoblowSync: async () => {},
    _updateVariantSelector() {}, _loadMultiAxisScripts() {}, _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {}, _formatActionsDuration: () => '0:00',
    _healManualVariantPath() {}, _markCloudUploadsPending() {},
    _resetCustomRoutingState() {}, _pushRemoteDeviceStatus() {}, _refreshLoopVideoVisibility() {},
    _settleVRVideoSyncOffset() {}, _applyVideoSyncOffset() {},
  });
  // The REAL options app.js passes the editor, bound to this app.
  const editorOptions = liftCtorOptions('ScriptEditor', {}).call(app);
  return { app, fakeWindow, loaded, heldByRemote: () => editorOptions.engineHeldByRemote() };
}

const settle = () => vi.runAllTimersAsync();

async function openLocal(ctx, label) {
  ctx.app.loadVideo({ name: `${label}.mp4`, path: `C:\\v\\${label}.mp4`, _isPathBased: true }, { autoPlay: false });
  ctx.app.loadFunscript({ textContent: script(label), name: `${label}.funscript` });
  await settle();
}

async function phoneConnects(ctx, label) {
  ctx.app.library = { _videosByPath: new Map([[`C:\\v\\${label}.mp4`, { name: label, hasFunscript: true, funscriptPath: label, variants: [] }]]) };
  await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id', `C:\\v\\${label}.mp4`);
  await settle();
}

function fakeVrBridge() {
  return { proxy: Object.assign(new EventTarget(), { currentTime: 0, paused: false, duration: 100 }), connected: false };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('app.js tells the editor when the engine holds a phone or VR script (R3-20)', () => {
  it('the editor is wired to it: a local video\'s script is this window\'s', async () => {
    const ctx = build();
    await openLocal(ctx, 'alpha');
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ctx.heldByRemote()).toBe(false);
  });

  // Rewritten 2026-11-06 (R4-04): this used to assert that after the phone let
  // go the engine STILL held the phone's script ('bravo', held by the remote)
  // until a local load: the bug R4-04 fixes, pinned as correct. The local
  // video (paused) showed the phone's heatmap and on Play drove the devices
  // with the phone video's script. Its own script now comes back at once.
  it('the phone loads its video\'s script: held by the phone; when it lets go, this window\'s script is back', async () => {
    const ctx = build();
    await openLocal(ctx, 'alpha');
    await phoneConnects(ctx, 'bravo');
    expect(ctx.loaded.at(-1)).toBe('bravo');
    expect(ctx.app._remoteActive).toBe(true);
    expect(ctx.heldByRemote()).toBe(true);
    // The phone let go: alpha's script goes back into the engine (R4-04).
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await settle();
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ctx.heldByRemote()).toBe(false);
    // A load in this window is this window's, as before.
    await openLocal(ctx, 'charlie');
    expect(ctx.heldByRemote()).toBe(false);
  });

  it('a VR headset loads its video\'s script: held by VR; a video load in this window clears it', async () => {
    const ctx = build();
    await openLocal(ctx, 'alpha');
    ctx.app.library = {
      ensureScanned: async () => {},
      _videos: [{}],
      resolveVRVideo: async () => ({ hasFunscript: true, funscriptPath: 'scene', path: 'C:\\v\\scene.mp4', name: 'scene' }),
    };
    ctx.app.vrBridge = fakeVrBridge();
    await ctx.app._onVRVideoChanged('scene', 'C:\\v\\scene.mp4');
    await settle();
    expect(ctx.loaded.at(-1)).toBe('scene');
    expect(ctx.heldByRemote()).toBe(true);
    ctx.app.loadVideo({ name: 'drop.mp4', path: 'C:\\v\\drop.mp4', _isPathBased: true }, { autoPlay: false });
    await settle();
    expect(ctx.heldByRemote()).toBe(false);
  });

  it('a funscript dropped on its own (no video load) is this window\'s again', async () => {
    const ctx = build();
    await openLocal(ctx, 'alpha');
    await phoneConnects(ctx, 'bravo');
    expect(ctx.heldByRemote()).toBe(true);
    ctx.app.loadFunscript({ textContent: script('dropped'), name: 'dropped.funscript' });
    await settle();
    expect(ctx.loaded.at(-1)).toBe('dropped');
    expect(ctx.heldByRemote()).toBe(false);
  });
});
