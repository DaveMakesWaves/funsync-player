/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Editor core fixes (notes/features/RESEARCH-editor-selection-modes.md §4.6),
// reachable today through Ctrl+1/2/3 and Ctrl+click, which already make
// selections with gaps:
//
//   - applyModifier selected every action sharing an output TIMESTAMP, so an
//     unselected neighbour got pulled in (defect 1), and nothing could tell
//     the points a modifier made from the ones it kept (defects 2-3).
//   - Sequence modifiers ran on a gappy selection as if it were contiguous:
//     duplicate timestamps, a flat line at 100 (defect 4).
//   - Equalize left _actions unsorted (defect 5).
//   - No-op modifiers still pushed undo and set dirty: with autosave on, a
//     file write and a Handy re-upload for nothing (defect 6).
//   - Range Extend scaled one point twice and another not at all (defect 8).
//   - The created record has to survive undo AND the editor's per-path
//     undo cache, which goes through JSON (defect 9).
//
// Every assertion is on the resulting actions, selection, undo stack, dirty
// flag and created record — never on how the code is laid out.
import { describe, it, expect } from 'vitest';
import { EditableScript, SEQUENCE_MODIFIERS } from '../../renderer/js/editable-script.js';
import {
  halfSpeed, doubleSpeed, reverseActions, remapRange, offsetTime, removePauses, rangeExtend,
} from '../../renderer/js/script-modifiers.js';

/** 0/100 zigzag, `n` points `step` ms apart, starting at the bottom. */
const zigzag = (n, step = 500, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ at: start + i * step, pos: i % 2 ? 100 : 0 }));

function scriptOf(actions) {
  const es = new EditableScript();
  es.loadFromData({ actions });
  return es;
}
const pair = (a) => `${a.at}:${a.pos}`;
const pairs = (es) => es.actions.map(pair);
const selectedPairs = (es) => [...es.selectedIndices].sort((a, b) => a - b).map((i) => pair(es.actions[i]));
const createdPairs = (es) => es.getCreatedActions().map(pair);
const selectIndices = (es, indices) => { es._selectedIndices = new Set(indices); };
const isSorted = (es) => es.actions.every((a, i, arr) => i === 0 || arr[i - 1].at <= a.at);

describe('applyModifier selects its output by reference (defect 1)', () => {
  it('Offset +500 leaves the unselected neighbour that shares a timestamp unselected', () => {
    const es = scriptOf(zigzag(9)); // 0:0 … 4000:0
    selectIndices(es, [2, 3, 4, 5, 6]); // the points at 1000-3000
    const status = es.applyModifier(offsetTime, 500);
    expect(status).toEqual({ changed: true, refused: false, created: 5 });
    // The moved 3500:0 lands on the unselected 3500:100. The timestamp match
    // used to select both (6 of 5).
    expect(es.selectedIndices.size).toBe(5);
    expect(selectedPairs(es)).toEqual(['1500:0', '2000:100', '2500:0', '3000:100', '3500:0']);
    // CB-02 (OFS: one point per time): the moved point takes 3500 and the
    // unselected 3500:100 goes. This used to assert that both stayed, which
    // pinned the duplicate timestamp as correct.
    expect(pairs(es).filter((p) => p.startsWith('3500:'))).toEqual(['3500:0']);
    expect(isSorted(es)).toBe(true);
  });

  it('keeps the WHOLE output selected after Double Speed (Q1)', () => {
    const es = scriptOf(zigzag(5));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    expect(es.actions).toHaveLength(9);
    expect(es.selectedIndices.size).toBe(9);
  });

  it('a whole-script run leaves nothing selected', () => {
    const es = scriptOf(zigzag(5, 1000));
    es.applyModifier(doubleSpeed);
    expect(es.selectedIndices.size).toBe(0);
  });
});

