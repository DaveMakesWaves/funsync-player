// ScriptEditor — Funscript editor panel with OFS-style interactions
// Centered playhead, speed-colored lines, click-to-insert, numpad placement, autosave

import { EditableScript } from '../js/editable-script.js';
import { startDragMove, dragMoveStep } from '../js/editor-drag-move.js';
import { ActionGraph } from '../js/action-graph.js';
import {
  icon, Undo2, Redo2, Save, ZoomIn, ZoomOut, Magnet, Trash2,
  FlipVertical2, Spline, Scissors, WandSparkles, BookmarkPlus, FileText, Rows3,
  AudioWaveform, Music, Layers2, ExternalLink, Plus, CircleDot, Gamepad2, History, FileCheck, Activity,
  FileOutput,
} from '../js/icons.js';
import { GamepadRecorder, DEFAULT_GAMEPAD_MAPPING } from '../js/gamepad-recorder.js';
import { takeToKeyframes, landTake } from '../js/gamepad-recording-math.js';
import { openGamepadRecordMenu, gamepadTargetAxes, createGamepadRecordHud, MAIN_TARGET } from './gamepad-record-menu.js';
import { buildCombinedFunscript, buildSeparateFunscripts } from '../js/combined-funscript.js';
import { AXIS_DEFINITIONS, getAxisBySuffix, buildCompanionPath, axisShortLabel } from '../js/multi-axis.js';
import { extractEmbeddedAxes } from '../js/embedded-multi-axis.js';
import { showToast } from '../js/toast.js';
import { selectionStatsText } from '../js/selection-stats.js';
import { openScriptBackupsDialog } from './script-backups-dialog.js';
import { openScriptCheck } from './script-check-panel.js';
import { openUndoHistoryMenu } from './undo-history-menu.js';
import { HISTORY_LABELS } from '../js/editable-script.js';
import { Modal } from './modal.js';
import {
  halfSpeed, doubleSpeed, reverseActions, remapRange, offsetTime, removePauses, rangeExtend, generatePattern,
  fadeIn, fadeOut, axisFromStroke, quarterCycleMs, vibrateBetween,
} from '../js/script-modifiers.js';
import { openVibratePanel } from './vibrate-panel.js';
import { FASTEST_DEVICE_CAP } from '../js/device-speed-caps.js';
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

