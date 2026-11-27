/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library builds its cards, chips and menus into a
 * DOM, and no-video-tile.js builds DOM (notes/CLAUDE.md "Test environments").
 */
// Dave, 2026-11-26: "for the scripts without a video, so that there is a view
// for it, under filters we have matched, unmatched so lets have one called
// scripts which is just scripts so somone can still make playlists etc with
// them". Then, asked when: "All of it for Friday".
//
//   - Filters > Scripts lists the scripts no video uses as cards (the
//     no-picture tile marked "Script"); a click plays one in the script player.
//   - ⋮ / right-click: Play, Add to playlist, Pair with a video, Show in
//     folder, Delete. Select mode offers only Add to playlist.
//   - A playlist (or Play all) plays a script entry in the script player:
//     the player closes, and when the script ends the list goes on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { Library } from '../../renderer/components/library.js';
import { buildNoVideoTile, isScriptPath, scriptItem } from '../../renderer/js/no-video-tile.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const V = (name, extra = {}) => ({ name: `${name}.mp4`, path: `C:\\Lib\\${name}.mp4`, hasFunscript: true, funscriptPath: `C:\\Lib\\${name}.funscript`, variants: [], ...extra });
const SOLO = { name: 'Solo Loop.funscript', path: 'C:\\Lib\\Scripts\\Solo Loop.funscript' };
const ALSO = { name: 'Another One.funscript', path: 'C:\\Lib\\Scripts\\Another One.funscript' };
const USED = { name: 'Alt.funscript', path: 'C:\\Lib\\Alt.funscript' };            // a video's variant
const AXIS = { name: 'Solo Loop.twist.funscript', path: 'C:\\Lib\\Scripts\\Solo Loop.twist.funscript' };

let lib;
let played;
let store;

function mount() {
  lib._container.innerHTML = `
    <span class="library__video-count"></span>
    <button class="library__select-mode-btn"></button>
    <div class="library__selection-bar" hidden>
      <span class="library__selection-count"></span>
      <button class="library__selection-action" data-action="playlist"></button>
      <button class="library__selection-action" data-action="category"></button>
      <button class="library__selection-action" data-action="collection"></button>
      <button class="library__selection-action" data-action="script"></button>
      <button class="library__selection-action" data-action="vrtype"></button>
    </div>
    <div id="library-chips"></div>
    <div class="library__grid-wrapper"><div class="library__grid"></div></div>`;
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 1; });
  played = [];
  store = { 'library.viewMode': 'grid', 'library.showCardHeatmap': false, 'library.sources': [{ path: 'C:\\Lib' }] };
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getVideoCategories: () => [], getCategories: () => [], getPlaylists: () => [] };
  lib = new Library({ settings, onPlayVideo: (...args) => played.push(args), onPairScript: vi.fn() });
  lib._container = document.createElement('div');
  document.body.appendChild(lib._container);
  const videos = [V('Alpha', { variants: [{ path: USED.path }] }), V('Bravo')];
  lib._videos = videos;
  lib._videosByPath = new Map(videos.map((v) => [v.path, v]));
  lib._unmatchedFunscripts = [ALSO, SOLO, USED, AXIS];
  lib._queueThumbnail = () => {};
  lib._measureGridColumns = () => 4;
  mount();
  window.funsync = { showInFolder: vi.fn() };
});

afterEach(() => {
  lib._dismissQueueContextMenu?.();
  lib._container.remove();
  vi.unstubAllGlobals();
  delete window.funsync;
});

const scriptCards = () => [...lib._container.querySelectorAll('.library__card--script')];

