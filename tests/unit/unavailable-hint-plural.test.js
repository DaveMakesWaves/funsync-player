/**
 * @vitest-environment jsdom
 * jsdom on purpose: the notices are DOM, and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// A category or playlist with videos on a drive that is not there (test day
// 2026-11-24, B028): with ONE such video it read "1 video on C: is
// unavailable. Reconnect the drive to play them. They stay in the category."
// The hint follows the count now, in every language whose pronoun has a
// number. Driven through the REAL notice builders.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { Categories } from '../../renderer/components/categories.js';
import { Playlists } from '../../renderer/components/playlists.js';

const load = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = load('en');
afterAll(() => _setBundlesForTests('en', EN, EN));

const paths = (n) => Array.from({ length: n }, (_, i) => `E:\\Videos\\Clip ${i + 1}.mp4`);
const hintOf = (Cls, n) => {
  const notice = Cls.prototype._createUnavailableNotice.call({}, paths(n));
  return notice.querySelector('[class$="__unavailable-hint"]').textContent;
};

describe('the unavailable notice\'s hint follows the count (B028)', () => {
  it('en, a category: one video, then two', () => {
    _setBundlesForTests('en', EN, EN);
    expect(hintOf(Categories, 1)).toBe('Reconnect the drive to play it. It stays in the category.');
    expect(hintOf(Categories, 2)).toBe('Reconnect the drive to play them. They stay in the category.');
  });

  it('en, a playlist: one video, then two', () => {
    _setBundlesForTests('en', EN, EN);
    expect(hintOf(Playlists, 1)).toBe('Reconnect the drive to play it. It stays in the playlist.');
    expect(hintOf(Playlists, 2)).toBe('Reconnect the drive to play them. They stay in the playlist.');
  });

  it.each([
    ['de', 'es abzuspielen. Es bleibt', 'sie abzuspielen. Sie bleiben'],
    ['fr', 'pour la lire. Elle reste', 'pour les lire. Elles restent'],
    ['es', 'para reproducirlo. Sigue', 'para reproducirlos. Siguen'],
    ['ru', 'воспроизвести его. Оно остаётся', 'воспроизвести их. Они остаются'],
    ['zh', '它仍保留', '它们仍保留'],
  ])('%s: both notices, one video then two', (loc, one, several) => {
    _setBundlesForTests(loc, load(loc), EN);
    for (const Cls of [Categories, Playlists]) {
      expect(hintOf(Cls, 1)).toContain(one);
      expect(hintOf(Cls, 2)).toContain(several);
    }
  });

  it('ru: 21 videos take the plural (Russian\'s "one" category holds 21)', () => {
    _setBundlesForTests('ru', load('ru'), EN);
    expect(hintOf(Categories, 21)).toContain('воспроизвести их. Они остаются');
  });
});
