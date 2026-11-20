/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library builds its virtual grid, cards and
 * heatmap canvases into a DOM (library.js imports DOM-branching modules;
 * notes/CLAUDE.md "Test environments").
 */
// V81 (Dave, 2026-11-03): "switching sorts with a large library is
// horrifically slow". Measured on his real 1,546-video library in the app,
// 6-12 s from the click to the repaint, for every sort option, in grid,
// list and folder view. Three causes, each pinned here by what the user
// gets, not by how the code is written:
//
//  1. Every render built EVERY card. `_renderGrid` empties the grid, and the
//     force-the-tail check then read the empty grid's extent (0), decided
//     the user was "at the bottom" and rendered to the end. Virtual scroll
//     was off for every sort, filter and background refresh.
//  2. Each heatmap strip forced a full-document layout: renderBins reads
//     `clientWidth` and then resizes its canvas, so drawing N strips one by
//     one cost N layouts (13 s of a 19 s profile).
//  3. Each render re-read and re-parsed every visible card's script off the
//     drive, although the speed, bins and badges were already on the video.
//
// jsdom does no layout. The wrapper's scroll extent is modelled from the
// spacers and rendered rows, and the canvas models "a read after a write
// costs a layout", which is exactly the browser behaviour that hurt.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

// The video options dialog, as far as the polls see it: open until the test
// closes it. The REAL dialog is in video-options-dialog.test.js.
const dialogMock = vi.hoisted(() => ({ calls: 0, close: null }));
vi.mock('../../renderer/components/video-options-dialog.js', () => ({
  openVideoOptionsDialog: () => {
    dialogMock.calls++;
    return new Promise((resolve) => { dialogMock.close = resolve; });
  },
}));

const COLUMNS = 7;           // wrapper is 1700px wide
const ROW = 197;             // measured card row (card + gap)
const LIST_ROW = 50;         // list view row, what library.js assumes
const VIEWPORT = 900;
const N = 2000;

// Fresh objects per test: a read leaves its results on the video.
const makeVideos = () => Array.from({ length: N }, (_, i) => ({
  name: `Video ${String(i).padStart(4, '0')}.mp4`,
  path: `D:\\Lib\\Video ${String(i).padStart(4, '0')}.mp4`,
  hasFunscript: true,
  funscriptPath: `D:\\Lib\\Video ${String(i).padStart(4, '0')}.funscript`,
  variants: [],
}));

let videos;
let rafQueue;
let lib;
let wrapper;
let grid;
let layouts;
let layoutDirty;
let drawn;
let reads;

/** Run every queued animation frame, including ones queued while running. */
function flushFrames() {
  for (let guard = 0; rafQueue.length && guard < 30; guard++) {
    const batch = rafQueue.splice(0);
    for (const cb of batch) cb(0);
  }
}

const cards = () => grid.querySelectorAll('.library__card');

function installCanvasLayoutModel() {
  const proto = HTMLCanvasElement.prototype;
  const sizes = new WeakMap();
  const ctx = { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: '' };
  vi.spyOn(proto, 'getContext').mockImplementation(() => ctx);
  const read = (v) => () => { if (layoutDirty) { layouts++; layoutDirty = false; } return v; };
  Object.defineProperty(proto, 'clientWidth', { get: read(200), configurable: true });
  Object.defineProperty(proto, 'clientHeight', { get: read(6), configurable: true });
  for (const dim of ['width', 'height']) {
    Object.defineProperty(proto, dim, {
      configurable: true,
      get() { return sizes.get(this)?.[dim] ?? (dim === 'width' ? 300 : 150); },
      set(v) {
        const s = sizes.get(this) || {};
        s[dim] = v;
        sizes.set(this, s);
        layoutDirty = true;   // a resized canvas invalidates layout
        if (dim === 'width') drawn.add(this);
      },
    });
  }
}

/**
 * (Re)build the grid in the library's container, as show() does after a
 * hide(), with the scroll extent a browser would give it: spacers plus the
 * rows actually rendered. An emptied grid has no extent beyond the viewport.
 */
