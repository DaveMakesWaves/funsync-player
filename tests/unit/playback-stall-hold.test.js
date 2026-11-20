/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FN-02 (2026-11-16): StallHold, the N-01 stall rule for the engines that
// read the clock every tick (Buttplug, T-Code), and isProxyStall, how a
// playback proxy's stall 'pause' is told from a real pause. Pure; the
// engines' own behaviour is in device-stall-hold.test.js. Since FN-05
// (2026-11-16) a stall holds only once its grace window (STALL_GRACE_MS) has
// run out; the window itself is in stall-grace.test.js.
import { describe, it, expect, vi } from 'vitest';
import { StallHold, isProxyStall, FROZEN_AFTER_MS, STALL_GRACE_MS } from '../../renderer/js/playback-stall.js';

function rig({ paused = false, readyState = 4, t = 10 } = {}) {
  const video = { paused, readyState, seeking: false, error: null };
  const player = { video, get paused() { return video.paused; }, currentTime: t };
  let now = 0;
  const onHold = vi.fn();
  const onRelease = vi.fn();
  const hold = new StallHold({ getPlayer: () => player, onHold, onRelease, now: () => now });
  /** `ms` of wall time in 50 ms ticks, the clock advancing `rate` x. */
  const run = (ms, rate = 1) => {
    let held = false;
    for (let w = 0; w < ms; w += 50) {
      now += 50;
      player.currentTime += (rate * 50) / 1000;
      held = hold.sample();
    }
    return held;
  };
  return { video, player, hold, onHold, onRelease, run };
}

describe('isProxyStall — a proxy\'s stall, not a pause', () => {
  it('stalled true and sourcePaused false is a stall; anything else is not', () => {
    expect(isProxyStall({ stalled: true, sourcePaused: false })).toBe(true);
    expect(isProxyStall({ stalled: true, sourcePaused: true })).toBe(false);
    expect(isProxyStall({ stalled: false, sourcePaused: false })).toBe(false);
    // An HTMLVideoElement has neither field; the phone never sends `stalled`.
    expect(isProxyStall({ paused: true })).toBe(false);
    expect(isProxyStall(null)).toBe(false);
  });
});

describe('StallHold', () => {
  it('waiting holds once (onHold) past the grace window, a later waiting or seeking adds nothing; clear() ends it without onRelease', () => {
    const r = rig();
    expect(r.hold.enter('seeking')).toBe(true);
    expect(r.hold.enter('waiting')).toBe(false);
    // FN-05: inside the window nothing is held yet.
    expect(r.hold.held).toBe(null);
    expect(r.hold.pending).toBe('waiting');   // a 'playing' is owed now
    expect(r.onHold).not.toHaveBeenCalled();
    expect(r.run(STALL_GRACE_MS, 0)).toBe(true);
    expect(r.hold.held).toBe('waiting');
    expect(r.onHold).toHaveBeenCalledTimes(1);
    expect(r.onHold).toHaveBeenCalledWith('waiting');
    expect(r.hold.clear()).toBe('waiting');
    expect(r.hold.held).toBe(null);
    expect(r.onRelease).not.toHaveBeenCalled();
  });

  it('\'stalled\' holds only when the element has run out of frames (then as waiting)', () => {
    const fed = rig({ readyState: 4 });
    expect(fed.hold.enter('stalled')).toBe(false);
    const starved = rig({ readyState: 2 });
    expect(starved.hold.enter('stalled')).toBe(true);
    expect(starved.hold.pending).toBe('waiting');   // FN-05: its window first
    expect(starved.run(STALL_GRACE_MS, 0)).toBe(true);
    expect(starved.hold.held).toBe('waiting');
  });

  it('a pause is not a stall; a proxy\'s stall pause is', () => {
    const r = rig({ paused: true });
    expect(r.hold.enter('waiting')).toBe(false);
    Object.assign(r.video, { stalled: true, sourcePaused: false });
    expect(r.hold.enter('proxy')).toBe(true);
  });

  it('a clock that stops with no event holds after FROZEN_AFTER_MS, and releases (onRelease) once it moves', () => {
    const r = rig();
    expect(r.run(2000)).toBe(false);
    expect(r.run(FROZEN_AFTER_MS - 100, 0)).toBe(false);
    expect(r.run(200, 0)).toBe(true);
    expect(r.onHold).toHaveBeenCalledWith('frozen');
    expect(r.run(50, 1)).toBe(true);    // 0.05 s: not yet a move
    expect(r.run(100, 1)).toBe(false);
    expect(r.onRelease).toHaveBeenCalledWith('frozen');
  });

  it('a starved element holds from the tick even with no event, and is not released while it stays starved', () => {
    const r = rig();
    r.video.readyState = 2;
    expect(r.run(50, 0)).toBe(false);          // FN-05: its window first
    expect(r.hold.pending).toBe('waiting');
    expect(r.run(STALL_GRACE_MS, 0)).toBe(true);
    expect(r.hold.held).toBe('waiting');
    // A seek lands somewhere new but the element still cannot play.
    r.player.currentTime += 30;
    expect(r.run(500, 0)).toBe(true);
    expect(r.onRelease).not.toHaveBeenCalled();
    r.video.readyState = 4;
    expect(r.run(150, 1)).toBe(false);
    expect(r.onRelease).toHaveBeenCalledTimes(1);
  });

  it('while paused the tick never holds, and a paused clock is never frozen', () => {
    const r = rig({ paused: true });
    expect(r.run(5000, 0)).toBe(false);
    expect(r.onHold).not.toHaveBeenCalled();
  });
});
