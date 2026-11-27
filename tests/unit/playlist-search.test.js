/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its grid header and
 * cards into a DOM, and the test types into its search box (notes/CLAUDE.md
 * "Test environments").
 */
// Playlist search (Dave 2026-08-06: "Search the playlist grid by name. No
// filtering or sorting"). Asserted: what it matches, that the desktop finds
// the same playlists in the same order as the phone (the search parity rule:
// same algorithm AND same call), what the grid shows while searching (no
// "New Playlist" card, a line when nothing matches, Stash groups searched
// too), that Escape empties the box before it reaches the app, that a
// re-render while typing keeps the focus, and that leaving the view clears it.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';

const { Playlists, filterPlaylistsByName } = await import('../../renderer/components/playlists.js');
const { fuzzySearch: phoneFuzzySearch } = await import('../../backend/web-remote/library-search.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const LISTS = [
  { id: 'a', name: 'Gym Mix', videoPaths: [] },
  { id: 'b', name: 'Two-Girl Scenes', videoPaths: [] },
  { id: 'c', name: 'Late night', videoPaths: [] },
  { id: 'd', name: 'Gymnastics', videoPaths: [] },
];

let container;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  window.funsync = { filesExist: vi.fn(async (l) => l.map(() => true)), fileExists: vi.fn(async () => true) };
});
afterEach(() => {
  container?.remove();
  delete window.funsync;
  vi.restoreAllMocks();
});

function grid(lists = LISTS, { stashGroups = [] } = {}) {
  const store = {};
  const pl = new Playlists({
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getPlaylists: () => lists, getPlaylist: () => null },
    onPlayVideo: vi.fn(),
    library: null,
  });
  pl._stashGroupPlaylists = () => stashGroups;
  container = document.createElement('div');
  document.body.appendChild(container);
  pl._container = container;
  pl._view = 'grid';
  pl._renderGrid();
  return pl;
}
const names = () => [...container.querySelectorAll('.playlists__grid:not(.playlists__grid--stash) .playlists__card:not(.playlists__card--create)')]
  .map((c) => c.querySelector('.playlists__card-name, .playlists__card-title, [class*="name"]')?.textContent.trim());
const search = () => container.querySelector('.playlists__search');
const type = (text) => { const s = search(); s.value = text; s.dispatchEvent(new Event('input', { bubbles: true })); };

describe('filterPlaylistsByName', () => {
  it('an empty search keeps every playlist in its own order; a search keeps the matches, best first', () => {
    expect(filterPlaylistsByName(LISTS, '')).toEqual(LISTS);
    expect(filterPlaylistsByName(LISTS, '   ')).toEqual(LISTS);
    expect(filterPlaylistsByName(LISTS, 'gym').map((p) => p.id)).toEqual(['a', 'd']);
    expect(filterPlaylistsByName(LISTS, 'two girl').map((p) => p.id)).toEqual(['b']);   // separators flattened
    expect(filterPlaylistsByName(LISTS, 'zzz')).toEqual([]);
  });

  it('finds the same playlists in the same order as the phone, with the phone\'s own search code', () => {
    // backend/web-remote/app.js renderGroupingsList, verbatim in shape.
    const phone = (items, q) => phoneFuzzySearch(items.map((g) => ({ name: g.name || '', path: g.name || '', _orig: g })), q).map((w) => w._orig);
    for (const q of ['gym', 'two girl', 'night', 'g', 'mix gym', 'zzz']) {
      expect(filterPlaylistsByName(LISTS, q), q).toEqual(phone(LISTS, q));
    }
    // And the phone still makes that call: if it changes, this side must follow.
    const src = fs.readFileSync('backend/web-remote/app.js', 'utf8');
    expect(src).toContain("items.map(g => ({ name: g.name || '', path: g.name || '', _orig: g }))");
  });
});

describe('the playlist grid', () => {
  it('has a search box; typing filters the cards and hides "New Playlist"; clearing brings both back', () => {
    grid();
    expect(search().placeholder).toBe(EN.playlists.searchPlaceholder);
    expect(search().getAttribute('aria-label')).toBe(EN.playlists.searchPlaceholder);
    expect(names()).toEqual(['Gym Mix', 'Two-Girl Scenes', 'Late night', 'Gymnastics']);
    expect(container.querySelector('.playlists__card--create')).toBeTruthy();
    type('gym');
    expect(names()).toEqual(['Gym Mix', 'Gymnastics']);
    expect(container.querySelector('.playlists__card--create')).toBeNull();
    type('');
    expect(names()).toHaveLength(4);
    expect(container.querySelector('.playlists__card--create')).toBeTruthy();
  });

  it('nothing matches: one line says so, naming the search', () => {
    grid();
    type('zzz');
    const none = container.querySelector('.playlists__search-empty');
    expect(none.textContent).toBe('No playlists match “zzz”');
    expect(none.getAttribute('role')).toBe('status');
    expect(container.querySelector('.playlists__grid')).toBeNull();
  });

  it('Stash groups are searched too; a search that only finds a group shows just that section', () => {
    grid(LISTS, { stashGroups: [{ id: 'stash-group:1', name: 'Studio Night Set', videoPaths: [], entries: [] }] });
    type('studio');
    expect(container.querySelector('.playlists__stash-section')).toBeTruthy();
    expect(container.querySelector('.playlists__grid:not(.playlists__grid--stash)')).toBeNull();
    type('gym');
    expect(container.querySelector('.playlists__stash-section')).toBeNull();
    expect(names()).toEqual(['Gym Mix', 'Gymnastics']);
  });

  it('Escape empties a box with text in it and goes no further; on an empty box it goes on to the app', () => {
    grid();
    const appEsc = vi.fn();
    document.addEventListener('keydown', appEsc);
    type('gym');
    const e1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    search().dispatchEvent(e1);
    expect(search().value).toBe('');
    expect(names()).toHaveLength(4);
    expect(e1.defaultPrevented).toBe(true);
    expect(appEsc).not.toHaveBeenCalled();
    search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(appEsc).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', appEsc);
  });

  it('a re-render while typing (the availability probe, a Stash change) keeps the text, the focus and the caret', () => {
    const pl = grid();
    search().focus();
    type('gym mix');
    search().setSelectionRange(3, 3);
    pl._renderGrid();
    expect(search().value).toBe('gym mix');
    expect(document.activeElement).toBe(search());
    expect(search().selectionStart).toBe(3);
    expect(names()).toEqual(['Gym Mix']);
  });

  it('kept while going into a playlist and back; cleared when the Playlists view is left', () => {
    const pl = grid();
    type('gym');
    pl._renderGrid();                              // back from a playlist's detail
    expect(search().value).toBe('gym');
    pl.hide();
    pl._container = container;
    pl._renderGrid();
    expect(search().value).toBe('');
    expect(names()).toHaveLength(4);
  });

  it('no playlists and no Stash groups: no search box (nothing to search)', () => {
    grid([]);
    expect(search()).toBeNull();
    expect(container.querySelector('.playlists__empty')).toBeTruthy();
  });
});

