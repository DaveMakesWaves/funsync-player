/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Disabled videos and Favourites, the models (zaikechi #381, 2026-11-23):
// renderer/js/disabled-videos.js and renderer/js/favourites.js, on a fake
// DataService. And the app's rule: a disabled video is never CHOSEN by
// FunSync (the real App methods on a stand-in: Up Next's check, Play all,
// N / P, a bulk Add to queue), while a hand pick still plays.
import { describe, it, expect, vi } from 'vitest';
import { isDisabled, setDisabled, enableVideos, withoutDisabled, disabledRows, disabledCount } from '../../renderer/js/disabled-videos.js';
import { isFavourite, setFavourite, toggleFavourite, favouritePaths, FAVOURITES_PLAYLIST_ID } from '../../renderer/js/favourites.js';
import { liftAppClass } from './helpers/app-methods.js';

function fakeSettings(init = {}) {
  const s = { 'library.disabledVideos': {}, ...init };
  const playlists = [];
  return {
    get: (k) => s[k],
    set: vi.fn((k, v) => { s[k] = v; }),
    getPlaylist: (id) => playlists.find((p) => p.id === id) || null,
    getPlaylists: () => playlists,
    ensureFavouritesPlaylist: vi.fn(async (name) => {
      let pl = playlists.find((p) => p.id === FAVOURITES_PLAYLIST_ID);
      if (!pl) { pl = { id: FAVOURITES_PLAYLIST_ID, name, videoPaths: [] }; playlists.unshift(pl); }
      return pl;
    }),
    addVideoToPlaylist: vi.fn((id, p) => { const pl = playlists.find((x) => x.id === id); if (!pl.videoPaths.includes(p)) pl.videoPaths.push(p); }),
    removeVideoFromPlaylist: vi.fn((id, p) => { const pl = playlists.find((x) => x.id === id); pl.videoPaths = pl.videoPaths.filter((x) => x !== p); }),
    _s: s,
    _playlists: playlists,
  };
}

describe('disabled-videos.js', () => {
  it('disable / enable, one write per change, none for no change', () => {
    const st = fakeSettings();
    expect(setDisabled(st, 'C:\\a.mp4', true, 100)).toBe(true);
    expect(setDisabled(st, 'C:\\a.mp4', true, 200)).toBe(true);
    expect(st.set).toHaveBeenCalledTimes(1);
    expect(st._s['library.disabledVideos']).toEqual({ 'C:\\a.mp4': 100 });
    expect(isDisabled(st, 'C:\\a.mp4')).toBe(true);
    expect(setDisabled(st, 'C:\\a.mp4', false)).toBe(false);
    expect(isDisabled(st, 'C:\\a.mp4')).toBe(false);
    expect(disabledCount(st)).toBe(0);
  });

  it('withoutDisabled keeps the order and takes paths or video records', () => {
    const st = fakeSettings({ 'library.disabledVideos': { B: 1 } });
    expect(withoutDisabled(['A', 'B', 'C'], st)).toEqual(['A', 'C']);
    expect(withoutDisabled([{ path: 'A' }, { path: 'B' }], st)).toEqual([{ path: 'A' }]);
  });

  it('the review rows: newest first, with the library record or null (offline / moved)', () => {
    const st = fakeSettings({ 'library.disabledVideos': { A: 1, B: 3, C: 2 } });
    const rows = disabledRows(st, [{ path: 'A', name: 'A.mp4' }, { path: 'B', name: 'B.mp4' }]);
    expect(rows.map((r) => [r.path, r.video?.name ?? null])).toEqual([['B', 'B.mp4'], ['C', null], ['A', 'A.mp4']]);
  });

  it('Enable all is one write', () => {
    const st = fakeSettings({ 'library.disabledVideos': { A: 1, B: 2 } });
    expect(enableVideos(st, ['A', 'B', 'X'])).toBe(2);
    expect(st.set).toHaveBeenCalledTimes(1);
    expect(st._s['library.disabledVideos']).toEqual({});
  });

  it('a damaged map reads as none disabled, never a throw', () => {
    const st = fakeSettings({ 'library.disabledVideos': ['A'] });
    expect(isDisabled(st, 'A')).toBe(false);
    expect(withoutDisabled(['A'], st)).toEqual(['A']);
  });
});

describe('favourites.js: the Favourites playlist IS the favourites', () => {
  it('the first favourite makes the playlist (in the name given); toggling takes it out again', async () => {
    const st = fakeSettings();
    expect(isFavourite(st, 'A')).toBe(false);
    expect(await setFavourite(st, 'A', true, 'Favoris')).toBe(true);
    expect(st._playlists[0]).toMatchObject({ id: 'favourites', name: 'Favoris', videoPaths: ['A'] });
    expect(await toggleFavourite(st, 'B', 'x')).toBe(true);
    expect([...favouritePaths(st)]).toEqual(['A', 'B']);
    expect(await toggleFavourite(st, 'A', 'x')).toBe(false);
    expect(st._playlists[0].videoPaths).toEqual(['B']);
    expect(st.ensureFavouritesPlaylist).toHaveBeenCalledTimes(2); // only on the way IN
  });

  it('unfavouriting never makes the playlist', async () => {
    const st = fakeSettings();
    expect(await setFavourite(st, 'A', false)).toBe(false);
    expect(st.ensureFavouritesPlaylist).not.toHaveBeenCalled();
    expect(st._playlists).toEqual([]);
  });
});

describe('the app never CHOOSES a disabled video', () => {
  const App = liftAppClass(['_isDisabledPath', '_isUpNextPlayable', '_playAll', 'addPathsToUserQueue', '_stepPlayContext'], { t: (k) => k, showToast: () => {} });
  function app(disabled) {
    const videos = ['A', 'B', 'C'].map((p) => ({ name: `${p}.mp4`, path: p, funscriptPath: null }));
    return Object.assign(new App(), {
      settings: fakeSettings({ 'library.disabledVideos': Object.fromEntries(disabled.map((p) => [p, 1])) }),
      library: { _videos: videos, getVideoByPath: (p) => videos.find((v) => v.path === p) || null },
      _isUnderEnabledSource: () => true,
      _userQueue: [],
      _persistUserQueue: vi.fn(),
      _updateQueuePanelState: vi.fn(),
    });
  }

  it("Up Next's check refuses a disabled video, before the library is even scanned", () => {
    const a = app(['B']);
    expect(a._isUpNextPlayable('A')).toBe(true);
    expect(a._isUpNextPlayable('B')).toBe(false);
    a.library._videos = [];
    expect(a._isUpNextPlayable('B')).toBe(false);
  });

  it('Play all / Shuffle all leave disabled ones out of the queue', () => {
    const a = app(['B']);
    a._editorAllowsReplace = () => true;
    a._playAllOrder = (list) => list.slice();
    a._navigateTo = vi.fn();
    a._playQueueItem = vi.fn();
    a._playAll(a.library._videos, {});
    expect(a._playQueue.map((v) => v.path)).toEqual(['A', 'C']);
    expect(a._playQueueItem).toHaveBeenCalledWith(0);
  });

  it('a bulk Add to queue skips a disabled one', () => {
    const a = app(['B']);
    expect(a.addPathsToUserQueue(['A', 'B', 'C'])).toBe(2);
    expect(a._userQueue).toEqual(['A', 'C']);
  });

  it('N steps over a disabled video (it names no video)', () => {
    const a = app(['B']);
    a._currentPlayContext = { source: 'library', list: ['A', 'B', 'C'], index: 0 };
    a._isPlaylistContext = () => false;
    let opened = null;
    a._playFromLibrary = (v) => { opened = v; };
    a.library._playVideo = (v) => { opened = v; };
    a._stepPlayContext(+1);
    // Whatever opens it, the target is C, never the disabled B.
    const target = opened?.path ?? a._currentPlayContext?.list?.[opened?._playContextOverride?.index];
    expect(opened?._playContextOverride?.index ?? null).toBe(2);
    expect(target).toBe('C');
  });
});
