/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its player on the DOM of
 * player-popout.html at import time, and i18n.js branches on `typeof window`.
 */
// N-01, the player pop-out (reproduced 2026-11-16, row P, the worst case):
// the window's <video> stalled for 12 s, but its TIME_TICKs kept saying
// `paused: false` with a frozen time and its 'waiting' / 'playing' / 'seeking'
// only drove its spinner, so main's proxy stayed "playing" while the Handy
// ran 12.05 s ahead, nothing re-anchored it when the picture moved again (the
// window forwards 'play', not 'playing'), and a seek played the old timeline
// for 4.8 s.
//
// FN-05 (2026-11-16): the hold now begins STALL_GRACE_MS after the window's
// stall reaches main; a stall or a seek over inside that window sends no
// stop (the last describe below; inline: stall-grace.test.js).
//
// The whole chain is REAL: element events → the pop-out renderer → its
// TIME_TICK / VIDEO_EVENT messages → app.js's `_onPlayerWindowMessage`
// (lifted) → RemotePlaybackProxy → SyncEngine → HandyManager → a fake SDK
// that records each command with its wall time. The device's own clock is
// replayed from those commands; the assertions are on it.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { liftAppClass } from './helpers/app-methods.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { STALL_GRACE_MS } from '../../renderer/js/playback-stall.js';

const mockHandy = {
  connect: vi.fn().mockResolvedValue({ result: 1 }),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  getClientServerLatency: vi.fn().mockReturnValue({ avgOffset: 0, avgRtd: 0, lastSyncTime: 0 }),
  getState: vi.fn().mockReturnValue({ info: { fwVersion: '4.2.1' }, mode: 1, hssp: { scriptSet: true } }),
  setScript: vi.fn().mockResolvedValue({ result: 1 }),
  hsspPlay: vi.fn(),
  hsspStop: vi.fn(),
  setOffset: vi.fn().mockResolvedValue(undefined),
  setMode: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  API: { get: { connected: vi.fn().mockResolvedValue({ connected: true }) } },
};
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: vi.fn().mockReturnValue(mockHandy),
  getEstimatedServerTime: vi.fn().mockReturnValue(0),
  uploadDataToServer: vi.fn().mockResolvedValue('https://scripts01.handyfeeling.com/abc123'),
}));

// The device, replayed from the commands the SDK was sent.
let sentToDevice;
const deviceRunning = () => sentToDevice.length > 0 && sentToDevice.at(-1).cmd === 'play';
function deviceTimeMs(wall = performance.now()) {
  let run = null; let stoppedAt = null;
  for (const e of sentToDevice) {
    if (e.cmd === 'play') run = e;
    else { if (run) stoppedAt = run.start + (e.wall - run.wall); run = null; }
  }
  return run ? run.start + (wall - run.wall) : stoppedAt;
}
const plays = () => sentToDevice.filter((e) => e.cmd === 'play');

// --- the pop-out window: its REAL renderer on player-popout.html -----------

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = [];          // every message the window sent to main
let onEvent = null;
let app = null;         // main's lifted handler, once built
const el = () => document.getElementById('video');

/** Give the window's <video> the state a real element would have. */
function setEl(fields) {
  for (const [k, v] of Object.entries(fields)) {
    Object.defineProperty(el(), k, { value: v, writable: true, configurable: true });
  }
}
const fire = (type) => el().dispatchEvent(new Event(type));
const ticks = () => up.filter((m) => m.type === PLAYERWIN.TIME_TICK);

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  window.funsync = {
    playerPopoutRelay: (direction, payload) => {
      if (direction !== 'to-parent') return;
      up.push(payload);
      // Main receives the clock and the element's events.
      if (app && (payload.type === PLAYERWIN.TIME_TICK || payload.type === PLAYERWIN.VIDEO_EVENT)) {
        app._onPlayerWindowMessage(payload);
      }
    },
    onPlayerPopoutEvent: (cb) => { onEvent = cb; },
  };
  await import('../../renderer/player-popout.js');
  onEvent({ type: 'opened' });
  const start = Date.now();
  while (!up.some((m) => m.type === PLAYERWIN.READY)) {
    if (Date.now() - start > 5000) throw new Error('the pop-out never said READY');
    await new Promise((r) => setTimeout(r, 5));
  }
}, 20000);

