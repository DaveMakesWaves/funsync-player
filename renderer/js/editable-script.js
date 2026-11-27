// EditableScript — Mutable funscript action array with undo/redo, selection, clipboard

import { parseFunscriptTime } from './funscript-time.js';
import * as Modifiers from './script-modifiers.js';

const { halfSpeed, doubleSpeed, reverseActions, removePauses, rangeExtend } = Modifiers;

/**
 * What each undo step is called in the undo history menu (editor work list
 * 4.5, 2026-11-24). Every undo / redo entry carries one of these locale keys
 * plus its ICU params ({count} where the count is known); the menu
 * translates them when it opens, so a language switch never leaves stale
 * text in the history. This module stays free of i18n: keys only.
 */
export const HISTORY_LABELS = Object.freeze({
  insert: 'editor.history.insert',
  editPoint: 'editor.history.editPoint',
  delete: 'editor.history.delete',
  cut: 'editor.history.cut',
  rippleDelete: 'editor.history.rippleDelete',
  move: 'editor.history.move',
  drag: 'editor.history.drag',
  moveToPlayhead: 'editor.history.moveToPlayhead',
  paste: 'editor.history.paste',
  pasteExact: 'editor.history.pasteExact',
  equalize: 'editor.history.equalize',
  invert: 'editor.history.invert',
  simplify: 'editor.history.simplify',
  modify: 'editor.history.modify',
  insertPoints: 'editor.history.insertPoints',
  generatePattern: 'editor.history.generatePattern',
  beats: 'editor.history.beats',
  fillGaps: 'editor.history.fillGaps',
  fill: 'editor.history.fill',
  metadata: 'editor.history.metadata',
  addBookmark: 'editor.history.addBookmark',
  removeBookmark: 'editor.history.removeBookmark',
  restore: 'editor.history.restore',
  edit: 'editor.history.edit',
});

/**
 * A modifier's undo label, from the EXPORTED function it is (editor work list
 * 4.5): matched by reference against script-modifiers.js, so the Modify menu,
 * its dialogs and the pop-out's name lookup (editor-popout-dispatch.js
 * POPOUT_MODIFIERS) all land on the same name. The keys are the Modify
 * menu's own (editor.modify.*), already in every locale; the menu strips
 * their trailing "…". A function that is not an export (a lambda) is "Modify".
 */
const MODIFIER_LABEL_KEYS = {
  halfSpeed: 'editor.modify.halfSpeed',
  doubleSpeed: 'editor.modify.doubleSpeed',
  reverseActions: 'editor.modify.reverse',
  remapRange: 'editor.modify.remapRange',
  offsetTime: 'editor.modify.offsetTime',
  removePauses: 'editor.modify.removePauses',
  rangeExtend: 'editor.modify.rangeExtend',
  fadeIn: 'editor.modify.fadeIn',
  fadeOut: 'editor.modify.fadeOut',
  vibrateBetween: 'editor.modify.vibrate',
};
const MODIFIER_LABELS = new Map(
  Object.entries(MODIFIER_LABEL_KEYS)
    .filter(([name]) => typeof Modifiers[name] === 'function')
    .map(([name, key]) => [Modifiers[name], key]),
);

/**
 * The undo label for applyModifier(fn, ...args).
 * @param {Function} fn
 * @param {Array} [args]
 * @returns {string} a locale key
 */
export function modifierLabel(fn, args = []) {
  // fadeDepth(actions, 'in' | 'out') is the one export whose name depends on an argument.
  if (fn === Modifiers.fadeDepth) return args[0] === 'out' ? MODIFIER_LABEL_KEYS.fadeOut : MODIFIER_LABEL_KEYS.fadeIn;
  return MODIFIER_LABELS.get(fn) || HISTORY_LABELS.modify;
}

/**
 * The metadata block OpenFunscripter writes (editor work list 5.3,
 * 2026-11-24): OFS-lib/Funscript/Funscript.h `struct Metadata`, serialised by
 * nlohmann::json, whose object keeps its keys in alphabetical order, so a
 * block written here reads the same as one OFS wrote. Each value is OFS's
 * empty default (type "basic", duration 0). `duration` is filled in at write
 * time (toFunscriptJSON).
 */
const OFS_METADATA_DEFAULTS = Object.freeze({
  creator: '',
  description: '',
  duration: 0,
  license: '',
  notes: '',
  performers: [],
  script_url: '',
  tags: [],
  title: '',
  type: 'basic',
  video_url: '',
});

/**
 * Modifiers that read the ORDER or SPACING of the points they are given, so
 * they only make sense on a run of neighbours. On a selection with gaps
 * (Ctrl+1/2/3, Ctrl+click) they were handed points from all over the script
 * as if they were adjacent: Double Speed on the bottoms of a zigzag wrote 6
 * duplicate timestamps, Reverse on them flattened the script at 100, Remove
 * Pauses pulled points 15 s away from their unselected partners.
 * applyModifier refuses these on a non-contiguous selection. Identified by
 * function reference, so every route (Modify menu, modals, the pop-out's
 * name lookup) gets the same guard.
 */
// Vibrate fills the gaps between neighbouring points: a run only (2026-11-24).
export const SEQUENCE_MODIFIERS = new Set([halfSpeed, doubleSpeed, reverseActions, removePauses, rangeExtend, Modifiers.vibrateBetween]);

const roundAction = (a) => ({ at: Math.round(a.at), pos: Math.round(Math.max(0, Math.min(100, a.pos))) });

// Revision ids (R4-18). Every state of the script gets its own id, and each
// undo / redo entry carries the id of the state it holds. The script is clean
// exactly while the state on screen is the one last loaded or saved: Ctrl+Z
// back to the saved point is clean again (it stayed dirty, so a close, quit or
// load asked about a script with no net change), a redo away from it is dirty,
// and a new edit after undoing past it drops the redo history, so no redo can
// return to it. Ids are unique across instances and the editor's per-script
// undo cache, so a cached entry never matches another state by accident.
let _revisionSeq = 0;
const nextRevision = () => ++_revisionSeq;

