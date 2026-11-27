/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 * Every browser hook GamepadRecorder uses is injected (getGamepads, the
 * clock, frames, the timer, the window); the default window listener is
 * checked under jsdom in gamepad-record-menu.test.js.
 */
// GamepadRecorder (editor work list 2.6, 2026-11-24): two stick axes into
// two funscript axes while the video plays, as OFS's controller recording.
import { describe, it, expect, vi } from 'vitest';
import { GamepadRecorder, cleanPadName, DEFAULT_GAMEPAD_MAPPING, STICK_AXES } from '../../renderer/js/gamepad-recorder.js';

/** A fake browser: pads, a clock, animation frames and a timer run by hand, a video. */
function makeEnv() {
  const env = {
    pads: [],
    clock: 0,
    frameCb: null,
    timerFn: null,
    cancelled: { frame: 0, timer: 0 },
    video: { t: 0, playing: false },
  };
  env.opts = {
    getGamepads: () => env.pads,
    now: () => env.clock,
    requestFrame: (cb) => { env.frameCb = cb; return 1; },
    cancelFrame: () => { env.frameCb = null; env.cancelled.frame++; },
    setTimer: (fn) => { env.timerFn = fn; return 2; },
    clearTimer: () => { env.timerFn = null; env.cancelled.timer++; },
    win: null,
    getVideoTimeMs: () => env.video.t,
    isPlaying: () => env.video.playing,
  };
  /** One animation frame: the clock and (if playing) the video move on by `ms`. */
  env.frame = (ms = 1000 / 60) => {
    env.clock += ms;
    if (env.video.playing) env.video.t += ms;
    const cb = env.frameCb;
    env.frameCb = null;
    cb?.(env.clock);
  };
  env.pad = (axes, extra = {}) => {
    const pad = { index: env.pads.length, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping: 'standard', connected: true, axes, buttons: [], ...extra };
    env.pads.push(pad);
    return pad;
  };
  return env;
}

describe('GamepadRecorder: reading the stick', () => {
  it('defaults: left stick X is A, left stick Y is B with up = 100, roll and pitch as targets', () => {
    expect(DEFAULT_GAMEPAD_MAPPING).toEqual({ x: 'roll', y: 'pitch', invertX: false, invertY: false });
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    expect(rec.config.axisA).toBe(STICK_AXES.leftX);
    expect(rec.config.axisB).toBe(STICK_AXES.leftY);
    env.pad([1, -1, 0, 0]); // right and up
    expect(rec.read()).toMatchObject({ a: 100, b: 100 });
    env.pads[0].axes = [-1, 1, 0, 0]; // left and down
    expect(rec.read()).toMatchObject({ a: 0, b: 0 });
  });

  it('a stick resting inside the deadzone reads 50', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder({ ...env.opts, deadzone: 0.15 });
    env.pad([0.12, -0.14, 0, 0]);
    expect(rec.read()).toMatchObject({ a: 50, b: 50 });
    rec.configure({ deadzone: 0.05 });
    const r = rec.read();
    expect(r.a).toBeGreaterThan(50);
    expect(r.b).toBeGreaterThan(50); // pushed up a little
  });

  it('invert flips each direction on its own', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder({ ...env.opts, invertA: true });
    env.pad([1, -1, 0, 0]);
    expect(rec.read()).toMatchObject({ a: 0, b: 100 });
    rec.configure({ invertA: false, invertB: true });
    expect(rec.read()).toMatchObject({ a: 100, b: 0 });
  });

  it('can read the right stick instead', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder({ ...env.opts, axisA: STICK_AXES.rightX, axisB: STICK_AXES.rightY });
    env.pad([0, 0, -1, -1]);
    expect(rec.read()).toMatchObject({ a: 0, b: 100 });
  });

  it('no pad: read() is null and padName() is null', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    expect(rec.read()).toBe(null);
    expect(rec.padName()).toBe(null);
    env.pads.push(null); // Chromium's empty slots
    expect(rec.read()).toBe(null);
  });

  it('picks the chosen pad, else the first with the standard mapping', () => {
    const env = makeEnv();
    env.pad([1, 0], { id: 'USB Joystick (Vendor: 0079 Product: 0006)', mapping: '' });
    env.pad([-1, 0], { id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)' });
    const rec = new GamepadRecorder(env.opts);
    expect(rec.padName()).toBe('Wireless Controller');
    expect(rec.read().a).toBe(0);
    rec.configure({ padIndex: 0 });
    expect(rec.padName()).toBe('USB Joystick');
    rec.configure({ padIndex: 5 });
    expect(rec.read()).toBe(null);
    expect(rec.listPads().map((p) => p.name)).toEqual(['USB Joystick', 'Wireless Controller']);
  });
});

