/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Undo history (editor work list 4.5, 2026-11-24): every undo step carries
// the name of the edit it undoes, undoHistory() lists them, and
// undoSteps / redoSteps go several steps in one go while each step stays its
// own undo. Pinned by what a user sees: the menu's names, the points after
// "undo to here", the unsaved flag, and the names surviving an axis switch.
import { describe, it, expect, vi } from 'vitest';
import { EditableScript, HISTORY_LABELS, modifierLabel } from '../../renderer/js/editable-script.js';
import * as M from '../../renderer/js/script-modifiers.js';

function scriptOf(points) {
  const es = new EditableScript();
  es.loadFromData({ actions: points.map(([at, pos]) => ({ at, pos })) });
  return es;
}
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);
const labels = (list) => list.map((e) => e.label);

describe('every edit names its undo step', () => {
  it('insert, change, move, delete, cut, paste, invert, equalize, ripple delete', () => {
    const es = scriptOf([[0, 0], [500, 100], [1000, 0], [1500, 100]]);
    es.insertAction(2000, 50);                         // a new point
    es.insertAction(2000, 60);                         // the same time: a change
    es.select(1);
    es.moveActions(es.selectedIndices, 0, -5);
    es.selectRange(1, 3);
    es.invertSelection();
    es.equalizeSelected();
    es.copy();
    es.paste(3000);
    es.selectRange(0, 0);
    es.cut();
    es.selectRange(0, 1);
    es.rippleDeleteSelected();
    es.selectAll();
    es.deleteActions(es.selectedIndices);

    expect(labels(es.undoHistory().undo)).toEqual([
      HISTORY_LABELS.delete,
      HISTORY_LABELS.rippleDelete,
      HISTORY_LABELS.cut,
      HISTORY_LABELS.paste,
      HISTORY_LABELS.equalize,
      HISTORY_LABELS.invert,
      HISTORY_LABELS.move,
      HISTORY_LABELS.editPoint,
      HISTORY_LABELS.insert,
    ]);
    const h = es.undoHistory().undo;
    expect(h[3].params).toEqual({ count: 3 });         // pasted 3 points
    expect(h[6].params).toEqual({ count: 1 });         // moved 1
  });

  it('pasteExact, simplify, fill, insertActions (default and given), bookmarks, metadata, move to playhead', () => {
    const es = scriptOf([[0, 0], [100, 10], [200, 20], [300, 30], [400, 0]]);
    es.selectRange(0, 1);
    es.copy();
    es.pasteExact();
    es.selectAll();
    es.simplify(5);
    es.replaceRange(0, 400, [{ at: 200, pos: 90 }]);
    es.insertActions([{ at: 1000, pos: 10 }, { at: 1200, pos: 90 }]);
    es.insertActions([{ at: 2000, pos: 10 }], HISTORY_LABELS.generatePattern);
    es.addBookmark(500, 'x');
    es.removeBookmark(500);
    es.setMetadataField('title', 'T');
    es.select(0);
    es.moveSelectedToTime(50);

    const h = es.undoHistory().undo;
    expect(labels(h)).toEqual([
      HISTORY_LABELS.moveToPlayhead,
      HISTORY_LABELS.metadata,
      HISTORY_LABELS.removeBookmark,
      HISTORY_LABELS.addBookmark,
      HISTORY_LABELS.generatePattern,
      HISTORY_LABELS.insertPoints,
      HISTORY_LABELS.fill,
      HISTORY_LABELS.simplify,
      HISTORY_LABELS.pasteExact,
    ]);
    expect(h[5].params).toEqual({ count: 2 });
    expect(h[4].params).toEqual({ count: 1 });
  });

  it('a drag is one step called a drag (beginBatch), and a batch may name itself', () => {
    const es = scriptOf([[0, 0], [500, 100]]);
    es.select(1);
    es.beginBatch();
    es.moveActions(es.selectedIndices, 10, 0);
    es.moveActions(es.selectedIndices, 10, 0);
    es.endBatch();
    es.beginBatch(HISTORY_LABELS.move, { count: 1 });
    es.moveActions(es.selectedIndices, 10, 0);
    es.endBatch();
    expect(es.undoHistory().undo).toEqual([
      { label: HISTORY_LABELS.move, params: { count: 1 } },
      { label: HISTORY_LABELS.drag, params: {} },
    ]);
  });

  it('a modifier is named by the exported function it is; anything else is "Modify"', () => {
    const named = [
      [M.halfSpeed, 'editor.modify.halfSpeed'],
      [M.doubleSpeed, 'editor.modify.doubleSpeed'],
      [M.reverseActions, 'editor.modify.reverse'],
      [M.remapRange, 'editor.modify.remapRange'],
      [M.offsetTime, 'editor.modify.offsetTime'],
      [M.removePauses, 'editor.modify.removePauses'],
      [M.rangeExtend, 'editor.modify.rangeExtend'],
      [M.fadeIn, 'editor.modify.fadeIn'],
      [M.fadeOut, 'editor.modify.fadeOut'],
    ];
    for (const [fn, key] of named) expect(modifierLabel(fn)).toBe(key);
    expect(modifierLabel(M.fadeDepth, ['out'])).toBe('editor.modify.fadeOut');
    expect(modifierLabel(M.fadeDepth, ['in'])).toBe('editor.modify.fadeIn');
    expect(modifierLabel((a) => a)).toBe(HISTORY_LABELS.modify);

    const es = scriptOf([[0, 0], [500, 100], [1000, 0]]);
    es.applyModifier(M.offsetTime, 250);
    es.applyModifier((a) => a.map((x) => ({ ...x, pos: 50 })));
    expect(labels(es.undoHistory().undo)).toEqual([HISTORY_LABELS.modify, 'editor.modify.offsetTime']);
  });

  it('every modifier label key is in en.json (the Modify menu keys, already shipped)', async () => {
    const { readFileSync } = await import('node:fs');
    const en = JSON.parse(readFileSync('renderer/locales/en.json', 'utf8'));
    const get = (k) => k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), en);
    for (const fn of [M.halfSpeed, M.doubleSpeed, M.reverseActions, M.remapRange, M.offsetTime, M.removePauses, M.rangeExtend, M.fadeIn, M.fadeOut]) {
      expect(typeof get(modifierLabel(fn)), modifierLabel(fn)).toBe('string');
    }
  });

  it('a refused or no-op edit leaves no step (and so no name)', () => {
    const es = scriptOf([[0, 0], [500, 100]]);
    es.insertAction(500, 100);                 // same point, same position
    es.applyModifier((a) => a);                // no change
    es.select(0);
    es.simplify(5);                            // fewer than 3
    expect(es.undoHistory().undo).toEqual([]);
  });
});

