/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL DeviceSimulator builds its panel and its
 * right-click menu, and the test drags, resizes and right-clicks it; the REAL
 * settings panel builds the Playback rows (notes/CLAUDE.md "Test environments").
 */
// The device simulator, handled on the widget itself (v0.10.1; powerkool on
// EroScripts: "a setting to invert and modify the device simulator (i.e.,
// change the color, position, etc.)"; Dave: size and position "draggable like
// ofs", colour on a right click, not "settings clutter"). Asserted: what it
// draws for each option, that a drag moves it and a corner drag resizes it
// (both saved), what the right-click menu offers and does, that app.js
// re-applies on a settings change (the Handy's Invert included), and that
// Settings keeps only opacity and a hint.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

const { DeviceSimulator, resolveSimOptions, SIM_SIZE_LIMITS, normalizeRotation, rotationFromPointer, rotatedBox, SIM_PRESET_COLORS, SIM_CUSTOM_COLOR_DEFAULT } = await import('../../renderer/components/device-simulator.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');
const { heatmapSpeedToColor } = await import('../../renderer/js/heatmap-palette.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  _setBundlesForTests('en', EN, EN);
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

function sim(raw = {}, hooks = {}) {
  const player = { currentTime: 0 };
  let pos = 30;
  const engine = { isLoaded: true, getPositionAt: () => pos };
  const s = new DeviceSimulator({ videoPlayer: player, funscriptEngine: engine, options: resolveSimOptions(raw), ...hooks });
  return { s, panel: document.querySelector('.device-sim'), player, setPos: (p) => { pos = p; } };
}
const ev = (type, x, y, extra = {}) => new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...extra });

describe('resolveSimOptions', () => {
  it('defaults; "Same as the Handy\'s Invert" follows the Invert; a size is clamped; junk falls back', () => {
    expect(resolveSimOptions({})).toEqual({ direction: 'device', flipped: false, color: 'accent', customColor: SIM_CUSTOM_COLOR_DEFAULT, size: null, position: null, rotation: 0 });
    expect(resolveSimOptions({}, { deviceInverted: true }).flipped).toBe(true);
    expect(resolveSimOptions({ direction: 'normal' }, { deviceInverted: true }).flipped).toBe(false);
    expect(resolveSimOptions({ direction: 'flipped' }).flipped).toBe(true);
    expect(resolveSimOptions({ size: { w: 5, h: 9999 } }).size).toEqual({ w: SIM_SIZE_LIMITS.minW, h: SIM_SIZE_LIMITS.maxH });
    expect(resolveSimOptions({ color: 'neon', size: 'large', position: { x: 'a' } })).toMatchObject({ color: 'accent', size: null, position: null });
  });
});

