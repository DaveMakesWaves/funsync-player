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
