/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar and canvas on
 * the DOM and its keys are real KeyboardEvents on the canvas; script-editor.js
 * imports DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// CB-02 (OFS add-or-edit): the editor never holds two points at one time.
//
// The verifier's three cases, in both editors (the pop-out's keys and paste
// reach the same parent code through _handlePopoutMessage):
//   - a number key on a frame holding an UNSELECTED point added a second one
//     (2000/50 next to 2000/5): it now gives that point the new position;
//   - Ctrl+V at 6 s over existing points made duplicates at 6000 and 6250:
//     a pasted point now replaces the point at its time;
//   - Range Extend x2 on idx 15-17 left two points at 4750: the modifier's
//     point now replaces the unselected one there.
// Moves, a drag, Equalize and the generators follow the same rule, and a file
// that already has duplicates loads as it is (only edits enforce the rule).
//
// Assertions are on the script the user ends up with: (time, position) pairs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { rangeExtend, offsetTime } = await import('../../renderer/js/script-modifiers.js');
const PROTOCOL = await import('../../renderer/js/editor-popout-protocol.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

/** 33 points, 250 ms apart, alternating 5 / 95: a shape like Alpha Scene. */
const ALPHA = Array.from({ length: 33 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 95 : 5 }));
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);
const at = (es, ms) => pairs(es).filter((p) => p.startsWith(`${ms}:`));
const timesAreUnique = (es) => new Set(es.actions.map((a) => a.at)).size === es.actions.length;
const isSorted = (es) => es.actions.every((a, i, arr) => i === 0 || arr[i - 1].at <= a.at);

document.body.innerHTML = '<div id="player-container"></div>';

function makeEditor(actions, { currentTime = 0 } = {}) {
  const video = Object.assign(new EventTarget(), { currentTime, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime });
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed.editableScript.loadFromData({ actions });
  ed._sendLivePreview = () => {};
  // Open, as the user has it: a closed editor is inert and takes no keys
  // (round 2, editor-closed-not-interactive.test.js).
  ed._panel.removeAttribute('inert');
  return ed;
}
const seek = (ed, ms) => { ed.videoPlayer.currentTime = ms / 1000; ed.videoPlayer.video.currentTime = ms / 1000; };
const press = (ed, key, { code, ctrl = false, shift = false } = {}) => ed._canvas.dispatchEvent(new KeyboardEvent('keydown', {
  key, code, bubbles: true, cancelable: true, ctrlKey: ctrl, shiftKey: shift,
}));
const scriptOf = (actions) => {
  const es = new EditableScript();
  es.loadFromData({ actions });
  return es;
};

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
});

describe('a position key on a frame that already holds a point (CB-02)', () => {
  it('docked: 5 at 2000 over an UNSELECTED 2000/5 gives it 50, one point, one undo step', () => {
    const ed = makeEditor(ALPHA);
    const es = ed.editableScript;
    es.select(3); // something else is selected, so FT-032's sole-selected tweak does not apply
    seek(ed, 2000);
    press(ed, '5', { code: 'Digit5' });
    expect(at(es, 2000)).toEqual(['2000:50']);
    expect(es.actions).toHaveLength(33);
    expect(es.dirty).toBe(true);
    expect(es._undoStack).toHaveLength(1);
    expect(es.actions[es.selectedIndices.values().next().value]).toEqual({ at: 2000, pos: 50 });
    es.undo();
    expect(at(es, 2000)).toEqual(['2000:5']);
  });

  it('docked: the same key again on that frame changes nothing and records nothing', () => {
    const ed = makeEditor(ALPHA);
    const es = ed.editableScript;
    es.clearSelection();
    seek(ed, 2000);
    press(ed, '0', { code: 'Digit0' }); // 2000 already holds 5... 0 is a change
    expect(at(es, 2000)).toEqual(['2000:0']);
    const steps = es._undoStack.length;
    es.clearSelection();
    press(ed, '0', { code: 'Digit0' });
    expect(at(es, 2000)).toEqual(['2000:0']);
    expect(es._undoStack.length).toBe(steps);
  });

  it('pop-out: OP_PLACE_AT on a frame with an unselected point edits it too', () => {
    const ed = makeEditor(ALPHA);
    const es = ed.editableScript;
    es.select(0);
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_PLACE_AT, { at: 2000, pos: 50 }));
    expect(at(es, 2000)).toEqual(['2000:50']);
    expect(es.actions).toHaveLength(33);
  });

  it('a free frame still gets a new point, and FT-032\'s sole-selected tweak still holds', () => {
    const ed = makeEditor(ALPHA);
    const es = ed.editableScript;
    seek(ed, 2100); // snaps to 2100 (63 frames)
    press(ed, '7', { code: 'Digit7' });
    expect(at(es, 2100)).toEqual(['2100:70']);
    expect(es.actions).toHaveLength(34);
    press(ed, '3', { code: 'Digit3' }); // the new point is the sole selection on this frame
    expect(at(es, 2100)).toEqual(['2100:30']);
    expect(es.actions).toHaveLength(34);
  });
});

