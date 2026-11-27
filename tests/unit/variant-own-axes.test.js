/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library (library.js) pairs the axis files and
 * resolves what a click loads, and it imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// A script variant's own axis files play with it (TODO "Found while editing
// Dave's scripts", 2026-11-20; also in v0.9.2).
//
// "Vibcheck (muted).vib.funscript" beside "Vibcheck (muted).funscript": the
// switch to the muted variant never loaded it, and the DEFAULT script's
// "Vibcheck.vib.funscript" played with every variant (sandbox Vibcheck: the
// default's vib level 11 stayed after the switch; the muted one's is 77).
//
// The rule (app.js `_multiAxisForScript`): a variant's own same-folder axis
// files replace the video's, axis by axis; an axis it has none for keeps the
// video's; the video's own script brings the video's set back; an axis the
// user assigned by hand is never replaced; nothing plays where the user chose
// no companion files (a "Single" preference). The axes embedded in the main
// script follow the script that plays too.
//
// The REAL app.js methods are lifted (helpers/app-methods.js): a library
// click, the shared content load, the variant switch and pick, the multi-axis
// and embedded-axis loaders. They run against the REAL ButtplugSync,
// TCodeSync, FunscriptEngine and Library (its auto-pairing of axis files),
// with scripts served from an in-memory disk. What is asserted is what each
// engine will play on each channel.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { APP_SRC, liftAppClass } from './helpers/app-methods.js';
import { Library } from '../../renderer/components/library.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { FunscriptEngine, stripBOM } from '../../renderer/js/funscript-engine.js';
import { extractEmbeddedAxes } from '../../renderer/js/embedded-multi-axis.js';
import { getAxisBySuffix, sameFolderCompanions } from '../../renderer/js/multi-axis.js';
import { pickVariantIndexOnLoad } from '../../renderer/js/variant-select.js';
import { canonicalPath, pathToFileURL } from '../../renderer/js/path-utils.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const LIFTED = [
  // A library click and what it loads
  '_playFromLibrary', '_withShuffledStart', '_loadPlayContent', 'loadFunscript',
  '_loadMultiAxisScripts', '_feedEmbeddedMultiAxis', '_applyEmbeddedAxes', '_companionAxisSuffixes',
  '_releaseCompanionAxis', 'getEmbeddedAxes', '_readScriptResilient',
  // The variant switch and the pick at open, under test
  '_switchVariant', '_applyVariantAxes', '_multiAxisForScript', '_applyPreferredVariant',
  '_getPreferredVariantLabel', '_updateVariantSelector', '_variantLabelText', '_editorAllowsReplace',
  // The load path they run through
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek', '_setUpNextContext',
  '_syncUpNextSuppression', '_updateQueueUI', '_startPlayback', '_playerWindowPlayback',
  '_routeLoadedVideoToPlayerWindow', '_markCloudUploadsPending', '_resolveCloudUpload',
  '_clearCloudUploadGate', '_showScriptLoadingOverlay', '_hideScriptLoadingOverlay',
  '_resetCustomRoutingState',
];

const level = (pos, n = 4) => Array.from({ length: n }, (_, i) => ({ at: i * 1000, pos }));
const stroke = (base, n = 6) => Array.from({ length: n }, (_, i) => ({ at: i * 500, pos: (base + i * 17) % 100 }));
const script = (actions, extra = {}) => JSON.stringify({ actions, ...extra });

const LIB = 'C:\\Lib';
const VIDEO = `${LIB}\\Vibcheck.mp4`;
const MAIN = `${LIB}\\Vibcheck.funscript`;
const MAIN_VIB = `${LIB}\\Vibcheck.vib.funscript`;
const MAIN_TWIST = `${LIB}\\Vibcheck.twist.funscript`;
const MUTED = `${LIB}\\Vibcheck (muted).funscript`;
const MUTED_VIB = `${LIB}\\Vibcheck (muted).vib.funscript`;
const SOFT = `${LIB}\\Vibcheck (soft).funscript`;
// The muted variant's name in another folder: another copy, never this one's.
const ELSEWHERE_VIB = 'C:\\Elsewhere\\Vibcheck (muted).vib.funscript';

const ACTIONS = {
  main: stroke(5),
  mainVib: level(11),
  mainTwist: stroke(40, 5),
  muted: stroke(60),
  mutedVib: level(77),
  soft: stroke(30),
  elsewhereVib: level(33),
  mainRoll: stroke(20, 7),   // embedded in the main script (R1)
  softPitch: stroke(70, 8),  // embedded in the soft variant (R2)
};