// --- main: the lifted handler, the REAL proxy / engine / manager -----------

const toPopout = [];
let Lifted;
async function buildMain({ at }) {
  const { HandyManager } = await import('../../renderer/js/handy-manager.js');
  const { SyncEngine } = await import('../../renderer/js/sync-engine.js');
  Lifted ||= liftAppClass(['_onPlayerWindowMessage', '_playerWindowPlayback'], {
    window: { funsync: { playerPopoutRelay: (dir, payload) => { if (dir === 'to-popout') toPopout.push(payload); } } },
    PLAYERWIN,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  });
  const manager = new HandyManager();
  await manager.init();
  Object.assign(manager, { _connected: true, _connectionKey: 'testkey', _mode: 1 });
  const proxy = new RemotePlaybackProxy();
  proxy.updateState({ at: at * 1000, paused: true, duration: 180 });
  const engine = new SyncEngine({ videoPlayer: proxy.asVideoPlayerWrapper(), handyManager: manager, funscriptEngine: { isLoaded: true } });
  engine._scriptReady = true;
  engine.start();
  app = Object.assign(new Lifted(), {
    _playerWindowActive: true, _playerWinProxy: proxy, _playerWindowHeld: false,
    syncEngine: engine, handyManager: manager, upNextEngine: null,
    videoPlayer: { video: { volume: 1, muted: false } },
    _recordResumePosition() {}, _onPopoutVideoEnded() {}, _mirrorPopoutVolume() {},
  });
  return { manager, proxy, engine };
}

/** The window's clock: its element advances only while the picture can move. */
let frozen = false;
async function run(ms, step = 50) {
  for (let t = 0; t < ms; t += step) {
    const v = el();
    if (!v.paused && !v.seeking && v.readyState >= 3 && !frozen) setEl({ currentTime: v.currentTime + step / 1000 });
    await vi.advanceTimersByTimeAsync(step);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  sentToDevice = [];
  mockHandy.hsspPlay.mockImplementation(async (start) => { sentToDevice.push({ cmd: 'play', wall: performance.now(), start }); return { result: 0 }; });
  mockHandy.hsspStop.mockImplementation(async () => { sentToDevice.push({ cmd: 'stop', wall: performance.now() }); return { result: 0 }; });
  frozen = false;
  up.length = 0;
  toPopout.length = 0;
});

afterEach(async () => {
  // Pause the window (stops its ticks) while the fake clock still owns them.
  setEl({ paused: true });
  fire('pause');
  app?.syncEngine?.stop();
  app = null;
  vi.useRealTimers();
});

/** The window plays from a buffered position. */
async function windowPlays(at) {
  setEl({ paused: false, readyState: 4, seeking: false, error: null, currentTime: at });
  fire('play');
  fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}

