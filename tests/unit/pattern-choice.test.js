/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The one pattern choice for Gap Filler, X and Z (pattern settings
// unification, 2026-11-19; DESIGN-pattern-settings-unify.md §1, §4): the
// normaliser, the reads (new key first, else derived from the old keys), the
// writes (never an old key), the quick picks, range mode 'script', the
// finisher seam, the preview sample and its stats. The upgrade guarantees
// (old render = new render) are pattern-choice-upgrade.test.js.
import { describe, it, expect, afterEach } from 'vitest';
import {
  PATTERN_FEATURES, RANGE_MODES, EMPTY_CHOICE, CHOICE_KEYS, ORGASM_SOURCE_KEY, SCRIPT_WINDOW_MS,
  normalizePatternChoice, readPatternChoice, readOrgasmSource, orgasmChoiceInUse, patternChoiceWrites,
  orgasmSourceWrites, listQuickPicks, quickPickIdFor, sameChoice, scriptRangeAround, resolveChoice, choiceSource,
  resolveGapFillerOptions, renderPatternSample, patternStats,
} from '../../renderer/js/pattern-choice.js';
import { FILLER_PRESETS } from '../../renderer/js/filler-presets.js';
import { describePattern } from '../../renderer/js/pattern-library.js';
import { clearPatternSourceCache, patternSourceKey, buildPatternSourceContent } from '../../renderer/js/pattern-source.js';
import { computeSpeedStats } from '../../renderer/js/library-search.js';
import { shapeBpm } from '../../renderer/js/pattern-library-shapes.js';

afterEach(() => clearPatternSourceCache());

const KEYS = Object.keys(EMPTY_CHOICE);
/** Strokes (two turns each) a minute of an action list; holds and repeated positions are not turns. */
function strokesPerMinute(acts) {
  let turns = 0, dir = 0;
  for (let i = 1; i < acts.length; i++) {
    const d = Math.sign(acts[i].pos - acts[i - 1].pos);
    if (!d) continue;
    if (dir && d !== dir) turns++;
    dir = d;
  }
  return (turns / 2) / ((acts[acts.length - 1].at - acts[0].at) / 60000);
}

describe('normalizePatternChoice', () => {
  it('always gives every field, and nothing chosen when nothing (or junk) is given', () => {
    for (const raw of [undefined, null, 42, 'shape-sine', [], {}, { id: 'nope', speed: 50 }]) {
      const c = normalizePatternChoice(raw);
      expect(Object.keys(c)).toEqual(KEYS);
      expect(c).toEqual({ ...EMPTY_CHOICE });
    }
    expect(PATTERN_FEATURES).toEqual(['gapFiller', 'orgasm', 'edge']);
    expect(RANGE_MODES).toEqual(['own', 'exact', 'script']);
  });

  it('reads an old value without rangeMode as own (no range) or exact (a range)', () => {
    expect(normalizePatternChoice({ id: 'quick-full-strokes', min: null, max: null }).rangeMode).toBe('own');
    expect(normalizePatternChoice({ id: 'quick-full-strokes', min: 80, max: 20 })).toMatchObject({ rangeMode: 'exact', min: 20, max: 80 });
    // exact with no range cannot be exact
    expect(normalizePatternChoice({ id: 'quick-full-strokes', rangeMode: 'exact' }).rangeMode).toBe('own');
    // script with no depth follows the whole range
    expect(normalizePatternChoice({ id: 'shape-sine', rangeMode: 'script' })).toMatchObject({ depthPct: 100, centrePct: null });
    expect(normalizePatternChoice({ id: 'shape-sine', rangeMode: 'script', depthPct: 0, centrePct: 140 })).toMatchObject({ depthPct: 1, centrePct: 100 });
    expect(normalizePatternChoice({ id: 'shape-sine', rangeMode: 'nope', min: 3.4, max: 120 })).toMatchObject({ rangeMode: 'exact', min: 3, max: 100 });
  });

  it("keeps a shape's speed unrounded (1-1000 u/s); a catalogue pattern's whole and inside its slider", () => {
    expect(normalizePatternChoice({ id: 'shape-triangle', speed: 133.33333333333334 }).speed).toBe(133.33333333333334);
    expect(normalizePatternChoice({ id: 'shape-triangle', speed: 4000 }).speed).toBe(1000);
    expect(normalizePatternChoice({ id: 'shape-triangle', speed: 0 }).speed).toBeNull();
    expect(normalizePatternChoice({ id: 'shape-triangle', speed: '' }).speed).toBeNull();
    const d = describePattern('quick-full-strokes');
    expect(normalizePatternChoice({ id: 'quick-full-strokes', speed: 133.6 }).speed).toBe(134);
    expect(normalizePatternChoice({ id: 'quick-full-strokes', speed: 99999 }).speed).toBeLessThanOrEqual(600);
    expect(d.speed).toBeGreaterThan(0);
    expect(normalizePatternChoice({ id: 'shape-sine', reversed: 'yes' }).reversed).toBe(false);
    expect(normalizePatternChoice({ id: 'shape-sine', reversed: true }).reversed).toBe(true);
  });
});

describe('reading a feature\'s choice', () => {
  it('the new key wins whenever it is there', () => {
    const pattern = { id: 'slow-tip-strokes', speed: 80, reversed: true, rangeMode: 'script', depthPct: 50, centrePct: 70, min: null, max: null };
    const player = {
      gapFiller: { enabled: true, presetId: 'gentle', pattern },
      orgasmPattern: { enabled: true, type: 'square', bpm: 60, min: 0, max: 100 },
      orgasmPatternChoice: { id: 'shape-random', speed: 70 },
      edgePattern: { id: 'quick-full-strokes', speed: null, reversed: false, min: null, max: null },
      edgePatternChoice: { id: 'shape-sine', speed: 30, rangeMode: 'exact', min: 10, max: 30 },
    };
    expect(readPatternChoice('gapFiller', player)).toEqual(normalizePatternChoice(pattern));
    expect(readPatternChoice('orgasm', player)).toMatchObject({ id: 'shape-random', speed: 70, rangeMode: 'own' });
    expect(readPatternChoice('edge', player)).toMatchObject({ id: 'shape-sine', speed: 30, rangeMode: 'exact', min: 10, max: 30 });
    expect(readPatternChoice('nope', player)).toEqual({ ...EMPTY_CHOICE });
  });

  it('Gap Filler without `pattern`: the preset (or Custom) as the same shape following the script', () => {
    for (const p of FILLER_PRESETS) {
      const c = readPatternChoice('gapFiller', { gapFiller: { enabled: true, presetId: p.id, thresholdMs: 10000 } });
      expect(c).toMatchObject({ id: `shape-${p.pattern}`, rangeMode: 'script', depthPct: p.depthPct, centrePct: p.centrePct, reversed: false });
      expect(quickPickIdFor(c)).toBe(p.id);
    }
    // nothing stored at all, or an unknown preset: the default preset, as resolveFillerOptions reads it
    expect(quickPickIdFor(readPatternChoice('gapFiller', {}))).toBe('slowTease');
    expect(quickPickIdFor(readPatternChoice('gapFiller', { gapFiller: { presetId: 'gone' } }))).toBe('slowTease');
    expect(quickPickIdFor(readPatternChoice('gapFiller', { gapFiller: { presetId: 'custom' } }))).toBe('slowTease');
    const custom = readPatternChoice('gapFiller', { gapFiller: { presetId: 'custom', custom: { pattern: 'triangle', bpm: 50, depthPct: 70, absolute: null } } });
    expect(custom).toMatchObject({ id: 'shape-triangle', rangeMode: 'script', depthPct: 70 });
    expect(shapeBpm(custom.speed, 70)).toBe(50);
    const abs = readPatternChoice('gapFiller', { gapFiller: { presetId: 'custom', custom: { pattern: 'square', bpm: 13, depthPct: 35, absolute: { min: 20, max: 85 } } } });
    expect(abs).toMatchObject({ id: 'shape-square', rangeMode: 'exact', min: 20, max: 85 });
    expect(shapeBpm(abs.speed, 65)).toBe(13);
    expect(quickPickIdFor(abs)).toBe('custom');
  });

  it('X without its new keys: the source in use, as app.js played it', () => {
    const gen = { enabled: true, type: 'escalating', bpm: 90, min: 10, max: 70 };
    const lib = { enabled: true, id: 'slow-tip-strokes', speed: 70, reversed: true, min: 30, max: 90 };
    // the Generated pattern on: that shape, at the same strokes a minute, in its range
    const c1 = readPatternChoice('orgasm', { orgasmPattern: gen, orgasmLibraryPattern: { ...lib, enabled: false } });
    expect(c1).toMatchObject({ id: 'shape-escalating', rangeMode: 'exact', min: 10, max: 70, reversed: false });
    expect(shapeBpm(c1.speed, 60)).toBe(90);
    // both on (a hand-edited file): the Generated pattern won, and still does
    expect(readPatternChoice('orgasm', { orgasmPattern: gen, orgasmLibraryPattern: lib }).id).toBe('shape-escalating');
    // the library on: its pattern
    expect(readPatternChoice('orgasm', { orgasmPattern: { ...gen, enabled: false }, orgasmLibraryPattern: lib }))
      .toEqual(normalizePatternChoice({ id: 'slow-tip-strokes', speed: 70, reversed: true, rangeMode: 'exact', min: 30, max: 90 }));
    // the library on with nothing chosen: nothing (the file played), even with a changed Generated pattern stored
    expect(readPatternChoice('orgasm', { orgasmPattern: { ...gen, enabled: false }, orgasmLibraryPattern: { ...lib, id: null } }).id).toBeNull();
    // the file in use: what the block shows: the picked library pattern, else a changed Generated pattern, else none
    expect(readPatternChoice('orgasm', { orgasmPattern: { ...gen, enabled: false }, orgasmLibraryPattern: { ...lib, enabled: false } }).id).toBe('slow-tip-strokes');
    expect(readPatternChoice('orgasm', { orgasmPattern: { ...gen, enabled: false } }).id).toBe('shape-escalating');
    expect(readPatternChoice('orgasm', { orgasmPattern: { enabled: false, type: 'sine', bpm: 120, min: 0, max: 100 } }).id).toBeNull();
    expect(readPatternChoice('orgasm', {}).id).toBeNull();
  });

  it('Z without its new key: edgePattern as it was (no pattern chosen stays none)', () => {
    expect(readPatternChoice('edge', { edgePattern: { id: 'quick-full-strokes', speed: 210, reversed: true, min: null, max: null } }))
      .toEqual({ ...EMPTY_CHOICE, id: 'quick-full-strokes', speed: 210, reversed: true });
    expect(readPatternChoice('edge', { edgePattern: { id: null, speed: 90 } }).id).toBeNull();
    expect(readPatternChoice('edge', {}).id).toBeNull();
  });

  it("X's source: the new key, else on when the Generated pattern or the library source was on", () => {
    expect(readOrgasmSource({})).toBe('file');
    expect(readOrgasmSource(null)).toBe('file');
    expect(readOrgasmSource({ orgasmPattern: { enabled: true } })).toBe('pattern');
    expect(readOrgasmSource({ orgasmLibraryPattern: { enabled: true } })).toBe('pattern');
    expect(readOrgasmSource({ orgasmPattern: { enabled: 'true' } })).toBe('file');
    expect(readOrgasmSource({ orgasmSource: 'file', orgasmPattern: { enabled: true } })).toBe('file');
    expect(readOrgasmSource({ orgasmSource: 'pattern' })).toBe('pattern');
    expect(readOrgasmSource({ orgasmSource: 'library', orgasmPattern: { enabled: true } })).toBe('pattern'); // junk ignored
    // in use only with a pattern chosen; else the file plays
    expect(orgasmChoiceInUse({ orgasmSource: 'pattern' })).toBeNull();
    expect(orgasmChoiceInUse({ orgasmSource: 'file', orgasmPatternChoice: { id: 'shape-sine' } })).toBeNull();
    expect(orgasmChoiceInUse({ orgasmSource: 'pattern', orgasmPatternChoice: { id: 'shape-sine' } }).id).toBe('shape-sine');
  });
});

describe('writing a choice', () => {
  it('writes only the feature\'s new key, normalised; never an old key', () => {
    const player = { gapFiller: { enabled: true, presetId: 'pulse', custom: { pattern: 'sine', bpm: 20 } }, orgasmPattern: { enabled: true } };
    const choice = { id: 'shape-sine', speed: 55, rangeMode: 'script', depthPct: 40, junk: 1 };
    // pf-fixup (PF-R6): each value also carries `basis`, the fingerprint of the old keys it was written over.
    const basis = expect.stringMatching(/^b1:[0-9a-f]{8}$/);
    expect(patternChoiceWrites('gapFiller', choice, player)).toEqual([{ key: 'player.gapFiller.pattern', value: { ...normalizePatternChoice(choice), basis } }]);
    expect(patternChoiceWrites('orgasm', choice, player)).toEqual([{ key: 'player.orgasmPatternChoice', value: { ...normalizePatternChoice(choice), basis } }]);
    expect(patternChoiceWrites('edge', choice, player)).toEqual([{ key: 'player.edgePatternChoice', value: { ...normalizePatternChoice(choice), basis } }]);
    expect(patternChoiceWrites('nope', choice, player)).toEqual([]);
    expect(orgasmSourceWrites('pattern')).toEqual([{ key: ORGASM_SOURCE_KEY, value: 'pattern' }]);
    expect(orgasmSourceWrites('library')).toEqual([{ key: ORGASM_SOURCE_KEY, value: 'file' }]);
    const old = ['player.gapFiller.presetId', 'player.gapFiller.custom', 'player.gapFiller', 'player.orgasmPattern', 'player.orgasmLibraryPattern', 'player.edgePattern', 'player.edgeHoldAction'];
    const all = [...PATTERN_FEATURES.flatMap((f) => patternChoiceWrites(f, choice, player)), ...orgasmSourceWrites('pattern')].map((w) => w.key);
    for (const k of all) for (const o of old) expect(k === o || o.startsWith(`${k}.`), `${k} touches ${o}`).toBe(false);
    expect(Object.values(CHOICE_KEYS)).toEqual(all.slice(0, 3));
  });
});

describe('quick picks', () => {
  it("are Gap Filler's presets, in units a second, the same strokes a minute on a whole-range script", () => {
    const picks = listQuickPicks();
    expect(picks.map((q) => q.id)).toEqual(FILLER_PRESETS.map((p) => p.id));
    expect(picks.map((q) => q.labelKey)).toEqual(FILLER_PRESETS.map((p) => p.labelKey));
    expect(picks.map((q) => Math.round(q.choice.speed * 100) / 100)).toEqual([40, 80, 133.33, 116.67, 50, 50]);
    for (const [i, q] of picks.entries()) {
      const p = FILLER_PRESETS[i];
      expect(Object.keys(q.choice)).toEqual(KEYS);
      expect(q.choice).toMatchObject({ id: `shape-${p.pattern}`, rangeMode: 'script', depthPct: p.depthPct, centrePct: p.centrePct });
      expect(shapeBpm(q.choice.speed, p.depthPct)).toBe(p.bpm);
      expect(quickPickIdFor(q.choice)).toBe(q.id);
    }
  });

  it('anything changed by hand is Custom; a slider landing within half a unit is still the pick', () => {
    const steady = listQuickPicks().find((q) => q.id === 'steady').choice;
    expect(quickPickIdFor({ ...steady, speed: 133 })).toBe('steady');
    expect(quickPickIdFor({ ...steady, speed: 134 })).toBe('custom');
    expect(quickPickIdFor({ ...steady, reversed: true })).toBe('custom');
    expect(quickPickIdFor({ ...steady, depthPct: 95 })).toBe('custom');
    expect(quickPickIdFor({ ...steady, rangeMode: 'own' })).toBe('custom');
    expect(quickPickIdFor({ ...EMPTY_CHOICE })).toBe('custom');
    expect(sameChoice({ id: 'shape-sine', rangeMode: 'exact', min: 1, max: 2 }, { id: 'shape-sine', min: 1, max: 2 })).toBe(true);
  });
});

describe("range mode 'script' and the finisher", () => {
  it('measures the script around now (30 s either side), else the whole script, else none', () => {
    expect(SCRIPT_WINDOW_MS).toBe(30000);
    const acts = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 60000, pos: 40 }, { at: 61000, pos: 60 }, { at: 200000, pos: 10 }];
    expect(scriptRangeAround(acts, 60500)).toEqual({ min: 40, max: 60 });
    expect(scriptRangeAround(acts, 500)).toEqual({ min: 0, max: 100 });
    expect(scriptRangeAround(acts, 200000)).toEqual({ min: 0, max: 100 }); // one point near: the whole script
    expect(scriptRangeAround([], 0)).toBeNull();
    expect(scriptRangeAround(null, 0)).toBeNull();
  });

  it('squeezes the pattern into the script\'s band with the timing it has on a whole-range script', () => {
    const c = { id: 'shape-sine', speed: 80, rangeMode: 'script', depthPct: 60 };
    expect(resolveChoice(c)).toEqual({ id: 'shape-sine', speed: 80, reversed: false, min: 20, max: 80 });
    const narrow = resolveChoice(c, { scriptRange: { min: 40, max: 60 } });
    expect(narrow).toMatchObject({ min: 44, max: 56 });
    expect(narrow.speed).toBeCloseTo(80 * 12 / 60, 9);
    // same strokes a minute on both scripts
    const wide = choiceSource(c).loop.actions, tight = choiceSource(c, { scriptRange: { min: 40, max: 60 } }).loop.actions;
    expect(Math.abs(strokesPerMinute(tight) / strokesPerMinute(wide) - 1)).toBeLessThan(0.02);
    expect(resolveChoice({ id: 'shape-sine', rangeMode: 'own', speed: 30 })).toMatchObject({ min: null, max: null, speed: 30 });
    expect(resolveChoice({ id: null })).toBeNull();
  });

  it("choiceSource is the seam X and Z play: a synthetic key, the loop's JSON, an ending's once", () => {
    const src = choiceSource({ id: 'quick-full-strokes', speed: 200, rangeMode: 'exact', min: 10, max: 90 });
    const p = { id: 'quick-full-strokes', speed: 200, reversed: false, min: 10, max: 90 };
    expect(src.key).toBe(patternSourceKey(p));
    expect(src.content).toBe(buildPatternSourceContent(p));
    expect(src.once).toBe(false);
    expect(choiceSource({ id: 'sprint-finish' }).once).toBe(true);
    expect(choiceSource({ id: null })).toBeNull();
  });
});

