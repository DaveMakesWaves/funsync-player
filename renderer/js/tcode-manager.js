// TCodeManager — Serial / UDP / WebSocket TCode protocol for OSR2/SR6 devices
// and MFP-protocol consumers (restim etc.). Communicates via IPC to main
// process transports.
//
// Precision: TCode-0.2 emits 3-digit values (0-999 → 0.000-0.999), TCode-0.3
// emits 4-digit (0-9999 → 0.0000-0.9999). Configurable per-session via
// `setPrecision(3 | 4)` because target devices vary — restim accepts either
// but TCode-0.3-only firmware (newer OSR2+/SR6 builds) needs 4-digit, and
// some MFP-compatible consumers infer the version from digit count.

const PRECISION_LIMITS = { 3: 999, 4: 9999 };

// How long a stop's rest frame (UDP / WebSocket) takes to bring the position
// axes to the middle: the same as the Go home button (tcode-sync.js
// GO_HOME_MOVE_MS), slow enough for L0 and every rotation across half their
// travel at once.
export const REST_MOVE_MS = 2000;

export class TCodeManager {
  constructor() {
    this._connected = false;
    this._transportKind = null; // 'serial' | 'udp' | 'websocket' — set on connect()
    this._portPath = '';
    this._baudRate = 115200;
    this._disconnectCleanup = null;
    this._precision = 3;       // digits per axis value
    this._valueMax = 999;      // derived from precision

    // Where each axis was last sent, to estimate where it is now (a move
    // after a jump eases from there, jump-ease.js; Eroto #423).
    // axis -> { from, to, at, ms }: moving from `from` to `to` over `ms`
    // from `at` (performance.now). ms 0 = a bare frame (as fast as it goes).
    this._axisMoves = new Map();

    // Callbacks
    this.onConnect = null;
    this.onDisconnect = null;
    this.onError = null;
  }

  /**
   * Where an axis is now, estimated from the commands sent to it (0-100), or
   * null when nothing has moved it since connecting. A timed move is taken
   * to go in a straight line over its interval, as T-Code firmware does.
   * @param {string} axis e.g. 'L0'
   * @param {number} [now] performance.now()
   * @returns {number|null}
   */
  estimatePosition(axis, now = performance.now()) {
    const m = this._axisMoves.get(axis);
    if (!m) return null;
    if (!(m.ms > 0)) return m.to;
    const f = Math.min(1, Math.max(0, (now - m.at) / m.ms));
    return m.from + (m.to - m.from) * f;
  }

  /** Record a move sent to an axis (for estimatePosition). */
  _recordMove(axis, to, ms, now = performance.now()) {
    const from = this.estimatePosition(axis, now);
    this._axisMoves.set(axis, { from: from ?? to, to, at: now, ms: ms > 0 ? ms : 0 });
  }

  /**
   * Set the TCode value-precision (3 = TCode-0.2, 4 = TCode-0.3). Default
   * is 3-digit. Setting an unknown precision is a no-op; the manager
   * stays at its current setting. Persisted by the connection-panel UI
   * via `tcode.precision`.
   */
  setPrecision(digits) {
    if (PRECISION_LIMITS[digits] == null) return;
    this._precision = digits;
    this._valueMax = PRECISION_LIMITS[digits];
  }

  get precision() { return this._precision; }

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
          const wasConnected = this._connected;
          this._connected = false;
          if (wasConnected && this.onDisconnect) this.onDisconnect(); // once per link
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
   * Where the link goes, for logs: `COM3 @ 115200 baud`, `192.168.1.42:8000`
   * or the WebSocket URL. Empty before the first connect.
   */
  get endpointSummary() {
    if (!this._transportKind) return '';
    const summary = this._describeTransport(this._transportKind, this._transportOpts || {});
    return this._transportKind === 'serial' ? `${summary} baud` : summary;
  }

  /** The endpoint alone (the device's label): COM port, host:port or URL. */
  get endpoint() {
    const opts = this._transportOpts || {};
    if (this._transportKind === 'udp') return `${opts.host || '?'}:${opts.port || '?'}`;
    if (this._transportKind === 'websocket' || this._transportKind === 'ws') return opts.url || '?';
    return this._portPath;
  }

