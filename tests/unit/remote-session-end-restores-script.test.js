/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R4-04 (2026-11-06, probably also in v0.9.2): when a phone or VR session
// ended, nothing loaded this window's video's script back into the shared
// engine. `_onRemotePhoneDisconnected` / `_stopVRSync` only rebound the
// device engines to the local player, so the local video (still loaded,
// paused) showed the phone video's heatmap and, on Play, drove the devices
// with the phone video's script until something else was loaded.
//
// The REAL app.js methods are lifted (helpers/app-methods.js), with the same
// stand-ins as editor-remote-engine-app.test.js. What is asserted is what
// drives the devices afterwards (the engine's script, the Handy upload),
// what the editor keeps, and that nothing is written.
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
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';

const METHODS = [
  'loadVideo', 'loadFunscript', '_loadPlayContent',
  '_onVRVideoChanged', '_onRemotePhoneConnected', '_stopVRSync', '_onRemotePhoneDisconnected',
  '_stashLocalScriptBeforeRemote', '_restoreLocalScriptAfterRemote',
  '_givePhoneVariantListBack', // FT-092: the variant half of the restore, run by the teardown itself
  '_audienceScriptContent', '_audienceLocalPlayerPlaying', '_fillerOptionsForUpload',
  '_uploadAndStartSync', '_handyUploadContent', '_handyInverted', '_cutoffFromSettings',
  '_autoblowUploadContent', '_sessionTimelineMs', '_uploadDurationMsFor', // FT-113: every cloud upload's chain
  '_editorAllowsReplace',
  // R4 fix-up: the axis feeds (stood in by build(); the companion tests use the real ones)
  '_clearLocalAxesForRemote', '_loadMultiAxisScripts', '_feedEmbeddedMultiAxis', '_applyEmbeddedAxes',
  '_companionAxisSuffixes', '_releaseCompanionAxis', 'getEmbeddedAxes',
];

const script = (label) => JSON.stringify({ version: '1.0', _label: label, actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }] });
const labelOf = (content) => { try { return JSON.parse(content)._label; } catch { return null; } };

const ALPHA = 'C:\\v\\alpha.mp4';
const ALPHA_FS = 'C:\\v\\alpha.funscript';
const PHONE = 'C:\\v\\bravo.mp4';

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 120; this.playbackRate = 1; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

function build() {
  const disk = { [ALPHA_FS]: script('alpha'), 'bravo.funscript': script('bravo'), scene: script('scene') };
  const fakeWindow = {
    funsync: {
      readFunscript: vi.fn(async (p) => disk[p] ?? null),
      writeFunscript: vi.fn(async () => { throw new Error('nothing may be written'); }),
      saveFunscript: vi.fn(async () => { throw new Error('nothing may be written'); }),
    },
  };
  const fakeDocument = { getElementById: () => ({ hidden: false, innerHTML: '', textContent: '', dataset: {} }) };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const toasts = [];
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: fakeDocument, console: quiet,
    showToast: (msg) => { toasts.push(msg); return { dismiss() {} }; }, t: (k) => k,
    stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    vrDisplayName, funsyncVideoIdFromVRPath, normalizeAssociation, resolveActiveConfig,
    RemotePlaybackProxy, pathToFileURL, URL, SOURCE_PLAYER, extractEmbeddedAxes, getAxisBySuffix,
    maybeShowHevcGuidance: () => {}, isAutoMatch: () => false,
  });
  const S = { 'player.gapFiller': { enabled: false }, 'player.gapSkip': { mode: 'off' }, 'library.associations': {} };
  const loaded = [];
  const uploads = [];
  const heatmap = { cleared: 0 };
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: () => {}, addRecentFile() {} },
    videoPlayer: { video: new FakeVideo(), duration: NaN, loadSource() {}, clearSubtitles() {} },
    progressBar: { clearHeatmap() { heatmap.cleared++; }, setGaps() {}, setMarkers() {}, setVideoSource() {}, renderHeatmap() {} },
    funscriptEngine: {
      isLoaded: false,
      _raw: null,
      clear() { this.isLoaded = false; this._raw = null; loaded.push('(cleared)'); },
      loadContent: vi.fn(async function (content) {
        this.isLoaded = true; this._raw = content; loaded.push(labelOf(content));
        return { filename: 'x', actionCount: 2 };
      }),
      loadFile: vi.fn(async function () { this.isLoaded = true; return { filename: 'x', actionCount: 2 }; }),
      getRawContent() { return this._raw; },
      getActions: () => [],
      getChapters: () => [],
      getBookmarks: () => [],
    },
    // A connected Handy (a fake, never a real key): what it is given to play.
    handyManager: {
      connected: true,
      uploadAndSetScript: vi.fn(async (content) => { uploads.push(labelOf(content)); return true; }),
      hsspStop: vi.fn(),
    },
    syncEngine: { _active: false, _scriptReady: false, player: null, start: vi.fn(), stop: vi.fn() },
    autoblowManager: null, audienceBridge: null,
    buttplugSync: null, tcodeSync: null, autoblowSync: null, handyHdspSync: null,
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
    _updateVariantSelector() {}, _loadMultiAxisScripts() {}, _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {}, _formatActionsDuration: () => '0:00',
    _healManualVariantPath() {}, _markCloudUploadsPending() {},
    _resetCustomRoutingState() {}, _pushRemoteDeviceStatus() {}, _refreshLoopVideoVisibility() {},
    _settleVRVideoSyncOffset() {}, _applyVideoSyncOffset() {},
  });
  return { app, fakeWindow, disk, loaded, uploads, heatmap, toasts };
}

