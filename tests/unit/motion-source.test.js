/**
 * @vitest-environment node
 * Pure maths — no DOM. See notes/CLAUDE.md "Test environments".
 */
// motion-source — generated motion for unscripted axes (dio_likes_jojo,
// EroScripts #306). What matters about the noise isn't its exact values but
// that it is CONTINUOUS: the device is asked to travel to each value it emits,
// so an uncorrelated sequence would be a slam-fest. These pin that property
// rather than the numbers, which are free to change if the noise is retuned.

import { describe, it, expect } from 'vitest';
import {
  createNoise1D,
  fbm,
  noiseToPercent,
  patternValue,
  sampleMotion,
  PATTERN_TYPES,
  DEFAULT_PATTERN,
  shapeGeneratedValue,
  axisPhase,
  normaliseMotionConfig,
} from '../../renderer/js/motion-source.js';

describe('createNoise1D', () => {
  it('is deterministic for a given seed (a bug report must reproduce)', () => {
    const a = createNoise1D(42);
    const b = createNoise1D(42);
    for (let i = 0; i < 20; i++) {
      expect(a(i * 0.37)).toBe(b(i * 0.37));
    }
  });

  it('differs between seeds', () => {
    const a = createNoise1D(1);
    const b = createNoise1D(2);
    const differs = Array.from({ length: 20 }, (_, i) => a(i * 0.37) !== b(i * 0.37));
    expect(differs.some(Boolean)).toBe(true);
  });

  it('stays inside [-1, 1]', () => {
    const n = createNoise1D(9);
    for (let t = -50; t < 50; t += 0.13) {
      expect(n(t)).toBeGreaterThanOrEqual(-1);
      expect(n(t)).toBeLessThanOrEqual(1);
    }
  });

  it('is continuous — small step in, small step out', () => {
    // The whole reason this isn't Math.random(). A 0.01 step must not produce
    // a full-throw jump; anything above a few percent of travel would be felt
    // as a slam on a stroker.
    const n = createNoise1D(5);
    let maxDelta = 0;
    for (let t = 0; t < 40; t += 0.01) {
      maxDelta = Math.max(maxDelta, Math.abs(n(t + 0.01) - n(t)));
    }
    expect(maxDelta).toBeLessThan(0.1);
  });

  it('actually moves over time (a constant would be "smooth" too)', () => {
    const n = createNoise1D(5);
    const samples = Array.from({ length: 200 }, (_, i) => n(i * 0.25));
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.5);
  });
});

describe('fbm', () => {
  it('single octave passes the noise through unchanged', () => {
    const n = createNoise1D(3);
    expect(fbm(n, 1.5, { octaves: 1 })).toBeCloseTo(n(1.5), 12);
  });

  it('multiple octaves stay in range and add detail', () => {
    const n = createNoise1D(3);
    let differs = false;
    for (let t = 0; t < 20; t += 0.3) {
      const v = fbm(n, t, { octaves: 3, persistence: 0.5, lacunarity: 2 });
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      if (Math.abs(v - n(t)) > 1e-9) differs = true;
    }
    expect(differs).toBe(true);
  });
});

describe('shapeGeneratedValue', () => {
  it('passes through at full depth, full travel', () => {
    expect(shapeGeneratedValue(0)).toBe(0);
    expect(shapeGeneratedValue(50)).toBe(50);
    expect(shapeGeneratedValue(100)).toBe(100);
  });

  it('depth scales around centre so 0% parks the axis at rest', () => {
    expect(shapeGeneratedValue(100, { depth: 50 })).toBe(75);
    expect(shapeGeneratedValue(0, { depth: 50 })).toBe(25);
    expect(shapeGeneratedValue(0, { depth: 0 })).toBe(50);
    expect(shapeGeneratedValue(100, { depth: 0 })).toBe(50);
  });

  it('half restricts travel to one side of centre', () => {
    expect(shapeGeneratedValue(0, { half: 'top' })).toBe(50);
    expect(shapeGeneratedValue(100, { half: 'top' })).toBe(100);
    expect(shapeGeneratedValue(0, { half: 'bottom' })).toBe(0);
    expect(shapeGeneratedValue(100, { half: 'bottom' })).toBe(50);
  });

  it('clamps out-of-band input', () => {
    expect(shapeGeneratedValue(-40)).toBe(0);
    expect(shapeGeneratedValue(140)).toBe(100);
  });
});

