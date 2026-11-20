// The Stash link's renderer side in app.js (Stash S1, Round 2 stage 2d;
// DESIGN-stash-s1.md (c), (f) "The phone", (a) step 8 "When it syncs", and
// Dave's answer 3: Stash scene markers as seek-bar chapters). These tests
// drive the REAL app.js methods (lifted: _wireStash, _applyStashMarkers,
// _jumpChapter, _scheduleRemoteTags, _registerRemoteTags) with the REAL
// stash-store.js, DataService, event bus and LibraryTagIndex, a fake main
// (`window.funsync`'s Stash calls) and a fake backend, and assert what the
// seek bar is given, what the phone is sent and what main is asked.
//
// jsdom on purpose (no node docblock): DataService.set calls
// window.funsync.setSetting. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import {
  STASH_API, initStashStore, onStashChanged, onStashSettingsChanged, stashData, stashVersion,
  stashSyncOnStart, isStashSettingPath, _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';
import { stashMarkersForVideo, chapterStarts } from '../../renderer/js/stash-markers.js';
import { scriptMetaMap } from '../../renderer/js/script-meta-store.js';
import {
  buildRemoteTagSlice, remoteTagSliceFromIndex, REMOTE_TAG_SETTING_PATHS,
} from '../../renderer/js/remote-tag-slice.js';
import { LibraryTagIndex } from '../../renderer/js/library-tag-filter.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const PORT = 5123;
const SERVER = 'http://127.0.0.1:9999';
const A = 'C:\\Lib\\Alpha Scene.mp4';
const B = 'C:\\Lib\\Bravo Take.mp4';

function projection(rev, { markers, tagName = 'Synthetic Tag A' } = {}) {
  return {
    v: 1, rev, server: { url: SERVER, version: 'v0.32.0' }, lastSync: { at: 1, kind: 'full', ok: true },
    links: { [A]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 5, oshash: 'aaaa' }, linkedAt: 2, state: 'ok' } },
    check: {}, refused: {},
    scenes: {
      1: {
        id: '1', title: 'Synthetic Scene Small', tagIds: ['5'], performerIds: [], files: [],
        markers: markers ?? [
          { id: '7', title: 'Synthetic marker one', seconds: 1, endSeconds: null, tag: 'Synthetic Tag A' },
          { id: '8', title: 'Synthetic marker two', seconds: 4, endSeconds: 6, tag: 'Synthetic Tag B' },
        ],
      },
    },
    performers: {}, studios: {}, tags: { 5: { id: '5', name: tagName } },
  };
}

/** A fake main: its Stash calls, recorded by preload name. */
function fakeMain(data) {
  const main = { calls: [], data, changed: null, settingsChanged: null };
  const api = {};
  for (const name of Object.values(STASH_API)) {
    api[name] = vi.fn(async (...args) => {
      main.calls.push(name);
      return name === STASH_API.data ? main.data : { ok: true, started: false, reason: 'off' };
    });
  }
  api[STASH_API.onChanged] = vi.fn((cb) => { main.changed = cb; return () => {}; });
  api[STASH_API.onSettingsChanged] = vi.fn((cb) => { main.settingsChanged = cb; return () => {}; });
  api[STASH_API.onProgress] = vi.fn(() => () => {});
  _setStashApiForTests(api);
  return main;
}

