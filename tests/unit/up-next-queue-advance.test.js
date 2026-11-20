/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library (library.js) carries the advance from
 * `_playUpNext` into `_playFromLibrary`, and it imports DOM-branching
 * modules (notes/CLAUDE.md "Test environments").
 */
// Unattended advances: Up Next and the Play-All queue. App test 2026-11-02:
//
//   V25  "Start playing on open" (player.autoplayOnOpen) also played every
//        unattended Up Next advance, whatever "Auto-play the next video"
//        (player.autoplayOnAdvance) said. The advance reaches
//        _playFromLibrary by the same road as a library click.
//   V28  A shuffled, looping Play All replayed the same order every cycle
//        when the advance came from the queue's own 'ended' path (Up Next
//        off, or the pop-out's end). Only the Up Next path reshuffled.
//   V29  (app half) A looping playlist context wrapped Up Next to item 1
//        with an index past the end of the list, so the card after it
//        proposed item 1 again, forever. The playlists half (the context
//        carrying `loop` at all) is in playlist-continue-loop.test.js.
//
// The REAL app.js methods are lifted into a class (helpers/app-methods.js)
// and run against a fake inline <video> (a real EventTarget), the real
// UpNextEngine and the real Library._playVideo. Assertions are on what the
// user sees: whether the video starts playing, which file plays next, and
// what the Up Next card offers after it.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, onTestFinished } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';
import { Library } from '../../renderer/components/library.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { pathToFileURL, canonicalPath, isSubpath } from '../../renderer/js/path-utils.js';
import { Playlists } from '../../renderer/components/playlists.js';
import { PLAYBACK_RATE_PRESETS } from '../../renderer/js/video-player.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import {
  shuffle as shuffleArray, reshuffleAvoidingRepeat, balancedShuffle, reshuffleBalancedAvoidingRepeat,
} from '../../renderer/js/shuffle.js';
import { partitionByWatched } from '../../renderer/js/playlist-progress.js';

const LIFTED = [
  // Under test
  '_playUpNext', '_playUpNextInner', '_contextIndexOfNext', '_jumpToVideoFromQueue',
  '_advanceQueueOnEnded', '_reshuffleQueueForWrap', '_playAll', '_playQueueItem',
  '_armQueueEndedListener', // R3-09
  '_playFromLibrary', '_loadPlayContent', '_loadQueueItemContent',
  '_scriptKeyOf', '_playAllOrder', '_wrapOrder', '_withShuffledStart',
  '_reshuffleContextForWrap',
  // FT-018: what Up Next may offer, and a queued video whose source went
  '_isUpNextPlayable', '_isUnderEnabledSource', '_queuedFileOnDisk',
  // CB-10: the queue's one "what plays next", and the keys that step it
  '_resolveUpNext', '_nextQueueStep', '_queueWrapOrder', '_playNext', '_playPrev', '_stepPlayContext',
  // CB-01's unsaved-edits question on every load (a clean editor: no question)
  '_editorAllowsReplace',
  // CB-11: a queued next and "Auto-play the next video"
  '_autoplayOnAdvance',
  // The load path they run through, real
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek', '_setUpNextContext',
  '_syncUpNextSuppression', '_updateQueueUI', '_startPlayback', '_playerWindowPlayback',
  '_routeLoadedVideoToPlayerWindow', '_markCloudUploadsPending', '_resolveCloudUpload',
  '_clearCloudUploadGate', '_showScriptLoadingOverlay', '_hideScriptLoadingOverlay',
  '_initPlayerWindow', '_currentPopoutVideo', '_sendLoadVideoToPopout',
  '_streamPlayerWindowData', '_sendPlayerWindowPlaybackState', '_mirrorPopoutVolume',
];

const ALPHA = 'D:\\Lib\\Alpha.mp4';
const BRAVO = 'D:\\Lib\\Bravo.mp4';
const CHARLIE = 'D:\\Lib\\Charlie.mp4';
const DELTA = 'D:\\Lib\\Delta.mp4';
const ECHO = 'D:\\Lib\\Echo.mp4';
const libVideo = (path) => ({ name: path.split('\\').pop(), path, hasFunscript: false });

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
let video;
let app;
let Lifted;
let toasts = []; // [message, level] for every toast the lifted methods show

