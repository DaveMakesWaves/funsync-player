// GapSkip — detect and skip idle sections in funscript playback
import { detectGaps } from './gap-filler.js';

const DEFAULT_THRESHOLD_MS = 10000;
const LEAD_TIME_MS = 1500;     // land 1.5s before the next action
const COOLDOWN_MS = 3000;      // prevent rapid-fire skips
const CHECK_INTERVAL_MS = 1000; // how often to check for gaps

export class GapSkipEngine {
  /**
   * @param {Object} opts
   * @param {import('./video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('./funscript-engine.js').FunscriptEngine} opts.funscriptEngine
   */
  constructor({ videoPlayer, funscriptEngine }) {
    this.player = videoPlayer;
    this.funscript = funscriptEngine;

    this._gaps = [];
    this._actions = null;
    this._mode = 'off';           // 'off' | 'auto' | 'button'
    this._threshold = DEFAULT_THRESHOLD_MS;
    this._countdownSeconds = 5;

    this._currentGap = null;
    this._skipOrigin = null;      // ms — for undo
    this._lastSkipTime = -COOLDOWN_MS; // ensure first check isn't blocked by cooldown
    this._countdownTimer = null;
    this._countdownRemaining = 0;
    this._checkTimer = null;

    // DOM references (set externally via setOverlayElements)
    this._overlay = null;
    this._btnSkip = null;
    this._btnCancel = null;

    // Callbacks
    this.onShowOverlay = null;    // (gap, countdownSeconds|null) => {}
    this.onHideOverlay = null;    // () => {}
    this.onCountdownTick = null;  // (remaining) => {}
    this.onSkipped = null;        // (skippedMs) => {}
  }

  /**
   * Load gaps from the current funscript.
   * Call after funscript is loaded and video duration is known.
   */
  loadGaps() {
    if (!this.funscript.isLoaded) {
      this._gaps = [];
      this._actions = null;
      return;
    }

    this._actions = this.funscript.getActions();
    const durationMs = this.player.duration * 1000;

    if (!isFinite(durationMs) || durationMs <= 0 || !this._actions || this._actions.length < 2) {
      this._gaps = [];
      return;
    }

    this._gaps = detectGaps(this._actions, this._threshold, durationMs);
  }

  /**
   * Get detected gaps for rendering on the progress bar.
   * @returns {Array<{startMs: number, endMs: number, durationMs: number}>}
   */
  get gaps() {
    return this._gaps;
  }

  /**
   * Get the total skippable duration in milliseconds.
   */
  get totalSkippableMs() {
    return this._gaps.reduce((sum, g) => sum + g.durationMs, 0);
  }

  /**
   * Update settings.
   * @param {'off'|'auto'|'button'} mode
   * @param {number} thresholdMs
   */
  setSettings(mode, thresholdMs) {
    this._mode = mode || 'off';
    this._threshold = thresholdMs || DEFAULT_THRESHOLD_MS;
    this.loadGaps();
    this._hideOverlay();
  }

  /**
   * Start monitoring video time for gaps.
   * Call after video + funscript are loaded.
   */
  start() {
    this.stop();
    if (this._mode === 'off') return;

    this._checkTimer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  /**
   * Stop monitoring.
   */
  stop() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    this._clearCountdown();
    this._hideOverlay();
    this._currentGap = null;
  }

  /**
   * Skip to the next action from the current position.
   * Works regardless of mode — can be triggered by keyboard shortcut.
   * @returns {{skippedMs: number}|null} null if nothing to skip to
   */
  skipToNextAction() {
    if (!this._actions || this._actions.length === 0) return null;

    const timeMs = this.player.currentTime * 1000;
    const next = this._findNextAction(timeMs);

    let targetMs;
    if (next) {
      targetMs = Math.max(0, next.at - LEAD_TIME_MS);
      if (targetMs <= timeMs) return null; // already past it
    } else if (this.player.duration > 0) {
      // No next action — skip to end of video (trailing gap)
      targetMs = this.player.duration * 1000;
    } else {
      return null;
    }

    this._skipOrigin = timeMs;
    const skippedMs = targetMs - timeMs;

    this.player.video.currentTime = targetMs / 1000;

    this._lastSkipTime = performance.now();
    this._clearCountdown();
    this._hideOverlay();
    this._currentGap = null;

    if (this.onSkipped) this.onSkipped(skippedMs);

    return { skippedMs };
  }

