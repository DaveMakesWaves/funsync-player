// CB-23 (block B verification, FT-022 follow-up): while the phone's first
// /api/remote/sources request was still on its way, a search typed in the
// meantime sent a second one (+1.7 s in the verifier's run), with a second
// /videos beside it, and when the load landed the list on screen was swapped
// for skeletons for the 200 ms dwell and back: a flash.
//
// Cause: loadLibrary() returned the cached list once it had one but did not
// share a load still on its way, so every render that asked before it landed
// started its own pair; and renderList() painted skeletons on EVERY render,
// list in memory or not, so the re-render when the search context landed (and
// every search keystroke after that) blanked the list for 200 ms.
//
// Drives the REAL phone SPA (index.html + app.js) against a fake backend and
// watches what #mainContent shows, as web-remote-search-sources-load.test.js
// does.
//
// jsdom (no docblock): app.js queries the DOM at import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

const SOURCE = 'C:\\Users\\sandboxuser\\AppData\\Local\\Temp\\funsync-sandbox\\library';
const video = (id, name) => ({
  id,
  name,
  path: `${SOURCE}\\${name}.mp4`,
  hasFunscript: false,
  hasSubtitle: false,
  duration: 8,
  avgSpeed: null,
  maxSpeed: null,
  dateAdded: 0,
  sourceName: 'Library',
  streamUrl: `/api/media/stream/${id}`,
  scriptUrl: null,
  subtitleUrl: null,
  thumbUrl: `/api/media/thumb/${id}`,
  variants: [],
  manualVRType: null,
});

const server = {
  videos: [video('a', 'Alpha Clip'), video('b', 'Bravo Clip'), video('c', 'Charlie Clip')],
  sourcesGate: null,
  calls: { videos: 0, sources: 0 },
};

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function fakeFetch(input) {
  const url = String(input?.url ?? input);
  const p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/videos') {
    server.calls.videos++;
    return json({ videos: structuredClone(server.videos) });
  }
  if (p === '/api/remote/sources') {
    server.calls.sources++;
    if (server.sourcesGate) await server.sourcesGate;
    return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  }
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
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

const main = () => document.getElementById('mainContent');
const shown = () => [...main().querySelectorAll('.card__title, .list__title')].map((el) => el.textContent);
const hasSkeleton = () => main().querySelector('.skeleton') != null;

// Every state #mainContent passes through, as a user would see it.
let frames = [];
let observer;
function record() {
  frames.push({ skeleton: hasSkeleton(), titles: shown().join('|') });
}

function search(text) {
  const input = document.getElementById('searchInput');
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

let openSources;
beforeAll(async () => {
  const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  globalThis.fetch = vi.fn(fakeFetch);
  observer = new MutationObserver(record);
  observer.observe(main(), { childList: true, subtree: true });
  // The source list answers late, as in the verifier's run (held 3 s).
  server.sourcesGate = new Promise((r) => { openSources = r; });
  await import('../../backend/web-remote/app.js');
  window.dispatchEvent(new Event('load'));
});

afterAll(() => {
  observer?.disconnect();
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('the phone loads the library once, and never flashes skeletons over a list it has (CB-23)', () => {
  it('a search typed while /sources is on its way shares the load: one /sources, one /videos', async () => {
    await waitFor(() => server.calls.sources === 1);
    await sleep(50);
    search('clip');
    // Long enough for the render the search starts to ask for the library.
    await sleep(300);
    expect(server.calls.sources).toBe(1);
    expect(server.calls.videos).toBe(1);
    expect(hasSkeleton()).toBe(true); // still loading: skeletons are right here

    frames = [];
    openSources();
    server.sourcesGate = null;
    expect(await waitFor(() => shown().length === 3)).toBe(true);
    // The search context lands right after and re-renders the search;
    // the old code painted skeletons for 200 ms there.
    await sleep(600);
    expect(shown()).toEqual(['Alpha Clip', 'Bravo Clip', 'Charlie Clip']);
    const firstList = frames.findIndex((f) => f.titles !== '');
    expect(firstList).toBeGreaterThanOrEqual(0);
    expect(frames.slice(firstList).filter((f) => f.skeleton)).toEqual([]);
    // And still exactly one of each request.
    expect(server.calls.sources).toBe(1);
    expect(server.calls.videos).toBe(1);
  });

  it('a search keystroke over a loaded list swaps the results without a skeleton in between', async () => {
    // Stand-alone: the load has landed even if the first case failed early.
    openSources();
    server.sourcesGate = null;
    await waitFor(() => shown().length === 3);
    await sleep(300);
    const videosBefore = server.calls.videos;
    frames = [];
    search('bravo');
    expect(await waitFor(() => shown().join() === 'Bravo Clip')).toBe(true);
    search('');
    expect(await waitFor(() => shown().length === 3)).toBe(true);
    await sleep(300);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((f) => f.skeleton)).toEqual([]);
    expect(server.calls.videos).toBe(videosBefore);
  });

  it('Refresh still fetches afresh, with skeletons while it loads', async () => {
    const before = { ...server.calls };
    frames = [];
    document.getElementById('refreshBtn').click();
    expect(await waitFor(() => server.calls.videos > before.videos && server.calls.sources > before.sources)).toBe(true);
    expect(await waitFor(() => shown().length === 3)).toBe(true);
    expect(frames.some((f) => f.skeleton)).toBe(true);
  });
});
