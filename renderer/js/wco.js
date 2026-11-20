// Windows Controls Overlay detection.
//
// When the native title bar is replaced by the tinted overlay
// (`titleBarStyle: 'hidden'`, electron/window-bg.js `winChromeOptions`), the
// page must supply its own drag region and inset its content from the caption
// buttons. All of that CSS is scoped under `html.has-wco`, so every window
// that can run frameless calls watchWcoClass at startup, which keeps the
// class in step with the overlay from then on (FT-055).
//
// Returns false on Linux (native frame) and on any build where the overlay
// isn't active, leaving those windows with their normal title bars.

/**
 * Toggle `html.has-wco` to match the current overlay state.
 * @returns {boolean} whether the overlay is active
 */
export function applyWcoClass() {
  let visible = false;
  try {
    visible = !!(navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible);
  } catch { /* older runtime — no overlay */ }
  try {
    document.documentElement.classList.toggle('has-wco', visible);
  } catch { /* no document (tests) */ }
  return visible;
}

/**
 * Keep `html.has-wco` in step with the overlay for the life of the window:
 * now, on every `geometrychange`, after `load` and after the first frame
 * (FT-055, a hedge for #381).
 *
 * zaikechi (#381): on the first launch after a reboot or sleep, no title-bar
 * drag and no Settings button; a restart fixes it. The class used to be set
 * ONCE at boot, and nothing listened for a change, so an overlay that turned
 * visible a moment after the boot check left the window with no drag region
 * and the Settings button under the caption buttons for the whole session.
 * That timing is NOT proven: this ships the re-check plus two log lines,
 * "[WCO] overlay visible=<bool> at boot" and, once, "[WCO] became visible
 * after N ms", so the next log from a bad launch says whether it was the
 * cause.
 *
 * @param {Object} [opts]
 * @param {string} [opts.where] - window name added to the log lines (pop-outs)
 * @param {{info: Function}} [opts.log] - where the lines go (console: the
 *   renderer forwards console.info to main.log)
 * @returns {{visible: boolean, recheck: Function, stop: Function}} the boot
 *   state, a manual re-check, and a stop that removes the listeners
 */
export function watchWcoClass({ where = '', log = console } = {}) {
  const suffix = where ? ` (${where})` : '';
  const say = (line) => { try { log?.info?.(line + suffix); } catch { /* logging never breaks the window */ } };
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const startedAt = now();
  const bootVisible = applyWcoClass();
  say(`[WCO] overlay visible=${bootVisible} at boot`);

  let reportedLate = bootVisible; // nothing late to report when it was there at boot
  const recheck = () => {
    const visible = applyWcoClass();
    if (visible && !reportedLate) {
      reportedLate = true;
      say(`[WCO] became visible after ${Math.round(now() - startedAt)} ms`);
    }
    return visible;
  };

  let overlay = null;
  try { overlay = navigator.windowControlsOverlay || null; } catch { /* older runtime */ }
  const stops = [];
  try {
    if (overlay && typeof overlay.addEventListener === 'function') {
      overlay.addEventListener('geometrychange', recheck);
      stops.push(() => overlay.removeEventListener('geometrychange', recheck));
    }
  } catch { /* no overlay events on this runtime */ }
  try {
    if (typeof window !== 'undefined') {
      if (document.readyState !== 'complete') {
        window.addEventListener('load', recheck, { once: true });
        stops.push(() => window.removeEventListener('load', recheck));
      }
      if (typeof window.requestAnimationFrame === 'function') {
        const id = window.requestAnimationFrame(() => recheck());
        stops.push(() => window.cancelAnimationFrame?.(id));
      }
    }
  } catch { /* no window (tests) */ }

  return {
    visible: bootVisible,
    recheck,
    stop: () => { for (const fn of stops.splice(0)) { try { fn(); } catch { /* ignore */ } } },
  };
}
