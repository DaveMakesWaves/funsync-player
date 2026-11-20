/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The renderer's Stash copy after a change (Stash fix-up 2026-11-19,
// s1-review-a RA-S1-7, with RA-S1-1 and RA-S1-3's store parts):
//   - one dialog change reads main's data ONCE: main reports {rev} before it
//     answers (ordered IPC), and that report's read is the change's read;
//   - the same rev again is the same data: no read, no re-index, and no
//     JSON.stringify of megabytes to find out;
//   - a report that comes while a read runs asks again only for a newer rev;
//   - "Not this scene…" and Unlink carry the scene the dialog named;
//   - a full sync's re-links are kept for this session with their Undo
//     token (Settings lists them), the start-up sync's included.
// Driven through a fake window.funsync that behaves as Electron main does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STASH_API, stashData, stashVersion, initStashStore, reloadStash, onStashChanged,
  refuseStashScene, unlinkStashVideo, chooseStashScene, syncStash, stashSyncOnStart,
  stashRelinks, noteStashRelinks, forgetStashRelinks, onStashRelinksChanged, MAX_STASH_RELINKS,
  _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';

const V = 'C:\\Lib\\Alpha Scene.mp4';
const W = 'C:\\Lib\\Bravo Scene.mp4';

function projection(rev, links = { [V]: '1' }) {
  return {
    v: 1, rev, server: { url: 'http://127.0.0.1:9999', version: 'v0.32.0' }, lastSync: null,
    links: Object.fromEntries(Object.entries(links).map(([p, id]) => [p, { sceneId: id, server: 'http://127.0.0.1:9999', by: 'oshash', fp: { size: 10, oshash: 'aa' }, linkedAt: 1, state: 'ok' }])),
    check: {}, refused: {},
    scenes: { 1: { id: '1', title: 'One', tagIds: [], performerIds: [], markers: [], files: [] } },
    performers: {}, studios: {}, tags: {},
  };
}

/**
 * A fake main: every change writes (rev + 1), REPORTS {rev} to the renderer
 * and then answers, as electron/stash-library-file.js update() + the IPC do;
 * the report and the reply each reach the renderer as their own task, and a
 * read of the data takes a few ms in transit (a big answer from another
 * process). `replyFirst` answers before the report instead.
 */
const task = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeMain({ replyFirst = false } = {}) {
  const main = { data: projection(1), reads: 0, calls: [], changed: null, replyFirst, readGate: null };
  const write = (mutate) => {
    const next = structuredClone(main.data);
    mutate(next);
    next.rev = main.data.rev + 1;
    main.data = next;
  };
  const change = (name, mutate, extra = {}) => async (input) => {
    main.calls.push([name, input]);
    write(mutate);
    const rev = main.data.rev;
    const reply = { ok: true, undoId: `undo-${main.calls.length}`, ...extra };
    if (main.replyFirst) {
      setTimeout(() => main.changed?.({ rev }), 6);
      return reply;
    }
    setTimeout(() => main.changed?.({ rev }), 0);
    await task(1);
    return reply;
  };
  const api = {
    [STASH_API.data]: vi.fn(async () => {
      main.reads += 1;
      const snapshot = structuredClone(main.data);
      if (main.readGate) await main.readGate;
      else await task(3);
      return snapshot;
    }),
    [STASH_API.onChanged]: vi.fn((cb) => { main.changed = cb; return () => { main.changed = null; }; }),
    [STASH_API.unlink]: change('unlink', (d) => { delete d.links[V]; }),
    [STASH_API.refuse]: change('refuse', (d) => { delete d.links[V]; d.refused[V] = { oshash: 'aa', sceneIds: ['1'], at: 1 }; }),
    [STASH_API.choose]: vi.fn(async (input) => { main.calls.push(['choose', input]); return { ok: true, undoId: 'u-noop' }; }), // wrote nothing: no report
    [STASH_API.sync]: vi.fn(async (input) => { main.calls.push(['sync', input]); return main.syncReply; }),
    [STASH_API.syncOnStart]: vi.fn(async (input) => { main.calls.push(['syncOnStart', input]); return main.syncReply; }),
  };
  _setStashApiForTests(api);
  return main;
}

/** Let every report, reply and read on its way arrive. */
const settle = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => { _resetStashStoreForTests(); });
afterEach(() => { _resetStashStoreForTests(); vi.restoreAllMocks(); });

