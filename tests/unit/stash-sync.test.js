/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The user-started Stash sync job (Stash S1, notes/features/DESIGN-stash-s1.md
// (a) step 5, (b), (e), (g)). A failed or partial sync never removes or
// clears anything. The client, the fingerprints, the matcher and the mapper
// are fakes with the interfaces electron/stash-sync.js documents; the
// library file is the real one in a temp folder. Every guard here was
// checked by reopening its hole (the stage's holes.jsonl lists them).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { createStashLibraryFile, emptyData } = require_('../../electron/stash-library-file.js');
const { createStashSync, shouldSyncOnStart, pruneUnreferenced } = require_('../../electron/stash-sync.js');
const { recordKey } = require_('../../electron/stash-keys.js');

const SERVER = { url: 'http://127.0.0.1:9999', version: 'v0.32.0' };
// Records are stored by server and id (Round 2: Stash ids are unique only per server).
const rk = (id, server = SERVER.url) => recordKey(server, String(id));
const NOW = new Date(2026, 10, 18, 20, 0, 0).getTime();
const quiet = { warn() {}, info() {} };
const hash = (n) => n.toString(16).padStart(16, '0');
const vid = (n) => `C:\\lib\\video ${n}.mp4`;

let dir;
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-stash-sync-')); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

const file = () => path.join(dir, 'library.json');
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(file())).digest('hex');
const onDisk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

/** A Stash scene in the fake server: one file with oshash hash(n) unless given. */
function stashScene(id, n, extra = {}) {
  return {
    id: String(id),
    title: `Synthetic Scene ${id}`,
    updated_at: '2026-11-17T10:00:00Z',
    files: [{ path: `/data/videos/${id}.mp4`, size: 1000 + n, oshash: hash(n) }],
    performers: [{ id: `p${id}`, name: `Performer ${id}` }],
    tags: [{ id: 't1', name: 'POV' }],
    studio: { id: 's1', name: 'Synthetic Studio' },
    ...extra,
  };
}

/**
 * The fake Stash: in-memory scenes, one request at a time recorded, with
 * failure switches.
 */
function fakeStash(scenes) {
  const s = {
    scenes: new Map(scenes.map((x) => [x.id, x])),
    listCalls: [],
    detailCalls: [],
    hashCalls: [],
    active: 0,
    maxActive: 0,
    failPage: null,
    failDetailsCall: null,
    countDrift: 0,
    deletedAfterList: new Set(),
    gate: null,
    onDetails: null,
  };
  const enter = () => { s.active++; s.maxActive = Math.max(s.maxActive, s.active); };
  const leave = () => { s.active--; };
  // The light list as Stash answers it (stash-client.js listScenes / scenesByOshash).
  const light = (x) => ({ id: x.id, updated_at: x.updated_at, files: x.files.map((f) => ({ path: f.path, size: f.size, oshash: f.oshash })) });
  s.client = {
    async listScenes({ page, perPage }) {
      enter();
      try {
        s.listCalls.push(page);
        await Promise.resolve();
        if (s.failPage === page) throw Object.assign(new Error('fetch failed'), { code: 'down' });
        const all = [...s.scenes.values()];
        return { count: all.length + (page > 1 ? s.countDrift : 0), scenes: all.slice((page - 1) * perPage, page * perPage).map(light) };
      } finally { leave(); }
    },
    async sceneDetails(ids) {
      enter();
      try {
        s.detailCalls.push([...ids]);
        if (s.onDetails) await s.onDetails(s.detailCalls.length);
        if (s.gate) await s.gate;
        if (s.failDetailsCall === s.detailCalls.length) throw Object.assign(new Error('timeout'), { code: 'timeout' });
        const out = {};
        for (const id of ids) out[id] = s.deletedAfterList.has(id) || !s.scenes.has(id) ? null : JSON.parse(JSON.stringify(s.scenes.get(id)));
        return out;
      } finally { leave(); }
    },
    async scenesByOshash(h) {
      enter();
      try {
        s.hashCalls.push(h);
        const hits = [...s.scenes.values()].filter((x) => x.files.some((f) => f.oshash === h)).map(light);
        return { count: hits.length, scenes: hits };
      } finally { leave(); }
    },
  };
  return s;
}