describe('a stall in the window holds the Handy, and its end re-anchors it', () => {
  it('row P: 12 s of starved source — the device stops with the picture and resumes where it froze', async () => {
    await buildMain({ at: 70 });
    await windowPlays(70);
    await run(9980);
    expect(deviceRunning()).toBe(true);

    // The source starves: 'waiting', readyState 2, paused stays false.
    setEl({ readyState: 2 });
    fire('waiting');
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks().at(-1)).toMatchObject({ paused: false, stalled: true });
    const frozenAt = el().currentTime * 1000;
    expect(deviceRunning(), 'stopped inside the grace window (FN-05)').toBe(true);
    await run(STALL_GRACE_MS + 50);
    expect(deviceRunning(), 'the Handy ran on through the window\'s stall (row P)').toBe(false);
    const n = sentToDevice.length;

    await run(12_000);     // ticks keep coming, all frozen
    expect(sentToDevice.length).toBe(n);
    expect(Math.abs(deviceTimeMs() - frozenAt - STALL_GRACE_MS)).toBeLessThan(150);

    // The picture moves again: 'playing' ticks at once and re-anchors.
    setEl({ readyState: 4 });
    fire('playing');
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks().at(-1)).toMatchObject({ paused: false, stalled: false });
    expect(deviceRunning(), 'nothing re-anchored the device when the picture resumed').toBe(true);
    await run(3000);
    expect(Math.abs(deviceTimeMs() - el().currentTime * 1000), 'device ahead of the picture after the stall')
      .toBeLessThan(200);
  });

  it('a seek in the window while playing on a slow source: stopped at the seek, ONE play where it lands', async () => {
    await buildMain({ at: 100 });
    await windowPlays(100);
    await run(1000);
    setEl({ seeking: true, readyState: 1, currentTime: 150 });
    fire('seeking');
    fire('waiting');
    await run(STALL_GRACE_MS + 50);   // FN-05: held once past the window
    expect(deviceRunning(), 'the device played the old timeline during the seek').toBe(false);
    await run(4800);
    const before = plays().length;
    setEl({ seeking: false, readyState: 2 });
    fire('seeked');
    await run(200);
    setEl({ readyState: 4 });
    fire('playing');
    await vi.advanceTimersByTimeAsync(0);
    expect(plays().length).toBe(before + 1);
    expect(Math.abs(plays().at(-1).start - 150_000)).toBeLessThan(100);
  });

  // verify-1 (2026-11-16, row P; new since v0.9.2): the new spot was ready at
  // once, so 'seeked', 'canplay' and 'playing' came in the same ms. The
  // forwarded 'seeked' stopped the device again, the stall's release played
  // it, then the seek played it a second time: stop + play + play in 250 ms.
  it('row P: a seek whose new spot is ready at once — ONE play, and no stop queued in front of it', async () => {
    await buildMain({ at: 100 });
    await windowPlays(100);
    await run(1000);
    setEl({ seeking: true, readyState: 1, currentTime: 150 });
    fire('seeking');
    fire('waiting');
    await run(STALL_GRACE_MS + 50);   // FN-05: held once past the window
    expect(deviceRunning()).toBe(false);
    await run(4800);
    const n = sentToDevice.length;
    setEl({ seeking: false, readyState: 4 });
    fire('seeked');
    fire('canplay');
    fire('playing');
    await run(1000);
    expect(sentToDevice.slice(n).map((e) => e.cmd), 'what the seek\'s end sent the device').toEqual(['play']);
    expect(Math.abs(plays().at(-1).start - 150_000)).toBeLessThan(100);
    expect(Math.abs(deviceTimeMs() - el().currentTime * 1000)).toBeLessThan(150);
  });

  // Row T, the take-over: the window's seek to the hand-over spot lands while
  // it is still paused, and it plays straight away. The engine's stop for that
  // seek was still travelling when the window's 'playing' anchored the device,
  // and the seek then played it again.
  it('row T: a seek that lands just before the window plays — ONE play, at the new spot', async () => {
    await buildMain({ at: 30 });
    setEl({ paused: true, readyState: 4, seeking: false, error: null, currentTime: 35 });
    const n = sentToDevice.length;
    fire('seeked');
    setEl({ paused: false });
    fire('play');
    fire('playing');
    await run(1000);
    const after = sentToDevice.slice(n);
    expect(after.filter((e) => e.cmd === 'play'), 'plays sent for one seek and one start').toHaveLength(1);
    expect(after.at(-1).cmd).toBe('play');
    expect(Math.abs(plays().at(-1).start - 35_000)).toBeLessThan(100);
    expect(Math.abs(deviceTimeMs() - el().currentTime * 1000)).toBeLessThan(150);
  });

  it('a time that stops with no event at all is caught within about a second', async () => {
    await buildMain({ at: 20 });
    await windowPlays(20);
    await run(2000);
    frozen = true;                  // readyState 4, paused false, no event
    await run(1500);
    expect(deviceRunning()).toBe(false);
    frozen = false;
    await run(500);
    expect(deviceRunning()).toBe(true);
  });
});

