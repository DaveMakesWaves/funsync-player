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
  // No state for this long while "playing" → synthesize pause (see
  // _armStaleWatchdog). 8× the phone's 250ms state cadence.
  static STALE_LIMIT_MS = 2000;

  constructor() {
    super();
    this._currentTimeSec = 0;       // last authoritative time in seconds
    this._duration = 0;
    this._paused = true;
    this._playbackRate = 1;
    this._ended = false;
    this._lastUpdateWallMs = 0;     // performance.now() when last state arrived
    this._staleTimer = null;
    // N-01: the player pop-out reports its element's own `paused` and,
    // separately, `stalled` (the picture cannot move: starved, seeking,
    // failed or frozen). `_paused` above is what the engines see: paused OR
    // stalled, so a stall reaches them as a 'pause' and its end as a
    // 'playing', and currentTime stops extrapolating through it. The phone
    // folds a stall into `paused` itself and never sends `stalled`.
    this._sourcePaused = true;
    this._stalled = false;
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
  /**
   * The source element's own paused flag, without a stall. What a Play /
   * Pause TOGGLE must read: during a stall `paused` is true while the video
   * is still playing, and toggling from it would ask a playing video to play.
   */
  get sourcePaused() { return this._sourcePaused; }
  /** True while the source reports a stalled picture (N-01). */
  get stalled() { return this._stalled; }

  play() {
    if (this._paused) {
      this._paused = false;
      this._lastUpdateWallMs = performance.now();
      this._armStaleWatchdog();
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
   * Apply a `state` message from the phone (or a TIME_TICK from the player
   * pop-out, which adds `stalled`).
   * @param {{at: number, paused?: boolean, stalled?: boolean, rate?: number, duration?: number}} state
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

    if (typeof state.paused === 'boolean' || typeof state.stalled === 'boolean') {
      if (typeof state.paused === 'boolean') this._sourcePaused = state.paused;
      if (typeof state.stalled === 'boolean') this._stalled = state.stalled;
      const nowPaused = this._sourcePaused || this._stalled;
      if (wasPaused && !nowPaused) {
        this._paused = false;
        this._armStaleWatchdog();
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
    this._sourcePaused = false;
    // A Play on a picture that cannot move yet (N-01: the pop-out ticks
    // `stalled` just before its 'play') starts nothing: the tick that says
    // it moves does.
    if (this._paused && !this._stalled) {
      this._paused = false;
      this._lastUpdateWallMs = performance.now();
      this._armStaleWatchdog();
      this.dispatchEvent(new Event('playing'));
    }
  }

  /** Explicit pause event from the phone. */
  handlePause() {
    this._sourcePaused = true;
    if (!this._paused) {
      this._currentTimeSec = this.currentTime;
      this._lastUpdateWallMs = performance.now();
      this._paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }

  /** Explicit ended event from the phone. */
  handleEnded() {
    this._sourcePaused = true;
    this._stalled = false;
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
    this._sourcePaused = true;
    this._stalled = false;
    this._playbackRate = 1;
    this._ended = false;
    this._lastUpdateWallMs = 0;
    this._disarmStaleWatchdog();
  }

  /**
   * Liveness watchdog (same idea as the VR bridge's 8s one, tighter because
   * the phone's state cadence is ~250ms): while "playing", the currentTime
   * getter extrapolates from the last state — with NO cap. If the phone goes
   * silent without a pause (dead socket before the backend's grace fires,
   * hidden page with timeupdate starved), the sync engines would drive
   * devices along a timeline the video has left, indefinitely. No state for
   * STALE_LIMIT_MS while unpaused → synthesize a pause, which the engines
   * already handle by stopping devices. A later state with paused:false
   * resumes through the normal updateState transition.
   */
  _armStaleWatchdog() {
    if (this._staleTimer) return;
    this._staleTimer = setInterval(() => {
      if (this._paused) { this._disarmStaleWatchdog(); return; }
      if (performance.now() - this._lastUpdateWallMs > RemotePlaybackProxy.STALE_LIMIT_MS) {
        this.pause();
        this._disarmStaleWatchdog();
      }
    }, 500);
  }

  _disarmStaleWatchdog() {
    if (this._staleTimer) {
      clearInterval(this._staleTimer);
      this._staleTimer = null;
    }
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
