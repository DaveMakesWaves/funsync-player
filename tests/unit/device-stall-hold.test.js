/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FN-02 (Dave 2026-11-16: "yes everything should shop while a video
// buffers"; also in v0.9.2). N-01 made the two cloud-clock engines (Handy,
// Autoblow) hold on a stall. Buttplug and T-Code read the clock every tick,
// so their POSITION outputs already stood on a frozen clock, but every
// SUSTAINED output kept the last level it was sent: a vibrator, a rotator, a
// flywheel machine, an e-stim box, the T-Code V / A channels and a generated
// intensity buzzed on through every stall. In the player pop-out a stall
// reached them as a 'pause' (since N-01), which ran stopAll / DSTOP and, over
// UDP / WebSocket T-Code, a rest frame that centres every position axis: a
// jerk per pop-out seek. And the headset proxy ran its clock straight through
// a stall, so nothing there held at all.
//
// FN-05 (2026-11-16): the hold now begins STALL_GRACE_MS after the picture
// stops, and a stall or a seek over inside that window turns nothing off
// (stall-grace.test.js has the short ones).
//
// What runs is REAL: ButtplugSync over the REAL ButtplugManager (only its
// five SDK sends are recorders), TCodeSync over the REAL TCodeManager on a
// stubbed IPC (the T-Code lines that would go down the wire), the REAL
// RemotePlaybackProxy (the pop-out) and VRPlaybackProxy (the headset), and
// SyncEngine over the REAL HandyManager on a fake SDK. Every assertion is on
// what a device was sent.
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

import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { VRPlaybackProxy } from '../../renderer/js/vr-playback-proxy.js';
import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { STALL_GRACE_MS } from '../../renderer/js/playback-stall.js';

// 10 <-> 90 every 250 ms for two minutes: always somewhere to go.
const stroke = (n = 480) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));
const wave = (lo, hi, n = 480) => Array.from({ length: n }, (_, i) => ({ at: i * 250, pos: i % 2 ? hi : lo }));
const TICK_MS = Math.round(1000 / 60);   // TCodeSync's one-tick snap interval

// --- the <video>: an EventTarget with the fields an element has -----------

class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { paused: true, seeking: false, readyState: 4, error: null, currentTime: 0, duration: 600 });
  }

  fire(type) { this.dispatchEvent(new Event(type)); }
}

const playerOf = (video) => ({
  video,
  get paused() { return video.paused; },
  get currentTime() { return video.currentTime; },
  get duration() { return video.duration; },
});

/** The picture advances only while it can move; `frozen` stops it with no event. */
const moving = (v, h) => !v.paused && !v.seeking && v.readyState >= 3 && !v.error && !h.frozen;

async function run(h, ms, step = 20) {
  for (let t = 0; t < ms; t += step) {
    if (moving(h.video, h)) h.video.currentTime += step / 1000;
    await vi.advanceTimersByTimeAsync(step);
  }
}

// --- the devices -------------------------------------------------------------

let bpLog;      // [kind, deviceIndex, value]
let lines;      // T-Code lines down the wire
let savedWindow;

const SUSTAINED = new Set(['vibrate', 'oscillate', 'rotate', 'scalar']);
const SENDS = [['sendLinear', 'linear'], ['sendVibrate', 'vibrate'], ['sendOscillate', 'oscillate'], ['sendRotate', 'rotate'], ['sendScalar', 'scalar']];

/** The REAL ButtplugManager with five devices; only its SDK sends record. */
function buttplugManager() {
  const mgr = new ButtplugManager();
  mgr._client = { stopAllDevices: vi.fn(async () => { bpLog.push(['stopAll']); }) };
  mgr._connected = true;
  const dev = (index, name, outputs) => ({ index, name, hasOutput: (t) => outputs.includes(t) });
  mgr._devices = new Map([
    [0, dev(0, 'Stroker', ['HwPositionWithDuration'])],
    [1, dev(1, 'Vibe', ['Vibrate'])],
    [2, dev(2, 'Flywheel', ['Oscillate'])],
    [3, dev(3, 'Rotator', ['Rotate'])],
    [4, dev(4, 'E-stim', ['Constrict'])],
  ]);
  for (const [method, kind] of SENDS) {
    mgr[method] = vi.fn(async (index, value) => { bpLog.push([kind, index, value]); return { ok: true }; });
  }
  return mgr;
}

