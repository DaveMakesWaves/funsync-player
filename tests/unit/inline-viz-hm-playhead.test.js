/**
 * @vitest-environment jsdom
 * jsdom on purpose: InlineViz builds its overlay as DOM and branches on
 * `typeof window`, the REAL SettingsPanel opens through Modal.open(), and the
 * parity check draws through the REAL ProgressBar (notes/CLAUDE.md "Test
 * environments").
 */
// A playhead marker on the HM strip (zaikechi, EroScripts #381): "a marker
// showing where you are on the heatmap". Optional, `player.inlineHeatmapPlayhead`,
// OFF by default (Settings > Playback, under the overlay opacity).
//
// The marker is an element OVER the strip's canvas, never paint in it: the
// strip is cached, and its pixels are held to the seek bar's by
// heatmap-palette-parity.test.js. It follows the clock like the TL cursor,
// so the render loop must run for the HM strip alone when the marker is on,
// and it must land where the strip draws that moment (position over the
// VIDEO duration). What is asserted: where the marker is, whether it moves,
// that the canvas paints the same rects with it on, and that the setting is
// off until the user turns it on (the REAL panel, wired to app.js's own
// callback, lifted). The pop-out half is in player-popout-renderer.test.js.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { InlineViz, heatmapPlayheadFraction } from '../../renderer/components/inline-viz.js';
import { ProgressBar } from '../../renderer/js/progress-bar.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { heatmapSpeedToColor } from '../../renderer/js/heatmap-palette.js';
import { APP_SRC, liftAppClass, liftCtorOptions } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ACTIONS = [
  { at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 3000, pos: 20 },
  { at: 20000, pos: 90 }, { at: 40000, pos: 10 }, { at: 59000, pos: 80 },
];
const DURATION_S = 60;

// A frame queue we step by hand, so "does the loop run" is a fact.
let frames;
beforeEach(() => {
  document.body.innerHTML = '';
  frames = new Map();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb) => { id += 1; frames.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (h) => { frames.delete(h); });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => _setBundlesForTests('en', EN, EN));

function stepFrame() {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, cb] of pending) cb(performance.now());
}

/** A viz over a <video> whose clock and paused flag the test drives. */
function makeViz() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const video = document.createElement('video');
  let paused = true;
  let time = 0;
  Object.defineProperty(video, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(video, 'currentTime', { get: () => time, set: (v) => { time = v; }, configurable: true });
  const viz = new InlineViz({ container, video });
  const play = () => { paused = false; video.dispatchEvent(new Event('play')); };
  const pause = () => { paused = true; video.dispatchEvent(new Event('pause')); };
  const seek = (s) => { time = s; video.dispatchEvent(new Event('seeked')); };
  return { container, video, viz, play, pause, seek, setTime: (s) => { time = s; } };
}

const marker = (c) => c.querySelector('.inline-viz__hm-playhead');
const leftPct = (c) => parseFloat(marker(c).style.left);

describe('heatmapPlayheadFraction: where on the strip the marker sits', () => {
  it('is the position over the video duration, clamped to the strip', () => {
    expect(heatmapPlayheadFraction(0, 60000)).toBe(0);
    expect(heatmapPlayheadFraction(15000, 60000)).toBe(0.25);
    expect(heatmapPlayheadFraction(30000, 60000)).toBe(0.5);
    expect(heatmapPlayheadFraction(60000, 60000)).toBe(1);
    expect(heatmapPlayheadFraction(75000, 60000)).toBe(1);
    expect(heatmapPlayheadFraction(-10, 60000)).toBe(0);
  });

  it('is 0 while the duration is unknown', () => {
    expect(heatmapPlayheadFraction(5000, 0)).toBe(0);
    expect(heatmapPlayheadFraction(5000, NaN)).toBe(0);
    expect(heatmapPlayheadFraction(NaN, 60000)).toBe(0);
  });

  it('lands where the strip draws that moment (the same at / duration mapping)', () => {
    // The strip puts an action at (at / durationMs) of its width.
    const a = ACTIONS[3];
    expect(heatmapPlayheadFraction(a.at, DURATION_S * 1000)).toBe(a.at / (DURATION_S * 1000));
  });
});

