/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library renders its virtual grid into a DOM
 * (library.js imports DOM-branching modules; notes/CLAUDE.md "Test
 * environments").
 */
// App test 2026-11-02, V30: switch the library from list to grid while
// scrolled deep and the grid's row height was never measured; it stayed on
// the 180px guess until a window resize.
//
// The list's scrollTop (14871px of 50px rows) was carried into grid mode as
// the scroll restore. computeGridRange put the first row at
// floor(14871/180) - 3 = 79, past the grid's 45 rows, so the range was empty
// and NO card rendered. The one-shot two-frame measurement then found no
// card and gave up, and nothing re-armed it: the scroll handler never
// measures.
//
// The fix has two halves and each is pinned here: the range clamps to the
// layout it is computing for, and a measurement that found nothing is
// re-armed by the next render that has cards.
//
// jsdom does no layout, so the wrapper's scroll metrics are set by hand and
// `_measureRowHeight` keeps its real contract (a number when a card is in
// the grid, null when none is) with a fixed card height.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeGridRange } from '../../renderer/js/virtual-scroll.js';
import { Library } from '../../renderer/components/library.js';

describe('computeGridRange: a scrollTop from another layout', () => {
  it('past the end of this layout, it still yields the last rows, not an empty range', () => {
    // 300 items, 7 columns = 43 rows of 180px = 7740px; the list left us at 14871.
    const state = computeGridRange({
      totalItems: 300, columns: 7, rowHeight: 180, viewportHeight: 900, scrollTop: 14871, overscan: 3,
    });
    expect(state.endIndex).toBe(300);
    expect(state.startIndex).toBeLessThan(state.endIndex);
    expect(state.visibleCount).toBeGreaterThan(0);
    expect(state.startRow).toBeLessThan(state.totalRows);
    // Spacers + rendered rows still add up to the layout's height.
    expect(state.topSpacer + (state.endRow - state.startRow) * 180 + state.bottomSpacer).toBe(state.totalHeight);
  });

  it('a negative scrollTop reads as the top', () => {
    const state = computeGridRange({
      totalItems: 100, columns: 5, rowHeight: 150, viewportHeight: 600, scrollTop: -40, overscan: 0,
    });
    expect(state.startIndex).toBe(0);
  });

  it('inside the layout nothing changes', () => {
    const state = computeGridRange({
      totalItems: 100, columns: 5, rowHeight: 150, viewportHeight: 600, scrollTop: 600, overscan: 2,
    });
    expect(state.startRow).toBe(2);
    expect(state.endRow).toBe(10);
  });
});

describe('Library: the grid row height gets measured', () => {
  const CARD_ROW = 251; // what a real card + gap measures
  let rafQueue;
  let lib;
  let wrapper;
  let grid;
  let hidden;
  const items = Array.from({ length: 300 }, (_, i) => ({ name: `v${i}.mp4`, path: `D:\\Lib\\v${i}.mp4` }));

  /** Run every queued animation frame, including ones queued while running. */
  function flushFrames() {
    for (let guard = 0; rafQueue.length && guard < 20; guard++) {
      const batch = rafQueue.splice(0);
      for (const cb of batch) cb(0);
    }
  }

  function cardsRendered() {
    return grid.querySelectorAll('.library__card').length;
  }

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
    hidden = false;

    const settings = { get: (k) => (k === 'library.viewMode' ? 'list' : undefined), set: vi.fn() };
    lib = new Library({ settings });
    const container = document.createElement('div');
    container.innerHTML = '<div class="library__grid-wrapper"><div class="library__grid"></div></div>';
    document.body.appendChild(container);
    lib._container = container;
    wrapper = container.querySelector('.library__grid-wrapper');
    grid = container.querySelector('.library__grid');
    // No layout in jsdom: the wrapper's scroll metrics, by hand.
    let scrollTop = 0;
    Object.defineProperty(wrapper, 'scrollTop', { get: () => scrollTop, set: (v) => { scrollTop = v; }, configurable: true });
    Object.defineProperty(wrapper, 'clientHeight', { value: 900, configurable: true });
    Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true }); // 7 columns
    Object.defineProperty(wrapper, 'scrollHeight', { get: () => 900 + grid.children.length * 10, configurable: true });

    // Not under test: card contents, thumbnails, the filter pipeline.
    lib._createItemEl = (item) => {
      const el = document.createElement('div');
      el.className = 'library__card';
      el.dataset.videoPath = item.path;
      return el;
    };
    lib._lazyLoadVisibleThumbnails = () => {};
    lib._drainPendingThumbnailsOnScrollEnd = () => {};
    lib._applyFilters = () => lib._renderGrid(items);
    // The real contract: a row height when a card is laid out, null when not.
    lib._measureRowHeight = (g) => (!hidden && g.querySelector('.library__card') ? CARD_ROW : null);
  });

  afterEach(() => {
    lib._container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('list -> grid while scrolled deep: cards render and the row height is measured', () => {
    lib._viewMode = 'list';
    lib._renderGrid(items);
    flushFrames();
    wrapper.scrollTop = 14871; // deep in the 50px-row list
    expect(lib._vsMeasuredRowHeight).toBeFalsy(); // list rows are never measured

    lib._setViewMode('grid');

    expect(cardsRendered()).toBeGreaterThan(0);
    flushFrames();
    expect(lib._vsMeasuredRowHeight).toBe(CARD_ROW);
    expect(lib._vsRowHeight).toBe(CARD_ROW);
    expect(cardsRendered()).toBeGreaterThan(0);
  });

  it('a first measurement that finds nothing is re-armed by the next render with cards', () => {
    lib._viewMode = 'grid';
    hidden = true; // first sample: nothing measurable
    lib._renderGrid(items);
    flushFrames();
    expect(lib._vsMeasuredRowHeight).toBeFalsy();
    expect(lib._vsRowHeight).toBe(180); // still the guess

    hidden = false;
    wrapper.scrollTop = 3000; // the user scrolls: a new range renders
    lib._scrollHandler();
    flushFrames();

    expect(lib._vsMeasuredRowHeight).toBe(CARD_ROW);
    expect(lib._vsRowHeight).toBe(CARD_ROW);
  });

  it('once measured, scrolling does not measure again (one measurement per layout)', () => {
    lib._viewMode = 'grid';
    lib._renderGrid(items);
    flushFrames();
    expect(lib._vsMeasuredRowHeight).toBe(CARD_ROW);
    const spy = vi.spyOn(lib, '_measureRowHeight');

    wrapper.scrollTop = 4000;
    lib._scrollHandler();
    flushFrames();

    expect(spy).not.toHaveBeenCalled();
  });
});
