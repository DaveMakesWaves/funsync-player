/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// layoutKey (renderer/js/keyboard-layout.js), FT-035: the key a letter
// shortcut matches. On a layout that types another alphabet the Latin letter
// on that physical key; everything else (Latin layouts, named keys, digits,
// punctuation, dead keys, an IME) exactly `e.key`. The three key switches
// that use it are tested in keyboard.test.js, editor-selection-menu.test.js
// and editor-popout-selection.test.js.

import { describe, it, expect } from 'vitest';
import { layoutKey } from '../../renderer/js/keyboard-layout.js';

describe('layoutKey: another alphabet → the Latin letter on the key', () => {
  it.each([
    ['Russian т on N', { key: 'т', code: 'KeyN' }, 'n'],
    ['Russian Shift+Т on N', { key: 'Т', code: 'KeyN', shiftKey: true }, 'N'],
    ['Russian with Caps Lock (Т, no Shift)', { key: 'Т', code: 'KeyN' }, 'n'],
    ['Russian а on F', { key: 'а', code: 'KeyF' }, 'f'],
    ['Russian с on C (Ctrl+C copies)', { key: 'с', code: 'KeyC', ctrlKey: true }, 'c'],
    ['Korean ㅜ on N', { key: 'ㅜ', code: 'KeyN' }, 'n'],
    ['Korean ㅂ on Q', { key: 'ㅂ', code: 'KeyQ' }, 'q'],
    ['Greek ν on N', { key: 'ν', code: 'KeyN' }, 'n'],
    ['Hebrew מ on N', { key: 'מ', code: 'KeyN' }, 'n'],
  ])('%s', (_, e, want) => {
    expect(layoutKey(e)).toBe(want);
  });
});

describe('layoutKey: everything else is e.key, untouched', () => {
  it.each([
    ['AZERTY a on the Q key (not Q)', { key: 'a', code: 'KeyQ' }, 'a'],
    ['AZERTY Shift+A on the Q key', { key: 'A', code: 'KeyQ', shiftKey: true }, 'A'],
    ['QWERTZ z on the Y key', { key: 'z', code: 'KeyY' }, 'z'],
    ['US n', { key: 'n', code: 'KeyN' }, 'n'],
    ['an IME composing', { key: 'Process', code: 'KeyN' }, 'Process'],
    ['a dead key', { key: 'Dead', code: 'KeyN' }, 'Dead'],
    ['a named key', { key: 'ArrowLeft', code: 'ArrowLeft' }, 'ArrowLeft'],
    ['Escape', { key: 'Escape', code: 'Escape' }, 'Escape'],
    ['a digit', { key: '1', code: 'Digit1' }, '1'],
    ['AZERTY é on the 2 key (not a letter key)', { key: 'é', code: 'Digit2' }, 'é'],
    ['German ß on Minus', { key: 'ß', code: 'Minus' }, 'ß'],
    ['German ü on BracketLeft', { key: 'ü', code: 'BracketLeft' }, 'ü'],
    ['Russian punctuation on Slash', { key: '.', code: 'Slash' }, '.'],
    ['a letter with no code (synthetic event)', { key: 'т' }, 'т'],
    ['Space', { key: ' ', code: 'Space' }, ' '],
  ])('%s', (_, e, want) => {
    expect(layoutKey(e)).toBe(want);
  });

  it('no event or no key: passes through', () => {
    expect(layoutKey(undefined)).toBeUndefined();
    expect(layoutKey({ code: 'KeyN' })).toBeUndefined();
  });
});
