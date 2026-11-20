/**
 * @vitest-environment jsdom
 * jsdom on purpose: ActionGraph draws on a real <canvas> element (its 2D
 * context is tests/setup.js's mock) and reads window.devicePixelRatio.
 */
// With Curves on, the drawn line (and the Fill drawer's dashed ghost) is a
// cubic Hermite curve through the points. Next to a turn it could swing past
// an end stop between two points that are in range (verifier-2: under the 0
// line between 2.0 s and 2.9 s, next to a kept point at 4000:50). The curve is
// held to the 0-100 lines; drawing only, the script never changes (fixup-2).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActionGraph } from '../../renderer/js/action-graph.js';
import { EditableScript } from '../../renderer/js/editable-script.js';

// Strokes 0/100 every 250 ms to 2.0 s, then 4000:50, then strokes again from 6.0 s: the shape of the report.
function reportShape() {
  const a = [];
  for (let t = 0; t <= 2000; t += 250) a.push({ at: t, pos: (t / 250) % 2 ? 100 : 0 });
  a.push({ at: 4000, pos: 50 });
  for (let t = 6000; t <= 8000; t += 250) a.push({ at: t, pos: ((t - 6000) / 250) % 2 ? 100 : 0 });
  return a;
}

let paths = [];
let OrigPath2D;
beforeEach(() => {
  document.body.innerHTML = '';
  OrigPath2D = globalThis.Path2D;
  paths = [];
  globalThis.Path2D = class {
    constructor() { this.pts = []; paths.push(this); }
    moveTo(x, y) { this.pts.push([x, y]); }
    lineTo(x, y) { this.pts.push([x, y]); }
    closePath() {}
    arc() {}
    rect() {}
  };
});
afterEach(() => { globalThis.Path2D = OrigPath2D; });

function setup(actions) {
  const canvas = document.createElement('canvas');
  const parent = document.createElement('div');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  canvas.width = 1000;
  canvas.height = 200;
  canvas.getContext('2d').setLineDash = () => {};
  const es = new EditableScript();
  es.loadFromData({ actions });
  const graph = new ActionGraph(canvas, es);
  graph.setViewport(0, 8000);
  return { graph, es };
}

const ys = () => paths.flatMap((p) => p.pts.map(([, y]) => y));

describe('ActionGraph: the drawn curve stays inside 0-100', () => {
  it('the line with Curves on never dips below the 0 line or above the 100 line, and still curves', () => {
    const { graph, es } = setup(reportShape());
    const before = JSON.stringify(es.toFunscriptJSON());
    expect(graph._splineMode).toBe(true); // Curves is on by default
    graph.draw();
    const top = graph.posToY(100), bottom = graph.posToY(0);
    const all = ys();
    expect(all.length).toBeGreaterThan(100);
    for (const y of all) {
      expect(y).toBeGreaterThanOrEqual(top - 1e-9);
      expect(y).toBeLessThanOrEqual(bottom + 1e-9);
    }
    // still a curve: between 2.0 s and 4.0 s some drawn points lie off the straight line 2000:0 -> 4000:50
    const x1 = graph.timeToX(2000), x2 = graph.timeToX(4000), y1 = graph.posToY(0), y2 = graph.posToY(50);
    const inner = paths.flatMap((p) => p.pts).filter(([x]) => x > x1 + 1 && x < x2 - 1);
    expect(inner.some(([x, y]) => Math.abs(y - (y1 + ((y2 - y1) * (x - x1)) / (x2 - x1))) > 2)).toBe(true);
    // drawing only
    expect(JSON.stringify(es.toFunscriptJSON())).toBe(before);
  });

  it('the Fill preview\'s dashed ghost is held the same way', () => {
    const { graph } = setup([{ at: 0, pos: 50 }, { at: 8000, pos: 50 }]);
    graph.setGhost(reportShape(), { from: 0, to: 8000 });
    graph.draw();
    const top = graph.posToY(100), bottom = graph.posToY(0);
    const all = ys();
    expect(all.length).toBeGreaterThan(100);
    for (const y of all) {
      expect(y).toBeGreaterThanOrEqual(top - 1e-9);
      expect(y).toBeLessThanOrEqual(bottom + 1e-9);
    }
  });

  it('with Curves off the straight line is drawn as before', () => {
    const { graph } = setup(reportShape());
    graph._splineMode = false;
    graph.draw();
    const pts = paths.flatMap((p) => p.pts);
    // every drawn point is one of the script's points
    const want = new Set(reportShape().map((a) => `${graph.timeToX(a.at).toFixed(3)},${graph.posToY(a.pos).toFixed(3)}`));
    const conn = pts.filter(([x, y]) => want.has(`${x.toFixed(3)},${y.toFixed(3)}`));
    expect(conn.length).toBeGreaterThan(30);
  });
});
