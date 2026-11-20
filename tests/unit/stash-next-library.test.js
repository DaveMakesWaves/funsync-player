/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash "next" lot (2026-11-19, stage sn-main): what library.json keeps of
// the new fields and what the renderer's projection carries
// (electron/stash-library-file.js; contract: RULES-S1-NEXT.txt and
// SCRATCH/sn-main/contract-notes.txt). The data file is the real one in a
// temp folder; the scenes are the local test Stash's (sn-scene-details).
//
// Guards checked by reopening their hole (SCRATCH/sn-main/holes.jsonl):
//   - a Group's scenes are in Stash's order (scene_index), not scene-id
//     order (hole: sort by id: Group A becomes 1, 2, 3 instead of 2, 3, 1)
//   - a Group goes ONLY after a complete sync shows it gone (hole: remove
//     it on any sync)
//   - a record without a field projects WITHOUT it (hole: project 0 plays)
//   - tagRules only when the caller asks (the opt-in) (hole: always)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  createStashLibraryFile, buildProjection, refreshGroups, storeTagTree, mergeLibraryData, emptyData,
} = require_('../../electron/stash-library-file.js');
const { mapScene, mapTagPage } = require_('../../electron/stash-map.js');
const { recordKey } = require_('../../electron/stash-keys.js');

const SERVER = 'http://127.0.0.1:9999';
const OTHER = 'http://nas.lan:9999';
const T0 = 1763500000000;
const fixture = (name) => JSON.parse(fs.readFileSync(`tests/fixtures/stash/${name}`, 'utf8'));
const DETAILS = fixture('sn-scene-details.response.json').body.data;
const TAGS = mapTagPage(fixture('sn-tag-list.response.json').body.data.findTags).tags;
const sceneRaw = (id) => Object.values(DETAILS).find((s) => s && s.id === String(id));
const quiet = { warn() {}, info() {} };
const vid = (n) => `C:\\lib\\video ${n}.mp4`;

let dir;
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-stash-next-lib-')); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

async function open(now = () => T0) {
  const lib = createStashLibraryFile({ dir, now, log: quiet });
  await lib.load();
  return lib;
}

/** Store scene `id` of the test Stash for `server` (as the sync does) and link video n to it. */
function storeLinked(d, id, n, { server = SERVER, at = T0, state = 'ok' } = {}) {
  const { scene } = mapScene(sceneRaw(id), { now: at });
  d.scenes[recordKey(server, scene.id)] = { ...scene, id: scene.id, fetchedAt: at, server };
  d.links[vid(n)] = { sceneId: scene.id, server, by: 'oshash', fp: null, linkedAt: at, state };
  if (!d.server) d.server = { url: server, version: 'v0.32.0' };
}

