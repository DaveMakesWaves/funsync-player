// playback-stall — is the picture actually moving? (N-01, 2026-11-16)
//
// The picture can stop with `paused` still false, and nothing then fires a
// 'pause': a starved source (a slow or sleeping drive, a source that went
// offline) fires 'waiting' with readyState <= 2, a seek freezes the frame
// until 'seeked', a media error stops playback, and the player pop-out kept
// reporting `paused: false` with a frozen time. A device that plays on its
// OWN clock (the Handy's HSSP, the Autoblow) ran on through every one of
// those, up to 15 s ahead of the frozen picture, then snapped back on
// 'playing' (Dave 2026-11-08: "the handy now doesnt always pause with the
// video escpecially if its buffering"; reproduced 2026-11-16, notes/fix-test-
// list-2026-11-05.md N-01).
//
// Two answers, both pure so the engines, the pop-out and the tests share
// them:
//   - isPictureStarved(video): what the element itself says (the phone's
//     remote-sync.js has used the same test since 2026-08-18);
//   - ProgressWatch: a backstop for a clock that stops moving with no event
//     at all (a frozen decoder, a window feeding a frozen time).

/** HTMLMediaElement.HAVE_FUTURE_DATA: below it there is no next frame. */
export const HAVE_FUTURE_DATA = 3;

/**
 * True when the element is NOT paused but cannot move: seeking, starved
 * (readyState below HAVE_FUTURE_DATA) or stopped by a media error. A paused
 * element is never "starved": a pause is its own answer.
 *
 * An object without a numeric readyState (a playback proxy, a test double)
 * is judged by `seeking` / `error` alone, so a proxy is never held on a
 * readyState it does not have.
 *
 * @param {{paused?: boolean, seeking?: boolean, readyState?: number, error?: any}|null} video
 */
export function isPictureStarved(video) {
  if (!video || video.paused) return false;
  if (video.seeking) return true;
  if (video.error) return true;
  return typeof video.readyState === 'number' && video.readyState < HAVE_FUTURE_DATA;
}

/** No progress for this long while playing = frozen. */
export const FROZEN_AFTER_MS = 1000;
/** Less movement than this is no movement (an interpolating proxy wobbles). */
export const MIN_ADVANCE_SEC = 0.1;

/**
 * Tracks whether a clock that should be moving is moving. Feed it a sample at
 * any cadence; it answers true once the time has stayed within
 * MIN_ADVANCE_SEC of where it was for FROZEN_AFTER_MS of wall time while not
 * paused. Any move of MIN_ADVANCE_SEC or more, either way (a seek or a loop),
 * starts a new window, so a seek is not mistaken for a freeze until it has
 * itself sat still for the whole window.
 *
 * Measured against where the window STARTED, not the previous sample: a
 * proxy fed a frozen time every 100 ms interpolates up to 0.1 s and is reset
 * by each tick, so every sample differs from the last while the clock goes
 * nowhere. The minimum rate this tolerates is MIN_ADVANCE_SEC per
 * FROZEN_AFTER_MS (0.1x); the app's slowest rate is 0.25x.
 */
export class ProgressWatch {
  constructor({ frozenAfterMs = FROZEN_AFTER_MS, minAdvanceSec = MIN_ADVANCE_SEC } = {}) {
    this._frozenAfterMs = frozenAfterMs;
    this._minAdvanceSec = minAdvanceSec;
    this.reset();
  }

  /** How long a clock must stand before it counts as frozen. */
  get frozenAfterMs() { return this._frozenAfterMs; }

  /** Forget the window (a pause, a stop, a new video). */
  reset() {
    this._anchorTime = null;
    this._anchorWallMs = 0;
  }

