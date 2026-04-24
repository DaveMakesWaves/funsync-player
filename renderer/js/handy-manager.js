// HandyManager — Wrapper around @ohdoki/handy-sdk for device connection and control

// SDK module reference — loaded dynamically via relative path to the ESM bundle
// (bare specifier '@ohdoki/handy-sdk' fails in Electron renderer with contextIsolation)
let HandySDK = null;

export class HandyManager {
  constructor() {
    this._handy = null;
    this._connectionKey = '';
    this._connected = false;
    this._deviceInfo = null;
    this._syncQuality = null;
    this._lastCloudUrl = null; // last uploaded script URL (for re-setup after mode switch)

    // Cloud-reachability health check. The SDK's 'disconnect' event only
    // fires for client-side socket drops — it does NOT fire when the
    // physical Handy switches to BT mode (the SDK's HTTP session stays
    // alive, only the cloud → device path breaks). Without this poll,
    // `_connected` stayed `true` after a BT-mode switch and the UI kept
    // showing the WiFi connection as live alongside the newly-enumerated
    // Buttplug BT device.
    this._healthCheckInterval = null;
    this._healthCheckIntervalMs = 10000;

    // Callbacks
    this.onStateChange = null;   // (state) => {}
    this.onConnect = null;       // () => {}
    this.onDisconnect = null;    // () => {}
    this.onError = null;         // (error) => {}
  }

  /**
   * Initialize the Handy SDK. Must be called before any other method.
   */
  async init() {
    try {
      // Use relative path to the ESM bundle — bare specifiers don't work in browser context
      HandySDK = await import('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js');

      this._handy = HandySDK.init({
        syncClientServerTime: true,
        syncClient: { syncCount: 30, outliers: 10 },
        syncHandy: { syncCount: 30, outliers: 10 },
      });

      // Subscribe to state changes
      this._handy.on('state', ({ state, change }) => {
        if (this.onStateChange) this.onStateChange(state, change);
      });

      this._handy.on('connect', () => {
        this._connected = true;
        this._startHealthCheck();
        if (this.onConnect) this.onConnect();
      });

      this._handy.on('disconnect', () => {
        this._stopHealthCheck();
        this._connected = false;
        this._deviceInfo = null;
        if (this.onDisconnect) this.onDisconnect();
      });

      console.log('Handy SDK initialized');
    } catch (err) {
      console.warn('Failed to initialize Handy SDK:', err.message);
      throw err;
    }
  }

  /**
   * Connect to a Handy device using the connection key. One-shot —
   * callers who want retries should handle it themselves. We deliberately
   * don't retry in here because an offline Handy is almost always a
   * device-side or cloud-side issue (LED in wrong mode, WiFi creds stale,
   * handyfeeling down) that the app can't resolve by retrying harder.
   *
   * @param {string} connectionKey
   * @returns {boolean} True if connected successfully
   */
  async connect(connectionKey) {
    if (!this._handy) {
      this._emitError('SDK not initialized');
      return false;
    }

    this._connectionKey = connectionKey;

    try {
      const result = await this._handy.connect(connectionKey);
      // ConnectResult: 0 = NOT_CONNECTED, 1 = CONNECTED
      const code = typeof result === 'number' ? result : result?.result;
      if (code === 1) {
        this._connected = true;
        await this._fetchDeviceInfo();
        this._startHealthCheck();
        return true;
      } else {
        this._emitError('Connection failed — check your connection key');
        return false;
      }
    } catch (err) {
      this._emitError(`Connection error: ${err.message}`);
      return false;
    }
  }

  /**
   * Disconnect from the device.
   */
  async disconnect() {
    if (!this._handy) return;

    // Stop polling first so a tick mid-disconnect can't resurrect state.
    this._stopHealthCheck();

    try {
      await this._handy.disconnect();
    } catch (err) {
      console.warn('Disconnect error:', err.message);
    }
    this._connected = false;
    this._deviceInfo = null;
  }

  /**
   * Fetch device info (firmware, model, etc.)
   */
  async _fetchDeviceInfo() {
    try {
      const state = this._handy.getState();
      this._deviceInfo = state?.info || null;
    } catch (err) {
      console.warn('Failed to get device info:', err.message);
    }
  }

