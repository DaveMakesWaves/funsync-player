/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The pattern Test with a video open but PAUSED (device session 2026-11-19,
// step 27, also in v0.9.2): with an Intiface toy connected and ANY video open,
// every Test (Gap Filler / Orgasm Switch / Edge Hold drawers) was refused with
// "Stop the video first — it is already driving your devices", because the
// engines' isDriving() was true from the moment a video was bound, playing or
// not. A paused video sends nothing (its pause stopped the scheduler and sent
// stopAll / DSTOP), so the Test runs now; the moment the video plays, the Test
// hands the devices back; and a Test that ends while paused still turns the
// toy off (stopTestOutput used to skip that whenever a video was bound).
//
// The REAL ButtplugManager (SDK sends recorded), ButtplugSync, TCodeManager
// (UDP), TCodeSync and FillerTestPlayer, with a fake <video>.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { FillerTestPlayer } from '../../renderer/js/filler-test-player.js';

const stroke = (n = 480) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
// A 6 s pattern sample (what the drawer's Test plays).
const SAMPLE = Array.from({ length: 25 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 80 : 20 }));

class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { paused: true, seeking: false, readyState: 4, error: null, currentTime: 0, duration: 600 });
  }
  fire(type) { this.dispatchEvent(new Event(type)); }
}

let bpLog;
let lines;
let savedWindow;

function buttplugManager() {
  const mgr = new ButtplugManager();
  mgr._client = { stopAllDevices: vi.fn(async () => { bpLog.push(['stopAll']); }) };
  mgr._connected = true;
  const dev = (index, name, outputs) => ({ index, name, hasOutput: (t) => outputs.includes(t) });
  mgr._devices = new Map([
    [0, dev(0, 'Stroker', ['HwPositionWithDuration'])],
    [1, dev(1, 'Lovense Edge', ['Vibrate'])],
  ]);
  mgr.sendLinear = vi.fn(async (i, v) => { bpLog.push(['linear', i, v]); return { ok: true }; });
  mgr.sendVibrate = vi.fn(async (i, v) => { bpLog.push(['vibrate', i, v]); return { ok: true }; });
  return mgr;
}

async function rig() {
  const video = new FakeVideo();
  const player = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
  };
  const actions = stroke();
  const engine = { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions };
  const bp = new ButtplugSync({ videoPlayer: player, buttplugManager: buttplugManager(), funscriptEngine: engine });
  const tcode = new TCodeManager();
  expect(await tcode.connect('udp', { host: '127.0.0.1', port: 18099 })).toBe(true);
  const tc = new TCodeSync({ videoPlayer: player, tcodeManager: tcode, funscriptEngine: { get isLoaded() { return true; }, getActions: () => actions, getAuthoredActions: () => actions } });
  // A video opened and bound, as a normal open does: the engines are started
  // on load, before the first play.
  bp.start();
  tc.start();
  const test = new FillerTestPlayer({ buttplugSync: bp, tcodeSync: tc });
  const play = async (ms) => {
    video.paused = false;
    video.fire('play');
    video.fire('playing');
    for (let t = 0; t < ms; t += 16) { video.currentTime += 0.016; await vi.advanceTimersByTimeAsync(16); }
  };
  const pause = () => { video.paused = true; video.fire('pause'); };
  return { video, bp, tc, test, play, pause };
}

const since = (from) => bpLog.slice(from);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
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
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  };
});
afterEach(() => {
  globalThis.window = savedWindow;
  vi.useRealTimers();
});

describe('pattern Test with a video open but paused (device session step 27)', () => {
  it('a video opened and never played: the Test runs on the toy and the T-Code device', async () => {
    const r = await rig();
    expect(r.bp.isDriving()).toBe(false);
    expect(r.tc.isDriving()).toBe(false);
    expect(r.test.blockedByPlayback).toBe(false);
    const mark = bpLog.length;
    lines = [];
    expect(r.test.play(SAMPLE)).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(since(mark).some((e) => e[0] === 'vibrate' && e[1] === 1 && e[2] > 0), 'the vibrator is driven').toBe(true);
    expect(since(mark).some((e) => e[0] === 'linear' && e[1] === 0), 'the stroker is driven').toBe(true);
    expect(lines.some((l) => /(^| )L0\d{3}I\d+/.test(l)), 'the T-Code L0 is driven').toBe(true);
    r.test.stop();
  });

  it('played, then paused: the Test runs, and when it ends the vibrator is turned OFF', async () => {
    const r = await rig();
    await r.play(1000);
    r.pause();
    expect(r.test.blockedByPlayback).toBe(false);
    expect(r.test.play(SAMPLE)).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    const mark = bpLog.length;
    lines = [];
    r.test.stop();
    // stopTestOutput used to return early whenever a video was bound, leaving
    // a vibrate output holding its last level.
    expect(since(mark).some((e) => e[0] === 'stopAll'), 'stopAll on the Test\'s end').toBe(true);
    expect(lines[0]).toBe('DSTOP\n');
  });

  it('the video starts during a Test: the Test hands over at once, and does not stop the video\'s output', async () => {
    const r = await rig();
    const ends = [];
    r.test.onEnd = (reason) => ends.push(reason);
    expect(r.test.play(SAMPLE)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    const mark = bpLog.length;
    await r.play(400);
    expect(r.test.running).toBe(false);
    expect(ends).toEqual(['playback']);
    // The hand-over sends no stopAll (the video is driving now) ...
    expect(since(mark).filter((e) => e[0] === 'stopAll')).toEqual([]);
    // ... and the video's own output carries on.
    expect(r.bp.isDriving()).toBe(true);
    const after = bpLog.length;
    await r.play(400);
    expect(since(after).some((e) => e[0] === 'linear' || e[0] === 'vibrate')).toBe(true);
  });

  it('while the video PLAYS the Test is still refused (two writers on one device)', async () => {
    const r = await rig();
    await r.play(500);
    expect(r.bp.isDriving()).toBe(true);
    expect(r.tc.isDriving()).toBe(true);
    expect(r.test.blockedByPlayback).toBe(true);
    expect(r.test.play(SAMPLE)).toBe(false);
  });

  it('a buffering stall mid-play still counts as playing (the player is not paused)', async () => {
    const r = await rig();
    await r.play(500);
    r.video.fire('waiting');
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.test.blockedByPlayback).toBe(true);
    expect(r.test.play(SAMPLE)).toBe(false);
  });
});
