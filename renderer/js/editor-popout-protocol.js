// Editor pop-out — state-sync protocol.
//
// Single broker (main process) ferries messages between the docked
// parent and the pop-out child. Both renderers import this module so
// they share the same message-type constants — there is exactly one
// place to add / rename / version a message type.
//
// Wire shape: `{ type: 'message', payload: { type: '<msg-type>', ... } }`
// — the outer envelope comes from `editor-popout-window.js::relay`; this
// file defines the inner `payload.type` values and the field-level
// contract for each.
//
// ## Message types
//
// ### Parent → Pop-out (initial state + ongoing updates)
//
// - `INITIAL_STATE` — pop-out's first hello receives the full snapshot:
//     { type, scripts, activePath, videoSrc, videoDuration, videoTime,
//       videoPaused, videoRate, splineMode, snapToFrame }
// - `TIME_TICK` — RAF-throttled video position update (~30 Hz):
//     { type, time, paused }
// - `VIDEO_META` — video-element metadata change (load, src swap, duration discovery):
//     { type, src, duration, rate }
// - `SCRIPTS_CHANGED` — list of available scripts changed (multi-axis
//   companions appeared / disappeared):
//     { type, scripts, activePath }
// - `ACTIONS_CHANGED` — parent's EditableScript mutated outside the
//   pop-out (e.g. a sync engine reloaded, undo from main, autosave
//   wrote a stale path). Pop-out re-renders from the new snapshot:
//     { type, path, actions, selectedIndices, bookmarks }
//
// ### Pop-out → Parent (commands)
//
// - `READY` — pop-out finished loading, ready to receive INITIAL_STATE.
//     { type }
// - `VIDEO_SEEK` — pop-out seeks the parent's video element. The parent
//   updates `video.currentTime` and the next TIME_TICK reflects it:
//     { type, time }
// - `VIDEO_PLAY` / `VIDEO_PAUSE` — control the parent's video:
//     { type }
// - `VIDEO_STEP_FRAME` — single-frame step (Left / Right arrows):
//     { type, direction }   // direction: +1 or -1
// - `VIDEO_STEP_FRAMES` — fast frame step (Ctrl+Left / Right):
//     { type, frames }
// - `SCRIPT_SWITCH` — user picked a different script in the dropdown:
//     { type, path }
// - `EDIT_OP` — single edit operation. Parent applies to its real
//   EditableScript; the broadcast that echoes back as ACTIONS_CHANGED
//   keeps both windows in sync without the pop-out maintaining its own
//   authoritative state:
//     { type, op, ...args }   // op: 'insert', 'delete', 'update', 'selectAll', 'invert', 'simplify', 'undo', 'redo', 'cut', 'paste', 'pasteOriginal', etc.
// - `SAVE` — autosave or manual save trigger. Parent's autosave path
//   handles the disk write so file ownership stays in one place:
//     { type }
// - `DEVICE_PREVIEW` — push a position to the Handy / Buttplug device
//   while placing actions in the pop-out (live haptic feedback while
//   editing). Parent fans out to whichever device managers exist:
//     { type, pos }   // pos: 0–100
//
// ## Open questions (deferred)
// - Two-way undo stack — main's EditableScript owns undo today; pop-out
//   sends EDIT_OP, parent applies + broadcasts back. Undo issued in
//   pop-out goes UNDO → parent.undo() → ACTIONS_CHANGED. Pop-out never
//   maintains its own undo stack. Verified compatible with the cached-
//   per-path undo model in script-editor.js.
// - Conflict resolution — pop-out edit + main edit at the same instant.
//   Locked decision §4.3 α: pop-out takes full ownership. Main's editor
//   panel is hidden while pop-out is open, so the only edits that can
//   land on main are from sync engines reloading on video change.
//   ACTIONS_CHANGED broadcasts handle that case.
// - Throttling — TIME_TICK at 30 Hz is fine for cursor sync but may be
//   overkill for non-playback states (paused, scrubbing). Future tuning
//   if profiling shows IPC pressure.

// Parent → pop-out
export const INITIAL_STATE   = 'initial-state';
export const TIME_TICK       = 'time-tick';
export const VIDEO_META      = 'video-meta';
export const SCRIPTS_CHANGED = 'scripts-changed';
export const ACTIONS_CHANGED = 'actions-changed';
export const THEME           = 'theme';   // { type, theme: 'dark' | 'light' }

// Pop-out → parent
export const READY             = 'ready';
export const VIDEO_SEEK        = 'video-seek';
export const VIDEO_PLAY        = 'video-play';
export const VIDEO_PAUSE       = 'video-pause';
export const VIDEO_STEP_FRAME  = 'video-step-frame';
export const VIDEO_STEP_FRAMES = 'video-step-frames';
export const SCRIPT_SWITCH     = 'script-switch';
export const EDIT_OP           = 'edit-op';
export const SAVE              = 'save';
export const DEVICE_PREVIEW    = 'device-preview';

