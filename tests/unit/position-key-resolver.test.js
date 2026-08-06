/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Editor custom-position-key resolver — pure-function tests.
// SCOPE: notes/features/SCOPE-editor-custom-position-keys.md §6.

import { describe, it, expect } from 'vitest';
import {
  serializeBinding,
  parseBinding,
  buildResolverMap,
  lookupBinding,
  isReservedKey,
  detectConflict,
  RESERVED_EDITOR_KEYS,
  DEFAULT_POSITION_KEYS,
} from '../../renderer/js/position-key-resolver.js';

describe('serializeBinding', () => {
  it('returns just the code for a bare key', () => {
    expect(serializeBinding({ code: 'KeyA' })).toBe('KeyA');
    expect(serializeBinding({ code: 'KeyA', mods: {} })).toBe('KeyA');
  });

  it('prepends Shift: for a shifted key', () => {
    expect(serializeBinding({ code: 'KeyA', mods: { shift: true } })).toBe('Shift:KeyA');
  });

  it('uses canonical modifier order (Ctrl → Alt → Shift)', () => {
    expect(
      serializeBinding({ code: 'KeyA', mods: { ctrl: true, alt: true, shift: true } }),
    ).toBe('Ctrl:Alt:Shift:KeyA');
    // Order of keys in the input object does not matter.
    expect(
      serializeBinding({ code: 'KeyA', mods: { shift: true, alt: true, ctrl: true } }),
    ).toBe('Ctrl:Alt:Shift:KeyA');
  });

  it('returns empty string for invalid input', () => {
    expect(serializeBinding(null)).toBe('');
    expect(serializeBinding({})).toBe('');
    expect(serializeBinding({ code: '' })).toBe('');
    expect(serializeBinding({ code: 42 })).toBe('');
  });
});

describe('parseBinding', () => {
  it('round-trips a bare key', () => {
    const out = parseBinding('KeyA');
    expect(out).toEqual({ code: 'KeyA', mods: { shift: false, ctrl: false, alt: false } });
  });

  it('parses a single-modifier combo', () => {
    expect(parseBinding('Shift:KeyA')).toEqual({
      code: 'KeyA', mods: { shift: true, ctrl: false, alt: false },
    });
  });

  it('parses a triple-modifier combo', () => {
    expect(parseBinding('Ctrl:Alt:Shift:KeyA')).toEqual({
      code: 'KeyA', mods: { shift: true, ctrl: true, alt: true },
    });
  });
});

describe('buildResolverMap', () => {
  it('returns empty map for empty / non-array input', () => {
    expect(buildResolverMap([]).size).toBe(0);
    expect(buildResolverMap(null).size).toBe(0);
    expect(buildResolverMap(undefined).size).toBe(0);
    expect(buildResolverMap('not-an-array').size).toBe(0);
  });

  it('builds a one-entry map from one valid binding', () => {
    const m = buildResolverMap([{ code: 'KeyA', mods: {}, position: 25 }]);
    expect(m.size).toBe(1);
    expect(m.get('KeyA')).toBe(25);
  });

  it('last-wins on duplicate keys', () => {
    const m = buildResolverMap([
      { code: 'KeyA', mods: {}, position: 25 },
      { code: 'KeyA', mods: {}, position: 75 },
    ]);
    expect(m.size).toBe(1);
    expect(m.get('KeyA')).toBe(75);
  });

  it('treats different modifier shapes as different keys', () => {
    const m = buildResolverMap([
      { code: 'KeyA', mods: {}, position: 25 },
      { code: 'KeyA', mods: { shift: true }, position: 75 },
    ]);
    expect(m.size).toBe(2);
    expect(m.get('KeyA')).toBe(25);
    expect(m.get('Shift:KeyA')).toBe(75);
  });

  it('clamps position to 0-100', () => {
    const m = buildResolverMap([
      { code: 'KeyA', mods: {}, position: 150 },
      { code: 'KeyB', mods: {}, position: -10 },
      { code: 'KeyC', mods: {}, position: 50.7 },
    ]);
    expect(m.get('KeyA')).toBe(100);
    expect(m.get('KeyB')).toBe(0);
    expect(m.get('KeyC')).toBe(51);  // rounded
  });

  it('drops entries with non-finite position', () => {
    const m = buildResolverMap([
      { code: 'KeyA', mods: {}, position: NaN },
      { code: 'KeyB', mods: {}, position: 'fifty' },
      { code: 'KeyC', mods: {}, position: 25 },
    ]);
    expect(m.has('KeyA')).toBe(false);
    expect(m.has('KeyB')).toBe(false);
    expect(m.get('KeyC')).toBe(25);
  });

  it('drops entries with missing / empty code', () => {
    const m = buildResolverMap([
      { code: '', mods: {}, position: 50 },
      { mods: {}, position: 50 },
      { code: null, mods: {}, position: 50 },
      { code: 'KeyA', mods: {}, position: 25 },
    ]);
    expect(m.size).toBe(1);
    expect(m.get('KeyA')).toBe(25);
  });

  it('drops null / non-object entries', () => {
    const m = buildResolverMap([null, 'string', 42, { code: 'KeyA', mods: {}, position: 25 }]);
    expect(m.size).toBe(1);
  });
});

describe('lookupBinding', () => {
  const map = buildResolverMap([
    { code: 'KeyA', mods: {}, position: 25 },
    { code: 'KeyA', mods: { shift: true }, position: 75 },
  ]);

  it('returns the mapped position for a matching binding', () => {
    expect(lookupBinding(map, { code: 'KeyA' })).toBe(25);
    expect(lookupBinding(map, { code: 'KeyA', mods: { shift: true } })).toBe(75);
  });

  it('returns null for an unmapped binding', () => {
    expect(lookupBinding(map, { code: 'KeyB' })).toBe(null);
    expect(lookupBinding(map, { code: 'KeyA', mods: { ctrl: true } })).toBe(null);
  });

  it('returns null for invalid inputs', () => {
    expect(lookupBinding(null, { code: 'KeyA' })).toBe(null);
    expect(lookupBinding(map, null)).toBe(null);
    expect(lookupBinding(map, { code: '' })).toBe(null);
  });
});

