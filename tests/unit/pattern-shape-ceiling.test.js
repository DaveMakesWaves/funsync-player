/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// pf-review PF-R2 (2026-11-19, major): X and Z play every catalogue pattern
// under the library's hard 600 u/s ceiling (pattern-source.js maxSpeed); the
// simple shapes skipped it, so a Sine at the Speed slider's top sent legs of
// 880 u/s while the preview said "peak 600" (patternStats capped every leg).
// Now: every shape leg X / Z send stays under the ceiling in every band, but
// square's and sawtooth's instant edges (pf-engine decision 2) and an
// upgraded 11-17 Generated pattern's own rate (pf-engine decision 3, mark
// `legacyRate`, never stored); the stats report the legs as they are.
// Also PF-R7: a Generated pattern at 20-29 BPM in a band 1 unit wide (speed
// under 1 u/s) keeps its rate (the floor of 1 u/s played it at 30 BPM).
import { describe, it, expect, afterEach } from 'vitest';
import {
  choiceSource, renderPatternSample, patternStats, orgasmChoiceInUse, readPatternChoice, patternChoiceWrites,
  normalizePatternChoice, INSTANT_LEG_MS,
} from '../../renderer/js/pattern-choice.js';
import {
  patternSpeedBounds, clearPatternSourceCache, ORGASM_LIBRARY_DEFAULTS,
} from '../../renderer/js/pattern-source.js';
import { PATTERN_SPEED_CEILING } from '../../renderer/js/pattern-library.js';
import { SHAPE_IDS, shapeFastestLeg, renderShapeLoop } from '../../renderer/js/pattern-library-shapes.js';
import * as OLD from '../fixtures/pre-unify-engines/orgasm-pattern.js';

afterEach(() => clearPatternSourceCache());

const actionsOf = (src) => JSON.parse(src.content).actions;
/** Fastest leg in u/s; `skipEdges`: square's / sawtooth's 1 ms jumps left out. */
const fastest = (acts, skipEdges = false) => {
  let m = 0;
  for (let i = 1; i < acts.length; i++) {
    const dt = acts[i].at - acts[i - 1].at;
    if (!(dt > 0) || (skipEdges && dt <= 1)) continue;
    m = Math.max(m, (Math.abs(acts[i].pos - acts[i - 1].pos) / dt) * 1000);
  }
  return m;
};
const STROKING = ['shape-sine', 'shape-triangle', 'shape-escalating', 'shape-random'];
const EDGED = ['shape-square', 'shape-sawtooth'];

describe('a simple shape in X / Z keeps the 600 u/s ceiling (PF-R2)', () => {
  it('at the Speed slider\'s top, in its own range and in the bands that ran over', () => {
    const over = [];
    for (const id of [...STROKING, ...EDGED]) {
      const top = patternSpeedBounds(id).max;
      expect(top).toBe(600);
      for (const choice of [
        { rangeMode: 'own' },
        { rangeMode: 'exact', min: 0, max: 25 },
        { rangeMode: 'exact', min: 0, max: 33 },
        { rangeMode: 'exact', min: 40, max: 60 },
        { rangeMode: 'exact', min: 10, max: 90, reversed: true },
        { rangeMode: 'script', depthPct: 70 },
      ]) {
        const f = fastest(actionsOf(choiceSource({ id, speed: top, ...choice })), EDGED.includes(id));
        if (f > PATTERN_SPEED_CEILING) over.push(`${id} ${JSON.stringify(choice)}: ${f.toFixed(0)} u/s`);
      }
    }
    expect(over).toEqual([]);
  });

  it('every shape, every band width 0-100, a spread of speeds: no stroke leg over 600', () => {
    const over = [];
    for (const id of SHAPE_IDS) {
      for (let w = 0; w <= 100; w += 1) {
        for (const speed of [10, 120, 207, 350, 401, 480, 570, 600]) {
          const lo = w % 3 === 0 ? 0 : Math.floor((100 - w) / 2);
          const acts = renderShapeLoop(id, { speed, range: { min: lo, max: lo + w }, maxSpeed: PATTERN_SPEED_CEILING }).actions;
          const f = shapeFastestLeg(acts, id.slice(6));
          if (f > PATTERN_SPEED_CEILING) over.push(`${id} ${lo}-${lo + w} @${speed}: ${f.toFixed(0)}`);
        }
      }
    }
    expect(over).toEqual([]);
  }, 60000);

  it('the ceiling slows the loop, the band and the shape stay: a Sine at 600 still sweeps its whole band', () => {
    const src = choiceSource({ id: 'shape-sine', speed: 600, rangeMode: 'exact', min: 20, max: 80 });
    const acts = actionsOf(src);
    expect(Math.min(...acts.map((a) => a.pos))).toBe(20);
    expect(Math.max(...acts.map((a) => a.pos))).toBe(80);
    expect(fastest(acts)).toBeLessThanOrEqual(600);
    expect(fastest(acts)).toBeGreaterThan(450);   // slowed to the ceiling, not far under it
  });

  it('a speed the ceiling never reaches plays exactly as before (no ceiling pass at all)', () => {
    for (const id of SHAPE_IDS) {
      const capped = renderShapeLoop(id, { speed: 120, range: { min: 10, max: 90 }, maxSpeed: 600 }).actions;
      const free = renderShapeLoop(id, { speed: 120, range: { min: 10, max: 90 } }).actions;
      expect(capped, id).toEqual(free);
    }
  });

  it('square and sawtooth keep their instant 1 ms edges (pf-engine decision 2)', () => {
    for (const id of EDGED) {
      const acts = actionsOf(choiceSource({ id, speed: 120, rangeMode: 'own' }));
      const jumps = acts.filter((a, i) => i > 0 && a.at - acts[i - 1].at <= 1 && Math.abs(a.pos - acts[i - 1].pos) === 100);
      expect(jumps.length, id).toBeGreaterThan(0);
    }
  });
});

