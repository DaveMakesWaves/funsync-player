/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Filler strokes during script gaps (lnlytrckr, thread #269).
//
// The requirement that drives almost every test here, in Dave's words:
//
//   "if the filler needs to stop at position 0 and the main script starts at
//    1 i dont want an ultrafast jump, i want the filler to account for where
//    and what position the main script starts and make sure its in the right
//    position when the main script starts."
//
// So the assertions are about MOTION and about the JOINS, not about how many
// points came out. Structural assertions are what let the doubleSpeed no-op
// survive for months; they are not acceptable here.
//
// Everything works in SCRIPT POSITION SPACE, upstream of the per-device
// stack, which is what makes filler obey a user's inversion, range limit and
// output cutoff automatically. The device-facing consequences of that are
// pinned in filler-device-integration.test.js.
import { describe, it, expect } from 'vitest';
import {
  applyFiller,
  buildFillerActions,
  buildGapFiller,
  joinReserveMs,
  limitSlewRate,
  mergeFiller,
  resolveDepth,
  DEFAULT_MAX_JOIN_SPEED,
  MIN_PATTERN_MS,
} from '../../renderer/js/filler-engine.js';
import { FILLER_PRESETS, getPreset, resolveFillerOptions } from '../../renderer/js/filler-presets.js';

// Rounding to integer ms and integer position can nudge a segment a hair
// over the cap. 5% absorbs that without hiding a real violation, which would
// be off by multiples, not percent.
const TOLERANCE = 1.05;

/** Speed in units/sec of every segment that involves a filler point. */
const fillerSegmentSpeeds = (merged) => {
  const speeds = [];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1];
    const b = merged[i];
    if (!a._filler && !b._filler) continue;   // authored-only segment
    const dt = b.at - a.at;
    const dp = Math.abs(b.pos - a.pos);
    if (dp === 0) continue;
    speeds.push(dt <= 0 ? Infinity : (dp / dt) * 1000);
  }
  return speeds;
};

/** A script with a gap in the middle: strokes, silence, strokes. */
const scriptWithMidGap = (pA = 0, pB = 100, gapMs = 20000) => {
  const head = [
    { at: 0, pos: 50 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 },
    { at: 1500, pos: 100 }, { at: 2000, pos: pA },
  ];
  const resume = 2000 + gapMs;
  const tail = [
    { at: resume, pos: pB }, { at: resume + 500, pos: 0 },
    { at: resume + 1000, pos: 100 }, { at: resume + 1500, pos: 0 },
  ];
  return [...head, ...tail];
};

const OPTS = { enabled: true, thresholdMs: 5000, pattern: 'sine', bpm: 20, depthPct: 100 };

describe('the main script is never touched', () => {
  it('returns every authored action unchanged', () => {
    const authored = scriptWithMidGap();
    const merged = applyFiller(authored, OPTS);
    const kept = merged.filter((a) => !a._filler);
    expect(kept.length).toBe(authored.length);
    expect(kept.map((a) => ({ at: a.at, pos: a.pos }))).toEqual(authored);
  });

  it('does not mutate the input array or its objects', () => {
    const authored = scriptWithMidGap();
    const snapshot = JSON.parse(JSON.stringify(authored));
    applyFiller(authored, OPTS);
    expect(authored).toEqual(snapshot);
  });

  it('adds filler only, never removes or edits', () => {
    const authored = scriptWithMidGap();
    const merged = applyFiller(authored, OPTS);
    expect(merged.length).toBeGreaterThan(authored.length);
    for (const a of authored) {
      expect(merged.some((m) => m.at === a.at && m.pos === a.pos && !m._filler)).toBe(true);
    }
  });

  it('is a no-op when disabled', () => {
    const authored = scriptWithMidGap();
    expect(applyFiller(authored, { ...OPTS, enabled: false })).toEqual(authored);
  });
});

