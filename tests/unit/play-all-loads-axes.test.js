/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library (library.js) resolves what a click and a
 * Play All item load, and it imports DOM-branching modules (notes/CLAUDE.md
 * "Test environments").
 */
// Play All loads what a library click loads (V72, found by the d01 fixer,
// 2026-11-02; also in v0.9.2).
//
// `_playQueueItem` read the queued video's main script and nothing else: no
// companion axis files (assigned or auto-promoted), no custom routing, no
// script variants (so no pinned or random variant), no subtitle. A
// multi-axis user who pressed Play All got single-axis output for every
// video, while a click on the same video drove every axis.
//
// The REAL app.js methods are lifted (helpers/app-methods.js): Play All, the
// click path, the shared content load, the multi-axis, embedded-axis and
// custom-routing loaders and the variant pick. They run against the REAL
// ButtplugSync, TCodeSync, FunscriptEngine and Library, with scripts served
// from an in-memory disk. What is asserted is what the user gets: the action
// array each engine will play per channel, the device each channel drives,
// the script loaded, the variant shown, the subtitle attached, the toasts.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { Library } from '../../renderer/components/library.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { FunscriptEngine, stripBOM } from '../../renderer/js/funscript-engine.js';
import { extractEmbeddedAxes } from '../../renderer/js/embedded-multi-axis.js';
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';
import { pickVariantIndexOnLoad } from '../../renderer/js/variant-select.js';
import { matchButtplugRoute } from '../../renderer/js/custom-routing-match.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { pathToFileURL } from '../../renderer/js/path-utils.js';
import { PLAYBACK_RATE_PRESETS } from '../../renderer/js/video-player.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import {
  shuffle as shuffleArray, reshuffleAvoidingRepeat, balancedShuffle, reshuffleBalancedAvoidingRepeat,
} from '../../renderer/js/shuffle.js';
import { partitionByWatched } from '../../renderer/js/playlist-progress.js';
import { Playlists } from '../../renderer/components/playlists.js';
import { Categories } from '../../renderer/components/categories.js';

const LIFTED = [
  // Play All, under test
  '_playAll', '_playQueueItem', '_loadQueueItemContent', '_advanceQueueOnEnded',
  '_armQueueEndedListener', // R3-09
  '_reshuffleQueueForWrap', '_playAllOrder', '_scriptKeyOf', '_wrapOrder',
  // What the queue plays next (CB-10), real
  '_nextQueueStep', '_queueWrapOrder', '_isUpNextPlayable', '_isUnderEnabledSource',
  // CB-01's unsaved-edits question on every load (no editor here: no question)
  '_editorAllowsReplace',
  // A library click, the reference
  '_playFromLibrary', '_withShuffledStart',
  // What both load, real
  '_loadPlayContent', 'loadFunscript', '_loadMultiAxisScripts', '_feedEmbeddedMultiAxis',
  '_applyEmbeddedAxes', '_companionAxisSuffixes', '_releaseCompanionAxis', 'getEmbeddedAxes',
  '_loadCustomRouting', '_readRouteScript', '_readScriptResilient', '_resetCustomRoutingState',
  '_applyCustomRoutingAssignments', '_matchButtplugRoute', '_isDeviceOnMainRoute',
  '_reportCustomRoutingMismatches', '_updateVariantSelector', '_variantLabelText', '_applyPreferredVariant',
  '_getPreferredVariantLabel', '_switchVariant', '_loadSubtitleFromLibrary',
  // The load path they run through, real
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek', '_setUpNextContext',
  '_syncUpNextSuppression', '_updateQueueUI', '_startPlayback', '_playerWindowPlayback',
  '_routeLoadedVideoToPlayerWindow', '_markCloudUploadsPending', '_resolveCloudUpload',
  '_clearCloudUploadGate', '_showScriptLoadingOverlay', '_hideScriptLoadingOverlay',
  '_initPlayerWindow', '_currentPopoutVideo', '_sendLoadVideoToPopout',
  '_streamPlayerWindowData', '_sendPlayerWindowPlaybackState', '_mirrorPopoutVolume',
];

const ramp = (n, base) => Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: (base + i * 7) % 100 }));
const script = (actions, extra = {}) => JSON.stringify({ actions, ...extra });

// Combined Clip: the main script carries twist/roll/pitch (Format E) and the
// user has twist and pitch companions (extracted, then edited), assigned as
// a multi-axis association. The companions must play, roll from the main.
const COMBINED = 'D:\\Lib\\Combined Clip.mp4';
const COMBINED_MAIN = 'D:\\Lib\\Combined Clip.funscript';
const TWIST = 'D:\\Lib\\Combined Clip.twist.funscript';
const PITCH = 'D:\\Lib\\Combined Clip.pitch.funscript';
const MAIN_ACTIONS = ramp(20, 0);
const EMBED = { R0: ramp(12, 10), R1: ramp(14, 20), R2: ramp(16, 30) };
const COMP = { R0: ramp(3, 60), R2: ramp(5, 70) };

// Routed: custom routing, the main script on the stroker, a second script on
// the vibe.
const ROUTED = 'D:\\Lib\\Routed.mp4';
const ROUTED_MAIN = 'D:\\Lib\\Routed.funscript';
const ROUTED_VIBE = 'D:\\Lib\\Routed.vibe.funscript';
const ROUTED_MAIN_ACTIONS = ramp(8, 5);
const ROUTED_VIBE_ACTIONS = ramp(6, 40);

