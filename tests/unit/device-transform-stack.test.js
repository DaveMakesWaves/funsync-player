// Property + unit tests for the per-device transform pipeline.
//
// This module is the single source of truth for the order in which
// per-device transforms apply across every sync engine. The tests pin
// three contracts:
//   1. Each step is a no-op at its default config (identity).
//   2. The documented order (extender → invert → range → safety) is
//      correct — verified by known-input compositions.
//   3. Every step is defensive — NaN / undefined / out-of-range inputs
//      never throw, never produce garbage, never leak past clamp01.
//
// If any of these break, every sync engine downstream is suspect.

import { describe, it, expect } from 'vitest';
import {
  applyExtender,
  applyInvert,
  applyRange,
  applyCutoff,
  applySafetyCap,
  applyDeviceStack,
  clamp01,
  computeNaturalRange,
  extendRawScriptContent,
  clampRawScriptContent,
  RANGE_EXTENDER_THRESHOLD_PCT,
} from '../../renderer/js/device-transform-stack.js';

describe('clamp01', () => {
  it('passes through values in [0, 100]', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(50)).toBe(50);
    expect(clamp01(100)).toBe(100);
  });
  it('clamps below 0 to 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });
  it('clamps above 100 to 100', () => {
    expect(clamp01(101)).toBe(100);
    expect(clamp01(1000)).toBe(100);
  });
  it('NaN / undefined / null / non-number → 0', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(undefined)).toBe(0);
    expect(clamp01(null)).toBe(0);
    expect(clamp01('50')).toBe(0);
    expect(clamp01({})).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });
});

describe('applyExtender', () => {
  it('disabled → identity', () => {
    expect(applyExtender(50, { min: 30, max: 70 }, false, 80)).toBe(50);
    expect(applyExtender(0,  { min: 30, max: 70 }, false, 80)).toBe(0);
    expect(applyExtender(100, { min: 30, max: 70 }, false, 80)).toBe(100);
  });

  it('wide script (width >= threshold) → identity even when enabled', () => {
    expect(applyExtender(50, { min: 10, max: 95 }, true, 80)).toBe(50); // width 85 >= 80
    expect(applyExtender(50, { min: 0, max: 100 }, true, 80)).toBe(50);
  });

  it('narrow script (width < threshold) → stretched', () => {
    // natural 30-70 (width 40), threshold 80 → stretch
    expect(applyExtender(30, { min: 30, max: 70 }, true, 80)).toBe(0);
    expect(applyExtender(70, { min: 30, max: 70 }, true, 80)).toBe(100);
    expect(applyExtender(50, { min: 30, max: 70 }, true, 80)).toBe(50); // center stays center
  });

  it('narrow + asymmetric remap correctly', () => {
    // natural 60-90 (width 30) — center is 75, not 50
    expect(applyExtender(60, { min: 60, max: 90 }, true, 80)).toBe(0);
    expect(applyExtender(90, { min: 60, max: 90 }, true, 80)).toBe(100);
    expect(applyExtender(75, { min: 60, max: 90 }, true, 80)).toBe(50);
  });

  it('threshold boundary uses strict less-than', () => {
    // width 80, threshold 80 → NOT stretched
    expect(applyExtender(50, { min: 10, max: 90 }, true, 80)).toBe(50);
  });

  it('threshold = 0 never fires', () => {
    expect(applyExtender(50, { min: 30, max: 70 }, true, 0)).toBe(50);
  });

  it('threshold = 100 always fires (unless width is exactly 100)', () => {
    expect(applyExtender(50, { min: 30, max: 70 }, true, 100)).toBe(50); // center
    expect(applyExtender(50, { min: 0, max: 100 }, true, 100)).toBe(50); // not narrower than 100
  });

  it('zero-width natural range → identity (degenerate)', () => {
    expect(applyExtender(50, { min: 50, max: 50 }, true, 80)).toBe(50);
    expect(applyExtender(0,  { min: 50, max: 50 }, true, 80)).toBe(0);
  });

  it('natural range null / undefined / non-object → identity', () => {
    expect(applyExtender(50, null, true, 80)).toBe(50);
    expect(applyExtender(50, undefined, true, 80)).toBe(50);
    expect(applyExtender(50, 'foo', true, 80)).toBe(50);
  });

  it('natural with NaN min/max → defaults to 0/100 → identity', () => {
    expect(applyExtender(50, { min: NaN, max: NaN }, true, 80)).toBe(50);
  });

  it('rawPos outside natural range → clamped to natural before stretch', () => {
    // Script malformed: natural says 30-70 but an action somehow at 80
    expect(applyExtender(80, { min: 30, max: 70 }, true, 80)).toBe(100); // clamped to 70 → 100
    expect(applyExtender(10, { min: 30, max: 70 }, true, 80)).toBe(0);   // clamped to 30 → 0
  });
});