describe('the Gap Filler engine options', () => {
  it('a shape gives the fields resolveFillerOptions gave (same BPM), and reversed', () => {
    const o = resolveGapFillerOptions({ enabled: true, presetId: 'steady', thresholdMs: 10000 }, { enabled: true, totalDurationMs: 5000 });
    expect(o).toMatchObject({ enabled: true, thresholdMs: 10000, totalDurationMs: 5000, pattern: 'triangle', bpm: 40, depthPct: 100, centrePct: null, absoluteDepth: null, reversed: false });
    const ex = resolveGapFillerOptions({ pattern: { id: 'shape-square', speed: 100, rangeMode: 'exact', min: 20, max: 70, reversed: true } });
    expect(ex).toMatchObject({ pattern: 'square', bpm: 60, absoluteDepth: { min: 20, max: 70 }, reversed: true });
    expect(resolveGapFillerOptions({ pattern: { id: 'shape-sine', speed: 100 } })).toMatchObject({ pattern: 'sine', bpm: 30, absoluteDepth: { min: 0, max: 100 } });
  });

  it('a catalogue pattern gives `library`; nothing chosen turns the filler off', () => {
    const o = resolveGapFillerOptions({ enabled: true, pattern: { id: 'slow-tip-strokes', rangeMode: 'script', depthPct: 50 } }, { enabled: true });
    expect(o.library).toMatchObject({ id: 'slow-tip-strokes', rangeMode: 'script', depthPct: 50 });
    expect(o.pattern).toBeUndefined();
    expect(resolveGapFillerOptions({ enabled: true, pattern: { id: null } }, { enabled: true }).enabled).toBe(false);
  });
});

