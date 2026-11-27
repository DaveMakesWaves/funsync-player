/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The move after a jump (Eroto #423, 2026-11-22): "the device moves to the
// new position at max speed, which is sometimes surprising, loud". After a
// seek (a gap skip, a click on the timeline), the end of Edge Hold or the
// Orgasm Switch / Edge Hold pattern starting, the first T-Code move took one
// tick (~16 ms) whatever the distance, and the Speed limit was skipped for it.
// Now it goes from where the device is (the manager's estimate) at the jump
// pace, and nothing else goes to that axis until it lands; a short hop still
// snaps. Asserted on the REAL TCodeManager's output lines (fake transport) and
// the REAL TCodeSync, and on the REAL OrgasmSwitch's frames.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { TCodeManager, REST_MOVE_MS } from '../../renderer/js/tcode-manager.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { jumpEaseMs, JUMP_MOVE_UNITS_PER_S, JUMP_EASE_MIN_UNITS, JUMP_EASE_MAX_MS } from '../../renderer/js/jump-ease.js';

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 600; }
}

let lines;
let savedWindow;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  lines = [];
  savedWindow = globalThis.window;
  globalThis.window = {
    funsync: {
      tcodeConnect: async () => ({ success: true }),
      onTcodeDisconnected: () => () => {},
      tcodeSend: async (line) => { lines.push({ at: performance.now(), line }); return true; },
      tcodeDisconnect: async () => {},
    },
  };
});
afterEach(() => {
  globalThis.window = savedWindow;
  vi.useRealTimers();
});

// L0 tokens sent, with the time each went out: { at, pos (0-100), ms }.
const l0 = () => lines.flatMap(({ at, line }) => line.trim().split(' ')
  .filter((p) => p.startsWith('L0'))
  .map((p) => { const [v, i] = p.slice(2).split('I'); return { at, pos: (Number(v) / 999) * 100, ms: i ? Number(i) : 0 }; }));

// A long hold at 10, then a long hold at 90: a seek from one to the other is
// a jump of 80 units; inside a hold the script itself never moves.
const HOLDS = [{ at: 0, pos: 10 }, { at: 4000, pos: 10 }, { at: 4100, pos: 90 }, { at: 9000, pos: 90 }, { at: 9100, pos: 10 }, { at: 20000, pos: 10 }];

async function rig({ actions = HOLDS, transport = 'udp' } = {}) {
  const tcode = new TCodeManager();
  const opts = transport === 'serial' ? { path: 'COM3', baudRate: 115200 } : { host: '127.0.0.1', port: 18099 };
  expect(await tcode.connect(transport, opts)).toBe(true);
  const video = new FakeVideo();
  const player = { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } };
  const engine = { get isLoaded() { return true; }, getActions: () => actions, getAuthoredActions: () => actions };
  const sync = new TCodeSync({ videoPlayer: player, tcodeManager: tcode, funscriptEngine: engine });
  const play = async (ms) => {
    if (video.paused) { video.paused = false; video.dispatchEvent(new Event('playing')); }
    for (let t = 0; t < ms; t += 16) {
      video.currentTime += 0.016;
      await vi.advanceTimersByTimeAsync(16);
    }
  };
  const seek = (sec) => {
    video.dispatchEvent(new Event('seeking'));
    video.currentTime = sec;
    video.dispatchEvent(new Event('seeked'));
  };
  return { sync, tcode, video, play, seek };
}

describe('jumpEaseMs', () => {
  it('a short hop snaps; a jump takes its distance at the jump pace; capped; unknown = the middle', () => {
    expect(jumpEaseMs(40, 40 + JUMP_EASE_MIN_UNITS - 0.1)).toBe(0);
    expect(jumpEaseMs(10, 90)).toBe(Math.round((80 / JUMP_MOVE_UNITS_PER_S) * 1000));   // 533
    expect(jumpEaseMs(0, 100, 10)).toBe(JUMP_EASE_MAX_MS);
    expect(jumpEaseMs(null, 90)).toBe(jumpEaseMs(50, 90));
    expect(jumpEaseMs(10, NaN)).toBe(0);
  });
});

describe('TCodeManager.estimatePosition', () => {
  it('null until moved; a timed move goes in a straight line; a bare frame is there at once', async () => {
    const t = new TCodeManager();
    await t.connect('udp', { host: '127.0.0.1', port: 18099 });
    expect(t.estimatePosition('L0')).toBeNull();
    t.sendAxes({ L0: 20 });
    expect(t.estimatePosition('L0')).toBe(20);
    t.sendAxes({ L0: 80 }, undefined, { L0: 600 });
    await vi.advanceTimersByTimeAsync(300);
    expect(t.estimatePosition('L0')).toBeCloseTo(50, 5);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.estimatePosition('L0')).toBe(80);
  });

  it('serial DSTOP halts in place; the UDP rest frame glides to the middle; a disconnect forgets', async () => {
    const s = new TCodeManager();
    await s.connect('serial', { path: 'COM3', baudRate: 115200 });
    s.sendAxes({ L0: 0 });
    s.sendAxes({ L0: 100 }, undefined, { L0: 1000 });
    await vi.advanceTimersByTimeAsync(250);
    s.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.estimatePosition('L0')).toBeCloseTo(25, 5);

    const u = new TCodeManager();
    await u.connect('udp', { host: '127.0.0.1', port: 18099 });
    u.sendAxes({ L0: 90 });
    u.stop();
    await vi.advanceTimersByTimeAsync(REST_MOVE_MS / 2);
    expect(u.estimatePosition('L0')).toBeCloseTo(70, 5);
    await u.disconnect();
    expect(u.estimatePosition('L0')).toBeNull();
  });
});

