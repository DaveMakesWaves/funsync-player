/**
 * @vitest-environment node
 * No DOM required: pattern-source.js is pure. See notes/CLAUDE.md "Test environments".
 */
// A pattern from the library as a looping finisher (next major): the Orgasm
// Switch's "Pattern from the library" source and Edge Hold's "Play a
// pattern" mode share renderer/js/pattern-source.js. What is asserted is
// what the devices get: the funscript the loop becomes, the Handy's tiled
// upload (tileFinisherContent, as the finisher sends it) against the REAL
// OrgasmSwitch's per-tick loop, and the stored settings read back the way
// the app reads them (an old config without the keys = today).
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  ORGASM_LIBRARY_DEFAULTS, EDGE_PATTERN_DEFAULTS, EDGE_HOLD_ACTIONS,
  normalizePatternSource, orgasmLibrarySettings, edgeHoldAction, patternSourceKey, patternSpeedBounds,
  patternSourceLoop, buildPatternSourceContent, patternNameKey, isLoopablePattern,
  clearPatternSourceCache, patternSourceCacheSize,
} from '../../renderer/js/pattern-source.js';
import { listPatterns, describePattern, renderLoop, PATTERN_ENGINE_VERSION, MIN_LEG, MIN_BUZZ } from '../../renderer/js/pattern-library.js';
import { isOrgasmPatternKey, orgasmPatternKey } from '../../renderer/js/orgasm-pattern.js';
import { parseFinisherActions } from '../../renderer/js/orgasm-plan.js';
import { tileFinisherContent, TILE_MAX_ACTIONS } from '../../renderer/js/orgasm-handy-engage.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';
import { interpolatePosition } from '../../renderer/js/handy-hdsp-sync.js';

const require_ = createRequire(import.meta.url);
const { DEFAULTS, applyDefaults } = require_('../../electron/store.js');

// The catalogue's loops: the simple shapes (2026-11-19) loop as the Generated pattern did (instant edges, no widening)
// and are held to that in pattern-library-shapes.test.js.
const LOOPABLE = listPatterns({ loopable: true }).filter((p) => p.family !== 'simple-shapes').map((p) => p.id);
const ENDINGS = listPatterns({ loopable: false }).map((p) => p.id);
const actionsOf = (raw) => JSON.parse(raw).actions;

beforeEach(() => clearPatternSourceCache());

describe('settings: defaults are today, and an old config reads as today', () => {
  it('the store defaults match the module and are off / "stop"', () => {
    expect(DEFAULTS.settings.player.orgasmLibraryPattern).toEqual({ ...ORGASM_LIBRARY_DEFAULTS });
    expect(DEFAULTS.settings.player.edgePattern).toEqual({ ...EDGE_PATTERN_DEFAULTS });
    expect(DEFAULTS.settings.player.edgeHoldAction).toBe('stop');
    expect(ORGASM_LIBRARY_DEFAULTS.enabled).toBe(false);
    expect(orgasmLibrarySettings(DEFAULTS.settings.player.orgasmLibraryPattern)).toBeNull();
    expect(EDGE_HOLD_ACTIONS).toEqual(['stop', 'pattern']);
    // No default pattern (Dave, 2026-11-17): none is chosen until the user
    // picks one (the design's §j Q2 defaults are gone).
    expect(ORGASM_LIBRARY_DEFAULTS.id).toBeNull();
    expect(EDGE_PATTERN_DEFAULTS.id).toBeNull();
    expect(DEFAULTS.settings.player.orgasmLibraryPattern.id).toBeNull();
    expect(DEFAULTS.settings.player.edgePattern.id).toBeNull();
    // On, but no pattern chosen: the library source still does nothing.
    expect(orgasmLibrarySettings({ ...DEFAULTS.settings.player.orgasmLibraryPattern, enabled: true })).toBeNull();
  });

  it('a value saved before the default changed (an id chosen) keeps working', () => {
    const merged = applyDefaults({ player: { orgasmLibraryPattern: { enabled: true, id: 'quick-full-strokes', speed: null, reversed: false, min: null, max: null } } }, DEFAULTS.settings);
    expect(orgasmLibrarySettings(merged.player.orgasmLibraryPattern)).toMatchObject({ enabled: true, id: 'quick-full-strokes' });
    const edge = applyDefaults({ player: { edgePattern: { id: 'slow-tip-strokes' } } }, DEFAULTS.settings).player.edgePattern;
    expect(normalizePatternSource(edge, EDGE_PATTERN_DEFAULTS).id).toBe('slow-tip-strokes');
  });

  it('a config written before this version (no keys at all) reads back as off / "stop", every other value untouched', () => {
    const old = {
      player: {
        orgasmSwitchMode: 'toggle',
        edgeHoldMode: 'toggle',
        orgasmPattern: { enabled: true, type: 'square', bpm: 90, min: 10, max: 80 },
      },
    };
    const merged = applyDefaults(old, DEFAULTS.settings);
    expect(merged.player.orgasmSwitchMode).toBe('toggle');
    expect(merged.player.edgeHoldMode).toBe('toggle');
    expect(merged.player.orgasmPattern).toEqual(old.player.orgasmPattern);
    expect(orgasmLibrarySettings(merged.player.orgasmLibraryPattern)).toBeNull();
    expect(edgeHoldAction(merged.player.edgeHoldAction)).toBe('stop');
    // And with no merge at all (a main-process read of a missing key):
    expect(orgasmLibrarySettings(undefined)).toBeNull();
    expect(edgeHoldAction(undefined)).toBe('stop');
  });

  it('a partly written value keeps what is there and fills the rest', () => {
    const merged = applyDefaults({ player: { edgePattern: { id: 'slow-tip-strokes', speed: 90 } } }, DEFAULTS.settings);
    expect(merged.player.edgePattern).toEqual({ id: 'slow-tip-strokes', speed: 90, reversed: false, min: null, max: null });
  });
});

