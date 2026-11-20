// FT-063, on the page: the REAL phone SPA (index.html + app.js), the desktop
// set to German (/api/remote/locale), the REAL locale bundles served at
// /locales/<lang>.json, and Matched + Non-VR remembered from the last visit.
// What is asserted is what the phone draws: the chips' text and aria-labels,
// and the aria-label of the player's variant list. All three were English
// literals in app.js. Only the WebSocket sync client is a fake.
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

const bundle = (lang) => JSON.parse(fs.readFileSync(`renderer/locales/${lang}.json`, 'utf8'));
// The two aria-label keys are new in FT-063 and reach the locale files in
// the strings stage. A key not there yet is filled with a MARKED stand-in, so
// the test still tells "read from the bundle" from "the old English literal";
// a key that is there is always its real value.
function withNewKeys(b, lang) {
  const out = structuredClone(b);
  const mark = lang === 'en' ? '' : `[${lang}] `;
  out.webRemote.filterChips.removeAria ??= `${mark}Remove filter: {label}`;
  out.webRemote.player.variantListAria ??= `${mark}Funscript variant`;
  return out;
}
const DE = withNewKeys(bundle('de'), 'de');
const EN = withNewKeys(bundle('en'), 'en');

const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const VIDEO = {
  id: 'vc', name: 'Variant Clip',
  path: `${SOURCE}\\Variant Clip.mp4`,
  hasFunscript: true, hasSubtitle: false, duration: 8, avgSpeed: 100, maxSpeed: 200, dateAdded: 0,
  sourceName: 'Library',
  streamUrl: '/api/media/stream/vc',
  scriptUrl: '/api/media/script/vc',
  subtitleUrl: null,
  thumbUrl: '/api/media/thumb/vc',
  variants: [
    { label: 'Default', name: 'Variant Clip.funscript' },
    { label: 'soft', name: 'Variant Clip (soft).funscript' },
  ],
  manualVRType: null,
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

beforeAll(async () => {
  localStorage.clear();
  localStorage.setItem('funsync.remote.ui', JSON.stringify({ tab: 'matched', vr: 'flat' }));
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
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
  localStorage.clear();
});

const chips = () => [...document.querySelectorAll('#filterChips .filter-chip')];

describe('the phone in German (FT-063)', () => {
  it('the Matched and Non-VR chips read German, aria-labels too', async () => {
    expect(await waitFor(() => document.documentElement.lang === 'de' && chips().length === 2
      && chips()[0].textContent.trim() === DE.webRemote.filterSheet.matchMatched)).toBe(true);
    const [tab, vr] = chips();
    expect(tab.textContent.trim()).toBe('Zugeordnet');
    expect(vr.textContent.trim()).toBe('Kein VR');
    const aria = (label) => DE.webRemote.filterChips.removeAria.replace('{label}', label);
    expect(tab.getAttribute('aria-label')).toBe(aria('Zugeordnet'));
    expect(vr.getAttribute('aria-label')).toBe(aria('Kein VR'));
    for (const el of [tab, vr]) {
      expect(el.getAttribute('aria-label')).not.toMatch(/^Remove filter: /);
    }
  });

  it('the player\'s variant list is labelled from the bundle, not the English literal', async () => {
    window.location.hash = 'play/vc';
    expect(await waitFor(() => document.querySelector('#mainContent .player__variant-list') != null)).toBe(true);
    const list = document.querySelector('#mainContent .player__variant-list');
    expect(list.getAttribute('aria-label')).toBe(DE.webRemote.player.variantListAria);
    expect(list.getAttribute('aria-label')).not.toBe('Funscript variant');
  });
});
