/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Modal draws the unsaved-changes question in the
 * document, and script-editor.js / library.js import DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// Round 3 (2026-11-06): Cancel at the unsaved-changes question means "not
// now", on every advance route, and changes NOTHING.
//
//   R3-09  With Up Next off (or not driving), Cancel at the question raised
//          by Play All's own end-of-video advance left Play All dead for that
//          video: the queue's `ended` listener had removed itself before the
//          load asked, and nothing armed it again.
//   R3-10  Cancel at an advance into YOUR queue dropped the queued video: the
//          head came off the queue (and was saved) and history took the video
//          being left before the question; a shuffled Play All wrap drew and
//          kept its new order before it too.
//   R3-11  A second route asking at the same end (the queue's `ended` while
//          Up Next's question was open) got `false` from "one question at a
//          time" and re-armed Up Next with that question still up: the card
//          could come back and count down under the open dialog.
//   R3-15  A video from your queue played during Play All ENDED the Play All
//          (it loaded as a library click, which clears the queue). foobar2000:
//          after the queued video, the playlist goes on.
//
// What runs is REAL: the app.js advance and load methods (lifted,
// helpers/app-methods.js), the UpNextEngine wired as app.js wires it, the
// Library's click route, the ScriptEditor's question (its prototype on a
// stand-in panel) and the Modal. Asserted is what the user sees and keeps:
// whether a question shows, what plays, what the queue, history and order
// hold afterwards.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { UpNextEngine } = await import('../../renderer/js/up-next.js');
const { Library } = await import('../../renderer/components/library.js');
const { RemotePlaybackProxy } = await import('../../renderer/js/remote-playback-proxy.js');
const { pathToFileURL, canonicalPath, isSubpath } = await import('../../renderer/js/path-utils.js');
const { PLAYBACK_RATE_PRESETS } = await import('../../renderer/js/video-player.js');
const PLAYERWIN = await import('../../renderer/js/player-popout-protocol.js');
const {
  shuffle: shuffleArray, reshuffleAvoidingRepeat, balancedShuffle, reshuffleBalancedAvoidingRepeat,
} = await import('../../renderer/js/shuffle.js');
const { partitionByWatched } = await import('../../renderer/js/playlist-progress.js');

const LIFTED = [
  // Under test
  '_playUpNext', '_playUpNextInner', '_jumpToVideoFromQueue', '_advanceQueueOnEnded',
  '_armQueueEndedListener', '_playQueueItem', '_playAll', '_editorAllowsReplace',
  '_reshuffleQueueForWrap', '_queueWrapOrder', '_nextQueueStep', '_resolveUpNext',
  '_reshuffleContextForWrap', '_contextIndexOfNext', '_wrapOrder', '_playAllOrder', '_scriptKeyOf',
  '_withShuffledStart', '_isUpNextPlayable', '_isUnderEnabledSource', '_queuedFileOnDisk',
  '_maybePushCurrentToHistory', '_persistUserQueue', '_autoplayOnAdvance', '_onPopoutVideoEnded',
  '_playPrev', '_playNext', '_stepPlayContext', '_playlistIdOf', '_isPlaylistContext',
  // The load path they run through, real
  '_playFromLibrary', '_loadPlayContent', '_loadQueueItemContent',
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek', '_setUpNextContext',
  '_syncUpNextSuppression', '_updateQueueUI', '_startPlayback', '_playerWindowPlayback',
  '_routeLoadedVideoToPlayerWindow', '_markCloudUploadsPending', '_resolveCloudUpload',
  '_clearCloudUploadGate', '_showScriptLoadingOverlay', '_hideScriptLoadingOverlay',
  '_initPlayerWindow', '_currentPopoutVideo', '_sendLoadVideoToPopout',
  '_streamPlayerWindowData', '_sendPlayerWindowPlaybackState', '_mirrorPopoutVolume',
  // Round 4 (2026-11-06): leaving the player, queuing, the queue panel
  '_onLeaveView', 'addToUserQueue', '_upNextMayOfferAfterEnd', '_jumpFromQueuePanel', '_getUpcoming',
  // Block D (2026-11-07): a dropped or opened file (FT-074)
  '_dragDropOptions', '_clearPlaySession', '_readFunscriptFileAgain',
];

const P = (n) => `D:\\Lib\\${n}.mp4`;
const ALPHA = P('Alpha');
const BRAVO = P('Bravo');
const CHARLIE = P('Charlie');
const DELTA = P('Delta');
const ECHO = P('Echo');
const SCRIPT = 'D:\\Lib\\Alpha.funscript';
const item = (p) => ({ name: p.split('\\').pop(), path: p, funscriptPath: null });

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
let disk;
const fakeEls = new Map();

