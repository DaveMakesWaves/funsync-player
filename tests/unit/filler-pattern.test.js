/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Gap Filler with a pattern from the library (pattern settings unification,
// 2026-11-19; DESIGN-pattern-settings-unify.md §5): today's guarantees hold
// for every library pattern: the joins never pass the join speed, every
// point strictly inside its gap, a gap too short is left alone, a trailing
// gap eases to rest, an ending plays once and holds; inside the gap the
// pattern-fill core's limits (minimum legs, the 600 u/s ceiling); range mode
// 'script' squeezes the pattern into the script's band with the same timing;
// and a 1 h script with 50 gaps stays fast.
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildLibraryGapFiller, buildLibraryFillerActions, patternWindow, depthBand, scriptBandSpeed, NEUTRAL_RANGE,
} from '../../renderer/js/filler-pattern.js';
import { resolveDepth, joinReserveMs } from '../../renderer/js/filler-engine.js';
import { detectGaps } from '../../renderer/js/gap-filler.js';
import { listPatterns, describePattern, PATTERN_SPEED_CEILING } from '../../renderer/js/pattern-library.js';
import { clearPatternSourceCache, patternSourceLoop } from '../../renderer/js/pattern-source.js';

afterEach(() => clearPatternSourceCache());

const CATALOGUE = listPatterns().filter((p) => p.family !== 'simple-shapes').map((p) => p.id);
const legSpeed = (a, b) => (Math.abs(b.pos - a.pos) / (b.at - a.at)) * 1000;

/** Every hard rule of one gap's filler. */
function gapProblems(fill, gap, before, after, join) {
  const out = [];
  if (!fill.length) return out;
  for (const a of fill) {
    if (!(a.at > gap.startMs && a.at < gap.endMs)) out.push(`outside the gap at ${a.at}`);
    if (a._filler !== true) out.push(`unmarked at ${a.at}`);
    if (!Number.isInteger(a.at) || !Number.isInteger(a.pos) || a.pos < 0 || a.pos > 100) out.push(`bad ${JSON.stringify(a)}`);
  }
  if (before != null && legSpeed({ at: gap.startMs, pos: before }, fill[0]) > join + 0.5) out.push(`move in at ${legSpeed({ at: gap.startMs, pos: before }, fill[0]).toFixed(0)}`);
  if (after != null && legSpeed(fill[fill.length - 1], { at: gap.endMs, pos: after }) > join + 0.5) out.push(`landing at ${legSpeed(fill[fill.length - 1], { at: gap.endMs, pos: after }).toFixed(0)}`);
  for (let i = 1; i < fill.length; i++) {
    const dt = fill[i].at - fill[i - 1].at;
    if (dt < 50) out.push(`leg ${i} is ${dt} ms`);
    else if (legSpeed(fill[i - 1], fill[i]) > PATTERN_SPEED_CEILING + 0.5) out.push(`leg ${i} at ${legSpeed(fill[i - 1], fill[i]).toFixed(0)} u/s`);
  }
  return out;
}

