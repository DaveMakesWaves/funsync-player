// VRPlaybackProxy — Virtual video element for VR companion mode
// Implements the same interface that sync engines bind to (currentTime, paused, duration, events).
// Fed by VR bridge with position updates from DeoVR/HereSphere.

export class VRPlaybackProxy extends EventTarget {
  constructor() {
    super();
    this._currentTime = 0;
    this._duration = 0;
    this._paused = true;
    this._playbackSpeed = 1;
    this._lastUpdateTime = 0;     // performance.now() of last state update
    this._lastReportedTime = 0;   // currentTime from last VR player update
    this._ended = false;          // guard against repeated ended events
    this._offsetMs = 0;           // sync offset in ms (negative = send commands early)
  }

  // --- Public interface (matches HTMLVideoElement subset used by sync engines) ---

  /**
   * Set the sync offset in milliseconds.
   * Negative values make device commands fire EARLY (compensate for VR latency).
   * @param {number} offsetMs
   */
  setOffset(offsetMs) {
    this._offsetMs = offsetMs || 0;
  }

  get currentTime() {
    // Interpolate between VR player updates using local clock, applying offset
    const offset = this._offsetMs / 1000; // convert to seconds
    if (this._paused) return this._currentTime - offset;
    const elapsed = (performance.now() - this._lastUpdateTime) / 1000;
    return this._lastReportedTime + (elapsed * this._playbackSpeed) - offset;
  }

  set currentTime(val) {
    this._currentTime = val;
    this._lastReportedTime = val;
    this._lastUpdateTime = performance.now();
  }

  get duration() { return this._duration; }
  get paused() { return this._paused; }
  get playbackRate() { return this._playbackSpeed; }

  // Stub methods sync engines may call
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
  }

  pause() {
    if (!this._paused) {
      this._paused = true;
      this._currentTime = this.currentTime; // capture interpolated time
      this.dispatchEvent(new Event('pause'));
    }
  }

  play() {
    if (this._paused) {
      this._paused = false;
      this._lastUpdateTime = performance.now();
      this._lastReportedTime = this._currentTime;
      this.dispatchEvent(new Event('playing'));
    }
    return Promise.resolve();
  }

  // --- Update methods (called by VR bridge) ---

  /**
   * Update state from VR player data.
   * @param {object} state
   * @param {number} state.currentTime — seconds
   * @param {number} state.duration — seconds
   * @param {number} state.playerState — 0=playing, 1=paused
   * @param {number} state.playbackSpeed — float
   */
  updateFromVR(state) {
    const wasPaused = this._paused;
    const now = performance.now();

    this._duration = state.duration || 0;
    this._playbackSpeed = state.playbackSpeed || 1;

    const newTime = state.currentTime || 0;

    // Calculate where we EXPECTED the position to be based on interpolation
    let expectedTime = this._currentTime;
    if (!wasPaused && this._lastUpdateTime > 0) {
      const elapsed = (now - this._lastUpdateTime) / 1000;
      expectedTime = this._lastReportedTime + (elapsed * this._playbackSpeed);
    }

    // Update position
    this._lastReportedTime = newTime;
    this._lastUpdateTime = now;
    this._currentTime = newTime;

    // Detect state changes
    const nowPaused = state.playerState === 1;

    if (wasPaused && !nowPaused) {
      this._paused = false;
      this.dispatchEvent(new Event('playing'));
    } else if (!wasPaused && nowPaused) {
      this._paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    // Detect seek: new position differs from EXPECTED interpolated position by > 5s
    // Normal playback drift is < 2s even with infrequent updates
    if (!wasPaused && !nowPaused && this._lastUpdateTime > 0) {
      const drift = Math.abs(newTime - expectedTime);
      if (drift > 5) {
        this.dispatchEvent(new Event('seeked'));
      }
    }

    // Detect video end (only fire once — guard with _ended flag)
    if (this._duration > 0 && this._currentTime >= this._duration - 0.5 && !nowPaused && !this._ended) {
      this._ended = true;
      this._paused = true;
      this.dispatchEvent(new Event('ended'));
    } else if (this._currentTime < this._duration - 1) {
      this._ended = false; // reset when position moves away from end
    }
  }

  /**
   * Reset state (on disconnect or new video).
   */
  reset() {
    this._currentTime = 0;
    this._duration = 0;
    this._paused = true;
    this._playbackSpeed = 1;
    this._lastUpdateTime = 0;
    this._lastReportedTime = 0;
  }
}
