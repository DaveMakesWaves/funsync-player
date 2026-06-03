// Audience pop-out — state-sync protocol.
//
// Single broker (main process, `electron/audience-popout-window.js`)
// ferries messages between the main renderer (which owns AudienceBridge
// + the SDK sessions) and the pop-out renderer (the management UI).
// Both renderers import this module so they share the same message-type
// constants — exactly one place to add / rename / version a message.
//
// Wire shape (mirrors editor-popout-protocol):
//   `{ type: 'message', payload: { type: '<msg-type>', ... } }`
//
// Architectural decision (SCOPE §3.3): authoritative state lives in the
// main renderer. The pop-out is a thin client — it sends commands and
// receives state updates. Closing the pop-out does NOT touch state;
// re-opening renders fresh from the next INITIAL_STATE.
//
// ## Message types
//
// ### Main → pop-out
//
// - `INITIAL_STATE` — pop-out's first hello receives the full snapshot:
//     { type, roomActive, viewers, hideKeys, theme }
//   where `viewers` is an array of viewer snapshots: { key, label,
//   offsetMs, status, rtdMs, lastError, muted }.
// - `VIEWER_ADDED` — a new viewer joined the room:
//     { type, viewer }
// - `VIEWER_REMOVED` — a viewer was removed:
//     { type, key }
// - `VIEWER_STATUS` — per-viewer status / RTD change (high-frequency):
//     { type, key, status, rtdMs, lastError }
// - `VIEWER_OFFSET` — confirmation of a setOffset (echo to keep the
//   slider value in sync if multiple sources can mutate it):
//     { type, key, offsetMs }
// - `HIDE_KEYS_CHANGED` — streamer toggled the panel-wide setting:
//     { type, hideKeys }
// - `THEME` — dark / light theme flipped:
//     { type, theme }
//
// ### Pop-out → main
//
// - `READY` — pop-out loaded, ready to receive INITIAL_STATE.
//     { type }
// - `ADD_VIEWER` — user pasted a key + clicked Add:
//     { type, key, label, offsetMs }
// - `REMOVE_VIEWER` — user clicked × on a row:
//     { type, key, forget }
// - `SET_OFFSET` — slider moved:
//     { type, key, offsetMs }
// - `SET_MUTED` — mute toggle pressed:
//     { type, key, muted }
// - `TEST_BUZZ` — Test buzz on one viewer:
//     { type, key }
// - `TEST_BUZZ_ALL` — Test buzz on all viewers:
//     { type }
// - `SET_HIDE_KEYS` — Hide-keys toggle:
//     { type, hideKeys }
// - `END_ROOM` — user clicked End Room (in pop-out or main tab):
//     { type }
//
// ## Batching
//
// `OP_BEGIN_BATCH` / `OP_END_BATCH` wrap a stream of related updates
// so the pop-out can defer re-render until the batch closes. Used when
// fanning out multi-viewer status changes (e.g. all viewers transition
// CALIBRATING → PLAYING during syncTimeAll). Mirrors the editor-popout
// pattern.

// Main → pop-out
export const INITIAL_STATE     = 'initial-state';
export const VIEWER_ADDED      = 'viewer-added';
export const VIEWER_REMOVED    = 'viewer-removed';
export const VIEWER_STATUS     = 'viewer-status';
export const VIEWER_OFFSET     = 'viewer-offset';
export const HIDE_KEYS_CHANGED = 'hide-keys-changed';
export const THEME             = 'theme';

// Pop-out → main
export const READY          = 'ready';
export const ADD_VIEWER     = 'add-viewer';
export const REMOVE_VIEWER  = 'remove-viewer';
export const SET_OFFSET     = 'set-offset';
export const SET_MUTED      = 'set-muted';
export const TEST_BUZZ      = 'test-buzz';
export const TEST_BUZZ_ALL  = 'test-buzz-all';
export const SET_HIDE_KEYS  = 'set-hide-keys';
export const END_ROOM       = 'end-room';

// Batch markers
export const OP_BEGIN_BATCH = 'begin-batch';
export const OP_END_BATCH   = 'end-batch';

/**
 * Wrap a payload in the canonical envelope shape so both sides agree on
 * the outer structure even before they handshake on inner types.
 * `audience-popout-window.js::relay` strips the envelope before dispatch.
 *
 * @param {string} type — inner message type (one of the constants above)
 * @param {object} [fields] — additional payload fields merged in
 * @returns {{type: string} & object}
 */
export function makeMessage(type, fields = {}) {
  return { type, ...fields };
}

/**
 * Validate that an incoming payload looks like one of our messages.
 * Returns the type string or `null` if invalid. Used at the dispatch
 * boundary so a malformed message logs a warning instead of crashing
 * the handler chain.
 */
export function classifyMessage(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    return null;
  }
  return payload.type;
}

/**
 * Enumeration of every known message type — useful for tests that want
 * to assert "every message we send is one of these" or for a dev-time
 * warning if an unknown type slips through the wire.
 */
export const ALL_MESSAGE_TYPES = Object.freeze([
  INITIAL_STATE, VIEWER_ADDED, VIEWER_REMOVED, VIEWER_STATUS, VIEWER_OFFSET,
  HIDE_KEYS_CHANGED, THEME,
  READY, ADD_VIEWER, REMOVE_VIEWER, SET_OFFSET, SET_MUTED, TEST_BUZZ,
  TEST_BUZZ_ALL, SET_HIDE_KEYS, END_ROOM,
  OP_BEGIN_BATCH, OP_END_BATCH,
]);
