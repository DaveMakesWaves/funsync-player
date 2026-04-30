// VRPlaybackProxy — Virtual video element for VR companion mode
// Implements the same interface that sync engines bind to (currentTime, paused, duration, events).
// Fed by VR bridge with position updates from DeoVR/HereSphere.
//
// Smoothing pass (2026-04-28) — adopted MultiFunPlayer's two-stage filter
// pattern (`SCOPE-vr-sync-smoothing.md`):
//
//   Stage A — drift-clamped EMA on the internal anchor when a packet
//   arrives. Below the seek threshold (1 s), the new packet is blended
//   into the existing interpolated position with α = 0.20; above it,
//   we hard-snap and dispatch a `'seeked'` event. Eliminates the
//   ~50–500 ms network-jitter step that was reaching the consumer
//   getter on every packet at the prior naive snap.
//
//   Stage B — slew-rate-limited consumer getter. The visible
//   `currentTime` advances by between 0.9× and 1.1× of the expected
//   wall-clock delta per read. Eliminates micro-jitter even when the
//   internal anchor takes several packets to converge.
//
// Hard-snap branches that bypass smoothing: first packet ever,
// pause↔play state transitions, real-seek detection (drift > 1 s),
// programmatic `set currentTime`, and `reset()`. These all reset the
// consumer slew state so the new value is adopted instantly.
//
// Monotonicity guard on the consumer getter — gap-skip, Buttplug
// action-boundary scheduler, and TCode interpolator all assume
// `currentTime` never decreases between reads. The slew floor of
// 0.9 × expectedAdvance is positive when playing, but we add an
// explicit `Math.max(0, …)` belt-and-braces so the invariant survives
// future changes to the slew constants.

// Stage A — α = 0.20 EMA blend on packets below the seek threshold.
// Lower than MultiFunPlayer's 0.33 (their cadence is ~1 Hz; ours is
// ~10 Hz at HereSphere's default and even faster on configurable
// values). With α = 0.20 at 10 Hz, ~80 % of error is corrected in
// 8 packets (~800 ms) — fast enough to track real pace changes,
// slow enough to filter typical packet jitter.
const EMA_ALPHA = 0.20;

// Stage A — drift threshold for "this is a real seek, hard-snap and
// dispatch a `'seeked'` event". MFP uses 1.0 s; ScriptPlayer uses
// per-source thresholds (35–200 ms); our prior hard-snap path used
// 5 s as a "definitely a seek" guard but everything below was
// silently snapped. 1 s catches user seeks responsively while leaving
// the EMA room to absorb sub-second jitter.
const SEEK_THRESHOLD_S = 1.0;

// Stage B — slew clamp: ±10 % of the expected wall-clock advance per
// consumer read. Matches MultiFunPlayer's slew limit. Tighter values
// are smoother but lag legitimate pace changes; looser lets jitter
// through.
const SLEW_RATIO_MAX = 1.10;
const SLEW_RATIO_MIN = 0.90;

export class VRPlaybackProxy extends EventTarget {
  constructor() {
    super();
    this._currentTime = 0;
    this._duration = 0;
    this._paused = true;
    this._playbackSpeed = 1;
    this._lastUpdateTime = 0;     // performance.now() of last anchor update
    this._lastReportedTime = 0;   // smoothed anchor (EMA output) — drives interpolation
    this._ended = false;          // guard against repeated ended events
    this._offsetMs = 0;           // sync offset in ms (negative = send commands early)
    // Slew-rate-limited consumer state. Re-primed on every state
    // anchor (play / pause / seek / reset / hard-snap on real-seek)
    // so the slew clamp can't drag the consumer behind a legitimate
    // seek or play-resume. `_consumerLastReadAt === 0` means
    // "not primed; next read will adopt the raw smoothed value".
    this._consumerLastValue = 0;
    this._consumerLastReadAt = 0;
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

  /**
   * Raw VR-aligned position WITHOUT offset adjustment and WITHOUT slew
   * clamping. Used internally to compute drift in `updateFromVR` and
   * to capture/restore the anchor across pause→play transitions.
   * Don't expose — sync engines must read `currentTime` so they get
   * both the offset and the slew filter.
   */
  _rawSmoothedTime(now = performance.now()) {
    if (this._paused) return this._currentTime;
    const elapsed = (now - this._lastUpdateTime) / 1000;
    return this._lastReportedTime + (elapsed * this._playbackSpeed);
  }

  /**
   * Re-prime the slew clamp so the next consumer read adopts the raw
   * smoothed value directly. Called on every state anchor — without it,
   * the slew clamp would drag the consumer-visible time toward the new
   * anchor over multiple reads, lagging legitimate seeks and play
   * transitions.
   */
  _resetConsumerSlew() {
    this._consumerLastValue = 0;
    this._consumerLastReadAt = 0;
  }

  get currentTime() {
    const offset = this._offsetMs / 1000;
    if (this._paused) return this._currentTime - offset;

    const now = performance.now();
    const rawSmoothed = this._rawSmoothedTime(now) - offset;

    // First read after a state anchor — prime the slew state, return raw.
    if (this._consumerLastReadAt === 0) {
      this._consumerLastValue = rawSmoothed;
      this._consumerLastReadAt = now;
      return rawSmoothed;
    }

    const wallElapsed = (now - this._consumerLastReadAt) / 1000;
    // Same-tick re-read: no advance, return cached.
    if (wallElapsed <= 0) return this._consumerLastValue;

    // Slew clamp: bound the consumer-visible advance per read.
    const expectedAdvance = wallElapsed * this._playbackSpeed;
    const proposedAdvance = rawSmoothed - this._consumerLastValue;
    let clampedAdvance = Math.min(
      expectedAdvance * SLEW_RATIO_MAX,
      Math.max(expectedAdvance * SLEW_RATIO_MIN, proposedAdvance),
    );
    // Belt-and-braces monotonicity guard. The 0.9 × expectedAdvance
    // floor is already positive when playing, but the explicit clamp
    // documents the invariant and survives future changes to the
    // slew constants.
    clampedAdvance = Math.max(0, clampedAdvance);

    this._consumerLastValue = this._consumerLastValue + clampedAdvance;
    this._consumerLastReadAt = now;
    return this._consumerLastValue;
  }

  set currentTime(val) {
    // Programmatic seek — bypass smoothing, snap to the requested
    // value immediately. Sync engines re-read after a seek event and
    // adopt the new position in their next tick.
    this._currentTime = val;
    this._lastReportedTime = val;
    this._lastUpdateTime = performance.now();
    this._resetConsumerSlew();
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
      // Capture the raw un-offset position so subsequent reads while
      // paused (the getter re-applies offset on every read) don't
      // double-count the offset. Pre-2026-04-28 this captured
      // `this.currentTime` (offset-adjusted), which produced a visible
      // jump on pause when offset ≠ 0. Fixed as a side effect of the
      // smoothing rewrite.
      this._currentTime = this._rawSmoothedTime();
      this._paused = true;
      this._resetConsumerSlew();
      this.dispatchEvent(new Event('pause'));
    }
  }

