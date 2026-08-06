// RemoteBridge — observer WebSocket client for web-remote device sync.
//
// Connects to the FastAPI backend at `/api/remote/sync/observe`, receives
// phone events (`phone-connected`, `state`, `seek`, etc.) and dispatches
// them upward as callbacks. Also relays device-status / script-* payloads
// back down to the phone.
//
// Reconnects with exponential backoff on drop — the backend is a local
// child process and disappears briefly during dev reloads / crashes, so
// resilience matters.

const DEFAULT_PORT = 5123;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

export class RemoteBridge {
  /**
   * @param {object} opts
   * @param {number} [opts.port]
   */
  constructor({ port = DEFAULT_PORT } = {}) {
    this._port = port;
    this._ws = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._shouldRun = false;

    // Upward callbacks — set by app.js
    this.onPhoneConnected = null;      // (ip, videoId, videoPath) => {}
    this.onPhoneReplaced = null;       // (oldIp, newIp) => {}
    this.onPhoneDisconnected = null;   // (ip) => {}
    this.onPhoneState = null;          // (state, ip) => {}
    this.onPhoneSeek = null;           // (atMs, ip) => {}
    this.onPhonePlay = null;           // (ip) => {}
    this.onPhonePause = null;          // (ip) => {}
    this.onPhoneEnded = null;          // (ip) => {}
    this.onPhoneSwitchVariant = null;  // (label, ip) => {} — phone tapped a variant in the player view
    this.onPhoneOrgasmHold = null;     // (active, ip) => {} — phone orgasm button press/release (F2)
    this.onPhoneSetOffset = null;      // (device, ms, ip) => {} — phone offset slider (F4)
    this.onBridgeOpen = null;          // () => {}
    this.onBridgeClose = null;         // () => {}
  }

  /** Start connecting; reconnects automatically on drop. */
  connect() {
    this._shouldRun = true;
    this._openSocket();
  }

  /** Stop reconnecting and close the current socket. */
  disconnect() {
    this._shouldRun = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
  }

  /**
   * Send a message downstream to the phone (forwarded by the backend).
   * Safe to call when disconnected — drops silently.
   */
  sendToPhone(payload) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify(payload));
    } catch { /* ignore */ }
  }

  /** True when the observer socket is open. */
  get connected() {
    return !!this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  // --- Internals --------------------------------------------------------

  _openSocket() {
    if (!this._shouldRun) return;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;

    const url = `ws://127.0.0.1:${this._port}/api/remote/sync/observe`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._reconnectAttempts = 0;
      if (this.onBridgeOpen) this.onBridgeOpen();
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      this._handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      if (this._ws === ws) this._ws = null;
      if (this.onBridgeClose) this.onBridgeClose();
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' will fire right after, which handles reconnect scheduling.
    });
  }

  _scheduleReconnect() {
    if (!this._shouldRun) return;
    if (this._reconnectTimer) return;
    this._reconnectAttempts++;
    const delay = Math.min(
      MIN_BACKOFF_MS * Math.pow(2, this._reconnectAttempts - 1),
      MAX_BACKOFF_MS,
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openSocket();
    }, delay);
  }

  _handleMessage(msg) {
    const t = msg.type;
    const ip = msg.ip;
    switch (t) {
      case 'phone-connected':
        if (this.onPhoneConnected && this._dedupConnect(ip, msg.videoId)) {
          this.onPhoneConnected(ip, msg.videoId, msg.videoPath);
        }
        break;
      case 'phone-replaced':
        if (this.onPhoneReplaced) this.onPhoneReplaced(msg.oldIp, msg.newIp);
        // The immediately-following `phone-connected` for the new phone will
        // hit onPhoneConnected via the normal path — don't fire here or we
        // double-fire.
        break;
      case 'phone-disconnected':
        if (this.onPhoneDisconnected) this.onPhoneDisconnected(ip);
        break;
      case 'state':
        if (this.onPhoneState) this.onPhoneState(msg, ip);
        break;
      case 'seek':
        if (this.onPhoneSeek) this.onPhoneSeek(msg.at, ip);
        break;
      case 'play':
        if (this.onPhonePlay) this.onPhonePlay(ip);
        break;
      case 'pause':
        if (this.onPhonePause) this.onPhonePause(ip);
        break;
      case 'ended':
        if (this.onPhoneEnded) this.onPhoneEnded(ip);
        break;
      case 'switch-variant':
        // Phone tapped a variant row. Desktop performs the switch (load
        // script, re-upload to Handy, reset editor, etc.) and broadcasts
        // `variant-changed` back so the phone can update its UI when the
        // switch actually completes.
        if (this.onPhoneSwitchVariant && typeof msg.label === 'string') {
          this.onPhoneSwitchVariant(msg.label, ip);
        }
        break;
      case 'orgasm-hold':
        // Orgasm Switch remote trigger (SCOPE-web-remote-2.md F2). The
        // phone's hold button — routed into the same keyboard-X handler.
        if (this.onPhoneOrgasmHold) this.onPhoneOrgasmHold(!!msg.active, ip);
        break;
      case 'set-offset':
        // Per-device offset slider on the phone's sync pill (F4). Value
        // is clamped by the handler (untrusted LAN input).
        if (this.onPhoneSetOffset && typeof msg.device === 'string') {
          this.onPhoneSetOffset(msg.device, Number(msg.ms), ip);
        }
        break;
      case 'hello':
        // Phones send hello after connecting — treat it as (re)announcing
        // the videoId so downstream can resolve the script.
        if (this.onPhoneConnected && msg.videoId && this._dedupConnect(ip, msg.videoId)) {
          this.onPhoneConnected(ip, msg.videoId, msg.videoPath);
        }
        break;
      default:
        // Unknown types are silently ignored — forward-compat.
        break;
    }
  }

  /**
   * De-duplicate phone-connect handler invocations. The backend emits
   * `phone-connected` AND the phone separately emits `hello` on the
   * same connection — both arrive within ~50ms of each other. Without
   * deduplication, `_onRemotePhoneConnected` would run end-to-end
   * twice: two script uploads to Handy cloud, two `setScript` calls,
   * two `syncEngine.start()` (the second is a no-op via `_active`
   * guard but still wasteful), and the phone briefly sees two
   * `script-loading` → `script-ready` pairs back-to-back.
   *
   * Dedup key is `(ip + '|' + videoId)` with a 2-second TTL — long
   * enough to catch the close-pair race, short enough that legitimate
   * sequential reconnects to the same video still trigger.
   *
   * Surfaced via community report 2026-05-01 (TODO.md backlog).
   *
   * Returns `true` if this is a fresh event, `false` if dedup
   * dropped it.
   */
  _dedupConnect(ip, videoId) {
    if (!ip || !videoId) return true;
    const key = ip + '|' + videoId;
    const now = Date.now();
    if (!this._connectDedup) this._connectDedup = new Map();
    const last = this._connectDedup.get(key);
    if (last && now - last < 2000) return false;
    this._connectDedup.set(key, now);
    // Prune old entries occasionally so the map doesn't grow without
    // bound on long-running sessions with many phone reconnects.
    if (this._connectDedup.size > 32) {
      for (const [k, ts] of this._connectDedup) {
        if (now - ts > 2000) this._connectDedup.delete(k);
      }
    }
    return true;
  }
}