  /**
   * @param {number} timeSec  the clock's current time
   * @param {boolean} paused  a paused (or otherwise accounted-for) clock is never frozen
   * @param {number} nowMs    wall time (performance.now())
   * @returns {boolean} true while the clock is frozen
   */
  sample(timeSec, paused, nowMs) {
    if (paused || !Number.isFinite(timeSec)) { this.reset(); return false; }
    // (1e-9: 5.1 - 5 is 0.0999... in floating point.)
    if (this._anchorTime === null || Math.abs(timeSec - this._anchorTime) >= this._minAdvanceSec - 1e-9) {
      this._anchorTime = timeSec;
      this._anchorWallMs = nowMs;
      return false;
    }
    return nowMs - this._anchorWallMs >= this._frozenAfterMs;
  }
}

// --- FN-05 (2026-11-16): a grace window on every stall
//
// N-01 stopped the Handy the instant the picture stalled, and FN-02 turned
// every sustained Buttplug / T-Code output off the same way, so a hiccup of a
// few frames (Chromium fires 'waiting' / 'playing' on every seek while playing
// and on a drive that blinks) made the devices stutter: stop, then play again
// 100 ms later (Dave 2026-11-16, notes/fix-test-list-2026-11-05.md FN-05).
// Now a stall ('waiting', a 'stalled' with no frames, a seek while playing, a
// proxy's stall) opens a window of STALL_GRACE_MS and NOTHING goes to a device
// inside it. The picture moving again inside it ends the stall with no stop:
//   - an HSSP / Autoblow device ran on, ahead of the picture by the stall's
//     length; that is added to a per-anchor total, and ONE re-anchor play at
//     the picture's time goes out once the total reaches STALL_RESYNC_MS
//     (never a stop and a play); a fresh anchor starts a new total;
//   - a seek that completed inside the window sends one play at the new
//     position;
//   - a tick-driven engine just carries on (position devices need nothing).
// Past the window the hold is what it was before (stop, then one play on
// 'playing'). A media error, and a clock found frozen (the watch has already
// waited FROZEN_AFTER_MS) or a headset's stall (the proxy waited 2 s), are past
// the window when they are seen and hold at once. Pause, end, a video change,
// Stop and a disconnect are instant and end the window: its timer is
// generation-guarded and never acts after them.

/** No device is stopped for a stall shorter than this (FN-05). One constant, for tuning from Dave's drive. */
export const STALL_GRACE_MS = 500;
/** A cloud-clock device is re-anchored once the stalls it ran through (in the window) add up to this. */
export const STALL_RESYNC_MS = 100;

/**
 * How long a proxy's picture had already stood when it reported the stall:
 * the headset proxy reports one only after its time stood 2 s; the pop-out's
 * proxy reports at once (no field).
 * @param {{stallAgeMs?: number}|null} video
 */
export function proxyStallAgeMs(video) {
  const age = Number(video?.stallAgeMs);
  return Number.isFinite(age) && age > 0 ? age : 0;
}

/**
 * The one log line a stall leaves when it ends (FN-05): its length, held or
 * not, re-anchored or not. No keys, no paths.
 * @param {{reason: string, lengthMs: number, held: boolean, seeked: boolean}} ep
 * @param {{reanchored?: boolean|null, driftMs?: number|null, endedBy?: string}} [o]
 */
export function stallSummary(ep, { reanchored = null, driftMs = null, endedBy = '' } = {}) {
  const parts = [`stall ${Math.round(ep.lengthMs)} ms (${ep.reason}${ep.seeked && ep.reason !== 'seeking' ? ' + seek' : ''})`];
  parts.push(ep.held ? `held (past the ${STALL_GRACE_MS} ms window)` : `not held (inside the ${STALL_GRACE_MS} ms window)`);
  if (reanchored !== null) parts.push(reanchored ? 're-anchored' : 'no re-anchor');
  if (driftMs !== null && Number.isFinite(driftMs)) parts.push(`drift total ${Math.round(driftMs)} of ${STALL_RESYNC_MS} ms`);
  if (endedBy) parts.push(`ended by ${endedBy}`);
  return parts.join(', ');
}

/**
 * One stall, from the picture stopping to its end, with the grace window
 * (FN-05). Shared by SyncEngine, AutoblowSync and StallHold; the engine
 * decides what each moment sends.
 *
 * `begin()` opens the window (or starts held, past it already); the window
 * running out calls `onExpire(reason)` once, from a timer called bare (never
 * a stored browser timer called as a method: "Illegal invocation") and
 * guarded by a generation `end()` bumps, so it never acts after the engine
 * ended the stall (a pause, a stop, a new video, the picture moving).
 */
