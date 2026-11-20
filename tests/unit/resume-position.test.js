/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Unit tests for resume-position helpers — imports from real source
import { describe, it, expect } from 'vitest';
import {
  MIN_RECORD_SECONDS,
  END_TAIL_SECONDS,
  endThreshold,
  shouldRecordPosition,
  shouldOfferResume,
  resumeProgressFraction,
  formatResumeTime,
  makeResumeEntry,
  makeFinishedEntry,
  isFinished,
} from '../../renderer/js/resume-position.js';

describe('endThreshold', () => {
  it('uses the 30s tail for short videos (5% would be smaller)', () => {
    // 5% of 300s = 15s, which is less than the 30s floor → 30s wins.
    expect(endThreshold(300)).toBe(270);
  });

  it('uses the 5% tail for long videos (30s would be smaller)', () => {
    // 5% of 3600s = 180s, larger than the 30s floor → 180s wins.
    expect(endThreshold(3600)).toBe(3420);
  });

  it('returns 0 for an unusable duration', () => {
    expect(endThreshold(0)).toBe(0);
    expect(endThreshold(NaN)).toBe(0);
    expect(endThreshold(undefined)).toBe(0);
    expect(endThreshold(-5)).toBe(0);
  });

  it('floors at halfway for clips shorter than the tail', () => {
    // Regression: this returned 0 for anything under the 30s tail, so a
    // short clip was "past the end" at position 0 and got marked watched
    // the instant it loaded. A playlist of loops showed everything watched.
    expect(endThreshold(20)).toBe(10);
    expect(endThreshold(8)).toBe(4);
    expect(endThreshold(50)).toBe(25);
  });

  it('still uses the tail rule once the video is long enough', () => {
    // 60s is the crossover: 60-30 === 60*0.5.
    expect(endThreshold(60)).toBe(30);
    expect(endThreshold(120)).toBe(90);
  });
});

describe('shouldRecordPosition', () => {
  it('records a normal mid-video position', () => {
    expect(shouldRecordPosition(600, 3600)).toBe(true);
  });

  it('ignores a glance in the first 10s', () => {
    expect(shouldRecordPosition(3, 3600)).toBe(false);
    expect(shouldRecordPosition(9.9, 3600)).toBe(false);
  });

  it('records exactly at the 10s boundary', () => {
    expect(shouldRecordPosition(MIN_RECORD_SECONDS, 3600)).toBe(true);
  });

  it('does not record inside the trailing zone (the credits problem)', () => {
    // 3600s video → finished from 3420s on.
    expect(shouldRecordPosition(3419, 3600)).toBe(true);
    expect(shouldRecordPosition(3420, 3600)).toBe(false);
    expect(shouldRecordPosition(3599, 3600)).toBe(false);
  });

  it('never records for a video shorter than the minimum', () => {
    // An 8s loop can never produce a valid position.
    expect(shouldRecordPosition(7, 8)).toBe(false);
    expect(shouldRecordPosition(9, MIN_RECORD_SECONDS)).toBe(false);
  });

  it('rejects unusable numbers', () => {
    expect(shouldRecordPosition(NaN, 3600)).toBe(false);
    expect(shouldRecordPosition(600, NaN)).toBe(false);
    expect(shouldRecordPosition(600, 0)).toBe(false);
    expect(shouldRecordPosition(undefined, undefined)).toBe(false);
  });
});

describe('shouldOfferResume', () => {
  it('offers for a valid stored entry', () => {
    expect(shouldOfferResume({ position: 600, duration: 3600 })).toBe(true);
  });

  it('declines for a missing or malformed entry', () => {
    expect(shouldOfferResume(null)).toBe(false);
    expect(shouldOfferResume(undefined)).toBe(false);
    expect(shouldOfferResume({})).toBe(false);
    expect(shouldOfferResume({ position: NaN, duration: 3600 })).toBe(false);
  });

  it('prefers the live duration over the stored one', () => {
    // File replaced: stored position 600s was fine for a 3600s video, but
    // the file at this path is now 120s long, so 600s is past the end.
    expect(shouldOfferResume({ position: 600, duration: 3600 }, 120)).toBe(false);
  });

  it('falls back to the stored duration when no live one is known', () => {
    expect(shouldOfferResume({ position: 600, duration: 3600 }, undefined)).toBe(true);
    expect(shouldOfferResume({ position: 600, duration: 3600 }, 0)).toBe(true);
  });

  it('declines when neither duration is usable', () => {
    expect(shouldOfferResume({ position: 600 })).toBe(false);
  });
});

describe('resumeProgressFraction', () => {
  it('computes a fraction for the card bar', () => {
    expect(resumeProgressFraction({ position: 900, duration: 3600 })).toBe(0.25);
  });

  it('clamps above 1 rather than overflowing the bar', () => {
    expect(resumeProgressFraction({ position: 5000, duration: 3600 })).toBe(1);
  });

  it('returns 0 when there is nothing to draw', () => {
    expect(resumeProgressFraction(null)).toBe(0);
    expect(resumeProgressFraction({ position: 0, duration: 3600 })).toBe(0);
    expect(resumeProgressFraction({ position: 600 })).toBe(0);
  });

  it('prefers the live duration', () => {
    expect(resumeProgressFraction({ position: 60, duration: 3600 }, 120)).toBe(0.5);
  });
});

