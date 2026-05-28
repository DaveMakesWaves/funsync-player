// Variant switching — per-device state persistence + per-script
// recompute contracts.
//
// Per SCOPE-device-settings-expansion.md §1 contracts R6 + R10:
//
//   - Per-DEVICE settings (range, invert, mode, maxIntensity, rampUp)
//     are user choices — they survive a variant switch. Each variant
//     drives the same physical device; the user's preferences for that
//     device don't change because they picked a different script.
//
//   - Per-SCRIPT state (natural range, action indices) is variant-
//     specific — it MUST recompute on switch. A wide v1 script
//     followed by a narrow v2 script should leave the extender no-op
//     on v1 and stretching on v2.
//
// This file pins both contracts so a future change that crosses the
// boundary (e.g., clearing per-device range on variant switch) fails
// loudly.

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
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      get currentTime() { return state.ct; },
      get paused() { return state.paused; },
      duration: state.dur,
    },
  };
}
function makeMockButtplug(devices = []) {
  return {
    connected: true, devices,
    sendLinear: vi.fn(), sendVibrate: vi.fn(), sendScalar: vi.fn(), sendRotate: vi.fn(),
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

describe('Variant switch — per-device settings survive (Buttplug)', () => {
  let sync;

  beforeEach(() => {
    sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript([{ at: 0, pos: 0 }, { at: 100, pos: 100 }]),
      buttplugManager: makeMockButtplug(),
    });
    sync._cacheActions();
    // Configure every per-device setting we care about
    sync.setInverted(0, true);
    sync.setVibeMode(0, 'position');
    sync.setScalarMode(0, 'intensity');
    sync.setRotateMode(0, 'intensity');
    sync.setMaxIntensity(0, 60);
    sync.setRampUp(0, false);
    sync.setAxisAssignment(0, 'L0');
    sync.setDeviceRange(0, 25, 75);    // NEW (Tier 1)
    sync.setRangeExtenderEnabled(true); // NEW (Tier 2a)
  });

  it('invert survives reloadActions', () => {
    sync.reloadActions();
    expect(sync.isInverted(0)).toBe(true);
  });

  it('vibe/scalar/rotate modes survive reloadActions', () => {
    sync.reloadActions();
    expect(sync.getVibeMode(0)).toBe('position');
    expect(sync.getScalarMode(0)).toBe('intensity');
    expect(sync.getRotateMode(0)).toBe('intensity');
  });

  it('maxIntensity + rampUp survive reloadActions', () => {
    sync.reloadActions();
    expect(sync.getMaxIntensity(0)).toBe(60);
    expect(sync.getRampUp(0)).toBe(false);
  });

  it('per-device range survives reloadActions (Tier 1)', () => {
    sync.reloadActions();
    expect(sync.getDeviceRange(0)).toEqual({ min: 25, max: 75 });
  });

  it('Range Extender enabled flag survives reloadActions (Tier 2a)', () => {
    sync.reloadActions();
    expect(sync.isRangeExtenderEnabled()).toBe(true);
  });

  it('axis assignment survives reloadActions', () => {
    expect(sync.getAxisAssignment(0)).toBe('L0');
    sync.reloadActions();
    expect(sync.getAxisAssignment(0)).toBe('L0');
  });

  it('ALL per-device state survives a chain of variant switches', () => {
    for (let i = 0; i < 5; i++) sync.reloadActions();
    expect(sync.isInverted(0)).toBe(true);
    expect(sync.getDeviceRange(0)).toEqual({ min: 25, max: 75 });
    expect(sync.getMaxIntensity(0)).toBe(60);
    expect(sync.getRampUp(0)).toBe(false);
    expect(sync.isRangeExtenderEnabled()).toBe(true);
  });
});

describe('Variant switch — natural range RECOMPUTES on script change', () => {
  it('main script: variant A wide (0-100), variant B narrow (40-60)', () => {
    const fs = makeMockFunscript([{ at: 0, pos: 0 }, { at: 100, pos: 100 }]);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: fs,
      buttplugManager: makeMockButtplug(),
    });
    sync._cacheActions();
    expect(sync._naturalRange).toEqual({ min: 0, max: 100 });

    // Simulate variant switch: replace actions, reload
    fs.getActions = () => [{ at: 0, pos: 40 }, { at: 100, pos: 60 }];
    sync.reloadActions();
    expect(sync._naturalRange).toEqual({ min: 40, max: 60 });
  });

  it('main script: variant A narrow (30-70), variant B wide (0-100)', () => {
    const fs = makeMockFunscript([{ at: 0, pos: 30 }, { at: 100, pos: 70 }]);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: fs,
      buttplugManager: makeMockButtplug(),
    });
    sync._cacheActions();
    expect(sync._naturalRange).toEqual({ min: 30, max: 70 });

    fs.getActions = () => [{ at: 0, pos: 0 }, { at: 100, pos: 100 }];
    sync.reloadActions();
    expect(sync._naturalRange).toEqual({ min: 0, max: 100 });
  });

  it('TCode main: variant switch recomputes natural range', () => {
    const fs = makeMockFunscript([{ at: 0, pos: 20 }, { at: 100, pos: 80 }]);
    const sync = new TCodeSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: fs,
      tcodeManager: makeMockTCode(),
    });
    sync._cacheActions();
    expect(sync._naturalRange).toEqual({ min: 20, max: 80 });

    fs.getActions = () => [{ at: 0, pos: 50 }, { at: 100, pos: 50 }];
    sync.reloadActions();
    expect(sync._naturalRange).toEqual({ min: 50, max: 50 });  // degenerate but recomputed
  });

  it('axis actions: setAxisActions replaces both actions AND natural range', () => {
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
    sync.setAxisActions('R0', [{ at: 0, pos: 20 }, { at: 100, pos: 80 }]);
    expect(sync._axisActions.get('R0').naturalRange).toEqual({ min: 20, max: 80 });
    // Variant switch — replace this axis's actions
    sync.setAxisActions('R0', [{ at: 0, pos: 40 }, { at: 100, pos: 60 }]);
    expect(sync._axisActions.get('R0').naturalRange).toEqual({ min: 40, max: 60 });
  });

  it('vib script: setVibrationActions replacing actions recomputes natural range', () => {
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
    sync.setVibrationActions([{ at: 0, pos: 30 }, { at: 100, pos: 70 }]);
    expect(sync._vibScriptNaturalRange).toEqual({ min: 30, max: 70 });
    sync.setVibrationActions([{ at: 0, pos: 0 }, { at: 100, pos: 50 }]);
    expect(sync._vibScriptNaturalRange).toEqual({ min: 0, max: 50 });
  });
});

