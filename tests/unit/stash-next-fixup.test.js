/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash "next" lot, stage sn-fixup (2026-11-19): the review's main-side
// findings (SCRATCH/report-sn-review.json). The sync job, the data file,
// the matcher and the mapper are the real ones; the client is an in-memory
// fake with the local test Stash's scenes and tags (sn-* fixtures); the
// Group playlists are read through the renderer's own stash-groups.js.
//
// Guards checked by reopening their hole (SCRATCH/sn-fixup/holes.jsonl):
//   - SN-R2: Cancel pressed while the tag list is read (or while the write
//     waits its turn) is a Cancel: not ok, cancelled, partial, and nothing
//     a complete sync removes is removed (hole: the old fullSync / writeResult)
//   - SN-R3: unlink, "Not this scene" and Undo rebuild the Groups, so a
//     just-unlinked scene leaves its Group playlist at once (hole: no
//     refreshGroups there)
//   - SN-R4: an import (merge) never brings back a Group a complete sync
//     removed (hole: the backup's `groups` taken as a union)
//   - the review's note: one tag whose name FunSync cannot use is skipped;
//     the tag list stays complete and the tree is stored (hole: it counted
//     as dropped)
//   - SN-R5: the tag rules are built once per stored tag tree, not on every
//     projection rebuild (hole: no memo)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { snFixtureScenes, snFixtureTags, lightScene } from '../helpers/fake-stash-server.js';
import { stashGroupPlaylists } from '../../renderer/js/stash-groups.js';

const require_ = createRequire(import.meta.url);
const { createStashLibraryFile, mergeLibraryData } = require_('../../electron/stash-library-file.js');
const { createStashSync } = require_('../../electron/stash-sync.js');
const { matchLibrary } = require_('../../electron/stash-match.js');
const { mapScene } = require_('../../electron/stash-map.js');

const SERVER = { url: 'http://127.0.0.1:9999', version: 'v0.32.0' };
const T0 = new Date(2026, 10, 19, 10, 0, 0).getTime();
const HOUR = 3600 * 1000;
const quiet = { warn() {}, info() {} };
const vid = (id) => `C:\\lib\\scene ${id}.mp4`;

const dirs = [];
async function newDir() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-sn-fixup-'));
  dirs.push(d);
  return d;
}
beforeEach(() => { dirs.length = 0; });
afterEach(async () => { for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }); });

/** The fake Stash: the test Stash's scenes and tags in memory, with hooks. */
function fakeStash() {
  const s = { scenes: new Map(snFixtureScenes().map((x) => [x.id, x])), tags: snFixtureTags(), onTags: null };
  const sorted = () => [...s.scenes.values()].sort((a, b) => Number(a.id) - Number(b.id));
  s.client = {
    async listScenes({ page, perPage }) {
      const all = sorted();
      return { count: all.length, scenes: all.slice((page - 1) * perPage, page * perPage).map(lightScene) };
    },
    async sceneDetails(ids) {
      const out = {};
      for (const id of ids) out[id] = s.scenes.has(id) ? structuredClone(s.scenes.get(id)) : null;
      return out;
    },
    async scenesByOshash(h) {
      const hits = sorted().filter((x) => x.files.some((f) => f.oshash === h)).map(lightScene);
      return { count: hits.length, scenes: hits };
    },
    async listTags({ page, perPage, signal }) {
      if (s.onTags) await s.onTags();
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'cancelled' });
      const all = [...s.tags].sort((a, b) => Number(a.id) - Number(b.id));
      return { count: all.length, tags: all.slice((page - 1) * perPage, page * perPage) };
    },
  };
  return s;
}

/**
 * A data file and a sync job over the fake Stash for the videos of `ids`.
 * `wrapLibrary(library, sync)` may hand the job a wrapped library.
 */