describe('paste replaces the points at the pasted times (CB-02)', () => {
  it('docked Ctrl+V at 6 s over existing points: one point at 6000 and at 6250, the pasted ones', () => {
    const ed = makeEditor(ALPHA);
    const es = ed.editableScript;
    es._selectedIndices = new Set([4, 5]); // 1000:5, 1250:95
    press(ed, 'c', { code: 'KeyC', ctrl: true });
    es._selectedIndices = new Set();
    // Make the pasted pair differ from what sits at 6000/6250 (6000:5, 6250:95).
    es.updateAction(4, { pos: 40 });
    es.updateAction(5, { pos: 60 });
    es._selectedIndices = new Set([4, 5]);
    press(ed, 'c', { code: 'KeyC', ctrl: true });
    seek(ed, 6000);
    press(ed, 'v', { code: 'KeyV', ctrl: true });
    expect(at(es, 6000)).toEqual(['6000:40']);
    expect(at(es, 6250)).toEqual(['6250:60']);
    expect(es.actions).toHaveLength(33);
    expect(timesAreUnique(es)).toBe(true);
    // The pasted points are what is selected.
    expect([...es.selectedIndices].map((i) => pairs(es)[i]).sort()).toEqual(['6000:40', '6250:60']);
  });

  it('Ctrl+Shift+V (paste at the original times) over the originals leaves one point per time', () => {
    const ed = makeEditor(ALPHA);
    const es = ed.editableScript;
    es._selectedIndices = new Set([8, 9, 10]);
    press(ed, 'c', { code: 'KeyC', ctrl: true });
    press(ed, 'V', { code: 'KeyV', ctrl: true, shift: true });
    expect(es.actions).toHaveLength(33);
    expect(timesAreUnique(es)).toBe(true);
  });

  it('pop-out OP_PASTE at the playhead replaces as well', () => {
    const ed = makeEditor(ALPHA);
    const es = ed.editableScript;
    es._selectedIndices = new Set([4, 5]);
    es.copy();
    es._selectedIndices = new Set();
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_PASTE, { at: 6000 }));
    expect(es.actions).toHaveLength(33);
    expect(timesAreUnique(es)).toBe(true);
  });
});

