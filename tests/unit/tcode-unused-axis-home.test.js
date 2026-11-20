/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-095 (2026-11-07; kissenpirat #389, also in v0.9.2): after a multi-axis
// video, a single-axis one left the T-Code device's other axes wherever the
// last video put them. Over serial stop() sends only DSTOP, which halts in
// place (a bare centre frame slams an OSR2+ across its travel, the 2026-08-01
// fix), and clearing the axis scripts only empties a map, so R0 / R1 / L1
// stayed twisted and tilted for every later video.
//
// Now the new video's FIRST PLAY eases each axis the last video moved, and
// this one does not drive, back to centre over 1 s. The REAL TCodeSync and
// the REAL TCodeManager over a stubbed IPC (no port, no device): asserted on
// the T-Code lines that would go down the wire.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';

const stroke = (n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
const wave = (lo, hi, n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? hi : lo }));

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 600; }
}

let lines;
let savedWindow;

async function rig({ transport = 'serial' } = {}) {
  const tcode = new TCodeManager();
  const opts = transport === 'serial' ? { path: 'COM3', baudRate: 115200 } : { host: '127.0.0.1', port: 18099 };
  expect(await tcode.connect(transport, opts)).toBe(true);
  const video = new FakeVideo();
  const player = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
  };
  let actions = stroke();
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
  /** The app's video change: loadVideo stops the engine and clears the axes. */
  const nextVideo = (mainActions = stroke()) => {
    sync.stop();
    sync.clearAxisActions();
    actions = mainActions;
    // A new source starts paused at 0 (the media load algorithm).
    video.paused = true;
    video.currentTime = 0;
  };
  return { sync, tcode, video, play, pause, nextVideo };
}

/** The homing line(s): every axis at a centre value with the 1 s interval. */
const homeLines = () => lines.filter((l) => /I1000\b/.test(l) && !/L0/.test(l));
const axesIn = (line) => line.trim().split(' ').map((p) => p.slice(0, 2));

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

describe('FT-095: axes the last video moved and this one does not drive go home, slowly', () => {
  it('multi-axis then single-axis over serial: one eased centre frame for R0 and R1 on the first play, none for L0', async () => {
    const r = await rig();
    r.sync.setAxisActions('R0', wave(0, 100));
    r.sync.setAxisActions('R1', wave(20, 80));
    r.sync.start();
    await r.play();
    expect(lines.some((l) => /R0\d{3}I/.test(l))).toBe(true);   // the multi-axis video drove them
    r.pause();
    r.nextVideo();

    // The single-axis video loads: nothing moves while it is paused.
    lines = [];
    r.sync.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(lines).toEqual([]);

    await r.play(300);
    const home = homeLines();
    expect(home).toEqual(['R0500I1000 R1500I1000\n']);
    // Sent before the stroke resumes, and the stroke itself is untouched.
    expect(lines.indexOf(home[0])).toBe(0);
    expect(lines.slice(1).some((l) => /^L0\d{3}I/.test(l))).toBe(true);
  });

  it('once per video: pause, play and seek in the same video send no second homing frame', async () => {
    const r = await rig();
    r.sync.setAxisActions('R0', wave(0, 100));
    r.sync.start();
    await r.play();
    r.nextVideo();
    r.sync.start();
    await r.play(200);
    expect(homeLines().length).toBe(1);
    r.pause();
    await r.play(200);
    r.video.currentTime = 30;
    r.video.dispatchEvent(new Event('seeked'));
    await r.play(200);
    expect(homeLines().length).toBe(1);
  });

  it('mid-video stop and start (Edge Hold, the Orgasm Switch release) homes nothing: its axes are still scripted', async () => {
    const r = await rig();
    r.sync.setAxisActions('R0', wave(0, 100));
    r.sync.setAxisActions('L1', wave(0, 100));
    r.sync.start();
    await r.play();
    // Edge Hold: the engine stops and starts again while the video plays on.
    r.sync.stop();
    lines = [];
    r.sync.start();
    await r.play(300);
    expect(homeLines()).toEqual([]);
    expect(lines.some((l) => /R0\d{3}I/.test(l))).toBe(true);
  });

  it('an axis the new video has a script for is not homed; the others are', async () => {
    const r = await rig();
    r.sync.setAxisActions('R0', wave(0, 100));
    r.sync.setAxisActions('R1', wave(0, 100));
    r.sync.start();
    await r.play();
    r.nextVideo();
    r.sync.setAxisActions('R0', wave(30, 70));   // the new video's own twist
    lines = [];
    r.sync.start();
    await r.play(200);
    expect(homeLines()).toEqual(['R1500I1000\n']);
  });

  it('an axis with generated motion, or one switched off, is not homed', async () => {
    const r = await rig();
    r.sync.setAxisActions('R0', wave(0, 100));
    r.sync.setAxisActions('R1', wave(0, 100));
    r.sync.setAxisActions('R2', wave(0, 100));
    r.sync.start();
    await r.play();
    r.nextVideo();
    r.sync.setAxisMotion('R0', { mode: 'link', depth: 50 });
    r.sync.setAxisEnabled('R1', false);
    lines = [];
    r.sync.start();
    await r.play(200);
    const home = homeLines();
    expect(home.length).toBe(1);
    expect(axesIn(home[0])).toEqual(['R2']);
  });

  it('never an axis no video moved: a single-axis video after a single-axis video sends no homing frame', async () => {
    const r = await rig();
    r.sync.start();
    await r.play();
    r.nextVideo();
    lines = [];
    r.sync.start();
    await r.play(300);
    expect(homeLines()).toEqual([]);
  });

  it('centre is the middle of the travel the axis allows (its range), inside its cutoff', async () => {
    const r = await rig();
    r.sync.setAxisRange('R0', 20, 60);
    r.sync.setAxisRange('R1', 0, 100);
    r.sync.setAxisCutoff('R1', 60, 100);
    r.sync.setAxisActions('R0', wave(0, 100));
    r.sync.setAxisActions('R1', wave(0, 100));
    r.sync.start();
    await r.play();
    r.nextVideo();
    lines = [];
    r.sync.start();
    await r.play(200);
    // R0: 20 + 0.5 x 40 = 40 %; R1: 50 % clamped up to its 60 % floor.
    expect(homeLines()).toEqual(['R0400I1000 R1599I1000\n']);
  });

  it('a video loaded but never played, then another: the second one\'s first play still homes the axes', async () => {
    const r = await rig();
    r.sync.setAxisActions('L1', wave(0, 100));
    r.sync.start();
    await r.play();
    r.nextVideo();
    r.sync.start();                 // loaded, never played
    r.nextVideo();
    lines = [];
    r.sync.start();
    await r.play(200);
    expect(homeLines()).toEqual(['L1500I1000\n']);
  });

  it('over UDP too (its stop() already centres, so this is the same place, eased)', async () => {
    const r = await rig({ transport: 'udp' });
    r.sync.setAxisActions('L2', wave(0, 100));
    r.sync.start();
    await r.play();
    r.nextVideo();
    lines = [];
    r.sync.start();
    await r.play(200);
    expect(homeLines()).toEqual(['L2500I1000\n']);
  });
});