describe('one gap with a library pattern', () => {
  it('every catalogue pattern: joins at no more than the join speed, inside the gap, within the core\'s limits', { timeout: 60000 }, () => {
    const problems = [];
    let filled = 0;
    for (const id of CATALOGUE) {
      for (const [before, after, join] of [[0, 100, 300], [100, 0, 150], [50, 50, 600]]) {
        const gap = { startMs: 5000, endMs: 19000 };
        const fill = buildLibraryGapFiller(gap, before, after, { pattern: { id, speed: null, reversed: id.length % 2 === 0, min: null, max: null }, maxJoinSpeed: join });
        if (fill.length) filled++;
        const p = gapProblems(fill, gap, before, after, join);
        if (p.length) problems.push(`${id} ${before}->${after} @${join}: ${p.slice(0, 3).join('; ')}`);
      }
    }
    expect(problems).toEqual([]);
    expect(filled).toBe(CATALOGUE.length * 3);
  });

  it('keeps the reserve at a joined edge only, and refuses a gap too short for 800 ms of pattern', () => {
    const p = { id: 'quick-full-strokes', speed: null, reversed: false, min: null, max: null };
    const reserve = joinReserveMs(300);
    const fill = buildLibraryGapFiller({ startMs: 0, endMs: 10000 }, 20, 80, { pattern: p });
    expect(fill[0].at).toBeGreaterThanOrEqual(reserve);
    expect(fill[fill.length - 1].at).toBeLessThanOrEqual(10000 - reserve);
    // a leading gap has nothing to join: the pattern's window starts at the gap's start (its point AT the start is
    // left out: strictly inside the gap)
    const lead = buildLibraryGapFiller({ startMs: 0, endMs: 10000 }, null, 80, { pattern: p });
    expect(lead.map((a) => ({ at: a.at, pos: a.pos }))).toEqual(patternWindow(p, 0, 10000 - reserve).filter((a) => a.at > 0));
    // too short: left alone (today's "refuse rather than lurch")
    expect(buildLibraryGapFiller({ startMs: 0, endMs: 2 * reserve + 799 }, 20, 80, { pattern: p })).toEqual([]);
    expect(buildLibraryGapFiller({ startMs: 0, endMs: 2 * reserve + 1400 }, 20, 80, { pattern: p }).length).toBeGreaterThan(0);
  });

  it('a trailing gap is filled to the end of the video (FT-113), and any ease to rest keeps the join speed', () => {
    const p = { id: 'quick-full-strokes', speed: null, reversed: false, min: 30, max: 90 };
    const fill = buildLibraryGapFiller({ startMs: 0, endMs: 12000 }, 50, null, { pattern: p, maxJoinSpeed: 200, restPos: 30 });
    expect(fill[fill.length - 1].at).toBeGreaterThan(12000 - describePattern(p.id).strokeMs);
    expect(gapProblems(fill, { startMs: 0, endMs: 12000 }, 50, null, 200)).toEqual([]);
    // a pattern that stops short of the end (an ending) eases down to rest at no more than the join speed
    const end = listPatterns({ loopable: false })[0].id;
    const f2 = buildLibraryGapFiller({ startMs: 0, endMs: 60000 }, 50, null, { pattern: { id: end, speed: null, reversed: false, min: 30, max: 90 }, maxJoinSpeed: 200, restPos: 30 });
    expect(gapProblems(f2, { startMs: 0, endMs: 60000 }, 50, null, 200)).toEqual([]);
  });

  it('an ending plays once from the start of the window, then holds its last position', () => {
    const id = listPatterns({ loopable: false })[0].id;
    const gap = { startMs: 1000, endMs: 61000 };
    const fill = buildLibraryGapFiller(gap, 50, 50, { pattern: { id, speed: null, reversed: false, min: null, max: null } });
    const once = patternSourceLoop({ id });
    expect(once.once).toBe(true);
    // the end of the shape is held until the landing
    const lastMove = fill.findLastIndex((a, i) => i > 0 && a.pos !== fill[i - 1].pos);
    expect(fill[fill.length - 1].at - fill[lastMove].at).toBeGreaterThan(30000);
    expect(gapProblems(fill, gap, 50, 50, 300)).toEqual([]);
  });

  it('refuses a simple shape (filler-engine.js draws those) and an unknown or missing pattern', () => {
    const gap = { startMs: 0, endMs: 20000 };
    expect(buildLibraryGapFiller(gap, 0, 0, { pattern: { id: 'shape-sine' } })).toEqual([]);
    expect(buildLibraryGapFiller(gap, 0, 0, { pattern: { id: 'nope' } })).toEqual([]);
    expect(buildLibraryGapFiller(gap, 0, 0, {})).toEqual([]);
    expect(patternWindow({ id: 'nope' }, 0, 5000)).toEqual([]);
  });
});