describe('filler never overlaps the main script', () => {
  it('every filler point lies strictly inside its gap', () => {
    const authored = scriptWithMidGap();
    const merged = applyFiller(authored, OPTS);
    const filler = merged.filter((a) => a._filler);
    expect(filler.length).toBeGreaterThan(0);
    for (const f of filler) {
      expect(f.at).toBeGreaterThan(2000);
      expect(f.at).toBeLessThan(22000);
    }
  });

  it('no filler point shares a timestamp with an authored action', () => {
    const authored = scriptWithMidGap();
    const merged = applyFiller(authored, OPTS);
    const authoredTimes = new Set(authored.map((a) => a.at));
    for (const f of merged.filter((a) => a._filler)) {
      expect(authoredTimes.has(f.at)).toBe(false);
    }
  });

  it('emits nothing when there is no qualifying gap', () => {
    const dense = Array.from({ length: 40 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 100 : 0 }));
    const merged = applyFiller(dense, OPTS);
    expect(merged.filter((a) => a._filler)).toHaveLength(0);
  });

  it('respects the threshold — a gap under it is left alone', () => {
    const authored = scriptWithMidGap(0, 100, 6000);
    const merged = applyFiller(authored, { ...OPTS, thresholdMs: 10000 });
    expect(merged.filter((a) => a._filler)).toHaveLength(0);
  });
});

