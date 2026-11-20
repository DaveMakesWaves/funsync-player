// CB-24 (found under FT-022, also in v0.9.2): the phone sorted names with
// bare localeCompare while the desktop uses compareNames (natural numbers,
// case ignored, 'en' collation). So "Clip 10" came before "Clip 2" on the
// phone and after it on the desktop: the same library in two orders, against
// the search-parity rule (same algorithm, options and sort on both).
//
// The first block runs the desktop and phone modules on the same names and
// requires the same order; the second drives the REAL phone SPA and reads the
// order its Library list and folder views show (the folder rows sorted their
// labels with localeCompare too).
//
// jsdom (no docblock): the second block imports app.js, which queries the
// DOM at import.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import * as desktop from '../../renderer/js/library-search.js';
import * as phone from '../../backend/web-remote/library-search.js';

const names = (list) => list.map((v) => v.name);
const asVideos = (list) => list.map((name, i) => ({ name, path: `C:\\Lib\\${i}\\${name}` }));

// Numbers of different widths, case, accents, a CJK name, a tie under
// 'base' sensitivity ("clip 1" / "Clip 1") and an empty name.
const NAMES = [
  'Clip 10.mp4', 'Clip 2.mp4', 'clip 1.mp4', 'Clip 1.mp4', 'Clip 1b.mp4', 'Clip 100.mp4',
  'Épisode 4.mp4', 'episode 30.mp4', '中文 视频 2.mp4', 'Zulu.mp4', 'alpha 3.mp4', 'Alpha 20.mp4', '',
];

describe('phone and desktop sort names the same way (CB-24)', () => {
  it('the phone exports the desktop comparator: same answer on every pair', () => {
    for (const a of NAMES) {
      for (const b of NAMES) {
        expect(Math.sign(phone.compareNames(a, b)), `${a} vs ${b}`).toBe(Math.sign(desktop.compareNames(a, b)));
      }
    }
  });

  it('Name A-Z and Z-A give the same order on both, with natural numbers', () => {
    const videos = asVideos(NAMES);
    for (const dir of ['asc', 'desc']) {
      expect(names(phone.sortVideos(videos, 'name', dir)), dir).toEqual(names(desktop.sortVideos(videos, 'name', dir)));
    }
    const clips = asVideos(['Clip 10.mp4', 'Clip 2.mp4', 'Clip 1.mp4', 'Clip 100.mp4']);
    expect(names(phone.sortVideos(clips, 'name', 'asc'))).toEqual(['Clip 1.mp4', 'Clip 2.mp4', 'Clip 10.mp4', 'Clip 100.mp4']);
    expect(names(phone.sortVideos(clips, 'name', 'desc'))).toEqual(['Clip 100.mp4', 'Clip 10.mp4', 'Clip 2.mp4', 'Clip 1.mp4']);
  });

  it('search results that score the same are ordered the same on both', () => {
    const videos = asVideos(NAMES);
    for (const q of ['clip', 'episode', 'alpha', 'mp4']) {
      expect(names(phone.fuzzySearch(videos, q)), q).toEqual(names(desktop.fuzzySearch(videos, q)));
    }
    // Every "clip" name is a prefix hit (same score): the tie is the name.
    expect(names(phone.fuzzySearch(asVideos(['Clip 10.mp4', 'Clip 2.mp4', 'Clip 1.mp4']), 'clip')))
      .toEqual(['Clip 1.mp4', 'Clip 2.mp4', 'Clip 10.mp4']);
  });
});

