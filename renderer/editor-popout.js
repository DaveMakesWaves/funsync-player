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

import { EditableScript } from './js/editable-script.js';
import { ActionGraph } from './js/action-graph.js';
import { PopoutVideoPlayerStub } from './js/editor-popout-video-stub.js';
import {
  icon, Undo2, Redo2, Save, ZoomIn, ZoomOut, Magnet, Trash2,
  FlipVertical2, Spline, Scissors, AudioWaveform, Music,
  WandSparkles, BookmarkPlus, FileText, Rows3,
} from './js/icons.js';
import { openKeyboardHelp, getEditorShortcutGroups } from './js/keyboard-help.js';
import {
  TIME_TICK, VIDEO_META, INITIAL_STATE, ACTIONS_CHANGED, SCRIPTS_CHANGED, THEME, SETTINGS,
  READY, msg, editOp,
  OP_INSERT, OP_DELETE, OP_UPDATE, OP_SELECT, OP_SELECT_ALL, OP_CLEAR_SELECTION, OP_INVERT,
  OP_UNDO, OP_REDO, OP_CUT, OP_COPY, OP_PASTE, OP_PASTE_ORIGINAL,
  OP_EQUALIZE, OP_SELECT_LEFT_OF, OP_SELECT_RIGHT_OF,
  OP_INSERT_ALTERNATING, OP_REPEAT_LAST_STROKE, OP_MOVE_SELECTED_TO,
  OP_BEGIN_BATCH, OP_END_BATCH,
  OP_SELECT_BY_POSITION, OP_APPLY_MODIFIER, OP_MOVE_ACTIONS,
  OP_ADD_BOOKMARK,
  SAVE, VIDEO_SET_RATE, SET_SETTING,
  REQUEST_METADATA, REQUEST_FILL_GAPS, REQUEST_BEATS, REQUEST_SIMPLIFY,
  REQUEST_REMAP_RANGE, REQUEST_OFFSET_TIME, REQUEST_REMOVE_PAUSES,
  REQUEST_RANGE_EXTEND, REQUEST_GENERATE_PATTERN, REQUEST_EXPORT_HEATMAP,
  REQUEST_TOGGLE_WAVEFORM,
} from './js/editor-popout-protocol.js';

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
}
function applyStyle(s) {
  // No-op on undefined so a theme-only message can't reset the style.
  if (s === 'classic' || s === 'modern') document.documentElement.dataset.style = s;
}

host.classList.add('script-editor', 'script-editor--popout-window');

// ===== Toolbar ============================================================

const send = (payload) => window.funsync.editorPopoutRelay('to-parent', payload);

const toolbar = document.createElement('div');
toolbar.className = 'editor__toolbar';
toolbar.setAttribute('role', 'toolbar');
toolbar.setAttribute('aria-label', 'Script editor toolbar');