function mountGrid() {
  lib._container.innerHTML = '<div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  wrapper = lib._container.querySelector('.library__grid-wrapper');
  grid = lib._container.querySelector('.library__grid');
  const g = grid;
  let scrollTop = 0;
  const extent = () => {
    const px = (el) => (el && el.parentNode === g && el.style.display !== 'none' ? parseFloat(el.style.height) || 0 : 0);
    const list = g.classList.contains('library__grid--list');
    const rows = list
      ? g.querySelectorAll('.library__list-item').length
      : Math.ceil(g.querySelectorAll('.library__card').length / COLUMNS);
    return Math.max(VIEWPORT, px(lib._topSpacer) + rows * (list ? LIST_ROW : ROW) + px(lib._bottomSpacer));
  };
  Object.defineProperty(wrapper, 'scrollTop', {
    get: () => scrollTop,
    set: (v) => { scrollTop = Math.max(0, Math.min(v, extent() - VIEWPORT)); },
    configurable: true,
  });
  Object.defineProperty(wrapper, 'scrollHeight', { get: extent, configurable: true });
  Object.defineProperty(wrapper, 'clientHeight', { value: VIEWPORT, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true });
}

beforeEach(() => {
  videos = makeVideos();
  rafQueue = [];
  layouts = 0;
  layoutDirty = true;
  drawn = new Set();
  reads = 0;
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  installCanvasLayoutModel();

  const store = { 'library.viewMode': 'grid', 'library.showCardHeatmap': true };
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  lib = new Library({ settings });
  const container = document.createElement('div');
  document.body.appendChild(container);
  lib._container = container;
  lib._videos = videos;
  lib._videosByPath = new Map(videos.map((v) => [v.path, v]));
  mountGrid();
  lib._vsMeasuredRowHeight = ROW;   // measured on an earlier render
  lib._measureGridColumns = () => COLUMNS;

  // Not under test: thumbnails (backend). Script reads are counted.
  lib._queueThumbnail = () => {};
  window.funsync = {
    readFunscript: vi.fn(async () => {
      reads++;
      return JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }] });
    }),
  };
});

afterEach(async () => {
  // Let reads still in flight land and draw, so no strip is left queued for
  // a frame that belongs to this test.
  await new Promise((r) => setTimeout(r, 0));
  flushFrames();
  lib._container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete HTMLCanvasElement.prototype.clientWidth;
  delete HTMLCanvasElement.prototype.clientHeight;
  delete HTMLCanvasElement.prototype.width;
  delete HTMLCanvasElement.prototype.height;
});

const flushReads = () => new Promise((r) => setTimeout(r, 0));
// What fits the viewport plus the 3-row overscan either side, plus the row
// the viewport straddles: the most a windowed render should build.
const SCREENFUL = (Math.ceil(VIEWPORT / ROW) + 2 * 3 + 1) * COLUMNS;

