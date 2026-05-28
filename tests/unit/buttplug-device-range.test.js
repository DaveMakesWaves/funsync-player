// Buttplug per-device range (Tier 1) — state + apply contract.
//
// Focused on:
//   - State machine: set / get / persist / clear lifecycle
//   - Composition with existing transforms (invert, scalar safety,
//     ramp-up) — verified via the device-transform-stack property tests,
//     mirrored here at the sync-engine level to pin the wiring.
//   - All 4 command types affected: linear / vibrate / scalar / rotate
//   - Multi-device independence
//   - clearDeviceState wipes range alongside the other per-device maps
//
// Composition order PROOF (range BEFORE safety cap, AFTER invert) lives
// in device-transform-stack.test.js. This file proves the SYNC ENGINE
// uses the helper correctly, not the math of the helper itself.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

function makeMockPlayer({ currentTime = 0, paused = false, duration = 120 } = {}) {
  const state = { ct: currentTime, paused, dur: duration };
  return {
    get currentTime() { return state.ct; },
    set currentTime(v) { state.ct = v; },
    get paused() { return state.paused; },
    set paused(v) { state.paused = v; },
    duration: state.dur,
    video: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      get currentTime() { return state.ct; },
      get paused() { return state.paused; },
      duration: state.dur,
    },
  };
}

function makeMockButtplug(devices = []) {
  return {
    connected: true,
    devices,
    sendLinear: vi.fn(),
    sendVibrate: vi.fn(),
    sendScalar: vi.fn(),
    sendRotate: vi.fn(),
    stopAll: vi.fn(),
  };
}

function makeMockFunscript(actions = []) {
  return {
    isLoaded: actions.length > 0,
    getActions: () => actions,
    getRawContent: () => JSON.stringify({ actions }),
  };
}

function makeSync({ devices = [], actions = [] } = {}) {
  return new ButtplugSync({
    videoPlayer: makeMockPlayer(),
    funscriptEngine: makeMockFunscript(actions),
    buttplugManager: makeMockButtplug(devices),
  });
}

function makeLinearDev(index, name = `linear-${index}`) {
  return { index, name, canLinear: true, canVibrate: false, canScalar: false, canRotate: false };
}
function makeVibeDev(index, name = `vibe-${index}`) {
  return { index, name, canLinear: false, canVibrate: true, canScalar: false, canRotate: false };
}
function makeScalarDev(index, name = `scalar-${index}`) {
  return { index, name, canLinear: false, canVibrate: false, canScalar: true, canRotate: false };
}
function makeRotateDev(index, name = `rotate-${index}`) {
  return { index, name, canLinear: false, canVibrate: false, canScalar: false, canRotate: true };
}

// --- State machine ---

describe('ButtplugSync — per-device range state', () => {
  let sync;
  beforeEach(() => { sync = makeSync(); });

  it('getDeviceRange defaults to {0, 100} for unconfigured devices', () => {
    expect(sync.getDeviceRange(0)).toEqual({ min: 0, max: 100 });
    expect(sync.getDeviceRange(99)).toEqual({ min: 0, max: 100 });
  });

  it('setDeviceRange round-trips correctly', () => {
    sync.setDeviceRange(0, 25, 80);
    expect(sync.getDeviceRange(0)).toEqual({ min: 25, max: 80 });
  });

  it('setDeviceRange called twice — last write wins', () => {
    sync.setDeviceRange(0, 25, 80);
    sync.setDeviceRange(0, 40, 60);
    expect(sync.getDeviceRange(0)).toEqual({ min: 40, max: 60 });
  });

  it('range on one device does not affect another', () => {
    sync.setDeviceRange(0, 10, 50);
    sync.setDeviceRange(1, 60, 90);
    expect(sync.getDeviceRange(0)).toEqual({ min: 10, max: 50 });
    expect(sync.getDeviceRange(1)).toEqual({ min: 60, max: 90 });
    expect(sync.getDeviceRange(2)).toEqual({ min: 0, max: 100 });
  });

  it('stores degenerate ranges (min >= max) without crashing — apply-time treats as no-op', () => {
    // The UI prevents this, but if a malformed config writes min=max=50,
    // we should accept the storage (so a re-save doesn't lose it) and
    // let applyRange treat it as identity. Composition tests in
    // device-transform-stack verify the no-op behaviour.
    sync.setDeviceRange(0, 50, 50);
    expect(sync.getDeviceRange(0)).toEqual({ min: 50, max: 50 });
  });
});