describe('what it draws', () => {
  it('normal: position 30 sits 30% up; flipped: 70% up with the fill hanging from the top; the read-out keeps 30', () => {
    const { s, panel } = sim();
    s._update();
    expect(panel.querySelector('.device-sim__marker').style.bottom).toBe('30%');
    s.applyOptions(resolveSimOptions({ direction: 'flipped' }));
    s._update();
    expect(panel.querySelector('.device-sim__marker').style.bottom).toBe('70%');
    expect(panel.querySelector('.device-sim__fill').style.height).toBe('30%');
    expect(panel.querySelector('.device-sim__pos').textContent).toBe('30');
    expect(panel.dataset.direction).toBe('flipped');
  });

  it('built flipped (as app.js builds it at start-up), it draws flipped from the first frame', () => {
    const { s, panel } = sim({ direction: 'flipped', position: { x: 0.1, y: 0.2 } });
    expect(panel.dataset.direction).toBe('flipped');
    s._update();
    expect(panel.querySelector('.device-sim__marker').style.bottom).toBe('70%');
  });

  it('speed colours paint the fill with the heatmap colour of the speed; white clears it', () => {
    const { s, panel, player, setPos } = sim({ color: 'speed' });
    expect(panel.dataset.color).toBe('speed');
    s._update();
    player.currentTime = 0.5;
    setPos(80);                 // 50 units in 500 ms = 0.1 units/ms
    s._update();
    const probe = document.createElement('div');
    probe.style.background = heatmapSpeedToColor(0.1);
    expect(panel.querySelector('.device-sim__fill').style.background).toBe(probe.style.background);
    s.applyOptions(resolveSimOptions({ color: 'white' }));
    expect(panel.querySelector('.device-sim__fill').style.background).toBe('');
  });

  it('a saved size and place are applied; none puts back the default', () => {
    const { s, panel } = sim({ size: { w: 60, h: 300 }, position: { x: 0.25, y: 0.5 } });
    const track = panel.querySelector('.device-sim__track');
    expect(track.style.width).toBe('60px');
    expect(track.style.height).toBe('300px');
    expect(panel.style.left).toBe('250px');
    expect(panel.style.top).toBe('400px');
    s.applyOptions(resolveSimOptions({}));
    expect(track.style.width).toBe('');
    expect(panel.classList.contains('device-sim--placed')).toBe(false);
  });

  it('a place near the edge is drawn inside a smaller window, and above the script player\'s bar; the saved place is kept (found in the app)', () => {
    const { s, panel } = sim({ position: { x: 0.98, y: 0.9 } });
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 260, right: 50, bottom: 260 });
    s._place();
    expect(panel.style.left).toBe('950px');                  // 1000 - 50, not 980
    expect(panel.style.top).toBe('540px');                   // 800 - 260, not 720
    // The script player's bar takes the bottom 66 px: #app ends at 734.
    document.getElementById('app').getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 734, right: 1000, bottom: 734 });
    s._place();
    expect(panel.style.top).toBe('474px');
    // A bigger window: back where it was put, since the saved place was kept.
    document.getElementById('app').getBoundingClientRect = () => ({ left: 0, top: 0, width: 4000, height: 3200, right: 4000, bottom: 3200 });
    window.innerWidth = 4000;
    window.innerHeight = 3200;
    window.dispatchEvent(new Event('resize'));
    expect(s._placeDue).toBe(true);
    s._place();
    expect(panel.style.left).toBe('3920px');
    expect(panel.style.top).toBe('2880px');
    expect(s._opts.position).toEqual({ x: 0.98, y: 0.9 });
  });

  it('hidden it cannot be measured, so the place stays due until a frame on the player measures it', () => {
    const { s, panel } = sim({ position: { x: 0.98, y: 0.9 } });
    expect(s._placeDue).toBe(true);                          // jsdom: no size
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 260, right: 50, bottom: 260 });
    s._place();
    expect(s._placeDue).toBe(false);
    expect(panel.style.left).toBe('950px');
  });
});

