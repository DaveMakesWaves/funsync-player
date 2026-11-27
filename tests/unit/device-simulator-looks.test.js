/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL DeviceSimulator builds its panel, its other
 * axes' block and its right-click menu, and the test right-clicks and drags
 * them (notes/CLAUDE.md "Test environments").
 */
// The simulator's other axes (editor work list 2.5, 2026-11-24). Dave:
// "option D as the default but just in case the user's pc struggles with 3d,
// the other 2d styles you added should be options with right click on the
// simulator". Asserted: the 3D receiver shows for any video (a stroke-only
// one moves it up and down only), a 2D look with only the stroke is exactly
// today's bar, each look shows the axes the video has, the Look / Size /
// View choices and a drag on the 3D picture reach the settings, the picture
// is drawn only when something changed and never while hidden, and app.js's
// wiring (settings, the editor's live points first).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { liftAppClass } from './helpers/app-methods.js';

const { DeviceSimulator, resolveSimOptions } = await import('../../renderer/components/device-simulator.js');
const { SIM3D_VIEWS } = await import('../../renderer/js/sim-receiver-3d.js');
const { getAxisBySuffix } = await import('../../renderer/js/multi-axis.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { DEFAULTS } = createRequire(import.meta.url)('../../electron/store.js');

// The new strings until they are merged into the locale files (the real
// ones win once they are there).
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
EN.deviceSim = {
  menuLook: 'Look', look3d: '3D receiver', lookDrawing: 'Drawing and numbers', lookBars: 'A bar per axis', lookGauges: 'Gauges',
  menuSize: 'Size', sizeSmall: 'Small', sizeLarge: 'Large',
  menuView: 'View', viewQuarter: 'Three-quarter', viewFront: 'Front', viewSide: 'Side', viewAbove: 'Above',
  align: 'Align to the video…', tooltipAligned: 'Lined up with the video', axesAria: 'Other axes',
  receiverAria: 'The receiver', receiver3dAria: '3D receiver: drag',
  ...EN.deviceSim,
};
const S = EN.deviceSim;

/** Every 2D canvas context records its calls (jsdom draws nothing). */
let draws2d = 0;
const origGetContext = HTMLCanvasElement.prototype.getContext;
function recordingCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
      if (prop === 'clearRect') return () => { draws2d++; };
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

let rafQueue = [];
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  _setBundlesForTests('en', EN, EN);
  window.innerWidth = 1000;
  window.innerHeight = 800;
  draws2d = 0;
  HTMLCanvasElement.prototype.getContext = function getContext(type) { return type === '2d' ? (this._rec ||= recordingCtx()) : null; };
  rafQueue = [];
  // A display's frames are 16.7 ms apart (60 Hz): runFrames steps this clock.
  // The 3D picture draws a pose at most every 15 ms (sim-axes-view POSE_FRAME_MS).
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { rafQueue.push(cb); return rafQueue.length; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  vi.restoreAllMocks();
});

/** Run the frames queued so far (one animation frame each). */
let clock = 1000;
let frameMs = 1000 / 60;
function runFrames(n = 1) {
  for (let i = 0; i < n; i++) {
    clock += frameMs;
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(performance.now());
  }
}

const twistPts = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
const vibPts = [{ at: 0, pos: 20 }, { at: 1000, pos: 60 }];

function sim({ look = {}, axes = {}, hooks = {}, raw = {} } = {}) {
  const player = { currentTime: 0 };
  let pos = 30;
  const engine = { isLoaded: true, getPositionAt: () => pos };
  const source = (suffix) => axes[suffix] || null;
  const s = new DeviceSimulator({
    videoPlayer: player, funscriptEngine: engine, options: resolveSimOptions(raw), axisSource: source, look, ...hooks,
  });
  return { s, panel: document.querySelector('.device-sim'), player, setPos: (p) => { pos = p; } };
}
const block = () => document.querySelector('.device-sim__axes');
const ev = (type, x, y, extra = {}) => new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...extra });

describe('built without `look`, it is today\'s bar alone', () => {
  it('no other axes, no Look on the menu', () => {
    const s = new DeviceSimulator({ videoPlayer: { currentTime: 0 }, funscriptEngine: { isLoaded: true, getPositionAt: () => 40 }, axisSource: () => twistPts });
    s._update();
    expect(block()).toBeNull();
    s._panel.querySelector('.device-sim__track').dispatchEvent(ev('contextmenu', 10, 10));
    const headings = [...document.querySelectorAll('.device-sim__menu-heading')].map((h) => h.textContent);
    expect(headings).not.toContain(S.menuLook);
  });
});

