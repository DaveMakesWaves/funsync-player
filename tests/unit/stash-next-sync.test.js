/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash "next" lot (2026-11-19, stage sn-main): the sync job
// (electron/stash-sync.js) with the next lot's data. The scenes and tags are
// the local test Stash's (sn-scene-details, sn-tag-list); the client is an
// in-memory fake with stash-client.js's interface; the matcher, the mapper
// and the data file are the real ones.
//
// Guards checked by reopening their hole (SCRATCH/sn-main/holes.jsonl):
//   - plays, O-count, Groups (and their names) and phash change in Stash
//     without the scene's updated_at changing: a full sync takes them from
//     the light list (hole: only the details carry them, so they stay old)
//   - only a COMPLETE tag list replaces the stored one (hole: store what
//     came back)
//   - a Group goes only after a complete, successful full sync (hole: any
//     sync removes it)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { snFixtureScenes, snFixtureTags, lightScene } from '../helpers/fake-stash-server.js';

const require_ = createRequire(import.meta.url);
const { createStashLibraryFile } = require_('../../electron/stash-library-file.js');
const { createStashSync } = require_('../../electron/stash-sync.js');
const { matchLibrary } = require_('../../electron/stash-match.js');
const { mapScene } = require_('../../electron/stash-map.js');
const { recordKey } = require_('../../electron/stash-keys.js');

const SERVER = { url: 'http://127.0.0.1:9999', version: 'v0.32.0' };
const T0 = new Date(2026, 10, 19, 10, 0, 0).getTime();
const quiet = { warn() {}, info() {} };
const vid = (id) => `C:\\lib\\scene ${id}.mp4`;
const rk = (id) => recordKey(SERVER.url, String(id));

let dir;
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-stash-next-sync-')); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

/** The fake Stash: the test Stash's scenes and tags, in memory, with failure switches. */
function fakeStash() {
  const s = {
    scenes: new Map(snFixtureScenes().map((x) => [x.id, x])),
    tags: snFixtureTags(),
    calls: [],
    failDetails: false,
    failTagPage: null,
    tagCountDrift: 0,
  };
  const sorted = () => [...s.scenes.values()].sort((a, b) => Number(a.id) - Number(b.id));
  s.client = {
    async listScenes({ page, perPage }) {
      s.calls.push('list');
      const all = sorted();
      return { count: all.length, scenes: all.slice((page - 1) * perPage, page * perPage).map(lightScene) };
    },
    async sceneDetails(ids) {
      s.calls.push(`details:${ids.join(',')}`);
      if (s.failDetails) throw Object.assign(new Error('timeout'), { code: 'timeout' });
      const out = {};
      for (const id of ids) out[id] = s.scenes.has(id) ? structuredClone(s.scenes.get(id)) : null;
      return out;
    },
    async scenesByOshash(h) {
      s.calls.push('byOshash');
      const hits = sorted().filter((x) => x.files.some((f) => f.oshash === h)).map(lightScene);
      return { count: hits.length, scenes: hits };
    },
    async listTags({ page, perPage }) {
      s.calls.push(`tags:${page}`);
      if (s.failTagPage === page) throw Object.assign(new Error('fetch failed'), { code: 'unreachable' });
      const all = [...s.tags].sort((a, b) => Number(a.id) - Number(b.id));
      return { count: all.length + (page > 1 ? s.tagCountDrift : 0), tags: all.slice((page - 1) * perPage, page * perPage) };
    },
  };
  return s;
}

/** One local video per Stash scene id, with that scene's primary file's size and oshash. */
function videosFor(stash, ids) {
  const fps = new Map();
  for (const id of ids) {
    const f = stash.scenes.get(String(id)).files[0];
    fps.set(vid(id), { size: f.size, mtimeMs: 1000 + Number(id), oshash: f.oshash });
  }
  return fps;
}

async function setup({ ids = [1, 2, 3, 4], perPage = 1000 } = {}) {
  const library = createStashLibraryFile({ dir, now: () => T0, log: quiet });
  await library.load();
  const stash = fakeStash();
  const fps = videosFor(stash, ids);
  let now = T0;
  const sync = createStashSync({
    library,
    client: stash.client,
    fingerprint: async (v) => (fps.has(v.path) ? { ...fps.get(v.path) } : null),
    match: (input) => matchLibrary({ ...input, server: SERVER.url, now }),
    mapScene: (raw) => mapScene(raw, { now }),
    now: () => now,
    log: quiet,
    perPage,
  });
  const run = () => sync.run({ videos: ids.map((id) => ({ path: vid(id) })), server: SERVER, pathRules: [] });
  const tick = (ms) => { now += ms; };
  return { library, stash, sync, run, tick, data: () => library.snapshot(), proj: (o) => library.projection(o) };
}