describe('undo and redo carry the name with them', () => {
  it('an undone step is listed as a redo under the same name, and back', () => {
    const es = scriptOf([[0, 0]]);
    es.insertAction(500, 100);
    es.insertAction(900, 0);
    es.undo();
    expect(es.undoHistory()).toEqual({
      undo: [{ label: HISTORY_LABELS.insert, params: {} }],
      redo: [{ label: HISTORY_LABELS.insert, params: {} }],
    });
    es.selectAll();
    es.deleteActions(es.selectedIndices);        // a new edit drops the redo
    es.undo();
    es.undo();
    expect(labels(es.undoHistory().redo)).toEqual([HISTORY_LABELS.insert, HISTORY_LABELS.delete]);
    es.redo();
    expect(labels(es.undoHistory().undo)).toEqual([HISTORY_LABELS.insert]);
    expect(labels(es.undoHistory().redo)).toEqual([HISTORY_LABELS.delete]);
  });

  it('undoHistory returns copies', () => {
    const es = scriptOf([[0, 0], [500, 100]]);
    es.selectAll();
    es.deleteActions(es.selectedIndices);
    const h = es.undoHistory();
    h.undo[0].params.count = 99;
    h.undo.push({ label: 'x', params: {} });
    expect(es.undoHistory().undo).toEqual([{ label: HISTORY_LABELS.delete, params: { count: 2 } }]);
  });

  it('an entry made before labels reads as label null', () => {
    const es = scriptOf([[0, 0]]);
    es.insertAction(500, 100);
    delete es._undoStack[0].label;
    delete es._undoStack[0].params;
    expect(es.undoHistory().undo).toEqual([{ label: null, params: {} }]);
    es.undo();
    expect(es.undoHistory().redo).toEqual([{ label: null, params: {} }]);
  });
});