describe('the HM playhead marker (#381)', () => {
  it('is off by default: no marker, and no render loop for the HM strip alone (as before)', () => {
    const { container, viz, play } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setHeatmapVisible(true);
    play();
    expect(marker(container).hidden).toBe(true);
    expect(frames.size).toBe(0);
    expect(viz._raf).toBeNull();
  });

  it('turned on, the loop runs with the HM strip alone and the marker follows the clock', () => {
    const { container, viz, play, setTime } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setHeatmapVisible(true);
    viz.setHeatmapPlayhead(true);
    expect(viz.timelineVisible).toBe(false);
    expect(marker(container).hidden).toBe(false);

    setTime(15);
    play();
    expect(frames.size).toBe(1);
    stepFrame();
    expect(leftPct(container)).toBeCloseTo(25);

    setTime(30);
    stepFrame();
    expect(leftPct(container)).toBeCloseTo(50);
    expect(frames.size).toBe(1); // still scheduled: it keeps following
  });

  it('pause stops the loop and leaves the marker at the paused spot; a seek while paused moves it', () => {
    const { container, viz, play, pause, seek, setTime } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setHeatmapVisible(true);
    viz.setHeatmapPlayhead(true);
    play();
    setTime(42);
    pause();
    expect(frames.size).toBe(0);
    expect(viz._raf).toBeNull();
    expect(leftPct(container)).toBeCloseTo(70);

    seek(6);
    expect(frames.size).toBe(0);
    expect(leftPct(container)).toBeCloseTo(10);
  });

  it('a seek while playing jumps the marker and keeps the loop going', () => {
    const { container, viz, play, seek } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setHeatmapVisible(true);
    viz.setHeatmapPlayhead(true);
    play();
    seek(54);
    expect(leftPct(container)).toBeCloseTo(90);
    expect(frames.size).toBe(1);
  });

  it('needs the HM strip and a script: hidden, and no loop, without either', () => {
    const { container, viz, play } = makeViz();
    viz.setHeatmapPlayhead(true);
    viz.setHeatmapVisible(true);
    play();
    expect(marker(container).hidden).toBe(true); // no script
    expect(frames.size).toBe(0);

    viz.setScript(ACTIONS, DURATION_S);
    expect(marker(container).hidden).toBe(false);
    expect(frames.size).toBe(1);

    viz.setHeatmapVisible(false);
    expect(marker(container).hidden).toBe(true);
    stepFrame();
    expect(frames.size).toBe(0); // the loop ended with nothing left to follow
  });

  it('turning the HM strip on while playing with the marker on starts the loop', () => {
    const { viz, play } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setHeatmapPlayhead(true);
    play();
    expect(frames.size).toBe(0);
    viz.setHeatmapVisible(true);
    expect(frames.size).toBe(1);
  });

  it('turning the TL off keeps the loop for the marker; turning the marker off then ends it', () => {
    const { viz, play } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setTimelineVisible(true);
    viz.setHeatmapVisible(true);
    viz.setHeatmapPlayhead(true);
    play();
    viz.setTimelineVisible(false);
    stepFrame();
    expect(frames.size).toBe(1);
    viz.setHeatmapPlayhead(false);
    expect(frames.size).toBe(0);
  });

  it('is never painted into the strip: the canvas draws the same rects, in the seek bar\'s colours', () => {
    function recordingContext() {
      const fills = [];
      return {
        fills, fillStyle: '', strokeStyle: '', lineWidth: 1,
        fillRect() { fills.push(this.fillStyle); },
        clearRect() {}, setTransform() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      };
    }
    const stripFills = (playheadOn) => {
      document.body.innerHTML = '';
      const { container, viz, play, setTime } = makeViz();
      const canvas = container.querySelector('.inline-viz__heatmap');
      Object.defineProperty(canvas, 'clientWidth', { value: 1000, configurable: true });
      Object.defineProperty(canvas, 'clientHeight', { value: 22, configurable: true });
      const ctx = recordingContext();
      canvas.getContext = () => ctx;
      viz.setHeatmapPlayhead(playheadOn);
      viz.setScript(ACTIONS, DURATION_S);
      viz.setHeatmapVisible(true);
      setTime(20);
      play();
      stepFrame();
      stepFrame();
      return ctx.fills;
    };
    const off = stripFills(false);
    const on = stripFills(true);
    expect(on).toEqual(off);
    expect(on).toHaveLength(ACTIONS.length - 1); // one rect per pair, nothing else

    document.body.innerHTML = `
      <div id="progress-container"><div id="tooltip-thumbnail"></div><canvas id="heatmap-canvas"></canvas>
      <div id="chapter-strip-container" hidden><canvas id="chapter-strip-canvas"></canvas></div></div>`;
    const bar = new ProgressBar({
      containerElement: document.getElementById('progress-container'),
      videoPlayer: { video: document.createElement('video') },
      backendPort: 5123,
    });
    const barCtx = recordingContext();
    bar.heatmapCtx = barCtx;
    bar.heatmapCanvas.parentElement.getBoundingClientRect = () => ({ width: 1000, height: 8, left: 0, top: 0 });
    bar.renderHeatmap(ACTIONS, DURATION_S);
    expect(on).toEqual(barCtx.fills);
  });

  it('sits over the canvas, in the strip\'s own box, so the layout is unchanged', () => {
    const { container, viz } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setHeatmapVisible(true);
    viz.setHeatmapPlayhead(true);
    const canvas = container.querySelector('.inline-viz__heatmap');
    expect(marker(container).parentElement).toBe(canvas.parentElement);
    expect(canvas.tagName).toBe('CANVAS');
    // Off again: the wrap holds only the strip as before.
    viz.setHeatmapPlayhead(false);
    expect(marker(container).hidden).toBe(true);
    expect(canvas.hidden).toBe(false);
  });
});

