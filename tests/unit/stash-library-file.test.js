/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// userData/stash/library.json, owned by Electron main (Stash S1,
// notes/features/DESIGN-stash-s1.md (c), (e), (g)). Every guard here was
// checked by reopening its hole (the stage's holes.jsonl lists them).
// Real files in a temp folder; failures come from an injected fs wrapper.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { createStashLibraryFile, emptyData } = require_('../../electron/stash-library-file.js');
const { recordKey } = require_('../../electron/stash-keys.js');

const H1 = '0123456789abcdef';
const H2 = '1111222233334444';
const H3 = 'aaaabbbbccccdddd';
const SERVER = 'http://127.0.0.1:9999';
// Records are stored by server and id (Round 2: Stash ids are unique only per server).
const rk = (id, server = SERVER) => recordKey(server, id);
const NOW = new Date(2026, 10, 18, 19, 30, 0).getTime();
const quiet = { warn() {}, info() {} };
const A = 'C:\\lib\\a.mp4';
const B = 'C:\\lib\\b.mp4';
const C = 'C:\\lib\\c.mp4';
const MOVED = 'C:\\lib\\moved\\a.mp4';

let dir;
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-stash-lib-')); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

const file = () => path.join(dir, 'library.json');
const bak = () => path.join(dir, 'library.json.bak');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const onDisk = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const open = (opts = {}) => createStashLibraryFile({ dir, now: () => NOW, log: quiet, ...opts });

function scene(id, extra = {}) {
  return {
    id, title: `Synthetic Scene ${id}`, code: `SYN-00${id}`, date: '2026-11-17', director: null, details: null,
    urls: [], rating100: 80, organized: true, studioId: 's1', performerIds: ['p1'], tagIds: ['t1'],
    markers: [], stashIds: [], files: [{ path: `D:\\stash\\${id}.mp4`, size: 100, duration: 1, oshash: H1 }],
    updatedAt: '2026-11-17T10:00:00Z', fetchedAt: 1000, server: SERVER, ...extra,
  };
}

function sample() {
  const d = emptyData();
  d.rev = 3;
  d.server = { url: SERVER, version: 'v0.32.0' };
  d.links[A] = { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 100, mtimeMs: 5, oshash: H1 }, linkedAt: 1000, state: 'ok' };
  d.links[B] = { sceneId: '2', server: SERVER, by: 'manual', fp: { size: 200, mtimeMs: 6, oshash: H2 }, linkedAt: 1000, state: 'ok' };
  d.check[C] = { kind: 'several', sceneIds: ['3', '4'], fp: { size: 300, mtimeMs: 7, oshash: H3 }, seenAt: 1000 };
  for (const id of ['1', '2', '3', '4']) d.scenes[rk(id)] = scene(id);
  d.performers[rk('p1')] = { id: 'p1', name: 'Jane Doe', disambiguation: 'blonde', stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: 'abc' }], fetchedAt: 1000, server: SERVER };
  d.studios[rk('s1')] = { id: 's1', name: 'Synthetic Studio', parent: null, stashIds: [], fetchedAt: 1000, server: SERVER };
  d.tags[rk('t1')] = { id: 't1', name: 'POV', fetchedAt: 1000, server: SERVER };
  return d;
}

async function writeSample(d = sample()) {
  await fsp.writeFile(file(), JSON.stringify(d));
  return d;
}

/** fs.promises with some calls replaced. */
function fsWith(overrides) {
  return { ...fsp, ...overrides };
}

