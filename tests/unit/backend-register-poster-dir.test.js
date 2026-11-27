/**
 * After a reload the phone and the headsets show the user's uploaded
 * posters again (N-05, TODO triage 2026-11-23, also in v0.9.2). The backend
 * serves a poster only from the custom-thumbs folder it was told about, and
 * the library fetches that folder lazily, so the FIRST registration after a
 * load went without it and they showed the generated frame until Library >
 * Refresh. Once the folder is known, the library registers again, but only
 * when some video has a poster (a frame pin needs no folder).
 * jsdom: library.js imports DOM-touching modules (notes/CLAUDE.md).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const DIR = 'C:\\Users\\x\\AppData\\Roaming\\funsync-player\\custom-thumbs';
let posts;

function lib(customThumbnails) {
  const store = { 'backend.port': 5123, 'library.customThumbnails': customThumbnails, 'library.sources': [] };
  const l = new Library({ settings: { get: (k) => store[k], set: () => {}, getPlaylists: () => [], getCategories: () => [] } });
  l._videos = [{ path: 'C:\\V\\Alpha.mp4', name: 'Alpha.mp4' }];
  return l;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  posts = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (opts.body) posts.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  });
  window.funsync = { getCustomThumbsDir: vi.fn(async () => DIR) };
});
afterEach(() => { delete globalThis.fetch; });

describe('registering with the backend after a load', () => {
  it('a library with a poster: registered again once the folder is known, now carrying it', async () => {
    const l = lib({ 'C:\\V\\Alpha.mp4': { type: 'image', imagePath: `${DIR}\\a.jpg` } });
    l._registerWithBackend();
    await vi.waitFor(() => expect(posts.some((p) => p.customThumbsDir === DIR)).toBe(true));
    expect(posts[0].customThumbsDir).toBeUndefined(); // the first went without it
    expect(window.funsync.getCustomThumbsDir).toHaveBeenCalledTimes(1);
  });

  it('only frame pins (no poster): no second registration', async () => {
    const l = lib({ 'C:\\V\\Alpha.mp4': { seekPct: 0.3 } });
    l._registerWithBackend();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(posts.length).toBe(1);
  });
});
