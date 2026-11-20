// The phone's Edge button (next major, Dave 2026-11-17: "yes"). The phone
// had an Orgasm button only; it now has a hold-to-edge button next to it,
// with the Orgasm button's press-and-hold contract:
//   - pointer down = the press; pointer up, cancel, leave, a hidden page or
//     pagehide = the release (hold mode); toggle mode acts on a tap;
//   - shown when (and only when) the Orgasm button is shown;
//   - its look follows the desktop's 'edge-state' { active, mode };
//   - its words come through the phone's i18n (renderer/locales).
// The desktop's half (the message reaching _onEdgeHold) is in
// remote-edge-hold.test.js.
//
// This drives the REAL phone SPA (index.html + app.js) against a fake
// backend, in German; only the WebSocket sync client is a fake, so the test
// sees what the page sends and can hand it the desktop's messages. The real
// client's wire message is checked at the end. jsdom (no docblock): app.js
// queries the DOM at import.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';

const clients = [];
vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; this.sent = []; clients.push(this); }
    start() {}
    stop() {}
    sendOrgasmHold(active) { this.sent.push(['orgasm', active]); }
    sendEdgeHold(active) { this.sent.push(['edge', active]); }
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
  window.HTMLMediaElement.prototype.pause = function pause() {};
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
});

describe('the Edge button sits next to the Orgasm button', () => {
  it('one row, Orgasm then Edge, in German', () => {
    expect(edgeBtn().parentElement).toBe(orgasmBtn().parentElement);
    expect(edgeBtn().parentElement.className).toBe('player__hold-row');
    expect(orgasmBtn().nextElementSibling).toBe(edgeBtn());
    expect(edgeBtn().type).toBe('button');
    expect(edgeBtn().textContent).toBe(DE.webRemote.player.edgeHold);
  });

  it('shown with the Orgasm button, hidden with it', () => {
    fromDesktop({ type: 'orgasm-state', configured: false, active: false, mode: 'hold' });
    expect(orgasmBtn().hidden).toBe(true);
    expect(edgeBtn().hidden).toBe(true);
    fromDesktop({ type: 'orgasm-state', configured: true, active: false, mode: 'hold' });
    expect(edgeBtn().hidden).toBe(false);
  });
});

describe('hold mode: pointer down is the press, every way of letting go is the release', () => {
  for (const ending of ['pointerup', 'pointercancel', 'pointerleave']) {
    it(`down then ${ending}: one press, one release`, () => {
      fire(edgeBtn(), 'pointerdown');
      fire(edgeBtn(), ending);
      fire(edgeBtn(), ending); // a second end sends nothing more
      expect(edgeSent()).toEqual([true, false]);
    });
  }

  it('a page that goes hidden lets go', () => {
    fire(edgeBtn(), 'pointerdown');
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(edgeSent()).toEqual([true, false]);
  });

  it('pagehide lets go', () => {
    fire(edgeBtn(), 'pointerdown');
    window.dispatchEvent(new Event('pagehide'));
    expect(edgeSent()).toEqual([true, false]);
  });

  it('no press, no release: a stray up or a hidden page sends nothing', () => {
    fire(edgeBtn(), 'pointerup');
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(edgeSent()).toEqual([]);
  });

  it('a tap\'s click sends nothing more in hold mode', () => {
    fire(edgeBtn(), 'pointerdown');
    fire(edgeBtn(), 'pointerup');
    fire(edgeBtn(), 'click');
    expect(edgeSent()).toEqual([true, false]);
  });

  it('the Orgasm button is its own: pressing Edge sends no Orgasm hold, and the other way round', () => {
    fire(edgeBtn(), 'pointerdown');
    fire(edgeBtn(), 'pointerup');
    fire(orgasmBtn(), 'pointerdown');
    fire(orgasmBtn(), 'pointerup');
    expect(client().sent).toEqual([['edge', true], ['edge', false], ['orgasm', true], ['orgasm', false]]);
  });

  it('the desktop\'s state sets its words and look (Release to resume)', () => {
    fromDesktop({ type: 'edge-state', active: true, mode: 'hold' });
    expect(edgeBtn().textContent).toBe(DE.webRemote.player.edgeRelease);
    expect(edgeBtn().classList.contains('player__edge-btn--active')).toBe(true);
    fromDesktop({ type: 'edge-state', active: false, mode: 'hold' });
    expect(edgeBtn().textContent).toBe(DE.webRemote.player.edgeHold);
    expect(edgeBtn().classList.contains('player__edge-btn--active')).toBe(false);
  });
});

describe('toggle mode (the desktop says so)', () => {
  beforeEach(() => {
    fromDesktop({ type: 'edge-state', active: false, mode: 'toggle' });
    client().sent.length = 0;
  });

  it('a tap is the press; pointer down and up send nothing', () => {
    expect(edgeBtn().textContent).toBe(DE.webRemote.player.edgeTap);
    fire(edgeBtn(), 'pointerdown');
    fire(edgeBtn(), 'pointerup');
    expect(edgeSent()).toEqual([]);
    fire(edgeBtn(), 'click');
    expect(edgeSent()).toEqual([true]);
  });

  it('on: "Tap to resume", and the next tap is a press too (the desktop flips it)', () => {
    fromDesktop({ type: 'edge-state', active: true, mode: 'toggle' });
    expect(edgeBtn().textContent).toBe(DE.webRemote.player.edgeResume);
    fire(edgeBtn(), 'click');
    expect(edgeSent()).toEqual([true]);
  });

  it('a hidden page does not end a toggled Edge', () => {
    fromDesktop({ type: 'edge-state', active: true, mode: 'toggle' });
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(edgeSent()).toEqual([]);
  });
});

describe('the real sync client puts it on the wire', () => {
  it('sendEdgeHold sends { type: "edge-hold", active } (as sendOrgasmHold sends orgasm-hold)', async () => {
    const { RemoteSyncClient } = await vi.importActual('../../backend/web-remote/remote-sync.js');
    const sent = [];
    const real = Object.create(RemoteSyncClient.prototype);
    real._send = (m) => sent.push(m);
    real.sendEdgeHold(true);
    real.sendEdgeHold(0);
    real.sendOrgasmHold(true);
    expect(sent).toEqual([
      { type: 'edge-hold', active: true },
      { type: 'edge-hold', active: false },
      { type: 'orgasm-hold', active: true },
    ]);
  });
});

describe('every locale has the four Edge button strings', () => {
  it('real words in all 8, never the English in another language', () => {
    for (const lang of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const p = bundle(lang).webRemote.player;
      for (const k of ['edgeHold', 'edgeRelease', 'edgeTap', 'edgeResume']) {
        expect(typeof p[k], `${lang} ${k}`).toBe('string');
        expect(p[k].length).toBeGreaterThan(0);
        if (lang !== 'en') expect(p[k], `${lang} ${k}`).not.toBe(EN.webRemote.player[k]);
      }
    }
  });
});