/** The mapper's shape (electron/stash-map.js builds the real one). */
function mapScene(raw) {
  return {
    scene: {
      id: String(raw.id), title: raw.title, urls: raw.urls || [], updatedAt: raw.updated_at,
      studioId: raw.studio ? raw.studio.id : null,
      performerIds: (raw.performers || []).map((p) => p.id),
      tagIds: (raw.tags || []).map((t) => t.id),
      files: raw.files.map((f) => ({ path: f.path, size: f.size, duration: 1, oshash: f.oshash })),
      markers: [],
      ...(raw.paths ? { paths: raw.paths } : {}),
    },
    performers: (raw.performers || []).map((p) => ({ id: p.id, name: p.name })),
    studios: raw.studio ? [raw.studio] : [],
    tags: (raw.tags || []).map((t) => ({ id: t.id, name: t.name })),
  };
}

/** The matcher's rules (b), simplified (electron/stash-match.js is the real one). */
function fakeMatch({ videos, scenes, complete, links, refused }) {
  const byHash = new Map();
  for (const sc of scenes) {
    for (const f of sc.files) {
      if (!f.oshash) continue;
      if (!byHash.has(f.oshash)) byHash.set(f.oshash, new Set());
      byHash.get(f.oshash).add(sc.id);
    }
  }
  const listed = new Set(scenes.map((sc) => sc.id));
  const out = { links: {}, check: {} };
  for (const v of videos) {
    const old = links[v.path];
    const r = refused[v.path];
    const refusedIds = r && r.oshash === v.oshash ? r.sceneIds : [];
    const ids = [...(byHash.get(v.oshash) || [])].filter((id) => !refusedIds.includes(id));
    const fp = { size: v.size, mtimeMs: v.mtimeMs, oshash: v.oshash };
    if (old && (old.by === 'manual' || old.by === 'chosen')) {
      out.links[v.path] = { ...old, state: listed.has(old.sceneId) ? 'ok' : (complete ? 'gone' : old.state) };
    } else if (ids.length === 1) {
      out.links[v.path] = { sceneId: ids[0], by: 'oshash', fp, state: 'ok', ...(old && old.sceneId === ids[0] ? { linkedAt: old.linkedAt } : {}) };
    } else if (ids.length > 1) {
      out.check[v.path] = { kind: 'several', sceneIds: ids, fp, seenAt: 1 };
      if (old) out.links[v.path] = old;
    } else if (old) {
      out.links[v.path] = { ...old, state: !listed.has(old.sceneId) && complete ? 'gone' : old.state };
    }
  }
  return out;
}

/** Fingerprints: path → {size, mtimeMs, oshash}; a path not in the map is offline. */
function fakeFingerprints(entries) {
  const map = new Map(entries);
  const calls = [];
  return {
    calls,
    fingerprint: async (video) => { calls.push(video.path); return map.has(video.path) ? { ...map.get(video.path) } : null; },
  };
}

const fpOf = (n) => ({ size: 1000 + n, mtimeMs: 5000 + n, oshash: hash(n) });

async function setup({ scenes, videos, offline = [], stored = null, perPage = 1000, batchSize, match = fakeMatch, mapper = mapScene } = {}) {
  if (stored) await fsp.writeFile(file(), JSON.stringify(stored));
  const library = createStashLibraryFile({ dir, now: () => NOW, log: quiet });
  await library.load();
  const stash = fakeStash(scenes);
  const fps = fakeFingerprints(videos.filter((n) => !offline.includes(n)).map((n) => [vid(n), fpOf(n)]));
  const sync = createStashSync({
    library, client: stash.client, fingerprint: fps.fingerprint, match, mapScene: mapper,
    now: () => NOW, log: quiet, perPage, ...(batchSize ? { batchSize } : {}),
  });
  const run = (extra = {}) => sync.run({ videos: videos.map((n) => ({ path: vid(n) })), server: SERVER, pathRules: [], ...extra });
  return { library, stash, fps, sync, run };
}