// EDIT_OP `op` field values — every mutation through the relay names
// the operation here. Parent's `_applyPopoutEdit` switch must handle
// every value we export. Adding a new op = add the constant, add a
// case in the parent switch, add a producer on the pop-out side.
export const OP_INSERT             = 'insert';
export const OP_DELETE             = 'delete';
export const OP_UPDATE             = 'update';
export const OP_SELECT             = 'select';
export const OP_SELECT_ALL         = 'selectAll';
export const OP_CLEAR_SELECTION    = 'clearSelection';
export const OP_INVERT             = 'invert';
export const OP_UNDO               = 'undo';
export const OP_REDO               = 'redo';
export const OP_CUT                = 'cut';
export const OP_PASTE              = 'paste';
export const OP_PASTE_ORIGINAL     = 'pasteOriginal';
export const OP_EQUALIZE           = 'equalize';
export const OP_SELECT_LEFT_OF     = 'selectLeftOf';
export const OP_SELECT_RIGHT_OF    = 'selectRightOf';
export const OP_INSERT_ALTERNATING = 'insertAlternating';
export const OP_REPEAT_LAST_STROKE = 'repeatLastStroke';
export const OP_MOVE_SELECTED_TO   = 'moveSelectedToTime';
export const OP_ADD_BOOKMARK       = 'addBookmark';
export const OP_REMOVE_BOOKMARK    = 'removeBookmark';

// Batch markers — wrap a drag's stream of OP_UPDATEs so the entire
// drag collapses into a single undo step. Same shape as
// EditableScript.beginBatch / endBatch.
export const OP_BEGIN_BATCH        = 'beginBatch';
export const OP_END_BATCH          = 'endBatch';

// Tier-A parity additions (parity audit 2026-05-23):
export const OP_COPY                  = 'copy';                  // Ctrl+C
export const OP_SELECT_BY_POSITION    = 'selectByPositionRange'; // Ctrl+1/2/3 → { minPos, maxPos }
export const OP_APPLY_MODIFIER        = 'applyModifier';         // { name: 'halfSpeed'|'doubleSpeed'|'reverse' }
export const OP_MOVE_ACTIONS          = 'moveActions';           // { indices?, deltaAt?, deltaPos? }

// Parent → pop-out additions: settings that affect rendering or
// input interpretation (snap-to-frame, spline mode, recording mode,
// playback rate). Broadcast on settings change so the pop-out stays
// coherent with the docked editor's state.
export const SETTINGS                 = 'settings';              // { snapToFrame, splineMode, recordingMode, playbackRate, ... }

// Pop-out → parent: requests that open one of the docked editor's
// existing modals. Mounting those modals inside a second renderer is
// a separate refactor; for now we surface the trigger in the pop-out
// toolbar and the modal opens in the parent window (which is visible
// since the user just clicked the pop-out's button).
export const REQUEST_METADATA         = 'request-metadata';
export const REQUEST_FILL_GAPS        = 'request-fill-gaps';
export const REQUEST_BEATS            = 'request-beats';
export const REQUEST_SIMPLIFY         = 'request-simplify';
export const REQUEST_REMAP_RANGE      = 'request-remap-range';
export const REQUEST_OFFSET_TIME      = 'request-offset-time';
export const REQUEST_REMOVE_PAUSES    = 'request-remove-pauses';
export const REQUEST_RANGE_EXTEND     = 'request-range-extend';
export const REQUEST_GENERATE_PATTERN = 'request-generate-pattern';
export const REQUEST_EXPORT_HEATMAP   = 'request-export-heatmap';
export const REQUEST_TOGGLE_WAVEFORM  = 'request-waveform-toggle';

// Pop-out → parent: settings the user can flip in the pop-out
// (snap-to-frame checkbox, spline/curves checkbox, R recording mode,
// speed dropdown). Forwarded to the parent so the docked editor and
// pop-out stay in lockstep.
export const SET_SETTING              = 'set-setting';           // { key, value }
export const VIDEO_SET_RATE           = 'video-set-rate';        // { rate }

/**
 * Build an EDIT_OP payload. The parent's `_handlePopoutMessage` routes
 * `type: EDIT_OP` to `_applyPopoutEdit`, which dispatches on `op`.
 */
export function editOp(op, fields = {}) {
  return { type: EDIT_OP, op, ...fields };
}

/**
 * Tag a payload with its type. Tiny helper to keep callsites readable.
 * Usage: `relay('to-popout', msg(TIME_TICK, { time, paused }))`.
 */
export function msg(type, fields = {}) {
  return { type, ...fields };
}