describe('axisPhase', () => {
  it('separates axes so they do not wander in lockstep', () => {
    const phases = ['R0', 'R1', 'R2'].map(axisPhase);
    expect(new Set(phases).size).toBe(3);
  });

  it('is stable for the same axis', () => {
    expect(axisPhase('R0')).toBe(axisPhase('R0'));
  });
});

describe('normaliseMotionConfig', () => {
  it('treats absent, null and "script" as scripted (the default everywhere)', () => {
    expect(normaliseMotionConfig(null)).toBeNull();
    expect(normaliseMotionConfig(undefined)).toBeNull();
    expect(normaliseMotionConfig({})).toBeNull();
    expect(normaliseMotionConfig({ mode: 'script' })).toBeNull();
  });

  it('rejects an unknown mode rather than guessing', () => {
    expect(normaliseMotionConfig({ mode: 'wobble' })).toBeNull();
  });

  it('fills defaults', () => {
    expect(normaliseMotionConfig({ mode: 'link' }))
      .toEqual({ mode: 'link', depth: 100, half: 'off', speed: 1, pattern: DEFAULT_PATTERN });
  });

  it('accepts pattern mode and keeps the chosen shape', () => {
    expect(normaliseMotionConfig({ mode: 'pattern', pattern: 'saw' }).pattern).toBe('saw');
  });

  it('falls back to the default shape for an unknown one', () => {
    expect(normaliseMotionConfig({ mode: 'pattern', pattern: 'wobble' }).pattern)
      .toBe(DEFAULT_PATTERN);
  });

  it('clamps out-of-range values from a hand-edited config file', () => {
    const cfg = normaliseMotionConfig({ mode: 'random', depth: 500, speed: 99, half: 'sideways' });
    expect(cfg.depth).toBe(100);
    expect(cfg.speed).toBe(4);
    expect(cfg.half).toBe('off');
    expect(normaliseMotionConfig({ mode: 'random', depth: -20, speed: 0 }).depth).toBe(0);
    expect(normaliseMotionConfig({ mode: 'random', speed: 0 }).speed).toBe(0.05);
  });
});

// Pattern mode (Dave, 2026-08-20). Random is a wander you can't predict; a
// pattern is a shape you choose. Same six shapes and same formulas as MFP's
// Pattern provider, so someone arriving from MFP gets what the name promises.
describe('patternValue', () => {
  it('offers the six MFP shapes and defaults to one of them', () => {
    expect(PATTERN_TYPES).toEqual(
      ['sine', 'triangle', 'doubleBounce', 'sharpBounce', 'saw', 'square']);
    expect(PATTERN_TYPES).toContain(DEFAULT_PATTERN);
  });

  it('stays inside the axis travel for every shape', () => {
    for (const pattern of PATTERN_TYPES) {
      for (let phase = -8; phase < 16; phase += 0.05) {
        const v = patternValue(pattern, phase);
        expect(v, `${pattern} @ ${phase}`).toBeGreaterThanOrEqual(0);
        expect(v, `${pattern} @ ${phase}`).toBeLessThanOrEqual(100);
        expect(Number.isFinite(v), `${pattern} @ ${phase}`).toBe(true);
      }
    }
  });

  it('repeats every 4 phase units', () => {
    for (const pattern of PATTERN_TYPES) {
      for (const phase of [0.3, 1.1, 2.7, 3.9]) {
        expect(patternValue(pattern, phase)).toBeCloseTo(patternValue(pattern, phase + 4), 9);
      }
    }
  });

  it('handles negative phase without a discontinuity', () => {
    // `%` keeps the sign in JS, so a naive modulo would mirror the waveform
    // for any caller that ended up with a negative clock.
    for (const pattern of PATTERN_TYPES) {
      expect(patternValue(pattern, -3.7)).toBeCloseTo(patternValue(pattern, 0.3), 9);
    }
  });

  it('actually traverses the range rather than hovering', () => {
    for (const pattern of PATTERN_TYPES) {
      const samples = [];
      for (let phase = 0; phase < 4; phase += 0.01) samples.push(patternValue(pattern, phase));
      expect(Math.max(...samples) - Math.min(...samples), pattern).toBeGreaterThan(80);
    }
  });

  it('sine is smooth and square is not — the point of offering both', () => {
    const step = (pattern) => {
      let max = 0;
      for (let phase = 0; phase < 8; phase += 0.005) {
        max = Math.max(max, Math.abs(patternValue(pattern, phase + 0.005) - patternValue(pattern, phase)));
      }
      return max;
    };
    expect(step('sine')).toBeLessThan(1);
    expect(step('square')).toBeGreaterThan(50);
  });

  it('falls back to sine for an unknown shape', () => {
    expect(patternValue('wobble', 1.3)).toBe(patternValue('sine', 1.3));
  });
});

