// SyncEngine — Coordinate video playback with Handy device

import {
  isPictureStarved, isProxyStall, proxyStallAgeMs, ProgressWatch,
  StallGrace, STALL_RESYNC_MS, stallSummary,
} from './playback-stall.js';

/** How old the last anchor play may be and still cover a new 'playing' (FN-01 follow-up). */
export const ANCHOR_COVER_MS = 1000;

export class SyncEngine {
  constructor({ videoPlayer, handyManager, funscriptEngine }) {
    this.player = videoPlayer;
    this.handy = handyManager;
    this.funscript = funscriptEngine;

    this._active = false;
    this._scriptReady = false;
    this._rafId = null;
    this._lastCheckTime = 0;
    this._playingTimer = null; // for double-play correction
    this._secondPlayDelay = 2500; // ms — matches SDK's videoPlayerDelayForSecondPlay
    this._seekGen = 0;  // monotonic counter so rapid seeks supersede in-flight handlers
    // Same idea for play/pause. hsspPlay is a CLOUD call: x0193143's log
    // (thread #288) shows it taking 8.7s and 17.3s to return. Pause during
    // that window sent hsspStop, the pending play then landed AFTER it, and
    // the device carried on stroking — "Handy would keep working about 15
    // seconds". Bumping this on pause lets a superseded play undo itself.
    this._playGen = 0;
    // Bumped ONLY by things that mean "the device should be stopped" (pause,
    // ended). `_playGen` alone cannot answer "was I superseded by a pause or
    // by another play?", and the answer decides whether an in-flight play
    // must undo itself — see _handlePlaying.
    this._pauseGen = 0;
    // Bumped by EVERY play this engine sends (anchor, seek, both corrections,
    // the drift re-anchor). A late play whose hold is already over must not
    // re-stop the device when a newer play has been sent since: in the HSSP
    // chain that stop dropped the newer play, and the device sat out the
    // resume until the 2.5 s correction (fix-up review, 2026-11-16).
    this._playSeq = 0;
    // The last anchor play _handlePlaying sent ({ seq, timeMs, at, pauseGen,
    // seekGen, ok }), so a second 'playing' at the same moment sends none.
    this._lastAnchor = null;

    // N-01 (Dave 2026-11-08: "the handy now doesnt always pause with the
    // video escpecially if its buffering"). HSSP plays on the DEVICE's clock,
    // so the device ran on through every stall that fired no 'pause': 15 s
    // ahead of a frozen picture on a starved source, then a jump back on
    // 'playing' (reproduced 2026-11-16). A stall now HOLDS the device as a
    // pause does and 'playing' re-anchors it. Why we hold, or null:
    //   'waiting' — the element has no next frame and promises a 'playing'
    //               when it has (so a 'seeked' meanwhile leaves the anchor to
    //               that 'playing');
    //   'seeking' / 'error' / 'frozen' — no such promise ('frozen' = the
    //               clock stopped with no event; the stall watch resumes it).
    this._held = null;
    this._progress = new ProgressWatch();
    this._stallTimer = null;
    this._stallPollMs = 250;
    this._now = () => performance.now();

    // FN-05 (Dave 2026-11-16): a stall waits STALL_GRACE_MS before it holds
    // the device, so a hiccup of a few frames is not a stop and a play. While
    // the window is open nothing is sent; past it, `_held` as above. A hiccup
    // over inside it left the device ahead of the picture by its length:
    // `_stallDriftMs` adds those up for the anchor `_stallDriftSeq` (a
    // `_playSeq`; any newer play starts a new total), and reaching
    // STALL_RESYNC_MS sends one re-anchor play. `_stallPlayOwed`: a resync()
    // asked for inside the window, sent when the picture moves.
    this._grace = new StallGrace({
      now: () => this._now(),
      onExpire: (reason) => this._holdAfterGrace(reason),
    });
    this._stallDriftMs = 0;
    this._stallDriftSeq = -1;
    this._stallPlayOwed = false;

    // Callbacks
    this.onDriftDetected = null;  // (driftMs) => {}
    this.onSyncStatus = null;    // (status: 'synced'|'drifting'|'resyncing') => {}
    // () => {} — fired when a pause could NOT stop the device. Wired by app.js
    // to a toast, because the device is physically still moving and only the
    // user can do anything about it.
    this.onStopFailed = null;
  }

