/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL KeyboardHandler listens on `document`, and it
 * imports i18n.js, which branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// The detached player window owns playback: its <video> is the only one that
// plays. The main window keeps an inline <video> with the same file loaded,
// paused and hidden. App test 2026-11-02 found every way that broke:
//
//   V13  Space / arrows / M in the main window, the global play/pause hotkey,
//        and every Play All item acted on the HIDDEN inline <video>: a second
//        invisible copy played while the pop-out and the device carried on,
//        and its loop flag (off) cancelled the pop-out's loop, so a looping
//        video auto-advanced at its end.
//   V14  (main-renderer half) a crashed pop-out folds back with no word.
//   V15  a library click autoplayed in the pop-out, ignoring
//        player.autoplayOnOpen=false; the cloud-upload gate only ever played
//        the inline <video>.
//   V16  a minimised or buried pop-out was not brought up for a new video.
//   V17  a fresh pop-out started at full volume, loop off, and with no
//        prev/next or "2 / 4" until the first navigation.
//
// The REAL app.js methods are lifted into a class (helpers/app-methods.js)
// and run against a fake inline <video> (a real EventTarget), the real
// RemotePlaybackProxy, the real UpNextEngine and the real KeyboardHandler.
// Assertions are on what the user and devices would see: the messages the
// pop-out receives, and whether the hidden inline <video> ever plays.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { pathToFileURL } from '../../renderer/js/path-utils.js';
import { PLAYBACK_RATE_PRESETS } from '../../renderer/js/video-player.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const LIFTED = [
  '_initPlayerWindow', '_onPlayerWindowMessage', '_onPopoutVideoEnded',
  '_playerWindowPlayback', '_startPlayback', '_mirrorPopoutVolume', '_sendPlayerWindowPlaybackState',
  '_currentPopoutVideo', '_sendPlayerWindowInitialState', '_inlineTimelineView', '_sendLoadVideoToPopout',
  '_routeLoadedVideoToPlayerWindow', '_streamPlayerWindowData', '_activatePlayerWindow',
  '_deactivatePlayerWindow', '_syncUpNextSuppression', '_setUpNextContext', '_updateQueueUI',
  '_playQueueItem', '_advanceQueueOnEnded', '_playFromLibrary', '_withShuffledStart', '_onGlobalShortcut',
  '_armQueueEndedListener', // R3-09
  '_nextQueueStep', '_queueWrapOrder', '_isUpNextPlayable', '_isUnderEnabledSource', // CB-10
  '_editorAllowsReplace', // CB-01's unsaved-edits question (no editor here: no question)
  '_loadPlayContent', '_loadQueueItemContent',
  '_keyboardOptions', '_dragDropOptions', '_clearPlaySession', // FT-074: a dropped file ends the list
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek',
  '_markCloudUploadsPending', '_resolveCloudUpload', '_clearCloudUploadGate',
  '_showScriptLoadingOverlay', '_hideScriptLoadingOverlay',
];

const ALPHA = 'D:\\Lib\\Alpha.mp4';
const BRAVO = 'D:\\Lib\\Bravo.mp4';
const CHARLIE = 'D:\\Lib\\Charlie.mp4';
const DELTA = 'D:\\Lib\\Delta.mp4';
// app.js's shouldOfferResume: no resume unless a test says so.
let offerResume = () => false;
const item = (path) => ({ name: path.split('\\').pop(), path, _isPathBased: true });

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
    // As in Chromium, currentSrc follows a new src only once the element
    // has loaded it: right after a swap it still names the PREVIOUS file.
    if (type === 'loadeddata') this.currentSrc = this.src;
    this.dispatchEvent(new Event(type));
  }
}

let relayed;
let toasts;
let warns;
let api;
let popoutEvent;
let video;
let app;
let Lifted;

/** Messages of one type the pop-out has received, oldest first. */
const sent = (type) => relayed.filter((m) => m.type === type);
const last = (type) => sent(type).at(-1);

