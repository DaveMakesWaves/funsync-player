/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash "next" lot (2026-11-19, stage sn-main), end to end: the REAL
// service (electron/stash-ipc.js) with the REAL client, data file, matcher,
// mapper, fingerprinter and sync job, against the fake Stash
// (tests/helpers/fake-stash-server.js) serving the local test Stash's
// next-lot scenes and tags. No other host.
//
// Guards checked by reopening their hole (SCRATCH/sn-main/holes.jsonl):
//   - tagRules reach the renderer only while Stash is on AND "Use Stash's
//     tag aliases and sub-tags" is ticked (hole: always hand them over)
//   - switching that moves the data's rev on and says so (stash-changed),
//     so the renderer, which skips a rev it has, reads again (hole: no
//     touch: the renderer would keep the old copy)
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { startFakeStash, snFixtureScenes } from '../helpers/fake-stash-server.js';
import { createSandboxService, makeVideos } from '../helpers/stash-sandbox.js';
import { createRequire } from 'node:module';

const { QUERY_NAMES } = createRequire(import.meta.url)('../../electron/stash-queries.js');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** The test Stash's scenes 1-4 and 10, each holding one sandbox video's file (phash, plays and Groups kept). */
function nextScenesFor(videos) {
  const base = snFixtureScenes();
  return videos.map((v, i) => {
    const s = structuredClone(base.find((x) => x.id === ['1', '2', '3', '4', '10'][i]));
    s.files = [{ ...s.files[0], path: `/data/stash/clip-${s.id}.mp4`, size: v.size, oshash: v.oshash }];
    return s;
  });
}

async function linkedNext() {
  const sb = createSandboxService();
  cleanups.push(async () => { await sb.service.shutdown(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  const videos = makeVideos(sb.dir, 5);
  const stash = await startFakeStash({ scenes: nextScenesFor(videos) });
  cleanups.push(() => stash.close());
  await sb.service.init();
  expect((await sb.call('stash-link', { address: stash.address })).ok).toBe(true);
  stash.reset();
  const list = videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs }));
  return { sb, stash, videos, list };
}

const changedRevs = (sb) => sb.events.filter((e) => e.channel === 'stash-changed').map((e) => e.payload.rev);

describe('Sync now with the next lot\'s fields, the real client against the fake Stash', () => {
  it('stores and hands over plays, last play, O-count, phash, Groups in Stash\'s order; read-only documents only', async () => {
    const { sb, stash, list } = await linkedNext();
    const res = await sb.call('stash-sync', { videos: list });
    expect(res).toMatchObject({ ok: true, complete: true, counts: { linked: 5 }, tags: { ok: true, count: 6, error: null } });

    const ops = stash.requests.map((r) => r.json.operationName);
    expect(new Set(ops)).toEqual(new Set(['FunSyncSceneList', 'FunSyncSceneDetails', 'FunSyncTagList']));
    for (const r of stash.requests) {
      expect(QUERY_NAMES).toContain(r.json.operationName);
      expect(r.json.query).not.toMatch(/\bmutation\b/);
    }

    const data = await sb.call('stash-get-data');
    expect(data.scenes['1']).toMatchObject({
      rating100: 80, organized: true, playCount: 1, oCounter: 1, lastPlayedAt: '2026-09-30T23:10:00.000Z', phash: '8a7da502fa0aeb6a',
      groups: [{ groupId: '1', sceneIndex: 3 }, { groupId: '2', sceneIndex: 2 }],
    });
    // The re-encode and the scene it re-encodes: one phash ("Looks the same (Stash)").
    expect(data.scenes['10'].phash).toBe(data.scenes['2'].phash);
    expect(data.scenes['4'].phash).toBeNull();
    // Stash's order (scene_index), not the scene ids' order: A is 2, 3, 1.
    expect(data.groups).toEqual({
      1: expect.objectContaining({ id: '1', name: 'Synthetic Series A', sceneIds: ['2', '3', '1'] }),
      2: expect.objectContaining({ id: '2', name: 'Synthetic Series B', sceneIds: ['4', '1'] }),
    });
    // The opt-in is off by default: no tag rules.
    expect(data.tagRules).toBeUndefined();
    expect((await sb.call('stash-status')).settings.useTagRules).toBe(false);
    const stored = fs.readFileSync(sb.library.file, 'utf8');
    expect(stored.toLowerCase()).not.toContain('apikey=');
  });
});

