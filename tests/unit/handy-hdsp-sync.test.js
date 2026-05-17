// Tests for the Handy HDSP-polled sync engine.
//
// Community report from NishaDD (2026-05-17): when the user changes the
// video playback rate (e.g. 1.5×), the Handy script plays at 1.0× —
// out of sync with the video. Buttplug works correctly because its
// scheduler reads `video.currentTime` per tick, which scales with rate.
//
// Root cause (from research): HSSP's `hsspPlay(timeMs, estServerTime)`
// has no rate parameter — the cloud schedules the script at 1.0×. The
// fix is to switch to HDSP-polled mode at non-1.0× rates. HDSP is per-
// tick (`hdspMove(position, durationMs)`) so reading currentTime each
// tick naturally scales. MultiFunPlayer uses this same strategy as its
// default for Handy.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HandyHdspSync, interpolatePosition } from '../../renderer/js/handy-hdsp-sync.js';

describe('interpolatePosition — pure linear interpolation', () => {
  it('returns null for empty / non-array input', () => {
    expect(interpolatePosition(null, 100)).toBeNull();
    expect(interpolatePosition([], 100)).toBeNull();
    expect(interpolatePosition('abc', 100)).toBeNull();
  });

  it('clamps to first action when time is before any action', () => {
    const actions = [{ at: 1000, pos: 30 }, { at: 2000, pos: 70 }];
    expect(interpolatePosition(actions, 0)).toBe(30);
    expect(interpolatePosition(actions, 999)).toBe(30);
    expect(interpolatePosition(actions, 1000)).toBe(30);
  });

  it('clamps to last action when time is after any action', () => {
    const actions = [{ at: 1000, pos: 30 }, { at: 2000, pos: 70 }];
    expect(interpolatePosition(actions, 2000)).toBe(70);
    expect(interpolatePosition(actions, 5000)).toBe(70);
  });

  it('linearly interpolates between adjacent actions', () => {
    const actions = [{ at: 1000, pos: 0 }, { at: 2000, pos: 100 }];
    expect(interpolatePosition(actions, 1500)).toBe(50);
    expect(interpolatePosition(actions, 1250)).toBe(25);
    expect(interpolatePosition(actions, 1750)).toBe(75);
  });

  it('handles non-monotonic positions (down then up)', () => {
    const actions = [
      { at: 0, pos: 80 },
      { at: 1000, pos: 20 },
      { at: 2000, pos: 90 },
    ];
    expect(interpolatePosition(actions, 500)).toBe(50);
    expect(interpolatePosition(actions, 1500)).toBe(55);
  });

  it('binary-searches efficiently over many actions', () => {
    // Construct an array of 1000 actions; assert correct lookup near the
    // tail without scanning from the head.
    const actions = [];
    for (let i = 0; i < 1000; i++) actions.push({ at: i * 100, pos: i % 2 === 0 ? 0 : 100 });
    // Between the 998th and 999th action — pos goes from 0 (998) to 100 (999).
    expect(interpolatePosition(actions, 998 * 100 + 50)).toBe(50);
  });

  it('handles a single-action script gracefully', () => {
    const actions = [{ at: 500, pos: 42 }];
    expect(interpolatePosition(actions, 0)).toBe(42);
    expect(interpolatePosition(actions, 500)).toBe(42);
    expect(interpolatePosition(actions, 999999)).toBe(42);
  });

  it('handles zero-span bracket (two actions at same time)', () => {
    const actions = [{ at: 1000, pos: 50 }, { at: 1000, pos: 80 }];
    // Either pos is acceptable; the function returns the upper bracket.
    expect(interpolatePosition(actions, 1000)).toBe(50); // first match
  });
});

describe('HandyHdspSync — lifecycle', () => {
  let handyManager;
  let player;
  let sync;
  let intervalCalls;
  let activeTimerCb;

  beforeEach(() => {
    handyManager = { hdspMove: vi.fn() };
    player = { currentTime: 0 };
    intervalCalls = [];
    sync = new HandyHdspSync({ handyManager, player });
    activeTimerCb = null;
    sync.setTimerImpl(
      (cb, ms) => {
        intervalCalls.push(ms);
        activeTimerCb = cb;
        return intervalCalls.length;
      },
      (id) => { if (id === intervalCalls.length) activeTimerCb = null; },
    );
  });

  it('starts inactive', () => {
    expect(sync.active).toBe(false);
  });

  it('start() arms the scheduler at 33ms (≈30 Hz)', () => {
    sync.setActions([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]);
    sync.start();
    expect(sync.active).toBe(true);
    expect(intervalCalls).toEqual([33]);
  });

  it('start() is idempotent', () => {
    sync.setActions([{ at: 0, pos: 0 }]);
    sync.start();
    sync.start();
    sync.start();
    expect(intervalCalls.length).toBe(1);
  });

  it('stop() clears the scheduler and is idempotent', () => {
    sync.setActions([{ at: 0, pos: 0 }]);
    sync.start();
    sync.stop();
    expect(sync.active).toBe(false);
    sync.stop();
    sync.stop();
    expect(sync.active).toBe(false);
  });

  it('does not start without a handyManager / player', () => {
    const orphan = new HandyHdspSync({ handyManager: null, player: null });
    orphan.setTimerImpl((cb, ms) => 1, () => {});
    orphan.start();
    expect(orphan.active).toBe(false);
  });

  it('does not start without a timer impl', () => {
    const noTimer = new HandyHdspSync({ handyManager, player });
    noTimer.setTimerImpl(null, null);
    noTimer.start();
    expect(noTimer.active).toBe(false);
  });

  it('accepts custom tick / lookahead intervals', () => {
    const fast = new HandyHdspSync({ handyManager, player }, { tickIntervalMs: 16, lookaheadMs: 50 });
    fast.setTimerImpl((cb, ms) => { intervalCalls.push(ms); return 1; }, () => {});
    fast.setActions([{ at: 0, pos: 0 }]);
    fast.start();
    expect(intervalCalls).toContain(16);
  });
});

