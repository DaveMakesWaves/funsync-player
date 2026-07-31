// Tests for the Orgasm Switch controller (hold-to-activate looping override).
//
// Community request shy4649 (2026-06-08): a held key swaps the device(s)
// onto a short looping "orgasm" script without pausing the video, releasing
// snaps back. The novel/hard part is the loop clock — the orgasm script must
// play on its OWN time base, independent of video.currentTime — so that's
// the focus of these tests. See SCOPE-orgasm-switch.md.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';

const SCRIPT = JSON.stringify({
  actions: [
    { at: 0, pos: 0 },
    { at: 1000, pos: 100 },
    { at: 2000, pos: 0 },
  ],
});

function makeDeps(overrides = {}) {
  return {
    buttplugManager: {
      connected: true,
      devices: [{ index: 0, name: 'Stroker', canLinear: true }],
      sendLinear: vi.fn(),
    },
    tcodeManager: { connected: true, sendAxes: vi.fn() },
    handyManager: { connected: true, hdspMove: vi.fn() },
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    now: () => 0,
    ...overrides,
  };
}

describe('OrgasmSwitch — loadScript', () => {
  let os;
  beforeEach(() => { os = new OrgasmSwitch(makeDeps()); });

  it('loads a valid script and computes loop duration from the last action', () => {
    expect(os.loadScript(SCRIPT)).toBe(true);
    expect(os.configured).toBe(true);
    expect(os._durationMs).toBe(2000);
    expect(os._actions).toHaveLength(3);
  });

  it('sorts actions by time', () => {
    const unsorted = JSON.stringify({ actions: [{ at: 2000, pos: 0 }, { at: 0, pos: 50 }, { at: 1000, pos: 100 }] });
    os.loadScript(unsorted);
    expect(os._actions.map((a) => a.at)).toEqual([0, 1000, 2000]);
  });

  it('strips a UTF-8 BOM before parsing', () => {
    expect(os.loadScript('﻿' + SCRIPT)).toBe(true);
    expect(os.configured).toBe(true);
  });

  it('rejects bad JSON / non-string / missing actions / too few actions', () => {
    expect(os.loadScript('not json {')).toBe(false);
    expect(os.loadScript(null)).toBe(false);
    expect(os.loadScript(JSON.stringify({ version: '1.0' }))).toBe(false);
    expect(os.loadScript(JSON.stringify({ actions: [{ at: 0, pos: 0 }] }))).toBe(false);
    expect(os.configured).toBe(false);
  });

  it('filters out malformed actions, needs >= 2 valid', () => {
    const dirty = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 'x', pos: 5 }, null, { at: 1000, pos: 100 }] });
    expect(os.loadScript(dirty)).toBe(true);
    expect(os._actions).toHaveLength(2);
  });
});

describe('OrgasmSwitch — activate / deactivate guards + lifecycle', () => {
  let deps;
  let os;
  beforeEach(() => {
    deps = makeDeps();
    os = new OrgasmSwitch(deps);
    os.setTimerImpl((cb, ms) => 1, () => {});
  });

  it('refuses to activate when not configured', () => {
    expect(os.activate()).toBe('not-configured');
    expect(os.active).toBe(false);
    expect(deps.onActivate).not.toHaveBeenCalled();
  });

  it('activates when configured, calling onActivate', () => {
    os.loadScript(SCRIPT);
    expect(os.activate()).toBe('activated');
    expect(os.active).toBe(true);
    expect(deps.onActivate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — second activate is a no-op', () => {
    os.loadScript(SCRIPT);
    os.activate();
    expect(os.activate()).toBe('already-active');
    expect(deps.onActivate).toHaveBeenCalledTimes(1);
  });

  it('deactivate stops the loop and calls onDeactivate, idempotently', () => {
    os.loadScript(SCRIPT);
    os.activate();
    os.deactivate();
    expect(os.active).toBe(false);
    expect(deps.onDeactivate).toHaveBeenCalledTimes(1);
    os.deactivate();
    expect(deps.onDeactivate).toHaveBeenCalledTimes(1); // not called again
  });

  it('does not activate without a timer impl', () => {
    os.loadScript(SCRIPT);
    os.setTimerImpl(null, null);
    expect(os.activate()).toBe('no-timer');
    expect(os.active).toBe(false);
  });
});

describe('OrgasmSwitch — loop clock + device dispatch', () => {
  let deps;
  let os;
  let clock;
  beforeEach(() => {
    clock = { t: 0 };
    deps = makeDeps({ now: () => clock.t });
    os = new OrgasmSwitch(deps);
    os.setTimerImpl((cb, ms) => 1, () => {});
    os.loadScript(SCRIPT); // 0→100→0 over 2000ms
  });

  it('sends the start-of-loop position immediately on activate', () => {
    os.activate(); // immediate tick at elapsed 0 → pos 0
    expect(deps.buttplugManager.sendLinear).toHaveBeenCalledWith(0, 0, expect.any(Number));
    expect(deps.tcodeManager.sendAxes).toHaveBeenCalledWith({ L0: 0 });
    expect(deps.handyManager.hdspMove).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it('interpolates along its own clock, NOT video time', () => {
    os.activate();
    clock.t = 500;  // 25% through the 0→100 leg → pos 50
    os._tick();
    expect(deps.buttplugManager.sendLinear).toHaveBeenLastCalledWith(0, 50, expect.any(Number));
  });

  it('LOOPS: time past the duration wraps modulo the loop length', () => {
    os.activate();          // t=0 → pos 0
    clock.t = 2500;         // 2500 % 2000 = 500 → pos 50 (back on the first leg)
    os._tick();
    expect(deps.buttplugManager.sendLinear).toHaveBeenLastCalledWith(0, 50, expect.any(Number));
    clock.t = 3000;         // 3000 % 2000 = 1000 → pos 100 (peak)
    os._tick();
    expect(deps.buttplugManager.sendLinear).toHaveBeenLastCalledWith(0, 100, expect.any(Number));
  });

  it('skips sends that would not move the device (MIN_POS_DELTA)', () => {
    os.activate();              // pos 0
    const callsAfterActivate = deps.buttplugManager.sendLinear.mock.calls.length;
    clock.t = 0;                // same position
    os._tick();
    expect(deps.buttplugManager.sendLinear.mock.calls.length).toBe(callsAfterActivate);
  });

  it('only drives linear-capable Buttplug devices', () => {
    deps.buttplugManager.devices = [
      { index: 0, name: 'Stroker', canLinear: true },
      { index: 1, name: 'Vibe', canLinear: false },
    ];
    os.activate();
    clock.t = 500; os._tick();
    const indices = deps.buttplugManager.sendLinear.mock.calls.map((c) => c[0]);
    expect(indices).toContain(0);
    expect(indices).not.toContain(1);
  });

  it('skips disconnected managers without throwing', () => {
    deps.buttplugManager.connected = false;
    deps.tcodeManager.connected = false;
    deps.handyManager.connected = false;
    os.activate();
    clock.t = 500;
    expect(() => os._tick()).not.toThrow();
    expect(deps.buttplugManager.sendLinear).not.toHaveBeenCalled();
  });

  it('swallows a manager send that throws (best-effort delivery)', () => {
    deps.buttplugManager.sendLinear = vi.fn(() => { throw new Error('BLE dropped'); });
    os.activate();
    clock.t = 500;
    expect(() => os._tick()).not.toThrow();
  });

  it('does nothing when inactive', () => {
    clock.t = 500;
    os._tick();
    expect(deps.buttplugManager.sendLinear).not.toHaveBeenCalled();
  });
});
