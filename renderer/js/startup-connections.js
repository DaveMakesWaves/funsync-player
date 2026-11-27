// One toast for the devices that connect by themselves at start-up.
//
// Dave, 2026-11-25: "since we dont just cater to handy users anymore lets
// remove the handy failed to connect toast on start up and have a toast for
// any devices that do get connected on start up". The Handy (a saved key)
// and Intiface's toys (found by the scan after Intiface answers, a few
// seconds in) connect on their own; each one that does in the first
// WINDOW_MS is listed, and one toast says so once they have settled
// (SETTLE_MS after the last one), not one per device. Nothing connected:
// nothing is said. A device connected after the window is the user's own
// doing, shown by its indicator as before.
//
// Pure: timers are injected; the app shows the toast.

export const WINDOW_MS = 15000;
export const SETTLE_MS = 2500;

export class StartupConnections {
  /**
   * @param {object} opts
   * @param {(names: string[]) => void} opts.onShow  shows the toast
   * @param {number} [opts.windowMs]
   * @param {number} [opts.settleMs]
   * @param {Function} [opts.setTimer]
   * @param {Function} [opts.clearTimer]
   */
  constructor({ onShow, windowMs = WINDOW_MS, settleMs = SETTLE_MS, setTimer, clearTimer } = {}) {
    this._onShow = typeof onShow === 'function' ? onShow : () => {};
    this._windowMs = windowMs;
    this._settleMs = settleMs;
    this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = clearTimer || ((h) => clearTimeout(h));
    this._open = false;
    this._done = false;
    this._names = [];
    this._settle = null;
    this._window = null;
  }

  /** Start listening (once, before the start-up connects begin). */
  begin() {
    if (this._open || this._done) return;
    this._open = true;
    this._window = this._setTimer(() => this._windowEnded(), this._windowMs);
  }

  /** A device connected: listed while the window is open (each name once). */
  connected(name) {
    const label = typeof name === 'string' ? name.trim() : '';
    if (!this._open || !label) return;
    if (!this._names.includes(label)) this._names.push(label);
    if (this._settle) this._clearTimer(this._settle);
    this._settle = this._setTimer(() => this._flush(), this._settleMs);
  }

  _windowEnded() {
    this._window = null;
    // Something still settling is said now; otherwise the window just closes.
    if (this._names.length) this._flush();
    else this._close();
  }

  _flush() {
    const names = this._names.slice();
    this._close();
    if (names.length) this._onShow(names);
  }

  _close() {
    this._open = false;
    this._done = true;
    this._names = [];
    if (this._settle) this._clearTimer(this._settle);
    if (this._window) this._clearTimer(this._window);
    this._settle = null;
    this._window = null;
  }
}

/** "A, B and C" in the language shown (Intl.ListFormat), else "A, B, C". */
export function deviceList(names, locale = 'en') {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n);
  try {
    if (typeof Intl?.ListFormat === 'function') return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(list);
  } catch { /* an unknown locale: the plain list */ }
  return list.join(', ');
}
