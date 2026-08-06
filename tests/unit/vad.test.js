/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Voice-activity detection — pure threshold/merge/drop logic tests.
//
// `extractVAD` itself spins up an OfflineAudioContext (via the
// multi-band extractor it depends on), so it's hard to unit-test
// without a real audio fixture. The pure-DSP function
// `computeVADSegments` factors out everything below the audio decode —
// these tests pin the threshold pass, the merge-close-runs pass, and
// the drop-too-short pass against synthetic mid-band envelopes.

import { describe, it, expect } from 'vitest';
import { computeVADSegments, DEFAULT_VAD_OPTIONS } from '../../renderer/js/vad.js';

describe('computeVADSegments — basics', () => {
  it('returns no segments for empty peaks', () => {
    const result = computeVADSegments(new Float32Array(0), 100, 0, {});
    expect(result.segments).toEqual([]);
    expect(result.method).toBe('energy-mid-band');
  });

  it('returns no segments for zero peaksPerSecond', () => {
    const peaks = new Float32Array([0.5, 0.5, 0.5]);
    const result = computeVADSegments(peaks, 0, 0.03, {});
    expect(result.segments).toEqual([]);
  });

  it('returns no segments when all peaks below threshold', () => {
    // 1 second of low-amplitude peaks (100 peaks @ 100 Hz peaksPerSecond)
    const peaks = new Float32Array(100).fill(0.04); // below 0.08 default
    const result = computeVADSegments(peaks, 100, 1.0, {});
    expect(result.segments).toEqual([]);
  });
});

describe('computeVADSegments — segment detection', () => {
  it('flags a single voice-on run when sustained above threshold', () => {
    // 1 second total: silent 0-0.3s, voice 0.3-0.7s, silent 0.7-1.0s
    const peaks = new Float32Array(100);
    for (let i = 30; i < 70; i++) peaks[i] = 0.5;
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 100, mergeGapMs: 50 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].startMs).toBeCloseTo(300, 0);
    expect(result.segments[0].endMs).toBeCloseTo(700, 0);
  });

  it('returns multiple segments separated by sufficient silence', () => {
    const peaks = new Float32Array(100);
    for (let i = 10; i < 30; i++) peaks[i] = 0.5; // 100-300ms
    for (let i = 60; i < 80; i++) peaks[i] = 0.5; // 600-800ms
    // mergeGap 100ms → 30→60 is 300ms gap, won't merge
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 100, mergeGapMs: 100 });
    expect(result.segments).toHaveLength(2);
  });
});

describe('computeVADSegments — merge close runs', () => {
  it('merges two runs separated by less than mergeGapMs', () => {
    const peaks = new Float32Array(100);
    for (let i = 10; i < 30; i++) peaks[i] = 0.5;
    for (let i = 33; i < 60; i++) peaks[i] = 0.5;
    // Gap of 3 peaks @ 100Hz = 30ms; mergeGap 100ms → should merge
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 50, mergeGapMs: 100 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].startMs).toBeCloseTo(100, 0);
    expect(result.segments[0].endMs).toBeCloseTo(600, 0);
  });

  it('does not merge runs separated by more than mergeGapMs', () => {
    const peaks = new Float32Array(100);
    for (let i = 10; i < 30; i++) peaks[i] = 0.5;
    for (let i = 60; i < 80; i++) peaks[i] = 0.5;
    // Gap of 30 peaks @ 100Hz = 300ms; mergeGap 100ms → don't merge
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 50, mergeGapMs: 100 });
    expect(result.segments).toHaveLength(2);
  });
});

describe('computeVADSegments — drop short runs', () => {
  it('drops runs shorter than minSegmentMs', () => {
    const peaks = new Float32Array(100);
    for (let i = 10; i < 13; i++) peaks[i] = 0.5;  // 30ms blip
    for (let i = 50; i < 80; i++) peaks[i] = 0.5;  // 300ms voice
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 250, mergeGapMs: 50 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].startMs).toBeCloseTo(500, 0);
  });

  it('keeps runs exactly at minSegmentMs', () => {
    const peaks = new Float32Array(100);
    // 25 peaks at 100Hz = 250ms exactly
    for (let i = 0; i < 25; i++) peaks[i] = 0.5;
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 250, mergeGapMs: 0 });
    expect(result.segments).toHaveLength(1);
  });
});

describe('computeVADSegments — boundary cases', () => {
  it('handles a run that extends to the very end', () => {
    const peaks = new Float32Array(100);
    for (let i = 50; i < 100; i++) peaks[i] = 0.5; // run reaches end
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 100, mergeGapMs: 50 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].endMs).toBeCloseTo(1000, 0);
  });

  it('handles a run starting at index 0', () => {
    const peaks = new Float32Array(100);
    for (let i = 0; i < 30; i++) peaks[i] = 0.5;
    const result = computeVADSegments(peaks, 100, 1.0, { threshold: 0.1, minSegmentMs: 100, mergeGapMs: 50 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].startMs).toBe(0);
  });

  it('uses default options when none provided', () => {
    const peaks = new Float32Array(100);
    for (let i = 0; i < 30; i++) peaks[i] = 0.5;
    const result = computeVADSegments(peaks, 100, 1.0); // no opts
    // Default threshold 0.08, minSegmentMs 250 → 30 peaks @100Hz = 300ms qualifies
    expect(result.segments).toHaveLength(1);
    expect(result.threshold).toBe(DEFAULT_VAD_OPTIONS.threshold);
  });

  it('reports method as energy-mid-band', () => {
    const result = computeVADSegments(new Float32Array(0), 100, 0, {});
    expect(result.method).toBe('energy-mid-band');
  });
});
