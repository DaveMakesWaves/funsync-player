// VR companion reconnect lifecycle (app test 2026-11-02: V19, V20, V21, V24).
//
// jsdom on purpose (no node docblock): vr-bridge.js imports i18n.js, which
// branches on `typeof window`, and the timestamp-server hint builds DOM.
// See notes/CLAUDE.md "Test environments".
//
// The REAL VRBridge runs against a fake main process that behaves like
// preload.js + vr-socket.js: one ipcRenderer-style listener per on*() call,
// a dial that succeeds only when something is listening on that host, and a
// `vr-disconnected` broadcast when the headset's socket closes. The REAL
// app.js reconnect methods are lifted out of the source (app.js instantiates
// itself on import, see tests/unit/helpers/app-methods.js) and driven tick by
// tick on a fake clock. What is asserted is what the user would see: which
// hosts got dialed, whether the link came back, what got saved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VRBridge } from '../../renderer/js/vr-bridge.js';
import { liftAppClass } from './helpers/app-methods.js';

const METHODS = [
  '_wireVRBridgeCallbacks',
  '_attemptSavedHostReconnect',
  '_announceVRLink',
  '_vrRetryBackoffMs',
  '_pollVRActivity',
  '_retryVRReconnect',
  '_maybeShowTimestampServerHint',
  '_dismissTimestampServerHint',
];

const NO_ACTIVITY = { clientIp: null, videoId: null, timestamp: 0 };

/**
 * One timestamp packet from a headset that is playing. Since FT-054 a link
 * counts as working (backoff reset, saved host, toast) from its first packet,
 * not from the TCP connect, so a test of a WORKING link sends one.
 */
const PLAYING_PACKET = { path: '/storage/emulated/0/VR/Scene.mp4', currentTime: 12, duration: 600, playerState: 0, playbackSpeed: 1 };

/** A fake main process + network, shaped like preload.js's vr-* surface. */
function fakeMain() {
  const listeners = { 'vr-state': [], 'vr-disconnected': [] };
  const remove = (list, h) => { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); };
  const net = {
    listening: new Set(), // hosts whose timestamp server accepts a dial
    dials: [],            // every real dial main was asked to make, in order
    gate: null,           // when set, dials wait on it (a slow ECONNREFUSED)
    listeners,
    /** The headset's socket closed: main broadcasts vr-disconnected. */
    drop() { for (const h of [...listeners['vr-disconnected']]) h({}); },
    /** One timestamp packet from the headset. */
    packet(data) { for (const h of [...listeners['vr-state']]) h({}, data); },
  };
  window.funsync = {
    vrConnect: vi.fn(async (host, port) => {
      net.dials.push(host);
      if (net.gate) await net.gate;
      return net.listening.has(host)
        ? { success: true }
        : { success: false, error: `connect ECONNREFUSED ${host}:${port}` };
    }),
    vrDisconnect: vi.fn(async () => ({ success: true })),
    vrSend: vi.fn(),
    // preload: a fresh wrapper per call, removed by the returned function
    onVrState(cb) {
      const h = (_event, data) => cb(data);
      listeners['vr-state'].push(h);
      return () => remove(listeners['vr-state'], h);
    },
    onVrDisconnected(cb) {
      listeners['vr-disconnected'].push(cb);
      return () => remove(listeners['vr-disconnected'], cb);
    },
  };
  return net;
}

/** performance.now() and Date.now() on one fake clock the test advances. */
function fakeClock() {
  const clock = { t: 50_000, wallBase: 1_800_000_000_000 };
  clock.perf = { now: () => clock.t };
  clock.date = { now: () => clock.wallBase + clock.t };
  clock.wallSeconds = () => (clock.wallBase + clock.t) / 1000;
  return clock;
}

