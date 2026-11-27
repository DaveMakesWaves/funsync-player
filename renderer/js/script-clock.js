// ScriptClock — the script player's own clock (v0.10.1; powerkool on EroScripts:
// "play ... scripts that aren't associated with a video" and "keep a script
// playing while allowing one to view other videos").
//
// A stand-in <video> for the sync engines, as RemotePlaybackProxy is for the
// phone: currentTime runs on the wall clock while playing, and the engines
// listen for the same events ('playing', 'pause', 'seeked', 'ended'). Nothing
// here drives a device; the engines bound to it do.
//
// At the end: with loop on it starts again from 0 (a 'seeked', so the Handy
// re-anchors); with loop off (Dave: "loop off by default") it pauses at the
// end and fires 'ended'.

export class ScriptClock extends EventTarget {
  /**
   * @param {{ now?: () => number, setTimer?: Function, clearTimer?: Function }} [deps]
   */
  constructor({ now, setTimer, clearTimer } = {}) {
    super();
    this._now = now || (() => performance.now());
    this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = clearTimer || ((id) => clearTimeout(id));
    this._t = 0;            // seconds, at wall time _at
    this._at = 0;
    this._paused = true;
    this._duration = 0;
    this._ended = false;
    this._endTimer = null;
    this.loop = false;
    // What the engines' stall checks read on a stand-in (never a picture to starve).
    this.stalled = false;
  }

  get currentTime() {
    if (this._paused) return this._t;
    const t = this._t + (this._now() - this._at) / 1000;
    return this._duration > 0 ? Math.min(t, this._duration) : t;
  }

  /** Assigning moves the clock without an event (as a video's would before 'seeked'). */
  set currentTime(v) {
    this._t = this._clamp(v);
    this._at = this._now();
  }

  get duration() { return this._duration; }
  set duration(d) { this._duration = Number.isFinite(d) && d > 0 ? d : 0; }
  get paused() { return this._paused; }
  get sourcePaused() { return this._paused; }
  get ended() { return this._ended; }
  get playbackRate() { return 1; }

  play() {
    if (!this._paused) return Promise.resolve();
    // Play at the end starts again from the top.
    if (this._duration > 0 && this._t >= this._duration - 0.05) this._t = 0;
    this._ended = false;
    this._paused = false;
    this._at = this._now();
    this._armEnd();
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }

  pause() {
    if (this._paused) return;
    this._t = this.currentTime;
    this._at = this._now();
    this._paused = true;
    this._disarmEnd();
    this.dispatchEvent(new Event('pause'));
  }

  /** @param {number} seconds */
  seek(seconds) {
    this._t = this._clamp(seconds);
    this._at = this._now();
    this._ended = false;
    if (!this._paused) this._armEnd();
    this.dispatchEvent(new Event('seeked'));
  }

  /** Back to an empty, paused clock. */
  reset() {
    this._disarmEnd();
    this._t = 0;
    this._at = 0;
    this._paused = true;
    this._duration = 0;
    this._ended = false;
  }

  _clamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return this._duration > 0 ? Math.min(n, this._duration) : n;
  }

  _armEnd() {
    this._disarmEnd();
    if (this._paused || !(this._duration > 0)) return;
    const ms = Math.max(0, (this._duration - this.currentTime) * 1000);
    this._endTimer = this._setTimer(() => this._onEnd(), ms + 5);
  }

  _disarmEnd() {
    if (this._endTimer != null) {
      this._clearTimer(this._endTimer);
      this._endTimer = null;
    }
  }

  _onEnd() {
    this._endTimer = null;
    if (this._paused) return;
    if (this.loop) {
      this._t = 0;
      this._at = this._now();
      this._armEnd();
      this.dispatchEvent(new Event('seeked'));
      return;
    }
    this._t = this._duration;
    this._at = this._now();
    this._paused = true;
    this._ended = true;
    this.dispatchEvent(new Event('pause'));
    this.dispatchEvent(new Event('ended'));
  }

  /** The VideoPlayer-like shape the sync engines read (`.video` for events). */
  asVideoPlayerWrapper() {
    const clock = this;
    return {
      video: clock,
      get currentTime() { return clock.currentTime; },
      get paused() { return clock.paused; },
      get duration() { return clock.duration; },
      get playbackRate() { return 1; },
    };
  }
}
