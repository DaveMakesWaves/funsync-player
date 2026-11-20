// Popping the player out of the player view stopped every device (verify-1,
// 2026-11-07; also in v0.9.2). `_activatePlayerWindow` restarted the sync
// engines on the window's clock, then sent this window to the library. That
// ran `_onLeaveView('player')`: the inline <video> had just been paused, so
// no mini player, and `_teardownPlayback` stopped every engine and sent each
// device a stop. Nothing started them again, so a connected device did not
// follow the detached player at all (a T-Code listener got no commands while
// the pop-out played for 30 s).
//
// Second, cosmetic: the pop-out always sent this window to the LIBRARY, so
// after a round trip Back from the player landed there even when the user
// had opened the video from Playlists.
//
// What runs is REAL: app.js's `_activatePlayerWindow`, `_deactivatePlayerWindow`,
// `_navigateTo`, `_navigateBack`, `_onEnterView`, `_onLeaveView` and the
// teardown (pip-guard.js), the REAL RemotePlaybackProxy, and the REAL
// TCodeSync over the REAL TCodeManager on a stubbed IPC (no port, no
// device): asserted on the T-Code lines that would go down the wire. The
// Handy, Buttplug and Autoblow engines are recording fakes; what is asserted
// for them is the stop each device would be sent.
//
// jsdom (no docblock): pip-guard.js and miniplayer.js branch on
// `typeof document` (notes/CLAUDE.md "Test environments").
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { isVideoInPip, teardownPlayback } from '../../renderer/js/pip-guard.js';
import { shouldEnterMiniplayer, exitFullscreenForNav } from '../../renderer/js/miniplayer.js';

const LiftedApp = liftAppClass([
  '_activatePlayerWindow', '_deactivatePlayerWindow',
  '_currentView', '_navigateTo', '_navigateBack', '_onEnterView', '_onLeaveView',
  '_isOurVideoInPip', '_teardownPlayback', '_shouldEnterMiniplayer',
], {
  document,
  RemotePlaybackProxy,
  isVideoInPip,
  teardownPlayback,
  shouldEnterMiniplayer,
  exitFullscreenForNav,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
});

const stroke = (n = 200) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));

/** The inline <video>: a real EventTarget with the fields the app reads. */
class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { src: 'file:///C:/Lib/Alpha.mp4', currentSrc: 'file:///C:/Lib/Alpha.mp4', paused: true, ended: false, currentTime: 0, duration: 120, loop: false });
  }

  play() {
    if (this.paused) { this.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); }
    return Promise.resolve();
  }

  pause() {
    if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); }
  }
}

/** A sync engine that records what was done to it (the Handy / Buttplug / Autoblow). */
function fakeEngine() {
  return {
    _active: false, player: null, stops: 0,
    start() { this._active = true; },
    stop() { this._active = false; this.stops += 1; },
    reloadActions() {},
  };
}

let lines;

