/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its detail view,
 * and every select, move, drag, key and Undo is dispatched on its elements
 * like a user's.
 */
// Select several videos in a playlist and move them at once (GuthixUnsigned,
// EroScripts #370: "select multiple videos to move around the playlist at
// once"; FT-104, not in v0.9.2).
//
// The playlist detail gets a Select mode like the Library's: a click (or
// Ctrl+click) toggles a video, Shift+click adds a range, Select all /
// Deselect all / Ctrl+A, Esc or Done leaves. On the selection: Move to top,
// Move up, Move down, Move to bottom, a drag of the whole selection, and
// Remove from playlist. Every order change goes through the same write as a
// drag or Sort (DataService.setPlaylistVideoPaths -> store.js), and a run of
// moves shares one Undo, like the Sort's.
//
// The whole write path is real, as in playlist-sort-by-name.test.js: the REAL
// Playlists component over a REAL DataService whose IPC calls go straight
// into the REAL store.js on the REAL electron-conf, against a config.json in
// a temp userData dir. "Saved" means "in config.json".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { liftMainHandler } from './helpers/main-handlers.js';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});

const store = await import('../../electron/store.js');
const { DataService } = await import('../../renderer/js/data-service.js');
const {
  Playlists, moveSelectedToEdge, moveSelectedByOne, moveSelectedTo, reinsertRemoved,
} = await import('../../renderer/components/playlists.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const B = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));
const useLocale = (l) => _setBundlesForTests(l, B[l], B.en);

const DIR = 'D:\\Evening\\';
const V = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'].map((n) => `${DIR}${n}.mp4`);
const [ONE, TWO, THREE, FOUR, FIVE, SIX, SEVEN, EIGHT] = V;
const WATCHED = SIX;
const PARTWAY = TWO;
const LAST = FOUR;

/**
 * The REAL preload.js with `electron` stubbed: its ipcRenderer.invoke runs
 * the REAL ipcMain handler lifted out of main.js for that channel, over the
 * REAL store. Used for the two batch calls the Select-mode Remove makes, so
 * a wrong channel name anywhere on the way fails here.
 */
const require_ = createRequire(import.meta.url);
function realPreload(channels) {
  const handlers = Object.fromEntries(channels.map((c) => [c, liftMainHandler(c, { store })]));
  const ipcRenderer = new EventEmitter();
  ipcRenderer.send = () => {};
  ipcRenderer.invoke = async (channel, ...args) => {
    if (!handlers[channel]) throw new Error(`no main handler wired for ${channel}`);
    return handlers[channel]({}, ...args);
  };
  let api = null;
  const fakeElectron = { contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } }, ipcRenderer, webUtils: {} };
  const resolved = require_.resolve('../../electron/preload.js');
  delete require_.cache[resolved];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  try { require_(resolved); } finally { Module._load = origLoad; }
  return api;
}
const BATCH_CHANNELS = ['add-videos-to-playlist', 'remove-videos-from-playlist'];

const configPath = () => path.join(h.userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));
const diskOrder = (id = 'p1') => onDisk().playlists.find((p) => p.id === id).videoPaths;

