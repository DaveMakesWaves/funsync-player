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
import { clampVideoSyncOffset } from './video-sync-offset.js';
import {
  createNoise1D,
  fbm,
  noiseToPercent,
  patternValue,
  blendWithStroke,
  shapeGeneratedValue,
  axisPhase,
  normaliseMotionConfig,
} from './motion-source.js';
import { AXIS_DEFINITIONS } from './multi-axis.js';
import { jumpEaseMs, JUMP_MOVE_UNITS_PER_S } from './jump-ease.js';

/**
 * A parked axis's first move counts as a slam when it is quicker than this
 * many times the stroke's own speed (and the jump pace): see
 * `_parkedMoveTooFast`. 1.5 leaves room for the estimate's drift.
 */
const PARKED_SLAM_FACTOR = 1.5;
import { StallHold, isProxyStall } from './playback-stall.js';

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
// Position axes that go back to centre when a video that no longer drives
// them starts playing (FT-095, kissenpirat #389). Never L0 (the stroke is the
// clock and the new video's first keyframe places it) and never an intensity
// channel (V*, A*: stop() already zeroes those where a rest frame is sent).
const HOME_AXES = new Set(['L1', 'L2', 'R0', 'R1', 'R2']);
// How long that move takes. Slow on purpose: a bare or fast frame slams an
// OSR2+/SR6 across its travel (the 2026-08-01 "violent jump on pause" fix).
const HOME_MOVE_MS = 1000;
// The Go home button's move (#384 uhntiss, #389 kissenpirat): slower still,
// because it can take L0 and every rotation across half their travel at once.
export const GO_HOME_MOVE_MS = 2000;
// Channels that carry an INTENSITY, not a position (V0 vibe, V1 pump, A1
// suck, A2 lube; any other V*): they keep acting on the last value they were
// sent, so a stall turns them off (FN-02). A0, the valve, is a position.
const INTENSITY_AXES = new Set(
  AXIS_DEFINITIONS.filter((a) => a.type === 'vibrate').map((a) => a.tcode),
);
const isIntensityAxis = (tcode) => INTENSITY_AXES.has(tcode) || String(tcode).charAt(0) === 'V';

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

    // Generated motion for axes with no script of their own (dio_likes_jojo,
    // EroScripts #306). Off for every axis until the user opts in, per axis.
    // tcode -> normalised { mode: 'link'|'random', depth, half, speed }
    this._axisMotion = new Map();
    this._genState = new Map();   // tcode -> { lastSentValue }
    this._genCursor = -1;         // this generator's own index into the main script
    this._genBeatIndex = -1;      // last main keyframe we emitted a value on
    this._genClockSec = 0;        // noise clock - advances only while L0 drives
    this._genLastTimeMs = -1;     // media time at the previous generated tick
    // Fixed seed: a session that misbehaves should be reproducible from a bug
    // report, and the variation people actually feel comes from the script's
    // timing, not from a different noise field every launch.
    this._noise = createNoise1D();

    // Interpolation
    this._interpolationMode = 'linear';
    this._interpolator = linearInterpolate;
    this._speedLimit = 0;
    // axis -> performance.now() until which the move after a jump is still
    // under way: nothing new is sent to that axis before it lands (_jumpEase).
    this._easeUntil = new Map();

    // Track last sent values for delta optimization
    this._lastSentAxes = {};

    // Unused axes go home (FT-095, #389). Over serial stop() sends DSTOP,
    // which halts in place, so R0 / R1 / L1… stayed wherever a multi-axis
    // video left them through every later single-axis video.
    //   _drivenAxes     — HOME_AXES this run has moved (since the last start)
    //   _homeCandidates — those a new video takes back to centre
    //   _homeArmed      — a new video is starting; home on its first play
    this._drivenAxes = new Set();
    this._homeCandidates = new Set();
    this._homeArmed = false;
    // Axes the Go home button parked in the middle: each one's first move on
    // the next play goes to its keyframe at the keyframe's pace, never a
    // one-tick snap (goHome, _tick).
    this._fromHome = new Set();
    // The new video's companion axis files are still loading (E2-06): the
    // homing decision waits for them. Set by holdHomeUntil, one per load.
    this._homeHold = null;

    // Per-device sync offset in ms. NEGATIVE = fire commands earlier.
    // Same semantics as buttplug-sync._offsetMs — see that module's
    // setOffsetMs comment for the formula and rationale.
    this._offsetMs = 0;
    // The current video's own delta on top (`library.syncOffsets`, #380).
    this._videoOffsetMs = 0;

    // FN-02 (Dave 2026-11-16: "yes everything should shop while a video
    // buffers"). The picture can stop without a 'pause' (a starved source, a
    // seek while playing, an error, a frozen clock, a proxy's stall). The
    // position axes already stood on the frozen clock, but the intensity
    // channels and a generated intensity kept their last level. A stall now
    // turns those off and sends nothing until the picture moves; its end
    // re-arms WITHOUT the one-tick snap a seek or a pause needs, because no
    // position axis was stopped or centred (no DSTOP, no rest frame).
    // FN-05: only past a grace window (STALL_GRACE_MS); a hiccup inside it
    // turns nothing off, and its end re-arms in place like a hold's.
    this._stall = new StallHold({
      getPlayer: () => this.player,
      onHold: (reason) => this._holdForStall(reason),
      onRelease: () => this._rearmAfterHold(),
      tag: '[TCodeSync]',
    });

    // Callbacks
    this.onSyncStatus = null;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._stall.clear();   // a new player or video: no hold carried over (FN-02)
    // A new video (or the same one after a stop): axes the last one moved and
    // this one does not drive go home when it starts playing (FT-095).
    this._armHome();
    this._cacheActions();
    this._bindVideoEvents();

    if (!this.player.paused) {
      this._resetIndices();
      this._homeUnusedAxes();
      this._startScheduler();
    }
    console.log('[TCodeSync] Started');
  }

  stop() {
    this._active = false;
    this._awaitingResume = false;
    this._stall.clear();
    this._unbindVideoEvents();
    this._stopScheduler();
    this._stopDevice();
    this._resetState();
    console.log('[TCodeSync] Stopped');
  }

  reloadActions() {
    this._cacheActions();
    this._resetIndices();
  }

  /**
   * Whether a video is SENDING to the device right now. A loaded but PAUSED
   * video sends nothing (the pause stopped the scheduler), so the pattern
   * Test and the range previews may use the device then (device session
   * 2026-11-19, step 27). A stall mid-play still counts as driving. The Test
   * stops itself when play starts (filler-test-player.js).
   */
  isDriving() {
    return !!this._active && (!!this._intervalId || this.player?.paused === false);
  }

  /**
   * Push one L0 target from OUTSIDE the video clock (the filler test button).
   *
   * Applies the same per-axis invert/range/cutoff a scripted position gets,
   * for the same reason the Buttplug side does: a test that skipped them
   * would not be a test of what the user will actually feel.
   *
   * @param {number} position 0-100
   * @param {number} durationMs time to reach it
   * @returns {boolean} false when refused
   */
  sendPositionNow(position, durationMs) {
    return this.previewAxisPosition('L0', position, durationMs);
  }

  /**
   * Push one target on ANY axis from outside the video clock.
   *
   * Generalises `sendPositionNow` off L0 so the per-axis range sliders can
   * drive the axis they belong to. The whole point of that preview is to feel
   * where the boundary actually lands, so it runs the same invert → range →
   * cutoff stack a scripted position runs; sending 0 or 100 through it lands
   * the device exactly on the min or max the slider is currently showing.
   *
   * Refuses while a video is driving — playback owns the device then, and a
   * preview command racing the scheduler would fight it mid-stroke.
   *
   * @param {string} tcode axis id, e.g. 'L0', 'R1'
   * @param {number} position 0-100, PRE-transform
   * @param {number} durationMs time to reach it
   * @returns {boolean} false when refused
   */
  previewAxisPosition(tcode, position, durationMs) {
    if (this.isDriving()) return false;
    if (!this.tcode?.connected) return false;
    if (!tcode || !this.isAxisEnabled(tcode)) return false;

    let value = applyInvert(position, this.isAxisInverted(tcode));
    const range = this.getAxisRange(tcode);
    value = range.min + (value / 100) * (range.max - range.min);
    value = applyCutoff(value, this._axisCutoff.get(tcode));

    this.tcode.sendAxes({ [tcode]: value }, undefined, { [tcode]: this._clampMove(durationMs) });
    return true;
  }

  /**
   * Idle the device after an off-clock run. Through _stopDevice, so over UDP /
   * WebSocket the axes the rest frame centred move on from the middle at the
   * script's pace when the paused video plays again.
   */
  stopTestOutput() {
    if (this.isDriving()) return;
    try { this._stopDevice(); } catch { /* best-effort */ }
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

  /**
   * Configure generated motion for an axis that has no script.
   *
   * @param {string} tcode  axis (L0 is refused - the stroke axis is the clock,
   *                        generating it would leave nothing to follow)
   * @param {{mode: 'script'|'link'|'random'|'pattern', depth?: number,
   *          half?: 'off'|'top'|'bottom', speed?: number, pattern?: string}|null} cfg
   *        'script' or null clears it. A real script for the axis always wins
   *        over this - see _tickGeneratedAxes.
   */
  setAxisMotion(tcode, cfg) {
    if (tcode === 'L0') return;
    const norm = normaliseMotionConfig(cfg);
    if (!norm) {
      this._axisMotion.delete(tcode);
      this._genState.delete(tcode);
      return;
    }
    this._axisMotion.set(tcode, norm);
    if (!this._genState.has(tcode)) this._genState.set(tcode, { lastSentValue: -1 });
  }

  getAxisMotion(tcode) {
    return this._axisMotion.get(tcode) || null;
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

  /** The playing video's own delta (#380), on top of the global offset. */
  setVideoOffsetMs(ms) {
    this._videoOffsetMs = clampVideoSyncOffset(ms);
  }

  _currentTimeMs() {
    return this.player.currentTime * 1000 - this._offsetMs - this._videoOffsetMs;
  }

  // --- Internal ---

  _cacheActions() {
    this._actions = this.funscript.isLoaded ? this.funscript.getActions() : null;
    // Cache the main axis's natural range whenever actions reload —
    // variant switch, script clear, etc. all funnel through here.
    //
    // Deliberately the AUTHORED actions, not the played ones. `getActions()`
    // includes gap filler, and the range extender uses this to decide how
    // far to stretch the script — measuring filler would stretch the
    // author's content by a factor derived from content they did not write.
    // The `?? this._actions` fallback is for older injected fakes that
    // predate `getAuthoredActions`. In production `funscript` is always a
    // FunscriptEngine, which has it, so the fallback never fires — and when
    // it does, it reproduces the pre-filler behaviour rather than throwing.
    this._naturalRange = computeNaturalRange(
      this.funscript.isLoaded
        ? (this.funscript.getAuthoredActions?.() ?? this._actions)
        : null,
    );
  }

  /**
   * Stop the device. Over UDP / WebSocket the manager's rest frame glides the
   * position axes to the middle (TCodeManager.stop returns them; serial halts
   * in place and returns none). Each of those takes its first move after the
   * next play to the next keyframe at the keyframe's own pace, as after Go
   * home: the usual first send snaps over ONE tick, which from the middle is
   * half the travel at full speed (the 17 ms jump back after a pop-out,
   * FT-095 verify-3).
   */
  _stopDevice() {
    const centred = this.tcode.stop();
    if (Array.isArray(centred)) for (const axis of centred) this._fromHome.add(axis);
  }

  _resetState() {
    this._easeUntil.clear();
    this._lastActionIndex = -1;
    this._lastSentPos = -1;
    this._lastSendTime = 0;
    this._lastSentAxes = {};
    this._resetGeneratedAxes();
  }

  _resetIndices() {
    const timeMs = this._currentTimeMs();
    // A new jump: its own first move decides its own ease.
    this._easeUntil.clear();

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
    this._resetGeneratedAxes();
  }

  /**
   * Generated axes re-anchor on the next main keyframe after a seek. The noise
   * clock keeps running - its phase isn't tied to media time, and resetting it
   * would snap every generated axis back to the same starting value.
   */
  _resetGeneratedAxes() {
    this._genCursor = -1;
    this._genBeatIndex = -1;
    this._genLastTimeMs = -1;
    for (const [, state] of this._genState) state.lastSentValue = -1;
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
      // The end of a stall hold (FN-02), or of a hiccup inside its grace
      // window (FN-05), re-arms in place: nothing stopped the position axes,
      // so they carry on from the target they were sent (a seek during the
      // stall has already reset them, in _onSeeked).
      const heldFor = this._stall.clear('playing');
      if (!this._active) return;
      if (heldFor) this._rearmAfterHold();
      else this._resetIndices();
      // Only the first play of a new video; a no-op on every later one.
      this._homeUnusedAxes();
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
    this._onPause = () => {
      if (!this._active) return;
      // A proxy reports a STALL as a 'pause' (the player pop-out, the
      // headset): hold, as the inline 'waiting' does, rather than stop(),
      // whose rest frame centres every axis over UDP / WebSocket (FN-02).
      if (isProxyStall(this.player?.video)) { this._stall.enter('proxy'); return; }
      this._stall.clear('pause');
      this._stopScheduler(); this._stopDevice(); this._emitStatus('idle');
    };
    this._onSeeked = () => { if (!this._active) return; this._resetIndices(); };
    this._onEnded = () => { if (!this._active) return; this._stall.clear(); this._stopScheduler(); this._stopDevice(); this._emitStatus('idle'); };
    // FN-02: the picture stops without a 'pause'. Each holds (see _stall).
    this._onWaiting = () => { if (this._active) this._stall.enter('waiting'); };
    this._onStalled = () => { if (this._active) this._stall.enter('stalled'); };
    this._onSeeking = () => { if (this._active) this._stall.enter('seeking'); };
    this._onError = () => { if (this._active) this._stall.enter('error'); };
    // Source replaced (manual next/prev, or picking another video mid-play).
    // The media load algorithm sets paused = true WITHOUT firing `pause`, and
    // the video didn't end — so neither handler above runs and the axes would
    // hold their last commanded value. `emptied` is the load algorithm's own
    // signal that a loaded source was torn down. Leaves `_active` set so the
    // new video re-arms via `playing` / reloadActions.
    this._onEmptied = () => {
      if (!this._active) return;
      console.log('[TCodeSync] Video source changed — stopping axes, holding until the new video plays');
      this._stall.clear();   // the stop below owns every axis now
      this._awaitingResume = true;
      this._stopScheduler();
      this._stopDevice();
      this._resetIndices();
      // A new video in the same run: its first play homes what it leaves.
      this._armHome();
      this._emitStatus('idle');
    };
    v.addEventListener('playing', this._onPlaying);
    v.addEventListener('pause', this._onPause);
    v.addEventListener('seeked', this._onSeeked);
    v.addEventListener('ended', this._onEnded);
    v.addEventListener('emptied', this._onEmptied);
    v.addEventListener('waiting', this._onWaiting);
    v.addEventListener('stalled', this._onStalled);
    v.addEventListener('seeking', this._onSeeking);
    v.addEventListener('error', this._onError);
  }

  _unbindVideoEvents() {
    const v = this.player.video;
    if (this._onPlaying) v.removeEventListener('playing', this._onPlaying);
    if (this._onPause) v.removeEventListener('pause', this._onPause);
    if (this._onSeeked) v.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) v.removeEventListener('ended', this._onEnded);
    if (this._onEmptied) v.removeEventListener('emptied', this._onEmptied);
    if (this._onWaiting) v.removeEventListener('waiting', this._onWaiting);
    if (this._onStalled) v.removeEventListener('stalled', this._onStalled);
    if (this._onSeeking) v.removeEventListener('seeking', this._onSeeking);
    if (this._onError) v.removeEventListener('error', this._onError);
  }

  /**
   * The intensity channels this run drives (a script or generated motion)
   * and the user has not switched off: what a stall turns off.
   */
  _drivenIntensityAxes() {
    const axes = new Set();
    for (const tcode of [...this._axisActions.keys(), ...this._axisMotion.keys()]) {
      if (isIntensityAxis(tcode) && this.isAxisEnabled(tcode)) axes.add(tcode);
    }
    return [...axes];
  }

  /**
   * A stall hold began (FN-02): each driven intensity channel goes to 0, its
   * stopped state, in one frame with no interval (a motor or pump goes off
   * at once). No position axis is in it: the clock is frozen, so they stand
   * where their last move takes them, and no DSTOP or rest frame jerks them.
   */
  _holdForStall(reason) {
    const timeMs = Math.round((Number(this.player?.currentTime) || 0) * 1000);
    const axes = this._drivenIntensityAxes();
    console.log(`[TCodeSync] picture stopped (${reason}) at ${timeMs}ms — ` +
      (axes.length ? `${axes.join(' ')} off until it moves` : 'holding until it moves'));
    if (!axes.length || !this.tcode?.connected) return;
    const off = {};
    for (const axis of axes) off[axis] = 0;
    this.tcode.sendAxes(off);
  }

  /**
   * The picture moves again after a hold (FN-02): pick the cursors up at the
   * current time and keep each position axis's last target, so the next
   * keyframe is reached by a normal move, never by the one-tick snap a seek
   * needs (a seek during the hold reset them already, so it still snaps).
   * The intensity channels were turned off: their current level is sent
   * again, and so is the generated value for the current keyframe.
   */
  _rearmAfterHold() {
    const timeMs = this._currentTimeMs();
    if (this._actions && this._actions.length > 0) {
      this._lastActionIndex = this._binarySearch(this._actions, timeMs);
    }
    for (const [tcode, state] of this._axisActions) {
      state.index = this._binarySearch(state.actions, timeMs);
      if (isIntensityAxis(tcode)) state.lastSentValue = -1;
    }
    this._genBeatIndex = -1;
    for (const [tcode, state] of this._genState) {
      if (isIntensityAxis(tcode)) state.lastSentValue = -1;
    }
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
      // FN-02: the picture is not moving. Send nothing (see _holdForStall).
      if (this._stall.sample()) return;
      this._tick();
    }, this._tickIntervalMs);
  }

  _stopScheduler() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * An axis parked in the middle (a pause or stop over UDP / WebSocket, Go
   * home, the script player handing the devices back) takes its first move to
   * the next keyframe at the keyframe's own pace. When that keyframe is only
   * moments away and the device is far from it, that pace is a slam: a
   * hand-back 10 ms before a 20 → 80 stroke sent `L0799I10`, 30 units in
   * 10 ms where the stroke itself is 600 units a second (full manual test,
   * 2026-11-23). So when the move from where the device is would be quicker
   * than both the move after a jump and half again the stroke's own speed,
   * it is a jump (`_jumpEase`). A move at about the script's own speed keeps
   * the keyframe's pace, as do a short hop and a manager that cannot say
   * where the device is.
   * @param {string} axis
   * @param {number} from the stroke's start, device units (stacked)
   * @param {number} to the next keyframe, device units (stacked)
   * @param {number} span the stroke's length, ms
   * @param {number} remaining ms until the next keyframe
   * @param {number} now
   * @returns {boolean}
   */
  _parkedMoveTooFast(axis, from, to, span, remaining, now) {
    if (typeof this.tcode.estimatePosition !== 'function' || !(remaining > 0)) return false;
    const est = this.tcode.estimatePosition(axis, now);
    const pace = this._speedLimit > 0 ? Math.min(this._speedLimit, JUMP_MOVE_UNITS_PER_S) : JUMP_MOVE_UNITS_PER_S;
    if (jumpEaseMs(est, to, pace) <= 0) return false; // a short hop
    const start = typeof est === 'number' && Number.isFinite(est) ? est : to;
    const speed = (Math.abs(to - start) / remaining) * 1000;
    const own = span > 0 ? (Math.abs(to - from) / span) * 1000 : 0;
    return speed > Math.max(pace, own * PARKED_SLAM_FACTOR);
  }

  /**
   * The first move after a jump (a seek, a gap skip, a start, the end of Edge
   * Hold): from where the device is (the manager's estimate; the middle when
   * nothing has moved it since connecting) to `target`, at the jump pace, or
   * the Speed limit when that is slower. Returns the move's length in ms, 0
   * for a short hop that just snaps, and marks the axis as easing until then.
   * Eroto #423: the one-tick snap went "to the new position at max speed".
   */
  _jumpEase(axis, targetAt, now) {
    const here = targetAt(0);
    // A manager that cannot say where the device is keeps the one-tick move.
    if (here === null || typeof this.tcode.estimatePosition !== 'function') return { target: here, ease: 0 };
    const est = this.tcode.estimatePosition(axis, now);
    const pace = this._speedLimit > 0 ? Math.min(this._speedLimit, JUMP_MOVE_UNITS_PER_S) : JUMP_MOVE_UNITS_PER_S;
    let ease = jumpEaseMs(est, here, pace);
    if (ease <= 0) return { target: here, ease: 0 };
    // The script moves on while the device travels: aim where it will be
    // when the move lands, or the next keyframe's move snaps the rest of the
    // way (found in the tests: a mid-stroke seek landed at 55 and the next
    // send went 55 → 90 in 13 ms). Lengthen the move while that target is
    // further than the pace allows (two rounds settle it).
    let target = targetAt(ease) ?? here;
    for (let round = 0; round < 2; round++) {
      const need = jumpEaseMs(est, target, pace);
      if (need <= ease) break;
      ease = need;
      target = targetAt(ease) ?? target;
    }
    this._easeUntil.set(axis, now + ease);
    return { target, ease };
  }

  /** The video's playback rate (the script runs at it while a move lands). */
  _playbackRate() {
    const r = this.player?.video?.playbackRate ?? this.player?.playbackRate;
    return typeof r === 'number' && r > 0 && Number.isFinite(r) ? r : 1;
  }

  /**
   * L0's output stack for a raw script position: extender → invert →
   * speed-limit (only with `now`, against the last send) → range → cutoff.
   */
  _stackL0(raw, now) {
    let p = applyExtender(raw, this._naturalRange, this._rangeExtenderEnabled, RANGE_EXTENDER_THRESHOLD_PCT);
    p = applyInvert(p, this.isAxisInverted('L0'));
    // Optional damping (off by default) — a user-enabled velocity clamp,
    // parity with XTEngine's damping. Left off, fast motion is untouched.
    if (now !== null && this._speedLimit > 0 && this._lastSentPos >= 0) {
      p = applySpeedLimit(p, this._lastSentPos, now - this._lastSendTime, this._speedLimit);
    }
    const range = this.getAxisRange('L0');
    p = range.min + (p / 100) * (range.max - range.min);
    return applyCutoff(p, this._axisCutoff.get('L0'));
  }

  /** A companion axis's output stack: extender → invert → range → cutoff, as L0. */
  _stackAxis(tcode, state, raw) {
    let v = applyExtender(raw, state.naturalRange, this._rangeExtenderEnabled, RANGE_EXTENDER_THRESHOLD_PCT);
    v = applyInvert(v, this.isAxisInverted(tcode));
    const range = this.getAxisRange(tcode);
    v = range.min + (v / 100) * (range.max - range.min);
    return applyCutoff(v, this._axisCutoff.get(tcode));
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
          // Go home parked L0 in the middle: its first move is to the next
          // keyframe at the keyframe's own pace, never a one-tick snap; unless
          // that is a slam, then it is a jump (_parkedMoveTooFast).
          const fromHome = this._fromHome.delete('L0');
          const firstSend = this._lastSentPos < 0
            && (!fromHome || this._parkedMoveTooFast('L0', this._stackL0(this._actions[i].pos, null),
              this._stackL0(next.pos, null), next.at - this._actions[i].at, remaining, now));
          // The move after a jump is still under way: nothing new until it lands.
          const easing = !firstSend && (this._easeUntil.get('L0') || 0) > now;
          // Steady state: target = the next keyframe's real position (so peaks
          // and troughs reach the device intact). First send: go to the
          // current interpolated position, over one tick when it is close,
          // else at the jump pace (_jumpEase).
          let rawPos = firstSend ? this._interpolator(this._actions, timeMs) : next.pos;
          let moveMs = firstSend ? this._tickIntervalMs : remaining;

          if (rawPos !== null && !easing) {
            let targetPos;
            if (firstSend) {
              // After a jump: where the script is (or, for a far jump, where
              // it will be when the device lands), at the jump pace.
              const rate = this._playbackRate();
              const jump = this._jumpEase('L0', (ms) => {
                const raw = this._interpolator(this._actions, timeMs + ms * rate);
                return raw === null ? null : this._stackL0(raw, null);
              }, now);
              targetPos = jump.target;
              if (jump.ease > 0) moveMs = jump.ease;
            } else {
              targetPos = this._stackL0(rawPos, now);
            }

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

      // An axis Go home parked in the middle never snaps from there: its first
      // move is to the next keyframe at the keyframe's own pace (goHome),
      // unless that is a slam (_parkedMoveTooFast).
      const fromHome = this._fromHome.delete(tcode);
      const firstSend = state.lastSentValue < 0
        && (!fromHome || this._parkedMoveTooFast(tcode, this._stackAxis(tcode, state, cur.pos),
          this._stackAxis(tcode, state, next.pos), next.at - cur.at, remaining, now));
      // The move after a jump is still under way: nothing new until it lands.
      if (!firstSend && (this._easeUntil.get(tcode) || 0) > now) continue;
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

      let value = this._stackAxis(tcode, state, rawVal);
      if (firstSend) {
        // After a jump, as L0: where the script will be when it lands.
        const rate = this._playbackRate();
        const jump = this._jumpEase(tcode, (ms) => {
          const raw = linearInterpolate(state.actions, timeMs + ms * rate);
          return raw === null ? null : this._stackAxis(tcode, state, Math.max(0, Math.min(100, raw)));
        }, now);
        value = jump.target;
        if (jump.ease > 0) moveMs = jump.ease;
      }

      if (state.lastSentValue < 0 || Math.abs(value - state.lastSentValue) >= MIN_POS_DELTA) {
        axisValues[tcode] = value;
        axisIntervals[tcode] = this._clampMove(moveMs);
        state.lastSentValue = value;
      }
    }

    // Generated axes - twist/roll/pitch with no script of their own.
    if (this._axisMotion.size > 0) {
      this._tickGeneratedAxes(timeMs, axisValues, axisIntervals);
    }

    if (Object.keys(axisValues).length > 0) {
      this.tcode.sendAxes(axisValues, undefined, axisIntervals);
      this._lastSendTime = now;
      for (const axis of Object.keys(axisValues)) {
        if (HOME_AXES.has(axis)) this._drivenAxes.add(axis);
      }
    }
  }

  /**
   * Take the homing decision only once `ready` settles (E2-06). The app
   * calls this as a video with companion axis files starts loading, with a
   * promise that settles when they have all loaded or failed: an axis one of
   * them drives must not be eased to centre first. The files load one after
   * another and are not awaited before playback starts, so with autoplay
   * and a slow drive the first play used to send `R0500I1000 R1500I1000` for
   * axes Companion Clip drives and hold them at centre for 6-9 s (verify-3).
   *
   * A play while held decides nothing; when `ready` settles, a video still
   * playing is homed then, from the axes it has scripts for by then (a file
   * that failed counts as undriven). `null` drops any hold, as a video with
   * no companions does. A newer call replaces an older one, so a superseded
   * load settling late holds nothing.
   *
   * @param {Promise|null} ready
   */
  holdHomeUntil(ready) {
    if (!ready) {
      const wasHeld = !!this._homeHold;
      this._homeHold = null;
      if (wasHeld) this._homeIfPlaying();
      return;
    }
    const hold = {};
    this._homeHold = hold;
    Promise.resolve(ready).then(() => {}, () => {}).then(() => {
      if (this._homeHold !== hold) return;
      this._homeHold = null;
      this._homeIfPlaying();
    });
  }

  /** Home now if this engine drives a video that is playing; otherwise the
   *  next play does (the decision stays armed). */
  _homeIfPlaying() {
    if (this._active && this.player && !this.player.paused) this._homeUnusedAxes();
  }

  /** A new video is starting: what the last one moved may need to go home. */
  _armHome() {
    for (const axis of this._drivenAxes) this._homeCandidates.add(axis);
    this._drivenAxes.clear();
    this._homeArmed = true;
  }

  /**
   * The new video's first play (FT-095, #389): each position axis the last
   * video moved that this one has no script or generated motion for, and is
   * enabled, eases back to centre over HOME_MOVE_MS. Never a bare frame,
   * never L0 or an axis no video moved, never while paused (this runs only
   * from a play), never mid-video (once per start). "Centre" goes through
   * the axis's own stack, as a scripted 50 would: the middle of the travel
   * its range allows, inside its cutoff. Stop is unchanged: UDP / WebSocket
   * stop() already centres every axis, serial DSTOP holds in place.
   */
  _homeUnusedAxes() {
    if (!this._homeArmed) return;
    // Its companion axes are still loading: decide when they have (E2-06).
    if (this._homeHold) return;
    this._homeArmed = false;
    // No link: keep them for the next start (a reconnect stops and starts).
    if (!this.tcode?.connected) return;
    const candidates = [...this._homeCandidates];
    this._homeCandidates.clear();
    const values = {};
    const intervals = {};
    for (const axis of candidates) {
      if (!this.isAxisEnabled(axis)) continue;
      if (this._axisActions.has(axis) || this._axisMotion.has(axis)) continue;
      let value = applyInvert(50, this.isAxisInverted(axis));
      const range = this.getAxisRange(axis);
      value = range.min + (value / 100) * (range.max - range.min);
      value = applyCutoff(value, this._axisCutoff.get(axis));
      values[axis] = value;
      intervals[axis] = HOME_MOVE_MS;
    }
    if (Object.keys(values).length === 0) return;
    console.log(`[TCodeSync] Homing axes this video does not drive: ${Object.keys(values).join(' ')}`);
    this.tcode.sendAxes(values, undefined, intervals);
  }

  /**
   * Go home (Devices > T-Code, #384 uhntiss, #389 kissenpirat; Dave
   * 2026-11-20: "can we impliment the t code return home stuff at least").
   * Every enabled position axis (L0, L1, L2, R0, R1, R2, A0) eases to the
   * middle of the user's own range over `moveMs`, through invert, range and
   * cutoff like any other value (so it never leaves the limits); every
   * intensity channel (V0, V1, A1, A2) goes to 0 at once. One frame, timed
   * per axis (`L0500I2000 ... V0000`): a bare or fast frame slams an
   * OSR2+/SR6 across its travel (the 2026-08-01 "violent jump on pause").
   * The caller pauses the video first (app.js `_tcodeGoHome`): while it
   * plays, the next keyframe would take the axes straight back.
   *
   * @param {{moveMs?: number}} [opts]
   * @returns {{sent: boolean, reason?: string, positions?: string[], intensities?: string[]}}
   */
  goHome({ moveMs = GO_HOME_MOVE_MS } = {}) {
    if (!this.tcode?.connected) return { sent: false, reason: 'not-connected' };
    const values = {};
    const intervals = {};
    const positions = [];
    const intensities = [];
    const axes = ['L0', ...AXIS_DEFINITIONS.map((a) => a.tcode)];
    for (const axis of axes) {
      if (!this.isAxisEnabled(axis)) continue;
      if (INTENSITY_AXES.has(axis)) {
        values[axis] = 0;
        intervals[axis] = 0;   // off at once, no ramp
        intensities.push(axis);
        continue;
      }
      let value = applyInvert(50, this.isAxisInverted(axis));
      const range = this.getAxisRange(axis);
      value = range.min + (value / 100) * (range.max - range.min);
      value = applyCutoff(value, this._axisCutoff.get(axis));
      values[axis] = value;
      intervals[axis] = moveMs;
      positions.push(axis);
    }
    if (positions.length === 0 && intensities.length === 0) return { sent: false, reason: 'no-axes' };
    this.tcode.sendAxes(values, undefined, intervals);
    // The next play must not slam them back. Every play / seek resets what
    // the engine remembers as sent, and its first send then snaps to the
    // current position over ONE tick: harmless from where the video paused,
    // half the travel at full speed from the middle. So each axis parked
    // here takes its first move to the next keyframe at the keyframe's own
    // pace instead (_tick; used once per axis).
    this._fromHome = new Set(positions);
    this._homeCandidates.clear();   // FT-095: nothing left to home on the next video
    console.log(`[TCodeSync] Go home: ${positions.join(' ') || '(no position axis)'} to the middle over ${moveMs} ms${intensities.length ? `; ${intensities.join(' ')} off` : ''}`);
    return { sent: true, positions, intensities };
  }

  /**
   * The main script's current keyframe, used as the clock for generated axes.
   *
   * Deliberately its own cursor rather than reusing _lastActionIndex: that one
   * only advances inside the L0 block, which is skipped when the user disables
   * L0 output. Someone running twist-only off a stroke script is exactly the
   * case this feature exists for, so the clock can't depend on L0 being sent.
   *
   * @returns {{index: number, pos: number, moveMs: number}|null} null when
   *          there's no script, we're past the end, or the next keyframe is
   *          further out than MAX_GAP_MS (an idle gap - generated axes hold
   *          position rather than crawling toward a distant target).
   */
  _mainBeat(timeMs) {
    const actions = this._actions;
    if (!actions || actions.length < 2) return null;

    // Re-anchor on a backward seek; otherwise walk forward.
    if (this._genCursor < 0 || this._genCursor >= actions.length ||
        actions[this._genCursor].at > timeMs) {
      this._genCursor = this._binarySearch(actions, timeMs);
    }
    while (this._genCursor + 1 < actions.length &&
           actions[this._genCursor + 1].at <= timeMs) {
      this._genCursor++;
    }

    const i = this._genCursor;
    if (i < 0 || i + 1 >= actions.length) return null;
    const remaining = actions[i + 1].at - timeMs;
    if (remaining <= 0 || remaining > MAX_GAP_MS) return null;
    return { index: i, pos: actions[i + 1].pos, moveMs: remaining };
  }

  /**
   * Emit one value per generated axis, once per MAIN keyframe.
   *
   * Rate matters here: sampling a noise function every tick would put 60
   * moves/sec/axis on a 115200 serial link and drown the scripted axes. One
   * value per main keyframe, travelling over that keyframe's own interval, is
   * both cheap and the reason generated motion tracks the action instead of
   * running to its own beat - the same trick XTPlayer uses.
   */
  _tickGeneratedAxes(timeMs, axisValues, axisIntervals) {
    // The noise clock runs on MEDIA time, not wall time. Playback speed then
    // scales generated motion the same way it scales the script, a seek lands
    // somewhere new in the noise field instead of continuing from where the
    // wall clock happened to be, and a paused tab can't accumulate drift.
    // Clamped so a long seek re-anchors rather than fast-forwarding the field.
    const dtMs = this._genLastTimeMs < 0
      ? this._tickIntervalMs
      : Math.min(Math.abs(timeMs - this._genLastTimeMs), 1000);
    this._genLastTimeMs = timeMs;

    const beat = this._mainBeat(timeMs);
    if (!beat) {
      // No clock (gap, end of script, or no script at all) - hold position and
      // re-anchor when the script picks back up.
      this._genBeatIndex = -1;
      return;
    }

    // Noise advances only while the main axis has somewhere to go. MFP gates on
    // the stroke axis being dirty for the same reason: motion that keeps
    // wandering through a paused or empty stretch reads as a fault.
    this._genClockSec += dtMs / 1000;

    if (beat.index === this._genBeatIndex) return;   // same keyframe, nothing new to say
    this._genBeatIndex = beat.index;

    for (const [tcode, cfg] of this._axisMotion) {
      if (!this.isAxisEnabled(tcode)) continue;
      // A real script for this axis always wins - generated motion fills in
      // for a missing track, it never overrides what a scripter wrote.
      if (this._axisActions.has(tcode)) continue;

      const state = this._genState.get(tcode) || { lastSentValue: -1 };
      let raw;
      if (cfg.mode === 'link') {
        raw = shapeGeneratedValue(beat.pos, cfg);
      } else if (cfg.mode === 'pattern') {
        // No per-axis phase offset here, unlike random: two axes on the same
        // pattern moving together is a coherent shape, and a user who wants
        // them apart has the half and depth controls to say so.
        raw = shapeGeneratedValue(patternValue(cfg.pattern, this._genClockSec * cfg.speed), cfg);
      } else {
        const t = this._genClockSec * cfg.speed + axisPhase(tcode);
        raw = shapeGeneratedValue(noiseToPercent(fbm(this._noise, t)), cfg);
      }

      // Blend toward the stroke if asked (MFP's MotionProviderBlend). Uses
      // the same beat position the link mode traces, so at blend=100 a random
      // axis lands exactly where "follow stroke" would.
      if (cfg.blend > 0 && cfg.mode !== 'link') {
        raw = blendWithStroke(raw, shapeGeneratedValue(beat.pos, cfg), cfg.blend);
      }

      // Same output stack as a scripted axis (minus the extender, which
      // stretches a narrow SCRIPT - a generated value is already full-scale),
      // so Safety Cap and Ceiling apply to generated motion too.
      let value = applyInvert(raw, this.isAxisInverted(tcode));
      const range = this.getAxisRange(tcode);
      value = range.min + (value / 100) * (range.max - range.min);
      value = applyCutoff(value, this._axisCutoff.get(tcode));

      if (state.lastSentValue < 0 || Math.abs(value - state.lastSentValue) >= MIN_POS_DELTA) {
        axisValues[tcode] = value;
        axisIntervals[tcode] = this._clampMove(beat.moveMs);
        state.lastSentValue = value;
      }
      this._genState.set(tcode, state);
    }
  }

  _emitStatus(status) {
    if (this.onSyncStatus) this.onSyncStatus(status);
  }
}