// Variant Clip: two script variants with "Soft" pinned as this video's
// default, plus a subtitle.
const VARIANT = 'D:\\Lib\\Variant Clip.mp4';
const VARIANT_MAIN = 'D:\\Lib\\Variant Clip.funscript';
const VARIANT_SOFT = 'D:\\Lib\\Variant Clip (Soft).funscript';
const VARIANT_SRT = 'D:\\Lib\\Variant Clip.srt';
const SOFT_ACTIONS = ramp(4, 50);

const PLAIN = 'D:\\Lib\\Plain.mp4';
const PLAIN_MAIN = 'D:\\Lib\\Plain.funscript';
const PLAIN_ACTIONS = ramp(10, 15);

const SCRIPTLESS = 'D:\\Lib\\Scriptless.mp4';

// Routes Only: custom routing with no auto-paired main script (only
// `.anal` / `.vibe` files on disk), so the main route is promoted into the
// main slot by a read of its own.
const ROUTES_ONLY = 'D:\\Lib\\Routes Only.mp4';
const ROUTES_ONLY_MAIN = 'D:\\Lib\\Routes Only.anal.funscript';
const ROUTES_ONLY_VIBE = 'D:\\Lib\\Routes Only.vibe.funscript';
const ROUTES_ONLY_MAIN_ACTIONS = ramp(7, 35);
const ROUTES_ONLY_VIBE_ACTIONS = ramp(5, 45);

// Late Script: the scan found no script, and `<name>.funscript` was added
// since (the library has no folder watcher).
const LATE = 'D:\\Lib\\Late Script.mp4';
const LATE_MAIN = 'D:\\Lib\\Late Script.funscript';
const LATE_ACTIONS = ramp(6, 55);

/** The disk the scripts live on. */
function makeDisk() {
  return new Map([
    [COMBINED_MAIN, script(MAIN_ACTIONS, {
      axes: [
        { id: 'R0', actions: EMBED.R0 },
        { id: 'R1', actions: EMBED.R1 },
        { id: 'R2', actions: EMBED.R2 },
      ],
    })],
    [TWIST, script(COMP.R0)],
    [PITCH, script(COMP.R2)],
    [ROUTED_MAIN, script(ROUTED_MAIN_ACTIONS)],
    [ROUTED_VIBE, script(ROUTED_VIBE_ACTIONS)],
    [VARIANT_MAIN, script(ramp(9, 25))],
    [VARIANT_SOFT, script(SOFT_ACTIONS)],
    [VARIANT_SRT, '1\n00:00:01,000 --> 00:00:02,000\nhello\n'],
    [PLAIN_MAIN, script(PLAIN_ACTIONS)],
    [ROUTES_ONLY_MAIN, script(ROUTES_ONLY_MAIN_ACTIONS)],
    [ROUTES_ONLY_VIBE, script(ROUTES_ONLY_VIBE_ACTIONS)],
    [LATE_MAIN, script(LATE_ACTIONS)],
  ]);
}

/** The library's records, as a scan plus `_applyManualAssociations` leave them. */
function makeLibraryVideos() {
  return [
    {
      name: 'Combined Clip.mp4', path: COMBINED, hasFunscript: true, funscriptPath: COMBINED_MAIN,
      _manualAssociation: true,
      _multiAxis: { main: COMBINED_MAIN, axes: { twist: TWIST, pitch: PITCH }, buttplugVib: false },
    },
    {
      name: 'Routed.mp4', path: ROUTED, hasFunscript: true, funscriptPath: ROUTED_MAIN,
      _manualAssociation: true,
      _customRouting: [
        { role: 'main', scriptPath: ROUTED_MAIN, deviceId: 'buttplug:Stroker', buttplugIndex: 0 },
        { role: 'axis', scriptPath: ROUTED_VIBE, deviceId: 'buttplug:Vibe', buttplugIndex: 1 },
      ],
    },
    {
      name: 'Variant Clip.mp4', path: VARIANT, hasFunscript: true, funscriptPath: VARIANT_MAIN,
      hasSubtitle: true, subtitlePath: VARIANT_SRT,
      variants: [
        { label: 'Default', path: VARIANT_MAIN, name: 'Variant Clip.funscript' },
        { label: 'Soft', path: VARIANT_SOFT, name: 'Variant Clip (Soft).funscript' },
      ],
    },
    { name: 'Plain.mp4', path: PLAIN, hasFunscript: true, funscriptPath: PLAIN_MAIN },
    { name: 'Scriptless.mp4', path: SCRIPTLESS, hasFunscript: false, funscriptPath: null },
    {
      name: 'Routes Only.mp4', path: ROUTES_ONLY, hasFunscript: false, funscriptPath: null,
      _manualAssociation: true,
      _customRouting: [
        { role: 'main', scriptPath: ROUTES_ONLY_MAIN, deviceId: 'buttplug:Stroker', buttplugIndex: 0 },
        { role: 'axis', scriptPath: ROUTES_ONLY_VIBE, deviceId: 'buttplug:Vibe', buttplugIndex: 1 },
      ],
    },
    { name: 'Late Script.mp4', path: LATE, hasFunscript: false, funscriptPath: null },
  ];
}