describe('the preview sample and its stats', () => {
  it('X / Z: the loop laid end to end over 8 s; an ending once, then held', () => {
    const s = renderPatternSample({ id: 'shape-sine', speed: 200 });
    expect(s.warnings).toEqual([]);
    expect(s.actions[0].at).toBe(0);
    expect(s.actions[s.actions.length - 1].at).toBeLessThanOrEqual(8000);
    expect(s.actions[s.actions.length - 1].at).toBeGreaterThan(7500);
    const once = renderPatternSample({ id: 'sprint-finish' }, { durationMs: 60000 });
    expect(once.actions[once.actions.length - 1].at).toBe(60000);
    expect(once.actions[once.actions.length - 1].pos).toBe(once.actions[once.actions.length - 2].pos);
    expect(renderPatternSample({ id: null })).toEqual({ actions: [], warnings: [{ code: 'no-pattern' }] });
  });

  it('a range too narrow says so (renderLoop\'s range-widened, with the band it plays)', () => {
    const s = renderPatternSample({ id: 'mixed-flutters-tip', rangeMode: 'exact', min: 50, max: 50 });
    expect(s.warnings.some((w) => w.code === 'range-widened' && Array.isArray(w.values.to))).toBe(true);
  });

  it('Gap Filler: an 8 s gap with a neighbour either side; square ramped at the join speed, joins under it', () => {
    const s = renderPatternSample({ id: 'shape-square', speed: 50, rangeMode: 'script', depthPct: 60 }, { feature: 'gapFiller' });
    expect(s.actions.length).toBeGreaterThan(4);
    // the slew limiter's 50 ms steps, positions rounded to whole units: within a unit a step of the 300 u/s limit
    for (let i = 1; i < s.actions.length; i++) {
      const dt = s.actions[i].at - s.actions[i - 1].at;
      expect((Math.abs(s.actions[i].pos - s.actions[i - 1].pos) / dt) * 1000).toBeLessThanOrEqual(320);
    }
    expect(s.actions.some((q, i) => i > 0 && q.at - s.actions[i - 1].at > 1 && Math.abs(q.pos - s.actions[i - 1].pos) >= 10)).toBe(true);
    const lib = renderPatternSample({ id: 'quick-full-strokes', rangeMode: 'script', depthPct: 60 }, { feature: 'gapFiller', maxJoinSpeed: 150 });
    const a = lib.actions;
    expect(a.length).toBeGreaterThan(4);
    expect(a.every((q) => q.at > 0 && q.at < 8000)).toBe(true);
    // the move in and the landing (from / to the neighbours at the band's middle) at no more than 150 u/s
    expect((Math.abs(a[0].pos - 50) / a[0].at) * 1000).toBeLessThanOrEqual(150.5);
    expect((Math.abs(50 - a[a.length - 1].pos) / (8000 - a[a.length - 1].at)) * 1000).toBeLessThanOrEqual(150.5);
  });

  it('patternStats: the mean and fastest leg as the Gap Filler preview measured them; an instant edge is counted as a jump (PF-R2)', () => {
    const acts = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 100 }, { at: 2500, pos: 0 }];
    expect(patternStats(acts)).toEqual({ avg: 150, peak: 200, instant: 0 });
    expect(computeSpeedStats(acts)).toEqual({ avgSpeed: 150, maxSpeed: 200 });
    // pf-fixup: no longer "600" (the 600 cap hid an 880 u/s sine): a 1 ms edge has no speed to show.
    expect(patternStats([{ at: 0, pos: 0 }, { at: 1, pos: 100 }])).toEqual({ avg: 0, peak: 0, instant: 1 });
    expect(patternStats([])).toEqual({ avg: 0, peak: 0, instant: 0 });
    expect(patternStats(null)).toEqual({ avg: 0, peak: 0, instant: 0 });
  });
});
