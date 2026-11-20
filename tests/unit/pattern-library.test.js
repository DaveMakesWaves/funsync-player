/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pattern library engine (next major, 2026-11-17): the API, the options, the
// seamless loop and the time budget. Parity with the reference generator is
// pattern-library-parity.test.js; the data's privacy guard is
// pattern-library-privacy.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PATTERN_ENGINE_VERSION, MIN_LEG, MIN_BUZZ, DEFAULT_MAX_SPEED,
  listFamilies, listPatterns, describePattern, hasPattern, renderPattern, render, renderLoop, actionStats,
} from '../../renderer/js/pattern-library.js';
import { tileFinisherContent } from '../../renderer/js/orgasm-handy-engage.js';

// The engine's own patterns (the catalogue). The six simple shapes merged in on 2026-11-19 are drawn by
// pattern-library-shapes.js exactly as generatePattern draws them, so the engine's rules below (minimum legs, the
// cap, startPos / startDir, seeds, the bottom-turn loop) are not theirs: pattern-library-shapes.test.js holds them.
const ALL = listPatterns().filter((p) => p.family !== 'simple-shapes');
const LOOPABLE = listPatterns({ loopable: true }).filter((p) => p.family !== 'simple-shapes');
const mirror = (acts) => acts.map((a) => ({ at: a.at, pos: 100 - a.pos }));
/** The direction of the first move that leaves the start position. */
function firstDir(acts) {
  for (let i = 1; i < acts.length; i++) if (acts[i].pos !== acts[0].pos) return Math.sign(acts[i].pos - acts[0].pos);
  return 0;
}
/** Every leg: integer times strictly increasing, integer positions 0-100, the minimum legs and the speed cap. */
function legProblems(res, from, until) {
  const a = res.actions, out = [];
  if (a[0].at !== from) out.push(`starts at ${a[0].at}`);
  if (a[a.length - 1].at !== until) out.push(`ends at ${a[a.length - 1].at}`);
  for (let i = 0; i < a.length; i++) {
    if (!Number.isInteger(a[i].at) || !Number.isInteger(a[i].pos) || a[i].pos < 0 || a[i].pos > 100) out.push(`bad action ${JSON.stringify(a[i])}`);
    if (i === 0) continue;
    const dt = a[i].at - a[i - 1].at, v = (Math.abs(a[i].pos - a[i - 1].pos) / dt) * 1000;
    if (dt < (res.vib[i] ? MIN_BUZZ : MIN_LEG)) out.push(`leg ${i} is ${dt} ms (vib ${res.vib[i]})`);
    if (v > res.params.maxSpeed + 0.5) out.push(`leg ${i} at ${v.toFixed(0)} u/s`);
  }
  return out;
}

