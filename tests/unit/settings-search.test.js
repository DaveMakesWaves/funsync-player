/**
 * @vitest-environment node
 * Pure matcher, no DOM. See notes/CLAUDE.md "Test environments".
 *
 * Settings search (2026-11-23, Dave: "we need to be forgiving with the
 * search so that if people don't know the name but know what it refers to
 * it still appears"): renderer/js/settings-search.js.
 */
import { describe, it, expect } from 'vitest';
import { normalizeText, words, editDistance, findWord, scoreRow, searchRows } from '../../renderer/js/settings-search.js';

describe('reading text', () => {
  it('case, accents and punctuation never matter', () => {
    expect(normalizeText('Thème — “Sombre”!')).toBe('theme sombre');
    expect(normalizeText('Gap-Filler: 10s')).toBe('gap filler 10s');
    expect(words('  Hide  file names ')).toEqual(['hide', 'file', 'names']);
    expect(words('')).toEqual([]);
  });

  it('a slip is one letter wrong, missing, extra or two swapped', () => {
    expect(editDistance('fullscreen', 'fulscreen')).toBe(1);
    expect(editDistance('hotkey', 'hotkye')).toBe(1);
    expect(editDistance('notifications', 'notifcations')).toBe(1);
    expect(editDistance('theme', 'thmee')).toBe(1);
    expect(editDistance('abc', 'xyz', 1)).toBe(2); // gave up past the limit
  });
});

describe('finding one typed word', () => {
  const row = (s) => [words(s), normalizeText(s)];
  // The panel always normalizes what was typed first (scoreRow).
  const find = (q, s) => findWord(normalizeText(q), ...row(s));
  it('whole word, start of a word, a shared stem, inside a word, a slip', () => {
    expect(find('feed', 'feeds and their notifications')).toBe('prefix');
    expect(find('feeds', 'feeds')).toBe('exact');
    expect(find('notifications', 'notify me')).toBe('stem');
    expect(find('colours', 'colour')).toBe('stem');
    expect(find('screen', 'open videos fullscreen')).toBe('inside');
    expect(find('fulscreen', 'open videos fullscreen')).toBe('slip');
    expect(find('fullscr', 'open videos fullscreen')).toBe('prefix');
    expect(find('hotkye', 'global hotkeys')).toBe('stem'); // shares "hotk" with the row's word
    expect(find('hotkyes', 'global hotkeys')).toBe('stem');
    expect(find('fullscreen', 'full stroke range')).toBe(null); // "full" is no stem of it
  });

  it('short words are not stretched: no slips under 4 letters, no inside-match under 3', () => {
    expect(find('vr', 'overlay')).toBe(null);
    expect(find('ux', 'linux')).toBe(null);
    expect(find('cat', 'cut')).toBe(null);
    expect(find('vr', 'vr headset')).toBe('exact');
  });

  it('accents off for Latin and Cyrillic; Japanese voicing marks and Korean syllables kept', () => {
    expect(normalizeText('Ёлка Thème')).toBe('елка theme');
    expect(normalizeText('フィード')).toBe('フィード');
    expect(normalizeText('알림')).toBe('알림');
    expect(find('フィード', 'フィートの通知')).toBe('slip'); // ド is not ト: a near miss, never a clean match
  });

  it('CJK has no spaces: found anywhere at any length', () => {
    expect(find('通知', '有新帖子时通知我')).toBe('inside');
    expect(find('フィード', 'フィードとその通知')).toBe('prefix');
    expect(find('その通知', 'フィードとその通知')).toBe('inside');
  });
});

describe('a row', () => {
  it('every typed word must be found (AND): a second word narrows', () => {
    const r = { label: 'Fill gaps with strokes', section: 'Gap Filler', aliases: 'pattern, idle' };
    expect(scoreRow('gap pattern', r)).not.toBeNull();
    expect(scoreRow('gap fullscreen', r)).toBeNull();
  });

  it('the words people use for a section find its rows (aliases)', () => {
    const r = { label: 'Keep playing while browsing', section: 'Player', aliases: 'mini player, picture in picture, pip' };
    expect(scoreRow('picture in picture', r)).not.toBeNull();
    expect(scoreRow('pip', r)).not.toBeNull();
  });

  it('a match on the row itself outscores one on its section', () => {
    const own = scoreRow('fullscreen', { label: 'Open videos fullscreen', section: 'Player' });
    const viaSection = scoreRow('fullscreen', { label: 'Remember playback speed', section: 'Player', aliases: 'fullscreen' });
    expect(own.score).toBeGreaterThan(viaSection.score);
  });

  it('an empty query matches nothing', () => {
    expect(scoreRow('   ', { label: 'x' })).toBeNull();
  });
});

describe('the result list', () => {
  const rows = [
    { id: 'fs', label: 'Open videos fullscreen' },
    { id: 'full', label: 'Full stroke range' },
    { id: 'feeds', label: 'Feeds and their notifications', aliases: 'feed, notify, bell' },
  ];
  it('keeps the panel order', () => {
    expect(searchRows('f', rows).map((h) => h.row.id)).toEqual(['fs', 'full', 'feeds']);
  });

  it('near misses (slips) are dropped when something matched cleanly, kept when nothing did', () => {
    // "fullscreen" matches 'fs' cleanly; nothing else is padded in.
    expect(searchRows('fullscreen', rows).map((h) => h.row.id)).toEqual(['fs']);
    // A typo alone: the slip is all there is, so it shows.
    expect(searchRows('fulscreen', rows).map((h) => h.row.id)).toEqual(['fs']);
    expect(searchRows('notifcations', rows).map((h) => h.row.id)).toEqual(['feeds']);
  });

  it('nothing found: an empty list', () => {
    expect(searchRows('xyzzy', rows)).toEqual([]);
  });
});