beforeAll(() => {
  Lifted = liftAppClass(LIFTED, {
    document: {
      documentElement: { dataset: { theme: 'dark', style: 'classic' } },
      // One stand-in per id, kept per test, so a test can read what the
      // player bar was told (R4-02: the queue counter).
      getElementById: (id) => {
        if (!fakeEls.has(id)) fakeEls.set(id, { hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {} });
        return fakeEls.get(id);
      },
    },
    exitFullscreenForNav: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
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

/** The editor on Alpha's script, as the CB-01 tests build it: REAL prototype. */
function editorOn() {
  const ed = Object.create(ScriptEditor.prototype);
  ed.editableScript = new EditableScript();
  ed.editableScript.loadFromData(JSON.parse(disk[SCRIPT]));
  Object.assign(ed, {
    _funscriptPath: SCRIPT,
    _scriptSelect: { value: SCRIPT },
    _availableScripts: [{ path: SCRIPT }],
    _undoCache: new Map(),
    _loadToken: 0,
    _autosaveTimer: null,
    _autosaveEnabled: false,
    _autosaveStatusEl: null,
    _stackedView: false,
    graph: null,
    _statusEl: null,
    _reloadIntoEngineAndSync() {},
    _broadcastScriptsChanged() {},
    _broadcastActionsChanged() {},
  });
  return ed;
}

/** Unsaved edits: the next advance asks. */
function edit() {
  app.scriptEditor.editableScript.insertAction(9000, 50);
  expect(app.scriptEditor.hasUnsavedChanges()).toBe(true);
}

const dialog = () => document.querySelector('.modal-overlay');
async function answer(choice) {
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  dialog().querySelector(`[data-choice="${choice}"]`).click();
  await vi.waitFor(() => expect(dialog()).toBeNull());
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}
async function noQuestion() {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  expect(dialog()).toBeNull();
}

function buildApp(libraryPaths = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO]) {
  disk = { [SCRIPT]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] }) };
  api = {
    playerPopoutRelay: vi.fn(),
    playerPopoutReveal: vi.fn(),
    playerPopoutClose: vi.fn(),
    onPlayerPopoutEvent: () => {},
    readFunscript: vi.fn(async (p) => disk[p] ?? null),
    writeFunscript: vi.fn(async (json, p) => { disk[p] = json; return p; }),
    saveFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (ps) => ps.map(() => true)),
  };
  window.funsync = api;
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
    _queueHistory: [],
    _queueHistoryCap: 50,
    _queueHistoryThresholdMs: 5000,
    // Collaborators the lifted methods call that are not under test.
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
    getResumeEntry: () => null,
    _maybeOfferResume: async () => null,
    _updateVariantSelector() {},
    loadFunscript() {},
    _loadMultiAxisScripts() {},
    _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {},
    _refreshLoopVideoVisibility() {},
    _rereadAfterEditorAnswer: async (fs) => fs,
  });
  // The REAL Library hands every advance to the app exactly as a click does.
  target.library = new Library({
    settings: target.settings,
    onPlayVideo: (v, fs, sub, variants) => target._playFromLibrary(v, fs, sub, variants),
  });
  target.library._videos = libraryPaths.map((p) => ({ name: p.split('\\').pop(), path: p, hasFunscript: false }));
  // The editor holds Alpha's script; loadVideo's own reset of it is a stub.
  target.scriptEditor = editorOn();
  // The engine, wired as app.js wires it.
  const engine = new UpNextEngine({ videoPlayer: target.videoPlayer, funscriptEngine: target.funscriptEngine });
  engine.setSettings('auto', 10);
  engine.isPlayable = (p) => target._isUpNextPlayable(p);
  engine.resolveNext = (ctx) => target._resolveUpNext(ctx);
  engine.getPriorityNext = () => (target._userQueue.length > 0 ? target._userQueue[0] : null);
  engine.onPlayNext = (p) => { target._lastUpNextAdvanceAt = Date.now(); target._playUpNext(p); };
  target.upNextShown = [];
  engine.onShowNext = (p) => target.upNextShown.push(p);
  engine.onShowEndOfList = () => target.upNextShown.push('END OF LIST');
  target.upNextEngine = engine;
  target._initPlayerWindow();
  return target;
}

/** The video reaches its end: the card's countdown (if any) and `ended`. */
function playToEnd() {
  video.currentTime = video.duration;
  video.ended = true;
  app.upNextEngine.check();
  video.fire('ended');
  video.ended = false;
}

/** Seek back, then into the last seconds again: does the card come up? */
function cardOnNextEnd() {
  video.currentTime = 2;
  app.upNextEngine.check();
  video.currentTime = video.duration - 2;
  app.upNextEngine.check();
  return app.upNextEngine.visible;
}

beforeEach(() => {
  document.body.innerHTML = '';
  fakeEls.clear();
  app = buildApp();
});

afterEach(() => {
  app.upNextEngine.hide();
  document.querySelectorAll('.modal-overlay').forEach((d) => d.remove());
  delete window.funsync;
  vi.restoreAllMocks();
});

