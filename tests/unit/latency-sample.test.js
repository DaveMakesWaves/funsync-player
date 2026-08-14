/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Auto-applying a measured Autoblow latency (myopiic, thread #270).
//
// The measurement already existed and was displayed then discarded. The risk
// in wiring it up is writing a BAD number into a user's sync offset, which
// breaks their sync silently and gives them no reason to suspect the button
// they pressed. So the rules worth pinning are the refusals.
import { describe, it, expect } from 'vitest';
import {
  medianLatency,
  isApplicableLatency,
  clampToOffsetRange,
} from '../../renderer/js/latency-sample.js';

describe('medianLatency', () => {
  it('takes the median of the samples', () => {
    expect(medianLatency([100, 110, 120])).toBe(110);
  });

  // The whole reason for sampling more than once.
  it('is unmoved by a single outlier, where a mean would not be', () => {
    const samples = [100, 105, 110, 115, 900];
    expect(medianLatency(samples)).toBe(110);
    const mean = Math.round(samples.reduce((a, b) => a + b) / samples.length);
    expect(mean).toBeGreaterThan(250);   // what we deliberately avoided
  });

  it('averages the middle pair for an even count', () => {
    expect(medianLatency([100, 120])).toBe(110);
  });

  it('ignores failed probes, which report 0', () => {
    expect(medianLatency([0, 0, 100, 110, 120])).toBe(110);
  });

  it('ignores implausible readings rather than trusting them', () => {
    expect(medianLatency([100, 110, 120, 999999])).toBe(110);
    expect(medianLatency([-50, 100, 110, 120])).toBe(110);
  });

  it('returns 0 when nothing usable came back', () => {
    expect(medianLatency([])).toBe(0);
    expect(medianLatency([0, 0, 0])).toBe(0);
    expect(medianLatency(null)).toBe(0);
    expect(medianLatency([NaN, Infinity])).toBe(0);
  });
});

describe('isApplicableLatency', () => {
  // estimateLatency() returns 0 BOTH when disconnected and on error, so 0
  // means "no reading" and must never overwrite a hand-tuned offset.
  it('refuses 0, the failure value', () => {
    expect(isApplicableLatency(0)).toBe(false);
  });

  it('refuses junk', () => {
    expect(isApplicableLatency(NaN)).toBe(false);
    expect(isApplicableLatency(Infinity)).toBe(false);
    expect(isApplicableLatency(undefined)).toBe(false);
    expect(isApplicableLatency(-100)).toBe(false);
  });

  it('refuses an implausibly large reading', () => {
    expect(isApplicableLatency(60000)).toBe(false);
  });

  it('accepts a real measurement', () => {
    expect(isApplicableLatency(120)).toBe(true);
    expect(isApplicableLatency(1)).toBe(true);
  });
});

describe('clampToOffsetRange', () => {
  // Storing a value the slider cannot represent would leave the user unable
  // to see or undo it.
  it('clamps to the slider bounds', () => {
    expect(clampToOffsetRange(5000)).toBe(1000);
    expect(clampToOffsetRange(-5000)).toBe(-1000);
  });

  it('passes an in-range value through, rounded', () => {
    expect(clampToOffsetRange(123.4)).toBe(123);
  });

  it('degrades to 0 on junk rather than throwing', () => {
    expect(clampToOffsetRange(NaN)).toBe(0);
    expect(clampToOffsetRange(undefined)).toBe(0);
  });
});
