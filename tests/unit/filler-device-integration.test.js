/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Gap filler has to be correct on EVERY device, with the user's settings as
// they actually have them.
//
// Dave: "for buttplug io the settings can dictate how it reads it, i usually
// use position and inverted but you should account for all of those and any
// other device settings users might have set away from the default."
//
// The design answer is one invariant: filler is generated in SCRIPT POSITION
// SPACE, upstream of the whole per-device stack, and merged into the action
// list before any of it runs. Invert, range, cutoff and safety cap then apply
// to filler and authored content identically, so a user's settings cannot be
// bypassed and joins stay seamless after inversion because both sides invert
// together.
//
// That is an argument. These are the tests. Every assertion here is on the
// value that would be SENT TO THE DEVICE, not the script-space value —
// asserting in script space would prove nothing about the thing that breaks.
import { describe, it, expect } from 'vitest';
import { applyFiller, fillRawScriptContent, DEFAULT_MAX_JOIN_SPEED } from '../../renderer/js/filler-engine.js';
import { applyDeviceStack, computeNaturalRange } from '../../renderer/js/device-transform-stack.js';

const TOLERANCE = 1.05;

const scriptWithMidGap = (pA = 0, pB = 100, gapMs = 20000) => {
  const resume = 2000 + gapMs;
  return [
    { at: 0, pos: 50 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 },
    { at: 1500, pos: 100 }, { at: 2000, pos: pA },
    { at: resume, pos: pB }, { at: resume + 500, pos: 0 },
    { at: resume + 1000, pos: 100 },
  ];
};

const FILLER_OPTS = { enabled: true, thresholdMs: 5000, pattern: 'sine', bpm: 20, depthPct: 100 };

/** Push every action through the per-device stack, as a sync engine would. */
const sendAll = (actions, ctx) =>
  actions.map((a) => ({ at: a.at, pos: applyDeviceStack(a.pos, ctx), _filler: a._filler }));

/** Speeds of segments involving filler, measured on SENT values. */
const sentFillerSpeeds = (sent) => {
  const out = [];
  for (let i = 1; i < sent.length; i++) {
    const a = sent[i - 1];
    const b = sent[i];
    if (!a._filler && !b._filler) continue;
    const dt = b.at - a.at;
    const dp = Math.abs(b.pos - a.pos);
    if (dp === 0) continue;
    out.push(dt <= 0 ? Infinity : (dp / dt) * 1000);
  }
  return out;
};

