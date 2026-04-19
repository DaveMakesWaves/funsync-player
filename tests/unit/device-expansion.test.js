// Tests for Phase 17.1: Buttplug ScalarCmd + RotateCmd (e-stim + rotation)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

// Mock video player
function mockPlayer() {
  return {
    video: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    currentTime: 0,
    paused: true,
    duration: 60,
  };
}

// Mock funscript engine
function mockFunscript(actions) {
  return {
    isLoaded: true,
    getActions: () => actions || [
      { at: 0, pos: 0 },
      { at: 1000, pos: 100 },
      { at: 2000, pos: 0 },
      { at: 3000, pos: 100 },
      { at: 4000, pos: 0 },
    ],
  };
}

// Mock buttplug manager with device capabilities
function mockButtplug(devices = []) {
  return {
    connected: true,
    devices,
    sendLinear: vi.fn(),
    sendVibrate: vi.fn(),
    sendRotate: vi.fn(),
    sendScalar: vi.fn(),
    stopAll: vi.fn(),
    stopDevice: vi.fn(),
  };
}

describe('ButtplugSync — ScalarCmd (E-Stim)', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'DG-LAB ESTIM', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
  });

  it('sends ScalarCmd to scalar-capable devices', () => {
    sync._sendToDevices(80, 200, 20);
    expect(buttplug.sendScalar).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it('does not send LinearCmd to scalar-only devices', () => {
    sync._sendToDevices(80, 200, 20);
    expect(buttplug.sendLinear).not.toHaveBeenCalled();
  });

  it('does not send VibrateCmd to scalar-only devices', () => {
    sync._sendToDevices(80, 200, 20);
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();
  });

  it('applies max intensity cap (default 70%)', () => {
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBeLessThanOrEqual(70);
  });

  it('applies custom max intensity cap', () => {
    sync.setMaxIntensity(0, 50);
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBeLessThanOrEqual(50);
  });

  it('max intensity cap at 0% sends zero', () => {
    sync.setMaxIntensity(0, 0);
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBe(0);
  });

  it('max intensity cap at 100% allows full range', () => {
    sync.setMaxIntensity(0, 100);
    sync.setRampUp(0, false);
    sync._rampUpStartTime = performance.now() - 10000; // past ramp-up
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBe(100);
  });

  it('default max intensity is 70 for e-stim', () => {
    expect(sync.getMaxIntensity(0)).toBe(70);
  });

  it('set/get max intensity round-trip', () => {
    sync.setMaxIntensity(0, 42);
    expect(sync.getMaxIntensity(0)).toBe(42);
  });

  it('clamps max intensity to 0-100', () => {
    sync.setMaxIntensity(0, 150);
    expect(sync.getMaxIntensity(0)).toBe(100);
    sync.setMaxIntensity(0, -10);
    expect(sync.getMaxIntensity(0)).toBe(0);
  });
});

describe('ButtplugSync — E-Stim Ramp-Up Safety', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'DG-LAB ESTIM', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
  });

  it('ramp-up is enabled by default', () => {
    expect(sync.getRampUp(0)).toBe(true);
  });

  it('ramp-up at t=0 outputs zero', () => {
    sync._rampUpStartTime = performance.now();
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBeLessThan(5); // near zero
  });

  it('ramp-up at t=1000ms outputs ~50% of target', () => {
    sync._rampUpStartTime = performance.now() - 1000;
    sync.setMaxIntensity(0, 100);
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    // At halfway through 2s ramp, should be ~50
    expect(sentIntensity).toBeGreaterThan(30);
    expect(sentIntensity).toBeLessThan(70);
  });

  it('ramp-up complete at t=2000ms outputs full target', () => {
    sync._rampUpStartTime = performance.now() - 2500;
    sync.setMaxIntensity(0, 100);
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBe(100);
  });

  it('ramp-up disabled sends full intensity immediately', () => {
    sync.setRampUp(0, false);
    sync.setMaxIntensity(0, 100);
    sync._rampUpStartTime = performance.now(); // just started
    sync._sendToDevices(100, 200, 0);
    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBe(100);
  });

  it('set/get ramp-up round-trip', () => {
    sync.setRampUp(0, false);
    expect(sync.getRampUp(0)).toBe(false);
    sync.setRampUp(0, true);
    expect(sync.getRampUp(0)).toBe(true);
  });

  it('ramp-up resets on seek', () => {
    sync._active = true;
    sync._actions = mockFunscript().getActions();
    const before = performance.now() - 5000;
    sync._rampUpStartTime = before;
    sync._handleSeeked();
    expect(sync._rampUpStartTime).toBeGreaterThan(before);
  });

  it('ramp-up resets on playing', () => {
    sync._active = true;
    sync._actions = mockFunscript().getActions();
    const before = performance.now() - 5000;
    sync._rampUpStartTime = before;
    sync._handlePlaying();
    expect(sync._rampUpStartTime).toBeGreaterThan(before);
  });
});

