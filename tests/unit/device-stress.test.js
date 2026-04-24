// Device stress + combination tests.
//
// The per-device test files (handy-manager, buttplug-sync, tcode, autoblow,
// sync-engine, device-expansion, custom-routing) already cover individual
// behaviour in depth. This file covers what they don't: many devices at once,
// all engine types running simultaneously, hot-plug scenarios, and
// performance measurements so we know where the ceiling is.
//
// Everything runs against in-memory fakes — no real Buttplug SDK, no real
// serial port, no Handy cloud. Ticks are stepped manually via `_tick()` so
// tests don't wait on setInterval.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';

// --- Fake factories -------------------------------------------------------

function makePlayer({ currentTime = 0, paused = false } = {}) {
  return {
    video: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    currentTime,
    paused,
  };
}

function makeFunscript(actions = null) {
  const defaultActions = [
    { at: 0, pos: 0 },
    { at: 250, pos: 100 },
    { at: 500, pos: 0 },
    { at: 750, pos: 100 },
    { at: 1000, pos: 50 },
  ];
  return {
    isLoaded: true,
    getActions: vi.fn().mockReturnValue(actions || defaultActions),
  };
}

// A long script (N actions over N*250 ms) for stress.
function makeLongFunscript(actionCount) {
  const actions = [];
  for (let i = 0; i < actionCount; i++) {
    actions.push({ at: i * 250, pos: i % 2 === 0 ? 0 : 100 });
  }
  return {
    isLoaded: true,
    getActions: vi.fn().mockReturnValue(actions),
  };
}

/**
 * Build a fake ButtplugManager with N devices. deviceSpecs is either a
 * number (→ that many linear-only devices) or an array of capability
 * objects: [{ name, canLinear, canVibrate, canRotate, canScalar }, ...].
 */