describe('TCodeSync: the move after a seek', () => {
  it('a far seek (a gap skip, a timeline click) eases there at the jump pace, and nothing else goes to L0 until it lands', async () => {
    const r = await rig();
    r.sync.start();
    await r.play(1000);                          // sitting in the hold at 10
    const before = r.tcode.estimatePosition('L0');
    expect(before).toBeCloseTo(10, 0);
    lines = [];
    r.seek(5);                                   // into the hold at 90
    await r.play(16);
    const [first] = l0();
    expect(first.pos).toBeCloseTo(90, 0);
    const ease = jumpEaseMs(before, first.pos);
    expect(ease).toBeGreaterThan(500);
    expect(first.ms).toBe(ease);                 // was one tick (~16 ms): "max speed"
    await r.play(ease - 40);
    expect(l0().filter((x) => x.at > first.at)).toEqual([]);
  });

  it('a mid-stroke seek aims where the script will be when it lands, so the script carries on from there with no catch-up slam (found in the tests)', async () => {
    const r = await rig({ actions: Array.from({ length: 120 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 })) });
    r.sync.start();
    await r.play(400);
    lines = [];
    r.seek(10.125);                              // mid-stroke, far from where it was
    await r.play(16);
    const [first] = l0();
    await r.play(first.ms + 600);
    // A keyframe falls inside the move: nothing interrupts it before it lands.
    expect(l0().filter((x) => x.at > first.at && x.at < first.at + first.ms)).toEqual([]);
    const after = l0().filter((x) => x.at >= first.at + first.ms);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => x.ms > r.sync._tickIntervalMs)).toBe(true);   // keyframe-paced moves
    // and the first of them is no catch-up slam: no faster than the script's own strokes (80 units in 250 ms)
    const speed = (from, to) => (Math.abs(to.pos - from.pos) / to.ms) * 1000;
    expect(speed(first, after[0])).toBeLessThan(400);
  });

  it('a short hop still snaps over one tick (a resume stays exact)', async () => {
    const r = await rig();
    r.sync.start();
    await r.play(1000);
    lines = [];
    r.seek(2);                                   // still the hold at 10
    await r.play(16);
    const [first] = l0();
    expect(first.ms).toBeLessThanOrEqual(r.sync._tickIntervalMs);
  });

  it('a Speed limit slower than the jump pace sets the pace', async () => {
    const r = await rig();
    r.sync.setSpeedLimit(60);
    r.sync.start();
    await r.play(1000);
    const before = r.tcode.estimatePosition('L0');
    lines = [];
    r.seek(5);
    await r.play(16);
    const [first] = l0();
    expect(first.ms).toBe(jumpEaseMs(before, first.pos, 60));
  });
});

describe('OrgasmSwitch / Edge Hold pattern: its first T-Code move', () => {
  const PATTERN = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }];
  const plan = () => ({ mode: 'multi', main: PATTERN, loopMs: 2000, tcodeAxes: { L0: PATTERN, V0: [{ at: 0, pos: 20 }, { at: 2000, pos: 80 }] }, vib: null, bpMode: 'keep', bpRoutes: null });

  function sw(tcodeManager) {
    const clock = { t: 0 };
    const os = new OrgasmSwitch({ buttplugManager: null, tcodeManager, handyManager: null, now: () => clock.t });
    os.setTimerImpl(() => 1, () => {});
    os.loadPlan(plan());
    return { os, clock };
  }

  it('eases from where the device is to where the pattern will be when it lands, sends no T-Code until then, then streams on', () => {
    const tc = { connected: true, sendAxes: vi.fn(), estimatePosition: vi.fn(() => 100) };
    const { os, clock } = sw(tc);
    os.activate();                               // t = 0: the pattern is at 0, the device at 100
    const [axes, , intervals] = tc.sendAxes.mock.calls[0];
    const ease = jumpEaseMs(100, 0);             // 667
    expect(intervals.L0).toBe(ease);
    expect(axes.L0).toBeCloseTo((ease / 1000) * 100, 0);   // the pattern at t = ease
    expect(intervals.V0).toBeUndefined();        // an intensity is never eased
    expect(axes.V0).toBeCloseTo(20, 0);
    for (const t of [100, 300, ease - 20]) { clock.t = t; os._tick(); }
    expect(tc.sendAxes).toHaveBeenCalledTimes(1);
    clock.t = ease + 40; os._tick();
    expect(tc.sendAxes).toHaveBeenCalledTimes(2);
    const [next, , nextIntervals] = tc.sendAxes.mock.calls[1];
    expect(next.L0).toBeCloseTo(((ease + 40) / 1000) * 100, 0);
    expect(nextIntervals).toBeUndefined();       // bare frames again
  });

  it('a device already near the pattern, or a manager that cannot say where it is, starts at once as before', () => {
    const near = { connected: true, sendAxes: vi.fn(), estimatePosition: vi.fn(() => 3) };
    sw(near).os.activate();
    expect(near.sendAxes.mock.calls[0][2]).toBeUndefined();
    const old = { connected: true, sendAxes: vi.fn() };
    sw(old).os.activate();
    expect(old.sendAxes.mock.calls[0][2]).toBeUndefined();
  });
});