describe('modifiers, generators, moves (CB-02)', () => {
  it('Range Extend x2 on idx 15-17: one point at 4750, the extended one', () => {
    const es = scriptOf(ALPHA); // idx 15-17 = 3750:95, 4000:5, 4250:95; 4750:95 unselected
    es._selectedIndices = new Set([15, 16, 17]);
    es.applyModifier(rangeExtend, 2);
    expect(at(es, 4750)).toHaveLength(1);
    expect(timesAreUnique(es)).toBe(true);
    // The extended point is the one that stayed, and it is selected.
    const kept = es.actions.findIndex((a) => a.at === 4750);
    expect(es.selectedIndices.has(kept)).toBe(true);
  });

  it('Offset Time onto unselected points: the moved ones keep the times', () => {
    const es = scriptOf(ALPHA);
    es._selectedIndices = new Set([0, 1, 2]); // 0:5, 250:95, 500:5
    es.applyModifier(offsetTime, 500); // → 500:5, 750:95, 1000:5 over 500:5, 750:95, 1000:5
    expect(timesAreUnique(es)).toBe(true);
    expect(es.selectedIndices.size).toBe(3);
  });

  it('a nudge onto a neighbour\'s time: the moved point stays, the other goes, undo brings it back', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 1033, pos: 20 }]);
    es._selectedIndices = new Set([2]);
    es.moveActions(es.selectedIndices, -33, 0);
    expect(pairs(es)).toEqual(['0:0', '1000:20']);
    expect([...es.selectedIndices]).toEqual([1]);
    es.undo();
    expect(pairs(es)).toEqual(['0:0', '1000:100', '1033:20']);
  });

  it('a drag that passes over a point keeps it; only where the drag ends counts', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }, { at: 3000, pos: 50 }]);
    es._selectedIndices = new Set([1]);
    es.beginBatch();
    es.moveActions(es.selectedIndices, 1000, 0); // onto 2000 mid-drag
    es.moveActions(es.selectedIndices, 500, 0);  // on to 2500
    es.endBatch();
    expect(pairs(es)).toEqual(['0:0', '2000:0', '2500:100', '3000:50']);

    es._selectedIndices = new Set([2]);
    es.beginBatch();
    es.moveActions(es.selectedIndices, 500, 0); // ends on 3000
    es.endBatch();
    expect(pairs(es)).toEqual(['0:0', '2000:0', '3000:100']);
    expect([...es.selectedIndices]).toEqual([2]);
    es.undo(); // one step for the whole drag
    expect(pairs(es)).toEqual(['0:0', '2000:0', '2500:100', '3000:50']);
  });

  it('a drag is ONE undo step: Ctrl+Z after it undoes the drag, not the edit before it', () => {
    // Found with CB-02 (also in v0.9.2): beginBatch set the batching flag
    // before taking its snapshot, and _pushState skips while batching.
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]);
    es.insertAction(2000, 50); // the edit before the drag
    es._selectedIndices = new Set([1]);
    es.beginBatch();
    es.moveActions(es.selectedIndices, 100, 0);
    es.moveActions(es.selectedIndices, 100, -10);
    es.endBatch();
    expect(pairs(es)).toEqual(['0:0', '1200:90', '2000:50']);
    es.undo();
    expect(pairs(es)).toEqual(['0:0', '1000:100', '2000:50']);
    es.undo();
    expect(pairs(es)).toEqual(['0:0', '1000:100']);
  });

  it('a Shift+click with no move leaves no undo step and keeps redo', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]);
    es.insertAction(2000, 50);
    es.undo();
    expect(es.canRedo).toBe(true);
    const steps = es._undoStack.length;
    es.beginBatch();
    es.endBatch();
    expect(es._undoStack.length).toBe(steps);
    expect(es.canRedo).toBe(true);
  });

  it('End (move the point to the playhead) onto another point replaces it', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 30 }]);
    es._selectedIndices = new Set([0]);
    es.moveSelectedToTime(2000);
    expect(pairs(es)).toEqual(['1000:100', '2000:0']);
    expect([...es.selectedIndices]).toEqual([1]);
  });

  it('Equalize landing on an unselected point keeps the equalized one', () => {
    // Selected 0, 900, 1000 (gaps); 900 goes to 500, where an unselected point sits.
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 400, pos: 10 }, { at: 500, pos: 20 }, { at: 900, pos: 90 }, { at: 1000, pos: 100 }]);
    es._selectedIndices = new Set([0, 3, 4]);
    es.equalizeSelected();
    expect(pairs(es)).toEqual(['0:0', '400:10', '500:90', '1000:100']);
    expect(isSorted(es)).toBe(true);
  });

  it('a generator (pattern stamp, gap fill, beats) replaces the points at its times', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 500, pos: 50 }, { at: 1000, pos: 100 }]);
    es.insertActions([{ at: 500, pos: 10 }, { at: 750, pos: 90 }, { at: 750, pos: 80 }]);
    expect(pairs(es)).toEqual(['0:0', '500:10', '750:80', '1000:100']);
    expect(es.getCreatedActions().map((a) => `${a.at}:${a.pos}`)).toEqual(['500:10', '750:80']);
  });
});

