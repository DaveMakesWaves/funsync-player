// FN-03 / FN-04 on the phone (Dave 2026-11-16: "yes variations should show
// on phone"; "the default means nothing"; also in v0.9.2). The phone showed
// each variation's raw label, so the video's own script read "Default" (in
// English, whatever the app's language), and it listed only the library
// scan's variations. /api/remote/videos now sends the desktop's list, the
// hand-added ones included, with the name the desktop shows (`text`) and the
// script the video opens on marked (`main`); see backend/tests/test_remote.py
// and tests/unit/phone-variations.test.js for the sending side.
//
// This drives the REAL phone SPA (index.html + app.js) against a fake
// backend; only the WebSocket sync client is a fake, so the test sees the
// switch the phone asks for and can hand it the desktop's `variant-changed`.
// What is asserted is what the phone shows and sends. jsdom (no docblock):
// app.js queries the DOM at import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

const clients = [];
vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; this.switches = []; clients.push(this); }
    start() {}
    stop() {}
    switchVariant(label) { this.switches.push(label); }
  },
}));

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const HARD = 'Hard & Fast+';
const clip = {
  id: 'vc', name: 'Variant Clip',
  path: `${SOURCE}\\Variant Clip.mp4`,
  hasFunscript: true, hasSubtitle: false, duration: 60, avgSpeed: 100, maxSpeed: 100, dateAdded: 0,
  sourceName: 'Library',
  streamUrl: '/api/media/stream/vc',
  scriptUrl: '/api/media/script/vc',
  subtitleUrl: null,
  thumbUrl: '/api/media/thumb/vc',
  // What backend/routes/remote.py sends now: the scan's two, then a
  // hand-added one with a free-text name (its label URL-quoted).
  variants: [
    { label: 'Default', text: 'Variant Clip', main: true, scriptUrl: '/api/media/script/vc?variant=Default' },
    { label: 'soft', text: 'soft', main: false, scriptUrl: '/api/media/script/vc?variant=soft' },
    { label: HARD, text: HARD, main: false, scriptUrl: '/api/media/script/vc?variant=Hard%20%26%20Fast%2B' },
  ],
  manualVRType: null,
};

const ACTIONS = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }];
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const url = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '');
  const [p] = url.split('?');
  if (p === '/api/remote/videos') return json({ videos: [clip] });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p === '/api/remote/locale') return json({ locale: 'en' });
  if (p === '/locales/en.json') return json(EN);
  if (p === '/api/media/script/vc') return json({ actions: ACTIONS });
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
  expect(await waitFor(() => document.querySelector('#mainContent .card__title')?.textContent === 'Variant Clip', 15000)).toBe(true);
  window.location.hash = 'play/vc';
  expect(await waitFor(() => clients.length === 1 && document.querySelector('#mainContent .player__variant-chip') != null)).toBe(true);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

const chipText = () => document.querySelector('#mainContent .player__variant-chip-label').textContent;
const rows = () => [...document.querySelectorAll('#mainContent .player__variant-row')].map((row) => ({
  name: row.querySelector('.player__variant-row-name')?.textContent ?? null,
  main: row.querySelector('.player__variant-row-main')?.textContent ?? null,
  checked: row.querySelector('input').checked,
}));
const desktopSays = (label) => clients.at(-1).opts.onServerMessage({ type: 'variant-changed', label });

describe('FN-03 / FN-04: the phone names every variation and lists the hand-added ones', () => {
  it('the chip and the list use the desktop\'s names: the main script by its file, marked main; no "Default"', () => {
    expect(chipText()).toBe('Variant Clip');
    expect(rows()).toEqual([
      { name: 'Variant Clip', main: EN.variants?.mainTag ?? 'variants.mainTag', checked: true },
      { name: 'soft', main: null, checked: false },
      { name: HARD, main: null, checked: false },
    ]);
    expect(document.querySelector('#mainContent .player__variant-list').textContent).not.toContain('Default');
  });

  it('tapping the hand-added one asks the desktop for it by its label', async () => {
    const input = [...document.querySelectorAll('#mainContent .player__variant-row input')][2];
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clients.at(-1).switches).toEqual([HARD]);
  });

  it('the desktop confirms it: the chip names it and its row is the checked one', async () => {
    desktopSays(HARD);
    expect(await waitFor(() => chipText() === HARD)).toBe(true);
    expect(rows().map((r) => r.checked)).toEqual([false, false, true]);
  });

  it('back to the main script: the chip names its file again, not "Default"', async () => {
    desktopSays('Default');
    expect(await waitFor(() => chipText() === 'Variant Clip')).toBe(true);
    expect(rows().map((r) => r.checked)).toEqual([true, false, false]);
  });
});
