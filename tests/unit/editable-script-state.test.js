/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Multi-axis editing (Dave, 2026-11-24): each axis keeps its own points,
// undo history and unsaved edits while another axis is on screen
// (exportState / importState), and one clipboard serves every axis: copy
// the stroke, open a new empty axis, paste. Loading another script used to
// empty the clipboard.
import { describe, it, expect } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';

const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);
const scriptOf = (actions, extra = {}) => {
  const es = new EditableScript();
  es.loadFromData({ actions, ...extra });
  return es;
};

describe('exportState / importState: an axis kept in memory', () => {
  it('points, selection, undo, redo and the unsaved edit come back exactly', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }], { metadata: { title: 'A' } });
    es.insertAction(2000, 50);
    es.insertAction(3000, 20);
    es.undo();                                   // one redo step
    es._selectedIndices = new Set([1]);
    expect(es.dirty).toBe(true);
    const kept = es.exportState();

    es.loadFromData({ actions: [{ at: 5, pos: 5 }] });   // another axis on screen
    expect(es.dirty).toBe(false);

    es.importState(kept);
    expect(pairs(es)).toEqual(['0:0', '1000:100', '2000:50']);
    expect([...es.selectedIndices]).toEqual([1]);
    expect(es.dirty).toBe(true);
    expect(es.canRedo).toBe(true);
    es.redo();
    expect(pairs(es)).toEqual(['0:0', '1000:100', '2000:50', '3000:20']);
    es.undo(); es.undo();
    expect(pairs(es)).toEqual(['0:0', '1000:100']);
    expect(es.dirty).toBe(false);                // back at the state loaded: clean
    expect(JSON.parse(es.toFunscriptJSON()).metadata.title).toBe('A');
  });

  it('is a copy: editing after export does not change what was kept', () => {
    const es = scriptOf([{ at: 0, pos: 0 }]);
    const kept = es.exportState();
    es.insertAction(1000, 90);
    es.importState(kept);
    expect(pairs(es)).toEqual(['0:0']);
    expect(es.dirty).toBe(false);
  });

  it('a kept clean axis put back after edits elsewhere is still clean; markSaved on it holds', () => {
    const a = scriptOf([{ at: 0, pos: 10 }]);
    a.insertAction(500, 60);
    const rev = a.revision;
    a.markSaved(rev);
    const kept = a.exportState();
    a.importState(kept);
    expect(a.dirty).toBe(false);
  });
});

describe('one clipboard for every axis', () => {
  it('copy on the stroke, load an empty axis, paste: the points arrive', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }]);
    es.selectAll();
    es.copy();
    es.loadEmpty();                              // the new, empty axis
    es.paste(0);
    expect(pairs(es)).toEqual(['0:0', '500:100', '1000:0']);
  });

  it('loadFromData and loadFromEngine keep it too', () => {
    const es = scriptOf([{ at: 0, pos: 30 }, { at: 400, pos: 70 }]);
    es.selectAll();
    es.copy();
    es.loadFromData({ actions: [] });
    es.loadFromEngine({ getActions: () => [], getMetadata: () => null });
    es.paste(1000);
    expect(pairs(es)).toEqual(['1000:30', '1400:70']);
  });
});