let container;
let toasts;
let savedFunsync;
let view;
let ds;
let calls;
let played;
let playedAll;

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** One app launch: config.json seeded, store + DataService booted, the playlist's detail open. */
async function openPlaylist({ videoPaths = V, mode = 'grid', queueOpen = false } = {}) {
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
    playlists: [
      { id: 'p1', name: 'Evening', createdAt: 1, videoPaths },
      { id: 'p2', name: 'Other', createdAt: 2, videoPaths: [EIGHT, ONE] },
    ],
    categories: [],
    videoCategories: {},
    _migrated: true,
  }, null, 2));
  await store.initStore();

  // The preload bridge, reduced to the calls this view makes; each store call
  // is what main's ipcMain handler for it does. Every call is recorded, so a
  // test can say which ones a Remove made (and that none touches a file).
  calls = [];
  const preload = realPreload(BATCH_CHANNELS);
  const bridge = {
    getAllData: async () => store.getAll(),
    setSetting: async (p, v) => store.setSetting(p, v),
    setPlaylistVideoPaths: async (id, paths) => store.setPlaylistVideoPaths(id, paths),
    removeVideoFromPlaylist: async (id, p) => store.removeVideoFromPlaylist(id, p),
    addVideoToPlaylist: async (id, p) => store.addVideoToPlaylist(id, p),
    removeVideosFromPlaylist: preload.removeVideosFromPlaylist,
    addVideosToPlaylist: preload.addVideosToPlaylist,
    filesExist: async (paths) => paths.map(() => true),
    readFunscript: async () => null,
    getThumbnail: async () => null,
    generateSingleThumbnail: async () => null,
    readCustomThumbnail: async () => null,
  };
  window.funsync = new Proxy(bridge, {
    get(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function') return fn;
      return (...args) => { calls.push(String(prop)); return fn(...args); };
    },
  });
  ds = new DataService();
  await ds.init();

  played = [];
  playedAll = [];
  view = new Playlists({
    settings: ds,
    library: { getVideoByPath: () => null },
    onPlayVideo: (fileData) => played.push(fileData),
    onPlayAll: (list) => playedAll.push(list.map((i) => i.path)),
    onToggleQueue: () => {},
    isQueueOpen: () => queueOpen,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  view.show(container);
  view._view = 'detail';
  view._detailPlaylistId = 'p1';
  view._viewMode = mode;
  await view._renderDetail('p1');
  await settle();
  calls.length = 0;
}

const items = () => [...container.querySelectorAll('.playlists__grid > [data-video-path]')];
const shownOrder = () => items().map((el) => el.dataset.videoPath);
const itemFor = (p) => items().find((el) => el.dataset.videoPath === p);
const tick = (p) => itemFor(p).querySelector('.playlists__select-check');
const selectBtn = () => container.querySelector('.playlists__select-btn');
const bar = () => container.querySelector('.playlists__selection-bar');
const action = (name) => bar().querySelector(`[data-action="${name}"]`);
const selected = () => items().filter((el) => tick(el.dataset.videoPath).getAttribute('aria-checked') === 'true')
  .map((el) => el.dataset.videoPath);
const liveToasts = () => [...toasts.querySelectorAll('.toast')].filter((el) => !el.classList.contains('toast--out'));
const undoButton = (cls = 'playlists__sort-undo') => liveToasts().map((el) => el.querySelector(`.${cls}`)).find(Boolean) || null;
const dialogs = () => [...document.querySelectorAll('.modal-overlay')];
/** The dialog on top, if any: its title, message and buttons as the user reads them. */
function dialog() {
  const d = dialogs().at(-1);
  if (!d) return null;
  return {
    title: d.querySelector('.modal-title')?.textContent,
    message: d.querySelector('.modal-message')?.textContent,
    action: d.querySelector('.modal-actions .modal-btn--danger'),
    cancel: d.querySelector('.modal-actions .modal-btn--secondary'),
  };
}
async function answer(yes) {
  (yes ? dialog().action : dialog().cancel).click();
  await settle();
}

// store.js makes every write through one function, and each one rewrites
// the whole config.json synchronously in main (block E2 review: 7-14 ms
// each), so this counts what a user's main process pays for an action.
let unsubscribes = [];
function countWrites() {
  let n = 0;
  unsubscribes.push(store.subscribe(() => { n++; }));
  return () => n;
}

async function click(el, mods = {}) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
  await settle();
}
function key(el, k, mods = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
  el.dispatchEvent(e);
  return e;
}
/** A drag as the browser dispatches it, from one item to the near or far half of another. */
async function drag(fromEl, toEl, { after }) {
  const box = { left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40 };
  toEl.getBoundingClientRect = () => box;
  const at = { clientX: after ? 150 : 50, clientY: after ? 30 : 10 };
  const ev = (type) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), at);
  fromEl.dispatchEvent(ev('dragstart'));
  toEl.dispatchEvent(ev('dragover'));
  toEl.dispatchEvent(ev('drop'));
  fromEl.dispatchEvent(ev('dragend'));
  await settle();
}

beforeEach(() => {
  useLocale('en');
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-playlist-multiselect-'));
  savedFunsync = window.funsync;
  toasts = document.createElement('div');
  toasts.id = 'toast-container';
  document.body.appendChild(toasts);
});