describe('normalizePatternSource', () => {
  it('only literal true turns a flag on; only "pattern" is the pattern mode', () => {
    expect(orgasmLibrarySettings({ enabled: 'yes' })).toBeNull();
    expect(orgasmLibrarySettings({ enabled: 1 })).toBeNull();
    expect(orgasmLibrarySettings({ enabled: true })).toBeNull();          // on, but no pattern chosen
    expect(orgasmLibrarySettings({ enabled: true, id: 'quick-full-strokes' })).toMatchObject({ enabled: true, id: 'quick-full-strokes' });
    expect(normalizePatternSource({ reversed: 'true' }).reversed).toBe(false);
    for (const v of ['Pattern', 'play', true, 1, null, '']) expect(edgeHoldAction(v)).toBe('stop');
    expect(edgeHoldAction('pattern')).toBe('pattern');
  });

  it('an unknown id or a missing one is "no pattern" (null); an ending is kept (it plays once)', () => {
    for (const id of ['no-such-pattern', undefined, null, 42, '']) {
      expect(normalizePatternSource({ id, speed: 200 }, ORGASM_LIBRARY_DEFAULTS)).toMatchObject({ id: null, speed: null });
      expect(normalizePatternSource({ id }, EDGE_PATTERN_DEFAULTS).id).toBeNull();
      expect(patternSourceKey({ id })).toBeNull();
      expect(patternSourceLoop({ id })).toBeNull();
      expect(buildPatternSourceContent({ id })).toBeNull();
    }
    expect(ENDINGS).toHaveLength(6);
    for (const id of ENDINGS) {
      expect(normalizePatternSource({ id }, ORGASM_LIBRARY_DEFAULTS).id).toBe(id);
      expect(normalizePatternSource({ id }, EDGE_PATTERN_DEFAULTS).id).toBe(id);
    }
  });

  it('speed: null or blank is the pattern\'s own; a number is clamped into the slider\'s bounds and rounded', () => {
    const b = patternSpeedBounds('quick-full-strokes');
    expect(normalizePatternSource({ id: 'quick-full-strokes', speed: null }).speed).toBeNull();
    expect(normalizePatternSource({ id: 'quick-full-strokes', speed: '' }).speed).toBeNull();
    expect(normalizePatternSource({ id: 'quick-full-strokes', speed: 'fast' }).speed).toBeNull();
    expect(normalizePatternSource({ id: 'quick-full-strokes', speed: 99999 }).speed).toBe(b.max);
    expect(normalizePatternSource({ id: 'quick-full-strokes', speed: 1 }).speed).toBe(b.min);
    expect(normalizePatternSource({ id: 'quick-full-strokes', speed: 180.6 }).speed).toBe(181);
  });

  it('range: two whole numbers 0-100 in order, or both null (the pattern\'s own place)', () => {
    expect(normalizePatternSource({ min: 80, max: 20 })).toMatchObject({ min: 20, max: 80 });
    expect(normalizePatternSource({ min: -5, max: 140 })).toMatchObject({ min: 0, max: 100 });
    expect(normalizePatternSource({ min: 30.4, max: 69.6 })).toMatchObject({ min: 30, max: 70 });
    expect(normalizePatternSource({ min: 30, max: null })).toMatchObject({ min: null, max: null });
    expect(normalizePatternSource({ min: 'x', max: 50 })).toMatchObject({ min: null, max: null });
  });

  it('the slider bounds hold the pattern\'s own speed and never pass the engine\'s cap', () => {
    for (const id of LOOPABLE) {
      const b = patternSpeedBounds(id);
      expect(b.min, id).toBeGreaterThanOrEqual(10);
      expect(b.max, id).toBeLessThanOrEqual(600);
      expect(b.own, id).toBeGreaterThanOrEqual(b.min);
      expect(b.own, id).toBeLessThanOrEqual(b.max);
      expect(Number.isInteger(b.min) && Number.isInteger(b.max) && Number.isInteger(b.own), id).toBe(true);
    }
    expect(patternSpeedBounds('nope')).toBeNull();
  });
});

