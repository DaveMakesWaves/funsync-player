/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Derived intensity must track how fast the script MOVES, not how it is
// authored.
//
// adventurous1, thread #274, on a Hismith flywheel machine:
//   "the speed will quit before the editor shows it should and the speed
//    dosn't seem to follow say 25% is faster than 40% but off is still off"
//
// Both symptoms, and the "off is still off" that made it confusing, come from
// one unit mismatch. `_computeVibeIntensity` divided the position change
// since the LAST SEND by the time remaining to the NEXT ACTION — two
// different intervals. So a single constant-speed stroke produced:
//
//     t=40ms   → 1.4%      t=500ms → 2.7%      t=960ms → 26.7%
//
// a sawtooth ramp repeating every stroke, instead of a flat 33%. Intensity
// therefore tracked keyframe SPACING rather than speed: widely spaced actions
// read as near-zero (machine stops while the editor shows it playing), and a
// densely authored "25%" section drove harder than a sparse "40%" one. Only
// a true zero stayed zero, which is why "off is still off".
//
// WHY THE EXISTING TESTS MISSED IT: they called `_sendToDevices` directly
// with a hand-picked duration, where "time to next action" and "time since
// last send" happen to be the same number. They only diverge when the real
// scheduler supplies them. These tests drive the tick loop instead.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

function machine(index = 0) {
  return {
    index, name: 'Hismith',
    canLinear: false, canVibrate: false, canRotate: false,
    canScalar: false, canOscillate: true,
  };
}

/** A sync engine driven by a fake clock and a fake player. */
function makeRig({ actions, devices = [machine()] }) {
  const buttplug = {
    devices,
    sendOscillate: vi.fn(),
    sendVibrate: vi.fn(),
    sendLinear: vi.fn(),
    sendRotate: vi.fn(),
    sendScalar: vi.fn(),
  };
  const player = { currentTime: 0, paused: false, addEventListener() {}, removeEventListener() {} };
  const funscript = {
    isLoaded: true,
    getActions: () => actions,
    getAuthoredActions: () => actions,
  };
  const sync = new ButtplugSync({
    videoPlayer: player, buttplugManager: buttplug, funscriptEngine: funscript,
  });
  sync._cacheActions();
  sync.setRampUp(0, false);          // ramp would mask the mapping
  sync.setOscillateMode(0, 'speed');
  return { sync, buttplug, player };
}

/**
 * Run the real dispatch tick at `tMs`, with `nowMs` as the wall clock so
 * `sinceLastMs` is whatever the scheduler actually computes.
 */
function runTick(sync, player, tMs, nowMs) {
  player.currentTime = tMs / 1000;
  // The dispatcher reads performance.now() itself and rate-limits on it, so
  // the fake clock has to advance in step with video time.
  vi.spyOn(performance, 'now').mockReturnValue(nowMs);
  sync.buttplug.connected = true;
  sync._sendPendingActions();
}

