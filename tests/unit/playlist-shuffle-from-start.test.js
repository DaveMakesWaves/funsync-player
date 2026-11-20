/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its detail view and
 * is clicked like a user would, and the REAL Library carries every advance
 * into `_playFromLibrary` (it imports DOM-branching modules; notes/CLAUDE.md
 * "Test environments").
 */
// App test 2026-11-02, V29, the Shuffle half (Dave's call the same day).
// A playlist's Shuffle reached only Play All. Clicking a video in the
// playlist, or Continue, played that video and then the REST OF THE LIST IN
// ORDER, Shuffle on or off. Loop was fixed earlier the same day
// (playlist-continue-loop.test.js); this is the order.
//
// Required: with Shuffle on, the clicked / Continue video plays first,
// exactly as before (Continue still asks to resume at its position and moves
// the playlist's Last watched marker), and every advance after it follows a
// shuffled order of the rest that honours "unwatched first" and "balance by
// script" the way Play All does. A Loop wrap reshuffles without repeating
// the video that just ended. Shuffle off: unchanged. (Play All itself is
// pinned by the V28 tests in up-next-queue-advance.test.js.)
//
// The REAL Playlists component is wired to REAL app.js methods (lifted,
// helpers/app-methods.js), the real UpNextEngine and the real
// Library._playVideo. Assertions are on what plays, in what order, and what
// the Up Next card offers. Math.random is seeded, so an order is a fact.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';
import { Library } from '../../renderer/components/library.js';
import { Playlists } from '../../renderer/components/playlists.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { pathToFileURL, canonicalPath, isSubpath } from '../../renderer/js/path-utils.js';
import { PLAYBACK_RATE_PRESETS } from '../../renderer/js/video-player.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import {
  shuffle as shuffleArray, reshuffleAvoidingRepeat, balancedShuffle, reshuffleBalancedAvoidingRepeat,
} from '../../renderer/js/shuffle.js';
import { partitionByWatched } from '../../renderer/js/playlist-progress.js';
import {
  shouldRecordPosition, shouldOfferResume, formatResumeTime, makeResumeEntry, makeFinishedEntry,
  isFinished, endThreshold, RESUME_WRITE_INTERVAL_MS, RESUME_MIN_DELTA_SECONDS,
} from '../../renderer/js/resume-position.js';

const LIFTED = [
  // Under test
  '_playFromLibrary', '_loadPlayContent', '_withShuffledStart', '_playAllOrder', '_scriptKeyOf',
  '_playUpNext', '_playUpNextInner', '_contextIndexOfNext', '_reshuffleContextForWrap', '_wrapOrder',
  '_isUnderEnabledSource',
  '_playNext', '_stepPlayContext', '_nextQueueStep', '_queueWrapOrder', '_isUpNextPlayable', // CB-10
  '_resolveUpNext', // R3-14: what the card names at a shuffled context's wrap
  '_editorAllowsReplace', // CB-01's unsaved-edits question (no editor here: no question)
  '_autoplayOnAdvance', // CB-11: "Auto-play the next video", read by every unattended advance
  // Resume + Last watched, real
  '_isPlaylistContext', '_playlistIdOf', '_recordResumePosition', '_markPlaylistLastWatched',
  '_resumeClockSource', '_writeResumeEntry', 'getResumeEntry', '_resumeMap',
  '_isSessionResumeClock', // 2026-11-07: whose clock it is (a phone's / headset's, or this window's)
  // The load path they run through, real
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek', '_setUpNextContext',
  '_syncUpNextSuppression', '_updateQueueUI', '_startPlayback', '_playerWindowPlayback',
  '_routeLoadedVideoToPlayerWindow', '_markCloudUploadsPending', '_resolveCloudUpload',
  '_clearCloudUploadGate', '_showScriptLoadingOverlay', '_hideScriptLoadingOverlay',
  '_initPlayerWindow', '_currentPopoutVideo', '_sendLoadVideoToPopout',
  '_streamPlayerWindowData', '_sendPlayerWindowPlaybackState', '_mirrorPopoutVolume',
];

const P = (name) => `D:\\PL\\${name}.mp4`;
const ALPHA = P('Alpha');
const BRAVO = P('Bravo');
const CHARLIE = P('Charlie');
const DELTA = P('Delta');
const ECHO = P('Echo');
const FOXTROT = P('Foxtrot');
const SIX = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO, FOXTROT];
const SHARED_SCRIPT = 'D:\\PL\\Shared.funscript';

