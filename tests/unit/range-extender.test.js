// Range Extender (Tier 2a) — script-side stretch integration.
//
// The pure functions (computeNaturalRange, applyExtender,
// extendRawScriptContent) are exhaustively unit-tested in
// device-transform-stack.test.js. This file proves the SYNC ENGINES
// + the cloud-upload paths wire the helpers in correctly:
//
//   - buttplugSync.setRangeExtenderEnabled toggles the per-tick state
//   - Natural range cached + applied per axis independently
//   - Variant switch recomputes the natural range
//   - clearAxisActions doesn't leak stale natural ranges
//   - tcodeSync mirrors buttplugSync's contract
//   - Default state (disabled, no script loaded) is a true no-op

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';

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
    connected: true, devices,
    sendLinear: vi.fn(), sendVibrate: vi.fn(),
    sendScalar: vi.fn(), sendRotate: vi.fn(),
    stopAll: vi.fn(),
  };
}

function makeMockTCode() {
  return { connected: true, sendAxes: vi.fn(), stop: vi.fn() };
}

function makeMockFunscript(actions = []) {
  return {
    isLoaded: actions.length > 0,
    getActions: () => actions,
    getRawContent: () => JSON.stringify({ actions }),
  };
}

const linearDev = (index) => ({
  index, name: `linear-${index}`, canLinear: true, canVibrate: false, canScalar: false, canRotate: false,
});

// --- Buttplug per-tick wiring ---

describe('ButtplugSync — Range Extender state', () => {
  let sync;
  beforeEach(() => {
    sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
  });

  it('default disabled', () => {
    expect(sync.isRangeExtenderEnabled()).toBe(false);
  });

  it('setRangeExtenderEnabled flips state', () => {
    sync.setRangeExtenderEnabled(true);
    expect(sync.isRangeExtenderEnabled()).toBe(true);
    sync.setRangeExtenderEnabled(false);
    expect(sync.isRangeExtenderEnabled()).toBe(false);
  });

  it('coerces truthy/falsy to boolean', () => {
    sync.setRangeExtenderEnabled(1);
    expect(sync.isRangeExtenderEnabled()).toBe(true);
    sync.setRangeExtenderEnabled(0);
    expect(sync.isRangeExtenderEnabled()).toBe(false);
    sync.setRangeExtenderEnabled(null);
    expect(sync.isRangeExtenderEnabled()).toBe(false);
    sync.setRangeExtenderEnabled(undefined);
    expect(sync.isRangeExtenderEnabled()).toBe(false);
  });
});

describe('ButtplugSync — natural range cached on script load', () => {
  it('_cacheActions computes natural range from loaded actions', () => {
    const narrow = [
      { at: 0, pos: 30 }, { at: 100, pos: 50 }, { at: 200, pos: 70 },
    ];
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(narrow),
      buttplugManager: makeMockButtplug(),
    });
    sync._cacheActions();
    expect(sync._naturalRange).toEqual({ min: 30, max: 70 });
  });

  it('empty script → default natural range {0, 100}', () => {
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
    sync._cacheActions();
    expect(sync._naturalRange).toEqual({ min: 0, max: 100 });
  });

  it('reloadActions recomputes natural range (variant switch)', () => {
    const initial = [{ at: 0, pos: 30 }, { at: 100, pos: 70 }];
    const fs = makeMockFunscript(initial);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: fs,
      buttplugManager: makeMockButtplug(),
    });
    sync._cacheActions();
    expect(sync._naturalRange).toEqual({ min: 30, max: 70 });

    // Simulate variant switch: replace actions, reload
    const newActions = [{ at: 0, pos: 10 }, { at: 100, pos: 95 }];
    fs.getActions = () => newActions;
    sync.reloadActions();
    expect(sync._naturalRange).toEqual({ min: 10, max: 95 });
  });
});

describe('ButtplugSync — per-axis natural range', () => {
  let sync;
  beforeEach(() => {
    sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
  });

  it('setAxisActions caches natural range on the axis state', () => {
    sync.setAxisActions('R0', [
      { at: 0, pos: 40 }, { at: 100, pos: 60 },
    ]);
    const state = sync._axisActions.get('R0');
    expect(state.naturalRange).toEqual({ min: 40, max: 60 });
  });

  it('each axis natural range is independent', () => {
    sync.setAxisActions('L0', [{ at: 0, pos: 0 }, { at: 100, pos: 100 }]);
    sync.setAxisActions('R0', [{ at: 0, pos: 40 }, { at: 100, pos: 60 }]);
    expect(sync._axisActions.get('L0').naturalRange).toEqual({ min: 0, max: 100 });
    expect(sync._axisActions.get('R0').naturalRange).toEqual({ min: 40, max: 60 });
  });

  it('setAxisActions with too-few actions removes the entry (and its natural range)', () => {
    sync.setAxisActions('R0', [{ at: 0, pos: 40 }, { at: 100, pos: 60 }]);
    expect(sync._axisActions.has('R0')).toBe(true);
    sync.setAxisActions('R0', [{ at: 0, pos: 40 }]); // < 2
    expect(sync._axisActions.has('R0')).toBe(false);
  });

  it('clearAxisActions wipes everything (no stale ranges)', () => {
    sync.setAxisActions('L0', [{ at: 0, pos: 0 }, { at: 100, pos: 100 }]);
    sync.setAxisActions('R0', [{ at: 0, pos: 40 }, { at: 100, pos: 60 }]);
    sync.clearAxisActions();
    expect(sync._axisActions.size).toBe(0);
  });
});