// --- clearDeviceState lifecycle (R7 contract) ---

describe('ButtplugSync — clearDeviceState wipes range', () => {
  let sync;
  beforeEach(() => { sync = makeSync(); });

  it('clearDeviceState removes the range entry', () => {
    sync.setDeviceRange(0, 25, 80);
    expect(sync.getDeviceRange(0)).toEqual({ min: 25, max: 80 });
    sync.clearDeviceState(0);
    expect(sync.getDeviceRange(0)).toEqual({ min: 0, max: 100 }); // back to default
  });

  it('clearDeviceState wipes range alongside ALL other per-device state', () => {
    // Verifies the contract that clearDeviceState doesn't miss the new
    // _rangeMap — if a future change adds a per-device map but forgets
    // to add it to clearDeviceState, this is where the bug shows up.
    sync.setInverted(0, true);
    sync.setVibeMode(0, 'position');
    sync.setScalarMode(0, 'intensity');
    sync.setRotateMode(0, 'intensity');
    sync.setMaxIntensity(0, 50);
    sync.setRampUp(0, false);
    sync.setAxisAssignment(0, 'V0');
    sync.setDeviceRange(0, 20, 80);

    sync.clearDeviceState(0);

    expect(sync.isInverted(0)).toBe(false);
    expect(sync.getVibeMode(0)).toBe('speed');
    expect(sync.getScalarMode(0)).toBe('position');
    expect(sync.getRotateMode(0)).toBe('speed');
    expect(sync.getMaxIntensity(0)).toBe(70);
    expect(sync.getRampUp(0)).toBe(true);
    expect(sync.getDeviceRange(0)).toEqual({ min: 0, max: 100 });
  });

  it('clearing one device does not affect another', () => {
    sync.setDeviceRange(0, 20, 80);
    sync.setDeviceRange(1, 30, 70);
    sync.clearDeviceState(0);
    expect(sync.getDeviceRange(0)).toEqual({ min: 0, max: 100 });
    expect(sync.getDeviceRange(1)).toEqual({ min: 30, max: 70 }); // untouched
  });
});

// --- Apply at send (integration via spied buttplug.send*) ---

describe('ButtplugSync — range applied to linear send', () => {
  it('default range = no remap (linear)', () => {
    const dev = makeLinearDev(0);
    const sync = makeSync({ devices: [dev] });
    sync._sendLinearToDevices(50, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 50, 200);
  });

  it('range [30, 70] remaps position 0 → 30, 100 → 70, 50 → 50', () => {
    const dev = makeLinearDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setDeviceRange(0, 30, 70);

    sync._sendLinearToDevices(0, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 30, 200);

    sync._sendLinearToDevices(100, 200, 50);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 70, 200);

    sync._sendLinearToDevices(50, 200, 50);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 50, 200);
  });

  it('range + invert composes: pos 75 → invert 25 → range [30,70] → 40', () => {
    const dev = makeLinearDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setInverted(0, true);
    sync.setDeviceRange(0, 30, 70);
    sync._sendLinearToDevices(75, 200, 50);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 40, 200);
  });
});