export class StallGrace {
  /**
   * @param {object} [o]
   * @param {number} [o.graceMs]
   * @param {() => number} [o.now] wall clock (performance.now())
   * @param {(reason: string) => void} [o.onExpire]
   */
  constructor({ graceMs = STALL_GRACE_MS, now, onExpire } = {}) {
    this._graceMs = graceMs;
    this._now = now || (() => performance.now());
    this._onExpire = onExpire || null;
    this._gen = 0;
    this._timer = null;
    this._ep = null;   // { reason, startMs, seeked, held }
  }

  get graceMs() { return this._graceMs; }
  /** A stall is in progress (inside the window, or held past it). */
  get active() { return this._ep !== null; }
  /** Inside the window: the picture stopped and nothing has been sent for it. */
  get open() { return this._ep !== null && !this._ep.held; }
  /** Past the window: the engine holds the device. */
  get held() { return !!this._ep?.held; }
  /** 'waiting' (a 'playing' is owed), 'seeking', 'stalled', 'error', 'frozen' or 'proxy'. */
  get reason() { return this._ep?.reason ?? null; }
  /** A seek happened during the stall: the device needs the new position. */
  get seeked() { return !!this._ep?.seeked; }
  /** The window has run out by the clock (a tick may notice before the timer). */
  get due() { return this.open && this._now() - this._ep.startMs >= this._graceMs; }

  /**
   * A stall began.
   * @param {string} reason
   * @param {{ageMs?: number, instant?: boolean}} [o] - `ageMs`: how long the
   *   picture had already stood; `instant`: no window at all (an error)
   * @returns {boolean} true when the window opened; false when the stall is
   *   past it already, and the caller holds now (onExpire is not called)
   */
  begin(reason, { ageMs = 0, instant = false } = {}) {
    this._cancelTimer();
    const age = Math.max(0, Number(ageMs) || 0);
    this._ep = { reason, startMs: this._now() - age, seeked: reason === 'seeking', held: false };
    if (instant || age >= this._graceMs) {
      this._ep.held = true;
      return false;
    }
    const gen = this._gen;
    this._timer = setTimeout(() => {
      if (gen !== this._gen) return;   // the stall ended (or a new one began) meanwhile
      this._timer = null;
      this.expire();
    }, this._graceMs - age);
    return true;
  }

  /**
   * The window is over (its timer, a tick that noticed first, or an error /
   * a frozen clock seen inside it): the stall is held from now.
   * @returns {boolean} true when it went held just now (onExpire called)
   */
  expire() {
    if (!this._ep || this._ep.held) return false;
    this._cancelTimer();
    this._ep.held = true;
    if (this._onExpire) this._onExpire(this._ep.reason);
    return true;
  }

  /** Another stall event while it lasts ('waiting' promises a 'playing'; a seek). */
  note(reason) {
    if (!this._ep) return;
    if (reason === 'seeking' || reason === 'seeked') this._ep.seeked = true;
    if (reason === 'waiting') this._ep.reason = 'waiting';
  }

  /**
   * End the stall (the picture moves, or a pause / stop / new video takes
   * over). The timer can no longer act.
   * @returns {{reason: string, lengthMs: number, held: boolean, seeked: boolean}|null}
   */
  end() {
    if (!this._ep) return null;
    const ep = {
      reason: this._ep.reason,
      lengthMs: Math.max(0, this._now() - this._ep.startMs),
      held: this._ep.held,
      seeked: this._ep.seeked,
    };
    this._cancelTimer();
    this._ep = null;
    return ep;
  }