async function setup({ ids = [1, 2, 3, 4], start = T0, stash = fakeStash(), log = quiet, wrapLibrary = null } = {}) {
  let now = start;
  const library = createStashLibraryFile({ dir: await newDir(), now: () => now, log: quiet });
  await library.load();
  const fps = new Map();
  for (const id of [1, 2, 3, 4]) {
    const f = stash.scenes.get(String(id)).files[0];
    fps.set(vid(id), { size: f.size, mtimeMs: 1000 + id, oshash: f.oshash });
  }
  const box = {};
  const sync = createStashSync({
    library: wrapLibrary ? wrapLibrary(library, box) : library,
    client: stash.client,
    fingerprint: async (v) => (fps.has(v.path) ? { ...fps.get(v.path) } : null),
    match: (input) => matchLibrary({ ...input, server: SERVER.url, now }),
    mapScene: (raw) => mapScene(raw, { now }),
    now: () => now,
    log,
  });
  box.sync = sync;
  const run = (list = ids) => sync.run({ videos: list.map((id) => ({ path: vid(id) })), server: SERVER, pathRules: [] });
  const videos = [1, 2, 3, 4].map((id) => ({ path: vid(id), size: fps.get(vid(id)).size }));
  const playlists = () => stashGroupPlaylists(library.projection(), { enabled: true, videos });
  const group = (name) => playlists().find((g) => g.name === name);
  return { library, stash, sync, run, videos, playlists, group, setNow: (t) => { now = t; } };
}

/** In Stash: Group B is deleted (scenes 1 and 4 leave it; their updated_at moves). */
function deleteGroupB(stash) {
  stash.scenes.get('1').groups = stash.scenes.get('1').groups.filter((g) => g.group.id !== '2');
  stash.scenes.get('4').groups = [];
  stash.scenes.get('1').updated_at = '2026-11-20T08:00:00Z';
  stash.scenes.get('4').updated_at = '2026-11-20T08:00:00Z';
}

describe('SN-R2: Cancel during the tag-list step, or while the write waits, is a Cancel', () => {
  it('control: without a Cancel the complete sync removes Group B (gone in Stash)', async () => {
    const { library, stash, run } = await setup();
    await run();
    deleteGroupB(stash);
    const res = await run();
    expect(res).toMatchObject({ ok: true, cancelled: false, partial: false });
    expect(library.projection().groups['2']).toBeUndefined();
  });

  it('Cancel while the tag list is read: not ok, cancelled, partial; Group B and the stored tag tree are kept', async () => {
    const { library, stash, sync, run } = await setup();
    await run();
    const treeBefore = library.snapshot().tagTrees;
    deleteGroupB(stash);
    stash.tags = stash.tags.filter((t) => t.id !== '6'); // a tag deleted too: a complete list would replace the tree
    stash.onTags = async () => { sync.cancel(); };
    const res = await run();
    expect({ ok: res.ok, cancelled: res.cancelled, partial: res.partial, written: res.written })
      .toEqual({ ok: false, cancelled: true, partial: true, written: true });
    const snap = library.snapshot();
    expect(snap.lastSync).toMatchObject({ ok: false, partial: true, error: 'cancelled' });
    expect(library.projection().groups['2']).toMatchObject({ name: 'Synthetic Series B' });
    expect(snap.tagTrees).toEqual(treeBefore);
    // What finished is written: scene 1's new data is stored.
    expect(library.projection().scenes['1'].groups.map((g) => g.groupId)).toEqual(['1']);
  });

  it('Cancel while the write waits its turn: the same (nothing a complete sync removes goes)', async () => {
    const wrapLibrary = (library, box) => ({
      ...library,
      applySync: (mutator) => { box.sync.cancel(); return library.applySync(mutator); },
    });
    const { library, stash, run } = await setup({ wrapLibrary });
    await library.applySync(() => ({})); // the data file exists
    // First a real sync through the unwrapped library.
    const plain = await setup({ stash });
    await plain.run();
    const backup = plain.library.snapshot();
    await library.replaceImported(backup);
    deleteGroupB(stash);
    const res = await run();
    expect({ ok: res.ok, cancelled: res.cancelled, partial: res.partial }).toEqual({ ok: false, cancelled: true, partial: true });
    expect(library.snapshot().lastSync).toMatchObject({ ok: false, partial: true, error: 'cancelled' });
    expect(library.projection().groups['2']).toMatchObject({ name: 'Synthetic Series B' });
  });
});