/** The inline <video>: a real EventTarget with the fields the app reads. */
class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      src: '', currentSrc: '', paused: true, ended: false, currentTime: 0, duration: 13,
      volume: 0.8, muted: false, loop: false, playbackRate: 1, error: null,
    });
    this.play = vi.fn(() => {
      if (this.paused) { this.paused = false; this.dispatchEvent(new Event('play')); }
      return Promise.resolve();
    });
    this.pause = vi.fn(() => {
      if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); }
    });
  }

  fire(type) {
    if (type === 'loadeddata') this.currentSrc = this.src;
    this.dispatchEvent(new Event(type));
  }
}

let api;
let disk;
let held; // script reads the test holds back: path -> { promise, resolve }
let heldConvert; // the backend's CSV conversions held back: script content -> promise
let els; // the page's elements by id, created on first lookup
let video;
let app;
let Lifted;
let toasts = [];
let badges = []; // the script each funscript-badge update names
let queueLoadFailures = [];

beforeAll(() => {
  Lifted = liftAppClass(LIFTED, {
    window: { get funsync() { return api; } },
    document: {
      documentElement: { dataset: { theme: 'dark', style: 'classic' } },
      getElementById: (id) => {
        if (!els[id]) els[id] = { id, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {} };
        return els[id];
      },
    },
    console: {
      log: () => {},
      // `_playQueueItem` does not await the item's load, and catches what
      // it throws with this warning. A test whose load threw would otherwise
      // pass on whatever state the throw left.
      warn: (...args) => { if (String(args[0]).startsWith('[Queue]')) queueLoadFailures.push(args); },
      error: () => {},
    },
    URL,
    File,
    pathToFileURL,
    maybeShowHevcGuidance: () => {},
    isAutoMatch: () => false,
    showToast: (message, level) => { toasts.push([message, level]); },
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    PLAYERWIN,
    RemotePlaybackProxy,
    PLAYBACK_RATE_PRESETS,
    INLINE_VIZ_OPACITY_DEFAULT: 80,
    shouldOfferResume: () => false,
    formatResumeTime: () => '',
    requestAnimationFrame: (fn) => fn(),
    shuffleArray,
    reshuffleAvoidingRepeat,
    balancedShuffle,
    reshuffleBalancedAvoidingRepeat,
    partitionByWatched,
    stripBOM,
    extractEmbeddedAxes,
    getAxisBySuffix,
    pickVariantIndexOnLoad,
    matchButtplugRoute,
  });
});

function buildApp() {
  disk = makeDisk();
  held = new Map();
  heldConvert = new Map();
  els = {};
  api = {
    playerPopoutRelay: vi.fn(),
    playerPopoutReveal: vi.fn(),
    playerPopoutClose: vi.fn(),
    onPlayerPopoutEvent: () => {},
    readFunscript: vi.fn((p) => (held.has(p) ? held.get(p).promise : Promise.resolve(disk.get(p) ?? null))),
    // FunscriptEngine.loadContent waits on this (a busy backend can hold it).
    convertFunscript: vi.fn((content) => heldConvert.get(content) ?? Promise.resolve(null)),
  };
  // The real Library reads through the page's own `window.funsync`.
  window.funsync = api;
  video = new FakeVideo();
  const settingsMap = new Map();
  const videoPlayer = {
    video,
    get duration() { return video.duration; },
    get currentTime() { return video.currentTime; },
    get paused() { return video.paused; },
    get ended() { return video.ended; },
    isVRProjecting: false,
    togglePlay: vi.fn(),
    loadSource: vi.fn((url) => { video.src = url; }),
    clearSubtitles: vi.fn(),
    loadSubtitles: vi.fn(),
  };
  const stroker = { index: 0, name: 'Stroker', canLinear: true };
  const vibe = { index: 1, name: 'Vibe', canLinear: true };
  const buttplugManager = { connected: true, devices: [stroker, vibe], sendLinear: vi.fn() };
  const funscriptEngine = new FunscriptEngine({ backendPort: 5123 });
  const target = Object.assign(new Lifted(), {
    videoPlayer,
    progressBar: {
      clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {},
      renderHeatmap() {}, renderChapterStrip() {},
    },
    funscriptEngine,
    buttplugManager,
    settings: {
      get: (k) => settingsMap.get(k),
      set: (k, v) => settingsMap.set(k, v),
      addRecentFile() {},
    },
    _settingsMap: settingsMap,
    scriptEditor: null,
    _pendingUploads: new Set(),
    _waitingForScript: false,
    _pendingFunscripts: [],
    _playQueue: [],
    _playQueueIndex: -1,
    _userQueue: [],
    // Collaborators the lifted methods call that are not under test.
    _persistUserQueue() {},
    _maybePushCurrentToHistory() {},
    _ensureVideoLoadWatch() {},
    _stopGapSkip() {},
    _startGapSkip() {},
    _feedInlineViz() {},
    _navigateTo() {},
    _currentView: () => 'player',
    _clearMiniplayer() {},
    _updateCategoryDots() {},
    _updateQueuePanelState() {},
    _applyVRFlattenForCurrent() {},
    _autoMatchEroScripts() {},
    _updatePlayerWindowButton() {},
    _recordResumePosition() {},
    _isPlaylistContext: () => false,
    getResumeEntry: () => null,
    _maybeOfferResume: async () => null,
    _refreshLoopVideoVisibility() {},
    _showFunscriptBadge(info) { badges.push(info?.filename); }, // the badge names the script loaded
    _formatActionsDuration: () => '0:01',
    _refreshEditorScriptList() {},
    _manualVariantsFor: () => [],
    _planLazyRehome: () => null, // an unpinned video: no pin to re-home
    _pruneStaleManualVariant: async () => {},
    _persistCustomRoutes() {},
    _uploadAndStartSync: async () => {},
    _tryStartButtplugSync() {},
    _tryStartTCodeSync() {},
    _tryStartAutoblowSync: async () => {},
  });
  target.buttplugSync = new ButtplugSync({ videoPlayer, buttplugManager, funscriptEngine });
  // Not under test, and the real one starts a scheduler on a video "playing".
  target.buttplugSync.start = vi.fn();
  target.tcodeSync = new TCodeSync({ videoPlayer, tcodeManager: {}, funscriptEngine });
  target.library = new Library({
    settings: target.settings,
    onPlayVideo: (v, fs, sub, variants) => target._playFromLibrary(v, fs, sub, variants),
  });
  target.library._videos = makeLibraryVideos();
  target.upNextEngine = new UpNextEngine({ videoPlayer, funscriptEngine });
  target.upNextEngine.setSettings('auto', 10);
  target._initPlayerWindow();
  return target;
}

