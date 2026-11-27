/**
 * Arrow keys for a popup menu opened from a button (the WAI-ARIA menu
 * button pattern): the player's ⋮ menu, in the main window and the pop-out.
 *
 * Break-it, 2026-11-25: the ⋮ menu says role="menu", but opened with Enter
 * the focus stayed on the button, and Down / Up went to the player under it
 * (the volume changed with the menu open); nothing moved through the items.
 * Now opening it from the keyboard focuses the first item, and while it is
 * open Down / Up (wrapping), Home and End move through the items that show.
 * The press is marked taken (preventDefault), so keyboard.js's
 * targetOwnsKey leaves it alone. Left / Right still seek, Space still plays.
 */

const MOVE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/**
 * The menu's items that show and can be used, in order. Hidden means hidden
 * INSIDE the menu (an item, or a group around it); whether the menu itself
 * shows is asked apart (`menu.hidden`), so a page that hides the menu's
 * surroundings some other way does not empty it.
 */
export function menuItems(menu) {
  const shows = (el) => {
    for (let n = el; n && n !== menu; n = n.parentElement) if (n.hidden) return false;
    return true;
  };
  return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')]
    .filter((el) => !el.disabled && shows(el));
}

/**
 * Move the focus for one key press while the menu is open.
 * @returns {boolean} true when the press was the menu's (the caller marks it taken)
 */
export function moveMenuFocus(menu, key, active = menu.ownerDocument.activeElement) {
  if (!menu || !menu.isConnected || menu.hidden || !MOVE_KEYS.has(key)) return false;
  const items = menuItems(menu);
  if (!items.length) return false;
  const at = items.indexOf(active);
  let next;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = items.length - 1;
  else if (at < 0) next = key === 'ArrowDown' ? 0 : items.length - 1;
  else next = (at + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
  return true;
}

/**
 * A menu opened from the keyboard: focus the item `prefer` names (the
 * current speed) when it shows, else the first item.
 */
export function focusMenuFromKeyboard(menu, prefer = null) {
  const items = menuItems(menu);
  const want = prefer ? menu.querySelector(prefer) : null;
  (items.includes(want) ? want : items[0])?.focus();
}

/**
 * Wire a menu button. Add it AFTER the button's own click handler (it reads
 * `menu.hidden` after the toggle) and before the window's player keys.
 * A click with `detail === 0` came from the keyboard (Enter / Space).
 *
 * Escape while it is open gives the focus back to the button (it was on an
 * item that is about to hide: it fell to the page). With `close`, Escape
 * also closes it and marks the press taken (the pop-out, which never closed
 * it on Escape); without, the window's own Escape closes it (main).
 * @param {{ doc?: Document, close?: () => void }} [opts]
 * @returns {() => void} removes the listeners
 */
export function wireMenuKeys(button, menu, { doc = button.ownerDocument, close = null } = {}) {
  const onClick = (e) => {
    if (e.detail === 0 && !menu.hidden) focusMenuFromKeyboard(menu);
  };
  const onKey = (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Right on an item that opens a menu of its own (⋮ ▸ Playback speed)
    // opens it, as Enter does: a click with detail 0, so its first item
    // takes the focus (the menu pattern; test day 2026-11-26, B098).
    if (e.key === 'ArrowRight') {
      const item = doc.activeElement;
      if (!menu.hidden && item && menu.contains(item) && item.getAttribute('aria-haspopup')) {
        e.preventDefault();
        item.click();
      }
      return;
    }
    if (moveMenuFocus(menu, e.key)) e.preventDefault();
  };
  // Capture: before the window's own Escape hides the menu under the focus.
  const onEscape = (e) => {
    if (e.key !== 'Escape' || menu.hidden || !menu.isConnected) return;
    if (menu.contains(doc.activeElement)) button.focus();
    if (close) { e.preventDefault(); close(); }
  };
  button.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('keydown', onEscape, true);
  // An item chosen with Enter closes the menu under the focus (Loop video,
  // Picture-in-Picture…): back to the button, not the page. The observer runs
  // after the item's handler, so an item that opens another menu (Playback
  // speed) has already moved the focus there and keeps it.
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => {
    if (menu.hidden && menu.contains(doc.activeElement)) button.focus();
  }) : null;
  observer?.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  // Removes the listeners (tests; the windows keep theirs for their life).
  return () => {
    button.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('keydown', onEscape, true);
    observer?.disconnect();
  };
}
