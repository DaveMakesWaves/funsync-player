/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// One Test at a time for the three Pattern blocks (Gap Filler, Orgasm Switch,
// Edge Hold; Dave 2026-11-19): filler-test-player.js createPatternTestSession
// over the EXISTING path, app.js's REAL `_startFillerTest` (lifted from the
// source) driving the REAL FillerTestPlayer on fake Buttplug / T-Code sync
// engines. No device. Asserted: what the devices are sent, what each block
// is told, and that nothing starts while a video drives the devices.
//
// Plus the generic preview's colours (filler-preview.js previewColors /
// drawSamplePreview): from the theme's tokens, so light and dark differ.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { FillerTestPlayer, createPatternTestSession } from '../../renderer/js/filler-test-player.js';
import { previewColors, drawSamplePreview, drawFillerWaveform, buildPreviewSample, PREVIEW_WINDOW_MS } from '../../renderer/js/filler-preview.js';

const LiftedApp = liftAppClass(['_startFillerTest'], { FillerTestPlayer });

function fakeSync({ driving = false } = {}) {
  return {
    driving,
    sent: [],
    stops: 0,
    isDriving() { return this.driving; },
    sendLinearNow(pos, ms) { this.sent.push(['linear', pos, ms]); },
    sendPositionNow(pos, ms) { this.sent.push(['pos', pos, ms]); },
    stopTestOutput() { this.stops++; },
  };
}

/** The app as app.js builds it, on a timer the test drives. */
function makeApp({ connected = true, driving = false } = {}) {
  const app = new LiftedApp();
  app.buttplugSync = fakeSync({ driving });
  app.tcodeSync = fakeSync();
  app.buttplugManager = { connected };
  app.tcodeManager = { connected: false };
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  app._fillerTest = new FillerTestPlayer({
    buttplugSync: app.buttplugSync,
    tcodeSync: app.tcodeSync,
    now: () => now,
    setInterval: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearInterval: (id) => { timers.delete(id); },
  });
  app.advance = (ms) => {
    for (let t = 0; t < ms; t += 40) { now += 40; for (const fn of [...timers.values()]) fn(); }
  };
  return app;
}

function sessionFor(app) {
  return createPatternTestSession({
    start: (actions, hooks) => app._startFillerTest(actions, hooks),
    stop: () => app._fillerTest?.stop(),
  });
}

const SAMPLE_A = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }];
const SAMPLE_B = [{ at: 0, pos: 50 }, { at: 400, pos: 10 }, { at: 800, pos: 50 }, { at: 1200, pos: 10 }];

function blockHooks() {
  return { onProgress: vi.fn(), onEnd: vi.fn() };
}

describe('one test at a time across the three blocks', () => {
  it('starts through app.js\'s path and drives the devices along the block\'s own sample', () => {
    const app = makeApp();
    const session = sessionFor(app);
    const a = blockHooks();
    expect(session.start('gapFiller', SAMPLE_A, a)).toBe('started');
    expect(session.activeOwner).toBe('gapFiller');
    app.advance(200);
    expect(app.buttplugSync.sent.some(([kind, pos]) => kind === 'linear' && pos === 100)).toBe(true);
    expect(a.onProgress).toHaveBeenCalled();
    const [progress] = a.onProgress.mock.calls.at(-1);
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
  });

  it('a second block\'s Test ends the first block\'s run (its button goes back to Test) and plays its own sample', () => {
    const app = makeApp();
    const session = sessionFor(app);
    const x = blockHooks();
    const z = blockHooks();
    session.start('orgasm', SAMPLE_A, x);
    app.advance(120);
    const before = app.buttplugSync.sent.length;
    expect(session.start('edge', SAMPLE_B, z)).toBe('started');
    // Z's sample aims at once: down towards 10 from where it starts.
    expect(app.buttplugSync.sent.slice(before).some(([kind, pos]) => kind === 'linear' && pos === 10)).toBe(true);
    expect(x.onEnd).toHaveBeenCalledTimes(1);   // X's block is told
    expect(z.onEnd).not.toHaveBeenCalled();     // the restart's own stop is not Z's end
    expect(session.activeOwner).toBe('edge');
    app.buttplugSync.sent.length = 0;
    const xProgress = x.onProgress.mock.calls.length;
    app.advance(600);
    expect(x.onProgress.mock.calls.length).toBe(xProgress);   // X's playhead no longer moves
    expect(z.onProgress).toHaveBeenCalled();
    // ...then back up to 50, Z's next keyframe (never SAMPLE_A's 100).
    expect(app.buttplugSync.sent.some(([kind, pos]) => kind === 'linear' && pos === 50)).toBe(true);
    expect(app.buttplugSync.sent.some(([kind, pos]) => kind === 'linear' && pos === 100)).toBe(false);
  });

  it('a late hook from an earlier run never ends or moves the run that replaced it', () => {
    const handed = [];
    const session = createPatternTestSession({ start: (actions, hooks) => { handed.push(hooks); return 'started'; } });
    const x = blockHooks();
    const z = blockHooks();
    session.start('orgasm', SAMPLE_A, x);
    session.start('edge', SAMPLE_B, z);
    expect(x.onEnd).toHaveBeenCalledTimes(1);
    // X's run reports late (a tick or an end already queued when Z started).
    handed[0].onProgress(0.7);
    handed[0].onEnd();
    expect(x.onProgress).not.toHaveBeenCalled();
    expect(x.onEnd).toHaveBeenCalledTimes(1);
    expect(z.onEnd).not.toHaveBeenCalled();
    expect(session.activeOwner).toBe('edge');
    handed[1].onProgress(0.2);
    expect(z.onProgress).toHaveBeenCalledWith(0.2, undefined);
  });

  it('a run that ends on its own tells its block once and frees the session', () => {
    const app = makeApp();
    const session = sessionFor(app);
    const a = blockHooks();
    session.start('gapFiller', SAMPLE_A, a);
    app.advance(1200);
    expect(a.onEnd).toHaveBeenCalledTimes(1);
    expect(session.activeOwner).toBeNull();
    expect(app.buttplugSync.stops).toBeGreaterThan(0);   // a real stop, not just silence
  });

  it('Stop idles the devices and tells the block; stop(other owner) leaves the run alone', () => {
    const app = makeApp();
    const session = sessionFor(app);
    const a = blockHooks();
    session.start('gapFiller', SAMPLE_A, a);
    session.stop('edge');
    expect(session.activeOwner).toBe('gapFiller');
    expect(a.onEnd).not.toHaveBeenCalled();
    const stops = app.buttplugSync.stops;
    session.stop('gapFiller');
    expect(app.buttplugSync.stops).toBe(stops + 1);
    expect(a.onEnd).toHaveBeenCalledTimes(1);
    expect(session.activeOwner).toBeNull();
    session.stop();   // nothing running: nothing happens
    expect(a.onEnd).toHaveBeenCalledTimes(1);
  });

  it('never starts while a video drives the devices (as today): busy, nothing sent', () => {
    const app = makeApp({ driving: true });
    const session = sessionFor(app);
    const a = blockHooks();
    expect(session.start('edge', SAMPLE_A, a)).toBe('busy');
    app.advance(400);
    expect(app.buttplugSync.sent).toEqual([]);
    expect(app.tcodeSync.sent).toEqual([]);
    expect(session.activeOwner).toBeNull();
    expect(a.onProgress).not.toHaveBeenCalled();
  });

  it('nothing connected, or no sample to play: refused, nothing sent', () => {
    const app = makeApp({ connected: false });
    const session = sessionFor(app);
    expect(session.start('orgasm', SAMPLE_A, blockHooks())).toBe('no-devices');
    const app2 = makeApp();
    const session2 = sessionFor(app2);
    expect(session2.start('orgasm', [], blockHooks())).toBe('empty');
    expect(session2.start('orgasm', [{ at: 0, pos: 1 }], blockHooks())).toBe('empty');
    expect(app.buttplugSync.sent).toEqual([]);
    expect(app2.buttplugSync.sent).toEqual([]);
  });

  it('a start that throws reads as not started', () => {
    const session = createPatternTestSession({ start: () => { throw new Error('gone'); } });
    expect(session.start('edge', SAMPLE_A, blockHooks())).toBe('no-devices');
    expect(session.activeOwner).toBeNull();
  });
});

