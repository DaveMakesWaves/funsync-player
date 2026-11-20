/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// electron/stash-match.js (Stash S1, 2026-11-18): which Stash scene each
// library video is (DESIGN-stash-s1.md (b), tests in (g)). Pure: the tests
// hand it fingerprints, a scene list and the stored links, and read the new
// maps it returns. The full-list test uses the local test Stash's answer
// (tests/fixtures/stash/all-scenes.response.json, synthetic library).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  matchLibrary, mapStashPath, compileRules, pathKey, sameServer, isWindowsStyle, sameContentPaths,
} = require_('../../electron/stash-match.js');
const { mapScenePage } = require_('../../electron/stash-map.js');
const { recordKey } = require_('../../electron/stash-keys.js');

const SERVER = 'http://127.0.0.1:9999';
const NOW = 1795000000000;
const H = {
  a: 'aaaaaaaaaaaaaaaa', b: 'bbbbbbbbbbbbbbbb', c: 'cccccccccccccccc', d: 'dddddddddddddddd', e: 'eeeeeeeeeeeeeeee',
};

/** A light-list scene: files as [path, oshash] pairs. */
function scene(id, files, updatedAt = '2026-11-18T10:00:00Z') {
  return { id, updatedAt, files: files.map(([path, oshash]) => ({ path, size: 1000, oshash })) };
}
function video(path, oshash, { size = 1000, mtimeMs = 1 } = {}) {
  return { path, size, mtimeMs, oshash };
}
function link(sceneId, oshash, extra = {}) {
  return { sceneId, server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 1, oshash }, linkedAt: 5, state: 'ok', ...extra };
}
function run(input) {
  return matchLibrary({ server: SERVER, now: NOW, complete: true, scenes: [], videos: [], ...input });
}

const V = 'C:\\lib\\clip.mp4';
const W = 'C:\\lib\\copy.mp4';