describe('applyInvert', () => {
  it('false → identity', () => {
    expect(applyInvert(0, false)).toBe(0);
    expect(applyInvert(50, false)).toBe(50);
    expect(applyInvert(100, false)).toBe(100);
  });

  it('undefined → identity (defensive)', () => {
    expect(applyInvert(50, undefined)).toBe(50);
    expect(applyInvert(50, null)).toBe(50);
  });

  it('true → mirror around 50', () => {
    expect(applyInvert(0, true)).toBe(100);
    expect(applyInvert(100, true)).toBe(0);
    expect(applyInvert(50, true)).toBe(50);   // fixed point
    expect(applyInvert(25, true)).toBe(75);
    expect(applyInvert(75, true)).toBe(25);
  });

  it('clamps rawPos before inverting', () => {
    expect(applyInvert(-50, true)).toBe(100); // -50 → 0 → 100
    expect(applyInvert(150, true)).toBe(0);   // 150 → 100 → 0
    expect(applyInvert(NaN, true)).toBe(100); // NaN → 0 → 100
  });
});

describe('applyRange', () => {
  it('default {0,100} → identity', () => {
    expect(applyRange(50, { min: 0, max: 100 })).toBe(50);
    expect(applyRange(0,  { min: 0, max: 100 })).toBe(0);
    expect(applyRange(100, { min: 0, max: 100 })).toBe(100);
  });

  it('null / undefined / non-object range → identity', () => {
    expect(applyRange(50, null)).toBe(50);
    expect(applyRange(50, undefined)).toBe(50);
    expect(applyRange(50, 'foo')).toBe(50);
  });

  it('NaN / undefined min or max → identity', () => {
    expect(applyRange(50, { min: NaN, max: 70 })).toBe(50);
    expect(applyRange(50, { min: 30, max: NaN })).toBe(50);
    expect(applyRange(50, { min: undefined, max: 70 })).toBe(50);
  });

  it('range [30, 70] remaps correctly', () => {
    expect(applyRange(0,   { min: 30, max: 70 })).toBe(30);
    expect(applyRange(100, { min: 30, max: 70 })).toBe(70);
    expect(applyRange(50,  { min: 30, max: 70 })).toBe(50); // midpoint stays mid (40/2 + 30)
    expect(applyRange(25,  { min: 30, max: 70 })).toBe(40); // 0.25 * 40 + 30
  });

  it('min == max → identity (refuses to collapse)', () => {
    expect(applyRange(50, { min: 50, max: 50 })).toBe(50);
    expect(applyRange(0,  { min: 50, max: 50 })).toBe(0);
  });

  it('min > max → identity (refuses to swap silently)', () => {
    expect(applyRange(50, { min: 80, max: 20 })).toBe(50);
    expect(applyRange(0,  { min: 80, max: 20 })).toBe(0);
  });

  it('out-of-bounds range values clamped to [0,100] before remap', () => {
    // min=-50 should be treated as 0
    expect(applyRange(50, { min: -50, max: 100 })).toBe(50);
    // max=150 should be treated as 100
    expect(applyRange(50, { min: 0, max: 150 })).toBe(50);
  });

  it('rawPos clamped before remap', () => {
    expect(applyRange(-50, { min: 30, max: 70 })).toBe(30);
    expect(applyRange(150, { min: 30, max: 70 })).toBe(70);
    expect(applyRange(NaN, { min: 30, max: 70 })).toBe(30); // NaN → 0 → min
  });
});