describe('SN-R3: unlink, "Not this scene" and Undo rebuild the Groups at once', () => {
  it('unlink: the scene leaves its Group playlist (no "missing" entry); Undo puts it back in Stash\'s order', async () => {
    const { library, run, group } = await setup();
    await run();
    expect(group('Synthetic Series A').entries.map((e) => e.sceneId)).toEqual(['2', '3', '1']);
    const r = await library.unlink(vid(3));
    expect(r.ok).toBe(true);
    const a = group('Synthetic Series A');
    expect(a.entries.map((e) => [e.sceneId, e.path])).toEqual([['2', vid(2)], ['1', vid(1)]]);
    expect(a.missing).toBe(0);
    expect((await library.restore(r.undo)).ok).toBe(true);
    expect(group('Synthetic Series A').entries.map((e) => [e.sceneId, e.path])).toEqual([['2', vid(2)], ['3', vid(3)], ['1', vid(1)]]);
  });

  it('"Not this scene": the refused scene leaves its Group at once', async () => {
    const { library, run, group } = await setup();
    await run();
    expect(group('Synthetic Series B').videoPaths).toEqual([vid(4), vid(1)]);
    const r = await library.refuse(vid(4), { target: 'link' });
    expect(r.ok).toBe(true);
    expect(group('Synthetic Series B').entries.map((e) => [e.sceneId, e.path])).toEqual([['1', vid(1)]]);
  });

  it('a Group whose last linked scene is unlinked is kept stored (until a complete sync) but listed no more', async () => {
    const { library, run, playlists } = await setup({ ids: [2, 3, 4] });
    await run();
    expect(playlists().map((g) => g.name)).toEqual(['Synthetic Series A', 'Synthetic Series B']);
    expect((await library.unlink(vid(4))).ok).toBe(true);
    expect(playlists().map((g) => g.name)).toEqual(['Synthetic Series A']);
    expect(library.snapshot().groups).toHaveProperty(['2@http://127.0.0.1:9999']);
  });
});

describe('SN-R4: an import (merge) never brings back a Group a complete sync removed', () => {
  it('a backup made before the Group was deleted in Stash: the Group stays gone', async () => {
    const { library, stash, run, playlists } = await setup();
    await run();
    const backup = library.snapshot();
    deleteGroupB(stash);
    expect((await run()).ok).toBe(true);
    expect(library.projection().groups['2']).toBeUndefined();
    expect((await library.mergeImported(backup)).ok).toBe(true);
    expect(playlists().map((g) => g.name)).toEqual(['Synthetic Series A']);
  });

  it('a backup from a later sync brings its links\' Groups (newer than this machine\'s last full sync)', async () => {
    const stash = fakeStash();
    const other = await setup({ stash, start: T0 + 2 * HOUR });
    await other.run([1, 2, 3, 4]);
    const here = await setup({ stash, ids: [2, 3] });
    await here.run();
    expect(here.playlists().map((g) => g.name)).toEqual(['Synthetic Series A']);
    expect((await here.library.mergeImported(other.library.snapshot())).ok).toBe(true);
    expect(here.playlists().map((g) => g.name)).toEqual(['Synthetic Series A', 'Synthetic Series B']);
    expect(here.group('Synthetic Series B').videoPaths).toEqual([vid(4), vid(1)]);
  });

  it('a Group only an older backup\'s records name waits for the next sync to find it', async () => {
    const stash = fakeStash();
    const old = await setup({ stash, start: T0 });
    await old.run([1, 2, 3, 4]);
    const here = await setup({ stash, ids: [2, 3], start: T0 + HOUR });
    await here.run();
    expect((await here.library.mergeImported(old.library.snapshot())).ok).toBe(true);
    // The imported links are there; Group A (known here) takes scene 1 in; Group B waits.
    expect(here.library.snapshot().links[vid(4)]).toMatchObject({ sceneId: '4' });
    expect(here.playlists().map((g) => g.name)).toEqual(['Synthetic Series A']);
    expect(here.group('Synthetic Series A').videoPaths).toEqual([vid(2), vid(3), vid(1)]);
    here.setNow(T0 + 2 * HOUR);
    expect((await here.run([1, 2, 3, 4])).ok).toBe(true);
    expect(here.playlists().map((g) => g.name)).toEqual(['Synthetic Series A', 'Synthetic Series B']);
  });

  it('Undo of Remove Stash data after a sync: the removed data\'s Groups come back (rebuilt, not held back)', async () => {
    const { library, run, playlists, setNow } = await setup();
    await run();
    const removed = await library.removeAll();
    expect(removed.ok).toBe(true);
    setNow(T0 + HOUR);
    await run([2, 3]); // a sync since: the file exists again
    expect(playlists().map((g) => g.name)).toEqual(['Synthetic Series A']);
    expect((await library.undoRemove(removed.undo)).ok).toBe(true);
    expect(playlists().map((g) => g.name)).toEqual(['Synthetic Series A', 'Synthetic Series B']);
  });

  it('mergeLibraryData (pure): the backup\'s Groups map is not taken; a confirmSince holds back a new Group of older records', () => {
    const local = { v: 1, rev: 1, server: { url: SERVER.url, version: null }, lastSync: null, links: {}, check: {}, refused: {}, scenes: {}, performers: {}, studios: {}, tags: {} };
    const incoming = structuredClone(local);
    incoming.links[vid(4)] = { sceneId: '4', server: SERVER.url, by: 'oshash', state: 'ok', linkedAt: 5, fp: { size: 1 } };
    incoming.scenes['4@http://127.0.0.1:9999'] = { id: '4', server: SERVER.url, fetchedAt: 5, groups: [{ id: '2', name: 'Synthetic Series B', sceneIndex: 1 }] };
    incoming.groups = { '9@http://127.0.0.1:9999': { id: '9', server: SERVER.url, name: 'Not derived', sceneIds: ['4'], updatedAt: 5, seenAt: 5 } };
    const held = mergeLibraryData(structuredClone(local), structuredClone(incoming), { at: 10, confirmSince: 7 });
    expect(held.groups).toEqual({});
    const taken = mergeLibraryData(structuredClone(local), structuredClone(incoming), { at: 10, confirmSince: 3 });
    expect(Object.keys(taken.groups)).toEqual(['2@http://127.0.0.1:9999']);
    expect(taken.groups['2@http://127.0.0.1:9999']).toMatchObject({ name: 'Synthetic Series B', sceneIds: ['4'] });
  });
});