describe('cleanPadName', () => {
  it('drops the mapping and USB ids Chromium and Firefox add', () => {
    expect(cleanPadName('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('Xbox 360 Controller');
    expect(cleanPadName('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe('Wireless Controller');
    expect(cleanPadName('USB Gamepad (Vendor: 0079 Product: 0006)')).toBe('USB Gamepad');
    expect(cleanPadName('045e-028e-Microsoft X-Box 360 pad')).toBe('Microsoft X-Box 360 pad');
    expect(cleanPadName('My Pad')).toBe('My Pad');
    expect(cleanPadName('(STANDARD GAMEPAD)')).toBe('(STANDARD GAMEPAD)'); // nothing else to call it
  });
});

describe('GamepadRecorder: recording', () => {
  it('samples once per animation frame, ONLY while the video plays', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    env.pad([0.55, 0, 0, 0]);
    expect(rec.start()).toBe(true);
    env.video.t = 10000;
    for (let i = 0; i < 5; i++) env.frame(); // paused: nothing
    env.video.playing = true;
    for (let i = 0; i < 6; i++) env.frame();
    env.video.playing = false;
    for (let i = 0; i < 5; i++) env.frame();
    const out = rec.stop();
    expect(out.a.length).toBe(6);
    expect(out.b.length).toBe(6);
    expect(out.a.every((s) => Math.abs(s.pos - 75) < 1e-9)).toBe(true);
    expect(out.b.every((s) => s.pos === 50)).toBe(true);
    expect(out.t0).toBeCloseTo(10000 + 1000 / 60, 6);
    expect(out.t1).toBeCloseTo(10100, 6);
    expect(out.segments.length).toBe(1);
    expect(rec.recording).toBe(false);
  });

  it('follows the stick as it moves', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    const pad = env.pad([0, 0, 0, 0]);
    rec.start();
    env.video.playing = true;
    const xs = [-1, -0.5, 0, 0.5, 1];
    for (const x of xs) { pad.axes = [x, x, 0, 0]; env.frame(); } // left-up to right-down
    const out = rec.stop();
    expect(out.a.map((s) => Math.round(s.pos))).toEqual([0, 28, 50, 72, 100]);
    expect(out.b.map((s) => Math.round(s.pos))).toEqual([100, 72, 50, 28, 0]);
  });

  it('a pause ends a take and hands it to onTake; stop() then returns only the rest', () => {
    const env = makeEnv();
    const onTake = vi.fn();
    const rec = new GamepadRecorder({ ...env.opts, onTake });
    env.pad([1, 0, 0, 0]);
    rec.start();
    env.video.playing = true;
    for (let i = 0; i < 4; i++) env.frame();
    env.video.playing = false;
    env.frame();
    expect(onTake).toHaveBeenCalledTimes(1);
    const [take, reason] = onTake.mock.calls[0];
    expect(reason).toBe('pause');
    expect(take.a.length).toBe(4);
    expect(take.t1).toBeGreaterThan(take.t0);
    env.video.playing = true;
    for (let i = 0; i < 3; i++) env.frame();
    const out = rec.stop();
    expect(onTake).toHaveBeenCalledTimes(1); // stop's own take comes back, not through onTake
    expect(out.a.length).toBe(3);
    expect(out.t0).toBeGreaterThan(take.t1);
  });

  it('a seek ends a take: forward past the gap, or back', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    env.pad([0, 0, 0, 0]);
    rec.start();
    env.video.t = 1000;
    env.video.playing = true;
    for (let i = 0; i < 3; i++) env.frame();
    env.video.t = 5000; // jump ahead
    for (let i = 0; i < 3; i++) env.frame();
    env.video.t = 2000; // jump back
    for (let i = 0; i < 3; i++) env.frame();
    const out = rec.stop();
    expect(out.segments.length).toBe(3);
    expect(out.segments.map((s) => Math.round(s.t0))).toEqual([1017, 5017, 2017]);
    expect(out.t0).toBeCloseTo(1000 + 1000 / 60, 6);
    expect(out.t1).toBeCloseTo(5050, 6);
  });

  it('a video time that has not moved on keeps one sample, with the newest stick', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    const pad = env.pad([0, 0, 0, 0]);
    rec.start();
    env.video.playing = true;
    env.frame();
    const at = env.video.t;
    pad.axes = [1, 0, 0, 0];
    env.video.t = at - 5; // a little jitter back is not a seek
    env.frame(0);
    env.video.t = at;
    env.frame(0);
    const out = rec.stop();
    expect(out.a).toEqual([{ at, pos: 100 }]);
  });

  it('no pad, no samples; a pad that turns up is used from then on', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    rec.start();
    env.video.playing = true;
    for (let i = 0; i < 3; i++) env.frame();
    env.pad([1, 0, 0, 0]);
    for (let i = 0; i < 2; i++) env.frame();
    expect(rec.stop().a.length).toBe(2);
  });

  it('when animation frames stop (window hidden), the timer keeps the take going', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    env.pad([1, 0, 0, 0]);
    rec.start();
    env.video.playing = true;
    env.frame();
    // Frames running: the timer stays out of the way.
    env.timerFn();
    // Frames stop; time goes on.
    env.frameCb = null;
    env.clock += 150;
    env.video.t += 150;
    env.timerFn();
    env.clock += 50;
    env.video.t += 50;
    env.timerFn();
    const out = rec.stop();
    expect(out.a.length).toBe(3);
  });

  it('stop() ends the frame loop and the timer; start() twice is refused', () => {
    const env = makeEnv();
    const rec = new GamepadRecorder(env.opts);
    expect(rec.start()).toBe(true);
    expect(rec.start()).toBe(false);
    expect(env.frameCb).not.toBe(null);
    rec.stop();
    expect(env.cancelled).toEqual({ frame: 1, timer: 1 });
    expect(env.frameCb).toBe(null);
    expect(env.timerFn).toBe(null);
    expect(rec.stop()).toEqual({ a: [], b: [], t0: null, t1: null, segments: [] });
  });

  it('cancel() throws the recording away', () => {
    const env = makeEnv();
    const onTake = vi.fn();
    const rec = new GamepadRecorder({ ...env.opts, onTake });
    env.pad([1, 0, 0, 0]);
    rec.start();
    env.video.playing = true;
    env.frame();
    rec.cancel();
    expect(onTake).not.toHaveBeenCalled();
    expect(rec.recording).toBe(false);
    expect(rec.stop().a).toEqual([]);
  });

  it('a throwing video hook or onTake does not kill the loop', () => {
    const env = makeEnv();
    let boom = true;
    const rec = new GamepadRecorder({
      ...env.opts,
      getVideoTimeMs: () => { if (boom) throw new Error('gone'); return env.video.t; },
      onTake: () => { throw new Error('listener'); },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    env.pad([1, 0, 0, 0]);
    rec.start();
    env.video.playing = true;
    env.frame();
    boom = false;
    env.frame();
    env.video.playing = false;
    env.frame();
    expect(env.frameCb).not.toBe(null);
    warn.mockRestore();
  });
});