async function tcodeManager() {
  const tcode = new TCodeManager();
  // UDP: stop() sends DSTOP AND a rest frame that centres every position axis.
  expect(await tcode.connect('udp', { host: '127.0.0.1', port: 18099 })).toBe(true);
  return tcode;
}

function buttplugSync(player) {
  const actions = stroke();
  const sync = new ButtplugSync({
    videoPlayer: player,
    buttplugManager: buttplugManager(),
    funscriptEngine: { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions },
  });
  sync.start();
  return sync;
}

async function tcodeSync(player) {
  const actions = stroke();
  const sync = new TCodeSync({
    videoPlayer: player,
    tcodeManager: await tcodeManager(),
    funscriptEngine: { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions },
  });
  sync.setAxisActions('V0', wave(60, 80));          // a scripted vibe channel
  sync.setAxisMotion('V1', { mode: 'link' });       // a generated intensity (pump)
  sync.setAxisMotion('R0', { mode: 'link' });       // a generated POSITION (twist)
  sync.start();
  return sync;
}

/** The level each sustained Buttplug output holds after log entry `upTo`. */
function sustainedLevels(upTo = bpLog.length) {
  const levels = {};
  for (const e of bpLog.slice(0, upTo)) if (SUSTAINED.has(e[0])) levels[`${e[0]}:${e[1]}`] = e[2];
  return levels;
}
const EVERY_SUSTAINED = ['vibrate:1', 'oscillate:2', 'rotate:3', 'scalar:4'];
const linears = (from = 0, to = bpLog.length) => bpLog.slice(from, to).filter((e) => e[0] === 'linear');
const stopAlls = (from = 0) => bpLog.slice(from).filter((e) => e[0] === 'stopAll');

const valueOf = (line, axis) => {
  const m = new RegExp(`(?:^| )${axis}(\\d{3})(?:I(\\d+))?`).exec(line);
  return m ? { value: Number(m[1]), interval: m[2] === undefined ? null : Number(m[2]) } : null;
};
const sendsOf = (axis, from = 0) => lines.slice(from).map((l) => valueOf(l, axis)).filter(Boolean);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.clearAllMocks();
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
  };
  mockHandy.getState.mockReturnValue({ info: { fwVersion: '4.2.1' }, mode: 1, hssp: { scriptSet: true } });
});
afterEach(() => {
  globalThis.window = savedWindow;
  vi.useRealTimers();
});

describe('the recorders sit on the real classes', () => {
  it('every send the Buttplug test records, and the stops it relies on, are ButtplugManager methods', () => {
    for (const [method] of SENDS) expect(typeof ButtplugManager.prototype[method]).toBe('function');
    for (const m of ['stopAll', 'stopSustainedOutputs']) expect(typeof ButtplugManager.prototype[m]).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(ButtplugManager.prototype, 'devices')?.get).toBe('function');
  });
});