describe('Groups as read-only playlists, kept in sync (Dave, 2026-11-19)', () => {
  it('each Group of a linked scene, its scenes in Stash\'s order by scene_index, NOT by id (guard)', () => {
    const d = emptyData();
    for (const [id, n] of [[1, 1], [2, 2], [3, 3], [4, 4]]) storeLinked(d, id, n);
    refreshGroups(d, SERVER, T0, { complete: true });
    expect(d.groups[recordKey(SERVER, '1')]).toMatchObject({ id: '1', name: 'Synthetic Series A', sceneIds: ['2', '3', '1'], updatedAt: T0, server: SERVER });
    expect(d.groups[recordKey(SERVER, '2')]).toMatchObject({ id: '2', name: 'Synthetic Series B', sceneIds: ['4', '1'] });
    expect(buildProjection(d).groups).toEqual({
      1: { id: '1', name: 'Synthetic Series A', sceneIds: ['2', '3', '1'], updatedAt: T0, server: SERVER },
      2: { id: '2', name: 'Synthetic Series B', sceneIds: ['4', '1'], updatedAt: T0, server: SERVER },
    });
  });

  it('only scenes a link in state ok points at count (a gone or changed link does not)', () => {
    const d = emptyData();
    storeLinked(d, 1, 1);
    storeLinked(d, 2, 2, { state: 'gone' });
    storeLinked(d, 3, 3, { state: 'changed' });
    refreshGroups(d, SERVER, T0, { complete: true });
    expect(d.groups[recordKey(SERVER, '1')].sceneIds).toEqual(['1']);
  });

  it('a Group no linked scene has now stays after a partial sync and goes after a complete one (guard)', () => {
    const d = emptyData();
    storeLinked(d, 4, 4); // Group B (2) only
    storeLinked(d, 2, 2); // Group A (1)
    refreshGroups(d, SERVER, T0, { complete: true });
    expect(Object.keys(d.groups).sort()).toEqual([recordKey(SERVER, '1'), recordKey(SERVER, '2')]);
    delete d.links[vid(4)]; // scene 4 no longer linked
    refreshGroups(d, SERVER, T0 + 1, { complete: false });
    expect(d.groups[recordKey(SERVER, '2')]).toMatchObject({ name: 'Synthetic Series B', sceneIds: ['4'], updatedAt: T0 });
    refreshGroups(d, SERVER, T0 + 2, { complete: true });
    expect(d.groups[recordKey(SERVER, '2')]).toBeUndefined();
    expect(d.groups[recordKey(SERVER, '1')]).toMatchObject({ sceneIds: ['2'] });
  });

  it('renamed or reordered: updated (updatedAt moves only then); another server\'s Group with the same id is never touched', () => {
    const d = emptyData();
    storeLinked(d, 2, 2);
    storeLinked(d, 3, 3);
    storeLinked(d, 1, 5, { server: OTHER }); // the NAS's group 1 is another Group
    refreshGroups(d, OTHER, T0, { complete: true });
    refreshGroups(d, SERVER, T0, { complete: true });
    expect(d.groups[recordKey(OTHER, '1')].sceneIds).toEqual(['1']);
    refreshGroups(d, SERVER, T0 + 5, { complete: true });
    expect(d.groups[recordKey(SERVER, '1')]).toMatchObject({ sceneIds: ['2', '3'], updatedAt: T0, seenAt: T0 + 5 });
    // Stash renames the Group and moves scene 3 first.
    const s3 = d.scenes[recordKey(SERVER, '3')];
    s3.groups = [{ id: '1', name: 'Series A (remastered)', sceneIndex: 0 }];
    s3.activityAt = T0 + 9;
    refreshGroups(d, SERVER, T0 + 9, { complete: true });
    expect(d.groups[recordKey(SERVER, '1')]).toMatchObject({ name: 'Series A (remastered)', sceneIds: ['3', '2'], updatedAt: T0 + 9 });
    expect(d.groups[recordKey(OTHER, '1')]).toMatchObject({ sceneIds: ['1'], updatedAt: T0 });
    const proj = buildProjection(d);
    expect(proj.groups['1'].name).toBe('Series A (remastered)');
    expect(proj.groups[`1@${OTHER}`]).toMatchObject({ id: `1@${OTHER}`, sceneIds: [`1@${OTHER}`], server: OTHER });
  });

  it('nothing known about Groups: no groups map at all (unknown); scenes that say "none": an empty one', () => {
    const d = emptyData();
    refreshGroups(d, SERVER, T0, { complete: true });
    expect(d.groups).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(buildProjection(d), 'groups')).toBe(false);
    storeLinked(d, 5, 5); // in no Group
    refreshGroups(d, SERVER, T0, { complete: true });
    expect(d.groups).toEqual({});
    expect(buildProjection(d).groups).toEqual({});
  });

  it('linking a scene by hand (Find in Stash…) brings its Groups in at once', async () => {
    const lib = await open();
    const records = mapScene(sceneRaw(1), { now: T0 });
    expect((await lib.link(vid(1), { sceneId: '1', fp: null, server: SERVER }, records)).ok).toBe(true);
    expect(lib.projection().groups).toMatchObject({ 1: { sceneIds: ['1'] }, 2: { sceneIds: ['1'] } });
  });
});

