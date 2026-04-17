// ProgressBar — Enhanced seek bar with thumbnail preview and heatmap overlay

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
  }

  _cacheElements() {
    this.tooltipThumbnail = document.getElementById('tooltip-thumbnail');
    this.heatmapCanvas = document.getElementById('heatmap-canvas');
    this.heatmapCtx = this.heatmapCanvas ? this.heatmapCanvas.getContext('2d') : null;
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
   * Called on progress bar hover.
   */
  updateThumbnailPreview(timeSeconds) {
    if (!this._thumbReady || !this._thumbVideo || !this.tooltipThumbnail) return;

    if (this._thumbSeeking) {
      // A seek is already in progress — queue this one
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
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      this.tooltipThumbnail.style.backgroundImage = `url('${dataUrl}')`;
      this.tooltipThumbnail.style.backgroundSize = 'cover';
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

    // Clear thumbnail display
    if (this.tooltipThumbnail) {
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
    // Normalize speed to 0–1 range (0.5 pos/ms is very fast)
    const normalized = Math.min(speed / 0.5, 1);

    if (normalized < 0.25) {
      // Blue to cyan
      const t = normalized / 0.25;
      return `rgb(0, ${Math.round(t * 200)}, ${Math.round(255 - t * 55)})`;
    } else if (normalized < 0.5) {
      // Cyan to green
      const t = (normalized - 0.25) / 0.25;
      return `rgb(0, ${Math.round(200 + t * 55)}, ${Math.round(200 - t * 200)})`;
    } else if (normalized < 0.75) {
      // Green to yellow
      const t = (normalized - 0.5) / 0.25;
      return `rgb(${Math.round(t * 255)}, 255, 0)`;
    } else {
      // Yellow to red
      const t = (normalized - 0.75) / 0.25;
      return `rgb(255, ${Math.round(255 - t * 255)}, 0)`;
    }
  }

  /**
   * Clear the heatmap canvas and thumbnail preview video.
   */
  clearHeatmap() {
    if (this.heatmapCtx && this.heatmapCanvas) {
      this.heatmapCtx.clearRect(0, 0, this.heatmapCanvas.width, this.heatmapCanvas.height);
    }
    this._heatmapData = null;
    this._destroyThumbVideo();
  }

  /**
   * Redraw heatmap (call on window resize).
   */
  redraw() {
    if (this._heatmapData) {
      this.renderHeatmap(this._heatmapData.actions, this._heatmapData.duration);
    }
  }
}