/** The inline <video>: a real EventTarget with the fields the app reads. */
class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      src: '', currentSrc: '', paused: true, ended: false, currentTime: 0, duration: 600,
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
let playlists;
let playlist;
let store;
let container;
let lastPlay;
let toasts = [];
let savedFunsync;
let Lifted;

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
    requestAnimationFrame: (fn) => fn(),
    shuffleArray,
    reshuffleAvoidingRepeat,
    balancedShuffle,
    reshuffleBalancedAvoidingRepeat,
    partitionByWatched,
    shouldRecordPosition,
    shouldOfferResume,
    formatResumeTime,
    makeResumeEntry,
    makeFinishedEntry,
    isFinished,
    endThreshold,
    RESUME_WRITE_INTERVAL_MS,
    RESUME_MIN_DELTA_SECONDS,
  });
});

// Deterministic Math.random (an LCG), as in the V28 tests.
function seedRandom(seed) {
  let s = seed;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  });
}

/**
 * The app, its library (`scripts` maps a video to its funscript; every
 * video has one so balance-by-script has something to group by) and the
 * Playlists view, sharing one settings store as in the real app.
 */
function build({ paths = SIX, scripts = {}, shuffle = false, loop = false, balanceByScript = false,
  preferUnwatched = false } = {}) {
  toasts = [];
  lastPlay = null;
  playlist = { id: 'p1', name: 'P', videoPaths: paths.slice(), loop, shuffle, balanceByScript, preferUnwatched };
  store = new Map([
    ['library.resumePositions', {}],
    ['library.playlistProgress', {}],
  ]);
  const settings = {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    addRecentFile() {},
    getPlaylists: () => [playlist],
    getPlaylist: (id) => (id === playlist.id ? playlist : null),
    setPlaylistLoop: (id, v) => { if (id === playlist.id) playlist.loop = !!v; },
    setPlaylistShuffle: (id, v) => { if (id === playlist.id) playlist.shuffle = !!v; },
  };
  api = {
    playerPopoutRelay: vi.fn(),
    playerPopoutReveal: vi.fn(),
    playerPopoutClose: vi.fn(),
    onPlayerPopoutEvent: () => {},
    filesExist: vi.fn(async (list) => list.map(() => true)),
    readFunscript: vi.fn(async () => '{"actions":[]}'),
    getThumbnail: vi.fn(async () => null),
  };
  window.funsync = api;
  video = new FakeVideo();
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
    settings,
    _pendingUploads: new Set(),
    _waitingForScript: false,
    _pendingFunscripts: [],
    _playQueue: [],
    _playQueueIndex: -1,
    _userQueue: [],
    // The resume prompt a deliberate open shows; the user picks Resume.
    resumePrompts: [],
    async _maybeOfferResume(path) {
      this.resumePrompts.push(path);
      return this.getResumeEntry(path)?.position ?? null;
    },
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
    _resetCustomRoutingState() {},
    _updateVariantSelector() {},
    loadFunscript() {},
    _loadMultiAxisScripts() {},
    _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {},
    _refreshLoopVideoVisibility() {},
  });
  const onPlayVideo = (v, fs, sub, variants) => {
    lastPlay = target._playFromLibrary(v, fs, sub, variants);
    return lastPlay;
  };
  // The REAL Library hands every advance to the app exactly as a click does.
  target.library = new Library({ settings, onPlayVideo });
  target.library._videos = paths.map((p) => ({
    name: p.split('\\').pop(), path: p, hasFunscript: true,
    funscriptPath: scripts[p] || p.replace(/\.mp4$/, '.funscript'),
  }));
  target.upNextEngine = new UpNextEngine({ videoPlayer: target.videoPlayer, funscriptEngine: target.funscriptEngine });
  target.upNextEngine.setSettings('auto', 10);
  target.upNextEngine.isPlayable = (p) => !!target.library.getVideoByPath(p);
  target.upNextShown = [];
  target.upNextEngine.onShowNext = (p) => target.upNextShown.push(p);
  target.upNextEngine.onShowEndOfList = () => target.upNextShown.push('END OF LIST');
  target._initPlayerWindow();
  app = target;

  playlists = new Playlists({
    settings,
    library: target.library,
    onPlayVideo,
    onPlayAll: vi.fn(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  playlists._container = container;
}

/** Let a click's async chain (funscript read, then the app's load) finish. */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  if (lastPlay) await lastPlay;
  video.fire('loadeddata');
}

async function renderDetail() {
  playlists._view = 'detail';
  playlists._detailPlaylistId = playlist.id;
  await playlists._renderDetail(playlist.id);
  await new Promise((r) => setTimeout(r, 0));
}

async function clickCard(path) {
  const name = path.split('\\').pop().replace(/\.[^.]+$/, '');
  const card = [...container.querySelectorAll('.playlists__video-card')]
    .find((el) => el.querySelector('.playlists__video-title')?.textContent === name);
  expect(card, `no card for ${name}`).toBeTruthy();
  card.click();
  await settle();
}

/** What the Up Next card offers once the current video nears its end. */
function cardNearEnd() {
  video.currentTime = video.duration - 2;
  app.upNextEngine.check();
  const shown = app.upNextShown.at(-1);
  app.upNextEngine.hide();
  return shown;
}

/** Let Up Next advance: returns what the card offered and what then played. */
async function advance() {
  const offered = cardNearEnd();
  await app._playUpNext(offered);
  video.fire('loadeddata');
  return { offered, played: app._currentVideoPath };
}

/** Advance `n` times through Up Next; returns the videos that played. */
async function advanceTimes(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await advance()).played);
  return out;
}

