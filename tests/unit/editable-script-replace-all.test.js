/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// replaceAll (editor work list 3.1, 2026-11-24): "Restore an earlier
// version…" puts a whole version back as ONE undo step, named "restore" in
// the undo history (4.5). Undo gives the points back exactly, redo restores
// again, and the script reads as unsaved until it is saved.
import { describe, it, expect, vi } from 'vitest';
import { EditableScript, HISTORY_LABELS } from '../../renderer/js/editable-script.js';

function scriptOf(points, file = {}) {
  const es = new EditableScript();
  es.loadFromData({ ...file, actions: points.map(([at, pos]) => ({ at, pos })) });
  return es;
}
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);

describe('replaceAll', () => {
  it('replaces every point as one undo step called "restore"', () => {
    const es = scriptOf([[0, 0], [500, 100], [1000, 0]]);
    const r = es.replaceAll([{ at: 0, pos: 50 }, { at: 2000, pos: 60 }]);
    expect(r).toEqual({ changed: true, count: 2 });
    expect(pairs(es)).toEqual(['0:50', '2000:60']);
    expect(es.undoHistory().undo).toEqual([{ label: HISTORY_LABELS.restore, params: { count: 2 } }]);
    expect(HISTORY_LABELS.restore).toBe('editor.history.restore');
  });

  it('undo gives the previous points back exactly; redo restores again', () => {
    const es = scriptOf([[0, 0], [500, 100], [1000, 0]]);
    es.replaceAll([{ at: 100, pos: 10 }]);
    expect(es.undo()).toBe(true);
    expect(pairs(es)).toEqual(['0:0', '500:100', '1000:0']);
    expect(es.canUndo).toBe(false);
    expect(es.redo()).toBe(true);
    expect(pairs(es)).toEqual(['100:10']);
  });

  it('a new revision: unsaved until saved, clean again on undo to the saved state (R4-18)', () => {
    const es = scriptOf([[0, 0], [500, 100]]);
    const rev = es.revision;
    expect(es.dirty).toBe(false);
    es.replaceAll([{ at: 0, pos: 30 }]);
    expect(es.revision).not.toBe(rev);
    expect(es.dirty).toBe(true);
    es.undo();
    expect(es.dirty).toBe(false);
    es.redo();
    es.markSaved();
    expect(es.dirty).toBe(false);
  });

  it('drops points without a finite time or position, rounds, sorts by time and keeps same-time points', () => {
    const es = scriptOf([[0, 0]]);
    es.replaceAll([
      { at: 900.6, pos: 140 },
      { at: 100, pos: 10 },
      { at: 'x', pos: 5 },
      { at: 500, pos: NaN },
      null,
      { at: 100, pos: 90 },         // same time as the second: kept, not merged
      { at: '300', pos: '40.4' },   // string numbers from a file
    ]);
    expect(pairs(es)).toEqual(['100:10', '100:90', '300:40', '901:100']);
  });

  it('clears the selection and the created record; leaves metadata and bookmarks', () => {
    const es = scriptOf([[0, 0], [500, 100]], { metadata: { title: 'T', bookmarks: [{ at: 200, name: 'b' }] } });
    es.selectAll();
    es.insertActions([{ at: 800, pos: 50 }]);
    expect(es.getCreatedIndices()).toHaveLength(1);
    es.replaceAll([{ at: 0, pos: 20 }, { at: 400, pos: 80 }]);
    expect(es.selectedIndices.size).toBe(0);
    expect(es.getCreatedIndices()).toEqual([]);
    expect(es.getMetadata().metadata.title).toBe('T');
    expect(es.getBookmarks()).toEqual([{ at: 200, name: 'b' }]);
  });

  it('fires onChange once', () => {
    const es = scriptOf([[0, 0]]);
    const onChange = vi.fn();
    es.onChange = onChange;
    es.replaceAll([{ at: 10, pos: 10 }]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('the same points as now change nothing: no step, not dirty, no onChange', () => {
    const es = scriptOf([[0, 0], [500, 100]]);
    const onChange = vi.fn();
    es.onChange = onChange;
    expect(es.replaceAll([{ at: 500, pos: 100 }, { at: 0, pos: 0 }])).toEqual({ changed: false, count: 2 });
    expect(es.canUndo).toBe(false);
    expect(es.dirty).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(es.replaceAll(null)).toEqual({ changed: false, count: 2 });
  });

  it('an empty version is a real restore (every point goes, one undo brings them back)', () => {
    const es = scriptOf([[0, 0], [500, 100]]);
    expect(es.replaceAll([])).toEqual({ changed: true, count: 0 });
    expect(es.actionCount).toBe(0);
    es.undo();
    expect(pairs(es)).toEqual(['0:0', '500:100']);
  });

  it('a label can be given', () => {
    const es = scriptOf([[0, 0]]);
    es.replaceAll([{ at: 5, pos: 5 }], HISTORY_LABELS.edit);
    expect(es.undoHistory().undo[0].label).toBe(HISTORY_LABELS.edit);
  });
});
