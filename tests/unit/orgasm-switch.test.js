/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
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
      sendVibrate: vi.fn(),
      sendRotate: vi.fn(),
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

describe('OrgasmSwitch — default timer wiring (no injected impl)', () => {
  it('activate() forwards to the global setInterval and starts the loop (no Illegal invocation)', () => {
    // Regression: the default `_setIntervalImpl` was a BARE `setInterval`
    // reference, so `this._setIntervalImpl(...)` threw "Illegal invocation" in
    // Electron — activate() aborted after stopping the sync engines, so the
    // device just stopped and the loop never ran.
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(42);
    try {
      const os = new OrgasmSwitch(makeDeps()); // real default wrapper, not injected
      os.loadScript(SCRIPT);
      expect(os.activate()).toBe('activated'); // must not throw
      expect(spy).toHaveBeenCalled();
      expect(os._timer).toBe(42);
      expect(os.buttplugManager.sendLinear).toHaveBeenCalled(); // immediate tick ran
    } finally {
      spy.mockRestore();
    }
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

  it('gates the Handy send on handyReady but still drives Buttplug/T-Code', () => {
    // While the app is still awaiting the HSSP→HDSP handoff, handyReady is
    // false: the Handy must NOT be driven (its commands would be ignored in
    // HSSP mode), but the local devices drive immediately.
    let ready = false;
    const gated = new OrgasmSwitch(makeDeps({ now: () => 0, handyReady: () => ready }));
    gated.setTimerImpl(() => 1, () => {});
    gated.loadScript(SCRIPT);
    gated.activate();
    expect(gated.buttplugManager.sendLinear).toHaveBeenCalled();
    expect(gated.handyManager.hdspMove).not.toHaveBeenCalled();
    // Once the handoff completes, the next tick drives the Handy.
    ready = true;
    gated._lastSentPos = -1; // allow the same position to re-send
    gated._tick();
    expect(gated.handyManager.hdspMove).toHaveBeenCalled();
  });

  it('applies the per-device cutoff so the finisher respects output limits', () => {
    const d = makeDeps({ now: () => 0, getCutoff: (key) => (key === 'handy' ? { min: 20, max: 80 } : null) });
    const os2 = new OrgasmSwitch(d);
    os2.setTimerImpl(() => 1, () => {});
    os2.loadScript(SCRIPT); // at t=0 → pos 0
    os2.activate();
    // Handy has a 20-80 cutoff → 0 clamps to 20; Buttplug has none → raw 0.
    expect(d.handyManager.hdspMove).toHaveBeenCalledWith(20, expect.any(Number));
    expect(d.buttplugManager.sendLinear).toHaveBeenCalledWith(0, 0, expect.any(Number));
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

  it('drives linear devices via sendLinear, vibes via speed-mapped sendVibrate', () => {
    // Vibe support added 2026-08-04 (community/Dave: a vibe-only device
    // went silent for the whole hold — the loop only drove strokers).
    deps.buttplugManager.devices = [
      { index: 0, name: 'Stroker', canLinear: true },
      { index: 1, name: 'Vibe', canLinear: false, canVibrate: true },
    ];
    os.activate();
    clock.t = 500; os._tick();
    const linearIdx = deps.buttplugManager.sendLinear.mock.calls.map((c) => c[0]);
    expect(linearIdx).toContain(0);
    expect(linearIdx).not.toContain(1); // vibes never get linear commands
    const vibeCalls = deps.buttplugManager.sendVibrate.mock.calls;
    expect(vibeCalls.length).toBeGreaterThan(0);
    expect(vibeCalls[0][0]).toBe(1);
    // Intensity is the sync engine's speed formula: 0-100, clamped.
    expect(vibeCalls[0][1]).toBeGreaterThanOrEqual(0);
    expect(vibeCalls[0][1]).toBeLessThanOrEqual(100);
  });

  it('drives rotate devices, and NEVER drives e-stim (safety caps live in the engine)', () => {
    deps.buttplugManager.sendScalar = vi.fn();
    deps.buttplugManager.devices = [
      { index: 2, name: 'Rotator', canRotate: true },
      { index: 3, name: 'EStim', canScalar: true },
    ];
    os.activate();
    clock.t = 500; os._tick();
    expect(deps.buttplugManager.sendRotate).toHaveBeenCalled();
    expect(deps.buttplugManager.sendRotate.mock.calls[0][0]).toBe(2);
    // E-stim bypassing the engine's max-cap + ramp-up would be unsafe.
    expect(deps.buttplugManager.sendScalar).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Multi-source plans (2026-08-04): loadPlan() drives multi-axis bundles and
// custom routing through the same shared-clock loop. Plans come from
// orgasm-plan.js; these tests feed hand-built plans directly.
// ---------------------------------------------------------------------------

const MAIN = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }];
const TWIST = [{ at: 0, pos: 50 }, { at: 500, pos: 90 }, { at: 2000, pos: 50 }];
const VIB = [{ at: 0, pos: 20 }, { at: 2000, pos: 80 }];
const ROUTED = [{ at: 0, pos: 10 }, { at: 1000, pos: 95 }, { at: 2000, pos: 10 }];

const multiPlan = (over = {}) => ({
  mode: 'multi',
  main: MAIN,
  loopMs: 2000,
  tcodeAxes: { L0: MAIN, R0: TWIST, V0: VIB },
  vib: null,
  bpMode: 'broadcast',
  bpRoutes: null,
  ...over,
});

describe('OrgasmSwitch — loadPlan (multi-axis)', () => {
  let deps;
  let os;
  let clock;
  beforeEach(() => {
    clock = { t: 0 };
    deps = makeDeps({ now: () => clock.t });
    os = new OrgasmSwitch(deps);
    os.setTimerImpl(() => 1, () => {});
  });

  it('loadPlan configures; loadPlan(null) clears', () => {
    expect(os.loadPlan(multiPlan())).toBe(true);
    expect(os.configured).toBe(true);
    expect(os._durationMs).toBe(2000);
    expect(os.loadPlan(null)).toBe(false);
    expect(os.configured).toBe(false);
  });

  it('sends ALL tcode channels in ONE sendAxes call', () => {
    os.loadPlan(multiPlan());
    os.activate();
    clock.t = 250; os._tick();
    // t=250: L0 = 25, R0 = 70 (halfway 50→90), V0 = 27.5
    const last = deps.tcodeManager.sendAxes.mock.calls.at(-1)[0];
    expect(Object.keys(last).sort()).toEqual(['L0', 'R0', 'V0']);
    expect(last.L0).toBeCloseTo(25, 0);
    expect(last.R0).toBeCloseTo(70, 0);
  });

  it('a static main does NOT starve moving aux channels (per-channel delta)', () => {
    // Main holds 100 from 900..1100; twist keeps moving.
    const flatMain = [{ at: 0, pos: 100 }, { at: 2000, pos: 100 }];
    os.loadPlan(multiPlan({ main: flatMain, tcodeAxes: { L0: flatMain, R0: TWIST } }));
    os.activate();
    clock.t = 250; os._tick();
    const last = deps.tcodeManager.sendAxes.mock.calls.at(-1)[0];
    expect(last.R0).toBeCloseTo(70, 0);
    expect(last.L0).toBeUndefined(); // main didn't move → channel skipped
    // …and linear buttplug devices also skip (main static).
    const linearCalls = deps.buttplugManager.sendLinear.mock.calls.length;
    clock.t = 300; os._tick();
    expect(deps.buttplugManager.sendLinear.mock.calls.length).toBe(linearCalls);
  });

  it('tcode stroke cutoff applies to L0 only — rotation channels pass raw', () => {
    const d = makeDeps({ now: () => clock.t, getCutoff: (k) => (k === 'tcode' ? { min: 40, max: 60 } : null) });
    const os2 = new OrgasmSwitch(d);
    os2.setTimerImpl(() => 1, () => {});
    os2.loadPlan(multiPlan());
    os2.activate(); // t=0: L0 raw 0 → clamped 40; R0 raw 50 stays 50
    const first = d.tcodeManager.sendAxes.mock.calls[0][0];
    expect(first.L0).toBe(40);
    expect(first.R0).toBe(50);
  });

  it('dedicated vib channel drives vibe devices by POSITION (intensity script)', () => {
    deps.buttplugManager.devices = [
      { index: 0, name: 'Stroker', canLinear: true },
      { index: 1, name: 'Vibe', canVibrate: true },
    ];
    os.loadPlan(multiPlan({ vib: VIB }));
    os.activate();
    clock.t = 1000; os._tick();
    // vib at t=1000 → pos 50 → intensity 50 (position IS intensity).
    const vibeCalls = deps.buttplugManager.sendVibrate.mock.calls;
    expect(vibeCalls.at(-1)[0]).toBe(1);
    expect(vibeCalls.at(-1)[1]).toBeCloseTo(50, 0);
  });

  it('axis-only plan (no main): aux channels drive, linear/handy stay silent', () => {
    os.loadPlan(multiPlan({ main: null, tcodeAxes: { R0: TWIST } }));
    expect(os.configured).toBe(true);
    os.activate();
    clock.t = 250; os._tick();
    expect(deps.tcodeManager.sendAxes).toHaveBeenCalled();
    expect(deps.buttplugManager.sendLinear).not.toHaveBeenCalled();
    expect(deps.handyManager.hdspMove).not.toHaveBeenCalled();
  });
});

describe('OrgasmSwitch — loadPlan (custom routing)', () => {
  let deps;
  let os;
  let clock;
  const customPlan = (over = {}) => ({
    mode: 'custom',
    main: MAIN,
    loopMs: 2000,
    tcodeAxes: {},
    vib: null,
    bpMode: 'routed',
    bpRoutes: [{ deviceIndex: 0, actions: MAIN, name: 'Stroker' }],
    ...over,
  });

  beforeEach(() => {
    clock = { t: 0 };
    deps = makeDeps({ now: () => clock.t });
    deps.buttplugManager.devices = [
      { index: 0, name: 'Stroker', canLinear: true },
      { index: 1, name: 'Hush', canVibrate: true },
    ];
    os = new OrgasmSwitch(deps);
    os.setTimerImpl(() => 1, () => {});
  });

  it('routed devices get their OWN script; unrouted devices stay silent', () => {
    os.loadPlan(customPlan({
      bpRoutes: [
        { deviceIndex: 0, actions: MAIN, name: 'Stroker' },
        { deviceIndex: 1, actions: ROUTED, name: 'Hush' },
      ],
    }));
    os.activate();
    clock.t = 500; os._tick();
    // Stroker (linear): MAIN at 500 → 50.
    const linear = deps.buttplugManager.sendLinear.mock.calls;
    expect(linear.every((c) => c[0] === 0)).toBe(true);
    expect(linear.at(-1)[1]).toBeCloseTo(50, 0);
    // Hush (vibe-only): driven from ROUTED via the speed formula (clamped).
    const vibe = deps.buttplugManager.sendVibrate.mock.calls;
    expect(vibe.length).toBeGreaterThan(0);
    expect(vibe.every((c) => c[0] === 1)).toBe(true);
    expect(vibe.at(-1)[1]).toBeGreaterThan(0);
    expect(vibe.at(-1)[1]).toBeLessThanOrEqual(100);
  });

  it('a device whose route disappeared (unplugged) is skipped without throwing', () => {
    os.loadPlan(customPlan({ bpRoutes: [{ deviceIndex: 9, actions: MAIN, name: 'Gone' }] }));
    os.activate();
    clock.t = 500;
    expect(() => os._tick()).not.toThrow();
    expect(deps.buttplugManager.sendLinear).not.toHaveBeenCalled();
  });

  it('bpMode "keep" sends nothing to Buttplug (main engine still owns it)', () => {
    os.loadPlan(customPlan({ bpMode: 'keep', bpRoutes: null, tcodeAxes: { L0: ROUTED } }));
    os.activate();
    clock.t = 500; os._tick();
    expect(deps.buttplugManager.sendLinear).not.toHaveBeenCalled();
    expect(deps.buttplugManager.sendVibrate).not.toHaveBeenCalled();
    expect(deps.tcodeManager.sendAxes).toHaveBeenCalled(); // tcode route still drives
  });

  it('never drives e-stim from a route (safety caps live in the engine)', () => {
    deps.buttplugManager.sendScalar = vi.fn();
    deps.buttplugManager.devices = [{ index: 2, name: 'EStim', canScalar: true }];
    os.loadPlan(customPlan({ bpRoutes: [{ deviceIndex: 2, actions: MAIN, name: 'EStim' }] }));
    os.activate();
    clock.t = 500; os._tick();
    expect(deps.buttplugManager.sendScalar).not.toHaveBeenCalled();
    expect(deps.buttplugManager.sendVibrate).not.toHaveBeenCalled();
  });

  it('never drives a flywheel MACHINE from a route', () => {
    // Same reasoning as e-stim, and it matters more: the finisher is a
    // sustained hold at high speed, the cap + ramp safety lives in the sync
    // engine, and a flywheel has inertia it cannot shed on release.
    deps.buttplugManager.sendOscillate = vi.fn();
    deps.buttplugManager.devices = [{ index: 2, name: 'Hismith', canOscillate: true }];
    os.loadPlan(customPlan({ bpRoutes: [{ deviceIndex: 2, actions: MAIN, name: 'Hismith' }] }));
    os.activate();
    clock.t = 500; os._tick();
    expect(deps.buttplugManager.sendOscillate).not.toHaveBeenCalled();
  });

  it('never drives a machine from the broadcast path either', () => {
    // Guarded explicitly rather than relying on the device lacking
    // canVibrate — some hardware exposes both.
    deps.buttplugManager.sendOscillate = vi.fn();
    deps.buttplugManager.devices = [
      { index: 2, name: 'Hismith', canOscillate: true, canVibrate: true },
    ];
    os.loadPlan(customPlan({ bpMode: 'broadcast', bpRoutes: null }));
    os.activate();
    clock.t = 500; os._tick();
    expect(deps.buttplugManager.sendOscillate).not.toHaveBeenCalled();
    expect(deps.buttplugManager.sendVibrate).not.toHaveBeenCalled();
  });

  it('preserveClock swaps the plan mid-hold without restarting the pattern', () => {
    os.loadPlan(customPlan());
    os.activate();
    clock.t = 1000; os._tick();
    // Demotion mid-hold: swap to a single-style plan, clock preserved.
    os.loadPlan({
      mode: 'single', main: MAIN, loopMs: 2000,
      tcodeAxes: { L0: MAIN }, vib: null, bpMode: 'broadcast', bpRoutes: null,
    }, { preserveClock: true });
    expect(os.active).toBe(true);
    clock.t = 1500; os._tick();
    // t=1500 on the SAME clock → pos 50 on the falling edge (not 25, which
    // a restarted clock at t=500-after-swap would give... both are 50/25?
    // 1500 → falling leg 100→0 at 50%: pos 50. A reset clock would read
    // 500 → rising leg pos 50 too — so assert via the NEXT tick instead.
    clock.t = 1800; os._tick();
    const last = deps.buttplugManager.sendLinear.mock.calls.at(-1);
    expect(last[1]).toBeCloseTo(20, 0); // 1800 → 100 - (800/1000)*100 = 20
  });
});
