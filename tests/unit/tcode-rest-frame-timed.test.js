/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A T-Code pause over UDP / WebSocket (FT-095, Dave 2026-11-20: "make the pause
// frame a slow move ... and treat A0 as a position everywhere").
//
// After DSTOP the manager sends a rest frame for MFP-style consumers (restim,
// Howl). It was BARE (`L0500 ... A0000`), so a real T-Code firmware over WiFi
// (an ESP32 OSR / SR6) slammed to the middle on every pause, and the valve A0
// was zeroed while TCodeSync and Go home centre it. Now the positions (A0
// included) glide to the middle over REST_MOVE_MS and the intensities go off
// at once; and the engine's next play moves those axes on at the keyframes'
// pace instead of snapping over one tick from the middle (the 17 ms jump back
// after a pop-out, FT-095 verify-3). Serial is unchanged: DSTOP halts in place.
// The real TCodeManager and TCodeSync on a fake transport (the Go home rig).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TCodeSync, GO_HOME_MOVE_MS } from '../../renderer/js/tcode-sync.js';
import { TCodeManager, REST_MOVE_MS } from '../../renderer/js/tcode-manager.js';

const stroke = (n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
const wave = (lo, hi, n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? hi : lo }));

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 600; }
}

let lines;
let savedWindow;

async function rig({ transport = 'udp' } = {}) {
  const tcode = new TCodeManager();
  const opts = transport === 'serial' ? { path: 'COM3', baudRate: 115200 }
    : transport === 'websocket' ? { url: 'ws://restim.local:81' } : { host: '127.0.0.1', port: 18099 };
  expect(await tcode.connect(transport, opts)).toBe(true);
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

const tokens = (axis) => lines.flatMap((l) => l.trim().split(' ')).filter((p) => p.startsWith(axis));

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

describe('TCodeManager.stop: the rest frame is timed, and A0 is a position', () => {
  for (const transport of ['udp', 'websocket']) {
    it(`${transport}: DSTOP, then every position (A0 too) to the middle over 2 s, intensities off at once`, async () => {
      const { tcode } = await rig({ transport });
      lines = [];
      const centred = tcode.stop();
      expect(REST_MOVE_MS).toBe(2000);
      expect(REST_MOVE_MS).toBe(GO_HOME_MOVE_MS); // the same pace as the Go home button
      expect(lines).toEqual([
        'DSTOP\n',
        'L0500I2000 L1500I2000 L2500I2000 R0500I2000 R1500I2000 R2500I2000 A0500I2000 V0000 V1000 A1000 A2000\n',
      ]);
      expect(centred).toEqual(['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'A0']);
    });
  }

  it('no position in the frame is bare (an untimed value is the slam)', async () => {
    const { tcode } = await rig();
    lines = [];
    tcode.stop();
    for (const t of lines[1].trim().split(' ')) {
      if (/^(V|A1|A2)/.test(t)) expect(t, `${t}: an intensity goes off at once`).not.toContain('I');
      else expect(t, `${t}: a position must carry an interval`).toMatch(/I2000$/);
    }
  });

  it('4-digit precision: the same frame, scaled', async () => {
    const { tcode } = await rig();
    tcode.setPrecision(4);
    lines = [];
    tcode.stop();
    expect(lines[1]).toBe('L05000I2000 L15000I2000 L25000I2000 R05000I2000 R15000I2000 R25000I2000 A05000I2000 V00000 V10000 A10000 A20000\n');
  });

  it('serial is unchanged: DSTOP only (the firmware halts in place), and nothing is reported centred', async () => {
    const { tcode } = await rig({ transport: 'serial' });
    lines = [];
    expect(tcode.stop()).toEqual([]);
    expect(lines).toEqual(['DSTOP\n']);
  });

  it('not connected: nothing sent, nothing centred', () => {
    const tcode = new TCodeManager();
    lines = [];
    expect(tcode.stop()).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('TCodeSync: after a pause over UDP the next play moves on from the middle at the keyframes\' pace', () => {
  it('pause, then play: the first L0 and R0 moves are keyframe targets over their own time, not one-tick snaps', async () => {
    const r = await rig();
    r.sync.setAxisActions('R0', wave(10, 90));
    r.sync.start();
    await r.play(1500);
    r.pause();
    expect(lines.some((l) => l.startsWith('L0500I2000 '))).toBe(true); // the timed rest frame went out
    lines = [];
    await r.play(400);
    const l0 = tokens('L0');
    const r0 = tokens('R0');
    expect(l0.length).toBeGreaterThan(0);
    expect(r0.length).toBeGreaterThan(0);
    // Keyframes are 10 and 90 (100 / 899 in 3 digits).
    for (const first of [l0[0], r0[0]]) {
      expect(['100', '899']).toContain(first.slice(2).split('I')[0]);
      expect(Number(first.split('I')[1]), `${first}: from the middle over the time to its keyframe, not one tick`)
        .toBeGreaterThan(r.sync._tickIntervalMs);
    }
  });

  it('a video change over UDP (emptied) does the same for the new video\'s first play', async () => {
    const r = await rig();
    r.sync.start();
    await r.play(1500);
    r.video.dispatchEvent(new Event('emptied'));
    expect(lines.some((l) => l.startsWith('L0500I2000 '))).toBe(true);
    lines = [];
    r.video.currentTime = 0.1;
    await r.play(400);
    const first = tokens('L0')[0];
    expect(Number(first.split('I')[1]), `${first}`).toBeGreaterThan(r.sync._tickIntervalMs);
  });

  it('control, serial: DSTOP halts in place, so a resume still takes the usual one-tick first send', async () => {
    const r = await rig({ transport: 'serial' });
    r.sync.start();
    await r.play(1500);
    r.pause();
    expect(lines.some((l) => l.includes('I2000'))).toBe(false);
    lines = [];
    await r.play(400);
    const first = tokens('L0')[0];
    expect(Number(first.split('I')[1])).toBeLessThanOrEqual(r.sync._tickIntervalMs);
  });
});
