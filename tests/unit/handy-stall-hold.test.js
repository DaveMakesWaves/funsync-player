/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// N-01 — "the handy now doesnt always pause with the video escpecially if its
// buffering" (Dave, 2026-11-08). Reproduced 2026-11-16 against a Handy v2
// stub (scratchpad next-n-2026-11-16/n-repro.md), every row below is one of
// those runs:
//
//   A  source stops 15 s: 'waiting' at video 20.881 s, readyState 2, paused
//      false; ZERO device commands for 15.2 s; the device clock went 21.4 →
//      35.6 s (14.7 s ahead of the frozen picture); 'playing' sent it BACK.
//   B  slow drive: 7 stalls of 1-6 s, 13 plays and no stop in 60 s.
//   D  seek while playing on a slow source: nothing sent for 4.8 s (the
//      device stroked the OLD timeline under the new frame), then a seek
//      correction sent DURING a later stall (readyState 2), and the
//      'seeked' and 'playing' handlers each sent a play, 210 ms apart.
//   E  source offline: 'waiting', no 'error' for 16 s, device 12 s ahead.
//
// FN-05 (2026-11-16, Dave): a stall now waits STALL_GRACE_MS before the hold,
// so each hold below begins that long after the picture froze, and the
// device stands up to that much ahead of the frozen frame (it was 14.7 s);
// 'playing' then re-anchors it at the picture. Short hiccups are in
// stall-grace.test.js.
//
// What runs is REAL: SyncEngine over the REAL HandyManager (its HSSP chain,
// stop pre-emption, deadlines), on a fake SDK that answers like the cloud
// and records each command with its wall time, from which the device's own
// clock is replayed: after hsspPlay(start) it runs from `start`, after
// hsspStop it stands. Every assertion is on that device clock or on the
// commands the SDK was sent, never on the engine's fields.
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
  uploadDataToServer: vi.fn().mockResolvedValue('https://scripts01.handyfeeling.com/abc123'),
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { STALL_GRACE_MS } from '../../renderer/js/playback-stall.js';
import { liftAppClass } from './helpers/app-methods.js';

// --- the device, replayed from what the SDK was sent ----------------------

let sent;   // [{ cmd: 'play'|'stop', wall, start }]

function answerLikeTheCloud() {
  sent = [];
  mockHandy.hsspPlay.mockImplementation(async (start) => {
    sent.push({ cmd: 'play', wall: performance.now(), start });
    return { result: 0 };
  });
  mockHandy.hsspStop.mockImplementation(async () => {
    sent.push({ cmd: 'stop', wall: performance.now() });
    return { result: 0 };
  });
}

/** Is the device playing its script right now (last command a play)? */
const deviceRunning = () => sent.length > 0 && sent[sent.length - 1].cmd === 'play';
/** The device's script time in ms, from its own clock. */
function deviceTimeMs(wall = performance.now()) {
  let run = null; let stoppedAt = null;
  for (const e of sent) {
    if (e.cmd === 'play') run = e;
    else { if (run) stoppedAt = run.start + (e.wall - run.wall); run = null; }
  }
  return run ? run.start + (wall - run.wall) : stoppedAt;
}
const plays = () => sent.filter((e) => e.cmd === 'play');
const stops = () => sent.filter((e) => e.cmd === 'stop');

// --- the <video>: an EventTarget with the fields an element has -----------

class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { paused: true, seeking: false, readyState: 4, error: null, currentTime: 0 });
  }

  fire(type) { this.dispatchEvent(new Event(type)); }
}

/** Whether a real element's clock advances right now. */
const moving = (v, h) => !v.paused && !v.seeking && v.readyState >= 3 && !v.error && !h.frozen;

