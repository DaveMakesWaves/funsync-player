/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Resume positions recorded from a clock that is not this window's own
// <video> (verify-1, 2026-11-07; all also in v0.9.2):
//
//   1. A pause in the player pop-out was not saved; only the 15 s tick
//      recorded. Paused at 0:53 and closed, the replay offered 0:47.
//   2. FT-097 check 6: a HereSphere headset playing the video a playlist has
//      open on the desktop recorded nothing (the resume clock had no VR
//      branch).
//   3. Found while fixing 2: a phone playing ANOTHER video wrote its clock
//      against this window's video: B's position replaced A's bookmark, and
//      a glance at B under 10 s deleted it.
//   4. After a phone or headset session on the same video, this window's
//      paused element still held the old time, and a write from it at quit
//      put that old position back over the session's.
//
// The REAL app.js resume methods are lifted (helpers/app-methods.js) with the
// REAL resume-position.js rules, the REAL RemotePlaybackProxy and the REAL
// pop-out message handler. What is asserted is what lands in
// library.resumePositions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import {
  shouldRecordPosition, makeResumeEntry, makeFinishedEntry, isFinished, endThreshold,
  RESUME_MIN_DELTA_SECONDS, RESUME_WRITE_INTERVAL_MS,
} from '../../renderer/js/resume-position.js';

const A = 'C:\\Lib\\Long Two.mp4';
const B = 'C:\\Lib\\Other.mp4';
const PLAYLIST = { source: 'playlist', sourceContext: { playlistId: 'pl1' } };

let fakeWindow;
const LiftedApp = liftAppClass([
  '_initResumeTracking', '_resumeClockSource', '_isSessionResumeClock', '_isPlaylistContext',
  '_playlistIdOf', '_resumeMap', 'getResumeEntry', '_writeResumeEntry', '_recordResumePosition',
  '_onPlayerWindowMessage',
], {
  // Forwards to the current test's window: the class is built once.
  window: { addEventListener: (...a) => fakeWindow.addEventListener(...a) },
  eventBus: { on() {} },
  PLAYERWIN,
  shouldRecordPosition, makeResumeEntry, makeFinishedEntry, isFinished, endThreshold,
  RESUME_MIN_DELTA_SECONDS, RESUME_WRITE_INTERVAL_MS,
  console: { log() {}, info() {}, warn() {}, error() {} },
});

/** The inline <video>: a real EventTarget with the fields the app reads. */
class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 120; }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  seek(s) { this.currentTime = s; this.dispatchEvent(new Event('seeked')); }
}

function build({ entries = {} } = {}) {
  const store = { 'library.resumePositions': { ...entries } };
  const video = new FakeVideo();
  const videoPlayer = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
  };
  const app = Object.assign(new LiftedApp(), {
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    videoPlayer,
    upNextEngine: { player: videoPlayer },
    _currentVideoPath: A,
    _currentPlayContext: PLAYLIST,
    _markPlaylistLastWatched() {},
    _onPopoutVideoEnded() {},
  });
  app._initResumeTracking();
  const at = (path = A) => store['library.resumePositions'][path] || null;
  return { app, video, videoPlayer, at };
}

/** Run the 15 s resume tick once. */
const tick = () => vi.advanceTimersByTimeAsync(RESUME_WRITE_INTERVAL_MS);

/**
 * A remote surface plays from `fromSec` for `forMs`: its state reaches the
 * proxy every 250 ms, as the pop-out's TIME_TICKs and the phone's states do
 * (a proxy with no state for 2 s pauses itself).
 */
async function feed(proxy, fromSec, forMs) {
  for (let t = 0; t < forMs; t += 250) {
    proxy.updateState({ at: fromSec * 1000 + t, paused: false });
    await vi.advanceTimersByTimeAsync(250);
  }
  proxy.updateState({ at: fromSec * 1000 + forMs, paused: false });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  fakeWindow = new EventTarget();
});
afterEach(() => { vi.useRealTimers(); });

