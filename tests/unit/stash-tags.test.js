/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// renderer/js/stash-tags.js (Stash S1, Round 1 stage 1d, 2026-11-18;
// notes/features/DESIGN-stash-s1.md (c) "The renderer's copy and the stash
// tag source", "Performers and studios split by Stash ID"; (g) "Trust
// check", "Turned off", "No URL from Stash stored").
//
// Pinned here, each by what a reader sees:
//   - stashIdentity: StashDB's Stash ID first, then by endpoint, lower case;
//     else `d-<disambiguation>`; else none;
//   - stashTagRecords: the engine's `stash` source; only `ok` and `gone`
//     links whose fingerprint size equals the scanned size (unknown sizes
//     trusted); nothing at all unless `enabled` is true; the data is never
//     changed; no URL Stash made is copied;
//   - nameIdentities: a name maps to an identity only when it is the ONLY
//     one Stash has for that name;
//   - stashVideoView: the dialog's states (check, changed, gone, linked,
//     refused, not in Stash, not synced) and their fields.
// Every value is synthetic; stash_ids use stash-box.invalid or synthetic UUIDs.
import { describe, it, expect } from 'vitest';
import {
  stashIdentity, stashTagRecords, nameIdentities, stashVideoView, STASHDB_HOST, TRUSTED_STATES,
} from '../../renderer/js/stash-tags.js';

const A = 'C:/Lib/Alpha Scene.mp4';
const B = 'C:/Lib/Bravo Take.mp4';
const C = 'C:/Lib/Charlie Cut.mp4';
const D = 'C:/Lib/Copies/Alpha Scene.mp4';
const E = 'C:/Lib/Echo Twice.mp4';
const F = 'C:/Lib/Foxtrot Refused.mp4';
const G = 'C:/Lib/Golf Unknown.mp4';

const OSH_A = 'aaaa000000000001';
const SERVER = 'http://127.0.0.1:9999';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function makeData() {
  return {
    v: 1,
    rev: 3,
    server: { url: SERVER, version: 'v0.32.0' },
    lastSync: { at: 1763400000000, kind: 'full', ok: true, partial: false, error: null, counts: { linked: 4 } },
    links: {
      [A]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 1, oshash: OSH_A }, linkedAt: 1, state: 'ok' },
      [B]: { sceneId: '2', server: SERVER, by: 'chosen', fp: { size: 2000, mtimeMs: 1, oshash: 'bbbb000000000002' }, linkedAt: 2, state: 'gone' },
      [C]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 3000, mtimeMs: 1, oshash: 'cccc000000000003' }, linkedAt: 3, state: 'changed' },
      [D]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 9, oshash: OSH_A }, linkedAt: 4, state: 'ok' },
      [G]: { sceneId: '2', server: 'http://192.0.2.10:9999/', by: 'manual', fp: { oshash: 'gggg000000000007' }, linkedAt: 5, state: 'ok' },
    },
    check: {
      [E]: { kind: 'several', sceneIds: ['1', '2'], fp: { size: 5000, mtimeMs: 1, oshash: 'bbbb000000000002' }, seenAt: 6 },
    },
    refused: {
      [F]: { oshash: 'ffff000000000006', sceneIds: ['2'], at: 7 },
    },
    scenes: {
      1: {
        id: '1',
        title: 'Synthetic Scene Small',
        code: 'SYN-001',
        date: '2026-11-17',
        director: 'Synthetic Director',
        details: 'A synthetic description.',
        urls: ['https://example.invalid/scene/1'],
        rating100: 80,
        organized: true,
        studioId: 's1',
        performerIds: ['p1', 'p2', 'p-missing'],
        tagIds: ['t1', 't2', 't-missing', 't1'],
        markers: [
          { id: 'm2', title: 'Synthetic Tag B', seconds: 4, endSeconds: null, tag: 'Synthetic Tag B' },
          { id: 'm1', title: 'Synthetic marker one', seconds: 1, endSeconds: 2, tag: 'Synthetic Tag A' },
        ],
        stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: 'scene-0001' }],
        files: [{ path: '/data/videos/scene_a.mp4', size: 1000, duration: 10.5, oshash: OSH_A }],
        updatedAt: '2026-11-18T10:00:00Z',
        fetchedAt: 1763450000000,
      },
      2: {
        id: '2',
        title: 'Synthetic Scene Two',
        date: '2026-11-16',
        studioId: 's2',
        performerIds: ['p3'],
        tagIds: ['t2'],
        markers: [],
        files: [{ path: '/data/videos/scene_b.mp4', size: 2000, duration: 30, oshash: 'bbbb000000000002' }],
        fetchedAt: 1763450000000,
      },
    },
    performers: {
      p1: { id: 'p1', name: 'Jane Doe', disambiguation: 'blonde', stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: '0B5E1C9A-0000-4000-8000-00000000AAAA' }] },
      p2: { id: 'p2', name: 'Sam Roe', disambiguation: '', stashIds: [] },
      p3: { id: 'p3', name: 'Jane Doe', disambiguation: '', stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: '0b5e1c9a-0000-4000-8000-000000003f2a' }] },
    },
    studios: {
      s1: { id: 's1', name: 'Synthetic Studio', parent: 'Synthetic Network', stashIds: [] },
      s2: { id: 's2', name: 'Studio Two', parent: null, stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: '5d1e0000-0000-4000-8000-00000000c0de' }] },
    },
    tags: {
      t1: { id: 't1', name: 'POV' },
      t2: { id: 't2', name: 'Synthetic Tag B' },
    },
  };
}

