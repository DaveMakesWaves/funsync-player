// Toast — Lightweight notification system
//
// Polish pass 2026-04-27 (SCOPE-desktop-redesign §4.8):
//   - Explicit close (X) button, focusable, on every toast.
//     Click-anywhere-to-dismiss is preserved for sighted-mouse users
//     but no longer the only path — keyboard/screen-reader users now
//     have a real focusable target. (Shneiderman #2 universal usability.)
//   - role="alert" for errors (announces immediately to screen readers),
//     role="status" for info/warn (announces politely).
//     (Nielsen #1 visibility of system status.)
//   - Auto-dismiss timer pauses on hover and on focus, and resumes on
//     mouseleave / blur. Slow readers get the time they need without
//     the toast disappearing mid-sentence. (Nielsen #3 user control.)

const TOAST_DURATION = 3000;

/**
 * Show a toast notification.
 * @param {string|HTMLElement} message — text string or DOM element
 * @param {'info'|'warn'|'error'} type — toast style
 * @param {number} [duration] — ms before auto-dismiss (0 = persistent, default 3000)
 * @returns {{dismiss: () => void, el: HTMLElement} | undefined} handle for
 *          programmatic dismissal (e.g. tear down a persistent hint when
 *          the underlying condition clears)
 */
export function showToast(message, type = 'info', duration = TOAST_DURATION) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  // Errors use role="alert" so screen readers interrupt and announce
  // immediately — they're problems the user needs to know about NOW.
  // Info / warn use role="status" (polite) — non-blocking confirmations
  // that don't deserve to break the user's focus.
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  el.tabIndex = 0;

  // Body wrapper holds the message; the X button sits next to it.
  const body = document.createElement('div');
  body.className = 'toast__body';
  if (typeof message === 'string') {
    body.textContent = message;
  } else if (message instanceof HTMLElement) {
    body.appendChild(message);
  }
  el.appendChild(body);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.add('toast--out');
    el.addEventListener('animationend', () => el.remove());
  };

  // Explicit close button — focusable, with aria-label. Stops propagation
  // so the click-anywhere-to-dismiss path doesn't double-fire.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast__close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  el.appendChild(closeBtn);

  // Click-anywhere on the body still dismisses for sighted-mouse users
  // (preserves the prior frictionless flow). Pressing Enter / Space on
  // the focused toast also dismisses, matching button affordance.
  body.addEventListener('click', dismiss);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dismiss();
    }
  });

  container.appendChild(el);

  // Pause-on-hover/focus auto-dismiss. Slow readers (or anyone whose
  // attention drifted at the wrong moment) get the message preserved
  // until they actively move on.
  if (duration > 0) {
    let remaining = duration;
    let startedAt = performance.now();
    let timer = setTimeout(dismiss, remaining);
    const pause = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      remaining -= performance.now() - startedAt;
    };
    const resume = () => {
      if (timer || dismissed) return;
      startedAt = performance.now();
      timer = setTimeout(dismiss, Math.max(remaining, 600));
    };
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', resume);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', resume);
  }

  return { dismiss, el };
}
