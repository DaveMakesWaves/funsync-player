// Handy HDSP-polled sync engine — used when the user changes the video
// playback rate (e.g. 1.5×). HSSP can't follow rate changes because its
// API only accepts a single `(timeMs, estServerTime)` pair and the cloud
// schedules the script at its native 1.0× thereafter. HDSP, in contrast,
// is per-tick: the client sends `(position, durationMs)` on every frame,
// so an outer scheduler that reads `video.currentTime` automatically
// scales with the playback rate (same property that makes Buttplug just
// work — see `buttplug-sync.js`).
//
// This module is deliberately small: pure interpolation against a sorted
// actions array, RAF-driven scheduler with a rate-limit, calls
// `handyManager.hdspMove(position, durationMs)`. No multi-axis, no
// custom routing — those paths stay on their respective syncs.
//
// Strategy: at each tick (~30 Hz), compute the linear-interpolated
// position at the current `video.currentTime`, then call
// `hdspMove(targetPos, lookaheadMs)` so the device moves toward the
// computed position over the lookahead window. The Handy firmware
// smooths over its onboard interpolator, so 30 Hz polling produces a
// usable feel — not as silky as HSSP at 1.0× but acceptable for the
// non-1.0× preview case which the user wouldn't pick HSSP for anyway.

import { applyCutoff } from './device-transform-stack.js';

const DEFAULT_TICK_INTERVAL_MS = 33; // ~30 Hz — Handy WiFi/BLE rate ceiling
const DEFAULT_LOOKAHEAD_MS = 100;    // movement budget per command
const MIN_POS_DELTA = 1;             // skip duplicate sends below this delta

/**
 * Pure linear interpolation against a sorted-by-`.at` actions array.
 * Returns position 0–100, or `null` if the time is outside the script's
 * range (caller decides what to do — typically: hold last position).
 *
 * @param {Array<{at: number, pos: number}>} actions
 * @param {number} timeMs
 * @returns {number | null}
 */
export function interpolatePosition(actions, timeMs) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  if (timeMs <= actions[0].at) return actions[0].pos;
  if (timeMs >= actions[actions.length - 1].at) return actions[actions.length - 1].pos;

  // Binary search the upper bracket. Action `at` values are sorted.
  let lo = 0;
  let hi = actions.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (actions[mid].at <= timeMs) lo = mid;
    else hi = mid;
  }
  const a = actions[lo];
  const b = actions[hi];
  const span = b.at - a.at;
  if (span <= 0) return b.pos;
  const t = (timeMs - a.at) / span;
  return a.pos + (b.pos - a.pos) * t;
}

export class HandyHdspSync {
  /**
   * @param {Object} deps
   * @param {{hdspMove: (pos: number, durationMs: number) => Promise<void>}} deps.handyManager
   * @param {{currentTime: number}} deps.player — typically `videoPlayer.video`
   * @param {Object} [opts]
   * @param {number} [opts.tickIntervalMs=33]
   * @param {number} [opts.lookaheadMs=100]
   */
  constructor({ handyManager, player }, opts = {}) {
    this.handyManager = handyManager;
    this.player = player;
    this._actions = null;
    this._active = false;
    this._tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this._lookaheadMs = opts.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
    this._lastSendTime = 0;
    this._lastSentPos = -1;
    // Output cutoff (hard floor/ceiling clamp). Null = no-op. Mirrors the
    // Handy HSSP path, which clamps the uploaded script content instead
    // (HDSP is per-tick so it clamps here). See SCOPE-device-cutoff-threshold.
    this._cutoff = null;
    this._timer = null;
    this._setIntervalImpl = (typeof setInterval !== 'undefined') ? setInterval : null;
    this._clearIntervalImpl = (typeof clearInterval !== 'undefined') ? clearInterval : null;
  }

  /**
   * Inject the timer functions — used by tests so they can drive the
   * scheduler synchronously without involving real timers.
   */
  setTimerImpl(setIntervalImpl, clearIntervalImpl) {
    this._setIntervalImpl = setIntervalImpl;
    this._clearIntervalImpl = clearIntervalImpl;
  }

  /**
   * Set the output cutoff floor/ceiling. Pass {min, max} (0-100) or null
   * to clear. Default no-op when {0, 100}. Applied to the interpolated
   * target before `hdspMove`.
   */
  setCutoff(cutoff) {
    this._cutoff = cutoff || null;
  }

  setActions(actions) {
    // Defensive copy + sort by `.at` so callers can't mutate underneath us.
    if (!Array.isArray(actions)) {
      this._actions = null;
      return;
    }
    this._actions = actions
      .filter((a) => a && typeof a.at === 'number' && typeof a.pos === 'number')
      .sort((a, b) => a.at - b.at);
  }

  start() {
    if (this._active) return;
    if (!this.handyManager || !this.player) return;
    if (!this._setIntervalImpl) return;
    this._active = true;
    this._lastSentPos = -1;
    this._timer = this._setIntervalImpl(() => this._tick(), this._tickIntervalMs);
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    if (this._timer && this._clearIntervalImpl) {
      this._clearIntervalImpl(this._timer);
    }
    this._timer = null;
  }

  get active() { return this._active; }

  /** One scheduler tick. Exposed for tests that drive it directly. */
  _tick() {
    if (!this._active) return;
    if (!this._actions || this._actions.length === 0) return;
    const timeMs = Math.max(0, (this.player.currentTime || 0) * 1000);
    const raw = interpolatePosition(this._actions, timeMs);
    if (raw === null) return;
    // Hard floor/ceiling clamp before send (no-op unless the user set one).
    const target = applyCutoff(raw, this._cutoff);
    if (this._lastSentPos >= 0 && Math.abs(target - this._lastSentPos) < MIN_POS_DELTA) return;
    this._lastSentPos = target;
    this._lastSendTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    // Fire-and-forget — HDSP is best-effort, the next tick will correct
    // any individual frame that didn't land.
    try {
      this.handyManager.hdspMove(target, this._lookaheadMs);
    } catch { /* swallow — non-critical */ }
  }
}