describe('Filters > Scripts: the scripts no video uses, as cards', () => {
  it('the picker offers it after Unmatched, with its chip', () => {
    lib._container.innerHTML += '<button id="library-filters-btn"><span class="library__picker-icon"></span></button><div id="library-filters-pop"></div>';
    lib._buildFiltersPicker();
    const values = [...lib._container.querySelectorAll('#library-filters-pop input[name="library-filter-tab"]')].map((r) => r.value);
    expect(values).toEqual(['all', 'matched', 'unmatched', 'scripts']);
    lib._activeTab = 'scripts';
    lib._renderFilterChips();
    expect(lib._container.querySelector('#library-chips').textContent).toContain(EN.library.filterScripts);
  });

  it('lists the loose ones only (no variant in use, no axis file), by name, with the count in scripts', () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    expect(scriptCards().map((c) => c.querySelector('.library__card-title').textContent)).toEqual(['Another One', 'Solo Loop']);
    expect(lib._container.querySelector('.library__video-count').textContent).toBe('2 scripts');
    expect(lib._container.querySelectorAll('.library__card:not(.library__card--script)')).toHaveLength(0);
    const tile = scriptCards()[0].querySelector('.library__thumb-novideo--script');
    expect(tile.getAttribute('aria-label')).toBe(EN.library.scripts.tileLabel);
    expect(tile.querySelector('.library__thumb-novideo-mark').textContent).toBe(EN.library.scripts.mark);
    expect(scriptCards()[0].dataset.loaded).toBe('true');                // no picture to fetch
  });

  it('the search finds them by name', () => {
    lib._activeTab = 'scripts';
    lib._searchQuery = 'solo';
    lib._applyFilters();
    expect(scriptCards().map((c) => c.dataset.videoPath)).toEqual([SOLO.path]);
    expect(lib._container.querySelector('.library__video-count').textContent).toBe('1 script of 2');
  });

  it('none: says why, not "no results"', () => {
    lib._unmatchedFunscripts = [USED];
    lib._activeTab = 'scripts';
    lib._applyFilters();
    expect(lib._container.querySelector('.library__empty-text').textContent).toBe(EN.library.scripts.emptyTitle);
    expect(lib._container.querySelector('.library__empty-hint').textContent).toBe(EN.library.scripts.emptyHint);
  });

  it('a click plays it through the app (its path a .funscript, no video data read), in this list\'s order', () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    scriptCards()[1].click();
    expect(played).toHaveLength(1);
    const [fileData, funscript, subtitle, variants] = played[0];
    expect(fileData).toMatchObject({ path: SOLO.path, name: 'Solo Loop' });
    expect(fileData._playContext).toMatchObject({ source: 'library', list: [ALSO.path, SOLO.path], index: 1 });
    expect([funscript, subtitle, variants]).toEqual([null, null, []]);
  });

  it('getVideoByPath finds a loose script too (playlists, Next, Up Next); never for a video path', () => {
    expect(lib.getVideoByPath(SOLO.path)).toMatchObject({ _script: true, name: 'Solo Loop', funscriptPath: SOLO.path });
    expect(lib.getVideoByPath(USED.path)).toBeUndefined();               // a video uses it
    expect(lib.getVideoByPath('C:\\Lib\\Bravo.mp4')._script).toBeUndefined();
    expect(lib.getVideoByPath('C:\\Lib\\Nope.funscript')).toBeUndefined();
  });

  it('Up Next and the queue get its tile, never a frame grab', async () => {
    await expect(lib._captureVideoFrame(SOLO.path)).resolves.toEqual({ noVideo: true, script: true });
  });

  it('⋮ and right-click open its own menu: Play, Add to playlist, Pair with a video, Show in folder, Delete', () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    const card = scriptCards()[1];
    card.querySelector('.library__kebab-btn').click();
    const items = () => [...document.querySelectorAll('.library__queue-context-menu [role="menuitem"]')].map((b) => b.textContent);
    expect(items()).toEqual([EN.library.scripts.play, EN.library.addToPlaylist, EN.library.scripts.pair, EN.library.scripts.showInFolder, EN.library.scripts.delete]);
    document.querySelector('.library__queue-context-menu [data-pos="folder"]').click();
    expect(window.funsync.showInFolder).toHaveBeenCalledWith(SOLO.path);
    // Right-click: the same menu, not a video's quick menu.
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperty(ev, 'target', { value: card.querySelector('.library__card-title') });
    lib._handleCardContextMenu(ev);
    expect(items()).toHaveLength(5);
    document.querySelector('.library__queue-context-menu [data-pos="pair"]').click();
    expect(lib._onPairScript).toHaveBeenCalledWith(expect.objectContaining({ path: SOLO.path }));
  });

  it('select mode: a click selects, and only Add to playlist is offered; leaving Scripts ends the selection', () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    lib._enterSelectMode();
    const shown = () => [...lib._container.querySelectorAll('.library__selection-action')].filter((b) => !b.hidden).map((b) => b.dataset.action);
    expect(shown()).toEqual(['playlist']);
    scriptCards()[0].click();
    expect([...lib._selectedPaths]).toEqual([ALSO.path]);
    expect(played).toHaveLength(0);
    lib._switchTab('all');
    expect(lib._selectMode).toBe(false);
    lib._enterSelectMode();
    expect(shown()).toEqual(['playlist', 'category', 'collection', 'script', 'vrtype']);
  });

  it('list view: a row with the compact tile, its name and ⋮', () => {
    lib._viewMode = 'list';
    lib._activeTab = 'scripts';
    lib._applyFilters();
    const rows = [...lib._container.querySelectorAll('.library__list-item--script')];
    expect(rows.map((r) => r.querySelector('.library__list-title').textContent)).toEqual(['Another One', 'Solo Loop']);
    expect(rows[0].querySelector('.library__thumb-novideo--compact.library__thumb-novideo--script')).not.toBeNull();
    expect(rows[0].querySelector('.library__list-kebab')).not.toBeNull();
  });
});

