// Tests for keyboard-help — the shared `?` overlay used by both the
// editor and the player view. Pure rendering helper; the interesting
// behaviours to pin down:
//
//   1. The exported group constants are well-formed (every row has
//      [keys, desc] strings — defends against accidental shape regression
//      when adding new shortcut entries).
//   2. Both the player and editor group sets contain the `?` row
//      (since the SCOPE doc treats discoverability of the help itself
//      as part of the help — a help screen that doesn't say how to
//      open it is a small but real Nielsen #10 violation).

import { describe, it, expect } from 'vitest';
import { PLAYER_SHORTCUT_GROUPS, EDITOR_SHORTCUT_GROUPS } from '../../renderer/js/keyboard-help.js';

function assertWellFormed(groups, name) {
  expect(Array.isArray(groups), `${name} is an array`).toBe(true);
  for (const g of groups) {
    expect(typeof g.title, `${name} group title is a string`).toBe('string');
    expect(g.title.length, `${name} group title not empty`).toBeGreaterThan(0);
    expect(Array.isArray(g.rows), `${name} group rows is an array`).toBe(true);
    for (const row of g.rows) {
      expect(Array.isArray(row), `${name} row is a tuple`).toBe(true);
      expect(row.length, `${name} row has [keys, desc]`).toBe(2);
      expect(typeof row[0], `${name} row keys is string`).toBe('string');
      expect(typeof row[1], `${name} row desc is string`).toBe('string');
      expect(row[0].length, `${name} row keys not empty`).toBeGreaterThan(0);
      expect(row[1].length, `${name} row desc not empty`).toBeGreaterThan(0);
    }
  }
}

describe('PLAYER_SHORTCUT_GROUPS', () => {
  it('is well-formed', () => {
    assertWellFormed(PLAYER_SHORTCUT_GROUPS, 'player');
  });

  it('lists the `?` shortcut so users can recall how to open this help', () => {
    const allRows = PLAYER_SHORTCUT_GROUPS.flatMap(g => g.rows);
    const hasQuestionMark = allRows.some(([keys]) => keys.includes('?'));
    expect(hasQuestionMark, 'player groups should list `?` somewhere').toBe(true);
  });

  it('covers playback essentials (Space/K, J/L, M, F)', () => {
    const allKeys = PLAYER_SHORTCUT_GROUPS.flatMap(g => g.rows.map(r => r[0])).join(' | ');
    expect(allKeys).toMatch(/Space|\bK\b/);  // play/pause
    expect(allKeys).toMatch(/\bJ\b|\bL\b/);   // ±10s seek
    expect(allKeys).toMatch(/\bM\b/);          // mute
    expect(allKeys).toMatch(/\bF\b/);          // fullscreen
  });
});

describe('EDITOR_SHORTCUT_GROUPS', () => {
  it('is well-formed', () => {
    assertWellFormed(EDITOR_SHORTCUT_GROUPS, 'editor');
  });

  it('lists the `?` shortcut', () => {
    const allRows = EDITOR_SHORTCUT_GROUPS.flatMap(g => g.rows);
    const hasQuestionMark = allRows.some(([keys]) => keys.includes('?'));
    expect(hasQuestionMark).toBe(true);
  });

  it('covers editor essentials (Ctrl+Z, Ctrl+S, numpad, arrows)', () => {
    const allKeys = EDITOR_SHORTCUT_GROUPS.flatMap(g => g.rows.map(r => r[0])).join(' | ');
    expect(allKeys).toMatch(/Ctrl\+Z/);
    expect(allKeys).toMatch(/Ctrl\+S/);
    expect(allKeys).toMatch(/Numpad|0 –/);
    expect(allKeys).toMatch(/Up|Down/);
  });
});
