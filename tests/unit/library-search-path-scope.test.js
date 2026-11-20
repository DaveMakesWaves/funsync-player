/**
 * @vitest-environment jsdom
 * jsdom on purpose: the last block drives the REAL Library._applyFilters
 * (library.js imports DOM-branching modules; notes/CLAUDE.md "Test
 * environments"). The search modules themselves are pure.
 */
// App test 2026-11-02, V35: library search matched file PATHS through an
// unbounded in-order subsequence. "alpha" found a, l, p, h, a somewhere in
// every file's folder chain and returned 313 of 313 videos; "bulk 29"
// returned 300 because the sandbox folder name held "29". Correct hits still
// ranked first, which is the only reason it looked like it worked.
//
// The fix: the subsequence fallback is for NAMES only. Path and context hits
// need every token as written, and the path is scored from the source
// folder's own name down, so `C:/Users/<you>/AppData/...` never matches.
// Desktop and web remote run the same algorithm with the same options
// (search-parity rule), so every algorithm test runs against both copies.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as desktop from '../../renderer/js/library-search.js';
import * as remote from '../../backend/web-remote/library-search.js';
import { Library } from '../../renderer/components/library.js';

// The tester's sandbox shape: a long temp folder whose session id holds "29".
const SANDBOX_ROOT = 'C:\\Users\\dave\\AppData\\Local\\Temp\\claude\\C--Users-dave-Desktop\\3ce3de0d-a95d-4859-ba94-2945855b78cb\\scratchpad\\library';
const bulk = Array.from({ length: 300 }, (_, i) => {
  const n = String(i).padStart(3, '0');
  return { name: `Bulk ${n}.mp4`, path: `${SANDBOX_ROOT}\\bulk\\Bulk ${n}.mp4` };
});
const sandboxLibrary = [
  ...bulk,
  { name: 'Alpha Scene.mp4', path: `${SANDBOX_ROOT}\\Alpha Scene.mp4` },
  { name: 'Zulu Last.mp4', path: `${SANDBOX_ROOT}\\Zulu Last.mp4` },
];

// The verifier's realistic library folders. None contains "ass" or "scene"
// as written, but every one contains a...s...s and s...c...e...n...e in order.
const REAL_ROOTS = [
  'D:\\Media\\Funscripts\\Downloads',
  'C:\\Users\\dave\\Videos\\Funscript Library\\Hardware Tested',
  'E:\\Adult\\EroScripts\\Collections\\Studio Packs\\Patreon Releases 2024',
];
const realNames = ['Morning Routine.mp4', 'Big Ass Compilation.mp4', 'Beach Scene 4K.mp4', 'Late Night.mp4', 'Office Party.mp4'];
const realLibrary = REAL_ROOTS.flatMap(root => realNames.map(name => ({ name, path: `${root}\\${name}` })));

const names = (list) => list.map(v => v.name);

