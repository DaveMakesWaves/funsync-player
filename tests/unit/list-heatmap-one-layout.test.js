/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Categories and Playlists components build their
 * list rows and heatmap canvases into a DOM (notes/CLAUDE.md "Test
 * environments").
 */
// V81 review (Dave, 2026-11-03): the category and playlist list views drew
// each row's heatmap strip with its own `renderBins`, which reads the
// canvas's layout and then resizes it: one full-document layout PER ROW. In
// the library list view that was 13 s of a 19 s profile on 1,546 videos. A
// big category or playlist froze the same way. They now queue their strips
// like the library does, so the strips of one render cost one layout.
//
// jsdom does no layout; the canvas models "a read after a write costs a
// layout", which is the browser behaviour that hurt.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Categories } from '../../renderer/components/categories.js';
import { Playlists } from '../../renderer/components/playlists.js';

const N = 40;
const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }] });

let rafQueue;
let layouts;
let layoutDirty;
let drawn;

function flushFrames() {
  for (let guard = 0; rafQueue.length && guard < 30; guard++) {
    const batch = rafQueue.splice(0);
    for (const cb of batch) cb(0);
  }
}
const flushReads = () => new Promise((r) => setTimeout(r, 0));

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
        layoutDirty = true;
        if (dim === 'width') drawn.add(this);
      },
    });
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  rafQueue = [];
  layouts = 0;
  layoutDirty = true;
  drawn = new Set();
  vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  installCanvasLayoutModel();
});

afterEach(async () => {
  await flushReads();
  flushFrames();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete HTMLCanvasElement.prototype.clientWidth;
  delete HTMLCanvasElement.prototype.clientHeight;
  delete HTMLCanvasElement.prototype.width;
  delete HTMLCanvasElement.prototype.height;
  delete window.funsync;
});

const paths = Array.from({ length: N }, (_, i) => `E:\\Videos\\Clip ${String(i).padStart(2, '0')}.mp4`);

describe('category list view: the strips of one render cost one layout', () => {
  const CAT = { id: 'cat-1', name: 'Big', color: '#e94560' };

  async function openListDetail() {
    window.funsync = {
      filesExist: vi.fn(async (list) => list.map(() => true)),
      fileExists: vi.fn(async () => true),
      readFunscript: vi.fn(async () => SCRIPT),
      generateSingleThumbnail: vi.fn(async () => null),
    };
    const settings = {
      getCategories: () => [CAT],
      getVideosByCategory: (id) => (id === CAT.id ? paths.slice() : []),
      get: () => ({}),
      unassignCategory: vi.fn(),
    };
    const cats = new Categories({ settings, onPlayVideo: vi.fn(), library: null });
    const container = document.createElement('div');
    document.body.appendChild(container);
    cats._container = container;
    cats._viewMode = 'list';
    cats._view = 'detail';
    cats._detailCategoryId = CAT.id;
    await cats._renderDetail(CAT.id);
    return { cats, container };
  }

  // Counted from before the render: a strip drawn the moment its read lands
  // is a layout too.
  it('every row strip is drawn, all measured in one layout', async () => {
    const { container } = await openListDetail();
    await flushReads();               // every row's script read lands
    flushFrames();

    const canvases = container.querySelectorAll('.categories__list-heatmap');
    expect(canvases).toHaveLength(N);
    expect([...canvases].every((c) => drawn.has(c))).toBe(true);
    expect(layouts).toBe(1);
  });

  it('a re-render that draws from the cached bins costs one layout too', async () => {
    const { cats, container } = await openListDetail();
    await flushReads();
    flushFrames();

    layouts = 0;
    layoutDirty = true;
    await cats._renderDetail(CAT.id);  // e.g. after removing a video
    await flushReads();
    flushFrames();

    const canvases = container.querySelectorAll('.categories__list-heatmap');
    expect(canvases).toHaveLength(N);
    expect([...canvases].every((c) => drawn.has(c))).toBe(true);
    expect(layouts).toBe(1);
  });
});

describe('playlist list view: the strips of one render cost one layout', () => {
  it('rows whose scripts land together are measured together', async () => {
    window.funsync = { readFunscript: vi.fn(async () => SCRIPT) };
    const pl = Object.create(Playlists.prototype);
    pl._binsByPath = new Map();
    const canvases = paths.map(() => {
      const c = document.createElement('canvas');
      document.body.appendChild(c);
      return c;
    });
    paths.forEach((p, i) => pl._loadListStats(p, p.replace('.mp4', '.funscript'), null, null, canvases[i], null));
    await flushReads();
    flushFrames();

    expect(canvases.every((c) => drawn.has(c))).toBe(true);
    expect(layouts).toBe(1);

    // ...and drawing the same rows again from the cached bins.
    layouts = 0;
    layoutDirty = true;
    paths.forEach((p, i) => pl._loadListStats(p, p.replace('.mp4', '.funscript'), null, null, canvases[i], null));
    await flushReads();
    flushFrames();
    expect(layouts).toBe(1);
  });
});