const settle = () => vi.runAllTimersAsync();

/** This window opens Alpha with its own script file, as a library click does. */
async function openLocal(ctx, { withScript = true, pathless = false } = {}) {
  ctx.app.loadVideo({ name: 'alpha.mp4', path: ALPHA, _isPathBased: true }, { autoPlay: false });
  if (withScript) {
    ctx.app.loadFunscript(pathless
      ? { textContent: script('alpha'), name: 'alpha.funscript' }
      : { textContent: script('alpha'), name: 'alpha.funscript', _funscriptPath: ALPHA_FS });
  }
  await settle();
}

async function phoneConnects(ctx, { variants = [] } = {}) {
  ctx.app.library = { _videosByPath: new Map([[PHONE, { name: 'bravo', hasFunscript: true, funscriptPath: 'bravo.funscript', variants }]]) };
  await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id', PHONE);
  await settle();
}

async function phoneLetsGo(ctx) {
  ctx.app._onRemotePhoneDisconnected('192.168.1.5');
  await settle();
}

function fakeVrBridge() {
  return { proxy: Object.assign(new EventTarget(), { currentTime: 0, paused: false, duration: 100 }), connected: false };
}

async function headsetPlays(ctx) {
  ctx.app.library = {
    ensureScanned: async () => {},
    _videos: [{}],
    resolveVRVideo: async () => ({ hasFunscript: true, funscriptPath: 'scene', path: 'C:\\v\\scene.mp4', name: 'scene' }),
  };
  ctx.app.vrBridge = fakeVrBridge();
  await ctx.app._onVRVideoChanged('scene', 'C:\\v\\scene.mp4');
  await settle();
}

