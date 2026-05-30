// KeyCapture component tests.
// SCOPE: notes/features/SCOPE-editor-custom-position-keys.md §6.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyCapture, formatBindingLabel } from '../../renderer/components/key-capture.js';

function makeMount() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

function fireKey(el, init) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

describe('KeyCapture component', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders empty placeholder when no initial binding', () => {
    const mount = makeMount();
    new KeyCapture({ element: mount });
    const root = document.querySelector('.key-capture');
    expect(root).toBeTruthy();
    expect(root.classList.contains('key-capture--empty')).toBe(true);
  });

  it('renders the initial binding label', () => {
    const mount = makeMount();
    new KeyCapture({ element: mount, initial: { code: 'KeyA', mods: {} } });
    const root = document.querySelector('.key-capture');
    expect(root.textContent).toBe('A');
  });

  it('enters capture mode on click', () => {
    const mount = makeMount();
    new KeyCapture({ element: mount });
    const root = document.querySelector('.key-capture');
    root.click();
    expect(root.classList.contains('key-capture--capturing')).toBe(true);
  });

  it('captures a bare key and emits onChange', () => {
    const mount = makeMount();
    const onChange = vi.fn();
    new KeyCapture({ element: mount, onChange });
    const root = document.querySelector('.key-capture');
    root.click();
    fireKey(root, { code: 'KeyA' });
    expect(onChange).toHaveBeenCalledWith({
      code: 'KeyA',
      mods: { shift: false, ctrl: false, alt: false },
    });
    expect(root.classList.contains('key-capture--capturing')).toBe(false);
    expect(root.textContent).toBe('A');
  });

  it('captures a modifier combo (Shift+A)', () => {
    const mount = makeMount();
    const onChange = vi.fn();
    new KeyCapture({ element: mount, onChange });
    const root = document.querySelector('.key-capture');
    root.click();
    fireKey(root, { code: 'KeyA', shiftKey: true });
    expect(onChange).toHaveBeenCalledWith({
      code: 'KeyA',
      mods: { shift: true, ctrl: false, alt: false },
    });
    expect(root.textContent).toBe('Shift+A');
  });

  it('captures Ctrl+Alt+Shift combo', () => {
    const mount = makeMount();
    const onChange = vi.fn();
    new KeyCapture({ element: mount, onChange });
    const root = document.querySelector('.key-capture');
    root.click();
    fireKey(root, { code: 'KeyJ', shiftKey: true, ctrlKey: true, altKey: true });
    expect(onChange).toHaveBeenCalledWith({
      code: 'KeyJ',
      mods: { shift: true, ctrl: true, alt: true },
    });
    expect(root.textContent).toBe('Ctrl+Alt+Shift+J');
  });

  it('ignores modifier-only keydown (waits for non-modifier)', () => {
    const mount = makeMount();
    const onChange = vi.fn();
    new KeyCapture({ element: mount, onChange });
    const root = document.querySelector('.key-capture');
    root.click();
    fireKey(root, { code: 'ShiftLeft', shiftKey: true });
    fireKey(root, { code: 'ControlLeft', ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(root.classList.contains('key-capture--capturing')).toBe(true);
    // Then the real key settles.
    fireKey(root, { code: 'KeyA', shiftKey: true, ctrlKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape without emitting onChange', () => {
    const mount = makeMount();
    const onChange = vi.fn();
    new KeyCapture({
      element: mount,
      initial: { code: 'KeyA', mods: {} },
      onChange,
    });
    const root = document.querySelector('.key-capture');
    root.click();
    fireKey(root, { code: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(root.classList.contains('key-capture--capturing')).toBe(false);
    expect(root.textContent).toBe('A');  // previous binding preserved
  });

  it('ignores Meta key combos (Win/Cmd) per SCOPE decision #7', () => {
    const mount = makeMount();
    const onChange = vi.fn();
    new KeyCapture({ element: mount, onChange });
    const root = document.querySelector('.key-capture');
    root.click();
    fireKey(root, { code: 'KeyA', metaKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(root.classList.contains('key-capture--capturing')).toBe(true);
  });

  it('setBinding replaces the current display without re-capturing', () => {
    const mount = makeMount();
    const onChange = vi.fn();
    const kc = new KeyCapture({ element: mount, onChange });
    kc.setBinding({ code: 'KeyB', mods: {} });
    const root = document.querySelector('.key-capture');
    expect(root.textContent).toBe('B');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cancel() exits capture mode programmatically', () => {
    const mount = makeMount();
    const kc = new KeyCapture({ element: mount });
    const root = document.querySelector('.key-capture');
    root.click();
    expect(root.classList.contains('key-capture--capturing')).toBe(true);
    kc.cancel();
    expect(root.classList.contains('key-capture--capturing')).toBe(false);
  });

  it('destroy() removes the element from DOM', () => {
    const mount = makeMount();
    const kc = new KeyCapture({ element: mount });
    expect(document.querySelector('.key-capture')).toBeTruthy();
    kc.destroy();
    expect(document.querySelector('.key-capture')).toBeFalsy();
  });
});

describe('formatBindingLabel', () => {
  it('formats letter keys', () => {
    expect(formatBindingLabel({ code: 'KeyA', mods: {} })).toBe('A');
    expect(formatBindingLabel({ code: 'KeyZ', mods: {} })).toBe('Z');
  });

  it('formats digit keys', () => {
    expect(formatBindingLabel({ code: 'Digit5', mods: {} })).toBe('5');
  });

  it('formats numpad keys with friendly names', () => {
    expect(formatBindingLabel({ code: 'Numpad7', mods: {} })).toBe('Numpad7');
    expect(formatBindingLabel({ code: 'NumpadAdd', mods: {} })).toBe('Numpad+');
    expect(formatBindingLabel({ code: 'NumpadSubtract', mods: {} })).toBe('Numpad-');
    expect(formatBindingLabel({ code: 'NumpadDecimal', mods: {} })).toBe('Numpad.');
  });

  it('formats symbol keys', () => {
    expect(formatBindingLabel({ code: 'Minus', mods: {} })).toBe('-');
    expect(formatBindingLabel({ code: 'Equal', mods: {} })).toBe('=');
    expect(formatBindingLabel({ code: 'Comma', mods: {} })).toBe(',');
  });

  it('formats modifier combos in canonical order', () => {
    expect(formatBindingLabel({
      code: 'KeyA', mods: { shift: true, ctrl: true, alt: true },
    })).toBe('Ctrl+Alt+Shift+A');
  });

  it('accepts serialized string form', () => {
    expect(formatBindingLabel('Shift:KeyA')).toBe('Shift+A');
    expect(formatBindingLabel('Ctrl:KeyZ')).toBe('Ctrl+Z');
  });

  it('returns empty string for invalid input', () => {
    expect(formatBindingLabel(null)).toBe('');
    expect(formatBindingLabel({})).toBe('');
    expect(formatBindingLabel({ code: '' })).toBe('');
  });
});
