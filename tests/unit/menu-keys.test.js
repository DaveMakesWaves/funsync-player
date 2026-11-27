/**
 * @vitest-environment jsdom
 * jsdom on purpose: focus and key events on real elements (notes/CLAUDE.md
 * "Test environments").
 */
// Break-it, 2026-11-25: the player's ⋮ menu (role="menu") opened with Enter
// left the focus on its button, and Down / Up changed the VOLUME under the
// open menu; nothing moved through the items. The real markup and the real
// keyboard rule (targetOwnsKey) below.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { wireMenuKeys, moveMenuFocus, menuItems, focusMenuFromKeyboard } from '../../renderer/js/menu-keys.js';
import { targetOwnsKey } from '../../renderer/js/keyboard.js';

const HTML = fs.readFileSync('renderer/index.html', 'utf8');

/** The real ⋮ button and menu from index.html. */
function mountRealMenu() {
  const from = HTML.lastIndexOf('<div', HTML.indexOf('id="controls-overflow"'));
  expect(from).toBeGreaterThan(0);
  // The wrapper's markup up to the menu's end (the first </div> after the last item).
  const lastItem = HTML.indexOf('id="btn-help"', from);
  const end = HTML.indexOf('</div>', lastItem) + '</div>'.length;
  document.body.innerHTML = HTML.slice(from, end) + '</div>';
  return { button: document.getElementById('btn-overflow'), menu: document.getElementById('controls-overflow-menu') };
}

function key(k, target = document.activeElement || document.body) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

let button; let menu; let unwire;
beforeEach(() => {
  ({ button, menu } = mountRealMenu());
  // The app's own toggle (app.js / player-popout.js), then the keys.
  button.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  unwire = wireMenuKeys(button, menu);
});
afterEach(() => unwire());

describe('the player ⋮ menu from the keyboard', () => {
  it('Enter / Space on the button (a click with detail 0) focuses the first item that shows', () => {
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe(menuItems(menu)[0]);
    expect(document.activeElement.id).toBe('btn-speed-menu');
  });

  it('a mouse click (detail 1) leaves the focus where it is', () => {
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('Down / Up move through the items that show (hidden ones skipped), wrapping; Home / End; the player never sees them', () => {
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    const items = menuItems(menu);
    expect(items.length).toBeGreaterThan(3);
    expect(items.some((el) => el.id === 'btn-vr-format-menu')).toBe(false);   // hidden in the markup
    const down = key('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    expect(down.defaultPrevented).toBe(true);
    expect(targetOwnsKey(down)).toBe(true);                                      // keyboard.js leaves it alone (no volume)
    key('End');
    expect(document.activeElement).toBe(items.at(-1));
    key('ArrowDown');
    expect(document.activeElement).toBe(items[0]);                               // wraps
    key('ArrowUp');
    expect(document.activeElement).toBe(items.at(-1));
    key('Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('opened with the mouse, Down goes into the menu (not the volume); Up to its last item', () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    document.body.focus();
    expect(key('ArrowDown', document.body).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(menuItems(menu)[0]);
    document.activeElement.blur();
    key('ArrowUp', document.body);
    expect(document.activeElement).toBe(menuItems(menu).at(-1));
  });

  it('closed, or other keys (Left / Right seek, Space plays, Shift+Down): the player keeps them', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(key(k, document.body).defaultPrevented).toBe(false);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    for (const k of ['ArrowLeft', 'ArrowRight', ' ']) expect(key(k, document.body).defaultPrevented).toBe(false);
    const shifted = new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(shifted);
    expect(shifted.defaultPrevented).toBe(false);
  });

  it('Escape gives the focus back to ⋮ (it fell to the page); the window\'s own Escape closes it', () => {
    // main's handler, registered before (app.js): closes, marks the press taken.
    const mainEsc = (e) => { if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); menu.hidden = true; } };
    document.addEventListener('keydown', mainEsc);
    try {
      button.focus();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      key('ArrowDown');
      expect(menu.contains(document.activeElement)).toBe(true);
      key('Escape');
      expect(menu.hidden).toBe(true);
      expect(document.activeElement).toBe(button);
    } finally {
      document.removeEventListener('keydown', mainEsc);
    }
  });

  it('with close (the pop-out, where Escape never closed it): Escape closes it, focus on ⋮, the press taken', () => {
    unwire();
    let closed = 0;
    unwire = wireMenuKeys(button, menu, { close: () => { closed += 1; menu.hidden = true; } });
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    const esc = key('Escape');
    expect(closed).toBe(1);
    expect(menu.hidden).toBe(true);
    expect(esc.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(key('Escape', button).defaultPrevented).toBe(false);                 // closed: the window's own Escape
  });

  it('a menu with nothing showing takes nothing', () => {
    const empty = document.createElement('div');
    empty.setAttribute('role', 'menu');
    expect(moveMenuFocus(empty, 'ArrowDown')).toBe(false);
  });
});

describe('the speed menu (⋮ ▸ Playback speed, or the speed chip)', () => {
  // The same pass: Enter on "Playback speed" hid the ⋮ menu under the focus,
  // the focus fell to the page and the arrows changed the volume again.
  it('opened from the keyboard, the focus goes to the current speed (the first one when none is marked)', () => {
    const pop = document.createElement('div');
    pop.setAttribute('role', 'menu');
    for (const r of ['0.5', '1', '1.5']) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.textContent = r;
      if (r === '1') b.className = 'speed-popover__item--current';
      pop.appendChild(b);
    }
    document.body.appendChild(pop);
    focusMenuFromKeyboard(pop, '.speed-popover__item--current');
    expect(document.activeElement.textContent).toBe('1');
    key('ArrowDown');                                   // the ⋮ menu is closed: only this one moves
    expect(document.activeElement.textContent).toBe('1');   // (no listener for it in this test)
    expect(moveMenuFocus(pop, 'ArrowDown')).toBe(true);
    expect(document.activeElement.textContent).toBe('1.5');
    pop.querySelector('.speed-popover__item--current').className = '';
    focusMenuFromKeyboard(pop, '.speed-popover__item--current');
    expect(document.activeElement.textContent).toBe('0.5');
  });

  it('both windows: keyboard-opened (detail 0) focuses the current speed, the arrows move, Escape gives the focus back', () => {
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    const wire = app.slice(app.indexOf('  _wireSpeedControl() {'), app.indexOf('    // Keep chip + overflow-menu label in sync'));
    expect(wire).toMatch(/openPopover\(chip, e\.detail === 0\)/);
    expect(wire).toMatch(/openPopover\(overflowBtn \|\| overflowItem, e\.detail === 0\)/);
    expect(wire).toMatch(/focusMenuFromKeyboard\(popover, '\.speed-popover__item--current'\)/);
    expect(wire).toMatch(/moveMenuFocus\(popover, e\.key\)/);
    expect(wire).toMatch(/popoverAnchor\?\.focus\(\)/);
    const pop = fs.readFileSync('renderer/player-popout.js', 'utf8');
    expect(pop).toMatch(/b\.setAttribute\('role', 'menuitem'\)/);          // its items were plain buttons
    expect(pop).toMatch(/openSpeedPopover\(overflowBtn, e\.detail === 0\)/);
    expect(pop).toMatch(/moveMenuFocus\(speedPopover, e\.key\)/);
    expect(pop).toMatch(/speedAnchor\?\.focus\(\)/);
  });
});

describe('both windows wire it', () => {
  it('app.js and player-popout.js call wireMenuKeys on the ⋮ button and menu', () => {
    for (const f of ['renderer/js/app.js', 'renderer/player-popout.js']) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).toMatch(/wireMenuKeys\(overflowBtn, overflowMenu[,)]/);
    }
  });
});