  /**
   * Start the sync engine. Call after both video and funscript are loaded
   * and the device is connected with a script set up.
   */
  start() {
    if (this._active) return;

    this._active = true;
    this._held = null;
    this._grace.end();
    this._stallPlayOwed = false;
    // A play from before this start (the device since handed to HDSP, the
    // Orgasm Switch, another video) never covers this start's anchor.
    this._lastAnchor = null;
    this._bindVideoEvents();
    this._startStallWatch();
    // Poll the device's reachability faster while a script is running. During
    // HSSP playback the app sends almost no commands, so the poll is the only
    // thing that would notice the device had gone — see setPlaybackActive.
    this.handy.setPlaybackActive?.(true);

    // If video is already playing, sync immediately.
    //
    // Not awaited (start() is sync), so it MUST carry its own catch: this one
    // is not reached through the guarded event listeners, and a rejection
    // inside it has no owner. It broke CI rather than the app — vitest fails
    // the run on an unhandled rejection while Node only warns (2026-08-21).
    //
    // ...unless "playing" is a video still loading (N-01): a load on a slow
    // drive starts with paused false and no frame for seconds, and anchoring
    // then ran the device that far ahead. The element fires 'playing' when
    // it can move, and that anchors.
    if (!this.player.paused && isPictureStarved(this.player.video)) {
      this._held = 'waiting';
      console.log('[Sync] started on a video that cannot move yet — anchoring on its playing event');
    } else if (!this.player.paused) {
      this._handlePlaying().catch((err) => {
        console.warn('[Sync] initial anchor failed:', err?.message || err);
      });
    }

    console.log('Sync engine started');
  }

  /**
   * Force a re-anchor at the player's CURRENT time.
   *
   * `start()` only anchors when `player.paused` is false at that instant.
   * That check is unreliable right after the Orgasm Switch releases: in a
   * web-remote session `player` is the RemotePlaybackProxy, whose paused
   * flag can still read true while the phone is mid-buffer. The logs showed
   * "Sync engine started" with no following `[Sync] hsspPlay`, so the Handy
   * simply stayed wherever the finisher had left it and the script ran out
   * of step with the video until the next seek (Dave 2026-08-05). Buttplug
   * never had this problem because ButtplugSync re-reads currentTime every
   * tick and self-corrects within a frame — only the anchored HSSP path
   * needs telling.
   *
   * @returns {Promise<boolean>} whether an anchor was attempted
   */
  async resync() {
    if (!this._active || !this._scriptReady || !this.handy.connected) return false;
    // Held on a stall (N-01, e.g. start() found the video still loading):
    // the stall's own end anchors, at the time the picture really resumes.
    if (this._held) return false;
    // Inside a stall's grace window (FN-05) the picture is frozen too: an
    // anchor now would run the device ahead of it. The play goes when the
    // picture moves (or with the hold's own 'playing').
    if (this._grace.open) {
      this._stallPlayOwed = true;
      return false;
    }
    await this._handlePlaying();
    return true;
  }

  /**
   * True while a stall holds the device (N-01), or the picture is stopped
   * inside a stall's grace window (FN-05): nothing may restart it.
   */
  get holding() {
    return this._held !== null || this._grace.open;
  }

  /**
   * Stop the sync engine. On its own this sends the device nothing.
   *
   * `deviceStopped`: the caller has just sent the device a stop (a video
   * change, FN-01 / FT-115; the player pop-out's take-over). A play of ours
   * still in flight then re-sends that stop when it lands, as it does after
   * a pause, unless a newer play owns the device by then: a stop always
   * wins over a late play. Left off where the device is handed to something
   * else that drives it (HDSP at a non-1x rate, the Orgasm Switch), where a
   * late stop would knock it out of that mode.
   * @param {{ deviceStopped?: boolean }} [opts]
   */
  stop({ deviceStopped = false } = {}) {
    if (deviceStopped) {
      this._playGen++;
      this._pauseGen++;
    }
    this._active = false;
    this._lastAnchor = null;
    this._endStall('stop');   // a grace timer never acts after this (FN-05)
    this._held = null;
    this._unbindVideoEvents();
    this._stopStallWatch();
    this.handy.setPlaybackActive?.(false);
    this._stopDriftMonitor();
    clearTimeout(this._playingTimer);

    console.log('Sync engine stopped');
  }

  /**
   * Set up the script on the Handy device.
   * @param {string} scriptUrl - URL to the CSV script
   * @returns {boolean}
   */
  async setupScript(scriptUrl) {
    if (!this.handy.connected) return false;

    const success = await this.handy.setupScript(scriptUrl);
    this._scriptReady = success;
    return success;
  }