describe('R3-09: Cancel at Play All\'s own end-of-video advance is "not now"', () => {
  it('Up Next off: Cancel keeps Alpha; the next end asks again, and its answer moves on', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    edit();

    playToEnd();
    await answer('cancel');
    expect(app._currentVideoPath).toBe(ALPHA);
    expect(app.scriptEditor.hasUnsavedChanges()).toBe(true); // the edits are kept

    playToEnd(); // seek back, play to the end again
    await answer('discard');
    expect(app._currentVideoPath).toBe(BRAVO);
    expect(app._playQueueIndex).toBe(1);
  });

  it('Cancel twice, then Don\'t save: one advance, to the next item, never two', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    edit();
    playToEnd();
    await answer('cancel');
    playToEnd();
    await answer('cancel');
    playToEnd();
    await answer('discard');
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(BRAVO);
    await noQuestion(); // nothing left over to ask again
  });

  it('a clean editor advances at once, without a question, as before', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    playToEnd();
    expect(app._currentVideoPath).toBe(BRAVO);
    await noQuestion();
  });

  it('at the last item nothing follows: no question for nothing', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA].map(item));
    video.fire('loadeddata');
    edit();
    playToEnd();
    await noQuestion();
    expect(app._currentVideoPath).toBe(ALPHA);
  });

  it('the pop-out\'s end (no card) asks again on its next end too', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    edit();
    app._onPopoutVideoEnded();
    await answer('cancel');
    expect(app._currentVideoPath).toBe(ALPHA);
    app._onPopoutVideoEnded();
    await answer('discard');
    expect(app._currentVideoPath).toBe(BRAVO);
  });
});

describe('R3-10: Cancel at an advance into your queue keeps the queue, history and order', () => {
  const libraryContext = (list, index) => ({ source: 'library', sourceLabel: 'library', sourceContext: {}, list, index });

  async function playFromLibrary(path, ctx) {
    const v = app.library.getVideoByPath(path);
    v._playContextOverride = ctx;
    await app.library._playVideo(v);
    video.fire('loadeddata');
  }

  it('Up Next into your queue: Cancel leaves Delta queued and saved, and Alpha out of history', async () => {
    await playFromLibrary(ALPHA, libraryContext([ALPHA, BRAVO], 0));
    app._userQueue = [DELTA];
    app._settingsMap.set('player.userQueue', [DELTA]);
    edit();
    video.currentTime = 12; // watched long enough for history

    const advance = app._playUpNext(DELTA);
    await answer('cancel');
    await advance;
    expect(app._currentVideoPath).toBe(ALPHA);
    expect(app._userQueue).toEqual([DELTA]);
    expect(app._settingsMap.get('player.userQueue')).toEqual([DELTA]);
    expect(app._queueHistory).toEqual([]);

    // And when it does go: Delta comes off the queue then, Alpha into history.
    const again = app._playUpNext(DELTA);
    await answer('discard');
    await again;
    expect(app._currentVideoPath).toBe(DELTA);
    expect(app._userQueue).toEqual([]);
    expect(app._settingsMap.get('player.userQueue')).toEqual([]);
    expect(app._queueHistory).toEqual([ALPHA]);
  });

  it('Play All\'s end into your queue (Up Next off): Cancel leaves Delta queued', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    app._userQueue = [DELTA];
    edit();
    playToEnd();
    await answer('cancel');
    expect(app._currentVideoPath).toBe(ALPHA);
    expect(app._userQueue).toEqual([DELTA]);
  });

  it('a click on a queued video in the queue panel: Cancel leaves it queued and history as it was', async () => {
    await playFromLibrary(ALPHA, libraryContext([ALPHA, BRAVO], 0));
    app._userQueue = [CHARLIE, DELTA];
    edit();
    video.currentTime = 12;
    const click = app._jumpToVideoFromQueue(DELTA);
    await answer('cancel');
    await click;
    expect(app._userQueue).toEqual([CHARLIE, DELTA]);
    expect(app._queueHistory).toEqual([]);
    expect(app._currentVideoPath).toBe(ALPHA);
  });

  it('a shuffled, looping Play All at its wrap: Cancel keeps the order, and the next end names the same video', async () => {
    let s = 7;
    vi.spyOn(Math, 'random').mockImplementation(() => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; });
    app._playAll([ALPHA, BRAVO, CHARLIE, DELTA].map(item), { shuffle: true, loop: true });
    video.fire('loadeddata');
    // Walk to the last slot of the first cycle with a clean editor.
    for (let i = 0; i < 3; i++) { app._playNext(); video.fire('loadeddata'); }
    expect(app._playQueueIndex).toBe(3);
    const order = app._playQueue.map((v) => v.path);
    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    const named = app.upNextShown.at(-1);
    app.upNextEngine.hide();
    edit();

    const advance = app._playUpNext(named);
    await answer('cancel');
    await advance;
    expect(app._playQueue.map((v) => v.path)).toEqual(order); // not reshuffled under the Cancel
    video.currentTime = 2;
    app.upNextEngine.setPlayContext(app._currentPlayContext);
    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    expect(app.upNextShown.at(-1)).toBe(named); // the same draw, still to come
  });
});

describe('R3-11: only the route whose question was answered re-arms Up Next', () => {
  it('the queue\'s end, while Up Next\'s question is open, leaves Up Next spent: no card under the dialog', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    edit();
    playToEnd(); // the card fires at once at the end (Up Next asks), then `ended` (asks too)
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);

    // Seek back and to the end again with the question still open.
    expect(cardOnNextEnd()).toBe(false);

    await answer('cancel');
    expect(app._currentVideoPath).toBe(ALPHA);
    // Cancel at ITS question re-armed it: the card returns on the next end.
    expect(cardOnNextEnd()).toBe(true);
  });
});

