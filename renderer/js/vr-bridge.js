// VRBridge — Connects to DeoVR or HereSphere via their TCP remote control API
// Reads playback state (video path, position, play/pause) and feeds it to VRPlaybackProxy.
// The sync engines then bind to the proxy just like they bind to a local <video> element.
//
// Reconnect strategy: bridge does NOT self-retry. The activity poll in
// app.js::_pollVRActivity is the sole reconnect driver — it knows whether
// the user is currently using HereSphere (via the backend's vr-activity
// endpoint) and is the right authority on when to attempt a reconnect.
// Removed the internal `_attemptReconnect` exponential-backoff loop in
// the connection-reliability pass (2026-04-28) so the two retry sources
// don't race. See `notes/features/SCOPE-vr-connection-reliability.md`.

import { VRPlaybackProxy } from './vr-playback-proxy.js';

// Liveness watchdog timeout — if `_connected === true` but no state
// packet has arrived within this many ms, treat as silent disconnect
// and tear down. ~2× the longest configurable HereSphere update_interval
// (1 s by default in the protocol; users with a slow Quest may run higher).
// Tighter values catch silent-failure faster but risk false-positive
// disconnects on network blips.
const LIVENESS_TIMEOUT_MS = 8000;

export class VRBridge {
  constructor() {
    this.proxy = new VRPlaybackProxy();
    this._connected = false;
    this._connecting = false;     // in-flight connect() guard (move 3.6.2)
    this._playerType = 'deovr'; // 'deovr' | 'heresphere'
    this._host = '127.0.0.1';
    this._port = 23554;
    this._currentVideoPath = null;
    // Network-jitter ring buffer: deltas between consecutive packet
    // arrivals. HereSphere/DeoVR push timestamp packets at a fairly
    // steady cadence (~10Hz); the spread of inter-arrival deltas
    // approximates the network jitter component of latency. Used by
    // the auto-offset diagnostic to classify transport quality
    // (cable / wifi-fast / wifi-slow).
    this._arrivalDeltas = [];
    this._lastArrivalMs = 0;
    // Liveness watchdog: set on every packet arrival; checked by a
    // periodic timer to detect "TCP socket open but no data flowing"
    // — the silent-failure mode that motivated this rewrite.
    this._livenessTimer = null;
    this._intentionalDisconnect = false;
    this._cleanupStateListener = null;
    this._cleanupDisconnectListener = null;

    // Callbacks
    this.onConnect = null;
    this.onDisconnect = null;
    this.onVideoChanged = null;   // (normalizedPath, rawPath) => {}
    this.onError = null;
  }