  // --- Video Event Handlers ---

  _bindVideoEvents() {
    const video = this.player.video;
    // Use 'playing' not 'play' — 'playing' fires after buffering completes,
    // 'play' fires when play is requested (might still be buffering).
    //
    // Each handler is async; swallow rejections at the listener boundary so
    // a failing Handy call (network drop, device disconnect) doesn't become
    // an unhandled promise rejection that muddies the console.
    const guard = (fn, label) => () => fn().catch(err =>
      console.warn(`[Sync] ${label} failed: ${err?.message || err}`)
    );
    this._onPlaying = guard(() => this._handlePlaying(), '_handlePlaying');
    this._onPause   = guard(() => this._handlePause(),   '_handlePause');
    this._onSeeked  = guard(() => this._handleSeeked(),  '_handleSeeked');
    this._onEnded   = guard(() => this._handleEnded(),   '_handleEnded');
    // N-01: the picture stops without a 'pause' — a starved source
    // ('waiting'; 'stalled' only when it really has no frame), a seek while
    // playing, a media error. Each holds the device; 'playing' re-anchors.
    this._onWaiting = guard(() => this._handleStall('waiting'), '_handleStall');
    this._onStalled = guard(() => this._handleStall('stalled'), '_handleStall');
    this._onSeeking = guard(() => this._handleStall('seeking'), '_handleStall');
    this._onError   = guard(() => this._handleStall('error'),   '_handleStall');

    video.addEventListener('playing', this._onPlaying);
    video.addEventListener('pause', this._onPause);
    video.addEventListener('seeked', this._onSeeked);
    video.addEventListener('ended', this._onEnded);
    video.addEventListener('waiting', this._onWaiting);
    video.addEventListener('stalled', this._onStalled);
    video.addEventListener('seeking', this._onSeeking);
    video.addEventListener('error', this._onError);
  }

