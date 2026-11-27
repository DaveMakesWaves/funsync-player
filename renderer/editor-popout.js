// Editor pop-out — renderer entry point.
//
// Hosts a docked-editor-equivalent surface for the parent window's
// active script. The parent broadcasts INITIAL_STATE on connect, then
// TIME_TICK at video rate + ACTIONS_CHANGED on edits + VIDEO_META on
// src/duration changes. Pop-out side mounts an ActionGraph + own
// EditableScript + video stub, and dispatches gestures back to the
// parent as EDIT_OPs (parent applies, ACTIONS_CHANGED echoes back).
//
// Design contract: this window is the docked editor opened in a
// separate `BrowserWindow`. Toolbar visuals, hotkeys, ARIA contract,
// and design tokens MUST match the docked editor (DESIGN.md §2.1 +
// §2.3 + §2.8). Buttons use `editor__btn` + Lucide icons via the
// existing `icon()` helper. Separators use `editor__toolbar-separator
// [--cluster]`. Theme is the user's chosen theme (data-theme on
// <html>), not a hard-coded dark.
//
// Language (FT-103, also in v0.9.2): every word here comes from the locale
// bundles, the docked editor's keys wherever the words are the same. The
// window had no i18n at all: English literals, and the ? list and a toast's
// X showed raw keys. It starts in English (initI18n), says READY only then,
// takes the user's language from INITIAL_STATE and follows a switch in the
// main window (LOCALE), as player-popout.js does.

import { t, initI18n, setLocale, translatePage } from './js/i18n.js';
import { eventBus } from './js/event-bus.js';
import { applySeason } from './js/holiday.js';
import { EditableScript } from './js/editable-script.js';
import { ActionGraph } from './js/action-graph.js';
import { startDragMove, dragMoveStep } from './js/editor-drag-move.js';
import { PopoutVideoPlayerStub } from './js/editor-popout-video-stub.js';
import {
  icon, Undo2, Redo2, Save, ZoomIn, ZoomOut, Magnet, Trash2,
  FlipVertical2, Spline, Scissors, AudioWaveform, Music,
  WandSparkles, BookmarkPlus, FileText, Rows3, Plus, FileOutput, Layers2, CircleDot, Gamepad2, History, FileCheck, Activity,
} from './js/icons.js';
import { openGamepadRecordMenu, gamepadTargetAxes } from './components/gamepad-record-menu.js';
import { cleanPadName, DEFAULT_GAMEPAD_MAPPING } from './js/gamepad-recorder.js';
import { AXIS_DEFINITIONS } from './js/multi-axis.js';
import { openKeyboardHelp, getEditorShortcutGroups } from './js/keyboard-help.js';
import { watchWcoClass } from './js/wco.js';
import { showToast } from './js/toast.js';
import { Modal } from './components/modal.js';
import { layoutKey, digitKey } from './js/keyboard-layout.js';
import { buildResolverMap, resolvePositionKey } from './js/position-key-resolver.js';
import {
  PatternFillDrawer, fillDrawerKeyVerdict, rangeFromBand, fillRangeKey, windowSignature,
} from './components/pattern-fill-drawer.js';
import { openContextMenu, closeContextMenu, activeContextMenu } from './js/editor-context-menu.js';
import { selectionStatsText } from './js/selection-stats.js';
import { openScriptBackupsDialog } from './components/script-backups-dialog.js';
import { openScriptCheck } from './components/script-check-panel.js';
import { openUndoHistoryMenu } from './components/undo-history-menu.js';
import { openVibratePanel } from './components/vibrate-panel.js';
import {
  TIME_TICK, VIDEO_META, INITIAL_STATE, ACTIONS_CHANGED, SCRIPTS_CHANGED, THEME, SETTINGS, TOAST, LOCALE,
  READY, msg, editOp,
  OP_INSERT, OP_DELETE, OP_UPDATE, OP_SELECT, OP_SELECT_ALL, OP_CLEAR_SELECTION, OP_INVERT,
  OP_UNDO, OP_REDO, OP_CUT, OP_COPY, OP_PASTE, OP_PASTE_ORIGINAL,
  OP_EQUALIZE, OP_SELECT_LEFT_OF, OP_SELECT_RIGHT_OF,
  OP_INSERT_ALTERNATING, OP_REPEAT_LAST_STROKE, OP_MOVE_SELECTED_TO,
  OP_BEGIN_BATCH, OP_END_BATCH,
  OP_SELECT_BY_POSITION, OP_APPLY_MODIFIER, OP_MOVE_ACTIONS,
  OP_ADD_BOOKMARK, OP_SELECT_CREATED, OP_SELECT_EVERY_NTH, OP_PLACE_AT, OP_FILL_RANGE, FILL_RESULT, OP_RIPPLE_DELETE, OP_UNDO_STEPS, OP_REDO_STEPS,
  SAVE, VIDEO_SET_RATE, SET_SETTING, VIDEO_PLAY, VIDEO_PAUSE, STOP_ALL,
  REQUEST_METADATA, REQUEST_FILL_GAPS, REQUEST_BEATS, REQUEST_SIMPLIFY,
  REQUEST_REMAP_RANGE, REQUEST_OFFSET_TIME, REQUEST_REMOVE_PAUSES,
  REQUEST_RANGE_EXTEND, REQUEST_GENERATE_PATTERN, REQUEST_EXPORT_HEATMAP,
  REQUEST_TOGGLE_WAVEFORM,
} from './js/editor-popout-protocol.js';

// Frameless window → the page owns the drag region (.popout-titlebar).
// Kept in step with the overlay for the whole session, not just at boot (FT-055).
watchWcoClass({ where: 'editor pop-out' });

const HOST_ID = 'editor-popout-host';
const host = document.getElementById(HOST_ID);
if (!host) throw new Error('[editor-popout] missing host element #' + HOST_ID);

// Theme starts as dark to avoid an unstyled flash; INITIAL_STATE
// carries the real effective theme and overrides this. A subsequent
// THEME message from the parent (fired on settings:changed) keeps the
// pop-out in lockstep when the user switches modes mid-session.
applyTheme(document.documentElement.dataset.theme || 'dark');
function applyTheme(t) {
  if (t === 'dark' || t === 'light') {
    document.documentElement.dataset.theme = t;
  }
  // Retint this window's native chrome too, or the caption strip keeps the
  // colours it was CREATED with while the main window follows the theme.
  if (t === 'dark' || t === 'light' || t === 'system') {
    try { window.funsync?.updateWindowChrome?.(t); } catch { /* non-fatal */ }
  }
}
function applyStyle(s) {
  // No-op on undefined so a theme-only message can't reset the style.
  if (s === 'classic' || s === 'modern') document.documentElement.dataset.style = s;
}

// The Holiday style's palette (v0.10.1): the main window sends its season with
// the style. No snow in a pop-out. No-op on undefined, like applyStyle.
function applyPopoutSeason(season) {
  if (season === undefined) return;
  applySeason(season === 'holiday' ? 'holiday' : null, document, { snow: false });
}

host.classList.add('script-editor', 'script-editor--popout-window');

// ===== Toolbar ============================================================

const send = (payload) => window.funsync.editorPopoutRelay('to-parent', payload);

// Every word below is a key, stamped as data-i18n / data-i18n-title /
// data-i18n-aria-label like the docked editor's toolbar (script-editor.js
// _makeBtn): the walk after initI18n writes them, and setLocale() walks them
// again on a switch. Nothing is written before a bundle has loaded, when t()
// would hand back the raw key.
function stamp(el, { text, title, aria } = {}) {
  if (text) el.setAttribute('data-i18n', text);
  if (title) el.setAttribute('data-i18n-title', title);
  if (aria) el.setAttribute('data-i18n-aria-label', aria);
  return el;
}

const toolbar = document.createElement('div');
toolbar.className = 'editor__toolbar';
toolbar.setAttribute('role', 'toolbar');
stamp(toolbar, { aria: 'editor.toolbarAria' });

function makeBtn(iconNode, key, onClick) {
  const btn = document.createElement('button');
  btn.className = 'editor__btn';
  stamp(btn, { title: key, aria: key });
  btn.appendChild(icon(iconNode, { width: 16, height: 16, 'stroke-width': 2 }));
  btn.addEventListener('click', onClick);
  return btn;
}
function makeSep(cluster) {
  const sep = document.createElement('div');
  sep.className = 'editor__toolbar-separator' + (cluster ? ' editor__toolbar-separator--cluster' : '');
  return sep;
}
function makeLabel(text, cls) {
  const span = document.createElement('span');
  span.className = cls || 'editor__status';
  span.textContent = text;
  return span;
}

// Script selector — only visible when 2+ scripts loaded.
const scriptSelect = document.createElement('select');
scriptSelect.className = 'editor__script-select';
stamp(scriptSelect, { title: 'editor.scriptSelectTitle' });
scriptSelect.hidden = true;
scriptSelect.addEventListener('change', () => {
  // Another script: a Fill with pattern preview of this one goes at once
  // (the parent's answer comes only after its disk read, review-2).
  fillDrawer?.close('cancel');
  send(msg('script-switch', { path: scriptSelect.value }));
});

const btnUndo   = makeBtn(Undo2,       'editor.btn.undo',         () => send(editOp(OP_UNDO)));
const btnRedo   = makeBtn(Redo2,       'editor.btn.redo',         () => send(editOp(OP_REDO)));
// The undo history (work list 4.5): the parent's, sent with every ACTIONS_CHANGED.
let lastHistory = { undo: [], redo: [] };
function openPopoutHistory(e, anchor) {
  e?.preventDefault?.();
  const r = anchor.getBoundingClientRect();
  const fromPointer = e?.type === 'contextmenu' && Number.isFinite(e.clientX);
  openUndoHistoryMenu({
    x: fromPointer ? e.clientX : r.left, y: fromPointer ? e.clientY : r.bottom,
    history: lastHistory,
    // Earlier versions (work list 3.1), under the undo steps (they sat in the
    // Export menu): the dialog opens here, on this monitor; the parent lands
    // the version (one undo step) if it still edits that file.
    extra: [{
      label: t('editor.backups.menuItem'), hint: t('editor.backups.menuHint'), disabled: !backupFile(),
      onSelect: () => { const path = backupFile(); openScriptBackupsDialog({ path, onRestore: (content) => send(msg('restore-backup', { path, content })) }); },
    }],
    onPick: (kind, steps) => send(editOp(kind === 'undo' ? OP_UNDO_STEPS : OP_REDO_STEPS, { steps })),
    returnFocus: canvas,
  });
}
btnUndo.addEventListener('contextmenu', (e) => openPopoutHistory(e, btnUndo));
btnRedo.addEventListener('contextmenu', (e) => openPopoutHistory(e, btnRedo));
const btnHistory = makeBtn(History, 'editor.history.button', (e) => openPopoutHistory(e, btnHistory));
// Vibrate (Dave, 2026-11-24): the panel and its live preview here, on this
// window's copy; Apply asks the parent, which lands it as one undo step.
let vibrateLast = null;
const btnVibrate = makeBtn(Activity, 'editor.vibrate.button', () => {
  openVibratePanel({
    anchor: btnVibrate,
    graph,
    getActions: () => editable.actions,
    getSelected: () => editable.selectedIndices,
    getMaxSpeed: () => 0,                               // no cap (Dave): the mark is only said
    getMarkSpeed: () => ActionGraph.speedLimits?.max || 0,
    initial: vibrateLast,
    onRemember: (o) => { vibrateLast = o; },
    onApply: (opts) => send(editOp(OP_APPLY_MODIFIER, { name: 'vibrate', args: [opts] })),
    returnFocus: canvas,
  });
});
// Check script (work list 4.2), on this window's copy; a pick selects in the parent.
const btnCheck = makeBtn(FileCheck, 'editor.check.button', () => {
  openScriptCheck({
    actions: editable.actions,
    getActions: () => editable.actions,
    limits: { ...(ActionGraph.speedLimits || {}), frameMs: popoutFrameMs },
    onJump: (at) => {
      graph.centerOnTime(at);
      player.video.currentTime = at / 1000;
      graph.setCursorTime?.(at);
      graph.draw();
      updateScrubber();
    },
    onSelect: (indices) => send(editOp(OP_SELECT, { indices })),
  });
});
const btnDelete = makeBtn(Trash2,      'editor.btn.delete',       () => send(editOp(OP_DELETE)));
const btnCut    = makeBtn(Scissors,    'editor.btn.cut',          () => send(editOp(OP_CUT)));
const btnInvert = makeBtn(FlipVertical2, 'editor.btn.invert',     () => send(editOp(OP_INVERT)));
const btnSimplify = makeBtn(Spline,    'editor.btn.simplify',     () => send(msg(REQUEST_SIMPLIFY)));
const btnSave   = makeBtn(Save,        'editor.btn.save',         () => send(msg(SAVE)));

