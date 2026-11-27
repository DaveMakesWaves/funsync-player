/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its DOM, and i18n.js
 * branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Shift+drag to move points (test day 2026-11-24).
// B031: a dragged point ignored Snap to frame (a click, a position key and
// Shift+Left/Right all snap), and the docked editor added each mousemove's
// raw delta, rounded to the ms, to the last, so a long drag drifted off the
// cursor (100 moves of 1.4 ms moved the point 100 ms, not 140).
// B032: the pop-out updated points by the index they had at the press; once
// the point passed a neighbour (the list re-sorts by time) the NEIGHBOUR
// moved, and a point on the drag's path was dropped at once. Both editors
// now step through renderer/js/editor-drag-move.js; the pop-out sends the
// steps as OP_MOVE_ACTIONS.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { applyPopoutEdit } = await import('../../renderer/js/editor-popout-dispatch.js');
const { startDragMove, dragMoveStep } = await import('../../renderer/js/editor-drag-move.js');
const P = await import('../../renderer/js/editor-popout-protocol.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const FRAME = 1000 / 30;
const onGrid = (ms) => Math.abs(ms - Math.round(ms / FRAME) * FRAME) <= 0.5;
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);

document.body.innerHTML = '<div id="player-container"></div>';

/** The real docked editor; 1 px = 1 ms across, 1 px = 1 position unit down. */
function makeEditor(actions, { snap = true } = {}) {
  const video = Object.assign(new EventTarget(), { currentTime: 0, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 0 });
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed.editableScript.loadFromData({ actions });
  ed._sendLivePreview = () => {};
  ed._panel.removeAttribute('inert');
  ed._snapToFrame = snap;
  ed.graph.getCanvasCoords = (e) => ({ x: e.clientX, y: e.clientY });
  ed.graph.xToTime = (x) => x;
  ed.graph.yToPos = (y) => 100 - y;
  ed.graph.hitTestAction = (x) => ed.editableScript.actions.findIndex((a) => Math.abs(a.at - x) < 5);
  return ed;
}
const mouse = (x, y, extra = {}) => ({ button: 0, clientX: x, clientY: y, preventDefault() {}, ...extra });
function drag(ed, from, path) {
  ed._onMouseDown(mouse(from.x, from.y, { shiftKey: true }));
  for (const p of path) ed._onMouseMove(mouse(p.x, p.y));
  ed._onMouseUp(mouse(path.at(-1).x, path.at(-1).y));
}

beforeEach(() => { _setBundlesForTests('en', EN, EN); });

describe('docked: Shift+drag (B031)', () => {
  it('with Snap to frame on, the dragged point lands on a frame start', () => {
    const ed = makeEditor([{ at: 0, pos: 0 }, { at: 1000, pos: 50 }, { at: 3000, pos: 0 }]);
    drag(ed, { x: 1000, y: 50 }, [{ x: 1020, y: 50 }, { x: 1047, y: 40 }]);
    const moved = ed.editableScript.actions[1];
    expect(moved.at).toBe(Math.round(31 * FRAME));   // 1047 ms -> the nearest frame, 1033.3
    expect(onGrid(moved.at)).toBe(true);
    expect(moved.pos).toBe(60);
  });

  it('a long drag of small steps stays with the cursor (no ms rounding builds up)', () => {
    const ed = makeEditor([{ at: 0, pos: 0 }, { at: 1000, pos: 50 }, { at: 9000, pos: 0 }], { snap: false });
    const path = Array.from({ length: 100 }, (_, i) => ({ x: 1000 + 1.4 * (i + 1), y: 50 }));
    drag(ed, { x: 1000, y: 50 }, path);
    expect(ed.editableScript.actions[1].at).toBe(1140);
  });

  it('a drag is still one undo step, and a point under the drag\'s path is kept', () => {
    const ed = makeEditor([{ at: 0, pos: 0 }, { at: 1000, pos: 50 }, { at: 2000, pos: 0 }, { at: 3000, pos: 50 }], { snap: false });
    drag(ed, { x: 1000, y: 50 }, [{ x: 2000, y: 50 }, { x: 2500, y: 50 }]);
    expect(pairs(ed.editableScript)).toEqual(['0:0', '2000:0', '2500:50', '3000:50']);
    ed.editableScript.undo();
    expect(pairs(ed.editableScript)).toEqual(['0:0', '1000:50', '2000:0', '3000:50']);
  });
});

describe('the shared step (editor-drag-move.js)', () => {
  it('whole-ms steps that add up to exactly where the cursor says, snapped or not', () => {
    const snap = (ms) => Math.round(ms / FRAME) * FRAME;
    const st = startDragMove({ anchorAt: 1000, anchorPos: 50, cursorAt: 1003, cursorPos: 52 });
    let at = 1000;
    for (let i = 1; i <= 200; i++) {
      const d = dragMoveStep(st, { cursorAt: 1003 + i * 0.73, cursorPos: 52, snap });
      if (d) { expect(Number.isInteger(d.deltaAt)).toBe(true); at += d.deltaAt; }
    }
    expect(at).toBe(Math.round(snap(1000 + 200 * 0.73)));
    expect(dragMoveStep(st, { cursorAt: 1003 + 200 * 0.73, cursorPos: 52, snap })).toBeNull();
  });
});

describe('pop-out: a drag sent as OP_MOVE_ACTIONS steps (B032)', () => {
  it('passing a neighbour moves only the grabbed point; the neighbour stays', () => {
    const es = new EditableScript();
    es.loadFromData({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 50 }, { at: 2000, pos: 0 }, { at: 3000, pos: 50 }] });
    applyPopoutEdit(es, { op: P.OP_SELECT, indices: [1] });
    applyPopoutEdit(es, { op: P.OP_BEGIN_BATCH });
    const st = startDragMove({ anchorAt: 1000, anchorPos: 50, cursorAt: 1000, cursorPos: 50 });
    for (const x of [1500, 2000, 2200, 2600]) {
      const d = dragMoveStep(st, { cursorAt: x, cursorPos: 50 });
      if (d) applyPopoutEdit(es, { op: P.OP_MOVE_ACTIONS, ...d });
    }
    applyPopoutEdit(es, { op: P.OP_END_BATCH });
    expect(pairs(es)).toEqual(['0:0', '2000:0', '2600:50', '3000:50']);
  });

  it('the pop-out sends the drag as these steps, never OP_UPDATE by index', () => {
    // Its canvas math is private to the page; the live check drove it.
    const src = fs.readFileSync('renderer/editor-popout.js', 'utf8');
    const move = src.slice(src.indexOf("if (dragState.mode === 'move') {"), src.indexOf("} else if (dragState.mode === 'rubber')"));
    expect(move).toMatch(/dragMoveStep\(/);
    expect(move).toMatch(/OP_MOVE_ACTIONS/);
    expect(move).not.toMatch(/OP_UPDATE/);
  });
});