  _unbindVideoEvents() {
    const video = this.player.video;
    if (this._onPlaying) video.removeEventListener('playing', this._onPlaying);
    if (this._onPause) video.removeEventListener('pause', this._onPause);
    if (this._onSeeked) video.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) video.removeEventListener('ended', this._onEnded);
    if (this._onWaiting) video.removeEventListener('waiting', this._onWaiting);
    if (this._onStalled) video.removeEventListener('stalled', this._onStalled);
    if (this._onSeeking) video.removeEventListener('seeking', this._onSeeking);
    if (this._onError) video.removeEventListener('error', this._onError);
  }

  async _handlePlaying() {
    // 'playing' means the picture moves: whatever held the device is over,
    // and the stall watch starts a fresh window from here.
    const ep = this._grace.end();
    this._held = null;
    this._progress.reset();
    const playOwed = this._stallPlayOwed;
    this._stallPlayOwed = false;
    if (!this._active || !this._scriptReady || !this.handy.connected) {
      if (ep) this._logStall(ep, { endedBy: 'playing' });
      return;
    }

    // FN-05: a hiccup over inside its grace window. Nothing was stopped, and
    // the device ran on, ahead of the picture by the stall's length. Below
    // STALL_RESYNC_MS in total since the last anchor that is not felt and
    // nothing is sent; at it, ONE re-anchor play at the picture's time
    // (never a stop and a play). Only while our anchor is what the device is
    // running (its last request a play): a stall after a pause's stop, or
    // one a Resync stopped, needs the full play below.
    if (ep && !ep.held && !ep.seeked && !playOwed && this.handy.hsspMayBeRunning === true) {
      if (this._stallDriftSeq !== this._playSeq) {
        this._stallDriftMs = 0;
        this._stallDriftSeq = this._playSeq;
      }
      this._stallDriftMs += ep.lengthMs;
      if (this._stallDriftMs < STALL_RESYNC_MS) {
        this._logStall(ep, { reanchored: false, driftMs: this._stallDriftMs });
        return;
      }
      this._logStall(ep, { reanchored: true, driftMs: this._stallDriftMs });
      await this._reanchorAfterStall();
      return;
    }
    if (ep) this._logStall(ep, { reanchored: true, endedBy: 'playing' });

    // The play just sent already anchors this position (FN-01 follow-up,
    // verify-1 live): start() anchors a video already playing, and the
    // element's own 'playing' (or app.js's resync() right after start())
    // asked again a moment later at the same position, so every scripted
    // start sent two hsspPlay(0) ~230 ms apart. Nothing is sent and nothing
    // is cleared: that play's own handler arms the correction as usual.
    const timeMs = Math.round(this.player.currentTime * 1000);
    if (this._anchorCovers(timeMs)) {
      console.log(`[Sync] playing at ${timeMs}ms — the play just sent already anchors it, no second play`);
      return;
    }

    // Clear any pending second-play timer
    clearTimeout(this._playingTimer);

    const gen = ++this._playGen;
    const pauseGen = this._pauseGen;
    const seq = ++this._playSeq;
    console.log(`[Sync] hsspPlay at ${timeMs}ms`);
    const anchor = {
      seq, timeMs, at: this._now(), pauseGen, seekGen: this._seekGen, ok: null,
    };
    this._lastAnchor = anchor;
    anchor.ok = await this.handy.hsspPlay(timeMs);

    // A PAUSE landed while that cloud call was in flight. The device has now
    // been told to play AFTER we told it to stop, so the stop is lost and it
    // keeps going. Undo it rather than assume ordering.
    //
    // Checked against `_pauseGen`, not `_playGen`. Both are bumped here and
    // `_playGen` is also bumped by _handlePause, so a second PLAY arriving
    // close behind the first (the orgasm-switch restore does exactly this —
    // an explicit start() plus the element's own `playing` event, 1ms apart)
    // made the first call believe a pause had superseded it and send a stop
    // — silencing the device immediately after the newer play started it.
    // Seen on Dave's Handy, 2026-08-21.
    //
    // Not `this.player.paused` either: the element can still read paused at
    // the moment the `playing` handler runs, so checking it made every normal
    // play send a stop and never reach 'synced'. The suite caught that one.
    //
    // A stall's hold (N-01) bumps `_pauseGen` too, so a play that lands
    // after the picture froze undoes itself the same way.
    if (await this._restopIfSuperseded(pauseGen, seq)) return;

    // Superseded by a NEWER PLAY: that call owns the device now and has
    // already anchored it. Stand down without touching the device.
    if (gen !== this._playGen) {
      console.log('[Sync] play superseded by a newer play — standing down');
      return;
    }

    // Double-play pattern (matches SDK's setVideoPlayer behavior):
    // Send a second hsspPlay after a delay to correct for video startup
    // buffering. By this time the video's currentTime is more accurate.
    // Detached from any await chain (lives on a setTimeout), so we catch
    // internally — otherwise a network-level hsspPlay rejection would
    // surface as an unhandled promise rejection.
    this._playingTimer = setTimeout(async () => {
      // `_held` too (N-01): a correction fired into a stall restarted the
      // device on a frozen picture; so would one inside a stall's grace
      // window (FN-05), whose end re-anchors if the drift needs it.
      if (!this._active || this.player.paused || this._held || this._grace.open || !this.handy.connected) return;
      if (gen !== this._playGen) return;   // paused/replayed since we scheduled
      const correctedTimeMs = Math.round(this.player.currentTime * 1000);
      const correctionPauseGen = this._pauseGen;
      const correctionSeq = ++this._playSeq;
      console.log(`[Sync] correction hsspPlay at ${correctedTimeMs}ms`);
      try {
        await this.handy.hsspPlay(correctedTimeMs);
        await this._restopIfSuperseded(correctionPauseGen, correctionSeq);
      } catch (err) {
        console.warn(`[Sync] correction hsspPlay failed: ${err?.message || err}`);
      }
    }, this._secondPlayDelay);

    this._emitStatus('synced');
    this._startDriftMonitor();
  }

  async _handlePause() {
    if (!this._active) return;
    // A proxy reports a STALL as a 'pause' (the player pop-out, a headset):
    // it gets a stall's grace window, not a pause's instant stop (FN-05).
    if (isProxyStall(this.player.video)) return this._handleStall('proxy');
    // A real pause is instant and ends any stall window at once (FN-05).
    this._endStall('pause');
    if (!this.handy.connected) return;

    // Supersede any in-flight hsspPlay BEFORE stopping, so if one is still
    // travelling it re-sends the stop when it lands (see _handlePlaying).
    this._playGen++;
    this._pauseGen++;
    this._held = null;   // a pause owns the stopped device now
    clearTimeout(this._playingTimer);
    this._stopDriftMonitor();
    const stopped = await this.handy.hsspStop();
    // A stop that did not land means the device is very likely still running
    // its own cloud-scheduled playback while the app shows paused. The user
    // has to be told — they are the only one who can hit the button on the
    // device. Reported as "it just keeps playing the script" (Welliambrisk,
    // #328), which is unfalsifiable from the UI alone.
    if (stopped === false && this.onStopFailed) this.onStopFailed();
  }

  async _handleSeeked() {
    if (!this._active || !this._scriptReady || !this.handy.connected) return;

    clearTimeout(this._playingTimer);

    // Generation token: rapid back-to-back seeks (e.g. J/L key spam) kick
    // off multiple handlers in parallel. Without this, a slow Stop from an
    // earlier handler can resolve AFTER a newer handler's Play and silently
    // halt the device for up to ~2s until drift monitor corrects. Bump the
    // gen on entry; bail out after each await if we've been superseded.
    const gen = ++this._seekGen;
    this._progress.reset();
    // Any engine play sent from here on reads the position this seek landed
    // on (the element, or the proxy's seek(), has it before 'seeked' fires).
    const playSeqAtSeek = this._playSeq;

    // FN-05: the seek's own 'seeking' opened a stall's grace window and
    // nothing was stopped for it. A 'playing' still owed (a 'waiting' came,
    // a proxy's stall, or the element cannot move yet) sends the one play at
    // the new position; otherwise the seek is done inside the window: one
    // play here, and no stop.
    let doneInWindow = false;
    if (this._grace.open) {
      this._grace.note('seeked');
      const starved = isPictureStarved(this.player.video);
      if (starved) this._grace.note('waiting');
      if (starved || this._grace.reason === 'waiting' || this._grace.reason === 'proxy'
          || this.player.video?.stalled === true) {
        return;
      }
      this._logStall(this._grace.end(), { reanchored: !this.player.paused, endedBy: 'seeked' });
      doneInWindow = true;
    }

    // The player pop-out's proxy reads paused through a stall and owes a
    // 'playing' when the picture moves, as the inline element owes one after
    // its 'waiting': the stall's 'pause' has stopped the device, and that
    // 'playing' anchors it. A stop here only queued a cloud round trip in
    // front of that play (verify-1 2026-11-16, row P; new since v0.9.2).
    if (this.player.video?.stalled === true) return;

    // Stop still runs for every seek — the device should pause regardless
    // of which handler wins the race to restart.
    //
    // N-01: unless a hold already stopped it when the seek started (its
    // 'seeking' / 'waiting'), and nothing has played since (every play
    // clears `_held`). Before that the device stroked the OLD timeline under
    // the new frame for as long as the seek took (4.8 s on a slow source).
    // FN-05: nor a seek done inside its grace window (a play re-anchors a
    // running device at the new position on its own).
    const held = this._held;
    if (!held && !doneInWindow) {
      await this.handy.hsspStop();
      if (gen !== this._seekGen) return;
    }

    // The element said 'waiting' and owes a 'playing' when the new position
    // can play; that one anchors. Playing here too sent two plays 210 ms
    // apart on every seek while playing, the first of them (on a slow
    // source) to a picture that had not moved yet. A hold that arrived
    // during the stop above, or an error, is not ours to undo either.
    if (this._held === 'waiting' || this._held === 'error' || this._held !== held) return;

    // A play went out while the stop above travelled (the pop-out's stall
    // release, its take-over start): it has already anchored the device where
    // this seek landed. Playing again sent stop + play + play within 250 ms
    // (verify-1 2026-11-16, rows P and T; new since v0.9.2).
    if (this._playSeq !== playSeqAtSeek) return;

    if (!this.player.paused) {
      this._held = null;
      const pauseGen = this._pauseGen;
      const seq = ++this._playSeq;
      const timeMs = Math.round(this.player.currentTime * 1000);
      console.log(`[Sync] seeked → hsspPlay at ${timeMs}ms`);
      await this.handy.hsspPlay(timeMs);
      // A stop always wins over a late play: a pause or a hold that came in
      // while this play travelled has already sent its stop, which this play
      // may now have overtaken.
      if (await this._restopIfSuperseded(pauseGen, seq)) return;
      if (gen !== this._seekGen) return;
      if (held) this._startDriftMonitor();   // the hold stopped it
      this._emitStatus('synced');

      // Correction pass — mirrors _handlePlaying's double-play. A seek WHILE
      // PLAYING lands the device ~one hsspPlay round-trip behind (the video
      // keeps advancing during the ~100-200ms the Play takes to reach the
      // Handy). Re-anchor once the position has settled so the user doesn't
      // have to pause/play to fix it (community report: seek in pop-out / VR
      // left the Handy slightly out of sync until a manual pause+play).
      clearTimeout(this._playingTimer);
      this._playingTimer = setTimeout(async () => {
        // Not into a stall (N-01): the repro's seek correction went out with
        // the video at readyState 2. Nor into a grace window (FN-05).
        if (!this._active || this.player.paused || this._held || this._grace.open || !this.handy.connected) return;
        if (gen !== this._seekGen) return;
        const correctedTimeMs = Math.round(this.player.currentTime * 1000);
        const correctionPauseGen = this._pauseGen;
        const correctionSeq = ++this._playSeq;
        console.log(`[Sync] seek correction hsspPlay at ${correctedTimeMs}ms`);
        try {
          await this.handy.hsspPlay(correctedTimeMs);
          await this._restopIfSuperseded(correctionPauseGen, correctionSeq);
        } catch (err) {
          console.warn(`[Sync] seek correction hsspPlay failed: ${err?.message || err}`);
        }
      }, this._secondPlayDelay);
    }
  }

  async _handleEnded() {
    if (!this._active) return;
    this._endStall('ended');   // instant, ends any stall window (FN-05)
    if (!this.handy.connected) return;

    // Also a "should be stopped" intent, so an in-flight play undoes itself.
    this._playGen++;
    this._pauseGen++;
    this._held = null;
    clearTimeout(this._playingTimer);
    this._stopDriftMonitor();
    await this.handy.hsspStop();
  }

  /**
   * The picture stopped without a 'pause' (N-01). After the stall's grace
   * window (FN-05; at once for an error, a clock found frozen or a headset's
   * stall, which are past it when seen), hold the device exactly as a pause
   * would — the same generation bumps, so a play still in flight undoes
   * itself when it lands — and leave the restart to whatever ends the stall:
   * 'playing', a 'seeked' with no 'playing' owed, or the stall watch seeing
   * the clock move again. Inside the window nothing is sent.
   *
   * @param {'waiting'|'stalled'|'seeking'|'error'|'frozen'|'proxy'} reason
   */
  async _handleStall(reason) {
    if (!this._active) return;
    // A pause is _handlePause's; a proxy's stall reads paused too.
    if (reason !== 'proxy' && this.player.paused) return;
    if (reason === 'stalled') {
      // 'stalled' is about the NETWORK: the element may still be playing
      // from its buffer. Only a stall that has run out of frames holds, and
      // that one is a 'waiting' (the element owes a 'playing').
      if (!isPictureStarved(this.player.video)) return;
      reason = 'waiting';
    }
    if (this._held) {
      // Already holding. A 'waiting' after a 'seeking' (Chromium fires both
      // for every seek while playing) still tells us a 'playing' is coming.
      if (reason === 'waiting') this._held = 'waiting';
      this._grace.note(reason);
      return;
    }
    if (this._grace.open) {
      // Inside the window: note it ('waiting' promises a 'playing'). An
      // error, or the clock found frozen, does not wait the window out.
      this._grace.note(reason);
      if (reason === 'error' || reason === 'frozen') this._grace.expire();
      return;
    }
    const ageMs = reason === 'frozen' ? this._progress.frozenAfterMs
      : reason === 'proxy' ? proxyStallAgeMs(this.player.video) : 0;
    if (this._grace.begin(reason, { ageMs, instant: reason === 'error' })) return;
    await this._holdNow(reason);
  }

  /** The grace window ran out (its timer, or an error inside it). */
  _holdAfterGrace(reason) {
    if (!this._active) return;
    this._holdNow(reason).catch((err) => {
      console.warn(`[Sync] stall hold failed: ${err?.message || err}`);
    });
  }

  /** Hold the device for a stall past its window (N-01's hold). */
  async _holdNow(reason) {
    this._held = reason;
    this._playGen++;
    this._pauseGen++;
    clearTimeout(this._playingTimer);
    this._stopDriftMonitor();
    if (!this.handy.connected) return;

    const timeMs = Math.round((Number(this.player.currentTime) || 0) * 1000);
    // Nothing of ours is playing (the first frames of a video loading, or a
    // stall right after a pause's stop): a stop now would only queue a cloud
    // round trip in front of the play that 'playing' is about to send.
    if (this.handy.hsspMayBeRunning === false) {
      console.log(`[Sync] picture stopped (${reason}) at ${timeMs}ms — device already stopped`);
      return;
    }
    console.log(`[Sync] picture stopped (${reason}) at ${timeMs}ms — past the grace window, holding the device until it moves`);
    const stopped = await this.handy.hsspStop();
    // Same contract as a pause: false = the device may still be moving.
    if (stopped === false && this.onStopFailed) this.onStopFailed();
  }

  /**
   * FN-05: the hiccups ended inside their windows add up to STALL_RESYNC_MS
   * since the last anchor: ONE play at the picture's time re-anchors the
   * device (it is running, so no stop goes first). A fresh anchor, so the
   * total starts again; a stop that came in meanwhile still wins.
   */
  async _reanchorAfterStall() {
    clearTimeout(this._playingTimer);
    const gen = ++this._playGen;
    const pauseGen = this._pauseGen;
    const seq = ++this._playSeq;
    const timeMs = Math.round(this.player.currentTime * 1000);
    console.log(`[Sync] re-anchor for the drift of stalls inside their window → hsspPlay at ${timeMs}ms`);
    await this.handy.hsspPlay(timeMs);
    if (await this._restopIfSuperseded(pauseGen, seq)) return;
    if (gen !== this._playGen) return;
    this._emitStatus('synced');
  }

  /**
   * Whether the last anchor play `_handlePlaying` sent already covers a new
   * anchor at `timeMs` (FN-01 follow-up): no other play, pause, hold or seek
   * since, it has not failed, it is under ANCHOR_COVER_MS old, and the
   * device it started is where the picture is (its time plus the wall time
   * since, HSSP runs at 1x) within STALL_RESYNC_MS, the drift FN-05 already
   * treats as not felt. A picture that has not moved since (a start that
   * waited for its first frame) is behind by that wait, and gets the play.
   * @param {number} timeMs
   */
  _anchorCovers(timeMs) {
    const a = this._lastAnchor;
    if (!a || a.ok === false) return false;
    if (a.seq !== this._playSeq || a.pauseGen !== this._pauseGen || a.seekGen !== this._seekGen) return false;
    if (this.handy.hsspMayBeRunning !== true) return false;
    const age = this._now() - a.at;
    if (!(age >= 0 && age <= ANCHOR_COVER_MS)) return false;
    return Math.abs(timeMs - (a.timeMs + age)) <= STALL_RESYNC_MS;
  }

  /** End a stall (if any) without a play: a pause, an end, stop() (FN-05). */
  _endStall(endedBy) {
    this._stallPlayOwed = false;
    const ep = this._grace.end();
    if (ep) this._logStall(ep, { endedBy });
  }

  /** The one line a stall leaves (FN-05): length, held or not, re-anchored or not. */
  _logStall(ep, opts = {}) {
    if (!ep) return;
    console.log(`[Sync] ${stallSummary(ep, opts)}`);
  }

  /**
   * After an engine play has landed: if a pause, an end or a hold bumped
   * `_pauseGen` while it travelled, the stop they sent may have reached the
   * device BEFORE this play, so the play wins and the device carries on.
   * Undo it rather than assume ordering (x0193143 #288; Welliambrisk #328).
   *
   * ...but only while the device should still be stopped. A hold or pause
   * that is already OVER, with a newer play sent since (the stall's own
   * 'playing', the seeked play), has handed the device to that play: it
   * left after the stop and queues behind this one in the HSSP chain.
   * Re-stopping then dropped it ("hsspPlay dropped — superseded while
   * queued") and the device sat out the resume until the 2.5 s correction
   * (fix-up review 2026-11-16: 'play stop@800 stop@1500 play@4000' with the
   * picture moving from 1.2 s). With no newer play yet (a Play pressed but
   * no 'playing' so far) the stop still goes: nothing has re-anchored.
   *
   * @param {number} pauseGen — `_pauseGen` when the play was sent
   * @param {number} [seq] — `_playSeq` of that play
   * @returns {Promise<boolean>} true when the play was superseded (the stop
   *   re-sent, or a newer play owns the device): the caller stands down
   */
  async _restopIfSuperseded(pauseGen, seq) {
    if (pauseGen === this._pauseGen) return false;
    if (seq !== undefined && seq !== this._playSeq && !this._wantsDeviceStopped()) {
      console.log('[Sync] play superseded by a hold that is over — a newer play owns the device, no re-stop');
      return true;
    }
    console.log('[Sync] play superseded by a pause while in flight — re-sending stop');
    // Best-effort: a device that cannot be stopped is already the worse
    // problem, and throwing here would take the handler down with it.
    try {
      const stopped = await this.handy.hsspStop();
      // Same contract as _handlePause: an explicit false means the hardware
      // may still be moving, and the user is the only one who can act on it.
      // This branch used to swallow that, so a pause that arrived during a
      // slow play — exactly Welliambrisk's case — was the one pause that
      // could fail silently.
      if (stopped === false && this.onStopFailed) this.onStopFailed();
    } catch (err) {
      console.warn('[Sync] supersede stop failed:', err?.message || err);
      if (this.onStopFailed) this.onStopFailed();
    }
    return true;
  }

  /** Paused, ended, held on a stall or stopped: the device should stand. */
  _wantsDeviceStopped() {
    return !this._active || this._held !== null || !!this.player.paused
      || this.player.video?.ended === true;
  }

  // --- Stall watch (N-01) ---
  //
  // The backstop for a clock that stops with no event at all (a frozen
  // decoder, a window feeding a frozen time). setInterval, not rAF: rAF
  // stops in a hidden window, and a video can play on behind it.

  _startStallWatch() {
    if (this._stallTimer) return;
    this._progress.reset();
    // Called bare, never stored and called as a method: Chromium throws
    // "Illegal invocation" for a browser timer with a non-window receiver
    // (the HDSP engine was dead from v0.8.0 to v0.9.2 that way).
    this._stallTimer = setInterval(() => this._checkProgress(), this._stallPollMs);
  }

  _stopStallWatch() {
    if (this._stallTimer) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
    this._progress.reset();
  }

  _checkProgress() {
    if (!this._active) return;
    const paused = !!this.player.paused;
    const frozen = this._progress.sample(Number(this.player.currentTime), paused, this._now());
    if (paused || !this._scriptReady || !this.handy.connected) return;
    const onFail = (err) => console.warn(`[Sync] stall watch failed: ${err?.message || err}`);
    if (frozen && !this._held) {
      this._handleStall('frozen').catch(onFail);
    } else if (!frozen && this._held === 'frozen') {
      console.log('[Sync] picture moving again — re-anchoring');
      this._handlePlaying().catch(onFail);
    }
  }

  // --- Drift Monitoring ---

  _startDriftMonitor() {
    const check = () => {
      if (!this._active) return;

      const now = performance.now();
      // Check drift every 2 seconds
      if (now - this._lastCheckTime > 2000 && !this.player.paused && this._scriptReady) {
        this._lastCheckTime = now;
        this._checkDrift();
      }

      this._rafId = requestAnimationFrame(check);
    };

    this._rafId = requestAnimationFrame(check);
  }

  _stopDriftMonitor() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  async _checkDrift() {
    if (!this.handy.connected || !this.funscript.isLoaded) return;
    // N-01: no re-anchor into a frozen picture, held or inside its window (FN-05).
    if (this._held || this._grace.open) return;

    const syncQuality = this.handy.syncQuality;

    if (syncQuality && syncQuality.avgRtd > 200) {
      this._emitStatus('drifting');
      if (this.onDriftDetected) {
        this.onDriftDetected(syncQuality.avgRtd);
      }

      // Auto re-sync
      this._emitStatus('resyncing');
      await this.handy.syncTime(10); // Quick re-sync

      // Restart playback at current position.
      //
      // Re-checked after the stop, not just before it: `syncTime` and
      // `hsspStop` are both cloud round trips, and on a slow link they can
      // together span seconds during which the user pauses. Restarting then
      // means the drift monitor is the thing that resumes a paused device —
      // an app-generated play arriving after the user's stop, which is the
      // failure this whole pass is about.
      // `_held` (N-01): a stall that began during the time sync has stopped
      // the device; restarting it here would run it on a frozen picture.
      // Nor inside a stall's grace window (FN-05): its end re-anchors.
      if (!this.player.paused && !this._held && !this._grace.open) {
        const pauseGen = this._pauseGen;
        await this.handy.hsspStop();
        if (this.player.paused || this._held || this._grace.open || pauseGen !== this._pauseGen) {
          this._emitStatus('synced');
          return;
        }
        const timeMs = Math.round(this.player.currentTime * 1000);
        const seq = ++this._playSeq;
        await this.handy.hsspPlay(timeMs);
        await this._restopIfSuperseded(pauseGen, seq);
      }

      this._emitStatus('synced');
    }
  }

  _emitStatus(status) {
    if (this.onSyncStatus) {
      this.onSyncStatus(status);
    }
  }
}
