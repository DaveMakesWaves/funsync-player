/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel builds the T-Code axis rows and
 * draws the motion preview on a canvas, and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// FT-020 (2026-11-05, verifier 2; new since v0.9.2): "Blending for generated
// axes" (dio_likes_jojo, EroScripts #320) shipped in the engine only. The
// change log promised a slider and a preview that shows the blend; the R0 row
// had Depth, Full travel, Speed and the preview, and no blend control. Worse,
// `commitMotion` built the motion object without `blend`, so moving ANY other
// control in the row saved over a blend set some other way. And the preview
// blended against an UNSHAPED stroke while the engine blends against the
// stroke shaped by Depth and the travel half, so at 100% the two disagreed.
//
// What runs is REAL: the ConnectionPanel's axis rows, a REAL TCodeSync behind
// it, and motion-source's sampleMotion. Asserted on what is saved, what the
// engine is handed, and what the preview draws.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { sampleMotion, shapeGeneratedValue, patternValue } from '../../renderer/js/motion-source.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));
beforeEach(() => { _setBundlesForTests('en', EN, EN); document.body.innerHTML = '<div id="app"></div>'; });

function build(axes = {}) {
  const map = new Map([['tcode.axes', axes]]);
  const settings = {
    get: (k) => map.get(k),
    set: vi.fn((k, v) => map.set(k, structuredClone(v))),
    getPlaylists: () => [], getPlaylist: () => null,
    getCategories: () => [], getCategory: () => null, getVideosByCategory: () => [],
  };
  const tcodeSync = new TCodeSync({
    videoPlayer: { currentTime: 0, paused: true, duration: 60, video: { addEventListener() {}, removeEventListener() {} } },
    funscriptEngine: { isLoaded: false, getActions: () => [] },
    tcodeManager: { connected: false, sendAxes: vi.fn(), stop: vi.fn() },
  });
  const panel = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings, tcodeSync });
  panel._renderTCodeAxes();
  const row = panel._panel.querySelector('.connection-panel__tcode-axis-row[data-axis="R0"]');
  const selects = row.querySelectorAll('select');
  const el = {
    row,
    motion: selects[0],
    blend: row.querySelector('.connection-panel__motion-blend'),
    blendRow: row.querySelector('.connection-panel__motion-blend-row'),
    // Depth: the first slider of the shaping row (the one with the travel-half select).
    depth: [...row.querySelectorAll('.connection-panel__device-safety')]
      .find((r) => r.querySelector('option[value="top"]'))?.querySelector('input[type="range"]'),
  };
  const saved = () => map.get('tcode.axes')?.R0?.motion;
  return { panel, tcodeSync, el, saved, settings };
}

const input = (elm, value) => { elm.value = String(value); elm.dispatchEvent(new Event('input')); };
const change = (elm, value) => { elm.value = value; elm.dispatchEvent(new Event('change')); };