describe('ButtplugSync — range applied to all command types', () => {
  it('vibrate: range [30, 70] applied via _sendToDevices', () => {
    const dev = makeVibeDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setVibeMode(0, 'position');  // simpler: intensity = position
    sync.setDeviceRange(0, 30, 70);
    sync._sendToDevices(100, 200, 50);
    // Vibe intensity in position mode is the ranged position
    expect(sync.buttplug.sendVibrate).toHaveBeenCalledWith(0, 70);
  });

  it('scalar: range applied BEFORE safety cap (range to 80, then capped to 70)', () => {
    const dev = makeScalarDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setScalarMode(0, 'position');
    sync.setRampUp(0, false);  // disable ramp so we test pure cap interaction
    sync.setDeviceRange(0, 0, 80);   // range max 80
    sync.setMaxIntensity(0, 70);     // safety cap 70 (default)
    sync._sendToDevices(100, 200, 50);
    // pos 100 → range to 80 → safety clip to 70
    expect(sync.buttplug.sendScalar).toHaveBeenCalledWith(0, 70);
  });

  it('scalar: range [0, 60] is below safety cap → range wins', () => {
    const dev = makeScalarDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setScalarMode(0, 'position');
    sync.setRampUp(0, false);
    sync.setDeviceRange(0, 0, 60);
    sync.setMaxIntensity(0, 70);
    sync._sendToDevices(100, 200, 50);
    // pos 100 → range to 60 → safety doesn't kick in (60 < 70 cap)
    expect(sync.buttplug.sendScalar).toHaveBeenCalledWith(0, 60);
  });

  it('rotate position mode: range applied to position before clockwise/speed derivation', () => {
    const dev = makeRotateDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setRotateMode(0, 'position');
    sync.setDeviceRange(0, 30, 70);
    sync._sendToDevices(100, 200, 0);
    // pos 100 → range to 70 → clockwise = (70 < 50) = false, speed = (70-50)/50*100 = 40
    expect(sync.buttplug.sendRotate).toHaveBeenCalledWith(0, 40, false);
  });
});

describe('ButtplugSync — multi-device independence', () => {
  it('two devices, different ranges, sent the right values', () => {
    const dev0 = makeLinearDev(0);
    const dev1 = makeLinearDev(1);
    const sync = makeSync({ devices: [dev0, dev1] });
    sync.setDeviceRange(0, 20, 80);
    sync.setDeviceRange(1, 40, 60);
    sync._sendLinearToDevices(50, 200, 0);
    // dev 0: 50 → range [20,80] midpoint = 50
    // dev 1: 50 → range [40,60] midpoint = 50
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 50, 200);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(1, 50, 200);
    // But at endpoints they diverge:
    sync.buttplug.sendLinear.mockClear();
    sync._sendLinearToDevices(0, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 20, 200);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(1, 40, 200);
    sync.buttplug.sendLinear.mockClear();
    sync._sendLinearToDevices(100, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 80, 200);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(1, 60, 200);
  });

  it('unconfigured device gets default range (no-op) while another is restricted', () => {
    const dev0 = makeLinearDev(0);
    const dev1 = makeLinearDev(1);
    const sync = makeSync({ devices: [dev0, dev1] });
    sync.setDeviceRange(0, 30, 70);
    // dev 1 has no range — defaults to {0, 100}, no-op
    sync._sendLinearToDevices(0, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 30, 200); // ranged
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(1, 0, 200);  // raw
  });
});

// --- Non-regression: existing behaviour without range set ---

describe('ButtplugSync — non-regression at default range', () => {
  it('linear send identical to pre-range behaviour when range is default', () => {
    const dev = makeLinearDev(0);
    const sync = makeSync({ devices: [dev] });
    // No setDeviceRange call → defaults
    sync._sendLinearToDevices(73, 250, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 73, 250);
  });

  it('invert without range still flips correctly', () => {
    const dev = makeLinearDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setInverted(0, true);
    sync._sendLinearToDevices(75, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 25, 200);
  });

  it('e-stim safety cap unchanged when range is default', () => {
    const dev = makeScalarDev(0);
    const sync = makeSync({ devices: [dev] });
    sync.setScalarMode(0, 'position');
    sync.setRampUp(0, false);
    sync.setMaxIntensity(0, 70);
    sync._sendToDevices(100, 200, 50);
    expect(sync.buttplug.sendScalar).toHaveBeenCalledWith(0, 70);
  });
});