describe('the shared pieces', () => {
  it('isScriptPath / scriptItem', () => {
    expect(isScriptPath('C:\\a\\B.FUNSCRIPT')).toBe(true);
    expect(isScriptPath('C:\\a\\B.mp4')).toBe(false);
    expect(isScriptPath(null)).toBe(false);
    expect(scriptItem(SOLO)).toEqual({ path: SOLO.path, name: 'Solo Loop', _script: true, hasFunscript: true, funscriptPath: SOLO.path, pairedWith: null });
    expect(scriptItem({ ...SOLO, pairedWith: 'Alpha.mp4' }).pairedWith).toBe('Alpha.mp4');
  });

  it('the tile: marked as a script, labelled for a screen reader', () => {
    const tile = buildNoVideoTile('Solo Loop.funscript', { script: true });
    expect(tile.className).toBe('library__thumb-novideo library__thumb-novideo--script');
    expect(tile.querySelector('.library__thumb-novideo-title').textContent).toBe('Solo Loop');
    expect(tile.title).toBe(t('library.scripts.tileLabel'));
    expect(buildNoVideoTile('x.mp4').querySelector('.library__thumb-novideo-mark')).toBeNull();
  });

  it('every locale has the words; the counts in their plural forms', () => {
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const j = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
      for (const k of ['filterScripts', 'scriptCount', 'scriptCountFiltered']) expect(typeof j.library[k], `${l} library.${k}`).toBe('string');
      for (const k of ['tileLabel', 'mark', 'play', 'pair', 'showInFolder', 'delete', 'menuAria', 'emptyTitle', 'emptyHint']) {
        expect(typeof j.library.scripts[k], `${l} library.scripts.${k}`).toBe('string');
      }
      expect(typeof j.playlists.scriptCount, `${l} playlists.scriptCount`).toBe('string');
    }
  });
});

