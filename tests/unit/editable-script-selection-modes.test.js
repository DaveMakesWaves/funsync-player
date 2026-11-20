/**
 * @vitest-environment node
 * No DOM required — EditableScript is DOM-free. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The two editor selection modes belgriffinite asked for in #261
// ("select just those midpoints just created and move them", "every other
// point, or every X number of points"), on the REAL EditableScript.
//
//   Every Nth point  — countEveryNth (pure, the dialog's live line) and
//                      selectEveryNth (research §4.2).
//   New points only  — selectCreated, the N key (§4.3).
//
// Both are selection only, like Ctrl+1/2/3 (Dave, Q4): no undo step, and the
// dirty flag is never touched. With autosave on, dirty means a file write and
// a Handy re-upload, so a selection command that set it would re-upload the
// script every time it was used.
//
// Assertions are on the resulting selection, the actions, the undo stack and
// the dirty flag.
import { describe, it, expect, vi } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';
import { doubleSpeed, halfSpeed, reverseActions } from '../../renderer/js/script-modifiers.js';

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 100 : 0 }));
/** 0, 50, 100, 50, 0, … — a zigzag with midpoints (research §4.2's worked examples). */
const withMidpoints = (n, step = 250) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: [0, 50, 100, 50][i % 4] }));
const scriptOf = (actions) => { const es = new EditableScript(); es.loadFromData({ actions }); return es; };
const sel = (es) => [...es.selectedIndices].sort((a, b) => a - b);
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);
const selPairs = (es) => sel(es).map((i) => `${es.actions[i].at}:${es.actions[i].pos}`);

describe('selectEveryNth: the rule (k >= start, (k - start) % n === 0, k numbered 1..K)', () => {
  it('10 points selected: (2, 1) gives points 1, 3, 5, 7, 9; (2, 2) gives 2, 4, 6, 8, 10', () => {
    const es = scriptOf(zigzag(10));
    es.selectAll();
    es.selectEveryNth(2, 1);
    expect(sel(es)).toEqual([0, 2, 4, 6, 8]);
    es.selectAll();
    es.selectEveryNth(2, 2);
    expect(sel(es)).toEqual([1, 3, 5, 7, 9]);
  });

  it('on a zigzag with midpoints, (4, 3) selects the tops; (4, 1) the bottoms; (2, 2) the midpoints; (2, 1) the turning points', () => {
    const es = scriptOf(withMidpoints(13));
    const pick = (n, start) => { es.selectAll(); es.selectEveryNth(n, start); return sel(es).map((i) => es.actions[i].pos); };
    expect(pick(4, 3)).toEqual([100, 100, 100]);
    expect(pick(4, 1)).toEqual([0, 0, 0, 0]);
    expect(pick(2, 2)).toEqual([50, 50, 50, 50, 50, 50]);
    expect(pick(2, 1)).toEqual([0, 100, 0, 100, 0, 100, 0]);
  });

  it('counts only the points in scope: a selection built out of order gives the same result as a sorted one', () => {
    const a = scriptOf(zigzag(12));
    a._selectedIndices = new Set([3, 4, 5, 6, 7, 8, 9]);
    a.selectEveryNth(3, 2);
    const b = scriptOf(zigzag(12));
    b._selectedIndices = new Set([9, 4, 7, 3, 8, 6, 5]); // Set iteration order is insertion order
    b.selectEveryNth(3, 2);
    expect(sel(a)).toEqual([4, 7]);
    expect(sel(b)).toEqual([4, 7]);
  });

  it('with nothing selected the whole script is in scope (Dave, Q9)', () => {
    const es = scriptOf(zigzag(7));
    const r = es.selectEveryNth(3, 1);
    expect(sel(es)).toEqual([0, 3, 6]);
    expect(r).toMatchObject({ scope: 7, n: 3, start: 1, count: 3 });
  });

  it('two points on the same timestamp count as two, in index order', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 500, pos: 0 }, { at: 1000, pos: 100 }]);
    es.selectEveryNth(2, 2);
    expect(selPairs(es)).toEqual(['500:100', '1000:100']);
  });

  it('returns the counts the toast needs: "Selected {count} of {scope} points."', () => {
    const es = scriptOf(zigzag(30));
    es._selectedIndices = new Set([...Array(24).keys()]);
    expect(es.selectEveryNth(2, 1)).toMatchObject({ scope: 24, count: 12 });
  });
});

