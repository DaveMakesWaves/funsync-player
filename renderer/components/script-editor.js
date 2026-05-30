// ScriptEditor — Funscript editor panel with OFS-style interactions
// Centered playhead, speed-colored lines, click-to-insert, numpad placement, autosave

import { EditableScript } from '../js/editable-script.js';
import { ActionGraph } from '../js/action-graph.js';
import {
  icon, Undo2, Redo2, Save, ZoomIn, ZoomOut, Magnet, Trash2,
  FlipVertical2, Spline, Scissors, WandSparkles, BookmarkPlus, FileText, Rows3,
  AudioWaveform, Music, Layers2, ExternalLink,
} from '../js/icons.js';
import { showToast } from '../js/toast.js';
import { Modal } from './modal.js';
import {
  halfSpeed, doubleSpeed, reverseActions, remapRange, offsetTime, removePauses, generatePattern,
} from '../js/script-modifiers.js';
import { detectGaps, fillGaps } from '../js/gap-filler.js';
import {
  extractPeaks, getCachedPeaks, clearCacheFor,
  extractMultiBandPeaks, getCachedMultiBand,
} from '../js/waveform.js';
import { extractVAD, getCachedVAD } from '../js/vad.js';
import { detectBeats, beatsToActions, getCachedBeats, clearBeatCacheFor } from '../js/beat-detector.js';
import { dataService } from '../js/data-service.js';
import { openKeyboardHelp, getEditorShortcutGroups } from '../js/keyboard-help.js';
import { t, translatePage } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';
import { buildResolverMap, lookupBinding } from '../js/position-key-resolver.js';

export class ScriptEditor {
  constructor({ videoPlayer, funscriptEngine, progressBar, syncEngine, handyHdspSync, handyManager, settings }) {
    this.videoPlayer = videoPlayer;
    this.funscriptEngine = funscriptEngine;
    this.progressBar = progressBar;
    this.syncEngine = syncEngine;
    this.handyHdspSync = handyHdspSync || null;
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

    // Multi-band waveform + VAD overlay state (Audio Event Detection §1)
    this._multiBandEnabled = false;
    this._vadEnabled = false;

    // Stacked multi-axis lane view (§3)
    this._stackedView = false;
    this._inactiveLanes = new Map();  // path → { script, canvas, graph, container }
    this._stackedContainer = null;
    this._btnStacked = null;

    // Pop-out editor window (§4)
    this._popoutOpen = false;
    this._popoutUnsubscribe = null;
    this._btnPopout = null;

    // Load token — bumps on every _onScriptSelectChange. Guards the
    // async readFunscript so a slow disk read for an earlier-selected
    // script can't overwrite the canvas after a newer selection has
    // already loaded. Bug surfaced by the SR6 community report (rapid
    // dropdown clicks + stacked-view lane clicks both routing through
    // the same handler).
    this._loadToken = 0;

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

    // Custom position-key resolver. User can bind any (code, mods) to
    // any 0-100 position via Settings → Editor → Position keys. Map is
    // checked BEFORE the default numpad map in _handleKeyDown so user
    // overrides win. Rebuilt on every settings:changed for editor.
    this._customPositionKeyMap = buildResolverMap(
      this.settings?.get?.('editor.customPositionKeys') || [],
    );

    this._buildPanel();
    this._bindEvents();

    // Wire pop-out lifecycle once on construction. Idempotent — guards
    // against re-binding on hot reload.
    this._bindPopoutLifecycle();

    // Wire onChange
    this.editableScript.onChange = () => this._onScriptChanged();

    // Re-translate the static toolbar surface on locale change. Every
    // toolbar string is tagged with data-i18n / data-i18n-title /
    // data-i18n-aria-label, so translatePage() walks the panel and
    // refreshes them in one call. Dynamic strings (autosave status,
    // beat-detection progress, status line counts) are set fresh via
    // t() each time they're written and don't need handling here.
    this._unsubscribeLanguage = eventBus.on('language:changed', () => {
      if (this._panel) translatePage(this._panel);
    });

    // Mirror external rate changes (player-controls speed button,
    // keyboard <  /  > , later web-remote) back into the toolbar
    // dropdown so the editor stays consistent with whatever the user
    // did outside it.
    this._unsubscribeRateChange = eventBus.on('playback:rate-changed', (rate) => {
      if (this._speedSelect && this._speedSelect.value !== String(rate)) {
        this._speedSelect.value = String(rate);
      }
    });

    // Rebuild the custom position-key resolver when the user adds /
    // removes / edits bindings in Settings. Keeps the runtime map in
    // lockstep with persisted state without requiring an editor reopen.
    this._unsubscribeSettings = eventBus.on('settings:changed', (key) => {
      if (key === 'editor.customPositionKeys' || key === '*') {
        this._customPositionKeyMap = buildResolverMap(
          this.settings?.get?.('editor.customPositionKeys') || [],
        );
      }
    });
  }

  // --- Panel Construction ---

  _buildPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'script-editor';