describe('app.js: a script entry plays in the script player, and a list goes on after it', () => {
  const Lifted = liftAppClass(['_playScriptEntry', '_endScriptEntry', '_advanceAfterScriptEntry', '_onScriptPlayerChange', '_playQueueItem', '_armQueueEndedListener'], {
    t: (k) => k, showToast: () => {}, shouldOfferResume: () => false, formatResumeTime: () => '',
    document: { getElementById: () => null },
  });
  const SCRIPT = 'C:\\Lib\\Scripts\\Solo Loop.funscript';
  const PL_CTX = { source: 'playlist', sourceContext: { playlistId: 'p1' }, list: ['C:\\Lib\\A.mp4', SCRIPT, 'C:\\Lib\\B.mp4'], index: 1 };

  function makeApp(extra = {}) {
    const video = new EventTarget();
    video.paused = false;
    video.pause = vi.fn(() => { video.paused = true; });
    const app = Object.assign(new Lifted(), {
      videoPlayer: { video },
      _isPlaylistContext: (ctx) => !!ctx?.sourceContext?.playlistId,
      _currentView: vi.fn(() => 'player'),
      _navigateBack: vi.fn(),
      _navigateTo: vi.fn(),
      _miniActive: false,
      _closeMiniplayer: vi.fn(),
      _playScriptOnly: vi.fn(async () => true),
      _stopScriptPlayer: vi.fn(async () => {}),
      // What follows is Up Next's answer (your queue, the list, Loop's wrap), played as Up Next plays it.
      upNextEngine: { peekNext: vi.fn(() => 'C:\\Lib\\B.mp4') },
      _setUpNextContext: vi.fn(),
      _playUpNext: vi.fn(async () => {}),
      scriptPlayerBar: { update() {} },
      _editorAllowsReplace: () => true,
      _recordResumePosition() {},
      getResumeEntry: () => null,
      _updateQueueUI: vi.fn(),
      _resetCustomRoutingState() {},
      loadVideo: vi.fn(),
      _markCloudUploadsPending() {},
      _applyPendingResumeSeek() {},
      _loadQueueItemContent: vi.fn(async () => {}),
      _routeLoadedVideoToPlayerWindow() {},
      _advanceQueueOnEnded: vi.fn(() => true),
      _playerWindowActive: false,
    }, extra);
    return app;
  }
  const state = (over) => ({ active: true, path: SCRIPT, name: 'Solo Loop', ended: false, loop: false, ...over });

  it('from a playlist: the video pauses, the player closes, the script plays; at its end the devices go back, then the next entry', async () => {
    const app = makeApp();
    await app._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: PL_CTX });
    expect(app.videoPlayer.video.pause).toHaveBeenCalled();
    expect(app._navigateBack).toHaveBeenCalled();
    expect(app._playScriptOnly).toHaveBeenCalledWith({ name: 'Solo Loop', path: SCRIPT });
    expect(app._scriptEntry).toEqual({ path: SCRIPT, ctx: PL_CTX });
    app._onScriptPlayerChange(state({ time: 2 }));                     // playing: nothing
    expect(app._playUpNext).not.toHaveBeenCalled();
    app._onScriptPlayerChange(state({ ended: true }));
    await vi.waitFor(() => expect(app._playUpNext).toHaveBeenCalledTimes(1));
    expect(app._playUpNext).toHaveBeenCalledWith('C:\\Lib\\B.mp4');
    expect(app._setUpNextContext).toHaveBeenCalledWith(PL_CTX);           // from the script's own place in the list
    expect(app._stopScriptPlayer.mock.invocationCallOrder[0]).toBeLessThan(app._playUpNext.mock.invocationCallOrder[0]);
    expect(app._currentPlayContext).toBe(PL_CTX);
    expect(app._openPlayerForNext).toBe(true);
    expect(app._scriptEntry).toBeNull();
    app._onScriptPlayerChange(state({ ended: true }));                 // a second "ended": once only
    await Promise.resolve();
    expect(app._playUpNext).toHaveBeenCalledTimes(1);
  });

  it('from the Library: it just plays (a video can stay open), and nothing follows its end', async () => {
    const app = makeApp();
    await app._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: { source: 'library', list: [SCRIPT], index: 0 } });
    expect(app.videoPlayer.video.pause).not.toHaveBeenCalled();
    expect(app._navigateBack).not.toHaveBeenCalled();
    expect(app._scriptEntry).toBeNull();
    app._onScriptPlayerChange(state({ ended: true }));
    await Promise.resolve();
    expect(app._playUpNext).not.toHaveBeenCalled();
  });

  it('✕ on the bar, another script, or loop on: the list stops here', async () => {
    for (const next of [state({ active: false }), state({ path: 'C:\\Other.funscript' })]) {
      const app = makeApp();
      await app._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: PL_CTX });
      app._onScriptPlayerChange(next);
      expect(app._scriptEntry).toBeNull();
      app._onScriptPlayerChange(state({ ended: true }));
      await Promise.resolve();
      expect(app._playUpNext).not.toHaveBeenCalled();
    }
    const looping = makeApp();
    await looping._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: PL_CTX });
    looping._onScriptPlayerChange(state({ ended: true, loop: true }));
    await Promise.resolve();
    expect(looping._playUpNext).not.toHaveBeenCalled();
  });

  it('the list ends after it (nothing next, Loop off): nothing plays, the player stays shut (the advance takes Up Next\'s answer, which wraps on Loop: T300)', async () => {
    const app = makeApp();
    app.upNextEngine.peekNext = vi.fn(() => null);
    await app._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: PL_CTX });
    app._onScriptPlayerChange(state({ ended: true }));
    await vi.waitFor(() => expect(app._stopScriptPlayer).toHaveBeenCalled());
    await Promise.resolve();
    expect(app._playUpNext).not.toHaveBeenCalled();
    expect(app._openPlayerForNext).toBeFalsy();
  });

  it('a script that would not start leaves no entry behind', async () => {
    const app = makeApp({ _playScriptOnly: vi.fn(async () => false) });
    await app._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: PL_CTX });
    expect(app._scriptEntry).toBeNull();
  });

  it('Play all: the "ended" Up Next turns into a script entry advances the queue ONCE (live, 2026-11-26: it went on past the script)', () => {
    const app = makeApp({
      _playQueue: [{ path: 'C:\\Lib\\A.mp4', name: 'A.mp4' }, { path: SCRIPT, name: 'Solo Loop.funscript' }, { path: 'C:\\Lib\\B.mp4', name: 'B.mp4' }],
      _playQueueIndex: 0,
    });
    app._playScriptEntry = vi.fn(async () => true);
    const video = app.videoPlayer.video;
    // Up Next's own "ended" handler was added at start-up, before the queue's.
    video.addEventListener('ended', () => app._playQueueItem(1));
    app._armQueueEndedListener();                                      // as video A's _playQueueItem did
    video.dispatchEvent(new Event('ended'));
    expect(app._playScriptEntry).toHaveBeenCalledTimes(1);
    expect(app._playScriptEntry.mock.calls[0][0]).toMatchObject({ path: SCRIPT, _playContext: { source: 'queue', index: 1 } });
    expect(app._advanceQueueOnEnded).not.toHaveBeenCalled();
    expect(app._queueEndedListener).toBeNull();
  });

  it('Play all: the video after a script entry opens the player again', () => {
    const app = makeApp({
      _playQueue: [{ path: SCRIPT, name: 'Solo Loop.funscript' }, { path: 'C:\\Lib\\B.mp4', name: 'B.mp4' }],
      _playQueueIndex: 0,
      _openPlayerForNext: true,
      _currentView: vi.fn(() => 'playlists'),
    });
    app._playQueueItem(1);
    expect(app._navigateTo).toHaveBeenCalledWith('player');
    expect(app._openPlayerForNext).toBe(false);
    expect(app.loadVideo).toHaveBeenCalledWith(expect.objectContaining({ path: 'C:\\Lib\\B.mp4' }), expect.anything());
  });

  it('Play all: a click on another item while a script entry plays hands the devices back first', async () => {
    const app = makeApp({
      _playQueue: [{ path: SCRIPT, name: 'Solo Loop.funscript' }, { path: 'C:\\Lib\\B.mp4', name: 'B.mp4' }],
      _scriptEntry: { path: SCRIPT, ctx: { source: 'queue' } },
    });
    await app._playQueueItem(1);
    expect(app._stopScriptPlayer).toHaveBeenCalledTimes(1);
    expect(app._stopScriptPlayer.mock.invocationCallOrder[0]).toBeLessThan(app.loadVideo.mock.invocationCallOrder[0]);
  });
});