describe('speed mode tracks real stroke speed', () => {
  beforeEach(() => vi.restoreAllMocks());

  // THE REGRESSION. One constant-speed stroke must produce one constant
  // intensity, not a ramp.
  it('a constant-speed stroke gives a constant intensity', () => {
    // 0 → 100 over 1000ms = a steady 100 units/s throughout.
    const { sync, buttplug, player } = makeRig({
      actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }],
    });

    const sent = [];
    for (let t = 40; t <= 960; t += 40) {
      buttplug.sendOscillate.mockClear();
      runTick(sync, player, t, t);
      if (buttplug.sendOscillate.mock.calls.length) {
        sent.push(buttplug.sendOscillate.mock.calls.at(-1)[1]);
      }
    }

    expect(sent.length, 'no commands were dispatched at all').toBeGreaterThan(4);
    // Drop the priming send: the first dispatch has no previous position, so
    // its delta is 0 by definition. Everything after it is the real signal.
    const steady = sent.slice(1);
    const lo = Math.min(...steady);
    const hi = Math.max(...steady);
    // Interpolation and rounding move this a little; a RAMP moved it ~19x.
    expect(hi - lo, `intensity ramped across one stroke: ${lo.toFixed(1)} → ${hi.toFixed(1)}`)
      .toBeLessThan(12);
  });

  // "25% is faster than 40%": intensity followed keyframe spacing.
  it('does not depend on how densely the script is authored', () => {
    const speeds = {};
    for (const [label, actions] of Object.entries({
      // Identical motion — 100 units/s — expressed with different keyframe
      // spacing. A script author would call these the same script.
      sparse: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }],
      dense: Array.from({ length: 11 }, (_, i) => ({ at: i * 100, pos: i * 10 })),
    })) {
      const { sync, buttplug, player } = makeRig({ actions });
      const sent = [];
      for (let t = 40; t <= 900; t += 40) {
        buttplug.sendOscillate.mockClear();
        runTick(sync, player, t, t);
        if (buttplug.sendOscillate.mock.calls.length) {
          sent.push(buttplug.sendOscillate.mock.calls.at(-1)[1]);
        }
        vi.restoreAllMocks();
      }
      speeds[label] = sent.reduce((a, b) => a + b, 0) / Math.max(1, sent.length);
    }

    expect(
      Math.abs(speeds.sparse - speeds.dense),
      `same motion read as ${speeds.sparse.toFixed(1)} sparse vs ${speeds.dense.toFixed(1)} dense`,
    ).toBeLessThan(10);
  });

  // "quits before the editor shows it should".
  it('keeps driving through a long, widely spaced segment', () => {
    // One slow 0→100 move over 4s: legitimate motion, sparse keyframes.
    const { sync, buttplug, player } = makeRig({
      actions: [{ at: 0, pos: 0 }, { at: 4000, pos: 100 }],
    });

    const sent = [];
    for (let t = 200; t <= 3800; t += 200) {
      buttplug.sendOscillate.mockClear();
      runTick(sync, player, t, t);
      if (buttplug.sendOscillate.mock.calls.length) {
        sent.push(buttplug.sendOscillate.mock.calls.at(-1)[1]);
      }
      vi.restoreAllMocks();
    }

    expect(sent.length).toBeGreaterThan(4);
    // 25 units/s is genuinely slow, but it is NOT zero, and the machine
    // should not be told to stop while the script is still moving.
    expect(Math.max(...sent), 'machine was driven to a standstill mid-stroke')
      .toBeGreaterThan(0);
  });

  it('faster motion still reads as more intensity', () => {
    const measure = (durationMs) => {
      const { sync, buttplug, player } = makeRig({
        actions: [{ at: 0, pos: 0 }, { at: durationMs, pos: 100 }],
      });
      // Prime first — the opening dispatch always reads zero.
      runTick(sync, player, durationMs * 0.25, durationMs * 0.25);
      vi.restoreAllMocks();
      buttplug.sendOscillate.mockClear();
      runTick(sync, player, durationMs * 0.5, durationMs * 0.5);
      const call = buttplug.sendOscillate.mock.calls.at(-1);
      vi.restoreAllMocks();
      return call ? call[1] : 0;
    };
    // The whole point of speed mode: a quicker stroke drives harder.
    expect(measure(200)).toBeGreaterThan(measure(2000));
  });

  it('a genuinely stationary script still reads as zero', () => {
    // "off is still off" was the one behaviour that always worked; keep it.
    const { sync, buttplug, player } = makeRig({
      actions: [{ at: 0, pos: 0 }, { at: 2000, pos: 0 }],
    });
    for (let t = 40; t <= 800; t += 40) {
      runTick(sync, player, t, t);
      vi.restoreAllMocks();
    }
    for (const call of buttplug.sendOscillate.mock.calls) {
      expect(call[1]).toBe(0);
    }
  });
});
