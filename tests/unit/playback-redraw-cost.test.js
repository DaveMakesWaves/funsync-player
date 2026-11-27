// The playback stutter fix (2026-11-20). See electron/gpu-switches.js for the measurements.
//
// 1. gpuSwitches: on Windows FunSync turns off DirectComposition only when the
//    user turns "Smooth playback with overlays" ON (opt-in, default off);
//    Linux keeps its decode switch exactly as before; macOS gets nothing.
// 2. InlineViz._fitCanvas reads the TL box (a forced layout) only when it may
//    have changed, not every frame (it was ~21% of the renderer's time).
// 3. DeviceSimulator writes to the page only when a shown value changes, so a
//    paused video with the panel open is not redrawn every frame.
//
// jsdom: InlineViz and DeviceSimulator build DOM.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { InlineViz } from '../../renderer/components/inline-viz.js';
import { DeviceSimulator } from '../../renderer/components/device-simulator.js';

const require = createRequire(import.meta.url);
const { gpuSwitches } = require('../../electron/gpu-switches.js');

describe('gpuSwitches', () => {
  it('Windows: nothing changes by default (no config, no player object, key absent, false, not exactly true)', () => {
    for (const player of [undefined, null, {}, { hwVideoDecode: false }, { smoothOverlays: false }, { smoothOverlays: 'yes' }]) {
      expect(gpuSwitches('win32', player)).toEqual([]);
    }
  });
  it('Windows: only an explicit opt-in (smoothOverlays true) turns DirectComposition off', () => {
    expect(gpuSwitches('win32', { smoothOverlays: true })).toEqual([['disable-direct-composition']]);
  });
  it('Linux: VA-API by default, software decode when hwVideoDecode is false, never the Windows switch', () => {
    const vaapi = [['enable-features', 'VaapiVideoDecoder,VaapiIgnoreDriverChecks']];
    expect(gpuSwitches('linux', undefined)).toEqual(vaapi);
    expect(gpuSwitches('linux', { smoothOverlays: true })).toEqual(vaapi);
    expect(gpuSwitches('linux', { hwVideoDecode: false })).toEqual([['disable-accelerated-video-decode']]);
  });
  it('macOS: nothing', () => {
    expect(gpuSwitches('darwin', { smoothOverlays: true, hwVideoDecode: true })).toEqual([]);
  });
});

const ACTIONS = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 20 }];

