/**
 * @vitest-environment jsdom
 * jsdom on purpose: the menu is DOM (editor-context-menu.js builds it in
 * document.body), and GamepadRecorder's DEFAULT window listener is checked
 * here (notes/CLAUDE.md "Test environments").
 */
// The gamepad recording menu and readout (editor work list 2.6, 2026-11-24):
// which pad, which axis each stick direction records into, the flips,
// Start / Stop; and the two live bars.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  openGamepadRecordMenu, gamepadTargetAxes, createGamepadRecordHud, GAMEPAD_TARGET_SUFFIXES, MAIN_TARGET,
} from '../../renderer/components/gamepad-record-menu.js';
import { activeContextMenu, closeContextMenu } from '../../renderer/js/editor-context-menu.js';
import { GamepadRecorder } from '../../renderer/js/gamepad-recorder.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';

// The strings land in the locale files with the editor integration; until
// then the few with placeholders get stand-ins, so a check that the pad's or
// an axis's name shows does not depend on that. A real string always wins.
const STAND_IN = {
  pad: 'Gamepad: {name}',
  stickX: 'Left / right: {axis}',
  stickY: 'Up / down: {axis}',
  axisNew: '{axis} (new)',
};

beforeAll(() => {
  const en = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
  en.editor = en.editor || {};
  en.editor.gamepad = { ...STAND_IN, ...(en.editor.gamepad || {}) };
  _setBundlesForTests('en', en, en);
});

afterEach(() => {
  closeContextMenu();
  document.body.innerHTML = '';
});

const items = () => [...activeContextMenu().querySelectorAll('.editor-context-menu__item')];
const byText = (text) => items().find((b) => b.textContent.includes(text));
const AXES = () => gamepadTargetAxes({ present: new Set(['roll', 'twist']) });

describe('gamepadTargetAxes', () => {
  it('roll and pitch first, then the other axes that rest at 50, then the stroke; never a vibration axis', () => {
    const axes = gamepadTargetAxes({ present: new Set(['roll']) });
    expect(axes.map((a) => a.id)).toEqual([...GAMEPAD_TARGET_SUFFIXES, MAIN_TARGET]);
    expect(axes.map((a) => a.id)).not.toContain('vib');
    expect(axes[0]).toEqual({ id: 'roll', label: 'Roll (R1)', missing: false });
    expect(axes[1]).toEqual({ id: 'pitch', label: 'Pitch (R2)', missing: true });
    expect(axes.at(-1)).toEqual({ id: 'main', label: t('editor.mainAxisLabel'), missing: false });
    expect(gamepadTargetAxes({ withMain: false }).map((a) => a.id)).not.toContain('main');
  });
});