describe('seamless joins — the core requirement', () => {
  // Dave's exact scenario.
  it('filler ending near 0 into a script resuming at 1 makes no fast jump', () => {
    const authored = scriptWithMidGap(0, 1);
    const merged = applyFiller(authored, OPTS);
    expect(merged.filter((a) => a._filler).length).toBeGreaterThan(0);
    for (const s of fillerSegmentSpeeds(merged)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });

  it('handles the reverse worst case: filler high, script resumes at 0', () => {
    const authored = scriptWithMidGap(100, 0);
    const merged = applyFiller(authored, OPTS);
    for (const s of fillerSegmentSpeeds(merged)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });

  // The property that actually protects the feature.
  it('no filler segment exceeds the cap, across every pattern and boundary', () => {
    for (const preset of FILLER_PRESETS) {
      for (const pA of [0, 1, 37, 50, 99, 100]) {
        for (const pB of [0, 1, 63, 50, 99, 100]) {
          const authored = scriptWithMidGap(pA, pB);
          const merged = applyFiller(authored, {
            enabled: true,
            thresholdMs: 5000,
            pattern: preset.pattern,
            bpm: preset.bpm,
            depthPct: preset.depthPct,
          });
          const worst = Math.max(0, ...fillerSegmentSpeeds(merged));
          expect(
            worst,
            `${preset.id} pattern=${preset.pattern} pA=${pA} pB=${pB}`,
          ).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
        }
      }
    }
  });

  it('honours a custom (lower) speed cap', () => {
    const authored = scriptWithMidGap(0, 100);
    const merged = applyFiller(authored, { ...OPTS, maxJoinSpeed: 80 });
    for (const s of fillerSegmentSpeeds(merged)) {
      expect(s).toBeLessThanOrEqual(80 * TOLERANCE);
    }
  });

  it('refuses to fill a gap too short to join safely, rather than lurching', () => {
    const reserve = joinReserveMs(DEFAULT_MAX_JOIN_SPEED);
    const tooShort = { startMs: 0, endMs: reserve * 2 + MIN_PATTERN_MS - 50 };
    expect(buildGapFiller(tooShort, 0, 100, { pattern: 'sine', bpm: 20 })).toEqual([]);
  });
});

describe('leading and trailing gaps', () => {
  it('a leading gap lands on the first action, with no jump into it', () => {
    const authored = [
      { at: 30000, pos: 80 }, { at: 30500, pos: 0 }, { at: 31000, pos: 100 },
    ];
    const merged = applyFiller(authored, { ...OPTS, totalDurationMs: 40000 });
    // A duration is set, so there is trailing filler too. Scope to the
    // leading run.
    const leading = merged.filter((a) => a._filler && a.at < 30000);
    expect(leading.length).toBeGreaterThan(0);
    for (const s of fillerSegmentSpeeds(merged)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });

  it('a trailing gap starts from the last action and eases to rest', () => {
    const authored = [
      { at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 100 },
    ];
    const merged = applyFiller(authored, { ...OPTS, totalDurationMs: 40000 });
    const filler = merged.filter((a) => a._filler);
    expect(filler.length).toBeGreaterThan(0);
    expect(Math.min(...filler.map((f) => f.at))).toBeGreaterThan(1000);
    for (const s of fillerSegmentSpeeds(merged)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });

  // A leading gap is bounded by the first action, so it is fillable without
  // knowing the video length. A trailing gap is not — its end is the end of
  // the video, and without a duration there is nothing to fill up to.
  it('fills a leading gap even without a known duration', () => {
    const authored = [{ at: 30000, pos: 80 }, { at: 30500, pos: 0 }];
    const merged = applyFiller(authored, OPTS);
    expect(merged.filter((a) => a._filler).length).toBeGreaterThan(0);
  });

  it('emits no trailing filler without a known duration', () => {
    const authored = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }];
    expect(applyFiller(authored, OPTS).filter((a) => a._filler)).toHaveLength(0);
  });
});

describe('square is limited, not banned', () => {
  // `_squarePattern` emits two points at the same timestamp to express an
  // instant edge, but `_dedupeByTime` then drops the earlier of the pair, so
  // the raw output is already a steep ramp rather than a true vertical.
  // The limiter still matters, because that ramp gets arbitrarily steep as
  // BPM rises — this is what proves it is not decoration.
  it('raw square exceeds the cap at high BPM, so the limiter is load-bearing', async () => {
    const { generatePattern } = await import('../../renderer/js/script-modifiers.js');
    const raw = generatePattern('square', 0, 10000, 200, 0, 100);
    let worst = 0;
    for (let i = 1; i < raw.length; i++) {
      const dt = raw[i].at - raw[i - 1].at;
      const dp = Math.abs(raw[i].pos - raw[i - 1].pos);
      if (dp === 0) continue;
      worst = Math.max(worst, dt <= 0 ? Infinity : (dp / dt) * 1000);
    }
    expect(worst, 'square got gentle on its own; re-check whether the limiter is still needed')
      .toBeGreaterThan(DEFAULT_MAX_JOIN_SPEED);
  });

  it('and the limiter brings that back under the cap', () => {
    const merged = applyFiller(scriptWithMidGap(50, 50), {
      ...OPTS, pattern: 'square', bpm: 200,
    });
    const filler = merged.filter((a) => a._filler);
    expect(filler.length).toBeGreaterThan(0);
    for (const s of fillerSegmentSpeeds(merged)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });

  it('the limiter turns those edges into ramps', () => {
    const merged = applyFiller(scriptWithMidGap(50, 50), {
      ...OPTS, pattern: 'square', bpm: 25,
    });
    const filler = merged.filter((a) => a._filler);
    expect(filler.length).toBeGreaterThan(0);
    for (const s of fillerSegmentSpeeds(merged)) {
      expect(s).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
    }
  });

  it('but square still moves — it is not flattened away', () => {
    const merged = applyFiller(scriptWithMidGap(50, 50), {
      ...OPTS, pattern: 'square', bpm: 25,
    });
    const filler = merged.filter((a) => a._filler);
    const spread = Math.max(...filler.map((f) => f.pos)) - Math.min(...filler.map((f) => f.pos));
    expect(spread).toBeGreaterThan(30);
  });
});

describe('limitSlewRate', () => {
  it('leaves a pattern already within the limit alone', () => {
    const slow = [{ at: 0, pos: 0 }, { at: 2000, pos: 50 }];
    const out = limitSlewRate(slow, 300);
    expect(out[0].pos).toBe(0);
    expect(out[out.length - 1].pos).toBe(50);
  });

  it('caps a violent move', () => {
    const violent = [{ at: 0, pos: 0 }, { at: 100, pos: 100 }];
    const out = limitSlewRate(violent, 100);
    for (let i = 1; i < out.length; i++) {
      const dt = out[i].at - out[i - 1].at;
      const dp = Math.abs(out[i].pos - out[i - 1].pos);
      expect((dp / dt) * 1000).toBeLessThanOrEqual(100 * TOLERANCE);
    }
  });

  it('survives duplicate timestamps without dividing by zero', () => {
    const dup = [
      { at: 0, pos: 0 }, { at: 500, pos: 0 },
      { at: 500, pos: 100 }, { at: 1000, pos: 100 },
    ];
    const out = limitSlewRate(dup, 200);
    for (const a of out) expect(Number.isFinite(a.pos)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i].at).toBeGreaterThan(out[i - 1].at);
  });

  it('degrades safely on junk input', () => {
    expect(limitSlewRate([], 300)).toEqual([]);
    expect(limitSlewRate(null, 300)).toEqual([]);
    expect(limitSlewRate([{ at: 0, pos: 5 }], 300)).toEqual([{ at: 0, pos: 5 }]);
    expect(() => limitSlewRate([{ at: 0, pos: 0 }, { at: 10, pos: 5 }], 0)).not.toThrow();
  });
});

describe('depth follows the authored range, not a fixed 0-100 band', () => {
  // Why: the range extender stretches narrow scripts using a factor derived
  // from AUTHORED content. Filler generated at a fixed 0-100 inside a script
  // that lives between 40 and 60 would be stretched by a factor it is not
  // part of, then clamped, and come out misshapen.
  it('a narrow script gets narrow filler', () => {
    const narrow = [{ at: 0, pos: 40 }, { at: 500, pos: 60 }, { at: 1000, pos: 40 }];
    const depth = resolveDepth(narrow, { depthPct: 100 });
    expect(depth.min).toBeGreaterThanOrEqual(40);
    expect(depth.max).toBeLessThanOrEqual(60);
  });

  it('depthPct narrows within that range', () => {
    const full = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }];
    expect(resolveDepth(full, { depthPct: 100 })).toEqual({ min: 0, max: 100 });
    expect(resolveDepth(full, { depthPct: 60 })).toEqual({ min: 20, max: 80 });
  });

  it('an absolute override bypasses the authored range', () => {
    const narrow = [{ at: 0, pos: 40 }, { at: 500, pos: 60 }];
    expect(resolveDepth(narrow, { absolute: { min: 0, max: 100 } })).toEqual({ min: 0, max: 100 });
  });

  it('a flat script degrades to full throw rather than zero motion', () => {
    const flat = [{ at: 0, pos: 50 }, { at: 500, pos: 50 }];
    expect(resolveDepth(flat, { depthPct: 100 })).toEqual({ min: 0, max: 100 });
  });

  it('filler stays inside the authored range end to end', () => {
    const narrow = [
      { at: 0, pos: 40 }, { at: 500, pos: 60 }, { at: 1000, pos: 40 },
      { at: 21000, pos: 60 }, { at: 21500, pos: 40 },
    ];
    const merged = applyFiller(narrow, { ...OPTS, depthPct: 100 });
    const filler = merged.filter((a) => a._filler);
    expect(filler.length).toBeGreaterThan(0);
    for (const f of filler) {
      // Join ramps may travel outside the band to reach the authored
      // positions, but those are themselves inside 40-60 here.
      expect(f.pos).toBeGreaterThanOrEqual(38);
      expect(f.pos).toBeLessThanOrEqual(62);
    }
  });
});