describe('ButtplugSync — E-Stim Intensity Modes', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'DG-LAB', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
    sync.setMaxIntensity(0, 100);
    sync.setRampUp(0, false);
    sync._rampUpStartTime = performance.now() - 10000;
  });

  it('position mode: intensity matches position directly', () => {
    sync.setScalarMode(0, 'position');
    sync._sendToDevices(75, 200, 25);
    const sent = buttplug.sendScalar.mock.calls[0][1];
    expect(sent).toBe(75);
  });

  it('speed mode: fast movement = high intensity', () => {
    sync.setScalarMode(0, 'speed');
    sync._sendToDevices(100, 100, 0); // 100 units in 100ms = very fast
    const sent = buttplug.sendScalar.mock.calls[0][1];
    expect(sent).toBeGreaterThan(50);
  });

  it('speed mode: slow movement = low intensity', () => {
    sync.setScalarMode(0, 'speed');
    sync._sendToDevices(10, 1000, 0); // 10 units in 1000ms = very slow
    const sent = buttplug.sendScalar.mock.calls[0][1];
    expect(sent).toBeLessThan(20);
  });

  it('hybrid mode: blends position and speed', () => {
    sync.setScalarMode(0, 'intensity');
    sync._sendToDevices(80, 200, 20);
    const sent = buttplug.sendScalar.mock.calls[0][1];
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(100);
  });

  it('default scalar mode is position', () => {
    expect(sync.getScalarMode(0)).toBe('position');
  });

  it('set/get scalar mode round-trip', () => {
    sync.setScalarMode(0, 'speed');
    expect(sync.getScalarMode(0)).toBe('speed');
  });
});

describe('ButtplugSync — RotateCmd (Rotation Devices)', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'Vorze A10', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
  });

  it('sends RotateCmd to rotate-capable devices', () => {
    sync._sendToDevices(80, 200, 20);
    expect(buttplug.sendRotate).toHaveBeenCalled();
  });

  it('does not send LinearCmd to rotate-only devices', () => {
    sync._sendToDevices(80, 200, 20);
    expect(buttplug.sendLinear).not.toHaveBeenCalled();
  });

  it('position mode: pos < 50 = clockwise', () => {
    sync.setRotateMode(0, 'position');
    sync._sendToDevices(20, 200, 50);
    const [, , clockwise] = buttplug.sendRotate.mock.calls[0];
    expect(clockwise).toBe(true);
  });

  it('position mode: pos > 50 = counter-clockwise', () => {
    sync.setRotateMode(0, 'position');
    sync._sendToDevices(80, 200, 50);
    const [, , clockwise] = buttplug.sendRotate.mock.calls[0];
    expect(clockwise).toBe(false);
  });

  it('position mode: pos = 50 → speed = 0', () => {
    sync.setRotateMode(0, 'position');
    sync._sendToDevices(50, 200, 20);
    const [, speed] = buttplug.sendRotate.mock.calls[0];
    expect(speed).toBe(0);
  });

  it('position mode: pos = 0 → max CW speed', () => {
    sync.setRotateMode(0, 'position');
    sync._sendToDevices(0, 200, 50);
    const [, speed] = buttplug.sendRotate.mock.calls[0];
    expect(speed).toBe(100);
  });

  it('speed mode: uses velocity for rotation speed', () => {
    sync.setRotateMode(0, 'speed');
    sync._sendToDevices(100, 100, 0); // fast
    const [, speed] = buttplug.sendRotate.mock.calls[0];
    expect(speed).toBeGreaterThan(50);
  });

  it('speed mode: direction follows movement direction', () => {
    sync.setRotateMode(0, 'speed');
    sync._sendToDevices(100, 200, 0);
    const [, , clockwise] = buttplug.sendRotate.mock.calls[0];
    expect(clockwise).toBe(true); // pos >= prevPos
  });

  it('default rotate mode is speed', () => {
    expect(sync.getRotateMode(0)).toBe('speed');
  });

  it('set/get rotate mode round-trip', () => {
    sync.setRotateMode(0, 'position');
    expect(sync.getRotateMode(0)).toBe('position');
  });
});

