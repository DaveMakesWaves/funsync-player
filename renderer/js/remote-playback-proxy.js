// RemotePlaybackProxy — virtual video element for the web remote.
//
// Fed by RemoteBridge with {at, paused, rate} events from the phone's
// <video> element over WebSocket. Exposes the same interface sync engines
// already bind to (VideoPlayer-like wrapper with `.video`, `.currentTime`,
// `.paused`, `.duration`). Explicit seek / play / pause / ended events are
// dispatched as HTML5 video events so the existing sync-engine code needs
// zero changes.
//
// Differences from VRPlaybackProxy (HereSphere/DeoVR companion):
//   - Time values arrive in MILLISECONDS (funscript convention, matches
//     phone's HTMLMediaElement.currentTime * 1000).
//   - `seek` / `play` / `pause` / `ended` events arrive *explicitly* from
//     the phone, so we don't need drift-based seek detection.
//   - Rate (playbackSpeed) is optional; defaults to 1.

export class RemotePlaybackProxy extends EventTarget {
  constructor() {
    super();
    this._currentTimeSec = 0;       // last authoritative time in seconds
    this._duration = 0;
    this._paused = true;
    this._playbackRate = 1;
    this._ended = false;
    this._lastUpdateWallMs = 0;     // performance.now() when last state arrived
  }

  // --- HTMLVideoElement-shaped interface --------------------------------

  get currentTime() {
    // Interpolate between updates for smooth sync-engine reads.
    if (this._paused) return this._currentTimeSec;
    const elapsed = (performance.now() - this._lastUpdateWallMs) / 1000;
    return this._currentTimeSec + (elapsed * this._playbackRate);
  }

  set currentTime(v) {
    this._currentTimeSec = v;
    this._lastUpdateWallMs = performance.now();
  }

  get duration() { return this._duration; }
  get paused() { return this._paused; }
  get playbackRate() { return this._playbackRate; }

  play() {
    if (this._paused) {
      this._paused = false;
      this._lastUpdateWallMs = performance.now();
      this.dispatchEvent(new Event('playing'));
    }
    return Promise.resolve();
  }

  pause() {
    if (!this._paused) {
      this._currentTimeSec = this.currentTime;  // freeze interpolated time
      this._lastUpdateWallMs = performance.now();
      this._paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }

  // --- Bridge-facing update methods ------------------------------------

  /**
   * Apply a `state` message from the phone.
   * @param {{at: number, paused?: boolean, rate?: number, duration?: number}} state
   */
  updateState(state) {
    if (!state || typeof state !== 'object') return;

    const now = performance.now();
    const wasPaused = this._paused;

    if (typeof state.at === 'number') {
      this._currentTimeSec = state.at / 1000;
      this._lastUpdateWallMs = now;
    }
    if (typeof state.rate === 'number' && state.rate > 0) {
      this._playbackRate = state.rate;
    }
    if (typeof state.duration === 'number' && state.duration > 0) {
      this._duration = state.duration;
    }

    if (typeof state.paused === 'boolean') {
      const nowPaused = state.paused;
      if (wasPaused && !nowPaused) {
        this._paused = false;
        this.dispatchEvent(new Event('playing'));
      } else if (!wasPaused && nowPaused) {
        this._paused = true;
        this.dispatchEvent(new Event('pause'));
      }
    }

    // Reset the ended guard whenever position moves away from the end.
    if (this._duration > 0 && this._currentTimeSec < this._duration - 1) {
      this._ended = false;
    }
  }

  /**
   * Explicit seek event from the phone — fires `seeked` without the drift
   * detection that VRPlaybackProxy needs.
   */
  seek(atMs) {
    this._currentTimeSec = (atMs || 0) / 1000;
    this._lastUpdateWallMs = performance.now();
    this.dispatchEvent(new Event('seeked'));
  }

  /** Explicit play event from the phone. */
  handlePlay() {
    if (this._paused) {
      this._paused = false;
      this._lastUpdateWallMs = performance.now();
      this.dispatchEvent(new Event('playing'));
    }
  }

  /** Explicit pause event from the phone. */
  handlePause() {
    if (!this._paused) {
      this._currentTimeSec = this.currentTime;
      this._lastUpdateWallMs = performance.now();
      this._paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }

  /** Explicit ended event from the phone. */
  handleEnded() {
    if (!this._ended) {
      this._ended = true;
      this._paused = true;
      this.dispatchEvent(new Event('ended'));
    }
  }

  /** Hard reset — used on remote disconnect so sync engines see a fresh slate. */
  reset() {
    this._currentTimeSec = 0;
    this._duration = 0;
    this._paused = true;
    this._playbackRate = 1;
    this._ended = false;
    this._lastUpdateWallMs = 0;
  }

  /**
   * Wrap this proxy as a VideoPlayer-like object (has a `.video` pointing
   * to the EventTarget). Sync engines read `.video.addEventListener(...)`
   * and `.currentTime` / `.paused` / `.duration` from the wrapper.
   */
  asVideoPlayerWrapper() {
    const proxy = this;
    return {
      video: proxy,
      get currentTime() { return proxy.currentTime; },
      get paused() { return proxy.paused; },
      get duration() { return proxy.duration; },
    };
  }
}