function makeDisk({ withMainAxes = true } = {}) {
  const disk = new Map([
    [MAIN, script(ACTIONS.main, { axes: [{ id: 'R1', actions: ACTIONS.mainRoll }] })],
    [MUTED, script(ACTIONS.muted)],
    [MUTED_VIB, script(ACTIONS.mutedVib)],
    [SOFT, script(ACTIONS.soft, { axes: [{ id: 'R2', actions: ACTIONS.softPitch }] })],
    [ELSEWHERE_VIB, script(ACTIONS.elsewhereVib)],
  ]);
  if (withMainAxes) {
    disk.set(MAIN_VIB, script(ACTIONS.mainVib));
    disk.set(MAIN_TWIST, script(ACTIONS.mainTwist));
  }
  return disk;
}

/** The scan's record of Vibcheck: its script and its two variants. */
const vibcheckRecord = () => ({
  name: 'Vibcheck.mp4', path: VIDEO, hasFunscript: true, funscriptPath: MAIN,
  variants: [
    { label: 'Default', path: MAIN, name: 'Vibcheck.funscript' },
    { label: 'muted', path: MUTED, name: 'Vibcheck (muted).funscript' },
    { label: 'soft', path: SOFT, name: 'Vibcheck (soft).funscript' },
  ],
});

/** The inline <video>: a real EventTarget with the fields the app reads. */
class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      src: '', currentSrc: '', paused: true, ended: false, currentTime: 0, duration: 13,
      volume: 0.8, muted: false, loop: false, playbackRate: 1, error: null,
    });
    this.play = vi.fn(() => Promise.resolve());
    this.pause = vi.fn();
  }

  fire(type) {
    if (type === 'loadeddata') this.currentSrc = this.src;
    this.dispatchEvent(new Event(type));
  }
}

let Lifted;
let disk;
let els;
let video;
let app;

// The two methods this fix added are lifted when app.js has them, so this
// file also runs against a build without them and shows what that build did
// (the hole-reopen check); every other method must be there.
const ADDED = new Set(['_applyVariantAxes', '_multiAxisForScript']);
const inApp = (name) => new RegExp(`^  (?:async )?${name}\\(`, 'm').test(APP_SRC);

beforeAll(() => {
  Lifted = liftAppClass(LIFTED.filter((name) => !ADDED.has(name) || inApp(name)), {
    window: { get funsync() { return window.funsync; } },
    document: {
      documentElement: { dataset: { theme: 'dark', style: 'classic' } },
      getElementById: (id) => {
        if (!els[id]) els[id] = { id, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {} };
        return els[id];
      },
    },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    URL,
    pathToFileURL,
    canonicalPath,
    maybeShowHevcGuidance: () => {},
    isAutoMatch: () => false,
    showToast: () => {},
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    PLAYERWIN,
    shouldOfferResume: () => false,
    formatResumeTime: () => '',
    requestAnimationFrame: (fn) => fn(),
    stripBOM,
    extractEmbeddedAxes,
    getAxisBySuffix,
    sameFolderCompanions,
    pickVariantIndexOnLoad,
  });
});

/**
 * The app, its engines and the library, as a scan of the disk leaves them:
 * `prefer` is Settings "Default playback" (player.preferMultiAxis), and
 * `association` a saved one for Vibcheck (else FunSync pairs the axis files).
 */