describe('selectEveryNth: bad input is clamped, never an error (§4.9)', () => {
  const run = (n, start, size = 10) => {
    const es = scriptOf(zigzag(size));
    es.selectAll();
    const r = es.selectEveryNth(n, start);
    return { r, picked: sel(es) };
  };

  it('N greater than the points in scope clamps to K: only the start point', () => {
    expect(run(50, 1)).toMatchObject({ r: { n: 10, start: 1, count: 1 }, picked: [0] });
    expect(run(50, 4)).toMatchObject({ r: { n: 10, start: 4, count: 1 }, picked: [3] });
  });

  it('N = 1 clamps to 2; Start at = 0 clamps to 1; Start at > N clamps to N', () => {
    expect(run(1, 1)).toMatchObject({ r: { n: 2, start: 1 }, picked: [0, 2, 4, 6, 8] });
    expect(run(3, 0)).toMatchObject({ r: { n: 3, start: 1 }, picked: [0, 3, 6, 9] });
    expect(run(3, 9)).toMatchObject({ r: { n: 3, start: 3 }, picked: [2, 5, 8] });
  });

  it('non-numeric input takes the defaults (Every 2, Start 1); strings from an <input> work; fractions round', () => {
    expect(run('abc', undefined)).toMatchObject({ r: { n: 2, start: 1 }, picked: [0, 2, 4, 6, 8] });
    expect(run('3', '2')).toMatchObject({ r: { n: 3, start: 2 }, picked: [1, 4, 7] });
    expect(run(2.6, 1.4)).toMatchObject({ r: { n: 3, start: 1 } });
  });

  it('fewer than 2 points in scope: nothing changes, count 0', () => {
    const one = scriptOf(zigzag(1));
    one.select(0);
    expect(one.selectEveryNth(2, 1)).toMatchObject({ scope: 1, count: 0 });
    expect(sel(one)).toEqual([0]);

    const es = scriptOf(zigzag(10));
    es.select(4); // a 1-point selection is the scope: K = 1
    expect(es.selectEveryNth(2, 1)).toMatchObject({ scope: 1, count: 0 });
    expect(sel(es)).toEqual([4]);

    const empty = scriptOf([]);
    expect(empty.selectEveryNth(2, 1)).toMatchObject({ scope: 0, count: 0 });
  });

  it('indices that point past the end (a stale pop-out OP_SELECT) are not counted', () => {
    const es = scriptOf(zigzag(6));
    es._selectedIndices = new Set([0, 1, 2, 3, 99]);
    expect(es.countEveryNth(2, 1)).toMatchObject({ scope: 4, indices: [0, 2] });
  });
});

