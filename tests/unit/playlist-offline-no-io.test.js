/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its detail grid and
 * list rows into a DOM (heatmap-strip.js branches on `typeof window`; see
 * notes/CLAUDE.md "Test environments").
 */
// FT-071 (app test V57): a playlist entry whose drive is offline still went
// to disk. `_renderDetail` built each tile (which requests its thumbnail and
// reads its script for the badge) BEFORE marking it unavailable, and list
// rows read their script for the heatmap unconditionally. Every one of those
// requests fails: a backend thumbnail, then a hidden-<video> fallback that
// feeds main's "thumbnail generation is broken" streak, and a read-funscript
// per entry against a path the probe has just said is unreachable.
// categories.js has skipped them since V01; this pins the same for
// playlists, by the requests the bridge sees.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Playlists } from '../../renderer/components/playlists.js';
import * as thumbCache from '../../renderer/js/thumbnail-cache.js';

const E = (p) => `E:\\Videos\\${p}`;
const C = (p) => `C:\\Users\\dave\\Videos\\${p}`;

let container;
afterEach(() => {
  container?.remove();
  delete window.funsync;
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function openPlaylist(paths, reachable, viewMode = 'grid', { cachedBins } = {}) {
  window.funsync = {
    filesExist: vi.fn(async (list) => list.map((p) => reachable.has(p))),
    fileExists: vi.fn(async (p) => reachable.has(p)),
    readFunscript: vi.fn(async () => null),
    generateSingleThumbnail: vi.fn(async () => null),
  };
  const playlist = { id: 'p1', name: 'P', videoPaths: paths.slice() };
  const store = {};
  const pl = new Playlists({
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
      getPlaylists: () => [playlist],
      getPlaylist: (id) => (id === 'p1' ? playlist : null),
      removeVideoFromPlaylist: vi.fn(),
    },
    onPlayVideo: vi.fn(),
    library: null,
  });
  if (cachedBins) for (const [p, bins] of Object.entries(cachedBins)) pl._binsByPath.set(p, bins);
  container = document.createElement('div');
  document.body.appendChild(container);
  pl._container = container;
  pl._viewMode = viewMode;
  pl._view = 'detail';
  pl._detailPlaylistId = 'p1';
  await pl._renderDetail('p1');
  await new Promise((r) => setTimeout(r, 0));
  return { pl, container };
}

const thumbsAsked = () => window.funsync.generateSingleThumbnail.mock.calls.map((c) => c[0]);
const readsAsked = () => window.funsync.readFunscript.mock.calls.map((c) => c[0]);

describe('a playlist entry on an offline drive reads nothing (FT-071)', () => {
  it('grid: no thumbnail request, no script read, no hidden <video> for the offline tile', async () => {
    const { container: c } = await openPlaylist([C('io-here.mp4'), E('io-gone.mp4')], new Set([C('io-here.mp4')]));
    expect(thumbsAsked()).toContain(C('io-here.mp4'));
    expect(thumbsAsked()).not.toContain(E('io-gone.mp4'));
    expect(readsAsked().some((p) => p.includes('io-gone'))).toBe(false);
    // An AVAILABLE scriptless entry still looks for its script, once.
    expect(readsAsked().filter((p) => p.includes('io-here'))).toHaveLength(1);
    expect(document.querySelector('video[src*="io-gone"]')).toBeNull();
    // Still on screen, greyed, and not marked broken ("File not found").
    const gone = [...c.querySelectorAll('.playlists__video-card')].find((el) => el.dataset.unavailable === 'true');
    expect(gone).toBeTruthy();
    expect(gone.classList.contains('playlists__video-card--broken')).toBe(false);
  });

  it('list: the offline row reads no script; the available one reads once', async () => {
    await openPlaylist([C('row-here.mp4'), E('row-gone.mp4')], new Set([C('row-here.mp4')]), 'list');
    expect(readsAsked().some((p) => p.includes('row-gone'))).toBe(false);
    expect(readsAsked().filter((p) => p.includes('row-here'))).toHaveLength(1);
  });

  it('an offline tile still shows a thumbnail already in the cache, without asking for one', async () => {
    thumbCache.set(E('cached.mp4'), 0, 'data:image/png;base64,AAAA', 61);
    try {
      const { container: c } = await openPlaylist([E('cached.mp4')], new Set());
      const card = c.querySelector('.playlists__video-card');
      expect(card.dataset.unavailable).toBe('true');
      expect(card.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
      expect(window.funsync.generateSingleThumbnail).not.toHaveBeenCalled();
    } finally {
      thumbCache.remove(E('cached.mp4'), 0);
    }
  });

  it('an offline list row keeps cached heatmap bins and drops the strip otherwise', async () => {
    const bins = Array.from({ length: 10 }, () => 0.5);
    const { container: c } = await openPlaylist(
      [E('binned.mp4'), E('bare.mp4')], new Set(), 'list', { cachedBins: { [E('binned.mp4')]: bins } },
    );
    const rows = [...c.querySelectorAll('.playlists__list-item')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.playlists__list-heatmap')).not.toBeNull();
    expect(rows[1].querySelector('.playlists__list-heatmap')).toBeNull();
    expect(rows[1].classList.contains('playlists__list-item--no-heatmap')).toBe(true);
    expect(window.funsync.readFunscript).not.toHaveBeenCalled();
  });

  it('a click on the offline tile explains instead of playing', async () => {
    const { pl, container: c } = await openPlaylist([E('a.mp4')], new Set());
    const play = vi.spyOn(pl, '_playVideoByPath');
    const notify = vi.spyOn(pl, '_notifyUnavailable').mockImplementation(async () => {});
    c.querySelector('.playlists__video-card').click();
    expect(notify).toHaveBeenCalledWith(E('a.mp4'));
    expect(play).not.toHaveBeenCalled();
  });
});
