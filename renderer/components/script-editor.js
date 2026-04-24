// ScriptEditor — Funscript editor panel with OFS-style interactions
// Centered playhead, speed-colored lines, click-to-insert, numpad placement, autosave

import { EditableScript } from '../js/editable-script.js';
import { ActionGraph } from '../js/action-graph.js';
import {
  icon, Undo2, Redo2, Save, ZoomIn, ZoomOut, Magnet, Trash2,
  FlipVertical2, Spline, Scissors, WandSparkles, BookmarkPlus, FileText, Rows3,
  AudioWaveform, Music,
} from '../js/icons.js';
import { showToast } from '../js/toast.js';
import { Modal } from './modal.js';
import {
  halfSpeed, doubleSpeed, reverseActions, remapRange, offsetTime, removePauses, generatePattern,
} from '../js/script-modifiers.js';
import { detectGaps, fillGaps } from '../js/gap-filler.js';
import { extractPeaks, getCachedPeaks, clearCacheFor } from '../js/waveform.js';
import { detectBeats, beatsToActions, getCachedBeats, clearBeatCacheFor } from '../js/beat-detector.js';
import { dataService } from '../js/data-service.js';

export class ScriptEditor {
  constructor({ videoPlayer, funscriptEngine, progressBar, syncEngine, handyManager, settings }) {
    this.videoPlayer = videoPlayer;
    this.funscriptEngine = funscriptEngine;
    this.progressBar = progressBar;
    this.syncEngine = syncEngine;
    this.handyManager = handyManager;
    this.settings = settings;

    this.editableScript = new EditableScript();
    this.graph = null;

    this._open = false;
    this._panel = null;
    this._canvas = null;
    this._canvasContainer = null;
    this._statusEl = null;
    this._speedSelect = null;
    this._btnUndo = null;
    this._btnRedo = null;
    this._previousPlaybackRate = 1;

    // Drag state
    this._dragMode = null; // 'move' | 'rubber' | 'pan'
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragStartTime = 0;
    this._dragStartPos = 0;
    this._lastSelectedIndex = -1;

    // Autosave state
    this._funscriptPath = null; // path on disk for autosave
    this._autosaveTimer = null;
    this._autosaveDelay = 1000; // 1s debounce
    this._autosaveEnabled = false;

    // Waveform state
    this._waveformEnabled = false;
    this._btnWaveform = null;

    /** @type {Function|null} Callback for when we create/load a funscript in editor */
    this.onFunscriptCreated = null;

    // Multi-script editing
    this._availableScripts = []; // [{ label, path }] — populated by app.js
    this._scriptSelect = null;

    // Undo stack cache per path (survives script switching)
    this._undoCache = new Map(); // path → { actions, undoStack, redoStack, selectedIndices, bookmarks }

    // Snap-to-frame
    this._snapToFrame = true;

    // Live device preview
    this._livePreview = false;

    this._buildPanel();
    this._bindEvents();

    // Wire onChange
    this.editableScript.onChange = () => this._onScriptChanged();
  }

  // --- Panel Construction ---

  _buildPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'script-editor';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'editor__toolbar';

    this._btnUndo = this._makeBtn(Undo2, 'Undo (Ctrl+Z)', () => this.editableScript.undo());
    this._btnRedo = this._makeBtn(Redo2, 'Redo (Ctrl+Y)', () => this.editableScript.redo());
    const btnDelete = this._makeBtn(Trash2, 'Delete Selected (Del)', () => this._deleteSelected());
    const sep1 = this._makeSeparator();

    // OFS operations
    const btnInvert = this._makeBtn(FlipVertical2, 'Invert Selected (Ctrl+I)', () => this._invertSelected());
    const btnSimplify = this._makeBtn(Spline, 'Simplify Selected', () => this._simplifySelected());
    const btnCut = this._makeBtn(Scissors, 'Cut Selected (Ctrl+X)', () => this._cutSelected());
    const sep1b = this._makeSeparator();