async function build({ at = 0 } = {}) {
  const manager = new HandyManager();
  await manager.init();
  manager._connected = true;
  manager._connectionKey = 'testkey';
  manager._mode = 1;
  const video = new FakeVideo();
  video.currentTime = at;
  const player = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return 180; },
  };
  const engine = new SyncEngine({ videoPlayer: player, handyManager: manager, funscriptEngine: { isLoaded: true } });
  engine._scriptReady = true;
  engine.onStopFailed = vi.fn();
  engine.start();
  const h = { manager, video, engine, frozen: false };
  return h;
}

/** Let wall time pass; the picture advances only while it can move. */
async function run(h, ms, step = 50) {
  for (let t = 0; t < ms; t += step) {
    if (moving(h.video, h)) h.video.currentTime += step / 1000;
    await vi.advanceTimersByTimeAsync(step);
  }
}

/** The user presses Play on a buffered position: 'play' then 'playing'. */
async function playFromBuffer(h) {
  h.video.paused = false;
  h.video.fire('play');
  h.video.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}

/** The source starves: readyState drops, 'waiting', paused stays false. */
async function starve(h) {
  h.video.readyState = 2;
  h.video.fire('waiting');
  await vi.advanceTimersByTimeAsync(0);
}

/** Data again: readyState back up, 'playing'. */
async function feed(h) {
  h.video.readyState = 4;
  h.video.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.clearAllMocks();
  mockHandy.getState.mockReturnValue({ info: { fwVersion: '4.2.1' }, mode: 1, hssp: { scriptSet: true } });
  answerLikeTheCloud();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('A — the source stops for 15 s: the device holds, then resumes in step', () => {
  it('stops the device once the stall outlasts the grace window, and sends nothing for the rest of it', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 20_900);
    expect(deviceRunning()).toBe(true);

    await starve(h);
    const frozenAtMs = Math.round(h.video.currentTime * 1000);
    // FN-05: nothing inside the window.
    await run(h, STALL_GRACE_MS - 50);
    expect(deviceRunning(), 'a stop went out inside the grace window').toBe(true);
    await run(h, 100);
    expect(deviceRunning(), 'the device ran on through the stall (row A)').toBe(false);
    const commandsAtStall = sent.length;

    await run(h, 15_200);
    // Nothing during the stall: no correction play, no drift re-anchor.
    expect(sent.length).toBe(commandsAtStall);
    // The device stood the grace window past where the picture froze, not
    // 14.7 s ahead of it.
    expect(Math.abs(deviceTimeMs() - frozenAtMs - STALL_GRACE_MS)).toBeLessThan(150);
  });

  it('re-anchors at the frozen time when the picture moves again: no jump back', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 20_900);
    await starve(h);
    await run(h, 15_200);
    const resumeAt = Math.round(h.video.currentTime * 1000);
    const deviceBefore = deviceTimeMs();

    await feed(h);
    expect(deviceRunning()).toBe(true);
    expect(plays().at(-1).start).toBe(resumeAt);
    // The re-anchor continues from where the picture froze: in the repro it
    // jumped BACK 14.7 s here; now at most the grace window it ran on (FN-05).
    expect(Math.abs(deviceTimeMs() - deviceBefore), 'the device jumped on resume').toBeLessThan(STALL_GRACE_MS + 150);
    await run(h, 3_000);   // past the 2.5 s correction
    expect(Math.abs(deviceTimeMs() - h.video.currentTime * 1000)).toBeLessThan(150);
  });
});

describe('B — a slow drive: every stall holds, every resume anchors once', () => {
  it('seven stop-and-go stalls never leave the device more than a step ahead of the picture', async () => {
    const h = await build();
    await playFromBuffer(h);
    let worst = 0;
    const stallLengths = [1000, 5900, 2000, 3300, 1500, 4000, 2600];
    for (const len of stallLengths) {
      await run(h, 1700);
      await starve(h);
      for (let t = 0; t < len; t += 100) {
        await run(h, 100);
        worst = Math.max(worst, deviceTimeMs() - h.video.currentTime * 1000);
      }
      await feed(h);
    }
    // Up to the grace window (FN-05), then held: row B had it 5.84 s ahead.
    expect(worst, 'device ahead of a frozen picture (row B: up to 5.84 s)').toBeLessThan(STALL_GRACE_MS + 100);
    // One stop per stall; one play per resume plus the first. No correction:
    // each one's 2.5 s fell inside the next stall, which cancelled it.
    expect(stops().length).toBe(stallLengths.length);
    expect(plays().length).toBe(stallLengths.length + 1);
  });

  it('the 2.5 s correction does not fire into a stall that began after the play', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 1000);
    await starve(h);
    await run(h, 4000);
    expect(plays().length, 'a correction restarted the device on a frozen picture').toBe(1);
    expect(deviceRunning()).toBe(false);
  });
});