beforeAll(() => {
  Lifted = liftAppClass(LIFTED, {
    window: { get funsync() { return api; } },
    document: {
      documentElement: { dataset: { theme: 'dark', style: 'classic' } },
      getElementById: () => ({ hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {} }),
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL,
    pathToFileURL,
    canonicalPath,
    isSubpath,
    maybeShowHevcGuidance: () => {},
    isAutoMatch: () => false,
    showToast: (message, level) => { toasts.push([message, level]); },
    t: (key) => key,
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
  });
});

function buildApp(libraryPaths = [ALPHA, BRAVO, CHARLIE, DELTA]) {
  api = {
    playerPopoutRelay: vi.fn(),
    playerPopoutReveal: vi.fn(),
    playerPopoutClose: vi.fn(),
    onPlayerPopoutEvent: () => {},
    readFunscript: vi.fn(async () => null),
  };
  video = new FakeVideo();
  const settingsMap = new Map();
  const target = Object.assign(new Lifted(), {
    videoPlayer: {
      video,
      get duration() { return video.duration; },
      get currentTime() { return video.currentTime; },
      get paused() { return video.paused; },
      get ended() { return video.ended; },
      isVRProjecting: false,
      togglePlay: vi.fn(),
      loadSource: vi.fn((url) => { video.src = url; }),
      clearSubtitles: vi.fn(),
    },
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {} },
    funscriptEngine: { clear() {}, isLoaded: false, getActions: () => [] },
    settings: {
      get: (k) => settingsMap.get(k),
      set: (k, v) => settingsMap.set(k, v),
      addRecentFile() {},
    },
    _settingsMap: settingsMap,
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
    _resetCustomRoutingState() {},
    _isPlaylistContext: () => false,
    getResumeEntry: () => null,
    _maybeOfferResume: async () => null,
    _updateVariantSelector() {},
    loadFunscript() {},
    _loadMultiAxisScripts() {},
    _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {},
    _refreshLoopVideoVisibility() {},
  });
  // The REAL Library hands the advance to the app exactly as it does a click.
  target.library = new Library({
    settings: target.settings,
    onPlayVideo: (v, fs, sub, variants) => target._playFromLibrary(v, fs, sub, variants),
  });
  target.library._videos = libraryPaths.map(libVideo);
  target.upNextEngine = new UpNextEngine({ videoPlayer: target.videoPlayer, funscriptEngine: target.funscriptEngine });
  target.upNextEngine.setSettings('auto', 10);
  target.upNextShown = [];
  target.upNextEngine.onShowNext = (p) => target.upNextShown.push(p);
  target.upNextEngine.onShowEndOfList = () => target.upNextShown.push('END OF LIST');
  target._initPlayerWindow();
  return target;
}

/** Open a video from the library the way a click does (no flags). */
async function clickInLibrary(path, ctx) {
  const v = app.library.getVideoByPath(path);
  if (ctx) v._playContextOverride = ctx;
  await app.library._playVideo(v);
  video.fire('loadeddata');
}

/** What the Up Next card offers once the current video nears its end. */
function cardNearEnd() {
  video.currentTime = video.duration - 2;
  app.upNextEngine.check();
  const shown = app.upNextShown.at(-1);
  app.upNextEngine.hide();
  return shown;
}

beforeEach(() => {
  toasts = [];
  app = buildApp();
});

afterEach(() => {
  app.upNextEngine.hide();
  vi.restoreAllMocks();
});

const libraryContext = (list, index, extra = {}) => ({
  source: 'library', sourceLabel: 'library', sourceContext: {}, list, index, ...extra,
});