describe('the scene projection: the new fields, and "unknown" stays unknown', () => {
  it('a record from the next lot projects plays, last play, O-count, phash and its Groups', () => {
    const d = emptyData();
    storeLinked(d, 1, 1);
    const p = buildProjection(d).scenes['1'];
    expect(p).toMatchObject({
      rating100: 80, organized: true, playCount: 1, lastPlayedAt: '2026-09-30T23:10:00.000Z', oCounter: 1, phash: '8a7da502fa0aeb6a',
      groups: [{ groupId: '1', sceneIndex: 3 }, { groupId: '2', sceneIndex: 2 }],
    });
  });

  it('an older record (S1, no next-lot fields) projects without them: never 0 plays or no Group (guard)', async () => {
    const old = emptyData();
    old.server = { url: SERVER, version: 'v0.32.0' };
    old.scenes[recordKey(SERVER, '7')] = { id: '7', server: SERVER, title: 'x', rating100: null, organized: false, fetchedAt: T0 };
    old.links[vid(7)] = { sceneId: '7', server: SERVER, by: 'oshash', state: 'ok' };
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(old));
    const lib = await open();
    const s = lib.projection().scenes['7'];
    for (const k of ['playCount', 'lastPlayedAt', 'oCounter', 'phash', 'groups']) expect(Object.prototype.hasOwnProperty.call(s, k), k).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(lib.projection(), 'groups')).toBe(false);
  });

  it('a hand-edited record is checked again: junk projects as absent, never as a value', () => {
    const d = emptyData();
    d.server = { url: SERVER, version: null };
    d.scenes[recordKey(SERVER, '1')] = {
      id: '1', server: SERVER, playCount: -3, oCounter: '2', lastPlayedAt: 'last tuesday', phash: 'xyz', groups: [{ id: '../x' }, { id: '9', sceneIndex: 1.5 }],
    };
    const p = buildProjection(d).scenes['1'];
    for (const k of ['playCount', 'oCounter', 'lastPlayedAt', 'phash']) expect(Object.prototype.hasOwnProperty.call(p, k), k).toBe(false);
    expect(p.groups).toEqual([{ groupId: '9', sceneIndex: null }]);
  });

  it('a groups map that is not a map (hand edit) is not read and does not make the file "damaged"', async () => {
    const d = emptyData();
    d.groups = 'oops';
    d.tagTrees = [1, 2];
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(d));
    const lib = await open();
    expect(lib.status().damaged).toBeNull();
    expect(lib.status().state).toBe('loaded');
    const proj = lib.projection({ tagRules: true });
    expect(Object.prototype.hasOwnProperty.call(proj, 'groups')).toBe(false);
    expect(proj.tagRules).toEqual({ aliases: {}, children: {}, names: {} });
  });
});

describe('tag rules: stored per server, projected only when asked (the opt-in)', () => {
  it('the projection carries tagRules only with {tagRules: true} (guard), from the data\'s own server', () => {
    const d = emptyData();
    d.server = { url: SERVER, version: null };
    storeTagTree(d, SERVER, TAGS, T0);
    storeTagTree(d, OTHER, [{ id: '1', name: 'Other Tag', aliases: ['ot'], parentIds: [] }], T0);
    expect(Object.prototype.hasOwnProperty.call(buildProjection(d), 'tagRules')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(buildProjection(d, { tagRules: false }), 'tagRules')).toBe(false);
    const rules = buildProjection(d, { tagRules: true }).tagRules;
    expect(rules.aliases['synthetic-a']).toBe('synthetic-tag-a');
    expect(rules.aliases.ot).toBeUndefined();
    expect(rules.children['synthetic-grandparent-tag']).toEqual(['synthetic-parent-tag', 'synthetic-tag-b']);
  });

  it('a new complete list replaces only its own server\'s tree', () => {
    const d = emptyData();
    storeTagTree(d, SERVER, TAGS, T0);
    storeTagTree(d, OTHER, [{ id: '1', name: 'Other Tag', aliases: [], parentIds: [] }], T0);
    storeTagTree(d, SERVER, [{ id: '9', name: 'Only', aliases: [], parentIds: [] }], T0 + 1);
    expect(Object.keys(d.tagTrees['http://127.0.0.1:9999'].tags)).toEqual(['9']);
    expect(Object.keys(d.tagTrees['http://nas.lan:9999'].tags)).toEqual(['1']);
  });

  it('the library caches each projection apart: asking without rules after with them gives none', async () => {
    const lib = await open();
    await lib.applySync((d) => { d.server = { url: SERVER, version: null }; storeTagTree(d, SERVER, TAGS, T0); return {}; });
    expect(lib.projection({ tagRules: true }).tagRules.names['synthetic-tag-a']).toBe('Synthetic Tag A');
    expect(lib.projection().tagRules).toBeUndefined();
    expect(lib.projection({ tagRules: true }).tagRules).toBeDefined();
  });
});

