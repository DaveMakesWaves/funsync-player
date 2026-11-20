// ProgressBar — Enhanced seek bar with thumbnail preview and heatmap overlay

import { heatmapSpeedToColor } from './heatmap-palette.js';
import { t } from './i18n.js';

/**
 * Stash scene markers on the chapter strip (Stash S1): one colour, not in
 * the script chapters' palette (funscript-engine.js), so they read as
 * Stash's. A marker's start is a tick; a marker with an end also gets a
 * fainter segment to its end.
 */
export const STASH_MARKER_COLOR = '#7fd8ff';
export const STASH_MARKER_RANGE_COLOR = 'rgba(127, 216, 255, 0.45)';

export class ProgressBar {
  constructor({ containerElement, videoPlayer, backendPort }) {
    this.container = containerElement;
    this.player = videoPlayer;
    this.backendPort = backendPort;

    this._heatmapData = null;

    // Client-side thumbnail preview
    this._thumbVideo = null;
    this._thumbCanvas = null;
    this._thumbCtx = null;
    this._thumbReady = false;
    this._thumbPending = null; // queued seek time while a seek is in progress
    this._thumbSeeking = false;

    this._cacheElements();
    this._bindTooltipVisibility();
  }

  /**
   * The hover preview (time + thumbnail) is shown by CSS on
   * `.controls__progress:hover` alone, and VideoPlayer moves it to the cursor
   * on mousemove. Hover can start with no mousemove at all: the bar moving
   * under a still pointer (opening the editor lifts the controls 250 px), or
   * synthetic input. The box then sat at the bar's left edge with the
   * markup's "0:00" and an empty grey thumbnail (CB-09, seen once after
   * synthetic mouse input over the editor). It stays hidden until a
   * mousemove has put it at the cursor, and hides again when the pointer
   * leaves, so the next hover cannot show a stale position either.
   */
  _bindTooltipVisibility() {
    const tip = document.getElementById('progress-tooltip');
    if (!tip || !this.container?.addEventListener) return;
    this.tooltip = tip;
    tip.style.visibility = 'hidden';
    this.container.addEventListener('mousemove', () => { tip.style.visibility = ''; });
    this.container.addEventListener('mouseleave', () => { tip.style.visibility = 'hidden'; });
  }

  _cacheElements() {
    this.tooltipThumbnail = document.getElementById('tooltip-thumbnail');
    this.heatmapCanvas = document.getElementById('heatmap-canvas');
    this.heatmapCtx = this.heatmapCanvas ? this.heatmapCanvas.getContext('2d') : null;
    // Chapter strip — separate canvas below the heatmap. Hidden until
    // a funscript with chapters loads. Per SCOPE-chapters-bookmarks.md §4.2.
    this.chapterStripContainer = document.getElementById('chapter-strip-container');
    this.chapterStripCanvas = document.getElementById('chapter-strip-canvas');
    this.chapterStripCtx = this.chapterStripCanvas ? this.chapterStripCanvas.getContext('2d') : null;
    // Tooltip marker label — fills with chapter/bookmark name on hover.
    this.tooltipMarker = document.getElementById('tooltip-marker');
    this.tooltipMarkerSwatch = document.getElementById('tooltip-marker-swatch');
    this.tooltipMarkerName = document.getElementById('tooltip-marker-name');
    this._chapters = [];
    this._bookmarks = [];
    // Stash scene markers of the playing video (Stash S1, Dave's answer 3):
    // their own list, drawn on the chapter strip ALONGSIDE the script's
    // chapters, so the many setMarkers() calls of the script paths never
    // drop them and they never replace a chapter. See setStashMarkers().
    this._stashMarkers = [];
    // The hover label's words, `(title) => text` (app.js gives the
    // translated "Stash marker: <title>"); null: the plain fallback.
    this.stashMarkerLabel = null;
  }

  /**
   * Set up a hidden video element for client-side thumbnail capture.
   * Called when a new video source is loaded.
   */
  setVideoSource(src) {
    this._destroyThumbVideo();

    if (!src) return;

    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    document.body.appendChild(video);

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;

    this._thumbVideo = video;
    this._thumbCanvas = canvas;
    this._thumbCtx = canvas.getContext('2d');
    this._thumbReady = false;
    this._thumbSeeking = false;
    this._thumbPending = null;

    video.addEventListener('loadeddata', () => {
      this._thumbReady = true;
      // Set canvas aspect ratio from actual video dimensions
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        canvas.height = Math.round(160 * (video.videoHeight / video.videoWidth));
      }
    });