    // Toolbar — role="toolbar" + arrow-key navigation between buttons
    // (Nielsen #4 standards). Pressing ← / → moves focus between
    // toolbar items; Home / End jumps to first / last. Tab still moves
    // focus OUT of the toolbar to the next page region — canonical
    // tablist/toolbar keyboard pattern.
    const toolbar = document.createElement('div');
    toolbar.className = 'editor__toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', t('editor.toolbarAria'));
    toolbar.setAttribute('data-i18n-aria-label', 'editor.toolbarAria');
    toolbar.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      // Only buttons participate in arrow-key roving — selects keep
      // their own arrow-key semantics (option scroll).
      const items = [...toolbar.querySelectorAll('button:not([disabled])')];
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % items.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      if (next >= 0) {
        e.preventDefault();
        items[next].focus();
      }
    });

    this._btnUndo = this._makeBtn(Undo2, 'editor.btn.undo', () => this.editableScript.undo());
    this._btnRedo = this._makeBtn(Redo2, 'editor.btn.redo', () => this.editableScript.redo());
    const btnDelete = this._makeBtn(Trash2, 'editor.btn.delete', () => this._deleteSelected());
    const sep1 = this._makeSeparator('cluster');

    // OFS operations
    const btnInvert = this._makeBtn(FlipVertical2, 'editor.btn.invert', () => this._invertSelected());
    const btnSimplify = this._makeBtn(Spline, 'editor.btn.simplify', () => this._simplifySelected());
    const btnCut = this._makeBtn(Scissors, 'editor.btn.cut', () => this._cutSelected());
    const sep1b = this._makeSeparator();

    // Modify dropdown
    this._modifySelect = document.createElement('select');
    this._modifySelect.className = 'editor__speed-select';
    this._modifySelect.title = t('editor.modify.title');
    this._modifySelect.setAttribute('data-i18n-title', 'editor.modify.title');
    const modOpts = [
      { value: '', key: 'editor.modify.placeholder' },
      { value: 'halfSpeed', key: 'editor.modify.halfSpeed' },
      { value: 'doubleSpeed', key: 'editor.modify.doubleSpeed' },
      { value: 'reverse', key: 'editor.modify.reverse' },
      { value: 'remapRange', key: 'editor.modify.remapRange' },
      { value: 'offsetTime', key: 'editor.modify.offsetTime' },
      { value: 'removePauses', key: 'editor.modify.removePauses' },
      { value: 'rangeExtend', key: 'editor.modify.rangeExtend' },
      { value: 'generatePattern', key: 'editor.modify.generatePattern' },
      { value: 'exportHeatmap', key: 'editor.modify.exportHeatmap' },
    ];
    for (const o of modOpts) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = t(o.key);
      opt.setAttribute('data-i18n', o.key);
      if (o.value === '') opt.disabled = true;
      this._modifySelect.appendChild(opt);
    }
    this._modifySelect.selectedIndex = 0;
    this._modifySelect.addEventListener('change', () => this._onModifyChange());

    const sep1c = this._makeSeparator();

    // Metadata, Bookmark, Fill Gaps buttons
    const btnMetadata = this._makeBtn(FileText, 'editor.btn.metadata', () => this._openMetadataModal());
    const btnBookmark = this._makeBtn(BookmarkPlus, 'editor.btn.bookmark', () => this._addBookmarkAtCursor());
    const btnFillGaps = this._makeBtn(Rows3, 'editor.btn.fillGaps', () => this._openFillGapsModal());
    this._btnWaveform = this._markToggleBtn(this._makeBtn(AudioWaveform, 'editor.btn.waveform', () => this._toggleWaveform()));
    const btnBeats = this._makeBtn(Music, 'editor.btn.beats', () => this._openBeatModal());

    const sep1d = this._makeSeparator('cluster');

    const btnZoomIn = this._makeBtn(ZoomIn, 'editor.btn.zoomIn', () => this._zoomIn());
    const btnZoomOut = this._makeBtn(ZoomOut, 'editor.btn.zoomOut', () => this._zoomOut());
    const btnFitAll = this._makeBtn(Magnet, 'editor.btn.fitAll', () => this.graph?.fitAll());
    const sep2 = this._makeSeparator();

    // Speed select
    const speedLabel = document.createElement('span');
    speedLabel.className = 'editor__speed-label';
    speedLabel.textContent = t('editor.speedLabel');
    speedLabel.setAttribute('data-i18n', 'editor.speedLabel');

    this._speedSelect = document.createElement('select');
    this._speedSelect.className = 'editor__speed-select';
    // Mirror the player-controls preset list (PLAYBACK_RATE_PRESETS in
    // video-player.js). Kept duplicated here to avoid an import cycle —
    // a parity test could catch drift but the list is small and stable.
    for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      const opt = document.createElement('option');
      opt.value = String(rate);
      opt.textContent = `${rate}x`;
      if (rate === 1) opt.selected = true;
      this._speedSelect.appendChild(opt);
    }
    this._speedSelect.addEventListener('change', () => this._onSpeedChange());

    const sep3 = this._makeSeparator('cluster');
    const btnSave = this._makeBtn(Save, 'editor.btn.save', () => this._save());

    // Stacked-view toggle — shows all loaded scripts as read-only
    // mini graphs above the active canvas. Hidden until ≥2 scripts
    // are loaded so single-axis videos see no extra UI.
    this._btnStacked = this._markToggleBtn(
      this._makeBtn(Layers2, 'editor.btn.stacked', () => this._toggleStackedView())
    );
    this._btnStacked.hidden = true;

    // Pop-out toggle — opens the editor in a separate BrowserWindow
    // for second-monitor editing. The actual mount of ScriptEditor
    // inside the pop-out is deferred (SCOPE §4 task #25); today this
    // opens a placeholder window via the broker, enough to verify
    // the IPC + lifecycle end-to-end.
    this._btnPopout = this._markToggleBtn(
      this._makeBtn(ExternalLink, 'editor.btn.popout', () => this._togglePopoutWindow())
    );

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
    autosaveLabel.textContent = t('editor.autosaveLabel');
    autosaveLabel.setAttribute('data-i18n', 'editor.autosaveLabel');

    this._autosaveStatusEl = document.createElement('span');
    this._autosaveStatusEl.className = 'editor__autosave-status';

    autosaveGroup.append(this._autosaveCheckbox, autosaveLabel, this._autosaveStatusEl);

    this._statusEl = document.createElement('span');
    this._statusEl.className = 'editor__status';

    // Script selector (multi-axis / custom routing)
    this._scriptSelect = document.createElement('select');
    this._scriptSelect.className = 'editor__script-select';
    this._scriptSelect.title = t('editor.scriptSelectTitle');
    this._scriptSelect.setAttribute('data-i18n-title', 'editor.scriptSelectTitle');
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
    snapCheck.addEventListener('change', () => {
      this._snapToFrame = snapCheck.checked;
      this._broadcastSettings();
    });
    snapLabel.appendChild(snapCheck);
    const snapText = document.createElement('span');
    snapText.style.marginLeft = '4px';
    snapText.textContent = t('editor.snapLabel');
    snapText.setAttribute('data-i18n', 'editor.snapLabel');
    snapLabel.appendChild(snapText);
    snapLabel.title = t('editor.snapTitle');
    snapLabel.setAttribute('data-i18n-title', 'editor.snapTitle');

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
      this._broadcastSettings();
    });
    splineLabel.appendChild(splineCheck);
    const splineText = document.createElement('span');
    splineText.style.marginLeft = '4px';
    splineText.textContent = t('editor.curvesLabel');
    splineText.setAttribute('data-i18n', 'editor.curvesLabel');
    splineLabel.appendChild(splineText);
    splineLabel.title = t('editor.curvesTitle');
    splineLabel.setAttribute('data-i18n-title', 'editor.curvesTitle');

    // Recording mode indicator
    this._recordingIndicator = document.createElement('span');
    this._recordingIndicator.className = 'editor__recording-indicator';
    this._recordingIndicator.textContent = t('editor.recording');
    this._recordingIndicator.setAttribute('data-i18n', 'editor.recording');
    this._recordingIndicator.hidden = true;
    this._recordingIndicator.style.cssText = 'color:#ff4444;font-weight:700;font-size:11px;margin-left:6px;animation:blink 1s step-end infinite';

    toolbar.append(
      this._scriptSelect, this._btnStacked, sepScript,
      this._btnUndo, this._btnRedo, sep1,
      btnDelete, btnCut, btnInvert, btnSimplify, sep1b,
      this._modifySelect, sep1c,
      btnMetadata, btnBookmark, btnFillGaps, this._btnWaveform, btnBeats, sep1d,
      btnZoomIn, btnZoomOut, btnFitAll, sep2,
      speedLabel, this._speedSelect, sep3,
      btnSave, this._btnPopout, autosaveGroup, snapLabel, splineLabel, this._recordingIndicator, this._statusEl,
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

    // Wrap the graph's draw so every redraw also syncs the inactive
    // lane previews when stacked view is on. Single hook covers zoom,
    // pan, hover redraws, cursor ticks, and the playback RAF — no
    // need to remember to call _syncInactiveLanes from each callsite.
    const _origDraw = this.graph.draw.bind(this.graph);
    this.graph.draw = (...args) => {
      const r = _origDraw(...args);
      if (this._stackedView) this._syncInactiveLanes();
      return r;
    };
  }

  // `titleKey` is an i18n key (e.g. 'editor.btn.undo'). We stamp it as
  // `data-i18n-title` so the eventBus 'language:changed' listener can
  // re-run translatePage(this._panel) and refresh every tooltip without
  // a separate retranslate method.
  _makeBtn(iconNode, titleKey, onClick) {
    const btn = document.createElement('button');
    btn.className = 'editor__btn';
    const titleText = t(titleKey);
    btn.title = titleText;
    btn.setAttribute('data-i18n-title', titleKey);
    // aria-label paired with title. Title alone isn't read by every
    // assistive tech in every state; aria-label is the canonical
    // accessible name. Polish-pass contract per DESIGN.md §2.3.
    btn.setAttribute('aria-label', titleText);
    btn.setAttribute('data-i18n-aria-label', titleKey);
    btn.appendChild(icon(iconNode, { width: 16, height: 16, 'stroke-width': 2 }));
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Mark a button as a toggle by seeding `aria-pressed="false"`.
   * `_setToggleState(btn, on)` flips both the attribute and the
   * legacy `--active` class so screen readers announce the state and
   * the visual highlight stays in sync. Use only on buttons that
   * persist a toggle state (Waveform, Multi-band, VAD, Stacked,
   * Pop-out) — momentary actions (Save, Undo, etc.) should NOT have
   * `aria-pressed`.
   */
  _markToggleBtn(btn) {
    if (btn) btn.setAttribute('aria-pressed', 'false');
    return btn;
  }

  _setToggleState(btn, on) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('editor__btn--active', !!on);
  }

  _makeSeparator(variant) {
    const sep = document.createElement('div');
    sep.className = 'editor__toolbar-separator';
    // Cluster variant: wider margin. Used at the strongest semantic
    // group boundaries (script-management → edit-history,
    // editing-operations → view-controls, playback → save). Minor
    // separators between same-intent groups stay at the default width.
    if (variant === 'cluster') sep.classList.add('editor__toolbar-separator--cluster');
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

    // Custom position-key bindings win over defaults — user explicitly
    // configured them in Settings → Editor → Position keys. Resolution
    // order per SCOPE-editor-custom-position-keys.md §2 decision #2:
    //   1. user's custom map
    //   2. default position-key map (this block below)
    //   3. editor command switch-case (further down)
    const customPos = lookupBinding(this._customPositionKeyMap, {
      code: e.code,
      mods: { shift: !!e.shiftKey, ctrl: !!ctrl, alt: !!e.altKey },
    });
    if (customPos !== null) {
      e.preventDefault();
      e.stopPropagation();
      this._placeOrTweakAt(customPos);
      return;
    }

    // 0-9 keys: place action at current video time with fixed position
    // Works with both regular number row and numpad. OFS parity: round
    // 10s, not 11s (key 9 = 90). The top of the range (100) wasn't
    // reachable in the original map — a community report flagged this.
    // Three bindings cover it now:
    //   - Shift+0 (modifier promotes the 0-floor to the 100-ceiling —
    //     Photoshop opacity convention)
    //   - `-` (Minus, number-row neighbor of 0 — single-handed reach)
    //   - Numpad- (NumpadSubtract, same role for numpad workflows)
    // Default scheme stays increments of 10 per Dave 2026-05-30; users
    // who want every-point binding granularity use the custom-key UI
    // wired above (notes/features/SCOPE-editor-custom-position-keys.md).
    const TOP_KEYS = new Set(['Minus', 'NumpadSubtract']);
    const isShiftZero = e.shiftKey && (e.code === 'Digit0' || e.code === 'Numpad0');
    const numpadMap = {
      'Digit0': 0, 'Digit1': 10, 'Digit2': 20, 'Digit3': 30, 'Digit4': 40,
      'Digit5': 50, 'Digit6': 60, 'Digit7': 70, 'Digit8': 80, 'Digit9': 90,
      'Numpad0': 0, 'Numpad1': 10, 'Numpad2': 20, 'Numpad3': 30, 'Numpad4': 40,
      'Numpad5': 50, 'Numpad6': 60, 'Numpad7': 70, 'Numpad8': 80, 'Numpad9': 90,
    };
    // Resolve the position from whichever binding fired. Shift+0 wins
    // over the plain 0→0 mapping (the shifted variant never matches
    // the unshifted entry in `numpadMap` because we early-return).
    const topKeyMatch = TOP_KEYS.has(e.code) && !ctrl && !e.altKey;
    if (isShiftZero || topKeyMatch || (e.code in numpadMap && !e.shiftKey && !ctrl && !e.altKey)) {
      e.preventDefault();
      e.stopPropagation();
      const pos = (isShiftZero || topKeyMatch) ? 100 : numpadMap[e.code];
      this._placeOrTweakAt(pos);
      return;
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        e.stopPropagation();
        this._deleteSelected();
        break;

      // OFS-style arrow-key mapping (v0.4.4).
      //   Plain Left/Right       = step 1 video frame
      //   Ctrl+Left/Right        = step N frames (editor.fastStepFrames, default 6)
      //   Shift+Left/Right       = move selected action(s) by ±1 frame (in time)
      //   Ctrl+Shift+Left/Right  = move selected action(s) by ±N frames (in time)
      //   Plain Up/Down          = navigate to prev/next action (with seek)
      //   Ctrl+Up/Down           = navigate to prev/next action across all scripts
      //   Shift+Up/Down          = nudge selected position ±5 (coarse)
      //   Ctrl+Shift+Up/Down     = nudge selected position ±1 (fine)
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        if (ctrl && e.altKey) {
          // Ctrl+Alt+Left → select everything before the playhead
          this._selectLeftOfCursor();
        } else if (e.shiftKey && this.editableScript.selectedIndices.size > 0) {
          const frames = ctrl ? this._fastStepFrames() : 1;
          const deltaMs = -frames * this._frameDurationMs();
          this.editableScript.moveActions(this.editableScript.selectedIndices, deltaMs, 0);
        } else if (ctrl) {
          this.videoPlayer.stepFrames(-this._fastStepFrames());
        } else {
          this.videoPlayer.stepFrame(-1);
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        if (ctrl && e.altKey) {
          // Ctrl+Alt+Right → select everything after the playhead
          this._selectRightOfCursor();
        } else if (e.shiftKey && this.editableScript.selectedIndices.size > 0) {
          const frames = ctrl ? this._fastStepFrames() : 1;
          const deltaMs = frames * this._frameDurationMs();
          this.editableScript.moveActions(this.editableScript.selectedIndices, deltaMs, 0);
        } else if (ctrl) {
          this.videoPlayer.stepFrames(this._fastStepFrames());
        } else {
          this.videoPlayer.stepFrame(1);
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey && this.editableScript.selectedIndices.size > 0) {
          const delta = ctrl ? 1 : 5;
          this.editableScript.moveActions(this.editableScript.selectedIndices, 0, delta);
        } else if (ctrl) {
          this._selectAdjacentActionAcrossScripts(-1);
        } else {
          this._selectAdjacentAction(-1);
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey && this.editableScript.selectedIndices.size > 0) {
          const delta = ctrl ? -1 : -5;
          this.editableScript.moveActions(this.editableScript.selectedIndices, 0, delta);
        } else if (ctrl) {
          this._selectAdjacentActionAcrossScripts(1);
        } else {
          this._selectAdjacentAction(1);
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
          showToast(t('editor.toast.copied', { count: this.editableScript.selectedIndices.size }), 'info');
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

      // `?` (Shift+/) opens the keyboard-shortcut help overlay.
      // Universal-discoverability for the editor's many bindings —
      // Nielsen #7 (flexibility for experts) + #10 (help in context).
      case '?':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._openKeyboardHelp();
        }
        break;

      case 'w':
      case 'W':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          // Shift+W → multi-band; bare W → single-band waveform
          if (e.shiftKey) this._toggleMultiBandWaveform();
          else this._toggleWaveform();
        }
        break;

      case 'v':
      case 'V':
        // Bare V → voice-activity toggle. Ctrl+V (paste) is handled
        // earlier in the switch and never reaches here. Shift+V is
        // reserved for variant cycling at the player level.
        if (!ctrl && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          this._toggleVADTrack();
        }
        break;

      case 'q':
      case 'Q':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._alternatingInsertAtCursor();
        }
        break;

      case 'Home':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._repeatLastStrokeAtCursor();
        }
        break;

      case 'e':
      case 'E':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._equalizeSelected();
        }
        break;

      case 'End':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._moveSelectedToPlayhead();
        }
        break;

      case 'b':
      case 'B':
        if (e.shiftKey && !ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._jumpToBookmark(1);
        } else if (ctrl && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          this._jumpToBookmark(-1);
        }
        // Bare B is handled by `_addBookmarkAtCursor` elsewhere.
        break;

      case '[':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._stepPlaybackSpeed(-1);
        }
        break;

      case ']':
        if (!ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._stepPlaybackSpeed(1);
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
      showToast(t('editor.toast.selectToInvert'), 'info');
      return;
    }
    this.editableScript.invertSelection();
    showToast(t('editor.toast.inverted', { count: this.editableScript.selectedIndices.size }), 'info');
  }

  async _simplifySelected() {
    if (this.editableScript.selectedIndices.size < 3) {
      showToast(t('editor.toast.selectToSimplify'), 'info');
      return;
    }
    const editableScript = this.editableScript;
    const result = await Modal.open({
      title: 'Simplify',
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">Epsilon
              <input type="range" id="simplify-eps" min="0.1" max="20" step="0.1" value="2" class="modal-input">
              <span id="simplify-eps-val" class="modal-hint" style="display:inline-block; min-width:3ch;">2.0</span>
            </label>
            <div class="modal-hint" id="simplify-preview">…</div>
            <div class="modal-hint">Higher epsilon removes more points. Live preview shows what will change.</div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="simplify-cancel">Cancel</button>
            <button class="modal-btn modal-btn--primary" id="simplify-ok">Apply</button>
          </div>`;
        const slider = body.querySelector('#simplify-eps');
        const valLabel = body.querySelector('#simplify-eps-val');
        const preview = body.querySelector('#simplify-preview');
        const updatePreview = () => {
          const eps = parseFloat(slider.value);
          valLabel.textContent = eps.toFixed(1);
          const stats = editableScript.previewSimplify(eps);
          preview.textContent = `Will remove ${stats.removed} of ${stats.total} points (keep ${stats.kept})`;
        };
        slider.addEventListener('input', updatePreview);
        updatePreview();
        body.querySelector('#simplify-cancel').addEventListener('click', () => close(null));
        body.querySelector('#simplify-ok').addEventListener('click', () => {
          close({ epsilon: parseFloat(slider.value) || 2 });
        });
      },
    });
    if (!result) return;
    const before = this.editableScript.selectedIndices.size;
    this.editableScript.simplify(result.epsilon);
    const after = this.editableScript.selectedIndices.size;
    const removed = before - after;
    if (removed > 0) {
      showToast(t('editor.toast.simplified', { count: removed }), 'info');
    } else {
      showToast(t('editor.toast.noPointsRemoved'), 'info');
    }
  }

  _cutSelected() {
    if (this.editableScript.selectedIndices.size === 0) return;
    const count = this.editableScript.selectedIndices.size;
    this.editableScript.cut();
    showToast(t('editor.toast.cut', { count }), 'info');
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

  /**
   * Like `_selectAdjacentAction` but considers action timestamps across every
   * loaded multi-axis script (current editor script + any axis scripts held
   * in buttplugSync._axisActions). Used by Ctrl+Up/Down so a user editing
   * the L0 script can still hop to a Roll/Pitch action point.
   *
   * Selection always lands on whatever index in the *current* editor script
   * is closest to the chosen cross-script timestamp — we don't switch the
   * open script automatically. The video and graph seek to the exact target.
   */
  _selectAdjacentActionAcrossScripts(direction) {
    const fromMs = this.videoPlayer.currentTime * 1000;

    // Collect candidate timestamps from every script we know about.
    const stamps = new Set();
    for (const a of this.editableScript.actions) stamps.add(a.at);
    const sync = this.syncEngine?._buttplugSync || this.handyManager?._buttplugSync;
    const axisMap = sync?._axisActions;
    if (axisMap && typeof axisMap.forEach === 'function') {
      axisMap.forEach((state) => {
        const list = state?.actions || [];
        for (const a of list) stamps.add(a.at);
      });
    }
    if (stamps.size === 0) {
      // No cross-script context — fall back to single-script navigation.
      this._selectAdjacentAction(direction);
      return;
    }

    // Pick the nearest stamp strictly in the requested direction.
    let target = null;
    for (const t of stamps) {
      if (direction > 0 && t > fromMs && (target === null || t < target)) target = t;
      else if (direction < 0 && t < fromMs && (target === null || t > target)) target = t;
    }
    if (target === null) {
      this._selectAdjacentAction(direction);
      return;
    }

    // Seek + recenter graph + reflect selection on the closest local action.
    this.videoPlayer.video.currentTime = target / 1000;
    this.graph.centerOnTime(target);
    this.graph.draw();
    this._updateScrubber();

    const localActions = this.editableScript.actions;
    if (localActions.length > 0) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < localActions.length; i++) {
        const d = Math.abs(localActions[i].at - target);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        this.editableScript.select(bestIdx);
        this._lastSelectedIndex = bestIdx;
      }
    }
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

  /**
   * Thin wrapper — videoPlayer owns the rate state plus the HSSP↔HDSP
   * mode switch (single source of truth across editor / player button /
   * keyboard / web-remote). The eventBus `playback:rate-changed`
   * subscription set up in `show()` echoes external changes back into
   * the dropdown.
   */
  _setSpeed(rate) {
    this.videoPlayer.setPlaybackRate(rate);
    this._broadcastSettings();
  }

  // --- Modify Dropdown ---

  async _onModifyChange() {
    const value = this._modifySelect.value;
    this._modifySelect.selectedIndex = 0; // reset to placeholder

    switch (value) {
      case 'halfSpeed':
        this.editableScript.applyModifier(halfSpeed);
        showToast(t('editor.toast.appliedHalfSpeed'), 'info');
        break;
      case 'doubleSpeed':
        this.editableScript.applyModifier(doubleSpeed);
        showToast(t('editor.toast.appliedDoubleSpeed'), 'info');
        break;
      case 'reverse':
        this.editableScript.applyModifier(reverseActions);
        showToast(t('editor.toast.appliedReverse'), 'info');
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
      case 'exportHeatmap':
        await this._exportHeatmapPng();
        break;
    }
  }

  // --- Modal dialogs for parameterized modifiers ---

  async _openRemapRangeModal() {
    const result = await Modal.open({
      title: t('editor.remapTitle'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.remapMin'))}<input type="number" id="remap-min" min="0" max="100" value="0" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.remapMax'))}<input type="number" id="remap-max" min="0" max="100" value="100" class="modal-input"></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="remap-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="remap-ok">${_esc(t('connection.btn.apply'))}</button>
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
      showToast(t('editor.toast.remapped', { min: result.min, max: result.max }), 'info');
    }
  }

  async _openOffsetTimeModal() {
    const result = await Modal.open({
      title: t('editor.offsetTitle'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.offsetMs'))}<input type="number" id="offset-ms" value="0" class="modal-input" step="100"></label>
            <div class="modal-hint">${_esc(t('editor.offsetHint'))}</div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="offset-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="offset-ok">${_esc(t('connection.btn.apply'))}</button>
          </div>`;
        body.querySelector('#offset-cancel').addEventListener('click', () => close(null));
        body.querySelector('#offset-ok').addEventListener('click', () => {
          close({ deltaMs: parseInt(body.querySelector('#offset-ms').value) || 0 });
        });
      },
    });
    if (result && result.deltaMs !== 0) {
      this.editableScript.applyModifier(offsetTime, result.deltaMs);
      showToast(t('editor.toast.offsetBy', { ms: result.deltaMs }), 'info');
    }
  }

  async _openRemovePausesModal() {
    const result = await Modal.open({
      title: t('editor.pausesTitle'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.pausesMax'))}<input type="number" id="pause-gap" min="100" value="5000" class="modal-input" step="500"></label>
            <div class="modal-hint">${_esc(t('editor.pausesHint'))}</div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="pause-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="pause-ok">${_esc(t('connection.btn.apply'))}</button>
          </div>`;
        body.querySelector('#pause-cancel').addEventListener('click', () => close(null));
        body.querySelector('#pause-ok').addEventListener('click', () => {
          close({ maxGapMs: parseInt(body.querySelector('#pause-gap').value) || 5000 });
        });
      },
    });
    if (result) {
      this.editableScript.applyModifier(removePauses, result.maxGapMs);
      showToast(t('editor.toast.pausesRemoved'), 'info');
    }
  }

  async _openRangeExtendModal() {
    const sel = this.editableScript.selectedIndices;
    if (sel.size < 2) {
      showToast(t('editor.toast.selectToExtend'), 'warn');
      return;
    }
    const result = await Modal.open({
      title: t('editor.extendTitle'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.extendFactor'))}<input type="number" id="extend-factor" value="1.0" step="0.1" min="0.1" max="10" class="modal-input"></label>
            <div class="modal-hint">${_esc(t('editor.extendHint'))}</div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="extend-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="extend-ok">${_esc(t('connection.btn.apply'))}</button>
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
      showToast(t('editor.toast.timeScaled', { factor: result.factor }), 'info');
    }
  }

  _toggleRecordingMode() {
    this._recordingMode = !this._recordingMode;
    this._recordingIndicator.hidden = !this._recordingMode;

    if (this._recordingMode) {
      showToast(t('editor.toast.recordingOn'), 'info');
      // In recording mode, start video if paused
      if (this.videoPlayer.video.paused) {
        this.videoPlayer.video.play();
      }
    } else {
      showToast(t('editor.toast.recordingOff'), 'info');
    }
    this._broadcastSettings();
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
      title: t('editor.patternTitle'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.patternStyle'))}
              <select id="pat-type" class="modal-input">
                <option value="sine">${_esc(t('editor.patternSine'))}</option>
                <option value="sawtooth">${_esc(t('editor.patternSawtooth'))}</option>
                <option value="square">${_esc(t('editor.patternSquare'))}</option>
                <option value="triangle">${_esc(t('editor.patternTriangle'))}</option>
                <option value="escalating">${_esc(t('editor.patternEscalating'))}</option>
                <option value="random">${_esc(t('editor.patternRandom'))}</option>
              </select>
            </label>
            <label class="modal-label">${_esc(t('editor.patternBpm'))}<input type="number" id="pat-bpm" min="10" max="600" value="120" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.patternMin'))}<input type="number" id="pat-min" min="0" max="100" value="0" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.patternMax'))}<input type="number" id="pat-max" min="0" max="100" value="100" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.patternStart'))}<input type="number" id="pat-start" min="0" value="${defaultStart}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.patternEnd'))}<input type="number" id="pat-end" min="0" value="${defaultEnd}" class="modal-input"></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="pat-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="pat-ok">${_esc(t('editor.generate'))}</button>
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
        showToast(t('editor.toast.patternInserted', { count: pattern.length, type: result.type }), 'info');
      } else {
        showToast(t('editor.toast.patternNone'), 'warn');
      }
    }
  }

  // --- Keyboard help overlay ---
  //
  // Surfaces every editor shortcut at once so the user doesn't have to
  // discover them piecemeal via tooltips. `?` opens it from the canvas
  // keydown handler. Modal for first ship (per SCOPE-desktop-redesign
  // §4.7, locked decision §10.4) — can demote to a popover later if it
  // feels heavy. Nielsen #7 (expert flexibility) + #10 (help in context).

  _openKeyboardHelp() {
    // Renders the same shape used by the player help overlay (extracted
    // 2026-04-27 into renderer/js/keyboard-help.js so both surfaces
    // share the layout). Editor's group set lives in EDITOR_SHORTCUT_GROUPS
    // — anyone updating a binding in this file should update that list too.
    openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups());
  }

  // --- Metadata Modal ---

  async _openMetadataModal() {
    const meta = this.editableScript.getMetadata();
    const md = meta.metadata || {};
    const defaultCreator = dataService.get('editor.defaultCreator') || '';

    const result = await Modal.open({
      title: t('editor.metaTitle'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.metaName'))}<input type="text" id="meta-title" value="${_esc(md.title || '')}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.metaCreator'))}<input type="text" id="meta-creator" value="${_esc(md.creator || defaultCreator)}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.metaDescription'))}<textarea id="meta-desc" class="modal-input modal-textarea" rows="2">${_esc(md.description || '')}</textarea></label>
            <label class="modal-label">${_esc(t('editor.metaTags'))}<input type="text" id="meta-tags" value="${_esc((md.tags || []).join(', '))}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.metaPerformers'))}<input type="text" id="meta-performers" value="${_esc((md.performers || []).join(', '))}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.metaLicense'))}<input type="text" id="meta-license" value="${_esc(md.license || '')}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.metaNotes'))}<textarea id="meta-notes" class="modal-input modal-textarea" rows="2">${_esc(md.notes || '')}</textarea></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="meta-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="meta-ok">${_esc(t('common.save'))}</button>
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
      showToast(t('editor.toast.metaUpdated'), 'info');
    }
  }

  // --- Bookmark ---

  async _addBookmarkAtCursor() {
    const timeMs = this.videoPlayer.currentTime * 1000;
    const name = await Modal.prompt(t('editor.bookmarkPrompt'), t('editor.bookmarkPlaceholder'));
    if (name !== null) {
      this.editableScript.addBookmark(timeMs, name || '');
      showToast(t('editor.toast.bookmarkAdded', { time: this._formatTimeForToast(timeMs) }), 'info');
    }
  }

  // --- Waveform ---

  async _toggleWaveform() {
    this._waveformEnabled = !this._waveformEnabled;
    this._setToggleState(this._btnWaveform, this._waveformEnabled);

    if (!this._waveformEnabled) {
      this.graph.setShowWaveform(false);
      if (!this.graph._animating) this.graph.draw();
      return;
    }

    // Check cache first
    const videoSrc = this.videoPlayer.video.src;
    if (!videoSrc) {
      showToast(t('editor.toast.noVideo'), 'warn');
      this._waveformEnabled = false;
      this._setToggleState(this._btnWaveform, false);
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
    this._statusEl.textContent = t('editor.extractingWaveform');

    const data = await extractPeaks(videoSrc, 100, (pct) => {
      this._statusEl.textContent = t('editor.extractingWaveformPct', { pct: Math.round(pct * 100) });
    });

    if (data && this._waveformEnabled) {
      this.graph.setWaveformData(data);
      this.graph.setShowWaveform(true);
      if (!this.graph._animating) this.graph.draw();
      showToast(t('editor.toast.waveformLoaded'), 'info');
    } else if (!data) {
      showToast(t('editor.toast.waveformFailed'), 'warn');
      this._waveformEnabled = false;
      this._setToggleState(this._btnWaveform, false);
    }

    this._updateStatus();
  }

  /** Clear waveform data when video changes. */
  _clearWaveform() {
    this._waveformEnabled = false;
    this._multiBandEnabled = false;
    this._vadEnabled = false;
    if (this._btnWaveform) this._setToggleState(this._btnWaveform, false);
    if (this.graph) {
      this.graph.setWaveformData(null);
      this.graph.setShowWaveform(false);
      this.graph.setMultiBandData(null);
      this.graph.setShowMultiBand(false);
      this.graph.setVADData(null);
      this.graph.setShowVAD(false);
    }
  }

  // --- Beat Detection ---

  async _openBeatModal() {
    const videoSrc = this.videoPlayer.video.src;
    if (!videoSrc) {
      showToast(t('editor.toast.noVideo'), 'warn');
      return;
    }

    // Detect beats (with progress in status bar)
    let beatData = getCachedBeats(videoSrc);
    if (!beatData) {
      const origStatus = this._statusEl.textContent;
      this._statusEl.textContent = t('editor.detectingBeats');

      beatData = await detectBeats(videoSrc, {}, (pct) => {
        this._statusEl.textContent = t('editor.detectingBeatsPct', { pct: Math.round(pct * 100) });
      });

      this._updateStatus();

      if (!beatData || beatData.count === 0) {
        showToast(t('editor.toast.noBeats'), 'warn');
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
      title: t('editor.beatTitle', { count: beatData.count, bpm: beatData.averageBPM }),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.beatStyle'))}
              <select id="beat-style" class="modal-input">
                <option value="alternating">${_esc(t('editor.beatStyleAlternating'))}</option>
                <option value="sine">${_esc(t('editor.beatStyleSine'))}</option>
                <option value="energy">${_esc(t('editor.beatStyleEnergy'))}</option>
              </select>
            </label>
            <label class="modal-label">${_esc(t('editor.beatMin'))}<input type="number" id="beat-min" min="0" max="100" value="0" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.beatMax'))}<input type="number" id="beat-max" min="0" max="100" value="100" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.beatStart'))}<input type="number" id="beat-start" min="0" value="${defaultStart}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.beatEnd'))}<input type="number" id="beat-end" min="0" value="${defaultEnd}" class="modal-input"></label>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="beat-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="beat-ok">${_esc(t('editor.generate'))}</button>
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
        showToast(t('editor.toast.noBeatsInRange'), 'warn');
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
        showToast(t('editor.toast.beatsInserted', { count: newActions.length }), 'info');
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
      showToast(t('editor.toast.gapsNeedActions'), 'info');
      return;
    }

    const videoDurationMs = (this.videoPlayer.duration || 0) * 1000;
    const gaps = detectGaps(actions, 3000, videoDurationMs);
    if (gaps.length === 0) {
      showToast(t('editor.toast.gapsNone'), 'info');
      return;
    }

    const result = await Modal.open({
      title: t('editor.fillTitle', { count: gaps.length }),
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
          <label class="modal-label">${_esc(t('editor.fillPattern'))}
            <select id="fill-type" class="modal-input">
              <option value="sine">${_esc(t('editor.patternSine'))}</option>
              <option value="sawtooth">${_esc(t('editor.patternSawtooth'))}</option>
              <option value="square">${_esc(t('editor.patternSquare'))}</option>
              <option value="triangle">${_esc(t('editor.patternTriangle'))}</option>
              <option value="random">${_esc(t('editor.patternRandom'))}</option>
            </select>
          </label>
          <label class="modal-label">${_esc(t('editor.fillBpm'))}<input type="number" id="fill-bpm" min="10" max="600" value="120" class="modal-input"></label>
          <label class="modal-label">${_esc(t('editor.fillMin'))}<input type="number" id="fill-min" min="0" max="100" value="0" class="modal-input"></label>
          <label class="modal-label">${_esc(t('editor.fillMax'))}<input type="number" id="fill-max" min="0" max="100" value="100" class="modal-input"></label>
        </div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn--secondary" id="fill-cancel">${_esc(t('common.cancel'))}</button>
          <button class="modal-btn modal-btn--primary" id="fill-ok">${_esc(t('editor.fillSelected'))}</button>
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
        showToast(t('editor.toast.gapsFilled', { gaps: result.gapIndices.length, actions: filled.length }), 'info');
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
          showToast(t('editor.toast.saved'), 'info');
          this._reloadIntoEngineAndSync();
        }
      } catch (err) {
        showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
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
        showToast(t('editor.toast.saved'), 'info');
        this._reloadIntoEngineAndSync();
      }
    } catch (err) {
      showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
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
      this._autosaveStatusEl.textContent = t('editor.autosaveSaving');
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
          this._autosaveStatusEl.textContent = t('editor.autosaveSavedAt', { time });
          this._autosaveStatusEl.classList.remove('editor__autosave-status--saving');
        }
      }
    } catch (err) {
      console.warn('[Editor] Autosave failed:', err.message);
      if (this._autosaveStatusEl) {
        this._autosaveStatusEl.textContent = t('editor.autosaveFailed');
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
    // Broadcast to pop-out if one is open so its read-only graph stays
    // in sync with parent edits.
    this._broadcastActionsChanged();
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

    let text = selected > 0
      ? t('editor.statusSelected', { count, selected })
      : t('editor.status', { count });
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

  /** Mirror open/closed state on the player bottom-bar editor button.
   *  Adds aria-pressed + a class hook for the accent-soft background.
   *  No-op if the button isn't in the DOM (e.g. early lifecycle). */
  _reflectOpenStateOnTrigger(isOpen) {
    const btn = document.getElementById('btn-editor');
    if (!btn) return;
    btn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
    btn.classList.toggle('control-btn--toggled', isOpen);
  }

  show() {
    if (this._open) return;
    this._open = true;
    // Reflect open state on the bottom-bar editor button so the user
    // sees the same toggle-state pattern other controls use (mute,
    // fullscreen) — Shneiderman #1 consistency, Nielsen #1 visibility.
    this._reflectOpenStateOnTrigger(true);

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
  }

  hide() {
    if (!this._open) return;
    this._open = false;
    this._reflectOpenStateOnTrigger(false);

    // Tear down stacked view if active. Lanes shouldn't survive an
    // editor close; reopening with stacked view stranded would be
    // confusing (no script loaded yet, lane previews would all be
    // for stale paths).
    if (this._stackedView) this._setStackedView(false);

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

    // Note: playback rate is intentionally NOT reset here. Rate is
    // player-owned now (see video-player.js::setPlaybackRate) and
    // resets on new video load instead. Closing the editor preserves
    // whatever rate the user is watching at.
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
      showToast(t('editor.toast.created', { name }), 'info');

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
    this._broadcastScriptsChanged();
  }

  _updateScriptSelect() {
    if (!this._scriptSelect) return;
    const show = this._availableScripts.length > 1;
    this._scriptSelect.hidden = !show;

    // Also show/hide the separator
    const sep = this._panel?.querySelector('.editor__script-sep');
    if (sep) sep.hidden = !show;

    // Stacked-view toggle visibility follows the same rule. If stacked
    // view is on and we drop below 2 scripts, tear it down so the user
    // doesn't see a stranded empty preview row.
    if (this._btnStacked) this._btnStacked.hidden = !show;
    if (!show && this._stackedView) this._setStackedView(false);

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

    // Bug B1 (community report 2026-05-23): two rapid changes raced —
    // the later-completing disk read won the canvas regardless of
    // which path the user picked last. The load-token guard bails any
    // in-flight load whose token has been superseded by a newer one.
    // Triggers for this handler are dropdown change, stacked-view lane
    // click, and (future) pop-out window sync — all share this guard.
    const token = ++this._loadToken;

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

    // Bail if a newer selection has superseded us before autosave finished
    if (token !== this._loadToken) return;

    // Load the new script from disk
    this._funscriptPath = newPath;
    try {
      const content = await window.funsync.readFunscript(newPath);
      // Bail if a newer selection happened during the disk read. This is
      // the race the SR6 user was hitting.
      if (token !== this._loadToken) return;

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

        // Rebuild inactive-lane previews so the lane that just became
        // active disappears from previews and the lane that *was* active
        // reappears. Cheap — N small canvases.
        if (this._stackedView) await this._rebuildInactiveLanes();

        // Pop-out (if open) needs to know the active script changed.
        this._broadcastScriptsChanged();
        this._broadcastActionsChanged();
      }
    } catch (err) {
      // Only warn if this load was still the active one; superseded
      // failures are expected and uninteresting.
      if (token === this._loadToken) console.warn('[Editor] Failed to load script:', err.message);
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

    return Math.round(timeMs / this._frameDurationMs()) * this._frameDurationMs();
  }

  /**
   * Frame duration in ms used for snap grid + arrow-key time moves. Matches
   * snapTime's 30fps default — `getVideoPlaybackQuality()` totals are
   * unreliable for FPS estimation, so we standardise on 30 across all videos.
   */
  _frameDurationMs() {
    return 1000 / 30;
  }

  /**
   * Frame count for fast frame-step bindings (Ctrl+Left/Right and the
   * Ctrl+Shift in-time move). Honours `editor.fastStepFrames` setting.
   */
  _fastStepFrames() {
    const n = Number(dataService.get('editor.fastStepFrames'));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 6;
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

  // === Pop-out editor window (§4) =====================================

  /**
   * Toolbar handler — open the pop-out window if closed, dock back if
   * open. The actual window lifecycle is brokered by main process; we
   * just trigger and let the lifecycle event update local state. See
   * `electron/editor-popout-window.js` for the broker side.
   */
  async _togglePopoutWindow() {
    if (!window.funsync?.editorPopoutOpen) {
      showToast('Pop-out unavailable — Electron bridge missing', 'error');
      return;
    }
    if (this._popoutOpen) {
      await window.funsync.editorPopoutClose();
    } else {
      await window.funsync.editorPopoutOpen();
    }
  }

  /**
   * Wire lifecycle subscription once on construction. Receives `opened`
   * / `closed` / `message` events. Idempotent — re-binding without
   * unsubscribing leaks listeners.
   */
  _bindPopoutLifecycle() {
    if (!window.funsync?.onEditorPopoutEvent) return;
    if (this._popoutUnsubscribe) return; // already bound
    this._popoutUnsubscribe = window.funsync.onEditorPopoutEvent((event) => {
      if (event.type === 'opened') {
        this._popoutOpen = true;
        this._setToggleState(this._btnPopout, true);
        if (this._btnPopout) {
          this._btnPopout.title = 'Dock editor back to main window';
          this._btnPopout.setAttribute('aria-label', 'Dock editor back to main window');
        }
        // Hide the docked editor panel AND let the video reclaim the
        // 250px slot. Without removing the `--editor-open` class on
        // the player container, the CSS rule
        // `.player-container--editor-open .player__video-wrapper { height: calc(100vh - 250px) }`
        // keeps the video compressed even though the editor is gone.
        // Per locked decision §4.3 α, pop-out takes full ownership —
        // main window shows only the video.
        if (this._panel) this._panel.hidden = true;
        document
          .getElementById('player-container')
          ?.classList.remove('player-container--editor-open');
        this._startPopoutBroadcast();
      } else if (event.type === 'closed') {
        this._popoutOpen = false;
        this._setToggleState(this._btnPopout, false);
        if (this._btnPopout) {
          this._btnPopout.title = 'Pop out editor to a separate window';
          this._btnPopout.setAttribute('aria-label', 'Pop out editor to a separate window');
        }
        this._stopPopoutBroadcast();
        if (this._panel && this._open) {
          this._panel.hidden = false;
          // Restore the editor-open layout class so the video
          // compresses again and the editor panel slides back into
          // its slot.
          document
            .getElementById('player-container')
            ?.classList.add('player-container--editor-open');
          // The panel was hidden while the pop-out was open — its canvas
          // missed every layout / size update during that window.
          // Force a resize + redraw on the next frame so dots / lines
          // re-appear without waiting for a `timeupdate` tick (which
          // never fires when the video is paused).
          requestAnimationFrame(() => {
            if (!this.graph) return;
            this.graph.resize();
            this.graph.setCursorTime(this.videoPlayer.currentTime * 1000);
            this.graph.draw();
            this._updateScrubber?.();
          });
        }
      } else if (event.type === 'message') {
        this._handlePopoutMessage(event.payload);
      }
    });
  }

  // === Pop-out state-sync broadcasting ================================
  //
  // Lightweight wire — see `renderer/js/editor-popout-protocol.js` for
  // the message-type contract. Parent is the source of truth; pop-out
  // hydrates from INITIAL_STATE on READY and re-syncs from broadcasts.

  /** Start broadcasting time ticks + push an initial-state offer. */
  _startPopoutBroadcast() {
    if (this._popoutTickInterval) return;
    // 30 Hz ticks — matches the editor's draw cadence and keeps the
    // pop-out cursor smooth without flooding the IPC channel.
    this._popoutTickInterval = setInterval(() => this._broadcastTimeTick(), 33);
    // VIDEO_META once on open so the pop-out has duration / src.
    this._broadcastVideoMeta();
    // Theme-sync: subscribe so a settings-panel theme change flows to
    // the pop-out while it's open. Unsubscribe on stop.
    if (eventBus && !this._popoutThemeUnsub) {
      this._popoutThemeUnsub = eventBus.on('settings:changed', ({ path } = {}) => {
        if (path === 'player.theme') {
          // Defer one tick — `theme-manager` writes the `data-theme`
          // attribute on settings:changed; we want to read it AFTER
          // that write so the broadcast carries the new value.
          setTimeout(() => this._broadcastTheme(), 0);
        }
      });
    }
  }

  _stopPopoutBroadcast() {
    if (this._popoutTickInterval) {
      clearInterval(this._popoutTickInterval);
      this._popoutTickInterval = null;
    }
    if (this._popoutThemeUnsub) {
      try { this._popoutThemeUnsub(); } catch {}
      this._popoutThemeUnsub = null;
    }
  }

  /** Pop-out sent us a message. Route by `payload.type`. */
  _handlePopoutMessage(payload) {
    if (!payload || !payload.type) return;
    switch (payload.type) {
      case 'ready':
        this._broadcastInitialState();
        break;
      case 'video-seek':
        // payload.time is seconds (matches HTMLVideoElement.currentTime)
        if (this.videoPlayer?.video && typeof payload.time === 'number') {
          this.videoPlayer.video.currentTime = payload.time;
        }
        break;
      case 'video-step-frame':
        this.videoPlayer?.stepFrame?.(payload.direction || 1);
        break;
      case 'video-step-frames':
        this.videoPlayer?.stepFrames?.(payload.frames || 0);
        break;
      case 'video-set-rate':
        if (typeof payload.rate === 'number' && this.videoPlayer?.setPlaybackRate) {
          this.videoPlayer.setPlaybackRate(payload.rate);
          if (this._speedSelect) this._speedSelect.value = String(payload.rate);
        }
        break;
      case 'edit-op':
        this._applyPopoutEdit(payload);
        break;
      case 'save':
        // Parent owns the disk write — autosave path handles it.
        this._save?.();
        break;
      case 'script-switch':
        if (payload.path && this._scriptSelect) {
          this._scriptSelect.value = payload.path;
          this._onScriptSelectChange();
        }
        break;

      // Tier-A parity additions (parity audit 2026-05-23):
      // Pop-out's toolbar / hotkey gestures that need the docked
      // editor's existing modal infrastructure. The pop-out can't
      // mount these modals locally without a refactor (Modal.open
      // works in either renderer but the modal-bearing methods bind
      // to the docked editor's `editableScript` directly). For now
      // we surface the trigger in the pop-out and the modal opens in
      // the parent window — visible to the user who just clicked.
      case 'request-metadata':
        this._openMetadataModal?.();
        break;
      case 'request-fill-gaps':
        this._openFillGapsModal?.();
        break;
      case 'request-beats':
        this._openBeatModal?.();
        break;
      case 'request-simplify':
        this._simplifySelected?.();
        break;
      case 'request-remap-range':
        this._openRemapRangeModal?.();
        break;
      case 'request-offset-time':
        this._openOffsetTimeModal?.();
        break;
      case 'request-remove-pauses':
        this._openRemovePausesModal?.();
        break;
      case 'request-range-extend':
        this._openRangeExtendModal?.();
        break;
      case 'request-generate-pattern':
        this._openPatternModal?.();
        break;
      case 'request-export-heatmap':
        this._exportHeatmapPng?.();
        break;
      case 'request-waveform-toggle':
        this._toggleWaveform?.();
        break;

      // Pop-out's snap / spline / recording toggles + speed dropdown.
      // Apply locally to the docked editor's state, then echo back via
      // _broadcastSettings so any other consumer (this pop-out's UI)
      // re-syncs.
      case 'set-setting':
        if (payload.key === 'snapToFrame') {
          this._snapToFrame = !!payload.value;
        } else if (payload.key === 'splineMode') {
          this._splineMode = !!payload.value;
          if (this.graph) {
            this.graph._splineMode = this._splineMode;
            this.graph.draw();
          }
        } else if (payload.key === 'recordingMode') {
          this._recordingMode = !!payload.value;
          if (this._recordingIndicator) this._recordingIndicator.hidden = !this._recordingMode;
        }
        this._broadcastSettings();
        break;
      // DEVICE_PREVIEW deferred.
      default:
        console.debug('[Editor] unhandled popout message:', payload.type);
    }
  }

  /**
   * Apply an EDIT_OP from the pop-out to the parent's EditableScript.
   * Per locked decision §4.3 α, the parent is the single source of
   * truth — pop-out gestures funnel through here, and the
   * `_onScriptChanged` hook fires `_broadcastActionsChanged` after
   * every mutation so the pop-out's local view re-syncs.
   *
   * Each branch maps one protocol op-name to the corresponding
   * EditableScript / ScriptEditor method. Unknown ops log + no-op
   * (defensive against protocol additions on the pop-out side that
   * the parent hasn't been updated for yet).
   */
  _applyPopoutEdit(payload) {
    const es = this.editableScript;
    if (!es) return;
    const op = payload.op;
    try {
      switch (op) {
        case 'insert':
          es.insertAction(payload.at, payload.pos);
          break;
        case 'delete':
          if (Array.isArray(payload.indices)) {
            es.deleteActions(new Set(payload.indices));
          } else {
            es.deleteActions(es.selectedIndices);
          }
          break;
        case 'update':
          if (typeof payload.idx === 'number') {
            es.updateAction(payload.idx, payload.fields || {});
          }
          break;
        case 'select':
          if (Array.isArray(payload.indices)) {
            es._selectedIndices = new Set(payload.indices);
            es._emit?.();
          }
          break;
        case 'selectAll':
          es.selectAll();
          break;
        case 'clearSelection':
          es.clearSelection();
          break;
        case 'invert':
          es.invertSelection();
          break;
        case 'undo':
          es.undo();
          break;
        case 'redo':
          es.redo();
          break;
        case 'cut':
          es.cut?.();
          break;
        case 'paste':
          es.paste?.(payload.at);
          break;
        case 'pasteOriginal':
          es.pasteOriginal?.();
          break;
        case 'equalize':
          es.equalizeSelected?.();
          break;
        case 'selectLeftOf':
          es.selectLeftOfCursor?.(payload.time);
          break;
        case 'selectRightOf':
          es.selectRightOfCursor?.(payload.time);
          break;
        case 'insertAlternating':
          es.insertAlternating?.(payload.at);
          break;
        case 'repeatLastStroke':
          es.repeatLastStroke?.(payload.at);
          break;
        case 'moveSelectedToTime':
          es.moveSelectedToTime?.(payload.time);
          break;
        case 'addBookmark':
          es.addBookmark?.(payload.at, payload.name);
          break;
        case 'removeBookmark':
          // EditableScript.removeBookmark keys by `at` (timeMs), not by id.
          es.removeBookmark?.(payload.at);
          break;
        case 'beginBatch':
          // Wraps a drag-style edit stream so the entire drag is one
          // undo step. Throttled OP_UPDATEs inside this window collapse.
          es.beginBatch?.();
          break;
        case 'endBatch':
          es.endBatch?.();
          break;
        case 'copy':
          es.copy?.();
          break;
        case 'selectByPositionRange':
          es.selectByPositionRange?.(payload.minPos, payload.maxPos);
          break;
        case 'moveActions':
          // {indices?, deltaAt?, deltaPos?} — indices defaults to current
          // selection, mirroring docked editor's nudge / move semantics.
          es.moveActions?.(
            Array.isArray(payload.indices) ? new Set(payload.indices) : es.selectedIndices,
            payload.deltaAt || 0,
            payload.deltaPos || 0,
          );
          break;
        case 'applyModifier': {
          // Direct (param-less) modifiers — halfSpeed / doubleSpeed /
          // reverse. The script-modifiers module exports pure functions;
          // resolve by name. Keys must match the protocol values the
          // pop-out dispatches (`'halfSpeed'` / `'doubleSpeed'` /
          // `'reverse'`), NOT the JS export names.
          const name = payload.name;
          const mods = { halfSpeed, doubleSpeed, reverse: reverseActions };
          if (mods[name]) es.applyModifier?.(mods[name]);
          break;
        }
        default:
          console.debug('[Editor] unknown popout edit-op:', op);
      }
    } catch (err) {
      console.warn('[Editor] popout edit-op failed:', op, err);
    }
  }

  _broadcastInitialState() {
    if (!this._popoutOpen) return;
    const v = this.videoPlayer;
    const payload = {
      type: 'initial-state',
      scripts: this._availableScripts || [],
      activePath: this._funscriptPath || null,
      videoSrc: v?.video?.src || '',
      videoDuration: v?.duration || 0,
      videoTime: v?.currentTime || 0,
      videoPaused: v?.video ? !!v.video.paused : true,
      videoRate: v?.video?.playbackRate || 1,
      splineMode: !!this._splineMode,
      snapToFrame: !!this._snapToFrame,
      recordingMode: !!this._recordingMode,
      actions: this.editableScript?.actions || [],
      selectedIndices: [...(this.editableScript?.selectedIndices || [])],
      bookmarks: this.editableScript?.getBookmarks?.() || [],
      // Pop-out applies this as `<html data-theme="...">` so the same
      // design tokens render at the same paint values. Without this
      // the pop-out is hardcoded dark, which regresses light-theme
      // users (DESIGN.md §2.1 — semantic tokens, not named colours).
      theme: document.documentElement.dataset.theme || 'dark',
      // Frame duration for the pop-out's snap-to-frame logic. Matches
      // `_frameDurationMs()` in the docked editor — 30 fps standard.
      frameDurationMs: this._frameDurationMs?.() || (1000 / 30),
    };
    this._relayToPopout(payload);
  }

  /** Push a theme update to the pop-out when the user changes
   *  Settings → Appearance → Theme while the pop-out is open. */
  _broadcastTheme() {
    if (!this._popoutOpen) return;
    this._relayToPopout({
      type: 'theme',
      theme: document.documentElement.dataset.theme || 'dark',
    });
  }

  /** Broadcast snap / spline / recording / rate so the pop-out's
   *  toolbar checkboxes and indicators reflect the docked editor's
   *  state. Fires on docked-side toggle changes AND on every
   *  set-setting echo so the pop-out's optimistic UI re-syncs. */
  _broadcastSettings() {
    if (!this._popoutOpen) return;
    this._relayToPopout({
      type: 'settings',
      snapToFrame: !!this._snapToFrame,
      splineMode: !!this._splineMode,
      recordingMode: !!this._recordingMode,
      playbackRate: this.videoPlayer?.video?.playbackRate || 1,
    });
  }

  _broadcastTimeTick() {
    if (!this._popoutOpen) return;
    const v = this.videoPlayer;
    if (!v?.video) return;
    this._relayToPopout({
      type: 'time-tick',
      time: v.currentTime,
      paused: !!v.video.paused,
    });
  }

  _broadcastVideoMeta() {
    if (!this._popoutOpen) return;
    const v = this.videoPlayer;
    if (!v?.video) return;
    this._relayToPopout({
      type: 'video-meta',
      src: v.video.src,
      duration: v.duration,
      rate: v.video.playbackRate || 1,
    });
  }

  _broadcastActionsChanged() {
    if (!this._popoutOpen) return;
    this._relayToPopout({
      type: 'actions-changed',
      path: this._funscriptPath || null,
      actions: this.editableScript?.actions || [],
      selectedIndices: [...(this.editableScript?.selectedIndices || [])],
      bookmarks: this.editableScript?.getBookmarks?.() || [],
    });
  }

  _broadcastScriptsChanged() {
    if (!this._popoutOpen) return;
    this._relayToPopout({
      type: 'scripts-changed',
      scripts: this._availableScripts || [],
      activePath: this._funscriptPath || null,
    });
  }

  _relayToPopout(payload) {
    try {
      window.funsync?.editorPopoutRelay?.('to-popout', payload);
    } catch (err) {
      console.warn('[Editor] popout relay failed:', err);
    }
  }

  // === Stacked multi-axis lane view (§3) ==============================

  /** Toolbar handler — flip the toggle and rebuild lanes. */
  async _toggleStackedView() {
    await this._setStackedView(!this._stackedView);
  }

  /**
   * Enable or disable stacked view. When enabling, fetches every
   * non-active script and renders it as a read-only preview canvas
   * stacked above the main canvas. When disabling, tears down the
   * preview row.
   */
  async _setStackedView(enable) {
    if (enable && this._availableScripts.length < 2) {
      showToast('Stacked view needs multiple scripts (multi-axis or custom routing)', 'info');
      return;
    }
    this._stackedView = !!enable;
    this._setToggleState(this._btnStacked, this._stackedView);
    this._panel?.classList.toggle('script-editor--stacked', this._stackedView);

    if (this._stackedView) {
      if (!this._stackedContainer) {
        this._stackedContainer = document.createElement('div');
        this._stackedContainer.className = 'editor__stacked-lanes';
      }
      // Insert *before* the main canvas so previews appear above the
      // active editing surface. Using `before` rather than `prepend` on
      // _canvasContainer because lanes need to live in the panel root,
      // not inside the canvas's resize-observed container.
      if (this._canvasContainer && !this._stackedContainer.parentElement) {
        this._canvasContainer.parentElement?.insertBefore(this._stackedContainer, this._canvasContainer);
      }
      await this._rebuildInactiveLanes();
    } else {
      // Tear down: remove DOM, clear lane state.
      if (this._stackedContainer?.parentElement) {
        this._stackedContainer.parentElement.removeChild(this._stackedContainer);
      }
      this._inactiveLanes.clear();
    }
  }

  /**
   * Drop the existing inactive-lane previews and re-create them from
   * `_availableScripts` (excluding the currently-active one). Each lane
   * loads the script from disk into its own EditableScript + ActionGraph
   * and inherits the active lane's viewport / cursor / video duration so
   * the previews stay locked to the main timeline.
   */
  async _rebuildInactiveLanes() {
    if (!this._stackedContainer) return;
    this._stackedContainer.innerHTML = '';
    this._inactiveLanes.clear();

    const inactive = this._availableScripts.filter(s => s.path !== this._funscriptPath);
    for (const s of inactive) {
      const lane = await this._buildLane(s);
      if (lane) {
        this._stackedContainer.appendChild(lane.container);
        this._inactiveLanes.set(s.path, lane);
        // ActionGraph needs the canvas's actual rendered pixel size to
        // set its drawing buffer. Has to happen after the canvas is in
        // the DOM (CSS sizing), so call after append.
        try { lane.graph.resize(); } catch { /* canvas not yet visible */ }
      }
    }
    this._syncInactiveLanes();
  }

  /**
   * Build a single read-only preview lane for `script`. The lane has
   * its own canvas + ActionGraph but no editor mouse handlers — clicking
   * anywhere inside it switches the active script (same flow the
   * dropdown triggers). Returns `null` when the funscript can't be
   * loaded so the rest of the lane row stays usable.
   */
  async _buildLane(script) {
    const container = document.createElement('div');
    container.className = 'editor__lane editor__lane--inactive';
    container.title = `${script.label} — click to edit`;

    const label = document.createElement('span');
    label.className = 'editor__lane-label';
    label.textContent = script.label;
    container.appendChild(label);

    const canvas = document.createElement('canvas');
    canvas.className = 'editor__lane-canvas';
    container.appendChild(canvas);

    const editable = new EditableScript();
    // Prefer the in-memory undo cache (preserves unsaved edits when
    // toggling stacked view) over a fresh disk read.
    const cached = this._undoCache.get(script.path);
    if (cached) {
      editable._actions = JSON.parse(JSON.stringify(cached.actions));
    } else {
      try {
        const content = await window.funsync.readFunscript(script.path);
        if (content) {
          const parsed = JSON.parse(content);
          editable.loadFromData(parsed);
        }
      } catch (err) {
        console.warn('[Editor] stacked-view lane load failed:', script.path, err?.message || err);
        return null;
      }
    }

    const graph = new ActionGraph(canvas, editable);
    graph._splineMode = this._splineMode;

    container.addEventListener('click', () => {
      // Route the click through the dropdown so the dropdown stays in
      // sync with the editor state — single source of truth for active
      // script. _onScriptSelectChange handles caching, autosave, and
      // calls back into _rebuildInactiveLanes for us.
      if (this._scriptSelect) {
        this._scriptSelect.value = script.path;
        this._onScriptSelectChange();
      }
    });

    return { script: editable, canvas, graph, container };
  }

  /**
   * Push the active lane's viewport / video duration / cursor onto every
   * inactive lane and trigger a redraw. Called from the wrapped active
   * `draw()` so previews stay aligned on every zoom / pan / cursor tick.
   */
  _syncInactiveLanes() {
    if (!this._stackedView || !this.graph) return;
    for (const lane of this._inactiveLanes.values()) {
      lane.graph.setVideoDuration(this.graph._videoDurationMs);
      lane.graph.setViewport(this.graph.viewStartMs, this.graph.viewEndMs);
      lane.graph.setCursorTime(this.graph._cursorMs);
      lane.graph._splineMode = this._splineMode;
      lane.graph.draw();
    }
  }

  // === OFS-parity hotkey handlers (§2.1) ==============================

  _equalizeSelected() {
    if (this.editableScript.selectedIndices.size < 3) {
      showToast('Select 3+ actions to equalize', 'info');
      return;
    }
    const count = this.editableScript.selectedIndices.size;
    this.editableScript.equalizeSelected();
    showToast(`Equalized ${count} actions`, 'info');
  }

  _moveSelectedToPlayhead() {
    if (this.editableScript.selectedIndices.size !== 1) {
      showToast('Select exactly one action to move to playhead', 'info');
      return;
    }
    const timeMs = this.snapTime(this.videoPlayer.currentTime * 1000);
    const newIdx = this.editableScript.moveSelectedToTime(timeMs);
    if (newIdx >= 0) {
      this.editableScript.select(newIdx);
      this._lastSelectedIndex = newIdx;
    }
  }

  _selectLeftOfCursor() {
    const timeMs = this.videoPlayer.currentTime * 1000;
    this.editableScript.selectLeftOfCursor(timeMs);
  }

  _selectRightOfCursor() {
    const timeMs = this.videoPlayer.currentTime * 1000;
    this.editableScript.selectRightOfCursor(timeMs);
  }

  // === Fast-scripting hotkeys (§2.2) ==================================

  /**
   * Place a new action at the current playhead with the given position,
   * OR — if a single action is already selected ON the same frame —
   * update that action's position instead. Shared by the default 0-9
   * key map, the Shift+0 / Minus top-keys, and the user's custom
   * position-key bindings.
   *
   * Disambiguation: every successful insertion auto-selects the new
   * action, so the second numpad press always hit the modify branch
   * if we used `sel.size === 1` alone. The same-frame check fixes that
   * — same frame → tweak; different frame → insert new.
   *
   * @param {number} pos — 0-100
   */
  _placeOrTweakAt(pos) {
    if (this._recordingMode) {
      const timeMs = this.snapTime(this.videoPlayer.currentTime * 1000);
      this.editableScript.insertAction(timeMs, pos);
      this._sendLivePreview(pos);
      return;
    }
    const sel = this.editableScript.selectedIndices;
    const timeMs = this.snapTime(this.videoPlayer.currentTime * 1000);
    let modifyIdx = -1;
    if (sel.size === 1) {
      const idx = [...sel][0];
      const action = this.editableScript.actions[idx];
      // Sub-millisecond tolerance covers float rounding from snapTime
      // when snap-to-frame is off; with snap on, both values land on
      // exact integer frame boundaries.
      if (action && Math.abs(action.at - timeMs) < 1) modifyIdx = idx;
    }
    if (modifyIdx >= 0) {
      const newIdx = this.editableScript.updateAction(modifyIdx, { pos });
      this.editableScript.select(newIdx);
      this._lastSelectedIndex = newIdx;
    } else {
      const newIdx = this.editableScript.insertAction(timeMs, pos);
      this.editableScript.select(newIdx);
      this._lastSelectedIndex = newIdx;
    }
    this._sendLivePreview(pos);
  }

  _alternatingInsertAtCursor() {
    const timeMs = this.snapTime(this.videoPlayer.currentTime * 1000);
    const newIdx = this.editableScript.insertAlternating(timeMs);
    this.editableScript.select(newIdx);
    this._lastSelectedIndex = newIdx;
    const pos = this.editableScript.actions[newIdx]?.pos;
    if (typeof pos === 'number') this._sendLivePreview?.(pos);
  }

  _repeatLastStrokeAtCursor() {
    const timeMs = this.snapTime(this.videoPlayer.currentTime * 1000);
    const result = this.editableScript.repeatLastStroke(timeMs);
    if (!result) {
      showToast('Need at least 2 actions to repeat a stroke', 'info');
      return;
    }
    showToast('Stroke repeated', 'info', 1200);
  }

  /** Walk the speed dropdown one step in `direction` (±1). */
  _stepPlaybackSpeed(direction) {
    if (!this._speedSelect) return;
    const opts = Array.from(this._speedSelect.options);
    if (opts.length === 0) return;
    const current = this._speedSelect.selectedIndex;
    const next = Math.max(0, Math.min(opts.length - 1, current + direction));
    if (next === current) return;
    this._speedSelect.selectedIndex = next;
    const rate = parseFloat(this._speedSelect.value);
    if (typeof this._setSpeed === 'function') this._setSpeed(rate);
    else if (this.videoPlayer && typeof this.videoPlayer.setPlaybackRate === 'function') {
      this.videoPlayer.setPlaybackRate(rate);
    }
    showToast(`Playback ${rate}x`, 'info', 1000);
  }

  /** Jump to next/previous bookmark relative to the playhead. */
  _jumpToBookmark(direction) {
    const bookmarks = this.editableScript.getBookmarks();
    if (!bookmarks || bookmarks.length === 0) {
      showToast('No bookmarks to navigate', 'info');
      return;
    }
    const cursorMs = this.videoPlayer.currentTime * 1000;
    let target = null;
    for (const bm of bookmarks) {
      if (direction > 0 && bm.at > cursorMs && (target === null || bm.at < target.at)) target = bm;
      else if (direction < 0 && bm.at < cursorMs && (target === null || bm.at > target.at)) target = bm;
    }
    if (!target) {
      showToast(direction > 0 ? 'No bookmark after cursor' : 'No bookmark before cursor', 'info');
      return;
    }
    this.videoPlayer.video.currentTime = target.at / 1000;
    this.graph.centerOnTime?.(target.at);
    this.graph.draw();
    this._updateScrubber?.();
    if (target.name) showToast(`▶ ${target.name}`, 'info', 1500);
  }

  // === Audio overlays (§7 Phase 1) ====================================

  /**
   * Toggle the multi-band (low/mid/high) waveform overlay. Independent
   * of `_toggleWaveform` — both can be on at once.
   */
  async _toggleMultiBandWaveform() {
    this._multiBandEnabled = !this._multiBandEnabled;
    if (!this._multiBandEnabled) {
      this.graph.setShowMultiBand(false);
      if (!this.graph._animating) this.graph.draw();
      return;
    }
    const videoSrc = this.videoPlayer.video.src;
    if (!videoSrc) {
      showToast('No video loaded', 'warn');
      this._multiBandEnabled = false;
      return;
    }
    const cached = getCachedMultiBand(videoSrc);
    if (cached) {
      this.graph.setMultiBandData(cached);
      this.graph.setShowMultiBand(true);
      if (!this.graph._animating) this.graph.draw();
      return;
    }
    const origStatus = this._statusEl.textContent;
    this._statusEl.textContent = 'Extracting multi-band waveform…';
    const data = await extractMultiBandPeaks(videoSrc, 100, (pct) => {
      this._statusEl.textContent = `Extracting multi-band… ${Math.round(pct * 100)}%`;
    });
    if (data && this._multiBandEnabled) {
      this.graph.setMultiBandData(data);
      this.graph.setShowMultiBand(true);
      if (!this.graph._animating) this.graph.draw();
      showToast('Multi-band waveform loaded', 'info');
    } else if (!data) {
      showToast('Could not extract multi-band waveform', 'warn');
      this._multiBandEnabled = false;
    }
    this._statusEl.textContent = origStatus;
    this._updateStatus?.();
  }

  /**
   * Toggle the voice-activity track. Energy-based stopgap today
   * (silero-vad ONNX swap planned for Phase 1c).
   */
  async _toggleVADTrack() {
    this._vadEnabled = !this._vadEnabled;
    if (!this._vadEnabled) {
      this.graph.setShowVAD(false);
      if (!this.graph._animating) this.graph.draw();
      return;
    }
    const videoSrc = this.videoPlayer.video.src;
    if (!videoSrc) {
      showToast('No video loaded', 'warn');
      this._vadEnabled = false;
      return;
    }
    const cached = getCachedVAD(videoSrc);
    if (cached) {
      this.graph.setVADData(cached);
      this.graph.setShowVAD(true);
      if (!this.graph._animating) this.graph.draw();
      return;
    }
    const origStatus = this._statusEl.textContent;
    this._statusEl.textContent = 'Detecting voice activity…';
    const data = await extractVAD(videoSrc);
    if (data && this._vadEnabled) {
      this.graph.setVADData(data);
      this.graph.setShowVAD(true);
      if (!this.graph._animating) this.graph.draw();
      const seconds = data.segments.reduce((acc, s) => acc + (s.endMs - s.startMs) / 1000, 0);
      showToast(`Voice detected: ${data.segments.length} segments (${seconds.toFixed(1)}s total)`, 'info', 2500);
    } else if (!data) {
      showToast('Could not extract voice activity', 'warn');
      this._vadEnabled = false;
    }
    this._statusEl.textContent = origStatus;
    this._updateStatus?.();
  }

  // === Heatmap export (§2.2) ==========================================

  async _exportHeatmapPng() {
    const actions = this.editableScript?.actions || [];
    if (actions.length === 0) {
      showToast('Nothing to export — script is empty', 'warn');
      return;
    }
    const duration = (this.videoPlayer?.duration || 0) * 1000;
    if (!duration) {
      showToast('Video duration unavailable — load a video first', 'warn');
      return;
    }
    let computeBins, renderBins;
    try {
      ({ computeBins, renderBins } = await import('../js/heatmap-strip.js'));
    } catch {
      showToast('Heatmap export unavailable', 'warn');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 80;
    const bins = computeBins(actions, 1200, duration);
    renderBins(canvas, bins);

    const stem = (this._funscriptPath || 'heatmap')
      .split(/[\\/]/).pop().replace(/\.funscript$/i, '');
    canvas.toBlob((blob) => {
      if (!blob) { showToast('Heatmap export failed', 'warn'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${stem}-heatmap.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Heatmap exported', 'info', 1500);
    }, 'image/png');
  }
}

/** Escape HTML special characters for safe insertion into innerHTML. */
function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
