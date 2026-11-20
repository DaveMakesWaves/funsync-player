/**
 * @vitest-environment node
 * No DOM required — EditableScript and the fill core are pure. See
 * notes/CLAUDE.md "Test environments" before changing this or adding DOM here.
 */
// EditableScript.replaceRange: how the Fill with pattern drawer (pattern
// library, Round 2) lands a fill, docked or from the pop-out (OP_FILL_RANGE).
//
//   - ONE undo step for the whole fill; undo / redo restore EXACTLY
//     (invariant I10 of the design: the actions, the selection, the created
//     record and the dirty flag);
//   - replace mode drops the points strictly between the anchors and keeps
//     the anchors; gap mode keeps every point;
//   - the new points are the selection and the created record (N);
//   - an empty fill changes nothing (absence is never destructive);
//   - with the REAL fill core: applying fillRange's `inserted` gives exactly
//     fillRange's own `actions`.
import { describe, it, expect } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';
import { fillRange } from '../../renderer/js/pattern-fill.js';

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 90 : 10 }));
const sel = (es) => [...es.selectedIndices].sort((a, b) => a - b);
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);
function scriptOf(actions) {
  const es = new EditableScript();
  es.loadFromData({ actions, metadata: { title: 't', bookmarks: [{ at: 700, name: 'b' }] } });
  return es;
}
/** Everything undo must give back, as plain data. */
const state = (es) => JSON.stringify({
  json: es.toFunscriptJSON(),
  sel: sel(es),
  created: es.getCreatedIndices(),
  dirty: es.dirty,
  revision: es.revision,
});