const VIDEOS = [
  { path: A, size: 1000 }, { path: B, size: 2000 }, { path: C, size: 3000 }, { path: D, size: 1000 },
  { path: E, size: 5000 }, { path: F }, { path: G },
];

describe('stashIdentity: who a performer or studio is', () => {
  it('a Stash ID, lower case; StashDB first even when listed later, then by endpoint', () => {
    expect(stashIdentity({ stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: 'ABC-1' }] })).toBe('abc-1');
    expect(stashIdentity({
      stashIds: [
        { endpoint: 'https://zz.stash-box.invalid/graphql', stashId: 'zz-1' },
        { endpoint: 'https://aa.stash-box.invalid/graphql', stashId: 'aa-1' },
        { endpoint: `https://${STASHDB_HOST}/graphql`, stashId: 'DB-1' },
      ],
    })).toBe('db-1');
    expect(stashIdentity({
      stashIds: [
        { endpoint: 'https://zz.stash-box.invalid/graphql', stashId: 'zz-1' },
        { endpoint: 'https://aa.stash-box.invalid/graphql', stashId: 'aa-1' },
      ],
    })).toBe('aa-1');
  });

  it('no Stash ID: d-<disambiguation>; neither: none (it merges by name)', () => {
    expect(stashIdentity({ stashIds: [], disambiguation: 'Blonde, 90s' })).toBe('d-blonde,-90s');
    expect(stashIdentity({ stashIds: [], disambiguation: '  ' })).toBeNull();
    expect(stashIdentity({ name: 'Jane Doe' })).toBeNull();
    expect(stashIdentity(null)).toBeNull();
  });

  it('an unusable Stash ID is skipped, and a # in one never survives', () => {
    expect(stashIdentity({ stashIds: [{ endpoint: 'x', stashId: '\ud83d' }, { endpoint: 'y', stashId: 'ok-2' }] })).toBe('ok-2');
    expect(stashIdentity({ stashIds: [{ endpoint: 'x', stashId: 42 }], disambiguation: 'tall' })).toBe('d-tall');
    expect(stashIdentity({ stashIds: [{ endpoint: 'x', stashId: 'a'.repeat(300) }] })).toBeNull();
    expect(stashIdentity({ stashIds: [{ endpoint: 'x', stashId: 'ab#cd' }] })).toBe('ab-cd');
  });
});

