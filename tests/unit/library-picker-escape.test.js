/**
 * @vitest-environment jsdom
 * jsdom on purpose: the pickers are real DOM and library.js imports modules
 * that branch on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// The Library header's Sort and Filters pop-ups (test day 2026-11-24, B022):
// Escape closed one only while the focus was INSIDE it. Opened with a click,
// the focus stays on the button, and Escape did nothing; the nav bar's
// Library menu had the same gap. Now Escape on the button closes it too, the
// focus stays on the button, and the key goes no further (the app's own
// Escape must not fire as well).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

let lib;
let btn;
let pop;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="host">
      <button id="library-sort-btn" aria-controls="library-sort-pop" aria-expanded="false">Name A-Z</button>
      <div class="library__picker-pop" id="library-sort-pop" role="listbox" hidden><button class="opt">Recently Added</button></div>
    </div>`;
  lib = Object.create(Library.prototype);
  lib._container = document.getElementById('host');
  btn = document.getElementById('library-sort-btn');
  pop = document.getElementById('library-sort-pop');
  lib._wirePickerDismissal(pop, btn);
});

const esc = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

describe('Library pickers: Escape (B022)', () => {
  it('with the focus on the button (opened by a click), Escape closes it', () => {
    btn.focus();
    lib._openPicker(pop, btn);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    esc(btn);
    window.removeEventListener('keydown', seen);
    expect(pop.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
    expect(seen).not.toHaveBeenCalled();
  });

  it('with the focus inside it, as before', () => {
    lib._openPicker(pop, btn);
    pop.querySelector('.opt').focus();
    esc(pop.querySelector('.opt'));
    expect(pop.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('a closed picker leaves Escape on the button alone', () => {
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    esc(btn);
    window.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
