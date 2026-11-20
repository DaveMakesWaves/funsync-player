/**
 * @vitest-environment jsdom
 * jsdom on purpose: the hung-window toast is real DOM (a button the user
 * clicks), built by the lifted app.js method.
 */
// FT-098 (also in v0.9.2): a hung (not crashed) player window was only
// logged in main. While it hangs no clock reaches the main window, the video
// in it may play on, and nothing told the user. Main now sends
// 'unresponsive' / 'responsive' (player-popout-window.test.js); this is the
// main renderer's half, the REAL app.js methods lifted over recording fakes:
//   - the devices stop: the window's clock (the proxy the engines follow)
//     pauses, and each connected device gets its stop;
//   - a toast that stays offers "Close player window", which closes it;
//   - a window that answers again is paused, and the devices wait for Play:
//     a late tick saying "playing" does not start them, a Play does;
//   - closed from the toast, the video is in the main window's player view,
//     paused where the window was.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { liftAppClass } from './helpers/app-methods.js';

let playerEvent;
let relays;
let toasts;
let app;
let proxyEvents;
let inline;
let view;

const t = (key) => `T(${key})`;
const showToast = (message, type, duration) => {
  const entry = { message, type, duration, dismissed: false };
  toasts.push(entry);
  return { dismiss: () => { entry.dismissed = true; } };
};
const textOf = (m) => (typeof m === 'string' ? m : m.textContent);
const fromWindow = (type, fields) => playerEvent({ type: 'message', payload: PLAYERWIN.makeMessage(type, fields) });

function build() {
  const Lifted = liftAppClass([
    '_initPlayerWindow', '_onPlayerWindowHung', '_onPlayerWindowAnswering',
    '_onPlayerWindowMessage', '_deactivatePlayerWindow',
  ], {
    window: { get funsync() { return window.funsync; } },
    showToast, t, console, PLAYERWIN, document,
  });
  app = new Lifted();
  inline = Object.assign(new EventTarget(), {
    currentTime: 3, duration: 60, paused: true, loop: false,
    src: 'file:///C:/sandbox/library/Alpha%20Scene.mp4', currentSrc: 'file:///C:/sandbox/library/Alpha%20Scene.mp4',
    play: vi.fn(function play() { this.paused = false; return Promise.resolve(); }),
    pause: vi.fn(function pause() { this.paused = true; }),
  });
  Object.assign(app, {
    videoPlayer: { video: inline, get currentTime() { return inline.currentTime; } },
    handyManager: { connected: true, hsspStop: vi.fn() },
    buttplugManager: { connected: true, stopAll: vi.fn() },
    tcodeManager: { connected: true, stop: vi.fn() },
    autoblowManager: { connected: false, syncStop: vi.fn() },
    _updatePlayerWindowButton: () => {},
    _currentPopoutVideo: () => ({ path: 'C:\\sandbox\\library\\Alpha Scene.mp4' }),
    _currentView: () => view,
    _navigateTo: (v) => { view = v; },
    _syncUpNextSuppression: () => {},
    _onPopoutVideoEnded: () => {},
    _mirrorPopoutVolume: () => {},
  });
  app._initPlayerWindow();
  // The window is open and owns playback, playing at 30 s (the take-over ran).
  playerEvent({ type: 'opened' });
  app._playerWinProxy = new RemotePlaybackProxy();
  proxyEvents = [];
  for (const ev of ['playing', 'pause']) app._playerWinProxy.addEventListener(ev, () => proxyEvents.push(ev));
  app._playerWinProxy.updateState({ at: 30000, paused: false, duration: 60 });
  app._playerWindowActive = true;
  proxyEvents.length = 0;
  view = 'library';
}

beforeEach(() => {
  playerEvent = null;
  relays = [];
  toasts = [];
  window.funsync = {
    onPlayerPopoutEvent: (cb) => { playerEvent = cb; },
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-popout') relays.push(payload); },
    playerPopoutClose: vi.fn(async () => {}),
  };
  build();
});