  /**
   * Run HSTP time synchronization.
   * @param {number} syncCount - Number of sync rounds (default 30)
   * @returns {Object|null} Sync result with RTD and offset
   */
  async syncTime(syncCount = 30) {
    if (!this._handy || !this._connected) return null;

    try {
      await this._handy.sync(
        { syncCount, outliers: Math.floor(syncCount / 3) },
        { syncCount, outliers: Math.floor(syncCount / 3) },
      );

      const latency = this._handy.getClientServerLatency();
      this._syncQuality = {
        avgOffset: latency?.avgOffset || 0,
        avgRtd: latency?.avgRtd || 0,
        lastSyncTime: latency?.lastSyncTime || Date.now(),
      };

      return this._syncQuality;
    } catch (err) {
      this._emitError(`Time sync failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Set up a script on the device from a URL.
   * @param {string} scriptUrl - URL to the CSV script (must be publicly accessible)
   * @returns {boolean} True if setup succeeded
   */
  async setupScript(scriptUrl) {
    if (!this._handy || !this._connected) return false;

    try {
      const result = await this._handy.setScript(scriptUrl);
      // HSSPSetupResult: 0 = USING_CACHED, 1 = DOWNLOADED
      return result?.result === 0 || result?.result === 1;
    } catch (err) {
      this._emitError(`Script setup failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Upload funscript data to handyfeeling.com and set it on the device.
   * Accepts raw funscript JSON string — the SDK converts to its own CSV format
   * (with proper header) and uploads to the cloud. Localhost URLs don't work
   * because the Handy downloads scripts via the cloud API.
   * @param {string} funscriptContent - Raw funscript JSON string
   * @returns {boolean} True if upload and setup succeeded
   */
  async uploadAndSetScript(funscriptContent) {
    if (!this._handy || !this._connected || !HandySDK) return false;

    try {
      // Pass raw funscript JSON to SDK — it handles conversion to CSV
      // (adds "#Created by Handy SDK v2" header) and uploads to handyfeeling.com
      const cloudUrl = await HandySDK.uploadDataToServer(funscriptContent);
      console.log('[Handy] Script uploaded to cloud:', cloudUrl);
      this._lastCloudUrl = cloudUrl;

      // Check device still connected after async upload
      if (!this._handy || !this._connected) return false;

      // setScript auto-switches to HSSP mode and sets the script on the device
      const result = await this._handy.setScript(cloudUrl);
      console.log('[Handy] setScript result:', JSON.stringify(result));
      const ok = result?.result === 0 || result?.result === 1;

      if (ok) {
        const state = this._handy.getState();
        console.log('[Handy] After setScript — mode:', state?.mode, 'scriptSet:', state?.hssp?.scriptSet);
      }

      return ok;
    } catch (err) {
      this._emitError(`Script upload failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Start HSSP playback at a given time position.
   * @param {number} startTimeMs - Video current time in milliseconds
   * @returns {boolean} True if play started
   */
  async hsspPlay(startTimeMs = 0) {
    if (!this._handy || !this._connected) return false;

    try {
      // Check SDK internal state before calling
      const state = this._handy.getState();
      console.log(`[Handy] hsspPlay(${startTimeMs}) — mode: ${state?.mode}, scriptSet: ${state?.hssp?.scriptSet}`);

      const est = HandySDK?.getEstimatedServerTime
        ? HandySDK.getEstimatedServerTime()
        : Date.now();
      const result = await this._handy.hsspPlay(startTimeMs, est);
      console.log('[Handy] hsspPlay result:', JSON.stringify(result));
      return result?.result === 0;
    } catch (err) {
      this._emitError(`HSSP play failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Stop HSSP playback.
   */
  async hsspStop() {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.hsspStop();
    } catch (err) {
      console.warn('HSSP stop error:', err.message);
    }
  }

  /**
   * Set HSTP offset (manual sync adjustment).
   * @param {number} offsetMs - Offset in milliseconds
   */
  async setOffset(offsetMs) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setOffset(offsetMs);
    } catch (err) {
      this._emitError(`Set offset failed: ${err.message}`);
    }
  }

  /**
   * Get current HSTP offset.
   * @returns {number} Offset in milliseconds
   */
  async getOffset() {
    if (!this._handy || !this._connected) return 0;

    try {
      const result = await this._handy.getOffset();
      return result?.offset || 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Set stroke zone (slide min/max).
   * @param {number} min - Minimum position (0–100)
   * @param {number} max - Maximum position (0–100)
   */
  async setStrokeZone(min, max) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setStrokeZone({ min, max });
    } catch (err) {
      this._emitError(`Set stroke zone failed: ${err.message}`);
    }
  }

  /**
   * Get current stroke zone.
   * @returns {{ min: number, max: number }|null}
   */
  async getStrokeZone() {
    if (!this._handy || !this._connected) return null;

    try {
      return await this._handy.getStrokeZone();
    } catch (err) {
      return null;
    }
  }

  /**
   * Set HSSP loop mode.
   * @param {boolean} loop
   */
  async setLoop(loop) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setHsspLoop(loop);
    } catch (err) {
      console.warn('Set loop failed:', err.message);
    }
  }

  /**
   * Start HAMP (manual alternating motion).
   * @param {number} velocity - Speed 0–100
   */
  async hampStart(velocity = 50) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setMode(0); // HAMP mode
      await this._handy.setHampVelocity(velocity);
      await this._handy.hampPlay();
    } catch (err) {
      this._emitError(`HAMP start failed: ${err.message}`);
    }
  }

  /**
   * Stop HAMP motion.
   */
  async hampStop() {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.hampStop();
    } catch (err) {
      console.warn('HAMP stop error:', err.message);
    }
  }

  /**
   * Set HAMP velocity.
   * @param {number} velocity - Speed 0–100
   */
  async setHampVelocity(velocity) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setHampVelocity(velocity);
    } catch (err) {
      console.warn('Set HAMP velocity error:', err.message);
    }
  }

  /**
   * Set HDSP (direct position) — move device to a specific position immediately.
   * Useful for scrub preview during seeking.
   * @param {number} position - Target position 0–100
   * @param {number} durationMs - Time to reach position in ms
   */
  async hdspMove(position, durationMs = 150) {
    if (!this._handy || !this._connected) return;

    try {
      // hdsp(position, speed, positionType, speedType, stopOnTarget, immediateResponse)
      await this._handy.hdsp(position, durationMs, 'percent', 'time', true, true);
    } catch (err) {
      // HDSP errors are non-critical, don't spam the user
      console.debug('HDSP move error:', err.message);
    }
  }

  // --- Cloud-reachability health check ---

  _startHealthCheck() {
    if (this._healthCheckInterval) return;
    this._healthCheckInterval = setInterval(
      () => this._healthCheckTick(),
      this._healthCheckIntervalMs,
    );
  }

  _stopHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /**
   * Ask the handyfeeling cloud whether the physical device is currently
   * reachable. Only flips state on an unambiguous `connected: false`.
   * Network errors are treated as transient — state is preserved so a
   * single flaky poll doesn't cause a spurious disconnect UI blip.
   */
  async _healthCheckTick() {
    if (!this._handy || !this._connected || !this._connectionKey) return;
    try {
      const resp = await this._handy.API?.get?.connected?.(this._connectionKey);
      if (resp && resp.connected === false) {
        console.log('[Handy] Cloud reports device unreachable — marking disconnected');
        this._handleDeviceLost();
      }
    } catch (err) {
      // Transient — log once per tick, don't touch state.
      console.debug('[Handy] Health check error:', err?.message || err);
    }
  }

  /**
   * Device is no longer reachable via WiFi (BT-mode switch, power off,
   * WiFi drop). Mirror the SDK's disconnect cleanup so every consumer
   * reading `handyManager.connected` updates immediately.
   */
  _handleDeviceLost() {
    this._stopHealthCheck();
    this._connected = false;
    this._deviceInfo = null;
    if (this.onDisconnect) this.onDisconnect();
  }

  // --- Getters ---

  get connected() {
    return this._connected;
  }

  get deviceInfo() {
    return this._deviceInfo;
  }

  get syncQuality() {
    return this._syncQuality;
  }

  get connectionKey() {
    return this._connectionKey;
  }

  // --- Internal ---

  _emitError(message) {
    console.error(`[HandyManager] ${message}`);
    if (this.onError) this.onError(message);
  }
}
