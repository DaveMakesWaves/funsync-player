// Videos on a disconnected drive must go UNAVAILABLE in a category, never be unassigned.
//
// App test V01, 2026-11-02 (critical): with a source drive unplugged, merely
// OPENING a category's detail view permanently stripped every video on that
// drive out of the category. `_renderDetail` probed each path with fileExists
// and called unassignCategory() on every miss, so an absent VOLUME was treated
// as a deleted FILE and config.json was rewritten before the drive came back.
// The identical bug was fixed for playlists on 2026-08-06
// (playlist-availability.test.js) and never fixed here.
//
// The invariant: absence is never destructive. These tests drive the REAL
// Categories component (jsdom) and assert the observable effect — no unassign
// call, every tile still rendered — not the structure of the code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Categories } from '../../renderer/components/categories.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';
import * as thumbCache from '../../renderer/js/thumbnail-cache.js';

const CAT = { id: 'cat-1', name: 'E Cat', color: '#e94560' };
const E = (p) => `E:\\Videos\\${p}`;
const C = (p) => `C:\\Users\\dave\\Videos\\${p}`;

function makeSettings(paths) {
  return {
    getCategories: () => [CAT],
    getVideosByCategory: (id) => (id === CAT.id ? paths.slice() : []),
    get: () => ({}),
    unassignCategory: vi.fn(),
  };
}

function installBridge(reachable) {
  window.funsync = {
    filesExist: vi.fn(async (list) => list.map((p) => reachable.has(p))),
    fileExists: vi.fn(async (p) => reachable.has(p)),
    readFunscript: vi.fn(async () => null),
    generateSingleThumbnail: vi.fn(async () => null),
  };
}

async function openDetail(paths, reachable, viewMode = 'grid') {
  installBridge(reachable);
  const settings = makeSettings(paths);
  const cats = new Categories({ settings, onPlayVideo: vi.fn(), library: null });
  const container = document.createElement('div');
  document.body.appendChild(container);
  cats._container = container;
  cats._viewMode = viewMode;
  cats._view = 'detail';
  cats._detailCategoryId = CAT.id;
  await cats._renderDetail(CAT.id);
  return { cats, settings, container };
}

