// EditableScript — Mutable funscript action array with undo/redo, selection, clipboard

export class EditableScript {
  constructor() {
    this._actions = [];
    this._selectedIndices = new Set();
    this._undoStack = [];
    this._redoStack = [];
    this._clipboard = [];
    this._dirty = false;
    this._maxUndoSteps = 100;
    this._metadata = {};
    this._bookmarks = [];

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
    this._undoStack = [];
    this._redoStack = [];
    this._clipboard = [];
    this._dirty = false;

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
   * Initialize with an empty action array (create-from-scratch mode).
   */
  loadEmpty() {
    this._actions = [];
    this._selectedIndices = new Set();
    this._undoStack = [];
    this._redoStack = [];
    this._clipboard = [];
    this._dirty = false;
    this._metadata = {};
    this._bookmarks = [];
  }

  /**
   * Clear all state.
   */
  clear() {
    this._actions = [];
    this._selectedIndices = new Set();
    this._undoStack = [];
    this._redoStack = [];
    this._clipboard = [];
    this._dirty = false;
    this._metadata = {};
    this._bookmarks = [];
  }

  // --- Accessors ---

  get actions() { return this._actions; }
  get selectedIndices() { return this._selectedIndices; }
  get dirty() { return this._dirty; }
  get actionCount() { return this._actions.length; }

  // --- Undo / Redo ---

  _pushState() {
    this._undoStack.push({
      actions: this._actions.map(a => ({ at: a.at, pos: a.pos })),
      selectedIndices: new Set(this._selectedIndices),
      metadata: JSON.parse(JSON.stringify(this._metadata)),
      bookmarks: this._bookmarks.map(b => ({ at: b.at, name: b.name })),
    });
    if (this._undoStack.length > this._maxUndoSteps) {
      this._undoStack.shift();
    }
    this._redoStack = [];
  }

  undo() {
    if (this._undoStack.length === 0) return false;
    // Save current state to redo stack
    this._redoStack.push({
      actions: this._actions.map(a => ({ at: a.at, pos: a.pos })),
      selectedIndices: new Set(this._selectedIndices),
      metadata: JSON.parse(JSON.stringify(this._metadata)),
      bookmarks: this._bookmarks.map(b => ({ at: b.at, name: b.name })),
    });
    const state = this._undoStack.pop();
    this._actions = state.actions;
    this._selectedIndices = state.selectedIndices;
    if (state.metadata) this._metadata = state.metadata;
    if (state.bookmarks) this._bookmarks = state.bookmarks;
    this._dirty = true;
    this._emit();
    return true;
  }

  redo() {
    if (this._redoStack.length === 0) return false;
    // Save current state to undo stack
    this._undoStack.push({
      actions: this._actions.map(a => ({ at: a.at, pos: a.pos })),
      selectedIndices: new Set(this._selectedIndices),
      metadata: JSON.parse(JSON.stringify(this._metadata)),
      bookmarks: this._bookmarks.map(b => ({ at: b.at, name: b.name })),
    });
    const state = this._redoStack.pop();
    this._actions = state.actions;
    this._selectedIndices = state.selectedIndices;
    if (state.metadata) this._metadata = state.metadata;
    if (state.bookmarks) this._bookmarks = state.bookmarks;
    this._dirty = true;
    this._emit();
    return true;
  }

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  // --- Mutations ---

  /**
   * Insert an action, maintaining sort order by `at`.
   * @returns {number} The index where the action was inserted
   */
  insertAction(at, pos) {
    this._pushState();
    at = Math.round(at);
    pos = Math.round(Math.max(0, Math.min(100, pos)));
    const action = { at, pos };

    // Binary search for insertion point
    let lo = 0, hi = this._actions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._actions[mid].at < at) lo = mid + 1;
      else hi = mid;
    }

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
   * @returns {number} The new index of the action after potential re-sort
   */
  updateAction(index, { at, pos }) {
    if (index < 0 || index >= this._actions.length) return index;
    this._pushState();

    const action = this._actions[index];
    const wasSelected = this._selectedIndices.has(index);

    if (pos !== undefined) {
      action.pos = Math.round(Math.max(0, Math.min(100, pos)));
    }

    if (at !== undefined) {
      action.at = Math.round(at);
      // Remove from current position and re-insert in sorted order
      this._actions.splice(index, 1);

      let lo = 0, hi = this._actions.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this._actions[mid].at < action.at) lo = mid + 1;
        else hi = mid;
      }
      this._actions.splice(lo, 0, action);

