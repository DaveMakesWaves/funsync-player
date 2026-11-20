// FN-04 fix-up after block F verify-1 (medium, also in v0.9.2): a video whose
// only scripts are hand-added variations (no script of its own). The desktop
// lists them in /api/remote/videos, but the phone gated everything on
// `hasFunscript`: it said "No funscript — playing video only", showed no list
// and opened no sync session, so nothing reached a device (sandbox
// "Manual Only", shot f1-34). The phone now treats a listed variation as a
// script: it opens the session (the desktop starts it on the first one, or
// the pinned one, tests/unit/phone-variations.test.js), lists them with the
// desktop's names and draws the first one's heatmap.
//
// Drives the REAL phone SPA (index.html + app.js) against a fake backend; only
// the WebSocket sync client is a fake, so the test sees the session open and
// the switch the phone asks for. jsdom (no docblock): app.js queries the DOM
// at import.
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
// What backend/routes/remote.py sends for it: no script of its own, the two
// hand-added variations, neither the main one.
const manualOnly = {
  id: 'mo', name: 'Manual Only',
  path: `${SOURCE}\\Manual Only.mp4`,
  hasFunscript: false, hasSubtitle: false, duration: 60, avgSpeed: null, maxSpeed: null, dateAdded: 0,
  sourceName: 'Library',
  streamUrl: '/api/media/stream/mo',
  scriptUrl: null,
  subtitleUrl: null,
  thumbUrl: '/api/media/thumb/mo',
  variants: [
    { label: 'Manual Pick A', text: 'Manual Pick A', main: false, scriptUrl: '/api/media/script/mo?variant=Manual%20Pick%20A' },
    { label: 'Manual Pick B', text: 'Manual Pick B', main: false, scriptUrl: '/api/media/script/mo?variant=Manual%20Pick%20B' },
  ],
  manualVRType: null,
};
// Control: a video with no script and nothing listed stays "no funscript".
const bare = { ...manualOnly, id: 'bare', name: 'Bare Clip', path: `${SOURCE}\\Bare Clip.mp4`, variants: [],
  streamUrl: '/api/media/stream/bare', thumbUrl: '/api/media/thumb/bare' };

const ACTIONS = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }];
const scriptFetches = [];
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const url = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '');
  const [p] = url.split('?');
  if (p === '/api/remote/videos') return json({ videos: [manualOnly, bare] });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p === '/api/remote/locale') return json({ locale: 'en' });
  if (p === '/locales/en.json') return json(EN);
  if (p === '/api/media/script/mo') { scriptFetches.push(url); return json({ actions: ACTIONS }); }
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
  expect(await waitFor(() => [...document.querySelectorAll('#mainContent .card__title')].some((e) => e.textContent === 'Manual Only'), 15000)).toBe(true);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

const pill = () => document.querySelector('#mainContent .player__sync-pill, #mainContent [data-state]');
const chipText = () => document.querySelector('#mainContent .player__variant-chip-label')?.textContent ?? null;
const rows = () => [...document.querySelectorAll('#mainContent .player__variant-row')].map((row) => ({
  name: row.querySelector('.player__variant-row-name')?.textContent ?? null,
  main: row.querySelector('.player__variant-row-main')?.textContent ?? null,
  checked: row.querySelector('input').checked,
}));

describe('FN-04: the phone plays a video whose only scripts are hand-added variations', () => {
  it('opens a sync session, lists both by name with the first one on, and draws its heatmap', async () => {
    window.location.hash = 'play/mo';
    expect(await waitFor(() => clients.length === 1 && chipText() != null)).toBe(true);
    expect(clients[0].opts.videoId).toBe('mo');
    expect(chipText()).toBe('Manual Pick A');
    expect(rows()).toEqual([
      { name: 'Manual Pick A', main: null, checked: true },
      { name: 'Manual Pick B', main: null, checked: false },
    ]);
    expect(document.querySelector('#mainContent .player__heatmap')).not.toBeNull();
    expect(await waitFor(() => scriptFetches.some((u) => u.includes('variant=Manual%20Pick%20A')))).toBe(true);
    // Not the "no funscript" pill of a video with nothing to sync.
    expect(document.querySelector('#mainContent [data-state="noscript"]')).toBeNull();
  });

  it('tapping the other one asks the desktop for it by its label', () => {
    const input = [...document.querySelectorAll('#mainContent .player__variant-row input')][1];
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clients[0].switches).toEqual(['Manual Pick B']);
  });

  it('control: a video with no script and nothing listed says so and opens no session', async () => {
    window.location.hash = 'play/bare';
    expect(await waitFor(() => document.querySelector('#mainContent [data-state="noscript"]') != null)).toBe(true);
    expect(clients).toHaveLength(1);
    expect(document.querySelector('#mainContent .player__variant-chip')).toBeNull();
    expect(pill()?.textContent).toBe(EN.webRemote.player.noScript);
  });
});