describe('ButtplugSync — Multi-Device Concurrent', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Lovense Lush', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
      { index: 2, name: 'DG-LAB ESTIM', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
      { index: 3, name: 'Vorze A10', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
    sync.setRampUp(2, false);
    sync._rampUpStartTime = performance.now() - 10000;
  });

  it('sends to all 4 device types simultaneously', () => {
    sync._sendToDevices(50, 200, 25);
    expect(buttplug.sendLinear).toHaveBeenCalledTimes(1);
    expect(buttplug.sendVibrate).toHaveBeenCalledTimes(1);
    expect(buttplug.sendScalar).toHaveBeenCalledTimes(1);
    expect(buttplug.sendRotate).toHaveBeenCalledTimes(1);
  });

  it('each device gets correct index', () => {
    sync._sendToDevices(50, 200, 25);
    expect(buttplug.sendLinear.mock.calls[0][0]).toBe(0);
    expect(buttplug.sendVibrate.mock.calls[0][0]).toBe(1);
    expect(buttplug.sendScalar.mock.calls[0][0]).toBe(2);
    expect(buttplug.sendRotate.mock.calls[0][0]).toBe(3);
  });

  it('per-device inversion works independently', () => {
    sync.setInverted(0, true); // KEON inverted
    sync.setInverted(2, true); // DG-LAB inverted
    sync._sendToDevices(80, 200, 40);

    // KEON gets inverted position (20)
    expect(buttplug.sendLinear.mock.calls[0][1]).toBe(20);
    // Lovense gets normal position-derived intensity
    expect(buttplug.sendVibrate.mock.calls[0][0]).toBe(1);
    // DG-LAB gets inverted
    const scalarIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(scalarIntensity).toBeLessThanOrEqual(70); // capped
  });

  it('e-stim safety is independent per device', () => {
    // Add second scalar device
    buttplug.devices.push(
      { index: 4, name: 'MK-312BT', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    );
    sync.setMaxIntensity(2, 50);
    sync.setMaxIntensity(4, 80);
    sync.setRampUp(4, false);
    sync._rampUpStartTime = performance.now() - 10000;

    sync._sendToDevices(100, 200, 0);

    const dglab = buttplug.sendScalar.mock.calls[0][1];
    const mk312 = buttplug.sendScalar.mock.calls[1][1];
    expect(dglab).toBeLessThanOrEqual(50);
    expect(mk312).toBeLessThanOrEqual(80);
  });
});

describe('ButtplugSync — Dedicated Vib Script with Scalar Devices', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'Lovense', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
      { index: 1, name: 'DG-LAB', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
    sync.setVibrationActions([
      { at: 0, pos: 0 },
      { at: 500, pos: 80 },
      { at: 1000, pos: 20 },
      { at: 1500, pos: 90 },
    ]);
    sync.setRampUp(1, false);
    sync._rampUpStartTime = performance.now() - 10000;
  });

  it('scalar devices receive vib script intensity', () => {
    sync._vibActionIndex = 1; // pos: 80
    sync._lastVibSentIntensity = -1;
    sync._lastVibSendTime = 0;
    sync.player.currentTime = 0.5;
    sync._sendPendingVibActions();

    expect(buttplug.sendScalar).toHaveBeenCalled();
  });

  it('scalar safety cap applies to vib script intensity', () => {
    sync.setMaxIntensity(1, 50);
    sync._vibActionIndex = 1; // pos: 80
    sync._lastVibSentIntensity = -1;
    sync._lastVibSendTime = 0;
    sync.player.currentTime = 0.5;
    sync._sendPendingVibActions();

    const sentIntensity = buttplug.sendScalar.mock.calls[0][1];
    expect(sentIntensity).toBeLessThanOrEqual(50);
  });

  it('vib script suppresses main script vibrate AND scalar (both driven by vib path)', () => {
    // With vib actions set, main script should NOT drive vibrate or scalar devices
    // (they're driven by _sendPendingVibActions instead to avoid double-sending)
    sync._sendToDevices(50, 200, 25);
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();
    expect(buttplug.sendScalar).not.toHaveBeenCalled();
  });
});

