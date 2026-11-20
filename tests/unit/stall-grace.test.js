/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FN-05 (Dave 2026-11-16): a grace window on stalls, so short hiccups do not
// make the devices stutter. N-01 stopped the Handy (and the Autoblow) the
// instant the picture stalled and FN-02 turned every sustained Buttplug /
// T-Code output off the same way, so a 'waiting' of a few frames (Chromium
// fires one on every seek while playing, and on a drive that blinks) was a
// stop and a play 100 ms apart. Agreed with Dave: wait STALL_GRACE_MS (500)
// before stopping; a hiccup over inside the window sends no stop, and one
// re-anchor play only once the drift it left (summed over hiccups, per
// anchor) reaches STALL_RESYNC_MS (100); a seek that finishes inside it sends
// one play at the new position; past it, hold as before. Pause, end, error,
// a video change and Stop stay instant and always win.
//
// What runs is REAL: SyncEngine over the REAL HandyManager (fake SDK legs,
// recorded with their wall time so the device's own clock can be replayed),
// AutoblowSync over the REAL AutoblowManager (fake IPC), ButtplugSync over
// the REAL ButtplugManager (its SDK sends record), TCodeSync over the REAL
// TCodeManager (the lines that would go down the wire), the REAL
// VRPlaybackProxy, and the shared StallGrace / StallHold. Fake timers; no
// device, no cloud, no key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  getOffset: vi.fn().mockResolvedValue({ offset: 0 }),
  setStrokeZone: vi.fn().mockResolvedValue(undefined),
  getStrokeZone: vi.fn().mockResolvedValue({ min: 0, max: 100 }),
  setHsspLoop: vi.fn().mockResolvedValue(undefined),
  setMode: vi.fn().mockResolvedValue(undefined),
  hdsp: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  API: { get: { connected: vi.fn().mockResolvedValue({ connected: true }) } },
};

vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: vi.fn().mockReturnValue(mockHandy),
  getEstimatedServerTime: vi.fn().mockReturnValue(0),
  uploadDataToServer: vi.fn().mockResolvedValue('https://scripts.local/a.csv'),
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { VRPlaybackProxy } from '../../renderer/js/vr-playback-proxy.js';
import {
  STALL_GRACE_MS, STALL_RESYNC_MS, StallGrace, StallHold, stallSummary, proxyStallAgeMs,
} from '../../renderer/js/playback-stall.js';

// --- the picture -------------------------------------------------------------

class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { paused: true, seeking: false, readyState: 4, error: null, currentTime: 0, ended: false, duration: 600 });
  }

  fire(type) { this.dispatchEvent(new Event(type)); }
}
const playerOf = (video) => ({
  video,
  get paused() { return video.paused; },
  get currentTime() { return video.currentTime; },
  get duration() { return video.duration; },
});
const moving = (v) => !v.paused && !v.seeking && v.readyState >= 3 && !v.error;

/** Let `ms` of wall time pass in `step` ms steps; the picture moves only while it can. */
async function run(video, ms, step = 20) {
  for (let t = 0; t < ms; t += step) {
    if (moving(video)) video.currentTime += step / 1000;
    await vi.advanceTimersByTimeAsync(step);
  }
}
async function startPlaying(video) {
  video.paused = false;
  video.fire('play');
  video.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}
/** A hiccup: 'waiting' at readyState 2, `ms` later readyState 4 and 'playing'. */
async function hiccup(video, ms) {
  video.readyState = 2;
  video.fire('waiting');
  await run(video, ms);
  video.readyState = 4;
  video.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}
/** A seek while playing to `toSec` that lands `ms` later (Chromium: seeking + waiting, then seeked + playing). */
async function seek(video, toSec, ms, { waiting = true } = {}) {
  Object.assign(video, { seeking: true, readyState: 1, currentTime: toSec });
  video.fire('seeking');
  if (waiting) video.fire('waiting');
  await run(video, ms);
  Object.assign(video, { seeking: false, readyState: 4 });
  video.fire('seeked');
  if (waiting) video.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}
