// TCodeSync — Funscript-to-TCode sync engine for OSR2/SR6 devices
// Sends TCode commands over serial via TCodeManager.
// Same architecture as ButtplugSync but outputs multi-axis TCode strings.

import { getInterpolator, applySpeedLimit, linearInterpolate } from './interpolation.js';

const TICK_INTERVAL_MS = 40;     // ~25Hz
const MIN_SEND_INTERVAL_MS = 50;
const MAX_GAP_MS = 5000;
const MIN_POS_DELTA = 0.5;

export class TCodeSync {
  /**
   * @param {object} opts
   * @param {import('./video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('./tcode-manager.js').TCodeManager} opts.tcodeManager
   * @param {import('./funscript-engine.js').FunscriptEngine} opts.funscriptEngine
   */
  constructor({ videoPlayer, tcodeManager, funscriptEngine }) {
    this.player = videoPlayer;
    this.tcode = tcodeManager;
    this.funscript = funscriptEngine;

    this._active = false;
    this._intervalId = null;

    // Main axis (L0) tracking
    this._actions = null;
    this._lastActionIndex = -1;
    this._lastSendTime = 0;
    this._lastSentPos = -1;

    // Multi-axis: tcode → { actions, index, lastSentValue }
    this._axisActions = new Map();

    // Per-axis enable/disable and range
    this._axisEnabled = new Map();   // tcode → boolean
    this._axisRanges = new Map();    // tcode → { min, max }

    // Interpolation
    this._interpolationMode = 'linear';
    this._interpolator = linearInterpolate;
    this._speedLimit = 0;

    // Track last sent values for delta optimization
    this._lastSentAxes = {};

    // Per-device sync offset in ms. NEGATIVE = fire commands earlier.
    // Same semantics as buttplug-sync._offsetMs — see that module's
    // setOffsetMs comment for the formula and rationale.
    this._offsetMs = 0;

    // Callbacks
    this.onSyncStatus = null;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._cacheActions();
    this._bindVideoEvents();

    if (!this.player.paused) {
      this._resetIndices();
      this._startScheduler();
    }
    console.log('[TCodeSync] Started');
  }

  stop() {
    this._active = false;
    this._unbindVideoEvents();
    this._stopScheduler();
    this.tcode.stop();
    this._resetState();
    console.log('[TCodeSync] Stopped');
  }

  reloadActions() {
    this._cacheActions();
    this._resetIndices();
  }

  /** Set actions for a companion axis. */
  setAxisActions(tcode, actions) {
    if (!actions || actions.length < 2) {
      this._axisActions.delete(tcode);
    } else {
      this._axisActions.set(tcode, { actions, index: -1, lastSentValue: -1 });
    }
  }

  clearAxisActions() {
    this._axisActions.clear();
  }

  setAxisEnabled(tcode, enabled) {
    this._axisEnabled.set(tcode, enabled);
  }

  isAxisEnabled(tcode) {
    const v = this._axisEnabled.get(tcode);
    return v !== undefined ? v : true; // enabled by default
  }

  setAxisRange(tcode, min, max) {
    this._axisRanges.set(tcode, { min, max });
  }

  getAxisRange(tcode) {
    return this._axisRanges.get(tcode) || { min: 0, max: 100 };
  }

  setInterpolationMode(mode) {
    this._interpolationMode = mode || 'linear';
    this._interpolator = getInterpolator(this._interpolationMode);
  }

  setSpeedLimit(maxSpeed) {
    this._speedLimit = maxSpeed || 0;
  }

  /**
   * Per-device sync offset in ms. Negative = fire commands earlier.
   * Same model as buttplug-sync; centralised time computation in
   * _currentTimeMs so adding the offset doesn't require updating every
   * scheduler branch.
   */
  setOffsetMs(ms) {
    this._offsetMs = Math.max(-2000, Math.min(2000, Number(ms) || 0));
  }

  getOffsetMs() {
    return this._offsetMs;
  }

  _currentTimeMs() {
    return this.player.currentTime * 1000 - this._offsetMs;
  }

  // --- Internal ---

  _cacheActions() {
    this._actions = this.funscript.isLoaded ? this.funscript.getActions() : null;
  }

  _resetState() {
    this._lastActionIndex = -1;
    this._lastSentPos = -1;
    this._lastSendTime = 0;
    this._lastSentAxes = {};
  }

  _resetIndices() {
    const timeMs = this._currentTimeMs();

    // Main axis
    if (this._actions && this._actions.length > 0) {
      this._lastActionIndex = this._binarySearch(this._actions, timeMs);
    } else {
      this._lastActionIndex = -1;
    }
    this._lastSentPos = -1;
    this._lastSendTime = 0;

    // Companion axes
    for (const [, state] of this._axisActions) {
      state.index = this._binarySearch(state.actions, timeMs);
      state.lastSentValue = -1;
    }
    this._lastSentAxes = {};
  }