describe('V25: "Start playing on open" is for opens, not unattended advances', () => {
  it('with autoplayOnOpen on and autoplayOnAdvance off, an Up Next advance loads paused', async () => {
    app._settingsMap.set('player.autoplayOnOpen', true);
    app._settingsMap.set('player.autoplayOnAdvance', false);
    await clickInLibrary(ALPHA, libraryContext([ALPHA, BRAVO, CHARLIE], 0));
    video.play.mockClear();
    video.pause(); // the user's video ended; nothing is playing now

    await app._playUpNext(BRAVO);
    video.fire('loadeddata');

    expect(app._currentVideoPath).toBe(BRAVO);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
  });

  it('with autoplayOnAdvance on, the same advance plays (whatever autoplayOnOpen says)', async () => {
    for (const onOpen of [false, true]) {
      app = buildApp();
      app._settingsMap.set('player.autoplayOnOpen', onOpen);
      app._settingsMap.set('player.autoplayOnAdvance', true);
      await clickInLibrary(ALPHA, libraryContext([ALPHA, BRAVO, CHARLIE], 0));
      video.pause();
      video.play.mockClear();

      await app._playUpNext(BRAVO);
      video.fire('loadeddata');

      expect(video.play).toHaveBeenCalledTimes(1);
    }
  });

  it('a library click still starts playing with autoplayOnOpen on', async () => {
    app._settingsMap.set('player.autoplayOnOpen', true);
    await clickInLibrary(ALPHA);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('a library click still loads paused with autoplayOnOpen off (the default)', async () => {
    await clickInLibrary(ALPHA);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('an advance into the user\'s own queue does not play on autoplayOnOpen either', async () => {
    app._settingsMap.set('player.autoplayOnOpen', true);
    app._settingsMap.set('player.autoplayOnAdvance', false);
    await clickInLibrary(ALPHA, libraryContext([ALPHA, BRAVO], 0));
    video.pause();
    video.play.mockClear();
    app._userQueue = [DELTA];

    await app._playUpNext(DELTA);
    video.fire('loadeddata');

    expect(app._currentVideoPath).toBe(DELTA);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('the advance flag does not leak: the next click after an advance obeys autoplayOnOpen', async () => {
    app._settingsMap.set('player.autoplayOnOpen', true);
    app._settingsMap.set('player.autoplayOnAdvance', false);
    await clickInLibrary(ALPHA, libraryContext([ALPHA, BRAVO, CHARLIE], 0));
    await app._playUpNext(BRAVO);
    video.fire('loadeddata');
    video.pause();
    video.play.mockClear();

    await clickInLibrary(DELTA);
    expect(video.play).toHaveBeenCalledTimes(1);
  });
});

describe('V29 (app half): a looping playlist context wraps and keeps going', () => {
  const playlistContext = (list, index, loop) => ({
    source: 'playlist', sourceLabel: 'playlist "P"', sourceContext: { playlistId: 'p1' }, list, index, loop,
  });

  it('after the last item Up Next offers item 1, and after item 1 it offers item 2', async () => {
    const list = [ALPHA, BRAVO, CHARLIE];
    await clickInLibrary(CHARLIE, playlistContext(list, 2, true));
    expect(cardNearEnd()).toBe(ALPHA);

    await app._playUpNext(ALPHA);
    video.fire('loadeddata');

    expect(app._currentVideoPath).toBe(ALPHA);
    expect(app._currentPlayContext.index).toBe(0);
    expect(cardNearEnd()).toBe(BRAVO);
  });

  it('without Loop the last item still ends the list', async () => {
    await clickInLibrary(CHARLIE, playlistContext([ALPHA, BRAVO, CHARLIE], 2, false));
    expect(cardNearEnd()).toBe('END OF LIST');
  });

  it('an entry Up Next skipped (no longer in the library) does not send it back a step', async () => {
    app = buildApp([ALPHA, CHARLIE, DELTA]); // Bravo's source was removed
    app.upNextEngine.isPlayable = (p) => !!app.library.getVideoByPath(p);
    await clickInLibrary(ALPHA, playlistContext([ALPHA, BRAVO, CHARLIE, DELTA], 0, false));
    expect(cardNearEnd()).toBe(CHARLIE);

    await app._playUpNext(CHARLIE);
    video.fire('loadeddata');

    expect(app._currentPlayContext.index).toBe(2);
    expect(cardNearEnd()).toBe(DELTA); // not Charlie again
  });

  // The library empties under a playing video: every source disabled or its
  // drive unplugged, or a playlist opened before the first scan finished.
  // The app's isPlayable (app.js, mirrored here) then reports every path
  // playable, because unknown counts as playable, while getVideoByPath finds
  // none of them. A looping context wraps forever in that state.
  function emptyLibraryUnderneath() {
    app.upNextEngine.isPlayable = (p) => {
      const lib = app.library;
      if (!lib._videos || lib._videos.length === 0) return true;
      return !!lib.getVideoByPath(p);
    };
    app.library._videos = [];
  }

  it('with Loop on and nothing in the library, the advance stops with "not found" instead of recursing forever', async () => {
    await clickInLibrary(CHARLIE, playlistContext([ALPHA, BRAVO, CHARLIE], 2, true));
    emptyLibraryUnderneath();
    expect(cardNearEnd()).toBe(ALPHA); // the card still offers the wrap

    let thrown = null;
    try { await app._playUpNext(ALPHA); } catch (e) { thrown = e; }

    expect(thrown).toBeNull(); // used to be RangeError: Maximum call stack size exceeded
    expect(toasts).toEqual([['toast.nextNotFound', 'warn']]);
    expect(app._currentVideoPath).toBe(CHARLIE); // nothing else was loaded
  });

  it('without Loop, the same empty library still ends in one "not found"', async () => {
    await clickInLibrary(ALPHA, playlistContext([ALPHA, BRAVO, CHARLIE], 0, false));
    emptyLibraryUnderneath();

    await app._playUpNext(BRAVO);

    expect(toasts).toEqual([['toast.nextNotFound', 'warn']]);
    expect(app._currentVideoPath).toBe(ALPHA);
  });

  it('the walk still steps past a missing entry to one the library has', async () => {
    // Bravo vanished after the card offered it; Charlie is still there.
    await clickInLibrary(ALPHA, playlistContext([ALPHA, BRAVO, CHARLIE], 0, true));
    app.library._videos = app.library._videos.filter((v) => v.path !== BRAVO);

    await app._playUpNext(BRAVO);
    video.fire('loadeddata');

    expect(toasts).toEqual([]);
    expect(app._currentVideoPath).toBe(CHARLIE);
    expect(app._currentPlayContext.index).toBe(2);
  });
});

// CB-11 (2026-11-05, found verifying block B; also in v0.9.2): with Settings >
// Playback "Auto-play the next video" on, a video from the user's queue loaded
// paused every time. _playUpNextInner returned into _jumpToVideoFromQueue
// before the arming every other unattended next gets.
describe('CB-11: a video from your queue follows "Auto-play the next video"', () => {
  const item = (p) => ({ name: p.split('\\').pop(), path: p, funscriptPath: null });

  it('setting on: the Up Next advance into the queue starts playing', async () => {
    app._settingsMap.set('player.autoplayOnAdvance', true);
    await clickInLibrary(ALPHA, libraryContext([ALPHA, BRAVO], 0));
    video.pause();
    video.play.mockClear();
    app._userQueue = [DELTA];

    await app._playUpNext(DELTA);
    video.fire('loadeddata');

    expect(app._currentVideoPath).toBe(DELTA);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
  });

  it('setting on: the queue\'s own end-of-video advance (Up Next off) plays it too', async () => {
    app._settingsMap.set('player.autoplayOnAdvance', true);
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    video.pause();
    video.play.mockClear();
    app._userQueue = [DELTA];

    expect(app._advanceQueueOnEnded()).toBe(true);
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(DELTA));
    video.fire('loadeddata');

    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('setting on: a queued video the library no longer holds (played by path) starts playing', async () => {
    app = buildApp([ALPHA, BRAVO]);
    app._settingsMap.set('player.autoplayOnAdvance', true);
    api.filesExist = vi.fn(async (ps) => ps.map(() => true));
    const savedFunsync = window.funsync;
    window.funsync = api;
    onTestFinished(() => { window.funsync = savedFunsync; });
    app.playlists = new Playlists({
      settings: { get: (k) => app._settingsMap.get(k), set() {}, getPlaylists: () => [], getPlaylist: () => null },
      library: app.library,
      onPlayVideo: (v, fs, sub, variants) => app._playFromLibrary(v, fs, sub, variants),
      onPlayAll: vi.fn(),
    });
    await clickInLibrary(ALPHA, libraryContext([ALPHA, BRAVO], 0));
    video.pause();
    video.play.mockClear();
    app._userQueue = ['E:\\Gone\\Queued.mp4'];

    await app._playUpNext('E:\\Gone\\Queued.mp4');
    video.fire('loadeddata');

    expect(app._currentVideoPath).toBe('E:\\Gone\\Queued.mp4');
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('setting off: it still loads paused; and a click on the queue panel is a click, not an advance', async () => {
    await clickInLibrary(ALPHA, libraryContext([ALPHA, BRAVO], 0));
    video.pause();
    video.play.mockClear();
    app._userQueue = [DELTA];
    await app._playUpNext(DELTA);
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();

    app._settingsMap.set('player.autoplayOnAdvance', true); // on, but this is a click
    app._userQueue = [CHARLIE];
    await app._jumpToVideoFromQueue(CHARLIE);
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(CHARLIE);
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe('V28: a shuffled, looping Play All reshuffles on every wrap, whichever path advanced it', () => {
  // Deterministic Math.random (an LCG), so "the order changed" is a fact,
  // not a probability.
  function seedRandom(seed = 7) {
    let s = seed;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    });
  }

  const ITEMS = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO].map((p) => ({ name: p.split('\\').pop(), path: p }));
  // The library holds every queued video. It used to lack Echo, which the
  // queue played anyway; since CB-10 the queue skips what Up Next would not
  // offer, exactly as the card always did.
  beforeEach(() => { app = buildApp(ITEMS.map((v) => v.path)); });

  /** Play one full cycle through the queue's own 'ended' path; returns the order. */
  function playCycle() {
    const order = [app._currentVideoPath];
    for (let i = 1; i < ITEMS.length; i++) {
      expect(app._advanceQueueOnEnded()).toBe(true);
      order.push(app._currentVideoPath);
    }
    return order;
  }

  it('with Up Next off, the next cycle is a fresh order that does not repeat the last video', () => {
    seedRandom();
    app._playAll(ITEMS, { shuffle: true, loop: true });
    const first = playCycle();
    expect([...first].sort()).toEqual(ITEMS.map((v) => v.path).sort());

    expect(app._advanceQueueOnEnded()).toBe(true); // the wrap
    const second = playCycle();

    expect([...second].sort()).toEqual(ITEMS.map((v) => v.path).sort());
    expect(second).not.toEqual(first);
    expect(second[0]).not.toBe(first.at(-1));
    // The Up Next card / queue panel read the new order, not the old one.
    expect(app._currentPlayContext.list).toEqual(second);
  });

  it('a Play All that is not shuffled replays the list in order on the wrap', () => {
    app._playAll(ITEMS, { shuffle: false, loop: true });
    const first = playCycle();
    expect(app._advanceQueueOnEnded()).toBe(true);
    const second = playCycle();
    expect(first).toEqual(ITEMS.map((v) => v.path));
    expect(second).toEqual(first);
  });

  it('without Loop the queue ends instead of wrapping', () => {
    app._playAll(ITEMS, { shuffle: true, loop: false });
    playCycle();
    expect(app._advanceQueueOnEnded()).toBe(false);
  });

  it('the Up Next path still reshuffles on its wrap too', async () => {
    seedRandom(11);
    app._playAll(ITEMS, { shuffle: true, loop: true });
    const first = playCycle();
    // Up Next drives the wrap this time.
    await app._playUpNext(app._currentPlayContext.list[0]);
    const second = playCycle();
    expect(second).not.toEqual(first);
    expect(second[0]).not.toBe(first.at(-1));
  });
});

// FT-018 (2026-11-05, verifier 2; new since v0.9.2): a source removed while a
// video plays. Two misses in the running app:
//
//  1. Playlist [Bravo, Bulk 003 (source B), Charlie], B removed in Settings
//     while on the Playlists view: the card named Bulk 003 and played it.
//     Only the Library view rescans on a source change, so the library still
//     held B's videos and `isPlayable` (library holds it) said yes. Removed
//     from the Library view, it worked.
//  2. A video from B in the user's queue: after B was removed the advance
//     toasted "Next video not found in library", emptied the queue and played
//     nothing, though the file was on disk and the card had named it.
//
// The library here stays STALE on purpose (it still holds B's videos): that
// is the state the Playlists view leaves it in. `isPlayable` is wired the
// way app.js wires it, to the lifted `_isUpNextPlayable`.
describe('FT-018: Up Next after a source is removed or switched off', () => {
  const SRC_A = { id: 'a', name: 'library', path: 'D:\\Lib', enabled: true };
  const SRC_B = { id: 'b', name: 'bulk', path: 'E:\\Bulk', enabled: true };
  const BULK3 = 'E:\\Bulk\\Bulk 003.mp4';
  const BULK5 = 'E:\\Bulk\\Bulk 005.mp4';
  const playlistContext = (list, index) => ({
    source: 'playlist', sourceLabel: 'playlist "Mixed"', sourceContext: { playlistId: 'p1' }, list, index,
  });

  function wire(paths = [BRAVO, BULK3, CHARLIE, BULK5]) {
    app = buildApp(paths);
    app._settingsMap.set('library.sources', [SRC_A, SRC_B]);
    app.upNextEngine.isPlayable = (p) => app._isUpNextPlayable(p); // as app.js wires it
    return app;
  }

  it('a playlist entry from a removed source is skipped although the library was not rescanned', async () => {
    wire();
    await clickInLibrary(BRAVO, playlistContext([BRAVO, BULK3, CHARLIE], 0));
    expect(cardNearEnd()).toBe(BULK3); // before the removal: B is still a source

    app._settingsMap.set('library.sources', [SRC_A]); // Settings > Sources > remove B
    expect(app.library.getVideoByPath(BULK3)).toBeTruthy(); // stale: no rescan ran
    expect(cardNearEnd()).toBe(CHARLIE);

    await app._playUpNext(CHARLIE);
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(CHARLIE);
    expect(toasts).toEqual([]);
  });

  it('a source switched off counts as removed; the last one left ends the list', async () => {
    wire();
    await clickInLibrary(BRAVO, playlistContext([BRAVO, CHARLIE, BULK3], 1));
    app._settingsMap.set('library.sources', [SRC_A, { ...SRC_B, enabled: false }]);
    expect(cardNearEnd()).toBe('END OF LIST');
  });

  it('a library list behaves the same, and a look-alike folder name is not mistaken for the source', async () => {
    const LOOKALIKE = 'D:\\Lib2\\Twin.mp4';
    wire([ALPHA, LOOKALIKE, BULK3, CHARLIE]);
    app._settingsMap.set('library.sources', [SRC_A]);
    await clickInLibrary(ALPHA, libraryContext([ALPHA, LOOKALIKE, BULK3, CHARLIE], 0));
    expect(cardNearEnd()).toBe(CHARLIE);
  });

  it('a source typed with other separators, case or a trailing slash still holds its videos', async () => {
    wire();
    app._settingsMap.set('library.sources', [{ ...SRC_A, path: 'd:/lib/' }, SRC_B]);
    await clickInLibrary(BRAVO, playlistContext([BRAVO, CHARLIE, BULK3], 0));
    expect(cardNearEnd()).toBe(CHARLIE);
    expect(app._isUpNextPlayable(CHARLIE)).toBe(true);
    // A drive-root source holds everything on that drive.
    app._settingsMap.set('library.sources', [{ ...SRC_A, path: 'D:\\' }]);
    expect(app._isUpNextPlayable(CHARLIE)).toBe(true);
    expect(app._isUpNextPlayable(BULK3)).toBe(false);
  });

  it('unknown still counts as playable: no source list, or a library with nothing scanned', async () => {
    wire();
    app._settingsMap.set('library.sources', undefined);
    await clickInLibrary(BRAVO, playlistContext([BRAVO, BULK3, CHARLIE], 0));
    expect(cardNearEnd()).toBe(BULK3);
    expect(app._isUpNextPlayable('Z:\\Never\\Scanned.mp4')).toBe(false); // the library does not hold it
    app.library._videos = [];
    expect(app._isUpNextPlayable('Z:\\Never\\Scanned.mp4')).toBe(true);
  });

  it('a queued video from a removed source still plays, with its script, when the file is on disk', async () => {
    wire([BRAVO, CHARLIE]); // B removed AND rescanned: the library no longer holds Bulk 005
    app._settingsMap.set('library.sources', [SRC_A]);
    const BULK5_SCRIPT = 'E:\\Bulk\\Bulk 005.funscript';
    api.filesExist = vi.fn(async (ps) => ps.map(() => true));
    api.readFunscript = vi.fn(async (p) => (p === BULK5_SCRIPT ? '{"actions":[{"at":0,"pos":0},{"at":500,"pos":100}]}' : null));
    const loaded = [];
    app.loadFunscript = (fs) => loaded.push(fs?.name);
    // The REAL Playlists component, wired as app.js wires it: its path-only
    // play is what a playlist entry from a removed source already uses. It
    // is a real module, so it reads the real window's bridge.
    const savedFunsync = window.funsync;
    window.funsync = api;
    onTestFinished(() => { window.funsync = savedFunsync; });
    app.playlists = new Playlists({
      settings: { get: (k) => app._settingsMap.get(k), set() {}, getPlaylists: () => [], getPlaylist: () => null },
      library: app.library,
      onPlayVideo: (v, fs, sub, variants) => app._playFromLibrary(v, fs, sub, variants),
      onPlayAll: vi.fn(),
    });
    await clickInLibrary(BRAVO, libraryContext([BRAVO, CHARLIE], 0));
    app._userQueue = [BULK5];

    await app._playUpNext(BULK5);
    video.fire('loadeddata');

    expect(app._currentVideoPath).toBe(BULK5);
    expect(app._userQueue).toEqual([]);
    expect(api.readFunscript).toHaveBeenCalledWith(BULK5_SCRIPT);
    expect(loaded).toContain('Bulk 005.funscript');
    expect(toasts).toEqual([]);
  });

  it('a queued file that is really gone is still "not found", and nothing loads', async () => {
    wire([BRAVO, CHARLIE]);
    api.filesExist = vi.fn(async (ps) => ps.map(() => false));
    app.playlists = { _playVideoByPath: vi.fn() };
    await clickInLibrary(BRAVO, libraryContext([BRAVO, CHARLIE], 0));
    app._userQueue = [BULK5];

    await app._playUpNext(BULK5);

    expect(app.playlists._playVideoByPath).not.toHaveBeenCalled();
    expect(toasts).toEqual([['toast.nextNotFound', 'warn']]);
    expect(app._currentVideoPath).toBe(BRAVO);
  });
});

// CB-10 (2026-11-05, found verifying block B; new since v0.9.2): FT-018's last
// failing case. Play All from a playlist, source B removed while a video
// played: the card named "Channels Clip" (Charlie here), then the removed
// source's Bulk 003 played, and the card named Channels Clip again over it.
// The queue's advances took slot index+1 whatever it held; only the card's
// walk asked `_isUpNextPlayable`. Now one decision, `_nextQueueStep`, handed
// to the engine as `resolveNext`, is what the card names and what the
// countdown, the queue's own `ended` advance and N/P play.
describe('CB-10: Play All plays the video the Up Next card names', () => {
  const SRC_A = { id: 'a', name: 'library', path: 'D:\\Lib', enabled: true };
  const SRC_B = { id: 'b', name: 'bulk', path: 'E:\\Bulk', enabled: true };
  const BULK3 = 'E:\\Bulk\\Bulk 003.mp4';
  const BULK5 = 'E:\\Bulk\\Bulk 005.mp4';
  const item = (p) => ({ name: p.split('\\').pop(), path: p, funscriptPath: null });

  /** The library stays STALE (no rescan), as the Playlists view leaves it. */
  function wire(paths = [ALPHA, BRAVO, BULK3, CHARLIE, BULK5, DELTA]) {
    app = buildApp(paths);
    app._settingsMap.set('library.sources', [SRC_A, SRC_B]);
    // As app.js wires the engine.
    app.upNextEngine.isPlayable = (p) => app._isUpNextPlayable(p);
    app.upNextEngine.resolveNext = (ctx) => app._resolveUpNext(ctx);
    app.upNextEngine.onPlayNext = (p) => { app._playUpNext(p); };
    return app;
  }
  const removeB = () => app._settingsMap.set('library.sources', [SRC_A]);

  /** The card comes up near the end and its countdown runs out at the end. */
  function countdownToEnd() {
    vi.useFakeTimers();
    try {
      video.currentTime = video.duration - 2;
      app.upNextEngine.check();
      const named = app.upNextShown.at(-1);
      video.currentTime = video.duration;
      video.ended = true;
      vi.advanceTimersByTime(250); // the card's own tick fires the advance
      video.ended = false;
      return named;
    } finally {
      vi.useRealTimers();
    }
  }

  it('B removed mid-queue: the countdown plays the video the card named, not the removed source\'s next slot', () => {
    wire();
    app._playAll([BRAVO, BULK3, CHARLIE].map(item), { sourceLabel: 'Mixed' });
    video.fire('loadeddata');
    removeB(); // Settings > Sources > remove 'bulk', from the mini player

    expect(countdownToEnd()).toBe(CHARLIE);
    expect(app._currentVideoPath).toBe(CHARLIE);
    expect(app._playQueueIndex).toBe(2);
    // Nothing was removed from the queue: the skipped slot stays put.
    expect(app._playQueue.map((v) => v.path)).toEqual([BRAVO, BULK3, CHARLIE]);
  });

  it('with Up Next off, the queue\'s own end-of-video advance skips it too', () => {
    wire();
    app.upNextEngine.setSettings('off');
    app._playAll([BRAVO, BULK3, CHARLIE].map(item));
    video.fire('loadeddata');
    removeB();

    video.fire('ended');

    expect(app._currentVideoPath).toBe(CHARLIE);
  });

  it('N steps over it, and P steps back over it', () => {
    wire();
    app._playAll([BRAVO, BULK3, CHARLIE].map(item));
    removeB();

    expect(app._playNext()).toBe(true);
    expect(app._currentVideoPath).toBe(CHARLIE);
    expect(app._playPrev()).toBe(true);
    expect(app._currentVideoPath).toBe(BRAVO);
  });

  it('nothing playable after it: the card says End of list and the queue stops, playing nothing of B', () => {
    wire();
    app._playAll([BRAVO, BULK3, BULK5].map(item));
    removeB();

    expect(cardNearEnd()).toBe('END OF LIST');
    expect(app._advanceQueueOnEnded()).toBe(false);
    expect(app._currentVideoPath).toBe(BRAVO);
  });

  it('a looping Play All wraps past it to the video the card named', () => {
    wire();
    app._playAll([BRAVO, CHARLIE, BULK3].map(item), { loop: true });
    app._advanceQueueOnEnded(); // on to Charlie
    removeB();

    expect(countdownToEnd()).toBe(BRAVO);
    expect(app._currentVideoPath).toBe(BRAVO);
    expect(app._playQueueIndex).toBe(0);
  });

  it('a shuffled, looping Play All: the wrap plays the video the card named, whichever path advances', () => {
    const ITEMS = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO];
    for (const via of ['countdown', 'ended']) {
      for (let seed = 1; seed <= 6; seed++) {
        app = wire(ITEMS);
        let s = seed;
        const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
          s = (s * 1103515245 + 12345) % 2147483648;
          return s / 2147483648;
        });
        try {
          app._playAll(ITEMS.map(item), { shuffle: true, loop: true });
          for (let i = 1; i < ITEMS.length; i++) app._advanceQueueOnEnded();
          const named = cardNearEnd();
          if (via === 'countdown') countdownToEnd(); else app._advanceQueueOnEnded();
          expect(app._currentVideoPath, `${via}, seed ${seed}`).toBe(named);
        } finally {
          spy.mockRestore();
        }
      }
    }
  });

  it('unknown still counts as playable: with nothing scanned the queue plays every slot in order', () => {
    wire([]);
    removeB();
    app._playAll([BRAVO, BULK3].map(item));
    expect(app._advanceQueueOnEnded()).toBe(true);
    expect(app._currentVideoPath).toBe(BULK3);
  });
});
