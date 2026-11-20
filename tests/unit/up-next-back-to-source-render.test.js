/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists and Categories components render their
 * detail views into real containers, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// FT-034 (2026-11-05, verifier 2; new since v0.9.2 for Play All, the direct-
// play shape also in v0.9.2): "Back to <playlist>" / "Back to <category>" on
// the End-of-list card opened the right detail, but with every video in it
// TWICE (2 grids, 4 cards for a 2-video playlist).
//
// `_upNextBackToSource` called `_navigateTo`, whose `show()` already renders
// the detail when the component's `_view` is 'detail' (it was: Play All was
// pressed from that detail), and then called `_renderDetail` again. The detail
// empties its container, awaits the availability probe, then appends its grid,
// so the two renders interleaved across the await and both appended.
//
// What runs is REAL: app.js's own `_currentView`, `_navigateTo`,
// `_onEnterView`, `_onLeaveView` and `_upNextBackToSource`, lifted out of
// app.js, driving the REAL components. Only the player teardown, the nav bar
// and the other views are stubs. Asserted on what the user sees: how many
// grids and cards are on screen once every render has settled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Playlists } from '../../renderer/components/playlists.js';
import { Categories } from '../../renderer/components/categories.js';
import { liftAppClass } from './helpers/app-methods.js';

const Z = 'C:\\Lib\\Zulu Last.mp4';
const A = 'C:\\Lib\\Alpha Scene.mp4';
const PL = { id: 'pl-two', name: 'FT034 Two', videoPaths: [Z, A], loop: false, shuffle: false };
const CAT = { id: 'cat-1', name: 'FT034 Cat', color: '#e94560' };

const LiftedApp = liftAppClass(
  ['_currentView', '_navigateTo', '_onEnterView', '_onLeaveView', '_upNextBackToSource'],
  { document, exitFullscreenForNav: () => {} },
);

let savedFunsync;

function build({ from = 'player', playlistsView = 'detail', categoriesView = 'detail' } = {}) {
  document.body.innerHTML = `
    <div id="app">
      <div id="library-container"></div>
      <div id="player-container"></div>
      <div id="playlists-container"></div>
      <div id="categories-container"></div>
    </div>`;
  const views = {
    library: document.getElementById('library-container'),
    player: document.getElementById('player-container'),
    playlists: document.getElementById('playlists-container'),
    categories: document.getElementById('categories-container'),
  };
  const store = {};
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getPlaylists: () => [PL],
    getPlaylist: (id) => (id === PL.id ? PL : null),
    getCategories: () => [CAT],
    getVideosByCategory: (id) => (id === CAT.id ? [Z, A] : []),
  };
  const playlists = new Playlists({ settings, library: null, onPlayVideo: vi.fn(), onPlayAll: vi.fn() });
  const categories = new Categories({ settings, library: null, onPlayVideo: vi.fn(), onPlayAll: vi.fn() });
  // Where Play All was pressed: the component was showing that detail (or,
  // for the second case, its grid) when the player took over.
  playlists._container = views.playlists;
  playlists._view = playlistsView;
  playlists._detailPlaylistId = playlistsView === 'detail' ? PL.id : null;
  categories._container = views.categories;
  categories._view = categoriesView;
  categories._detailCategoryId = categoriesView === 'detail' ? CAT.id : null;

  const app = Object.assign(new LiftedApp(), {
    _navStack: from === 'player' ? ['playlists', 'player'] : [from],
    _miniActive: from !== 'player',
    playlists,
    categories,
    library: { show() {}, hide() {} },
    navBar: { show() {}, hide() {}, setActive() {} },
    queuePanel: null,
    _getViewEl: (v) => views[v] || null,
    _syncCaptionOverlay() {}, _syncBackendBannerOffset() {},
    _emitVideoSyncOffsetRowChanged() {},
    _refreshCollectionsUI: async () => {},
    _clearMiniplayer() {},
    _isOurVideoInPip: () => false,
    _beginDeferredPipTeardown() {},
    _shouldEnterMiniplayer: () => false,
    _enterMiniplayer() {},
    _teardownPlayback: vi.fn(),
  });
  return { app, views };
}