describe('D — a seek while playing on a slow source', () => {
  async function seekWhilePlaying(h, toSec) {
    h.video.seeking = true;
    h.video.readyState = 1;
    h.video.currentTime = toSec;
    h.video.fire('seeking');
    h.video.fire('waiting');
    await vi.advanceTimersByTimeAsync(0);
  }

  it('stops the device within the grace window of the seek STARTING, not when it ends 4.8 s later', async () => {
    const h = await build({ at: 25 });
    await playFromBuffer(h);
    await run(h, 700);
    await seekWhilePlaying(h, 150);
    await run(h, STALL_GRACE_MS + 50);   // FN-05: a seek done inside the window sends no stop
    expect(deviceRunning(), 'the device stroked the old timeline under the new frame').toBe(false);
    const n = sent.length;
    await run(h, 4800);
    expect(sent.length).toBe(n);
  });

  it('anchors ONCE, at the new position, when it can play there', async () => {
    const h = await build({ at: 25 });
    await playFromBuffer(h);
    await run(h, 700);
    await seekWhilePlaying(h, 150);
    await run(h, 4800);
    const before = plays().length;

    // Chromium: 'seeked' (readyState 2, still no next frame), then 'playing'.
    h.video.seeking = false;
    h.video.readyState = 2;
    h.video.fire('seeked');
    await vi.advanceTimersByTimeAsync(0);
    expect(plays().length, 'the seeked handler played a picture that had not moved').toBe(before);
    await run(h, 210);
    await feed(h);
    expect(plays().length).toBe(before + 1);
    expect(plays().at(-1).start).toBe(150_000);
  });

  it('a later stall cancels the seek correction (it went out at readyState 2 in the repro)', async () => {
    const h = await build({ at: 25 });
    await playFromBuffer(h);
    await run(h, 700);
    // A seek that never starved (a player that fires no 'waiting'): the
    // seeked handler anchors and arms its 2.5 s correction.
    h.video.currentTime = 150;
    h.video.fire('seeked');
    await run(h, 300);
    expect(deviceRunning()).toBe(true);
    const before = plays().length;
    await starve(h);
    await run(h, 3000);
    expect(plays().length).toBe(before);
    expect(deviceRunning()).toBe(false);
  });
});

