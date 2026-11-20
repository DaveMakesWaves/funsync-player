// AutoblowSync — Sync engine for Autoblow Ultra / VacuGlide 2
// Both device types support script upload + sync playback (like Handy HSSP).
// Mirrors SyncEngine architecture: video events → API calls.

import {
  isPictureStarved, isProxyStall, proxyStallAgeMs, ProgressWatch,
  StallGrace, STALL_RESYNC_MS, stallSummary,
} from './playback-stall.js';

export class AutoblowSync {
  /**
   * @param {object} opts
   * @param {import('./video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('./autoblow-manager.js').AutoblowManager} opts.autoblowManager
   */
  constructor({ videoPlayer, autoblowManager }) {
    this.player = videoPlayer;
    this.autoblow = autoblowManager;
    this._active = false;
    this._scriptReady = false;

    // N-01: the Autoblow plays on its own cloud clock like the Handy's HSSP,
    // so a stall that fires no 'pause' (a starved source, a seek, a media
    // error, a clock that just stops) left it running ahead of a frozen
    // picture. Why it is held, or null; same meanings as SyncEngine._held.
    this._held = null;
    this._progress = new ProgressWatch();
    this._stallTimer = null;
    this._stallPollMs = 250;
    this._now = () => performance.now();

    // A stop always wins over a late start (fix-up review 2026-11-16). Each
    // syncStart / syncStop is its own IPC call and its own HTTP request in
    // main, so the cloud applies them in the order they ARRIVE: a start sent
    // on 'playing' that answers in 1.5 s lands after a stall's stop sent at
    // 0.7 s, and the device ran through the whole stall on a frozen picture.
    // `_pauseGen` is bumped by everything that means "stand still" (pause,
    // ended, a stall's hold, stop()); `_startSeq` by every start sent;
    // `_answeredSeq` is the newest start whose answer has come back.
    this._pauseGen = 0;
    this._startSeq = 0;
    this._answeredSeq = 0;
    // `_pauseGen` when the last start was sent: equal to `_pauseGen` while
    // that start is what the device runs (no stop asked for since).
    this._runningPauseGen = -1;

    // FN-05 (Dave 2026-11-16): a stall waits STALL_GRACE_MS before it stops
    // the device (see SyncEngine). A hiccup over inside the window left the
    // device ahead by its length: summed per start (`_stallDriftSeq` is a
    // `_startSeq`), and one re-anchor start goes once it reaches
    // STALL_RESYNC_MS.
    this._grace = new StallGrace({
      now: () => this._now(),
      onExpire: (reason) => this._holdAfterGrace(reason),
    });
    this._stallDriftMs = 0;
    this._stallDriftSeq = -1;

    // FT-116, the Autoblow half (block F review, 2026-11-16; also in
    // v0.9.2): each upload is its own IPC call and HTTP PUT, and the cloud
    // keeps the last one to ARRIVE, so an old video's upload landing after
    // the new one's left the old script in the cloud under the new video.
    // Uploads now go one at a time in the order asked for; one superseded
    // before it left is never sent. app.js reads `uploadSeq` to tell "not
    // mine" from "failed".
    this._uploadSeq = 0;
    this._uploadChain = Promise.resolve();

    // Callbacks
    this.onSyncStatus = null;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._held = null;
    this._grace.end();
    this._bindVideoEvents();
    this._startStallWatch();

    if (!this.player.paused && this._scriptReady) {
      if (isPictureStarved(this.player.video)) {
        // Still loading: its 'playing' starts the device (N-01).
        this._held = 'waiting';
      } else {
        const timeMs = this.player.currentTime * 1000;
        this._sendStart(timeMs);
        this._emitStatus('synced');
      }
    }

    console.log('[AutoblowSync] Started');
  }

  stop() {
    this._active = false;
    this._scriptReady = false;
    this._endStall('stop');   // a grace timer never acts after this (FN-05)
    this._held = null;
    this._pauseGen++;   // a start still in flight re-sends this stop
    this._unbindVideoEvents();
    this._stopStallWatch();
    this.autoblow.syncStop();
    this._emitStatus('idle');
    console.log('[AutoblowSync] Stopped');
  }

  /**
   * Upload a funscript and mark as ready for sync.
   * @param {string} funscriptContent — raw JSON
   * @returns {boolean} success
   */
  async uploadScript(funscriptContent) {
    // Taken before the first await: app.js reads it right after the call.
    const seq = ++this._uploadSeq;
    const prev = this._uploadChain;
    let release;
    this._uploadChain = new Promise((r) => { release = r; });
    try {
      await prev;   // the upload before this one has reached the cloud
      if (seq !== this._uploadSeq) {
        console.log('[AutoblowSync] upload superseded before it left — not sent');
        return false;
      }
      const ok = await this.autoblow.uploadScript(funscriptContent);
      if (seq !== this._uploadSeq) {
        // A newer upload goes after this one, so the cloud ends on it; this
        // script is not the one to start.
        console.log('[AutoblowSync] upload superseded while it travelled — the newer one follows it');
        return false;
      }
      this._scriptReady = ok;
      return ok;
    } finally {
      release();
    }
  }

