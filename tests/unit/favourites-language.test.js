// Test day 2026-11-24, B008: on a first launch the Favourites playlist is
// made before the language prompt is answered, so a German user's
// "Favoriten" read "Favourites". The renderer asks main again with the new
// language's name; main renames it only from one built-in name to another
// (favourites-store.test.js), and the renderer's cache and listeners follow.
// jsdom: data-service reads window.funsync.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';

describe('the Favourites playlist follows the language (renderer, B008)', () => {
  let ds;
  beforeEach(() => {
    ds = new DataService();
    ds._cache = { playlists: [{ id: 'favourites', name: 'Favourites', videoPaths: [], system: 'favourites' }] };
  });

  it('a new language\'s name goes to main; the cache and a playlist:changed follow its answer', async () => {
    window.funsync = { ensureFavouritesPlaylist: vi.fn(async (name) => ({ id: 'favourites', name, videoPaths: [] })) };
    const heard = [];
    const off = eventBus.on('playlist:changed', (e) => heard.push(e));
    const pl = await ds.ensureFavouritesPlaylist('Favoriten');
    off?.();
    expect(window.funsync.ensureFavouritesPlaylist).toHaveBeenCalledWith('Favoriten');
    expect(pl.name).toBe('Favoriten');
    expect(ds.getPlaylist('favourites').name).toBe('Favoriten');
    expect(heard.map((e) => e.action)).toContain('rename');
  });

  it('main keeping a user\'s name: nothing changes; the same name: main is not asked', async () => {
    window.funsync = { ensureFavouritesPlaylist: vi.fn(async () => ({ id: 'favourites', name: 'Favourites' })) };
    expect((await ds.ensureFavouritesPlaylist('Favoriten')).name).toBe('Favourites');
    window.funsync.ensureFavouritesPlaylist.mockClear();
    await ds.ensureFavouritesPlaylist('Favourites');
    expect(window.funsync.ensureFavouritesPlaylist).not.toHaveBeenCalled();
  });

  it('app.js asks again on every language change', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8');   // vitest runs from the repo root
    expect(src).toMatch(/eventBus\.on\('language:changed', \(\) => this\.settings\.ensureFavouritesPlaylist\?\.\(t\('library\.favourites\.playlistName'\)\)\)/);
  });
});