function fakeSettings(initial = {}) {
  const store = { ...initial };
  return { store, get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
}

let net;
let clock;
let backend;   // what /api/media/vr-activity answers
let toasts;
let apps;

/** `fetch` defaults to a backend answering `backend.activity`. */
function makeApp(settings = {}, { fetch } = {}) {
  const LiftedApp = liftAppClass(METHODS, {
    showToast: (message, type, duration) => {
      const toast = { message, type, duration, dismissed: false, dismiss() { this.dismissed = true; } };
      toasts.push(toast);
      return toast;
    },
    t: (key) => key,
    fetch: fetch || (async () => ({ ok: true, json: async () => ({ ...backend.activity }) })),
    performance: clock.perf,
    Date: clock.date,
  });
  const app = new LiftedApp();
  app.vrBridge = new VRBridge();
  app.settings = fakeSettings(settings);
  app._updateDeviceIndicators = () => {};
  app._stopVRSync = () => {};
  app._onVRVideoChanged = () => {};
  app._maybeApplyVrOffsetPreset = () => {};
  app._lastVrActivityTs = 0;
  app._wireVRBridgeCallbacks();
  apps.push(app);
  return app;
}

/** One 2 s activity-poll tick, as the interval in init() fires it. */
async function tick(app, ms = 2000) {
  clock.t += ms;
  await app._pollVRActivity();
}

/** Tick until the bridge is connected, at most `max` ticks. */
async function tickUntilConnected(app, max = 6) {
  for (let i = 0; i < max && !app.vrBridge.connected; i++) await tick(app);
  return app.vrBridge.connected;
}

beforeEach(() => {
  net = fakeMain();
  clock = fakeClock();
  backend = { activity: { ...NO_ACTIVITY } };
  toasts = [];
  apps = [];
});

afterEach(() => {
  for (const app of apps) app.vrBridge._stopLivenessWatchdog();
  vi.useRealTimers();
  delete window.funsync;
});

describe('V19: every successful connect arms the quiet-endpoint retry', () => {
  it('re-dials a host connected through the VR modal after the headset drops (PCVR loopback: no activity is ever recorded)', async () => {
    const app = makeApp();
    net.listening.add('127.0.0.1');
    // What vr-modal.js's Connect button does; the headset talks.
    expect(await app.vrBridge.connect('heresphere', '127.0.0.1', 23554)).toBe(true);
    net.packet(PLAYING_PACKET);

    // HereSphere is closed: the socket drops and nothing is listening.
    net.listening.delete('127.0.0.1');
    net.drop();
    expect(app.vrBridge.connected).toBe(false);
    const dialsAtDrop = net.dials.length;
    await tick(app);
    expect(net.dials.length).toBeGreaterThan(dialsAtDrop); // it is trying

    // HereSphere comes back.
    net.listening.add('127.0.0.1');
    expect(await tickUntilConnected(app)).toBe(true);
    expect(net.dials.slice(dialsAtDrop).every((h) => h === '127.0.0.1')).toBe(true);
  });

  it('re-dials the saved host from startup after a liveness timeout', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    net.listening.add('192.168.1.50');
    await app._attemptSavedHostReconnect();
    expect(app.vrBridge.connected).toBe(true);
    net.packet(PLAYING_PACKET); // a working link: it was playing

    // The headset goes quiet: socket open, no packets. The bridge's 8 s
    // watchdog tears the link down.
    app.vrBridge._lastArrivalMs = Date.now() - 9000;
    vi.advanceTimersByTime(1100);
    expect(app.vrBridge.connected).toBe(false);

    // HereSphere talks again; the activity endpoint stays quiet.
    const dialsAtDrop = net.dials.length;
    expect(await tickUntilConnected(app)).toBe(true);
    expect(net.dials.slice(dialsAtDrop)).toEqual(['192.168.1.50']);
  });

  it('re-dials after the toast\'s Try again connected', async () => {
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    net.listening.add('192.168.1.50');
    app._maybeShowTimestampServerHint('connect ECONNREFUSED 192.168.1.50:23554', '192.168.1.50');
    const tryAgain = toasts.at(-1).message.querySelector('button');
    tryAgain.click();
    await vi.waitFor(() => expect(app.vrBridge.connected).toBe(true));
    net.packet(PLAYING_PACKET);

    net.drop();
    expect(await tickUntilConnected(app)).toBe(true);
  });

  it('does not undo a deliberate Disconnect', async () => {
    const app = makeApp();
    net.listening.add('127.0.0.1');
    await app.vrBridge.connect('heresphere', '127.0.0.1', 23554);
    await app.vrBridge.disconnect(); // the VR modal's Disconnect button

    const dialsAtDisconnect = net.dials.length;
    for (let i = 0; i < 6; i++) await tick(app);
    expect(net.dials.length).toBe(dialsAtDisconnect);
    expect(app.vrBridge.connected).toBe(false);
  });

  // Was "a successful connect resets the retry backoff": since FT-054 a link
  // resets it from its first PACKET, so the reconnect here sends one.
  it('a working link resets the retry backoff', async () => {
    const app = makeApp();
    net.listening.add('127.0.0.1');
    await app.vrBridge.connect('heresphere', '127.0.0.1', 23554);
    net.packet(PLAYING_PACKET);

    // A long outage: enough failed retries to reach the 8 s backoff.
    net.listening.delete('127.0.0.1');
    net.drop();
    for (let i = 0; i < 4; i++) await tick(app);

    // The user reconnects by hand, then the headset drops once more and is
    // straight back. The very next 2 s tick must find it: the old failures
    // belong to a link that has since worked.
    net.listening.add('127.0.0.1');
    await app.vrBridge.connect('heresphere', '127.0.0.1', 23554);
    net.packet(PLAYING_PACKET);
    net.drop();
    await tick(app);
    expect(app.vrBridge.connected).toBe(true);
  });

  it('a link that accepted and never sent a packet does not reset it (FT-054)', async () => {
    const app = makeApp();
    net.listening.add('127.0.0.1');
    await app.vrBridge.connect('heresphere', '127.0.0.1', 23554);
    net.packet(PLAYING_PACKET);
    net.listening.delete('127.0.0.1');
    net.drop();
    for (let i = 0; i < 4; i++) await tick(app);   // 8 s backoff reached

    net.listening.add('127.0.0.1');
    await app.vrBridge.connect('heresphere', '127.0.0.1', 23554); // silent
    net.drop();
    const dials = net.dials.length;
    await tick(app);
    expect(net.dials.length).toBe(dials);           // still backing off
  });
});