describe('load: absence and damage are never destructive', () => {
  it('a missing file is an empty library and nothing is written', async () => {
    const lib = open();
    const st = await lib.load();
    expect(st.state).toBe('empty');
    expect(st.damaged).toBeNull();
    expect(fs.existsSync(file())).toBe(false);
    expect(lib.projection().links).toEqual({});
  });

  it('a good file loads as it is, unknown fields kept for the next write', async () => {
    const d = sample();
    d.futureField = { x: 1 };
    await writeSample(d);
    const lib = open();
    expect((await lib.load()).state).toBe('loaded');
    expect(lib.snapshot().links[A].sceneId).toBe('1');
    await lib.unlink(B);
    expect(onDisk().futureField).toEqual({ x: 1 });
  });

  it('a damaged file is moved aside byte for byte, never overwritten; a later sync writes a new one', async () => {
    await fsp.writeFile(file(), '{"v":1,"links":{ broken');
    const damagedSha = sha(file());
    const lib = open();
    const st = await lib.load();
    expect(st.damaged).toEqual({ as: 'library.damaged-2026-11-18.json', reason: 'not-json' });
    const aside = path.join(dir, 'library.damaged-2026-11-18.json');
    expect(sha(aside)).toBe(damagedSha);
    expect(fs.existsSync(file())).toBe(false);

    const res = await lib.applySync((d) => { d.links[A] = { sceneId: '1', by: 'oshash', state: 'ok' }; return {}; });
    expect(res.ok).toBe(true);
    expect(onDisk().links[A].sceneId).toBe('1');
    expect(sha(aside)).toBe(damagedSha);
    expect(lib.status().damaged).toBeNull();
  });

  it('while the damaged file waits for a sync, your own changes do not write the empty copy', async () => {
    await fsp.writeFile(file(), 'not json at all');
    const lib = open();
    await lib.load();
    const res = await lib.link(A, { sceneId: '7', fp: { size: 1, mtimeMs: 1, oshash: H1 } });
    expect(res).toMatchObject({ ok: false, error: 'damaged' });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('a second damaged file the same day gets its own name', async () => {
    await fsp.writeFile(path.join(dir, 'library.damaged-2026-11-18.json'), 'first');
    await fsp.writeFile(file(), '[]');
    const lib = open();
    expect((await lib.load()).damaged.as).toBe('library.damaged-2026-11-18-2.json');
    expect(fs.readFileSync(path.join(dir, 'library.damaged-2026-11-18.json'), 'utf8')).toBe('first');
  });

  it('another version or shape is set aside too, never read as ours', async () => {
    await fsp.writeFile(file(), JSON.stringify({ v: 2, links: {} }));
    const lib = open();
    expect((await lib.load()).damaged.reason).toBe('wrong-shape');
    await fsp.writeFile(file(), JSON.stringify({ v: 1, links: [] }));
    const lib2 = open();
    expect((await lib2.load()).damaged.reason).toBe('wrong-shape');
  });

  it('a file over the size limit is refused on load and moved aside', async () => {
    await writeSample();
    const before = sha(file());
    const lib = open({ maxBytes: 200 });
    const st = await lib.load();
    expect(st.damaged).toMatchObject({ reason: 'too-large', as: 'library.damaged-2026-11-18.json' });
    expect(sha(path.join(dir, 'library.damaged-2026-11-18.json'))).toBe(before);
    expect(lib.snapshot().links).toEqual({});
  });

  it('a file that cannot be read (locked) is left where it is and nothing is written this session', async () => {
    await writeSample();
    const before = sha(file());
    const lib = open({ fsImpl: fsWith({ readFile: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } }) });
    const st = await lib.load();
    expect(st.damaged).toEqual({ as: null, reason: 'unreadable' });
    expect(st.writable).toBe(false);
    expect((await lib.applySync(() => ({}))).ok).toBe(false);
    expect(sha(file())).toBe(before);
  });
});

describe('atomic write and .bak', () => {
  it('each write bumps rev; the version it replaces becomes library.json.bak', async () => {
    const lib = open();
    await lib.load();
    await lib.applySync((d) => { d.links[A] = { sceneId: '1', by: 'oshash', state: 'ok' }; return {}; });
    expect(onDisk().rev).toBe(1);
    expect(fs.existsSync(bak())).toBe(false);
    const first = fs.readFileSync(file(), 'utf8');
    await lib.unlink(A);
    expect(onDisk().rev).toBe(2);
    expect(fs.readFileSync(bak(), 'utf8')).toBe(first);
    expect(lib.projection().rev).toBe(2);
  });

  it('never writes a file the next start would refuse as too large', async () => {
    await writeSample();
    const before = sha(file());
    const lib = open({ maxBytes: fs.statSync(file()).size + 50 });
    await lib.load();
    const res = await lib.applySync((d) => { d.scenes['9'] = { id: '9', details: 'x'.repeat(500) }; return {}; });
    expect(res).toMatchObject({ ok: false, error: 'too-large' });
    expect(sha(file())).toBe(before);
    expect(lib.snapshot().scenes['9']).toBeUndefined();
  });

  it('a failing write leaves library.json and library.json.bak intact, and memory as it was', async () => {
    await writeSample();
    await fsp.writeFile(bak(), JSON.stringify({ ...sample(), rev: 2 }));
    const fileSha = sha(file());
    const bakSha = sha(bak());
    const target = path.resolve(file());
    const failing = fsWith({
      // The commit step fails...
      rename: async (from, to) => {
        if (path.resolve(to) === target) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return fsp.rename(from, to);
      },
      // ...and so does writing straight into library.json, half way.
      open: async (p, flags) => {
        const fh = await fsp.open(p, flags);
        if (path.resolve(p) !== target) return fh;
        return {
          writeFile: async (text) => { await fh.writeFile(String(text).slice(0, 10)); throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
          sync: () => fh.sync(),
          close: () => fh.close(),
        };
      },
    });
    const lib = open({ fsImpl: failing });
    await lib.load();
    const res = await lib.unlink(A);
    expect(res).toMatchObject({ ok: false, error: 'write-failed' });
    expect(sha(file())).toBe(fileSha);
    expect(sha(bak())).toBe(bakSha);
    expect(lib.status().rev).toBe(3);
    expect(lib.snapshot().links[A].sceneId).toBe('1');
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('choose, refuse, unlink and Undo', () => {
  it('Use this scene: a check candidate becomes a chosen link; a non-candidate is refused', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    expect(await lib.choose(C, '9')).toMatchObject({ ok: false, error: 'not-a-candidate' });
    const res = await lib.choose(C, '4');
    expect(res.ok).toBe(true);
    const d = onDisk();
    expect(d.links[C]).toMatchObject({ sceneId: '4', by: 'chosen', state: 'ok', linkedAt: NOW, fp: { oshash: H3 } });
    expect(d.check[C]).toBeUndefined();
  });

  it('Not this scene, then Undo: links and refused are JSON-equal to before', async () => {
    const d0 = sample();
    d0.refused[A] = { oshash: H1, sceneIds: ['8'], at: 500 };
    await writeSample(d0);
    const lib = open();
    await lib.load();
    const before = lib.snapshot();
    const res = await lib.refuse(A);
    expect(res.ok).toBe(true);
    const after = onDisk();
    expect(after.links[A]).toBeUndefined();
    expect(after.refused[A]).toEqual({ oshash: H1, sceneIds: ['8', '1'], at: NOW, server: SERVER });

    expect((await lib.restore(res.undo)).ok).toBe(true);
    const back = onDisk();
    expect(JSON.stringify(back.links[A])).toBe(JSON.stringify(before.links[A]));
    expect(JSON.stringify(back.refused[A])).toBe(JSON.stringify(before.refused[A]));
  });

  it('Undo of a first refusal removes the refusal again', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    const res = await lib.refuse(A);
    await lib.restore(res.undo);
    expect(onDisk().refused[A]).toBeUndefined();
    expect(onDisk().links[A]).toEqual(sample().links[A]);
  });

  it('None of these refuses every candidate for this file content and clears the check', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    const res = await lib.refuse(C, { target: 'check' });
    expect(res.ok).toBe(true);
    expect(onDisk().refused[C]).toEqual({ oshash: H3, sceneIds: ['3', '4'], at: NOW, server: SERVER });
    expect(onDisk().check[C]).toBeUndefined();
    await lib.restore(res.undo);
    expect(onDisk().check[C]).toEqual(sample().check[C]);
    expect(onDisk().refused[C]).toBeUndefined();
  });

  it('a refusal of other file content is replaced, not joined', async () => {
    const d0 = sample();
    d0.refused[A] = { oshash: H2, sceneIds: ['8'], at: 500 };
    await writeSample(d0);
    const lib = open();
    await lib.load();
    await lib.refuse(A);
    expect(onDisk().refused[A]).toEqual({ oshash: H1, sceneIds: ['1'], at: NOW, server: SERVER });
  });

  it('Unlink and its Undo', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    expect(await lib.unlink(C)).toMatchObject({ ok: false, error: 'not-linked' });
    const res = await lib.unlink(A);
    expect(onDisk().links[A]).toBeUndefined();
    await lib.restore(res.undo);
    expect(onDisk().links[A]).toEqual(sample().links[A]);
  });

  it('Find in Stash…: a manual link stores the picked scene and lifts its refusal', async () => {
    const d0 = sample();
    d0.refused[C] = { oshash: H3, sceneIds: ['5', '6'], at: 500 };
    await writeSample(d0);
    const lib = open();
    await lib.load();
    const res = await lib.link(C, { sceneId: '5', fp: { size: 300, mtimeMs: 7, oshash: H3 }, server: SERVER }, {
      scene: scene('5', { fetchedAt: undefined, server: undefined }), performers: [{ id: 'p5', name: 'Kim' }], studios: [], tags: [],
    });
    expect(res.ok).toBe(true);
    const d = onDisk();
    expect(d.links[C]).toMatchObject({ sceneId: '5', by: 'manual', server: SERVER });
    expect(d.check[C]).toBeUndefined();
    expect(d.refused[C].sceneIds).toEqual(['6']);
    expect(d.scenes[rk('5')]).toMatchObject({ id: '5', title: 'Synthetic Scene 5', fetchedAt: NOW, server: SERVER });
    expect(d.performers[rk('p5')]).toMatchObject({ id: 'p5', name: 'Kim', fetchedAt: NOW, server: SERVER });
  });

  it('Undo refuses a token that is not one', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    expect((await lib.restore({ path: A, links: 'x' })).ok).toBe(false);
    expect((await lib.restore(null)).ok).toBe(false);
    expect(onDisk()).toEqual(sample());
  });
});

describe('re-home on move', () => {
  it('the link, check and refusal move together in one write; the link is marked verify', async () => {
    const d0 = sample();
    d0.refused[A] = { oshash: H1, sceneIds: ['8'], at: 500 };
    await writeSample(d0);
    const lib = open();
    await lib.load();
    const res = await lib.rehome([{ from: A, to: MOVED, keepSource: false }, { from: C, to: 'C:\\lib\\moved\\c.mp4', keepSource: false }]);
    expect(res).toMatchObject({ ok: true, moved: 2 });
    const d = onDisk();
    expect(d.rev).toBe(4);
    expect(d.links[A]).toBeUndefined();
    expect(d.refused[A]).toBeUndefined();
    expect(d.links[MOVED]).toEqual({ ...d0.links[A], verify: true });
    expect(d.refused[MOVED]).toEqual(d0.refused[A]);
    expect(d.check['C:\\lib\\moved\\c.mp4']).toEqual(d0.check[C]);
  });

  it('keepSource keeps the original (its absence is unproven)', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    await lib.rehome([{ from: A, to: MOVED, keepSource: true }]);
    expect(onDisk().links[A]).toEqual(sample().links[A]);
    expect(onDisk().links[MOVED].verify).toBe(true);
  });

  it('a destination that has Stash data is never overwritten', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    const before = sha(file());
    const res = await lib.rehome([{ from: A, to: B, keepSource: false }]);
    expect(res).toMatchObject({ ok: true, moved: 0, written: false });
    expect(sha(file())).toBe(before);
    expect(lib.snapshot().links[B]).toEqual(sample().links[B]);
  });
});