const sorted = (a) => [...a].sort();

beforeEach(() => {
  savedFunsync = window.funsync;
});

afterEach(() => {
  app?.upNextEngine?.hide();
  container?.remove();
  window.funsync = savedFunsync;
  vi.restoreAllMocks();
});

describe('V29: with Shuffle on, a video card plays first and the rest follow in a shuffled order', () => {
  it('the clicked video plays, then Up Next walks a shuffled order of the rest, each once, then ends', async () => {
    seedRandom(3);
    build();
    await renderDetail();
    // Shuffle switched on in the header AFTER the cards rendered, as a user does.
    const shuffleBtn = container.querySelector('.playlists__shuffle-btn');
    shuffleBtn.click();
    expect(shuffleBtn.getAttribute('aria-pressed')).toBe('true');

    await clickCard(CHARLIE);
    expect(app._currentVideoPath).toBe(CHARLIE);

    const offeredAndPlayed = [];
    for (let i = 0; i < 5; i++) offeredAndPlayed.push(await advance());
    const rest = offeredAndPlayed.map((s) => s.played);

    expect(sorted(rest)).toEqual(sorted([ALPHA, BRAVO, DELTA, ECHO, FOXTROT]));
    // Not list order: that would be Delta, Echo, Foxtrot and then the end.
    expect(rest.slice(0, 3)).not.toEqual([DELTA, ECHO, FOXTROT]);
    expect(rest).not.toEqual([ALPHA, BRAVO, DELTA, ECHO, FOXTROT]);
    // The card offered exactly what then played, every time.
    for (const { offered, played } of offeredAndPlayed) expect(played).toBe(offered);
    // Loop off: after the sixth video the list ends.
    expect(cardNearEnd()).toBe('END OF LIST');
  });

  it('N (next video) steps through the same shuffled order', async () => {
    seedRandom(5);
    build({ shuffle: true });
    await renderDetail();
    await clickCard(BRAVO);
    const order = app._currentPlayContext.list.slice();
    expect(order[0]).toBe(BRAVO);

    expect(app._playNext()).toBe(true);
    await settle();
    expect(app._currentVideoPath).toBe(order[1]);
    expect(app._playNext()).toBe(true);
    await settle();
    expect(app._currentVideoPath).toBe(order[2]);
    expect(order.slice(1, 3)).not.toEqual([CHARLIE, DELTA]); // not list order
  });

  it('Shuffle off: the rest of the list plays in order, as before', async () => {
    seedRandom(3);
    build({ shuffle: false });
    await renderDetail();
    await clickCard(BRAVO);

    expect(await advanceTimes(4)).toEqual([CHARLIE, DELTA, ECHO, FOXTROT]);
    expect(cardNearEnd()).toBe('END OF LIST');
  });
});

