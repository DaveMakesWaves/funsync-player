// GamepadRecorder: record two axes at once from a gamepad's stick, as
// OpenFunscripter's recording mode does with a controller (editor work list
// 2.6, 2026-11-24). OFS (src/OFS_ScriptingMode.cpp, RecordingMode) writes
// stick X into the roll script and Y into the pitch script once per frame
// while the video plays; this does the same into whichever two axes the user
// picks (gamepad-record-menu.js), default left/right -> Roll (R1) and
// up/down -> Pitch (R2).
//
// How it runs:
//   - The Gamepad API (navigator.getGamepads) is polled once per animation
//     frame while recording. Chromium hands out a fresh snapshot per call,
//     so there is nothing to subscribe to. If animation frames stop (the
//     window hidden or occluded), a slow timer keeps polling, so a take does
//     not freeze on the last reading.
//   - Samples ({at: video ms, a, b}) are taken ONLY while the video plays.
//   - A "take" is one unbroken run of playback. It ends on a pause or a seek
//     (the video time going back, or jumping ahead further than maxGapMs).
//     Each take lands as its own range, so a seek never wipes the stretch
//     between two takes. With `onTake`, every take is handed over the moment
//     it ends (the editor lands it on pause, as OFS shows its points as soon
//     as they are recorded); without it, takes pile up for stop().
//   - stop() returns what was not handed over yet: { a, b, t0, t1, segments }.
//
// No DOM: every browser hook (getGamepads, the clock, the frame and timer
// functions, the window for connect events) is injectable for tests. The
// defaults call them through their owner object (memory: a bare
// setInterval taken as a method throws "Illegal invocation" in Chromium).

import { stickToPos, DEFAULT_DEADZONE } from './gamepad-recording-math.js';

/** Standard-mapping axis indices (https://w3c.github.io/gamepad/#remapping). */
export const STICK_AXES = Object.freeze({ leftX: 0, leftY: 1, rightX: 2, rightY: 3 });

/**
 * What the user picks in the menu: which funscript axis each stick direction
 * records into, and the per-direction flips. `x` / `y` are canonical axis
 * suffixes (multi-axis.js AXIS_DEFINITIONS) or 'main' for the stroke.
 * OFS's two-axes mode is hard-wired to roll + pitch; they stay the default.
 */
export const DEFAULT_GAMEPAD_MAPPING = Object.freeze({ x: 'roll', y: 'pitch', invertX: false, invertY: false });

/** Video time may step back this little without it counting as a seek (jitter). */
const BACK_TOLERANCE_MS = 30;
/** A jump ahead longer than this is a seek: the take ends there. */
const DEFAULT_MAX_GAP_MS = 750;
/** The timer that stands in for animation frames when they stop. */
const FALLBACK_POLL_MS = 50;
const FALLBACK_AFTER_MS = 40;

const defaultGetGamepads = () => {
  try { return globalThis.navigator?.getGamepads?.() || []; } catch { return []; }
};
const defaultNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const defaultRequestFrame = (cb) => (typeof globalThis.requestAnimationFrame === 'function'
  ? globalThis.requestAnimationFrame(cb)
  : globalThis.setTimeout(() => cb(defaultNow()), 16));
const defaultCancelFrame = (id) => {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id);
  else globalThis.clearTimeout(id);
};
const defaultSetTimer = (fn, ms) => globalThis.setInterval(fn, ms);
const defaultClearTimer = (id) => globalThis.clearInterval(id);

/**
 * A pad's id as a person would name it. Chromium appends the mapping and
 * USB ids: "Xbox 360 Controller (XInput STANDARD GAMEPAD)", "Wireless
 * Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)", "USB Gamepad
 * (Vendor: 0079 Product: 0006)". Firefox prefixes them: "045e-028e-...".
 * @param {string} id
 * @returns {string}
 */
export function cleanPadName(id) {
  const raw = String(id ?? '').trim();
  let s = raw
    .replace(/\s*\([^()]*STANDARD GAMEPAD[^()]*\)\s*$/i, '')
    .replace(/\s*\(\s*Vendor:\s*[0-9a-f]{1,4}\s+Product:\s*[0-9a-f]{1,4}\s*\)\s*$/i, '')
    .replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '')
    .trim();
  if (!s) s = raw;
  return s;
}

function connectedPads(list) {
  const out = [];
  for (const pad of Array.from(list || [])) if (pad && pad.connected !== false) out.push(pad);
  return out;
}

