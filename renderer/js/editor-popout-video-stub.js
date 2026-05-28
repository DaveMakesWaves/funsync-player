// Editor pop-out — video-player stub.
//
// `ScriptEditor` was built to talk to the real `VideoPlayer` class, which
// owns an HTMLVideoElement. The pop-out window has neither — the real
// `<video>` lives in the main window. This stub fills in for VideoPlayer
// inside the pop-out by relaying every property read / method call back
// to the parent and broadcasting `timeupdate` / `playing` / `pause`
// events from inbound TIME_TICK and VIDEO_META messages.
//
// Drop-in for the surface area ScriptEditor actually touches (verified
// by grep against `videoPlayer.X` in script-editor.js):
//   - `.video` (HTMLVideoElement stub with `currentTime`, `src`,
//     `addEventListener`, `removeEventListener`)
//   - `.currentTime` (getter — reads through to `.video.currentTime`)
//   - `.duration` (getter)
//   - `.paused` (getter)
//   - `.stepFrame(direction)` / `.stepFrames(n)` (send command to parent)
//   - `.setPlaybackRate(rate)` (send command to parent)
//
// Edits to `.video.currentTime` get translated to a VIDEO_SEEK message —
// the real video element only updates on the parent side, and TIME_TICK
// echoes back. Setting currentTime is therefore optimistic: the local
// `_time` field updates immediately so the next access is consistent
// (UI doesn't lag a frame waiting for the round-trip), and the parent
// follows on the next animation frame.

import {
  TIME_TICK, VIDEO_META, VIDEO_SEEK, VIDEO_PLAY, VIDEO_PAUSE,
  VIDEO_STEP_FRAME, VIDEO_STEP_FRAMES, msg,
} from './editor-popout-protocol.js';

export class PopoutVideoPlayerStub {
  /**
   * @param {object} opts
   * @param {(payload: object) => void} opts.send — pass-through to
   *   `window.funsync.editorPopoutRelay('to-parent', payload)`. Decoupled
   *   so tests can substitute a spy.
   */
  constructor({ send }) {
    this._send = send;
    this._time = 0;          // seconds
    this._duration = 0;
    this._src = '';
    this._paused = true;
    this._playbackRate = 1;

    // EventTarget-like dispatch so `this.video.addEventListener` works.
    // ScriptEditor wires 'timeupdate', 'playing', 'pause'. The stub fires
    // these as the parent's TIME_TICK / VIDEO_META messages arrive.
    this._listeners = new Map(); // event → Set<fn>

    // Expose a `.video` property that looks enough like HTMLVideoElement
    // for the editor. Properties go through getters / setters so the
    // editor's `video.currentTime = X` translates to a seek command.
    const stub = this;
    this.video = {
      get currentTime() { return stub._time; },
      set currentTime(v) {
        stub._time = Number(v) || 0;
        stub._send(msg(VIDEO_SEEK, { time: stub._time }));
      },
      get duration() { return stub._duration; },
      get paused() { return stub._paused; },
      get src() { return stub._src; },
      get playbackRate() { return stub._playbackRate; },
      addEventListener: (event, fn) => stub._addListener(event, fn),
      removeEventListener: (event, fn) => stub._removeListener(event, fn),
    };
  }

  // === VideoPlayer interface ============================================

  get currentTime() { return this._time; }
  get duration() { return this._duration; }
  get paused() { return this._paused; }

  setPlaybackRate(rate) {
    this._playbackRate = rate;
    // Could send a VIDEO_RATE_CHANGE — but rate changes from inside the
    // editor are vanishingly rare (the user normally sets rate from the
    // main controls). Reserve a message type if user feedback shows we
    // need it.
  }

  stepFrame(direction) {
    this._send(msg(VIDEO_STEP_FRAME, { direction }));
  }

  stepFrames(n) {
    this._send(msg(VIDEO_STEP_FRAMES, { frames: n }));
  }

  // === Inbound message handlers (called by editor-popout.js) ============

  /**
   * Apply a TIME_TICK from the parent. Fires `timeupdate` to mirror what
   * the real HTMLVideoElement would do, plus 'playing' / 'pause' on
   * transition so ScriptEditor's existing event wiring works unchanged.
   */
  applyTimeTick({ time, paused }) {
    const wasPaused = this._paused;
    this._time = Number(time) || 0;
    this._paused = !!paused;
    this._fire('timeupdate');
    if (wasPaused && !this._paused) this._fire('playing');
    else if (!wasPaused && this._paused) this._fire('pause');
  }

  applyMeta({ src, duration, rate }) {
    let changed = false;
    if (src !== undefined && src !== this._src) {
      this._src = src;
      changed = true;
    }
    if (duration !== undefined && duration !== this._duration) {
      this._duration = duration;
      changed = true;
    }
    if (rate !== undefined && rate !== this._playbackRate) {
      this._playbackRate = rate;
      changed = true;
    }
    // Surface a loadedmetadata-equivalent so any consumer that re-reads
    // duration / src on the event picks up the change.
    if (changed) this._fire('loadedmetadata');
  }

  // === Private ==========================================================

  _addListener(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
  }
  _removeListener(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }
  _fire(event) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn({ type: event, target: this.video }); }
      catch (err) { console.warn('[PopoutVideoPlayerStub] listener threw:', err); }
    }
  }
}
