// ActionGraph — Canvas-based time x position graph renderer for funscript editing
// OFS (OpenFunscripter) style: centered playhead, speed-colored lines, dark purple bg

export class ActionGraph {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./editable-script.js').EditableScript} editableScript
   */
  constructor(canvas, editableScript) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.script = editableScript;

    // Viewport (visible time window)
    this._viewStartMs = 0;
    this._viewEndMs = 5000; // OFS default: 5s view
    this._videoDurationMs = 0;

    // Playback cursor
    this._cursorMs = 0;

    // Hover state
    this._hoveredIndex = -1;
    this._hoverX = 0;
    this._hoverY = 0;

    // Rubber-band selection
    this._rubberBand = null; // { x1, y1, x2, y2 } in canvas coords

    // Waveform overlay
    this._waveformData = null; // WaveformData from waveform.js
    this._showWaveform = false;

    // Beat markers
    this._beatMarkers = null; // Float64Array of beat timestamps in ms
    this._showBeatMarkers = false;

    // Auto-follow playback cursor
    this._autoFollow = true;

    // Animation
    this._rafId = null;
    this._animating = false;

    // Smooth zoom easing
    this._targetViewDurationMs = null;
    this._zoomCenterMs = 0;
    this._zoomCenterRatio = 0.5;
    this._zoomStartTime = 0;
    this._zoomFromDuration = 0;

    // Drawing constants
    this._padding = { top: 10, right: 20, bottom: 28, left: 40 };
    this._dotRadius = 5;
    this._selectedDotRadius = 6;
    this._hitRadius = 8;