function buildApp({ prefer = 'multi', association = null, withMainAxes = true } = {}) {
  disk = makeDisk({ withMainAxes });
  els = {};
  window.funsync = {
    readFunscript: vi.fn(async (p) => disk.get(p) ?? null),
    convertFunscript: vi.fn(async () => null),
    playerPopoutRelay: vi.fn(),
  };
  video = new FakeVideo();
  const settingsMap = new Map([['player.preferMultiAxis', prefer]]);
  if (association) settingsMap.set('library.associations', { [VIDEO]: association });
  const videoPlayer = {
    video,
    get duration() { return video.duration; },
    get currentTime() { return video.currentTime; },
    get paused() { return video.paused; },
    isVRProjecting: false,
    loadSource: vi.fn((url) => { video.src = url; }),
    clearSubtitles: vi.fn(),
    loadSubtitles: vi.fn(),
  };
  const buttplugManager = { connected: true, devices: [{ index: 0, name: 'Edge', canVibrate: true }], sendLinear: vi.fn() };
  const funscriptEngine = new FunscriptEngine({ backendPort: 5123 });
  const settings = {
    get: (k) => settingsMap.get(k),
    set: (k, v) => settingsMap.set(k, v),
    addRecentFile() {},
  };
  const target = Object.assign(new Lifted(), {
    videoPlayer,
    progressBar: {
      clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {}, renderHeatmap() {}, renderChapterStrip() {},
    },
    funscriptEngine,
    buttplugManager,
    settings,
    _settingsMap: settingsMap,
    scriptEditor: null,
    _pendingUploads: new Set(),
    _waitingForScript: false,
    _pendingFunscripts: [],
    _playQueue: [],
    _playQueueIndex: -1,
    _userQueue: [],
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
    _recordResumePosition() {},
    _isPlaylistContext: () => false,
    getResumeEntry: () => null,
    _maybeOfferResume: async () => null,
    _refreshLoopVideoVisibility() {},
    _showFunscriptBadge() {},
    _formatActionsDuration: () => '0:01',
    _refreshEditorScriptList() {},
    _manualVariantsFor: () => [],
    _planLazyRehome: () => null,
    _uploadAndStartSync: async () => {},
    _tryStartButtplugSync() {},
    _tryStartTCodeSync() {},
    _tryStartAutoblowSync: async () => {},
    _streamPlayerWindowData() {},
    upNextEngine: { setPlayContext() {}, setSuppressed() {}, hide() {}, check() {} },
  });
  target.buttplugSync = new ButtplugSync({ videoPlayer, buttplugManager, funscriptEngine });
  target.buttplugSync.start = vi.fn(); // not under test: it starts a scheduler
  target.tcodeSync = new TCodeSync({ videoPlayer, tcodeManager: {}, funscriptEngine });
  // The library as its scan pass leaves it: the scan's record and file list,
  // then the saved association, else FunSync's pairing of the axis files.
  const library = new Library({ settings, onPlayVideo: (v, fs, sub, variants) => target._playFromLibrary(v, fs, sub, variants) });
  library._videos = [vibcheckRecord()];
  library._videosByPath = new Map(library._videos.map((v) => [v.path, v]));
  library._allFunscripts = [...disk.keys()].map((p) => ({ name: p.split('\\').pop(), path: p }));
  library._validateAssociationsInBackground = () => {};
  library._applyManualAssociations();
  target.library = library;
  return target;
}

/** What each engine will play on a channel (null = nothing). */
const channel = (tcode) => ({
  buttplug: app.buttplugSync._axisActions.get(tcode)?.actions ?? null,
  tcode: app.tcodeSync._axisActions.get(tcode)?.actions ?? null,
});
const both = (actions) => ({ buttplug: actions, tcode: actions });
const NONE = both(null);

/** Click Vibcheck in the library, and let everything it loads land. */
async function openVibcheck() {
  await app.library._playVideo(app.library.getVideoByPath(VIDEO));
  video.fire('loadeddata');
  await vi.waitFor(() => expect(app.funscriptEngine.isLoaded).toBe(true));
}

/** Pick the variant whose file is `path`, as the menu does. */
async function pick(path) {
  const at = app._allVariantsWithManual.findIndex((v) => v.path === path);
  expect(at, `${path} is in the menu`).toBeGreaterThanOrEqual(0);
  await app._switchVariant(at);
  expect(app._activeVariantIndex).toBe(at);
}

beforeEach(() => {
  app = buildApp();
});

afterEach(() => {
  delete window.funsync;
  vi.restoreAllMocks();
});

