// ButtplugSync — Reliable sync engine for Buttplug.io devices
// Uses setInterval (not RAF) so it survives tab backgrounding.
// Rate-limited to avoid overwhelming Bluetooth, with dirty-check to skip redundant sends.
//
// Linear strategy:
//   - 'action-boundary' (default): one LinearCmd per funscript action transition,
//     with duration = full stroke length. The device's firmware handles the
//     in-stroke interpolation — no mid-stroke retargeting, much smoother on BLE
//     (Handy / Kiiroo / Fredorch). This matches the semantics of the BLE
//     protocol's "move to X over Y ms" command and avoids the ~10-commands-per-
//     stroke flood the interpolated strategy produces.
//   - 'interpolated' (legacy): re-samples between actions at ~20Hz and sends
//     fresh LinearCmds with the remaining duration. Produces visibly smoother
//     motion on devices that DON'T do their own firmware interpolation, but
//     overwhelms BLE with mid-stroke retargets on devices that do.
//
// Derived-intensity paths (vibration/scalar/rotate inferred from stroke speed)
// stay on the interpolated schedule regardless — those commands don't carry a
// duration and need frequent re-sampling to track stroke speed.

import { getInterpolator, applySpeedLimit, linearInterpolate } from './interpolation.js';

const TICK_INTERVAL_MS = 40;     // ~25Hz polling — safe for BLE
const MIN_SEND_INTERVAL_MS = 50; // Don't send derived-intensity commands faster than this
const MAX_GAP_MS = 5000;         // Don't send commands for actions more than 5s away
const MIN_POS_DELTA = 0.5;       // Skip sends when position change is < 0.5 (out of 100)

const DEFAULT_LOOKAHEAD_MS = 60;      // BLE round-trip compensation — fire command this far before action
const DEFAULT_MIN_STROKE_MS = 60;     // Floor on stroke duration — clamp sub-BLE-roundtrip strokes up

export class ButtplugSync {
  /**
   * @param {object} opts
   * @param {import('./video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('./buttplug-manager.js').ButtplugManager} opts.buttplugManager
   * @param {import('./funscript-engine.js').FunscriptEngine} opts.funscriptEngine
   */
  constructor({ videoPlayer, buttplugManager, funscriptEngine }) {
    this.player = videoPlayer;
    this.buttplug = buttplugManager;
    this.funscript = funscriptEngine;

    this._active = false;
    this._intervalId = null;
    this._lastActionIndex = -1;
    this._lastSendTime = 0;       // timestamp of last command sent
    this._lastSentPos = -1;       // last position sent (for dirty check)
    this._actions = null;
    this._vibActions = null;       // separate vibration script actions (multi-axis)
    this._vibActionIndex = -1;
    this._lastVibSendTime = 0;
    this._lastVibSentIntensity = -1;

    // Multi-axis action arrays: tcode → { actions, index, lastSendTime, lastSentValue }
    this._axisActions = new Map();
    // Per-device axis assignment: deviceIndex → tcode (e.g. 'L0', 'R0', 'V0')
    this._axisAssignmentMap = new Map();
    this._invertedDevices = new Set();
    this._vibeModeMap = new Map();          // deviceIndex → 'speed'|'position'|'intensity'
    this._scalarModeMap = new Map();        // deviceIndex → 'speed'|'position'|'intensity'
    this._rotateModeMap = new Map();        // deviceIndex → 'speed'|'position'|'intensity'
    this._maxIntensityMap = new Map();      // deviceIndex → 0-100 (safety cap for e-stim)
    this._rampUpMap = new Map();            // deviceIndex → true/false
    this._rampUpStartTime = 0;             // timestamp when playback started (for ramp-up calc)
    this._rampUpDuration = 2000;           // ms for ramp-up

    // Interpolation
    this._interpolationMode = 'linear';
    this._interpolator = linearInterpolate;
    this._speedLimit = 0; // 0 = disabled, otherwise pos-units per second
    this._vibInterpolationMode = 'step'; // vibration defaults to step

    // Linear command scheduling. action-boundary fires ONE LinearCmd per
    // funscript action transition; interpolated resends every tick. See
    // module header for the full rationale.
    this._linearStrategy = 'action-boundary';
    this._linearLookaheadMs = DEFAULT_LOOKAHEAD_MS;
    this._minStrokeMs = DEFAULT_MIN_STROKE_MS;

    // Per-device sync offset in ms. NEGATIVE = fire commands earlier
    // (compensate for BLE latency / VR display lag). Applied to every
    // time-read so the sync scheduler thinks the video is slightly
    // further along than it actually is, which causes it to dispatch
    // the action that's coming up.
    this._offsetMs = 0;
    // Tracks which action-boundary the linear commands have been dispatched
    // for. Separate from _lastActionIndex (which is also updated by the
    // derived-intensity path) so the two schedules don't clobber each other.
    this._lastLinearSentForIdx = -1;
    // Same per axis — tcode → index we've already sent a LinearCmd for.
    this._axisLastLinearSentIdx = new Map();

    // Custom routing mode — when active, only explicitly assigned devices get commands
    this._customRoutingActive = false;

    // Callbacks
    this.onSyncStatus = null; // (status: 'synced'|'idle') => {}
    this.onCommandSent = null; // () => {} — fires when a command is dispatched (for activity indicator)
  }