function makeBtn(iconNode, titleText, onClick) {
  const btn = document.createElement('button');
  btn.className = 'editor__btn';
  btn.title = titleText;
  btn.setAttribute('aria-label', titleText);
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
scriptSelect.title = 'Switch axis';
scriptSelect.hidden = true;
scriptSelect.addEventListener('change', () => {
  send(msg('script-switch', { path: scriptSelect.value }));
});

const btnUndo   = makeBtn(Undo2,       'Undo (Ctrl+Z)',           () => send(editOp(OP_UNDO)));
const btnRedo   = makeBtn(Redo2,       'Redo (Ctrl+Y)',           () => send(editOp(OP_REDO)));
const btnDelete = makeBtn(Trash2,      'Delete selected (Del)',   () => send(editOp(OP_DELETE)));
const btnCut    = makeBtn(Scissors,    'Cut (Ctrl+X)',            () => send(editOp(OP_CUT)));
const btnInvert = makeBtn(FlipVertical2, 'Invert (Ctrl+I)',       () => send(editOp(OP_INVERT)));
const btnSimplify = makeBtn(Spline,    'Simplify selected',       () => send(msg(REQUEST_SIMPLIFY)));
const btnSave   = makeBtn(Save,        'Save (Ctrl+S)',           () => send(msg(SAVE)));

// Metadata / Bookmark / Fill Gaps / Beats — these open modals that
// live in the docked editor. For Tier-A parity we surface the trigger
// here; the modal opens in the parent window (visible to the user
// since they're presumably looking at both monitors). Bookmark add is
// an immediate op — no modal — so it dispatches directly.
const btnMetadata = makeBtn(FileText,    'Edit Metadata',            () => send(msg(REQUEST_METADATA)));
const btnBookmark = makeBtn(BookmarkPlus, 'Add bookmark at playhead (B)', () =>
  send(editOp(OP_ADD_BOOKMARK, { at: Math.round(player.currentTime * 1000) })));
const btnFillGaps = makeBtn(Rows3,       'Fill gaps',                () => send(msg(REQUEST_FILL_GAPS)));
const btnBeats    = makeBtn(Music,       'Generate from beats',      () => send(msg(REQUEST_BEATS)));
// Zoom buttons + `+`/`-` keys mirror the docked editor exactly:
// zoom around the playhead (or viewport centre when playhead is 0),
// 1.5× per click. Same factor as the docked toolbar buttons.
function zoomKey(factor) {
  graph.markInteraction?.();
  const center = graph._cursorMs || (graph.viewStartMs + graph.viewDurationMs / 2);
  graph.zoomAt?.(center, factor);
  updateScrubber();
}
const btnZoomIn = makeBtn(ZoomIn,      'Zoom in (+)',             () => zoomKey(1 / 1.5));
const btnZoomOut = makeBtn(ZoomOut,    'Zoom out (-)',            () => zoomKey(1.5));
const btnFitAll = makeBtn(Magnet,      'Fit all',                 () => { graph.fitAll?.(); graph.draw(); updateScrubber(); });

// Modify dropdown — same option set as the docked editor. Param-less
// modifiers (halfSpeed / doubleSpeed / reverse) dispatch directly as
// OP_APPLY_MODIFIER. Modal-bearing ones (remap, offset, removePauses,
// rangeExtend, generatePattern, exportHeatmap) forward to the parent
// which already owns those modal flows.
const modifySelect = document.createElement('select');
modifySelect.className = 'editor__speed-select';
modifySelect.title = 'Modify script';
modifySelect.setAttribute('aria-label', 'Modify script');
[
  ['', 'Modify…', true],
  ['halfSpeed', 'Half Speed', false],
  ['doubleSpeed', 'Double Speed', false],
  ['reverse', 'Reverse', false],
  ['remapRange', 'Remap Range…', false],
  ['offsetTime', 'Offset Time…', false],
  ['removePauses', 'Remove Pauses…', false],
  ['rangeExtend', 'Range Extend/Compress…', false],
  ['generatePattern', 'Generate Pattern…', false],
  ['exportHeatmap', 'Export Heatmap PNG…', false],
].forEach(([value, label, disabled]) => {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  opt.disabled = !!disabled;
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
    case 'remapRange':       send(msg(REQUEST_REMAP_RANGE)); break;
    case 'offsetTime':       send(msg(REQUEST_OFFSET_TIME)); break;
    case 'removePauses':     send(msg(REQUEST_REMOVE_PAUSES)); break;
    case 'rangeExtend':      send(msg(REQUEST_RANGE_EXTEND)); break;
    case 'generatePattern':  send(msg(REQUEST_GENERATE_PATTERN)); break;
    case 'exportHeatmap':    send(msg(REQUEST_EXPORT_HEATMAP)); break;
  }
});

// Waveform toggle — forwards to parent (no in-pop-out render yet;
// waveform data sync is Tier-B work). Marked as a toggle button so
// future state-broadcast can flip aria-pressed via _setToggleState.
const btnWaveform = makeBtn(AudioWaveform, 'Toggle waveform in main window (W)', () =>
  send(msg(REQUEST_TOGGLE_WAVEFORM))
);
btnWaveform.setAttribute('aria-pressed', 'false');

