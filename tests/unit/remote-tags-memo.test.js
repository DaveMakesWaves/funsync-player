// The phone's tag slice comes from the library's ONE memoised index and is
// sent only when it changed (r3-fixup R3R-6, 2026-11-18). Measured on a
// synthetic 6,000-video library, the old send ran the whole merge a second
// time (~110-150 ms) and posted the whole slice (2.3 MB) after every tag edit
// and on every step of a first harvest (every 2 s). These tests drive the
// REAL app.js methods (lifted), the REAL DataService, event bus,
// funscript-metadata store and LibraryTagIndex, and assert on what a fake
// backend receives.
//
// jsdom on purpose (no node docblock): DataService.set calls
// window.funsync.setSetting. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import {
  scriptMetaMap, scriptMetaVersion, onScriptMetaChanged, refreshScriptMeta, getScriptMeta,
  _resetScriptMetaStoreForTests, _setScriptMetaFetcherForTests,
} from '../../renderer/js/script-meta-store.js';
import {
  buildRemoteTagSlice, remoteTagSliceFromIndex, REMOTE_TAG_SETTING_PATHS,
} from '../../renderer/js/remote-tag-slice.js';
import { LibraryTagIndex } from '../../renderer/js/library-tag-filter.js';

const PORT = 5123;
const A = 'D:/v/Alpha Scene.mp4';
const A_SCRIPT = 'D:/v/Alpha Scene.funscript';
const B = 'D:/v/Bravo Scene.mp4';
const B_SCRIPT = 'D:/v/Bravo Scene.funscript';

function fakeBackend() {
  const backend = { posts: [], fail: false };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (String(url).endsWith('/api/media/register')) {
      const body = JSON.parse(opts.body);
      if (body.videoTags) backend.posts.push(body.videoTags);
    }
    if (backend.fail) return { ok: false, status: 503, json: async () => ({}) };
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

describe('the slice is the library index, sent when it changed', () => {
  const buildSpy = vi.fn((...args) => buildRemoteTagSlice(...args));
  const Lifted = liftAppClass(
    ['_wireGroupingsRegister', '_registerGroupingsEarly', '_wireRemoteTags', '_scheduleRemoteTags',
      '_registerRemoteTags', '_remoteTagsAfterRestart', '_onBackendStatusForRegistry'],
    {
      eventBus, scriptMetaMap, onScriptMetaChanged, refreshScriptMeta: vi.fn(), getScriptMeta,
      buildRemoteTagSlice: buildSpy, remoteTagSliceFromIndex, REMOTE_TAG_SETTING_PATHS,
    },
  );
  let backend;
  let settings;
  let app;
  let memo;
  let savedHandlers;
  let metaAnswer;

  beforeEach(() => {
    vi.useFakeTimers();
    savedHandlers = eventBus._handlers;
    eventBus._handlers = new Map();
    _resetScriptMetaStoreForTests();
    metaAnswer = {};
    _setScriptMetaFetcherForTests(async (query) => {
      const path = query?.paths?.[0];
      return { records: path && metaAnswer[path] ? { [path]: metaAnswer[path] } : {}, pending: 0, registered: 2 };
    }, async () => {});
    buildSpy.mockClear();
    backend = fakeBackend();
    window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
    settings = realDataService();
    app = new Lifted();
    app.backendPort = PORT;
    app.settings = settings;
    const videos = [
      { path: A, name: 'Alpha Scene.mp4', funscriptPath: A_SCRIPT },
      { path: B, name: 'Bravo Scene.mp4', funscriptPath: B_SCRIPT },
    ];
    memo = new LibraryTagIndex({
      settings: () => settings, videos: () => videos, scriptMeta: () => scriptMetaMap(), scriptMetaVersion: () => scriptMetaVersion(),
    });
    app.library = { _videos: videos, _registerWithBackend: vi.fn(), _tagIndexMemo: () => memo };
    app._wireGroupingsRegister();
  });

  afterEach(() => {
    vi.useRealTimers();
    eventBus._handlers = savedHandlers;
    _resetScriptMetaStoreForTests();
    delete globalThis.fetch;
    delete window.funsync;
  });

  /** A harvest step: one script's record arrives (as each poll of a first pass does). */
  async function harvestStep(path, tags) {
    metaAnswer[path] = { metadata: { tags }, readAt: Date.now() };
    await getScriptMeta(path);
  }

  it('reads the library index the Tags filter reads: no second merge', async () => {
    memo.get();                                   // the library rendered: built once
    settings.set('library.userTags', { [A]: ['favourite', 'pov'] });
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(1);
    expect(buildSpy).not.toHaveBeenCalled();
    expect(memo.builds).toBe(2);                  // the edit's rebuild, shared by the send and the library
    expect(backend.posts[0]).toEqual(remoteTagSliceFromIndex(memo.get().index));
    expect(backend.posts[0][A].map((t) => t.key)).toEqual(['content:favourite', 'content:pov']);
  });

  it('nothing changed, nothing sent: the same index, or a rebuild that gives the same tags', async () => {
    settings.set('library.userTags', { [A]: ['favourite', 'pov'] });
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(1);

    app._scheduleRemoteTags();                    // the same index object
    await vi.advanceTimersByTimeAsync(500);
    settings.set('library.userTags', { [A]: ['favourite', 'pov'] });   // a new map, the same tags
    await vi.advanceTimersByTimeAsync(500);
    settings.set('library.scriptTags', {});       // a change no video's tags see
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(1);

    settings.set('library.userTags', { [A]: ['favourite'] });          // a real change
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(2);
  });

  it('a harvest arriving in steps is sent once per 10 s, not once per step, and ends up complete', async () => {
    await harvestStep(A_SCRIPT, ['step-one']);
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(1);        // the first one goes out at once
    for (const tag of ['step-two', 'step-three', 'step-four', 'step-five']) {
      await vi.advanceTimersByTimeAsync(2000);
      await harvestStep(B_SCRIPT, [tag]);
    }
    expect(backend.posts).toHaveLength(1);        // 8.5 s later: still one
    await vi.advanceTimersByTimeAsync(2500);
    expect(backend.posts).toHaveLength(2);
    expect(backend.posts[1][B].map((t) => t.key)).toEqual(['content:step-five']);
    expect(backend.posts[1][A].map((t) => t.key)).toEqual(['content:favourite', 'content:step-one']);

    // A tag you add meanwhile does not wait for the harvest's 10 s.
    await harvestStep(B_SCRIPT, ['step-six']);
    settings.set('library.userTags', { [A]: ['favourite', 'mine'] });
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(3);
    expect(backend.posts[2][B].map((t) => t.key)).toEqual(['content:step-six']);
  });

  it('a restarted backend gets the slice again, unchanged as it is', async () => {
    settings.set('library.userTags', { [A]: ['favourite', 'pov'] });
    await vi.advanceTimersByTimeAsync(500);
    app._onBackendStatusForRegistry('restarting');
    app._onBackendStatusForRegistry('running');
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(2);
    expect(backend.posts[1]).toEqual(backend.posts[0]);
  });

  it('a send that failed is sent again (the retry, and the next change)', async () => {
    backend.fail = true;
    settings.set('library.userTags', { [A]: ['favourite', 'pov'] });
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.posts).toHaveLength(1);
    backend.fail = false;
    await vi.advanceTimersByTimeAsync(2100);      // the retry
    expect(backend.posts).toHaveLength(2);
    expect(backend.posts[1]).toEqual(backend.posts[0]);
  });
});
