/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The renderer's copy of the Stash data (Stash S1, Round 2 stage 2d;
// DESIGN-stash-s1.md (c) "The renderer's copy and the stash tag source",
// (a) step 8 "When it syncs", (e)). Driven through a fake `window.funsync`
// that records every call, so each test asserts what main was asked and what
// the renderer's copy holds afterwards.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STASH_API, stashData, stashVersion, onStashChanged, stashLoaded, initStashStore,
  reloadStash, stashSyncOnStart, stashSyncVideos, isStashProjection,
  syncStash, syncStashVideo, chooseStashScene, refuseStashScene, unlinkStashVideo,
  undoStash, rehomeStash, linkStashScene, removeStashData, openStashScene, searchStash,
  onStashSettingsChanged, onStashProgress,
  _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import fs from 'node:fs';

const V = 'C:\\Lib\\Alpha Scene.mp4';

function projection(rev, extra = {}) {
  return {
    v: 1, rev, server: { url: 'http://127.0.0.1:9999', version: 'v0.32.0' }, lastSync: null,
    links: { [V]: { sceneId: '1', server: 'http://127.0.0.1:9999', by: 'oshash', fp: { size: 10, mtimeMs: 1, oshash: 'aa' }, linkedAt: 1, state: 'ok' } },
    check: {}, refused: {},
    scenes: { 1: { id: '1', title: 'Synthetic Scene', tagIds: ['5'], performerIds: [], markers: [], files: [] } },
    performers: {}, studios: {}, tags: { 5: { id: '5', name: 'POV' } },
    ...extra,
  };
}

/** A fake main: records every call by its preload name. */
function fakeMain({ data = projection(1), replies = {} } = {}) {
  const main = { calls: [], data, changed: null, progress: null };
  const api = {};
  for (const name of Object.values(STASH_API)) {
    api[name] = vi.fn(async (...args) => {
      main.calls.push([name, ...args]);
      if (name === STASH_API.data) {
        if (main.data instanceof Error) throw main.data;
        return main.data;
      }
      if (name === STASH_API.onChanged) { main.changed = args[0]; return () => { main.changed = null; }; }
      if (name in replies) return typeof replies[name] === 'function' ? replies[name](...args) : replies[name];
      return { ok: true };
    });
  }
  // The two subscriptions answer synchronously, as ipcRenderer.on does.
  api[STASH_API.onChanged] = vi.fn((cb) => { main.calls.push([STASH_API.onChanged]); main.changed = cb; return () => { main.changed = null; }; });
  api[STASH_API.onProgress] = vi.fn((cb) => { main.progress = cb; return () => { main.progress = null; }; });
  api[STASH_API.onSettingsChanged] = vi.fn((cb) => { main.settings = cb; return () => { main.settings = null; }; });
  _setStashApiForTests(api);
  return main;
}

const names = (main) => main.calls.map(([n]) => n);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { _resetStashStoreForTests(); });
afterEach(() => { _resetStashStoreForTests(); });

describe('before anything is loaded', () => {
  it('the copy is an empty frozen projection, never null, version 0', () => {
    const d = stashData();
    expect(d).toMatchObject({ links: {}, check: {}, refused: {}, scenes: {}, performers: {}, studios: {}, tags: {} });
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.links)).toBe(true);
    expect(stashVersion()).toBe(0);
    expect(stashLoaded()).toBe(false);
  });
});

