/**
 * @vitest-environment jsdom
 * jsdom: the phone app renders its player into the page; i18n branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Test day 2026-11-26: on the phone, a video its browser cannot play (an
// Xvid AVI, WMV, MPEG-2...) sat at 0:00 with a play button that did nothing:
// the <video> errored and nothing was said. Now it says why and what to do
// (Convert to play on the PC; the backend then serves that copy, which
// plays). A network error is not this (it has its own handling).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class { constructor(opts) { this.opts = opts; } start() {} stop() {} },
}));

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const SOURCE = 'C:\\Lib';
const video = (id, name) => ({
  id, name, path: `${SOURCE}\\${name}`, hasFunscript: false, hasSubtitle: false, duration: 30,
  avgSpeed: 0, maxSpeed: 0, dateAdded: 0, sourceName: 'Library',
  streamUrl: `/api/media/stream/${id}`, scriptUrl: null, subtitleUrl: null, thumbUrl: `/api/media/thumb/${id}`,
  variants: [], manualVRType: null,
});
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/videos') return json({ videos: [video('avi', 'Classic Xvid.avi'), video('mp4', 'Fine.mp4')] });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p.startsWith('/locales/')) return json(EN);
  return json({ detail: 'not found' }, 404);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

beforeAll(async () => {
  localStorage.clear();
  const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.HTMLMediaElement.prototype.load = function load() {};
  window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function pause() {};
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = vi.fn(fakeFetch);
  await import('../../backend/web-remote/app.js');
  window.dispatchEvent(new Event('load'));
});
afterAll(() => { vi.restoreAllMocks(); delete globalThis.fetch; });

const playerVideo = () => document.querySelector('#mainContent video.player__video');
const note = () => document.querySelector('#mainContent .player__note--error');
function fail(el, code) {
  Object.defineProperty(el, 'error', { configurable: true, get: () => ({ code }) });
  el.dispatchEvent(new Event('error'));
}

describe('the phone, a video its browser cannot play', () => {
  it('a format it cannot decode or open (MediaError 3 / 4): says why and what to do', async () => {
    window.location.hash = 'play/avi';
    expect(await waitFor(() => playerVideo() != null && note() != null)).toBe(true);
    expect(note().hidden).toBe(true);
    fail(playerVideo(), 4);
    expect(note().hidden).toBe(false);
    expect(note().getAttribute('role')).toBe('alert');
    expect(note().textContent).toMatch(/can't play this video's format.*Convert to play/);
  });

  it('a network error (MediaError 2) is not that: nothing said here', async () => {
    window.location.hash = 'play/mp4';
    expect(await waitFor(() => playerVideo()?.src.includes('/mp4') && note() != null)).toBe(true);
    fail(playerVideo(), 2);
    expect(note().hidden).toBe(true);
  });
});
