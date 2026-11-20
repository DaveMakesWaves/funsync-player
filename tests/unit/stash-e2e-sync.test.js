/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A WHOLE Stash sync, end to end (Stash S1 Round 2, s1-2a-main; the test the
// Round 1 client stage asked for, DESIGN-stash-s1.md (d) and (g)): the REAL
// service main.js registers (electron/stash-ipc.js) with the REAL client
// over Node's own fetch, the REAL key file, data file, fingerprinter,
// matcher, mapper and sync job, against the local fake Stash
// (tests/helpers/fake-stash-server.js). Every request leaving the process is
// recorded at fetch itself.
//
//   - Only the configured host: every request is POST <address>/graphql;
//     the addresses inside Stash's answers (scene URLs, stash-box
//     endpoints, a second fake Stash) get nothing, and after the address
//     changes the old one gets nothing either.
//   - Every body is one of the frozen read-only documents, with nothing but
//     ids, pages and hashes as variables: no key, no library path.
//   - The key travels only in the ApiKey header, never in a URL or a body.
//   - Never on its own: a start with Stash linked and "Sync with Stash when
//     FunSync starts" off sends no request at all, through every call the
//     page makes at start-up and when it opens a video's dialog.
//
// Guards checked by reopening their hole (stage s1-2a-main): the client
// built for the address in the Stash data instead of the configured one;
// the start-up sync ignoring the setting.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startFakeStash } from '../helpers/fake-stash-server.js';
import { createSandboxService, makeVideos, scenesFor } from '../helpers/stash-sandbox.js';

const require_ = createRequire(import.meta.url);
const { QUERY_NAMES, queryDocument } = require_('../../electron/stash-queries.js');

const KEY = 'eyJhbGciOiJIUzI1NiJ9.RTJFVEVTVEtFWTAwMDE.ZTJlc2lnbmF0dXJl';
const VARIABLE = /^(id\d{1,2}|page|perPage|oshash|q)$/;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** Every request made through fetch, from now on. */
function recordFetch() {
  const calls = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: { ...(init.headers || {}) }, body: init.body, redirect: init.redirect });
    return real(url, init);
  });
  cleanups.push(() => spy.mockRestore());
  return calls;
}

async function fake(opts) {
  const s = await startFakeStash(opts);
  cleanups.push(() => s.close());
  return s;
}

/** Stash's answers point at `decoy` everywhere they can (scene URLs, stash-box endpoints). */
function scenesPointingAt(videos, decoy) {
  return scenesFor(videos).map((s) => ({
    ...s,
    urls: [`${decoy}/scene/${s.id}`, `${decoy}/graphql?apikey=x`],
    stash_ids: [{ endpoint: `${decoy}/graphql`, stash_id: `00000000-0000-4000-8000-00000000000${s.id}` }],
    performers: s.performers.map((p) => ({ ...p, stash_ids: [{ endpoint: `${decoy}/graphql`, stash_id: `p-${p.id}` }] })),
  }));
}

function checkBodies(calls, { address, libraryDir, videoPaths }) {
  for (const c of calls) {
    expect(c.url).toBe(`${address}/graphql`);
    expect(c.method).toBe('POST');
    expect(c.redirect).toBe('manual');
    expect(c.url.toLowerCase()).not.toContain('apikey');
    const body = JSON.parse(c.body);
    expect(Object.keys(body).sort()).toEqual(['operationName', 'query', 'variables']);
    expect(QUERY_NAMES).toContain(body.operationName);
    const n = Object.keys(body.variables).filter((k) => /^id\d+$/.test(k)).length;
    expect(body.query).toBe(queryDocument(body.operationName, body.operationName === 'FunSyncSceneDetails' ? n : undefined));
    expect(body.query).not.toMatch(/\b(mutation|subscription)\b/);
    for (const k of Object.keys(body.variables)) expect(k).toMatch(VARIABLE);
    expect(c.body).not.toContain(KEY);
    expect(c.body).not.toContain(libraryDir.replace(/\\/g, '\\\\'));
    for (const p of videoPaths) {
      expect(c.body).not.toContain(path.basename(p));
    }
  }
}