  get scriptReady() { return this._scriptReady; }

  /** Bumped by every uploadScript call before its first await (FT-116). */
  get uploadSeq() { return this._uploadSeq; }

  // --- Video event wiring ---

  _bindVideoEvents() {
    const v = this.player.video;
    this._onPlaying = () => this._handlePlaying();
    this._onPause = () => this._handlePause();
    this._onSeeked = () => this._handleSeeked();
    this._onEnded = () => this._handleEnded();
    // N-01: stalls that fire no 'pause' (see SyncEngine._bindVideoEvents).
    this._onWaiting = () => this._handleStall('waiting');
    this._onStalled = () => this._handleStall('stalled');
    this._onSeeking = () => this._handleStall('seeking');
    this._onError = () => this._handleStall('error');
    v.addEventListener('playing', this._onPlaying);
    v.addEventListener('pause', this._onPause);
    v.addEventListener('seeked', this._onSeeked);
    v.addEventListener('ended', this._onEnded);
    v.addEventListener('waiting', this._onWaiting);
    v.addEventListener('stalled', this._onStalled);
    v.addEventListener('seeking', this._onSeeking);
    v.addEventListener('error', this._onError);
  }

  _unbindVideoEvents() {
    const v = this.player.video;
    if (this._onPlaying) v.removeEventListener('playing', this._onPlaying);
    if (this._onPause) v.removeEventListener('pause', this._onPause);
    if (this._onSeeked) v.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) v.removeEventListener('ended', this._onEnded);
    if (this._onWaiting) v.removeEventListener('waiting', this._onWaiting);
    if (this._onStalled) v.removeEventListener('stalled', this._onStalled);
    if (this._onSeeking) v.removeEventListener('seeking', this._onSeeking);
    if (this._onError) v.removeEventListener('error', this._onError);
  }

  _handlePlaying() {
    const ep = this._grace.end();
    this._held = null;   // the picture moves
    this._progress.reset();
    if (!this._active || !this._scriptReady) {
      if (ep) this._logStall(ep, { endedBy: 'playing' });
      return;
    }
    // FN-05: a hiccup over inside its grace window: nothing was stopped and
    // the device ran on, ahead by the stall's length. One re-anchor start
    // once those add up to STALL_RESYNC_MS since the last start; nothing
    // below that. Only while our last start is what the device runs.
    if (ep && !ep.held && !ep.seeked && this._startSeq > 0 && this._runningPauseGen === this._pauseGen) {
      if (this._stallDriftSeq !== this._startSeq) {
        this._stallDriftMs = 0;
        this._stallDriftSeq = this._startSeq;
      }
      this._stallDriftMs += ep.lengthMs;
      const reanchor = this._stallDriftMs >= STALL_RESYNC_MS;
      this._logStall(ep, { reanchored: reanchor, driftMs: this._stallDriftMs });
      if (!reanchor) return;
    } else if (ep) {
      this._logStall(ep, { reanchored: true, endedBy: 'playing' });
    }
    const timeMs = this.player.currentTime * 1000;
    this._sendStart(timeMs);
    this._emitStatus('synced');
  }

  _handlePause() {
    if (!this._active) return;
    // A proxy reports a STALL as a 'pause' (the player pop-out, a headset):
    // it gets a stall's grace window, not a pause's instant stop (FN-05).
    if (isProxyStall(this.player.video)) { this._handleStall('proxy'); return; }
    this._endStall('pause');   // a real pause is instant (FN-05)
    this._held = null;
    this._pauseGen++;
    this.autoblow.syncStop();
    this._emitStatus('idle');
  }

  async _handleSeeked() {
    if (!this._active || !this._scriptReady) return;
    if (this.player.paused) return;
    this._progress.reset();
    // FN-05: a seek inside its stall's grace window stopped nothing. A
    // 'playing' still owed starts the device at the new position; a seek
    // done inside the window starts it here, once, with no stop.
    if (this._grace.open) {
      this._grace.note('seeked');
      const starved = isPictureStarved(this.player.video);
      if (starved) this._grace.note('waiting');
      if (starved || this._grace.reason === 'waiting' || this._grace.reason === 'proxy') return;
      this._logStall(this._grace.end(), { reanchored: true, endedBy: 'seeked' });
      await this._sendStart(this.player.currentTime * 1000);
      this._emitStatus('synced');
      return;
    }
    // A 'waiting' hold (N-01) already stopped the device when the seek
    // began, and the element owes a 'playing' that starts it at the new
    // position: starting here too would run it on a picture still loading.
    if (this._held === 'waiting' || this._held === 'error') return;
    const held = this._held;
    // Stop then restart at new position (awaited to avoid race)
    if (!held) await this.autoblow.syncStop();
    if (this._held !== held || this.player.paused) return;   // a hold or pause meanwhile
    this._held = null;
    const timeMs = this.player.currentTime * 1000;
    await this._sendStart(timeMs);
  }

  _handleEnded() {
    if (!this._active) return;
    this._endStall('ended');   // instant (FN-05)
    this._held = null;
    this._pauseGen++;
    this.autoblow.syncStop();
    this._emitStatus('idle');
  }

  /**
   * The picture stopped without a 'pause' (N-01): after the stall's grace
   * window (FN-05; at once for an error, a clock found frozen or a headset's
   * stall), stop the device as a pause does and let whatever ends the stall
   * start it again ('playing', a 'seeked' with no 'playing' owed, or the
   * stall watch). Inside the window nothing is sent.
   * @param {'waiting'|'stalled'|'seeking'|'error'|'frozen'|'proxy'} reason
   */
  _handleStall(reason) {
    if (!this._active) return;
    if (reason !== 'proxy' && this.player.paused) return;   // a pause is _handlePause's
    if (reason === 'stalled') {
      if (!isPictureStarved(this.player.video)) return;   // still playing from its buffer
      reason = 'waiting';
    }
    if (this._held) {
      if (reason === 'waiting') this._held = 'waiting';
      this._grace.note(reason);
      return;
    }
    if (this._grace.open) {
      this._grace.note(reason);
      if (reason === 'error' || reason === 'frozen') this._grace.expire();
      return;
    }
    const ageMs = reason === 'frozen' ? this._progress.frozenAfterMs
      : reason === 'proxy' ? proxyStallAgeMs(this.player.video) : 0;
    if (this._grace.begin(reason, { ageMs, instant: reason === 'error' })) return;
    this._holdNow(reason);
  }

  /** The grace window ran out (its timer, or an error inside it). */
  _holdAfterGrace(reason) {
    if (!this._active) return;
    this._holdNow(reason);
  }

  /** Stop the device for a stall past its window (N-01's hold). */
  _holdNow(reason) {
    this._held = reason;
    this._pauseGen++;
    console.log(`[AutoblowSync] picture stopped (${reason}) — past the grace window, holding the device until it moves`);
    this.autoblow.syncStop();
    this._emitStatus('idle');
  }

  /**
   * Send a start, and make a stop that came in while it travelled win.
   * Never rejects (callers do not await it, and it sits on event handlers).
   *
   * When the answer comes back and nothing stopped the device meanwhile,
   * that is that. Otherwise the stop sent meanwhile may have reached the
   * cloud BEFORE this start, so:
   *  - the device should still stand (paused, ended, held, stopped), or
   *    nothing has started it since: send the stop again;
   *  - a newer start owns it and is still travelling: it left after the
   *    stop and will most likely land after this one, so stand down;
   *  - a newer start already answered: this stale one may have landed
   *    after it and left the device on an old position, so anchor again
   *    where the picture is now. (No 2.5 s correction exists here to
   *    heal that, unlike the Handy.)
   * @param {number} timeMs
   */
  async _sendStart(timeMs) {
    const seq = ++this._startSeq;
    const pauseGen = this._pauseGen;
    this._runningPauseGen = pauseGen;
    try {
      await this.autoblow.syncStart(timeMs);
      const newerAnswered = this._answeredSeq > seq;
      if (seq > this._answeredSeq) this._answeredSeq = seq;
      if (pauseGen === this._pauseGen) return;
      if (this._wantsDeviceStopped() || seq === this._startSeq) {
        console.log('[AutoblowSync] start superseded by a stop while in flight — re-sending stop');
        await this.autoblow.syncStop();
        return;
      }
      if (!newerAnswered) return;
      console.log('[AutoblowSync] a late start may have landed after the newer one — anchoring again');
      await this._sendStart(this.player.currentTime * 1000);
    } catch (err) {
      console.warn('[AutoblowSync] start failed:', err?.message || err);
    }
  }

  /** Paused, ended, held on a stall or stopped: the device should stand. */
  _wantsDeviceStopped() {
    return !this._active || this._held !== null || !!this.player.paused
      || this.player.video?.ended === true;
  }

  // Stall watch: the clock stopped with no event at all (see SyncEngine).
  _startStallWatch() {
    if (this._stallTimer) return;
    this._progress.reset();
    // Bare call: a stored browser timer called as a method throws
    // "Illegal invocation" in Chromium.
    this._stallTimer = setInterval(() => this._checkProgress(), this._stallPollMs);
  }

  _stopStallWatch() {
    if (this._stallTimer) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
    this._progress.reset();
  }

  _checkProgress() {
    if (!this._active) return;
    const paused = !!this.player.paused;
    const frozen = this._progress.sample(Number(this.player.currentTime), paused, this._now());
    if (paused || !this._scriptReady) return;
    if (frozen && !this._held) this._handleStall('frozen');
    else if (!frozen && this._held === 'frozen') this._handlePlaying();
  }

  /** End a stall (if any) without a start: a pause, an end, stop() (FN-05). */
  _endStall(endedBy) {
    const ep = this._grace.end();
    if (ep) this._logStall(ep, { endedBy });
  }

  /** The one line a stall leaves (FN-05): length, held or not, re-anchored or not. */
  _logStall(ep, opts = {}) {
    if (!ep) return;
    console.log(`[AutoblowSync] ${stallSummary(ep, opts)}`);
  }

  _emitStatus(status) {
    if (this.onSyncStatus) this.onSyncStatus(status);
  }
}
