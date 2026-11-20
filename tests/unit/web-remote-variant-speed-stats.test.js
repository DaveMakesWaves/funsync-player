// E2-02 (verify-3 of E-09, cosmetic, also in v0.9.2): on the phone, the Avg /
// Max speed stats under the heatmap always described the video's MAIN
// script. app.js drew them once from the library's `avgSpeed` / `maxSpeed`
// and a variant switch (the phone's own pick, the desktop's, or E-09's
// pinned variant at the start of a session) only redrew the heatmap. Variant
// Clip opened on "soft" read Avg 300 / Max 300; soft is about 67 units/s.
//
// This drives the REAL phone SPA (index.html + app.js + heatmap.js) against
// a fake backend; only the WebSocket sync client is a fake, so the test can
// hand the page the desktop's `variant-changed`. What is asserted is what the
// phone shows under the heatmap. jsdom (no docblock): app.js queries the DOM
// at import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

const clients = [];
vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; clients.push(this); }
    start() {}
    stop() {}
    switchVariant() {}
  },
}));

const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const variantClip = {
  id: 'vc', name: 'Variant Clip',
  path: `${SOURCE}\\Variant Clip.mp4`,
  // The library's numbers: the main script's (the backend's speed probe).
  hasFunscript: true, hasSubtitle: false, duration: 60, avgSpeed: 300, maxSpeed: 300, dateAdded: 0,
  sourceName: 'Library',
  streamUrl: '/api/media/stream/vc',
  scriptUrl: '/api/media/script/vc',
  subtitleUrl: null,
  thumbUrl: '/api/media/thumb/vc',
  variants: [
    { label: 'Default', scriptUrl: '/api/media/script/vc?variant=Default' },
    { label: 'soft', scriptUrl: '/api/media/script/vc?variant=soft' },
    { label: 'gone', scriptUrl: '/api/media/script/vc?variant=gone' },
  ],
  manualVRType: null,
};

// 0 -> 100 in 333 ms: 300 units/s. Soft: three strokes of 1500 ms (67 units/s)
// and one of 1000 ms (100, its peak): avg 75, max 100.
const MAIN = [{ at: 0, pos: 0 }, { at: 333, pos: 100 }, { at: 666, pos: 0 }];
const SOFT = [{ at: 0, pos: 0 }, { at: 1500, pos: 100 }, { at: 3000, pos: 0 }, { at: 4500, pos: 100 }, { at: 5500, pos: 0 }];

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const url = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '');
  const [p, query = ''] = url.split('?');
  if (p === '/api/remote/videos') return json({ videos: [variantClip] });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p === '/api/media/script/vc') {
    if (query === 'variant=soft') return json({ actions: SOFT });
    if (query === 'variant=gone') return json({ detail: 'Funscript not found' }, 404);
    return json({ actions: MAIN });
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
  // The first router pass waits for i18n (seconds under vitest): open the
  // player after it, as a phone user can only tap a card it has drawn. A
  // hash set before it lands under the list it then draws.
  // The real list, not its skeleton cards.
  expect(await waitFor(() => document.querySelector('#mainContent .card__title')?.textContent === 'Variant Clip', 15000)).toBe(true);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

const row = () => document.querySelector('#mainContent .player__speed');
/** [avg, max] as the phone shows them, or null when the row is hidden. */
const shown = () => {
  const r = row();
  if (!r || r.hidden) return null;
  return [...r.querySelectorAll('.player__speed-stat strong')].map((s) => Number(s.textContent));
};
const tone = () => row()?.querySelector('.player__speed-badge')?.className.match(/speed-(\w+)/)?.[1] ?? null;
const desktopSays = (label) => clients.at(-1).opts.onServerMessage({ type: 'variant-changed', label });

describe('the phone\'s speed stats follow the script the heatmap shows (E2-02)', () => {
  it('opens on the main script\'s numbers', async () => {
    window.location.hash = 'play/vc';
    expect(await waitFor(() => clients.length === 1 && shown() != null)).toBe(true);
    expect(shown()).toEqual([300, 300]);
    expect(tone()).toBe('fast');
  });

  it('the desktop starts the pinned "soft" variant: the stats are soft\'s, not the main script\'s', async () => {
    desktopSays('soft');
    expect(await waitFor(() => shown()?.[0] === 75)).toBe(true);
    expect(shown()).toEqual([75, 100]);
    expect(tone()).toBe('slow');
    expect(document.querySelector('#mainContent .player__variant-chip-label').textContent).toBe('soft');
  });

  it('back to Default: the main script\'s numbers again', async () => {
    desktopSays('Default');
    expect(await waitFor(() => shown()?.[0] === 300)).toBe(true);
    expect(shown()).toEqual([300, 300]);
  });

  it('a variant the phone cannot read shows no stats rather than the last script\'s', async () => {
    desktopSays('gone');
    expect(await waitFor(() => shown() == null)).toBe(true);
    desktopSays('soft');
    expect(await waitFor(() => shown()?.[0] === 75)).toBe(true);
  });
});
