// DeviceSimulator — Visual stroke indicator showing real-time device position
// Animates a marker on a vertical bar based on funscript interpolation

export class DeviceSimulator {
  /**
   * @param {object} opts
   * @param {import('../js/video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('../js/funscript-engine.js').FunscriptEngine} opts.funscriptEngine
   */
  constructor({ videoPlayer, funscriptEngine }) {
    this.player = videoPlayer;
    this.funscript = funscriptEngine;

    this._visible = false;
    this._panel = null;
    this._marker = null;
    this._posLabel = null;
    this._speedLabel = null;
    this._rafId = null;
    this._lastPosition = 50;
    this._lastTimeMs = 0;

    this._buildPanel();
  }

  _buildPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'device-sim';
    this._panel.hidden = true;

    this._panel.innerHTML = `
      <div class="device-sim__track">
        <div class="device-sim__fill"></div>
        <div class="device-sim__marker"></div>
      </div>
      <div class="device-sim__info">
        <span class="device-sim__pos">50</span>
        <span class="device-sim__speed">0</span>
      </div>
    `;

    this._marker = this._panel.querySelector('.device-sim__marker');
    this._fill = this._panel.querySelector('.device-sim__fill');
    this._posLabel = this._panel.querySelector('.device-sim__pos');
    this._speedLabel = this._panel.querySelector('.device-sim__speed');

    document.getElementById('app')?.appendChild(this._panel);
  }

  /**
   * Get the current interpolated position (0–100) from the funscript engine.
   * @returns {number}
   */
  getPosition() {
    if (!this.funscript.isLoaded) return 50;
    const timeMs = this.player.currentTime * 1000;
    return this.funscript.getPositionAt(timeMs);
  }

  /**
   * Calculate speed as position change per second.
   * @param {number} position — current position (0–100)
   * @param {number} timeMs — current time in ms
   * @returns {number} speed in pos-units/second
   */
  getSpeed(position, timeMs) {
    const dt = timeMs - this._lastTimeMs;
    if (dt <= 0) return 0;
    const dp = Math.abs(position - this._lastPosition);
    return (dp / dt) * 1000; // pos/sec
  }

  // --- Animation ---

  _startAnimation() {
    if (this._rafId) return;

    const loop = () => {
      if (!this._visible) return;
      this._update();
      this._rafId = requestAnimationFrame(loop);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  _stopAnimation() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _update() {
    const timeMs = this.player.currentTime * 1000;
    const position = this.getPosition();
    const speed = this.getSpeed(position, timeMs);

    // Update marker position (0 at bottom, 100 at top)
    const pct = Math.max(0, Math.min(100, position));
    this._marker.style.bottom = `${pct}%`;
    this._fill.style.height = `${pct}%`;

    // Update labels
    this._posLabel.textContent = Math.round(position);
    this._speedLabel.textContent = Math.round(speed);

    this._lastPosition = position;
    this._lastTimeMs = timeMs;
  }

  // --- Public API ---

  toggle() {
    if (this._visible) this.hide();
    else this.show();
  }

  show() {
    if (this._visible) return;
    this._visible = true;
    this._panel.hidden = false;
    this._lastTimeMs = this.player.currentTime * 1000;
    this._lastPosition = this.getPosition();
    this._startAnimation();
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this._panel.hidden = true;
    this._stopAnimation();
  }

  get isVisible() {
    return this._visible;
  }
}