/** Let every read and load in flight finish (all of them resolve as microtasks). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A Play All queue item, as Playlists `_queueItems` builds it. */
const item = (path) => ({
  name: path.split('\\').pop(),
  path,
  funscriptPath: app.library.getVideoByPath(path)?.funscriptPath || path.replace(/\.[^.]+$/, '.funscript'),
});

/** Press Play All on these videos, and let the first one load. */
async function playAll(paths) {
  app._playAll(paths.map(item));
  video.fire('loadeddata');
  await settle();
}

/** Click a video in the library, and let it load. */
async function click(path) {
  await app.library._playVideo(app.library.getVideoByPath(path));
  video.fire('loadeddata');
  await settle();
}

/** What each engine will play on a channel (null = nothing). */
const channel = (tcode) => ({
  buttplug: app.buttplugSync._axisActions.get(tcode)?.actions ?? null,
  tcode: app.tcodeSync._axisActions.get(tcode)?.actions ?? null,
});

/** The devices that receive the main stroke. */
function mainStrokeDevices() {
  app.buttplugManager.sendLinear.mockClear();
  app.buttplugSync.sendLinearNow(50, 100);
  return app.buttplugManager.sendLinear.mock.calls.map(([index]) => index);
}

/** Everything the user gets from the loaded video, for click-vs-queue parity. */
function whatPlays() {
  const channels = {};
  for (const tcode of ['R0', 'R1', 'R2', 'V0', 'CR1', 'CR2']) {
    const c = channel(tcode);
    if (c.buttplug || c.tcode) channels[tcode] = c;
  }
  return {
    video: app._currentVideoPath,
    script: app.funscriptEngine.isLoaded ? app.funscriptEngine.getActions() : null,
    channels,
    companions: app._currentMultiAxis ? { ...app._currentMultiAxis.axes } : null,
    routing: !!app._customRoutingActive,
    mainStrokeDevices: mainStrokeDevices(),
    variants: (app._allVariantsWithManual || []).map((v) => v.label),
    variantShown: els['variant-btn-label']?.textContent || '',
    subtitles: app.videoPlayer.loadSubtitles.mock.calls.map(([file]) => file.name),
  };
}

/** What a library click on `path` gives, in a fresh app. */
async function whatAClickPlays(path, before = () => {}) {
  app = buildApp();
  before();
  await click(path);
  return whatPlays();
}

beforeEach(() => {
  toasts = [];
  badges = [];
  queueLoadFailures = [];
  app = buildApp();
});

afterEach(() => {
  expect(queueLoadFailures, 'a queue item\'s load threw').toEqual([]);
  app.upNextEngine.hide();
  delete window.funsync;
  vi.restoreAllMocks();
});

