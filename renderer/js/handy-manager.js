// HandyManager — Wrapper around @ohdoki/handy-sdk for device connection and control

import { t } from './i18n.js';

// SDK module reference — loaded dynamically via relative path to the ESM bundle
// (bare specifier '@ohdoki/handy-sdk' fails in Electron renderer with contextIsolation)
let HandySDK = null;

/** Mask a connection key for logging — keys are passwords and logs get
 *  shared when users report problems. Last 4 chars only. */
function maskKey(k) {
  const s = String(k || '');
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

export class HandyManager {
  constructor() {
    this._handy = null;
    this._connectionKey = '';
    this._connected = false;
    this._deviceInfo = null;
    this._syncQuality = null;
    this._lastCloudUrl = null; // last uploaded script URL (for re-setup after mode switch)
    // Tracks the device's current SDK mode (0=HAMP, 1=HSSP, 2=HDSP) so hdspMove
    // can lazily switch INTO HDSP before its first send. Without this, driving
    // HDSP straight after an hsspStop (e.g. the Orgasm Switch) left the device
    // in HSSP mode with the HDSP commands ignored — "it just stops the device".
    this._mode = null;
    this._hdspErrorLogged = false;

    // --- HSSP call serialisation ---------------------------------------
    //
    // Every HSSP call is a cloud round trip taking 200-750ms. Mashing X and Z
    // fires an engage/release pair per press, so a few quick presses put
    // several of them in flight at once — and under that pile-up the cloud
    // started returning "Device timeout", after which the device had lost its
    // mode setup and stopped following the video (Dave, 2026-08-21).
    //
    // One at a time, in order. The device has a single state machine and there
    // is no version of "two overlapping mode-setup calls" that is coherent.
    this._hsspChain = Promise.resolve();
    // Bumped by every enqueue. A queued PLAY whose generation is stale by the
    // time it reaches the front is pointless — a newer play or a stop has
    // already superseded it — so it is dropped rather than sent. Stops are
    // never dropped: skipping one leaves the device running.
    this._hsspGen = 0;

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

    console.log(`[Handy] connect(${maskKey(connectionKey)}) — requesting…`);
    try {
      const result = await this._handy.connect(connectionKey);
      // ConnectResult: 0 = NOT_CONNECTED, 1 = CONNECTED
      const code = typeof result === 'number' ? result : result?.result;
      console.log(`[Handy] connect result code: ${code} (1 = connected, 0 = not connected)`);
      if (code === 1) {
        this._connected = true;
        await this._fetchDeviceInfo();
        this._startHealthCheck();
        console.log('[Handy] connected — device reachable via cloud');
        return true;
      } else {
        this._emitError(t('error.handyConnectionFailed'));
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
  /**
   * Run an HSSP operation with no other HSSP operation in flight.
   *
   * @param {'play'|'stop'|'setup'} kind — 'play' may be dropped when stale
   * @param {() => Promise<any>} fn
   * @param {any} skipValue — returned if the call is dropped as superseded
   */
  _hsspExclusive(kind, fn, skipValue) {
    const gen = ++this._hsspGen;
    const run = this._hsspChain.then(async () => {
      // Only a play is safe to drop: a stop that never runs leaves hardware
      // moving, and a setup that never runs leaves the device unusable.
      if (kind === 'play' && gen !== this._hsspGen) {
        console.log(`[Handy] hsspPlay dropped — superseded while queued`);
        return skipValue;
      }
      return fn();
    });
    // Keep the chain alive even when a link rejects, or one failure would
    // wedge every later HSSP call in this session.
    this._hsspChain = run.then(() => {}, () => {});
    return run;
  }

  async setupScript(scriptUrl) {
    return this._hsspExclusive('setup', () => this._setupScriptImpl(scriptUrl), false);
  }

  async _setupScriptImpl(scriptUrl) {
    if (!this._handy || !this._connected) return false;

    try {
      const result = await this._handy.setScript(scriptUrl);
      // HSSPSetupResult: 0 = USING_CACHED, 1 = DOWNLOADED
      const ok = result?.result === 0 || result?.result === 1;
      if (ok) this._mode = 1; // setScript auto-switches the device to HSSP mode
      return ok;
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
        this._mode = 1; // setScript auto-switches the device to HSSP mode
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
   * Upload funscript JSON to the cloud and return its URL WITHOUT setting it on
   * the device (so it doesn't disturb the currently-playing main script). Used
   * to pre-cache the Orgasm Switch's finisher script, which is then set + looped
   * via HSSP on activate. Returns null on failure.
   * @param {string} funscriptContent - Raw funscript JSON string
   * @returns {Promise<string|null>}
   */
  async uploadScriptOnly(funscriptContent) {
    if (!this._connected || !HandySDK?.uploadDataToServer) return null;
    try {
      return await HandySDK.uploadDataToServer(funscriptContent);
    } catch (err) {
      console.warn('[Handy] Orgasm script upload failed:', err.message);
      return null;
    }
  }

  /**
   * Start HSSP playback at a given time position.
   * @param {number} startTimeMs - Video current time in milliseconds
   * @returns {boolean} True if play started
   */
  async hsspPlay(startTimeMs = 0) {
    return this._hsspExclusive('play', () => this._hsspPlayImpl(startTimeMs), false);
  }

  async _hsspPlayImpl(startTimeMs = 0) {
    if (!this._handy || !this._connected) return false;

    const est = HandySDK?.getEstimatedServerTime
      ? HandySDK.getEstimatedServerTime()
      : Date.now();

    try {
      // Check SDK internal state before calling
      const state = this._handy.getState();
      console.log(`[Handy] hsspPlay(${startTimeMs}) — mode: ${state?.mode}, scriptSet: ${state?.hssp?.scriptSet}`);

      const result = await this._handy.hsspPlay(startTimeMs, est);
      console.log('[Handy] hsspPlay result:', JSON.stringify(result));
      return result?.result === 0;
    } catch (err) {
      // Self-heal: HDSP (Orgasm Switch, scrub preview) clears HSSP's scriptSet,
      // so resuming can fail with "Script set is required". Re-set the cached
      // cloud script and retry once — this is the reliable fix for the device
      // going silent after the Orgasm Switch releases.
      // Two different messages mean the same thing — the device no longer has
      // HSSP set up and needs setScript again:
      //   "Script set is required"                        (HDSP cleared it)
      //   "Illegal state. Mode specific setup required first."
      // The second showed up when Dave mashed X and Z: the stacked engage /
      // release cycles timed out against the cloud and left the device
      // without its mode setup, and because only the first message was
      // matched, nothing re-established it — the Handy stopped following the
      // video until the video was reloaded (2026-08-21).
      if (/script\s*set\s*is\s*required|mode\s*specific\s*setup\s*required/i.test(err?.message || '')
          && this._lastCloudUrl) {
        console.warn('[Handy] hsspPlay: HSSP setup lost — re-setting cached script and retrying');
        try {
          const r = await this._handy.setScript(this._lastCloudUrl);
          if (r?.result === 0 || r?.result === 1) {
            this._mode = 1;
            const result = await this._handy.hsspPlay(startTimeMs, est);
            console.log('[Handy] hsspPlay retry result:', JSON.stringify(result));
            return result?.result === 0;
          }
        } catch (err2) {
          this._mode = null;   // stop claiming a mode the device does not have
          this._emitError(`HSSP re-setScript+play failed: ${err2.message}`);
          return false;
        }
      }
      // Drop the mode cache on ANY failure. It exists to keep steady-state
      // ticks cheap, and holding a stale `_mode = 1` after an error is how the
      // device stays dead: every later call skips the re-setup it needs.
      this._mode = null;
      this._emitError(`HSSP play failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Stop HSSP playback.
   */
  async hsspStop() {
    return this._hsspExclusive('stop', () => this._hsspStopImpl(), undefined);
  }

  async _hsspStopImpl() {
    if (!this._handy || !this._connected) return;

    // Logged both sides, like hsspPlay. Until 2026-08-16 a successful stop
    // logged NOTHING, so x0193143's report (#288, "Handy keeps working ~15s
    // after pause") could not be diagnosed from his log: the plays were
    // visible with call and result timestamps, the stops were invisible, and
    // the whole bug was about the ORDER the two arrived in.
    console.log('[Handy] hsspStop — requesting…');
    try {
      const res = await this._handy.hsspStop();
      console.log(`[Handy] hsspStop result: ${JSON.stringify(res ?? null)}`);
    } catch (err) {
      // Same reasoning as hsspPlay: a failed stop means the device is not in
      // the state we think it is, so the cache has to go or the next play
      // will skip its setup.
      this._mode = null;
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
      this._mode = 0;
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
   * Explicitly switch the device into HDSP mode (2) and remember it. Used to
   * SEQUENCE the HSSP→HDSP handoff for the Orgasm Switch: await hsspStop, THEN
   * await enterHdsp, THEN start driving. Without this ordering an un-awaited
   * hsspStop could land after the first hdsp and silently re-stop the device
   * (and the _mode cache would then skip re-switching, so it stays dead).
   * @returns {boolean} true if the mode switch succeeded
   */
  async enterHdsp() {
    if (!this._handy || !this._connected) return false;
    try {
      await this._handy.setMode(2);
      this._mode = 2;
      console.log('[Handy] Entered HDSP mode (2)');
      return true;
    } catch (err) {
      this._mode = null;
      console.warn('[Handy] enterHdsp (setMode 2) failed:', err.message);
      return false;
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
      // Ensure the device is actually in HDSP mode (2) before sending. The SDK
      // does NOT reliably auto-switch when we come straight from a stopped-HSSP
      // state, so an explicit, awaited setMode is required — otherwise the hdsp
      // commands are ignored and the device just sits stopped. Only switched on
      // a real transition (tracked by _mode), so steady-state ticks stay cheap.
      if (this._mode !== 2) {
        await this._handy.setMode(2);
        this._mode = 2;
      }
      // hdsp(position, speed, positionType, speedType, stopOnTarget, immediateResponse)
      await this._handy.hdsp(position, durationMs, 'percent', 'time', true, true);
      this._hdspErrorLogged = false;
    } catch (err) {
      // Force a mode re-check next tick. Log once per failure streak at WARN so
      // it reaches the log file (renderer console is forwarded; debug is not) —
      // this path was previously undiagnosable when it silently failed.
      this._mode = null;
      if (!this._hdspErrorLogged) {
        console.warn('[Handy] HDSP move failed (device may not have entered HDSP mode):', err.message);
        this._hdspErrorLogged = true;
      }
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