describe.each([
  ['desktop renderer/js/library-search.js', desktop],
  ['web remote backend/web-remote/library-search.js', remote],
])('%s: path matching never turns a short query into match-everything', (_label, { fuzzySearch }) => {
  it("'alpha' finds the one Alpha video, not the whole sandbox library", () => {
    const out = fuzzySearch(sandboxLibrary, 'alpha');
    expect(names(out)).toEqual(['Alpha Scene.mp4']);
    // Same without the source roots: exact tokens alone already stop it.
    expect(names(fuzzySearch(sandboxLibrary, 'alpha', { pathRoots: [SANDBOX_ROOT] }))).toEqual(['Alpha Scene.mp4']);
  });

  it("'ass' and 'scene' return only the real hits under realistic library paths", () => {
    const ass = fuzzySearch(realLibrary, 'ass', { pathRoots: REAL_ROOTS });
    expect(new Set(names(ass))).toEqual(new Set(['Big Ass Compilation.mp4']));
    expect(ass).toHaveLength(3); // one per folder, nothing else

    const scene = fuzzySearch(realLibrary, 'scene', { pathRoots: REAL_ROOTS });
    expect(new Set(names(scene))).toEqual(new Set(['Beach Scene 4K.mp4']));
    expect(scene).toHaveLength(3);

    // No roots (web remote before /api/remote/sources answers): still exact.
    expect(fuzzySearch(realLibrary, 'ass')).toHaveLength(3);
    expect(fuzzySearch(realLibrary, 'scene')).toHaveLength(3);
  });

  it("'bulk 29' with the source root returns the name hits, not every file under a folder holding '29'", () => {
    const out = fuzzySearch(sandboxLibrary, 'bulk 29', { pathRoots: [SANDBOX_ROOT] });
    const nameOnly = fuzzySearch(sandboxLibrary, 'bulk 29', { searchPaths: false });
    expect(nameOnly.length).toBe(21); // 029, 129, 229, 290-299 + in-order 2..9 like 209
    expect(names(out)).toEqual(names(nameOnly));
  });

  it('the folders ABOVE a source never match; the source folder and its subfolders do', () => {
    const root = 'C:\\Users\\dave\\Videos\\Klixen';
    const vids = [
      { name: 'clip.mp4', path: `${root}\\Studio Packs\\clip.mp4` },
      { name: 'other.mp4', path: `${root}\\other.mp4` },
    ];
    const opts = { pathRoots: [root] };
    expect(fuzzySearch(vids, 'dave', opts)).toEqual([]);
    expect(fuzzySearch(vids, 'users', opts)).toEqual([]);
    expect(fuzzySearch(vids, 'videos', opts)).toEqual([]);
    // The source folder's own name is a real thing to type.
    expect(fuzzySearch(vids, 'klixen', opts)).toHaveLength(2);
    expect(names(fuzzySearch(vids, 'studio packs', opts))).toEqual(['clip.mp4']);
  });

  it('roots compare across slash style, case and a trailing slash; the most specific root wins', () => {
    const vids = [{ name: 'clip.mp4', path: 'C:\\Users\\Dave\\Videos\\Lib\\Nested\\Deep\\clip.mp4' }];
    expect(fuzzySearch(vids, 'dave', { pathRoots: ['c:/users/dave/videos/lib/'] })).toEqual([]);
    expect(fuzzySearch(vids, 'lib', { pathRoots: ['c:/users/dave/videos/lib/'] })).toHaveLength(1);
    // A source nested inside another source is cut at its own folder.
    const roots = ['C:\\Users\\Dave\\Videos\\Lib', 'C:\\Users\\Dave\\Videos\\Lib\\Nested'];
    expect(fuzzySearch(vids, 'lib', { pathRoots: roots })).toEqual([]);
    expect(fuzzySearch(vids, 'nested', { pathRoots: roots })).toHaveLength(1);
    // A path under no known root is matched whole (still exact tokens).
    expect(fuzzySearch(vids, 'dave', { pathRoots: ['E:\\Elsewhere'] })).toHaveLength(1);
  });

  it('a collection / category name must contain the query as written too', () => {
    const vids = [{ name: 'clip.mp4', path: '/a' }];
    const contextMap = new Map([['/a', ['A Big Collection']]]);
    expect(fuzzySearch(vids, 'abc', { contextMap })).toEqual([]); // a..b..c in order only
    expect(fuzzySearch(vids, 'big coll', { contextMap })).toHaveLength(1);
  });

  it('names keep the in-order fuzzy match', () => {
    const vids = [{ name: 'Gamma Test.avi', path: '/v/gamma.avi' }, { name: 'Other.mp4', path: '/v/other.mp4' }];
    expect(names(fuzzySearch(vids, 'gmt'))).toEqual(['Gamma Test.avi']);
  });
});

describe('desktop and web remote rank identically (search-parity rule)', () => {
  const queries = ['alpha', 'ass', 'scene', 'bulk 29', 'bulk 1', 'zulu', 'gmt', 'klixen', 'patreon 2024', 'b0'];
  const library = [...sandboxLibrary.slice(0, 60), ...realLibrary.slice(0, 10), { name: 'Gamma Test.avi', path: 'D:\\Klixen\\Gamma Test.avi' }];
  const contextMap = new Map([[realLibrary[0].path, ['Klixen Favourites']]]);
  for (const q of queries) {
    it(`'${q}'`, () => {
      const opts = { pathRoots: [SANDBOX_ROOT, ...REAL_ROOTS, 'D:\\Klixen'], contextMap };
      expect(names(remote.fuzzySearch(library, q, opts))).toEqual(names(desktop.fuzzySearch(library, q, opts)));
      expect(names(remote.fuzzySearch(library, q))).toEqual(names(desktop.fuzzySearch(library, q)));
    });
  }
});

describe('the REAL Library search scopes path hits to the configured sources', () => {
  let lib;
  afterEach(() => {
    lib?._container?.remove();
    vi.restoreAllMocks();
  });

  function runSearch(query, sources) {
    const settings = {
      get: (k) => {
        if (k === 'library.sources') return sources;
        if (k === 'library.viewMode') return 'list';
        return undefined;
      },
      set: vi.fn(),
    };
    lib = new Library({ settings });
    const container = document.createElement('div');
    container.innerHTML = '<span class="library__video-count"></span><div class="library__grid-wrapper"><div class="library__grid"></div></div>';
    document.body.appendChild(container);
    lib._container = container;
    lib._videos = sandboxLibrary;
    lib._activeTab = 'all'; // the default tab shows scripted videos only
    lib._searchQuery = query;
    let shown = null;
    lib._renderGrid = (items) => { shown = items; };
    lib._applyFilters();
    return shown;
  }

  it("typing 'bulk 29' shows the 21 name hits, not 300 files under the sandbox folder", () => {
    const shown = runSearch('bulk 29', [{ id: 's1', name: 'Library', path: SANDBOX_ROOT, enabled: true }]);
    expect(shown).toHaveLength(21);
    expect(shown.every(v => /29|2\d9/.test(v.name))).toBe(true);
  });

  it("typing a folder name above the source ('appdata') finds nothing", () => {
    const shown = runSearch('appdata', [{ id: 's1', name: 'Library', path: SANDBOX_ROOT, enabled: true }]);
    expect(shown).toEqual([]);
  });

  it('typing the source folder or a subfolder still finds its videos', () => {
    const sources = [{ id: 's1', name: 'Library', path: SANDBOX_ROOT, enabled: true }];
    expect(runSearch('bulk', sources)).toHaveLength(300);
    expect(runSearch('library', sources)).toHaveLength(302);
  });
});

