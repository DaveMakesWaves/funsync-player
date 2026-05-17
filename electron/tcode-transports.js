// Main-process TCode transports.
//
// Originally TCode shipped with a hardcoded `serialport` transport — every
// IPC handler reached for the same global `tcodePort` SerialPort instance.
// Community feedback (GGEZGitGud, 2026-05-15) asked for a UDP option:
// "2.4GHz should be more stable than Bluetooth". GGEZGitGud also asked
// whether WebSocket would be easy to integrate — same protocol formatter,
// different wire.
//
// This module separates "how do I get bytes onto a device" from "what
// bytes do I send" (the formatter still lives in
// `renderer/js/tcode-manager.js`). Each transport implements the same
// shape so the IPC dispatcher in `main.js` can route to whichever one
// the user picked at connect time.
//
// Transport contract:
//   async connect(opts): Promise<{ success: boolean, error?: string }>
//   async disconnect(): Promise<void>
//   send(command: string): boolean   // sync write; false on failure
//   get connected(): boolean
//   onDisconnect(callback): void     // single subscriber; replaces prior
//   destroy(): void                  // hard teardown, idempotent

const dgram = require('dgram');

// Some Electron / Node sandboxes expose WebSocket globally (Node 22+).
// Fall back gracefully — UDP can still be selected even if WS isn't
// available in this environment.
const HAS_GLOBAL_WS = typeof globalThis.WebSocket !== 'undefined';

class SerialTransport {
  constructor({ log = console } = {}) {
    this._port = null;
    this._log = log;
    this._onDisconnect = null;
  }