    video.addEventListener('seeked', () => {
      this._captureFrame();
      this._thumbSeeking = false;

      // If another seek was queued, process it
      if (this._thumbPending !== null) {
        const next = this._thumbPending;
        this._thumbPending = null;
        this._seekThumbVideo(next);
      }
    });

    video.addEventListener('error', () => {
      this._thumbReady = false;
    });

    video.src = src;
  }

  /**
   * Update the thumbnail preview for the given timestamp.
   * Called on progress bar hover. Throttled to avoid hardware decoder contention.
   */
  updateThumbnailPreview(timeSeconds) {
    if (!this._thumbReady || !this._thumbVideo || !this.tooltipThumbnail) return;

    // Throttle: skip if less than 150ms since last seek request
    const now = performance.now();
    if (now - (this._lastThumbRequestTime || 0) < 150) {
      // Queue the latest position for when throttle expires
      if (!this._thumbThrottleTimer) {
        this._thumbThrottleTimer = setTimeout(() => {
          this._thumbThrottleTimer = null;
          if (this._thumbLatestTime !== null) {
            this._seekThumbVideo(this._thumbLatestTime);
            this._thumbLatestTime = null;
          }
        }, 150);
      }
      this._thumbLatestTime = timeSeconds;
      return;
    }
    this._lastThumbRequestTime = now;
    this._thumbLatestTime = null;

    if (this._thumbSeeking) {
      this._thumbPending = timeSeconds;
      return;
    }

    this._seekThumbVideo(timeSeconds);
  }

  _seekThumbVideo(timeSeconds) {
    const video = this._thumbVideo;
    if (!video || !isFinite(timeSeconds)) return;
    if (!isFinite(video.duration) || video.duration <= 0) return;

    const clamped = Math.max(0, Math.min(timeSeconds, video.duration));
    this._thumbSeeking = true;
    video.currentTime = clamped;
  }

  _captureFrame() {
    const video = this._thumbVideo;
    const ctx = this._thumbCtx;
    const canvas = this._thumbCanvas;
    if (!video || !ctx || !canvas || !this.tooltipThumbnail) return;

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Use canvas element directly instead of expensive toDataURL encoding
      if (!this._thumbCanvasAttached) {
        this.tooltipThumbnail.innerHTML = '';
        this.tooltipThumbnail.appendChild(canvas);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        this._thumbCanvasAttached = true;
      }
    } catch {
      // Cross-origin or other capture error — ignore
    }
  }

  _destroyThumbVideo() {
    if (this._thumbVideo) {
      this._thumbVideo.pause();
      this._thumbVideo.removeAttribute('src');
      this._thumbVideo.load();
      // Remove all listeners before removing element to prevent leaks
      this._thumbVideo.onloadeddata = null;
      this._thumbVideo.onseeked = null;
      this._thumbVideo.onerror = null;
      this._thumbVideo.remove();
      this._thumbVideo = null;
    }
    this._thumbCanvas = null;
    this._thumbCtx = null;
    this._thumbReady = false;
    this._thumbSeeking = false;
    this._thumbPending = null;
    this._thumbCanvasAttached = false;
    this._thumbLatestTime = null;
    this._lastThumbRequestTime = 0;
    if (this._thumbThrottleTimer) { clearTimeout(this._thumbThrottleTimer); this._thumbThrottleTimer = null; }

    // Clear thumbnail display (remove canvas child and background)
    if (this.tooltipThumbnail) {
      this.tooltipThumbnail.innerHTML = '';
      this.tooltipThumbnail.style.backgroundImage = '';
    }
  }

  /**
   * Render funscript heatmap on the progress bar canvas.
   * @param {Array} actions - Funscript actions [{at, pos}, ...]
   * @param {number} duration - Video duration in seconds
   */
  renderHeatmap(actions, duration) {
    if (!this.heatmapCanvas || !this.heatmapCtx || !actions || actions.length < 2) return;
    if (!isFinite(duration) || duration <= 0) return;

    this._heatmapData = { actions, duration };

    const canvas = this.heatmapCanvas;
    const ctx = this.heatmapCtx;
    const rect = canvas.parentElement.getBoundingClientRect();

    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const w = rect.width;
    const h = rect.height;
    const durationMs = duration * 1000;

    ctx.clearRect(0, 0, w, h);

    // Calculate intensity (speed) between each pair of actions
    for (let i = 0; i < actions.length - 1; i++) {
      const a = actions[i];
      const b = actions[i + 1];

      const dt = b.at - a.at;
      if (dt <= 0) continue;

      const dp = Math.abs(b.pos - a.pos);
      const speed = dp / dt; // position units per ms

      // Map speed to color: blue (slow) → green → yellow → red (fast)
      const color = this._speedToColor(speed);

      const x1 = (a.at / durationMs) * w;
      const x2 = (b.at / durationMs) * w;

      ctx.fillStyle = color;
      ctx.fillRect(x1, 0, Math.max(x2 - x1, 1), h);
    }

    // Render gap indicators if available
    if (this._gapData) {
      this._renderGapIndicators(ctx, w, h, durationMs);
    }

    // Render bookmark ticks ON TOP of the heatmap so they always read
    // against the underlying gradient. Chapters live on a separate
    // canvas below the seekbar — see _renderChapterStrip().
    if (this._bookmarks.length > 0) {
      this._renderBookmarkTicks(ctx, w, h, durationMs);
    }
  }

  /**
   * Draw bookmark ticks on the progress bar. Gold vertical lines, 2px
   * wide, full height of the canvas. Drawn after the heatmap so they
   * sit on top. Per SCOPE-chapters-bookmarks.md §4.1.
   */
  _renderBookmarkTicks(ctx, w, h, durationMs) {
    if (durationMs <= 0) return;
    ctx.fillStyle = 'rgba(255, 215, 0, 0.8)';
    for (const bm of this._bookmarks) {
      const x = Math.round((bm.at / durationMs) * w);
      // Clip at the edges so out-of-range bookmarks (C-E18) don't break
      // the layout. 2px wide centred at x.
      const drawX = Math.max(0, Math.min(w - 2, x - 1));
      ctx.fillRect(drawX, 0, 2, h);
    }
  }

  /**
   * Set chapter + bookmark marker data. Called from app.js whenever a
   * funscript loads (or a variant switches). Either array can be empty;
   * the chapter strip auto-shows/hides based on chapter count.
   *
   * @param {{chapters: Array, bookmarks: Array}} markers
   */
  setMarkers({ chapters, bookmarks } = {}) {
    this._chapters = Array.isArray(chapters) ? chapters : [];
    this._bookmarks = Array.isArray(bookmarks) ? bookmarks : [];

    // Show/hide the chapter strip element based on whether we have any.
    // `hidden` attribute respects the global `[hidden] { display: none }`
    // CSS reset so layout collapses cleanly when no chapters present.
    this._syncChapterStripVisibility();

    this.redraw();
  }

  /**
   * The playing video's Stash scene markers (Stash S1; DESIGN-stash-s1.md
   * (j) row 1, in S1 by Dave's answer 3). Drawn on the chapter strip with
   * the script's chapters, never instead of them: with both, the script's
   * chapters keep the strip's top half and Stash's markers take the bottom
   * half. A marker with an end is a segment, one without is a tick. The
   * hover label says it is from Stash. An empty list (Stash off, the video
   * not linked, another video) takes them away again.
   *
   * @param {Array<{startMs: number, endMs?: number|null, title?: string}>} markers
   */
  setStashMarkers(markers) {
    const out = [];
    for (const m of Array.isArray(markers) ? markers : []) {
      const startMs = Number(m?.startMs);
      if (!Number.isFinite(startMs) || startMs < 0) continue;
      const end = m?.endMs == null ? null : Number(m.endMs);
      out.push({
        startMs,
        endMs: Number.isFinite(end) && end > startMs ? end : null,
        title: typeof m?.title === 'string' ? m.title : '',
        source: 'stash',
      });
    }
    out.sort((a, b) => a.startMs - b.startMs);
    this._stashMarkers = out;
    this._syncChapterStripVisibility();
    if (this.chapterStripCtx && this.chapterStripCanvas && out.length === 0 && this._chapters.length === 0) {
      this.chapterStripCtx.clearRect(0, 0, this.chapterStripCanvas.width, this.chapterStripCanvas.height);
    }
    this.redraw();
  }

  /** The strip shows while the script has chapters or Stash has markers. */
  _syncChapterStripVisibility() {
    if (this.chapterStripContainer) {
      this.chapterStripContainer.hidden = this._chapters.length === 0 && this._stashMarkers.length === 0;
    }
  }

  /**
   * Render the chapter strip below the seek bar. 4px tall band with
   * per-chapter color segments. Time axis derives from the video's
   * own duration (chapters can exist without actions per C-E19), so
   * the caller passes duration in seconds.
   *
   * @param {number} durationSec — video duration in seconds (from the player)
   */
  renderChapterStrip(durationSec) {
    if (!this.chapterStripCanvas || !this.chapterStripCtx) return;
    if (!Number.isFinite(durationSec) || durationSec <= 0) return;
    if (this._chapters.length === 0 && this._stashMarkers.length === 0) return;

    const canvas = this.chapterStripCanvas;
    const ctx = this.chapterStripCtx;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const w = rect.width;
    const h = rect.height;
    const durationMs = durationSec * 1000;

    ctx.clearRect(0, 0, w, h);

    // Two lanes when both kinds are there: the script's chapters on top,
    // Stash's markers below (neither covers the other).
    const both = this._chapters.length > 0 && this._stashMarkers.length > 0;
    const chapterH = both ? h / 2 : h;
    for (const c of this._chapters) {
      const x1 = Math.max(0, Math.min(w, (c.startMs / durationMs) * w));
      const x2 = Math.max(0, Math.min(w, (c.endMs / durationMs) * w));
      const width = Math.max(1, x2 - x1);
      ctx.fillStyle = c.color;
      ctx.fillRect(x1, 0, width, chapterH);
    }
    if (this._stashMarkers.length > 0) {
      this._renderStashMarkers(ctx, w, both ? h / 2 : 0, both ? h / 2 : h, durationMs);
    }
  }

  /**
   * Stash's markers in their lane (`top`, `laneH`): a segment for a marker
   * with an end, a 2px tick for one without, in Stash's one colour.
   */
  _renderStashMarkers(ctx, w, top, laneH, durationMs) {
    if (durationMs <= 0) return;
    for (const m of this._stashMarkers) {
      const x1 = Math.max(0, Math.min(w, (m.startMs / durationMs) * w));
      if (m.endMs != null) {
        const x2 = Math.max(0, Math.min(w, (m.endMs / durationMs) * w));
        ctx.fillStyle = STASH_MARKER_RANGE_COLOR;
        ctx.fillRect(x1, top, Math.max(1, x2 - x1), laneH);
      }
      ctx.fillStyle = STASH_MARKER_COLOR;
      ctx.fillRect(Math.max(0, Math.min(w - 2, Math.round(x1) - 1)), top, 2, laneH);
    }
  }

  /**
   * Update the marker label inside the progress tooltip. Called on
   * every hover frame; resolves the marker at the cursor and either
   * fills the marker label (chapter name + swatch / bookmark name)
   * or hides it so the regular thumbnail + time still read.
   *
   * @param {number} xPx — cursor x relative to container
   * @param {number} widthPx — container width
   * @param {number} durationMs
   */
  updateMarkerTooltip(xPx, widthPx, durationMs) {
    if (!this.tooltipMarker) return;
    this._updateStashMarkerTooltip(xPx, widthPx, durationMs);
    const m = this.resolveHoverMarker(xPx, widthPx, durationMs);
    if (!m) {
      this.tooltipMarker.hidden = true;
      return;
    }
    this.tooltipMarker.hidden = false;
    if (m.kind === 'chapter') {
      if (this.tooltipMarkerSwatch) {
        this.tooltipMarkerSwatch.style.background = m.data.color;
        this.tooltipMarkerSwatch.style.visibility = '';
      }
      this.tooltipMarkerName.textContent = m.data.name || '';
    } else {
      // Bookmark — show a small icon (rendered via CSS class) instead
      // of a color swatch. Single source for both kinds keeps the
      // tooltip layout stable.
      if (this.tooltipMarkerSwatch) {
        this.tooltipMarkerSwatch.style.background = 'rgba(255, 215, 0, 0.9)';
        this.tooltipMarkerSwatch.style.visibility = '';
      }
      this.tooltipMarkerName.textContent = m.data.name || '';
    }
  }

  /**
   * Hover-resolution helper for the tooltip. Given a horizontal cursor
   * position (in CSS px relative to the progress container) and the
   * video duration in ms, return whichever marker is closest. Bookmarks
   * win over chapters within their hit radius (smaller, more precise
   * target per C-E24).
   *
   * @param {number} xPx — cursor x relative to container
   * @param {number} widthPx — container width in CSS px
   * @param {number} durationMs
   * @returns {{kind: 'bookmark'|'chapter', data: object}|null}
   */
  resolveHoverMarker(xPx, widthPx, durationMs) {
    if (widthPx <= 0 || durationMs <= 0) return null;
    const HIT_RADIUS_PX = 6;

    for (const bm of this._bookmarks) {
      const x = (bm.at / durationMs) * widthPx;
      if (Math.abs(xPx - x) <= HIT_RADIUS_PX) {
        return { kind: 'bookmark', data: bm };
      }
    }
    for (let i = this._chapters.length - 1; i >= 0; i--) {
      // Iterate in reverse so overlapping chapters resolve to the
      // topmost one (last added) per C-E13.
      const c = this._chapters[i];
      const x1 = (c.startMs / durationMs) * widthPx;
      const x2 = (c.endMs / durationMs) * widthPx;
      if (xPx >= x1 && xPx <= x2) {
        return { kind: 'chapter', data: c };
      }
    }
    return null;
  }

  /**
   * The Stash marker at the cursor (Stash S1), or null: the nearest marker
   * start within the tick's hit radius first (a point is the precise
   * target), else the last marker whose start..end range holds the cursor.
   * The script's chapters and bookmarks are resolved apart
   * (resolveHoverMarker), so both labels can show at once.
   *
   * @param {number} xPx cursor x relative to the container
   * @param {number} widthPx container width in CSS px
   * @param {number} durationMs
   * @returns {{kind: 'stash', data: {startMs: number, endMs: number|null, title: string}}|null}
   */
  resolveStashMarker(xPx, widthPx, durationMs) {
    if (!(widthPx > 0) || !(durationMs > 0) || this._stashMarkers.length === 0) return null;
    const HIT_RADIUS_PX = 6;
    let best = null;
    let bestDist = Infinity;
    for (const m of this._stashMarkers) {
      const dist = Math.abs(xPx - (m.startMs / durationMs) * widthPx);
      if (dist <= HIT_RADIUS_PX && dist < bestDist) { best = m; bestDist = dist; }
    }
    if (best) return { kind: 'stash', data: best };
    for (let i = this._stashMarkers.length - 1; i >= 0; i--) {
      const m = this._stashMarkers[i];
      if (m.endMs == null) continue;
      const x1 = (m.startMs / durationMs) * widthPx;
      const x2 = (m.endMs / durationMs) * widthPx;
      if (xPx >= x1 && xPx <= x2) return { kind: 'stash', data: m };
    }
    return null;
  }

  /**
   * The words for a Stash marker's hover label: always says "Stash". The
   * window's label hook, else the loaded language's words (the pop-out
   * player's bar too, s1-review-a RA-S1-6), else the plain fallback.
   */
  _stashMarkerText(title) {
    const name = typeof title === 'string' ? title.trim() : '';
    if (typeof this.stashMarkerLabel === 'function') {
      try {
        const out = this.stashMarkerLabel(name);
        if (typeof out === 'string' && out) return out;
      } catch { /* the fallback below */ }
    }
    const key = name ? 'player.stashMarker' : 'player.stashMarkerUntitled';
    try {
      const out = name ? t(key, { title: name }) : t(key);
      if (typeof out === 'string' && out && out !== key) return out;
    } catch { /* no words loaded: the fallback below */ }
    return name ? `Stash: ${name}` : 'Stash';
  }

  /**
   * The Stash line of the hover tooltip: its own element, made once next to
   * the script's marker label (the same look), so a script chapter and a
   * Stash marker at one spot both show. The title is set as text, never as
   * HTML (it comes from the user's Stash).
   */
  _updateStashMarkerTooltip(xPx, widthPx, durationMs) {
    const m = this.resolveStashMarker(xPx, widthPx, durationMs);
    if (!m) {
      if (this.tooltipStashMarker) this.tooltipStashMarker.hidden = true;
      return;
    }
    const el = this._stashTooltipElement();
    if (!el) return;
    el.hidden = false;
    el.querySelector('.tooltip__marker-name').textContent = this._stashMarkerText(m.data.title);
  }

  _stashTooltipElement() {
    if (this.tooltipStashMarker) return this.tooltipStashMarker;
    const anchor = this.tooltipMarker;
    if (!anchor?.parentNode || typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'tooltip__marker tooltip__marker--stash';
    el.id = 'tooltip-marker-stash';
    // A line of its own under the script's label, centred like it.
    el.style.display = 'flex';
    el.style.width = 'max-content';
    el.style.maxWidth = '220px';
    el.style.margin = '0 auto 4px';
    el.hidden = true;
    const swatch = document.createElement('span');
    swatch.className = 'tooltip__marker-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.background = STASH_MARKER_COLOR;
    const name = document.createElement('span');
    name.className = 'tooltip__marker-name';
    el.append(swatch, name);
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    this.tooltipStashMarker = el;
    return el;
  }

  /**
   * Set gap data for rendering indicators on the progress bar.
   * @param {Array<{startMs: number, endMs: number}>} gaps
   */
  setGaps(gaps) {
    this._gapData = gaps && gaps.length > 0 ? gaps : null;
    this.redraw();
  }

  _renderGapIndicators(ctx, w, h, durationMs) {
    if (!this._gapData || durationMs <= 0) return;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    for (const gap of this._gapData) {
      const x1 = (gap.startMs / durationMs) * w;
      const x2 = (gap.endMs / durationMs) * w;
      ctx.fillRect(x1, 0, Math.max(x2 - x1, 1), h);
    }

    // Draw thin border lines at gap edges
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    for (const gap of this._gapData) {
      const x1 = Math.round((gap.startMs / durationMs) * w) + 0.5;
      const x2 = Math.round((gap.endMs / durationMs) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, h);
      ctx.moveTo(x2, 0);
      ctx.lineTo(x2, h);
      ctx.stroke();
    }
  }

  /**
   * Map a speed value to a heatmap color.
   * @param {number} speed - Position units per millisecond
   * @returns {string} CSS color string
   */
  _speedToColor(speed) {
    // Shared with the HM overlay strip (inline-viz.js) so the two agree.
    return heatmapSpeedToColor(speed);
  }

  /**
   * Clear the heatmap canvas and thumbnail preview video.
   */
  clearHeatmap() {
    if (this.heatmapCtx && this.heatmapCanvas) {
      this.heatmapCtx.clearRect(0, 0, this.heatmapCanvas.width, this.heatmapCanvas.height);
    }
    this._heatmapData = null;
    // Markers persist across heatmap clears — the funscript engine
    // controls them via setMarkers() and may keep chapters even when
    // a script has zero actions (C-E19). The chapter strip is cleared
    // separately when setMarkers receives an empty list.
    if (this.chapterStripCtx && this.chapterStripCanvas) {
      this.chapterStripCtx.clearRect(0, 0, this.chapterStripCanvas.width, this.chapterStripCanvas.height);
    }
    this._destroyThumbVideo();
  }

  /**
   * Redraw heatmap + chapter strip (call on window resize).
   */
  redraw() {
    if (this._heatmapData) {
      this.renderHeatmap(this._heatmapData.actions, this._heatmapData.duration);
    }
    if (this._chapters.length > 0 || this._stashMarkers.length > 0) {
      const duration = this._heatmapData?.duration ?? this.player?.duration ?? 0;
      if (duration > 0) this.renderChapterStrip(duration);
    }
  }
}
