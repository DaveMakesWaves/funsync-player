/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Round-trip tests for EDIT_OP routing — pop-out sends an op via the
// relay, parent's `_applyPopoutEdit` dispatches to EditableScript.
//
// Doesn't mount the full ScriptEditor (DOM + canvas + IPC are
// orthogonal to the dispatch logic we want to lock here). Instead we
// extract a minimal harness that mimics `_applyPopoutEdit` exactly.
// The matrix below is the contract — every protocol op must have a
// dispatch path that mutates the EditableScript in the right way.

import { describe, it, expect, beforeEach } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';
import {
  OP_INSERT, OP_DELETE, OP_UPDATE, OP_SELECT, OP_SELECT_ALL, OP_CLEAR_SELECTION,
  OP_INVERT, OP_UNDO, OP_REDO, OP_CUT, OP_PASTE,
  OP_EQUALIZE, OP_SELECT_LEFT_OF, OP_SELECT_RIGHT_OF,
  OP_INSERT_ALTERNATING, OP_REPEAT_LAST_STROKE, OP_MOVE_SELECTED_TO,
  OP_ADD_BOOKMARK, OP_REMOVE_BOOKMARK,
  OP_BEGIN_BATCH, OP_END_BATCH,
  OP_COPY, OP_SELECT_BY_POSITION, OP_MOVE_ACTIONS, OP_APPLY_MODIFIER,
} from '../../renderer/js/editor-popout-protocol.js';
import { halfSpeed, doubleSpeed, reverseActions } from '../../renderer/js/script-modifiers.js';

// Copy of `_applyPopoutEdit` logic, isolated from ScriptEditor. Keep
// this in sync with the parent — diverging silently would break the
// pop-out's editing in production.
function applyPopoutEdit(es, payload) {
  const op = payload.op;
  switch (op) {
    case OP_INSERT: es.insertAction(payload.at, payload.pos); break;
    case OP_DELETE:
      if (Array.isArray(payload.indices)) es.deleteActions(new Set(payload.indices));
      else es.deleteActions(es.selectedIndices);
      break;
    case OP_UPDATE:
      if (typeof payload.idx === 'number') es.updateAction(payload.idx, payload.fields || {});
      break;
    case OP_SELECT:
      if (Array.isArray(payload.indices)) {
        es._selectedIndices = new Set(payload.indices);
        es._emit?.();
      }
      break;
    case OP_SELECT_ALL: es.selectAll(); break;
    case OP_CLEAR_SELECTION: es.clearSelection(); break;
    case OP_INVERT: es.invertSelection(); break;
    case OP_UNDO: es.undo(); break;
    case OP_REDO: es.redo(); break;
    case OP_CUT: es.cut?.(); break;
    case OP_PASTE: es.paste?.(payload.at); break;
    case OP_EQUALIZE: es.equalizeSelected?.(); break;
    case OP_SELECT_LEFT_OF: es.selectLeftOfCursor?.(payload.time); break;
    case OP_SELECT_RIGHT_OF: es.selectRightOfCursor?.(payload.time); break;
    case OP_INSERT_ALTERNATING: es.insertAlternating?.(payload.at); break;
    case OP_REPEAT_LAST_STROKE: es.repeatLastStroke?.(payload.at); break;
    case OP_MOVE_SELECTED_TO: es.moveSelectedToTime?.(payload.time); break;
    case OP_ADD_BOOKMARK: es.addBookmark?.(payload.at, payload.name); break;
    case OP_REMOVE_BOOKMARK: es.removeBookmark?.(payload.at); break;
    case OP_BEGIN_BATCH: es.beginBatch?.(); break;
    case OP_END_BATCH: es.endBatch?.(); break;
    case OP_COPY: es.copy?.(); break;
    case OP_SELECT_BY_POSITION: es.selectByPositionRange?.(payload.minPos, payload.maxPos); break;
    case OP_MOVE_ACTIONS:
      es.moveActions?.(
        Array.isArray(payload.indices) ? new Set(payload.indices) : es.selectedIndices,
        payload.deltaAt || 0,
        payload.deltaPos || 0,
      );
      break;
    case OP_APPLY_MODIFIER: {
      const mods = { halfSpeed, doubleSpeed, reverse: reverseActions };
      if (mods[payload.name]) es.applyModifier?.(mods[payload.name]);
      break;
    }
  }
}

