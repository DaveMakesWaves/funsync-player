// The section rails of Settings and the video options dialog are a COLUMN on
// a wide window and a ROW on a narrow one (their own CSS media queries). The
// arrow keys and aria-orientation follow what is on screen: in a row, Left /
// Right move along it, as they do in any horizontal tablist (WAI-ARIA APG);
// Up / Down still work there too. Below 620 px both rails used to stay
// "vertical" and move on Up / Down only (found fixup-ui 2026-11-18; fixed
// 2026-11-22).

/** Is the rail laid out as a row right now? */
export function railIsHorizontal(rail) {
  try {
    return String(getComputedStyle(rail).flexDirection || '').startsWith('row');
  } catch {
    return false;
  }
}

/** Set aria-orientation from the rail's layout; returns true for a row. */
export function syncRailOrientation(rail) {
  const horizontal = railIsHorizontal(rail);
  rail.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
  return horizontal;
}

/**
 * The index a key moves the focus to among `count` rail items, or -1 when
 * the key is not a rail key. Wraps at both ends; Home / End jump.
 */
export function railNextIndex(key, idx, count, horizontal) {
  if (count <= 0 || idx < 0) return -1;
  const forward = key === 'ArrowDown' || (horizontal && key === 'ArrowRight');
  const back = key === 'ArrowUp' || (horizontal && key === 'ArrowLeft');
  if (forward) return (idx + 1) % count;
  if (back) return (idx - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

/**
 * Wire a rail: its items (by selector) move with the keys above, a move
 * clicks the item (selection follows focus), and aria-orientation is kept in
 * step whenever the focus enters the rail or a key is pressed in it.
 */
export function wireRailKeys(rail, itemSelector) {
  syncRailOrientation(rail);
  rail.addEventListener('focusin', () => syncRailOrientation(rail));
  // A layout change while the focus is already in the rail (the window
  // resized, the interface size changed) resizes the rail: say so at once.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncRailOrientation(rail)).observe(rail);
  }
  rail.addEventListener('keydown', (e) => {
    const items = [...rail.querySelectorAll(itemSelector)];
    const idx = items.indexOf(document.activeElement);
    if (idx < 0) return;
    const next = railNextIndex(e.key, idx, items.length, syncRailOrientation(rail));
    if (next >= 0) {
      e.preventDefault();
      items[next].click();
    }
  });
}
