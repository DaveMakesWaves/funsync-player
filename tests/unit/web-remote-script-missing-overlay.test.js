// Block C fix-up (2026-11-06, real-app verifier 2; also in v0.9.2): the
// phone's "Switching script…" overlay stayed up after the desktop answered
// `script-missing`. The phone shows the overlay, and pauses its video, on
// `script-loading`; only `script-ready` hid it. A desktop that cannot read
// the script (C-06's failed read sends script-loading, then script-missing)
// left the overlay over a paused video, 8 s later still, under the "Desktop
// couldn't find a matching script" pill.
//
// This drives the REAL phone SPA (index.html + app.js) against a fake
// backend; only the WebSocket sync client is a fake, so the test can hand the
// page the desktop's messages. What is asserted is what the phone shows and
// does: the overlay, the pill, and whether its video plays. jsdom (no
// docblock): app.js queries the DOM at import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

const clients = [];
vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; clients.push(this); }
    start() {}
    stop() {}
  },
}));

const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const video = (id, name) => ({
  id, name,
  path: `${SOURCE}\\${name}.mp4`,
  hasFunscript: true, hasSubtitle: false, duration: 8, avgSpeed: 100, maxSpeed: 200, dateAdded: 0,
  sourceName: 'Library',
  streamUrl: `/api/media/stream/${id}`,
  scriptUrl: `/api/media/script/${id}`,
  subtitleUrl: null,
  thumbUrl: `/api/media/thumb/${id}`,
  variants: [], manualVRType: null,
});

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/videos') return json({ videos: [video('sq', 'Square OU')] });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [] });
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

let playCalls = 0;
beforeAll(async () => {
  localStorage.clear();
  const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  // jsdom has no media playback: a `paused` flag the page's play/pause flip.
  Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
    configurable: true, get() { return this._paused !== false; },
  });
  window.HTMLMediaElement.prototype.load = function load() {};
  window.HTMLMediaElement.prototype.play = function play() { playCalls++; this._paused = false; return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function pause() { this._paused = true; };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = vi.fn(fakeFetch);
  await import('../../backend/web-remote/app.js');
  window.dispatchEvent(new Event('load'));
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

const overlay = () => document.querySelector('#mainContent .player__loading-overlay');
const playerVideo = () => document.querySelector('#mainContent video.player__video');

describe('script-missing ends the "Switching script…" overlay', () => {
  it('script-loading shows it and pauses; script-missing hides it, says no script, and the video plays on', async () => {
    window.location.hash = 'play/sq';
    expect(await waitFor(() => playerVideo() != null && clients.length === 1)).toBe(true);
    const el = playerVideo();
    const send = (msg) => clients[0].opts.onServerMessage(msg);
    await el.play();                              // the phone is playing
    playCalls = 0;

    send({ type: 'script-loading', videoId: 'sq' });
    expect(overlay().hidden).toBe(false);
    expect(el.paused).toBe(true);

    send({ type: 'script-missing', videoId: 'sq' });
    expect(overlay().hidden).toBe(true);
    const pill = document.querySelector('#mainContent [data-state]');
    expect(pill?.dataset.state).toBe('nomatch');
    expect(playCalls).toBe(1);                    // the pause was the overlay's: undone
    expect(el.paused).toBe(false);
  });

  it('a user who paused before the switch is not played behind their back', async () => {
    const el = playerVideo();
    const send = (msg) => clients[0].opts.onServerMessage(msg);
    el.pause();
    playCalls = 0;
    send({ type: 'script-loading', videoId: 'sq' });
    send({ type: 'script-missing', videoId: 'sq' });
    expect(overlay().hidden).toBe(true);
    expect(playCalls).toBe(0);
    expect(el.paused).toBe(true);
  });
});
