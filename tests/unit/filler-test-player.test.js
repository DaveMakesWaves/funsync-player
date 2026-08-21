/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The filler test button (Dave, 2026-08-21): play the previewed pattern
// through the devices so you can feel it.
//
// It earned its place on the first run — the preview is drawn in SCRIPT space
// and Dave's Lovense Edge had Invert on, so the sawtooth he saw rising slowly
// was arriving at the toy as a fast rise and a slow decline. Nothing in the
// app could show that short of playing a video with a gap in it.
//
// What must hold, in order of how much damage breaking it would do:
//   1. It NEVER writes to devices a video is already driving.
//   2. It always sends a real stop when it finishes, however it finishes.
//   3. It goes through the engines' own send path, so per-device transforms
//      apply — a test that bypassed them would be a lie.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FillerTestPlayer } from '../../renderer/js/filler-test-player.js';

function makeEngine({ driving = false } = {}) {
  return {
    // `sent` is the tick path (vibrate/rotate/e-stim — resampled), `linear`
    // is the keyframe path. Playback splits these two ways and so must the
    // test driver: a vibrator does not interpolate.
    sent: [],
    linear: [],
    stops: 0,
    _driving: driving,
    isDriving() { return this._driving; },
    sendPositionNow(pos, durationMs, prevPos, opts = {}) {
      this.sent.push({ pos, durationMs, prevPos, emitLinear: opts.emitLinear !== false });
      return true;
    },
    sendLinearNow(pos, durationMs, prevPos) {
      this.linear.push({ pos, durationMs, prevPos });
      return true;
    },
    stopTestOutput() { this.stops++; },
  };
}

/** Controllable clock + interval, so a test never waits on wall time. */
function makeHarness({ driving = false } = {}) {
  const buttplugSync = makeEngine({ driving });
  const tcodeSync = makeEngine({ driving });
  let now = 0;
  let tickFn = null;
  const player = new FillerTestPlayer({
    buttplugSync,
    tcodeSync,
    now: () => now,
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
  });
  return {
    player, buttplugSync, tcodeSync,
    advance(ms) { now += ms; if (tickFn) tickFn(); },
    get ticking() { return tickFn !== null; },
  };
}

// A 4s sawtooth-ish sample: slow rise, instant drop, slow rise.
const SAMPLE = [
  { at: 0, pos: 0 },
  { at: 2000, pos: 100 },
  { at: 2001, pos: 0 },
  { at: 4000, pos: 100 },
];

describe('FillerTestPlayer — refusing to fight playback', () => {
  it('will not start while a video is driving the devices', () => {
    const h = makeHarness({ driving: true });
    expect(h.player.blockedByPlayback).toBe(true);
    expect(h.player.play(SAMPLE)).toBe(false);
    expect(h.player.running).toBe(false);
    expect(h.buttplugSync.sent).toEqual([]);
  });

  it('starts when nothing else owns the devices', () => {
    const h = makeHarness();
    expect(h.player.play(SAMPLE)).toBe(true);
    expect(h.player.running).toBe(true);
    h.player.stop();
  });

  it('refuses a list too short to be a pattern', () => {
    const h = makeHarness();
    expect(h.player.play([{ at: 0, pos: 50 }])).toBe(false);
    expect(h.player.play([])).toBe(false);
    expect(h.player.play(null)).toBe(false);
  });

  it('refuses a zero-length sample rather than dividing by it', () => {
    const h = makeHarness();
    expect(h.player.play([{ at: 500, pos: 0 }, { at: 500, pos: 100 }])).toBe(false);
  });
});

