// Inline script visualization — TL (windowed timeline graph) + HM (full-
// duration heatmap strip) shown during NORMAL playback, outside the editor.
// zaikechi (EroScripts #209 + DM); reference design: ScriptPlayer+ v0.3.0's
// independent TL/HM toggles. See SCOPE-inline-viz-and-script-mapping.md.
//
// Crucially NOT the editor: no pause, no Up Next suppression, no editing.
// The whole overlay is pointer-events:none — pure display; interaction
// stays on the seek bar. TL reuses the editor's ActionGraph in a read-only
// mount (no pointer wiring — the editor attaches its handlers externally,
// so a bare ActionGraph is already non-interactive), which guarantees
// visual parity with the editor for free. HM uses the seek-bar heatmap's
// exact per-action-pair algorithm AND colour scale (see _renderHeatmap) so
// both show identical detail in identical colours.

import { ActionGraph } from '../js/action-graph.js';
import { heatmapSpeedToColor } from '../js/heatmap-palette.js';

/** The TL's window width for every new video: the editor's OFS default (5 s). */
export const INLINE_VIEW_MS = 5000;

/**
 * The Timeline overlay's own zoom and playhead (zaikechi #381, 2026-11-22),
 * Settings > Playback: how many seconds it shows, and where the playhead
 * sits: in the middle (as the editor, OFS-style) or near the left edge, so
 * more of what is coming shows than of what has passed.
 */
export const INLINE_WINDOW_CHOICES_MS = [5000, 10000, 20000, 30000];
export const INLINE_PLAYHEAD_LEAD = { centre: 0.5, left: 0.2 };

/** A saved or sent view, made safe: an unknown window is 5 s, an unknown anchor the middle. */
export function normalizeTimelineView(view) {
  const ms = Number(view?.windowMs);
  return {
    windowMs: INLINE_WINDOW_CHOICES_MS.includes(ms) ? ms : INLINE_VIEW_MS,
    anchor: view?.anchor === 'left' ? 'left' : 'centre',
  };
}

/** The viewport for playback time `ms`: the window, with the playhead at its lead share. */
export function timelineViewport(ms, view) {
  const v = normalizeTimelineView(view);
  const start = ms - v.windowMs * INLINE_PLAYHEAD_LEAD[v.anchor];
  return { start, end: start + v.windowMs };
}

/**
 * Where the HM playhead marker sits, as a 0..1 share of the strip: the
 * playback position over the VIDEO duration, the same mapping the strip's
 * rects use (so the marker lands on the stroke being played). Clamped, and 0
 * while the duration is unknown.
 */
export function heatmapPlayheadFraction(timeMs, durationMs) {
  if (!(durationMs > 0) || !Number.isFinite(timeMs)) return 0;
  return Math.min(1, Math.max(0, timeMs / durationMs));
}