describe('category detail with an unplugged drive (V01)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { delete window.funsync; });

  it('never unassigns a video just because its drive is offline', async () => {
    const paths = [E('a.mp4'), E('b.mp4')];
    const { settings } = await openDetail(paths, new Set());
    expect(settings.unassignCategory).not.toHaveBeenCalled();
  });

  it('keeps every assigned video on screen, greyed, with a volume notice', async () => {
    const paths = [C('here.mp4'), E('gone1.mp4'), E('gone2.mp4')];
    const { container } = await openDetail(paths, new Set([C('here.mp4')]));
    const cards = container.querySelectorAll('.categories__video-card');
    expect(cards).toHaveLength(3);
    const greyed = [...cards].filter((c) => c.dataset.unavailable === 'true');
    expect(greyed).toHaveLength(2);
    const notice = container.querySelector('.categories__unavailable-notice');
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('E:');
    // the header count is the assignment count, not the reachable count
    expect(container.querySelector('.categories__detail-count').textContent).toBe('3 videos');
  });

  it('does not show the empty state when every video is offline', async () => {
    const { container } = await openDetail([E('a.mp4')], new Set());
    expect(container.querySelector('.categories__empty')).toBeNull();
    expect(container.querySelectorAll('.categories__video-card')).toHaveLength(1);
  });

  it('greys list rows too', async () => {
    const { container, settings } = await openDetail([E('a.mp4'), C('b.mp4')], new Set([C('b.mp4')]), 'list');
    const rows = [...container.querySelectorAll('.categories__list-item')];
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.dataset.unavailable === 'true')).toHaveLength(1);
    expect(rows[0].querySelector('.categories__unavailable-badge--inline')).not.toBeNull();
    expect(settings.unassignCategory).not.toHaveBeenCalled();
  });

  it('fails OPEN when the availability probe throws: nothing greyed, nothing removed', async () => {
    const paths = [E('a.mp4')];
    const settings = makeSettings(paths);
    window.funsync = {
      filesExist: vi.fn(async () => { throw new Error('IPC down'); }),
      readFunscript: vi.fn(async () => null),
      generateSingleThumbnail: vi.fn(async () => null),
    };
    const cats = new Categories({ settings, onPlayVideo: vi.fn(), library: null });
    cats._container = document.createElement('div');
    cats._detailCategoryId = CAT.id;
    await cats._renderDetail(CAT.id);
    expect(settings.unassignCategory).not.toHaveBeenCalled();
    expect(cats._container.querySelector('[data-unavailable="true"]')).toBeNull();
  });

  it('a click on an offline tile does not start playback', async () => {
    const { cats, container } = await openDetail([E('a.mp4')], new Set());
    const play = vi.spyOn(cats, '_playVideo');
    container.querySelector('.categories__video-card').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(play).not.toHaveBeenCalled();
  });

  // Category plays have no prev/next (playlists only). What does advance
  // through a category is Up Next, so that is what must step over the offline
  // video. It does so because app.js wires `isPlayable` to the library, and an
  // offline source is not scanned. Driven end to end: the real context a tile
  // click produces, fed to the real engine.
  it('Up Next for a category play walks past the offline video', async () => {
    const paths = [C('here.mp4'), E('gone.mp4'), C('after.mp4')];
    const reachable = new Set([C('here.mp4'), C('after.mp4')]);
    const { cats, container } = await openDetail(paths, reachable);
    const play = vi.spyOn(cats, '_playVideo').mockImplementation(() => {});
    container.querySelector('.categories__video-card:not([data-unavailable])').click();
    const ctx = play.mock.calls[0][1];
    // The context keeps the offline video in its list; skipping is Up Next's job.
    expect(ctx.list).toEqual(paths);

    const engine = new UpNextEngine({
      videoPlayer: { currentTime: 0, paused: false, duration: 120, ended: false },
      funscriptEngine: { isLoaded: false, getActions: () => [] },
    });
    engine.setPlayContext(ctx);
    // Same shape as app.js: the library only holds what it could scan.
    engine.isPlayable = (p) => reachable.has(p);
    expect(engine._nextPath()).toBe(C('after.mp4'));
  });

  // An offline tile must not go to disk. Each request would fail: a backend
  // thumbnail (then a hidden-<video> fallback) that feeds main's "thumbnail
  // generation is broken for this whole library" streak, and an error-level
  // read-funscript ENOENT per tile (V57, reachable from categories once the
  // purge stopped removing these paths).
  it('an offline card requests no thumbnail and reads no funscript', async () => {
    const paths = [C('io-here.mp4'), E('io-gone.mp4')];
    await openDetail(paths, new Set([C('io-here.mp4')]));
    await new Promise((r) => setTimeout(r, 0));
    const thumbs = window.funsync.generateSingleThumbnail.mock.calls.map((c) => c[0]);
    const reads = window.funsync.readFunscript.mock.calls.map((c) => c[0]);
    expect(thumbs).toContain(C('io-here.mp4'));
    expect(thumbs).not.toContain(E('io-gone.mp4'));
    expect(reads.some((p) => p.includes('io-gone'))).toBe(false);
    expect(reads.some((p) => p.includes('io-here'))).toBe(true);
    expect(document.querySelector('video[src*="io-gone"]')).toBeNull();
  });

  it('an offline list row reads no funscript', async () => {
    await openDetail([C('row-here.mp4'), E('row-gone.mp4')], new Set([C('row-here.mp4')]), 'list');
    await new Promise((r) => setTimeout(r, 0));
    const reads = window.funsync.readFunscript.mock.calls.map((c) => c[0]);
    expect(reads.some((p) => p.includes('row-gone'))).toBe(false);
    expect(reads.some((p) => p.includes('row-here'))).toBe(true);
  });

  it('an offline card still shows a thumbnail it already has cached', async () => {
    thumbCache.set(E('cached.mp4'), 0, 'data:image/png;base64,AAAA', 61);
    try {
      const { container } = await openDetail([E('cached.mp4')], new Set());
      const card = container.querySelector('.categories__video-card');
      expect(card.dataset.unavailable).toBe('true');
      expect(card.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
      expect(window.funsync.generateSingleThumbnail).not.toHaveBeenCalled();
    } finally {
      thumbCache.remove(E('cached.mp4'), 0);
    }
  });

  // Display probes fail OPEN. `files-exist` answers null when a path misses
  // its time budget (a spun-down disk, a NAS); greying it would turn a click
  // on a playable video into a "reconnect the drive" toast.
  it('a probe that timed out (null) leaves the tile playable', async () => {
    const settings = makeSettings([E('slow.mp4')]);
    window.funsync = {
      filesExist: vi.fn(async (list) => list.map(() => null)),
      readFunscript: vi.fn(async () => null),
      generateSingleThumbnail: vi.fn(async () => null),
    };
    const cats = new Categories({ settings, onPlayVideo: vi.fn(), library: null });
    cats._container = document.createElement('div');
    cats._detailCategoryId = CAT.id;
    await cats._renderDetail(CAT.id);
    expect(cats._container.querySelector('[data-unavailable="true"]')).toBeNull();
    expect(cats._container.querySelector('.categories__unavailable-notice')).toBeNull();
  });

  it('the user remove button is still the one way to unassign', async () => {
    const { settings, container } = await openDetail([E('a.mp4')], new Set());
    container.querySelector('.categories__video-remove-btn').click();
    expect(settings.unassignCategory).toHaveBeenCalledWith(E('a.mp4'), CAT.id);
  });
});
