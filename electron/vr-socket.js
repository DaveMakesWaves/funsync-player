// vr-socket — the TCP link to the headset's DeoVR/HereSphere companion server.
//
// Renderers cannot open sockets, so this lives in main. `vr-bridge.js` is the
// protocol brain; this is only the pipe, plus the one rule the pipe has to
// enforce:
//
//   A DEAD ATTEMPT MUST NEVER TOUCH A LIVE CONNECTION'S STATE.
//
// That rule was not enforced before, and it is the whole reason this file
// exists. The old inline handler kept `vrSocket` and `vrKeepAliveTimer` as two
// loose module globals, and every socket's listeners wrote to them by name
// with no check that the socket firing the event was still the current one.
// Two concrete ways that bit:
//
//   * The `error` handler nulled `vrSocket` and resolved, but never destroyed
//     the socket or unbound its listeners. The socket stayed alive with live
//     handlers attached, waiting to fire into shared state it no longer owned.
//   * The `close` handler then ran `clearInterval(vrKeepAliveTimer)`
//     unconditionally. A stale socket closing would happily clear the timer
//     belonging to a NEWER, working connection. Keep-alive silence for three
//     seconds is exactly how HereSphere drops a link, so the visible symptom
//     is a connection that dies on its own a few seconds after being made,
//     with nothing in the log to say why.
//
// pallokala2 (EroScripts #338/#343) reported constant disconnects and a
// connection that then refused to come back. This is not proven to be his bug
// — his ECONNREFUSED points at the headset's listener rather than at us, and
// the fix he actually needs is the quiet-endpoint retry — but it is a real
// hole on the exact path he was hammering, and it fails in the same shape.
//
// The fix is generation stamping. Every attempt takes a number; every listener
// checks that number before touching anything shared. A late event from a dead
// attempt can then only clean up after itself.
//
// Everything is injected so this is testable without Electron or a real
// headset. `net` is a parameter, not a require.

// Players drop the connection after ~3 s of silence, so keep well inside that.
// Matches MultiFunPlayer's cadence.
const KEEP_ALIVE_MS = 1000;

// Applies to the CONNECT attempt. Cleared once connected, because after that
// the socket is legitimately idle whenever the user pauses, and an inactivity
// timeout would tear down a perfectly good link. The liveness watchdog in
// vr-bridge.js owns silence-detection on a live connection.
const CONNECT_TIMEOUT_MS = 5000;

class VRSocketLink {
  /**
   * @param {object} deps
   * @param {() => object} deps.createSocket   Returns a net.Socket-alike.
   * @param {(channel: string, payload?: any) => void} deps.broadcast
   * @param {object} [deps.log]                 { info, warn, debug }
   * @param {typeof setInterval} [deps.setIntervalFn]
   * @param {typeof clearInterval} [deps.clearIntervalFn]
   */
  constructor({
    createSocket,
    broadcast,
    log = { info() {}, warn() {}, debug() {} },
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    keepAliveMs = KEEP_ALIVE_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
  }) {
    this._createSocket = createSocket;
    this._broadcast = broadcast;
    this._log = log;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._keepAliveMs = keepAliveMs;
    this._connectTimeoutMs = connectTimeoutMs;

    this._socket = null;
    this._keepAliveTimer = null;
    // Bumped on every connect() and every disconnect(). A listener whose
    // captured generation is stale owns nothing and may only destroy itself.
    this._generation = 0;
  }

  get connected() { return this._socket !== null; }

