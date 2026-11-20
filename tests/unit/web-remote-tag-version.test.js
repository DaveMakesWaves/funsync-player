// The phone picks up the desktop's tag changes without a Refresh (r3-fixup
// R3R-4, 2026-11-18). It fetched /api/remote/tags once per page (the first
// filter-sheet open) and kept it, so a tag added, hidden or harvested on the
// desktop afterwards never reached a phone page left open. Now each sheet
// open asks once, with the version it holds; the backend (routes/remote.py
// list_tags) answers "unchanged" or the new slice. Nothing polls.
//
// The REAL phone SPA (index.html + app.js) and locale bundle; fakes: fetch
// (answering as list_tags does, version included) and the WebSocket client.
// jsdom (no docblock): app.js queries the DOM at import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; }
    start() {}
    stop() {}
  },
}));

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const SOURCE = 'C:\\Sandbox\\library';
const video = (id, name) => ({
  id, name, path: `${SOURCE}\\${name}.mp4`, hasFunscript: true, hasSubtitle: false, duration: 60,
  avgSpeed: 100, maxSpeed: 200, dateAdded: 0, sourceName: 'Library', streamUrl: `/api/media/stream/${id}`,
  scriptUrl: `/api/media/script/${id}`, subtitleUrl: null, thumbUrl: `/api/media/thumb/${id}`, variants: [], manualVRType: null,
});
const VIDEOS = [video('a', 'Alpha Scene'), video('b', 'Bravo Scene'), video('c', 'Charlie Clip')];
const P = Object.fromEntries(VIDEOS.map((v) => [v.id, v.path]));

// What the backend holds: the desktop's slice and its version.
const server = { version: 'boot.1.1', videoTags: { [P.a]: ['content:pov'] } };
const tagRequests = [];
function slice() {
  const counts = new Map();
  for (const keys of Object.values(server.videoTags)) for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  return {
    videoTags: structuredClone(server.videoTags),
    tags: [...counts].map(([key, count]) => ({ key, facet: key.split(':')[0], label: key.split(':')[1], count })),
    version: server.version,
  };
}
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
async function fakeFetch(input) {
  const url = new URL(String(input?.url ?? input), 'http://phone.invalid');
  const p = url.pathname;
  if (p === '/api/remote/locale') return json({ locale: 'en', theme: 'dark' });
  if (p === '/locales/en.json') return json(EN);
  if (p === '/api/remote/videos') return json({ videos: structuredClone(VIDEOS) });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (['/api/remote/collections', '/api/remote/playlists', '/api/remote/categories'].includes(p)) {
    return json({ collections: [], playlists: [], categories: [] });
  }
  if (p === '/api/remote/tags') {
    const asked = url.searchParams.get('version');
    tagRequests.push(asked);
    if (asked !== null && asked === server.version) return json({ version: server.version, unchanged: true });
    return json(slice());
  }
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
const titles = () => [...document.querySelectorAll('#mainContent .card__title')].map((el) => el.textContent);
const tagKeys = () => [...document.querySelectorAll('#tagFilterFacets input[type="checkbox"]')].map((i) => i.value);
const tagBox = (key) => [...document.querySelectorAll('#tagFilterFacets input[type="checkbox"]')].find((i) => i.value === key);
async function openSheet() {
  const before = tagRequests.length;
  document.getElementById('filtersBtn').click();
  await waitFor(() => tagRequests.length > before);
  await sleep(60);
}

beforeAll(async () => {
  localStorage.clear();
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
  await waitFor(() => titles().length === 3);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
  localStorage.clear();
});

describe('a later sheet open checks the slice once', () => {
  it('the first open fetches the slice', async () => {
    expect(tagRequests).toEqual([]);
    await openSheet();
    expect(tagRequests).toEqual([null]);
    expect(tagKeys()).toEqual(['content:pov']);
  });

  it('opened again with nothing changed: one small "unchanged?" request, the same section', async () => {
    const box = tagBox('content:pov');
    await openSheet();
    expect(tagRequests).toEqual([null, 'boot.1.1']);
    expect(tagBox('content:pov')).toBeTruthy();
    expect(box).toBeTruthy();
  });

  it('a tag the desktop added since shows at the next open, without a Refresh', async () => {
    server.videoTags = { [P.a]: ['content:pov'], [P.b]: ['content:pov', 'device:osr2'] };
    server.version = 'boot.2.1';
    await openSheet();
    expect(tagRequests.at(-1)).toBe('boot.1.1');
    expect(await waitFor(() => tagKeys().includes('device:osr2'))).toBe(true);
  });

  it('a picked tag re-filters the list when the slice under it changed', async () => {
    const box = tagBox('content:pov');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await waitFor(() => titles().join('|') === 'Alpha Scene|Bravo Scene')).toBe(true);
    // The desktop hid pov on Alpha: the next open re-filters.
    server.videoTags = { [P.b]: ['content:pov', 'device:osr2'] };
    server.version = 'boot.3.1';
    await openSheet();
    expect(await waitFor(() => titles().join('|') === 'Bravo Scene')).toBe(true);
  });

  it('nothing asks while the sheet stays shut (no polling)', async () => {
    const before = tagRequests.length;
    await sleep(400);
    expect(tagRequests.length).toBe(before);
  });
});
