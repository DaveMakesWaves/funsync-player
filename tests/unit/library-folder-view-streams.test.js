/**
 * @vitest-environment jsdom
 * jsdom: the real Library renders into a DOM; i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Test day 2026-11-26.
// B099: with folder view on, a saved stream showed nowhere (the root lists
// only the source folders), and the folder view's count was English in every
// language ("1 folder · 8 videos" in German).
// B100: every source switched on but unreachable (a drive unplugged, a folder
// moved): the library said "Add a source folder" and Refresh said "No source
// folders to refresh", though one is set up and comes back by itself.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const toasts = [];
vi.mock('../../renderer/js/toast.js', () => ({ showToast: (text, type) => { toasts.push({ text, type }); } }));

const { Library } = await import('../../renderer/components/library.js');
const { buildFolderIndex } = await import('../../renderer/js/folder-index.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

const SRC = 'C:\\Lib';
const V = (name) => ({ name: `${name}.mp4`, path: `${SRC}\\${name}.mp4`, hasFunscript: true, funscriptPath: `${SRC}\\${name}.funscript`, variants: [] });
const STREAM = { key: 'stream:example.com/remote-a', pageUrl: 'https://example.com/remote-a', title: 'Remote A', site: 'example.com', duration: 8, scriptPath: 'C:\\Scripts\\Remote A.funscript', addedAt: 1 };

let lib;
let store;
let rendered;

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 1; });
  toasts.length = 0;
  store = {
    'library.viewMode': 'grid', 'library.showCardHeatmap': false,
    'library.sources': [{ path: SRC, name: 'Main Drive' }],
    'library.streams': [STREAM],
    'library.folderBrowse': true,
  };
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getVideoCategories: () => [], getCategories: () => [], getPlaylists: () => [] };
  lib = new Library({ settings, onPlayVideo: vi.fn() });
  lib._container = document.createElement('div');
  lib._container.innerHTML = '<span class="library__video-count"></span><div id="library-chips"></div><div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  document.body.appendChild(lib._container);
  lib._videos = [V('Alpha'), V('Bravo')];
  lib._mergeStreams();
  lib._videosByPath = new Map(lib._videos.map((v) => [v.path, v]));
  lib._folderBrowse = true;
  lib._currentFolderPath = null;
  lib._folderIndex = buildFolderIndex(lib._videos, store['library.sources']);
  rendered = null;
  lib._renderGrid = (items) => { rendered = items; };
});

afterEach(() => {
  lib._container.remove();
  vi.unstubAllGlobals();
});

const count = () => lib._container.querySelector('.library__video-count').textContent;

describe('folder view shows saved streams (B099)', () => {
  it('at the root: the source folder, then the stream; both counted', () => {
    lib._applyFilters();
    expect(rendered.filter((i) => i.isFolder)).toHaveLength(1);
    expect(rendered.map((i) => i.path).filter(Boolean)).toContain(STREAM.key);
    expect(count()).toBe('1 folder · 3 videos');
  });

  it('the count is in the language chosen', () => {
    _setBundlesForTests('de', DE, EN);
    lib._applyFilters();
    expect(count()).toBe('1 Ordner · 3 Videos');
  });
});

describe('every source on but unreachable (B100)', () => {
  it('the empty state names the source and says the videos come back; not "Add a source folder"', () => {
    lib._unavailablePaths = new Set([SRC]);
    lib._renderEmpty();
    expect(lib._container.querySelector('.library__empty-text').textContent).toBe('Source unavailable: Main Drive');
    expect(lib._container.querySelector('.library__empty-hint').textContent).toBe(EN.library.sourcesOfflineHint);
    expect(lib._container.querySelector('.library__empty-btn')).not.toBeNull(); // adding another stays possible
  });

  it('no source at all: still "Add a source folder", no hint', () => {
    store['library.sources'] = [];
    lib._renderEmpty();
    expect(lib._container.querySelector('.library__empty-text').textContent).toBe(EN.library.noSourcesEmpty);
    expect(lib._container.querySelector('.library__empty-hint')).toBeNull();
  });

  it('a scan that just failed counts too (the source name falls back to its folder)', () => {
    store['library.sources'] = [{ path: 'E:\\Videos\\Funscripts' }];
    lib._failedScanPaths = new Set(['E:\\Videos\\Funscripts']);
    lib._renderEmpty();
    expect(lib._container.querySelector('.library__empty-text').textContent).toBe('Source unavailable: Funscripts');
  });

  it('Refresh: "Source unavailable: <name>", not "No source folders to refresh"', async () => {
    lib._unavailablePaths = new Set([SRC]);
    await lib.refresh();
    expect(toasts).toEqual([{ text: 'Source unavailable: Main Drive', type: 'warn' }]);
  });
});