describe('the created record (§4.3 contract)', () => {
  it('Double Speed: 3 per full cycle, the kept ends excluded, 1000:100 → 1000:0 counted', () => {
    const es = scriptOf(zigzag(5, 1000)); // 0:0 1000:100 2000:0 3000:100 4000:0
    es.selectAll();
    const status = es.applyModifier(doubleSpeed);
    expect(status).toEqual({ changed: true, refused: false, created: 6 });
    // 1000:0 and 3000:0 reuse the dropped peaks' timestamps with another
    // position. A timestamp-only diff would call them original (defect 3).
    expect(createdPairs(es)).toEqual(['500:100', '1000:0', '1500:100', '2500:100', '3000:0', '3500:100']);
  });

  it('Double Speed: a trailing half-cycle passes through and is not new', () => {
    const es = scriptOf(zigzag(4, 1000)); // even length
    es.selectAll();
    expect(es.applyModifier(doubleSpeed).created).toBe(3);
    expect(createdPairs(es)).toEqual(['500:100', '1000:0', '1500:100']);
    expect(pairs(es)).toContain('3000:100');
  });

  it('Double Speed on collinear-midpoint input (v0.9.0 output): only 2 per cycle count', () => {
    const es = scriptOf([
      { at: 0, pos: 0 }, { at: 500, pos: 50 }, { at: 1000, pos: 100 }, { at: 1500, pos: 50 }, { at: 2000, pos: 0 },
    ]);
    es.selectAll();
    expect(es.applyModifier(doubleSpeed).created).toBe(4);
    // The 50% point equals the dropped midpoint exactly, so it is original.
    expect(createdPairs(es)).toEqual(['250:50', '750:50', '1250:50', '1750:50']);
  });

  it('Half Speed: one new point (the retimed tail) for length 7', () => {
    const es = scriptOf(zigzag(7));
    es.selectAll();
    expect(es.applyModifier(halfSpeed)).toEqual({ changed: true, refused: false, created: 1 });
    expect(createdPairs(es)).toEqual(['3000:100']);
  });

  it('Half Speed: none for length 8, and the record is REPLACED by that empty set', () => {
    const es = scriptOf(zigzag(8));
    es.insertActions([{ at: 20000, pos: 50 }]);
    expect(createdPairs(es)).toEqual(['20000:50']);
    selectIndices(es, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(es.applyModifier(halfSpeed)).toEqual({ changed: true, refused: false, created: 0 });
    expect(es.getCreatedIndices()).toEqual([]);
  });

  it('Reverse: all 9 points of a 9-point zigzag are new', () => {
    const es = scriptOf(zigzag(9));
    es.selectAll();
    expect(es.applyModifier(reverseActions).created).toBe(9);
  });

  it('Remap: every point that moved', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 50 }]);
    es.selectAll();
    expect(es.applyModifier(remapRange, 0, 50).created).toBe(2);
    expect(createdPairs(es)).toEqual(['500:50', '1000:25']);
  });

  it('a whole-script run records what it created, with an empty selection', () => {
    const es = scriptOf(zigzag(5, 1000));
    const status = es.applyModifier(doubleSpeed);
    expect(status.created).toBe(6);
    expect(es.selectedIndices.size).toBe(0);
    expect(es.getCreatedIndices()).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it('insertActions (Generate Pattern, Beats, Fill Gaps) selects and records exactly what it inserted', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 5000, pos: 50 }]);
    const status = es.insertActions([{ at: 1000, pos: 0 }, { at: 1500, pos: 100 }, { at: 5000, pos: 20 }]);
    expect(status).toEqual({ changed: true, refused: false, created: 3 });
    // 5000:20 lands next to the existing 5000:50; the reference picks the
    // new one, not the old one.
    expect(selectedPairs(es)).toEqual(['1000:0', '1500:100', '5000:20']);
    expect(createdPairs(es)).toEqual(['1000:0', '1500:100', '5000:20']);
  });

  it('paste, repeat stroke and single inserts do not replace the record (Q6)', () => {
    const es = scriptOf(zigzag(5, 1000));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    const before = createdPairs(es);
    es.insertAction(9000, 50);
    es.select(0);
    es.copy();
    es.paste(12000);
    es.repeatLastStroke(15000);
    expect(createdPairs(es)).toEqual(before);
  });

  it('follows its points through a nudge (same objects) and loses only what was deleted', () => {
    const es = scriptOf([
      { at: 0, pos: 0 }, { at: 500, pos: 50 }, { at: 1000, pos: 100 }, { at: 1500, pos: 50 }, { at: 2000, pos: 0 },
    ]);
    es.selectAll();
    es.applyModifier(doubleSpeed);
    selectIndices(es, es.getCreatedIndices());
    es.moveActions(es.selectedIndices, 0, 20);
    expect(createdPairs(es)).toEqual(['250:70', '750:70', '1250:70', '1750:70']);
    es.deleteActions(new Set([es.getCreatedIndices()[0]]));
    expect(createdPairs(es)).toEqual(['750:70', '1250:70', '1750:70']);
  });

  it('every loader empties it', () => {
    const fresh = () => {
      const es = scriptOf(zigzag(5, 1000));
      es.applyModifier(doubleSpeed);
      expect(es.getCreatedIndices()).toHaveLength(6);
      return es;
    };
    let es = fresh();
    es.loadFromEngine({ getActions: () => zigzag(5, 1000), getMetadata: () => null });
    expect(es.getCreatedIndices()).toEqual([]);
    es = fresh();
    es.loadFromData({ actions: zigzag(5, 1000) });
    expect(es.getCreatedIndices()).toEqual([]);
    es = fresh();
    es.loadEmpty();
    expect(es.getCreatedIndices()).toEqual([]);
    es = fresh();
    es.clear();
    expect(es.getCreatedIndices()).toEqual([]);
  });
});

