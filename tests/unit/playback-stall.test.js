/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// N-01 (2026-11-16): the two answers to "is the picture moving?" that the
// Handy / Autoblow engines and the player pop-out share. Pure.
import { describe, it, expect } from 'vitest';
import {
  isPictureStarved, ProgressWatch, HAVE_FUTURE_DATA, FROZEN_AFTER_MS, MIN_ADVANCE_SEC,
} from '../../renderer/js/playback-stall.js';

describe('isPictureStarved — what the element itself says', () => {
  it('a playing element with a next frame is not starved', () => {
    expect(isPictureStarved({ paused: false, seeking: false, readyState: 4, error: null })).toBe(false);
    expect(isPictureStarved({ paused: false, readyState: HAVE_FUTURE_DATA })).toBe(false);
  });

  it('readyState below HAVE_FUTURE_DATA while not paused is starved (the repro: readyState 2, paused false)', () => {
    expect(isPictureStarved({ paused: false, readyState: 2 })).toBe(true);
    expect(isPictureStarved({ paused: false, readyState: 1 })).toBe(true);
    expect(isPictureStarved({ paused: false, readyState: 0 })).toBe(true);
  });

  it('seeking or a media error while not paused is starved, whatever readyState says', () => {
    expect(isPictureStarved({ paused: false, seeking: true, readyState: 4 })).toBe(true);
    expect(isPictureStarved({ paused: false, readyState: 4, error: { code: 3 } })).toBe(true);
  });

  it('a paused element is never starved: a pause is its own answer', () => {
    expect(isPictureStarved({ paused: true, readyState: 0, seeking: true })).toBe(false);
  });

  it('a proxy with no readyState is judged by seeking / error only, never held on a readyState it lacks', () => {
    expect(isPictureStarved({ paused: false })).toBe(false);
    expect(isPictureStarved(null)).toBe(false);
    expect(isPictureStarved(undefined)).toBe(false);
  });
});

describe('ProgressWatch — a clock that stops with no event', () => {
  it('a clock moving at 1x is never frozen', () => {
    const w = new ProgressWatch();
    for (let ms = 0; ms <= 10000; ms += 250) expect(w.sample(ms / 1000, false, ms)).toBe(false);
  });

  it('the slowest playback rate (0.25x) is not mistaken for a freeze', () => {
    const w = new ProgressWatch();
    for (let ms = 0; ms <= 10000; ms += 250) expect(w.sample(0.25 * ms / 1000, false, ms)).toBe(false);
  });

  it('a time that stays put is frozen after FROZEN_AFTER_MS, not before', () => {
    const w = new ProgressWatch();
    expect(w.sample(20.881, false, 0)).toBe(false);
    expect(w.sample(20.881, false, FROZEN_AFTER_MS - 1)).toBe(false);
    expect(w.sample(20.881, false, FROZEN_AFTER_MS)).toBe(true);
    expect(w.sample(20.881, false, FROZEN_AFTER_MS + 5000)).toBe(true);
  });

  it('a frozen time fed through an interpolating proxy (a 0.1 s sawtooth) is still frozen', () => {
    // The pop-out repro: ticks every 100 ms carried the same frozen time and
    // the proxy extrapolated up to 0.1 s between them, so every sample
    // differed from the one before while the clock went nowhere.
    const w = new ProgressWatch();
    let frozenAt = null;
    for (let ms = 0; ms <= 2000; ms += 25) {
      const t = 79.98 + ((ms % 100) / 1000) * 0.99;
      if (w.sample(t, false, ms) && frozenAt === null) frozenAt = ms;
    }
    expect(frozenAt).not.toBeNull();
    expect(frozenAt).toBeLessThanOrEqual(FROZEN_AFTER_MS + 100);
  });

  it('movement of MIN_ADVANCE_SEC ends the freeze at once', () => {
    const w = new ProgressWatch();
    w.sample(5, false, 0);
    expect(w.sample(5, false, 1500)).toBe(true);
    expect(w.sample(5 + MIN_ADVANCE_SEC, false, 1600)).toBe(false);
  });

  it('a seek (a jump either way) starts a new window instead of counting as a freeze', () => {
    const w = new ProgressWatch();
    w.sample(30, false, 0);
    expect(w.sample(150, false, 900)).toBe(false);   // jump forward
    expect(w.sample(150, false, 1800)).toBe(false);  // 900 ms since the jump
    expect(w.sample(150, false, 1900)).toBe(true);   // the new position sat still a full window
    expect(w.sample(10, false, 2000)).toBe(false);   // jump back
  });

  it('a pause resets the window: resuming is not reported frozen from before the pause', () => {
    const w = new ProgressWatch();
    w.sample(5, false, 0);
    expect(w.sample(5, true, 5000)).toBe(false);
    expect(w.sample(5, false, 5100)).toBe(false);
    expect(w.sample(5.05, false, 5900)).toBe(false);
  });

  it('a non-finite time is never frozen', () => {
    const w = new ProgressWatch();
    expect(w.sample(NaN, false, 0)).toBe(false);
    expect(w.sample(NaN, false, 5000)).toBe(false);
  });
});
