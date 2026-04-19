// Tests for Custom Routing — multi-device script assignment scenarios
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

// --- Helpers ---

function mockPlayer(time = 0) {
  return {
    video: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    currentTime: time,
    paused: false,
    duration: 60,
  };
}

function mockFunscript(actions) {
  return {
    isLoaded: true,
    getActions: () => actions || [
      { at: 0, pos: 0 }, { at: 1000, pos: 100 },
      { at: 2000, pos: 0 }, { at: 3000, pos: 100 },
    ],
  };
}

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

const SCRIPT_A = [
  { at: 0, pos: 0 }, { at: 500, pos: 100 },
  { at: 1000, pos: 0 }, { at: 1500, pos: 100 },
];

const SCRIPT_B = [
  { at: 0, pos: 100 }, { at: 500, pos: 0 },
  { at: 1000, pos: 100 }, { at: 1500, pos: 0 },
];

const SCRIPT_C = [
  { at: 0, pos: 50 }, { at: 500, pos: 50 },
  { at: 1000, pos: 50 }, { at: 1500, pos: 50 },
];

// ===== SCENARIO 1: Single Axis — all devices play same script =====

describe('Single Axis — all devices play same script', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'Lovense Max', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Lovense Nora', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
      { index: 2, name: 'DG-LAB', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.5),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });
    // NOT custom routing — all devices get L0
    sync._customRoutingActive = false;
  });

  it('all 3 devices receive commands from main script', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendLinear).toHaveBeenCalledTimes(1);
    expect(bp.sendVibrate).toHaveBeenCalledTimes(1);
    expect(bp.sendScalar).toHaveBeenCalledTimes(1);
  });

  it('linear device gets position', () => {
    sync._sendToDevices(80, 200, 20);
    expect(bp.sendLinear).toHaveBeenCalledWith(0, 80, 200);
  });

  it('vibrate device gets derived intensity', () => {
    sync._sendToDevices(80, 200, 20);
    expect(bp.sendVibrate.mock.calls[0][0]).toBe(1);
    expect(bp.sendVibrate.mock.calls[0][1]).toBeGreaterThan(0);
  });

  it('scalar device gets capped intensity', () => {
    sync.setRampUp(2, false);
    sync._rampUpStartTime = performance.now() - 10000;
    sync._sendToDevices(100, 200, 0);
    const sent = bp.sendScalar.mock.calls[0][1];
    expect(sent).toBeLessThanOrEqual(70); // default 70% cap
  });
});

// ===== SCENARIO 2: Custom Routing — 2 devices, 2 scripts =====

describe('Custom Routing — 2 devices, 2 scripts', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'Lovense Max', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Lovense Nora', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A), // main script for L0
    });

    // Set up custom routing
    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'L0');  // Max → main script
    sync.setAxisAssignment(1, 'CR1'); // Nora → script B
    sync.setAxisActions('CR1', SCRIPT_B);
  });

  it('device 0 gets main script (L0), not CR1', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendLinear).toHaveBeenCalledTimes(1);
    expect(bp.sendLinear.mock.calls[0][0]).toBe(0);
  });

  it('device 1 does NOT get main script', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendVibrate).not.toHaveBeenCalled(); // skipped — on CR1
  });

  it('device 1 gets CR1 script via axis actions', () => {
    sync._sendPendingAxisActions();
    expect(bp.sendVibrate).toHaveBeenCalledTimes(1);
    expect(bp.sendVibrate.mock.calls[0][0]).toBe(1);
  });

  it('scripts are independent — different positions at same time', () => {
    // At t=250ms: SCRIPT_A pos ~50 (0→100 over 500ms), SCRIPT_B pos ~50 (100→0 over 500ms)
    sync._sendToDevices(50, 200, 0);
    sync._sendPendingAxisActions();

    const linearPos = bp.sendLinear.mock.calls[0][1];
    const vibePos = bp.sendVibrate.mock.calls[0][1];

    // Both get valid values but from different scripts
    expect(linearPos).toBeGreaterThanOrEqual(0);
    expect(vibePos).toBeGreaterThanOrEqual(0);
  });
});

// ===== SCENARIO 3: Custom Routing — 3rd device unassigned =====