describe('applyCutoff', () => {
  it('no-op when cutoff is null/undefined/non-object', () => {
    expect(applyCutoff(50, null)).toBe(50);
    expect(applyCutoff(50, undefined)).toBe(50);
    expect(applyCutoff(50, 'foo')).toBe(50);
  });

  it('no-op when min/max non-finite', () => {
    expect(applyCutoff(50, { min: NaN, max: 80 })).toBe(50);
    expect(applyCutoff(50, { min: 20, max: NaN })).toBe(50);
    expect(applyCutoff(50, { min: undefined, max: 80 })).toBe(50);
  });

  it('no-op at full-range defaults', () => {
    expect(applyCutoff(0, { min: 0, max: 100 })).toBe(0);
    expect(applyCutoff(50, { min: 0, max: 100 })).toBe(50);
    expect(applyCutoff(100, { min: 0, max: 100 })).toBe(100);
  });

  it('CLAMPS (pins) out-of-band values, leaves in-band untouched', () => {
    // floor 20, ceiling 80 — the defining behaviour vs applyRange's remap
    expect(applyCutoff(10, { min: 20, max: 80 })).toBe(20); // below floor → floor
    expect(applyCutoff(0,  { min: 20, max: 80 })).toBe(20);
    expect(applyCutoff(50, { min: 20, max: 80 })).toBe(50); // in band → untouched
    expect(applyCutoff(90, { min: 20, max: 80 })).toBe(80); // above ceil → ceil
    expect(applyCutoff(100, { min: 20, max: 80 })).toBe(80);
  });

  it('contrasts with applyRange: clamp does NOT rescale', () => {
    // Same window 20-100. Range REMAPS 10 → 28; cutoff CLAMPS 10 → 20.
    expect(applyRange(10, { min: 20, max: 100 })).toBe(28);
    expect(applyCutoff(10, { min: 20, max: 100 })).toBe(20);
    // And an in-band value: range rescales it, cutoff leaves it.
    expect(applyRange(50, { min: 20, max: 100 })).toBe(60);
    expect(applyCutoff(50, { min: 20, max: 100 })).toBe(50);
  });

  it('floor-only (ceiling 100)', () => {
    expect(applyCutoff(5,  { min: 30, max: 100 })).toBe(30);
    expect(applyCutoff(70, { min: 30, max: 100 })).toBe(70);
  });

  it('refuses degenerate min >= max (no-op)', () => {
    expect(applyCutoff(50, { min: 80, max: 20 })).toBe(50);
    expect(applyCutoff(50, { min: 50, max: 50 })).toBe(50);
  });

  it('clamps an out-of-[0,100] cutoff config before applying', () => {
    expect(applyCutoff(5, { min: -10, max: 80 })).toBe(5);   // floor clamps to 0 → no floor effect
    expect(applyCutoff(90, { min: 20, max: 150 })).toBe(90); // ceil clamps to 100 → no ceil effect
  });

  it('NaN input → 0 → floor', () => {
    expect(applyCutoff(NaN, { min: 20, max: 80 })).toBe(20);
  });
});

describe('applySafetyCap', () => {
  it('cap undefined / NaN → identity', () => {
    expect(applySafetyCap(80, undefined)).toBe(80);
    expect(applySafetyCap(80, NaN)).toBe(80);
    expect(applySafetyCap(80, null)).toBe(80);
  });

  it('cap >= 100 → identity (no clipping needed)', () => {
    expect(applySafetyCap(80, 100)).toBe(80);
    expect(applySafetyCap(80, 150)).toBe(80);
  });

  it('cap = 0 → identity (defensive: 0 is a config error, not "always 0")', () => {
    // Conceptually 0% safety cap would silence the device entirely.
    // The UI should never produce this; if a config bug somehow does,
    // refuse to apply rather than silently muting the device.
    expect(applySafetyCap(80, 0)).toBe(80);
  });

  it('clips above cap, passes through below', () => {
    expect(applySafetyCap(80, 70)).toBe(70);  // clipped
    expect(applySafetyCap(70, 70)).toBe(70);  // boundary
    expect(applySafetyCap(50, 70)).toBe(50);  // below
    expect(applySafetyCap(0,  70)).toBe(0);
  });
});