describe('InlineViz: the TL box is measured only when it may have changed', () => {
  let observers;
  let realRO;
  let realDpr;
  beforeEach(() => {
    document.body.innerHTML = '';
    observers = [];
    realRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); } observe(t) { this.targets.push(t); } disconnect() {} };
    realDpr = window.devicePixelRatio;
  });
  afterEach(() => {
    globalThis.ResizeObserver = realRO;
    Object.defineProperty(window, 'devicePixelRatio', { value: realDpr, configurable: true });
  });

  /** An InlineViz with the TL on and a TL box whose clientWidth reads are counted. */
  function setup() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const video = document.createElement('video');
    const viz = new InlineViz({ container, video });
    viz.setScript(ACTIONS, 60);
    viz.setTimelineVisible(true);
    const box = viz._tlWrap;
    let width = 800;
    const reads = { n: 0 };
    Object.defineProperty(box, 'clientWidth', { get: () => { reads.n++; return width; }, configurable: true });
    Object.defineProperty(box, 'clientHeight', { get: () => 90, configurable: true });
    const resize = vi.spyOn(viz._graph, 'resize');
    return { viz, reads, resize, setWidth: (w) => { width = w; } };
  }

  it('observes the TL itself as well as the root', () => {
    const { viz } = setup();
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toEqual(expect.arrayContaining([viz._root, viz._tlWrap]));
  });

  it('reads the box once, then not again on later frames', () => {
    const { viz, reads, resize } = setup();
    viz._drawFrame();
    expect(reads.n).toBe(1);
    expect(resize).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i++) viz._drawFrame();
    expect(reads.n).toBe(1);
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it('a resize reported by the observer is picked up: read again, graph resized to the new size', () => {
    const { viz, reads, resize, setWidth } = setup();
    viz._drawFrame();
    setWidth(1400);
    observers[0].cb([]);
    expect(reads.n).toBe(2);
    expect(resize).toHaveBeenCalledTimes(2);
    viz._drawFrame();
    expect(reads.n).toBe(2);
  });

  it('a DPR change (a window moved to another monitor) is picked up without an observer callback', () => {
    const { viz, reads, resize } = setup();
    viz._drawFrame();
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    viz._drawFrame();
    expect(reads.n).toBe(2);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it('a hidden TL (0 wide) stays dirty and is measured again until it has a size', () => {
    const { viz, reads, resize, setWidth } = setup();
    setWidth(0);
    viz._drawFrame();
    viz._drawFrame();
    expect(reads.n).toBe(2);
    expect(resize).not.toHaveBeenCalled();
    setWidth(900);
    viz._drawFrame();
    expect(resize).toHaveBeenCalledTimes(1);
    viz._drawFrame();
    expect(reads.n).toBe(3);
  });

  it('turning the TL back on re-measures it', () => {
    const { viz, reads } = setup();
    viz._drawFrame();
    viz.setTimelineVisible(false);
    viz.setTimelineVisible(true);
    viz._drawFrame();
    expect(reads.n).toBeGreaterThanOrEqual(2);
  });

  it('with no ResizeObserver it measures every frame, as before', () => {
    globalThis.ResizeObserver = undefined;
    const { viz, reads, resize } = setup();
    viz._drawFrame();
    viz._drawFrame();
    viz._drawFrame();
    expect(reads.n).toBe(3);
    expect(resize).toHaveBeenCalledTimes(1);
  });
});

describe('DeviceSimulator: writes only what changed', () => {
  let sim;
  let player;
  let pos;
  beforeEach(() => {
    if (!document.getElementById('app')) { const a = document.createElement('div'); a.id = 'app'; document.body.appendChild(a); }
    player = { video: document.createElement('video'), currentTime: 10, paused: true };
    pos = 50;
    sim = new DeviceSimulator({ videoPlayer: player, funscriptEngine: { isLoaded: true, getPositionAt: () => pos } });
  });
  afterEach(() => { sim.hide(); document.querySelector('.device-sim')?.remove(); });

  /** Count property writes on the elements the frame loop touches. */
  function countWrites() {
    const n = { text: 0, style: 0 };
    for (const el of [sim._posLabel, sim._speedLabel]) {
      let v = el.textContent;
      Object.defineProperty(el, 'textContent', { get: () => v, set: (x) => { n.text++; v = String(x); }, configurable: true });
    }
    for (const el of [sim._marker, sim._fill]) {
      const style = el.style;
      const real = { bottom: style.bottom, height: style.height };
      Object.defineProperty(el, 'style', { value: new Proxy(style, { set: (t, k, x) => { n.style++; t[k] = x; real[k] = x; return true; } }), configurable: true });
    }
    return n;
  }

  it('a paused video (nothing changes) writes nothing after the first frame', () => {
    sim._update();
    const n = countWrites();
    for (let i = 0; i < 20; i++) sim._update();
    expect(n).toEqual({ text: 0, style: 0 });
  });

  it('a moving position writes the marker, the fill and the labels, with the right values', () => {
    sim._update();
    const n = countWrites();
    pos = 80;
    player.currentTime = 10.1;
    sim._update();
    expect(n.style).toBe(2);
    expect(sim._marker.style.bottom).toBe('80%');
    expect(sim._fill.style.height).toBe('80%');
    expect(sim._posLabel.textContent).toBe('80');
    expect(sim._speedLabel.textContent).toBe('300');
  });
});
