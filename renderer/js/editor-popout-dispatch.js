// Editor pop-out — the parent's EDIT_OP dispatch.
//
// The pop-out window sends EDIT_OPs (editor-popout-protocol.js) and the
// parent applies each one to its real EditableScript HERE. Per locked
// decision §4.3 α the parent is the single source of truth: pop-out
// gestures funnel through this switch, and the editor's `_onScriptChanged`
// hook broadcasts ACTIONS_CHANGED after every mutation so the pop-out's
// local view re-syncs.
//
// One module, two importers: `ScriptEditor._applyPopoutEdit` and
// tests/unit/editor-popout-edit-ops.test.js. The routing test used to run a
// COPY of this switch, and the copy drifted: it had no OP_PASTE_ORIGINAL
// case while the parent called `es.pasteOriginal?.()` (EditableScript has
// `pasteExact`), so the pop-out's Ctrl+Shift+V did nothing and every test
// stayed green (2026-11-04).
//
// Pure: no DOM and no toasts. What needs the editor comes in through `host`.
// Unknown ops log and do nothing (defensive against a pop-out that is newer
// than its parent). A method that does not exist must be called PLAINLY, not
// with `?.()`, so a rename throws and is logged instead of vanishing.

import { halfSpeed, doubleSpeed, reverseActions, fadeIn, fadeOut, vibrateBetween } from './script-modifiers.js';
import { PATTERN_SPEED_CEILING } from './pattern-library.js';
import {
  OP_INSERT, OP_DELETE, OP_UPDATE, OP_SELECT, OP_SELECT_ALL, OP_CLEAR_SELECTION,
  OP_INVERT, OP_UNDO, OP_REDO, OP_CUT, OP_PASTE, OP_PASTE_ORIGINAL,
  OP_EQUALIZE, OP_SELECT_LEFT_OF, OP_SELECT_RIGHT_OF,
  OP_INSERT_ALTERNATING, OP_REPEAT_LAST_STROKE, OP_MOVE_SELECTED_TO,
  OP_ADD_BOOKMARK, OP_REMOVE_BOOKMARK, OP_BEGIN_BATCH, OP_END_BATCH,
  OP_COPY, OP_SELECT_BY_POSITION, OP_MOVE_ACTIONS, OP_APPLY_MODIFIER,
  OP_SELECT_CREATED, OP_SELECT_EVERY_NTH, OP_PLACE_AT, OP_FILL_RANGE, OP_RIPPLE_DELETE, OP_UNDO_STEPS, OP_REDO_STEPS,
} from './editor-popout-protocol.js';

/** The most points one OP_FILL_RANGE may carry (a 10-minute buzz fill is ~12,000). */
export const MAX_FILL_POINTS = 50000;
/** u/s of slack for whole-ms / whole-position rounding over the ceiling (the core's own envelope). */
const FILL_SPEED_SLACK = 0.5;

/**
 * An OP_FILL_RANGE payload checked, or null. The pop-out's fill must be
 * whole ms, strictly increasing, strictly inside (t0, t1), positions 0-100,
 * and not empty; mode 'replace' or 'gap'. Anything else is refused whole:
 * a fill is never trimmed into something the user did not see.
 *
 * `range: true` is a fill of a marked time range (no anchors on t0 / t1):
 * its edge points sit ON t0 and t1, so they may (inside [t0, t1]). No speed
 * check: the editor's fill has no ceiling since 2026-11-24 (Dave: "lift the
 * fill cap too"; it was PATTERN_SPEED_CEILING, 600 u/s, from 2026-11-17).
 *
 * t0 and t1 are the anchors' own times, which may be fractional (a file can
 * say "at": 1234.5; nothing rounds them on load). They are compared as they
 * are, as EditableScript.replaceRange does in the docked editor, so the two
 * editors take the same fills (review-2 minor 7: whole-ms t0 / t1 refused
 * such a script's fill in the pop-out only, with no message).
 *
 * `sig` (what the preview was built on, pattern-fill-drawer.js
 * windowSignature) and `path` (the pop-out's script) are what the parent
 * matches against its own script before it lands anything; `requestId`
 * comes back with its answer (FILL_RESULT).
 * @param {object} payload
 * @returns {{t0:number, t1:number, points:Array<{at:number,pos:number}>, mode:'replace'|'gap', patternId:string|null, options:object|null, path:string|null, sig:string, requestId:(number|string|null), range?:true}|null}
 */