describe('formatResumeTime', () => {
  it('formats under an hour without an hours field', () => {
    expect(formatResumeTime(754)).toBe('12:34');
    expect(formatResumeTime(59)).toBe('0:59');
    expect(formatResumeTime(60)).toBe('1:00');
  });

  it('adds hours once past 3600s', () => {
    expect(formatResumeTime(3723)).toBe('1:02:03');
    expect(formatResumeTime(3600)).toBe('1:00:00');
  });

  it('floors fractional seconds', () => {
    expect(formatResumeTime(754.9)).toBe('12:34');
  });

  it('handles junk input', () => {
    expect(formatResumeTime(NaN)).toBe('0:00');
    expect(formatResumeTime(-5)).toBe('0:00');
    expect(formatResumeTime(undefined)).toBe('0:00');
  });
});

describe('makeResumeEntry', () => {
  // Rewritten for E2-07: this pinned round-to-nearest (600.06 -> 600.1,
  // 3600.04 -> 3600), which is what stored a pause just under the end
  // threshold ON it and so never offered it. The position now rounds down
  // and the duration up: never further through the video than recorded.
  it('keeps a tenth of a second, the position rounded down and the duration up, and stamps the time', () => {
    expect(makeResumeEntry(600.06, 3600.04, 1754400000000)).toEqual({
      position: 600,
      duration: 3600.1,
      updatedAt: 1754400000000,
    });
    expect(makeResumeEntry(52.3, 120, 1)).toMatchObject({ position: 52.3, duration: 120 });
  });

  it('E2-07: a pause just under the end threshold is stored under it, and offered', () => {
    // Long Two: 100 s, threshold 70. Paused at 69.96 (verify-3's case).
    expect(endThreshold(100)).toBe(70);
    expect(shouldRecordPosition(69.96, 100)).toBe(true);
    const entry = makeResumeEntry(69.96, 100, 1);
    expect(entry.position).toBe(69.9);
    expect(shouldOfferResume(entry)).toBe(true);
    expect(shouldOfferResume(entry, 100)).toBe(true);
  });

  it('E2-07: whatever is recorded is offered back, at both ends of the window', () => {
    // Every duration from 20.5 s to 2 h in uneven steps, every position in a
    // tenth-wide band under the end threshold and just over the 10 s minimum.
    let checked = 0;
    for (let d = 20.5; d < 7200; d = d * 1.37 + 0.013) {
      const end = endThreshold(d);
      for (const p of [end - 0.001, end - 0.04, end - 0.05, end - 0.06, end - 0.099, 10, 10.01, 10.049, 10.05, 10.099]) {
        if (!shouldRecordPosition(p, d)) continue;
        const entry = makeResumeEntry(p, d, 1);
        expect(shouldOfferResume(entry), `d=${d} p=${p} stored ${entry.position}/${entry.duration}`).toBe(true);
        expect(shouldOfferResume(entry, d), `d=${d} p=${p} with the live duration`).toBe(true);
        expect(entry.position).toBeLessThanOrEqual(p);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('never stores a negative position', () => {
    expect(makeResumeEntry(-3, 3600, 1).position).toBe(0);
  });

  it('takes the clock as an argument so callers stay deterministic', () => {
    expect(makeResumeEntry(10, 100, 42).updatedAt).toBe(42);
  });
});

describe('threshold constants stay in the documented relationship', () => {
  it('the tail floor is larger than the minimum record time', () => {
    // If this ever inverts, a video just over MIN_RECORD_SECONDS could be
    // simultaneously "too early to record" and "already finished".
    expect(END_TAIL_SECONDS).toBeGreaterThan(MIN_RECORD_SECONDS);
  });
});

describe('watched and in-progress are mutually exclusive', () => {
  it('a recorded position carries no watched mark', () => {
    // Regression (Dave, 2026-08-05): the mark used to be sticky, so
    // rewatching a finished video left an entry with BOTH. Every consumer
    // tests isFinished first, so the card showed a tick instead of the
    // progress bar and Continue skipped a video mid-rewatch.
    const entry = makeResumeEntry(600, 3600, 1);
    expect(entry.finished).toBeUndefined();
    expect(isFinished(entry)).toBe(false);
  });

  it('a finished entry carries no position', () => {
    const entry = makeFinishedEntry(3600, 1);
    expect(entry.position).toBeUndefined();
    expect(isFinished(entry)).toBe(true);
    // ...so it offers no resume and draws no bar, with no special-casing.
    expect(shouldOfferResume(entry)).toBe(false);
    expect(resumeProgressFraction(entry)).toBe(0);
  });

  it('a part-rewatched video reads as in-progress, not watched', () => {
    const entry = makeResumeEntry(600, 3600, 2);
    expect(isFinished(entry)).toBe(false);
    expect(shouldOfferResume(entry)).toBe(true);
    expect(resumeProgressFraction(entry)).toBeCloseTo(1 / 6, 5);
  });
});
