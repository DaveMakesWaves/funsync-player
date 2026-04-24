// Toast — Lightweight notification system

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
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.title = 'Click to dismiss';

  if (typeof message === 'string') {
    el.textContent = message;
  } else if (message instanceof HTMLElement) {
    el.appendChild(message);
  }

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.add('toast--out');
    el.addEventListener('animationend', () => el.remove());
  };

  // Click/key-to-dismiss — any toast can be cleared by the user, which is
  // especially important for persistent warnings (duration=0) that would
  // otherwise linger forever once their trigger condition has passed.
  el.addEventListener('click', dismiss);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dismiss();
    }
  });

  container.appendChild(el);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }

  return { dismiss, el };
}
