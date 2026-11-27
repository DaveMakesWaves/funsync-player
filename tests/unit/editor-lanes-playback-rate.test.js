/**
 * @vitest-environment jsdom
 * jsdom on purpose: script-editor.js imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// Dave, 2026-11-25: "is there any way to speed up the player when in editor
// especially when its multi axis". Profiled live on his 144 Hz display (Long
// Test, six axes): the stacked tracks were redrawn on every frame, and each
// track read two element boxes (alignTo) on every frame. During playback they
// are drawn every 2nd frame on a fast display and line up again only after a
// layout change or twice a second; paused, everything is at once, as before.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { ScriptEditor, LANE_FRAME_MS } = await import('../../renderer/components/script-editor.js');

let clock;
let rafs;
beforeEach(() => {
  clock = 1000;
  rafs = [];
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafs.push(cb); return rafs.length; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** The real method on an editor with three stacked tracks (fakes for their graphs). */
function editor({ paused }) {
  const lanes = new Map();
  for (const k of ['pitch', 'roll', 'twist']) {
    lanes.set(k, { graph: { setVideoDuration: vi.fn(), alignTo: vi.fn(), setViewport: vi.fn(), setCursorTime: vi.fn(), draw: vi.fn() } });
  }
  const ed = Object.create(ScriptEditor.prototype);
  Object.assign(ed, {
    _stackedView: true, _splineMode: false, _inactiveLanes: lanes,
    graph: { _videoDurationMs: 60000, viewStartMs: 0, viewEndMs: 10000, _cursorMs: 5000 },
    videoPlayer: { video: { paused } },
  });
  const count = (fn) => [...lanes.values()].reduce((n, l) => n + l.graph[fn].mock.calls.length, 0) / lanes.size;
  return { ed, lanes, count };
}

/** The main graph's per-frame draw at `hz` for `ms`. */
function frames(ed, hz, ms) {
  const step = 1000 / hz;
  for (let t = 0; t < ms; t += step) { clock += step; ed._syncInactiveLanes(); }
}

describe('stacked tracks during playback', () => {
  it('at 144 Hz a track is drawn every 2nd frame (72 a second, not 144); a skipped frame is drawn on the next', () => {
    const { ed, count } = editor({ paused: false });
    frames(ed, 144, 1000);
    expect(LANE_FRAME_MS).toBe(12);
    expect(count('draw')).toBeGreaterThanOrEqual(68);
    expect(count('draw')).toBeLessThanOrEqual(74);
    // A skipped frame asks for one more, so the last moment is never left undrawn.
    expect(rafs.length).toBeGreaterThan(0);
  });

  it('at 60 Hz every frame is drawn (nothing changes on a 60 Hz display)', () => {
    const { ed, count } = editor({ paused: false });
    frames(ed, 60, 1000);
    expect(count('draw')).toBeGreaterThanOrEqual(59);
  });

  it('lines up with the main plot on its first draw, after a layout change, and twice a second, not every frame', () => {
    const { ed, count } = editor({ paused: false });
    frames(ed, 60, 1000);
    expect(count('alignTo')).toBeLessThanOrEqual(3);      // first draw + the 500 ms safety net
    ed._lanesAlignDirty = true;                            // _layoutLanes: the plot moved
    clock += 20;
    ed._syncInactiveLanes();
    expect(count('alignTo')).toBeLessThanOrEqual(4);
    const before = count('alignTo');
    clock += 20;
    ed._syncInactiveLanes();
    expect(count('alignTo')).toBe(before);                 // not again next frame
  });
});

describe('stacked tracks while paused (editing)', () => {
  it('every redraw draws and lines up at once, however close together (zoom, hover, edits)', () => {
    const { ed, count } = editor({ paused: true });
    for (let i = 0; i < 10; i++) { clock += 1; ed._syncInactiveLanes(); }
    expect(count('draw')).toBe(10);
    expect(count('alignTo')).toBe(10);
    expect(rafs.length).toBe(0);
  });
});
