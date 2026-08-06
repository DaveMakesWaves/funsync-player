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
// exact per-action-pair algorithm (see _renderHeatmap) so both show
// identical detail.

import { ActionGraph } from '../js/action-graph.js';

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

    this._root = document.createElement('div');
    this._root.className = 'inline-viz';
    this._root.hidden = true;
    this._root.setAttribute('aria-hidden', 'true');

    this._hmCanvas = document.createElement('canvas');
    this._hmCanvas.className = 'inline-viz__heatmap';
    this._hmCanvas.hidden = true;

    this._tlWrap = document.createElement('div');
    this._tlWrap.className = 'inline-viz__timeline';
    this._tlWrap.hidden = true;
    this._tlCanvas = document.createElement('canvas');
    this._tlWrap.appendChild(this._tlCanvas);

    this._root.append(this._hmCanvas, this._tlWrap);
    container.appendChild(this._root);

    // Read-only shim satisfying ActionGraph's script interface
    // (actions + selection + bookmarks — nothing is ever selected here).
    this._shim = { actions: [], selectedIndices: new Set(), getBookmarks: () => [] };
    this._graph = new ActionGraph(this._tlCanvas, this._shim);

    // Drive the graph's cursor from the video clock with our own rAF loop
    // (only while playing AND the TL is visible — zero cost otherwise).
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

    this._resizeObserver = (typeof ResizeObserver !== 'undefined')
      ? new ResizeObserver(() => this._onResize())
      : null;
    this._resizeObserver?.observe(this._root);
  }

  /** Load the current script's main-axis actions. durationSec = video duration. */
  setScript(actions, durationSec) {
    const clean = Array.isArray(actions) ? actions : [];
    this._actions = clean.length >= 2 ? clean : null;
    this._shim.actions = this._actions || [];
    this._durationMs = (durationSec && isFinite(durationSec)) ? durationSec * 1000 : 0;
    if (this._durationMs > 0) {
      this._graph.setVideoDuration(this._durationMs);
    }
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
    this._updateVisibility();
    this._drawOnce();
    this._syncLoop();
  }

  setHeatmapVisible(on) {
    this._hmOn = !!on;
    this._updateVisibility();
    this._renderHeatmap();
  }

  get timelineVisible() { return this._tlOn; }
  get heatmapVisible() { return this._hmOn; }

  destroy() {
    this._stopLoop();
    this._resizeObserver?.disconnect();
    this._video.removeEventListener('play', this._onPlay);
    this._video.removeEventListener('pause', this._onStill);
    this._video.removeEventListener('seeked', this._onSeeked);
    this._root.remove();
  }

  // ---- internals ----

  _hasScript() { return !!this._actions; }

  _updateVisibility() {
    const any = this._hasScript() && (this._tlOn || this._hmOn);
    this._root.hidden = !any;
    this._hmCanvas.hidden = !(this._hasScript() && this._hmOn);
    this._tlWrap.hidden = !(this._hasScript() && this._tlOn);
  }

  _tlActive() {
    return this._hasScript() && this._tlOn && !this._root.hidden;
  }

  _syncLoop() {
    if (!this._tlActive() || this._video.paused) { this._stopLoop(); return; }
    if (this._raf) return; // already running
    const loop = () => {
      if (!this._tlActive() || this._video.paused) { this._raf = null; return; }
      this._drawFrame();
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
  }

  _drawFrame() {
    this._fitCanvas(this._tlCanvas, this._tlWrap);
    const ms = (this._video.currentTime || 0) * 1000;
    this._graph.setCursorTime(ms);
    this._graph.centerOnTime(ms);
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
   */
  _fitCanvas(canvas, box) {
    const w = box.clientWidth || 0;
    const h = box.clientHeight || 0;
    if (w <= 0 || h <= 0) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
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
   * Colors via ActionGraph.speedToColor — one palette across the strip,
   * seek bar, and editor lines.
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
      ctx.fillStyle = ActionGraph.speedToColor(speed);
      ctx.fillRect(x1, 0, Math.max(x2 - x1, 1), cssH);
    }
  }

  _onResize() {
    this._renderHeatmap();
    this._drawOnce();
  }
}