afterEach(() => {
  for (const off of unsubscribes) off();
  unsubscribes = [];
  window.funsync = savedFunsync;
  container?.remove();
  toasts?.remove();
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('Select mode in a playlist (FT-104, #370)', () => {
  it('Select shows a tick on every tile and the bar; a click then selects instead of playing', async () => {
    await openPlaylist();
    expect(bar().hidden).toBe(true);
    expect(items().every((el) => tick(el.dataset.videoPath).hidden)).toBe(true);
    expect(selectBtn().getAttribute('aria-pressed')).toBe('false');

    await click(selectBtn());

    expect(selectBtn().getAttribute('aria-pressed')).toBe('true');
    expect(bar().hidden).toBe(false);
    expect(items().every((el) => !tick(el.dataset.videoPath).hidden)).toBe(true);
    // Nothing selected yet: the moves and Remove wait for a selection.
    for (const a of ['move-top', 'move-up', 'move-down', 'move-bottom', 'remove']) expect(action(a).disabled, a).toBe(true);

    await click(itemFor(THREE));
    expect(played).toHaveLength(0);
    expect(selected()).toEqual([THREE]);
    expect(itemFor(THREE).classList.contains('playlists__item--selected')).toBe(true);
    expect(action('move-top').disabled).toBe(false);
    expect(bar().querySelector('.playlists__selection-count').textContent).toContain('1');
  });

  it('three videos that are not next to each other go to the top, in their order, on screen and in config.json; resume, watched and Last watched stay on their videos', async () => {
    await openPlaylist();
    const marks = () => ({
      watched: !!itemFor(WATCHED).querySelector('.playlists__watched-check'),
      partway: !!itemFor(PARTWAY).querySelector('.resume-bar'),
      last: !!itemFor(LAST).querySelector('.playlists__last-watched'),
      ticks: container.querySelectorAll('.playlists__watched-check').length,
      pills: container.querySelectorAll('.playlists__last-watched').length,
    });
    const before = marks();
    expect(before).toMatchObject({ watched: true, partway: true, last: true, ticks: 1, pills: 1 });

    await click(selectBtn());
    await click(itemFor(SEVEN));
    await click(itemFor(TWO));
    await click(itemFor(FIVE));
    await click(action('move-top'));

    const expected = [TWO, FIVE, SEVEN, ONE, THREE, FOUR, SIX, EIGHT];
    expect(shownOrder()).toEqual(expected);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(expected);
    expect(diskOrder()).toEqual(expected);
    expect(diskOrder('p2')).toEqual([EIGHT, ONE]); // another playlist untouched
    expect(marks()).toEqual(before);
    const disk = onDisk().settings.library;
    expect(disk.playlistProgress.p1.lastVideoPath).toBe(LAST);
    expect(disk.resumePositions[WATCHED].finished).toBe(true);
    expect(disk.resumePositions[PARTWAY].position).toBe(300);
    // Still selected, so the next move needs no re-selecting.
    expect(selected()).toEqual([TWO, FIVE, SEVEN]);
    expect(calls).toEqual(['setPlaylistVideoPaths']);
  });

  it('Undo in the toast puts the order back exactly, on screen and on disk', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(SEVEN));
    await click(itemFor(TWO));
    await click(action('move-bottom'));
    expect(diskOrder()).toEqual([ONE, THREE, FOUR, FIVE, SIX, EIGHT, TWO, SEVEN]);

    await click(undoButton());

    expect(shownOrder()).toEqual(V);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(V);
    expect(diskOrder()).toEqual(V);
    expect(liveToasts()).toHaveLength(0);
  });

  it('Move up three times is one Undo, back to the order before the first press', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(FIVE));
    await click(itemFor(SIX));
    await click(action('move-up'));
    expect(shownOrder()).toEqual([ONE, TWO, THREE, FIVE, SIX, FOUR, SEVEN, EIGHT]);
    await click(action('move-up'));
    await click(action('move-up'));
    expect(diskOrder()).toEqual([ONE, FIVE, SIX, TWO, THREE, FOUR, SEVEN, EIGHT]);
    expect(liveToasts()).toHaveLength(1);

    await click(undoButton());

    expect(diskOrder()).toEqual(V);
    expect(shownOrder()).toEqual(V);
  });

  it('Move up at the top and Move down at the bottom change nothing and raise no toast', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(ONE));
    await click(action('move-up'));
    await click(action('move-top'));
    await click(itemFor(ONE));
    await click(itemFor(EIGHT));
    await click(action('move-down'));
    await click(action('move-bottom'));
    expect(diskOrder()).toEqual(V);
    expect(liveToasts()).toHaveLength(0);
    expect(calls).not.toContain('setPlaylistVideoPaths');
  });

  it('Shift+click adds the range from the last click, Ctrl+click toggles one, Deselect all and Select all', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(TWO));
    await click(itemFor(FIVE), { shiftKey: true });
    expect(selected()).toEqual([TWO, THREE, FOUR, FIVE]);
    await click(itemFor(FOUR), { ctrlKey: true });
    expect(selected()).toEqual([TWO, THREE, FIVE]);
    // The anchor moved to Four: Shift+click Seven adds Four to Seven.
    await click(itemFor(SEVEN), { shiftKey: true });
    expect(selected()).toEqual([TWO, THREE, FOUR, FIVE, SIX, SEVEN]);

    await click(action('select-none'));
    expect(selected()).toEqual([]);
    await click(action('select-all'));
    expect(selected()).toEqual(V);
  });

  it('Shift+click or Ctrl+click while browsing starts Select mode with that video; a plain click still plays', async () => {
    await openPlaylist();
    await click(itemFor(THREE));
    expect(played.map((f) => f.path)).toEqual([THREE]);

    await click(itemFor(FIVE), { ctrlKey: true });
    expect(view._selectMode).toBe(true);
    expect(bar().hidden).toBe(false);
    expect(selected()).toEqual([FIVE]);
    expect(played).toHaveLength(1);
  });

  it('Ctrl+A selects every video in the playlist; Esc leaves Select mode, Done too', async () => {
    await openPlaylist();
    const e = key(document.body, 'a', { ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(selected()).toEqual(V);
    expect(bar().hidden).toBe(false);

    const esc = key(document.body, 'Escape');
    expect(esc.defaultPrevented).toBe(true); // the player's Esc (A-B loop) stays out of it
    expect(view._selectMode).toBe(false);
    expect(bar().hidden).toBe(true);
    expect(items().every((el) => tick(el.dataset.videoPath).hidden)).toBe(true);

    await click(selectBtn());
    action('done').focus();
    await click(action('done'));
    expect(view._selectMode).toBe(false);
    expect(document.activeElement).toBe(selectBtn()); // focus is not dropped on <body>
  });

  it('Esc belongs to an open dialog, the Devices panel or the queue panel first', async () => {
    await openPlaylist({ queueOpen: true });
    await click(selectBtn());
    expect(key(document.body, 'Escape').defaultPrevented).toBe(false);
    expect(view._selectMode).toBe(true); // the queue panel closes first

    container.remove();
    await openPlaylist();
    await click(selectBtn());
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay';
    document.body.appendChild(dialog);
    key(document.body, 'Escape');
    expect(view._selectMode).toBe(true);
    dialog.remove();

    const panel = document.createElement('div');
    panel.setAttribute('aria-modal', 'true');
    document.body.appendChild(panel);
    key(document.body, 'Escape');
    expect(view._selectMode).toBe(true);
    panel.hidden = true; // the Devices panel, closed
    key(document.body, 'Escape');
    expect(view._selectMode).toBe(false);
    panel.remove();
  });

  // Block E2 verify-1, in the real app: neither Esc nor Ctrl+A did anything.
  // The editor's docked panel is built at app start and a closed one is
  // never `[hidden]`, so the handler's `.script-editor:not([hidden])` test
  // always matched it. The tests above built no editor; this one puts the
  // REAL one in the document, closed, as app.js does at startup.
  it('with the REAL script editor built but closed, as at app start: Ctrl+A and Esc work; open, they stand back', async () => {
    const playerContainer = document.createElement('div');
    playerContainer.id = 'player-container';
    document.body.appendChild(playerContainer);
    const video = Object.assign(new EventTarget(), { currentTime: 0, duration: 60, paused: true });
    const ed = new ScriptEditor({
      videoPlayer: Object.assign(new EventTarget(), { video, duration: 60, currentTime: 0 }),
      funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
      progressBar: { renderHeatmap() {} },
      settings: { get: () => undefined, set() {} },
    });
    ed._sendLivePreview = () => {};
    try {
      await openPlaylist();
      expect(document.querySelector('.script-editor')).not.toBe(null);
      expect(ed.isOpen).toBe(false);

      expect(key(document.body, 'a', { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(selected()).toEqual(V);
      expect(key(document.body, 'Escape').defaultPrevented).toBe(true);
      expect(view._selectMode).toBe(false);
      expect(bar().hidden).toBe(true);

      // Open and on screen, the editor has its own Ctrl+A and Esc.
      window.funsync.writeFunscript = async (_json, p) => p;
      ed.show();
      await settle();
      await click(selectBtn());
      expect(key(document.body, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
      expect(selected()).toEqual([]);
      expect(key(document.body, 'Escape').defaultPrevented).toBe(false);
      expect(view._selectMode).toBe(true);
      ed.hide();
      expect(key(document.body, 'Escape').defaultPrevented).toBe(true);
      expect(view._selectMode).toBe(false);
    } finally {
      playerContainer.remove();
    }
  });

  // Block E2 verify-1: in Select mode a tile's or row's X still removed its
  // video at once, with no question and no Undo, right next to the tick, and
  // Tab reached it before each tick. Hidden while selecting (the global
  // `[hidden]` rule takes it out of the layout and the tab order); the bar's
  // Remove asks and undoes.
  for (const mode of ['grid', 'list']) {
    it(`${mode}: each video's own X is out of the way while selecting, and back after`, async () => {
      await openPlaylist({ mode });
      const xs = () => items().map((el) => el.querySelector('.playlists__remove-one'));
      expect(xs().every((x) => x && !x.hidden)).toBe(true);
      await click(selectBtn());
      expect(xs().every((x) => x.hidden)).toBe(true);
      await click(itemFor(THREE)); // a rebuilt or clicked item keeps it hidden
      expect(xs().every((x) => x.hidden)).toBe(true);
      key(document.body, 'Escape');
      expect(view._selectMode).toBe(false);
      expect(xs().every((x) => !x.hidden)).toBe(true);
      expect(diskOrder()).toEqual(V); // nothing was removed on the way
    });
  }

  it('keyboard: each tick is a focusable checkbox; Space toggles it (and is taken from the player), Shift+Enter adds the range', async () => {
    await openPlaylist();
    await click(selectBtn());
    const t2 = tick(TWO);
    expect(t2.tagName).toBe('BUTTON');
    expect(t2.getAttribute('role')).toBe('checkbox');
    expect(t2.getAttribute('aria-label')).toBeTruthy(); // its words: 'is in every locale'
    t2.focus();
    expect(document.activeElement).toBe(t2);

    const space = key(t2, ' ');
    expect(space.defaultPrevented).toBe(true);
    expect(selected()).toEqual([TWO]);
    key(tick(FOUR), 'Enter', { shiftKey: true });
    expect(selected()).toEqual([TWO, THREE, FOUR]);
    key(t2, ' ');
    expect(selected()).toEqual([THREE, FOUR]);

    // The bar's actions are buttons in the tab order.
    for (const a of ['select-all', 'select-none', 'move-top', 'move-up', 'move-down', 'move-bottom', 'remove', 'done']) {
      expect(action(a).tagName, a).toBe('BUTTON');
    }
    action('move-down').focus();
    await click(action('move-down'));
    expect(diskOrder()).toEqual([ONE, TWO, FIVE, THREE, FOUR, SIX, SEVEN, EIGHT]);
    expect(document.activeElement).toBe(action('move-down')); // focus stays for the next press
  });

  it('a card played after a move gets the new order, and so does Play All', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(EIGHT));
    await click(action('move-top'));
    await click(selectBtn()); // leave Select mode

    await click(itemFor(ONE));
    const ctx = played[0]._playContext;
    expect(ctx.list).toEqual([EIGHT, ONE, TWO, THREE, FOUR, FIVE, SIX, SEVEN]);
    expect(ctx.index).toBe(1);

    await click(container.querySelector('.playlists__play-all-btn'));
    expect(playedAll[0]).toEqual([EIGHT, ONE, TWO, THREE, FOUR, FIVE, SIX, SEVEN]);
  });

  it('a list row moved with its own Move down button plays with the new order too', async () => {
    await openPlaylist({ mode: 'list' });
    await click(itemFor(ONE).querySelector('.playlists__move-down'));
    expect(diskOrder()).toEqual([TWO, ONE, THREE, FOUR, FIVE, SIX, SEVEN, EIGHT]);

    await click(itemFor(TWO));
    expect(played[0]._playContext.list).toEqual([TWO, ONE, THREE, FOUR, FIVE, SIX, SEVEN, EIGHT]);
    expect(played[0]._playContext.index).toBe(0);
  });

  it('dragging a selected tile moves the whole selection to where it is dropped', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(TWO));
    await click(itemFor(FOUR));
    expect(itemFor(TWO).draggable).toBe(true);

    await drag(itemFor(FOUR), itemFor(SIX), { after: true });

    const expected = [ONE, THREE, FIVE, SIX, TWO, FOUR, SEVEN, EIGHT];
    expect(shownOrder()).toEqual(expected);
    expect(diskOrder()).toEqual(expected);
    expect(container.querySelectorAll('.playlists__item--dragging')).toHaveLength(0);

    await click(undoButton());
    expect(diskOrder()).toEqual(V);
  });

  it('list view: a selected row dragged before another takes the selection; an unselected row moves alone', async () => {
    await openPlaylist({ mode: 'list' });
    await click(selectBtn());
    await click(itemFor(SEVEN));
    await click(itemFor(EIGHT));
    await drag(itemFor(SEVEN), itemFor(TWO), { after: false });
    expect(diskOrder()).toEqual([ONE, SEVEN, EIGHT, TWO, THREE, FOUR, FIVE, SIX]);

    await drag(itemFor(SIX), itemFor(ONE), { after: false });
    expect(diskOrder()).toEqual([SIX, ONE, SEVEN, EIGHT, TWO, THREE, FOUR, FIVE]);
    expect(shownOrder()).toEqual(diskOrder());
  });

  it('grid tiles are not draggable outside Select mode (the thumbnail keeps its own drag)', async () => {
    await openPlaylist();
    expect(items().some((el) => el.draggable)).toBe(false);
    await click(selectBtn());
    expect(items().every((el) => el.draggable)).toBe(true);
    await click(selectBtn());
    expect(items().some((el) => el.draggable)).toBe(false);
  });

  it('Remove of several asks first, then takes only the selected videos out in one write, never a file; Undo puts them back in their places', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(TWO));
    await click(itemFor(SIX));
    await click(itemFor(SEVEN));
    const writes = countWrites();
    await click(action('remove'));

    // The question says what, how many and from which playlist; nothing is
    // gone while it is open.
    expect(dialog().title).toBe(B.en.playlists.removeFromPlaylist);
    expect(dialog().message).toBe('Remove 3 videos from "Evening"? Your video files are not touched.');
    expect(dialog().action.textContent).toBe(B.en.common.remove);
    expect(diskOrder()).toEqual(V);
    expect(writes()).toBe(0);

    await answer(true);

    const kept = [ONE, THREE, FOUR, FIVE, EIGHT];
    expect(shownOrder()).toEqual(kept);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(kept);
    expect(diskOrder()).toEqual(kept);
    expect(diskOrder('p2')).toEqual([EIGHT, ONE]);
    // The playlist entries only, in ONE config.json write (it was one per
    // video), then the re-render's reads. No file call, and no resume or
    // watched write.
    const READS = new Set(['filesExist', 'readFunscript', 'getThumbnail', 'generateSingleThumbnail', 'readCustomThumbnail']);
    expect(calls.filter((c) => !READS.has(c))).toEqual(['removeVideosFromPlaylist']);
    expect(writes()).toBe(1);
    expect(onDisk().settings.library.resumePositions[WATCHED].finished).toBe(true);
    expect(view._selectMode).toBe(false);

    calls.length = 0;
    const undoWrites = countWrites();
    await click(undoButton('playlists__remove-undo'));

    expect(shownOrder()).toEqual(V);
    expect(diskOrder()).toEqual(V);
    expect(ds.getPlaylist('p1').videoPaths).toEqual(V);
    // Put back in one write, put in place by one reorder.
    expect(calls.filter((c) => !READS.has(c))).toEqual(['addVideosToPlaylist', 'setPlaylistVideoPaths']);
    expect(undoWrites()).toBe(2);
  });

  it('Select all, Remove: the question names all of them; Cancel, Esc or the X keep every video and the selection', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(action('select-all'));
    const writes = countWrites();

    await click(action('remove'));
    expect(dialog().message).toBe('Remove 8 videos from "Evening"? Your video files are not touched.');
    await answer(false);
    expect(dialogs()).toHaveLength(0);

    await click(action('remove'));
    // Esc closes the question, not Select mode under it.
    key(dialogs().at(-1).querySelector('.modal-btn--secondary'), 'Escape');
    await settle();
    expect(dialogs()).toHaveLength(0);

    await click(action('remove'));
    dialogs().at(-1).querySelector('.modal-close-btn').click();
    await settle();

    expect(diskOrder()).toEqual(V);
    expect(shownOrder()).toEqual(V);
    expect(writes()).toBe(0);
    expect(view._selectMode).toBe(true);
    expect(selected()).toEqual(V);
    expect(liveToasts()).toHaveLength(0);
  });

  it('Remove of ONE selected video asks nothing, as the X on its card asks nothing, and offers Undo', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(FIVE));
    await click(action('remove'));

    expect(dialogs()).toHaveLength(0);
    expect(diskOrder()).toEqual(V.filter((p) => p !== FIVE));
    await click(undoButton('playlists__remove-undo'));
    expect(diskOrder()).toEqual(V);
  });

  it('the store\'s batch calls: one write, entries only, the order kept, nothing added twice', () => {
    // Straight on the REAL store.js (no playlist detail needed).
    fs.writeFileSync(configPath(), JSON.stringify({
      playlists: [{ id: 'p1', name: 'Evening', createdAt: 1, videoPaths: [ONE, TWO, THREE, FOUR] }],
      _migrated: true,
    }));
    return store.initStore().then(() => {
      const writes = countWrites();
      store.removeVideosFromPlaylist('p1', [THREE, ONE, 'D:\\not-in-it.mp4']);
      expect(diskOrder()).toEqual([TWO, FOUR]);
      expect(writes()).toBe(1);
      store.removeVideosFromPlaylist('p1', ['D:\\not-in-it.mp4']);
      store.removeVideosFromPlaylist('nope', [TWO]);
      store.removeVideosFromPlaylist('p1', null);
      expect(writes()).toBe(1); // nothing to do, nothing written
      store.addVideosToPlaylist('p1', [THREE, TWO, ONE, THREE, 42]);
      expect(diskOrder()).toEqual([TWO, FOUR, THREE, ONE]);
      expect(writes()).toBe(2);
      store.addVideosToPlaylist('p1', [FOUR]);
      store.addVideosToPlaylist('p1', 'D:\\x.mp4');
      expect(writes()).toBe(2);
    });
  });

  it('Undo of a Remove keeps a reorder made since: the videos go back after the ones they followed', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(TWO));
    await click(itemFor(THREE));
    await click(action('remove'));
    await answer(true);
    // Then One goes to the bottom.
    await click(selectBtn());
    await click(itemFor(ONE));
    await click(action('move-bottom'));
    expect(diskOrder()).toEqual([FOUR, FIVE, SIX, SEVEN, EIGHT, ONE]);

    await click(undoButton('playlists__remove-undo'));

    expect(diskOrder()).toEqual([FOUR, FIVE, SIX, SEVEN, EIGHT, ONE, TWO, THREE]);
    expect(shownOrder()).toEqual(diskOrder());
  });

  it('Select mode ends on Back, on another playlist and when the view hides; a selected video removed with its X leaves the selection', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(TWO));
    await click(itemFor(THREE));
    await click(itemFor(TWO).querySelector('.playlists__video-remove-btn'));
    expect(view._selectMode).toBe(true);
    expect(selected()).toEqual([THREE]);

    view.navigateBack();
    expect(view._selectMode).toBe(false);

    view._view = 'detail';
    view._detailPlaylistId = 'p1';
    await view._renderDetail('p1');
    await click(selectBtn());
    view._detailPlaylistId = 'p2';
    await view._renderDetail('p2');
    expect(view._selectMode).toBe(false);

    await click(selectBtn());
    view.hide();
    expect(view._selectMode).toBe(false);
  });

  it('the selection survives a language switch (the detail renders again)', async () => {
    await openPlaylist();
    await click(selectBtn());
    await click(itemFor(FOUR));
    await view._renderDetail('p1');
    await settle();
    expect(bar().hidden).toBe(false);
    expect(selected()).toEqual([FOUR]);
  });

  // Every word the mode adds, in all 8 languages: the reused keys (Select,
  // N selected, Select all, Deselect all, Move up, Move down, Remove from
  // playlist, Done, Undo) and the six new ones.
  it('is in every locale', async () => {
    const seen = new Set();
    for (const locale of LOCALES) {
      useLocale(locale);
      await openPlaylist();
      await click(selectBtn());
      await click(itemFor(TWO));
      const b = B[locale];
      expect(selectBtn().textContent, locale).toBe(b.library.selectModeEnter);
      expect(selectBtn().title, locale).toBe(b.playlists.selectModeTitle);
      expect(action('select-all').textContent, locale).toBe(b.collectionModal.selectAll);
      expect(action('select-none').textContent, locale).toBe(b.collectionModal.deselectAll);
      expect(action('move-top').textContent, locale).toBe(b.playlists.moveToTop);
      expect(action('move-up').textContent, locale).toBe(b.playlists.moveUp);
      expect(action('move-down').textContent, locale).toBe(b.playlists.moveDown);
      expect(action('move-bottom').textContent, locale).toBe(b.playlists.moveToBottom);
      expect(action('remove').textContent, locale).toBe(b.playlists.removeFromPlaylist);
      expect(action('done').textContent, locale).toBe(b.common.done);
      // Move to top must not read as Move up (German's queue key did).
      expect(action('move-top').textContent, locale).not.toBe(action('move-up').textContent);
      expect(action('move-bottom').textContent, locale).not.toBe(action('move-down').textContent);
      expect(tick(TWO).getAttribute('aria-label'), locale).toContain('Two');
      expect(tick(TWO).getAttribute('aria-label'), locale).not.toContain('{name}');

      await click(action('move-bottom'));
      const moved = liveToasts()[0].textContent;
      expect(moved, locale).toContain('Evening');
      expect(moved, locale).not.toMatch(/[{}]/);
      expect(moved, locale).toContain(b.toast.undo);

      toasts.replaceChildren();
      await click(action('remove'));
      const removed = liveToasts()[0].textContent;
      expect(removed, locale).toContain('Evening');
      expect(removed, locale).not.toMatch(/[{}]/);
      // The six new keys are translated, not English copies.
      if (locale !== 'en') {
        for (const k of ['moveToTop', 'moveToBottom', 'selectModeTitle', 'selectVideoNamed', 'movedSelection', 'removedSelection']) {
          expect(b.playlists[k], `${locale} ${k}`).toBeTruthy();
          expect(b.playlists[k], `${locale} ${k}`).not.toBe(B.en.playlists[k]);
        }
      }
      seen.add(moved.replace(/\s+/g, ' '));
      container.remove();
      toasts.replaceChildren();
    }
    expect(seen.size).toBe(8);
  });

  // The question a Remove of several asks (block E2 review), in all 8.
  it('the Remove question is in every locale', async () => {
    for (const locale of LOCALES) {
      useLocale(locale);
      await openPlaylist();
      await click(selectBtn());
      await click(itemFor(TWO));
      await click(itemFor(THREE));
      await click(action('remove'));
      const b = B[locale];
      expect(dialog().title, locale).toBe(b.playlists.removeFromPlaylist);
      expect(dialog().action.textContent, locale).toBe(b.common.remove);
      expect(dialog().cancel.textContent, locale).toBe(b.common.cancel);
      expect(dialog().message, locale).toContain('Evening');
      expect(dialog().message, locale).toContain('2');
      expect(dialog().message, locale).not.toMatch(/[{}#]/);
      if (locale !== 'en') {
        expect(b.playlists.confirmRemoveSelection, locale).not.toBe(B.en.playlists.confirmRemoveSelection);
      }
      await answer(false);
      expect(diskOrder(), locale).toEqual(V);
      container.remove();
    }
  });

  // One Esc, one thing (block E2 review). Select mode takes Esc in the
  // capture phase; the player's handler then dismissed a visible Up Next card
  // before it looked whether the press was already taken.
  it('one Esc with the Up Next card showing leaves Select mode and nothing else; the next Esc dismisses the card', async () => {
    const { KeyboardHandler } = await import('../../renderer/js/keyboard.js');
    class Keys extends KeyboardHandler { _bindEvents() {} }
    const clearAbLoop = vi.fn();
    const keys = new Keys({
      videoPlayer: { clearAbLoop },
      connectionPanel: { hide: vi.fn() },
      getView: () => 'playlists',
      isQueueOpen: () => false,
      onToggleQueue: vi.fn(),
    });
    const engine = { visible: true, dismiss: vi.fn(() => { engine.visible = false; }) };
    keys.upNextEngine = engine;
    const onKey = (e) => keys._onKeyDown(e);
    document.addEventListener('keydown', onKey);
    try {
      await openPlaylist();
      await click(selectBtn());
      await click(itemFor(TWO));

      key(document.body, 'Escape');
      expect(view._selectMode).toBe(false);
      expect(engine.dismiss).not.toHaveBeenCalled();
      expect(clearAbLoop).not.toHaveBeenCalled();

      key(document.body, 'Escape');
      expect(engine.dismiss).toHaveBeenCalledTimes(1);
      expect(clearAbLoop).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });
});

describe('the move rules', () => {
  const sel = (...p) => new Set(p);

  it('to the top / bottom: one block, in its own order', () => {
    expect(moveSelectedToEdge(['a', 'b', 'c', 'd', 'e'], sel('d', 'b'), 'top')).toEqual(['b', 'd', 'a', 'c', 'e']);
    expect(moveSelectedToEdge(['a', 'b', 'c', 'd', 'e'], sel('d', 'b'), 'bottom')).toEqual(['a', 'c', 'e', 'b', 'd']);
  });

  it('one place up / down: a block moves as a block and stops at the end', () => {
    expect(moveSelectedByOne(['a', 'b', 'c', 'd'], sel('b', 'c'), -1)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveSelectedByOne(['a', 'b', 'c', 'd'], sel('a', 'c'), -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveSelectedByOne(['a', 'b', 'c', 'd'], sel('a', 'b'), -1)).toEqual(['a', 'b', 'c', 'd']);
    expect(moveSelectedByOne(['a', 'b', 'c', 'd'], sel('b', 'c'), 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveSelectedByOne(['a', 'b', 'c', 'd'], sel('d', 'b'), 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('a drop: the gap before the item at the index, selected items around it not counted', () => {
    expect(moveSelectedTo(['a', 'b', 'c', 'd', 'e'], sel('b', 'd'), 5)).toEqual(['a', 'c', 'e', 'b', 'd']);
    expect(moveSelectedTo(['a', 'b', 'c', 'd', 'e'], sel('b', 'd'), 0)).toEqual(['b', 'd', 'a', 'c', 'e']);
    expect(moveSelectedTo(['a', 'b', 'c', 'd', 'e'], sel('b', 'd'), 4)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(moveSelectedTo(['a', 'b', 'c', 'd', 'e'], sel('b', 'd'), 2)).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('every result is the same paths (a pure reorder store.js accepts)', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f'];
    const s = sel('b', 'e', 'f');
    for (const out of [moveSelectedToEdge(order, s, 'top'), moveSelectedByOne(order, s, -1),
      moveSelectedByOne(order, s, 1), moveSelectedTo(order, s, 3)]) {
      expect(out.slice().sort()).toEqual(order);
    }
  });

  it('Undo of a Remove: back after the video it followed, first when none is left, never twice', () => {
    expect(reinsertRemoved(['a', 'b', 'c', 'd'], ['a', 'd'], sel('b', 'c'))).toEqual(['a', 'b', 'c', 'd']);
    expect(reinsertRemoved(['a', 'b', 'c', 'd'], ['d', 'a'], sel('b', 'c'))).toEqual(['d', 'a', 'b', 'c']);
    expect(reinsertRemoved(['a', 'b', 'c'], ['c'], sel('a', 'b'))).toEqual(['a', 'b', 'c']);
    expect(reinsertRemoved(['a', 'b', 'c'], ['b', 'c'], sel('b'))).toEqual(['b', 'c']);
  });
});