describe('E — the source goes offline', () => {
  it('holds through 16 s with no error event, then resumes when the source returns', async () => {
    const h = await build({ at: 40 });
    await playFromBuffer(h);
    await run(h, 7500);
    await starve(h);
    const at = h.video.currentTime * 1000;
    await run(h, 16_000);
    expect(deviceRunning()).toBe(false);
    expect(Math.abs(deviceTimeMs() - at - STALL_GRACE_MS)).toBeLessThan(150);   // the window, then held
    await feed(h);
    expect(deviceRunning()).toBe(true);
  });

  it('a media error while playing holds the device, and a seek during it does not restart it', async () => {
    const h = await build({ at: 40 });
    await playFromBuffer(h);
    await run(h, 2000);
    h.video.error = { code: 2 };
    h.video.fire('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(deviceRunning()).toBe(false);
    h.video.fire('seeked');
    await run(h, 3000);
    expect(deviceRunning()).toBe(false);
  });
});

describe('a stop always wins over a late play (the FT-110 rule)', () => {
  it('a stall during a play still in flight: the stop goes out at once, and the late play is undone', async () => {
    const h = await build();
    let releasePlay;
    mockHandy.hsspPlay.mockImplementationOnce((start) => {
      sent.push({ cmd: 'play', wall: performance.now(), start });
      return new Promise((r) => { releasePlay = () => r({ result: 0 }); });
    });
    await playFromBuffer(h);           // the play leaves for the cloud and hangs
    await run(h, 300);
    await starve(h);
    await run(h, STALL_GRACE_MS + 50);  // past the window (FN-05)
    expect(stops().length, 'the stall\'s stop waited behind the hung play').toBe(1);

    // The play answers late. Its command may have reached the device AFTER
    // the stop, so the engine sends the stop again (out of the last stop's
    // SDK throttle window, so ~220 ms later: block F review).
    sent.push({ cmd: 'play', wall: performance.now(), start: 0 });   // the device obeys the late play
    releasePlay();
    await run(h, 300);
    expect(deviceRunning(), 'a late play outlived the stall\'s stop').toBe(false);
  });

  // Fix-up review 2026-11-16 (reviewer scratch restop-race): a slow play, a
  // short stall, the picture moves again, THEN the slow play answers. The
  // resume's play queued behind it, and the late play's re-stop dropped it:
  // 'play@0 stop@800 stop@1500 play@4000', the device standing for 2.8 s of
  // a moving picture until the 2.5 s correction.
  it('a late play whose stall is already over leaves the resume\'s play alone', async () => {
    const h = await build({ at: 10 });
    let releasePlay;
    mockHandy.hsspPlay.mockImplementationOnce((start) => {
      sent.push({ cmd: 'play', wall: performance.now(), start });
      return new Promise((r) => { releasePlay = () => r({ result: 0 }); });
    });
    await playFromBuffer(h);           // play A leaves and hangs
    await run(h, 800);
    await starve(h);                   // past the window, the stall's stop pre-empts A
    await run(h, 400 + STALL_GRACE_MS);
    await feed(h);                     // the picture moves: play B queues behind A
    await run(h, 300);
    releasePlay();                     // A answers late
    await run(h, 300);                 // B waits out A's SDK throttle window (block F review)

    expect(stops().length, 'the late play re-stopped a device the resume owns').toBe(1);
    expect(deviceRunning(), 'the resume\'s play was dropped').toBe(true);
    expect(plays().length).toBe(2);
    // B carries the time the picture resumed at, sent once A answered.
    expect(plays().at(-1).start).toBe(10_800);
    await run(h, 3000);                // past B's own correction
    expect(Math.abs(deviceTimeMs() - h.video.currentTime * 1000)).toBeLessThan(150);
  });

  it('a late play after a pause re-stops while nothing has re-anchored (Play pressed, no "playing" yet)', async () => {
    const h = await build({ at: 10 });
    let releasePlay;
    mockHandy.hsspPlay.mockImplementationOnce((start) => {
      sent.push({ cmd: 'play', wall: performance.now(), start });
      return new Promise((r) => { releasePlay = () => r({ result: 0 }); });
    });
    await playFromBuffer(h);
    await run(h, 500);
    h.video.paused = true;
    h.video.fire('pause');
    await run(h, 300);
    // Play pressed again on a spot still loading: 'play' only, so far.
    h.video.paused = false;
    h.video.readyState = 1;
    h.video.fire('play');
    sent.push({ cmd: 'play', wall: performance.now(), start: 10_000 });   // the device obeys the late play
    releasePlay();
    await vi.advanceTimersByTimeAsync(0);
    expect(deviceRunning(), 'a late play ran the device on a picture that had not moved').toBe(false);
  });
});

describe('nothing to hold: no stop is queued in front of the play that follows', () => {
  it('a Play on a position still loading, after a pause, sends just the play when it can move', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 3000);
    h.video.paused = true;
    h.video.fire('pause');
    await vi.advanceTimersByTimeAsync(0);
    const n = sent.length;

    // Play on an unbuffered spot: 'play', 'waiting', then 'playing'.
    h.video.paused = false;
    h.video.readyState = 1;
    h.video.fire('play');
    h.video.fire('waiting');
    await run(h, 1500);
    expect(sent.length, 'a stall with the device already stopped sent another stop').toBe(n);
    await feed(h);
    expect(sent.slice(n).map((e) => e.cmd)).toEqual(['play']);
  });

  it('start() on a video still loading anchors on its "playing", not before', async () => {
    const manager = new HandyManager();
    await manager.init();
    Object.assign(manager, { _connected: true, _connectionKey: 'testkey', _mode: 1 });
    const video = new FakeVideo();
    Object.assign(video, { paused: false, readyState: 1, currentTime: 0 });
    const player = { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } };
    const engine = new SyncEngine({ videoPlayer: player, handyManager: manager, funscriptEngine: { isLoaded: true } });
    engine._scriptReady = true;
    engine.start();
    await vi.advanceTimersByTimeAsync(3000);   // the drive spins up
    expect(plays().length, 'anchored a device on a video with no frame yet').toBe(0);
    video.readyState = 4;
    video.fire('playing');
    await vi.advanceTimersByTimeAsync(0);
    expect(plays().length).toBe(1);
    expect(plays()[0].start).toBe(0);
    engine.stop();
  });
});