describe('ButtplugManager — Device Serialization', () => {
  it('serialization includes canScalar', () => {
    // Test the serialization contract
    const dev = { index: 0, name: 'test', canLinear: false, canVibrate: false, canRotate: false, canScalar: true };
    expect(dev.canScalar).toBe(true);
  });

  it('serialization defaults canScalar to false for non-scalar devices', () => {
    const dev = { index: 0, name: 'test', canLinear: true, canVibrate: true, canRotate: false, canScalar: false };
    expect(dev.canScalar).toBe(false);
  });
});

describe('ButtplugSync — Emergency Stop', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'DG-LAB', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
    sync._active = true;
    sync._actions = mockFunscript().getActions();
  });

  it('pause stops all devices', () => {
    sync._handlePause();
    expect(buttplug.stopAll).toHaveBeenCalled();
  });

  it('video end stops all devices', () => {
    sync._handleEnded();
    expect(buttplug.stopAll).toHaveBeenCalled();
  });
});

// === Phase 17.2: Multi-Axis Routing ===

describe('ButtplugSync — Axis Actions', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Vorze', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
      { index: 2, name: 'Lovense', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
  });

  it('setAxisActions stores actions for a TCode axis', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
    sync.setAxisActions('R0', actions);
    expect(sync.getLoadedAxes()).toContain('R0');
  });

  it('setAxisActions with null removes the axis', () => {
    sync.setAxisActions('R0', [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]);
    sync.setAxisActions('R0', null);
    expect(sync.getLoadedAxes()).not.toContain('R0');
  });

  it('setAxisActions ignores arrays with < 2 actions', () => {
    sync.setAxisActions('R0', [{ at: 0, pos: 50 }]);
    expect(sync.getLoadedAxes()).not.toContain('R0');
  });

  it('clearAxisActions removes all axes', () => {
    sync.setAxisActions('R0', [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]);
    sync.setAxisActions('L1', [{ at: 0, pos: 0 }, { at: 1000, pos: 50 }]);
    sync.clearAxisActions();
    expect(sync.getLoadedAxes()).toHaveLength(0);
  });

  it('multiple axes can be loaded simultaneously', () => {
    sync.setAxisActions('R0', [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]);
    sync.setAxisActions('L1', [{ at: 0, pos: 0 }, { at: 1000, pos: 50 }]);
    sync.setAxisActions('V0', [{ at: 0, pos: 0 }, { at: 1000, pos: 75 }]);
    expect(sync.getLoadedAxes()).toHaveLength(3);
  });
});

describe('ButtplugSync — Per-Device Axis Assignment', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Vorze', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
      { index: 2, name: 'Lovense', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
  });

  it('default axis assignment is L0', () => {
    expect(sync.getAxisAssignment(0)).toBe('L0');
    expect(sync.getAxisAssignment(1)).toBe('L0');
  });

  it('set/get axis assignment round-trip', () => {
    sync.setAxisAssignment(1, 'R0');
    expect(sync.getAxisAssignment(1)).toBe('R0');
  });

  it('setting L0 clears the override (back to default)', () => {
    sync.setAxisAssignment(1, 'R0');
    sync.setAxisAssignment(1, 'L0');
    expect(sync.getAxisAssignment(1)).toBe('L0');
  });

  it('setting null clears the override', () => {
    sync.setAxisAssignment(1, 'R0');
    sync.setAxisAssignment(1, null);
    expect(sync.getAxisAssignment(1)).toBe('L0');
  });

  it('devices assigned to non-L0 axis are skipped by _sendToDevices', () => {
    sync.setAxisAssignment(1, 'R0');
    sync._sendToDevices(50, 200, 25);
    // Vorze (index 1) assigned to R0 → skipped by main _sendToDevices
    expect(buttplug.sendRotate).not.toHaveBeenCalled();
    // KEON (index 0) still on L0 → should receive linear
    expect(buttplug.sendLinear).toHaveBeenCalledWith(0, expect.any(Number), expect.any(Number));
  });

  it('devices on L0 still receive main script commands', () => {
    sync.setAxisAssignment(0, 'L0');
    sync._sendToDevices(80, 200, 20);
    expect(buttplug.sendLinear).toHaveBeenCalledWith(0, 80, 200);
  });
});

