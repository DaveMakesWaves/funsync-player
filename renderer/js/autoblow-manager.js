// AutoblowManager — Renderer-side wrapper for Autoblow Ultra / VacuGlide 2
// API calls proxied through main process via IPC (avoids SDK ESM issues)

export class AutoblowManager {
  constructor() {
    this._connected = false;
    this._deviceType = null; // 'autoblow-ultra' | 'vacuglide'
    this._deviceInfo = null;
    this._scriptUploaded = false;

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
        if (this.onConnect) this.onConnect();
        return true;
      } else {
        this._emitError(result.error || 'Connection failed');
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
      this._emitError(result.error || 'Upload failed');
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
    if (!this._connected) return;
    try {
      await window.funsync.autoblowSyncOffset(offsetMs);
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