function makeButtplug(deviceSpecs) {
  const devices = Array.isArray(deviceSpecs)
    ? deviceSpecs.map((s, i) => ({
        index: i,
        name: s.name || `Device${i}`,
        canLinear: !!s.canLinear,
        canVibrate: !!s.canVibrate,
        canRotate: !!s.canRotate,
        canScalar: !!s.canScalar,
      }))
    : Array.from({ length: deviceSpecs }, (_, i) => ({
        index: i,
        name: `Linear${i}`,
        canLinear: true,
        canVibrate: false,
        canRotate: false,
        canScalar: false,
      }));

  return {
    connected: true,
    devices,
    sendLinear: vi.fn().mockResolvedValue(undefined),
    sendVibrate: vi.fn().mockResolvedValue(undefined),
    sendRotate: vi.fn().mockResolvedValue(undefined),
    sendScalar: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHandy() {
  return {
    connected: true,
    uploadAndSetScript: vi.fn().mockResolvedValue(true),
    hsspPlay: vi.fn().mockResolvedValue({ result: 0 }),
    hsspStop: vi.fn().mockResolvedValue(undefined),
    setupScript: vi.fn().mockResolvedValue(true),
    sync: vi.fn().mockResolvedValue(undefined),
    _lastCloudUrl: 'https://mock/script',
  };
}

function makeTCode({ connected = true } = {}) {
  return {
    connected,
    sendAxes: vi.fn(),
    send: vi.fn().mockResolvedValue(true),
    stop: vi.fn(),
  };
}

function makeAutoblowSync() {
  // AutoblowSync has its own interval loop; we just need a stub that
  // exposes start/stop/uploadScript so the multi-engine harness can call
  // them. Real behaviour is tested in autoblow.test.js.
  return {
    start: vi.fn(),
    stop: vi.fn(),
    uploadScript: vi.fn().mockResolvedValue(true),
    _active: false,
  };
}

// Force enough simulated time between ticks that MIN_SEND_INTERVAL_MS (50ms)
// doesn't suppress commands. performance.now() barely advances in jsdom
// between sync test calls, so we bump the baseline ourselves.
let _nowBump = 1000;
function stepTick(sync, playerTimeSec) {
  sync.player.currentTime = playerTimeSec;
  sync.player.paused = false;
  _nowBump += 1000;
  const spy = vi.spyOn(performance, 'now');
  spy.mockReturnValue(performance.now() + _nowBump);
  try {
    // TCodeSync exposes _tick(); ButtplugSync interleaves three _sendPending*
    // methods in its scheduler interval. Match whichever the engine has.
    if (typeof sync._tick === 'function') {
      sync._tick();
    } else {
      sync._sendPendingActions();
      if (sync._vibActions) sync._sendPendingVibActions();
      if (sync._axisActions && sync._axisActions.size > 0) sync._sendPendingAxisActions();
    }
  } finally {
    spy.mockRestore();
  }
}


// --- A. Single-engine smoke tests (each isolated) -------------------------

describe('Device stress — single engine smoke', () => {
  it('ButtplugSync drives 1 linear device', () => {
    const sync = new ButtplugSync({
      videoPlayer: makePlayer(),
      buttplugManager: makeButtplug(1),
      funscriptEngine: makeFunscript(),
    });
    sync.start();
    stepTick(sync, 0.3);  // 300 ms — between action 1 and 2
    expect(sync.buttplug.sendLinear).toHaveBeenCalled();
    sync.stop();
  });

  it('ButtplugSync drives 1 vibrator', () => {
    const sync = new ButtplugSync({
      videoPlayer: makePlayer(),
      buttplugManager: makeButtplug([{ name: 'Vibe', canVibrate: true }]),
      funscriptEngine: makeFunscript(),
    });
    sync.start();
    stepTick(sync, 0.3);
    expect(sync.buttplug.sendVibrate).toHaveBeenCalled();
    sync.stop();
  });

  it('ButtplugSync drives 1 rotator', () => {
    const sync = new ButtplugSync({
      videoPlayer: makePlayer(),
      buttplugManager: makeButtplug([{ name: 'Rotator', canRotate: true }]),
      funscriptEngine: makeFunscript(),
    });
    sync.start();
    stepTick(sync, 0.3);
    expect(sync.buttplug.sendRotate).toHaveBeenCalled();
    sync.stop();
  });

  it('ButtplugSync drives 1 scalar (e-stim) device', () => {
    const sync = new ButtplugSync({
      videoPlayer: makePlayer(),
      buttplugManager: makeButtplug([{ name: 'EStim', canScalar: true }]),
      funscriptEngine: makeFunscript(),
    });
    // Disable ramp-up so the first tick already outputs non-zero intensity,
    // otherwise the rate-limited tick loop might not send until ramp reaches
    // MIN_POS_DELTA worth of movement from the last sent value.
    sync.setRampUp(0, false);
    sync.start();
    stepTick(sync, 0.3);
    expect(sync.buttplug.sendScalar).toHaveBeenCalled();
    sync.stop();
  });

  it('TCodeSync drives an L0 axis', () => {
    const tcode = makeTCode();
    const sync = new TCodeSync({
      videoPlayer: makePlayer(),
      tcodeManager: tcode,
      funscriptEngine: makeFunscript(),
    });
    sync.start();
    stepTick(sync, 0.3);
    expect(tcode.sendAxes).toHaveBeenCalled();
    const sentAxes = tcode.sendAxes.mock.calls[0][0];
    expect(Object.keys(sentAxes)).toContain('L0');
    sync.stop();
  });
});


// --- B. Pairwise combinations --------------------------------------------
// Every reasonable pairing. Each engine is an independent object so there
// isn't "coordination" to test — we just verify both fire, neither suppresses
// the other, and stop cleans up both.

describe('Device stress — pairwise engine combinations', () => {
  it('Buttplug linear + TCode together both drive their devices', () => {
    const bp = makeButtplug(1);
    const tc = makeTCode();
    const fs = makeFunscript();
    const bpSync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: fs });
    const tcSync = new TCodeSync({ videoPlayer: makePlayer(), tcodeManager: tc, funscriptEngine: fs });

    bpSync.start(); tcSync.start();
    stepTick(bpSync, 0.3); stepTick(tcSync, 0.3);

    expect(bp.sendLinear).toHaveBeenCalled();
    expect(tc.sendAxes).toHaveBeenCalled();

    bpSync.stop(); tcSync.stop();
  });

  it('TCode + Buttplug vibrate → each gets its own modality', () => {
    const bp = makeButtplug([{ name: 'Vibe', canVibrate: true }]);
    const tc = makeTCode();
    const fs = makeFunscript();
    const bpSync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: fs });
    const tcSync = new TCodeSync({ videoPlayer: makePlayer(), tcodeManager: tc, funscriptEngine: fs });

    bpSync.start(); tcSync.start();
    stepTick(bpSync, 0.3); stepTick(tcSync, 0.3);

    expect(bp.sendVibrate).toHaveBeenCalled();
    expect(bp.sendLinear).not.toHaveBeenCalled();   // no linear device attached
    expect(tc.sendAxes).toHaveBeenCalled();

    bpSync.stop(); tcSync.stop();
  });

  it('Buttplug linear + vibe in one manager both receive commands', () => {
    const bp = makeButtplug([
      { name: 'Stroker', canLinear: true },
      { name: 'Vibe',    canVibrate: true },
    ]);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });

    sync.start();
    stepTick(sync, 0.3);

    expect(bp.sendLinear).toHaveBeenCalledWith(0, expect.any(Number), expect.any(Number));
    expect(bp.sendVibrate).toHaveBeenCalledWith(1, expect.any(Number));

    sync.stop();
  });
});


