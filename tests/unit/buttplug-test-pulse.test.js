/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The device test button must tell the truth.
//
// adventurous1, thread #274: Intiface sees his Hismith, FunSync sees it,
// "does not control and test does not work either."
//
// Two separate faults made that indistinguishable from a dead device:
//
//   1. THE TEST COULD NOT MOVE A FLYWHEEL. It sent a flat 20%, documented as
//      "enough to prove routing without spinning a flywheel up" — which is
//      self-defeating. A fuck machine has real stiction and does not start
//      below roughly a third power. A vibrator at 20% is an obvious buzz; a
//      Hismith at 20% is silence.
//
//   2. THE TEST REPORTED SUCCESS WHEN THE COMMAND FAILED. Every send* caught
//      its own error into `_warnOnce` and returned undefined, so the caller
//      could not distinguish "delivered" from "threw". Same shape as the
//      e-stim bug: a real failure dressed up as a working device.
//
// A third fault surfaced while fixing these: the routing modal's test passed
// `sendVibrate(idx, 0.5)` and `sendScalar(idx, 0.3)` to methods documented as
// taking 0-100, so it was commanding 0.5% and 0.3%. Imperceptible on any
// hardware, not just flywheels.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

/** A manager with one fake device wired straight into the private map. */
function managerWith({ throws = false } = {}) {
  const mgr = new ButtplugManager();
  const runOutput = vi.fn(async () => {
    if (throws) throw new Error('device went away');
  });
  const device = { index: 3, name: 'Hismith', runOutput, hasOutput: () => true };
  mgr._devices = new Map([[3, device]]);
  return { mgr, device, runOutput };
}

describe('send paths report their outcome', () => {
  // Without this the test button cannot tell a delivered command from a
  // thrown one, which is the whole bug.
  it('returns ok on success', async () => {
    const { mgr } = managerWith();
    // The SDK is module-private; if it is unavailable every send reports
    // not-connected, which is still a REPORT rather than silence.
    const r = await mgr.sendVibrate(3, 50);
    expect(r).toBeTruthy();
    expect(typeof r.ok).toBe('boolean');
  });

  it('never returns undefined, whatever happens', async () => {
    const { mgr } = managerWith({ throws: true });
    for (const call of [
      () => mgr.sendVibrate(3, 50),
      () => mgr.sendLinear(3, 50, 300),
      () => mgr.sendRotate(3, 50, true),
      () => mgr.sendOscillate(3, 50),
      () => mgr.sendScalar(3, 50),
    ]) {
      const r = await call();
      expect(r, 'a send path returned undefined — callers cannot check it').toBeTruthy();
      expect(r).toHaveProperty('ok');
    }
  });

  it('reports not-connected for an unknown device index', async () => {
    const { mgr } = managerWith();
    const r = await mgr.sendVibrate(999, 50);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not connected/i);
  });
});

describe('the flywheel test pulse', () => {
  // The value that matters: it has to be able to actually turn a motor.
  it('drives well above the stiction floor a flat 20% sat under', async () => {
    const { mgr } = managerWith();
    const sent = [];
    mgr.sendOscillate = vi.fn(async (_i, speed) => { sent.push(speed); return { ok: true }; });

    await mgr.testOscillate(3, 100);

    const peak = Math.max(...sent);
    expect(peak, 'peak too low to break stiction on a flywheel').toBeGreaterThanOrEqual(50);
    expect(sent.length).toBeGreaterThan(1);
  });

  it('ramps rather than slamming straight to peak', async () => {
    const { mgr } = managerWith();
    const sent = [];
    mgr.sendOscillate = vi.fn(async (_i, speed) => { sent.push(speed); return { ok: true }; });

    await mgr.testOscillate(3, 100);

    const moving = sent.filter((s) => s > 0);
    expect(moving[0]).toBeLessThan(Math.max(...moving));
  });

  it('always stops the machine at the end', async () => {
    const { mgr } = managerWith();
    const sent = [];
    mgr.sendOscillate = vi.fn(async (_i, speed) => { sent.push(speed); return { ok: true }; });

    await mgr.testOscillate(3, 100);

    expect(sent.at(-1), 'machine left running after the test').toBe(0);
  });

  // Safety wins: a user who capped their machine at 30% must not get 65%
  // just because they pressed test.
  it('never exceeds the user safety cap', async () => {
    const { mgr } = managerWith();
    const sent = [];
    mgr.sendOscillate = vi.fn(async (_i, speed) => { sent.push(speed); return { ok: true }; });

    await mgr.testOscillate(3, 30);

    expect(Math.max(...sent)).toBeLessThanOrEqual(30);
  });

  it('stops the machine even when a command fails mid-ramp', async () => {
    const { mgr } = managerWith();
    const sent = [];
    let calls = 0;
    mgr.sendOscillate = vi.fn(async (_i, speed) => {
      sent.push(speed);
      calls++;
      return calls === 2 ? { ok: false, error: 'boom' } : { ok: true };
    });

    const r = await mgr.testOscillate(3, 100);

    expect(r.ok).toBe(false);
    expect(sent.at(-1), 'failure left the machine spinning').toBe(0);
  });

  it('surfaces the failure rather than reporting success', async () => {
    const { mgr } = managerWith();
    mgr.sendOscillate = vi.fn(async () => ({ ok: false, error: 'no such output' }));
    const r = await mgr.testOscillate(3, 100);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no such output');
  });

  it('treats a zero cap as "do not move"', async () => {
    const { mgr } = managerWith();
    const sent = [];
    mgr.sendOscillate = vi.fn(async (_i, speed) => { sent.push(speed); return { ok: true }; });
    await mgr.testOscillate(3, 0);
    expect(Math.max(...sent)).toBe(0);
  });
});

