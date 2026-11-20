// FT-022: the phone's search matched WHOLE paths until /api/remote/sources
// answered, and again after a phone Refresh whose rescan changed the list.
//
// Path hits are scored from each source folder down (app test V35), so a word
// that only appears ABOVE the source folder (`appdata`, the Windows user
// name) must match nothing. That needs the source roots. The phone fetched
// them in the background AFTER the library, so a search typed before they
// answered listed every video; and the rescan branch dropped them while
// keeping the library, so loadLibrary() returned early and never fetched them
// again.
//
// No pure-function test can see this: library-search-path-scope.test.js pins
// fuzzySearch given roots. This drives the REAL phone SPA (index.html +
// app.js) against a fake backend and reads what the list shows.
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
  sourcesGate: null,          // a Promise the /sources answer waits on
  sourcesCalls: 0,
};

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function fakeFetch(input) {
  const url = String(input?.url ?? input);
  const p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/videos') return json({ videos: structuredClone(server.videos) });
  if (p === '/api/remote/sources') {
    server.sourcesCalls++;
    if (server.sourcesGate) await server.sourcesGate;
    return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  }
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p === '/api/remote/request-rescan') return json({ ok: true, counter: 1 });
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

/** Titles of the real (non-skeleton) cards or rows on screen. */
const shown = () => [...document.querySelectorAll('#mainContent .card__title, #mainContent .list__title')]
  .map((el) => el.textContent);

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
  // The source list answers late, as it does when the phone's first two
  // requests race on a busy LAN.
  server.sourcesGate = new Promise((r) => { openSources = r; });
  await import('../../backend/web-remote/app.js');
  window.dispatchEvent(new Event('load'));
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('phone search is scoped to the source folders from the first keystroke', () => {
  it('a word from above the source folder lists nothing while /sources is still on its way', async () => {
    await waitFor(() => fetch.mock.calls.some((c) => String(c[0]).includes('/api/remote/videos')));
    await sleep(50);
    search('appdata');
    // Long enough for the 120 ms debounce, the 200 ms skeleton dwell and a
    // render on the old code, which showed all three videos here.
    await sleep(600);
    expect(shown()).toEqual([]);

    openSources();
    server.sourcesGate = null;
    await waitFor(() => document.querySelector('#mainContent .empty') != null);
    await sleep(300);
    expect(shown()).toEqual([]);
    // And the scope does not hide what IS under the source folder.
    search('library');
    expect(await waitFor(() => shown().length === 3)).toBe(true);
    search('bravo');
    expect(await waitFor(() => shown().join() === 'Bravo Clip')).toBe(true);
  });

  it('still lists nothing for that word after a phone Refresh whose rescan adds a file', async () => {
    // Stand-alone: the roots are in before the Refresh, even if the first
    // case failed before it let /sources answer.
    openSources();
    server.sourcesGate = null;
    await sleep(300);
    search('appdata');
    await sleep(400);
    expect(shown()).toEqual([]);

    const videoFetches = () => fetch.mock.calls.filter((c) => String(c[0]).includes('/api/remote/videos')).length;
    const fetchesBefore = videoFetches();
    const callsBefore = server.sourcesCalls;
    document.getElementById('refreshBtn').click();
    // The desktop's rescan lands after the phone's immediate re-fetch, so
    // the phone's poll (first try 1.5 s later) is what sees the new file.
    await sleep(300);
    server.videos.push(video('d', 'Delta Clip'));
    expect(await waitFor(() => videoFetches() >= fetchesBefore + 2, 4000)).toBe(true);
    await sleep(600);
    expect(shown()).toEqual([]);
    expect(server.sourcesCalls).toBeGreaterThan(callsBefore);

    // The fresh list really was adopted: the new file is searchable.
    search('delta');
    expect(await waitFor(() => shown().join() === 'Delta Clip')).toBe(true);
  }, 10000);
});
