/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ProgressBar and InlineViz draw into canvases,
 * and inline-viz.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// App test 2026-11-02, V36 (EroScripts #381, zaikechi): the HM overlay strip
// and the seek-bar heatmap under it coloured the same script differently.
// The strip used the editor's OFS scale (black at rest, saturating at
// 0.3 pos/ms) and the seek bar its own (blue at rest, saturating at
// 0.5 pos/ms), so the overlay "went red at a lower speed". A code comment
// and the v0.9.0 notes both claimed one shared palette.
//
// Pinned on what is drawn: the same script goes through the real seek bar
// and the real overlay strip, and every rect each one paints is recorded.
// The script editor and the overlay's TL graph keep the OFS palette on
// purpose (the OFS convention editor users know); action-graph.test.js
// pins that one.
import { describe, it, expect, beforeEach } from 'vitest';
import { ProgressBar } from '../../renderer/js/progress-bar.js';
import { InlineViz } from '../../renderer/components/inline-viz.js';
import { ActionGraph } from '../../renderer/js/action-graph.js';

/** A 2D context that records the fill colour of every rect painted. */
function recordingContext() {
  const fills = [];
  return {
    fills,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect() { fills.push(this.fillStyle); },
    clearRect() {},
    setTransform() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
}

// One stroke per speed band, slow to past saturation (pos-units per ms):
// 0.02 0.1 0.2 0.25 0.3 0.4 0.6
const SPEEDS = [0.02, 0.1, 0.2, 0.25, 0.3, 0.4, 0.6];
const ACTIONS = (() => {
  const out = [{ at: 0, pos: 0 }];
  let at = 0;
  let pos = 0;
  for (const s of SPEEDS) {
    // Move 60 units at speed s: dt = 60 / s ms, alternating direction.
    at += Math.round(60 / s);
    pos = pos === 0 ? 60 : 0;
    out.push({ at, pos });
  }
  return out;
})();
const DURATION_SEC = Math.ceil(ACTIONS[ACTIONS.length - 1].at / 1000) + 1;

function seekBarFills() {
  document.body.innerHTML = `
    <div id="progress-container">
      <div id="tooltip-thumbnail"></div>
      <canvas id="heatmap-canvas"></canvas>
      <div id="chapter-strip-container" hidden><canvas id="chapter-strip-canvas"></canvas></div>
    </div>`;
  const bar = new ProgressBar({
    containerElement: document.getElementById('progress-container'),
    videoPlayer: { video: document.createElement('video') },
    backendPort: 5123,
  });
  const ctx = recordingContext();
  bar.heatmapCtx = ctx;
  bar.heatmapCanvas.parentElement.getBoundingClientRect = () => ({ width: 1000, height: 8, left: 0, top: 0 });
  bar.renderHeatmap(ACTIONS, DURATION_SEC);
  return ctx.fills;
}

function overlayStripFills() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const viz = new InlineViz({ container, video: document.createElement('video') });
  const canvas = container.querySelector('.inline-viz__heatmap');
  Object.defineProperty(canvas, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 22, configurable: true });
  const ctx = recordingContext();
  canvas.getContext = () => ctx;
  viz.setScript(ACTIONS, DURATION_SEC);
  viz.setHeatmapVisible(true);
  return ctx.fills;
}

describe('the HM overlay strip and the seek-bar heatmap use one colour scale', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('the same script paints the same colours, stroke for stroke', () => {
    const bar = seekBarFills();
    const strip = overlayStripFills();
    expect(bar).toHaveLength(SPEEDS.length);
    expect(strip).toEqual(bar);
  });

  it('0.3 pos/ms is yellow-orange in both, not red in the overlay (#381)', () => {
    const i = SPEEDS.indexOf(0.3);
    const bar = seekBarFills();
    const strip = overlayStripFills();
    expect(strip[i]).toBe(bar[i]);
    expect(strip[i]).not.toBe('rgb(255,0,0)');
    expect(strip[i]).not.toBe('rgb(255, 0, 0)');
    // Only past the seek bar's saturation point is it red.
    expect(strip[SPEEDS.indexOf(0.6)]).toBe('rgb(255, 0, 0)');
  });

  it('a slow stroke is blue in both, never the editor black', () => {
    const strip = overlayStripFills();
    expect(strip[0]).toMatch(/^rgb\(0, \d+, \d+\)$/);
    expect(strip[0]).not.toBe(ActionGraph.speedToColor(SPEEDS[0]));
  });
});