  /**
   * Skip back to the previous action group start.
   * @returns {{skippedMs: number}|null}
   */
  skipToPreviousAction() {
    if (!this._actions || this._actions.length === 0) return null;

    const timeMs = this.player.currentTime * 1000;
    const prev = this._findPreviousActionGroupStart(timeMs);
    if (prev === null) return null;

    const targetMs = Math.max(0, prev);
    const skippedMs = timeMs - targetMs;
    if (skippedMs < 500) return null; // too close

    this._skipOrigin = timeMs;
    this.player.video.currentTime = targetMs / 1000;

    if (this.onSkipped) this.onSkipped(-skippedMs);

    return { skippedMs };
  }

  /**
   * Undo the last skip.
   */
  undo() {
    if (this._skipOrigin === null) return;
    this.player.video.currentTime = this._skipOrigin / 1000;
    this._skipOrigin = null;
  }

  // --- Internal ---

  _check() {
    if (this._mode === 'off' || this.player.paused) return;
    if (this._gaps.length === 0) return;

    const timeMs = this.player.currentTime * 1000;
    const gap = this._findGapAt(timeMs);

    if (gap && gap !== this._currentGap) {
      // Entered a new gap
      // Cooldown check
      if (performance.now() - this._lastSkipTime < COOLDOWN_MS) return;

      this._currentGap = gap;
      this._currentGapType = this._classifyGap(gap);

      if (this._mode === 'auto') {
        this._startCountdown();
      } else if (this._mode === 'button') {
        this._showSkipButton();
      }
    } else if (!gap && this._currentGap) {
      // Left the gap
      this._currentGap = null;
      this._clearCountdown();
      this._hideOverlay();
    }
  }

  _startCountdown() {
    this._countdownRemaining = this._countdownSeconds;
    this._showCountdown();

    this._countdownTimer = setInterval(() => {
      this._countdownRemaining--;
      if (this.onCountdownTick) this.onCountdownTick(this._countdownRemaining);

      if (this._countdownRemaining <= 0) {
        this._clearCountdown();
        this.skipToNextAction();
      }
    }, 1000);
  }

  _clearCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    this._countdownRemaining = 0;
  }

  _showSkipButton() {
    if (this.onShowOverlay) this.onShowOverlay(this._currentGap, null, this._currentGapType);
  }

  _showCountdown() {
    if (this.onShowOverlay) this.onShowOverlay(this._currentGap, this._countdownRemaining, this._currentGapType);
  }

  /**
   * Classify a gap as 'leading' (before first action), 'trailing' (after last action), or 'mid'.
   */
  _classifyGap(gap) {
    if (!this._actions || this._actions.length < 1) return 'mid';
    const firstAt = this._actions[0].at;
    const lastAt = this._actions[this._actions.length - 1].at;
    if (gap.endMs <= firstAt + 100) return 'leading';
    if (gap.startMs >= lastAt - 100) return 'trailing';
    return 'mid';
  }

  _hideOverlay() {
    if (this.onHideOverlay) this.onHideOverlay();
  }

  /**
   * Find the gap that contains the given time (exclusive of endpoints).
   */
  _findGapAt(timeMs) {
    for (const gap of this._gaps) {
      if (timeMs >= gap.startMs && timeMs < gap.endMs) {
        return gap;
      }
    }
    return null;
  }

  /**
   * Find the next action after the given time.
   */
  _findNextAction(timeMs) {
    if (!this._actions) return null;

    // Binary search
    let lo = 0;
    let hi = this._actions.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this._actions[mid].at <= timeMs) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return lo < this._actions.length ? this._actions[lo] : null;
  }

  /**
   * Find the start of the previous action group.
   * An action group is a sequence of actions separated by less than the threshold.
   */
  _findPreviousActionGroupStart(timeMs) {
    if (!this._actions || this._actions.length === 0) return null;

    // Find the action just before current time
    let idx = -1;
    for (let i = this._actions.length - 1; i >= 0; i--) {
      if (this._actions[i].at < timeMs - 500) { // 500ms buffer
        idx = i;
        break;
      }
    }

    if (idx < 0) return null;

    // Walk backwards through the current action group (actions closer than threshold)
    while (idx > 0) {
      const gap = this._actions[idx].at - this._actions[idx - 1].at;
      if (gap >= this._threshold) break;
      idx--;
    }

    // Now walk back further to find the previous group
    if (idx > 0) {
      idx--; // step past the gap
      // Walk to the start of that group
      while (idx > 0) {
        const gap = this._actions[idx].at - this._actions[idx - 1].at;
        if (gap >= this._threshold) break;
        idx--;
      }
    }

    return this._actions[idx].at;
  }
}

// --- Pure utility functions for testing ---

export { DEFAULT_THRESHOLD_MS, LEAD_TIME_MS, COOLDOWN_MS };