describe('a picture that stops with no event at all (the stall watch)', () => {
  it('holds after about a second, and re-anchors where the clock moves on', async () => {
    const h = await build({ at: 10 });
    await playFromBuffer(h);
    await run(h, 2000);
    h.frozen = true;                 // readyState 4, paused false, no event
    await run(h, 1600);
    expect(deviceRunning(), 'the device ran on a clock that had stopped').toBe(false);
    const n = plays().length;
    h.frozen = false;
    await run(h, 600);
    expect(deviceRunning()).toBe(true);
    expect(plays().length).toBe(n + 1);
    expect(Math.abs(deviceTimeMs() - h.video.currentTime * 1000)).toBeLessThan(400);
  });

  it('a network "stalled" while frames still play from the buffer holds nothing', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 1000);
    h.video.fire('stalled');            // readyState still 4
    await run(h, 2000);
    expect(deviceRunning()).toBe(true);
    expect(stops().length).toBe(0);
  });

  it('a "stalled" that has run out of frames holds like a "waiting"', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 1000);
    h.video.readyState = 2;
    h.video.fire('stalled');
    await vi.advanceTimersByTimeAsync(0);
    expect(deviceRunning(), 'held inside the grace window').toBe(true);
    await run(h, STALL_GRACE_MS + 50);
    expect(deviceRunning()).toBe(false);
  });
});