describe('FT-020: the generated-axis blend has a control, and it is saved', () => {
  it('Random shows a Blend slider with the saved value, labelled and explained', () => {
    const { el } = build({ R0: { motion: { mode: 'random', depth: 100, blend: 40 } } });
    expect(el.blend).not.toBeNull();
    expect(el.blendRow.hidden).toBe(false);
    expect(el.blend.value).toBe('40');
    expect(el.blendRow.textContent).toContain('Blend');
    expect(el.blendRow.textContent).toContain('40%');
    expect(el.blend.getAttribute('aria-label')).toBe(EN.connection.tcode.motionBlend);
    expect(el.blend.title).toBe(EN.connection.tcode.motionBlendHint);
  });

  it('moving it saves the blend and hands it to the engine', () => {
    const { el, saved, tcodeSync } = build({ R0: { motion: { mode: 'random' } } });
    input(el.blend, 70);
    expect(saved()).toMatchObject({ mode: 'random', blend: 70 });
    expect(tcodeSync.getAxisMotion('R0')).toMatchObject({ mode: 'random', blend: 70 });
  });

  it('changing another control in the row keeps the blend (it used to be dropped)', () => {
    const { el, saved, tcodeSync } = build({ R0: { motion: { mode: 'pattern', pattern: 'sine', blend: 55 } } });
    input(el.depth, 60);
    change(el.motion, 'random');
    expect(saved()).toMatchObject({ mode: 'random', depth: 60, blend: 55 });
    expect(tcodeSync.getAxisMotion('R0').blend).toBe(55);
  });

  it('hidden for Follow stroke (it already is the stroke) and Script only, and the value survives the round trip', () => {
    const { el, saved } = build({ R0: { motion: { mode: 'random', blend: 30 } } });
    change(el.motion, 'link');
    expect(el.blendRow.hidden).toBe(true);
    expect(saved().blend).toBe(30);
    change(el.motion, 'script');
    expect(el.blendRow.hidden).toBe(true);
    expect(saved()).toBeNull();
    change(el.motion, 'random');
    expect(el.blendRow.hidden).toBe(false);
    expect(saved().blend).toBe(30);
  });

  it("the row's preview draws the blend: at 100% it is the Follow stroke drawing", () => {
    const { el } = build({ R0: { motion: { mode: 'pattern', pattern: 'square', depth: 40, half: 'top', blend: 0 } } });
    const ctx = el.row.querySelector('canvas').getContext('2d'); // tests/setup.js mock
    const drawn = () => ctx.lineTo.mock.calls.map(([, y]) => Math.round(y * 1000) / 1000);
    ctx.lineTo.mockClear();
    input(el.blend, 100);
    const blended = drawn();
    ctx.lineTo.mockClear();
    change(el.motion, 'link');
    const link = drawn();
    ctx.lineTo.mockClear();
    change(el.motion, 'pattern');
    input(el.blend, 0);
    const pure = drawn();
    expect(blended.length).toBeGreaterThan(100);
    expect(blended).toEqual(link);
    expect(pure).not.toEqual(link);
  });

  it('follows the axis enable toggle like the other motion controls', () => {
    const { el } = build({ R0: { enabled: false, motion: { mode: 'random' } } });
    expect(el.blend.disabled).toBe(true);
  });
});

describe('FT-020: the preview curve shows what the engine will do', () => {
  const opts = { samples: 64 };

  it('at 100% the curve is the Follow stroke curve, Depth and travel half included', () => {
    for (const shape of [{ depth: 40, half: 'top' }, { depth: 70, half: 'bottom' }, { depth: 100, half: 'off' }]) {
      const full = sampleMotion({ mode: 'pattern', pattern: 'square', blend: 100, ...shape }, opts);
      const link = sampleMotion({ mode: 'link', ...shape }, opts);
      full.forEach((v, i) => expect(v).toBeCloseTo(link[i], 6));
    }
  });

  it('at 50% it sits halfway between the pattern and the stroke', () => {
    const shape = { depth: 40, half: 'off' };
    const mid = sampleMotion({ mode: 'pattern', pattern: 'square', blend: 50, ...shape }, opts);
    const pure = sampleMotion({ mode: 'pattern', pattern: 'square', blend: 0, ...shape }, opts);
    const link = sampleMotion({ mode: 'link', ...shape }, opts);
    mid.forEach((v, i) => expect(v).toBeCloseTo((pure[i] + link[i]) / 2, 6));
  });

  it('Follow stroke ignores a stored blend, as the engine does', () => {
    const plain = sampleMotion({ mode: 'link', depth: 40 }, opts);
    const withBlend = sampleMotion({ mode: 'link', depth: 40, blend: 80 }, opts);
    expect(withBlend).toEqual(plain);
  });

  it('the engine lands on the shaped stroke at 100%: same rule as the preview', () => {
    // tcode-sync.js blends toward shapeGeneratedValue(beat.pos, cfg); the
    // preview's stroke reference is the link curve, shaped the same way.
    const cfg = { depth: 40, half: 'top' };
    const u = 0.3;
    const stroke = patternValue('sine', u * 4 * 2);
    const preview = sampleMotion({ mode: 'pattern', pattern: 'saw', blend: 100, ...cfg }, { samples: 11 })[3];
    expect(preview).toBeCloseTo(shapeGeneratedValue(stroke, cfg), 6);
  });
});