describe('stash-match: by oshash', () => {
  it('a unique oshash links the video to that scene (by: oshash)', () => {
    const res = run({ videos: [video(V, H.a, { size: 1234, mtimeMs: 77 })], scenes: [scene('1', [['S:\\x.mp4', H.a]]), scene('2', [['S:\\y.mp4', H.b]])] });
    expect(res.links).toEqual({
      [V]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1234, mtimeMs: 77, oshash: H.a }, linkedAt: NOW, state: 'ok', sceneHashes: [H.a] },
    });
    expect(res.check).toEqual({});
    expect(res.outcome).toEqual({ [V]: 'linked' });
  });

  it('takes light scenes as the client returns them (updated_at, a fingerprints list)', () => {
    const raw = {
      id: '1', updated_at: '2026-11-18T09:00:00Z',
      files: [{ path: 'S:\\x.mp4', size: 1000, fingerprints: [{ type: 'phash', value: H.b }, { type: 'oshash', value: H.a.toUpperCase() }] }],
    };
    const res = run({ videos: [video(V, H.a)], scenes: [raw], storedScenes: { [recordKey(SERVER, '1')]: { updatedAt: '2026-11-18T09:00:00Z' } } });
    expect(res.links[V]).toMatchObject({ sceneId: '1', by: 'oshash' });
    expect(res.fetch).toEqual([]);
  });

  it('without `now` it stamps the link with the clock; without `server` the link is this one\'s', () => {
    const before = Date.now();
    const res = matchLibrary({ videos: [video(V, H.a)], scenes: [scene('1', [['S:\\x.mp4', H.a]])], complete: true });
    expect(res.links[V].linkedAt).toBeGreaterThanOrEqual(before);
    expect(res.links[V].server).toBe('');
    expect(matchLibrary()).toMatchObject({ links: {}, check: {}, refused: {}, relinked: [], fetch: [] });
  });

  it('a scene with several files is one scene: any of its files links it', () => {
    const res = run({ videos: [video(V, H.b)], scenes: [scene('1', [['S:\\x.mp4', H.a], ['S:\\x2.mp4', H.b]])] });
    expect(res.links[V].sceneId).toBe('1');
  });

  it('the test Stash\'s nine clips at OTHER paths (same bytes) all link by oshash', () => {
    const page = mapScenePage(JSON.parse(fs.readFileSync('tests/fixtures/stash/all-scenes.response.json', 'utf8')).data.findScenes);
    const videos = page.scenes.map((s) => video(`D:\\sandbox\\library\\clip-${s.id}.mp4`, s.files[0].oshash));
    const res = run({ videos, scenes: page.scenes });
    expect(res.counts).toMatchObject({ linked: 9, check: 0, notInStash: 0 });
    for (const s of page.scenes) expect(res.links[`D:\\sandbox\\library\\clip-${s.id}.mp4`]).toMatchObject({ sceneId: s.id, by: 'oshash' });
  });

  it('hashes are compared whole: a Stash value that is a piece of the hash links nothing', () => {
    const ours = '6b3f3b3ee9e8c31a';
    const scenes = [scene('1', [['S:\\a.mp4', '6b3f']]), scene('2', [['S:\\b.mp4', 'e9e8c31a']]), scene('3', [['S:\\c.mp4', `${ours}0`]])];
    const res = run({ videos: [video(V, ours)], scenes });
    expect(res.links).toEqual({});
    expect(res.outcome[V]).toBe('notInStash');
    // the same hash in upper case is the same hash
    expect(run({ videos: [video(V, ours)], scenes: [scene('4', [['S:\\d.mp4', ours.toUpperCase()]])] }).links[V].sceneId).toBe('4');
  });

  it('two scenes with one oshash: a check (several), nothing linked', () => {
    const scenes = [scene('2', [['S:\\b.mp4', H.a]]), scene('1', [['S:\\a.mp4', H.a]])];
    const res = run({ videos: [video(V, H.a)], scenes });
    expect(res.links).toEqual({});
    expect(res.check).toEqual({ [V]: { kind: 'several', sceneIds: ['1', '2'], fp: { size: 1000, mtimeMs: 1, oshash: H.a }, seenAt: NOW, server: SERVER } });
    expect(res.outcome[V]).toBe('check');
  });

  it('two scenes with one oshash: an existing link to one of them is kept', () => {
    const scenes = [scene('1', [['S:\\a.mp4', H.a]]), scene('2', [['S:\\b.mp4', H.a]])];
    const res = run({ videos: [video(V, H.a, { mtimeMs: 9 })], scenes, links: { [V]: link('2', H.a) } });
    expect(res.links[V]).toEqual({ ...link('2', H.a), fp: { size: 1000, mtimeMs: 9, oshash: H.a }, sceneHashes: [H.a] });
    expect(res.check[V]).toMatchObject({ kind: 'several', sceneIds: ['1', '2'] });
  });

  it('identical copies in the library (two files, one oshash) are BOTH linked to the scene', () => {
    const res = run({ videos: [video(V, H.a), video(W, H.a)], scenes: [scene('1', [['S:\\x.mp4', H.a]])] });
    expect(res.links[V]).toMatchObject({ sceneId: '1', by: 'oshash' });
    expect(res.links[W]).toMatchObject({ sceneId: '1', by: 'oshash' });
    expect(sameContentPaths(res.links, V)).toEqual([W]);
    expect(sameContentPaths(res.links, W)).toEqual([V]);
    expect(sameContentPaths(res.links, 'C:\\none.mp4')).toEqual([]);
  });
});