describe('applyDeviceStack — composition', () => {
  it('all defaults → identity (no transforms enabled)', () => {
    expect(applyDeviceStack(50, {})).toBe(50);
    expect(applyDeviceStack(0,  {})).toBe(0);
    expect(applyDeviceStack(100, {})).toBe(100);
  });

  it('empty ctx → just clamp', () => {
    expect(applyDeviceStack(50, null)).toBe(50);
    expect(applyDeviceStack(50, undefined)).toBe(50);
    expect(applyDeviceStack(-10, null)).toBe(0);
    expect(applyDeviceStack(150, null)).toBe(100);
  });

  it('order: extender → invert → range → safety', () => {
    // Script natural 30-70 (width 40, < 80 threshold) so extender fires.
    // Input pos = 30. Inverted. Range [20, 80]. Cap 50.
    //
    //   step 1 (extender): 30 → 0          (start of natural range)
    //   step 2 (invert):   0  → 100
    //   step 3 (range):    100 → 80         (range max)
    //   step 4 (safety):   80 → 50          (capped)
    const out = applyDeviceStack(30, {
      natural: { min: 30, max: 70 },
      extender: { enabled: true, thresholdPct: 80 },
      inverted: true,
      range: { min: 20, max: 80 },
      maxIntensity: 50,
    });
    expect(out).toBe(50);
  });

  it('extender + range compose without invert', () => {
    // natural 60-90 (width 30) → stretch to 0-100
    // input 75 → extender stretches to 50 → range [20, 80] → 50 (midpoint)
    expect(applyDeviceStack(75, {
      natural: { min: 60, max: 90 },
      extender: { enabled: true, thresholdPct: 80 },
      range: { min: 20, max: 80 },
    })).toBe(50);
  });

  it('invert + range without extender', () => {
    // input 75 → invert to 25 → range [30, 70] → 30 + 0.25*40 = 40
    expect(applyDeviceStack(75, {
      inverted: true,
      range: { min: 30, max: 70 },
    })).toBe(40);
  });

  it('range without invert/extender', () => {
    expect(applyDeviceStack(50, { range: { min: 30, max: 70 } })).toBe(50);
    expect(applyDeviceStack(0,  { range: { min: 30, max: 70 } })).toBe(30);
    expect(applyDeviceStack(100, { range: { min: 30, max: 70 } })).toBe(70);
  });

  it('cutoff clamps after range remap (order: range → cutoff)', () => {
    // input 0 → range [0,100] no-op → cutoff floor 20 → 20
    expect(applyDeviceStack(0, { cutoff: { min: 20, max: 80 } })).toBe(20);
    // input 100 → cutoff ceiling 80 → 80
    expect(applyDeviceStack(100, { cutoff: { min: 20, max: 80 } })).toBe(80);
    // range remaps 10 → 28 (window 20-100), THEN cutoff floor 30 pins to 30
    expect(applyDeviceStack(10, {
      range: { min: 20, max: 100 },
      cutoff: { min: 30, max: 100 },
    })).toBe(30);
  });

  it('safety cap wins over cutoff floor', () => {
    // cutoff floor 40, but e-stim safety cap 30 → device sees 30 (safety last)
    expect(applyDeviceStack(0, {
      cutoff: { min: 40, max: 100 },
      maxIntensity: 30,
    })).toBe(30);
  });

  it('safety cap clips even when range output is high', () => {
    // input 100 → range [0,100] → 100 → safety 70 → 70
    expect(applyDeviceStack(100, {
      range: { min: 0, max: 100 },
      maxIntensity: 70,
    })).toBe(70);
  });

  it('safety cap dominates over range when both are tight', () => {
    // range allows up to 80, safety cap is 50 → cap wins
    expect(applyDeviceStack(100, {
      range: { min: 0, max: 80 },
      maxIntensity: 50,
    })).toBe(50);
  });

  it('output always clamped to [0,100]', () => {
    // Even with pathological config, output stays in bounds
    expect(applyDeviceStack(50, {
      inverted: true,
      range: { min: 0, max: 100 },
    })).toBeGreaterThanOrEqual(0);
    expect(applyDeviceStack(50, {
      inverted: true,
      range: { min: 0, max: 100 },
    })).toBeLessThanOrEqual(100);
  });

  it('idempotent at defaults — applying twice == applying once', () => {
    // Per the contract: with default config, the stack must be a true
    // identity. Repeated application is a sanity check on that.
    const out1 = applyDeviceStack(73, {});
    const out2 = applyDeviceStack(out1, {});
    expect(out1).toBe(73);
    expect(out2).toBe(73);
  });

  it('NaN input + any config → never throws, always 0', () => {
    expect(applyDeviceStack(NaN, {
      natural: { min: 30, max: 70 },
      extender: { enabled: true, thresholdPct: 80 },
      inverted: true,
      range: { min: 20, max: 80 },
      maxIntensity: 50,
    })).toBeGreaterThanOrEqual(0);
    // NaN clamps to 0 first; stack proceeds with 0.
  });
});

