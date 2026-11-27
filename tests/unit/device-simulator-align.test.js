/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL aligner layer and the REAL DeviceSimulator are
 * built as DOM and clicked (notes/CLAUDE.md "Test environments").
 */
// "Align the simulator to the video" (editor work list 5.4, 2026-11-24): from
// the simulator's right-click menu, click the stroke's tip, then its base,
// on the video; the bar is laid along that line, kept as fractions of the
// picture. Asserted: the two clicks give those fractions, Esc and Cancel
// stop at any step, the clicks and the Esc never reach the player's own
// listeners, the menu offers it only with a picture, the simulator is laid
// along the line (grip, knob and Turn 90° gone), a drag moves the line, and
// clearing it (Reset) puts the simulator back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { startSimAlign, SIM_ALIGN_LINGER_MS } = await import('../../renderer/components/sim-align-overlay.js');
const { DeviceSimulator, resolveSimOptions } = await import('../../renderer/components/device-simulator.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
EN.deviceSim = {
  align: 'Align to the video…', alignTip: 'Click the tip of the stroke on the video.', alignBase: 'Now click the base of the stroke.',
  alignEsc: 'Esc cancels', alignAria: 'Align the simulator to the video', tooltipAligned: 'Lined up with the video',
  ...EN.deviceSim,
};
const S = EN.deviceSim;

const PICTURE = { left: 100, top: 50, width: 800, height: 450 };
const click = (el, x, y) => el.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
const key = (k) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });

let docClicks;
let docKeys;
const onDocClick = () => { docClicks++; };
const onDocKey = (e) => { docKeys.push(e.key); };
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  _setBundlesForTests('en', EN, EN);
  window.innerWidth = 1000;
  window.innerHeight = 800;
  docClicks = 0;
  docKeys = [];
  // The player's own listeners, as app.js and keyboard.js have them.
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
});
afterEach(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKey);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the two clicks', () => {
  it('the tip, then the base: fractions of the picture; the clicks never reach the player', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const a = startSimAlign({ getRect: () => ({ content: PICTURE }), onDone });
    const layer = document.querySelector('.sim-align');
    expect(layer.querySelector('.sim-align__step').textContent).toBe(S.alignTip);
    click(layer, 500, 140);                      // x 0.5, y 0.2
    expect(layer.querySelector('.sim-align__step').textContent).toBe(S.alignBase);
    click(layer, 500, 365);                      // x 0.5, y 0.7
    expect(onDone).toHaveBeenCalledWith({ tip: { x: 0.5, y: 0.2 }, base: { x: 0.5, y: 0.7 } });
    expect(docClicks).toBe(0);
    expect(a.active).toBe(false);
    // It stays a moment, still taking clicks, so the release cannot land on the video.
    expect(document.querySelector('.sim-align')).not.toBeNull();
    click(layer, 500, 365);
    expect(docClicks).toBe(0);
    vi.advanceTimersByTime(SIM_ALIGN_LINGER_MS);
    expect(document.querySelector('.sim-align')).toBeNull();
  });

  it('a click off the picture, or a base too near the tip, is not taken', () => {
    const onDone = vi.fn();
    startSimAlign({ getRect: () => ({ content: PICTURE }), onDone });
    const layer = document.querySelector('.sim-align');
    click(layer, 20, 20);                        // off the picture
    expect(layer.querySelector('.sim-align__step').textContent).toBe(S.alignTip);
    click(layer, 500, 140);
    click(layer, 510, 150);                      // 14 px away
    expect(onDone).not.toHaveBeenCalled();
    click(layer, 500, 300);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Esc cancels at any step, and the player never hears it', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    startSimAlign({ getRect: () => ({ content: PICTURE }), onDone, onCancel });
    click(document.querySelector('.sim-align'), 500, 140);
    document.dispatchEvent(key('Escape'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(document.querySelector('.sim-align')).toBeNull();
    expect(docKeys).toEqual([]);
    // Other keys pass (Space still pauses, to find the frame).
    startSimAlign({ getRect: () => ({ content: PICTURE }), onDone, onCancel });
    document.dispatchEvent(key(' '));
    expect(docKeys).toEqual([' ']);
  });

  it('Cancel cancels', () => {
    const onCancel = vi.fn();
    startSimAlign({ getRect: () => ({ content: PICTURE }), onDone: vi.fn(), onCancel });
    document.querySelector('.sim-align__cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.sim-align')).toBeNull();
    expect(docClicks).toBe(0);
  });
});

