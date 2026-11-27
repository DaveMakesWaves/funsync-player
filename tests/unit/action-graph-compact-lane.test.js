/**
 * @vitest-environment jsdom
 * jsdom: the graph draws on a canvas and measures it on screen.
 */
// Stacked lanes that fit (Dave, 2026-11-24: "for more than 3 axis the stacked
// axis mode only shows 3 max on editor and on the popout the bottom axis goes
// off screen"). A lane's graph is compact (slim padding; no scale numbers,
// time labels or heatmap strip, the main graph shows those) so it stays
// readable at 30 px, and its time axis lines up with the main graph's on
// screen however the lane is inset or narrowed by a scrollbar. Asserted on the
// drawn area and on where a moment lands on screen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionGraph } from '../../renderer/js/action-graph.js';
import { EditableScript } from '../../renderer/js/editable-script.js';

function graphAt(rect, { w = rect.width, h = rect.height } = {}) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.width = w;
  canvas.height = h;
  canvas.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top });
  const ctx = canvas.getContext('2d');
  ctx.setLineDash = vi.fn();
  const es = new EditableScript();
  es.loadFromData({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }] });
  const graph = new ActionGraph(canvas, es);
  graph.setViewport(0, 4000);
  return { graph, ctx, canvas };
}
const screenX = (g, ms) => g.canvas.getBoundingClientRect().left + g.timeToX(ms);

beforeEach(() => { document.body.innerHTML = ''; });

describe('a compact lane', () => {
  it('keeps nearly all of a 30 px lane for the curve (a full graph keeps 0 of it)', () => {
    const { graph } = graphAt({ left: 0, top: 0, width: 800, height: 30 });
    expect(graph._drawArea().h).toBeLessThan(0);           // 30 - 10 - 28: nothing to draw in
    graph.setCompact(true);
    expect(graph._drawArea().h).toBe(24);                  // 30 - 3 - 3
    graph.setCompact(false);
    expect(graph._drawArea().h).toBeLessThan(0);
  });

  it('draws no scale numbers, time labels or heatmap strip', () => {
    const { graph, ctx } = graphAt({ left: 0, top: 0, width: 800, height: 48 });
    graph.draw();
    const full = ctx.fillText.mock.calls.length;
    expect(full).toBeGreaterThan(5);
    ctx.fillText.mockClear();
    graph.setCompact(true);
    graph.draw();
    const labels = ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(labels.filter((s) => /^(0|25|50|75|100)$/.test(s) || /\d:\d\d/.test(s))).toEqual([]);
  });
});

describe('a lane lines up with the main graph', () => {
  it('inset by its box and narrowed by a scrollbar, the same moment lands at the same x', () => {
    const main = graphAt({ left: 0, top: 300, width: 1280, height: 182 }).graph;
    // The lane: 5 px in (padding + border), 1280 - 10 - 8 (a scrollbar) wide.
    const lane = graphAt({ left: 5, top: 100, width: 1262, height: 40 }).graph;
    lane.setCompact(true);
    // Before: fixed padding put both ends off (the start 5 px, the end 13).
    expect(Math.abs(screenX(lane, 0) - screenX(main, 0))).toBeGreaterThan(3);
    lane.alignTo(main);
    for (const ms of [0, 1000, 2500, 4000]) expect(Math.round(screenX(lane, ms))).toBe(Math.round(screenX(main, ms)));
  });
  it('a full graph, or one not on screen, is left alone', () => {
    const main = graphAt({ left: 0, top: 0, width: 1000, height: 182 }).graph;
    const full = graphAt({ left: 5, top: 0, width: 990, height: 40 }).graph;
    const before = { ...full._padding };
    full.alignTo(main);
    expect(full._padding).toEqual(before);
    const hidden = graphAt({ left: 0, top: 0, width: 0, height: 0 }, { w: 300, h: 40 }).graph;
    hidden.setCompact(true);
    const was = { ...hidden._padding };
    hidden.alignTo(main);
    expect(hidden._padding).toEqual(was);
  });
});