// Speed dropdown — mirrors the docked editor exactly. Same preset
// list (PLAYBACK_RATE_PRESETS in video-player.js); changing fires
// VIDEO_SET_RATE so the parent's videoPlayer.setPlaybackRate is the
// single source of truth.
const speedLabel = document.createElement('span');
speedLabel.className = 'editor__speed-label';
speedLabel.textContent = 'Speed:';
const speedSelect = document.createElement('select');
speedSelect.className = 'editor__speed-select';
for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
  const opt = document.createElement('option');
  opt.value = String(rate);
  opt.textContent = `${rate}x`;
  if (rate === 1) opt.selected = true;
  speedSelect.appendChild(opt);
}
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
snapText.textContent = 'Snap';
snapLabel.appendChild(snapText);
snapLabel.title = 'Snap timestamps to 30fps frame grid';

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
splineText.textContent = 'Curves';
splineLabel.appendChild(splineText);
splineLabel.title = 'Render Hermite splines between actions (off = linear segments)';

// Recording REC indicator — hidden when not recording, blinking when on.
// Matches the docked editor's `editor__recording-indicator`.
const recordingIndicator = document.createElement('span');
recordingIndicator.className = 'editor__recording-indicator';
recordingIndicator.textContent = 'REC';
recordingIndicator.hidden = true;
recordingIndicator.style.cssText = 'color:#ff4444;font-weight:700;font-size:11px;margin-left:6px;animation:blink 1s step-end infinite';

const statusEl = makeLabel('', 'editor__status');

// Local snap-to-frame state — mirrored from the parent via SETTINGS.
// Used to snap pop-out gesture timestamps before sending them.
let popoutSnapToFrame = true;
let popoutFrameMs = 1000 / 30;
function snapTime(timeMs) {
  if (!popoutSnapToFrame) return timeMs;
  return Math.round(timeMs / popoutFrameMs) * popoutFrameMs;
}

// Dock-back is the pop-out's `Pop out` button — sits in the same
// location (after Save, before autosave/snap/curves). Uses the same
// `editor__btn--active` accent treatment since the docked editor's
// equivalent does the same on "popout open".
// Dock button — text label rather than icon. Visual sizing handled in
// editor.css under `.script-editor--popout-window .editor__btn[aria-label^="Dock"]`
// so all inline style stays out of the JS.
const btnDock = document.createElement('button');
btnDock.className = 'editor__btn editor__btn--active';
btnDock.title = 'Dock editor back to main window';
btnDock.setAttribute('aria-label', 'Dock editor back to main window');
btnDock.textContent = 'Dock';
btnDock.addEventListener('click', () => window.funsync.editorPopoutClose());