describe('start-up: loaded only when Stash is on, and never a sync on its own', () => {
  it('off (the default): nothing is asked of main, not even the data', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => false, isSyncOnStart: () => true });
    expect(names(main)).toEqual([STASH_API.onChanged]);
    expect(stashVersion()).toBe(0);
  });

  it('on: the projection is read once, frozen deep, the version bumps and listeners hear it', async () => {
    const main = fakeMain();
    const heard = vi.fn();
    onStashChanged(heard);
    const changed = await initStashStore({ isEnabled: () => true });
    expect(changed).toBe(true);
    expect(names(main)).toEqual([STASH_API.onChanged, STASH_API.data]);
    expect(stashData().links[V].sceneId).toBe('1');
    expect(Object.isFrozen(stashData().links[V].fp)).toBe(true);
    expect(stashVersion()).toBe(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a second init in the same window does nothing more', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    await initStashStore({ isEnabled: () => true });
    expect(names(main).filter((n) => n === STASH_API.data)).toHaveLength(1);
  });

  it('Never on its own: on, syncOnStart off: the first scan asks main for no sync, nothing but the data', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true, isSyncOnStart: () => false });
    expect(stashSyncOnStart([{ path: V, size: 10, dateAdded: 5 }])).toBeNull();
    await settle();
    expect(names(main)).toEqual([STASH_API.onChanged, STASH_API.data]);
  });

  it('syncOnStart on: main is asked once, after the first scan only, with path, size and modified time', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true, isSyncOnStart: () => true });
    const run = stashSyncOnStart([{ path: V, size: 10, dateAdded: 5, name: 'x', funscriptPath: 'y' }]);
    expect(run).not.toBeNull();
    await run;
    expect(stashSyncOnStart([{ path: V, size: 10, dateAdded: 5 }])).toBeNull();
    const asks = main.calls.filter(([n]) => n === STASH_API.syncOnStart);
    expect(asks).toEqual([[STASH_API.syncOnStart, { videos: [{ path: V, size: 10, mtimeMs: 5 }] }]]);
    expect(names(main)).not.toContain(STASH_API.sync);
  });

  it('an empty first list (no source yet) asks nothing and keeps the one ask for a real scan', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true, isSyncOnStart: () => true });
    expect(stashSyncOnStart([])).toBeNull();
    expect(stashSyncOnStart([{ path: V }])).not.toBeNull();
    expect(main.calls.filter(([n]) => n === STASH_API.syncOnStart)).toHaveLength(1);
  });

  it('syncOnStart on but Stash off: no sync', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => false, isSyncOnStart: () => true });
    expect(stashSyncOnStart([{ path: V }])).toBeNull();
    expect(names(main)).not.toContain(STASH_API.syncOnStart);
    expect(names(main)).not.toContain(STASH_API.sync);
  });

  it('syncOnStart must be exactly true', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true, isSyncOnStart: () => 'yes' });
    expect(stashSyncOnStart([{ path: V }])).toBeNull();
    expect(names(main)).not.toContain(STASH_API.syncOnStart);
  });
});

describe('turning Stash on and off', () => {
  it('the first turn-on of a session loads the copy at once, with no sync', async () => {
    let on = false;
    const main = fakeMain();
    await initStashStore({ isEnabled: () => on });
    on = true;
    eventBus.emit('settings:changed', { path: 'stash.enabled', value: true });
    await settle();
    expect(names(main)).toEqual([STASH_API.onChanged, STASH_API.data]);
    expect(stashData().links[V]).toBeTruthy();
  });

  it('turning off keeps the copy (the views read the switch); on again asks nothing', async () => {
    let on = true;
    const main = fakeMain();
    await initStashStore({ isEnabled: () => on });
    on = false;
    eventBus.emit('settings:changed', { path: 'stash.enabled', value: false });
    on = true;
    eventBus.emit('settings:changed', { path: 'stash.enabled', value: true });
    await settle();
    expect(stashData().links[V]).toBeTruthy();
    expect(names(main).filter((n) => n === STASH_API.data)).toHaveLength(1);
  });
});

describe('main reports a change', () => {
  it('a report carrying the projection replaces the copy without another ask', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    main.changed({ data: projection(2, { links: {} }) });
    expect(stashData().links).toEqual({});
    expect(stashVersion()).toBe(2);
    expect(names(main).filter((n) => n === STASH_API.data)).toHaveLength(1);
  });

  it('main reports {rev}: the store reads the data again', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    main.data = projection(3, { tags: { 5: { id: '5', name: 'POV' }, 6: { id: '6', name: 'Outdoor' } } });
    main.changed({ rev: 3 });
    await settle();
    expect(stashData().tags[6].name).toBe('Outdoor');
    expect(stashVersion()).toBe(2);
  });

  it('the same projection again does not bump the version (no re-index for nothing)', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    main.changed({ data: projection(1) });
    expect(stashVersion()).toBe(1);
  });
});

describe('absence is never destructive', () => {
  it('a failed read keeps the copy', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    const before = stashData();
    main.data = new Error('main is busy');
    expect(await reloadStash()).toBe(false);
    expect(stashData()).toBe(before);
    expect(stashVersion()).toBe(1);
  });

  it('a malformed answer (null, an error reply, a list) keeps the copy', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    const before = stashData();
    for (const bad of [null, { ok: false, error: { code: 'damaged' } }, [], { links: [] }]) {
      main.data = bad;
      await reloadStash();
    }
    expect(stashData()).toBe(before);
    expect(isStashProjection({ links: [] })).toBe(false);
  });

  it('a refused change keeps the copy and asks for nothing', async () => {
    const main = fakeMain({ replies: { [STASH_API.unlink]: { ok: false, code: 'busy' } } });
    await initStashStore({ isEnabled: () => true });
    const before = stashData();
    const reply = await unlinkStashVideo(V);
    expect(reply).toEqual({ ok: false, code: 'busy' });
    expect(stashData()).toBe(before);
    expect(names(main).filter((n) => n === STASH_API.data)).toHaveLength(1);
  });

  it('no preload call (an older main): an "unavailable" answer, nothing thrown, nothing changed', async () => {
    _setStashApiForTests({});
    await initStashStore({ isEnabled: () => true });
    expect(await chooseStashScene(V, '2')).toEqual({ ok: false, code: 'unavailable' });
    expect(stashVersion()).toBe(0);
  });
});