describe('a whole sync with the real client', () => {
  it('only the configured host, only read-only documents, the key only in its header', async () => {
    const decoy = await fake();
    const sb = createSandboxService();
    cleanups.push(async () => { await sb.service.shutdown(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
    const videos = makeVideos(sb.dir, 6);
    const stash = await fake({ scenes: scenesPointingAt(videos, decoy.address), apiKey: KEY });
    const calls = recordFetch();
    await sb.service.init();

    expect((await sb.call('stash-link', { address: stash.address, apiKey: KEY })).ok).toBe(true);
    const list = videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs }));
    const res = await sb.call('stash-sync', { videos: list });
    expect(res).toMatchObject({ ok: true, complete: true, counts: { linked: 6 } });
    await sb.call('stash-sync-video', list[2]);
    await sb.call('stash-search', { q: 'synthetic' });
    await sb.call('stash-link-scene', { path: videos[0].path, sceneId: '4' });
    await sb.call('stash-open-scene', { path: videos[1].path });

    expect(calls.length).toBe(stash.requests.length);
    expect(new Set(calls.map((c) => c.headers.ApiKey))).toEqual(new Set([KEY]));
    checkBodies(calls, { address: stash.address, libraryDir: path.join(sb.dir, 'library'), videoPaths: videos.map((v) => v.path) });
    expect(stash.requests.every((r) => r.method === 'POST' && r.url === '/graphql' && r.headers.apikey === KEY)).toBe(true);
    expect(new Set(stash.requests.map((r) => r.json.operationName))).toEqual(new Set([
      'FunSyncTest', 'FunSyncSceneList', 'FunSyncSceneDetails', 'FunSyncScenesByOshash', 'FunSyncSceneSearch',
      // The next lot (2026-11-19): a full sync also reads the tag list.
      'FunSyncTagList',
    ]));
    // The addresses inside Stash's answers were never contacted.
    expect(decoy.requests).toEqual([]);
    // Open in Stash went to the browser, not through fetch.
    expect(sb.opened).toEqual([`${stash.address}/scenes/2`]);
    // Nothing Stash built was stored.
    const stored = fs.readFileSync(path.join(sb.dir, 'stash', 'library.json'), 'utf8');
    expect(stored.toLowerCase()).not.toContain('apikey=');
    expect(stored).not.toContain(KEY);
  });

  it('after the address changes, every request goes to the new one; the old one gets nothing (guard)', async () => {
    const sb = createSandboxService();
    cleanups.push(async () => { await sb.service.shutdown(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
    const videos = makeVideos(sb.dir, 3);
    const one = await fake({ scenes: scenesFor(videos) });
    const two = await fake({ scenes: scenesFor(videos) });
    await sb.service.init();
    await sb.call('stash-link', { address: one.address });
    await sb.call('stash-sync', { videos: videos.map(({ path: p }) => ({ path: p })) });
    expect((await sb.call('stash-get-data')).server.url).toBe(one.address);

    await sb.call('stash-link', { address: two.address });
    one.reset();
    const calls = recordFetch();
    await sb.call('stash-sync', { videos: videos.map(({ path: p }) => ({ path: p })) });
    await sb.call('stash-sync-video', { path: videos[0].path });
    await sb.call('stash-search', { q: 'synthetic' });
    expect(one.requests).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.url).toBe(`${two.address}/graphql`);
    expect((await sb.call('stash-get-data')).server.url).toBe(two.address);
  });
});

describe('never on its own', () => {
  async function startedApp({ syncOnStart }) {
    const sb0 = createSandboxService();
    const videos = makeVideos(sb0.dir, 3);
    const stash = await fake({ scenes: scenesFor(videos), apiKey: KEY });
    // A linked Stash from an earlier session: address, on, key saved, data synced.
    await sb0.service.init();
    await sb0.call('stash-link', { address: stash.address, apiKey: KEY });
    await sb0.call('stash-sync', { videos: videos.map(({ path: p }) => ({ path: p })) });
    await sb0.service.shutdown();
    stash.reset();
    // The next start: a fresh main process over the same userData.
    const sb = createSandboxService({ dir: sb0.dir, store: sb0.store });
    sb.store.setSetting('stash.syncOnStart', syncOnStart);
    cleanups.push(async () => { await sb.service.shutdown(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
    return { sb, stash, videos };
  }

  it('with "Sync with Stash when FunSync starts" off, a start sends no request at all', async () => {
    const { sb, stash, videos } = await startedApp({ syncOnStart: false });
    const calls = recordFetch();
    await sb.service.init();
    // What the page does at start-up and when a video's dialog opens.
    expect((await sb.call('stash-status')).settings).toMatchObject({ enabled: true, syncOnStart: false });
    const data = await sb.call('stash-get-data');
    expect(Object.keys(data.links)).toHaveLength(3);
    expect(await sb.call('stash-sync-on-start', { videos: videos.map(({ path: p }) => ({ path: p })) }))
      .toEqual({ ok: true, started: false, reason: 'off' });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    expect(stash.requests).toEqual([]);
  });

  it('with it on, the start-up sync runs once, and only when the page asks after its first scan', async () => {
    const { sb, stash, videos } = await startedApp({ syncOnStart: true });
    const calls = recordFetch();
    await sb.service.init();
    await sb.call('stash-status');
    await sb.call('stash-get-data');
    expect(calls).toEqual([]);
    const res = await sb.call('stash-sync-on-start', { videos: videos.map(({ path: p }) => ({ path: p })) });
    expect(res).toMatchObject({ started: true, ok: true });
    const sent = calls.length;
    expect(sent).toBeGreaterThan(0);
    expect(await sb.call('stash-sync-on-start', { videos: [] })).toMatchObject({ started: false, reason: 'done' });
    expect(calls.length).toBe(sent);
    expect(stash.requests.length).toBe(sent);
  });
});