describe('V20: a reconnect never stacks a second set of IPC listeners', () => {
  const PACKET = { path: '/storage/emulated/0/VR/Scene.mp4', currentTime: 12, duration: 600, playerState: 0, playbackSpeed: 1 };

  it('after socket drops and reconnects, each packet is handled once', async () => {
    const bridge = new VRBridge();
    net.listening.add('127.0.0.1');
    for (let i = 0; i < 3; i++) {
      await bridge.connect('heresphere', '127.0.0.1', 23554);
      if (i < 2) net.drop();
    }
    const feed = vi.spyOn(bridge.proxy, 'updateFromVR');
    net.packet(PACKET);
    expect(feed).toHaveBeenCalledTimes(1);
    expect(net.listeners['vr-state']).toHaveLength(1);
    expect(net.listeners['vr-disconnected']).toHaveLength(1);
    bridge._stopLivenessWatchdog();
  });

  it('after a liveness-watchdog teardown and reconnect, each packet is handled once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const bridge = new VRBridge();
    net.listening.add('127.0.0.1');
    await bridge.connect('heresphere', '127.0.0.1', 23554);
    bridge._lastArrivalMs = Date.now() - 9000;
    vi.advanceTimersByTime(1100);
    expect(bridge.connected).toBe(false);

    await bridge.connect('heresphere', '127.0.0.1', 23554);
    const feed = vi.spyOn(bridge.proxy, 'updateFromVR');
    net.packet(PACKET);
    expect(feed).toHaveBeenCalledTimes(1);
    bridge._stopLivenessWatchdog();
  });

  it('after a deliberate Disconnect, a stray packet changes nothing', async () => {
    const bridge = new VRBridge();
    const videoChanged = vi.fn();
    bridge.onVideoChanged = videoChanged;
    net.listening.add('127.0.0.1');
    await bridge.connect('heresphere', '127.0.0.1', 23554);
    net.drop();
    await bridge.connect('heresphere', '127.0.0.1', 23554);
    await bridge.disconnect();

    // A raw link still delivering packets (the tester's repro): the app must
    // not load a VR script for a video while VR is disconnected.
    const feed = vi.spyOn(bridge.proxy, 'updateFromVR');
    net.packet(PACKET);
    expect(videoChanged).not.toHaveBeenCalled();
    expect(feed).not.toHaveBeenCalled();
    expect(net.listeners['vr-state']).toHaveLength(0);
    expect(net.listeners['vr-disconnected']).toHaveLength(0);
  });
});

