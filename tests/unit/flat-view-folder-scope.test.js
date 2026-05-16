// Tests for the flat-view folder-scope feature.
//
// Community feedback (GGEZGitGud, 2026-05-15): "when i switch into video mode
// from folder mode, it always shows all videos in source. I'd prefer it scoped
// to the current folder I was browsing." The fix scopes `_applyFilters`'s flat
// path to `descendantsOf(folderIndex, currentFolderPath)` when a non-source
// folder is selected.
//
// These tests exercise `Library._getFlatScopeVideos` against a real folder
// index built from `buildFolderIndex` — pure logic, no DOM.

import { describe, it, expect } from 'vitest';
import { Library } from '../../renderer/components/library.js';
import { buildFolderIndex } from '../../renderer/js/folder-index.js';

const getFlatScope = Library.prototype._getFlatScopeVideos;

function makeCtx({ videos = [], sources = [], currentFolderPath = null } = {}) {
  const folderIndex = buildFolderIndex(videos, sources);
  return {
    _videos: videos,
    _folderIndex: folderIndex,
    _currentFolderPath: currentFolderPath,
  };
}

const SRC_A = { id: 'a', name: 'Source A', path: '/lib/a', enabled: true };
const SRC_B = { id: 'b', name: 'Source B', path: '/lib/b', enabled: true };

const fixtureVideos = [
  { path: '/lib/a/top.mp4' },
  { path: '/lib/a/sub1/v1.mp4' },
  { path: '/lib/a/sub1/v2.mp4' },
  { path: '/lib/a/sub1/sub2/v3.mp4' },
  { path: '/lib/a/sub1/sub2/v4.mp4' },
  { path: '/lib/a/sub1/sub2/sub3/v5.mp4' },
  { path: '/lib/a/other/v6.mp4' },
  { path: '/lib/b/x.mp4' },
];