describe('GamepadRecorder: readout and pads', () => {
  it('preview() reports positions every frame without recording', () => {
    const env = makeEnv();
    const frames = [];
    const rec = new GamepadRecorder({ ...env.opts, onFrame: (f) => frames.push(f) });
    env.pad([1, 1, 0, 0]);
    rec.preview(true);
    env.frame();
    expect(frames).toEqual([{ a: 100, b: 0, pad: 'Xbox 360 Controller', playing: false, recording: false }]);
    rec.preview(false);
    expect(env.frameCb).toBe(null);
    expect(rec.stop().a).toEqual([]);
  });

  it('tells onPadsChanged when a pad connects or goes', () => {
    const env = makeEnv();
    const win = new EventTarget();
    const onPadsChanged = vi.fn();
    const rec = new GamepadRecorder({ ...env.opts, win, onPadsChanged });
    env.pad([0, 0]);
    win.dispatchEvent(new Event('gamepadconnected'));
    expect(onPadsChanged).toHaveBeenLastCalledWith([{ index: 0, id: env.pads[0].id, name: 'Xbox 360 Controller', mapping: 'standard' }], 'gamepadconnected');
    env.pads[0].connected = false;
    win.dispatchEvent(new Event('gamepaddisconnected'));
    expect(onPadsChanged).toHaveBeenLastCalledWith([], 'gamepaddisconnected');
    rec.dispose();
    win.dispatchEvent(new Event('gamepadconnected'));
    expect(onPadsChanged).toHaveBeenCalledTimes(2);
  });
});
