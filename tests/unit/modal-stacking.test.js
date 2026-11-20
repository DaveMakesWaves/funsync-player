/**
 * @vitest-environment jsdom
 * jsdom: real dialogs in a real document, keys and focus events dispatched on
 * real elements (notes/CLAUDE.md "Test environments").
 */
// FT-048 (also in v0.9.2): with one dialog open on top of another (Settings +
// Rename source, the Restore list + its confirm, Devices + the Safety Cap
// confirm), one Escape closed BOTH, and Tab was dead in the top one. Every
// Modal.open adds its own document-level capture keydown listener, and the
// LOWER dialog's runs first: on Escape it closed itself (stopPropagation does
// not stop other listeners on the same node), and on Tab it saw the focus
// outside its own panel, cancelled the Tab and pulled the focus back to its
// own control under the backdrop (V70 saw it live). The fix keeps a stack in
// modal.js: only the dialog on top answers a key.
//
// Assertions are on what the user sees: which dialogs are still on screen,
// where the focus is, whether a dialog's promise has answered, and whether
// the browser was left to move the focus itself (defaultPrevented false).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// lucide does not resolve in vitest (same mock as modal.test.js).
vi.mock('../../renderer/js/icons.js', () => ({
  icon: () => document.createElement('span'),
  X: [],
}));

import { Modal } from '../../renderer/components/modal.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><button id="opener">Settings</button></div><div id="toast-container"></div>';
});
afterEach(async () => {
  // Close whatever a test left open the way a user would, so no dialog
  // listener outlives its test.
  for (let i = 0; i < 5 && document.querySelector('.modal-overlay'); i++) {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }
  document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
});