describe('one change, one read (RA-S1-7)', () => {
  it('a dialog change (Unlink): main reports {rev} first; the store reads its data once', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    expect(main.reads).toBe(1);
    const heard = vi.fn();
    onStashChanged(heard);
    const reply = await unlinkStashVideo(V);
    expect(reply.ok).toBe(true);
    await settle();
    expect(main.reads).toBe(2); // the start-up read + ONE for the change
    expect(stashData().links).toEqual({});
    expect(stashData().rev).toBe(2);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(stashVersion()).toBe(2);
  });

  it('main answering before it reports: still one read', async () => {
    const main = fakeMain({ replyFirst: true });
    await initStashStore({ isEnabled: () => true });
    await refuseStashScene(V, 'link');
    await settle();
    await settle();
    expect(main.reads).toBe(2);
    expect(stashData().refused[V].sceneIds).toEqual(['1']);
  });

  it('a report of the rev the copy already has asks nothing', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    main.changed({ rev: 1 });
    await settle();
    expect(main.reads).toBe(1);
  });

  it('the same rev again is the same data: not applied, and never compared by JSON.stringify', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    const spy = vi.spyOn(JSON, 'stringify');
    expect(await reloadStash()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(stashVersion()).toBe(1);
    expect(main.reads).toBe(2);
  });

  it('a report during a read: asked again only when that read was older than the report', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    // A read is on its way and returns rev 1; main writes rev 2 meanwhile.
    let open;
    main.readGate = new Promise((r) => { open = r; });
    const first = reloadStash();
    main.data = { ...projection(2), links: {} };
    main.changed({ rev: 2 });
    main.readGate = null;
    open();
    await first;
    await settle();
    expect(main.reads).toBe(3); // the stale read, then one more for rev 2
    expect(stashData().rev).toBe(2);
    // A read that already returns the reported rev: no more.
    main.readGate = new Promise((r) => { open = r; });
    main.data = projection(3);
    const second = reloadStash();
    main.changed({ rev: 3 });
    main.readGate = null;
    open();
    await second;
    await settle();
    expect(main.reads).toBe(4);
    expect(stashData().rev).toBe(3);
  });

  it('a change main did not write (no report): one read, nothing re-indexed', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    await chooseStashScene(V, '1');
    expect(main.reads).toBe(2);
    expect(stashVersion()).toBe(1);
  });
});

describe('the scene the dialog named goes with the request (RA-S1-3)', () => {
  it('Not this scene… sends {path, target, sceneId}; without one, exactly {path, target}', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    await refuseStashScene(V, 'link', '12@abc');
    await refuseStashScene(V, 'check');
    expect(main.calls.filter(([n]) => n === 'refuse').map(([, input]) => input)).toEqual([
      { path: V, target: 'link', sceneId: '12@abc' },
      { path: V, target: 'check' },
    ]);
  });

  it('Unlink sends {path, sceneId}; without one, exactly {path}', async () => {
    const main = fakeMain();
    await initStashStore({ isEnabled: () => true });
    await unlinkStashVideo(V, '1');
    main.data = projection(main.data.rev, { [V]: '1' });
    await unlinkStashVideo(V);
    expect(main.calls.filter(([n]) => n === 'unlink').map(([, input]) => input)).toEqual([{ path: V, sceneId: '1' }, { path: V }]);
  });
});

describe('this session\'s re-links (RA-S1-1)', () => {
  const relink = (path, undoId, to = '2') => ({ path, from: '1', to, undoId });

  it('the start-up sync\'s reply is kept: its re-links, each with main\'s Undo token', async () => {
    const main = fakeMain();
    main.syncReply = { ok: true, kind: 'full', started: true, relinked: [relink(V, 'u-1'), relink(W, 'u-2', '7')] };
    await initStashStore({ isEnabled: () => true, isSyncOnStart: () => true });
    const heard = vi.fn();
    onStashRelinksChanged(heard);
    const reply = await stashSyncOnStart([{ path: V, size: 10, dateAdded: 5 }]);
    expect(reply.started).toBe(true);
    expect(stashRelinks().map(({ path, from, to, undoId }) => ({ path, from, to, undoId }))).toEqual([
      { path: V, from: '1', to: '2', undoId: 'u-1' },
      { path: W, from: '1', to: '7', undoId: 'u-2' },
    ]);
    expect(Object.isFrozen(stashRelinks())).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('Sync now through the store keeps them too; a start-up sync that did not run keeps nothing', async () => {
    const main = fakeMain();
    main.syncReply = { ok: true, kind: 'full', relinked: [relink(V, 'u-1')] };
    await initStashStore({ isEnabled: () => true, isSyncOnStart: () => false });
    expect(stashSyncOnStart([{ path: V }])).toBeNull();
    expect(stashRelinks()).toEqual([]);
    await syncStash({ videos: [{ path: V }] });
    expect(stashRelinks().map((r) => r.undoId)).toEqual(['u-1']);
  });

  it('entries without a token or a path are left out; the same token twice is kept once; the newest per video wins', () => {
    expect(noteStashRelinks({ relinked: [relink(V, ''), { to: '2', undoId: 'u-x' }, null, relink(V, 'u-1')] }).map((r) => r.undoId)).toEqual(['u-1']);
    noteStashRelinks({ relinked: [relink(V, 'u-1')] });
    expect(stashRelinks().map((r) => r.undoId)).toEqual(['u-1']);
    noteStashRelinks({ relinked: [relink(V, 'u-9', '3')] });
    expect(stashRelinks().map((r) => r.undoId)).toEqual(['u-9']);
    expect(noteStashRelinks(null)).toEqual([]);
    expect(noteStashRelinks({ ok: false, code: 'unavailable' })).toEqual([]);
  });

  it('forget drops by token; the list is capped at the newest MAX_STASH_RELINKS', () => {
    noteStashRelinks({ relinked: [relink(V, 'u-1'), relink(W, 'u-2')] });
    forgetStashRelinks(['u-1']);
    expect(stashRelinks().map((r) => r.undoId)).toEqual(['u-2']);
    const many = Array.from({ length: MAX_STASH_RELINKS + 5 }, (_, i) => relink(`C:\\Lib\\v${i}.mp4`, `t-${i}`));
    noteStashRelinks({ relinked: many });
    expect(stashRelinks()).toHaveLength(MAX_STASH_RELINKS);
    expect(stashRelinks().at(-1).undoId).toBe(`t-${MAX_STASH_RELINKS + 4}`);
  });
});