/** A stored library: video n linked to scene id (automatic unless `by`), with the scene's data. */
function storedWith(links, { scenes = [], check = {}, refused = {} } = {}) {
  const d = emptyData();
  d.rev = 5;
  d.server = { url: SERVER.url, version: 'v0.32.0' };
  for (const [n, id, by = 'oshash'] of links) {
    d.links[vid(n)] = { sceneId: String(id), server: SERVER.url, by, fp: fpOf(n), linkedAt: 100, state: 'ok' };
  }
  for (const [id, n, extra = {}] of scenes) {
    const m = mapScene(stashScene(id, n));
    d.scenes[rk(id)] = { ...m.scene, fetchedAt: 100, server: SERVER.url, ...extra };
    for (const p of m.performers) d.performers[rk(p.id)] = { ...p, fetchedAt: 100, server: SERVER.url };
    for (const t of m.tags) d.tags[rk(t.id)] = { ...t, fetchedAt: 100, server: SERVER.url };
    for (const st of m.studios) d.studios[rk(st.id)] = { ...st, fetchedAt: 100, server: SERVER.url };
  }
  d.check = check;
  d.refused = refused;
  return d;
}

describe('Sync now', () => {
  it('links unique oshash matches, fetches their details and writes once', async () => {
    const t = await setup({ scenes: [stashScene(1, 1), stashScene(2, 2), stashScene(3, 30)], videos: [1, 2, 4] });
    const steps = [];
    const res = await t.run({ onProgress: (p) => steps.push(p.step) });
    expect(res).toMatchObject({ ok: true, written: true, partial: false, complete: true });
    expect(res.counts).toEqual({ linked: 2, check: 0, notInStash: 1, gone: 0, changed: 0, skipped: 0 });
    const d = onDisk();
    expect(d.rev).toBe(1);
    expect(d.links[vid(1)]).toMatchObject({ sceneId: '1', by: 'oshash', state: 'ok', server: SERVER.url, linkedAt: NOW, fp: fpOf(1) });
    expect(d.links[vid(4)]).toBeUndefined();
    expect(d.scenes[rk('1')]).toMatchObject({ title: 'Synthetic Scene 1', fetchedAt: NOW, server: SERVER.url });
    expect(d.scenes[rk('3')]).toBeUndefined();
    expect(d.performers[rk('p1')].name).toBe('Performer 1');
    expect(d.lastSync).toMatchObject({ at: NOW, kind: 'full', ok: true, partial: false, error: null });
    expect(d.server).toEqual(SERVER);
    expect(t.stash.detailCalls).toEqual([['1', '2']]);
    expect([...new Set(steps)]).toEqual(['hash', 'list', 'match', 'details', 'write']);
  });

  it('offline at sync start: library.json stays byte for byte (a failed Test, then a failed sync)', async () => {
    const stored = storedWith([[1, 1]], { scenes: [[1, 1]] });
    const t = await setup({ scenes: [stashScene(1, 1)], videos: [1, 2], stored });
    const before = sha();
    t.stash.failPage = 1;
    // a failed Test touches no file either (it is a client call)
    await expect(t.stash.client.listScenes({ page: 1, perPage: 1 })).rejects.toThrow();
    const res = await t.run();
    expect(res).toMatchObject({ ok: false, written: false, error: { code: 'down' } });
    expect(sha()).toBe(before);
    expect(fs.existsSync(path.join(dir, 'library.json.bak'))).toBe(false);
  });

  it('a page failing mid-list: nothing written, so nothing is marked gone', async () => {
    const stored = storedWith([[1, 9]], { scenes: [[9, 1]] }); // linked to a scene no longer in Stash
    const t = await setup({ scenes: [stashScene(2, 2), stashScene(3, 3), stashScene(4, 4)], videos: [1, 2], stored, perPage: 2 });
    const before = sha();
    t.stash.failPage = 2;
    const res = await t.run();
    expect(res).toMatchObject({ written: false, partial: true, error: { code: 'down' } });
    expect(sha()).toBe(before);
  });

  it('a list whose count moved while paging is not complete: the missing scene is not marked gone', async () => {
    const stored = storedWith([[1, 9]], { scenes: [[9, 1]] });
    let toldComplete = null;
    const t = await setup({
      scenes: [stashScene(2, 2), stashScene(3, 3), stashScene(4, 4)], videos: [1, 2], stored, perPage: 2,
      match: (input) => { toldComplete = input.complete; return fakeMatch(input); },
    });
    t.stash.countDrift = 1;
    const res = await t.run();
    expect(toldComplete).toBe(false);
    expect(res).toMatchObject({ ok: true, written: true, complete: false });
    const d = onDisk();
    expect(d.links[vid(1)].state).toBe('ok');
    expect(d.links[vid(2)].sceneId).toBe('2');
  });

  it('a complete list marks the missing scene gone and keeps its data', async () => {
    const stored = storedWith([[1, 9]], { scenes: [[9, 1]] });
    const t = await setup({ scenes: [stashScene(2, 2), stashScene(3, 3), stashScene(4, 4)], videos: [1], stored, perPage: 2 });
    const res = await t.run();
    expect(res.complete).toBe(true);
    expect(res.counts.gone).toBe(1);
    const d = onDisk();
    expect(d.links[vid(1)]).toMatchObject({ sceneId: '9', state: 'gone' });
    expect(d.scenes[rk('9')].title).toBe('Synthetic Scene 9');
  });

  it('a matcher that says "gone" from an incomplete list is not followed', async () => {
    const stored = storedWith([[1, 1]], { scenes: [[1, 1]] });
    const sayGone = (input) => {
      const out = fakeMatch(input);
      for (const p of Object.keys(input.links)) out.links[p] = { ...input.links[p], state: 'gone' };
      return out;
    };
    const t = await setup({ scenes: [stashScene(1, 1), stashScene(2, 2), stashScene(3, 3)], videos: [1], stored, perPage: 2, match: sayGone });
    t.stash.countDrift = 1;
    const res = await t.run();
    expect(res.complete).toBe(false);
    expect(onDisk().links[vid(1)].state).toBe('ok');
  });

  it('partial sync: a failing details batch writes the batches that finished, removes nothing, partial: true', async () => {
    // video 1: your manual link, its scene stored; video 9: on an offline drive, linked.
    const stored = storedWith([[1, 1, 'manual'], [9, 9]], {
      scenes: [[1, 1], [9, 9], [77, 77]],
      check: { [vid(8)]: { kind: 'several', sceneIds: ['1', '9'], fp: fpOf(8), seenAt: 1 } },
    });
    const t = await setup({
      scenes: [1, 2, 3, 4, 5, 6].map((n) => stashScene(n, n)),
      videos: [1, 2, 3, 4, 5, 6, 8, 9], offline: [9], stored, batchSize: 2,
    });
    t.stash.failDetailsCall = 2;
    const res = await t.run();
    expect(res).toMatchObject({ ok: false, written: true, partial: true, error: { code: 'timeout' }, details: { done: 2, total: 5 } });
    const d = onDisk();
    expect(d.lastSync).toMatchObject({ ok: false, partial: true, error: 'timeout' });
    // the first batch (scenes 2 and 3) is written
    expect(d.links[vid(2)].sceneId).toBe('2');
    expect(d.links[vid(3)].sceneId).toBe('3');
    // the rest waits for the next sync
    expect(d.links[vid(4)]).toBeUndefined();
    // nothing removed: your link, the offline video's link, the check, every scene
    expect(d.links[vid(1)]).toMatchObject({ sceneId: '1', by: 'manual' });
    expect(d.links[vid(9)]).toEqual(stored.links[vid(9)]);
    expect(d.check[vid(8)]).toEqual(stored.check[vid(8)]);
    for (const id of ['1', '9', '77']) expect(d.scenes[rk(id)]).toBeDefined();
    expect(res.counts.skipped).toBe(1);
  });

  it('Cancel during the details writes what finished; Cancel while hashing writes nothing', async () => {
    const t = await setup({ scenes: [1, 2, 3, 4].map((n) => stashScene(n, n)), videos: [1, 2, 3, 4], batchSize: 2 });
    t.stash.onDetails = (n) => { if (n === 1) t.sync.cancel(); };
    const res = await t.run();
    expect(res).toMatchObject({ written: true, partial: true, cancelled: true, error: { code: 'cancelled' } });
    expect(Object.keys(onDisk().links).length).toBe(2);
    const before = sha();

    const t2 = await setup({ scenes: [stashScene(1, 1)], videos: [1, 2] });
    const run = t2.run({ onProgress: (p) => { if (p.step === 'hash' && p.done === 1) t2.sync.cancel(); } });
    const res2 = await run;
    expect(res2).toMatchObject({ written: false, cancelled: true });
    expect(sha()).toBe(before);
    expect(t2.stash.listCalls).toEqual([]);
  });

  it('your choice wins: a scene chosen while the sync runs is not replaced by the automatic match', async () => {
    // video 1 needed a check between scenes 1 and 2; now only scene 1 has its file.
    const stored = storedWith([], {
      scenes: [[1, 1], [2, 1]],
      check: { [vid(1)]: { kind: 'several', sceneIds: ['1', '2'], fp: fpOf(1), seenAt: 1 } },
    });
    const t = await setup({ scenes: [stashScene(1, 1, { updated_at: 'changed' }), stashScene(2, 50)], videos: [1], stored });
    t.stash.onDetails = async () => { await t.library.choose(vid(1), '2'); };
    const res = await t.run();
    expect(res.written).toBe(true);
    expect(onDisk().links[vid(1)]).toMatchObject({ sceneId: '2', by: 'chosen' });
    expect(onDisk().check[vid(1)]).toBeUndefined();
  });

  it('a refusal made while the sync runs is kept: that scene is not linked again for this file', async () => {
    const stored = storedWith([[1, 1]], { scenes: [[1, 1]] });
    const t = await setup({ scenes: [stashScene(1, 1, { updated_at: 'changed' })], videos: [1], stored });
    t.stash.onDetails = async () => { await t.library.refuse(vid(1)); };
    await t.run();
    const d = onDisk();
    expect(d.links[vid(1)]).toBeUndefined();
    expect(d.refused[vid(1)]).toMatchObject({ oshash: hash(1), sceneIds: ['1'] });
  });

  it('details by id: at most 50 ids per request, one request at a time; a scene deleted after the list fails nothing else', async () => {
    const ns = Array.from({ length: 120 }, (_, i) => i + 1);
    const stored = storedWith([[7, 7]], { scenes: [[7, 7, { updatedAt: 'old' }]] });
    const t = await setup({ scenes: ns.map((n) => stashScene(n, n)), videos: ns, stored });
    t.stash.deletedAfterList.add('7');
    t.stash.deletedAfterList.add('8');
    const res = await t.run();
    expect(res.ok).toBe(true);
    expect(t.stash.detailCalls.length).toBe(3);
    expect(Math.max(...t.stash.detailCalls.map((c) => c.length))).toBeLessThanOrEqual(50);
    expect(t.stash.maxActive).toBe(1);
    const d = onDisk();
    expect(d.links[vid(7)]).toMatchObject({ sceneId: '7', state: 'gone' }); // Stash answered "no such scene"
    expect(d.scenes[rk('7')]).toBeDefined(); // its data is kept
    expect(d.links[vid(8)]).toBeUndefined(); // a new match with no data is not linked
    expect(d.links[vid(120)].sceneId).toBe('120');
  });

  it('only scenes that are new or changed in Stash are fetched again', async () => {
    const t = await setup({ scenes: [stashScene(1, 1), stashScene(2, 2)], videos: [1, 2] });
    await t.run();
    t.stash.detailCalls.length = 0;
    t.stash.scenes.get('2').updated_at = '2026-11-18T09:00:00Z';
    await t.run();
    expect(t.stash.detailCalls).toEqual([['2']]);
  });

  it('scenes nothing points to go only at the end of a complete, successful sync', async () => {
    const stored = storedWith([], { scenes: [[77, 77]] });
    const t = await setup({ scenes: [1, 2, 3].map((n) => stashScene(n, n)), videos: [1, 2, 3], stored, batchSize: 1 });
    t.stash.failDetailsCall = 2;
    await t.run();
    expect(onDisk().scenes[rk('77')]).toBeDefined();
    t.stash.failDetailsCall = null;
    await t.run();
    expect(onDisk().scenes[rk('77')]).toBeUndefined();
    expect(Object.keys(onDisk().scenes).sort()).toEqual([rk('1'), rk('2'), rk('3')]);
  });

  it("the prune keeps what a kept scene points to: its studio's parent and its markers' tags", () => {
    const d = emptyData();
    d.links[vid(1)] = { sceneId: '1', by: 'oshash', state: 'ok' };
    d.refused[vid(2)] = { oshash: hash(2), sceneIds: ['3'] };
    const at = (list) => Object.fromEntries(list.map((r) => [rk(r.id), { ...r, server: SERVER.url }]));
    d.scenes = at([
      { id: '1', studioId: 's1', performerIds: ['p1'], tagIds: ['t1'], markers: [{ id: 'm1', tag: { id: 't2', name: 'A' }, tags: [{ id: 't3', name: 'B' }] }] },
      { id: '2', studioId: 's9', performerIds: ['p9'], tagIds: ['t9'], markers: [] },
      { id: '3', studioId: null, performerIds: [], tagIds: [], markers: [] },
    ]);
    d.studios = at([{ id: 's1', parent: 'Network', parentId: 's0' }, { id: 's0' }, { id: 's9' }]);
    d.performers = at([{ id: 'p1' }, { id: 'p9' }]);
    d.tags = at([{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't9' }]);
    pruneUnreferenced(d, SERVER.url);
    expect(Object.keys(d.scenes).sort()).toEqual([rk('1'), rk('3')]);
    expect(Object.keys(d.studios).sort()).toEqual([rk('s0'), rk('s1')]);
    expect(Object.keys(d.performers)).toEqual([rk('p1')]);
    expect(Object.keys(d.tags).sort()).toEqual([rk('t1'), rk('t2'), rk('t3')]);
  });

  it('no string Stash built is stored: nothing in library.json contains apikey=', async () => {
    const leaky = stashScene(1, 1, {
      urls: ['https://example.invalid/s/1', 'http://127.0.0.1:9999/scene/1/funscript?apikey=SECRET'],
      paths: { funscript: 'http://127.0.0.1:9999/scene/1/funscript?apikey=SECRET', stream: 'http://127.0.0.1:9999/scene/1/stream?apikey=SECRET' },
    });
    const t = await setup({ scenes: [leaky], videos: [1] });
    await t.run();
    const text = fs.readFileSync(file(), 'utf8');
    expect(text.toLowerCase()).not.toContain('apikey=');
    expect(onDisk().scenes[rk('1')].urls).toEqual(['https://example.invalid/s/1']);
    expect(JSON.stringify(t.library.projection()).toLowerCase()).not.toContain('apikey=');
  });

  it('a re-link to a new unique match comes with an Undo that restores exactly', async () => {
    const stored = storedWith([[1, 5]], { scenes: [[5, 1]] }); // scene 5 had this file; now scene 6 has it
    const t = await setup({ scenes: [stashScene(5, 50), stashScene(6, 1)], videos: [1], stored });
    const res = await t.run();
    expect(onDisk().links[vid(1)].sceneId).toBe('6');
    expect(res.relinked).toHaveLength(1);
    expect(res.relinked[0]).toMatchObject({ path: vid(1), from: '5', to: '6' });
    await t.library.restore(res.relinked[0].undo);
    expect(onDisk().links[vid(1)]).toEqual(stored.links[vid(1)]);
  });

  it('a link moved by the scan-time re-home is confirmed (verify cleared) when its file hashes the same', async () => {
    const stored = storedWith([[1, 1]], { scenes: [[1, 1]] });
    stored.links[vid(1)].verify = true;
    const t = await setup({ scenes: [stashScene(1, 1)], videos: [1], stored });
    await t.run();
    expect(onDisk().links[vid(1)].verify).toBeUndefined();
  });

  it('one job at a time', async () => {
    const t = await setup({ scenes: [stashScene(1, 1)], videos: [1] });
    let release;
    t.stash.gate = new Promise((r) => { release = r; });
    const first = t.run();
    expect(t.sync.isRunning()).toBe(true);
    expect(await t.run()).toMatchObject({ ok: false, written: false, error: { code: 'busy' } });
    release();
    expect((await first).ok).toBe(true);
    expect(t.sync.isRunning()).toBe(false);
    await t.sync.whenIdle();
  });
});