describe("range mode 'script' for the filler", () => {
  it('depthBand is resolveDepth\'s arithmetic', () => {
    const scripts = [
      [{ at: 0, pos: 20 }, { at: 1, pos: 80 }],
      [{ at: 0, pos: 40 }, { at: 1, pos: 55 }],
      [{ at: 0, pos: 0 }, { at: 1, pos: 100 }],
      [{ at: 0, pos: 50 }, { at: 1, pos: 50 }],
    ];
    for (const acts of scripts) {
      const natural = { min: Math.min(...acts.map((a) => a.pos)), max: Math.max(...acts.map((a) => a.pos)) };
      for (const depthPct of [10, 35, 60, 100]) {
        for (const centrePct of [null, 0, 25, 80, 100]) {
          expect(depthBand(natural, depthPct, centrePct)).toEqual(resolveDepth(acts, { depthPct, centrePct }));
        }
      }
    }
  });

  it('squeezes the pattern into the band with the timing it has on a whole-range script', () => {
    const c = { id: 'quick-full-strokes', speed: 200, depthPct: 60, centrePct: null };
    expect(scriptBandSpeed(c, depthBand(NEUTRAL_RANGE, 60))).toEqual({ min: 20, max: 80, speed: 200 });
    const s = scriptBandSpeed(c, { min: 45, max: 57 });
    expect(s).toEqual({ min: 45, max: 57, speed: 40 });
    // no speed: the pattern's own, scaled the same way
    expect(scriptBandSpeed({ ...c, speed: null }, { min: 45, max: 57 }).speed).toBeCloseTo(describePattern(c.id).speed / 5, 9);
  });

  it('every gap of a script, banded to the script and joined to its neighbours', () => {
    const acts = [];
    for (let t = 0; t < 120000; t += 500) {
      if (t > 20000 && t < 45000) continue;   // a 25 s gap
      if (t > 70000 && t < 82000) continue;   // a 12 s gap
      acts.push({ at: t, pos: (t / 500) % 2 ? 70 : 30 });
    }
    const gaps = detectGaps(acts, 10000, 150000);
    expect(gaps).toHaveLength(3);   // the two and the trailing 30 s
    const fill = buildLibraryFillerActions(acts, gaps, {
      library: { id: 'quick-full-strokes', speed: 150, reversed: false, rangeMode: 'script', depthPct: 50, centrePct: null },
      scriptBand: (d, c) => resolveDepth(acts, { depthPct: d, centrePct: c }),
      maxJoinSpeed: 300,
    });
    const band = resolveDepth(acts, { depthPct: 50 });   // 40-60
    for (const g of gaps) {
      const before = acts.filter((a) => a.at <= g.startMs).pop(), after = acts.find((a) => a.at >= g.endMs) || null;
      const part = fill.filter((a) => a.at > g.startMs && a.at < g.endMs);
      expect(part.length, `${g.startMs}`).toBeGreaterThan(10);
      expect(gapProblems(part, g, before.pos, after ? after.pos : null, 300)).toEqual([]);
      // the body of the fill (away from the joins and the rest) lives in the band (a narrow band may be widened by
      // renderLoop so the pattern can move: never past the script's own range)
      for (const a of part.slice(2, -2)) expect(a.pos >= 30 && a.pos <= 70, `${a.at}: ${a.pos}`).toBe(true);
    }
    expect(band).toEqual({ min: 40, max: 60 });
  });
});