describe('stash-match: by path (a check, never a link)', () => {
  it('same path, other content: a check (pathChanged), no link', () => {
    const scenes = [scene('3', [['C:\\lib\\clip.mp4', H.b]])];
    const res = run({ videos: [video(V, H.a)], scenes });
    expect(res.links).toEqual({});
    expect(res.check[V]).toEqual({ kind: 'pathChanged', sceneIds: ['3'], fp: { size: 1000, mtimeMs: 1, oshash: H.a }, seenAt: NOW, server: SERVER });
  });

  it('Windows paths compare without case, / and \\ alike', () => {
    const scenes = [scene('3', [['c:/LIB/Clip.mp4', H.b]])];
    expect(run({ videos: [video(V, H.a)], scenes }).check[V]).toMatchObject({ kind: 'pathChanged', sceneIds: ['3'] });
  });

  it('a path rule maps Stash\'s folder (Docker / NAS) to FunSync\'s, on a folder boundary', () => {
    const local = '\\\\NAS\\videos\\set\\clip.mp4';
    const scenes = [scene('3', [['/data/videos/set/clip.mp4', H.b]]), scene('4', [['/data/videos2/set/clip.mp4', H.c]])];
    const pathRules = [{ local: '\\\\NAS\\videos', stash: '/data/videos' }];
    const res = run({ videos: [video(local, H.a)], scenes, pathRules });
    expect(res.check[local]).toMatchObject({ kind: 'pathChanged', sceneIds: ['3'] });
    // without the rule the paths are compared as they are: no match
    expect(run({ videos: [video(local, H.a)], scenes }).check).toEqual({});
  });

  it('a linked video whose file is unchanged gets no path check', () => {
    // Scene 1's file has no oshash in Stash (not hashed yet): nothing says it
    // is another scene now, so the link holds (s1-fixup-main: a listed file
    // with another oshash would mark it changed, see "a Stash reset").
    const scenes = [scene('1', [['S:\\other.mp4', null]]), scene('3', [['C:\\lib\\clip.mp4', H.b]])];
    const res = run({ videos: [video(V, H.a)], scenes, links: { [V]: link('1', H.a) } });
    expect(res.links[V].state).toBe('ok');
    expect(res.check).toEqual({});
  });
});

describe('stash-match: your choices', () => {
  it('a manual or chosen link survives a sync that would match elsewhere', () => {
    const scenes = [scene('1', [['S:\\a.mp4', H.a]]), scene('5', [['S:\\e.mp4', H.e]])];
    for (const by of ['manual', 'chosen']) {
      const res = run({ videos: [video(V, H.a, { mtimeMs: 3 })], scenes, links: { [V]: link('5', H.a, { by }) } });
      // (its scene's files are kept with it from now on: sceneHashes)
      expect(res.links[V]).toEqual({ ...link('5', H.a, { by }), fp: { size: 1000, mtimeMs: 3, oshash: H.a }, sceneHashes: [H.e] });
      expect(res.relinked).toEqual([]);
      expect(res.check).toEqual({});
      // its file changed to content of ANOTHER scene: still yours, marked changed, never re-linked
      const moved = run({ videos: [video(V, H.a)], scenes, links: { [V]: link('5', H.d, { by }) } });
      expect(moved.links[V]).toEqual(link('5', H.d, { by, state: 'changed' }));
      expect(moved.relinked).toEqual([]);
    }
  });

  it('a manual link to a re-encode (no hash match anywhere) is kept and stays ok', () => {
    const res = run({ videos: [video(V, H.d)], scenes: [scene('5', [['S:\\e.mp4', H.e]])], links: { [V]: link('5', H.d, { by: 'manual' }) } });
    expect(res.links[V]).toMatchObject({ sceneId: '5', by: 'manual', state: 'ok' });
  });

  it('a refused scene is never linked or offered again for that content; the refusal is kept', () => {
    const refused = { [V]: { oshash: H.a, sceneIds: ['1'], at: 4 } };
    const scenes = [scene('1', [['S:\\a.mp4', H.a], ['S:\\a2.mp4', H.b]])];
    const res = run({ videos: [video(V, H.a)], scenes, refused });
    expect(res.links).toEqual({});
    expect(res.check).toEqual({});
    expect(res.refused).toEqual(refused);
    // the file changed (another oshash): the scene can be linked again
    const changed = run({ videos: [video(V, H.b)], scenes, refused });
    expect(changed.links[V]).toMatchObject({ sceneId: '1', by: 'oshash' });
    expect(changed.refused).toEqual(refused);
  });

  it('a refused path match ("Ignore") is not offered again; "None of these" refuses every scene', () => {
    const scenes = [scene('3', [[V, H.b]])];
    expect(run({ videos: [video(V, H.a)], scenes, refused: { [V]: { oshash: H.a, sceneIds: ['3'] } } }).check).toEqual({});
    const two = [scene('1', [['S:\\a.mp4', H.a]]), scene('2', [['S:\\b.mp4', H.a]])];
    const none = run({ videos: [video(V, H.a)], scenes: two, refused: { [V]: { oshash: H.a, sceneIds: ['1', '2'] } } });
    expect(none.links).toEqual({});
    expect(none.check).toEqual({});
  });
});

