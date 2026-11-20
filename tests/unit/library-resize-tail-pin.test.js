/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library builds its virtual grid and cards into a
 * DOM (library.js imports DOM-branching modules; notes/CLAUDE.md "Test
 * environments").
 */
// E2-05 (found while FT-089, by reading; probably also in v0.9.2): a window
// RESIZE at the end of the grid was not pinned. `_handleResize` re-measures
// the columns and the row height (a card's height follows its width) and
// re-renders at the OLD scrollTop: the same short landing FT-089 fixed for
// the view switch. Narrowing the window is the bad case: the cards on screen
// re-flow into more rows and grow the extent under an unchanged scrollTop,
// and the update then renders the middle of the library at that offset.
//
// jsdom does no layout, so the wrapper's scroll extent is modelled the way a
// browser gives it, as in library-tail-pin.test.js: spacers plus the rows
// actually rendered at the CURRENT column count and real row height, with
// scrollTop clamped to the extent. A resize changes both, and a clamp that
// moves the position fires a scroll event, as a browser's does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const VIEWPORT = 643;
const N = 1500;
// Two window widths: a 2560 px window holds 10 columns of slightly taller
// cards, a 1280 px one 5 (minmax(220px, 1fr) and a 16/9 thumbnail).
const WIDE = { columns: 10, row: 205 };
const NARROW = { columns: 5, row: 197 };

const makeVideos = () => Array.from({ length: N }, (_, i) => ({
  name: `Bulk ${String(i + 1).padStart(4, '0')}.mp4`,
  path: `C:\\Lib\\Bulk ${String(i + 1).padStart(4, '0')}.mp4`,
  hasFunscript: true,
  funscriptPath: `C:\\Lib\\Bulk ${String(i + 1).padStart(4, '0')}.funscript`,
  variants: [],
}));

let videos;
let rafQueue;
let lib;
let wrapper;
let grid;
let scrollTop;
let layout;          // the window's current { columns, row }

function oneFrame() {
  const batch = rafQueue.splice(0);
  for (const cb of batch) cb(0);
}
function flushFrames() {
  for (let guard = 0; rafQueue.length && guard < 40; guard++) oneFrame();
}

const items = () => grid.querySelectorAll('.library__card');
const shows = (path) => [...items()].some((el) => el.dataset.videoPath === path);
const extent = () => {
  const px = (el) => (el && el.parentNode === grid && el.style.display !== 'none' ? parseFloat(el.style.height) || 0 : 0);
  const rows = Math.ceil(items().length / layout.columns);
  return Math.max(VIEWPORT, px(lib._topSpacer) + rows * layout.row + px(lib._bottomSpacer));
};
const clamp = (v) => Math.max(0, Math.min(v, extent() - VIEWPORT));
const gapToEnd = () => wrapper.scrollHeight - VIEWPORT - wrapper.scrollTop;

/** Scroll to the end as a user would: the extent grows as the tail renders. */
function toEnd() {
  for (let i = 0; i < 4; i++) {
    wrapper.scrollTop = wrapper.scrollHeight;
    lib._scrollHandler();
    flushFrames();
  }
}

function settleWithScrollEvents() {
  for (let i = 0; i < 4; i++) {
    flushFrames();
    lib._scrollHandler();
  }
  flushFrames();
}

/**
 * The window changes size. The browser re-lays the cards on screen out at
 * once (and clamps the position, with a scroll event when that moves it);
 * the library's debounced `_handleResize` runs after that.
 */
function resizeTo(next) {
  const before = wrapper.scrollTop;
  layout = next;
  if (clamp(scrollTop) !== scrollTop) {
    scrollTop = clamp(scrollTop);
    if (scrollTop !== before) lib._scrollHandler();
  }
  flushFrames();
  lib._handleResize();
  settleWithScrollEvents();
}

beforeEach(() => {
  videos = makeVideos();
  rafQueue = [];
  layout = WIDE;
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  const store = { 'library.viewMode': 'grid', 'library.showCardHeatmap': false };
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  lib = new Library({ settings });
  lib._viewMode = 'grid';
  const container = document.createElement('div');
  container.innerHTML = '<div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  document.body.appendChild(container);
  lib._container = container;
  lib._videos = videos;
  lib._videosByPath = new Map(videos.map((v) => [v.path, v]));
  wrapper = container.querySelector('.library__grid-wrapper');
  grid = container.querySelector('.library__grid');
  scrollTop = 0;
  Object.defineProperty(wrapper, 'scrollTop', {
    get: () => clamp(scrollTop),
    set: (v) => { scrollTop = clamp(v); },
    configurable: true,
  });
  Object.defineProperty(wrapper, 'scrollHeight', { get: extent, configurable: true });
  Object.defineProperty(wrapper, 'clientHeight', { value: VIEWPORT, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1248, configurable: true });
  lib._measureGridColumns = () => layout.columns;
  lib._measureRowHeight = (g) => (g.querySelector('.library__card') ? layout.row : null);
  lib._queueThumbnail = () => {};
  window.funsync = { readFunscript: vi.fn(async () => null) };
  lib._renderGrid(videos);
  settleWithScrollEvents();
});

afterEach(() => {
  flushFrames();
  lib._container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const atTheEnd = () => {
  expect(gapToEnd()).toBeLessThan(2);
  expect(shows(videos[N - 1].path)).toBe(true);
  // ...on screen: the last row is the bottom of the extent.
  expect(wrapper.scrollHeight - layout.row).toBeGreaterThanOrEqual(wrapper.scrollTop);
};

describe('a window resize at the end of the grid ends at the end (E2-05)', () => {
  it('narrower (2560 -> 1280 px, 10 -> 5 columns): still at the end, the last card on screen', () => {
    toEnd();
    atTheEnd();
    resizeTo(NARROW);
    expect(lib._vsColumns).toBe(5);
    expect(lib._vsRowHeight).toBe(NARROW.row);
    atTheEnd();
  });

  it('wider (1280 -> 2560 px, 5 -> 10 columns): still at the end', () => {
    resizeTo(NARROW);
    toEnd();
    atTheEnd();
    resizeTo(WIDE);
    expect(lib._vsColumns).toBe(10);
    atTheEnd();
  });

  it('back and forth at the end stays at the end', () => {
    toEnd();
    resizeTo(NARROW);
    resizeTo(WIDE);
    resizeTo(NARROW);
    atTheEnd();
  });

  it('a resize mid-list does not jump to the end', () => {
    wrapper.scrollTop = 4000;
    lib._scrollHandler();
    flushFrames();
    resizeTo(NARROW);
    expect(gapToEnd()).toBeGreaterThan(10000);
  });

  // Block E2 verify-2, in the real app: 2560 -> 1280 px at the end landed
  // 540 px short, maximised -> 1280 px 626 px short. The order of events is
  // what the tests above left out. The window's `resize` event comes first;
  // then Chromium's scroll anchoring keeps a card on screen in place as the
  // narrower grid grows, which moves scrollTop down (803 -> 1522 there, still
  // short of the new end) and fires a scroll event; only then does the
  // debounced `_handleResize` run, and that scroll had just re-read
  // "at the end" against the grown extent: false.
  it('the browser order: resize event, scroll anchoring\'s scroll, then the debounce: still at the end', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      toEnd();
      vi.advanceTimersByTime(200); // the scroll has ended
      atTheEnd();
      expect(lib._vsTailPin).toBe(0); // nothing held from before: the resize alone decides

      // 1. The window's resize event (the listener `show()` adds).
      lib._onResize();
      // 2. The cards on screen re-flow at the new width; anchoring keeps the
      //    first card on screen where it was, by moving scrollTop.
      const top = parseFloat(lib._topSpacer.style.height) || 0;
      const cardTop = (i, l) => top + Math.floor(i / l.columns) * l.row;
      const before = wrapper.scrollTop;
      const anchor = [...items()].findIndex((_, i) => cardTop(i, WIDE) >= before);
      expect(anchor).toBeGreaterThan(9); // a card below the first rendered row
      layout = NARROW;
      wrapper.scrollTop = before + (cardTop(anchor, NARROW) - cardTop(anchor, WIDE));
      expect(wrapper.scrollTop).toBeGreaterThan(before);
      // The anchored spot is rows short of the end (567 px here; 540 px in
      // the real app at 2560 -> 1280).
      expect(gapToEnd()).toBeGreaterThan(2 * NARROW.row);
      lib._scrollHandler();
      expect(lib._vsAtEnd).toBe(false); // what the debounced handler used to go by
      flushFrames();
      // 3. The debounce runs.
      vi.advanceTimersByTime(100);
      settleWithScrollEvents();
      vi.advanceTimersByTime(200);
      settleWithScrollEvents();
      expect(lib._vsColumns).toBe(5);
      atTheEnd();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the same order mid-list: the resize event reads "not at the end", and it stays put', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      wrapper.scrollTop = 4000;
      lib._scrollHandler();
      flushFrames();
      vi.advanceTimersByTime(200);
      lib._onResize();
      layout = NARROW;
      lib._scrollHandler();
      flushFrames();
      vi.advanceTimersByTime(100);
      settleWithScrollEvents();
      expect(gapToEnd()).toBeGreaterThan(10000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolled up from the end before the resize: left where the user is', () => {
    toEnd();
    wrapper.scrollTop = 6000;
    lib._scrollHandler();
    flushFrames();
    resizeTo(NARROW);
    expect(gapToEnd()).toBeGreaterThan(10000);
  });
});