describe('V72: every Play All item loads what a library click on it loads', () => {
  it('a multi-axis video: its companion files reach both engines and win over the axes embedded in the main script', async () => {
    await playAll([COMBINED, PLAIN]);

    expect(app._currentVideoPath).toBe(COMBINED);
    expect(channel('R0')).toEqual({ buttplug: COMP.R0, tcode: COMP.R0 }); // the twist companion
    expect(channel('R2')).toEqual({ buttplug: COMP.R2, tcode: COMP.R2 }); // the pitch companion
    expect(channel('R1')).toEqual({ buttplug: EMBED.R1, tcode: EMBED.R1 }); // roll: no companion
    expect(app.funscriptEngine.getActions()).toEqual(MAIN_ACTIONS);
    // The library card's badge and kebab look the embedded axes up by the
    // video's script path: the queue's load caches them there too.
    expect(app.getEmbeddedAxes(COMBINED_MAIN)?.suffixes.sort()).toEqual(['pitch', 'roll', 'twist']);

    const queued = whatPlays();
    expect(queued).toEqual(await whatAClickPlays(COMBINED));
  });

  it('a video the library does not hold caches its embedded axes under the queue item\'s script', async () => {
    const elsewhere = 'E:\\Old\\Combined Copy.mp4';
    const elsewhereScript = 'E:\\Old\\Combined Copy.funscript';
    disk.set(elsewhereScript, disk.get(COMBINED_MAIN));
    app._playAll([{ name: 'Combined Copy.mp4', path: elsewhere, funscriptPath: elsewhereScript }]);
    video.fire('loadeddata');
    await settle();
    expect(app.getEmbeddedAxes(elsewhereScript)?.suffixes.sort()).toEqual(['pitch', 'roll', 'twist']);
    expect(channel('R1')).toEqual({ buttplug: EMBED.R1, tcode: EMBED.R1 });
  });

  it('custom routing: the second script plays on its own channel, on the device it was routed to', async () => {
    await playAll([ROUTED, PLAIN]);

    expect(app._customRoutingActive).toBe(true);
    expect(channel('CR1')).toEqual({ buttplug: ROUTED_VIBE_ACTIONS, tcode: ROUTED_VIBE_ACTIONS });
    expect(app.buttplugSync.getAxisAssignment(1)).toBe('CR1'); // the vibe
    expect(mainStrokeDevices()).toEqual([0]); // the main stroke drives the stroker only
    expect(app.funscriptEngine.getActions()).toEqual(ROUTED_MAIN_ACTIONS);

    const queued = whatPlays();
    expect(queued).toEqual(await whatAClickPlays(ROUTED));
  });

  it('custom routing with no auto-paired main script: the main route is promoted and plays, as for a click', async () => {
    await playAll([ROUTES_ONLY, PLAIN]);

    expect(app.funscriptEngine.getActions()).toEqual(ROUTES_ONLY_MAIN_ACTIONS);
    expect(channel('CR1')).toEqual({ buttplug: ROUTES_ONLY_VIBE_ACTIONS, tcode: ROUTES_ONLY_VIBE_ACTIONS });
    expect(mainStrokeDevices()).toEqual([0]);
    expect(toasts.filter(([m]) => m.startsWith('toast.queueRead'))).toEqual([]);

    const queued = whatPlays();
    expect(queued).toEqual(await whatAClickPlays(ROUTES_ONLY));
  });

  it('a pinned variant and the subtitle load for a queued video, as for a click', async () => {
    const pin = () => app._settingsMap.set('library.preferredVariants', { [VARIANT]: 'Soft' });
    pin();
    await playAll([VARIANT, PLAIN]);

    expect(app.funscriptEngine.getActions()).toEqual(SOFT_ACTIONS);
    expect(els['variant-btn-label'].textContent).toBe('Soft');
    expect(app.videoPlayer.loadSubtitles).toHaveBeenCalledTimes(1);
    expect(app.videoPlayer.loadSubtitles.mock.calls[0][0].name).toBe('Variant Clip.srt');

    const queued = whatPlays();
    expect(queued).toEqual(await whatAClickPlays(VARIANT, pin));
  });

  it('the next item starts clean: no axes, routing or device assignment carried over', async () => {
    await playAll([ROUTED, COMBINED, PLAIN]);
    expect(app._customRoutingActive).toBe(true);

    video.fire('ended'); // Play All's own advance
    video.fire('loadeddata');
    await settle();
    expect(app._currentVideoPath).toBe(COMBINED);
    expect(app._customRoutingActive).toBe(false);
    expect(channel('CR1')).toEqual({ buttplug: null, tcode: null });
    expect(mainStrokeDevices()).toEqual([0, 1]); // the vibe is back on the main stroke
    expect(channel('R0')).toEqual({ buttplug: COMP.R0, tcode: COMP.R0 });

    video.fire('ended');
    video.fire('loadeddata');
    await settle();
    expect(app._currentVideoPath).toBe(PLAIN);
    for (const tcode of ['R0', 'R1', 'R2']) expect(channel(tcode)).toEqual({ buttplug: null, tcode: null });
    expect(app._currentMultiAxis).toBe(null);
    expect(app.funscriptEngine.getActions()).toEqual(PLAIN_ACTIONS);
  });

  it('reads for an item the user skipped past never land on the next one', async () => {
    let release;
    held.set(COMBINED_MAIN, { promise: new Promise((r) => { release = r; }) });
    app._playAll([COMBINED, PLAIN].map(item));
    app._playQueueItem(1); // Next, while Combined Clip's script is still being read
    video.fire('loadeddata');
    await settle();

    release(disk.get(COMBINED_MAIN)); // the slow read comes back
    await settle();

    expect(app._currentVideoPath).toBe(PLAIN);
    expect(app.funscriptEngine.getActions()).toEqual(PLAIN_ACTIONS);
    expect(app._currentMultiAxis).toBe(null);
    for (const tcode of ['R0', 'R1', 'R2']) expect(channel(tcode)).toEqual({ buttplug: null, tcode: null });
  });
});

/** Hold the read of `path` back; returns what lets it come back. */
function hold(path) {
  let release;
  held.set(path, { promise: new Promise((r) => { release = r; }) });
  return () => release(disk.get(path));
}

/** Hold the backend's CSV conversion of the script at `path` back. */
function holdConvert(path) {
  let release;
  heldConvert.set(disk.get(path), new Promise((r) => { release = r; }));
  return () => release(null);
}

/** The queue's Next, and let the next item load. */
async function next() {
  app._playQueueItem(app._playQueueIndex + 1);
  video.fire('loadeddata');
  await settle();
}