describe('FN-02 inline: a buffering stall turns every sustained Buttplug output off, and position is left alone', () => {
  async function playing() {
    const video = new FakeVideo();
    const h = { video, frozen: false };
    h.sync = buttplugSync(playerOf(video));
    video.paused = false;
    video.fire('playing');
    await run(h, 3000);
    return h;
  }

  it('waiting: vibrate / oscillate / rotate / e-stim go to 0 past the grace window and stay there; no stopAll, no linear command, all stall long', async () => {
    const h = await playing();
    const before = sustainedLevels();
    for (const k of EVERY_SUSTAINED) expect(before[k], `${k} was driven before the stall`).toBeGreaterThan(0);

    const at = bpLog.length;
    h.video.readyState = 2;
    h.video.fire('waiting');
    // FN-05: nothing is turned off inside the window...
    await run(h, STALL_GRACE_MS - 40);
    const inWindow = sustainedLevels();
    for (const k of EVERY_SUSTAINED) expect(inWindow[k], `${k} turned off inside the grace window`).toBeGreaterThan(0);
    // ...and everything is once it has run out.
    await run(h, 60);
    const now = sustainedLevels();
    for (const k of EVERY_SUSTAINED) expect(now[k], `${k} kept its last level through the stall`).toBe(0);

    const atHold = bpLog.length;
    await run(h, 5000);
    // Inside the window the tick ran as it always did; from the hold on,
    // nothing turns an output back on until the picture moves.
    expect(bpLog.slice(atHold).filter((e) => SUSTAINED.has(e[0]) && e[2] !== 0)).toEqual([]);
    expect(stopAlls(at), 'a StopDeviceCmd stops a stroker mid-stroke').toEqual([]);
    expect(linears(at), 'a position device follows the frozen clock: nothing new').toEqual([]);
  });

  it('playing: the sustained outputs come back, and the stroker gets the target it already had (no jerk)', async () => {
    const h = await playing();
    const lastLinearBefore = linears().at(-1);
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h, 5000);

    const at = bpLog.length;
    h.video.readyState = 4;
    h.video.fire('playing');
    await run(h, 2500);
    const after = sustainedLevels();
    for (const k of EVERY_SUSTAINED) expect(after[k], `${k} came back`).toBeGreaterThan(0);
    // The first position command after the stall is the one it was moving to.
    expect(linears(at)[0].slice(1, 3)).toEqual(lastLinearBefore.slice(1, 3));
  });

  it('a clock that stops with NO event (a frozen decoder) holds within about a second, and moving again releases it', async () => {
    const h = await playing();
    const at = bpLog.length;
    h.frozen = true;
    await run(h, 1500);
    const held = sustainedLevels();
    for (const k of EVERY_SUSTAINED) expect(held[k]).toBe(0);
    expect(stopAlls(at)).toEqual([]);

    h.frozen = false;   // no 'playing': the clock just moves
    await run(h, 2500);
    const back = sustainedLevels();
    for (const k of EVERY_SUSTAINED) expect(back[k]).toBeGreaterThan(0);
  });

  it('a seek while playing that lands inside the grace window turns nothing off; a real pause still stops everything (stopAll)', async () => {
    const h = await playing();
    const hold = vi.spyOn(h.sync.buttplug, 'stopSustainedOutputs');
    h.video.seeking = true;
    h.video.fire('seeking');
    await run(h, 200);                 // FN-05: inside the window
    for (const k of EVERY_SUSTAINED) expect(sustainedLevels()[k]).toBeGreaterThan(0);
    h.video.seeking = false;
    h.video.fire('seeked');
    h.video.fire('playing');
    await run(h, 2500);
    for (const k of EVERY_SUSTAINED) expect(sustainedLevels()[k]).toBeGreaterThan(0);
    // The stall hold never fired (the seek's own ramp restart is the seek's).
    expect(hold, 'a short seek turned the sustained outputs off').not.toHaveBeenCalled();

    const at = bpLog.length;
    h.video.paused = true;
    h.video.fire('pause');
    expect(stopAlls(at)).toHaveLength(1);
  });
});

describe('FN-02 inline: T-Code intensity channels go to 0 on a stall, position axes are not stopped, centred or snapped', () => {
  async function playing() {
    const video = new FakeVideo();
    const h = { video, frozen: false };
    h.sync = await tcodeSync(playerOf(video));
    video.paused = false;
    video.fire('playing');
    await run(h, 3000, 16);
    return h;
  }

  it('waiting: one frame turns V0 (scripted) and V1 (generated) off; no DSTOP, no rest frame, nothing more all stall long', async () => {
    const h = await playing();
    expect(sendsOf('V0').at(-1).value).toBeGreaterThan(0);
    expect(sendsOf('V1').at(-1).value).toBeGreaterThan(0);
    expect(sendsOf('R0').length, 'the generated twist was driven').toBeGreaterThan(0);

    const at = lines.length;
    h.video.readyState = 2;
    h.video.fire('waiting');
    await vi.advanceTimersByTimeAsync(0);
    // FN-05: past the grace window, not at once. Inside it the tick ran as
    // it always did (a keyframe move due on the frozen clock may go); then
    // the hold's one frame.
    await run(h, STALL_GRACE_MS + 20, 16);
    expect(lines.slice(at).at(-1)).toBe('V0000 V1000\n');
    expect(lines.slice(at).filter((l) => /V0000|V1000/.test(l))).toEqual(['V0000 V1000\n']);
    const atHold = lines.length;

    await run(h, 5000, 16);
    expect(lines.slice(atHold), 'nothing is sent while the picture stands').toEqual([]);
    expect(lines.slice(at).some((l) => /DSTOP|L0500(?!I)/.test(l))).toBe(false);
  });

  it('playing: V0 and V1 come back; the stroke resumes with a normal move, not the one-tick snap a seek needs', async () => {
    const h = await playing();
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h, 5000, 16);

    const at = lines.length;
    h.video.readyState = 4;
    h.video.fire('playing');
    await run(h, 1500, 16);
    expect(sendsOf('V0', at).some((s) => s.value > 0)).toBe(true);
    expect(sendsOf('V1', at).some((s) => s.value > 0)).toBe(true);
    const firstStroke = sendsOf('L0', at)[0];
    expect(firstStroke.interval, `L0 snapped over one tick (I${TICK_MS}) after the stall`).toBeGreaterThan(100);
  });

  it('an intensity channel the user switched off is left alone', async () => {
    const h = await playing();
    h.sync.setAxisEnabled('V0', false);
    const at = lines.length;
    h.video.readyState = 2;
    h.video.fire('waiting');
    await run(h, STALL_GRACE_MS + 20, 16);   // FN-05: past the window
    expect(lines.slice(at).at(-1)).toBe('V1000\n');
    expect(lines.slice(at).some((l) => /V0000/.test(l))).toBe(false);
  });
});