describe('a whole long script stays fast', () => {
  it('1 h, 50 gaps, a heavy buzz pattern: one loop render (cached), a linear pass per gap', () => {
    const acts = [];
    let t = 0, k = 0, g = 0;
    while (t < 3600000) {
      acts.push({ at: t, pos: (k++ % 2) ? 85 : 15 });
      if (t > (g + 1) * 72000 - 60000 && g < 50) { t += 15000 + ((g * 900) % 45000); g++; } else t += 400;
    }
    const gaps = detectGaps(acts, 10000, 3700000);
    expect(gaps.length).toBeGreaterThanOrEqual(50);
    const run = () => buildLibraryFillerActions(acts, gaps, {
      library: { id: 'steady-buzz-base', speed: null, reversed: false, rangeMode: 'script', depthPct: 60 },
      scriptBand: (d, c) => resolveDepth(acts, { depthPct: d, centrePct: c }), maxJoinSpeed: 300,
    });
    const t0 = performance.now();
    const cold = run();
    const coldMs = performance.now() - t0;
    const t1 = performance.now();
    run();
    const warmMs = performance.now() - t1;
    expect(cold.length).toBeGreaterThan(10000);
    // measured 2026-11-19: ~80 ms cold, ~25-50 ms warm on an idle machine (the old engine's sine filler: ~70 ms);
    // the bound leaves room for a loaded full suite
    expect(coldMs).toBeLessThan(2500);
    expect(warmMs).toBeLessThan(2000);
  });
});

describe('through filler-engine.js (every device path: the tick engines, the Handy / Autoblow upload)', () => {
  const acts = [];
  for (let t = 0; t < 90000; t += 450) { if (t > 20000 && t < 50000) continue; acts.push({ at: t, pos: (t / 450) % 2 ? 80 : 20 }); }

  it('buildFillerActions plays a library choice through filler-pattern.js, with the threshold and the trailing gap', async () => {
    const { buildFillerActions, fillRawScriptContent, applyFiller } = await import('../../renderer/js/filler-engine.js');
    const library = { id: 'quick-full-strokes', speed: 180, reversed: false, rangeMode: 'script', depthPct: 50, centrePct: null };
    const opts = { enabled: true, thresholdMs: 10000, totalDurationMs: 120000, library };
    const fill = buildFillerActions(acts, opts);
    const gaps = detectGaps(acts, 10000, 120000);
    expect(gaps).toHaveLength(2);   // the 30 s gap and the trailing one: FT-113
    expect(fill).toEqual(buildLibraryFillerActions(acts, gaps, {
      library, scriptBand: (d, c) => resolveDepth(acts, { depthPct: d, centrePct: c }), maxJoinSpeed: 300, minPatternMs: 800,
    }));
    expect(fill.some((a) => a.at > 90000)).toBe(true);
    // a higher threshold than the gap: nothing
    expect(buildFillerActions(acts, { ...opts, thresholdMs: 40000, totalDurationMs: 0 })).toEqual([]);
    // the upload carries the same points
    const raw = JSON.stringify({ actions: acts });
    expect(JSON.parse(fillRawScriptContent(raw, opts)).actions).toEqual(applyFiller(acts, opts).map((a) => ({ at: a.at, pos: a.pos })));
  });

  it('a reversed simple shape is mirrored inside its band before the slew limiter and the joins', async () => {
    const { buildGapFiller } = await import('../../renderer/js/filler-engine.js');
    const gap = { startMs: 0, endMs: 12000 };
    const base = { pattern: 'sawtooth', bpm: 20, min: 20, max: 70, maxJoinSpeed: 300 };
    const plain = buildGapFiller(gap, 45, 45, base);
    const rev = buildGapFiller(gap, 45, 45, { ...base, reversed: true });
    expect(rev).not.toEqual(plain);
    // the sawtooth ramps DOWN now: the long legs fall
    const longLegs = (fill) => fill.filter((a, i) => i > 0 && a.at - fill[i - 1].at > 1000).map((a, i) => Math.sign(a.pos - fill[fill.indexOf(a) - 1].pos));
    expect(longLegs(plain).every((d) => d > 0)).toBe(true);
    expect(longLegs(rev).every((d) => d < 0)).toBe(true);
    for (const a of rev) expect(a.pos >= 20 && a.pos <= 70).toBe(true);
    // not reversed: exactly as before (pattern-choice-upgrade.test.js holds the whole filler to v0.9.2)
    expect(buildGapFiller(gap, 45, 45, { ...base, reversed: false })).toEqual(plain);
  });
});
