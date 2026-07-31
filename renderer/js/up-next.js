// UpNextEngine — autoplay-countdown card that suggests the next library
// item at the end of a video. Pure logic; no DOM. The view (UpNextCard)
// subscribes to onShowNext / onShowEndOfList / onTick / onHide and paints
// accordingly. See `notes/features/SCOPE-up-next.md` for the full spec.
//
// Trigger zone (per SCOPE §4): the engine fires `onShowNext` when the
// playhead enters a trailing dead zone — the post-last-action gap if a
// script is loaded, or the last 5 s if no script (or no trailing gap).
// At zero-countdown, fires `onPlayNext(path)`. End-of-list (last item in
// the snapshot) routes to `onShowEndOfList` instead — same trigger zone,
// no countdown, informational only.

// "Trailing gap is meaningful" floor — gaps shorter than this are just
// brief silence, not worth interrupting playback for.
const MIN_TRAILING_GAP_MS = 5000;
const TICK_INTERVAL_MS = 200;       // countdown poll cadence (sub-second so the label feels live)

export class UpNextEngine {
  /**
   * @param {Object} opts
   * @param {import('./video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('./funscript-engine.js').FunscriptEngine} opts.funscriptEngine
   */
  constructor({ videoPlayer, funscriptEngine }) {
    this.player = videoPlayer;
    this.funscript = funscriptEngine;

    this._mode = 'auto';
    this._countdownSec = 10;
    this._playContext = null;       // { source, sourceLabel, sourceContext, list, index }
    this._suppressed = false;       // editor open, A-B loop, video.loop, modal open
    this._dismissed = false;        // user clicked × or pressed Esc for this video

    // Card state
    this._visible = false;
    this._endOfList = false;
    // Multiple sources can pause the countdown (hover and video-pause
    // are independent). Track each so resuming hover doesn't undo a
    // video.paused-driven pause and vice versa.
    this._pauseReasons = new Set();   // {'hover', 'video'}
    this._countdownTotalMs = 0;
    this._countdownStartedAt = 0;     // performance.now()
    this._pausedAccruedMs = 0;
    this._pauseEnteredAt = 0;
    this._tickTimer = null;

    // Optional resolver for a "priority next" — a user-queued item that
    // plays before the context's own next (foobar2000-style queue insert).
    // When it returns a path, that's the real next-up: the card, the
    // queue-panel countdown chip, and playNext() all target it, and the
    // context is never treated as end-of-list (a queued item follows).
    this.getPriorityNext = null;    // () => path | null

    // Callbacks
    this.onShowNext = null;         // (nextPath, countdownSec) => {}
    this.onShowEndOfList = null;    // (sourceLabel, sourceContext) => {}
    this.onTick = null;             // (remainingSec) => {}
    this.onHide = null;             // () => {}
    this.onPlayNext = null;         // (path) => {}
  }

  // --- Public API ---

  setSettings(mode, countdownSec) {
    this._mode = mode || 'off';
    if (typeof countdownSec === 'number' && countdownSec > 0) {
      this._countdownSec = countdownSec;
    }
    if (this._mode === 'off') this.hide();
  }

  setPlayContext(ctx) {
    this._playContext = ctx || null;
    // New context = new video session — clear dismissal so the card can
    // re-fire for the new video.
    this._dismissed = false;
    this.hide();
  }

  setSuppressed(flag) {
    const next = !!flag;
    if (next === this._suppressed) return;
    this._suppressed = next;
    if (next) this.hide();
  }

  /**
   * Check whether the card should be shown right now. Called by app.js
   * on timeupdate, seeked, play, pause, ended, and on context / settings
   * changes. Idempotent: showing-when-already-shown is a no-op.
   */
  check() {
    if (this._mode === 'off' || this._suppressed || this._dismissed) {
      this.hide();
      return;
    }
    const should = this._shouldShow();
    if (should && !this._visible) {
      this._show();
    } else if (!should && this._visible) {
      this.hide();
    }
  }

  /**
   * Pause the countdown — used by the card on hover or focus.
   */
  pauseCountdown() { this._pauseFor('hover'); }

  /**
   * Resume the countdown after a hover/focus pause.
   */
  resumeCountdown() { this._resumeFor('hover'); }

  /**
   * Fire the next-video callback immediately (user clicked play icon /
   * thumbnail / title).
   */
  playNext() {
    if (!this._visible || this._endOfList) return;
    const path = this._nextPath();
    this.hide();
    if (path && this.onPlayNext) this.onPlayNext(path);
  }

  /**
   * User dismissed via × or Esc — hide and stay dismissed for this video.
   */
  dismiss() {
    if (!this._visible) return;
    this._dismissed = true;
    this.hide();
  }

