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

    // If video is already playing, sync immediately
    if (!this.player.paused) {
      this._handlePlaying();
    }

    console.log('Sync engine started');
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

    const timeMs = Math.round(this.player.currentTime * 1000);
    console.log(`[Sync] hsspPlay at ${timeMs}ms`);
    await this.handy.hsspPlay(timeMs);

    // Double-play pattern (matches SDK's setVideoPlayer behavior):
    // Send a second hsspPlay after a delay to correct for video startup
    // buffering. By this time the video's currentTime is more accurate.
    // Detached from any await chain (lives on a setTimeout), so we catch
    // internally — otherwise a network-level hsspPlay rejection would
    // surface as an unhandled promise rejection.
    this._playingTimer = setTimeout(async () => {
      if (!this._active || this.player.paused || !this.handy.connected) return;
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
    }
  }

  async _handleEnded() {
    if (!this._active || !this.handy.connected) return;

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