beforeAll(() => {
  const fakeDocument = {
    documentElement: { dataset: { theme: 'dark', style: 'classic' } },
    getElementById: () => ({ hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {} }),
  };
  Lifted = liftAppClass(LIFTED, {
    window: { get funsync() { return api; } },
    document: fakeDocument,
    console: { log: () => {}, warn: (...a) => warns.push(a), error: () => {} },
    URL,
    pathToFileURL,
    maybeShowHevcGuidance: () => {},
    isAutoMatch: () => false,
    showToast: (message, type) => { toasts.push({ key: String(message), type }); },
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    PLAYERWIN,
    RemotePlaybackProxy,
    PLAYBACK_RATE_PRESETS,
    INLINE_VIZ_OPACITY_DEFAULT: 80,
    shouldOfferResume: (...a) => offerResume(...a),
    formatResumeTime: () => '',
    requestAnimationFrame: (fn) => fn(),
  });
});

function buildApp() {
  relayed = [];
  toasts = [];
  warns = [];
  popoutEvent = null;
  api = {
    playerPopoutRelay: vi.fn((direction, payload) => { if (direction === 'to-popout') relayed.push(payload); }),
    playerPopoutReveal: vi.fn(),
    playerPopoutClose: vi.fn(),
    onPlayerPopoutEvent: (cb) => { popoutEvent = cb; },
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
      isVRProjecting: false,
      togglePlay: vi.fn(() => (video.paused ? video.play() : video.pause())),
      skip: vi.fn((s) => { video.currentTime += s; }),
      seek: vi.fn((s) => { video.currentTime = s; }),
      setVolume: vi.fn((v) => { video.volume = Math.max(0, Math.min(1, v)); }),
      toggleMute: vi.fn(() => { video.muted = !video.muted; }),
      cyclePlaybackRate: vi.fn(),
      loadSource: vi.fn((url) => { video.src = url; }), // currentSrc lags: see FakeVideo.fire
      clearSubtitles: vi.fn(),
    },
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {} },
    funscriptEngine: { clear() {}, isLoaded: false },
    settings: {
      get: (k) => settingsMap.get(k),
      set: (k, v) => settingsMap.set(k, v),
      addRecentFile() {},
    },
    _settingsMap: settingsMap,
    library: { getVideoByPath: () => null },
    _pendingUploads: new Set(),
    _waitingForScript: false,
    _pendingFunscripts: [],
    _playQueue: [],
    _playQueueIndex: -1,
    _userQueue: [],
    // Collaborators the lifted methods call that are not under test.
    _maybePushCurrentToHistory() {},
    _ensureVideoLoadWatch() {},
    _stopGapSkip() {},
    _feedInlineViz() {},
    _navigateTo: vi.fn(),
    _currentView: () => 'library',
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
    _onOrgasmHold() {},
    _onEdgeHold() {},
  });
  target.upNextEngine = new UpNextEngine({ videoPlayer: target.videoPlayer, funscriptEngine: target.funscriptEngine });
  target.upNextEngine.setSettings('auto', 10);
  target.upNextShown = [];
  target.upNextAdvanced = [];
  target.upNextEngine.onShowNext = (p) => target.upNextShown.push(p);
  target.upNextEngine.onPlayNext = (p) => target.upNextAdvanced.push(p);
  target._initPlayerWindow();
  return target;
}

/** The pop-out window opens and takes over the video loaded inline. */
function popOut({ at = 4, playing = true } = {}) {
  popoutEvent({ type: 'opened' });
  popoutEvent({ type: 'message', payload: PLAYERWIN.makeMessage(PLAYERWIN.READY) });
  popoutEvent({
    type: 'message',
    payload: PLAYERWIN.makeMessage(PLAYERWIN.VIDEO_META, { durationMs: video.duration * 1000 }),
  });
  popoutTick({ at, paused: !playing });
}

/** A TIME_TICK from the pop-out's own <video>. */
function popoutTick({ at, paused = false, loop = false, rate = 1 }) {
  popoutEvent({
    type: 'message',
    payload: PLAYERWIN.makeMessage(PLAYERWIN.TIME_TICK, { timeMs: at * 1000, paused, rate, loop }),
  });
}

function popoutVideoEvent(event, fields = {}) {
  popoutEvent({ type: 'message', payload: PLAYERWIN.makeMessage(PLAYERWIN.VIDEO_EVENT, { event, ...fields }) });
}