  async connect({ path, baudRate = 115200 } = {}) {
    try {
      // Hard-reset any previous instance — the SerialPort 'close' event
      // would normally clear `_port`, but a fresh connect attempt should
      // not depend on that event having fired yet.
      if (this._port) {
        try { this._port.removeAllListeners(); } catch {}
        try { if (this._port.isOpen) this._port.close(); } catch {}
        this._port = null;
      }
      const { SerialPort } = require('serialport');
      this._port = new SerialPort({
        path,
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });
      return await new Promise((resolve) => {
        this._port.open((err) => {
          if (err) {
            this._log.warn?.('[TCode/serial] Open failed:', err.message);
            this._port = null;
            resolve({ success: false, error: err.message });
            return;
          }
          this._port.on('close', () => {
            this._log.info?.('[TCode/serial] Port closed');
            this._port = null;
            if (this._onDisconnect) this._onDisconnect();
          });
          this._port.on('error', (e) => {
            this._log.warn?.('[TCode/serial] Port error:', e.message);
          });
          this._log.info?.(`[TCode/serial] Connected to ${path} @ ${baudRate}`);
          resolve({ success: true });
        });
      });
    } catch (err) {
      this._log.warn?.('[TCode/serial] Connect error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async disconnect() {
    if (this._port && this._port.isOpen) {
      try { this._port.close(); } catch {}
    }
    this._port = null;
  }

  send(command) {
    if (!this._port || !this._port.isOpen) return false;
    try {
      this._port.write(command);
      return true;
    } catch (err) {
      this._log.debug?.('[TCode/serial] Write error:', err.message);
      return false;
    }
  }

  get connected() { return !!(this._port && this._port.isOpen); }

  onDisconnect(cb) { this._onDisconnect = cb; }

  destroy() {
    this._onDisconnect = null;
    if (this._port) {
      try { this._port.removeAllListeners(); } catch {}
      try { if (this._port.isOpen) this._port.close(); } catch {}
      this._port = null;
    }
  }
}

class UdpTransport {
  /**
   * UDP transport for 2.4GHz wireless TCode receivers (ESP-NOW bridges,
   * NodeMCU/ESP32 hosts running a UDP→serial loopback firmware, etc.).
   * Connectionless — `connect()` just resolves the remote address and
   * opens the local socket; the first `send()` is when bytes actually go
   * out. Disconnect callback fires only on socket-level errors.
   *
   * @param opts.dgramFactory optional override for tests (returns a
   *   `dgram.Socket` lookalike with .send/.close/.bind/.on).
   */
  constructor({ log = console, dgramFactory } = {}) {
    this._socket = null;
    this._host = null;
    this._port = null;
    this._log = log;
    this._onDisconnect = null;
    this._dgramFactory = dgramFactory || (() => dgram.createSocket('udp4'));
  }

  async connect({ host, port } = {}) {
    if (!host || typeof host !== 'string') {
      return { success: false, error: 'host required' };
    }
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
      return { success: false, error: 'port must be 1-65535' };
    }
    // Tear down any prior socket — connection state is host+port; a fresh
    // call replaces the remote.
    await this.disconnect();
    try {
      this._socket = this._dgramFactory();
      this._host = host;
      this._port = numericPort;
      this._socket.on('error', (err) => {
        this._log.warn?.('[TCode/udp] Socket error:', err.message);
        this._fireDisconnect();
      });
      // Bind to an ephemeral local port so the OS doesn't lazy-bind on
      // first send (which can race with rapid teardown).
      return await new Promise((resolve) => {
        this._socket.bind(() => {
          this._log.info?.(`[TCode/udp] Bound, target ${host}:${numericPort}`);
          resolve({ success: true });
        });
      });
    } catch (err) {
      this._log.warn?.('[TCode/udp] Connect error:', err.message);
      this._socket = null;
      this._host = null;
      this._port = null;
      return { success: false, error: err.message };
    }
  }

  async disconnect() {
    if (!this._socket) return;
    const s = this._socket;
    this._socket = null;
    this._host = null;
    this._port = null;
    await new Promise((resolve) => {
      try { s.close(() => resolve()); }
      catch { resolve(); }
    });
  }

  send(command) {
    if (!this._socket || !this._host || !this._port) return false;
    try {
      const buf = Buffer.from(command, 'utf8');
      this._socket.send(buf, 0, buf.length, this._port, this._host, (err) => {
        if (err) this._log.debug?.('[TCode/udp] Send error:', err.message);
      });
      return true;
    } catch (err) {
      this._log.debug?.('[TCode/udp] Send threw:', err.message);
      return false;
    }
  }

  get connected() { return !!this._socket; }

  onDisconnect(cb) { this._onDisconnect = cb; }

  _fireDisconnect() {
    if (this._socket) {
      try { this._socket.close(); } catch {}
      this._socket = null;
      this._host = null;
      this._port = null;
    }
    if (this._onDisconnect) this._onDisconnect();
  }

  destroy() {
    this._onDisconnect = null;
    if (this._socket) {
      try { this._socket.close(); } catch {}
      this._socket = null;
      this._host = null;
      this._port = null;
    }
  }
}

class WebsocketTransport {
  /**
   * WebSocket client transport — connects to a WS server hosted by the
   * TCode device. Send is sync-returning-bool to match the contract;
   * delivery is best-effort (no ack model in the TCode protocol).
   *
   * Auto-reconnects with exponential backoff when the remote drops the
   * connection AFTER an initial successful open. This matters for
   * MFP-protocol consumers like restim — if restim restarts while
   * FunSync is playing, the user shouldn't have to manually disconnect
   * and reconnect.
   *
   * @param opts.WebSocketImpl optional override for tests — must match
   *   the browser WebSocket shape (constructor `(url)`, `.send(data)`,
   *   `.close()`, `.readyState`, `.onopen/.onmessage/.onclose/.onerror`).
   * @param opts.setTimeoutImpl optional override for tests — must match
   *   the `setTimeout(fn, ms) -> id` shape.
   * @param opts.clearTimeoutImpl optional override for tests.
   * @param opts.reconnect (default true) — disable to keep tests simple.
   */
  constructor({ log = console, WebSocketImpl, setTimeoutImpl, clearTimeoutImpl, reconnect = true } = {}) {
    this._ws = null;
    this._log = log;
    this._onDisconnect = null;
    this._url = null;
    this._reconnectEnabled = !!reconnect;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._stopped = false;
    this._setTimeout = setTimeoutImpl || ((typeof setTimeout !== 'undefined') ? setTimeout : null);
    this._clearTimeout = clearTimeoutImpl || ((typeof clearTimeout !== 'undefined') ? clearTimeout : null);
    // Distinguish "caller did not pass WebSocketImpl" (undefined → fall
    // back to global) from "caller explicitly passed null" (no runtime,
    // tested explicitly).
    if (WebSocketImpl === undefined) {
      this._WebSocket = HAS_GLOBAL_WS ? globalThis.WebSocket : null;
    } else {
      this._WebSocket = WebSocketImpl;
    }
  }

  /**
   * Compute backoff for the Nth reconnect attempt (0-indexed). Capped
   * at 30s to keep the wait bounded; the sequence is 1s, 2s, 4s, 8s,
   * 16s, 30s, 30s, ... — matches the pattern used in
   * `renderer/js/vr-bridge.js` for the VR companion. Exposed for tests.
   */
  _backoffMs(attempt) {
    return Math.min(30000, 1000 * Math.pow(2, attempt));
  }