describe('isReservedKey', () => {
  it('reserves Escape with any modifier combo', () => {
    expect(isReservedKey('Escape', {}).reserved).toBe(true);
    expect(isReservedKey('Escape', { shift: true }).reserved).toBe(true);
    expect(isReservedKey('Escape', { ctrl: true, alt: true }).reserved).toBe(true);
  });

  it('reserves bare KeyR (recording) but allows Shift+R', () => {
    expect(isReservedKey('KeyR', {}).reserved).toBe(true);
    expect(isReservedKey('KeyR', { shift: true }).reserved).toBe(false);
    expect(isReservedKey('KeyR', { ctrl: true }).reserved).toBe(false);
  });

  it('reserves Ctrl+Z (undo) but allows bare Z and Shift+Z', () => {
    expect(isReservedKey('KeyZ', { ctrl: true }).reserved).toBe(true);
    expect(isReservedKey('KeyZ', {}).reserved).toBe(false);
    expect(isReservedKey('KeyZ', { shift: true }).reserved).toBe(false);
  });

  it('does not reserve random letter keys', () => {
    expect(isReservedKey('KeyA', {}).reserved).toBe(false);
    expect(isReservedKey('KeyJ', {}).reserved).toBe(false);
  });

  it('reserves all function keys F1-F12 with any modifier combo', () => {
    for (let n = 1; n <= 12; n++) {
      expect(isReservedKey(`F${n}`, {}).reserved).toBe(true);
      expect(isReservedKey(`F${n}`, { ctrl: true }).reserved).toBe(true);
    }
  });

  it('reserves navigation keys (arrows, Home, End, PgUp, PgDn) with any modifier', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                         'Home', 'End', 'PageUp', 'PageDown']) {
      expect(isReservedKey(code, {}).reserved).toBe(true);
      expect(isReservedKey(code, { shift: true }).reserved).toBe(true);
    }
  });

  it('returns reason="structural" for navigation keys', () => {
    expect(isReservedKey('Escape', {}).reason).toBe('structural');
  });

  it('returns reason="editor-command" for editor letter keys', () => {
    expect(isReservedKey('KeyR', {}).reason).toBe('editor-command');
    expect(isReservedKey('KeyZ', { ctrl: true }).reason).toBe('editor-command');
  });
});

describe('detectConflict', () => {
  it('returns null when binding is unique and not a default', () => {
    expect(detectConflict({ code: 'KeyA' }, [])).toEqual({ kind: null, defaultPosition: null });
  });

  it('returns "duplicate" when binding matches an existing custom entry', () => {
    const existing = [{ code: 'KeyA', mods: {}, position: 25 }];
    expect(detectConflict({ code: 'KeyA' }, existing)).toEqual({
      kind: 'duplicate',
      defaultPosition: null,
    });
  });

  it('treats different modifier shapes as non-duplicates', () => {
    const existing = [{ code: 'KeyA', mods: {}, position: 25 }];
    expect(detectConflict({ code: 'KeyA', mods: { shift: true } }, existing)).toEqual({
      kind: null,
      defaultPosition: null,
    });
  });

  it('returns "override-default" when binding matches a default key', () => {
    expect(detectConflict({ code: 'Digit5' }, [])).toEqual({
      kind: 'override-default',
      defaultPosition: 50,
    });
    expect(detectConflict({ code: 'Digit0' }, [])).toEqual({
      kind: 'override-default',
      defaultPosition: 0,
    });
  });

  it('returns "override-default" for Shift+0 (top-key)', () => {
    expect(detectConflict({ code: 'Digit0', mods: { shift: true } }, [])).toEqual({
      kind: 'override-default',
      defaultPosition: 100,
    });
  });

  it('returns "override-default" for the Minus top-key', () => {
    expect(detectConflict({ code: 'Minus' }, [])).toEqual({
      kind: 'override-default',
      defaultPosition: 100,
    });
  });

  it('prefers "duplicate" over "override-default" when both apply', () => {
    // User already custom-bound Digit5 — adding another should report
    // duplicate, not the lesser override-default warning.
    const existing = [{ code: 'Digit5', mods: {}, position: 75 }];
    expect(detectConflict({ code: 'Digit5' }, existing)).toEqual({
      kind: 'duplicate',
      defaultPosition: null,
    });
  });
});

describe('RESERVED_EDITOR_KEYS + DEFAULT_POSITION_KEYS exports', () => {
  it('reserved list includes structural + editor commands', () => {
    const codes = new Set(RESERVED_EDITOR_KEYS.map((e) => e.code));
    expect(codes.has('Escape')).toBe(true);
    expect(codes.has('KeyR')).toBe(true);
    expect(codes.has('KeyZ')).toBe(true);
  });

  it('defaults cover 0–100 in 10s', () => {
    const positions = new Set(DEFAULT_POSITION_KEYS.map((d) => d.position));
    for (let p = 0; p <= 100; p += 10) {
      expect(positions.has(p)).toBe(true);
    }
  });

  it('defaults include the three top-key bindings', () => {
    const map = buildResolverMap(DEFAULT_POSITION_KEYS);
    expect(map.get('Shift:Digit0')).toBe(100);
    expect(map.get('Shift:Numpad0')).toBe(100);
    expect(map.get('Minus')).toBe(100);
    expect(map.get('NumpadSubtract')).toBe(100);
  });
});
