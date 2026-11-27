// StreamStatus — what a streamed video is doing, over the picture
// (2026-11-23, the streaming UX pass).
//
//   "Starting the stream…"  from the load until the first frame (a Watch used
//                           to land on a black player for up to 20 s);
//   "Loading…"              when it stops to load for more than 400 ms;
//   "Reconnecting…"         while an expired link is looked up again.
//
// The card sits in the middle of the picture and lets every click through
// (pointer-events: none), so Pause and Back still work under it. It also
// counts the stops: three within a minute (a seek's own wait not counted)
// calls onRepeatedStalls once per stream, so the app can offer a lower
// quality. Local files never show it: begin() is called for streams only.

import { t } from '../js/i18n.js';

export const STALL_SHOW_AFTER_MS = 400;
export const STALL_WINDOW_MS = 60_000;
export const STALL_OFFER_AT = 3;
/** A wait this soon after a seek is the seek's own: not counted. */
export const SEEK_QUIET_MS = 2_000;

/** Stops within the last minute. */
export class StallCounter {
  constructor() { this._at = []; }
  note(now) {
    this._at = this._at.filter((x) => now - x < STALL_WINDOW_MS);
    this._at.push(now);
    return this._at.length;
  }
  reset() { this._at = []; }
}

export class StreamStatus {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {HTMLElement} opts.el                #stream-status
   * @param {() => void} [opts.onRepeatedStalls]
   * @param {() => number} [opts.now]
   */
  constructor({ video, el, onRepeatedStalls = null, now = () => Date.now() }) {
    this.video = video;
    this.el = el;
    this.onRepeatedStalls = onRepeatedStalls;
    this._now = now;
    this._active = false;
    this._starting = false;
    this._offered = false;
    this._seekAt = -Infinity;
    this._timer = null;
    this._stalls = new StallCounter();
    this._text = el?.querySelector('.stream-status__text') || null;
    if (video) {
      video.addEventListener('waiting', () => this._onWaiting());
      video.addEventListener('playing', () => this._ready());
      video.addEventListener('canplay', () => { if (this.video.paused) this._ready(); });
      video.addEventListener('seeking', () => { this._seekAt = this._now(); });
    }
  }

  get active() { return this._active; }
  get shown() { return !!this.el && !this.el.hidden; }

  /** A stream starts: shown until its first frame. */
  begin() {
    this._active = true;
    this._starting = true;
    this._offered = false;
    this._stalls.reset();
    this._show('starting');
  }

  /** Not a stream any more (a local file, the player closed). */
  end() {
    this._active = false;
    this._starting = false;
    clearTimeout(this._timer);
    this._hide();
  }

  /** The link is being looked up again (an expired or lost stream). */
  reconnecting() {
    if (!this._active) return;
    clearTimeout(this._timer);
    this._show('reconnecting');
  }

  _onWaiting() {
    if (!this._active || this._starting) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (this._active && this.video.readyState < 3) this._show('loading');
    }, STALL_SHOW_AFTER_MS);
    const now = this._now();
    if (now - this._seekAt < SEEK_QUIET_MS) return;
    if (this._stalls.note(now) >= STALL_OFFER_AT && !this._offered) {
      this._offered = true;
      this.onRepeatedStalls?.();
    }
  }

  _ready() {
    if (!this._active) return;
    this._starting = false;
    clearTimeout(this._timer);
    this._hide();
  }

  _show(kind) {
    if (!this.el) return;
    if (this._text) this._text.textContent = t(`player.stream.${kind}`);
    this.el.dataset.kind = kind;
    this.el.hidden = false;
  }

  _hide() {
    if (this.el) this.el.hidden = true;
  }
}