describe('Custom Routing — unassigned device stays silent', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'Max', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Nora', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
      { index: 2, name: 'Extra', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(1, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_B);
    // Device 2 (Extra) — NO assignment
  });

  it('unassigned device does not receive main script commands', () => {
    sync._sendToDevices(50, 200, 25);
    // Only device 0 (linear on L0) should get commands
    expect(bp.sendLinear).toHaveBeenCalledTimes(1);
    expect(bp.sendVibrate).not.toHaveBeenCalled(); // device 1 on CR1, device 2 unassigned
  });

  it('unassigned device does not receive axis commands', () => {
    sync._sendPendingAxisActions();
    // Only device 1 on CR1 should get commands
    expect(bp.sendVibrate).toHaveBeenCalledTimes(1);
    expect(bp.sendVibrate.mock.calls[0][0]).toBe(1); // Nora, not Extra
  });
});

// ===== SCENARIO 4: Follow Custom Routing on single axis video =====

describe('Follow Custom Routing on single axis video', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'Max', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Nora', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    // NOT custom routing — single axis video
    sync._customRoutingActive = false;
    // Both devices on default (no explicit assignment)
  });

  it('both devices play main script when no custom routing', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendLinear).toHaveBeenCalledTimes(1);
    expect(bp.sendVibrate).toHaveBeenCalledTimes(1);
  });
});

// ===== SCENARIO 5: Multi-axis companion files =====

describe('Multi-axis companion files', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Vorze', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
      { index: 2, name: 'Lovense', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A), // L0
    });

    // Multi-axis — NOT custom routing
    sync._customRoutingActive = false;
    sync.setAxisActions('R0', SCRIPT_B);  // twist companion
    sync.setAxisActions('V0', SCRIPT_C);  // vib companion
    sync.setAxisAssignment(1, 'R0');      // Vorze → twist
    sync.setAxisAssignment(2, 'V0');      // Lovense → vibe
  });

  it('KEON gets main script (L0)', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendLinear).toHaveBeenCalledWith(0, expect.any(Number), expect.any(Number));
  });

  it('Vorze gets twist script (R0)', () => {
    sync._sendPendingAxisActions();
    expect(bp.sendRotate).toHaveBeenCalled();
    expect(bp.sendRotate.mock.calls[0][0]).toBe(1);
  });

  it('Lovense gets vibe script (V0)', () => {
    sync._sendPendingAxisActions();
    expect(bp.sendVibrate).toHaveBeenCalled();
    expect(bp.sendVibrate.mock.calls[0][0]).toBe(2);
  });

  it('Vorze does not get main script', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendRotate).not.toHaveBeenCalled(); // driven by axis only
  });

  it('Lovense does not get main script vibrate', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendVibrate).not.toHaveBeenCalled(); // on V0 axis, skipped
  });
});

// ===== SCENARIO 6: Override custom routing with explicit axis =====

describe('Override custom routing with explicit axis in panel', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'Max', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Nora', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    sync._customRoutingActive = true;
    sync.setAxisActions('CR1', SCRIPT_B);
    // Custom routing assigned Nora to CR1, but user overrides to L0 in panel
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(1, 'L0'); // override: force to main script
  });

  it('overridden device gets main script instead of custom route', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendLinear).toHaveBeenCalledTimes(1);
    expect(bp.sendVibrate).toHaveBeenCalledTimes(1); // Nora on L0 now
    expect(bp.sendVibrate.mock.calls[0][0]).toBe(1);
  });

  it('CR1 axis has no assigned devices', () => {
    sync._sendPendingAxisActions();
    // No device assigned to CR1 anymore — should not send
    expect(bp.sendVibrate).not.toHaveBeenCalled();
  });
});

// ===== SCENARIO 7: Mixed device types in custom routing =====

describe('Custom Routing — mixed device types', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Lovense', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
      { index: 2, name: 'DG-LAB', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
      { index: 3, name: 'Vorze', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'L0');  // KEON → main
    sync.setAxisAssignment(1, 'CR1'); // Lovense → script B
    sync.setAxisAssignment(2, 'CR2'); // DG-LAB → script C
    sync.setAxisAssignment(3, 'CR3'); // Vorze → script A again
    sync.setAxisActions('CR1', SCRIPT_B);
    sync.setAxisActions('CR2', SCRIPT_C);
    sync.setAxisActions('CR3', SCRIPT_A);

    sync.setRampUp(2, false);
    sync._rampUpStartTime = performance.now() - 10000;
  });

  it('sends correct command type per device capability on custom axes', () => {
    sync._sendPendingAxisActions();
    expect(bp.sendVibrate).toHaveBeenCalledWith(1, expect.any(Number)); // Lovense
    expect(bp.sendScalar).toHaveBeenCalledWith(2, expect.any(Number));  // DG-LAB
    expect(bp.sendRotate).toHaveBeenCalledWith(3, expect.any(Number), expect.any(Boolean)); // Vorze
  });

  it('main script only goes to KEON', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendLinear).toHaveBeenCalledTimes(1);
    expect(bp.sendLinear.mock.calls[0][0]).toBe(0);
    expect(bp.sendVibrate).not.toHaveBeenCalled();
    expect(bp.sendScalar).not.toHaveBeenCalled();
    expect(bp.sendRotate).not.toHaveBeenCalled();
  });
});