/** Plain plays, and nothing of the item before it is on an engine or device. */
function expectOnlyPlain() {
  expect(app._currentVideoPath).toBe(PLAIN);
  expect(app.funscriptEngine.getActions()).toEqual(PLAIN_ACTIONS);
  for (const tcode of ['R0', 'R1', 'R2', 'CR1', 'CR2']) {
    expect(channel(tcode), tcode).toEqual({ buttplug: null, tcode: null });
  }
  expect(app._customRoutingActive).toBe(false);
  expect(app._currentMultiAxis).toBe(null);
  expect(mainStrokeDevices()).toEqual([0, 1]); // both devices on the main stroke
}

// V72 review: the first version checked `_videoLoadGen` around the queue's
// own main-script read only. Every later await of the shared load (the main
// route's promotion, each custom route read and upload, the pinned or random
// variant's read, the engine's CSV conversion) still wrote to the engines of
// whatever video the user had moved on to. Pressing N through a playlist is
// exactly how that happens.
describe('V72: a load the user moved past writes nothing to the next video', () => {
  it('a custom route read that comes back after Next', async () => {
    const release = hold(ROUTED_VIBE);
    await playAll([ROUTED, PLAIN]);
    await next();
    release();
    await settle();
    expectOnlyPlain();
  });

  it('the main route\'s promotion read that comes back after Next', async () => {
    const release = hold(ROUTES_ONLY_MAIN);
    await playAll([ROUTES_ONLY, PLAIN]);
    await next();
    release();
    await settle();
    expectOnlyPlain();
  });

  it('a pinned variant\'s read that comes back after Next', async () => {
    app._settingsMap.set('library.preferredVariants', { [VARIANT]: 'Soft' });
    const release = hold(VARIANT_SOFT);
    await playAll([VARIANT, PLAIN]);
    await next();
    release();
    await settle();
    expectOnlyPlain();
    expect(app._currentFunscriptPath).toBe(PLAIN_MAIN); // what the badge and editor key on
    expect(toasts.filter(([m]) => m.startsWith('toast.nowPlayingVariant'))).toEqual([]);
  });

  it('a pinned variant\'s parse that comes back after Next (a busy backend)', async () => {
    app._settingsMap.set('library.preferredVariants', { [VARIANT]: 'Soft' });
    const release = holdConvert(VARIANT_SOFT);
    await playAll([VARIANT, PLAIN]);
    await next();
    release();
    await settle();
    expectOnlyPlain();
    expect(badges).not.toContain('Variant Clip (Soft).funscript'); // over Plain's actions
    expect(badges.at(-1)).toBe('Plain.funscript');
    expect(toasts.filter(([m]) => m.startsWith('toast.nowPlayingVariant'))).toEqual([]);
  });

  it('a random variant picked for the item before is not announced over the next one', async () => {
    app._settingsMap.set('player.randomVariantOnPlay', true);
    vi.spyOn(Math, 'random').mockReturnValue(0.75); // picks "Soft"
    const release = hold(VARIANT_SOFT);
    await playAll([VARIANT, PLAIN]);
    await next();
    release();
    await settle();
    expectOnlyPlain();
    expect(toasts.filter(([m]) => m.startsWith('toast.randomVariant'))).toEqual([]);
  });

  it('the main script\'s parse that comes back after Next (a busy backend) leaves its embedded axes off the next item', async () => {
    const release = holdConvert(COMBINED_MAIN);
    await playAll([COMBINED, PLAIN]);
    await next();
    release();
    await settle();
    expectOnlyPlain();
  });

  it('the same for a click: a click whose route read comes back after the next click', async () => {
    const release = hold(ROUTED_VIBE);
    const first = app.library._playVideo(app.library.getVideoByPath(ROUTED));
    await settle();
    await click(PLAIN);
    release();
    await first;
    await settle();
    expectOnlyPlain();
  });

  it('a click the user moved past does not reload the pop-out over the Play All item now playing there', async () => {
    // The pop-out is open and owns playback. Its take-over itself is not
    // under test here (player-popout-playback.test.js covers it).
    app._playerWindowOpen = true;
    app._playerWindowActive = true;
    app._activatePlayerWindow = () => {};
    const loadsSent = () => api.playerPopoutRelay.mock.calls
      .map(([, message]) => message)
      .filter((message) => message?.type === PLAYERWIN.LOAD_VIDEO);

    const release = hold(ROUTED_VIBE);
    const first = app.library._playVideo(app.library.getVideoByPath(ROUTED)); // opens paused
    await settle();
    await playAll([PLAIN]); // autoplays, in the pop-out
    expect(loadsSent().at(-1)).toMatchObject({ src: pathToFileURL(PLAIN), autoplay: true, timeMs: 0 });
    const sentBefore = loadsSent().length;

    release();
    await first;
    await settle();
    expect(loadsSent().length).toBe(sentBefore);
    expectOnlyPlain();
  });
});

/**
 * A connected Handy and Autoblow, and every step that drives them, logged in
 * order. A cloud upload takes 1-3 s, the likeliest window for a Next.
 * `hold(step)` parks the NEXT call of that step until `release(step)`.
 */