describe('the renderer projection', () => {
  it('carries only the design fields: nothing else reaches the renderer', async () => {
    const d0 = sample();
    d0.apiKey = 'sekrit-123';
    d0.fingerprints = { [A]: { size: 1, mtimeMs: 1, oshash: H1 } };
    d0.scenes[rk('1')].paths = { stream: 'http://127.0.0.1:9999/scene/1/stream' };
    d0.scenes[rk('1')].apiKey = 'sekrit-123';
    d0.links[A].key = 'sekrit-123';
    await writeSample(d0);
    const lib = open();
    await lib.load();
    const p = lib.projection();
    const text = JSON.stringify(p);
    expect(text).not.toContain('sekrit-123');
    expect(text).not.toContain('/stream');
    expect(Object.keys(p).sort()).toEqual(['check', 'lastSync', 'links', 'performers', 'refused', 'rev', 'scenes', 'server', 'studios', 'tags', 'v']);
    expect(p.links[A]).toEqual({ sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 100, mtimeMs: 5, oshash: H1 }, linkedAt: 1000, state: 'ok' });
    expect(p.scenes['1'].title).toBe('Synthetic Scene 1');
    expect(p.performers.p1).toEqual({ id: 'p1', name: 'Jane Doe', disambiguation: 'blonde', stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: 'abc' }] });
  });

  it('no string in the projection contains apikey=', async () => {
    const d0 = sample();
    d0.scenes[rk('1')].urls = ['https://example.invalid/scene/1', 'http://127.0.0.1:9999/scene/1/funscript?apikey=SECRET'];
    d0.scenes[rk('1')].title = 'http://127.0.0.1:9999/x?ApiKey=SECRET';
    await writeSample(d0);
    const lib = open();
    await lib.load();
    const text = JSON.stringify(lib.projection());
    expect(text.toLowerCase()).not.toContain('apikey=');
    expect(lib.projection().scenes['1'].urls).toEqual(['https://example.invalid/scene/1']);
  });

  it('is a copy: changing it changes nothing stored', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    lib.projection().links[A].sceneId = 'x';
    expect(lib.projection().links[A].sceneId).toBe('1');
  });
});

