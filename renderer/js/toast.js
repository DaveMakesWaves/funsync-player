// Toast — Lightweight notification system

const TOAST_DURATION = 3000;

/**
 * Show a toast notification.
 * @param {string|HTMLElement} message — text string or DOM element
 * @param {'info'|'warn'|'error'} type — toast style
 * @param {number} [duration] — ms before auto-dismiss (0 = persistent, default 3000)
 */
export function showToast(message, type = 'info', duration = TOAST_DURATION) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;

  if (typeof message === 'string') {
    el.textContent = message;
  } else if (message instanceof HTMLElement) {
    el.appendChild(message);
  }

  container.appendChild(el);

  if (duration > 0) {
    setTimeout(() => {
      el.classList.add('toast--out');
      el.addEventListener('animationend', () => el.remove());
    }, duration);
  }
}