describe('R3-15: a video from your queue during Play All, then Play All goes on', () => {
  it('Up Next: Alpha, your Delta, then Bravo (the card names Bravo at Delta\'s end)', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item), { sourceLabel: 'P' });
    video.fire('loadeddata');
    app._userQueue = [DELTA];

    await app._playUpNext(DELTA);
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(DELTA);
    expect(app._playQueue.map((v) => v.path)).toEqual([ALPHA, BRAVO, CHARLIE]);
    expect(app._userQueue).toEqual([]);

    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    expect(app.upNextShown.at(-1)).toBe(BRAVO);
    app.upNextEngine.hide();
    await app._playUpNext(BRAVO);
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(BRAVO);
    expect(app._playQueueIndex).toBe(1);
  });

  it('Up Next off: the queue\'s own end plays Delta, and Delta\'s end plays Bravo', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    app._userQueue = [DELTA];

    playToEnd();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(DELTA));
    video.fire('loadeddata');
    playToEnd();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(BRAVO));
    expect(app._playQueueIndex).toBe(1);
  });

  // R3-15 fix-up (real-app verifier 2, Up Next on, the default): at the end
  // of the item before a queued video BOTH advances ran in 5 of 6 tries. Up
  // Next's countdown took Delta off your queue and waited on its reads; the
  // queue's `ended` then found your queue empty and played Bravo; Delta
  // loaded 30 ms later as the interlude, with the Play All already on Bravo's
  // slot, so N skipped Bravo. Every load is counted here.
  function trackLoads() {
    const loads = [];
    const real = app.loadVideo;
    app.loadVideo = function (file, opts) { loads.push(file.path); return real.call(this, file, opts); };
    return loads;
  }
  async function endWithCardUp({ countdownFirst }) {
    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    expect(app.upNextEngine.visible).toBe(true);
    const ended = () => { video.currentTime = video.duration; video.ended = true; video.fire('ended'); video.ended = false; };
    if (countdownFirst) { app.upNextEngine.playNext(); ended(); } else { ended(); app.upNextEngine.playNext(); }
  }

  it('Up Next on: the countdown plays your Delta ONCE, Play All\'s own end at the same moment adds nothing', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    app._userQueue = [DELTA];
    const loads = trackLoads();
    await endWithCardUp({ countdownFirst: true });
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(DELTA));
    await noQuestion();
    video.fire('loadeddata');
    expect(loads).toEqual([DELTA]);
    expect(app._playQueueIndex).toBe(0); // the Play All is still on Alpha's slot
    // Delta's end: the card names Bravo and its countdown plays it, never
    // skipping it. (Its load is synchronous; a browser drops the `ended` still
    // queued for the old file when the new one loads, so none is fired here.)
    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    expect(app.upNextShown.at(-1)).toBe(BRAVO);
    app.upNextEngine.playNext();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(BRAVO));
    await noQuestion();
    expect(loads).toEqual([DELTA, BRAVO]);
    expect(app._playQueueIndex).toBe(1);
  });

  it('…and the other way round: Play All\'s end plays your Delta, the countdown a beat later adds nothing', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    app._userQueue = [DELTA];
    const loads = trackLoads();
    await endWithCardUp({ countdownFirst: false });
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(DELTA));
    await noQuestion();
    expect(loads).toEqual([DELTA]);
    expect(app._playQueueIndex).toBe(0);
  });

  it('a queued video that is gone: its toast, then Play All\'s end still goes on to Bravo', async () => {
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    const GONE = P('Gone'); // not in the library, and no playlist route to play the file
    app._userQueue = [GONE];
    const loads = trackLoads();
    await endWithCardUp({ countdownFirst: true });
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(BRAVO));
    await noQuestion();
    expect(loads).toEqual([BRAVO]);
    expect(app._userQueue).toEqual([]);
  });

  it('two queued videos in a row, then the Play All\'s next item', async () => {
    app.upNextEngine.setSettings('off');
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    app._userQueue = [DELTA, ECHO];
    playToEnd();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(DELTA));
    video.fire('loadeddata');
    playToEnd();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(ECHO));
    video.fire('loadeddata');
    playToEnd();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(BRAVO));
  });

  it('the queued video is not the playlist\'s: no resume or Last watched against it; P goes back to Alpha', async () => {
    app._playAll([ALPHA, BRAVO].map(item), { sourceContext: { kind: 'playlist', id: 'p1' } });
    video.fire('loadeddata');
    expect(app._isPlaylistContext(app._currentPlayContext)).toBe(true);
    app._userQueue = [DELTA];
    await app._playUpNext(DELTA);
    video.fire('loadeddata');
    expect(app._isPlaylistContext(app._currentPlayContext)).toBe(false);
    app._playPrev();
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(ALPHA);
  });

  it('a library click afterwards still ends the Play All, as any open does', async () => {
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    await app.library._playVideo(app.library.getVideoByPath(DELTA));
    expect(app._playQueue).toEqual([]);
  });
});