export class InlineViz {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.container — the player container element
   * @param {HTMLVideoElement} deps.video
   */
  constructor({ container, video }) {
    this._video = video;
    this._actions = null;
    this._durationMs = 0;
    this._raf = null;
    this._tlOn = false;
    this._hmOn = false;
    // Optional playhead marker on the HM strip (zaikechi #381,
    // `player.inlineHeatmapPlayhead`, off by default).
    this._hmPlayheadOn = false;
    // Over the video (the default) or under it (#381; Dave 2026-11-22):
    // `player.inlineVizPlacement`. Under it, the container gets
    // .player-container--viz-below and --inline-viz-band (the strip's height),
    // and player.css shortens the video to make room (_applyPlacement).
    this._container = container;
    this._placement = 'overlay';
    // The Timeline's window and playhead (#381): 5 s, centred, until set.
    this._view = normalizeTimelineView(null);

    this._root = document.createElement('div');
    this._root.className = 'inline-viz';
    this._root.hidden = true;
    this._root.setAttribute('aria-hidden', 'true');

    this._hmCanvas = document.createElement('canvas');
    this._hmCanvas.className = 'inline-viz__heatmap';
    this._hmCanvas.hidden = true;

    // The strip's playhead is an element positioned OVER the canvas, never
    // painted into it: the strip is cached (redrawn only on script, toggle or
    // resize), and its pixels are what heatmap-palette-parity.test.js holds to
    // the seek bar's. The wrap is only a positioning box for the two.
    this._hmWrap = document.createElement('div');
    this._hmWrap.className = 'inline-viz__heatmap-wrap';
    this._hmWrap.hidden = true;
    this._hmPlayhead = document.createElement('div');
    this._hmPlayhead.className = 'inline-viz__hm-playhead';
    this._hmPlayhead.hidden = true;
    this._hmWrap.append(this._hmCanvas, this._hmPlayhead);

    this._tlWrap = document.createElement('div');
    this._tlWrap.className = 'inline-viz__timeline';
    this._tlWrap.hidden = true;
    this._tlCanvas = document.createElement('canvas');
    this._tlWrap.appendChild(this._tlCanvas);

    this._root.append(this._hmWrap, this._tlWrap);
    container.appendChild(this._root);

    // Read-only shim satisfying ActionGraph's script interface
    // (actions + selection + bookmarks — nothing is ever selected here).
    this._shim = { actions: [], selectedIndices: new Set(), getBookmarks: () => [] };
    this._graph = new ActionGraph(this._tlCanvas, this._shim);

    // Drive the graph's cursor from the video clock with our own rAF loop
    // (only while playing AND the TL, or the HM playhead, is visible — zero
    // cost otherwise).
    // centerOnTime keeps the OFS-style centered playhead.
    this._onPlay = () => this._syncLoop();
    // Pause: stop the loop and draw once so the frozen frame is current.
    this._onStill = () => { this._stopLoop(); this._drawOnce(); };
    // Seek: redraw at the new position, then RESUME. `seeked` used to share
    // the pause handler, which killed the loop — and since `play` never
    // fires for a seek during playback, nothing restarted it. The timeline
    // jumped to the new spot and froze there while the video kept going
    // (Dave, 2026-08-06). `_syncLoop` already no-ops when the video really
    // is paused, so the seek-while-paused case is unchanged.
    this._onSeeked = () => { this._drawOnce(); this._syncLoop(); };
    video.addEventListener('play', this._onPlay);
    video.addEventListener('pause', this._onStill);
    video.addEventListener('seeked', this._onSeeked);

    // The TL box is re-measured only when it may have changed (see _fitCanvas):
    // a ResizeObserver callback on the root or the TL itself, a DPR change, or
    // a visibility toggle. Without a ResizeObserver (jsdom) it is read every frame.
    this._tlBoxDirty = true;
    this._resizeObserver = (typeof ResizeObserver !== 'undefined')
      ? new ResizeObserver(() => { this._tlBoxDirty = true; this._onResize(); })
      : null;
    this._resizeObserver?.observe(this._root);
    this._resizeObserver?.observe(this._tlWrap);
  }

  /** Load the current script's main-axis actions. durationSec = video duration. */
  setScript(actions, durationSec) {
    const clean = Array.isArray(actions) ? actions : [];
    this._actions = clean.length >= 2 ? clean : null;
    this._shim.actions = this._actions || [];
    this._durationMs = (durationSec && isFinite(durationSec)) ? durationSec * 1000 : 0;
    // The new video's length FIRST (0 = unknown, no clamp), then the TL's own
    // default window: the one graph lives for the whole session and the TL
    // has no zoom of its own, so a window a short video narrowed must not
    // carry over to the next one (Dave, 2026-11-18: the timeline "moves
    // wayyyyy faster than the video" after a video change).
    this._graph.setVideoDuration(this._durationMs);
    this._graph.setViewport(0, this._view.windowMs);
    this._updateVisibility();
    this._renderHeatmap();
    this._drawOnce();
    this._syncLoop();
  }

  /** No script for the current video — hide everything. */
  clear() {
    this._actions = null;
    this._shim.actions = [];
    this._durationMs = 0;
    this._stopLoop();
    this._updateVisibility();
  }

  setTimelineVisible(on) {
    this._tlOn = !!on;
    this._tlBoxDirty = true;
    this._updateVisibility();
    this._drawOnce();
    this._syncLoop();
  }

  setHeatmapVisible(on) {
    this._hmOn = !!on;
    this._updateVisibility();
    this._renderHeatmap();
    // The playhead marker moves with the clock, so the loop has to run for
    // the HM alone when the marker is on.
    this._drawOnce();
    this._syncLoop();
  }

  /** Show a playhead marker on the HM strip (`player.inlineHeatmapPlayhead`). */
  setHeatmapPlayhead(on) {
    this._hmPlayheadOn = !!on;
    this._updateVisibility();
    this._drawOnce();
    this._syncLoop();
  }

  /**
   * 'overlay' (over the bottom of the video, as always) or 'below' (the
   * video shrinks and the TL / HM sit in a strip under it, so nothing covers
   * the picture). Anything else is 'overlay'.
   */
  /** The Timeline's window and playhead (#381): `{ windowMs, anchor: 'centre' | 'left' }`. */
  setTimelineView(view) {
    this._view = normalizeTimelineView(view);
    this._graph.setViewport(0, this._view.windowMs);
    this._drawOnce();
  }

