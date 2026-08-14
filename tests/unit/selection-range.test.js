/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Shift-click range selection.
//
// Community request: "hold shift to select every video between the first and
// second selected".
//
// The rules worth pinning are the ones that are easy to get subtly wrong:
// which ORDER the range follows, what happens to FOLDER rows in
// folder-browse mode, and what happens when the anchor no longer exists
// because the filter changed under it.
import { describe, it, expect } from 'vitest';
import { rangeBetween, allSelectablePaths, nextAnchor } from '../../renderer/js/selection-range.js';

const v = (p) => ({ path: p });
const folder = (name) => ({ isFolder: true, node: { path: name } });
const LIST = [v('a'), v('b'), v('c'), v('d'), v('e')];

describe('rangeBetween', () => {
  it('selects everything between the two ends, inclusive', () => {
    expect(rangeBetween(LIST, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  it('is direction-agnostic — dragging up matches dragging down', () => {
    expect(rangeBetween(LIST, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('handles anchor and target being the same item', () => {
    expect(rangeBetween(LIST, 'c', 'c')).toEqual(['c']);
  });

  it('spans the whole list', () => {
    expect(rangeBetween(LIST, 'a', 'e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  // The order is the SORTED, FILTERED on-screen order, because that is what
  // "everything between these two" means to someone looking at the screen.
  it('follows the given order, not any underlying disk order', () => {
    const sorted = [v('z'), v('m'), v('a')];
    expect(rangeBetween(sorted, 'z', 'a')).toEqual(['z', 'm', 'a']);
  });
});

describe('folder rows', () => {
  // Implicitly selecting a folder's entire contents because it happened to
  // sit inside a dragged range is a nasty surprise on a big library.
  it('skips folder entries inside the span', () => {
    const mixed = [v('a'), folder('Clips'), v('b'), folder('More'), v('c')];
    expect(rangeBetween(mixed, 'a', 'c')).toEqual(['a', 'b', 'c']);
  });

  it('excludes folders from select-all', () => {
    const mixed = [folder('Clips'), v('a'), folder('More'), v('b')];
    expect(allSelectablePaths(mixed)).toEqual(['a', 'b']);
  });

  it('cannot anchor on a folder', () => {
    const mixed = [folder('Clips'), v('a'), v('b')];
    // 'Clips' is not a selectable path, so it degrades to a single selection.
    expect(rangeBetween(mixed, 'Clips', 'b')).toEqual(['b']);
  });
});

describe('the anchor going stale', () => {
  // Select a range, then change the filter: the anchor now points at
  // something that is not in the list. It must degrade, not throw and not
  // select something arbitrary.
  it('falls back to a single selection when the anchor was filtered away', () => {
    expect(rangeBetween(LIST, 'gone', 'c')).toEqual(['c']);
  });

  it('falls back to a single selection with no anchor at all', () => {
    expect(rangeBetween(LIST, null, 'c')).toEqual(['c']);
  });

  it('returns nothing when the TARGET is not in the list', () => {
    expect(rangeBetween(LIST, 'a', 'gone')).toEqual([]);
  });

  it('survives an empty or missing list', () => {
    expect(rangeBetween([], 'a', 'b')).toEqual([]);
    expect(rangeBetween(undefined, 'a', 'b')).toEqual([]);
  });
});

describe('nextAnchor', () => {
  // The whole point of the interaction: extend, then extend further from the
  // SAME start. Moving the anchor turns a second shift-click into a new tiny
  // range, which is exactly the frustrating behaviour people complain about.
  it('does NOT move on a shift-click', () => {
    expect(nextAnchor('b', 'd', true)).toBe('b');
  });

  it('moves on a plain click', () => {
    expect(nextAnchor('b', 'd', false)).toBe('d');
  });

  it('adopts the clicked item when there is no anchor yet, even with shift', () => {
    expect(nextAnchor(null, 'd', true)).toBe('d');
  });
});

describe('extend and re-extend', () => {
  it('a second shift-click from the same anchor grows the range', () => {
    let anchor = 'b';
    const first = rangeBetween(LIST, anchor, 'c');
    anchor = nextAnchor(anchor, 'c', true);
    const second = rangeBetween(LIST, anchor, 'e');
    expect(first).toEqual(['b', 'c']);
    expect(second).toEqual(['b', 'c', 'd', 'e']);
  });
});