describe('stashTagRecords: the engine\'s `stash` source', () => {
  it('turned off, never set up, or no data: nothing (Turned off)', () => {
    const data = makeData();
    expect(stashTagRecords(data, { videos: VIDEOS, enabled: false })).toEqual({});
    expect(stashTagRecords(data, { videos: VIDEOS })).toEqual({});
    expect(stashTagRecords(data, { videos: VIDEOS, enabled: 'yes' })).toEqual({});
    expect(stashTagRecords(null, { enabled: true })).toEqual({});
    expect(stashTagRecords({ v: 1 }, { enabled: true })).toEqual({});
  });

  it('a linked video gets its scene\'s tags, performers (with identity) and studio', () => {
    const out = stashTagRecords(makeData(), { videos: VIDEOS, enabled: true });
    expect(out[A]).toEqual({
      tags: [{ id: 't1', name: 'POV' }, { id: 't2', name: 'Synthetic Tag B' }],
      performers: [
        { id: 'p1', name: 'Jane Doe', identity: '0b5e1c9a-0000-4000-8000-00000000aaaa', disambiguation: 'blonde' },
        { id: 'p2', name: 'Sam Roe' },
      ],
      studio: { id: 's1', name: 'Synthetic Studio' },
    });
  });

  it('a gone scene keeps its tags; a changed link gives none', () => {
    const out = stashTagRecords(makeData(), { videos: VIDEOS, enabled: true });
    expect(out[B].tags).toEqual([{ id: 't2', name: 'Synthetic Tag B' }]);
    expect(out[B].studio).toEqual({ id: 's2', name: 'Studio Two', identity: '5d1e0000-0000-4000-8000-00000000c0de' });
    expect(C in out).toBe(false);
    expect(TRUSTED_STATES).toEqual(['ok', 'gone']);
  });

  it('Trust check: a fingerprint size other than the scanned size gives no tags; the record stays', () => {
    const data = deepFreeze(makeData());
    const before = JSON.stringify(data);
    const swapped = VIDEOS.map((v) => (v.path === A ? { ...v, size: 1001 } : v));
    const out = stashTagRecords(data, { videos: swapped, enabled: true });
    expect(A in out).toBe(false);
    expect(D in out).toBe(true); // the identical copy still matches its own size
    expect(JSON.stringify(data)).toBe(before);
    expect(data.links[A].sceneId).toBe('1');
  });

  it('an unknown size on either side is trusted', () => {
    const out = stashTagRecords(makeData(), { videos: VIDEOS, enabled: true });
    expect(out[G]).toBeTruthy(); // link has no fp.size, video has no size
    const noSizes = stashTagRecords(makeData(), { videos: VIDEOS.map((v) => ({ path: v.path })), enabled: true });
    expect(Object.keys(noSizes).sort()).toEqual([A, B, D, G].sort());
  });

  it('only the library\'s videos when a list is given; every trusted link without one', () => {
    expect(Object.keys(stashTagRecords(makeData(), { videos: [{ path: A, size: 1000 }], enabled: true }))).toEqual([A]);
    expect(Object.keys(stashTagRecords(makeData(), { enabled: true })).sort()).toEqual([A, B, D, G].sort());
  });

  it('identical copies share one frozen record; nothing in the input is changed', () => {
    const data = deepFreeze(makeData());
    const out = stashTagRecords(data, { videos: VIDEOS, enabled: true });
    expect(out[A]).toBe(out[D]);
    expect(Object.isFrozen(out[A])).toBe(true);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('a missing scene, tag or person adds nothing; junk is left out, never cut', () => {
    const data = makeData();
    data.links[A].sceneId = '404';
    data.tags.t1.name = '\ud83d';
    data.tags.t2.name = 'x'.repeat(201);
    data.performers.p2.name = 7;
    const out = stashTagRecords(data, { videos: VIDEOS, enabled: true });
    expect(A in out).toBe(false);
    expect(out[D].tags).toEqual([]);
    expect(out[D].performers.map((p) => p.id)).toEqual(['p1']);
  });

  it('at most 200 tags and 100 performers per scene', () => {
    const data = makeData();
    data.scenes[1].tagIds = [];
    data.scenes[1].performerIds = [];
    for (let i = 0; i < 260; i += 1) {
      data.tags[`x${i}`] = { id: `x${i}`, name: `Tag ${i}` };
      data.performers[`q${i}`] = { id: `q${i}`, name: `Person ${i}`, stashIds: [] };
      data.scenes[1].tagIds.push(`x${i}`);
      data.scenes[1].performerIds.push(`q${i}`);
    }
    const out = stashTagRecords(data, { videos: VIDEOS, enabled: true });
    expect(out[A].tags).toHaveLength(200);
    expect(out[A].performers).toHaveLength(100);
  });

  it('No URL from Stash stored: no field of a scene is copied but names and ids', () => {
    const data = makeData();
    data.scenes[1].urls = ['https://example.invalid/?apikey=SAMPLEKEY'];
    data.scenes[1].paths = { screenshot: `${SERVER}/scene/1/screenshot?apikey=SAMPLEKEY` };
    data.scenes[1].details = 'apikey=SAMPLEKEY';
    data.scenes[1].files[0].path = '/data/apikey=SAMPLEKEY.mp4';
    const text = JSON.stringify(stashTagRecords(data, { videos: VIDEOS, enabled: true }));
    expect(text).not.toContain('apikey=');
    expect(text).not.toContain('SAMPLEKEY');
  });

  it('a path named like an Object prototype key is an ordinary own entry', () => {
    const data = makeData();
    Object.defineProperty(data.links, '__proto__', { value: { ...data.links[A] }, enumerable: true });
    const out = stashTagRecords(data, { enabled: true });
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('nameIdentities: the bare-name join\'s table', () => {
  it('a name with exactly one identity maps to it', () => {
    const data = makeData();
    delete data.performers.p3; // one Jane Doe left
    const ids = nameIdentities(data, { enabled: true });
    expect(ids.get('performer:jane-doe')).toBe('0b5e1c9a-0000-4000-8000-00000000aaaa');
    expect(ids.get('studio:studio-two')).toBe('5d1e0000-0000-4000-8000-00000000c0de');
  });

  it('two identities for one name: left out (never joined to the first)', () => {
    const ids = nameIdentities(makeData(), { enabled: true });
    expect(ids.has('performer:jane-doe')).toBe(false);
  });

  it('one with an identity and one with none: left out too', () => {
    const data = makeData();
    data.performers.p3 = { id: 'p3', name: 'Jane Doe', disambiguation: '', stashIds: [] };
    expect(nameIdentities(data, { enabled: true }).has('performer:jane-doe')).toBe(false);
  });

  it('a name with no identity at all maps to nothing; off gives an empty table', () => {
    const ids = nameIdentities(makeData(), { enabled: true });
    expect(ids.has('performer:sam-roe')).toBe(false);
    expect(ids.has('studio:synthetic-studio')).toBe(false);
    expect(nameIdentities(makeData(), { enabled: false }).size).toBe(0);
    expect(nameIdentities(makeData()).size).toBe(0);
    expect(nameIdentities(null, { enabled: true }).size).toBe(0);
  });
});

describe('stashVideoView: the dialog\'s Stash block', () => {
  const view = (path, opts = {}) => stashVideoView(makeData(), path, { enabled: true, ...opts });

  it('off, no data or no path: null (the dialog shows no Stash at all)', () => {
    expect(stashVideoView(makeData(), A, { enabled: false })).toBeNull();
    expect(stashVideoView(makeData(), A)).toBeNull();
    expect(stashVideoView(null, A, { enabled: true })).toBeNull();
    expect(stashVideoView(makeData(), '', { enabled: true })).toBeNull();
  });

  it('linked: the scene, how it was matched, the counts, the markers in time order, the copy', () => {
    const v = view(A, { size: 1000, duration: 10 });
    expect(v.state).toBe('linked');
    expect(v.hidden).toBe(false);
    expect(v.link).toEqual({ sceneId: '1', by: 'oshash', state: 'ok', linkedAt: 1, server: SERVER, otherServer: false, verify: false });
    expect(v.scene.title).toBe('Synthetic Scene Small');
    expect(v.scene.code).toBe('SYN-001');
    expect(v.scene.rating100).toBe(80);
    expect(v.scene.organized).toBe(true);
    expect(v.scene.studio).toEqual({ id: 's1', name: 'Synthetic Studio', parent: 'Synthetic Network' });
    expect(v.scene.performers).toEqual([
      { id: 'p1', name: 'Jane Doe', disambiguation: 'blonde' }, { id: 'p2', name: 'Sam Roe', disambiguation: null },
    ]);
    expect(v.scene.markers.map((m) => [m.seconds, m.title])).toEqual([[1, 'Synthetic marker one'], [4, 'Synthetic Tag B']]);
    expect(v.scene.files[0].name).toBe('scene_a.mp4');
    expect(v.counts).toEqual({ tags: 2, performers: 2, studio: 1 });
    expect(v.copies).toEqual([D]);
    expect(v.server).toEqual({ url: SERVER, version: 'v0.32.0' });
  });

  it('changed: a size the scan sees differently hides the data (counts 0), and the sync\'s own mark too', () => {
    const v = view(A, { size: 999 });
    expect(v.state).toBe('changed');
    expect(v.hidden).toBe(true);
    expect(v.counts).toEqual({ tags: 0, performers: 0, studio: 0 });
    expect(v.scene.title).toBe('Synthetic Scene Small');
    expect(view(C, { size: 3000 }).state).toBe('changed');
  });

  it('gone: kept and still counted; from another Stash: flagged', () => {
    const v = view(B, { size: 2000 });
    expect(v.state).toBe('gone');
    expect(v.counts.tags).toBe(1);
    expect(view(G).link.otherServer).toBe(true);
    expect(view(A).link.otherServer).toBe(false);
  });

  it('check: the candidates with title, date, studio, file name and the duration difference', () => {
    const v = view(E, { size: 5000, duration: 10 });
    expect(v.state).toBe('check');
    expect(v.check.kind).toBe('several');
    expect(v.check.candidates).toEqual([
      { sceneId: '1', title: 'Synthetic Scene Small', date: '2026-11-17', studio: 'Synthetic Studio', fileName: 'scene_a.mp4', duration: 10.5, durationDiff: 0.5, durationFlag: false },
      { sceneId: '2', title: 'Synthetic Scene Two', date: '2026-11-16', studio: 'Studio Two', fileName: 'scene_b.mp4', duration: 30, durationDiff: 20, durationFlag: true },
    ]);
  });

  it('refused, not in Stash, not synced', () => {
    const r = view(F);
    expect(r.state).toBe('refused');
    expect(r.refused.scenes).toEqual([{ id: '2', title: 'Synthetic Scene Two' }]);
    expect(view('C:/Lib/Never Seen.mp4').state).toBe('notInStash');
    const data = makeData();
    delete data.lastSync;
    expect(stashVideoView(data, 'C:/Lib/Never Seen.mp4', { enabled: true }).state).toBe('notSynced');
  });

  it('text from Stash comes back as plain data, never as markup', () => {
    const data = makeData();
    data.scenes[1].title = '<img src=x onerror=alert(1)>';
    const v = stashVideoView(data, A, { enabled: true });
    expect(v.scene.title).toBe('<img src=x onerror=alert(1)>');
    expect(typeof v.scene.title).toBe('string');
  });

  it('details are cut at 2,000 characters without splitting an emoji', () => {
    const data = makeData();
    data.scenes[1].details = `${'x'.repeat(1999)}😀tail`;
    const v = stashVideoView(data, A, { enabled: true });
    expect(v.scene.details).toBe('x'.repeat(1999));
  });
});
