// The ? overlay's Z row reads Edge Hold's SHARED choice (pattern settings
// unification, 2026-11-19): player.edgePatternChoice when it is there, else
// the old player.edgePattern, as app.js plays it (pattern-choice.js).
//
// jsdom (no docblock): keyboard-help.js imports i18n.js, which branches on
// `typeof window` (notes/CLAUDE.md "Test environments").
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

const SETTINGS = vi.hoisted(() => ({}));
vi.mock('../../renderer/js/data-service.js', () => ({
  dataService: { get: (key) => SETTINGS[key], set: (key, v) => { SETTINGS[key] = v; } },
}));

import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { getPlayerShortcutGroups } from '../../renderer/js/keyboard-help.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const rowFor = (key) => getPlayerShortcutGroups().flatMap((g) => g.rows).find(([keys]) => keys === key);

beforeEach(() => {
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  _setBundlesForTests('en', EN, EN);
});

describe("the ? overlay's Z row follows the shared Edge Hold choice", () => {
  it('a pattern chosen in the new block (a simple shape too) says Z plays it', () => {
    SETTINGS['player.edgeHoldAction'] = 'pattern';
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHold'));
    SETTINGS['player.edgePatternChoice'] = { id: 'shape-sine', speed: 60 };
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHoldPattern'));
  });

  it('the new key wins over the old one: none chosen there means Z stops, whatever edgePattern holds', () => {
    SETTINGS['player.edgeHoldAction'] = 'pattern';
    SETTINGS['player.edgePattern'] = { id: 'slow-tip-strokes' };
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHoldPattern'));   // derived from the old key while the new one is absent
    SETTINGS['player.edgePatternChoice'] = { id: null };
    expect(rowFor('Z')[1]).toBe(t('kbd.edgeHold'));
  });
});
