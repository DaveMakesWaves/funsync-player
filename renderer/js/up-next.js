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
    // onPlayNext already fired for this video. The advance is one-shot: the
    // context only changes once the next video's load gets past an await
    // (the funscript read), and every check() in that window saw the OLD
    // context with the playhead at its end, so _show() fired again with a
    // zero countdown. One end loaded the next video two or three times,
    // each with its own script convert and device upload (V18).
    this._advanced = false;
    // rearm() after a cancelled advance: the card stays down until the
    // playhead has left the end window once, then comes back on the next end.
    this._waitForLeave = false;
    // The furthest the playhead got since that rearm(): a seek back from
    // there also counts as leaving (see check()).
    this._rearmedAtSec = null;
    // The next-up card on screen was offered AFTER the video had ended, by
    // a queue or source change under an End-of-list card (R4-01): it counts
    // its own full countdown, so being at the end is where it started, not a
    // reason to fire, and the ended video reading paused does not freeze it.
    this._afterEnd = false;

    // Card state
    this._visible = false;
    this._endOfList = false;
    this._shownNext = null;         // the path the next-up card names (refresh)
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

    // Optional "is this path still in the library" predicate.
    //
    // `_playContext.list` is a SNAPSHOT of absolute paths taken when playback
    // started, and nothing revalidates it. Remove a source mid-session and its
    // paths stay in the snapshot, so Up Next happily proposes a video that no
    // longer exists — Welliambrisk's log (2026-08-27) shows a thumbnail being
    // fetched for a file under a source he had removed, requested by the
    // Up Next card ~14s into a 24s clip. Nothing crashed; it just offered him
    // something it could not play.
    //
    // Returns true when unknown, so a library that has not finished scanning
    // never suppresses the card. See _playable.
    this.isPlayable = null;         // (path) => boolean

    // Optional owner of "what plays next" for a context (CB-10). When it
    // returns a path, or null for "nothing follows", that IS the next: the
    // card, the countdown advance and End of list all use it, and the app's
    // own advance asks the same function, so what the card names is what
    // plays. `undefined` hands the decision back to the list walk below.
    // A Play All queue needs it: its loop wrap plays a fresh shuffle the
    // context's list cannot know about, and its advance walks the queue.
    this.resolveNext = null;        // (playContext) => path | null | undefined

    // Optional: may a card be offered for a video that has already ended
    // (R4-01)? The app says yes only while its player view is on screen;
    // anywhere else (the library after Back, the mini player, the pop-out)
    // a queue change at the end offers nothing. Unset = no.
    this.canOfferAfterEnd = null;   // () => boolean

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
    this._advanced = false;
    this._waitForLeave = false;
    this._rearmedAtSec = null;
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
    if (this._mode === 'off' || this._suppressed || this._dismissed || this._advanced) {
      this.hide();
      return;
    }
    const should = this._shouldShow();
    if (this._waitForLeave) {
      // A seek back of a second or more is "watch it again" too. A video
      // shorter than the countdown sits in the end window from its first
      // second, so it never left it, and after a Cancel the card never came
      // back however far back the user seeked (R3 fix-up, real-app verifier
      // 1: an 8 s clip with the default 10 s countdown).
      // `_rearmedAtSec` is the furthest the playhead got since the rearm.
      const now = this.player?.currentTime;
      const seekedBack = Number.isFinite(now) && Number.isFinite(this._rearmedAtSec)
        && now <= this._rearmedAtSec - 1;
      if (should && !seekedBack) {
        if (Number.isFinite(now)) this._rearmedAtSec = Math.max(this._rearmedAtSec ?? now, now);
        this.hide();
        return;
      }
      this._waitForLeave = false;
      this._rearmedAtSec = null;
    }
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
    this._fire(path);
  }

  /**
   * The advance this video handed over did not happen: the user answered
   * Cancel at the unsaved-changes question it raised (round 2). Cancel means
   * "not now", so the one-shot guard (`_advanced`) is released: it stayed
   * set, and Up Next never fired again for this video. Not at once, though:
   * still at the end, the card would count down and ask again. It comes back
   * on the NEXT end, once the playhead has left the end window or been
   * seeked back (a clip shorter than the countdown never leaves it).
   */
  rearm() {
    if (!this._advanced) return;
    this._advanced = false;
    this._waitForLeave = true;
    this._rearmedAtSec = Number.isFinite(this.player?.currentTime) ? this.player.currentTime : null;
    this.hide();
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
    this._afterEnd = false;
    this._pauseReasons.clear();
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this.onHide) this.onHide();
  }

  /**
   * Keep a visible card naming what will really play (FT-018). The card's
   * next is worked out when it shows; a source removed, or a video queued or
   * unqueued, while it was up changed what plays but not what it said (it
   * named a video from the removed source and then played another). Runs on
   * every tick, and app.js calls it when the queue or the sources change
   * (the End-of-list card has no ticker). The countdown carries on; only the
   * name moves, or the card switches between next-up and End of list.
   */
  refresh() {
    if (!this._visible) return;
    const last = this._isLastInList();
    if (last !== this._endOfList) {
      // An End-of-list card left over from a video that has ENDED, and now
      // something follows (a video queued from the library, a source switched
      // back on). check() would show a next-up card with nothing left of the
      // video to count down, and fire it at once: queuing a card after Back
      // switched to the player and loaded it (R4-01, new since v0.9.2: FT-018
      // made a queue change call this). Never fire here. In the player view
      // a fresh card with the full countdown is offered, which the user can
      // cancel; anywhere else nothing shows, and it stays that way until the
      // playhead leaves the end (a replay, a seek back).
      if (this._endOfList && this._atVideoEnd()) {
        this.hide();
        const next = this._nextPath();
        if (next && this._mayOfferAfterEnd()) {
          this._showAfterEnd(next);
        } else {
          this._waitForLeave = true;
          this._rearmedAtSec = Number.isFinite(this.player?.currentTime) ? this.player.currentTime : null;
        }
        return;
      }
      this.hide();
      this.check();
      return;
    }
    if (last) return;
    const next = this._nextPath();
    if (!next || next === this._shownNext) return;
    this._shownNext = next;
    if (this.onShowNext) this.onShowNext(next, this._remainingCountdownSec());
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

  /**
   * What an advance from the current entry would play, without playing it or
   * moving anything: the app walks on from an entry whose file turned out to
   * be missing only once it was loaded (App._onCurrentVideoMissing).
   */
  peekNext() {
    return this._nextPath();
  }

  // --- Inspection (for tests + debugging) ---

  get visible() { return this._visible; }
  get endOfListShown() { return this._endOfList; }
  /** The next-up card on screen was offered after the video ended (R4-01). */
  get afterEndShown() { return this._visible && this._afterEnd; }
  get paused() { return this._pauseReasons.size > 0; }
  get pauseReasons() { return Array.from(this._pauseReasons); }
  get mode() { return this._mode; }
  get countdownSec() { return this._countdownSec; }

  // --- Internal ---

  _priorityNext() {
    try { return this.getPriorityNext?.() || null; } catch { return null; }
  }

  /** The app's decision for this context (see `resolveNext`), else undefined. */
  _resolvedNext() {
    if (typeof this.resolveNext !== 'function') return undefined;
    try {
      const path = this.resolveNext(this._playContext);
      return path === undefined ? undefined : (path || null);
    } catch {
      return undefined;
    }
  }

  /** Hand the advance to the app, once per video (see `_advanced`). */
  _fire(path) {
    if (!path || !this.onPlayNext || this._advanced) return;
    this._advanced = true;
    this.onPlayNext(path);
  }

  /**
   * Whether `path` is still something we could play.
   *
   * Unknown counts as playable: the predicate is optional, the library may
   * still be scanning, and a false negative here silently kills the Up Next
   * card — a much more visible regression than the stale entry it exists to
   * skip.
   */
  _playable(path) {
    if (!path) return false;
    if (typeof this.isPlayable !== 'function') return true;
    try {
      return this.isPlayable(path) !== false;
    } catch {
      return true;
    }
  }

  _nextPath() {
    // A user-queued item takes priority over the context's own next, and is
    // NOT filtered: the user put it there by hand and is looking at it in the
    // queue panel. Silently skipping their explicit choice would be a worse
    // surprise than failing to open it.
    const priority = this._priorityNext();
    if (priority) return priority;
    if (!this._playContext) return null;
    const decided = this._resolvedNext();
    if (decided !== undefined) return decided;
    const list = this._playContext.list;
    if (!list || list.length === 0) return null;
    const next = (this._playContext.index ?? -1) + 1;
    // Walk forward past anything the library no longer has, rather than
    // returning the first entry blindly.
    for (let i = next; i < list.length; i++) {
      if (this._playable(list[i])) return list[i];
    }
    // Loop mode: after the last item, "next" wraps to index 0. Used by
    // playlists that have their per-playlist loop toggle on. Stops before the
    // current index so a list of nothing-but-missing files cannot spin.
    if (this._playContext.loop) {
      const stop = Math.min(next, list.length);
      for (let i = 0; i < stop; i++) {
        if (this._playable(list[i])) return list[i];
      }
    }
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
    if (this._playContext.loop) return this._nextPath() === null;
    // "Last" is really "nothing playable left after this one" — with stale
    // entries filtered out, being at index 3 of 5 can still be the end.
    return this._nextPath() === null;
  }

  _shouldShow() {
    // A video with no list (a dropped or opened file) still offers a video
    // you queued (FT-074 follow-up, 2026-11-22): it used to wait, unoffered,
    // until the next Library play. With no queue it offers nothing, as before.
    const hasList = !!(this._playContext?.list && this._playContext.index >= 0);
    if (!hasList && !this._priorityNext()) return false;

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
      this._fire(nextPath);
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

    this._shownNext = nextPath;
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
    // Not a card offered after the end (R4-01): it started there and runs
    // its own countdown, until the playhead moves off the end.
    const atEnd = this._atVideoEnd();
    if (this._afterEnd && !atEnd) this._afterEnd = false;
    if (atEnd && !this._afterEnd) {
      const path = this._nextPath();
      this.hide();
      this._fire(path);
      return;
    }

    // Mid-video pause (user paused) is its own pause reason — countdown
    // freezes until they unpause OR they dismiss / hover-resume. An ended
    // video reads paused; a card offered after the end is not frozen by it.
    if (this.player?.paused && !this._afterEnd) this._pauseFor('video');
    else this._resumeFor('video');

    // Paused or not, the card must name what will play (FT-018).
    this.refresh();
    if (!this._visible || this._endOfList) return;

    if (this.paused) return;

    const elapsed = performance.now() - this._countdownStartedAt - this._pausedAccruedMs;
    let remainingMs = this._countdownTotalMs - elapsed;
    // A seek forward inside the window leaves less video than countdown. The
    // count follows the video: the card said "in 9 s" with 6 s left and the
    // next video started at the end while it was still counting (verify-1,
    // 2026-11-07). It only ever shortens; a card offered after the end has
    // no video left to follow.
    if (!this._afterEnd) {
      const videoLeftMs = ((this.player?.duration || 0) - (this.player?.currentTime || 0)) * 1000;
      if (Number.isFinite(videoLeftMs) && videoLeftMs > 0 && videoLeftMs < remainingMs) {
        this._countdownTotalMs -= remainingMs - videoLeftMs;
        remainingMs = videoLeftMs;
      }
    }
    if (remainingMs <= 0) {
      const path = this._nextPath();
      this.hide();
      this._fire(path);
      return;
    }
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
    if (this.onTick) this.onTick(remainingSec);
  }

  /** Whole seconds left on the running countdown, paused time excluded. */
  _remainingCountdownSec() {
    const now = performance.now();
    const pausedNow = this._pauseReasons.size > 0 ? now - this._pauseEnteredAt : 0;
    const elapsed = now - this._countdownStartedAt - this._pausedAccruedMs - pausedNow;
    return Math.max(1, Math.ceil((this._countdownTotalMs - elapsed) / 1000));
  }

  _isAtVideoEnd() {
    const dur = this.player?.duration || 0;
    if (!isFinite(dur) || dur <= 0) return false;
    return (this.player.currentTime || 0) >= dur - 0.05;
  }

  /** Ended, or close enough that a countdown has nothing left to count. */
  _atVideoEnd() {
    return !!this.player?.ended || this._isAtVideoEnd();
  }

  /** The app's answer to "may a card be offered after the end?" (R4-01). */
  _mayOfferAfterEnd() {
    if (typeof this.canOfferAfterEnd !== 'function') return false;
    try { return this.canOfferAfterEnd() === true; } catch { return false; }
  }

  /**
   * A next-up card for a video that has already ended (R4-01): the full
   * countdown, never one clamped to the time left (there is none, and a
   * zero countdown fired at once). It plays `nextPath` when it runs out,
   * like any card; × dismisses it, and a replay or a seek back takes it down.
   */
  _showAfterEnd(nextPath) {
    this._visible = true;
    this._endOfList = false;
    this._afterEnd = true;
    this._pauseReasons.clear();
    this._countdownTotalMs = this._countdownSec * 1000;
    this._countdownStartedAt = performance.now();
    this._pausedAccruedMs = 0;
    this._pauseEnteredAt = 0;
    this._shownNext = nextPath;
    if (this.onShowNext) this.onShowNext(nextPath, this._countdownSec);
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => this._tick(), TICK_INTERVAL_MS);
  }
}

export { MIN_TRAILING_GAP_MS, TICK_INTERVAL_MS };