  /**
   * Disconnect (any transport). A user disconnect is a disconnect: when the
   * link was up, `onDisconnect` fires exactly as it does for a dropped link,
   * so the app stops the sync engine and the nav bar stops saying
   * "Connected" (CB-15: it never fired here, and both stayed as they were).
   * Once: the dropped-link listener is removed first, and `_connected` drops
   * before the await, so a second call or a late main-process notice does
   * not fire it again.
   */
  async disconnect() {
    const wasConnected = this._connected;
    this._connected = false;
    // The device may be moved or re-homed before the next connect.
    this._axisMoves.clear();
    if (this._disconnectCleanup) {
      this._disconnectCleanup();
      this._disconnectCleanup = null;
    }

    try {
      await window.funsync.tcodeDisconnect();
    } catch (err) {
      console.warn('[TCode] Disconnect error:', err.message);
    }

    if (wasConnected && this.onDisconnect) this.onDisconnect();
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
   * @param {number} [durationMs] — shared interval for timed moves (I suffix)
   * @param {Object} [axisIntervals] — optional per-axis interval override map,
   *   e.g. { L0: 20, R0: 250 }. When present, an axis's own interval wins over
   *   `durationMs` so each axis can move over the exact time to ITS next
   *   keyframe — the same shape XTEngine emits (`L0500I100 R0300I250`). Falls
   *   back to `durationMs` for any axis not in the map.
   */
  sendAxes(axisValues, durationMs, axisIntervals) {
    if (!this._connected || !axisValues) return;

    const parts = [];
    const now = performance.now();
    for (const [axis, value] of Object.entries(axisValues)) {
      const clamped = Math.max(0, Math.min(100, value));
      const tcodeVal = Math.round(clamped / 100 * this._valueMax);
      const valStr = String(tcodeVal).padStart(this._precision, '0');
      let cmd = `${axis}${valStr}`;
      const iv = (axisIntervals && axisIntervals[axis] != null) ? axisIntervals[axis] : durationMs;
      if (iv && iv > 0) {
        cmd += `I${Math.round(iv)}`;
      }
      parts.push(cmd);
      this._recordMove(axis, clamped, iv && iv > 0 ? Math.round(iv) : 0, now);
    }

    if (parts.length > 0) {
      this.send(parts.join(' ') + '\n');
    }
  }

  /**
   * Stop all axes. For serial / UDP targets (typical TCode firmware) we
   * still emit `DSTOP\n` because OSR2/SR6 builds recognise it as a
   * shorthand. For MFP-protocol consumers (WebSocket → restim, Howl,
   * etc.) DSTOP is non-standard — they expect axis values — so we ALSO
   * send a rest frame: position axes (A0, the valve, included) glide to the
   * middle over REST_MOVE_MS, intensity axes go to zero at once.
   * Sending both is
   * harmless on the firmware side (the second frame wins; DSTOP just
   * acts as a hint).
   *
   * @returns {string[]} the position axes the rest frame sent to the middle
   *   (none over serial), so the sync engine's next play moves them from there
   *   at the script's pace instead of a one-tick snap (tcode-sync.js).
   */
  stop() {
    if (!this._connected) return [];
    this.send('DSTOP\n');
    // DSTOP halts in place: every axis stays where it has got to.
    const now = performance.now();
    for (const axis of [...this._axisMoves.keys()]) {
      const at = this.estimatePosition(axis, now);
      this._axisMoves.set(axis, { from: at, to: at, at: now, ms: 0 });
    }
    // The neutral-position fallback frame (50% on every axis) is ONLY for
    // MFP-protocol consumers (restim, Howl, etc. over ws/udp) that don't
    // understand DSTOP and expect explicit axis values. On real TCode firmware
    // (serial OSR2+/SR6) DSTOP already halts motion in place, and a BARE
    // (interval-less) 50% frame makes the device slam to center at full speed —
    // the "violent jump on pause" OSR2+ users reported. So skip it on serial.
    if (this._transportKind === 'serial') return [];
    const mid = String(Math.round(this._valueMax / 2)).padStart(this._precision, '0');
    const off = '0'.padStart(this._precision, '0');
    // Position axes centre; intensity axes go to ZERO. A "neutral" frame that
    // parks V0 at 50% is a stop that leaves the device running at half power.
    // The lists must cover every channel we actually drive (AXIS_DEFINITIONS):
    // this used to zero A1/A2, which nothing drove, while skipping V1 and V2,
    // which were driven — so those axes held their last value through a stop.
    // A0, the valve, is a POSITION, as in TCodeSync and Go home: it used to be
    // zeroed here and centred everywhere else (2026-11-20, Dave: centre it).
    // The positions are TIMED (`L0500I2000`): a bare frame makes a real
    // T-Code firmware over WiFi (an ESP32 OSR / SR6) slam to the middle on
    // every pause, the jump serial had before 2026-08-01 (FT-095, Dave
    // 2026-11-20: "make the pause frame a slow move"). MFP-style consumers
    // read the interval like any MultiFunPlayer frame.
    const positionAxes = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'A0'];
    const intensityAxes = ['V0', 'V1', 'A1', 'A2'];
    this.send([
      ...positionAxes.map((a) => `${a}${mid}I${REST_MOVE_MS}`),
      ...intensityAxes.map((a) => `${a}${off}`),
    ].join(' ') + '\n');
    for (const a of positionAxes) this._recordMove(a, 50, REST_MOVE_MS, now);
    return positionAxes;
  }

  get connected() { return this._connected; }
  get portPath() { return this._portPath; }
  get baudRate() { return this._baudRate; }

  _emitError(message) {
    console.error(`[TCodeManager] ${message}`);
    if (this.onError) this.onError(message);
  }
}