async function build({ from = 'library' } = {}) {
  document.body.innerHTML = `
    <div id="app">
      <div id="library-container"></div>
      <div id="player-container" hidden></div>
      <div id="playlists-container" hidden></div>
      <div id="categories-container" hidden></div>
    </div>`;
  const views = {
    library: document.getElementById('library-container'),
    player: document.getElementById('player-container'),
    playlists: document.getElementById('playlists-container'),
    categories: document.getElementById('categories-container'),
  };
  const video = new FakeVideo();
  const videoPlayer = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
  };
  const tcodeManager = new TCodeManager();
  expect(await tcodeManager.connect('udp', { host: '127.0.0.1', port: 18099 })).toBe(true);
  const actions = stroke();
  const funscriptEngine = { get isLoaded() { return true; }, getActions: () => actions, getAuthoredActions: () => actions };
  const tcodeSync = new TCodeSync({ videoPlayer, tcodeManager, funscriptEngine });

  const app = Object.assign(new LiftedApp(), {
    settings: { get: (k) => (k === 'player.miniPlayer' ? false : undefined) },
    videoPlayer,
    funscriptEngine,
    _navStack: [from],
    _miniActive: false,
    _playerWindowActive: false,
    _playerWinProxy: null,
    _remoteActive: false,
    vrBridge: null,
    tcodeManager,
    tcodeSync,
    // `hsspMayBeRunning` as the real HandyManager has it: null = unknown, false
    // after a stop request, true after a play request (FN-01 reads it).
    handyManager: { connected: true, hsspMayBeRunning: null, hsspStop: vi.fn() },
    syncEngine: fakeEngine(),
    buttplugManager: { connected: true, stopAll: vi.fn() },
    buttplugSync: fakeEngine(),
    autoblowManager: { connected: true, syncStop: vi.fn() },
    autoblowSync: fakeEngine(),
    handyHdspSync: null,
    upNextEngine: { player: videoPlayer, visible: false, hide() {} },
    // The views' own components: not under test.
    navBar: { show() {}, hide() {}, setActive() {} },
    library: { show() {}, hide() {} },
    playlists: { show: vi.fn(), hide() {}, navigateBack: () => false },
    categories: { show() {}, hide() {}, navigateBack: () => false },
    queuePanel: null,
    _getViewEl: (v) => views[v] || null,
    _syncCaptionOverlay() {}, _syncBackendBannerOffset() {},
    _refreshCollectionsUI: async () => {},
    _beginDeferredPipTeardown() {},
    _clearMiniplayer() {},
    _enterMiniplayer() {},
    _emitVideoSyncOffsetRowChanged() {},
    _refreshLoopVideoVisibility() {},
    _currentPopoutVideo: () => ({ src: video.src, title: 'Alpha', timeMs: Math.round(video.currentTime * 1000), autoplay: !video.paused }),
  });

  // The user opens Alpha into the player view and plays it: every
  // connected device runs on the inline <video>.
  app._navigateTo('player');
  for (const e of [app.syncEngine, app.buttplugSync, app.autoblowSync]) { e.player = videoPlayer; e.start(); }
  tcodeSync.start();
  video.play();
  video.currentTime = 10;
  return { app, video, tcodeSync };
}

/** The pop-out's <video> plays: its TIME_TICKs feed the proxy. */
async function popoutPlays(app, { fromSec = 10, ms = 1500 } = {}) {
  app._playerWinProxy.updateState({ at: fromSec * 1000, paused: false });
  for (let t = 0; t < ms; t += 100) {
    app._playerWinProxy.updateState({ at: fromSec * 1000 + t, paused: false });
    await vi.advanceTimersByTimeAsync(100);
  }
}

/** Position frames for the main stroke (an interval-carrying L0 command). */
const strokeFrames = (from = 0) => lines.slice(from).filter((l) => /\bL0\d+I\d+/.test(l));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  lines = [];
  window.funsync = {
    tcodeConnect: async () => ({ success: true }),
    onTcodeDisconnected: () => () => {},
    tcodeSend: async (line) => { lines.push(line); return true; },
    tcodeDisconnect: async () => {},
  };
});
afterEach(() => {
  delete window.funsync;
  vi.useRealTimers();
});

