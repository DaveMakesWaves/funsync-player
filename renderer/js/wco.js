// Windows Controls Overlay detection.
//
// When the native title bar is replaced by the tinted overlay
// (`titleBarStyle: 'hidden'`, electron/window-bg.js `winChromeOptions`), the
// page must supply its own drag region and inset its content from the caption
// buttons. All of that CSS is scoped under `html.has-wco`, so every window
// that can run frameless calls this once at startup.
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