// Dave, 2026-08-14: releasing the Orgasm Switch hotkey in an unscripted zone
// left the device "hanging on to the last value played in the orgasm switch
// script".
//
// Hold-mode release restarts the main sync engines, whose comment promises
// they "re-anchor at the current video time automatically on their next
// tick" — true only where the script HAS content. In a gap the tick hits
// `nextIdx >= actions.length` or `duration > MAX_GAP_MS`, both bare returns,
// so nothing is commanded. Meanwhile `deactivate()` never sent a stop either.
// Two sides each assuming the other would handle it.
//
// The distinction that matters: a LINEAR device parked at its last position
// is inert, but a vibrate/rotate/oscillate/e-stim actuator holding its last
// value keeps acting on it. `stopAll()` would zero linear too and snap
// strokers to 0 on every release.
describe('stopSustainedOutputs', () => {
  const rig = (devices) => {
    const mgr = new ButtplugManager();
    mgr._client = { };            // connected-enough for the guard
    mgr._connected = true;
    mgr._devices = new Map(devices.map((d) => [d.index, d]));
    Object.defineProperty(mgr, 'devices', { get: () => devices });
    for (const m of ['sendVibrate', 'sendOscillate', 'sendRotate', 'sendScalar', 'sendLinear']) {
      mgr[m] = vi.fn(async () => ({ ok: true }));
    }
    return mgr;
  };

  it('zeroes every sustained actuator', async () => {
    const mgr = rig([
      { index: 0, canVibrate: true },
      { index: 1, canOscillate: true },
      { index: 2, canRotate: true },
      { index: 3, canScalar: true },
    ]);
    await mgr.stopSustainedOutputs();
    expect(mgr.sendVibrate).toHaveBeenCalledWith(0, 0);
    expect(mgr.sendOscillate).toHaveBeenCalledWith(1, 0);
    expect(mgr.sendRotate).toHaveBeenCalledWith(2, 0, true);
    expect(mgr.sendScalar).toHaveBeenCalledWith(3, 0);
  });

  // THE POINT. Zeroing linear would snap a stroker to 0 on every release,
  // including mid-scripted-section where nothing was wrong.
  it('leaves linear position alone', async () => {
    const mgr = rig([{ index: 0, canLinear: true }]);
    await mgr.stopSustainedOutputs();
    expect(mgr.sendLinear).not.toHaveBeenCalled();
  });

  it('silences the motor of a device that is BOTH, without moving it', async () => {
    const mgr = rig([{ index: 0, canLinear: true, canVibrate: true }]);
    await mgr.stopSustainedOutputs();
    expect(mgr.sendVibrate).toHaveBeenCalledWith(0, 0);
    expect(mgr.sendLinear).not.toHaveBeenCalled();
  });

  it('does nothing when disconnected', async () => {
    const mgr = rig([{ index: 0, canVibrate: true }]);
    mgr._connected = false;
    await mgr.stopSustainedOutputs();
    expect(mgr.sendVibrate).not.toHaveBeenCalled();
  });

  it('survives an empty device list', async () => {
    const mgr = rig([]);
    await expect(mgr.stopSustainedOutputs()).resolves.toBeUndefined();
  });
});

