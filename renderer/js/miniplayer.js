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