export class GamepadRecorder {
  /**
   * @param {object} o
   * @param {() => number} o.getVideoTimeMs — the playing video's time in ms
   * @param {() => boolean} o.isPlaying — the video plays (not paused / ended)
   * @param {() => ArrayLike<Gamepad|null>} [o.getGamepads]
   * @param {() => number} [o.now] — a ms clock (performance.now)
   * @param {(cb: Function) => any} [o.requestFrame]
   * @param {(id: any) => void} [o.cancelFrame]
   * @param {(fn: Function, ms: number) => any} [o.setTimer] — a repeating timer
   * @param {(id: any) => void} [o.clearTimer]
   * @param {EventTarget|null} [o.win] — gamepadconnected / gamepaddisconnected come from it
   * @param {number|null} [o.padIndex] — one pad; null = the first standard one
   * @param {number} [o.axisA] — the Gamepad axis recorded as A (0 = left stick X)
   * @param {number} [o.axisB] — the Gamepad axis recorded as B (1 = left stick Y)
   * @param {boolean} [o.invertA]
   * @param {boolean} [o.invertB]
   * @param {number} [o.deadzone]
   * @param {number} [o.maxGapMs]
   * @param {(take: object, reason: 'pause'|'seek') => void} [o.onTake]
   * @param {(frame: {a:number|null,b:number|null,pad:string|null,playing:boolean,recording:boolean}) => void} [o.onFrame]
   * @param {(pads: Array, type: string) => void} [o.onPadsChanged]
   */
  constructor({
    getVideoTimeMs, isPlaying,
    getGamepads = defaultGetGamepads,
    now = defaultNow,
    requestFrame = defaultRequestFrame, cancelFrame = defaultCancelFrame,
    setTimer = defaultSetTimer, clearTimer = defaultClearTimer,
    win = (typeof window !== 'undefined' ? window : null),
    padIndex = null,
    axisA = STICK_AXES.leftX, axisB = STICK_AXES.leftY,
    invertA = false, invertB = false,
    deadzone = DEFAULT_DEADZONE,
    maxGapMs = DEFAULT_MAX_GAP_MS,
    onTake = null, onFrame = null, onPadsChanged = null,
  } = {}) {
    this._getVideoTimeMs = getVideoTimeMs;
    this._isPlaying = isPlaying;
    this._getGamepads = getGamepads;
    this._now = now;
    this._requestFrame = requestFrame;
    this._cancelFrame = cancelFrame;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._win = win;
    this.onTake = onTake;
    this.onFrame = onFrame;
    this.onPadsChanged = onPadsChanged;
    this._cfg = { padIndex, axisA, axisB, invertA, invertB, deadzone, maxGapMs };

    this._recording = false;
    this._previewing = false;
    this._looping = false;
    this._raf = null;
    this._timer = null;
    this._lastPollAt = -Infinity;
    this._take = [];
    this._takes = [];

    this._onPadEvent = (e) => {
      try { this.onPadsChanged?.(this.listPads(), e?.type || ''); } catch { /* the listener's own problem */ }
    };
    if (this._win?.addEventListener) {
      this._win.addEventListener('gamepadconnected', this._onPadEvent);
      this._win.addEventListener('gamepaddisconnected', this._onPadEvent);
    }
  }

  /** Change the mapping (any of the constructor's padIndex / axisA / axisB / invertA / invertB / deadzone / maxGapMs). */
  configure(partial = {}) {
    for (const k of Object.keys(this._cfg)) if (k in partial) this._cfg[k] = partial[k];
  }

  /** The mapping in use (a copy). */
  get config() { return { ...this._cfg }; }

  /** True from start() to stop() / cancel(). */
  get recording() { return this._recording; }

  /** The pads connected now: [{ index, id, name, mapping }]. */
  listPads() {
    return connectedPads(this._getGamepads()).map((p) => ({
      index: p.index, id: String(p.id || ''), name: cleanPadName(p.id), mapping: p.mapping || '',
    }));
  }

  /** The pad that records: the chosen index, else the first with the standard mapping, else the first. */
  activePad() {
    const pads = connectedPads(this._getGamepads());
    const want = this._cfg.padIndex;
    if (Number.isInteger(want)) return pads.find((p) => p.index === want) || null;
    return pads.find((p) => p.mapping === 'standard') || pads[0] || null;
  }

  /** The recording pad's name, or null (none connected, or none pressed a button yet). */
  padName() {
    const pad = this.activePad();
    return pad ? cleanPadName(pad.id) : null;
  }

  /** The two positions the stick gives now (0-100, not rounded), or null with no pad. */
  read() {
    const pad = this.activePad();
    if (!pad) return null;
    const axes = pad.axes || [];
    const c = this._cfg;
    // Odd standard axes are vertical (left Y = 1, right Y = 3): up = 100.
    return {
      a: stickToPos(axes[c.axisA], { deadzone: c.deadzone, up: c.axisA % 2 === 1, invert: !!c.invertA }),
      b: stickToPos(axes[c.axisB], { deadzone: c.deadzone, up: c.axisB % 2 === 1, invert: !!c.invertB }),
      pad: cleanPadName(pad.id),
    };
  }

  /**
   * Start recording. Takes start when the video plays. A pad that connects
   * later is picked up (Chromium shows a pad only after one of its buttons
   * is pressed). False when already recording.
   */
  start() {
    if (this._recording) return false;
    this._recording = true;
    this._take = [];
    this._takes = [];
    this._syncLoop();
    return true;
  }

