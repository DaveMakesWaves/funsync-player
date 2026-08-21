/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
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

import { describe, it, expect, vi } from 'vitest';

// Settings the overlay reads. Mutable so a test can flip a mode and rebuild
// the groups — the builders are called fresh each time the modal opens.
const SETTINGS = vi.hoisted(() => ({}));
vi.mock('../../renderer/js/data-service.js', () => ({
  dataService: { get: (key) => SETTINGS[key] },
}));

import { getPlayerShortcutGroups, getEditorShortcutGroups } from '../../renderer/js/keyboard-help.js';
import { t } from '../../renderer/js/i18n.js';

const PLAYER_SHORTCUT_GROUPS = getPlayerShortcutGroups();
const EDITOR_SHORTCUT_GROUPS = getEditorShortcutGroups();

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

// X and Z can each run as hold or press-to-toggle. A row that says "(hold)"
// next to a key that toggles is worse than no row at all, so the label has to
// follow the setting (lr_x3, EroScripts #307).
describe('hold keys reflect their configured mode', () => {
  const rowFor = (key) => getPlayerShortcutGroups()
    .flatMap(g => g.rows)
    .find(([keys]) => keys === key);

  it('Z reads as a hold by default', () => {
    delete SETTINGS['player.edgeHoldMode'];
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHold'));
  });

  it('Z reads as a toggle when the mode is set', () => {
    SETTINGS['player.edgeHoldMode'] = 'toggle';
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHoldToggle'));
    expect(rowFor('Z')[1]).not.toBe(t('kbd.edgeHold'));
    delete SETTINGS['player.edgeHoldMode'];
  });

  it('X reads as a toggle when the Orgasm Switch is in toggle mode', () => {
    SETTINGS['player.orgasmSwitchMode'] = 'toggle';
    expect(rowFor('X')[1]).toBe(t('kbd.orgasmSwitchToggle'));
    SETTINGS['player.orgasmSwitchMode'] = 'hold';
    expect(rowFor('X')[1]).toBe(t('kbd.orgasmSwitch'));
    delete SETTINGS['player.orgasmSwitchMode'];
  });
});