describe('stash-match: gone, changed, re-linked', () => {
  it('gone needs a complete list: a partial list marks nothing gone; a complete one does, data kept', () => {
    const links = { [V]: link('7', H.a) };
    const partial = run({ videos: [video(V, H.a)], scenes: [scene('1', [['S:\\a.mp4', H.c]])], links, complete: false });
    expect(partial.links[V].state).toBe('ok');
    const full = run({ videos: [video(V, H.a)], scenes: [scene('1', [['S:\\a.mp4', H.c]])], links, complete: true });
    expect(full.links[V]).toEqual({ ...link('7', H.a), state: 'gone' });
    expect(full.outcome[V]).toBe('gone');
    // back in a later list: ok again
    expect(run({ videos: [video(V, H.a)], scenes: [scene('7', [['S:\\g.mp4', H.a]])], links: full.links }).links[V].state).toBe('ok');
  });

  it('"Sync this video": a scene Stash answered null for (goneIds) is gone even from a partial list', () => {
    const res = run({ videos: [video(V, H.a)], scenes: [], links: { [V]: link('7', H.a) }, complete: false, goneIds: ['7'] });
    expect(res.links[V]).toMatchObject({ sceneId: '7', state: 'gone' });
  });

  it('a gone scene whose file now matches another scene uniquely (merged in Stash) is re-linked, with Undo data', () => {
    const before = link('7', H.a);
    const res = run({ videos: [video(V, H.a)], scenes: [scene('8', [['S:\\m.mp4', H.a]])], links: { [V]: before } });
    expect(res.links[V]).toMatchObject({ sceneId: '8', by: 'oshash', state: 'ok', linkedAt: NOW });
    expect(res.relinked).toEqual([{ path: V, from: before, to: res.links[V] }]);
  });

  it('changed content that matches nothing: the link stays, marked changed, with its OLD fingerprint', () => {
    const before = link('1', H.a);
    const scenes = [scene('1', [['S:\\a.mp4', H.a]])];
    const res = run({ videos: [video(V, H.c, { size: 2000, mtimeMs: 9 })], scenes, links: { [V]: before } });
    expect(res.links[V]).toEqual({ ...before, state: 'changed' });
    expect(res.outcome[V]).toBe('changed');
    // the old file is back: ok again, fingerprint renewed
    expect(run({ videos: [video(V, H.a, { mtimeMs: 10 })], scenes, links: res.links }).links[V])
      .toEqual({ ...before, fp: { size: 1000, mtimeMs: 10, oshash: H.a }, sceneHashes: [H.a] });
  });

  it('changed content still in the same scene: the fingerprint is renewed', () => {
    const scenes = [scene('1', [['S:\\a.mp4', H.a], ['S:\\a-new.mp4', H.b]])];
    const res = run({ videos: [video(V, H.b, { size: 3000, mtimeMs: 4 })], scenes, links: { [V]: link('1', H.a) } });
    expect(res.links[V]).toEqual({ ...link('1', H.a), fp: { size: 3000, mtimeMs: 4, oshash: H.b }, sceneHashes: [H.a, H.b] });
    expect(res.relinked).toEqual([]);
  });

  it('changed content that matches a different single scene: re-linked, with Undo data', () => {
    const before = link('1', H.a);
    const scenes = [scene('1', [['S:\\a.mp4', H.a]]), scene('2', [['S:\\b.mp4', H.b]])];
    const res = run({ videos: [video(V, H.b)], scenes, links: { [V]: before } });
    expect(res.links[V]).toMatchObject({ sceneId: '2', by: 'oshash' });
    expect(res.relinked).toEqual([{ path: V, from: before, to: res.links[V] }]);
  });

  it('a re-homed link (verify) is confirmed by content, or marked changed', () => {
    const scenes = [scene('1', [['S:\\a.mp4', H.a]])];
    const moved = link('1', H.a, { verify: true });
    const ok = run({ videos: [video(V, H.a, { mtimeMs: 50 })], scenes, links: { [V]: moved } });
    expect(ok.links[V]).toEqual({ ...link('1', H.a), fp: { size: 1000, mtimeMs: 50, oshash: H.a }, sceneHashes: [H.a] });
    const bad = run({ videos: [video(V, H.d)], scenes, links: { [V]: moved } });
    expect(bad.links[V]).toEqual({ ...link('1', H.a), state: 'changed' });
  });
});

