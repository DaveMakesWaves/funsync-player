// AutoblowSync — Sync engine for Autoblow Ultra / VacuGlide 2
// Both device types support script upload + sync playback (like Handy HSSP).
// Mirrors SyncEngine architecture: video events → API calls.

export class AutoblowSync {
  /**
   * @param {object} opts
   * @param {import('./video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('./autoblow-manager.js').AutoblowManager} opts.autoblowManager
   */
  constructor({ videoPlayer, autoblowManager }) {
    this.player = videoPlayer;
    this.autoblow = autoblowManager;
    this._active = false;
    this._scriptReady = false;

    // Callbacks
    this.onSyncStatus = null;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._bindVideoEvents();

    if (!this.player.paused && this._scriptReady) {
      const timeMs = this.player.currentTime * 1000;
      this.autoblow.syncStart(timeMs);
      this._emitStatus('synced');
    }

    console.log('[AutoblowSync] Started');
  }

  stop() {
    this._active = false;
    this._scriptReady = false;
    this._unbindVideoEvents();
    this.autoblow.syncStop();
    this._emitStatus('idle');
    console.log('[AutoblowSync] Stopped');
  }

  /**
   * Upload a funscript and mark as ready for sync.
   * @param {string} funscriptContent — raw JSON
   * @returns {boolean} success
   */
  async uploadScript(funscriptContent) {
    const ok = await this.autoblow.uploadScript(funscriptContent);
    this._scriptReady = ok;
    return ok;
  }

  get scriptReady() { return this._scriptReady; }

  // --- Video event wiring ---

  _bindVideoEvents() {
    const v = this.player.video;
    this._onPlaying = () => this._handlePlaying();
    this._onPause = () => this._handlePause();
    this._onSeeked = () => this._handleSeeked();
    this._onEnded = () => this._handleEnded();
    v.addEventListener('playing', this._onPlaying);
    v.addEventListener('pause', this._onPause);
    v.addEventListener('seeked', this._onSeeked);
    v.addEventListener('ended', this._onEnded);
  }

  _unbindVideoEvents() {
    const v = this.player.video;
    if (this._onPlaying) v.removeEventListener('playing', this._onPlaying);
    if (this._onPause) v.removeEventListener('pause', this._onPause);
    if (this._onSeeked) v.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) v.removeEventListener('ended', this._onEnded);
  }

  _handlePlaying() {
    if (!this._active || !this._scriptReady) return;
    const timeMs = this.player.currentTime * 1000;
    this.autoblow.syncStart(timeMs);
    this._emitStatus('synced');
  }

  _handlePause() {
    if (!this._active) return;
    this.autoblow.syncStop();
    this._emitStatus('idle');
  }

  async _handleSeeked() {
    if (!this._active || !this._scriptReady) return;
    if (this.player.paused) return;
    // Stop then restart at new position (awaited to avoid race)
    await this.autoblow.syncStop();
    const timeMs = this.player.currentTime * 1000;
    this.autoblow.syncStart(timeMs);
  }

  _handleEnded() {
    if (!this._active) return;
    this.autoblow.syncStop();
    this._emitStatus('idle');
  }

  _emitStatus(status) {
    if (this.onSyncStatus) this.onSyncStatus(status);
  }
}
