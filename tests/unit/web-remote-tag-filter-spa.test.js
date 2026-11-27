// The phone's Tags filter (P1 tags, Round 3, 2026-11-18), on the page: the
// REAL phone SPA (index.html + app.js), the desktop set to German, the REAL
// locale bundles, and /api/remote/tags answering the slice the desktop sent
// (backend routes/remote.py list_tags). Asserted is what the phone draws:
// the sheet's Tags section (facet names and the length unit in German, tag
// values as given), the cards that stay, the chips and the badge, and what
// it stores. Only the WebSocket sync client is a fake.
//
// Rules pinned (Dave, 2026-11-17, DESIGN-video-options.md answers 4 and 5):
// the phone filters with the desktop's algorithm (OR within a facet, AND
// across facets: web-remote/tag-filter.js), search does not match tags, and
// the tag filter is not remembered across launches.
//
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

const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const video = (id, name) => ({
  id, name, path: `${SOURCE}\\${name}.mp4`,
  hasFunscript: true, hasSubtitle: false, duration: 60, avgSpeed: 100, maxSpeed: 200, dateAdded: 0,
  sourceName: 'Library', streamUrl: `/api/media/stream/${id}`, scriptUrl: `/api/media/script/${id}`,
  subtitleUrl: null, thumbUrl: `/api/media/thumb/${id}`, variants: [], manualVRType: null,
});
const VIDEOS = [
  video('a', 'Alpha Scene'),
  video('b', 'Bravo Scene'),
  video('c', 'Charlie Clip'),
  video('d', 'Delta Clip'),
  video('e', 'Echo POV Night'),
];
const P = Object.fromEntries(VIDEOS.map((v) => [v.id, v.path]));
const EVIL = '<img src=x onerror="window.__pwned=1">';
const TAGS = {
  videoTags: {
    [P.a]: ['device:the-handy', 'content:pov'],
    [P.b]: ['content:pov', 'length:10-25'],
    [P.c]: ['device:osr2', `content:${EVIL}`],
    // Delta and Echo: no tags from any source.
  },
  tags: [
    { key: 'length:10-25', facet: 'length', label: '10-25', count: 1 },
    { key: 'device:osr2', facet: 'device', label: 'osr2', count: 1 },
    { key: 'device:the-handy', facet: 'device', label: 'the handy', count: 1 },
    { key: 'content:pov', facet: 'content', label: 'pov', count: 2 },
    { key: `content:${EVIL}`, facet: 'content', label: EVIL, count: 1 },
  ],
};

let tagFetches = 0;
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/locale') return json({ locale: 'de', theme: 'dark' });
  if (p === '/locales/de.json') return json(DE);
  if (p === '/locales/en.json') return json(EN);
  if (p === '/api/remote/videos') return json({ videos: structuredClone(VIDEOS) });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p === '/api/remote/tags') { tagFetches += 1; return json(structuredClone(TAGS)); }
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
const showsOnly = (names) => waitFor(() => titles().join('|') === names.join('|'));
const chips = () => [...document.querySelectorAll('#filterChips .filter-chip')];
const tagBox = (key) => [...document.querySelectorAll('#tagFilterFacets input[type="checkbox"]')].find((i) => i.value === key);
function tick(key, on = true) {
  const box = tagBox(key);
  box.checked = on;
  box.dispatchEvent(new Event('change', { bubbles: true }));
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
  await waitFor(() => document.documentElement.lang === 'de' && titles().length === 5);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
  localStorage.clear();
});

