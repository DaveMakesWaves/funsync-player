// Sort picker: five FIELDS plus a direction toggle, replacing ten combined
// field+direction entries (Dave, 2026-08-06).
//
// `_sortKey` stays `field:dir` so nothing downstream changed — these pin
// the parts that did.
import { describe, it, expect, beforeEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

function makeLib(sortKey = 'name:asc') {
  const lib = Object.create(Library.prototype);
  lib._sortKey = sortKey;
  return lib;
}

describe('sort options', () => {
  it('lists five fields, not ten combinations', () => {
    expect(Library._SORT_OPTIONS).toHaveLength(5);
    expect(Library._SORT_OPTIONS.map((o) => o.value))
      .toEqual(['name', 'dateAdded', 'duration', 'avgSpeed', 'maxSpeed']);
  });

  it('gives every field a sensible default direction', () => {
    const dirs = Object.fromEntries(Library._SORT_OPTIONS.map((o) => [o.value, o.defaultDir]));
    // Newest first for dates and fastest first for speed are what people
    // actually want; A-Z and shortest-first for the rest.
    expect(dirs).toEqual({
      name: 'asc', dateAdded: 'desc', duration: 'asc', avgSpeed: 'desc', maxSpeed: 'desc',
    });
  });

  it('keeps the speed flag so the unmatched tab can still disable them', () => {
    const speed = Library._SORT_OPTIONS.filter((o) => o.isSpeed).map((o) => o.value);
    expect(speed).toEqual(['avgSpeed', 'maxSpeed']);
  });

  it('has a directional label for every field/direction pair', () => {
    // The trigger button reuses these, so a missing one would fall back to
    // the generic "Sort" and lose the specific wording.
    for (const opt of Library._SORT_OPTIONS) {
      for (const dir of ['asc', 'desc']) {
        expect(Library._SORT_LABELS[`${opt.value}:${dir}`]).toBeTruthy();
      }
    }
    expect(Object.keys(Library._SORT_LABELS)).toHaveLength(10);
  });
});

describe('_sortParts', () => {
  it('splits the stored key', () => {
    expect(makeLib('duration:desc')._sortParts()).toEqual(['duration', 'desc']);
  });

  it('defaults to name ascending', () => {
    expect(makeLib(undefined)._sortParts()).toEqual(['name', 'asc']);
    expect(makeLib('')._sortParts()).toEqual(['name', 'asc']);
  });

  it('treats anything that is not "desc" as ascending', () => {
    // Guards against an old or corrupt persisted value flipping the order.
    expect(makeLib('name:sideways')._sortParts()).toEqual(['name', 'asc']);
    expect(makeLib('name')._sortParts()).toEqual(['name', 'asc']);
  });

  it('reads a legacy combined key without breaking', () => {
    // Values persisted before the split are already `field:dir`.
    expect(makeLib('maxSpeed:desc')._sortParts()).toEqual(['maxSpeed', 'desc']);
  });
});

// --- Per-row direction toggle (Dave, 2026-08-06) ---
//
// Each row carries its own direction: the wording states it, an arrow
// repeats it, and re-clicking the SELECTED row flips both while the
// popover stays open. Selecting a different row closes it, as before.
describe('sort picker interaction', () => {
  // Each mount appends a container carrying the same element IDs. Left
  // to accumulate, jsdom stops resolving `#library-sort-btn` once the
  // document holds duplicates — the first test passes and every one
  // after it fails, which looks exactly like a broken component.
  beforeEach(() => { document.body.innerHTML = ''; });

  function mountPicker(sortKey = 'name:asc') {
    const container = document.createElement('div');
    container.innerHTML = `
      <button class="library__picker-btn" id="library-sort-btn" aria-expanded="false">
        <span class="library__picker-icon"></span>
        <span class="library__picker-label">Sort</span>
      </button>
      <div class="library__picker-pop" id="library-sort-pop" hidden></div>`;
    document.body.appendChild(container);

    const lib = Object.create(Library.prototype);
    lib._container = container;
    lib._sortKey = sortKey;
    lib._scanning = true;              // skip _applyFilters
    lib._closePicker = () => { lib._closed = (lib._closed || 0) + 1; };
    lib._togglePicker = () => {};
    lib._wirePickerDismissal = () => {};
    lib._buildSortPicker();
    return { lib, container };
  }

  const rowFor = (container, field) =>
    container.querySelector(`.library__picker-item[data-value="${field}"]`);

  it('renders five rows with directional wording and an arrow each', () => {
    const { container } = mountPicker();
    const rows = container.querySelectorAll('.library__picker-item');
    expect(rows).toHaveLength(5);
    expect(rowFor(container, 'name').querySelector('.library__picker-item-label').textContent)
      .toBe('Name A-Z');
    expect(rowFor(container, 'name').querySelector('.library__sort-arrow').textContent).toBe('↑');
    // Unselected rows show their own default direction, not a neutral name.
    expect(rowFor(container, 'dateAdded').querySelector('.library__picker-item-label').textContent)
      .toBe('Recently Added');
  });

  it('flips direction when the selected row is clicked again', () => {
    const { lib, container } = mountPicker('name:asc');
    rowFor(container, 'name').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(lib._sortKey).toBe('name:desc');
    expect(rowFor(container, 'name').querySelector('.library__picker-item-label').textContent)
      .toBe('Name Z-A');
    expect(rowFor(container, 'name').querySelector('.library__sort-arrow').textContent).toBe('↓');
  });

  it('keeps the popover open on a direction flip', () => {
    const { lib, container } = mountPicker('name:asc');
    rowFor(container, 'name').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(lib._closed).toBeUndefined();
  });

  it('closes the popover when a different field is selected', () => {
    const { lib, container } = mountPicker('name:asc');
    const radio = rowFor(container, 'duration').querySelector('input');
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));

    expect(lib._sortKey).toBe('duration:asc');
    expect(lib._closed).toBe(1);
  });

  it('remembers each field direction independently', () => {
    const { lib, container } = mountPicker('name:asc');
    // Flip Name to Z-A...
    rowFor(container, 'name').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(lib._sortKey).toBe('name:desc');

    // ...switch away...
    const dur = rowFor(container, 'duration').querySelector('input');
    dur.checked = true;
    dur.dispatchEvent(new Event('change'));
    expect(lib._sortKey).toBe('duration:asc');

    // ...and back: Name is still Z-A, not silently reset.
    const nameRadio = rowFor(container, 'name').querySelector('input');
    nameRadio.checked = true;
    nameRadio.dispatchEvent(new Event('change'));
    expect(lib._sortKey).toBe('name:desc');
  });

  it('flips exactly once when the row TEXT is clicked', () => {
    // The regression: a label-mounted handler ran twice for one click —
    // the label forwards a synthetic click to its control, which bubbles
    // back up — so the flip undid itself and nothing appeared to happen.
    const { lib, container } = mountPicker('name:asc');
    const row = rowFor(container, 'name');
    row.querySelector('.library__picker-item-label')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(lib._sortKey).toBe('name:desc');
    expect(row.querySelector('.library__picker-item-label').textContent).toBe('Name Z-A');
  });

  it('flips exactly once when the radio itself is clicked', () => {
    const { lib, container } = mountPicker('name:asc');
    rowFor(container, 'name').querySelector('input')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(lib._sortKey).toBe('name:desc');
  });

  it('flips back and forth rather than sticking', () => {
    const { lib, container } = mountPicker('name:asc');
    const text = () => rowFor(container, 'name').querySelector('.library__picker-item-label');
    const click = () => text().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    click();
    expect(lib._sortKey).toBe('name:desc');
    click();
    expect(lib._sortKey).toBe('name:asc');
    expect(text().textContent).toBe('Name A-Z');
  });

  it('seeds direction memory from the persisted sort key', () => {
    const { container } = mountPicker('duration:desc');
    expect(rowFor(container, 'duration').querySelector('.library__picker-item-label').textContent)
      .toBe('Duration Long-Short');
    expect(rowFor(container, 'duration').querySelector('.library__sort-arrow').textContent).toBe('↓');
  });

  it('mirrors the current sort onto the trigger button', () => {
    const { container } = mountPicker('avgSpeed:desc');
    expect(container.querySelector('#library-sort-btn .library__picker-label').textContent)
      .toBe('Avg Speed Fast-Slow');
  });
});