describe('the key', () => {
  it('keeps the generated pattern\'s prefix, so nothing ever treats it as a file', () => {
    const key = patternSourceKey({ id: 'quick-full-strokes' });
    expect(isOrgasmPatternKey(key)).toBe(true);
    expect(key).toBe(`funsync-generated-pattern:library/v${PATTERN_ENGINE_VERSION}/quick-full-strokes/own/n/own/s1`);
    // It can never be one of the generated pattern's keys.
    expect(key).not.toBe(orgasmPatternKey({ type: 'sine', bpm: 120, min: 0, max: 100 }));
  });

  it('names every value that shapes the content (the Handy upload cache is keyed on it)', () => {
    const base = { id: 'quick-full-strokes', speed: null, reversed: false, min: null, max: null };
    const variants = [
      base,
      { ...base, id: 'slow-tip-strokes' },
      { ...base, speed: 250 },
      { ...base, reversed: true },
      { ...base, min: 20, max: 80 },
      { ...base, min: 20, max: 81 },
    ];
    const keys = variants.map(patternSourceKey);
    expect(new Set(keys).size).toBe(variants.length);
    // The same loop, written differently, is the same key.
    expect(patternSourceKey({ ...base, speed: 250.2 })).toBe(patternSourceKey({ ...base, speed: 250 }));
    expect(patternSourceKey({ ...base, min: 80, max: 20 })).toBe(patternSourceKey({ ...base, min: 20, max: 80 }));
  });
});

