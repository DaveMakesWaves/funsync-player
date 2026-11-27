/**
 * @vitest-environment node
 * No DOM required: pattern-choice.js is pure. See notes/CLAUDE.md "Test environments" before changing this or
 * adding DOM here. (What the summary row DRAWS is checked in pattern-block-settings.test.js, on jsdom.)
 */
// The summary graph's window (TODO 2026-11-19, fixed 2026-11-20 for v0.10.1): the summary row under Gap Filler,
// Orgasm Switch and Edge Hold drew the first 4 s of the choice, so a pattern that builds up (the upgraded Crescendo,
// i.e. the Building quick pick: the escalating shape) drew a flat line. It now draws the whole pattern once: one
// loop of what X and Z play (an ending once through), 4-20 s, and for the Gap Filler its joins either side as well.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  representativeMs, renderPatternSample, resolveChoice, listQuickPicks, SUMMARY_MIN_MS, SUMMARY_MAX_MS,
} from '../../renderer/js/pattern-choice.js';
import { patternSourceLoop, clearPatternSourceCache } from '../../renderer/js/pattern-source.js';
import { joinReserveMs } from '../../renderer/js/filler-engine.js';

beforeEach(() => clearPatternSourceCache());

const NEUTRAL = { min: 0, max: 100 };
const BUILDING = listQuickPicks().find((q) => q.id === 'building').choice;
const loopOf = (choice) => patternSourceLoop(resolveChoice(choice, { scriptRange: NEUTRAL }));
/** The tops of the strokes, in order. */
function peaks(actions) {
  const out = [];
  for (let i = 1; i < actions.length - 1; i++) {
    if (actions[i].pos > actions[i - 1].pos && actions[i].pos >= actions[i + 1].pos) out.push(actions[i].pos);
  }
  return out;
}
const rising = (list) => list.every((v, i) => i === 0 || v > list[i - 1]);

describe('a pattern that builds up draws its build (it was a flat line)', () => {
  it('Building (Crescendo) in the Gap Filler: the strokes climb from low to the top across the window', () => {
    expect(BUILDING.id).toBe('shape-escalating');
    const ms = representativeMs(BUILDING, { feature: 'gapFiller', scriptRange: NEUTRAL });
    const s = renderPatternSample(BUILDING, { durationMs: ms, feature: 'gapFiller', scriptRange: NEUTRAL });
    const tops = peaks(s.actions);
    expect(tops.length).toBeGreaterThanOrEqual(4);
    expect(rising(tops)).toBe(true);
    expect(tops[0]).toBeLessThan(40);
    expect(tops.at(-1)).toBeGreaterThan(90);
  });

  it('Building in X and Z: the whole build of its loop, up to the top', () => {
    for (const feature of ['orgasm', 'edge']) {
      const ms = representativeMs(BUILDING, { feature, scriptRange: NEUTRAL });
      const tops = peaks(renderPatternSample(BUILDING, { durationMs: ms, feature, scriptRange: NEUTRAL }).actions);
      expect(rising(tops), feature).toBe(true);
      expect(tops.at(-1), feature).toBeGreaterThan(90);
    }
  });
});

describe('the window: the whole pattern once, 4-20 s', () => {
  it('X and Z: exactly one loop of what they play, so the graph ends where it starts', () => {
    for (const choice of [{ id: 'quick-full-strokes' }, { id: 'swelling-long-strokes-higher', speed: 120 }, { id: 'shape-sine', speed: 90 }]) {
      const loop = loopOf(choice);
      expect(loop.loopMs).toBeGreaterThan(SUMMARY_MIN_MS);
      expect(loop.loopMs).toBeLessThanOrEqual(SUMMARY_MAX_MS);
      for (const feature of ['orgasm', 'edge']) {
        const ms = representativeMs(choice, { feature, scriptRange: NEUTRAL });
        expect(ms, choice.id).toBe(loop.loopMs);
        const s = renderPatternSample(choice, { durationMs: ms, feature, scriptRange: NEUTRAL }).actions;
        expect(s.at(-1).at).toBe(loop.loopMs);
        expect(s.at(-1).pos).toBe(s[0].pos);
      }
    }
  });

  it('an ending: once through when it fits; one longer than 20 s shows its first 20 s', () => {
    const short = { id: 'plunge-finish' };
    expect(loopOf(short).once).toBe(true);
    expect(representativeMs(short, { feature: 'orgasm' })).toBe(loopOf(short).loopMs);
    const long = { id: 'slow-down-finish' };
    expect(loopOf(long).loopMs).toBeGreaterThan(SUMMARY_MAX_MS);
    expect(representativeMs(long, { feature: 'edge' })).toBe(SUMMARY_MAX_MS);
    expect(SUMMARY_MAX_MS).toBe(20000);
  });

  it('the Gap Filler: the same pattern between its joins (a reserve either side, from its join speed)', () => {
    const choice = { id: 'quick-full-strokes' };
    const body = loopOf(choice).loopMs;
    expect(representativeMs(choice, { feature: 'gapFiller' })).toBe(body + 2 * joinReserveMs(300));
    expect(representativeMs(choice, { feature: 'gapFiller', maxJoinSpeed: 150 })).toBe(body + 2 * joinReserveMs(150));
  });

  it('nothing chosen, or nothing that renders: the shortest window, 4 s', () => {
    expect(SUMMARY_MIN_MS).toBe(4000);
    expect(representativeMs({ id: null })).toBe(SUMMARY_MIN_MS);
    expect(representativeMs(null)).toBe(SUMMARY_MIN_MS);
    expect(representativeMs({ id: 'no-such-pattern' }, { feature: 'orgasm' })).toBe(SUMMARY_MIN_MS);
  });
});
