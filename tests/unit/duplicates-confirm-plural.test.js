/**
 * @vitest-environment jsdom
 * jsdom on purpose: i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// Find Duplicates' "Move to Recycle Bin?" question (test day 2026-11-24,
// B025): with one file ticked it read "Move 1 file (132 KB) to the Recycle
// Bin? You can get them back from there". The pronoun follows the count in
// every locale whose pronoun has a number (en it/them, fr le/les, es
// recuperarlo/recuperarlos, ru Его/Их); de "sie" and ja/ko/zh need none.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';

const load = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = load('en');
const body = (locale, count) => {
  _setBundlesForTests(locale, load(locale), EN);
  return t('settingsPanel.duplicates.confirmBody', { count, size: '1 KB', os: 'win' });
};

describe('Find Duplicates: the move question\'s pronoun follows the count (B025)', () => {
  it.each([
    ['en', 'You can get it back', 'You can get them back'],
    ['fr', 'Vous pourrez le récupérer', 'Vous pourrez les récupérer'],
    ['es', 'Podrás recuperarlo desde', 'Podrás recuperarlos desde'],
    ['ru', 'Его можно будет вернуть', 'Их можно будет вернуть'],
  ])('%s: one file, then several', (locale, one, several) => {
    expect(body(locale, 1)).toContain(one);
    expect(body(locale, 3)).toContain(several);
  });

  it('ru: 21 files take the plural pronoun too (Russian\'s "one" category holds 21, 31 ...)', () => {
    expect(body('ru', 21)).toContain('Их можно будет вернуть');
  });

  it('en reads whole for one file', () => {
    expect(body('en', 1)).toBe('Move 1 file (1 KB) to the Recycle Bin? You can get it back from there if you change your mind. The copy marked Keep in each group is not touched.');
  });
});
