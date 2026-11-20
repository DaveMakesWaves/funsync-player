/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// N-01 for the OTHER cloud-clock device. The Autoblow Ultra / VacuGlide play
// an uploaded script on their own clock, exactly like the Handy's HSSP, and
// AutoblowSync bound the same four events, so a stall that fires no 'pause'
// (a starved source, a seek, a media error, a clock that just stops) left it
// running ahead of a frozen picture too. Found by reading while fixing the
// Handy (2026-11-16); the vault's rule: when you fix a device-lifecycle bug,
// check the other cloud-upload device for the same shape.
//
// FN-05 (2026-11-16): the hold now begins STALL_GRACE_MS after the picture
// stops (short hiccups: stall-grace.test.js).
//
// REAL AutoblowSync over the REAL AutoblowManager; only the IPC to main is a
// fake (no token, nothing leaves the test). It records each start / stop with
// its wall time, and the device's clock is replayed from those.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { STALL_GRACE_MS } from '../../renderer/js/playback-stall.js';

let sent;
const deviceRunning = () => sent.length > 0 && sent[sent.length - 1].cmd === 'start';
function deviceTimeMs(wall = performance.now()) {
  let run = null; let stoppedAt = null;
  for (const e of sent) {
    if (e.cmd === 'start') run = e;
    else { if (run) stoppedAt = run.at + (e.wall - run.wall); run = null; }
  }
  return run ? run.at + (wall - run.wall) : stoppedAt;
}
const starts = () => sent.filter((e) => e.cmd === 'start');

class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { paused: true, seeking: false, readyState: 4, error: null, currentTime: 0 });
  }

  fire(type) { this.dispatchEvent(new Event(type)); }
}
const moving = (v, h) => !v.paused && !v.seeking && v.readyState >= 3 && !v.error && !h.frozen;

function build({ at = 0, paused = true, readyState = 4 } = {}) {
  const manager = new AutoblowManager();
  manager._connected = true;
  manager._scriptUploaded = true;
  const video = new FakeVideo();
  Object.assign(video, { currentTime: at, paused, readyState });
  const player = { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } };
  const sync = new AutoblowSync({ videoPlayer: player, autoblowManager: manager });
  sync._scriptReady = true;
  sync.start();
  return { manager, video, sync, frozen: false };
}

async function run(h, ms, step = 50) {
  for (let t = 0; t < ms; t += step) {
    if (moving(h.video, h)) h.video.currentTime += step / 1000;
    await vi.advanceTimersByTimeAsync(step);
  }
}
async function playFromBuffer(h) {
  h.video.paused = false;
  h.video.fire('play');
  h.video.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}
async function starve(h) {
  h.video.readyState = 2;
  h.video.fire('waiting');
  await vi.advanceTimersByTimeAsync(0);
}
async function feed(h) {
  h.video.readyState = 4;
  h.video.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  sent = [];
  globalThis.window = {
    funsync: {
      autoblowSyncStart: vi.fn(async (at) => { sent.push({ cmd: 'start', wall: performance.now(), at }); return { success: true }; }),
      autoblowSyncStop: vi.fn(async () => { sent.push({ cmd: 'stop', wall: performance.now() }); return { success: true }; }),
    },
  };
});

afterEach(() => {
  delete globalThis.window;
  vi.useRealTimers();
});

describe('the Autoblow holds through a stall and resumes in step', () => {
  it('a starved source stops it past the grace window; nothing is sent during 15 s; "playing" restarts it at the frozen time', async () => {
    const h = build();
    await playFromBuffer(h);
    await run(h, 20_900);
    await starve(h);
    const frozenAt = h.video.currentTime * 1000;
    await run(h, STALL_GRACE_MS - 50);
    expect(deviceRunning(), 'stopped inside the grace window (FN-05)').toBe(true);
    await run(h, 100);
    expect(deviceRunning(), 'the Autoblow ran on through the stall').toBe(false);
    const n = sent.length;
    await run(h, 15_000);
    expect(sent.length).toBe(n);
    expect(Math.abs(deviceTimeMs() - frozenAt - STALL_GRACE_MS)).toBeLessThan(150);
    await feed(h);
    expect(deviceRunning()).toBe(true);
    expect(starts().at(-1).at).toBeCloseTo(frozenAt, 0);
  });

  it('a seek while playing on a slow source: stopped when it starts, started ONCE where it lands', async () => {
    const h = build({ at: 25 });
    await playFromBuffer(h);
    await run(h, 700);
    Object.assign(h.video, { seeking: true, readyState: 1, currentTime: 150 });
    h.video.fire('seeking');
    h.video.fire('waiting');
    await run(h, STALL_GRACE_MS + 50);   // FN-05: held once past the window
    expect(deviceRunning()).toBe(false);
    await run(h, 4800);
    const before = starts().length;
    Object.assign(h.video, { seeking: false, readyState: 2 });
    h.video.fire('seeked');
    await vi.advanceTimersByTimeAsync(0);
    expect(starts().length, 'started on a picture still loading').toBe(before);
    await feed(h);
    expect(starts().length).toBe(before + 1);
    expect(starts().at(-1).at).toBe(150_000);
  });

  it('a clock that stops with no event is caught by the stall watch, and resumed when it moves', async () => {
    const h = build({ at: 10 });
    await playFromBuffer(h);
    await run(h, 2000);
    h.frozen = true;
    await run(h, 1600);
    expect(deviceRunning()).toBe(false);
    h.frozen = false;
    await run(h, 600);
    expect(deviceRunning()).toBe(true);
    expect(Math.abs(deviceTimeMs() - h.video.currentTime * 1000)).toBeLessThan(400);
  });

  it('start() on a video still loading waits for its "playing"', async () => {
    const h = build({ paused: false, readyState: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(starts().length).toBe(0);
    await feed(h);
    expect(starts().length).toBe(1);
  });

  it('a network "stalled" with frames still in the buffer changes nothing', async () => {
    const h = build();
    await playFromBuffer(h);
    await run(h, 1000);
    h.video.fire('stalled');
    await run(h, 2000);
    expect(deviceRunning()).toBe(true);
    expect(sent.filter((e) => e.cmd === 'stop').length).toBe(0);
  });

  it('a seek with no stall still stops and restarts at the new position (unchanged)', async () => {
    const h = build({ at: 5 });
    await playFromBuffer(h);
    await run(h, 500);
    h.video.currentTime = 60;
    h.video.fire('seeked');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.slice(-2).map((e) => e.cmd)).toEqual(['stop', 'start']);
    expect(starts().at(-1).at).toBe(60_000);
  });
});