describe('a sort on a large library renders one screenful, not the whole library (V81)', () => {
  it('a 2,000-video render builds only the cards around the viewport', () => {
    lib._renderGrid(videos);
    expect(cards().length).toBeGreaterThan(0);
    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
    flushFrames();
    // ...and stays that way once the frame after it has run its checks.
    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
  });

  it('re-sorting while scrolled into the middle keeps the window and the position', () => {
    lib._renderGrid(videos);
    flushFrames();
    wrapper.scrollTop = 30000;
    lib._scrollHandler();
    flushFrames();

    lib._renderGrid([...videos].reverse());   // the sort click's render
    flushFrames();

    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
    expect(wrapper.scrollTop).toBe(30000);
  });

  it('scrolled to the very bottom, the last card still renders', () => {
    lib._renderGrid(videos);
    flushFrames();
    for (let i = 0; i < 3; i++) {   // the extent grows as the tail renders
      wrapper.scrollTop = wrapper.scrollHeight;
      lib._scrollHandler();
      flushFrames();
    }
    const last = videos[videos.length - 1].path;
    expect([...cards()].some((c) => c.dataset.videoPath === last)).toBe(true);
    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
  });

  it('with an over-estimated row height, a re-render at the bottom keeps the last card on screen', () => {
    // The case the force-the-tail guard exists for (#315 territory): the
    // estimate is taller than the real rows, so the arithmetic alone never
    // reaches the end, and the re-inflated bottom spacer puts the DOM's
    // bottom a screen below the user. Whether they were at the bottom is
    // read from the grid BEFORE the render empties it.
    lib._vsMeasuredRowHeight = 600;
    lib._renderGrid(videos);
    flushFrames();
    for (let i = 0; i < 4; i++) {
      wrapper.scrollTop = wrapper.scrollHeight;
      lib._scrollHandler();
      flushFrames();
    }
    expect([...cards()].some((c) => c.dataset.videoPath === videos[videos.length - 1].path)).toBe(true);
    const sorted = [...videos].reverse();
    lib._renderGrid(sorted);
    flushFrames();
    const last = sorted[sorted.length - 1].path;
    expect([...cards()].some((c) => c.dataset.videoPath === last)).toBe(true);
  });

  it('with an over-estimated row height, coming back to the library at the bottom shows the last card', () => {
    // Back from the player: hide() threw the grid away, show() builds a new
    // one, and only hide() could see whether the user was at the bottom.
    lib._vsMeasuredRowHeight = 600;
    lib._renderGrid(videos);
    flushFrames();
    for (let i = 0; i < 4; i++) {
      wrapper.scrollTop = wrapper.scrollHeight;
      lib._scrollHandler();
      flushFrames();
    }
    lib.hide();
    mountGrid();
    lib._renderGrid(videos);
    flushFrames();
    const last = videos[videos.length - 1].path;
    expect([...cards()].some((c) => c.dataset.videoPath === last)).toBe(true);
    expect(cards().length).toBeLessThanOrEqual(SCREENFUL * 2);
  });

  it('a re-render while at the bottom still shows the last card', () => {
    lib._renderGrid(videos);
    flushFrames();
    for (let i = 0; i < 3; i++) {
      wrapper.scrollTop = wrapper.scrollHeight;
      lib._scrollHandler();
      flushFrames();
    }
    const sorted = [...videos].reverse();
    lib._renderGrid(sorted);
    flushFrames();
    const last = sorted[sorted.length - 1].path;
    expect([...cards()].some((c) => c.dataset.videoPath === last)).toBe(true);
  });
});

describe('at the bottom, a render into a bigger list or another view still builds one screenful (V81 review)', () => {
  // Keeping the tail used to extend the window from the OLD scroll position
  // to the end of the NEW list. When the new list is longer, or its rows are
  // a different height, that old offset is mid-list, so one render built
  // most of the library again: 1,006 cards, 895 list rows, 1,153 cards.
  const LIST_SCREENFUL = Math.ceil(VIEWPORT / LIST_ROW) + 2 * 3 + 1;
  const toBottom = () => {
    for (let i = 0; i < 3; i++) {   // the extent grows as the tail renders
      wrapper.scrollTop = wrapper.scrollHeight;
      lib._scrollHandler();
      flushFrames();
    }
  };
  const atBottom = () => wrapper.scrollTop >= wrapper.scrollHeight - VIEWPORT - 1;
  const shows = (els, path) => [...els].some((el) => el.dataset.videoPath === path);

  it('the list grows under the user (Matched off): one screenful, still at the bottom', () => {
    lib._renderGrid(videos.slice(0, 1044));
    flushFrames();
    toBottom();

    lib._renderGrid(videos);                 // 1,044 -> 2,000
    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
    flushFrames();                           // the position restore
    lib._scrollHandler();                    // ...and the scroll it fires
    flushFrames();

    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
    expect(shows(cards(), videos[N - 1].path)).toBe(true);
    expect(atBottom()).toBe(true);
  });

  it('grid to list view at the bottom: one screenful of rows, the last video still on screen', () => {
    lib._renderGrid(videos);
    flushFrames();
    toBottom();

    lib._setViewMode('list');                // the real toggle: _applyFilters -> _renderGrid
    const rows = () => grid.querySelectorAll('.library__list-item');
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThanOrEqual(LIST_SCREENFUL);
    flushFrames();
    lib._scrollHandler();
    flushFrames();

    expect(rows().length).toBeLessThanOrEqual(LIST_SCREENFUL);
    expect(shows(rows(), videos[N - 1].path)).toBe(true);
    expect(atBottom()).toBe(true);
  });

  it('back from hide() at the bottom of a smaller list into a bigger one: one screenful', () => {
    lib._renderGrid(videos.slice(0, 900));
    flushFrames();
    toBottom();
    lib.hide();
    mountGrid();

    lib._renderGrid(videos);
    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
    flushFrames();
    lib._scrollHandler();
    flushFrames();

    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
    expect(shows(cards(), videos[N - 1].path)).toBe(true);
  });

  it('the list shrinks under the user: one screenful, at the new bottom', () => {
    lib._renderGrid(videos);
    flushFrames();
    toBottom();

    lib._renderGrid(videos.slice(0, 1044));
    flushFrames();
    lib._scrollHandler();
    flushFrames();

    expect(cards().length).toBeLessThanOrEqual(SCREENFUL);
    expect(shows(cards(), videos[1043].path)).toBe(true);
    expect(atBottom()).toBe(true);
  });
});

