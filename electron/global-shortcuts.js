// Global hotkeys — OS-wide accelerators for play/pause, Orgasm Switch and
// Edge Hold.
//
// Eroto (EroScripts #316) drives his device with the window minimised while
// watching something else, and the media keys "mostly work but conflict with
// my media player" — which is the whole problem with media keys: every app
// claims them and the OS picks a winner.
//
// So these are explicit, opt-in accelerators, off until the user sets them
// (Settings > Playback > Global hotkeys). Registered ONLY in the main
// process: a renderer keydown listener cannot see a keystroke that went to
// another window, which is the entire point.
//
// Each binding comes back with a result, and a failure says WHICH failure:
//   'taken'   — register() returned false: another application owns the
//               combination. Pick a different key.
//   'invalid' — register() THREW: Electron could not parse the accelerator
//               at all (only reachable from a hand-edited config.json, or a
//               key the settings UI failed to refuse). Retrying is pointless.
// Both used to come back as a bare ok:false, so the renderer told the user
// "already used by another app" for a typo, and the failure was logged twice
// (V48). Silently failing to bind is how a hotkey feature becomes "it doesn't
// work" with nothing to debug, so every failure is logged, once.

const GLOBAL_ACTIONS = ['playPause', 'orgasm', 'edge'];

/**
 * @param {object} deps
 * @param {{register: Function, unregister: Function}} deps.globalShortcut — electron's
 * @param {{warn: Function}} deps.log
 * @param {(action: string) => void} deps.onFire — an accelerator fired
 */
function createGlobalShortcuts({ globalShortcut, log, onFire }) {
  let registered = [];

  function unregisterAll() {
    for (const accel of registered) {
      try { globalShortcut.unregister(accel); } catch { /* already gone */ }
    }
    registered = [];
  }

  /**
   * Replace every registration with `bindings`.
   * @param {{playPause?: string, orgasm?: string, edge?: string}} bindings
   * @returns {{action: string, accelerator: string, ok: boolean, reason?: 'taken'|'invalid'}[]}
   */
  function apply(bindings = {}) {
    unregisterAll();
    const results = [];
    for (const action of GLOBAL_ACTIONS) {
      const accel = bindings?.[action];
      if (!accel || typeof accel !== 'string') continue;
      let ok;
      try {
        // Fire-and-forget into the renderer, which owns every device path.
        // Deliberately does NOT focus or raise the window: the user asked
        // for this precisely so they can stay in another app.
        ok = globalShortcut.register(accel, () => onFire(action));
      } catch (err) {
        log.warn(`[GlobalShortcut] ${action} (${accel}) is not a valid accelerator: ${err?.message || err}`);
        results.push({ action, accelerator: accel, ok: false, reason: 'invalid' });
        continue;
      }
      if (ok) {
        registered.push(accel);
        results.push({ action, accelerator: accel, ok: true });
      } else {
        log.warn(`[GlobalShortcut] ${action} (${accel}) rejected — another app likely owns it`);
        results.push({ action, accelerator: accel, ok: false, reason: 'taken' });
      }
    }
    return results;
  }

  return { apply, unregisterAll };
}

module.exports = { createGlobalShortcuts, GLOBAL_ACTIONS };