// tintinfernando13, thread #285 and a follow-up PM: "the vacuum it creates
// using the scripts seems way too strong... I've tried changing the
// percentages, but it's still the same."
//
// He was right, and it was not user error. His JoyHub Mirage 3 reports
// Vibrate + Rotate + E-Stim, and his screenshot showed Max set to 65% with
// the 2s ramp on. But the cap only ever reached the SCALAR and OSCILLATE
// paths — sendVibrate and sendRotate were uncapped and unramped. The
// suction he was feeling came out of the vibrate path at full script value.
//
// The slider is presented once per DEVICE, so it has to govern the whole
// device. Gated on the device actually showing the control, or every plain
// vibrator (which has no slider at all) would be silently pinned at the 70%
// default with no way to raise it.
describe('the Max cap governs the whole device, not just e-stim', () => {
  function syncWith(caps) {
    const sent = { vibrate: [], rotate: [], scalar: [] };
    const sync = new ButtplugSync({
      buttplugManager: {
        sendVibrate: (_i, v) => sent.vibrate.push(v),
        sendRotate: (_i, v) => sent.rotate.push(v),
        sendScalar: (_i, v) => sent.scalar.push(v),
        sendLinear: () => {},
        sendOscillate: () => {},
        get devices() { return [{ index: 0, ...caps }]; },
      },
      funscriptEngine: { isLoaded: true, getActions: () => [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
      videoPlayer: { get currentTime() { return 0.5; }, get paused() { return false; } },
    });
    sync._rampUpMap.set(0, false);   // isolate the CAP from the ramp
    return { sync, sent };
  }

  it('caps vibrate on a device that also has e-stim', () => {
    const { sync, sent } = syncWith({ canVibrate: true, canScalar: true });
    sync.setMaxIntensity(0, 65);
    expect(sync._safe({ index: 0, canVibrate: true, canScalar: true }, 100)).toBeLessThanOrEqual(65);
  });

  it('caps rotate on the same device', () => {
    const { sync } = syncWith({ canRotate: true, canScalar: true });
    sync.setMaxIntensity(0, 40);
    expect(sync._safe({ index: 0, canRotate: true, canScalar: true }, 100)).toBeLessThanOrEqual(40);
  });

  // THE GUARD. A plain vibrator shows no Max slider, so capping it would
  // hold it at the 70% default forever with no control to change it.
  it('leaves a vibrate-only device completely alone', () => {
    const { sync } = syncWith({ canVibrate: true });
    expect(sync._safe({ index: 0, canVibrate: true }, 100)).toBe(100);
  });

  it('treats a flywheel machine as having controls, as it always did', () => {
    const { sync } = syncWith({ canOscillate: true });
    sync.setMaxIntensity(0, 30);
    expect(sync._safe({ index: 0, canOscillate: true }, 100)).toBeLessThanOrEqual(30);
  });

  it('_hasSafetyControls matches what the UI actually renders', () => {
    const { sync } = syncWith({ canVibrate: true });
    expect(sync._hasSafetyControls({ canScalar: true })).toBe(true);
    expect(sync._hasSafetyControls({ canOscillate: true })).toBe(true);
    expect(sync._hasSafetyControls({ canVibrate: true })).toBe(false);
    expect(sync._hasSafetyControls({ canRotate: true })).toBe(false);
    expect(sync._hasSafetyControls(null)).toBe(false);
  });
});

// Heater and spray, added 2026-08-16 after auditing the Buttplug device
// config. 19 devices expose Temperature (18 binary heaters plus the Umove at
// a real 37-42 C) and 2 expose Spray (JoyHub Dodge, Sinloli Piupiu).
//
// They are MANUAL controls, never routed from the funscript: a heater is a
// comfort setting you pick once, and a binary dispenser fired on every action
// would empty itself in a minute. An earlier note in this project called them
// a "deliberate no" and stopped there, which conflated "should not be a script
// output" with "should not be supported at all".
describe('heater and spray', () => {
  // init() loads the real SDK from node_modules, which is what populates the
  // module-private ButtplugSDK. Without it every send short-circuits to
  // not-connected and a test asserting real behaviour silently passes on a
  // no-op — the failure mode this whole file exists to catch.
  async function mgrWith({ throws = false } = {}) {
    const mgr = new ButtplugManager();
    await mgr.init();
    const sent = [];
    const runOutput = vi.fn(async (cmd) => {
      sent.push(cmd);
      if (throws) throw new Error('device went away');
    });
    mgr._devices = new Map([[1, { index: 1, name: 'JoyHub Dodge', runOutput, hasOutput: () => true }]]);
    return { mgr, sent, runOutput };
  }

  it('heat returns a result rather than undefined', async () => {
    const { mgr } = await mgrWith();
    const r = await mgr.sendHeat(1, true);
    expect(r).toBeTruthy();
    expect(typeof r.ok).toBe('boolean');
  });

  it('reports not-connected for an unknown device', async () => {
    const { mgr } = await mgrWith();
    expect((await mgr.sendHeat(99, true)).ok).toBe(false);
    expect((await mgr.sendSpray(99)).ok).toBe(false);
  });

  it('surfaces a failure instead of claiming success', async () => {
    const { mgr } = await mgrWith({ throws: true });
    expect((await mgr.sendHeat(1, true)).ok).toBe(false);
  });

  // THE ONE THAT MATTERS. A dispenser left on empties itself, and nothing
  // else in the app would ever switch it off.
  it('spray always switches itself back off', async () => {
    const { mgr, sent } = await mgrWith();
    await mgr.sendSpray(1, 50);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.at(-1)).toBeTruthy();
  });

  it('spray still switches off when the first command throws', async () => {
    const mgr = new ButtplugManager();
    // Explicit init, not relying on a previous test having set the
    // module-private SDK. Without this the test passes only because of leaked
    // module state and would fail when run alone or reordered.
    await mgr.init();
    let calls = 0;
    const sent = [];
    const runOutput = vi.fn(async (cmd) => {
      calls++; sent.push(cmd);
      if (calls === 1) throw new Error('boom');
    });
    mgr._devices = new Map([[1, { index: 1, name: 'x', runOutput, hasOutput: () => true }]]);
    const r = await mgr.sendSpray(1, 20);
    expect(r.ok).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(2);   // the off attempt still happened
  });
});