async function pause(video) {
  video.paused = true;
  video.fire('pause');
  await vi.advanceTimersByTimeAsync(0);
}

let logs;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.clearAllMocks();
  mockHandy.getState.mockReturnValue({ info: { fwVersion: '4.2.1' }, mode: 1, hssp: { scriptSet: true } });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const stallLines = (prefix) => logs.filter((l) => l.startsWith(`${prefix} stall `));

// --- the Handy (HSSP) ----------------------------------------------------------

describe('FN-05 the Handy: a grace window on every stall', () => {
  let sent;   // [{ cmd, wall, start }]
  const cmds = (from = 0) => sent.slice(from).map((e) => e.cmd);
  function deviceTimeMs(wall = performance.now()) {
    let runE = null; let stoppedAt = null;
    for (const e of sent) {
      if (e.cmd === 'play') runE = e;
      else { if (runE) stoppedAt = runE.start + (e.wall - runE.wall); runE = null; }
    }
    return runE ? runE.start + (wall - runE.wall) : stoppedAt;
  }

  async function handy({ at = 10 } = {}) {
    sent = [];
    mockHandy.hsspPlay.mockImplementation(async (start) => { sent.push({ cmd: 'play', wall: performance.now(), start }); return { result: 0 }; });
    mockHandy.hsspStop.mockImplementation(async () => { sent.push({ cmd: 'stop', wall: performance.now() }); return { result: 0 }; });
    const manager = new HandyManager();
    await manager.init();
    Object.assign(manager, { _connected: true, _connectionKey: 'TESTKEY01', _mode: 1 });
    const video = new FakeVideo();
    video.currentTime = at;
    const engine = new SyncEngine({ videoPlayer: playerOf(video), handyManager: manager, funscriptEngine: { isLoaded: true } });
    engine._scriptReady = true;
    engine.onStopFailed = vi.fn();
    engine.start();
    await startPlaying(video);
    await run(video, 3000);   // past the first play's 2.5 s correction
    return { video, engine, manager, mark: sent.length };
  }

  it('a 60 ms hiccup sends nothing at all', async () => {
    const h = await handy();
    await hiccup(h.video, 60);
    await run(h.video, 1500);
    expect(cmds(h.mark), 'a stop / play for a 60 ms hiccup').toEqual([]);
  });

  it('a 200 ms hiccup: no stop, ONE re-anchor play at the picture\'s time (its 200 ms drift is past STALL_RESYNC_MS)', async () => {
    expect(STALL_RESYNC_MS).toBe(100);
    const h = await handy();
    await hiccup(h.video, 200);
    const resumedAt = Math.round(h.video.currentTime * 1000);
    await run(h.video, 1500);
    expect(cmds(h.mark)).toEqual(['play']);
    expect(sent.at(-1).start).toBe(resumedAt);
    expect(Math.abs(deviceTimeMs() - h.video.currentTime * 1000)).toBeLessThan(60);
  });

  it('repeated 60 ms hiccups re-anchor ONCE, when their total crosses 100 ms; a fresh anchor starts a new total', async () => {
    const h = await handy();
    await hiccup(h.video, 60);
    await run(h.video, 400);
    expect(cmds(h.mark), 'the first 60 ms').toEqual([]);
    await hiccup(h.video, 60);              // 120 ms in total since the anchor
    await run(h.video, 400);
    expect(cmds(h.mark)).toEqual(['play']);
    await hiccup(h.video, 60);              // 60 ms since that re-anchor
    await run(h.video, 400);
    expect(cmds(h.mark), 'the re-anchor did not start a new total').toEqual(['play']);
    await hiccup(h.video, 60);              // 120 ms again
    await run(h.video, 400);
    expect(cmds(h.mark)).toEqual(['play', 'play']);
    expect(Math.abs(deviceTimeMs() - h.video.currentTime * 1000)).toBeLessThan(60);
  });

  it('a 300 ms seek while playing: no stop, ONE play at the new position', async () => {
    const h = await handy({ at: 25 });
    await seek(h.video, 150, 300);
    await run(h.video, 1000);
    expect(cmds(h.mark)).toEqual(['play']);
    expect(sent.at(-1).start).toBe(150_000);
    // ...and the seek's own 2.5 s correction afterwards, as before FN-05.
    await run(h.video, 2000);
    expect(cmds(h.mark)).toEqual(['play', 'play']);
  });

  it('a seek that never starved (no "waiting") and lands in 100 ms: ONE play from its "seeked", no stop', async () => {
    const h = await handy({ at: 25 });
    await seek(h.video, 90, 100, { waiting: false });
    await run(h.video, 1000);
    expect(cmds(h.mark)).toEqual(['play']);
    expect(sent.at(-1).start).toBe(90_000);
  });

  it('a 2 s stall: stop once the window has run out, then ONE play on "playing"', async () => {
    const h = await handy();
    const stallWall = performance.now();
    await hiccup(h.video, 2000);
    await run(h.video, 1000);
    expect(cmds(h.mark)).toEqual(['stop', 'play']);
    const stop = sent[h.mark];
    expect(stop.wall - stallWall).toBeGreaterThanOrEqual(STALL_GRACE_MS);
    expect(stop.wall - stallWall).toBeLessThan(STALL_GRACE_MS + 60);
  });

  it('a pause 200 ms into the window: an immediate stop, and nothing after (the timer never acts)', async () => {
    const h = await handy();
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h.video, 200);
    expect(cmds(h.mark)).toEqual([]);
    await pause(h.video);
    expect(cmds(h.mark), 'the pause waited for the window').toEqual(['stop']);
    await run(h.video, 3000);
    expect(cmds(h.mark), 'the grace timer acted after a pause').toEqual(['stop']);
  });

  it('stop() inside the window (a video change, Stop, a disconnect): the timer never acts', async () => {
    const h = await handy();
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h.video, 200);
    h.engine.stop();
    await run(h.video, 3000);
    expect(cmds(h.mark)).toEqual([]);
  });

  it('an error does not wait for the window: the stop goes at once', async () => {
    const h = await handy();
    h.video.error = { code: 2 };
    h.video.fire('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(cmds(h.mark)).toEqual(['stop']);
  });

  it('an error inside an open window holds at once too', async () => {
    const h = await handy();
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h.video, 100);
    h.video.error = { code: 2 };
    h.video.fire('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(cmds(h.mark)).toEqual(['stop']);
  });

  it('a Play on a spot still loading after a pause: the stall window does not swallow the first play', async () => {
    const h = await handy();
    await pause(h.video);
    const n = sent.length;
    h.video.paused = false;
    h.video.readyState = 1;
    h.video.fire('play');
    h.video.fire('waiting');
    await run(h.video, 150);              // inside the window
    h.video.readyState = 4;
    h.video.fire('playing');
    await run(h.video, 500);
    expect(cmds(n), 'the device never started').toEqual(['play']);
  });

  it('a resync() inside the window waits for the picture, then plays once', async () => {
    const h = await handy();
    await h.engine._handlePause();        // the Orgasm Switch took the device: stopped
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h.video, 100);
    expect(await h.engine.resync()).toBe(false);
    const n = sent.length;
    await run(h.video, 100);
    h.video.readyState = 4;
    h.video.fire('playing');
    await run(h.video, 500);
    expect(cmds(n)).toEqual(['play']);
  });

  it('one log line per stall: its length, held or not, re-anchored or not', async () => {
    const h = await handy();
    await hiccup(h.video, 60);
    await run(h.video, 400);
    await hiccup(h.video, 200);
    await run(h.video, 400);
    await hiccup(h.video, 1000);
    await run(h.video, 400);
    const lines = stallLines('[Sync]');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[Sync\] stall 60 ms \(waiting\), not held .*, no re-anchor, drift total 60 of 100 ms$/);
    expect(lines[1]).toMatch(/^\[Sync\] stall 200 ms \(waiting\), not held .*, re-anchored, drift total 260 of 100 ms$/);
    expect(lines[2]).toMatch(/^\[Sync\] stall 1000 ms \(waiting\), held .*, re-anchored, ended by playing$/);
    expect(lines.join('\n')).not.toMatch(/TESTKEY01|[A-Z]:\\/);
  });

  it('a headset stall (the proxy waited 2 s) is past the window: the stop goes when it is reported', async () => {
    const proxy = new VRPlaybackProxy();
    const player = { video: proxy, get currentTime() { return proxy.currentTime; }, get paused() { return proxy.paused; } };
    sent = [];
    mockHandy.hsspPlay.mockImplementation(async (start) => { sent.push({ cmd: 'play', wall: performance.now(), start }); return { result: 0 }; });
    mockHandy.hsspStop.mockImplementation(async () => { sent.push({ cmd: 'stop', wall: performance.now() }); return { result: 0 }; });
    const manager = new HandyManager();
    await manager.init();
    Object.assign(manager, { _connected: true, _connectionKey: 'TESTKEY01', _mode: 1 });
    const engine = new SyncEngine({ videoPlayer: player, handyManager: manager, funscriptEngine: { isLoaded: true } });
    engine._scriptReady = true;
    engine.start();
    let t = 0;
    let frozen = false;
    const feed = async (ms) => {
      for (let w = 0; w < ms; w += 100) {
        if (!frozen) t += 0.1;
        proxy.updateFromVR({ currentTime: t, duration: 600, playerState: 0, playbackSpeed: 1 });
        await vi.advanceTimersByTimeAsync(100);
      }
    };
    await feed(3000);
    frozen = true;
    let reportedAt = null;
    proxy.addEventListener('pause', () => { reportedAt = performance.now(); });
    await feed(2600);
    expect(reportedAt).not.toBe(null);
    expect(proxy.stallAgeMs).toBeGreaterThanOrEqual(STALL_GRACE_MS);
    const stop = sent.find((e) => e.cmd === 'stop');
    expect(stop, 'the Handy ran on under a stalled headset').toBeTruthy();
    expect(stop.wall - reportedAt, 'waited another grace window on top of the headset\'s 2 s').toBeLessThan(50);
    engine.stop();
  });
});