describe('handled on the widget', () => {
  it('drag the bar: it moves and the place is saved as fractions of the window', () => {
    const onMoved = vi.fn();
    const { panel } = sim({}, { onMoved });
    panel.getBoundingClientRect = () => ({ left: 900, top: 300, width: 50, height: 240, right: 950, bottom: 540 });
    const track = panel.querySelector('.device-sim__track');
    track.dispatchEvent(ev('pointerdown', 910, 310));
    track.dispatchEvent(ev('pointermove', 210, 110));
    track.dispatchEvent(ev('pointerup', 210, 110));
    expect(panel.style.left).toBe('200px');
    expect(onMoved).toHaveBeenCalledWith({ x: 0.2, y: 0.125 });
  });

  it('drag the corner grip: it resizes (within the limits) and the size is saved; a placed bar does not move', () => {
    const onResized = vi.fn();
    const onMoved = vi.fn();
    const { panel } = sim({ position: { x: 0.9, y: 0.375 } }, { onResized, onMoved });
    const track = panel.querySelector('.device-sim__track');
    const grip = panel.querySelector('.device-sim__grip');
    track.getBoundingClientRect = () => ({ left: 900, top: 300, width: 42, height: 200, right: 942, bottom: 500 });
    grip.dispatchEvent(ev('pointerdown', 940, 498));
    grip.dispatchEvent(ev('pointermove', 958, 598));
    grip.dispatchEvent(ev('pointerup', 958, 598));
    expect(track.style.width).toBe('60px');
    expect(track.style.height).toBe('300px');
    expect(onResized).toHaveBeenCalledWith({ w: 60, h: 300 });
    expect(onMoved).not.toHaveBeenCalled();
    // Away from the window's edge, so the size limits are what stop it.
    track.getBoundingClientRect = () => ({ left: 100, top: 300, width: 42, height: 200, right: 142, bottom: 500 });
    grip.dispatchEvent(ev('pointerdown', 140, 498));
    grip.dispatchEvent(ev('pointermove', 2000, 0));
    grip.dispatchEvent(ev('pointerup', 2000, 0));
    expect(onResized).toHaveBeenLastCalledWith({ w: SIM_SIZE_LIMITS.maxW, h: SIM_SIZE_LIMITS.minH });
  });

  it('a resize keeps going when the pointer leaves the bar for the video, and the release there ends it (found in the app)', () => {
    const onResized = vi.fn();
    const { panel } = sim({ position: { x: 0.1, y: 0.1 } }, { onResized });
    const track = panel.querySelector('.device-sim__track');
    const grip = panel.querySelector('.device-sim__grip');
    const video = document.createElement('video');
    document.getElementById('app').appendChild(video);
    track.getBoundingClientRect = () => ({ left: 100, top: 80, width: 42, height: 200, right: 142, bottom: 280 });
    grip.dispatchEvent(ev('pointerdown', 140, 278));
    video.dispatchEvent(ev('pointermove', 170, 378));        // the pointer is over the video now
    video.dispatchEvent(ev('pointerup', 170, 378));
    expect(track.style.width).toBe('72px');
    expect(track.style.height).toBe('300px');
    expect(onResized).toHaveBeenCalledWith({ w: 72, h: 300 });
    expect(panel.classList.contains('device-sim--resizing')).toBe(false);
  });

  it('a resize from the default spot pins the top-left first (so the corner follows the pointer) and saves the place too (found in the app)', () => {
    const onResized = vi.fn();
    const onMoved = vi.fn();
    const { panel } = sim({}, { onResized, onMoved });
    expect(panel.classList.contains('device-sim--placed')).toBe(false);
    const track = panel.querySelector('.device-sim__track');
    const grip = panel.querySelector('.device-sim__grip');
    panel.getBoundingClientRect = () => ({ left: 900, top: 300, width: 42, height: 246, right: 942, bottom: 546 });
    track.getBoundingClientRect = () => ({ left: 900, top: 300, width: 42, height: 200, right: 942, bottom: 500 });
    grip.dispatchEvent(ev('pointerdown', 940, 498));
    expect(panel.classList.contains('device-sim--placed')).toBe(true);
    expect(panel.style.left).toBe('900px');
    expect(panel.style.top).toBe('300px');
    grip.dispatchEvent(ev('pointermove', 950, 548));
    grip.dispatchEvent(ev('pointerup', 950, 548));
    expect(onResized).toHaveBeenCalledWith({ w: 52, h: 250 });
    expect(onMoved).toHaveBeenCalledWith({ x: 0.9, y: 0.375 });
  });

  it('a resize stops at the window\'s right edge and above the script player\'s bar', () => {
    const onResized = vi.fn();
    const { panel } = sim({ position: { x: 0.9, y: 0.5 } }, { onResized });
    const track = panel.querySelector('.device-sim__track');
    const grip = panel.querySelector('.device-sim__grip');
    document.getElementById('app').getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 734, right: 1000, bottom: 734 });
    panel.getBoundingClientRect = () => ({ left: 900, top: 400, width: 42, height: 246, right: 942, bottom: 646 });
    track.getBoundingClientRect = () => ({ left: 900, top: 400, width: 42, height: 200, right: 942, bottom: 600 });
    grip.dispatchEvent(ev('pointerdown', 940, 598));
    grip.dispatchEvent(ev('pointermove', 1100, 900));
    grip.dispatchEvent(ev('pointerup', 1100, 900));
    // right: 1000 - 900 - 4 = 96; bottom: 734 - 400 - 46 (the read-out) - 4 = 284
    expect(onResized).toHaveBeenCalledWith({ w: 96, h: 284 });
  });

  it('right-click: Direction and Colour with the current ones ticked, and Reset size and position; a choice goes to onOption and closes it', () => {
    const onOption = vi.fn();
    const { panel } = sim({ direction: 'normal', color: 'speed' }, { onOption });
    const track = panel.querySelector('.device-sim__track');
    const ctx = ev('contextmenu', 500, 400);
    track.dispatchEvent(ctx);
    expect(ctx.defaultPrevented).toBe(true);
    const menu = document.querySelector('.device-sim__menu');
    expect(menu.getAttribute('role')).toBe('menu');
    // The compact menu (Dave, 2026-11-24): Direction is ONE row of short
    // buttons (the full wording as their name), Colour ONE row of swatches
    // (Accent, Speed colours and White among them), then the plain items.
    const dirs = [...menu.querySelectorAll('.device-sim__seg-row')][0].querySelectorAll('.device-sim__seg');
    expect([...dirs].map((b) => b.textContent)).toEqual([EN.deviceSim.dirDeviceShort, EN.deviceSim.dirNormalShort, EN.deviceSim.dirFlippedShort]);
    expect([...dirs].map((b) => b.getAttribute('aria-label'))).toEqual([EN.deviceSim.dirDevice, EN.deviceSim.dirNormal, EN.deviceSim.dirFlipped]);
    const items = [...menu.querySelectorAll('.device-sim__menu-item')];
    expect(items.map((b) => b.textContent)).toEqual([EN.deviceSim.turn, EN.deviceSim.reset]);
    const ticked = [...menu.querySelectorAll('[aria-checked="true"]')];
    expect(ticked.map((b) => b.dataset.value || b.dataset.color)).toEqual(['normal', 'speed']);
    expect(document.activeElement).toBe(dirs[1]);             // the current direction has the focus
    dirs[2].click();
    expect(onOption).toHaveBeenCalledWith('direction', 'flipped');
    expect(document.querySelector('.device-sim__menu')).toBeNull();

    track.dispatchEvent(ev('contextmenu', 500, 400));
    document.querySelector('.device-sim__swatch[data-color="white"]').click();
    expect(onOption).toHaveBeenCalledWith('color', 'white');
    track.dispatchEvent(ev('contextmenu', 500, 400));
    [...document.querySelectorAll('.device-sim__menu-item')].find((b) => b.textContent === EN.deviceSim.reset).click();
    expect(onOption).toHaveBeenLastCalledWith('reset');
  });

  it('the menu closes on Escape, on a click elsewhere, and when the simulator hides', () => {
    const { s, panel } = sim();
    s.show();
    const track = panel.querySelector('.device-sim__track');
    track.dispatchEvent(ev('contextmenu', 10, 10));
    document.querySelector('.device-sim__menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.device-sim__menu')).toBeNull();
    track.dispatchEvent(ev('contextmenu', 10, 10));
    document.body.dispatchEvent(ev('pointerdown', 900, 700));
    expect(document.querySelector('.device-sim__menu')).toBeNull();
    track.dispatchEvent(ev('contextmenu', 10, 10));
    s.hide();
    expect(document.querySelector('.device-sim__menu')).toBeNull();
  });
});