// --- The setting: off by default, applied live through app.js -------------

describe('Settings > Playback "Playhead on the heatmap strip" (#381)', () => {
  let store;
  let showing;

  const appOptions = liftCtorOptions('SettingsPanel', { showToast: vi.fn(), t });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    store = {};
    _setBundlesForTests('en', EN, EN);
    window.funsync = {
      setSetting: () => {},
      onGlobalShortcut: () => {},
      setGlobalShortcuts: async () => [],
      convertFunscript: async () => null,
    };
  });
  afterEach(async () => {
    document.querySelector('.settings-panel__done-btn')?.click();
    await showing;
  });

  async function openPlayback(app) {
    const panel = new SettingsPanel(appOptions.call(app));
    showing = panel.show();
    document.querySelector('.settings-panel__rail-item[data-area="playback"]').click();
    await flush();
    return panel;
  }

  it('the store default is off', async () => {
    const { DEFAULTS } = await import('../../electron/store.js');
    expect(DEFAULTS.settings.player.inlineHeatmapPlayhead).toBe(false);
  });

  it('unticked until set; ticking it saves and shows the marker on the live strip at once', async () => {
    const { container, viz, play } = makeViz();
    viz.setScript(ACTIONS, DURATION_S);
    viz.setHeatmapVisible(true);
    play();
    const app = {
      settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getAll: () => ({}) },
      inlineViz: viz,
      _orgasmSummaryText: () => [],
    };
    await openPlayback(app);
    const box = document.querySelector('#sp-hm-playhead');
    expect(box.checked).toBe(false);
    expect(document.querySelector(`label[for="sp-hm-playhead"]`).textContent).toBe(EN.settingsPanel.playback.heatmapPlayheadLabel);
    expect(marker(container).hidden).toBe(true);

    box.click();
    expect(store['player.inlineHeatmapPlayhead']).toBe(true);
    expect(marker(container).hidden).toBe(false);
    // The overlay's loop is running (the dialog schedules frames of its own).
    expect(viz._raf).not.toBeNull();

    box.click();
    expect(store['player.inlineHeatmapPlayhead']).toBe(false);
    expect(marker(container).hidden).toBe(true);
  });

  // FT-028 (2026-11-05, new since v0.9.2): a change while the pop-out is
  // open reached it only on its next open. app.js's REAL Settings callbacks
  // (lifted with the panel's options) now send INLINE_VIZ_STATE.
  it('ticking it, or moving the opacity slider, while the pop-out is open tells the pop-out at once; closed, nothing is sent', async () => {
    const sent = [];
    const Lifted = liftAppClass(['_sendPlayerWindowInlineVizState', '_applyInlineVizOpacity', '_inlineTimelineView'], {
      window: { funsync: { playerPopoutRelay: (dir, msg) => sent.push([dir, msg]) } },
      PLAYERWIN,
      INLINE_VIZ_OPACITY_DEFAULT: Number(/const INLINE_VIZ_OPACITY_DEFAULT = (\d+);/.exec(APP_SRC)[1]),
    });
    const app = Object.assign(new Lifted(), {
      settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getAll: () => ({}) },
      inlineViz: null,
      _orgasmSummaryText: () => [],
      _playerWindowOpen: true,
      _playerWindowActive: true,
    });
    await openPlayback(app);
    document.querySelector('#sp-hm-playhead').click();
    expect(sent).toEqual([['to-popout', { type: PLAYERWIN.INLINE_VIZ_STATE, playhead: true, opacity: 80, placement: 'overlay', timelineView: { windowMs: 5000, anchor: 'centre' } }]]);

    const slider = document.querySelector('#sp-inline-viz-opacity');
    slider.value = '50';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent.at(-1)).toEqual(['to-popout', { type: PLAYERWIN.INLINE_VIZ_STATE, playhead: true, opacity: 50, placement: 'overlay', timelineView: { windowMs: 5000, anchor: 'centre' } }]);

    app._playerWindowOpen = false;
    app._playerWindowActive = false;
    const n = sent.length;
    document.querySelector('#sp-hm-playhead').click();
    slider.value = '70';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent).toHaveLength(n);
  });

  it('the pop-out is told the setting when it opens (it reuses InlineViz)', () => {
    const sent = [];
    const Lifted = liftAppClass(['_sendPlayerWindowInitialState', '_inlineTimelineView'], {
      window: { funsync: { playerPopoutRelay: (dir, msg) => sent.push([dir, msg]) } },
      document: { documentElement: { dataset: {} } },
      PLAYERWIN,
      INLINE_VIZ_OPACITY_DEFAULT: Number(/const INLINE_VIZ_OPACITY_DEFAULT = (\d+);/.exec(APP_SRC)[1]),
    });
    const app = new Lifted();
    app.settings = { get: (k) => store[k] };
    app._sendPlayerWindowInitialState();
    store['player.inlineHeatmapPlayhead'] = true;
    app._sendPlayerWindowInitialState();
    expect(sent.map(([, m]) => m.inlineViz.playhead)).toEqual([false, true]);
  });
});

