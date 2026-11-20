/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-051 (2026-11-06, brokenobj #379, also in v0.9.2): Lovense Solace Pro
// strokes were jerky. The vendored Buttplug device config gives the Solace
// Pro (and the Kinky Makers OSSM) ONE feature carrying both
// hw_position_with_duration and oscillate, so the device serialises as
// canLinear AND canOscillate. ButtplugSync sent a LinearCmd per stroke and an
// Oscillate speed every tick to that one motor, and the two fought.
//
// Position wins on such a device. What is asserted is what the device is
// sent over 20 ticks of the REAL scheduler on a fake clock, in both linear
// strategies: only linear commands for the Solace-like device, and an
// oscillate-only machine (Hismith) still driven by speed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

// A 250 ms stroke script: 0 <-> 100 for 10 s.
const SCRIPT = Array.from({ length: 41 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 100 : 0 }));

const device = (index, name, caps) => ({
  index, name,
  canLinear: false, canVibrate: false, canRotate: false, canScalar: false, canOscillate: false,
  ...caps,
});

/** Play 20 scheduler ticks (40 ms each) and return what each device was sent. */
function play(devices, { strategy, setup } = {}) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  const sent = [];
  const rec = (kind) => vi.fn((index, value) => { sent.push({ kind, index, value }); return Promise.resolve({ ok: true }); });
  const buttplug = {
    connected: true,
    devices,
    sendLinear: rec('linear'),
    sendVibrate: rec('vibrate'),
    sendRotate: rec('rotate'),
    sendScalar: rec('scalar'),
    sendOscillate: rec('oscillate'),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
  const player = {
    video: { addEventListener() {}, removeEventListener() {} },
    currentTime: 0.1, paused: false, duration: 60,
  };
  const sync = new ButtplugSync({
    buttplugManager: buttplug,
    videoPlayer: player,
    funscriptEngine: { isLoaded: true, getActions: () => SCRIPT },
  });
  if (strategy) sync.setLinearStrategy(strategy);
  for (const d of devices) { sync.setRampUp(d.index, false); sync.setMaxIntensity(d.index, 100); }
  setup?.(sync);
  sync.start();
  for (let i = 0; i < 20; i++) {
    player.currentTime += 0.04;
    vi.advanceTimersByTime(40);
  }
  sync.stop();
  const of = (index, kind) => sent.filter((s) => s.index === index && s.kind === kind);
  return { sent, of };
}

afterEach(() => { vi.useRealTimers(); });

describe('FT-051: a device with position AND oscillate on one motor gets position only', () => {
  for (const strategy of ['action-boundary', 'interpolated']) {
    it(`Solace-like device (${strategy}): linear commands, no oscillate`, () => {
      const solace = device(0, 'Lovense Solace Pro', { canLinear: true, canOscillate: true });
      const { sent, of } = play([solace], { strategy });
      expect(of(0, 'linear').length).toBeGreaterThan(0);
      expect(of(0, 'oscillate')).toEqual([]);
      // Nothing else reaches that motor either.
      expect(sent.every((s) => s.kind === 'linear')).toBe(true);
    });

    it(`oscillate-only machine (${strategy}): still driven by speed`, () => {
      const hismith = device(1, 'Hismith', { canOscillate: true });
      const { of } = play([hismith], { strategy });
      expect(of(1, 'oscillate').length).toBeGreaterThan(0);
      expect(of(1, 'linear')).toEqual([]);
    });
  }

  it('the two side by side: each gets its own kind, one does not change the other', () => {
    const solace = device(0, 'Kinky Makers OSSM', { canLinear: true, canOscillate: true });
    const hismith = device(1, 'Hismith', { canOscillate: true });
    const { of } = play([solace, hismith]);
    expect(of(0, 'linear').length).toBeGreaterThan(0);
    expect(of(0, 'oscillate')).toEqual([]);
    expect(of(1, 'oscillate').length).toBeGreaterThan(0);
    expect(of(1, 'linear')).toEqual([]);
  });
});

// Block C fix-up (2026-11-06, real-app verifier 2; also in v0.9.2): a custom
// route assigned to an oscillate-only machine never drove it. The routing
// dialog offers the device, but _sendPendingAxisActions' custom-route branch
// sent linear, vibrate, rotate or scalar only: Fake Flywheel on route 2 got 0
// commands in 2.6 s while the stroker on main got its strokes.
describe('a custom route on an oscillate-only machine drives it', () => {
  /** Main on device 0, route 2 (its own script on CR1) on device 1. */
  const routed = (main, route) => (sync) => {
    sync._customRoutingActive = true;
    sync.setAxisAssignment(main, 'L0');
    sync.setAxisAssignment(route, 'CR1');
    sync.setAxisActions('CR1', SCRIPT);
  };

  for (const strategy of ['action-boundary', 'interpolated']) {
    it(`the flywheel on route 2 gets oscillate speeds, the stroker on main its strokes (${strategy})`, () => {
      const stroker = device(0, 'Stroker', { canLinear: true });
      const flywheel = device(1, 'Fake Flywheel', { canOscillate: true });
      const { of } = play([stroker, flywheel], { strategy, setup: routed(0, 1) });
      expect(of(1, 'oscillate').length).toBeGreaterThan(0);
      expect(of(1, 'linear')).toEqual([]);
      expect(of(0, 'linear').length).toBeGreaterThan(0);
      expect(of(0, 'oscillate')).toEqual([]);
    });
  }

  it('the route\'s oscillate keeps the Max cap (scalar-safety path, as the main stroke\'s)', () => {
    const flywheel = device(1, 'Fake Flywheel', { canOscillate: true });
    const { of } = play([flywheel], {
      strategy: 'interpolated',
      setup: (sync) => { routed(0, 1)(sync); sync.setMaxIntensity(1, 40); },
    });
    const speeds = of(1, 'oscillate').map((s) => s.value);
    expect(speeds.length).toBeGreaterThan(0);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(40);
  });

  it('a position-and-oscillate device on a route still gets position only (FT-051)', () => {
    const solace = device(1, 'Lovense Solace Pro', { canLinear: true, canOscillate: true });
    for (const strategy of ['action-boundary', 'interpolated']) {
      const { sent, of } = play([solace], { strategy, setup: routed(0, 1) });
      expect(of(1, 'linear').length, strategy).toBeGreaterThan(0);
      expect(sent.every((x) => x.kind === 'linear'), strategy).toBe(true);
    }
  });
});