  get timelineView() { return { ...this._view }; }

  setPlacement(placement) {
    this._placement = placement === 'below' ? 'below' : 'overlay';
    this._applyPlacement();
  }

  get placement() { return this._placement; }

  /**
   * The container's class and band height for the placement. Only while the
   * strip is on screen: with nothing showing, the video keeps the whole
   * player. The band is the strip's own height, read whenever it may change
   * (visibility, a resize), so the video ends exactly where the strip starts.
   */
  _applyPlacement() {
    const c = this._container;
    if (!c?.classList) return;
    const below = this._placement === 'below' && !this._root.hidden;
    c.classList.toggle('player-container--viz-below', below);
    // The page root gets it too: the queue panel is not inside the player
    // container (only in fullscreen), and it must end above the control bar
    // the band lifts (full manual test, 2026-11-23: docked, the bar ran
    // under it).
    const root = c.ownerDocument?.documentElement;
    if (below) {
      const h = Math.ceil(this._root.getBoundingClientRect().height || this._root.offsetHeight || 0);
      c.style.setProperty('--inline-viz-band', `${h}px`);
      root?.style?.setProperty('--inline-viz-band-root', `${h}px`);
    } else {
      c.style.removeProperty('--inline-viz-band');
      root?.style?.removeProperty('--inline-viz-band-root');
    }
  }

  get timelineVisible() { return this._tlOn; }
  get heatmapVisible() { return this._hmOn; }
  get heatmapPlayheadVisible() { return this._hmPlayheadOn; }

  destroy() {
    this._stopLoop();
    this._resizeObserver?.disconnect();
    this._video.removeEventListener('play', this._onPlay);
    this._video.removeEventListener('pause', this._onStill);
    this._video.removeEventListener('seeked', this._onSeeked);
    this._root.remove();
    this._container?.classList?.remove('player-container--viz-below');
    this._container?.style?.removeProperty('--inline-viz-band');
    this._container?.ownerDocument?.documentElement?.style?.removeProperty('--inline-viz-band-root');
  }

  // ---- internals ----

  _hasScript() { return !!this._actions; }

  _updateVisibility() {
    const any = this._hasScript() && (this._tlOn || this._hmOn);
    this._root.hidden = !any;
    this._hmCanvas.hidden = !(this._hasScript() && this._hmOn);
    this._hmWrap.hidden = this._hmCanvas.hidden;
    this._hmPlayhead.hidden = this._hmCanvas.hidden || !this._hmPlayheadOn;
    this._tlWrap.hidden = !(this._hasScript() && this._tlOn);
    this._applyPlacement();
  }

  _tlActive() {
    return this._hasScript() && this._tlOn && !this._root.hidden && !this._covered;
  }

  _hmPlayheadActive() {
    return this._hasScript() && this._hmOn && this._hmPlayheadOn && !this._root.hidden && !this._covered;
  }

  /**
   * Something sits over the strip (the docked script editor): nothing to draw
   * there. Dave, 2026-11-25 ("speed up the player when in editor"): profiled
   * live, the strip drew every frame under the open editor, 538 ms of 5 s of
   * playback with six axes. Uncovered, it draws the moment at once.
   */
  setCovered(on) {
    const covered = on === true;
    if (covered === !!this._covered) return;
    this._covered = covered;
    if (!covered) {
      this._tlBoxDirty = true;
      this._drawOnce();
    }
    this._syncLoop();
  }

  /** Anything on screen that follows the clock. */
  _loopActive() {
    return this._tlActive() || this._hmPlayheadActive();
  }