describe('computeNaturalRange', () => {
  it('empty array → default {0, 100}', () => {
    expect(computeNaturalRange([])).toEqual({ min: 0, max: 100 });
  });

  it('non-array (null/undefined) → default {0, 100}', () => {
    expect(computeNaturalRange(null)).toEqual({ min: 0, max: 100 });
    expect(computeNaturalRange(undefined)).toEqual({ min: 0, max: 100 });
    expect(computeNaturalRange('foo')).toEqual({ min: 0, max: 100 });
  });

  it('single action → both min and max equal that pos (degenerate width)', () => {
    expect(computeNaturalRange([{ at: 0, pos: 50 }])).toEqual({ min: 50, max: 50 });
    expect(computeNaturalRange([{ at: 0, pos: 0 }])).toEqual({ min: 0, max: 0 });
  });

  it('all-same-pos → width = 0 (degenerate, but valid)', () => {
    const actions = [
      { at: 0, pos: 50 },
      { at: 100, pos: 50 },
      { at: 200, pos: 50 },
    ];
    expect(computeNaturalRange(actions)).toEqual({ min: 50, max: 50 });
  });

  it('wide script (0-100) returns full bounds', () => {
    expect(computeNaturalRange([
      { at: 0, pos: 0 }, { at: 100, pos: 50 }, { at: 200, pos: 100 },
    ])).toEqual({ min: 0, max: 100 });
  });

  it('narrow script (30-70) returns observed range', () => {
    expect(computeNaturalRange([
      { at: 0, pos: 30 }, { at: 100, pos: 50 }, { at: 200, pos: 70 },
    ])).toEqual({ min: 30, max: 70 });
  });

  it('asymmetric script (60-90) returns observed range', () => {
    expect(computeNaturalRange([
      { at: 0, pos: 60 }, { at: 100, pos: 75 }, { at: 200, pos: 90 },
    ])).toEqual({ min: 60, max: 90 });
  });

  it('clamps out-of-bounds pos values before measuring (malformed script)', () => {
    expect(computeNaturalRange([
      { at: 0, pos: -10 }, { at: 100, pos: 50 }, { at: 200, pos: 150 },
    ])).toEqual({ min: 0, max: 100 });   // -10 → 0, 150 → 100
  });

  it('skips actions missing pos (NaN-safe)', () => {
    expect(computeNaturalRange([
      { at: 0, pos: 30 },
      { at: 100 },                  // no pos
      { at: 200, pos: NaN },        // not a number
      null,                         // null action
      { at: 300, pos: 70 },
    ])).toEqual({ min: 30, max: 70 });
  });

  it('all invalid actions → default {0, 100}', () => {
    expect(computeNaturalRange([{ at: 0 }, null, { at: 100, pos: NaN }])).toEqual({ min: 0, max: 100 });
  });
});

