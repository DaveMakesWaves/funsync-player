// The phone gets the subtitles inside a video file too (#268 thirstyduck500,
// 2026-11-23), and a CC button for them:
//   - a video with no subtitle file beside it asks /api/media/subtitle/{id}/tracks
//     and gets a <track> per TEXT track (picture ones left out), labelled as
//     the desktop labels them, fetched from /api/media/subtitle/{id}/track/{n};
//   - the CC button is there once the video has a track; each press steps
//     Off, then each track, then Off (a subtitle file beside the video could
//     not be turned off on the phone before);
//   - the phone's copy of subtitle-tracks.js agrees with the desktop's.
//
// Drives the REAL phone SPA (index.html + app.js) against a fake backend, as
// web-remote-edge-button.test.js does. jsdom (no docblock): app.js queries
// the DOM at import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as desk from '../../renderer/js/subtitle-tracks.js';
import * as phoneCopy from '../../backend/web-remote/subtitle-tracks.js';

vi.mock('../../backend/web-remote/remote-sync.js', () => ({
  RemoteSyncClient: class {
    constructor(opts) { this.opts = opts; }
    start() {}
    stop() {}
  },
}));

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const SOURCE = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const VIDEO = {
  id: 'mk', name: 'Film', path: `${SOURCE}\\Film.mkv`,
  hasFunscript: false, hasSubtitle: false, duration: 8, avgSpeed: null, maxSpeed: null, dateAdded: 0,
  sourceName: 'Library', streamUrl: '/api/media/stream/mk', scriptUrl: null, subtitleUrl: null,
  thumbUrl: '/api/media/thumb/mk', variants: [], manualVRType: null,
};
const TRACKS = [
  { index: 2, codec: 'subrip', language: 'eng', title: '', default: false, forced: false, text: true },
  { index: 3, codec: 'subrip', language: 'jpn', title: 'Signs', default: true, forced: false, text: true },
  { index: 4, codec: 'hdmv_pgs_subtitle', language: 'eng', title: '', default: false, forced: false, text: false },
];
const asked = [];

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  asked.push(p);
  if (p === '/api/remote/locale') return json({ locale: 'en', theme: 'dark' });
  if (p === '/locales/en.json') return json(EN);
  if (p === '/api/remote/videos') return json({ videos: [structuredClone(VIDEO)] });
  if (p === '/api/remote/sources') return json({ sources: [{ id: 's1', name: 'Library', path: SOURCE }] });
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
  if (p === '/api/media/subtitle/mk/tracks') return json({ tracks: TRACKS });
  return json({ detail: 'not found' }, 404);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

let app;
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
  app = await import('../../backend/web-remote/app.js');
  window.dispatchEvent(new Event('load'));
  window.location.hash = 'play/mk';
  expect(await waitFor(() => document.querySelectorAll('#mainContent video track').length > 0)).toBe(true);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
  localStorage.clear();
});

describe('a video with no subtitle file beside it', () => {
  it('gets a track per text track inside it, labelled and fetched by id; picture ones left out', () => {
    expect(asked).toContain('/api/media/subtitle/mk/tracks');
    const tracks = [...document.querySelectorAll('#mainContent video track')];
    expect(tracks.map((el) => el.label)).toEqual(['English', 'Signs (Japanese)']);
    expect(tracks.map((el) => el.getAttribute('src'))).toEqual(['/api/media/subtitle/mk/track/2', '/api/media/subtitle/mk/track/3']);
    expect(tracks.every((el) => el.kind === 'subtitles')).toBe(true);
    // The one the file marks default starts on, through the `default`
    // attribute: a mode set at once let Chromium's own selection switch
    // EVERY track on (seen live on the phone page, 2026-11-23).
    expect(tracks.map((el) => el.default)).toEqual([false, true]);
    const src = fs.readFileSync('backend/web-remote/app.js', 'utf8');
    const fn = src.slice(src.indexOf('export async function addEmbeddedSubtitleTracks'), src.indexOf('export function buildSubtitleButton'));
    expect(fn).toContain('el.default = !!(choice?.show && choice.track === tr);');
    expect(fn).not.toMatch(/\.mode = /);
  });
});