describe('the generic preview (filler-preview.js)', () => {
  afterEach(() => { delete globalThis.getComputedStyle; });

  function tokens(map) {
    globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => map[name] || '' });
    return {};
  }
  function recordingCanvas() {
    const ctx = {
      strokes: [],
      setTransform() {}, clearRect() {}, beginPath() { this.n = 0; }, moveTo() { this.n = 1; }, lineTo() { this.n++; },
      stroke() { this.strokes.push({ style: this.strokeStyle, points: this.n }); },
      save() {}, restore() {}, closePath() {}, fill() {},
    };
    return { ctx, canvas: { clientWidth: 260, clientHeight: 60, width: 260, height: 60, getContext: () => ctx } };
  }

  it('colours come from the theme\'s tokens, so dark and light each get their own', () => {
    const dark = previewColors(tokens({ '--accent': '#e94560', '--border-strong': 'rgba(255,255,255,0.18)', '--text-primary': '#e0e0e0' }));
    const light = previewColors(tokens({ '--accent': '#e94560', '--border-strong': 'rgba(0,0,0,0.18)', '--text-primary': '#1a1a1f' }));
    expect(dark).toEqual({ stroke: '#e94560', grid: 'rgba(255,255,255,0.18)', playhead: '#e0e0e0' });
    expect(light).toEqual({ stroke: '#e94560', grid: 'rgba(0,0,0,0.18)', playhead: '#1a1a1f' });
    // The playhead never takes the curve's colour.
    expect(dark.playhead).not.toBe(dark.stroke);
    expect(light.playhead).not.toBe(light.stroke);
  });

  it('draws any sample: midline, the curve through every action, the playhead only while a test runs', () => {
    tokens({ '--accent': 'ACCENT', '--border-strong': 'GRID', '--text-primary': 'HEAD' });
    const { ctx, canvas } = recordingCanvas();
    drawSamplePreview(canvas, SAMPLE_B, { colors: previewColors({}) });
    expect(ctx.strokes.map((s) => s.style)).toEqual(['GRID', 'ACCENT']);
    expect(ctx.strokes[1].points).toBe(SAMPLE_B.length);
    ctx.strokes.length = 0;
    drawSamplePreview(canvas, SAMPLE_B, { playhead: 0.5, colors: previewColors({}) });
    expect(ctx.strokes.map((s) => s.style)).toEqual(['GRID', 'ACCENT', 'HEAD']);
  });

  it('keeps its existing exports working (the old gap preview builder and drawer)', () => {
    const { actions, stats } = buildPreviewSample({ pattern: 'sine', bpm: 30, min: 20, max: 80 });
    expect(actions.length).toBeGreaterThan(2);
    expect(actions.at(-1).at).toBeLessThanOrEqual(PREVIEW_WINDOW_MS);
    expect(stats.avgSpeed).toBeGreaterThan(0);
    const { ctx, canvas } = recordingCanvas();
    drawFillerWaveform(canvas, actions, { stroke: 'S', grid: 'G' });
    expect(ctx.strokes.map((s) => s.style)).toEqual(['G', 'S']);
  });
});