describe('no-op modifiers record nothing (defect 6)', () => {
  // A 10-point zigzag plus a marker record from an earlier generator run, so
  // "the old record is kept" is something the test can see.
  const setup = () => {
    const es = scriptOf(zigzag(10));
    es.insertActions([{ at: 20000, pos: 50 }]);
    es.markSaved();
    return es;
  };
  const CASES = [
    ['Double Speed on 2 points', [0, 1], doubleSpeed, []],
    ['Half Speed on 3 points', [0, 1, 2], halfSpeed, []],
    ['Reverse on an even-length zigzag', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], reverseActions, []],
    ['Remap to its own range', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], remapRange, [0, 100]],
    ['Offset clamped at 0', [0], offsetTime, [-500]],
    ['Remove Pauses with no pause', [0, 1, 2, 3, 4], removePauses, [5000]],
    ['Range Extend ×1', [0, 1, 2, 3], rangeExtend, [1]],
  ];
  it.each(CASES)('%s', (_name, indices, fn, args) => {
    const es = setup();
    selectIndices(es, indices);
    const before = pairs(es);
    const undoDepth = es._undoStack.length;
    let emitted = 0;
    es.onChange = () => { emitted++; };

    const status = es.applyModifier(fn, ...args);

    expect(status).toEqual({ changed: false, refused: false, created: 0 });
    expect(pairs(es)).toEqual(before);
    expect(es._undoStack.length).toBe(undoDepth);
    expect(es.dirty).toBe(false);
    expect(createdPairs(es)).toEqual(['20000:50']);
    expect(selectedPairs(es)).toEqual(indices.map((i) => before[i]));
    expect(emitted).toBe(0);
  });
});