// The REAL KeyboardHandler, built for each test from app.js's REAL options
// (_keyboardOptions), so dropping a pop-out route from that wiring fails
// here. It would bind to `document` for good, so it binds nothing and one
// pair of listeners forwards to the current test's handler instead.
class TestKeyboardHandler extends KeyboardHandler { _bindEvents() {} }
let keys = null;
document.addEventListener('keydown', (e) => keys?._onKeyDown(e));
document.addEventListener('keyup', (e) => keys?._onKeyUp(e));
function press(key, opts = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}

beforeEach(() => {
  app = buildApp();
  keys = new TestKeyboardHandler(app._keyboardOptions());
  // Alpha is open in the main window, paused, when the user pops it out.
  app.loadVideo(item(ALPHA), { autoPlay: false, skipViewSwitch: true });
  video.fire('loadeddata');
  app._currentPlayContext = null;
});

afterEach(() => {
  app.upNextEngine.hide();
});

describe('V13: the main window\'s playback keys drive the pop-out, never the hidden inline <video>', () => {
  it('Space / K pause and play the pop-out', () => {
    popOut({ at: 4, playing: true });
    press(' ');
    expect(last(PLAYERWIN.SET_PLAY_STATE)).toEqual({ type: 'set-play-state', paused: true });

    popoutVideoEvent('pause', { timeMs: 4000 }); // the pop-out paused
    press('k');
    expect(last(PLAYERWIN.SET_PLAY_STATE)).toEqual({ type: 'set-play-state', paused: false });

    expect(video.play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
  });

  it('arrows, J / L, Home and End seek the pop-out from ITS clock', () => {
    popOut({ at: 4, playing: false });
    press('ArrowRight');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(9000);
    popoutVideoEvent('seeked', { timeMs: 9000 }); // the pop-out got there
    press('j');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(0); // 9 - 10, clamped
    popoutVideoEvent('seeked', { timeMs: 0 });
    press('l');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(10000);
    popoutVideoEvent('seeked', { timeMs: 10000 });
    press('l');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(13000); // clamped to the 13 s clip
    press('Home');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(0);
    press('End');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(12950);
    // The hidden copy did not move.
    expect(video.currentTime).toBe(0);
    expect(app.videoPlayer.skip).not.toHaveBeenCalled();
  });

  it('arrows pressed faster than the pop-out seeks each step on from the last one (a held key)', () => {
    popOut({ at: 1, playing: false });
    press('ArrowRight');
    press('ArrowRight');
    expect(sent(PLAYERWIN.SEEK).map((m) => m.timeMs)).toEqual([6000, 11000]);
    // The first seek lands late: the keys are already headed for 11 s.
    popoutVideoEvent('seeked', { timeMs: 6000 });
    press('ArrowLeft');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(6000); // 11 - 5
    // Once it reports the last target, its own clock is the reference again.
    popoutVideoEvent('seeked', { timeMs: 6000 });
    popoutTick({ at: 7, paused: true });
    press('ArrowRight');
    expect(last(PLAYERWIN.SEEK).timeMs).toBe(12000);
  });

  it('M and the volume keys set the pop-out\'s volume and mute', () => {
    popOut();
    press('ArrowUp');
    expect(last(PLAYERWIN.SET_VOLUME)).toMatchObject({ muted: false });
    expect(last(PLAYERWIN.SET_VOLUME).volume).toBeCloseTo(0.85);
    press('m');
    expect(last(PLAYERWIN.SET_VOLUME)).toMatchObject({ muted: true });
    expect(last(PLAYERWIN.SET_VOLUME).volume).toBeCloseTo(0.85);
    press('ArrowDown');
    expect(last(PLAYERWIN.SET_VOLUME).volume).toBeCloseTo(0.8);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('a volume changed in the pop-out is what the next key steps from (and what is saved)', () => {
    popOut();
    popoutVideoEvent('volumechange', { volume: 0.3, muted: false }); // its own slider
    press('ArrowUp');
    expect(last(PLAYERWIN.SET_VOLUME).volume).toBeCloseTo(0.35);
  });

  it('< and > change the pop-out\'s speed, not the hidden player\'s', () => {
    popOut();
    press('>');
    expect(last(PLAYERWIN.SET_RATE)).toEqual({ type: 'set-rate', rate: 1.25 });
    press('<');
    expect(last(PLAYERWIN.SET_RATE)).toEqual({ type: 'set-rate', rate: 1 });
    expect(app.videoPlayer.cyclePlaybackRate).not.toHaveBeenCalled();
  });

  it('> twice on a paused pop-out goes 1.25 then 1.5 (no tick arrives while paused)', () => {
    popOut({ playing: false });
    press('>');
    press('>');
    expect(sent(PLAYERWIN.SET_RATE).map((m) => m.rate)).toEqual([1.25, 1.5]);
    press('<');
    press('<');
    press('<');
    expect(sent(PLAYERWIN.SET_RATE).map((m) => m.rate)).toEqual([1.25, 1.5, 1.25, 1, 0.75]);
  });

  it('a speed picked in the pop-out\'s own menu is what the next key steps from', () => {
    popOut({ playing: false });
    popoutTick({ at: 4, paused: true, rate: 1.75 }); // its ratechange report
    press('>');
    expect(last(PLAYERWIN.SET_RATE).rate).toBe(2);
  });

  it('the global play/pause hotkey pauses the pop-out (the device follows it), not a hidden copy', () => {
    popOut({ at: 4, playing: true });
    app._onGlobalShortcut('playPause');
    expect(last(PLAYERWIN.SET_PLAY_STATE)).toEqual({ type: 'set-play-state', paused: true });
    expect(video.play).not.toHaveBeenCalled();
  });

  // CB-05: this used to press Space on the Library (this harness's view)
  // with no pop-out and no mini player, and expect the hidden inline video to
  // play: the bug (audio from a player nobody can see). Docked means the
  // player view; on the Library the keys now do nothing.
  it('docked (no pop-out), the same keys and hotkey still drive the inline player', () => {
    app._currentView = () => 'player';
    press(' ');
    expect(video.play).toHaveBeenCalledTimes(1);
    app._onGlobalShortcut('playPause');
    expect(video.paused).toBe(true);
    expect(sent(PLAYERWIN.SET_PLAY_STATE)).toEqual([]);
  });

  it('no pop-out, no mini player, on the Library: Space plays nothing (CB-05)', () => {
    press(' ');
    expect(video.play).not.toHaveBeenCalled();
    expect(sent(PLAYERWIN.SET_PLAY_STATE)).toEqual([]);
  });

  it('Play All with the pop-out open plays each item in the pop-out only', () => {
    popOut();
    app._playQueue = [item(ALPHA), item(BRAVO), item(CHARLIE)];
    app._playQueueItem(1);
    video.fire('loadeddata'); // the inline element finishes loading Bravo

    expect(video.play).not.toHaveBeenCalled();
    expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(BRAVO), autoplay: true, timeMs: 0 });
  });

  it('a playlist item with a resume point starts there in the pop-out, not at 0 (triage 2026-11-23)', () => {
    popOut();
    app._isPlaylistContext = () => true;
    app.getResumeEntry = (p) => (p === BRAVO ? { position: 42, duration: 600 } : null);
    app._playQueue = [item(ALPHA), item(BRAVO), item(CHARLIE)];
    offerResume = (entry) => !!entry;
    try {
      app._playQueueItem(1);
      video.fire('loadeddata');
      expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(BRAVO), autoplay: true, timeMs: 42000 });
      // The next item has none: back to 0, never the previous one's point.
      app._playQueueItem(2);
      video.fire('loadeddata');
      expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(CHARLIE), timeMs: 0 });
    } finally {
      offerResume = () => false;
    }
  });

  it('a dropped or opened file (drag-drop, Browse, O key) plays in the pop-out, not behind it', () => {
    popOut({ at: 4, playing: true });
    app._dragDropOptions().onVideoFile(item(BRAVO));
    video.fire('loadeddata'); // the inline element finishes loading Bravo

    expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(BRAVO), autoplay: true, timeMs: 0 });
    expect(video.play).not.toHaveBeenCalled();
    expect(warns.some((w) => String(w[0]).includes('blocked inline play'))).toBe(false);
    expect(app._navigateTo).not.toHaveBeenCalledWith('player'); // main stays browseable
    expect(api.playerPopoutReveal).toHaveBeenCalledTimes(1);
  });

  it('a dropped File with no path (blob:) folds the pop-out back and plays inline from the start', async () => {
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = () => 'blob:dropped';
    URL.revokeObjectURL = () => {};
    try {
      popOut({ at: 4, playing: true });
      api.playerPopoutClose = vi.fn(async () => popoutEvent({ type: 'closed' })); // main closes it
      await app._dragDropOptions().onVideoFile({ name: 'Dropped.mp4' });

      expect(api.playerPopoutClose).toHaveBeenCalledTimes(1);
      expect(app._playerWindowActive).toBe(false);
      expect(video.src).toBe('blob:dropped');
      expect(video.currentTime).toBe(0); // not the previous clip's 4 s
      expect(video.play).toHaveBeenCalledTimes(1);
      expect(video.paused).toBe(false);
      expect(app._navigateTo).toHaveBeenCalledWith('player');
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  it('docked, a dropped file plays inline and opens the player, as before', () => {
    app._dragDropOptions().onVideoFile(item(BRAVO));
    video.fire('loadeddata');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
    expect(app._navigateTo).toHaveBeenCalledWith('player');
    expect(sent(PLAYERWIN.LOAD_VIDEO)).toEqual([]);
  });

  it('any other caller that plays the inline <video> while detached is stopped at once', () => {
    popOut();
    video.play();
    expect(video.paused).toBe(true);
    expect(warns.some((w) => String(w[0]).includes('blocked inline play'))).toBe(true);
  });

  it('a looping pop-out at its end does not advance, whatever the hidden element reports', () => {
    app._currentPlayContext = { source: 'library', list: [ALPHA, BRAVO], index: 0 };
    app._setUpNextContext(app._currentPlayContext);
    popOut({ at: 1 }); // before the 10 s Up Next window of this 13 s clip
    popoutTick({ at: 12.9, loop: true });
    // What an inline event (timeupdate, loadedmetadata → loop refresh) runs.
    app._syncUpNextSuppression();
    app.upNextEngine.check();
    expect(app.upNextShown).toEqual([]);
    expect(app.upNextAdvanced).toEqual([]);
  });

  it('Shift+L in the main window loops the pop-out', () => {
    app._currentPlayContext = { source: 'library', list: [ALPHA, BRAVO], index: 0 };
    app._setUpNextContext(app._currentPlayContext);
    popOut({ at: 4 });
    press('L', { shiftKey: true });
    expect(last(PLAYERWIN.SET_LOOP)).toEqual({ type: 'set-loop', loop: true });
    expect(video.loop).toBe(false); // the hidden element was not the one looped
  });
});

describe('V15: a video routed into the pop-out obeys the same autoplay rules as inline', () => {
  it('a library click loads it paused when player.autoplayOnOpen is off', async () => {
    popOut({ playing: false });
    await app._playFromLibrary(item(BRAVO), null, null, []);
    video.fire('loadeddata');
    expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(BRAVO), autoplay: false });
    expect(video.play).not.toHaveBeenCalled();
  });

  it('with player.autoplayOnOpen on it autoplays, in the pop-out only', async () => {
    app._settingsMap.set('player.autoplayOnOpen', true);
    popOut({ playing: false });
    await app._playFromLibrary(item(BRAVO), null, null, []);
    video.fire('loadeddata');
    expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(BRAVO), autoplay: true });
    expect(video.play).not.toHaveBeenCalled();
  });

  it('an Up Next advance with autoplayOnAdvance autoplays in the pop-out only', async () => {
    popOut({ playing: true });
    app._autoAdvancing = true;
    await app._playFromLibrary({ ...item(BRAVO), _autoPlayOnLoad: true }, null, null, []);
    video.fire('loadeddata');
    expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ autoplay: true });
    expect(video.play).not.toHaveBeenCalled();
  });

  it('a cloud upload in flight holds the pop-out; the upload finishing starts the POP-OUT', async () => {
    popOut({ playing: false });
    // The real HandyManager's surface loadVideo reads (FN-01): a paused
    // pop-out's device was last told to stop.
    app.handyManager = { connected: true, hsspMayBeRunning: false, hsspStop: vi.fn(async () => true) };
    app.loadVideo(item(BRAVO), { autoPlay: false, skipViewSwitch: true });
    app._markCloudUploadsPending();
    await app._routeLoadedVideoToPlayerWindow(true);
    expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(BRAVO), autoplay: false });
    const before = sent(PLAYERWIN.SET_PLAY_STATE).length;

    app._resolveCloudUpload('handy');

    expect(sent(PLAYERWIN.SET_PLAY_STATE).slice(before)).toEqual([{ type: 'set-play-state', paused: false }]);
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe('V16: the pop-out is brought up for a video the user asked for', () => {
  it('a library click reveals it', async () => {
    popOut();
    await app._playFromLibrary(item(BRAVO), null, null, []);
    expect(api.playerPopoutReveal).toHaveBeenCalledTimes(1);
  });

  it('Next in a Play All queue reveals it', () => {
    popOut();
    app._playQueue = [item(ALPHA), item(BRAVO), item(CHARLIE)];
    app._playQueueIndex = 0;
    app._playQueueItem(1); // what _playNext calls
    expect(api.playerPopoutReveal).toHaveBeenCalledTimes(1);
  });

  it('an auto-advance leaves a minimised window where it is (Up Next and Play All)', async () => {
    popOut();
    app._autoAdvancing = true; // _playUpNext holds this across the load
    await app._playFromLibrary(item(BRAVO), null, null, []);
    app._autoAdvancing = false;
    app._playQueue = [item(ALPHA), item(BRAVO), item(CHARLIE)];
    app._playQueueIndex = 0;
    app._advanceQueueOnEnded(); // the pop-out's 'ended' with Up Next off
    expect(last(PLAYERWIN.LOAD_VIDEO)).toMatchObject({ src: pathToFileURL(BRAVO) });
    expect(api.playerPopoutReveal).not.toHaveBeenCalled();
  });
});

