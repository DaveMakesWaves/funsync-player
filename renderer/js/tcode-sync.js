// TCodeSync — Funscript-to-TCode sync engine for OSR2/SR6 devices
// Sends TCode commands over serial via TCodeManager.
// Same architecture as ButtplugSync but outputs multi-axis TCode strings.

import { getInterpolator, applySpeedLimit, linearInterpolate } from './interpolation.js';
import {
  applyInvert,
  applyCutoff,
  applyExtender,
  computeNaturalRange,
  RANGE_EXTENDER_THRESHOLD_PCT,
} from './device-transform-stack.js';

// Poll/detect rate. This is NOT the number of moves sent — moves are emitted
// per funscript keyframe (see _tick). It's how often we sample the clock to
// catch the next keyframe crossing, so it caps the fastest motion we can
// represent (60Hz → keyframes as close as ~17ms, i.e. vibration up to ~30Hz).
// Default 60Hz: fast "vibration" script sections (high-speed, low-distance
// moves) were flattened at the old 25Hz because the tick aliased them below
// Nyquist. Higher = catches faster keyframes; cheap at 115200 baud.
const TICK_INTERVAL_MS = Math.round(1000 / 60);  // ~60Hz default
const MIN_UPDATE_HZ = 15;        // clamp floor for the tunable rate
const MAX_UPDATE_HZ = 60;        // clamp ceiling (well within 115200 baud)
// Treat a next-keyframe further away than this as an idle gap — don't drive
// the device toward it (it'd crawl for seconds). Playback resumes driving
// when keyframes get dense again.
const MAX_GAP_MS = 5000;
// Suppress re-sending a target that hasn't moved (serial economy). Also the
// per-keyframe send gate: one send per keyframe, when the target changes.
const MIN_POS_DELTA = 0.5;
// Floor for a per-move interval (I-suffix). Keeps a fast keyframe from being
// told to move in ~0ms (jitter / divide issues) without slowing it materially.
const MIN_MOVE_MS = 10;

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
    // Poll/detect interval (ms). User-tunable via setUpdateRate — higher rates
    // catch faster keyframe crossings (fast vibration sections survive). Moves
    // are emitted per keyframe in _tick, so this is a sampling ceiling, not the
    // send cadence. Also the first-send snap interval after start/seek.
    this._tickIntervalMs = TICK_INTERVAL_MS;

    // Main axis (L0) tracking
    this._actions = null;
    this._lastActionIndex = -1;
    this._lastSendTime = 0;
    this._lastSentPos = -1;

    // Multi-axis: tcode → { actions, index, lastSentValue }
    this._axisActions = new Map();

    // Per-axis enable/disable, range, and direction-invert. Each map is
    // keyed independently by TCode axis (L0/L1/L2/R0/R1/R2/V0/V1/V2/A0)
    // so the three settings can be toggled without touching each other.
    this._axisEnabled = new Map();   // tcode → boolean
    this._axisRanges = new Map();    // tcode → { min, max }  (remap)
    this._axisCutoff = new Map();    // tcode → { min, max }  (hard clamp, after remap)
    this._axisInverted = new Map();  // tcode → boolean

    // Range Extender state. When enabled, narrow scripts get stretched
    // to 0-100 before invert/range. Natural range cached per source so
    // ticks don't re-scan the action arrays.
    this._rangeExtenderEnabled = false;
    this._naturalRange = { min: 0, max: 100 };  // main script (L0)
    // Per-axis natural ranges live on the axis state inside _axisActions.

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
    this._awaitingResume = false;
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
      this._axisActions.set(tcode, {
        actions,
        index: -1,
        lastSentValue: -1,
        // Per-axis natural range cached at set-time. Each axis stretches
        // independently so a 0-100 main alongside a 40-60 twist leaves
        // main untouched and stretches twist.
        naturalRange: computeNaturalRange(actions),
      });
    }
  }

  /**
   * Toggle Range Extender. Stretches narrow scripts (natural width <
   * threshold) to 0-100 before invert/range apply. See
   * device-transform-stack.js §2 for composition order.
   */
  setRangeExtenderEnabled(enabled) {
    this._rangeExtenderEnabled = !!enabled;
  }

  isRangeExtenderEnabled() {
    return this._rangeExtenderEnabled;
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

  /**
   * Per-axis output cutoff — a hard floor/ceiling clamp applied AFTER the
   * range remap. Pins out-of-band values to the boundary (vs setAxisRange
   * which rescales). Default {0, 100} = no-op. See applyCutoff.
   */
  setAxisCutoff(tcode, min, max) {
    this._axisCutoff.set(tcode, { min, max });
  }

  getAxisCutoff(tcode) {
    return this._axisCutoff.get(tcode) || { min: 0, max: 100 };
  }

  /**
   * Per-axis direction flip. Applied BEFORE range remap so "invert AND
   * limit to 30-70" reads as expected: input pos 100 → invert to 0 →
   * range to 30 (device min). Default false; missing entries treated as
   * not inverted.
   */
  setAxisInverted(tcode, inverted) {
    this._axisInverted.set(tcode, !!inverted);
  }

  isAxisInverted(tcode) {
    return !!this._axisInverted.get(tcode);
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
    // Cache the main axis's natural range whenever actions reload —
    // variant switch, script clear, etc. all funnel through here.
    this._naturalRange = computeNaturalRange(this._actions);
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
    this._onPlaying = () => {
      if (!this._active) return;
      this._resetIndices();
      this._startScheduler();
      this._emitStatus('synced');
      // Closes the pair logged by _onEmptied. A "source changed" line with no
      // matching "RE-ARMED" is the signature of axes going dead after a video
      // change — the failure this hook could plausibly introduce.
      if (this._awaitingResume) {
        this._awaitingResume = false;
        console.log('[TCodeSync] RE-ARMED after source change');
      }
    };
    this._onPause = () => { if (!this._active) return; this._stopScheduler(); this.tcode.stop(); this._emitStatus('idle'); };
    this._onSeeked = () => { if (!this._active) return; this._resetIndices(); };
    this._onEnded = () => { if (!this._active) return; this._stopScheduler(); this.tcode.stop(); this._emitStatus('idle'); };
    // Source replaced (manual next/prev, or picking another video mid-play).
    // The media load algorithm sets paused = true WITHOUT firing `pause`, and
    // the video didn't end — so neither handler above runs and the axes would
    // hold their last commanded value. `emptied` is the load algorithm's own
    // signal that a loaded source was torn down. Leaves `_active` set so the
    // new video re-arms via `playing` / reloadActions.
    this._onEmptied = () => {
      if (!this._active) return;
      console.log('[TCodeSync] Video source changed — stopping axes, holding until the new video plays');
      this._awaitingResume = true;
      this._stopScheduler();
      this.tcode.stop();
      this._resetIndices();
      this._emitStatus('idle');
    };
    v.addEventListener('playing', this._onPlaying);
    v.addEventListener('pause', this._onPause);
    v.addEventListener('seeked', this._onSeeked);
    v.addEventListener('ended', this._onEnded);
    v.addEventListener('emptied', this._onEmptied);
  }

  _unbindVideoEvents() {
    const v = this.player.video;
    if (this._onPlaying) v.removeEventListener('playing', this._onPlaying);
    if (this._onPause) v.removeEventListener('pause', this._onPause);
    if (this._onSeeked) v.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) v.removeEventListener('ended', this._onEnded);
    if (this._onEmptied) v.removeEventListener('emptied', this._onEmptied);
  }

  // --- Scheduler ---

  /**
   * Set the T-Code poll/detect rate in Hz (default 60). Higher rates catch
   * faster keyframe crossings, so fast "vibration" script sections survive
   * (60Hz represents motion up to ~30Hz). Moves are still emitted per keyframe,
   * so serial cost stays low. Clamped to 15–60 Hz. Restarts the scheduler live
   * if currently syncing.
   */
  setUpdateRate(hz) {
    const clamped = Math.max(MIN_UPDATE_HZ, Math.min(MAX_UPDATE_HZ, Number(hz) || 60));
    this._tickIntervalMs = Math.round(1000 / clamped);
    if (this._intervalId) {
      this._stopScheduler();
      this._startScheduler();
    }
  }

  _startScheduler() {
    if (this._intervalId) return;
    this._intervalId = setInterval(() => {
      if (!this._active || this.player.paused) return;
      this._tick();
    }, this._tickIntervalMs);
  }

  _stopScheduler() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /** Clamp a per-move interval to the valid [MIN_MOVE_MS, MAX_GAP_MS] window. */
  _clampMove(ms) {
    return Math.round(Math.max(MIN_MOVE_MS, Math.min(MAX_GAP_MS, ms)));
  }

  /**
   * Main tick — KEYFRAME-DRIVEN output (matches XTEngine's model, the fix for
   * flattened "vibration" sections on OSR2/SR6).
   *
   * Instead of resampling the interpolated position at a fixed rate — which
   * aliased fast, low-distance script motion below Nyquist and rounded off the
   * peaks — each axis aims at its NEXT keyframe's actual position over the exact
   * time to reach it (`L0<pos>I<time-to-next>`), letting the device firmware
   * interpolate. One send per keyframe (gated by MIN_POS_DELTA), so fast peaks
   * survive. The scheduler still polls at _tickIntervalMs; that only bounds how
   * finely we can catch keyframe crossings, not how the move is shaped.
   *
   * On the first send after start/seek (_lastSentPos < 0) we instead snap to the
   * current interpolated position over one tick, so the device lands correctly
   * before keyframe-driven motion resumes (avoids crawling toward a far keyframe
   * from a stale post-seek position).
   */
  _tick() {
    if (!this.tcode.connected) return;

    const now = performance.now();
    const timeMs = this._currentTimeMs();
    const axisValues = {};
    const axisIntervals = {}; // per-axis I-suffix (time to that axis's next keyframe)

    // Main axis (L0)
    if (this._actions && this._actions.length >= 2 && this.isAxisEnabled('L0')) {
      // Catch up to the interval containing timeMs.
      while (this._lastActionIndex + 1 < this._actions.length &&
             this._actions[this._lastActionIndex + 1].at <= timeMs) {
        this._lastActionIndex++;
      }

      const i = this._lastActionIndex;
      if (i >= 0 && i + 1 < this._actions.length) {
        const next = this._actions[i + 1];
        const remaining = next.at - timeMs; // time to reach the next keyframe

        if (remaining > 0 && remaining <= MAX_GAP_MS) {
          const firstSend = this._lastSentPos < 0;
          // Steady state: target = the next keyframe's real position (so peaks
          // and troughs reach the device intact). First send: snap to the
          // current interpolated position over one tick.
          let rawPos = firstSend ? this._interpolator(this._actions, timeMs) : next.pos;
          const moveMs = firstSend ? this._tickIntervalMs : remaining;

          if (rawPos !== null) {
            // Stack order: extender → invert → speed-limit → range → cutoff.
            let targetPos = applyExtender(
              rawPos, this._naturalRange,
              this._rangeExtenderEnabled, RANGE_EXTENDER_THRESHOLD_PCT,
            );
            targetPos = applyInvert(targetPos, this.isAxisInverted('L0'));

            // Optional damping (off by default) — a user-enabled velocity clamp,
            // parity with XTEngine's damping. Left off, fast motion is untouched.
            if (this._speedLimit > 0 && this._lastSentPos >= 0) {
              const deltaMs = now - this._lastSendTime;
              targetPos = applySpeedLimit(targetPos, this._lastSentPos, deltaMs, this._speedLimit);
            }

            const range = this.getAxisRange('L0');
            targetPos = range.min + (targetPos / 100) * (range.max - range.min);
            targetPos = applyCutoff(targetPos, this._axisCutoff.get('L0'));

            if (this._lastSentPos < 0 || Math.abs(targetPos - this._lastSentPos) >= MIN_POS_DELTA) {
              axisValues.L0 = targetPos;
              axisIntervals.L0 = this._clampMove(moveMs);
              this._lastSentPos = targetPos;
            }
          }
        }
      }
    }

    // Companion axes — same keyframe-driven model, each with its own interval.
    for (const [tcode, state] of this._axisActions) {
      if (!this.isAxisEnabled(tcode)) continue;
      if (!state.actions || state.actions.length < 2) continue;

      while (state.index + 1 < state.actions.length &&
             state.actions[state.index + 1].at <= timeMs) {
        state.index++;
      }

      if (state.index < 0 || state.index + 1 >= state.actions.length) continue;

      const cur = state.actions[state.index];
      const next = state.actions[state.index + 1];
      const remaining = next.at - timeMs;
      if (remaining <= 0 || remaining > MAX_GAP_MS) continue;

      const firstSend = state.lastSentValue < 0;
      let rawVal, moveMs;
      if (firstSend) {
        // Snap to the current interpolated position over one tick.
        const span = next.at - cur.at;
        const t = span > 0 ? (timeMs - cur.at) / span : 0;
        rawVal = Math.max(0, Math.min(100, cur.pos + t * (next.pos - cur.pos)));
        moveMs = this._tickIntervalMs;
      } else {
        rawVal = next.pos;
        moveMs = remaining;
      }

      // Extender → invert → range → cutoff, matching L0's stack order.
      let value = applyExtender(
        rawVal, state.naturalRange,
        this._rangeExtenderEnabled, RANGE_EXTENDER_THRESHOLD_PCT,
      );
      value = applyInvert(value, this.isAxisInverted(tcode));
      const range = this.getAxisRange(tcode);
      value = range.min + (value / 100) * (range.max - range.min);
      value = applyCutoff(value, this._axisCutoff.get(tcode));

      if (state.lastSentValue < 0 || Math.abs(value - state.lastSentValue) >= MIN_POS_DELTA) {
        axisValues[tcode] = value;
        axisIntervals[tcode] = this._clampMove(moveMs);
        state.lastSentValue = value;
      }
    }

    if (Object.keys(axisValues).length > 0) {
      this.tcode.sendAxes(axisValues, undefined, axisIntervals);
      this._lastSendTime = now;
    }
  }

  _emitStatus(status) {
    if (this.onSyncStatus) this.onSyncStatus(status);
  }
}