describe('import merge and overwrite', () => {
  it('merge: newer linkedAt wins, your link beats an imported automatic one, refusals join, check stays local', async () => {
    const local = sample();
    local.links[B].linkedAt = 1000; // manual
    local.refused[A] = { oshash: H1, sceneIds: ['8'], at: 500 };
    await writeSample(local);
    const incoming = emptyData();
    incoming.apiKey = 'sekrit-123';
    incoming.links[A] = { sceneId: '5', server: SERVER, by: 'oshash', fp: { oshash: H1 }, linkedAt: 2000, state: 'ok' }; // newer automatic: wins
    incoming.links[B] = { sceneId: '6', server: SERVER, by: 'oshash', fp: { oshash: H2 }, linkedAt: 9000, state: 'ok' }; // newer, but yours is manual
    incoming.links['C:\\lib\\new.mp4'] = { sceneId: '7', by: 'oshash', linkedAt: 1, state: 'ok' };
    incoming.refused[A] = { oshash: H1, sceneIds: ['8', '9'], at: 700 };
    incoming.check[A] = { kind: 'several', sceneIds: ['1', '5'] };
    incoming.scenes[rk('1')] = { ...scene('1'), title: 'Older', fetchedAt: 10 };
    incoming.scenes[rk('5')] = scene('5');
    incoming.performers[rk('p1')] = { id: 'p1', name: 'Newer name', fetchedAt: 5000, server: SERVER };
    const lib = open();
    await lib.load();
    expect((await lib.mergeImported(incoming)).ok).toBe(true);
    const d = onDisk();
    expect(d.links[A].sceneId).toBe('5');
    expect(d.links[B]).toEqual(local.links[B]);
    expect(d.links['C:\\lib\\new.mp4'].sceneId).toBe('7');
    expect(d.refused[A]).toEqual({ oshash: H1, sceneIds: ['8', '9'], at: 700 });
    expect(d.check).toEqual(local.check);
    expect(d.scenes[rk('1')].title).toBe('Synthetic Scene 1');
    expect(d.scenes[rk('5')]).toBeDefined();
    expect(d.performers[rk('p1')].name).toBe('Newer name');
    expect(JSON.stringify(d)).not.toContain('sekrit-123');
    expect(JSON.parse(fs.readFileSync(bak(), 'utf8'))).toEqual(local);
  });

  it('an imported manual link that is newer wins over a local automatic one; a tie keeps this machine', async () => {
    await writeSample();
    const incoming = emptyData();
    incoming.links[A] = { sceneId: '5', by: 'manual', linkedAt: 2000, state: 'ok' };
    incoming.links[C] = { sceneId: '5', by: 'oshash', linkedAt: 1, state: 'ok' };
    const lib = open();
    await lib.load();
    await lib.mergeImported(incoming);
    expect(onDisk().links[A].by).toBe('manual');
    const tie = emptyData();
    tie.links[A] = { sceneId: '9', by: 'manual', linkedAt: 2000, state: 'ok' };
    await lib.mergeImported(tie);
    expect(onDisk().links[A].sceneId).toBe('5');
  });

  it('a backup file that is not Stash data changes nothing', async () => {
    await writeSample();
    const before = sha(file());
    const lib = open();
    await lib.load();
    expect((await lib.mergeImported({ v: 7 })).ok).toBe(false);
    expect((await lib.mergeImported(null)).ok).toBe(false);
    expect(sha(file())).toBe(before);
  });

  it('overwrite: the backup replaces the file (known fields only); the old one becomes .bak', async () => {
    const local = await writeSample();
    const incoming = emptyData();
    incoming.links[C] = { sceneId: '5', by: 'oshash', linkedAt: 1, state: 'ok' };
    incoming.apiKey = 'sekrit-123';
    const lib = open();
    await lib.load();
    await lib.replaceImported(incoming);
    const d = onDisk();
    expect(Object.keys(d.links)).toEqual([C]);
    expect(d.apiKey).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(bak(), 'utf8'))).toEqual(local);
  });
});