// Metadata / Bookmark / Fill Gaps / Beats — these open modals that
// live in the docked editor. For Tier-A parity we surface the trigger
// here; the modal opens in the parent window (visible to the user
// since they're presumably looking at both monitors). Bookmark add is
// an immediate op — no modal — so it dispatches directly.
const btnMetadata = makeBtn(FileText,    'editor.btn.metadata',      () => send(msg(REQUEST_METADATA)));
const btnBookmark = makeBtn(BookmarkPlus, 'editor.btn.bookmark',     () =>
  send(editOp(OP_ADD_BOOKMARK, { at: Math.round(player.currentTime * 1000) })));
const btnFillGaps = makeBtn(Rows3,       'editor.btn.fillGaps',      () => send(msg(REQUEST_FILL_GAPS)));
const btnBeats    = makeBtn(Music,       'editor.btn.beats',         () => send(msg(REQUEST_BEATS)));
// Zoom buttons + `+` / Ctrl+- keys mirror the docked editor exactly:
// zoom around the playhead (or viewport centre when playhead is 0),
// 1.5× per click. Same factor as the docked toolbar buttons. Bare `-`
// places a point at 100 (FT-032), so the zoom-out tooltip names Ctrl+-
// (CB-04; it said "(-)").
function zoomKey(factor) {
  graph.markInteraction?.();
  const center = graph._cursorMs || (graph.viewStartMs + graph.viewDurationMs / 2);
  graph.zoomAt?.(center, factor);
  updateScrubber();
}
const btnZoomIn = makeBtn(ZoomIn,      'editor.btn.zoomIn',       () => zoomKey(1 / 1.5));
const btnZoomOut = makeBtn(ZoomOut,    'editor.btn.zoomOut',      () => zoomKey(1.5));
const btnFitAll = makeBtn(Magnet,      'editor.btn.fitAll',       () => { graph.fitAll?.(); graph.draw(); updateScrubber(); });

// Select dropdown — same items, order, keys and words as the docked editor's
// (editor.select.*). Every item sends exactly what its key sends
// (runSelectCommand below).
const selectMenu = document.createElement('select');
selectMenu.className = 'editor__speed-select editor__select-menu';
stamp(selectMenu, { title: 'editor.select.title', aria: 'editor.select.title' });
[
  '', 'all', 'beforePlayhead', 'afterPlayhead', 'topThird', 'middleThird', 'bottomThird',
  null,
  'everyNth', 'created',
  null,
  'none',
].forEach((value) => {
  // null = separator. Chromium draws an <hr> in a <select> as a divider.
  if (value === null) { selectMenu.appendChild(document.createElement('hr')); return; }
  const opt = document.createElement('option');
  opt.value = value;
  stamp(opt, { text: `editor.select.${value || 'placeholder'}` });
  opt.disabled = value === '';
  selectMenu.appendChild(opt);
});
selectMenu.selectedIndex = 0;
selectMenu.addEventListener('change', () => {
  const v = selectMenu.value;
  selectMenu.selectedIndex = 0;
  // Back to the canvas, as in the docked editor: a focused <select> takes
  // the arrow keys and type-ahead.
  canvas.focus({ preventScroll: true });
  runSelectCommand(v);
});

// Modify dropdown — same option set as the docked editor. Param-less
// modifiers (halfSpeed / doubleSpeed / reverse) dispatch directly as
// OP_APPLY_MODIFIER. Modal-bearing ones (remap, offset, removePauses,
// rangeExtend, generatePattern, exportHeatmap) forward to the parent
// which already owns those modal flows.
const modifySelect = document.createElement('select');
modifySelect.className = 'editor__speed-select';
stamp(modifySelect, { title: 'editor.modify.title', aria: 'editor.modify.title' });
[
  '', 'halfSpeed', 'doubleSpeed', 'reverse', 'fadeIn', 'fadeOut', 'rippleDelete', 'fromStroke', 'remapRange', 'offsetTime',
  'removePauses', 'rangeExtend', 'generatePattern', 'fillPattern', 'exportHeatmap',
].forEach((value) => {
  const opt = document.createElement('option');
  opt.value = value;
  stamp(opt, { text: `editor.modify.${value || 'placeholder'}` });
  opt.disabled = value === '';
  modifySelect.appendChild(opt);
});
modifySelect.selectedIndex = 0;
modifySelect.addEventListener('change', () => {
  const v = modifySelect.value;
  modifySelect.selectedIndex = 0;
  switch (v) {
    case 'halfSpeed':   send(editOp(OP_APPLY_MODIFIER, { name: 'halfSpeed' })); break;
    case 'doubleSpeed': send(editOp(OP_APPLY_MODIFIER, { name: 'doubleSpeed' })); break;
    case 'reverse':     send(editOp(OP_APPLY_MODIFIER, { name: 'reverse' })); break;
    case 'fadeIn':      send(editOp(OP_APPLY_MODIFIER, { name: 'fadeIn' })); break;
    case 'fadeOut':     send(editOp(OP_APPLY_MODIFIER, { name: 'fadeOut' })); break;
    case 'rippleDelete': send(editOp(OP_RIPPLE_DELETE)); break;
    case 'fromStroke':  send(msg('request-from-stroke')); break;
    case 'remapRange':       send(msg(REQUEST_REMAP_RANGE)); break;
    case 'offsetTime':       send(msg(REQUEST_OFFSET_TIME)); break;
    case 'removePauses':     send(msg(REQUEST_REMOVE_PAUSES)); break;
    case 'rangeExtend':      send(msg(REQUEST_RANGE_EXTEND)); break;
    case 'generatePattern':  send(msg(REQUEST_GENERATE_PATTERN)); break;
    // Fill with pattern: the drawer opens HERE, beside this window's timeline.
    case 'fillPattern':      openPatternFill(); break;
    case 'exportHeatmap':    send(msg(REQUEST_EXPORT_HEATMAP)); break;
  }
});

// Waveform toggle — forwards to parent (no in-pop-out render yet;
// waveform data sync is Tier-B work). Marked as a toggle button so
// future state-broadcast can flip aria-pressed via _setToggleState. Its own
// key: it says where the waveform shows (the docked one's does not need to).
// Recording mode on the toolbar (work list 4.6): the parent owns it; the
// SETTINGS echo flips this button with the REC indicator.
const btnRecord = makeBtn(CircleDot, 'editor.btn.record', () =>
  send(msg(SET_SETTING, { key: 'recordingMode', value: recordingIndicator.hidden })));
btnRecord.setAttribute('aria-pressed', 'false');
btnRecord.classList.add('editor__btn--record');
// Gamepad recording (work list 2.6): the main window records on the real
// video's time; this window only asks (SET_SETTING) and shows its state.
let gamepadRecording = false;
let gamepadMapping = { ...DEFAULT_GAMEPAD_MAPPING };
function popoutPadName() {
  try {
    const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
    return pads.length ? cleanPadName(pads[0].id) : null;
  } catch { return null; }
}
function openPopoutGamepadMenu() {
  const r = btnGamepad.getBoundingClientRect();
  openGamepadRecordMenu({
    x: r.left, y: r.bottom,
    axes: gamepadTargetAxes({ present: axesPresent, withMain: axisTools }),
    current: gamepadMapping,
    padName: popoutPadName(), getPadName: popoutPadName,
    recording: gamepadRecording,
    onPick: (m) => send(msg(SET_SETTING, { key: 'gamepadMapping', value: m })),
    onStart: axisTools ? (m) => { send(msg(SET_SETTING, { key: 'gamepadMapping', value: m })); send(msg(SET_SETTING, { key: 'gamepadRecording', value: true })); } : undefined,
    onStop: () => send(msg(SET_SETTING, { key: 'gamepadRecording', value: false })),
    returnFocus: btnGamepad,
  });
}
const btnGamepad = makeBtn(Gamepad2, 'editor.gamepad.button', openPopoutGamepadMenu);
btnGamepad.setAttribute('aria-pressed', 'false');
const btnWaveform = makeBtn(AudioWaveform, 'editor.popout.waveformTitle', () =>
  send(msg(REQUEST_TOGGLE_WAVEFORM))
);
btnWaveform.setAttribute('aria-pressed', 'false');

// Speed dropdown — mirrors the docked editor exactly. Same preset
// list (PLAYBACK_RATE_PRESETS in video-player.js); changing fires
// VIDEO_SET_RATE so the parent's videoPlayer.setPlaybackRate is the
// single source of truth.
const speedLabel = document.createElement('span');
speedLabel.className = 'editor__speed-label';
stamp(speedLabel, { text: 'editor.speedLabel' });
const speedSelect = document.createElement('select');
speedSelect.className = 'editor__speed-select';
for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
  const opt = document.createElement('option');
  opt.value = String(rate);
  opt.textContent = `${rate}x`;
  if (rate === 1) opt.selected = true;
  speedSelect.appendChild(opt);
}
// The label and its select wrap as one (R3 fix-up, verifier 1: at 1100x700
// 'Speed:' ended row 1 and its select started row 2).
const speedGroup = document.createElement('span');
speedGroup.className = 'editor__speed-group';
speedGroup.append(speedLabel, speedSelect);
speedSelect.addEventListener('change', () => {
  const rate = parseFloat(speedSelect.value);
  send(msg(VIDEO_SET_RATE, { rate }));
});

// Snap-to-frame toggle — mirrors the docked editor. Snap state lives
// in the parent (single source of truth). Toggle dispatches
// SET_SETTING; the SETTINGS echo flips this checkbox.
const snapLabel = document.createElement('label');
snapLabel.className = 'editor__toggle-label';
const snapCheck = document.createElement('input');
snapCheck.type = 'checkbox';
snapCheck.checked = true;
snapCheck.addEventListener('change', () => {
  send(msg(SET_SETTING, { key: 'snapToFrame', value: snapCheck.checked }));
});
snapLabel.appendChild(snapCheck);
const snapText = document.createElement('span');
snapText.style.marginLeft = '4px';
stamp(snapText, { text: 'editor.snapLabel' });
snapLabel.appendChild(snapText);
stamp(snapLabel, { title: 'editor.snapTitle' });

// Spline/curves toggle — same pattern.
const splineLabel = document.createElement('label');
splineLabel.className = 'editor__toggle-label';
const splineCheck = document.createElement('input');
splineCheck.type = 'checkbox';
splineCheck.checked = true;
splineCheck.addEventListener('change', () => {
  send(msg(SET_SETTING, { key: 'splineMode', value: splineCheck.checked }));
});
splineLabel.appendChild(splineCheck);
const splineText = document.createElement('span');
splineText.style.marginLeft = '4px';
stamp(splineText, { text: 'editor.curvesLabel' });
splineLabel.appendChild(splineText);
stamp(splineLabel, { title: 'editor.curvesTitle' });

