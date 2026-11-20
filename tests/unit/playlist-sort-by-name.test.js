/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its detail header
 * and grid, the sort button and the toast's Undo are clicked like a user.
 */
// Sort a playlist by name (GuthixUnsigned, EroScripts #370; app test V78).
//
// The playlist detail header gets one Sort button: "Sort by name, A-Z", or
// "Z-A" once the list already reads A-Z. It reorders through the same write
// as a drag or Move (DataService.setPlaylistVideoPaths -> store.js), with the
// project's natural collator ("Clip 2" before "Clip 10"), and the toast it
// raises has an Undo that puts the hand-made order back exactly.
//
// The whole write path is real: the REAL Playlists component over a REAL
// DataService whose IPC calls go straight into the REAL store.js on the REAL
// electron-conf, against a config.json in a temp userData dir. So "saved"
// means "in config.json", and store.js's pure-reorder guard is the one that
// ships.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});

const store = await import('../../electron/store.js');
const { DataService } = await import('../../renderer/js/data-service.js');
const { Playlists, sortPlaylistPathsByName, restorePlaylistOrder } = await import('../../renderer/components/playlists.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const B = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));
const useLocale = (l) => _setBundlesForTests(l, B[l], B.en);

const DIR = 'D:\\Mix\\';
// Hand-made order: nothing alphabetical about it. "Clip 10" vs "Clip 2" is
// where a plain string sort goes wrong; "bravo" (lower case) vs "Charlie" is
// where a case-sensitive one does.
const HAND = ['Delta.mp4', 'Clip 10.mp4', 'bravo.mkv', 'Alpha.mp4', 'Clip 2.mp4', 'Charlie.mp4'].map((n) => DIR + n);
const AZ = ['Alpha.mp4', 'bravo.mkv', 'Charlie.mp4', 'Clip 2.mp4', 'Clip 10.mp4', 'Delta.mp4'].map((n) => DIR + n);
const ZA = AZ.slice().reverse();
const WATCHED = DIR + 'Clip 10.mp4';
const PARTWAY = DIR + 'Charlie.mp4';
const LAST = DIR + 'bravo.mkv';

const configPath = () => path.join(h.userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));
const diskOrder = (id = 'p1') => onDisk().playlists.find((p) => p.id === id).videoPaths;