describe('ButtplugSync — extender applied to linear send', () => {
  it('disabled: no transformation', () => {
    const dev = linearDev(0);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript([
        { at: 0, pos: 30 }, { at: 100, pos: 70 },
      ]),
      buttplugManager: makeMockButtplug([dev]),
    });
    sync._cacheActions();
    sync._sendLinearToDevices(50, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 50, 200);
  });

  it('enabled + narrow script: pos 30 → 0, pos 70 → 100', () => {
    const dev = linearDev(0);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript([
        { at: 0, pos: 30 }, { at: 100, pos: 70 },
      ]),
      buttplugManager: makeMockButtplug([dev]),
    });
    sync._cacheActions();
    sync.setRangeExtenderEnabled(true);
    sync._sendLinearToDevices(30, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 0, 200);
    sync._sendLinearToDevices(70, 200, 30);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 100, 200);
    sync._sendLinearToDevices(50, 200, 30);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 50, 200);  // midpoint stays
  });

  it('enabled + wide script: no-op (script already uses full range)', () => {
    const dev = linearDev(0);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript([
        { at: 0, pos: 0 }, { at: 100, pos: 100 },
      ]),
      buttplugManager: makeMockButtplug([dev]),
    });
    sync._cacheActions();
    sync.setRangeExtenderEnabled(true);
    sync._sendLinearToDevices(50, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenCalledWith(0, 50, 200);
  });

  it('enabled + per-device range composes: extender stretches first, then range clips', () => {
    const dev = linearDev(0);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript([
        { at: 0, pos: 30 }, { at: 100, pos: 70 },  // natural 30-70 (width 40)
      ]),
      buttplugManager: makeMockButtplug([dev]),
    });
    sync._cacheActions();
    sync.setRangeExtenderEnabled(true);
    sync.setDeviceRange(0, 20, 80);  // device-level range
    // pos 50 → extender keeps 50 (midpoint) → range [20,80] midpoint = 50
    sync._sendLinearToDevices(50, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 50, 200);
    // pos 30 → extender stretches to 0 → range to 20 (device min)
    sync._sendLinearToDevices(30, 200, 30);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 20, 200);
    // pos 70 → extender stretches to 100 → range to 80 (device max)
    sync._sendLinearToDevices(70, 200, 30);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 80, 200);
  });
});

// --- TCode mirror ---

describe('TCodeSync — Range Extender state mirrors ButtplugSync', () => {
  let sync;
  beforeEach(() => {
    sync = new TCodeSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      tcodeManager: makeMockTCode(),
    });
  });

  it('default disabled', () => {
    expect(sync.isRangeExtenderEnabled()).toBe(false);
  });

  it('setRangeExtenderEnabled flips state + defensive on non-bool inputs', () => {
    sync.setRangeExtenderEnabled(true);
    expect(sync.isRangeExtenderEnabled()).toBe(true);
    sync.setRangeExtenderEnabled(null);
    expect(sync.isRangeExtenderEnabled()).toBe(false);
    sync.setRangeExtenderEnabled('truthy-string');
    expect(sync.isRangeExtenderEnabled()).toBe(true);
  });

  it('setAxisActions caches natural range per axis', () => {
    sync.setAxisActions('R0', [{ at: 0, pos: 25 }, { at: 100, pos: 75 }]);
    const state = sync._axisActions.get('R0');
    expect(state.naturalRange).toEqual({ min: 25, max: 75 });
  });

  it('_cacheActions computes main natural range', () => {
    const actions = [{ at: 0, pos: 20 }, { at: 100, pos: 80 }];
    const fs = makeMockFunscript(actions);
    const sync2 = new TCodeSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: fs,
      tcodeManager: makeMockTCode(),
    });
    sync2._cacheActions();
    expect(sync2._naturalRange).toEqual({ min: 20, max: 80 });
  });
});

// --- Vib-script natural range ---

describe('ButtplugSync — vib script natural range', () => {
  it('setVibrationActions caches natural range', () => {
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
    sync.setVibrationActions([{ at: 0, pos: 30 }, { at: 100, pos: 70 }]);
    expect(sync._vibScriptNaturalRange).toEqual({ min: 30, max: 70 });
  });

  it('clearing vib script (null actions) resets to defaults', () => {
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
    sync.setVibrationActions([{ at: 0, pos: 30 }, { at: 100, pos: 70 }]);
    sync.setVibrationActions(null);
    expect(sync._vibScriptNaturalRange).toEqual({ min: 0, max: 100 });
  });
});

// --- Non-regression: default = no transforms ---

describe('Range Extender — non-regression at defaults', () => {
  it('Buttplug: no transformation when extender disabled (default)', () => {
    const dev = linearDev(0);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript([
        { at: 0, pos: 30 }, { at: 100, pos: 70 },  // narrow script
      ]),
      buttplugManager: makeMockButtplug([dev]),
    });
    sync._cacheActions();
    // Despite the script being narrow, no setRangeExtenderEnabled call.
    // Output should be identical to pre-extender behaviour.
    sync._sendLinearToDevices(30, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 30, 200);
    sync._sendLinearToDevices(70, 200, 30);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 70, 200);
  });
});