describe('a file that already has duplicates (CB-02)', () => {
  const WITH_DUPES = [{ at: 0, pos: 0 }, { at: 500, pos: 10 }, { at: 500, pos: 90 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }];

  it('loads as it is and stays as it is through an edit elsewhere', () => {
    const es = scriptOf(WITH_DUPES);
    expect(es.dirty).toBe(false);
    expect(pairs(es)).toEqual(['0:0', '500:10', '500:90', '1000:100', '2000:0']);
    es.insertAction(1500, 40);
    es._selectedIndices = new Set([5]); // 2000:0
    es.moveActions(es.selectedIndices, 100, 0);
    expect(at(es, 500)).toEqual(['500:10', '500:90']);
  });

  it('an edit on that time resolves it: the key edits one point and leaves the file\'s other', () => {
    const es = scriptOf(WITH_DUPES);
    es.insertAction(500, 50);
    expect(at(es, 500)).toEqual(['500:50', '500:90']);
    // A paste on that time leaves one.
    es._selectedIndices = new Set([0]);
    es.copy();
    es.paste(500);
    expect(at(es, 500)).toEqual(['500:0']);
  });
});

describe('a point drag that leaves the canvas and comes back (CB-02 review)', () => {
  // The REAL docked canvas and its mouse handlers. The mouseleave handler
  // ended the drag's batch but not the drag, so the moves after the pointer
  // came back ran outside any batch, and every point a moved one landed on
  // along the way was removed: the rule is that only where a drag ENDS counts.
  // The graph's pixel mapping is replaced by a plain one (x * 10 ms, pos =
  // 100 - y), as jsdom lays nothing out.
  const SCRIPT = [{ at: 1000, pos: 50 }, { at: 2000, pos: 20 }, { at: 3000, pos: 80 }, { at: 5000, pos: 50 }];
  function dragEditor() {
    const ed = makeEditor(SCRIPT);
    const g = ed.graph;
    g.getCanvasCoords = (e) => ({ x: e.clientX, y: e.clientY });
    g.xToTime = (x) => x * 10;
    g.yToPos = (y) => 100 - y;
    g.hitTestAction = (x) => ed.editableScript.actions.findIndex((a) => a.at === x * 10);
    g.markInteraction = () => {};
    g.draw = () => {};
    return ed;
  }
  const mouse = (target, type, x, extra = {}) => target.dispatchEvent(new MouseEvent(type, {
    clientX: x, clientY: 50, button: 0, bubbles: true, cancelable: true, ...extra,
  }));

  it('the points it passes over on the way back stay; one undo step for the whole drag', () => {
    const ed = dragEditor();
    const es = ed.editableScript;
    const c = ed._canvas;
    mouse(c, 'mousedown', 100, { shiftKey: true }); // Shift+drag the 1000 point
    mouse(c, 'mousemove', 200); // over the 2000 point
    mouse(c, 'mousemove', 250);
    c.dispatchEvent(new MouseEvent('mouseleave'));
    mouse(c, 'mousemove', 300); // back in, over the 3000 point
    mouse(c, 'mousemove', 350);
    mouse(c, 'mouseup', 350);
    expect(pairs(es)).toEqual(['2000:20', '3000:80', '3500:50', '5000:50']);
    es.undo();
    expect(pairs(es)).toEqual(['1000:50', '2000:20', '3000:80', '5000:50']);
  });

  it('released outside the canvas: the drag ends there, and a later move over the canvas moves nothing', () => {
    const ed = dragEditor();
    const es = ed.editableScript;
    const c = ed._canvas;
    mouse(c, 'mousedown', 100, { shiftKey: true });
    mouse(c, 'mousemove', 250);
    c.dispatchEvent(new MouseEvent('mouseleave'));
    mouse(document, 'mouseup', 900); // let go outside it
    expect(pairs(es)).toEqual(['2000:20', '2500:50', '3000:80', '5000:50']);
    mouse(c, 'mousemove', 300); // hovering back in, no button
    mouse(c, 'mousemove', 500);
    expect(pairs(es)).toEqual(['2000:20', '2500:50', '3000:80', '5000:50']);
    es.undo();
    expect(pairs(es)).toEqual(['1000:50', '2000:20', '3000:80', '5000:50']);
  });

  it('a drag that ends ON another point still replaces it there', () => {
    const ed = dragEditor();
    const c = ed._canvas;
    mouse(c, 'mousedown', 100, { shiftKey: true });
    c.dispatchEvent(new MouseEvent('mouseleave'));
    mouse(c, 'mousemove', 300);
    mouse(c, 'mouseup', 300);
    expect(pairs(ed.editableScript)).toEqual(['2000:20', '3000:50', '5000:50']);
  });
});
