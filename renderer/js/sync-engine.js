// SyncEngine — Coordinate video playback with Handy device

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

    // Callbacks
    this.onDriftDetected = null;  // (driftMs) => {}
    this.onSyncStatus = null;    // (status: 'synced'|'drifting'|'resyncing') => {}
  }

  /**
   * Start the sync engine. Call after both video and funscript are loaded
   * and the device is connected with a script set up.
   */
  start() {
    if (this._active) return;

    this._active = true;
    this._bindVideoEvents();

    // If video is already playing, sync immediately.
    //
    // Not awaited (start() is sync), so it MUST carry its own catch: this one
    // is not reached through the guarded event listeners, and a rejection
    // inside it has no owner. It broke CI rather than the app — vitest fails
    // the run on an unhandled rejection while Node only warns (2026-08-21).
    if (!this.player.paused) {
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
    await this._handlePlaying();
    return true;
  }

  /**
   * Stop the sync engine.
   */
  stop() {
    this._active = false;
    this._unbindVideoEvents();
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

  async _handlePlaying() {
    if (!this._active || !this._scriptReady || !this.handy.connected) return;

    // Clear any pending second-play timer
    clearTimeout(this._playingTimer);

    const gen = ++this._playGen;
    const pauseGen = this._pauseGen;
    const timeMs = Math.round(this.player.currentTime * 1000);
    console.log(`[Sync] hsspPlay at ${timeMs}ms`);
    await this.handy.hsspPlay(timeMs);

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
    if (pauseGen !== this._pauseGen) {
      console.log('[Sync] play superseded by a pause while in flight — re-sending stop');
      // Best-effort: a device that cannot be stopped is already the worse
      // problem, and throwing here would take the handler down with it.
      try {
        await this.handy.hsspStop();
      } catch (err) {
        console.warn('[Sync] supersede stop failed:', err?.message || err);
      }
      return;
    }

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
      if (!this._active || this.player.paused || !this.handy.connected) return;
      if (gen !== this._playGen) return;   // paused/replayed since we scheduled
      const correctedTimeMs = Math.round(this.player.currentTime * 1000);
      console.log(`[Sync] correction hsspPlay at ${correctedTimeMs}ms`);
      try {
        await this.handy.hsspPlay(correctedTimeMs);
      } catch (err) {
        console.warn(`[Sync] correction hsspPlay failed: ${err?.message || err}`);
      }
    }, this._secondPlayDelay);

    this._emitStatus('synced');
    this._startDriftMonitor();
  }

  async _handlePause() {
    if (!this._active || !this.handy.connected) return;

    // Supersede any in-flight hsspPlay BEFORE stopping, so if one is still
    // travelling it re-sends the stop when it lands (see _handlePlaying).
    this._playGen++;
    this._pauseGen++;
    clearTimeout(this._playingTimer);
    this._stopDriftMonitor();
    await this.handy.hsspStop();
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

    // Stop still runs for every seek — the device should pause regardless
    // of which handler wins the race to restart.
    await this.handy.hsspStop();
    if (gen !== this._seekGen) return;

    if (!this.player.paused) {
      const timeMs = Math.round(this.player.currentTime * 1000);
      console.log(`[Sync] seeked → hsspPlay at ${timeMs}ms`);
      await this.handy.hsspPlay(timeMs);
      if (gen !== this._seekGen) return;
      this._emitStatus('synced');

      // Correction pass — mirrors _handlePlaying's double-play. A seek WHILE
      // PLAYING lands the device ~one hsspPlay round-trip behind (the video
      // keeps advancing during the ~100-200ms the Play takes to reach the
      // Handy). Re-anchor once the position has settled so the user doesn't
      // have to pause/play to fix it (community report: seek in pop-out / VR
      // left the Handy slightly out of sync until a manual pause+play).
      clearTimeout(this._playingTimer);
      this._playingTimer = setTimeout(async () => {
        if (!this._active || this.player.paused || !this.handy.connected) return;
        if (gen !== this._seekGen) return;
        const correctedTimeMs = Math.round(this.player.currentTime * 1000);
        console.log(`[Sync] seek correction hsspPlay at ${correctedTimeMs}ms`);
        try {
          await this.handy.hsspPlay(correctedTimeMs);
        } catch (err) {
          console.warn(`[Sync] seek correction hsspPlay failed: ${err?.message || err}`);
        }
      }, this._secondPlayDelay);
    }
  }

  async _handleEnded() {
    if (!this._active || !this.handy.connected) return;

    // Also a "should be stopped" intent, so an in-flight play undoes itself.
    this._playGen++;
    this._pauseGen++;
    clearTimeout(this._playingTimer);
    this._stopDriftMonitor();
    await this.handy.hsspStop();
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

    const syncQuality = this.handy.syncQuality;

    if (syncQuality && syncQuality.avgRtd > 200) {
      this._emitStatus('drifting');
      if (this.onDriftDetected) {
        this.onDriftDetected(syncQuality.avgRtd);
      }

      // Auto re-sync
      this._emitStatus('resyncing');
      await this.handy.syncTime(10); // Quick re-sync

      // Restart playback at current position
      if (!this.player.paused) {
        await this.handy.hsspStop();
        const timeMs = Math.round(this.player.currentTime * 1000);
        await this.handy.hsspPlay(timeMs);
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
