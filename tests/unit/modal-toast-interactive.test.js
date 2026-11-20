/**
 * jsdom on purpose: the REAL index.html body (so the real #toast-container,
 * where the app puts it), the REAL Modal.open() and the REAL showToast().
 *
 * V70: while any Modal.open() dialog was open, the toast container was one
 * of the background siblings the dialog inerts. The toast still painted on
 * top (z-index 2000 against the backdrop's 1000), but the browser skips an
 * inert element when it works out what the pointer is over, so pressing a
 * toast's X landed on the backdrop and closed the dialog, and hovering a
 * toast did not pause it. Toasts now stay live under a dialog, but never take
 * focus from it.
 *
 * jsdom has no hit testing and ignores `inert`, so press()/hover() below
 * model the two browser rules the bug was made of. Nothing else is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

// Same mock as modal.test.js: lucide's node_modules paths don't resolve here.
vi.mock('../../renderer/js/icons.js', () => ({
  icon: () => document.createElement('span'),
  X: [],
}));

import { Modal } from '../../renderer/components/modal.js';
import { showToast } from '../../renderer/js/toast.js';

// Scripts in it do not run through innerHTML; only the markup is used.
const INDEX_BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(fs.readFileSync('renderer/index.html', 'utf8'))[1];

const topOverlay = () => {
  const all = document.querySelectorAll('.modal-overlay');
  return all[all.length - 1] || null;
};

/**
 * A mouse press and release on `el`, as Chromium does it. An inert element is
 * not under the pointer as far as the browser is concerned, so the press goes
 * to what is behind it: here the open dialog's backdrop. mousedown focuses
 * the nearest focusable element under the pointer unless a listener cancels
 * it; the click lands either way.
 */
