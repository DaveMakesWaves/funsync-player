// Unit tests for ActionGraph — imports from real source
import { describe, it, expect, beforeEach } from 'vitest';
import { ActionGraph } from '../../renderer/js/action-graph.js';
import { EditableScript } from '../../renderer/js/editable-script.js';

describe('ActionGraph', () => {
  let graph, script, canvas;

  beforeEach(() => {
    // Create a canvas and set dimensions (jsdom canvas)
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    // Mock parentElement for resize operations
    const parent = document.createElement('div');
    parent.appendChild(canvas);
    parent.getBoundingClientRect = () => ({ width: 800, height: 400 });
    document.body.appendChild(parent);

    script = new EditableScript();
    graph = new ActionGraph(canvas, script);
  });

  // --- Viewport ---

  describe('setViewport', () => {
    it('sets start and end times', () => {
      graph.setViewport(1000, 5000);
      expect(graph.viewStartMs).toBe(1000);
      expect(graph.viewEndMs).toBe(5000);
      expect(graph.viewDurationMs).toBe(4000);
    });

    it('enforces minimum 1s duration', () => {
      graph.setViewport(1000, 1500);
      expect(graph.viewDurationMs).toBeGreaterThanOrEqual(1000);
    });

    it('enforces maximum 300s duration', () => {
      graph.setViewport(0, 500000);
      expect(graph.viewDurationMs).toBeLessThanOrEqual(300000);
    });

    it('clamps start to >= 0', () => {
      graph.setViewport(-1000, 3000);
      expect(graph.viewStartMs).toBe(0);
    });

    it('respects video duration', () => {
      graph.setVideoDuration(10000);
      graph.setViewport(8000, 20000);
      expect(graph.viewEndMs).toBeLessThanOrEqual(10000);
    });
  });

  describe('centerOnTime', () => {
    it('centers viewport on given time', () => {
      graph.setViewport(0, 4000);
      graph.centerOnTime(5000);
      // Should center the 4000ms window around 5000ms
      expect(graph.viewStartMs).toBe(3000);
      expect(graph.viewEndMs).toBe(7000);
    });
  });

  describe('panBy', () => {
    it('pans viewport by delta', () => {
      graph.setViewport(1000, 5000);
      graph.panBy(2000);
      expect(graph.viewStartMs).toBe(3000);
      expect(graph.viewEndMs).toBe(7000);
    });

    it('pans backwards', () => {
      graph.setViewport(3000, 7000);
      graph.panBy(-1000);
      expect(graph.viewStartMs).toBe(2000);
      expect(graph.viewEndMs).toBe(6000);
    });
  });

  describe('zoomAt', () => {
    it('zooms in (smaller duration)', () => {
      graph.setViewport(0, 10000);
      const durationBefore = graph.viewDurationMs;
      graph.zoomAt(5000, 0.5);
      expect(graph.viewDurationMs).toBeLessThan(durationBefore);
    });

    it('zooms out (larger duration)', () => {
      graph.setViewport(0, 5000);
      const durationBefore = graph.viewDurationMs;
      graph.zoomAt(2500, 2.0);
      expect(graph.viewDurationMs).toBeGreaterThan(durationBefore);
    });

    it('clamps zoom to minimum 1s', () => {
      graph.setViewport(0, 2000);
      graph.zoomAt(1000, 0.1);
      expect(graph.viewDurationMs).toBeGreaterThanOrEqual(1000);
    });

    it('clamps zoom to maximum 300s', () => {
      graph.setViewport(0, 200000);
      graph.zoomAt(100000, 10);
      expect(graph.viewDurationMs).toBeLessThanOrEqual(300000);
    });
  });

  // --- Coordinate mapping ---

  describe('timeToX / xToTime round-trip', () => {
    it('round-trips correctly', () => {
      graph.setViewport(0, 10000);
      const time = 5000;
      const x = graph.timeToX(time);
      const recoveredTime = graph.xToTime(x);
      expect(Math.abs(recoveredTime - time)).toBeLessThan(1);
    });

    it('maps viewport start to left edge', () => {
      graph.setViewport(1000, 5000);
      const x = graph.timeToX(1000);
      expect(x).toBe(graph._padding.left);
    });
  });

  describe('posToY / yToPos round-trip', () => {
    it('round-trips correctly', () => {
      const pos = 75;
      const y = graph.posToY(pos);
      const recoveredPos = graph.yToPos(y);
      expect(Math.abs(recoveredPos - pos)).toBeLessThan(1);
    });

    it('pos 100 maps to top (y close to padding.top)', () => {
      const y100 = graph.posToY(100);
      const y0 = graph.posToY(0);
      expect(y100).toBeLessThan(y0);
    });

    it('clamps yToPos to 0-100', () => {
      expect(graph.yToPos(-1000)).toBe(100);
      expect(graph.yToPos(10000)).toBe(0);
    });
  });

  // --- Hit testing ---

  describe('hitTestAction', () => {
    it('finds action within radius', () => {
      script.insertAction(2500, 50);
      graph.setViewport(0, 5000);
      const x = graph.timeToX(2500);
      const y = graph.posToY(50);
      const idx = graph.hitTestAction(x, y);
      expect(idx).toBe(0);
    });

    it('returns -1 when no action nearby', () => {
      script.insertAction(2500, 50);
      graph.setViewport(0, 5000);
      const idx = graph.hitTestAction(0, 0, 5);
      expect(idx).toBe(-1);
    });

    it('finds closest when multiple nearby', () => {
      script.insertAction(2500, 50);
      script.insertAction(2600, 55);
      graph.setViewport(0, 5000);
      const x = graph.timeToX(2500);
      const y = graph.posToY(50);
      const idx = graph.hitTestAction(x, y);
      expect(idx).toBe(0);
    });
  });

  describe('hitTestRect', () => {
    it('selects actions within rectangle', () => {
      script.insertAction(1000, 20);
      script.insertAction(2000, 50);
      script.insertAction(3000, 80);
      graph.setViewport(0, 5000);

      const x1 = graph.timeToX(500);
      const y1 = graph.posToY(90);
      const x2 = graph.timeToX(2500);
      const y2 = graph.posToY(10);

      const indices = graph.hitTestRect({ x1, y1, x2, y2 });
      expect(indices.has(0)).toBe(true);
      expect(indices.has(1)).toBe(true);
      expect(indices.has(2)).toBe(false); // at 3000, outside rect
    });

    it('returns empty set when no actions in rect', () => {
      script.insertAction(5000, 50);
      graph.setViewport(0, 10000);
      const indices = graph.hitTestRect({ x1: 0, y1: 0, x2: 10, y2: 10 });
      expect(indices.size).toBe(0);
    });

    it('handles reversed coordinates', () => {
      script.insertAction(2000, 50);
      graph.setViewport(0, 5000);
      const x1 = graph.timeToX(1000);
      const y1 = graph.posToY(30);
      const x2 = graph.timeToX(3000);
      const y2 = graph.posToY(70);
      // Reversed: x2,y2 before x1,y1
      const indices = graph.hitTestRect({ x1: x2, y1: y2, x2: x1, y2: y1 });
      expect(indices.has(0)).toBe(true);
    });
  });

  // --- Static speedToColor ---

  describe('ActionGraph.speedToColor', () => {
    it('returns black for zero speed', () => {
      expect(ActionGraph.speedToColor(0)).toBe('rgb(0,0,0)');
    });

    it('returns red for high speed', () => {
      expect(ActionGraph.speedToColor(0.3)).toBe('rgb(255,0,0)');
    });

    it('clamps above max speed', () => {
      expect(ActionGraph.speedToColor(1.0)).toBe('rgb(255,0,0)');
    });

    it('returns blue-ish for low speed', () => {
      const color = ActionGraph.speedToColor(0.06);
      expect(color).toMatch(/^rgb\(/);
      // At normalized=0.2, should be pure blue
      expect(ActionGraph.speedToColor(0.06)).toBe('rgb(0,0,255)');
    });

    it('returns green for medium speed', () => {
      // normalized = 0.6 → green (idx 3)
      const speed = 0.3 * 0.6;
      const color = ActionGraph.speedToColor(speed);
      expect(color).toBe('rgb(0,255,0)');
    });
  });

  // --- _monotoneTangents ---

  describe('_monotoneTangents', () => {
    it('returns constant slope for 2 points', () => {
      const xs = [0, 100];
      const ys = [0, 100];
      const tangents = graph._monotoneTangents(xs, ys);
      expect(tangents[0]).toBeCloseTo(1);
      expect(tangents[1]).toBeCloseTo(1);
    });

    it('returns zero tangents for flat segment', () => {
      const xs = [0, 100, 200];
      const ys = [50, 50, 50];
      const tangents = graph._monotoneTangents(xs, ys);
      expect(tangents[0]).toBe(0);
      expect(tangents[1]).toBe(0);
      expect(tangents[2]).toBe(0);
    });

    it('returns empty for empty input', () => {
      const tangents = graph._monotoneTangents([], []);
      expect(tangents.length).toBe(0);
    });

    it('produces valid tangents for monotone data', () => {
      const xs = [0, 100, 200, 300];
      const ys = [0, 30, 60, 100];
      const tangents = graph._monotoneTangents(xs, ys);
      expect(tangents.length).toBe(4);
      // All tangents should be positive for monotonically increasing data
      for (const t of tangents) {
        expect(t).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // --- fitAll ---

  describe('fitAll', () => {
    it('fits to action range', () => {
      script.insertAction(5000, 0);
      script.insertAction(15000, 100);
      graph.fitAll();
      expect(graph.viewStartMs).toBeLessThan(5000);
      expect(graph.viewEndMs).toBeGreaterThan(15000);
    });

    it('shows default 5s when no actions and no video', () => {
      graph.fitAll();
      expect(graph.viewStartMs).toBe(0);
      expect(graph.viewEndMs).toBe(5000);
    });

    it('uses video duration when no actions but video loaded', () => {
      graph.setVideoDuration(30000);
      graph.fitAll();
      expect(graph.viewEndMs).toBeLessThanOrEqual(30000);
    });
  });
});
