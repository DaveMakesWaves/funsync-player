// The Bluetooth sync test (brokenobj #431, 2026-11-23: "proper sync with BLE
// has been a white whale for me with every library app"): the model behind
// Devices ▸ Buttplug ▸ Sync test…
//
// Two halves, as the Handy has Measure + its offset:
// 1. MEASURE. The round trip of a harmless command (a stop on an idle toy)
//    through Intiface: it answers once the command has gone out to the toy
//    (for Bluetooth, the BLE write). Half the median is the one-way delay,
//    which the Sync tab's suggestion (auto-offset.js computeSuggestedOffset,
//    `buttplugPingMs`) turns into an offset; until now it guessed from a preset.
// 2. FEEL IT. What no measurement sees (the toy's own motor start, the
//    person's sense of "now"): the toy pulses on a steady beat with a flash on
//    screen, and the user slides the offset until they land together. The
//    offset works as in playback: NEGATIVE fires the toy EARLIER
//    (buttplug.defaultOffset, ButtplugSync._offsetMs).
//
// Pure (the clock and the toy are passed in): no DOM, no IPC.

import { medianLatency } from './latency-sample.js';
import { computeSuggestedOffset } from './auto-offset.js';

/** The offset slider's range and step (ms), and the beat. */
export const OFFSET_MIN = -400;
export const OFFSET_MAX = 200;
export const OFFSET_STEP = 10;
export const BEAT_MS = 1000;
/** How long a vibrator buzzes per beat, and how long a stroker takes to reach the top. */
export const PULSE_MS = 160;
export const STROKE_UP_MS = 180;

/**
 * Faster than any Bluetooth link can confirm a write (a BLE connection event
 * is 7.5 ms at best, there and back more). Found on Dave's Lovense Edge via
 * Intiface (2026-11-25): every stop answered in 1-2 ms, before the toy had
 * it, so the measure timed only the local link to Intiface. Under this the
 * round trip is not the toy's: not saved, no suggestion (Feel it sets it).
 */
export const MIN_PLAUSIBLE_BLE_RTT_MS = 15;

/** Clamp to the slider's range and step. */
export function clampOffset(ms) {
  const n = Math.round((Number(ms) || 0) / OFFSET_STEP) * OFFSET_STEP;
  return Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, n));
}

/**
 * The measurement, summed up: median, spread and the offset it suggests.
 * `samples` are round trips in ms; anything not a positive finite number is
 * left out. Null when nothing usable came back.
 */
export function summariseRoundTrips(samples) {
  const ok = (Array.isArray(samples) ? samples : []).filter((x) => Number.isFinite(x) && x > 0);
  if (ok.length === 0) return null;
  const median = Math.round(medianLatency(ok));
  const sorted = ok.slice().sort((a, b) => a - b);
  const spread = Math.round(sorted[sorted.length - 1] - sorted[0]);
  // Answered before the toy could have had it: not the toy's round trip.
  const plausible = median >= MIN_PLAUSIBLE_BLE_RTT_MS;
  const suggested = plausible
    ? clampOffset(computeSuggestedOffset({ device: 'buttplug', context: 'desktop', buttplugPingMs: median }))
    : null;
  return { median, min: Math.round(sorted[0]), max: Math.round(sorted[sorted.length - 1]), spread, count: ok.length, suggested, plausible };
}

/**
 * When to send each command for the beat at `beatAt` (ms on the page
 * clock), for a toy of `kind`, at `offsetMs`. A vibrator buzzes at the
 * beat; a stroker ARRIVES at the top at the beat (it starts STROKE_UP_MS
 * earlier) and goes back down after. Offsets move every send.
 * @returns {{ at: number, cmd: 'vibrate'|'linear', value: number, durationMs?: number }[]}
 */
export function beatCommands(kind, beatAt, offsetMs) {
  const o = clampOffset(offsetMs);
  if (kind === 'linear') {
    return [
      { at: beatAt - STROKE_UP_MS + o, cmd: 'linear', value: 100, durationMs: STROKE_UP_MS },
      { at: beatAt + o + 60, cmd: 'linear', value: 0, durationMs: Math.round(BEAT_MS / 2) },
    ];
  }
  if (kind === 'vibrate') {
    return [
      { at: beatAt + o, cmd: 'vibrate', value: 100 },
      { at: beatAt + o + PULSE_MS, cmd: 'vibrate', value: 0 },
    ];
  }
  return [];
}

/** What the test can drive on a device: a stroker, a vibrator, or nothing (a flywheel machine is left out). */
export function pulseKind(device) {
  if (device?.canLinear) return 'linear';
  if (device?.canVibrate || device?.canScalar) return 'vibrate';
  return null;
}

/**
 * The beat: every BEAT_MS a flash (onBeat) and the toys' commands, sent
 * `offsetMs` early or late. Schedules one beat ahead so an early send
 * (a negative offset) is never in the past. stop() sends every toy its stop.
 */
export class SyncPulser {
  /**
   * @param {{ manager: object, devices: object[], onBeat?: (at: number) => void,
   *   now?: () => number, setTimer?: Function, clearTimer?: Function }} deps
   */
  constructor({ manager, devices, onBeat, onStop, now, setTimer, clearTimer }) {
    this.manager = manager;
    this.targets = (Array.isArray(devices) ? devices : [])
      .map((d) => ({ index: d.index, kind: pulseKind(d) }))
      .filter((d) => d.kind);
    this.onBeat = onBeat || (() => {});
    this.onStop = onStop || (() => {}); // told when the beat ends, whoever ended it (Stop all)
    this.now = now || (() => performance.now());
    this.setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clearTimer || ((id) => clearTimeout(id));
    this.offsetMs = 0;
    this.running = false;
    this._timers = new Set();
    this._nextBeat = 0;
  }

  setOffset(ms) { this.offsetMs = clampOffset(ms); }

  start() {
    if (this.running || this.targets.length === 0) return false;
    this.running = true;
    // The first beat far enough ahead for the earliest possible send.
    this._nextBeat = this.now() + STROKE_UP_MS - OFFSET_MIN + 100;
    this._scheduleBeat();
    return true;
  }

  _later(at, fn) {
    const id = this.setTimer(() => { this._timers.delete(id); if (this.running) fn(); }, Math.max(0, at - this.now()));
    this._timers.add(id);
  }

  _scheduleBeat() {
    if (!this.running) return;
    const beatAt = this._nextBeat;
    for (const t of this.targets) {
      for (const c of beatCommands(t.kind, beatAt, this.offsetMs)) {
        this._later(c.at, () => {
          if (c.cmd === 'linear') this.manager.sendLinear?.(t.index, c.value, c.durationMs);
          else this.manager.sendVibrate?.(t.index, c.value);
        });
      }
    }
    this._later(beatAt, () => this.onBeat(beatAt));
    // The next beat is planned half a beat before this one lands.
    this._nextBeat = beatAt + BEAT_MS;
    this._later(beatAt - BEAT_MS / 2 + OFFSET_MIN, () => this._scheduleBeat());
  }

  /** End the beat and stop every toy it drove. */
  stop() {
    const was = this.running;
    this.running = false;
    for (const id of this._timers) this.clearTimer(id);
    this._timers.clear();
    if (was) for (const t of this.targets) this.manager.stopDevice?.(t.index);
    if (was) this.onStop();
    return was;
  }
}