// Recording REC indicator — hidden when not recording, blinking when on.
// Matches the docked editor's `editor__recording-indicator`.
const recordingIndicator = document.createElement('span');
recordingIndicator.className = 'editor__recording-indicator';
stamp(recordingIndicator, { text: 'editor.recording' });
recordingIndicator.hidden = true;
recordingIndicator.style.cssText = 'color:#ff4444;font-weight:700;font-size:11px;margin-left:6px;animation:blink 1s step-end infinite';

const statusEl = makeLabel('', 'editor__status');
// The parent's script holds unsaved edits (its ACTIONS_CHANGED `dirty`): the
// status line's "*" (updateStatus).
let parentDirty = false;

// Local snap-to-frame state — mirrored from the parent via SETTINGS.
// Used to snap pop-out gesture timestamps before sending them.
let popoutSnapToFrame = true;
let popoutFrameMs = 1000 / 30;
// Where the video's frame grid starts (the docked editor's _framePhaseMs):
// frames sit at phase + n x popoutFrameMs, not always at n x popoutFrameMs.
let popoutFramePhaseMs = 0;
// Ctrl+Left/Right and Ctrl+Shift+Left/Right step this many frames: the docked
// editor's `editor.fastStepFrames` (the parent sends it in INITIAL_STATE and
// SETTINGS). It was a literal 6 here, whatever the setting said (D-02).
let popoutFastStepFrames = 6;
function snapTime(timeMs) {
  if (!popoutSnapToFrame) return timeMs;
  return popoutFramePhaseMs + Math.round((timeMs - popoutFramePhaseMs) / popoutFrameMs) * popoutFrameMs;
}

// Moving the selection by `frames` frames (Shift / Ctrl+Shift+Left/Right), as
// the docked editor's _frameMoveDeltaMs: with Snap to frame on, the first
// selected point lands exactly on the frame start that many frames away. A
// bare frames x duration was rounded to the ms on each press and drifted off
// the frames, about 1 ms every 3 presses at 29.97 fps (B031).
function frameMoveDeltaMs(frames) {
  const raw = frames * popoutFrameMs;
  if (!popoutSnapToFrame) return raw;
  const times = [...editable.selectedIndices].map((i) => editable.actions[i]?.at).filter(Number.isFinite);
  if (!times.length) return raw;
  const first = Math.min(...times);
  return snapTime(snapTime(first) + raw) - first;
}

// The frame grid from INITIAL_STATE / SETTINGS (a new video's rate or grid),
// and the speed limits the graph marks (the docked editor's _speedLimits).
function applyFrameGrid(m) {
  if (m.speedLimits && typeof m.speedLimits === 'object') {
    ActionGraph.setSpeedLimits(m.speedLimits);
    graph?.draw?.();
  }
  if (typeof m.frameDurationMs === 'number' && m.frameDurationMs > 0) popoutFrameMs = m.frameDurationMs;
  if (typeof m.framePhaseMs === 'number' && m.framePhaseMs >= 0 && m.framePhaseMs < popoutFrameMs) {
    popoutFramePhaseMs = m.framePhaseMs;
  }
}

// Dock-back is the pop-out's `Pop out` button — sits in the same
// location (after Save, before autosave/snap/curves). Uses the same
// `editor__btn--active` accent treatment since the docked editor's
// equivalent does the same on "popout open".
// Dock button — text label rather than icon. Visual sizing handled in
// editor.css under `.script-editor--popout-window .editor__btn--dock` so all
// inline style stays out of the JS (it matched `aria-label^="Dock"`, which
// only the English label starts with).
const btnDock = document.createElement('button');
btnDock.className = 'editor__btn editor__btn--active editor__btn--dock';
stamp(btnDock, { text: 'editor.popout.dock', title: 'editor.btn.dock', aria: 'editor.btn.dock' });
btnDock.addEventListener('click', () => window.funsync.editorPopoutClose());

// ===== The video's axes (multi-axis editing, 2026-11-24) ===================
// The docked editor's New axis, Export and stacked lanes, in this window. The
// parent owns every axis (its session, its Save); this window asks for the
// work and draws what it is sent.
let axisTools = false;          // a script is loaded and the list is axes (not Custom Routing routes)
let axesPresent = new Set();    // the axes the video has (canonical suffixes)
let lanesOn = false;
// The tracks' pace during playback (syncLanes).
const LANE_FRAME_MS = 12;
let lanesDrawnAt = -Infinity;
let lanesAlignedAt = -Infinity;
let lanesAlignDirty = true;
let lanesRaf = 0;
const btnNewAxis = makeBtn(Plus, 'editor.btn.newAxis', () => {
  const r = btnNewAxis.getBoundingClientRect();
  openContextMenu({
    x: r.left, y: r.bottom,
    ariaLabel: t('editor.newAxis.menu'),
    returnFocus: btnNewAxis,
    items: AXIS_DEFINITIONS.map((def) => ({
      label: `${def.label} (${def.tcode})`,
      disabled: axesPresent.has(def.suffix),
      hint: axesPresent.has(def.suffix) ? t('editor.newAxis.have') : '',
      onSelect: () => send(msg('axis-create', { suffix: def.suffix })),
    })),
  });
});
const btnExportAxes = makeBtn(FileOutput, 'editor.btn.exportAxes', () => {
  const r = btnExportAxes.getBoundingClientRect();
  openContextMenu({
    x: r.left, y: r.bottom,
    ariaLabel: t('editor.export.menu'),
    returnFocus: btnExportAxes,
    items: [
      { heading: t('editor.export.thisScript') },
      { label: t('editor.export.saveAs'), hint: t('editor.export.saveAsHint'), onSelect: () => send(msg('save-as')) },
      { heading: t('editor.export.everyAxis') },
      { label: t('editor.export.combined'), hint: t('editor.export.combinedHint'), onSelect: () => send(msg('axes-export', { kind: 'combined' })) },
      { label: t('editor.export.separate'), hint: t('editor.export.separateHint'), onSelect: () => send(msg('axes-export', { kind: 'separate' })) },
    ],
  });
});
/**
 * What Save writes for this video, as the parent says (into the combined file,
 * each axis to its own file, or plain Save): the button's tooltip and name, and
 * its keys for a later language change.
 */
function applySaveKey(key) {
  if (!key) return;
  stamp(btnSave, { title: key, aria: key });
  btnSave.title = t(key);
  btnSave.setAttribute('aria-label', t(key));
}

/** The script FILE of the script on screen (an axis in a combined file is in it); never a stream. */
function backupFile() {
  const p = activePath;
  if (typeof p !== 'string' || !p || p.startsWith('stream:')) return null;
  const i = p.indexOf('#embedded=');
  return i >= 0 ? p.slice(0, i) : p;
}
const btnStacked = makeBtn(Layers2, 'editor.btn.stacked', () => setLanes(!lanesOn));
btnNewAxis.hidden = true;
btnExportAxes.hidden = true;
btnStacked.hidden = true;

toolbar.append(
  scriptSelect, btnStacked, btnNewAxis, btnExportAxes, makeSep(true),
  btnUndo, btnRedo, btnHistory, makeSep(),
  btnDelete, btnCut, btnInvert, btnSimplify, btnVibrate, makeSep(),
  selectMenu, modifySelect, makeSep(),
  btnMetadata, btnBookmark, btnFillGaps, btnCheck, btnWaveform, btnBeats, btnRecord, btnGamepad, makeSep(true),
  btnZoomIn, btnZoomOut, btnFitAll, makeSep(true),
  speedGroup, makeSep(true),
  btnSave, btnDock, snapLabel, splineLabel, recordingIndicator, statusEl,
);

// ===== Canvas + scrubber + footer =========================================

const canvasContainer = document.createElement('div');
canvasContainer.className = 'editor__canvas-container';

const canvas = document.createElement('canvas');
canvas.className = 'editor__canvas';
canvas.tabIndex = 0;
canvasContainer.appendChild(canvas);

const scrubber = document.createElement('div');
scrubber.className = 'editor__scrubber';
const scrubberTrack = document.createElement('div');
scrubberTrack.className = 'editor__scrubber-track';
const scrubberViewport = document.createElement('div');
scrubberViewport.className = 'editor__scrubber-viewport';
const scrubberCursor = document.createElement('div');
scrubberCursor.className = 'editor__scrubber-cursor';
scrubberTrack.append(scrubberViewport, scrubberCursor);
scrubber.appendChild(scrubberTrack);

host.append(toolbar, canvasContainer, scrubber);

// ===== Model wiring =======================================================

const editable = new EditableScript();
const player = new PopoutVideoPlayerStub({ send });
const graph = new ActionGraph(canvas, editable);
let hydrated = false;
let activePath = null;

// The stacked lanes: the video's other axes, read-only, above this window's
// timeline and locked to its view; a click edits that axis (as the docked
// editor's Stacked View). The parent sends their points while they show.
const lanesContainer = document.createElement('div');
lanesContainer.className = 'editor__stacked-lanes';
lanesContainer.hidden = true;
host.insertBefore(lanesContainer, canvasContainer);
// The tracks keep their order (fixed-order tracks, Dave 2026-11-24): the one
// being edited is this window's timeline in its own place, the ones before it
// above, the ones after it here below; its name sits in the timeline's gutter.
const lanesAfter = document.createElement('div');
lanesAfter.className = 'editor__stacked-lanes editor__stacked-lanes--after';
lanesAfter.hidden = true;
canvasContainer.after(lanesAfter);
const trackLabel = document.createElement('span');
trackLabel.className = 'editor__track-label';
canvasContainer.appendChild(trackLabel);
const TRACK_GUTTER_PX = 92;
// The graph follows its box (the lanes coming and going, a window resize):
// the docked editor has the same watcher (_resizeObserver).
if (typeof ResizeObserver !== 'undefined') {
  let rsFrame = 0;
  new ResizeObserver(() => {
    if (rsFrame) return;
    rsFrame = requestAnimationFrame(() => { rsFrame = 0; try { graph.resize(); graph.draw(); } catch { /* not ready */ } });
  }).observe(canvasContainer);
}
const lanes = [];

function setLanes(on) {
  lanesOn = !!on;
  btnStacked.setAttribute('aria-pressed', String(lanesOn));
  btnStacked.classList.toggle('editor__btn--active', lanesOn);
  lanesContainer.hidden = !lanesOn;
  lanesAfter.hidden = !lanesOn;
  host.classList.toggle('script-editor--stacked', lanesOn);
  graph.setGutter?.(lanesOn ? TRACK_GUTTER_PX : 40);
  try { graph.draw(); } catch { /* not hydrated yet */ }
  if (!lanesOn) {
    lanesContainer.innerHTML = '';
    lanesAfter.innerHTML = '';
    lanes.length = 0;
  }
  send(msg('lanes-wanted', { on: lanesOn }));
}

// Lanes hidden with a right-click (work list 2.2), for this window; the
// last list the parent sent, to draw again after a hide or a show.
const hiddenLanes = new Set();
let lastLanes = [];
function openLaneMenu(e, l) {
  e.preventDefault();
  e.stopPropagation();
  openContextMenu({
    x: e.clientX, y: e.clientY,
    ariaLabel: t('editor.lanes.menu'),
    items: [
      { label: t('editor.lanes.hide', { name: l.label }), onSelect: () => { hiddenLanes.add(l.path); renderLanes(lastLanes); } },
      { label: t('editor.lanes.showAll'), disabled: hiddenLanes.size === 0, onSelect: () => { hiddenLanes.clear(); renderLanes(lastLanes); } },
    ],
  });
}