// FT-046 (also in v0.9.2): desktop search never matched a CATEGORY name and
// had no PLAYLISTS at all, while the phone matched collections, playlists and
// categories (search-parity rule). `_buildSearchContextMap` read
// `settings.get('library.categories')` and `('library.videoCategories')`, but
// those maps live at the config ROOT and DataService.get reads only
// `settings`, so both were always empty. Driven through the REAL Library and
// the REAL DataService (its cache shaped like config.json), and compared with
// the phone's own map builder and search.
describe('FT-046: a category or playlist name finds its videos, as on the phone', async () => {
  const { DataService } = await import('../../renderer/js/data-service.js');
  const { buildContextMapFromGroupings } = await import('../../backend/web-remote/search-context.js');

  const ROOT = 'C:\Lib';
  const videos = [
    { id: 'v1', name: 'Alpha Scene.mp4', path: `${ROOT}\Alpha Scene.mp4`, hasFunscript: true },
    { id: 'v2', name: 'Zulu Last.mp4', path: `${ROOT}\Zulu Last.mp4`, hasFunscript: true },
    { id: 'v3', name: 'Bravo Duplicate.mp4', path: `${ROOT}\Bravo Duplicate.mp4`, hasFunscript: true },
    { id: 'v4', name: 'Charlie.mp4', path: `${ROOT}\Charlie.mp4`, hasFunscript: true },
  ];
  const byName = Object.fromEntries(videos.map((v) => [v.name, v]));
  const groupings = {
    collections: [{ id: 'c1', name: 'Weekend Picks', videoPaths: [byName['Bravo Duplicate.mp4'].path] }],
    playlists: [{ id: 'p1', name: 'Evening', createdAt: 1, videoPaths: [byName['Alpha Scene.mp4'].path] }],
    categories: [{ id: 'k1', name: 'Kitchen', color: '#f80' }],
    videoCategories: { [byName['Zulu Last.mp4'].path]: ['k1'] },
  };

  let lib;
  afterEach(() => { lib?._container?.remove(); lib = null; });

  function desktopSearch(query) {
    const ds = new DataService();
    ds._cache.settings.library = {
      ...ds._cache.settings.library,
      sources: [{ id: 's1', name: 'Lib', path: ROOT, enabled: true }],
      collections: groupings.collections,
      viewMode: 'list',
    };
    ds._cache.playlists = structuredClone(groupings.playlists);
    ds._cache.categories = structuredClone(groupings.categories);
    ds._cache.videoCategories = structuredClone(groupings.videoCategories);
    lib = new Library({ settings: ds });
    const container = document.createElement('div');
    container.innerHTML = '<span class="library__video-count"></span><div class="library__grid-wrapper"><div class="library__grid"></div></div>';
    document.body.appendChild(container);
    lib._container = container;
    lib._videos = videos;
    lib._activeTab = 'all';
    lib._searchQuery = query;
    let shown = null;
    lib._renderGrid = (items) => { shown = items; };
    lib._applyFilters();
    return names(shown);
  }

  // The phone: /api/remote/* answer each grouping with registry video ids.
  function phoneSearch(query) {
    const ids = (paths) => paths.map((p) => videos.find((v) => v.path === p)?.id).filter(Boolean);
    const cols = groupings.collections.map((c) => ({ name: c.name, videoIds: ids(c.videoPaths) }));
    const pls = groupings.playlists.map((p) => ({ name: p.name, videoIds: ids(p.videoPaths) }));
    const cats = groupings.categories.map((c) => ({
      name: c.name,
      videoIds: ids(Object.entries(groupings.videoCategories).filter(([, k]) => k.includes(c.id)).map(([p]) => p)),
    }));
    const contextMap = buildContextMapFromGroupings(videos, cols, pls, cats);
    return names(remote.fuzzySearch(videos, query, { searchPaths: true, pathRoots: [ROOT], contextMap }));
  }

  it("'kitchen' (a category) finds Zulu Last only", () => {
    expect(desktopSearch('kitchen')).toEqual(['Zulu Last.mp4']);
  });

  it("'evening' (a playlist) finds Alpha Scene only", () => {
    expect(desktopSearch('evening')).toEqual(['Alpha Scene.mp4']);
  });

  it("'weekend' (a collection) still finds Bravo Duplicate", () => {
    expect(desktopSearch('weekend')).toEqual(['Bravo Duplicate.mp4']);
  });

  it.each(['kitchen', 'evening', 'weekend', 'alpha', 'charlie', 'picks'])("'%s': desktop and phone return the same videos", (q) => {
    expect(desktopSearch(q)).toEqual(phoneSearch(q));
  });
});