describe('sequence modifiers refuse a selection with gaps (defect 4)', () => {
  // 13-point zigzag; Ctrl+3 (bottom third) picks every bottom, i.e. every
  // second point. The tops (odd indices) are the other every-second pattern.
  const SELECTIONS = [
    ['Ctrl+3 (bottom third)', (es) => es.selectByPositionRange(0, 33)],
    ['every second point from the 2nd', (es) => selectIndices(es, [1, 3, 5, 7, 9, 11])],
  ];
  const REFUSED = [
    ['Half Speed', halfSpeed, []],
    ['Double Speed', doubleSpeed, []],
    ['Reverse', reverseActions, []],
    ['Remove Pauses', removePauses, [100]],
    ['Range Extend', rangeExtend, [2]],
  ];
  for (const [selName, makeSelection] of SELECTIONS) {
    it.each(REFUSED)(`%s on ${selName}: nothing changes, no undo step, refused`, (_n, fn, args) => {
      const es = scriptOf(zigzag(13));
      es.insertActions([{ at: 20000, pos: 50 }]);
      es.markSaved();
      makeSelection(es);
      const before = pairs(es);
      const selBefore = selectedPairs(es);
      const undoDepth = es._undoStack.length;

      expect(es.refusesModifier(fn)).toBe(true);
      const status = es.applyModifier(fn, ...args);

      expect(status).toEqual({ changed: false, refused: true, created: 0 });
      expect(pairs(es)).toEqual(before);
      expect(selectedPairs(es)).toEqual(selBefore);
      expect(es._undoStack.length).toBe(undoDepth);
      expect(es.dirty).toBe(false);
      expect(createdPairs(es)).toEqual(['20000:50']);
    });
  }

  it('Remap still works on a gappy selection and changes only the selected points', () => {
    const es = scriptOf(zigzag(13));
    es.selectByPositionRange(0, 33);
    const status = es.applyModifier(remapRange, 20, 30);
    expect(status.changed).toBe(true);
    expect(status.refused).toBe(false);
    // A flat input remaps to the middle of the new range; tops untouched.
    expect(es.actions.map((a) => a.pos)).toEqual(zigzag(13).map((a) => (a.pos === 0 ? 25 : 100)));
    expect(es.actions.map((a) => a.at)).toEqual(zigzag(13).map((a) => a.at));
  });

  it('Offset Time still works on a gappy selection', () => {
    const es = scriptOf(zigzag(5));
    selectIndices(es, [1, 3]);
    expect(es.applyModifier(offsetTime, 100)).toEqual({ changed: true, refused: false, created: 2 });
    expect(pairs(es)).toEqual(['0:0', '600:100', '1000:0', '1600:100', '2000:0']);
  });

  it('a contiguous selection behaves exactly as before', () => {
    const es = scriptOf(zigzag(9));
    selectIndices(es, [0, 1, 2, 3, 4]);
    expect(es.isSelectionContiguous()).toBe(true);
    expect(es.refusesModifier(doubleSpeed)).toBe(false);
    expect(es.applyModifier(doubleSpeed).refused).toBe(false);
    expect(pairs(es)).toEqual([
      '0:0', '250:100', '500:0', '750:100', '1000:0', '1250:100', '1500:0', '1750:100', '2000:0',
      '2500:100', '3000:0', '3500:100', '4000:0',
    ]);
  });

  it('nothing selected means the whole script, which is never refused', () => {
    const es = scriptOf(zigzag(5, 1000));
    expect(es.refusesModifier(doubleSpeed)).toBe(false);
    expect(es.applyModifier(doubleSpeed).changed).toBe(true);
  });

  it('the guarded set is exactly the five order/spacing modifiers', () => {
    expect([...SEQUENCE_MODIFIERS]).toEqual(
      expect.arrayContaining([halfSpeed, doubleSpeed, reverseActions, removePauses, rangeExtend]),
    );
    expect(SEQUENCE_MODIFIERS.size).toBe(5);
    expect(SEQUENCE_MODIFIERS.has(remapRange)).toBe(false);
    expect(SEQUENCE_MODIFIERS.has(offsetTime)).toBe(false);
  });
});

describe('Equalize keeps the script sorted (defect 5)', () => {
  const setup = () => {
    const es = scriptOf([
      { at: 0, pos: 10 }, { at: 400, pos: 20 }, { at: 600, pos: 30 }, { at: 900, pos: 40 }, { at: 1000, pos: 50 },
    ]);
    selectIndices(es, [0, 3, 4]);
    es.equalizeSelected();
    return es;
  };

  it('re-sorts after retiming and keeps the same points selected', () => {
    const es = setup();
    // 900:40 retimed to 500 now sits before 600 (it used to stay after it).
    expect(pairs(es)).toEqual(['0:10', '400:20', '500:40', '600:30', '1000:50']);
    expect(selectedPairs(es)).toEqual(['0:10', '500:40', '1000:50']);
  });

  it('a later insert lands in the right place', () => {
    const es = setup();
    es.insertAction(550, 60);
    expect(pairs(es)).toEqual(['0:10', '400:20', '500:40', '550:60', '600:30', '1000:50']);
  });

  it('select-before-playhead sees every earlier point', () => {
    const es = setup();
    es.selectLeftOfCursor(550);
    expect(selectedPairs(es)).toEqual(['0:10', '400:20', '500:40']);
  });
});