function renderLanes(list) {
  lanesContainer.innerHTML = '';
  lanesAfter.innerHTML = '';
  lanes.length = 0;
  lastLanes = list || [];
  if (!lanesOn) return;
  // The parent's list is in the tracks' order, the one being edited marked.
  const activeAt = lastLanes.findIndex((l) => l.active);
  trackLabel.textContent = activeAt >= 0 ? (lastLanes[activeAt].label || '') : '';
  const shown = lastLanes.filter((l) => !l.active && !hiddenLanes.has(l.path));
  for (const l of shown) {
    const container = document.createElement('div');
    container.className = 'editor__lane editor__lane--inactive';
    container.title = t('editor.lanes.clickToEdit', { name: l.label });
    const label = document.createElement('span');
    label.className = 'editor__lane-label';
    label.textContent = l.label;
    const laneCanvas = document.createElement('canvas');
    laneCanvas.className = 'editor__lane-canvas';
    container.append(label, laneCanvas);
    const laneScript = new EditableScript();
    laneScript._actions = (l.actions || []).map((a) => ({ at: a.at, pos: a.pos }));
    const laneGraph = new ActionGraph(laneCanvas, laneScript);
    laneGraph.setCompact(true);
    container.addEventListener('click', () => {
      send(msg('script-switch', { path: l.path }));
      // The keys go to this window's timeline (as the docked editor's).
      try { canvas.focus({ preventScroll: true }); } catch { /* not shown */ }
    });
    container.addEventListener('contextmenu', (e) => openLaneMenu(e, l));
    (activeAt >= 0 && lastLanes.indexOf(l) < activeAt ? lanesContainer : lanesAfter).appendChild(container);
    try { laneGraph.resize(); } catch { /* not visible yet */ }
    lanes.push({ path: l.path, graph: laneGraph });
  }
  const hiddenCount = lastLanes.filter((l) => !l.active).length - shown.length;
  if (hiddenCount > 0) {
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'editor__lanes-show-hidden';
    show.textContent = t('editor.lanes.showHidden', { count: hiddenCount });
    show.addEventListener('click', () => { hiddenLanes.clear(); renderLanes(lastLanes); });
    lanesAfter.appendChild(show);
  }
  // Laid out with the Show hidden row in (it counts in the height: it went
  // below the fold with room to spare, fit-on-screen pass).
  layoutPopoutLanes(shown.length);
  // Short of room the boxes scroll: they open on the tracks next to the one
  // being edited (the box above at its end, the box below at its top).
  lanesContainer.scrollTop = lanesContainer.scrollHeight;
  lanesAfter.scrollTop = 0;
  // Sized now: the lane canvases take their new height.
  for (const l of lanes) { try { l.graph.resize(); } catch { /* not visible yet */ } }
  syncLanes();
}

/**
 * Every lane fits (Dave, 2026-11-24: in the pop-out the last lane went off
 * screen): the lanes area takes at most 40% of the editor host, the lanes
 * share it (56 px each down to 30), and more than fit scroll. Re-run on a
 * window resize.
 */
function layoutPopoutLanes(n = lanes.length) {
  lanesAlignDirty = true;
  const boxes = [lanesContainer, lanesAfter];
  const shownBoxes = boxes.filter((b) => b.childElementCount > 0);
  for (const b of boxes) if (!b.childElementCount) b.style.height = '';
  if (!lanesOn || !shownBoxes.length) return;
  const lanesIn = (b) => b.querySelectorAll('.editor__lane').length;
  // Of the room the lanes share with the main graph (the window less its
  // title strip, the toolbar's rows and the scrubber), at most 45%, and never
  // so much that the main graph drops under 160 px: past that the lanes scroll
  // (a 720x460 window left the main graph 99 px, fit-on-screen pass).
  const host = document.getElementById('editor-popout-host');
  const total = host?.getBoundingClientRect?.().height || window.innerHeight || 700;
  const fixed = (toolbar?.offsetHeight || 0) + (scrubber?.offsetHeight || 0);
  const room = Math.max(0, total - fixed);
  const cap = Math.max(72, Math.min(Math.round(room * 0.45), room - 160));
  // A box's padding and border, and the Show hidden row (+ its gap).
  const chromeOf = (b) => {
    const bar = b.querySelector('.editor__lanes-show-hidden')?.offsetHeight || 0;
    return 5 + (bar ? bar + 1 : 0);
  };
  const chrome = shownBoxes.reduce((sum, b) => sum + chromeOf(b), 0);
  const lanesTotal = Math.min(n * 57 + chrome, cap);
  const laneH = n ? Math.max(30, Math.min(56, Math.floor((lanesTotal - chrome) / n) - 1)) : 30;
  // Each box its lanes at that height; short of room, shared out (each scrolls).
  const natural = shownBoxes.map((b) => lanesIn(b) * (laneH + 1) + chromeOf(b));
  const sum = natural.reduce((a, b) => a + b, 0);
  shownBoxes.forEach((b, i) => {
    const h = sum <= lanesTotal ? natural[i]
      : Math.max(Math.min(natural[i], chromeOf(b) + laneH + 1), Math.floor((lanesTotal * natural[i]) / sum));
    b.style.height = `${h}px`;
    b.style.setProperty('--lane-h', `${laneH}px`);
  });
}
window.addEventListener('resize', () => {
  if (!lanesOn || (!lanes.length && !lanesAfter.childElementCount)) return;
  layoutPopoutLanes(lanes.length);
  for (const l of lanes) { try { l.graph.resize(); } catch { /* hidden */ } }
  syncLanes();
});

// During playback the tracks draw at most every LANE_FRAME_MS and line up with
// the plot again only after a layout change or twice a second, as the docked
// editor's (script-editor.js _syncInactiveLanes; Dave, 2026-11-25: "speed up
// the player when in editor"). Paused, every redraw is at once.
function syncLanes() {
  if (!lanesOn) return;
  const playing = player.paused === false;
  const now = performance.now();
  if (playing && now - lanesDrawnAt < LANE_FRAME_MS) {
    if (!lanesRaf) lanesRaf = requestAnimationFrame(() => { lanesRaf = 0; syncLanes(); });
    return;
  }
  lanesDrawnAt = now;
  const align = !playing || lanesAlignDirty || now - lanesAlignedAt > 500;
  if (align) { lanesAlignDirty = false; lanesAlignedAt = now; }
  for (const l of lanes) {
    l.graph.setVideoDuration(graph._videoDurationMs);
    if (align || !l.aligned) { l.graph.alignTo(graph); l.aligned = true; }
    l.graph.setViewport(graph.viewStartMs, graph.viewEndMs);
    l.graph.setCursorTime(graph._cursorMs);
    l.graph._splineMode = graph._splineMode;
    l.graph.draw();
  }
}
// Every redraw of this window's timeline moves the lanes with it.
const drawTimeline = graph.draw.bind(graph);
graph.draw = (...args) => {
  const r = drawTimeline(...args);
  syncLanes();
  return r;
};

// ===== Fill with pattern (pattern library, Round 2) =======================
// The docked editor's drawer, in this window, beside this window's timeline.
// The preview is rendered here (the fill core is pure) on this window's copy
// of the parent's script; Apply sends the fill it showed as OP_FILL_RANGE and
// the parent lands it as one undo step (its script, undo stack and autosave
// stay the only ones). The parent sends the remembered options
// (editor.patternFill) in INITIAL_STATE and SETTINGS and stores them on Apply.

let patternFillOptions = null;
let fillDrawer = null;
// Apply waits for the parent's answer (FILL_RESULT): the drawer stays open
// and busy, closes when the fill landed, and keeps the user's settings when
// it was refused (review-2 minor 7). No answer in this time: as refused.
const FILL_ANSWER_TIMEOUT_MS = 5000;
let fillRequestSeq = 0;
const fillWaiters = new Map();

// A time range marked for a fill, as in the docked editor: a rubber band
// over 0 or 1 points leaves its span here ({ startMs, endMs, key }), shaded
// on the graph. The band's selection is the parent's to make: the mark waits
// (pending) for the ACTIONS_CHANGED that brings it back, and holds from then
// on while the selection, the path and the window's points stay (any other
// selection, an edit there or another script ends it). Esc and any left
// press on the timeline end it too.
let fillRangeMark = null;

function fillRangeKeyOf(indices, startMs, endMs) {
  return fillRangeKey(indices, `${activePath}|${windowSignature(editable.actions, startMs, endMs)}`);
}

/** The marked fill range while it holds, else null (and it is gone). */
function currentFillRange() {
  const r = fillRangeMark;
  if (!r || r.pending) return null;
  if (r.key === fillRangeKeyOf(editable.selectedIndices, r.startMs, r.endMs)) return r;
  fillRangeMark = null;
  graph.setTimeRange?.(null);
  return null;
}

/** The marked range on the graph (or none), and an open drawer previews it. */
function showFillRange() {
  const r = fillRangeMark && !fillRangeMark.pending ? fillRangeMark : null;
  graph.setTimeRange?.(r ? { from: r.startMs, to: r.endMs } : null, () => !!currentFillRange());
  if (hydrated) graph.draw();
  fillDrawer?.refresh();
}

/**
 * Mark (or, with null, end) the range. `expected`: the selection a band
 * asked the parent for; the mark waits for it (ACTIONS_CHANGED).
 */
function setFillRange(range, expected = null) {
  fillRangeMark = range
    ? {
      startMs: range.startMs, endMs: range.endMs, pending: !!expected,
      key: fillRangeKeyOf(expected || editable.selectedIndices, range.startMs, range.endMs),
    }
    : null;
  showFillRange();
}

/** ACTIONS_CHANGED: a waiting mark holds once its selection is back; any mark ends with another selection or an edit. */
function followFillRange() {
  const r = fillRangeMark;
  if (!r) return;
  if (!r.pending) {
    if (!currentFillRange()) showFillRange();
    return;
  }
  if (r.key === fillRangeKeyOf(editable.selectedIndices, r.startMs, r.endMs)) r.pending = false;
  else fillRangeMark = null;
  showFillRange();
}

function ensureFillDrawer() {
  if (fillDrawer) return fillDrawer;
  fillDrawer = new PatternFillDrawer({
    container: host,
    graph,
    placement: 'side',
    getActions: () => editable.actions,
    getSelectedIndices: () => editable.selectedIndices,
    loadOptions: () => patternFillOptions,
    // The parent's script this window mirrors. ACTIONS_CHANGED reloads the
    // mirror on every parent edit, so the path is the script's identity here.
    getScriptKey: () => activePath,
    notify: (text, level) => showToast(text, level),
    getFillRange: () => currentFillRange(),
    onApply: (fill) => {
      const requestId = ++fillRequestSeq;
      // What the preview was built on goes along (the script's path and the
      // signature of its points): the parent lands it only on that script.
      send(editOp(OP_FILL_RANGE, {
        t0: fill.t0, t1: fill.t1, points: fill.points, mode: fill.mode,
        patternId: fill.patternId, options: fill.options,
        path: activePath, sig: fill.sig, requestId,
        // A marked time range (no anchors at t0 / t1): the parent lands it as an insert.
        range: fill.range === true,
      }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          fillWaiters.delete(requestId);
          resolve(false);
        }, FILL_ANSWER_TIMEOUT_MS);
        fillWaiters.set(requestId, (ok) => {
          clearTimeout(timer);
          fillWaiters.delete(requestId);
          resolve(ok);
        });
      });
    },
    onClose: () => canvas.focus({ preventScroll: true }),
  });
  return fillDrawer;
}