describe('a device follows the player window popped out of the player view', () => {
  it('T-Code: the pop-out\'s playback reaches the device, and no stop is sent after the take-over', async () => {
    const { app, tcodeSync } = await build();
    app._activatePlayerWindow();
    expect(app._currentView()).toBe('library');

    // The take-over's own stop (before the re-bind) is the last one.
    const afterTakeover = lines.length;
    await popoutPlays(app);
    expect(tcodeSync.isDriving()).toBe(true);
    expect(tcodeSync.player.video).toBe(app._playerWinProxy);
    expect(strokeFrames(afterTakeover).length).toBeGreaterThan(3);
    expect(lines.slice(afterTakeover).some((l) => /DSTOP/.test(l))).toBe(false);
  });

  it('Handy, Buttplug and Autoblow stay bound to the window\'s clock, and none of them is sent a teardown stop', async () => {
    const { app } = await build();
    app._activatePlayerWindow();
    for (const e of [app.syncEngine, app.buttplugSync, app.autoblowSync]) {
      expect(e._active).toBe(true);
      expect(e.player.video).toBe(app._playerWinProxy);
    }
    // The Handy gets ONE stop, the take-over's own (N-01, 2026-11-16): the
    // inline pause lands after the engine is re-bound, and SyncEngine.stop()
    // sends nothing, so HSSP played on through the hand-off until the
    // window's first 'playing'. That is the stop the real T-Code, Buttplug
    // and Autoblow engines' own stop() already sends at this point (the
    // T-Code test above sees its DSTOP; these fakes do not model it). The
    // teardown's stop came on top of it, with nothing restarting the engines.
    expect(app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(app.buttplugManager.stopAll).not.toHaveBeenCalled();
    expect(app.autoblowManager.syncStop).not.toHaveBeenCalled();
  });

  it('the window closed during a stall folds back PLAYING: a stall is not a pause (N-01)', async () => {
    const { app, video } = await build();
    app._activatePlayerWindow();
    await popoutPlays(app);
    // The window's last tick: playing, but its picture stalled. The devices
    // see a pause; the user did not press one.
    app._playerWinProxy.updateState({ at: 11_500, paused: false, stalled: true });
    expect(app._playerWinProxy.paused).toBe(true);
    app._deactivatePlayerWindow();
    expect(video.paused, 'the fold-back took a stall for a pause and left the video paused').toBe(false);
    expect(app._currentView()).toBe('player');
  });

  it('a take-over from a PAUSED inline video sends the Handy no stop (N-01)', async () => {
    const { app, video } = await build();
    video.pause();
    // The real engine's pause sent the stop (these fake engines do not), so
    // the real manager reads "last told to stop".
    app.handyManager.hsspMayBeRunning = false;
    app.handyManager.hsspStop.mockClear();
    app._activatePlayerWindow();
    expect(app.syncEngine._active).toBe(true);
    expect(app.handyManager.hsspStop).not.toHaveBeenCalled();
  });

  it('control: Back from the player view with no pop-out still stops every device', async () => {
    const { app, video, tcodeSync } = await build();
    app._navigateBack();
    expect(app._currentView()).toBe('library');
    expect(video.paused).toBe(true);
    expect(tcodeSync.isDriving()).toBe(false);
    expect(lines.at(-2) || lines.at(-1)).toMatch(/DSTOP/);
    expect(app.handyManager.hsspStop).toHaveBeenCalled();
    expect(app.buttplugManager.stopAll).toHaveBeenCalled();
    expect(app.autoblowManager.syncStop).toHaveBeenCalled();
  });
});

describe('the main window goes back to where the player was opened from', () => {
  it('opened from Playlists: Playlists shows while popped out, and after the round trip Back lands on Playlists', async () => {
    const { app } = await build({ from: 'playlists' });
    app._activatePlayerWindow();
    expect(app._currentView()).toBe('playlists');
    expect(document.getElementById('playlists-container').hidden).toBe(false);
    expect(document.getElementById('player-container').hidden).toBe(true);

    // The pop-out closes while playing: playback folds back into the player view.
    await popoutPlays(app);
    app._deactivatePlayerWindow();
    expect(app._currentView()).toBe('player');
    app._navigateBack();
    expect(app._currentView()).toBe('playlists');
  });

  it('opened from the library: the library, as before', async () => {
    const { app } = await build({ from: 'library' });
    app._activatePlayerWindow();
    expect(app._currentView()).toBe('library');
    expect(app._navStack).toEqual(['library']);
  });
});