// --- Round 4 (2026-11-06) ----------------------------------------------------
//
//   R4-01  After a video reached an "End of list" card, Back, then "Add to
//          queue" on any library card switched to the player and loaded that
//          video (new since v0.9.2: FT-018 made a queue change refresh the
//          card, and the left-over card fired at once at the old video's end).
//   R4-02  A click on an UPCOMING Play All item in the queue panel ended the
//          Play All (it loaded as a library click); and during a video from
//          your queue in the middle of Play All the counter showed the item
//          before it ("1 / 3").
//   R4-03  The panel's "Up next" did not read what the card decides: at a
//          shuffled looping wrap it had no "Up next" while the card named the
//          next video; it listed a removed source's slot first.

/** Every video load, by path. */
function countLoads() {
  const loads = [];
  const real = app.loadVideo;
  app.loadVideo = function (file, opts) { loads.push(file.path); return real.call(this, file, opts); };
  return loads;
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('R4-01: Add to queue after an End-of-list card and Back loads nothing', () => {
  let view;
  let navigations;
  beforeEach(() => {
    view = 'player';
    navigations = [];
    app._currentView = () => view;
    app._navigateTo = (v) => { navigations.push(v); view = v; };
    app._isOurVideoInPip = () => false;
    app._shouldEnterMiniplayer = () => false;
    app._enterMiniplayer = () => { app._miniActive = true; };
    app._teardownPlayback = () => video.pause();
    app.upNextEngine.canOfferAfterEnd = () => app._upNextMayOfferAfterEnd();
  });
  /** The last video plays to its end under End of list, and stays ended. */
  function endsAtEndOfList() {
    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    expect(app.upNextShown.at(-1)).toBe('END OF LIST');
    playToEnd();
    video.ended = true;
  }
  function back() { view = 'library'; app._onLeaveView('player'); }
  async function playLastOfLibraryList(path, list) {
    const v = app.library.getVideoByPath(path);
    v._playContextOverride = { source: 'library', sourceLabel: 'library', sourceContext: {}, list, index: list.indexOf(path) };
    await app.library._playVideo(v);
    video.fire('loadeddata');
  }

  it('Play All on three videos: the last ends, Back, Add to queue on a library card', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    app._playNext(); video.fire('loadeddata');
    app._playNext(); video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(CHARLIE);
    endsAtEndOfList();
    back();
    navigations.length = 0;
    const loads = countLoads();
    app.addToUserQueue(DELTA);
    await tick();
    expect(navigations).toEqual([]); // the view stays on the library
    expect(loads).toEqual([]); // nothing loads
    expect(app._currentVideoPath).toBe(CHARLIE);
    expect(app._userQueue).toEqual([DELTA]);
    expect(app.upNextEngine.visible).toBe(false);
  });

  it('no playlist: the last video of the library list ends, Back, Add to queue', async () => {
    await playLastOfLibraryList(ECHO, [ALPHA, BRAVO, CHARLIE, DELTA, ECHO]);
    endsAtEndOfList();
    back();
    navigations.length = 0;
    const loads = countLoads();
    app.addToUserQueue(ALPHA);
    await tick();
    expect(navigations).toEqual([]);
    expect(loads).toEqual([]);
    expect(app._currentVideoPath).toBe(ECHO);
  });

  it('the mini player: the video ends in the corner under End of list; queuing loads nothing', async () => {
    await playLastOfLibraryList(ECHO, [DELTA, ECHO]);
    video.play();
    app._shouldEnterMiniplayer = () => true;
    video.currentTime = 4;
    back(); // docks in the corner, still playing
    expect(app._miniActive).toBe(true);
    endsAtEndOfList(); // its End of list comes up in the corner, then it ends
    navigations.length = 0;
    const loads = countLoads();
    app.addToUserQueue(ALPHA);
    await tick();
    expect(navigations).toEqual([]);
    expect(loads).toEqual([]);
  });

  it('Back while End of list shows in the last seconds (into the mini player): the card goes with the view', async () => {
    await playLastOfLibraryList(ECHO, [DELTA, ECHO]);
    video.play();
    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    expect(app.upNextShown.at(-1)).toBe('END OF LIST');
    app._shouldEnterMiniplayer = () => true;
    back();
    expect(app.upNextEngine.visible).toBe(false);
    const loads = countLoads();
    app.addToUserQueue(ALPHA);
    app.upNextEngine.check();
    await tick();
    expect(loads).toEqual([]);
    expect(app.upNextEngine.visible).toBe(false);
  });

  it('still in the player view: a fresh card with the FULL countdown, nothing loads at once, and × cancels it', async () => {
    await playLastOfLibraryList(ECHO, [DELTA, ECHO]);
    endsAtEndOfList();
    const shown = [];
    app.upNextEngine.onShowNext = (p, sec) => shown.push([p, sec]);
    navigations.length = 0;
    const loads = countLoads();
    app._userQueue.push(ALPHA);
    app._persistUserQueue(); // a queue change with the player view on screen
    await tick();
    expect(loads).toEqual([]);
    expect(shown).toEqual([[ALPHA, 10]]);
    app.upNextEngine.dismiss();
    await tick();
    expect(loads).toEqual([]);
    expect(navigations).toEqual([]);
  });

  // R4-01 fix-up (real-app verifier 1): that fresh card was kept on Back (only
  // End of list was dismissed), counted down behind the Playlists view, then
  // switched back to the player and loaded its video.
  it.each([
    ['torn down (no mini player)', false],
    ['into the mini player', true],
  ])('a fresh after-end card in the player view, then Back within its countdown (%s): nothing loads, the view stays', async (_label, mini) => {
    vi.useFakeTimers();
    try {
      await playLastOfLibraryList(ECHO, [DELTA, ECHO]);
      endsAtEndOfList();
      app._userQueue.push(ALPHA);
      app._persistUserQueue(); // the card for Alpha, full countdown
      expect(app.upNextEngine.visible).toBe(true);
      expect(app.upNextEngine.endOfListShown).toBe(false);
      app._shouldEnterMiniplayer = () => mini;
      vi.advanceTimersByTime(400);
      navigations.length = 0;
      const loads = countLoads();
      back();
      vi.advanceTimersByTime(30 * 1000);
      app.upNextEngine.check();
      vi.advanceTimersByTime(30 * 1000);
      await vi.runAllTimersAsync();
      expect(loads).toEqual([]);
      expect(navigations).toEqual([]);
      expect(app._currentVideoPath).toBe(ECHO);
      expect(app._userQueue).toEqual([ALPHA]); // still queued, for later
      expect(app.upNextEngine.visible).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('R4-02: a click on an upcoming Play All item jumps inside the Play All', () => {
  it('Alpha playing, a click on Charlie: it plays as the Play All\'s third item, and the Play All goes on to Delta', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE, DELTA].map(item));
    video.fire('loadeddata');
    expect(app._getUpcoming().items).toEqual([BRAVO, CHARLIE, DELTA]);
    await app._jumpFromQueuePanel(CHARLIE, { kind: 'upcoming', idx: 1 });
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(CHARLIE);
    expect(app._playQueue.map((v) => v.path)).toEqual([ALPHA, BRAVO, CHARLIE, DELTA]);
    expect(app._playQueueIndex).toBe(2);
    expect(app._currentPlayContext.source).toBe('queue');
    app.upNextEngine.setSettings('off');
    playToEnd();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(DELTA));
    expect(app._playQueueIndex).toBe(3);
  });

  it('through the REAL queue panel: a click on the Up next row keeps the Play All', async () => {
    const { QueuePanel } = await import('../../renderer/components/queue-panel.js');
    const el = document.createElement('aside');
    document.body.appendChild(el);
    const panel = new QueuePanel({ element: el, library: app.library, onJump: (p, where) => app._jumpFromQueuePanel(p, where) });
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    panel.setState({ history: [], nowPlaying: ALPHA, userQueue: [], upcoming: app._getUpcoming().items, hasContext: true });
    panel.open();
    [...el.querySelectorAll('.queue-panel__row--upcoming')].find((row) => row.dataset.queuePath === CHARLIE).click();
    await vi.waitFor(() => expect(app._currentVideoPath).toBe(CHARLIE));
    expect(app._playQueue.map((v) => v.path)).toEqual([ALPHA, BRAVO, CHARLIE]);
    expect(app._playQueueIndex).toBe(2);
  });

  it('a row of your own queue keeps its behaviour: an interlude, and the Play All goes on after it', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    app._userQueue = [DELTA];
    await app._jumpFromQueuePanel(DELTA, { kind: 'user-queue', idx: 0 });
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(DELTA);
    expect(app._currentPlayContext.interlude).toBe(true);
    expect(app._playQueue.map((v) => v.path)).toEqual([ALPHA, BRAVO, CHARLIE]);
    expect(app._userQueue).toEqual([]);
  });

  it('Cancel at the unsaved-changes question: nothing moves', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    edit();
    const jump = app._jumpFromQueuePanel(CHARLIE, { kind: 'upcoming', idx: 1 });
    await answer('cancel');
    await jump;
    expect(app._currentVideoPath).toBe(ALPHA);
    expect(app._playQueueIndex).toBe(0);
  });

  it('the counter is hidden while your queued video plays in the middle of Play All, and back after it', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    const counter = fakeEls.get('queue-indicator');
    expect(counter.textContent).toBe('1 / 3');
    expect(counter.hidden).toBe(false);
    app._userQueue = [DELTA];
    await app._playUpNext(DELTA);
    video.fire('loadeddata');
    expect(app._currentPlayContext.interlude).toBe(true);
    expect(counter.hidden).toBe(true); // it said "1 / 3" under Delta
    expect(fakeEls.get('btn-prev').disabled).toBe(false); // P goes back to Alpha
    app.upNextEngine.hide();
    await app._playUpNext(BRAVO);
    video.fire('loadeddata');
    expect(counter.hidden).toBe(false);
    expect(counter.textContent).toBe('2 / 3');
  });
});