// --- the Autoblow --------------------------------------------------------------

describe('FN-05 the Autoblow follows the same window', () => {
  let sent;
  const cmds = (from = 0) => sent.slice(from).map((e) => e.cmd);
  let savedWindow;
  beforeEach(() => {
    sent = [];
    savedWindow = globalThis.window;
    globalThis.window = {
      funsync: {
        autoblowSyncStart: vi.fn(async (at) => { sent.push({ cmd: 'start', wall: performance.now(), at }); return { success: true }; }),
        autoblowSyncStop: vi.fn(async () => { sent.push({ cmd: 'stop', wall: performance.now() }); return { success: true }; }),
      },
    };
  });
  afterEach(() => { globalThis.window = savedWindow; });

  async function autoblow({ at = 10 } = {}) {
    const manager = new AutoblowManager();
    manager._connected = true;
    manager._scriptUploaded = true;
    const video = new FakeVideo();
    video.currentTime = at;
    const sync = new AutoblowSync({ videoPlayer: playerOf(video), autoblowManager: manager });
    sync._scriptReady = true;
    sync.start();
    await startPlaying(video);
    await run(video, 1000);
    return { video, sync, mark: sent.length };
  }

  it('a 60 ms hiccup sends nothing; a second one (120 ms in all) ONE re-anchor start, no stop', async () => {
    const h = await autoblow();
    await hiccup(h.video, 60);
    await run(h.video, 400);
    expect(cmds(h.mark)).toEqual([]);
    await hiccup(h.video, 60);
    await run(h.video, 400);
    expect(cmds(h.mark)).toEqual(['start']);
    expect(sent.at(-1).at).toBeCloseTo(h.video.currentTime * 1000 - 400, -1);
  });

  it('a 200 ms hiccup: ONE start, no stop', async () => {
    const h = await autoblow();
    await hiccup(h.video, 200);
    await run(h.video, 1000);
    expect(cmds(h.mark)).toEqual(['start']);
  });

  it('a 300 ms seek while playing: ONE start at the new position, no stop', async () => {
    const h = await autoblow({ at: 20 });
    await seek(h.video, 75, 300);
    await run(h.video, 1000);
    expect(cmds(h.mark)).toEqual(['start']);
    expect(sent.at(-1).at).toBe(75_000);
  });

  it('a 2 s stall: stop once past the window, then ONE start on "playing"', async () => {
    const h = await autoblow();
    const stallWall = performance.now();
    await hiccup(h.video, 2000);
    await run(h.video, 500);
    expect(cmds(h.mark)).toEqual(['stop', 'start']);
    expect(sent[h.mark].wall - stallWall).toBeGreaterThanOrEqual(STALL_GRACE_MS);
  });

  it('a pause 200 ms into the window: an immediate stop and nothing after', async () => {
    const h = await autoblow();
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h.video, 200);
    await pause(h.video);
    expect(cmds(h.mark)).toEqual(['stop']);
    await run(h.video, 2000);
    expect(cmds(h.mark)).toEqual(['stop']);
  });

  it('stop() inside the window: its own stop, then nothing from the timer', async () => {
    const h = await autoblow();
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h.video, 200);
    h.sync.stop();
    await run(h.video, 2000);
    expect(cmds(h.mark)).toEqual(['stop']);
  });

  it('logs one line per stall', async () => {
    const h = await autoblow();
    await hiccup(h.video, 60);
    await run(h.video, 300);
    await hiccup(h.video, 900);
    await run(h.video, 300);
    const lines = stallLines('[AutoblowSync]');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/stall 60 ms \(waiting\), not held .*, no re-anchor, drift total 60 of 100 ms/);
    expect(lines[1]).toMatch(/stall 900 ms \(waiting\), held .*, re-anchored, ended by playing/);
  });
});