// FT-027 (2026-11-05, new since v0.9.2): the marker was the TL cursor's
// #4caf50, about 2:1 against the heatmap's pure green and lost in its cyan
// and yellow, so over the middle of the speed scale there was no marker to
// see. The rule in player.css (the main window and the pop-out both load it)
// now draws a white core with a dark 1px outline; for every colour the strip
// can paint, the core or the outline must reach 3:1 (WCAG 1.4.11, non-text
// contrast). What is read is the shipped stylesheet, not a copy.
describe('the HM playhead marker stands out on every heatmap colour (FT-027)', () => {
  const CSS = fs.readFileSync('renderer/styles/player.css', 'utf8');
  /** The body of the rule written exactly `<selector> {` in player.css. */
  const rule = (selector) => {
    const at = CSS.indexOf(`${selector} {`);
    expect(at, `${selector} rule in player.css`).toBeGreaterThanOrEqual(0);
    return CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  };
  /** A declaration's value in a rule body, or null. */
  const decl = (body, prop) => {
    const d = body.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${prop}:`));
    return d ? d.slice(prop.length + 1).trim() : null;
  };

  /** First colour in a declaration value: #rgb, #rrggbb, rgb() or rgba(). */
  function colourIn(value) {
    if (!value) return null;
    const hex = value.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    const fn = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
    if (fn) return { r: +fn[1], g: +fn[2], b: +fn[3], a: fn[4] === undefined ? 1 : +fn[4] };
    return null;
  }
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrast = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  /** A translucent colour as it lands on `bg`. */
  const over = (c, bg) => ({ r: c.a * c.r + (1 - c.a) * bg.r, g: c.a * c.g + (1 - c.a) * bg.g, b: c.a * c.b + (1 - c.a) * bg.b });

  const SAMPLES = Array.from({ length: 21 }, (_, k) => {
    const speed = Math.round(k * 5) / 100;            // 0, 0.05, ... 1.0 (saturates at 0.5)
    return { speed, colour: colourIn(heatmapSpeedToColor(speed)) };
  });

  /** For each sample, the better of core and outline; [] when all pass. */
  function misses(core, outline) {
    const out = [];
    for (const { speed, colour } of SAMPLES) {
      const c = core ? contrast(over(core, colour), colour) : 0;
      const o = outline ? contrast(over(outline, colour), colour) : 0;
      if (Math.max(c, o) < 3) out.push(`${speed} → ${heatmapSpeedToColor(speed)}: core ${c.toFixed(2)}, outline ${o.toFixed(2)}`);
    }
    return out;
  }

  it('samples the whole scale, blue through green and yellow to red', () => {
    expect(SAMPLES.every((s) => s.colour)).toBe(true);
    expect(heatmapSpeedToColor(0.25)).toBe('rgb(0, 255, 0)');   // the green that hid the old marker
  });

  it('the line: its core or its outline is at least 3:1 against every heatmap colour', () => {
    const body = rule('.inline-viz__hm-playhead');
    const core = colourIn(decl(body, 'background') ?? decl(body, 'background-color'));
    const outline = colourIn(decl(body, 'box-shadow'));
    expect(core, 'line colour').toBeTruthy();
    expect(misses(core, outline)).toEqual([]);
  });

  it('the caret on top: the same, through its drop-shadow outline', () => {
    const body = rule('.inline-viz__hm-playhead::before');
    const core = colourIn(decl(body, 'border-top'));
    const outline = colourIn(decl(body, 'filter'));
    expect(core, 'caret colour').toBeTruthy();
    expect(misses(core, outline)).toEqual([]);
  });

  it('the old #4caf50 marker with no outline fails on green (what this fixes)', () => {
    const old = colourIn('#4caf50');
    expect(misses(old, null).some((m) => m.startsWith('0.25 '))).toBe(true);
  });
});
