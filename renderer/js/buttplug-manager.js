// ButtplugManager — Wrapper around buttplug.io v4 client for Intiface Central device control
// Connects as a WebSocket client to a running Intiface Central instance
//
// v4 API: capabilities checked via device.hasOutput('Vibrate'), commands sent via
// device.runOutput(DeviceOutput.Vibrate.percent(0.3))

let ButtplugSDK = null;

export class ButtplugManager {
  constructor() {
    this._client = null;
    this._connector = null;
    this._devices = new Map(); // deviceIndex → ButtplugClientDevice
    this._connected = false;
    this._port = 12345;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 3;
    this._connecting = false;

    // Callbacks
    this.onConnect = null;      // () => {}
    this.onDisconnect = null;   // () => {}
    this.onDeviceAdded = null;  // (device) => {}
    this.onDeviceRemoved = null; // (device) => {}
    this.onError = null;        // (message) => {}
  }

  /**
   * Initialize the Buttplug SDK. Must be called before any other method.
   */
  async init() {
    try {
      ButtplugSDK = await import('../../node_modules/buttplug/dist/web/buttplug.mjs');
      console.log('Buttplug SDK loaded');
    } catch (err) {
      console.warn('Failed to load Buttplug SDK:', err.message);
      throw err;
    }
  }

  /**
   * Connect to Intiface Central via WebSocket.
   * @param {number} [port=12345] — Intiface WebSocket port
   * @returns {boolean} True if connected
   */
  async connect(port) {
    if (!ButtplugSDK) {
      this._emitError('SDK not initialized');
      return false;
    }

    if (this._connecting) return false;

    if (this._connected) {
      await this.disconnect();
    }

    this._connecting = true;
    this._port = port || this._port;

    try {
      this._client = new ButtplugSDK.ButtplugClient('FunSync Player');

      // Wire device events
      this._client.addListener('deviceadded', (device) => {
        this._devices.set(device.index, device);
        if (this.onDeviceAdded) this.onDeviceAdded(this._serializeDevice(device));
      });

      this._client.addListener('deviceremoved', (device) => {
        this._devices.delete(device.index);
        if (this.onDeviceRemoved) this.onDeviceRemoved(this._serializeDevice(device));
      });

      this._client.addListener('disconnect', () => {
        this._connected = false;
        this._devices.clear();
        if (this.onDisconnect) this.onDisconnect();
        // Auto-reconnect with exponential backoff
        this._attemptReconnect();
      });

      this._connector = new ButtplugSDK.ButtplugBrowserWebsocketClientConnector(
        `ws://127.0.0.1:${this._port}`,
      );

      await this._client.connect(this._connector);
      this._connected = true;
      this._connecting = false;
      this._reconnectAttempts = 0;

      if (this.onConnect) this.onConnect();
      console.log(`[Buttplug] Connected to Intiface on port ${this._port}`);
      return true;
    } catch (err) {
      this._connected = false;
      this._connecting = false;
      const msg = err?.message || err?.reason || String(err);
      this._emitError(`Connection failed: ${msg}`);
      return false;
    }
  }

  /**
   * Disconnect from Intiface Central.
   */
  async disconnect() {
    if (!this._client) return;

    this._intentionalDisconnect = true; // suppress auto-reconnect

    try {
      await this._client.disconnect();
    } catch (err) {
      console.warn('[Buttplug] Disconnect error:', err.message);
    }

    this._connected = false;
    this._devices.clear();
    this._client = null;
    this._connector = null;
  }

  /**
   * Start scanning for devices.
   */
  async startScanning() {
    if (!this._client || !this._connected) return;

    try {
      await this._client.startScanning();
    } catch (err) {
      if (!err.message?.includes('already')) {
        this._emitError(`Scan failed: ${err.message}`);
      }
    }
  }

  /**
   * Stop scanning for devices.
   */
  async stopScanning() {
    if (!this._client || !this._connected) return;

    try {
      await this._client.stopScanning();
    } catch (err) {
      console.debug('[Buttplug] Stop scan:', err.message);
    }
  }

  /**
   * Send a vibrate command to a device (v4: DeviceOutput.Vibrate.percent).
   * @param {number} deviceIndex — device index
   * @param {number} intensity — vibration intensity 0–100 (funscript scale)
   */
  async sendVibrate(deviceIndex, intensity) {
    const device = this._devices.get(deviceIndex);
    if (!device || !ButtplugSDK) return;

    const pct = Math.max(0, Math.min(1, intensity / 100));

    try {
      const cmd = ButtplugSDK.DeviceOutput.Vibrate.percent(pct);
      await device.runOutput(cmd);
    } catch (err) {
      console.debug('[Buttplug] Vibrate error:', err?.message || err);
    }
  }

  /**
   * Send a linear/position command to a device (v4: DeviceOutput.PositionWithDuration.percent).
   * @param {number} deviceIndex — device index
   * @param {number} position — target position 0–100 (funscript scale)
   * @param {number} durationMs — time to reach position in ms
   */
  async sendLinear(deviceIndex, position, durationMs) {
    const device = this._devices.get(deviceIndex);
    if (!device || !ButtplugSDK) return;

    const pct = Math.max(0, Math.min(1, position / 100));
    const dur = Math.max(50, Math.round(durationMs));

    try {
      const cmd = ButtplugSDK.DeviceOutput.PositionWithDuration.percent(pct, dur);
      await device.runOutput(cmd);
    } catch (err) {
      console.debug('[Buttplug] Linear error:', err?.message || err);
    }
  }

