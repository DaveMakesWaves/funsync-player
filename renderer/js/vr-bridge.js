// VRBridge — Connects to DeoVR or HereSphere via their TCP remote control API
// Reads playback state (video path, position, play/pause) and feeds it to VRPlaybackProxy.
// The sync engines then bind to the proxy just like they bind to a local <video> element.

import { VRPlaybackProxy } from './vr-playback-proxy.js';

export class VRBridge {
  constructor() {
    this.proxy = new VRPlaybackProxy();
    this._connected = false;
    this._playerType = 'deovr'; // 'deovr' | 'heresphere'
    this._host = '127.0.0.1';
    this._port = 23554;
    this._currentVideoPath = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    // Network-jitter ring buffer: deltas between consecutive packet
    // arrivals. HereSphere/DeoVR push timestamp packets at a fairly
    // steady cadence (~10Hz); the spread of inter-arrival deltas
    // approximates the network jitter component of latency. Used by
    // the auto-offset diagnostic to classify transport quality
    // (cable / wifi-fast / wifi-slow).
    this._arrivalDeltas = [];
    this._lastArrivalMs = 0;
    // No retry cap. Closing HereSphere on the Quest (or headset battery
    // dropping) often takes longer than a 44-second budget to recover
    // from, and a TCP connect attempt is cheap. Keep trying until the
    // user explicitly calls disconnect().
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
    if (this._connected) await this.disconnect();

    this._playerType = playerType || 'deovr';
    this._host = host || '127.0.0.1';
    this._port = port || 23554;
    this._intentionalDisconnect = false;
    // Don't reset reconnect counter here — _attemptReconnect manages it
    // Only reset on successful connect (below)

    try {
      const result = await window.funsync.vrConnect(this._host, this._port);
      if (result.success) {
        this._connected = true;
        this._reconnectAttempts = 0;
        this._bindListeners();
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
    }
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
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

  // --- Internal ---

  _bindListeners() {
    this._cleanupStateListener = window.funsync.onVrState((data) => {
      this._handleStateUpdate(data);
    });

    this._cleanupDisconnectListener = window.funsync.onVrDisconnected(() => {
      this._connected = false;
      this._currentVideoPath = null;
      this.proxy.pause();
      if (this.onDisconnect) this.onDisconnect();
      this._attemptReconnect();
    });
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

  _attemptReconnect() {
    if (this._intentionalDisconnect) return;
    if (this._reconnecting) return; // prevent concurrent reconnect attempts

    this._reconnectAttempts++;
    this._reconnecting = true;
    // Exponential backoff 2s → 15s, then stay at 15s forever. Closing
    // HereSphere on the Quest or the headset going to sleep can exceed
    // any short reconnect budget; we'd rather poll quietly at 15s
    // intervals than give up and leave the user disconnected.
    const delay = Math.min(2000 * Math.pow(2, this._reconnectAttempts - 1), 15000);
    console.log(`[VR] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnecting = false;
      if (this._connected || this._intentionalDisconnect) return;
      const success = await this.connect(this._playerType, this._host, this._port);
      if (!success && !this._intentionalDisconnect) {
        this._attemptReconnect();
      }
    }, delay);
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