describe('openGamepadRecordMenu', () => {
  it('shows the pad and the two stick directions with their axes; a missing axis says it is new', () => {
    openGamepadRecordMenu({ x: 10, y: 10, axes: AXES(), current: { x: 'roll', y: 'pitch' }, padName: 'Xbox 360 Controller' });
    const menu = activeContextMenu();
    expect(menu.classList.contains('gamepad-record-menu')).toBe(true);
    expect(menu.getAttribute('aria-label')).toBe(t('editor.gamepad.menu'));
    const [status, sx, sy] = items();
    expect(status.textContent).toContain('Xbox 360 Controller');
    expect(status.getAttribute('aria-disabled')).toBe('true');
    expect(sx.textContent).toContain('Roll (R1)');
    expect(sx.textContent).not.toContain(t('editor.gamepad.axisNew', { axis: 'Roll (R1)' }));
    expect(sy.textContent).toContain(t('editor.gamepad.axisNew', { axis: 'Pitch (R2)' }));
    // The focus starts on the first choice, not on the pad line.
    expect(document.activeElement).toBe(sx);
  });

  it('with no pad it says how to get one found, and Start is off', () => {
    const onStart = vi.fn();
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), padName: null, onStart });
    expect(items()[0].textContent).toBe(t('editor.gamepad.noPad'));
    const start = byText(t('editor.gamepad.start'));
    expect(start.getAttribute('aria-disabled')).toBe('true');
    start.click();
    expect(onStart).not.toHaveBeenCalled();
    expect(activeContextMenu()).not.toBe(null);
  });

  it('Start hands over the mapping', () => {
    const onStart = vi.fn();
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), current: { x: 'twist', y: 'pitch', invertY: true }, padName: 'Pad', onStart });
    byText(t('editor.gamepad.start')).click();
    expect(onStart).toHaveBeenCalledWith({ x: 'twist', y: 'pitch', invertX: false, invertY: true });
    expect(activeContextMenu()).toBe(null);
  });

  it('while recording it offers Stop instead', () => {
    const onStop = vi.fn();
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), padName: 'Pad', recording: true, onStart: vi.fn(), onStop });
    expect(byText(t('editor.gamepad.start'))).toBeUndefined();
    byText(t('editor.gamepad.stop')).click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('choosing a direction lists the axes; the other direction\'s axis is off; a pick comes back to the menu', () => {
    const onPick = vi.fn();
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), current: { x: 'roll', y: 'pitch' }, padName: 'Pad', onPick });
    items()[1].click();
    const picker = activeContextMenu();
    expect(picker.getAttribute('aria-label')).toBe(t('editor.gamepad.pickX'));
    const roll = byText('Roll (R1)');
    const pitch = byText('Pitch (R2)');
    expect(roll.getAttribute('role')).toBe('menuitemradio');
    expect(roll.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(roll);
    expect(pitch.getAttribute('aria-disabled')).toBe('true');
    pitch.click();
    expect(onPick).not.toHaveBeenCalled();

    byText('Twist').click();
    expect(onPick).toHaveBeenCalledWith({ x: 'twist', y: 'pitch', invertX: false, invertY: false });
    // Back on the main menu, showing the new choice.
    expect(activeContextMenu().getAttribute('aria-label')).toBe(t('editor.gamepad.menu'));
    expect(items()[1].textContent).toContain('Twist');
  });

  it('the up / down list starts on its own axis and greys the left / right one', () => {
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), current: { x: 'roll', y: 'pitch' }, padName: 'Pad' });
    items()[2].click();
    expect(activeContextMenu().getAttribute('aria-label')).toBe(t('editor.gamepad.pickY'));
    expect(byText('Roll (R1)').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement.textContent).toContain('Pitch (R2)');
  });

  it('the flips are checkboxes that toggle and report the whole mapping', () => {
    const onPick = vi.fn();
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), current: { x: 'roll', y: 'pitch' }, padName: 'Pad', onPick });
    const inv = byText(t('editor.gamepad.invertY'));
    expect(inv.getAttribute('role')).toBe('menuitemcheckbox');
    expect(inv.getAttribute('aria-checked')).toBe('false');
    inv.click();
    expect(onPick).toHaveBeenLastCalledWith({ x: 'roll', y: 'pitch', invertX: false, invertY: true });
    expect(byText(t('editor.gamepad.invertY')).getAttribute('aria-checked')).toBe('true');
  });

  it('a pad found while the menu is open replaces "no gamepad found" with its name', () => {
    let name = null;
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), padName: null, getPadName: () => name, onStart: vi.fn() });
    expect(items()[0].textContent).toBe(t('editor.gamepad.noPad'));
    name = 'Wireless Controller';
    window.dispatchEvent(new Event('gamepadconnected'));
    expect(items()[0].textContent).toContain('Wireless Controller');
    expect(byText(t('editor.gamepad.start')).hasAttribute('aria-disabled')).toBe(false);
  });

  it('without getPadName it names the pad from the event', () => {
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), padName: null });
    const e = new Event('gamepadconnected');
    e.gamepad = { id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)' };
    window.dispatchEvent(e);
    expect(items()[0].textContent).toContain('Xbox 360 Controller');
    expect(items()[0].textContent).not.toContain('XInput');
  });

  it('a closed menu stops listening for pads', () => {
    const getPadName = vi.fn(() => 'Pad');
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), padName: null, getPadName });
    closeContextMenu();
    window.dispatchEvent(new Event('gamepadconnected'));
    window.dispatchEvent(new Event('gamepadconnected'));
    expect(getPadName).not.toHaveBeenCalled();
    expect(activeContextMenu()).toBe(null);
  });

  it('Escape closes it and gives the focus back', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.appendChild(canvas);
    canvas.focus();
    openGamepadRecordMenu({ x: 0, y: 0, axes: AXES(), padName: 'Pad', returnFocus: canvas });
    activeContextMenu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(activeContextMenu()).toBe(null);
    expect(document.activeElement).toBe(canvas);
  });
});

describe('createGamepadRecordHud', () => {
  it('fills each bar from the centre toward the stick, and turns red only while a take records', () => {
    const hud = createGamepadRecordHud();
    document.body.appendChild(hud.el);
    expect(hud.el.hidden).toBe(true);
    hud.update({ a: 75, b: 24.6, labelA: 'Roll', labelB: 'Pitch', recording: true, playing: false });
    expect(hud.el.hidden).toBe(false);
    expect(hud.el.classList.contains('gamepad-hud--live')).toBe(false);
    const [ra, rb] = hud.el.querySelectorAll('.gamepad-hud__axis');
    expect(ra.querySelector('.gamepad-hud__label').textContent).toBe('Roll');
    expect(ra.querySelector('.gamepad-hud__fill').style.left).toBe('50%');
    expect(ra.querySelector('.gamepad-hud__fill').style.width).toBe('25%');
    expect(rb.querySelector('.gamepad-hud__fill').style.left).toBe('25%');
    expect(rb.querySelector('.gamepad-hud__fill').style.width).toBe('25%');
    expect(rb.querySelector('.gamepad-hud__value').textContent).toBe('25');
    expect(rb.querySelector('.gamepad-hud__track').getAttribute('aria-valuenow')).toBe('25');
    hud.update({ a: 75, b: 25, recording: true, playing: true });
    expect(hud.el.classList.contains('gamepad-hud--live')).toBe(true);
    hud.update({ a: null, b: null });
    expect(ra.querySelector('.gamepad-hud__fill').style.width).toBe('0%');
    expect(ra.querySelector('.gamepad-hud__track').hasAttribute('aria-valuenow')).toBe(false);
    hud.destroy();
    expect(hud.el.isConnected).toBe(false);
  });
});

describe('GamepadRecorder in a window', () => {
  it('listens to the window for pads by default', () => {
    const onPadsChanged = vi.fn();
    const rec = new GamepadRecorder({ getVideoTimeMs: () => 0, isPlaying: () => false, getGamepads: () => [], onPadsChanged });
    window.dispatchEvent(new Event('gamepadconnected'));
    expect(onPadsChanged).toHaveBeenCalledWith([], 'gamepadconnected');
    rec.dispose();
    window.dispatchEvent(new Event('gamepadconnected'));
    expect(onPadsChanged).toHaveBeenCalledTimes(1);
  });
});
