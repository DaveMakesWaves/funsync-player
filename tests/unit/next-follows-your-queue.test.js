/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library (library.js) carries every load into
 * `_playFromLibrary`, and it imports DOM-branching modules (notes/CLAUDE.md
 * "Test environments").
 */
// FN-07 (Dave 2026-11-17: "n/next should play add to queue items", then
// "same with the previous video hotkeys"; also in v0.9.2). With "Add to
// queue" items and a video opened from the Library, N / Next did nothing:
// `_playNext` read only Play All's queue or a playlist, although the queue
// panel listed your queue as next, the Up Next card named its head and the
// end of the video played it. Now N plays your queue's head, and P from a
// video your queue played goes back to the video it followed (the video you
// leave goes back to the head of your queue). With nothing queued, N and P
// are what they were; Play All and playlists keep their own order.
//
// Every binding goes through these two methods: the N / P keys (keyboard.js
// onLoadNext / onLoadPrev), the player's prev / next buttons and the player
// pop-out's (PLAYERWIN LOAD_NEXT / LOAD_PREV). The REAL app.js methods run
// against a fake <video>, the real UpNextEngine and the real Library;
// assertions are on which video plays, whether it plays, what your queue
// holds and what the prev / next buttons offer.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';
import { Library } from '../../renderer/components/library.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { pathToFileURL, canonicalPath, isSubpath } from '../../renderer/js/path-utils.js';
import { PLAYBACK_RATE_PRESETS } from '../../renderer/js/video-player.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import {
  shuffle as shuffleArray, reshuffleAvoidingRepeat, balancedShuffle, reshuffleBalancedAvoidingRepeat,
} from '../../renderer/js/shuffle.js';
import { partitionByWatched } from '../../renderer/js/playlist-progress.js';

const LIFTED = [
  // Under test
  '_playNext', '_playPrev', '_userQueueBackHere', '_playUserQueueBack', '_jumpToVideoFromQueue',
  '_updateQueueUI', '_persistUserQueue',
  // What they hand over to, real
  '_stepPlayContext', '_nextQueueStep', '_queueWrapOrder', '_isUpNextPlayable', '_isUnderEnabledSource',
  '_queuedFileOnDisk', '_playUpNext', '_playUpNextInner', '_contextIndexOfNext', '_advanceQueueOnEnded',
  '_reshuffleQueueForWrap', '_playAll', '_playQueueItem', '_armQueueEndedListener', '_resolveUpNext',
  '_playFromLibrary', '_loadPlayContent', '_loadQueueItemContent', '_scriptKeyOf', '_playAllOrder',
  '_wrapOrder', '_withShuffledStart', '_reshuffleContextForWrap', '_editorAllowsReplace', '_autoplayOnAdvance',
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek', '_setUpNextContext',
  '_syncUpNextSuppression', '_startPlayback', '_playerWindowPlayback',
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
const OPENED = 'C:\\Elsewhere\\Opened.mp4'; // not in the library (opened with O)
const libVideo = (path) => ({ name: path.split('\\').pop(), path, hasFunscript: false });

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
let elements;
let relayed;

beforeAll(() => {
  Lifted = liftAppClass(LIFTED, {
    window: { get funsync() { return api; } },
    document: {
      documentElement: { dataset: { theme: 'dark', style: 'classic' } },
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { id, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {} });
        return elements.get(id);
      },
    },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    URL,
    pathToFileURL,
    canonicalPath,
    isSubpath,
    maybeShowHevcGuidance: () => {},
    isAutoMatch: () => false,
    showToast: () => {},
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

function buildApp(libraryPaths = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO]) {
  elements = new Map();
  relayed = [];
  api = {
    playerPopoutRelay: vi.fn((dir, msg) => relayed.push(msg)),
    playerPopoutReveal: vi.fn(),
    playerPopoutClose: vi.fn(),
    onPlayerPopoutEvent: () => {},
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (paths) => paths.map(() => true)),
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
    _userQueueBack: [],
    _userQueueNavPaths: new Set(),
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
    _isPlaylistContext: (ctx) => ctx?.source === 'playlist',
    getResumeEntry: () => null,
    _maybeOfferResume: async () => null,
    _updateVariantSelector() {},
    loadFunscript() {},
    _loadMultiAxisScripts() {},
    _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {},
    _refreshLoopVideoVisibility() {},
  });
  target.library = new Library({
    settings: target.settings,
    onPlayVideo: (v, fs, sub, variants) => target._playFromLibrary(v, fs, sub, variants),
  });
  target.library._videos = libraryPaths.map(libVideo);
  // A file the library does not hold opens by its path, as the queue's own
  // not-in-library route does (playlists._playVideoByPath).
  target.playlists = {
    _playVideoByPath: vi.fn(async (path, ctx, { autoPlay } = {}) => {
      const data = { name: path.split('\\').pop(), path, _isPathBased: true };
      if (autoPlay) data._autoPlayOnLoad = true;
      if (ctx) data._playContext = ctx;
      return target._playFromLibrary(data, null, null, []);
    }),
  };
  target.upNextEngine = new UpNextEngine({ videoPlayer: target.videoPlayer, funscriptEngine: target.funscriptEngine });
  target.upNextEngine.setSettings('auto', 10);
  target._initPlayerWindow();
  return target;
}