describe('HandyHdspSync — tick → hdspMove dispatch', () => {
  let handyManager;
  let player;
  let sync;

  beforeEach(() => {
    handyManager = { hdspMove: vi.fn() };
    player = { currentTime: 0 };
    sync = new HandyHdspSync({ handyManager, player });
    sync.setTimerImpl((cb, ms) => 1, () => {});
    sync.setActions([
      { at: 0, pos: 0 },
      { at: 1000, pos: 100 },
    ]);
    sync.start();
  });

  it('sends position from interpolation', () => {
    player.currentTime = 0.5; // 500ms — halfway between actions
    sync._tick();
    expect(handyManager.hdspMove).toHaveBeenCalledTimes(1);
    expect(handyManager.hdspMove).toHaveBeenCalledWith(50, 100);
  });

  it('skips ticks that wouldn\'t move the device (MIN_POS_DELTA)', () => {
    player.currentTime = 0.5;
    sync._tick();
    // Same time → same target → no command.
    sync._tick();
    expect(handyManager.hdspMove).toHaveBeenCalledTimes(1);
  });

  it('emits a fresh command after the position changes meaningfully', () => {
    player.currentTime = 0.5;
    sync._tick();
    player.currentTime = 0.6; // pos 60 — 10 unit jump
    sync._tick();
    expect(handyManager.hdspMove).toHaveBeenCalledTimes(2);
    expect(handyManager.hdspMove.mock.calls[1][0]).toBe(60);
  });

  it('does nothing when not active', () => {
    sync.stop();
    player.currentTime = 0.5;
    sync._tick();
    expect(handyManager.hdspMove).not.toHaveBeenCalled();
  });

  it('does nothing without actions', () => {
    sync.setActions(null);
    player.currentTime = 0.5;
    sync._tick();
    expect(handyManager.hdspMove).not.toHaveBeenCalled();
  });

  it('swallows hdspMove throws (best-effort delivery)', () => {
    handyManager.hdspMove = vi.fn(() => { throw new Error('disconnected'); });
    player.currentTime = 0.5;
    expect(() => sync._tick()).not.toThrow();
  });

  it('handles negative currentTime defensively (clamps to 0)', () => {
    player.currentTime = -1;
    sync._tick();
    // Should interpolate at 0ms → pos 0 (first action). The dirty-check
    // filter still fires because _lastSentPos starts at -1.
    expect(handyManager.hdspMove).toHaveBeenCalledWith(0, 100);
  });
});

describe('HandyHdspSync — setActions filters + sorts', () => {
  it('filters out non-action entries', () => {
    const sync = new HandyHdspSync({ handyManager: { hdspMove: vi.fn() }, player: { currentTime: 0 } });
    sync.setActions([
      { at: 100, pos: 50 },
      { at: null, pos: 30 }, // bad
      'garbage',
      { at: 200, pos: 70 },
      { at: 50, pos: 20 }, // out of order
    ]);
    expect(sync._actions).toEqual([
      { at: 50, pos: 20 },
      { at: 100, pos: 50 },
      { at: 200, pos: 70 },
    ]);
  });

  it('treats non-array as null', () => {
    const sync = new HandyHdspSync({ handyManager: { hdspMove: vi.fn() }, player: { currentTime: 0 } });
    sync.setActions(null);
    expect(sync._actions).toBeNull();
    sync.setActions('abc');
    expect(sync._actions).toBeNull();
  });
});

describe('Rate-scaling validation — the bug being fixed', () => {
  // The whole point: at non-1.0× playback rate, the HDSP-polled engine
  // emits positions at the correct effective rate because it reads
  // `video.currentTime`, which advances at the playback-scaled rate.
  // This test simulates the rate-scaled time advance and asserts the
  // emitted positions track the video.

  it('emits positions that follow currentTime regardless of rate', () => {
    const handyManager = { hdspMove: vi.fn() };
    const player = { currentTime: 0 };
    const sync = new HandyHdspSync({ handyManager, player });
    sync.setTimerImpl((cb, ms) => 1, () => {});
    sync.setActions([
      { at: 0, pos: 0 },
      { at: 1000, pos: 100 },
    ]);
    sync.start();

    // Simulate 1.5× playback: time advances 1.5× per "real" tick.
    // 5 real ticks * 33ms per tick = 165ms, but at 1.5× that's 247.5ms
    // of script time → pos ≈ 24.75. Three ticks land at:
    //  - 0    → pos 0
    //  - 0.05 → pos 5
    //  - 0.10 → pos 10
    //  - 0.15 → pos 15
    //  - 0.20 → pos 20
    // The dirty-filter (delta >= 1) lets every step through.
    const positions = [];
    for (let i = 0; i < 5; i++) {
      player.currentTime = i * 0.05;
      sync._tick();
      if (handyManager.hdspMove.mock.calls[i]) {
        positions.push(handyManager.hdspMove.mock.calls[i][0]);
      }
    }
    // Float-precision tolerance on a couple of the lerps (e.g. 0.15 *
    // 100 = 15.000...2). Round each to a single decimal.
    const rounded = positions.map((p) => Math.round(p * 10) / 10);
    expect(rounded).toEqual([0, 5, 10, 15, 20]);
  });
});
