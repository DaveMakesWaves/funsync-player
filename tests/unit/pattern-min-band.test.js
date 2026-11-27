/**
 * @vitest-environment node
 * No DOM required: the engine, pattern-source.js, pattern-choice.js and the fillers are pure. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Lowest = Highest gave a pattern that did not move, and no note (device session 2026-11-20, step 35; fix
// 2026-11-20 for v0.10.1). X / Z on Mixed flutters at the tip at its slowest speed (38 u/s) with Lowest = Highest
// = 22 played a 10-point loop in 21-23: the Handy (stroke zone 35-65) read a flat 46 mm, and neither the drawer
// nor the summary said anything. renderLoop accepted any loop of 3 points or more, and the engine draws a band
// under 2 units 2 units wide, so the 11-17 widening never started. Now a range under MIN_LOOP_BAND (5 units) is
// widened about its middle to 5 units, a loop must move at least 4 units, and the loop says which band it plays.
// What is asserted is what the devices get: the Handy's tiled upload interpolated over the loop, the Gap Filler's
// points, and the band the note names.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderLoop, renderPattern, MIN_LOOP_BAND, widenBand } from '../../renderer/js/pattern-library.js';
import {
  patternSourceLoop, buildPatternSourceContent, patternSpeedBounds, clearPatternSourceCache,
} from '../../renderer/js/pattern-source.js';
import { renderPatternSample, choiceSource, widenedBand } from '../../renderer/js/pattern-choice.js';
import { buildLibraryFillerActions } from '../../renderer/js/filler-pattern.js';
import { fillRange } from '../../renderer/js/pattern-fill.js';
import { tileFinisherContent } from '../../renderer/js/orgasm-handy-engage.js';
import { interpolatePosition } from '../../renderer/js/handy-hdsp-sync.js';

beforeEach(() => clearPatternSourceCache());

const FLUTTER = 'mixed-flutters-tip';
const SLOWEST = patternSpeedBounds(FLUTTER).min;
/** pattern-library.js MIN_LOOP_BAND, as a number: these cases then fail on what plays if the minimum is taken out. */
const MIN_BAND = 5;
/** mm a unit of the 0-100 range moves the Handy with a 35-65 stroke zone: 30 % of its ~110 mm travel. */
const MM_PER_UNIT_35_65 = (0.3 * 110) / 100;

/** What the Handy is commanded over one loop: the tiled upload, interpolated every 20 ms. */
function commanded(pattern) {
  const loop = patternSourceLoop(pattern);
  const tiled = JSON.parse(tileFinisherContent(buildPatternSourceContent(pattern))).actions;
  const out = [];
  for (let t = 0; t <= loop.loopMs; t += 20) out.push(interpolatePosition(tiled, t));
  return out;
}
/** How many times a position track turns (a flutter turns many times a loop; a flat line never). */
function turns(track) {
  let n = 0, dir = 0;
  for (let i = 1; i < track.length; i++) {
    const d = Math.sign(track[i] - track[i - 1]);
    if (!d) continue;
    if (dir && d !== dir) n++;
    dir = d;
  }
  return n;
}
const spanOf = (list) => Math.max(...list) - Math.min(...list);

describe('Lowest = Highest on Mixed flutters at the tip (Dave\'s step 35)', () => {
  it('at its slowest speed the Handy is driven through a flutter 5 units wide (it was a 2-unit loop: a flat 46 mm)', () => {
    expect(SLOWEST).toBe(38);
    for (const reversed of [false, true]) {
      const track = commanded({ id: FLUTTER, speed: SLOWEST, reversed, min: 22, max: 22 });
      expect(spanOf(track), `reversed ${reversed}`).toBeGreaterThanOrEqual(MIN_BAND - 1);
      // ~1.3 mm or more on Dave's stroke zone (a 2-unit loop was ~0.7 mm, and read flat)
      expect(spanOf(track) * MM_PER_UNIT_35_65).toBeGreaterThan(1.3);
      expect(turns(track), `reversed ${reversed}`).toBeGreaterThanOrEqual(20);
      for (const p of track) {
        expect(p).toBeGreaterThanOrEqual(20);
        expect(p).toBeLessThanOrEqual(25);
      }
    }
  });

  it('says it was widened, and to which band: the band it plays (the drawer and the summary name it)', () => {
    const loop = patternSourceLoop({ id: FLUTTER, speed: SLOWEST, min: 22, max: 22 });
    expect(loop.warnings).toEqual([{ code: 'range-widened', values: { from: [22, 22], to: [20, 25] } }]);
    const choice = { id: FLUTTER, speed: SLOWEST, rangeMode: 'exact', min: 22, max: 22 };
    for (const feature of ['orgasm', 'edge', 'gapFiller']) {
      const s = renderPatternSample(choice, { durationMs: 8000, feature });
      expect(widenedBand(choice, s.warnings, s.actions), feature).toEqual([20, 25]);
    }
    // X's and Z's finisher is that loop
    expect(choiceSource(choice).loop).toBe(patternSourceLoop({ id: FLUTTER, speed: SLOWEST, min: 22, max: 22 }));
  });

  it('20-25 is left as set (Dave saw it move: a 59-point flutter), and no note', () => {
    for (const speed of [SLOWEST, null]) {
      const loop = patternSourceLoop({ id: FLUTTER, speed, min: 20, max: 25 });
      expect(loop.warnings).toEqual([]);
      expect(spanOf(loop.actions.map((a) => a.pos))).toBeGreaterThanOrEqual(MIN_BAND - 1);
    }
    const choice = { id: FLUTTER, speed: SLOWEST, rangeMode: 'exact', min: 20, max: 25 };
    const s = renderPatternSample(choice, { durationMs: 8000 });
    expect(widenedBand(choice, s.warnings, s.actions)).toBeNull();
  });

  it('the Gap Filler with that range fills a gap with a flutter, not a still line', () => {
    const script = [{ at: 0, pos: 10 }, { at: 1000, pos: 90 }, { at: 21000, pos: 10 }, { at: 22000, pos: 90 }];
    const filler = buildLibraryFillerActions(script, [{ startMs: 1000, endMs: 21000 }], {
      library: { id: FLUTTER, speed: SLOWEST, reversed: false, rangeMode: 'exact', min: 22, max: 22 },
    });
    // the body, away from the joins (a reserve of 334 ms at 300 u/s either side)
    const body = filler.filter((a) => a.at > 2000 && a.at < 20000).map((a) => a.pos);
    expect(spanOf(body)).toBeGreaterThanOrEqual(MIN_BAND - 1);
    expect(turns(body)).toBeGreaterThanOrEqual(20);
  });
});