const libraryContext = (list, index) => ({ source: 'library', sourceLabel: 'library', sourceContext: {}, list, index });
const playlistContext = (list, index) => ({
  source: 'playlist', sourceLabel: 'Evening', sourceContext: { playlistId: 'p1' }, list, index,
});

/** Open a video from the library the way a click does. */
async function clickInLibrary(path, ctx = libraryContext([ALPHA, BRAVO, CHARLIE, DELTA, ECHO], 0)) {
  const v = app.library.getVideoByPath(path);
  v._playContextOverride = ctx;
  await app.library._playVideo(v);
  await vi.waitFor(() => expect(app._currentVideoPath).toBe(path));
  video.fire('loadeddata');
}

/** Press a key bound to `method` and wait for the video it loads. */
async function press(method, expectPath) {
  video.play.mockClear();
  const went = app[method]();
  if (expectPath) {
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(expectPath));
    video.fire('loadeddata');
  }
  return went;
}

const queueOf = () => [...app._userQueue];

beforeEach(() => {
  app = buildApp();
});

afterEach(() => {
  app.upNextEngine.hide();
  vi.restoreAllMocks();
});

describe('FN-07: N plays the videos you added with "Add to queue"', () => {
  it('a Library video and two queued: N plays the first queued video, and it plays', async () => {
    await clickInLibrary(ALPHA);
    app._userQueue = [BRAVO, CHARLIE];

    expect(await press('_playNext', BRAVO)).toBe(true);
    expect(video.play).toHaveBeenCalled();     // an explicit Next plays, whatever autoplayOnAdvance says
    expect(queueOf()).toEqual([CHARLIE]);       // it came off your queue

    await press('_playNext', CHARLIE);
    expect(queueOf()).toEqual([]);
  });

  it('N plays what the end of the video and the Up Next card would: your queue before the list', async () => {
    await clickInLibrary(ALPHA);
    app._userQueue = [DELTA];
    // The card names your queue's head ...
    expect(app.upNextEngine.getPriorityNext?.() ?? app._userQueue[0]).toBe(DELTA);
    // ... and N plays it, not the library list's next (Bravo).
    await press('_playNext', DELTA);
  });

  it('nothing queued: N and P are what they were (a Library video has no next or previous)', async () => {
    await clickInLibrary(BRAVO, libraryContext([ALPHA, BRAVO, CHARLIE], 1));
    expect(app._playNext()).toBe(false);
    expect(app._playPrev()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(app._currentVideoPath).toBe(BRAVO);
  });
});

describe('FN-07: P goes back from a video your queue played', () => {
  it('back to the Library video it followed, and the queued video goes back to the head of your queue', async () => {
    await clickInLibrary(ALPHA);
    app._userQueue = [BRAVO, CHARLIE];
    await press('_playNext', BRAVO);

    expect(await press('_playPrev', ALPHA)).toBe(true);
    expect(video.play).toHaveBeenCalled();
    expect(queueOf()).toEqual([BRAVO, CHARLIE]);
    // N then plays it again.
    await press('_playNext', BRAVO);
    expect(queueOf()).toEqual([CHARLIE]);
  });

  it('through a chain: Alpha, N Bravo, N Charlie, then P Bravo and P Alpha', async () => {
    await clickInLibrary(ALPHA);
    app._userQueue = [BRAVO, CHARLIE];
    await press('_playNext', BRAVO);
    await press('_playNext', CHARLIE);

    await press('_playPrev', BRAVO);
    expect(queueOf()).toEqual([CHARLIE]);
    await press('_playPrev', ALPHA);
    expect(queueOf()).toEqual([BRAVO, CHARLIE]);
    // Back at the Library video: no further way back.
    expect(app._playPrev()).toBe(false);
  });

  it('however the queued video started: the end-of-video advance into your queue too', async () => {
    await clickInLibrary(ALPHA);
    app._userQueue = [BRAVO];
    app._settingsMap.set('player.autoplayOnAdvance', true);
    await app._playUpNext(BRAVO);
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(BRAVO));
    video.fire('loadeddata');

    await press('_playPrev', ALPHA);
    expect(queueOf()).toEqual([BRAVO]);
  });

  it('back into a playlist: the video it followed plays with its playlist, which goes on from there', async () => {
    const pl = playlistContext([DELTA, ALPHA, ECHO], 1);
    await clickInLibrary(ALPHA, pl);
    app._userQueue = [BRAVO];
    await press('_playNext', BRAVO);

    await press('_playPrev', ALPHA);
    expect(app._currentPlayContext.source).toBe('playlist');
    expect(app._currentPlayContext.list).toEqual([DELTA, ALPHA, ECHO]);
    expect(app._currentPlayContext.index).toBe(1);
    // Your queue still comes first, then the playlist's own next.
    await press('_playNext', BRAVO);
    await press('_playPrev', ALPHA);
    app._userQueue = [];
    await press('_playNext', ECHO);
  });

  it('back to a video opened with O (not in the library): it opens by its path', async () => {
    app.loadVideo({ name: 'Opened.mp4', path: OPENED, _isPathBased: true }, { skipViewSwitch: true });
    video.fire('loadeddata');
    app._userQueue = [BRAVO];
    await press('_playNext', BRAVO);

    await press('_playPrev', OPENED);
    expect(app.playlists._playVideoByPath).toHaveBeenCalledWith(OPENED, null, { autoPlay: true });
    expect(queueOf()).toEqual([BRAVO]);
  });

  it('opening something else ends the way back: P then does what it always did', async () => {
    await clickInLibrary(ALPHA);
    app._userQueue = [BRAVO];
    await press('_playNext', BRAVO);
    await clickInLibrary(DELTA);

    expect(app._playPrev()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(app._currentVideoPath).toBe(DELTA);
    expect(queueOf()).toEqual([]);
  });
});

describe('FN-07: Play All is unchanged, with your queue in the middle of it', () => {
  const item = (p) => ({ name: p.split('\\').pop(), path: p, funscriptPath: null });

  it('N plays your queue\'s video between two Play All items; P goes back to the item it followed', async () => {
    app._playAll([item(ALPHA), item(CHARLIE), item(DELTA)], { label: 'All' });
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(ALPHA));
    video.fire('loadeddata');
    app._userQueue = [BRAVO];

    await press('_playNext', BRAVO);
    expect(app._currentPlayContext.interlude).toBe(true);
    expect(app._playQueue.map((v) => v.path)).toEqual([ALPHA, CHARLIE, DELTA]);

    await press('_playPrev', ALPHA);
    expect(app._playQueueIndex).toBe(0);
    expect(queueOf()).toEqual([BRAVO]);
    // With your queue empty, N is Play All's own next again.
    app._userQueue = [];
    await press('_playNext', CHARLIE);
    expect(app._playQueueIndex).toBe(1);
  });
});

