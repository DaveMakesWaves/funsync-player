/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A full sync that re-links more than 100 videos keeps EVERY re-link's Undo
// for the session (TODO triage 2026-11-23, Stash S1). main kept at most 100
// Undo tokens, so the oldest re-links' rows in Settings answered "could not
// be undone" (expired) while they still showed. Ordinary Undo entries keep
// the 100 limit.
//
// The REAL Stash service (electron/stash-ipc.js) against the fake Stash
// server, as stash-ipc.test.js: 105 videos linked, then every scene merged
// in "Stash" (new ids, the old ones gone), so the next full sync re-links all
// 105. Hole: drop the session flag, and the first 5 expire.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { startFakeStash } from '../helpers/fake-stash-server.js';
import { createSandboxService, makeVideos, scenesFor } from '../helpers/stash-sandbox.js';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function setup(n) {
  const sb = createSandboxService();
  cleanups.push(async () => { await sb.service.shutdown(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  const videos = makeVideos(sb.dir, n);
  const stash = await startFakeStash({ scenes: scenesFor(videos) });
  cleanups.push(() => stash.close());
  await sb.service.init();
  expect((await sb.call('stash-link', { address: `${stash.address}/` })).ok).toBe(true);
  const list = videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs }));
  const first = await sb.call('stash-sync', { videos: list });
  expect(first).toMatchObject({ ok: true, complete: true });
  expect(first.counts.linked).toBe(n);
  return { sb, stash, videos, list };
}

/** Every scene merged into a new one in Stash: new ids, the old ones gone. */
function mergeAll(stash, videos) {
  stash.set({
    scenes: scenesFor(videos).map((s) => ({ ...s, id: String(Number(s.id) + 1000) })),
    deletedIds: videos.map((_, i) => String(i + 1)),
  });
}

describe('a sync that re-links more than 100 videos', () => {
  it('every re-link can be undone, the oldest included; an Undo restores that video\'s link', { timeout: 60000 }, async () => {
    const { sb, stash, videos, list } = await setup(105);
    const before = (await sb.call('stash-get-data')).links;
    mergeAll(stash, videos);
    const second = await sb.call('stash-sync', { videos: list });
    expect(second.ok).toBe(true);
    expect(second.relinked).toHaveLength(105);
    expect(second.relinked.every((r) => typeof r.undoId === 'string')).toBe(true);

    const oldest = second.relinked[0];
    expect((await sb.call('stash-get-data')).links[oldest.path].sceneId).toBe(String(Number(before[oldest.path].sceneId) + 1000));
    expect(await sb.call('stash-undo', oldest.undoId)).toEqual({ ok: true });
    expect((await sb.call('stash-get-data')).links[oldest.path].sceneId).toBe(before[oldest.path].sceneId);
    // Used once.
    expect(await sb.call('stash-undo', oldest.undoId)).toEqual({ ok: false, code: 'expired' });
    // The newest still works too.
    expect(await sb.call('stash-undo', second.relinked[104].undoId)).toEqual({ ok: true });
  });
});

describe('ordinary Undo entries still stop at 100, and the two never push each other out', () => {
  it('102 Link / Unlink of one video: the first has expired, the last works; a sync\'s re-link still undoes', { timeout: 60000 }, async () => {
    const { sb, stash, videos, list } = await setup(4);
    mergeAll(stash, videos);
    const second = await sb.call('stash-sync', { videos: list });
    expect(second.relinked).toHaveLength(4);
    const toggled = videos[3].path;
    const sceneId = (await sb.call('stash-get-data')).links[toggled].sceneId;
    const tokens = [];
    for (let i = 0; i < 102; i++) {
      const res = i % 2 === 0
        ? await sb.call('stash-unlink', { path: toggled })
        : await sb.call('stash-link-scene', { path: toggled, sceneId });
      expect(res.ok, `step ${i}`).toBe(true);
      tokens.push(res.undoId);
    }
    expect(await sb.call('stash-undo', tokens[0])).toEqual({ ok: false, code: 'expired' });
    expect(await sb.call('stash-undo', tokens[101])).toEqual({ ok: true });
    // The re-link of another video, made before all of them, is still there.
    const relinkOf0 = second.relinked.find((r) => r.path === videos[0].path);
    expect(await sb.call('stash-undo', relinkOf0.undoId)).toEqual({ ok: true });
  });
});

describe('the code', () => {
  it('re-links are kept for the session; ordinary entries keep the 100 cap; a pending removal never stops the trimming', () => {
    const src = fs.readFileSync('electron/stash-ipc.js', 'utf8');
    expect(src).toContain("undoId: x.undo ? addUndo({ kind: 'video', undo: x.undo }, { session: true }) : null,");
    expect(src).toMatch(/const MAX_UNDO = 100;/);
    expect(src).toMatch(/const MAX_SESSION_UNDO = 20000;/);
    expect(src).not.toMatch(/if \(old\.kind === 'remove'\) break;/);
  });
});