describe('popout EDIT_OP routing', () => {
  let es;
  beforeEach(() => {
    es = new EditableScript();
  });

  it('OP_INSERT inserts at the given time/pos', () => {
    applyPopoutEdit(es, { op: OP_INSERT, at: 500, pos: 75 });
    expect(es.actions).toEqual([{ at: 500, pos: 75 }]);
  });

  it('OP_DELETE with explicit indices removes those actions', () => {
    es.insertAction(0, 0);
    es.insertAction(500, 50);
    es.insertAction(1000, 100);
    applyPopoutEdit(es, { op: OP_DELETE, indices: [0, 2] });
    expect(es.actions).toEqual([{ at: 500, pos: 50 }]);
  });

  it('OP_DELETE without indices falls back to current selection', () => {
    es.insertAction(0, 0);
    es.insertAction(500, 50);
    es.select(0);
    applyPopoutEdit(es, { op: OP_DELETE });
    expect(es.actions).toEqual([{ at: 500, pos: 50 }]);
  });

  it('OP_UPDATE patches the at/pos fields', () => {
    es.insertAction(500, 50);
    applyPopoutEdit(es, { op: OP_UPDATE, idx: 0, fields: { pos: 90 } });
    expect(es.actions[0]).toEqual({ at: 500, pos: 90 });
  });

  it('OP_SELECT replaces selection with provided indices', () => {
    es.insertAction(0, 0);
    es.insertAction(500, 50);
    applyPopoutEdit(es, { op: OP_SELECT, indices: [0, 1] });
    expect([...es.selectedIndices].sort()).toEqual([0, 1]);
  });

  it('OP_SELECT_ALL and OP_CLEAR_SELECTION work', () => {
    es.insertAction(0, 0);
    es.insertAction(500, 50);
    applyPopoutEdit(es, { op: OP_SELECT_ALL });
    expect(es.selectedIndices.size).toBe(2);
    applyPopoutEdit(es, { op: OP_CLEAR_SELECTION });
    expect(es.selectedIndices.size).toBe(0);
  });

  it('OP_INVERT flips position values for selected actions', () => {
    es.insertAction(0, 30);
    es.insertAction(500, 70);
    applyPopoutEdit(es, { op: OP_SELECT_ALL });
    applyPopoutEdit(es, { op: OP_INVERT });
    expect(es.actions.map(a => a.pos)).toEqual([70, 30]);
  });

  it('OP_UNDO / OP_REDO round-trip an edit', () => {
    es.insertAction(0, 0);
    applyPopoutEdit(es, { op: OP_INSERT, at: 500, pos: 50 });
    expect(es.actions.length).toBe(2);
    applyPopoutEdit(es, { op: OP_UNDO });
    expect(es.actions.length).toBe(1);
    applyPopoutEdit(es, { op: OP_REDO });
    expect(es.actions.length).toBe(2);
  });

  it('OP_CUT removes selected actions and copies to clipboard', () => {
    es.insertAction(0, 0);
    es.insertAction(500, 50);
    es.select(0);
    applyPopoutEdit(es, { op: OP_CUT });
    expect(es.actions).toEqual([{ at: 500, pos: 50 }]);
    // OP_PASTE at a later time re-inserts the cut action shifted to the cursor
    applyPopoutEdit(es, { op: OP_PASTE, at: 1000 });
    expect(es.actions.length).toBe(2);
  });

  it('OP_EQUALIZE redistributes selected middle actions', () => {
    es.insertAction(0, 0);
    es.insertAction(100, 50);
    es.insertAction(200, 50);
    es.insertAction(1000, 100);
    applyPopoutEdit(es, { op: OP_SELECT_ALL });
    applyPopoutEdit(es, { op: OP_EQUALIZE });
    expect(es.actions.map(a => a.at)).toEqual([0, 333, 667, 1000]);
  });

  it('OP_SELECT_LEFT_OF / OP_SELECT_RIGHT_OF use the time field', () => {
    es.insertAction(100, 10);
    es.insertAction(500, 50);
    es.insertAction(800, 80);
    applyPopoutEdit(es, { op: OP_SELECT_LEFT_OF, time: 500 });
    expect([...es.selectedIndices]).toEqual([0]);
    applyPopoutEdit(es, { op: OP_SELECT_RIGHT_OF, time: 500 });
    expect([...es.selectedIndices]).toEqual([2]);
  });

  it('OP_INSERT_ALTERNATING flips from previous pos', () => {
    es.insertAction(0, 20);
    applyPopoutEdit(es, { op: OP_INSERT_ALTERNATING, at: 500 });
    expect(es.actions[1].pos).toBe(100);
  });

  it('OP_REPEAT_LAST_STROKE duplicates the trailing pair at the cursor', () => {
    es.insertAction(0, 0);
    es.insertAction(200, 100);
    applyPopoutEdit(es, { op: OP_REPEAT_LAST_STROKE, at: 1000 });
    expect(es.actions).toHaveLength(4);
    expect(es.actions[2]).toEqual({ at: 1000, pos: 0 });
    expect(es.actions[3]).toEqual({ at: 1200, pos: 100 });
  });

  it('OP_MOVE_SELECTED_TO snaps single selection to cursor', () => {
    es.insertAction(100, 50);
    es.select(0);
    applyPopoutEdit(es, { op: OP_MOVE_SELECTED_TO, time: 900 });
    expect(es.actions[0].at).toBe(900);
  });

  it('OP_ADD_BOOKMARK / OP_REMOVE_BOOKMARK round-trip', () => {
    applyPopoutEdit(es, { op: OP_ADD_BOOKMARK, at: 500, name: 'verse' });
    const bookmarks = es.getBookmarks();
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]).toEqual(expect.objectContaining({ at: 500, name: 'verse' }));
    applyPopoutEdit(es, { op: OP_REMOVE_BOOKMARK, at: 500 });
    expect(es.getBookmarks()).toHaveLength(0);
  });

  it('unknown op is a silent no-op (defensive)', () => {
    es.insertAction(0, 50);
    const before = JSON.stringify(es.actions);
    applyPopoutEdit(es, { op: 'fooBarNotReal' });
    expect(JSON.stringify(es.actions)).toBe(before);
  });

  it('malformed payload (no op) is a silent no-op', () => {
    es.insertAction(0, 50);
    const before = JSON.stringify(es.actions);
    applyPopoutEdit(es, {});
    expect(JSON.stringify(es.actions)).toBe(before);
  });

  it('OP_COPY captures selection to clipboard (paste round-trip)', () => {
    es.insertAction(0, 0);
    es.insertAction(500, 100);
    es.selectAll();
    applyPopoutEdit(es, { op: OP_COPY });
    // Clear and paste at a new time — copy filled the clipboard
    es.deleteActions(es.selectedIndices);
    expect(es.actions).toHaveLength(0);
    applyPopoutEdit(es, { op: OP_PASTE, at: 1000 });
    expect(es.actions.length).toBe(2);
  });

  it('OP_SELECT_BY_POSITION selects by position range', () => {
    es.insertAction(0, 10);
    es.insertAction(100, 50);
    es.insertAction(200, 90);
    applyPopoutEdit(es, { op: OP_SELECT_BY_POSITION, minPos: 67, maxPos: 100 });
    expect([...es.selectedIndices]).toEqual([2]);
    applyPopoutEdit(es, { op: OP_SELECT_BY_POSITION, minPos: 34, maxPos: 66 });
    expect([...es.selectedIndices]).toEqual([1]);
    applyPopoutEdit(es, { op: OP_SELECT_BY_POSITION, minPos: 0, maxPos: 33 });
    expect([...es.selectedIndices]).toEqual([0]);
  });

  it('OP_MOVE_ACTIONS shifts selected actions by deltaAt / deltaPos', () => {
    es.insertAction(100, 30);
    es.insertAction(200, 50);
    es.selectAll();
    applyPopoutEdit(es, { op: OP_MOVE_ACTIONS, deltaAt: 50, deltaPos: 10 });
    expect(es.actions[0].at).toBe(150);
    expect(es.actions[0].pos).toBe(40);
    expect(es.actions[1].at).toBe(250);
    expect(es.actions[1].pos).toBe(60);
  });

  it('OP_MOVE_ACTIONS with explicit indices targets just those', () => {
    es.insertAction(100, 30);
    es.insertAction(200, 50);
    applyPopoutEdit(es, { op: OP_MOVE_ACTIONS, indices: [1], deltaPos: 25 });
    expect(es.actions[0].pos).toBe(30); // untouched
    expect(es.actions[1].pos).toBe(75);
  });

  it('OP_APPLY_MODIFIER routes by name (halfSpeed / doubleSpeed / reverse)', () => {
    // halfSpeed (down-sample) — drop every other action
    es.insertAction(0, 0);
    es.insertAction(100, 50);
    es.insertAction(200, 100);
    es.insertAction(300, 50);
    es.insertAction(400, 0);
    es.selectAll();
    applyPopoutEdit(es, { op: OP_APPLY_MODIFIER, name: 'halfSpeed' });
    expect(es.actions.length).toBeLessThan(5);

    // doubleSpeed — needs a full cycle (out and back) to have something to
    // repeat; two points is a single one-way move and is left alone by
    // design, so route-testing with two would prove nothing.
    es = new EditableScript();
    es.insertAction(0, 0);
    es.insertAction(500, 100);
    es.insertAction(1000, 0);
    es.selectAll();
    const before = es.actions.length;
    applyPopoutEdit(es, { op: OP_APPLY_MODIFIER, name: 'doubleSpeed' });
    expect(es.actions.length).toBeGreaterThan(before);

    // reverse — time-reversed AND position-inverted (pos = 100 - pos).
    // With three off-centre points the asymmetry is visible.
    es = new EditableScript();
    es.insertAction(0, 30);
    es.insertAction(100, 70);
    es.insertAction(200, 20);
    es.selectAll();
    applyPopoutEdit(es, { op: OP_APPLY_MODIFIER, name: 'reverse' });
    // Input  positions [30, 70, 20] → time-reversed [20, 70, 30] → inverted [80, 30, 70]
    expect(es.actions.map(a => a.pos)).toEqual([80, 30, 70]);
  });

  it('OP_APPLY_MODIFIER with unknown name is a no-op', () => {
    es.insertAction(0, 0);
    es.insertAction(500, 100);
    const before = JSON.stringify(es.actions);
    applyPopoutEdit(es, { op: OP_APPLY_MODIFIER, name: 'noSuchModifier' });
    expect(JSON.stringify(es.actions)).toBe(before);
  });

  it('OP_BEGIN_BATCH / OP_END_BATCH suppress per-update undo pushes', () => {
    // Simulate a drag: begin batch, fire many OP_UPDATEs, end batch.
    // Without batching, each OP_UPDATE pushes its own undo state — 30
    // updates would push 30. Batching collapses them so the drag
    // doesn't bloat the undo stack.
    es.insertAction(0, 50);
    es.insertAction(1000, 75);
    const undoCountBeforeBatch = es._undoStack.length;

    applyPopoutEdit(es, { op: OP_BEGIN_BATCH });
    for (let p = 51; p <= 80; p++) {
      applyPopoutEdit(es, { op: OP_UPDATE, idx: 0, fields: { pos: p } });
    }
    applyPopoutEdit(es, { op: OP_END_BATCH });

    expect(es.actions[0].pos).toBe(80);
    // Critically: NO new undo entries were added during the batch.
    // (Without OP_BEGIN_BATCH, the loop would push 30 entries.)
    expect(es._undoStack.length).toBe(undoCountBeforeBatch);
  });
});