describe('the library', () => {
  it('lists 78 patterns in 10 families, in catalogue order, under unique descriptive ids (then the 6 simple shapes)', () => {
    const fams = listFamilies().filter((f) => f.id !== 'simple-shapes');
    expect(listFamilies().map((f) => f.id).slice(-1)).toEqual(['simple-shapes']);
    expect(listPatterns().map((p) => p.id)).toEqual([...ALL.map((p) => p.id), 'shape-sine', 'shape-triangle', 'shape-sawtooth', 'shape-square', 'shape-escalating', 'shape-random']);
    expect(ALL).toHaveLength(78);
    expect(fams).toHaveLength(10);
    expect(fams.map((f) => f.id)).toEqual(['full-strokes', 'tip-work', 'base-grind', 'buzz', 'climbs', 'holds', 'waves', 'stutters', 'endings', 'flutters']);
    // the families hold every pattern once, in the list's order
    expect(fams.flatMap((f) => f.patternIds)).toEqual(ALL.map((p) => p.id));
    for (const f of fams) {
      expect(ALL.filter((p) => p.family === f.id).map((p) => p.id)).toEqual(f.patternIds);
      expect(f.nameKey).toBe(`patterns.family.${f.id}.name`);
      expect(f.descKey).toBe(`patterns.family.${f.id}.desc`);
    }
    const ids = [...ALL.map((p) => p.id), ...fams.map((f) => f.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(['family', 'ui']).not.toContain(id); // reserved: i18n sub-keys under patterns.*
    }
  });

  it('has the five kinds, and only the six endings are not loopable', () => {
    const count = (k) => ALL.filter((p) => p.kind === k).length;
    expect([count('cycle'), count('template'), count('drone'), count('hold'), count('event')]).toEqual([54, 12, 3, 3, 6]);
    const notLoopable = listPatterns({ loopable: false });
    expect(notLoopable).toHaveLength(6);
    expect(notLoopable.every((p) => p.kind === 'event')).toBe(true);
    expect(LOOPABLE).toHaveLength(72);
    expect(listPatterns({ loopable: true })).toHaveLength(78); // + the 6 simple shapes, all loopable
    expect(listPatterns({ family: 'holds' }).map((p) => p.id)).toEqual(['pause-at-top', 'pause-at-bottom', 'pause-halfway', 'dip-climb-hold-top']);
    expect(listPatterns({ family: 'nope' })).toEqual([]);
  });

  it('describes a pattern for the picker and the sliders, and knows nothing of unknown ids', () => {
    const d = describePattern('quick-full-strokes');
    expect(d).toMatchObject({ id: 'quick-full-strokes', family: 'full-strokes', kind: 'cycle', loopable: true, hasBuzz: false, nameKey: 'patterns.quick-full-strokes.name', descKey: 'patterns.quick-full-strokes.desc' });
    expect(describePattern('steady-buzz-base').hasBuzz).toBe(true);
    expect(describePattern('plunge-finish').loopable).toBe(false);
    for (const p of ALL) {
      const x = describePattern(p.id);
      expect(x.speed, p.id).toBeGreaterThan(0);
      expect(x.speedRange[0], p.id).toBeLessThan(x.speedRange[1]);
      expect(x.range[0], p.id).toBeGreaterThanOrEqual(0);
      expect(x.range[1], p.id).toBeLessThanOrEqual(100);
      expect(x.range[0], p.id).toBeLessThan(x.range[1]);
      expect(x.strokeMs, p.id).toBeGreaterThan(0);
    }
    for (const bad of ['nope', '', null, undefined, 42, 'family', '__proto__', 'toString']) {
      expect(describePattern(bad)).toBeNull();
      expect(hasPattern(bad)).toBe(false);
      expect(renderPattern(bad)).toBeNull();
      expect(render(bad)).toBeNull();
      expect(renderLoop(bad)).toBeNull();
    }
    expect(hasPattern('slow-tip-strokes')).toBe(true);
  });

  it('refuses a length, speed or cap that is not above 0', () => {
    expect(() => renderPattern('quick-full-strokes', { durationMs: 0 })).toThrow(RangeError);
    expect(() => renderPattern('quick-full-strokes', { durationMs: -5 })).toThrow(RangeError);
    expect(() => renderPattern('quick-full-strokes', { speed: 0 })).toThrow(RangeError);
    expect(() => renderPattern('quick-full-strokes', { speed: 100, ramp: { to: -1 } })).toThrow(RangeError);
    expect(() => renderPattern('quick-full-strokes', { maxSpeed: 0 })).toThrow(RangeError);
  });

  it('is a pure module: no DOM, no Node APIs, only its own data', () => {
    const src = readFileSync(fileURLToPath(new URL('../../renderer/js/pattern-library.js', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./pattern-library-data.js']); // single-line imports; the shapes module's is multi-line
    expect(src).toMatch(/\} from '\.\/pattern-library-shapes\.js';/);
    for (const banned of [/\brequire\(/, /\bprocess\./, /\bwindow\b/, /\bdocument\b/, /\bfs\b/, /\blocalStorage\b/]) expect(src).not.toMatch(banned);
    expect(PATTERN_ENGINE_VERSION).toBe(1);
    expect([MIN_LEG, MIN_BUZZ, DEFAULT_MAX_SPEED]).toEqual([100, 50, 600]);
  });
});

// Each of these renders every pattern several times: about 0.5-3 s on an idle machine, several times that under a
// loaded full suite, so they get a timeout of their own rather than the default 5 s.
const HEAVY = { timeout: 60000 };

describe('renderPattern', HEAVY, () => {
  it('gives valid actions for every pattern: ends on the window, minimum legs, the speed cap', () => {
    const problems = [];
    for (const p of ALL) {
      const d = describePattern(p.id);
      for (const o of [{}, { speed: d.speedRange[0] }, { speed: d.speedRange[1], reversed: true }, { from: 1500, startPos: 0, durationMs: 3000 }, { variation: 2 }, { variation: 0, startPos: 60, startDir: -1 }]) {
        const from = o.from ?? 0;
        const res = renderPattern(p.id, { durationMs: 10000, seed: 9, ...o });
        const bad = legProblems(res, from, from + (o.durationMs ?? 10000));
        if (bad.length) problems.push(`${p.id} ${JSON.stringify(o)}: ${bad.slice(0, 2).join('; ')}`);
        expect(res.vib).toHaveLength(res.actions.length);
        expect(res.vib[0]).toBe(false);
      }
    }
    expect(problems).toEqual([]);
  });

  it('reports stats of what it rendered and warnings as codes, never as text', () => {
    const KNOWN = ['speed-capped', 'speed-unreachable', 'range-clipped', 'too-short', 'range-widened', 'fast-legs'];
    const seen = new Set();
    for (const p of ALL) {
      for (const o of [{ durationMs: 10000 }, { durationMs: 1000, startPos: 0 }, { durationMs: 5000, range: { min: -10, max: 130 }, allowFast: true }, { durationMs: 10000, speed: 900, maxSpeed: 300 }]) {
        const res = renderPattern(p.id, { seed: 2, ...o });
        expect(res.stats).toEqual(actionStats(res.actions));
        for (const w of res.warnings) {
          expect(Object.keys(w).sort()).toEqual(['code', 'values']);
          expect(KNOWN).toContain(w.code);
          seen.add(w.code);
        }
      }
    }
    expect([...seen].sort()).toEqual([...KNOWN].sort());
    // positions in a warning are in the caller's coordinates, also when reversed
    const clipped = renderPattern('quick-full-strokes', { durationMs: 4000, range: { min: -10, max: 60 }, reversed: true, seed: 1 });
    expect(clipped.warnings.find((w) => w.code === 'range-clipped').values).toEqual({ from: [-10, 60], to: [0, 60] });
  });

  it('a higher speed is a faster render, near the asked speed', () => {
    for (const p of ALL) {
      const d = describePattern(p.id);
      const slow = renderPattern(p.id, { durationMs: 20000, speed: d.speedRange[0], seed: 2 });
      const fast = renderPattern(p.id, { durationMs: 20000, speed: d.speedRange[1], seed: 2 });
      expect(fast.stats.mean, p.id).toBeGreaterThan(slow.stats.mean);
      for (const [res, asked] of [[slow, d.speedRange[0]], [fast, d.speedRange[1]]]) {
        if (res.warnings.some((w) => w.code === 'speed-unreachable')) continue; // says so when it cannot
        expect(Math.abs(res.stats.mean / asked - 1), `${p.id} at ${asked}`).toBeLessThanOrEqual(0.15);
      }
    }
    // the tempo follows the speed: twice the speed, about half the stroke time
    const turns = (a) => a.filter((q, i) => i > 0 && i < a.length - 1 && Math.sign(q.pos - a[i - 1].pos) !== Math.sign(a[i + 1].pos - q.pos)).length;
    const t1 = turns(render('quick-full-strokes', { durationMs: 20000, speed: 120, seed: 3 }));
    const t2 = turns(render('quick-full-strokes', { durationMs: 20000, speed: 240, seed: 3 }));
    expect(t2 / t1).toBeGreaterThan(1.7);
    expect(t2 / t1).toBeLessThan(2.3);
  });

  it('a speed ramp builds: the second half runs faster than the first', () => {
    for (const id of ['quick-full-strokes', 'uneven-base-strokes', 'buzz-long-strokes', 'pause-at-top', 'steady-buzz-base']) {
      const d = describePattern(id);
      const res = renderPattern(id, { durationMs: 30000, speed: d.speedRange[0], ramp: { to: d.speedRange[1] }, seed: 4 });
      const half = (lo, hi) => actionStats(res.actions.filter((a) => a.at >= lo && a.at <= hi)).mean;
      expect(half(15000, 30000), id).toBeGreaterThan(half(0, 15000) * 1.3);
    }
  });

  it('reversed is the exact mirror, also with a start position, a heading and a range (asked in your coordinates)', () => {
    for (const p of ALL) {
      expect(render(p.id, { durationMs: 12000, reversed: true, seed: 5 }), p.id).toEqual(mirror(render(p.id, { durationMs: 12000, seed: 5 })));
      const rev = renderPattern(p.id, { durationMs: 12000, reversed: true, seed: 5, startPos: 30, startDir: 1, range: { min: 10, max: 70 } });
      const plain = renderPattern(p.id, { durationMs: 12000, seed: 5, startPos: 70, startDir: -1, range: { min: 30, max: 90 } });
      expect(rev.actions, p.id).toEqual(mirror(plain.actions));
      expect(rev.vib).toEqual(plain.vib);
      expect(rev.actions[0].pos).toBe(30);
      expect(rev.stats.mean).toBeCloseTo(plain.stats.mean, 9);
    }
  });

  it('stays inside an asked range', () => {
    const out = [];
    for (const p of ALL) {
      for (const reversed of [false, true]) {
        const res = renderPattern(p.id, { durationMs: 12000, range: { min: 20, max: 60 }, reversed, seed: 4 });
        if (res.actions.some((a) => a.pos < 20 || a.pos > 60)) out.push(`${p.id} reversed ${reversed}`);
        // from outside the range it moves in first, then stays
        const fromOut = renderPattern(p.id, { durationMs: 12000, range: { min: 20, max: 60 }, reversed, seed: 4, startPos: 90 });
        if (fromOut.actions.slice(2).some((a) => a.pos < 20 || a.pos > 60)) out.push(`${p.id} reversed ${reversed} from 90`);
      }
    }
    expect(out).toEqual([]);
  });

  it('is deterministic: the same seed gives the same strokes, another seed others', () => {
    for (const p of ALL) {
      const a = renderPattern(p.id, { durationMs: 12000, seed: 1 });
      expect(renderPattern(p.id, { durationMs: 12000, seed: 1 }), p.id).toEqual(a);
      expect(render(p.id, { durationMs: 12000 }), `${p.id}: seed 1 is the default`).toEqual(a.actions);
      expect(render(p.id, { durationMs: 12000, seed: 2 }), p.id).not.toEqual(a.actions);
      expect(render(p.id, { durationMs: 12000, seed: 'x' }), p.id).not.toEqual(a.actions);
    }
  });

  it('variation 1 is the pattern itself; 0 repeats whole cycles whatever the seed; 2 varies more', () => {
    for (const p of ALL) expect(render(p.id, { durationMs: 10000, seed: 6, variation: 1 }), p.id).toEqual(render(p.id, { durationMs: 10000, seed: 6 }));
    // variation 0: every cycle the same (times within 1 ms, positions within 1) and the seed no longer matters
    const v0 = render('quick-full-strokes', { durationMs: 20000, variation: 0, seed: 1 });
    expect(render('quick-full-strokes', { durationMs: 20000, variation: 0, seed: 99 })).toEqual(v0);
    const tops = v0.filter((a, i) => i > 0 && i < v0.length - 1 && a.pos > v0[i - 1].pos && a.pos >= v0[i + 1].pos);
    const periods = tops.slice(1).map((a, i) => a.at - tops[i].at);
    expect(Math.max(...periods) - Math.min(...periods)).toBeLessThanOrEqual(1);
    expect(new Set(tops.map((a) => a.pos)).size).toBe(1);
    expect(render('uneven-long-strokes', { durationMs: 20000, variation: 0, seed: 1 })).toEqual(render('uneven-long-strokes', { durationMs: 20000, variation: 0, seed: 2 }));
    // more variation, more spread in the stroke tops
    const spread = (v) => { const a = render('quick-full-strokes', { durationMs: 30000, variation: v, seed: 3 }); const t = a.filter((q, i) => i > 0 && i < a.length - 1 && q.pos > a[i - 1].pos && q.pos >= a[i + 1].pos).map((q) => q.pos); return Math.max(...t) - Math.min(...t); };
    expect(spread(2)).toBeGreaterThan(spread(1));
    expect(spread(1)).toBeGreaterThan(spread(0));
    // out-of-range values are held to 0-2
    expect(render('quick-full-strokes', { durationMs: 8000, variation: 7, seed: 3 })).toEqual(render('quick-full-strokes', { durationMs: 8000, variation: 2, seed: 3 }));
    expect(render('quick-full-strokes', { durationMs: 8000, variation: -1, seed: 3 })).toEqual(render('quick-full-strokes', { durationMs: 8000, variation: 0, seed: 3 }));
  });

  it('startDir: from inside the band the first move carries on the heading; at the edge it heads for, it turns there', () => {
    const problems = [];
    for (const p of ALL) {
      if (p.kind === 'drone' || p.kind === 'hold') continue; // a buzz has no heading; a pause keeps its place
      for (const reversed of [false, true]) for (const startPos of [20, 35, 50, 65, 80]) for (const dir of [1, -1]) {
        const res = renderPattern(p.id, { durationMs: 4000, startPos, startDir: dir, reversed, seed: 3 });
        const [lo, hi] = res.params.startBand; // the band the start was chosen in (a climb starts low, inside its envelope)
        const edge = dir > 0 ? hi : lo;
        if (dir > 0 ? startPos > edge - 10 : startPos < edge + 10) continue;
        // the first leg carries on the heading, or is flat within 3 units (the fill design's I5)
        const leg = res.actions[1].pos - res.actions[0].pos;
        if (Math.sign(leg) !== dir && Math.abs(leg) > 3) problems.push(`${p.id} reversed ${reversed} from ${startPos} heading ${dir}: ${JSON.stringify(res.actions.slice(0, 3))}`);
      }
    }
    expect(problems).toEqual([]);
    // at (or past) the top heading up, and at the bottom heading down: the pattern turns there, like a stroke would
    for (const p of ALL.filter((x) => x.kind === 'cycle')) {
      const d = describePattern(p.id);
      expect(firstDir(render(p.id, { durationMs: 4000, startPos: Math.min(100, Math.round(d.range[1]) + 3), startDir: 1, seed: 3 })), p.id).toBe(-1);
      expect(firstDir(render(p.id, { durationMs: 4000, startPos: Math.max(0, Math.round(d.range[0]) - 3), startDir: -1, seed: 3 })), p.id).toBe(1);
    }
    // the named cases of the fill design: A mid heading up -> first leg up; A at the top heading up -> first leg down
    expect(firstDir(render('quick-full-strokes', { durationMs: 3000, startPos: 50, startDir: 1, seed: 1 }))).toBe(1);
    expect(firstDir(render('quick-full-strokes', { durationMs: 3000, startPos: 50, startDir: -1, seed: 1 }))).toBe(-1);
    expect(firstDir(render('quick-full-strokes', { durationMs: 3000, startPos: 95, startDir: 1, seed: 1 }))).toBe(-1);
    // no heading (0, or not a number) is the plain render
    expect(render('quick-full-strokes', { durationMs: 5000, startPos: 50, startDir: 0, seed: 1 })).toEqual(render('quick-full-strokes', { durationMs: 5000, startPos: 50, seed: 1 }));
    expect(render('quick-full-strokes', { durationMs: 5000, startPos: 50, startDir: 'up', seed: 1 })).toEqual(render('quick-full-strokes', { durationMs: 5000, startPos: 50, seed: 1 }));
  });

  it('starts at startPos and eases in from it', () => {
    for (const p of ALL) {
      const res = renderPattern(p.id, { from: 2000, durationMs: 8000, startPos: 37, seed: 1 });
      expect(res.actions[0], p.id).toEqual({ at: 2000, pos: 37 });
    }
  });
});

describe('renderLoop', HEAVY, () => {
  const loopProblems = (id, opts) => {
    const loop = renderLoop(id, opts);
    const a = loop.actions, n = a.length, out = [];
    if (loop.fallback) out.push('no clean cut');
    if (a[0].at !== 0) out.push(`first at ${a[0].at}`);
    if (a[n - 1].at !== loop.loopMs) out.push('last is not at loopMs');
    if (a[n - 1].pos !== a[0].pos) out.push(`ends at ${a[n - 1].pos}, starts at ${a[0].pos}`);
    if (loop.loopMs < 8000 || loop.loopMs > 20000) out.push(`loopMs ${loop.loopMs}`);
    // valley to valley: it arrives going down (or level) and leaves going up (or level)
    if (a[n - 2].pos < a[n - 1].pos) out.push('arrives going up');
    if (a[1].pos < a[0].pos) out.push('leaves going down');
    for (let i = 1; i < n; i++) if (a[i].at - a[i - 1].at < (loop.vib[i] ? MIN_BUZZ : MIN_LEG)) out.push(`leg ${i} too short`);
    // tiled three times by the Handy finisher's own tiler: one seamless line, every leg within the cap
    const cap = Math.max(DEFAULT_MAX_SPEED, 1.5 * (opts.speed ?? describePattern(id).speed));
    const tiled = JSON.parse(tileFinisherContent(JSON.stringify({ actions: a }), 3 * loop.loopMs)).actions;
    if (tiled.length !== 3 * (n - 1) + 1) out.push(`tiled to ${tiled.length} actions`);
    for (let k = 1; k <= 3; k++) if (tiled[k * (n - 1)].at !== k * loop.loopMs || tiled[k * (n - 1)].pos !== a[0].pos) out.push(`wrap ${k} off`);
    for (let i = 1; i < tiled.length; i++) {
      const dt = tiled[i].at - tiled[i - 1].at;
      if (dt < MIN_BUZZ) out.push(`tiled leg ${i} is ${dt} ms`);
      if ((Math.abs(tiled[i].pos - tiled[i - 1].pos) / dt) * 1000 > cap + 0.5) out.push(`tiled leg ${i} over the cap`);
    }
    return { loop, out };
  };

  it('tiles seamlessly for every loopable pattern, plain and reversed', () => {
    const problems = [];
    for (const p of LOOPABLE) for (const reversed of [false, true]) {
      const { out } = loopProblems(p.id, { reversed });
      if (out.length) problems.push(`${p.id} reversed ${reversed}: ${out.slice(0, 3).join('; ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('follows speed and range, and is deterministic', () => {
    const problems = [];
    for (const id of ['quick-full-strokes', 'slow-tip-strokes', 'uneven-base-strokes', 'buzz-long-strokes', 'climbing-long-strokes', 'pause-at-bottom', 'steady-buzz-tip-high', 'fast-strokes-flutter-both-ends']) {
      const d = describePattern(id);
      for (const opts of [{ speed: d.speedRange[1] }, { range: { min: 30, max: 70 }, reversed: true }, { speed: d.speedRange[0], range: { min: 0, max: 50 } }]) {
        const { loop, out } = loopProblems(id, opts);
        if (out.length) problems.push(`${id} ${JSON.stringify(opts)}: ${out.slice(0, 3).join('; ')}`);
        if (opts.range && loop.actions.some((a) => a.pos < opts.range.min || a.pos > opts.range.max)) problems.push(`${id} ${JSON.stringify(opts)}: out of range`);
      }
      expect(renderLoop(id, { seed: 3 }), id).toEqual(renderLoop(id, { seed: 3 }));
      const slow = actionStats(renderLoop(id, { speed: d.speedRange[0] }).actions).mean;
      const fast = actionStats(renderLoop(id, { speed: d.speedRange[1] }).actions).mean;
      expect(fast, id).toBeGreaterThan(slow);
    }
    expect(problems).toEqual([]);
    expect(renderLoop('quick-full-strokes')).toEqual(renderLoop('quick-full-strokes', { seed: 1, targetMs: 10000 }));
  });

  it('a longer target gives a longer loop', () => {
    const loop = renderLoop('quick-full-strokes', { targetMs: 20000 });
    expect(loop.loopMs).toBeGreaterThanOrEqual(16000);
    expect(loop.loopMs).toBeLessThanOrEqual(40000);
    expect(loop.fallback).toBe(false);
  });

  it('offers no loop of an ending', () => {
    for (const p of listPatterns({ loopable: false })) expect(renderLoop(p.id), p.id).toBeNull();
  });
});

describe('time budget (a live preview redraws once per frame)', HEAVY, () => {
  // DESIGN-pattern-library.md (f): p95 over the patterns at most 16 ms for a 30 s window. Four patterns draw hundreds
  // of 50 ms buzz legs (or, the double flutter, many tiny ones) and are named here; they get a bound RELATIVE to a
  // reference measured in the same rounds, so a loaded machine (a full suite on 4 workers took 455 s once) slows the
  // bound with them: each may take at most what rendering all the ordinary patterns once takes together. Measured
  // warm on node, they take about 0.25-0.4 of that (27-50 ms against 80-130 ms); a 3x slowdown of the buzz path alone
  // still fails. Every number is the median of 5 rounds, each round rendering every pattern once, so a burst of load
  // hits all patterns alike.
  const SLOW = ['buzz-frantic-base-strokes', 'buzz-tiny-base-strokes', 'buzz-short-tip-strokes', 'fast-strokes-flutter-both-ends'];
  it('renders a 30 s window within budget', () => {
    for (const p of ALL) render(p.id, { durationMs: 30000, seed: 0, startPos: 50 }); // warm up (models, JIT)
    const runs = new Map(ALL.map((p) => [p.id, []]));
    for (let round = 0; round < 5; round++) {
      for (const p of ALL) {
        const t0 = performance.now();
        render(p.id, { durationMs: 30000, seed: 7 + round, startPos: 50 });
        runs.get(p.id).push(performance.now() - t0);
      }
    }
    const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const ms = new Map(ALL.map((p) => [p.id, median(runs.get(p.id))]));
    const ordinary = ALL.filter((p) => !SLOW.includes(p.id)).map((p) => ms.get(p.id)).sort((x, y) => x - y);
    expect(ordinary).toHaveLength(74);
    // the ordinary patterns: the design's 16 ms for a live preview frame, at p95
    expect(ordinary[Math.floor(0.95 * ordinary.length)]).toBeLessThanOrEqual(16);
    // the named slow ones: no more than all the ordinary patterns together, measured alongside them
    const reference = ordinary.reduce((a, b) => a + b, 0);
    for (const id of SLOW) expect(ms.get(id), `${id}: ${ms.get(id).toFixed(1)} ms against a reference of ${reference.toFixed(1)} ms`).toBeLessThanOrEqual(reference);
  });
});