describe('stash-match: a partial list only adds', () => {
  it('never re-links an existing link', () => {
    const before = link('1', H.a);
    const scenes = [scene('2', [['S:\\b.mp4', H.a]])];
    const res = run({ videos: [video(V, H.a)], scenes, links: { [V]: before }, complete: false });
    expect(res.links[V]).toEqual(before);
    expect(res.relinked).toEqual([]);
  });

  it('never replaces or clears a check; still links a video with neither', () => {
    const check = { [V]: { kind: 'several', sceneIds: ['1', '2', '3'], fp: { size: 1000, mtimeMs: 1, oshash: H.a }, seenAt: 3 } };
    const scenes = [scene('1', [['S:\\a.mp4', H.a]]), scene('9', [['S:\\w.mp4', H.b]])];
    const res = run({ videos: [video(V, H.a), video(W, H.b)], scenes, check, complete: false });
    expect(res.check).toEqual(check);
    expect(res.links[V]).toBeUndefined();
    expect(res.links[W]).toMatchObject({ sceneId: '9' });
    // two of the three scenes on the pages it saw: the stored check (three) stays
    const two = [scene('1', [['S:\\a.mp4', H.a]]), scene('2', [['S:\\b.mp4', H.a]])];
    expect(run({ videos: [video(V, H.a)], scenes: two, check, complete: false }).check).toEqual(check);
    // the same with a complete list resolves the check
    const full = run({ videos: [video(V, H.a)], scenes, check, complete: true });
    expect(full.check).toEqual({});
    expect(full.links[V]).toMatchObject({ sceneId: '1' });
  });
});