  /**
   * Dial the headset. Resolves once, either way — never rejects.
   */
  connect(host, port) {
    // Tear down whatever is there. This bumps the generation, so any listener
    // still attached to the old socket is now stale by definition.
    this._teardown();

    const generation = ++this._generation;
    const socket = this._createSocket();
    let buffer = Buffer.alloc(0);
    let settled = false;

    return new Promise((resolve) => {
      // `settled` guards the PROMISE (resolve once). `isCurrent()` guards the
      // SHARED STATE. They are different questions and conflating them is the
      // original bug: a socket can be settled and still be the live one, or
      // unsettled and already superseded.
      const isCurrent = () => generation === this._generation;

      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Retire a socket that is not, or is no longer, the live one. Safe to
      // call twice; net.Socket.destroy() is idempotent.
      const abandon = () => {
        socket.removeAllListeners();
        try { socket.destroy(); } catch { /* already gone */ }
      };

      socket.setTimeout(this._connectTimeoutMs);

      socket.connect(port || 23554, host || '127.0.0.1', () => {
        if (!isCurrent()) {
          // Superseded while the TCP handshake was in flight. Do not publish.
          abandon();
          settle({ success: false, error: 'Superseded by a newer connection' });
          return;
        }

        // The connect deadline has done its job. Leaving it armed would make
        // any quiet stretch on a live connection look like a failure.
        socket.setTimeout(0);

        this._socket = socket;
        this._log.info(`[VR] Connected to ${host}:${port}`);

        this._keepAliveTimer = this._setInterval(() => {
          if (!isCurrent()) return;
          try {
            socket.write(Buffer.alloc(4, 0)); // [0,0,0,0] = zero-length packet
          } catch { /* ignore write errors */ }
        }, this._keepAliveMs);

        settle({ success: true });
      });

      socket.on('data', (chunk) => {
        if (!isCurrent()) return;
        buffer = Buffer.concat([buffer, chunk]);

        // 4-byte LE length prefix + JSON payload.
        while (buffer.length >= 4) {
          const len = buffer.readUInt32LE(0);
          if (buffer.length < 4 + len) break; // incomplete packet

          const json = buffer.subarray(4, 4 + len).toString('utf-8');
          buffer = buffer.subarray(4 + len);

          try {
            const data = JSON.parse(json);
            // Main-process arrival stamp so the renderer can derive network
            // jitter from the spread between consecutive arrivals.
            data._arrivalMs = Date.now();
            this._broadcast('vr-state', data);
          } catch (err) {
            this._log.debug('[VR] Failed to parse JSON:', err.message);
          }
        }
      });

      socket.on('close', () => {
        if (!isCurrent()) {
          // A dead attempt closing. It has no claim on the keep-alive timer
          // or the live socket, and clearing them here was the cross-talk bug.
          abandon();
          return;
        }
        const wasConnected = this._socket === socket;
        this._clearKeepAlive();
        this._socket = null;
        socket.removeAllListeners();
        if (wasConnected) {
          this._log.info('[VR] Connection closed');
          this._broadcast('vr-disconnected');
        }
        settle({ success: false, error: 'Connection closed' });
      });

      socket.on('error', (err) => {
        // ECONNREFUSED is the EXPECTED state when HereSphere/DeoVR is not
        // listening on 23554 (no video playing, headset asleep, timestamp
        // server off). Debug so normal use does not fill the log. Anything
        // else is a genuine network problem the user should be able to see.
        if (err.code === 'ECONNREFUSED') {
          this._log.debug('[VR] Socket error (expected when no VR app listening):', err.message);
        } else {
          this._log.warn('[VR] Socket error:', err.message);
        }

        if (isCurrent()) {
          // Destroy, but KEEP the listeners: Node always emits 'close' after
          // 'error', and 'close' is the single place that releases state and
          // tells the renderer. Stripping the listeners here instead was a
          // regression caught by driving this against a real net.Socket — a
          // headset hanging up mid-session raises ECONNRESET first, so the
          // renderer was never told the link had gone and sat on a dead
          // connection until vr-bridge's 8s liveness watchdog noticed.
          try { socket.destroy(); } catch { /* already gone */ }
        } else {
          // Stale. It publishes nothing, so it may go quietly and completely.
          abandon();
        }
        settle({ success: false, error: err.message });
      });

      socket.on('timeout', () => {
        // Only armed during connect — see setTimeout(0) above.
        if (isCurrent()) {
          this._clearKeepAlive();
          if (this._socket === socket) this._socket = null;
        }
        abandon();
        settle({ success: false, error: 'Connection timed out' });
      });
    });
  }

  disconnect() {
    this._teardown();
    this._log.info('[VR] Disconnected');
    return { success: true };
  }

  /**
   * Length-prefix and send one JSON string. False if there is no link.
   */
  send(jsonStr) {
    if (!this._socket) return false;
    try {
      const payload = Buffer.from(jsonStr);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      this._socket.write(Buffer.concat([header, payload]));
      return true;
    } catch { return false; }
  }

  _clearKeepAlive() {
    if (this._keepAliveTimer) {
      this._clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  /**
   * Drop the current link and invalidate every listener still out there.
   */
  _teardown() {
    this._generation++;
    this._clearKeepAlive();
    if (this._socket) {
      this._socket.removeAllListeners();
      try { this._socket.destroy(); } catch { /* already gone */ }
      this._socket = null;
    }
  }
}

module.exports = { VRSocketLink, KEEP_ALIVE_MS, CONNECT_TIMEOUT_MS };
