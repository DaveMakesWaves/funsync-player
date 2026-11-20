/**
 * @vitest-environment jsdom
 * jsdom on purpose: this opens the REAL `?` overlay (Modal.open) and reads
 * what it renders, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// V46 (app test 2026-11-02): the player's `?` shortcut list.
//
//   1. It said "Esc — Back from player to library". Escape has never left
//      the player: it dismisses Up Next, closes the queue panel, clears the
//      A-B loop and closes panels — which the list ALSO said, on another
//      Esc row, so the two contradicted each other. The false row is gone.
//   2. It opened scrolled past its first groups. Modal.open focuses the
//      first button in the body, and the list's only button ("Got it") is
//      at the very end, so focus() scrolled the overflow body down to it,
//      hiding Navigation and Playback.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { openKeyboardHelp, getPlayerShortcutGroups } from '../../renderer/js/keyboard-help.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

beforeAll(() => {
  _setBundlesForTests('en', EN, EN);
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('V46: the shortcut list says what Escape actually does', () => {
  it('has exactly one Esc row, and it is the one Escape does', () => {
    const escRows = getPlayerShortcutGroups()
      .flatMap((g) => g.rows)
      .filter(([keys]) => keys.split(/\s*\/\s*/).includes('Esc'));
    expect(escRows.map(([, desc]) => desc)).toEqual([t('kbd.clearLoop')]);
  });

  it('the rendered list no longer claims Escape goes back to the library', async () => {
    openKeyboardHelp(t('kbd.playerTitle'), getPlayerShortcutGroups());
    const text = document.querySelector('.modal-body').textContent;
    expect(text).not.toMatch(/back from player to library/i);
    expect(text).toContain('Clear loop / close panels');
    document.querySelector('.modal-close-btn').click();
  });

  it('Escape on the player does what that row says, and does not leave', () => {
    // Pin the behaviour the list now describes, so the two cannot drift
    // apart again unnoticed: Esc clears the A-B loop and closes panels.
    const player = { clearAbLoop: vi.fn() };
    const connectionPanel = { hide: vi.fn(), toggle: vi.fn() };
    const onNavigate = vi.fn();
    class OneHandler extends KeyboardHandler { _bindEvents() {} }
    const kb = new OneHandler({ videoPlayer: player, connectionPanel, onNavigate });
    kb._onKeyDown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(player.clearAbLoop).toHaveBeenCalledTimes(1);
    expect(connectionPanel.hide).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('V46: the shortcut list opens at its top', () => {
  // jsdom has no layout, so it never scrolls anything. Model the one
  // browser behaviour this is about: focus() without preventScroll scrolls
  // the focused control into view inside its scrolling ancestor (the
  // .modal-body, overflow-y: auto). Record which focus calls would have.
  let scrolledTo;
  let realFocus;
  let realRaf;
  beforeEach(() => {
    scrolledTo = [];
    realFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focus(opts) {
      if (!opts?.preventScroll && this.closest('.modal-body')) scrolledTo.push(this.textContent);
      return realFocus.call(this, opts);
    };
    realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (fn) => { fn(); return 0; };
  });
  afterEach(() => {
    HTMLElement.prototype.focus = realFocus;
    window.requestAnimationFrame = realRaf;
  });

  it('focuses "Got it" for the keyboard without scrolling the list down to it', () => {
    openKeyboardHelp(t('kbd.playerTitle'), getPlayerShortcutGroups());
    const ok = [...document.querySelectorAll('.modal-body button')].pop();
    expect(ok.textContent).toBe(t('common.gotIt'));
    expect(document.activeElement).toBe(ok);          // Enter / Space still dismiss
    expect(scrolledTo, 'the body scrolled away from Navigation / Playback').toEqual([]);
    // The first group is still the one on top.
    expect(document.querySelector('.editor-help__title').textContent).toBe(t('kbd.navigation'));
    document.querySelector('.modal-close-btn').click();
  });
});
