/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL `?` overlay (keyboard-help.js through the REAL
 * Modal) is rendered into the document and read back as the user sees it.
 */
// CB-08: the `?` overlay's chord column was literal English in every
// locale, so a German overlay mixed "Ctrl" (built-in rows) with "Strg" (the
// custom position-key rows, which FT-014 already translated). The built-in
// chords now render through the same `keys.*` names. The data rows stay in
// canonical English (keyboard-shortcut-clash.test.js parses them).
//
// Also CB-04: the editor's zoom row said "+ / -", but bare - places a point
// at 100; it is "+ / Ctrl+-" now.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { openKeyboardHelp, getPlayerShortcutGroups, getEditorShortcutGroups, localizeChordPart } =
  await import('../../renderer/js/keyboard-help.js');
const { formatBindingLabel } = await import('../../renderer/components/key-capture.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

/** Every <kbd> chip of the open overlay, in order. */
const chips = () => [...document.querySelectorAll('.editor-help__keys kbd')].map((k) => k.textContent);
/** The chips of the row whose description is `desc`. */
const rowChips = (desc) => {
  const dd = [...document.querySelectorAll('.editor-help__desc')].find((d) => d.textContent === desc);
  return dd ? [...dd.previousElementSibling.querySelectorAll('kbd')].map((k) => k.textContent) : null;
};

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  _setBundlesForTests('en', EN, EN);
});

describe('the `?` overlay in German says Strg, not Ctrl (CB-08)', () => {
  it('editor list: no built-in chip says Ctrl, Shift, Del, Home or Space; they read like Settings', () => {
    _setBundlesForTests('de', DE, EN);
    openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups());
    const all = chips();
    expect(all.length).toBeGreaterThan(30);
    for (const word of ['Ctrl', 'Shift', 'Del', 'Backspace', 'Home', 'Up', 'Left']) {
      expect(all.filter((c) => new RegExp(`(^|\\+)${word}(\\+|$)`).test(c)), word).toEqual([]);
    }
    expect(rowChips(DE.kbd.editorUndo)).toEqual([`${DE.keys.ctrl}+Z`]);
    expect(rowChips(DE.kbd.editorNudgeFine)).toEqual([`${DE.keys.ctrl}+${DE.keys.shift}+${DE.keys.arrowUp}`, DE.keys.arrowDown]);
    expect(rowChips(DE.kbd.editorDelete)).toEqual([DE.keys.delete, DE.keys.backspace]);
    expect(rowChips(DE.kbd.editorRepeatLastStroke)).toEqual([DE.keys.home]);
    expect(rowChips(DE.kbd.editorSelectThird)).toEqual([`${DE.keys.ctrl}+1`, '2', '3']);
  });

  it('player list: Space, Esc, Home / End and the modifiers in German', () => {
    _setBundlesForTests('de', DE, EN);
    openKeyboardHelp(t('kbd.playerTitle'), getPlayerShortcutGroups());
    expect(rowChips(DE.kbd.playPause)).toEqual([DE.keys.space, 'K']);
    expect(rowChips(DE.kbd.jumpStartEnd)).toEqual([DE.keys.home, DE.keys.end]);
    expect(rowChips(DE.kbd.clearLoop)).toEqual([DE.keys.escape]);
    expect(rowChips(DE.kbd.library)).toEqual(['Alt+1']);
    expect(rowChips(DE.kbd.nextBookmark)).toEqual([`${DE.keys.ctrl}+B`]);
    expect(chips().some((c) => /(^|\+)Ctrl(\+|$)/.test(c))).toBe(false);
  });

  it('a built-in row and a custom position-key row use the same words', () => {
    _setBundlesForTests('de', DE, EN);
    // The custom rows come from formatBindingLabel (FT-014); the built-in
    // chords must match it word for word.
    expect(localizeChordPart('Ctrl+Shift+P')).toBe(formatBindingLabel({ code: 'KeyP', mods: { ctrl: true, shift: true } }));
    expect(localizeChordPart('Ctrl+Alt+Left')).toBe(formatBindingLabel({ code: 'ArrowLeft', mods: { ctrl: true, alt: true } }));
    expect(localizeChordPart('Del')).toBe(formatBindingLabel({ code: 'Delete', mods: {} }));
  });

  it('English is unchanged for the modifiers and letters; named keys use the Settings names', () => {
    _setBundlesForTests('en', EN, EN);
    openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups());
    expect(rowChips(EN.kbd.editorUndo)).toEqual(['Ctrl+Z']);
    expect(rowChips(EN.kbd.editorRedo)).toEqual(['Ctrl+Y', 'Ctrl+Shift+Z']);
    expect(rowChips(EN.kbd.editorDelete)).toEqual([EN.keys.delete, EN.keys.backspace]);
  });

  it('with no bundle at all (the editor pop-out has no i18n yet) a chord reads as written', () => {
    _setBundlesForTests('en', {}, {});
    expect(localizeChordPart('Ctrl+Shift+Left')).toBe('Ctrl+Shift+Left');
    expect(localizeChordPart('Del')).toBe('Del');
    expect(localizeChordPart('+')).toBe('+');
    expect(localizeChordPart('Ctrl+-')).toBe('Ctrl+-');
  });

  it('the mouse half of a chord goes through keys.* too (Scroll, Click, a point drag, Arrows)', () => {
    const DEX = structuredClone(DE);
    DEX.keys = { ...DEX.keys, scroll: 'Mausrad', click: 'Klick', dragPoint: 'Punkt ziehen', arrows: 'Pfeiltasten' };
    _setBundlesForTests('de', DEX, EN);
    expect(localizeChordPart('Ctrl+Scroll')).toBe('Strg+Mausrad');
    expect(localizeChordPart('Alt+Click')).toBe('Alt+Klick');
    expect(localizeChordPart('Shift+Drag dot')).toBe('Umschalt+Punkt ziehen');
    expect(localizeChordPart('Shift+Arrows')).toBe('Umschalt+Pfeiltasten');
  });
});

