/**
 * @vitest-environment jsdom
 *
 * FT-102 re-check (cosmetic, also in v0.9.2; fixed 2026-11-22): Library
 * Select > Assign Script on ONE video said "Extra Two.funscript assigned to 1
 * videos". en / de / es / fr now have an ICU plural; ja / ko / zh have no
 * plural and Russian's "видео" does not change, so those read right as they are.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const say = (l, count) => {
  _setBundlesForTests(l, bundle(l), bundle('en'));
  return t('library.bulkScriptAssigned', { name: 'Extra Two.funscript', count });
};

describe('"assigned to N videos" counts right', () => {
  it.each([
    ['en', 'Extra Two.funscript assigned to 1 video', 'Extra Two.funscript assigned to 3 videos'],
    ['de', 'Extra Two.funscript wurde 1 Video zugewiesen', 'Extra Two.funscript wurde 3 Videos zugewiesen'],
    ['es', 'Extra Two.funscript asignado a 1 vídeo', 'Extra Two.funscript asignado a 3 vídeos'],
    ['fr', 'Extra Two.funscript assigné à 1 vidéo', 'Extra Two.funscript assigné à 3 vidéos'],
  ])('%s', (l, one, three) => {
    expect(say(l, 1)).toBe(one);
    expect(say(l, 3)).toBe(three);
  });

  it.each(['ja', 'ko', 'ru', 'zh'])('%s formats with the count', (l) => {
    expect(say(l, 1)).toContain('1');
    expect(say(l, 1)).not.toContain('{');
  });
});