/** A whole number clamped to lo..hi; `fallback` for anything that is not a number. */
const clampWhole = (value, lo, hi, fallback) => {
  const v = Math.round(Number(value));
  if (Number.isNaN(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
};

export class EditableScript {
  constructor() {
    this._actions = [];
    this._selectedIndices = new Set();
    // The points the last modifier or generator created (applyModifier,
    // insertActions), as OBJECT REFERENCES into _actions — never indices,
    // which go stale on any insert or delete. Undo snapshots carry it as a
    // plain index array (createdIndices); see _snapshot().
    this._lastCreated = new Set();
    this._undoStack = [];
    this._redoStack = [];
    this._clipboard = [];
    this._clipboardAbsolute = [];
    this._dirty = false;
    // The state on screen, and the state last loaded or saved (R4-18).
    this._revision = nextRevision();
    this._savedRevision = this._revision;
    this._batching = false;
    // Points a drag (one batch) moved in time: what they land on is resolved
    // once, when the drag ends (endBatch), not on every mousemove (CB-02).
    this._batchMoved = new Set();
    this._batchRedo = null; // the redo stack as a batch found it (a no-op batch puts it back)
    this._maxUndoSteps = 100;
    this._metadata = {};
    this._bookmarks = [];
    // The video's length in ms, for the saved metadata block's `duration`
    // (editor work list 5.3). A property of the VIDEO, not the script, so no
    // load, clear or axis switch resets it: the editor sets it whenever the
    // video's length is known (setVideoDuration). 0 = unknown.
    this._videoDurationMs = 0;

    /** @type {Function|null} Callback fired after every mutation */
    this.onChange = null;
  }

  // --- Loading ---

  /**
   * Load actions from a FunscriptEngine instance.
   * Clones the actions array, resets undo/selection.
   */
  loadFromEngine(funscriptEngine) {
    const actions = funscriptEngine.getActions();
    this._actions = actions ? actions.map(a => ({ at: a.at, pos: a.pos })) : [];
    this._selectedIndices = new Set();
    this._lastCreated = new Set();
    this._undoStack = [];
    this._redoStack = [];
    // The clipboard stays: copy on one axis, paste on another (OFS keeps one
    // clipboard for the app; multi-axis editing, 2026-11-24).
    this._dirty = false;
    this._markLoaded();

    // Load metadata from engine (defensive — engine may not have getMetadata)
    const meta = typeof funscriptEngine.getMetadata === 'function' ? funscriptEngine.getMetadata() : null;
    if (meta) {
      this.loadMetadata(meta);
    } else {
      this._metadata = {};
      this._bookmarks = [];
    }
  }

  /**
   * Load from a parsed funscript file (the script switcher, stacked lanes,
   * the pop-out). `data` is the WHOLE file: { version, inverted, range,
   * axes, metadata: { title, tags, bookmarks, ... }, actions, ... }.
   *
   * Metadata goes through loadMetadata, the same as loadFromEngine, so
   * `_metadata` always holds the whole file minus actions — the shape
   * toFunscriptJSON writes back. It used to keep only the INNER `metadata`
   * object and copy bookmarks raw (FT-001, in v0.9.2 and earlier): a save
   * after picking a script in the switcher moved title/tags/creator to the
   * top level, forced version to "1.0", dropped top-level inverted / range /
   * axes, and wrote MFP `time: "HH:MM:SS.mmm"` bookmarks without a time.
   * @param {object} data — parsed funscript JSON
   */
  loadFromData(data) {
    this._actions = (data.actions || []).map(a => ({ at: a.at, pos: a.pos }));
    this._actions.sort((a, b) => a.at - b.at);
    this._selectedIndices = new Set();
    this._lastCreated = new Set();
    this._undoStack = [];
    this._redoStack = [];
    // The clipboard stays: copy on one axis, paste on another (OFS keeps one
    // clipboard for the app; multi-axis editing, 2026-11-24).
    this._dirty = false;
    this._markLoaded();
    this.loadMetadata(data);
  }

  /**
   * Initialize with an empty action array (create-from-scratch mode).
   */
  loadEmpty() {
    this._actions = [];
    this._selectedIndices = new Set();
    this._lastCreated = new Set();
    this._undoStack = [];
    this._redoStack = [];
    // The clipboard stays: copy on one axis, paste on another (OFS keeps one
    // clipboard for the app; multi-axis editing, 2026-11-24).
    this._dirty = false;
    this._markLoaded();
    this._metadata = {};
    this._bookmarks = [];
  }

  /**
   * Clear all state.
   */
  clear() {
    this._actions = [];
    this._selectedIndices = new Set();
    this._lastCreated = new Set();
    this._undoStack = [];
    this._redoStack = [];
    this._clipboard = [];
    this._dirty = false;
    this._markLoaded();
    this._metadata = {};
    this._bookmarks = [];
  }

  /**
   * Everything this script's editing holds, to keep one axis in memory while
   * another is on screen (multi-axis editing, 2026-11-24): the points, the
   * selection, undo / redo, the points the last modifier made, bookmarks,
   * the file's other keys, and the revision ids that say whether it has
   * unsaved edits (R4-18). A deep copy; importState() puts it back exactly.
   * The clipboard is not part of it (one clipboard for every axis), nor is
   * the video length (setVideoDuration: the video's, shared by every axis).
   * Undo / redo entries keep their history labels (`label`, `params`: plain
   * data, editor work list 4.5), so the undo history menu names an axis's
   * steps the same after a switch away and back.
   */
  exportState() {
    const created = [];
    this._actions.forEach((a, i) => { if (this._lastCreated.has(a)) created.push(i); });
    return structuredClone({
      actions: this._actions,
      selectedIndices: [...this._selectedIndices],
      createdIndices: created,
      undoStack: this._undoStack,
      redoStack: this._redoStack,
      metadata: this._metadata,
      bookmarks: this._bookmarks,
      revision: this._revision,
      savedRevision: this._savedRevision,
    });
  }

  /**
   * Put back a state from exportState(): another axis comes on screen with
   * its own points, history and unsaved edits. Counts as a load for the Fill
   * with pattern drawer (loadId), so a preview never lands on another axis.
   * @param {ReturnType<EditableScript['exportState']>} state
   */
  importState(state) {
    const s = structuredClone(state);
    this._actions = s.actions || [];
    this._selectedIndices = new Set(s.selectedIndices || []);
    this._lastCreated = new Set((s.createdIndices || []).map((i) => this._actions[i]).filter(Boolean));
    this._undoStack = s.undoStack || [];
    this._redoStack = s.redoStack || [];
    this._metadata = s.metadata || {};
    this._bookmarks = s.bookmarks || [];
    this._batching = false;
    this._batchMoved = new Set();
    this._batchRedo = null;
    this._revision = Number.isFinite(s.revision) ? s.revision : nextRevision();
    this._savedRevision = Number.isFinite(s.savedRevision) ? s.savedRevision : this._revision;
    this._syncDirtyToRevision();
    this._loadId = (this._loadId || 0) + 1;
    this._emit();
  }

  // --- Accessors ---

  get actions() { return this._actions; }
  get selectedIndices() { return this._selectedIndices; }
  get dirty() { return this._dirty; }
  get actionCount() { return this._actions.length; }
  /** The id of the state on screen (R4-18): pass it to markSaved() for the state that was written. */
  get revision() { return this._revision; }
  /**
   * Which load this is: changes on every load (engine, file, empty, clear)
   * and never on an edit, undo or selection change. The Fill with pattern
   * drawer closes when it changes, so a preview drawn on one script never
   * lands on the next (review-2 blocker).
   */
  get loadId() { return this._loadId || 0; }

  /** A fresh load: one new state, and it is the saved one (R4-18). */
  _markLoaded() {
    this._revision = nextRevision();
    this._savedRevision = this._revision;
    this._loadId = (this._loadId || 0) + 1;
  }

  /** Dirty exactly while the state on screen is not the one last loaded or saved (R4-18). */
  _syncDirtyToRevision() {
    this._dirty = this._revision !== this._savedRevision;
  }

  // --- Undo / Redo ---

  /**
   * Begin a batch — pushes undo state once, suppresses further pushes until endBatch().
   * @param {string} [label] the step's name in the undo history (editor work
   *   list 4.5): a drag by default, the only batch the editor makes today.
   * @param {object} [params]
   */
  beginBatch(label = HISTORY_LABELS.drag, params) {
    if (this._batching) return;
    // The snapshot goes BEFORE the flag: _pushState() does nothing while
    // batching, so the old order recorded nothing and a drag was no undo
    // step at all; Ctrl+Z after a drag went back past the edit before it
    // (found with CB-02, also in v0.9.2).
    this._batchRedo = this._redoStack;
    this._pushState(label, params);
    this._batching = true;
  }

  /** End a batch — current state is the post-batch result. */
  endBatch() {
    if (!this._batching) return;
    this._batching = false;
    // A drag ends where it ends: a point it dropped on another's time takes
    // that time now (CB-02). Resolving on every mousemove would have eaten
    // every point the drag merely passed over.
    const moved = this._batchMoved;
    this._batchMoved = new Set();
    const redo = this._batchRedo;
    this._batchRedo = null;
    if (moved.size > 0) {
      const selected = this._selectedRefs();
      if (this._dropCollisions(moved)) {
        this._reselect(selected);
        this._emit();
      }
    }
    // A batch that changed nothing (a Shift+click on a point, no move)
    // leaves no undo step and keeps the redo history.
    const top = this._undoStack[this._undoStack.length - 1];
    if (top && redo && top.actions.length === this._actions.length
        && top.actions.every((a, i) => a.at === this._actions[i].at && a.pos === this._actions[i].pos)) {
      this._undoStack.pop();
      this._redoStack = redo;
      // Still the state from before the batch: its id, and clean again when
      // that one was saved (R4-18).
      if (Number.isFinite(top.revision)) {
        this._revision = top.revision;
        this._syncDirtyToRevision();
      }
    }
  }

  // --- One point per timestamp (CB-02) ---
  //
  // OFS's add-or-edit rule: the editor never holds two points at one time
  // (OFS keeps actions in a set ordered by time). An insert on an occupied
  // time edits that point (insertAction), and an edit that lands points on
  // occupied times (paste, a modifier, a generator, a move, Equalize) keeps
  // the points it moved or made and removes the others there. Only EDITS
  // enforce it: a file that already has duplicates loads as it is and is
  // never rewritten for that; an edit only resolves the times it touched.

  /** Index of the first action at or after `at` (actions sorted by time). */
  _lowerBound(at) {
    let lo = 0, hi = this._actions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._actions[mid].at < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Remove every point that shares a time with a point in `preferred` (the
   * ones an edit moved or made) and is not that point. Of several preferred
   * points on one time, the last in array order stays. Nothing else moves:
   * no sort, no selection work (callers re-select by reference). True when
   * it removed anything.
   * @param {Set<object>} preferred — action objects in `_actions`
   */
  _dropCollisions(preferred) {
    if (!preferred || preferred.size === 0) return false;
    const keeper = new Map(); // at → the preferred point that keeps it
    for (const a of this._actions) if (preferred.has(a)) keeper.set(a.at, a);
    if (keeper.size === 0) return false;
    const before = this._actions.length;
    this._actions = this._actions.filter((a) => {
      const k = keeper.get(a.at);
      return !k || k === a;
    });
    return this._actions.length !== before;
  }

  /** The selected action objects (survives any reorder or removal). */
  _selectedRefs() {
    return new Set([...this._selectedIndices].map(i => this._actions[i]).filter(Boolean));
  }

  /** Select exactly the given action objects that are still in `_actions`. */
  _reselect(refs) {
    this._selectedIndices = new Set();
    for (let i = 0; i < this._actions.length; i++) {
      if (refs.has(this._actions[i])) this._selectedIndices.add(i);
    }
  }

  /**
   * Insert `points` ({at, pos}, already rounded), each replacing any point at
   * its time; of points sharing a time the last wins. Keeps `_actions`
   * sorted. Returns the inserted objects. No undo step, no emit.
   */
  _insertReplacing(points) {
    const byAt = new Map();
    for (const p of points) byAt.set(p.at, p);
    const fresh = [...byAt.values()].sort((a, b) => a.at - b.at);
    const rest = this._actions.filter(a => !byAt.has(a.at));
    const merged = [];
    let r = 0;
    for (const a of fresh) {
      while (r < rest.length && rest[r].at < a.at) merged.push(rest[r++]);
      merged.push(a);
    }
    while (r < rest.length) merged.push(rest[r++]);
    this._actions = merged;
    return fresh;
  }

  /**
   * One undo/redo entry. `createdIndices` is the created record as a PLAIN
   * ARRAY of indices into this entry's own `actions`: a Set would come back
   * from the editor's per-path undo cache (JSON) as `{}`, and references
   * would not survive the copy at all.
   *
   * `label` / `params` name the EDIT this entry undoes (or, on the redo
   * stack, redoes): a locale key from HISTORY_LABELS or modifierLabel() and
   * its ICU params, both plain data so exportState's structuredClone and the
   * JSON copies in the tests carry them (editor work list 4.5, 2026-11-24).
   * An entry made before labels (an older cached axis) has none; the menu
   * calls it "Edit".
   * @param {string|null} [label]
   * @param {object} [params]
   */
  _snapshot(label = null, params = undefined) {
    return {
      actions: this._actions.map(a => ({ at: a.at, pos: a.pos })),
      selectedIndices: new Set(this._selectedIndices),
      createdIndices: this.getCreatedIndices(),
      metadata: JSON.parse(JSON.stringify(this._metadata)),
      bookmarks: this._bookmarks.map(b => ({ at: b.at, name: b.name })),
      revision: this._revision,
      label: typeof label === 'string' && label ? label : null,
      params: params && typeof params === 'object' ? { ...params } : {},
    };
  }

  _restoreSnapshot(state) {
    // An entry without an id (none are made any more) is a state of its own.
    this._revision = Number.isFinite(state.revision) ? state.revision : nextRevision();
    this._actions = state.actions;
    this._selectedIndices = state.selectedIndices;
    const created = Array.isArray(state.createdIndices) ? state.createdIndices : [];
    this._lastCreated = new Set(created.map(i => this._actions[i]).filter(Boolean));
    if (state.metadata) this._metadata = state.metadata;
    if (state.bookmarks) this._bookmarks = state.bookmarks;
  }

  /**
   * Record the state before an edit as one undo step.
   * @param {string} [label] what the edit is called in the undo history
   *   (a HISTORY_LABELS key, or modifierLabel(fn)); editor work list 4.5
   * @param {object} [params] its ICU params, e.g. { count }
   */
  _pushState(label = HISTORY_LABELS.edit, params = undefined) {
    if (this._batching) return;
    this._undoStack.push(this._snapshot(label, params));
    if (this._undoStack.length > this._maxUndoSteps) {
      this._undoStack.shift();
    }
    this._redoStack = [];
    // The edit that follows makes a new state (R4-18).
    this._revision = nextRevision();
  }

  /**
   * One undo, without the emit. The current state goes to the redo stack
   * under the SAME label: redoing it re-applies that edit (editor work list
   * 4.5), so the history menu names a redo row by what it brings back.
   */
  _undoOne() {
    const entry = this._undoStack.pop();
    this._redoStack.push(this._snapshot(entry.label, entry.params));
    this._restoreSnapshot(entry);
  }

  /** One redo, without the emit; the label goes back to the undo stack with it. */
  _redoOne() {
    const entry = this._redoStack.pop();
    this._undoStack.push(this._snapshot(entry.label, entry.params));
    this._restoreSnapshot(entry);
  }

  undo() {
    return this.undoSteps(1) === 1;
  }

  redo() {
    return this.redoSteps(1) === 1;
  }

  /**
   * Undo `n` steps in one go: the undo history menu's "undo to here"
   * (editor work list 4.5, 2026-11-24). Each step is still its own undo, so
   * every one of them can be redone on its own, but onChange fires once at
   * the end (one redraw, one pop-out broadcast, one autosave schedule).
   * Clean when it lands on the saved state (R4-18), as a single undo is.
   * @param {number} n — clamped to 0..canUndo depth; anything not a number is 0
   * @returns {number} the steps actually undone
   */
  undoSteps(n) {
    const want = clampWhole(n, 0, this._undoStack.length, 0);
    for (let i = 0; i < want; i++) this._undoOne();
    if (want > 0) {
      this._syncDirtyToRevision();
      this._emit();
    }
    return want;
  }

  /**
   * Redo `n` steps in one go (the history menu's redo rows). As undoSteps.
   * @param {number} n
   * @returns {number} the steps actually redone
   */
  redoSteps(n) {
    const want = clampWhole(n, 0, this._redoStack.length, 0);
    for (let i = 0; i < want; i++) this._redoOne();
    if (want > 0) {
      this._syncDirtyToRevision();
      this._emit();
    }
    return want;
  }

  /**
   * The undo and redo steps by name, for the undo history menu (editor work
   * list 4.5). `undo` is newest first: undoSteps(i + 1) goes back to before
   * undo[i]. `redo` is next-to-redo first: redoSteps(j + 1) re-applies
   * redo[0..j]. `label` is a locale key (null for an entry made before
   * labels); `params` its ICU params. Copies: changing them changes nothing.
   * @returns {{undo: Array<{label: string|null, params: object}>, redo: Array<{label: string|null, params: object}>}}
   */
  undoHistory() {
    const view = (e) => ({
      label: typeof e?.label === 'string' && e.label ? e.label : null,
      params: e?.params && typeof e.params === 'object' ? { ...e.params } : {},
    });
    return {
      undo: this._undoStack.map(view).reverse(),
      redo: this._redoStack.map(view).reverse(),
    };
  }

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  // --- Mutations ---

  /**
   * Insert an action, maintaining sort order by `at`. On a time that already
   * holds a point, that point takes the new position instead (OFS add-or-
   * edit, CB-02): a number key on a frame with an unselected point used to
   * stack a second one there (2000/50 next to 2000/5). Same position: nothing
   * changes, no undo step, not dirty.
   * @returns {number} The index of the inserted (or edited) action
   */
  insertAction(at, pos) {
    at = Math.round(at);
    pos = Math.round(Math.max(0, Math.min(100, pos)));
    const lo = this._lowerBound(at);
    const existing = this._actions[lo];
    if (existing && existing.at === at) {
      if (existing.pos === pos) return lo;
      this._pushState(HISTORY_LABELS.editPoint);
      existing.pos = pos;
      this._dirty = true;
      this._emit();
      return lo;
    }

    this._pushState(HISTORY_LABELS.insert);
    const action = { at, pos };
    this._actions.splice(lo, 0, action);

    // Adjust selected indices that shifted
    const newSelected = new Set();
    for (const idx of this._selectedIndices) {
      newSelected.add(idx >= lo ? idx + 1 : idx);
    }
    this._selectedIndices = newSelected;

    this._dirty = true;
    this._emit();
    return lo;
  }

  /**
   * Update an action's properties.
   * If `at` changes, re-sorts and adjusts selection.
   * @param {number} index
   * @param {{at?: number, pos?: number}} changes
   * @param {string} [label] its name in the undo history (editor work list 4.5)
   * @returns {number} The new index of the action after potential re-sort
   */
  updateAction(index, { at, pos }, label = HISTORY_LABELS.editPoint) {
    if (index < 0 || index >= this._actions.length) return index;
    this._pushState(label);

    const action = this._actions[index];

    if (pos !== undefined) {
      action.pos = Math.round(Math.max(0, Math.min(100, pos)));
    }

    if (at !== undefined) {
      action.at = Math.round(at);
      const selected = this._selectedRefs();
      // Remove from current position and re-insert in sorted order. A point
      // already at the new time gives way to the moved one (CB-02).
      this._actions.splice(index, 1);
      this._actions = this._actions.filter(a => a.at !== action.at);
      const lo = this._lowerBound(action.at);
      this._actions.splice(lo, 0, action);
      this._reselect(selected);

      this._dirty = true;
      this._emit();
      return lo;
    }

    this._dirty = true;
    this._emit();
    return index;
  }

  /**
   * Delete actions at the given indices.
   * @param {Set<number>|number[]} indices
   * @param {string} [label] its name in the undo history (cut() passes its own; editor work list 4.5)
   */
  deleteActions(indices, label = HISTORY_LABELS.delete) {
    if (!indices || indices.size === 0 && (!Array.isArray(indices) || indices.length === 0)) return;
    const toDelete = new Set(indices instanceof Set ? indices : indices);
    let count = 0;
    for (const i of toDelete) if (i >= 0 && i < this._actions.length) count++;
    this._pushState(label, { count });

    this._actions = this._actions.filter((_, i) => !toDelete.has(i));
    this._selectedIndices = new Set();
    this._dirty = true;
    this._emit();
  }

  /**
   * Ripple delete (editor work list 4.3, 2026-11-24; FunGen 2 has it): delete
   * the selected points and close the gap they leave. Every later point moves
   * earlier by the selection's span (its first to its last point), as if that
   * stretch of video were cut out, so what follows keeps its rhythm. One undo
   * step. The selection must be one run of points (no unselected point inside
   * it, which would end up after the points moved past it): refused otherwise.
   * @returns {{changed: boolean, refused: boolean, count: number, shiftMs: number}}
   */
  rippleDeleteSelected() {
    const sel = [...this._selectedIndices].filter(i => i >= 0 && i < this._actions.length).sort((a, b) => a - b);
    if (sel.length === 0) return { changed: false, refused: false, count: 0, shiftMs: 0 };
    if (!this._isContiguous(sel)) return { changed: false, refused: true, count: 0, shiftMs: 0 };
    const first = this._actions[sel[0]].at;
    const last = this._actions[sel[sel.length - 1]].at;
    const shiftMs = last - first;
    this._pushState(HISTORY_LABELS.rippleDelete, { count: sel.length });
    const toDelete = new Set(sel);
    this._actions = this._actions
      .filter((_, i) => !toDelete.has(i))
      .map(a => (a.at > last ? { ...a, at: a.at - shiftMs } : a));
    this._selectedIndices = new Set();
    this._dirty = true;
    this._emit();
    return { changed: true, refused: false, count: sel.length, shiftMs };
  }

  /**
   * Move selected actions by delta time and delta position.
   */
  moveActions(indices, deltaAt, deltaPos) {
    const idxSet = indices instanceof Set ? indices : new Set(indices);
    if (idxSet.size === 0) return;
    this._pushState(HISTORY_LABELS.move, { count: idxSet.size });

    for (const idx of idxSet) {
      if (idx < 0 || idx >= this._actions.length) continue;
      const a = this._actions[idx];
      a.at = Math.max(0, Math.round(a.at + deltaAt));
      a.pos = Math.round(Math.max(0, Math.min(100, a.pos + deltaPos)));
    }

    // Re-sort, preserving selection by reference
    const selected = new Set([...idxSet].map(i => this._actions[i]).filter(Boolean));
    // A point moved onto another's time takes it (CB-02): now for a nudge,
    // at the end of a drag (endBatch) for a drag's mousemoves.
    if (Math.round(deltaAt) !== 0) {
      if (this._batching) for (const a of selected) this._batchMoved.add(a);
      else this._dropCollisions(selected);
    }
    this._actions.sort((a, b) => a.at - b.at);
    this._selectedIndices = new Set();
    for (let i = 0; i < this._actions.length; i++) {
      if (selected.has(this._actions[i])) {
        this._selectedIndices.add(i);
      }
    }

    this._dirty = true;
    this._emit();
  }

  // --- Selection ---

  select(index) {
    this._selectedIndices = new Set([index]);
    this._emit();
  }

  toggleSelect(index) {
    if (this._selectedIndices.has(index)) {
      this._selectedIndices.delete(index);
    } else {
      this._selectedIndices.add(index);
    }
    this._emit();
  }

  selectRange(from, to) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let i = lo; i <= hi; i++) {
      this._selectedIndices.add(i);
    }
    this._emit();
  }

  selectAll() {
    this._selectedIndices = new Set(this._actions.map((_, i) => i));
    this._emit();
  }

  clearSelection() {
    if (this._selectedIndices.size === 0) return;
    this._selectedIndices = new Set();
    this._emit();
  }

  /**
   * Select exactly these points (the Check script dialog's row and "Select
   * all N", editor work list 4.2): indices outside the script, or not whole
   * numbers, are skipped. Selection only, like Ctrl+1/2/3: no undo step,
   * the unsaved flag untouched, one onChange. Returns how many are selected.
   * @param {Iterable<number>} indices
   * @returns {number}
   */
  selectIndices(indices) {
    const next = new Set();
    for (const i of indices || []) {
      if (Number.isInteger(i) && i >= 0 && i < this._actions.length) next.add(i);
    }
    this._selectedIndices = next;
    this._emit();
    return next.size;
  }

  // --- Clipboard ---

  copy() {
    if (this._selectedIndices.size === 0) return;
    const selected = [...this._selectedIndices].sort((a, b) => a - b);
    const first = this._actions[selected[0]];
    this._clipboard = selected.map(i => ({
      at: this._actions[i].at - first.at,
      pos: this._actions[i].pos,
    }));
    // Also save absolute timestamps for pasteExact
    this._clipboardAbsolute = selected.map(i => ({
      at: this._actions[i].at,
      pos: this._actions[i].pos,
    }));
  }

  /**
   * Paste the clipboard with its first point at `atMs`. A pasted point
   * replaces any point at its time (CB-02: Ctrl+V at 6 s over existing points
   * made duplicates at 6000 and 6250); the pasted points end up selected.
   */
  paste(atMs) {
    if (this._clipboard.length === 0) return;
    this._pushState(HISTORY_LABELS.paste, { count: this._clipboard.length });
    const pasted = this._insertReplacing(this._clipboard.map(a => ({
      at: Math.round(atMs + a.at),
      pos: a.pos,
    })));
    this._reselect(new Set(pasted));
    this._dirty = true;
    this._emit();
  }

  /** Paste at original absolute timestamps (not relative to cursor); replaces as paste() does. */
  pasteExact() {
    if (this._clipboard.length === 0 || !this._clipboardAbsolute) return;
    this._pushState(HISTORY_LABELS.pasteExact, { count: this._clipboardAbsolute.length });
    const pasted = this._insertReplacing(this._clipboardAbsolute.map(a => ({
      at: Math.round(a.at),
      pos: a.pos,
    })));
    this._reselect(new Set(pasted));
    this._dirty = true;
    this._emit();
  }

  /** Select actions by position range. */
  selectByPositionRange(minPos, maxPos) {
    this._selectedIndices = new Set();
    for (let i = 0; i < this._actions.length; i++) {
      if (this._actions[i].pos >= minPos && this._actions[i].pos <= maxPos) {
        this._selectedIndices.add(i);
      }
    }
    this._emit();
  }

  /**
   * Select every action whose `at` is strictly less than `cursorMs`.
   * OFS parity: `Ctrl+Alt+Left` — isolate "everything before this point"
   * for bulk operations without dragging across the timeline.
   */
  selectLeftOfCursor(cursorMs) {
    this._selectedIndices = new Set();
    for (let i = 0; i < this._actions.length; i++) {
      if (this._actions[i].at < cursorMs) this._selectedIndices.add(i);
      else break;
    }
    this._emit();
  }

  /**
   * Select every action whose `at` is strictly greater than `cursorMs`.
   * OFS parity: `Ctrl+Alt+Right`.
   */
  selectRightOfCursor(cursorMs) {
    this._selectedIndices = new Set();
    for (let i = 0; i < this._actions.length; i++) {
      if (this._actions[i].at > cursorMs) this._selectedIndices.add(i);
    }
    this._emit();
  }

  // --- Selection filters: Every Nth point, New points only ---
  //
  // Selection only, like Ctrl+1/2/3: no undo step and the dirty flag is
  // never touched. With autosave on, dirty means a file write plus a Handy
  // re-upload, so a selection command that set it would re-upload the
  // script every time it was used.

  /**
   * Every Nth point, counted WITHOUT touching anything (the dialog's live
   * line). Scope: the selected points in time order (sorted indices, never
   * the Set's insertion order), or every point when nothing is selected.
   * Numbered 1..K, point k is kept when k >= start and (k - start) % n === 0:
   * start, start + n, start + 2n, … Only points in scope are counted, so
   * New points only followed by Every 3 from point 2 picks Double Speed's
   * 50 % points.
   * `n` is a whole number clamped to 2..K and `start` to 1..n; bad input is
   * clamped, never an error. Duplicate timestamps count as separate points.
   * Fewer than 2 points in scope selects nothing (count 0).
   * @returns {{scope: number, n: number, start: number, count: number, indices: number[]}}
   *   scope = K; n / start = the values actually used; indices ascending.
   */
  countEveryNth(n, start) {
    const len = this._actions.length;
    const scope = this._selectedIndices.size > 0
      ? [...this._selectedIndices].filter(i => Number.isInteger(i) && i >= 0 && i < len).sort((a, b) => a - b)
      : this._actions.map((_, i) => i);
    const k = scope.length;
    if (k < 2) return { scope: k, n: 2, start: 1, count: 0, indices: [] };
    const every = clampWhole(n, 2, k, 2);
    const from = clampWhole(start, 1, every, 1);
    const indices = [];
    for (let j = from; j <= k; j += every) indices.push(scope[j - 1]);
    return { scope: k, n: every, start: from, count: indices.length, indices };
  }

  /**
   * Replace the selection with countEveryNth(n, start). With fewer than 2
   * points in scope the selection stays as it is. Returns the same counts.
   */
  selectEveryNth(n, start) {
    const result = this.countEveryNth(n, start);
    if (result.count === 0) return result;
    this._selectedIndices = new Set(result.indices);
    this._emit();
    return result;
  }

  /**
   * New points only (N): replace the selection with the points the last
   * modifier or generator created that still exist (getCreatedIndices).
   * Replaces rather than narrows: after a whole-script modifier nothing is
   * selected, so narrowing would always come up empty. With nothing recorded
   * the selection stays as it is. Returns the number selected.
   * @returns {number}
   */
  selectCreated() {
    const idx = this.getCreatedIndices();
    if (idx.length === 0) return 0;
    this._selectedIndices = new Set(idx);
    this._emit();
    return idx.length;
  }

  /**
   * A string that changes whenever the selection does: each selected index in
   * order with that point's at and pos. A dialog that applies to "the
   * selection" takes it when it opens and compares on Apply (FT-031): the
   * pop-out can clear or move the selection while the dialog is open in the
   * main window, and Remap with nothing selected remaps the WHOLE script.
   * Empty string for no selection. Pure: reads only.
   * @returns {string}
   */
  selectionSignature() {
    return [...this._selectedIndices]
      .sort((a, b) => a - b)
      .map((i) => {
        const a = this._actions[i];
        return a ? `${i}:${a.at}:${a.pos}` : `${i}:-`;
      })
      .join('|');
  }

  /**
   * Equalize selected actions evenly in time between the first and
   * last of the selection. Positions stay put — only `at` timestamps
   * are re-spaced. OFS parity (`E` key). No-op for selections of 0/1/2.
   * First and last selected actions are preserved exactly so the
   * outer envelope of the pattern doesn't shift.
   *
   * Re-sorts afterwards, keeping the selection by reference like
   * moveActions. On a selection with gaps a retimed point can pass an
   * unselected one (0, 900, 1000 selected among 0, 400, 600, 900, 1000 put
   * 900 at 500, after 600), and an unsorted array misplaces every later
   * binary-search insert and breaks selectLeftOfCursor. OFS stays sorted
   * too: its Equalize removes the selection and re-adds it to a
   * time-ordered container (Funscript.cpp L642-664).
   */
  equalizeSelected() {
    const sel = [...this._selectedIndices].sort((a, b) => a - b);
    if (sel.length < 3) return;
    this._pushState(HISTORY_LABELS.equalize, { count: sel.length });

    const first = this._actions[sel[0]];
    const last = this._actions[sel[sel.length - 1]];
    const span = last.at - first.at;
    const step = span / (sel.length - 1);

    for (let i = 1; i < sel.length - 1; i++) {
      const newAt = Math.round(first.at + step * i);
      this._actions[sel[i]].at = newAt;
    }

    const selected = new Set(sel.map(i => this._actions[i]));
    // A retimed point that lands on an unselected point's time takes it (CB-02).
    this._dropCollisions(new Set(sel.slice(1, -1).map(i => this._actions[i])));
    this._actions.sort((a, b) => a.at - b.at);
    this._selectedIndices = new Set();
    for (let i = 0; i < this._actions.length; i++) {
      if (selected.has(this._actions[i])) this._selectedIndices.add(i);
    }

    this._dirty = true;
    this._emit();
  }

  /**
   * Move the *single* selected action to `cursorMs`. OFS parity (`End`
   * key). No-op when 0 or 2+ are selected (ambiguous target). Returns
   * the new index of the moved action, or -1 if no-op.
   */
  moveSelectedToTime(cursorMs) {
    if (this._selectedIndices.size !== 1) return -1;
    const idx = [...this._selectedIndices][0];
    return this.updateAction(idx, { at: cursorMs }, HISTORY_LABELS.moveToPlayhead);
  }

  /**
   * Insert an action at `cursorMs` with the position flipped relative
   * to the most recent existing action. If the last action's pos is
   * ≥ 50, place at 0; otherwise place at 100. Replaces the `1`/`9`
   * ping-pong on the numpad with one key. Empty script falls back to 100.
   */
  insertAlternating(cursorMs) {
    cursorMs = Math.round(cursorMs);
    let lastPos = -1;
    for (let i = this._actions.length - 1; i >= 0; i--) {
      if (this._actions[i].at <= cursorMs) { lastPos = this._actions[i].pos; break; }
    }
    if (lastPos < 0 && this._actions.length > 0) lastPos = this._actions[this._actions.length - 1].pos;
    const pos = lastPos < 0 ? 100 : (lastPos >= 50 ? 0 : 100);
    return this.insertAction(cursorMs, pos);
  }

  /**
   * Repeat the trailing two-action stroke at `cursorMs`. OFS parity
   * (`Home` key). Preserves delta-time and positions. Inserts two new
   * actions and selects them both. Returns `[firstIdx, secondIdx]` or
   * `null` if fewer than 2 actions exist or the stroke has zero span.
   */
  repeatLastStroke(cursorMs) {
    if (this._actions.length < 2) return null;
    const last = this._actions[this._actions.length - 1];
    const prev = this._actions[this._actions.length - 2];
    const span = last.at - prev.at;
    if (span <= 0) return null;
    cursorMs = Math.round(cursorMs);
    const firstIdx = this.insertAction(cursorMs, prev.pos);
    const secondIdx = this.insertAction(cursorMs + span, last.pos);
    this._selectedIndices = new Set([firstIdx, secondIdx]);
    this._emit();
    return [firstIdx, secondIdx];
  }

  // --- Advanced Operations ---

  /**
   * Invert selected action positions: pos = 100 - pos.
   */
  invertSelection() {
    if (this._selectedIndices.size === 0) return;
    this._pushState(HISTORY_LABELS.invert, { count: this._selectedIndices.size });
    for (const idx of this._selectedIndices) {
      if (idx >= 0 && idx < this._actions.length) {
        this._actions[idx].pos = 100 - this._actions[idx].pos;
      }
    }
    this._dirty = true;
    this._emit();
  }

  /**
   * Dry-run RDP simplification. Returns `{kept, removed, total}` counts
   * a hypothetical `simplify(epsilon)` would produce, without mutating
   * actions or selection. Drives the Simplify modal's live preview.
   */
  previewSimplify(epsilon) {
    const sortedIndices = [...this._selectedIndices].sort((a, b) => a - b);
    if (sortedIndices.length < 3) {
      return { kept: sortedIndices.length, removed: 0, total: sortedIndices.length };
    }
    const points = sortedIndices.map(i => this._actions[i]);
    const simplified = this._rdpSimplify(points, epsilon);
    return {
      kept: simplified.length,
      removed: points.length - simplified.length,
      total: points.length,
    };
  }

  /**
   * Simplify selected actions using Ramer-Douglas-Peucker algorithm.
   * Removes points below the epsilon distance threshold.
   * @param {number} epsilon — distance threshold (default 2)
   */
  simplify(epsilon = 2) {
    if (this._selectedIndices.size < 3) return;

    const sortedIndices = [...this._selectedIndices].sort((a, b) => a - b);
    const points = sortedIndices.map(i => this._actions[i]);

    const simplified = this._rdpSimplify(points, epsilon);

    // Build a set of action references to keep
    const keepSet = new Set(simplified);
    const removeIndices = new Set();
    for (const idx of sortedIndices) {
      if (!keepSet.has(this._actions[idx])) {
        removeIndices.add(idx);
      }
    }

    if (removeIndices.size === 0) return; // nothing to simplify
    // The undo step only once something changes: a no-op left a step that
    // made a state of its own, so a redo past it read as unsaved (R4-18).
    this._pushState(HISTORY_LABELS.simplify, { count: removeIndices.size });

    // Remove the simplified-out actions
    this._actions = this._actions.filter((_, i) => !removeIndices.has(i));

    // Rebuild selection to match remaining kept actions
    const keptRefs = new Set(simplified);
    this._selectedIndices = new Set();
    for (let i = 0; i < this._actions.length; i++) {
      if (keptRefs.has(this._actions[i])) {
        this._selectedIndices.add(i);
      }
    }

    this._dirty = true;
    this._emit();
  }

  /**
   * Ramer-Douglas-Peucker line simplification.
   * Points are {at, pos} objects treated as (x, y) coordinates.
   * @returns {Array} Simplified subset of points (same object references)
   */
  _rdpSimplify(points, epsilon) {
    if (points.length <= 2) return points;

    // Normalize coordinates for distance calculation
    // Use at range and pos range (0-100) to make distance meaningful
    const atRange = points[points.length - 1].at - points[0].at;
    const posRange = 100;

    const first = points[0];
    const last = points[points.length - 1];

    let maxDist = 0;
    let maxIdx = 0;

    for (let i = 1; i < points.length - 1; i++) {
      const d = this._perpendicularDist(points[i], first, last, atRange, posRange);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon) {
      const left = this._rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
      const right = this._rdpSimplify(points.slice(maxIdx), epsilon);
      return [...left.slice(0, -1), ...right];
    }

    return [first, last];
  }

  _perpendicularDist(point, lineStart, lineEnd, atRange, posRange) {
    // Normalize to 0-100 range for both axes
    const scale = atRange > 0 ? posRange / atRange : 1;
    const px = (point.at - lineStart.at) * scale;
    const py = point.pos;
    const lx = 0;
    const ly = lineStart.pos;
    const ex = (lineEnd.at - lineStart.at) * scale;
    const ey = lineEnd.pos;

    const dx = ex - lx;
    const dy = ey - ly;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      const ddx = px - lx;
      const ddy = py - ly;
      return Math.sqrt(ddx * ddx + ddy * ddy);
    }

    const num = Math.abs(dy * px - dx * py + ex * ly - ey * lx);
    return num / Math.sqrt(lenSq);
  }

  /**
   * Cut: copy selected actions to clipboard, then delete them.
   */
  cut() {
    if (this._selectedIndices.size === 0) return;
    this.copy();
    this.deleteActions(this._selectedIndices, HISTORY_LABELS.cut);
  }

  // --- Modifier / Bulk Operations ---

  /**
   * Apply a modifier function to the script.
   * If actions are selected, applies to selection only; otherwise applies to all.
   *
   * Selection afterwards: the modifier's whole output, chosen BY REFERENCE
   * (the objects spliced in). It used to select every action whose timestamp
   * appeared in the output, which also grabbed an unselected neighbour that
   * happened to share one (Offset Time +500 selected 6 of 5). A whole-script
   * run leaves nothing selected, as before.
   *
   * Created record: the output points whose rounded (at, pos) matches no
   * unused input pair (a multiset, so duplicates count). Timestamps alone
   * cannot tell: Double Speed's 50% point lands on the dropped point's
   * time with another position (1000:100 becomes 1000:0). Stored as
   * `_lastCreated`, replaced by every run that changes the script, even
   * when it created nothing.
   *
   * Returns `{ changed, refused, created }` (created = a count). Callers must
   * check it before saying "Applied …":
   *   - refused: a SEQUENCE_MODIFIERS function on a non-contiguous selection.
   *   - changed false: the output equals the input on rounded (at, pos).
   * Either way nothing is recorded: no undo step, dirty flag untouched,
   * created record kept, no onChange. A pointless "change" here is a file
   * write plus a Handy re-upload with autosave on.
   *
   * @param {Function} fn — (actions, ...args) => new actions array
   * @param {...*} args — additional arguments for the modifier
   * @returns {{changed: boolean, refused: boolean, created: number}}
   */
  applyModifier(fn, ...args) {
    const sortedIndices = [...this._selectedIndices].sort((a, b) => a - b);
    const scoped = sortedIndices.length > 0;
    if (scoped && SEQUENCE_MODIFIERS.has(fn) && !this._isContiguous(sortedIndices)) {
      return { changed: false, refused: true, created: 0 };
    }

    // Deep copy in index (= time) order; the modifier gets its own copy so
    // the created diff below compares against untouched input.
    const input = (scoped ? sortedIndices.map(i => this._actions[i]) : this._actions).map(roundAction);
    const produced = fn(input.map(a => ({ at: a.at, pos: a.pos })), ...args).map(roundAction);
    produced.sort((a, b) => a.at - b.at);
    // One point per time (CB-02): of output points sharing a time the last
    // stays, and below, an output point replaces an unselected one at its
    // time (Range Extend x2 on 3750/4000/4250 left two points at 4750).
    const output = produced.filter((a, i) => i === produced.length - 1 || produced[i + 1].at !== a.at);

    if (output.length === input.length && output.every((a, i) => a.at === input[i].at && a.pos === input[i].pos)) {
      return { changed: false, refused: false, created: 0 };
    }

    this._pushState(modifierLabel(fn, args));
    if (scoped) {
      // Merge the output into the unselected rest in one pass. On a tie the
      // output point replaces the unselected one (CB-02).
      const toDelete = new Set(sortedIndices);
      const rest = this._actions.filter((_, i) => !toDelete.has(i));
      const merged = [];
      let r = 0;
      for (const a of output) {
        while (r < rest.length && rest[r].at < a.at) merged.push(rest[r++]);
        while (r < rest.length && rest[r].at === a.at) r++;
        merged.push(a);
      }
      while (r < rest.length) merged.push(rest[r++]);
      this._actions = merged;

      const outputRefs = new Set(output);
      this._selectedIndices = new Set();
      for (let i = 0; i < merged.length; i++) {
        if (outputRefs.has(merged[i])) this._selectedIndices.add(i);
      }
    } else {
      this._actions = output;
    }

    const unused = new Map();
    for (const a of input) {
      const key = `${a.at}:${a.pos}`;
      unused.set(key, (unused.get(key) || 0) + 1);
    }
    const created = [];
    for (const a of output) {
      const key = `${a.at}:${a.pos}`;
      const left = unused.get(key) || 0;
      if (left > 0) unused.set(key, left - 1);
      else created.push(a);
    }
    this._lastCreated = new Set(created);

    this._dirty = true;
    this._emit();
    return { changed: true, refused: false, created: created.length };
  }

  /**
   * Bulk insert actions with undo. Used by pattern stamp and gap fill.
   * Selects the inserted points and makes them the created record.
   * @param {Array<{at: number, pos: number}>} newActions
   * @param {string} [label] its name in the undo history (editor work list
   *   4.5): HISTORY_LABELS.generatePattern / beats / fillGaps from the
   *   editor's generators; "Add N points" when not given. Gets { count }.
   * @returns {{changed: boolean, refused: boolean, created: number}}
   */
  insertActions(newActions, label = HISTORY_LABELS.insertPoints) {
    if (!newActions || newActions.length === 0) return { changed: false, refused: false, created: 0 };
    const points = newActions.map(roundAction);
    this._pushState(label, { count: new Set(points.map(p => p.at)).size });

    // A new point replaces any point at its time (CB-02).
    const inserted = this._insertReplacing(points);

    // Select newly inserted actions (by reference)
    const insertedRefs = new Set(inserted);
    this._reselect(insertedRefs);
    this._lastCreated = insertedRefs;

    this._dirty = true;
    this._emit();
    return { changed: true, refused: false, created: inserted.length };
  }

  /**
   * Fill with pattern (pattern library, Round 2): put `points` between t0
   * and t1 as ONE undo step. The drawer and the pop-out's OP_FILL_RANGE both
   * land here, so what the user previewed is what lands.
   *
   *   'replace': every point strictly between t0 and t1 goes; the points ON
   *              t0 and t1 (the anchors the fill joins) stay.
   *   'gap':     no point goes; the new ones go into the empty stretches.
   *
   * Points are rounded (whole ms, 0-100); any not strictly inside (t0, t1) is
   * dropped. t0 and t1 are the anchors' own times, compared as they are: a
   * script with fractional times (an "at" of 1000.4 in the file) keeps its
   * anchors. Rounding them first made 1000 the edge, so the anchor at 1000.4
   * counted as inside and was removed (review-2 minor 7, with the pop-out's
   * check, editor-popout-dispatch.js validFillRange, on the same rule).
   * A new point on an occupied time replaces that point (CB-02).
   * The new points become the selection and the created record (N). Nothing
   * to insert changes nothing (no undo step, not dirty): an empty fill never
   * deletes the points it would have replaced.
   * Undo puts back exactly what was there (actions, selection, created
   * record, dirty flag), as every edit's snapshot does (invariant I10).
   *
   * @param {number} t0 — the first anchor's time (ms)
   * @param {number} t1 — the last anchor's time (ms)
   * @param {Array<{at:number,pos:number}>} points — the fill (fillRange's `inserted`)
   * @param {'replace'|'gap'} [mode]
   * @returns {{changed: boolean, created: number, removed: number}}
   */
  replaceRange(t0, t1, points, mode = 'replace') {
    const none = { changed: false, created: 0, removed: 0 };
    const a = Number(t0);
    const b = Number(t1);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return none;
    const fresh = (Array.isArray(points) ? points : [])
      .filter(p => p && Number.isFinite(Number(p.at)) && Number.isFinite(Number(p.pos)))
      .map(p => roundAction({ at: Number(p.at), pos: Number(p.pos) }))
      .filter(p => p.at > a && p.at < b);
    if (fresh.length === 0) return none;

    this._pushState(HISTORY_LABELS.fill, { count: new Set(fresh.map(p => p.at)).size });
    const before = this._actions.length;
    if (mode !== 'gap') this._actions = this._actions.filter(x => !(x.at > a && x.at < b));
    const inserted = this._insertReplacing(fresh);
    const refs = new Set(inserted);
    this._reselect(refs);
    this._lastCreated = refs;

    this._dirty = true;
    this._emit();
    return { changed: true, created: inserted.length, removed: before + inserted.length - this._actions.length };
  }

  /**
   * Replace every point as ONE undoable edit: "Restore an earlier version…"
   * (editor work list 3.1, 2026-11-24). Points without a finite at / pos are
   * dropped; the rest are rounded like every edit (whole ms, 0-100) and put
   * in time order. Points sharing a time are kept as they are, NOT merged:
   * the version being restored is put back exactly, the way a file with
   * duplicates loads (the one-point-per-time rule binds edits, CB-02, and
   * this is a version coming back). The selection and the created record
   * (N) are cleared; metadata and bookmarks are left alone.
   *
   * The same points as now change nothing: no undo step, not dirty, no
   * onChange (as applyModifier: a pointless "change" is a file write plus a
   * Handy re-upload with autosave on). An empty array is a real restore (of
   * an empty version). Anything but an array is ignored.
   *
   * @param {Array<{at: number, pos: number}>} actions
   * @param {string} [label] its name in the undo history (editor work list 4.5)
   * @returns {{changed: boolean, count: number}} count = the points now in the script
   */
  replaceAll(actions, label = HISTORY_LABELS.restore) {
    if (!Array.isArray(actions)) return { changed: false, count: this._actions.length };
    const next = actions
      .filter(a => a && Number.isFinite(Number(a.at)) && Number.isFinite(Number(a.pos)))
      .map(a => roundAction({ at: Number(a.at), pos: Number(a.pos) }))
      .sort((a, b) => a.at - b.at); // stable: same-time points keep their order
    const same = next.length === this._actions.length
      && next.every((a, i) => a.at === this._actions[i].at && a.pos === this._actions[i].pos);
    if (same) return { changed: false, count: next.length };

    this._pushState(label, { count: next.length });
    this._actions = next;
    this._selectedIndices = new Set();
    this._lastCreated = new Set();
    this._dirty = true;
    this._emit();
    return { changed: true, count: next.length };
  }

  // --- Created record + selection shape ---

  /**
   * Indices (ascending) of the points the last modifier or generator
   * created that still exist. Deleted ones simply drop out; points moved,
   * nudged, inverted or equalized since are still the same points. O(n).
   * Read-only: selecting them is the caller's job.
   * @returns {number[]}
   */
  getCreatedIndices() {
    const out = [];
    if (this._lastCreated.size === 0) return out;
    for (let i = 0; i < this._actions.length; i++) {
      if (this._lastCreated.has(this._actions[i])) out.push(i);
    }
    return out;
  }

  /**
   * The same points as getCreatedIndices(), as the LIVE action objects in
   * time order. Do not mutate them; go through the edit methods.
   * @returns {Array<{at: number, pos: number}>}
   */
  getCreatedActions() {
    return this.getCreatedIndices().map(i => this._actions[i]);
  }

  /** True when the selection is one run of neighbours (or empty). */
  isSelectionContiguous() {
    return this._isContiguous([...this._selectedIndices].sort((a, b) => a - b));
  }

  /** True when applyModifier(fn) would refuse on the current selection. */
  refusesModifier(fn) {
    return this._selectedIndices.size > 0 && SEQUENCE_MODIFIERS.has(fn) && !this.isSelectionContiguous();
  }

  _isContiguous(sortedIndices) {
    if (sortedIndices.length === 0) return true;
    return sortedIndices[sortedIndices.length - 1] - sortedIndices[0] + 1 === sortedIndices.length;
  }

  // --- Metadata ---

  /**
   * Load metadata from a parsed funscript object (everything except actions).
   * @param {Object} metadata
   */
  loadMetadata(metadata) {
    // Deep clone to avoid shared references
    const { actions, ...rest } = metadata;
    this._metadata = JSON.parse(JSON.stringify(rest));

    // Extract bookmarks from metadata.metadata.bookmarks if present.
    // Routed through parseFunscriptTime so the editor accepts the same
    // shapes the player does — `at: <ms-number>`, `time: "HH:MM:SS.mmm"`
    // (MFP / .NET TimeSpan), or string-encoded numbers. Per SCOPE-
    // chapters-bookmarks.md §5 (editable-script bookmark parse).
    if (this._metadata.metadata && Array.isArray(this._metadata.metadata.bookmarks)) {
      this._bookmarks = this._metadata.metadata.bookmarks
        .map((b) => {
          if (!b || typeof b !== 'object') return null;
          const at = parseFunscriptTime(b.at ?? b.time);
          if (at === null) return null;
          return { at, name: typeof b.name === 'string' ? b.name : '' };
        })
        .filter(Boolean)
        .sort((a, b) => a.at - b.at);
    } else {
      this._bookmarks = [];
    }
  }

  /**
   * Get a copy of the current metadata.
   * @returns {Object}
   */
  getMetadata() {
    return JSON.parse(JSON.stringify(this._metadata));
  }

  /**
   * Set a metadata field (under metadata.metadata.*).
   * Creates the `metadata` sub-object if it doesn't exist.
   * @param {string} key
   * @param {*} value
   */
  setMetadataField(key, value) {
    this._pushState(HISTORY_LABELS.metadata);
    if (!this._metadata.metadata) {
      this._metadata.metadata = {};
    }
    this._metadata.metadata[key] = value;
    this._dirty = true;
    this._emit();
  }

  // --- Bookmarks ---

  /**
   * Add or update a bookmark at the given time.
   * @param {number} timeMs
   * @param {string} name
   */
  addBookmark(timeMs, name = '') {
    this._pushState(HISTORY_LABELS.addBookmark);
    timeMs = Math.round(timeMs);

    // Check if a bookmark already exists at this time
    const existing = this._bookmarks.findIndex(b => b.at === timeMs);
    if (existing >= 0) {
      this._bookmarks[existing].name = name;
    } else {
      this._bookmarks.push({ at: timeMs, name });
      this._bookmarks.sort((a, b) => a.at - b.at);
    }

    this._dirty = true;
    this._emit();
  }

  /**
   * Remove a bookmark at the given time.
   * @param {number} timeMs
   * @returns {boolean} true if a bookmark was removed
   */
  removeBookmark(timeMs) {
    timeMs = Math.round(timeMs);
    const idx = this._bookmarks.findIndex(b => b.at === timeMs);
    if (idx < 0) return false;

    this._pushState(HISTORY_LABELS.removeBookmark);
    this._bookmarks.splice(idx, 1);
    this._dirty = true;
    this._emit();
    return true;
  }

  /**
   * Get all bookmarks (sorted by time).
   * @returns {Array<{at: number, name: string}>}
   */
  getBookmarks() {
    return this._bookmarks.map(b => ({ at: b.at, name: b.name }));
  }

  // --- Serialization ---

  /**
   * The length of the video this script is edited against, in ms (editor
   * work list 5.3): the saved metadata block's `duration` comes from it, in
   * whole seconds, as OFS writes it. Kept across loads and axis switches (it
   * belongs to the video); 0, a negative or a non-number = unknown.
   * @param {number} ms
   */
  setVideoDuration(ms) {
    const v = Number(ms);
    this._videoDurationMs = Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** The video length set by setVideoDuration, in ms; 0 = unknown. */
  get videoDurationMs() { return this._videoDurationMs; }

  /**
   * Build a full .funscript JSON string, preserving original metadata.
   * Uses internal metadata by default; pass metadata param for backward compat.
   *
   * The `metadata` block is OpenFunscripter's (editor work list 5.3,
   * 2026-11-24): every key the file already had stays as it was, top level
   * and inside `metadata`, unknown ones included; only the OFS keys it lacks
   * are added, with OFS's empty defaults ('' / [] / type "basic"). A file
   * with no block gets a whole one. `title` is NOT taken from the file name:
   * OFS's block title is the project's own field, "" until the user types
   * one (OFS-lib Funscript.cpp: the path-derived name is the script's tab
   * name, never written into the block).
   *
   * `duration`: OFS writes the video's length in whole seconds
   * (OpenFunscripter.cpp: metadata.duration = player->Duration(), a double
   * stored in an int64, so truncated), and replaces the file's value with it
   * whenever a video is loaded; so does this, when setVideoDuration() gave
   * one. Unknown video length: the file's own value stays, else 0, OFS's
   * default. Never the last point's time: FunSync reads a positive duration
   * as the length of the video the script was MADE FOR (stream-session.js
   * streamCutWarning, eroscripts-post.js lengthVerdict), and a script
   * usually ends before its video does, so that would warn "made for another
   * cut" on the next stream of the same video.
   *
   * A `metadata` that is not an object (a string, an array) is the file's
   * own and is written back untouched.
   *
   * @param {Object} [metadata] - Override metadata (optional, for backward compat)
   * @returns {string} JSON string
   */
  toFunscriptJSON(metadata) {
    const source = metadata || this._metadata || {};
    const output = JSON.parse(JSON.stringify(source));
    output.actions = this._actions.map(a => ({
      at: Math.round(a.at),
      pos: Math.round(a.pos),
    }));
    if (!output.version) output.version = '1.0';

    if (output.metadata === undefined || output.metadata === null) output.metadata = {};
    const meta = output.metadata;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      for (const [key, dflt] of Object.entries(OFS_METADATA_DEFAULTS)) {
        if (!(key in meta)) meta[key] = Array.isArray(dflt) ? [] : dflt;
      }
      if (this._videoDurationMs > 0) meta.duration = Math.floor(this._videoDurationMs / 1000);

      // Write bookmarks into metadata.metadata.bookmarks
      if (this._bookmarks.length > 0) {
        meta.bookmarks = this._bookmarks.map(b => ({ at: b.at, name: b.name }));
      } else {
        delete meta.bookmarks;
      }
    }

    return JSON.stringify(output, null, 2);
  }

  /**
   * Mark as saved (clears dirty flag). `revision` is the state that was
   * written: the one on screen by default. An edit made while the write was
   * on its way (pass the `revision` read before toFunscriptJSON) is not on
   * disk, so it stays dirty, and Ctrl+Z back to the written state is clean
   * (R4-18).
   * @param {number} [revision]
   */
  markSaved(revision = this._revision) {
    this._savedRevision = revision;
    this._syncDirtyToRevision();
  }

  // --- Internal ---

  _emit() {
    if (this.onChange) this.onChange();
  }
}
