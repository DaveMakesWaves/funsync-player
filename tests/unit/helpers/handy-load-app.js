// The REAL app.js load path (loadVideo, a library click, a Play All item, the
// player pop-out's re-route, the Handy and Autoblow uploads) on a fake inline
// <video>, for tests about what devices and the cloud-upload gate do when a
// video loads (block F: FT-112, FT-115, FT-116, FN-01). Built the way
// player-popout-playback.test.js builds its app (helpers/app-methods.js
// lifts the method bodies); collaborators not under test are inert stubs.
//
// FakeVideo follows Chromium where it matters here: play() and pause() flip
// `paused` at once but fire `play` + `playing` / `pause` on a later task (a
// queued media element task), so a handler unbound right after a pause() in
// the same task never sees it (the pop-out take-over relies on that); a
// source swap (loadSource) sets `paused` WITHOUT firing `pause`, fires
// `emptied`, and `loadeddata` comes only when the test fires it. That silent
// pause is the whole of FT-115.
import { vi } from 'vitest';
import { liftAppClass } from './app-methods.js';
import { pathToFileURL } from '../../../renderer/js/path-utils.js';
import { RemotePlaybackProxy } from '../../../renderer/js/remote-playback-proxy.js';
import * as PLAYERWIN from '../../../renderer/js/player-popout-protocol.js';

export const LOAD_PATH_METHODS = [
  'loadVideo', '_disarmLoadAutoplay', '_applyPendingResumeSeek',
  '_playFromLibrary', '_withShuffledStart', '_playQueueItem', '_loadPlayContent', '_loadQueueItemContent',
  '_editorAllowsReplace', '_armQueueEndedListener', '_setUpNextContext', '_updateQueueUI',
  '_routeLoadedVideoToPlayerWindow', '_currentPopoutVideo', '_sendLoadVideoToPopout',
  '_activatePlayerWindow', '_syncUpNextSuppression',
  '_playerWindowPlayback', '_startPlayback',
  '_markCloudUploadsPending', '_resolveCloudUpload', '_clearCloudUploadGate',
  '_showScriptLoadingOverlay', '_hideScriptLoadingOverlay',
];

export class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      src: '', currentSrc: '', paused: true, ended: false, seeking: false, readyState: 4,
      currentTime: 0, duration: 13, volume: 0.8, muted: false, loop: false, playbackRate: 1, error: null,
    });
    this.play = vi.fn(() => {
      if (this.paused) {
        this.paused = false;
        setTimeout(() => {
          this.dispatchEvent(new Event('play'));
          this.dispatchEvent(new Event('playing'));
        }, 0);
      }
      return Promise.resolve();
    });
    this.pause = vi.fn(() => {
      if (!this.paused) {
        this.paused = true;
        setTimeout(() => this.dispatchEvent(new Event('pause')), 0);
      }
    });
  }

  /** What `video.src = url; video.load()` does: paused, no `pause` event. */
  swapSource(url) {
    this.src = url;
    this.paused = true;
    this.currentTime = 0;
    this.dispatchEvent(new Event('emptied'));
  }

  fire(type) {
    if (type === 'loadeddata') this.currentSrc = this.src;
    this.dispatchEvent(new Event(type));
  }
}

/**
 * @param {object} [o]
 * @param {string[]} [o.extra] - more app.js methods to lift
 * @param {object} [o.deps] - more free identifiers for the lifted methods
 * @param {object} [o.console] - the console the lifted code writes to
 */
export function makeLoadAppClass({ extra = [], deps = {}, console: con } = {}) {
  const fakeDocument = {
    documentElement: { dataset: { theme: 'dark', style: 'classic' } },
    getElementById: () => ({ hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {} }),
  };
  return liftAppClass([...LOAD_PATH_METHODS, ...extra], {
    window: { get funsync() { return globalThis.__liftedFunsync; } },
    document: fakeDocument,
    console: con || { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    URL,
    pathToFileURL,
    RemotePlaybackProxy,
    maybeShowHevcGuidance: () => {},
    isAutoMatch: () => false,
    showToast: (message, type) => { (globalThis.__liftedToasts ||= []).push({ key: String(message), type }); },
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    PLAYERWIN,
    shouldOfferResume: () => false,
    formatResumeTime: () => '',
    requestAnimationFrame: (fn) => fn(),
    INLINE_VIZ_OPACITY_DEFAULT: 80,
    // Identity transforms: the upload content chain is FT-113's, not these tests'.
    extendRawScriptContent: (raw) => raw,
    fillRawScriptContent: (raw) => raw,
    clampRawScriptContent: (raw) => raw,
    ...deps,
  });
}

/** An app on a FakeVideo with every stub the load path needs. */
export function buildLoadApp(Lifted, overrides = {}) {
  globalThis.__liftedToasts = [];
  const relayed = [];
  globalThis.__liftedFunsync = {
    readFunscript: vi.fn(async () => null),
    playerPopoutRelay: vi.fn((direction, payload) => { if (direction === 'to-popout') relayed.push(payload); }),
    playerPopoutReveal: vi.fn(),
    playerPopoutClose: vi.fn(),
  };
  const video = new FakeVideo();
  const settingsMap = new Map();
  const videoPlayer = {
    video,
    get duration() { return video.duration; },
    get currentTime() { return video.currentTime; },
    get paused() { return video.paused; },
    isVRProjecting: false,
    loadSource: vi.fn((url) => video.swapSource(url)),
    clearSubtitles: vi.fn(),
  };
  const app = Object.assign(new Lifted(), {
    videoPlayer,
    progressBar: {
      clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {}, renderHeatmap() {}, renderChapterStrip() {},
    },
    funscriptEngine: { clear() {}, isLoaded: false },
    settings: { get: (k) => settingsMap.get(k), set: (k, v) => settingsMap.set(k, v), addRecentFile() {} },
    _settingsMap: settingsMap,
    library: { getVideoByPath: () => null },
    _pendingUploads: new Set(),
    _waitingForScript: false,
    _pendingFunscripts: [],
    _playQueue: [],
    _playQueueIndex: -1,
    _userQueue: [],
    _maybePushCurrentToHistory() {},
    _ensureVideoLoadWatch() {},
    _stopGapSkip() {},
    _feedInlineViz() {},
    _navigateTo: vi.fn(),
    _currentView: () => 'player',
    _clearMiniplayer() {},
    _updateCategoryDots() {},
    _updateQueuePanelState() {},
    _applyVRFlattenForCurrent() {},
    _autoMatchEroScripts() {},
    _recordResumePosition() {},
    _resetCustomRoutingState() {},
    _isPlaylistContext: () => false,
    getResumeEntry: () => null,
    _maybeOfferResume: async () => null,
    _updateVariantSelector() {},
    loadFunscript: vi.fn(),
    _loadMultiAxisScripts() {},
    _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {},
    _emitVideoSyncOffsetRowChanged() {},
    // The pop-out's heatmap / variant stream: not these tests' (FN-03's).
    _streamPlayerWindowData() {},
    _handyUploadContent: (raw) => raw,
    _autoblowUploadContent: (raw) => raw,
    _uploadDurationMsFor: () => null,
    _handyInverted: () => false,
    _fillerOptionsForUpload: () => null,
    _cutoffFromSettings: () => null,
    upNextEngine: { setPlayContext() {}, setSuppressed() {}, hide() {}, check() {} },
    ...overrides,
  });
  return { app, video, relayed, toasts: () => globalThis.__liftedToasts };
}

export const fileItem = (path) => ({ name: path.split(/[\\/]/).pop(), path, _isPathBased: true });