// C-07 (new since v0.9.2, by reading, the round-4 review's R4-02 nit): a click
// on a WRAP row (the next cycle of a shuffled, looping Play All) reshuffled
// the queue and played `_playQueue[step.queueIndex]` without checking that
// the slot still held the clicked video. The ordinary row checks. If the
// queue or its position moved while the unsaved-changes question was open,
// the card's memo no longer matched, a fresh order was drawn, and another
// video than the clicked one played.
describe('C-07: a wrap row of the queue panel plays the video it shows', () => {
  /** A shuffled, looping Play All at its last item, so Up next lists the next cycle. */
  function atTheWrap() {
    app._playAll([ALPHA, BRAVO, CHARLIE, DELTA].map(item), { shuffle: true, loop: true });
    video.fire('loadeddata');
    for (let i = 0; i < 3; i++) { app._playNext(); video.fire('loadeddata'); }
    expect(app._playQueueIndex).toBe(3);
    const upcoming = app._getUpcoming().items;
    expect(app._upcomingSteps[1]?.wrap).toBe(true);
    return upcoming;
  }

  it('the queue moved during the unsaved question: Don\'t save plays the CLICKED video, not what now sits in its slot', async () => {
    const upcoming = atTheWrap();
    const clicked = upcoming[1];
    edit();
    const jump = app._jumpFromQueuePanel(clicked, { kind: 'upcoming', idx: 1 });
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    // While the question is open the queue changes under the click: the
    // clicked video is no longer in it, so no draw can put it in its slot.
    app._playQueue = app._playQueue.filter((v) => v.path !== clicked);
    await answer('discard');
    await jump;
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(clicked);
  });

  it('nothing moved: the click plays the clicked video in the next cycle\'s order the panel showed', async () => {
    const upcoming = atTheWrap();
    const clicked = upcoming[1];
    edit();
    const jump = app._jumpFromQueuePanel(clicked, { kind: 'upcoming', idx: 1 });
    await answer('discard');
    await jump;
    video.fire('loadeddata');
    expect(app._currentVideoPath).toBe(clicked);
    expect(app._playQueue.map((v) => v.path)).toEqual(upcoming.slice(0, 4));
  });
});

