// Phone-side WebSocket client for device sync.
//
// Opens /api/remote/sync when a video starts, streams the phone's <video>
// element state (play / pause / seek / throttled timeupdate / ended) to the
// backend. The desktop's sync engines bind to our state and drive connected
// devices.
//
// Handles:
//  - Visibility change: pauses devices when the phone is backgrounded (iOS
//    / Android throttle WebSocket activity aggressively — don't leave toys
//    running while the screen is off). Also checked on `play` itself: a
//    page that is ALREADY hidden when playback starts never gets a
//    visibilitychange transition, so the event alone is not enough.
//  - Buffering stalls: `state.paused` reports EFFECTIVE playback (paused
//    OR seeking OR starved buffer), not just `video.paused`. During a
//    network seek the element stops firing timeupdate while `paused`
//    stays false — without this the desktop proxy extrapolates through
//    the stall and devices play a timeline the video has already left.
//  - Reconnect on transient network drops with capped backoff (the
//    desktop side has its own 3s grace before stopping devices).
//  - Server kick (`kicked` payload): closes cleanly and surfaces a UI hook.

const STATE_THROTTLE_MS = 250;
const RECONNECT_MAX_MS = 10000;

export class RemoteSyncClient {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video    phone's <video> element
   * @param {string}           opts.videoId  backend's id for this video
   * @param {(msg:object)=>void} [opts.onServerMessage]  device-status / script-* etc.
   * @param {()=>void}         [opts.onKicked]
   */
  constructor({ video, videoId, onServerMessage, onKicked }) {
    this._video = video;
    this._videoId = videoId;
    this._onServerMessage = onServerMessage || (() => {});
    this._onKicked = onKicked || (() => {});

    this._ws = null;
    this._kicked = false;
    this._stopped = false;
    this._retries = 0;
    this._retryTimer = null;
    this._lastStateSent = 0;
    this._boundHandlers = null;

    this._onPlay = () => {
      // The visibilitychange guard below only fires on a TRANSITION; a page
      // that is already hidden when play() lands never sees one, and Chrome
      // starves timeupdate in hidden pages — the desktop would extrapolate
      // stale state with nothing correcting it. Refuse to start hidden.
      if (typeof document !== 'undefined' && document.hidden) {
        try { this._video.pause(); } catch { /* ignore */ }
        return;
      }
      this._send({ type: 'play' });
    };
    this._onPause = () => this._send({ type: 'pause' });
    this._onSeeked = () => this._send({ type: 'seek', at: Math.round(this._video.currentTime * 1000) });
    this._onEnded = () => this._send({ type: 'ended' });
    this._onTimeUpdate = () => this._sendStateThrottled();
    // Stall transitions bypass the throttle: they are rare, and each one
    // flips the effective-paused bit the desktop uses to stop/start devices.
    this._onStallChange = () => this._sendState();
    this._onVisibility = () => {
      if (document.hidden && !this._video.paused) {
        // Phone backgrounded — pause playback so devices don't keep running
        // while the WebSocket silently throttles.
        try { this._video.pause(); } catch { /* ignore */ }
      } else if (!document.hidden && !this._ws && !this._stopped && !this._kicked) {
        // Back on screen with a dead socket — reconnect immediately rather
        // than waiting out the backoff timer.
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        this.start();
      }
    };
  }