describe('the 3D receiver (the default look)', () => {
  it('shows for a stroke-only video, and a stroke moves it up and down only', () => {
    const { s, setPos } = sim();
    s.show();
    runFrames();
    expect(block().hidden).toBe(false);
    expect(block().dataset.look).toBe('3d');
    expect(block().querySelector('canvas.device-sim__3d')).not.toBeNull();
    expect(block().querySelector('.device-sim__readout')).toBeNull();   // no other axis to read out
    const rc = s._axesView._receiver;
    const low = rc.centre();
    setPos(90);
    runFrames();
    const high = rc.centre();
    expect(high.y).toBeLessThan(low.y);
    expect(high.x).toBeCloseTo(low.x, 6);
  });

  it('shows the receiver axes the video has under it, and the others as rows', () => {
    const { s, player } = sim({ axes: { twist: twistPts, vib: vibPts } });
    s.show();
    player.currentTime = 0.5;
    runFrames();
    const read = [...block().querySelectorAll('.device-sim__readout span')].map((x) => x.textContent);
    expect(read).toEqual(['Twist 50']);
    const rows = [...block().querySelectorAll('.device-sim__axis-row')].map((r) => r.dataset.axis);
    expect(rows).toEqual(['vib']);
    expect(block().querySelector('.device-sim__axis-val').textContent).toBe('40');
  });

  it('draws only when something changed, and nothing while hidden or off the player view', () => {
    const { s, setPos } = sim();
    s.show();
    runFrames();
    const after1 = s._axesView.draws;
    expect(after1).toBe(1);
    runFrames(3);                        // nothing changed
    expect(s._axesView.draws).toBe(1);
    setPos(70);
    runFrames();
    expect(s._axesView.draws).toBe(2);
    // Off the player view (the mini player): the loop runs, nothing draws.
    document.getElementById('app').dataset.view = 'library';
    setPos(10);
    runFrames();
    expect(s._axesView.draws).toBe(2);
    document.getElementById('app').dataset.view = 'player';
    runFrames();
    expect(s._axesView.draws).toBe(3);
    // Hidden: the loop stops.
    s.hide();
    setPos(50);
    runFrames(3);
    expect(s._axesView.draws).toBe(3);
    expect(rafQueue).toHaveLength(0);
  });

  // One simulator (Dave, 2026-11-24: "both the 2d and 3d one appear side by
  // side, you can only move both around by dragging the 2d simulator"): a
  // drag on the 3D picture MOVES it, like the bar; the wheel turns the view;
  // the corner grip resizes the picture.
  it('a drag on the 3D picture moves the whole simulator, as one on the bar does', () => {
    const onOption = vi.fn();
    const onMoved = vi.fn();
    const { s, panel } = sim({ hooks: { onOption, onMoved } });
    s.show();
    runFrames();
    const cv = block().querySelector('canvas.device-sim__3d');
    cv.dispatchEvent(ev('pointerdown', 100, 100));
    window.dispatchEvent(ev('pointermove', 60, 80));
    window.dispatchEvent(ev('pointerup', 60, 80));
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(onOption.mock.calls.some(([k]) => k === 'view3d')).toBe(false);
    const track = panel.querySelector('.device-sim__track');
    track.dispatchEvent(ev('pointerdown', 500, 400));
    window.dispatchEvent(ev('pointermove', 450, 380));
    window.dispatchEvent(ev('pointerup', 450, 380));
    expect(onMoved).toHaveBeenCalledTimes(2);
  });

  it('the wheel over the picture turns the view (Shift: tilts), saved once it rests', () => {
    vi.useFakeTimers();
    try {
      const onOption = vi.fn();
      const { s } = sim({ hooks: { onOption } });
      s.show();
      runFrames();
      const cv = block().querySelector('canvas.device-sim__3d');
      const wheel = (deltaY, shiftKey = false) => { const e = new WheelEvent('wheel', { deltaY, shiftKey, bubbles: true, cancelable: true }); cv.dispatchEvent(e); return e; };
      expect(wheel(40).defaultPrevented).toBe(true);   // the page / video does not scroll
      wheel(40);
      expect(onOption.mock.calls.some(([k]) => k === 'view3d')).toBe(false);   // not per tick
      vi.advanceTimersByTime(450);
      const [key, view] = onOption.mock.calls.at(-1);
      expect(key).toBe('view3d');
      expect(view.yaw).not.toBe(SIM3D_VIEWS.quarter.yaw);
      expect(view.tilt).toBe(SIM3D_VIEWS.quarter.tilt);
      wheel(-40, true);
      vi.advanceTimersByTime(450);
      expect(onOption.mock.calls.at(-1)[1].tilt).not.toBe(SIM3D_VIEWS.quarter.tilt);
      expect(s.look.view.preset).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the corner grip resizes the 3D picture (up-left grows it), held to its limits, saved as a width', () => {
    const onOption = vi.fn();
    const onMoved = vi.fn();
    const { s } = sim({ hooks: { onOption, onMoved } });
    s.show();
    runFrames();
    const grip = block().querySelector('.device-sim__3d-grip');
    const cv = () => block().querySelector('canvas.device-sim__3d');
    grip.dispatchEvent(ev('pointerdown', 300, 300));
    window.dispatchEvent(ev('pointermove', 240, 300));
    window.dispatchEvent(ev('pointerup', 240, 300));
    expect(onOption).toHaveBeenLastCalledWith('size3d', 210);
    expect(cv().style.width).toBe('210px');
    expect(cv().style.height).toBe('252px');
    // The picture is the simulator now (2026-11-25), anchored at its top-left:
    // the panel moved up-left by the growth (60 x 72), so the opposite corner
    // stayed where it was and the grip followed the pointer; that place is saved.
    const panel = document.querySelector('.device-sim');
    expect(panel.style.left).toBe('-60px');
    expect(panel.style.top).toBe('-72px');
    expect(onMoved).toHaveBeenCalledTimes(1);
    grip.dispatchEvent(ev('pointerdown', 300, 300));
    window.dispatchEvent(ev('pointermove', 2000, 2000));
    window.dispatchEvent(ev('pointerup', 2000, 2000));
    expect(onOption).toHaveBeenLastCalledWith('size3d', 100);   // the smallest
  });
});

describe('the 2D looks', () => {
  for (const look of ['drawing', 'bars', 'gauges']) {
    it(`${look}: with only the stroke it is exactly today's bar`, () => {
      const legacy = new DeviceSimulator({ videoPlayer: { currentTime: 0 }, funscriptEngine: { isLoaded: true, getPositionAt: () => 30 } });
      legacy._update();
      const legacyHtml = legacy._panel.innerHTML;
      legacy._panel.remove();
      const { s, panel } = sim({ look: { look } });
      s.show();
      runFrames(2);
      expect(block().hidden).toBe(true);
      expect(panel.dataset.axesSide).toBeUndefined();
      const clone = panel.cloneNode(true);
      clone.querySelector('.device-sim__axes').remove();
      expect(clone.innerHTML).toBe(legacyHtml);
      expect(s._axesView.draws).toBe(0);
    });
  }

  it('drawing: a line drawing and a row per axis', () => {
    const { s, player } = sim({ look: { look: 'drawing' }, axes: { twist: twistPts, vib: vibPts } });
    s.show();
    player.currentTime = 0.25;
    runFrames();
    expect(block().hidden).toBe(false);
    expect(block().querySelector('canvas.device-sim__receiver')).not.toBeNull();
    expect([...block().querySelectorAll('.device-sim__axis-row')].map((r) => [r.dataset.axis, r.querySelector('.device-sim__axis-val').textContent]))
      .toEqual([['twist', '25'], ['vib', '30']]);
    // Twist fills from the middle (25 → from 25% to 50%); vibe from 0.
    const [tw, vb] = [...block().querySelectorAll('.device-sim__axis-fill')];
    expect([tw.style.left, tw.style.width]).toEqual(['25%', '25%']);
    expect([vb.style.left, vb.style.width]).toEqual(['0%', '30%']);
  });

  it('bars: a slim bar per axis with its T-Code channel', () => {
    const { s, player } = sim({ look: { look: 'bars' }, axes: { twist: twistPts, vib: vibPts } });
    s.show();
    player.currentTime = 1;
    runFrames();
    const cols = [...block().querySelectorAll('.device-sim__bar-col')];
    expect(cols.map((c) => c.querySelector('.device-sim__bar-label').firstChild.textContent)).toEqual(['R0', 'V0']);
    expect(cols.map((c) => c.querySelector('.device-sim__bar-label span').textContent)).toEqual(['100', '60']);
    expect(cols[0].querySelector('.device-sim__bar-marker').style.bottom).toBe('100%');
  });

  it('gauges: a gauge per receiver axis, rows for the others; Speed colours paints each by its own speed', () => {
    const { s, player } = sim({ look: { look: 'gauges' }, axes: { twist: twistPts, vib: vibPts }, raw: { color: 'speed' } });
    s.show();
    player.currentTime = 0.5;
    runFrames();
    expect([...block().querySelectorAll('.device-sim__gauge')].map((g) => g.dataset.gauge)).toEqual(['twist']);
    expect(block().querySelector('.device-sim__gauge-cap b').textContent).toBe('50');
    const vib = block().querySelector('.device-sim__axis-fill');
    expect(vib.style.background).toMatch(/^rgb\(/);   // 0.04 units/ms on the heatmap's scale
  });
});

// Dave, 2026-11-25: "why when i have the 3d device simulator selected does the
// original 2d one show beside it? surely both arent required, also the rotate
// option we have for the 2d one doesnt apply to the 3d one". In the 3D look
// the picture IS the simulator (the bar is hidden, data-look="3d"), and Turn
// 90°, the knob and an alignment turn the picture.
describe('the 3D look is the simulator, and it turns', () => {
  const menuOpen = (panel) => panel.querySelector('.device-sim__track').dispatchEvent(ev('contextmenu', 300, 200));
  const heads = () => [...document.querySelectorAll('.device-sim__menu-heading')].map((h) => h.textContent);

  it('a turn turns the 3D picture, not the hidden bar; back in a 2D look it turns the bar again', () => {
    const { s, panel } = sim({ raw: { rotation: 90 } });
    s.show();
    runFrames();
    expect(panel.dataset.look).toBe('3d');
    expect(block().querySelector('canvas.device-sim__3d').style.transform).toBe('rotate(90deg)');
    expect(s._body.style.transform).toBe('');
    s.setLook({ look: 'bars' });
    expect(panel.dataset.look).toBe('bars');
    expect(s._body.style.transform).toBe('rotate(90deg)');
    s.setLook({ look: '3d' });
    expect(block().querySelector('canvas.device-sim__3d').style.transform).toBe('rotate(90deg)');
    expect(s._body.style.transform).toBe('');
  });

  it('the picture has its own turn knob, which turns it and saves the angle', () => {
    const onRotated = vi.fn();
    const { s } = sim({ hooks: { onRotated } });
    s.show();
    runFrames();
    const knob = block().querySelector('.device-sim__3d-knob');
    expect(knob).toBeTruthy();
    knob.dispatchEvent(ev('pointerdown', 0, -100));
    window.dispatchEvent(ev('pointermove', 100, 0));
    window.dispatchEvent(ev('pointerup', 100, 0));
    expect(onRotated).toHaveBeenCalled();
    const deg = onRotated.mock.calls.at(-1)[0];
    expect(deg).not.toBe(0);
    expect(block().querySelector('canvas.device-sim__3d').style.transform).toBe(`rotate(${deg}deg)`);
  });

  // Dave, 2026-11-25: "why cant you rotate the base". Two buttons on the View
  // row turn it a quarter each way; the menu stays up for the next turn.
  it('the View row turns the base 90° each way and stays open', () => {
    const onOption = vi.fn();
    const { s, panel } = sim({ hooks: { onOption } });
    s.show();
    runFrames();
    menuOpen(panel);
    const turn = (step) => document.querySelector(`.device-sim__seg--turn[data-turn="${step}"]`);
    expect(turn(-90).getAttribute('aria-label')).toBe(S.turnBaseCcw);
    expect(turn(90).getAttribute('aria-label')).toBe(S.turnBaseCw);
    const yaw0 = s.look.view.yaw;
    turn(90).click();
    expect(onOption).toHaveBeenLastCalledWith('view3d', { yaw: yaw0 + 90, tilt: s.look.view.tilt });
    expect(s.look.view.yaw).toBe(yaw0 + 90);
    expect(document.querySelector('.device-sim__menu')).toBeTruthy();   // still open
    turn(-90).click();
    turn(-90).click();
    expect(s.look.view.yaw).toBe(yaw0 - 90);
    s._closeMenu();
  });

  // Found turning the base with the editor open (2026-11-25): the menu opened
  // on the simulator, so the turn could not be seen. Beside it now.
  it('the menu opens beside the simulator when it would cover it, else at the click', () => {
    const { s, panel } = sim();
    s.show();
    runFrames();
    const was = { w: window.innerWidth, h: window.innerHeight };
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
    panel.getBoundingClientRect = () => ({ left: 1100, top: 0, right: 1260, bottom: 250, width: 160, height: 250 });
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function rect() {
      if (this.classList?.contains('device-sim__menu')) return { left: 0, top: 0, right: 354, bottom: 272, width: 354, height: 272 };
      return orig.call(this);
    };
    try {
      s._openMenu(1180, 120);
      const left = parseFloat(document.querySelector('.device-sim__menu').style.left);
      expect(left + 354).toBeLessThanOrEqual(1100 - 8);           // to its left, clear of it
      s._closeMenu();
      s._openMenu(300, 400);                                      // nowhere near it: at the click
      expect(parseFloat(document.querySelector('.device-sim__menu').style.left)).toBe(300);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
      s._closeMenu();
      Object.defineProperty(window, 'innerWidth', { value: was.w, configurable: true, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: was.h, configurable: true, writable: true });
    }
  });

  it('Colour is offered only where it colours something (not a lone 3D picture)', () => {
    const { s, panel } = sim();
    s.show();
    runFrames();
    menuOpen(panel);
    expect(heads()).not.toContain(S.menuColor);
    s._closeMenu();
    s.setLook({ look: 'bars' });
    menuOpen(panel);
    expect(heads()).toContain(S.menuColor);
  });
});

describe('the right-click menu: Look, Size, View', () => {
  const menuOpen = (panel) => panel.querySelector('.device-sim__track').dispatchEvent(ev('contextmenu', 300, 200));
  const itemTexts = () => [...document.querySelectorAll('.device-sim__menu-item')].map((b) => b.textContent);
  const ticked = (sel) => [...document.querySelectorAll(sel)].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent);

  // The Look is ONE row of short buttons (Dave: "the look section could be a
  // button row instead of worded options"); Size is gone (drag the corner).
  it('Look is a row of four buttons (3D ticked); View under 3D; no Size; a choice is shown at once and saved', () => {
    const onOption = vi.fn();
    const { s, panel } = sim({ hooks: { onOption } });
    s.show();
    menuOpen(panel);
    const looks = () => [...document.querySelectorAll('.device-sim__seg')].filter((b) => ['3d', 'drawing', 'bars', 'gauges'].includes(b.dataset.value));
    expect(looks().map((b) => b.textContent)).toEqual([S.look3dShort, S.lookDrawingShort, S.lookBarsShort, S.lookGaugesShort]);
    expect(looks().map((b) => b.getAttribute('aria-label'))).toEqual([S.look3d, S.lookDrawing, S.lookBars, S.lookGauges]);
    expect(ticked('.device-sim__seg')).toEqual([S.dirDeviceShort, S.look3dShort, S.viewQuarter]);
    expect(document.querySelector('.device-sim__menu').textContent).not.toMatch(/Small|Large|Size/);
    [...document.querySelectorAll('.device-sim__seg')].find((b) => b.textContent === S.viewSide).click();
    expect(onOption).toHaveBeenLastCalledWith('view3d', 'side');
    expect(s.look.view).toMatchObject({ ...SIM3D_VIEWS.side, preset: 'side' });
    menuOpen(panel);
    looks().find((b) => b.dataset.value === 'bars').click();
    expect(onOption).toHaveBeenLastCalledWith('look', 'bars');
    expect(block().dataset.look).toBe('bars');
    menuOpen(panel);
    expect([...document.querySelectorAll('.device-sim__seg')].some((b) => b.textContent === S.viewSide)).toBe(false);   // View is the 3D look's
  });

  it('setLook (a settings change) switches the look; an old "large" reads as 230 px', () => {
    const { s } = sim();
    s.setLook({ look: 'gauges', size: 'large', view: 'above' });
    expect(block().dataset.look).toBe('gauges');
    expect(s.look).toMatchObject({ look: 'gauges', size: 230, view: { preset: 'above' } });
  });
});

// Fit-on-screen pass (2026-11-24): the docked editor grown by its stacked
// lanes left 160 px above it at 900x600 for a 246 px simulator, its read-out
// behind the editor. Too tall for the room above the floor, it is drawn
// smaller (down to 40 %), and back to full size when the room comes back;
// never placed (CSS-centred) and past the floor, it is put at the floor.
describe('the simulator fits the room above the docked editor', () => {
  function withEditorTop(top) {
    document.getElementById('player-container')?.remove();
    const pc = document.createElement('div');
    pc.id = 'player-container';
    if (top != null) pc.classList.add('player-container--editor-open');
    const ed = document.createElement('div');
    ed.className = 'script-editor script-editor--open';
    ed.getBoundingClientRect = () => ({ top, bottom: 768, left: 0, right: 1024, width: 1024, height: 768 - top });
    pc.appendChild(ed);
    document.body.appendChild(pc);
  }
  function measured(panel, { left = 800, top = 0 } = {}) {
    // A 42 x 246 panel, drawn at its CSS scale (from its top-left).
    panel.getBoundingClientRect = () => {
      const k = parseFloat(panel.style.scale) || 1;
      const t = parseFloat(panel.style.top) || top;
      return { left, top: t, width: 42 * k, height: 246 * k, right: left + 42 * k, bottom: t + 246 * k, x: left, y: t };
    };
  }
  it('160 px of room: drawn at 156/246; the editor closing gives it full size back', () => {
    withEditorTop(160);
    const { s, panel } = sim({ raw: { position: { x: 0.8, y: 0.1 } } });
    measured(panel);
    s._place();
    expect(Number(panel.style.scale)).toBeCloseTo(156 / 246, 2);
    expect(panel.style.transformOrigin).toBe('top left');
    const r = panel.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(160);
    withEditorTop(null);
    s._place();
    expect(panel.style.scale).toBe('');
  });
  it('never smaller than 40 %', () => {
    withEditorTop(60);
    const { s, panel } = sim({ raw: { position: { x: 0.8, y: 0.1 } } });
    measured(panel);
    s._place();
    expect(Number(panel.style.scale)).toBe(0.4);
  });
  it('not placed (centred by CSS) and past the floor: put at the floor, nothing saved', () => {
    withEditorTop(400);
    const saved = vi.fn();
    const { s, panel } = sim({ hooks: { onOptionsChange: saved } });
    measured(panel, { top: 261 });          // centred on a 768 px window: 261..507
    s._place();
    expect(panel.classList.contains('device-sim--placed')).toBe(true);
    expect(panel.style.top).toBe(`${400 - 246}px`);
    expect(s._opts.position).toBeNull();
    expect(saved).not.toHaveBeenCalled();
  });
});

describe('app.js wiring and the saved settings', () => {
  it('the new settings default to the 3D receiver, 150 px wide, three-quarter, not aligned', () => {
    const p = DEFAULTS.settings.player;
    expect([p.deviceSimLook, p.deviceSim3dSize, p.deviceSim3dView, p.deviceSimAlign]).toEqual(['3d', 150, 'quarter', null]);
  });

  function app(store = new Map()) {
    const Lifted = liftAppClass(['_deviceSimOptions', '_wireDeviceSimOptions', '_onDeviceSimOption', '_deviceSimLook', '_deviceSimAxisActions'],
      { eventBus, resolveSimOptions, getAxisBySuffix });
    return Object.assign(new Lifted(), {
      settings: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); eventBus.emit('settings:changed', { path: k }); } },
      deviceSimulator: { applyOptions: vi.fn(), setLook: vi.fn(), setAlignment: vi.fn() },
    });
  }

  it('menu choices are saved; a saved change goes back to the simulator; Reset clears the alignment too', () => {
    const store = new Map();
    const a = app(store);
    a._wireDeviceSimOptions();
    a._onDeviceSimOption('look', 'bars');
    a._onDeviceSimOption('size3d', 'large');
    a._onDeviceSimOption('view3d', { yaw: 10, tilt: 30 });
    expect(store.get('player.deviceSimLook')).toBe('bars');
    expect(a.deviceSimulator.setLook).toHaveBeenLastCalledWith({ look: 'bars', size: 'large', view: { yaw: 10, tilt: 30 } });
    const line = { tip: { x: 0.5, y: 0.2 }, base: { x: 0.5, y: 0.7 } };
    a._onDeviceSimOption('align', line);
    expect(store.get('player.deviceSimAlign')).toEqual(line);
    expect(a.deviceSimulator.setAlignment).toHaveBeenLastCalledWith(line);
    a._onDeviceSimOption('reset');
    expect(store.get('player.deviceSimAlign')).toBeNull();
    expect(a.deviceSimulator.setAlignment).toHaveBeenLastCalledWith(null);
    expect(a.deviceSimulator.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ rotation: 0 }));
  });

  it('the points: the editor\'s live ones first, else what the T-Code / Buttplug engines play', () => {
    const a = app();
    const live = [{ at: 0, pos: 1 }];
    const played = [{ at: 0, pos: 2 }, { at: 9, pos: 3 }];
    const bp = [{ at: 0, pos: 4 }, { at: 9, pos: 5 }];
    a.scriptEditor = { getLiveAxisActions: (s) => (s === 'twist' ? live : null) };
    a.tcodeSync = { _axisActions: new Map([['R0', { actions: played }], ['R1', { actions: played }]]) };
    a.buttplugSync = { _axisActions: new Map([['V0', { actions: bp }]]) };
    expect(a._deviceSimAxisActions('twist')).toBe(live);    // the array itself, no copy
    expect(a._deviceSimAxisActions('roll')).toBe(played);
    expect(a._deviceSimAxisActions('vib')).toBe(bp);
    expect(a._deviceSimAxisActions('pitch')).toBeNull();
    expect(a._deviceSimAxisActions('nonsense')).toBeNull();
    a.scriptEditor = null;                                   // the editor not holding it: what plays
    expect(a._deviceSimAxisActions('twist')).toBe(played);
    a.scriptEditor = { getLiveAxisActions: () => null };
    a.tcodeSync = null;
    expect(a._deviceSimAxisActions('roll')).toBeNull();
  });
});

