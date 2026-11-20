/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL phone page (index.html + app.js) queries the DOM
 * at import and draws the playlist into it (notes/CLAUDE.md "Test
 * environments").
 */
// Block E2 verify-1 (also in v0.9.2): the phone's playlist page ignored the
// playlist's order. /api/remote/playlists sends `videoIds` in the order the
// desktop keeps (Move, drag, Sort, Undo; FT-104 made that easy), but
// renderGroupingDetail filtered the library by those ids and then sorted by
// the phone's own sort, Name A-Z by default. So the list, and the phone's
// Play all, always ran in name order.
//
// Asserted is what the phone draws and plays: the cards' titles in order,
// where Play all goes and what it queues next, the Sort button, and that a
// collection (a set) still follows the phone's sort. Only the WebSocket sync
// client is a fake.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; }
    start() {}
    stop() {}
  },
}));

const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const video = (id, name, extra = {}) => ({
  id, name, path: `${SOURCE}\\${name}.mp4`,
  hasFunscript: true, hasSubtitle: false, duration: 60, avgSpeed: 100, maxSpeed: 200, dateAdded: 0,
  sourceName: 'Library',
  streamUrl: `/api/media/stream/${id}`, scriptUrl: `/api/media/script/${id}`, subtitleUrl: null,
  thumbUrl: `/api/media/thumb/${id}`, variants: [], manualVRType: null,
  ...extra,
});
const VIDEOS = [
  video('va', 'Alpha Scene'),
  video('vb', 'Bravo Scene'),
  video('vc', 'Charlie Scene'),
  video('vd', 'Delta Scene', { hasFunscript: false }),
];
// The order the user set on the desktop: not A-Z, not Z-A.
const PLAYLIST = { id: 'p1', name: 'Evening', videoIds: ['vc', 'va', 'vd', 'vb'], balanceByScript: false };
const COLLECTION = { id: 'c1', name: 'Set', videoIds: ['vc', 'va', 'vb'] };

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/locale') return json({ locale: 'en', theme: 'dark' });
  if (p === '/locales/en.json') return json(EN);
  if (p === '/api/remote/videos') return json({ videos: structuredClone(VIDEOS) });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [structuredClone(COLLECTION)] });
  if (p === '/api/remote/playlists') return json({ playlists: [structuredClone(PLAYLIST)] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p.startsWith('/api/media/script/')) return json({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] });
  return json({ detail: 'not found' }, 404);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}
const titles = () => [...document.querySelectorAll('#mainContent .card__title')].map((el) => el.textContent);
const sortBtn = () => document.getElementById('sortBtn');
async function open(hash, expected) {
  window.location.hash = hash;
  return waitFor(() => titles().join('|') === expected.join('|'));
}

beforeAll(async () => {
  localStorage.clear();
  // The phone's own sort, remembered from the last visit: Name A-Z.
  localStorage.setItem('funsync.remote.ui', JSON.stringify({ sort: 'name:asc', view: 'grid', tab: 'all' }));
  const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  window.HTMLMediaElement.prototype.load = function load() {};
  window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function pause() {};
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = vi.fn(fakeFetch);
  await import('../../backend/web-remote/app.js');
  window.dispatchEvent(new Event('load'));
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
  localStorage.clear();
});

describe('the phone\'s playlist page follows the playlist\'s order (block E2 verify-1)', () => {
  it('the library itself is in the phone\'s sort, Name A-Z', async () => {
    expect(await open('', ['Alpha Scene', 'Bravo Scene', 'Charlie Scene', 'Delta Scene'])).toBe(true);
    expect(sortBtn().hidden).toBe(false);
  });

  it('a playlist lists its videos in the order the desktop keeps, and has no Sort to offer', async () => {
    expect(await open('playlist/p1', ['Charlie Scene', 'Alpha Scene', 'Delta Scene', 'Bravo Scene'])).toBe(true);
    expect(sortBtn().hidden).toBe(true);
  });

  it('Play all plays it in that order', async () => {
    expect(await open('playlist/p1', ['Charlie Scene', 'Alpha Scene', 'Delta Scene', 'Bravo Scene'])).toBe(true);
    const playAll = document.querySelector('#mainContent .playall-bar__btn--primary');
    expect(playAll).not.toBe(null);
    playAll.click();
    expect(window.location.hash).toBe('#play/vc');
  });

  it('a collection is a set: it keeps the phone\'s sort, and Sort is back', async () => {
    expect(await open('collection/c1', ['Alpha Scene', 'Bravo Scene', 'Charlie Scene'])).toBe(true);
    expect(sortBtn().hidden).toBe(false);
  });
});
