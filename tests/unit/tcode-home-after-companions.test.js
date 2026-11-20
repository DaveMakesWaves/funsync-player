/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// E2-06 (block E1 review minor, reproduced live by verify-3; new since
// v0.9.2): FT-095 homes the T-Code axes the last video moved and the new one
// does not drive, at the new video's first play. It took that decision from
// the axis scripts loaded AT THAT MOMENT, and app.js loads the companion
// files (`Clip.twist.funscript`...) one after another without awaiting them
// before playback starts. With autoplay and a slow drive (read-funscript
// delayed 3 s) Companion Clip's R0 and R1 got `R0500I1000 R1500I1000` and sat
// at centre for 6-9 s although it drives them.
//
// Now the decision waits for the companions to load or fail. The REAL
// TCodeSync and the REAL TCodeManager over a stubbed IPC (no port, no
// device), and the REAL app.js `_loadPlayContent` / `_loadMultiAxisScripts`
// lifted out (helpers/app-methods.js). Asserted on the T-Code lines that
// would go down the wire.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';
import { liftAppClass } from './helpers/app-methods.js';

const stroke = (n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
const wave = (lo, hi, n = 80) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? hi : lo }));

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 600; }
}

let lines;
let savedWindow;

async function rig() {
  const tcode = new TCodeManager();
  expect(await tcode.connect('serial', { path: 'COM3', baudRate: 115200 })).toBe(true);
  const video = new FakeVideo();
  const player = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
  };
  let actions = stroke();
  const engine = {
    get isLoaded() { return true; },
    getActions: () => actions,
    getAuthoredActions: () => actions,
  };
  const sync = new TCodeSync({ videoPlayer: player, tcodeManager: tcode, funscriptEngine: engine });
  /** Playback runs for `ms` (the engine's 60 Hz tick under fake timers). */
  const run = async (ms) => {
    for (let t = 0; t < ms; t += 16) {
      if (!video.paused) video.currentTime += 0.016;
      await vi.advanceTimersByTimeAsync(16);
    }
  };
  const play = async (ms = 1500) => {
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    await run(ms);
  };
  const pause = () => { video.paused = true; video.dispatchEvent(new Event('pause')); };
  /** loadVideo: stop the engine, clear the axes, the new source at 0 paused. */
  const nextVideo = () => {
    sync.stop();
    sync.clearAxisActions();
    actions = stroke();
    video.paused = true;
    video.currentTime = 0;
  };
  /** A multi-axis video drove R0, R1 and R2; then the next video loads. */
  const afterMultiAxisVideo = async () => {
    sync.setAxisActions('R0', wave(0, 100));
    sync.setAxisActions('R1', wave(20, 80));
    sync.setAxisActions('R2', wave(10, 90));
    sync.start();
    await play();
    pause();
    nextVideo();
    lines = [];
  };
  return { sync, tcode, video, player, play, pause, run, afterMultiAxisVideo };
}

/** The homing line(s): an axis at a centre value with the 1 s interval. */
const homeLines = () => lines.filter((l) => /I1000\b/.test(l) && !/L0/.test(l));
const homedAxes = () => homeLines().flatMap((l) => l.trim().split(' ').map((p) => p.slice(0, 2)));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

describe('E2-06: TCodeSync decides what to home once the companions have loaded', () => {
  it('a play while they load homes nothing; once they land, only the axis this video does not drive goes home', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    const companions = deferred();
    r.sync.holdHomeUntil(companions.promise);
    r.sync.start();
    await r.play(3000);                         // autoplay; the drive is slow
    expect(homeLines()).toEqual([]);
    // twist (R0) and roll (R1) arrive, then the load settles.
    r.sync.setAxisActions('R0', wave(30, 70));
    r.sync.setAxisActions('R1', wave(40, 60));
    companions.resolve();
    await r.run(300);
    expect(homeLines()).toEqual(['R2500I1000\n']);
    // R0 and R1 play their own scripts; neither was ever sent to centre.
    expect(lines.some((l) => /R0\d{3}I/.test(l) && !/I1000\b/.test(l))).toBe(true);
    expect(homedAxes()).not.toContain('R0');
    expect(homedAxes()).not.toContain('R1');
  });

  it('a companion that failed counts as undriven: it goes home when the load settles', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    const companions = deferred();
    r.sync.holdHomeUntil(companions.promise);
    r.sync.start();
    await r.play(500);
    r.sync.setAxisActions('R0', wave(30, 70));  // twist loaded, roll failed
    companions.reject(new Error('EACCES'));
    await r.run(300);
    expect(homedAxes().sort()).toEqual(['R1', 'R2']);
  });

  it('paused when the load settles: nothing moves until the next play, which homes once', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    const companions = deferred();
    r.sync.holdHomeUntil(companions.promise);
    r.sync.start();
    await r.play(300);
    r.pause();
    companions.resolve();
    await r.run(1000);
    expect(homeLines()).toEqual([]);
    await r.play(300);
    expect(homeLines()).toEqual(['R0500I1000 R1500I1000 R2500I1000\n']);
    await r.play(300);
    expect(homeLines().length).toBe(1);
  });

  it('a load that settles before the first play changes nothing about that play', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    r.sync.holdHomeUntil(Promise.resolve());
    r.sync.setAxisActions('R0', wave(30, 70));
    await r.run(50);
    r.sync.start();
    await r.play(300);
    expect(homeLines()).toEqual(['R1500I1000 R2500I1000\n']);
  });

  it('null (a video with no companions) drops the hold and homes at once if it is playing', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    r.sync.holdHomeUntil(deferred().promise);   // an earlier load that never settles
    r.sync.start();
    await r.play(300);
    expect(homeLines()).toEqual([]);
    r.sync.holdHomeUntil(null);
    await r.run(100);
    expect(homeLines()).toEqual(['R0500I1000 R1500I1000 R2500I1000\n']);
  });

  it('a superseded load settling late does not decide for the newer one', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    const older = deferred();
    const newer = deferred();
    r.sync.holdHomeUntil(older.promise);
    r.sync.holdHomeUntil(newer.promise);
    r.sync.start();
    await r.play(300);
    older.resolve();
    await r.run(300);
    expect(homeLines()).toEqual([]);
    r.sync.setAxisActions('R2', wave(10, 90));
    newer.resolve();
    await r.run(300);
    expect(homeLines()).toEqual(['R0500I1000 R1500I1000\n']);
  });
});