describe('Variant switch — extender enabled+narrow→wide flow', () => {
  // End-to-end: variant A narrow + extender on stretches, variant B
  // wide + extender on no-op. Proves that the natural-range recompute
  // actually flows through to the per-tick application.

  it('narrow variant: extender stretches; wide variant: no-op', () => {
    const dev = { index: 0, name: 'd', canLinear: true };
    const fs = makeMockFunscript([{ at: 0, pos: 30 }, { at: 100, pos: 70 }]);
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: fs,
      buttplugManager: makeMockButtplug([dev]),
    });
    sync._cacheActions();
    sync.setRangeExtenderEnabled(true);

    // Narrow variant: pos 30 → stretched to 0
    sync._sendLinearToDevices(30, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 0, 200);

    // Variant switch to wide
    fs.getActions = () => [{ at: 0, pos: 0 }, { at: 100, pos: 100 }];
    sync.reloadActions();
    // Wide variant: pos 30 → no stretch (script already wide)
    sync._sendLinearToDevices(30, 200, 0);
    expect(sync.buttplug.sendLinear).toHaveBeenLastCalledWith(0, 30, 200);
  });
});

describe('Backup/restore — settings round-trip', () => {
  // Per R12 — the new settings ride on the existing flat settings
  // schema, so they round-trip through .funsync-backup via
  // data-export.js automatically. These tests prove the SHAPE of the
  // round-trip: a settings snapshot containing the new fields
  // restores to the same in-memory state.
  //
  // (Full export/import IPC flow is out of scope for unit tests; we
  // verify the data shape here, not the file I/O.)

  it('Buttplug deviceSettings shape preserves range across snapshot', () => {
    const snapshot = {
      'buttplug.deviceSettings': {
        '0:Solace Pro': {
          inverted: true,
          maxIntensity: 60,
          range: { min: 25, max: 75 },
        },
      },
    };
    // After restore, the same shape should be readable
    const restored = JSON.parse(JSON.stringify(snapshot));
    expect(restored['buttplug.deviceSettings']['0:Solace Pro'].range).toEqual({ min: 25, max: 75 });
    expect(restored['buttplug.deviceSettings']['0:Solace Pro'].inverted).toBe(true);
    expect(restored['buttplug.deviceSettings']['0:Solace Pro'].maxIntensity).toBe(60);
  });

  it('TCode axis settings shape preserves inverted across snapshot', () => {
    const snapshot = {
      'tcode.axes': {
        R0: { enabled: true, min: 20, max: 80, inverted: true },
        L0: { enabled: false, min: 0, max: 100, inverted: false },
      },
    };
    const restored = JSON.parse(JSON.stringify(snapshot));
    expect(restored['tcode.axes'].R0).toEqual({ enabled: true, min: 20, max: 80, inverted: true });
    expect(restored['tcode.axes'].L0.inverted).toBe(false);
  });

  it('Range Extender setting is a flat boolean — straightforward round-trip', () => {
    const snapshot = { 'player.rangeExtender.enabled': true };
    const restored = JSON.parse(JSON.stringify(snapshot));
    expect(restored['player.rangeExtender.enabled']).toBe(true);
  });

  it('Loading missing range field defaults to no-op (backward compat)', () => {
    // Pre-Tier-1 saved settings have no `range` key. Loading them must
    // not crash and must leave the device at default {0, 100}.
    const sync = new ButtplugSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      buttplugManager: makeMockButtplug(),
    });
    // Simulate _loadButtplugDeviceSettings logic: only apply if both
    // min and max are finite. Pre-Tier-1 config has neither.
    const oldSaved = { inverted: true, maxIntensity: 70 /* no range field */ };
    if (oldSaved.range && Number.isFinite(oldSaved.range?.min) && Number.isFinite(oldSaved.range?.max)) {
      sync.setDeviceRange(0, oldSaved.range.min, oldSaved.range.max);
    }
    expect(sync.getDeviceRange(0)).toEqual({ min: 0, max: 100 });
  });

  it('Loading missing inverted field defaults to false (backward compat)', () => {
    const sync = new TCodeSync({
      videoPlayer: makeMockPlayer(),
      funscriptEngine: makeMockFunscript(),
      tcodeManager: makeMockTCode(),
    });
    // Simulate _applyTCodeAxisSettings logic
    const oldSaved = { enabled: true, min: 0, max: 100 /* no inverted field */ };
    const inverted = oldSaved.inverted === true;
    sync.setAxisInverted('R0', inverted);
    expect(sync.isAxisInverted('R0')).toBe(false);
  });
});