describe('V21: stale headset activity never overrides the host the user connected to', () => {
  const sceneRequestFrom = (ip) => ({ clientIp: ip, videoId: '9758fd2293ed', timestamp: clock.wallSeconds() });

  it('a scene request from before a manual connect neither replaces nor out-dials the connected host', async () => {
    // The verifier's repro: something at the PC's LAN IP fetched /deovr,
    // nothing listens there; the user then connects to PCVR on loopback.
    backend.activity = sceneRequestFrom('192.168.1.202');
    clock.t += 1000;
    const app = makeApp();
    net.listening.add('127.0.0.1');
    await app.vrBridge.connect('heresphere', '127.0.0.1', 23554);
    net.packet(PLAYING_PACKET);

    net.drop(); // HereSphere resets the socket, and is still listening
    const dialsAtDrop = net.dials.length;
    expect(await tickUntilConnected(app)).toBe(true);
    expect(app.settings.get('vr.lastHost')).toBe('127.0.0.1');
    expect(net.dials.slice(dialsAtDrop)).not.toContain('192.168.1.202');
  });

  it('a failed auto-connect leaves the saved host alone, and its hint retries the IP it names', async () => {
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    backend.activity = sceneRequestFrom('192.168.1.99'); // nothing listening there
    await tick(app);
    expect(net.dials).toEqual(['192.168.1.99']);
    expect(app.settings.get('vr.lastHost')).toBe('192.168.1.50');

    const hint = toasts.find((x) => x.message instanceof HTMLElement);
    expect(hint).toBeTruthy();
    hint.message.querySelector('button').click();
    await vi.waitFor(() => expect(net.dials).toHaveLength(2));
    expect(net.dials[1]).toBe('192.168.1.99');
  });

  it('a scene request from before a deliberate Disconnect does not reconnect; a new one does', async () => {
    const app = makeApp();
    net.listening.add('192.168.1.77');
    backend.activity = sceneRequestFrom('192.168.1.77');
    await tick(app);
    expect(app.vrBridge.connected).toBe(true); // auto-connect still works

    // While connected the user picks another video in the headset (a scene
    // request NEWER than the connect), then presses Disconnect.
    clock.t += 30_000;
    backend.activity = sceneRequestFrom('192.168.1.77');
    clock.t += 30_000;
    await app.vrBridge.disconnect(); // the VR modal's Disconnect
    const dialsAtDisconnect = net.dials.length;
    for (let i = 0; i < 6; i++) await tick(app);
    expect(net.dials.length).toBe(dialsAtDisconnect);
    expect(app.vrBridge.connected).toBe(false);

    // The user picks another video in the headset.
    backend.activity = sceneRequestFrom('192.168.1.77');
    await tick(app);
    expect(app.vrBridge.connected).toBe(true);
  });

  it('a scene request newer than the last connect still moves to the new IP (DHCP change)', async () => {
    const app = makeApp();
    net.listening.add('192.168.1.77');
    backend.activity = sceneRequestFrom('192.168.1.77');
    await tick(app);
    expect(app.vrBridge.connected).toBe(true);

    // The Quest comes back on a new lease and picks a scene.
    net.listening.delete('192.168.1.77');
    net.drop();
    clock.t += 1000;
    net.listening.add('192.168.1.78');
    backend.activity = sceneRequestFrom('192.168.1.78');
    expect(await tickUntilConnected(app)).toBe(true);
    expect(app.vrBridge.host).toBe('192.168.1.78');
    net.packet(PLAYING_PACKET); // saved once the new link talks (FT-054)
    expect(app.settings.get('vr.lastHost')).toBe('192.168.1.78');
  });
});