describe('output is always playable', () => {
  it('timestamps strictly increase and positions stay in range', () => {
    for (const preset of FILLER_PRESETS) {
      const merged = applyFiller(scriptWithMidGap(0, 100), {
        enabled: true, thresholdMs: 5000,
        pattern: preset.pattern, bpm: preset.bpm, depthPct: preset.depthPct,
      });
      for (let i = 1; i < merged.length; i++) {
        expect(merged[i].at, preset.id).toBeGreaterThanOrEqual(merged[i - 1].at);
      }
      for (const a of merged) {
        expect(a.pos).toBeGreaterThanOrEqual(0);
        expect(a.pos).toBeLessThanOrEqual(100);
        expect(Number.isFinite(a.at)).toBe(true);
      }
    }
  });

  it('handles an empty or single-action script', () => {
    expect(applyFiller([], OPTS)).toEqual([]);
    expect(applyFiller([{ at: 0, pos: 50 }], OPTS)).toEqual([{ at: 0, pos: 50 }]);
  });

  it('does not double-fill when applied twice', () => {
    const authored = scriptWithMidGap();
    const once = applyFiller(authored, OPTS);
    const authoredOnly = once.filter((a) => !a._filler).map((a) => ({ at: a.at, pos: a.pos }));
    const twice = applyFiller(authoredOnly, OPTS);
    expect(twice.filter((a) => a._filler).length).toBe(once.filter((a) => a._filler).length);
  });
});

