// The phone's Tags filter gets its tags from the desktop (P1 tags, Round 3,
// 2026-11-18; design (e) "The phone's filter slice"). The desktop merges
// every source once and POSTs `videoTags` to /api/media/register; these
// tests drive the REAL app.js methods (lifted, helpers/app-methods.js), the
// REAL DataService, the REAL event bus and the REAL funscript-metadata store,
// and assert on the POST bodies a fake backend receives: what the phone's
// /api/remote/tags will read.
//
// jsdom on purpose (no node docblock): DataService.set calls
// window.funsync.setSetting. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import {
  scriptMetaMap, onScriptMetaChanged, refreshScriptMeta, getScriptMeta,
  _resetScriptMetaStoreForTests, _setScriptMetaFetcherForTests,
} from '../../renderer/js/script-meta-store.js';
import { buildRemoteTagSlice, REMOTE_TAG_SETTING_PATHS } from '../../renderer/js/remote-tag-slice.js';

const PORT = 5123;
const A = 'D:/v/Alpha Scene.mp4';
const A_SCRIPT = 'D:/v/Alpha Scene.funscript';
const B = 'D:/v/Bravo Scene.mp4';

function fakeBackend() {
  const backend = { registers: [], up: true };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (!backend.up) throw new TypeError('fetch failed');
    if (String(url).endsWith('/api/media/register')) backend.registers.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return backend;
}

function realDataService() {
  const ds = new DataService();
  ds._cache = {
    settings: {
      backend: { port: PORT },
      library: {
        sources: [], collections: [],
        userTags: { [A]: ['favourite'] },
        hiddenTags: {},
        scriptTags: {},
        tagSettings: { aliases: {}, hidden: [], facetOverrides: {} },
      },
    },
    playlists: [], categories: [], videoCategories: {},
  };
  ds._initialized = true;
  return ds;
}

const tagSends = (backend) => backend.registers.filter((r) => r.videoTags);
const lastKeys = (backend, path) => (tagSends(backend).at(-1)?.videoTags[path] || []).map((t) => t.key);