describe('the drift re-anchor and the manual-resync restore leave a held device alone', () => {
  it('a stall that starts while the drift check is syncing time is not undone by it', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 3000);
    // A slow time sync: the stall begins while it runs.
    let releaseSync;
    mockHandy.sync.mockImplementationOnce(() => new Promise((r) => { releaseSync = r; }));
    mockHandy.getClientServerLatency.mockReturnValue({ avgOffset: 0, avgRtd: 250, lastSyncTime: 0 });
    h.manager._syncQuality = { avgRtd: 250, avgOffset: 0 };
    const drift = h.engine._checkDrift();
    await vi.advanceTimersByTimeAsync(0);
    await starve(h);
    releaseSync();
    await drift;
    await run(h, 500);
    expect(deviceRunning(), 'the drift re-anchor restarted a held device').toBe(false);
  });

  // app.js `_restoreHssspAfterResync` (lifted, REAL): after the panel's
  // Resync, the device ignores HSSP until a stop and a play. During a stall
  // the play half belongs to the engine's re-anchor on 'playing'.
  const Lifted = liftAppClass(['_restoreHssspAfterResync'], {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  });
  const restoreApp = (h) => Object.assign(new Lifted(), {
    handyManager: h.manager, videoPlayer: { video: h.video }, syncEngine: h.engine,
  });

  it('the manual-Resync restore stops a held device and leaves the play to "playing"', async () => {
    const h = await build();
    await playFromBuffer(h);
    await run(h, 2000);
    await starve(h);
    const n = plays().length;
    await restoreApp(h)._restoreHssspAfterResync();
    expect(plays().length, 'the Resync restore played a frozen picture').toBe(n);
    expect(deviceRunning()).toBe(false);
    await feed(h);
    expect(deviceRunning()).toBe(true);
  });

  it('the manual-Resync restore on a moving picture: stop, then play at the current time (unchanged)', async () => {
    const h = await build({ at: 12 });
    await playFromBuffer(h);
    await run(h, 2000);
    const n = sent.length;
    await restoreApp(h)._restoreHssspAfterResync();
    expect(sent.slice(n).map((e) => e.cmd)).toEqual(['stop', 'play']);
    expect(plays().at(-1).start).toBe(Math.round(h.video.currentTime * 1000));
  });

  // Fix-up review 2026-11-16 (also in v0.9.2): the restore's stop is slow
  // and the user pauses while it travels. The pause's stop queued behind
  // it, then the restore's play went out after both: 'stop stop play',
  // the device running under a paused picture.
  it('a pause during the restore\'s stop: the restore sends no play', async () => {
    const h = await build({ at: 30 });
    await playFromBuffer(h);
    await run(h, 4000);
    mockHandy.hsspStop.mockImplementationOnce(() => new Promise((r) => setTimeout(() => {
      sent.push({ cmd: 'stop', wall: performance.now() });
      r({ result: 0 });
    }, 1500)));
    const n = sent.length;
    const restore = restoreApp(h)._restoreHssspAfterResync();
    await run(h, 300);
    h.video.paused = true;
    h.video.fire('pause');
    await run(h, 3000);
    await restore;
    expect(sent.slice(n).map((e) => e.cmd)).toEqual(['stop', 'stop']);
    expect(deviceRunning(), 'the Resync restore ran the device after a pause').toBe(false);
  });

  it('a pause during the restore\'s play: the restore sends the stop again', async () => {
    const h = await build({ at: 30 });
    await playFromBuffer(h);
    await run(h, 4000);
    let releasePlay;
    mockHandy.hsspPlay.mockImplementationOnce((start) => {
      sent.push({ cmd: 'play', wall: performance.now(), start });
      return new Promise((r) => { releasePlay = () => r({ result: 0 }); });
    });
    const restore = restoreApp(h)._restoreHssspAfterResync();
    await run(h, 200);                 // its stop answered, its play hangs
    h.video.paused = true;
    h.video.fire('pause');             // the pause's stop pre-empts the play
    await run(h, 300);
    sent.push({ cmd: 'play', wall: performance.now(), start: 34_000 });   // the device obeys the late play
    releasePlay();
    await restore;
    await vi.advanceTimersByTimeAsync(0);
    expect(deviceRunning(), 'the restore\'s late play outlived the pause').toBe(false);
  });

  it('the restore plays at the time its stop answered, not the time it began', async () => {
    const h = await build({ at: 12 });
    await playFromBuffer(h);
    await run(h, 2000);
    mockHandy.hsspStop.mockImplementationOnce(() => new Promise((r) => setTimeout(() => {
      sent.push({ cmd: 'stop', wall: performance.now() });
      r({ result: 0 });
    }, 1000)));
    const restore = restoreApp(h)._restoreHssspAfterResync();
    // The 2.5 s correction queued behind the slow stop and goes when it
    // answers; the restore's play then waits out that play's SDK throttle
    // window (~220 ms, block F review).
    await run(h, 1100 + 300);
    await restore;
    expect(plays().at(-1).start).toBeGreaterThanOrEqual(14_950);
  });
});
