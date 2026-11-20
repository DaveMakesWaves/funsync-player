// R3-29 (found while CB-23, phone): the phone's library load kicks off two
// background fetches that re-render an active search when they land: the
// search context (collections / playlists / categories) and a retried
// /api/remote/sources when the first one failed. Both called render(), which
// is a VIEW CHANGE: it stops the open sync client and rebuilds the view. With
// a search still set and the player opened in the meantime, the context (or
// the retried source list) landing cut the device off mid-video and replaced
// the <video> under the user. They re-render only the list on screen now
// (rerenderCurrent), which is a no-op on the player view.
//
// This drives the REAL phone SPA (index.html + app.js) against a fake
// backend; only the WebSocket sync client is a fake, so the test can see
// whether it was stopped. jsdom (no docblock): app.js queries the DOM at
// import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

const clients = [];
vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; this.started = 0; this.stopped = 0; clients.push(this); }
    start() { this.started++; }
    stop() { this.stopped++; }
  },
}));

const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const video = (id, name, hasFunscript) => ({
  id,
  name,
  path: `${SOURCE}\\${name}.mp4`,
  hasFunscript,
  hasSubtitle: false,
  duration: 8,
  avgSpeed: 100,
  maxSpeed: 200,
  dateAdded: 0,
  sourceName: 'Library',
  streamUrl: `/api/media/stream/${id}`,
  scriptUrl: hasFunscript ? `/api/media/script/${id}` : null,
  subtitleUrl: null,
  thumbUrl: `/api/media/thumb/${id}`,
  variants: [],
  manualVRType: null,
});

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const server = {
  videos: [video('a', 'Alpha Scene', true), video('b', 'Bravo Clip', true)],
  sourcesCalls: 0,
  sourcesRetry: gate(),      // the second /sources answers when the test says
  collections: gate(),       // the search context lands when the test says
};

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/videos') return json({ videos: structuredClone(server.videos) });
  if (p === '/api/remote/sources') {
    server.sourcesCalls++;
    if (server.sourcesCalls === 1) return json({ detail: 'busy' }, 500); // the first one fails
    await server.sourcesRetry.p;
    return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  }
  if (p === '/api/remote/collections') { await server.collections.p; return json({ collections: [] }); }
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p.startsWith('/api/media/script/')) return json({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] });
  return json({ detail: 'not found' }, 404);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}
const shown = () => [...document.querySelectorAll('#mainContent .card__title, #mainContent .list__title')].map((el) => el.textContent);
const playerVideo = () => document.querySelector('#mainContent video.player__video');
// jsdom fires `hashchange` itself for a hash assignment; dispatching one too
// would render the view twice (and open two sync clients).
function go(hash) {
  window.location.hash = hash;
}
function search(text) {
  const input = document.getElementById('searchInput');
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

beforeAll(async () => {
  localStorage.clear();
  const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  // jsdom has no media playback; the player only needs these not to throw.
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
  server.sourcesRetry.open();
  server.collections.open();
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('a background re-render never touches the open player (R3-29)', () => {
  it('search set, player opened, then the retried /sources and the search context land: same player, sync never stopped', async () => {
    // The library is in (the first /sources failed, its retry and the
    // search context are still on their way) and a search is active.
    expect(await waitFor(() => shown().length === 2)).toBe(true);
    search('alpha');
    expect(await waitFor(() => shown().join() === 'Alpha Scene')).toBe(true);
    expect(server.sourcesCalls).toBe(2); // the retry is pending

    // The user opens the video (search still set, as it stays for Back).
    go('play/a');
    expect(await waitFor(() => playerVideo() != null && clients.length === 1)).toBe(true);
    const el = playerVideo();
    const client = clients[0];
    expect(client.started).toBe(1);

    // The retried source list lands: before R3-29 this re-ran render().
    server.sourcesRetry.open();
    await sleep(400);
    expect(client.stopped, 'sync client stopped by the /sources retry').toBe(0);
    expect(clients).toHaveLength(1);
    expect(playerVideo()).toBe(el);

    // The search context lands: same.
    server.collections.open();
    await sleep(400);
    expect(client.stopped, 'sync client stopped by the search context').toBe(0);
    expect(clients).toHaveLength(1);
    expect(playerVideo()).toBe(el);
    expect(location.hash).toBe('#play/a');
  });

  it('back on the list, the landed context and roots are used: the search still finds by name', async () => {
    go('');
    expect(await waitFor(() => shown().join() === 'Alpha Scene')).toBe(true);
    // Leaving the player is the one thing that stops its sync client.
    expect(clients[0].stopped).toBe(1);
  });
});