describe('Playlists: a script entry', () => {
  let Playlists;
  beforeEach(async () => { ({ Playlists } = await import('../../renderer/components/playlists.js')); });
  const pl = { id: 'p1', name: 'Mix', videoPaths: ['C:\Lib\Alpha.mp4', SOLO.path, 'C:\Lib\Bravo.mp4'] };
  const make = () => {
    const calls = [];
    const settings = { get: (k) => store[k], set() {}, getPlaylists: () => [pl], removeVideoFromPlaylist: vi.fn() };
    const p = new Playlists({ settings, onPlayVideo: (...a) => calls.push(a), library: lib });
    p._loadVideoThumbnail = vi.fn();
    p._checkFunscriptBadge = vi.fn();
    return { p, calls };
  };

  it('its card: the script tile, never a picture fetched; its name without .funscript', () => {
    const { p } = make();
    const card = p._createVideoCard(SOLO.path, pl, null, true);
    expect(card.classList.contains('playlists__video-card--script')).toBe(true);
    expect(card.querySelector('.library__thumb-novideo--script')).not.toBeNull();
    expect(card.querySelector('.playlists__video-placeholder')).toBeNull();
    expect(card.querySelector('.playlists__video-title').textContent).toBe('Solo Loop');
    expect(p._loadVideoThumbnail).not.toHaveBeenCalled();
    expect(p._checkFunscriptBadge).not.toHaveBeenCalled();
    p._createVideoCard('C:\Lib\Bravo.mp4', pl, null, true);
    expect(p._loadVideoThumbnail).toHaveBeenCalledTimes(1);          // a video's still is
  });

  it('its row says "Script" in words', () => {
    const { p } = make();
    p._loadListStats = vi.fn();
    const row = p._createVideoListItem(SOLO.path, pl, null, true);
    expect(row.querySelector('.playlists__script-mark').textContent).toBe(EN.library.scripts.mark);
  });

  it('the count says videos and scripts apart; progress counts only videos', () => {
    const { p } = make();
    expect(p._entryCount(pl)).toBe('2 videos · 1 script');
    expect(p._entryCount({ videoPaths: ['C:\Lib\Alpha.mp4'] })).toBe('1 video');
    p._resumeEntryFor = () => null;
    p._isAvailable = () => () => true;
    // A script has no watched state: "1 of 2 watched", never "of 3".
    expect(p._summariseProgress(pl).total).toBe(2);
  });

  it('a click plays it through the app with this playlist\'s order, no video data read', async () => {
    const { p, calls } = make();
    const ctx = { source: 'playlist', sourceContext: { playlistId: 'p1' }, list: pl.videoPaths, index: 1 };
    await p._playVideoByPath(SOLO.path, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ path: SOLO.path, name: 'Solo Loop', _playContext: expect.objectContaining({ index: 1 }) });
    expect(calls[0].slice(1)).toEqual([null, null, []]);
  });
});