  /** Open the socket. Resolves once it's open or fails to open (best-effort). */
  start() {
    if (this._ws) return;
    // The visibility guard outlives any one socket: it pauses on hide and
    // drives reconnect on unhide, so it must NOT die with the connection.
    if (!this._visibilityBound && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
      this._visibilityBound = true;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/remote/sync?videoId=${encodeURIComponent(this._videoId)}`;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._retries = 0;
      ws.send(JSON.stringify({
        type: 'hello',
        videoId: this._videoId,
        duration: isFinite(this._video.duration) ? this._video.duration : 0,
      }));
      this._attachVideoHandlers();
      // Seed the initial state in case the video is already playing.
      this._sendState();
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'kicked') {
        this._kicked = true;
        this._onKicked(msg.reason || 'Disconnected');
        return;
      }
      this._onServerMessage(msg);
    });

    ws.addEventListener('close', () => {
      this._detachVideoHandlers();
      this._ws = null;
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => { /* 'close' will follow */ });
  }

  /**
   * Capped-backoff reconnect after an unexpected close. A Wi-Fi blip or an
   * OS-killed socket used to end device sync silently for the rest of the
   * video — playback carried on, devices sat dead, and only exiting and
   * reopening the video restored sync. Kicks and deliberate stop() never
   * reconnect; hidden pages wait for the visibility handler instead (the
   * socket would just be throttled into uselessness anyway).
   */
  _scheduleReconnect() {
    if (this._stopped || this._kicked || this._retryTimer) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const delay = Math.min(1000 * 2 ** this._retries, RECONNECT_MAX_MS);
    this._retries++;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this._stopped && !this._kicked && !this._ws) this.start();
    }, delay);
  }

  /**
   * Tell the desktop to switch to a different funscript variant for the
   * currently-playing video. Fire-and-forget — the desktop performs the
   * switch (loads the script, re-uploads to Handy, etc.) and broadcasts
   * a `variant-changed` reply that `onServerMessage` receives. The UI
   * should treat this as a request and only reflect the change after
   * the reply arrives.
   */
  switchVariant(label) {
    if (typeof label !== 'string' || !label) return;
    this._send({ type: 'switch-variant', label });
  }

  /**
   * Orgasm Switch remote trigger (F2). Hold mode: active=true on press,
   * false on release. Toggle mode: send active=true per tap — the
   * desktop's mode handler flips start/stop itself (single source of
   * truth; the `orgasm-state` broadcast keeps the button honest).
   */
  sendOrgasmHold(active) {
    this._send({ type: 'orgasm-hold', active: !!active });
  }

  /**
   * Per-device offset adjustment from the phone (F4). `device` is the
   * kind key the desktop's device-status list uses (handy/buttplug/
   * tcode/autoblow); ms is clamped desktop-side (untrusted LAN input).
   */
  sendSetOffset(device, ms) {
    if (typeof device !== 'string' || !device) return;
    this._send({ type: 'set-offset', device, ms: Math.round(Number(ms) || 0) });
  }

  /** Cleanly signal disconnect and tear down. */
  stop() {
    this._stopped = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._visibilityBound) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._visibilityBound = false;
    }
    this._detachVideoHandlers();
    if (this._ws) {
      try {
        if (this._ws.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({ type: 'bye' }));
        }
        this._ws.close();
      } catch { /* ignore */ }
      this._ws = null;
    }
  }

  get kicked() { return this._kicked; }

  // --- internals -------------------------------------------------------

  _send(payload) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try { this._ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }

  _sendState() {
    if (!this._video) return;
    this._lastStateSent = performance.now();
    this._send({
      type: 'state',
      at: Math.round(this._video.currentTime * 1000),
      // Effective playback, not the element's `paused` bit: during a seek
      // or buffer starvation `paused` stays false while no frames advance.
      // Reporting that honestly is what lets the desktop stop devices
      // instead of extrapolating through the stall. readyState < 3 is
      // HAVE_CURRENT_DATA or worse — nothing to advance into.
      paused: this._video.paused || this._video.seeking || this._video.readyState < 3,
      rate: this._video.playbackRate || 1,
      duration: isFinite(this._video.duration) ? this._video.duration : 0,
    });
  }

  _sendStateThrottled() {
    const now = performance.now();
    if (now - this._lastStateSent < STATE_THROTTLE_MS) return;
    this._sendState();
  }

  _attachVideoHandlers() {
    if (this._boundHandlers) return;
    this._video.addEventListener('play', this._onPlay);
    this._video.addEventListener('pause', this._onPause);
    this._video.addEventListener('seeked', this._onSeeked);
    this._video.addEventListener('ended', this._onEnded);
    this._video.addEventListener('timeupdate', this._onTimeUpdate);
    // Stall boundaries: timeupdate stops during these, so each must push a
    // state itself or the desktop never learns playback isn't advancing.
    this._video.addEventListener('seeking', this._onStallChange);
    this._video.addEventListener('waiting', this._onStallChange);
    this._video.addEventListener('stalled', this._onStallChange);
    this._video.addEventListener('playing', this._onStallChange);
    this._video.addEventListener('canplay', this._onStallChange);
    this._boundHandlers = true;
  }

  _detachVideoHandlers() {
    if (!this._boundHandlers) return;
    this._video.removeEventListener('play', this._onPlay);
    this._video.removeEventListener('pause', this._onPause);
    this._video.removeEventListener('seeked', this._onSeeked);
    this._video.removeEventListener('ended', this._onEnded);
    this._video.removeEventListener('timeupdate', this._onTimeUpdate);
    this._video.removeEventListener('seeking', this._onStallChange);
    this._video.removeEventListener('waiting', this._onStallChange);
    this._video.removeEventListener('stalled', this._onStallChange);
    this._video.removeEventListener('playing', this._onStallChange);
    this._video.removeEventListener('canplay', this._onStallChange);
    this._boundHandlers = false;
  }
}