// The preview curve (Dave, 2026-08-20). Picking "sharp bounce" from a list of
// names is picking blind, so the panel draws the shape. It has to come from
// the same functions the engine runs, or the picture lies.
describe('sampleMotion', () => {
  it('draws nothing for a scripted axis', () => {
    expect(sampleMotion(null)).toEqual([]);
    expect(sampleMotion({ mode: 'script' })).toEqual([]);
  });

  it('returns the requested number of samples, all in axis range', () => {
    const vals = sampleMotion({ mode: 'pattern', pattern: 'triangle' }, { samples: 40 });
    expect(vals).toHaveLength(40);
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('matches what the engine would produce for the same shape', () => {
    // Same maths, not a lookalike: the preview must not drift from playback.
    const vals = sampleMotion({ mode: 'pattern', pattern: 'saw' }, { samples: 9, cycles: 1 });
    const expected = Array.from({ length: 9 }, (_, i) => patternValue('saw', (i / 8) * 4));
    expect(vals).toEqual(expected);
  });

  it('shows the effect of depth and half, since that is what it is for', () => {
    const full = sampleMotion({ mode: 'pattern', pattern: 'sine' }, { samples: 64 });
    const shallow = sampleMotion({ mode: 'pattern', pattern: 'sine', depth: 40 }, { samples: 64 });
    const spread = (v) => Math.max(...v) - Math.min(...v);
    expect(spread(shallow)).toBeLessThan(spread(full));

    const top = sampleMotion({ mode: 'pattern', pattern: 'sine', half: 'top' }, { samples: 64 });
    expect(Math.min(...top)).toBeGreaterThanOrEqual(50);
  });

  it('is deterministic for random, so the preview does not shimmer', () => {
    const a = sampleMotion({ mode: 'random' }, { samples: 50 });
    const b = sampleMotion({ mode: 'random' }, { samples: 50 });
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(5);
  });

  it('shows speed as a busier curve, not a stretched one', () => {
    // The canvas is a fixed window of time, so turning Speed up has to fit
    // more cycles into it — that is what it does to the axis.
    const crossings = (vals) => vals.slice(1)
      .filter((v, i) => (vals[i] - 50) * (v - 50) < 0).length;
    const slow = sampleMotion({ mode: 'pattern', pattern: 'sine', speed: 0.5 }, { samples: 400 });
    const fast = sampleMotion({ mode: 'pattern', pattern: 'sine', speed: 3 }, { samples: 400 });
    expect(crossings(fast)).toBeGreaterThan(crossings(slow));
    // Amplitude is Depth's job, not Speed's — the curve must not shrink.
    const spread = (v) => Math.max(...v) - Math.min(...v);
    expect(spread(fast)).toBeCloseTo(spread(slow), 0);
  });

  it('speed changes the random preview too', () => {
    const a = sampleMotion({ mode: 'random', speed: 0.5 }, { samples: 200 });
    const b = sampleMotion({ mode: 'random', speed: 3 }, { samples: 200 });
    expect(a).not.toEqual(b);
  });

  it('leaves link mode alone — it has no speed of its own', () => {
    // Follow stroke takes its timing from the script's keyframes, so a Speed
    // slider reading would be a lie in the picture.
    expect(sampleMotion({ mode: 'link', speed: 0.5 }, { samples: 60 }))
      .toEqual(sampleMotion({ mode: 'link', speed: 3 }, { samples: 60 }));
  });

  it('draws link mode as a stroke rather than an empty box', () => {
    // The real script isn't knowable here, so it stands in with a full
    // stroke — enough to show what depth and half do to one.
    const vals = sampleMotion({ mode: 'link' }, { samples: 50 });
    expect(vals).toHaveLength(50);
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(50);
  });
});