// R3-28 (also in v0.9.2): the two sides sort different KEYS. The desktop's
// video `name` is the file name with its extension (library-scan.js:
// `name: entry.name`); the phone's comes from /api/remote/videos, which
// sends the stem (backend/routes/remote.py list_videos:
// `os.path.splitext(name)[0] or name`). Comparing names gave "Alpha Scene
// (copy).mp4" before "Alpha Scene.mp4" on the desktop (space before dot) and
// "Alpha Scene" before "Alpha Scene (copy)" on the phone. The block above
// feeds both modules the SAME strings, so it never saw this. Here each side
// gets the objects it really sorts, and the order (by path, the one thing
// both carry unchanged) must be the same: name without its extension first,
// as Windows Explorer lists them, then the extension.
const pyStem = (file) => {
  // Python's os.path.splitext: the last dot, leading dots ignored.
  const i = file.lastIndexOf('.');
  return i > 0 && /[^.]/.test(file.slice(0, i)) ? file.slice(0, i) : file;
};
const FILES = [
  'Bravo Duplicate - renamed.mp4', 'Alpha Scene (copy).mp4', 'Clip.mp4', 'Scene.v2.mp4', 'clip 10.mp4',
  'Alpha Scene.mp4', 'Bravo Duplicate.mp4', 'Clip.mkv', 'Scene.mp4', 'Clip 2.MP4', 'Épisode 4.mp4', '中文 2.mp4',
];
const LIB = 'C:\\Users\\sandboxuser\\funsync-sandbox\\library';
const desktopVideos = FILES.map((f) => ({ name: f, path: `${LIB}\\${f}` }));
const phoneVideos = [...FILES]
  .sort((a, b) => pyStem(a).toLowerCase().localeCompare(pyStem(b).toLowerCase())) // the backend's own order
  .map((f) => ({ name: pyStem(f), path: `${LIB}\\${f}` }));
const files = (list) => list.map((v) => v.path.split('\\').pop());

describe('Name A-Z: the desktop and the phone agree on their real objects (R3-28)', () => {
  it('the phone objects really are stems (the fixture matches what /api/remote/videos sends)', () => {
    expect(phoneVideos.find((v) => v.path.endsWith('\\Scene.v2.mp4')).name).toBe('Scene.v2');
    expect(phoneVideos.find((v) => v.path.endsWith('\\Alpha Scene (copy).mp4')).name).toBe('Alpha Scene (copy)');
  });

  it('A-Z: name without extension (natural), then extension; same order on both', () => {
    const want = [
      'Alpha Scene.mp4', 'Alpha Scene (copy).mp4', 'Bravo Duplicate.mp4', 'Bravo Duplicate - renamed.mp4',
      'Clip.mkv', 'Clip.mp4', 'Clip 2.MP4', 'clip 10.mp4', 'Épisode 4.mp4', 'Scene.mp4', 'Scene.v2.mp4', '中文 2.mp4',
    ];
    expect(files(desktop.sortVideos(desktopVideos, 'name', 'asc'))).toEqual(want);
    expect(files(phone.sortVideos(phoneVideos, 'name', 'asc'))).toEqual(want);
  });

  it('Z-A is A-Z reversed on both', () => {
    const asc = files(desktop.sortVideos(desktopVideos, 'name', 'asc'));
    expect(files(desktop.sortVideos(desktopVideos, 'name', 'desc'))).toEqual([...asc].reverse());
    expect(files(phone.sortVideos(phoneVideos, 'name', 'desc'))).toEqual([...asc].reverse());
  });

  it('search results with the same score are tie-broken the same way on both', () => {
    for (const q of ['alpha', 'bravo', 'clip', 'scene']) {
      const d = files(desktop.fuzzySearch(desktopVideos, q));
      const p = files(phone.fuzzySearch(phoneVideos, q));
      expect(p, q).toEqual(d);
    }
    // Both Alpha Scene files score the same for "alpha": the plain one first.
    expect(files(phone.fuzzySearch(phoneVideos, 'alpha'))).toEqual(['Alpha Scene.mp4', 'Alpha Scene (copy).mp4']);
    expect(files(desktop.fuzzySearch(desktopVideos, 'alpha'))).toEqual(['Alpha Scene.mp4', 'Alpha Scene (copy).mp4']);
  });

  it('a name with a dot in it keeps it: "Scene.v2" is not cut to "Scene" on either side', () => {
    expect(desktop.videoNameKey(desktopVideos.find((v) => v.name === 'Scene.v2.mp4'))).toEqual({ stem: 'Scene.v2', ext: 'mp4' });
    expect(phone.videoNameKey(phoneVideos.find((v) => v.name === 'Scene.v2'))).toEqual({ stem: 'Scene.v2', ext: 'mp4' });
  });
});

