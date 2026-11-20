/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library builds its chip strip, virtual grid and
 * cards into a DOM (library.js imports DOM-branching modules; notes/CLAUDE.md
 * "Test environments").
 */
// FT-068 (app test V81, notes/UPDATES.md "Not covered"): removing the
// Matched chip at the bottom of a large library threw the user off the end
// of the list. The chip's X ran `_switchTab('all')`, which already filters
// and renders, and then rendered a SECOND time. The first render kept the
// tail; the second read the scroll position mid-way through the first one
// (the old list's bottom, now mid-list in the longer one) and its restore
// ran last, so the user landed in the middle of the library instead of at
// the end they were looking at.
//
// What the user gets is pinned here: one render, and still at the bottom
// with the last video on screen. The VR chip (which always rendered once)
// is the control.
//
// jsdom does no layout: the wrapper's scroll extent is modelled from the
// spacers and rendered rows, as in library-large-library-speed.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const COLUMNS = 7;
const ROW = 197;
const VIEWPORT = 900;
const N = 2000;

let rafQueue;
let lib;
let wrapper;
let grid;
let videos;

function flushFrames() {
  for (let guard = 0; rafQueue.length && guard < 30; guard++) {
    const batch = rafQueue.splice(0);
    for (const cb of batch) cb(0);
  }
}

const cards = () => grid.querySelectorAll('.library__card');
const shows = (path) => [...cards()].some((c) => c.dataset.videoPath === path);
const atBottom = () => wrapper.scrollTop >= wrapper.scrollHeight - VIEWPORT - 1;
const chip = (key) => lib._container.querySelector(`#library-chips .filter-chip[data-filter-key="${key}"]`);

function mount() {
  lib._container.innerHTML = '<div id="library-chips"></div>'
    + '<div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  wrapper = lib._container.querySelector('.library__grid-wrapper');
  grid = lib._container.querySelector('.library__grid');
  const g = grid;
  let scrollTop = 0;
  const extent = () => {
    const px = (el) => (el && el.parentNode === g && el.style.display !== 'none' ? parseFloat(el.style.height) || 0 : 0);
    const rows = Math.ceil(g.querySelectorAll('.library__card').length / COLUMNS);
    return Math.max(VIEWPORT, px(lib._topSpacer) + rows * ROW + px(lib._bottomSpacer));
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

function toBottom() {
  for (let i = 0; i < 4; i++) {   // the extent grows as the tail renders
    wrapper.scrollTop = wrapper.scrollHeight;
    lib._scrollHandler();
    flushFrames();
  }
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  // Half the library scripted, interleaved, so Matched is a shorter list
  // whose bottom sits mid-way through the full one. Video 1999 is not
  // scripted: the full list's last card is one Matched never showed.
  videos = Array.from({ length: N }, (_, i) => ({
    name: `Video ${String(i).padStart(4, '0')}.mp4`,
    path: `C:\\Lib\\Video ${String(i).padStart(4, '0')}.mp4`,
    hasFunscript: i % 2 === 0,
    funscriptPath: i % 2 === 0 ? `C:\\Lib\\Video ${String(i).padStart(4, '0')}.funscript` : null,
    variants: [],
  }));
  const store = { 'library.viewMode': 'grid', 'library.showCardHeatmap': false };
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
  mount();
  lib._vsMeasuredRowHeight = ROW;
  lib._measureGridColumns = () => COLUMNS;
  lib._queueThumbnail = () => {};
  window.funsync = {
    readFunscript: vi.fn(async () => JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] })),
  };
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushFrames();
  lib._container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.funsync;
});

describe('removing a library filter chip keeps the user where they were (FT-068)', () => {
  it('Matched chip X at the bottom: one render, still at the bottom, the last video on screen', () => {
    lib._activeTab = 'matched';
    lib._renderFilterChips();
    lib._applyFilters();
    flushFrames();
    toBottom();
    expect(shows(videos[N - 2].path)).toBe(true);   // the last Matched video

    const renders = vi.spyOn(lib, '_renderGrid');
    chip('tab').click();
    flushFrames();
    lib._scrollHandler();   // the scroll the position restore fires
    flushFrames();

    expect(lib._activeTab).toBe('all');
    expect(chip('tab')).toBeNull();
    // What the user sees first: still at the end, the last video on screen.
    expect(atBottom()).toBe(true);
    expect(shows(videos[N - 1].path)).toBe(true);
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it('Matched chip X mid-list: one render and the scroll position is kept', () => {
    lib._activeTab = 'matched';
    lib._renderFilterChips();
    lib._applyFilters();
    flushFrames();
    wrapper.scrollTop = 9850;
    lib._scrollHandler();
    flushFrames();

    const renders = vi.spyOn(lib, '_renderGrid');
    chip('tab').click();
    flushFrames();

    expect(renders).toHaveBeenCalledTimes(1);
    expect(wrapper.scrollTop).toBe(9850);
  });

  it('VR chip X at the bottom (control): one render, still at the bottom', () => {
    // Flat-only first, so removing the chip grows the list as Matched does.
    // vr-detect reads the path as well as the name.
    videos.forEach((v, i) => {
      if (i % 3 !== 1) return;   // 1999 % 3 === 1: the last video is VR, unseen under Non-VR
      v.name = v.name.replace('.mp4', '_180_sbs.mp4');
      v.path = v.path.replace('.mp4', '_180_sbs.mp4');
    });
    lib._videosByPath = new Map(videos.map((v) => [v.path, v]));
    lib._activeTab = 'all';   // the Library opens on Matched
    lib._vrFilter = 'flat';
    lib._renderFilterChips();
    lib._applyFilters();
    flushFrames();
    toBottom();

    const renders = vi.spyOn(lib, '_renderGrid');
    chip('vr').click();
    flushFrames();
    lib._scrollHandler();
    flushFrames();

    expect(renders).toHaveBeenCalledTimes(1);
    expect(lib._vrFilter).toBe('all');
    expect(atBottom()).toBe(true);
    expect(shows(videos[N - 1].path)).toBe(true);
  });
});
