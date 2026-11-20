// Virtual-scroll row-height measurement (Sylvain-Et-Un #315 territory).
//
// The original code measured `sampleCard.offsetHeight` one frame after render
// and cached it forever. Two things went wrong with that, both measured live
// in the running app on 2026-08-24:
//
//   1. A grid hands surplus container height to its auto-sized rows, so a
//      card whose children summed to 173px reported offsetHeight 260px. The
//      "correction" therefore re-derived the estimate it was correcting —
//      a self-confirming loop that cached 276px against a true 189px.
//   2. Card height tracks card WIDTH (16/9 thumb in a `1fr` column): 181px at
//      a 1280px window, 173px at 1920px. Resize refreshed the column count
//      and never the row height.
//
// An over-estimated row height is not cosmetic: `floor(scrollTop / rowHeight)`
// then maps the bottom of the real scroll range to a row short of the last,
// so the final cards can become unreachable.
//
// jsdom has no layout engine, so these drive `_measureRowHeight` against
// hand-built elements with offsetHeight defined — the arithmetic and the
// stretch-detection are what's under test, not the browser's box model.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const measure = Library.prototype._measureRowHeight;

/** Build a fake card whose box height and content stack can disagree. */
function makeGrid({ boxHeight, childHeights, rowGap = '16px', cardClass = 'library__card' }) {
  const card = document.createElement('div');
  card.className = cardClass;
  Object.defineProperty(card, 'offsetHeight', { value: boxHeight, configurable: true });
  for (const h of childHeights) {
    const child = document.createElement('div');
    Object.defineProperty(child, 'offsetHeight', { value: h, configurable: true });
    card.appendChild(child);
  }

  const grid = document.createElement('div');
  grid.className = 'library__grid';
  grid.appendChild(card);

  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => (
    el === grid ? { rowGap, gap: rowGap } : { rowGap: '0px', gap: '0px' }
  ));

  return grid;
}

describe('Library._measureRowHeight', () => {
  let ctx;
  beforeEach(() => {
    ctx = { _vsRowGap: null };
    vi.restoreAllMocks();
  });

  it('measures card height plus the row gap when nothing is stretched', () => {
    const grid = makeGrid({ boxHeight: 173, childHeights: [124, 16, 33] });
    expect(measure.call(ctx, grid)).toBe(189);
  });

  it('ignores a STRETCHED box and uses the content stack instead', () => {
    // The exact numbers observed in the running app: children total 173,
    // the row was stretched to 260. Taking 260 is what cached 276.
    const grid = makeGrid({ boxHeight: 260, childHeights: [124, 16, 33] });
    expect(measure.call(ctx, grid)).toBe(189);
    expect(measure.call(ctx, grid)).not.toBe(276);
  });

  it('never reports SHORTER than the box — content overflow is not stretch', () => {
    // A card box taller than its children is stretch; a box shorter than its
    // children (overflow/clipping) must not make the row height smaller,
    // because under-estimating is the direction that hides cards.
    const grid = makeGrid({ boxHeight: 173, childHeights: [200] });
    expect(measure.call(ctx, grid)).toBe(189);
  });

  it('tolerates sub-pixel disagreement without switching sources', () => {
    const grid = makeGrid({ boxHeight: 173.4, childHeights: [124, 16, 33] });
    expect(measure.call(ctx, grid)).toBeCloseTo(189.4, 1);
  });

  it('remembers the row gap for the spacer leading-gap fix', () => {
    const grid = makeGrid({ boxHeight: 173, childHeights: [173], rowGap: '24px' });
    measure.call(ctx, grid);
    expect(ctx._vsRowGap).toBe(24);
  });

  it('falls back to a 16px gap when the computed style has none', () => {
    const grid = makeGrid({ boxHeight: 100, childHeights: [100], rowGap: '' });
    expect(measure.call(ctx, grid)).toBe(116);
  });

  it('measures folder cards too', () => {
    const grid = makeGrid({ boxHeight: 150, childHeights: [150], cardClass: 'library__folder-card' });
    expect(measure.call(ctx, grid)).toBe(166);
  });

  it('returns null rather than a bogus number when there is nothing to measure', () => {
    const empty = document.createElement('div');
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ rowGap: '16px', gap: '16px' });
    expect(measure.call(ctx, empty)).toBeNull();
    expect(measure.call(ctx, null)).toBeNull();
  });

  it('returns null for a zero-height card — layout has not happened yet', () => {
    const grid = makeGrid({ boxHeight: 0, childHeights: [0] });
    expect(measure.call(ctx, grid)).toBeNull();
  });
});

// The grid must not stretch its rows in the first place; `_measureRowHeight`
// is the second line of defence, not the only one.
describe('library.css grid contract', () => {
  it('pins align-content:start on the grid', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync('renderer/styles/library.css', 'utf8');
    const block = css.slice(css.indexOf('.library__grid {'), css.indexOf('.library__virtual-spacer'));
    expect(block).toMatch(/align-content:\s*start/);
  });

  it('keeps a blank gutter after the last row so it can always scroll clear', () => {
    // Belt-and-braces for "the bottom of my library is cut off" — a residual
    // pixel or two of row-height error must not be able to hide a card.
    const fs = require('node:fs');
    const css = fs.readFileSync('renderer/styles/library.css', 'utf8');
    const block = css.slice(css.indexOf('.library__grid {'), css.indexOf('.library__virtual-spacer'));
    expect(block).toMatch(/padding-bottom:\s*var\(--library-grid-gutter/);
  });
});