/** An editor on Alpha's script, as the docked editor holds it. */
function editorOnAlpha(ctx, { dirty }) {
  const ed = {
    _funscriptPath: ALPHA_FS,
    isOpen: false,
    editableScript: { actionCount: 3, toFunscriptJSON: () => script('alpha-edited') },
    hasUnsavedChanges: () => dirty,
    setFunscriptPath: vi.fn(), loadScript: vi.fn(),
    clearForVideoLoad() {}, setAvailableScripts() {}, clearUndoCache() {}, hide() {},
  };
  ctx.app.scriptEditor = ed;
  return ed;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('R4-04: a phone session ends, this window\'s video gets its own script back', () => {
  it('the engine and the Handy go back to Alpha\'s script, read from its file', async () => {
    const ctx = build();
    await openLocal(ctx);
    await phoneConnects(ctx);
    expect(ctx.loaded.at(-1)).toBe('bravo');
    expect(ctx.uploads.at(-1)).toBe('bravo');

    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ctx.uploads.at(-1)).toBe('alpha'); // Play drives Alpha's script, not the phone's
    expect(ctx.app._engineHeldByRemote).toBe(false);
    expect(ctx.app._currentFunscriptPath).toBe(ALPHA_FS);
    expect(ctx.fakeWindow.funsync.readFunscript).toHaveBeenLastCalledWith(ALPHA_FS);
    expect(ctx.fakeWindow.funsync.writeFunscript).not.toHaveBeenCalled();
    expect(ctx.fakeWindow.funsync.saveFunscript).not.toHaveBeenCalled();
  });

  it('Alpha has no script: the engine is emptied, so Play drives nothing (no phone heatmap)', async () => {
    const ctx = build();
    await openLocal(ctx, { withScript: false });
    await phoneConnects(ctx);
    const cleared = ctx.heatmap.cleared;
    const uploads = ctx.uploads.length;
    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('(cleared)');
    expect(ctx.app.funscriptEngine.isLoaded).toBe(false);
    expect(ctx.heatmap.cleared).toBeGreaterThan(cleared);
    expect(ctx.uploads.length).toBe(uploads); // nothing new for the Handy
    expect(ctx.app._engineHeldByRemote).toBe(false);
  });

  it('a script dropped with no path of its own: what the engine held before the phone goes back', async () => {
    const ctx = build();
    await openLocal(ctx, { pathless: true });
    expect(ctx.app._currentFunscriptPath).toBe(ALPHA); // loadFunscript's fallback: the VIDEO's path
    await phoneConnects(ctx);
    const reads = ctx.fakeWindow.funsync.readFunscript.mock.calls.length;
    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha');
    // The video file itself is never read as a script.
    expect(ctx.fakeWindow.funsync.readFunscript.mock.calls.slice(reads).map((c) => c[0])).not.toContain(ALPHA);
  });

  it('unsaved editor edits on Alpha\'s script are kept, and the engine takes them, not the file', async () => {
    const ctx = build();
    await openLocal(ctx);
    const ed = editorOnAlpha(ctx, { dirty: true });
    await phoneConnects(ctx);
    ed.setFunscriptPath.mockClear();
    ed.loadScript.mockClear();
    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha-edited');
    expect(ctx.uploads.at(-1)).toBe('alpha-edited');
    expect(ed.loadScript).not.toHaveBeenCalled(); // the edits and the undo history stay
    expect(ed.setFunscriptPath).not.toHaveBeenCalled();
    expect(ctx.fakeWindow.funsync.writeFunscript).not.toHaveBeenCalled();
  });

  it('a clean editor on Alpha is not reloaded either; the engine reads the file', async () => {
    const ctx = build();
    await openLocal(ctx);
    const ed = editorOnAlpha(ctx, { dirty: false });
    await phoneConnects(ctx);
    ed.loadScript.mockClear();
    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ed.loadScript).not.toHaveBeenCalled();
  });

  it('Alpha\'s variant list (and the one that was on) comes back in place of the phone\'s', async () => {
    const ctx = build();
    await openLocal(ctx);
    const local = [{ label: 'Default', path: ALPHA_FS }, { label: 'Soft', path: 'C:\\v\\alpha.soft.funscript' }];
    ctx.app._currentVariants = local;
    ctx.app._activeVariantIndex = 0;
    ctx.app._activeVariantPath = ALPHA_FS;
    await phoneConnects(ctx, { variants: [{ label: 'P1', path: 'bravo.funscript' }, { label: 'P2', path: 'bravo.p2.funscript' }] });
    expect(ctx.app._currentVariants.map((v) => v.label)).toEqual(['P1', 'P2']);
    await phoneLetsGo(ctx);
    expect(ctx.app._currentVariants).toBe(local);
    expect(ctx.app._activeVariantPath).toBe(ALPHA_FS);
    expect(ctx.app._variantsPhoneEpoch).toBe(null);
  });

  it('a variant tapped on the phone pointed the script path at the PHONE video\'s file: Alpha\'s own comes back, not that one', async () => {
    const ctx = build();
    await openLocal(ctx);
    await phoneConnects(ctx);
    // What `_switchVariant` does for a phone tap: the path and the engine follow the phone's variant.
    ctx.disk['bravo.p2.funscript'] = script('bravo-p2');
    ctx.app._currentFunscriptPath = 'bravo.p2.funscript';
    await ctx.app.funscriptEngine.loadContent(script('bravo-p2'));
    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ctx.app._currentFunscriptPath).toBe(ALPHA_FS);
  });

  it('Alpha\'s file is gone now: the engine is emptied rather than kept on the phone\'s script', async () => {
    const ctx = build();
    await openLocal(ctx);
    // No stash either: a later remote load after the first one.
    await phoneConnects(ctx);
    ctx.app._localScriptBeforeRemote = null;
    delete ctx.disk[ALPHA_FS];
    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('(cleared)');
    expect(ctx.toasts).toContain('toast.funscriptUnreadable');
  });

  it('a local load while the file is read wins: the restore does not land on it', async () => {
    const ctx = build();
    await openLocal(ctx);
    await phoneConnects(ctx);
    let release;
    ctx.fakeWindow.funsync.readFunscript.mockImplementationOnce(() => new Promise((r) => { release = () => r(script('alpha')); }));
    ctx.app._onRemotePhoneDisconnected('192.168.1.5');
    await Promise.resolve(); await Promise.resolve();
    ctx.app.loadVideo({ name: 'charlie.mp4', path: 'C:\\v\\charlie.mp4', _isPathBased: true }, { autoPlay: false });
    ctx.app.loadFunscript({ textContent: script('charlie'), name: 'charlie.funscript', _funscriptPath: 'C:\\v\\charlie.funscript' });
    await settle();
    release();
    await settle();
    expect(ctx.loaded.at(-1)).toBe('charlie');
  });
});