// Dave, 2026-11-26: "on that page only can we have a pill group on the right
// hand side of the row shared by the applies filter chips, to show unassigned
// by default and all as an option which shows all scripts regardless of
// whether they have an assigned video or not".
describe('the Scripts filter\'s Unassigned / All pills', () => {
  const MAIN = { name: 'Bravo.funscript', path: 'C:\Lib\Bravo.funscript' };    // Bravo's own script
  beforeEach(() => {
    lib._allFunscripts = [ALSO, MAIN, SOLO, USED, AXIS];
    lib._videos[1].funscriptPath = MAIN.path;
  });
  const pills = () => [...lib._container.querySelectorAll('#library-chips .library__scripts-scope-btn')];
  const titles = () => scriptCards().map((c) => c.querySelector('.library__card-title').textContent);

  it('only on Scripts, at the end of the chips row, Unassigned on at first', () => {
    lib._switchTab('scripts');
    const row = lib._container.querySelector('#library-chips');
    expect(row.hidden).toBe(false);
    expect(row.lastElementChild.className).toBe('library__scripts-scope');
    expect(row.lastElementChild.getAttribute('role')).toBe('radiogroup');
    expect(pills().map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([
      [EN.library.scripts.scopeUnassigned, 'true'], [EN.library.scripts.scopeAll, 'false'],
    ]);
    expect(titles()).toEqual(['Another One', 'Solo Loop']);
    lib._switchTab('matched');
    expect(pills()).toHaveLength(0);
  });

  it('All: every script, with or without a video (never an axis file); each paired one says whose it is', () => {
    lib._switchTab('scripts');
    pills()[1].click();
    expect(titles()).toEqual(['Alt', 'Another One', 'Bravo', 'Solo Loop']);
    expect(lib._container.querySelector('.library__video-count').textContent).toBe('4 scripts');
    const sub = (name) => scriptCards().find((c) => c.querySelector('.library__card-title').textContent === name).querySelector('.library__card-sub')?.textContent ?? null;
    expect(sub('Bravo')).toBe('With Bravo');                          // its main script
    expect(sub('Alt')).toBe('With Alpha');                            // a variant of Alpha
    expect(sub('Solo Loop')).toBeNull();
    expect(pills().map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('arrow keys move between them and choose', () => {
    lib._switchTab('scripts');
    pills()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(lib._scriptsScope).toBe('all');
    expect(document.activeElement?.dataset?.scope).toBe('all');
    pills()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(lib._scriptsScope).toBe('unassigned');
  });

  it('a paired script\'s menu has no Pair or Delete (it is its video\'s); a loose one keeps both', () => {
    lib._switchTab('scripts');
    pills()[1].click();
    const menuFor = (name) => {
      scriptCards().find((c) => c.querySelector('.library__card-title').textContent === name).querySelector('.library__kebab-btn').click();
      return [...document.querySelectorAll('.library__queue-context-menu [role="menuitem"]')].map((b) => b.dataset.pos);
    };
    expect(menuFor('Bravo')).toEqual(['play', 'playlist', 'folder']);
    expect(menuFor('Solo Loop')).toEqual(['play', 'playlist', 'pair', 'folder', 'delete']);
  });

  it('a paired script in a playlist is found too (Next and Up Next step into it)', () => {
    expect(lib.getVideoByPath(MAIN.path)).toMatchObject({ _script: true, name: 'Bravo', pairedWith: 'Bravo.mp4' });
    expect(lib.getVideoByPath(AXIS.path)).toBeUndefined();
  });
});

describe('the Library menu', () => {
  it('no "Scripts without a video" entry any more (Filters > Scripts has them); Load from URL is there', async () => {
    const { NavBar } = await import('../../renderer/components/nav-bar.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const bar = new NavBar({ onNavigate() {}, onLoadUrlClick() {}, onDisabledVideos() {}, onAddSource() {}, onNewCollection() {} });
    bar.init(host);
    bar._toggleLibraryDropdown();
    const items = [...host.querySelectorAll('.nav-bar__library-option')].map((b) => b.textContent);
    expect(items).toContain(EN.remoteVideo.title);
    expect(items.some((x) => /without a video/i.test(x))).toBe(false);
    expect(host.querySelector('.nav-bar__library-option--loose')).toBeNull();
    expect(EN.scriptPlayer.navLoose).toBeUndefined();
    host.remove();
  });
});

describe('app.js: a playlist playing in the mini player keeps to it after a script (T302, B091)', () => {
  const Lifted = liftAppClass(['_playScriptEntry', '_endScriptEntry', '_advanceAfterScriptEntry', '_onScriptPlayerChange'], {
    t: (k) => k, document: { getElementById: () => null },
  });
  const SCRIPT = 'C:\Lib\Scripts\Solo Loop.funscript';
  const CTX = { source: 'playlist', sourceContext: { playlistId: 'p1' }, list: ['C:\Lib\A.mp4', SCRIPT, 'C:\Lib\B.mp4'], index: 1 };
  const make = (next) => {
    const video = { paused: false, pause() { this.paused = true; } };
    const app = Object.assign(new Lifted(), {
      videoPlayer: { video },
      _isPlaylistContext: (c) => !!c?.sourceContext?.playlistId,
      _currentView: () => 'playlists',
      _navigateBack: vi.fn(),
      _miniActive: true,
      _closeMiniplayer: vi.fn(function () { this._miniActive = false; }),
      _enterMiniplayer: vi.fn(function () { this._miniActive = true; }),
      _setUpNextContext() {},
      _playScriptOnly: vi.fn(async () => true),
      _stopScriptPlayer: vi.fn(async () => {}),
      upNextEngine: { peekNext: () => next },
      _playUpNext: vi.fn(async () => {}),
      scriptPlayerBar: { update() {} },
    });
    return app;
  };
  const ended = { active: true, path: SCRIPT, ended: true, loop: false };

  it('the corner closes for the script, and the next video goes back into it (not the full player)', async () => {
    const app = make('C:\Lib\B.mp4');
    await app._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: CTX });
    expect(app._closeMiniplayer).toHaveBeenCalled();
    app._onScriptPlayerChange(ended);
    await vi.waitFor(() => expect(app._playUpNext).toHaveBeenCalledWith('C:\Lib\B.mp4'));
    expect(app._enterMiniplayer).toHaveBeenCalledTimes(1);
    expect(app._enterMiniplayer.mock.invocationCallOrder[0]).toBeLessThan(app._playUpNext.mock.invocationCallOrder[0]);
    expect(app._openPlayerForNext).toBeFalsy();
  });

  it('a script next keeps waiting for the next video; ✕ forgets the corner', async () => {
    const app = make('C:\Lib\Scripts\Next.funscript');
    await app._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: CTX });
    app._onScriptPlayerChange(ended);
    await vi.waitFor(() => expect(app._playUpNext).toHaveBeenCalled());
    expect(app._enterMiniplayer).not.toHaveBeenCalled();
    expect(app._miniBeforeScript).toBe(true);
    const stopped = make('C:\Lib\B.mp4');
    await stopped._playScriptEntry({ path: SCRIPT, name: 'Solo Loop', _playContext: CTX });
    stopped._onScriptPlayerChange({ active: false, path: null });
    expect(stopped._miniBeforeScript).toBe(false);
  });
});

describe('Delete… on a script card (test day T306, B093)', () => {
  it('once the script is gone, its card goes (the delete rescans but did not redraw)', async () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    expect(scriptCards()).toHaveLength(2);
    lib.deleteLooseScript = vi.fn(async (item) => {
      lib._unmatchedFunscripts = lib._unmatchedFunscripts.filter((s) => s.path !== item.path);   // the rescan's list
      return true;
    });
    scriptCards()[1].querySelector('.library__kebab-btn').click();
    document.querySelector('.library__queue-context-menu [data-pos="delete"]').click();
    await vi.waitFor(() => expect(scriptCards().map((c) => c.dataset.videoPath)).toEqual([ALSO.path]));
    expect(lib._container.querySelector('.library__video-count').textContent).toBe('1 script');
  });

  it('cancelled: the card stays', async () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    lib.deleteLooseScript = vi.fn(async () => false);
    scriptCards()[1].querySelector('.library__kebab-btn').click();
    document.querySelector('.library__queue-context-menu [data-pos="delete"]').click();
    await Promise.resolve(); await Promise.resolve();
    expect(scriptCards()).toHaveLength(2);
  });
});