export function validFillRange(payload) {
  if (!payload) return null;
  const { t0, t1, points, mode } = payload;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
  if (mode !== 'replace' && mode !== 'gap') return null;
  if (typeof payload.sig !== 'string' || !payload.sig) return null;
  if (payload.path !== null && payload.path !== undefined && typeof payload.path !== 'string') return null;
  if (!Array.isArray(points) || points.length === 0 || points.length > MAX_FILL_POINTS) return null;
  const range = payload.range === true;
  let prev = range ? -Infinity : t0;
  let last = null;
  const out = [];
  for (const p of points) {
    if (!p || !Number.isInteger(p.at) || !Number.isFinite(p.pos)) return null;
    if (p.at <= prev) return null;
    if (range ? (p.at < t0 || p.at > t1) : p.at >= t1) return null;
    if (p.pos < 0 || p.pos > 100) return null;
    const q = { at: p.at, pos: Math.round(p.pos) };
    out.push(q);
    last = q;
    prev = p.at;
  }
  const id = payload.requestId;
  return {
    t0, t1, points: out, mode,
    patternId: typeof payload.patternId === 'string' ? payload.patternId : null,
    options: payload.options && typeof payload.options === 'object' ? payload.options : null,
    path: typeof payload.path === 'string' ? payload.path : null,
    sig: payload.sig,
    requestId: Number.isFinite(id) || typeof id === 'string' ? id : null,
    // Only on a range fill: an anchor fill keeps its shape.
    ...(range ? { range: true } : {}),
  };
}

// The SAME function references the docked Modify menu uses, so
// EditableScript's contiguity guard (SEQUENCE_MODIFIERS) recognises them.
// Keys are the protocol values the pop-out sends ('reverse'), NOT the JS
// export names.
const POPOUT_MODIFIERS = { halfSpeed, doubleSpeed, reverse: reverseActions, fadeIn, fadeOut, vibrate: vibrateBetween };

/**
 * Apply one EDIT_OP from the pop-out to the parent's EditableScript.
 *
 * @param {import('./editable-script.js').EditableScript} es
 * @param {{op: string}} payload — `{ type: EDIT_OP, op, ...args }`
 * @param {object} host — the parent editor's hooks:
 *   - `reportModifierResult(status, name)` toasts a refused or no-op
 *     modifier (a success stays silent on this route, as it always was)
 *   - `selectCreated()` — New points only, with its toast
 *   - `selectEveryNth(n, start)` — Every Nth point, with its toast
 *   - `placeAt(pos, at)` — a position key: the docked editor's place-or-tweak
 *   - `fillRange(fill)` — a checked Fill with pattern (validFillRange): lands
 *     it with replaceRange when it was built on this script, remembers its
 *     options, toasts the outcome and answers the pop-out (FILL_RESULT)
 *   - `fillRefused(payload)` — an OP_FILL_RANGE that is not a valid fill:
 *     says so and answers the pop-out, which keeps its drawer open
 *   The toasting hooks show their toast in the pop-out (FT-029).
 */
