/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library builds its virtual grid and cards into a
 * DOM (library.js imports DOM-branching modules; notes/CLAUDE.md "Test
 * environments").
 */
// FT-089 (also in v0.9.2): the Library lands a row or more short of the end
// after some re-renders. Reproduced in real Chromium with the real Library
// (scratch harness, 300 videos, 1280x800): at the end of the LIST view,
// switch to the grid and the user is left 571 px above the end, the last
// card 339 px below the window's bottom edge.
//
// Why: a render that keeps the tail anchors its first window to the end with
// the row height it has, and the list -> grid switch forgets the measured
// grid row (the 180 px guess). Two frames later the row measure finds the
// real ~197 px row and re-renders, but kept the scrollTop that was the end of
// the GUESSED extent: short of the real one by every row's error.
//
// jsdom does no layout, so the wrapper's scroll extent is modelled the way a
// browser gives it: spacers plus the rows actually rendered, each rendered
// grid row REAL_ROW tall whatever the estimate says.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const COLUMNS = 5;
const REAL_ROW = 197;        // a rendered grid row: card + gap
const LIST_ROW = 50;         // a list row, what library.js assumes
const VIEWPORT = 643;        // the wrapper at 1280x800
// Dave's library size: the guessed row's error adds up over the rows above
// the end (the harness used --bulk 300; the short fall is per row).
const N = 1500;

// Fresh objects per test: a render leaves its reads on the video.
const makeVideos = () => Array.from({ length: N }, (_, i) => ({
  name: `Bulk ${String(i + 1).padStart(3, '0')}.mp4`,
  path: `C:\\Lib\\Bulk ${String(i + 1).padStart(3, '0')}.mp4`,
  hasFunscript: true,
  // A script each: the default tab is Matched.
  funscriptPath: `C:\\Lib\\Bulk ${String(i + 1).padStart(3, '0')}.funscript`,
  variants: [],
}));

let videos;
let rafQueue;
let lib;
let wrapper;
let grid;
let scrollTop;
let growth;            // px the extent grows by after layout (cards laying out late)

/** One animation frame: the callbacks queued so far, not ones they queue. */
function oneFrame() {
  const batch = rafQueue.splice(0);
  for (const cb of batch) cb(0);
}
function flushFrames() {
  for (let guard = 0; rafQueue.length && guard < 40; guard++) oneFrame();
}

const items = () => grid.querySelectorAll('.library__card, .library__list-item');
const shows = (path) => [...items()].some((el) => el.dataset.videoPath === path);
const extent = () => {
  const px = (el) => (el && el.parentNode === grid && el.style.display !== 'none' ? parseFloat(el.style.height) || 0 : 0);
  const list = grid.classList.contains('library__grid--list');
  const rows = list
    ? grid.querySelectorAll('.library__list-item').length
    : Math.ceil(grid.querySelectorAll('.library__card').length / COLUMNS);
  return Math.max(VIEWPORT, px(lib._topSpacer) + rows * (list ? LIST_ROW : REAL_ROW) + px(lib._bottomSpacer) + growth);
};
const gapToEnd = () => wrapper.scrollHeight - VIEWPORT - wrapper.scrollTop;

/** Scroll to the end as a user would: the extent grows as the tail renders. */
function toEnd() {
  for (let i = 0; i < 4; i++) {
    wrapper.scrollTop = wrapper.scrollHeight;
    lib._scrollHandler();
    flushFrames();
  }
}

/** What the browser does after a programmatic scroll: a scroll event. */
function settleWithScrollEvents() {
  for (let i = 0; i < 4; i++) {
    flushFrames();
    lib._scrollHandler();
  }
  flushFrames();
}

beforeEach(() => {
  videos = makeVideos();
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  const store = { 'library.viewMode': 'list', 'library.showCardHeatmap': false };
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  lib = new Library({ settings });
  lib._viewMode = 'list';
  const container = document.createElement('div');
  container.innerHTML = '<div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  document.body.appendChild(container);
  lib._container = container;
  lib._videos = videos;
  lib._videosByPath = new Map(videos.map((v) => [v.path, v]));
  wrapper = container.querySelector('.library__grid-wrapper');
  grid = container.querySelector('.library__grid');
  scrollTop = 0;
  growth = 0;
  Object.defineProperty(wrapper, 'scrollTop', {
    // A browser clamps the position to the extent at its next layout.
    get: () => Math.max(0, Math.min(scrollTop, extent() - VIEWPORT)),
    set: (v) => { scrollTop = Math.max(0, Math.min(v, extent() - VIEWPORT)); },
    configurable: true,
  });
  Object.defineProperty(wrapper, 'scrollHeight', { get: extent, configurable: true });
  Object.defineProperty(wrapper, 'clientHeight', { value: VIEWPORT, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1248, configurable: true });
  lib._measureGridColumns = () => COLUMNS;
  // jsdom has no layout: a rendered grid row measures what the browser
  // measured, REAL_ROW (card 181 + gap 16).
  lib._measureRowHeight = (g) => (g.querySelector('.library__card') ? REAL_ROW : null);
  lib._queueThumbnail = () => {};
  window.funsync = { readFunscript: vi.fn(async () => null) };
});

afterEach(() => {
  flushFrames();
  lib._container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a render that keeps the tail ends AT the end once the row height is measured (FT-089)', () => {
  it('list -> grid at the end: the last card is on screen and the scroll is at the real end', () => {
    lib._renderGrid(videos);
    flushFrames();
    toEnd();
    expect(gapToEnd()).toBeLessThan(2);

    // Every render on the way builds one screenful: the measure's re-render
    // too, not every card from the guessed end to the real one (V81's cost).
    const built = [];
    const update = lib._virtualScrollUpdate.bind(lib);
    lib._virtualScrollUpdate = (w, g) => { update(w, g); built.push(items().length); };

    lib._setViewMode('grid');            // forgets the grid row: the 180 px guess
    settleWithScrollEvents();

    expect(lib._vsRowHeight).toBe(REAL_ROW);   // the measure did run
    expect(gapToEnd()).toBeLessThan(2);
    expect(shows(videos[N - 1].path)).toBe(true);
    // ...and it is ON screen: the last row is the bottom of the extent.
    const lastRowTop = wrapper.scrollHeight - REAL_ROW;
    expect(lastRowTop).toBeGreaterThanOrEqual(wrapper.scrollTop);
    const screenful = (Math.ceil(VIEWPORT / 180) + 2 * 3 + 1) * COLUMNS;
    expect(Math.max(...built)).toBeLessThanOrEqual(screenful);
  });

  it('grid -> list -> grid at the end comes back to the end', () => {
    lib._viewMode = 'grid';
    lib._renderGrid(videos);
    settleWithScrollEvents();
    toEnd();
    lib._setViewMode('list');
    settleWithScrollEvents();
    expect(gapToEnd()).toBeLessThan(2);
    lib._setViewMode('grid');
    settleWithScrollEvents();
    expect(gapToEnd()).toBeLessThan(2);
    expect(shows(videos[N - 1].path)).toBe(true);
  });

  it('a user scroll away from the end before the measure lands is left alone', () => {
    lib._renderGrid(videos);
    flushFrames();
    toEnd();

    lib._setViewMode('grid');
    oneFrame();                          // the restore, and the measure's warm-up
    wrapper.scrollTop = 3000;            // the user scrolls up
    lib._scrollHandler();
    flushFrames();

    expect(lib._vsRowHeight).toBe(REAL_ROW);
    expect(wrapper.scrollTop).toBe(3000);
    expect(gapToEnd()).toBeGreaterThan(1000);
  });

  it('cards that lay out after the restore do not cancel the pin (9 px in real Chromium)', () => {
    // Traced in the real-Chromium harness: the restore's scroll event
    // arrived reading 6885 against an end of 6894, because cards had laid
    // out in between and grown the extent. A rule of "not at the end = the
    // user scrolled away" let go there, and the measure's re-render then
    // stayed 571 px short.
    lib._renderGrid(videos);
    flushFrames();
    toEnd();

    lib._setViewMode('grid');
    oneFrame();                          // the restore lands on the end as it is
    growth = 9;                          // ...then cards lay out, the extent grows
    lib._scrollHandler();                // the restore's own scroll event, 9 px short
    settleWithScrollEvents();

    expect(lib._vsRowHeight).toBe(REAL_ROW);
    expect(gapToEnd()).toBeLessThan(2);
    expect(shows(videos[N - 1].path)).toBe(true);
  });

  it('a render that did not keep the tail does not jump to the end', () => {
    lib._renderGrid(videos);
    flushFrames();
    wrapper.scrollTop = 2000;            // mid-list
    lib._scrollHandler();
    flushFrames();

    lib._setViewMode('grid');
    settleWithScrollEvents();

    expect(gapToEnd()).toBeGreaterThan(1000);
  });

  it('the pin lets go once the layout has settled', () => {
    lib._renderGrid(videos);
    flushFrames();
    toEnd();
    lib._setViewMode('grid');
    settleWithScrollEvents();
    expect(gapToEnd()).toBeLessThan(2);
    // A later scroll is the user's alone.
    wrapper.scrollTop = 1500;
    lib._scrollHandler();
    flushFrames();
    expect(wrapper.scrollTop).toBe(1500);
  });
});