  /**
   * Send a rotate command to a device (v4: DeviceOutput.Rotate.percent).
   * @param {number} deviceIndex — device index
   * @param {number} speed — rotation speed 0–100 (funscript scale)
   * @param {boolean} [clockwise=true] — rotation direction
   */
  async sendRotate(deviceIndex, speed, clockwise = true) {
    const device = this._devices.get(deviceIndex);
    if (!device || !ButtplugSDK) return;

    const pct = Math.max(0, Math.min(1, speed / 100));

    try {
      const cmd = ButtplugSDK.DeviceOutput.Rotate.percent(pct, clockwise);
      await device.runOutput(cmd);
    } catch (err) {
      console.debug('[Buttplug] Rotate error:', err?.message || err);
    }
  }

  /**
   * Send a scalar command to a device (v4: DeviceOutput.Scalar).
   * Used for e-stim (DG-LAB Coyote, MK-312BT, ET-312), inflate, constrict, etc.
   * @param {number} deviceIndex — device index
   * @param {number} intensity — scalar intensity 0–100 (funscript scale)
   */
  async sendScalar(deviceIndex, intensity) {
    const device = this._devices.get(deviceIndex);
    if (!device || !ButtplugSDK) return;

    const pct = Math.max(0, Math.min(1, intensity / 100));

    try {
      const cmd = ButtplugSDK.DeviceOutput.Scalar.percent(pct);
      await device.runOutput(cmd);
    } catch (err) {
      console.debug('[Buttplug] Scalar error:', err?.message || err);
    }
  }

  /**
   * Stop a specific device.
   * @param {number} deviceIndex
   */
  async stopDevice(deviceIndex) {
    const device = this._devices.get(deviceIndex);
    if (!device) return;

    try {
      await device.stop();
    } catch (err) {
      console.debug('[Buttplug] Stop device error:', err?.message || err);
    }
  }

  /**
   * Stop all devices.
   */
  async stopAll() {
    if (!this._client || !this._connected) return;

    try {
      await this._client.stopAllDevices();
    } catch (err) {
      console.debug('[Buttplug] StopAll error:', err?.message || err);
    }
  }

  /**
   * Serialize a ButtplugClientDevice for UI display.
   * v4 API: capabilities checked via device.hasOutput(OutputType).
   *
   * The OutputType enum in buttplug-js v4 is: Vibrate, Rotate, Oscillate,
   * Constrict, Inflate, Position, HwPositionWithDuration, Temperature,
   * Spray, Led. Different device drivers expose different output types
   * for the same physical function — e.g. the FW4+ Handy driver in
   * Intiface advertises HwPositionWithDuration (used by timed linear
   * commands) but not the step-based Position. We accept both so the
   * device is correctly flagged as linear.
   *
   * @param {object} device
   * @returns {object}
   */
  _serializeDevice(device) {
    const probe = (type) => {
      try { return !!device.hasOutput(type); } catch (e) { return false; }
    };

    const canVibrate = probe('Vibrate');
    // Linear: our sendLinear sends HwPositionWithDuration; some drivers
    // only expose plain Position (step-based). Accept either so the
    // device is routable through L0 / the main stroke axis.
    const canLinear = probe('HwPositionWithDuration') || probe('Position');
    const canRotate = probe('Rotate');
    // Scalar umbrella: older buttplug had a unified Scalar type; v4 split
    // it into Constrict / Inflate / Vibrate. Keep the legacy name check
    // for backward compat and also accept Constrict/Inflate so e-stim +
    // inflation devices keep getting picked up.
    const canScalar = probe('Scalar') || probe('Constrict') || probe('Inflate');

    // Diagnostic — when a device connects but no known capability matches,
    // dump the set of output types it actually exposes so we can add the
    // mapping without guessing. Catches driver renames + new device types.
    if (!canVibrate && !canLinear && !canRotate && !canScalar) {
      const ALL_TYPES = [
        'Vibrate', 'Rotate', 'Oscillate', 'Constrict', 'Inflate',
        'Position', 'HwPositionWithDuration', 'Temperature', 'Spray', 'Led',
      ];
      const present = ALL_TYPES.filter(probe);
      console.warn(
        `[Buttplug] Device "${device.name}" reports no recognised capabilities. ` +
        `Actual outputs: [${present.join(', ') || 'none'}]. ` +
        `Commands will not be routed to it.`
      );
    }

    return {
      index: device.index,
      name: device.name,
      canVibrate,
      canLinear,
      canRotate,
      canScalar,
    };
  }

  // --- Getters ---

  get connected() { return this._connected; }
  get port() { return this._port; }

  /** Get all connected devices as serialized objects. */
  get devices() {
    const result = [];
    for (const device of this._devices.values()) {
      result.push(this._serializeDevice(device));
    }
    return result;
  }

  /**
   * Get the first device with vibrate or linear capability.
   * @returns {number|null} device index, or null if none found
   */
  get primaryDevice() {
    for (const device of this._devices.values()) {
      const info = this._serializeDevice(device);
      if (info.canVibrate || info.canLinear || info.canScalar || info.canRotate) return device.index;
    }
    return null;
  }

  // --- Internal ---

  _attemptReconnect() {
    if (this._intentionalDisconnect) {
      this._intentionalDisconnect = false;
      return;
    }
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.log('[Buttplug] Max reconnect attempts reached');
      this._reconnectAttempts = 0;
      return;
    }

    this._reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(2, this._reconnectAttempts - 1), 10000);
    console.log(`[Buttplug] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);

    setTimeout(async () => {
      if (this._connected) return; // already reconnected
      const success = await this.connect(this._port);
      if (success) {
        console.log('[Buttplug] Reconnected successfully');
        this._reconnectAttempts = 0;
        // Re-scan for devices
        try { await this.startScanning(); } catch {}
      }
    }, delay);
  }

  _emitError(message) {
    console.error(`[ButtplugManager] ${message}`);
    if (this.onError) this.onError(message);
  }
}