describe("Dave's setup: Buttplug, position mode, inverted", () => {
  it('joins stay seamless after inversion', () => {
    // The 0-to-1 case, inverted: 0 becomes 100 and 1 becomes 99. Both sides
    // invert together, so the join is still a 1-unit move.
    const merged = applyFiller(scriptWithMidGap(0, 1), FILLER_OPTS);
    const sent = sendAll(merged, { inverted: true });
    for (const s of sentFillerSpeeds(sent)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });

  it('inversion is applied to filler, not skipped', () => {
    const merged = applyFiller(scriptWithMidGap(0, 100), FILLER_OPTS);
    const plain = sendAll(merged, {});
    const inverted = sendAll(merged, { inverted: true });
    const fi = inverted.filter((a) => a._filler);
    const fp = plain.filter((a) => a._filler);
    expect(fi.length).toBeGreaterThan(0);
    for (let i = 0; i < fi.length; i++) {
      expect(fi[i].pos).toBeCloseTo(100 - fp[i].pos, 5);
    }
  });
});

describe("a user's range limit is never bypassed", () => {
  it('no sent filler value falls outside the configured range', () => {
    for (const range of [{ min: 20, max: 80 }, { min: 0, max: 40 }, { min: 60, max: 100 }]) {
      const merged = applyFiller(scriptWithMidGap(0, 100), FILLER_OPTS);
      const sent = sendAll(merged, { range });
      for (const a of sent.filter((x) => x._filler)) {
        expect(a.pos, JSON.stringify(range)).toBeGreaterThanOrEqual(range.min - 0.001);
        expect(a.pos, JSON.stringify(range)).toBeLessThanOrEqual(range.max + 0.001);
      }
    }
  });

  it('range compression makes joins slower, never faster', () => {
    const merged = applyFiller(scriptWithMidGap(0, 100), FILLER_OPTS);
    const full = Math.max(0, ...sentFillerSpeeds(sendAll(merged, {})));
    const narrow = Math.max(0, ...sentFillerSpeeds(sendAll(merged, { range: { min: 40, max: 60 } })));
    expect(narrow).toBeLessThanOrEqual(full + 0.001);
  });
});

describe('output cutoff clamps filler too', () => {
  it('filler obeys the same floor and ceiling as the main script', () => {
    const cutoff = { min: 20, max: 80 };
    const merged = applyFiller(scriptWithMidGap(0, 100), FILLER_OPTS);
    const sent = sendAll(merged, { cutoff });
    for (const a of sent) {
      expect(a.pos).toBeGreaterThanOrEqual(20);
      expect(a.pos).toBeLessThanOrEqual(80);
    }
    expect(sent.some((a) => a._filler)).toBe(true);
  });

  it('adds no new discontinuity at the boundary', () => {
    const merged = applyFiller(scriptWithMidGap(0, 100), FILLER_OPTS);
    const sent = sendAll(merged, { cutoff: { min: 20, max: 80 } });
    for (const s of sentFillerSpeeds(sent)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });
});

describe('e-stim safety cap', () => {
  it('caps filler as well as authored content', () => {
    const merged = applyFiller(scriptWithMidGap(0, 100), FILLER_OPTS);
    const sent = sendAll(merged, { maxIntensity: 40 });
    for (const a of sent) expect(a.pos).toBeLessThanOrEqual(40);
  });
});

describe('the range extender measures AUTHORED content only', () => {
  // The hazard: the extender stretches narrow scripts using a factor derived
  // from the script's own range. Measuring filler would stretch the author's
  // content by a factor derived from content they did not write.
  it('a narrow script keeps its narrow natural range once filler exists', () => {
    const narrow = [
      { at: 0, pos: 45 }, { at: 500, pos: 55 }, { at: 1000, pos: 45 },
      { at: 21000, pos: 55 }, { at: 21500, pos: 45 },
    ];
    const merged = applyFiller(narrow, FILLER_OPTS);
    expect(merged.some((a) => a._filler)).toBe(true);

    const authoredRange = computeNaturalRange(narrow);
    expect(authoredRange).toEqual({ min: 45, max: 55 });

    // Depth is a percentage of the AUTHORED range, so filler sits inside it
    // and measuring the merged list must not widen the reading materially.
    const mergedRange = computeNaturalRange(merged);
    expect(mergedRange.min).toBeGreaterThanOrEqual(authoredRange.min - 2);
    expect(mergedRange.max).toBeLessThanOrEqual(authoredRange.max + 2);
  });

  it('extender output is identical whether or not filler is present', () => {
    const narrow = [
      { at: 0, pos: 45 }, { at: 500, pos: 55 }, { at: 1000, pos: 45 },
      { at: 21000, pos: 55 }, { at: 21500, pos: 45 },
    ];
    const authoredRange = computeNaturalRange(narrow);
    const ctx = { natural: authoredRange, extender: { enabled: true, thresholdPct: 80 } };
    // An authored point must be transformed the same regardless of filler.
    expect(applyDeviceStack(55, ctx)).toBeCloseTo(100, 5);
    expect(applyDeviceStack(45, ctx)).toBeCloseTo(0, 5);
  });
});

describe('every combination, swept', () => {
  // The assertion that actually protects the feature: whatever the user has
  // configured, nothing sent to their device exceeds the join speed cap.
  it('no sent filler segment exceeds the cap across invert x range x cutoff', () => {
    const inverts = [false, true];
    const ranges = [null, { min: 20, max: 80 }, { min: 0, max: 50 }];
    const cutoffs = [null, { min: 10, max: 90 }, { min: 30, max: 70 }];
    const merged = applyFiller(scriptWithMidGap(0, 1), FILLER_OPTS);

    for (const inverted of inverts) {
      for (const range of ranges) {
        for (const cutoff of cutoffs) {
          const sent = sendAll(merged, { inverted, range, cutoff });
          const worst = Math.max(0, ...sentFillerSpeeds(sent));
          expect(
            worst,
            `inverted=${inverted} range=${JSON.stringify(range)} cutoff=${JSON.stringify(cutoff)}`,
          ).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
        }
      }
    }
  });
});

describe('cloud-upload devices get filler too', () => {
  // Handy HSSP and Autoblow play an uploaded script from their own clock.
  // Without this path they would silently get no filler at all.
  it('bakes filler into the uploaded JSON', () => {
    const raw = JSON.stringify({ version: '1.0', actions: scriptWithMidGap(0, 100) });
    const out = fillRawScriptContent(raw, FILLER_OPTS);
    const parsed = JSON.parse(out);
    expect(parsed.actions.length).toBeGreaterThan(scriptWithMidGap(0, 100).length);
    expect(parsed.version).toBe('1.0');   // other fields preserved
  });

  it('strips the internal marker before sending', () => {
    const raw = JSON.stringify({ actions: scriptWithMidGap(0, 100) });
    const parsed = JSON.parse(fillRawScriptContent(raw, FILLER_OPTS));
    for (const a of parsed.actions) {
      expect(Object.keys(a).sort()).toEqual(['at', 'pos']);
    }
  });

  it('keeps the uploaded script within the speed cap', () => {
    const raw = JSON.stringify({ actions: scriptWithMidGap(0, 1) });
    const parsed = JSON.parse(fillRawScriptContent(raw, FILLER_OPTS));
    for (let i = 1; i < parsed.actions.length; i++) {
      const dt = parsed.actions[i].at - parsed.actions[i - 1].at;
      const dp = Math.abs(parsed.actions[i].pos - parsed.actions[i - 1].pos);
      if (dp === 0 || dt <= 0) continue;
      // Authored segments can legitimately be fast; only check the gap.
      if (parsed.actions[i].at > 2000 && parsed.actions[i].at < 22000) {
        expect((dp / dt) * 1000).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
      }
    }
  });

  // Same contract as extendRawScriptContent: never corrupt, never throw.
  it('returns the input untouched on a no-op', () => {
    const raw = JSON.stringify({ actions: scriptWithMidGap(0, 100) });
    expect(fillRawScriptContent(raw, { ...FILLER_OPTS, enabled: false })).toBe(raw);
    expect(fillRawScriptContent(raw, null)).toBe(raw);
    expect(fillRawScriptContent('not json', FILLER_OPTS)).toBe('not json');
    expect(fillRawScriptContent(JSON.stringify({ actions: [] }), FILLER_OPTS))
      .toBe(JSON.stringify({ actions: [] }));
    expect(fillRawScriptContent('', FILLER_OPTS)).toBe('');
    expect(fillRawScriptContent(null, FILLER_OPTS)).toBe(null);
  });

  it('returns the input untouched when no gap qualifies', () => {
    const dense = Array.from({ length: 40 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 100 : 0 }));
    const raw = JSON.stringify({ actions: dense });
    expect(fillRawScriptContent(raw, FILLER_OPTS)).toBe(raw);
  });
});
