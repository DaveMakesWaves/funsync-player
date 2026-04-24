import { describe, it, expect } from 'vitest';
import { computeBins, renderBins, speedToColor } from '../../renderer/js/heatmap-strip.js';

describe('speedToColor', () => {
  it('returns a blue tone for zero speed', () => {
    const c = speedToColor(0);
    expect(c).toBe('rgb(0,0,255)');
  });

  it('returns red for max speed (saturated)', () => {
    const c = speedToColor(0.5);
    expect(c).toBe('rgb(255,0,0)');
  });

  it('clamps above-max speeds', () => {
    const c = speedToColor(5);
    expect(c).toBe('rgb(255,0,0)');
  });

  it('clamps negative speeds to zero', () => {
    const c = speedToColor(-1);
    expect(c).toBe('rgb(0,0,255)');
  });

  it('transitions through green mid-range', () => {
    const c = speedToColor(0.25);
    expect(c).toBe('rgb(0,255,0)');
  });
});

describe('computeBins', () => {
  it('returns empty array when actions are missing', () => {
    expect(computeBins(null).length).toBe(0);
    expect(computeBins([]).length).toBe(0);
    expect(computeBins([{ at: 0, pos: 0 }]).length).toBe(0);
  });

  it('returns empty array when span is zero', () => {
    const actions = [{ at: 0, pos: 0 }, { at: 0, pos: 100 }];
    expect(computeBins(actions).length).toBe(0);
  });

  it('produces binCount entries', () => {
    const actions = [];
    for (let i = 0; i < 200; i++) actions.push({ at: i * 100, pos: i % 2 === 0 ? 0 : 100 });
    const bins = computeBins(actions, 50);
    expect(bins.length).toBe(50);
  });

  it('averages speeds within each bin', () => {
    // Simple case: constant speed throughout
    const actions = [];
    for (let i = 0; i < 10; i++) actions.push({ at: i * 100, pos: i % 2 === 0 ? 0 : 100 });
    const bins = computeBins(actions, 5);
    // Every bin should see roughly the same speed (1 pos/ms).
    for (const v of bins) expect(v).toBeCloseTo(1, 3);
  });

  it('produces higher speed in the faster half', () => {
    const actions = [];
    // First half slow (speed 0.1), second half fast (speed 1.0)
    for (let i = 0; i < 10; i++) actions.push({ at: i * 1000, pos: i % 2 === 0 ? 0 : 100 });
    for (let i = 10; i < 20; i++) actions.push({ at: i * 100, pos: i % 2 === 0 ? 0 : 100 });
    const bins = computeBins(actions, 10);
    const firstAvg = bins.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const lastAvg = bins.slice(5).reduce((a, b) => a + b, 0) / 5;
    expect(lastAvg).toBeGreaterThan(firstAvg);
  });

  it('skips zero-delta-time pairs without error', () => {
    const actions = [
      { at: 0, pos: 0 },
      { at: 0, pos: 50 }, // dt=0, skipped
      { at: 1000, pos: 100 },
    ];
    expect(() => computeBins(actions, 10)).not.toThrow();
  });
});

describe('renderBins', () => {
  function makeCanvas(w = 200, h = 24) {
    const calls = [];
    const ctx = {
      setTransform: (...a) => calls.push(['setTransform', a]),
      clearRect: (...a) => calls.push(['clearRect', a]),
      fillRect: (...a) => calls.push(['fillRect', a]),
      set fillStyle(v) { calls.push(['fillStyle', v]); },
    };
    return {
      canvas: {
        width: w, height: h,
        clientWidth: w, clientHeight: h,
        getContext: () => ctx,
      },
      calls,
    };
  }

  it('no-ops on empty bins', () => {
    const { canvas, calls } = makeCanvas();
    renderBins(canvas, new Float32Array(0));
    expect(calls.length).toBe(0);
  });

  it('no-ops on null canvas', () => {
    expect(() => renderBins(null, new Float32Array([1, 2, 3]))).not.toThrow();
  });

  it('skips zero-speed bins (leaves gaps)', () => {
    const { canvas, calls } = makeCanvas();
    const bins = new Float32Array([0, 0.25, 0, 1.0]);
    renderBins(canvas, bins);
    const fillRects = calls.filter(c => c[0] === 'fillRect');
    expect(fillRects.length).toBe(2); // only the two non-zero bins draw
  });

  it('covers the full canvas width across non-zero bins', () => {
    const { canvas, calls } = makeCanvas(400, 24);
    const bins = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    renderBins(canvas, bins);
    const fillRects = calls.filter(c => c[0] === 'fillRect').map(c => c[1]);
    expect(fillRects[0][0]).toBe(0);
    const last = fillRects[fillRects.length - 1];
    expect(last[0] + last[2]).toBeGreaterThanOrEqual(400);
  });

  it('centers bars vertically around the strip', () => {
    const { canvas, calls } = makeCanvas(400, 24);
    const bins = new Float32Array([0.5]); // normalized = 1.0, full height
    renderBins(canvas, bins);
    const fillRects = calls.filter(c => c[0] === 'fillRect').map(c => c[1]);
    const [, y, , h] = fillRects[0];
    expect(y + h / 2).toBeCloseTo(12, 5); // middle of 24px tall strip
  });

  it('scales bar height by speed (saturates at 0.5 pos/ms)', () => {
    const { canvas, calls } = makeCanvas(400, 24);
    const bins = new Float32Array([0.25]); // half of MAX_SPEED
    renderBins(canvas, bins);
    const [, , , h] = calls.filter(c => c[0] === 'fillRect')[0][1];
    expect(h).toBeCloseTo(12, 1); // half of 24px

    const { canvas: c2, calls: calls2 } = makeCanvas(400, 24);
    renderBins(c2, new Float32Array([1.0])); // way over max, should saturate
    const [, , , h2] = calls2.filter(c => c[0] === 'fillRect')[0][1];
    expect(h2).toBe(24);
  });

  it('enforces a minimum 1px bar for non-zero activity', () => {
    const { canvas, calls } = makeCanvas(400, 24);
    const bins = new Float32Array([0.00001]); // essentially zero but non-zero
    renderBins(canvas, bins);
    const [, , , h] = calls.filter(c => c[0] === 'fillRect')[0][1];
    expect(h).toBeGreaterThanOrEqual(1);
  });

  it('uses a single theme color for all bars', () => {
    const { canvas, calls } = makeCanvas();
    const bins = new Float32Array([0.1, 0.3, 0.5]);
    renderBins(canvas, bins);
    const fillStyles = calls.filter(c => c[0] === 'fillStyle').map(c => c[1]);
    // One fillStyle set before the loop, reused for every bar
    expect(fillStyles.length).toBe(1);
  });
});
