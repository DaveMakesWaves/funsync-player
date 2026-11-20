// AutoblowManager — Renderer-side wrapper for Autoblow Ultra / VacuGlide 2
// API calls proxied through main process via IPC (avoids SDK ESM issues)

import { t } from './i18n.js';
import { clampVideoSyncOffset, deviceOffsetWithVideoDelta } from './video-sync-offset.js';

export class AutoblowManager {
  /**
   * @param {object} [opts]
   * @param {() => ({globalMs: number, videoOffsetsInUse: boolean})} [opts.savedOffsetState]
   *   — app.js, read on every connect: the saved `autoblow.offset` (the
   *   slider can move while disconnected) and whether the library has
   *   per-video offsets (#380), so an earlier session may have left one on
   *   the device.
   */
  constructor({ savedOffsetState } = {}) {
    this._connected = false;
    this._deviceType = null; // 'autoblow-ultra' | 'vacuglide'
    this._deviceInfo = null;
    this._scriptUploaded = false;
    // Sync offset = the global `autoblow.offset` (syncOffset) with the
    // current video's own delta (setVideoOffset, #380) taken off, since
    // positive is earlier on the Autoblow (_sendOffset). 0 delta = as before.
    this._globalOffsetMs = null;
    this._videoOffsetMs = 0;
    // The delta inside the last offset sent: what the device holds on top
    // of the global, as far as this session knows. setVideoOffset compares
    // with this, not `_videoOffsetMs`, so a delta changed while
    // disconnected still reaches the device on the next connect.
    this._sentVideoOffsetMs = 0;
    this._savedOffsetState = typeof savedOffsetState === 'function' ? savedOffsetState : null;

    // Callbacks
    this.onConnect = null;
    this.onDisconnect = null;
    this.onError = null;
  }

  /**
   * Connect to an Autoblow device using its token.
   * @param {string} token — device token
   * @returns {boolean} success
   */
  async connect(token) {
    if (this._connected) await this.disconnect();

    try {
      const result = await window.funsync.autoblowConnect(token);
      if (result.success) {
        this._connected = true;
        this._deviceType = result.deviceType;
        this._deviceInfo = result.deviceInfo;
        this._scriptUploaded = false;
        console.log(`[Autoblow] Connected: ${this._deviceType}`);
        // Every connect sends the SAVED global `autoblow.offset` (read now:
        // the Autoblow tab only saves while disconnected) with this video's
        // delta, so the device runs at what the slider shows (FT-052,
        // 2026-11-06; also in v0.9.2). A connect used to send nothing unless
        // a per-video delta was in play, so the saved offset reached the
        // device only when the slider was moved while connected. The global
        // is sent as stored, as the slider does. Without a saved global
        // (no savedOffsetState and no syncOffset yet) it still sends when a
        // delta is or may be in play: this video has one, or the device was
        // last sent one (e.g. a disconnect on video A, B loaded meanwhile).
        let saved = null;
        try { saved = this._savedOffsetState?.() || null; } catch { /* never fails a connect */ }
        if (saved && Number.isFinite(Number(saved.globalMs))) this._globalOffsetMs = Number(saved.globalMs);
        if (this._globalOffsetMs !== null || this._videoOffsetMs !== 0 || this._sentVideoOffsetMs !== 0
            || saved?.videoOffsetsInUse === true) {
          this._sendOffset();
        }
        if (this.onConnect) this.onConnect();
        return true;
      } else {
        this._emitError(result.error || t('error.connectionFailed'));
        return false;
      }
    } catch (err) {
      this._emitError(err.message);
      return false;
    }
  }

  async disconnect() {
    try {
      await window.funsync.autoblowDisconnect();
    } catch (err) {
      console.warn('[Autoblow] Disconnect error:', err.message);
    }
    this._connected = false;
    this._deviceType = null;
    this._deviceInfo = null;
    this._scriptUploaded = false;
    if (this.onDisconnect) this.onDisconnect();
  }

  /**
   * Upload a funscript for sync playback.
   * @param {string} funscriptContent — raw JSON content
   * @returns {boolean} success
   */
  async uploadScript(funscriptContent) {
    if (!this._connected) return false;
    try {
      const result = await window.funsync.autoblowUploadScript(funscriptContent);
      if (result.success) {
        this._scriptUploaded = true;
        console.log('[Autoblow] Script uploaded');
        return true;
      }
      this._emitError(result.error || t('error.uploadFailed'));
      return false;
    } catch (err) {
      this._emitError(err.message);
      return false;
    }
  }

  /**
   * Start synced playback at the given time.
   * @param {number} startTimeMs
   */
  async syncStart(startTimeMs) {
    if (!this._connected || !this._scriptUploaded) return;
    try {
      await window.funsync.autoblowSyncStart(startTimeMs);
    } catch (err) {
      console.warn('[Autoblow] Sync start error:', err.message);
    }
  }

  /** Stop synced playback. */
  async syncStop() {
    if (!this._connected) return;
    try {
      await window.funsync.autoblowSyncStop();
    } catch (err) {
      console.warn('[Autoblow] Sync stop error:', err.message);
    }
  }

  /**
   * Set sync offset.
   * @param {number} offsetMs
   */
  async syncOffset(offsetMs) {
    // The GLOBAL offset; the device gets it plus this video's delta.
    this._globalOffsetMs = Number(offsetMs) || 0;
    if (!this._connected) return;
    await this._sendOffset();
  }

  /**
   * The playing video's own delta (Pudknocker #380) on top of the global
   * offset (`autoblow.offset`, passed as `globalMs`). Sends only when the
   * device does not already hold this delta, so a library without
   * per-video offsets sends nothing new. Disconnected, it is remembered
   * for the next connect.
   * @param {number} deltaMs
   * @param {number} [globalMs]
   */
  async setVideoOffset(deltaMs, globalMs) {
    if (globalMs != null && Number.isFinite(Number(globalMs))) this._globalOffsetMs = Number(globalMs);
    this._videoOffsetMs = clampVideoSyncOffset(deltaMs);
    if (!this._connected || this._videoOffsetMs === this._sentVideoOffsetMs) return;
    await this._sendOffset();
  }

  /**
   * Send the global with this video's delta, and remember the delta it
   * carried. The delta goes in negated (global - delta): the Autoblow adds
   * its offset to the script time, so positive is earlier there, while the
   * delta's negative is earlier on every device (video-sync-offset.js).
   */
  async _sendOffset() {
    const delta = this._videoOffsetMs;
    this._sentVideoOffsetMs = delta;
    try {
      await window.funsync.autoblowSyncOffset(deviceOffsetWithVideoDelta('autoblow', this._globalOffsetMs, delta));
    } catch (err) {
      console.warn('[Autoblow] Offset error:', err.message);
    }
  }

  /**
   * Estimate round-trip latency.
   * @returns {number} average latency in ms
   */
  async estimateLatency() {
    if (!this._connected) return 0;
    try {
      const result = await window.funsync.autoblowLatency();
      return result.success ? result.latency : 0;
    } catch {
      return 0;
    }
  }

  get connected() { return this._connected; }
  get deviceType() { return this._deviceType; }
  get deviceInfo() { return this._deviceInfo; }
  get scriptUploaded() { return this._scriptUploaded; }
  get isUltra() { return this._deviceType === 'autoblow-ultra'; }
  get isVacuglide() { return this._deviceType === 'vacuglide'; }

  _emitError(message) {
    console.error(`[AutoblowManager] ${message}`);
    if (this.onError) this.onError(message);
  }
}