describe('the player pop-out: a pause and the end are saved at once', () => {
  function popOut(app) {
    const proxy = new RemotePlaybackProxy();
    proxy.updateState({ at: 0, paused: true, duration: 120 });
    app._playerWinProxy = proxy;
    app._playerWindowActive = true;
    app.upNextEngine.player = proxy.asVideoPlayerWrapper();
    return proxy;
  }
  const popoutEvent = (app, event, timeMs) => app._onPlayerWindowMessage(
    PLAYERWIN.makeMessage(PLAYERWIN.VIDEO_EVENT, { event, timeMs }),
  );

  it('paused at 0:53 between two ticks: 0:53 is saved, not the tick before it', async () => {
    const { app, at } = build();
    const proxy = popOut(app);
    await feed(proxy, 32, 15000); // the 15 s tick lands at about 0:47
    expect(at().position).toBeGreaterThan(46);
    expect(at().position).toBeLessThan(48);

    await feed(proxy, 47, 6500); // 6.5 s more, no tick
    popoutEvent(app, 'pause', 53500);
    expect(at().position).toBeCloseTo(53.5, 1);
  });

  it('ended in the window: the video is marked watched before anything advances', async () => {
    const { app, at } = build({ entries: { [A]: makeResumeEntry(47, 120, 1) } });
    const proxy = popOut(app);
    proxy.updateState({ at: 119900, paused: false });
    popoutEvent(app, 'ended', 120000);
    expect(isFinished(at())).toBe(true);
    expect(at().position).toBeUndefined();
  });
});

describe('a HereSphere headset playing the video this window has open in a playlist (FT-097 check 6)', () => {
  function headset(app, { matched = A, time = 20 } = {}) {
    const vr = { currentTime: time, paused: false, duration: 120 };
    app._vrPlayerRef = { video: {}, get currentTime() { return vr.currentTime; }, get paused() { return vr.paused; }, get duration() { return vr.duration; } };
    app._vrSyncOffsetPath = matched;
    return vr;
  }

  it('32 s in the headset move the bookmark; a pause there is saved at the next tick', async () => {
    const { app, video, at } = build();
    video.currentTime = 20;
    video.pause(); // the desktop stopped at 0:20 (a pause saves it)
    expect(at().position).toBe(20);

    const vr = headset(app, { time: 52 });
    await tick();
    expect(at().position).toBe(52);

    vr.currentTime = 60;
    vr.paused = true;
    await tick();
    expect(at().position).toBe(60);
  });

  it('after the session: a quit does not put this window\'s old 0:20 back; playing here again records from here', async () => {
    const { app, video, at } = build();
    video.currentTime = 20;
    video.pause();
    headset(app, { time: 52 });
    await tick();
    expect(at().position).toBe(52);

    app._vrPlayerRef = null; // the headset disconnects (_stopVRSync)
    fakeWindow.dispatchEvent(new Event('beforeunload'));
    expect(at().position).toBe(52);

    // Back on the desktop: the user seeks / plays here, so this element is the clock again.
    video.seek(70);
    video.play();
    fakeWindow.dispatchEvent(new Event('beforeunload'));
    expect(at().position).toBe(70);
  });

  it('the headset on ANOTHER video leaves this window\'s bookmark alone', async () => {
    const { app, video, at } = build({ entries: { [A]: makeResumeEntry(40, 120, 1) } });
    video.currentTime = 40;
    headset(app, { matched: B, time: 75 });
    await tick();
    await tick();
    expect(at().position).toBe(40);
    expect(at(B)).toBeNull();
  });
});

describe('a phone session', () => {
  function phone(app, { path, atMs }) {
    const proxy = new RemotePlaybackProxy();
    proxy.updateState({ at: atMs, paused: false, duration: 120 });
    app._remoteProxy = proxy;
    app._remoteActive = true;
    app._phoneSyncOffsetPath = path;
    return proxy;
  }

  it('the phone playing ANOTHER video: this window\'s bookmark is neither replaced nor deleted', async () => {
    const { app, at } = build({ entries: { [A]: makeResumeEntry(600, 1200, 1) } });
    app.videoPlayer.video.duration = 1200;
    const proxy = phone(app, { path: B, atMs: 0 });
    proxy.updateState({ paused: true });
    await vi.advanceTimersByTimeAsync(10000); // the phone is still loading B
    await feed(proxy, 0, 15000); // the tick samples B at 0:05: a glance deleted A's 10:00
    expect(at().position).toBe(600);
    await feed(proxy, 300, 15000); // and at 5:05: written over A's
    expect(at().position).toBe(600);
    expect(at(B)).toBeNull();
  });

  it('the phone playing THIS video records it, and its end of session does not bring the desktop\'s old time back', async () => {
    const { app, video, at } = build();
    video.currentTime = 15;
    video.pause();
    expect(at().position).toBe(15);
    const proxy = phone(app, { path: A, atMs: 30000 });
    await feed(proxy, 30, 15000);
    expect(at().position).toBeGreaterThanOrEqual(44);

    app._remoteActive = false; // _onRemotePhoneDisconnected
    fakeWindow.dispatchEvent(new Event('beforeunload'));
    expect(at().position).toBeGreaterThanOrEqual(44);
  });
});