describe('heatmap strips of one render cost one layout (V81)', () => {
  it('draws every visible strip, measuring them all in a single layout', () => {
    for (const v of videos) v._heatmapBins = new Float32Array([0.1, 0.2, 0.3]);
    lib._renderGrid(videos);
    const canvases = grid.querySelectorAll('.library__card-heatmap-canvas');
    expect(canvases.length).toBeGreaterThan(10);
    layouts = 0;
    layoutDirty = true;   // the render just changed the DOM

    flushFrames();

    expect([...canvases].every((c) => drawn.has(c))).toBe(true);
    expect(layouts).toBe(1);
  });

  it('strips whose scripts are read in the same frame are measured together', async () => {
    lib._renderGrid(videos);
    await flushReads();               // every visible card's read resolves
    layouts = 0;
    layoutDirty = true;
    flushFrames();
    const canvases = grid.querySelectorAll('.library__card-heatmap-canvas');
    expect([...canvases].every((c) => drawn.has(c))).toBe(true);
    expect(layouts).toBe(1);
  });
});

describe('a sort does not re-read the scripts already shown (V81)', () => {
  it('reads each visible script once, and a re-sort reads none of them again', async () => {
    lib._renderGrid(videos);
    await flushReads();
    flushFrames();
    const firstReads = reads;
    expect(firstReads).toBe(cards().length);

    lib._renderGrid([...videos]);     // same window, new card elements
    await flushReads();
    flushFrames();

    expect(reads).toBe(firstReads);
    // The fresh cards still show what the reads found.
    for (const card of cards()) {
      expect(card.querySelector('.library__speed-badge')).not.toBeNull();
      expect(drawn.has(card.querySelector('.library__card-heatmap-canvas'))).toBe(true);
    }
  });

  it('a card built while its read was still in flight gets the badge from the cached read', async () => {
    const video = videos[0];
    const first = lib._createCard(video);
    const second = lib._createCard(video);   // re-rendered before the read lands
    await lib._loadSpeedStatsForVideo(video, first);
    await lib._loadSpeedStatsForVideo(video, second);
    flushFrames();
    expect(reads).toBe(1);
    expect(second.querySelector('.library__speed-badge')).not.toBeNull();
  });

  it('a script that changed (a new association) is read again', async () => {
    const video = { ...videos[1] };
    await lib._loadSpeedStatsForVideo(video, lib._createCard(video));
    video.funscriptPath = 'D:\\Lib\\Other.funscript';
    await lib._loadSpeedStatsForVideo(video, lib._createCard(video));
    expect(reads).toBe(2);
  });
});

