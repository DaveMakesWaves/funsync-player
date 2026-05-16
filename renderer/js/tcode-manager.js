// TCodeManager — Serial connection + TCode v0.3 protocol for OSR2/SR6 devices
// Communicates via IPC to main process serialport instance

const TCODE_VALUE_MAX = 999; // TCode range 0-999 (0.000-0.999)

export class TCodeManager {
  constructor() {
    this._connected = false;
    this._portPath = '';
    this._baudRate = 115200;
    this._disconnectCleanup = null;

    // Callbacks
    this.onConnect = null;
    this.onDisconnect = null;
    this.onError = null;
  }

  /**
   * List available serial ports.
   * @returns {Promise<Array<{path: string, manufacturer: string}>>}
   */
  async listPorts() {
    try {
      return await window.funsync.tcodeListPorts();
    } catch (err) {
      console.warn('[TCode] Failed to list ports:', err.message);
      return [];
    }
  }

  /**
   * Connect to a TCode device. Supports three transports — the call shape
   * differs by which one the user picked in the connection panel.
   *
   *   serial   → connect('serial', { path: 'COM3', baudRate: 115200 })
   *   udp      → connect('udp',    { host: '192.168.1.42', port: 8080 })
   *   websocket→ connect('ws',     { url: 'ws://192.168.1.42:81' })
   *
   * Back-compat: `connect(portPath, baudRate)` (two strings/numbers) still
   * routes to serial — preserves the original call sites and any saved
   * scripts that hardcoded the old signature.
   *
   * @returns {boolean} success
   */
  async connect(kindOrPath, optsOrBaud = {}) {
    if (this._connected) await this.disconnect();

    // Normalise the two call shapes into a single { kind, opts } pair so
    // the IPC payload + downstream state writes stay uniform.
    let kind;
    let opts;
    const isLegacyCall = typeof kindOrPath === 'string'
      && kindOrPath !== 'serial' && kindOrPath !== 'udp'
      && kindOrPath !== 'websocket' && kindOrPath !== 'ws';
    if (isLegacyCall) {
      kind = 'serial';
      opts = { path: kindOrPath, baudRate: typeof optsOrBaud === 'number' ? optsOrBaud : 115200 };
    } else {
      kind = kindOrPath;
      opts = optsOrBaud && typeof optsOrBaud === 'object' ? optsOrBaud : {};
    }

    this._transportKind = kind;
    this._transportOpts = opts;
    // Retain legacy fields for the connection panel's reconnect-on-error
    // helper, which still reads _portPath / _baudRate. Empty when not serial.
    this._portPath = kind === 'serial' ? (opts.path || '') : '';
    this._baudRate = kind === 'serial' ? (opts.baudRate || 115200) : 0;

    try {
      const result = await window.funsync.tcodeConnect(kind, opts);
      if (result.success) {
        this._connected = true;

        // Listen for unexpected disconnects from main process
        this._disconnectCleanup = window.funsync.onTcodeDisconnected(() => {
          this._connected = false;
          if (this.onDisconnect) this.onDisconnect();
        });

        const summary = this._describeTransport(kind, opts);
        console.log(`[TCode] Connected via ${kind}: ${summary}`);
        if (this.onConnect) this.onConnect();
        return true;
      } else {
        this._emitError(`Connection failed: ${result.error}`);
        return false;
      }
    } catch (err) {
      this._emitError(`Connection error: ${err.message}`);
      return false;
    }
  }

  /** Render a one-liner summary of the transport (for logs/UI). Pure. */
  _describeTransport(kind, opts) {
    if (kind === 'serial') return `${opts.path || '?'} @ ${opts.baudRate || 115200}`;
    if (kind === 'udp') return `${opts.host || '?'}:${opts.port || '?'}`;
    if (kind === 'websocket' || kind === 'ws') return opts.url || '?';
    return JSON.stringify(opts);
  }

  /**
   * Disconnect from the serial port.
   */
  async disconnect() {
    if (this._disconnectCleanup) {
      this._disconnectCleanup();
      this._disconnectCleanup = null;
    }

    try {
      await window.funsync.tcodeDisconnect();
    } catch (err) {
      console.warn('[TCode] Disconnect error:', err.message);
    }

    this._connected = false;
  }

  /**
   * Send a raw TCode command string.
   * @param {string} command — e.g. 'L0500 R0750\n'
   */
  async send(command) {
    if (!this._connected) return false;
    try {
      return await window.funsync.tcodeSend(command);
    } catch {
      return false;
    }
  }

  /**
   * Send multi-axis position values as a single TCode command.
   * Only sends axes that have changed since last call.
   *
   * @param {Object} axisValues — e.g. { L0: 50, R0: 75, V0: 30 }
   * @param {number} [durationMs] — optional interval for timed moves (I suffix)
   */
  sendAxes(axisValues, durationMs) {
    if (!this._connected || !axisValues) return;

    const parts = [];
    for (const [axis, value] of Object.entries(axisValues)) {
      const tcodeVal = Math.round(Math.max(0, Math.min(100, value)) / 100 * TCODE_VALUE_MAX);
      const valStr = String(tcodeVal).padStart(3, '0');
      let cmd = `${axis}${valStr}`;
      if (durationMs && durationMs > 0) {
        cmd += `I${Math.round(durationMs)}`;
      }
      parts.push(cmd);
    }

    if (parts.length > 0) {
      this.send(parts.join(' ') + '\n');
    }
  }

  /**
   * Stop all axes (send to neutral position 500 = 50%).
   */
  stop() {
    if (!this._connected) return;
    this.send('DSTOP\n');
  }

  get connected() { return this._connected; }
  get portPath() { return this._portPath; }
  get baudRate() { return this._baudRate; }

  _emitError(message) {
    console.error(`[TCodeManager] ${message}`);
    if (this.onError) this.onError(message);
  }
}