describe('an item chosen with Enter', () => {
  it('closing the menu under the focus gives it back to ⋮; an item that moved the focus elsewhere keeps it there', async () => {
    const { button: btn, menu: m } = mountRealMenu();
    btn.addEventListener('click', () => { m.hidden = !m.hidden; });
    const off = wireMenuKeys(btn, m);
    try {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      const loop = m.querySelector('#btn-loop-video');
      loop.focus();
      m.hidden = true;                                    // what the item's own handler does
      await Promise.resolve();                            // the observer (a microtask)
      expect(document.activeElement).toBe(btn);

      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      elsewhere.focus();                                  // Playback speed: the speed menu took it
      m.hidden = true;
      await Promise.resolve();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      off();
    }
  });

  it('a speed chosen with Enter gives the focus back to where the speed menu was opened from (both windows)', () => {
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    const item = app.slice(app.indexOf("item.addEventListener('click', (e) => {", app.indexOf('  _wireSpeedControl() {')));
    // Read BEFORE the rate: live, the label sync re-rendered the list and the
    // focused item was gone when it was asked afterwards.
    expect(item.slice(0, 700)).toMatch(/const hadFocus = popover\.contains\(document\.activeElement\);\s*this\.videoPlayer\.setPlaybackRate\(rate\);\s*if \(hadFocus\) popoverAnchor\?\.focus\(\);\s*closePopover\(\)/);
    const pop = fs.readFileSync('renderer/player-popout.js', 'utf8');
    expect(pop).toMatch(/const hadFocus = speedPopover\.contains\(document\.activeElement\);\s*applyRate\(s\);\s*if \(hadFocus\) speedAnchor\?\.focus\(\);\s*speedPopover\.hidden = true;/);
  });
});

// Test day 2026-11-26 (B098): with the player's ⋮ open, Left / Right seeked
// the video behind it by 5 s and Space on "Loop video" played the video
// instead of ticking it: the player's keys only gave way to a control inside
// a dialog, never inside a menu.
describe('an open menu keeps its own keys (B098)', () => {
  const owns = (k, target) => targetOwnsKey({ key: k, target, defaultPrevented: false });
  it('the arrows, Home / End and Enter / Space on a menu item are the menu\'s; letters still reach the player', () => {
    const loop = document.getElementById('btn-loop-video');
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ']) expect(owns(k, loop)).toBe(true);
    for (const k of ['f', 'm', 'k']) expect(owns(k, loop)).toBe(false);
    // The ⋮ button itself is not in the menu: Space there still plays.
    expect(owns(' ', button)).toBe(false);
  });

  it('Right on "Playback speed ▸" opens it the way Enter does (a click with detail 0); Right elsewhere does nothing', () => {
    const speed = document.getElementById('btn-speed-menu');
    let detail = null;
    speed.addEventListener('click', (e) => { detail = e.detail; });
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement).toBe(speed);
    const e = key('ArrowRight');
    expect(e.defaultPrevented).toBe(true);
    expect(detail).toBe(0);
    detail = null;
    document.getElementById('btn-loop-video').focus();
    key('ArrowRight');
    expect(detail).toBe(null);
  });
});
