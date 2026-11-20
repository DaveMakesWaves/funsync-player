/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its detail grid and
 * the REAL playlists.css runs through jsdom's cascade (getComputedStyle).
 */
// App test 2026-11-02, V67 (reported by Dave). In a playlist's grid a
// WATCHED video's tick sat in the thumbnail's top-right corner, exactly where
// the remove (X) button appears on hover: both were absolute at top/right
// 6px, z-index 2, and the tick was appended after the X, so it painted over
// most of it. The top-left corner had the same clash: the "Last watched"
// pill and the unplugged (drive offline) badge both sat at top/left 6px.
//
// jsdom has no layout, so each corner element's box is worked out from its
// COMPUTED style (position, top/left/right, width/height, max-width), the
// same values Chromium lays out from. An auto-width pill is taken at its
// max-width, the widest any translation can make it. `:hover` cannot be
// simulated, so it is mapped to a class with the same specificity; keyboard
// focus is real (`:focus-within`). Every combination of watched x last
// watched x unavailable, at rest, hovered and with the X focused, must show
// no two visible corner elements overlapping, and must still show each one
// whose job it is to be seen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { Playlists } from '../../renderer/components/playlists.js';

const VIDEO = 'D:\\PL\\Alpha.mp4';
// The grid's narrowest column: `repeat(auto-fill, minmax(220px, 1fr))`.
const THUMB_WIDTH = 220;

const CSS = fs.readFileSync('renderer/styles/playlists.css', 'utf8')
  .replace(/:hover\b/g, '.test-hover');

let style;
let container;
let savedFunsync;

beforeEach(() => {
  savedFunsync = window.funsync;
  style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
});

afterEach(() => {
  window.funsync = savedFunsync;
  style.remove();
  container?.remove();
  vi.restoreAllMocks();
});

/** Render a one-video playlist whose card is in the given state. */
async function renderCard({ watched = false, lastWatched = false, unavailable = false, view = 'grid' }) {
  const store = {
    'library.resumePositions': watched ? { [VIDEO]: { finished: true, duration: 600, updatedAt: 1 } } : {},
    'library.playlistProgress': lastWatched ? { p1: { lastVideoPath: VIDEO, updatedAt: 1 } } : {},
  };
  const playlist = { id: 'p1', name: 'P', videoPaths: [VIDEO] };
  window.funsync = {
    ...savedFunsync,
    filesExist: vi.fn(async (paths) => paths.map(() => !unavailable)),
    readFunscript: vi.fn(async () => null),
    getThumbnail: vi.fn(async () => null),
  };
  const playlists = new Playlists({
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
      getPlaylists: () => [playlist],
      getPlaylist: (id) => (id === 'p1' ? playlist : null),
    },
    library: { getVideoByPath: () => null },
    onPlayVideo: () => {},
    onPlayAll: () => {},
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  playlists._container = container;
  playlists._viewMode = view;
  playlists._view = 'detail';
  playlists._detailPlaylistId = 'p1';
  await playlists._renderDetail('p1');
  await new Promise((r) => setTimeout(r, 0));
  return container.querySelector(view === 'list' ? '.playlists__list-item' : '.playlists__video-card');
}

const px = (v) => (typeof v === 'string' && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);

/** A length as px within a box `w` wide: `Npx`, `N%` or `calc(100% - Npx)`. */
function length(v, w) {
  if (px(v) !== null) return px(v);
  let m = /^calc\(100% - ([\d.]+)px\)$/.exec(v || '');
  if (m) return w - parseFloat(m[1]);
  m = /^([\d.]+)%$/.exec(v || '');
  if (m) return (w * parseFloat(m[1])) / 100;
  return null;
}

/**
 * The element's box inside the thumbnail, or null when the user cannot see
 * it (display none, hidden, or fully transparent).
 */
function visibleBox(el) {
  if (!el) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
  expect(cs.position, `${el.className} should overlay the thumbnail`).toBe('absolute');
  const w = px(cs.width) ?? length(cs.maxWidth, THUMB_WIDTH) ?? THUMB_WIDTH;
  const h = px(cs.height) ?? 18;
  const left = px(cs.left);
  const x0 = left !== null ? left : THUMB_WIDTH - px(cs.right) - w;
  const y0 = px(cs.top) ?? 0;
  return { name: el.className.split(' ')[0], x0, x1: x0 + w, y0, y1: y0 + h };
}

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function corners(card) {
  return {
    remove: card.querySelector('.playlists__video-remove-btn'),
    tick: card.querySelector('.playlists__watched-check'),
    pill: card.querySelector('.playlists__last-watched'),
    unplugged: card.querySelector('.playlists__unavailable-badge'),
  };
}

const STATES = [];
for (const watched of [false, true]) {
  for (const lastWatched of [false, true]) {
    for (const unavailable of [false, true]) {
      for (const interaction of ['rest', 'hover', 'focus']) {
        STATES.push({ watched, lastWatched, unavailable, interaction });
      }
    }
  }
}

const label = (s) => `${s.watched ? 'watched' : 'unwatched'}, ${s.lastWatched ? 'last watched' : 'not last'}, `
  + `${s.unavailable ? 'unavailable' : 'available'}, ${s.interaction}`;

describe('V67: corner badges on a playlist grid tile never overlap', () => {
  it.each(STATES.map((s) => [label(s), s]))('%s', async (_, state) => {
    const card = await renderCard(state);
    const els = corners(card);
    // Set the interaction BEFORE the first style read: jsdom caches styles.
    if (state.interaction === 'hover') card.classList.add('test-hover');
    if (state.interaction === 'focus') els.remove.focus();

    const boxes = Object.fromEntries(Object.entries(els).map(([k, el]) => [k, visibleBox(el)]));
    const shown = Object.values(boxes).filter(Boolean);
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        expect(overlaps(shown[i], shown[j]), `${shown[i].name} overlaps ${shown[j].name}`).toBe(false);
      }
    }

    // ...and nothing that has a job to do was simply hidden to get there.
    const xShows = state.unavailable || state.interaction !== 'rest';
    expect(!!boxes.remove, 'remove button visible').toBe(xShows);
    if (state.lastWatched) expect(boxes.pill, 'Last watched pill visible').toBeTruthy();
    if (state.unavailable) expect(boxes.unplugged, 'unplugged badge visible').toBeTruthy();
    // The tick steps aside only for the X; an unavailable tile keeps both.
    if (state.watched) expect(!!boxes.tick, 'watched tick visible').toBe(state.unavailable || !xShows);
  });
});

describe('V67: list rows', () => {
  it('every marker flows in the row, so none can sit on another, and the pill is not truncated', async () => {
    const row = await renderCard({ watched: true, lastWatched: true, unavailable: true, view: 'list' });
    for (const sel of ['.playlists__watched-check', '.playlists__last-watched', '.playlists__unavailable-badge']) {
      const el = row.querySelector(sel);
      expect(el, sel).toBeTruthy();
      expect(getComputedStyle(el).position, sel).toBe('static');
    }
    expect(getComputedStyle(row.querySelector('.playlists__last-watched')).maxWidth).not.toMatch(/calc/);
  });
});
