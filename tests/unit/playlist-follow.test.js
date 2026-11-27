/**
 * @vitest-environment jsdom
 * jsdom: the REAL DataService (window.funsync from tests/setup.js) and the
 * REAL follow dialog on the REAL Modal.
 */
// Following playlists (zaikechi #381, 2026-11-23: "sync a playlist with a
// library/Category/Folder"): renderer/js/playlist-follow.js (what a rule
// matches; adds only; a category unassign is the one removal), the
// DataService keeping what the user took out by hand (excludedPaths), and
// the Follow… dialog (a cancel never reads as "follow nothing").
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { ruleMembers, planFollowAdds, planCategoryUnassign, isUnderFolder, describeRule } from '../../renderer/js/playlist-follow.js';
import { DataService } from '../../renderer/js/data-service.js';
import { openPlaylistFollowDialog } from '../../renderer/components/playlist-follow-dialog.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const V = (path, name) => ({ path, name: name || path.split('\\').pop() });
const videos = [
  V('D:\\Lib\\b clip.mp4'), V('D:\\Lib\\Sub\\A clip.mp4'), V('D:\\Lib\\Sub\\c clip.mp4'), V('E:\\Other\\x.mp4'),
  { path: 'stream:example.com/v', name: 'Stream', _stream: true },
];
const cats = { 'D:\\Lib\\b clip.mp4': ['c1'], 'E:\\Other\\x.mp4': ['c1', 'c2'] };
const ctx = { videos, sources: [{ id: 's1', path: 'D:\\Lib' }], getVideoCategories: (p) => cats[p] || [] };

describe('playlist-follow.js', () => {
  it('a folder rule: everything under it, without case or slash style, never a sibling with the same prefix', () => {
    expect(isUnderFolder('d:/lib/sub/a.mp4', 'D:\\Lib\\')).toBe(true);
    expect(isUnderFolder('D:\\Library\\a.mp4', 'D:\\Lib')).toBe(false);
    expect(ruleMembers({ kind: 'folder', folderPath: 'd:/lib/sub' }, ctx)).toEqual(['D:\\Lib\\Sub\\A clip.mp4', 'D:\\Lib\\Sub\\c clip.mp4']);
  });

  it('a source rule follows the source path; a category rule its videos; streams never; name order', () => {
    expect(ruleMembers({ kind: 'source', sourceId: 's1' }, ctx)).toEqual(['D:\\Lib\\Sub\\A clip.mp4', 'D:\\Lib\\b clip.mp4', 'D:\\Lib\\Sub\\c clip.mp4']);
    expect(ruleMembers({ kind: 'source', sourceId: 'gone' }, ctx)).toEqual([]);
    expect(ruleMembers({ kind: 'category', categoryId: 'c1' }, ctx)).toEqual(['D:\\Lib\\b clip.mp4', 'E:\\Other\\x.mp4']);
  });

  it('adds what the rule matches and the playlist lacks, never what was taken out by hand', () => {
    const pl = { id: 'p', follow: { kind: 'category', categoryId: 'c1' }, videoPaths: ['E:\\Other\\x.mp4'], excludedPaths: [] };
    expect(planFollowAdds(pl, ctx)).toEqual({ playlistId: 'p', add: ['D:\\Lib\\b clip.mp4'] });
    expect(planFollowAdds({ ...pl, excludedPaths: ['D:\\Lib\\b clip.mp4'] }, ctx)).toBeNull();
  });

  it('nothing before the library is scanned, and nothing for a playlist that follows nothing', () => {
    const pl = { id: 'p', follow: { kind: 'source', sourceId: 's1' }, videoPaths: [] };
    expect(planFollowAdds(pl, { ...ctx, videos: [] })).toBeNull();
    expect(planFollowAdds({ id: 'q', videoPaths: [] }, ctx)).toBeNull();
  });

  it('a category unassign takes the video out of playlists following THAT category only', () => {
    const pls = [
      { id: 'a', follow: { kind: 'category', categoryId: 'c1' }, videoPaths: ['X'] },
      { id: 'b', follow: { kind: 'category', categoryId: 'c2' }, videoPaths: ['X'] },
      { id: 'c', videoPaths: ['X'] },
    ];
    expect(planCategoryUnassign(pls, 'c1', 'X')).toEqual([{ playlistId: 'a', remove: ['X'] }]);
  });

  it('describeRule names the rule, or says null for a deleted category', () => {
    expect(describeRule({ kind: 'category', categoryId: 'c1' }, { categories: [{ id: 'c1', name: 'Hot' }] })).toEqual({ kind: 'category', name: 'Hot' });
    expect(describeRule({ kind: 'category', categoryId: 'zz' }, { categories: [] })).toEqual({ kind: 'category', name: null });
  });
});

