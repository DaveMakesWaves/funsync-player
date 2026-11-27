/**
 * @vitest-environment jsdom
 *
 * FT-103 (found by reading, also in v0.9.2; fixed 2026-11-22): the editor
 * pop-out's `?` list never listed the user's custom position keys.
 * keyboard-help.js read them from the settings store, which the pop-out never
 * initialises; its parent already sends them (`customPositionKeys`), so the
 * pop-out now passes them to `getEditorShortcutGroups`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { getEditorShortcutGroups } from '../../renderer/js/keyboard-help.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
_setBundlesForTests('en', EN, EN);
const customGroup = (groups) => groups.find((g) => g.title === EN.editor.customKeysHelpGroup);

describe('the editor ? list and custom position keys', () => {
  it('bindings handed in are listed with their positions', () => {
    const group = customGroup(getEditorShortcutGroups({ customPositionKeys: [
      { code: 'KeyQ', key: 'q', position: 30 },
      { code: 'KeyE', key: 'e', shift: true, position: 85 },
    ] }));
    expect(group).toBeTruthy();
    expect(group.rows.map((r) => r[1])).toEqual(['→ 30', '→ 85']);
  });

  it('none handed in and no store: no group (as before)', () => {
    expect(customGroup(getEditorShortcutGroups())).toBeUndefined();
    expect(customGroup(getEditorShortcutGroups({ customPositionKeys: [] }))).toBeUndefined();
  });

  it('the pop-out keeps what its parent sent and passes it', () => {
    const src = fs.readFileSync('renderer/editor-popout.js', 'utf8');
    expect(src).toMatch(/getEditorShortcutGroups\(\{ customPositionKeys \}\)/);
    expect(src.match(/customPositionKeys = m\.customPositionKeys;/g)).toHaveLength(2);
  });
});