describe('V24: a tick that lands on an in-flight dial is not a failed attempt', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Dials that refuse only when the test says so: a refused dial to a LAN IP
   * takes about 2 s on Windows (measured 2019-2043 ms), the same as the poll
   * interval, so the next tick fires while it is still in flight.
   */
  function slowRefusals() {
    const pending = [];
    window.funsync.vrConnect = vi.fn((host, port) => {
      net.dials.push(host);
      return new Promise((resolve) => pending.push({
        at: clock.t,
        refuse: () => resolve({ success: false, error: `connect ECONNREFUSED ${host}:${port}` }),
      }));
    });
    const dialTimes = () => pending.map((d) => d.at);
    /** Refuse every dial made before `t`. */
    const refuseBefore = (t) => { for (const d of pending) if (d.at < t && !d.done) { d.done = true; d.refuse(); } };
    return { dialTimes, refuseBefore };
  }

  it('makes three real dials at the 2 s cadence before backing off to 8 s', async () => {
    const app = makeApp();
    backend.activity = { clientIp: '192.168.1.202', videoId: '9758fd2293ed', timestamp: clock.wallSeconds() };
    const dials = slowRefusals();
    const start = clock.t;
    const ticks = [];
    for (let i = 0; i < 10; i++) {
      clock.t += 2000;
      ticks.push(app._pollVRActivity());
      await settle();
      dials.refuseBefore(clock.t); // the previous dial's refusal lands after this tick fired
      await settle();
    }
    dials.refuseBefore(Infinity);
    await Promise.all(ticks);
    // Before the fix the tick at +4 s joined dial #1 and counted it as a
    // second failure, so the third dial waited for the 8 s backoff (+16 s).
    expect(dials.dialTimes().slice(0, 3).map((t) => t - start)).toEqual([2000, 6000, 10000]);
  });

  it('a stalled backend does not pile up activity polls', async () => {
    // A busy backend can hold a request for many seconds (a 25.8 s /health
    // silence during a scan is on record); ticks must not stack behind it.
    let fetches = 0;
    let answer;
    const app = makeApp({}, {
      fetch: () => { fetches++; return new Promise((r) => { answer = r; }); },
    });
    const ticks = [];
    for (let i = 0; i < 5; i++) { clock.t += 2000; ticks.push(app._pollVRActivity()); await settle(); }
    expect(fetches).toBe(1);
    answer({ ok: true, json: async () => ({ ...NO_ACTIVITY }) });
    await Promise.all(ticks);
  });

  it('never shows the timestamp-server hint for an IP it has not dialed', async () => {
    // The saved host from last session is being dialed at startup (slow)
    // when a scene request arrives from the Quest's new IP.
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    const dials = slowRefusals();
    const startup = app._attemptSavedHostReconnect();
    await settle();
    backend.activity = { clientIp: '192.168.1.99', videoId: '9758fd2293ed', timestamp: clock.wallSeconds() };

    const first = tick(app);
    await settle();
    dials.refuseBefore(Infinity); // the startup dial to .50 is refused
    await first;
    await startup;
    // The tick must not have adopted .50's refusal as .99's.
    expect(net.dials).toEqual(['192.168.1.50']);
    expect(toasts.filter((x) => x.message instanceof HTMLElement)).toHaveLength(0);

    // Next tick: .99 is dialed for real, and only its own refusal hints.
    const second = tick(app);
    await settle();
    dials.refuseBefore(Infinity);
    await second;
    expect(net.dials).toEqual(['192.168.1.50', '192.168.1.99']);
    expect(toasts.filter((x) => x.message instanceof HTMLElement)).toHaveLength(1);
  });
});