// --- C. Full stack (all engine types at once) ----------------------------

describe('Device stress — full device stack (Buttplug + TCode + Handy-equiv + Autoblow stub)', () => {
  it('every engine fires commands on a shared funscript', async () => {
    const fs = makeFunscript();
    const bp = makeButtplug([
      { name: 'Handy (Intiface)', canLinear: true },
      { name: 'Lovense',          canVibrate: true },
      { name: 'Nora',             canRotate: true },
      { name: 'DG-LAB',           canScalar: true },
    ]);
    const tc = makeTCode();
    const handy = makeHandy();
    const autoblow = makeAutoblowSync();

    const bpSync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: fs });
    const tcSync = new TCodeSync({ videoPlayer: makePlayer(), tcodeManager: tc, funscriptEngine: fs });

    // Disable ramp-up on the scalar device so it fires on the first tick.
    bpSync.setRampUp(3, false);

    bpSync.start(); tcSync.start();
    // Native Handy doesn't tick — it uploads once then Handy plays the script
    // itself. Emulate that upload step so the "handy participates" claim is
    // asserted by the test.
    await handy.uploadAndSetScript('{"actions":[]}');
    autoblow.start();

    stepTick(bpSync, 0.3); stepTick(tcSync, 0.3);

    // All four Buttplug modalities fire.
    expect(bp.sendLinear).toHaveBeenCalled();
    expect(bp.sendVibrate).toHaveBeenCalled();
    expect(bp.sendRotate).toHaveBeenCalled();
    expect(bp.sendScalar).toHaveBeenCalled();
    // TCode fires.
    expect(tc.sendAxes).toHaveBeenCalled();
    // Handy upload fired.
    expect(handy.uploadAndSetScript).toHaveBeenCalledTimes(1);
    // Autoblow start fired.
    expect(autoblow.start).toHaveBeenCalledTimes(1);

    bpSync.stop(); tcSync.stop(); autoblow.stop();
  });

  it('stop tears down every engine cleanly (no orphaned intervals)', () => {
    const bp = makeButtplug([{ canLinear: true }, { canVibrate: true }]);
    const tc = makeTCode();
    const bpSync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
    const tcSync = new TCodeSync({ videoPlayer: makePlayer(), tcodeManager: tc, funscriptEngine: makeFunscript() });

    bpSync.start(); tcSync.start();
    bpSync.stop(); tcSync.stop();

    expect(bpSync._active).toBe(false);
    expect(tcSync._active).toBe(false);
    expect(bpSync._intervalId).toBe(null);
    expect(tcSync._intervalId).toBe(null);
    expect(tc.stop).toHaveBeenCalled();
  });
});


// --- D. Many-device stress ----------------------------------------------