describe('R4-03: the queue panel\'s Up next starts with what the Up Next card names', () => {
  function cardNames() {
    video.currentTime = video.duration - 2;
    app.upNextEngine.check();
    const named = app.upNextShown.at(-1);
    app.upNextEngine.hide();
    return named;
  }
  function seededRandom() {
    let s = 11;
    vi.spyOn(Math, 'random').mockImplementation(() => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; });
  }

  it('a shuffled, looping Play All at its last item: the next cycle\'s first, in both', () => {
    seededRandom();
    app._playAll([ALPHA, BRAVO, CHARLIE, DELTA].map(item), { shuffle: true, loop: true });
    video.fire('loadeddata');
    for (let i = 0; i < 3; i++) { app._playNext(); video.fire('loadeddata'); }
    expect(app._playQueueIndex).toBe(3);
    const upcoming = app._getUpcoming().items;
    expect(upcoming.length).toBeGreaterThan(0);
    expect(upcoming[0]).toBe(cardNames());
  });

  it('a shuffled, looping playlist context (a card click with Shuffle on) at its wrap: same', async () => {
    seededRandom();
    const list = [ALPHA, BRAVO, CHARLIE, DELTA];
    const v = app.library.getVideoByPath(DELTA);
    v._playContextOverride = {
      source: 'playlist', sourceLabel: 'P', sourceContext: { kind: 'playlist', id: 'p1' },
      list, index: 3, loop: true, shuffle: true, shuffleBalance: false,
      shufflePool: list.map((p) => ({ path: p, funscriptPath: null })),
    };
    await app.library._playVideo(v);
    video.fire('loadeddata');
    const upcoming = app._getUpcoming().items;
    expect(upcoming.length).toBeGreaterThan(0); // the panel had no "Up next" here
    expect(upcoming[0]).toBe(cardNames());
  });

  it('a Play All slot whose source was removed is skipped by both', () => {
    const BULK = 'E:\\Bulk\\Bulk 003.mp4';
    app.library._videos.push({ name: 'Bulk 003.mp4', path: BULK, hasFunscript: false });
    app._settingsMap.set('library.sources', [{ path: 'D:\\Lib', enabled: true }]); // E:\Bulk removed
    app._playAll([ALPHA, BULK, CHARLIE].map(item));
    video.fire('loadeddata');
    expect(app._getUpcoming().items).toEqual([CHARLIE]);
    expect(cardNames()).toBe(CHARLIE);
  });

  it('a library list: the list the card walks, not the library view re-sorted since', async () => {
    const v = app.library.getVideoByPath(BRAVO);
    v._playContextOverride = { source: 'library', sourceLabel: 'library', sourceContext: {}, list: [ALPHA, BRAVO, CHARLIE, DELTA], index: 1 };
    await app.library._playVideo(v);
    video.fire('loadeddata');
    app.library._filteredVideos = [DELTA, CHARLIE, BRAVO, ALPHA].map((p) => app.library.getVideoByPath(p)); // Z-A since
    expect(app._getUpcoming().items).toEqual([CHARLIE, DELTA]);
    expect(cardNames()).toBe(CHARLIE);
  });
});