  _syncLoop() {
    if (!this._loopActive() || this._video.paused) { this._stopLoop(); return; }
    if (this._raf) return; // already running
    const loop = () => {
      if (!this._loopActive() || this._video.paused) { this._raf = null; return; }
      if (this._tlActive()) this._drawFrame();
      if (this._hmPlayheadActive()) this._placeHeatmapPlayhead();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopLoop() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  _drawOnce() {
    if (this._tlActive()) this._drawFrame();
    if (this._hmPlayheadActive()) this._placeHeatmapPlayhead();
  }

  /** Move the HM marker to the current position (CSS %, so no DPR maths). */
  _placeHeatmapPlayhead() {
    const frac = heatmapPlayheadFraction((this._video.currentTime || 0) * 1000, this._durationMs);
    this._hmPlayhead.style.left = `${frac * 100}%`;
  }

  _drawFrame() {
    this._fitCanvas(this._tlCanvas, this._tlWrap);
    const ms = (this._video.currentTime || 0) * 1000;
    this._graph.setCursorTime(ms);
    // The window follows the playhead at its place (#381: the middle, or
    // near the left). The viewport's own clamps keep the start and the end
    // of a video inside it, as centerOnTime did.
    const { start, end } = timelineViewport(ms, this._view);
    this._graph.setViewport(start, end);
    this._graph.draw();
  }

  /**
   * Keep the timeline canvas matched to its CSS box (no-op when unchanged).
   *
   * Delegates to `ActionGraph.resize()` instead of writing `canvas.width`
   * here, because doing it directly got two things wrong:
   *
   *   1. DPR. The old code set `canvas.width = clientWidth` in CSS pixels,
   *      but ActionGraph derives its drawing area as `canvas.width / dpr`.
   *      On any display above 1x the graph therefore believed it had a
   *      fraction of the real width and drew across only part of it.
   *   2. Stale cache. ActionGraph caches `_cachedArea` and clears it ONLY in
   *      `resize()`. Assigning `canvas.width` left the old area in place, so
   *      growing the canvas (windowed → fullscreen) kept the graph drawing
   *      to the previous, narrower width.
   *
   * Together those are why the timeline points stopped short of the screen
   * edge in fullscreen (Dave, 2026-08-04).
   *
   * Keyed on the CSS box + DPR rather than comparing pixel sizes: the canvas
   * width setter truncates the float ActionGraph assigns, so a rounded
   * comparison could differ by a pixel and re-resize on every frame.
   *
   * The box is read only when it may have changed (2026-11-20). Reading
   * `clientWidth` / `clientHeight` forces a synchronous layout whenever
   * anything on the page changed since the last frame, and the device
   * simulator writes every frame, so this one read was ~21% of the renderer's
   * time during playback (CPU profile: 4.6 s self of 22 s). A ResizeObserver
   * (root and TL) marks it dirty; `devicePixelRatio` is read every frame, which
   * costs no layout. With no ResizeObserver (jsdom) it is read every frame.
   */
  _fitCanvas(canvas, box) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (this._resizeObserver && !this._tlBoxDirty && dpr === this._tlFitDpr) return;
    const w = box.clientWidth || 0;
    const h = box.clientHeight || 0;
    if (w <= 0 || h <= 0) return; // hidden or not laid out yet: stays dirty, tried again next frame
    this._tlBoxDirty = false;
    this._tlFitDpr = dpr;
    const key = `${w}x${h}@${dpr}`;
    if (this._tlFitKey === key) return;
    this._tlFitKey = key;
    this._graph.resize();
  }

  /**
   * Full-duration heatmap strip — SAME algorithm as the seek-bar heatmap
   * (progress-bar.js renderHeatmap): one rect per adjacent action pair,
   * variable width, sub-pixel positions with devicePixelRatio scaling,
   * mapped over the VIDEO duration (not the script span, so it aligns with
   * the seek bar even when a script starts late). An earlier revision
   * binned speeds into 240 fixed buckets, which read as blocky flat colour
   * next to the seek bar's per-action detail (Dave, 2026-08-04).
   * Colors via heatmapSpeedToColor, the seek bar's own scale, so a speed
   * looks the same in the strip and the seek bar under it. Until app test
   * V36 this used ActionGraph.speedToColor and went red at 0.3 pos/ms where
   * the seek bar was still yellow (EroScripts #381). The TL graph above it
   * stays on the editor's OFS palette, like the editor.
   */
  _renderHeatmap() {
    if (this._hmCanvas.hidden || !this._actions || !(this._durationMs > 0)) return;
    const canvas = this._hmCanvas;
    const cssW = canvas.clientWidth || 0;
    const cssH = canvas.clientHeight || 0;
    if (cssW === 0 || cssH === 0) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const actions = this._actions;
    const durationMs = this._durationMs;
    for (let i = 0; i < actions.length - 1; i++) {
      const a = actions[i];
      const b = actions[i + 1];
      const dt = b.at - a.at;
      if (dt <= 0) continue;
      const speed = Math.abs(b.pos - a.pos) / dt; // pos-units per ms
      const x1 = (a.at / durationMs) * cssW;
      const x2 = (b.at / durationMs) * cssW;
      ctx.fillStyle = heatmapSpeedToColor(speed);
      ctx.fillRect(x1, 0, Math.max(x2 - x1, 1), cssH);
    }
  }

  _onResize() {
    this._applyPlacement();
    this._renderHeatmap();
    this._drawOnce();
  }
}