function key(target, keyName, init = {}) {
  const e = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** Track a dialog's answer without awaiting it. */
function track(promise) {
  const state = { settled: false, value: undefined };
  promise.then((v) => { state.settled = true; state.value = v; });
  return state;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Dialog A: a Settings-like dialog with three buttons; returns its parts. */
async function openA() {
  document.getElementById('opener').focus();
  let buttons;
  const answer = track(Modal.open({
    title: 'Settings',
    onRender(body, close) {
      body.innerHTML = '<button class="a1">Rename source</button><button class="a2">Remove source</button><button class="a3">Done</button>';
      buttons = [...body.querySelectorAll('button')];
      buttons[2].addEventListener('click', () => close('done'));
    },
  }));
  const overlay = document.querySelectorAll('.modal-overlay')[0];
  return { answer, overlay, buttons, panel: overlay.querySelector('.modal-panel') };
}

/** Dialog B: the Rename prompt, opened from A's first button. */
function openB(a) {
  a.buttons[0].focus();
  const answer = track(Modal.prompt('Rename source', 'Name', 'Old name'));
  const overlays = document.querySelectorAll('.modal-overlay');
  const overlay = overlays[overlays.length - 1];
  const input = overlay.querySelector('input');
  input.focus(); // what the dialog's own first-focus frame does
  const focusables = [...overlay.querySelectorAll('button, input')];
  return { answer, overlay, input, first: focusables[0], last: focusables[focusables.length - 1] };
}

describe('FT-048: two dialogs stacked', () => {
  it('Tab in the top dialog is left to the browser: the dialog under it does not cancel it or take the focus', async () => {
    const a = await openA();
    const b = openB(a);
    const e = key(b.input, 'Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(b.input);
    expect(a.panel.contains(document.activeElement)).toBe(false);
  });

  it('the top dialog\'s own trap still wraps: Tab on its last control goes to its first, Shift+Tab on its first to its last', async () => {
    const a = await openA();
    const b = openB(a);
    b.last.focus();
    expect(key(b.last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b.first);
    expect(key(b.first, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b.last);
    expect(a.panel.contains(document.activeElement)).toBe(false);
  });

  it('one Escape closes only the top dialog; the one under it stays open, unanswered, with the focus back in it', async () => {
    const a = await openA();
    const b = openB(a);
    expect(a.overlay.getAttribute('inert')).toBe('modal'); // under B's backdrop
    key(b.input, 'Escape');
    await flush();
    expect(b.answer).toEqual({ settled: true, value: null }); // a prompt cancels safely
    expect(b.overlay.isConnected).toBe(false);
    expect(a.overlay.isConnected).toBe(true);
    expect(a.answer.settled).toBe(false);
    expect(document.activeElement).toBe(a.buttons[0]); // back on Rename source
    expect(a.overlay.hasAttribute('inert')).toBe(false);

    // A second Escape closes A, and the focus goes back to the page.
    key(document.activeElement, 'Escape');
    await flush();
    expect(a.answer).toEqual({ settled: true, value: null });
    expect(a.overlay.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('opener'));
  });

  it('after the top dialog closes, the lower one\'s trap works again', async () => {
    const a = await openA();
    const b = openB(a);
    key(b.input, 'Escape');
    a.buttons[2].focus();
    expect(key(a.buttons[2], 'Tab').defaultPrevented).toBe(true);
    const aFirst = a.panel.querySelector('button'); // its X
    expect(document.activeElement).toBe(aFirst);
  });

  it('an Escape the top dialog takes reaches no other document listener (a panel under the dialogs stays open)', async () => {
    const a = await openA();
    const b = openB(a);
    const later = vi.fn();
    document.addEventListener('keydown', later, true);
    try {
      key(b.input, 'Escape');
      expect(later).not.toHaveBeenCalled();
      expect(a.overlay.isConnected).toBe(true);
    } finally {
      document.removeEventListener('keydown', later, true);
    }
  });

  it('focus that reaches a toast goes back into the TOP dialog, not the one under it', async () => {
    const a = await openA();
    const b = openB(a);
    const toastBtn = document.createElement('button');
    document.getElementById('toast-container').appendChild(toastBtn);
    toastBtn.focus();
    expect(b.overlay.contains(document.activeElement)).toBe(true);
    expect(a.panel.contains(document.activeElement)).toBe(false);
  });

  it('a fullscreen change with two dialogs open leaves the top one live (not inert) and on top', async () => {
    const a = await openA();
    const b = openB(a);
    const stage = document.createElement('div');
    stage.id = 'player-container';
    document.getElementById('app').appendChild(stage);
    Object.defineProperty(document, 'fullscreenElement', { value: stage, configurable: true });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(b.overlay.parentElement).toBe(stage);
      expect(a.overlay.parentElement).toBe(stage);
      expect(b.overlay.hasAttribute('inert')).toBe(false);
      expect(a.overlay.getAttribute('inert')).toBe('modal');
      expect([...stage.children].indexOf(b.overlay)).toBeGreaterThan([...stage.children].indexOf(a.overlay));
    } finally {
      delete document.fullscreenElement;
    }
  });

  it('a single dialog behaves as before: Escape closes it, Tab wraps inside it', async () => {
    const a = await openA();
    a.buttons[2].focus();
    expect(key(a.buttons[2], 'Tab').defaultPrevented).toBe(true);
    key(document.activeElement, 'Escape');
    await flush();
    expect(a.answer).toEqual({ settled: true, value: null });
  });
});

// The video options dialog's onEscape (notes/features/DESIGN-video-options.md
// (f)): it is asked only when its dialog is on top. The Unpair confirm opens
// over the dialog; its Escape is the confirm's alone.
describe('onEscape with dialogs stacked', () => {
  /** Dialog A with an onEscape; its buttons as in openA. */
  function openAWith(onEscape) {
    document.getElementById('opener').focus();
    let buttons;
    const answer = track(Modal.open({
      title: 'Video options',
      onEscape,
      onRender(body) {
        body.innerHTML = '<button class="a1">Unpair</button><button class="a2">Tags</button>';
        buttons = [...body.querySelectorAll('button')];
      },
    }));
    const overlay = document.querySelectorAll('.modal-overlay')[0];
    return { answer, overlay, buttons };
  }

  it('a confirm stacked on a dialog with onEscape: Escape closes the confirm only, and the lower onEscape is not asked', async () => {
    const onEscape = vi.fn(() => false);
    const a = openAWith(onEscape);
    a.buttons[0].focus();
    const confirm = track(Modal.confirm('Unpair funscript?', 'The video keeps its file.'));
    const overlays = document.querySelectorAll('.modal-overlay');
    const b = overlays[overlays.length - 1];
    b.querySelector('.modal-btn--secondary').focus();

    key(document.activeElement, 'Escape');
    await flush();
    expect(onEscape).not.toHaveBeenCalled();
    expect(confirm).toEqual({ settled: true, value: null });
    expect(b.isConnected).toBe(false);
    expect(a.overlay.isConnected).toBe(true);
    expect(a.answer.settled).toBe(false);
    expect(document.activeElement).toBe(a.buttons[0]);

    // Now A is on top: its onEscape is asked, says "not handled", A closes.
    key(document.activeElement, 'Escape');
    await flush();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(a.answer).toEqual({ settled: true, value: null });
    expect(document.activeElement).toBe(document.getElementById('opener'));
  });

  it('a top dialog whose onEscape handles the press stays, and the dialog under it is not closed either', async () => {
    const a = await openA();
    a.buttons[0].focus();
    let handled = true;
    const onEscape = vi.fn(() => handled);
    const top = track(Modal.open({
      title: 'Video options',
      onEscape,
      onRender(body) { body.innerHTML = '<button class="b1">Tags</button>'; },
    }));
    const overlays = document.querySelectorAll('.modal-overlay');
    const b = overlays[overlays.length - 1];
    b.querySelector('.b1').focus();

    key(document.activeElement, 'Escape');
    await flush();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(b.isConnected).toBe(true);
    expect(top.settled).toBe(false);
    expect(a.overlay.isConnected).toBe(true);
    expect(a.answer.settled).toBe(false);

    handled = false;
    key(document.activeElement, 'Escape');
    await flush();
    expect(top).toEqual({ settled: true, value: null });
    expect(a.overlay.isConnected).toBe(true);
    expect(a.answer.settled).toBe(false);
  });
});
