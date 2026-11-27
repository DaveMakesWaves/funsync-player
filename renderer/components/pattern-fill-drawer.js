// Fill with pattern: the editor's slide-out drawer (pattern library, Round 2;
// notes/features/DESIGN-pattern-library.md §f).
//
// Dave: "if a section of the timeline is selected then the user right clicks
// they can fill that space with one of the patterns and choose the speed of
// it on a slider and reverse if they wish ... preview how it will look in the
// timeline live so maybe add it as a drawer slide out option instead of a
// modal, i cant stress live changes as the slider for speed is moved".
//
// One component for both editors: the docked one (script-editor.js) and the
// pop-out (editor-popout.js). It never edits a script itself. It reads the
// host's actions and selection, runs the pure fill core (pattern-fill.js
// fillRange) and shows the result as the graph's ghost layer
// (ActionGraph.setGhost), which is never part of the script. Apply hands the
// result to the host (`onApply`): the docked editor calls
// EditableScript.replaceRange (one undo step), the pop-out sends
// OP_FILL_RANGE to the parent, whose script, undo stack and autosave stay the
// single source of truth. Cancel, the X and Esc clear the ghost and leave the
// script as it was.
//
// LIVE: every `input` event (a slider while it is dragged, a key in the
// search box, a click in the list) asks for one preview; at most one fill
// runs per animation frame, and it reads the controls when it runs, so the
// last value always wins and nothing queues up behind a slow pattern. A
// preview expected to take longer than a frame (a buzz pattern over minutes)
// runs in a module Worker (pattern-fill-worker.js, the same pure core) with a
// request id: one request in flight, only the answer to the latest request
// is shown, and "Updating the preview…" says so meanwhile. When the Worker
// fails to load, previews run here and a slow one waits until the slider
// settles. (Where there is no Worker at all, as in the tests' jsdom, every
// preview runs here once a frame, as before.)
//
// SCRIPT IDENTITY: a preview remembers what it was built on (the window, a
// signature of its points and their neighbours, the host's script key).
// Apply checks that against the script and selection as they are NOW and
// refuses with the 'changed' message when they differ, so a preview drawn on
// one script never lands on another (review-2 blockers). The pop-out sends
// the same signature and its script path with OP_FILL_RANGE.
//
// Not a modal (DESIGN.md §2.13: a persistent panel next to live content): the
// timeline stays visible, zoom / pan / seek / selection still work and the
// preview follows the selection. role="dialog" with aria-modal="false",
// focus moves in on open and back to the canvas on close. A key the focused
// control uses (typing, a slider's arrows, Space on a button) stays in it;
// the player's keys (Space on a slider, F, M, K, J, L...) go on to the player.

import { t, getCurrentLocale } from '../js/i18n.js';
import { speedForBpm, bpmFromBeats, TEMPO_MIN_BPM, TEMPO_MAX_BPM } from '../js/fill-tempo.js';
import { eventBus } from '../js/event-bus.js';
import { icon, X } from '../js/icons.js';
import { fillRange, FILL_NO_CAP } from '../js/pattern-fill.js';
import { listFamilies, listPatterns, describePattern, renderPattern, PATTERN_SPEED_CEILING, FAST_LEG } from '../js/pattern-library.js';

/**
 * No speed ceiling on what the editor writes (Dave, 2026-11-24: "there
 * shouldnt really be a limit, i think some scripts on the forum go up to like
 * 2000 ... its down to the scripters ... sometimes going over the limit is a
 * trick people use for unusual movements", then "yes lift the fill cap too").
 * The fill core gets no cap (FILL_NO_CAP) and the Speed / Ramp sliders reach
 * FILL_SLIDER_MAX. The live patterns (Gap Filler, Orgasm Switch, Edge Hold)
 * drive a device as they play and keep PATTERN_SPEED_CEILING.
 */
export const FILL_SLIDER_MAX = 5000;         // = FILL_NO_CAP (Dave: "infinite can be 5000")
import { layoutKey } from '../js/keyboard-layout.js';

/** `editor.patternFill` in electron/store.js: what the drawer remembers (design §h). */
export const PATTERN_FILL_DEFAULTS = Object.freeze({ id: null, endFit: 'stretch', mode: 'replace', join: 0.5, variation: 1 });
/** The first pattern offered while nothing is remembered. */
export const DEFAULT_FILL_PATTERN = 'quick-full-strokes';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The remembered options, cleaned: anything missing or out of range is the
 * default, an unknown pattern id is null (absence is never an error).
 * @param {*} raw — the stored `editor.patternFill`
 * @returns {{id: string|null, endFit: 'stretch'|'partial', mode: 'replace'|'gap', join: number, variation: number}}
 */
export function normalisePatternFillOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof o.id === 'string' && describePattern(o.id) ? o.id : null,
    endFit: o.endFit === 'partial' ? 'partial' : 'stretch',
    mode: o.mode === 'gap' ? 'gap' : 'replace',
    join: isNum(o.join) ? clamp(o.join, 0, 1) : PATTERN_FILL_DEFAULTS.join,
    variation: isNum(o.variation) ? clamp(o.variation, 0, 2) : PATTERN_FILL_DEFAULTS.variation,
  };
}

/** ms: a marked time range shorter than this is no range (a fill needs two whole legs). */
export const FILL_RANGE_MIN_MS = 200;

/**
 * The stretch a fill covers: from the first to the last selected point (both
 * kept as the join anchors, design Q3). With fewer than two selected points,
 * a marked time range (`range`, the band a rubber-band drag left; Dave
 * 2026-11-17: "fill with fewer than two selected points: allowed on a plain
 * time range") is the stretch instead: its edges stand in for the anchors
 * (the fill core joins them on the script's own line, or free where no point
 * lies beyond) and the one point it may hold stays. A range is plain: one
 * that holds two or more points is none (select those points instead).
 * Null without either: the action is off and says why.
 * @param {Array<{at:number,pos:number}>} actions
 * @param {Iterable<number>} selectedIndices
 * @param {{startMs:number,endMs:number}|null} [range]
 * @returns {{startMs: number, endMs: number, selected: number, points: number, range?: true}|null}
 *   `points` = every point inside the stretch, anchors included
 */
export function fillWindowOf(actions, selectedIndices, range = null) {
  let lo = Infinity;
  let hi = -Infinity;
  let selected = 0;
  for (const i of selectedIndices || []) {
    const a = actions?.[i];
    if (!a) continue;
    selected++;
    if (a.at < lo) lo = a.at;
    if (a.at > hi) hi = a.at;
  }
  if (selected < 2) return rangeWindowOf(actions, range, selected);
  let points = 0;
  for (const a of actions) if (a.at >= lo && a.at <= hi) points++;
  return { startMs: lo, endMs: hi, selected, points };
}

/** A marked time range as the fill's stretch (fillWindowOf), or null when it is not a plain range. */
function rangeWindowOf(actions, range, selected = 0) {
  const start = Number(range?.startMs);
  const end = Number(range?.endMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < FILL_RANGE_MIN_MS) return null;
  let points = 0;
  for (const a of actions || []) if (a.at >= start && a.at <= end) points++;
  if (points > 1) return null;
  return { startMs: start, endMs: end, selected, points, range: true };
}

/**
 * The time range a rubber-band drag marks for a fill (both editors): the
 * band's time span in whole ms, when it is long enough and holds at most one
 * point of the script; else null. The band selects what it selects as before.
 * @param {Array<{at:number,pos:number}>} actions
 * @param {number} t1 — one edge of the band (ms)
 * @param {number} t2 — the other edge (ms)
 * @returns {{startMs:number,endMs:number}|null}
 */
export function rangeFromBand(actions, t1, t2) {
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  const startMs = Math.max(0, Math.round(Math.min(t1, t2)));
  const endMs = Math.round(Math.max(t1, t2));
  return rangeWindowOf(actions, { startMs, endMs }) ? { startMs, endMs } : null;
}

/**
 * What a marked range belongs to: the selection it was marked with and what
 * the host adds (the docked editor: its load id and revision; the pop-out:
 * the path and the window's signature). Any other selection, an edit or
 * another script gives another key, and the range is gone.
 */
export function fillRangeKey(selectedIndices, extra = '') {
  return `${[...(selectedIndices || [])].sort((a, b) => a - b).join(',')}|${extra}`;
}

/**
 * Where a fill lands (EditableScript.replaceRange's t0, t1 and mode), for the
 * docked Apply and the pop-out's in the parent alike. A fill between two
 * anchors: their times and the drawer's mode (the anchors stay, replace
 * drops the points between). A fill of a marked time range removes nothing
 * (the fill core keeps the one point it may hold) and its edge points sit ON
 * the range's edges, so it lands as an insert over a window one ms wider on
 * each side.
 * @param {{t0:number,t1:number,mode:string,range?:boolean}} fill
 * @returns {{t0:number,t1:number,mode:'replace'|'gap'}}
 */
export function fillLanding(fill) {
  if (fill?.range === true) return { t0: Math.floor(fill.t0) - 1, t1: Math.ceil(fill.t1) + 1, mode: 'gap' };
  return { t0: fill.t0, t1: fill.t1, mode: fill.mode === 'gap' ? 'gap' : 'replace' };
}

/**
 * The part of a script a fill reads: every point from t0 to t1 plus one
 * neighbour on each side (the fill core takes the anchors' direction from
 * them, pattern-fill.js pointEnd). Actions sorted by time, as both editors
 * keep them.
 * @returns {{from: number, to: number}} index range, `to` exclusive
 */