describe('the phone\u2019s Tags filter (P1 tags)', () => {
  it('nothing about tags is fetched or shown before the filter sheet opens', () => {
    expect(titles()).toEqual(['Alpha Scene', 'Bravo Scene', 'Charlie Clip', 'Delta Clip', 'Echo POV Night']);
    expect(tagFetches).toBe(0);
    expect(document.getElementById('tagFilterGroup').hidden).toBe(true);
  });

  it('the sheet shows the desktop\u2019s groups, facet names and the length unit in German', async () => {
    document.getElementById('filtersBtn').click();
    expect(await waitFor(() => !document.getElementById('tagFilterGroup').hidden)).toBe(true);
    expect(tagFetches).toBe(1);
    expect(document.getElementById('tagFilterTitle').textContent).toBe(DE.webRemote.filterSheet.tagsHeader);
    const groups = [...document.querySelectorAll('#tagFilterFacets .sheet__tag-facet-title')].map((h) => h.textContent);
    expect(groups).toEqual([DE.tags.facet.length, DE.tags.facet.device, DE.tags.facet.content]);
    expect(groups).toEqual(['Länge', 'Gerät', 'Inhalt']);
    const lengthRow = tagBox('length:10-25').closest('label');
    expect(lengthRow.textContent).toContain('10-25 Min.');
    expect(tagBox('content:pov').getAttribute('aria-label')).toBe('pov, 2 Videos');
  });

  it('a tag name is text, never markup', () => {
    const row = tagBox(`content:${EVIL}`).closest('label');
    expect(row.textContent).toContain(EVIL);
    expect(document.querySelector('#tagFilterFacets img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  it('one tag narrows the list; its chip reads German and the badge counts it', async () => {
    tick('content:pov');
    expect(await showsOnly(['Alpha Scene', 'Bravo Scene'])).toBe(true);
    expect(chips().map((c) => c.textContent.trim())).toEqual(['Inhalt: pov']);
    expect(chips()[0].getAttribute('aria-label')).toBe(DE.webRemote.filterChips.removeAria.replace('{label}', 'Inhalt: pov'));
    const badge = document.getElementById('filtersBadge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
  });

  it('every ticked tag must be on the video, as the desktop\u2019s filterByTags (Dave 2026-11-22)', async () => {
    tick('device:the-handy');                              // pov AND the handy
    expect(await showsOnly(['Alpha Scene'])).toBe(true);
    tick('device:osr2');                                   // no video has all three
    expect(await showsOnly([])).toBe(true);
    tick('content:pov', false);                            // the handy AND osr2: still none
    expect(await showsOnly([])).toBe(true);
    expect(document.getElementById('filtersBadge').textContent).toBe('2');
  });

  it('removing a chip unticks its tag and widens the list', async () => {
    const osr = chips().find((c) => c.textContent.includes('osr2'));
    osr.click();
    expect(await showsOnly(['Alpha Scene'])).toBe(true);
    expect(tagBox('device:osr2').checked).toBe(false);
    expect(tagBox('device:the-handy').checked).toBe(true);
  });

  it('the tag filter is never stored (not remembered across launches)', () => {
    // A stored change (the view toggle) writes the phone's UI state.
    document.getElementById('viewToggle').click();
    document.getElementById('viewToggle').click();
    const stored = JSON.parse(localStorage.getItem('funsync.remote.ui') || '{}');
    expect(stored.view).toBeDefined();
    expect(stored).not.toHaveProperty('tags');
    expect(JSON.stringify(stored)).not.toContain('the-handy');
  });

  it('search does not match tags: "pov" finds the video NAMED pov, not the ones tagged pov', async () => {
    chips().forEach((c) => c.click());
    expect(await showsOnly(['Alpha Scene', 'Bravo Scene', 'Charlie Clip', 'Delta Clip', 'Echo POV Night'])).toBe(true);
    const input = document.getElementById('searchInput');
    input.value = 'pov';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(await showsOnly(['Echo POV Night'])).toBe(true);
    input.value = 'the handy';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(await waitFor(() => titles().length === 0)).toBe(true);
    document.getElementById('searchClear').click();
  });

  it('Refresh keeps a picked tag working while the slice is fetched again', async () => {
    tick('content:pov');
    expect(await showsOnly(['Alpha Scene', 'Bravo Scene'])).toBe(true);
    const before = tagFetches;
    document.getElementById('refreshBtn').click();
    expect(await waitFor(() => tagFetches === before + 1)).toBe(true);
    expect(await showsOnly(['Alpha Scene', 'Bravo Scene'])).toBe(true);
  });
});