describe('R4-04: a VR session ends the same way', () => {
  it('the headset disconnects: Alpha\'s script is back', async () => {
    const ctx = build();
    await openLocal(ctx);
    await headsetPlays(ctx);
    expect(ctx.loaded.at(-1)).toBe('scene');
    ctx.app._stopVRSync(); // the bridge's onDisconnect
    await settle();
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ctx.uploads.at(-1)).toBe('alpha');
    expect(ctx.app._engineHeldByRemote).toBe(false);
  });

  it('the headset\'s NEXT video is not a session end: nothing local is loaded in between', async () => {
    const ctx = build();
    await openLocal(ctx);
    await headsetPlays(ctx);
    const before = ctx.loaded.length;
    await headsetPlays(ctx);
    expect(ctx.loaded.slice(before)).toEqual(['scene']);
  });

  it('the phone takes over from the headset: the phone\'s script stays, Alpha\'s does not come back over it', async () => {
    const ctx = build();
    await openLocal(ctx);
    await headsetPlays(ctx);
    // The tracker's takeover: VR's teardown runs, then the phone's session is recorded.
    let session = { source: 'vr' };
    ctx.app.sessionTracker = {
      getSession: () => session,
      startSession: (source) => { ctx.app._stopVRSync(); session = { source }; },
      endSession: () => { session = null; },
      setVideo() {}, setState() {}, markScriptMissing() {}, markScriptReady() {}, setDeviceStatus() {},
    };
    await phoneConnects(ctx);
    expect(ctx.loaded.at(-1)).toBe('bravo');
    expect(ctx.loaded.slice(ctx.loaded.indexOf('scene'))).toEqual(['scene', 'bravo']);
    expect(ctx.uploads.at(-1)).toBe('bravo');
  });
});