// FT-075 (also in v0.9.2): the queue panel showed an empty "Up next" for a
// playlist or category card's play. v0.9.2's `_getUpcoming` read only the
// Play All queue and a 'library' context; R4-03 rewrote it to walk any
// context's list (the shuffled-wrap case is above). These pin the plain
// middle-of-the-list case for both card kinds. A loop shows its wrap only
// once nothing later is left, as the card and the advances do (R4-03), so
// at index 1 of four it is the rest of the list, loop or not.
describe('FT-075: a playlist or category card\'s play lists the rest of its list', () => {
  for (const kind of ['playlist', 'category']) {
    for (const loop of [false, true]) {
      it(`${kind}${loop ? ', looping' : ''}: at Bravo of [Alpha, Bravo, Charlie, Delta] -> [Charlie, Delta]`, async () => {
        const v = app.library.getVideoByPath(BRAVO);
        v._playContextOverride = {
          source: kind, sourceLabel: kind, sourceContext: { kind, id: 'x1' },
          list: [ALPHA, BRAVO, CHARLIE, DELTA], index: 1, loop,
        };
        await app.library._playVideo(v);
        video.fire('loadeddata');
        const upcoming = app._getUpcoming();
        expect(upcoming.hasContext).toBe(true);
        expect(upcoming.items).toEqual([CHARLIE, DELTA]);
      });
    }
    it(`${kind}, looping, at its last entry: the next cycle, from the top`, async () => {
      const v = app.library.getVideoByPath(DELTA);
      v._playContextOverride = {
        source: kind, sourceLabel: kind, sourceContext: { kind, id: 'x1' },
        list: [ALPHA, BRAVO, CHARLIE, DELTA], index: 3, loop: true,
      };
      await app.library._playVideo(v);
      video.fire('loadeddata');
      // The whole next cycle, Delta again at its end, as the loop plays it.
      expect(app._getUpcoming().items).toEqual([ALPHA, BRAVO, CHARLIE, DELTA]);
    });
  }
});

// FT-074 (also in v0.9.2): a file dropped on the window, or opened with O /
// Browse, kept the last list. onVideoFile calls loadVideo, which never
// cleared the play context or the Play All queue (only _playFromLibrary
// did), so Up Next offered the old list's next video at the dropped file's
// end, prev / next stepped through it and the queue panel listed it. Driven
// through app.js's REAL DragDrop options (`_dragDropOptions().onVideoFile`).
describe('FT-074: a dropped or opened file plays on its own', () => {
  const ZULU = 'C:\Downloads\Zulu Last.mp4';
  const dropped = () => ({ name: 'Zulu Last.mp4', path: ZULU, _isPathBased: true });

  it('after a library play: no context, no Up next, no card at its end, nothing advances', async () => {
    const v = app.library.getVideoByPath(BRAVO);
    v._playContextOverride = {
      source: 'library', sourceLabel: 'library', sourceContext: {}, list: [ALPHA, BRAVO, CHARLIE, DELTA], index: 1,
    };
    await app.library._playVideo(v);
    video.fire('loadeddata');
    expect(app._getUpcoming().items).toEqual([CHARLIE, DELTA]);

    await app._dragDropOptions().onVideoFile(dropped());
    video.fire('loadeddata');

    expect(app._currentVideoPath).toBe(ZULU);
    expect(app._currentPlayContext).toBeNull();
    expect(app._getUpcoming()).toEqual({ items: [], hasContext: false });
    app.upNextShown.length = 0;
    playToEnd();
    await noQuestion();
    expect(app.upNextShown).toEqual([]);
    expect(app._currentVideoPath).toBe(ZULU);
  });

  it('after Play All: the queue is gone, prev / next are hidden, nothing advances at the end', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item), { shuffle: false, loop: true });
    video.fire('loadeddata');
    expect(app._playQueue).toHaveLength(3);
    expect(fakeEls.get('btn-next').hidden).toBe(false);

    await app._dragDropOptions().onVideoFile(dropped());
    video.fire('loadeddata');

    expect(app._playQueue).toEqual([]);
    expect(app._playQueueIndex).toBe(-1);
    expect(app._playQueueLoop).toBe(false);
    expect(fakeEls.get('btn-prev').hidden).toBe(true);
    expect(fakeEls.get('btn-next').hidden).toBe(true);
    expect(app._getUpcoming().hasContext).toBe(false);
    app.upNextShown.length = 0;
    playToEnd();
    await noQuestion();
    expect(app.upNextShown).toEqual([]);
    expect(app._currentVideoPath).toBe(ZULU);
  });

  it('your own queue stays (it is yours, not the list\'s)', async () => {
    app._playAll([ALPHA, BRAVO].map(item));
    video.fire('loadeddata');
    app.addToUserQueue(DELTA);

    await app._dragDropOptions().onVideoFile(dropped());
    video.fire('loadeddata');

    expect(app._userQueue.map((e) => e?.path || e)).toEqual([DELTA]);
    expect(app._playQueue).toEqual([]);
  });

  it('Cancel at the unsaved-edits question changes nothing: the Play All goes on', async () => {
    app._playAll([ALPHA, BRAVO, CHARLIE].map(item));
    video.fire('loadeddata');
    edit();

    const drop = app._dragDropOptions().onVideoFile(dropped());
    await answer('cancel');
    await drop;

    expect(app._currentVideoPath).toBe(ALPHA);
    expect(app._playQueue).toHaveLength(3);
    expect(app._getUpcoming().items).toEqual([BRAVO, CHARLIE]);
  });
});