describe('FN-02 pop-out: the window\'s stall reaches the engines as a pause, and holds them instead of stopping them', () => {
  // The player pop-out ticks {at, paused, stalled} every 100 ms (N-01); the
  // REAL RemotePlaybackProxy turns `stalled` into 'pause' / 'playing'.
  async function popout() {
    const proxy = new RemotePlaybackProxy();
    const player = proxy.asVideoPlayerWrapper();
    const h = { proxy, at: 0, stalled: false, paused: false };
    h.bp = buttplugSync(player);
    h.tc = await tcodeSync(player);
    h.tick = async (ms) => {
      for (let t = 0; t < ms; t += 100) {
        if (!h.paused && !h.stalled) h.at += 100;
        proxy.updateState({ at: h.at, paused: h.paused, stalled: h.stalled, duration: 600 });
        await vi.advanceTimersByTimeAsync(100);
      }
    };
    await h.tick(3000);
    return h;
  }

  it('stalled: sustained outputs off, no stopAll, no DSTOP and no rest frame; moving again brings them back', async () => {
    const h = await popout();
    const bpAt = bpLog.length;
    const tcAt = lines.length;
    h.stalled = true;
    await h.tick(3000);
    for (const k of EVERY_SUSTAINED) expect(sustainedLevels()[k]).toBe(0);
    expect(stopAlls(bpAt), 'stopAll on a pop-out stall (every pop-out seek)').toEqual([]);
    expect(lines.slice(tcAt)).toEqual(['V0000 V1000\n']);

    const tcBack = lines.length;
    h.stalled = false;
    await h.tick(2500);
    for (const k of EVERY_SUSTAINED) expect(sustainedLevels()[k]).toBeGreaterThan(0);
    expect(sendsOf('V0', tcBack).some((s) => s.value > 0)).toBe(true);
    expect(sendsOf('L0', tcBack)[0].interval).toBeGreaterThan(100);
  });

  it('a real pause in the pop-out still stops everything (stopAll, DSTOP)', async () => {
    const h = await popout();
    const bpAt = bpLog.length;
    const tcAt = lines.length;
    h.paused = true;
    await h.tick(300);
    expect(stopAlls(bpAt)).toHaveLength(1);
    expect(lines.slice(tcAt).some((l) => l.startsWith('DSTOP'))).toBe(true);
  });
});

