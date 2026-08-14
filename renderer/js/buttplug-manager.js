// ButtplugManager — Wrapper around buttplug.io v4 client for Intiface Central device control
// Connects as a WebSocket client to a running Intiface Central instance
//
// v4 API: capabilities checked via device.hasOutput('Vibrate'), commands sent via
// device.runOutput(DeviceOutput.Vibrate.percent(0.3))

let ButtplugSDK = null;

// Send-path results.
//
// Every send* used to swallow its own error into a warning and return
// undefined, so a CALLER could not tell "command delivered" from "command
// threw". That is how a Hismith can sit inert while the device test reports
// success (adventurous1, thread #274) — the same shape as the e-stim bug: a
// real failure dressed up as a working device.
//
// The sync loop still ignores these. It must never throw mid-tick, and a
// per-tick failure is already rate-limited by _warnOnce. The device TEST
// checks them, so "test passed" now means the hardware was really commanded.
const SENT = { ok: true };
const NOT_CONNECTED = { ok: false, error: 'device not connected' };
const failed = (err) => ({ ok: false, error: err?.message || String(err) });

/**
 * Coerce an arbitrary thrown value into a user-readable string.
 *
 * The WebSocket-backed Buttplug client rejects with a browser Event
 * (open/error) when the connection refuses — Intiface not running,
 * wrong port, blocked by firewall. Event objects have no `.message`
 * or `.reason`, so the previous `String(err)` produced the infamous
 * `[object Event]` user-visible status string.
 *
 * Order of preference:
 *   1. Real Error / SDK rejection → `.message`
 *   2. WebSocket close info → `.reason` (when set by Intiface)
 *   3. DOM Event → user-friendly hint (Intiface likely not running)
 *   4. Anything else → cautious `String(err)`, but only if it doesn't
 *      stringify to `[object Object]` / `[object Event]`.
 */