      // Rebuild selection — the moved action goes to `lo`
      const newSelected = new Set();
      for (const idx of this._selectedIndices) {
        if (idx === index) continue; // handle separately
        // Adjust for removal at `index` and insertion at `lo`
        let adjusted = idx;
        if (adjusted > index) adjusted--;
        if (adjusted >= lo) adjusted++;
        newSelected.add(adjusted);
      }
      if (wasSelected) newSelected.add(lo);
      this._selectedIndices = newSelected;

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
   */
  deleteActions(indices) {
    if (!indices || indices.size === 0 && (!Array.isArray(indices) || indices.length === 0)) return;
    this._pushState();

    const toDelete = new Set(indices instanceof Set ? indices : indices);
    this._actions = this._actions.filter((_, i) => !toDelete.has(i));
    this._selectedIndices = new Set();
    this._dirty = true;
    this._emit();
  }

  /**
   * Move selected actions by delta time and delta position.
   */
  moveActions(indices, deltaAt, deltaPos) {
    const idxSet = indices instanceof Set ? indices : new Set(indices);
    if (idxSet.size === 0) return;
    this._pushState();

    for (const idx of idxSet) {
      if (idx < 0 || idx >= this._actions.length) continue;
      const a = this._actions[idx];
      a.at = Math.max(0, Math.round(a.at + deltaAt));
      a.pos = Math.round(Math.max(0, Math.min(100, a.pos + deltaPos)));
    }

    // Re-sort, preserving selection by reference
    const selected = new Set([...idxSet].map(i => this._actions[i]));
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

  // --- Clipboard ---

  copy() {
    if (this._selectedIndices.size === 0) return;
    const selected = [...this._selectedIndices].sort((a, b) => a - b);
    const first = this._actions[selected[0]];
    this._clipboard = selected.map(i => ({
      at: this._actions[i].at - first.at,
      pos: this._actions[i].pos,
    }));
  }

  paste(atMs) {
    if (this._clipboard.length === 0) return;
    this._pushState();

    const newIndices = [];
    for (const action of this._clipboard) {
      const insertAt = Math.round(atMs + action.at);
      const pos = action.pos;
      // Binary insert
      let lo = 0, hi = this._actions.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this._actions[mid].at < insertAt) lo = mid + 1;
        else hi = mid;
      }
      this._actions.splice(lo, 0, { at: insertAt, pos });
      newIndices.push(lo);
      // Adjust subsequent newIndices for the insertion
    }

    // Select the pasted actions
    this._selectedIndices = new Set();
    // Re-find pasted actions (indices may have shifted)
    // Simplest: re-sort and select based on timestamps
    this._actions.sort((a, b) => a.at - b.at);
    const pastedTimes = this._clipboard.map(a => Math.round(atMs + a.at));
    const used = new Set();
    for (const t of pastedTimes) {
      for (let i = 0; i < this._actions.length; i++) {
        if (this._actions[i].at === t && !used.has(i)) {
          this._selectedIndices.add(i);
          used.add(i);
          break;
        }
      }
    }