describe('presets', () => {
  it('every preset resolves and names a real generator', () => {
    const known = ['sine', 'sawtooth', 'square', 'triangle', 'escalating', 'random'];
    for (const p of FILLER_PRESETS) {
      expect(known).toContain(p.pattern);
      expect(p.bpm).toBeGreaterThan(0);
      expect(p.depthPct).toBeGreaterThan(0);
      expect(p.labelKey.startsWith('filler.preset.')).toBe(true);
    }
  });

  it('an unknown preset id falls back instead of throwing', () => {
    expect(getPreset('nope')).toBeTruthy();
    expect(getPreset('nope').id).toBe('slowTease');
  });

  it('custom settings bypass the preset table', () => {
    const opts = resolveFillerOptions({
      enabled: true, presetId: 'custom',
      custom: { pattern: 'triangle', bpm: 55, depthPct: 40 },
    });
    expect(opts.pattern).toBe('triangle');
    expect(opts.bpm).toBe(55);
    expect(opts.depthPct).toBe(40);
  });

  it('every preset actually produces motion in a real gap', () => {
    for (const p of FILLER_PRESETS) {
      const merged = applyFiller(scriptWithMidGap(50, 50), {
        ...resolveFillerOptions({ enabled: true, presetId: p.id, thresholdMs: 5000 }),
      });
      const filler = merged.filter((a) => a._filler);
      expect(filler.length, p.id).toBeGreaterThan(1);
      const spread = Math.max(...filler.map((f) => f.pos)) - Math.min(...filler.map((f) => f.pos));
      expect(spread, `${p.id} produced no movement`).toBeGreaterThan(5);
    }
  });
});

// The Custom option in the settings panel feeds these fields straight from
// sliders, so the values that arrive here are whatever the user dragged to,
// including combinations the preset table can never produce.
describe('custom settings from the picker', () => {
  it('uses the custom pattern, bpm and depth verbatim', () => {
    const opts = resolveFillerOptions({
      enabled: true, presetId: 'custom',
      custom: { pattern: 'square', bpm: 75, depthPct: 35 },
    });
    expect(opts).toMatchObject({ pattern: 'square', bpm: 75, depthPct: 35 });
  });

  it('an absolute band overrides the depth percentage', () => {
    const opts = resolveFillerOptions({
      enabled: true, presetId: 'custom',
      custom: { pattern: 'sine', bpm: 20, depthPct: 30, absolute: { min: 10, max: 90 } },
    });
    expect(resolveDepth([{ at: 0, pos: 40 }, { at: 1, pos: 60 }], {
      depthPct: opts.depthPct, absolute: opts.absoluteDepth,
    })).toEqual({ min: 10, max: 90 });
  });

  it('falls back to sane values when the custom block is partial', () => {
    const opts = resolveFillerOptions({ enabled: true, presetId: 'custom', custom: {} });
    expect(opts.pattern).toBe('sine');
    expect(opts.bpm).toBeGreaterThan(0);
    expect(opts.depthPct).toBeGreaterThan(0);
  });

  it('presetId custom with no custom block falls back to a preset', () => {
    const opts = resolveFillerOptions({ enabled: true, presetId: 'custom', custom: null });
    expect(opts.pattern).toBeTruthy();
    expect(opts.bpm).toBeGreaterThan(0);
  });

  // The absolute min/max sliders can be dragged past each other, and the two
  // layers handle that differently ON PURPOSE:
  //   * the picker REFUSES an inverted band (readCustom returns absolute:
  //     null), so the user's depth % stays in charge rather than the app
  //     silently reinterpreting what they dragged
  //   * resolveDepth, which any caller can reach, normalises defensively so
  //     a hand-edited config can never produce a negative-width band
  it('resolveDepth normalises an inverted band rather than emitting nonsense', () => {
    expect(resolveDepth([{ at: 0, pos: 0 }, { at: 1, pos: 100 }],
      { absolute: { min: 80, max: 20 } })).toEqual({ min: 20, max: 80 });
  });

  it('no absolute band means the depth percentage applies', () => {
    expect(resolveDepth([{ at: 0, pos: 0 }, { at: 1, pos: 100 }],
      { depthPct: 100, absolute: null })).toEqual({ min: 0, max: 100 });
    expect(resolveDepth([{ at: 0, pos: 0 }, { at: 1, pos: 100 }],
      { depthPct: 50, absolute: null })).toEqual({ min: 25, max: 75 });
  });

  it('every custom pattern still produces safe, moving filler', () => {
    for (const pattern of ['sine', 'triangle', 'sawtooth', 'square', 'escalating', 'random']) {
      for (const bpm of [10, 60, 120]) {
        const merged = applyFiller(scriptWithMidGap(0, 100), {
          ...resolveFillerOptions({
            enabled: true, presetId: 'custom',
            custom: { pattern, bpm, depthPct: 100 },
          }),
          thresholdMs: 5000,
        });
        const filler = merged.filter((a) => a._filler);
        expect(filler.length, `${pattern}@${bpm}`).toBeGreaterThan(1);
        const worst = Math.max(0, ...fillerSegmentSpeeds(merged));
        expect(worst, `${pattern}@${bpm}`).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
      }
    }
  });
});

