// The player's script viewer (the TL strip, inline-viz.js) and the editor share
// one long-lived ActionGraph each. Dave, 2026-11-18: "if you use it on a video
// and leave it open when the video closes and open another one it moves
// wayyyyy faster than the video". Cause (reproduced live on the frozen build):
// `ActionGraph.setVideoDuration` clamped only the window's END, so a 5 s window
// left near the end of a 12 s video became 1 s wide for an 8 s video, and the
// graph scrolled that narrow window five times too fast; it shrank further with
// every video. These tests drive the real ActionGraph and the real InlineViz.

import { describe, it, expect, beforeEach } from 'vitest';
import { ActionGraph } from '../../renderer/js/action-graph.js';
import { InlineViz, INLINE_VIEW_MS } from '../../renderer/components/inline-viz.js';

const ACTIONS = [
  { at: 0, pos: 0 },
  { at: 500, pos: 100 },
  { at: 1000, pos: 20 },
  { at: 7000, pos: 80 },
];

function makeGraph() {
  const canvas = document.createElement('canvas');
  return new ActionGraph(canvas, { actions: ACTIONS, selectedIndices: new Set(), getBookmarks: () => [] });
}

function makeViz() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const video = document.createElement('video');
  const viz = new InlineViz({ container, video });
  return { video, viz };
}

describe('ActionGraph.setVideoDuration keeps the window width', () => {
  it('a window near the end of a longer video keeps its 5 s width for a shorter one', () => {
    const g = makeGraph();
    g.setVideoDuration(12000);
    g.setViewport(7000, 12000);
    expect(g.viewDurationMs).toBe(5000);

    g.setVideoDuration(8000);
    expect(g.viewDurationMs).toBe(5000);   // was 1000: 7000..8000
    expect(g.viewEndMs).toBe(8000);
    expect(g.viewStartMs).toBe(3000);
  });

  it('the editor\'s own zoom width survives a video change', () => {
    const g = makeGraph();
    g.setVideoDuration(600000);
    g.setViewport(590000, 600000);          // a 10 s zoom at the very end
    g.setVideoDuration(120000);
    expect(g.viewDurationMs).toBe(10000);
    expect(g.viewEndMs).toBe(120000);
  });

  it('a window already inside the new duration is left exactly where it is', () => {
    const g = makeGraph();
    g.setVideoDuration(60000);
    g.setViewport(2000, 7000);
    g.setVideoDuration(30000);
    expect([g.viewStartMs, g.viewEndMs]).toEqual([2000, 7000]);
  });

  it('only a video shorter than the window narrows it (to the video), and an unknown duration clamps nothing', () => {
    const g = makeGraph();
    g.setViewport(0, 5000);
    g.setVideoDuration(3000);
    expect([g.viewStartMs, g.viewEndMs]).toEqual([0, 3000]);
    g.setVideoDuration(0);
    expect(g.viewDurationMs).toBe(3000);
  });
});

describe('the TL strip starts every video on its default window', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('Dave\'s sequence: near the end of a 12 s video, then an 8 s video: 5 s window, not 1 s', () => {
    const { viz } = makeViz();
    viz.setTimelineVisible(true);
    viz.setScript(ACTIONS, 12);
    viz._graph.centerOnTime(11500);         // what the loop does near the end
    expect(viz._graph.viewEndMs).toBe(12000);

    viz.setScript(ACTIONS, 8);
    expect(viz._graph.viewDurationMs).toBe(INLINE_VIEW_MS);
  });

  it('it never compounds: 12 s, 11 s, 8 s videos in a row all get the full window', () => {
    const { viz } = makeViz();
    viz.setTimelineVisible(true);
    for (const sec of [12, 11, 8]) {
      viz.setScript(ACTIONS, sec);
      viz._graph.centerOnTime(sec * 1000 - 300);
      expect(viz._graph.viewDurationMs).toBe(INLINE_VIEW_MS);
    }
  });

  it('a very short video does not leave a narrow window for the next, longer one', () => {
    const { viz } = makeViz();
    viz.setTimelineVisible(true);
    viz.setScript(ACTIONS, 3);              // shorter than the window
    expect(viz._graph.viewDurationMs).toBe(3000);
    viz.setScript(ACTIONS, 60);
    expect(viz._graph.viewDurationMs).toBe(INLINE_VIEW_MS);
  });

  it('a script with no known duration still gets the full window', () => {
    const { viz } = makeViz();
    viz.setTimelineVisible(true);
    viz.setScript(ACTIONS, 3);
    viz.setScript(ACTIONS, 0);
    expect(viz._graph.viewDurationMs).toBe(INLINE_VIEW_MS);
  });
});