describe('Library._getFlatScopeVideos', () => {
  it('returns the full library when no folder is selected', () => {
    const ctx = makeCtx({ videos: fixtureVideos, sources: [SRC_A, SRC_B] });
    const scoped = getFlatScope.call(ctx);
    expect(scoped).toBe(ctx._videos);
    expect(scoped.length).toBe(fixtureVideos.length);
  });

  it('returns the full library when there is no folder index', () => {
    const ctx = makeCtx({ videos: fixtureVideos, sources: [SRC_A] });
    ctx._folderIndex = null;
    ctx._currentFolderPath = '/lib/a/sub1';
    expect(getFlatScope.call(ctx)).toBe(ctx._videos);
  });

  it('returns the full library when the selected path is unknown to the index', () => {
    // Defensive: a stale `_currentFolderPath` from a previous scan should not
    // collapse the view to nothing — fall back to the full library.
    const ctx = makeCtx({
      videos: fixtureVideos,
      sources: [SRC_A, SRC_B],
      currentFolderPath: '/lib/a/ghost-folder',
    });
    expect(getFlatScope.call(ctx)).toBe(ctx._videos);
  });

  it('scopes to descendants of a leaf-level folder', () => {
    const ctx = makeCtx({
      videos: fixtureVideos,
      sources: [SRC_A, SRC_B],
      currentFolderPath: '/lib/a/sub1/sub2',
    });
    const scoped = getFlatScope.call(ctx);
    const paths = scoped.map((v) => v.path).sort();
    expect(paths).toEqual([
      '/lib/a/sub1/sub2/sub3/v5.mp4',
      '/lib/a/sub1/sub2/v3.mp4',
      '/lib/a/sub1/sub2/v4.mp4',
    ]);
  });

  it('scopes to a mid-level folder including all nested descendants', () => {
    // The community member's exact described layout: drilled into sub1 from
    // source root, flat view should show sub1 + sub2 + sub3 videos but not
    // sibling-folder /other/ or the source's top-level top.mp4.
    const ctx = makeCtx({
      videos: fixtureVideos,
      sources: [SRC_A, SRC_B],
      currentFolderPath: '/lib/a/sub1',
    });
    const scoped = getFlatScope.call(ctx);
    const paths = scoped.map((v) => v.path).sort();
    expect(paths).toEqual([
      '/lib/a/sub1/sub2/sub3/v5.mp4',
      '/lib/a/sub1/sub2/v3.mp4',
      '/lib/a/sub1/sub2/v4.mp4',
      '/lib/a/sub1/v1.mp4',
      '/lib/a/sub1/v2.mp4',
    ]);
  });

  it('does NOT scope when the selected path is a source root', () => {
    // Source-root flat view IS the source, and the source-picker already
    // governs that. Scoping at source-root would mask the global toggle's
    // behaviour and surprise users coming from collections.
    const ctx = makeCtx({
      videos: fixtureVideos,
      sources: [SRC_A, SRC_B],
      currentFolderPath: '/lib/a',
    });
    expect(getFlatScope.call(ctx)).toBe(ctx._videos);
  });

  it('returns an empty array for a folder that exists but has no descendants', () => {
    // A folder with `isSourceRoot=false` and no videos / no children — should
    // honestly render zero, not silently fall through to the full library.
    // (Build a custom index manually because the fixture doesn't produce
    // descendant-less non-root folders.)
    const ctx = makeCtx({ videos: fixtureVideos, sources: [SRC_A] });
    ctx._folderIndex.set('/lib/a/empty-leaf', {
      path: '/lib/a/empty-leaf',
      label: 'empty-leaf',
      parent: '/lib/a',
      childFolders: new Set(),
      videos: [],
      isSourceRoot: false,
      sourceId: null,
    });
    ctx._currentFolderPath = '/lib/a/empty-leaf';
    expect(getFlatScope.call(ctx)).toEqual([]);
  });

  it('keeps videos at the exact selected level, not just deeper ones', () => {
    // Bug-class guard: a naive "include only sub-folder paths" filter would
    // miss videos sitting directly inside the selected folder.
    const ctx = makeCtx({
      videos: fixtureVideos,
      sources: [SRC_A, SRC_B],
      currentFolderPath: '/lib/a/sub1/sub2',
    });
    const scoped = getFlatScope.call(ctx);
    expect(scoped.some((v) => v.path === '/lib/a/sub1/sub2/v3.mp4')).toBe(true);
    expect(scoped.some((v) => v.path === '/lib/a/sub1/sub2/v4.mp4')).toBe(true);
  });

  it('does not leak videos from sibling folders', () => {
    const ctx = makeCtx({
      videos: fixtureVideos,
      sources: [SRC_A, SRC_B],
      currentFolderPath: '/lib/a/sub1',
    });
    const scoped = getFlatScope.call(ctx);
    expect(scoped.some((v) => v.path === '/lib/a/other/v6.mp4')).toBe(false);
    expect(scoped.some((v) => v.path === '/lib/a/top.mp4')).toBe(false);
  });

  it('does not leak videos from other sources', () => {
    const ctx = makeCtx({
      videos: fixtureVideos,
      sources: [SRC_A, SRC_B],
      currentFolderPath: '/lib/a/sub1/sub2',
    });
    const scoped = getFlatScope.call(ctx);
    expect(scoped.some((v) => v.path.startsWith('/lib/b/'))).toBe(false);
  });
});

describe('Library._clearFolderScope', () => {
  // Pure-ish behaviour — set the field, ignore DOM-side effects in the test.
  it('nulls _currentFolderPath', () => {
    const ctx = {
      _currentFolderPath: '/lib/a/sub1/sub2',
      _renderBreadcrumb: () => {},
      _applyFilters: () => {},
      _container: { querySelector: () => null },
    };
    Library.prototype._clearFolderScope.call(ctx);
    expect(ctx._currentFolderPath).toBeNull();
  });

  it('rerenders breadcrumb and filters', () => {
    let breadcrumbCalls = 0;
    let filtersCalls = 0;
    const ctx = {
      _currentFolderPath: '/lib/a/sub1',
      _renderBreadcrumb: () => { breadcrumbCalls++; },
      _applyFilters: () => { filtersCalls++; },
      _container: { querySelector: () => null },
    };
    Library.prototype._clearFolderScope.call(ctx);
    expect(breadcrumbCalls).toBe(1);
    expect(filtersCalls).toBe(1);
  });

  it('resets scrollTop on the grid wrapper when present', () => {
    const wrapper = { scrollTop: 500 };
    const ctx = {
      _currentFolderPath: '/lib/a/sub1',
      _renderBreadcrumb: () => {},
      _applyFilters: () => {},
      _container: {
        querySelector: (sel) => sel === '.library__grid-wrapper' ? wrapper : null,
      },
    };
    Library.prototype._clearFolderScope.call(ctx);
    expect(wrapper.scrollTop).toBe(0);
  });
});