// --- the FN-02 sustained-output hold (Buttplug, T-Code) --------------------------

describe('FN-05 the FN-02 sustained-output hold follows the same window', () => {
  let bpLog;
  let lines;
  let savedWindow;
  beforeEach(() => {
    bpLog = [];
    lines = [];
    savedWindow = globalThis.window;
    globalThis.window = {
      funsync: {
        tcodeConnect: async () => ({ success: true }),
        onTcodeDisconnected: () => () => {},
        tcodeSend: async (line) => { lines.push(line); return true; },
        tcodeDisconnect: async () => {},
      },
    };
  });
  afterEach(() => { globalThis.window = savedWindow; });

  const stroke = (n = 480) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));

  function buttplug(video) {
    const mgr = new ButtplugManager();
    mgr._client = { stopAllDevices: vi.fn(async () => { bpLog.push(['stopAll']); }) };
    mgr._connected = true;
    mgr._devices = new Map([
      [0, { index: 0, name: 'Stroker', hasOutput: (t) => t === 'HwPositionWithDuration' }],
      [1, { index: 1, name: 'Vibe', hasOutput: (t) => t === 'Vibrate' }],
    ]);
    mgr.sendLinear = vi.fn(async (i, v) => { bpLog.push(['linear', i, v]); return { ok: true }; });
    mgr.sendVibrate = vi.fn(async (i, v) => { bpLog.push(['vibrate', i, v]); return { ok: true }; });
    for (const m of ['sendOscillate', 'sendRotate', 'sendScalar']) mgr[m] = vi.fn(async () => ({ ok: true }));
    const actions = stroke();
    const sync = new ButtplugSync({
      videoPlayer: playerOf(video), buttplugManager: mgr,
      funscriptEngine: { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions },
    });
    sync.start();
    return { sync, mgr };
  }

  it('the fakes sit on the real class', () => {
    for (const m of ['sendLinear', 'sendVibrate', 'sendOscillate', 'sendRotate', 'sendScalar', 'stopAll', 'stopSustainedOutputs']) {
      expect(typeof ButtplugManager.prototype[m]).toBe('function');
    }
  });

  it('Buttplug: a 200 ms hiccup turns nothing off (no stopSustainedOutputs, no zero, no re-arm ramp)', async () => {
    const video = new FakeVideo();
    const { sync, mgr } = buttplug(video);
    await startPlaying(video);
    await run(video, 3000);
    const hold = vi.spyOn(mgr, 'stopSustainedOutputs');
    const ramp = sync._rampUpStartTime;
    const at = bpLog.length;
    await hiccup(video, 200);
    await run(video, 1000);
    expect(hold).not.toHaveBeenCalled();
    expect(bpLog.slice(at).filter((e) => e[0] === 'vibrate' && e[2] === 0)).toEqual([]);
    expect(sync._rampUpStartTime, 'the hiccup restarted the ramp').toBe(ramp);
    expect(bpLog.slice(at).some((e) => e[0] === 'stopAll')).toBe(false);
    sync.stop();
  });

  it('Buttplug: a 2 s stall turns the vibe off once the window has run out, and "playing" brings it back', async () => {
    const video = new FakeVideo();
    const { sync } = buttplug(video);
    await startPlaying(video);
    await run(video, 3000);
    const at = bpLog.length;
    video.readyState = 2;
    video.fire('waiting');
    await run(video, STALL_GRACE_MS - 40);
    expect(bpLog.slice(at).filter((e) => e[0] === 'vibrate' && e[2] === 0), 'off inside the window').toEqual([]);
    await run(video, 80);
    expect(bpLog.slice(at).filter((e) => e[0] === 'vibrate').at(-1)[2]).toBe(0);
    await run(video, 1500);
    video.readyState = 4;
    video.fire('playing');
    await run(video, 1000);
    expect(bpLog.slice(at).filter((e) => e[0] === 'vibrate').at(-1)[2]).toBeGreaterThan(0);
    sync.stop();
  });

  it('Buttplug: a pause inside the window stops everything at once (stopAll), and the window never fires after it', async () => {
    const video = new FakeVideo();
    const { sync, mgr } = buttplug(video);
    await startPlaying(video);
    await run(video, 3000);
    const hold = vi.spyOn(mgr, 'stopSustainedOutputs');
    const at = bpLog.length;
    video.readyState = 2;
    video.fire('waiting');
    await run(video, 200);
    await pause(video);
    expect(bpLog.slice(at).filter((e) => e[0] === 'stopAll')).toHaveLength(1);
    await run(video, 2000);
    expect(hold).not.toHaveBeenCalled();
    sync.stop();
  });

  async function tcode(video) {
    const manager = new TCodeManager();
    expect(await manager.connect('udp', { host: '127.0.0.1', port: 18099 })).toBe(true);
    const actions = stroke();
    const wave = actions.map((a, i) => ({ at: a.at, pos: i % 2 ? 80 : 60 }));
    const sync = new TCodeSync({
      videoPlayer: playerOf(video), tcodeManager: manager,
      funscriptEngine: { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions },
    });
    sync.setAxisActions('V0', wave);
    sync.start();
    return sync;
  }

  it('T-Code: a 200 ms hiccup sends no V0 off frame; a 2 s stall sends exactly one, past the window', async () => {
    const video = new FakeVideo();
    const sync = await tcode(video);
    await startPlaying(video);
    await run(video, 3000, 16);
    let at = lines.length;
    await hiccup(video, 200);
    await run(video, 1000, 16);
    expect(lines.slice(at).filter((l) => /V0000/.test(l)), 'V0 turned off for a 200 ms hiccup').toEqual([]);

    at = lines.length;
    video.readyState = 2;
    video.fire('waiting');
    await run(video, STALL_GRACE_MS - 40, 16);
    expect(lines.slice(at).filter((l) => /V0000/.test(l))).toEqual([]);
    await run(video, 1500, 16);
    expect(lines.slice(at).filter((l) => /V0000/.test(l))).toEqual(['V0000\n']);
    expect(lines.slice(at).some((l) => /DSTOP/.test(l))).toBe(false);
    sync.stop();
  });
});