let container;
let toasts;
let savedFunsync;
let view;
let ds;

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** One app launch: config.json seeded, store + DataService booted, playlist detail open. */
async function openPlaylist({ videoPaths = HAND, extraPlaylists = [] } = {}) {
  fs.writeFileSync(configPath(), JSON.stringify({
    settings: {
      library: {
        resumePositions: {
          [WATCHED]: { position: 590, duration: 600, finished: true, updatedAt: 1 },
          [PARTWAY]: { position: 300, duration: 600, updatedAt: 2 },
        },
        playlistProgress: { p1: { lastVideoPath: LAST, updatedAt: 3 } },
      },
    },
    playlists: [{ id: 'p1', name: 'Evening', createdAt: 1, videoPaths }, ...extraPlaylists],
    categories: [],
    videoCategories: {},
    _migrated: true,
  }, null, 2));
  await store.initStore();

  // The preload bridge, reduced to the calls this view makes; each store call
  // is what main's ipcMain handler for it does.
  window.funsync = {
    getAllData: async () => store.getAll(),
    setSetting: async (p, v) => store.setSetting(p, v),
    setPlaylistVideoPaths: async (id, paths) => store.setPlaylistVideoPaths(id, paths),
    removeVideoFromPlaylist: async (id, p) => store.removeVideoFromPlaylist(id, p),
    addVideoToPlaylist: async (id, p) => store.addVideoToPlaylist(id, p),
    filesExist: async (paths) => paths.map(() => true),
    readFunscript: async () => null,
    getThumbnail: async () => null,
    generateSingleThumbnail: async () => null,
    readCustomThumbnail: async () => null,
  };
  ds = new DataService();
  await ds.init();

  view = new Playlists({
    settings: ds,
    library: { getVideoByPath: () => null },
    onPlayVideo: () => {},
    onPlayAll: () => {},
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  view._container = container;
  view._view = 'detail';
  view._detailPlaylistId = 'p1';
  view._viewMode = 'grid';
  await view._renderDetail('p1');
  await settle();
}

const sortBtn = () => container.querySelector('.playlists__sort-btn');
const shownOrder = () => [...container.querySelectorAll('.playlists__video-card .playlists__video-title')]
  .map((el) => el.title);
const cardFor = (p) => [...container.querySelectorAll('.playlists__video-card')]
  .find((c) => c.querySelector('.playlists__video-title').title === p);
const liveToasts = () => [...toasts.querySelectorAll('.toast')].filter((el) => !el.classList.contains('toast--out'));
const undoButton = () => liveToasts().map((el) => el.querySelector('.playlists__sort-undo')).find(Boolean) || null;

async function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
}

beforeEach(() => {
  useLocale('en');
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-playlist-sort-'));
  savedFunsync = window.funsync;
  toasts = document.createElement('div');
  toasts.id = 'toast-container';
  document.body.appendChild(toasts);
});

afterEach(() => {
  window.funsync = savedFunsync;
  container?.remove();
  toasts?.remove();
  try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('Sort by name in a playlist (V78)', () => {
  it('A-Z reorders by the shown name, naturally and ignoring case, and saves it to config.json', async () => {
    await openPlaylist();
    expect(shownOrder()).toEqual(HAND);
    expect(sortBtn().dataset.sortDir).toBe('asc');
    expect(sortBtn().getAttribute('aria-label')).toBe('Sort by name, A-Z');

    await click(sortBtn());

    expect(shownOrder()).toEqual(AZ);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(AZ);
    expect(diskOrder()).toEqual(AZ);
    const toast = liveToasts()[0];
    expect(toast.textContent).toContain('Sorted "Evening" by name, A-Z');
    expect(undoButton().textContent).toBe('Undo');
  });

  it('Undo puts the hand-made order back exactly, on screen and on disk, and closes the toast', async () => {
    await openPlaylist();
    await click(sortBtn());
    expect(diskOrder()).toEqual(AZ);

    await click(undoButton());

    expect(shownOrder()).toEqual(HAND);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(HAND);
    expect(diskOrder()).toEqual(HAND);
    expect(liveToasts()).toHaveLength(0);
  });

  // jsdom has no key activation, so the browser's is modelled: a keydown no
  // one cancelled activates the focused button (Enter on keypress, Space on
  // keyup), a cancelled one does nothing. The toast cancelled both, so for a
  // keyboard user the Undo closed the toast and kept the sort (V78 review).
  it.each([['Enter'], [' ']])('Undo from the keyboard: %j on the focused Undo button puts the order back', async (key) => {
    await openPlaylist();
    await click(sortBtn());
    expect(diskOrder()).toEqual(AZ);

    const btn = undoButton();
    btn.focus();
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    btn.dispatchEvent(e);
    if (!e.defaultPrevented) btn.click(); // the button's own activation
    await settle();

    expect(diskOrder()).toEqual(HAND);
    expect(shownOrder()).toEqual(HAND);
    expect(liveToasts()).toHaveLength(0);
  });

  it('once the list reads A-Z the button offers Z-A, which is A-Z reversed', async () => {
    await openPlaylist();
    await click(sortBtn());
    expect(sortBtn().dataset.sortDir).toBe('desc');
    expect(sortBtn().getAttribute('aria-label')).toBe('Sort by name, Z-A');

    await click(sortBtn());

    expect(shownOrder()).toEqual(ZA);
    expect(diskOrder()).toEqual(ZA);
    expect(liveToasts().map((el) => el.textContent).join(' ')).toContain('Sorted "Evening" by name, Z-A');
    expect(sortBtn().dataset.sortDir).toBe('asc');
  });

  it('A-Z then Z-A share one Undo, which goes back to the order before the FIRST sort', async () => {
    await openPlaylist();
    await click(sortBtn());
    await click(sortBtn());
    // The first toast made way for the second: one Undo on screen.
    expect(liveToasts()).toHaveLength(1);

    await click(undoButton());

    expect(shownOrder()).toEqual(HAND);
    expect(diskOrder()).toEqual(HAND);
  });

  it('the watched tick, the resume bar and the Last watched marker stay on their videos', async () => {
    await openPlaylist();
    const marks = () => ({
      watched: !!cardFor(WATCHED).querySelector('.playlists__watched-check'),
      partway: !!cardFor(PARTWAY).querySelector('.resume-bar'),
      bars: container.querySelectorAll('.resume-bar').length,
      last: !!cardFor(LAST).querySelector('.playlists__last-watched'),
      ticks: container.querySelectorAll('.playlists__watched-check').length,
      pills: container.querySelectorAll('.playlists__last-watched').length,
    });
    const before = marks();
    expect(before).toMatchObject({ watched: true, partway: true, last: true, ticks: 1, pills: 1 });

    await click(sortBtn());
    expect(marks()).toEqual(before);
    const disk = onDisk().settings.library;
    expect(disk.playlistProgress.p1.lastVideoPath).toBe(LAST);
    expect(disk.resumePositions[WATCHED].finished).toBe(true);
    expect(disk.resumePositions[PARTWAY].position).toBe(300);

    await click(undoButton());
    expect(marks()).toEqual(before);
  });

  it('a video removed after the sort stays removed on Undo, and the rest goes back to the hand order', async () => {
    await openPlaylist();
    await click(sortBtn());
    const gone = DIR + 'Alpha.mp4';
    cardFor(gone).querySelector('.playlists__video-remove-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(diskOrder()).not.toContain(gone);

    await click(undoButton());

    const expected = HAND.filter((p) => p !== gone);
    expect(shownOrder()).toEqual(expected);
    // store.js accepted it: a pure reorder of what the playlist holds now.
    expect(diskOrder()).toEqual(expected);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(expected);
  });

  it('a list view sorts the same way', async () => {
    await openPlaylist();
    view._viewMode = 'list';
    await view._renderDetail('p1');
    await settle();
    await click(sortBtn());
    const rows = [...container.querySelectorAll('.playlists__list-item')].map((r) => r.dataset.videoPath);
    expect(rows).toEqual(AZ);
    expect(diskOrder()).toEqual(AZ);
  });

  it('another playlist is untouched, and a one-video playlist has no Sort button', async () => {
    const other = { id: 'p2', name: 'Other', createdAt: 2, videoPaths: [DIR + 'Zulu.mp4', DIR + 'Alpha.mp4'] };
    await openPlaylist({ extraPlaylists: [other] });
    await click(sortBtn());
    expect(diskOrder('p2')).toEqual(other.videoPaths);

    container.remove();
    await openPlaylist({ videoPaths: [DIR + 'Only.mp4'] });
    expect(sortBtn()).toBeNull();
  });

  it('is in every locale', async () => {
    const seen = new Set();
    for (const locale of LOCALES) {
      useLocale(locale);
      await openPlaylist();
      const label = sortBtn().getAttribute('aria-label');
      await click(sortBtn());
      const text = liveToasts()[0].textContent;
      // The playlist's name is in the message (the placeholder was filled).
      expect(text, locale).toContain('Evening');
      expect(text, locale).not.toContain('{name}');
      expect(text, locale).toContain(B[locale].toast.undo);
      // Not the English text (a key missing from the locale falls back to it).
      if (locale !== 'en') expect(label, locale).not.toBe(B.en.playlists.sortAzTitle);
      seen.add(label);
      container.remove();
      toasts.replaceChildren();
    }
    expect(seen.size).toBe(8);
  });
});

// CB-14 (2026-11-05, found verifying block B; new since v0.9.2):
// DataService.setPlaylistVideoPaths wrote the order into its cache before
// asking main, and store.js refuses anything that is not a pure reorder, so a
// refused write left the cache (what every view reads) on a list config.json
// never got, until a restart. No UI path is known to send one; a stale or
// partial list is how it would happen. Same real write path as above.
describe('the cache follows what store.js kept (CB-14)', () => {
  it('a write store.js refuses leaves the cache on what config.json holds', async () => {
    await openPlaylist();
    const partial = HAND.slice(1).reverse(); // a stale list, one video short

    await ds.setPlaylistVideoPaths('p1', partial);

    expect(diskOrder()).toEqual(HAND); // refused
    expect(ds.getPlaylist('p1').videoPaths).toEqual(HAND); // and the cache agrees
  });

  it('a duplicate or an extra path is refused the same way', async () => {
    await openPlaylist();
    await ds.setPlaylistVideoPaths('p1', [...HAND, HAND[0]]);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(HAND);
    await ds.setPlaylistVideoPaths('p1', [...HAND, `${DIR}Elsewhere.mp4`]);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(HAND);
    expect(diskOrder()).toEqual(HAND);
  });

  it('a reorder is shown at once and is what both hold; two quick ones end on the second', async () => {
    await openPlaylist();
    const first = ds.setPlaylistVideoPaths('p1', AZ);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(AZ); // no wait for main
    const second = ds.setPlaylistVideoPaths('p1', ZA);
    await Promise.all([first, second]);
    expect(diskOrder()).toEqual(ZA);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(ZA);
  });
});

describe('sortPlaylistPathsByName / restorePlaylistOrder', () => {
  it('orders by the name without extension, then the file name, then the path, whatever the start order', () => {
    const paths = ['E:/b/Same.mp4', 'D:/a/Same.mkv', 'D:/a/Same.mp4', 'C:/x/same.mp4'];
    const a = sortPlaylistPathsByName(paths, 'asc');
    const b = sortPlaylistPathsByName(paths.slice().reverse(), 'asc');
    expect(a).toEqual(b);
    expect(a.slice(0, 1)).toEqual(['D:/a/Same.mkv']);
    expect(sortPlaylistPathsByName(paths, 'desc')).toEqual(a.slice().reverse());
  });

  it('Undo order: exact when nothing changed; removed videos dropped, added ones kept at the end', () => {
    expect(restorePlaylistOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
    expect(restorePlaylistOrder(['c', 'a', 'b'], ['a', 'c', 'd'])).toEqual(['c', 'a', 'd']);
  });
});