describe('the tag slice reaches the backend (design (e))', () => {
  const refreshSpy = vi.fn((opts) => refreshScriptMeta(opts));
  const Lifted = liftAppClass(
    ['_wireGroupingsRegister', '_registerGroupingsEarly', '_wireRemoteTags', '_scheduleRemoteTags',
      '_registerRemoteTags', '_remoteTagsAfterRestart', '_onBackendStatusForRegistry'],
    {
      eventBus, scriptMetaMap, onScriptMetaChanged, refreshScriptMeta: refreshSpy, getScriptMeta,
      buildRemoteTagSlice, REMOTE_TAG_SETTING_PATHS,
    },
  );
  let backend;
  let settings;
  let app;
  let savedHandlers;

  beforeEach(() => {
    vi.useFakeTimers();
    savedHandlers = eventBus._handlers;
    eventBus._handlers = new Map();
    _resetScriptMetaStoreForTests();
    _setScriptMetaFetcherForTests(async () => null, async () => {});
    refreshSpy.mockClear();
    backend = fakeBackend();
    window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
    settings = realDataService();
    app = new Lifted();
    app.backendPort = PORT;
    app.settings = settings;
    app.library = {
      _videos: [
        { path: A, name: 'Alpha Scene.mp4', funscriptPath: A_SCRIPT },
        { path: B, name: 'Bravo Scene.mp4', funscriptPath: null },
      ],
      _registerWithBackend: vi.fn(),
    };
    app._wireGroupingsRegister();
  });

  afterEach(() => {
    vi.useRealTimers();
    eventBus._handlers = savedHandlers;
    _resetScriptMetaStoreForTests();
    delete globalThis.fetch;
    delete window.funsync;
  });

  it('adding a tag sends the merged slice once, on its own (no videos, no groupings)', async () => {
    settings.set('library.userTags', { [A]: ['favourite', 'pov'], [B]: ['solo'] });
    expect(tagSends(backend)).toHaveLength(0);           // debounced
    await vi.advanceTimersByTimeAsync(500);
    expect(tagSends(backend)).toHaveLength(1);
    const sent = tagSends(backend)[0];
    expect(Object.keys(sent).sort()).toEqual(['videoTags']);
    expect(sent.videoTags[A]).toEqual([
      { key: 'content:favourite', facet: 'content', label: 'favourite' },
      { key: 'content:pov', facet: 'content', label: 'pov' },
    ]);
    expect(lastKeys(backend, B)).toEqual(['content:solo']);
  });

  it('a tag hidden on the video is not sent, and one hidden everywhere neither', async () => {
    settings.set('library.userTags', { [A]: ['favourite'], [B]: ['solo'] });
    settings.set('library.scriptTags', { [A]: { tags: ['the-handy', 'real'], scriptPath: A_SCRIPT } });
    await vi.advanceTimersByTimeAsync(500);
    expect(lastKeys(backend, A)).toEqual(['device:the-handy', 'content:favourite', 'content:real']);

    settings.set('library.hiddenTags', { [A]: ['the-handy'] });
    await vi.advanceTimersByTimeAsync(500);
    expect(lastKeys(backend, A)).toEqual(['content:favourite', 'content:real']);

    settings.set('library.tagSettings', { aliases: {}, hidden: ['real'], facetOverrides: {} });
    await vi.advanceTimersByTimeAsync(500);
    expect(lastKeys(backend, A)).toEqual(['content:favourite']);
  });

  it('the funscript harvest arriving re-sends the slice with the file’s tags', async () => {
    _setScriptMetaFetcherForTests(async () => ({
      records: { [A_SCRIPT]: { metadata: { tags: ['POV'], creator: 'Scripter One' }, readAt: 1 } },
      pending: 0, registered: 2, cacheId: 'abc', seq: 1,
    }), async () => {});
    await refreshScriptMeta();
    await vi.advanceTimersByTimeAsync(500);
    expect(lastKeys(backend, A)).toEqual(['content:favourite', 'content:pov', 'creator:scripter-one']);
  });

  it('a scan’s new video list loads the harvest and sends the slice; a re-render of the same list does neither', async () => {
    eventBus.emit('library:filtered', { count: 2 });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(tagSends(backend)).toHaveLength(1);

    eventBus.emit('library:filtered', { count: 1 });         // a filter change: same list
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(tagSends(backend)).toHaveLength(1);

    app.library._videos = [...app.library._videos];          // a rescan
    eventBus.emit('library:filtered', { count: 2 });
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });

  it('a pairing re-sends the slice and asks for the new script’s metadata', async () => {
    settings.set('library.associations', { [B]: { single: 'D:/v/New.funscript' } });
    expect(refreshSpy).toHaveBeenCalledWith({ delayMs: 1500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(tagSends(backend)).toHaveLength(1);
  });

  it('a script saved from the editor is read again (once per burst of autosaves) and its new tags reach the phone', async () => {
    const asked = [];
    _setScriptMetaFetcherForTests(async (query) => {
      asked.push(query);
      return { records: { [A_SCRIPT]: { metadata: { tags: ['Edited'] }, readAt: 9 } }, pending: 0, registered: 2 };
    }, async () => {});
    eventBus.emit('funscript:saved', { path: A_SCRIPT });
    eventBus.emit('funscript:saved', { path: A_SCRIPT });   // autosave again
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toEqual([{ paths: [A_SCRIPT] }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(lastKeys(backend, A)).toEqual(['content:edited', 'content:favourite']);
  });

  it('a restarted backend gets the slice again', async () => {
    app._onBackendStatusForRegistry('restarting');
    app._onBackendStatusForRegistry('running');
    await vi.advanceTimersByTimeAsync(500);
    expect(tagSends(backend)).toHaveLength(1);
    expect(lastKeys(backend, A)).toEqual(['content:favourite']);
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('an unrelated setting sends no slice, and nothing is sent before a scan listed videos', async () => {
    settings.set('player.volume', 0.4);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tagSends(backend)).toHaveLength(0);

    app.library._videos = [];
    settings.set('library.userTags', { [A]: ['x'] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(tagSends(backend)).toHaveLength(0);
  });

  it('a failed send is retried with the CURRENT tags, never an older slice', async () => {
    backend.up = false;
    settings.set('library.userTags', { [A]: ['first'] });
    await vi.advanceTimersByTimeAsync(500);                    // fails, retry armed
    backend.up = true;
    settings.set('library.userTags', { [A]: ['second'] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(tagSends(backend)).toHaveLength(1);
    expect(lastKeys(backend, A)).toEqual(['content:second']);
  });

  it('search is not given the tags: no contextMap or search field is sent with them', async () => {
    settings.set('library.userTags', { [A]: ['pov'] });
    await vi.advanceTimersByTimeAsync(500);
    for (const r of backend.registers) {
      expect(r.videos).toBeUndefined();
      expect(JSON.stringify(r)).not.toMatch(/contextMap|search/i);
    }
  });
});