// R3-25 (found verifying CB-08): the numpad rows still read "Numpad 0 – 9"
// and "Numpad-" in every language; there was no `keys.numpad`. The custom
// position-key rows (formatBindingLabel) said "Numpad5" too.
describe('the `?` overlay names the numpad in the active language (R3-25)', () => {
  const LOCALES = ['de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
  const BUNDLES = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));

  it('German: the place rows read Ziffernblock, word for word what Settings writes', () => {
    _setBundlesForTests('de', DE, EN);
    openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups());
    expect(rowChips(DE.kbd.editorPlaceNumpad)).toEqual(['0 – 9', 'Ziffernblock 0 – 9']);
    expect(rowChips(DE.kbd.editorPlaceTop)).toEqual([`${DE.keys.shift}+0`, '-', 'Ziffernblock -']);
    // A custom row bound to the numpad uses the same word.
    expect(formatBindingLabel({ code: 'NumpadSubtract', mods: {} })).toBe('Ziffernblock -');
  });

  it.each(LOCALES)('%s: no chip says the English "Numpad"', (l) => {
    _setBundlesForTests(l, BUNDLES[l], EN);
    openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups());
    const all = chips();
    expect(all.filter((c) => /Numpad/.test(c))).toEqual([]);
    // ...and the numpad is still named: the row has two alternatives.
    expect(rowChips(BUNDLES[l].kbd.editorPlaceNumpad)).toHaveLength(2);
    expect(rowChips(BUNDLES[l].kbd.editorPlaceNumpad)[1]).toContain('0 – 9');
  });

  it('English is unchanged: "Numpad 0 – 9" and "Numpad-"', () => {
    _setBundlesForTests('en', EN, EN);
    openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups());
    expect(rowChips(EN.kbd.editorPlaceNumpad)).toEqual(['0 – 9', 'Numpad 0 – 9']);
    expect(rowChips(EN.kbd.editorPlaceTop)).toEqual(['Shift+0', '-', 'Numpad-']);
  });

  it('with no bundle the numpad chord reads as written', () => {
    _setBundlesForTests('en', {}, {});
    expect(localizeChordPart('Numpad-')).toBe('Numpad-');
    expect(localizeChordPart('Numpad 0 – 9')).toBe('Numpad 0 – 9');
  });
});

describe('the editor\'s zoom row names Ctrl+- for zoom out (CB-04)', () => {
  it('reads "+ / Ctrl+-", not "+ / -" (bare - places a point at 100)', () => {
    _setBundlesForTests('en', EN, EN);
    openKeyboardHelp(t('editor.keyboardHelpTitle'), getEditorShortcutGroups());
    expect(rowChips(EN.kbd.editorZoom)).toEqual(['+', 'Ctrl+-']);
  });
});