describe('Every Nth is selection only (Dave, Q4)', () => {
  it('no undo step, dirty stays false, the actions are untouched', () => {
    const es = scriptOf(zigzag(10));
    es.selectAll();
    const before = pairs(es);
    es.selectEveryNth(2, 2);
    expect(es._undoStack).toHaveLength(0);
    expect(es.dirty).toBe(false);
    expect(pairs(es)).toEqual(before);
  });

  it('after an edit, Every Nth leaves the undo stack exactly as the edit left it, and Ctrl+Z undoes the EDIT', () => {
    const es = scriptOf(zigzag(10));
    es.insertAction(5000, 50);
    es.markSaved();
    es.selectAll();
    es.selectEveryNth(2, 1);
    expect(es._undoStack).toHaveLength(1);
    expect(es.dirty).toBe(false);
    es.undo();
    expect(es.actions).toHaveLength(10);
  });

  it('countEveryNth is pure: the selection is the same Set with the same contents, and nothing is emitted', () => {
    const es = scriptOf(zigzag(10));
    es.selectAll();
    const setBefore = es.selectedIndices;
    const onChange = vi.fn();
    es.onChange = onChange;
    const r = es.countEveryNth(3, 2);
    expect(r).toMatchObject({ scope: 10, count: 3, indices: [1, 4, 7] });
    expect(es.selectedIndices).toBe(setBefore);
    expect(sel(es)).toEqual([...Array(10).keys()]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('selectCreated (New points only)', () => {
  it('after Double Speed it selects ONLY the new points (3 per full cycle), not the kept endpoints', () => {
    const es = scriptOf(zigzag(5)); // 2 full cycles
    es.selectAll();
    es.applyModifier(doubleSpeed);
    expect(sel(es)).toHaveLength(9); // the modifier still selects its whole output (Dave, Q1)
    expect(es.selectCreated()).toBe(6);
    expect(selPairs(es)).toEqual(['250:100', '500:0', '750:100', '1250:100', '1500:0', '1750:100']);
  });

  it('after a whole-script modifier (nothing selected, so nothing to narrow) it still finds the new points', () => {
    const es = scriptOf(zigzag(5));
    es.applyModifier(doubleSpeed);
    expect(es.selectedIndices.size).toBe(0);
    expect(es.selectCreated()).toBe(6);
  });

  it('after a generator (insertActions: Generate Pattern, Beats, Fill Gaps) it selects what was inserted', () => {
    const es = scriptOf(zigzag(3));
    es.insertActions([{ at: 5000, pos: 10 }, { at: 5500, pos: 90 }]);
    es.clearSelection();
    expect(es.selectCreated()).toBe(2);
    expect(selPairs(es)).toEqual(['5000:10', '5500:90']);
  });

  it('after moveActions they are still the same points, where they moved to', () => {
    const es = scriptOf(zigzag(5));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.selectCreated();
    es.moveActions(es.selectedIndices, 0, -20);
    es.clearSelection();
    expect(es.selectCreated()).toBe(6);
    expect(selPairs(es)).toEqual(['250:80', '500:0', '750:80', '1250:80', '1500:0', '1750:80']);
  });

  it('after deleting one of them, the rest remain', () => {
    const es = scriptOf(zigzag(5));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.deleteActions(new Set([2])); // 500:0, a new point
    expect(es.selectCreated()).toBe(5);
    expect(selPairs(es)).toEqual(['250:100', '750:100', '1250:100', '1500:0', '1750:100']);
  });

  it('every created point deleted: returns 0 and the selection stays as it is', () => {
    const es = scriptOf(zigzag(3));
    es.insertActions([{ at: 5000, pos: 10 }]);
    es.deleteActions(new Set([3]));
    es.select(0);
    expect(es.selectCreated()).toBe(0);
    expect(sel(es)).toEqual([0]);
  });

  it('undo of a nudge, then N, still selects the new points (back where they were)', () => {
    const es = scriptOf(zigzag(5));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.selectCreated();
    es.moveActions(es.selectedIndices, 0, -20);
    es.undo(); // the nudge
    es.clearSelection();
    expect(es.selectCreated()).toBe(6);
    expect(selPairs(es)).toEqual(['250:100', '500:0', '750:100', '1250:100', '1500:0', '1750:100']);
  });

  it('undo of the modifier restores the record from BEFORE it; redo brings this one back', () => {
    const es = scriptOf(zigzag(5));
    es.insertActions([{ at: 9000, pos: 33 }]); // an earlier generator run
    es.selectAll();
    es.applyModifier(reverseActions);
    es.undo(); // the Reverse
    es.clearSelection();
    expect(es.selectCreated()).toBe(1);
    expect(selPairs(es)).toEqual(['9000:33']);
    es.redo();
    es.clearSelection();
    expect(es.selectCreated()).toBeGreaterThan(1);
    expect(selPairs(es)).not.toContain('9000:33');
  });

  it('a refused modifier keeps the previous record; a real change that created nothing empties it', () => {
    const es = scriptOf(zigzag(13));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.selectByPositionRange(0, 33); // gaps → the next Reverse is refused
    expect(es.applyModifier(reverseActions)).toMatchObject({ refused: true });
    es.clearSelection();
    expect(es.selectCreated()).toBe(18);

    const half = scriptOf(zigzag(8)); // Half Speed at length 8 creates nothing (§4.3)
    half.insertActions([{ at: 9000, pos: 33 }]);
    half.selectAll();
    expect(half.applyModifier(halfSpeed)).toMatchObject({ changed: true, created: 0 });
    half.select(0);
    expect(half.selectCreated()).toBe(0);
    expect(sel(half)).toEqual([0]);
  });

  it('the loaders leave nothing to select (loadFromEngine, loadFromData, loadEmpty, clear)', () => {
    // NOTE: these pass even without the explicit resets in the loaders —
    // every loader builds new action objects, so old references drop out of
    // getCreatedIndices anyway (the core run's H17). They pin the user-visible
    // outcome, not the reset line.
    const make = () => { const es = scriptOf(zigzag(5)); es.selectAll(); es.applyModifier(doubleSpeed); return es; };
    const engine = { getActions: () => zigzag(5), getMetadata: () => null };
    for (const load of [
      (es) => es.loadFromEngine(engine),
      (es) => es.loadFromData({ actions: zigzag(5) }),
      (es) => es.loadEmpty(),
      (es) => es.clear(),
    ]) {
      const es = make();
      load(es);
      if (es.actions.length) es.select(1);
      const before = sel(es);
      expect(es.selectCreated()).toBe(0);
      expect(sel(es)).toEqual(before);
    }
  });

  it('is selection only: no undo step, dirty stays false; an empty record emits nothing', () => {
    const es = scriptOf(zigzag(5));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.markSaved();
    const depth = es._undoStack.length;
    es.selectCreated();
    expect(es._undoStack).toHaveLength(depth);
    expect(es.dirty).toBe(false);

    const fresh = scriptOf(zigzag(5));
    const onChange = vi.fn();
    fresh.onChange = onChange;
    expect(fresh.selectCreated()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("belgriffinite's workflow, end to end (#261)", () => {
  it('Select all → Double Speed → New points only → Every 3 from 2 → nudge +20 moves ONLY the 50 % points', () => {
    // A 0/100 zigzag starting at 0, so the 50 % points sit at 0 and a +20
    // nudge does not clamp.
    const es = scriptOf(zigzag(9));
    es.selectAll();
    es.applyModifier(doubleSpeed);
    const afterDouble = pairs(es);

    expect(es.selectCreated()).toBe(12);       // 3 per cycle × 4 cycles
    es.selectEveryNth(3, 2);                    // 25 %, 50 %, 75 % → the middle one
    expect(selPairs(es)).toEqual(['500:0', '1500:0', '2500:0', '3500:0']);
    es.moveActions(es.selectedIndices, 0, 20);

    const moved = new Set(['500', '1500', '2500', '3500']);
    const now = pairs(es);
    expect(now).toHaveLength(afterDouble.length);
    for (let i = 0; i < now.length; i++) {
      const [at, pos] = afterDouble[i].split(':');
      expect(now[i]).toBe(moved.has(at) ? `${at}:${Number(pos) + 20}` : afterDouble[i]);
    }
    // Two undo steps in the whole flow: the modifier and the nudge.
    expect(es._undoStack).toHaveLength(2);
  });
});
