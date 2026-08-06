// Mini-player decision — pure helper used by `App._onLeaveView`.
//
// Community request (belgriffinite #181, deaf #189, 2026-07): "if you have
// a video playing you cannot continue to browse the library without the
// current video stopping." Phase 1 answer (single-window): when the user
// leaves the player view while a video is actively PLAYING, instead of
// tearing playback down, keep the <video> alive and shrink the player into
// a docked corner overlay so they can browse while it plays. (Phase 2 —
// the fully detached second window — is scoped separately in
// notes/features/SCOPE-separate-player-window.md.)
//
// Kept pure so the enter/skip rules are unit-testable without the App/DOM.

/**
 * Should leaving the player view dock into the mini-player instead of
 * tearing playback down?
 *
 * Only when actively playing: a paused or ended video means the user is
 * done watching, so the normal teardown is the right call. Gated by the
 * `player.miniPlayer` setting (default on) so it can be turned off.
 *
 * @param {Object} s
 * @param {boolean} s.enabled  — the `player.miniPlayer` setting (default true)
 * @param {boolean} s.hasVideo — a video is loaded (has a src)
 * @param {boolean} s.paused   — video.paused
 * @param {boolean} s.ended    — video.ended
 * @returns {boolean}
 */
export function shouldEnterMiniplayer({ enabled, hasVideo, paused, ended }) {
  if (!enabled) return false;
  if (!hasVideo) return false;
  if (ended) return false;
  return !paused;
}

/**
 * Drop OS fullscreen before leaving the player view. Call this on EVERY
 * exit path, not just the mini-player one.
 *
 * Bug (zaikechi, EroScripts #229, 2026-08-05): pressing Back while
 * fullscreen left the user stuck, having to kill the app. Nothing in the
 * navigation path exited fullscreen — the only `exitFullscreen()` call was
 * the user-initiated toggle — so the player container stayed
 * `document.fullscreenElement` while the mini-player docked on top of it.
 *
 * A fullscreen element fills the display regardless of its CSS box, so the
 * mini-player's corner styling did nothing and it rendered full screen.
 * `.player-container--mini` then hid `.player__top-bar`, taking the back
 * arrow with it, and left only the mini's expand/close buttons. Expand
 * re-entered the player (arrow back), Back re-docked the mini (arrow gone),
 * and the two states alternated forever over a library the fullscreen
 * element was covering.
 *
 * Returns whether an exit was actually requested, so callers/tests can tell
 * a no-op from a real exit. Never throws: `exitFullscreen()` rejects if the
 * document isn't in fullscreen, and this runs on a teardown path where a
 * rejection must not break navigation.
 *
 * @param {Document} [doc=document]
 * @returns {boolean} true if an exit was requested
 */
export function exitFullscreenForNav(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || !doc.fullscreenElement) return false;
  if (typeof doc.exitFullscreen !== 'function') return false;
  try {
    const p = doc.exitFullscreen();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