describe('E2-06: app.js holds the decision while a played video\'s companions load', () => {
  const LiftedApp = liftAppClass(['_loadPlayContent', '_loadMultiAxisScripts'], {
    getAxisBySuffix,
    showToast: () => {},
    t: (k) => k,
    console: { log() {}, info() {}, warn() {}, error() {} },
  });
  const CLIP = 'C:\\Lib\\Companion Clip.mp4';
  const TWIST = 'C:\\Lib\\Companion Clip.twist.funscript';
  const ROLL = 'C:\\Lib\\Companion Clip.roll.funscript';
  const text = (actions) => JSON.stringify({ actions });

  function build(r) {
    const reads = new Map();     // path -> deferred read
    const app = Object.assign(new LiftedApp(), {
      _videoLoadGen: 1,
      _audienceVideoToken: 1,
      _currentVideoPath: CLIP,
      tcodeSync: r.sync,
      buttplugSync: null,
      buttplugManager: null,
      funscriptEngine: { isLoaded: true },
      videoPlayer: r.player,
      _updateVariantSelector() {},
      _applyPreferredVariant: async () => {},
      _refreshEditorScriptList() {},
      _releaseCompanionAxis: vi.fn(),
      // The main script loads and the engine starts with it, as
      // loadFunscript -> _tryStartTCodeSync does; the video already plays.
      loadFunscript() { r.sync.start(); },
      // A slow drive: each companion read waits for the test.
      _readScriptResilient(p) {
        const d = deferred();
        reads.set(p, d);
        return d.promise;
      },
    });
    const land = async (p, actions) => {
      reads.get(p).resolve(actions ? { content: text(actions) } : null);
      await r.run(50);
    };
    return { app, reads, land };
  }

  it('Companion Clip on a slow drive: R0 and R1 are never homed, R2 (not driven) is, after the companions load', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    const { app, reads, land } = build(r);
    r.video.paused = false;                     // autoplay began
    const loading = app._loadPlayContent({ path: CLIP }, {
      name: 'Companion Clip.funscript',
      textContent: text(stroke()),
      _multiAxis: { axes: { twist: TWIST, roll: ROLL } },
    }, null, []);
    r.video.dispatchEvent(new Event('playing'));
    await r.run(3000);                          // the 3 s read
    expect(homeLines()).toEqual([]);
    await land(TWIST, wave(30, 70));
    await r.run(3000);                          // the next file, one after another
    expect(homeLines()).toEqual([]);
    await land(ROLL, wave(40, 60));
    await loading;
    await r.run(300);
    expect([...reads.keys()]).toEqual([TWIST, ROLL]);
    expect(homeLines()).toEqual(['R2500I1000\n']);
  });

  it('a companion that cannot be read: its axis goes home once the load has given up on it', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    const { app, land } = build(r);
    r.video.paused = false;
    app._loadPlayContent({ path: CLIP }, {
      name: 'Companion Clip.funscript',
      textContent: text(stroke()),
      _multiAxis: { axes: { twist: TWIST, roll: ROLL } },
    }, null, []);
    r.video.dispatchEvent(new Event('playing'));
    await land(TWIST, wave(30, 70));
    await r.run(500);
    expect(homeLines()).toEqual([]);
    await land(ROLL, null);                     // unreadable
    await r.run(300);
    expect(homedAxes().sort()).toEqual(['R1', 'R2']);
  });

  it('a video with no companions homes at its first play, as FT-095 did', async () => {
    const r = await rig();
    await r.afterMultiAxisVideo();
    const { app } = build(r);
    r.video.paused = false;
    await app._loadPlayContent({ path: CLIP }, { name: 'Single.funscript', textContent: text(stroke()) }, null, []);
    r.video.dispatchEvent(new Event('playing'));
    await r.run(300);
    expect(homeLines()).toEqual(['R0500I1000 R1500I1000 R2500I1000\n']);
  });
});