describe('V29: Continue with Shuffle on', () => {
  function markInProgress(path, position = 120) {
    store.set('library.resumePositions', { ...store.get('library.resumePositions'), [path]: { position, duration: 600, updatedAt: 1 } });
    store.set('library.playlistProgress', { p1: { lastVideoPath: path, updatedAt: 1 } });
  }

  it('resumes the marked video at its saved position exactly as with Shuffle off', async () => {
    for (const shuffle of [false, true]) {
      seedRandom(7);
      build({ shuffle });
      markInProgress(DELTA, 120);
      await playlists._continueFromLastWatched(playlist);
      await settle();

      expect(app._currentVideoPath).toBe(DELTA);
      expect(app.resumePrompts).toEqual([DELTA]); // the same resume prompt
      expect(video.currentTime).toBe(120); // and it starts where you left off
    }
  });

  it('then the next three are a shuffled draw, not Echo, Foxtrot, end of list', async () => {
    seedRandom(7);
    build({ shuffle: true });
    markInProgress(DELTA, 120);
    await playlists._continueFromLastWatched(playlist);
    await settle();

    const next3 = await advanceTimes(3);
    expect(next3).not.toContain(DELTA);
    expect(new Set(next3).size).toBe(3);
    expect(next3.slice(0, 2)).not.toEqual([ECHO, FOXTROT]);

    // Shuffle off, the same Continue goes on in list order and then ends.
    build({ shuffle: false });
    markInProgress(DELTA, 120);
    await playlists._continueFromLastWatched(playlist);
    await settle();
    expect(await advanceTimes(2)).toEqual([ECHO, FOXTROT]);
    expect(cardNearEnd()).toBe('END OF LIST');
  });

  it('the playlist\'s Last watched marker and resume position follow the shuffled playback', async () => {
    seedRandom(7);
    build({ shuffle: true });
    markInProgress(DELTA, 120);
    await playlists._continueFromLastWatched(playlist);
    await settle();
    const [second] = await advanceTimes(1);

    video.currentTime = 200;
    app._recordResumePosition({ force: true });

    expect(store.get('library.playlistProgress').p1.lastVideoPath).toBe(second);
    expect(store.get('library.resumePositions')[second].position).toBe(200);
  });
});

describe('V29: the shuffled rest honours the playlist options the way Play All does', () => {
  it('unwatched first: after the clicked video, every unwatched one plays before any watched one', async () => {
    for (let seed = 1; seed <= 6; seed++) {
      seedRandom(seed);
      build({ shuffle: true, preferUnwatched: true });
      store.set('library.resumePositions', {
        [ALPHA]: makeFinishedEntry(600, 1),
        [BRAVO]: makeFinishedEntry(600, 1),
      });
      await renderDetail();
      await clickCard(ECHO);

      const rest = await advanceTimes(5);
      expect(sorted(rest.slice(0, 3)), `seed ${seed}`).toEqual(sorted([CHARLIE, DELTA, FOXTROT]));
      expect(sorted(rest.slice(3)), `seed ${seed}`).toEqual(sorted([ALPHA, BRAVO]));
      container.remove();
    }
  });

  it('balance by script: the clicked video takes its script\'s slot, so its siblings wait for the next cycle', async () => {
    const scripts = { [ALPHA]: SHARED_SCRIPT, [BRAVO]: SHARED_SCRIPT, [CHARLIE]: SHARED_SCRIPT };
    for (let seed = 1; seed <= 6; seed++) {
      seedRandom(seed);
      build({ scripts, shuffle: true, balanceByScript: true, loop: true });
      await renderDetail();
      await clickCard(BRAVO);

      // One cycle: Bravo stands in for the shared script, then the three
      // videos with scripts of their own, once each.
      const cycle = await advanceTimes(3);
      expect(sorted(cycle), `seed ${seed}`).toEqual(sorted([DELTA, ECHO, FOXTROT]));

      // The wrap draws a fresh cycle: one representative of the shared
      // script plus the other three, never opening on the script that ended.
      const next = await advanceTimes(4);
      const shared = next.filter((p) => [ALPHA, BRAVO, CHARLIE].includes(p));
      expect(shared, `seed ${seed}`).toHaveLength(1);
      expect(sorted(next.filter((p) => !shared.includes(p))), `seed ${seed}`).toEqual(sorted([DELTA, ECHO, FOXTROT]));
      expect(next[0], `seed ${seed}`).not.toBe(cycle.at(-1));
      container.remove();
    }
  });
});

