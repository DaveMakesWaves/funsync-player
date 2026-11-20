/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// "Back to <playlist>" on the End-of-list card after Play All opened the
// Library (V72 verify, 2026-11-04; also in v0.9.2). Play All's queue context
// is `{ kind: 'playlist', id }` (playlists.js Play All); a direct playlist play
// is `{ playlistId }`. `_upNextBackToSource` read only the second shape.
import { describe, it, expect } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';

const Lifted = liftAppClass(['_upNextBackToSource', '_currentView'], {});

// The fakes keep the real contract the render count depends on (FT-034):
// entering a view runs its component's show(), and show() renders the detail
// when `_view` is 'detail'. `rendered` is the LAST id, `renders` the count;
// one Back must render once (the real detail double-rendered when it ran from
// both show() and the method itself). See up-next-back-to-source-render.test.js
// for the same through the REAL components.
const fakeView = (idKey) => ({
  rendered: null,
  renders: 0,
  _view: 'grid',
  show() { if (this._view === 'detail') this._renderDetail(this[idKey]); },
  _renderDetail(id) { this.rendered = id; this.renders++; },
});
const make = () => {
  const app = new Lifted();
  app.nav = [];
  app._navStack = ['player'];
  app._navigateTo = (v) => {
    app.nav.push(v);
    app._navStack = [v];
    if (v === 'playlists' || v === 'categories') app[v].show();
  };
  app.playlists = fakeView('_detailPlaylistId');
  app.categories = fakeView('_detailCategoryId');
  return app;
};

describe('_upNextBackToSource', () => {
  it("Play All's queue context goes back to the playlist", () => {
    const app = make();
    // Play All was pressed from this playlist's detail, so that is the
    // component's state when the End-of-list card offers the way back.
    app.playlists._view = 'detail';
    app.playlists._detailPlaylistId = 'pl-7';
    app._upNextBackToSource({ kind: 'playlist', id: 'pl-7' });
    expect(app.nav).toEqual(['playlists']);
    expect(app.playlists._detailPlaylistId).toBe('pl-7');
    expect(app.playlists._view).toBe('detail');
    expect(app.playlists.rendered).toBe('pl-7');
    expect(app.playlists.renders).toBe(1);
  });

  it('already on the Playlists view (mini player docked): no navigation, one render', () => {
    const app = make();
    app._navStack = ['playlists'];
    app._upNextBackToSource({ kind: 'playlist', id: 'pl-7' });
    expect(app.nav).toEqual([]);
    expect(app.playlists.rendered).toBe('pl-7');
    expect(app.playlists.renders).toBe(1);
  });

  it('a direct playlist play still goes back to the playlist', () => {
    const app = make();
    app._upNextBackToSource({ playlistId: 'pl-3' });
    expect(app.nav).toEqual(['playlists']);
    expect(app.playlists.rendered).toBe('pl-3');
  });

  it('both category shapes go back to the category', () => {
    for (const ctx of [{ categoryId: 'c-1' }, { kind: 'category', id: 'c-1' }]) {
      const app = make();
      app._upNextBackToSource(ctx);
      expect(app.nav).toEqual(['categories']);
      expect(app.categories.rendered).toBe('c-1');
      expect(app.categories.renders).toBe(1);
    }
  });

  it('anything else goes to the Library', () => {
    for (const ctx of [null, {}, { kind: 'folder', id: 'x' }, { kind: 'playlist' }]) {
      const app = make();
      app._upNextBackToSource(ctx);
      expect(app.nav).toEqual(['library']);
    }
  });
});