describe('the picker preview matches what plays', () => {
  it('previews through the same resolve path as playback', async () => {
    const { buildPreviewSample, PREVIEW_WINDOW_MS } = await import('../../renderer/js/filler-preview.js');
    const { actions, stats } = buildPreviewSample({ pattern: 'sine', bpm: 30, min: 20, max: 80 });
    expect(actions.length).toBeGreaterThan(1);
    expect(actions[0].at).toBeGreaterThanOrEqual(0);
    expect(actions[actions.length - 1].at).toBeLessThanOrEqual(PREVIEW_WINDOW_MS);
    expect(stats.avgSpeed).toBeGreaterThan(0);
    expect(stats.maxSpeed).toBeGreaterThanOrEqual(stats.avgSpeed);
  });

  it('the previewed sample obeys the same speed cap as playback', async () => {
    const { buildPreviewSample } = await import('../../renderer/js/filler-preview.js');
    for (const pattern of ['square', 'sawtooth', 'random']) {
      const { actions } = buildPreviewSample({ pattern, bpm: 120, min: 0, max: 100 });
      for (let i = 1; i < actions.length; i++) {
        const dt = actions[i].at - actions[i - 1].at;
        const dp = Math.abs(actions[i].pos - actions[i - 1].pos);
        if (dp === 0 || dt <= 0) continue;
        expect((dp / dt) * 1000, pattern).toBeLessThanOrEqual(DEFAULT_MAX_JOIN_SPEED * TOLERANCE);
      }
    }
  });

  it('a shallower depth previews as genuinely shallower', async () => {
    const { buildPreviewSample } = await import('../../renderer/js/filler-preview.js');
    const spread = (min, max) => {
      const { actions } = buildPreviewSample({ pattern: 'sine', bpm: 30, min, max });
      return Math.max(...actions.map((a) => a.pos)) - Math.min(...actions.map((a) => a.pos));
    };
    expect(spread(35, 65)).toBeLessThan(spread(0, 100));
  });
});

describe('mergeFiller', () => {
  it('sorts filler into the authored timeline', () => {
    const authored = [{ at: 0, pos: 0 }, { at: 10000, pos: 100 }];
    const filler = [{ at: 5000, pos: 50, _filler: true }];
    expect(mergeFiller(authored, filler).map((a) => a.at)).toEqual([0, 5000, 10000]);
  });

  it('returns a copy when there is no filler', () => {
    const authored = [{ at: 0, pos: 0 }];
    const out = mergeFiller(authored, []);
    expect(out).toEqual(authored);
    expect(out[0]).not.toBe(authored[0]);
  });
});

describe('buildFillerActions guards', () => {
  it('returns nothing for a non-positive threshold', () => {
    expect(buildFillerActions(scriptWithMidGap(), { thresholdMs: 0 })).toEqual([]);
  });

  it('survives junk input', () => {
    expect(buildFillerActions(null, { thresholdMs: 5000 })).toEqual([]);
    expect(buildFillerActions(undefined, { thresholdMs: 5000 })).toEqual([]);
  });
});
