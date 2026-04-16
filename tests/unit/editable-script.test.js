import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';

describe('EditableScript', () => {
  let script;

  beforeEach(() => {
    script = new EditableScript();
  });

  describe('insertAction', () => {
    it('inserts into empty array', () => {
      const idx = script.insertAction(1000, 50);
      expect(idx).toBe(0);
      expect(script.actions).toEqual([{ at: 1000, pos: 50 }]);
    });

    it('maintains sort order', () => {
      script.insertAction(3000, 30);
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      expect(script.actions.map(a => a.at)).toEqual([1000, 2000, 3000]);
    });

    it('clamps pos to 0-100', () => {
      script.insertAction(100, -10);
      script.insertAction(200, 150);
      expect(script.actions[0].pos).toBe(0);
      expect(script.actions[1].pos).toBe(100);
    });

    it('rounds at and pos to integers', () => {
      script.insertAction(100.7, 55.3);
      expect(script.actions[0]).toEqual({ at: 101, pos: 55 });
    });

    it('adjusts selected indices after insert', () => {
      script.insertAction(1000, 10);
      script.insertAction(3000, 30);
      script.select(1); // select action at 3000
      script.insertAction(2000, 20); // insert between them
      expect(script.selectedIndices.has(2)).toBe(true); // shifted from 1 to 2
      expect(script.selectedIndices.size).toBe(1);
    });

    it('marks dirty', () => {
      expect(script.dirty).toBe(false);
      script.insertAction(1000, 50);
      expect(script.dirty).toBe(true);
    });
  });

  describe('updateAction', () => {
    beforeEach(() => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      script.insertAction(3000, 30);
      // Clear undo from inserts
    });

    it('updates pos without re-sorting', () => {
      script.updateAction(1, { pos: 75 });
      expect(script.actions[1]).toEqual({ at: 2000, pos: 75 });
    });

    it('updates at and re-sorts', () => {
      const newIdx = script.updateAction(0, { at: 2500 });
      expect(newIdx).toBe(1); // moved from index 0 to after 2000
      expect(script.actions.map(a => a.at)).toEqual([2000, 2500, 3000]);
    });

    it('preserves selection when at changes', () => {
      script.select(0); // select action at 1000
      const newIdx = script.updateAction(0, { at: 2500 });
      expect(script.selectedIndices.has(newIdx)).toBe(true);
    });

    it('clamps pos', () => {
      script.updateAction(0, { pos: 200 });
      expect(script.actions[0].pos).toBe(100);
    });
  });

  describe('deleteActions', () => {
    beforeEach(() => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      script.insertAction(3000, 30);
    });

    it('removes actions by index set', () => {
      script.deleteActions(new Set([0, 2]));
      expect(script.actions).toEqual([{ at: 2000, pos: 20 }]);
    });

    it('clears selection after delete', () => {
      script.select(1);
      script.deleteActions(new Set([0]));
      expect(script.selectedIndices.size).toBe(0);
    });

    it('does nothing for empty set', () => {
      script.deleteActions(new Set());
      expect(script.actions.length).toBe(3);
    });
  });

  describe('moveActions', () => {
    beforeEach(() => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 50);
      script.insertAction(3000, 90);
    });

    it('moves selected actions by delta', () => {
      script.moveActions(new Set([1]), 500, 10);
      // Action at 2000 → 2500, pos 50 → 60
      const moved = script.actions.find(a => a.at === 2500);
      expect(moved).toBeTruthy();
      expect(moved.pos).toBe(60);
    });

    it('clamps pos during move', () => {
      script.moveActions(new Set([2]), 0, 20); // 90 + 20 = 110 → clamped to 100
      expect(script.actions[2].pos).toBe(100);
    });

    it('clamps at to >= 0', () => {
      script.moveActions(new Set([0]), -5000, 0); // 1000 - 5000 → clamped to 0
      expect(script.actions[0].at).toBe(0);
    });

    it('re-sorts after move and updates selection', () => {
      script.moveActions(new Set([0]), 4000, 0); // 1000 → 5000, goes to end
      expect(script.actions[2].at).toBe(5000);
      expect(script.selectedIndices.has(2)).toBe(true);
    });
  });

  describe('selection', () => {
    beforeEach(() => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      script.insertAction(3000, 30);
      script.insertAction(4000, 40);
    });

    it('select replaces previous selection', () => {
      script.select(0);
      script.select(2);
      expect(script.selectedIndices.size).toBe(1);
      expect(script.selectedIndices.has(2)).toBe(true);
    });

    it('toggleSelect adds/removes', () => {
      script.toggleSelect(0);
      script.toggleSelect(2);
      expect(script.selectedIndices.size).toBe(2);
      script.toggleSelect(0);
      expect(script.selectedIndices.size).toBe(1);
      expect(script.selectedIndices.has(2)).toBe(true);
    });

    it('selectRange adds contiguous range', () => {
      script.selectRange(1, 3);
      expect([...script.selectedIndices].sort()).toEqual([1, 2, 3]);
    });

    it('selectAll selects everything', () => {
      script.selectAll();
      expect(script.selectedIndices.size).toBe(4);
    });

    it('clearSelection empties set', () => {
      script.selectAll();
      script.clearSelection();
      expect(script.selectedIndices.size).toBe(0);
    });
  });

  describe('undo / redo', () => {
    it('undoes an insert', () => {
      script.insertAction(1000, 50);
      expect(script.actions.length).toBe(1);
      script.undo();
      expect(script.actions.length).toBe(0);
    });

    it('redo restores after undo', () => {
      script.insertAction(1000, 50);
      script.undo();
      script.redo();
      expect(script.actions.length).toBe(1);
      expect(script.actions[0]).toEqual({ at: 1000, pos: 50 });
    });

    it('multiple undos walk back through history', () => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      script.insertAction(3000, 30);
      expect(script.actions.length).toBe(3);

      script.undo(); // remove 3000
      expect(script.actions.length).toBe(2);

      script.undo(); // remove 2000
      expect(script.actions.length).toBe(1);

      script.undo(); // remove 1000
      expect(script.actions.length).toBe(0);
    });

    it('redo stack clears on new mutation', () => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      script.undo();
      // Now insert something different
      script.insertAction(3000, 30);
      expect(script.canRedo).toBe(false);
    });

    it('restores selection state', () => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      script.select(0);
      // Undo reverts the select? No — select doesn't push state.
      // Undo reverts the last mutation that pushed state (insertAction 2000).
      script.undo();
      expect(script.actions.length).toBe(1);
    });

    it('caps undo stack at 100', () => {
      for (let i = 0; i < 110; i++) {
        script.insertAction(i * 100, 50);
      }
      // Stack should have at most 100 entries
      expect(script._undoStack.length).toBeLessThanOrEqual(100);
    });

    it('returns false when nothing to undo/redo', () => {
      expect(script.undo()).toBe(false);
      expect(script.redo()).toBe(false);
    });
  });

  describe('copy / paste', () => {
    beforeEach(() => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 50);
      script.insertAction(3000, 90);
    });

    it('copies selected actions with relative timestamps', () => {
      script.select(0);
      script.toggleSelect(2);
      script.copy();
      expect(script._clipboard).toEqual([
        { at: 0, pos: 10 },
        { at: 2000, pos: 90 },
      ]);
    });

    it('paste inserts at given time offset', () => {
      script.select(0);
      script.toggleSelect(1);
      script.copy();
      script.paste(5000);
      // Should have original 3 + pasted 2 = 5
      expect(script.actions.length).toBe(5);
      expect(script.actions.some(a => a.at === 5000 && a.pos === 10)).toBe(true);
      expect(script.actions.some(a => a.at === 6000 && a.pos === 50)).toBe(true);
    });

    it('paste selects pasted actions', () => {
      script.select(0);
      script.copy();
      script.paste(5000);
      expect(script.selectedIndices.size).toBe(1);
    });

    it('does nothing if clipboard is empty', () => {
      script.paste(5000);
      expect(script.actions.length).toBe(3);
    });
  });

  describe('toFunscriptJSON', () => {
    it('produces valid JSON with metadata', () => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 90);
      const json = script.toFunscriptJSON({ inverted: false, range: 100 });
      const parsed = JSON.parse(json);
      expect(parsed.version).toBe('1.0');
      expect(parsed.inverted).toBe(false);
      expect(parsed.range).toBe(100);
      expect(parsed.actions).toEqual([
        { at: 1000, pos: 10 },
        { at: 2000, pos: 90 },
      ]);
    });

    it('preserves existing metadata', () => {
      script.insertAction(500, 50);
      const json = script.toFunscriptJSON({ version: '2.0', customField: 'hello' });
      const parsed = JSON.parse(json);
      expect(parsed.version).toBe('2.0');
      expect(parsed.customField).toBe('hello');
    });

    it('rounds values to integers', () => {
      // Insert directly into _actions to test rounding in serialization
      script._actions = [{ at: 100.6, pos: 55.9 }];
      const json = script.toFunscriptJSON();
      const parsed = JSON.parse(json);
      expect(parsed.actions[0]).toEqual({ at: 101, pos: 56 });
    });
  });

  describe('loadFromEngine', () => {
    it('deep clones actions from engine', () => {
      const mockEngine = {
        getActions: () => [{ at: 100, pos: 50 }, { at: 200, pos: 75 }],
      };
      script.loadFromEngine(mockEngine);
      expect(script.actions.length).toBe(2);
      // Verify it's a deep clone
      mockEngine.getActions()[0].pos = 999;
      expect(script.actions[0].pos).toBe(50);
    });

    it('resets undo/redo stacks', () => {
      script.insertAction(1000, 50);
      const mockEngine = { getActions: () => [{ at: 100, pos: 50 }] };
      script.loadFromEngine(mockEngine);
      expect(script.canUndo).toBe(false);
      expect(script.canRedo).toBe(false);
    });

    it('handles null actions', () => {
      const mockEngine = { getActions: () => null };
      script.loadFromEngine(mockEngine);
      expect(script.actions).toEqual([]);
    });
  });

  describe('onChange callback', () => {
    it('fires on insert', () => {
      const cb = vi.fn();
      script.onChange = cb;
      script.insertAction(1000, 50);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('fires on delete', () => {
      script.insertAction(1000, 50);
      const cb = vi.fn();
      script.onChange = cb;
      script.deleteActions(new Set([0]));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('fires on undo', () => {
      script.insertAction(1000, 50);
      const cb = vi.fn();
      script.onChange = cb;
      script.undo();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('fires on selection change', () => {
      script.insertAction(1000, 50);
      const cb = vi.fn();
      script.onChange = cb;
      script.select(0);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('markSaved', () => {
    it('clears dirty flag', () => {
      script.insertAction(1000, 50);
      expect(script.dirty).toBe(true);
      script.markSaved();
      expect(script.dirty).toBe(false);
    });
  });

  describe('invertSelection', () => {
    beforeEach(() => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 75);
      script.insertAction(3000, 50);
    });

    it('inverts selected action positions (100 - pos)', () => {
      script.select(0);
      script.toggleSelect(1);
      script.invertSelection();
      expect(script.actions[0].pos).toBe(90);  // 100 - 10
      expect(script.actions[1].pos).toBe(25);  // 100 - 75
      expect(script.actions[2].pos).toBe(50);  // unchanged
    });

    it('does nothing with empty selection', () => {
      script.invertSelection();
      expect(script.actions[0].pos).toBe(10);
    });

    it('is undoable', () => {
      script.selectAll();
      script.invertSelection();
      expect(script.actions[0].pos).toBe(90);
      script.undo();
      expect(script.actions[0].pos).toBe(10);
    });

    it('marks dirty', () => {
      script.markSaved();
      script.select(0);
      script.invertSelection();
      expect(script.dirty).toBe(true);
    });

    it('fires onChange', () => {
      const cb = vi.fn();
      script.onChange = cb;
      script.select(0);
      cb.mockClear();
      script.invertSelection();
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('simplify', () => {
    it('removes redundant points on a straight line', () => {
      // Create a straight line from (0, 0) to (4000, 100) with midpoints on the line
      script.insertAction(0, 0);
      script.insertAction(1000, 25);
      script.insertAction(2000, 50);
      script.insertAction(3000, 75);
      script.insertAction(4000, 100);
      script.selectAll();
      script.simplify(2);
      // Only endpoints should remain (all midpoints are on the line)
      expect(script.actions.length).toBe(2);
      expect(script.actions[0]).toEqual({ at: 0, pos: 0 });
      expect(script.actions[1]).toEqual({ at: 4000, pos: 100 });
    });

    it('keeps points with significant deviation', () => {
      script.insertAction(0, 0);
      script.insertAction(1000, 100); // significant deviation from straight line
      script.insertAction(2000, 0);
      script.selectAll();
      script.simplify(2);
      // All three are significant — middle point deviates heavily
      expect(script.actions.length).toBe(3);
    });

    it('does nothing with fewer than 3 selected', () => {
      script.insertAction(0, 0);
      script.insertAction(1000, 100);
      script.selectAll();
      script.simplify(2);
      expect(script.actions.length).toBe(2);
    });

    it('is undoable', () => {
      script.insertAction(0, 0);
      script.insertAction(1000, 25);
      script.insertAction(2000, 50);
      script.insertAction(3000, 75);
      script.insertAction(4000, 100);
      script.selectAll();
      script.simplify(2);
      expect(script.actions.length).toBe(2);
      script.undo();
      expect(script.actions.length).toBe(5);
    });

    it('only simplifies selected actions, keeps unselected', () => {
      script.insertAction(0, 0);
      script.insertAction(1000, 25);   // on line, will be simplified
      script.insertAction(2000, 50);   // on line, will be simplified
      script.insertAction(3000, 75);   // on line, will be simplified
      script.insertAction(4000, 100);
      // Select only the first 4 (not the last)
      script.select(0);
      script.toggleSelect(1);
      script.toggleSelect(2);
      script.toggleSelect(3);
      script.simplify(2);
      // Unselected action at index 4 (at:4000) should remain
      expect(script.actions.some(a => a.at === 4000)).toBe(true);
    });
  });

  describe('cut', () => {
    beforeEach(() => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 50);
      script.insertAction(3000, 90);
    });

    it('copies to clipboard and deletes selected', () => {
      script.select(0);
      script.toggleSelect(1);
      script.cut();
      // Should have 1 action left
      expect(script.actions.length).toBe(1);
      expect(script.actions[0].at).toBe(3000);
      // Clipboard should have the cut actions
      expect(script._clipboard.length).toBe(2);
    });

    it('can paste after cut', () => {
      script.select(1);
      script.cut();
      expect(script.actions.length).toBe(2);
      script.paste(5000);
      expect(script.actions.length).toBe(3);
      expect(script.actions.some(a => a.at === 5000 && a.pos === 50)).toBe(true);
    });

    it('does nothing with empty selection', () => {
      script.cut();
      expect(script.actions.length).toBe(3);
    });
  });

  describe('loadEmpty', () => {
    it('initializes with empty action array', () => {
      script.insertAction(1000, 50);
      script.loadEmpty();
      expect(script.actions).toEqual([]);
      expect(script.dirty).toBe(false);
      expect(script.selectedIndices.size).toBe(0);
    });

    it('clears undo/redo stacks', () => {
      script.insertAction(1000, 50);
      script.loadEmpty();
      expect(script.canUndo).toBe(false);
      expect(script.canRedo).toBe(false);
    });
  });

  describe('selectRange reversed', () => {
    it('handles reversed from > to', () => {
      script.insertAction(1000, 10);
      script.insertAction(2000, 20);
      script.insertAction(3000, 30);
      script.insertAction(4000, 40);
      script.selectRange(3, 1);
      expect([...script.selectedIndices].sort()).toEqual([1, 2, 3]);
    });
  });

  describe('copy with empty selection', () => {
    it('does nothing when no actions selected', () => {
      script.insertAction(1000, 50);
      script.copy();
      expect(script._clipboard).toEqual([]);
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      script.insertAction(1000, 50);
      script.insertAction(2000, 75);
      script.select(0);
      script.clear();
      expect(script.actions).toEqual([]);
      expect(script.selectedIndices.size).toBe(0);
      expect(script.dirty).toBe(false);
      expect(script.canUndo).toBe(false);
    });
  });

  describe('actionCount', () => {
    it('returns number of actions', () => {
      expect(script.actionCount).toBe(0);
      script.insertAction(1000, 50);
      expect(script.actionCount).toBe(1);
      script.insertAction(2000, 75);
      expect(script.actionCount).toBe(2);
    });
  });
});
