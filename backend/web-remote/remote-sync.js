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
//    running while the screen is off).
//  - Reconnect on transient network drops (3s grace period before the
//    desktop stops devices, matches scope-doc spec).
//  - Server kick (`kicked` payload): closes cleanly and surfaces a UI hook.

const STATE_THROTTLE_MS = 250;

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
    this._lastStateSent = 0;
    this._boundHandlers = null;

    this._onPlay = () => this._send({ type: 'play' });
    this._onPause = () => this._send({ type: 'pause' });
    this._onSeeked = () => this._send({ type: 'seek', at: Math.round(this._video.currentTime * 1000) });
    this._onEnded = () => this._send({ type: 'ended' });
    this._onTimeUpdate = () => this._sendStateThrottled();
    this._onVisibility = () => {
      if (document.hidden && !this._video.paused) {
        // Phone backgrounded — pause playback so devices don't keep running
        // while the WebSocket silently throttles.
        try { this._video.pause(); } catch { /* ignore */ }
      }
    };
  }

  /** Open the socket. Resolves once it's open or fails to open (best-effort). */
  start() {
    if (this._ws) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/remote/sync?videoId=${encodeURIComponent(this._videoId)}`;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    this._ws = ws;

    ws.addEventListener('open', () => {
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
    });

    ws.addEventListener('error', () => { /* 'close' will follow */ });
  }

  /** Cleanly signal disconnect and tear down. */
  stop() {
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
      paused: this._video.paused,
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
    document.addEventListener('visibilitychange', this._onVisibility);
    this._boundHandlers = true;
  }

  _detachVideoHandlers() {
    if (!this._boundHandlers) return;
    this._video.removeEventListener('play', this._onPlay);
    this._video.removeEventListener('pause', this._onPause);
    this._video.removeEventListener('seeked', this._onSeeked);
    this._video.removeEventListener('ended', this._onEnded);
    this._video.removeEventListener('timeupdate', this._onTimeUpdate);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._boundHandlers = false;
  }
}