describe('the changes go to main, and main\'s new data comes back', () => {
  it('a reply carrying the projection replaces the copy at once', async () => {
    const after = projection(4, { links: {}, refused: { [V]: { oshash: 'aa', sceneIds: ['1'], at: 9 } } });
    const main = fakeMain({ replies: { [STASH_API.refuse]: { ok: true, undoId: 'u7', data: after } } });
    await initStashStore({ isEnabled: () => true });
    const reply = await refuseStashScene(V, 'link');
    expect(main.calls.find(([n]) => n === STASH_API.refuse)).toEqual([STASH_API.refuse, { path: V, target: 'link' }]);
    expect(reply.undoId).toBe('u7');
    expect(stashData().refused[V].sceneIds).toEqual(['1']);
    expect(stashData().links).toEqual({});
  });

  it('a reply without it makes the store read main\'s data again', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    main.data = projection(5, { links: {} });
    await chooseStashScene(V, '2');
    expect(stashData().links).toEqual({});
    expect(names(main).filter((n) => n === STASH_API.data)).toHaveLength(2);
  });

  it('each call passes its arguments as given', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    await undoStash('u1');
    await rehomeStash([{ from: 'a', to: 'b', keepSource: false }]);
    await linkStashScene(V, '9');
    await chooseStashScene(V, '12@http://192.168.1.20:9999');
    await unlinkStashVideo(V);
    await openStashScene(V);
    await openStashScene(V, '9');
    await searchStash('synthetic');
    await removeStashData();
    await syncStashVideo({ path: V, size: 10, dateAdded: 3, name: 'n' });
    await syncStash({ videos: [{ path: V, size: 10, dateAdded: 3 }, { path: '' }, null] });
    const sent = main.calls.filter(([n]) => n !== STASH_API.data && n !== STASH_API.onChanged);
    expect(sent).toEqual([
      [STASH_API.undo, 'u1'],
      [STASH_API.rehome, [{ from: 'a', to: 'b', keepSource: false }]],
      [STASH_API.linkScene, { path: V, sceneId: '9' }],
      [STASH_API.choose, { path: V, sceneId: '12@http://192.168.1.20:9999' }],
      [STASH_API.unlink, { path: V }],
      [STASH_API.openScene, { path: V }],
      [STASH_API.openScene, { path: V, sceneId: '9' }],
      [STASH_API.search, { q: 'synthetic' }],
      [STASH_API.remove],
      [STASH_API.syncVideo, { path: V, size: 10, mtimeMs: 3 }],
      [STASH_API.sync, { videos: [{ path: V, size: 10, mtimeMs: 3 }] }],
    ]);
  });

  it('the sync list carries only path, size and modified time (no names, no scripts)', () => {
    expect(stashSyncVideos([{ path: V, size: 1, dateAdded: 2, name: 'n', funscriptPath: 'f', duration: 9 }, { path: 'x' }]))
      .toEqual([{ path: V, size: 1, mtimeMs: 2 }, { path: 'x' }]);
  });
});

describe('the preload names are stage s1-2a-main\'s', () => {
  it('one name per call, as main.js / preload.js expose them', () => {
    expect(STASH_API).toMatchObject({
      data: 'stashGetData', onChanged: 'onStashChanged', onSettingsChanged: 'onStashSettingsChanged',
      sync: 'stashSync', syncOnStart: 'stashSyncOnStart', syncVideo: 'stashSyncVideo',
      choose: 'stashChoose', refuse: 'stashRefuse', unlink: 'stashUnlink', linkScene: 'stashLinkScene',
      undo: 'stashUndo', rehome: 'stashRehome', search: 'stashSearch', remove: 'stashRemoveData',
      openScene: 'stashOpenScene', onProgress: 'onStashProgress',
    });
  });

  it('the subscriptions hand back an unsubscribe, and nothing breaks without them', () => {
    const main = fakeMain();
    const seen = [];
    const off = onStashProgress((p) => seen.push(p));
    main.progress({ kind: 'full', step: 'hash', done: 1, total: 2 });
    off();
    expect(main.progress).toBeNull();
    expect(seen).toEqual([{ kind: 'full', step: 'hash', done: 1, total: 2 }]);
    const offSettings = onStashSettingsChanged(() => {});
    expect(typeof offSettings).toBe('function');
    _setStashApiForTests({});
    expect(typeof onStashProgress(() => {})).toBe('function');
  });
});

describe('every call the store makes exists in the real preload', () => {
  // A renamed or missing preload entry would make the store answer
  // "unavailable" for ever, silently: pinned here against the source.
  const preload = fs.readFileSync('electron/preload.js', 'utf8');
  for (const [call, name] of Object.entries(STASH_API)) {
    it(`${call}: window.funsync.${name}`, () => {
      expect(preload).toMatch(new RegExp(`\\b${name}: \\(`));
    });
  }
});