describe('V17: a pop-out that takes over gets the volume, loop and queue the main window had', () => {
  it('sends volume, mute, loop and the queue position on READY', () => {
    video.volume = 0.8;
    video.loop = true;
    app._playQueue = [item(ALPHA), item(BRAVO), item(CHARLIE), item(DELTA)];
    app._playQueueIndex = 1;
    popOut();
    expect(last(PLAYERWIN.SET_VOLUME)).toEqual({ type: 'set-volume', volume: 0.8, muted: false });
    expect(last(PLAYERWIN.SET_LOOP)).toEqual({ type: 'set-loop', loop: true });
    expect(last(PLAYERWIN.QUEUE_STATE)).toEqual({ type: 'queue-state', hasPrev: true, hasNext: true, label: '2 / 4' });
  });

  it('a video looped inline does not auto-advance once popped out', () => {
    app._currentPlayContext = { source: 'library', list: [ALPHA, BRAVO], index: 0 };
    app._setUpNextContext(app._currentPlayContext);
    video.loop = true;
    video.currentTime = 12.9; // popped out in its last second
    popoutEvent({ type: 'opened' });
    popoutEvent({ type: 'message', payload: PLAYERWIN.makeMessage(PLAYERWIN.READY) });
    app.upNextEngine.check();
    expect(app.upNextShown).toEqual([]);
    expect(app.upNextAdvanced).toEqual([]);
  });

  it('closing the pop-out hands its loop flag back to the main window', () => {
    popOut();
    press('L', { shiftKey: true }); // loop on, in the pop-out
    popoutEvent({ type: 'closed' });
    expect(video.loop).toBe(true);
  });
});

describe('V14 (main renderer): a pop-out that crashed', () => {
  it('folds back with a toast saying why, and the keys act inline again', () => {
    popOut({ playing: true });
    popoutEvent({ type: 'closed', reason: 'crashed' });
    expect(toasts.map((x) => x.key)).toEqual(['player.windowCrashed']);
    press(' ');
    expect(video.play).toHaveBeenCalled(); // inline again, not relayed into the dead window
  });

  it('an ordinary close shows no toast', () => {
    popOut();
    popoutEvent({ type: 'closed' });
    expect(toasts).toEqual([]);
  });
});