toolbar.append(
  scriptSelect, makeSep(true),
  btnUndo, btnRedo, makeSep(),
  btnDelete, btnCut, btnInvert, btnSimplify, makeSep(),
  modifySelect, makeSep(),
  btnMetadata, btnBookmark, btnFillGaps, btnWaveform, btnBeats, makeSep(true),
  btnZoomIn, btnZoomOut, btnFitAll, makeSep(true),
  speedLabel, speedSelect, makeSep(true),
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

function resizeCanvas() {
  graph.resize();
  if (hydrated) {
    graph.draw();
    updateScrubber();
  }
}
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(resizeCanvas);

function updateScrubber() {
  const dur = player.duration * 1000;
  if (!dur) return;
  const startPct = Math.max(0, Math.min(100, (graph.viewStartMs / dur) * 100));
  const endPct = Math.max(0, Math.min(100, (graph.viewEndMs / dur) * 100));
  scrubberViewport.style.left = startPct + '%';
  scrubberViewport.style.width = Math.max(2, endPct - startPct) + '%';
  const cursorPct = Math.max(0, Math.min(100, (player.currentTime * 1000 / dur) * 100));
  scrubberCursor.style.left = cursorPct + '%';
}

// ===== Mouse interactions ================================================
// (click-select, double-click-delete, alt-click-insert, shift-drag-move,
//  rubber-band selection — kept from the prior pass, design unchanged)

const DRAG_THROTTLE_MS = 33;
let dragState = null;

canvas.addEventListener('click', (e) => {
  if (!hydrated) return;
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
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hitIdx = graph.hitTestAction?.(x, y) ?? -1;

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

  if (e.shiftKey && hitIdx >= 0) {
    const action = editable.actions[hitIdx];
    if (!action) return;
    const sel = new Set(editable.selectedIndices);
    if (!sel.has(hitIdx)) {
      sel.clear();
      sel.add(hitIdx);
      send(editOp(OP_SELECT, { indices: [hitIdx] }));
    }
    dragState = {
      mode: 'move',
      indices: [...sel],
      anchorMs: action.at,
      anchorPos: action.pos,
      originals: [...sel].map(i => ({ idx: i, at: editable.actions[i].at, pos: editable.actions[i].pos })),
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
    const newTimeMs = graph.xToTime?.(x);
    const newPos = graph.yToPos?.(y);
    if (typeof newTimeMs !== 'number' || typeof newPos !== 'number') return;
    const deltaT = newTimeMs - dragState.anchorMs;
    const deltaP = newPos - dragState.anchorPos;
    for (const o of dragState.originals) {
      send(editOp(OP_UPDATE, {
        idx: o.idx,
        fields: {
          at: Math.max(0, Math.round(o.at + deltaT)),
          pos: Math.max(0, Math.min(100, Math.round(o.pos + deltaP))),
        },
      }));
    }
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
function redrawRubberBand() {
  if (!dragState || dragState.mode !== 'rubber') return;
  graph.draw();
  const ctx = canvas.getContext('2d');
  const r = normaliseRect(dragState);
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(233, 69, 96, 0.15)';
  ctx.strokeStyle = 'rgba(233, 69, 96, 0.8)';
  ctx.lineWidth = 1;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}
function clearRubberBand() {
  if (hydrated) graph.draw();
}

// ===== Keyboard handler ===================================================
//
// Window-level — works whether canvas or toolbar is focused. Numpad
// map matches the parent's flipped scheme (10s, not 11s).

const NUMPAD_POS = {
  Digit0: 0, Digit1: 10, Digit2: 20, Digit3: 30, Digit4: 40,
  Digit5: 50, Digit6: 60, Digit7: 70, Digit8: 80, Digit9: 90,
  Numpad0: 0, Numpad1: 10, Numpad2: 20, Numpad3: 30, Numpad4: 40,
  Numpad5: 50, Numpad6: 60, Numpad7: 70, Numpad8: 80, Numpad9: 90,
};

window.addEventListener('keydown', (e) => {
  if (!hydrated) return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (e.code in NUMPAD_POS) {
    e.preventDefault();
    send(editOp(OP_INSERT, {
      at: Math.round(snapTime(player.currentTime * 1000)),
      pos: NUMPAD_POS[e.code],
    }));
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      if (ctrl && e.altKey) {
        send(editOp(OP_SELECT_LEFT_OF, { time: player.currentTime * 1000 }));
      } else if (e.shiftKey && editable.selectedIndices.size > 0) {
        // Shift+Left → move selected by ±frame; Ctrl+Shift+Left → ±N frames
        const frames = ctrl ? 6 : 1; // fast-step matches docked editor default
        send(editOp(OP_MOVE_ACTIONS, { deltaAt: -frames * popoutFrameMs }));
      } else if (ctrl) {
        player.stepFrames(-6);
      } else {
        player.stepFrame(-1);
      }
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (ctrl && e.altKey) {
        send(editOp(OP_SELECT_RIGHT_OF, { time: player.currentTime * 1000 }));
      } else if (e.shiftKey && editable.selectedIndices.size > 0) {
        const frames = ctrl ? 6 : 1;
        send(editOp(OP_MOVE_ACTIONS, { deltaAt: frames * popoutFrameMs }));
      } else if (ctrl) {
        player.stepFrames(6);
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
        // Plain Up → select previous action (and seek video). Local
        // lookup against the pop-out's mirror of actions, then dispatch.
        selectAdjacentAction(-1);
      }
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (e.shiftKey && editable.selectedIndices.size > 0) {
        send(editOp(OP_MOVE_ACTIONS, { deltaPos: ctrl ? -1 : -5 }));
      } else {
        selectAdjacentAction(1);
      }
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
      send(editOp(OP_DELETE));
      break;
    case 'Escape':
      e.preventDefault();
      send(editOp(OP_CLEAR_SELECTION));
      break;
    case 'z': case 'Z':
      if (ctrl) { e.preventDefault(); send(editOp(e.shiftKey ? OP_REDO : OP_UNDO)); }
      break;
    case 'y': case 'Y':
      if (ctrl) { e.preventDefault(); send(editOp(OP_REDO)); }
      break;
    case 'a': case 'A':
      if (ctrl) { e.preventDefault(); send(editOp(OP_SELECT_ALL)); }
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

    // Ctrl+1 / 2 / 3 → select by position third (top / mid / bottom)
    case '1':
      if (ctrl) { e.preventDefault(); send(editOp(OP_SELECT_BY_POSITION, { minPos: 67, maxPos: 100 })); }
      break;
    case '2':
      if (ctrl) { e.preventDefault(); send(editOp(OP_SELECT_BY_POSITION, { minPos: 34, maxPos: 66 })); }
      break;
    case '3':
      if (ctrl) { e.preventDefault(); send(editOp(OP_SELECT_BY_POSITION, { minPos: 0, maxPos: 33 })); }
      break;

    case 'r': case 'R':
      if (!ctrl) {
        e.preventDefault();
        // Toggle recording mode in parent — SETTINGS echo flips the
        // REC indicator visibility on this side.
        send(msg(SET_SETTING, { key: 'recordingMode', value: !recordingIndicator.hidden ? false : true }));
      }
      break;

    case 'b': case 'B':
      if (!ctrl && !e.shiftKey) {
        e.preventDefault();
        send(editOp(OP_ADD_BOOKMARK, { at: Math.round(snapTime(player.currentTime * 1000)) }));
      } else if (!ctrl && e.shiftKey) {
        // Shift+B → next bookmark
        e.preventDefault();
        jumpToBookmark(1);
      } else if (ctrl && !e.shiftKey) {
        // Ctrl+B → previous bookmark
        e.preventDefault();
        jumpToBookmark(-1);
      }
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
        openKeyboardHelp('Script Editor — Shortcuts', getEditorShortcutGroups());
      }
      break;
    case 's': case 'S':
      if (ctrl) { e.preventDefault(); send(msg(SAVE)); }
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

// ===== Inbound message routing ============================================

window.funsync.onEditorPopoutEvent((event) => {
  if (event.type !== 'message') return;
  const m = event.payload;
  if (!m || !m.type) return;

  switch (m.type) {
    case THEME: {
      applyTheme(m.theme);
      applyStyle(m.uiStyle);
      break;
    }
    case INITIAL_STATE: {
      if (m.theme) applyTheme(m.theme);
      applyStyle(m.uiStyle);
      activePath = m.activePath || null;
      updateScriptSelect(m.scripts || [], activePath);
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
      }
      if (typeof m.frameDurationMs === 'number' && m.frameDurationMs > 0) {
        popoutFrameMs = m.frameDurationMs;
      }
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
      statusEl.textContent = `${editable.actions.length} actions`;
      hydrated = true;
      resizeCanvas();
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
      }
      if (typeof m.playbackRate === 'number' && speedSelect.value !== String(m.playbackRate)) {
        speedSelect.value = String(m.playbackRate);
      }
      break;
    }
    case TIME_TICK: {
      player.applyTimeTick(m);
      if (hydrated) {
        graph.setCursorTime?.(m.time * 1000);
        graph.draw();
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
      if (m.path && m.path !== activePath) activePath = m.path;
      if (Array.isArray(m.actions)) {
        editable.loadFromData({ version: '1.0', actions: m.actions });
      }
      if (Array.isArray(m.selectedIndices)) {
        editable._selectedIndices = new Set(m.selectedIndices);
      }
      if (Array.isArray(m.bookmarks)) {
        editable._bookmarks = m.bookmarks.map(b => ({ ...b }));
      }
      const selCount = editable.selectedIndices.size;
      statusEl.textContent = selCount > 0
        ? `${editable.actions.length} actions · ${selCount} selected`
        : `${editable.actions.length} actions`;
      if (hydrated) graph.draw();
      break;
    }
    case SCRIPTS_CHANGED: {
      if (m.activePath) activePath = m.activePath;
      updateScriptSelect(m.scripts || [], activePath);
      break;
    }
    default:
      console.debug('[editor-popout] unknown message type:', m.type, m);
  }
});

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

// Ready signal — parent replies with INITIAL_STATE.
send(msg(READY));