  _binarySearch(actions, timeMs) {
    let lo = 0, hi = actions.length - 1, result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (actions[mid].at <= timeMs) { result = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return result;
  }

  // --- Video events ---

  _bindVideoEvents() {
    const v = this.player.video;
    this._onPlaying = () => { if (!this._active) return; this._resetIndices(); this._startScheduler(); this._emitStatus('synced'); };
    this._onPause = () => { if (!this._active) return; this._stopScheduler(); this.tcode.stop(); this._emitStatus('idle'); };
    this._onSeeked = () => { if (!this._active) return; this._resetIndices(); };
    this._onEnded = () => { if (!this._active) return; this._stopScheduler(); this.tcode.stop(); this._emitStatus('idle'); };
    v.addEventListener('playing', this._onPlaying);
    v.addEventListener('pause', this._onPause);
    v.addEventListener('seeked', this._onSeeked);
    v.addEventListener('ended', this._onEnded);
  }

  _unbindVideoEvents() {
    const v = this.player.video;
    if (this._onPlaying) v.removeEventListener('playing', this._onPlaying);
    if (this._onPause) v.removeEventListener('pause', this._onPause);
    if (this._onSeeked) v.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) v.removeEventListener('ended', this._onEnded);
  }

  // --- Scheduler ---

  _startScheduler() {
    if (this._intervalId) return;
    this._intervalId = setInterval(() => {
      if (!this._active || this.player.paused) return;
      this._tick();
    }, TICK_INTERVAL_MS);
  }

  _stopScheduler() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Main tick — compute positions for all axes and send as a single TCode command.
   */
  _tick() {
    if (!this.tcode.connected) return;

    const now = performance.now();
    if (now - this._lastSendTime < MIN_SEND_INTERVAL_MS) return;

    const timeMs = this._currentTimeMs();
    const axisValues = {};
    let durationMs = MIN_SEND_INTERVAL_MS;

    // Main axis (L0)
    if (this._actions && this._actions.length >= 2 && this.isAxisEnabled('L0')) {
      // Catch up
      while (this._lastActionIndex + 1 < this._actions.length &&
             this._actions[this._lastActionIndex + 1].at <= timeMs) {
        this._lastActionIndex++;
      }

      if (this._lastActionIndex >= 0 && this._lastActionIndex + 1 < this._actions.length) {
        const nextAction = this._actions[this._lastActionIndex + 1];
        durationMs = Math.max(MIN_SEND_INTERVAL_MS, nextAction.at - timeMs);

        if (durationMs <= MAX_GAP_MS) {
          let targetPos = this._interpolator(this._actions, timeMs);
          if (targetPos !== null) {
            if (this._speedLimit > 0 && this._lastSentPos >= 0) {
              const deltaMs = now - this._lastSendTime;
              targetPos = applySpeedLimit(targetPos, this._lastSentPos, deltaMs, this._speedLimit);
            }

            const range = this.getAxisRange('L0');
            targetPos = range.min + (targetPos / 100) * (range.max - range.min);

            if (this._lastSentPos < 0 || Math.abs(targetPos - this._lastSentPos) >= MIN_POS_DELTA) {
              axisValues.L0 = targetPos;
              this._lastSentPos = targetPos;
            }
          }
        }
      }
    }

    // Companion axes
    for (const [tcode, state] of this._axisActions) {
      if (!this.isAxisEnabled(tcode)) continue;
      if (!state.actions || state.actions.length < 2) continue;

      // Catch up
      while (state.index + 1 < state.actions.length &&
             state.actions[state.index + 1].at <= timeMs) {
        state.index++;
      }

      if (state.index < 0 || state.index + 1 >= state.actions.length) continue;

      const action = state.actions[state.index];
      const nextAction = state.actions[state.index + 1];
      const axisDur = Math.max(MIN_SEND_INTERVAL_MS, nextAction.at - timeMs);
      if (axisDur > MAX_GAP_MS) continue;

      // Linear interpolation
      const span = nextAction.at - action.at;
      const t = span > 0 ? (timeMs - action.at) / span : 0;
      let value = Math.max(0, Math.min(100, action.pos + t * (nextAction.pos - action.pos)));

      // Apply range
      const range = this.getAxisRange(tcode);
      value = range.min + (value / 100) * (range.max - range.min);

      if (state.lastSentValue < 0 || Math.abs(value - state.lastSentValue) >= MIN_POS_DELTA) {
        axisValues[tcode] = value;
        state.lastSentValue = value;
      }
    }

    // Only send if there are changed values (no I suffix — let device interpolate at native rate)
    if (Object.keys(axisValues).length > 0) {
      this.tcode.sendAxes(axisValues);
      this._lastSendTime = now;
    }
  }

  _emitStatus(status) {
    if (this.onSyncStatus) this.onSyncStatus(status);
  }
}
