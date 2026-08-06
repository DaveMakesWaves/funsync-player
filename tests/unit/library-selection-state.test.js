// Multi-select: the border and the tick must never disagree.
//
// Bug, 2026-08-06 (Dave): selecting items in the library showed the border and
// the tick, then the tick vanished as soon as you clicked something else.
//
// Cause: `_createCard` / `_createListItem` restored `library__card--selected`
// from `_selectedPaths` on rebuild, but never re-applied
// `library__card-checkbox--checked`. The two halves of "this is selected"
// lived in different places, so a rebuild restored one and dropped the other —
// and with virtual scrolling, cards rebuild on nearly every interaction.
// `_selectFolderDescendants` had the same half-update.
//
// These tests drive `_applySelectionState` directly rather than the full
// component: the invariant under test is "both classes come from one source",
// and that is exactly what the helper owns.
import { describe, it, expect, beforeEach } from 'vitest';

// Minimal stand-in for the parts of Library the helper touches. Using the real
// method off the prototype keeps the test honest — it fails if the real
// implementation stops setting either class.
import { Library } from '../../renderer/components/library.js';

function makeCard(videoPath, { withCheckbox = true } = {}) {
  const card = document.createElement('div');
  card.className = 'library__card';
  card.dataset.videoPath = videoPath;
  if (withCheckbox) {
    const cb = document.createElement('div');
    cb.className = 'library__card-checkbox';
    card.appendChild(cb);
  }
  return card;
}

function makeHost({ selected = [], selectMode = true } = {}) {
  return {
    _selectedPaths: new Set(selected),
    _selectMode: selectMode,
    _applySelectionState: Library.prototype._applySelectionState,
    _updateSelectionCount() {},
    _toggleCardSelection: Library.prototype._toggleCardSelection,
  };
}

const SELECTED = 'C:\\v\\picked.mp4';
const OTHER = 'C:\\v\\other.mp4';

describe('_applySelectionState', () => {
  let host;
  beforeEach(() => { host = makeHost({ selected: [SELECTED] }); });

  it('applies BOTH the border and the tick for a selected card', () => {
    const card = makeCard(SELECTED);
    host._applySelectionState(card, SELECTED);

    expect(card.classList.contains('library__card--selected')).toBe(true);
    expect(card.querySelector('.library__card-checkbox')
      .classList.contains('library__card-checkbox--checked')).toBe(true);
  });

  // The regression itself: a rebuilt card must come back fully selected.
  it('restores the tick on a freshly rebuilt card, not just the border', () => {
    const rebuilt = makeCard(SELECTED); // no classes yet, as after a re-render
    host._applySelectionState(rebuilt, SELECTED);

    const cb = rebuilt.querySelector('.library__card-checkbox');
    expect(rebuilt.classList.contains('library__card--selected')).toBe(true);
    expect(cb.classList.contains('library__card-checkbox--checked')).toBe(true);
  });

  it('clears both for an unselected card', () => {
    const card = makeCard(OTHER);
    card.classList.add('library__card--selected');
    card.querySelector('.library__card-checkbox')
      .classList.add('library__card-checkbox--checked');

    host._applySelectionState(card, OTHER);

    expect(card.classList.contains('library__card--selected')).toBe(false);
    expect(card.querySelector('.library__card-checkbox')
      .classList.contains('library__card-checkbox--checked')).toBe(false);
  });

  it('shows the checkbox in select mode and hides it outside', () => {
    const inMode = makeCard(SELECTED);
    host._applySelectionState(inMode, SELECTED);
    expect(inMode.querySelector('.library__card-checkbox').hidden).toBe(false);

    const off = makeHost({ selected: [SELECTED], selectMode: false });
    const outOfMode = makeCard(SELECTED);
    off._applySelectionState(outOfMode, SELECTED);
    expect(outOfMode.querySelector('.library__card-checkbox').hidden).toBe(true);
  });

  it('survives a card with no checkbox (folder rows)', () => {
    const card = makeCard(SELECTED, { withCheckbox: false });
    expect(() => host._applySelectionState(card, SELECTED)).not.toThrow();
    expect(card.classList.contains('library__card--selected')).toBe(true);
  });

  it('is a no-op on a null element', () => {
    expect(() => host._applySelectionState(null, SELECTED)).not.toThrow();
  });
});

describe('_toggleCardSelection keeps both states in step', () => {
  it('selects: set, border and tick all agree', () => {
    const host = makeHost({ selected: [] });
    const card = makeCard(OTHER);

    host._toggleCardSelection(card, OTHER);

    expect(host._selectedPaths.has(OTHER)).toBe(true);
    expect(card.classList.contains('library__card--selected')).toBe(true);
    expect(card.querySelector('.library__card-checkbox')
      .classList.contains('library__card-checkbox--checked')).toBe(true);
  });

  it('deselects: set, border and tick all agree', () => {
    const host = makeHost({ selected: [SELECTED] });
    const card = makeCard(SELECTED);
    host._applySelectionState(card, SELECTED);

    host._toggleCardSelection(card, SELECTED);

    expect(host._selectedPaths.has(SELECTED)).toBe(false);
    expect(card.classList.contains('library__card--selected')).toBe(false);
    expect(card.querySelector('.library__card-checkbox')
      .classList.contains('library__card-checkbox--checked')).toBe(false);
  });

  it('round-trips back to selected', () => {
    const host = makeHost({ selected: [] });
    const card = makeCard(OTHER);

    host._toggleCardSelection(card, OTHER);
    host._toggleCardSelection(card, OTHER);
    host._toggleCardSelection(card, OTHER);

    expect(host._selectedPaths.has(OTHER)).toBe(true);
    expect(card.querySelector('.library__card-checkbox')
      .classList.contains('library__card-checkbox--checked')).toBe(true);
  });
});
