/**
 * @vitest-environment jsdom
 *
 * F11 is the PLAYER's fullscreen, never the window's (Dave 2026-11-22; found
 * C-01, 2026-11-06, also in v0.9.2). The View menu's `togglefullscreen` role
 * fired for any F11 the page did not take (a text field focused in the player
 * view, any other view) and made the WINDOW fullscreen, which the player did
 * not know about: its button still said "Fullscreen", `document.fullscreenElement`
 * stayed null, Esc did nothing and the menu bar was hidden.
 *
 * Now the menu item tells the main window (and the player pop-out), whose
 * keyboard handler does what F does; any other window keeps the window toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';

const MAIN_SRC = fs.readFileSync('electron/main.js', 'utf8').replace(/\r\n/g, '\n');
function lift(start, end) {
  const i = MAIN_SRC.indexOf(start);
  if (i < 0) throw new Error(`not found in main.js: ${start}`);
  const j = MAIN_SRC.indexOf(end, i);
  return MAIN_SRC.slice(i, j + end.length);
}

function fakeWindow(url) {
  return {
    full: false,
    sent: [],
    isDestroyed: () => false,
    isFullScreen() { return this.full; },
    setFullScreen(v) { this.full = v; },
    webContents: { getURL: () => url, send(ch) { this.owner.sent.push(ch); } },
  };
}
function win(url) { const w = fakeWindow(url); w.webContents.owner = w; return w; }

function menuWith(mainWindow) {
  const src = [
    lift('async function _reloadWindow(', '\n}\n'),
    lift('function _toggleFullscreenFromMenu(', '\n}\n'),
    lift('function buildAppMenu() {', '\n}\n'),
    'return { buildAppMenu };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('process', 'Menu', 'uiScale', 'mainWindow', '_unsavedEdits', src)(
    { platform: 'win32' }, { buildFromTemplate: (t) => t }, { menuItems: () => [] }, mainWindow, { confirm: async () => true },
  );
}
const f11Item = (m) => m.buildAppMenu().find((menu) => menu.label === 'View').submenu.find((i) => i.accelerator === 'F11');

describe('the View menu\'s F11 (main.js)', () => {
  it('is no longer the built-in window-fullscreen role', () => {
    const view = menuWith(null).buildAppMenu().find((menu) => menu.label === 'View').submenu;
    expect(view.some((i) => i.role === 'togglefullscreen')).toBe(false);
    expect(f11Item(menuWith(null))).toBeTruthy();
  });

  it('the main window is told, and stays out of window fullscreen', () => {
    const main = win('file:///app/renderer/index.html');
    f11Item(menuWith(main)).click(null, main);
    expect(main.sent).toEqual(['menu-toggle-fullscreen']);
    expect(main.full).toBe(false);
  });

  it('the player pop-out is told too', () => {
    const pop = win('file:///app/renderer/player-popout.html');
    f11Item(menuWith(win('file:///app/renderer/index.html'))).click(null, pop);
    expect(pop.sent).toEqual(['menu-toggle-fullscreen']);
    expect(pop.full).toBe(false);
  });

  it('any other window (the editor pop-out) still toggles window fullscreen, in and out', () => {
    const ed = win('file:///app/renderer/editor-popout.html');
    const item = f11Item(menuWith(win('file:///app/renderer/index.html')));
    item.click(null, ed);
    expect(ed.full).toBe(true);
    item.click(null, ed);
    expect(ed.full).toBe(false);
    expect(ed.sent).toEqual([]);
  });
});

describe('the main window\'s answer (KeyboardHandler.toggleFullscreenFromMenu)', () => {
  let view;
  let offView;
  let player;
  let handler;
  const added = [];
  beforeEach(() => {
    view = 'player';
    offView = false;
    player = { toggleFullscreen: vi.fn() };
    const realAdd = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((t, fn, o) => { added.push([t, fn, o]); realAdd(t, fn, o); });
    handler = new KeyboardHandler({ videoPlayer: player, scriptEditor: { isOpen: false }, getView: () => view, hasOffViewPlayer: () => offView });
  });
  afterEach(() => {
    for (const [t, fn, o] of added.splice(0)) document.removeEventListener(t, fn, o);
    vi.restoreAllMocks();
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
  });

  it('in the player view (a text field focused there): the player goes fullscreen, as F11 on the page does', () => {
    expect(handler.toggleFullscreenFromMenu()).toBe(true);
    expect(player.toggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('in the Library with no player on screen: nothing happens', () => {
    view = 'library';
    expect(handler.toggleFullscreenFromMenu()).toBe(false);
    expect(player.toggleFullscreen).not.toHaveBeenCalled();
  });

  it('in the Library while the player pop-out plays: its fullscreen, as F does', () => {
    view = 'library';
    offView = true;
    expect(handler.toggleFullscreenFromMenu()).toBe(true);
  });

  it('already fullscreen: F11 always leaves it, whatever the view says', () => {
    view = 'library';
    Object.defineProperty(document, 'fullscreenElement', { value: document.body, configurable: true });
    expect(handler.toggleFullscreenFromMenu()).toBe(true);
    expect(player.toggleFullscreen).toHaveBeenCalledTimes(1);
  });
});

describe('the wiring', () => {
  it('the preload exposes the message, app.js and the player pop-out listen for it, and the pop-out takes F11 itself', () => {
    expect(fs.readFileSync('electron/preload.js', 'utf8')).toMatch(/onMenuToggleFullscreen[\s\S]{0,200}'menu-toggle-fullscreen'/);
    expect(fs.readFileSync('renderer/js/app.js', 'utf8')).toMatch(/onMenuToggleFullscreen\?\.\(\(\) => this\._keyboard\?\.toggleFullscreenFromMenu\(\)\)/);
    const pop = fs.readFileSync('renderer/player-popout.js', 'utf8');
    expect(pop).toMatch(/onMenuToggleFullscreen\?\.\(\(\) => videoPlayer\?\.toggleFullscreen\(\)\)/);
    expect(pop).toMatch(/case 'F11': e\.preventDefault\(\); videoPlayer\.toggleFullscreen\(\)/);
  });
});