  /**
   * Tear down the card without setting the dismiss flag. Used on view
   * change / new video / suppression.
   */
  hide() {
    if (!this._visible) return;
    this._visible = false;
    this._endOfList = false;
    this._pauseReasons.clear();
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this.onHide) this.onHide();
  }

  /**
   * Walk forward in the list to skip a missing file (called if onPlayNext
   * verifies the file is gone). Returns the next playable path or null
   * if we've fallen off the end.
   */
  advancePastMissing() {
    if (!this._playContext) return null;
    this._playContext = { ...this._playContext, index: this._playContext.index + 1 };
    return this._nextPath();
  }

  // --- Inspection (for tests + debugging) ---

  get visible() { return this._visible; }
  get endOfListShown() { return this._endOfList; }
  get paused() { return this._pauseReasons.size > 0; }
  get pauseReasons() { return Array.from(this._pauseReasons); }
  get mode() { return this._mode; }
  get countdownSec() { return this._countdownSec; }

  // --- Internal ---

  _priorityNext() {
    try { return this.getPriorityNext?.() || null; } catch { return null; }
  }

  _nextPath() {
    // A user-queued item takes priority over the context's own next.
    const priority = this._priorityNext();
    if (priority) return priority;
    if (!this._playContext) return null;
    const list = this._playContext.list;
    if (!list || list.length === 0) return null;
    const next = (this._playContext.index ?? -1) + 1;
    if (next < list.length) return list[next];
    // Loop mode: after the last item, "next" wraps to index 0. Used by
    // playlists that have their per-playlist loop toggle on.
    if (this._playContext.loop) return list[0];
    return null;
  }

  _isLastInList() {
    // A queued item plays next, so the context is never "last" here — show
    // the next-up card for the queued item, not the end-of-list state.
    if (this._priorityNext()) return false;
    if (!this._playContext?.list) return false;
    // When loop is on, there's no "last" — the queue wraps. Always
    // show the next-up card with the looped-around item, never the
    // end-of-list state.
    if (this._playContext.loop) return false;
    return this._playContext.index >= this._playContext.list.length - 1;
  }

  _shouldShow() {
    if (!this._playContext || !this._playContext.list) return false;
    if (this._playContext.index < 0) return false;

    const durationMs = (this.player?.duration || 0) * 1000;
    if (!isFinite(durationMs) || durationMs <= 0) return false;
    const currentMs = (this.player?.currentTime || 0) * 1000;

    // Trailing-gap branch: script loaded with a meaningful tail past
    // the last action. Mirrors gap-skip.js::_classifyGap('trailing').
    // Fires the moment the playhead enters the dead zone, regardless of
    // how much real video time remains.
    if (this.funscript?.isLoaded) {
      const actions = this.funscript.getActions?.() || [];
      if (actions.length > 0) {
        const lastMs = actions[actions.length - 1].at;
        const tailMs = durationMs - lastMs;
        if (tailMs >= MIN_TRAILING_GAP_MS && currentMs >= lastMs) return true;
        // No meaningful trailing gap — fall through to last-N-seconds.
      }
    }
    // Last-N-seconds branch: no script, OR script with no trailing
    // gap. Window matches the user's configured countdown so the card
    // appears N seconds before the end and counts down 1:1 with the
    // remaining video time. Skipping into the window mid-stream still
    // shows the card with the correct (clamped) countdown.
    const triggerWindowMs = this._countdownSec * 1000;
    return durationMs - currentMs <= triggerWindowMs;
  }

  _show() {
    if (this._isLastInList()) {
      this._visible = true;
      this._endOfList = true;
      if (this.onShowEndOfList) {
        this.onShowEndOfList(
          this._playContext.sourceLabel || this._playContext.source || 'list',
          this._playContext.sourceContext || {},
        );
      }
      return;
    }

    const nextPath = this._nextPath();
    if (!nextPath) return;

    // Clamp countdown to time-remaining so a 3 s tail doesn't run a
    // 10 s countdown into negative territory.
    const remainingSec = Math.max(0, this.player.duration - this.player.currentTime);
    const countdown = Math.min(this._countdownSec, Math.ceil(remainingSec));
    if (countdown <= 0) {
      // Trigger zone is past the video end — fire immediately.
      this.hide();
      if (this.onPlayNext) this.onPlayNext(nextPath);
      return;
    }

    this._visible = true;
    this._endOfList = false;
    this._pauseReasons.clear();
    this._countdownTotalMs = countdown * 1000;
    this._countdownStartedAt = performance.now();
    this._pausedAccruedMs = 0;
    this._pauseEnteredAt = 0;
    if (this.player?.paused) this._pauseFor('video');

    if (this.onShowNext) this.onShowNext(nextPath, countdown);
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => this._tick(), TICK_INTERVAL_MS);
  }

  _pauseFor(reason) {
    if (!this._visible || this._endOfList) return;
    if (this._pauseReasons.has(reason)) return;
    if (this._pauseReasons.size === 0) {
      this._pauseEnteredAt = performance.now();
    }
    this._pauseReasons.add(reason);
  }

  _resumeFor(reason) {
    if (!this._visible || this._endOfList) return;
    if (!this._pauseReasons.has(reason)) return;
    this._pauseReasons.delete(reason);
    if (this._pauseReasons.size === 0) {
      this._pausedAccruedMs += performance.now() - this._pauseEnteredAt;
    }
  }

  _tick() {
    if (!this._visible || this._endOfList) return;

    // Video reached the end — fire next immediately rather than freezing
    // the countdown on whatever number it was at. This is the dominant
    // path: trigger zone is short, video ends mid-countdown, the
    // standard 'paused' reason would otherwise lock the card.
    if (this.player?.ended || this._isAtVideoEnd()) {
      const path = this._nextPath();
      this.hide();
      if (path && this.onPlayNext) this.onPlayNext(path);
      return;
    }

    // Mid-video pause (user paused) is its own pause reason — countdown
    // freezes until they unpause OR they dismiss / hover-resume.
    if (this.player?.paused) this._pauseFor('video');
    else this._resumeFor('video');

    if (this.paused) return;

    const elapsed = performance.now() - this._countdownStartedAt - this._pausedAccruedMs;
    const remainingMs = this._countdownTotalMs - elapsed;
    if (remainingMs <= 0) {
      const path = this._nextPath();
      this.hide();
      if (path && this.onPlayNext) this.onPlayNext(path);
      return;
    }
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
    if (this.onTick) this.onTick(remainingSec);
  }

  _isAtVideoEnd() {
    const dur = this.player?.duration || 0;
    if (!isFinite(dur) || dur <= 0) return false;
    return (this.player.currentTime || 0) >= dur - 0.05;
  }
}

export { MIN_TRAILING_GAP_MS, TICK_INTERVAL_MS };