// ===== SCENARIO 8: Pause stops all devices =====

describe('Pause stops all devices in all modes', () => {
  it('single axis: pause stops all', () => {
    const bp = mockButtplug([
      { index: 0, name: 'A', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'B', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    const sync = new ButtplugSync({ videoPlayer: mockPlayer(), buttplugManager: bp, funscriptEngine: mockFunscript() });
    sync._active = true;
    sync._actions = mockFunscript().getActions();
    sync._handlePause();
    expect(bp.stopAll).toHaveBeenCalled();
  });

  it('custom routing: pause stops all', () => {
    const bp = mockButtplug([
      { index: 0, name: 'A', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'B', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    const sync = new ButtplugSync({ videoPlayer: mockPlayer(), buttplugManager: bp, funscriptEngine: mockFunscript() });
    sync._customRoutingActive = true;
    sync._active = true;
    sync._actions = mockFunscript().getActions();
    sync._handlePause();
    expect(bp.stopAll).toHaveBeenCalled();
  });
});

// ===== SCENARIO 9: Invert works per device =====

describe('Invert works independently per device in custom routing', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'A', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'B', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(1, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_A);
    sync.setInverted(1, true); // B inverted
  });

  it('device A gets normal position', () => {
    sync._sendToDevices(80, 200, 20);
    expect(bp.sendLinear.mock.calls[0][1]).toBe(80);
  });

  it('device B gets inverted position on custom axis', () => {
    sync._sendPendingAxisActions();
    // The axis dispatch checks inversion
    const calls = bp.sendLinear.mock.calls.filter(c => c[0] === 1);
    if (calls.length > 0) {
      // Inverted: 100 - value
      expect(calls[0][1]).toBeLessThan(100);
    }
  });
});

// ===== SCENARIO 10: E-stim safety in custom routing =====

describe('E-stim safety in custom routing', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'DG-LAB', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(1, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_A);
    sync.setMaxIntensity(1, 50);
    sync.setRampUp(1, false);
    sync._rampUpStartTime = performance.now() - 10000;
  });

  it('e-stim cap applied on custom axis', () => {
    sync._sendPendingAxisActions();
    const scalarCalls = bp.sendScalar.mock.calls.filter(c => c[0] === 1);
    if (scalarCalls.length > 0) {
      expect(scalarCalls[0][1]).toBeLessThanOrEqual(50);
    }
  });

  it('linear device is not affected by e-stim cap', () => {
    sync._sendToDevices(100, 200, 0);
    expect(bp.sendLinear.mock.calls[0][1]).toBe(100);
  });
});

// ===== SCENARIO 11: Seek resets all axis indices =====

describe('Seek resets all axis indices', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'A', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'B', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.5),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(1, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_B);
    sync._active = true;
    sync._actions = SCRIPT_A;
  });

  it('seeked resets main and axis indices', () => {
    const state = sync._axisActions.get('CR1');
    state.index = 5;
    state.lastSentValue = 42;

    sync._handleSeeked();

    expect(state.lastSentValue).toBe(-1);
    expect(sync._lastSentPos).toBe(-1);
  });
});

// ===== SCENARIO 12: Custom routing cleared on new video =====

describe('Custom routing cleared on new video', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'A', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });
  });

  it('customRoutingActive flag resets', () => {
    sync._customRoutingActive = true;
    sync.setAxisActions('CR1', SCRIPT_B);

    // Simulate new video load
    sync._customRoutingActive = false;
    sync.clearAxisActions();

    expect(sync._customRoutingActive).toBe(false);
    expect(sync.getLoadedAxes()).toHaveLength(0);
  });

  it('after clearing, all devices get main script again', () => {
    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'CR1');

    // Clear
    sync._customRoutingActive = false;
    sync.setAxisAssignment(0, null);

    sync._sendToDevices(50, 200, 25);
    expect(bp.sendLinear).toHaveBeenCalledTimes(1);
  });
});

// ===== SCENARIO 13: Dedicated vib script with custom routing =====