describe('FN-05: a stall or a seek in the window that is over inside the grace window sends no stop', () => {
  it('a 300 ms seek while playing: no stop, ONE play at the new spot', async () => {
    await buildMain({ at: 100 });
    await windowPlays(100);
    await run(3000);                    // past the first play's correction
    const n = sentToDevice.length;
    setEl({ seeking: true, readyState: 1, currentTime: 150 });
    fire('seeking');
    fire('waiting');
    await run(300);
    setEl({ seeking: false, readyState: 4 });
    fire('seeked');
    fire('canplay');
    fire('playing');
    await run(1000);
    expect(sentToDevice.slice(n).map((e) => e.cmd), 'what a seek inside the window sent').toEqual(['play']);
    expect(Math.abs(plays().at(-1).start - 150_000)).toBeLessThan(100);
  });

  it('a 200 ms starve while playing: nothing at all reaches the device (drift 200 ms re-anchors once, no stop)', async () => {
    await buildMain({ at: 40 });
    await windowPlays(40);
    await run(3000);
    const n = sentToDevice.length;
    setEl({ readyState: 2 });
    fire('waiting');
    await run(200);
    setEl({ readyState: 4 });
    fire('playing');
    await run(1000);
    const after = sentToDevice.slice(n).map((e) => e.cmd);
    expect(after.filter((c) => c === 'stop'), 'a stop for a 200 ms hiccup').toEqual([]);
    // 200 ms is past STALL_RESYNC_MS, so one re-anchor play, never stop + play.
    expect(after).toEqual(['play']);
    expect(Math.abs(deviceTimeMs() - el().currentTime * 1000)).toBeLessThan(150);
  });
});

describe('a Play in the window on a position still loading does not start the device ahead of it', () => {
  it('the window ticks "stalled" before its "play"; the device starts on "playing", once', async () => {
    await buildMain({ at: 30 });
    setEl({ paused: false, readyState: 1, seeking: false, error: null, currentTime: 30 });
    fire('play');
    await vi.advanceTimersByTimeAsync(0);
    const iTick = up.findIndex((m) => m.type === PLAYERWIN.TIME_TICK);
    const iPlay = up.findIndex((m) => m.type === PLAYERWIN.VIDEO_EVENT && m.event === 'play');
    expect(iTick).toBeGreaterThanOrEqual(0);
    expect(iTick).toBeLessThan(iPlay);
    expect(up[iTick]).toMatchObject({ paused: false, stalled: true });
    await run(2000);
    expect(plays().length, 'the device started before the picture').toBe(0);
    setEl({ readyState: 4 });
    fire('playing');
    await vi.advanceTimersByTimeAsync(0);
    expect(plays().length).toBe(1);
  });
});

describe('main\'s Play/Pause toggle during a stall pauses the window', () => {
  it('the proxy reads paused for the devices, but the toggle asks the playing window to PAUSE', async () => {
    await buildMain({ at: 50 });
    await windowPlays(50);
    await run(1000);
    setEl({ readyState: 2 });
    fire('waiting');
    await vi.advanceTimersByTimeAsync(0);
    expect(app._playerWinProxy.paused).toBe(true);
    app._playerWindowPlayback('toggle');
    expect(toPopout.filter((m) => m.type === PLAYERWIN.SET_PLAY_STATE).at(-1)).toMatchObject({ paused: true });
  });
});