  /**
   * Start the sync engine. Call after video and funscript are loaded
   * and a Buttplug device is connected.
   */
  start() {
    if (this._active) return;

    this._active = true;
    this._cacheActions();
    this._bindVideoEvents();

    if (!this.player.paused) {
      this._resetIndex();
      this._resetVibIndex();
      this._lastSentPos = -1;
      this._lastVibSentIntensity = -1;
      this._rampUpStartTime = performance.now();
      this._startScheduler();
    }

    console.log('[ButtplugSync] Started');
  }

  /**
   * Stop the sync engine.
   */
  stop() {
    this._active = false;
    this._unbindVideoEvents();
    this._stopScheduler();
    this._lastActionIndex = -1;
    this._lastSentPos = -1;
    this._lastSendTime = 0;
    this._vibActionIndex = -1;
    this._lastVibSendTime = 0;
    this._lastVibSentIntensity = -1;
    this._lastLinearSentForIdx = -1;
    this._axisLastLinearSentIdx.clear();

    console.log('[ButtplugSync] Stopped');
  }

  /**
   * Reload cached actions (e.g. after editor changes).
   */
  reloadActions() {
    this._cacheActions();
    this._lastActionIndex = -1;
    this._lastSentPos = -1;
    this._vibActionIndex = -1;
    this._lastVibSentIntensity = -1;
    this._lastLinearSentForIdx = -1;
    this._axisLastLinearSentIdx.clear();
    for (const [, state] of this._axisActions) {
      state.index = -1;
      state.lastSentValue = -1;
      state.lastSendTime = 0;
    }
  }

  get hasVibScript() {
    return !!this._vibActions;
  }

  /**
   * Set a separate vibration script (multi-axis).
   * When set, vibrate devices use this instead of deriving from the main stroke script.
   * @param {Array<{at: number, pos: number}>} actions
   */
  setVibrationActions(actions) {
    this._vibActions = actions && actions.length >= 2 ? actions : null;
    this._vibActionIndex = -1;
    this._lastVibSentIntensity = -1;
  }

  // --- Action cache ---

  _cacheActions() {
    if (this.funscript.isLoaded) {
      this._actions = this.funscript.getActions();
    } else {
      this._actions = null;
    }
  }

  // --- Video event wiring ---

  _bindVideoEvents() {
    const video = this.player.video;
    this._onPlaying = () => this._handlePlaying();
    this._onPause = () => this._handlePause();
    this._onSeeked = () => this._handleSeeked();
    this._onEnded = () => this._handleEnded();

    video.addEventListener('playing', this._onPlaying);
    video.addEventListener('pause', this._onPause);
    video.addEventListener('seeked', this._onSeeked);
    video.addEventListener('ended', this._onEnded);
  }

