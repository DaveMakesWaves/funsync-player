// The phone's Stop (design review, 2026-11-23; DESIGN.md §1.6 S1, §2.15): the
// desktop's Stop all from the thumb zone. It pauses the phone's own video at
// once and sends 'stop-all' to the desktop (whose half is in stop-all.test.js:
// remoteBridge.onPhoneStopAll -> stopEverything). The desktop's own Stop all
// sends 'stop-all' to the phone, which pauses its video. The button shows while
// the desktop reports a device ('device-status').
//
// This drives the REAL phone SPA (index.html + app.js), as
// web-remote-edge-button.test.js does (its rig, copied).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';

const clients = [];
const pauses = [];
vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; this.sent = []; clients.push(this); }
    start() {}
    stop() {}
    sendOrgasmHold(active) { this.sent.push(['orgasm', active]); }
    sendEdgeHold(active) { this.sent.push(['edge', active]); }
    sendStopAll() { this.sent.push(['stop-all']); }
  },
}));

const bundle = (lang) => JSON.parse(fs.readFileSync(`renderer/locales/${lang}.json`, 'utf8'));
const DE = bundle('de');
const EN = bundle('en');

const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const VIDEO = {
  id: 'eb', name: 'Edge Clip',
  path: `${SOURCE}\\Edge Clip.mp4`,
  hasFunscript: true, hasSubtitle: false, duration: 8, avgSpeed: 100, maxSpeed: 200, dateAdded: 0,
  sourceName: 'Library',
  streamUrl: '/api/media/stream/eb',
  scriptUrl: '/api/media/script/eb',
  subtitleUrl: null,
  thumbUrl: '/api/media/thumb/eb',
  variants: [], manualVRType: null,
};

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/locale') return json({ locale: 'de', theme: 'dark' });
  if (p === '/locales/de.json') return json(DE);
  if (p === '/locales/en.json') return json(EN);
  if (p === '/api/remote/videos') return json({ videos: [structuredClone(VIDEO)] });
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

const edgeBtn = () => document.querySelector('#mainContent .player__edge-btn');
const orgasmBtn = () => document.querySelector('#mainContent .player__orgasm-btn');
const client = () => clients.at(-1);
const edgeSent = () => client().sent.filter(([k]) => k === 'edge').map(([, a]) => a);
const fromDesktop = (msg) => client().opts.onServerMessage(msg);
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
const setVisibility = (state) => Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });

beforeAll(async () => {
  localStorage.clear();
  const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  window.HTMLMediaElement.prototype.load = function load() {};
  window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function pause() { pauses.push(this.className); };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = vi.fn(fakeFetch);
  await import('../../backend/web-remote/app.js');
  window.dispatchEvent(new Event('load'));
  window.location.hash = 'play/eb';
  expect(await waitFor(() => document.documentElement.lang === 'de' && edgeBtn() != null && clients.length > 0)).toBe(true);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
  localStorage.clear();
});

beforeEach(() => {
  setVisibility('visible');
  // Back to the desktop's defaults: hold mode, off, buttons shown.
  fromDesktop({ type: 'edge-state', active: false, mode: 'hold' });
  fromDesktop({ type: 'orgasm-state', configured: true, active: false, mode: 'hold' });
  client().sent.length = 0;
  pauses.length = 0;
});

const stopBtn = () => document.querySelector('#mainContent .player__stop-btn');
const video = () => document.querySelector('#mainContent .player__video');

describe('the phone Stop button', () => {
  it('sits in the hold row after X and Z, in the phone language, as a real button', () => {
    expect(stopBtn().parentElement.className).toBe('player__hold-row');
    expect(stopBtn().previousElementSibling).toBe(edgeBtn());
    expect(stopBtn().type).toBe('button');
    expect(stopBtn().textContent).toBe(DE.webRemote.player.stopAll);
    expect(stopBtn().getAttribute('aria-label')).toBe(DE.webRemote.player.stopAllAria);
  });

  it('shows while the desktop reports a device, and hides when none is left', () => {
    fromDesktop({ type: 'device-status', devices: [{ kind: 'tcode', label: 'TCode (UDP)', offsetMs: 0 }] });
    expect(stopBtn().hidden).toBe(false);
    fromDesktop({ type: 'device-status', devices: [] });
    expect(stopBtn().hidden).toBe(true);
    // An older desktop's booleans.
    fromDesktop({ type: 'device-status', handy: 'connected' });
    expect(stopBtn().hidden).toBe(false);
  });

  it('a tap pauses this video at once and sends stop-all to the desktop', () => {
    fromDesktop({ type: 'device-status', devices: [{ kind: 'handy', label: 'The Handy', offsetMs: 0 }] });
    stopBtn().click();
    expect(pauses).toContain(video().className);
    expect(client().sent).toEqual([['stop-all']]);
  });

  it("the desktop's Stop all pauses this video", () => {
    fromDesktop({ type: 'stop-all' });
    expect(pauses).toContain(video().className);
    expect(client().sent).toEqual([]);
  });
});
