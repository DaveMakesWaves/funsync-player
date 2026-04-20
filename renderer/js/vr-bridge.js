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
    this._maxReconnectAttempts = 5;
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

    // Strip extension
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) name = name.slice(0, dotIdx);

    // Normalize separators and case for matching
    name = name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

    return name;
  }

  _attemptReconnect() {
    if (this._intentionalDisconnect) return;
    if (this._reconnecting) return; // prevent concurrent reconnect attempts
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.log('[VR] Max reconnect attempts reached');
      this._reconnectAttempts = 0;
      return;
    }

    this._reconnectAttempts++;
    this._reconnecting = true;
    const delay = Math.min(2000 * Math.pow(2, this._reconnectAttempts - 1), 15000);
    console.log(`[VR] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);

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
    console.error(`[VRBridge] ${message}`);
    if (this.onError) this.onError(message);
  }
}