  _unbindVideoEvents() {
    const video = this.player.video;
    if (this._onPlaying) video.removeEventListener('playing', this._onPlaying);
    if (this._onPause) video.removeEventListener('pause', this._onPause);
    if (this._onSeeked) video.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) video.removeEventListener('ended', this._onEnded);
  }

  _handlePlaying() {
    if (!this._active) return;
    this._resetIndex();
    this._resetVibIndex();
    this._resetAxisIndices();
    this._lastSentPos = -1;
    this._lastVibSentIntensity = -1;
    this._lastLinearSentForIdx = -1;
    this._axisLastLinearSentIdx.clear();
    this._rampUpStartTime = performance.now();
    this._startScheduler();
    this._emitStatus('synced');
  }

  _handlePause() {
    if (!this._active) return;
    this._stopScheduler();
    this.buttplug.stopAll();
    this._lastSentPos = -1;
    this._lastVibSentIntensity = -1;
    this._emitStatus('idle');
  }

  _handleSeeked() {
    if (!this._active) return;
    this._resetIndex();
    this._lastSentPos = -1;
    this._resetVibIndex();
    this._resetAxisIndices();
    this._lastVibSentIntensity = -1;
    this._lastLinearSentForIdx = -1;
    this._axisLastLinearSentIdx.clear();
    this._rampUpStartTime = performance.now(); // reset ramp-up on seek
  }

  _handleEnded() {
    if (!this._active) return;
    this._stopScheduler();
    this.buttplug.stopAll();
    this._lastSentPos = -1;
    this._lastVibSentIntensity = -1;
    this._emitStatus('idle');
  }

  // --- Scheduler (setInterval — survives tab backgrounding) ---

  /**
   * Find the action index just before the current video time.
   */
  _resetIndex() {
    if (!this._actions || this._actions.length === 0) {
      this._lastActionIndex = -1;
      return;
    }

    const timeMs = this._currentTimeMs();

    let lo = 0;
    let hi = this._actions.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this._actions[mid].at <= timeMs) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    this._lastActionIndex = result;
  }

  _resetVibIndex() {
    if (!this._vibActions || this._vibActions.length === 0) {
      this._vibActionIndex = -1;
      return;
    }
    const timeMs = this._currentTimeMs();
    let lo = 0;
    let hi = this._vibActions.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this._vibActions[mid].at <= timeMs) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    this._vibActionIndex = result;
  }

  _resetAxisIndices() {
    const timeMs = this._currentTimeMs();
    for (const [, state] of this._axisActions) {
      let lo = 0, hi = state.actions.length - 1, result = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (state.actions[mid].at <= timeMs) { result = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      state.index = result;
      state.lastSentValue = -1;
      state.lastSendTime = 0;
    }
  }

  _startScheduler() {
    if (this._intervalId) return;

    this._intervalId = setInterval(() => {
      if (!this._active || this.player.paused) return;
      this._sendPendingActions();
      if (this._vibActions) this._sendPendingVibActions();
      if (this._axisActions.size > 0) this._sendPendingAxisActions();
    }, TICK_INTERVAL_MS);
  }

  _stopScheduler() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Core scheduling loop — runs every TICK_INTERVAL_MS.
   *
   * Splits into two schedules:
   *   1. Linear: action-boundary OR interpolated, depending on _linearStrategy.
   *      Action-boundary fires ONE LinearCmd per funscript action transition;
   *      the device's firmware handles in-stroke interpolation. Interpolated
   *      resends at tick-rate with remaining duration (legacy).
   *   2. Derived intensity (vibration/scalar/rotate inferred from stroke
   *      speed): always on the interpolated schedule, rate-limited to
   *      MIN_SEND_INTERVAL_MS. These commands have no duration field and
   *      need frequent re-sampling to track the stroke.
   */
  _sendPendingActions() {
    if (!this._actions || this._actions.length < 2) return;
    if (!this.buttplug.connected) return;

    const now = performance.now();
    const timeMs = this._currentTimeMs();

    // ---- Linear scheduling ----
    if (this._linearStrategy === 'action-boundary') {
      this._dispatchLinearAtBoundary(timeMs);
    } else {
      // Legacy interpolated mode — fall through to the same path as derived
      // below but also emit linear from it.
    }

    // ---- Derived intensity + (legacy) interpolated linear ----
    // Rate limit — don't send faster than MIN_SEND_INTERVAL_MS
    if (now - this._lastSendTime < MIN_SEND_INTERVAL_MS) return;

    // Catch up index for position tracking
    while (this._lastActionIndex + 1 < this._actions.length &&
           this._actions[this._lastActionIndex + 1].at <= timeMs) {
      this._lastActionIndex++;
    }

    // Check we're within the action range
    if (this._lastActionIndex < 0) return;
    const nextIdx = this._lastActionIndex + 1;
    if (nextIdx >= this._actions.length) return;

    const nextAction = this._actions[nextIdx];
    const duration = Math.max(MIN_SEND_INTERVAL_MS, nextAction.at - timeMs);

    // Skip if next action is too far away (avoids very slow moves during gaps)
    if (duration > MAX_GAP_MS) return;

    // Compute interpolated position at current time
    if (!this._actions || !this._interpolator) return;
    let targetPos = this._interpolator(this._actions, timeMs);
    if (targetPos === null) return;

    // Apply speed limit
    if (this._speedLimit > 0 && this._lastSentPos >= 0) {
      const deltaMs = now - this._lastSendTime;
      targetPos = applySpeedLimit(targetPos, this._lastSentPos, deltaMs, this._speedLimit);
    }

    // Dirty check — skip if position barely changed (but always send first command)
    if (this._lastSentPos >= 0 && Math.abs(targetPos - this._lastSentPos) < MIN_POS_DELTA) return;

    const prevPos = this._lastSentPos >= 0 ? this._lastSentPos : targetPos;
    // In action-boundary mode, skip linear emission here — it was handled above.
    const emitLinear = this._linearStrategy !== 'action-boundary';
    this._sendToDevices(targetPos, duration, prevPos, { emitLinear });
    this._lastSendTime = now;
    this._lastSentPos = targetPos;
    if (this.onCommandSent) this.onCommandSent();
  }

  /**
   * Action-boundary linear scheduler. Fires ONE LinearCmd per action
   * transition with the full stroke duration, pre-scheduled by
   * _linearLookaheadMs to compensate for BLE round-trip. The Handy and
   * similar BLE strokers handle their own in-stroke interpolation, so
   * one command per stroke produces the smoothest motion.
   */
  _dispatchLinearAtBoundary(timeMs) {
    if (!this._actions || this._actions.length < 2) return;
    const lookahead = this._linearLookaheadMs || 0;

    // Advance through any action boundaries we've crossed this tick (plus
    // any we're about to cross within the lookahead window).
    while (this._lastActionIndex + 1 < this._actions.length &&
           this._actions[this._lastActionIndex + 1].at - lookahead <= timeMs) {
      this._lastActionIndex++;
    }

    if (this._lastActionIndex < 0) return;
    const nextIdx = this._lastActionIndex + 1;
    if (nextIdx >= this._actions.length) return;

    // Already dispatched for this boundary? Nothing to do until we cross
    // the next one.
    if (this._lastLinearSentForIdx >= nextIdx) return;

    const currentAction = this._actions[this._lastActionIndex];
    const nextAction = this._actions[nextIdx];
    const strokeDuration = nextAction.at - currentAction.at;

    // Skip silent gaps — don't slow-crawl the device to a position that's
    // seconds away.
    if (strokeDuration > MAX_GAP_MS) {
      this._lastLinearSentForIdx = nextIdx;
      return;
    }

    // Coalesce sub-BLE-roundtrip strokes: the device can't honor
    // 20ms "move and arrive" commands over BLE. Floor the duration at
    // _minStrokeMs so the device has time to actually execute.
    const duration = Math.max(this._minStrokeMs || 0, strokeDuration);

    const prevPos = this._lastSentPos >= 0 ? this._lastSentPos : currentAction.pos;
    this._sendLinearToDevices(nextAction.pos, duration, prevPos);
    this._lastLinearSentForIdx = nextIdx;
    // Deliberately do NOT mutate _lastSentPos here — that field feeds the
    // derived-intensity path's dirty check + speed-limit calc, and the
    // derived path tracks interpolated position, not action targets.
    if (this.onCommandSent) this.onCommandSent();
  }

  /**
   * Emit LinearCmd to every linear-capable device that the main stroke
   * script should drive. Separate from _sendToDevices so the derived
   * path can opt out of linear emission (action-boundary gating).
   */
  _sendLinearToDevices(position, durationMs, prevPosition) {
    const devices = this.buttplug.devices;
    for (const dev of devices) {
      if (!dev.canLinear) continue;
      const assigned = this._axisAssignmentMap.get(dev.index);
      if (assigned && assigned !== 'L0') continue;
      if (this._customRoutingActive && !assigned) continue;
      const inverted = this._invertedDevices.has(dev.index);
      const pos = inverted ? 100 - position : position;
      this.buttplug.sendLinear(dev.index, pos, durationMs);
    }
  }

  /**
   * Send commands to all connected devices.
   * @param {number} position — target position 0–100
   * @param {number} durationMs — time to reach position
   * @param {number} prevPosition — previous position 0–100
   * @param {{emitLinear?: boolean}} [opts] — emitLinear:false skips linear
   *        emission (used when action-boundary scheduler already handled it)
   */
  _sendToDevices(position, durationMs, prevPosition, opts = {}) {
    const emitLinear = opts.emitLinear !== false;
    const devices = this.buttplug.devices;

    for (const dev of devices) {
      // Skip devices assigned to a specific axis — they're driven by _sendPendingAxisActions
      const assigned = this._axisAssignmentMap.get(dev.index);
      if (assigned && assigned !== 'L0') continue;

      // In custom routing mode, only devices explicitly assigned to L0 get main script
      // (unassigned devices should not receive any commands)
      if (this._customRoutingActive && !assigned) continue;

      const inverted = this._invertedDevices.has(dev.index);
      const pos = inverted ? 100 - position : position;
      const prevPos = inverted ? 100 - prevPosition : prevPosition;

      if (dev.canLinear && emitLinear) {
        this.buttplug.sendLinear(dev.index, pos, durationMs);
      }
      // Only drive vibrate from main script if no separate vib script is loaded
      if (dev.canVibrate && !this._vibActions) {
        const mode = this._vibeModeMap.get(dev.index) || 'speed';
        const intensity = this._computeVibeIntensity(mode, pos, prevPos, durationMs);
        this.buttplug.sendVibrate(dev.index, intensity);
      }
      // E-stim / scalar devices (skip if dedicated vib script is loaded — vib path drives them)
      if (dev.canScalar && !this._vibActions) {
        const mode = this._scalarModeMap.get(dev.index) || 'position';
        let intensity = this._computeVibeIntensity(mode, pos, prevPos, durationMs);
        intensity = this._applyScalarSafety(dev.index, intensity);
        this.buttplug.sendScalar(dev.index, intensity);
      }
      // Rotation devices
      if (dev.canRotate) {
        const mode = this._rotateModeMap.get(dev.index) || 'speed';
        if (mode === 'position') {
          const clockwise = pos < 50;
          const speed = pos < 50 ? ((50 - pos) / 50) * 100 : ((pos - 50) / 50) * 100;
          this.buttplug.sendRotate(dev.index, speed, clockwise);
        } else {
          const intensity = this._computeVibeIntensity(mode, pos, prevPos, durationMs);
          const clockwise = pos >= prevPos;
          this.buttplug.sendRotate(dev.index, intensity, clockwise);
        }
      }
    }
  }

  /**
   * Apply e-stim safety: max intensity cap + ramp-up.
   * @param {number} deviceIndex
   * @param {number} intensity — raw intensity 0–100
   * @returns {number} capped and ramped intensity 0–100
   */
  _applyScalarSafety(deviceIndex, intensity) {
    // Apply max intensity cap
    const maxCap = this._maxIntensityMap.get(deviceIndex);
    const cap = maxCap !== undefined ? maxCap : 70; // default 70% for e-stim
    intensity = Math.min(intensity, cap);

    // Apply ramp-up if enabled
    const rampEnabled = this._rampUpMap.get(deviceIndex);
    if (rampEnabled !== false) { // default on
      const elapsed = performance.now() - this._rampUpStartTime;
      if (elapsed < this._rampUpDuration) {
        const rampFactor = elapsed / this._rampUpDuration;
        intensity *= rampFactor;
      }
    }

    return Math.max(0, Math.min(100, intensity));
  }

  /**
   * Send vibration commands from the dedicated vibration script.
   * The vib funscript uses pos 0-100 as vibration intensity directly.
   */
  _sendPendingVibActions() {
    if (!this._vibActions || this._vibActions.length < 2) return;
    if (!this.buttplug.connected) return;

    const now = performance.now();
    const timeMs = this._currentTimeMs();

    if (now - this._lastVibSendTime < MIN_SEND_INTERVAL_MS) return;

    // Catch up
    while (this._vibActionIndex + 1 < this._vibActions.length &&
           this._vibActions[this._vibActionIndex + 1].at <= timeMs) {
      this._vibActionIndex++;
    }

    if (this._vibActionIndex < 0 || this._vibActionIndex >= this._vibActions.length) return;

    const action = this._vibActions[this._vibActionIndex];
    const intensity = Math.max(0, Math.min(100, action.pos));

    // Dirty check
    if (Math.abs(intensity - this._lastVibSentIntensity) < MIN_POS_DELTA) return;

    const devices = this.buttplug.devices;
    for (const dev of devices) {
      // Skip devices assigned to non-default axes — they're driven by _sendPendingAxisActions
      const assigned = this._axisAssignmentMap.get(dev.index);
      if (assigned && assigned !== 'L0' && assigned !== 'V0') continue;
      if (this._customRoutingActive && !assigned) continue;

      if (dev.canVibrate) {
        this.buttplug.sendVibrate(dev.index, intensity);
      }
      if (dev.canScalar) {
        let scalarIntensity = intensity;
        scalarIntensity = this._applyScalarSafety(dev.index, scalarIntensity);
        this.buttplug.sendScalar(dev.index, scalarIntensity);
      }
    }

    this._lastVibSendTime = now;
    this._lastVibSentIntensity = intensity;
  }

  /**
   * Send pending multi-axis actions to devices assigned to those axes.
   * Each axis has independent action tracking.
   *
   * Linear-family axes (L, A) and custom-routed linear devices go through
   * the action-boundary scheduler for the same smoothness reasons as the
   * main stroke script. Vibration/rotate/scalar axes stay on the
   * interpolated tick-rate schedule (those commands have no duration
   * field and need re-sampling).
   */
  _sendPendingAxisActions() {
    if (!this.buttplug.connected) return;

    const now = performance.now();
    const timeMs = this._currentTimeMs();
    const devices = this.buttplug.devices;

    for (const [tcode, state] of this._axisActions) {
      if (!state.actions || state.actions.length < 2) continue;

      const featureType = tcode.charAt(0); // L, R, V, A, C (custom)
      const useActionBoundary = this._linearStrategy === 'action-boundary' &&
        (featureType === 'L' || featureType === 'A' || featureType === 'C');

      if (useActionBoundary) {
        this._dispatchAxisLinearAtBoundary(tcode, state, timeMs, devices);
        // Custom-routed axes may include non-linear devices (vibe/rotate/scalar).
        // For those, fall through to the interpolated path below.
        if (featureType !== 'C') continue;
      }

      if (now - state.lastSendTime < MIN_SEND_INTERVAL_MS) continue;

      // Catch up index
      while (state.index + 1 < state.actions.length &&
             state.actions[state.index + 1].at <= timeMs) {
        state.index++;
      }

      if (state.index < 0 || state.index + 1 >= state.actions.length) continue;

      const action = state.actions[state.index];
      const nextAction = state.actions[state.index + 1];
      const duration = Math.max(MIN_SEND_INTERVAL_MS, nextAction.at - timeMs);
      if (duration > MAX_GAP_MS) continue;

      // Linear interpolation for axis position
      const span = nextAction.at - action.at;
      const t = span > 0 ? (timeMs - action.at) / span : 0;
      const value = Math.max(0, Math.min(100, action.pos + t * (nextAction.pos - action.pos)));

      if (state.lastSentValue >= 0 && Math.abs(value - state.lastSentValue) < MIN_POS_DELTA) continue;

      // Route to devices assigned to this axis
      for (const dev of devices) {
        const assigned = this._axisAssignmentMap.get(dev.index);
        if (assigned !== tcode) continue;

        const inverted = this._invertedDevices.has(dev.index);
        const pos = inverted ? 100 - value : value;

        if (featureType === 'C') {
          // Custom route: send based on device capabilities. Linear was
          // handled above by _dispatchAxisLinearAtBoundary when action-
          // boundary mode is on; skip it here to avoid double-send.
          if (dev.canLinear && !useActionBoundary) this.buttplug.sendLinear(dev.index, pos, duration);
          else if (dev.canVibrate) this.buttplug.sendVibrate(dev.index, pos);
          else if (dev.canRotate) this.buttplug.sendRotate(dev.index, pos, pos >= 50);
          else if (dev.canScalar) this.buttplug.sendScalar(dev.index, this._applyScalarSafety(dev.index, pos));
        } else if (featureType === 'L' || featureType === 'A') {
          if (dev.canLinear) this.buttplug.sendLinear(dev.index, pos, duration);
          if (dev.canScalar) this.buttplug.sendScalar(dev.index, this._applyScalarSafety(dev.index, pos));
        } else if (featureType === 'R') {
          if (dev.canRotate) {
            const clockwise = pos < 50;
            const speed = pos < 50 ? ((50 - pos) / 50) * 100 : ((pos - 50) / 50) * 100;
            this.buttplug.sendRotate(dev.index, speed, clockwise);
          }
        } else if (featureType === 'V') {
          if (dev.canVibrate) this.buttplug.sendVibrate(dev.index, pos);
          if (dev.canScalar) this.buttplug.sendScalar(dev.index, this._applyScalarSafety(dev.index, pos));
        }
      }

      state.lastSendTime = now;
      state.lastSentValue = value;
    }
  }

  /**
   * Axis-level action-boundary dispatcher. Mirror of _dispatchLinearAtBoundary
   * for multi-axis scripts. Tracks per-axis "last dispatched index" so each
   * axis schedules independently.
   */
  _dispatchAxisLinearAtBoundary(tcode, state, timeMs, devices) {
    const lookahead = this._linearLookaheadMs || 0;

    while (state.index + 1 < state.actions.length &&
           state.actions[state.index + 1].at - lookahead <= timeMs) {
      state.index++;
    }

    if (state.index < 0) return;
    const nextIdx = state.index + 1;
    if (nextIdx >= state.actions.length) return;

    const lastSentIdx = this._axisLastLinearSentIdx.get(tcode) ?? -1;
    if (lastSentIdx >= nextIdx) return;

    const currentAction = state.actions[state.index];
    const nextAction = state.actions[nextIdx];
    const strokeDuration = nextAction.at - currentAction.at;

    if (strokeDuration > MAX_GAP_MS) {
      this._axisLastLinearSentIdx.set(tcode, nextIdx);
      return;
    }

    const duration = Math.max(this._minStrokeMs || 0, strokeDuration);

    for (const dev of devices) {
      const assigned = this._axisAssignmentMap.get(dev.index);
      if (assigned !== tcode) continue;
      if (!dev.canLinear) continue;
      const inverted = this._invertedDevices.has(dev.index);
      const pos = inverted ? 100 - nextAction.pos : nextAction.pos;
      this.buttplug.sendLinear(dev.index, pos, duration);
    }

    this._axisLastLinearSentIdx.set(tcode, nextIdx);
    // Deliberately do NOT mutate state.lastSentValue — the interpolated
    // fallback path (for non-linear devices on custom axes) uses it for
    // dirty-checking derived intensity commands.
  }

  // --- Per-device settings ---

  setInverted(deviceIndex, inverted) {
    if (inverted) this._invertedDevices.add(deviceIndex);
    else this._invertedDevices.delete(deviceIndex);
  }

  isInverted(deviceIndex) {
    return this._invertedDevices.has(deviceIndex);
  }

  setVibeMode(deviceIndex, mode) {
    this._vibeModeMap.set(deviceIndex, mode);
  }

  getVibeMode(deviceIndex) {
    return this._vibeModeMap.get(deviceIndex) || 'speed';
  }

  /**
   * Set actions for a specific TCode axis (multi-axis companion scripts).
   * @param {string} tcode — e.g. 'L1', 'R0', 'V0'
   * @param {Array<{at: number, pos: number}>|null} actions
   */
  setAxisActions(tcode, actions) {
    if (!actions || actions.length < 2) {
      this._axisActions.delete(tcode);
    } else {
      this._axisActions.set(tcode, {
        actions,
        index: -1,
        lastSendTime: 0,
        lastSentValue: -1,
      });
    }
  }

  /** Clear all axis actions (on video change). */
  clearAxisActions() {
    this._axisActions.clear();
  }

  /** Get loaded axis tcodes. */
  getLoadedAxes() {
    return [...this._axisActions.keys()];
  }

  /**
   * Assign a device to a specific axis.
   * @param {number} deviceIndex
   * @param {string|null} tcode — null means 'L0' (main stroke, default)
   */
  setAxisAssignment(deviceIndex, tcode) {
    if (!tcode) {
      this._axisAssignmentMap.delete(deviceIndex);
    } else {
      // Store all assignments including L0 (needed for custom routing to know which
      // devices are explicitly assigned vs unassigned)
      this._axisAssignmentMap.set(deviceIndex, tcode);
    }
  }

  getAxisAssignment(deviceIndex) {
    return this._axisAssignmentMap.get(deviceIndex) || 'L0';
  }

  setScalarMode(deviceIndex, mode) {
    this._scalarModeMap.set(deviceIndex, mode);
  }

  getScalarMode(deviceIndex) {
    return this._scalarModeMap.get(deviceIndex) || 'position';
  }

  setRotateMode(deviceIndex, mode) {
    this._rotateModeMap.set(deviceIndex, mode);
  }

  getRotateMode(deviceIndex) {
    return this._rotateModeMap.get(deviceIndex) || 'speed';
  }

  setMaxIntensity(deviceIndex, maxPercent) {
    this._maxIntensityMap.set(deviceIndex, Math.max(0, Math.min(100, maxPercent)));
  }

  getMaxIntensity(deviceIndex) {
    const v = this._maxIntensityMap.get(deviceIndex);
    return v !== undefined ? v : 70;
  }

  setRampUp(deviceIndex, enabled) {
    this._rampUpMap.set(deviceIndex, !!enabled);
  }

  getRampUp(deviceIndex) {
    const v = this._rampUpMap.get(deviceIndex);
    return v !== undefined ? v : true;
  }

  /**
   * Drop every per-device entry for `deviceIndex` from the in-memory maps.
   * Called from app.js's `onDeviceRemoved` wiring so that if Intiface
   * recycles the index (e.g. after a full disconnect + reconnect), a
   * freshly-enumerated device at that index won't inherit stale axis,
   * vibe/scalar/rotate mode, inverted flag, intensity cap, or ramp-up
   * setting from whatever used to live at that slot.
   *
   * Persistent settings keyed by device name in `buttplug.deviceSettings`
   * are unaffected — `_loadButtplugDeviceSettings` restores them per-name
   * on reconnect.
   */
  clearDeviceState(deviceIndex) {
    this._axisAssignmentMap.delete(deviceIndex);
    this._invertedDevices.delete(deviceIndex);
    this._vibeModeMap.delete(deviceIndex);
    this._scalarModeMap.delete(deviceIndex);
    this._rotateModeMap.delete(deviceIndex);
    this._maxIntensityMap.delete(deviceIndex);
    this._rampUpMap.delete(deviceIndex);
  }

  setInterpolationMode(mode) {
    this._interpolationMode = mode || 'linear';
    this._interpolator = getInterpolator(this._interpolationMode);
  }

  getInterpolationMode() {
    return this._interpolationMode;
  }

  setSpeedLimit(maxSpeed) {
    this._speedLimit = maxSpeed || 0;
  }

  getSpeedLimit() {
    return this._speedLimit;
  }

  /**
   * Set the linear command scheduling strategy.
   * @param {'action-boundary'|'interpolated'} strategy
   */
  setLinearStrategy(strategy) {
    this._linearStrategy = strategy === 'interpolated' ? 'interpolated' : 'action-boundary';
    this._lastLinearSentForIdx = -1;
    this._axisLastLinearSentIdx.clear();
  }

  getLinearStrategy() {
    return this._linearStrategy;
  }

  /**
   * BLE round-trip compensation. Command fires this many ms before the
   * action's wall-clock time so it arrives at the device on-time.
   */
  setLinearLookaheadMs(ms) {
    this._linearLookaheadMs = Math.max(0, Math.min(500, Number(ms) || 0));
  }

  getLinearLookaheadMs() {
    return this._linearLookaheadMs;
  }

  /**
   * Floor on stroke duration. Sub-threshold strokes are stretched up so
   * BLE has time to actually execute them.
   */
  setMinStrokeMs(ms) {
    this._minStrokeMs = Math.max(0, Math.min(500, Number(ms) || 0));
  }

  getMinStrokeMs() {
    return this._minStrokeMs;
  }

  /**
   * Set the per-device sync offset. NEGATIVE values fire commands earlier
   * (compensate for BLE latency / VR display lag). The scheduler reads
   * effective time = real time − offset, so a negative offset increases
   * the effective time, dispatching upcoming actions ahead of schedule.
   *
   * Range typically -1000 to +1000 ms. Live — takes effect immediately
   * without restarting the scheduler.
   */
  setOffsetMs(ms) {
    this._offsetMs = Math.max(-2000, Math.min(2000, Number(ms) || 0));
  }

  getOffsetMs() {
    return this._offsetMs;
  }

  /**
   * Effective video time in ms — real player time shifted by the
   * configured offset. Centralised so adding/changing the formula
   * affects every read site uniformly.
   */
  _currentTimeMs() {
    return this.player.currentTime * 1000 - this._offsetMs;
  }

  /**
   * Compute vibration intensity based on the selected mapping mode.
   * @param {'speed'|'position'|'intensity'} mode
   * @param {number} pos — current position 0–100
   * @param {number} prevPos — previous position 0–100
   * @param {number} durationMs — time between actions
   * @returns {number} intensity 0–100
   */
  _computeVibeIntensity(mode, pos, prevPos, durationMs) {
    switch (mode) {
      case 'position':
        return Math.max(0, Math.min(100, pos));

      case 'intensity': {
        const base = pos * 0.4;
        const posDelta = Math.abs(pos - prevPos);
        const speed = durationMs > 0 ? (posDelta / durationMs) * 1000 : 0;
        const speedComponent = Math.min(100, (speed / 300) * 100) * 0.6;
        return Math.min(100, base + speedComponent);
      }

      case 'speed':
      default: {
        const posDelta = Math.abs(pos - prevPos);
        const speed = durationMs > 0 ? (posDelta / durationMs) * 1000 : 0;
        return Math.min(100, (speed / 300) * 100);
      }
    }
  }

  // --- Internal ---

  _emitStatus(status) {
    if (this.onSyncStatus) this.onSyncStatus(status);
  }
}
