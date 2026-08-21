// filler-test-player — drive the connected devices through a filler sample so
// the user can FEEL the pattern they picked, from the settings panel.
//
// Dave, 2026-08-21: "that setting should have a test button to play through the
// pattern preview". It earns its place immediately — the preview is drawn in
// script space, so a per-device transform (invert, range, floor/ceiling, the
// safety cap) can make the hardware do something quite different from the
// picture, and there was no way to notice short of playing a video with a gap
// in it. The first thing this button found was an Invert left on.
//
// Off-clock driver, same shape as the Orgasm Switch: it owns a tick, walks a
// list of actions, and pushes positions at the sync engines' own public send
// point. It deliberately does NOT reimplement routing or the transform stack —
// that is the most safety-critical code in the app, and a second copy of it
// would be a second thing to get wrong.
//
// Cloud-upload devices (Handy HSSP, Autoblow) are out of scope on purpose:
// they play a script from their own clock, so there is no live position to
// push. Testing a pattern on those means playing a video.

/** How often to re-aim the devices. Matches ButtplugSync's own tick. */
const TICK_MS = 40;

/** Never leave a test running longer than this, whatever the caller passes. */
const MAX_RUN_MS = 30000;

export class FillerTestPlayer {
  /**
   * @param {object} deps
   * @param {{sendPositionNow: Function, isDriving: Function}} [deps.buttplugSync]
   * @param {{sendPositionNow: Function, isDriving: Function}} [deps.tcodeSync]
   * @param {() => number} [deps.now]
   * @param {(fn: Function, ms: number) => any} [deps.setInterval]
   * @param {(handle: any) => void} [deps.clearInterval]
   */
  constructor({ buttplugSync, tcodeSync, now, setInterval: setIntervalImpl, clearInterval: clearIntervalImpl } = {}) {
    this.buttplugSync = buttplugSync || null;
    this.tcodeSync = tcodeSync || null;
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._setInterval = setIntervalImpl
      || ((fn, ms) => (typeof window !== 'undefined' ? window.setInterval(fn, ms) : setInterval(fn, ms)));
    this._clearInterval = clearIntervalImpl
      || ((h) => (typeof window !== 'undefined' ? window.clearInterval(h) : clearInterval(h)));

    this._actions = null;
    this._handle = null;
    this._startedAt = 0;
    this._durationMs = 0;
    this._index = -1;
    this._lastTarget = -1;   // last keyframe target sent on the linear path
    this._lastInterp = -1;   // last interpolated value sent on the tick path

    /** Fired with (progress 0-1, position 0-100) each tick, for the playhead. */
    this.onProgress = null;
    /** Fired once when the run ends, for whatever reason. */
    this.onEnd = null;
  }

  get running() {
    return this._handle !== null;
  }

  /**
   * True when a video is already driving the devices. Testing then would put
   * two writers on one device and leave whichever lost holding a stale value,
   * so the caller is expected to refuse rather than fight.
   */
  get blockedByPlayback() {
    return !!(this.buttplugSync?.isDriving?.() || this.tcodeSync?.isDriving?.());
  }

  /**
   * Play an action list through the devices in real time.
   *
   * @param {Array<{at:number,pos:number}>} actions — as generated for a gap
   * @returns {boolean} false if it refused to start
   */
  play(actions) {
    if (this.running) this.stop();
    const list = (Array.isArray(actions) ? actions : [])
      .filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos))
      .sort((a, b) => a.at - b.at);
    if (list.length < 2) return false;
    if (this.blockedByPlayback) return false;

    const span = list[list.length - 1].at - list[0].at;
    if (!(span > 0)) return false;

    this._actions = list;
    this._durationMs = Math.min(span, MAX_RUN_MS);
    this._startedAt = this._now();
    this._index = -1;
    this._lastTarget = -1;
    this._lastInterp = -1;

    this._handle = this._setInterval(() => this._tick(), TICK_MS);
    this._tick();   // aim immediately rather than after one tick of silence
    return true;
  }

  /**
   * Stop the run and idle whatever it was driving.
   *
   * Always sends a real stop, never merely stops sending: a vibrate or rotate
   * output holds its last value until something tells it otherwise, which is
   * the exact failure the Orgasm Switch release hit on 2026-08-14.
   */
  stop() {
    if (this._handle !== null) {
      this._clearInterval(this._handle);
      this._handle = null;
    }
    this._actions = null;
    this._index = -1;
    this._lastTarget = -1;
    this._lastInterp = -1;
    try { this.buttplugSync?.stopTestOutput?.(); } catch { /* best-effort */ }
    try { this.tcodeSync?.stopTestOutput?.(); } catch { /* best-effort */ }
    if (this.onEnd) this.onEnd();
  }

  _tick() {
    if (!this._actions) return;
    const elapsed = this._now() - this._startedAt;
    if (elapsed >= this._durationMs) {
      if (this.onProgress) this.onProgress(1, this._lastInterp);
      this.stop();
      return;
    }

    const t = this._actions[0].at + elapsed;

    // Advance to the interval containing t, then aim at its END — the same
    // keyframe-driven model the engines use, so a linear device travels
    // rather than being stepped at the tick rate.
    const before = this._index;
    while (this._index + 1 < this._actions.length - 1
           && this._actions[this._index + 1].at <= t) {
      this._index++;
    }
    const i = Math.max(0, this._index);
    const next = this._actions[i + 1];
    if (!next) { this.stop(); return; }

    // A step edge is 1ms wide, so a 40ms tick straddles it: without this, the
    // tick after the edge would aim at the NEXT keyframe and the step itself
    // would never reach the device — a sawtooth that ramps up and then simply
    // stays up, a square with no bottom half. Land on the keyframe we crossed
    // before aiming past it.
    if (before !== this._index && this._lastTarget >= 0) {
      const landed = this._actions[i].pos;
      if (Math.abs(landed - this._lastTarget) >= 0.5) {
        this.buttplugSync?.sendLinearNow?.(landed, TICK_MS, this._lastTarget);
        this.tcodeSync?.sendPositionNow?.(landed, TICK_MS);
        this._lastTarget = landed;
      }
    }

    const remaining = Math.max(TICK_MS, next.at - t);

    // --- Linear path: one command per keyframe, travelled over its duration.
    if (Math.abs(next.pos - this._lastTarget) >= 0.5 || this._lastTarget < 0) {
      const prev = this._lastTarget < 0 ? this._actions[i].pos : this._lastTarget;
      this.buttplugSync?.sendLinearNow?.(next.pos, remaining, prev);
      this.tcodeSync?.sendPositionNow?.(next.pos, remaining);
      this._lastTarget = next.pos;
    }

    // --- Everything else: resample every tick.
    // A vibrator, rotator, oscillator or e-stim channel does not interpolate;
    // it takes a value and holds it. Given only the keyframes it slams between
    // the extremes with no ramp — which is what a Lovense Edge in position
    // mode did to the first version of this driver.
    const a = this._actions[i];
    const span = next.at - a.at;
    const u = span > 0 ? Math.min(1, Math.max(0, (t - a.at) / span)) : 0;
    const interpolated = a.pos + u * (next.pos - a.pos);
    const prevInterp = this._lastInterp < 0 ? interpolated : this._lastInterp;
    this.buttplugSync?.sendPositionNow?.(interpolated, TICK_MS, prevInterp, { emitLinear: false });
    this._lastInterp = interpolated;

    if (this.onProgress) {
      // The INTERPOLATED position, so the playhead sits where the device is
      // rather than where it is heading.
      this.onProgress(elapsed / this._durationMs, interpolated);
    }
  }
}
