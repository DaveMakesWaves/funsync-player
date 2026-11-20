// The editor timeline's right-click menu (Fill with pattern, pattern library
// Round 2). The editor had no context menu before; this one is deliberately
// small: a short list at the pointer, driven by the keyboard as well as the
// mouse (Up / Down / Home / End move, Enter or Space choose, Esc or Tab close
// and hand the focus back), and it changes no selection and starts no drag.
// One module for both editors, docked (script-editor.js) and pop-out
// (editor-popout.js). It lives outside the editor, so the canvas's own keys
// never see a key pressed in it: in document.body, or in the fullscreen
// element while one is up (as modal.js does). A fixed element in the body is
// not drawn over a fullscreen player, so the menu was invisible there yet
// held the focus (review-2 minor 4). Closed any way but by a choice, it hands
// the focus back to the canvas when it had it.

let _active = null;

/**
 * Open a menu at (x, y) in viewport pixels, closing any menu already open.
 *
 * A disabled item stays in the list and can take the focus, so the user can
 * read why it is off: its `hint` is shown under it and named as its
 * description (aria-describedby). It does nothing when chosen.
 *
 * @param {object} o
 * @param {number} o.x
 * @param {number} o.y
 * @param {Array<{label: string, disabled?: boolean, hint?: string, onSelect?: Function}>} o.items
 * @param {string} o.ariaLabel — the menu's accessible name
 * @param {HTMLElement|null} [o.returnFocus] — focused again when the menu
 *   closes without a choice (Esc, Tab, a click elsewhere in the window)
 * @param {Document} [o.doc]
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openContextMenu({ x, y, items, ariaLabel, returnFocus = null, doc = document }) {
  closeContextMenu();
  const win = doc.defaultView || window;
  const menu = doc.createElement('div');
  menu.className = 'editor-context-menu';
  menu.setAttribute('role', 'menu');
  if (ariaLabel) menu.setAttribute('aria-label', ariaLabel);
  menu.style.position = 'fixed';

  const buttons = [];
  items.forEach((item, i) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'editor-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.tabIndex = -1;
    btn.textContent = item.label;
    if (item.disabled) btn.setAttribute('aria-disabled', 'true');
    menu.appendChild(btn);
    buttons.push(btn);
    if (item.hint) {
      const hint = doc.createElement('div');
      hint.className = 'editor-context-menu__hint';
      hint.id = `editor-context-menu-hint-${i}`;
      hint.textContent = item.hint;
      btn.setAttribute('aria-describedby', hint.id);
      menu.appendChild(hint);
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (item.disabled) return;
      close({ refocus: false });
      item.onSelect?.();
    });
  });

  const move = (delta, to) => {
    if (!buttons.length) return;
    const at = buttons.indexOf(doc.activeElement);
    let next;
    if (to === 'first') next = 0;
    else if (to === 'last') next = buttons.length - 1;
    else next = at < 0 ? 0 : (at + delta + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  menu.addEventListener('keydown', (e) => {
    // Every key stops here: the canvas and the player never see a key
    // pressed in the menu.
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); move(0, 'first'); break;
      case 'End': e.preventDefault(); move(0, 'last'); break;
      case 'Escape': e.preventDefault(); close({ refocus: true }); break;
      case 'Tab': e.preventDefault(); close({ refocus: true }); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (doc.activeElement && buttons.includes(doc.activeElement)) doc.activeElement.click();
        break;
      default: break;
    }
  });
  // The browser's own menu never opens over this one.
  menu.addEventListener('contextmenu', (e) => e.preventDefault());

  // A click elsewhere, the window losing focus, a resize or a fullscreen
  // change: the focus goes back to the canvas if it was in the menu (the
  // click's own target still takes it after this, as usual).
  const onOutside = (e) => {
    if (!menu.contains(e.target)) close({ refocus: 'if-inside' });
  };
  const onAway = () => close({ refocus: 'if-inside' });

  let closed = false;
  function close({ refocus = false } = {}) {
    if (closed) return;
    closed = true;
    const hadFocus = menu.contains(doc.activeElement);
    doc.removeEventListener('mousedown', onOutside, true);
    doc.removeEventListener('fullscreenchange', onAway);
    win.removeEventListener('blur', onAway);
    win.removeEventListener('resize', onAway);
    menu.remove();
    if (_active?.el === menu) _active = null;
    const back = refocus === true || (refocus === 'if-inside' && hadFocus);
    if (back && returnFocus && typeof returnFocus.focus === 'function' && returnFocus.isConnected !== false) {
      try { returnFocus.focus({ preventScroll: true }); } catch { /* gone */ }
    }
  }

  (doc.fullscreenElement || doc.body).appendChild(menu);
  // Kept inside the window: flipped left / up when it would run off an edge.
  const vw = win.innerWidth || 0;
  const vh = win.innerHeight || 0;
  const rect = menu.getBoundingClientRect();
  let left = Math.round(x);
  let top = Math.round(y);
  if (vw && rect.width && left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
  if (vh && rect.height && top + rect.height > vh - 4) top = Math.max(4, vh - rect.height - 4);
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;

  doc.addEventListener('mousedown', onOutside, true);
  doc.addEventListener('fullscreenchange', onAway);
  win.addEventListener('blur', onAway);
  win.addEventListener('resize', onAway);

  _active = { el: menu, close };
  (buttons.find((b) => !b.hasAttribute('aria-disabled')) || buttons[0])?.focus();
  return _active;
}

/** Close the open menu, if any (focus stays where it is). */
export function closeContextMenu() {
  _active?.close({ refocus: false });
  _active = null;
}

/** The open menu's element, or null. */
export function activeContextMenu() {
  return _active?.el || null;
}
