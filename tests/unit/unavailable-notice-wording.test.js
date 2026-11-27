/**
 * @vitest-environment jsdom
 * jsdom: the notices are built as DOM; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Test day 2026-11-26, Dave: "fix those 3".
// S028: a playlist's unavailable banner counted a script entry as a video
//   (2 videos and 1 script: "3 videos on C: are unavailable").
// S030: the banners always said "Reconnect the drive", also when the drive is
//   there and the file was renamed or moved. When every missing file's folder
//   answers a definite yes, they now say the file is not where it was.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { Playlists } = await import('../../renderer/components/playlists.js');
const { Categories } = await import('../../renderer/components/categories.js');
const { foldersPresent, parentFolder } = await import('../../renderer/js/playlist-availability.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

const V1 = 'C:\\Lib\\Bravo.mp4';
const V2 = 'C:\\Lib\\Zulu.mp4';
const S1 = 'C:\\Lib\\Queue Test Script.funscript';

beforeEach(() => { _setBundlesForTests('en', EN, EN); });
afterEach(() => { delete window.funsync; });

function playlistNotice(paths, filesExist) {
  window.funsync = { filesExist: vi.fn(filesExist || (async (list) => list.map(() => false))) };
  const ctx = {};
  const notice = Playlists.prototype._createUnavailableNotice.call(ctx, paths);
  return { notice, ctx, text: () => notice.querySelector('span').textContent, hint: () => notice.querySelector('.playlists__unavailable-hint').textContent };
}

describe('what a playlist\'s unavailable banner counts (S028)', () => {
  it('videos only: "videos", as before', () => {
    expect(playlistNotice([V1, V2]).text()).toBe('2 videos on C: are unavailable');
  });
  it('a script only: "script"', () => {
    expect(playlistNotice([S1]).text()).toBe('1 script on C: is unavailable');
  });
  it('videos and a script: "entries", not "3 videos"', () => {
    expect(playlistNotice([V1, S1, V2]).text()).toBe('3 entries on C: are unavailable');
  });
  it('in German too', () => {
    _setBundlesForTests('de', DE, EN);
    expect(playlistNotice([V1, S1, V2]).text()).toBe('3 Einträge auf C: sind nicht verfügbar');
    expect(playlistNotice([S1]).text()).toBe('1 Skript auf C: ist nicht verfügbar');
  });
});

describe('drive gone or file moved (S030)', () => {
  it('the folder is not there (the drive is gone): "Reconnect the drive", the unplug mark', async () => {
    const n = playlistNotice([V1], async (list) => list.map(() => false));
    expect(await n.ctx._unavailableHintCheck).toBe(false);
    expect(n.hint()).toBe(EN.playlists.unavailableHint.replace(/\{count, plural, one \{([^}]*)\} other \{[^}]*\}\}/g, '$1'));
  });

  it('every folder there: "not where it was: renamed, moved or deleted?", and the drive is never mentioned', async () => {
    const n = playlistNotice([V1, S1], async (list) => list.map(() => true));
    expect(await n.ctx._unavailableHintCheck).toBe(true);
    expect(n.hint()).toBe("They aren't where they were: renamed, moved or deleted? They stay in the playlist.");
    expect(n.hint()).not.toMatch(/drive/i);
    expect(window.funsync.filesExist).toHaveBeenCalledWith(['C:\\Lib']);
  });

  it('a category says the same', async () => {
    window.funsync = { filesExist: vi.fn(async (list) => list.map(() => true)) };
    const ctx = {};
    const notice = Categories.prototype._createUnavailableNotice.call(ctx, [V1]);
    expect(await ctx._unavailableHintCheck).toBe(true);
    expect(notice.querySelector('.categories__unavailable-hint').textContent)
      .toBe("It isn't where it was: renamed, moved or deleted? It stays in the category.");
  });
});

describe('foldersPresent: only a definite yes for every folder (S030)', () => {
  const api = (answers) => ({ filesExist: vi.fn(async (list) => list.map((d) => answers[d])) });
  it('all yes: true; one no, one unknown (timed out), or a throw: false', async () => {
    expect(await foldersPresent([V1, 'D:\\X\\a.mp4'], api({ 'C:\\Lib': true, 'D:\\X': true }))).toBe(true);
    expect(await foldersPresent([V1, 'D:\\X\\a.mp4'], api({ 'C:\\Lib': true, 'D:\\X': false }))).toBe(false);
    expect(await foldersPresent([V1], api({ 'C:\\Lib': null }))).toBe(false);
    expect(await foldersPresent([V1], { filesExist: async () => { throw new Error('ipc'); } })).toBe(false);
    expect(await foldersPresent([V1], {})).toBe(false);
  });
  it('a saved stream is no file: left out; nothing to ask: false', async () => {
    const a = api({});
    expect(await foldersPresent(['stream:example.com/x'], a)).toBe(false);
    expect(a.filesExist).not.toHaveBeenCalled();
  });
  it('parentFolder', () => {
    expect(parentFolder('C:\\Lib\\a.mp4')).toBe('C:\\Lib');
    expect(parentFolder('C:\\a.mp4')).toBe('C:\\');
    expect(parentFolder('/mnt/usb/a.mp4')).toBe('/mnt/usb');
    expect(parentFolder('/a.mp4')).toBe('/');
    expect(parentFolder('\\\\nas\\share\\a.mp4')).toBe('\\\\nas\\share');
    expect(parentFolder('a.mp4')).toBe('');
  });
});