describe('replaceRange', () => {
  it('replace: the points strictly between t0 and t1 go, the anchors stay, the fill goes in', () => {
    const es = scriptOf(zigzag(9)); // 0 .. 4000
    const r = es.replaceRange(1000, 3000, [{ at: 1250, pos: 50 }, { at: 1600, pos: 70 }, { at: 2400, pos: 20 }]);
    expect(r).toEqual({ changed: true, created: 3, removed: 3 }); // 1500, 2000, 2500
    expect(pairs(es)).toEqual(['0:10', '500:90', '1000:10', '1250:50', '1600:70', '2400:20', '3000:10', '3500:90', '4000:10']);
  });

  it('gap: every point stays and the fill goes between them', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 5000, pos: 0 }]);
    const r = es.replaceRange(0, 5000, [{ at: 2000, pos: 40 }, { at: 3000, pos: 60 }], 'gap');
    expect(r).toEqual({ changed: true, created: 2, removed: 0 });
    expect(pairs(es)).toEqual(['0:0', '1000:100', '2000:40', '3000:60', '5000:0']);
  });

  it('is ONE undo step, and undo / redo restore exactly (I10)', () => {
    const es = scriptOf(zigzag(9));
    es.select(2);
    es.toggleSelect(6);
    const before = state(es);
    const undoDepth = es._undoStack.length;
    es.replaceRange(1000, 3000, [{ at: 1300, pos: 33 }, { at: 1900, pos: 77 }]);
    const after = state(es);
    expect(es._undoStack.length).toBe(undoDepth + 1);
    expect(es.dirty).toBe(true);
    expect(es.undo()).toBe(true);
    expect(state(es)).toBe(before);
    expect(es.dirty).toBe(false); // back on the loaded state: clean again
    expect(es.redo()).toBe(true);
    expect(state(es)).toBe(after);
    expect(es.undo()).toBe(true);
    expect(state(es)).toBe(before);
  });

  it('selects the new points and records them as created (N selects them again)', () => {
    const es = scriptOf(zigzag(9));
    es.selectAll();
    es.replaceRange(500, 2500, [{ at: 800, pos: 60 }, { at: 1200, pos: 30 }, { at: 2100, pos: 80 }]);
    const expected = es.actions.map((a, i) => [a, i]).filter(([a]) => [800, 1200, 2100].includes(a.at)).map(([, i]) => i);
    expect(sel(es)).toEqual(expected);
    es.clearSelection();
    expect(es.selectCreated()).toBe(3);
    expect(sel(es)).toEqual(expected);
  });

  it('an empty fill (or one entirely outside the stretch) changes nothing: no undo step, not dirty, nothing removed', () => {
    const es = scriptOf(zigzag(9));
    const before = state(es);
    for (const pts of [[], null, [{ at: 1000, pos: 5 }], [{ at: 3000, pos: 5 }], [{ at: 9000, pos: 5 }], [{ at: 'x', pos: 1 }]]) {
      expect(es.replaceRange(1000, 3000, pts)).toEqual({ changed: false, created: 0, removed: 0 });
    }
    expect(es.replaceRange(3000, 1000, [{ at: 2000, pos: 1 }]).changed).toBe(false); // t1 before t0
    expect(es.replaceRange(NaN, 1000, [{ at: 500, pos: 1 }]).changed).toBe(false);
    expect(state(es)).toBe(before);
    expect(es.canUndo).toBe(false);
  });

  it('rounds the points (whole ms, 0-100), drops any outside (t0, t1) and keeps one point per time', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 4000, pos: 100 }]);
    es.replaceRange(0, 4000, [
      { at: -5, pos: 50 }, { at: 0, pos: 50 }, { at: 1000.4, pos: 120 }, { at: 1000.2, pos: 30 }, { at: 2000, pos: -4.6 }, { at: 4000, pos: 9 },
    ]);
    expect(pairs(es)).toEqual(['0:0', '1000:30', '2000:0', '4000:100']);
  });

  it('gap mode: a fill point on an occupied time replaces that point (CB-02), nothing else moves', () => {
    const es = scriptOf([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 3000, pos: 0 }]);
    es.replaceRange(0, 3000, [{ at: 1000, pos: 55 }, { at: 2000, pos: 45 }], 'gap');
    expect(pairs(es)).toEqual(['0:0', '1000:55', '2000:45', '3000:0']);
  });

  it('leaves the metadata and bookmarks alone', () => {
    const es = scriptOf(zigzag(9));
    const meta = JSON.stringify(es.getMetadata());
    const marks = JSON.stringify(es.getBookmarks());
    es.replaceRange(1000, 3000, [{ at: 1500, pos: 50 }]);
    expect(JSON.stringify(es.getMetadata())).toBe(meta);
    expect(JSON.stringify(es.getBookmarks())).toBe(marks);
  });
});

describe('replaceRange with the real fill core', () => {
  const cases = [
    { name: 'replace, stretch', patternId: 'quick-full-strokes', options: {} },
    { name: 'replace, partial, reversed, slow', patternId: 'slow-tip-strokes', options: { endFit: 'partial', reversed: true, speed: 60 } },
    { name: 'gap', patternId: 'fast-base-strokes', options: { mode: 'gap' } },
  ];
  for (const c of cases) {
    it(`${c.name}: replaceRange(inserted) = fillRange's own actions, and undo restores the input exactly (I10)`, () => {
      // Points every 500 ms with a 6 s hole in the middle (for the gap case).
      const actions = [...zigzag(5), ...zigzag(5).map((a) => ({ at: a.at + 8000, pos: a.pos }))];
      const es = scriptOf(actions);
      const first = 1, last = 7;
      es.select(first);
      es.toggleSelect(last);
      const t0 = es.actions[first].at, t1 = es.actions[last].at;
      const before = state(es);
      const res = fillRange({ actions: es.actions, selection: { startMs: t0, endMs: t1 }, patternId: c.patternId, options: c.options });
      expect(res.inserted.length).toBeGreaterThan(0);
      const r = es.replaceRange(t0, t1, res.inserted, c.options.mode || 'replace');
      expect(r.changed).toBe(true);
      expect(r.created).toBe(res.inserted.length);
      expect(es.actions).toEqual(res.actions);
      expect(es._undoStack.length).toBe(1);
      es.undo();
      expect(state(es)).toBe(before);
    });
  }
});