/** P, the right-click menu and Modify > Fill with Pattern… (two selected points or a marked range, as docked). */
function openPatternFill() {
  if (!hydrated) return false;
  if (editable.selectedIndices.size < 2 && !currentFillRange()) {
    showToast(t('editor.patternFill.needSelection'), 'info');
    return false;
  }
  closeContextMenu();
  ensureFillDrawer().open();
  return true;
}

/** The timeline's right-click menu, as in the docked editor (script-editor.js _openCanvasMenu). */
function openCanvasMenu(x = null, y = null) {
  if (x === null || y === null) {
    const rect = canvas.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 3;
  }
  const enough = editable.selectedIndices.size >= 2 || !!currentFillRange();
  openContextMenu({
    x, y,
    ariaLabel: t('editor.patternFill.contextMenu'),
    returnFocus: canvas,
    items: [{
      label: t('editor.patternFill.menu'),
      disabled: !enough,
      hint: enough ? '' : t('editor.patternFill.needSelection'),
      onSelect: () => openPatternFill(),
    }],
  });
}

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!hydrated) return;
  // At the pointer; a menu the keyboard opened (no position) sits on the canvas.
  const pointed = e.clientX !== 0 || e.clientY !== 0;
  openCanvasMenu(pointed ? e.clientX : null, pointed ? e.clientY : null);
});

// Follow playback as the docked editor does (script-editor.js 'playing' /
// 'pause'): the graph recentres on the playhead only while it animates
// (ActionGraph.setCursorTime), and this window never started it, so the
// playhead walked off a static graph, points and selection stood still
// (D-01, Dave's report, also in v0.9.2). The stub fires these from the
// parent's TIME_TICKs.
player.video.addEventListener('playing', () => {
  if (hydrated) graph.startAnimation();
});
player.video.addEventListener('pause', () => {
  graph.stopAnimation();
  if (hydrated) graph.draw();
});

function resizeCanvas() {
  graph.resize();
  if (hydrated) {
    graph.draw();
    updateScrubber();
  }
}
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(resizeCanvas);

/** The scroller's length: the docked editor's `_getScrubberTotalMs` (the
 *  video, or the last point when the script runs past it). */
function scrubberTotalMs() {
  const actions = editable.actions;
  const lastMs = actions.length > 0 ? actions[actions.length - 1].at : 0;
  return Math.max((player.duration || 0) * 1000, lastMs, 1000);
}

function updateScrubber() {
  if (!player.duration) return;
  const dur = scrubberTotalMs();
  const startPct = Math.max(0, Math.min(100, (graph.viewStartMs / dur) * 100));
  const endPct = Math.max(0, Math.min(100, (graph.viewEndMs / dur) * 100));
  scrubberViewport.style.left = startPct + '%';
  scrubberViewport.style.width = Math.max(2, endPct - startPct) + '%';
  const cursorPct = Math.max(0, Math.min(100, (player.currentTime * 1000 / dur) * 100));
  scrubberCursor.style.left = cursorPct + '%';
}

// The bottom scroller seeks, as the docked one does (_onScrubberDown /
// _scrubberSeek): press or drag on it centres the graph there and seeks the
// video. It only painted here, so a click or a drag did nothing (D-01).
let scrubberDragging = false;
function scrubberSeek(e) {
  const rect = scrubberTrack.getBoundingClientRect();
  if (!rect.width) return;
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const targetMs = pct * scrubberTotalMs();
  graph.markInteraction?.();
  graph.centerOnTime(targetMs);
  // The stub sends VIDEO_SEEK; the parent seeks the video that plays.
  player.video.currentTime = targetMs / 1000;
  graph.setCursorTime?.(targetMs);
  graph.draw();
  updateScrubber();
}
scrubber.addEventListener('mousedown', (e) => {
  if (!hydrated || e.button !== 0) return;
  e.preventDefault();
  scrubberDragging = true;
  scrubberSeek(e);
});
document.addEventListener('mousemove', (e) => {
  if (scrubberDragging) scrubberSeek(e);
});
document.addEventListener('mouseup', () => { scrubberDragging = false; });

// ===== Mouse interactions ================================================
// (click-select, double-click-delete, alt-click-insert, shift-drag-move,
//  rubber-band selection — kept from the prior pass, design unchanged)

const DRAG_THROTTLE_MS = 33;
let dragState = null;

// A press that moved before its release was a drag (a rubber band, a
// Shift-drag of points), and the browser still fires a 'click' after its
// mouseup. That click seeked the video to where the band ended (verify-1,
// 2026-11-07; also in v0.9.2), or re-selected only the point under the
// mouse after a multi-point move. The docked editor's band only selects.
const CLICK_SLOP_PX = 3; // the band's own threshold (mouseup: r.w > 3)
let pressAt = null;
canvas.addEventListener('mousedown', (e) => {
  pressAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
});

canvas.addEventListener('click', (e) => {
  if (!hydrated) return;
  const press = pressAt;
  pressAt = null;
  if (press && Math.max(Math.abs(e.clientX - press.x), Math.abs(e.clientY - press.y)) > CLICK_SLOP_PX) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hitIdx = graph.hitTestAction?.(x, y) ?? -1;
  if (hitIdx >= 0) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) {
      const current = new Set(editable.selectedIndices);
      if (current.has(hitIdx)) current.delete(hitIdx);
      else current.add(hitIdx);
      send(editOp(OP_SELECT, { indices: [...current] }));
    } else {
      send(editOp(OP_SELECT, { indices: [hitIdx] }));
    }
    return;
  }
  const timeMs = graph.xToTime?.(x) ?? null;
  if (timeMs == null) return;
  const clamped = Math.max(0, Math.min(timeMs, player.duration * 1000));
  send(msg('video-seek', { time: clamped / 1000 }));
});

// Double-click → seek video to the clicked time. Matches docked editor
// semantics (script-editor.js::_onDoubleClick). Was incorrectly mapped
// to delete-action in an earlier pass — divergent semantics confused
// users coming from the docked editor.
canvas.addEventListener('dblclick', (e) => {
  if (!hydrated) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const timeMs = graph.xToTime?.(x);
  if (typeof timeMs !== 'number') return;
  const clamped = Math.max(0, Math.min(timeMs, player.duration * 1000));
  send(msg('video-seek', { time: clamped / 1000 }));
});

canvas.addEventListener('mousedown', (e) => {
  if (!hydrated) return;

  // Middle-click → pan mode (matches docked editor). Tracks the
  // cumulative delta-in-time from the start point and feeds it to
  // `panBy` so the gesture matches the docked editor's responsiveness
  // at every zoom level.
  if (e.button === 1) {
    e.preventDefault();
    graph.markInteraction?.();
    const { x } = graph.getCanvasCoords?.(e) ?? { x: e.offsetX };
    dragState = { mode: 'pan', startX: x };
    return;
  }

  if (e.button !== 0) return;
  // A left press anywhere on the timeline ends a marked fill range (a new
  // band marks a new one on release); the right-click menu keeps it.
  if (fillRangeMark) setFillRange(null);
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hitIdx = graph.hitTestAction?.(x, y) ?? -1;
  // While Fill with pattern previews, the two mouse EDITS wait (Alt+click
  // insert, Shift+drag move); clicks still select, as in the docked editor.
  const previewing = fillDrawer?.isOpen === true;

  if (e.altKey && hitIdx < 0 && previewing) {
    e.preventDefault();
    return;
  }

  if (e.altKey && hitIdx < 0) {
    const timeMs = graph.xToTime?.(x);
    const pos = graph.yToPos?.(y);
    if (typeof timeMs !== 'number' || typeof pos !== 'number') return;
    if (timeMs < 0 || timeMs > player.duration * 1000) return;
    e.preventDefault();
    send(editOp(OP_INSERT, {
      at: Math.round(snapTime(timeMs)),
      pos: Math.max(0, Math.min(100, Math.round(pos))),
    }));
    return;
  }

  if (e.shiftKey && hitIdx >= 0 && previewing) {
    // The click's own 'click' selects; no drag starts.
    return;
  }

  if (e.shiftKey && hitIdx >= 0) {
    const action = editable.actions[hitIdx];
    if (!action) return;
    const sel = new Set(editable.selectedIndices);
    if (!sel.has(hitIdx)) {
      sel.clear();
      sel.add(hitIdx);
      send(editOp(OP_SELECT, { indices: [hitIdx] }));
    }
    // The grabbed point leads, by the cursor's travel since the press, and
    // the steps go as OP_MOVE_ACTIONS on the selection (editor-drag-move.js).
    // OP_UPDATE by the press-time index moved the NEIGHBOUR once the point
    // passed it, and dropped a point on the path mid-drag (B032).
    const cursorAt = graph.xToTime?.(x);
    const cursorPos = graph.yToPos?.(y);
    dragState = {
      mode: 'move',
      move: startDragMove({ anchorAt: action.at, anchorPos: action.pos, cursorAt, cursorPos }),
      lastSendAt: 0,
    };
    send(editOp(OP_BEGIN_BATCH));
    e.preventDefault();
    return;
  }

  if (!e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && hitIdx < 0) {
    dragState = { mode: 'rubber', startX: x, startY: y, currentX: x, currentY: y };
    e.preventDefault();
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!hydrated || !dragState) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (dragState.mode === 'pan') {
    // Same proportional-pan math as docked editor: convert pixel
    // delta to time delta via xToTime, then panBy. Keeps gesture
    // feel identical at every zoom level.
    graph.markInteraction?.();
    const deltaMs = graph.xToTime?.(dragState.startX) - graph.xToTime?.(x);
    if (typeof deltaMs === 'number' && !isNaN(deltaMs)) graph.panBy?.(deltaMs);
    dragState.startX = x;
    updateScrubber();
    return;
  }

  if (dragState.mode === 'move') {
    const now = performance.now();
    if (now - dragState.lastSendAt < DRAG_THROTTLE_MS) return;
    dragState.lastSendAt = now;
    // Snapped to the frame with Snap to frame on, as a click or a key (B031).
    const step = dragMoveStep(dragState.move, {
      cursorAt: graph.xToTime?.(x),
      cursorPos: graph.yToPos?.(y),
      snap: popoutSnapToFrame ? snapTime : null,
    });
    if (step) send(editOp(OP_MOVE_ACTIONS, step));
  } else if (dragState.mode === 'rubber') {
    dragState.currentX = x;
    dragState.currentY = y;
    redrawRubberBand();
  }
});

canvas.addEventListener('mouseup', () => {
  if (!dragState) return;
  if (dragState.mode === 'move') {
    send(editOp(OP_END_BATCH));
  } else if (dragState.mode === 'rubber') {
    const r = normaliseRect(dragState);
    if (r.w > 3 && r.h > 3 && graph.hitTestRect) {
      const indices = graph.hitTestRect({ x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h });
      send(editOp(OP_SELECT, { indices: [...indices] }));
      // Fewer than two points caught: the band's time span is kept as a
      // range to fill (shaded), when it holds at most one point (as docked).
      if (indices.size < 2) {
        setFillRange(rangeFromBand(editable.actions, graph.xToTime?.(r.x), graph.xToTime?.(r.x + r.w)), indices);
      }
    }
    clearRubberBand();
  }
  // pan mode just clears — nothing to commit (it's a view-only gesture)
  dragState = null;
});

canvas.addEventListener('mouseleave', () => {
  if (!dragState) return;
  if (dragState.mode === 'move') send(editOp(OP_END_BATCH));
  if (dragState.mode === 'rubber') clearRubberBand();
  // pan: just clear
  dragState = null;
});