    // Modify dropdown
    this._modifySelect = document.createElement('select');
    this._modifySelect.className = 'editor__speed-select';
    this._modifySelect.title = 'Modify script';
    const modOpts = [
      { value: '', label: 'Modify\u2026' },
      { value: 'halfSpeed', label: 'Half Speed' },
      { value: 'doubleSpeed', label: 'Double Speed' },
      { value: 'reverse', label: 'Reverse' },
      { value: 'remapRange', label: 'Remap Range\u2026' },
      { value: 'offsetTime', label: 'Offset Time\u2026' },
      { value: 'removePauses', label: 'Remove Pauses\u2026' },
      { value: 'rangeExtend', label: 'Range Extend/Compress\u2026' },
      { value: 'generatePattern', label: 'Generate Pattern\u2026' },
    ];
    for (const o of modOpts) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === '') opt.disabled = true;
      this._modifySelect.appendChild(opt);
    }
    this._modifySelect.selectedIndex = 0;
    this._modifySelect.addEventListener('change', () => this._onModifyChange());

    const sep1c = this._makeSeparator();

    // Metadata, Bookmark, Fill Gaps buttons
    const btnMetadata = this._makeBtn(FileText, 'Edit Metadata', () => this._openMetadataModal());
    const btnBookmark = this._makeBtn(BookmarkPlus, 'Add Bookmark (B)', () => this._addBookmarkAtCursor());
    const btnFillGaps = this._makeBtn(Rows3, 'Fill Gaps', () => this._openFillGapsModal());
    this._btnWaveform = this._makeBtn(AudioWaveform, 'Toggle Waveform (W)', () => this._toggleWaveform());
    const btnBeats = this._makeBtn(Music, 'Generate from Beats', () => this._openBeatModal());

    const sep1d = this._makeSeparator();

    const btnZoomIn = this._makeBtn(ZoomIn, 'Zoom In (+)', () => this._zoomIn());
    const btnZoomOut = this._makeBtn(ZoomOut, 'Zoom Out (-)', () => this._zoomOut());
    const btnFitAll = this._makeBtn(Magnet, 'Fit All', () => this.graph?.fitAll());
    const sep2 = this._makeSeparator();

    // Speed select
    const speedLabel = document.createElement('span');
    speedLabel.className = 'editor__speed-label';
    speedLabel.textContent = 'Speed:';

    this._speedSelect = document.createElement('select');
    this._speedSelect.className = 'editor__speed-select';
    for (const rate of [0.25, 0.5, 0.75, 1, 1.5, 2]) {
      const opt = document.createElement('option');
      opt.value = String(rate);
      opt.textContent = `${rate}x`;
      if (rate === 1) opt.selected = true;
      this._speedSelect.appendChild(opt);
    }
    this._speedSelect.addEventListener('change', () => this._onSpeedChange());

    const sep3 = this._makeSeparator();
    const btnSave = this._makeBtn(Save, 'Save (Ctrl+S)', () => this._save());

    // Autosave checkbox + status
    const autosaveGroup = document.createElement('span');
    autosaveGroup.className = 'editor__autosave-group';

    this._autosaveCheckbox = document.createElement('input');
    this._autosaveCheckbox.type = 'checkbox';
    this._autosaveCheckbox.id = 'editor-autosave';
    this._autosaveCheckbox.checked = false;
    this._autosaveCheckbox.addEventListener('change', () => {
      this._autosaveEnabled = this._autosaveCheckbox.checked;
      this._autosaveStatusEl.textContent = '';
      if (this._autosaveEnabled && this.editableScript?.dirty) {
        this._triggerAutosave();
      }
    });

    const autosaveLabel = document.createElement('label');
    autosaveLabel.htmlFor = 'editor-autosave';
    autosaveLabel.className = 'editor__autosave-label';
    autosaveLabel.textContent = 'Autosave';

    this._autosaveStatusEl = document.createElement('span');
    this._autosaveStatusEl.className = 'editor__autosave-status';

    autosaveGroup.append(this._autosaveCheckbox, autosaveLabel, this._autosaveStatusEl);

    this._statusEl = document.createElement('span');
    this._statusEl.className = 'editor__status';

    // Script selector (multi-axis / custom routing)
    this._scriptSelect = document.createElement('select');
    this._scriptSelect.className = 'editor__script-select';
    this._scriptSelect.title = 'Select which script to edit';
    this._scriptSelect.hidden = true; // shown when multiple scripts available
    this._scriptSelect.addEventListener('change', () => this._onScriptSelectChange());

    const sepScript = this._makeSeparator();
    sepScript.classList.add('editor__script-sep');
    sepScript.hidden = true;

    // Snap-to-frame toggle
    const snapLabel = document.createElement('label');
    snapLabel.className = 'editor__toggle-label';
    const snapCheck = document.createElement('input');
    snapCheck.type = 'checkbox';
    snapCheck.checked = this._snapToFrame;
    snapCheck.addEventListener('change', () => { this._snapToFrame = snapCheck.checked; });
    snapLabel.appendChild(snapCheck);
    snapLabel.appendChild(document.createTextNode(' Snap'));
    snapLabel.title = 'Snap action timestamps to video frame boundaries';

    // Spline/Linear toggle
    const splineLabel = document.createElement('label');
    splineLabel.className = 'editor__toggle-label';
    const splineCheck = document.createElement('input');
    splineCheck.type = 'checkbox';
    splineCheck.checked = true; // splines on by default
    this._splineMode = true;
    splineCheck.addEventListener('change', () => {
      this._splineMode = splineCheck.checked;
      if (this.graph) {
        this.graph._splineMode = this._splineMode;
        this.graph.draw();
      }
    });
    splineLabel.appendChild(splineCheck);
    splineLabel.appendChild(document.createTextNode(' Curves'));
    splineLabel.title = 'Toggle between curved (Hermite) and linear connection lines';

    // Recording mode indicator
    this._recordingIndicator = document.createElement('span');
    this._recordingIndicator.className = 'editor__recording-indicator';
    this._recordingIndicator.textContent = 'REC';
    this._recordingIndicator.hidden = true;
    this._recordingIndicator.style.cssText = 'color:#ff4444;font-weight:700;font-size:11px;margin-left:6px;animation:blink 1s step-end infinite';

    toolbar.append(
      this._scriptSelect, sepScript,
      this._btnUndo, this._btnRedo, sep1,
      btnDelete, btnCut, btnInvert, btnSimplify, sep1b,
      this._modifySelect, sep1c,
      btnMetadata, btnBookmark, btnFillGaps, this._btnWaveform, btnBeats, sep1d,
      btnZoomIn, btnZoomOut, btnFitAll, sep2,
      speedLabel, this._speedSelect, sep3,
      btnSave, autosaveGroup, snapLabel, splineLabel, this._recordingIndicator, this._statusEl,
    );

    // Canvas container
    this._canvasContainer = document.createElement('div');
    this._canvasContainer.className = 'editor__canvas-container';

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'editor__canvas';
    this._canvas.tabIndex = 0;
    this._canvasContainer.appendChild(this._canvas);

    // Timeline scrubber — thin bar below canvas showing full timeline + viewport window
    this._scrubber = document.createElement('div');
    this._scrubber.className = 'editor__scrubber';

    this._scrubberTrack = document.createElement('div');
    this._scrubberTrack.className = 'editor__scrubber-track';

    this._scrubberViewport = document.createElement('div');
    this._scrubberViewport.className = 'editor__scrubber-viewport';

    this._scrubberCursor = document.createElement('div');
    this._scrubberCursor.className = 'editor__scrubber-cursor';

    this._scrubberTrack.append(this._scrubberViewport, this._scrubberCursor);
    this._scrubber.appendChild(this._scrubberTrack);

    this._panel.append(toolbar, this._canvasContainer, this._scrubber);

    // Insert into player container
    const playerContainer = document.getElementById('player-container');
    if (playerContainer) {
      playerContainer.appendChild(this._panel);
    }

    // Create graph renderer
    this.graph = new ActionGraph(this._canvas, this.editableScript);
  }

  _makeBtn(iconNode, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'editor__btn';
    btn.title = title;
    btn.appendChild(icon(iconNode, { width: 16, height: 16, 'stroke-width': 2 }));
    btn.addEventListener('click', onClick);
    return btn;
  }

  _makeSeparator() {
    const sep = document.createElement('div');
    sep.className = 'editor__toolbar-separator';
    return sep;
  }

  // --- Events ---

  _bindEvents() {
    // Canvas mouse events
    this._canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this._canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this._canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this._canvas.addEventListener('mouseleave', () => this._onMouseLeave());
    this._canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));
    this._canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // Canvas keyboard events (stopPropagation prevents global shortcuts)
    this._canvas.addEventListener('keydown', (e) => this._onCanvasKeyDown(e));

    // Scrubber events
    this._scrubberDragging = false;
    this._scrubber.addEventListener('mousedown', (e) => this._onScrubberDown(e));
    document.addEventListener('mousemove', (e) => this._onScrubberMove(e));
    document.addEventListener('mouseup', () => this._onScrubberUp());

    // Resize observer
    this._resizeObserver = new ResizeObserver(() => {
      if (this._open && this.graph) {
        this.graph.resize();
      }
    });
    this._resizeObserver.observe(this._canvasContainer);

    // Track video time for cursor + scrubber
    this.videoPlayer.video.addEventListener('timeupdate', () => {
      if (this._open && this.graph) {
        this.graph.setCursorTime(this.videoPlayer.currentTime * 1000);
        if (!this._dragMode && !this.graph._animating) this.graph.draw();
        this._updateScrubber();
      }
    });

    // Start/stop animation on play/pause
    this.videoPlayer.video.addEventListener('playing', () => {
      if (this._open && this.graph) this.graph.startAnimation();
    });
    this.videoPlayer.video.addEventListener('pause', () => {
      if (this._open && this.graph) {
        this.graph.stopAnimation();
        this.graph.draw();
      }
    });
  }

  // --- Mouse Handlers (OFS style) ---

  _onMouseDown(e) {
    this.graph.markInteraction();
    const { x, y } = this.graph.getCanvasCoords(e);
    const hitIdx = this.graph.hitTestAction(x, y);

    // Middle-click → pan
    if (e.button === 1) {
      e.preventDefault();
      this._dragMode = 'pan';
      this._dragStartX = x;
      this._canvasContainer.classList.add('editor__canvas-container--panning');
      return;
    }

    if (e.button !== 0) return;

    if (hitIdx >= 0) {
      // Clicked on an action dot
      if (e.ctrlKey || e.metaKey) {
        this.editableScript.toggleSelect(hitIdx);
      } else if (e.shiftKey && this._lastSelectedIndex >= 0) {
        // Shift+click on dot → range select OR start move drag
        this.editableScript.selectRange(this._lastSelectedIndex, hitIdx);
      } else if (!this.editableScript.selectedIndices.has(hitIdx)) {
        this.editableScript.select(hitIdx);
      }
      this._lastSelectedIndex = hitIdx;

      // Shift+click on dot → start move drag (OFS: shift+drag to move)
      if (e.shiftKey) {
        this._dragMode = 'move';
        this._dragStartX = x;
        this._dragStartY = y;
        this._dragStartTime = this.graph.xToTime(x);
        this._dragStartPos = this.graph.yToPos(y);
        this._canvasContainer.classList.add('editor__canvas-container--dragging');
        this.editableScript.beginBatch(); // throttle undo during drag
      }
    } else {
      // Clicked on empty area
      if (e.altKey) {
        // Alt+click on empty = insert action at this position (OFS style)
        const timeMs = this.snapTime(this.graph.xToTime(x));
        const pos = Math.round(this.graph.yToPos(y));
        const newIdx = this.editableScript.insertAction(timeMs, pos);
        this.editableScript.select(newIdx);
        this._lastSelectedIndex = newIdx;
        this._sendLivePreview(pos);
        return;
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl+click empty = start rubber band (additive)
        this._dragMode = 'rubber';
        this._dragStartX = x;
        this._dragStartY = y;
      } else if (e.shiftKey) {
        // Shift+click empty = rubber band
        this._dragMode = 'rubber';
        this._dragStartX = x;
        this._dragStartY = y;
      } else {
        // Plain left-click on empty area — rubber band drag
        this._dragMode = 'click-or-rubber';
        this._dragStartX = x;
        this._dragStartY = y;
      }
    }
  }

  _onMouseMove(e) {
    this.graph.markInteraction();
    const { x, y } = this.graph.getCanvasCoords(e);

    if (this._dragMode === 'pan') {
      const deltaMs = this.graph.xToTime(this._dragStartX) - this.graph.xToTime(x);
      this.graph.panBy(deltaMs);
      this._dragStartX = x;
      this._updateScrubber();
      return;
    }

    if (this._dragMode === 'move') {
      const currentTime = this.graph.xToTime(x);
      const currentPos = this.graph.yToPos(y);
      const deltaAt = currentTime - this._dragStartTime;
      const deltaPos = currentPos - this._dragStartPos;

      if (Math.abs(deltaAt) > 1 || Math.abs(deltaPos) > 0.5) {
        this.editableScript.moveActions(this.editableScript.selectedIndices, deltaAt, deltaPos);
        this._dragStartTime = currentTime;
        this._dragStartPos = currentPos;
      }
      return;
    }

    if (this._dragMode === 'rubber' || this._dragMode === 'click-or-rubber') {
      const dx = Math.abs(x - this._dragStartX);
      const dy = Math.abs(y - this._dragStartY);
      if (dx > 3 || dy > 3) {
        // Transitioned to a real drag — clear selection and become rubber band
        if (this._dragMode === 'click-or-rubber') {
          this._dragMode = 'rubber';
          this.editableScript.clearSelection();
        }
        this.graph.setRubberBand({
          x1: this._dragStartX,
          y1: this._dragStartY,
          x2: x,
          y2: y,
        });
        this.graph.draw();
      }
      return;
    }

    // Hover
    const hitIdx = this.graph.hitTestAction(x, y);
    if (hitIdx >= 0) {
      this.graph.setHover(hitIdx, x, y);
      this._canvas.style.cursor = 'pointer';
    } else {
      this.graph.clearHover();
      this._canvas.style.cursor = 'crosshair';
    }
    if (!this.graph._animating) this.graph.draw();
  }

  _onMouseUp(e) {
    const { x, y } = this.graph.getCanvasCoords(e);

    if (this._dragMode === 'click-or-rubber') {
      // Single click on empty area — no longer inserts (use numpad keys instead)
      this.graph.clearRubberBand();
    } else if (this._dragMode === 'rubber') {
      // Check if it was a click (not a drag)
      const dx = Math.abs(x - this._dragStartX);
      const dy = Math.abs(y - this._dragStartY);
      if (dx < 3 && dy < 3) {
        // Tiny rubber band → treat as click (no action for ctrl/shift clicks on empty)
      } else {
        // Rubber band selection
        const rect = {
          x1: this._dragStartX, y1: this._dragStartY,
          x2: x, y2: y,
        };
        const indices = this.graph.hitTestRect(rect);
        if (e.ctrlKey || e.metaKey) {
          for (const i of indices) this.editableScript.toggleSelect(i);
        } else {
          this.editableScript._selectedIndices = indices;
          this.editableScript._emit();
        }
      }
      this.graph.clearRubberBand();
    }

    this._dragMode = null;
    this.editableScript.endBatch(); // commit undo state for any drag
    this._canvasContainer.classList.remove('editor__canvas-container--dragging');
    this._canvasContainer.classList.remove('editor__canvas-container--panning');
    if (!this.graph._animating) this.graph.draw();
  }

  _onMouseLeave() {
    this.graph.clearHover();
    this.editableScript.endBatch(); // safety: end any active drag batch
    if (!this.graph._animating) this.graph.draw();
  }

  _onDoubleClick(e) {
    // OFS: double-click = SEEK video to that time
    const { x, y } = this.graph.getCanvasCoords(e);
    const hitIdx = this.graph.hitTestAction(x, y);
    if (hitIdx >= 0) return; // Double-clicked on existing action — no special behavior

    const time = this.graph.xToTime(x);
    if (time >= 0 && time <= this.graph._videoDurationMs) {
      this.videoPlayer.video.currentTime = time / 1000;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    this.graph.markInteraction();
    const { x } = this.graph.getCanvasCoords(e);
    const centerMs = this.graph.xToTime(x);

    if (e.shiftKey) {
      // Shift+scroll → pan
      const delta = e.deltaY > 0 ? 1 : -1;
      const panAmount = this.graph.viewDurationMs * 0.1 * delta;
      this.graph.panBy(panAmount);
    } else {
      // Scroll → zoom (with smooth easing during playback)
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      this.graph.zoomAt(centerMs, factor);
    }
    this._updateScrubber();
  }

  // --- Canvas Keyboard (OFS style) ---

  _onCanvasKeyDown(e) {
    this.graph.markInteraction();
    // Let Space propagate for play/pause
    if (e.key === ' ') return;

    const ctrl = e.ctrlKey || e.metaKey;

    // 0-9 keys: place action at current video time with fixed position
    // Works with both regular number row and numpad
    const numpadMap = {
      'Digit0': 0, 'Digit1': 11, 'Digit2': 22, 'Digit3': 33, 'Digit4': 44,
      'Digit5': 55, 'Digit6': 66, 'Digit7': 77, 'Digit8': 88, 'Digit9': 100,
      'Numpad0': 0, 'Numpad1': 11, 'Numpad2': 22, 'Numpad3': 33, 'Numpad4': 44,
      'Numpad5': 55, 'Numpad6': 66, 'Numpad7': 77, 'Numpad8': 88, 'Numpad9': 100,
    };
    if (e.code in numpadMap) {
      e.preventDefault();
      e.stopPropagation();
      const pos = numpadMap[e.code];

      if (this._recordingMode) {
        // Recording mode: insert at live playhead, don't select, don't pause
        const timeMs = this.snapTime(this.videoPlayer.currentTime * 1000);
        this.editableScript.insertAction(timeMs, pos);
        this._sendLivePreview(pos);
      } else {
        const sel = this.editableScript.selectedIndices;
        if (sel.size === 1) {
          const idx = [...sel][0];
          const newIdx = this.editableScript.updateAction(idx, { pos });
          this.editableScript.select(newIdx);
          this._lastSelectedIndex = newIdx;
          this._sendLivePreview(pos);
        } else {
          const timeMs = this.snapTime(this.videoPlayer.currentTime * 1000);
          const newIdx = this.editableScript.insertAction(timeMs, pos);
          this.editableScript.select(newIdx);
          this._lastSelectedIndex = newIdx;
          this._sendLivePreview(pos);
        }
      }
      return;
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        e.stopPropagation();
        this._deleteSelected();
        break;

      // Left/Right: jump selection between action points (Ctrl = frame step)
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        if (ctrl) {
          this.videoPlayer.stepFrame(-1);
        } else {
          this._selectAdjacentAction(-1);
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        if (ctrl) {
          this.videoPlayer.stepFrame(1);
        } else {
          this._selectAdjacentAction(1);
        }
        break;

      // Up/Down: nudge selected positions (Ctrl = fine ±1, plain = ±5)
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (this.editableScript.selectedIndices.size > 0) {
          const delta = ctrl ? 1 : 5;
          this.editableScript.moveActions(this.editableScript.selectedIndices, 0, delta);
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (this.editableScript.selectedIndices.size > 0) {
          const delta = ctrl ? -1 : -5;
          this.editableScript.moveActions(this.editableScript.selectedIndices, 0, delta);
        }
        break;

      case 'z':
      case 'Z':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) this.editableScript.redo();
          else this.editableScript.undo();
        }
        break;

      case 'y':
      case 'Y':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this.editableScript.redo();
        }
        break;

      case 'c':
      case 'C':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this.editableScript.copy();
          showToast(`Copied ${this.editableScript.selectedIndices.size} action(s)`, 'info');
        }
        break;

      case 'x':
      case 'X':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._cutSelected();
        }
        break;

      case 'v':
      case 'V':
        if (ctrl && e.shiftKey) {
          // Ctrl+Shift+V: Paste Exact (original timestamps)
          e.preventDefault();
          e.stopPropagation();
          this.editableScript.pasteExact();
        } else if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          const timeMs = this.videoPlayer.currentTime * 1000;
          this.editableScript.paste(timeMs);
        }
        break;

      case 'a':
      case 'A':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this.editableScript.selectAll();
        }
        break;

      // Ctrl+1/2/3: Select by position range (top/mid/bottom third)
      case '1':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this.editableScript.selectByPositionRange(67, 100); // top third
        }
        break;
      case '2':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this.editableScript.selectByPositionRange(34, 66); // middle third
        }
        break;
      case '3':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this.editableScript.selectByPositionRange(0, 33); // bottom third
        }
        break;

      // R: Toggle recording mode
      case 'r':
      case 'R':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._toggleRecordingMode();
        }
        break;

      case 'i':
      case 'I':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._invertSelected();
        }
        break;

      case 's':
      case 'S':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._save();
        }
        break;

      case 'b':
      case 'B':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._addBookmarkAtCursor();
        }
        break;

      case 'w':
      case 'W':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._toggleWaveform();
        }
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (this.editableScript.selectedIndices.size > 0) {
          this.editableScript.clearSelection();
        } else {
          this.hide();
        }
        break;

      case '+':
      case '=':
        e.preventDefault();
        e.stopPropagation();
        this._zoomIn();
        break;

      case '-':
        e.preventDefault();
        e.stopPropagation();
        this._zoomOut();
        break;

      default:
        break;
    }
  }

  // --- Actions ---

  _deleteSelected() {
    if (this.editableScript.selectedIndices.size === 0) return;
    this.editableScript.deleteActions(this.editableScript.selectedIndices);
  }

  _invertSelected() {
    if (this.editableScript.selectedIndices.size === 0) {
      showToast('Select actions to invert', 'info');
      return;
    }
    this.editableScript.invertSelection();
    showToast(`Inverted ${this.editableScript.selectedIndices.size} action(s)`, 'info');
  }

  _simplifySelected() {
    if (this.editableScript.selectedIndices.size < 3) {
      showToast('Select at least 3 actions to simplify', 'info');
      return;
    }
    const before = this.editableScript.selectedIndices.size;
    this.editableScript.simplify(2);
    const after = this.editableScript.selectedIndices.size;
    const removed = before - after;
    if (removed > 0) {
      showToast(`Simplified: removed ${removed} point(s)`, 'info');
    } else {
      showToast('No points removed (all significant)', 'info');
    }
  }

  _cutSelected() {
    if (this.editableScript.selectedIndices.size === 0) return;
    const count = this.editableScript.selectedIndices.size;
    this.editableScript.cut();
    showToast(`Cut ${count} action(s)`, 'info');
  }

  _zoomIn() {
    const center = this.graph._cursorMs || (this.graph.viewStartMs + this.graph.viewDurationMs / 2);
    this.graph.zoomAt(center, 1 / 1.5);
  }

  _zoomOut() {
    const center = this.graph._cursorMs || (this.graph.viewStartMs + this.graph.viewDurationMs / 2);
    this.graph.zoomAt(center, 1.5);
  }

  /**
   * Select the next or previous action point relative to the current selection.
   * Centers the graph on that point and seeks the video to its time.
   * @param {1|-1} direction — 1 = next, -1 = previous
   */
  _selectAdjacentAction(direction) {
    const actions = this.editableScript.actions;
    if (actions.length === 0) return;

    // Find current index — use the single selected point, or find nearest to cursor
    let currentIdx = -1;
    const sel = this.editableScript.selectedIndices;
    if (sel.size === 1) {
      currentIdx = [...sel][0];
    } else if (sel.size > 1) {
      // Multiple selected: jump from the edge in the direction of travel
      const sorted = [...sel].sort((a, b) => a - b);
      currentIdx = direction > 0 ? sorted[sorted.length - 1] : sorted[0];
    } else {
      // Nothing selected — find nearest action to current video time
      const timeMs = this.videoPlayer.currentTime * 1000;
      let bestDist = Infinity;
      for (let i = 0; i < actions.length; i++) {
        const dist = Math.abs(actions[i].at - timeMs);
        if (dist < bestDist) {
          bestDist = dist;
          currentIdx = i;
        }
      }
    }

    // Move to adjacent
    let nextIdx = currentIdx + direction;
    nextIdx = Math.max(0, Math.min(actions.length - 1, nextIdx));

    // Select it
    this.editableScript.select(nextIdx);
    this._lastSelectedIndex = nextIdx;

    // Seek video to this action's time
    const action = actions[nextIdx];
    this.videoPlayer.video.currentTime = action.at / 1000;

    // Center graph on this action with a comfortable zoom
    this.graph.centerOnTime(action.at);
    this.graph.draw();
    this._updateScrubber();
  }

  // --- Scrubber ---

  _onScrubberDown(e) {
    this._scrubberDragging = true;
    this._scrubberSeek(e);
  }

  _onScrubberMove(e) {
    if (!this._scrubberDragging) return;
    this._scrubberSeek(e);
  }

  _onScrubberUp() {
    this._scrubberDragging = false;
  }

  _scrubberSeek(e) {
    const rect = this._scrubberTrack.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    const totalMs = this._getScrubberTotalMs();
    const targetMs = pct * totalMs;

    // Center the graph viewport on the clicked position
    this.graph.centerOnTime(targetMs);

    // Seek the video
    this.videoPlayer.video.currentTime = targetMs / 1000;

    this.graph.draw();
    this._updateScrubber();
  }

  /** Get the total timeline length for the scrubber (video duration or last action). */
  _getScrubberTotalMs() {
    const videoDurMs = (this.videoPlayer.duration || 0) * 1000;
    const actions = this.editableScript.actions;
    const lastActionMs = actions.length > 0 ? actions[actions.length - 1].at : 0;
    return Math.max(videoDurMs, lastActionMs, 1000);
  }

  /** Update scrubber viewport indicator and cursor position. */
  _updateScrubber() {
    if (!this._scrubberTrack || !this.graph) return;
    const totalMs = this._getScrubberTotalMs();
    if (totalMs <= 0) return;

    // Viewport indicator (the visible window in the graph)
    const startPct = (this.graph.viewStartMs / totalMs) * 100;
    const endPct = (this.graph.viewEndMs / totalMs) * 100;
    this._scrubberViewport.style.left = `${startPct}%`;
    this._scrubberViewport.style.width = `${Math.max(1, endPct - startPct)}%`;

    // Playback cursor line
    const cursorPct = (this.videoPlayer.currentTime * 1000 / totalMs) * 100;
    this._scrubberCursor.style.left = `${cursorPct}%`;
  }

  _onSpeedChange() {
    const rate = parseFloat(this._speedSelect.value);
    this._setSpeed(rate);
  }

  _setSpeed(rate) {
    this.videoPlayer.video.playbackRate = rate;
    this._speedSelect.value = String(rate);

    // Warn if Handy connected and rate != 1
    if (rate !== 1 && this.handyManager?.connected) {
      if (this.syncEngine) this.syncEngine.stop();
      showToast('Sync paused — playback speed changed', 'warn');
    } else if (rate === 1 && this.handyManager?.connected && this.syncEngine) {
      this.syncEngine.start();
    }
  }

  // --- Modify Dropdown ---

  async _onModifyChange() {
    const value = this._modifySelect.value;
    this._modifySelect.selectedIndex = 0; // reset to placeholder

    switch (value) {
      case 'halfSpeed':
        this.editableScript.applyModifier(halfSpeed);
        showToast('Applied: Half Speed', 'info');
        break;
      case 'doubleSpeed':
        this.editableScript.applyModifier(doubleSpeed);
        showToast('Applied: Double Speed', 'info');
        break;
      case 'reverse':
        this.editableScript.applyModifier(reverseActions);
        showToast('Applied: Reverse', 'info');
        break;
      case 'remapRange':
        await this._openRemapRangeModal();
        break;
      case 'offsetTime':
        await this._openOffsetTimeModal();
        break;
      case 'removePauses':
        await this._openRemovePausesModal();
        break;
      case 'rangeExtend':
        await this._openRangeExtendModal();
        break;
      case 'generatePattern':
        await this._openPatternModal();
        break;
    }
  }

  // --- Modal dialogs for parameterized modifiers ---

  async _openRemapRangeModal() {
    const result = await Modal.open({
      title: 'Remap Range',
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">New Min Position<input type="number" id="remap-min" min="0" max="100" value="0" class="modal-input"></label>
            <label class="modal-label">New Max Position<input type="number" id="remap-max" min="0" max="100" value="100" class="modal-input"></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="remap-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="remap-ok">Apply</button>
          </div>`;
        body.querySelector('#remap-cancel').addEventListener('click', () => close(null));
        body.querySelector('#remap-ok').addEventListener('click', () => {
          close({
            min: parseInt(body.querySelector('#remap-min').value) || 0,
            max: parseInt(body.querySelector('#remap-max').value) || 100,
          });
        });
      },
    });
    if (result) {
      this.editableScript.applyModifier(remapRange, result.min, result.max);
      showToast(`Remapped to ${result.min}–${result.max}`, 'info');
    }
  }

  async _openOffsetTimeModal() {
    const result = await Modal.open({
      title: 'Offset Time',
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">Offset (ms)<input type="number" id="offset-ms" value="0" class="modal-input" step="100"></label>
            <div class="modal-hint">Positive = shift later, negative = shift earlier</div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="offset-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="offset-ok">Apply</button>
          </div>`;
        body.querySelector('#offset-cancel').addEventListener('click', () => close(null));
        body.querySelector('#offset-ok').addEventListener('click', () => {
          close({ deltaMs: parseInt(body.querySelector('#offset-ms').value) || 0 });
        });
      },
    });
    if (result && result.deltaMs !== 0) {
      this.editableScript.applyModifier(offsetTime, result.deltaMs);
      showToast(`Offset by ${result.deltaMs}ms`, 'info');
    }
  }

  async _openRemovePausesModal() {
    const result = await Modal.open({
      title: 'Remove Pauses',
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">Max gap threshold (ms)<input type="number" id="pause-gap" min="100" value="5000" class="modal-input" step="500"></label>
            <div class="modal-hint">Gaps longer than this will be collapsed</div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="pause-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="pause-ok">Apply</button>
          </div>`;
        body.querySelector('#pause-cancel').addEventListener('click', () => close(null));
        body.querySelector('#pause-ok').addEventListener('click', () => {
          close({ maxGapMs: parseInt(body.querySelector('#pause-gap').value) || 5000 });
        });
      },
    });
    if (result) {
      this.editableScript.applyModifier(removePauses, result.maxGapMs);
      showToast('Pauses removed', 'info');
    }
  }

  async _openRangeExtendModal() {
    const sel = this.editableScript.selectedIndices;
    if (sel.size < 2) {
      showToast('Select 2+ actions to extend/compress', 'warn');
      return;
    }
    const result = await Modal.open({
      title: 'Range Extend / Compress',
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">Time Scale Factor<input type="number" id="extend-factor" value="1.0" step="0.1" min="0.1" max="10" class="modal-input"></label>
            <div class="modal-hint">1.0 = no change, 2.0 = double duration, 0.5 = half duration</div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="extend-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="extend-ok">Apply</button>
          </div>`;
        body.querySelector('#extend-cancel').addEventListener('click', () => close(null));
        body.querySelector('#extend-ok').addEventListener('click', () => {
          close({ factor: parseFloat(body.querySelector('#extend-factor').value) || 1 });
        });
      },
    });
    if (result && result.factor !== 1) {
      const sorted = [...sel].sort((a, b) => a - b);
      const actions = this.editableScript.actions;
      const anchorTime = actions[sorted[0]].at;
      this.editableScript.beginBatch();
      // Scale timestamps relative to first selected action
      for (const i of sorted) {
        const offset = actions[i].at - anchorTime;
        const newAt = Math.round(anchorTime + offset * result.factor);
        this.editableScript.updateAction(i, { at: newAt });
      }
      this.editableScript.endBatch();
      showToast(`Time scaled by ${result.factor}x`, 'info');
    }
  }

  _toggleRecordingMode() {
    this._recordingMode = !this._recordingMode;
    this._recordingIndicator.hidden = !this._recordingMode;

    if (this._recordingMode) {
      showToast('Recording mode ON — numpad keys insert at live playhead', 'info');
      // In recording mode, start video if paused
      if (this.videoPlayer.video.paused) {
        this.videoPlayer.video.play();
      }
    } else {
      showToast('Recording mode OFF', 'info');
    }
  }

  async _openPatternModal() {
    const sel = this.editableScript.selectedIndices;
    const actions = this.editableScript.actions;
    let defaultStart = Math.round(this.videoPlayer.currentTime * 1000);
    let defaultEnd = defaultStart + 5000;

    // Default to selection range if available
    if (sel.size >= 2) {
      const sorted = [...sel].sort((a, b) => a - b);
      defaultStart = actions[sorted[0]].at;
      defaultEnd = actions[sorted[sorted.length - 1]].at;
    }

    const result = await Modal.open({
      title: 'Generate Pattern',
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">Pattern
              <select id="pat-type" class="modal-input">
                <option value="sine">Sine</option>
                <option value="sawtooth">Sawtooth</option>
                <option value="square">Square</option>
                <option value="triangle">Triangle</option>
                <option value="escalating">Escalating</option>
                <option value="random">Random</option>
              </select>
            </label>
            <label class="modal-label">BPM<input type="number" id="pat-bpm" min="10" max="600" value="120" class="modal-input"></label>
            <label class="modal-label">Min Position<input type="number" id="pat-min" min="0" max="100" value="0" class="modal-input"></label>
            <label class="modal-label">Max Position<input type="number" id="pat-max" min="0" max="100" value="100" class="modal-input"></label>
            <label class="modal-label">Start (ms)<input type="number" id="pat-start" min="0" value="${defaultStart}" class="modal-input"></label>
            <label class="modal-label">End (ms)<input type="number" id="pat-end" min="0" value="${defaultEnd}" class="modal-input"></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="pat-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="pat-ok">Generate</button>
          </div>`;
        body.querySelector('#pat-cancel').addEventListener('click', () => close(null));
        body.querySelector('#pat-ok').addEventListener('click', () => {
          close({
            type: body.querySelector('#pat-type').value,
            bpm: parseInt(body.querySelector('#pat-bpm').value) || 120,
            min: parseInt(body.querySelector('#pat-min').value) || 0,
            max: parseInt(body.querySelector('#pat-max').value) || 100,
            start: parseInt(body.querySelector('#pat-start').value) || 0,
            end: parseInt(body.querySelector('#pat-end').value) || 5000,
          });
        });
      },
    });
    if (result) {
      const pattern = generatePattern(result.type, result.start, result.end, result.bpm, result.min, result.max);
      if (pattern.length > 0) {
        this.editableScript.insertActions(pattern);
        showToast(`Inserted ${pattern.length} actions (${result.type})`, 'info');
      } else {
        showToast('No actions generated — check parameters', 'warn');
      }
    }
  }

  // --- Metadata Modal ---

  async _openMetadataModal() {
    const meta = this.editableScript.getMetadata();
    const md = meta.metadata || {};
    const defaultCreator = dataService.get('editor.defaultCreator') || '';

    const result = await Modal.open({
      title: 'Script Metadata',
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">Title<input type="text" id="meta-title" value="${_esc(md.title || '')}" class="modal-input"></label>
            <label class="modal-label">Creator<input type="text" id="meta-creator" value="${_esc(md.creator || defaultCreator)}" class="modal-input"></label>
            <label class="modal-label">Description<textarea id="meta-desc" class="modal-input modal-textarea" rows="2">${_esc(md.description || '')}</textarea></label>
            <label class="modal-label">Tags (comma-separated)<input type="text" id="meta-tags" value="${_esc((md.tags || []).join(', '))}" class="modal-input"></label>
            <label class="modal-label">Performers (comma-separated)<input type="text" id="meta-performers" value="${_esc((md.performers || []).join(', '))}" class="modal-input"></label>
            <label class="modal-label">License<input type="text" id="meta-license" value="${_esc(md.license || '')}" class="modal-input"></label>
            <label class="modal-label">Notes<textarea id="meta-notes" class="modal-input modal-textarea" rows="2">${_esc(md.notes || '')}</textarea></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="meta-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="meta-ok">Save</button>
          </div>`;
        body.querySelector('#meta-cancel').addEventListener('click', () => close(null));
        body.querySelector('#meta-ok').addEventListener('click', () => {
          const tags = body.querySelector('#meta-tags').value.split(',').map(s => s.trim()).filter(Boolean);
          const performers = body.querySelector('#meta-performers').value.split(',').map(s => s.trim()).filter(Boolean);
          close({
            title: body.querySelector('#meta-title').value.trim(),
            creator: body.querySelector('#meta-creator').value.trim(),
            description: body.querySelector('#meta-desc').value.trim(),
            tags,
            performers,
            license: body.querySelector('#meta-license').value.trim(),
            notes: body.querySelector('#meta-notes').value.trim(),
          });
        });
      },
    });
    if (result) {
      const fields = ['title', 'creator', 'description', 'tags', 'performers', 'license', 'notes'];
      for (const field of fields) {
        if (result[field] !== undefined) {
          const val = result[field];
          // Only set non-empty values (or arrays)
          if (Array.isArray(val) ? val.length > 0 : val) {
            this.editableScript.setMetadataField(field, val);
          }
        }
      }
      // Save default creator preference
      if (result.creator) {
        dataService.set('editor.defaultCreator', result.creator);
      }
      showToast('Metadata updated', 'info');
    }
  }

  // --- Bookmark ---

  async _addBookmarkAtCursor() {
    const timeMs = this.videoPlayer.currentTime * 1000;
    const name = await Modal.prompt('Bookmark name', 'e.g. Scene start');
    if (name !== null) {
      this.editableScript.addBookmark(timeMs, name || '');
      showToast(`Bookmark added at ${this._formatTimeForToast(timeMs)}`, 'info');
    }
  }

  // --- Waveform ---

  async _toggleWaveform() {
    this._waveformEnabled = !this._waveformEnabled;
    this._btnWaveform.classList.toggle('editor__btn--active', this._waveformEnabled);

    if (!this._waveformEnabled) {
      this.graph.setShowWaveform(false);
      if (!this.graph._animating) this.graph.draw();
      return;
    }

    // Check cache first
    const videoSrc = this.videoPlayer.video.src;
    if (!videoSrc) {
      showToast('No video loaded', 'warn');
      this._waveformEnabled = false;
      this._btnWaveform.classList.remove('editor__btn--active');
      return;
    }

    const cached = getCachedPeaks(videoSrc);
    if (cached) {
      this.graph.setWaveformData(cached);
      this.graph.setShowWaveform(true);
      if (!this.graph._animating) this.graph.draw();
      return;
    }

    // Extract peaks — show progress in status bar
    const origStatus = this._statusEl.textContent;
    this._statusEl.textContent = 'Extracting waveform\u2026';

    const data = await extractPeaks(videoSrc, 100, (pct) => {
      this._statusEl.textContent = `Extracting waveform\u2026 ${Math.round(pct * 100)}%`;
    });

    if (data && this._waveformEnabled) {
      this.graph.setWaveformData(data);
      this.graph.setShowWaveform(true);
      if (!this.graph._animating) this.graph.draw();
      showToast('Waveform loaded', 'info');
    } else if (!data) {
      showToast('Could not extract waveform', 'warn');
      this._waveformEnabled = false;
      this._btnWaveform.classList.remove('editor__btn--active');
    }

    this._updateStatus();
  }

  /** Clear waveform data when video changes. */
  _clearWaveform() {
    this._waveformEnabled = false;
    if (this._btnWaveform) {
      this._btnWaveform.classList.remove('editor__btn--active');
    }
    if (this.graph) {
      this.graph.setWaveformData(null);
      this.graph.setShowWaveform(false);
    }
  }

  // --- Beat Detection ---

  async _openBeatModal() {
    const videoSrc = this.videoPlayer.video.src;
    if (!videoSrc) {
      showToast('No video loaded', 'warn');
      return;
    }

    // Detect beats (with progress in status bar)
    let beatData = getCachedBeats(videoSrc);
    if (!beatData) {
      const origStatus = this._statusEl.textContent;
      this._statusEl.textContent = 'Detecting beats\u2026';

      beatData = await detectBeats(videoSrc, {}, (pct) => {
        this._statusEl.textContent = `Detecting beats\u2026 ${Math.round(pct * 100)}%`;
      });

      this._updateStatus();

      if (!beatData || beatData.count === 0) {
        showToast('No beats detected', 'warn');
        return;
      }
    }

    // Show beat markers on graph
    this.graph.setBeatMarkers(beatData.beats);
    this.graph.setShowBeatMarkers(true);
    if (!this.graph._animating) this.graph.draw();

    // Open config modal
    const sel = this.editableScript.selectedIndices;
    const actions = this.editableScript.actions;
    let defaultStart = 0;
    let defaultEnd = Math.round((this.videoPlayer.duration || 0) * 1000);

    if (sel.size >= 2) {
      const sorted = [...sel].sort((a, b) => a - b);
      defaultStart = actions[sorted[0]].at;
      defaultEnd = actions[sorted[sorted.length - 1]].at;
    }

    const result = await Modal.open({
      title: `Generate from Beats (${beatData.count} detected, ~${beatData.averageBPM} BPM)`,
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">Mapping Style
              <select id="beat-style" class="modal-input">
                <option value="alternating">Alternating (0/100)</option>
                <option value="sine">Sine Wave</option>
                <option value="energy">Energy-mapped</option>
              </select>
            </label>
            <label class="modal-label">Min Position<input type="number" id="beat-min" min="0" max="100" value="0" class="modal-input"></label>
            <label class="modal-label">Max Position<input type="number" id="beat-max" min="0" max="100" value="100" class="modal-input"></label>
            <label class="modal-label">Start (ms)<input type="number" id="beat-start" min="0" value="${defaultStart}" class="modal-input"></label>
            <label class="modal-label">End (ms)<input type="number" id="beat-end" min="0" value="${defaultEnd}" class="modal-input"></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="beat-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="beat-ok">Generate</button>
          </div>`;
        body.querySelector('#beat-cancel').addEventListener('click', () => close(null));
        body.querySelector('#beat-ok').addEventListener('click', () => {
          close({
            style: body.querySelector('#beat-style').value,
            min: parseInt(body.querySelector('#beat-min').value) || 0,
            max: parseInt(body.querySelector('#beat-max').value) || 100,
            start: parseInt(body.querySelector('#beat-start').value) || 0,
            end: parseInt(body.querySelector('#beat-end').value) || defaultEnd,
          });
        });
      },
    });

    if (result) {
      // Filter beats to the selected time range
      const filteredBeats = beatData.beats.filter(t => t >= result.start && t <= result.end);
      if (filteredBeats.length === 0) {
        showToast('No beats in selected range', 'warn');
        return;
      }

      const newActions = beatsToActions(
        Float64Array.from(filteredBeats),
        result.style,
        result.min,
        result.max,
      );
      if (newActions.length > 0) {
        this.editableScript.insertActions(newActions);
        showToast(`Inserted ${newActions.length} actions from beats`, 'info');
      }
    }
  }

  /** Clear beat markers when video changes. */
  _clearBeatMarkers() {
    if (this.graph) {
      this.graph.setBeatMarkers(null);
      this.graph.setShowBeatMarkers(false);
    }
  }

  _formatTimeForToast(ms) {
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- Fill Gaps Modal ---

  async _openFillGapsModal() {
    const actions = this.editableScript.actions;
    if (actions.length < 2) {
      showToast('Need at least 2 actions to detect gaps', 'info');
      return;
    }

    const videoDurationMs = (this.videoPlayer.duration || 0) * 1000;
    const gaps = detectGaps(actions, 3000, videoDurationMs);
    if (gaps.length === 0) {
      showToast('No gaps detected (threshold: 3s)', 'info');
      return;
    }

    const result = await Modal.open({
      title: `Fill Gaps (${gaps.length} found)`,
      onRender(body, close) {
        let html = '<div class="modal-form">';
        html += '<div class="modal-gap-list" style="max-height:200px;overflow-y:auto;margin-bottom:8px;">';
        for (let i = 0; i < gaps.length; i++) {
          const g = gaps[i];
          const startSec = (g.startMs / 1000).toFixed(1);
          const endSec = (g.endMs / 1000).toFixed(1);
          const durSec = (g.durationMs / 1000).toFixed(1);
          html += `<label class="modal-label" style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="gap-checkbox" data-index="${i}" checked>
            <span>${startSec}s \u2013 ${endSec}s (${durSec}s)</span>
          </label>`;
        }
        html += '</div>';
        html += `
          <label class="modal-label">Pattern
            <select id="fill-type" class="modal-input">
              <option value="sine">Sine</option>
              <option value="sawtooth">Sawtooth</option>
              <option value="square">Square</option>
              <option value="triangle">Triangle</option>
              <option value="random">Random</option>
            </select>
          </label>
          <label class="modal-label">BPM<input type="number" id="fill-bpm" min="10" max="600" value="120" class="modal-input"></label>
          <label class="modal-label">Min Position<input type="number" id="fill-min" min="0" max="100" value="0" class="modal-input"></label>
          <label class="modal-label">Max Position<input type="number" id="fill-max" min="0" max="100" value="100" class="modal-input"></label>
        </div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn--secondary" id="fill-cancel">Cancel</button>
          <button class="modal-btn modal-btn--primary" id="fill-ok">Fill Selected</button>
        </div>`;
        body.innerHTML = html;
        body.querySelector('#fill-cancel').addEventListener('click', () => close(null));
        body.querySelector('#fill-ok').addEventListener('click', () => {
          const checked = [...body.querySelectorAll('.gap-checkbox:checked')].map(cb => parseInt(cb.dataset.index));
          close({
            gapIndices: checked,
            type: body.querySelector('#fill-type').value,
            bpm: parseInt(body.querySelector('#fill-bpm').value) || 120,
            min: parseInt(body.querySelector('#fill-min').value) || 0,
            max: parseInt(body.querySelector('#fill-max').value) || 100,
          });
        });
      },
    });
    if (result && result.gapIndices.length > 0) {
      const selectedGaps = result.gapIndices.map(i => gaps[i]);
      const filled = fillGaps(selectedGaps, result.type, result.bpm, result.min, result.max);
      if (filled.length > 0) {
        this.editableScript.insertActions(filled);
        showToast(`Filled ${result.gapIndices.length} gap(s) with ${filled.length} actions`, 'info');
      }
    }
  }

  // --- Save / Autosave ---

  async _save() {
    const json = this.editableScript.toFunscriptJSON();

    // If we have a known path, write directly (autosave-style)
    if (this._funscriptPath) {
      try {
        const savedPath = await window.funsync.writeFunscript(json, this._funscriptPath);
        if (savedPath) {
          this.editableScript.markSaved();
          this._updateStatus();
          showToast('Funscript saved', 'info');
          this._reloadIntoEngineAndSync();
        }
      } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
      }
      return;
    }

    // No known path — use Save As dialog
    let suggestedName = 'script.funscript';
    const videoName = this._getVideoName();
    if (videoName) {
      suggestedName = videoName.replace(/\.[^/.]+$/, '') + '.funscript';
    }

    try {
      const savedPath = await window.funsync.saveFunscript(json, suggestedName);
      if (savedPath) {
        this._funscriptPath = savedPath;
        this.editableScript.markSaved();
        this._updateStatus();
        showToast('Funscript saved', 'info');
        this._reloadIntoEngineAndSync();
      }
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    }
  }

  /** Debounced autosave — called after every script mutation. */
  _triggerAutosave() {
    if (!this._autosaveEnabled) return;
    if (!this._funscriptPath) return;
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => this._autosave(), this._autosaveDelay);
  }

  async _autosave() {
    if (!this._funscriptPath || !this.editableScript.dirty) return;

    if (this._autosaveStatusEl) {
      this._autosaveStatusEl.textContent = 'Saving...';
      this._autosaveStatusEl.classList.add('editor__autosave-status--saving');
    }

    const json = this.editableScript.toFunscriptJSON();

    try {
      const savedPath = await window.funsync.writeFunscript(json, this._funscriptPath);
      if (savedPath) {
        this.editableScript.markSaved();
        this._updateStatus();
        this._reloadIntoEngineAndSync();

        if (this._autosaveStatusEl) {
          const now = new Date();
          const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          this._autosaveStatusEl.textContent = `Saved ${time}`;
          this._autosaveStatusEl.classList.remove('editor__autosave-status--saving');
        }
      }
    } catch (err) {
      console.warn('[Editor] Autosave failed:', err.message);
      if (this._autosaveStatusEl) {
        this._autosaveStatusEl.textContent = 'Save failed';
        this._autosaveStatusEl.classList.remove('editor__autosave-status--saving');
      }
    }
  }

  /** Reload actions into the funscript engine and re-upload to Handy. */
  async _reloadIntoEngineAndSync() {
    const actions = this.editableScript.actions;
    if (actions.length === 0) return; // nothing to sync

    if (!this.funscriptEngine.isLoaded) {
      // Engine wasn't loaded yet (e.g. we auto-created an empty script).
      // Now that we have actions, load the full funscript into the engine.
      const json = this.editableScript.toFunscriptJSON();
      try {
        await this.funscriptEngine.loadContent(json, this._funscriptPath?.split(/[\\/]/).pop() || 'script.funscript');
      } catch (err) {
        console.warn('[Editor] Failed to load script into engine:', err.message);
        return;
      }
    } else {
      this.funscriptEngine.reloadActions(actions);
    }
    this._refreshHeatmap();
    this._reuploadToHandy();
  }

  _getVideoName() {
    const titleEl = document.getElementById('video-title');
    return titleEl?.textContent || null;
  }

  // --- Script Changed Callback ---

  _onScriptChanged() {
    this._updateStatus();
    this._updateToolbarState();
    if (this.graph && !this.graph._animating) {
      this.graph.draw();
    }
    this._refreshHeatmap();
    this._updateScrubber();
    this._triggerAutosave();
  }

  _refreshHeatmap() {
    const duration = this.videoPlayer.duration;
    if (isFinite(duration) && duration > 0 && this.editableScript.actions.length >= 2) {
      this.progressBar.renderHeatmap(this.editableScript.actions, duration);
    }
  }

  async _reuploadToHandy() {
    if (!this.handyManager?.connected || !this.syncEngine) return;

    try {
      this.syncEngine.stop();
      const rawContent = this.funscriptEngine.getRawContent();
      if (rawContent) {
        const ok = await this.handyManager.uploadAndSetScript(rawContent);
        if (ok) {
          this.syncEngine._scriptReady = true;
          this.syncEngine.start();
        }
      }
    } catch (err) {
      console.warn('[Editor] Handy re-upload failed:', err.message);
    }
  }

  _updateStatus() {
    if (!this._statusEl) return;
    const count = this.editableScript.actionCount;
    const selected = this.editableScript.selectedIndices.size;
    const dirty = this.editableScript.dirty;

    let text = `${count} action${count !== 1 ? 's' : ''}`;
    if (selected > 0) text += ` (${selected} selected)`;
    if (dirty) text += ' *';

    this._statusEl.textContent = text;
    this._statusEl.className = dirty ? 'editor__status editor__status--dirty' : 'editor__status';
  }

  _updateToolbarState() {
    if (this._btnUndo) this._btnUndo.disabled = !this.editableScript.canUndo;
    if (this._btnRedo) this._btnRedo.disabled = !this.editableScript.canRedo;
  }

  // --- Public API ---

  /**
   * Set the funscript file path (for autosave).
   * Called by app.js when a funscript is loaded or auto-created.
   */
  setFunscriptPath(path) {
    this._funscriptPath = path || null;
  }

  /**
   * Load or reload the script into the editor.
   * Called by app.js after a funscript is loaded or when opening editor without a funscript.
   */
  loadScript() {
    this._clearWaveform();
    this._clearBeatMarkers();

    if (this.funscriptEngine.isLoaded) {
      this.editableScript.loadFromEngine(this.funscriptEngine);
    } else {
      this.editableScript.loadEmpty();
    }

    const duration = this.videoPlayer.duration;
    if (isFinite(duration) && duration > 0) {
      this.graph.setVideoDuration(duration * 1000);
    }

    if (this.editableScript.actionCount > 100) {
      const cursorMs = this.videoPlayer.currentTime * 1000;
      this.graph.smartZoom(cursorMs);
    } else {
      this.graph.fitAll();
    }
    this._updateStatus();
    this._updateToolbarState();
    this._updateScrubber();
  }

  toggle() {
    if (this._open) this.hide();
    else this.show();
  }

  show() {
    if (this._open) return;
    this._open = true;

    // Auto-create funscript if none loaded and we have a video path
    this._ensureFunscript();

    // Ensure script data is loaded
    if (this.editableScript.actionCount === 0 && !this.editableScript.dirty) {
      this.loadScript();
    }

    // Update video duration if available
    const duration = this.videoPlayer.duration;
    if (isFinite(duration) && duration > 0) {
      this.graph.setVideoDuration(duration * 1000);
    }

    this._panel.classList.add('script-editor--open');
    document.getElementById('player-container')?.classList.add('player-container--editor-open');

    // Resize canvas after layout settles
    requestAnimationFrame(() => {
      this.graph.resize();
      this.graph.setCursorTime(this.videoPlayer.currentTime * 1000);
      this.graph.draw();
      this._updateScrubber();
    });

    // Start animation if video is playing
    if (!this.videoPlayer.video.paused) {
      this.graph.startAnimation();
    }

    this._canvas.focus();
    this._previousPlaybackRate = this.videoPlayer.video.playbackRate;
  }

  hide() {
    if (!this._open) return;
    this._open = false;

    // Flush pending autosave before closing (only if autosave is enabled)
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
      if (this._autosaveEnabled && this.editableScript.dirty && this._funscriptPath) {
        this._autosave();
      }
    }

    this._panel.classList.remove('script-editor--open');
    document.getElementById('player-container')?.classList.remove('player-container--editor-open');

    this.graph.stopAnimation();

    // Restore playback speed to 1x
    if (this.videoPlayer.video.playbackRate !== 1) {
      this.videoPlayer.video.playbackRate = 1;
      this._speedSelect.value = '1';
      // Re-enable sync if it was paused
      if (this.handyManager?.connected && this.syncEngine) {
        this.syncEngine.start();
      }
    }
  }

  get isOpen() {
    return this._open;
  }

  /**
   * Auto-create a funscript file if the video has no associated funscript.
   * Creates an empty .funscript at the same path as the video file.
   */
  async _ensureFunscript() {
    if (this.funscriptEngine.isLoaded) return;

    // Need a video path to derive the funscript path
    const videoPath = this._getVideoPath();
    if (!videoPath) return;

    // Build funscript path: same directory, same base name, .funscript extension
    const funscriptPath = videoPath.replace(/\.[^/.]+$/, '') + '.funscript';
    this._funscriptPath = funscriptPath;

    // Create minimal funscript JSON (with a placeholder action so the engine accepts it)
    const emptyScript = JSON.stringify({
      version: '1.0',
      inverted: false,
      range: 100,
      actions: [],
    }, null, 2);

    try {
      // Write to disk
      await window.funsync.writeFunscript(emptyScript, funscriptPath);

      // Don't load into funscript engine — it rejects empty action arrays.
      // Instead, just set up the editor with an empty script.
      // The engine will be loaded on first autosave (when actions exist).
      this.editableScript.loadEmpty();
      this._updateStatus();

      const name = funscriptPath.split(/[\\/]/).pop();
      showToast(`Created ${name}`, 'info');

      // Show funscript badge
      const badge = document.getElementById('funscript-badge');
      if (badge) {
        badge.title = `${name} — 0 actions`;
        badge.hidden = false;
        if (!badge.querySelector('svg')) {
          const { icon: makeIcon, FileCheck } = await import('../js/icons.js');
          badge.appendChild(makeIcon(FileCheck, { width: 20, height: 20, 'stroke-width': 1.75 }));
        }
      }
    } catch (err) {
      console.warn('[Editor] Failed to auto-create funscript:', err.message);
    }
  }

  _getVideoPath() {
    // Access the video path from the app's state via the video element's src
    // The app stores _currentVideoPath — we need to access it
    // We'll use a data attribute set by app.js
    return document.getElementById('player-container')?.dataset?.videoPath || null;
  }

  // --- Multi-Script Selector ---

  /**
   * Set available scripts for the dropdown (called by app.js when multi-axis/custom routing is active).
   * @param {Array<{label: string, path: string}>} scripts
   */
  setAvailableScripts(scripts) {
    this._availableScripts = scripts || [];
    this._updateScriptSelect();
  }

  _updateScriptSelect() {
    if (!this._scriptSelect) return;
    const show = this._availableScripts.length > 1;
    this._scriptSelect.hidden = !show;

    // Also show/hide the separator
    const sep = this._panel?.querySelector('.editor__script-sep');
    if (sep) sep.hidden = !show;

    if (!show) return;

    this._scriptSelect.innerHTML = '';
    for (const s of this._availableScripts) {
      const opt = document.createElement('option');
      opt.value = s.path;
      opt.textContent = s.label;
      this._scriptSelect.appendChild(opt);
    }
    if (this._funscriptPath) {
      this._scriptSelect.value = this._funscriptPath;
    }
  }

  async _onScriptSelectChange() {
    const newPath = this._scriptSelect.value;
    if (!newPath || newPath === this._funscriptPath) return;

    // Cache current undo state before switching
    this._cacheUndoState();

    // Flush pending autosave
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
      if (this._autosaveEnabled && this.editableScript.dirty && this._funscriptPath) {
        await this._autosave();
      }
    }

    // Load the new script from disk
    this._funscriptPath = newPath;
    try {
      const content = await window.funsync.readFunscript(newPath);
      if (content) {
        const parsed = JSON.parse(content);
        this.editableScript.loadFromData(parsed);

        // Restore undo/redo stacks if we have a cache (but keep fresh actions from disk)
        const cached = this._undoCache.get(newPath);
        if (cached) {
          const deserializeStack = (stack) => stack.map(entry => ({
            ...entry,
            selectedIndices: new Set(entry.selectedIndices || []),
          }));
          this.editableScript._undoStack = deserializeStack(JSON.parse(JSON.stringify(cached.undoStack)));
          this.editableScript._redoStack = deserializeStack(JSON.parse(JSON.stringify(cached.redoStack)));
          this.editableScript._selectedIndices = new Set(cached.selectedIndices);
          this.editableScript._dirty = cached.dirty;
        }

        this.graph?.fitAll();
        this._updateToolbarState();
        this._statusEl.textContent = newPath.split(/[\\/]/).pop();
      }
    } catch (err) {
      console.warn('[Editor] Failed to load script:', err.message);
    }
  }

  // --- Undo Stack Cache ---

  clearUndoCache() {
    this._undoCache.clear();
  }

  _cacheUndoState() {
    if (!this._funscriptPath) return;
    // Deep clone everything — undo/redo stacks contain objects with Set selectedIndices
    // which JSON.stringify can't handle, so we serialize Sets as arrays
    const serializeStack = (stack) => stack.map(entry => ({
      ...entry,
      selectedIndices: entry.selectedIndices ? [...entry.selectedIndices] : [],
    }));
    this._undoCache.set(this._funscriptPath, {
      actions: JSON.parse(JSON.stringify(this.editableScript.actions)),
      undoStack: JSON.parse(JSON.stringify(serializeStack(this.editableScript._undoStack))),
      redoStack: JSON.parse(JSON.stringify(serializeStack(this.editableScript._redoStack))),
      selectedIndices: [...this.editableScript._selectedIndices],
      bookmarks: JSON.parse(JSON.stringify(this.editableScript._bookmarks || [])),
      dirty: this.editableScript.dirty,
    });
  }

  _restoreUndoState() {
    if (!this._funscriptPath) return;
    const cached = this._undoCache.get(this._funscriptPath);
    if (!cached) return;
    // Deep clone from cache so the cache itself isn't mutated
    const deserializeStack = (stack) => stack.map(entry => ({
      ...entry,
      selectedIndices: new Set(entry.selectedIndices || []),
    }));
    this.editableScript._actions = JSON.parse(JSON.stringify(cached.actions));
    this.editableScript._undoStack = deserializeStack(JSON.parse(JSON.stringify(cached.undoStack)));
    this.editableScript._redoStack = deserializeStack(JSON.parse(JSON.stringify(cached.redoStack)));
    this.editableScript._selectedIndices = new Set(cached.selectedIndices);
    this.editableScript._bookmarks = JSON.parse(JSON.stringify(cached.bookmarks));
    this.editableScript._dirty = cached.dirty;
  }

  // --- Snap to Frame ---

  /**
   * Snap a timestamp to the nearest video frame boundary.
   * @param {number} timeMs — timestamp in milliseconds
   * @returns {number} snapped timestamp
   */
  snapTime(timeMs) {
    if (!this._snapToFrame) return timeMs;
    if (!this.videoPlayer?.video || !isFinite(this.videoPlayer.video.duration)) return timeMs;

    // Use 30fps as default snap grid — reliable across all videos
    // (getVideoPlaybackQuality().totalVideoFrames is unreliable for FPS estimation)
    const frameDurationMs = 1000 / 30;
    return Math.round(timeMs / frameDurationMs) * frameDurationMs;
  }

  // --- Live Device Preview ---

  /**
   * Send a position preview to connected HDSP-capable devices.
   * Called when dragging actions or placing via numpad.
   * @param {number} position — 0-100
   */
  _sendLivePreview(position) {
    if (!this.handyManager?.connected) return;
    // Only send HDSP when sync is NOT active (would break HSSP)
    if (this.syncEngine?._active) return;
    try {
      this.handyManager.hdspMove(position, 150);
    } catch { /* ignore */ }
  }
}

/** Escape HTML special characters for safe insertion into innerHTML. */
function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