  _cancelTimer() {
    this._gen++;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// --- FN-02 (2026-11-16): the hold for engines that read the clock every tick
//
// Buttplug and T-Code cannot run ahead of the picture (they read currentTime
// every tick), so a stall only froze their POSITION outputs: a vibrator, a
// rotator, a flywheel machine, an e-stim box and the T-Code V / A channels
// kept the last level they were sent and ran on through every stall (Dave
// 2026-11-16: "yes everything should shop while a video buffers"; notes/
// fix-test-list-2026-11-05.md FN-02). StallHold is the N-01 stall rule for
// them: the same triggers as the cloud engines ('waiting', 'stalled' while
// starved, 'seeking', 'error', a clock that stops with no event), sampled
// from the engine's own tick instead of a timer of its own, plus a proxy's
// stall, which a proxy reports as a 'pause' (see isProxyStall).

/**
 * True when a playback proxy reported a STALL, not a pause: the pop-out's and
 * the headset's proxies fold a stall into `paused` (so the cloud engines stop
 * on its 'pause' and re-anchor on its 'playing') and say so with `stalled`
 * true while the source's own `sourcePaused` is false. An HTMLVideoElement
 * has neither, so it is never a proxy stall; the phone never sends `stalled`.
 *
 * @param {{stalled?: boolean, sourcePaused?: boolean}|null} video
 */
export function isProxyStall(video) {
  return !!video && video.stalled === true && video.sourcePaused === false;
}

/** Why the picture is not moving, read from the element itself. */
function starvedReason(video) {
  if (video?.seeking) return 'seeking';
  if (video?.error) return 'error';
  return 'waiting';
}

/**
 * The stall hold for an engine that reads the clock every tick (FN-02), with
 * the grace window (FN-05).
 *
 * The engine binds 'waiting' / 'stalled' / 'seeking' / 'error' to `enter()`,
 * calls `sample()` at the top of every tick (true = held: send nothing), and
 * calls `clear()` (or `end()`) from its own 'playing', 'pause', 'ended',
 * source-change and stop() handlers, which own the device from there.
 *
 * A stall opens a window of STALL_GRACE_MS first (FN-05): the tick runs as it
 * did before FN-02 and nothing is turned off, so a hiccup of a few frames is
 * not felt; the picture moving again inside it ends the stall with nothing
 * sent. `onHold(reason)` runs once when the window runs out (the engine turns
 * its sustained outputs off), at once for an error or a clock found frozen;
 * `onRelease(reason)` runs when the clock moves again with no 'playing' (the
 * frozen-clock backstop): the engine re-arms as for a 'playing'.
 *
 * A hold never stops a POSITION output: the clock is frozen, so a stroker
 * finishes the move it was sent and stands, as it did before FN-02, and no
 * stop or centre frame jerks it mid-stroke.
 */
export class StallHold {
  /**
   * @param {object} opts
   * @param {() => ({video?: object, currentTime?: number, paused?: boolean}|null)} opts.getPlayer
   * @param {(reason: string) => void} [opts.onHold]
   * @param {(reason: string) => void} [opts.onRelease]
   * @param {() => number} [opts.now] wall clock (performance.now())
   * @param {number} [opts.graceMs] the window (STALL_GRACE_MS)
   * @param {string} [opts.tag] the engine's log prefix, for the one line per stall
   */
  constructor({ getPlayer, onHold, onRelease, now, frozenAfterMs, minAdvanceSec, graceMs, tag } = {}) {
    this._getPlayer = getPlayer || (() => null);
    this._onHold = onHold || null;
    this._onRelease = onRelease || null;
    this._now = now || (() => performance.now());
    this._minAdvanceSec = minAdvanceSec ?? MIN_ADVANCE_SEC;
    this._progress = new ProgressWatch({ frozenAfterMs, minAdvanceSec });
    this._held = null;      // why we hold, or null
    this._heldAtSec = 0;    // the clock when the stall began
    this._tag = tag || '[StallHold]';
    this._grace = new StallGrace({
      graceMs, now: () => this._now(), onExpire: (reason) => this._hold(reason),
    });
  }

  /** Why the engine is holding ('waiting' | 'seeking' | 'error' | 'frozen' | 'proxy'), or null. */
  get held() { return this._held; }

  /** Inside the grace window (FN-05): why the picture stopped, or null. Nothing is turned off yet. */
  get pending() { return this._grace.open ? this._grace.reason : null; }

  /**
   * The picture stopped (an element event, or a proxy's stall 'pause').
   * @param {'waiting'|'stalled'|'seeking'|'error'|'frozen'|'proxy'} reason
   * @returns {boolean} true when a NEW stall began (its window opened, or
   *   it held at once)
   */
  enter(reason) {
    const player = this._getPlayer();
    const video = player?.video;
    if (reason === 'stalled') {
      // About the NETWORK: the element may still play from its buffer. Only
      // a stall that has run out of frames holds, and it owes a 'playing'.
      if (!isPictureStarved(video)) return false;
      reason = 'waiting';
    }
    // A pause is the engine's pause handler's, unless it is a proxy's stall.
    if (player?.paused && !isProxyStall(video)) return false;
    if (this._grace.active) {
      this._grace.note(reason);
      if (this._held) {
        if (reason === 'waiting') this._held = 'waiting';
      } else if (reason === 'error' || reason === 'frozen') {
        this._grace.expire();   // an error does not wait out the window
      }
      return false;
    }
    const t = Number(player?.currentTime);
    this._heldAtSec = Number.isFinite(t) ? t : 0;
    this._progress.reset();
    // Past the window when seen: an error (none), a clock found frozen (the
    // watch waited FROZEN_AFTER_MS), a headset's stall (its proxy waited 2 s).
    const ageMs = reason === 'frozen' ? this._progress.frozenAfterMs
      : reason === 'proxy' ? proxyStallAgeMs(video) : 0;
    if (!this._grace.begin(reason, { ageMs, instant: reason === 'error' })) this._hold(reason);
    return true;
  }

  /** The window ran out (or there was none): turn the sustained outputs off, once. */
  _hold(reason) {
    if (this._held) return;
    this._held = this._grace.reason || reason;
    this._progress.reset();
    if (this._onHold) this._onHold(this._held);
  }

  /**
   * Called from the tick while not paused.
   * @returns {boolean} true while held: the tick sends nothing
   */
  sample() {
    const player = this._getPlayer();
    if (!player) return this._held !== null;
    const video = player.video;
    const t = Number(player.currentTime);
    const paused = !!player.paused;
    const frozen = this._progress.sample(t, paused, this._now());
    if (paused) return this._held !== null;
    if (!this._grace.active) {
      if (frozen) this.enter('frozen');
      else if (isPictureStarved(video)) this.enter(starvedReason(video));
      return this._held !== null;
    }
    // The element no longer says it cannot move, and the clock has moved
    // since the stall began.
    const moving = !isPictureStarved(video) && Number.isFinite(t)
      && Math.abs(t - this._heldAtSec) >= this._minAdvanceSec - 1e-9;
    if (!this._held) {
      // Inside the window: the tick runs as it always did. A stall over with
      // no 'playing' (a seek that never starved) ends here, nothing sent.
      if (moving) { this.end('the clock moving'); return false; }
      if (this._grace.due) this._grace.expire();
      return this._held !== null;
    }
    // Held: the backstop release.
    if (moving) {
      const reason = this._held;
      this.end('the clock moving');
      if (this._onRelease) this._onRelease(reason);
      return false;
    }
    return true;
  }

  /**
   * End the stall, logging its one line (FN-05). A 'playing', a pause, an
   * end, a new source or stop() owns the device from here; no onRelease.
   * @param {string} [endedBy]
   * @returns {{reason: string, lengthMs: number, held: boolean, seeked: boolean}|null}
   */
  end(endedBy = '') {
    const ep = this._grace.end();
    this._held = null;
    this._progress.reset();
    if (ep) console.log(`${this._tag} ${stallSummary(ep, { endedBy })}`);
    return ep;
  }

  /**
   * Forget the stall without onRelease (see end()).
   * @param {string} [endedBy]
   * @returns {string|null} why the picture had stopped (held, or inside the
   *   window), or null when there was no stall
   */
  clear(endedBy = '') {
    const ep = this.end(endedBy);
    return ep ? ep.reason : null;
  }
}