/** Change a scene in the fake Stash the way Stash would (updated_at only when `touch`). */
function edit(stash, id, fn, { touch = false } = {}) {
  const scene = stash.scenes.get(String(id));
  fn(scene);
  if (touch) scene.updated_at = '2026-11-20T08:00:00Z';
}

describe('a full sync stores the next lot\'s data', () => {
  it('plays, last play, O-count, phash and Groups per scene; Groups in Stash\'s order; the tag tree', async () => {
    const { run, data, proj } = await setup();
    const res = await run();
    expect(res).toMatchObject({ ok: true, complete: true, counts: { linked: 4 }, tags: { ok: true, count: 6, error: null } });
    const p = proj();
    expect(p.scenes['2']).toMatchObject({ playCount: 5, oCounter: 3, lastPlayedAt: '2026-11-17T21:45:00.000Z', phash: 'ab63cd1cc33c3343', groups: [{ groupId: '1', sceneIndex: 1 }] });
    expect(p.scenes['4']).toMatchObject({ playCount: 0, lastPlayedAt: null, phash: null });
    expect(p.groups['1']).toMatchObject({ name: 'Synthetic Series A', sceneIds: ['2', '3', '1'] });
    expect(p.groups['2']).toMatchObject({ name: 'Synthetic Series B', sceneIds: ['4', '1'] });
    expect(Object.keys(data().tagTrees['http://127.0.0.1:9999'].tags).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(p.tagRules).toBeUndefined();
    expect(proj({ tagRules: true }).tagRules.children['synthetic-grandparent-tag']).toEqual(['synthetic-parent-tag', 'synthetic-tag-b']);
  });

  it('a Group only an unlinked scene is in is no playlist (scene 10 is in none; scene 5 is not linked here)', async () => {
    const { run, proj } = await setup({ ids: [2, 3] });
    await run();
    expect(proj().groups).toEqual({ 1: expect.objectContaining({ sceneIds: ['2', '3'] }) });
  });
});

describe('what changes in Stash without updated_at moving is fresh after every full sync', () => {
  it('more plays, an O, a renamed Group and a phash generated later arrive WITHOUT fetching the details again (guard)', async () => {
    const { run, stash, proj, tick } = await setup();
    await run();
    stash.calls.length = 0;
    // In Stash: scene 2 played twice more and an O; Group A renamed (its
    // scenes untouched); the Generate task adds scene 4's phash.
    edit(stash, 2, (s) => { s.play_count = 7; s.last_played_at = '2026-11-19T21:00:00+01:00'; s.o_counter = 4; });
    for (const id of ['1', '2', '3']) edit(stash, id, (s) => { for (const g of s.groups) if (g.group.id === '1') g.group.name = 'Series A (new name)'; });
    edit(stash, 4, (s) => { s.files[0].phash = 'c3c3c3c3c3c3c3c3'; });
    tick(60000);
    const res = await run();
    expect(res.ok).toBe(true);
    expect(stash.calls.filter((c) => c.startsWith('details'))).toEqual([]);
    const p = proj();
    expect(p.scenes['2']).toMatchObject({ playCount: 7, oCounter: 4, lastPlayedAt: '2026-11-19T20:00:00.000Z' });
    expect(p.scenes['4'].phash).toBe('c3c3c3c3c3c3c3c3');
    expect(p.groups['1']).toMatchObject({ name: 'Series A (new name)', sceneIds: ['2', '3', '1'], updatedAt: T0 + 60000 });
    expect(p.groups['2']).toMatchObject({ name: 'Synthetic Series B', updatedAt: T0 });
  });

  it('a reordered Group (scene_index changed, which Stash records on the scene) is reordered', async () => {
    const { run, stash, proj } = await setup();
    await run();
    edit(stash, 1, (s) => { s.groups.find((g) => g.group.id === '1').scene_index = 0; }, { touch: true });
    await run();
    expect(proj().groups['1'].sceneIds).toEqual(['1', '2', '3']);
  });
});

describe('a Group goes only after a complete, successful full sync shows it gone (guard)', () => {
  it('a failed sync keeps it; the next complete one removes it; nothing else goes with it', async () => {
    const { run, stash, proj, data } = await setup();
    await run();
    expect(Object.keys(proj().groups).sort()).toEqual(['1', '2']);
    // In Stash, Group B is deleted: scenes 1 and 4 are in it no more.
    edit(stash, 1, (s) => { s.groups = s.groups.filter((g) => g.group.id !== '2'); }, { touch: true });
    edit(stash, 4, (s) => { s.groups = []; }, { touch: true });
    stash.failDetails = true;
    const partial = await run();
    expect(partial).toMatchObject({ ok: false, written: true, partial: true });
    expect(proj().groups['2']).toMatchObject({ name: 'Synthetic Series B', sceneIds: ['4', '1'] });
    stash.failDetails = false;
    expect(await run()).toMatchObject({ ok: true, complete: true });
    expect(proj().groups['2']).toBeUndefined();
    expect(proj().groups['1'].sceneIds).toEqual(['2', '3', '1']);
    expect(Object.keys(data().links)).toHaveLength(4);
  });

  it('Sync this video never removes a Group and never reads the tag list', async () => {
    const { run, stash, sync, proj } = await setup();
    await run();
    edit(stash, 4, (s) => { s.groups = []; }, { touch: true });
    edit(stash, 1, (s) => { s.groups = s.groups.filter((g) => g.group.id !== '2'); }, { touch: true });
    stash.calls.length = 0;
    const one = await sync.runVideo({ video: { path: vid(4) }, server: SERVER, pathRules: [] });
    expect(one).toMatchObject({ ok: true, kind: 'video', tags: null });
    expect(stash.calls.some((c) => c.startsWith('tags'))).toBe(false);
    // Scene 4 left Group B (its fresh details say so); Group B itself stays until a complete sync.
    expect(proj().scenes['4'].groups).toEqual([]);
    expect(proj().groups['2']).toMatchObject({ sceneIds: ['1'] });
  });
});

describe('the tag list: only a complete one replaces the stored tree (guard)', () => {
  it('a failing page keeps the stored tree; the sync itself is fine', async () => {
    const { run, stash, data } = await setup({ perPage: 4 });
    await run();
    const before = data().tagTrees;
    stash.tags.push({ id: '7', name: 'Synthetic Tag D', aliases: [], parents: [] });
    stash.failTagPage = 2;
    const res = await run();
    expect(res).toMatchObject({ ok: true, complete: true, tags: { ok: false, count: null, error: { code: 'unreachable' } } });
    expect(data().tagTrees).toEqual(before);
  });

  it('a list whose count moved between pages is not complete: kept as it was', async () => {
    const { run, stash, data } = await setup({ perPage: 4 });
    await run();
    const before = data().tagTrees;
    stash.tags.push({ id: '7', name: 'Synthetic Tag D', aliases: [], parents: [] });
    stash.tagCountDrift = 1;
    const res = await run();
    expect(res.tags).toMatchObject({ ok: false, error: { code: 'incomplete' } });
    expect(data().tagTrees).toEqual(before);
    stash.tagCountDrift = 0;
    expect((await run()).tags).toMatchObject({ ok: true, count: 7 });
    expect(Object.keys(data().tagTrees['http://127.0.0.1:9999'].tags)).toContain('7');
  });

  it('a client without listTags (an older build) syncs as before', async () => {
    const { stash, library } = await setup();
    delete stash.client.listTags;
    const sync = createStashSync({
      library, client: stash.client, fingerprint: async () => null, match: () => ({}), mapScene: (raw) => mapScene(raw, { now: T0 }), now: () => T0, log: quiet,
    });
    const res = await sync.run({ videos: [], server: SERVER, pathRules: [] });
    expect(res).toMatchObject({ ok: true, tags: null });
  });
});

describe('records of other data are never touched by the light list', () => {
  it('a stored scene of another server with the same id keeps its values', async () => {
    const { run, library, proj } = await setup({ ids: [2] });
    await library.applySync((d) => {
      d.scenes[recordKey('http://nas.lan:9999', '2')] = { id: '2', server: 'http://nas.lan:9999', playCount: 99, fetchedAt: 1 };
      d.links['C:\\other\\x.mp4'] = { sceneId: '2', server: 'http://nas.lan:9999', by: 'manual', state: 'ok' };
      return {};
    });
    await run();
    expect(library.snapshot().scenes[recordKey('http://nas.lan:9999', '2')].playCount).toBe(99);
    expect(proj().scenes['2'].playCount).toBe(5);
    expect(library.snapshot().scenes[rk(2)].activityAt).toBeUndefined(); // fetched just now: details, not the list
  });
});
