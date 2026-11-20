/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The six simple shapes as library patterns (pattern settings unification,
// 2026-11-19; DESIGN-pattern-settings-unify.md §3): listed after the
// catalogue, described for the pickers, drawn exactly as script-modifiers.js
// generatePattern draws them and looped exactly as the Orgasm Switch's
// Generated pattern looped them; the Fill drawer's core holds them to the
// hard limits. The engine's own rules (pattern-library.test.js) are the
// catalogue's.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  listFamilies, listPatterns, describePattern, hasPattern, renderPattern, render, renderLoop, PATTERN_SPEED_CEILING,
} from '../../renderer/js/pattern-library.js';
import {
  SHAPE_IDS, SHAPE_TYPES, SHAPE_OWN_SPEED, shapeBpm, shapeSpeed, shapeRng, isShapeId, shapeTypeOf, shapeIdFor,
  shapeLoopActions,
} from '../../renderer/js/pattern-library-shapes.js';
import { generatePattern } from '../../renderer/js/script-modifiers.js';
import { buildOrgasmPatternContent } from '../../renderer/js/orgasm-pattern.js';
import { fillRange } from '../../renderer/js/pattern-fill.js';
import {
  normalizePatternSource, patternSpeedBounds, patternSourceLoop, patternSourceKey, clearPatternSourceCache,
} from '../../renderer/js/pattern-source.js';

/** Math.random answering from a seeded stream, so generatePattern's 'random' can be compared step for step. */
function stubRandom(seed) {
  const r = shapeRng(seed);
  return vi.spyOn(Math, 'random').mockImplementation(() => r());
}

afterEach(() => { vi.restoreAllMocks(); clearPatternSourceCache(); });