// Turning it to any angle, like OFS's simulator (Dave 2026-11-22: "rotatable similarly to ofs").
describe('turning it', () => {
  it('the angle is kept as [0, 360); junk is upright', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(359.96)).toBe(0);
    expect(normalizeRotation('x')).toBe(0);
    expect(resolveSimOptions({ rotation: -45 }).rotation).toBe(315);
  });

  it('the knob points from the centre to the pointer: up 0, right 90, left 270; near a quarter turn it lands on it; Shift moves in 15s', () => {
    expect(rotationFromPointer(100, 100, 100, 0)).toBe(0);
    expect(rotationFromPointer(100, 100, 200, 100)).toBe(90);
    expect(rotationFromPointer(100, 100, 0, 100)).toBe(270);
    expect(rotationFromPointer(100, 100, 100, 200)).toBe(180);
    expect(rotationFromPointer(100, 100, 200, 105)).toBe(90);          // 92.9° → 90
    const free = rotationFromPointer(100, 100, 200, 30);               // 55°: no snap
    expect(free).toBeGreaterThan(54);
    expect(free).toBeLessThan(56);
    expect(rotationFromPointer(100, 100, 200, 30, { shift: true })).toBe(60);
  });

  it('turned, the bar takes its turned box, and the read-out keeps its place under it, upright', () => {
    const box = rotatedBox(42, 200, 90);
    expect(box.w).toBeCloseTo(200, 6);
    expect(box.h).toBeCloseTo(42, 6);
    const { s, panel } = sim({ rotation: 90 });
    const body = panel.querySelector('.device-sim__body');
    expect(body.style.transform).toBe('rotate(90deg)');
    expect(body.style.margin).toBe('-79px 79px');                     // (42 - 200) / 2, (200 - 42) / 2
    expect(panel.querySelector('.device-sim__info').closest('.device-sim__body')).toBeNull();
    s.applyOptions(resolveSimOptions({}));
    expect(body.style.transform).toBe('');
    expect(body.style.margin).toBe('');
  });

  it('drag the knob: it turns around its centre as the pointer goes, and the angle is saved on release', () => {
    const onRotated = vi.fn();
    const { panel } = sim({}, { onRotated });
    const body = panel.querySelector('.device-sim__body');
    const knob = panel.querySelector('.device-sim__knob');
    body.getBoundingClientRect = () => ({ left: 80, top: 0, width: 40, height: 200, right: 120, bottom: 200 });  // centre (100, 100)
    knob.dispatchEvent(ev('pointerdown', 100, -20));
    knob.dispatchEvent(ev('pointermove', 300, 100));                  // straight right of the centre
    expect(body.style.transform).toBe('rotate(90deg)');
    expect(panel.classList.contains('device-sim--rotating')).toBe(true);
    document.body.dispatchEvent(ev('pointerup', 300, 100));           // released anywhere
    expect(onRotated).toHaveBeenCalledWith(90);
    expect(panel.classList.contains('device-sim--rotating')).toBe(false);
  });

  it('turned a quarter, dragging the corner down widens the bar (the drag follows the bar\'s own axes)', () => {
    const onResized = vi.fn();
    const { panel } = sim({ rotation: 90, position: { x: 0.2, y: 0.2 } }, { onResized });
    const grip = panel.querySelector('.device-sim__grip');
    grip.dispatchEvent(ev('pointerdown', 500, 400));
    grip.dispatchEvent(ev('pointermove', 500, 430));
    grip.dispatchEvent(ev('pointerup', 500, 430));
    expect(onResized).toHaveBeenCalledWith({ w: 72, h: 200 });        // 42 + 30, the length unchanged
  });

  it('the bar turns around its own centre: the panel moves so the centre stays put, and the new place is saved with the angle (found by Dave: "the pivot point is wrong")', () => {
    const onMoved = vi.fn();
    const onRotated = vi.fn();
    const { s, panel } = sim({ position: { x: 0.9, y: 0.375 } }, { onMoved, onRotated });  // left 900, top 300
    const body = panel.querySelector('.device-sim__body');
    // jsdom has no layout: the panel is as wide as the turned bar (the read-out is narrower), the bar
    // sits at its top, centred; the panel's left/top are what the code sets.
    const layout = () => {
      const box = rotatedBox(42, 200, s._opts.rotation || 0);
      const left = parseFloat(panel.style.left);
      const top = parseFloat(panel.style.top);
      return { box, left, top };
    };
    panel.getBoundingClientRect = () => { const { box, left, top } = layout(); return { left, top, width: box.w, height: box.h + 46, right: left + box.w, bottom: top + box.h + 46 }; };
    body.getBoundingClientRect = () => { const { box, left, top } = layout(); return { left, top, width: box.w, height: box.h, right: left + box.w, bottom: top + box.h }; };
    const centre = () => { const r = body.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const [cx, cy] = centre();                                         // (921, 400)
    const knob = panel.querySelector('.device-sim__knob');
    knob.dispatchEvent(ev('pointerdown', cx, cy - 120));
    knob.dispatchEvent(ev('pointermove', cx + 200, cy));               // sideways
    const [nx, ny] = centre();
    expect(nx).toBeCloseTo(cx, 6);
    expect(ny).toBeCloseTo(cy, 6);
    document.body.dispatchEvent(ev('pointerup', cx + 200, cy));
    expect(onRotated).toHaveBeenCalledWith(90);
    expect(onMoved).toHaveBeenCalledWith({ x: 0.821, y: 0.47375 });   // 821 / 1000, 379 / 800
    // The menu's Turn 90° turns about the same centre too.
    panel.querySelector('.device-sim__track').dispatchEvent(ev('contextmenu', 500, 400));
    [...document.querySelectorAll('.device-sim__menu-item')].find((b) => b.textContent === EN.deviceSim.turn).click();
    expect(onRotated).toHaveBeenLastCalledWith(180);
    const [tx, ty] = centre();
    expect(tx).toBeCloseTo(cx, 6);
    expect(ty).toBeCloseTo(cy, 6);
  });

  it('Reset makes it upright again (app.js)', () => {
    const Lifted = liftAppClass(['_deviceSimOptions', '_wireDeviceSimOptions', '_onDeviceSimOption'], { eventBus, resolveSimOptions });
    const store = new Map([['player.deviceSimRotation', 270]]);
    const app = Object.assign(new Lifted(), {
      settings: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); eventBus.emit('settings:changed', { path: k }); } },
      deviceSimulator: { applyOptions: vi.fn() },
    });
    app._wireDeviceSimOptions();
    app._onDeviceSimOption('reset');
    expect(store.get('player.deviceSimRotation')).toBe(0);
    expect(app.deviceSimulator.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ rotation: 0 }));
  });
});