describe('undoSteps / redoSteps', () => {
  function threeEdits() {
    const es = scriptOf([[0, 0]]);
    es.insertAction(100, 10);   // A
    es.insertAction(200, 20);   // B
    es.insertAction(300, 30);   // C
    return es;
  }

  it('"undo to here": undoSteps(n) lands on the state before the nth newest edit', () => {
    const es = threeEdits();
    expect(es.undoSteps(2)).toBe(2);
    expect(pairs(es)).toEqual(['0:0', '100:10']);
    // Each step is still its own undo: one redo brings back B alone.
    expect(es.redoSteps(1)).toBe(1);
    expect(pairs(es)).toEqual(['0:0', '100:10', '200:20']);
    expect(es.redoSteps(1)).toBe(1);
    expect(pairs(es)).toEqual(['0:0', '100:10', '200:20', '300:30']);
  });

  it('is the same as n single undos, redo for redo', () => {
    const a = threeEdits();
    const b = threeEdits();
    a.undoSteps(3);
    b.undo(); b.undo(); b.undo();
    expect(pairs(a)).toEqual(pairs(b));
    expect(a.undoHistory()).toEqual(b.undoHistory());
    a.redoSteps(2);
    b.redo(); b.redo();
    expect(pairs(a)).toEqual(pairs(b));
    expect(a.undoHistory()).toEqual(b.undoHistory());
  });

  it('fires onChange once, and only when something moved', () => {
    const es = threeEdits();
    const onChange = vi.fn();
    es.onChange = onChange;
    es.undoSteps(3);
    expect(onChange).toHaveBeenCalledTimes(1);
    es.undoSteps(2);              // nothing left
    expect(onChange).toHaveBeenCalledTimes(1);
    es.redoSteps(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('clamps: more than there is goes as far as it can; junk is 0', () => {
    const es = threeEdits();
    expect(es.undoSteps(99)).toBe(3);
    expect(pairs(es)).toEqual(['0:0']);
    expect(es.undoSteps(1)).toBe(0);
    expect(es.redoSteps('x')).toBe(0);
    expect(es.redoSteps(-2)).toBe(0);
    expect(es.redoSteps(Infinity)).toBe(3);
    expect(pairs(es)).toEqual(['0:0', '100:10', '200:20', '300:30']);
  });

  it('is clean exactly when it lands on the saved state (R4-18)', () => {
    const es = threeEdits();
    es.markSaved();                  // saved with A, B, C
    es.undoSteps(2);
    expect(es.dirty).toBe(true);
    es.redoSteps(2);
    expect(es.dirty).toBe(false);
    es.undoSteps(3);
    es.markSaved();                  // saved with none
    es.redoSteps(3);
    expect(es.dirty).toBe(true);
    es.undoSteps(3);
    expect(es.dirty).toBe(false);
  });

  it('undo() and redo() still return true / false', () => {
    const es = scriptOf([[0, 0]]);
    expect(es.undo()).toBe(false);
    es.insertAction(100, 10);
    expect(es.undo()).toBe(true);
    expect(es.redo()).toBe(true);
    expect(es.redo()).toBe(false);
  });
});

describe('selectIndices (the Check script dialog\'s selection, work list 4.2)', () => {
  it('selects exactly the valid indices, once, with no undo step and no unsaved flag', () => {
    const es = scriptOf([[0, 0], [500, 100], [1000, 0]]);
    es.select(0);
    const onChange = vi.fn();
    es.onChange = onChange;
    expect(es.selectIndices([2, 1, 1, 7, -1, 0.5])).toBe(2);
    expect([...es.selectedIndices].sort()).toEqual([1, 2]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(es.canUndo).toBe(false);
    expect(es.dirty).toBe(false);
    expect(es.selectIndices(null)).toBe(0);
    expect(es.selectedIndices.size).toBe(0);
  });
});

describe('the names survive an axis switch (exportState / importState)', () => {
  it('structuredClone carries labels and params both ways', () => {
    const es = scriptOf([[0, 0], [500, 100], [1000, 0]]);
    es.selectAll();
    es.invertSelection();
    es.applyModifier(M.offsetTime, 100);
    es.undo();
    const before = es.undoHistory();
    const kept = es.exportState();

    const other = new EditableScript();
    other.loadFromData({ actions: [{ at: 0, pos: 50 }] });
    other.importState(kept);
    expect(other.undoHistory()).toEqual(before);
    expect(before.undo[0]).toEqual({ label: HISTORY_LABELS.invert, params: { count: 3 } });
    expect(before.redo[0]).toEqual({ label: 'editor.modify.offsetTime', params: {} });
    // And they still work as steps.
    other.redoSteps(1);
    expect(labels(other.undoHistory().undo)).toEqual(['editor.modify.offsetTime', HISTORY_LABELS.invert]);
  });

  it('survives the JSON round trip of the older undo cache shape', () => {
    const es = scriptOf([[0, 0], [500, 100]]);
    es.insertAction(800, 40);
    const json = JSON.parse(JSON.stringify(es._undoStack.map((e) => ({ ...e, selectedIndices: [...e.selectedIndices] }))));
    const back = scriptOf([[0, 0], [500, 100], [800, 40]]);
    back._undoStack = json.map((e) => ({ ...e, selectedIndices: new Set(e.selectedIndices) }));
    expect(back.undoHistory().undo).toEqual([{ label: HISTORY_LABELS.insert, params: {} }]);
  });
});