describe('touch(): the projection changed without the data changing', () => {
  it('moves rev on in memory, tells the listeners, writes nothing; the next write continues from it', async () => {
    const lib = await open();
    await lib.applySync((d) => { storeLinked(d, 1, 1); return {}; });
    const file = path.join(dir, 'library.json');
    const sha = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = sha();
    const rev = lib.status().rev;
    let heard = 0;
    lib.onChange(() => { heard += 1; });
    expect(await lib.touch()).toEqual({ ok: true, rev: rev + 1 });
    expect(heard).toBe(1);
    expect(lib.status().rev).toBe(rev + 1);
    expect(lib.projection().rev).toBe(rev + 1);
    expect(sha()).toBe(before);
    await lib.applySync(() => ({}));
    expect(lib.status().rev).toBe(rev + 2);
  });
});

describe('backups: the next lot\'s maps travel with the Stash data', () => {
  it('merge: the tag trees are a union (the newer winning); the backup\'s Groups are not taken (sn-fixup SN-R4: rebuilt from the merged scenes)', () => {
    const local = emptyData();
    const incoming = emptyData();
    local.groups = { [recordKey(SERVER, '1')]: { id: '1', server: SERVER, name: 'Mine', sceneIds: ['2'], updatedAt: 5, seenAt: 10 } };
    incoming.groups = {
      [recordKey(SERVER, '1')]: { id: '1', server: SERVER, name: 'Older', sceneIds: ['3'], updatedAt: 1, seenAt: 2 },
      [recordKey(SERVER, '2')]: { id: '2', server: SERVER, name: 'B', sceneIds: ['4'], updatedAt: 1, seenAt: 2 },
    };
    incoming.tagTrees = { 'http://127.0.0.1:9999': { server: SERVER, at: 3, tags: { 1: { name: 'A', aliases: [], parentIds: [] } } } };
    mergeLibraryData(local, incoming, { at: 20 });
    expect(local.groups[recordKey(SERVER, '1')].name).toBe('Mine');
    // No linked scene names Group 2: the backup's entry alone does not bring it back.
    expect(local.groups[recordKey(SERVER, '2')]).toBeUndefined();
    expect(local.tagTrees['http://127.0.0.1:9999'].at).toBe(3);
  });

  it('overwrite import keeps the backup\'s Groups and tag trees', async () => {
    const lib = await open();
    const backup = emptyData();
    backup.groups = { [recordKey(SERVER, '1')]: { id: '1', server: SERVER, name: 'A', sceneIds: [], updatedAt: 1, seenAt: 1 } };
    backup.tagTrees = { 'http://127.0.0.1:9999': { server: SERVER, at: 1, tags: {} } };
    expect((await lib.replaceImported(backup)).ok).toBe(true);
    expect(lib.snapshot().groups).toEqual(backup.groups);
    expect(lib.snapshot().tagTrees).toEqual(backup.tagTrees);
  });
});