// More colours (Dave 2026-11-22: "can we add more colour options for the device simulator").
describe('more colours', () => {
  it('the swatches and Custom are valid choices; a custom colour must be a hex colour', () => {
    expect(resolveSimOptions({ color: 'green' }).color).toBe('green');
    expect(resolveSimOptions({ color: 'custom', customColor: '#12AB34' })).toMatchObject({ color: 'custom', customColor: '#12ab34' });
    expect(resolveSimOptions({ color: 'custom', customColor: 'red' }).customColor).toBe(SIM_CUSTOM_COLOR_DEFAULT);
    expect(resolveSimOptions({ color: 'teal' }).color).toBe('accent');
  });

  it('a swatch or the custom colour draws the bar in that colour; Accent, Speed and White as before', () => {
    const { s, panel } = sim({ color: 'green' });
    expect(panel.dataset.color).toBe('solid');
    expect(panel.style.getPropertyValue('--sim-color')).toBe(SIM_PRESET_COLORS.green);
    s.applyOptions(resolveSimOptions({ color: 'custom', customColor: '#123456' }));
    expect(panel.style.getPropertyValue('--sim-color')).toBe('#123456');
    s.applyOptions(resolveSimOptions({ color: 'white' }));
    expect(panel.dataset.color).toBe('white');
    expect(panel.style.getPropertyValue('--sim-color')).toBe('');
  });

  it('the colour row: Accent, Speed colours, White, the eight colours and the picker, by name; the current one ticked; a pick saves and closes', () => {
    const onOption = vi.fn();
    const { panel } = sim({ color: 'blue' }, { onOption });
    panel.querySelector('.device-sim__track').dispatchEvent(ev('contextmenu', 500, 400));
    const swatches = [...document.querySelectorAll('.device-sim__swatch')];
    expect(swatches.map((b) => b.getAttribute('aria-label'))).toEqual([
      EN.deviceSim.colorAccent, EN.deviceSim.colorSpeed, EN.deviceSim.colorWhite,
      EN.deviceSim.colorRed, EN.deviceSim.colorOrange, EN.deviceSim.colorYellow, EN.deviceSim.colorGreen,
      EN.deviceSim.colorCyan, EN.deviceSim.colorBlue, EN.deviceSim.colorPurple, EN.deviceSim.colorPink,
      EN.deviceSim.colorCustom,
    ]);
    expect(swatches.filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.color)).toEqual(['blue']);
    expect(swatches.every((b) => b.getAttribute('role') === 'menuitemradio')).toBe(true);
    swatches.find((b) => b.dataset.color === 'green').click();
    expect(onOption).toHaveBeenCalledWith('color', 'green');
    expect(document.querySelector('.device-sim__menu')).toBeNull();
  });

  it('Custom colour… opens the colour picker at the saved colour; the bar follows while picking, a pick is saved, a cancel puts it back', () => {
    const onOption = vi.fn();
    const opened = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const { panel } = sim({ color: 'red', customColor: '#00ff88' }, { onOption });
    panel.querySelector('.device-sim__track').dispatchEvent(ev('contextmenu', 500, 400));
    const custom = document.querySelector('.device-sim__swatch[data-color="custom"]');
    expect(custom.style.getPropertyValue('--custom')).toBe('#00ff88');   // shows the saved custom colour
    custom.click();
    const input = document.querySelector('input.device-sim__color-input');
    expect(opened).toHaveBeenCalled();
    expect(input.value).toBe('#00ff88');
    input.value = '#123456';
    input.dispatchEvent(new Event('input'));
    expect(panel.style.getPropertyValue('--sim-color')).toBe('#123456');   // previewed, not saved
    expect(onOption).not.toHaveBeenCalled();
    input.dispatchEvent(new Event('cancel'));
    expect(panel.style.getPropertyValue('--sim-color')).toBe(SIM_PRESET_COLORS.red);
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    expect(onOption).toHaveBeenCalledWith('customColor', '#123456');
    opened.mockRestore();
  });

  it('app.js: a picked custom colour is saved and chosen; anything but a hex colour is ignored', () => {
    const Lifted = liftAppClass(['_deviceSimOptions', '_wireDeviceSimOptions', '_onDeviceSimOption'], { eventBus, resolveSimOptions });
    const store = new Map();
    const app = Object.assign(new Lifted(), {
      settings: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); eventBus.emit('settings:changed', { path: k }); } },
      deviceSimulator: { applyOptions: vi.fn() },
    });
    app._wireDeviceSimOptions();
    app._onDeviceSimOption('customColor', '#ABCDEF');
    expect(store.get('player.deviceSimCustomColor')).toBe('#abcdef');
    expect(store.get('player.deviceSimColor')).toBe('custom');
    expect(app.deviceSimulator.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'custom', customColor: '#abcdef' }));
    app._onDeviceSimOption('customColor', 'javascript:alert(1)');
    expect(store.get('player.deviceSimCustomColor')).toBe('#abcdef');
  });
});

