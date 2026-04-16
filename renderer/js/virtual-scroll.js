// VirtualScroll — Pure scroll math for rendering large lists efficiently
// Computes which items are visible, spacer heights, and recycle ranges.
// No DOM manipulation — returns data for the consumer to render.

/**
 * @typedef {Object} VirtualState
 * @property {number} startIndex — first visible item index
 * @property {number} endIndex — last visible item index (exclusive)
 * @property {number} visibleCount — number of items to render
 * @property {number} topSpacer — height of spacer above visible items (px)
 * @property {number} bottomSpacer — height of spacer below visible items (px)
 * @property {number} totalHeight — total scrollable height (px)
 */

/**
 * Compute which items are visible for a given scroll state.
 *
 * @param {object} opts
 * @param {number} opts.totalItems — total number of items in the list
 * @param {number} opts.itemHeight — height of each item in px
 * @param {number} opts.viewportHeight — visible viewport height in px
 * @param {number} opts.scrollTop — current scroll position in px
 * @param {number} [opts.overscan=3] — extra items to render above/below viewport
 * @returns {VirtualState}
 */
export function computeVisibleRange({ totalItems, itemHeight, viewportHeight, scrollTop, overscan = 3 }) {
  if (totalItems <= 0 || itemHeight <= 0 || viewportHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      visibleCount: 0,
      topSpacer: 0,
      bottomSpacer: 0,
      totalHeight: 0,
    };
  }

  const totalHeight = totalItems * itemHeight;
  const rawStart = Math.floor(scrollTop / itemHeight);
  const rawVisible = Math.ceil(viewportHeight / itemHeight);

  // Apply overscan (extra items rendered off-screen for smoother scrolling)
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(totalItems, rawStart + rawVisible + overscan);
  const visibleCount = endIndex - startIndex;

  const topSpacer = startIndex * itemHeight;
  const bottomSpacer = Math.max(0, (totalItems - endIndex) * itemHeight);

  return {
    startIndex,
    endIndex,
    visibleCount,
    topSpacer,
    bottomSpacer,
    totalHeight,
  };
}

/**
 * Compute visible range for a grid layout (multiple columns).
 *
 * @param {object} opts
 * @param {number} opts.totalItems — total number of items
 * @param {number} opts.columns — number of columns in the grid
 * @param {number} opts.rowHeight — height of each row in px
 * @param {number} opts.viewportHeight — visible viewport height in px
 * @param {number} opts.scrollTop — current scroll position in px
 * @param {number} [opts.overscan=2] — extra rows to render above/below
 * @returns {VirtualState & {startRow: number, endRow: number, totalRows: number}}
 */
export function computeGridRange({ totalItems, columns, rowHeight, viewportHeight, scrollTop, overscan = 2 }) {
  if (totalItems <= 0 || columns <= 0 || rowHeight <= 0 || viewportHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      visibleCount: 0,
      topSpacer: 0,
      bottomSpacer: 0,
      totalHeight: 0,
      startRow: 0,
      endRow: 0,
      totalRows: 0,
    };
  }

  const totalRows = Math.ceil(totalItems / columns);
  const totalHeight = totalRows * rowHeight;
  const rawStartRow = Math.floor(scrollTop / rowHeight);
  const rawVisibleRows = Math.ceil(viewportHeight / rowHeight);

  const startRow = Math.max(0, rawStartRow - overscan);
  const endRow = Math.min(totalRows, rawStartRow + rawVisibleRows + overscan);

  const startIndex = startRow * columns;
  const endIndex = Math.min(totalItems, endRow * columns);
  const visibleCount = endIndex - startIndex;

  const topSpacer = startRow * rowHeight;
  const bottomSpacer = Math.max(0, (totalRows - endRow) * rowHeight);

  return {
    startIndex,
    endIndex,
    visibleCount,
    topSpacer,
    bottomSpacer,
    totalHeight,
    startRow,
    endRow,
    totalRows,
  };
}

/**
 * Determine if the visible range has changed enough to warrant a re-render.
 * Avoids unnecessary DOM updates for tiny scroll changes.
 *
 * @param {VirtualState} prev — previous state
 * @param {VirtualState} next — new state
 * @returns {boolean} true if range changed
 */
export function hasRangeChanged(prev, next) {
  if (!prev || !next) return true;
  return prev.startIndex !== next.startIndex || prev.endIndex !== next.endIndex;
}