/** The stacked tracks' left gutter: the track's name, then the 0-100 scale. */
const TRACK_GUTTER_PX = 92;
/** During playback: the least time between two redraws of the stacked tracks (every frame at 60-75 Hz, every 2nd at 120-165 Hz). */
export const LANE_FRAME_MS = 12;
/** During playback: how often the tracks read where the main plot sits on screen, with no layout change. */
const LANE_ALIGN_MS = 500;

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
    // Lilac above the max speed, dashed below the min (every graph here).
    ActionGraph.setSpeedLimits(this._speedLimits());

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
      if (key === 'editor.maxSpeed' || key === 'editor.minSpeed' || key === 'editor' || key === '*') {
        ActionGraph.setSpeedLimits(this._speedLimits());
        this.graph?.draw?.();
        this._broadcastSettings();
      }
    });
  }

  /**
   * The speed limits the graphs mark (Settings > Keyboard > Editor speed
   * limits): units/s, 0 = not marked. Defaults: roa's 400 max, kinetics'
   * 33 min for the Handy (notes/scripting-research-2026-11-24.md).
   * @returns {{max: number, min: number}}
   */
  _speedLimits() {
    const read = (key, dflt) => {
      const v = Number(this.settings?.get?.(key));
      return Number.isFinite(v) && v >= 0 ? v : dflt;
    };
    return { max: read('editor.maxSpeed', FASTEST_DEVICE_CAP), min: read('editor.minSpeed', 33) };
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
    // Vibrate between the selected points, with a size slider (Dave, 2026-11-24).
    this._btnVibrate = this._makeBtn(Activity, 'editor.vibrate.button', () => this._openVibrate());
    // The undo history (work list 4.5): right-click Undo or Redo, or the History button.
    this._btnUndo.addEventListener('contextmenu', (e) => this._openUndoHistory(e, this._btnUndo));
    this._btnRedo.addEventListener('contextmenu', (e) => this._openUndoHistory(e, this._btnRedo));
    this._btnHistory = this._makeBtn(History, 'editor.history.button', (e) => this._openUndoHistory(e, this._btnHistory));
    // Check script (work list 4.2; FunGen 2's Funscript Doctor).
    this._btnCheck = this._makeBtn(FileCheck, 'editor.check.button', () => this._openScriptCheck());
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
      { value: 'fadeIn', key: 'editor.modify.fadeIn' },            // work list 4.4
      { value: 'fadeOut', key: 'editor.modify.fadeOut' },
      { value: 'rippleDelete', key: 'editor.modify.rippleDelete' }, // work list 4.3 (Shift+Del)
      { value: 'fromStroke', key: 'editor.modify.fromStroke' },     // work list 2.4 (an axis only)
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
    // Recording mode on the toolbar too (work list 4.6; it was R only).
    this._btnRecord = this._markToggleBtn(this._makeBtn(CircleDot, 'editor.btn.record', () => this._toggleRecordingMode()));
    this._btnRecord.classList.add('editor__btn--record');
    // Record two axes from a gamepad's stick (work list 2.6; OFS's two-axis recording).
    this._btnGamepad = this._markToggleBtn(this._makeBtn(Gamepad2, 'editor.gamepad.button', () => this._openGamepadMenu()));
    this._gamepadHud = createGamepadRecordHud();
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
    this._btnSave = btnSave;

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

    // New axis (multi-axis editing, Dave 2026-11-24): an empty script for an
    // axis the video does not have yet, in the combined file when the video's
    // script is combined, else as <main>.<axis>.funscript. Written on Save.
    this._btnNewAxis = this._makeBtn(Plus, 'editor.btn.newAxis', () => this._openNewAxisMenu());
    this._btnNewAxis.hidden = true;
    // Export every axis as one combined file, or as separate files.
    this._btnExportAxes = this._makeBtn(FileOutput, 'editor.btn.exportAxes', () => this._openExportMenu());
    this._btnExportAxes.hidden = true;

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
      this._scriptSelect, this._btnStacked, this._btnNewAxis, this._btnExportAxes, sepScript,
      this._btnUndo, this._btnRedo, this._btnHistory, sep1,
      btnDelete, btnCut, btnInvert, btnSimplify, this._btnVibrate, sep1b,
      this._selectMenu, this._modifySelect, sep1c,
      btnMetadata, btnBookmark, btnFillGaps, this._btnCheck, this._btnWaveform, btnBeats, this._btnRecord, this._btnGamepad, sep1d,
      btnZoomIn, btnZoomOut, btnFitAll, sep2,
      speedGroup, sep3,
      btnSave, this._btnPopout, autosaveGroup, snapLabel, splineLabel, this._recordingIndicator, this._gamepadHud.el, this._statusEl,
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
    this._extraContainer = container;
    const write = (extra) => {
      this._toolbarExtra = extra;
      // The lanes' share depends on the toolbar's rows (a window resize
      // re-wraps it after the lanes were laid out: a live 1280 -> 900 px
      // resize left the video 141 px), so they are laid out again with it.
      const apply = () => {
        if (this._stackedView) this._layoutLanes();
        this._writeEditorExtra();
      };
      if (typeof requestAnimationFrame !== 'function') {
        apply();
        return;
      }
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply();
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

  /**
   * The panel's height past its 250 px: the toolbar's extra rows plus the
   * stacked lanes (2026-11-24), on the player container (the video and the
   * controls move up by it) and on body (the toasts sit above it, S009).
   */
  _writeEditorExtra() {
    const extra = (this._toolbarExtra || 0) + (this._lanesExtra || 0);
    const container = this._extraContainer || document.getElementById('player-container');
    container?.style?.setProperty('--editor-toolbar-extra', `${extra}px`);
    document.body?.style.setProperty('--editor-toolbar-extra', `${extra}px`);
  }

  /**
   * Size the stacked lanes so every one fits (Dave, 2026-11-24). In the docked
   * editor the panel grows by the lanes, up to a third of the window, so the
   * main graph keeps its height; the lanes share that, 48 px each down to 30;
   * more than fit scroll. Re-run on a resize and whenever the lanes change.
   */
  _layoutLanes() {
    // The plot moved or resized: the tracks line up with it again on their next draw.
    this._lanesAlignDirty = true;
    if (!this._lanesResizeWired && typeof window !== 'undefined') {
      this._lanesResizeWired = true;
      window.addEventListener('resize', () => { if (this._stackedView) this._layoutLanes(); });
    }
    // The lanes above the track being edited and the ones below it.
    const boxes = [this._stackedContainer, this._stackedAfter].filter((b) => b?.parentElement);
    const lanesIn = (b) => b.querySelectorAll('.editor__lane').length;
    const shown = boxes.filter((b) => b.childElementCount > 0);
    for (const b of boxes) if (!b.childElementCount) b.style.height = '';
    if (!this._stackedView || !shown.length) {
      if (this._lanesExtra) { this._lanesExtra = 0; this._writeEditorExtra(); }
      return;
    }
    const n = shown.reduce((sum, b) => sum + lanesIn(b), 0);
    // A box's padding and border, and the show-hidden row (+ its gap).
    const chromeOf = (b) => {
      const bar = b.querySelector('.editor__lanes-show-hidden')?.offsetHeight || 0;
      return 5 + (bar ? bar + 1 : 0);
    };
    const chrome = shown.reduce((sum, b) => sum + chromeOf(b), 0);
    const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
    // A third of the window at most, and never so much that the video drops
    // under ~160 px (a 600 px window left it 91 px tall): past that the lanes
    // scroll instead (fit-on-screen pass, 2026-11-24).
    const room = vh - 250 - (this._toolbarExtra || 0) - 160;
    const cap = Math.max(72, Math.min(Math.round(vh / 3), room));
    const want = n * (48 + 1) + chrome;
    const total = Math.min(want, cap);
    const laneH = n ? Math.max(30, Math.min(48, Math.floor((total - chrome) / n) - 1)) : 30;
    // Each box its lanes at that height; short of room, the room shared out
    // (each scrolls), never under one lane.
    const natural = shown.map((b) => lanesIn(b) * (laneH + 1) + chromeOf(b));
    const sum = natural.reduce((a, b) => a + b, 0);
    let height = 0;
    shown.forEach((b, i) => {
      const h = sum <= total ? natural[i]
        : Math.max(Math.min(natural[i], chromeOf(b) + laneH + 1), Math.floor((total * natural[i]) / sum));
      b.style.height = `${h}px`;
      b.style.setProperty('--lane-h', `${laneH}px`);
      height += h;
    });
    // The panel grows by the lanes only while the video keeps its 160 px;
    // past that the main graph gives the rest (it shrinks with its box), down
    // to ~100 px. At 800x500 in German (three toolbar rows) the 72 px of lanes
    // left the video 98 px: the player's control bar rose over the top bar,
    // its seek bar over Back (fit-on-screen pass, 2026-11-24).
    const grow = Math.max(0, Math.min(height, Math.max(room, height - 82)));
    if (this._lanesExtra !== grow) { this._lanesExtra = grow; this._writeEditorExtra(); }
    for (const lane of this._inactiveLanes.values()) { try { lane.graph.resize(); } catch { /* not visible yet */ } }
    this._syncInactiveLanes();
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
        // The grabbed point leads: it follows the cursor's travel since the
        // press and lands on a frame with Snap to frame on (B031).
        const grabbed = this.editableScript.actions[hitIdx];
        this._dragMove = startDragMove({
          anchorAt: grabbed.at, anchorPos: grabbed.pos,
          cursorAt: this._dragStartTime, cursorPos: this._dragStartPos,
        });
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
      // The step from where the points are to where the cursor says, in
      // whole ms (editor-drag-move.js): each mousemove used to add its own
      // raw delta, rounded, to the last, so a long drag drifted off the
      // cursor, and it never snapped to the frame (B031).
      const step = this._dragMove && dragMoveStep(this._dragMove, {
        cursorAt: this.graph.xToTime(x),
        cursorPos: this.graph.yToPos(y),
        snap: this._snapToFrame ? (ms) => this.snapTime(ms) : null,
      });
      if (step) this.editableScript.moveActions(this.editableScript.selectedIndices, step.deltaAt, step.deltaPos);
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
        // Shift+Del: ripple delete (close the gap; work list 4.3).
        if (e.shiftKey && e.key === 'Delete') this._rippleDelete();
        else this._deleteSelected();
        break;

      // PageUp / PageDown: the previous / next script in the list, as OFS's
      // keys for the active script (multi-axis editing, work list 2.1). With
      // one script the key goes on to the player.
      case 'PageUp':
      case 'PageDown':
        if ((this._availableScripts || []).length > 1) {
          e.preventDefault();
          e.stopPropagation();
          this._cycleScript(e.key === 'PageDown' ? 1 : -1);
        }
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
          this.editableScript.moveActions(this.editableScript.selectedIndices, this._frameMoveDeltaMs(-frames), 0);
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
          this.editableScript.moveActions(this.editableScript.selectedIndices, this._frameMoveDeltaMs(frames), 0);
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
          // Up = the NEXT action, as in OpenFunscripter (next_action /
          // next_action_multi on Ctrl). It was the previous one (TedBaxter,
          // Discord #bug-reports, 2026-11-22).
          this._selectAdjacentActionAcrossScripts(1);
        } else {
          this._selectAdjacentAction(1);
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey && this.editableScript.selectedIndices.size > 0) {
          const delta = ctrl ? -1 : -5;
          this.editableScript.moveActions(this.editableScript.selectedIndices, 0, delta);
        } else if (ctrl) {
          // Down = the PREVIOUS action (OFS prev_action / prev_action_multi).
          this._selectAdjacentActionAcrossScripts(-1);
        } else {
          this._selectAdjacentAction(-1);
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
          this.editableScript.paste(this._playheadMs());
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
          // Shift+R: record with a gamepad (work list 2.6); R alone is recording mode.
          if (e.shiftKey) this._openGamepadMenu();
          else this._toggleRecordingMode();
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
          // Ctrl+Shift+S: Save As (belgriffinite #439).
          if (e.shiftKey) this._saveAs();
          else this._save();
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

      // T: the stroke behind an axis off / on (work list 2.3). Not G: that is
      // the player's skip to the next action, and T is free in both.
      case 't':
      case 'T':
        if (!ctrl && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          this._toggleReference();
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
        // E with nothing selected goes on to the player, which closes the
        // editor: E opens it and E closes it again, as the ? list says (the
        // open focuses this canvas, so a second E used to be Equalize and only
        // toasted; work list 5.5, R4-19 note). With a selection it is OFS's
        // Equalize, as before.
        if (!ctrl && this.editableScript.selectedIndices.size > 0) {
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
      case 'fadeIn':
        this._reportModifierResult(this.editableScript.applyModifier(fadeIn),
          'fadeIn', t('editor.toast.appliedFadeIn'));
        break;
      case 'fadeOut':
        this._reportModifierResult(this.editableScript.applyModifier(fadeOut),
          'fadeOut', t('editor.toast.appliedFadeOut'));
        break;
      case 'rippleDelete':
        this._rippleDelete();
        break;
      case 'fromStroke':
        await this._openAxisFromStrokeModal();
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

  /**
   * Ripple delete (Shift+Del, Modify > Ripple delete; work list 4.3): the
   * selected run of points goes and everything after it moves earlier by the
   * run's span. Says what moved, since the rest of the script changes too.
   */
  _rippleDelete(notify = showToast) {
    const r = this.editableScript.rippleDeleteSelected();
    if (r.refused) {
      notify(t('editor.toast.needsContinuous', { name: this._modifierLabel('rippleDelete') }), 'warn');
    } else if (!r.changed) {
      notify(t('editor.toast.rippleNeedsSelection'), 'info');
    } else {
      // Two decimals under a second: 50 ms read as "0.1 s" (hands-on pass).
      notify(t('editor.toast.rippleDone', { count: r.count, seconds: (r.shiftMs / 1000).toFixed(r.shiftMs < 1000 ? 2 : 1) }), 'info');
    }
    return r;
  }

  /**
   * PageUp / PageDown (work list 2.1): switch to the previous / next script
   * in the list, round the end, as a pick in the list would (each axis keeps
   * its edits).
   */
  _cycleScript(dir) {
    const list = this._availableScripts || [];
    if (list.length < 2) return null;
    const i = Math.max(0, list.findIndex((x) => x.path === this._funscriptPath));
    const next = list[(i + dir + list.length) % list.length];
    if (!next || next.path === this._funscriptPath) return null;
    return this.selectScript(next.path);
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

  /**
   * Modify > Make from the stroke… (work list 2.4): the axis on screen made
   * from the main script in one step: shifted in time (a quarter of the
   * stroke's cycle to start with, the usual roll), its depth scaled around a
   * centre, upside down if asked. Replaces the axis's points as ONE undo step;
   * nothing is saved until Save. Only for an axis (not the stroke itself, not
   * Custom Routing).
   */
  async _openAxisFromStrokeModal(notify = showToast) {
    const main = this._mainScriptPath?.();
    const routing = (this._availableScripts || []).some((x) => x.route);
    if (!main || routing || this._isMainActive?.() !== false) {
      notify(t('editor.fromStroke.pickAxis'), 'info');
      return;
    }
    const stroke = this._liveStateOf(main)?.actions
      || (this.funscriptEngine?.isLoaded ? this.funscriptEngine.getActions?.() : null) || [];
    if (stroke.length < 2) {
      notify(t('editor.fromStroke.noStroke'), 'info');
      return;
    }
    const path = this._funscriptPath;
    const axisName = this._entryFor(path)?.label || '';
    const existing = this.editableScript.actionCount;
    const quarter = quarterCycleMs(stroke);
    const result = await Modal.open({
      title: t('editor.fromStroke.title'),
      onRender(body, close) {
        body.innerHTML = `
          <div class="modal-form">
            <label class="modal-label">${_esc(t('editor.fromStroke.shift'))}<input type="number" id="fs-shift" value="${quarter}" step="10" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.fromStroke.scale'))}<input type="number" id="fs-scale" value="100" min="0" max="200" step="5" class="modal-input"></label>
            <label class="modal-label">${_esc(t('editor.fromStroke.centre'))}<input type="number" id="fs-centre" value="50" min="0" max="100" step="5" class="modal-input"></label>
            <label class="modal-check"><input type="checkbox" id="fs-invert"> ${_esc(t('editor.fromStroke.invert'))}</label>
            <div class="modal-hint">${_esc(t('editor.fromStroke.hint', { ms: quarter }))}</div>
            <div class="modal-hint" id="fs-result" aria-live="polite"></div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn modal-btn--secondary" id="fs-cancel">${_esc(t('common.cancel'))}</button>
            <button class="modal-btn modal-btn--primary" id="fs-ok">${_esc(t('connection.btn.apply'))}</button>
          </div>`;
        const read = () => ({
          shiftMs: Number(body.querySelector('#fs-shift').value) || 0,
          scalePct: Number(body.querySelector('#fs-scale').value),
          centre: Number(body.querySelector('#fs-centre').value),
          invert: body.querySelector('#fs-invert').checked,
        });
        const resultEl = body.querySelector('#fs-result');
        const update = () => {
          const n = axisFromStroke(stroke, read()).length;
          resultEl.textContent = existing > 0
            ? t('editor.fromStroke.resultReplace', { count: n, axis: axisName, existing })
            : t('editor.fromStroke.result', { count: n, axis: axisName });
        };
        body.querySelectorAll('input').forEach((el) => el.addEventListener('input', update));
        update();
        body.querySelector('#fs-cancel').addEventListener('click', () => close(null));
        body.querySelector('#fs-ok').addEventListener('click', () => close(read()));
      },
    });
    // Another axis on screen by now (the pop-out switched): nothing lands.
    if (!result || this._funscriptPath !== path) return;
    const made = axisFromStroke(stroke, result);
    const es = this.editableScript;
    es.clearSelection?.();
    const status = es.applyModifier(() => made.map((a) => ({ at: a.at, pos: a.pos })));
    this._reportModifierResult(status, 'fromStroke', t('editor.fromStroke.done', { count: made.length, axis: axisName }), notify);
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

  /**
   * An axis's points as the editor holds them NOW, unsaved edits included, for
   * the device simulator (work list 2.5); null when the editor holds nothing
   * of that axis (then the app's loaded copy is the one to show). No copy is
   * made (the simulator reads it every frame): callers must not change it.
   * @param {string} suffix — an axis suffix (any spelling getAxisBySuffix knows)
   * @returns {Array<{at:number,pos:number}>|null}
   */
  getLiveAxisActions(suffix) {
    const want = getAxisBySuffix(suffix)?.suffix;
    if (!want) return null;
    for (const s of this._availableScripts || []) {
      if (s.route) continue;
      if (getAxisBySuffix(s.embeddedAxis || s.axis || '')?.suffix !== want) continue;
      if (s.path === this._funscriptPath) return this.editableScript.actions;
      return this._undoCache?.get(s.path)?.state?.actions || null;
    }
    return null;
  }

  /**
   * Vibrate (Dave, 2026-11-24; OFS has it as an add-on): small up-and-down
   * moves between the selected points, previewed live on the graph while
   * Size / Rate / Taper move, kept under the max speed, landed as ONE undo step.
   */
  _openVibrate() {
    if (this._panel?.hasAttribute?.('inert')) return;
    openVibratePanel({
      anchor: this._btnVibrate,
      graph: this.graph,
      getActions: () => this.editableScript.actions,
      getSelected: () => this.editableScript.selectedIndices,
      // No cap (Dave, 2026-11-24: "there shouldnt really be a limit ...
      // sometimes going over the limit is a trick people use for unusual
      // movements"): written as the sliders say; the user's mark is only said.
      getMaxSpeed: () => 0,
      getMarkSpeed: () => this._speedLimits?.()?.max || 0,
      initial: this._vibrateLast,
      onRemember: (o) => { this._vibrateLast = o; this._broadcastSettings?.(); },
      onApply: (opts) => {
        const before = this.editableScript.actionCount;
        const status = this.editableScript.applyModifier(vibrateBetween, opts);
        this._reportModifierResult(status, 'vibrate', t('editor.vibrate.done', { count: this.editableScript.actionCount - before }));
      },
      returnFocus: this._canvas,
    });
  }

  /** The undo history (work list 4.5): newest first; a pick undoes or redoes to there. */
  _openUndoHistory(e, anchor) {
    e?.preventDefault?.();
    const r = anchor?.getBoundingClientRect?.() || { left: 0, bottom: 0 };
    const fromPointer = e?.type === 'contextmenu' && Number.isFinite(e.clientX);
    openUndoHistoryMenu({
      x: fromPointer ? e.clientX : r.left, y: fromPointer ? e.clientY : r.bottom,
      history: this.editableScript.undoHistory(),
      extra: [{ label: t('editor.backups.menuItem'), hint: t('editor.backups.menuHint'), disabled: !this._backupFilePath(), onSelect: () => this._openBackups() }],
      onPick: (kind, steps) => {
        const n = kind === 'undo' ? this.editableScript.undoSteps(steps) : this.editableScript.redoSteps(steps);
        if (n > 1) showToast(t(kind === 'undo' ? 'editor.history.toastUndone' : 'editor.history.toastRedone', { count: n }), 'info');
      },
      returnFocus: this._canvas,
    });
  }

  /**
   * Check script (work list 4.2): strokes over the speed limit or too slow
   * for the Handy, points at one time, positions out of range, long gaps. A
   * row jumps there and selects its points; Select all takes a whole kind.
   */
  async _openScriptCheck() {
    const es = this.editableScript;
    await openScriptCheck({
      actions: es.actions,
      getActions: () => this.editableScript.actions,
      limits: { ...this._speedLimits(), frameMs: this._frameDurationMs() },
      onJump: (at) => {
        this.videoPlayer.video.currentTime = at / 1000;
        this.graph.centerOnTime(at);
        this.graph.draw();
        this._updateScrubber?.();
      },
      onSelect: (indices) => {
        this.editableScript.selectIndices(indices);
        this._canvas?.focus?.({ preventScroll: true });
      },
    });
  }

  // --- Gamepad recording (work list 2.6) ---
  // OFS records roll and pitch from a controller's stick while the video plays.
  // Here: left / right into one axis, up / down into another (Roll and Pitch
  // by default, any of the motion axes or the stroke), each take reduced to
  // keyframes and landed as ONE undo step on each axis (per-axis undo). An
  // axis the video lacks is created as a new, empty axis first. The recorder
  // lives in this window, on the real video's time; the pop-out drives it.

  _gamepadMapping() {
    return { ...DEFAULT_GAMEPAD_MAPPING, ...(this.settings?.get?.('editor.gamepad') || {}) };
  }

  _gamepadRecorder() {
    if (this._gamepad) return this._gamepad;
    const v = () => this.videoPlayer?.video;
    this._gamepad = new GamepadRecorder({
      getVideoTimeMs: () => (this.videoPlayer?.currentTime || 0) * 1000,
      isPlaying: () => !!v() && !v().paused && !v().ended,
      // Each pause or seek lands the take so far.
      onTake: (take) => { this._landGamepadTakes([take]).catch((err) => console.warn('[Editor] gamepad take:', err?.message || err)); },
      onFrame: (f) => this._gamepadHud?.update({ ...f, labelA: this._gamepadLabel('a'), labelB: this._gamepadLabel('b') }),
      onPadsChanged: (_pads, type) => {
        if (type === 'gamepaddisconnected' && this._gamepad?.recording && !this._gamepad.activePad()) {
          showToast(t('editor.gamepad.toast.padLost'), 'warn');
        }
      },
    });
    return this._gamepad;
  }

  /** The gamepad menu (the toolbar button, Shift+R): axes, inverts, Start / Stop. */
  _openGamepadMenu(x, y) {
    if (this._panel?.hasAttribute?.('inert')) return;
    const rec = this._gamepadRecorder();
    const r = this._btnGamepad?.getBoundingClientRect?.() || { left: 0, bottom: 0 };
    const routing = (this._availableScripts || []).some((e) => e.route);
    openGamepadRecordMenu({
      x: x ?? r.left, y: y ?? r.bottom,
      axes: gamepadTargetAxes({ present: this._axesPresent(), withMain: !!this._mainScriptPath() }),
      current: this._gamepadMapping(),
      padName: rec.padName(), getPadName: () => rec.padName(),
      recording: rec.recording,
      onPick: (m) => { this.settings?.set?.('editor.gamepad', m); this._broadcastSettings(); },
      // No script, or Custom Routing (its scripts are not one device's axes): no Start.
      onStart: this._mainScriptPath() && !routing ? (m) => this._startGamepadRecording(m) : undefined,
      onStop: () => this._stopGamepadRecording(),
      returnFocus: this._btnGamepad,
    });
  }

  _gamepadTargetPath(id) {
    if (id === MAIN_TARGET) return this._mainScriptPath();
    const e = (this._availableScripts || []).find((x) => !x.route && getAxisBySuffix(x.embeddedAxis || x.axis || '')?.suffix === id);
    return e?.path || null;
  }

  _gamepadLabel(which) {
    const id = which === 'a' ? this._gamepadTargets?.mapping?.x : this._gamepadTargets?.mapping?.y;
    if (!id) return '';
    return id === MAIN_TARGET ? t('editor.mainAxisLabel') : axisShortLabel(id);
  }

  async _startGamepadRecording(m = this._gamepadMapping()) {
    const rec = this._gamepadRecorder();
    if (rec.recording || !this._mainScriptPath()) return;
    // A target the video lacks becomes a new, empty axis (New axis); creating
    // one switches to it, so the axis that was on screen comes back after.
    const back = this._funscriptPath;
    for (const id of [m.x, m.y]) {
      if (id && id !== MAIN_TARGET && !this._axesPresent().has(id)) await this._createAxis(id);
    }
    if (back && this._funscriptPath !== back) await this.selectScript(back);
    this._gamepadTargets = { a: this._gamepadTargetPath(m.x), b: this._gamepadTargetPath(m.y), mapping: m };
    rec.configure({ invertA: !!m.invertX, invertB: !!m.invertY });
    if (!rec.start()) return;
    this._setToggleState(this._btnGamepad, true);
    if (!this._recordingMode) this._toggleRecordingMode();   // REC, and the video plays, as R does
    showToast(t('editor.gamepad.toast.on'), 'info');
    this._broadcastSettings();
  }

  async _stopGamepadRecording() {
    const rec = this._gamepad;
    if (!rec?.recording) return;
    const out = rec.stop();                                    // what a pause has not landed yet
    if (this._gamepadHud) this._gamepadHud.el.hidden = true;
    this._setToggleState(this._btnGamepad, false);
    if (out?.segments?.length) await this._landGamepadTakes(out.segments);
    showToast(t('editor.gamepad.toast.off'), 'info');
    this._broadcastSettings();
  }

  /** Takes onto both target axes: ONE undo step on each. */
  async _landGamepadTakes(takes) {
    const tg = this._gamepadTargets;
    if (!tg || !takes?.length) return;
    const opts = { epsilon: 2, minIntervalMs: this._frameDurationMs(), snap: this._snapToFrame ? (ms) => this.snapTime(ms) : null };
    const keyed = takes.map((tk) => takeToKeyframes(tk, opts)).filter(Boolean);
    if (!keyed.length) return;
    const ra = await this._landOnAxis(tg.a, keyed.map((k) => ({ t0: k.t0, t1: k.t1, actions: k.a })));
    const rb = tg.b === tg.a ? { changed: false, created: 0 } : await this._landOnAxis(tg.b, keyed.map((k) => ({ t0: k.t0, t1: k.t1, actions: k.b })));
    if (ra.changed || rb.changed) {
      showToast(t('editor.gamepad.toast.landed', { count: ra.created + rb.created, axisA: this._gamepadLabel('a'), axisB: this._gamepadLabel('b') }), 'info');
    } else {
      showToast(t('editor.gamepad.toast.nothing'), 'info');
    }
  }

  async _landOnAxis(path, segments) {
    const none = { changed: false, created: 0, removed: 0 };
    if (!path) return none;
    if (path === this._funscriptPath) return landTake(this.editableScript, segments);
    const es = new EditableScript();
    const kept = this._undoCache.get(path);
    if (kept) {
      es.importState(kept.state);
    } else {
      // Not touched this session: as a switch would load it.
      const entry = this._entryFor(path);
      if (entry?.embeddedAxis) es.loadFromData({ actions: this.getEmbeddedAxisActions?.(entry.embeddedAxis) || [] });
      else if (entry?.isNew) es.loadFromData({ actions: [] });
      else {
        try {
          const c = await window.funsync.readFunscript(path);
          es.loadFromData(c ? JSON.parse(c) : { actions: [] });
        } catch { return none; }
      }
      // After the read: the axis may be on screen, or kept, by now.
      if (path === this._funscriptPath) return landTake(this.editableScript, segments);
      const now = this._undoCache.get(path);
      if (now) es.importState(now.state);
    }
    const r = landTake(es, segments);
    if (r.changed) {
      this._undoCache.set(path, { state: es.exportState(), dirty: true });
      this._reportDirty();
      if (this._stackedView) await this._rebuildInactiveLanes();
      if (this._popoutLanesOn) this._broadcastLanes();
    }
    return r;
  }

  _toggleRecordingMode() {
    this._recordingMode = !this._recordingMode;
    this._recordingIndicator.hidden = !this._recordingMode;
    this._setToggleState(this._btnRecord, this._recordingMode);
    // Recording mode off ends a gamepad take too (it lands on its axes).
    if (!this._recordingMode && this._gamepad?.recording) this._stopGamepadRecording();

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
        this.editableScript.insertActions(pattern, HISTORY_LABELS.generatePattern);
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
        this.editableScript.insertActions(newActions, HISTORY_LABELS.beats);
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
        this.editableScript.insertActions(filled, HISTORY_LABELS.fillGaps);
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
    // One Save for every axis (multi-axis editing, Dave 2026-11-24): the one
    // on screen, then every axis kept in memory with unsaved edits. The axes
    // of a combined file go back as ONE write of that file, in the new
    // format (combined-funscript.js); the others to their own files.
    if (this._inCombinedFile(this._funscriptPath)) {
      await this._writeInTurn(() => this._saveCombinedFile({ syncEngine }));
    } else {
      await this._saveActive({ syncEngine });
    }
    await this._saveKeptAxes({ syncEngine });
    this._reportDirty();
  }

  /** Ctrl+S's write of the axis on screen when it has a file of its own (or Save As for none). */
  async _saveActive({ syncEngine = true } = {}) {
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
        this._afterAxisWritten(path, savedPath, { syncEngine });
      }
    } catch (err) {
      showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
    }
  }

  /**
   * After an axis's own file was written: the MAIN script goes to the engine
   * and the Handy as before; any other axis is handed to app.js, which plays
   * it on its own channel (and learns a new one). It used to load ANY saved
   * axis into the main engine: a saved twist edit was then played by the
   * Handy as the stroke (found 2026-11-24 building multi-axis editing).
   */
  _afterAxisWritten(path, savedPath, { syncEngine = true } = {}) {
    const entry = this._entryFor(path);
    const created = !!entry?.isNew;
    if (entry?.isNew) entry.isNew = false;           // on disk now
    if (path === this._mainScriptPath()) {
      if (syncEngine) this._reloadIntoEngineAndSync(this._liveStateOf(path)?.actions || null);
    } else if (syncEngine) {
      const suffix = getAxisBySuffix(entry?.axis || '')?.suffix || null;
      try { this.onAxisSaved?.({ path: savedPath, suffix, created }); } catch { /* the app's refresh only */ }
    }
    this._announceSaved(savedPath);
  }

  /**
   * Write every axis kept in memory with unsaved edits (Save is for all of
   * them). An axis inside the combined file goes with that file's one write.
   */
  async _saveKeptAxes({ syncEngine = true } = {}) {
    let combinedDone = this._inCombinedFile(this._funscriptPath);
    for (const [path, kept] of [...(this._undoCache || [])]) {
      if (!kept.dirty) continue;
      if (this._inCombinedFile(path)) {
        if (!combinedDone) {
          combinedDone = true;
          await this._writeInTurn(() => this._saveCombinedFile({ syncEngine }));
        }
        continue;
      }
      await this._writeInTurn(() => this._saveKeptAxis(path, { syncEngine }));
    }
  }

  /** One kept axis to its own file (no toast: Save's one toast covers them). */
  async _saveKeptAxis(path, { syncEngine = true } = {}) {
    const kept = this._undoCache?.get(path);
    if (!kept?.dirty) return;
    const es = new EditableScript();
    es.importState(kept.state);
    const revision = es.revision;
    try {
      const savedPath = await window.funsync.writeFunscript(es.toFunscriptJSON(), path);
      if (!savedPath) return;
      const still = this._undoCache.get(path);
      if (still && still.state.revision === revision) {
        still.state.savedRevision = revision;
        still.dirty = false;
      } else if (this._funscriptPath === path) {
        this.editableScript.markSaved(revision);       // came on screen during the write
      }
      this._afterAxisWritten(path, savedPath, { syncEngine });
    } catch (err) {
      showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
    }
  }

  /**
   * The axes as they are now, unsaved edits included: the main script as it
   * would be written alone, and suffix -> points for the others. For Save of
   * a combined file (`embeddedOnly`: the axes that live in it) and Export.
   * An axis not touched this session comes from its file / the combined file.
   */
  async _collectAxes({ embeddedOnly = false } = {}) {
    const mainPath = this._mainScriptPath();
    const revisions = new Map();
    const mainState = mainPath ? this._liveStateOf(mainPath) : null;
    let mainJson = null;
    if (mainState) {
      const es = new EditableScript();
      es.importState(mainState);
      mainJson = JSON.parse(es.toFunscriptJSON());
      revisions.set(mainPath, mainState.revision);
    } else if (mainPath && !mainPath.includes('#embedded=')) {
      try {
        const content = await window.funsync.readFunscript(mainPath);
        if (content) mainJson = JSON.parse(content);
      } catch { mainJson = null; }
    }
    // Every axis the main file already carries first: one covered by a
    // companion file (played from that file) is still the file's own and
    // stays in it. The axes of this session then go over them.
    // One key per axis, whatever spelling a file used (suction / suck ...).
    const canon = (suffix) => getAxisBySuffix(suffix)?.suffix || null;
    const axes = new Map();
    for (const [suffix, actions] of mainJson ? extractEmbeddedAxes(mainJson) : []) if (canon(suffix)) axes.set(canon(suffix), actions);
    for (const s of this._availableScripts || []) {
      if (s.path === mainPath || s.route) continue;
      if (embeddedOnly && !s.embeddedAxis) continue;
      const suffix = canon(s.embeddedAxis || s.axis);
      if (!suffix) continue;
      const st = this._liveStateOf(s.path);
      if (st) {
        axes.set(suffix, st.actions);
        revisions.set(s.path, st.revision);
      } else if (s.embeddedAxis) {
        const actions = this.getEmbeddedAxisActions?.(s.embeddedAxis);
        if (Array.isArray(actions)) axes.set(suffix, actions);
      } else if (!s.isNew) {
        try {
          const content = await window.funsync.readFunscript(s.path);
          if (content) axes.set(suffix, JSON.parse(content).actions || []);
        } catch { /* an unreadable axis file is left out */ }
      }
    }
    return { mainPath, mainState, mainJson, axes, revisions };
  }

  /**
   * Write the combined main file: the stroke and every axis inside it, in
   * the new format (funscript 2.0 + the `axes` mirror, combined-funscript.js).
   * A combined file is the master copy (Dave, 2026-11-24), so its axes are
   * saved back into it, never split into companion files. Every axis written
   * is clean at the state written (R4-18), the engine gets the stroke, and
   * app.js re-reads the file for the other axes.
   */
  async _saveCombinedFile({ syncEngine = true, autosave = false } = {}) {
    const { mainPath, mainState, mainJson, axes, revisions } = await this._collectAxes({ embeddedOnly: true });
    if (!mainPath || !mainJson) return;
    const out = buildCombinedFunscript(mainJson, axes);
    try {
      const savedPath = await window.funsync.writeFunscript(JSON.stringify(out, null, 2), mainPath);
      if (!savedPath) return;
      for (const [path, rev] of revisions) {
        if (!Number.isFinite(rev)) continue;
        if (path === this._funscriptPath) {
          this.editableScript.markSaved(rev);
        } else {
          const kept = this._undoCache.get(path);
          if (kept && kept.state.revision === rev) {
            kept.state.savedRevision = rev;
            kept.dirty = false;
          }
        }
      }
      for (const s of this._availableScripts || []) if (s.embeddedAxis && s.isNew) s.isNew = false;
      this._updateStatus();
      if (!autosave) showToast(t('editor.toast.saved'), 'info');
      if (syncEngine) {
        if (mainState) this._reloadIntoEngineAndSync(mainState.actions);
        try { this.onCombinedSaved?.({ path: mainPath }); } catch { /* the app's refresh only */ }
      }
      this._announceSaved(savedPath);
      this._reportDirty();
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
    // An axis of the combined file is written with the whole file, never to
    // its own (virtual) path (multi-axis editing).
    if (this._inCombinedFile(this._funscriptPath)) {
      await this._saveCombinedFile({ syncEngine, autosave: true });
      return;
    }

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
        this._afterAxisWritten(this._funscriptPath, savedPath, { syncEngine });

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

  /**
   * True while any axis of this video holds edits that are not on disk: the
   * one on screen or one kept in memory (multi-axis editing). Every route
   * that would drop them asks first (CB-01), and Save writes them all.
   */
  hasUnsavedChanges() {
    return this._dirtyAxisCount() > 0;
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
        // Whether ANY axis has unsaved edits, not just this one (multi-axis).
        this._reportDirty();
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
    // The one script with unsaved edits: the one on screen, or one kept in
    // memory; an axis inside the combined file by its list name, not its
    // virtual path (multi-axis editing).
    const dirtyPath = this.editableScript?.dirty ? this._funscriptPath
      : ([...(this._undoCache || [])].find(([, k]) => k.dirty)?.[0] || this._funscriptPath);
    const entry = this._entryFor(dirtyPath);
    const name = (entry?.embeddedAxis ? entry.label : dirtyPath?.split(/[\\/]/).pop())
      || (videoName ? videoName.replace(/\.[^/.]+$/, '') + '.funscript' : 'script.funscript');
    const editor = this;
    // Several axes with unsaved edits: one question for all of them, as Save
    // writes them all (multi-axis editing).
    const many = this._dirtyAxisCount();
    const asked = Modal.open({
      title: many > 1 ? t('editor.unsaved.titleMany', { count: many }) : t('editor.unsaved.title', { name }),
      onRender(body, close) {
        editor._closeUnsavedQuestion = close; // withdrawUnsavedQuestion
        const msg = document.createElement('div');
        msg.className = 'modal-message';
        msg.textContent = many > 1 ? t('editor.unsaved.messageMany') : t('editor.unsaved.message');
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
    // Every axis goes back to its file (multi-axis editing): the ones kept in
    // memory with unsaved edits are dropped (their history leads into the
    // discarded edits), and an axis created here and never saved goes. The
    // axis on screen reloads; if it was such a new axis, or one inside the
    // combined file, the main script comes on screen instead.
    for (const [p, kept] of [...(this._undoCache || [])]) if (kept.dirty) this._undoCache.delete(p);
    const unsavedNew = new Set((this._availableScripts || []).filter((s) => s.isNew).map((s) => s.path));
    let path = this._funscriptPath;
    if (unsavedNew.has(path) || this._entryFor(path)?.embeddedAxis) {
      path = this._mainScriptPath();
      this._undoCache?.delete(path);
      this._funscriptPath = path;
    }
    if (unsavedNew.size) {
      this._availableScripts = this._availableScripts.filter((s) => !s.isNew);
      this._updateScriptSelect();
    }
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
    if (this._scriptSelect && this._funscriptPath) this._scriptSelect.value = this._funscriptPath;
    this._reportDirty();
    this._updateStatus?.();
    this._updateToolbarState?.();
    this.graph?.draw?.();
    this._broadcastActionsChanged?.();
    this._broadcastScriptsChanged?.();
  }

  /**
   * Reload the MAIN script's points into the funscript engine and re-upload
   * to the Handy. `mainActions`: the main script's points when it is not the
   * axis on screen; without it, the axis on screen, and only when it IS the
   * main script (another axis never goes into the main engine).
   */
  async _reloadIntoEngineAndSync(mainActions = null) {
    const actions = Array.isArray(mainActions) ? mainActions
      : (this._isMainActive() ? this.editableScript.actions : null);
    if (!actions || actions.length === 0) return; // nothing to sync
    // The phone or a VR headset drives the devices from ITS script in the
    // engine: this window's edits are saved to their own file, never pushed
    // into that engine or re-uploaded to the Handy over it (R3-20).
    if (this.engineHeldByRemote?.() === true) return;

    if (!this.funscriptEngine.isLoaded) {
      // Engine wasn't loaded yet (e.g. we auto-created an empty script).
      // Now that we have actions, load the full funscript into the engine:
      // the main script, which is the one on screen here (a new script).
      if (!this._isMainActive()) return;
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
    this._refreshHeatmap(actions);
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

  /** The seek bar's heatmap: the MAIN script (`actions`), else the axis on screen when it is the main one. */
  _refreshHeatmap(actions = null) {
    const list = Array.isArray(actions) ? actions : (this._isMainActive() ? this.editableScript.actions : null);
    const duration = this.videoPlayer.duration;
    if (list && isFinite(duration) && duration > 0 && list.length >= 2) {
      this.progressBar.renderHeatmap(list, duration);
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
    // Two or more selected: the span and the strokes' speeds (work list 4.1).
    const stats = selected > 1 ? selectionStatsText(this.editableScript.actions, this.editableScript.selectedIndices, t) : '';
    if (stats) text += ` · ${stats}`;
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
    // Another video: a gamepad take in progress ends (its pause already landed it).
    if (this._gamepad?.recording) { this._gamepad.cancel(); this._gamepadTargets = null; if (this._gamepadHud) this._gamepadHud.el.hidden = true; this._setToggleState(this._btnGamepad, false); }
    this._hiddenLanes?.clear();                       // another video: every lane shows again
    this.editableScript?.setVideoDuration?.(0);        // its length is not known yet (5.3)
    // Another video: the axes kept for the last one, and any new axis it
    // never saved, go with it (its unsaved edits were asked about first).
    this._undoCache?.clear();
    if ((this._availableScripts || []).some((s) => s.isNew)) {
      this._availableScripts = this._availableScripts.filter((s) => !s.isNew);
    }
    this.setFunscriptPath(null);
    this.editableScript.loadEmpty();
    this._reportDirty();
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
      // The saved metadata block's duration (OFS writes the video's; work list 5.3).
      this.editableScript.setVideoDuration?.(duration * 1000);
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
    // Every way in (E, the player's button, the menu, Fill from the bar)
    // tells the app, which pauses Up Next for an open editor: opened with E,
    // a card already up stayed behind the editor (fit-on-screen pass).
    try { this.onOpenChange?.(true); } catch { /* the app's, not ours */ }
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
      // The saved metadata block's duration (OFS writes the video's; work list 5.3).
      this.editableScript.setVideoDuration?.(duration * 1000);
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
    try { this.onOpenChange?.(false); } catch { /* the app's, not ours */ }
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

  /** Open AND docked in the player (not in the pop-out window): what covers the bottom of the player. */
  get dockedOnScreen() {
    return this._open && !this._popoutOpen;
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

    // Build funscript path: same directory, same base name, .funscript extension.
    // The FILE's extension only ([^/\\.] stops at a Windows separator): a
    // dotted folder is never cut (2026-11-22, as FT-069 / FT-070).
    const funscriptPath = videoPath.replace(/\.[^/\\.]+$/, '') + '.funscript';
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
    const incoming = scripts || [];
    // An axis created here and not saved yet is not on disk, so app.js's
    // list (built from the files) does not have it: it stays, with its
    // points, until Save writes it or the video changes (multi-axis editing).
    const kept = (this._availableScripts || []).filter((s) => s.isNew && !incoming.some((n) => n.path === s.path));
    const list = incoming.length || !kept.length ? [...incoming, ...kept]
      : [{ label: t('editor.mainAxisLabel'), path: this._mainScriptPath() || '', kind: 'main' }, ...kept];
    this._availableScripts = list;
    this._updateScriptSelect();
    this._broadcastScriptsChanged();
  }

  _updateScriptSelect() {
    if (!this._scriptSelect) return;
    const show = this._availableScripts.length > 1;
    this._scriptSelect.hidden = !show;

    // New axis / Export: whenever a script is loaded, except under Custom
    // Routing (its list is device routes, not the axes of one script).
    const routing = this._availableScripts.some((s) => s.route);
    const axisTools = !routing && !!this._mainScriptPath();
    if (this._btnNewAxis) this._btnNewAxis.hidden = !axisTools;
    if (this._btnExportAxes) this._btnExportAxes.hidden = !axisTools;

    // Also show/hide the separator
    const sep = this._panel?.querySelector('.editor__script-sep');
    if (sep) sep.hidden = !show && !axisTools;

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

    // Multi-axis editing (Dave, 2026-11-24): every axis keeps its own points,
    // undo history and unsaved edits in memory while another is on screen,
    // and one Save writes them all, so a switch asks nothing (it asked Save /
    // Don't save / Cancel each time with autosave off, CB-01). An axis inside
    // the combined main file is edited in place (it was extracted to
    // companion files first, V42), and a new axis starts empty.
    const picked = this._availableScripts.find((s) => s.path === newPath);

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

    // The timeline's view stays where it is: the same video, the same
    // moment (a track click zoomed right out, fitAll, Dave 2026-11-24).
    const keptView = this.graph && this.graph.viewEndMs > this.graph.viewStartMs
      ? [this.graph.viewStartMs, this.graph.viewEndMs] : null;

    // Load the new script: the state it was left in this session, else its
    // points inside the combined file, an empty new axis, or the file.
    this._funscriptPath = newPath;
    try {
      const cached = this._undoCache.get(newPath);
      let parsed = null;
      if (!cached) {
        if (picked?.embeddedAxis) {
          const actions = this.getEmbeddedAxisActions?.(picked.embeddedAxis) || [];
          parsed = { actions: actions.map((a) => ({ at: a.at, pos: a.pos })) };
        } else if (picked?.isNew) {
          // Empty (Dave: "start a new axis completely empty"). A companion
          // file takes the main script's metadata block (title, creator ...),
          // as OFS writes it into every axis; inside the combined file the
          // one block at the top serves every axis.
          parsed = { actions: [] };
          const mainMeta = this._liveStateOf(this._mainScriptPath())?.metadata?.metadata;
          if (!picked.embeddedAxis && mainMeta && typeof mainMeta === 'object') parsed.metadata = structuredClone(mainMeta);
        } else {
          const content = await window.funsync.readFunscript(newPath);
          // Bail if a newer selection happened during the disk read. This
          // is the race the SR6 user was hitting.
          if (token !== this._loadToken) return;
          parsed = content ? JSON.parse(content) : null;
        }
      }

      if (cached || parsed) {
        // After the waits: a drawer opened meanwhile (the old script was
        // still on screen) previewed THAT script (review-2 blocker).
        this._fillDrawer?.close('cancel');
        if (cached) {
          // The axis as it was left: points, history, unsaved edits.
          this.editableScript.importState(cached.state);
          this._undoCache.delete(newPath);
        } else {
          this.editableScript.loadFromData(parsed);
        }
        this._reportDirty();

        if (keptView) this.graph?.setViewport(keptView[0], keptView[1]);
        else this.graph?.fitAll();
        this._updateToolbarState();
        if (this._statusEl) this._statusEl.textContent = (this._entryFor(newPath)?.label) || newPath.split(/[\\/]/).pop();

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

  /**
   * Keep the axis on screen in memory while another one is edited: its whole
   * editing state (EditableScript.exportState: points, history, unsaved
   * edits). `_undoCache` holds every axis of this video that is NOT on
   * screen; switching back puts it back exactly (multi-axis editing).
   */
  _cacheUndoState() {
    if (!this._funscriptPath) return;
    this._undoCache.set(this._funscriptPath, {
      state: this.editableScript.exportState(),
      dirty: this.editableScript.dirty,
    });
  }

  _restoreUndoState() {
    if (!this._funscriptPath) return;
    const cached = this._undoCache.get(this._funscriptPath);
    if (!cached) return;
    this.editableScript.importState(cached.state);
    this._undoCache.delete(this._funscriptPath);
  }

  // --- The axes of this video (multi-axis editing, 2026-11-24) ---

  /** The list entry for `path`, or null (a single script has no list). */
  _entryFor(path) {
    return (this._availableScripts || []).find((s) => s.path === path) || null;
  }

  /** The main (stroke) script's file: the list's main entry, else the script being edited. */
  _mainScriptPath() {
    const list = this._availableScripts || [];
    const main = list.find((s) => s.kind === 'main') || (list.length && !list.some((s) => s.route) ? list[0] : null);
    return main?.path || (list.length ? null : this._funscriptPath) || null;
  }

  _isMainActive() {
    const main = this._mainScriptPath();
    return !main || this._funscriptPath === main;
  }

  /** The video's script is one combined file (it holds axes of its own): it is the master copy. */
  _isCombinedMaster() {
    return (this._availableScripts || []).some((s) => s.embeddedAxis);
  }

  /** Part of the combined main file: the main script or an axis inside it. */
  _inCombinedFile(path) {
    if (!this._isCombinedMaster()) return false;
    return path === this._mainScriptPath() || !!this._entryFor(path)?.embeddedAxis;
  }

  /**
   * An axis's state as it is now: the one on screen, or kept in memory.
   * Null for an axis not touched this session (the file / the combined
   * file holds it as it is).
   */
  _liveStateOf(path) {
    if (path === this._funscriptPath) return this.editableScript?.exportState?.() || null;
    return this._undoCache?.get(path)?.state || null;
  }

  /** How many axes hold edits that are not on disk. */
  _dirtyAxisCount() {
    let n = this.editableScript?.dirty ? 1 : 0;
    for (const c of this._undoCache?.values?.() || []) if (c.dirty) n++;
    return n;
  }

  /**
   * Tell main whether ANY axis has unsaved edits (R3-19: it holds a close,
   * quit or reload for the question only while this says so). The axis on
   * screen reports through _watchDirtyState; a switch, a save of an axis
   * kept in memory or a Don't save changes the answer without it.
   */
  _reportDirty() {
    const any = this.hasUnsavedChanges();
    if (any === this._reportedDirty) return;
    this._reportedDirty = any;
    try { window.funsync?.editorDirtyChanged?.(any); } catch { /* reporting only */ }
  }

  /** The axes this video has: a canonical suffix for each list entry that is an axis. */
  _axesPresent() {
    const have = new Set();
    for (const s of this._availableScripts || []) {
      const suffix = getAxisBySuffix(s.embeddedAxis || s.axis || '')?.suffix;
      if (suffix) have.add(suffix);
    }
    return have;
  }

  /** The New axis menu: every axis, the ones the video has greyed. */
  _openNewAxisMenu() {
    if (!this._mainScriptPath()) return;
    const have = this._axesPresent();
    const r = this._btnNewAxis.getBoundingClientRect();
    openContextMenu({
      x: r.left, y: r.bottom,
      ariaLabel: t('editor.newAxis.menu'),
      returnFocus: this._btnNewAxis,
      items: AXIS_DEFINITIONS.map((def) => ({
        label: `${def.label} (${def.tcode})`,
        disabled: have.has(def.suffix),
        hint: have.has(def.suffix) ? t('editor.newAxis.have') : '',
        onSelect: () => this._createAxis(def.suffix),
      })),
    });
  }

  /**
   * A new, EMPTY axis (Dave, 2026-11-24: "start a new axis completely empty,
   * users can copy all the points from stroke and paste them"). When the
   * video's script is combined it goes inside that file; otherwise it is the
   * companion file <main script>.<axis>.funscript beside it (OFS names it the
   * same way). Nothing is written until Save; a file already there under
   * that name IS that axis, so it opens instead of being started over.
   * @param {string} suffix any spelling of the axis
   */
  async _createAxis(suffix) {
    const main = this._mainScriptPath();
    const def = getAxisBySuffix(suffix);
    if (!main || !def || this._axesPresent().has(def.suffix)) return;
    let entry;
    if (this._isCombinedMaster()) {
      entry = {
        label: t('editor.embeddedAxisLabel', { axis: axisShortLabel(def.suffix) }),
        path: `${main}#embedded=${def.suffix}`,
        embeddedAxis: def.suffix, axisLabel: axisShortLabel(def.suffix), kind: 'embedded', isNew: true,
      };
    } else {
      const path = buildCompanionPath(main, def.suffix);
      let exists = false;
      try { exists = !!(await window.funsync?.fileExists?.(path)); } catch { exists = false; }
      entry = { label: axisShortLabel(def.suffix), path, axis: def.suffix, kind: 'companion', ...(exists ? {} : { isNew: true }) };
    }
    const list = (this._availableScripts || []).length
      ? [...this._availableScripts]
      : [{ label: t('editor.mainAxisLabel'), path: main, kind: 'main' }];
    if (!list.some((s) => s.path === entry.path)) list.push(entry);
    this._availableScripts = list;
    this._updateScriptSelect();
    this._broadcastScriptsChanged();
    await this.selectScript(entry.path);
    if (this._stackedView) await this._rebuildInactiveLanes();
  }

  /**
   * Save As (belgriffinite, EroScripts #439, 2026-11-24: save a modified
   * script as a new file instead of over the original, to test tweaks; Dave:
   * "we should definitly add that in"). The script on screen is written,
   * unsaved edits included, to a file the user picks (the dialog opens in its
   * folder on "<name> (edit).funscript"), and from then on IS that file: Save
   * writes there, the original stays exactly as it is on disk, and playback
   * follows (the main script goes to the engine; another axis plays from the
   * new file on its channel). When the video's script is combined, the whole
   * file (every axis in it) is saved as. Ctrl+Shift+S, or Export ▸ Save as….
   */
  async _saveAs() {
    const from = this._funscriptPath;
    if (!from) return this._save();                   // no file yet: Save asks where already
    const combined = this._inCombinedFile(from);
    const mainPath = this._mainScriptPath();
    const filePath = combined ? mainPath : from;      // the file the script on screen lives in
    if (!filePath || filePath.includes('#embedded=')) return;
    let json;
    let revisions = new Map();
    let mainActions = null;
    if (combined) {
      const collected = await this._collectAxes({ embeddedOnly: true });
      if (!collected.mainJson) return;
      json = JSON.stringify(buildCombinedFunscript(collected.mainJson, collected.axes), null, 2);
      revisions = collected.revisions;
      mainActions = collected.mainState?.actions || null;
    } else {
      revisions.set(from, this.editableScript.revision);
      json = this.editableScript.toFunscriptJSON();
    }
    const cut = filePath.search(/[\\/][^\\/]*$/);
    const folder = cut >= 0 ? filePath.slice(0, cut + 1) : '';
    const baseName = filePath.slice(cut + 1).replace(/\.funscript$/i, '');
    let to = null;
    try {
      to = await window.funsync.saveFunscript(json, `${folder}${baseName} (edit).funscript`);
    } catch (err) {
      showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
      return;
    }
    if (!to) return;                                   // cancelled: nothing changed
    const same = to.toLowerCase().replace(/\//g, '\\') === filePath.toLowerCase().replace(/\//g, '\\');
    if (!same) this._repointPath(filePath, to, { combined });
    // Every state written is clean, under its (new) path (R4-18).
    for (const [path, rev] of revisions) {
      if (!Number.isFinite(rev)) continue;
      const now = same ? path : (path === filePath ? to : (path.startsWith(`${filePath}#embedded=`) ? to + path.slice(filePath.length) : path));
      if (now === this._funscriptPath) this.editableScript.markSaved(rev);
      else {
        const kept = this._undoCache?.get(now);
        if (kept && kept.state.revision === rev) { kept.state.savedRevision = rev; kept.dirty = false; }
      }
    }
    for (const s of this._availableScripts || []) if (s.path === to || s.path.startsWith(`${to}#embedded=`)) s.isNew = false;
    this._updateStatus();
    this._reportDirty();
    showToast(t('editor.toast.savedAs', { name: to.split(/[\\/]/).pop() }), 'success');
    // Playback follows the new file.
    if (combined) {
      if (mainActions) this._reloadIntoEngineAndSync(mainActions);
      try { this.onMainSavedAs?.({ from: filePath, to }); } catch { /* the app's refresh only */ }
      try { this.onCombinedSaved?.({ path: to }); } catch { /* the app's refresh only */ }
    } else if (filePath === mainPath || !mainPath) {
      this._reloadIntoEngineAndSync();
      try { this.onMainSavedAs?.({ from: filePath, to }); } catch { /* the app's refresh only */ }
    } else {
      const suffix = getAxisBySuffix(this._entryFor(to)?.axis || '')?.suffix || null;
      try { this.onAxisSaved?.({ path: to, suffix, created: true }); } catch { /* the app's refresh only */ }
    }
    this._announceSaved(to);
  }

  /** The script FILE whose earlier versions are kept: an axis inside a
   *  combined file is in its main file; never a stream (work list 3.1). */
  _backupFilePath() {
    const p = this._funscriptPath;
    if (typeof p !== 'string' || !p || p.startsWith('stream:')) return null;
    const i = p.indexOf('#embedded=');
    return i >= 0 ? p.slice(0, i) : p;
  }

  /** Export ▸ Restore an earlier version… (work list 3.1). */
  async _openBackups() {
    const file = this._backupFilePath();
    if (!file) { showToast(t('editor.backups.noScript'), 'info'); return; }
    const forKey = this._funscriptPath;
    await openScriptBackupsDialog({
      path: file,
      // Not after a switch to another script while the dialog was open.
      onRestore: (content) => { if (this._funscriptPath === forKey) this._restoreBackupContent(content); },
    });
  }

  /**
   * An earlier version into the script on screen as ONE undoable edit; nothing
   * is written until Save (or autosave), and that write is backed up in turn.
   * For an axis inside a combined file, that axis out of the restored file.
   */
  _restoreBackupContent(content, notify = showToast) {
    let data;
    try { data = JSON.parse(content); } catch { notify(t('editor.backups.readFailed'), 'error'); return false; }
    let actions = Array.isArray(data?.actions) ? data.actions : null;
    const at = (this._funscriptPath || '').indexOf('#embedded=');
    if (at >= 0) {
      const want = getAxisBySuffix(this._funscriptPath.slice(at + '#embedded='.length))?.suffix;
      actions = null;
      for (const [suffix, acts] of extractEmbeddedAxes(data)) {
        if (getAxisBySuffix(suffix)?.suffix === want) actions = acts;
      }
    }
    if (!Array.isArray(actions)) { notify(t('editor.backups.readFailed'), 'error'); return false; }
    const es = this.editableScript;
    if (typeof es.replaceAll === 'function') {
      es.replaceAll(actions, 'editor.history.restore');
    } else {
      es.clearSelection();
      es.applyModifier(() => actions.map((a) => ({ at: a.at, pos: a.pos })));
    }
    notify(t('editor.backups.restoredToast'), 'info');
    return true;
  }

  /**
   * After Save As: the script (or, for a combined file, the file and every
   * axis inside it) lives at `to`. The list, the kept states and the path on
   * screen follow; the original file is never touched.
   */
  _repointPath(from, to, { combined = false } = {}) {
    const move = (p) => {
      if (p === from) return to;
      if (combined && typeof p === 'string' && p.startsWith(`${from}#embedded=`)) return to + p.slice(from.length);
      return p;
    };
    for (const s of this._availableScripts || []) s.path = move(s.path);
    for (const [p, v] of [...(this._undoCache || [])]) {
      const now = move(p);
      if (now !== p) { this._undoCache.delete(p); this._undoCache.set(now, v); }
    }
    this._funscriptPath = move(this._funscriptPath);
    this._updateScriptSelect();
    this._broadcastScriptsChanged();
  }

  /** Save as, and export every axis as one combined file or as separate files. */
  _openExportMenu() {
    const r = this._btnExportAxes.getBoundingClientRect();
    openContextMenu({
      x: r.left, y: r.bottom,
      ariaLabel: t('editor.export.menu'),
      returnFocus: this._btnExportAxes,
      items: [
        { heading: t('editor.export.thisScript') },
        { label: t('editor.export.saveAs'), hint: t('editor.export.saveAsHint'), onSelect: () => this._saveAs() },
        // Earlier versions kept before an overwrite (work list 3.1).
        { heading: t('editor.export.everyAxis') },
        { label: t('editor.export.combined'), hint: t('editor.export.combinedHint'), onSelect: () => this._exportAxes('combined') },
        { label: t('editor.export.separate'), hint: t('editor.export.separateHint'), onSelect: () => this._exportAxes('separate') },
      ],
    });
  }

  /**
   * Export the axes as they are now, unsaved edits included (nothing in the
   * editor is marked saved by an export). `combined`: one file in the new
   * format, where the user picks (Save As), refused without a stroke (a
   * single-axis player reads only the stroke, and the format needs one).
   * `separate`: the main script and <base>.<axis>.funscript for each axis in
   * a folder the user picks, asking before any file there is replaced.
   * @param {'combined'|'separate'} kind
   */
  async _exportAxes(kind) {
    const { mainPath, mainJson, axes } = await this._collectAxes();
    if (!mainJson) return;
    const base = (mainPath || 'script').split(/[\\/]/).pop().replace(/\.funscript$/i, '');
    if (kind === 'combined') {
      if (!Array.isArray(mainJson.actions) || mainJson.actions.length === 0) {
        showToast(t('editor.export.needStroke'), 'warn', 5000);
        return;
      }
      const out = buildCombinedFunscript(mainJson, axes);
      try {
        const saved = await window.funsync.saveFunscript(JSON.stringify(out, null, 2), `${base}.funscript`);
        if (saved) showToast(t('editor.export.done', { count: 1 }), 'success');
      } catch (err) {
        showToast(t('editor.toast.saveFailed', { error: err.message }), 'error');
      }
      return;
    }
    const dir = await window.funsync.selectDirectory?.();
    if (!dir) return;
    const sep = dir.includes('\\') ? '\\' : '/';
    const targets = buildSeparateFunscripts(mainJson, axes, base).map((f) => ({
      name: f.name,
      path: `${dir.replace(/[\\/]+$/, '')}${sep}${f.name}`,
      json: JSON.stringify(f.content, null, 2),
    }));
    let there = [];
    try { there = (await window.funsync.filesExist?.(targets.map((x) => x.path))) || []; } catch { there = []; }
    const replacing = targets.filter((_, i) => there[i]).map((x) => x.name);
    if (replacing.length) {
      // Asked from the pop-out (or with this window behind): the question
      // opens here, so this window comes forward first (as R3-21's does).
      if (typeof document !== 'undefined' && document.hasFocus?.() === false) {
        try { window.funsync?.bringMainWindowForward?.(); } catch { /* the question still opens */ }
      }
      const ok = await Modal.confirm(
        t('editor.export.replaceTitle', { count: replacing.length }),
        t('editor.export.replaceBody', { count: replacing.length, names: replacing.join(', ') }),
        { confirmText: t('editor.export.replaceConfirm') },
      );
      if (!ok) return;
    }
    let written = 0;
    for (const x of targets) {
      try { if (await window.funsync.writeFunscript(x.json, x.path)) written++; } catch { /* counted below */ }
    }
    showToast(t('editor.export.done', { count: written }), written === targets.length ? 'success' : 'error');
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

    const dur = this._frameDurationMs();
    const phase = this._framePhaseMs();
    return phase + Math.round((timeMs - phase) / dur) * dur;
  }

  /**
   * Where a point goes when it is placed at the playhead (a position key,
   * paste, alternating insert, repeat stroke, move to playhead): the start of
   * the frame ON SCREEN. While paused that is the presented frame's own
   * timestamp (VideoPlayer.shownFrameTimeMs); otherwise the frame grid's
   * frame at or before the playhead, not the nearest one: a seek to the
   * second half of a frame still shows that frame (OFS places at the frame
   * shown too). Snap to frame off = the raw playhead time.
   * @returns {number} ms
   */
  _playheadMs() {
    const raw = (this.videoPlayer?.currentTime || 0) * 1000;
    if (!this._snapToFrame) return raw;
    if (!this.videoPlayer?.video || !isFinite(this.videoPlayer.video.duration)) return raw;
    const shown = this.videoPlayer.shownFrameTimeMs?.();
    if (Number.isFinite(shown)) return shown;
    const dur = this._frameDurationMs();
    const phase = this._framePhaseMs();
    return Math.max(0, phase + Math.floor((raw - phase) / dur + 1e-6) * dur);
  }

  /**
   * The time shift for moving the selection by `frames` frames (Shift /
   * Ctrl+Shift+Left/Right): with snap to frame on, the first selected point
   * lands exactly on the frame start that many frames away. A bare
   * frames x duration moved each point by a whole-ms-rounded 33.37 ms and
   * drifted off the frames, about 1 ms every 3 presses at 29.97 fps.
   * @param {number} frames  positive = later
   * @returns {number} ms
   */
  _frameMoveDeltaMs(frames) {
    const dur = this._frameDurationMs();
    const raw = frames * dur;
    if (!this._snapToFrame) return raw;
    const es = this.editableScript;
    const times = [...es.selectedIndices].map((i) => es.actions[i]?.at).filter(Number.isFinite);
    if (!times.length) return raw;
    const first = Math.min(...times);
    return this.snapTime(this.snapTime(first) + raw) - first;
  }

  /**
   * Frame duration in ms for the snap grid, the frame steps and the arrow-key
   * time moves: the video's own frame rate (ffprobe, via VideoPlayer.setFps;
   * OFS uses the decoder's rate the same way). 1/30 s only while the rate is
   * unknown. It was 1/30 s for every video: 0.03 ms short a frame at 29.97 fps
   * (a step that showed no new frame every ~33 s), every other frame skipped
   * at 60 fps, mid-frame at 24 / 25 fps (2026-11-24).
   */
  _frameDurationMs() {
    const ms = this.videoPlayer?.frameDurationMs?.();
    return Number.isFinite(ms) && ms > 0 ? ms : 1000 / 30;
  }

  /**
   * Where the video's frame grid starts, in ms: frames sit at phase + n x
   * duration. Learned from the frames the player presents; 0 until then.
   */
  _framePhaseMs() {
    const s = this.videoPlayer?.framePhaseSec?.();
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
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
    // The Handy plays the stroke: a point placed on another axis (twist,
    // roll ...) is not a stroke position, and moved it there (multi-axis
    // editing, 2026-11-24).
    if (this._isMainActive?.() === false) return;
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
        // The docked panel left the player: what sat under it shows again
        // (the script strip draws, the simulator's floor drops; 2026-11-25).
        try { this.onOpenChange?.(this._open); } catch { /* the app's, not ours */ }
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
        try { this.onOpenChange?.(this._open); } catch { /* the app's, not ours */ }
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
      // The pop-out's Shift+Space: Stop all (DESIGN.md §2.15).
      case 'stop-all':
        this.onStopAll?.();
        break;
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
      // Multi-axis editing (2026-11-24): the pop-out's New axis, Export and
      // stacked lanes. The work is done here (the session is this editor's).
      case 'save-as':
        this._saveAs();
        break;
      case 'reference-toggle':
        this._toggleReference();
        break;
      // The pop-out's Restore an earlier version… (its dialog ran there, on its monitor).
      case 'restore-backup':
        if (typeof payload.content === 'string' && payload.path === this._backupFilePath()) {
          this._restoreBackupContent(payload.content, this._popoutNotifier());
        }
        break;
      case 'axis-create':
        if (typeof payload.suffix === 'string') this._createAxis(payload.suffix);
        break;
      case 'axes-export':
        if (payload.kind === 'combined' || payload.kind === 'separate') this._exportAxes(payload.kind);
        break;
      case 'lanes-wanted':
        this._popoutLanesOn = payload.on === true;
        if (this._popoutLanesOn) this._broadcastLanes();
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
      case 'request-from-stroke':
        this._openAxisFromStrokeModal?.(this._popoutNotifier?.());
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
        if (payload.key === 'gamepadRecording') {
          if (payload.value) this._startGamepadRecording(); else this._stopGamepadRecording();
          break;
        }
        if (payload.key === 'gamepadMapping') {
          if (payload.value && typeof payload.value === 'object') this.settings?.set?.('editor.gamepad', { ...DEFAULT_GAMEPAD_MAPPING, ...payload.value });
          this._broadcastSettings();
          break;
        }
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
          this._setToggleState(this._btnRecord, this._recordingMode);
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
      rippleDelete: () => this._rippleDelete(notify),
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
    // A new pop-out starts with its stacked lanes off.
    this._popoutLanesOn = false;
    const v = this.videoPlayer;
    const clock = this._popoutClock();
    const payload = {
      type: 'initial-state',
      scripts: this._availableScripts || [],
      activePath: this._funscriptPath || null,
      axisTools: !(this._availableScripts || []).some((s) => s.route) && !!this._mainScriptPath(),
      // What Save writes, for the pop-out's Save tooltip from the start.
      saveKey: this._saveTitleKey(),
      axesPresent: [...this._axesPresent()],
      reference: this._referenceActions(),
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
      season: document.documentElement.dataset.season || null,
      // The frame grid for the pop-out's snap to frame: the docked editor's
      // `_frameDurationMs()` (the video's own rate) and `_framePhaseMs()`.
      frameDurationMs: this._frameDurationMs?.() || (1000 / 30),
      framePhaseMs: this._framePhaseMs?.() || 0,
      // The graph's lilac / dashed marks (Settings > Editor speed limits).
      speedLimits: this._speedLimits?.() || null,
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
      season: document.documentElement.dataset.season || null,
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
      // A new video's frame rate / grid (VideoPlayer.onFrameGridChanged).
      frameDurationMs: this._frameDurationMs(),
      framePhaseMs: this._framePhaseMs(),
      speedLimits: this._speedLimits(),
      gamepadRecording: !!this._gamepad?.recording,
      gamepadMapping: this._gamepadMapping(),
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
      // Its undo history menu's rows (work list 4.5).
      history: this.editableScript?.undoHistory?.() || { undo: [], redo: [] },
    });
  }

  /**
   * The stroke behind the axis on screen (work list 2.3): while an axis that
   * is not the main script is edited, the main script (as it is in memory,
   * unsaved edits included) is drawn faintly under it. T turns it off and on.
   * Not under Custom Routing (its scripts are not one device's axes).
   */
  _referenceActions() {
    if (this._showReference === false) return null;
    const main = this._mainScriptPath?.();
    if (!main || this._isMainActive?.() !== false) return null;
    if ((this._availableScripts || []).some((x) => x.route)) return null;
    return this._liveStateOf(main)?.actions
      || (this.funscriptEngine?.isLoaded ? this.funscriptEngine.getActions?.() : null)
      || null;
  }

  _updateReference() {
    if (!this.graph?.setReference) return;
    this.graph.setReference(this._referenceActions());
    this.graph.draw?.();
  }

  /** T: the stroke behind an axis off / on (both editors). */
  _toggleReference() {
    this._showReference = this._showReference === false;
    this._updateReference();
    this._broadcastScriptsChanged();
    showToast(t(this._showReference ? 'editor.toast.referenceOn' : 'editor.toast.referenceOff'), 'info');
  }

  /**
   * What Save writes, for this video (Dave, 2026-11-25: nothing said whether
   * it wrote the axes separately or combined): every axis back into the
   * combined file, every axis to its own file, or the one script.
   */
  _saveTitleKey() {
    if (this._isCombinedMaster()) return 'editor.btn.saveCombined';
    return (this._availableScripts || []).length > 1 ? 'editor.btn.saveEach' : 'editor.btn.save';
  }

  _updateSaveTitle() {
    const btn = this._btnSave;
    if (!btn) return;
    const key = this._saveTitleKey();
    if (btn.getAttribute('data-i18n-title') === key) return;
    btn.title = t(key);
    btn.setAttribute('aria-label', t(key));
    btn.setAttribute('data-i18n-title', key);
    btn.setAttribute('data-i18n-aria-label', key);
  }

  _broadcastScriptsChanged() {
    // Every switch and list change passes here: the stroke behind an axis follows.
    this._updateReference();
    this._updateSaveTitle();
    if (!this._popoutOpen) return;
    const routing = (this._availableScripts || []).some((s) => s.route);
    this._relayToPopout({
      type: 'scripts-changed',
      scripts: this._availableScripts || [],
      activePath: this._funscriptPath || null,
      // The pop-out's New axis / Export show as the docked ones do.
      axisTools: !routing && !!this._mainScriptPath(),
      axesPresent: [...this._axesPresent()],
      reference: this._referenceActions(),
      saveKey: this._saveTitleKey(),
    });
    if (this._popoutLanesOn) this._broadcastLanes();
  }

  /**
   * The pop-out's stacked lanes: every axis but the one on screen, with its
   * points as they are now (kept in memory, inside the combined file, a new
   * empty one, or the file).
   */
  async _broadcastLanes() {
    if (!this._popoutOpen || !this._popoutLanesOn) return;
    // Only the newest is sent: one started before a switch reads files and
    // could land after the one started after it (the lanes of the old axis).
    const seq = (this._lanesSeq = (this._lanesSeq || 0) + 1);
    const lanes = [];
    for (const s of this._availableScripts || []) {
      // Its place in the order (the pop-out keeps the tracks' order too).
      if (s.path === this._funscriptPath) { lanes.push({ path: s.path, label: s.label, active: true }); continue; }
      let actions = this._undoCache?.get(s.path)?.state?.actions || null;
      if (!actions && s.isNew) actions = [];
      if (!actions && s.embeddedAxis) actions = this.getEmbeddedAxisActions?.(s.embeddedAxis) || [];
      if (!actions) {
        try {
          const content = await window.funsync.readFunscript(s.path);
          actions = content ? (JSON.parse(content).actions || []) : [];
        } catch { actions = []; }
      }
      lanes.push({ path: s.path, label: s.label, actions: actions.map((a) => ({ at: a.at, pos: a.pos })) });
    }
    if (seq !== this._lanesSeq) return;
    if (this._popoutOpen && this._popoutLanesOn) this._relayToPopout({ type: 'lanes', lanes });
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
      showToast(t('editor.toast.stackedNeedsMulti'), 'info');
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
      // The video's tracks keep their order (fixed-order tracks, Dave
      // 2026-11-24): the one being edited is the timeline in its own place,
      // the ones before it above, the ones after it in this box below.
      if (!this._stackedAfter) {
        this._stackedAfter = document.createElement('div');
        this._stackedAfter.className = 'editor__stacked-lanes editor__stacked-lanes--after';
      }
      if (this._canvasContainer && !this._stackedAfter.parentElement) {
        this._canvasContainer.after(this._stackedAfter);
      }
      this._ensureTrackLabel();
      this.graph?.setGutter?.(TRACK_GUTTER_PX);
      this.graph?.draw?.();
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
      this._stackedAfter?.remove();
      this._inactiveLanes.clear();
      this.graph?.setGutter?.(40);
      this.graph?.draw?.();
      this._layoutLanes();
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
    if (this._stackedAfter) this._stackedAfter.innerHTML = '';
    this._inactiveLanes.clear();
    const order = this._availableScripts || [];
    const activeAt = order.findIndex((s) => s.path === this._funscriptPath);

    // Lanes hidden with a right-click stay out until shown again (OFS's
    // right-click > Scripts; work list 2.2), for this video.
    const hidden = this._hiddenLanes || (this._hiddenLanes = new Set());
    const others = this._availableScripts.filter(s => s.path !== this._funscriptPath);
    const inactive = others.filter(s => !hidden.has(s.path));
    for (const s of inactive) {
      const lane = await this._buildLane(s);
      if (lane) {
        const above = activeAt >= 0 && order.indexOf(s) < activeAt;
        (above || !this._stackedAfter ? this._stackedContainer : this._stackedAfter).appendChild(lane.container);
        this._inactiveLanes.set(s.path, lane);
        // ActionGraph needs the canvas's actual rendered pixel size to
        // set its drawing buffer. Has to happen after the canvas is in
        // the DOM (CSS sizing), so call after append.
        try { lane.graph.resize(); } catch { /* canvas not yet visible */ }
      }
    }
    const hiddenCount = others.length - inactive.length;
    if (hiddenCount > 0) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'editor__lanes-show-hidden';
      show.textContent = t('editor.lanes.showHidden', { count: hiddenCount });
      show.addEventListener('click', () => this._showAllLanes());
      (this._stackedAfter || this._stackedContainer).appendChild(show);
    }
    this._ensureTrackLabel();
    this.graph?.setGutter?.(TRACK_GUTTER_PX);
    this._layoutLanes();
    // Short of room the boxes scroll: they open on the tracks next to the
    // one being edited (the box above at its end, the box below at its top).
    this._stackedContainer.scrollTop = this._stackedContainer.scrollHeight;
    if (this._stackedAfter) this._stackedAfter.scrollTop = 0;
    this._syncInactiveLanes();
  }

  /**
   * The name of the track being edited, in the timeline's left gutter, as
   * every lane shows its own (stacked tracks only; fixed-order tracks).
   */
  _ensureTrackLabel() {
    if (!this._canvasContainer || typeof document === 'undefined') return;
    if (!this._trackLabel) {
      this._trackLabel = document.createElement('span');
      this._trackLabel.className = 'editor__track-label';
      this._canvasContainer.appendChild(this._trackLabel);
    }
    const label = this._entryFor(this._funscriptPath)?.label || '';
    if (this._trackLabel.textContent !== label) this._trackLabel.textContent = label;
  }

  /** Hide one lane of the stacked view (right-click > Hide this lane). */
  _hideLane(path) {
    (this._hiddenLanes || (this._hiddenLanes = new Set())).add(path);
    return this._rebuildInactiveLanes();
  }

  /** Every hidden lane back (the "Show N hidden lanes" bar, or the menu). */
  _showAllLanes() {
    this._hiddenLanes?.clear();
    return this._rebuildInactiveLanes();
  }

  /** A lane's right-click menu: hide it, or show every hidden one again. */
  _openLaneMenu(e, script) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({
      x: e.clientX, y: e.clientY,
      ariaLabel: t('editor.lanes.menu'),
      items: [
        { label: t('editor.lanes.hide', { name: script.label }), onSelect: () => this._hideLane(script.path) },
        { label: t('editor.lanes.showAll'), disabled: !(this._hiddenLanes?.size > 0), onSelect: () => this._showAllLanes() },
      ],
    });
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
    // Translated (it was English in every language).
    container.title = t('editor.lanes.clickToEdit', { name: script.label });

    const label = document.createElement('span');
    label.className = 'editor__lane-label';
    label.textContent = script.label;
    container.appendChild(label);

    const canvas = document.createElement('canvas');
    canvas.className = 'editor__lane-canvas';
    container.appendChild(canvas);

    const editable = new EditableScript();
    // The axis as it is in memory (its unsaved edits) before any file.
    const cached = this._undoCache.get(script.path);
    if (cached) {
      editable.importState(cached.state);
    } else if (script.isNew) {
      // A new axis, not on disk yet: an empty lane (multi-axis editing).
    } else if (script.embeddedAxis) {
      // Inside the combined main file: its parsed copy (V42).
      const actions = this.getEmbeddedAxisActions?.(script.embeddedAxis);
      if (!Array.isArray(actions)) return null;
      editable._actions = actions.map((a) => ({ at: a.at, pos: a.pos }));
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
    graph.setCompact(true);
    graph._splineMode = this._splineMode;

    container.addEventListener('contextmenu', (e) => this._openLaneMenu(e, script));
    container.addEventListener('click', () => {
      // Route the click through the dropdown so the dropdown stays in
      // sync with the editor state — single source of truth for active
      // script. _onScriptSelectChange handles caching, autosave, and
      // calls back into _rebuildInactiveLanes for us.
      if (this._scriptSelect) {
        this._scriptSelect.value = script.path;
        this._onScriptSelectChange();
      }
      // The keys go to the timeline now: a track click left focus on the
      // track's row (not focusable), so Up / Down and the other editor keys
      // went to the player until the timeline was clicked (Dave, 2026-11-25).
      try { this._canvas?.focus({ preventScroll: true }); } catch { /* not shown */ }
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
    // During playback (Dave, 2026-11-25: "speed up the player when in editor
    // especially when its multi axis"): the tracks are drawn at most ~60 times
    // a second (a 144 Hz display drew every one of them every frame; a skipped
    // frame is drawn on the next one), and where the main graph's plot sits on
    // screen is read again only after a layout change or twice a second
    // (alignTo read two boxes per track per frame). Paused, every edit, zoom
    // and hover shows on the tracks at once, as before.
    const playing = this.videoPlayer?.video?.paused === false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (playing && now - (this._lanesDrawnAt ?? -Infinity) < LANE_FRAME_MS) {
      if (!this._lanesRaf && typeof requestAnimationFrame === 'function') {
        this._lanesRaf = requestAnimationFrame(() => { this._lanesRaf = null; this._syncInactiveLanes(); });
      }
      return;
    }
    this._lanesDrawnAt = now;
    const align = !playing || this._lanesAlignDirty !== false || now - (this._lanesAlignedAt ?? -Infinity) > LANE_ALIGN_MS;
    if (align) { this._lanesAlignDirty = false; this._lanesAlignedAt = now; }
    for (const lane of this._inactiveLanes.values()) {
      lane.graph.setVideoDuration(this.graph._videoDurationMs);
      if (align || !lane.aligned) { lane.graph.alignTo(this.graph); lane.aligned = true; }
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
      showToast(t('editor.toast.moveOneToPlayhead'), 'info');
      return;
    }
    const timeMs = this._playheadMs();
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
    // The pop-out's time is its mirror of this playhead: on the same frame,
    // the frame on screen here is the exact one.
    const fromPopout = Number.isFinite(atMs)
      && Math.abs(atMs - (this.videoPlayer?.currentTime || 0) * 1000) >= this._frameDurationMs();
    const timeMs = fromPopout ? this.snapTime(atMs) : this._playheadMs();
    if (this._recordingMode) {
      this.editableScript.insertAction(timeMs, pos);
      this._sendLivePreview(pos);
      return;
    }
    // OFS's rule (Funscript::AddEditAction): a point already within a frame
    // of this one (up to a frame before, half a frame after) is EDITED, time
    // and position, not joined by a second point a few ms away. FunSync only
    // edited an exact-ms match (or the selected point within 1 ms), so a key
    // pressed on a frame whose point sat 1 ms off, or after an Alt+click
    // that snapped to the nearest frame, stacked a near-duplicate.
    const modifyIdx = this._pointWithinFrame(timeMs);
    const cur = modifyIdx >= 0 ? this.editableScript.actions[modifyIdx] : null;
    if (cur && cur.at === Math.round(timeMs) && cur.pos === Math.round(pos)) {
      // The same key again on that frame: nothing changes, no undo step.
      this.editableScript.select(modifyIdx);
      this._lastSelectedIndex = modifyIdx;
    } else if (modifyIdx >= 0) {
      const newIdx = this.editableScript.updateAction(modifyIdx, cur.at === Math.round(timeMs) ? { pos } : { at: timeMs, pos });
      this.editableScript.select(newIdx);
      this._lastSelectedIndex = newIdx;
    } else {
      const newIdx = this.editableScript.insertAction(timeMs, pos);
      this.editableScript.select(newIdx);
      this._lastSelectedIndex = newIdx;
    }
    this._sendLivePreview(pos);
  }

  /**
   * The point a placement at `timeMs` edits instead of adding a second one:
   * the closest within just under a frame either side. OFS's window
   * (getActionAtTime: a frame before, HALF a frame after) assumes every point
   * sits on a frame start; an imported script's points sit anywhere in a
   * frame, and a key on the frame 1733-1767 ms added 1733 beside 1750 (test
   * day B020). Whole-ms times shave 1 ms off each side, so the previous and
   * the next frame's points are never taken. -1 = none.
   * @param {number} timeMs
   * @returns {number}
   */
  _pointWithinFrame(timeMs) {
    const dur = this._frameDurationMs();
    const actions = this.editableScript.actions;
    let best = -1;
    let bestErr = Infinity;
    for (let i = 0; i < actions.length; i++) {
      const d = actions[i].at - timeMs;
      if (d >= dur - 1) break;
      if (d <= -(dur - 1)) continue;
      const err = Math.abs(d);
      if (err <= bestErr) { bestErr = err; best = i; }
    }
    return best;
  }

  _alternatingInsertAtCursor() {
    const timeMs = this._playheadMs();
    const newIdx = this.editableScript.insertAlternating(timeMs);
    this.editableScript.select(newIdx);
    this._lastSelectedIndex = newIdx;
    const pos = this.editableScript.actions[newIdx]?.pos;
    if (typeof pos === 'number') this._sendLivePreview?.(pos);
  }

  _repeatLastStrokeAtCursor() {
    const timeMs = this._playheadMs();
    const result = this.editableScript.repeatLastStroke(timeMs);
    if (!result) {
      showToast(t('editor.toast.repeatNeedsTwo'), 'info');
      return;
    }
    showToast(t('editor.toast.strokeRepeated'), 'info', 1200);
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
    showToast(t('editor.toast.playbackRate', { rate }), 'info', 1000);
  }

  /** Jump to next/previous bookmark relative to the playhead. */
  _jumpToBookmark(direction) {
    const bookmarks = this.editableScript.getBookmarks();
    if (!bookmarks || bookmarks.length === 0) {
      showToast(t('editor.toast.noBookmarks'), 'info');
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
      showToast(t('editor.toast.noVideo'), 'warn');
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
      showToast(t('editor.toast.multiBandLoaded'), 'info');
    } else if (!data) {
      showToast(t('editor.toast.multiBandFailed'), 'warn');
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
      showToast(t('editor.toast.noVideo'), 'warn');
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
      showToast(t('editor.toast.voiceDetected', { count: data.segments.length, seconds: seconds.toFixed(1) }), 'info', 2500);
    } else if (!data) {
      showToast(t('editor.toast.voiceFailed'), 'warn');
      this._vadEnabled = false;
    }
    this._statusEl.textContent = origStatus;
    this._updateStatus?.();
  }

  // === Heatmap export (§2.2) ==========================================

  async _exportHeatmapPng() {
    const actions = this.editableScript?.actions || [];
    if (actions.length === 0) {
      showToast(t('editor.toast.exportEmpty'), 'warn');
      return;
    }
    const duration = (this.videoPlayer?.duration || 0) * 1000;
    if (!duration) {
      showToast(t('editor.toast.exportNoDuration'), 'warn');
      return;
    }
    let computeBins, renderBins;
    try {
      ({ computeBins, renderBins } = await import('../js/heatmap-strip.js'));
    } catch {
      showToast(t('editor.toast.heatmapUnavailable'), 'warn');
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
      if (!blob) { showToast(t('editor.toast.heatmapFailed'), 'warn'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${stem}-heatmap.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(t('editor.toast.heatmapExported'), 'info', 1500);
    }, 'image/png');
  }
}

/** Escape HTML special characters for safe insertion into innerHTML. */
function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