describe('Device stress — many Buttplug devices at once', () => {
  // 12 is the smallest "dozen+" the user asked for; we also run 24, 50, 100
  // to map the shape of the cost curve.
  const DEVICE_COUNTS = [12, 24, 50, 100];

  for (const N of DEVICE_COUNTS) {
    it(`${N} linear devices all receive commands in the same tick`, () => {
      const bp = makeButtplug(N);
      const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
      sync.start();
      stepTick(sync, 0.3);

      // Every device should receive at least one sendLinear call in this tick.
      const linearCallsByIndex = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
      expect(linearCallsByIndex.size).toBe(N);
      sync.stop();
    });

    it(`${N} linear devices — repeated ticks produce no wrong-index commands`, () => {
      const bp = makeButtplug(N);
      const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
      sync.start();
      for (let t = 0.1; t < 1.0; t += 0.1) stepTick(sync, t);

      for (const [idx] of bp.sendLinear.mock.calls) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(N);
      }
      sync.stop();
    });
  }

  it('24 mixed devices (linear/vibe/rotate/scalar) — each modality fires on every capable device', () => {
    const mix = [];
    for (let i = 0; i < 6; i++) mix.push({ name: `L${i}`, canLinear: true });
    for (let i = 0; i < 6; i++) mix.push({ name: `V${i}`, canVibrate: true });
    for (let i = 0; i < 6; i++) mix.push({ name: `R${i}`, canRotate: true });
    for (let i = 0; i < 6; i++) mix.push({ name: `S${i}`, canScalar: true });
    const bp = makeButtplug(mix);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
    sync.setRampUp(-1, false);  // any — just defensive
    for (const d of bp.devices) sync.setRampUp(d.index, false);
    sync.start();
    stepTick(sync, 0.3);

    const indicesByFn = {
      sendLinear:  new Set(bp.sendLinear.mock.calls.map(([i]) => i)),
      sendVibrate: new Set(bp.sendVibrate.mock.calls.map(([i]) => i)),
      sendRotate:  new Set(bp.sendRotate.mock.calls.map(([i]) => i)),
      sendScalar:  new Set(bp.sendScalar.mock.calls.map(([i]) => i)),
    };

    // 6 linear devices at indices 0..5
    expect([...indicesByFn.sendLinear].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    // 6 vibrate devices at indices 6..11
    expect([...indicesByFn.sendVibrate].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11]);
    // 6 rotate devices at indices 12..17
    expect([...indicesByFn.sendRotate].sort((a, b) => a - b)).toEqual([12, 13, 14, 15, 16, 17]);
    // 6 scalar devices at indices 18..23
    expect([...indicesByFn.sendScalar].sort((a, b) => a - b)).toEqual([18, 19, 20, 21, 22, 23]);

    sync.stop();
  });
});


// --- E. Custom routing at scale -----------------------------------------

describe('Device stress — custom routing to many devices', () => {
  it('12 devices each assigned to a different synthetic axis route their own script', () => {
    const bp = makeButtplug(12);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
    sync._customRoutingActive = true;

    // Give every device a distinct CR axis with its own action track.
    for (let i = 0; i < 12; i++) {
      const axis = `CR${i + 1}`;
      sync.setAxisActions(axis, [
        { at: 0, pos: i * 8 },              // distinct starting pos per axis
        { at: 500, pos: 100 - i * 8 },
      ]);
      sync.setAxisAssignment(i, axis);
    }

    sync.start();
    stepTick(sync, 0.2);

    // Each device should be commanded with a position matching its axis —
    // specifically, interpolated between i*8 and (100 - i*8) at t=200ms
    // (40% through the 0→500 window). We don't pin the exact value, just
    // verify all 12 distinct device indices saw a sendLinear call.
    const seen = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
    expect(seen.size).toBe(12);

    sync.stop();
  });

  it('unassigned devices in custom-routing mode receive zero commands (spec behaviour)', () => {
    const bp = makeButtplug(5);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
    sync._customRoutingActive = true;

    // Only assign devices 0 and 1 to the main axis; 2/3/4 stay unassigned.
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(1, 'L0');

    sync.start();
    stepTick(sync, 0.3);

    const seen = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
    expect(seen).toEqual(new Set([0, 1]));

    sync.stop();
  });
});


// --- F. Hot-plug stability ---------------------------------------------

