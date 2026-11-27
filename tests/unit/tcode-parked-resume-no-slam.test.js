/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A resume (or the script player's hand-back) just before a fast stroke, over
// UDP / WebSocket (full manual test, 2026-11-23). A pause there sends the
// timed rest frame, so the axes glide to the middle, and the next play took
// L0 to the next keyframe "at the keyframe's own pace". With that keyframe
// 10 ms away it sent `L0799I10` to the stand-in listener: 30 units in 10 ms
// from the middle, five times the stroke's own 600 u/s. The slam Eroto (#423)
// asked about, by another door. Now such a move takes the jump ease (from
// where the device is, 150 u/s); a move at about the script's own speed
// keeps the keyframe's pace, as the FT-095 fix wanted.
// The real TCodeManager and TCodeSync on a fake transport (the rest-frame rig).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';

// A hold at 20, a fast stroke 3.9 → 4.0 s up to 80, a hold at 80 to 8 s.
const HOLDS = [{ at: 0, pos: 20 }, { at: 3900, pos: 20 }, { at: 4000, pos: 80 }, { at: 8000, pos: 80 }, { at: 9000, pos: 30 }];

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 600; }
}

let lines;
let savedWindow;

async function rig(actions = HOLDS) {
  const tcode = new TCodeManager();
  expect(await tcode.connect('udp', { host: '127.0.0.1', port: 18099 })).toBe(true);
  const video = new FakeVideo();
  const player = { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } };
  const engine = { get isLoaded() { return true; }, getActions: () => actions, getAuthoredActions: () => actions };
  const sync = new TCodeSync({ videoPlayer: player, tcodeManager: tcode, funscriptEngine: engine });
  const play = async (ms) => {
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

const l0 = () => lines.flatMap((l) => l.trim().split(' ')).filter((p) => p.startsWith('L0'));
const parse = (tok) => ({ pos: Number(tok.slice(2).split('I')[0]) / 10, ms: Number(tok.split('I')[1]) });

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

describe('after a pause over UDP, the first move never slams', () => {
  it('a resume moments before a fast stroke eases from the middle at the jump pace, not in one tick', async () => {
    const r = await rig();
    r.sync.start();
    await r.play(3940);                 // into the 3.9 → 4.0 s stroke
    // Paused so the first tick after play lands at about 3.992 s, 8 ms before
    // its keyframe (live: 10 ms). The rig's clock moves on twice (32 ms)
    // before the engine's first tick.
    r.video.currentTime = 3.96;
    r.pause();
    expect(lines.some((l) => l.startsWith('L0500I2000 '))).toBe(true); // the timed rest frame
    await vi.advanceTimersByTimeAsync(2500); // the device glides to the middle
    lines = [];
    await r.play(400);
    const first = parse(l0()[0]);
    // 30 units from the middle at 150 u/s is 200 ms; the keyframe was 10 ms away
    // (the old engine sent L0799I10).
    expect(first.ms, `${l0()[0]}: from the middle to ~80 must not be a one-tick slam`).toBeGreaterThanOrEqual(150);
    expect(first.pos).toBeGreaterThan(70);
    // Nothing else to L0 until it lands (the jump ease's hold).
    expect(l0().length).toBe(1);
  });

  it('a resume early in a long hold keeps the keyframe\'s own pace (FT-095 unchanged)', async () => {
    const r = await rig();
    r.sync.start();
    await r.play(4500);                 // in the hold at 80, which lasts to 8 s
    r.pause();
    await vi.advanceTimersByTimeAsync(2500);
    lines = [];
    await r.play(200);
    const first = parse(l0()[0]);
    expect(first.pos).toBeCloseTo(79.9, 0);
    expect(first.ms, `${l0()[0]}: over the time to its keyframe at 8 s`).toBeGreaterThan(3000);
  });

  it('a resume on a script at about its own speed keeps the keyframe\'s pace (a 10 / 90 wave)', async () => {
    const wave = Array.from({ length: 80 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
    const r = await rig(wave);
    r.sync.start();
    await r.play(1500);
    r.pause();
    lines = [];
    await r.play(400);
    const first = parse(l0()[0]);
    expect([10, 89.9]).toContain(first.pos); // a keyframe, not an interpolated jump target
    expect(first.ms).toBeGreaterThan(16);
  });
});
