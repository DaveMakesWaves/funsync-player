/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Flywheel "fuck machine" support — Buttplug `Oscillate`.
//
// Community report 2026-08-06: a Hismith connected, reported [Oscillate],
// and received nothing because Oscillate was in the capability DIAGNOSTIC
// list but not the recognised set.
//
// The safety model is the point of most of these tests. A machine's stroke
// length is mechanically fixed, so Oscillate is a SPEED. Feeding it raw
// script positions makes a slow deep stroke into full power — documented as
// causing "irregular, uncontrollable bursts of power". Hence: speed mode by
// default, routed through the same cap + ramp path as e-stim, and excluded
// from the Orgasm Switch finisher.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

function machine(overrides = {}) {
  return {
    index: 0,
    name: 'Hismith Sex Machine',
    canLinear: false,
    canVibrate: false,
    canRotate: false,
    canScalar: false,
    canOscillate: true,
    ...overrides,
  };
}

function makeSync(devices) {
  const buttplug = {
    connected: true,
    devices,
    sendLinear: vi.fn(),
    sendVibrate: vi.fn(),
    sendRotate: vi.fn(),
    sendScalar: vi.fn(),
    sendOscillate: vi.fn(),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
  const sync = new ButtplugSync({
    buttplugManager: buttplug,
    videoPlayer: { video: { addEventListener: vi.fn(), removeEventListener: vi.fn() }, currentTime: 0, paused: true },
    funscriptEngine: { isLoaded: true, getActions: () => [] },
  });
  return { sync, buttplug };
}

/**
 * Drive one dispatch tick directly, bypassing the scheduler.
 *
 * `durationMs` here means "the interval this movement happened over", which
 * is `sinceLastMs` — NOT the third positional arg (`durationMs` = time to the
 * next action, used only by LinearCmd). Passing it positionally is what these
 * tests used to do, and it is precisely the confusion that hid the bug: the
 * two coincide in a hand-built call and diverge completely in production.
 */
function tick(sync, devices, { pos, prevPos, durationMs = 100 }) {
  sync._sendToDevices(pos, durationMs, prevPos, { sinceLastMs: durationMs });
}

describe('oscillate dispatch', () => {
  let sync, buttplug, devices;

  beforeEach(() => {
    devices = [machine()];
    ({ sync, buttplug } = makeSync(devices));
    // Ramp-up would scale early values down; disable so the mapping is
    // testable on its own. Ramp behaviour is covered separately below.
    sync.setRampUp(0, false);
    sync.setMaxIntensity(0, 100);
  });

  it('sends an oscillate command to a machine at all', () => {
    // The regression: nothing was ever sent.
    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 100 });
    expect(buttplug.sendOscillate).toHaveBeenCalled();
  });

  it('defaults to SPEED mode, not position', () => {
    // A big slow move must NOT read as high power.
    tick(sync, devices, { pos: 90, prevPos: 80, durationMs: 1000 });
    const slow = buttplug.sendOscillate.mock.calls.at(-1)[1];

    // Same distance, ten times faster → much higher speed.
    tick(sync, devices, { pos: 90, prevPos: 80, durationMs: 100 });
    const fast = buttplug.sendOscillate.mock.calls.at(-1)[1];

    expect(fast).toBeGreaterThan(slow);
    // 10 units over 1s = 10 units/s, which is nowhere near full power.
    expect(slow).toBeLessThan(20);
  });

  it('position mode passes the value straight through, for converted scripts', () => {
    sync.setOscillateMode(0, 'position');
    tick(sync, devices, { pos: 42, prevPos: 42, durationMs: 100 });
    expect(buttplug.sendOscillate.mock.calls.at(-1)[1]).toBe(42);
  });

  it('applies the max-speed cap', () => {
    sync.setMaxIntensity(0, 30);
    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 50 }); // very fast
    expect(buttplug.sendOscillate.mock.calls.at(-1)[1]).toBeLessThanOrEqual(30);
  });

  it('applies ramp-up so a flywheel is not slammed from cold', () => {
    sync.setRampUp(0, true);
    sync._rampUpStartTime = performance.now(); // ramp just began
    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 50 });
    const early = buttplug.sendOscillate.mock.calls.at(-1)[1];

    sync._rampUpStartTime = performance.now() - 10_000; // long finished
    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 50 });
    const later = buttplug.sendOscillate.mock.calls.at(-1)[1];

    expect(early).toBeLessThan(later);
  });

  it('never exceeds 0-100', () => {
    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 1 }); // absurd speed
    const v = buttplug.sendOscillate.mock.calls.at(-1)[1];
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

describe('oscillate precedence and isolation', () => {
  it('drives Oscillate and NOT Vibrate on hardware exposing both', () => {
    // Driving both would fight over one motor.
    const devices = [machine({ canVibrate: true })];
    const { sync, buttplug } = makeSync(devices);
    sync.setRampUp(0, false);

    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 100 });

    expect(buttplug.sendOscillate).toHaveBeenCalled();
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();
  });

  it('leaves a plain vibrator alone', () => {
    const devices = [machine({ canOscillate: false, canVibrate: true })];
    const { sync, buttplug } = makeSync(devices);
    sync.setRampUp(0, false);

    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 100 });

    expect(buttplug.sendVibrate).toHaveBeenCalled();
    expect(buttplug.sendOscillate).not.toHaveBeenCalled();
  });

  it('a dedicated vib script takes over from the main script', () => {
    const devices = [machine()];
    const { sync, buttplug } = makeSync(devices);
    // Needs >= 2 actions — setVibrationActions ignores a shorter script.
    sync.setVibrationActions([{ at: 0, pos: 50 }, { at: 1000, pos: 80 }]);

    tick(sync, devices, { pos: 100, prevPos: 0, durationMs: 100 });

    expect(buttplug.sendOscillate).not.toHaveBeenCalled();
  });
});

describe('stop', () => {
  it('issues a device stop — a machine must not keep running', () => {
    // Worse than a vibrator that keeps buzzing: this one keeps thrusting.
    const devices = [machine()];
    const { sync, buttplug } = makeSync(devices);
    sync.stop();
    expect(buttplug.stopAll).toHaveBeenCalled();
  });
});