    this._dirty = true;
    this._emit();
  }

  // --- Advanced Operations ---

  /**
   * Invert selected action positions: pos = 100 - pos.
   */
  invertSelection() {
    if (this._selectedIndices.size === 0) return;
    this._pushState();
    for (const idx of this._selectedIndices) {
      if (idx >= 0 && idx < this._actions.length) {
        this._actions[idx].pos = 100 - this._actions[idx].pos;
      }
    }
    this._dirty = true;
    this._emit();
  }

  /**
   * Simplify selected actions using Ramer-Douglas-Peucker algorithm.
   * Removes points below the epsilon distance threshold.
   * @param {number} epsilon — distance threshold (default 2)
   */
  simplify(epsilon = 2) {
    if (this._selectedIndices.size < 3) return;
    this._pushState();

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
    this.deleteActions(this._selectedIndices);
  }

  // --- Modifier / Bulk Operations ---

  /**
   * Apply a modifier function to the script.
   * If actions are selected, applies to selection only; otherwise applies to all.
   * @param {Function} fn — (actions, ...args) => new actions array
   * @param {...*} args — additional arguments for the modifier
   */
  applyModifier(fn, ...args) {
    this._pushState();
    if (this._selectedIndices.size > 0) {
      // Extract selected actions (deep copy, sorted by index)
      const sortedIndices = [...this._selectedIndices].sort((a, b) => a - b);
      const selectedActions = sortedIndices.map(i => ({ at: this._actions[i].at, pos: this._actions[i].pos }));

      // Apply modifier
      const modified = fn(selectedActions, ...args);

      // Remove old selected actions
      const toDelete = new Set(sortedIndices);
      this._actions = this._actions.filter((_, i) => !toDelete.has(i));

      // Merge modified back, maintaining sort order
      for (const a of modified) {
        let lo = 0, hi = this._actions.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (this._actions[mid].at < a.at) lo = mid + 1;
          else hi = mid;
        }
        this._actions.splice(lo, 0, { at: Math.round(a.at), pos: Math.round(Math.max(0, Math.min(100, a.pos))) });
      }

      // Select the newly inserted actions (by matching timestamps)
      this._selectedIndices = new Set();
      const modifiedTimes = new Set(modified.map(a => Math.round(a.at)));
      const used = new Set();
      for (let i = 0; i < this._actions.length; i++) {
        if (modifiedTimes.has(this._actions[i].at) && !used.has(this._actions[i].at)) {
          this._selectedIndices.add(i);
          // Don't mark as used — multiple actions can share a timestamp
        }
      }
    } else {
      // Apply to all actions
      const modified = fn(this._actions.map(a => ({ at: a.at, pos: a.pos })), ...args);
      this._actions = modified.map(a => ({
        at: Math.round(a.at),
        pos: Math.round(Math.max(0, Math.min(100, a.pos))),
      }));
      this._actions.sort((a, b) => a.at - b.at);
    }
    this._dirty = true;
    this._emit();
  }

  /**
   * Bulk insert actions with undo. Used by pattern stamp and gap fill.
   * @param {Array<{at: number, pos: number}>} newActions
   */
  insertActions(newActions) {
    if (!newActions || newActions.length === 0) return;
    this._pushState();

    for (const a of newActions) {
      const action = { at: Math.round(a.at), pos: Math.round(Math.max(0, Math.min(100, a.pos))) };
      let lo = 0, hi = this._actions.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this._actions[mid].at < action.at) lo = mid + 1;
        else hi = mid;
      }
      this._actions.splice(lo, 0, action);
    }

    // Select newly inserted actions
    const insertedTimes = new Map();
    for (const a of newActions) {
      const t = Math.round(a.at);
      insertedTimes.set(t, (insertedTimes.get(t) || 0) + 1);
    }
    this._selectedIndices = new Set();
    const remaining = new Map(insertedTimes);
    for (let i = 0; i < this._actions.length; i++) {
      const count = remaining.get(this._actions[i].at);
      if (count && count > 0) {
        this._selectedIndices.add(i);
        remaining.set(this._actions[i].at, count - 1);
      }
    }

    this._dirty = true;
    this._emit();
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

    // Extract bookmarks from metadata.metadata.bookmarks if present
    if (this._metadata.metadata && Array.isArray(this._metadata.metadata.bookmarks)) {
      this._bookmarks = this._metadata.metadata.bookmarks
        .filter(b => b && typeof b.at === 'number')
        .map(b => ({ at: b.at, name: b.name || '' }))
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
    this._pushState();
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
    this._pushState();
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

    this._pushState();
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
   * Build a full .funscript JSON string, preserving original metadata.
   * Uses internal metadata by default; pass metadata param for backward compat.
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

    // Write bookmarks into metadata.metadata.bookmarks
    if (this._bookmarks.length > 0) {
      if (!output.metadata) output.metadata = {};
      output.metadata.bookmarks = this._bookmarks.map(b => ({ at: b.at, name: b.name }));
    } else if (output.metadata) {
      delete output.metadata.bookmarks;
    }

    return JSON.stringify(output, null, 2);
  }

  /**
   * Mark as saved (clears dirty flag).
   */
  markSaved() {
    this._dirty = false;
  }

  // --- Internal ---

  _emit() {
    if (this.onChange) this.onChange();
  }
}