export function _describeError(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  if (typeof err.reason === 'string' && err.reason) return err.reason;
  // DOM Event (WebSocket open/error) — no useful properties surface
  // through stringification. The dominant cause for Buttplug is
  // "Intiface Central isn't running on this port"; surface that
  // instead of the JS coercion artifact.
  const isEvent = (typeof Event !== 'undefined' && err instanceof Event)
    || typeof err.type === 'string';
  if (isEvent) {
    return 'Intiface Central is not reachable on this port — start Intiface and try again.';
  }
  const s = String(err);
  // Final defense: never return a useless `[object ...]` artifact.
  if (s.startsWith('[object ')) return 'Unknown error';
  return s;
}

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
    // Keys already warned about, so a failure inside a 20Hz send loop is
    // reported once rather than thousands of times. Cleared on disconnect
    // so a reconnect re-reports a still-broken device.
    this._warnedKeys = new Set();

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
        const info = this._serializeDevice(device);
        // ALWAYS log what a device advertises, not only when nothing matched.
        //
        // Previously the only device log was the "no recognised capabilities"
        // warning, so a device that WAS recognised but still did not move
        // left no trace at all — and a user reporting "it sees my machine
        // but won't control it" could not be diagnosed from their log
        // (adventurous1, thread #274, took three round trips). One line per
        // device at connect makes the next report answerable immediately.
        console.log(
          `[Buttplug] Device added: "${device.name}" (index ${device.index}) ` +
          `outputs=[${this._describeOutputs(device).join(', ') || 'none'}] ` +
          `routed as: ${[
            info.canLinear && 'linear',
            info.canOscillate && 'oscillate',
            info.canVibrate && 'vibrate',
            info.canRotate && 'rotate',
            info.canScalar && 'scalar',
          ].filter(Boolean).join('+') || 'NOTHING'}`
        );
        if (this.onDeviceAdded) this.onDeviceAdded(info);
      });

      this._client.addListener('deviceremoved', (device) => {
        this._devices.delete(device.index);
        if (this.onDeviceRemoved) this.onDeviceRemoved(this._serializeDevice(device));
      });

      this._client.addListener('disconnect', () => {
        this._connected = false;
        this._devices.clear();
        this._warnedKeys.clear();
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
      this._emitError(`Connection failed: ${_describeError(err)}`);
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
        this._emitError(`Scan failed: ${_describeError(err)}`);
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
    if (!device || !ButtplugSDK) return NOT_CONNECTED;

    const pct = Math.max(0, Math.min(1, intensity / 100));

    try {
      const cmd = ButtplugSDK.DeviceOutput.Vibrate.percent(pct);
      await device.runOutput(cmd);
      return SENT;
    } catch (err) {
      this._warnOnce(
        `send-vibrate-${deviceIndex}`,
        `[Buttplug] Vibrate command to "${device.name}" failed: ${err?.message || err}`
      );
      return failed(err);
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
    if (!device || !ButtplugSDK) return NOT_CONNECTED;

    const pct = Math.max(0, Math.min(1, position / 100));
    const dur = Math.max(50, Math.round(durationMs));

    try {
      const cmd = ButtplugSDK.DeviceOutput.PositionWithDuration.percent(pct, dur);
      await device.runOutput(cmd);
      return SENT;
    } catch (err) {
      this._warnOnce(
        `send-linear-${deviceIndex}`,
        `[Buttplug] Linear command to "${device.name}" failed: ${err?.message || err}`
      );
      return failed(err);
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
    if (!device || !ButtplugSDK) return NOT_CONNECTED;

    const pct = Math.max(0, Math.min(1, speed / 100));

    try {
      const cmd = ButtplugSDK.DeviceOutput.Rotate.percent(pct, clockwise);
      await device.runOutput(cmd);
      return SENT;
    } catch (err) {
      this._warnOnce(
        `send-rotate-${deviceIndex}`,
        `[Buttplug] Rotate command to "${device.name}" failed: ${err?.message || err}`
      );
      return failed(err);
    }
  }

  /**
   * Send an oscillation (speed) command to a flywheel machine
   * (v4: DeviceOutput.Oscillate.percent).
   *
   * The value is a SPEED, not a position — the machine's stroke length is
   * fixed. Callers must derive it from stroke rate, not pass a raw script
   * position; see ButtplugSync's oscillate dispatch.
   *
   * @param {number} deviceIndex — device index
   * @param {number} speed — 0–100 (funscript scale)
   */
  async sendOscillate(deviceIndex, speed) {
    const device = this._devices.get(deviceIndex);
    if (!device || !ButtplugSDK) return NOT_CONNECTED;

    const pct = Math.max(0, Math.min(1, speed / 100));

    try {
      const cmd = ButtplugSDK.DeviceOutput.Oscillate.percent(pct);
      await device.runOutput(cmd);
      return SENT;
    } catch (err) {
      this._warnOnce(
        `send-oscillate-${deviceIndex}`,
        `[Buttplug] Oscillate command to "${device.name}" failed: ${err?.message || err}`
      );
      return failed(err);
    }
  }

  /**
   * Spin a flywheel machine briefly, hard enough that it actually turns.
   *
   * The old test sent a flat 20% and was documented as "enough to prove
   * routing without spinning a flywheel up" — which is self-defeating. A
   * fuck machine has real stiction; below roughly a third power it does not
   * start at all. So the test proved nothing and looked identical to a
   * broken device (adventurous1, thread #274: "does not control and test
   * does not work either"). A vibrator at 20% is a clear buzz; a Hismith at
   * 20% is silence.
   *
   * Ramped rather than slammed: a machine jumping straight to full is
   * alarming, and a ramp also demonstrates that speed *changes* land, not
   * just that one command did.
   *
   * @param {number} deviceIndex
   * @param {number} [cap] — user's safety cap 0-100; never exceeded
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async testOscillate(deviceIndex, cap = 100) {
    const ceiling = Math.max(0, Math.min(100, cap));
    // Below this a flywheel generally will not break stiction, so a "test"
    // that stays under it cannot answer the question being asked.
    const peak = Math.min(65, ceiling);
    const steps = [Math.min(45, ceiling), peak, peak];

    let last = SENT;
    try {
      for (const speed of steps) {
        last = await this.sendOscillate(deviceIndex, speed);
        if (last && last.ok === false) return last;
        await new Promise((r) => setTimeout(r, 350));
      }
      return await this.sendOscillate(deviceIndex, 0);
    } finally {
      // Never leave a machine running because the test threw part-way.
      this.sendOscillate(deviceIndex, 0);
    }
  }

  /**
   * Resolve which CONCRETE scalar output type a device actually exposes.
   *
   * There is no `Scalar` output type in buttplug-js v4 — the enum is
   * Vibrate / Rotate / Oscillate / Constrict / Inflate / Position /
   * HwPositionWithDuration / Temperature / Spray / Led. `DeviceOutput.Scalar`
   * is therefore `undefined`, and reading `.percent()` off it throws.
   * Callers must send the specific type the hardware advertises.
   *
   * @param {object} device
   * @returns {'Constrict'|'Inflate'|null}
   */
  _scalarOutputType(device) {
    for (const type of ['Constrict', 'Inflate']) {
      try {
        if (device.hasOutput(type)) return type;
      } catch { /* probe failure — try the next type */ }
    }
    return null;
  }

  /**
   * Log a message once per key, so an error inside a 20Hz send loop surfaces
   * without flooding the log.
   * @param {string} key
   * @param {string} message
   */
  _warnOnce(key, message) {
    if (this._warnedKeys.has(key)) return;
    this._warnedKeys.add(key);
    console.warn(message);
  }

  /**
   * Send a scalar command to a device.
   * Used for e-stim (DG-LAB Coyote, MK-312BT, ET-312), inflate, constrict, etc.
   *
   * Sends the concrete output type the device advertises (Constrict or
   * Inflate). Until 2026-08-06 this sent `DeviceOutput.Scalar`, which does
   * not exist in v4 — every call threw a TypeError that was swallowed into
   * console.debug, so e-stim devices connected, appeared routed in the UI,
   * and silently did nothing.
   *
   * @param {number} deviceIndex — device index
   * @param {number} intensity — scalar intensity 0–100 (funscript scale)
   */
  async sendScalar(deviceIndex, intensity) {
    const device = this._devices.get(deviceIndex);
    if (!device || !ButtplugSDK) return NOT_CONNECTED;

    const type = this._scalarOutputType(device);
    if (!type) {
      this._warnOnce(
        `scalar-type-${deviceIndex}`,
        `[Buttplug] Device "${device.name}" is flagged as scalar-capable but ` +
        `exposes neither Constrict nor Inflate. Scalar commands cannot be sent.`
      );
      return { ok: false, error: 'no concrete scalar output type' };
    }

    const pct = Math.max(0, Math.min(1, intensity / 100));

    try {
      const cmd = ButtplugSDK.DeviceOutput[type].percent(pct);
      await device.runOutput(cmd);
      return SENT;
    } catch (err) {
      // Warn (not debug) and once per device: a silent failure here is
      // indistinguishable from a device that simply isn't responding.
      this._warnOnce(
        `scalar-send-${deviceIndex}`,
        `[Buttplug] ${type} command to "${device.name}" failed: ${err?.message || err}`
      );
      return failed(err);
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
      // Not once-guarded and not debug: a failed stop means the device is
      // STILL RUNNING. Every occurrence matters, and console.debug is not
      // forwarded to main.log, so a swallowed one leaves no trace at all.
      console.error(
        `[Buttplug] STOP FAILED for "${device.name}" (index ${deviceIndex}) — ` +
        `device may still be running: ${err?.message || err}`
      );
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
      // See stopDevice: never swallowed. If this fails, every connected
      // device is potentially still running — including a flywheel machine.
      console.error(
        `[Buttplug] STOP-ALL FAILED — devices may still be running: ${err?.message || err}`
      );
    }
  }

  /**
   * Zero every SUSTAINED-OUTPUT actuator, leaving linear position alone.
   *
   * The distinction is the whole point. A linear device parked at its last
   * position is inert — it simply sits there. A vibrate / rotate / oscillate
   * / e-stim actuator holding its last value keeps *acting on* it, because
   * for those "send nothing" means "carry on as you were".
   *
   * Needed on Orgasm Switch release (Dave, 2026-08-14): releasing the hotkey
   * restarts the main sync engines, which re-anchor "on their next tick" —
   * true only where the script has content. Land in an unscripted zone and
   * the tick hits `nextIdx >= actions.length` or `duration > MAX_GAP_MS`,
   * both bare returns, so nothing is commanded and the finisher's last value
   * stays on the device. The finisher holds HIGH values, so it stays running
   * hard with nothing on screen to explain it.
   *
   * Why not `stopAll()`: that also zeroes linear, which would snap strokers
   * to 0 on every release even mid-scripted-section.
   *
   * @returns {Promise<void>}
   */
  async stopSustainedOutputs() {
    if (!this._client || !this._connected) return;
    await Promise.all(this.devices.map(async (dev) => {
      // Deliberately NOT gated on `canLinear` being false — hardware that is
      // both (some Lovense) still needs its motor silenced while keeping its
      // position untouched.
      if (dev.canVibrate) await this.sendVibrate(dev.index, 0);
      if (dev.canOscillate) await this.sendOscillate(dev.index, 0);
      if (dev.canRotate) await this.sendRotate(dev.index, 0, true);
      if (dev.canScalar) await this.sendScalar(dev.index, 0);
    }));
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
  /**
   * Every output type a device actually advertises.
   *
   * `OutputType` in buttplug-js v4 is a STRING enum and `hasOutput` does
   * `Output.hasOwnProperty(type)`, so probing by string is correct — worth
   * stating because "maybe it wants the enum object" is the obvious wrong
   * theory when a device reports nothing.
   *
   * @returns {string[]}
   */
  _describeOutputs(device) {
    const ALL_TYPES = [
      'Vibrate', 'Rotate', 'Oscillate', 'Constrict', 'Inflate',
      'Position', 'HwPositionWithDuration', 'Temperature', 'Spray', 'Led',
    ];
    return ALL_TYPES.filter((t) => {
      try { return !!device.hasOutput(t); } catch { return false; }
    });
  }

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
    // Flywheel "fuck machines" (Hismith, Auxfun, some Lovense) expose
    // Oscillate: a scalar SPEED, not a position. Stroke length is
    // mechanically fixed, so this is the only controllable quantity.
    // Detected but never routed until 2026-08-06 — the device connected
    // and sat inert, which is what the community report was.
    const canOscillate = probe('Oscillate');
    // Scalar umbrella. NOTE: v4 has no `Scalar` output type at all — the
    // enum is Vibrate / Rotate / Oscillate / Constrict / Inflate / Position /
    // HwPositionWithDuration / Temperature / Spray / Led. `probe('Scalar')`
    // is therefore always false; it stays only as a forward-guard in case a
    // driver ever advertises it. The real detection is Constrict / Inflate.
    // sendScalar() resolves the concrete type — it must never send `Scalar`.
    const canScalar = probe('Scalar') || probe('Constrict') || probe('Inflate');

    // Diagnostic — when a device connects but no known capability matches,
    // dump the set of output types it actually exposes so we can add the
    // mapping without guessing. Catches driver renames + new device types.
    if (!canVibrate && !canLinear && !canRotate && !canScalar && !canOscillate) {
      const present = this._describeOutputs(device);
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
      canOscillate,
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
      if (info.canVibrate || info.canLinear || info.canScalar || info.canRotate
          || info.canOscillate) return device.index;
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
      } else {
        // Community report (NylonBorg, via TODO.md backlog): the
        // original setTimeout did NOT recurse on failure, so
        // `_maxReconnectAttempts = 3` was effectively dead — only
        // one attempt ever ran. Now we chain through the full
        // backoff series until the configured max.
        this._attemptReconnect();
      }
    }, delay);
  }

  _emitError(message) {
    console.error(`[ButtplugManager] ${message}`);
    if (this.onError) this.onError(message);
  }
}
