/**
 * @vitest-environment jsdom
 * jsdom on purpose: NavBar builds real DOM, listens on `document`, and
 * i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Picking anything from the library dropdown must close it fully (app test
// V53): menu hidden, the arrow back to aria-expanded="false" (which is what
// un-rotates the chevron, nav-bar.css), and no outside-click listener left
// behind.
//
// Every item handler did a bare `dd.hidden = true`. A keyboard pick (Enter
// fires click with no pointerdown) left the arrow announcing "expanded" for
// good; a mouse pick did too, because its pointerdown lands INSIDE the menu,
// which the outside-click closer deliberately ignores.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NavBar } from '../../renderer/components/nav-bar.js';

let bar;
let calls;

beforeEach(() => {
  document.body.innerHTML = '';
  calls = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  bar = new NavBar({
    onNavigate: () => {},
    onLibraryCollectionChange: (id) => calls.push(['collection', id]),
    onRenameCollection: (id) => calls.push(['rename', id]),
    onDeleteCollection: (id) => calls.push(['delete', id]),
    onAddSource: () => calls.push(['addSource']),
    onNewCollection: () => calls.push(['newCollection']),
  });
  bar.init(host);
  bar.setCollections([{ id: 'c1', name: 'Favourites' }], null, []);
});

afterEach(() => vi.restoreAllMocks());

const arrow = () => document.querySelector('.nav-bar__library-arrow');
const menu = () => document.querySelector('.nav-bar__library-dropdown');

async function openMenu() {
  arrow().click();
  await new Promise((r) => setTimeout(r, 0)); // outside-click closer arms
  expect(menu().hidden).toBe(false);
  expect(arrow().getAttribute('aria-expanded')).toBe('true');
}

function expectClosed() {
  expect(menu().hidden).toBe(true);
  expect(arrow().getAttribute('aria-expanded')).toBe('false');
}

const PICKS = [
  ['All Videos', () => menu().querySelector('.nav-bar__library-option'), ['collection', null]],
  ['a collection', () => menu().querySelector('.nav-bar__library-row .nav-bar__library-option'), ['collection', 'c1']],
  ['rename', () => menu().querySelector('.nav-bar__library-action:not(.nav-bar__library-action--danger)'), ['rename', 'c1']],
  ['delete', () => menu().querySelector('.nav-bar__library-action--danger'), ['delete', 'c1']],
  ['Add Source Folder', () => menu().querySelectorAll('.nav-bar__library-option--new')[0], ['addSource']],
  ['New Collection', () => menu().querySelectorAll('.nav-bar__library-option--new')[1], ['newCollection']],
];

describe('library dropdown closes fully on every pick (V53)', () => {
  it.each(PICKS)('keyboard pick: %s', async (_name, find, expectedCall) => {
    await openMenu();
    find().click(); // Enter/Space on a button = click with no pointerdown
    expectClosed();
    expect(calls).toEqual([expectedCall]);
  });

  it.each(PICKS)('mouse pick: %s', async (_name, find, expectedCall) => {
    await openMenu();
    const target = find();
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    target.click();
    expectClosed();
    expect(calls).toEqual([expectedCall]);
  });

  it('leaves no outside-click listener on the document after a pick', async () => {
    const live = trackDocumentPointerdown();
    await openMenu();
    expect(live.size).toBe(1);
    find0().click();
    expect(live.size).toBe(0);
  });

  it('a pick before the closer arms does not arm it afterwards', async () => {
    const live = trackDocumentPointerdown();
    arrow().click();
    find0().click(); // same tick as opening, before setTimeout(0) runs
    await new Promise((r) => setTimeout(r, 0));
    expect(live.size).toBe(0);
    expectClosed();
  });

  it('the arrow still toggles open and shut', async () => {
    await openMenu();
    arrow().click();
    expectClosed();
  });
});

/** The pointerdown capture listeners currently attached to `document`. */
function trackDocumentPointerdown() {
  const live = new Set();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    if (type === 'pointerdown' && fn) live.add(fn);
    return add(type, fn, opts);
  });
  vi.spyOn(document, 'removeEventListener').mockImplementation((type, fn, opts) => {
    if (type === 'pointerdown') live.delete(fn);
    return remove(type, fn, opts);
  });
  return live;
}

function find0() {
  return menu().querySelector('.nav-bar__library-option');
}

// Test day 2026-11-24 (B022): Escape did nothing on the open menu (the nav
// bar had no key handling at all); the menu-button pattern closes it and
// gives the focus back to the button that opened it. The Escape stops
// there: the app's own Escape (leave fullscreen, clear the loop, close the
// player view) must not fire as well.
describe('Escape closes the library menu (B022)', () => {
  it('closes it, focus back on the arrow, and the key goes no further', async () => {
    await openMenu();
    menu().querySelector('.nav-bar__library-option').focus();
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    window.removeEventListener('keydown', seen);
    expectClosed();
    expect(document.activeElement).toBe(arrow());
    expect(seen).not.toHaveBeenCalled();
  });

  it('with the focus still on the arrow, too', async () => {
    arrow().focus();
    await openMenu();
    arrow().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expectClosed();
    expect(document.activeElement).toBe(arrow());
  });

  it('a closed menu leaves Escape alone', () => {
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    window.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

// Test day 2026-11-26 (S023): the arrow said aria-haspopup="menu", but only
// Tab moved through it. Now its items are menu items and the arrows move.
describe('the Library menu from the keyboard', () => {
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  it('Enter on ▾: the library shown takes the focus; Down / Up / End move through the items (not the ✎ / ✕ beside a collection)', async () => {
    bar.setCollections([{ id: 'c1', name: 'Favourites' }], 'c1', []);
    arrow().focus();
    arrow().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(menu().getAttribute('role')).toBe('menu');
    expect(document.activeElement.textContent).toBe('Favourites');              // the active one
    key('ArrowUp');
    expect(document.activeElement.textContent).toBe('All Videos');
    key('ArrowDown');
    key('ArrowDown');
    expect(document.activeElement.getAttribute('role')).toBe('menuitem');
    expect(document.activeElement.classList.contains('nav-bar__library-action')).toBe(false);
    key('End');
    expect(document.activeElement).toBe([...menu().querySelectorAll('[role="menuitem"]')].at(-1));
    key('Escape');
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(arrow());
  });

  it('a mouse click leaves the focus where it was', () => {
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    arrow().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(other);
  });
});