describe('Range Extend is one pass over the original times (defect 8)', () => {
  it('4 points ×2 → 0, 200, 400, 600', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 100, pos: 100 }, { at: 200, pos: 0 }, { at: 300, pos: 100 }]);
    es.selectAll();
    expect(es.applyModifier(rangeExtend, 2).changed).toBe(true);
    expect(es.actions.map((a) => a.at)).toEqual([0, 200, 400, 600]);
    expect(es.actions.map((a) => a.pos)).toEqual([0, 100, 0, 100]);
  });

  it('8 points 100 ms apart ×1.5 stay evenly spaced', () => {
    const es = scriptOf(zigzag(8, 100));
    es.selectAll();
    es.applyModifier(rangeExtend, 1.5);
    expect(es.actions.map((a) => a.at)).toEqual([0, 150, 300, 450, 600, 750, 900, 1050]);
  });

  it('compression from the first selected point leaves the rest of the script alone', () => {
    const es = scriptOf([
      { at: 0, pos: 0 }, { at: 1000, pos: 0 }, { at: 1100, pos: 100 }, { at: 1200, pos: 0 }, { at: 1300, pos: 100 },
      { at: 2000, pos: 50 },
    ]);
    selectIndices(es, [1, 2, 3, 4]);
    es.applyModifier(rangeExtend, 0.5);
    expect(pairs(es)).toEqual(['0:0', '1000:0', '1050:100', '1100:0', '1150:100', '2000:50']);
    expect(selectedPairs(es)).toEqual(['1000:0', '1050:100', '1100:0', '1150:100']);
  });

  it('is a single undo step', () => {
    const es = scriptOf(zigzag(4, 100));
    es.selectAll();
    es.applyModifier(rangeExtend, 2);
    es.undo();
    expect(es.actions.map((a) => a.at)).toEqual([0, 100, 200, 300]);
  });

  it('a non-positive or non-numeric factor changes nothing', () => {
    for (const factor of [0, -1, NaN]) {
      const es = scriptOf(zigzag(4, 100));
      es.selectAll();
      expect(es.applyModifier(rangeExtend, factor)).toEqual({ changed: false, refused: false, created: 0 });
      expect(es.actions.map((a) => a.at)).toEqual([0, 100, 200, 300]);
    }
  });
});

describe('undo / redo carry the created record', () => {
  // Collinear input so the created points sit at 50 and a +20 nudge is visible.
  const setup = () => {
    const es = scriptOf([
      { at: 0, pos: 0 }, { at: 500, pos: 50 }, { at: 1000, pos: 100 }, { at: 1500, pos: 50 }, { at: 2000, pos: 0 },
    ]);
    es.insertActions([{ at: 9000, pos: 33 }]); // the record before the modifier
    es.selectAll();
    es.applyModifier(doubleSpeed);
    selectIndices(es, es.getCreatedIndices());
    es.moveActions(es.selectedIndices, 0, 20);
    return es;
  };

  it('undo of a nudge brings the new points back; undo of the modifier restores the older record', () => {
    const es = setup();
    expect(createdPairs(es)).toEqual(['250:70', '750:70', '1250:70', '1750:70']);
    es.undo();
    expect(createdPairs(es)).toEqual(['250:50', '750:50', '1250:50', '1750:50']);
    es.undo();
    expect(createdPairs(es)).toEqual(['9000:33']);
    es.redo();
    expect(createdPairs(es)).toEqual(['250:50', '750:50', '1250:50', '1750:50']);
    es.redo();
    expect(createdPairs(es)).toEqual(['250:70', '750:70', '1250:70', '1750:70']);
  });

  it("survives the per-path undo cache's JSON round trip (defect 9)", () => {
    const es = setup();
    // The same shape as script-editor.js _cacheUndoState / _onScriptSelectChange.
    const serializeStack = (stack) => stack.map((entry) => ({
      ...entry,
      selectedIndices: entry.selectedIndices ? [...entry.selectedIndices] : [],
    }));
    const deserializeStack = (stack) => stack.map((entry) => ({
      ...entry,
      selectedIndices: new Set(entry.selectedIndices || []),
    }));
    const cachedUndo = JSON.parse(JSON.stringify(serializeStack(es._undoStack)));

    const back = scriptOf(es.actions.map((a) => ({ at: a.at, pos: a.pos })));
    back._undoStack = deserializeStack(JSON.parse(JSON.stringify(cachedUndo)));
    expect(back.getCreatedIndices()).toEqual([]); // the live record resets on load
    back.undo();
    expect(createdPairs(back)).toEqual(['250:50', '750:50', '1250:50', '1750:50']);
  });
});