describe('the simple shapes in the library', () => {
  it('are a family of their own after the catalogue, six loopable cycles, under shape-<type> ids', () => {
    const fams = listFamilies();
    expect(fams[fams.length - 1]).toEqual({
      id: 'simple-shapes', patternIds: [...SHAPE_IDS],
      nameKey: 'patterns.family.simple-shapes.name', descKey: 'patterns.family.simple-shapes.desc',
    });
    expect(SHAPE_IDS).toEqual(['shape-sine', 'shape-triangle', 'shape-sawtooth', 'shape-square', 'shape-escalating', 'shape-random']);
    expect(listPatterns({ family: 'simple-shapes' })).toEqual(SHAPE_IDS.map((id) => ({ id, family: 'simple-shapes', kind: 'cycle', loopable: true })));
    expect(listPatterns({ loopable: false }).some((p) => isShapeId(p.id))).toBe(false);
    for (const id of SHAPE_IDS) {
      expect(hasPattern(id)).toBe(true);
      expect(describePattern(id)).toEqual({
        id, family: 'simple-shapes', kind: 'cycle', loopable: true, hasBuzz: false,
        speed: SHAPE_OWN_SPEED, speedRange: [10, 600], range: [0, 100], strokeMs: 1667,
        nameKey: `patterns.${id}.name`, descKey: `patterns.${id}.desc`,
      });
    }
    // strict ids: nothing that merely looks like one
    for (const bad of ['shape-', 'shape-foo', 'shape-sine ', 'Shape-sine', 'sine', 'shape-__proto__', 'shape-toString']) {
      expect(hasPattern(bad), bad).toBe(false);
      expect(describePattern(bad)).toBeNull();
      expect(renderPattern(bad)).toBeNull();
      expect(renderLoop(bad)).toBeNull();
    }
    expect(shapeTypeOf('shape-square')).toBe('square');
    expect(shapeIdFor('triangle')).toBe('shape-triangle');
    expect(shapeIdFor('nope')).toBe('shape-sine'); // generatePattern's own fallback
  });

  it('converts strokes a minute and units a second both ways, exactly at a whole BPM', () => {
    for (let bpm = 1; bpm <= 600; bpm++) {
      for (const width of [1, 5, 33, 60, 75, 99.5, 100]) expect(shapeBpm(shapeSpeed(bpm, width), width)).toBe(bpm);
    }
    expect(shapeSpeed(120, 100)).toBe(400);        // the Generated pattern's default
    expect(shapeSpeed(20, 60)).toBe(40);           // Slow tease
    expect(shapeSpeed(30, 0)).toBe(1);             // a flat band converts at 1 unit
    expect(shapeBpm(100000, 100)).toBe(600);       // clamped to the shape limits
    expect(shapeBpm(0.001, 100)).toBe(1);
  });

  it('renderPattern draws exactly what generatePattern draws (same positions, same timestamps)', () => {
    for (const type of ['sine', 'triangle', 'sawtooth', 'square', 'escalating']) {
      for (const speed of [10, 40, 133.33333333333334, 400, 1000]) {
        for (const [min, max] of [[0, 100], [20, 80], [45, 55]]) {
          const from = 1234, durationMs = 17321;
          const bpm = shapeBpm(speed, max - min);
          const want = generatePattern(type, from, from + durationMs, bpm, min, max);
          const res = renderPattern(`shape-${type}`, { from, durationMs, speed, range: { min, max } });
          expect(res.actions, `${type} ${speed} ${min}-${max}`).toEqual(want);
          expect(res.vib).toEqual(want.map(() => false));
          expect(res.stats.lo).toBe(want.length ? Math.min(...want.map((a) => a.pos)) : null);
        }
      }
    }
  });

  it("'random' is generatePattern's algorithm from a seeded stream: the same seed, the same strokes", () => {
    const opts = { from: 0, durationMs: 20000, speed: 50, range: { min: 10, max: 90 }, seed: 7 };
    const a = render('shape-random', opts);
    expect(render('shape-random', opts)).toEqual(a);
    expect(render('shape-random', { ...opts, seed: 8 })).not.toEqual(a);
    stubRandom(7);
    expect(generatePattern('random', 0, 20000, shapeBpm(50, 80), 10, 90)).toEqual(a);
  });

  it('reversed mirrors inside the band; the defaults are the whole range at the own speed', () => {
    const plain = render('shape-sawtooth', { durationMs: 5000, speed: 60, range: { min: 20, max: 70 } });
    const rev = render('shape-sawtooth', { durationMs: 5000, speed: 60, range: { min: 20, max: 70 }, reversed: true });
    expect(rev).toEqual(plain.map((a) => ({ at: a.at, pos: 90 - a.pos })));
    expect(render('shape-sine')).toEqual(generatePattern('sine', 0, 10000, shapeBpm(SHAPE_OWN_SPEED, 100), 0, 100));
  });

  it('refuses a length, speed or cap that is not above 0, like every pattern', () => {
    expect(() => renderPattern('shape-sine', { durationMs: 0 })).toThrow(RangeError);
    expect(() => renderPattern('shape-sine', { speed: -1 })).toThrow(RangeError);
    expect(() => renderPattern('shape-sine', { speed: 50, ramp: { to: 0 } })).toThrow(RangeError);
    expect(() => renderPattern('shape-sine', { maxSpeed: 0 })).toThrow(RangeError);
  });

  it('renderLoop is the Generated pattern loop at every whole BPM, type and range (random: from the same stream)', () => {
    for (const type of SHAPE_TYPES) {
      for (const bpm of [20, 21, 37, 55, 60, 89, 120, 133, 181, 250, 300]) {
        for (const [min, max] of [[0, 100], [10, 90], [40, 45], [50, 50]]) {
          if (type === 'random') stubRandom(`${bpm}|${min}`);
          const old = JSON.parse(buildOrgasmPatternContent({ enabled: true, type, bpm, min, max })).actions;
          vi.restoreAllMocks();
          const nw = type === 'random'
            ? shapeLoopActions(type, shapeBpm(shapeSpeed(bpm, max - min), max - min), min, max, shapeRng(`${bpm}|${min}`))
            : renderLoop(`shape-${type}`, { speed: shapeSpeed(bpm, max - min), range: { min, max } }).actions;
          expect(nw, `${type} ${bpm} ${min}-${max}`).toEqual(old);
        }
      }
    }
  });

  it('a loop starts at 0, ends on its first position, whole ms; a reversed loop is the mirror', () => {
    for (const id of SHAPE_IDS) {
      const loop = renderLoop(id, { speed: 90, range: { min: 15, max: 85 } });
      const a = loop.actions;
      expect(a[0].at).toBe(0);
      expect(a[a.length - 1].at).toBe(loop.loopMs);
      expect(a[a.length - 1].pos).toBe(a[0].pos);
      expect(loop.fallback).toBe(false);
      expect(loop.warnings).toEqual([]);
      for (let i = 1; i < a.length; i++) expect(a[i].at).toBeGreaterThan(a[i - 1].at);
      for (const q of a) expect(Number.isInteger(q.pos) && q.pos >= 15 && q.pos <= 85).toBe(true);
      const rev = renderLoop(id, { speed: 90, range: { min: 15, max: 85 }, reversed: true });
      expect(rev.actions).toEqual(a.map((q) => ({ at: q.at, pos: 100 - q.pos })));
    }
  });

  it('the Fill drawer core fills with a shape inside the hard limits (anchors kept, minimum legs, the 600 u/s ceiling)', () => {
    const acts = [{ at: 0, pos: 10 }, { at: 1000, pos: 90 }, { at: 9000, pos: 20 }, { at: 10000, pos: 80 }];
    for (const id of SHAPE_IDS) {
      for (const speed of [null, 300, 600]) {
        const res = fillRange({ actions: acts, selection: { startMs: 1000, endMs: 9000 }, patternId: id, options: { speed, maxSpeed: PATTERN_SPEED_CEILING } });
        expect(res.inserted.length, id).toBeGreaterThan(2);
        expect(res.actions[0]).toEqual(acts[0]);
        expect(res.actions.find((a) => a.at === 1000)?.pos).toBe(90);
        expect(res.actions.find((a) => a.at === 9000)?.pos).toBe(20);
        const a = res.actions;
        for (let i = 1; i < a.length; i++) {
          const dt = a[i].at - a[i - 1].at;
          expect(dt, `${id} ${speed} leg ${i}`).toBeGreaterThanOrEqual(100);
          expect((Math.abs(a[i].pos - a[i - 1].pos) / dt) * 1000, `${id} ${speed} leg ${i}`).toBeLessThanOrEqual(PATTERN_SPEED_CEILING + 0.5);
        }
      }
    }
  });

  it('pattern-source keeps a shape speed as given (0.5-1000 u/s, unrounded) and keys it apart', () => {
    expect(patternSpeedBounds('shape-triangle')).toEqual({ min: 10, max: 600, own: 120 });
    expect(normalizePatternSource({ id: 'shape-triangle', speed: 133.33333333333334 }).speed).toBe(133.33333333333334);
    expect(normalizePatternSource({ id: 'shape-sine', speed: 5000 }).speed).toBe(1000);
    // PF-R7 (pf-fixup): the floor is 0.5, under the 0.67 u/s of a Generated 20 BPM in a 1-unit band.
    expect(normalizePatternSource({ id: 'shape-sine', speed: 0.2 }).speed).toBe(0.5);
    expect(normalizePatternSource({ id: 'shape-sine', speed: -3 }).speed).toBeNull();
    // the catalogue as before: whole numbers inside the slider's bounds
    expect(normalizePatternSource({ id: 'quick-full-strokes', speed: 133.4 }).speed).toBe(133);
    const k1 = patternSourceKey({ id: 'shape-sine', speed: 400, min: 0, max: 100 });
    expect(k1).toMatch(/^funsync-generated-pattern:library\/v1\/shape-sine\/400\/n\/0-100\/s1$/);
    expect(patternSourceKey({ id: 'shape-sine', speed: 401, min: 0, max: 100 })).not.toBe(k1);
    const loop = patternSourceLoop({ id: 'shape-square', speed: 400, min: 0, max: 100 });
    expect(loop.once).toBe(false);
    expect(loop.vib.every((v) => v === false)).toBe(true);
    expect(loop.actions).toEqual(JSON.parse(buildOrgasmPatternContent({ enabled: true, type: 'square', bpm: 120, min: 0, max: 100 })).actions);
  });

  it('is a pure module: only script-modifiers.js, no DOM, no Node APIs', () => {
    const src = readFileSync(fileURLToPath(new URL('../../renderer/js/pattern-library-shapes.js', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./script-modifiers.js']);
    for (const banned of [/\brequire\(/, /\bprocess\./, /\bwindow\b/, /\bdocument\b/, /\blocalStorage\b/]) expect(src).not.toMatch(banned);
  });
});