describe('app.js', () => {
  it('a menu choice saves the setting; Reset clears size and place; any change (or the Handy\'s Invert) re-applies', () => {
    const Lifted = liftAppClass(['_deviceSimOptions', '_wireDeviceSimOptions', '_onDeviceSimOption'], { eventBus, resolveSimOptions });
    const store = new Map([['player.deviceSimSize', { w: 60, h: 300 }], ['player.deviceSimPosition', { x: 0.1, y: 0.1 }]]);
    const app = Object.assign(new Lifted(), {
      settings: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); eventBus.emit('settings:changed', { path: k }); } },
      deviceSimulator: { applyOptions: vi.fn() },
    });
    app._wireDeviceSimOptions();
    app._onDeviceSimOption('direction', 'flipped');
    expect(store.get('player.deviceSimDirection')).toBe('flipped');
    expect(app.deviceSimulator.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ flipped: true }));
    app._onDeviceSimOption('color', 'white');
    expect(app.deviceSimulator.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'white' }));
    app._onDeviceSimOption('reset');
    expect(store.get('player.deviceSimSize')).toBeNull();
    expect(store.get('player.deviceSimPosition')).toBeNull();
    app.settings.set('player.deviceSimDirection', 'device');
    app.settings.set('handy.inverted', true);
    expect(app.deviceSimulator.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ flipped: true, size: null, position: null }));
  });
});

describe('Settings > Playback', () => {
  it('keeps opacity and a hint saying where the rest is; no rows for direction, colour, size or position', () => {
    window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
    const settings = { get: () => undefined, set: vi.fn(), getAll: () => ({}) };
    const tab = new SettingsPanel({ settings })._buildPlaybackTab();
    document.body.appendChild(tab);
    expect(tab.querySelector('#sp-device-sim-opacity')).toBeTruthy();
    expect(tab.querySelector('#sp-device-sim-hint').textContent).toBe(EN.settingsPanel.playback.deviceSimHint);
    for (const id of ['#sp-device-sim-direction', '#sp-device-sim-color', '#sp-device-sim-size', '#sp-device-sim-position-reset']) {
      expect(tab.querySelector(id)).toBeNull();
    }
    delete window.funsync;
  });
});