  /**
   * Connect to a VR player.
   * @param {'deovr'|'heresphere'} playerType
   * @param {string} host — IP address (default localhost for PCVR)
   * @param {number} port — default 23554
   */
  async connect(playerType, host, port) {
    // Coalesce concurrent connect attempts. Without this guard, the
    // activity poll could fire a connect() while a previous attempt
    // is still in flight — visible in user logs as double-error
    // entries landing within 1 ms of each other.
    if (this._connecting) return false;
    if (this._connected) await this.disconnect();

    this._playerType = playerType || 'deovr';
    this._host = host || '127.0.0.1';
    this._port = port || 23554;
    this._intentionalDisconnect = false;
    this._connecting = true;

    try {
      const result = await window.funsync.vrConnect(this._host, this._port);
      if (result.success) {
        this._connected = true;
        // Seed `_lastArrivalMs` to "now" so the liveness watchdog has
        // a sensible first-packet window: if nothing arrives within
        // LIVENESS_TIMEOUT_MS, we tear down (silent-failure recovery).
        this._lastArrivalMs = Date.now();
        this._bindListeners();
        this._startLivenessWatchdog();
        console.log(`[VR] Connected to ${this._playerType} at ${this._host}:${this._port}`);
        if (this.onConnect) this.onConnect();
        return true;
      } else {
        this._emitError(result.error || 'Connection failed');
        return false;
      }
    } catch (err) {
      this._emitError(err.message);
      return false;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    this._stopLivenessWatchdog();
    this._unbindListeners();

    try {
      await window.funsync.vrDisconnect();
    } catch (err) {
      console.warn('[VR] Disconnect error:', err.message);
    }

    this._connected = false;
    this._currentVideoPath = null;
    this.proxy.reset();
    if (this.onDisconnect) this.onDisconnect();
  }

  /**
   * Send a seek command to the VR player.
   */
  seek(timeSeconds) {
    if (!this._connected) return;
    window.funsync.vrSend(JSON.stringify({ currentTime: timeSeconds }));
  }

  get connected() { return this._connected; }
  get playerType() { return this._playerType; }
  get currentVideoPath() { return this._currentVideoPath; }
  get host() { return this._host; }

  /**
   * Three-state derivation for the UI: connected & receiving / connected &
   * waiting / disconnected. Used by the VR modal pill and the nav-bar
   * tooltip; encodes the silent-failure detection (`connected = true`
   * but no packets in last 5 s = waiting). Threshold is shorter than
   * the liveness watchdog timeout (8 s) so the UI flips to "waiting"
   * before the watchdog tears down the connection.
   */
  get linkState() {
    if (!this._connected) return 'disconnected';
    const sinceLastPacket = Date.now() - this._lastArrivalMs;
    return sinceLastPacket < 5000 ? 'receiving' : 'waiting';
  }

  // --- Internal ---

  _bindListeners() {
    this._cleanupStateListener = window.funsync.onVrState((data) => {
      this._handleStateUpdate(data);
    });

    // On socket close: tear down state and notify, but do NOT self-retry.
    // The activity poll in app.js::_pollVRActivity decides when (and
    // whether) to reconnect, based on actual signs of HereSphere being
    // alive. See SCOPE-vr-connection-reliability.md §3.6.1.
    this._cleanupDisconnectListener = window.funsync.onVrDisconnected(() => {
      this._handleSocketClosed();
    });
  }

  /**
   * Tear down on socket close OR on liveness-watchdog timeout. Same
   * semantic state in both cases — the bridge is no longer receiving
   * packets, so consumers must know to stop trusting the proxy and the
   * activity poll can decide when to reconnect.
   */
  _handleSocketClosed() {
    if (!this._connected) return; // already torn down
    this._connected = false;
    this._currentVideoPath = null;
    this._stopLivenessWatchdog();
    this.proxy.pause();
    if (this.onDisconnect) this.onDisconnect();
  }

  _unbindListeners() {
    if (this._cleanupStateListener) { this._cleanupStateListener(); this._cleanupStateListener = null; }
    if (this._cleanupDisconnectListener) { this._cleanupDisconnectListener(); this._cleanupDisconnectListener = null; }
  }

  _handleStateUpdate(data) {
    if (!data) return;

    // Update jitter ring from main-process arrival timestamps. Skip
    // the first arrival (no delta) and any abnormally large gap that's
    // probably a pause/seek pause rather than network jitter.
    if (data._arrivalMs && this._lastArrivalMs) {
      const delta = data._arrivalMs - this._lastArrivalMs;
      if (delta > 0 && delta < 500) {
        this._arrivalDeltas.push(delta);
        if (this._arrivalDeltas.length > 20) this._arrivalDeltas.shift();
      }
    }
    if (data._arrivalMs) this._lastArrivalMs = data._arrivalMs;

    // Detect video change
    const rawPath = data.path || '';
    if (rawPath && rawPath !== this._currentVideoPath) {
      this._currentVideoPath = rawPath;
      const normalized = this._normalizePath(rawPath);
      if (this.onVideoChanged) this.onVideoChanged(normalized, rawPath);
    }

    // Feed state to proxy
    this.proxy.updateFromVR({
      currentTime: data.currentTime || 0,
      duration: data.duration || 0,
      playerState: data.playerState ?? 1,
      playbackSpeed: data.playbackSpeed || 1,
    });
  }

  /**
   * Get current packet-arrival jitter in ms. Used by the auto-offset
   * diagnostic to classify the transport (cable / wifi-fast / wifi-slow).
   * Returns the standard deviation of the last 20 arrival deltas, or
   * null if we don't have enough samples yet.
   */
  getNetworkJitterMs() {
    if (this._arrivalDeltas.length < 4) return null;
    const mean = this._arrivalDeltas.reduce((a, b) => a + b, 0) / this._arrivalDeltas.length;
    const variance = this._arrivalDeltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / this._arrivalDeltas.length;
    return Math.round(Math.sqrt(variance));
  }

  /**
   * Normalize a VR-reported file path for matching against the local library.
   * Handles Windows paths, Android paths, DLNA URLs, URL-encoding, special chars.
   */
  _normalizePath(rawPath) {
    let name = rawPath;

    // Strip URL scheme if present (DLNA/XBVR)
    if (name.includes('://')) {
      try { name = new URL(name).pathname; } catch { /* keep as-is */ }
    }

    // Get basename (last segment after / or \)
    name = name.split(/[\\/]/).pop() || name;

    // URL-decode (%20 → space, etc.)
    try { name = decodeURIComponent(name); } catch { /* keep as-is */ }

    // Strip extension — whitelist of known video/audio extensions only.
    // Headsets often report paths without an extension (e.g.
    // `2.GroVR_30 35_ Lina Laon Amecan Bety2_TMAL`); a naive "strip after last
    // dot" or `/\.[^/.]+$/` chops the stem in half for those cases.
    name = name.replace(/\.(?:mp4|mkv|webm|avi|mov|wmv|flv|m4v|mp3|wav|ogg|flac|aac|m4a|3gp|ts|mts|m2ts)$/i, '');

    // Normalize separators and case for matching
    name = name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

    return name;
  }

  /**
   * Liveness watchdog. Started on connect, stopped on disconnect.
   * Polls every second; when the time since `_lastArrivalMs` exceeds
   * LIVENESS_TIMEOUT_MS we treat the connection as silently dead and
   * synthesise a disconnect. The activity poll then decides when to
   * try again.
   *
   * This catches the silent-failure mode where the TCP socket is open
   * but HereSphere isn't pushing state packets (timestamp-server toggle
   * off, wrong port answering, network blip, etc.). Without this, the
   * UI would falsely show "Connected" and toys would sit silent.
   */
  _startLivenessWatchdog() {
    this._stopLivenessWatchdog(); // idempotent
    this._livenessTimer = setInterval(() => {
      if (!this._connected) {
        this._stopLivenessWatchdog();
        return;
      }
      const sinceLastPacket = Date.now() - this._lastArrivalMs;
      if (sinceLastPacket > LIVENESS_TIMEOUT_MS) {
        console.warn(`[VR] Liveness timeout — no packet in ${sinceLastPacket}ms; tearing down`);
        // Mirror the cleanup the IPC vrDisconnect would do, so the next
        // activity-poll tick sees `_connected === false` and can attempt
        // a fresh connection.
        try { window.funsync.vrDisconnect?.(); } catch { /* ignore */ }
        this._handleSocketClosed();
      }
    }, 1000);
  }

  _stopLivenessWatchdog() {
    if (this._livenessTimer) {
      clearInterval(this._livenessTimer);
      this._livenessTimer = null;
    }
  }

  _emitError(message) {
    // Stash the message so the caller of connect() can introspect WHY it
    // failed without needing to subscribe to onError. The auto-connect
    // loop in app.js uses this to recognise the "HereSphere timestamp
    // server isn't running" case and surface a specific hint.
    this._lastError = String(message || '');
    console.error(`[VRBridge] ${message}`);
    if (this.onError) this.onError(message);
  }
}