describe('the minimum band', () => {
  it('is 5 units, about the asked middle, whole numbers inside 0-100', () => {
    expect(MIN_LOOP_BAND).toBe(MIN_BAND);
    expect(widenBand(22, 22)).toEqual([20, 25]);
    expect(widenBand(21, 23)).toEqual([20, 25]);
    expect(widenBand(0, 0)).toEqual([0, 5]);
    expect(widenBand(100, 100)).toEqual([95, 100]);
    expect(widenBand(98, 99)).toEqual([95, 100]);
    expect(widenBand(1, 2)).toEqual([0, 5]);
    // wide enough: as given
    expect(widenBand(20, 25)).toEqual([20, 25]);
    expect(widenBand(30.5, 70.5)).toEqual([30.5, 70.5]);
    for (let lo = 0; lo <= 100; lo++) {
      for (const w of [0, 1, 2, 3, 4]) {
        if (lo + w > 100) continue;
        const [a, b] = widenBand(lo, lo + w);
        expect(b - a, `${lo}-${lo + w}`).toBe(5);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(100);
        expect(a <= lo && b >= lo + w, `${lo}-${lo + w} inside ${a}-${b}`).toBe(true);
      }
    }
  });

  it('a band that is wide enough but does not move the pattern is widened too, and says so', () => {
    // Uneven tip strokes, reversed at 191 u/s, in 20-25: 13 points that spread 1 unit (found with this fix).
    const loop = renderLoop('uneven-tip-strokes', { speed: 191, reversed: true, range: { min: 20, max: 25 }, maxSpeed: 600 });
    const w = loop.warnings.find((x) => x.code === 'range-widened');
    expect(w.values.from).toEqual([20, 25]);
    expect(w.values.to[1] - w.values.to[0]).toBeGreaterThan(5);
    expect(spanOf(loop.actions.map((a) => a.pos))).toBeGreaterThanOrEqual(MIN_BAND - 1);
  });

  it('a range that is not given is the pattern\'s own place, as before (no widening, no note)', () => {
    for (const id of ['quick-full-strokes', FLUTTER]) {
      expect(renderLoop(id, {}).warnings).toEqual([]);
      expect(renderLoop(id, { range: { min: null, max: null } }).warnings).toEqual([]);
    }
  });

  it('the simple shapes still play the band as set (as the Generated pattern did; PF-R7 holds the old loop)', () => {
    const flat = renderLoop('shape-sine', { speed: 60, range: { min: 22, max: 22 } });
    expect(flat.warnings).toEqual([]);
    expect(new Set(flat.actions.map((a) => a.pos))).toEqual(new Set([22]));
  });
});

describe('the editor\'s pattern fill is not a loop: it keeps its own rule', () => {
  it('Lowest = Highest fills the 2-unit band it always drew and warns (the drawer says "range adjusted")', () => {
    const res = fillRange({
      actions: [{ at: 0, pos: 50 }, { at: 10000, pos: 50 }],
      selection: { startMs: 0, endMs: 10000 },
      patternId: FLUTTER,
      options: { mode: 'replace', range: { min: 22, max: 22 }, speed: SLOWEST, seed: 1 },
    });
    expect(res.inserted.length).toBeGreaterThan(2);
    expect(res.warnings.map((w) => w.code)).toContain('range-clipped');
    // the render the editor's fill draws from: unchanged by the loop's minimum
    const r = renderPattern(FLUTTER, { durationMs: 10000, range: { min: 22, max: 22 }, speed: SLOWEST });
    expect(r.warnings.find((w) => w.code === 'range-clipped').values.to).toEqual([21, 23]);
  });
});