describe('stash-match: what it leaves alone', () => {
  it('videos not passed in (skipped: offline, unreadable) keep their link and check, even from a complete list', () => {
    const links = { 'E:\\offline.mp4': link('7', H.a), [V]: link('1', H.b) };
    const check = { 'E:\\offline2.mp4': { kind: 'several', sceneIds: ['1', '2'], fp: null, seenAt: 1 } };
    const res = run({ videos: [video(V, H.b)], scenes: [scene('1', [['S:\\a.mp4', H.b]])], links, check, skipped: 2 });
    expect(res.links['E:\\offline.mp4']).toEqual(links['E:\\offline.mp4']);
    expect(res.check).toEqual(check);
    expect(res.counts).toEqual({ linked: 1, check: 0, notInStash: 0, gone: 0, changed: 0, skipped: 2 });
  });

  it('never changes its inputs', () => {
    const input = {
      videos: [video(V, H.a), video(W, H.c)],
      scenes: [scene('1', [['S:\\a.mp4', H.a]]), scene('2', [['C:\\lib\\copy.mp4', H.d]])],
      links: { [V]: link('9', H.e) },
      check: { 'C:\\x.mp4': { kind: 'several', sceneIds: ['1'], fp: null, seenAt: 1 } },
      refused: { [W]: { oshash: H.e, sceneIds: ['2'] } },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const res = run(input);
    expect(input).toEqual(snapshot);
    expect(res.links).not.toBe(input.links);
    expect(res.relinked[0].from).toEqual(snapshot.links[V]);
  });

  it('a link from another Stash: re-linked when this one has the file, else kept untouched', () => {
    const old = link('4', H.a, { server: 'http://192.168.1.20:9999' });
    const res = run({ videos: [video(V, H.a)], scenes: [scene('11', [['S:\\a.mp4', H.a]])], links: { [V]: old } });
    expect(res.links[V]).toMatchObject({ sceneId: '11', server: SERVER });
    expect(res.relinked).toHaveLength(1);
    const kept = run({ videos: [video(V, H.c)], scenes: [scene('11', [['S:\\a.mp4', H.a]])], links: { [V]: old } });
    expect(kept.links[V]).toEqual(old);
    expect(kept.outcome[V]).toBe('notInStash');
    const manual = { ...old, by: 'manual' };
    expect(run({ videos: [video(V, H.a)], scenes: [scene('11', [['S:\\a.mp4', H.a]])], links: { [V]: manual } }).links[V]).toEqual(manual);
  });

  it('a video with no usable oshash is counted as skipped and touches nothing', () => {
    const links = { [V]: link('1', H.a) };
    const res = run({ videos: [{ path: V, size: 5, mtimeMs: 1, oshash: null }, null], scenes: [], links });
    expect(res.links).toEqual(links);
    expect(res.counts.skipped).toBe(2);
  });
});

describe('stash-match: counts and the details to fetch', () => {
  it('counts each video once; fetches new or changed scenes of links and checks only', () => {
    const scenes = [
      scene('1', [['S:\\a.mp4', H.a]], 't-new'),
      scene('2', [['S:\\b.mp4', H.b]], 't-same'),
      scene('3', [['S:\\c.mp4', H.c]]), scene('4', [['S:\\c2.mp4', H.c]]),
      scene('6', [['S:\\unrelated.mp4', 'ffffffffffffffff']]),
    ];
    const videos = [video('C:\\1.mp4', H.a), video('C:\\2.mp4', H.b), video('C:\\3.mp4', H.c), video('C:\\4.mp4', H.d)];
    const storedScenes = { [recordKey(SERVER, '1')]: { updatedAt: 't-old' }, [recordKey(SERVER, '2')]: { updatedAt: 't-same' } };
    const res = run({ videos, scenes, storedScenes, skipped: 1 });
    expect(res.counts).toEqual({ linked: 2, check: 1, notInStash: 1, gone: 0, changed: 0, skipped: 1 });
    expect(res.fetch).toEqual(['1', '3', '4']);
  });
});

describe('stash-match: paths and addresses', () => {
  it('mapStashPath: the longest Stash prefix wins, on folder boundaries; no rule, no change', () => {
    const rules = compileRules([
      { local: 'D:\\media', stash: '/data' },
      { local: '\\\\NAS\\vr', stash: '/data/vr/' },
      { local: '', stash: '/x' },
      { local: 'C:\\', stash: '  ' },
      null,
    ]);
    expect(rules).toHaveLength(2);
    expect(mapStashPath('/data/vr/a.mp4', rules)).toBe('//NAS/vr/a.mp4');
    expect(mapStashPath('/data/flat/a.mp4', rules)).toBe('D:/media/flat/a.mp4');
    expect(mapStashPath('/database/a.mp4', rules)).toBe('/database/a.mp4');
    expect(mapStashPath('C:\\Stash\\a.mp4', [])).toBe('C:/Stash/a.mp4');
  });

  it('pathKey and isWindowsStyle: case folds only Windows-style paths', () => {
    expect(pathKey('C:\\A\\\\B.mp4', true)).toBe('c:/a/b.mp4');
    expect(pathKey('\\\\NAS\\Share\\x', true)).toBe('//nas/share/x');
    expect(isWindowsStyle('C:\\x')).toBe(true);
    expect(isWindowsStyle('\\\\NAS\\x')).toBe(true);
    expect(isWindowsStyle('/home/me/A.mp4')).toBe(false);
    // on a Linux path, case matters: no check for a file that differs only in case
    const res = run({ videos: [video('/home/me/A.mp4', H.a)], scenes: [scene('3', [['/home/me/a.mp4', H.b]])] });
    expect(res.check).toEqual({});
  });

  it('sameServer ignores a trailing slash and case; a link with no server is this one', () => {
    expect(sameServer('http://127.0.0.1:9999/', SERVER)).toBe(true);
    expect(sameServer('HTTP://127.0.0.1:9999', SERVER)).toBe(true);
    expect(sameServer(undefined, SERVER)).toBe(true);
    expect(sameServer('http://192.168.1.20:9999', SERVER)).toBe(false);
  });
});

// Round 2 (2026-11-18): Stash ids are unique only per server. Scene 1 on
// another Stash is another scene, so nothing stored about another server's
// scene 1 may decide anything about this server's scene 1.
describe('stash-match: scene ids belong to one server', () => {
  const OTHER = 'http://192.168.1.20:9999';

  it('a refusal recorded on another server does not refuse this server\'s scene with the same id', () => {
    const scenes = [scene('1', [['S:\\x.mp4', H.a]])];
    const res = run({ videos: [video(V, H.a)], scenes, refused: { [V]: { oshash: H.a, sceneIds: ['1'], server: OTHER } } });
    expect(res.links[V]).toMatchObject({ sceneId: '1', server: SERVER, by: 'oshash' });
    // The same refusal on this server (or one with no server recorded) still holds.
    expect(run({ videos: [video(V, H.a)], scenes, refused: { [V]: { oshash: H.a, sceneIds: ['1'], server: SERVER } } }).links).toEqual({});
    expect(run({ videos: [video(V, H.a)], scenes, refused: { [V]: { oshash: H.a, sceneIds: ['1'] } } }).links).toEqual({});
  });

  it('a stored scene of another server never stands in for this server\'s scene with the same id', () => {
    const scenes = [scene('1', [['S:\\x.mp4', H.a]], 't-1')];
    const stale = { [recordKey(OTHER, '1')]: { updatedAt: 't-1' } };
    expect(run({ videos: [video(V, H.a)], scenes, storedScenes: stale }).fetch).toEqual(['1']);
    const mine = { [recordKey(SERVER, '1')]: { updatedAt: 't-1' } };
    expect(run({ videos: [video(V, H.a)], scenes, storedScenes: mine }).fetch).toEqual([]);
  });

  it('a check records its server; another server\'s open check fetches nothing here', () => {
    const scenes = [scene('1', [['S:\\x.mp4', H.a]]), scene('2', [['S:\\y.mp4', H.a]]), scene('7', [['S:\\z.mp4', H.e]])];
    const res = run({ videos: [video(V, H.a)], scenes });
    expect(res.check[V]).toMatchObject({ kind: 'several', sceneIds: ['1', '2'], server: SERVER });
    const other = run({
      videos: [], scenes,
      check: { 'C:\\lib\\offline.mp4': { kind: 'several', sceneIds: ['7'], fp: null, seenAt: 1, server: OTHER } },
    });
    expect(other.fetch).toEqual([]);
  });

  it('sameContentPaths: a copy linked to another server\'s scene with the same id is not "the same video"', () => {
    const links = {
      [V]: link('1', H.a),
      [W]: link('1', H.a, { server: OTHER }),
      'C:\\lib\\third.mp4': link('1', H.a),
    };
    expect(sameContentPaths(links, V)).toEqual(['C:\\lib\\third.mp4']);
  });
});

describe('stash-match: s1-fixup-main (2026-11-19) guards', () => {
  it('an automatic link to a scene refused for this content is dropped, and another scene may link; yours is kept (S1RB-3)', () => {
    // An import brought back a link the user refused ("Not this scene").
    const refused = { [V]: { oshash: H.a, sceneIds: ['1'], at: 4, server: SERVER } };
    const scenes = [scene('1', [['S:\a.mp4', H.a]])];
    const res = run({ videos: [video(V, H.a)], scenes, refused, links: { [V]: link('1', H.a) } });
    expect(res.links).toEqual({});
    expect(res.outcome[V]).toBe('notInStash');
    expect(res.refused).toEqual(refused);
    // a partial list drops it too (it adds nothing, but the refusal is the user's word)
    expect(run({ videos: [video(V, H.a)], scenes, refused, links: { [V]: link('1', H.a) }, complete: false }).links).toEqual({});
    // two scenes have the file, one refused: the other links
    const two = [...scenes, scene('2', [['S:\b.mp4', H.a]])];
    expect(run({ videos: [video(V, H.a)], scenes: two, refused, links: { [V]: link('1', H.a) } }).links[V]).toMatchObject({ sceneId: '2', by: 'oshash' });
    // a link you made is yours
    expect(run({ videos: [video(V, H.a)], scenes, refused, links: { [V]: link('1', H.a, { by: 'manual' }) } }).links[V]).toMatchObject({ sceneId: '1', state: 'ok' });
  });

  it('a Stash reset at the same address: a link whose id now names another scene is changed (sceneChanged), never ok, and its scene is not fetched (S1RB-4)', () => {
    // New database: id 1 is now an unrelated file; this video is not in it (yet).
    const reset = [scene('1', [['/data/new/other-1.mp4', H.c]], '2026-11-19T08:00:00Z')];
    const stored = { [recordKey(SERVER, '1')]: { id: '1', updatedAt: '2026-11-18T10:00:00Z', files: [{ path: 'S:\a.mp4', oshash: H.a }] } };
    for (const before of [
      link('1', H.a), // automatic, from before links kept their scene's files: its own fingerprint
      link('1', H.a, { sceneHashes: [H.a, H.b] }),
      link('1', H.d, { by: 'manual', sceneHashes: [H.b] }), // a re-encode found by hand
      link('1', H.a, { by: 'chosen' }), // no sceneHashes: the stored record's files
    ]) {
      const res = run({ videos: [video(V, before.fp.oshash)], scenes: reset, links: { [V]: before }, storedScenes: stored });
      expect(res.links[V]).toEqual({ ...before, state: 'changed', sceneChanged: true });
      expect(res.outcome[V]).toBe('changed');
      expect(res.fetch).toEqual([]);
      expect(res.relinked).toEqual([]);
    }
    // The scene still holds one of the link's files: the same scene, ok
    const same = run({ videos: [video(V, H.d)], scenes: [scene('1', [['S:\b.mp4', H.b], ['S:\new.mp4', H.e]])], links: { [V]: link('1', H.d, { by: 'manual', sceneHashes: [H.b] }) } });
    expect(same.links[V]).toMatchObject({ state: 'ok', sceneHashes: [H.b, H.e] });
    expect(same.links[V].sceneChanged).toBeUndefined();
    // Stash has not hashed the listed file: nothing to compare, trusted as before
    expect(run({ videos: [video(V, H.a)], scenes: [scene('1', [['S:\a.mp4', null]])], links: { [V]: link('1', H.a) } }).links[V].state).toBe('ok');
    // The video found again under its new id: re-linked, with Undo data
    const back = run({ videos: [video(V, H.a)], scenes: [...reset, scene('7', [['/data/new/a.mp4', H.a]])], links: { [V]: { ...link('1', H.a), state: 'changed', sceneChanged: true } } });
    expect(back.links[V]).toMatchObject({ sceneId: '7', state: 'ok', sceneHashes: [H.a] });
    expect(back.links[V].sceneChanged).toBeUndefined();
    expect(back.relinked).toHaveLength(1);
  });
});