describe('Remove Stash data… and its Undo', () => {
  it('moves the file and .bak aside; Undo puts both back', async () => {
    await writeSample();
    await fsp.writeFile(bak(), 'previous');
    const fileSha = sha(file());
    const lib = open();
    await lib.load();
    const res = await lib.removeAll();
    expect(res.ok).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(bak())).toBe(false);
    expect(lib.projection().links).toEqual({});
    expect(res.undo.removed.file).toMatch(/^library\.removed-2026-11-18T19-30-00\.json$/);

    expect((await lib.undoRemove(res.undo)).ok).toBe(true);
    expect(sha(file())).toBe(fileSha);
    expect(fs.readFileSync(bak(), 'utf8')).toBe('previous');
    expect(lib.snapshot().links[A].sceneId).toBe('1');
  });

  it('Undo after new data was written merges the removed data back (nothing new is lost), then deletes the set-aside files (guard)', async () => {
    // s1-fixup-main (review-a note): this Undo used to fail 'changed-since'
    // and leave library.removed-*.json behind for good.
    await writeSample();
    const lib = open();
    await lib.load();
    const res = await lib.removeAll();
    await lib.applySync((d) => { d.links[C] = { sceneId: '9', by: 'oshash', state: 'ok' }; return {}; });
    expect(await lib.undoRemove(res.undo)).toEqual({ ok: true, merged: true });
    const d = onDisk();
    expect(d.links[C]).toMatchObject({ sceneId: '9' }); // written after the Remove: kept
    expect(d.links[A]).toMatchObject({ sceneId: '1', by: 'oshash' }); // the removed data: back
    expect(d.links[B]).toMatchObject({ sceneId: '2', by: 'manual' });
    expect(d.scenes[rk('1')]).toMatchObject({ title: 'Synthetic Scene 1' });
    expect(lib.snapshot().links[A].sceneId).toBe('1');
    expect(fs.readdirSync(dir).sort()).toEqual(['library.json', 'library.json.bak']);
  });

  it('discard deletes only the set-aside files', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    const res = await lib.removeAll();
    await lib.discardRemoved({ removed: { ...res.undo.removed, bak: '../outside.json' } });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('an Undo that cannot put the files back keeps every set-aside file, and a second Undo works', async () => {
    await writeSample();
    await fsp.writeFile(bak(), JSON.stringify(sample()));
    let failOnce = true;
    const lib = open({
      fsImpl: fsWith({
        rename: async (from, to) => {
          // The .bak's way back fails once (a virus scanner holding it).
          if (failOnce && String(from).endsWith('.json.bak') && to === bak()) { failOnce = false; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
          return fsp.rename(from, to);
        },
      }),
    });
    await lib.load();
    const res = await lib.removeAll();
    const aside = fs.readdirSync(dir).sort();
    expect(aside).toEqual([res.undo.removed.file, res.undo.removed.bak].sort());
    expect(await lib.undoRemove(res.undo)).toEqual({ ok: false, error: 'restore-failed' });
    expect(fs.readdirSync(dir).sort()).toEqual(aside); // both still set aside, nothing half back
    expect((await lib.undoRemove(res.undo)).ok).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['library.json', 'library.json.bak']);
    expect(lib.snapshot().links[A].sceneId).toBe('1');
  });
});

