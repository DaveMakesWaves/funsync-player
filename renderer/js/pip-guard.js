// Picture-in-Picture sync guard — pure helpers used by `App._onLeaveView`.
//
// Community feedback (GGEZGitGud, 2026-05-15): "when im playing in
// picture-in-picture mode and i back to the menu, the video can keeps
// going but the script will stop". Root cause: the player-leave teardown
// in `app.js` unconditionally paused the video and stopped every sync
// engine + device. The PiP video kept going (because pause() only affects
// the source video element's playback in the inline player, not the
// detached PiP), but devices were silenced because their sync engines
// were stopped.
//
// The fix runs the teardown only when PiP is NOT active. If it is, defer
// until PiP closes — either because the user dismissed the floating
// window, the video ended, or PiP was programmatically exited. If the
// user comes BACK to the player view before PiP closes, the deferred
// teardown is cancelled (they're actively watching again).
//
// All helpers are pure — they accept a `deps` object containing the
// references they need and operate on it. Makes them straightforward to
// test without instantiating the full App.

/**
 * Is the supplied video element currently the document's PiP element?
 * Defensive against missing video (e.g. test setup) and undefined document.
 */
export function isVideoInPip(video, doc = (typeof document !== 'undefined' ? document : null)) {
  if (!video || !doc) return false;
  return doc.pictureInPictureElement === video;
}

/**
 * Run the full teardown sequence — pause video, stop sync engines, stop
 * device-side commands, exit fullscreen. Idempotent on missing refs so
 * the same helper handles both the immediate and deferred paths.
 *
 * @param {Object} deps
 * @param {{video: HTMLVideoElement|null}|null} [deps.videoPlayer]
 * @param {{stop: () => void}|null} [deps.syncEngine]
 * @param {{_active: boolean, stop: () => void}|null} [deps.buttplugSync]
 * @param {{_active: boolean, stop: () => void}|null} [deps.tcodeSync]
 * @param {{_active: boolean, stop: () => void}|null} [deps.autoblowSync]
 * @param {{connected: boolean, hsspStop: () => void}|null} [deps.handyManager]
 * @param {{connected: boolean, stopAll: () => void}|null} [deps.buttplugManager]
 * @param {{connected: boolean, stop: () => void}|null} [deps.tcodeManager]
 * @param {{connected: boolean, syncStop: () => void}|null} [deps.autoblowManager]
 */
export function teardownPlayback(deps) {
  // Pause video first — stops playback immediately in the browser
  if (deps?.videoPlayer?.video) deps.videoPlayer.video.pause();

  // Stop all sync engines (prevents any new commands from being queued)
  if (deps?.syncEngine) deps.syncEngine.stop();
  if (deps?.buttplugSync?._active) deps.buttplugSync.stop();
  if (deps?.tcodeSync?._active) deps.tcodeSync.stop();
  if (deps?.autoblowSync?._active) deps.autoblowSync.stop();

  // Stop all devices (network calls — async but fire-and-forget)
  if (deps?.handyManager?.connected) deps.handyManager.hsspStop();
  if (deps?.buttplugManager?.connected) deps.buttplugManager.stopAll();
  if (deps?.tcodeManager?.connected) deps.tcodeManager.stop();
  if (deps?.autoblowManager?.connected) deps.autoblowManager.syncStop();

  const doc = (typeof document !== 'undefined') ? document : null;
  if (doc && doc.fullscreenElement) {
    doc.exitFullscreen().catch(() => {});
  }
}

/**
 * Install a one-shot `leavepictureinpicture` listener that runs the
 * teardown when PiP eventually closes. Tracks `pending` / `cancelled`
 * flags on the supplied state object so the caller can:
 *   - skip if a deferred teardown is already pending (idempotent),
 *   - cancel from outside when the user returns to active playback.
 *
 * @param {Object} state — `{ _pipTeardownPending, _pipTeardownCancelled }`
 *                         (read + written by this helper).
 * @param {Object} deps — same shape as `teardownPlayback` deps.
 * @returns {boolean} true if a listener was installed; false if it was a
 *                    no-op (already pending) OR the teardown ran inline
 *                    because no video element was available.
 */
export function beginDeferredPipTeardown(state, deps) {
  if (state._pipTeardownPending) return false;
  state._pipTeardownPending = true;
  const video = deps?.videoPlayer?.video;
  if (!video) {
    state._pipTeardownPending = false;
    teardownPlayback(deps);
    return false;
  }
  const handler = () => {
    video.removeEventListener('leavepictureinpicture', handler);
    state._pipTeardownPending = false;
    if (state._pipTeardownCancelled) {
      state._pipTeardownCancelled = false;
      return;
    }
    teardownPlayback(deps);
  };
  video.addEventListener('leavepictureinpicture', handler, { once: true });
  return true;
}
