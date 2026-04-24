// Tests for the auto-offset helpers. The source-tag logic gates whether
// a user's hand-tuned offset gets silently overwritten by a preset, so
// it's covered exhaustively — a regression there would be very annoying.

import { describe, it, expect } from 'vitest';
import {
  VR_OFFSET_PRESETS,
  DEVICE_OFFSET_PRESETS,
  classifyTransport,
  lookupVrPreset,
  computeSuggestedOffset,
  decidePresetApply,
} from '../../renderer/js/auto-offset.js';

describe('classifyTransport', () => {
  it('returns cable for sub-5ms jitter', () => {
    expect(classifyTransport(0)).toBe('cable');
    expect(classifyTransport(4.9)).toBe('cable');
  });

  it('returns wifi-fast for 5-20ms', () => {
    expect(classifyTransport(5)).toBe('wifi-fast');
    expect(classifyTransport(15)).toBe('wifi-fast');
  });

  it('returns wifi-slow for 20-50ms', () => {
    expect(classifyTransport(20)).toBe('wifi-slow');
    expect(classifyTransport(45)).toBe('wifi-slow');
  });

  it('returns wifi-slowest for 50ms+', () => {
    expect(classifyTransport(50)).toBe('wifi-slowest');
    expect(classifyTransport(200)).toBe('wifi-slowest');
  });

  it('defaults to wifi-slow for null/missing input', () => {
    expect(classifyTransport(null)).toBe('wifi-slow');
    expect(classifyTransport(undefined)).toBe('wifi-slow');
    expect(classifyTransport(-1)).toBe('wifi-slow');
  });
});

describe('lookupVrPreset', () => {
  it('returns the preset for a known player + transport', () => {
    const r = lookupVrPreset('heresphere', 30);
    expect(r).toEqual({ key: 'heresphere:wifi-slow', value: -350 });
  });

  it('returns null for unknown player', () => {
    expect(lookupVrPreset('unknown', 10)).toBeNull();
  });

  it('classifies transport from jitter automatically', () => {
    expect(lookupVrPreset('heresphere', 1)?.key).toBe('heresphere:cable');
    expect(lookupVrPreset('heresphere', 100)?.key).toBe('heresphere:wifi-slowest');
  });

  it('all preset values are negative (early-fire convention)', () => {
    for (const v of Object.values(VR_OFFSET_PRESETS)) {
      expect(v).toBeLessThan(0);
    }
    for (const v of Object.values(DEVICE_OFFSET_PRESETS)) {
      expect(v).toBeLessThan(0);
    }
  });
});

describe('computeSuggestedOffset', () => {
  it('uses Handy RTD/2 for handy device on desktop', () => {
    const r = computeSuggestedOffset({ device: 'handy', context: 'desktop', handyRtdMs: 120 });
    // 120/2 = 60, rounded to 10ms → -60
    expect(r).toBe(-60);
  });

  it('uses Buttplug ping/2 for buttplug device on desktop', () => {
    const r = computeSuggestedOffset({ device: 'buttplug', context: 'desktop', buttplugPingMs: 80 });
    expect(r).toBe(-40);
  });

  it('adds VR jitter for vr context', () => {
    const r = computeSuggestedOffset({
      device: 'handy', context: 'vr',
      handyRtdMs: 100, vrJitterMs: 12, vrPlayerType: 'heresphere',
    });
    // 100/2 + 12 + |-200| (heresphere:wifi-fast) = 50+12+200 = 262 → -260
    expect(r).toBe(-260);
  });

  it('adds WS RTT/2 for remote context', () => {
    const r = computeSuggestedOffset({
      device: 'handy', context: 'remote',
      handyRtdMs: 100, wsRttMs: 30,
    });
    // 50 + 15 = 65 → -70 (rounded to nearest 10)
    expect(r).toBe(-70);
  });

  it('rounds to nearest 10ms', () => {
    expect(computeSuggestedOffset({ device: 'handy', context: 'desktop', handyRtdMs: 47 })).toBe(-20);
    expect(computeSuggestedOffset({ device: 'handy', context: 'desktop', handyRtdMs: 53 })).toBe(-30);
  });

  it('returns 0 when nothing is measurable', () => {
    expect(computeSuggestedOffset({ device: 'handy', context: 'desktop' })).toBe(0);
  });

  it('omits device latency when not provided', () => {
    // VR jitter only.
    const r = computeSuggestedOffset({
      device: 'buttplug', context: 'vr',
      vrJitterMs: 15, vrPlayerType: 'heresphere',
    });
    // 15 + 200 = 215 → -220
    expect(r).toBe(-220);
  });
});

describe('decidePresetApply', () => {
  const incoming = { key: 'heresphere:wifi-slow', value: -350 };

  it('applies when no saved source (first connect / legacy)', () => {
    expect(decidePresetApply({}, incoming)).toEqual({
      apply: true, reason: 'no-saved-source',
    });
    expect(decidePresetApply(null, incoming)).toEqual({
      apply: true, reason: 'no-saved-source',
    });
    expect(decidePresetApply({ value: -200 }, incoming)).toEqual({
      apply: true, reason: 'no-saved-source',
    });
  });

  it('NEVER applies when source is user (manual tune)', () => {
    expect(decidePresetApply({ source: 'user', value: -200 }, incoming)).toEqual({
      apply: false, reason: 'user-tuned',
    });
    // Even if the saved value matches the incoming preset coincidentally:
    expect(decidePresetApply({ source: 'user', value: -350 }, incoming)).toEqual({
      apply: false, reason: 'user-tuned',
    });
  });

  it('applies when source=preset but the preset key changed', () => {
    // E.g. user switched from WiFi to USB cable; we want to apply the
    // new preset that better fits the new transport.
    expect(decidePresetApply(
      { source: 'preset', presetKey: 'heresphere:wifi-slow', value: -350 },
      { key: 'heresphere:cable', value: -100 },
    )).toEqual({ apply: true, reason: 'preset-key-changed' });
  });

  it('does NOT apply when source=preset and key is identical (no-op refresh)', () => {
    expect(decidePresetApply(
      { source: 'preset', presetKey: 'heresphere:wifi-slow', value: -350 },
      { key: 'heresphere:wifi-slow', value: -350 },
    )).toEqual({ apply: false, reason: 'same-preset' });
  });

  it('does not apply for unknown source values (defensive)', () => {
    expect(decidePresetApply({ source: 'mystery' }, incoming)).toEqual({
      apply: false, reason: 'unknown-source',
    });
  });
});

describe('source-tag invariant — user value is never lost', () => {
  // Property test: across many call sequences, a value tagged 'user'
  // must never be overwritten by decidePresetApply.
  it('survives any sequence of preset application decisions', () => {
    const userState = { source: 'user', value: -250 };
    const presetSequence = [
      { key: 'heresphere:wifi-slow', value: -350 },
      { key: 'heresphere:cable', value: -100 },
      { key: 'deovr:wifi-fast', value: -180 },
      { key: 'heresphere:wifi-slowest', value: -500 },
    ];
    for (const incoming of presetSequence) {
      const decision = decidePresetApply(userState, incoming);
      expect(decision.apply).toBe(false);
    }
  });
});