function press(el) {
  const target = el.closest('[inert]') ? (topOverlay() || document.body) : el;
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  if (!down.defaultPrevented) {
    const focusable = target.closest('button, input, select, textarea, [tabindex]');
    if (focusable) focusable.focus();
  }
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Pointer moves onto / off `el`. An inert element gets neither event. */
function hover(el) {
  if (!el.closest('[inert]')) el.dispatchEvent(new MouseEvent('mouseenter'));
}
function unhover(el) {
  if (!el.closest('[inert]')) el.dispatchEvent(new MouseEvent('mouseleave'));
}

/** Focus by keyboard or script. An inert element cannot take focus. */
function focusLike(el) {
  if (!el.closest('[inert]')) el.focus();
}

/** The toast's exit animation finishing, which jsdom never plays. */
function finishExit(toastEl) {
  toastEl.dispatchEvent(new Event('animationend'));
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

describe('toasts while a dialog is open (V70)', () => {
  let pending = [];

  beforeEach(() => {
    document.body.innerHTML = INDEX_BODY;
    pending = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Close whatever a test left open, newest first, so no listener leaks.
    let overlay;
    while ((overlay = topOverlay())) {
      overlay.querySelector('.modal-close-btn').click();
    }
    await Promise.all(pending);
  });

  const open = (opts) => {
    const p = Modal.open(opts);
    pending.push(p);
    return p;
  };

  it('uses the real toast container from index.html, a sibling the dialog would otherwise inert', () => {
    const container = document.getElementById('toast-container');
    expect(container).toBeTruthy();
    expect(container.parentElement).toBe(document.body);
  });

  it('leaves the toast container live while the rest of the page is inert', () => {
    open({ title: 'Restore from backup' });
    const container = document.getElementById('toast-container');
    expect(container.closest('[inert]')).toBeNull();
    // The dialog is still modal: the app behind it is inert and the panel
    // still declares it.
    expect(document.getElementById('app').hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.modal-panel').getAttribute('aria-modal')).toBe('true');
  });

  it("a toast's X closes the toast and leaves the dialog open", async () => {
    const result = open({ title: 'Restore from backup' });
    const { el } = showToast('Snapshot taken', 'info', 0);
    const container = document.getElementById('toast-container');

    press(el.querySelector('.toast__close'));
    expect(el.classList.contains('toast--out')).toBe(true);
    finishExit(el);
    expect(container.contains(el)).toBe(false);

    // The press did not fall through to the backdrop and cancel the dialog.
    expect(topOverlay()).toBeTruthy();
    let settled = false;
    result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('a press on the toast body dismisses it too, dialog untouched', () => {
    open({ title: 'Restore from backup' });
    const { el } = showToast('Snapshot taken', 'info', 0);
    press(el.querySelector('.toast__body'));
    expect(el.classList.contains('toast--out')).toBe(true);
    expect(topOverlay()).toBeTruthy();
  });

  it('hovering a toast pauses its auto-dismiss under a dialog, and leaving resumes it', () => {
    vi.useFakeTimers();
    open({ title: 'Restore from backup' });
    const { el } = showToast('Snapshot taken', 'info', 3000);

    vi.advanceTimersByTime(1000);
    hover(el);
    vi.advanceTimersByTime(10000);
    expect(el.classList.contains('toast--out')).toBe(false);

    unhover(el);
    vi.advanceTimersByTime(3000);
    expect(el.classList.contains('toast--out')).toBe(true);
  });

  it('pressing a toast keeps focus where it was in the dialog', async () => {
    pending.push(Modal.prompt('Rename source', '', 'Library'));
    await nextFrame();
    const input = document.querySelector('.modal-input');
    expect(document.activeElement).toBe(input);

    const { el } = showToast('Snapshot taken', 'info', 0);
    press(el.querySelector('.toast__close'));
    expect(el.classList.contains('toast--out')).toBe(true);
    expect(document.activeElement).toBe(input);

    press(showToast('Second', 'info', 0).el);
    expect(document.activeElement).toBe(input);
  });

  it('focus that reaches a toast goes back into the dialog', async () => {
    open({ title: 'Restore from backup' });
    await nextFrame();
    const { el } = showToast('Snapshot taken', 'info', 0);

    focusLike(el);
    expect(document.querySelector('.modal-panel').contains(document.activeElement)).toBe(true);
    focusLike(el.querySelector('.toast__close'));
    expect(document.querySelector('.modal-panel').contains(document.activeElement)).toBe(true);
  });

  it('with a dialog stacked on another, the X still works and focus goes to the top one', async () => {
    open({ title: 'Settings' });
    open({ title: 'Remove source' });
    await nextFrame();
    const [lower, upper] = document.querySelectorAll('.modal-overlay');
    expect(lower.hasAttribute('inert')).toBe(true);

    const { el } = showToast('Snapshot taken', 'info', 0);
    focusLike(el);
    expect(upper.querySelector('.modal-panel').contains(document.activeElement)).toBe(true);

    press(el.querySelector('.toast__close'));
    expect(el.classList.contains('toast--out')).toBe(true);
    expect(document.querySelectorAll('.modal-overlay').length).toBe(2);
  });

  // This used to pin "a press focuses the X" once the dialog had closed. That
  // focus was FT-036: with the toast gone, focus sat on <body>, and an open
  // EroScripts or Devices panel stopped hearing Escape. A press never takes
  // focus now, dialog or not (floating-panel-modal-clicks.test.js has the
  // panels); keyboard and script focus still reach the toast, and nothing
  // redirects it.
  it('after the dialog closes nothing redirects: focus still reaches the toast, and a press still does not take it', async () => {
    const result = open({ title: 'Restore from backup' });
    document.querySelector('.modal-close-btn').click();
    await result;
    expect(document.getElementById('app').hasAttribute('inert')).toBe(false);

    const { el } = showToast('Snapshot taken', 'info', 0);
    focusLike(el);
    expect(document.activeElement).toBe(el);
    focusLike(el.querySelector('.toast__close'));
    expect(document.activeElement).toBe(el.querySelector('.toast__close'));

    const before = document.activeElement;
    const second = showToast('Second', 'info', 0).el;
    press(second.querySelector('.toast__close'));
    expect(second.classList.contains('toast--out')).toBe(true);
    expect(document.activeElement).toBe(before);
  });
});

// FT-037: focus that reached a toast under a dialog left the toast paused for
// good. Modal's document-capture focusin moved focus back into the dialog
// synchronously, so the toast's focusout (resume) ran while its timer was
// still running and did nothing; the same focusin then reached the toast and
// paused it, and no focusout ever came.
describe('a toast under a dialog still times out after focus bounces off it (FT-037)', () => {
  let pending = [];
  beforeEach(() => {
    document.body.innerHTML = INDEX_BODY;
    pending = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    let overlay;
    while ((overlay = topOverlay())) overlay.querySelector('.modal-close-btn').click();
    await Promise.all(pending);
  });

  it('Tab or script focus on its X: focus goes back to the dialog and the toast still goes at its time', async () => {
    pending.push(Modal.open({ title: 'Settings' }));
    await nextFrame();
    vi.useFakeTimers();
    const { el } = showToast('Snapshot taken', 'info', 1000);

    focusLike(el.querySelector('.toast__close'));
    expect(document.querySelector('.modal-panel').contains(document.activeElement)).toBe(true);

    vi.advanceTimersByTime(1700);
    expect(el.classList.contains('toast--out')).toBe(true);
  });

  it('the toast itself (tabindex 0) the same', async () => {
    pending.push(Modal.open({ title: 'Settings' }));
    await nextFrame();
    vi.useFakeTimers();
    const { el } = showToast('Snapshot taken', 'info', 1000);
    focusLike(el);
    vi.advanceTimersByTime(1700);
    expect(el.classList.contains('toast--out')).toBe(true);
  });

  it("the dialog's redirect stops the focusin there: the toast never hears it", async () => {
    pending.push(Modal.open({ title: 'Settings' }));
    await nextFrame();
    const { el } = showToast('Snapshot taken', 'info', 0);
    let heard = 0;
    el.addEventListener('focusin', () => { heard++; });
    focusLike(el.querySelector('.toast__close'));
    expect(heard).toBe(0);
  });

  it('without a dialog, any focus trap that bounces focus off a toast leaves it running (the toast guard)', () => {
    vi.useFakeTimers();
    const { el } = showToast('Snapshot taken', 'info', 1000);
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    // A foreign trap: sends focus away in the capture phase and lets the event go on.
    const trap = (e) => { if (el.contains(e.target)) elsewhere.focus(); };
    document.addEventListener('focusin', trap, true);
    try {
      el.querySelector('.toast__close').focus();
      expect(document.activeElement).toBe(elsewhere);
      vi.advanceTimersByTime(1700);
      expect(el.classList.contains('toast--out')).toBe(true);
    } finally {
      document.removeEventListener('focusin', trap, true);
    }
  });

  it('focus that stays on the toast still pauses it, and leaving resumes it', () => {
    vi.useFakeTimers();
    const { el } = showToast('Snapshot taken', 'info', 1000);
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    el.querySelector('.toast__close').focus();
    vi.advanceTimersByTime(5000);
    expect(el.classList.contains('toast--out')).toBe(false);
    elsewhere.focus();
    vi.advanceTimersByTime(1100);
    expect(el.classList.contains('toast--out')).toBe(true);
  });
});