describe('the previous copy is the way back (s1-fixup-main, S1RB-2)', () => {
  // The user's manual link and refusal, in library.json and its .bak.
  const withUserData = () => {
    const d = sample();
    d.refused[C] = { oshash: H3, sceneIds: ['3'], at: 900, server: SERVER };
    d.scenes[rk('2')] = scene('2', { title: 'MANUAL-LINK-SCENE' });
    return d;
  };
  const holding = (needle) => fs.readdirSync(dir).filter((n) => fs.readFileSync(path.join(dir, n), 'utf8').includes(needle)).sort();
  const syncWrite = (lib, at) => lib.applySync((d) => { d.lastSync = { at, kind: 'full', ok: true, partial: false, error: null, counts: {} }; return {}; });

  it('a damaged library.json: the .bak is loaded, and it survives every write until a whole new file exists (guard)', async () => {
    await fsp.writeFile(bak(), JSON.stringify(withUserData()));
    await fsp.writeFile(file(), Buffer.alloc(4096)); // a torn write: NUL bytes
    const lib = open();
    const st = await lib.load();
    expect(st.damaged).toEqual({ as: 'library.damaged-2026-11-18.json', reason: 'not-json' });
    expect(st.recovered).toEqual({ from: 'library.json.bak', reason: 'not-json' });
    expect(lib.snapshot().links[B]).toMatchObject({ sceneId: '2', by: 'manual' });
    expect(lib.projection().refused[C]).toMatchObject({ sceneIds: ['3'] });
    expect(holding('MANUAL-LINK-SCENE')).toEqual(['library.json.bak']); // load wrote nothing
    // "Sync to rebuild it", then anything else: the user's data is in a file all along.
    await syncWrite(lib, 4);
    expect(holding('MANUAL-LINK-SCENE')).toEqual(['library.json', 'library.json.bak']);
    await syncWrite(lib, 5);
    expect(holding('MANUAL-LINK-SCENE')).toEqual(['library.json', 'library.json.bak']);
    expect(onDisk().refused[C]).toMatchObject({ sceneIds: ['3'] });
  });

  it('a recovered copy is real data: your own changes are written (an empty copy after damage still waits for a sync)', async () => {
    await fsp.writeFile(bak(), JSON.stringify(withUserData()));
    await fsp.writeFile(file(), '{"v":1,"links":{ broken');
    const lib = open();
    await lib.load();
    expect((await lib.unlink(A)).ok).toBe(true);
    expect(onDisk().links[A]).toBeUndefined();
    expect(onDisk().links[B]).toMatchObject({ by: 'manual' });
  });

  it('a MISSING library.json: the .bak is loaded, nothing is written at load, and it survives two writes (guard)', async () => {
    await fsp.writeFile(bak(), JSON.stringify(withUserData()));
    const bakSha = sha(bak());
    const lib = open();
    const st = await lib.load();
    expect(st.state).toBe('empty'); // no library.json until the next write
    expect(st.damaged).toBeNull();
    expect(st.recovered).toEqual({ from: 'library.json.bak', reason: 'missing' });
    expect(fs.readdirSync(dir)).toEqual(['library.json.bak']);
    expect(lib.snapshot().links[B]).toMatchObject({ by: 'manual' });
    await syncWrite(lib, 4);
    expect(sha(bak())).toBe(bakSha); // the first write leaves the .bak alone
    await syncWrite(lib, 5);
    expect(holding('MANUAL-LINK-SCENE')).toEqual(['library.json', 'library.json.bak']);
  });

  it('after a damaged or missing load, a library.json this session did not write never replaces the .bak (guard)', async () => {
    await fsp.writeFile(bak(), JSON.stringify(withUserData()));
    const bakSha = sha(bak());
    const lib = open();
    await lib.load(); // missing: the .bak's data is in memory
    // Something else puts a file there meanwhile (a sync tool, a half restore).
    await fsp.writeFile(file(), Buffer.alloc(512));
    await syncWrite(lib, 4);
    expect(sha(bak())).toBe(bakSha); // the last good copy is still the .bak
    expect(onDisk().links[B]).toMatchObject({ by: 'manual' });
    await syncWrite(lib, 5); // a file this session wrote may become the .bak now
    expect(holding('MANUAL-LINK-SCENE')).toEqual(['library.json', 'library.json.bak']);
  });

  it('an unusable .bak is not loaded: the library starts empty, as before', async () => {
    await fsp.writeFile(bak(), 'not json');
    const lib = open();
    const st = await lib.load();
    expect(st.recovered).toBeNull();
    expect(lib.snapshot().links).toEqual({});
  });
});