describe('the loop', () => {
  it('is the engine\'s seamless loop as funscript JSON, readable as a finisher file', () => {
    const p = { id: 'quick-full-strokes', speed: 220, reversed: true, min: 15, max: 85 };
    const raw = buildPatternSourceContent(p);
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ version: '1.0', inverted: false, range: 100 });
    const expected = renderLoop('quick-full-strokes', { speed: 220, reversed: true, range: { min: 15, max: 85 }, seed: 1 });
    expect(parsed.actions).toEqual(expected.actions);
    expect(parseFinisherActions(raw)).toEqual(expected.actions);
    expect(parsed.actions[0].at).toBe(0);
    expect(parsed.actions.at(-1).at).toBe(expected.loopMs);
    expect(parsed.actions.at(-1).pos).toBe(parsed.actions[0].pos);
  });

  it('own speed and own place: no speed or range is passed to the engine', () => {
    const raw = buildPatternSourceContent({ id: 'slow-tip-strokes' });
    expect(actionsOf(raw)).toEqual(renderLoop('slow-tip-strokes', { seed: 1 }).actions);
  });

  it('is deterministic: the same settings give the same bytes, after the cache is cleared too', () => {
    const p = { id: 'buzz-long-strokes', speed: 300, reversed: false, min: null, max: null };
    const a = buildPatternSourceContent(p);
    clearPatternSourceCache();
    expect(buildPatternSourceContent({ ...p })).toBe(a);
  });

  it('is rendered once per key and kept (a cache hit is the same loop, a new value a new render), a few at a time', () => {
    const p = { id: 'buzz-frantic-base-strokes' };
    const first = patternSourceLoop(p);
    expect(patternSourceCacheSize()).toBe(1);
    expect(patternSourceLoop({ ...p })).toBe(first);           // the very same object: no re-render
    expect(buildPatternSourceContent(p)).toBe(buildPatternSourceContent(p));
    expect(patternSourceCacheSize()).toBe(1);
    expect(patternSourceLoop({ ...p, reversed: true })).not.toBe(first);
    expect(patternSourceCacheSize()).toBe(2);
    // A dragged slider makes many keys: memory stays bounded.
    for (let s = 150; s < 450; s += 10) patternSourceLoop({ id: 'quick-full-strokes', speed: s });
    expect(patternSourceCacheSize()).toBeLessThanOrEqual(12);
  });

  it('a cache hit is fast even for the heaviest buzz loop', () => {
    patternSourceLoop({ id: 'buzz-frantic-base-strokes' });
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) buildPatternSourceContent({ id: 'buzz-frantic-base-strokes' });
    expect((performance.now() - t0) / 50).toBeLessThan(5);
  });

  it('every loopable pattern, plain and reversed: the Handy\'s tiled upload stays within the 8,000-action cap and every wrap joins (no jump, the minimum leg, the speed cap)', () => {
    const bad = [];
    for (const id of LOOPABLE) {
      for (const reversed of [false, true]) {
        const raw = buildPatternSourceContent({ id, reversed });
        const one = actionsOf(raw);
        const loopMs = one.at(-1).at;
        const tiled = actionsOf(tileFinisherContent(raw));
        if (tiled.length > TILE_MAX_ACTIONS) bad.push(`${id}${reversed ? ' r' : ''}: ${tiled.length} actions`);
        if (one.at(-1).pos !== one[0].pos) bad.push(`${id}${reversed ? ' r' : ''}: ends at ${one.at(-1).pos}, starts at ${one[0].pos}`);
        // The legs on both sides of each wrap in the tiled upload.
        const cap = Math.max(600, 1.5 * describePattern(id).speed) + 0.5;
        for (let k = 1; k <= 2; k++) {
          const i = tiled.findIndex((a) => a.at === k * loopMs);
          if (i < 1 || i + 1 >= tiled.length) { bad.push(`${id}: wrap ${k} not found`); continue; }
          for (const j of [i, i + 1]) {
            const dt = tiled[j].at - tiled[j - 1].at;
            const v = (Math.abs(tiled[j].pos - tiled[j - 1].pos) / dt) * 1000;
            if (dt < MIN_BUZZ) bad.push(`${id}${reversed ? ' r' : ''}: a ${dt} ms leg at wrap ${k}`);
            if (v > cap) bad.push(`${id}${reversed ? ' r' : ''}: ${Math.round(v)} u/s at wrap ${k}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(MIN_LEG).toBeGreaterThan(MIN_BUZZ);
  });

  it('the Handy\'s tiled upload and the REAL OrgasmSwitch\'s per-tick loop are at the same place through two wraps', () => {
    for (const p of [{ id: 'quick-full-strokes' }, { id: 'slow-tip-strokes', reversed: true }, { id: 'buzz-long-strokes', min: 20, max: 70 }]) {
      const raw = buildPatternSourceContent(p);
      const loopMs = actionsOf(raw).at(-1).at;
      const tiled = actionsOf(tileFinisherContent(raw));
      let clock = 0;
      const sw = new OrgasmSwitch({ now: () => clock });
      sw.setTimerImpl(() => 1, () => {});
      expect(sw.loadScript(raw)).toBe(true);
      expect(sw.activate()).toBe('activated');
      let firstMiss = null;
      for (let t = 0; t <= 2 * loopMs + 500 && firstMiss === null; t += 3) {
        clock = t;
        sw._tick();
        const handy = interpolatePosition(tiled, t);
        if (Math.abs(handy - sw._livePos) > 1e-6) firstMiss = { t, handy, local: sw._livePos };
      }
      expect(firstMiss, p.id).toBeNull();
      sw.deactivate();
    }
  });

  it('the name key is the pattern\'s own (none when no pattern is chosen)', () => {
    expect(patternNameKey({ id: 'quick-full-strokes' })).toBe('patterns.quick-full-strokes.name');
    expect(patternNameKey({ id: 'sprint-finish' })).toBe('patterns.sprint-finish.name');
    expect(patternNameKey({ id: 'gone' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix-up 2026-11-17 (review-1, minors): the slider's top is a hard ceiling for
// every leg, and the narrowest range still gives a loop that moves.
describe('caps and narrow ranges', () => {
  const legsOver = (actions, cap) => {
    const over = [];
    for (let i = 1; i < actions.length; i++) {
      const dt = actions[i].at - actions[i - 1].at;
      const v = (Math.abs(actions[i].pos - actions[i - 1].pos) / dt) * 1000;
      if (v > cap + 0.5) over.push(Math.round(v));
    }
    return over;
  };

  it('at the Speed slider\'s top no leg of any loopable pattern\'s loop passes 600 u/s, the wraps of the tiled upload included', () => {
    const bad = [];
    for (const id of LOOPABLE) {
      const raw = buildPatternSourceContent({ id, speed: patternSpeedBounds(id).max });
      const tiled = actionsOf(tileFinisherContent(raw));
      const over = legsOver(tiled.slice(0, 2 * actionsOf(raw).length + 2), 600);
      if (over.length) bad.push(`${id}: ${over.length} legs, up to ${Math.max(...over)} u/s`);
    }
    expect(bad).toEqual([]);
  });

  // 144 widening loop renders: ~4-6 s on a busy machine (measured 2026-11-19, the same before and after the simple
  // shapes), so it gets a timeout of its own like pattern-library.test.js's heavy cases.
  it('Lowest = Highest (the narrowest a range can be set) gives every loopable pattern a loop that moves', { timeout: 60000 }, () => {
    const bad = [];
    for (const id of LOOPABLE) {
      for (const speed of [null, patternSpeedBounds(id).max]) {
        const loop = patternSourceLoop({ id, speed, min: 50, max: 50 });
        const pos = loop ? loop.actions.map((a) => a.pos) : [];
        if (!loop || loop.actions.length < 3 || !(loop.loopMs > 0) || Math.max(...pos) === Math.min(...pos)) {
          bad.push(`${id} at ${speed ?? 'own'}: ${loop ? `${loop.actions.length} actions, ${loop.loopMs} ms` : 'none'}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('a band too narrow for the pattern is widened about its middle, and says so (it used to be a 1-action loop)', () => {
    // (In 20-25 it plays at its own speed; at its slowest it did not.)
    for (const [min, max, speeds] of [[20, 25, [172]], [50, 50, [null, 172]], [0, 0, [null, 172]], [100, 100, [null, 172]]]) {
      for (const speed of speeds) {
        const loop = patternSourceLoop({ id: 'mixed-flutters-tip', speed, min, max });
        expect(loop.actions.length, `${min}-${max}`).toBeGreaterThan(2);
        expect(loop.loopMs).toBeGreaterThan(0);
        expect(loop.actions[0].at).toBe(0);
        expect(loop.actions.at(-1).at).toBe(loop.loopMs);
        expect(loop.actions.at(-1).pos).toBe(loop.actions[0].pos);
        const w = loop.warnings.find((x) => x.code === 'range-widened');
        expect(w, `${min}-${max}`).toBeTruthy();
        const [lo, hi] = w.values.to;
        expect(lo).toBeLessThanOrEqual(min);
        expect(hi).toBeGreaterThanOrEqual(max);
        for (const a of loop.actions) {
          expect(a.pos).toBeGreaterThanOrEqual(lo - 1);
          expect(a.pos).toBeLessThanOrEqual(hi + 1);
        }
      }
    }
    // A band it can play in is left as it is.
    expect(patternSourceLoop({ id: 'mixed-flutters-tip', min: 30, max: 60 }).warnings).toEqual([]);
  });
});
