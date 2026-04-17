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
    // 'play' fires when play is requested (might still be buffering)
    this._onPlaying = () => this._handlePlaying();
    this._onPause = () => this._handlePause();
    this._onSeeked = () => this._handleSeeked();
    this._onEnded = () => this._handleEnded();

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
    // Send a second hsspPlay after a delay to correct for video startup buffering.
    // By this time the video's currentTime is more accurate.
    this._playingTimer = setTimeout(async () => {
      if (!this._active || this.player.paused || !this.handy.connected) return;
      const correctedTimeMs = Math.round(this.player.currentTime * 1000);
      console.log(`[Sync] correction hsspPlay at ${correctedTimeMs}ms`);
      await this.handy.hsspPlay(correctedTimeMs);
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

    // Stop then restart at new position
    await this.handy.hsspStop();

    if (!this.player.paused) {
      const timeMs = Math.round(this.player.currentTime * 1000);
      console.log(`[Sync] seeked → hsspPlay at ${timeMs}ms`);
      await this.handy.hsspPlay(timeMs);
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