describe('a refusal wins over an imported link (s1-fixup-main, S1RB-3)', () => {
  it('merge never brings back a link to a scene refused for that file content (guard)', async () => {
    const backup = sample(); // made before "Not this scene" on A
    const d = sample();
    delete d.links[A];
    d.refused[A] = { oshash: H1, sceneIds: ['1'], at: 2000, server: SERVER };
    await writeSample(d);
    const lib = open();
    await lib.load();
    expect((await lib.mergeImported(backup)).ok).toBe(true);
    expect(onDisk().links[A]).toBeUndefined();
    expect(onDisk().refused[A]).toMatchObject({ sceneIds: ['1'] });
  });

  it('an imported refusal removes an automatic link here; a link you made here stays; other content is not refused', async () => {
    const d = sample();
    d.links[C] = { sceneId: '3', server: SERVER, by: 'oshash', fp: { size: 300, mtimeMs: 7, oshash: H2 }, linkedAt: 1000, state: 'ok' };
    await writeSample(d);
    const backup = emptyData();
    backup.server = { url: SERVER, version: null };
    backup.refused[A] = { oshash: H1, sceneIds: ['1'], at: 3000, server: SERVER };
    backup.refused[B] = { oshash: H2, sceneIds: ['2'], at: 3000, server: SERVER };
    backup.refused[C] = { oshash: H3, sceneIds: ['3'], at: 3000, server: SERVER }; // another content than C's link
    const lib = open();
    await lib.load();
    await lib.mergeImported(backup);
    const now = onDisk();
    expect(now.links[A]).toBeUndefined(); // automatic, refused for its content
    expect(now.links[B]).toMatchObject({ sceneId: '2', by: 'manual' }); // yours
    expect(now.links[C]).toMatchObject({ sceneId: '3' }); // the refusal is about other content
  });
});

