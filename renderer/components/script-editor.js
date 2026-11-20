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
  halfSpeed, doubleSpeed, reverseActions, remapRange, offsetTime, removePauses, rangeExtend, generatePattern,
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
import { t, translatePage, getCurrentLocale } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';
import { buildResolverMap, resolvePositionKey } from '../js/position-key-resolver.js';
import { layoutKey, digitKey } from '../js/keyboard-layout.js';
import { invertRawScriptContent } from '../js/device-transform-stack.js';
import { applyPopoutEdit } from '../js/editor-popout-dispatch.js';
import {
  PatternFillDrawer, fillDrawerKeyVerdict, normalisePatternFillOptions, windowSignature,
  rangeFromBand, fillRangeKey, fillLanding,
} from './pattern-fill-drawer.js';
import { FILL_RESULT } from '../js/editor-popout-protocol.js';
import { openContextMenu, closeContextMenu } from '../js/editor-context-menu.js';
import { describePattern } from '../js/pattern-library.js';

/** Ctrl+<digit> → the Select… command it runs (CB-06: matched on the key, digitKey). */
const THIRD_BY_DIGIT = { 1: 'topThird', 2: 'middleThird', 3: 'bottomThird' };

export class ScriptEditor {
  constructor({ videoPlayer, funscriptEngine, progressBar, syncEngine, handyHdspSync, handyManager, settings, engineHeldByRemote }) {
    this.videoPlayer = videoPlayer;
    // True while the shared engine holds a script the phone or a VR headset
    // loaded, not this window's video's (R3-20): the editor then never takes
    // the engine's points, and a save never pushes into it.
    this.engineHeldByRemote = typeof engineHeldByRemote === 'function' ? engineHeldByRemote : () => false;
    this.funscriptEngine = funscriptEngine;
    this.progressBar = progressBar;
    this.syncEngine = syncEngine;
    this.handyHdspSync = handyHdspSync || null;
    this.handyManager = handyManager;
    this.settings = settings;

    this.editableScript = new EditableScript();
    // Main asks before a close / quit / reload while this says dirty (R3-19).
    this._watchDirtyState();
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

    // Fill with pattern drawer (pattern library, Round 2): built on first use.
    this._fillDrawer = null;
    // A time range marked for a fill: a rubber band over 0 or 1 points
    // leaves its span here ({ startMs, endMs, key }), shaded on the graph.
    // It lasts while the selection, the script and the load stay as they
    // were (key), and goes on Esc and on any left click on the timeline.
    this._fillRange = null;
    // Set by app.js (D-01). While the player window owns playback the inline
    // <video> only holds the file, paused: `getPlaybackClock()` returns the
    // clock that plays then (the window's proxy), else null, and
    // `routePlayback(command, arg)` sends the pop-out's seeks and frame steps
    // there (true = taken). Without them the pop-out followed the paused
    // inline element and its arrows stepped a video nobody sees.
    this.getPlaybackClock = null;
    this.routePlayback = null;
    // Set by app.js (E-07): the pop-out closed with the editor open, so it
    // docked into the player view. With the player in its own window the
    // main window shows the Library, and the docked editor was on screen
    // nowhere.
    this.onPopoutDocked = null;

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
    this._availableScripts = []; // [{ label, path, embeddedAxis? }] — populated by app.js
    this._scriptSelect = null;

    // Axes embedded in the main script (#376, V42) are listed with an
    // `embeddedAxis` suffix and a virtual path: there is no file to load.
    // Picking one calls `onEditEmbeddedAxis(suffix)` (app.js extracts it to
    // a companion file, then opens that); the stacked view previews it
    // read-only from `getEmbeddedAxisActions(suffix)`.
    /** @type {((suffix: string) => Promise<void>|void)|null} */
    this.onEditEmbeddedAxis = null;
    /** @type {((suffix: string) => Array<{at:number,pos:number}>|null)|null} */
    this.getEmbeddedAxisActions = null;

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
    // beat-detection progress) are set fresh via t() each time they're
    // written. The status line ("44 actions") is written only when the
    // script changes, so it kept the old language until the next edit: it
    // is written again here (R3 fix-up, real-app verifier 1).
    this._unsubscribeLanguage = eventBus.on('language:changed', () => {
      if (this._panel) translatePage(this._panel);
      this._updateStatus();
      // The editor pop-out follows the switch (FT-103): it kept English.
      this._broadcastLocale();
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
    //
    // DataService emits `{ path, value }`. This compared the whole payload
    // with the key, so it never matched and a binding added in Settings
    // reached the editor only after a restart (found with FT-032). A bare
    // string is still accepted.
    this._unsubscribeSettings = eventBus.on('settings:changed', (payload) => {
      const key = typeof payload === 'string' ? payload : payload?.path;
      if (key === 'editor.customPositionKeys' || key === 'editor' || key === '*') {
        this._customPositionKeyMap = buildResolverMap(this._customPositionKeys());
        // The pop-out resolves its keys itself, from this list (FT-032).
        this._broadcastSettings();
      } else if (key === 'editor.fastStepFrames') {
        // The pop-out's Ctrl+Left/Right step (D-02).
        this._broadcastSettings();
      }
    });
  }

  // --- Panel Construction ---

  _buildPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'script-editor';
    // Closed until show(): inert, so Tab cannot reach its buttons or canvas.
    // editor.css only slides it off screen (translateY + opacity), and Tab
    // from the player landed on the hidden Delete Selected, Zoom Out and
    // canvas: Enter or a digit edited the script unseen, and the focus
    // scrolled the page 250 px, taking the top bar with it (round 2, also
    // in v0.9.2). show() / hide() switch it.
    this._panel.setAttribute('inert', '');

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

    // Select dropdown, just left of Modify. OFS's Select-menu order
    // (OpenFunscripter.cpp L2401-2453). Every item runs the SAME code as its
    // key (_runSelectCommand), and the labels name their keys: today the
    // only other place to discover them is the `?` overlay (belgriffinite
    // #261, "Maybe there is a way and I just don't know how"). Selection
    // only: nothing here pushes an undo step or sets the unsaved flag.
    this._selectMenu = document.createElement('select');
    this._selectMenu.className = 'editor__speed-select editor__select-menu';
    this._selectMenu.title = t('editor.select.title');
    this._selectMenu.setAttribute('data-i18n-title', 'editor.select.title');
    const selectOpts = [
      { value: '', key: 'editor.select.placeholder' },
      { value: 'all', key: 'editor.select.all' },
      { value: 'beforePlayhead', key: 'editor.select.beforePlayhead' },
      { value: 'afterPlayhead', key: 'editor.select.afterPlayhead' },
      { value: 'topThird', key: 'editor.select.topThird' },
      { value: 'middleThird', key: 'editor.select.middleThird' },
      { value: 'bottomThird', key: 'editor.select.bottomThird' },
      null,
      { value: 'everyNth', key: 'editor.select.everyNth' },
      { value: 'created', key: 'editor.select.created' },
      null,
      { value: 'none', key: 'editor.select.none' },
    ];
    for (const o of selectOpts) {
      // null = separator. Chromium draws an <hr> in a <select> as a divider.
      if (!o) { this._selectMenu.appendChild(document.createElement('hr')); continue; }
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = t(o.key);
      opt.setAttribute('data-i18n', o.key);
      if (o.value === '') opt.disabled = true;
      this._selectMenu.appendChild(opt);
    }
    this._selectMenu.selectedIndex = 0;
    this._selectMenu.addEventListener('change', () => this._onSelectMenuChange());

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
      { value: 'fillPattern', key: 'editor.modify.fillPattern' }, // the drawer (pattern library)
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

    // The speed label and its select wrap as one: in a wrapped toolbar the
    // label could end one row and its select start the next (R3 fix-up).
    const speedGroup = document.createElement('span');
    speedGroup.className = 'editor__speed-group';
    speedGroup.append(speedLabel, this._speedSelect);

    toolbar.append(
      this._scriptSelect, this._btnStacked, sepScript,
      this._btnUndo, this._btnRedo, sep1,
      btnDelete, btnCut, btnInvert, btnSimplify, sep1b,
      this._selectMenu, this._modifySelect, sep1c,
      btnMetadata, btnBookmark, btnFillGaps, this._btnWaveform, btnBeats, sep1d,
      btnZoomIn, btnZoomOut, btnFitAll, sep2,
      speedGroup, sep3,
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
      this._watchToolbarRows(toolbar, playerContainer);
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

  /**
   * The toolbar wraps onto more rows in a narrow window or a longer language
   * (R3-23): every control stays reachable. editor.css grows the panel by the
   * rows past the first, and moves the video and the player controls up by
   * the same amount, so the canvas keeps its height. The extra goes on
   * `container` as --editor-toolbar-extra, measured whenever the toolbar's
   * size changes (a resize, a language switch, a control shown or hidden).
   */
  _watchToolbarRows(toolbar, container) {
    if (typeof ResizeObserver === 'undefined') return;
    let last = null;
    let frame = 0;
    // Written in the next frame, not inside the observer's callback: the
    // write grows the panel, which resized the canvas container (observed
    // too, `_resizeObserver`) inside the same delivery, and Chromium reported
    // "ResizeObserver loop completed with undelivered notifications" as a
    // window error, logged as [error] in the log users send (R3 fix-up, real-
    // app verifier 2; seen only since R3-23 added this observer).
    const write = (extra) => {
      if (typeof requestAnimationFrame !== 'function') {
        container.style.setProperty('--editor-toolbar-extra', `${extra}px`);
        return;
      }
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        container.style.setProperty('--editor-toolbar-extra', `${extra}px`);
      });
    };
    const measure = () => {
      const kids = [...toolbar.children].filter((el) => el.offsetHeight > 0);
      if (!kids.length) return; // hidden (the pop-out holds the editor): keep the last value
      const cs = getComputedStyle(toolbar);
      const px = (v) => parseFloat(v) || 0;
      const chrome = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
      const oneRow = Math.max(px(cs.minHeight), Math.max(...kids.map((el) => el.offsetHeight)) + chrome);
      const extra = Math.max(0, Math.round(toolbar.offsetHeight - oneRow));
      if (extra === last) return;
      last = extra;
      write(extra);
    };
    this._toolbarRowsObserver = new ResizeObserver(measure);
    this._toolbarRowsObserver.observe(toolbar);
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
    // Right-click: the timeline's small menu (Fill with pattern…). The press
    // itself (mousedown, button 2) still does nothing, so no selection or
    // drag changes; only the menu opens.
    this._canvas.addEventListener('contextmenu', (e) => this._onCanvasContextMenu(e));

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
    // A left press anywhere on the timeline ends a marked fill range (a new
    // band marks a new one on release). Right-click keeps it: its menu fills it.
    if (this._fillRange) this._setFillRange(null);
    // While Fill with pattern previews, clicks still select (the preview
    // follows), but the two mouse EDITS wait: Alt+click insert and the
    // Shift+drag move (design §f: editing pauses until Apply or Cancel).
    const previewing = this._fillDrawer?.isOpen === true;

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
      if (e.shiftKey && !previewing) {
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
      if (e.altKey && previewing) {
        return;
      } else if (e.altKey) {
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
          // Fewer than two points caught: the band's time span is kept as a
          // range to fill (shaded), when it holds at most one point.
          if (indices.size < 2) {
            this._setFillRange(rangeFromBand(this.editableScript.actions, this.graph.xToTime(rect.x1), this.graph.xToTime(rect.x2)));
          }
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
    if (this._dragMode === 'move') {
      // A point drag that leaves the canvas carries on until the button comes
      // up, wherever that is (OFS keeps the mouse for a drag), so its batch
      // stays open: ending it here sent the moves after the pointer came back
      // outside any batch, where every point a moved one landed on along the
      // way was removed (CB-02 review). The canvas's own mouseup never sees a
      // release outside it, so the document's does.
      if (!this._dragReleaseListener) {
        this._dragReleaseListener = (e) => {
          this._dragReleaseListener = null;
          if (this._dragMode === 'move') this._onMouseUp(e);
        };
        document.addEventListener('mouseup', this._dragReleaseListener, { once: true });
      }
    } else {
      this.editableScript.endBatch(); // safety: end any active drag batch
    }
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
    // A closed editor takes no keys, even if its canvas still had focus.
    if (this._panel?.hasAttribute?.('inert')) return;
    this.graph.markInteraction();

    // Fill with pattern is open: Esc closes it (before it would clear the
    // selection), P goes back into it, the edit keys wait until Apply or
    // Cancel, and the rest (play, steps, selection, zoom, help) work on.
    if (this._fillDrawer?.isOpen) {
      const verdict = fillDrawerKeyVerdict(e, {
        isPositionKey: resolvePositionKey(e, this._customPositionKeyMap) !== null,
      });
      if (verdict !== 'allow') {
        e.preventDefault();
        e.stopPropagation();
        if (verdict === 'close') this._fillDrawer.close('cancel');
        else if (verdict === 'focus') this._fillDrawer.focus();
        return;
      }
    }

    // Let Space propagate for play/pause
    if (e.key === ' ') return;

    const ctrl = e.ctrlKey || e.metaKey;

    // Position keys: the user's custom map (Settings → Editor → Position
    // keys) first, then 0-9 → 0-90 (OFS's round 10s) and Shift+0 / - /
    // Numpad- → 100. ONE resolver, shared with the pop-out
    // (resolvePositionKey, FT-032), so both editors place the same point for
    // the same key. Default scheme stays increments of 10 per Dave
    // 2026-05-30; finer bindings are the custom map
    // (notes/features/SCOPE-editor-custom-position-keys.md).
    const placePos = resolvePositionKey(e, this._customPositionKeyMap);
    if (placePos !== null) {
      e.preventDefault();
      e.stopPropagation();
      this._placeOrTweakAt(placePos);
      return;
    }

    // Ctrl+1/2/3: select by position range (top / middle / bottom third), on
    // the number-row KEY (digitKey): AZERTY types & é " there unshifted, so
    // the old `case '1'` on e.key never fired on it (CB-06).
    const third = ctrl && !e.shiftKey && !e.altKey ? THIRD_BY_DIGIT[digitKey(e)] : undefined;
    if (third) {
      e.preventDefault();
      e.stopPropagation();
      this._runSelectCommand(third);
      return;
    }

    // layoutKey: the Latin letter on the key when the layout types another
    // alphabet (Russian т on N, Korean ㅜ), so the letter cases below work
    // there too (FT-035). Every other key is e.key unchanged.
    switch (layoutKey(e)) {
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
          this._runSelectCommand('beforePlayhead');
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
          this._runSelectCommand('afterPlayhead');
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

      // ONE case for v/V (and b/B below). Each used to appear twice in this
      // switch; JavaScript runs the first matching label, so the second
      // copy was dead: bare V never reached the VAD toggle, Ctrl+B did
      // nothing and Shift+B added a bookmark instead of jumping.
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
        } else {
          // Bare V → voice-activity toggle. Shift+V has no editor action
          // but is stopped too: the player's V / Shift+V cycle the script
          // variant with no editor gate (keyboard.js), which would swap the
          // script out from under the editing session.
          e.preventDefault();
          e.stopPropagation();
          if (!e.shiftKey) this._toggleVADTrack();
        }
        break;

      // The selection keys go through _runSelectCommand, the Select…
      // menu's own path, so a key and its menu item cannot drift apart.
      case 'a':
      case 'A':
        if (ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._runSelectCommand('all');
        }
        break;

      // Ctrl+1/2/3 (select a third) are handled above the switch, on the key.

      // N: New points only — the points the last modifier or generator
      // created (belgriffinite #261, Dave Q2). Bare N only. Stopped so it
      // never reaches the player's N (next video; editor-gated there too).
      // A custom position key bound to N before this existed still wins: the
      // custom map is checked above, before this switch.
      case 'n':
      case 'N':
        if (!ctrl && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          this._runSelectCommand('created');
        }
        break;

      // P: Fill with pattern (pattern library, design §f). Bare P only;
      // stopped so it never reaches the player's P (previous video, already
      // editor-gated there). A custom position key bound to P still wins:
      // the custom map is checked above, before this switch.
      case 'p':
      case 'P':
        if (!ctrl && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          this._openPatternFill();
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
        // Shift+B / Ctrl+B = previous / next bookmark, the PLAYER's
        // direction (keyboard.js, help rows "Previous / Next bookmark"), so
        // the chord means the same thing whether or not the editor is open
        // (Dave, 2026-11-04). The editor's old dead branch had it reversed.
        if (e.shiftKey && !ctrl) {
          e.preventDefault();
          e.stopPropagation();
          this._jumpToBookmark(-1);
        } else if (ctrl && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          this._jumpToBookmark(1);
        } else if (!ctrl && !e.shiftKey) {
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
        if (this._currentFillRange()) {
          // A marked fill range goes (with its one point, if selected).
          this._setFillRange(null);
          if (this.editableScript.selectedIndices.size > 0) this._runSelectCommand('none');
        } else if (this.editableScript.selectedIndices.size > 0) {
          this._runSelectCommand('none');
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
    // While the player window owns playback, its video takes the rate (E-06).
    if (!this.routePlayback?.('setRate', rate)) this.videoPlayer.setPlaybackRate(rate);
    this._broadcastSettings();
  }

  // --- Select Dropdown ---

  async _onSelectMenuChange() {
    const value = this._selectMenu.value;
    this._selectMenu.selectedIndex = 0; // reset to placeholder
    // Hand the keys back to the canvas FIRST (the Every Nth dialog restores
    // focus to whatever had it on close). A focused <select> owns the arrow
    // keys: Shift+Up after "New points only" would pick another menu item
    // instead of nudging the points.
    this._canvas?.focus?.({ preventScroll: true });
    await this._runSelectCommand(value);
  }

  /**
   * The ONE path for every selection command: the Select… menu, its keys
   * (Ctrl+A, Ctrl+Alt+Left/Right, Ctrl+1/2/3, N, Esc's clear) and nothing
   * else, so an item and its key cannot drift apart. Selection only (Dave,
   * Q4): no undo step, the unsaved flag untouched.
   * @param {string} command — a Select… menu value
   */
  _runSelectCommand(command) {
    const es = this.editableScript;
    switch (command) {
      case 'all': es.selectAll(); break;                           // Ctrl+A
      case 'beforePlayhead': this._selectLeftOfCursor(); break;    // Ctrl+Alt+Left
      case 'afterPlayhead': this._selectRightOfCursor(); break;    // Ctrl+Alt+Right
      case 'topThird': es.selectByPositionRange(67, 100); break;   // Ctrl+1
      case 'middleThird': es.selectByPositionRange(34, 66); break; // Ctrl+2
      case 'bottomThird': es.selectByPositionRange(0, 33); break;  // Ctrl+3
      case 'everyNth': return this._openEveryNthModal();           // no key (Q3)
      case 'created': this._selectCreatedPoints(); break;          // N
      case 'none': es.clearSelection(); break;                     // Esc with a selection; the item only ever clears
    }
    return undefined;
  }

  /** New points only (N, the Select… item, the pop-out's N). `notify` is
   *  where the toast goes: this window, or the pop-out (_popoutNotifier). */
  _selectCreatedPoints(notify = showToast) {
    const count = this.editableScript.selectCreated();
    if (count > 0) notify(t('editor.toast.newPointsSelected', { count }), 'info');
    else notify(t('editor.toast.newPointsNone'), 'info');
    return count;
  }

  /** Every Nth point with chosen values (the dialog's Select, the pop-out op). */
  _selectEveryNth(n, start, notify = showToast) {
    const result = this.editableScript.selectEveryNth(n, start);
    if (result.count > 0) {
      notify(t('editor.toast.everyNthSelected', { count: result.count, total: result.scope }), 'info');
    } else {
      notify(t('editor.toast.everyNthNone'), 'info');
    }
    return result;
  }

  /**
   * Every Nth point… : Every (default 2) and Start at point (default 1),
   * remembered for this session only (in memory; persisting would need a
   * default in electron/store.js). The live lines come from the PURE
   * countEveryNth, so the selection never changes while the dialog is open
   * (OFS and ofs-se both reset a tool when the selection changes under it).
   * Select recomputes from the LIVE selection: the pop-out can change it
   * while this is open, so the toast reports what actually happened.
   */
  async _openEveryNthModal() {
    const editor = this;
    const last = this._everyNthLast || { n: 2, start: 1 };
    const result = await Modal.open({
      title: t('editor.everyNthTitle'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.everyNthEvery'))}<input type="number" id="nth-every" min="2" step="1" value="${Number(last.n)}" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.everyNthStart'))}<input type="number" id="nth-start" min="1" step="1" value="${Number(last.start)}" class="modal-input"></label>
            <div class="modal-hint" id="nth-scope"></div>
            <div class="modal-hint" id="nth-result" aria-live="polite"></div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="nth-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="nth-ok">${_esc(t('editor.everyNthSelect'))}</button>
          </div>`;
        const everyInput = body.querySelector('#nth-every');
        const startInput = body.querySelector('#nth-start');
        const scopeEl = body.querySelector('#nth-scope');
        const resultEl = body.querySelector('#nth-result');
        const update = () => {
          const es = editor.editableScript;
          const r = es.countEveryNth(everyInput.value, startInput.value);
          scopeEl.textContent = es.selectedIndices.size > 0
            ? t('editor.everyNthScopeSelected', { count: r.scope })
            : t('editor.everyNthScopeAll', { count: r.scope });
          resultEl.textContent = r.count > 0
            ? t('editor.everyNthResult', { count: r.count })
            : t('editor.everyNthTooFew');
        };
        everyInput.addEventListener('input', update);
        startInput.addEventListener('input', update);
        update();
        body.querySelector('#nth-cancel').addEventListener('click', () => close(null));
        body.querySelector('#nth-ok').addEventListener('click', () => {
          close({ n: everyInput.value, start: startInput.value });
        });
      },
    });
    if (!result) return;
    const n = parseInt(result.n, 10);
    const start = parseInt(result.start, 10);
    this._everyNthLast = {
      n: Number.isNaN(n) ? last.n : Math.max(2, n),
      start: Number.isNaN(start) ? last.start : Math.max(1, start),
    };
    this._selectEveryNth(result.n, result.start);
  }

  // --- Modify Dropdown ---

  async _onModifyChange() {
    const value = this._modifySelect.value;
    this._modifySelect.selectedIndex = 0; // reset to placeholder
    // Same as the Select… menu: hand the keys back to the canvas FIRST (the
    // dialogs restore focus to whatever had it on close). A focused <select>
    // owns the arrow keys, so a plain Down after Double Speed used to pick
    // and RUN the next item (Half Speed) instead of moving to the next point,
    // and N did nothing (found in the 2026-11-04 live check).
    this._canvas?.focus?.({ preventScroll: true });

    switch (value) {
      case 'halfSpeed':
        this._reportModifierResult(this.editableScript.applyModifier(halfSpeed),
          'halfSpeed', t('editor.toast.appliedHalfSpeed'));
        break;
      case 'doubleSpeed':
        this._reportModifierResult(this.editableScript.applyModifier(doubleSpeed),
          'doubleSpeed', t('editor.toast.appliedDoubleSpeed'));
        break;
      case 'reverse':
        this._reportModifierResult(this.editableScript.applyModifier(reverseActions),
          'reverse', t('editor.toast.appliedReverse'));
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
      case 'fillPattern':
        this._openPatternFill();
        break;
      case 'exportHeatmap':
        await this._exportHeatmapPng();
        break;
    }
  }

  // --- Fill with pattern (pattern library, Round 2) ---

  /**
   * Open the Fill with pattern drawer on the selection (P, the right-click
   * menu, Modify > Fill with Pattern…). Two selected points at least: the
   * first and the last are the anchors the fill joins (design §f, Q3). With
   * fewer, a marked time range (a rubber band over 0 or 1 points; Dave
   * 2026-11-17) is filled instead. Without either the action is off and the
   * toast says what to do.
   * @returns {boolean} true when the drawer is open
   */
  _openPatternFill() {
    if (this._panel?.hasAttribute?.('inert')) return false;
    if (this.editableScript.selectedIndices.size < 2 && !this._currentFillRange()) {
      showToast(t('editor.patternFill.needSelection'), 'info');
      return false;
    }
    closeContextMenu();
    this._ensureFillDrawer().open();
    return true;
  }

  _ensureFillDrawer() {
    if (this._fillDrawer) return this._fillDrawer;
    this._fillDrawer = new PatternFillDrawer({
      container: this._panel,
      graph: this.graph,
      placement: 'above',
      getActions: () => this.editableScript.actions,
      getSelectedIndices: () => this.editableScript.selectedIndices,
      loadOptions: () => this.settings?.get?.('editor.patternFill'),
      onApply: (fill) => this._applyPatternFill(fill),
      onClose: () => {
        // Back to the timeline, where the user was (unless the editor closed).
        if (this._open && !this._panel?.hasAttribute?.('inert')) this._canvas?.focus?.({ preventScroll: true });
      },
      // Another load (a script switch, Don't save, a reload) is another
      // script: the drawer closes, and its preview never lands (review-2).
      getScriptKey: () => this.editableScript.loadId,
      notify: (text, level) => showToast(text, level),
      getFillRange: () => this._currentFillRange(),
    });
    return this._fillDrawer;
  }

  /** What a marked fill range belongs to: the selection, the load and the script's state. */
  _fillRangeKey() {
    const es = this.editableScript;
    return fillRangeKey(es.selectedIndices, `${es.loadId}|${es.revision}`);
  }

  /**
   * Mark (or, with null, end) the time range a fill uses while fewer than two
   * points are selected. The graph shades it for as long as it holds; an
   * open drawer previews it.
   * @param {{startMs:number,endMs:number}|null} range
   */
  _setFillRange(range) {
    this._fillRange = range ? { startMs: range.startMs, endMs: range.endMs, key: this._fillRangeKey() } : null;
    this.graph?.setTimeRange?.(range ? { from: range.startMs, to: range.endMs } : null, () => !!this._currentFillRange());
    if (this.graph && !this.graph._animating) this.graph.draw();
    this._fillDrawer?.refresh();
  }

  /** The marked fill range while it still holds (the same selection, script and load), else null (and it is gone). */
  _currentFillRange() {
    const r = this._fillRange;
    if (!r) return null;
    if (r.key === this._fillRangeKey()) return r;
    this._fillRange = null;
    this.graph?.setTimeRange?.(null);
    return null;
  }

  /**
   * The drawer's Apply in this window: ONE undo step (replaceRange), the new
   * points selected and recorded as created (N), and an ordinary edit after
   * that (dirty, autosave, the engine reload and Handy re-upload after a save).
   * @returns {boolean} false when nothing landed (the drawer stays open)
   */
  _applyPatternFill(fill, notify = showToast) {
    // A marked time range lands as an insert; a fill between anchors as before (fillLanding).
    const at = fillLanding(fill);
    const r = this.editableScript.replaceRange(at.t0, at.t1, fill.points, at.mode);
    if (!r.changed) {
      notify(t('editor.toast.nothingChanged'), 'info');
      return false;
    }
    this._rememberPatternFill(fill.options);
    const name = fill.name || this._patternName(fill.patternId);
    notify(t('editor.patternFill.applied', { name, count: r.created }), 'info');
    return true;
  }

  /**
   * The pop-out drawer's Apply (OP_FILL_RANGE, already checked by
   * validFillRange). Its preview was drawn on the pop-out's copy of this
   * script. It lands only on the script it was built on: the same path, no
   * script switch or Don't save reload under way (the path moves before the
   * file is read), and the same points in its window and beside it (the
   * signature the pop-out sent, pattern-fill-drawer.js windowSignature).
   * Multi-axis scripts share their times, so "both anchors still exist" was
   * also true on another axis (review-2 blocker). Else nothing lands and the
   * pop-out says so ('changed'). A fill of a marked time range has no anchors
   * to look for; the path and the signature still have to match.
   */
  _applyPopoutFill(fill, notify = this._popoutNotifier()) {
    const actions = this.editableScript.actions;
    const has = (at) => actions.some((a) => a.at === at);
    const same = !this._scriptLoads
      && (fill.path ?? null) === (this._funscriptPath || null)
      && (fill.range === true || (has(fill.t0) && has(fill.t1)))
      && fill.sig === windowSignature(actions, fill.t0, fill.t1);
    if (!same) {
      notify(t('editor.patternFill.changed'), 'warn');
      return false;
    }
    return this._applyPatternFill(fill, notify);
  }

  /** Tell the pop-out's drawer how its Apply ended (it waits open until then, review-2 minor 7). */
  _answerPopoutFill(requestId, ok) {
    if (!this._popoutOpen || requestId === undefined || requestId === null) return;
    this._relayToPopout({ type: FILL_RESULT, requestId, ok: ok === true });
  }

  /** editor.patternFill: the drawer's last-used pattern, end fit, mode, join and variation (design §h). */
  _rememberPatternFill(options) {
    if (!options || typeof options !== 'object') return;
    const next = normalisePatternFillOptions(options);
    try { this.settings?.set?.('editor.patternFill', next); } catch (err) { console.warn('[Editor] remember fill options failed:', err); }
    this._broadcastSettings();
  }

  _patternName(id) {
    const key = describePattern(id)?.nameKey;
    const name = key ? t(key) : '';
    return name && name !== key ? name : String(id || '');
  }

  /**
   * The timeline's right-click menu. A right-click anywhere on the canvas
   * opens it; it changes no selection. "Fill with pattern…" is off with fewer
   * than two selected points and no marked time range, and says why. The
   * Menu key and Shift+F10 fire this event too (from the keyboard, at the canvas).
   */
  _onCanvasContextMenu(e) {
    e.preventDefault();
    if (this._panel?.hasAttribute?.('inert')) return;
    // At the pointer; a menu the keyboard opened (no position) sits on the canvas.
    const pointed = e.clientX !== 0 || e.clientY !== 0;
    this._openCanvasMenu(pointed ? e.clientX : null, pointed ? e.clientY : null);
  }

  _openCanvasMenu(x = null, y = null) {
    if (x === null || y === null) {
      const rect = this._canvas.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 3;
    }
    const enough = this.editableScript.selectedIndices.size >= 2 || !!this._currentFillRange();
    openContextMenu({
      x, y,
      ariaLabel: t('editor.patternFill.contextMenu'),
      returnFocus: this._canvas,
      items: [{
        label: t('editor.patternFill.menu'),
        disabled: !enough,
        hint: enough ? '' : t('editor.patternFill.needSelection'),
        onSelect: () => this._openPatternFill(),
      }],
    });
  }

  /**
   * Toast the outcome of an `applyModifier` run. A refused or no-op run
   * says why nothing happened and never claims "Applied …" (it used to,
   * unconditionally). `appliedText` is omitted where the route never had
   * an "Applied" toast (the pop-out). Returns true when the script changed.
   * @param {{changed: boolean, refused: boolean}} status
   * @param {string} modifier — the Modify menu value ('doubleSpeed', …)
   * @param {string} [appliedText]
   * @param {Function} [notify] — where the toast goes (the pop-out's route
   *   passes _popoutNotifier); this window by default
   */
  _reportModifierResult(status, modifier, appliedText, notify = showToast) {
    if (status?.refused) {
      notify(t('editor.toast.needsContinuous', { name: this._modifierLabel(modifier) }), 'warn');
      return false;
    }
    if (!status?.changed) {
      notify(t('editor.toast.nothingChanged'), 'info');
      return false;
    }
    if (appliedText) notify(appliedText, 'info');
    return true;
  }

  /** The Modify menu's label for `modifier`, minus the "…" of a dialog item. */
  _modifierLabel(modifier) {
    return t(`editor.modify.${modifier}`).replace(/\s*…$/, '');
  }

  /**
   * Refuse a sequence modifier BEFORE its dialog opens, so nobody fills in
   * a dialog only to be told no. applyModifier still guards on its own;
   * this is only the early answer. Returns true when refused.
   */
  _refuseBeforeDialog(fn, modifier) {
    if (!this.editableScript.refusesModifier(fn)) return false;
    this._reportModifierResult({ changed: false, refused: true, created: 0 }, modifier);
    return true;
  }

  /**
   * True, with a toast, when the selection is no longer the one a dialog
   * opened with (`signature` from EditableScript.selectionSignature()). The
   * pop-out can clear or change it while Remap, Offset, Remove Pauses or
   * Range Extend is open in this window; applying then would hit other
   * points, or with nothing selected the WHOLE script (FT-031). Refuses
   * only, so nothing is at risk.
   */
  _selectionChangedSince(signature) {
    if (this.editableScript.selectionSignature() === signature) return false;
    showToast(t('editor.toast.selectionChanged'), 'warn');
    return true;
  }

  // --- Modal dialogs for parameterized modifiers ---

  async _openRemapRangeModal() {
    const selection = this.editableScript.selectionSignature();
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
    if (result && !this._selectionChangedSince(selection)) {
      this._reportModifierResult(this.editableScript.applyModifier(remapRange, result.min, result.max),
        'remapRange', t('editor.toast.remapped', { min: result.min, max: result.max }));
    }
  }

  async _openOffsetTimeModal() {
    const selection = this.editableScript.selectionSignature();
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
    if (result && result.deltaMs !== 0 && !this._selectionChangedSince(selection)) {
      this._reportModifierResult(this.editableScript.applyModifier(offsetTime, result.deltaMs),
        'offsetTime', t('editor.toast.offsetBy', { ms: result.deltaMs }));
    }
  }

  async _openRemovePausesModal() {
    if (this._refuseBeforeDialog(removePauses, 'removePauses')) return;
    const selection = this.editableScript.selectionSignature();
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
    if (result && !this._selectionChangedSince(selection)) {
      this._reportModifierResult(this.editableScript.applyModifier(removePauses, result.maxGapMs),
        'removePauses', t('editor.toast.pausesRemoved'));
    }
  }

  async _openRangeExtendModal() {
    if (this.editableScript.selectedIndices.size < 2) {
      showToast(t('editor.toast.selectToExtend'), 'warn');
      return;
    }
    if (this._refuseBeforeDialog(rangeExtend, 'rangeExtend')) return;
    const selection = this.editableScript.selectionSignature();
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
      // A pure modifier through applyModifier: one undo step, the
      // contiguity guard, the created record, and every new time computed
      // from the original one. The old per-index updateAction loop re-sorted
      // under its own feet (4 points ×2 gave 0, 200, 300, 800).
      // Re-checked here because the pop-out can change the selection while
      // the dialog is open, and with none left this would scale the whole
      // script. Any change refuses, as in Remap, Offset and Remove Pauses
      // (FT-031); it used to check only for fewer than 2 points.
      if (this._selectionChangedSince(selection)) return;
      this._reportModifierResult(this.editableScript.applyModifier(rangeExtend, result.factor),
        'rangeExtend', t('editor.toast.timeScaled', { factor: result.factor }));
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

  /**
   * Ctrl+S. `syncEngine: false` writes the same file without reloading the
   * engine or re-uploading to the Handy: only for the unsaved-changes
   * question asked by a route that loads another script next (CB-01 review).
   * Its re-upload of the OLD script raced the new one's, with no guard, and
   * could finish last, leaving the device on the old script.
   */
  async _save({ syncEngine = true } = {}) {
    // If we have a known path, write directly (autosave-style), in turn with
    // the autosaves (E-02): a Ctrl+S while an autosave's write was on its way
    // started a second write, and the two could land in either order, so the
    // file could end on the older state. It now waits for the write in flight
    // and writes the state as it is at its turn; an autosave fired meanwhile
    // waits for it the same way.
    if (this._funscriptPath) {
      const path = this._funscriptPath;
      return this._writeInTurn(() => this._saveToKnownPath(path, { syncEngine }));
    }

    // The state being written: an edit made while the write is on its way
    // stays unsaved (R4-18).
    const revision = this.editableScript.revision;
    const json = this.editableScript.toFunscriptJSON();

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
        this.editableScript.markSaved(revision);
        this._updateStatus();
        showToast(t('editor.toast.saved'), 'info');
        if (syncEngine) this._reloadIntoEngineAndSync();
        this._announceSaved(savedPath);
      }
    } catch (err) {
      showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
    }
  }

  /**
   * Ctrl+S's write to the script's own file, when its turn comes (E-02).
   * `path` is the file the user saved: if the editor holds another script by
   * then (its replace route flushed the first one), nothing is written, so
   * a state is never written under a file it was not saved for.
   */
  async _saveToKnownPath(path, { syncEngine = true } = {}) {
    if (this._funscriptPath !== path) return;
    // The state being written: an edit made while the write is on its way
    // stays unsaved (R4-18).
    const revision = this.editableScript.revision;
    const json = this.editableScript.toFunscriptJSON();
    try {
      const savedPath = await window.funsync.writeFunscript(json, path);
      if (savedPath) {
        this.editableScript.markSaved(revision);
        this._updateStatus();
        showToast(t('editor.toast.saved'), 'info');
        if (syncEngine) this._reloadIntoEngineAndSync();
        this._announceSaved(savedPath);
      }
    } catch (err) {
      showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
    }
  }

  /**
   * Run one write to the script's file after the write on its way, if any
   * (C-12 for autosaves, E-02 for Ctrl+S): one at a time, so the last to
   * land is the newest state. With nothing in flight it starts at once, as
   * before (same timing for every caller).
   */
  _writeInTurn(write) {
    const before = this._autosaveInFlight || null;
    const run = before ? before.catch(() => {}).then(write) : write();
    this._autosaveInFlight = run;
    const done = () => { if (this._autosaveInFlight === run) this._autosaveInFlight = null; };
    run.then(done, done);
    return run;
  }

  /**
   * The script at `path` changed on disk. The library paints a script it
   * already read this session from that read, so it has to hear about this
   * to show (and sort by) the edited speeds and heatmap (V81 review).
   */
  _announceSaved(path) {
    if (typeof path === 'string' && path) eventBus.emit('funscript:saved', { path });
  }

  /** Debounced autosave — called after every script mutation. */
  _triggerAutosave() {
    if (!this._autosaveEnabled) return;
    if (!this._funscriptPath) return;
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => this._autosave(), this._autosaveDelay);
  }

  /**
   * The debounced write. `syncEngine` as for `_save()`.
   *
   * One write at a time (C-12, found by reading in R4-18): an autosave that
   * fired while the previous one's write was still on its way started a
   * second write of the newer state, and the two could finish in either
   * order, leaving the file on the OLDER state until the next edit. Each
   * autosave now waits for the one in flight, then writes the state as it is
   * when its turn comes, so the last write to land is the newest state.
   */
  async _autosave(opts = {}) {
    // Ctrl+S's writes take their turn in the same chain (E-02).
    return this._writeInTurn(() => this._autosaveNow(opts));
  }

  /** One autosave write (see `_autosave`, which runs these one at a time). */
  async _autosaveNow({ syncEngine = true } = {}) {
    if (!this._funscriptPath || !this.editableScript.dirty) return;

    if (this._autosaveStatusEl) {
      this._autosaveStatusEl.textContent = t('editor.autosaveSaving');
      this._autosaveStatusEl.classList.add('editor__autosave-status--saving');
    }

    const revision = this.editableScript.revision;
    const json = this.editableScript.toFunscriptJSON();

    try {
      const savedPath = await window.funsync.writeFunscript(json, this._funscriptPath);
      if (savedPath) {
        // An edit made during the write stays unsaved, so its own autosave
        // still writes it (it found the script clean and skipped) (R4-18).
        this.editableScript.markSaved(revision);
        this._updateStatus();
        if (syncEngine) this._reloadIntoEngineAndSync();
        this._announceSaved(savedPath);

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

  // --- Unsaved changes (CB-01) ---

  /** True while the script in the editor holds edits that are not on disk. */
  hasUnsavedChanges() {
    return !!this.editableScript?.dirty;
  }

  /**
   * Tell main each time the script turns dirty or clean (R3-19). Main holds a
   * window close, a quit, a reload, an update install and Import / Restore's
   * relaunch for the unsaved-edits question only while this last said dirty
   * (electron/unsaved-edits-guard.js), so a change it never hears of would
   * let one of those drop the edits again. Every write of EditableScript's
   * `_dirty` comes through this accessor: each edit, undo and redo, every
   * load, markSaved, and the per-script cache putting a state back. The
   * pop-out applies its edits here too (it has no script of its own on disk).
   */
  _watchDirtyState() {
    const script = this.editableScript;
    let dirty = !!script._dirty;
    Object.defineProperty(script, '_dirty', {
      configurable: true,
      enumerable: true,
      get: () => dirty,
      set: (value) => {
        const next = !!value;
        if (next === dirty) return;
        dirty = next;
        try { window.funsync?.editorDirtyChanged?.(next); } catch { /* reporting only */ }
        // The pop-out's status line shows the same unsaved marker (R4 fix-up,
        // real-app verifier 2, also in v0.9.2: it never showed one). A save
        // or an undo back to the saved point changes this with no onChange
        // broadcast, so it is sent here, once the change has finished.
        if (this._popoutOpen) Promise.resolve().then(() => this._broadcastActionsChanged());
      },
    });
  }

  /**
   * What app.js asks first on every route that replaces the script in the
   * editor: library / playlist / category clicks, Up Next, the queue panel
   * and prev/next (`_playFromLibrary`), Play All and its advances
   * (`_playAll`, `_playQueueItem`), DragDrop / Browse / O and a dropped
   * funscript (`_dragDropOptions`), Load from URL, an EroScripts download,
   * and a variant switch from the desktop or the phone (`_switchVariant`).
   * `true` synchronously when nothing is unsaved, so a clean editor changes
   * no caller's timing; otherwise `confirmUnsavedChanges()`'s promise.
   *
   * Every one of these routes loads another script into the engine (and the
   * Handy) next, so a Save here writes without reloading the engine or
   * re-uploading the script being left (`syncEngine: false`, CB-01 review).
   * @returns {true|Promise<boolean>}
   */
  confirmBeforeReplace() {
    return this.hasUnsavedChanges() ? this.confirmUnsavedChanges({ syncEngine: false }) : true;
  }

  /**
   * Asked by every route that would replace the script in the editor (another
   * video by any route, a variant, a dropped or downloaded script, the
   * editor's own script list). With autosave off those routes used to drop
   * unsaved edits without a word (CB-01, also in v0.9.2). OFS's convention:
   * "Save changes to <script>?" with Save / Don't save / Cancel; Escape, the
   * X and a click outside are Cancel. With autosave on the pending write is
   * flushed instead, and the question only comes up if that write fails.
   *
   * One question at a time: a second route asking while the dialog is open
   * gets `false` (it does not load), so the route the user is answering is
   * the one that goes on.
   *
   * @param {{syncEngine?: boolean}} [opts] — false when the caller loads
   *   another script into the engine next (see confirmBeforeReplace): the
   *   write is the same, the engine reload and Handy re-upload are skipped.
   * @returns {Promise<boolean>} true when the caller may go on: nothing was
   *   unsaved, Save wrote the file (exactly as Ctrl+S), or Don't save (the
   *   editor goes back to the file on disk). False on Cancel, a failed save
   *   or a cancelled Save As: the caller keeps the current video and edits.
   */
  async confirmUnsavedChanges({ syncEngine = true } = {}) {
    if (!this.hasUnsavedChanges()) return true;
    if (this._unsavedPrompt) return false;
    if (this._autosaveEnabled && this._funscriptPath) {
      if (this._autosaveTimer) {
        clearTimeout(this._autosaveTimer);
        this._autosaveTimer = null;
      }
      await this._autosave({ syncEngine });
      if (!this.hasUnsavedChanges()) return true;
      if (this._unsavedPrompt) return false;
    }
    let choice = null;
    // The question opens in this, the main, window. Asked for from the
    // detached player (its N / P, Up Next) or the editor pop-out (its script
    // list), or with this window minimised or behind another, it waited
    // where the user could not see it: bring this window to the front first
    // (R3-21). Modal.open then focuses its first button, Save.
    if (typeof document !== 'undefined' && document.hasFocus?.() === false) {
      try { window.funsync?.bringMainWindowForward?.(); } catch { /* the question still opens */ }
    }
    this._unsavedPrompt = this._askSaveChanges();
    try {
      choice = await this._unsavedPrompt;
    } finally {
      this._unsavedPrompt = null;
      this._closeUnsavedQuestion = null; // withdrawUnsavedQuestion: nothing open now
    }
    if (choice === 'save') {
      await this._save({ syncEngine });
      return !this.hasUnsavedChanges();
    }
    if (choice === 'discard') {
      await this._discardUnsavedChanges();
      return true;
    }
    return false;
  }

  /**
   * Close the open Save / Don't save / Cancel question as Cancel: nothing is
   * saved or thrown away. For main's question before a close, quit or
   * import that went ahead without this page's answer (R4 fix-up).
   */
  withdrawUnsavedQuestion() {
    const close = this._closeUnsavedQuestion;
    this._closeUnsavedQuestion = null;
    if (typeof close === 'function') close(null);
  }

  /** The Save / Don't save / Cancel dialog. Resolves 'save', 'discard' or null (Cancel). */
  _askSaveChanges() {
    const videoName = this._getVideoName();
    const name = this._funscriptPath?.split(/[\\/]/).pop()
      || (videoName ? videoName.replace(/\.[^/.]+$/, '') + '.funscript' : 'script.funscript');
    const editor = this;
    const asked = Modal.open({
      title: t('editor.unsaved.title', { name }),
      onRender(body, close) {
        editor._closeUnsavedQuestion = close; // withdrawUnsavedQuestion
        const msg = document.createElement('div');
        msg.className = 'modal-message';
        msg.textContent = t('editor.unsaved.message');
        body.appendChild(msg);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        // Windows order, Save first: Modal.open focuses the first button,
        // so Enter saves and nothing is lost by a reflex keypress.
        const button = (label, cls, value) => {
          const btn = document.createElement('button');
          btn.className = `modal-btn ${cls}`;
          btn.textContent = label;
          btn.dataset.choice = value || 'cancel';
          btn.addEventListener('click', () => close(value));
          actions.appendChild(btn);
          return btn;
        };
        button(t('common.save'), 'modal-btn--primary', 'save');
        button(t('editor.unsaved.dontSave'), 'modal-btn--secondary', 'discard');
        button(t('common.cancel'), 'modal-btn--secondary', null);
        body.appendChild(actions);
      },
    });
    return asked;
  }

  /**
   * Don't save: the editor goes back to the file on disk (or to an empty
   * script when there is no readable file, with no path, so nothing can
   * later write another script's points over it). The per-path undo cache
   * entry goes too: its history leads into the discarded edits.
   */
  async _discardUnsavedChanges() {
    const path = this._funscriptPath;
    let data = null;
    if (path) {
      // A pop-out fill arriving during the read would be thrown away by the
      // reload below: it is refused instead (_applyPopoutFill, review-2).
      this._scriptLoads = (this._scriptLoads || 0) + 1;
      try {
        const content = await window.funsync?.readFunscript?.(path);
        if (content) data = JSON.parse(content);
      } catch {
        data = null;
      } finally {
        this._scriptLoads--;
      }
      this._undoCache?.delete(path);
    }
    // After the wait: a Fill with pattern drawer opened meanwhile previewed
    // the edits that are going now (review-2 blocker).
    this._fillDrawer?.close('cancel');
    if (data && typeof data === 'object') {
      this.editableScript.loadFromData(data);
    } else {
      this.editableScript.loadEmpty();
      this._funscriptPath = null;
    }
    this._updateStatus?.();
    this._updateToolbarState?.();
    this.graph?.draw?.();
    this._broadcastActionsChanged?.();
  }

  /** Reload actions into the funscript engine and re-upload to Handy. */
  async _reloadIntoEngineAndSync() {
    const actions = this.editableScript.actions;
    if (actions.length === 0) return; // nothing to sync
    // The phone or a VR headset drives the devices from ITS script in the
    // engine: this window's edits are saved to their own file, never pushed
    // into that engine or re-uploaded to the Handy over it (R3-20).
    if (this.engineHeldByRemote?.() === true) return;

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
    // A marked fill range ends with any other selection or edit (its key).
    this._currentFillRange();
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
    // An open Fill with pattern drawer previews the new script / selection.
    this._fillDrawer?.refresh();
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
      // The app's own upload path when wired (app.js sets it): the same
      // extend → fill → invert → clamp chain as a video load, and it records
      // the cloud URL the Orgasm Switch restore and the invert re-arm use.
      // A raw upload here used to drop the output limits and gap filler.
      if (typeof this.onReuploadHandy === 'function') {
        await this.onReuploadHandy();
        return;
      }
      const rawContent = this.funscriptEngine.getRawContent();
      if (rawContent) {
        const ok = await this.handyManager.uploadAndSetScript(
          invertRawScriptContent(rawContent, this.settings?.get?.('handy.inverted') === true),
        );
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
    // A video load (null) or a script load: the next open sets up afresh.
    this._ensuredFor = null;
  }

  /**
   * A video is loading in this window (app.js `loadVideo`, after its route's
   * unsaved-changes question was answered): what the editor holds is the
   * outgoing video's script, so it starts empty with no path. A script load
   * for the new video fills it right after (`loadScript`); a video with no
   * script stays empty until `_ensureFunscript()` sets it up on the first open.
   *
   * Only the path used to be cleared, and `_ensureFunscript()` emptied the
   * stale points on the next open, unless the engine was loaded: with a phone
   * or a VR session holding the engine, the editor opened on a scriptless
   * video still showed the PREVIOUS video's points, with no path, and Save As
   * wrote them as this video's script (R3-20 fix-up, real-app verifier 1).
   */
  clearForVideoLoad() {
    this._fillDrawer?.close('cancel');
    this.setFunscriptPath(null);
    this.editableScript.loadEmpty();
    this._updateStatus();
    this._updateToolbarState();
    this._broadcastActionsChanged();
  }

  /**
   * Load or reload the script into the editor.
   * Called by app.js after a funscript is loaded or when opening editor without a funscript.
   */
  loadScript() {
    // Another script: a fill previewed on the old one is gone (nothing landed).
    this._fillDrawer?.close('cancel');
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
    // An open pop-out shows what was loaded. A video load empties the editor
    // (`clearForVideoLoad`, which tells the pop-out), and without this the
    // pop-out then stayed empty over the new video's script (R3 fix-up).
    this._broadcastActionsChanged();
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

    // Ensure script data is loaded. Not from an engine the phone or a VR
    // headset loaded (R3-20, also in v0.9.2): that is another video's
    // script, and under this video's path the next save wrote it over this
    // video's script. The editor stays on this window's video.
    if (this.editableScript.actionCount === 0 && !this.editableScript.dirty) {
      if (this.engineHeldByRemote?.() !== true) this.loadScript();
      else if (this.funscriptEngine.isLoaded) showToast(t('editor.toast.remoteScriptNotShown'), 'info', 6000);
    }

    // Update video duration if available
    const duration = this.videoPlayer.duration;
    if (isFinite(duration) && duration > 0) {
      this.graph.setVideoDuration(duration * 1000);
    }

    // Before the focus() below: an inert canvas cannot take focus.
    this._panel.removeAttribute('inert');
    this._panel.classList.add('script-editor--open');
    // While the pop-out window holds the editor the docked panel stays
    // hidden, so the video keeps its full height (R3-22): the pop-out's
    // 'closed' puts the layout back.
    if (!this._popoutOpen) {
      document.getElementById('player-container')?.classList.add('player-container--editor-open');
    }

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

    // Closing the editor cancels an open Fill with pattern: the script is
    // left as it was and the preview goes (and a marked range with it).
    this._fillDrawer?.close('cancel');
    if (this._fillRange) this._setFillRange(null);
    closeContextMenu();

    // Flush pending autosave before closing (only if autosave is enabled)
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
      if (this._autosaveEnabled && this.editableScript.dirty && this._funscriptPath) {
        this._autosave();
      }
    }

    this._panel.classList.remove('script-editor--open');
    // Not focusable or clickable while closed (see _buildPanel); a control
    // that had focus loses it here.
    this._panel.setAttribute('inert', '');
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
   * Opening the editor on a video with no script loaded: an empty script for
   * it at `<videoBase>.funscript`, created on disk when no file is there.
   *
   * Once per loaded video (`_ensuredFor`; `setFunscriptPath()`, which every
   * video load and script load calls, starts it over). The engine only loads
   * on the first save, so until then the editor holds the only copy of the
   * new points, and running again on every open wrote an empty file and
   * emptied the editor: closing and reopening the editor lost every unsaved
   * point with no question (CB-01 review, also in v0.9.2).
   *
   * A file that is already there (one the library had not paired yet, such
   * as a script saved earlier this session) is opened, never overwritten:
   * the empty script written over it lost the saved one. Only a definite
   * "absent" creates the file. Unknown (unreadable, timed out) writes
   * nothing and leaves the editor empty with no path, so a save asks where.
   */
  async _ensureFunscript() {
    if (this.funscriptEngine.isLoaded) return;

    // Need a video path to derive the funscript path
    const videoPath = this._getVideoPath();
    if (!videoPath) return;
    if (this._ensuredFor === videoPath) return; // set up by an earlier open
    this._ensuredFor = videoPath;
    const current = () => this._ensuredFor === videoPath; // no other video since

    // Build funscript path: same directory, same base name, .funscript extension
    const funscriptPath = videoPath.replace(/\.[^/.]+$/, '') + '.funscript';
    // What the editor still holds is the previous video's script (a video
    // load clears only the path), so this one starts empty, before any await.
    // Don't load into funscript engine — it rejects empty action arrays.
    // The engine will be loaded on first save (when actions exist).
    this._funscriptPath = null;
    this._fillDrawer?.close('cancel'); // another script (review-2)
    this.editableScript.loadEmpty();
    this._updateStatus();

    let present = null;
    try {
      present = (await window.funsync.filesExist([funscriptPath]))?.[0] ?? null;
    } catch (err) {
      console.warn('[Editor] Could not check for', funscriptPath, err?.message || err);
    }
    if (!current()) return;
    if (present === true) {
      await this._openUnpairedScript(funscriptPath, current);
      return;
    }
    if (present !== false) return; // unknown: not proof it is missing

    // Create minimal funscript JSON
    const emptyScript = JSON.stringify({
      version: '1.0',
      inverted: false,
      range: 100,
      actions: [],
    }, null, 2);

    try {
      // Write to disk
      const written = await window.funsync.writeFunscript(emptyScript, funscriptPath);
      if (!written || !current()) return;
      this._funscriptPath = funscriptPath;
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

  /**
   * `_ensureFunscript()` found a script at the video's own path that nothing
   * loaded: show what is on disk and edit that file. If it cannot be read or
   * parsed, or points were added while it was read, the editor keeps no path,
   * so nothing is written over the file without a Save As.
   */
  async _openUnpairedScript(path, current) {
    let data = null;
    try {
      const content = await window.funsync.readFunscript(path);
      data = content ? JSON.parse(content) : null;
    } catch (err) {
      console.warn('[Editor] Could not open', path, err?.message || err);
      data = null;
    }
    if (!current() || this.editableScript.dirty) return;
    if (!data || typeof data !== 'object' || !Array.isArray(data.actions)) return;
    this._fillDrawer?.close('cancel'); // another script (review-2)
    this.editableScript.loadFromData(data);
    this._funscriptPath = path;
    this._updateStatus();
    this._updateToolbarState?.();
    this.graph?.fitAll?.();
    this.graph?.draw?.();
    this._broadcastActionsChanged?.();
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

  /** Switch the editor to one of `_availableScripts`, as picking it would. */
  async selectScript(path) {
    if (!this._scriptSelect || !path) return;
    this._scriptSelect.value = path;
    await this._onScriptSelectChange();
  }

  /**
   * The script list's pick (also a lane click and the pop-out's own list).
   * While the switch runs (the unsaved question, the autosave flush, the disk
   * read, the lane rebuild) a pop-out Fill with pattern is refused: the path
   * moves before the file is read, and the new script is in place before the
   * pop-out hears of it (review-2 blocker; _applyPopoutFill).
   */
  async _onScriptSelectChange() {
    this._scriptLoads = (this._scriptLoads || 0) + 1;
    try {
      return await this._switchToSelectedScript();
    } finally {
      this._scriptLoads--;
    }
  }

  async _switchToSelectedScript() {
    const newPath = this._scriptSelect.value;
    if (!newPath || newPath === this._funscriptPath) return;
    // Another script: a Fill with pattern preview of this one goes.
    this._fillDrawer?.close('cancel');

    // An embedded axis has no file to open: put the selector back on the
    // script being edited and hand the pick to app.js, which extracts the
    // axes to companion files and then selects the chosen one (V42).
    const picked = this._availableScripts.find((s) => s.path === newPath);
    if (picked?.embeddedAxis) {
      if (this._funscriptPath) this._scriptSelect.value = this._funscriptPath;
      await this.onEditEmbeddedAxis?.(picked.embeddedAxis);
      return;
    }

    // Unsaved edits to this script are asked about first (CB-01). The switch
    // used to cache only the stacks and reload the file on the way back, so
    // the last unsaved state was gone (TODO Q12's dropdown half). Cancel puts
    // the list back on the script being edited.
    if (this.hasUnsavedChanges()) {
      const go = await this.confirmUnsavedChanges();
      if (!go) {
        if (this._funscriptPath) this._scriptSelect.value = this._funscriptPath;
        // The pick may have come from the pop-out's own list: it goes back
        // too, or it kept naming the new pick over the old script's points
        // (and picking it again fired no change). R3 fix-up, verifier 1.
        this._broadcastScriptsChanged();
        return;
      }
      this._scriptSelect.value = newPath;
    }

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
        // After the waits: a drawer opened meanwhile (the old script was
        // still on screen) previewed THAT script (review-2 blocker).
        this._fillDrawer?.close('cancel');
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
          // The cached entries keep their revision ids (R4-18). The state on
          // screen is the file just read: a fresh id, and the saved one.
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
    // Preview where the device will really go: honour the Handy invert.
    const target = this.settings?.get?.('handy.inverted') === true ? 100 - position : position;
    try {
      this.handyManager.hdspMove(target, 150);
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
      showToast(t('editor.toast.popoutUnavailable'), 'error');
      return;
    }
    if (this._popoutOpen) {
      await window.funsync.editorPopoutClose();
    } else {
      await window.funsync.editorPopoutOpen();
    }
  }

  /**
   * The pop-out button's tooltip and accessible name, in the user's language
   * and kept there by the panel's language walk (data-i18n-*). Both were set
   * to English literals on every pop-out / dock, so after one cycle they
   * stayed English in every language (E-08, also in v0.9.2).
   */
  _labelPopoutButton(key) {
    const btn = this._btnPopout;
    if (!btn) return;
    const text = t(key);
    btn.title = text;
    btn.setAttribute('aria-label', text);
    btn.setAttribute('data-i18n-title', key);
    btn.setAttribute('data-i18n-aria-label', key);
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
        this._labelPopoutButton('editor.btn.dock');
        // Hide the docked editor panel AND let the video reclaim the
        // 250px slot. Without removing the `--editor-open` class on
        // the player container, the CSS rule
        // `.player-container--editor-open .player__video-wrapper { height: calc(100vh - 250px) }`
        // keeps the video compressed even though the editor is gone.
        // Per locked decision §4.3 α, pop-out takes full ownership —
        // main window shows only the video.
        // A Fill with pattern open here is cancelled (the pop-out has its own).
        this._fillDrawer?.close('cancel');
        closeContextMenu();
        if (this._panel) this._panel.hidden = true;
        document
          .getElementById('player-container')
          ?.classList.remove('player-container--editor-open');
        this._startPopoutBroadcast();
      } else if (event.type === 'closed') {
        this._popoutOpen = false;
        this._setToggleState(this._btnPopout, false);
        this._labelPopoutButton('editor.btn.popout');
        this._stopPopoutBroadcast();
        // Always: the docked panel was hidden for the pop-out, whatever
        // happened meanwhile. An editor hidden while popped out (a new
        // video's load) kept `hidden` for good, so it never showed again
        // (R3-22). Closed, it stays out of sight through its own rules
        // (no --open class, inert).
        if (this._panel) this._panel.hidden = false;
        if (this._panel && this._open) {
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
        // Docked into the player view, which the main window may not be
        // showing: app.js brings it up (onPopoutDocked, E-07).
        if (this._open) {
          try { this.onPopoutDocked?.(); } catch (err) { console.warn('[Editor] onPopoutDocked failed:', err); }
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
        if (path === 'player.theme' || path === 'player.uiStyle') {
          // Defer one tick — `theme-manager` writes the `data-theme` /
          // `data-style` attribute on settings:changed; we want to read it
          // AFTER that write so the broadcast carries the new value.
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
      // Seeks and steps go to the video that plays: the player window's
      // while it owns playback (routePlayback, D-01), else the inline one.
      case 'video-seek':
        // payload.time is seconds (matches HTMLVideoElement.currentTime)
        if (typeof payload.time !== 'number') break;
        if (this.routePlayback?.('seekTo', payload.time)) break;
        if (this.videoPlayer?.video) this.videoPlayer.video.currentTime = payload.time;
        break;
      // The pop-out's Space (verify-1, 2026-11-07: it had none). Play or
      // pause, as asked, whichever video plays; togglePlay keeps the inline
      // player's own rules (an ended video replays).
      case 'video-play':
      case 'video-pause': {
        const play = payload.type === 'video-play';
        if (this.routePlayback?.(play ? 'play' : 'pause')) break;
        const v = this.videoPlayer?.video;
        if (v && (play ? (v.paused || v.ended) : !v.paused)) this.videoPlayer.togglePlay?.();
        break;
      }
      case 'video-step-frame':
        if (this.routePlayback?.('stepFrames', payload.direction || 1)) break;
        this.videoPlayer?.stepFrame?.(payload.direction || 1);
        break;
      case 'video-step-frames':
        if (!payload.frames) break;
        if (this.routePlayback?.('stepFrames', payload.frames)) break;
        this.videoPlayer?.stepFrames?.(payload.frames || 0);
        break;
      // The pop-out's Speed list: the video that plays, as the seeks above
      // (E-06, also in v0.9.2: it set the hidden inline element's rate while
      // the player window played on at the old one).
      case 'video-set-rate':
        if (typeof payload.rate !== 'number') break;
        if (this.routePlayback?.('setRate', payload.rate)) {
          if (this._speedSelect) this._speedSelect.value = String(payload.rate);
          break;
        }
        if (this.videoPlayer?.setPlaybackRate) {
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
      case 'request-select-every-nth':
        // The pop-out's Select… → Every Nth point… : the dialog opens here,
        // like Remap; its Select applies to this EditableScript.
        this._openEveryNthModal();
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
   * The switch itself lives in `editor-popout-dispatch.js`, which the
   * routing test imports too: it used to test a COPY of this switch, and
   * the copy drifted (the dead pop-out Ctrl+Shift+V). What needs this
   * editor (toasts) is handed in as hooks.
   */
  _applyPopoutEdit(payload) {
    const notify = this._popoutNotifier();
    applyPopoutEdit(this.editableScript, payload, {
      reportModifierResult: (status, name) => this._reportModifierResult(status, name, undefined, notify),
      selectCreated: () => this._selectCreatedPoints(notify),
      selectEveryNth: (n, start) => this._selectEveryNth(n, start, notify),
      placeAt: (pos, at) => this._placeOrTweakAt(pos, at),
      fillRange: (fill) => this._answerPopoutFill(fill.requestId, this._applyPopoutFill(fill, notify)),
      // Not a valid fill: said in the pop-out too, which keeps its drawer open.
      fillRefused: (raw) => {
        notify(t('editor.patternFill.failed'), 'warn');
        this._answerPopoutFill(raw?.requestId, false);
      },
    });
  }

  /**
   * Where a toast for a command the POP-OUT sent goes: into the pop-out, the
   * window the user is working in (FT-029; Every Nth, N, a refused or no-op
   * Modify item). The same translated text this window would show (the
   * command ran here; the pop-out is in the same language since FT-103).
   * This window while no pop-out is open.
   * @returns {(text: string, type?: string, duration?: number) => void}
   */
  _popoutNotifier() {
    return (text, type = 'info', duration) => {
      if (!this._popoutOpen) {
        showToast(text, type, duration);
        return;
      }
      this._relayToPopout({
        type: 'toast',
        text: String(text),
        level: type,
        ...(typeof duration === 'number' ? { duration } : {}),
        dismissLabel: t('toast.dismissAria'),
      });
    };
  }

  _broadcastInitialState() {
    if (!this._popoutOpen) return;
    const v = this.videoPlayer;
    const clock = this._popoutClock();
    const payload = {
      type: 'initial-state',
      scripts: this._availableScripts || [],
      activePath: this._funscriptPath || null,
      videoSrc: v?.video?.src || '',
      videoDuration: v?.duration || clock?.duration || 0,
      videoTime: clock?.currentTime || 0,
      videoPaused: clock ? clock.paused : true,
      videoRate: v?.video?.playbackRate || 1,
      splineMode: !!this._splineMode,
      snapToFrame: !!this._snapToFrame,
      recordingMode: !!this._recordingMode,
      actions: this.editableScript?.actions || [],
      selectedIndices: [...(this.editableScript?.selectedIndices || [])],
      bookmarks: this.editableScript?.getBookmarks?.() || [],
      dirty: this.editableScript?.dirty === true, // the pop-out's "*" (R4 fix-up)
      // Pop-out applies this as `<html data-theme="...">` so the same
      // design tokens render at the same paint values. Without this
      // the pop-out is hardcoded dark, which regresses light-theme
      // users (DESIGN.md §2.1 — semantic tokens, not named colours).
      theme: document.documentElement.dataset.theme || 'dark',
      uiStyle: document.documentElement.dataset.style || 'classic',
      // Frame duration for the pop-out's snap-to-frame logic. Matches
      // `_frameDurationMs()` in the docked editor — 30 fps standard.
      frameDurationMs: this._frameDurationMs?.() || (1000 / 30),
      // Its Ctrl+Left/Right step, this editor's (D-02).
      fastStepFrames: this._fastStepFrames(),
      // So the pop-out's position keys resolve as this editor's (FT-032).
      customPositionKeys: this._customPositionKeys(),
      // The Fill with pattern drawer's remembered options (editor.patternFill).
      patternFill: this.settings?.get?.('editor.patternFill') ?? null,
      // The pop-out speaks this window's language (FT-103).
      locale: getCurrentLocale(),
    };
    this._relayToPopout(payload);
  }

  /** A language switch here, while the pop-out is open (FT-103). */
  _broadcastLocale() {
    if (!this._popoutOpen) return;
    this._relayToPopout({ type: 'locale', locale: getCurrentLocale() });
  }

  /** Push a theme update to the pop-out when the user changes
   *  Settings → Appearance → Theme while the pop-out is open. */
  _broadcastTheme() {
    if (!this._popoutOpen) return;
    this._relayToPopout({
      type: 'theme',
      theme: document.documentElement.dataset.theme || 'dark',
      uiStyle: document.documentElement.dataset.style || 'classic',
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
      customPositionKeys: this._customPositionKeys(),
      fastStepFrames: this._fastStepFrames(),
      patternFill: this.settings?.get?.('editor.patternFill') ?? null,
    });
  }

  /** The raw `editor.customPositionKeys` setting, always an array. */
  _customPositionKeys() {
    const v = this.settings?.get?.('editor.customPositionKeys');
    return Array.isArray(v) ? v : [];
  }

  /**
   * The clock the pop-out follows (D-01): the player window's while it owns
   * playback (`getPlaybackClock`, set by app.js), else the inline video. The
   * inline element is paused and hidden then, so every tick said "paused at
   * the time the window took over" and the pop-out never moved.
   * @returns {{currentTime: number, paused: boolean, duration: number}|null}
   */
  _popoutClock() {
    let ext = null;
    try { ext = this.getPlaybackClock?.() || null; } catch { ext = null; }
    if (ext) {
      return { currentTime: Number(ext.currentTime) || 0, paused: !!ext.paused, duration: Number(ext.duration) || 0 };
    }
    const v = this.videoPlayer;
    if (!v?.video) return null;
    return { currentTime: v.currentTime, paused: !!v.video.paused, duration: v.duration };
  }

  _broadcastTimeTick() {
    if (!this._popoutOpen) return;
    const clock = this._popoutClock();
    if (!clock) return;
    this._relayToPopout({
      type: 'time-tick',
      time: clock.currentTime,
      paused: clock.paused,
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
      dirty: this.editableScript?.dirty === true, // the pop-out's "*" (R4 fix-up)
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
    if (script.embeddedAxis) {
      // Embedded in the main script: no file, preview the parsed copy (V42).
      const actions = this.getEmbeddedAxisActions?.(script.embeddedAxis);
      if (!Array.isArray(actions) || actions.length === 0) return null;
      editable._actions = actions.map((a) => ({ at: a.at, pos: a.pos }));
    } else if (cached) {
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
      showToast(t('editor.toast.selectToEqualize'), 'info');
      return;
    }
    const count = this.editableScript.selectedIndices.size;
    this.editableScript.equalizeSelected();
    showToast(t('editor.toast.equalized', { count }), 'info');
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
   * — same frame → tweak; different frame → insert new. An insert on a time
   * that already holds a point (selected or not) edits that point instead:
   * EditableScript.insertAction is add-or-edit, OFS's rule (CB-02).
   *
   * @param {number} pos — 0-100
   * @param {number} [atMs] — where; the playhead when omitted. The pop-out
   *   sends the time its own playhead showed (OP_PLACE_AT, FT-032).
   */
  _placeOrTweakAt(pos, atMs) {
    const timeMs = this.snapTime(Number.isFinite(atMs) ? atMs : this.videoPlayer.currentTime * 1000);
    if (this._recordingMode) {
      this.editableScript.insertAction(timeMs, pos);
      this._sendLivePreview(pos);
      return;
    }
    const sel = this.editableScript.selectedIndices;
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