function connectCloudDevices() {
  const log = [];
  const parked = new Set();
  const releases = new Map();
  const step = (name) => {
    log.push(name);
    if (!parked.delete(name)) return Promise.resolve();
    return new Promise((resolve) => releases.set(name, resolve));
  };
  app.handyManager = {
    connected: true,
    hsspStop: () => step('handy stop'),
    uploadAndSetScript: () => step('handy route upload'),
  };
  app.syncEngine = { _scriptReady: true, start: () => log.push('handy start'), stop() {} };
  app.autoblowManager = { connected: true };
  app.autoblowSync = { stop() {}, uploadScript: () => step('autoblow route upload') };
  app._uploadAndStartSync = () => step('handy upload');
  app._tryStartAutoblowSync = () => step('autoblow upload');
  app._tryStartButtplugSync = () => log.push('buttplug start');
  app._tryStartTCodeSync = () => log.push('tcode start');
  app._startGapSkip = () => log.push('gap skip');
  app.scriptEditor = {
    isOpen: false, hide() {}, setFunscriptPath() {}, clearForVideoLoad() {}, loadScript() {}, clearUndoCache() {},
    // loadVideo empties the list; a routed load fills it with its routes.
    setAvailableScripts: (scripts) => { if (scripts.length) log.push('editor script list'); },
  };
  app._findKnownDeviceForRoute = () => null;
  return { log, hold: (name) => parked.add(name), release: (name) => releases.get(name)?.() };
}

describe('V72: a device step the user moved past drives nothing for the next video', () => {
  /** Hold `step` while `start` loads the item before Plain; Next; release. What ran after? */
  async function afterRelease(step, start) {
    const devices = connectCloudDevices();
    // Boxed: an async function returning the parked promise would wait on it.
    const { pending } = (await start(devices, () => devices.hold(step))) || {};
    await next();
    expect(app._currentVideoPath).toBe(PLAIN);
    const mark = devices.log.length;
    devices.release(step);
    await pending;
    await settle();
    return devices.log.slice(mark);
  }

  /** Play All on [video, Plain] with `step` held. */
  const playAllHolding = (video) => async (devices, holdStep) => {
    holdStep();
    await playAll([video, PLAIN]);
  };

  /** Play All on [Variant Clip, Plain], then the user picks "Soft" with `step` held. */
  const switchVariantHolding = async (devices, holdStep) => {
    await playAll([VARIANT, PLAIN]);
    holdStep();
    const pending = app._switchVariant(1);
    await settle();
    return { pending };
  };

  it('a custom route\'s Handy upload: the Handy is not started for the item left behind', async () => {
    app.library.getVideoByPath(ROUTED)._customRouting[1].deviceId = 'handy';
    expect(await afterRelease('handy route upload', playAllHolding(ROUTED))).toEqual([]);
    expectOnlyPlain();
  });

  it('a custom route\'s Autoblow upload: the editor does not list the item left behind\'s routes', async () => {
    app.library.getVideoByPath(ROUTED)._customRouting[1].deviceId = 'autoblow';
    expect(await afterRelease('autoblow route upload', playAllHolding(ROUTED))).toEqual([]);
    expectOnlyPlain();
  });

  it('the main script\'s Handy upload: Buttplug, T-Code and Autoblow are not started again', async () => {
    expect(await afterRelease('handy upload', playAllHolding(COMBINED))).toEqual([]);
    expectOnlyPlain();
  });

  it('the main script\'s Autoblow upload: gap skip is not started for it', async () => {
    expect(await afterRelease('autoblow upload', playAllHolding(COMBINED))).toEqual([]);
    expectOnlyPlain();
  });

  it.each([
    ['the Handy stop before the re-upload', 'handy stop'],
    ['the Handy re-upload', 'handy upload'],
    ['the Autoblow re-upload', 'autoblow upload'],
  ])('a variant switch held at %s: nothing more is uploaded or announced', async (_label, step) => {
    expect(await afterRelease(step, switchVariantHolding)).toEqual([]);
    expectOnlyPlain();
    expect(toasts.filter(([m]) => m.startsWith('toast.nowPlayingVariant'))).toEqual([]);
  });
});