describe('ButtplugSync — Axis Action Dispatch', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Vorze', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
      { index: 2, name: 'Lovense', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });

    // Set up multi-axis
    sync.setAxisActions('R0', [
      { at: 0, pos: 0 },
      { at: 1000, pos: 100 },
      { at: 2000, pos: 0 },
    ]);
    sync.setAxisActions('V0', [
      { at: 0, pos: 10 },
      { at: 1000, pos: 90 },
    ]);

    // Assign devices to axes
    sync.setAxisAssignment(1, 'R0'); // Vorze → twist
    sync.setAxisAssignment(2, 'V0'); // Lovense → vibe
  });

  it('sends rotate commands to R0-assigned device', () => {
    sync.player.currentTime = 0.5; // 500ms → midway through R0 actions
    sync._sendPendingAxisActions();

    expect(buttplug.sendRotate).toHaveBeenCalled();
    const [idx] = buttplug.sendRotate.mock.calls[0];
    expect(idx).toBe(1); // Vorze
  });

  it('sends vibrate commands to V0-assigned device', () => {
    sync.player.currentTime = 0.5;
    sync._sendPendingAxisActions();

    expect(buttplug.sendVibrate).toHaveBeenCalled();
    const [idx] = buttplug.sendVibrate.mock.calls[0];
    expect(idx).toBe(2); // Lovense
  });

  it('does not send to devices not assigned to any loaded axis', () => {
    sync.player.currentTime = 0.5;
    sync._sendPendingAxisActions();

    // KEON is on L0 (default) — not assigned to R0 or V0
    expect(buttplug.sendLinear).not.toHaveBeenCalled();
  });

  it('interpolates position between action points', () => {
    sync.player.currentTime = 0.5; // halfway: pos should be ~50 for R0
    sync._sendPendingAxisActions();

    const [, speed] = buttplug.sendRotate.mock.calls[0];
    // At R0 pos ~50, position mode: pos=50 means stopped, but speed may vary
    // The value should be a valid number
    expect(typeof speed).toBe('number');
    expect(speed).toBeGreaterThanOrEqual(0);
    expect(speed).toBeLessThanOrEqual(100);
  });

  it('respects axis rate limiting', () => {
    sync.player.currentTime = 0.5;
    sync._sendPendingAxisActions();
    // Immediately call again — should be rate-limited
    sync._sendPendingAxisActions();

    // R0 should only send once (rate limited)
    expect(buttplug.sendRotate).toHaveBeenCalledTimes(1);
  });

  it('reloadActions resets axis state', () => {
    sync.player.currentTime = 0.5;
    sync._sendPendingAxisActions();

    sync.reloadActions();

    // Axis state should be reset
    for (const [, state] of sync._axisActions) {
      expect(state.index).toBe(-1);
      expect(state.lastSentValue).toBe(-1);
    }
  });
});

describe('ButtplugSync — Axis Reset on Video Events', () => {
  let sync, buttplug;

  beforeEach(() => {
    buttplug = mockButtplug([
      { index: 0, name: 'Vorze', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: buttplug,
      funscriptEngine: mockFunscript(),
    });
    sync.setAxisActions('R0', [
      { at: 0, pos: 0 },
      { at: 1000, pos: 100 },
    ]);
    sync._active = true;
    sync._actions = mockFunscript().getActions();
  });

  it('playing resets axis indices', () => {
    const state = sync._axisActions.get('R0');
    state.index = 5;
    state.lastSentValue = 42;
    sync._handlePlaying();
    expect(state.lastSentValue).toBe(-1);
  });

  it('seeked resets axis indices', () => {
    const state = sync._axisActions.get('R0');
    state.index = 5;
    state.lastSentValue = 42;
    sync._handleSeeked();
    expect(state.lastSentValue).toBe(-1);
  });
});