describe('the review\'s note: one tag with a name FunSync cannot use', () => {
  it('is left out; the list stays complete and the tree is stored; it is logged once', async () => {
    const lines = [];
    const log = { warn: (m) => lines.push(m), info: (m) => lines.push(m) };
    const stash = fakeStash();
    stash.tags = [...stash.tags, { id: '7', name: 'x'.repeat(250), aliases: [], parents: [{ id: '5' }] }];
    const { library, run } = await setup({ stash, log });
    const res = await run();
    expect(res.tags).toEqual({ ok: true, count: 6, error: null });
    const tree = library.snapshot().tagTrees['http://127.0.0.1:9999'].tags;
    expect(Object.keys(tree).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    await run();
    expect(lines.filter((m) => /cannot use were left out of the tag list/.test(m))).toHaveLength(1);
    expect(lines.filter((m) => /cannot use/.test(m))[0]).toContain('ids: 7');
  });

  it('a tag whose id cannot be read still makes the list incomplete (the stored tree is kept)', async () => {
    const stash = fakeStash();
    const { library, run } = await setup({ stash });
    await run();
    const before = library.snapshot().tagTrees;
    stash.tags = [...stash.tags.filter((t) => t.id !== '6'), { id: '../7', name: 'Odd id', aliases: [], parents: [] }];
    const res = await run();
    expect(res.tags.ok).toBe(false);
    expect(library.snapshot().tagTrees).toEqual(before);
  });
});

describe('SN-R5: the tag rules are built once per stored tag tree', () => {
  it('projection rebuilds after links and Undo reuse them; a new tree (the next full sync) builds them once more', async () => {
    const { library, run, setNow } = await setup();
    await run();
    expect(library.tagRuleBuilds()).toBe(0); // nobody asked for them yet
    const first = library.projection({ tagRules: true }).tagRules;
    expect(library.tagRuleBuilds()).toBe(1);
    expect(typeof first.stamp).toBe('string');
    const r = await library.unlink(vid(3));
    library.projection({ tagRules: true });
    await library.restore(r.undo);
    const again = library.projection({ tagRules: true }).tagRules;
    expect(library.tagRuleBuilds()).toBe(1);
    expect(again).toEqual(first);
    setNow(T0 + HOUR);
    await run();
    const next = library.projection({ tagRules: true }).tagRules;
    expect(library.tagRuleBuilds()).toBe(2);
    expect(next.stamp).not.toBe(first.stamp);
    const { stamp: _a, ...firstRules } = first;
    const { stamp: _b, ...nextRules } = next;
    expect(nextRules).toEqual(firstRules);
  });

  it('no stored tree: the empty rules, no stamp', async () => {
    const { library } = await setup();
    await library.applySync((d) => { d.server = { url: SERVER.url, version: null }; return {}; });
    expect(library.projection({ tagRules: true }).tagRules).toEqual({ aliases: {}, children: {}, names: {} });
  });
});