describe('FillerTestPlayer — driving', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });

  it('aims immediately rather than after a tick of silence', () => {
    h.player.play(SAMPLE);
    expect(h.buttplugSync.linear.length).toBe(1);
    expect(h.tcodeSync.sent.length).toBe(1);
  });

  it('sends to BOTH engines, since either may hold the devices', () => {
    h.player.play(SAMPLE);
    h.advance(500);
    expect(h.buttplugSync.linear.length).toBeGreaterThan(0);
    expect(h.tcodeSync.sent.length).toBe(h.buttplugSync.linear.length);
  });

  it('gives linear devices one command per keyframe, with its duration', () => {
    // Travel to the real target and let the device interpolate. Stepping a
    // linear toy at the tick rate would flatten the pattern.
    h.player.play(SAMPLE);
    const first = h.buttplugSync.linear[0];
    expect(first.pos).toBe(100);
    expect(first.durationMs).toBe(2000);
  });

  // The Lovense Edge bug: given only the keyframes, a vibrator jumps to full
  // and holds, then jumps to zero. No incline at all (Dave, 2026-08-21).
  it('resamples the interpolated position every tick for non-linear devices', () => {
    h.player.play(SAMPLE);
    for (let i = 0; i < 10; i++) h.advance(100);
    const ticks = h.buttplugSync.sent;
    expect(ticks.length).toBeGreaterThan(8);
    // Never on the linear path — that is dispatched separately per keyframe.
    for (const s of ticks) expect(s.emitLinear).toBe(false);
    // And it really is a ramp, not two values.
    const values = ticks.map((s) => s.pos);
    expect(new Set(values).size).toBeGreaterThan(5);
    expect(Math.max(...values)).toBeGreaterThan(40);
    expect(Math.min(...values)).toBeLessThan(20);
  });

  it('the resampled ramp rises monotonically across a rising keyframe', () => {
    h.player.play(SAMPLE);
    for (let i = 0; i < 10; i++) h.advance(100);
    const values = h.buttplugSync.sent.map((s) => s.pos);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it('delivers a step edge even when a tick straddles it', () => {
    // The 1ms drop at 2001 falls between ticks. Without landing on the
    // keyframe we crossed, the device would be told "go to 100" twice and
    // the sawtooth would ramp up and simply stay up.
    h.player.play(SAMPLE);
    h.advance(2100);            // past the instant drop
    const positions = h.buttplugSync.linear.map((s) => s.pos);
    expect(positions).toContain(0);                      // the reset landed
    expect(positions[positions.length - 1]).toBe(100);   // then off to the next peak
    expect(h.buttplugSync.linear.length).toBeGreaterThan(2);
  });

  it('walks the whole pattern at a realistic tick rate', () => {
    h.player.play(SAMPLE);
    for (let i = 0; i < 100; i++) h.advance(40);
    const positions = h.buttplugSync.linear.map((s) => s.pos);
    expect(positions).toContain(0);
    expect(positions).toContain(100);
  });

  it('does not re-send a LINEAR target that has not moved', () => {
    h.player.play(SAMPLE);
    h.advance(100);
    h.advance(100);
    h.advance(100);
    // All inside the first ramp, all aiming at the same keyframe. The tick
    // path still resamples — only the linear dispatch is deduped.
    expect(h.buttplugSync.linear.length).toBe(1);
    expect(h.buttplugSync.sent.length).toBeGreaterThan(1);
  });

  it('reports progress and an interpolated position for the playhead', () => {
    const seen = [];
    h.player.onProgress = (progress, pos) => seen.push({ progress, pos });
    h.player.play(SAMPLE);
    h.advance(1000);
    expect(seen.length).toBeGreaterThan(1);
    const mid = seen[seen.length - 1];
    expect(mid.progress).toBeCloseTo(0.25, 2);
    // Halfway up the first ramp, not already at the target.
    expect(mid.pos).toBeGreaterThan(40);
    expect(mid.pos).toBeLessThan(60);
  });
});

describe('FillerTestPlayer — stopping', () => {
  it('stops the devices for real when the run ends', () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.player.onEnd = ended;
    h.player.play(SAMPLE);
    h.advance(4100);
    expect(h.player.running).toBe(false);
    expect(h.buttplugSync.stops).toBe(1);
    expect(h.tcodeSync.stops).toBe(1);
    expect(ended).toHaveBeenCalled();
  });

  it('stops the devices when stopped early', () => {
    const h = makeHarness();
    h.player.play(SAMPLE);
    h.advance(500);
    h.player.stop();
    expect(h.player.running).toBe(false);
    expect(h.buttplugSync.stops).toBe(1);
    expect(h.tcodeSync.stops).toBe(1);
  });

  it('reaches progress 1 so the playhead does not freeze mid-sweep', () => {
    const h = makeHarness();
    const seen = [];
    h.player.onProgress = (p) => seen.push(p);
    h.player.play(SAMPLE);
    h.advance(4100);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('restarting stops the previous run first', () => {
    const h = makeHarness();
    h.player.play(SAMPLE);
    h.player.play(SAMPLE);
    expect(h.buttplugSync.stops).toBe(1);
    expect(h.player.running).toBe(true);
    h.player.stop();
  });

  it('survives an engine that throws on stop', () => {
    const h = makeHarness();
    h.buttplugSync.stopTestOutput = () => { throw new Error('disconnected'); };
    h.player.play(SAMPLE);
    expect(() => h.player.stop()).not.toThrow();
    // The other engine must still be idled.
    expect(h.tcodeSync.stops).toBe(1);
  });

  it('works with only one engine present', () => {
    const player = new FillerTestPlayer({ buttplugSync: makeEngine() });
    expect(() => player.stop()).not.toThrow();
  });
});