describe('app.js: a pair or delete from the scripts window redraws the Scripts filter (T310, B094)', () => {
  it('paired: gone from Unassigned at once; deleted: the same; the one-script window closes itself', async () => {
    let opts = null;
    const Lifted = liftAppClass(['_showLooseScripts'], {
      looseScripts: (u) => u, showLooseScriptsDialog: (o) => { opts = o; return Promise.resolve(null); },
      showToast: () => {}, t: (k) => k,
    });
    const libStub = {
      _unmatchedFunscripts: [SOLO, ALSO], _videos: [{ name: 'Bravo.mp4', path: 'C:\Lib\Bravo.mp4' }], _activeTab: 'scripts',
      associateDownloadedScript: vi.fn(() => true), _applyFilters: vi.fn(), deleteLooseScript: vi.fn(async () => true),
    };
    const app = Object.assign(new Lifted(), { library: libStub });
    app._showLooseScripts({ only: { path: SOLO.path } });
    expect(opts.scripts).toEqual([SOLO]);
    expect(opts.closeWhenEmpty).toBe(true);
    expect(opts.onPair('C:\Lib\Bravo.mp4', SOLO)).toBe(true);
    expect(libStub._unmatchedFunscripts).toEqual([ALSO]);
    expect(libStub._applyFilters).toHaveBeenCalledTimes(1);
    await expect(opts.onDelete(ALSO)).resolves.toBe(true);
    expect(libStub._applyFilters).toHaveBeenCalledTimes(2);
    libStub._activeTab = 'all';                                       // not on Scripts: nothing to redraw
    opts.onPair('C:\Lib\Bravo.mp4', ALSO);
    expect(libStub._applyFilters).toHaveBeenCalledTimes(2);
  });
});

