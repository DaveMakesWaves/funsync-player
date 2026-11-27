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
// Loop the current video. Sent when the pop-out takes over (so a video
// looped inline stays looped) and for Shift+L pressed in the main window.
export const SET_LOOP      = 'set-loop';      // { type, loop }
// Request a current-frame screenshot from the player (2d).
export const CAPTURE_FRAME = 'capture-frame'; // { type, requestId }
// Funscript-driven overlays streamed down for the reused ProgressBar +
// variant selector (the data lives in main with the devices).
export const HEATMAP       = 'heatmap';       // { type, actions, durationMs }
export const CHAPTERS      = 'chapters';       // { type, chapters, bookmarks, durationMs }
export const VARIANTS      = 'variants';       // { type, list:[{label,path,text}], activeLabel, activeText? (no entry plays) }
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
// Settings > Playback changed the HM playhead marker or the overlay opacity
// while the pop-out is open (FT-028). Applied there, never echoed back.
// INITIAL_STATE still carries both for a fresh open.
//   { type, playhead: boolean, opacity: number (percent, 20-100) }
export const INLINE_VIZ_STATE = 'inline-viz-state';
// The video's subtitles (2026-11-22: the pop-out showed none). Sent when the
// main window loads or clears them, and with every video it hands over.
//   { type, name, text }  — the subtitle file's name (.srt / .vtt) and text
//   { type, name: null }  — no subtitles
export const SUBTITLE      = 'subtitle';

// ── Pop-out → main ─────────────────────────────────────────────────────
export const READY         = 'ready';         // { type }
// High-frequency clock tick that drives the IPCPlaybackProxy (2c).
//   { type, timeMs, paused, stalled, rate, loop }
// `paused` is the element's own flag; `stalled` (N-01) is true while it is
// not paused but the picture cannot move (starved, seeking, failed, or a
// time frozen for a second). Main's proxy treats either as paused for the
// devices. Also sent at once on every stall boundary, not only every 100 ms.
export const TIME_TICK     = 'time-tick';
// Discrete <video> events the proxy re-dispatches to the sync engines.
//   { type, event: 'play'|'pause'|'seeked'|'ended', timeMs }
// 'volumechange' carries { volume, muted } instead: main keeps the saved
// volume in step with the pop-out's slider and its own volume keys.
export const VIDEO_EVENT   = 'video-event';
// Video metadata on load / change.
//   { type, src, durationMs, width, height }
export const VIDEO_META    = 'video-meta';
// User asked to fold the player back to the main window (Expand/close).
export const REQUEST_EXPAND = 'request-expand';
// Variant selector click → main performs the switch + streams fresh data.
export const SWITCH_VARIANT = 'switch-variant'; // { type, label }
// Pop-out toggled a TL/HM inline visualisation. Main owns the settings
// store, so it persists the flag and mirrors it onto its own overlay —
// the two windows stay in step and the choice survives a restart.
//   { type, key: 'timeline'|'heatmap', on: boolean }
export const SET_INLINE_VIZ = 'set-inline-viz';
// Queue navigation from the player window's prev/next controls.
export const LOAD_NEXT     = 'load-next';      // { type }
export const LOAD_PREV     = 'load-prev';      // { type }
// Up Next card interaction relayed up (the engine that owns the countdown
// lives in main). `action`: 'play' | 'dismiss' | 'pause' | 'resume' | 'back'.
export const UP_NEXT_ACTION = 'up-next-action'; // { type, action }
// Reply to CAPTURE_FRAME with a data URL (2d).
export const FRAME_CAPTURED = 'frame-captured'; // { type, requestId, dataUrl }
// X (Orgasm Switch) and Z (Edge Hold) pressed and let go in the player
// window (next major, Dave 2026-11-17). Main calls the handlers its own
// keyboard calls (_onOrgasmHold / _onEdgeHold), which apply hold or toggle
// as set. `active` is true on the press (once: auto-repeat is not sent)
// and false on the key's release.
export const ORGASM_HOLD   = 'orgasm-hold';    // { type, active }
export const EDGE_HOLD     = 'edge-hold';      // { type, active }
// Main -> player window: the note shown while Z is kept on into a new video
// (lr_x3 #447, edge-hold-carry.js), or none (`text` null).
export const EDGE_NOTICE   = 'edge-notice';    // { type, text }
// Shift+Space in the player window (2026-11-23, DESIGN.md §2.15): main runs
// Stop all, as for its own Shift+Space.
export const STOP_ALL      = 'stop-all';       // { type }

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
  INITIAL_STATE, LOAD_VIDEO, SEEK, SET_PLAY_STATE, SET_RATE, SET_VOLUME, SET_LOOP,
  CAPTURE_FRAME, HEATMAP, CHAPTERS, VARIANTS, QUEUE_STATE, UP_NEXT, THEME, LOCALE,
  READY, TIME_TICK, VIDEO_EVENT, VIDEO_META, REQUEST_EXPAND, SWITCH_VARIANT,
  LOAD_NEXT, LOAD_PREV, UP_NEXT_ACTION, FRAME_CAPTURED, SET_INLINE_VIZ, INLINE_VIZ_STATE,
  ORGASM_HOLD, EDGE_HOLD, EDGE_NOTICE, SUBTITLE, STOP_ALL,
]);
