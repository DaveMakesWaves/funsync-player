/**
 * @vitest-environment jsdom
 * jsdom on purpose: ActionGraph draws on a real <canvas> element (its 2D
 * context is tests/setup.js's mock) and reads window.devicePixelRatio.
 */
// The graph's ghost layer (Fill with pattern, pattern library Round 2): the
// drawer's live preview, drawn as a dashed line over the real one. It is the
// GRAPH's, never the script's: setting, redrawing and clearing it leaves the
// actions, the selection, the undo history, the created record, the dirty
// flag and the revision exactly as they were.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionGraph } from '../../renderer/js/action-graph.js';
import { EditableScript } from '../../renderer/js/editable-script.js';

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 90 : 10 }));

function setup() {
  const canvas = document.createElement('canvas');
  const parent = document.createElement('div');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  // A real size: tests/setup.js's mock context has none, and the graph reads the canvas.
  canvas.width = 1000;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  ctx.setLineDash = vi.fn();
  for (const k of Object.keys(ctx)) if (typeof ctx[k]?.mockClear === 'function') ctx[k].mockClear();
  const es = new EditableScript();
  es.loadFromData({ actions: zigzag(9) });
  es.select(2);
  es.toggleSelect(6);
  const graph = new ActionGraph(canvas, es);
  graph.setViewport(0, 4000);
  return { graph, es, ctx };
}
const scriptState = (es) => JSON.stringify({
  json: es.toFunscriptJSON(),
  sel: [...es.selectedIndices].sort((a, b) => a - b),
  created: es.getCreatedIndices(),
  undo: es._undoStack.length,
  redo: es._redoStack.length,
  dirty: es.dirty,
  revision: es.revision,
});

beforeEach(() => { document.body.innerHTML = ''; });

describe('ActionGraph ghost layer', () => {
  it('setGhost / draw / clearGhost never change the script', () => {
    const { graph, es } = setup();
    const before = scriptState(es);
    const fill = [{ at: 1000, pos: 10 }, { at: 1300, pos: 80 }, { at: 1700, pos: 20 }, { at: 3000, pos: 10 }];
    graph.setGhost(fill, { from: 1000, to: 3000 });
    graph.draw();
    expect(scriptState(es)).toBe(before);
    expect(es.actions).toEqual(zigzag(9));
    graph.clearGhost();
    graph.draw();
    expect(scriptState(es)).toBe(before);
  });

  it('keeps its own sorted copy: changing the array it was given later changes nothing', () => {
    const { graph } = setup();
    const fill = [{ at: 2000, pos: 50 }, { at: 1500, pos: 20 }];
    graph.setGhost(fill, { from: 1000, to: 3000 });
    fill[0].pos = 99;
    fill.push({ at: 2500, pos: 1 });
    expect(graph.ghost.points).toEqual([{ at: 1500, pos: 20 }, { at: 2000, pos: 50 }]);
    expect(graph.ghost.from).toBe(1000);
    expect(graph.ghost.to).toBe(3000);
  });

  it('draws a dashed line over the real one while set, and none once cleared', () => {
    const { graph, ctx } = setup();
    graph.draw();
    const dashed = () => ctx.setLineDash.mock.calls.filter(([d]) => Array.isArray(d) && d.length > 0).length;
    expect(dashed()).toBe(0); // no bookmarks, no ghost: nothing dashed
    graph.setGhost([{ at: 1000, pos: 10 }, { at: 1250, pos: 90 }, { at: 1500, pos: 10 }], { from: 1000, to: 1500 });
    graph.draw();
    expect(dashed()).toBe(1);
    // The band over the filled stretch: a fillRect inside the drawing area.
    const band = ctx.fillRect.mock.calls.find(([x, , w]) => Math.abs(x - graph.timeToX(1000)) < 1 && Math.abs(w - (graph.timeToX(1500) - graph.timeToX(1000))) < 1);
    expect(band).toBeTruthy();
    ctx.setLineDash.mockClear();
    graph.clearGhost();
    graph.draw();
    expect(dashed()).toBe(0);
    expect(graph.ghost).toBeNull();
  });

  it('an empty or missing list clears it', () => {
    const { graph } = setup();
    graph.setGhost([{ at: 1000, pos: 10 }, { at: 2000, pos: 90 }]);
    expect(graph.ghost).not.toBeNull();
    graph.setGhost([]);
    expect(graph.ghost).toBeNull();
    graph.setGhost([{ at: 1000, pos: 10 }]);
    graph.setGhost(null);
    expect(graph.ghost).toBeNull();
  });
});