describe('DataService: what the user takes out of a following playlist stays out', () => {
  let ds;
  beforeEach(() => {
    window.funsync.setPlaylistExcluded = vi.fn();
    ds = new DataService();
    ds._cache = { playlists: [
      { id: 'f', name: 'F', follow: { kind: 'category', categoryId: 'c1' }, videoPaths: ['A', 'B'] },
      { id: 'n', name: 'N', videoPaths: ['A'] },
    ] };
  });

  it('a hand removal is remembered; a hand add clears it; a plain playlist keeps nothing', () => {
    ds.removeVideoFromPlaylist('f', 'A');
    expect(ds.getPlaylist('f').excludedPaths).toEqual(['A']);
    ds.addVideoToPlaylist('f', 'A');
    expect(ds.getPlaylist('f').excludedPaths).toBeUndefined();
    ds.removeVideoFromPlaylist('n', 'A');
    expect(ds.getPlaylist('n').excludedPaths).toBeUndefined();
  });

  it("the rule's own removal (a category unassign) is not the user's: nothing remembered", () => {
    ds.removeVideosFromPlaylist('f', ['B'], { byRule: true });
    expect(ds.getPlaylist('f').videoPaths).toEqual(['A']);
    expect(ds.getPlaylist('f').excludedPaths).toBeUndefined();
  });
});

describe('the Follow… dialog', () => {
  beforeEach(() => { document.body.innerHTML = ''; _setBundlesForTests('en', EN, EN); });
  const frame = () => new Promise((r) => setTimeout(r, 30));
  const open = (follow) => openPlaylistFollowDialog({
    playlist: { id: 'p', name: 'Mix', follow },
    categories: [{ id: 'c1', name: 'Hot' }, { id: 'c2', name: 'Slow' }],
    sources: [{ id: 's1', name: 'Main', path: 'D:\\Lib' }],
    pickFolder: async () => 'E:\\Picked',
  });
  const save = () => document.querySelector('.playlist-follow__save');

  it('opens on the current rule; choosing in a list picks its option; Save gives the rule', async () => {
    const p = open({ kind: 'category', categoryId: 'c2' });
    await frame();
    expect(document.querySelector('input[value="category"]').checked).toBe(true);
    expect(document.querySelector('.playlist-follow__select').value).toBe('c2');
    const src = document.querySelectorAll('.playlist-follow__select')[1];
    src.value = 's1'; src.dispatchEvent(new Event('change'));
    expect(document.querySelector('input[value="source"]').checked).toBe(true);
    save().click();
    expect(await p).toEqual({ follow: { kind: 'source', sourceId: 's1' } });
  });

  it('Another folder: Save stays off until a folder is picked', async () => {
    const p = open(null);
    await frame();
    const folder = document.querySelector('input[value="folder"]');
    folder.checked = true; folder.dispatchEvent(new Event('change', { bubbles: true }));
    expect(save().disabled).toBe(true);
    document.querySelector('.playlist-follow__browse').click();
    await frame();
    expect(save().disabled).toBe(false);
    save().click();
    expect(await p).toEqual({ follow: { kind: 'folder', folderPath: 'E:\\Picked' } });
  });

  it('"Nothing" saves { follow: null }; Escape is a cancel (null), never "follow nothing"', async () => {
    const p = open({ kind: 'category', categoryId: 'c1' });
    await frame();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p).toBeNull();
    const p2 = open({ kind: 'category', categoryId: 'c1' });
    await frame();
    const none = document.querySelector('input[value="none"]');
    none.checked = true; none.dispatchEvent(new Event('change', { bubbles: true }));
    save().click();
    expect(await p2).toEqual({ follow: null });
  });
});