// --- The phone SPA --------------------------------------------------------

const ROOT2 = 'C:\\Lib\\Set 2';
const ROOT10 = 'C:\\Lib\\Set 10';
const video = (id, name, dir) => ({
  id,
  name,
  path: `${dir}\\${name}.mp4`,
  hasFunscript: false,
  hasSubtitle: false,
  duration: 8,
  avgSpeed: null,
  maxSpeed: null,
  dateAdded: 0,
  sourceName: 'Lib',
  streamUrl: `/api/media/stream/${id}`,
  scriptUrl: null,
  subtitleUrl: null,
  thumbUrl: `/api/media/thumb/${id}`,
  variants: [],
  manualVRType: null,
});
const VIDEOS = [
  video('a', 'Clip 10', ROOT2),
  video('b', 'Clip 2', ROOT2),
  video('c', 'Clip 1', ROOT2),
  video('d', 'Part 10 A', `${ROOT10}\\Part 10`),
  video('e', 'Part 2 A', `${ROOT10}\\Part 2`),
  // R3-28: a name that is a prefix of another (the backend sends stems).
  video('f', 'Alpha Scene (copy)', ROOT2),
  video('g', 'Alpha Scene', ROOT2),
];
const SOURCES = [
  { id: 's10', name: 'Set 10', path: ROOT10 },
  { id: 's2', name: 'Set 2', path: ROOT2 },
];

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
async function fakeFetch(input) {
  const p = String(input?.url ?? input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (p === '/api/remote/videos') return json({ videos: structuredClone(VIDEOS) });
  if (p === '/api/remote/sources') return json({ sources: structuredClone(SOURCES) });
  if (p === '/api/remote/collections') return json({ collections: [] });
  if (p === '/api/remote/playlists') return json({ playlists: [] });
  if (p === '/api/remote/categories') return json({ categories: [] });
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
const listTitles = () => [...document.querySelectorAll('#mainContent .card__title, #mainContent .list__title')].map((el) => el.textContent);
const folderRows = () => [...document.querySelectorAll('#mainContent .grouping-row:not(.skeleton) .grouping-row__name')].map((el) => el.textContent);
function go(hash) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

describe('the phone shows natural order in its Library list and folder views (CB-24)', () => {
  beforeAll(async () => {
    localStorage.clear(); // default sort: Name A-Z
    const html = fs.readFileSync('backend/web-remote/index.html', 'utf8');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    window.matchMedia = window.matchMedia || ((q) => ({
      matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(fakeFetch);
    await import('../../backend/web-remote/app.js');
    window.dispatchEvent(new Event('load'));
  });

  afterAll(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it('Library, Name A-Z: Clip 1, Clip 2, Clip 10', async () => {
    expect(await waitFor(() => listTitles().length === 7)).toBe(true);
    expect(listTitles().filter((n) => n.startsWith('Clip'))).toEqual(['Clip 1', 'Clip 2', 'Clip 10']);
    // R3-28: the shorter name first, as on the desktop since R3-28.
    expect(listTitles().filter((n) => n.startsWith('Alpha'))).toEqual(['Alpha Scene', 'Alpha Scene (copy)']);
  });

  it('folder browse: source folders and subfolders in natural order', async () => {
    go('folder');
    expect(await waitFor(() => folderRows().length === 2)).toBe(true);
    expect(folderRows()).toEqual(['Set 2', 'Set 10']);

    go(`folder/${encodeURIComponent('C:/Lib/Set 10'.replace(/^C/, 'c'))}`);
    expect(await waitFor(() => folderRows().length === 2)).toBe(true);
    expect(folderRows()).toEqual(['Part 2', 'Part 10']);
  });
});
