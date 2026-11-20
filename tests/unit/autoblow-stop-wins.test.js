/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A stop always wins over a late start, on the Autoblow too (N-01 fix-up
// review, 2026-11-16). Every syncStart / syncStop is its own IPC call and its
// own HTTP request in main (electron/main.js autoblow-sync-start / -stop), so
// nothing orders them: the cloud applies them in the order they ARRIVE. The
// reviewer's scratch run (review/t/autoblow-late-start.test.js) with the REAL
// classes: a start sent on 'playing' answered in 1.5 s, a stall 0.6 s later
// sent a stop that arrived at 0.7 s, and the cloud saw 'stop@700
// start(20000)@1500': the device ran through the whole 8 s stall on a frozen
// picture. The same shape for a pause during a slow start (also in v0.9.2:
// AutoblowSync had no generation at all).
//
// FN-05 (2026-11-16): a stall's stop now goes STALL_GRACE_MS after the
// picture stops, so the stalls below run past that window (a hiccup inside
// it sends no stop at all: stall-grace.test.js).
//
// REAL AutoblowSync over the REAL AutoblowManager; only the IPC to main is a
// fake, and it behaves like the cloud: each command is APPLIED when it
// arrives (after its own latency) and answered then. The device replays its
// clock from the applied commands, in arrival order. No token, nothing
// leaves the test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';

let applied;          // [{ cmd: 'start'|'stop', wall, at }] in ARRIVAL order
let latency;          // { start: [ms, ...], stop: [ms, ...] } per call, else 100

const nextLatency = (cmd) => (latency[cmd].length ? latency[cmd].shift() : 100);
const deviceRunning = () => applied.length > 0 && applied[applied.length - 1].cmd === 'start';
function deviceTimeMs(wall = performance.now()) {
  let run = null; let stoppedAt = null;
  for (const e of applied) {
    if (e.cmd === 'start') run = e;
    else { if (run) stoppedAt = run.at + (e.wall - run.wall); run = null; }
  }
  return run ? run.at + (wall - run.wall) : stoppedAt;
}
const count = (cmd) => applied.filter((e) => e.cmd === cmd).length;

class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { paused: true, seeking: false, readyState: 4, error: null, currentTime: 0, ended: false });
  }

  fire(type) { this.dispatchEvent(new Event(type)); }
}

function build({ at = 20 } = {}) {
  const manager = new AutoblowManager();
  manager._connected = true;
  manager._scriptUploaded = true;
  const video = new FakeVideo();
  video.currentTime = at;
  const player = { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } };
  const sync = new AutoblowSync({ videoPlayer: player, autoblowManager: manager });
  sync._scriptReady = true;
  sync.start();
  return { manager, video, sync };
}

const moving = (v) => !v.paused && !v.seeking && v.readyState >= 3 && !v.error;
async function run(h, ms, step = 50, each = null) {
  for (let t = 0; t < ms; t += step) {
    if (moving(h.video)) h.video.currentTime += step / 1000;
    await vi.advanceTimersByTimeAsync(step);
    if (each) each();
  }
}
async function play(h) {
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
  applied = [];
  latency = { start: [], stop: [] };
  const arrive = (cmd, at) => new Promise((resolve) => {
    setTimeout(() => {
      applied.push({ cmd, wall: performance.now(), at });
      resolve({ success: true });
    }, nextLatency(cmd));
  });
  globalThis.window = {
    funsync: {
      autoblowSyncStart: vi.fn((at) => arrive('start', at)),
      autoblowSyncStop: vi.fn(() => arrive('stop')),
    },
  };
});

afterEach(() => {
  delete globalThis.window;
  vi.useRealTimers();
});

describe('the Autoblow: a stop always wins over a late start', () => {
  it('a start that lands after the stall\'s stop is undone, and the device stands for the rest of the stall', async () => {
    latency.start.push(1500);           // the start sent on 'playing' is slow
    const h = build();
    await play(h);
    await run(h, 600);
    await starve(h);                    // its stop arrives at 0.7 s, BEFORE the start
    const frozenAt = h.video.currentTime * 1000;
    let ranDuringStall = 0;
    await run(h, 1100);                 // the late start lands at 1.5 s; the re-stop 0.1 s later
    await run(h, 6800, 50, () => { if (deviceRunning()) ranDuringStall++; });
    expect(ranDuringStall, 'the device ran through the stall on a frozen picture').toBe(0);
    // In arrival order: the stall's stop, the late start, the stop again
    // (the device ran 0.1 s between the last two).
    expect(applied.map((e) => e.cmd)).toEqual(['stop', 'start', 'stop']);

    await feed(h);                      // the stall ends: one start, at the frozen time
    await run(h, 200);
    expect(deviceRunning()).toBe(true);
    expect(applied.at(-1).at).toBeCloseTo(frozenAt, 0);
  });

  it('a pause during a slow start: the start is undone when it lands', async () => {
    latency.start.push(1500);
    const h = build();
    await play(h);
    await run(h, 300);
    h.video.paused = true;
    h.video.fire('pause');
    let ranWhilePaused = 0;
    await run(h, 1400);                 // the start lands at 1.5 s
    await run(h, 3000, 50, () => { if (deviceRunning()) ranWhilePaused++; });
    expect(ranWhilePaused, 'the late start ran the device under a paused picture').toBe(0);
    expect(deviceRunning()).toBe(false);
  });

  it('the engine stopped while a start travels (a pop-out take-over, an Edge hold): it is undone', async () => {
    latency.start.push(1500);
    const h = build();
    await play(h);
    await run(h, 300);
    h.sync.stop();
    await run(h, 2000);
    expect(deviceRunning(), 'a start sent before stop() ran the device after it').toBe(false);
  });

  it('a late start whose stall is already over, and the newer start already answered: anchored again where the picture is', async () => {
    latency.start.push(2500, 100);      // A slow; B (the resume's) quick
    const h = build();
    await play(h);                      // A leaves
    await run(h, 600);
    await starve(h);                    // past the 500 ms window its stop goes at 1.1 s
    await run(h, 900);
    await feed(h);                      // B leaves at 1.5 s, lands at 1.6 s
    await run(h, 1500);                 // A lands at 2.5 s, AFTER B: the device is on A's old time
    // The device runs, and in step with the picture: not stopped (the resume
    // owns it) and not left 1 s behind on the stale start.
    expect(deviceRunning()).toBe(true);
    expect(count('stop')).toBe(1);
    expect(Math.abs(deviceTimeMs() - h.video.currentTime * 1000)).toBeLessThan(250);
  });

  it('a late start while the newer start is still travelling: stands down, no stop, no extra start (control)', async () => {
    latency.start.push(2500, 2000);     // A slow; B slower still, lands at 3.5 s
    const h = build();
    await play(h);
    await run(h, 600);
    await starve(h);                    // past the 500 ms window its stop goes at 1.1 s
    await run(h, 900);
    await feed(h);                      // B leaves at 1.5 s; A lands at 2.5 s while B travels
    await run(h, 2500);
    expect(count('start')).toBe(2);
    expect(count('stop')).toBe(1);
    expect(deviceRunning()).toBe(true);
    expect(applied.at(-1).at).toBeCloseTo(20_600, 0);   // B's, the last to land
  });

  it('a start with nothing in its way sends nothing more (control)', async () => {
    const h = build();
    await play(h);
    await run(h, 3000);
    expect(applied.map((e) => e.cmd)).toEqual(['start']);
    h.video.paused = true;
    h.video.fire('pause');
    await run(h, 500);
    expect(applied.map((e) => e.cmd)).toEqual(['start', 'stop']);
  });
});