describe('V72: Play All keeps its own behaviour', () => {
  it('still autoplays every item and advances on its own at the end', async () => {
    await playAll([COMBINED, PLAIN]);
    expect(video.play).toHaveBeenCalledTimes(1);
    video.fire('ended');
    video.fire('loadeddata');
    await settle();
    expect(app._currentVideoPath).toBe(PLAIN);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(app._playQueueIndex).toBe(1);
  });

  it('a library video whose script cannot be read still warns that it plays without sync', async () => {
    disk.delete(PLAIN_MAIN);
    await playAll([PLAIN, COMBINED]);
    expect(toasts.filter(([m]) => m.startsWith('toast.queueReadFailed'))).toEqual([
      ['toast.queueReadFailed {"name":"Plain.mp4","script":"Plain.funscript"}', 'warn'],
    ]);
  });

  it('a video with no script plays without a "script couldn\'t be read" warning, as a click does', async () => {
    await playAll([SCRIPTLESS, PLAIN]);
    expect(app._currentVideoPath).toBe(SCRIPTLESS);
    expect(toasts.filter(([m]) => m.startsWith('toast.queueRead'))).toEqual([]);
    expect(app.funscriptEngine.isLoaded).toBe(false);
    // FT-069: the library's read now looks for `<name>.funscript` itself, and
    // Play All's own quiet read of the same guess does not repeat it.
    const sidecarReads = window.funsync.readFunscript.mock.calls
      .filter(([p]) => p === 'D:\\Lib\\Scriptless.funscript');
    expect(sidecarReads).toHaveLength(1);
  });

  it('a script added since the last scan still plays, as it did before V72 and does on a playlist card click', async () => {
    // The library's record says no script; the playlist's own pick is
    // `<name>.funscript`, which is on disk now.
    expect(app.library.getVideoByPath(LATE).hasFunscript).toBe(false);
    await playAll([LATE, PLAIN]);
    expect(app._currentVideoPath).toBe(LATE);
    expect(app.funscriptEngine.getActions()).toEqual(LATE_ACTIONS);
    expect(app._currentFunscriptPath).toBe(LATE_MAIN);
    expect(toasts.filter(([m]) => m.startsWith('toast.queueRead'))).toEqual([]);
  });

  it('a video the library does not hold still gets the queue item\'s own script', async () => {
    const elsewhere = 'E:\\Old\\Gone From Library.mp4';
    const elsewhereScript = 'E:\\Old\\Gone From Library.funscript';
    disk.set(elsewhereScript, script(PLAIN_ACTIONS));
    app._playAll([{ name: 'Gone From Library.mp4', path: elsewhere, funscriptPath: elsewhereScript }]);
    video.fire('loadeddata');
    await settle();
    expect(app._currentVideoPath).toBe(elsewhere);
    expect(app.funscriptEngine.getActions()).toEqual(PLAIN_ACTIONS);
    expect(toasts.filter(([m]) => m.startsWith('toast.queueRead'))).toEqual([]);
  });
});

// CB-12 (2026-11-05, found verifying block B; new since v0.9.2): a SCRIPTLESS
// video from a removed source, played by Play All, toasted "Queue item Bulk
// 003.mp4: script Bulk 003.funscript couldn't be read — playing without sync"
// for a script that never existed. Once the library no longer holds the
// video, the queue item's `<name>.funscript` is all there is, and it is only
// a GUESS. Only a script the app expected (an association, or the pairing the
// library held when the queue was built) may warn. The queue items here are
// built by the REAL Playlists and Categories components.
describe('CB-12: Play All warns only about a script it expected', () => {
  const BULK3 = 'E:\\Bulk\\Bulk 003.mp4';
  const BULK5 = 'E:\\Bulk\\Bulk 005.mp4';
  const BULK5_SCRIPT = 'E:\\Bulk\\scripts\\Bulk 005 v2.funscript';
  const readToasts = () => toasts.filter(([m]) => m.startsWith('toast.queueRead'));

  function playlists() {
    return new Playlists({
      settings: { get: (k) => app._settingsMap.get(k) },
      library: app.library,
      onPlayVideo: () => {},
      onPlayAll: (list, opts) => app._playAll(list, opts),
    });
  }

  async function playAllOf(items) {
    app._playAll(items);
    video.fire('loadeddata');
    await settle();
  }

  it('a scriptless video the library no longer holds plays with no "couldn\'t be read" toast', async () => {
    const [queued] = playlists()._queueItems([BULK3]);
    expect(queued.funscriptPath).toBe('E:\\Bulk\\Bulk 003.funscript'); // the guess
    await playAllOf([queued]);
    expect(app._currentVideoPath).toBe(BULK3);
    expect(readToasts()).toEqual([]);
  });

  it('the same from a category\'s Play All', async () => {
    api.filesExist = vi.fn(async (ps) => ps.map(() => true));
    const cats = new Categories({
      settings: {
        get: (k) => app._settingsMap.get(k),
        getCategories: () => [{ id: 'c1', name: 'Bulk', color: '#f00' }],
        getVideosByCategory: () => [BULK3],
      },
      library: app.library,
      onPlayVideo: () => {},
      onPlayAll: (list, opts) => app._playAll(list, opts),
    });
    await cats._playAllInCategory('c1');
    video.fire('loadeddata');
    await settle();
    expect(app._currentVideoPath).toBe(BULK3);
    expect(readToasts()).toEqual([]);
  });

  it('an ASSOCIATED script the app cannot read still warns, library or not', async () => {
    app._settingsMap.set('library.associations', {
      [BULK5]: { active: 'single', single: BULK5_SCRIPT, multi: null, custom: null },
    });
    const [queued] = playlists()._queueItems([BULK5]);
    expect(queued.funscriptPath).toBe(BULK5_SCRIPT);
    await playAllOf([queued]);
    expect(readToasts()).toEqual([
      ['toast.queueReadFailed {"name":"Bulk 005.mp4","script":"Bulk 005 v2.funscript"}', 'warn'],
    ]);
  });

  it('a pairing the library held when Play All started still warns once it is gone', async () => {
    const [queued] = playlists()._queueItems([PLAIN]); // the library pairs Plain with its script
    disk.delete(PLAIN_MAIN);
    app.library._videos = app.library._videos.filter((v) => v.path !== PLAIN); // source removed since
    await playAllOf([queued]);
    expect(readToasts()).toHaveLength(1);
  });

  it('a guessed script that IS there still loads, quietly', async () => {
    disk.set('E:\\Bulk\\Bulk 003.funscript', script(PLAIN_ACTIONS));
    const [queued] = playlists()._queueItems([BULK3]);
    await playAllOf([queued]);
    expect(app.funscriptEngine.getActions()).toEqual(PLAIN_ACTIONS);
    expect(readToasts()).toEqual([]);
  });
});