// Test day 2026-11-26, T357 (B096): a script card's ⋮ opened with Enter left
// the focus on ⋮ and the arrows went nowhere, so its menu could not be used
// from the keyboard.
describe('a script card menu from the keyboard (B096)', () => {
  const menuEl = () => document.querySelector('.library__queue-context-menu');
  const keydown = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('Enter on ⋮: the first item takes the focus; Down / Up / End move; Escape closes and the focus is back on ⋮', () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    const kebab = scriptCards()[0].querySelector('.library__kebab-btn');
    kebab.focus();
    kebab.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));    // Enter / Space
    expect(document.activeElement.textContent).toBe(EN.library.scripts.play);
    keydown(document.activeElement, 'ArrowDown');
    expect(document.activeElement.textContent).toBe(EN.library.addToPlaylist);
    keydown(document.activeElement, 'ArrowUp');
    keydown(document.activeElement, 'ArrowUp');                                    // wraps
    expect(document.activeElement.textContent).toBe(EN.library.scripts.delete);
    keydown(document.activeElement, 'Home');
    expect(document.activeElement.textContent).toBe(EN.library.scripts.play);
    keydown(document.activeElement, 'Escape');
    expect(menuEl()).toBeNull();
    expect(document.activeElement).toBe(kebab);
  });

  it('a choice by Enter closes it and gives the focus back too; a mouse click leaves the focus alone', () => {
    lib._activeTab = 'scripts';
    lib._applyFilters();
    const kebab = scriptCards()[1].querySelector('.library__kebab-btn');
    kebab.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    const folder = [...menuEl().querySelectorAll('[role="menuitem"]')].find((b) => b.dataset.pos === 'folder');
    folder.focus();
    folder.click();
    expect(window.funsync.showInFolder).toHaveBeenCalledWith(SOLO.path);
    expect(document.activeElement).toBe(kebab);
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    kebab.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));      // the mouse
    expect(menuEl()).not.toBeNull();
    expect(menuEl().contains(document.activeElement)).toBe(false);
    other.remove();
  });
});