describe('never on its own', () => {
  it('shouldSyncOnStart: only linked, on, and "Sync when FunSync starts" on', () => {
    expect(shouldSyncOnStart({ enabled: true, url: SERVER.url, syncOnStart: true, pathRules: [] })).toBe(true);
    expect(shouldSyncOnStart({ enabled: true, url: SERVER.url, syncOnStart: false })).toBe(false);
    expect(shouldSyncOnStart({ enabled: false, url: SERVER.url, syncOnStart: true })).toBe(false);
    expect(shouldSyncOnStart({ enabled: true, url: '', syncOnStart: true })).toBe(false);
    expect(shouldSyncOnStart({ enabled: 'true', url: SERVER.url, syncOnStart: 'true' })).toBe(false);
    expect(shouldSyncOnStart(undefined)).toBe(false);
  });

  it('loading the library and creating the job send no request', async () => {
    const stored = storedWith([[1, 1]], { scenes: [[1, 1]] });
    const t = await setup({ scenes: [stashScene(1, 1)], videos: [1], stored });
    t.library.projection();
    t.library.status();
    expect(t.stash.listCalls).toEqual([]);
    expect(t.stash.detailCalls).toEqual([]);
    expect(t.stash.hashCalls).toEqual([]);
    expect(t.fps.calls).toEqual([]);
  });
});