  /**
   * Stop recording: the take in progress ends, and every take not handed to
   * onTake comes back as one recording. `a` / `b` are all its samples as
   * {at, pos}; `segments` are the takes (land each over its own range).
   * @returns {{a:Array<{at:number,pos:number}>, b:Array<{at:number,pos:number}>, t0:number|null, t1:number|null, segments:Array}}
   */
  stop() {
    if (!this._recording) return emptyRecording();
    this._endTake(null);
    this._recording = false;
    this._syncLoop();
    const segments = this._takes;
    this._takes = [];
    return combine(segments);
  }

  /** Stop and throw the recording away (the take in progress too). */
  cancel() {
    this._take = [];
    this._takes = [];
    this._recording = false;
    this._syncLoop();
  }

  /** Poll without recording, for a live readout (onFrame) before a take. */
  preview(on) {
    this._previewing = !!on;
    this._syncLoop();
  }

  /** Stop everything and drop the connect listeners. */
  dispose() {
    this.cancel();
    this.preview(false);
    if (this._win?.removeEventListener) {
      this._win.removeEventListener('gamepadconnected', this._onPadEvent);
      this._win.removeEventListener('gamepaddisconnected', this._onPadEvent);
    }
  }

  /**
   * One reading (the loop calls it each frame; public for tests). Records a
   * sample when recording, the video plays and a pad is there.
   */
  poll() {
    this._lastPollAt = this._now();
    let vals = null;
    try { vals = this.read(); } catch { vals = null; }
    const playing = !!this._safe(this._isPlaying);
    if (this.onFrame) {
      try {
        this.onFrame({ a: vals?.a ?? null, b: vals?.b ?? null, pad: vals?.pad ?? null, playing, recording: this._recording });
      } catch { /* a readout's problem */ }
    }
    if (!this._recording) return;
    if (!playing) { this._endTake('pause'); return; }
    if (!vals) return; // no pad: a gap, nothing recorded (a long one ends the take below)
    const at = Number(this._safe(this._getVideoTimeMs));
    if (!Number.isFinite(at)) return;
    const take = this._take;
    const last = take[take.length - 1];
    if (last) {
      if (at < last.at - BACK_TOLERANCE_MS || at - last.at > this._cfg.maxGapMs) {
        this._endTake('seek');
      } else if (at <= last.at) {
        // The video has not moved on since the last reading: newest stick wins.
        last.a = vals.a;
        last.b = vals.b;
        return;
      }
    }
    this._take.push({ at, a: vals.a, b: vals.b });
  }

  _safe(fn) {
    try { return typeof fn === 'function' ? fn() : undefined; } catch { return undefined; }
  }

  /** End the take in progress: to onTake (pause / seek), else kept for stop(). */
  _endTake(reason) {
    const samples = this._take;
    this._take = [];
    if (samples.length === 0) return;
    const take = toTake(samples);
    if (reason && typeof this.onTake === 'function') {
      try { this.onTake(take, reason); } catch (err) { console.warn('[GamepadRecorder] onTake failed:', err?.message || err); }
      return;
    }
    this._takes.push(take);
  }

  _syncLoop() {
    const want = this._recording || this._previewing;
    if (want && !this._looping) {
      this._looping = true;
      const tick = () => {
        if (!this._looping) return;
        this._raf = this._requestFrame(tick);
        this._pollSafely();
      };
      this._raf = this._requestFrame(tick);
      this._timer = this._setTimer(() => {
        if (this._looping && this._now() - this._lastPollAt >= FALLBACK_AFTER_MS) this._pollSafely();
      }, FALLBACK_POLL_MS);
    } else if (!want && this._looping) {
      this._looping = false;
      if (this._raf != null) { try { this._cancelFrame(this._raf); } catch { /* gone */ } }
      if (this._timer != null) { try { this._clearTimer(this._timer); } catch { /* gone */ } }
      this._raf = null;
      this._timer = null;
    }
  }

  _pollSafely() {
    try { this.poll(); } catch (err) { console.warn('[GamepadRecorder] poll failed:', err?.message || err); }
  }
}

function toTake(samples) {
  return {
    t0: samples[0].at,
    t1: samples[samples.length - 1].at,
    a: samples.map((s) => ({ at: s.at, pos: s.a })),
    b: samples.map((s) => ({ at: s.at, pos: s.b })),
    samples: samples.length,
  };
}

function emptyRecording() {
  return { a: [], b: [], t0: null, t1: null, segments: [] };
}

function combine(segments) {
  if (segments.length === 0) return emptyRecording();
  return {
    a: segments.flatMap((s) => s.a),
    b: segments.flatMap((s) => s.b),
    t0: Math.min(...segments.map((s) => s.t0)),
    t1: Math.max(...segments.map((s) => s.t1)),
    segments,
  };
}