describe('on the simulator', () => {
  /** A video showing a 1600 x 900 picture in an 800 x 450 box at (100, 50). */
  const video = () => ({
    videoWidth: 1600,
    videoHeight: 900,
    getBoundingClientRect: () => ({ ...PICTURE, right: 900, bottom: 500 }),
    parentElement: null,
  });

  function sim(hooks = {}, withVideo = true) {
    const player = { currentTime: 0, video: withVideo ? video() : undefined };
    const s = new DeviceSimulator({
      videoPlayer: player, funscriptEngine: { isLoaded: true, getPositionAt: () => 50 }, options: resolveSimOptions({}), ...hooks,
    });
    return { s, panel: document.querySelector('.device-sim') };
  }
  const menuItems = (panel) => {
    panel.querySelector('.device-sim__track').dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
    return [...document.querySelectorAll('.device-sim__menu-item')];
  };

  it('the menu offers it only while a video picture shows', () => {
    const { panel } = sim({}, false);
    expect(menuItems(panel).map((b) => b.textContent)).not.toContain(S.align);
    document.body.innerHTML = '<div id="app"></div>';
    const { panel: p2 } = sim();
    expect(menuItems(p2).map((b) => b.textContent)).toContain(S.align);
  });

  it('after the two clicks the bar is aligned: saved, grip and knob gone, Turn 90° not offered; clearing it puts it back', () => {
    const onOption = vi.fn();
    const { s, panel } = sim({ onOption });
    menuItems(panel).find((b) => b.textContent === S.align).click();
    expect(s.isAligning).toBe(true);
    const layer = document.querySelector('.sim-align');
    click(layer, 500, 140);
    click(layer, 500, 365);
    const line = { tip: { x: 0.5, y: 0.2 }, base: { x: 0.5, y: 0.7 } };
    expect(onOption).toHaveBeenLastCalledWith('align', line);
    expect(s.alignment).toEqual(line);
    expect(panel.dataset.aligned).toBe('true');
    expect(panel.querySelector('.device-sim__track').title).toBe(S.tooltipAligned);
    expect(menuItems(panel).map((b) => b.textContent)).not.toContain(S.turn);
    s.setAlignment(null);                        // Reset (app.js clears the setting)
    expect(panel.dataset.aligned).toBeUndefined();
    expect(menuItems(panel).map((b) => b.textContent)).toContain(S.turn);
  });

  it('a drag on an aligned bar moves the line over the picture; the grip and knob do nothing', () => {
    const onOption = vi.fn();
    const onResized = vi.fn();
    const onRotated = vi.fn();
    const { s, panel } = sim({ onOption, onResized, onRotated });
    s.setAlignment({ tip: { x: 0.5, y: 0.2 }, base: { x: 0.5, y: 0.7 } });
    const pd = (el, x, y) => el.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    pd(panel.querySelector('.device-sim__track'), 500, 250);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 580, clientY: 250 }));   // 80 px = 0.1 of the picture
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 580, clientY: 250 }));
    const [k, moved] = onOption.mock.calls.at(-1);
    expect(k).toBe('align');
    expect(moved.tip.x).toBeCloseTo(0.6, 9);
    expect(moved.base.x).toBeCloseTo(0.6, 9);
    pd(panel.querySelector('.device-sim__grip'), 520, 300);
    pd(panel.querySelector('.device-sim__knob'), 520, 100);
    window.dispatchEvent(new MouseEvent('pointerup', {}));
    expect(onResized).not.toHaveBeenCalled();
    expect(onRotated).not.toHaveBeenCalled();
  });

  it('hiding the simulator stops the clicks', () => {
    const { s } = sim();
    s.show();
    expect(s.startAlign()).toBe(true);
    s.hide();
    expect(s.isAligning).toBe(false);
    expect(document.querySelector('.sim-align')).toBeNull();
  });
});