describe('Sync this video', () => {
  it('links by its hash, and a linked scene Stash answers "not found" for becomes gone with its data kept', async () => {
    const t = await setup({ scenes: [stashScene(1, 1)], videos: [1] });
    const res = await t.sync.runVideo({ video: { path: vid(1) }, server: SERVER });
    expect(res).toMatchObject({ ok: true, kind: 'video', written: true });
    expect(onDisk().links[vid(1)]).toMatchObject({ sceneId: '1', by: 'oshash' });
    expect(t.stash.hashCalls).toEqual([hash(1)]);
    expect(t.stash.detailCalls).toEqual([['1']]);
    expect(t.stash.listCalls).toEqual([]);

    t.stash.scenes.delete('1');
    await t.sync.runVideo({ video: { path: vid(1) }, server: SERVER });
    expect(onDisk().links[vid(1)]).toMatchObject({ sceneId: '1', state: 'gone' });
    expect(onDisk().scenes[rk('1')]).toBeDefined();
  });

  it('a video with an open check is never auto-linked by one video\'s sync (it is not the full list)', async () => {
    const stored = storedWith([], {
      scenes: [[1, 1], [2, 1]],
      check: { [vid(1)]: { kind: 'several', sceneIds: ['1', '2'], fp: fpOf(1), seenAt: 1 } },
    });
    // Scene 2's file changed in Stash since: one video's view sees scene 1 alone.
    const t = await setup({ scenes: [stashScene(1, 1), stashScene(2, 50)], videos: [1], stored });
    await t.sync.runVideo({ video: { path: vid(1) }, server: SERVER });
    const d = onDisk();
    expect(d.links[vid(1)]).toBeUndefined();
    expect(d.check[vid(1)]).toEqual(stored.check[vid(1)]);
  });

  it('keeps a full sync\'s summary line', async () => {
    const t = await setup({ scenes: [stashScene(1, 1), stashScene(2, 2)], videos: [1, 2] });
    await t.run();
    await t.sync.runVideo({ video: { path: vid(2) }, server: SERVER });
    expect(onDisk().lastSync).toMatchObject({ kind: 'full', counts: { linked: 2 } });
  });

  it('an offline video is skipped and nothing is written', async () => {
    const t = await setup({ scenes: [stashScene(1, 1)], videos: [1], offline: [1] });
    const res = await t.sync.runVideo({ video: { path: vid(1) }, server: SERVER });
    expect(res).toMatchObject({ written: false, skipped: true });
    expect(fs.existsSync(file())).toBe(false);
    expect(t.stash.hashCalls).toEqual([]);
  });
});
