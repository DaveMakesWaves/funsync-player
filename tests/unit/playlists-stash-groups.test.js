/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its grid, the
 * "From Stash" section and a group's detail into a DOM (heatmap-strip.js
 * branches on `typeof window`; see notes/CLAUDE.md "Test environments").
 */
// Stash Groups as read-only playlists (Stash "next" lot #6; Dave 2026-11-19:
// "Kept in sync": read-only "Stash: <group>" playlists in Stash's order,
// updated on every sync, never touching the user's own playlists; Stash off
// or Remove Stash data hides them). Drives the REAL Playlists component and
// the REAL stash-store.js against a fake main and fake settings, and the
// REAL app.js wiring (lifted), asserting what is on screen, what app.js is
// handed and what is (never) written.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

import { showToast } from '../../renderer/js/toast.js';
import { Playlists } from '../../renderer/components/playlists.js';
import { Modal } from '../../renderer/components/modal.js';
import {
  STASH_API, initStashStore, syncStash, _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { t, _setBundlesForTests } from '../../renderer/js/i18n.js';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';

// Until the merge step puts stage sn-groups' strings into the locales, their
// English text (SCRATCH/sn-groups/strings.json) stands in; en.json's win.
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
EN.playlists.stashGroups = {
  sectionTitle: 'From Stash',
  sectionHint: 'Groups from your Stash, kept in sync each time FunSync syncs with Stash. To change one, change it in Stash.',
  name: 'Stash: {name}',
  unnamed: 'Unnamed group',
  readOnly: 'Read-only',
  readOnlyReason: 'Kept in sync with this group in your Stash. FunSync cannot change its videos or their order: change the group in Stash, then sync.',
  missingCount: '{count, plural, one {# scene not in your library} other {# scenes not in your library}}',
  missingScene: 'Not in your FunSync library',
  missingSceneTooltip: 'This Stash scene has no linked video in your FunSync library, so it is skipped when the group plays.',
  untitledScene: 'Untitled Stash scene',
  playOptionsNote: 'These options are shared with the Library and categories.',
  addToQueue: 'Add to queue',
  addToQueueTitle: "Add this group's videos to the end of your queue",
  addedToQueue: '{count, plural, one {Added # video to your queue} other {Added # videos to your queue}}',
  copy: 'Copy to my playlists',
  copyTitle: 'Make your own playlist with these videos.',
  copied: 'Added "{name}" to your playlists',
  copyFailed: 'Could not make the playlist. Please try again.',
  ...(EN.playlists.stashGroups || {}),
};
_setBundlesForTests('en', EN, EN);

const SERVER = 'http://127.0.0.1:9999';
// The local test Stash's grouped scenes (tests/fixtures/stash/sn-scenes,
// sn-groups): A = 2, 3, 1 by scene_index; B = 4, 1; scene 1 in both.
const S1 = 'C:\\Lib\\Synthetic Clip Small.mp4';
const S2 = 'C:\\Lib\\synthetic_large.mkv';
const S3 = 'C:\\Lib\\synthetic_mid.mp4';
const S4 = 'C:\\Lib\\synthetic_tiny.mp4';
const SCENES = {
  1: ['Synthetic Scene Small', S1, [['1', 3], ['2', 2]]],
  2: ['', S2, [['1', 1]]],
  3: ['Synthetic Scene Mid', S3, [['1', 2]]],
  4: ['', S4, [['2', 1]]],
};
const GROUPS = {
  1: { name: 'Synthetic Series A', sceneIds: ['1', '2', '3'], updatedAt: '2026-11-19T09:24:26Z' },
  2: { name: 'Synthetic Series B', sceneIds: ['1', '4'], updatedAt: '2026-11-19T09:24:26Z' },
};

function projection(rev, { groups = GROUPS, unlinked = [], index = {} } = {}) {
  const scenes = {};
  const links = {};
  for (const [id, [title, path, memberOf]] of Object.entries(SCENES)) {
    scenes[id] = {
      id, title, tagIds: [], performerIds: [], markers: [], files: [],
      groups: memberOf.map(([groupId, sceneIndex]) => ({ groupId, sceneIndex: index[`${groupId}/${id}`] ?? sceneIndex })),
    };
    if (!unlinked.includes(id)) {
      links[path] = { sceneId: id, server: SERVER, by: 'oshash', state: 'ok', fp: { size: 1000, oshash: 'x' }, linkedAt: 1 };
    }
  }
  return {
    v: 1, rev, server: { url: SERVER, version: 'v0.32.0' }, lastSync: { at: rev, kind: 'full', ok: true },
    links, check: {}, refused: {}, scenes, performers: {}, studios: {}, tags: {}, groups,
  };
}

let main;
function fakeMain(data) {
  main = { data, changed: null };
  const api = {};
  for (const name of Object.values(STASH_API)) api[name] = vi.fn(async () => ({ ok: true }));
  api[STASH_API.data] = vi.fn(async () => main.data);
  api[STASH_API.onChanged] = vi.fn((cb) => { main.changed = cb; return () => { main.changed = null; }; });
  api[STASH_API.sync] = vi.fn(async () => ({ ok: true, data: main.data }));
  _setStashApiForTests(api);
}

function fakeSettings({ playlists = [], stashOn = true } = {}) {
  const s = {
    store: { 'stash.enabled': stashOn, 'library.playOptions': { loop: true, balanceByScript: false, preferUnwatched: false } },
    playlists,
    get: (k) => s.store[k],
    set: vi.fn((k, v) => { s.store[k] = v; }),
    getPlaylists: () => s.playlists,
    getPlaylist: (id) => s.playlists.find((p) => p.id === id) || null,
    addPlaylist: vi.fn(async (name) => {
      const created = { id: 'new-1', name, createdAt: 1, videoPaths: [] };
      s.playlists.push(created);
      return created;
    }),
    addVideosToPlaylist: vi.fn((id, paths) => { s.playlists.find((p) => p.id === id).videoPaths.push(...paths); }),
    renamePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    removeVideoFromPlaylist: vi.fn(),
    removeVideosFromPlaylist: vi.fn(),
    setPlaylistVideoPaths: vi.fn(),
    setPlaylistLoop: vi.fn(),
    setPlaylistShuffle: vi.fn(),
  };
  return s;
}

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let pl;
let settings;
let container;
let calls;
let offline;

async function mount({ playlists = [], stashOn = true, viewMode = 'grid', data = projection(1) } = {}) {
  offline = new Set();
  window.funsync = {
    filesExist: vi.fn(async (list) => list.map((p) => !offline.has(p))),
    readFunscript: vi.fn(async () => null),
    generateSingleThumbnail: vi.fn(async () => null),
  };
  fakeMain(data);
  settings = fakeSettings({ playlists, stashOn });
  await initStashStore({ isEnabled: () => settings.get('stash.enabled') === true });
  calls = { playAll: vi.fn(), playVideo: vi.fn(), queue: vi.fn((paths) => paths.length) };
  pl = new Playlists({
    settings, library: null,
    onPlayVideo: calls.playVideo, onPlayAll: calls.playAll, onAddPathsToQueue: calls.queue,
  });
  pl._viewMode = viewMode;
  container = document.createElement('div');
  document.body.appendChild(container);
  pl.show(container);
  await flush();
}

async function openGroup(groupId) {
  container.querySelector(`[data-playlist-id="stash-group:${groupId}"]`).click();
  await flush();
}

const section = () => container.querySelector('.playlists__stash-section');
const stashCards = () => [...container.querySelectorAll('.playlists__stash-section [data-playlist-id]')];
const cardNames = () => stashCards().map((c) => (c.querySelector('.playlists__card-name, .playlists__list-name')).textContent);
const shown = (name) => t('playlists.stashGroups.name', { name });
const detailPaths = () => [...container.querySelectorAll('.playlists__grid [data-video-path]')].map((el) => el.dataset.videoPath);
const button = (cls) => container.querySelector(`.playlists__header .${cls}`);
const byPath = (p) => [...container.querySelectorAll('[data-video-path]')].find((el) => el.dataset.videoPath === p);

beforeEach(() => {
  _resetStashStoreForTests();
  vi.mocked(showToast).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  pl?.hide();
  container?.remove();
  delete window.funsync;
  _resetStashStoreForTests();
  vi.restoreAllMocks();
});

describe('the Playlists view: a "From Stash" section of read-only group playlists', () => {
  it('lists each group as "Stash: <group>" under the user\'s own playlists, with no Rename or Delete', async () => {
    const mine = { id: 'p1', name: 'Mine', createdAt: 1, videoPaths: [S1] };
    await mount({ playlists: [mine], data: projection(1, { unlinked: ['4'] }) });
    // The user's playlist is as it always was.
    const own = container.querySelector('.playlists__card:not(.playlists__card--stash):not(.playlists__card--create)');
    expect(own.querySelector('.playlists__card-name').textContent).toBe('Mine');
    // Set a cover (2026-11-23), Rename, Delete.
    expect(own.querySelectorAll('.playlists__card-action-btn')).toHaveLength(3);
    expect(own.querySelector('.playlists__cover-set')).not.toBeNull();
    // Its own labelled section, after the user's grid.
    expect(section().querySelector('h2').textContent).toBe(t('playlists.stashGroups.sectionTitle'));
    expect(section().getAttribute('aria-labelledby')).toBe(section().querySelector('h2').id);
    expect(cardNames()).toEqual([shown('Synthetic Series A'), shown('Synthetic Series B')]);
    const [a, b] = stashCards();
    expect(a.querySelector('.playlists__card-count').textContent).toBe(t('playlists.videoCount', { count: 3 }));
    expect(b.querySelector('.playlists__card-count').textContent)
      .toBe(`${t('playlists.videoCount', { count: 1 })} · ${t('playlists.stashGroups.missingCount', { count: 1 })}`);
    // Read-only: no Rename / Delete; the mark says why.
    for (const card of stashCards()) {
      expect(card.querySelector('.playlists__card-action-btn')).toBeNull();
      expect(card.querySelector('.playlists__stash-badge').title).toBe(t('playlists.stashGroups.readOnlyReason'));
    }
    // Derived, never written: the user's playlists and settings are untouched.
    expect(settings.getPlaylists()).toEqual([mine]);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('with no playlists of the user\'s own, the empty state stays and the groups show under it', async () => {
    await mount();
    expect(container.querySelector('.playlists__empty-cta')).not.toBeNull();
    expect(cardNames()).toEqual([shown('Synthetic Series A'), shown('Synthetic Series B')]);
  });

  it('Stash off: no section; on again: it shows at once (nothing deleted, nothing asked of Stash)', async () => {
    await mount({ stashOn: false });
    expect(section()).toBeNull();
    settings.store['stash.enabled'] = true;
    eventBus.emit('settings:changed', { path: 'stash.enabled', value: true });
    await flush();
    expect(cardNames()).toHaveLength(2);
    settings.store['stash.enabled'] = false;
    eventBus.emit('settings:changed', { path: 'stash.enabled', value: false });
    await flush();
    expect(section()).toBeNull();
    expect(settings.getPlaylists()).toEqual([]);
  });

  it('list view: one row per group, no Rename or Delete either', async () => {
    await mount({ viewMode: 'list' });
    expect(cardNames()).toEqual([shown('Synthetic Series A'), shown('Synthetic Series B')]);
    for (const row of stashCards()) {
      expect(row.classList.contains('playlists__list-item--stash')).toBe(true);
      expect(row.querySelector('.playlists__card-action-btn')).toBeNull();
    }
  });
});

describe('a group\'s detail', () => {
  it('its linked videos in Stash\'s order; a scene with no linked video is shown as missing, never invented', async () => {
    await mount({ data: projection(1, { unlinked: ['4'] }) });
    await openGroup('1');
    expect(container.querySelector('.playlists__title').textContent).toBe(shown('Synthetic Series A'));
    expect(detailPaths()).toEqual([S2, S3, S1]);
    pl.navigateBack();
    await openGroup('2');
    const items = [...container.querySelectorAll('.playlists__grid > *')];
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains('playlists__stash-missing')).toBe(true);
    expect(items[0].dataset.videoPath).toBeUndefined();
    expect(items[0].querySelector('.playlists__video-title').textContent).toBe(t('playlists.stashGroups.untitledScene'));
    expect(items[0].title).toBe(t('playlists.stashGroups.missingSceneTooltip'));
    expect(items[1].dataset.videoPath).toBe(S1);
    // The missing scene plays nothing.
    items[0].click();
    await flush();
    expect(calls.playVideo).not.toHaveBeenCalled();
  });

  it('read-only: no Remove, Move, handle, Select or Sort; Ctrl+click plays; the note says why', async () => {
    await mount();
    await openGroup('1');
    for (const cls of ['playlists__remove-one', 'playlists__select-btn', 'playlists__sort-btn', 'playlists__select-check', 'playlists__loop-btn:not(.playlists__stash-shuffle-btn):not(.playlists__advanced-btn):not(.playlists__stash-queue-btn):not(.playlists__stash-copy-btn)']) {
      expect(container.querySelector(`.${cls}`)).toBeNull();
    }
    expect(container.querySelector('.playlists__stash-note').textContent).toBe(t('playlists.stashGroups.readOnlyReason'));
    const card = byPath(S3);
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await flush();
    expect(pl._selectMode).toBe(false);
    expect(calls.playVideo).toHaveBeenCalledTimes(1);
    // List view: no handle, no Move buttons, not draggable.
    pl._setViewMode('list');
    await flush();
    const rows = [...container.querySelectorAll('.playlists__grid [data-video-path]')];
    expect(rows.map((r) => r.dataset.videoPath)).toEqual([S2, S3, S1]);
    for (const row of rows) {
      expect(row.draggable).toBe(false);
      expect(row.querySelector('.playlists__drag-handle, .playlists__move-btn, .playlists__remove-one, .playlists__select-check')).toBeNull();
    }
    expect(settings.removeVideoFromPlaylist).not.toHaveBeenCalled();
    expect(settings.setPlaylistVideoPaths).not.toHaveBeenCalled();
  });

  it('Play All and Shuffle all hand app.js the linked videos in Stash\'s order, with the Library\'s play options', async () => {
    await mount({ data: projection(1, { unlinked: ['4'] }) });
    await openGroup('1');
    button('playlists__play-all-btn').click();
    await flush();
    const [list, opts] = calls.playAll.mock.calls[0];
    expect(list.map((v) => v.path)).toEqual([S2, S3, S1]);
    expect(opts).toMatchObject({
      sourceLabel: shown('Synthetic Series A'),
      sourceContext: { kind: 'playlist', id: 'stash-group:1' },
      shuffle: false, loop: true, balanceByScript: false, preferUnwatched: false,
    });
    button('playlists__stash-shuffle-btn').click();
    await flush();
    expect(calls.playAll.mock.calls[1][1].shuffle).toBe(true);
    expect(calls.playAll.mock.calls[1][0].map((v) => v.path)).toEqual([S2, S3, S1]);
  });

  it('a card plays in the group\'s order as a playlist (prev / next, Back to the group)', async () => {
    await mount();
    await openGroup('1');
    byPath(S3).click();
    await flush();
    const [fileData] = calls.playVideo.mock.calls[0];
    expect(fileData.path).toBe(S3);
    expect(fileData._playContext).toMatchObject({
      source: 'playlist',
      sourceContext: { playlistId: 'stash-group:1' },
      list: [S2, S3, S1],
      index: 1,
      loop: true,
    });
    expect(fileData._shuffle).toBeUndefined();
  });

  it('Add to queue: the reachable videos, in Stash\'s order, in one call', async () => {
    await mount();
    await openGroup('1');
    offline.add(S3);
    button('playlists__stash-queue-btn').click();
    await flush();
    expect(calls.queue).toHaveBeenCalledTimes(1);
    expect(calls.queue).toHaveBeenCalledWith([S2, S1]);
    expect(vi.mocked(showToast).mock.calls.map((c) => c[0]))
      .toContain(t('playlists.stashGroups.addedToQueue', { count: 2 }));
  });

  it('Copy to my playlists: an ordinary playlist of the user\'s own, with the videos in Stash\'s order', async () => {
    await mount();
    await openGroup('1');
    const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('Series A, mine');
    button('playlists__stash-copy-btn').click();
    await flush();
    expect(prompt.mock.calls[0][2]).toBe('Synthetic Series A');
    expect(settings.addPlaylist).toHaveBeenCalledWith('Series A, mine');
    expect(settings.addVideosToPlaylist).toHaveBeenCalledWith('new-1', [S2, S3, S1]);
    expect(vi.mocked(showToast).mock.calls.map((c) => c[0]))
      .toContain(t('playlists.stashGroups.copied', { name: 'Series A, mine' }));
    // The group itself is untouched and still read-only.
    pl.navigateBack();
    await flush();
    expect(cardNames()).toEqual([shown('Synthetic Series A'), shown('Synthetic Series B')]);
    expect(settings.renamePlaylist).not.toHaveBeenCalled();
    expect(settings.deletePlaylist).not.toHaveBeenCalled();
  });

  it('Copy cancelled: nothing is made', async () => {
    await mount();
    await openGroup('1');
    vi.spyOn(Modal, 'prompt').mockResolvedValue(null);
    button('playlists__stash-copy-btn').click();
    await flush();
    expect(settings.addPlaylist).not.toHaveBeenCalled();
  });
});

describe('kept in sync with the Stash data', () => {
  it('main\'s change report after a sync redraws the grid: a renamed group, a group gone', async () => {
    await mount();
    main.data = projection(2, { groups: { 1: { ...GROUPS[1], name: 'Series A (new cut)' } } });
    main.changed({ rev: 2 });
    await flush();
    expect(cardNames()).toEqual([shown('Series A (new cut)')]);
  });

  it('a Sync now reply redraws the open group in Stash\'s new order', async () => {
    await mount();
    await openGroup('1');
    expect(detailPaths()).toEqual([S2, S3, S1]);
    main.data = projection(3, { index: { '1/1': 1, '1/2': 2, '1/3': 3 } });
    await syncStash({ videos: [] });
    await flush();
    expect(detailPaths()).toEqual([S1, S2, S3]);
  });

  it('Remove Stash data: the open group goes back to the grid, the user\'s playlists untouched', async () => {
    const mine = { id: 'p1', name: 'Mine', createdAt: 1, videoPaths: [S1] };
    await mount({ playlists: [mine] });
    await openGroup('1');
    main.data = { ...projection(4), links: {}, scenes: {}, groups: {} };
    main.changed({ rev: 4 });
    await flush();
    expect(pl._view).toBe('grid');
    expect(section()).toBeNull();
    expect(settings.getPlaylists()).toEqual([mine]);
  });

  it('a change that alters nothing on screen does not redraw', async () => {
    await mount();
    const render = vi.spyOn(pl, '_renderGrid');
    main.data = { ...projection(5), lastSync: { at: 99, kind: 'full', ok: true } };
    main.changed({ rev: 5 });
    await flush();
    expect(render).not.toHaveBeenCalled();
  });

  it('a user playlist\'s open detail is left alone (its Select mode stays)', async () => {
    const mine = { id: 'p1', name: 'Mine', createdAt: 1, videoPaths: [S1] };
    await mount({ playlists: [mine] });
    pl._view = 'detail';
    pl._detailPlaylistId = 'p1';
    await pl._renderDetail('p1');
    pl._enterSelectMode();
    main.data = projection(6, { groups: {} });
    main.changed({ rev: 6 });
    await flush();
    expect(pl._detailPlaylistId).toBe('p1');
    expect(pl._selectMode).toBe(true);
  });
});

describe('app.js wiring', () => {
  it('new Playlists({...}) gets onAddPathsToQueue: the app\'s addPathsToUserQueue', () => {
    const app = { addPathsToUserQueue: vi.fn(() => 2) };
    const options = liftCtorOptions('Playlists').call(app);
    expect(options.onAddPathsToQueue(['a', 'b'])).toBe(2);
    expect(app.addPathsToUserQueue).toHaveBeenCalledWith(['a', 'b']);
  });

  it('addPathsToUserQueue: in order, a queued one skipped, ONE write, the count back', () => {
    const Lifted = liftAppClass(['addPathsToUserQueue'], {});
    const app = new Lifted();
    app._userQueue = ['b'];
    app._persistUserQueue = vi.fn();
    app._updateQueuePanelState = vi.fn();
    expect(app.addPathsToUserQueue(['a', 'b', 'c', '', null])).toBe(2);
    expect(app._userQueue).toEqual(['b', 'a', 'c']);
    expect(app._persistUserQueue).toHaveBeenCalledTimes(1);
    expect(app.addPathsToUserQueue(['a'])).toBe(0);
    expect(app._persistUserQueue).toHaveBeenCalledTimes(1);
  });

  it('playing from a Stash group writes no last-watched marker into config.json (a user playlist still does)', () => {
    const Lifted = liftAppClass(['_markPlaylistLastWatched', '_playlistIdOf'], {});
    const app = new Lifted();
    const store = {};
    app.settings = { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
    app._currentPlayContext = { source: 'playlist', sourceContext: { playlistId: 'stash-group:1' } };
    app._markPlaylistLastWatched(S1, 10);
    app._currentPlayContext = { source: 'queue', sourceContext: { kind: 'playlist', id: 'stash-group:1' } };
    app._markPlaylistLastWatched(S1, 11);
    expect(app.settings.set).not.toHaveBeenCalled();
    app._currentPlayContext = { source: 'playlist', sourceContext: { playlistId: 'p1' } };
    app._markPlaylistLastWatched(S1, 12);
    expect(store['library.playlistProgress']).toEqual({ p1: { lastVideoPath: S1, updatedAt: 12 } });
  });

  it('Back to the group (Up Next) opens the group\'s detail, as for any playlist', async () => {
    await mount();
    const Lifted = liftAppClass(['_upNextBackToSource'], {});
    const app = new Lifted();
    app.playlists = pl;
    app.categories = null;
    app._currentView = () => 'playlists';
    app._navigateTo = vi.fn();
    app._upNextBackToSource({ kind: 'playlist', id: 'stash-group:1' });
    await flush();
    expect(pl._view).toBe('detail');
    expect(container.querySelector('.playlists__title').textContent).toBe(shown('Synthetic Series A'));
    expect(detailPaths()).toEqual([S2, S3, S1]);
  });

  it('Up Next names a group\'s playlist "Stash: <group>"', async () => {
    await mount();
    const Lifted = liftAppClass(['_upNextListName'], { t });
    const app = new Lifted();
    app.settings = settings;
    app.playlists = pl;
    expect(app._upNextListName({ source: 'playlist', sourceContext: { playlistId: 'stash-group:2' } }))
      .toBe(shown('Synthetic Series B'));
    expect(app._upNextListName({ source: 'queue', sourceContext: { kind: 'playlist', id: 'stash-group:1' } }))
      .toBe(shown('Synthetic Series A'));
  });
});