// R4 fix-up (real-app verifier 1, medium, also in v0.9.2): a phone or VR
// session left this window's video's COMPANION axes on T-Code / Buttplug.
// Only custom routing was cleared at the takeover, so the phone's main stroke
// played with the local video's R0 / R1 / R2 (and vibe) files: the fake
// device got L0 at the phone script's rhythm plus R0 / R1 / R2 at the local
// twist / roll / pitch rhythms. What is asserted is what each engine plays on
// which channel, during the session and after it ends.
describe('R4 fix-up: this window\'s companion and embedded axes are off the devices for the session, and back after', () => {
  const TWIST = 'C:\v\alpha.twist.funscript';
  const ROLL = 'C:\v\alpha.roll.funscript';
  const VIB = 'C:\v\alpha.vib.funscript';
  const axisScript = (label) => JSON.stringify({ _label: label, actions: [{ at: 0, pos: 0 }, { at: 700, pos: 100 }] });
  // Alpha's main script also carries an embedded pitch (OFS `raw`).
  const alphaWithPitch = JSON.stringify({
    _label: 'alpha', actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }],
    raw: { pitch: { actions: [{ at: 0, pos: 20 }, { at: 900, pos: 80 }] } },
  });

  /** A multi-axis engine (T-Code / Buttplug): which script plays on which channel. */
  function axisEngine({ vib = false } = {}) {
    const axes = new Map();
    const eng = {
      _active: false, player: null, axes, vibration: null,
      setAxisActions: vi.fn((tc, actions) => { if (actions) axes.set(tc, actions); else axes.delete(tc); }),
      clearAxisActions: vi.fn(() => axes.clear()),
      reloadActions() {}, start() { this._active = true; }, stop() { this._active = false; },
      playing() { return Object.fromEntries([...axes].map(([tc, a]) => [tc, a.at(-1).at])); },
    };
    if (vib) Object.assign(eng, { _customRoutingActive: false, _axisAssignmentMap: new Map(), setVibrationActions: vi.fn((a) => { eng.vibration = a; }) });
    return eng;
  }

  async function localMultiAxis(ctx) {
    Object.assign(ctx.disk, { [ALPHA_FS]: alphaWithPitch, [TWIST]: axisScript('twist'), [ROLL]: axisScript('roll'), [VIB]: axisScript('vib') });
    const app = ctx.app;
    // The real feeds, not the build()'s stand-ins.
    for (const m of ['_loadMultiAxisScripts', '_feedEmbeddedMultiAxis', '_refreshEditorScriptList']) delete app[m];
    app._refreshEditorScriptList = () => {};
    app._readScriptResilient = async (p) => (ctx.disk[p] ? { content: ctx.disk[p] } : null);
    app.tcodeSync = axisEngine();
    app.tcodeManager = { connected: true };
    app.buttplugSync = axisEngine({ vib: true });
    app.buttplugManager = { connected: true, devices: [], stopAll() {} };
    const multi = { axes: { twist: TWIST, roll: ROLL, vib: VIB }, buttplugVib: true };
    app.loadVideo({ name: 'alpha.mp4', path: ALPHA, _isPathBased: true }, { autoPlay: false });
    await app._loadPlayContent({ path: ALPHA }, { name: 'alpha.funscript', textContent: alphaWithPitch, _funscriptPath: ALPHA_FS, _multiAxis: multi }, null, []);
    await settle();
    return multi;
  }

  const LOCAL = { R0: 700, R1: 700, V0: 700, R2: 900 }; // twist, roll, vib (files), pitch (embedded)

  it('a phone session: none of Alpha\'s axes play under the phone\'s script; all of them are back when it ends', async () => {
    const ctx = build();
    await localMultiAxis(ctx);
    expect(ctx.app.tcodeSync.playing()).toEqual(LOCAL);
    expect(ctx.app.buttplugSync.playing()).toEqual(LOCAL);
    expect(ctx.app.buttplugSync.vibration).not.toBe(null);

    await phoneConnects(ctx);
    expect(ctx.loaded.at(-1)).toBe('bravo');
    expect(ctx.app.tcodeSync.playing()).toEqual({}); // the phone's L0 only
    expect(ctx.app.buttplugSync.playing()).toEqual({});
    expect(ctx.app.buttplugSync.vibration).toBe(null);

    await phoneLetsGo(ctx);
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ctx.app.tcodeSync.playing()).toEqual(LOCAL);
    expect(ctx.app.buttplugSync.playing()).toEqual(LOCAL);
    expect(ctx.app.buttplugSync.vibration).not.toBe(null);
    expect(ctx.fakeWindow.funsync.writeFunscript).not.toHaveBeenCalled();
  });

  it('a VR session: the same, through the headset disconnecting', async () => {
    const ctx = build();
    await localMultiAxis(ctx);
    await headsetPlays(ctx);
    expect(ctx.loaded.at(-1)).toBe('scene');
    expect(ctx.app.tcodeSync.playing()).toEqual({});
    ctx.app._stopVRSync();
    await settle();
    expect(ctx.loaded.at(-1)).toBe('alpha');
    expect(ctx.app.tcodeSync.playing()).toEqual(LOCAL);
  });

  it('companion files only (no main script): the engine shows the first companion again and the axes are back', async () => {
    const ctx = build();
    Object.assign(ctx.disk, { [TWIST]: axisScript('twist'), [ROLL]: axisScript('roll') });
    const app = ctx.app;
    for (const m of ['_loadMultiAxisScripts', '_feedEmbeddedMultiAxis']) delete app[m];
    app._readScriptResilient = async (p) => (ctx.disk[p] ? { content: ctx.disk[p] } : null);
    app.tcodeSync = axisEngine();
    app.tcodeManager = { connected: true };
    app.loadVideo({ name: 'alpha.mp4', path: ALPHA, _isPathBased: true }, { autoPlay: false });
    await app._loadPlayContent({ path: ALPHA }, { name: '', textContent: null, _multiAxis: { axes: { twist: TWIST, roll: ROLL } } }, null, []);
    await settle();
    expect(app.tcodeSync.playing()).toEqual({ R0: 700, R1: 700 });
    await phoneConnects(ctx);
    expect(app.tcodeSync.playing()).toEqual({});
    await phoneLetsGo(ctx);
    expect(app.tcodeSync.playing()).toEqual({ R0: 700, R1: 700 });
  });
});