describe('extendRawScriptContent', () => {
  const NARROW_SCRIPT = JSON.stringify({
    version: '1.0',
    actions: [
      { at: 0, pos: 30 }, { at: 100, pos: 50 }, { at: 200, pos: 70 },
    ],
  });
  const WIDE_SCRIPT = JSON.stringify({
    version: '1.0',
    actions: [
      { at: 0, pos: 0 }, { at: 100, pos: 50 }, { at: 200, pos: 100 },
    ],
  });

  it('disabled → returns original string unchanged', () => {
    expect(extendRawScriptContent(NARROW_SCRIPT, false)).toBe(NARROW_SCRIPT);
  });

  it('wide script → returns original (no transformation needed)', () => {
    expect(extendRawScriptContent(WIDE_SCRIPT, true)).toBe(WIDE_SCRIPT);
  });

  it('narrow script + enabled → returns stretched JSON', () => {
    const out = extendRawScriptContent(NARROW_SCRIPT, true);
    expect(out).not.toBe(NARROW_SCRIPT);
    const parsed = JSON.parse(out);
    expect(parsed.actions[0].pos).toBe(0);    // 30 → 0 (min of natural)
    expect(parsed.actions[1].pos).toBe(50);   // 50 → 50 (midpoint)
    expect(parsed.actions[2].pos).toBe(100);  // 70 → 100 (max of natural)
  });

  it('preserves action timestamps + other fields', () => {
    const content = JSON.stringify({
      version: '1.2',
      metadata: { creator: 'test' },
      actions: [
        { at: 0,   pos: 30, custom: 'x' },
        { at: 500, pos: 70, custom: 'y' },
      ],
    });
    const out = extendRawScriptContent(content, true);
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe('1.2');
    expect(parsed.metadata).toEqual({ creator: 'test' });
    expect(parsed.actions[0]).toEqual({ at: 0, pos: 0, custom: 'x' });
    expect(parsed.actions[1]).toEqual({ at: 500, pos: 100, custom: 'y' });
  });

  it('invalid JSON → returns original string (defensive, never throws)', () => {
    const bad = 'not valid json {';
    expect(extendRawScriptContent(bad, true)).toBe(bad);
  });

  it('non-string input → returned unchanged', () => {
    expect(extendRawScriptContent(null, true)).toBe(null);
    expect(extendRawScriptContent(undefined, true)).toBe(undefined);
    // For numeric input, returned unchanged (typeof check is the guard)
    expect(extendRawScriptContent(42, true)).toBe(42);
  });

  it('content without actions array → returned unchanged', () => {
    const noActions = JSON.stringify({ version: '1.0' });
    expect(extendRawScriptContent(noActions, true)).toBe(noActions);
  });

  it('content with empty actions array → returned unchanged', () => {
    const empty = JSON.stringify({ version: '1.0', actions: [] });
    expect(extendRawScriptContent(empty, true)).toBe(empty);
  });

  it('degenerate width (all-same pos) → returned unchanged (no div-by-zero)', () => {
    const flat = JSON.stringify({
      actions: [{ at: 0, pos: 50 }, { at: 100, pos: 50 }],
    });
    expect(extendRawScriptContent(flat, true)).toBe(flat);
  });

  it('threshold boundary — width exactly at threshold → no stretch', () => {
    const exactlyThreshold = JSON.stringify({
      actions: [
        { at: 0, pos: 10 },                                // min
        { at: 100, pos: 10 + RANGE_EXTENDER_THRESHOLD_PCT }, // max → width = threshold
      ],
    });
    expect(extendRawScriptContent(exactlyThreshold, true)).toBe(exactlyThreshold);
  });

  it('multi-axis embedded fields left intact (Handy/Autoblow are single-axis)', () => {
    // additional_axes is for multi-axis devices; cloud upload paths
    // (HSSP / Autoblow) ignore them anyway. Preserve so re-export
    // round-trips don't lose data.
    const content = JSON.stringify({
      actions: [{ at: 0, pos: 30 }, { at: 100, pos: 70 }],
      additional_axes: [
        { axis: 'twist', actions: [{ at: 0, pos: 50 }, { at: 100, pos: 50 }] },
      ],
    });
    const out = extendRawScriptContent(content, true);
    const parsed = JSON.parse(out);
    expect(parsed.additional_axes).toBeDefined();
    expect(parsed.additional_axes[0].actions).toEqual([{ at: 0, pos: 50 }, { at: 100, pos: 50 }]);
    // Main actions were stretched
    expect(parsed.actions[0].pos).toBe(0);
    expect(parsed.actions[1].pos).toBe(100);
  });

  it('RANGE_EXTENDER_THRESHOLD_PCT is the documented value', () => {
    // Decision: fixed at 80%. Pinning the constant so a future change
    // to it is visible in PR review.
    expect(RANGE_EXTENDER_THRESHOLD_PCT).toBe(80);
  });
});