describe('FN-02 headset: a time that stands still while the headset says playing is a stall', () => {
  /** Packets every `everyMs` (HereSphere's default interval is 1 s). */
  function headset({ everyMs = 100 } = {}) {
    const proxy = new VRPlaybackProxy();
    const events = [];
    for (const type of ['pause', 'playing', 'seeked', 'ended']) proxy.addEventListener(type, () => events.push(type));
    const h = { proxy, events, t: 0, frozen: false, playerState: 0 };
    h.feed = async (ms) => {
      for (let w = 0; w < ms; w += everyMs) {
        if (!h.frozen && h.playerState === 0) h.t += everyMs / 1000;
        proxy.updateFromVR({ currentTime: h.t, duration: 600, playerState: h.playerState, playbackSpeed: 1 });
        await vi.advanceTimersByTimeAsync(everyMs);
      }
    };
    return h;
  }

  it('frozen for 2 s: \'pause\' with stalled true and sourcePaused false, the clock held at the reported time; moving: \'playing\'', async () => {
    const h = headset();
    await h.feed(3000);
    expect(h.proxy.paused).toBe(false);
    h.events.length = 0;

    h.frozen = true;
    const frozenAt = h.t;
    await h.feed(1800);
    expect(h.events, 'not before two seconds').not.toContain('pause');
    await h.feed(400);
    expect(h.events).toContain('pause');
    expect(h.proxy.stalled).toBe(true);
    expect(h.proxy.sourcePaused).toBe(false);
    expect(h.proxy.paused).toBe(true);
    await h.feed(3000);
    expect(Math.abs(h.proxy.currentTime - frozenAt), 'the clock ran on through the stall').toBeLessThan(0.05);

    h.events.length = 0;
    h.frozen = false;
    await h.feed(300);
    expect(h.events).toEqual(['playing']);
    expect(h.proxy.stalled).toBe(false);
    expect(h.proxy.paused).toBe(false);
  });

  it('normal playback at one packet a second is never a stall, and a headset that is PAUSED is paused, not stalled', async () => {
    const h = headset({ everyMs: 1000 });
    await h.feed(20000);
    expect(h.events).toEqual(['playing']);
    h.playerState = 1;
    await h.feed(5000);
    expect(h.events).toEqual(['playing', 'pause']);
    expect(h.proxy.stalled).toBe(false);
    expect(h.proxy.sourcePaused).toBe(true);
  });

  it('every device on the headset: the Handy stops and re-anchors where it froze, sustained Buttplug and T-Code outputs go off and come back', async () => {
    const h = headset();
    const vr = h.proxy;
    const player = { video: vr, get currentTime() { return vr.currentTime; }, get paused() { return vr.paused; }, get duration() { return vr.duration; } };
    const bp = buttplugSync(player);
    const tc = await tcodeSync(player);
    const handy = new HandyManager();
    await handy.init();
    handy._connected = true;
    handy._connectionKey = 'TESTKEY01';
    handy._mode = 1;
    const hssp = [];
    mockHandy.hsspPlay.mockImplementation(async (start) => { hssp.push(['play', start]); return { result: 0 }; });
    mockHandy.hsspStop.mockImplementation(async () => { hssp.push(['stop']); return { result: 0 }; });
    const engine = new SyncEngine({ videoPlayer: player, handyManager: handy, funscriptEngine: { isLoaded: true } });
    engine._scriptReady = true;
    engine.start();

    await h.feed(3000);
    for (const k of EVERY_SUSTAINED) expect(sustainedLevels()[k]).toBeGreaterThan(0);
    expect(hssp.at(-1)[0]).toBe('play');

    const bpAt = bpLog.length;
    const tcAt = lines.length;
    h.frozen = true;
    const frozenMs = Math.round(h.t * 1000);
    await h.feed(4000);
    expect(hssp.at(-1), 'the Handy ran on through a headset stall').toEqual(['stop']);
    for (const k of EVERY_SUSTAINED) expect(sustainedLevels()[k]).toBe(0);
    expect(stopAlls(bpAt)).toEqual([]);
    // Up to the 2 s it takes to call it a stall the proxy still says playing;
    // from then on: one frame turning the intensities off, and nothing else.
    const zero = lines.indexOf('V0000 V1000\n', tcAt);
    expect(zero).toBeGreaterThan(-1);
    expect(lines.slice(zero + 1)).toEqual([]);
    expect(lines.slice(tcAt).some((l) => /DSTOP|L0500(?!I)/.test(l))).toBe(false);

    const stoppedAt = hssp.length;
    h.frozen = false;
    await h.feed(2500);
    // The first play after the stall's stop: where the picture froze.
    const resume = hssp.slice(stoppedAt).find((c) => c[0] === 'play');
    expect(Math.abs(resume[1] - frozenMs)).toBeLessThan(400);
    for (const k of EVERY_SUSTAINED) expect(sustainedLevels()[k]).toBeGreaterThan(0);
    engine.stop();
    bp.stop();
    tc.stop();
  });
});