  async connect({ url } = {}) {
    if (!this._WebSocket) {
      return { success: false, error: 'WebSocket runtime not available' };
    }
    if (!url || typeof url !== 'string' || !/^wss?:\/\//.test(url)) {
      return { success: false, error: 'url must start with ws:// or wss://' };
    }
    // User-initiated connect resets the stopped flag and attempt counter
    // — clearing whatever state a prior `disconnect()` set. The internal
    // reconnect path (`_openSocket`) skips this reset so backoff grows
    // across consecutive failed reconnects.
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._hasEverConnected = false;
    if (this._reconnectTimer && this._clearTimeout) {
      this._clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._url = url;
    return this._openSocket(url);
  }

  /**
   * Open a fresh WebSocket and resolve when it either opens or closes.
   * Shared between user-initiated `connect()` and internal `_scheduleReconnect()` so
   * the latter can grow the backoff across consecutive failures without
   * `connect()` resetting state on every attempt.
   */
  async _openSocket(url) {
    // Synchronous teardown of any prior socket — avoid awaiting so the
    // new socket is constructed on the same tick.
    if (this._ws) {
      const prior = this._ws;
      this._ws = null;
      try { prior.close(); } catch {}
    }
    try {
      this._ws = new this._WebSocket(url);
      return await new Promise((resolve) => {
        const settle = (result) => {
          if (resolved) return;
          resolved = true;
          resolve(result);
        };
        let resolved = false;
        this._ws.onopen = () => {
          this._log.info?.(`[TCode/ws] Connected ${url}`);
          this._reconnectAttempts = 0;
          this._hasEverConnected = true;
          settle({ success: true });
        };
        this._ws.onclose = (ev) => {
          const wasPreOpen = !resolved;
          if (wasPreOpen) {
            settle({ success: false, error: `closed before open (${ev?.code ?? ''})` });
            this._ws = null;
          } else {
            this._log.info?.('[TCode/ws] Closed');
            this._ws = null;
          }
          // Schedule a reconnect on remote-initiated drops AND on
          // pre-open closes inside an active reconnect session (we'd
          // already opened at least once). The very-first connect that
          // closes before open is reported as a failure to the caller —
          // user just typed a bad URL — no auto-retry.
          const shouldRetry = this._reconnectEnabled
            && !this._stopped
            && (this._hasEverConnected || !wasPreOpen);
          if (shouldRetry) {
            this._scheduleReconnect();
          } else if (!wasPreOpen && this._onDisconnect) {
            this._onDisconnect();
          }
        };
        this._ws.onerror = (ev) => {
          this._log.warn?.('[TCode/ws] Socket error');
          if (!resolved) settle({ success: false, error: ev?.message || 'connect failed' });
        };
      });
    } catch (err) {
      this._log.warn?.('[TCode/ws] Connect error:', err.message);
      this._ws = null;
      return { success: false, error: err.message };
    }
  }

  /**
   * Schedule the next reconnect attempt. Called from the close handler
   * when reconnection is enabled and the user didn't explicitly stop.
   * Pulled out so tests can assert backoff timing without faking a
   * full WebSocket lifecycle.
   */
  _scheduleReconnect() {
    if (!this._setTimeout) return;
    const delay = this._backoffMs(this._reconnectAttempts);
    this._reconnectAttempts++;
    this._log.info?.(`[TCode/ws] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      if (this._stopped || !this._url) return;
      // Don't await — if it fails, the close handler fires again and
      // schedules the next attempt with grown backoff. Call _openSocket
      // directly so the user-initiated state reset in connect() doesn't
      // wipe `_reconnectAttempts` on every retry.
      this._openSocket(this._url).catch(() => {});
    }, delay);
  }

  async disconnect() {
    // Mark as user-initiated so the close handler doesn't schedule
    // a reconnect.
    this._stopped = true;
    if (this._reconnectTimer && this._clearTimeout) {
      this._clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;
    if (!this._ws) return;
    const ws = this._ws;
    this._ws = null;
    try { ws.close(); } catch {}
  }

  send(command) {
    if (!this._ws) return false;
    // WebSocket.OPEN === 1. Reference via numeric literal so a mocked
    // WebSocketImpl in tests doesn't need to provide the OPEN static.
    if (this._ws.readyState !== 1) return false;
    try {
      this._ws.send(command);
      return true;
    } catch (err) {
      this._log.debug?.('[TCode/ws] Send error:', err.message);
      return false;
    }
  }

  get connected() { return !!this._ws && this._ws.readyState === 1; }

  /** Was a reconnect scheduled? Exposed for tests. */
  get reconnecting() { return this._reconnectTimer !== null; }

  onDisconnect(cb) { this._onDisconnect = cb; }

  destroy() {
    this._onDisconnect = null;
    this._stopped = true;
    if (this._reconnectTimer && this._clearTimeout) {
      this._clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }
}

/**
 * Build a transport instance by name. Throws on unknown name so the IPC
 * caller fails loudly instead of silently doing nothing.
 */
function createTransport(kind, opts = {}) {
  switch (kind) {
    case 'serial': return new SerialTransport(opts);
    case 'udp': return new UdpTransport(opts);
    case 'websocket':
    case 'ws':
      return new WebsocketTransport(opts);
    default:
      throw new Error(`Unknown TCode transport: ${kind}`);
  }
}

module.exports = {
  SerialTransport,
  UdpTransport,
  WebsocketTransport,
  createTransport,
};
