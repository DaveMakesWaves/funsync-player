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

// While the headset is PAUSED (the last packet said so) on a link that has
// received, a longer silence is allowed before teardown (FT-053, 2026-11-06;
// also in v0.9.2). Nothing is driven while paused (the devices are stopped),
// and whether HereSphere keeps sending while paused is not known, so 8 s
// dropped the link on any longer pause (a likely cause of #343's drops). A
// dead socket still shows as a close or a keep-alive write error. The first
// packet's window and a playing link keep LIVENESS_TIMEOUT_MS.
const PAUSED_LIVENESS_TIMEOUT_MS = 60000;

import { t } from './i18n.js';

// FunSync's own content server names a video by its registry id, never by
// file: the stream URL `/api/media/stream/{id}` and the scene URLs
// `/heresphere/{id}`, `/deovr/{id}`, where id = md5(path)[:12]
// (backend/routes/media.py `_path_to_id`). When a headset streaming from
// FunSync reports one of those as the playing path, its last segment is the
// id, which no file name matches (V63). Followed by `/`, `?`, `#` or the end,
// so a real file called `<12 hex>.mp4` in a folder named `deovr` is not one.
const FUNSYNC_VIDEO_URL_RE = /\/(?:api\/media\/stream|heresphere|deovr)\/([0-9a-f]{12})(?=[/?#]|$)/i;

/**
 * The registry id in a FunSync stream / scene URL, or null for anything else
 * (a file path, an XBVR or DLNA URL).
 * @param {string} rawPath
 * @returns {string|null}
 */
export function funsyncVideoIdFromVRPath(rawPath) {
  const m = FUNSYNC_VIDEO_URL_RE.exec(String(rawPath || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The name to SHOW for a headset-reported path: its file name, URL-decoded,
 * query dropped. Never the normalised match key `onVideoChanged` passes
 * first ("vr tagged 180 lr"), which the VR modal used to display (V66).
 * @param {string} rawPath
 * @param {string} [fallback]
 * @returns {string}
 */
export function vrDisplayName(rawPath, fallback = '') {
  let s = String(rawPath || '');
  if (s.includes('://')) {
    try { s = new URL(s).pathname; } catch { /* keep as-is */ }
  }
  let base = s.split(/[\\/]/).pop() || '';
  try { base = decodeURIComponent(base); } catch { /* keep as-is */ }
  return base || fallback || '';
}

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
    // Whether THIS link (since the last successful connect) has had a state
    // packet (FT-054). A TCP connect alone proves only that something
    // accepted on the port; app.js treats the first packet as the working
    // link (backoff reset, toast, saved host) and a teardown of a link that
    // never received as a failed attempt. Kept after a teardown, so
    // onDisconnect can read what the ended link did; reset on the next
    // successful connect.
    this._received = false;

    // Callbacks
    this.onConnect = null;
    this.onDisconnect = null;
    this.onFirstPacket = null;    // () => {} — once per link, on its first state packet
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
    //
    // A coalesced caller gets the in-flight attempt's real outcome. It
    // used to get `false`, which every caller reads as a failed dial: the
    // activity poll counted it toward the 8 s backoff, and a Connect click
    // during a background dial said "failed" without dialing (V24).
    const target = { host: host || '127.0.0.1', port: port || 23554 };
    if (this._connecting) {
      const inFlight = this._connectPromise;
      const t0 = this._connectTarget;
      if (t0.host === target.host && t0.port === target.port) return inFlight;
      // A different host (the user typed one while a background dial was
      // running): let that attempt finish, then make this one.
      await inFlight;
      if (this._connected && this._host === target.host && this._port === target.port) return true;
      return this.connect(playerType, host, port);
    }
    this._connecting = true; // before any await, so a second call coalesces
    this._connectTarget = target;
    this._connectPromise = this._connect(playerType, host, port);
    return this._connectPromise;
  }

  async _connect(playerType, host, port) {
    try {
      if (this._connected) await this.disconnect();

      this._playerType = playerType || 'deovr';
      this._host = host || '127.0.0.1';
      this._port = port || 23554;
      this._intentionalDisconnect = false;

      const result = await window.funsync.vrConnect(this._host, this._port);
      if (result.success) {
        this._connected = true;
        this._received = false; // a new link: nothing from it yet (FT-054)
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
        this._emitError(result.error || t('error.connectionFailed'));
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

  /**
   * Ask the VR player to pause (Stop all, DESIGN.md §2.15). The same field
   * the player pushes (`playerState`: 0 playing, 1 paused), sent back the way
   * `seek` sends `currentTime`. Not yet checked on a headset (hardware list);
   * a player that ignores it is caught by Stop all's hold.
   * @returns {boolean} whether it was sent
   */
  pause() {
    if (!this._connected) return false;
    window.funsync.vrSend(JSON.stringify({ playerState: 1 }));
    return true;
  }

  get connected() { return this._connected; }
  /**
   * The current link (or, once torn down, the last one) has had a state
   * packet. False from a successful connect until its first packet.
   */
  get received() { return this._received; }
  /** A connect() is in flight. */
  get connecting() { return this._connecting; }
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
    // Nothing from this link yet: waiting, not receiving. connect() seeds
    // `_lastArrivalMs` to now for the watchdog only, so a link that had sent
    // nothing read "receiving timestamps" for its first 5 s, retries to a
    // quiet headset included (block C verifier 2; also in v0.9.2).
    if (!this._received) return 'waiting';
    const sinceLastPacket = Date.now() - this._lastArrivalMs;
    return sinceLastPacket < 5000 ? 'receiving' : 'waiting';
  }

  // --- Internal ---

  _bindListeners() {
    // Never stack a second pair: each on*() call adds an ipcRenderer
    // listener, and overwriting the cleanup handles orphans the old one,
    // which then keeps handling packets after an intentional Disconnect (V20).
    this._unbindListeners();
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
    // This link is over: release its IPC listeners. connect() only calls
    // disconnect() (the other place that unbinds) while still connected,
    // so a close or a watchdog teardown used to leave them bound (V20).
    this._unbindListeners();
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

    // The first packet of this link: it is a working link now (FT-054).
    // app.js hears of it once the packet has been handled (below).
    const firstPacket = this._connected && !this._received;
    if (firstPacket) this._received = true;

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

    if (firstPacket && this.onFirstPacket) {
      try { this.onFirstPacket(); } catch (err) { console.warn('[VR] first-packet handler failed:', err?.message || err); }
    }
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
   * LIVENESS_TIMEOUT_MS (PAUSED_LIVENESS_TIMEOUT_MS while the headset is
   * paused on a link that has received) we treat the connection as
   * silently dead and synthesise a disconnect. The activity poll then
   * decides when to try again.
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
      // Paused on a link that has received: the longer window (FT-053).
      // Before the first packet the proxy reads paused too (its initial
      // state), so `_received` keeps the first-packet window at 8 s.
      const limit = this._received && this.proxy.paused ? PAUSED_LIVENESS_TIMEOUT_MS : LIVENESS_TIMEOUT_MS;
      if (sinceLastPacket > limit) {
        console.warn(`[VR] Liveness timeout — no packet in ${sinceLastPacket}ms${limit === PAUSED_LIVENESS_TIMEOUT_MS ? ' (paused)' : ''}; tearing down`);
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