/** Let every render waiting on its probe (and the probe's IPC) finish. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  savedFunsync = window.funsync;
  window.funsync = {
    // A real IPC answer arrives on a later task, not a microtask.
    filesExist: vi.fn((paths) => new Promise((r) => setTimeout(() => r(paths.map(() => true)), 1))),
    fileExists: vi.fn(async () => true),
    readFunscript: vi.fn(async () => null),
    getThumbnail: vi.fn(async () => null),
    generateSingleThumbnail: vi.fn(async () => null),
  };
});
afterEach(() => {
  window.funsync = savedFunsync;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const shown = (el, gridSel, cardSel) => ({
  grids: el.querySelectorAll(gridSel).length,
  cards: el.querySelectorAll(cardSel).length,
});

describe("FT-034: Back to <playlist> / <category> shows the detail once", () => {
  it("Back to <playlist> after Play All from that playlist's detail: one grid, one card per video", async () => {
    const { app, views } = build();
    app._upNextBackToSource({ kind: 'playlist', id: PL.id });
    await settle();
    expect(app._currentView()).toBe('playlists');
    expect(app.playlists._view).toBe('detail');
    expect(app.playlists._detailPlaylistId).toBe(PL.id);
    expect(shown(views.playlists, '.playlists__grid', '.playlists__video-card'))
      .toEqual({ grids: 1, cards: 2 });
  });

  it('the direct-play shape and a playlists grid left behind land on the same single detail', async () => {
    const { app, views } = build({ playlistsView: 'grid' });
    app._upNextBackToSource({ playlistId: PL.id });
    await settle();
    expect(app.playlists._view).toBe('detail');
    expect(shown(views.playlists, '.playlists__grid', '.playlists__video-card'))
      .toEqual({ grids: 1, cards: 2 });
  });

  it('with the mini player docked over the Playlists view, the detail still renders (once)', async () => {
    const { app, views } = build({ from: 'playlists', playlistsView: 'grid' });
    app._upNextBackToSource({ kind: 'playlist', id: PL.id });
    await settle();
    expect(app._currentView()).toBe('playlists');
    expect(views.playlists.querySelector('.playlists__title')?.textContent).toBe(PL.name);
    expect(shown(views.playlists, '.playlists__grid', '.playlists__video-card'))
      .toEqual({ grids: 1, cards: 2 });
  });

  it("Back to <category> after Play All from that category's detail: one grid, one card per video", async () => {
    const { app, views } = build();
    app._upNextBackToSource({ kind: 'category', id: CAT.id });
    await settle();
    expect(app._currentView()).toBe('categories');
    expect(app.categories._detailCategoryId).toBe(CAT.id);
    expect(shown(views.categories, '.categories__grid', '.categories__video-card'))
      .toEqual({ grids: 1, cards: 2 });
  });

  it('with the mini player docked over the Categories view, the category detail renders once', async () => {
    const { app, views } = build({ from: 'categories', categoriesView: 'grid' });
    app._upNextBackToSource({ categoryId: CAT.id });
    await settle();
    expect(shown(views.categories, '.categories__grid', '.categories__video-card'))
      .toEqual({ grids: 1, cards: 2 });
  });
});

// The components on their own: whoever renders twice, the later render owns
// the container (a language switch mid-render, a slow probe, a Back click).
describe('FT-034: a newer render supersedes a detail still waiting on its probe', () => {
  it('two overlapping playlist detail renders leave one grid', async () => {
    const { app, views } = build({ from: 'playlists' });
    await Promise.all([app.playlists._renderDetail(PL.id), app.playlists._renderDetail(PL.id)]);
    await settle();
    expect(shown(views.playlists, '.playlists__grid', '.playlists__video-card'))
      .toEqual({ grids: 1, cards: 2 });
    expect(views.playlists.querySelectorAll('.playlists__header')).toHaveLength(1);
  });

  it('Back to the playlists grid while a detail is still probing leaves no detail grid behind', async () => {
    const { app, views } = build({ from: 'playlists' });
    const pending = app.playlists._renderDetail(PL.id);
    app.playlists.navigateBack();
    await pending;
    await settle();
    // The playlists grid (one playlist card), not the detail's video cards.
    expect(views.playlists.querySelectorAll('.playlists__video-card')).toHaveLength(0);
    expect(views.playlists.querySelectorAll('.playlists__grid')).toHaveLength(1);
    expect(views.playlists.querySelectorAll('.playlists__header')).toHaveLength(1);
  });

  it('two overlapping category detail renders leave one grid', async () => {
    const { app, views } = build({ from: 'categories' });
    await Promise.all([app.categories._renderDetail(CAT.id), app.categories._renderDetail(CAT.id)]);
    await settle();
    expect(shown(views.categories, '.categories__grid', '.categories__video-card'))
      .toEqual({ grids: 1, cards: 2 });
  });
});