  play() {
    if (this._paused) {
      this._paused = false;
      this._lastUpdateTime = performance.now();
      this._lastReportedTime = this._currentTime;
      this._resetConsumerSlew();
      this.dispatchEvent(new Event('playing'));
    }
    return Promise.resolve();
  }

  // --- Update methods (called by VR bridge) ---

  /**
   * Update state from VR player data. Stage A of the smoothing filter
   * lives here — drift-clamped EMA on the smoothed anchor for normal
   * playback packets; hard-snap on first-packet, state transitions,
   * and detected real seeks.
   *
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
    const nowPaused = state.playerState === 1;

    // Calculate where we EXPECTED the position to be based on
    // interpolation — used both for drift detection (real-seek vs
    // jitter) and for the EMA blend.
    let expectedTime = this._currentTime;
    if (!wasPaused && this._lastUpdateTime > 0) {
      const elapsed = (now - this._lastUpdateTime) / 1000;
      expectedTime = this._lastReportedTime + (elapsed * this._playbackSpeed);
    }
    const drift = Math.abs(newTime - expectedTime);

    // Branch: hard-snap or EMA blend.
    //   - First packet ever (no prior anchor to blend with).
    //   - Pause↔play state transition (re-anchor required).
    //   - Drift > SEEK_THRESHOLD_S (real user seek; we want to dispatch
    //     `'seeked'` and adopt the new position fully).
    // Otherwise: blend the new packet with the interpolated anchor by
    // α — the bulk of normal-playback packets land here.
    const isFirstPacket = this._lastUpdateTime === 0;
    const stateTransition = wasPaused !== nowPaused;
    const isSeek = !isFirstPacket && !stateTransition && drift > SEEK_THRESHOLD_S;
    const hardSnap = isFirstPacket || stateTransition || isSeek;

    if (hardSnap) {
      this._lastReportedTime = newTime;
      this._currentTime = newTime;
      this._lastUpdateTime = now;
      // Snap is a real anchor — let the consumer re-prime so the next
      // read adopts the new value instantly (no slew lag on a seek).
      this._resetConsumerSlew();
    } else {
      // EMA: blend the smoothed anchor toward the new packet by α of
      // the error. _currentTime tracks the anchor for consistency
      // (used by pause's capture path); consumer slew state is NOT
      // reset — its job is to follow the smoothed anchor.
      this._lastReportedTime = expectedTime + EMA_ALPHA * (newTime - expectedTime);
      this._currentTime = this._lastReportedTime;
      this._lastUpdateTime = now;
    }

    // State-transition events.
    if (wasPaused && !nowPaused) {
      this._paused = false;
      this.dispatchEvent(new Event('playing'));
    } else if (!wasPaused && nowPaused) {
      this._paused = true;
      this.dispatchEvent(new Event('pause'));
    }

    // Real-seek event — fired only when we hard-snapped due to drift.
    // First-packet and state-transition snaps have their own semantic
    // events ('playing' / 'pause') and don't represent seeks.
    if (isSeek) {
      this.dispatchEvent(new Event('seeked'));
    }

    // Detect video end (only fire once — guard with _ended flag).
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
    this._resetConsumerSlew();
  }
}
