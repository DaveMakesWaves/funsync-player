/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash ids are unique only per server (Stash S1 Round 2, 2026-11-18; Dave's
// answers after Round 1, point 3). Scene 1 on the Stash on this PC and scene
// 1 on a NAS are different scenes, and FunSync keeps the data of an address
// it was pointed at before ("From your other Stash"). These tests pin that a
// sync of one server can never overwrite or stand in for another server's
// record with the same id, in storage (electron/stash-library-file.js,
// electron/stash-sync.js, electron/stash-match.js) and in the renderer
// projection (opaque ids, electron/stash-keys.js).
//
// The sync runs the REAL matcher and mapper over the recorded synthetic
// scenes (tests/fixtures/stash), with the real library file in a temp folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixtureScenes, lightScene } from '../helpers/fake-stash-server.js';

const require_ = createRequire(import.meta.url);
const { recordKey, projectedId, parseProjectedId, sameServer, serverKey } = require_('../../electron/stash-keys.js');
const { createStashLibraryFile, emptyData } = require_('../../electron/stash-library-file.js');
const { createStashSync } = require_('../../electron/stash-sync.js');
const { matchLibrary } = require_('../../electron/stash-match.js');
const { mapScene } = require_('../../electron/stash-map.js');

const A = 'http://127.0.0.1:9999';
const B = 'http://192.168.1.20:9999';
const NOW = 1795000000000;
const quiet = { warn() {}, info() {} };
const V1 = 'C:\\lib\\one.mp4';
const V2 = 'C:\\lib\\two.mp4';
const H1 = '1111111111111111';
const H2 = '2222222222222222';

let dir;
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-stash-keys-')); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

/** Fixture scene 1 as server `label` has it: its own title, one file with `oshash`. */
function rawScene(label, oshash) {
  const s = fixtureScenes().find((x) => String(x.id) === '1');
  s.title = `Scene one on ${label}`;
  s.performers = s.performers.slice(0, 1).map((p) => ({ ...p, name: `Performer one on ${label}` }));
  s.files = [{ ...s.files[0], oshash }];
  return s;
}

/** A fake client over a fixed scene list (the interface stash-sync.js documents). */
function clientFor(scenes) {
  return {
    async listScenes() { return { count: scenes.length, scenes: scenes.map(lightScene) }; },
    async sceneDetails(ids) {
      const out = {};
      for (const id of ids) out[id] = structuredClone(scenes.find((s) => String(s.id) === String(id)) || null);
      return out;
    },
    async scenesByOshash(h) { const hits = scenes.filter((s) => s.files.some((f) => f.oshash === h)); return { count: hits.length, scenes: hits.map(lightScene) }; },
  };
}

async function syncWith(lib, server, scenes, hashes) {
  const sync = createStashSync({
    library: lib,
    client: clientFor(scenes),
    fingerprint: async (v) => ({ size: 100, mtimeMs: 1, oshash: hashes[v.path] }),
    match: matchLibrary,
    mapScene,
    now: () => NOW,
    log: quiet,
  });
  return sync.run({ videos: Object.keys(hashes).map((p) => ({ path: p, size: 100, mtimeMs: 1 })), server: { url: server, version: 'v0.32.0' } });
}

describe('stash-keys', () => {
  it('a stored key names the server; the projection keeps raw ids for the data\'s own server only', () => {
    expect(recordKey(A, '12')).toBe('12@http://127.0.0.1:9999');
    expect(recordKey(`${A}/`, 12)).toBe(recordKey(A, '12'));
    expect(recordKey(A, '1@x')).toBeNull();
    expect(recordKey(A, '')).toBeNull();
    expect(projectedId(A, '12', A)).toBe('12');
    expect(projectedId(null, '12', A)).toBe('12');
    expect(projectedId(B, '12', A)).toBe('12@http://192.168.1.20:9999');
    expect(parseProjectedId('12@http://192.168.1.20:9999')).toEqual({ id: '12', server: serverKey(B) });
    expect(parseProjectedId('12')).toEqual({ id: '12', server: null });
    expect(parseProjectedId('@x')).toBeNull();
    expect(sameServer(null, A)).toBe(true);
    expect(sameServer(B, A)).toBe(false);
  });
});

describe('two servers, one id', () => {
  it('a sync of another server keeps the first server\'s scene 1 and adds its own scene 1 beside it', async () => {
    const lib = createStashLibraryFile({ dir, now: () => NOW, log: quiet });
    await lib.load();
    // Linked against the Stash on this PC: video one is its scene 1.
    expect((await syncWith(lib, A, [rawScene('A', H1)], { [V1]: H1 })).ok).toBe(true);
    // Re-pointed at the NAS: ITS scene 1 is video two. Video one is not there.
    const res = await syncWith(lib, B, [rawScene('B', H2)], { [V1]: H1, [V2]: H2 });
    expect(res.ok).toBe(true);

    const d = lib.snapshot();
    expect(d.scenes[recordKey(A, '1')].title).toBe('Scene one on A');
    expect(d.scenes[recordKey(B, '1')].title).toBe('Scene one on B');
    expect(d.links[V1]).toMatchObject({ sceneId: '1', server: A });
    expect(d.links[V2]).toMatchObject({ sceneId: '1', server: B });
    // Each scene's performer is its own server's.
    const pa = d.scenes[recordKey(A, '1')].performerIds[0];
    expect(d.performers[recordKey(A, pa)].name).toBe('Performer one on A');
    expect(d.performers[recordKey(B, pa)].name).toBe('Performer one on B');
  });

  it('the projection: data.scenes[link.sceneId] is each link\'s own scene, references included', async () => {
    const lib = createStashLibraryFile({ dir, now: () => NOW, log: quiet });
    await lib.load();
    await syncWith(lib, A, [rawScene('A', H1)], { [V1]: H1 });
    await syncWith(lib, B, [rawScene('B', H2)], { [V1]: H1, [V2]: H2 });
    const p = lib.projection();
    expect(p.server.url).toBe(B);
    // The data's own server keeps raw ids; the other server's are qualified.
    expect(p.links[V2].sceneId).toBe('1');
    expect(p.links[V1].sceneId).toBe(`1@${serverKey(A)}`);
    expect(p.links[V1].server).toBe(A);
    const one = p.scenes[p.links[V1].sceneId];
    const two = p.scenes[p.links[V2].sceneId];
    expect(one.title).toBe('Scene one on A');
    expect(two.title).toBe('Scene one on B');
    expect(p.performers[one.performerIds[0]].name).toBe('Performer one on A');
    expect(p.performers[two.performerIds[0]].name).toBe('Performer one on B');
    expect(p.studios[one.studioId]).toBeDefined();
    expect(p.studios[one.studioId].id).toBe(one.studioId);
    for (const t of one.tagIds) expect(p.tags[t]).toBeDefined();
    for (const t of two.tagIds) expect(p.tags[t]).toBeDefined();
  });
});

describe('choices and refusals belong to their server', () => {
  function stored() {
    const d = emptyData();
    d.server = { url: B, version: 'v0.32.0' };
    d.check[V1] = { kind: 'several', sceneIds: ['1', '2'], fp: { size: 100, mtimeMs: 1, oshash: H1 }, seenAt: 1, server: B };
    d.links[V2] = { sceneId: '1', server: B, by: 'oshash', fp: { size: 100, mtimeMs: 1, oshash: H2 }, linkedAt: 1, state: 'ok' };
    return d;
  }

  it('Use this scene takes the id the projection gave; another server\'s id is not a candidate', async () => {
    await fsp.writeFile(path.join(dir, 'library.json'), JSON.stringify(stored()));
    const lib = createStashLibraryFile({ dir, now: () => NOW, log: quiet });
    await lib.load();
    expect(await lib.choose(V1, `2@${serverKey(A)}`)).toMatchObject({ ok: false, error: 'not-a-candidate' });
    const res = await lib.choose(V1, lib.projection().check[V1].sceneIds[1]);
    expect(res.ok).toBe(true);
    expect(lib.snapshot().links[V1]).toMatchObject({ sceneId: '2', server: B, by: 'chosen' });
  });

  it('Not this scene records the server; Undo puts the link and refusal back exactly', async () => {
    await fsp.writeFile(path.join(dir, 'library.json'), JSON.stringify(stored()));
    const lib = createStashLibraryFile({ dir, now: () => NOW, log: quiet });
    await lib.load();
    const before = lib.snapshot();
    const res = await lib.refuse(V2, { target: 'link' });
    expect(lib.snapshot().refused[V2]).toEqual({ oshash: H2, sceneIds: ['1'], at: NOW, server: B });
    expect(lib.snapshot().links[V2]).toBeUndefined();
    await lib.restore(res.undo);
    expect(JSON.stringify(lib.snapshot().links[V2])).toBe(JSON.stringify(before.links[V2]));
    expect(lib.snapshot().refused[V2]).toBeUndefined();
  });

  it('a manual link on an empty library names the server the data belongs to', async () => {
    const lib = createStashLibraryFile({ dir, now: () => NOW, log: quiet });
    await lib.load();
    const mapped = mapScene(rawScene('A', H1), { now: NOW });
    expect((await lib.link(V1, { sceneId: '1', fp: { size: 100, mtimeMs: 1, oshash: H1 }, server: A }, mapped)).ok).toBe(true);
    const p = lib.projection();
    expect(p.server.url).toBe(A);
    expect(p.links[V1].sceneId).toBe('1');
    expect(p.scenes['1'].title).toBe('Scene one on A');
  });
});