describe('the preview tells the truth (PF-R2)', () => {
  it('peak and average are the legs as they are, not capped at 600', () => {
    const acts = [{ at: 0, pos: 0 }, { at: 100, pos: 90 }, { at: 200, pos: 0 }];
    expect(patternStats(acts)).toEqual({ avg: 900, peak: 900, instant: 0 });
  });

  it('square / sawtooth in X and Z: the jumps are counted as instant, outside the average and the peak', () => {
    expect(INSTANT_LEG_MS).toBe(1);
    const sq = renderPatternSample({ id: 'shape-square', speed: 120, rangeMode: 'own' }, { durationMs: 8000, feature: 'edge' });
    const s = patternStats(sq.actions);
    expect(s.instant).toBeGreaterThan(0);
    expect(s.peak).toBe(0);
    const saw = patternStats(renderPatternSample({ id: 'shape-sawtooth', speed: 120, rangeMode: 'own' }, { durationMs: 8000, feature: 'orgasm' }).actions);
    expect(saw.instant).toBeGreaterThan(0);
    expect(saw.peak).toBeGreaterThan(0);
    expect(saw.peak).toBeLessThanOrEqual(120);
    // Gap Filler ramps them (its slew limiter): no instant jump in its preview.
    expect(patternStats(renderPatternSample({ id: 'shape-square', speed: 120 }, { durationMs: 8000, feature: 'gapFiller' }).actions).instant).toBe(0);
  });

  it('a Sine at the slider\'s top: the peak shown is the fastest leg sent', () => {
    const choice = { id: 'shape-sine', speed: 600, rangeMode: 'own' };
    const shown = patternStats(renderPatternSample(choice, { durationMs: 8000, feature: 'orgasm' }).actions);
    expect(shown.peak).toBe(Math.round(fastest(actionsOf(choiceSource(choice)))));
    expect(shown.peak).toBeLessThanOrEqual(600);
  });
});

describe('an upgraded 11-17 Generated pattern keeps its own rate (pf-engine decision 3), and only until it is changed', () => {
  const op = { enabled: true, type: 'sine', bpm: 150, min: 0, max: 100 };
  const player = { orgasmPattern: op, orgasmLibraryPattern: { ...ORGASM_LIBRARY_DEFAULTS } };

  it('plays exactly the 11-17 loop, legs over 600 and all, and its preview says so', () => {
    const choice = orgasmChoiceInUse(player);
    expect(choice.legacyRate).toBe(true);
    const src = choiceSource(choice);
    expect(src.content).toBe(OLD.buildOrgasmPatternContent(op));
    expect(src.key.endsWith('/g')).toBe(true);
    const legs = fastest(actionsOf(src));
    expect(legs).toBeGreaterThan(600);
    expect(patternStats(renderPatternSample(choice, { durationMs: 8000, feature: 'orgasm' }).actions).peak).toBe(Math.round(legs));
  });

  it('the mark is never stored; the same values as a stored (new) choice keep the ceiling, under another key', () => {
    const choice = readPatternChoice('orgasm', player);
    const [w] = patternChoiceWrites('orgasm', choice, player);
    expect(w.value).not.toHaveProperty('legacyRate');
    expect(JSON.stringify(w.value)).not.toContain('legacyRate');
    const stored = choiceSource(normalizePatternChoice(JSON.parse(JSON.stringify(w.value))));
    expect(fastest(actionsOf(stored))).toBeLessThanOrEqual(600);
    expect(stored.key).not.toBe(choiceSource(choice).key);
  });

  it('the mark sits only on a simple shape', () => {
    expect(normalizePatternChoice({ id: 'quick-full-strokes', legacyRate: true })).not.toHaveProperty('legacyRate');
    expect(normalizePatternChoice({ id: 'shape-sine', legacyRate: 'yes' })).not.toHaveProperty('legacyRate');
    expect(normalizePatternChoice({ id: 'shape-sine', legacyRate: true }).legacyRate).toBe(true);
  });
});

describe('PF-R7: a Generated pattern under 1 u/s keeps its strokes a minute', () => {
  it('Triangle 20 BPM over 33-34: the 11-17 loop, point for point', () => {
    for (const type of ['triangle', 'sine', 'escalating']) {
      for (const bpm of [20, 24, 29]) {
        const o = { enabled: true, type, bpm, min: 33, max: 34 };
        const src = choiceSource(orgasmChoiceInUse({ orgasmPattern: o }));
        expect(src.content, `${type} ${bpm}`).toBe(OLD.buildOrgasmPatternContent(o));
      }
    }
  });
});