    // OFS Colors
    this._colors = {
      bg: 'rgb(60, 0, 60)',                    // OFS dark purple
      grid: 'rgba(255, 255, 255, 0.08)',
      gridLabel: 'rgba(255, 255, 255, 0.35)',
      dot: '#e94560',                           // red with dark border
      dotBorder: 'rgba(0, 0, 0, 0.8)',
      selectedDot: 'rgb(11, 252, 3)',           // OFS green
      selectedGlow: 'rgba(11, 252, 3, 0.3)',
      selectedLine: 'rgb(3, 194, 252)',         // cyan for selected segments
      hoveredDot: '#ff6b81',
      cursor: '#4caf50',
      rubberBand: 'rgba(3, 252, 207, 0.15)',   // OFS cyan
      rubberBandBorder: 'rgba(3, 252, 207, 0.5)',
      waveform: 'rgba(100, 180, 255, 0.35)',
      beatMarker: 'rgba(255, 140, 50, 0.5)',
    };
  }

  // --- Viewport ---

  get viewStartMs() { return this._viewStartMs; }
  get viewEndMs() { return this._viewEndMs; }
  get viewDurationMs() { return this._viewEndMs - this._viewStartMs; }

  setVideoDuration(durationMs) {
    this._videoDurationMs = durationMs;
    if (this._viewEndMs > durationMs) {
      this._viewEndMs = durationMs;
    }
  }

  setViewport(startMs, endMs) {
    const minDuration = 1000;  // OFS: 1s minimum
    const maxDuration = 300000; // OFS: 300s maximum
    let duration = Math.max(minDuration, Math.min(maxDuration, endMs - startMs));
    this._viewStartMs = Math.max(0, startMs);
    this._viewEndMs = this._viewStartMs + duration;
    if (this._videoDurationMs > 0 && this._viewEndMs > this._videoDurationMs) {
      this._viewEndMs = this._videoDurationMs;
      this._viewStartMs = Math.max(0, this._viewEndMs - duration);
    }
  }

  zoomAt(centerMs, factor) {
    const currentDuration = this.viewDurationMs;
    const newDuration = Math.max(1000, Math.min(300000, currentDuration * factor));

    if (this._animating) {
      // Smooth easing zoom during animation
      this._targetViewDurationMs = newDuration;
      this._zoomCenterMs = centerMs;
      this._zoomCenterRatio = (centerMs - this._viewStartMs) / currentDuration;
      this._zoomStartTime = performance.now();
      this._zoomFromDuration = currentDuration;
    } else {
      // Instant zoom when paused
      const ratio = (centerMs - this._viewStartMs) / currentDuration;
      const newStart = centerMs - newDuration * ratio;
      this.setViewport(newStart, newStart + newDuration);
      this.draw();
    }
  }

  panBy(deltaMs) {
    this.setViewport(this._viewStartMs + deltaMs, this._viewEndMs + deltaMs);
    this.draw();
  }

  centerOnTime(ms) {
    const half = this.viewDurationMs / 2;
    this.setViewport(ms - half, ms + half);
  }

  /** Fit viewport to show all actions (or full video if no actions). */
  fitAll() {
    const actions = this.script.actions;
    if (actions.length > 0) {
      const first = actions[0].at;
      const last = actions[actions.length - 1].at;
      const padding = Math.max(2000, (last - first) * 0.05);
      this.setViewport(first - padding, last + padding);
    } else if (this._videoDurationMs > 0) {
      this.setViewport(0, Math.min(this._videoDurationMs, 5000));
    } else {
      this.setViewport(0, 5000);
    }
    this.draw();
  }

  // --- Waveform ---

  /**
   * Set waveform peak data for rendering behind action lines.
   * @param {import('./waveform.js').WaveformData|null} data
   */
  setWaveformData(data) {
    this._waveformData = data;
  }

  /** Toggle waveform visibility. */
  setShowWaveform(show) {
    this._showWaveform = !!show;
  }

  get showWaveform() { return this._showWaveform; }

  // --- Beat markers ---

  /**
   * Set beat marker timestamps for rendering on the graph.
   * @param {Float64Array|null} beats — beat timestamps in ms
   */
  setBeatMarkers(beats) {
    this._beatMarkers = beats;
  }

  /** Toggle beat marker visibility. */
  setShowBeatMarkers(show) {
    this._showBeatMarkers = !!show;
  }

  get showBeatMarkers() { return this._showBeatMarkers; }

  // --- Coordinate mapping ---

  /** Canvas drawing area (excludes padding). */
  _drawArea() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    return {
      x: this._padding.left,
      y: this._padding.top,
      w: w - this._padding.left - this._padding.right,
      h: h - this._padding.top - this._padding.bottom,
    };
  }

  timeToX(ms) {
    const area = this._drawArea();
    return area.x + ((ms - this._viewStartMs) / this.viewDurationMs) * area.w;
  }

  xToTime(px) {
    const area = this._drawArea();
    return this._viewStartMs + ((px - area.x) / area.w) * this.viewDurationMs;
  }

  posToY(pos) {
    const area = this._drawArea();
    // Inverted: 100 at top, 0 at bottom
    return area.y + (1 - pos / 100) * area.h;
  }

  yToPos(py) {
    const area = this._drawArea();
    return Math.max(0, Math.min(100, (1 - (py - area.y) / area.h) * 100));
  }

  // --- Hit testing ---

  hitTestAction(x, y, radius) {
    radius = radius || this._hitRadius;
    const actions = this.script.actions;
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < actions.length; i++) {
      const ax = this.timeToX(actions[i].at);
      const ay = this.posToY(actions[i].pos);
      const dx = x - ax;
      const dy = y - ay;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < radius && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    return bestIdx;
  }

  hitTestRect(rect) {
    const indices = new Set();
    const actions = this.script.actions;
    const x1 = Math.min(rect.x1, rect.x2);
    const x2 = Math.max(rect.x1, rect.x2);
    const y1 = Math.min(rect.y1, rect.y2);
    const y2 = Math.max(rect.y1, rect.y2);

    for (let i = 0; i < actions.length; i++) {
      const ax = this.timeToX(actions[i].at);
      const ay = this.posToY(actions[i].pos);
      if (ax >= x1 && ax <= x2 && ay >= y1 && ay <= y2) {
        indices.add(i);
      }
    }

    return indices;
  }

  // --- Cursor ---

  setCursorTime(ms) {
    this._cursorMs = ms;
    // During playback, center viewport on cursor (OFS centered playhead)
    if (this._autoFollow && this._animating) {
      this.centerOnTime(ms);
    }
  }

  // --- Hover / Rubber band ---

  setHover(index, x, y) {
    this._hoveredIndex = index;
    this._hoverX = x;
    this._hoverY = y;
  }

  clearHover() {
    this._hoveredIndex = -1;
  }

  setRubberBand(rect) {
    this._rubberBand = rect;
  }

  clearRubberBand() {
    this._rubberBand = null;
  }

  // --- Animation ---

  startAnimation() {
    if (this._animating) return;
    this._animating = true;
    const loop = () => {
      if (!this._animating) return;
      this._updateZoomEasing();
      this.draw();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stopAnimation() {
    this._animating = false;
    this._targetViewDurationMs = null;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Process smooth zoom interpolation each frame. */
  _updateZoomEasing() {
    if (this._targetViewDurationMs === null) return;

    const elapsed = performance.now() - this._zoomStartTime;
    const duration = 150; // ms
    const t = Math.min(1, elapsed / duration);
    // easeOutExpo
    const ease = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);

    const currentDuration = this._zoomFromDuration + (this._targetViewDurationMs - this._zoomFromDuration) * ease;
    const newStart = this._zoomCenterMs - currentDuration * this._zoomCenterRatio;
    this.setViewport(newStart, newStart + currentDuration);

    if (t >= 1) {
      this._targetViewDurationMs = null;
    }
  }

  // --- Resize ---

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.draw();
  }

  // --- Speed to color (OFS heatmap gradient) ---

  /**
   * Map action speed to OFS 6-stop heatmap color.
   * Speed is |deltaPos| / deltaTime (pos-units per millisecond).
   * @param {number} speed — pos/ms
   * @returns {string} CSS color
   */
  static speedToColor(speed) {
    // Normalize speed: 0 = still, ~0.3 = max intensity
    const t = Math.min(1, speed / 0.3);

    // 6-stop gradient: Black → Blue → Cyan → Green → Yellow → Red
    const stops = [
      [0, 0, 0],       // 0.0 — black
      [0, 0, 255],     // 0.2 — blue
      [0, 255, 255],   // 0.4 — cyan
      [0, 255, 0],     // 0.6 — green
      [255, 255, 0],   // 0.8 — yellow
      [255, 0, 0],     // 1.0 — red
    ];

    const idx = t * (stops.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, stops.length - 1);
    const frac = idx - lo;

    const r = Math.round(stops[lo][0] + (stops[hi][0] - stops[lo][0]) * frac);
    const g = Math.round(stops[lo][1] + (stops[hi][1] - stops[lo][1]) * frac);
    const b = Math.round(stops[lo][2] + (stops[hi][2] - stops[lo][2]) * frac);

    return `rgb(${r},${g},${b})`;
  }

  // --- Drawing ---

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Background
    ctx.fillStyle = this._colors.bg;
    ctx.fillRect(0, 0, w, h);

    const area = this._drawArea();

    // 2. Waveform (behind everything else)
    if (this._showWaveform && this._waveformData) {
      this._drawWaveform(ctx, area);
    }

    // 3. Beat markers (behind grid and actions, on top of waveform)
    if (this._showBeatMarkers && this._beatMarkers) {
      this._drawBeatMarkers(ctx, area);
    }

    // 4. Grid lines
    this._drawGrid(ctx, area);

    // 5. Bookmark lines (gold dashed, before connections so they're behind)
    this._drawBookmarks(ctx, area);

    // 6. Connection lines (speed-colored, OFS style)
    this._drawConnections(ctx, area);

    // 7. Action dots
    this._drawDots(ctx, area);

    // 8. Playback cursor (centered during playback)
    this._drawCursor(ctx, area);

    // 9. Heatmap bar at bottom
    this._drawHeatmapBar(ctx, area);

    // 10. Rubber-band selection
    if (this._rubberBand) {
      this._drawRubberBand(ctx);
    }

    // 11. Hover tooltip
    if (this._hoveredIndex >= 0) {
      this._drawHoverTooltip(ctx);
    }

    ctx.restore();
  }

  _drawGrid(ctx, area) {
    ctx.strokeStyle = this._colors.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = this._colors.gridLabel;

    // Horizontal grid (position: 0, 25, 50, 75, 100)
    for (const pos of [0, 25, 50, 75, 100]) {
      const y = this.posToY(pos);
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(pos), area.x - 6, y);
    }

    // Vertical grid (time — adaptive intervals)
    const duration = this.viewDurationMs;
    let interval;
    if (duration > 60000) interval = 30000;
    else if (duration > 10000) interval = 5000;
    else if (duration > 2000) interval = 1000;
    else interval = 100;

    const firstTick = Math.ceil(this._viewStartMs / interval) * interval;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let t = firstTick; t <= this._viewEndMs; t += interval) {
      const x = this.timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();
      ctx.fillText(this._formatTime(t), x, area.y + area.h + 6);
    }
  }

  _drawWaveform(ctx, area) {
    const data = this._waveformData;
    if (!data || !data.peaks || data.peaks.length === 0) return;

    const { peaks, peaksPerSecond } = data;
    const startIdx = Math.max(0, Math.floor(this._viewStartMs / 1000 * peaksPerSecond));
    const endIdx = Math.min(peaks.length - 1, Math.ceil(this._viewEndMs / 1000 * peaksPerSecond));
    if (startIdx >= endIdx) return;

    const midY = area.y + area.h / 2;
    const maxHalf = area.h / 2;

    ctx.save();
    ctx.fillStyle = this._colors.waveform;
    ctx.beginPath();

    // Top half (forward pass)
    for (let i = startIdx; i <= endIdx; i++) {
      const timeMs = (i / peaksPerSecond) * 1000;
      const x = this.timeToX(timeMs);
      const amp = peaks[i] * maxHalf;
      if (i === startIdx) ctx.moveTo(x, midY - amp);
      else ctx.lineTo(x, midY - amp);
    }

    // Bottom half (reverse pass — mirror)
    for (let i = endIdx; i >= startIdx; i--) {
      const timeMs = (i / peaksPerSecond) * 1000;
      const x = this.timeToX(timeMs);
      const amp = peaks[i] * maxHalf;
      ctx.lineTo(x, midY + amp);
    }

    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _drawBeatMarkers(ctx, area) {
    const beats = this._beatMarkers;
    if (!beats || beats.length === 0) return;

    ctx.save();
    ctx.strokeStyle = this._colors.beatMarker;
    ctx.lineWidth = 1;

    for (let i = 0; i < beats.length; i++) {
      const timeMs = beats[i];
      if (timeMs < this._viewStartMs || timeMs > this._viewEndMs) continue;

      const x = this.timeToX(timeMs);
      ctx.beginPath();
      ctx.moveTo(x, area.y + area.h - 12);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawConnections(ctx) {
    const actions = this.script.actions;
    if (actions.length < 2) return;

    const selected = this.script.selectedIndices;

    // Build screen-space points array
    const n = actions.length;
    const xs = new Array(n);
    const ys = new Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = this.timeToX(actions[i].at);
      ys[i] = this.posToY(actions[i].pos);
    }

    // Compute monotone cubic Hermite tangents (Fritsch-Carlson method)
    // This guarantees no overshoot — curves stay between adjacent point values
    const tangents = this._monotoneTangents(xs, ys);

    // Draw each segment
    for (let i = 0; i < n - 1; i++) {
      const bothSelected = selected.has(i) && selected.has(i + 1);

      let color;
      if (bothSelected) {
        color = this._colors.selectedLine;
      } else {
        const deltaTime = actions[i + 1].at - actions[i].at;
        const deltaPos = Math.abs(actions[i + 1].pos - actions[i].pos);
        const speed = deltaTime > 0 ? deltaPos / deltaTime : 0;
        color = ActionGraph.speedToColor(speed);
      }

      const x1 = xs[i], y1 = ys[i], x2 = xs[i + 1], y2 = ys[i + 1];
      const dx = x2 - x1;
      const m1 = tangents[i] * dx;
      const m2 = tangents[i + 1] * dx;

      // Build cubic Hermite path
      const path = new Path2D();
      path.moveTo(x1, y1);

      const steps = 16;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;

        // Hermite basis functions
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;

        const sx = x1 + dx * t; // X is always linear (time axis)
        const sy = h00 * y1 + h10 * m1 + h01 * y2 + h11 * m2;

        path.lineTo(sx, sy);
      }

      // Background stroke for contrast
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = 5;
      ctx.stroke(path);

      // Colored stroke
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke(path);
    }
  }

  /**
   * Compute monotone cubic Hermite tangents using the Fritsch-Carlson method.
   * Guarantees the interpolation never overshoots between data points.
   * @returns {Float64Array} tangent (dy/dx) at each point
   */
  _monotoneTangents(xs, ys) {
    const n = xs.length;
    const tangents = new Float64Array(n);

    if (n < 2) return tangents;
    if (n === 2) {
      const slope = (ys[1] - ys[0]) / (xs[1] - xs[0] || 1);
      tangents[0] = slope;
      tangents[1] = slope;
      return tangents;
    }

    // Step 1: compute slopes between successive points
    const deltas = new Float64Array(n - 1);
    const slopes = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      deltas[i] = xs[i + 1] - xs[i];
      slopes[i] = deltas[i] !== 0 ? (ys[i + 1] - ys[i]) / deltas[i] : 0;
    }

    // Step 2: initial tangents as average of adjacent slopes
    tangents[0] = slopes[0];
    for (let i = 1; i < n - 1; i++) {
      tangents[i] = (slopes[i - 1] + slopes[i]) / 2;
    }
    tangents[n - 1] = slopes[n - 2];

    // Step 3: Fritsch-Carlson monotonicity constraints
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(slopes[i]) < 1e-10) {
        // Flat segment — zero tangents at both ends
        tangents[i] = 0;
        tangents[i + 1] = 0;
      } else {
        const alpha = tangents[i] / slopes[i];
        const beta = tangents[i + 1] / slopes[i];

        // Clamp to ensure monotonicity (circle constraint)
        const mag = Math.sqrt(alpha * alpha + beta * beta);
        if (mag > 3) {
          const tau = 3 / mag;
          tangents[i] = tau * alpha * slopes[i];
          tangents[i + 1] = tau * beta * slopes[i];
        }
      }
    }

    return tangents;
  }

  _drawDots(ctx) {
    const actions = this.script.actions;
    const selected = this.script.selectedIndices;

    // Draw non-selected dots first
    for (let i = 0; i < actions.length; i++) {
      if (selected.has(i) || i === this._hoveredIndex) continue;
      const x = this.timeToX(actions[i].at);
      const y = this.posToY(actions[i].pos);

      // OFS style: red dot with dark border
      ctx.strokeStyle = this._colors.dotBorder;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = this._colors.dot;
      ctx.beginPath();
      ctx.arc(x, y, this._dotRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Draw hovered dot (larger)
    if (this._hoveredIndex >= 0 && !selected.has(this._hoveredIndex)) {
      const a = actions[this._hoveredIndex];
      const x = this.timeToX(a.at);
      const y = this.posToY(a.pos);
      ctx.strokeStyle = this._colors.dotBorder;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = this._colors.hoveredDot;
      ctx.beginPath();
      ctx.arc(x, y, this._dotRadius + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Draw selected dots on top (OFS green with glow)
    for (const i of selected) {
      if (i >= actions.length) continue;
      const x = this.timeToX(actions[i].at);
      const y = this.posToY(actions[i].pos);

      // Glow
      ctx.fillStyle = this._colors.selectedGlow;
      ctx.beginPath();
      ctx.arc(x, y, this._selectedDotRadius + 3, 0, Math.PI * 2);
      ctx.fill();

      // Dot
      ctx.fillStyle = this._colors.selectedDot;
      ctx.strokeStyle = this._colors.dotBorder;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, this._selectedDotRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  _drawCursor(ctx, area) {
    // During playback, cursor is always at center (OFS centered playhead)
    const x = this.timeToX(this._cursorMs);
    if (x < area.x - 1 || x > area.x + area.w + 1) return;

    ctx.strokeStyle = this._colors.cursor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.h);
    ctx.stroke();

    // Small triangle at top
    ctx.fillStyle = this._colors.cursor;
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x - 5, area.y - 6);
    ctx.lineTo(x + 5, area.y - 6);
    ctx.closePath();
    ctx.fill();
  }

  /** Draw a thin heatmap intensity bar at the very bottom of the draw area. */
  _drawHeatmapBar(ctx, area) {
    const actions = this.script.actions;
    if (actions.length < 2) return;

    const barHeight = 6;
    const barY = area.y + area.h - barHeight;
    const barWidth = area.w;

    // Draw in pixel-width segments
    const segments = Math.min(barWidth, 200); // cap for performance
    const segWidth = barWidth / segments;

    for (let s = 0; s < segments; s++) {
      const x = area.x + s * segWidth;
      const timeAtX = this.xToTime(x);

      // Find speed at this time
      let speed = 0;
      for (let i = 0; i < actions.length - 1; i++) {
        if (actions[i].at <= timeAtX && actions[i + 1].at >= timeAtX) {
          const dt = actions[i + 1].at - actions[i].at;
          const dp = Math.abs(actions[i + 1].pos - actions[i].pos);
          speed = dt > 0 ? dp / dt : 0;
          break;
        }
      }

      ctx.fillStyle = ActionGraph.speedToColor(speed);
      ctx.globalAlpha = 0.6;
      ctx.fillRect(x, barY, segWidth + 0.5, barHeight);
    }
    ctx.globalAlpha = 1;
  }

  _drawBookmarks(ctx, area) {
    if (typeof this.script.getBookmarks !== 'function') return;
    const bookmarks = this.script.getBookmarks();
    if (bookmarks.length === 0) return;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (const bm of bookmarks) {
      const x = this.timeToX(bm.at);
      // Skip bookmarks outside current viewport
      if (x < area.x - 10 || x > area.x + area.w + 10) continue;

      // Gold dashed vertical line
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.6)';
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();

      // Small label at top
      if (bm.name) {
        ctx.fillStyle = 'rgba(255, 215, 0, 0.8)';
        const label = bm.name.length > 12 ? bm.name.slice(0, 11) + '\u2026' : bm.name;
        ctx.fillText(label, x, area.y - 2);
      }
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawRubberBand(ctx) {
    const r = this._rubberBand;
    const x = Math.min(r.x1, r.x2);
    const y = Math.min(r.y1, r.y2);
    const w = Math.abs(r.x2 - r.x1);
    const h = Math.abs(r.y2 - r.y1);

    ctx.fillStyle = this._colors.rubberBand;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = this._colors.rubberBandBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  }

  _drawHoverTooltip(ctx) {
    const action = this.script.actions[this._hoveredIndex];
    if (!action) return;

    const text = `${this._formatTime(action.at)}, pos: ${action.pos}`;
    ctx.font = '11px sans-serif';
    const metrics = ctx.measureText(text);
    const px = 6;
    const py = 4;
    const tw = metrics.width + px * 2;
    const th = 18;

    let tx = this._hoverX - tw / 2;
    let ty = this._hoverY - th - 12;

    // Clamp to canvas bounds
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.width / dpr;
    if (tx < 2) tx = 2;
    if (tx + tw > cw - 2) tx = cw - 2 - tw;
    if (ty < 2) ty = this._hoverY + 12;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.beginPath();
    ctx.roundRect(tx, ty, tw, th, 4);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, tx + px, ty + th / 2);
  }

  // --- Helpers ---

  _formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const frac = ms % 1000;

    if (this.viewDurationMs <= 5000) {
      // Show milliseconds for tight zoom
      return `${min}:${String(sec).padStart(2, '0')}.${String(Math.floor(frac / 100))}`;
    }
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  /**
   * Get canvas-relative coordinates from a MouseEvent.
   */
  getCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }
}