// Wheel zoom/pan — mirrors the docked editor exactly (script-editor.js::_onWheel).
// Zoom is CENTERED ON THE CURSOR (not the playhead) so the user can
// precision-zoom on an action by hovering and scrolling. Shift+wheel
// pans by 10% of viewport — proportional pan so the gesture feels the
// same at every zoom level.
canvas.addEventListener('wheel', (e) => {
  if (!hydrated) return;
  e.preventDefault();
  graph.markInteraction?.();
  const { x } = graph.getCanvasCoords?.(e) ?? { x: e.offsetX };
  const centerMs = graph.xToTime?.(x);
  if (e.shiftKey) {
    const delta = e.deltaY > 0 ? 1 : -1;
    const panAmount = graph.viewDurationMs * 0.1 * delta;
    graph.panBy?.(panAmount);
  } else {
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    if (typeof centerMs === 'number') graph.zoomAt?.(centerMs, factor);
  }
  updateScrubber();
}, { passive: false });

function normaliseRect(s) {
  return {
    x: Math.min(s.startX, s.currentX),
    y: Math.min(s.startY, s.currentY),
    w: Math.abs(s.currentX - s.startX),
    h: Math.abs(s.currentY - s.startY),
  };
}
// The band is the graph's own (setRubberBand), as in the docked editor, so the
// animation loop that runs during playback (D-01) draws it too instead of
// painting over a band drawn on top of the last frame.
function redrawRubberBand() {
  if (!dragState || dragState.mode !== 'rubber') return;
  graph.setRubberBand({ x1: dragState.startX, y1: dragState.startY, x2: dragState.currentX, y2: dragState.currentY });
  graph.draw();
}
function clearRubberBand() {
  graph.clearRubberBand();
  if (hydrated) graph.draw();
}

// ===== Keyboard handler ===================================================
//
// Window-level — works whether canvas or toolbar is focused. Position keys
// resolve exactly as in the docked editor (resolvePositionKey, FT-032): the
// user's custom keys (the parent sends them in INITIAL_STATE and SETTINGS),
// then 0-9 → 0-90 and Shift+0 / - / Numpad- → 100. Shift+1..9 place nothing.
// It used to have its own digit map: Shift+0 placed 0, Shift+5 placed 50, no
// key reached 100 and custom keys did nothing here.

let customPositionKeyMap = new Map();
// The bindings themselves, for the ? list (it reads no settings store here).
let customPositionKeys = [];

window.addEventListener('keydown', (e) => {
  if (!hydrated) return;
  // A dialog in this window (Every Nth point…, the ? list) owns the keys:
  // typing 3 into Every must not place a point at 30 behind it. Its Escape
  // never reaches here (the dialog stops it on the way down).
  if (document.querySelector('.modal-overlay')) return;
  // The Fill with pattern drawer and the right-click menu own the keys
  // pressed in them (both stop them on the way; this is the backstop).
  if (fillDrawer?.owns(e.target) || activeContextMenu()?.contains(e.target)) return;
  // Drawer open: Esc closes it, P goes back into it, the edit keys wait
  // until Apply or Cancel (the docked editor's rule, fillDrawerKeyVerdict).
  if (fillDrawer?.isOpen) {
    const verdict = fillDrawerKeyVerdict(e, { isPositionKey: resolvePositionKey(e, customPositionKeyMap) !== null });
    if (verdict !== 'allow') {
      e.preventDefault();
      if (verdict === 'close') fillDrawer.close('cancel');
      else if (verdict === 'focus') fillDrawer.focus();
      return;
    }
  }
  const ctrl = e.ctrlKey || e.metaKey;

  // Before the switch, and only with the modifiers the resolver allows:
  // Ctrl+1/2/3 are the select-third keys below (in v0.9.2 they placed a
  // point at 10/20/30). The parent places or tweaks, as the docked editor.
  const placePos = resolvePositionKey(e, customPositionKeyMap);
  if (placePos !== null) {
    e.preventDefault();
    send(editOp(OP_PLACE_AT, {
      at: Math.round(snapTime(player.currentTime * 1000)),
      pos: placePos,
    }));
    return;
  }

  // Ctrl+1 / 2 / 3 → select by position third (top / mid / bottom), on the
  // number-row KEY: AZERTY types & é " there unshifted (CB-06).
  const third = ctrl && !e.shiftKey && !e.altKey
    ? { 1: 'topThird', 2: 'middleThird', 3: 'bottomThird' }[digitKey(e)] : undefined;
  if (third) {
    e.preventDefault();
    runSelectCommand(third);
    return;
  }

  // layoutKey: the Latin letter on the key when the layout types another
  // alphabet (Russian т on N, Korean ㅜ), so the letter cases below work
  // there too (FT-035). Every other key is e.key unchanged.
  switch (layoutKey(e)) {
    case 'ArrowLeft':
      e.preventDefault();
      if (ctrl && e.altKey) {
        runSelectCommand('beforePlayhead');
      } else if (e.shiftKey && editable.selectedIndices.size > 0) {
        // Shift+Left → move selected by ±frame; Ctrl+Shift+Left → ±N frames
        const frames = ctrl ? popoutFastStepFrames : 1;
        send(editOp(OP_MOVE_ACTIONS, { deltaAt: frameMoveDeltaMs(-frames) }));
      } else if (ctrl) {
        player.stepFrames(-popoutFastStepFrames);
      } else {
        player.stepFrame(-1);
      }
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (ctrl && e.altKey) {
        runSelectCommand('afterPlayhead');
      } else if (e.shiftKey && editable.selectedIndices.size > 0) {
        const frames = ctrl ? popoutFastStepFrames : 1;
        send(editOp(OP_MOVE_ACTIONS, { deltaAt: frameMoveDeltaMs(frames) }));
      } else if (ctrl) {
        player.stepFrames(popoutFastStepFrames);
      } else {
        player.stepFrame(1);
      }
      break;

    case 'ArrowUp':
      e.preventDefault();
      if (e.shiftKey && editable.selectedIndices.size > 0) {
        // Shift+Up → nudge position +5 (Ctrl: +1)
        send(editOp(OP_MOVE_ACTIONS, { deltaPos: ctrl ? 1 : 5 }));
      } else {
        // Plain Up → the NEXT action (and seek), as in OpenFunscripter
        // (TedBaxter, Discord, 2026-11-22: it was the previous one). Local
        // lookup against the pop-out's mirror of actions, then dispatch.
        selectAdjacentAction(1);
      }
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (e.shiftKey && editable.selectedIndices.size > 0) {
        send(editOp(OP_MOVE_ACTIONS, { deltaPos: ctrl ? -1 : -5 }));
      } else {
        // Down → the PREVIOUS action (OFS prev_action).
        selectAdjacentAction(-1);
      }
      break;
    // Space plays / pauses the video that plays (the player window's while it
    // owns playback), as Space does over the docked editor (keyboard.js). The
    // pop-out had no play key, so with it on a second monitor the user had
    // to go back to the main window (verify-1, 2026-11-07; also in v0.9.2).
    // A focused button, list or field keeps its own Space.
    case ' ':
      if (ctrl || e.altKey || e.repeat) break;
      if (e.target?.closest?.('button, select, input, textarea, [contenteditable="true"]')) break;
      e.preventDefault();
      // Shift+Space: Stop all (DESIGN.md §2.15), as in the main window.
      if (e.shiftKey) { send(msg(STOP_ALL)); break; }
      send(msg(player.paused ? VIDEO_PLAY : VIDEO_PAUSE));
      break;
    case '+': case '=':
      e.preventDefault();
      zoomKey(1 / 1.5);
      break;
    case '-':
      e.preventDefault();
      zoomKey(1.5);
      break;
    case 'Delete': case 'Backspace':
      e.preventDefault();
      // Shift+Del: ripple delete (close the gap; work list 4.3).
      send(editOp(e.shiftKey && e.key === 'Delete' ? OP_RIPPLE_DELETE : OP_DELETE));
      break;
    // PageUp / PageDown: the previous / next script in the list (OFS; work
    // list 2.1). The parent switches, as a pick in the list would.
    case 'PageUp': case 'PageDown': {
      const paths = [...scriptSelect.options].map((o) => o.value);
      if (paths.length < 2) break;
      e.preventDefault();
      const i = Math.max(0, paths.indexOf(activePath));
      const next = paths[(i + (e.key === 'PageDown' ? 1 : -1) + paths.length) % paths.length];
      if (next && next !== activePath) send(msg('script-switch', { path: next }));
      break;
    }
    case 'Escape':
      e.preventDefault();
      // A marked fill range goes too (the docked editor's Esc).
      if (fillRangeMark) setFillRange(null);
      runSelectCommand('none');
      break;
    case 'z': case 'Z':
      if (ctrl) { e.preventDefault(); send(editOp(e.shiftKey ? OP_REDO : OP_UNDO)); }
      break;
    case 'y': case 'Y':
      if (ctrl) { e.preventDefault(); send(editOp(OP_REDO)); }
      break;
    case 'a': case 'A':
      if (ctrl) { e.preventDefault(); runSelectCommand('all'); }
      break;
    case 'i': case 'I':
      if (ctrl) { e.preventDefault(); send(editOp(OP_INVERT)); }
      break;
    case 'c': case 'C':
      if (ctrl) { e.preventDefault(); send(editOp(OP_COPY)); }
      break;
    case 'x': case 'X':
      if (ctrl) { e.preventDefault(); send(editOp(OP_CUT)); }
      break;
    case 'v': case 'V':
      if (ctrl) {
        e.preventDefault();
        send(editOp(e.shiftKey ? OP_PASTE_ORIGINAL : OP_PASTE, { at: Math.round(snapTime(player.currentTime * 1000)) }));
      } else if (!ctrl && !e.shiftKey) {
        // Bare V → toggle VAD track in main (no in-pop-out render yet).
        e.preventDefault();
        send({ type: 'request-vad-toggle' });
      }
      break;

    // Ctrl+1 / 2 / 3 (select a third) are handled above the switch, on the key.

    // N → New points only (the parent holds the created record and toasts).
    case 'n': case 'N':
      if (!ctrl && !e.shiftKey && !e.altKey) { e.preventDefault(); runSelectCommand('created'); }
      break;

    // P → Fill with pattern (the drawer opens in this window). A custom
    // position key on P wins: it is resolved above, before this switch.
    case 'p': case 'P':
      if (!ctrl && !e.shiftKey && !e.altKey) { e.preventDefault(); openPatternFill(); }
      break;

    case 'r': case 'R':
      if (!ctrl) {
        e.preventDefault();
        // Toggle recording mode in parent — SETTINGS echo flips the
        // REC indicator visibility on this side.
        if (e.shiftKey) openPopoutGamepadMenu();   // Shift+R: record with a gamepad (work list 2.6)
        else send(msg(SET_SETTING, { key: 'recordingMode', value: !recordingIndicator.hidden ? false : true }));
      }
      break;

    case 'b': case 'B':
      if (!ctrl && !e.shiftKey) {
        e.preventDefault();
        send(editOp(OP_ADD_BOOKMARK, { at: Math.round(snapTime(player.currentTime * 1000)) }));
      } else if (!ctrl && e.shiftKey) {
        // Shift+B → previous bookmark, Ctrl+B → next: the player's
        // direction (keyboard.js), now also the docked editor's (2026-11-04).
        e.preventDefault();
        jumpToBookmark(-1);
      } else if (ctrl && !e.shiftKey) {
        e.preventDefault();
        jumpToBookmark(1);
      }
      break;

    // T: the stroke behind an axis off / on (work list 2.3); the parent owns it.
    case 't': case 'T':
      if (!ctrl && !e.altKey) { e.preventDefault(); send(msg('reference-toggle')); }
      break;
    case 'w': case 'W':
      if (!ctrl) {
        e.preventDefault();
        // Shift+W → multi-band; bare W → single-band. Both forward to
        // parent (data-sync to pop-out is Tier-B work).
        send(e.shiftKey ? { type: 'request-multiband-toggle' } : msg(REQUEST_TOGGLE_WAVEFORM));
      }
      break;

    case '[':
      if (!ctrl) { e.preventDefault(); stepSpeed(-1); }
      break;
    case ']':
      if (!ctrl) { e.preventDefault(); stepSpeed(1); }
      break;

    case '?':
      if (!ctrl) {
        e.preventDefault();
        openHelp();
      }
      break;
    case 's': case 'S':
      // Ctrl+Shift+S: Save As (belgriffinite #439), done by the parent.
      if (ctrl) { e.preventDefault(); send(e.shiftKey ? msg('save-as') : msg(SAVE)); }
      break;
    case 'e': case 'E':
      if (!ctrl) { e.preventDefault(); send(editOp(OP_EQUALIZE)); }
      break;
    case 'End':
      if (!ctrl) { e.preventDefault(); send(editOp(OP_MOVE_SELECTED_TO, { time: snapTime(player.currentTime * 1000) })); }
      break;
    case 'q': case 'Q':
      if (!ctrl) { e.preventDefault(); send(editOp(OP_INSERT_ALTERNATING, { at: Math.round(snapTime(player.currentTime * 1000)) })); }
      break;
    case 'Home':
      if (!ctrl) { e.preventDefault(); send(editOp(OP_REPEAT_LAST_STROKE, { at: Math.round(snapTime(player.currentTime * 1000)) })); }
      break;
  }
});