// Dave, 2026-11-25: "is there any way to speed up the player when in editor
// especially when its multi axis". Profiled live on his 144 Hz display (Long
// Test, six axes, stacked tracks + the 3D simulator): the 3D picture drew a
// new pose on every one of 144 frames a second, and the frame loop read where
// the docked editor starts (a query and a layout read) on every frame.
describe('the simulator on a fast display', () => {
  it('a moving pose is drawn every 2nd frame at 144 Hz (72 a second, not 144), the last one always; a turn draws at once', () => {
    const { s, setPos } = sim();
    s.show();
    runFrames();
    expect(s._axesView.draws).toBe(1);
    frameMs = 1000 / 144;                 // 144 Hz: frames 6.9 ms apart
    try {
      for (let i = 0; i < 72; i++) { setPos(30 + (i % 40)); runFrames(); }   // half a second moving
      const moving = s._axesView.draws - 1;
      expect(moving).toBeLessThanOrEqual(40);                     // ~36, not 72
      expect(moving).toBeGreaterThanOrEqual(32);
      // It stops: the last pose is on screen within a frame or two.
      setPos(95);
      runFrames(3);
      const drawn = s._axesView.draws;
      expect(s._axesView._last3d[0]).toBe(95);
      // A turn of the view is not held back.
      s._axesView._view = { yaw: s._axesView._view.yaw + 30, tilt: s._axesView._view.tilt };
      s._axesView.invalidate();
      runFrames();
      expect(s._axesView.draws).toBe(drawn + 1);
    } finally {
      frameMs = 1000 / 60;
    }
  });

  it('where the docked editor starts is read a few times a second, and at once after editorMoved()', () => {
    const { s } = sim();
    // Placed once (jsdom boxes are empty, which would re-place every frame).
    s._panel.getBoundingClientRect = () => ({ left: 100, top: 100, right: 220, bottom: 400, width: 120, height: 300 });
    const reads = vi.spyOn(s, '_editorTop');
    s.show();
    runFrames(5);                          // shown and placed (placing reads it too)
    reads.mockClear();
    runFrames(60);                         // one second at 60 Hz: 64 reads before
    expect(reads.mock.calls.length).toBeLessThanOrEqual(5);
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3);
    const before = reads.mock.calls.length;
    s.editorMoved();                       // app.js: the editor opened or closed
    runFrames();
    expect(reads.mock.calls.length).toBe(before + 1);
  });
});
