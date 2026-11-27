/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A vibrator during a script hold (EroScripts #434, 2026-11-23: "when the
// script stops moving ... the vibrations continue at the position level. So
// if the position is 0 it continues vibrating at like 5-10%").
//
// The tick sends only when the position changes, so during a hold NOTHING was
// sent and every speed-derived output kept its last MOVING value for the
// whole hold: 16 % in Speed mode, 45 % in Hybrid, on the script below. Now a
// hold (a flat segment), a gap past MAX_GAP_MS and the time after the last
// action send the outputs as the script stands: Speed 0, Position its level,
// Hybrid its position part, faded to off when "Hybrid fades to off during
// holds" is on. Linear strokers and flywheel machines are left as they were.
//
// The REAL ButtplugSync and its tick (`_sendPendingActions`), on a fake clock.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ButtplugSync, hybridHoldFactor, HYBRID_HOLD_GRACE_MS, HYBRID_HOLD_FADE_MS } from '../../renderer/js/buttplug-sync.js';

// A stroke 20 → 90 over 0.5 s, a hold at 90 until 4.5 s, a stroke down to 10 at 5 s.
const HOLD = [{ at: 0, pos: 20 }, { at: 500, pos: 90 }, { at: 4500, pos: 90 }, { at: 5000, pos: 10 }];

function rig({ caps = { canVibrate: true }, actions = HOLD, setup } = {}) {
  const dev = { index: 0, name: 'Gush', canLinear: false, canVibrate: false, canRotate: false, canScalar: false, canOscillate: false, ...caps };
  const buttplug = { devices: [dev], connected: true, sendOscillate: vi.fn(), sendVibrate: vi.fn(), sendLinear: vi.fn(), sendRotate: vi.fn(), sendScalar: vi.fn() };
  const player = { currentTime: 0, paused: false, addEventListener() {}, removeEventListener() {} };
  const sync = new ButtplugSync({ videoPlayer: player, buttplugManager: buttplug, funscriptEngine: { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions } });
  sync._cacheActions();
  setup?.(sync);
  /** Run the tick every 20 ms from..to; returns [t, value] of each send of `kind`. */
  const run = (from, to, kind = 'sendVibrate', arg = 1) => {
    const sent = [];
    for (let t = from; t <= to; t += 20) {
      buttplug[kind].mockClear();
      player.currentTime = t / 1000;
      vi.spyOn(performance, 'now').mockReturnValue(t);
      sync._sendPendingActions();
      if (buttplug[kind].mock.calls.length) sent.push([t, Math.round(buttplug[kind].mock.calls.at(-1)[arg])]);
    }
    return sent;
  };
  return { sync, buttplug, run };
}

afterEach(() => vi.restoreAllMocks());

const inHold = (sent) => sent.filter(([t]) => t > 600 && t < 4400);
const lastBefore = (sent, ms) => sent.filter(([t]) => t <= ms).at(-1)?.[1];

describe('a vibrator during a script hold', () => {
  it('Speed mode: off for the hold (it stayed at the last moving value, 16 %)', () => {
    const { run } = rig({ setup: (s) => s.setVibeMode(0, 'speed') });
    const sent = run(20, 4400);
    expect(lastBefore(sent, 600)).toBe(0);
    // Nothing needs to be sent again while the hold lasts: the device is off.
    expect(inHold(sent)).toEqual([]);
  });

  it('Hybrid: its position part for the hold (40 % of 90), not the last moving value', () => {
    const { run } = rig({ setup: (s) => s.setVibeMode(0, 'intensity') });
    const sent = run(20, 4400);
    expect(lastBefore(sent, 600)).toBe(36);
    expect(inHold(sent)).toEqual([]);
  });

  it('Hybrid with "fades to off during holds": down to 0 within the grace and the fade, never back up', () => {
    const { run } = rig({ setup: (s) => { s.setVibeMode(0, 'intensity'); s.setHybridHoldFade(true); } });
    const sent = run(20, 4400);
    // From the hold's start (500 ms). This read 460 until 2026-11-25: Per-stroke's
    // lookahead put the vibrate path into the hold 60 ms early, and the test
    // pinned that (at 460 the stroke still moves: Hybrid 63, not the hold's 36).
    const holdSends = sent.filter(([t]) => t >= 500);
    const values = holdSends.map(([, v]) => v);
    expect(values[0]).toBe(36);
    expect(values.at(-1)).toBe(0);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    const zeroAt = holdSends.find(([, v]) => v === 0)[0];
    expect(zeroAt - holdSends[0][0]).toBeLessThanOrEqual(HYBRID_HOLD_GRACE_MS + HYBRID_HOLD_FADE_MS + 60);
  });

  it('the fade lifts at once when the script moves again', () => {
    const { run } = rig({ setup: (s) => { s.setVibeMode(0, 'intensity'); s.setHybridHoldFade(true); } });
    run(20, 4400);
    const after = run(4420, 4900);
    expect(Math.max(...after.map(([, v]) => v))).toBeGreaterThan(30);
  });

  it('Position mode is unchanged: the level of the hold', () => {
    const { run } = rig({ setup: (s) => s.setVibeMode(0, 'position') });
    expect(lastBefore(run(20, 4400), 600)).toBe(90);
  });

  it('past the last action and in a long gap the outputs settle too', () => {
    const end = rig({ setup: (s) => s.setVibeMode(0, 'speed') });
    const sent = end.run(4400, 5600);
    expect(sent.at(-1)[1]).toBe(0);
    // A 9 s gap between two actions (over MAX_GAP_MS): settled, not left moving.
    const gap = rig({ actions: [{ at: 0, pos: 10 }, { at: 400, pos: 80 }, { at: 9400, pos: 30 }], setup: (s) => s.setVibeMode(0, 'speed') });
    const g = gap.run(20, 3000);
    expect(lastBefore(g, 3000)).toBe(0);
  });

  it('e-stim in Speed mode settles to 0 as well (it held its last level)', () => {
    const { run } = rig({ caps: { canScalar: true }, setup: (s) => s.setScalarMode(0, 'speed') });
    expect(lastBefore(run(20, 4400, 'sendScalar'), 600)).toBe(0);
  });

  it('flywheel machines and linear strokers are left as they were', () => {
    const machine = rig({ caps: { canOscillate: true }, setup: (s) => s.setOscillateMode(0, 'speed') });
    expect(inHold(machine.run(20, 4400, 'sendOscillate'))).toEqual([]);
    const stroker = rig({ caps: { canLinear: true } });
    const linear = stroker.run(20, 4400, 'sendLinear', 1);
    expect(inHold(linear)).toEqual([]);
  });
});

describe('hybridHoldFactor', () => {
  it('full through the grace, then a straight fade to 0', () => {
    expect(hybridHoldFactor(0)).toBe(1);
    expect(hybridHoldFactor(HYBRID_HOLD_GRACE_MS)).toBe(1);
    expect(hybridHoldFactor(HYBRID_HOLD_GRACE_MS + HYBRID_HOLD_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(hybridHoldFactor(HYBRID_HOLD_GRACE_MS + HYBRID_HOLD_FADE_MS)).toBe(0);
    expect(hybridHoldFactor(60_000)).toBe(0);
    expect(hybridHoldFactor(NaN)).toBe(1);
  });
});

// Found on Dave's Lovense Edge via Intiface (2026-11-25, the "Embedded Subs"
// fixture): a jump 20 -> 80 in 100 ms out of a 3.9 s hold sent 1 %, then 0.
// The hold's level is sent ONCE, at its start, so the first tick after it
// divided the stroke's movement by the time since that send: the whole hold.
// Every stroke after a hold or a gap started near 0, and a short snap out of
// one was lost. The speed is now the stroke's own, over the last tick.
describe('the first stroke after a hold', () => {
  const SNAP = [{ at: 0, pos: 20 }, { at: 3900, pos: 20 }, { at: 4000, pos: 80 }, { at: 8000, pos: 80 }, { at: 9000, pos: 30 }];
  const firstAfter = (sent, ms) => sent.find(([t]) => t > ms)?.[1];

  it('Speed: a 600 u/s snap out of a 3.9 s hold buzzes (it sent 1 %)', () => {
    const { run } = rig({ actions: SNAP, setup: (s) => s.setVibeMode(0, 'speed') });
    const sent = run(20, 4100);
    expect(firstAfter(sent, 3900)).toBeGreaterThanOrEqual(80);
    // And the hold that follows still turns it off.
    expect(lastBefore(sent, 4100)).toBe(0);
  });

  it('Speed: a 50 u/s stroke out of a 4 s hold starts at its own speed (about 17 %), not near 0', () => {
    const { run } = rig({ actions: SNAP, setup: (s) => s.setVibeMode(0, 'speed') });
    const sent = run(20, 8400);
    const first = firstAfter(sent, 8000);
    expect(first).toBeGreaterThanOrEqual(12);
    expect(first).toBeLessThanOrEqual(22);
  });

  it('Hybrid: the snap adds its speed part to the position part', () => {
    const { run } = rig({ actions: SNAP, setup: (s) => s.setVibeMode(0, 'intensity') });
    const sent = run(20, 4100);
    // 40 % of the position (about 32) + 60 % of the speed part (100) = about 70.
    expect(firstAfter(sent, 3900)).toBeGreaterThanOrEqual(60);
  });

  it('a stroke that keeps moving is measured as before (since the last send)', () => {
    const { run } = rig({ setup: (s) => s.setVibeMode(0, 'speed') });
    // HOLD's first stroke: 70 units in 500 ms = 140 u/s = 47 %.
    const sent = run(20, 460).filter(([t]) => t >= 100);
    for (const [, v] of sent) expect(Math.abs(v - 47)).toBeLessThanOrEqual(3);
  });
});

// The same night: Per-stroke (action-boundary, the default) moves the shared
// action index up to its lookahead EARLY for strokers, and the vibrate path
// read it, so 60 ms before every action it was already in the next segment:
// into a hold, it settled to 0 a lookahead early. On the Edge the 100 ms snap
// buzzed for one tick (100 then 0 at 3987 ms, still inside the snap) or not at
// all. The vibrate path now takes the action at or before the real time.
describe('Per-stroke\'s lookahead and a vibrator', () => {
  const SNAP = [{ at: 0, pos: 20 }, { at: 3900, pos: 20 }, { at: 4000, pos: 80 }, { at: 8000, pos: 80 }, { at: 9000, pos: 30 }];

  for (const lookahead of [60, 200]) {
    it(`a snap out of a hold buzzes for its whole length, the hold after it off (lookahead ${lookahead} ms)`, () => {
      const { run } = rig({ actions: SNAP, setup: (s) => { s.setVibeMode(0, 'speed'); s.setLinearStrategy('action-boundary'); s.setLinearLookaheadMs(lookahead); } });
      const sent = run(20, 4200);
      const inSnap = sent.filter(([t]) => t > 3900 && t < 4000);
      expect(inSnap.length).toBeGreaterThanOrEqual(1);
      for (const [, v] of inSnap) expect(v).toBeGreaterThanOrEqual(80);
      // The 0 comes once the hold has begun, not before.
      const firstZero = sent.find(([t, v]) => t > 3900 && v === 0)?.[0];
      expect(firstZero).toBeGreaterThanOrEqual(4000);
      expect(lastBefore(sent, 4200)).toBe(0);
    });
  }

  it('the stroker still gets each keyframe a lookahead early', () => {
    const { run } = rig({ caps: { canLinear: true }, actions: SNAP, setup: (s) => { s.setLinearStrategy('action-boundary'); s.setLinearLookaheadMs(60); } });
    const linear = run(20, 4200, 'sendLinear', 1);
    // The keyframe to 80 at 4000 ms goes out before 4000 (by about the lookahead).
    const to80 = linear.find(([, pos]) => pos === 80);
    expect(to80[0]).toBeLessThan(4000);
  });
});