describe('FT-098: the player window stops answering', () => {
  it('the devices stop: the clock they follow pauses and each connected device gets its stop', () => {
    playerEvent({ type: 'unresponsive' });
    expect(app._playerWinProxy.paused).toBe(true);
    expect(proxyEvents).toEqual(['pause']);
    expect(app.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(app.buttplugManager.stopAll).toHaveBeenCalledTimes(1);
    expect(app.tcodeManager.stop).toHaveBeenCalledTimes(1);
    expect(app.autoblowManager.syncStop).not.toHaveBeenCalled(); // not connected
  });

  it('a toast that stays says so and offers to close the window; its button closes it', () => {
    playerEvent({ type: 'unresponsive' });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'warn', duration: 0 });
    expect(textOf(toasts[0].message)).toContain('T(player.windowHung)');
    const btn = toasts[0].message.querySelector('button');
    expect(btn.textContent).toBe('T(player.windowHungClose)');
    btn.click();
    expect(window.funsync.playerPopoutClose).toHaveBeenCalledTimes(1);
  });

  it('a second "not responding" adds no second toast', () => {
    playerEvent({ type: 'unresponsive' });
    playerEvent({ type: 'unresponsive' });
    expect(toasts).toHaveLength(1);
  });

  it('nothing is closed on its own', () => {
    playerEvent({ type: 'unresponsive' });
    expect(window.funsync.playerPopoutClose).not.toHaveBeenCalled();
    expect(app._playerWindowActive).toBe(true);
  });
});

describe('FT-098: it answers again', () => {
  it('the toast goes, the window is paused, and a late "playing" tick does not start the devices', () => {
    playerEvent({ type: 'unresponsive' });
    playerEvent({ type: 'responsive' });
    expect(toasts[0].dismissed).toBe(true);
    expect(relays).toEqual([PLAYERWIN.makeMessage(PLAYERWIN.SET_PLAY_STATE, { paused: true })]);
    expect(textOf(toasts.at(-1).message)).toBe('T(player.windowRecovered)');
    // The window's ticks from before our pause landed still say playing.
    proxyEvents.length = 0;
    fromWindow(PLAYERWIN.TIME_TICK, { timeMs: 41000, paused: false, rate: 1, loop: false });
    expect(app._playerWinProxy.paused).toBe(true);
    expect(proxyEvents).toEqual([]);
    expect(app._playerWinProxy.currentTime).toBeCloseTo(41, 3); // the clock still follows
  });

  it('a Play in the window starts the devices again', () => {
    playerEvent({ type: 'unresponsive' });
    playerEvent({ type: 'responsive' });
    fromWindow(PLAYERWIN.VIDEO_EVENT, { event: 'pause', timeMs: 41000 });
    proxyEvents.length = 0;
    fromWindow(PLAYERWIN.VIDEO_EVENT, { event: 'play', timeMs: 41000 });
    expect(proxyEvents).toEqual(['playing']);
    fromWindow(PLAYERWIN.TIME_TICK, { timeMs: 41100, paused: false, rate: 1, loop: false });
    expect(app._playerWinProxy.paused).toBe(false);
  });

  it('a window that never hung is not paused by a "responsive"', () => {
    playerEvent({ type: 'responsive' });
    expect(relays).toEqual([]);
    expect(toasts).toHaveLength(0);
  });
});

describe('FT-098: closed from the toast', () => {
  it('the video is in the player view, paused where the window was; the toast goes', async () => {
    playerEvent({ type: 'unresponsive' });
    playerEvent({ type: 'closed', reason: 'unresponsive' });
    expect(app._playerWindowActive).toBe(false);
    expect(view).toBe('player');
    expect(inline.currentTime).toBeCloseTo(30, 1);
    expect(inline.play).not.toHaveBeenCalled();
    expect(toasts[0].dismissed).toBe(true);
  });

  it('an ordinary close of a window that answers keeps the old fold-back (no view change when paused)', () => {
    app._playerWinProxy.handlePause();
    playerEvent({ type: 'closed' });
    expect(view).toBe('library');
  });
});
