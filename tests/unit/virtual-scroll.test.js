import { describe, it, expect } from 'vitest';
import { computeVisibleRange, computeGridRange, hasRangeChanged } from '../../renderer/js/virtual-scroll.js';

describe('virtual-scroll', () => {
  describe('computeVisibleRange', () => {
    it('computes correct range at top of list', () => {
      const state = computeVisibleRange({
        totalItems: 100,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 0,
        overscan: 0,
      });
      expect(state.startIndex).toBe(0);
      expect(state.endIndex).toBe(6); // ceil(300/50) = 6
      expect(state.visibleCount).toBe(6);
      expect(state.topSpacer).toBe(0);
      expect(state.totalHeight).toBe(5000);
    });

    it('computes correct range scrolled partway', () => {
      const state = computeVisibleRange({
        totalItems: 100,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 250, // scrolled past 5 items
        overscan: 0,
      });
      expect(state.startIndex).toBe(5);
      expect(state.endIndex).toBe(11);
      expect(state.topSpacer).toBe(250);
    });

    it('computes correct range at bottom of list', () => {
      const state = computeVisibleRange({
        totalItems: 100,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 4700, // near bottom
        overscan: 0,
      });
      expect(state.endIndex).toBe(100);
      expect(state.bottomSpacer).toBe(0);
    });

    it('includes overscan items', () => {
      const state = computeVisibleRange({
        totalItems: 100,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 500, // item 10
        overscan: 3,
      });
      expect(state.startIndex).toBe(7); // 10 - 3
      expect(state.endIndex).toBe(19); // 10 + 6 + 3
    });

    it('clamps start to 0 with overscan', () => {
      const state = computeVisibleRange({
        totalItems: 100,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 50, // item 1
        overscan: 5,
      });
      expect(state.startIndex).toBe(0);
    });

    it('clamps end to totalItems with overscan', () => {
      const state = computeVisibleRange({
        totalItems: 10,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 200,
        overscan: 5,
      });
      expect(state.endIndex).toBe(10);
    });

    it('returns zeros for empty list', () => {
      const state = computeVisibleRange({
        totalItems: 0,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 0,
      });
      expect(state.startIndex).toBe(0);
      expect(state.endIndex).toBe(0);
      expect(state.visibleCount).toBe(0);
      expect(state.totalHeight).toBe(0);
    });

    it('handles single item', () => {
      const state = computeVisibleRange({
        totalItems: 1,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 0,
        overscan: 0,
      });
      expect(state.startIndex).toBe(0);
      expect(state.endIndex).toBe(1);
      expect(state.visibleCount).toBe(1);
      expect(state.totalHeight).toBe(50);
    });

    it('renders all items when list fits in viewport', () => {
      const state = computeVisibleRange({
        totalItems: 5,
        itemHeight: 50,
        viewportHeight: 500,
        scrollTop: 0,
        overscan: 0,
      });
      expect(state.startIndex).toBe(0);
      expect(state.endIndex).toBe(5);
      expect(state.visibleCount).toBe(5);
      expect(state.topSpacer).toBe(0);
      expect(state.bottomSpacer).toBe(0);
    });

    it('spacers sum to correct total', () => {
      const state = computeVisibleRange({
        totalItems: 100,
        itemHeight: 50,
        viewportHeight: 300,
        scrollTop: 1000,
        overscan: 2,
      });
      const renderedHeight = state.visibleCount * 50;
      expect(state.topSpacer + renderedHeight + state.bottomSpacer).toBe(state.totalHeight);
    });

    it('returns zeros for zero itemHeight', () => {
      const state = computeVisibleRange({
        totalItems: 100,
        itemHeight: 0,
        viewportHeight: 300,
        scrollTop: 0,
      });
      expect(state.visibleCount).toBe(0);
    });
  });

  describe('computeGridRange', () => {
    it('computes correct range for grid', () => {
      const state = computeGridRange({
        totalItems: 50,
        columns: 4,
        rowHeight: 200,
        viewportHeight: 600,
        scrollTop: 0,
        overscan: 0,
      });
      // 50 items / 4 cols = 13 rows
      expect(state.totalRows).toBe(13);
      // Visible rows: ceil(600/200) = 3
      expect(state.startRow).toBe(0);
      expect(state.endRow).toBe(3);
      expect(state.startIndex).toBe(0);
      expect(state.endIndex).toBe(12); // 3 rows * 4 cols
    });

    it('handles partial last row', () => {
      const state = computeGridRange({
        totalItems: 10,
        columns: 4,
        rowHeight: 200,
        viewportHeight: 800,
        scrollTop: 0,
        overscan: 0,
      });
      // 10 items / 4 cols = 3 rows (last row has 2 items)
      expect(state.totalRows).toBe(3);
      expect(state.endIndex).toBe(10); // clamped to totalItems
    });

    it('includes overscan rows', () => {
      const state = computeGridRange({
        totalItems: 100,
        columns: 5,
        rowHeight: 150,
        viewportHeight: 600,
        scrollTop: 600, // row 4
        overscan: 2,
      });
      expect(state.startRow).toBe(2); // 4 - 2
      expect(state.endRow).toBe(10); // 4 + 4 + 2
    });

    it('returns zeros for empty grid', () => {
      const state = computeGridRange({
        totalItems: 0,
        columns: 4,
        rowHeight: 200,
        viewportHeight: 600,
        scrollTop: 0,
      });
      expect(state.visibleCount).toBe(0);
      expect(state.totalRows).toBe(0);
    });

    it('spacers sum to correct total', () => {
      const state = computeGridRange({
        totalItems: 80,
        columns: 4,
        rowHeight: 200,
        viewportHeight: 600,
        scrollTop: 800,
        overscan: 1,
      });
      const renderedRows = state.endRow - state.startRow;
      const renderedHeight = renderedRows * 200;
      expect(state.topSpacer + renderedHeight + state.bottomSpacer).toBe(state.totalHeight);
    });
  });

  describe('hasRangeChanged', () => {
    it('returns true for null prev', () => {
      expect(hasRangeChanged(null, { startIndex: 0, endIndex: 5 })).toBe(true);
    });

    it('returns true for null next', () => {
      expect(hasRangeChanged({ startIndex: 0, endIndex: 5 }, null)).toBe(true);
    });

    it('returns false for identical ranges', () => {
      const a = { startIndex: 5, endIndex: 15 };
      const b = { startIndex: 5, endIndex: 15 };
      expect(hasRangeChanged(a, b)).toBe(false);
    });

    it('returns true when startIndex changes', () => {
      const a = { startIndex: 5, endIndex: 15 };
      const b = { startIndex: 6, endIndex: 15 };
      expect(hasRangeChanged(a, b)).toBe(true);
    });

    it('returns true when endIndex changes', () => {
      const a = { startIndex: 5, endIndex: 15 };
      const b = { startIndex: 5, endIndex: 16 };
      expect(hasRangeChanged(a, b)).toBe(true);
    });
  });
});