// --- the shared pieces -----------------------------------------------------------

describe('StallGrace / StallHold (playback-stall.js)', () => {
  it('one exported constant each: STALL_GRACE_MS 500, STALL_RESYNC_MS 100', () => {
    expect(STALL_GRACE_MS).toBe(500);
    expect(STALL_RESYNC_MS).toBe(100);
  });

  it('the window expires once, after STALL_GRACE_MS, from a bare timer', async () => {
    const onExpire = vi.fn();
    const g = new StallGrace({ onExpire });
    expect(g.begin('waiting')).toBe(true);
    expect(g.open).toBe(true);
    await vi.advanceTimersByTimeAsync(STALL_GRACE_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith('waiting');
    expect(g.held).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('end() inside the window: the timer never acts (generation-guarded), and the stall\'s length is measured', async () => {
    const onExpire = vi.fn();
    const g = new StallGrace({ onExpire });
    g.begin('seeking');
    await vi.advanceTimersByTimeAsync(230);
    const ep = g.end();
    expect(ep).toEqual({ reason: 'seeking', lengthMs: 230, held: false, seeked: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('a stall already past the window when seen (a headset\'s, a frozen clock\'s) or an error starts held, with no timer', async () => {
    const onExpire = vi.fn();
    const g = new StallGrace({ onExpire });
    expect(g.begin('proxy', { ageMs: 2000 })).toBe(false);
    expect(g.held).toBe(true);
    expect(g.end().lengthMs).toBe(2000);
    expect(g.begin('error', { instant: true })).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(proxyStallAgeMs({ stallAgeMs: 2000 })).toBe(2000);
    expect(proxyStallAgeMs({ stalled: true })).toBe(0);
  });

  it('StallHold: onHold only after the window; clear() inside it ends the stall with no onHold, ever', async () => {
    const video = { paused: false, readyState: 2, seeking: false, error: null };
    const player = { video, get paused() { return video.paused; }, currentTime: 5 };
    const onHold = vi.fn();
    const hold = new StallHold({ getPlayer: () => player, onHold });
    expect(hold.enter('waiting')).toBe(true);
    expect(hold.pending).toBe('waiting');
    await vi.advanceTimersByTimeAsync(300);
    expect(hold.clear('playing')).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(onHold).not.toHaveBeenCalled();
    hold.enter('waiting');
    await vi.advanceTimersByTimeAsync(STALL_GRACE_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('stallSummary: length, held or not, re-anchored or not; no keys, no paths', () => {
    expect(stallSummary({ reason: 'waiting', lengthMs: 212.4, held: false, seeked: false }, { reanchored: true, driftMs: 212.4 }))
      .toBe('stall 212 ms (waiting), not held (inside the 500 ms window), re-anchored, drift total 212 of 100 ms');
    expect(stallSummary({ reason: 'seeking', lengthMs: 2000, held: true, seeked: true }, { endedBy: 'pause' }))
      .toBe('stall 2000 ms (seeking), held (past the 500 ms window), ended by pause');
  });
});