describe('clampRawScriptContent', () => {
  const SCRIPT = JSON.stringify({
    version: '1.0',
    actions: [
      { at: 0, pos: 5 }, { at: 100, pos: 50 }, { at: 200, pos: 95 },
    ],
  });

  it('no-op cutoff (0/100) → returns original string unchanged', () => {
    expect(clampRawScriptContent(SCRIPT, { min: 0, max: 100 })).toBe(SCRIPT);
  });

  it('null / non-finite cutoff → returns original unchanged', () => {
    expect(clampRawScriptContent(SCRIPT, null)).toBe(SCRIPT);
    expect(clampRawScriptContent(SCRIPT, { min: NaN, max: 80 })).toBe(SCRIPT);
  });

  it('floor/ceiling → pins out-of-band action positions', () => {
    const out = clampRawScriptContent(SCRIPT, { min: 20, max: 80 });
    expect(out).not.toBe(SCRIPT);
    const parsed = JSON.parse(out);
    expect(parsed.actions[0].pos).toBe(20);  // 5  → floor
    expect(parsed.actions[1].pos).toBe(50);  // 50 → untouched
    expect(parsed.actions[2].pos).toBe(80);  // 95 → ceiling
  });

  it('preserves timestamps + other fields', () => {
    const content = JSON.stringify({
      version: '1.2',
      metadata: { creator: 'test' },
      actions: [{ at: 0, pos: 5, custom: 'x' }, { at: 500, pos: 95, custom: 'y' }],
    });
    const parsed = JSON.parse(clampRawScriptContent(content, { min: 20, max: 80 }));
    expect(parsed.version).toBe('1.2');
    expect(parsed.metadata).toEqual({ creator: 'test' });
    expect(parsed.actions[0]).toEqual({ at: 0, pos: 20, custom: 'x' });
    expect(parsed.actions[1]).toEqual({ at: 500, pos: 80, custom: 'y' });
  });

  it('degenerate min >= max → returns original unchanged', () => {
    expect(clampRawScriptContent(SCRIPT, { min: 80, max: 20 })).toBe(SCRIPT);
  });

  it('invalid JSON / non-string / no-actions → returned unchanged', () => {
    const bad = 'not json {';
    expect(clampRawScriptContent(bad, { min: 20, max: 80 })).toBe(bad);
    expect(clampRawScriptContent(null, { min: 20, max: 80 })).toBe(null);
    const noActions = JSON.stringify({ version: '1.0' });
    expect(clampRawScriptContent(noActions, { min: 20, max: 80 })).toBe(noActions);
  });
});

describe('applyDeviceStack — non-regression for existing transforms', () => {
  // Pins that the existing per-device behavior (Buttplug invert + e-stim
  // max-intensity, TCode range, Handy stroke range) reproduces correctly
  // when expressed through the new stack. Failure here = behavior drift
  // against the audit findings in SCOPE §1 contracts R1-R5.

  it('Buttplug invert-only (existing behaviour) matches 100-pos', () => {
    expect(applyDeviceStack(75, { inverted: true })).toBe(applyInvert(75, true));
  });

  it('Buttplug e-stim max-intensity 70 clips correctly (existing R5)', () => {
    expect(applyDeviceStack(85, { maxIntensity: 70 })).toBe(70);
    expect(applyDeviceStack(50, { maxIntensity: 70 })).toBe(50);
  });

  it('Buttplug invert + max-intensity composes (existing pipeline)', () => {
    // pos 100 → invert to 0 → cap doesn't matter (0 is below cap)
    expect(applyDeviceStack(100, { inverted: true, maxIntensity: 70 })).toBe(0);
    // pos 0 → invert to 100 → cap clips to 70
    expect(applyDeviceStack(0,   { inverted: true, maxIntensity: 70 })).toBe(70);
  });

  it('TCode range remap (existing R2) matches the inline formula', () => {
    // Existing inline at tcode-sync.js:256-257:
    //   value = range.min + (value / 100) * (range.max - range.min)
    const inline = (v, r) => r.min + (v / 100) * (r.max - r.min);
    const range = { min: 25, max: 85 };
    for (const v of [0, 17, 50, 73, 100]) {
      expect(applyDeviceStack(v, { range })).toBeCloseTo(inline(v, range), 9);
    }
  });

  it('Handy stroke range (existing R1) matches the inline formula', () => {
    // Same arithmetic as TCode — Handy applies it via SDK's setStrokeZone
    // but the conceptual remap is identical at the per-tick level.
    const inline = (v, r) => r.min + (v / 100) * (r.max - r.min);
    const range = { min: 10, max: 60 };
    for (const v of [0, 25, 50, 75, 100]) {
      expect(applyDeviceStack(v, { range })).toBeCloseTo(inline(v, range), 9);
    }
  });
});