describe('"Use Stash\'s tag aliases and sub-tags" (settings.stash.useTagRules, opt-in)', () => {
  it('ticked: the data carries tagRules and the renderer is told to read again; unticked: gone again (guard)', async () => {
    const { sb, list } = await linkedNext();
    await sb.call('stash-sync', { videos: list });
    const rev0 = (await sb.call('stash-get-data')).rev;
    sb.events.length = 0;

    const on = await sb.call('stash-set-options', { useTagRules: true });
    expect(on).toMatchObject({ ok: true, settings: { useTagRules: true, enabled: true } });
    expect(sb.store.settings.stash.useTagRules).toBe(true);
    expect(changedRevs(sb)).toEqual([rev0 + 1]);
    expect(sb.events.find((e) => e.channel === 'stash-settings-changed').payload.useTagRules).toBe(true);
    const data = await sb.call('stash-get-data');
    expect(data.rev).toBe(rev0 + 1);
    expect(data.tagRules.aliases).toMatchObject({ 'synthetic-a': 'synthetic-tag-a', 'synthetic-child': 'synthetic-tag-b' });
    expect(data.tagRules.children['synthetic-grandparent-tag']).toEqual(['synthetic-parent-tag', 'synthetic-tag-b']);
    expect(data.tagRules.names['synthetic-grandparent-tag']).toBe('Synthetic Grandparent Tag');

    // Ticking it again changes nothing: no new rev.
    await sb.call('stash-set-options', { useTagRules: true });
    expect(changedRevs(sb)).toEqual([rev0 + 1]);

    await sb.call('stash-set-options', { useTagRules: false });
    expect(changedRevs(sb)).toEqual([rev0 + 1, rev0 + 2]);
    expect((await sb.call('stash-get-data')).tagRules).toBeUndefined();
  });

  it('Stash off hides the rules even with the box ticked; on again brings them back (each a new rev)', async () => {
    const { sb, list } = await linkedNext();
    await sb.call('stash-sync', { videos: list });
    await sb.call('stash-set-options', { useTagRules: true });
    const rev1 = (await sb.call('stash-get-data')).rev;
    await sb.call('stash-set-options', { enabled: false });
    expect((await sb.call('stash-get-data'))).toMatchObject({ rev: rev1 + 1 });
    expect((await sb.call('stash-get-data')).tagRules).toBeUndefined();
    // The renderer's own settings write (set-setting of the Stash block) counts the same.
    sb.service.applySettingWrite('stash', { enabled: true });
    await sb.service.handlers['stash-status']();
    await new Promise((r) => setTimeout(r, 0));
    const back = await sb.call('stash-get-data');
    expect(back.rev).toBe(rev1 + 2);
    expect(back.tagRules.aliases['syn-gp']).toBe('synthetic-grandparent-tag');
  });

  it('ticked before the first sync: empty rules until a sync has read Stash\'s tags', async () => {
    const { sb, list } = await linkedNext();
    sb.service.applySettingWrite('stash.useTagRules', true);
    await new Promise((r) => setTimeout(r, 0));
    expect((await sb.call('stash-get-data')).tagRules).toEqual({ aliases: {}, children: {}, names: {} });
    await sb.call('stash-sync', { videos: list });
    expect(Object.keys((await sb.call('stash-get-data')).tagRules.names)).toHaveLength(6);
  });

  it('only a true or false is taken; nothing else is written', async () => {
    const { sb } = await linkedNext();
    for (const bad of ['yes', 1, null, {}]) {
      expect(await sb.call('stash-set-options', { useTagRules: bad })).toEqual({ ok: false, code: 'badInput' });
    }
    sb.service.applySettingWrite('stash.useTagRules', 'yes');
    expect(sb.store.settings.stash.useTagRules).toBe(false);
  });
});