describe('the background polls re-render only when something arrived (V81)', () => {
  it('a duration poll that brings nothing new does not rebuild the grid', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lib2 = Object.create(Library.prototype);
    lib2._videos = [
      { path: 'D:\\Lib\\a.mp4', duration: 0 },
      { path: 'D:\\Lib\\b.mp4', duration: 0 },
    ];
    lib2._durationCache = new Map();
    lib2._settings = { get: () => ({}), set: vi.fn() };
    lib2._applyFilters = vi.fn();
    let poll = 0;
    window.funsync = {
      getDurations: vi.fn(async () => {
        poll++;
        if (poll > 3) throw new Error('stop');   // ends the loop
        return { 'D:\\Lib\\a.mp4': 12 };       // b never arrives
      }),
    };
    const done = lib2._precomputeDurationsInBackground();
    await vi.advanceTimersByTimeAsync(7000);
    await done;
    vi.useRealTimers();

    expect(poll).toBe(4);
    expect(lib2._applyFilters).toHaveBeenCalledTimes(1);
  });

  it('a speed-stats poll that brings nothing new does not rebuild the grid', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lib2 = Object.create(Library.prototype);
    lib2._videos = [
      { path: 'D:\\Lib\\a.mp4', hasFunscript: true, funscriptPath: 'D:\\Lib\\a.funscript' },
      { path: 'D:\\Lib\\b.mp4', hasFunscript: true, funscriptPath: 'D:\\Lib\\b.funscript' },
    ];
    lib2._settings = { get: () => ({}), set: vi.fn() };
    lib2._applyFilters = vi.fn();
    let poll = 0;
    window.funsync = {
      getSpeedStats: vi.fn(async () => {
        poll++;
        if (poll > 3) throw new Error('stop');
        return { 'D:\\Lib\\a.funscript': { avgSpeed: 100, maxSpeed: 200 } };
      }),
    };
    const done = lib2._precomputeSpeedStatsInBackground();
    await vi.advanceTimersByTimeAsync(7000);
    await done;
    vi.useRealTimers();

    expect(poll).toBe(4);
    expect(lib2._applyFilters).toHaveBeenCalledTimes(1);
  });

  // V81 review: the render a poll skips because a kebab menu is open is still
  // owed. With "only re-render on arrival", later polls brought nothing, so
  // nothing re-queued it and the badges and the speed/duration order on
  // screen stayed stale until some other render.
  it('a speed render skipped for an open menu happens once the menu closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lib2 = Object.create(Library.prototype);
    lib2._videos = [
      { path: 'D:\\Lib\\a.mp4', hasFunscript: true, funscriptPath: 'D:\\Lib\\a.funscript' },
      { path: 'D:\\Lib\\b.mp4', hasFunscript: true, funscriptPath: 'D:\\Lib\\b.funscript' },
    ];
    lib2._settings = { get: () => ({}), set: vi.fn() };
    lib2._openMenu = { menu: true };              // open when the data lands
    const menuAtRender = [];
    lib2._applyFilters = vi.fn(() => menuAtRender.push(lib2._openMenu));
    let poll = 0;
    window.funsync = {
      getSpeedStats: vi.fn(async () => {
        poll++;
        if (poll === 2) lib2._openMenu = null;    // closed before the next poll
        if (poll > 4) throw new Error('stop');
        return { 'D:\\Lib\\a.funscript': { avgSpeed: 100, maxSpeed: 200 } };
      }),
    };
    const done = lib2._precomputeSpeedStatsInBackground();
    await vi.advanceTimersByTimeAsync(9000);
    await done;
    vi.useRealTimers();

    expect(poll).toBe(5);
    expect(lib2._applyFilters).toHaveBeenCalledTimes(1);
    expect(menuAtRender).toEqual([null]);
    expect(lib2._videos[0].avgSpeed).toBe(100);
  });

  it('durations that all arrived while a menu was open are rendered once it closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lib2 = Object.create(Library.prototype);
    lib2._videos = [
      { path: 'D:\\Lib\\a.mp4', duration: 0 },
      { path: 'D:\\Lib\\b.mp4', duration: 0 },
    ];
    lib2._durationCache = new Map();
    lib2._settings = { get: () => ({}), set: vi.fn() };
    lib2._openMenu = { menu: true };
    lib2._applyFilters = vi.fn();
    window.funsync = {
      // Everything arrives on the first poll, so nothing is pending after it.
      getDurations: vi.fn(async () => ({ 'D:\\Lib\\a.mp4': 12, 'D:\\Lib\\b.mp4': 30 })),
    };
    setTimeout(() => { lib2._openMenu = null; }, 3000);
    const done = lib2._precomputeDurationsInBackground();
    await vi.advanceTimersByTimeAsync(2500);
    expect(lib2._applyFilters).not.toHaveBeenCalled();   // still open
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    vi.useRealTimers();

    expect(lib2._applyFilters).toHaveBeenCalledTimes(1);
    expect(window.funsync.getDurations).toHaveBeenCalledTimes(1);   // no polling for nothing
  });
  // Video options (2026-11-18, stage 2a): the dialog holds the grid still as
  // an open menu does (`_isMenuOrDialogOpen`). The render the polls skipped
  // runs on its close, once, and only then does the focus go back to the ⋮,
  // found again by path: a render after the focus would take it off again.
  for (const [poll, start, bridge] of [
    ['speed-stats', (l) => l._precomputeSpeedStatsInBackground(), (fn) => ({ getSpeedStats: fn })],
    ['duration', (l) => l._precomputeDurationsInBackground(), (fn) => ({ getDurations: fn })],
  ]) {
    it(`no ${poll} poll rebuilds the grid while the video options dialog is open; its close renders once, then focuses the ⋮`, async () => {
      const A = 'C:\\Lib\\a.mp4';
      const B = 'C:\\Lib\\b.mp4';
      const lib2 = Object.create(Library.prototype);
      lib2._videos = [
        { path: A, name: 'a.mp4', hasFunscript: true, funscriptPath: 'C:\\Lib\\a.funscript', duration: 0 },
        { path: B, name: 'b.mp4', hasFunscript: true, funscriptPath: 'C:\\Lib\\b.funscript', duration: 0 },
      ];
      lib2._durationCache = new Map();
      lib2._settings = { get: () => ({}), set: vi.fn() };
      // Each render builds the card anew, its ⋮ with it.
      const container = document.createElement('div');
      container.innerHTML = '<div class="library__grid"></div>';
      document.body.appendChild(container);
      lib2._container = container;
      const renderCards = () => {
        const g = container.querySelector('.library__grid');
        g.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'library__card';
        card.dataset.videoPath = A;
        const kebab = document.createElement('button');
        kebab.className = 'library__kebab-btn';
        card.appendChild(kebab);
        g.appendChild(card);
      };
      renderCards();
      const kebab = () => container.querySelector('.library__kebab-btn');
      lib2._applyFilters = vi.fn(renderCards);

      kebab().focus();
      dialogMock.calls = 0;
      const opened = lib2._openVideoOptions(lib2._videos[0]);
      await vi.waitFor(() => expect(dialogMock.calls).toBe(1));

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let n = 0;
      const answer = poll === 'duration'
        ? { [A]: 12, [B]: 30 }
        : { 'C:\\Lib\\a.funscript': { avgSpeed: 100, maxSpeed: 200 }, 'C:\\Lib\\b.funscript': { avgSpeed: 90, maxSpeed: 150 } };
      window.funsync = bridge(vi.fn(async () => {
        if (++n > 6) throw new Error('stop');
        return answer;
      }));
      const done = start(lib2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(lib2._applyFilters).not.toHaveBeenCalled();      // open: the grid stays

      dialogMock.close({ kind: 'closed' });
      await opened;
      expect(lib2._applyFilters).toHaveBeenCalledTimes(1);    // the owed render, on close
      expect(document.activeElement).toBe(kebab());           // the NEW ⋮, after it

      await vi.advanceTimersByTimeAsync(10000);
      await done;
      vi.useRealTimers();
      expect(lib2._applyFilters).toHaveBeenCalledTimes(1);    // no second render to steal it
      expect(document.activeElement).toBe(kebab());
      container.remove();
    });
  }
});