describe('a variant plays with its own axis files (TODO 2026-11-20)', () => {
  it('the muted variant\'s own vib replaces the default\'s on both engines; the default\'s twist stays', async () => {
    await openVibcheck();
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mainVib)));
    expect(channel('R0')).toEqual(both(ACTIONS.mainTwist));

    await pick(MUTED);
    expect(app.funscriptEngine.getActions()).toEqual(ACTIONS.muted);
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mutedVib)));
    expect(channel('R0')).toEqual(both(ACTIONS.mainTwist));
    // Its own folder's file, never another copy of that name.
    expect(channel('V0').buttplug).not.toEqual(ACTIONS.elsewhereVib);
  });

  it('back to the default script: the default\'s vib again, nothing of the variant\'s left', async () => {
    await openVibcheck();
    await pick(MUTED);
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mutedVib)));

    await pick(MAIN);
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mainVib)));
    expect(channel('R0')).toEqual(both(ACTIONS.mainTwist));
    expect(app._currentMultiAxis).toBe(app.library.getVideoByPath(VIDEO)._multiAxis);
  });

  it('a variant with no axis files of its own keeps the default\'s', async () => {
    await openVibcheck();
    await pick(SOFT);
    await vi.waitFor(() => expect(app.funscriptEngine.getActions()).toEqual(ACTIONS.soft));
    expect(channel('V0')).toEqual(both(ACTIONS.mainVib));
    expect(channel('R0')).toEqual(both(ACTIONS.mainTwist));
  });

  it('muted then soft: the muted vib does not stay on with a variant that has none', async () => {
    await openVibcheck();
    await pick(MUTED);
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mutedVib)));
    await pick(SOFT);
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mainVib)));
  });

  it('a variant pinned as the default loads with its own vib when the video opens', async () => {
    app._settingsMap.set('library.preferredVariants', { [VIDEO]: 'muted' });
    await openVibcheck();
    await vi.waitFor(() => expect(app.funscriptEngine.getActions()).toEqual(ACTIONS.muted));
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mutedVib)));
    // The video's own reads, still landing, do not put the default's back.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(channel('V0')).toEqual(both(ACTIONS.mutedVib));
    expect(channel('R0')).toEqual(both(ACTIONS.mainTwist));
  });

  it('the axes embedded in the playing script follow the switch, on both engines', async () => {
    await openVibcheck();
    await vi.waitFor(() => expect(channel('R1')).toEqual(both(ACTIONS.mainRoll)));
    expect(channel('R2')).toEqual(NONE);

    await pick(SOFT);
    await vi.waitFor(() => expect(channel('R2')).toEqual(both(ACTIONS.softPitch)));
    expect(channel('R1'), 'the default\'s embedded roll is not left playing').toEqual(NONE);

    await pick(MAIN);
    await vi.waitFor(() => expect(channel('R1')).toEqual(both(ACTIONS.mainRoll)));
    expect(channel('R2')).toEqual(NONE);
  });

  it('a video whose own script has no axis files: the variant\'s vib plays, and goes with it', async () => {
    app = buildApp({ withMainAxes: false });
    await openVibcheck();
    expect(app._currentMultiAxis ?? null).toBeNull();
    expect(channel('V0')).toEqual(NONE);

    await pick(MUTED);
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mutedVib)));

    await pick(MAIN);
    await vi.waitFor(() => expect(channel('V0')).toEqual(NONE));
  });
});

describe('what a variant never changes', () => {
  it('an axis the user assigned by hand keeps their file', async () => {
    app = buildApp({
      association: { active: 'multi', single: MAIN, custom: null, multi: { main: MAIN, axes: { vib: MAIN_VIB }, buttplugVib: false } },
    });
    await openVibcheck();
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mainVib)));
    await pick(MUTED);
    await vi.waitFor(() => expect(app.funscriptEngine.getActions()).toEqual(ACTIONS.muted));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(channel('V0')).toEqual(both(ACTIONS.mainVib));
  });

  it('a hand-made set without a vib: the variant\'s own vib joins it, the user\'s twist stays', async () => {
    app = buildApp({
      association: { active: 'multi', single: MAIN, custom: null, multi: { main: MAIN, axes: { twist: MAIN_TWIST }, buttplugVib: false } },
    });
    await openVibcheck();
    await vi.waitFor(() => expect(channel('R0')).toEqual(both(ACTIONS.mainTwist)));
    expect(channel('V0')).toEqual(NONE);
    await pick(MUTED);
    await vi.waitFor(() => expect(channel('V0')).toEqual(both(ACTIONS.mutedVib)));
    expect(channel('R0')).toEqual(both(ACTIONS.mainTwist));
    await pick(MAIN);
    await vi.waitFor(() => expect(channel('V0')).toEqual(NONE));
    expect(channel('R0')).toEqual(both(ACTIONS.mainTwist));
  });

  it('"Single" playback: no axis file plays with any variant', async () => {
    app = buildApp({ prefer: 'single' });
    await openVibcheck();
    await pick(MUTED);
    await vi.waitFor(() => expect(app.funscriptEngine.getActions()).toEqual(ACTIONS.muted));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(channel('V0')).toEqual(NONE);
    expect(channel('R0')).toEqual(NONE);
  });

  it('a single-script association of the user\'s: no axis file plays with a variant either', async () => {
    app = buildApp({ withMainAxes: false, association: { active: 'single', single: MAIN, multi: null, custom: null } });
    await openVibcheck();
    await pick(MUTED);
    await vi.waitFor(() => expect(app.funscriptEngine.getActions()).toEqual(ACTIONS.muted));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(channel('V0')).toEqual(NONE);
  });
});