describe('V29: a Loop wrap reshuffles, without repeating the video that just ended', () => {
  const FIVE = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO];

  it('the second cycle is a fresh order of all five that does not open on the last one', async () => {
    seedRandom(11);
    build({ paths: FIVE, shuffle: true, loop: true });
    await renderDetail();
    await clickCard(CHARLIE);

    const first = [CHARLIE, ...(await advanceTimes(4))];
    expect(sorted(first)).toEqual(sorted(FIVE));

    const second = await advanceTimes(5);
    expect(sorted(second)).toEqual(sorted(FIVE));
    expect(second).not.toEqual(first);
    expect(second[0]).not.toBe(first.at(-1));
    // The counter and the card follow the new order: the card after the
    // wrap offers the second video of the new cycle, not of the old one.
    expect(app._currentPlayContext.list).toEqual(second);
  });

  it('never repeats the video that just ended, whatever the draw', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      seedRandom(seed);
      build({ paths: FIVE, shuffle: true, loop: true });
      await renderDetail();
      await clickCard(ALPHA);
      const first = [ALPHA, ...(await advanceTimes(4))];
      const [afterWrap] = await advanceTimes(1);
      expect(afterWrap, `seed ${seed}`).not.toBe(first.at(-1));
      container.remove();
    }
  });

  it('with nothing left in the library at the wrap, it stops with one "not found" instead of crashing', async () => {
    seedRandom(2);
    build({ paths: FIVE, shuffle: true, loop: true });
    await renderDetail();
    await clickCard(ALPHA);
    await advanceTimes(4);
    const last = app._currentVideoPath;
    const offered = cardNearEnd();
    // Every source switched off under the playing video (see the V29 review
    // tests in up-next-queue-advance.test.js for why isPlayable says yes).
    app.upNextEngine.isPlayable = () => true;
    app.library._videos = [];

    await app._playUpNext(offered);

    expect(toasts).toEqual([['toast.nextNotFound', 'warn']]);
    expect(app._currentVideoPath).toBe(last);
  });
});

// R3-14 (found while CB-10): with the engine wired as app.js wires it
// (`resolveNext`, `isPlayable`), the card at a shuffled context's Loop wrap
// named the OLD order's first entry, then the advance drew a fresh order and
// played ITS first. One draw now, named by the card and played by the advance.
describe('R3-14: at a shuffled, looping card click\'s wrap, the card names what plays', () => {
  const FIVE = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO];

  function wireAsTheApp() {
    app.upNextEngine.isPlayable = (p) => app._isUpNextPlayable(p);
    app.upNextEngine.resolveNext = (ctx) => app._resolveUpNext(ctx);
  }

  it('every wrap, over many draws: the video the card names is the one that plays, and it is not the one that just ended', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      seedRandom(seed);
      build({ paths: FIVE, shuffle: true, loop: true });
      wireAsTheApp();
      await renderDetail();
      await clickCard(BRAVO);
      const first = [BRAVO, ...(await advanceTimes(4))];
      const { offered, played } = await advance(); // the wrap
      expect(played, `seed ${seed}`).toBe(offered);
      expect(played, `seed ${seed}`).not.toBe(first.at(-1));
      // ...and the card after it is the new cycle's second video.
      expect(app._currentPlayContext.list[0]).toBe(played);
      expect(cardNearEnd(), `seed ${seed}`).toBe(app._currentPlayContext.list[1]);
      container.remove();
    }
  });

  it('the card asked twice before the end names the same video both times (one draw per cycle end)', async () => {
    seedRandom(3);
    build({ paths: FIVE, shuffle: true, loop: true });
    wireAsTheApp();
    await renderDetail();
    await clickCard(ALPHA);
    await advanceTimes(4);
    const once = cardNearEnd();
    const twice = cardNearEnd();
    expect(twice).toBe(once);
    await app._playUpNext(twice);
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(once);
  });

  it('Shuffle off with Loop: the wrap is item 1, as before', async () => {
    build({ paths: FIVE, shuffle: false, loop: true });
    wireAsTheApp();
    await renderDetail();
    await clickCard(DELTA);
    expect(await advanceTimes(2)).toEqual([ECHO, ALPHA]);
  });
});