export function fillBasisRange(actions, t0, t1) {
  const acts = Array.isArray(actions) ? actions : [];
  let lo = 0;
  let hi = acts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (acts[mid].at < t0) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < acts.length && acts[end].at <= t1) end++;
  return { from: Math.max(0, lo - 1), to: Math.min(acts.length, end + 1) };
}

/**
 * What a fill was built on, as a short string: the count and a hash (FNV-1a)
 * of the points fillBasisRange covers. Equal signatures mean the same points
 * at the same times and positions, so the same controls give the same fill.
 * The docked Apply and the pop-out's parent both compare it (review-2).
 */
export function windowSignature(actions, t0, t1) {
  const acts = Array.isArray(actions) ? actions : [];
  const { from, to } = fillBasisRange(acts, t0, t1);
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) {
    const s = `${acts[i].at},${acts[i].pos};`;
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${to - from}:${(h >>> 0).toString(16)}`;
}

/**
 * The window handed to the fill core: whole ms that still contain the
 * anchors. The core rounds the selection's edges, so an anchor at 1000.5
 * fell outside a window rounded to 1001 and the fill joined the next point
 * instead (the docked and pop-out Apply then disagreed, review-2 minor 7).
 */
export function fillSelectionOf(win) {
  return { startMs: Math.floor(win.startMs), endMs: Math.ceil(win.endMs) };
}

/**
 * What a key on the editor's canvas does while the drawer is open (design
 * §f: "editing keys pause until Apply or Cancel"; zoom, pan, seek and
 * selection changes still work and the preview follows the selection).
 *   'close'  Esc: closes the drawer (before it would clear the selection)
 *   'focus'  P: back into the drawer
 *   'block'  a key that changes the script (the editor's edit keys): it
 *            waits while the preview is up
 *   'allow'  everything else, as with the drawer closed: the editor's other
 *            keys (play, frame steps, selection, zoom, help, speed, view
 *            toggles, save) and the keys it has no case for, which go on to
 *            the player (F / F11 fullscreen, M, K, J, L, H...; review-2: the
 *            old default 'block' swallowed them)
 * Only the edit set is listed, so a new player key is never blocked here.
 * @param {KeyboardEvent} e
 * @param {{isPositionKey?: boolean}} [o] — a position key (the user's own map
 *   included) is an edit: it would place a point
 * @returns {'close'|'focus'|'allow'|'block'}
 */
export function fillDrawerKeyVerdict(e, { isPositionKey = false } = {}) {
  const ctrl = !!(e.ctrlKey || e.metaKey);
  const k = layoutKey(e);
  if (k === 'Escape') return 'close';
  if (['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock'].includes(k)) return 'allow';
  if (isPositionKey) return 'block';
  if ((k === 'p' || k === 'P') && !ctrl && !e.shiftKey && !e.altKey) return 'focus';
  if (k === 'Delete' || k === 'Backspace') return 'block';
  // Shift+Left / Right moves the selected points in time (Ctrl+Alt is a
  // selection command, plain and Ctrl are frame steps).
  if (k === 'ArrowLeft' || k === 'ArrowRight') return e.shiftKey && !(ctrl && e.altKey) ? 'block' : 'allow';
  // Shift+Up / Down nudges; Ctrl+Up / Down moves to another script.
  if (k === 'ArrowUp' || k === 'ArrowDown') return e.shiftKey || ctrl ? 'block' : 'allow';
  // Undo, redo, cut, paste, invert.
  if (ctrl && ['z', 'Z', 'y', 'Y', 'x', 'X', 'v', 'V', 'i', 'I'].includes(k)) return 'block';
  // B adds a bookmark; Q inserts, E equalizes; Home repeats the last stroke,
  // End moves the selection to the playhead.
  if (!ctrl && !e.shiftKey && (k === 'b' || k === 'B')) return 'block';
  if (!ctrl && ['q', 'Q', 'e', 'E', 'Home', 'End'].includes(k)) return 'block';
  return 'allow';
}

// The keys a focused control in the drawer uses itself (the player's own
// rule, keyboard.js targetOwnsKey): a slider steps with these, a checkbox,
// radio or button takes Space and Enter, a radio its arrows too, and the
// search box, the group list and the pattern list take every key.
const RANGE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
// The pattern list uses only these (it has no type-ahead). The focus lands
// in it when the drawer opens, so F, M, K and the other player keys go on
// from there (live verifier 2026-11-17: it kept every key). The list is
// marked data-owns-keys="navigation" for keyboard.js's own rule.
export const LIST_KEYS = new Set([...ARROWS, 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ']);

/**
 * True when the drawer's focused control uses this key, so it stays in the
 * drawer. Any other key goes on to the player as with the drawer closed
 * (Space on a slider pauses; F, M, K, J, L...). Edit keys never reach the
 * timeline from here: the canvas is not on the way.
 * @param {KeyboardEvent} e
 */
export function drawerControlOwnsKey(e) {
  const el = e.target;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('select, textarea')) return true;
  if (el.closest('[role="listbox"]')) return LIST_KEYS.has(e.key);
  const tag = String(el.tagName || '').toUpperCase();
  const key = e.key;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    if (type === 'range') return RANGE_KEYS.has(key);
    if (type === 'checkbox') return key === ' ' || key === 'Enter';
    if (type === 'radio') return key === ' ' || key === 'Enter' || ARROWS.has(key);
    return true; // the search box
  }
  if (el.closest('button')) return key === ' ' || key === 'Enter';
  return false;
}

// ---- the docked drawer's place (live verifier 2026-11-17: in a short window
// or at a large interface size it went off the top of the window) ----

/** CSS px: the scrolling body (search, group, list, options) gets at least this whenever the window has room. */
export const FILL_DRAWER_MIN_BODY_PX = 150;
/** CSS px: the title, hint, summary and buttons around the body (the floor; measured when shown). */
export const FILL_DRAWER_CHROME_PX = 190;
/** CSS px: the docked drawer's tallest. */
export const FILL_DRAWER_MAX_PX = 560;
/** CSS px: the gap kept under the player's top bar and its queue button. */
const TOP_GAP_PX = 6;

/**
 * Where the docked drawer goes, in CSS px of the window (the interface size
 * is already in them). Best first:
 *   'above'    standing on the player's controls bar, as tall as the room
 *              over it allows: the whole bar stays usable;
 *   'over-bar' standing on the editor's top edge, over the bar's right end,
 *              when the room over the bar is too short but this is not;
 *   'side'     at the right from under the top bar down to the editor's
 *              bottom, beside the timeline (which narrows at the same scale,
 *              as in the pop-out), when even that is too short.
 * The top is never above `topLimit` while the room allows the minimum, and
 * never above the window: the title and the X stay in reach.
 * @param {object} o
 * @param {number} o.editorTop — the docked editor's top edge
 * @param {number} o.editorBottom — its bottom edge (the window's bottom)
 * @param {number} [o.barTop] — the player's controls bar's top edge
 * @param {number} [o.topLimit] — the bottom of the player's top bar (and queue button)
 * @param {number} [o.chrome] — the drawer's height without its body
 * @param {number} [o.minBody] / [o.maxHeight]
 * @returns {{ mode: 'above'|'over-bar'|'side', top: number, height: number }}
 */
export function dockedDrawerPlacement({
  editorTop, editorBottom, barTop, topLimit = 0,
  chrome = FILL_DRAWER_CHROME_PX, minBody = FILL_DRAWER_MIN_BODY_PX, maxHeight = FILL_DRAWER_MAX_PX,
}) {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const eTop = num(editorTop, 0);
  const eBottom = Math.max(eTop, num(editorBottom, eTop));
  const bTop = Math.min(eTop, num(barTop, eTop));
  const limit = Math.max(0, num(topLimit, 0));
  const minH = Math.max(0, num(chrome, FILL_DRAWER_CHROME_PX)) + Math.max(0, num(minBody, FILL_DRAWER_MIN_BODY_PX));
  const maxH = Math.max(minH, num(maxHeight, FILL_DRAWER_MAX_PX));
  for (const [mode, bottom] of [['above', bTop], ['over-bar', eTop]]) {
    const room = bottom - limit;
    if (room >= minH) {
      const height = Math.floor(Math.min(maxH, room));
      return { mode, top: bottom - height, height };
    }
  }
  // Beside the timeline: inside the editor when it alone holds a whole drawer
  // (stacked lanes make it that tall: from under the top bar it covered the
  // control bar's right end at 1280x800, fit-on-screen pass 2026-11-24), else
  // from under the top bar as before (a short window).
  const top = eBottom - eTop >= minH ? eTop : Math.max(0, Math.min(limit, eBottom - minH));
  return { mode: 'side', top, height: eBottom - top };
}

// ---- sparklines (lazy, cached per pattern for the session) ----

const SPARK_W = 64;
const SPARK_H = 20;
const _sparkCache = new Map();

/** The pattern's shape as SVG polyline points in a 64 x 20 box ('' when it cannot render). */
export function sparklinePoints(id) {
  if (_sparkCache.has(id)) return _sparkCache.get(id);
  let pts = '';
  try {
    const d = describePattern(id);
    const opts = { seed: 1 };
    if (d && d.kind !== 'event') opts.durationMs = clamp((d.strokeMs || 1000) * 3, 1500, 6000);
    const acts = renderPattern(id, opts)?.actions || [];
    if (acts.length >= 2) {
      const a0 = acts[0].at;
      const span = acts[acts.length - 1].at - a0 || 1;
      pts = acts.map((a) => `${(2 + ((a.at - a0) / span) * (SPARK_W - 4)).toFixed(1)},${(SPARK_H - 2 - (a.pos / 100) * (SPARK_H - 4)).toFixed(1)}`).join(' ');
    }
  } catch {
    pts = '';
  }
  _sparkCache.set(id, pts);
  return pts;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let _drawerSeq = 0;

// ---- the preview's cost (review-2 minor 5: 919 ms a frame for a buzz
// pattern over 10 minutes froze the window and the renderer-side device sync)

/** ms: a preview expected to take longer than this runs in the Worker. */
const MAIN_THREAD_BUDGET_MS = 8;
/** ms: with the Worker failed, a preview that took longer than this waits for the controls to settle. */
const SLOW_PREVIEW_MS = 30;
/** ms: how long the controls stay still before a slow preview runs (Worker failed). */
const SETTLE_MS = 180;
/** ms: the summary is read out once it has stayed the same this long. */
const ANNOUNCE_MS = 600;

/** The preview Worker: the same pure fill core, off the window's thread. */
function defaultCreateWorker() {
  if (typeof Worker !== 'function') return null;
  return new Worker(new URL('../js/pattern-fill-worker.js', import.meta.url), { type: 'module' });
}

/** The controls as one comparable string (a result is reused only for the same controls). */
const optionsKey = (patternId, options) => JSON.stringify([patternId, options]);

export class PatternFillDrawer {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container — the editor panel the drawer lives in
   * @param {import('../js/action-graph.js').ActionGraph} o.graph — the ghost layer's graph
   * @param {() => Array<{at:number,pos:number}>} o.getActions
   * @param {() => Iterable<number>} o.getSelectedIndices
   * @param {(fill: {t0:number,t1:number,points:Array,mode:string,patternId:string,name:string,options:object,result:object}) => (boolean|void)} o.onApply
   *   false keeps the drawer open (nothing landed)
   * @param {() => *} [o.loadOptions] — the remembered `editor.patternFill`
   * @param {(reason: 'apply'|'cancel') => void} [o.onClose]
   * @param {'above'|'side'} [o.placement] — 'above': over the video, above
   *   the docked editor (its 250 px are too short for the controls, and the
   *   timeline keeps its full width); 'side': beside the timeline, under the
   *   toolbar (the pop-out window), the timeline narrowing at the same scale
   * @param {Function} [o.fill] — the fill core (tests count its calls)
   * @param {Function} [o.raf] / [o.caf] — the frame scheduler
   * @param {() => *} [o.getScriptKey] — which script this is (the docked
   *   editor: its load id; the pop-out: the parent's path). A drawer opened on
   *   one script closes when the key changes, and never applies across it.
   * @param {(text: string, level?: string) => void} [o.notify] — a toast for
   *   a refused Apply (the 'changed' message)
   * @param {(() => Worker|null)|null} [o.createWorker] — the preview Worker
   *   (null: always on this thread; tests pass a fake)
   * @param {() => ({startMs:number,endMs:number}|null)} [o.getFillRange] — the
   *   time range the user marked (a rubber band over 0 or 1 points), used
   *   while fewer than two points are selected (fillWindowOf)
   *
   * `onApply` may also return a Promise (the pop-out waits for the parent's
   * answer): the drawer stays open and busy until it settles, closes on
   * true, and keeps the user's settings on false.
   */
  constructor({
    container, graph, getActions, getSelectedIndices, onApply, loadOptions, onClose,
    placement = 'above', fill = fillRange, raf, caf, getScriptKey, notify, createWorker = defaultCreateWorker,
    getFillRange,
  }) {
    this._container = container;
    this._graph = graph;
    this._getActions = getActions;
    this._getSelected = getSelectedIndices;
    this._onApply = onApply;
    this._loadOptions = loadOptions || (() => null);
    this._onClose = onClose || null;
    this._placement = placement === 'side' ? 'side' : 'above';
    this._fill = fill;
    this._raf = raf || ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16)));
    this._caf = caf || ((id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)));
    this._getScriptKey = typeof getScriptKey === 'function' ? getScriptKey : null;
    this._notify = typeof notify === 'function' ? notify : null;
    this._createWorker = typeof createWorker === 'function' ? createWorker : null;
    this._getFillRange = typeof getFillRange === 'function' ? getFillRange : null;
    this._id = `fill-drawer-${++_drawerSeq}`;

    this._root = null;
    this._isOpen = false;
    this._frame = 0;
    this._pending = false;
    this._result = null;
    this._lastCostMs = 0;
    this._state = null;
    this._observer = null;
    this._openKey = undefined; // the script key the drawer opened on
    this._busy = false; // an Apply waiting for its answer (the pop-out)
    this._applyWhenReady = false; // an Apply waiting for the Worker's fill of the current controls
    this._applySeq = 0; // bumps on close: a late answer to an old Apply does nothing
    this._updatingEl = null;
    this._announce = null;
    this._refreshAfterBusy = false;
    // The preview Worker (built on the first open; see _wantsWorker).
    this._worker = null;
    this._workerBroken = false;
    this._reqSeq = 0; // the latest preview request; an answer to an older one is dropped
    this._inflight = null; // { id, job } sent to the Worker, not answered yet
    this._rates = new Map(); // pattern id -> ms per second of window (measured)
    this._settleTimer = 0;
    this._announceTimer = 0;
    this._unsubLanguage = eventBus.on('language:changed', () => this._retranslate());
    // A resized window can wrap the pop-out's toolbar onto another row, or
    // change the height of the player's controls bar under the docked drawer.
    this._dock = placement === 'side' ? 'side' : 'above'; // where the docked drawer is now (_placeAbove)
    this._narrowed = false; // the timeline made room for a side drawer
    this._onResize = () => {
      if (!this._isOpen) return;
      this._layout(true);
      // The docked editor measures its wrapped toolbar on the same event:
      // once more after it.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { if (this._isOpen) this._layout(true); });
    };
    if (typeof window !== 'undefined') window.addEventListener('resize', this._onResize);
  }

  get isOpen() { return this._isOpen; }
  /** The drawer's element (built on the first open), or null. */
  get element() { return this._root; }
  /** ms the last preview's fill took (shown nowhere; for the report and tests). */
  get lastCostMs() { return this._lastCostMs; }
  /** The preview on show: { res (fillRange's result), win, options, patternId } or null. */
  get preview() { return this._result; }

  /** True when `node` is inside the drawer. */
  owns(node) {
    return !!(this._root && node && this._root.contains(node));
  }

  // ---------------------------------------------------------------- open / close

  /**
   * Open on the current selection. The host checks for two selected points
   * or a marked time range first (without, the action is off and says why).
   */
  open() {
    if (!this._root) this._build();
    const remembered = normalisePatternFillOptions(this._loadOptions());
    if (!this._isOpen) {
      this._state = this._freshState(remembered);
      this._syncControls();
      this._renderList();
      this._openKey = this._scriptKey();
    }
    this._isOpen = true;
    this._root.hidden = false;
    this._root.classList.add('fill-drawer--open');
    this._layout(true);
    this._revealWindow();
    this.focus();
    this._schedule();
  }

  /**
   * Close and clear the ghost. Cancel, the X, Esc and every route that takes
   * the script away (the editor closing, another script or video loading, the
   * pop-out taking over) come here: the script is not touched.
   * @param {'apply'|'cancel'} [reason]
   */
  close(reason = 'cancel') {
    if (!this._isOpen) return;
    this._isOpen = false;
    if (this._frame) this._caf(this._frame);
    this._frame = 0;
    this._pending = false;
    this._result = null;
    // A preview still in the Worker, or an Apply still waiting, is dropped.
    this._reqSeq++;
    this._inflight = null;
    this._applySeq++;
    this._setBusy(false);
    this._refreshAfterBusy = false;
    clearTimeout(this._settleTimer);
    clearTimeout(this._announceTimer);
    this._settleTimer = 0;
    this._announceTimer = 0;
    this._setUpdating(false);
    // The rows are rendered again on the next open.
    this._observer?.disconnect?.();
    this._observer = null;
    this._graph?.clearGhost?.();
    this._redraw();
    this._root.classList.remove('fill-drawer--open');
    this._root.hidden = true;
    this._layout(false);
    try { this._onClose?.(reason); } catch (err) { console.warn('[FillDrawer] onClose failed:', err); }
  }

  /**
   * The host's script or selection changed: preview again (next frame). A
   * drawer whose script went away (another one loaded) closes instead.
   */
  refresh() {
    if (!this._isOpen) return;
    if (this._scriptGone()) {
      this.close('cancel');
      return;
    }
    // An Apply waiting for its answer: its own echo is not a new preview.
    if (this._busy) {
      this._refreshAfterBusy = true;
      return;
    }
    this._schedule();
  }

  /** Focus the chosen pattern (or the search box when the list is empty). */
  focus() {
    if (!this._root) return;
    const opt = this._list.querySelector('[aria-selected="true"]') || this._list.querySelector('[role="option"]');
    (opt || this._search).focus({ preventScroll: false });
  }

  destroy() {
    this.close('cancel');
    this._unsubLanguage?.();
    if (typeof window !== 'undefined') window.removeEventListener('resize', this._onResize);
    this._observer?.disconnect?.();
    try { this._worker?.terminate?.(); } catch { /* gone */ }
    this._worker = null;
    this._root?.remove();
    this._root = null;
  }

  // ---------------------------------------------------------------- apply

  /**
   * Apply, on the script and selection as they are NOW. What the preview on
   * screen was built on (its window and the signature of its points) is
   * checked against them first: another script, a moved selection or an edit
   * in the window refuses with the 'changed' message, keeps the drawer and
   * previews what is there now (review-2 blocker: a preview drawn on one
   * script was applied to another). Then the fill: the one on screen when
   * the controls have not moved since, else a fresh fill from the controls
   * as they are now (the same inputs give the same fill). One call to the
   * host, one undo step there; the drawer closes (the new points are the
   * selection now, and a fill between them would fill the fill).
   * @returns {boolean} true when the host took it (the pop-out: sent it)
   */
  apply() {
    if (!this._isOpen || this._busy) return false;
    if (this._scriptGone()) {
      this._refuse();
      this.close('cancel');
      return false;
    }
    const job = this._job();
    const shown = this._result;
    if (!job.win || (shown && (shown.win.startMs !== job.win.startMs
        || shown.win.endMs !== job.win.endMs || shown.sig !== job.sig))) {
      this._refuse();
      this._schedule();
      return false;
    }
    let r = shown && shown.key === job.key ? shown : null;
    if (!r) {
      // The controls moved since the preview. A slow fill waits for the
      // Worker's answer to them (busy meanwhile) rather than freezing the
      // window; a quick one runs here and now.
      if (this._worker && !this._workerBroken && this._wantsWorker(job)) {
        this._applyWhenReady = true;
        this._setBusy(true);
        if (!this._inflight && !this._frame) this._renderPreview();
        return false;
      }
      if (this._frame) this._caf(this._frame);
      this._frame = 0;
      this._pending = false;
      r = this._runHere(job, ++this._reqSeq);
      this._show(r);
    }
    if (!r.res.inserted.length) return false;
    const fill = {
      t0: r.win.startMs,
      t1: r.win.endMs,
      points: r.res.inserted.map((p) => ({ at: p.at, pos: p.pos })),
      mode: r.options.mode,
      patternId: r.patternId,
      name: this._patternName(r.patternId),
      options: this.remembered(),
      result: r.res,
      sig: r.sig,
      // A marked time range, not two anchors: it lands as an insert (fillLanding).
      range: r.win.range === true,
    };
    let ok;
    try {
      ok = this._onApply?.(fill);
    } catch (err) {
      console.warn('[FillDrawer] apply failed:', err);
      ok = false;
    }
    if (ok && typeof ok.then === 'function') {
      // The pop-out: open and busy until the parent answers; a refusal keeps
      // the user's settings (review-2 minor 7).
      const seq = this._applySeq;
      this._setBusy(true);
      ok.then((landed) => this._settleApply(seq, landed === true), (err) => {
        console.warn('[FillDrawer] apply failed:', err);
        this._settleApply(seq, false);
      });
      return true;
    }
    if (ok === false) return false;
    this.close('apply');
    return true;
  }

  /** The answer to an Apply that waited (the pop-out's parent): close, or stay with the settings. */
  _settleApply(seq, landed) {
    if (seq !== this._applySeq || !this._isOpen) return;
    this._setBusy(false);
    if (landed) {
      this.close('apply');
      return;
    }
    this._refreshAfterBusy = false;
    this._schedule();
  }

  /** Apply refused: the script or the selection is not what the preview was built on. */
  _refuse() {
    try { this._notify?.(t('editor.patternFill.changed'), 'warn'); } catch { /* the drawer still stays */ }
  }

  /** The host's script key now (undefined without a getScriptKey). */
  _scriptKey() {
    return this._getScriptKey ? this._getScriptKey() : undefined;
  }

  /** True when the script the drawer opened on is no longer the host's. */
  _scriptGone() {
    return !!this._getScriptKey && this._scriptKey() !== this._openKey;
  }

  _setBusy(on) {
    this._busy = !!on;
    if (!on) this._applyWhenReady = false;
    if (!this._root) return;
    this._root.setAttribute('aria-busy', on ? 'true' : 'false');
    this._root.classList.toggle('fill-drawer--busy', !!on);
    if (this._applyBtn) this._applyBtn.disabled = !!on || !this._result?.res?.inserted?.length;
    if (!on && this._refreshAfterBusy && this._isOpen) {
      this._refreshAfterBusy = false;
      this._schedule();
    }
  }

  /** What `editor.patternFill` keeps after an Apply (design §h). */
  remembered() {
    const s = this._state || this._freshState(PATTERN_FILL_DEFAULTS);
    return { id: s.patternId, endFit: s.endFit, mode: s.mode, join: s.join, variation: s.variation };
  }

  // ---------------------------------------------------------------- state

  _freshState(remembered) {
    const id = remembered.id || (describePattern(DEFAULT_FILL_PATTERN) ? DEFAULT_FILL_PATTERN : listPatterns()[0]?.id);
    return {
      patternId: id,
      ...this._patternDefaults(id),
      reversed: false,
      variation: remembered.variation,
      seed: 1,
      join: remembered.join,
      endFit: remembered.endFit,
      mode: remembered.mode,
    };
  }

  /**
   * Speed, ramp and range start at the pattern's own on every pattern change
   * (design §f). The Speed and Ramp sliders reach the pattern's own top or
   * the speed ceiling (PATTERN_SPEED_CEILING, 600 u/s), whichever is lower:
   * one pattern's own range reached 946 u/s, and the fill core's cap then
   * rose to 1.5x that (device-speed-limits-2026-11-17.md, finding 1).
   */
  _patternDefaults(id) {
    const d = describePattern(id);
    const own = Math.round(d?.speed || 120);
    const lo = Math.max(5, Math.min(Math.floor(d?.speedRange?.[0] || own / 2), FILL_SLIDER_MAX - 5));
    // The slider reaches FILL_SLIDER_MAX on every pattern (no ceiling, Dave).
    const hi = Math.max(lo + 5, Math.ceil(d?.speedRange?.[1] || own * 2), own, FILL_SLIDER_MAX);
    const place = d?.range || [0, 100];
    return {
      speed: null,
      speedMin: Math.min(lo, own),
      speedMax: hi,
      own,
      rampOn: false,
      rampTo: own,
      rangeOwn: true,
      rangeMin: Math.round(place[0]),
      rangeMax: Math.round(place[1]),
    };
  }

  /**
   * The fill core's options from the controls, read NOW (the last value
   * wins). maxSpeed is always the ceiling: every fill the drawer runs (the
   * preview here, the Worker, Apply; docked and pop-out) holds every leg,
   * the joins included, to 600 u/s.
   */
  _options() {
    const s = this._state;
    return {
      speed: s.speed === null ? null : s.speed,
      ramp: s.rampOn ? { to: s.rampTo } : null,
      reversed: s.reversed,
      range: s.rangeOwn ? null : { min: Math.min(s.rangeMin, s.rangeMax), max: Math.max(s.rangeMin, s.rangeMax) },
      variation: s.variation,
      seed: s.seed,
      joinSmoothness: s.join,
      endFit: s.endFit,
      mode: s.mode,
      maxSpeed: FILL_NO_CAP,                               // no ceiling (FILL_SLIDER_MAX)
      // ... and no hidden one: legs as short as a frame (17 ms), the joins too
      // (the 100 ms / 50 ms floors held top speeds down; Dave: no limit).
      allowFast: true,
      minLegMs: FAST_LEG,
    };
  }

  /** The stretch a fill covers now: the selection, or the marked time range (fillWindowOf). */
  _window(actions) {
    return fillWindowOf(actions, this._getSelected?.() || [], this._getFillRange?.() || null);
  }

  _patternName(id) {
    const d = describePattern(id);
    const key = d?.nameKey;
    const name = key ? t(key) : '';
    return name && name !== key ? name : String(id);
  }

  // ---------------------------------------------------------------- preview

  /**
   * One preview per animation frame at most; the frame reads the controls
   * when it runs. With the Worker failed and a slow last preview, it waits instead
   * until the controls have been still for SETTLE_MS ("Updating the
   * preview…" meanwhile), so a drag does not freeze the window.
   */
  _schedule() {
    if (!this._isOpen) return;
    this._pending = true;
    if (this._workerBroken && this._lastCostMs > SLOW_PREVIEW_MS) {
      this._setUpdating(true);
      clearTimeout(this._settleTimer);
      this._settleTimer = setTimeout(() => {
        this._settleTimer = 0;
        if (!this._pending || !this._isOpen || this._frame) return;
        this._pending = false;
        this._renderPreview();
      }, SETTLE_MS);
      return;
    }
    if (this._frame) return;
    this._frame = this._raf(() => {
      this._frame = 0;
      if (!this._pending || !this._isOpen) return;
      this._pending = false;
      this._renderPreview();
    });
  }

  /** What a fill would be built on now: the window, its signature and the controls. */
  _job() {
    const actions = this._getActions?.() || [];
    const win = this._window(actions);
    const patternId = this._state.patternId;
    const options = this._options();
    return {
      actions,
      win,
      patternId,
      options,
      key: optionsKey(patternId, options),
      sig: win ? windowSignature(actions, win.startMs, win.endMs) : null,
    };
  }

  _renderPreview() {
    if (this._scriptGone()) {
      this.close('cancel');
      return;
    }
    const job = this._job();
    if (!job.win) {
      this._reqSeq++; // an answer about an earlier selection is not wanted
      this._setUpdating(false);
      this._result = null;
      this._graph?.clearGhost?.();
      this._redraw();
      this._showSummary(null);
      return;
    }
    if (this._wantsWorker(job)) {
      this._post(job);
      return;
    }
    const r = this._runHere(job, ++this._reqSeq);
    this._setUpdating(false);
    this._show(r);
  }

  /** The fill on this thread, timed (the result the drawer shows and applies). */
  _runHere(job, reqId) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const started = now();
    let res;
    try {
      res = this._fill({ actions: job.actions, selection: fillSelectionOf(job.win), patternId: job.patternId, options: job.options });
    } catch (err) {
      console.warn('[FillDrawer] fill failed:', err);
      res = { actions: job.actions, inserted: [], removed: [], warnings: [{ code: 'render-failed' }], stats: {} };
    }
    this._lastCostMs = now() - started;
    this._learnCost(job, this._lastCostMs);
    return { res, win: job.win, options: job.options, patternId: job.patternId, sig: job.sig, key: job.key, reqId };
  }

  /** Put a result on screen: the ghost, the summary, and a queued Apply. */
  _show(r) {
    this._result = r;
    const { res, win } = r;
    if (res.inserted.length) {
      // The whole stretch as it would be: the anchors, the fill and (gap
      // mode) the points it keeps.
      const ghost = res.actions.filter((a) => a.at >= win.startMs && a.at <= win.endMs);
      this._graph?.setGhost?.(ghost, { from: win.startMs, to: win.endMs });
    } else {
      this._graph?.clearGhost?.();
    }
    this._redraw();
    this._showSummary(r);
    if (this._applyWhenReady && r.reqId === this._reqSeq) {
      this._setBusy(false);
      this.apply();
    }
  }

  // ---------------------------------------------------------------- the preview Worker

  /** ms per second of window for this pattern, as last measured (here or in the Worker). */
  _learnCost(job, ms) {
    const seconds = Math.max(1, (job.win.endMs - job.win.startMs) / 1000);
    if (Number.isFinite(ms) && ms >= 0) this._rates.set(job.patternId, ms / seconds);
  }

  /**
   * Run this preview in the Worker? When one can be had and the fill is
   * expected to take longer than a frame's share (a pattern not measured yet
   * counts as slow). A short window of a light pattern stays here: no
   * round trip, the ghost moves in the same frame.
   */
  _wantsWorker(job) {
    if (this._workerBroken || !this._createWorker) return false;
    const rate = this._rates.get(job.patternId);
    if (rate !== undefined) {
      const est = rate * Math.max(1, (job.win.endMs - job.win.startMs) / 1000);
      if (est <= MAIN_THREAD_BUDGET_MS) return false;
    }
    return !!this._ensureWorker();
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    if (this._workerBroken || !this._createWorker) return null;
    try {
      const w = this._createWorker();
      if (!w) {
        this._createWorker = null; // no Worker here: every preview on this thread, as before
        return null;
      }
      w.onmessage = (e) => this._onWorkerMessage(e?.data);
      w.onerror = (e) => {
        e?.preventDefault?.();
        this._workerFailed(e?.message || 'error');
      };
      w.onmessageerror = () => this._workerFailed('messageerror');
      this._worker = w;
      return w;
    } catch (err) {
      this._workerFailed(err?.message || err);
      return null;
    }
  }

  /**
   * Ask the Worker. One request in flight: a newer one only bumps the
   * request id, and the latest controls go when the answer comes back.
   * Only the part of the script the fill reads goes over (fillBasisRange).
   */
  _post(job) {
    const id = ++this._reqSeq;
    this._setUpdating(true);
    if (this._inflight) return;
    const { from, to } = fillBasisRange(job.actions, job.win.startMs, job.win.endMs);
    this._inflight = { id, job };
    try {
      this._worker.postMessage({
        id,
        actions: job.actions.slice(from, to).map((a) => ({ at: a.at, pos: a.pos })),
        selection: fillSelectionOf(job.win),
        patternId: job.patternId,
        options: job.options,
      });
    } catch (err) {
      this._workerFailed(err?.message || err);
    }
  }

  _onWorkerMessage(msg) {
    const sent = this._inflight;
    if (!sent || !msg || msg.id !== sent.id) return; // dropped (closed, or an older request)
    this._inflight = null;
    if (!this._isOpen) return;
    if (this._scriptGone()) {
      this.close('cancel');
      return;
    }
    if (Number.isFinite(msg.ms)) this._learnCost(sent.job, msg.ms);
    if (msg.id !== this._reqSeq) {
      // The controls or the selection moved meanwhile: the latest goes now
      // (unless a frame is about to do it). This answer is not the latest,
      // but while it is newer than the one on screen and on the same stretch
      // of the same script it is shown, so a heavy preview moves during a
      // drag instead of standing still until the release (live verifier
      // 2026-11-17). "Updating…" stays up, and Apply never takes it: it only
      // lands a preview of what the controls say now.
      const shownId = this._result?.reqId ?? 0;
      if (msg.id > shownId && msg.res && Array.isArray(msg.res.inserted)) {
        const now = this._job();
        const job = sent.job;
        if (now.win && job.win && now.win.startMs === job.win.startMs && now.win.endMs === job.win.endMs && now.sig === job.sig) {
          this._show({ res: msg.res, win: job.win, options: job.options, patternId: job.patternId, sig: job.sig, key: job.key, reqId: msg.id });
        }
      }
      if (!this._frame && this._result?.reqId !== this._reqSeq) this._renderPreview();
      return;
    }
    const job = sent.job;
    const res = msg.res && Array.isArray(msg.res.inserted) ? msg.res
      : { actions: [], inserted: [], removed: [], warnings: [{ code: 'render-failed' }], stats: {} };
    this._setUpdating(false);
    this._show({ res, win: job.win, options: job.options, patternId: job.patternId, sig: job.sig, key: job.key, reqId: msg.id });
  }

  /** The Worker could not load or broke: previews run on this thread from now on (the settle rule keeps a slow one off the drag). */
  _workerFailed(why) {
    console.warn('[FillDrawer] preview worker unavailable; previews run in this window:', why);
    this._workerBroken = true;
    try { this._worker?.terminate?.(); } catch { /* gone */ }
    this._worker = null;
    const waiting = this._inflight;
    this._inflight = null;
    if (waiting && this._isOpen) this._renderPreview();
  }

  /** "Updating the preview…" while the shown preview is not the controls' latest. */
  _setUpdating(on) {
    if (!this._updatingEl) return;
    this._updatingEl.hidden = !on;
    this._summary.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  _redraw() {
    const g = this._graph;
    if (g && !g._animating) g.draw?.();
  }

  // ---------------------------------------------------------------- layout

  /**
   * 'side' (the pop-out): the drawer sits under the toolbar and the timeline
   * makes room for it at the SAME scale (ms per pixel): what was on screen
   * stays where it was, so nothing jumps. 'above' (docked): the drawer sits
   * over the video, and the editor does not change at all.
   */
  _layout(open) {
    if (open) this._placeAbove();
    this._watchSize(open);
    if (!this._container) return;
    if (open && this._placement === 'side') this._placeSide();
    // The pop-out's drawer, and the docked one when it had to go to the side.
    this._setNarrow(open && (this._placement === 'side' || this._dock === 'side'));
  }

  /**
   * Docked: place again whenever the editor or the controls bar changes
   * size while open. The editor measures its wrapped toolbar after a window
   * resize, so a place worked out on the resize itself was off by the new
   * row (seen live: the drawer then covered the queue button).
   */
  _watchSize(on) {
    if (this._placement !== 'above') return;
    if (!on) {
      this._sizeObserver?.disconnect?.();
      this._sizeObserver = null;
      return;
    }
    if (this._sizeObserver || typeof ResizeObserver !== 'function' || !this._container) return;
    this._sizeObserver = new ResizeObserver(() => {
      if (!this._isOpen) return;
      this._placeAbove();
      this._setNarrow(this._dock === 'side');
    });
    this._sizeObserver.observe(this._container);
    const bar = this._container.parentElement?.querySelector?.('.player__controls');
    if (bar) this._sizeObserver.observe(bar);
  }

  /** The timeline makes room for a side drawer (or takes it back) at the SAME scale. */
  _setNarrow(on) {
    if (!!this._narrowed === on) return;
    this._narrowed = on;
    const g = this._graph;
    const before = g?._drawArea?.()?.w || 0;
    const start = g?.viewStartMs;
    const dur = g?.viewDurationMs;
    this._container.classList.toggle('fill-drawer-host--open', on);
    if (!g?.resize) return;
    g.resize();
    const after = g._drawArea?.()?.w || 0;
    if (before > 0 && after > 0 && dur > 0) {
      g.setViewport(start, start + dur * (after / before));
      this._redraw();
    }
    // A drawer that went to the side while open (a smaller window): the
    // selected stretch, and its ghost, back into the narrower view.
    if (on && this._isOpen) this._revealWindow();
  }

  /**
   * 'above' (docked): the drawer stands on the player's controls bar, not
   * over it, so the editor, device, overflow and fullscreen buttons at its
   * right end stay usable while it is open (review-2 minor 6). The bar, the
   * editor and the player's top bar are measured (they differ with the
   * window, the UI style and the interface size) and dockedDrawerPlacement
   * picks the place: on the bar when the room over it is enough, else on
   * the editor's edge over the bar's right end, else at the side beside the
   * timeline. Its title never leaves the window (live verifier 2026-11-17).
   */
  _placeAbove() {
    if (this._placement !== 'above' || !this._root) return;
    const rectOf = (el) => (el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null);
    const host = this._container?.parentElement;
    const bar = rectOf(host?.querySelector?.('.player__controls'));
    const panel = rectOf(this._container);
    const style = this._root.style;
    if (!panel || !(panel.height > 0)) {
      // Nothing laid out to measure: on the bar, as before.
      this._dock = 'above';
      this._root.dataset.dock = 'above';
      style.setProperty('--fill-drawer-lift', `${Math.max(0, Math.round(bar?.height || 0))}px`);
      return;
    }
    let topLimit = 0;
    for (const sel of ['.player__top-bar', '.player__queue-toggle']) {
      const r = rectOf(host?.querySelector?.(sel));
      if (r && r.height > 0) topLimit = Math.max(topLimit, r.bottom + TOP_GAP_PX);
    }
    const p = dockedDrawerPlacement({
      editorTop: panel.top,
      editorBottom: panel.bottom,
      barTop: bar && bar.height > 0 ? bar.top : panel.top,
      topLimit,
      chrome: this._chromeHeight(),
    });
    this._dock = p.mode;
    this._root.dataset.dock = p.mode;
    if (p.mode === 'side') {
      style.setProperty('--fill-drawer-top', `${Math.ceil(p.top - panel.top)}px`);
    } else {
      style.setProperty('--fill-drawer-lift', `${Math.max(0, panel.top - (p.top + p.height))}px`);
      style.setProperty('--fill-drawer-h', `${p.height}px`);
    }
  }

  /** The drawer's height without its scrolling body (title, hint, summary, buttons), at least the floor. */
  _chromeHeight() {
    let h = 2; // the borders
    for (const el of this._root?.children || []) {
      if (!el.classList.contains('fill-drawer__body')) h += el.getBoundingClientRect?.().height || 0;
    }
    return Math.max(FILL_DRAWER_CHROME_PX, Math.ceil(h));
  }

  /** 'side': fixed in the window from the toolbar's bottom edge down (the title strip and a wrapped toolbar included). */
  _placeSide() {
    if (this._placement !== 'side' || !this._root) return;
    const bar = this._container?.querySelector(':scope > .editor__toolbar');
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    this._root.style.top = `${Math.max(0, Math.round(top))}px`;
  }

  /** Bring the selected stretch into view (pan, or zoom out when it is wider than the view). */
  _revealWindow() {
    const g = this._graph;
    if (!g?.setViewport) return;
    const win = this._window(this._getActions?.() || []);
    if (!win) return;
    const span = win.endMs - win.startMs;
    const view = g.viewDurationMs;
    if (win.startMs >= g.viewStartMs && win.endMs <= g.viewEndMs) return;
    if (span * 1.1 <= view) {
      const mid = (win.startMs + win.endMs) / 2;
      g.setViewport(mid - view / 2, mid + view / 2);
    } else {
      const pad = span * 0.05;
      g.setViewport(win.startMs - pad, win.endMs + pad);
    }
    this._redraw();
  }

  // ---------------------------------------------------------------- DOM

  _el(tag, cls, attrs = {}) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    return el;
  }

  /** A label / output head and a range input under it. */
  _slider({ name, labelKey, min, max, step, onInput }) {
    const row = this._el('div', `fill-drawer__row fill-drawer__row--${name}`);
    const head = this._el('div', 'fill-drawer__row-head');
    const id = `${this._id}-${name}`;
    const label = this._el('label', 'fill-drawer__label', { for: id, 'data-i18n': labelKey, text: t(labelKey) });
    const out = this._el('output', 'fill-drawer__value', { for: id });
    head.append(label, out);
    const input = this._el('input', 'fill-drawer__range', { type: 'range', id, min, max, step });
    input.addEventListener('input', () => { onInput(Number(input.value)); this._schedule(); });
    input.addEventListener('change', () => this._schedule());
    row.append(head, input);
    return { row, head, input, out };
  }

  _check({ name, labelKey, onChange }) {
    const label = this._el('label', `fill-drawer__check fill-drawer__check--${name}`);
    const input = this._el('input', null, { type: 'checkbox', id: `${this._id}-${name}` });
    const text = this._el('span', null, { 'data-i18n': labelKey, text: t(labelKey) });
    input.addEventListener('change', () => { onChange(input.checked); this._schedule(); });
    label.append(input, text);
    return { label, input };
  }

  _radios({ name, legendKey, choices, onChange }) {
    const set = this._el('fieldset', `fill-drawer__choice fill-drawer__choice--${name}`);
    const legend = this._el('legend', 'fill-drawer__label', { 'data-i18n': legendKey, text: t(legendKey) });
    set.appendChild(legend);
    const inputs = {};
    for (const [value, key] of choices) {
      const label = this._el('label', 'fill-drawer__radio');
      const input = this._el('input', null, { type: 'radio', name: `${this._id}-${name}`, value });
      input.addEventListener('change', () => { if (input.checked) { onChange(value); this._schedule(); } });
      label.append(input, this._el('span', null, { 'data-i18n': key, text: t(key) }));
      set.appendChild(label);
      inputs[value] = input;
    }
    return { set, inputs };
  }

  _build() {
    const root = this._el('aside', `fill-drawer fill-drawer--${this._placement}`, {
      role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': `${this._id}-title`,
    });
    root.hidden = true;

    // Header: title + close.
    const header = this._el('div', 'fill-drawer__header');
    const title = this._el('h2', 'fill-drawer__title', { id: `${this._id}-title`, 'data-i18n': 'editor.patternFill.title', text: t('editor.patternFill.title') });
    const close = this._el('button', 'fill-drawer__close', { type: 'button' });
    close.appendChild(icon(X, { width: 16, height: 16, 'stroke-width': 2, 'aria-hidden': 'true' }));
    close.addEventListener('click', () => this.close('cancel'));
    this._closeBtn = close;
    header.append(title, close);
    const hint = this._el('p', 'fill-drawer__hint', { 'data-i18n': 'editor.patternFill.editingPaused', text: t('editor.patternFill.editingPaused') });

    const body = this._el('div', 'fill-drawer__body');

    // Find: search + group.
    const find = this._el('div', 'fill-drawer__find');
    this._search = this._el('input', 'fill-drawer__search', {
      type: 'search', 'data-i18n-placeholder': 'editor.patternFill.search', 'data-i18n-aria-label': 'editor.patternFill.search',
      placeholder: t('editor.patternFill.search'), 'aria-label': t('editor.patternFill.search'), 'aria-controls': `${this._id}-list`,
    });
    this._search.addEventListener('input', () => this._renderList());
    this._family = this._el('select', 'fill-drawer__family', { 'data-i18n-aria-label': 'editor.patternFill.family', 'aria-label': t('editor.patternFill.family') });
    this._family.addEventListener('change', () => this._renderList());
    find.append(this._search, this._family);

    // Pattern list.
    this._list = this._el('div', 'fill-drawer__list', {
      id: `${this._id}-list`, role: 'listbox', 'data-i18n-aria-label': 'editor.patternFill.patterns', 'aria-label': t('editor.patternFill.patterns'),
      'data-owns-keys': 'navigation',
    });
    this._list.addEventListener('click', (e) => {
      const opt = e.target.closest?.('[role="option"]');
      if (opt) this._choose(opt.dataset.id, { focus: true });
    });
    this._list.addEventListener('keydown', (e) => this._onListKey(e));
    this._empty = this._el('p', 'fill-drawer__empty');
    this._empty.hidden = true;

    // Controls.
    const controls = this._el('div', 'fill-drawer__controls');
    const s = () => this._state;

    this._speed = this._slider({ name: 'speed', labelKey: 'editor.patternFill.speed', min: 10, max: FILL_SLIDER_MAX, step: 1, onInput: (v) => { s().speed = v; this._writeOutputs(); } });
    this._speedOwn = this._el('p', 'fill-drawer__sub');
    this._speed.row.appendChild(this._speedOwn);
    this._buildTempoRow();

    this._ramp = this._slider({ name: 'ramp', labelKey: 'editor.patternFill.rampTo', min: 10, max: FILL_SLIDER_MAX, step: 1, onInput: (v) => { s().rampTo = v; this._writeOutputs(); } });
    this._rampCheck = this._el('input', 'fill-drawer__inline-check', { type: 'checkbox', id: `${this._id}-ramp-on` });
    this._rampCheck.addEventListener('change', () => { s().rampOn = this._rampCheck.checked; this._syncControls(); this._schedule(); });
    // "Ramp to" is the on / off checkbox's label; the slider is named by the
    // same words. The text sits in its own span: a language switch rewrites
    // a [data-i18n] element's whole text, which would drop the checkbox.
    const rampLabel = this._ramp.head.querySelector('label');
    rampLabel.setAttribute('for', `${this._id}-ramp-on`);
    rampLabel.removeAttribute('data-i18n');
    rampLabel.textContent = '';
    rampLabel.append(this._rampCheck, this._el('span', null, { 'data-i18n': 'editor.patternFill.rampTo', text: t('editor.patternFill.rampTo') }));
    this._ramp.input.setAttribute('data-i18n-aria-label', 'editor.patternFill.rampTo');
    this._ramp.input.setAttribute('aria-label', t('editor.patternFill.rampTo'));

    this._reverse = this._check({ name: 'reverse', labelKey: 'editor.patternFill.reverse', onChange: (v) => { s().reversed = v; } });

    // Range: the pattern's own, or a bottom and a top of your own.
    const rangeRow = this._el('div', 'fill-drawer__row fill-drawer__row--range');
    const rangeHead = this._el('div', 'fill-drawer__row-head');
    rangeHead.append(
      this._el('span', 'fill-drawer__label', { 'data-i18n': 'editor.patternFill.range', text: t('editor.patternFill.range'), id: `${this._id}-range-label` }),
      (this._rangeOut = this._el('output', 'fill-drawer__value')),
    );
    this._rangeOwn = this._check({ name: 'range-own', labelKey: 'editor.patternFill.rangeOwn', onChange: (v) => { s().rangeOwn = v; this._syncControls(); } });
    const mkRange = (name, key) => {
      const input = this._el('input', 'fill-drawer__range', {
        type: 'range', min: 0, max: 100, step: 1, id: `${this._id}-${name}`,
        'aria-label': t(key), 'data-i18n-aria-label': key,
      });
      return input;
    };
    this._rangeMin = mkRange('range-min', 'editor.patternFill.rangeMin');
    this._rangeMax = mkRange('range-max', 'editor.patternFill.rangeMax');
    this._rangeMin.addEventListener('input', () => { s().rangeMin = Number(this._rangeMin.value); this._writeOutputs(); this._schedule(); });
    this._rangeMax.addEventListener('input', () => { s().rangeMax = Number(this._rangeMax.value); this._writeOutputs(); this._schedule(); });
    const rangePair = this._el('div', 'fill-drawer__range-pair');
    rangePair.append(this._rangeMin, this._rangeMax);
    rangeRow.append(rangeHead, this._rangeOwn.label, rangePair);

    this._variation = this._slider({ name: 'variation', labelKey: 'editor.patternFill.variation', min: 0, max: 2, step: 0.1, onInput: (v) => { s().variation = v; this._writeOutputs(); } });

    const seedRow = this._el('div', 'fill-drawer__row fill-drawer__row--seed');
    const seedHead = this._el('div', 'fill-drawer__row-head');
    this._seedOut = this._el('output', 'fill-drawer__value', { 'aria-live': 'off' });
    this._reroll = this._el('button', 'fill-drawer__btn fill-drawer__btn--small', {
      type: 'button', 'data-i18n': 'editor.patternFill.reroll', text: t('editor.patternFill.reroll'),
      'data-i18n-title': 'editor.patternFill.rerollTitle', title: t('editor.patternFill.rerollTitle'),
    });
    this._reroll.addEventListener('click', () => {
      // A new seed, never the same one twice in a row.
      let next = s().seed;
      while (next === s().seed) next = 1 + Math.floor(Math.random() * 9999);
      s().seed = next;
      this._writeOutputs();
      this._schedule();
    });
    seedHead.append(
      this._el('span', 'fill-drawer__label', { 'data-i18n': 'editor.patternFill.seed', text: t('editor.patternFill.seed') }),
      this._seedOut, this._reroll,
    );
    seedRow.appendChild(seedHead);

    this._join = this._slider({ name: 'join', labelKey: 'editor.patternFill.join', min: 0, max: 1, step: 0.05, onInput: (v) => { s().join = v; this._writeOutputs(); } });

    this._endFit = this._radios({
      name: 'end-fit', legendKey: 'editor.patternFill.endFit',
      choices: [['stretch', 'editor.patternFill.endFitStretch'], ['partial', 'editor.patternFill.endFitPartial']],
      onChange: (v) => { s().endFit = v; },
    });
    this._mode = this._radios({
      name: 'mode', legendKey: 'editor.patternFill.mode',
      choices: [['replace', 'editor.patternFill.modeReplace'], ['gap', 'editor.patternFill.modeGap']],
      onChange: (v) => { s().mode = v; },
    });

    controls.append(
      this._speed.row, this._tempoRow, this._ramp.row, this._reverse.label, rangeRow,
      this._variation.row, seedRow, this._join.row, this._endFit.set, this._mode.set,
    );
    body.append(find, this._list, this._empty, controls);

    // Summary (always in sight) and the two buttons. It changes on every
    // preview frame, so it is not a live region itself: a hidden copy is,
    // and is written once the summary has stayed the same for ANNOUNCE_MS
    // (a dragged slider is read out once, not 60 times a second).
    this._summary = this._el('div', 'fill-drawer__summary');
    this._selLine = this._el('p', 'fill-drawer__sel');
    this._statsLine = this._el('p', 'fill-drawer__stats');
    this._updatingEl = this._el('p', 'fill-drawer__updating', { 'data-i18n': 'editor.patternFill.updating', text: t('editor.patternFill.updating') });
    this._updatingEl.hidden = true;
    this._warnList = this._el('ul', 'fill-drawer__warnings');
    this._announce = this._el('p', 'fill-drawer__announce', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    this._summary.append(this._selLine, this._statsLine, this._updatingEl, this._warnList, this._announce);

    const footer = this._el('div', 'fill-drawer__footer');
    this._cancelBtn = this._el('button', 'fill-drawer__btn', { type: 'button', 'data-i18n': 'common.cancel', text: t('common.cancel') });
    this._cancelBtn.addEventListener('click', () => this.close('cancel'));
    this._applyBtn = this._el('button', 'fill-drawer__btn fill-drawer__btn--primary', { type: 'button', 'data-i18n': 'editor.patternFill.apply', text: t('editor.patternFill.apply') });
    this._applyBtn.addEventListener('click', () => this.apply());
    footer.append(this._cancelBtn, this._applyBtn);

    root.append(header, hint, body, this._summary, footer);

    // Esc closes; Ctrl+Enter applies (Enter alone chooses in the list or
    // presses a button). A key the focused control uses stays in the drawer:
    // a 3 typed in the search box, a slider's arrows, Space on a button or a
    // checkbox. Any other key goes on to the player as with the drawer
    // closed (Space on a slider pauses, F fullscreen, M mute...; review-2).
    // The timeline is not on the way, so no key from here edits the script;
    // the pop-out's window handler leaves the drawer's keys alone.
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.close('cancel');
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.stopPropagation();
        e.preventDefault();
        this.apply();
      } else if (drawerControlOwnsKey(e)) {
        e.stopPropagation();
      }
    });
    root.addEventListener('contextmenu', (e) => e.stopPropagation());

    this._container.appendChild(root);
    this._root = root;
    this._fillFamilies();
    this._retranslate();
  }

  _fillFamilies() {
    const keep = this._family.value;
    this._family.replaceChildren();
    const all = this._el('option', null, { value: '', text: t('editor.patternFill.allFamilies') });
    this._family.appendChild(all);
    for (const f of listFamilies()) {
      this._family.appendChild(this._el('option', null, { value: f.id, text: t(f.nameKey) }));
    }
    this._family.value = keep || '';
  }

  /** The list for the search text and group; the chosen pattern stays chosen even when filtered out. */
  _renderList() {
    if (!this._root) return;
    const q = fold(this._search.value.trim());
    const fam = this._family.value || undefined;
    // The group's whole name on hover, should it still not fit.
    this._family.title = this._family.selectedOptions?.[0]?.textContent || '';
    const rows = [];
    for (const p of listPatterns(fam ? { family: fam } : {})) {
      const d = describePattern(p.id);
      const name = this._patternName(p.id);
      const desc = d?.descKey ? t(d.descKey) : '';
      if (q && !fold(`${name} ${desc}`).includes(q)) continue;
      rows.push({ id: p.id, name, desc });
    }
    this._observer?.disconnect?.();
    this._list.replaceChildren();
    const chosen = this._state?.patternId;
    for (const r of rows) {
      const opt = this._el('div', 'fill-drawer__option', {
        role: 'option', id: `${this._id}-opt-${r.id}`, 'aria-selected': r.id === chosen ? 'true' : 'false', title: r.desc,
      });
      opt.dataset.id = r.id;
      opt.tabIndex = -1;
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'fill-drawer__spark');
      svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const text = this._el('span', 'fill-drawer__option-text');
      text.append(
        this._el('span', 'fill-drawer__option-name', { text: r.name }),
        this._el('span', 'fill-drawer__option-desc', { text: r.desc }),
      );
      opt.append(svg, text);
      this._list.appendChild(opt);
    }
    // One option takes Tab: the chosen one when shown, else the first.
    const tabStop = this._list.querySelector('[aria-selected="true"]') || this._list.querySelector('[role="option"]');
    if (tabStop) tabStop.tabIndex = 0;
    this._empty.hidden = rows.length > 0;
    if (!rows.length) this._empty.textContent = t('editor.patternFill.noMatch', { query: this._search.value.trim() });
    this._drawSparklines();
  }

  /** Sparklines are drawn when their row scrolls into view, each pattern once a session. */
  _drawSparklines() {
    const draw = (opt) => {
      const svg = opt.querySelector('svg');
      if (!svg || svg.firstChild) return;
      const pts = sparklinePoints(opt.dataset.id);
      if (!pts) return;
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('points', pts);
      svg.appendChild(line);
    };
    const opts = [...this._list.querySelectorAll('[role="option"]')];
    if (typeof IntersectionObserver === 'function') {
      this._observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          draw(e.target);
          this._observer.unobserve(e.target);
        }
      }, { root: this._list, rootMargin: '64px 0px' });
      for (const o of opts) this._observer.observe(o);
    } else {
      // No observer: a few rows per tick, after the drawer has painted.
      let i = 0;
      const step = () => {
        if (!this._root) return;
        for (let n = 0; n < 8 && i < opts.length; n++, i++) if (opts[i].isConnected) draw(opts[i]);
        if (i < opts.length) setTimeout(step, 0);
      };
      setTimeout(step, 0);
    }
  }

  _onListKey(e) {
    const opts = [...this._list.querySelectorAll('[role="option"]')];
    if (!opts.length) return;
    const at = opts.indexOf(document.activeElement);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown': next = Math.min(opts.length - 1, at + 1); break;
      case 'ArrowUp': next = Math.max(0, at - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = opts.length - 1; break;
      case 'Enter':
      case ' ':
        if (at >= 0) { e.preventDefault(); this._choose(opts[at].dataset.id, { focus: true }); }
        return;
      default: return;
    }
    e.preventDefault();
    if (next >= 0) this._choose(opts[next].dataset.id, { focus: true });
  }

  /** A pattern is chosen: speed, ramp and range go back to its own; the preview follows. */
  _choose(id, { focus = false } = {}) {
    if (!id || !describePattern(id)) return;
    const s = this._state;
    if (s.patternId !== id) {
      Object.assign(s, this._patternDefaults(id), { patternId: id });
      this._syncControls();
    }
    for (const opt of this._list.querySelectorAll('[role="option"]')) {
      const on = opt.dataset.id === id;
      opt.setAttribute('aria-selected', on ? 'true' : 'false');
      opt.tabIndex = on ? 0 : -1;
      if (on) {
        if (focus) opt.focus();
        opt.scrollIntoView?.({ block: 'nearest' });
      }
    }
    this._schedule();
  }

  /**
   * Tempo (editor work list 4.7, 2026-11-24): a BPM sets the Speed to one
   * stroke per beat over the fill's depth; From the beats reads the BPM off
   * the beat markers inside the stretch (the editor's Generate from Beats /
   * beat detection). The Speed slider stays free to move afterwards.
   */
  _buildTempoRow() {
    this._tempoRow = this._el('div', 'fill-drawer__row fill-drawer__tempo');
    const label = this._el('label', 'fill-drawer__label', { for: `${this._id}-bpm` });
    label.textContent = t('editor.patternFill.tempo');
    label.setAttribute('data-i18n', 'editor.patternFill.tempo');
    this._bpm = this._el('input', 'fill-drawer__bpm', {
      type: 'number', id: `${this._id}-bpm`, min: String(TEMPO_MIN_BPM), max: String(TEMPO_MAX_BPM), step: '1', inputmode: 'numeric',
      placeholder: 'BPM',
    });
    this._bpmBeats = this._el('button', 'fill-drawer__btn fill-drawer__btn--small fill-drawer__bpm-beats', { type: 'button' });
    this._bpmBeats.textContent = t('editor.patternFill.tempoFromBeats');
    this._bpmBeats.setAttribute('data-i18n', 'editor.patternFill.tempoFromBeats');
    this._tempoNote = this._el('p', 'fill-drawer__sub');
    this._bpm.addEventListener('change', () => this._applyTempo(Number(this._bpm.value)));
    this._bpmBeats.addEventListener('click', () => {
      const w = this._window(this._getActions?.() || []);
      const bpm = w ? bpmFromBeats(this._graph?._beatMarkers || null, w.startMs, w.endMs) : null;
      if (bpm === null) {
        this._tempoNote.textContent = t('editor.patternFill.tempoNoBeats');
        return;
      }
      this._bpm.value = String(bpm);
      this._applyTempo(bpm);
    });
    this._tempoRow.append(label, this._bpm, this._bpmBeats, this._tempoNote);
  }

  /** Speed from a BPM over the fill's depth (the chosen range, or the pattern's own). */
  _applyTempo(bpm) {
    const s = this._state;
    if (!s) return;
    const depth = Math.abs((s.rangeMax ?? 100) - (s.rangeMin ?? 0)) || 100;
    const speed = speedForBpm(bpm, depth, { min: s.speedMin ?? 10, max: s.speedMax ?? FILL_SLIDER_MAX });
    if (speed === null) {
      this._tempoNote.textContent = t('editor.patternFill.tempoRange', { min: TEMPO_MIN_BPM, max: TEMPO_MAX_BPM });
      return;
    }
    s.speed = speed;
    this._tempoNote.textContent = t('editor.patternFill.tempoSet', { bpm: Math.round(bpm), speed });
    this._syncControls();
    this._writeOutputs?.();
    this._schedule();
  }

  /** Every control from the state (open, pattern change, a toggle that disables others). */
  _syncControls() {
    if (!this._root || !this._state) return;
    const s = this._state;
    for (const [ctl, min, max] of [[this._speed, s.speedMin, s.speedMax], [this._ramp, s.speedMin, s.speedMax]]) {
      ctl.input.min = String(min);
      ctl.input.max = String(max);
    }
    this._speed.input.value = String(s.speed === null ? s.own : s.speed);
    this._rampCheck.checked = s.rampOn;
    this._ramp.input.disabled = !s.rampOn;
    this._ramp.input.value = String(s.rampTo);
    this._reverse.input.checked = s.reversed;
    this._rangeOwn.input.checked = s.rangeOwn;
    this._rangeMin.disabled = s.rangeOwn;
    this._rangeMax.disabled = s.rangeOwn;
    this._rangeMin.value = String(s.rangeMin);
    this._rangeMax.value = String(s.rangeMax);
    this._variation.input.value = String(s.variation);
    this._join.input.value = String(s.join);
    this._endFit.inputs[s.endFit].checked = true;
    this._mode.inputs[s.mode].checked = true;
    this._writeOutputs();
  }

  /** The value read-outs beside the controls (cheap: on every input event). */
  _writeOutputs() {
    if (!this._root || !this._state) return;
    const s = this._state;
    const speed = s.speed === null ? s.own : s.speed;
    this._speed.out.textContent = t('editor.patternFill.speedValue', { speed: Math.round(speed) });
    this._speedOwn.textContent = t('editor.patternFill.ownSpeed', { speed: s.own });
    this._ramp.out.textContent = s.rampOn ? t('editor.patternFill.speedValue', { speed: Math.round(s.rampTo) }) : t('editor.patternFill.rampOff');
    const lo = Math.min(s.rangeMin, s.rangeMax);
    const hi = Math.max(s.rangeMin, s.rangeMax);
    this._rangeOut.textContent = `${lo}–${hi}`;
    this._variation.out.textContent = this._num(s.variation, 1);
    this._seedOut.textContent = String(s.seed);
    this._join.out.textContent = `${Math.round(s.join * 100)}%`;
  }

  _num(v, digits) {
    try {
      return new Intl.NumberFormat(getCurrentLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    } catch {
      return v.toFixed(digits);
    }
  }

  /** The selection, the result and any warnings, in plain words. */
  _showSummary(r) {
    if (!this._root) return;
    this._warnList.replaceChildren();
    const warn = (key, values) => this._warnList.appendChild(this._el('li', null, { text: t(key, values) }));
    if (!r) {
      this._selLine.textContent = t('editor.patternFill.needSelection');
      this._statsLine.textContent = '';
      this._applyBtn.disabled = true;
      this._queueAnnounce();
      return;
    }
    const { res, win, options } = r;
    // A marked time range says so ("Time range: 4.0 s, no points").
    this._selLine.textContent = t(win.range ? 'editor.patternFill.rangeSelection' : 'editor.patternFill.selection', {
      seconds: this._num((win.endMs - win.startMs) / 1000, 1), count: win.points,
    });
    const codes = new Set((res.warnings || []).map((w) => w.code));
    if (res.inserted.length) {
      let line = t('editor.patternFill.stats', { points: res.inserted.length, mean: res.stats?.mean || 0, max: res.stats?.max || 0 });
      // Its own sentence on its own line (it ran into the stats: "… units/s Replaces 6 points.").
      if (options.mode !== 'gap' && res.removed?.length) line += `\n${t('editor.patternFill.replaces', { count: res.removed.length })}`;
      this._statsLine.textContent = line;
      if (codes.has('end-fit-partial')) warn('editor.patternFill.endFitFallback');
      if (codes.has('join-too-fast')) warn('editor.patternFill.joinTooFast');
      if (codes.has('speed-capped')) warn('editor.patternFill.speedCapped', { max: Math.round(res.stats?.cap || PATTERN_SPEED_CEILING) });
      if (codes.has('speed-unreachable')) warn('editor.patternFill.speedUnreachable');
      if (codes.has('range-widened') || codes.has('range-clipped')) warn('editor.patternFill.rangeAdjusted');
    } else {
      this._statsLine.textContent = '';
      if (codes.has('no-gap')) warn('editor.patternFill.noGap');
      else if (codes.has('too-short')) warn('editor.patternFill.tooShort');
      else warn('editor.patternFill.failed');
    }
    this._applyBtn.disabled = res.inserted.length === 0 || this._busy;
    this._queueAnnounce();
  }

  /** Read the summary out once it has stopped changing (the live region is a hidden copy). */
  _queueAnnounce() {
    clearTimeout(this._announceTimer);
    this._announceTimer = setTimeout(() => {
      this._announceTimer = 0;
      if (!this._isOpen || !this._announce) return;
      const words = [this._selLine.textContent, this._statsLine.textContent,
        ...[...this._warnList.children].map((li) => li.textContent)].filter(Boolean).join(' ');
      if (this._announce.textContent !== words) this._announce.textContent = words;
    }, ANNOUNCE_MS);
  }

  /** A language switch: the words that are written from state (the rest carry data-i18n). */
  _retranslate() {
    if (!this._root) return;
    const label = t('modal.closeAria', { title: t('editor.patternFill.title') });
    this._closeBtn.setAttribute('aria-label', label);
    this._closeBtn.title = label;
    this._fillFamilies();
    if (this._state) {
      this._renderList();
      this._writeOutputs();
      this._showSummary(this._result);
    }
  }
}
