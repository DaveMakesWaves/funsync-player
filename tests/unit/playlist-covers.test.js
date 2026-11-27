/**
 * @vitest-environment jsdom
 * jsdom: the real Playlists component builds its cards as DOM, and
 * i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 *
 * Playlist cover images (Dave, 2026-08-06: "Make it POSSIBLE to set a cover
 * image per playlist; explicitly do NOT auto-assign one"; built 2026-11-23).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { Playlists } from '../../renderer/components/playlists.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const PL = { id: 'p1', name: 'Favourites', videoPaths: ['C:\\V\\a.mp4', 'C:\\V\\b.mp4'] };
const tick = () => new Promise((r) => setTimeout(r, 0));

function view(store = {}) {
  const v = Object.create(Playlists.prototype);
  v._settings = { get: (k) => store[k], set: vi.fn((k, val) => { store[k] = val; }), deletePlaylist: vi.fn() };
  v._renderGrid = vi.fn();
  v._summariseProgress = () => ({ watched: 0, inProgress: 0, total: 2, remainingSeconds: 0 });
  v._showResumeProgress = () => true;
  v._playlistHasProgress = () => false;
  return { v, store };
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
  window.funsync = {};
});

describe('a playlist with no cover', () => {
  it('looks as it always did: no picture, never one taken from its videos; only "Set a cover image"', () => {
    const { v } = view();
    const card = v._createPlaylistCard(PL);
    expect(card.querySelector('.playlists__card-cover')).toBeNull();
    expect(card.classList.contains('playlists__card--cover')).toBe(false);
    expect(card.querySelector('.playlists__cover-set').title).toBe(EN.playlists.coverSet);
    expect(card.querySelector('.playlists__cover-remove')).toBeNull();
  });
});

describe('a grid where some have covers', () => {
  it('the rest keep the picture\'s room with a plain plate (never a picture of their own); no covers anywhere: no plates', () => {
    const { v } = view();
    const plate = v._createPlaylistCard(PL, { coverSlot: true }).querySelector('.playlists__card-cover--empty');
    expect(plate).not.toBeNull();
    expect(plate.querySelector('img')).toBeNull();
    expect(plate.getAttribute('aria-hidden')).toBe('true');
    expect(v._createPlaylistCard(PL).querySelector('.playlists__card-cover')).toBeNull();
    const src = fs.readFileSync('renderer/components/playlists.js', 'utf8');
    expect(src).toMatch(/const coverSlot = playlists\.some\(\(pl\) => covers\[pl\.id\]\?\.imagePath\);/);
  });
});

describe('setting one', () => {
  it('pick an image, it is imported like a video poster (keyed by the playlist), saved, the grid redrawn', async () => {
    const { v, store } = view();
    window.funsync.selectThumbnailImage = vi.fn(async () => ({ path: 'C:\\Pics\\cover.png' }));
    window.funsync.importCustomThumbnail = vi.fn(async () => ({ path: 'C:\\UD\\custom-thumbs\\abc.jpg', dataUrl: 'data:image/jpeg;base64,AA' }));
    await v._setCover(PL);
    expect(window.funsync.importCustomThumbnail).toHaveBeenCalledWith('playlist:p1', 'C:\\Pics\\cover.png');
    expect(store['library.playlistCovers']).toEqual({ p1: { imagePath: 'C:\\UD\\custom-thumbs\\abc.jpg' } });
    expect(v._renderGrid).toHaveBeenCalled();
    // The redrawn card shows it at once (the import's own picture, no read).
    window.funsync.readCustomThumbnail = vi.fn();
    const card = v._createPlaylistCard(PL);
    expect(card.querySelector('.playlists__card-cover img').src).toBe('data:image/jpeg;base64,AA');
    expect(window.funsync.readCustomThumbnail).not.toHaveBeenCalled();
    expect(card.querySelector('.playlists__cover-remove').title).toBe(EN.playlists.coverRemove);
  });

  it('cancelled: nothing changes; an image that cannot be used: nothing saved', async () => {
    const { v, store } = view();
    window.funsync.selectThumbnailImage = vi.fn(async () => null);
    window.funsync.importCustomThumbnail = vi.fn();
    await v._setCover(PL);
    expect(window.funsync.importCustomThumbnail).not.toHaveBeenCalled();
    window.funsync.selectThumbnailImage = vi.fn(async () => ({ path: 'C:\\Pics\\broken.xyz' }));
    window.funsync.importCustomThumbnail = vi.fn(async () => null);
    await v._setCover(PL);
    expect(store['library.playlistCovers']).toBeUndefined();
  });
});

describe('showing and removing it', () => {
  it('read from the thumbnail cache when the grid opens; a file that is gone shows nothing, not a broken picture', async () => {
    const { v } = view({ 'library.playlistCovers': { p1: { imagePath: 'C:\\UD\\custom-thumbs\\abc.jpg' } } });
    window.funsync.readCustomThumbnail = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,BB' }));
    const card = v._createPlaylistCard(PL);
    await tick();
    expect(window.funsync.readCustomThumbnail).toHaveBeenCalledWith('C:\\UD\\custom-thumbs\\abc.jpg');
    expect(card.querySelector('.playlists__card-cover img').src).toBe('data:image/jpeg;base64,BB');

    const { v: v2 } = view({ 'library.playlistCovers': { p1: { imagePath: 'C:\\UD\\custom-thumbs\\gone.jpg' } } });
    window.funsync.readCustomThumbnail = vi.fn(async () => null);
    const card2 = v2._createPlaylistCard(PL);
    await tick();
    expect(card2.querySelector('.playlists__card-cover').hidden).toBe(true);
  });

  it('the list view has it too (a small picture, the same buttons)', () => {
    const { v } = view({ 'library.playlistCovers': { p1: { imagePath: 'x.jpg' } } });
    v._coverCache = new Map([['x.jpg', 'data:image/jpeg;base64,CC']]);
    const row = v._createPlaylistListItem(PL);
    expect(row.querySelector('.playlists__list-cover img').src).toBe('data:image/jpeg;base64,CC');
    expect(row.querySelector('.playlists__cover-set')).not.toBeNull();
    expect(row.querySelector('.playlists__cover-remove')).not.toBeNull();
  });

  it('Remove takes only that playlist\'s cover; deleting a playlist forgets its cover', () => {
    const { v, store } = view({ 'library.playlistCovers': { p1: { imagePath: 'a.jpg' }, p2: { imagePath: 'b.jpg' } } });
    v._removeCover(PL);
    expect(store['library.playlistCovers']).toEqual({ p2: { imagePath: 'b.jpg' } });
    expect(v._renderGrid).toHaveBeenCalled();
    expect(v._forgetCover('p2')).toBe(true);
    expect(v._forgetCover('p2')).toBe(false); // nothing left to forget
    const src = fs.readFileSync('renderer/components/playlists.js', 'utf8');
    expect(src).toMatch(/this\._settings\.deletePlaylist\(pl\.id\);\s+this\._forgetCover\?\.\(pl\.id\);/);
  });

  it('the setting has a real default in electron/store.js', () => {
    expect(fs.readFileSync('electron/store.js', 'utf8')).toMatch(/playlistCovers: \{\},/);
  });
});