// FT-054 (2026-11-06, also in v0.9.2): a host that accepts the TCP connect and
// never sends a packet flapped every ~10 s for ever: the connect counted as a
// working link (backoff reset, "VR companion reconnected" toast, saved host),
// the 8 s watchdog dropped it and the retry re-dialed 2 s later. Now a link
// counts from its first packet, and a teardown of one that never received is
// a failed attempt timed from the teardown, backing off to a 30 s cap.
//
// The REAL bridge's watchdog runs on fake timers (its interval and Date.now),
// and the lifted app's clock moves with it, one second at a time, with the
// activity poll on every 2 s tick as init() schedules it.
describe('FT-054: a headset that accepts but never sends', () => {
  const reconnectedToasts = () => toasts.filter((x) => x.message === 'toast.vrReconnected' || x.message === 'toast.vrConnected');

  function recordDialTimes() {
    const times = [];
    const dial = window.funsync.vrConnect;
    window.funsync.vrConnect = vi.fn(async (...args) => { times.push(clock.t); return dial(...args); });
    return times;
  }

  /** `seconds` one-second steps; the 2 s activity poll fires on even seconds. */
  async function run(app, seconds) {
    for (let s = 1; s <= seconds; s++) {
      clock.t += 1000;
      vi.advanceTimersByTime(1000);
      if (Math.round(clock.t / 1000) % 2 === 0) await app._pollVRActivity();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  });

  it('over 120 s: a few dials with growing gaps, no toast, and the saved host is kept', async () => {
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    net.listening.add('192.168.1.50');   // accepts; the test never sends a packet
    const dialTimes = recordDialTimes();
    const start = clock.t;
    await app._attemptSavedHostReconnect();
    await run(app, 120);

    const at = dialTimes.map((t) => (t - start) / 1000);
    // Before the fix: a dial every ~10 s (12 in 120 s) and a toast on each.
    expect(at.length).toBeLessThanOrEqual(6);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(30);
    expect(reconnectedToasts()).toHaveLength(0);
    expect(app.settings.get('vr.lastHost')).toBe('192.168.1.50');
  });

  it('the first packet: exactly one toast, and the backoff is reset', async () => {
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    net.listening.add('192.168.1.50');
    const dialTimes = recordDialTimes();
    await app._attemptSavedHostReconnect();
    await run(app, 120);                       // silent: backed off
    expect(reconnectedToasts()).toHaveLength(0);

    // Wait for the next dial (at most the 30 s cap away), then the headset talks.
    const dials = dialTimes.length;
    for (let s = 0; s < 40 && dialTimes.length === dials; s++) await run(app, 1);
    expect(dialTimes.length).toBe(dials + 1);
    expect(app.vrBridge.connected).toBe(true);
    net.packet({ ...PLAYING_PACKET, _arrivalMs: Date.now() });
    net.packet({ ...PLAYING_PACKET, _arrivalMs: Date.now() });
    expect(reconnectedToasts().map((x) => x.message)).toEqual(['toast.vrReconnected']);

    // A drop now is a working link's drop: the very next 2 s tick re-dials.
    net.drop();
    const before = dialTimes.length;
    clock.t += 2000;
    vi.advanceTimersByTime(2000);
    await app._pollVRActivity();
    expect(dialTimes.length).toBe(before + 1);
  });

  it('a modal connect to a host that never sends does not replace the saved host', async () => {
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    net.listening.add('192.168.1.60');
    await app.vrBridge.connect('heresphere', '192.168.1.60', 23554); // the VR modal's Connect
    await run(app, 9);                          // the watchdog drops it
    expect(app.vrBridge.connected).toBe(false);
    expect(app.settings.get('vr.lastHost')).toBe('192.168.1.50');

    // The same host, talking this time: now it is the saved one.
    await app.vrBridge.connect('heresphere', '192.168.1.60', 23554);
    net.packet({ ...PLAYING_PACKET, _arrivalMs: Date.now() });
    expect(app.settings.get('vr.lastHost')).toBe('192.168.1.60');
  });

  it('a refused dial still retries every 8 s (the headset coming back, #320), not slower', async () => {
    const app = makeApp({ 'vr.lastHost': '192.168.1.50' });
    net.listening.add('192.168.1.50');
    await app._attemptSavedHostReconnect();
    net.packet({ ...PLAYING_PACKET, _arrivalMs: Date.now() });
    net.listening.delete('192.168.1.50');       // HereSphere closed
    net.drop();
    const dialTimes = recordDialTimes();
    await run(app, 80);
    const gaps = dialTimes.slice(1).map((t, i) => (t - dialTimes[i]) / 1000);
    expect(gaps.slice(3).every((g) => g === 8)).toBe(true);
    expect(gaps.length).toBeGreaterThanOrEqual(8);
  });
});