describe('the CC button', () => {
  // jsdom has no TextTrackList: a stand-in video with real-shaped tracks.
  function fakeVideo(labels) {
    const listeners = {};
    const textTracks = labels.map((label) => ({ label, mode: 'disabled' }));
    textTracks.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
    return { textTracks, fire: (type) => (listeners[type] || []).forEach((fn) => fn()) };
  }

  it('hidden until there is a track; then each press steps Off, each track, Off', () => {
    const v = fakeVideo([]);
    const btn = app.buildSubtitleButton(v);
    expect(btn.hidden).toBe(true);
    v.textTracks.push({ label: 'English', mode: 'disabled' }, { label: 'Signs (Japanese)', mode: 'disabled' });
    v.fire('addtrack');
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Subtitles: Off');
    const showing = () => v.textTracks.filter((tr) => tr.mode === 'showing').map((tr) => tr.label);
    btn.click();
    expect(showing()).toEqual(['English']);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Subtitles: English');
    btn.click();
    expect(showing()).toEqual(['Signs (Japanese)']);
    btn.click();
    expect(showing()).toEqual([]);
    expect(btn.getAttribute('aria-label')).toBe('Subtitles: Off');
  });

  it('a subtitle file beside the video (shown at once, no label) can now be turned off', () => {
    const v = fakeVideo(['']);
    v.textTracks[0].mode = 'showing';
    const btn = app.buildSubtitleButton(v);
    expect(btn.getAttribute('aria-label')).toBe('Subtitles: Subtitles');
    btn.click();
    expect(v.textTracks[0].mode).toBe('disabled');
    btn.click();
    expect(v.textTracks[0].mode).toBe('showing');
  });

  it('sits in the control bar before Fullscreen; the icon is Lucide "captions"', () => {
    const src = fs.readFileSync('backend/web-remote/app.js', 'utf8');
    expect(src).toMatch(/const ccBtn = buildSubtitleButton\(videoEl\);\n\s+btnRow\.append\(playBtn, muteBtn, spacer, \.\.\.\(flatBtn \? \[flatBtn\] : \[\]\), ccBtn, fsBtn\);/);
    const icons = fs.readFileSync('backend/web-remote/icons.js', 'utf8');
    expect(icons).toContain('captions: \'<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>\'');
  });
});

describe("the phone's copy of the track helpers agrees with the desktop's", () => {
  const t = (key, p) => (key === 'player.subtitles.track' ? `Track ${p.n}` : "pictures, can't be shown");
  const codes = ['eng', 'jpn', 'kor', 'chi', 'zho', 'ger', 'deu', 'fre', 'fra', 'spa', 'rus', 'ita', 'por', 'dut', 'nld',
    'pol', 'swe', 'nor', 'dan', 'fin', 'tur', 'ara', 'heb', 'hin', 'tha', 'vie', 'ind', 'ukr', 'ces', 'cze', 'hun', 'gre',
    'ell', 'rum', 'ron', 'und', '', 'xyz', 'en', 'EN'];
  for (const locale of ['en', 'de', 'ja']) {
    it(`language names (${locale})`, () => {
      for (const c of codes) expect(phoneCopy.languageName(c, locale), c).toBe(desk.languageName(c, locale));
    });
  }
  it('labels, the pick, and which files are asked about', () => {
    for (const [i, tr] of TRACKS.entries()) expect(phoneCopy.subtitleTrackLabel(tr, i + 1, t)).toBe(desk.subtitleTrackLabel(tr, i + 1, t));
    expect(phoneCopy.subtitleTrackLabel({ language: '', title: '', text: true }, 5, t)).toBe('Track 5');
    for (const list of [TRACKS, TRACKS.slice(0, 1), [TRACKS[2]], []]) expect(phoneCopy.pickEmbeddedTrack(list)).toEqual(desk.pickEmbeddedTrack(list));
    for (const p of ['a.mkv', 'a.MP4', 'a.m4v', 'a.mov', 'a.webm', 'a.avi', 'stream:x/y', '']) {
      expect(phoneCopy.mayHaveEmbeddedSubtitles(p), p).toBe(desk.mayHaveEmbeddedSubtitles(p));
    }
  });
});