// ===== Keyboard-helper functions ========================================
//
// Pop-out has its own EditableScript mirror so these can do local
// lookups without round-tripping to the parent. The resulting OP_*
// dispatches keep the parent as the single source of truth.

/** The ONE path for selection commands: the Select… list AND the keys
 *  (Ctrl+A, Ctrl+Alt+Left/Right, Ctrl+1/2/3, N, Esc) send the same thing.
 *  The parent applies it (editor-popout-dispatch.js) and sends the New
 *  points only and Every Nth toasts back here (TOAST). Every Nth point…
 *  opens this window's own dialog (FT-029); it opened in the main window. */
function runSelectCommand(command) {
  switch (command) {
    case 'all':            send(editOp(OP_SELECT_ALL)); break;
    case 'beforePlayhead': send(editOp(OP_SELECT_LEFT_OF, { time: player.currentTime * 1000 })); break;
    case 'afterPlayhead':  send(editOp(OP_SELECT_RIGHT_OF, { time: player.currentTime * 1000 })); break;
    case 'topThird':       send(editOp(OP_SELECT_BY_POSITION, { minPos: 67, maxPos: 100 })); break;
    case 'middleThird':    send(editOp(OP_SELECT_BY_POSITION, { minPos: 34, maxPos: 66 })); break;
    case 'bottomThird':    send(editOp(OP_SELECT_BY_POSITION, { minPos: 0, maxPos: 33 })); break;
    case 'everyNth':       openEveryNthDialog(); break;
    case 'created':        send(editOp(OP_SELECT_CREATED)); break;
    case 'none':           send(editOp(OP_CLEAR_SELECTION)); break;
  }
}

// Every Nth point… (FT-029): the docked dialog (_openEveryNthModal) in this
// window. Every (2) and Start at point (1), remembered for this window's
// session; the live lines come from the PURE countEveryNth on this window's
// mirror, so the selection never changes while it is open; Select sends the
// values (OP_SELECT_EVERY_NTH) and the parent recomputes from its LIVE
// selection and toasts the real result here. The docked dialog's words
// (editor.everyNth*, common.cancel); a language switch while it is open
// relabels it in place (retranslateWindow), keeping what was typed.
let everyNthLast = { n: 2, start: 1 };
let relabelEveryNth = null; // set while the dialog is open

async function openEveryNthDialog() {
  const last = everyNthLast;
  const result = await Modal.open({
    title: t('editor.everyNthTitle'),
    onRender(body, close) {
      // Words go in as text (relabel below), never into this markup.
      body.innerHTML = `
        <div class="modal-form">
          <label class="modal-label"><span id="nth-every-label"></span><input type="number" id="nth-every" min="2" step="1" value="${Number(last.n)}" class="modal-input"></label>
          <label class="modal-label"><span id="nth-start-label"></span><input type="number" id="nth-start" min="1" step="1" value="${Number(last.start)}" class="modal-input"></label>
          <div class="modal-hint" id="nth-scope"></div>
          <div class="modal-hint" id="nth-result" aria-live="polite"></div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn--secondary" id="nth-cancel"></button>
          <button class="modal-btn modal-btn--primary" id="nth-ok"></button>
        </div>`;
      const everyInput = body.querySelector('#nth-every');
      const startInput = body.querySelector('#nth-start');
      const scopeEl = body.querySelector('#nth-scope');
      const resultEl = body.querySelector('#nth-result');
      const update = () => {
        const r = editable.countEveryNth(everyInput.value, startInput.value);
        scopeEl.textContent = editable.selectedIndices.size > 0
          ? t('editor.everyNthScopeSelected', { count: r.scope })
          : t('editor.everyNthScopeAll', { count: r.scope });
        resultEl.textContent = r.count > 0
          ? t('editor.everyNthResult', { count: r.count })
          : t('editor.everyNthTooFew');
      };
      relabelEveryNth = () => {
        const title = t('editor.everyNthTitle');
        const panel = body.parentElement;
        const titleEl = panel?.querySelector('.modal-title');
        if (titleEl) titleEl.textContent = title;
        // Modal's own X words (modal.js), in the new language.
        const x = panel?.querySelector('.modal-close-btn');
        if (x) { x.setAttribute('aria-label', t('modal.closeAria', { title })); x.title = t('common.close'); }
        body.querySelector('#nth-every-label').textContent = t('editor.everyNthEvery');
        body.querySelector('#nth-start-label').textContent = t('editor.everyNthStart');
        body.querySelector('#nth-cancel').textContent = t('common.cancel');
        body.querySelector('#nth-ok').textContent = t('editor.everyNthSelect');
        update();
      };
      relabelEveryNth();
      everyInput.addEventListener('input', update);
      startInput.addEventListener('input', update);
      body.querySelector('#nth-cancel').addEventListener('click', () => close(null));
      body.querySelector('#nth-ok').addEventListener('click', () => {
        close({ n: everyInput.value, start: startInput.value });
      });
    },
  });
  relabelEveryNth = null;
  if (!result) return;
  const n = parseInt(result.n, 10);
  const start = parseInt(result.start, 10);
  everyNthLast = {
    n: Number.isNaN(n) ? last.n : Math.max(2, n),
    start: Number.isNaN(start) ? last.start : Math.max(1, start),
  };
  // Number(), not parseInt: the parent clamps exactly what the docked
  // dialog's Select hands it ('2.6' rounds to 3, '' falls back to 2).
  send(editOp(OP_SELECT_EVERY_NTH, { n: Number(result.n), start: Number(result.start) }));
}

/** Up/Down arrow: select previous / next action and seek to it.
 *  Mirrors `_selectAdjacentAction` in the docked editor. */
function selectAdjacentAction(direction) {
  const actions = editable.actions;
  if (actions.length === 0) return;

  let currentIdx = -1;
  const sel = editable.selectedIndices;
  if (sel.size === 1) {
    currentIdx = [...sel][0];
  } else if (sel.size > 1) {
    const sorted = [...sel].sort((a, b) => a - b);
    currentIdx = direction > 0 ? sorted[sorted.length - 1] : sorted[0];
  } else {
    // No selection — find nearest action to playhead time
    const timeMs = player.currentTime * 1000;
    let bestDist = Infinity;
    for (let i = 0; i < actions.length; i++) {
      const dist = Math.abs(actions[i].at - timeMs);
      if (dist < bestDist) { bestDist = dist; currentIdx = i; }
    }
  }

  const nextIdx = Math.max(0, Math.min(actions.length - 1, currentIdx + direction));
  if (nextIdx === currentIdx && sel.size > 0) return;
  send(editOp(OP_SELECT, { indices: [nextIdx] }));
  send(msg('video-seek', { time: actions[nextIdx].at / 1000 }));
}

/** Shift+B / Ctrl+B — jump to next/previous bookmark. Reads the
 *  pop-out's mirror of bookmarks (broadcast via ACTIONS_CHANGED). */
function jumpToBookmark(direction) {
  const bookmarks = editable.getBookmarks?.() || [];
  if (bookmarks.length === 0) return;
  const cursorMs = player.currentTime * 1000;
  let target = null;
  for (const bm of bookmarks) {
    if (direction > 0 && bm.at > cursorMs && (target === null || bm.at < target.at)) target = bm;
    else if (direction < 0 && bm.at < cursorMs && (target === null || bm.at > target.at)) target = bm;
  }
  if (!target) return;
  send(msg('video-seek', { time: target.at / 1000 }));
}

/** [ / ] — step playback speed by one preset. Reads the speed dropdown
 *  and dispatches VIDEO_SET_RATE. */
function stepSpeed(direction) {
  const opts = Array.from(speedSelect.options);
  if (opts.length === 0) return;
  const current = speedSelect.selectedIndex;
  const next = Math.max(0, Math.min(opts.length - 1, current + direction));
  if (next === current) return;
  speedSelect.selectedIndex = next;
  send(msg(VIDEO_SET_RATE, { rate: parseFloat(speedSelect.value) }));
}

/** ? — the docked editor's shortcut list (_openKeyboardHelp), same title. */
function openHelp() {
  openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups({ customPositionKeys }));
}

// ===== Language (FT-103) ==================================================

let _i18nReady = false;

/** The window's name in the taskbar and Alt+Tab (the page title wins over
 *  the BrowserWindow's), in the user's language. */
function setWindowTitle() {
  document.title = `FunSync — ${t('editor.popoutWindowTitle')}`;
}

/**
 * Everything this window writes from state, in the new language. setLocale()
 * walks the stamped keys (the toolbar, the title strip) before it emits
 * language:changed, so this runs after that walk and has the last word.
 */
function retranslateWindow() {
  if (!_i18nReady) return;
  setWindowTitle();
  if (hydrated) updateStatus(); // blank until INITIAL_STATE, as before
  relabelEveryNth?.();
  // An open shortcut list was built in the old language and has no keys for
  // the walk: build it again (as FT-065 does in the player window).
  const help = document.querySelector('.modal-overlay .editor-help');
  if (help) {
    help.closest('.modal-overlay')?.querySelector('.modal-close-btn')?.click();
    openHelp();
  }
}

// ===== Inbound message routing ============================================

