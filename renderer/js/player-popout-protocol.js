// Player pop-out — state-sync protocol.
//
// Single broker (main process, `electron/player-popout-window.js`) ferries
// messages between the main renderer (library, device managers, sync
// engines, funscript, editor, heatmap) and the player renderer (the
// detached <video> + local controls). Both import this module so the
// message-type constants live in exactly one place.
//
// Wire shape (mirrors editor/audience pop-out protocols):
//   `{ type: 'message', payload: { type: '<msg-type>', ... } }`
//
// Architecture (SCOPE-separate-player-window.md §9): the player window is
// treated like an external playback source (à la a VR headset). It owns
// the only <video>; it STREAMS its clock up to main, where an
// IPCPlaybackProxy feeds the sync engines (Phase 2c). Main relays load +
// external-seek commands DOWN. The full type set is defined here up front
// so the protocol is stable across the 2a→2d increments even though 2a
// only exercises the handshake (READY / INITIAL_STATE / THEME / LOCALE).

// ── Main → pop-out ─────────────────────────────────────────────────────
// First hello: full snapshot. In 2a `video` is null (shell only).
//   { type, theme, locale, video: { src, title, timeMs, paused, rate,
//     durationMs, volume, muted } | null }
export const INITIAL_STATE = 'initial-state';
// Load / switch the video shown in the player window (2b).
//   { type, src, title, timeMs, autoplay }
export const LOAD_VIDEO    = 'load-video';
// External seek relayed down (heatmap click, chapter/bookmark jump,
// editor seek, gap-skip) — the player applies it to its <video> (2c/2d).
//   { type, timeMs }
export const SEEK          = 'seek';
// Main asks the player to play / pause (e.g. cloud-upload gate) (2c).
//   { type, paused }
export const SET_PLAY_STATE = 'set-play-state';
// Playback-rate / volume relayed down when changed from a main-side UI.
export const SET_RATE      = 'set-rate';      // { type, rate }
export const SET_VOLUME    = 'set-volume';    // { type, volume, muted }
// Request a current-frame screenshot from the player (2d).
export const CAPTURE_FRAME = 'capture-frame'; // { type, requestId }
// Funscript-driven overlays streamed down for the reused ProgressBar +
// variant selector (the data lives in main with the devices).
export const HEATMAP       = 'heatmap';       // { type, actions, durationMs }
export const CHAPTERS      = 'chapters';       // { type, chapters, bookmarks, durationMs }
export const VARIANTS      = 'variants';       // { type, list:[{label,path}], activeLabel }
export const QUEUE_STATE   = 'queue-state';    // { type, hasPrev, hasNext, label }
// Up Next overlay, mirrored into the pop-out so the countdown card shows
// where the video actually is. `action` selects the sub-event; the engine
// lives in main (with the queue + funscript), the card is a pure view.
//   show:  { type, action:'show', path, name, duration, hasFunscript, countdownSec }
//   thumb: { type, action:'thumb', path, thumbDataUrl }
//   tick:  { type, action:'tick', remaining }
//   end:   { type, action:'end', sourceLabel }
//   hide:  { type, action:'hide' }
export const UP_NEXT       = 'up-next';
export const THEME         = 'theme';         // { type, theme }
export const LOCALE        = 'locale';        // { type, locale }

// ── Pop-out → main ─────────────────────────────────────────────────────
export const READY         = 'ready';         // { type }
// High-frequency clock tick that drives the IPCPlaybackProxy (2c).
//   { type, timeMs, paused, rate }
export const TIME_TICK     = 'time-tick';
// Discrete <video> events the proxy re-dispatches to the sync engines.
//   { type, event: 'play'|'pause'|'seeked'|'ended', timeMs }
export const VIDEO_EVENT   = 'video-event';
// Video metadata on load / change.
//   { type, src, durationMs, width, height }
export const VIDEO_META    = 'video-meta';
// User asked to fold the player back to the main window (Expand/close).
export const REQUEST_EXPAND = 'request-expand';
// Variant selector click → main performs the switch + streams fresh data.
export const SWITCH_VARIANT = 'switch-variant'; // { type, label }
// Queue navigation from the player window's prev/next controls.
export const LOAD_NEXT     = 'load-next';      // { type }
export const LOAD_PREV     = 'load-prev';      // { type }
// Up Next card interaction relayed up (the engine that owns the countdown
// lives in main). `action`: 'play' | 'dismiss' | 'pause' | 'resume' | 'back'.
export const UP_NEXT_ACTION = 'up-next-action'; // { type, action }
// Reply to CAPTURE_FRAME with a data URL (2d).
export const FRAME_CAPTURED = 'frame-captured'; // { type, requestId, dataUrl }

/**
 * Build an inner message payload. The window-module `relay()` wraps it in
 * the `{ type: 'message', payload }` envelope before dispatch.
 */
export function makeMessage(type, fields = {}) {
  return { type, ...fields };
}

/**
 * Validate an incoming payload. Returns the type string or `null`.
 */
export function classifyMessage(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    return null;
  }
  return payload.type;
}

/** Every known message type — for tests + dev-time unknown-type warnings. */
export const ALL_MESSAGE_TYPES = Object.freeze([
  INITIAL_STATE, LOAD_VIDEO, SEEK, SET_PLAY_STATE, SET_RATE, SET_VOLUME,
  CAPTURE_FRAME, HEATMAP, CHAPTERS, VARIANTS, QUEUE_STATE, UP_NEXT, THEME, LOCALE,
  READY, TIME_TICK, VIDEO_EVENT, VIDEO_META, REQUEST_EXPAND, SWITCH_VARIANT,
  LOAD_NEXT, LOAD_PREV, UP_NEXT_ACTION, FRAME_CAPTURED,
]);