describe('Not this scene… names its scene (s1-fixup-main, RA-S1-3)', () => {
  it('the link changed under the confirm: only the named scene is refused, the current link stays, and it is reported (guard)', async () => {
    const d = sample();
    d.links[A] = { ...d.links[A], sceneId: '4' }; // re-linked 1 -> 4 while the confirm was open
    await writeSample(d);
    const lib = open();
    await lib.load();
    const res = await lib.refuse(A, { target: 'link', sceneId: '1' });
    expect(res).toMatchObject({ ok: true, linkChanged: true, linkedSceneId: '4' });
    expect(onDisk().refused[A]).toEqual({ oshash: H1, sceneIds: ['1'], at: NOW, server: SERVER });
    expect(onDisk().links[A]).toMatchObject({ sceneId: '4', state: 'ok' });
    // Undo puts the refusal back as it was (none)
    expect((await lib.restore(res.undo)).ok).toBe(true);
    expect(onDisk().refused[A]).toBeUndefined();
    expect(onDisk().links[A]).toMatchObject({ sceneId: '4' });
  });

  it('the named scene is still linked: refused and unlinked as before; nothing linked or offered any more: changed-since', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    const res = await lib.refuse(A, { target: 'link', sceneId: '1' });
    expect(res.ok).toBe(true);
    expect(res.linkChanged).toBeUndefined();
    expect(onDisk().links[A]).toBeUndefined();
    expect(onDisk().refused[A]).toMatchObject({ sceneIds: ['1'] });
    const other = 'C:\\lib\\none.mp4';
    expect(await lib.refuse(other, { target: 'link', sceneId: '1' })).toEqual({ ok: false, error: 'changed-since' });
    expect(await lib.refuse(A, { target: 'check', sceneId: '1' })).toEqual({ ok: false, error: 'bad-input' });
  });

  it('a link stored without an oshash is refused with the content hash main gives, never "no-fingerprint" then', async () => {
    const d = sample();
    d.links[B] = { ...d.links[B], fp: { size: 200, mtimeMs: 6, oshash: null } };
    await writeSample(d);
    const lib = open();
    await lib.load();
    expect(await lib.refuse(B, { target: 'link', sceneId: '2' })).toEqual({ ok: false, error: 'no-fingerprint' });
    expect((await lib.refuse(B, { target: 'link', sceneId: '2', oshash: H2.toUpperCase() })).ok).toBe(true);
    expect(onDisk().refused[B]).toMatchObject({ oshash: H2, sceneIds: ['2'] });
  });

  it('Unlink names its scene too: another scene linked now is left alone', async () => {
    await writeSample();
    const lib = open();
    await lib.load();
    expect(await lib.unlink(A, { sceneId: '7' })).toEqual({ ok: false, error: 'changed-since' });
    expect(onDisk().links[A]).toMatchObject({ sceneId: '1' });
    expect((await lib.unlink(A, { sceneId: '1' })).ok).toBe(true);
    expect(onDisk().links[A]).toBeUndefined();
  });
});

describe('a link knows its scene\'s files (s1-fixup-main, S1RB-4)', () => {
  it('Find in Stash… and Use this scene keep the scene\'s file hashes; the projection says sceneChanged only for a changed link', async () => {
    const d = sample();
    d.links[MOVED] = { sceneId: '2', server: SERVER, by: 'oshash', fp: { size: 1, mtimeMs: 1, oshash: H2 }, linkedAt: 1, state: 'changed', sceneChanged: true };
    d.links[B] = { ...d.links[B], sceneChanged: true }; // state ok: not projected
    await writeSample(d);
    const lib = open();
    await lib.load();
    const REENCODE = 'C:\\lib\\re-encode.mp4';
    await lib.link(REENCODE, { sceneId: '5', fp: { size: 1, mtimeMs: 1, oshash: H2 }, server: SERVER }, { scene: scene('5', { files: [{ path: '/data/stash/5.mp4', size: 1, duration: 1, oshash: H3 }] }) });
    expect(onDisk().links[REENCODE].sceneHashes).toEqual([H3]);
    await lib.choose(C, '3');
    expect(onDisk().links[C]).toMatchObject({ by: 'chosen', sceneHashes: [H1] });
    const proj = lib.projection();
    expect(proj.links[MOVED].sceneChanged).toBe(true);
    expect(proj.links[B].sceneChanged).toBeUndefined();
    expect(proj.links[C].sceneHashes).toBeUndefined(); // not a renderer field
  });
});