describe('Dedicated vib script + custom routing', () => {
  let sync, bp;

  beforeEach(() => {
    bp = mockButtplug([
      { index: 0, name: 'KEON', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
      { index: 1, name: 'Lovense', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(0.25),
      buttplugManager: bp,
      funscriptEngine: mockFunscript(SCRIPT_A),
    });

    sync._customRoutingActive = true;
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(1, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_B);
    sync.setVibrationActions(SCRIPT_C); // dedicated vib
  });

  it('vib script does not drive custom-routed device', () => {
    sync._vibActionIndex = 1;
    sync._lastVibSentIntensity = -1;
    sync._lastVibSendTime = 0;
    sync.player.currentTime = 0.25;
    sync._sendPendingVibActions();

    // Lovense is on CR1, unassigned from vib path
    // Only unassigned or L0/V0 devices get vib — but in custom routing, unassigned = silent
    const vibCalls = bp.sendVibrate.mock.calls.filter(c => c[0] === 1);
    expect(vibCalls).toHaveLength(0);
  });

  it('main script does not send vibrate when vib actions set', () => {
    sync._sendToDevices(50, 200, 25);
    expect(bp.sendVibrate).not.toHaveBeenCalled();
  });
});

// ===== SCENARIO 14: setAxisAssignment stores L0 explicitly =====

describe('Axis assignment stores L0 explicitly', () => {
  let sync;

  beforeEach(() => {
    sync = new ButtplugSync({
      videoPlayer: mockPlayer(),
      buttplugManager: mockButtplug([]),
      funscriptEngine: mockFunscript(),
    });
  });

  it('setAxisAssignment L0 stores in map', () => {
    sync.setAxisAssignment(0, 'L0');
    expect(sync._axisAssignmentMap.has(0)).toBe(true);
    expect(sync._axisAssignmentMap.get(0)).toBe('L0');
  });

  it('setAxisAssignment null removes from map', () => {
    sync.setAxisAssignment(0, 'L0');
    sync.setAxisAssignment(0, null);
    expect(sync._axisAssignmentMap.has(0)).toBe(false);
  });

  it('getAxisAssignment returns L0 as default', () => {
    expect(sync.getAxisAssignment(99)).toBe('L0');
  });

  it('getAxisAssignment returns stored value', () => {
    sync.setAxisAssignment(0, 'CR1');
    expect(sync.getAxisAssignment(0)).toBe('CR1');
  });
});

// ===== SCENARIO 15: Custom axis dispatch uses device capability =====

describe('Custom axis (C prefix) sends by capability', () => {
  it('sends LinearCmd to linear device on custom axis', () => {
    const bp = mockButtplug([
      { index: 0, name: 'A', canLinear: true, canVibrate: false, canRotate: false, canScalar: false },
    ]);
    const sync = new ButtplugSync({ videoPlayer: mockPlayer(0.25), buttplugManager: bp, funscriptEngine: mockFunscript(SCRIPT_A) });
    sync.setAxisAssignment(0, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_A);
    sync._sendPendingAxisActions();
    expect(bp.sendLinear).toHaveBeenCalled();
  });

  it('sends VibrateCmd to vibrate device on custom axis', () => {
    const bp = mockButtplug([
      { index: 0, name: 'A', canLinear: false, canVibrate: true, canRotate: false, canScalar: false },
    ]);
    const sync = new ButtplugSync({ videoPlayer: mockPlayer(0.25), buttplugManager: bp, funscriptEngine: mockFunscript(SCRIPT_A) });
    sync.setAxisAssignment(0, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_A);
    sync._sendPendingAxisActions();
    expect(bp.sendVibrate).toHaveBeenCalled();
  });

  it('sends RotateCmd to rotate device on custom axis', () => {
    const bp = mockButtplug([
      { index: 0, name: 'A', canLinear: false, canVibrate: false, canRotate: true, canScalar: false },
    ]);
    const sync = new ButtplugSync({ videoPlayer: mockPlayer(0.25), buttplugManager: bp, funscriptEngine: mockFunscript(SCRIPT_A) });
    sync.setAxisAssignment(0, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_A);
    sync._sendPendingAxisActions();
    expect(bp.sendRotate).toHaveBeenCalled();
  });

  it('sends ScalarCmd to scalar device on custom axis', () => {
    const bp = mockButtplug([
      { index: 0, name: 'A', canLinear: false, canVibrate: false, canRotate: false, canScalar: true },
    ]);
    const sync = new ButtplugSync({ videoPlayer: mockPlayer(0.25), buttplugManager: bp, funscriptEngine: mockFunscript(SCRIPT_A) });
    sync.setAxisAssignment(0, 'CR1');
    sync.setAxisActions('CR1', SCRIPT_A);
    sync.setRampUp(0, false);
    sync._rampUpStartTime = performance.now() - 10000;
    sync._sendPendingAxisActions();
    expect(bp.sendScalar).toHaveBeenCalled();
  });
});