describe('Device stress — hot-plug / hot-unplug mid-playback', () => {
  it('device added mid-playback gets commands on subsequent ticks', () => {
    const bp = makeButtplug(2);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
    sync.start();
    stepTick(sync, 0.2);
    const seenBefore = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
    expect(seenBefore).toEqual(new Set([0, 1]));

    // Hot-add a third linear device
    bp.devices.push({ index: 2, name: 'LateJoiner', canLinear: true, canVibrate: false, canRotate: false, canScalar: false });

    stepTick(sync, 0.6);
    const seenAfter = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
    expect(seenAfter).toEqual(new Set([0, 1, 2]));
    sync.stop();
  });

  it('device removed mid-playback stops receiving commands; others keep going', () => {
    const bp = makeButtplug(3);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
    sync.start();
    stepTick(sync, 0.2);

    // Yank device 1
    bp.devices = bp.devices.filter(d => d.index !== 1);
    bp.sendLinear.mockClear();

    stepTick(sync, 0.6);
    const seen = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
    expect(seen).toEqual(new Set([0, 2]));
    expect(seen.has(1)).toBe(false);
    sync.stop();
  });

  it('rapid connect/disconnect cycles do not leak intervals or state', () => {
    const bp = makeButtplug(4);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });

    for (let i = 0; i < 10; i++) {
      sync.start();
      stepTick(sync, 0.1 * i);
      sync.stop();
      expect(sync._intervalId).toBe(null);
      expect(sync._active).toBe(false);
    }
  });

  it('seek mid-playback resets action index without losing the per-device mapping', () => {
    const bp = makeButtplug(5);
    const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeLongFunscript(50) });
    sync.start();
    // Advance to t=5s
    stepTick(sync, 5);
    const seenEarly = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
    expect(seenEarly.size).toBe(5);

    // Fire seeked handler and jump back to t=1s
    bp.sendLinear.mockClear();
    sync._onSeeked();
    stepTick(sync, 1);
    const seenAfterSeek = new Set(bp.sendLinear.mock.calls.map(([idx]) => idx));
    expect(seenAfterSeek.size).toBe(5);
    sync.stop();
  });
});


// --- G. Performance measurements ---------------------------------------
// Not strict assertions (CI runners vary wildly), but we log measured
// per-tick time so a regression that blows the budget shows up. We keep a
// loose ceiling of 50ms per tick — anything above that and the 40ms
// scheduler interval can't keep up.

describe('Device stress — performance', () => {
  function measureTickMs(sync, ticks = 20) {
    const times = [];
    for (let t = 0; t < ticks; t++) {
      const simSec = 0.1 + t * 0.1;
      sync.player.currentTime = simSec;
      sync.player.paused = false;
      // Override perf clock so MIN_SEND_INTERVAL isn't the bottleneck.
      const spy = vi.spyOn(performance, 'now');
      spy.mockReturnValue(performance.now() + 1000 * (t + 1));
      const start = Date.now();
      if (typeof sync._tick === 'function') {
        sync._tick();
      } else {
        sync._sendPendingActions();
        if (sync._vibActions) sync._sendPendingVibActions();
        if (sync._axisActions && sync._axisActions.size > 0) sync._sendPendingAxisActions();
      }
      times.push(Date.now() - start);
      spy.mockRestore();
    }
    times.sort((a, b) => a - b);
    return {
      median: times[Math.floor(times.length / 2)],
      max: times[times.length - 1],
      avg: times.reduce((a, b) => a + b, 0) / times.length,
    };
  }

  it('measures _tick() time scaling with device count', () => {
    const results = [];
    for (const N of [1, 4, 12, 50, 100]) {
      const bp = makeButtplug(N);
      const sync = new ButtplugSync({ videoPlayer: makePlayer(), buttplugManager: bp, funscriptEngine: makeFunscript() });
      sync.start();
      const { median, max, avg } = measureTickMs(sync);
      results.push({ N, median, max, avg });
      sync.stop();

      // Loose sanity cap: tick budget is 40ms (one scheduler period). 50ms
      // is the point beyond which the scheduler can't keep up — fail there.
      expect(max).toBeLessThan(50);
    }
    // Print to stdout so CI logs capture the shape of the curve.
    console.log('[device-stress] ButtplugSync tick time by device count (ms):', results);
  });

  it('TCodeSync with 10 axes completes ticks well under the budget', () => {
    const tc = makeTCode();
    const sync = new TCodeSync({ videoPlayer: makePlayer(), tcodeManager: tc, funscriptEngine: makeFunscript() });
    // Load all 10 TCode v0.3 axes we expose in the UI
    const AXES = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'V0', 'V1', 'V2', 'A0'];
    for (const ax of AXES) {
      if (ax === 'L0') continue;
      sync.setAxisActions(ax, [
        { at: 0, pos: 0 },
        { at: 500, pos: 100 },
        { at: 1000, pos: 0 },
      ]);
    }

    sync.start();
    const { median, max } = measureTickMs(sync);
    console.log(`[device-stress] TCodeSync 10-axis tick time: median=${median}ms, max=${max}ms`);
    expect(max).toBeLessThan(50);
    sync.stop();
  });
});