function fakeBackend() {
  const backend = { posts: [] };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (String(url).endsWith('/api/media/register')) {
      const body = JSON.parse(opts.body);
      if (body.videoTags) backend.posts.push(body.videoTags);
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return backend;
}

function dataService({ enabled = true, syncOnStart = false } = {}) {
  const ds = new DataService();
  ds._cache = {
    settings: {
      backend: { port: PORT },
      library: { sources: [], userTags: {}, hiddenTags: {}, scriptTags: {}, tagSettings: { aliases: {}, hidden: [], facetOverrides: {} } },
      stash: { enabled, url: SERVER, syncOnStart, pathRules: [] },
    },
    playlists: [], categories: [], videoCategories: {},
  };
  ds._initialized = true;
  return ds;
}

const t = (key, params) => (key === 'player.stashMarker' ? `Stash marker: ${params.title}`
  : key === 'player.stashMarkerUntitled' ? 'Stash marker' : key);

const Lifted = liftAppClass(
  ['_wireStash', '_applyStashMarkers', '_jumpChapter', '_scheduleRemoteTags', '_registerRemoteTags',
    '_streamPlayerWindowData', '_variantLabelText'],
  {
    PLAYERWIN, eventBus, t, initStashStore, onStashChanged, onStashSettingsChanged, stashData, stashSyncOnStart,
    isStashSettingPath, stashMarkersForVideo, chapterStarts, scriptMetaMap,
    buildRemoteTagSlice, remoteTagSliceFromIndex, REMOTE_TAG_SETTING_PATHS,
  },
);

let main;
let backend;
let settings;
let app;
let savedHandlers;
let videos;

async function boot({ enabled = true, syncOnStart = false, data = projection(1), playing = A } = {}) {
  main = fakeMain(data);
  settings = dataService({ enabled, syncOnStart });
  app = new Lifted();
  app.backendPort = PORT;
  app.settings = settings;
  app.progressBar = { setStashMarkers: vi.fn(), stashMarkerLabel: null };
  app.videoPlayer = { video: { currentTime: 0 } };
  app.funscriptEngine = { getChapters: () => [] };
  app._currentVideoPath = playing;
  app._currentIsRemote = false;
  videos = [{ path: A, name: 'Alpha Scene.mp4', size: 1000, dateAdded: 5 }, { path: B, name: 'Bravo Take.mp4', size: 7, dateAdded: 6 }];
  const memo = new LibraryTagIndex({
    settings: () => settings, videos: () => videos, stashData: () => stashData(), stashVersion: () => stashVersion(),
  });
  app.library = {
    _videos: videos,
    _tagIndexMemo: () => memo,
    getVideoByPath: (p) => videos.find((v) => v.path === p) || null,
  };
  app._wireStash();
  await vi.advanceTimersByTimeAsync(0);
}

const lastMarkers = () => app.progressBar.setStashMarkers.mock.calls.at(-1)?.[0];
const slicePaths = (post) => Object.keys(post || {});

beforeEach(() => {
  vi.useFakeTimers();
  savedHandlers = eventBus._handlers;
  eventBus._handlers = new Map();
  _resetStashStoreForTests();
  backend = fakeBackend();
  window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
});

afterEach(() => {
  vi.useRealTimers();
  eventBus._handlers = savedHandlers;
  _resetStashStoreForTests();
  delete globalThis.fetch;
  delete window.funsync;
});

describe('Stash markers on the seek bar for the playing video', () => {
  it('Stash on and the video linked: its scene\'s markers, labelled as Stash\'s', async () => {
    await boot();
    expect(lastMarkers()).toEqual([
      { startMs: 1000, endMs: null, title: 'Synthetic marker one' },
      { startMs: 4000, endMs: 6000, title: 'Synthetic marker two' },
    ]);
    expect(app.progressBar.stashMarkerLabel('Synthetic marker one')).toBe('Stash marker: Synthetic marker one');
    expect(app.progressBar.stashMarkerLabel('')).toBe('Stash marker');
  });

  it('a sync that changes the markers redraws them (main reports the change)', async () => {
    await boot();
    main.data = projection(2, { markers: [{ id: '9', title: 'New marker', seconds: 2.5, endSeconds: null }] });
    main.changed({ rev: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastMarkers()).toEqual([{ startMs: 2500, endMs: null, title: 'New marker' }]);
  });

  it('turning Stash off takes them away; on again brings them back with no request', async () => {
    await boot();
    settings.set('stash.enabled', false);
    expect(lastMarkers()).toEqual([]);
    settings.set('stash.enabled', true);
    expect(lastMarkers()).toHaveLength(2);
    expect(main.calls.filter((n) => n === STASH_API.data)).toHaveLength(1);
    expect(main.calls.filter((n) => n.includes('ync'))).toEqual([]);
  });

  it('Stash off at start-up: no markers, and main is not even asked for the data', async () => {
    await boot({ enabled: false });
    app._applyStashMarkers();
    expect(lastMarkers()).toEqual([]);
    expect(main.calls).toEqual([]);
  });

  it('a video that is not linked, a remote stream, or a swapped file (other size): none', async () => {
    await boot({ playing: B });
    expect(lastMarkers()).toEqual([]);
    app._currentVideoPath = A;
    app._currentIsRemote = true;
    app._applyStashMarkers();
    expect(lastMarkers()).toEqual([]);
    app._currentIsRemote = false;
    videos[0].size = 999;
    app._applyStashMarkers();
    expect(lastMarkers()).toEqual([]);
  });

  it('the previous / next chapter keys step through the Stash markers too', async () => {
    await boot();
    const v = app.videoPlayer.video;
    app._jumpChapter(+1);
    expect(v.currentTime).toBe(1);
    app._jumpChapter(+1);
    expect(v.currentTime).toBe(4);
    app._jumpChapter(+1);
    expect(v.currentTime).toBe(4);           // no wrap (C-E23)
    app._jumpChapter(-1);
    expect(v.currentTime).toBe(1);
  });

  it('with the script\'s own chapters: both kinds, in time order', async () => {
    await boot();
    app.funscriptEngine = { getChapters: () => [{ startMs: 0, endMs: 2000, name: 'Intro' }, { startMs: 2000, endMs: 9000, name: 'Main' }] };
    const v = app.videoPlayer.video;
    v.currentTime = 0.2;
    app._jumpChapter(+1);
    expect(v.currentTime).toBe(1);
    app._jumpChapter(+1);
    expect(v.currentTime).toBe(2);
    app._jumpChapter(+1);
    expect(v.currentTime).toBe(4);
  });
});

describe('the detached player window gets them too', () => {
  function popout() {
    const relayed = [];
    const relay = vi.fn((dir, msg) => { if (dir === 'to-popout') relayed.push(msg); });
    window.funsync = new Proxy({ playerPopoutRelay: relay }, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)) });
    app._playerWindowOpen = true;
    app.videoPlayer.duration = 60;
    return relayed;
  }
  const chaptersMsgs = (relayed) => relayed.filter((m) => m.type === PLAYERWIN.CHAPTERS);

  it('a Stash change relays the markers next to the script\'s chapters', async () => {
    await boot();
    const relayed = popout();
    app.funscriptEngine = { isLoaded: true, getChapters: () => [{ startMs: 0, endMs: 2000, name: 'Intro' }], getBookmarks: () => [] };
    main.data = projection(2, { markers: [{ id: '9', title: 'New marker', seconds: 2.5 }] });
    main.changed({ rev: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const [msg] = chaptersMsgs(relayed);
    expect(msg.chapters).toEqual([{ startMs: 0, endMs: 2000, name: 'Intro' }]);
    expect(msg.stashMarkers).toEqual([{ startMs: 2500, endMs: null, title: 'New marker' }]);
    expect(msg.durationMs).toBe(60000);
  });

  it('opening the window with a video that has no script still sends its Stash markers', async () => {
    await boot();
    const relayed = popout();
    app.funscriptEngine = { isLoaded: false, getChapters: () => [] };
    app._streamPlayerWindowData();
    const [msg] = chaptersMsgs(relayed);
    expect(msg.chapters).toEqual([]);
    expect(msg.stashMarkers).toHaveLength(2);
  });

  it('turning Stash off clears them there too; nothing is relayed when there was nothing', async () => {
    await boot({ playing: B });
    const relayed = popout();
    app._applyStashMarkers();
    expect(chaptersMsgs(relayed)).toEqual([]);
    app._currentVideoPath = A;
    app._applyStashMarkers();
    settings.set('stash.enabled', false);
    expect(chaptersMsgs(relayed).at(-1).stashMarkers).toEqual([]);
  });
});

describe('the phone\'s tag slice follows the Stash data', () => {
  it('a Stash change re-sends the slice with the Stash tags in it', async () => {
    await boot({ data: projection(1, { tagName: 'Synthetic Tag A' }) });
    await vi.advanceTimersByTimeAsync(500);
    const first = backend.posts.at(-1);
    expect(first[A].map((tag) => tag.label)).toContain('Synthetic Tag A');
    main.data = projection(2, { tagName: 'Outdoor' });
    main.changed({ rev: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts.at(-1)[A].map((tag) => tag.label)).toContain('Outdoor');
    expect(backend.posts.at(-1)[A].map((tag) => tag.label)).not.toContain('Synthetic Tag A');
  });

  it('turning Stash off re-sends it without them (a write of the whole stash block too)', async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(500);
    expect(slicePaths(backend.posts.at(-1))).toEqual([A]);
    settings.set('stash', { ...settings.get('stash'), enabled: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts.at(-1)).toEqual({});
  });
});

describe('never on its own: the one start-up sync is asked only when its setting is on', () => {
  it('on, syncOnStart off: start-up and every scan ask main for the data and nothing else', async () => {
    await boot({ syncOnStart: false });
    eventBus.emit('library:filtered', { count: 2 });
    eventBus.emit('library:filtered', { count: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(main.calls).toEqual([STASH_API.data]);
  });

  it('syncOnStart on: main is asked once, after the first scan that listed videos', async () => {
    await boot({ syncOnStart: true });
    app.library._videos = [];
    eventBus.emit('library:filtered', { count: 0 });
    expect(main.calls.filter((n) => n === STASH_API.syncOnStart)).toHaveLength(0);
    app.library._videos = videos;
    eventBus.emit('library:filtered', { count: 2 });
    eventBus.emit('library:filtered', { count: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(main.calls.filter((n) => n === STASH_API.syncOnStart)).toHaveLength(1);
    expect(main.calls).not.toContain(STASH_API.sync);
  });
});

describe('main\'s settings block lands in the renderer\'s settings', () => {
  it('Link (main writes settings.stash) shows in settings.get without a write back', async () => {
    await boot({ enabled: false });
    const setSetting = window.funsync.setSetting;
    main.settingsChanged({ enabled: true, url: 'http://127.0.0.1:9998', syncOnStart: false, pathRules: [], trustedCert: null });
    expect(settings.get('stash.url')).toBe('http://127.0.0.1:9998');
    expect(settings.get('stash.enabled')).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();
    // Turned on by main: the copy loads at once, with no sync.
    await vi.advanceTimersByTimeAsync(0);
    expect(main.calls).toEqual([STASH_API.data]);
    expect(lastMarkers()).toHaveLength(2);
  });

  it('a malformed block changes nothing', async () => {
    await boot();
    main.settingsChanged(null);
    main.settingsChanged(['x']);
    expect(settings.get('stash.url')).toBe(SERVER);
  });
});