describe('FN-07: the prev / next buttons and the pop-out offer it', () => {
  it('next shows and is live while your queue holds a video; prev while there is a way back', async () => {
    await clickInLibrary(ALPHA);
    const next = elements.get('btn-next');
    const prev = elements.get('btn-prev');
    expect(next.hidden).toBe(true);   // a Library video, nothing queued

    app._userQueue.push(BRAVO);
    app._persistUserQueue();          // what "Add to queue" runs
    expect(next.hidden).toBe(false);
    expect(next.disabled).toBe(false);
    expect(prev.disabled).toBe(true);
    expect(elements.get('queue-indicator').hidden).toBe(true); // your queue has no "N / total"

    await press('_playNext', BRAVO);
    expect(prev.hidden).toBe(false);
    expect(prev.disabled).toBe(false);
    expect(next.hidden).toBe(false);
    expect(next.disabled).toBe(true); // nothing left queued
  });

  it('the player pop-out is told the same', async () => {
    await clickInLibrary(ALPHA);
    app._playerWindowOpen = true;
    app._userQueue.push(BRAVO);
    app._persistUserQueue();
    const state = relayed.filter((m) => m.type === PLAYERWIN.QUEUE_STATE).at(-1);
    expect(state.hasNext).toBe(true);
    expect(state.hasPrev).toBe(false);
  });
});