// --- The sort actually applied (Dave, 2026-08-06: "switching desc to asc
// doesn't work") ---
//
// This is the code path the picker tests above CANNOT reach: they set
// `_scanning = true` to skip `_applyFilters`, and the bug lived inside it.
// `_applyFilters` read the checked radio's `value` straight into `_sortKey`.
// That worked when values were `name:asc`; once the picker moved to five
// bare fields the value became `name`, so the direction was dropped,
// `_sortKey` was clobbered, and `split(':')` gave the sorter `undefined` —
// ascending, every time. The label flipped (that happens earlier) while the
// grid never re-sorted, which is exactly what was reported.
describe('_effectiveSort', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  // Deliberately NOT attached to document.body, and `pop` is held by
  // reference rather than looked up by id: this helper runs several times
  // inside one test, and jsdom stops resolving an id selector once the
  // document holds duplicates of it. (Same trap as the picker tests above —
  // it has now cost time twice.)
  function withPicker(checkedField, { sortKey = 'name:asc', dirs = null } = {}) {
    const container = document.createElement('div');
    const pop = document.createElement('div');
    pop.id = 'library-sort-pop';
    container.appendChild(pop);
    for (const opt of Library._SORT_OPTIONS) {
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'library-sort';
      r.value = opt.value;
      r.checked = opt.value === checkedField;
      pop.appendChild(r);
    }
    const lib = Object.create(Library.prototype);
    lib._container = container;
    lib._sortKey = sortKey;
    lib._sortDirs = dirs;
    return lib;
  }

  it('keeps the direction the user chose', () => {
    // The regression, stated plainly.
    const lib = withPicker('name', { sortKey: 'name:desc', dirs: { name: 'desc' } });
    expect(lib._effectiveSort()).toEqual(['name', 'desc']);
  });

  it('never yields an undefined direction', () => {
    // `split(':')` on a direction-less key handed `undefined` to sortVideos.
    for (const field of Library._SORT_OPTIONS.map((o) => o.value)) {
      const [, dir] = withPicker(field, { sortKey: field })._effectiveSort();
      expect(['asc', 'desc']).toContain(dir);
    }
  });

  it('takes the field from the visible selection', () => {
    const lib = withPicker('duration', { sortKey: 'name:asc', dirs: { duration: 'asc' } });
    expect(lib._effectiveSort()[0]).toBe('duration');
  });

  it('does not apply one field stored direction to another field', () => {
    // Selection moved to duration while `_sortKey` still says name:desc —
    // duration must use its own direction, not inherit "desc".
    const lib = withPicker('duration', { sortKey: 'name:desc', dirs: null });
    expect(lib._effectiveSort()).toEqual(['duration', 'asc']);
  });

  it('falls back to the field default when nothing is remembered', () => {
    const lib = withPicker('dateAdded', { sortKey: 'name:asc', dirs: null });
    expect(lib._effectiveSort()).toEqual(['dateAdded', 'desc']);
  });

  it('works before the picker exists in the DOM', () => {
    const lib = Object.create(Library.prototype);
    lib._container = null;
    lib._sortKey = 'duration:desc';
    lib._sortDirs = null;
    expect(lib._effectiveSort()).toEqual(['duration', 'desc']);
  });

  it('survives a legacy persisted key', () => {
    const lib = withPicker('maxSpeed', { sortKey: 'maxSpeed:asc', dirs: null });
    expect(lib._effectiveSort()).toEqual(['maxSpeed', 'asc']);
  });
});