window.funsync.onEditorPopoutEvent((event) => {
  if (event.type !== 'message') return;
  const m = event.payload;
  if (!m || !m.type) return;

  switch (m.type) {
    case THEME: {
      applyTheme(m.theme);
      applyStyle(m.uiStyle); applyPopoutSeason(m.season);
      break;
    }
    case INITIAL_STATE: {
      if (m.theme) applyTheme(m.theme);
      applyStyle(m.uiStyle); applyPopoutSeason(m.season);
      // The main window's language (FT-103). The window is labelled in
      // English by now; setLocale walks the keys and retranslateWindow()
      // redoes the status line, once the bundle is in.
      if (typeof m.locale === 'string' && m.locale) applyLocale(m.locale);
      activePath = m.activePath || null;
      updateScriptSelect(m.scripts || [], activePath);
      applySaveKey(m.saveKey);
      // The stroke behind an axis (work list 2.3): the parent decides.
      graph.setReference?.(m.reference || null);
      applyAxisTools(m);
      if (Array.isArray(m.actions)) {
        editable.loadFromData({ version: '1.0', actions: m.actions });
      }
      if (Array.isArray(m.selectedIndices)) {
        editable._selectedIndices = new Set(m.selectedIndices);
      }
      if (Array.isArray(m.bookmarks)) {
        editable._bookmarks = m.bookmarks.map(b => ({ ...b }));
      }
      // Settings — snap / spline / recording / rate. Mirror into the
      // pop-out's UI so the checkboxes and indicator reflect the
      // parent's truth.
      if (typeof m.snapToFrame === 'boolean') {
        popoutSnapToFrame = m.snapToFrame;
        snapCheck.checked = m.snapToFrame;
      }
      if (typeof m.splineMode === 'boolean') {
        splineCheck.checked = m.splineMode;
        graph._splineMode = m.splineMode;
      }
      if (typeof m.recordingMode === 'boolean') {
        recordingIndicator.hidden = !m.recordingMode;
        btnRecord.setAttribute('aria-pressed', String(m.recordingMode));
        btnRecord.classList.toggle('editor__btn--active', m.recordingMode);
      }
      if (typeof m.gamepadRecording === 'boolean') {
        gamepadRecording = m.gamepadRecording;
        btnGamepad.setAttribute('aria-pressed', String(gamepadRecording));
        btnGamepad.classList.toggle('editor__btn--active', gamepadRecording);
      }
      if (m.gamepadMapping && typeof m.gamepadMapping === 'object') gamepadMapping = { ...DEFAULT_GAMEPAD_MAPPING, ...m.gamepadMapping };
      applyFrameGrid(m);
      if (Number.isInteger(m.fastStepFrames) && m.fastStepFrames > 0) {
        popoutFastStepFrames = m.fastStepFrames;
      }
      if (Array.isArray(m.customPositionKeys)) {
        customPositionKeyMap = buildResolverMap(m.customPositionKeys);
        customPositionKeys = m.customPositionKeys;
      }
      if (m.patternFill !== undefined) patternFillOptions = m.patternFill;
      if (typeof m.videoRate === 'number') {
        speedSelect.value = String(m.videoRate);
      }
      player.applyMeta({
        src: m.videoSrc || '',
        duration: m.videoDuration || 0,
        rate: m.videoRate || 1,
      });
      player.applyTimeTick({ time: m.videoTime || 0, paused: m.videoPaused !== false });
      graph.setVideoDuration?.((m.videoDuration || 0) * 1000);
      graph.setCursorTime?.((m.videoTime || 0) * 1000);
      // Match the docked editor's initial-zoom heuristic
      // (script-editor.js::show). Scripts with >100 actions get a
      // 10-second window around the playhead via `smartZoom` so the
      // first draw doesn't paint thousands of dots — that was the lag
      // pattern users hit on long scripts. Small scripts fit-all.
      if (editable.actionCount > 100) {
        const cursorMs = (m.videoTime || 0) * 1000;
        graph.smartZoom?.(cursorMs);
      } else {
        graph.fitAll?.();
      }
      parentDirty = m.dirty === true;
      updateStatus();
      hydrated = true;
      resizeCanvas();
      // Opened on a playing video: follow it from the start, as show() does
      // in the docked editor (the 'playing' above fired before hydration).
      if (!player.paused) graph.startAnimation();
      else graph.stopAnimation();
      break;
    }

    case SETTINGS: {
      // Parent broadcasts on snap / spline / recording / rate change
      // (docked toggle or pop-out echo). Mirror into the pop-out's UI.
      if (typeof m.snapToFrame === 'boolean') {
        popoutSnapToFrame = m.snapToFrame;
        snapCheck.checked = m.snapToFrame;
      }
      if (typeof m.splineMode === 'boolean') {
        splineCheck.checked = m.splineMode;
        if (graph._splineMode !== m.splineMode) {
          graph._splineMode = m.splineMode;
          if (hydrated) graph.draw();
        }
      }
      if (typeof m.recordingMode === 'boolean') {
        recordingIndicator.hidden = !m.recordingMode;
        btnRecord.setAttribute('aria-pressed', String(m.recordingMode));
        btnRecord.classList.toggle('editor__btn--active', m.recordingMode);
      }
      if (typeof m.gamepadRecording === 'boolean') {
        gamepadRecording = m.gamepadRecording;
        btnGamepad.setAttribute('aria-pressed', String(gamepadRecording));
        btnGamepad.classList.toggle('editor__btn--active', gamepadRecording);
      }
      if (m.gamepadMapping && typeof m.gamepadMapping === 'object') gamepadMapping = { ...DEFAULT_GAMEPAD_MAPPING, ...m.gamepadMapping };
      if (typeof m.playbackRate === 'number' && speedSelect.value !== String(m.playbackRate)) {
        speedSelect.value = String(m.playbackRate);
      }
      if (Array.isArray(m.customPositionKeys)) {
        customPositionKeyMap = buildResolverMap(m.customPositionKeys);
        customPositionKeys = m.customPositionKeys;
      }
      if (Number.isInteger(m.fastStepFrames) && m.fastStepFrames > 0) {
        popoutFastStepFrames = m.fastStepFrames;
      }
      applyFrameGrid(m);
      if (m.patternFill !== undefined) patternFillOptions = m.patternFill;
      break;
    }
    case TOAST: {
      // A toast for a command this window sent (FT-029), translated by the
      // parent. It used to show in the main window only.
      if (typeof m.text !== 'string' || !m.text) break;
      const level = m.level === 'warn' || m.level === 'error' ? m.level : 'info';
      const handle = typeof m.duration === 'number'
        ? showToast(m.text, level, m.duration)
        : showToast(m.text, level);
      // toast.js labels its X in this window's language now (FT-103); the
      // parent's label, when sent, is the same words.
      const x = handle?.el?.querySelector?.('.toast__close');
      if (x && typeof m.dismissLabel === 'string' && m.dismissLabel) x.setAttribute('aria-label', m.dismissLabel);
      break;
    }
    case LOCALE: {
      // A language switch in the main window (FT-103).
      if (typeof m.locale === 'string' && m.locale) applyLocale(m.locale);
      break;
    }
    case TIME_TICK: {
      player.applyTimeTick(m);
      if (hydrated) {
        // Recentres the view while playing (the animation runs then, D-01).
        graph.setCursorTime?.(m.time * 1000);
        // The animation loop draws while playing, as in the docked editor.
        if (!graph._animating) graph.draw();
        updateScrubber();
      }
      break;
    }
    case VIDEO_META: {
      player.applyMeta(m);
      if (typeof m.duration === 'number') graph.setVideoDuration?.(m.duration * 1000);
      if (hydrated) { graph.draw(); updateScrubber(); }
      break;
    }
    case ACTIONS_CHANGED: {
      if (m.path && m.path !== activePath) {
        activePath = m.path;
        // Another script in the parent: a preview of the old one goes.
        fillDrawer?.close('cancel');
      }
      if (Array.isArray(m.actions)) {
        editable.loadFromData({ version: '1.0', actions: m.actions });
      }
      if (Array.isArray(m.selectedIndices)) {
        editable._selectedIndices = new Set(m.selectedIndices);
      }
      if (Array.isArray(m.bookmarks)) {
        editable._bookmarks = m.bookmarks.map(b => ({ ...b }));
      }
      if (typeof m.dirty === 'boolean') parentDirty = m.dirty;
      if (m.history && Array.isArray(m.history.undo)) lastHistory = m.history;
      // A marked fill range holds once the band's selection is back, and ends
      // with any other selection or an edit there (its key).
      followFillRange();
      updateStatus();
      if (hydrated) graph.draw();
      // An open drawer previews the new script / selection (next frame).
      fillDrawer?.refresh();
      break;
    }
    case SCRIPTS_CHANGED: {
      // The parent sends this BEFORE the ACTIONS_CHANGED of a switch, so the
      // path check there never saw the change: close here (review-2 minor 3).
      if (m.activePath && m.activePath !== activePath) fillDrawer?.close('cancel');
      if (m.activePath) activePath = m.activePath;
      updateScriptSelect(m.scripts || [], activePath);
      // What Save writes, as the docked editor's tooltip says it.
      applySaveKey(m.saveKey);
      if (m.reference !== undefined) { graph.setReference?.(m.reference || null); graph.draw(); }
      applyAxisTools(m);
      break;
    }
    case 'lanes': {
      renderLanes(m.lanes);
      break;
    }
    case FILL_RESULT: {
      // The parent's answer to this window's Fill with pattern Apply.
      fillWaiters.get(m.requestId)?.(m.ok === true);
      break;
    }
    default:
      console.debug('[editor-popout] unknown message type:', m.type, m);
  }
});

/**
 * The status line: point count, selection, and the unsaved marker the docked
 * editor shows ("*", R4 fix-up, real-app verifier 2, also in v0.9.2: the
 * pop-out never showed one, so its edits looked saved). The parent owns the
 * script and its saved state, and sends `dirty` with every ACTIONS_CHANGED.
 */
function updateStatus() {
  // No words before a bundle is in; labelAndReady() writes it then.
  if (!_i18nReady) return;
  // The docked editor's line and words (_updateStatus): "44 actions
  // (3 selected) *". It read "44 actions · 3 selected" in English only.
  const count = editable.actions.length;
  const selected = editable.selectedIndices.size;
  let text = selected > 0
    ? t('editor.statusSelected', { count, selected })
    : t('editor.status', { count });
  // The docked editor's selection statistics (work list 4.1).
  const stats = selected > 1 ? selectionStatsText(editable.actions, editable.selectedIndices, t) : '';
  if (stats) text += ` · ${stats}`;
  if (parentDirty) text += ' *';
  statusEl.textContent = text;
  statusEl.className = parentDirty ? 'editor__status editor__status--dirty' : 'editor__status';
}

/** New axis / Export / Stacked, as the docked editor shows them (multi-axis editing). */
function applyAxisTools(m) {
  axisTools = m.axisTools === true;
  axesPresent = new Set(Array.isArray(m.axesPresent) ? m.axesPresent : []);
  btnNewAxis.hidden = !axisTools;
  btnExportAxes.hidden = !axisTools;
  btnStacked.hidden = (m.scripts || []).length < 2;
  if (btnStacked.hidden && lanesOn) setLanes(false);
}

function updateScriptSelect(scripts, active) {
  const show = scripts.length > 1;
  scriptSelect.hidden = !show;
  if (!show) return;
  scriptSelect.innerHTML = '';
  for (const s of scripts) {
    const opt = document.createElement('option');
    opt.value = s.path;
    opt.textContent = s.label;
    scriptSelect.appendChild(opt);
  }
  if (active) scriptSelect.value = active;
}

/** Switch to the main window's language; the walk and language:changed
 *  (retranslateWindow) follow once its bundle is in. */
function applyLocale(locale) {
  setLocale(locale).catch((err) => console.warn('[editor-popout] setLocale failed:', err));
}

// Ready signal — parent replies with INITIAL_STATE. Only once this window
// has words: English first (its INITIAL_STATE then carries the user's
// language), so nothing is ever drawn from a raw key, and the two setLocale
// calls never race (player-popout.js does the same).
eventBus.on('language:changed', retranslateWindow);
function labelAndReady() {
  _i18nReady = true;
  translatePage(document);
  retranslateWindow();
  send(msg(READY));
}
initI18n({ savedLocale: 'en' }).then(labelAndReady, (err) => {
  console.warn('[editor-popout] initI18n failed:', err);
  labelAndReady();
});