export function applyPopoutEdit(es, payload, host) {
  if (!es || !payload) return;
  const op = payload.op;
  try {
    switch (op) {
      case OP_INSERT:
        es.insertAction(payload.at, payload.pos);
        break;
      case OP_DELETE:
        if (Array.isArray(payload.indices)) {
          es.deleteActions(new Set(payload.indices));
        } else {
          es.deleteActions(es.selectedIndices);
        }
        break;
      case OP_UPDATE:
        if (typeof payload.idx === 'number') {
          es.updateAction(payload.idx, payload.fields || {});
        }
        break;
      case OP_SELECT:
        if (Array.isArray(payload.indices)) {
          es._selectedIndices = new Set(payload.indices);
          es._emit?.();
        }
        break;
      case OP_SELECT_ALL:
        es.selectAll();
        break;
      case OP_CLEAR_SELECTION:
        es.clearSelection();
        break;
      case OP_INVERT:
        es.invertSelection();
        break;
      case OP_UNDO:
        es.undo();
        break;
      case OP_REDO:
        es.redo();
        break;
      case OP_CUT:
        es.cut?.();
        break;
      case OP_PASTE:
        es.paste?.(payload.at);
        break;
      case OP_PASTE_ORIGINAL:
        // The pop-out's Ctrl+Shift+V. Called plainly: see the header.
        es.pasteExact();
        break;
      case OP_EQUALIZE:
        es.equalizeSelected?.();
        break;
      case OP_SELECT_LEFT_OF:
        es.selectLeftOfCursor?.(payload.time);
        break;
      case OP_SELECT_RIGHT_OF:
        es.selectRightOfCursor?.(payload.time);
        break;
      case OP_INSERT_ALTERNATING:
        es.insertAlternating?.(payload.at);
        break;
      case OP_REPEAT_LAST_STROKE:
        es.repeatLastStroke?.(payload.at);
        break;
      case OP_MOVE_SELECTED_TO:
        es.moveSelectedToTime?.(payload.time);
        break;
      case OP_ADD_BOOKMARK:
        es.addBookmark?.(payload.at, payload.name);
        break;
      case OP_REMOVE_BOOKMARK:
        // EditableScript.removeBookmark keys by `at` (timeMs), not by id.
        es.removeBookmark?.(payload.at);
        break;
      case OP_BEGIN_BATCH:
        // Wraps a drag-style edit stream so the entire drag is one
        // undo step. Throttled OP_UPDATEs inside this window collapse.
        es.beginBatch?.();
        break;
      case OP_END_BATCH:
        es.endBatch?.();
        break;
      case OP_COPY:
        es.copy?.();
        break;
      case OP_SELECT_BY_POSITION:
        es.selectByPositionRange?.(payload.minPos, payload.maxPos);
        break;
      case OP_MOVE_ACTIONS:
        // {indices?, deltaAt?, deltaPos?} — indices defaults to current
        // selection, mirroring docked editor's nudge / move semantics.
        es.moveActions?.(
          Array.isArray(payload.indices) ? new Set(payload.indices) : es.selectedIndices,
          payload.deltaAt || 0,
          payload.deltaPos || 0,
        );
        break;
      case OP_APPLY_MODIFIER: {
        // Direct (param-less) modifiers — halfSpeed / doubleSpeed / reverse.
        // A refusal or no-op is toasted by the host (in the parent window,
        // like the modals the pop-out opens); a success stays silent.
        const name = payload.name;
        const fn = POPOUT_MODIFIERS[name];
        // One options object at most (Vibrate's size / rate / taper / cap); the
        // modifier clamps every value itself.
        const args = Array.isArray(payload.args) && payload.args[0] && typeof payload.args[0] === 'object' ? [payload.args[0]] : [];
        if (fn) host.reportModifierResult(es.applyModifier(fn, ...args), name);
        break;
      }
      case OP_UNDO_STEPS:
        // The pop-out's undo history menu: several steps at once (work list 4.5).
        es.undoSteps?.(payload.steps);
        break;
      case OP_REDO_STEPS:
        es.redoSteps?.(payload.steps);
        break;
      case OP_RIPPLE_DELETE:
        // Shift+Del / Modify > Ripple delete in the pop-out; the toast goes there.
        host.rippleDelete?.();
        break;
      case OP_SELECT_CREATED:
        // N in the pop-out. The created record lives in THIS EditableScript;
        // the new selection reaches the pop-out through ACTIONS_CHANGED.
        host.selectCreated();
        break;
      case OP_SELECT_EVERY_NTH:
        // The Select of the pop-out's own Every Nth dialog (FT-029).
        host.selectEveryNth(payload.n, payload.start);
        break;
      case OP_PLACE_AT:
        // A position key in the pop-out (FT-032). It used to send OP_INSERT,
        // so a second press on the same frame stacked a duplicate point where
        // the docked editor moves the selected one.
        if (Number.isFinite(payload.pos)) {
          host.placeAt(Math.max(0, Math.min(100, Math.round(payload.pos))), payload.at);
        }
        break;
      case OP_FILL_RANGE: {
        // The pop-out drawer's Apply (Fill with pattern). Checked here, landed
        // by the host as one undo step (EditableScript.replaceRange), so the
        // parent's script, undo stack and autosave stay the only ones.
        const fill = validFillRange(payload);
        if (fill) {
          host.fillRange(fill);
        } else {
          console.debug('[Editor] popout fillRange refused: not a valid fill');
          host.fillRefused(payload);
        }
        break;
      }
      default:
        console.debug('[Editor] unknown popout edit-op:', op);
    }
  } catch (err) {
    console.warn('[Editor] popout edit-op failed:', op, err);
  }
}
