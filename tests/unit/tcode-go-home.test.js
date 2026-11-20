/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The T-Code "Go home" button (#384 uhntiss: "a send-to-home function";
// #389 kissenpirat: "a Go To Home Position button"; Dave 2026-11-20: "can we
// impliment the t code return home stuff at least"). TCodeSync.goHome eases
// every enabled position axis to the middle of the user's own range in one
// timed frame and turns every intensity channel off. The real TCodeManager
// and TCodeSync on a fake transport (the FT-095 rig, tcode-unused-axis-home).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TCodeSync, GO_HOME_MOVE_MS } from '../../renderer/js/tcode-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';

const stroke = (n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
const wave = (lo, hi, n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? hi : lo }));

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 600; }
}

let lines;
let savedWindow;

async function rig({ transport = 'serial', connect = true } = {}) {
  const tcode = new TCodeManager();
  if (connect) {
    const opts = transport === 'serial' ? { path: 'COM3', baudRate: 115200 } : { host: '127.0.0.1', port: 18099 };
    expect(await tcode.connect(transport, opts)).toBe(true);
  }
  const video = new FakeVideo();
  const player = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
  };
  const actions = stroke();
  const engine = { get isLoaded() { return true; }, getActions: () => actions, getAuthoredActions: () => actions };
  const sync = new TCodeSync({ videoPlayer: player, tcodeManager: tcode, funscriptEngine: engine });
  const play = async (ms = 1500) => {
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    for (let t = 0; t < ms; t += 16) {
      video.currentTime += 0.016;
      await vi.advanceTimersByTimeAsync(16);
    }
  };
  const pause = () => { video.paused = true; video.dispatchEvent(new Event('pause')); };
  return { sync, tcode, video, play, pause };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
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
afterEach(() => {
  globalThis.window = savedWindow;
  vi.useRealTimers();
});

describe('T-Code Go home (#384, #389)', () => {
  it('one timed frame: every position axis to the middle over 2 s, every intensity channel off at once', async () => {
    const r = await rig();
    lines = [];
    const res = r.sync.goHome();
    expect(res.sent).toBe(true);
    expect(GO_HOME_MOVE_MS).toBe(2000);
    expect(lines).toEqual([
      'L0500I2000 L1500I2000 L2500I2000 R0500I2000 R1500I2000 R2500I2000 V0000 V1000 A0500I2000 A1000 A2000\n',
    ]);
    expect(res.positions).toEqual(['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'A0']);
    expect(res.intensities).toEqual(['V0', 'V1', 'A1', 'A2']);
  });

  it('home is the middle of the USER\'s range, through invert and cutoff; a disabled axis is left alone', async () => {
    const r = await rig();
    r.sync.setAxisRange('L0', 20, 60);          // middle of 20-60 = 40
    r.sync.setAxisRange('R1', 0, 40);
    r.sync.setAxisInverted('R1', true);         // 50 inverted is 50, then 0-40 -> 20
    r.sync.setAxisCutoff('R2', 60, 100);        // 50 held to the floor, 60
    r.sync.setAxisEnabled('L2', false);
    r.sync.setAxisEnabled('V1', false);
    lines = [];
    r.sync.goHome();
    const parts = lines[0].trim().split(' ');
    expect(parts).toContain('L0400I2000');
    expect(parts).toContain('R1200I2000');
    expect(parts).toContain('R2599I2000');
    expect(parts.some((p) => p.startsWith('L2')), 'a disabled axis is not moved').toBe(false);
    expect(parts.some((p) => p.startsWith('V1')), 'a disabled channel is not touched').toBe(false);
  });

  it('the same frame over UDP (no DSTOP, no bare centre frame)', async () => {
    const r = await rig({ transport: 'udp' });
    lines = [];
    r.sync.goHome();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/DSTOP/);
    expect(lines[0].trim().split(' ').filter((p) => /^[LR]\d/.test(p)).every((p) => /I2000$/.test(p)), 'every position axis is timed').toBe(true);
  });

  it('not connected: nothing is sent, and it says why', async () => {
    const r = await rig({ connect: false });
    expect(r.sync.goHome()).toEqual({ sent: false, reason: 'not-connected' });
    expect(lines).toEqual([]);
  });

  it('after going home, the next play moves on from home at the keyframes\' own pace: no one-tick snap', async () => {
    // Every play resets what the engine remembers as sent, and its first send
    // then snaps to the CURRENT position over one tick (_tick): from where the
    // video paused that is nothing, from the middle it is half the travel at
    // full speed. Axes Go home parked take their first move to the next
    // keyframe at its own pace instead.
    const r = await rig();
    r.sync.setAxisActions('R0', wave(10, 90));
    r.sync.start();
    await r.play(1500);
    r.pause();
    r.sync.goHome();
    lines = [];
    await r.play(400);
    const parts = lines.flatMap((l) => l.trim().split(' '));
    const l0 = parts.filter((p) => p.startsWith('L0'));
    const r0 = parts.filter((p) => p.startsWith('R0'));
    expect(l0.length).toBeGreaterThan(0);
    expect(r0.length).toBeGreaterThan(0);
    // Keyframes are 10 and 90 (100 / 899 in 3 digits): the first move after
    // home is a keyframe target over its time, not a one-tick snap to a
    // midpoint.
    for (const first of [l0[0], r0[0]]) {
      expect(['100', '899']).toContain(first.slice(2).split('I')[0]);
      expect(Number(first.split('I')[1]), `${first}: moved over the time to its keyframe, not one tick`).toBeGreaterThan(16);
    }
    // Used once per DRIVEN axis; an axis no script moves stays marked (it IS
    // still in the middle).
    expect(r.sync._fromHome.has('L0'), 'L0 used').toBe(false);
    expect(r.sync._fromHome.has('R0'), 'R0 used').toBe(false);
    expect(r.sync._fromHome.has('R1'), 'R1 (not driven) still at home').toBe(true);
  });

  it('control: without Go home, a resume still snaps over one tick (the behaviour the parked axes skip)', async () => {
    const r = await rig();
    r.sync.start();
    await r.play(1500);
    r.pause();
    lines = [];
    await r.play(400);
    const l0 = lines.flatMap((l) => l.trim().split(' ')).filter((p) => p.startsWith('L0'));
    expect(Number(l0[0].split('I')[1])).toBeLessThanOrEqual(r.sync._tickIntervalMs);
  });

  it('FT-095 has nothing left to home on the next video once Go home ran', async () => {
    const r = await rig();
    r.sync.setAxisActions('R0', wave(0, 100));
    r.sync.start();
    await r.play(1000);
    r.pause();
    r.sync.goHome();
    expect(r.sync._homeCandidates.size).toBe(0);
  });
});
