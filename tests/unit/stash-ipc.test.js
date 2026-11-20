/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The main-process Stash service behind every `stash-*` IPC channel
// (electron/stash-ipc.js; Stash S1 Round 2, 2026-11-18). REAL modules
// throughout (data file, key file, client, matcher, mapper, fingerprinter,
// sync) in a temp userData folder, against the local fake Stash
// (tests/helpers/fake-stash-server.js); no other host.
//
// Guards checked by reopening their hole (stage s1-2a-main):
//   - Remove Stash data: the set-aside files go only after the Undo window
//     (hole: discard at once)
//   - Remove during a sync: the sync is stopped first, so nothing is written
//     back after the removal (hole: no cancel)
//   - Trust: only a certificate this session was shown at that origin can be
//     pinned (hole: pin whatever the page sends); a new origin drops the pin
//     (hole: keep it)
//   - a saved key is never sent to another address (hole: the saved key for
//     any address)
//   - s1-fixup-main (2026-11-19, S1RB-1): the key is bound to the address
//     key.json records, not to settings.stash.url: a renderer write of the
//     address, a restored or recovered config and the start-up sync never
//     take it along (hole: compare with settings.stash.url, as before)
//   - s1-fixup-main (RA-S1-3): Not this scene… refuses only the scene its
//     confirm named (hole: refuse whatever is linked now)
//   - s1-fixup-main (review-a note): a failed Undo of Remove Stash data never
//     deletes the set-aside files and may be tried again (hole: drop the
//     entry before the Undo)
//   - the renderer cannot write the trusted certificate (hole: let
//     set-setting write it)
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeStash, testCertificate } from '../helpers/fake-stash-server.js';
import { createSandboxService, makeVideos, scenesFor } from '../helpers/stash-sandbox.js';
import { createRequire } from 'node:module';

const dataExport = createRequire(import.meta.url)('../../electron/data-export.js');

const KEY = 'eyJhbGciOiJIUzI1NiJ9.SVBDVEVTVEtFWTAwMDE.aXBjc2lnbmF0dXJl';
const KEY2 = 'eyJhbGciOiJIUzI1NiJ9.SVBDVEVTVEtFWTAwMDI.aXBjc2lnbmF0dXJl';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fake(opts = {}) {
  const s = await startFakeStash(opts);
  cleanups.push(() => s.close());
  return s;
}

function sandbox(o = {}) {
  const sb = createSandboxService(o);
  cleanups.push(async () => { await sb.service.shutdown(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  return sb;
}

/** A sandbox linked to a fake Stash that has one scene per video. */
async function linked({ n = 3, apiKey = null, settings = {} } = {}) {
  const sb = sandbox();
  const videos = makeVideos(sb.dir, n);
  const stash = await fake({ scenes: scenesFor(videos), apiKey });
  await sb.service.init();
  const res = await sb.call('stash-link', { address: `${stash.address}/`, ...(apiKey ? { apiKey } : {}) });
  expect(res.ok).toBe(true);
  for (const [k, v] of Object.entries(settings)) sb.store.setSetting(`stash.${k}`, v);
  stash.reset();
  return { ...sb, videos, stash };
}

const ops = (stash) => stash.requests.map((r) => r.json && r.json.operationName);

describe('start-up and status', () => {
  it('init reads the local files and sends nothing; status says what Settings needs, never the key', async () => {
    const sb = sandbox({ settings: { stash: { enabled: true, url: 'http://127.0.0.1:9', syncOnStart: false } } });
    sb.secret.save(KEY);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await sb.service.init();
      const st = await sb.call('stash-status');
      expect(st).toMatchObject({
        ok: true,
        settings: { enabled: true, url: 'http://127.0.0.1:9', syncOnStart: false, pathRules: [], trustedCert: null },
        key: { hasKey: true, keyStorage: 'plain', saveStorage: 'plain', plainReason: 'portable', unreadable: false },
        keyTravelsInClear: false,
        library: { state: 'empty', writable: true },
        sync: { running: false, kind: null, progress: null },
      });
      expect(JSON.stringify(st)).not.toContain(KEY);
      expect(await sb.call('stash-get-data')).toMatchObject({ v: 1, links: {}, scenes: {} });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keyTravelsInClear: a key to http on another machine', async () => {
    const sb = sandbox({ settings: { stash: { url: 'http://192.168.1.20:9999' } } });
    await sb.service.init();
    sb.secret.save(KEY, { address: 'http://192.168.1.20:9999' });
    expect((await sb.call('stash-status')).keyTravelsInClear).toBe(true);
    // A key of another address is not sent, so it does not travel.
    sb.secret.save(KEY, { address: 'http://127.0.0.1:9999' });
    expect((await sb.call('stash-status')).keyTravelsInClear).toBe(false);
  });

  it('a key file from before the address was stored belongs to the address in use at start-up (once; the file then says so)', async () => {
    const sb = sandbox({ settings: { stash: { enabled: true, url: 'http://127.0.0.1:9' } } });
    const keyFile = path.join(sb.dir, 'stash', 'key.json');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `${JSON.stringify({ v: 1, storage: 'plain', value: KEY })}\n`);
    await sb.service.init();
    expect((await sb.call('stash-status')).key).toMatchObject({ hasKey: true, address: 'http://127.0.0.1:9', elsewhere: false });
    expect(JSON.parse(fs.readFileSync(keyFile, 'utf8'))).toEqual({ v: 1, storage: 'plain', value: KEY, address: 'http://127.0.0.1:9' });
  });
});

describe('Test and Link', () => {
  it('Test with a typed key: the address comes back normalized, the key is not saved', async () => {
    const stash = await fake({ apiKey: KEY });
    const sb = sandbox();
    await sb.service.init();
    const res = await sb.call('stash-test', { address: `  ${stash.address}/graphql `, apiKey: KEY });
    expect(res).toEqual({ ok: true, address: stash.address, version: 'v0.32.0', sceneCount: 9, keyTravelsInClear: false });
    expect(sb.secret.status().hasKey).toBe(false);
    expect(stash.requests.map((r) => r.headers.apikey)).toEqual([KEY]);
    expect(await sb.call('stash-test', { address: stash.address })).toMatchObject({ ok: false, code: 'needsKey', address: stash.address });
    expect(await sb.call('stash-test', { address: stash.address, apiKey: KEY2 })).toMatchObject({ ok: false, code: 'badKey' });
    expect(await sb.call('stash-test', { address: 'ftp://x' })).toEqual({ ok: false, code: 'badAddress' });
    expect(await sb.call('stash-test', { address: stash.address, apiKey: 'two words' })).toMatchObject({ ok: false, code: 'invalidKey' });
  });

  it('Link saves the address, turns Stash on and saves the key; nothing is synced', async () => {
    const stash = await fake({ apiKey: KEY });
    const sb = sandbox();
    await sb.service.init();
    const res = await sb.call('stash-link', { address: `${stash.address}/`, apiKey: KEY });
    expect(res).toMatchObject({
      ok: true, version: 'v0.32.0', sceneCount: 9, keySaved: true,
      settings: { enabled: true, url: stash.address }, key: { hasKey: true, keyStorage: 'plain' },
    });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(sb.secret.getKey()).toBe(KEY);
    expect(ops(stash)).toEqual(['FunSyncTest']);
    expect(sb.events.filter((e) => e.channel === 'stash-settings-changed').at(-1).payload).toMatchObject({ url: stash.address, enabled: true });
  });

  it('a failed Test links nothing', async () => {
    const stash = await fake({ mode: 'html' });
    const sb = sandbox();
    await sb.service.init();
    expect(await sb.call('stash-link', { address: stash.address })).toMatchObject({ ok: false, code: 'notStash' });
    expect(sb.store.getSetting('stash.url')).toBe('');
    expect(sb.store.getSetting('stash.enabled')).toBe(false);
  });

  it('the saved key is used only for its own address (guard): another address gets no key, and linking it drops the old key', async () => {
    const one = await fake({ apiKey: KEY });
    const two = await fake();
    const sb = sandbox();
    await sb.service.init();
    await sb.call('stash-link', { address: one.address, apiKey: KEY });
    expect(await sb.call('stash-test', { address: one.address })).toMatchObject({ ok: true });
    expect(await sb.call('stash-test', { address: two.address })).toMatchObject({ ok: true });
    expect(two.requests.map((r) => r.headers.apikey)).toEqual([undefined]);
    // s1-fixup-main (S1RB-1): the address changed without stash-link (a page
    // write; a restore or recovery does the same to settings): still no key.
    sb.service.applySettingWrite('stash.url', two.address);
    expect(await sb.call('stash-test', { address: two.address })).toMatchObject({ ok: true, keyElsewhere: one.address });
    expect(two.requests.map((r) => r.headers.apikey)).toEqual([undefined, undefined]);
    expect(await sb.call('stash-link', { address: two.address })).toMatchObject({ ok: true, key: { hasKey: false } });
    expect(sb.secret.getKey()).toBe('');
    expect(JSON.stringify(two.requests)).not.toContain(KEY);
  });

  it('the key is bound to the address it was saved for, not to settings.stash.url (guard, S1RB-1): a page write, a restored config and the start-up sync never take it along', async () => {
    const mine = await fake({ apiKey: KEY });
    const other = await fake();
    const sb = sandbox();
    const videos = makeVideos(sb.dir, 1);
    await sb.service.init();
    await sb.call('stash-link', { address: mine.address, apiKey: KEY });
    expect(JSON.parse(fs.readFileSync(path.join(sb.dir, 'stash', 'key.json'), 'utf8')).address).toBe(mine.address);

    // (a) A renderer set-setting of the address (main.js -> applySettingWrite).
    sb.service.applySettingWrite('stash.url', other.address);
    const tested = await sb.call('stash-test', { address: other.address });
    expect(tested).toMatchObject({ ok: true, keyElsewhere: mine.address });
    const st = await sb.call('stash-status');
    expect(st.key).toMatchObject({ hasKey: true, address: mine.address, elsewhere: true });
    expect(st.keyTravelsInClear).toBe(false);
    // (b) A config snapshot restore / boot recovery: settings replaced whole,
    // key.json untouched; the relaunch's start-up sync.
    sb.store.settings.stash = { ...sb.store.settings.stash, url: other.address, enabled: true, syncOnStart: true, trustedCert: null };
    const sb2 = sandbox({ dir: sb.dir, store: sb.store });
    await sb2.service.init();
    const started = await sb2.call('stash-sync-on-start', { videos: videos.map(({ path: p }) => ({ path: p })) });
    expect(started).toMatchObject({ started: true, keyElsewhere: mine.address });
    // ... and Sync now, Sync this video and Find in Stash.
    await sb2.call('stash-sync', { videos: videos.map(({ path: p }) => ({ path: p })) });
    await sb2.call('stash-sync-video', { path: videos[0].path });
    await sb2.call('stash-search', { q: 'synthetic' });
    expect(other.requests.length).toBeGreaterThan(3);
    expect(other.requests.map((r) => r.headers.apikey).filter((k) => k !== undefined)).toEqual([]);
    expect(JSON.stringify(other.requests)).not.toContain(KEY);

    // (c) An import (data-export.js mergeConfig): an overwrite import takes
    // the backup's address; the key file is never part of a backup.
    const cfg = (stash) => ({ settings: { stash }, playlists: [], categories: [], videoCategories: {} });
    const imported = dataExport.mergeConfig(cfg({ ...sb.store.settings.stash }), cfg({ enabled: true, url: other.address, syncOnStart: true, pathRules: [] }), 'overwrite');
    sb.store.settings.stash = { ...imported.settings.stash, trustedCert: null };
    const sb3 = sandbox({ dir: sb.dir, store: sb.store });
    await sb3.service.init();
    other.reset();
    expect(await sb3.call('stash-sync-on-start', { videos: videos.map(({ path: p }) => ({ path: p })) })).toMatchObject({ started: true, keyElsewhere: mine.address });
    expect(other.requests.length).toBeGreaterThan(0);
    expect(other.requests.map((r) => r.headers.apikey).filter((k) => k !== undefined)).toEqual([]);

    // Back at the key's own address: it is sent again.
    mine.reset();
    expect(await sb2.call('stash-link', { address: mine.address })).toMatchObject({ ok: true, key: { hasKey: true, elsewhere: false } });
    expect(mine.requests.map((r) => r.headers.apikey)).toEqual([KEY]);
  });
});

describe('Sync now, Sync this video and the start-up sync', () => {
  it('links each video to its scene, reports progress, and tells the page after the write', async () => {
    const sb = await linked({ apiKey: KEY });
    const res = await sb.call('stash-sync', { videos: sb.videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs })) });
    expect(res).toMatchObject({ ok: true, kind: 'full', written: true, partial: false, complete: true, error: null });
    expect(res.counts).toEqual({ linked: 3, check: 0, notInStash: 0, gone: 0, changed: 0, skipped: 0 });
    const data = await sb.call('stash-get-data');
    for (const v of sb.videos) expect(data.links[v.path]).toMatchObject({ server: sb.stash.address, by: 'oshash', state: 'ok' });
    expect(data.scenes[data.links[sb.videos[0].path].sceneId].title).toBe('Synthetic Scene Small');
    const progress = sb.events.filter((e) => e.channel === 'stash-progress').map((e) => e.payload.step);
    expect(new Set(progress)).toEqual(new Set(['hash', 'list', 'match', 'details', 'write', 'finished']));
    expect(sb.events.some((e) => e.channel === 'stash-changed')).toBe(true);
    expect(fs.existsSync(path.join(sb.dir, 'stash', 'fingerprints.json'))).toBe(true);
  });

  it('one job at a time: a second sync while one runs is busy; Cancel stops it', async () => {
    const sb = await linked();
    sb.stash.set({ mode: 'slow', delayMs: 300 });
    const videos = sb.videos.map(({ path: p }) => ({ path: p }));
    const first = sb.call('stash-sync', { videos });
    await vi.waitFor(() => expect(sb.service.isSyncing()).toBe(true));
    expect(await sb.call('stash-sync', { videos })).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect((await sb.call('stash-status')).sync.running).toBe(true);
    expect(await sb.call('stash-cancel')).toEqual({ ok: true, cancelled: true });
    expect(await first).toMatchObject({ ok: false, cancelled: true });
  });

  it('turned off or never linked: no sync and no request', async () => {
    const sb = await linked({ settings: { enabled: false } });
    expect(await sb.call('stash-sync', { videos: [{ path: sb.videos[0].path }] })).toMatchObject({ ok: false, error: { code: 'notLinked' } });
    expect(sb.stash.requests).toEqual([]);
  });

  it('the start-up sync runs only with "Sync with Stash when FunSync starts" on, once per session', async () => {
    const off = await linked();
    const videos = off.videos.map(({ path: p }) => ({ path: p }));
    expect(await off.call('stash-sync-on-start', { videos })).toEqual({ ok: true, started: false, reason: 'off' });
    expect(off.stash.requests).toEqual([]);

    const on = await linked({ settings: { syncOnStart: true } });
    const res = await on.call('stash-sync-on-start', { videos: on.videos.map(({ path: p }) => ({ path: p })) });
    expect(res).toMatchObject({ started: true, ok: true, kind: 'full' });
    const sent = on.stash.requests.length;
    expect(sent).toBeGreaterThan(0);
    expect(await on.call('stash-sync-on-start', { videos })).toEqual({ ok: true, started: false, reason: 'done' });
    expect(on.stash.requests.length).toBe(sent);
  });

  it('Sync this video links one video', async () => {
    const sb = await linked();
    const v = sb.videos[1];
    const res = await sb.call('stash-sync-video', { path: v.path, size: v.size, mtimeMs: v.mtimeMs });
    expect(res).toMatchObject({ ok: true, kind: 'video', written: true });
    expect((await sb.call('stash-get-data')).links[v.path]).toMatchObject({ sceneId: '2', by: 'oshash' });
    expect(ops(sb.stash)).toEqual(['FunSyncScenesByOshash', 'FunSyncSceneDetails']);
  });
});

describe('a video\'s link: choose, refuse, unlink, Find in Stash, Undo', () => {
  async function synced() {
    const sb = await linked();
    await sb.call('stash-sync', { videos: sb.videos.map(({ path: p }) => ({ path: p })) });
    return sb;
  }

  it('Not this scene, then Undo: the link and the refusal are exactly as before', async () => {
    const sb = await synced();
    const v = sb.videos[0].path;
    const before = await sb.call('stash-get-data');
    const res = await sb.call('stash-refuse', { path: v, target: 'link' });
    expect(res).toEqual({ ok: true, undoId: expect.stringMatching(/^[0-9a-f]{24}$/) });
    const after = await sb.call('stash-get-data');
    expect(after.links[v]).toBeUndefined();
    expect(after.refused[v]).toMatchObject({ sceneIds: ['1'], server: sb.stash.address });
    expect(await sb.call('stash-undo', res.undoId)).toEqual({ ok: true });
    const back = await sb.call('stash-get-data');
    expect(JSON.stringify(back.links[v])).toBe(JSON.stringify(before.links[v]));
    expect(back.refused[v]).toBeUndefined();
    expect(await sb.call('stash-undo', res.undoId)).toEqual({ ok: false, code: 'expired' });
    expect(await sb.call('stash-undo', 'not-a-token')).toEqual({ ok: false, code: 'expired' });
  });

  it('Not this scene… refuses only the scene its confirm named (guard, RA-S1-3): a link that changed meanwhile stays, and is reported', async () => {
    const sb = await linked({ n: 2 });
    const list = sb.videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs }));
    await sb.call('stash-sync', { videos: list });
    const p = sb.videos[0].path;
    const shown = (await sb.call('stash-get-data')).links[p].sceneId; // what the confirm named
    // Meanwhile the link moves to another scene (a sync re-link, Use this scene...).
    await sb.library.applySync((d) => { d.links[p] = { ...d.links[p], sceneId: '2' }; return {}; });
    const res = await sb.call('stash-refuse', { path: p, target: 'link', sceneId: shown });
    expect(res).toMatchObject({ ok: true, undoId: expect.any(String), linkChanged: true, linkedSceneId: '2' });
    const data = await sb.call('stash-get-data');
    expect(data.refused[p].sceneIds).toEqual([shown]);
    expect(data.links[p]).toMatchObject({ sceneId: '2', state: 'ok' });
    expect(await sb.call('stash-refuse', { path: p, target: 'link', sceneId: 'x' })).toEqual({ ok: false, code: 'badInput' });
    expect(await sb.call('stash-unlink', { path: p, sceneId: shown })).toEqual({ ok: false, code: 'changed-since' });
  });

  it('Not this scene… for a link stored without an oshash: main hashes the file now; an unreadable file answers skipped, never "changed meanwhile"', async () => {
    const sb = await linked({ n: 2 });
    const [v, gone] = sb.videos;
    await sb.library.link(v.path, { sceneId: '1', fp: { size: v.size, mtimeMs: v.mtimeMs, oshash: null }, server: sb.stash.address });
    expect(await sb.call('stash-refuse', { path: v.path, target: 'link', sceneId: '1' })).toMatchObject({ ok: true });
    expect((await sb.call('stash-get-data')).refused[v.path]).toMatchObject({ oshash: v.oshash, sceneIds: ['1'] });
    await sb.library.link(gone.path, { sceneId: '2', fp: { size: gone.size, mtimeMs: gone.mtimeMs, oshash: null }, server: sb.stash.address });
    fs.rmSync(gone.path);
    expect(await sb.call('stash-refuse', { path: gone.path, target: 'link', sceneId: '2' })).toEqual({ ok: false, code: 'skipped' });
    expect((await sb.call('stash-get-data')).links[gone.path]).toMatchObject({ sceneId: '2' });
  });

  it('Unlink and its Undo; bad input is refused without a write', async () => {
    const sb = await synced();
    const v = sb.videos[2].path;
    const res = await sb.call('stash-unlink', { path: v });
    expect((await sb.call('stash-get-data')).links[v]).toBeUndefined();
    await sb.call('stash-undo', res.undoId);
    expect((await sb.call('stash-get-data')).links[v]).toMatchObject({ sceneId: '3' });
    expect(await sb.call('stash-unlink', { path: '' })).toEqual({ ok: false, code: 'badInput' });
    expect(await sb.call('stash-choose', { path: v, sceneId: '9' })).toEqual({ ok: false, code: 'not-a-candidate' });
    expect(await sb.call('stash-refuse', { path: v, target: 'x' })).toEqual({ ok: false, code: 'badInput' });
  });

  it('Find in Stash…: search answers names, never paths; a pick links by hand with the file\'s fingerprint', async () => {
    const sb = await linked();
    const found = await sb.call('stash-search', { q: 'synthetic' });
    expect(found.ok).toBe(true);
    expect(found.scenes.length).toBeGreaterThan(0);
    expect(found.scenes[0]).toEqual({
      id: expect.any(String), title: expect.any(String), code: expect.anything(), date: expect.anything(),
      studio: expect.anything(), files: [{ name: expect.stringMatching(/^clip-\d+\.mp4$/), size: expect.any(Number), duration: expect.any(Number) }],
    });
    expect(JSON.stringify(found)).not.toContain('/data/stash');
    const v = sb.videos[0];
    const res = await sb.call('stash-link-scene', { path: v.path, sceneId: '2' });
    expect(res.ok).toBe(true);
    const link = (await sb.call('stash-get-data')).links[v.path];
    expect(link).toMatchObject({ sceneId: '2', by: 'manual', server: sb.stash.address, fp: { size: v.size, oshash: v.oshash } });
    expect(await sb.call('stash-link-scene', { path: v.path, sceneId: '999' })).toEqual({ ok: false, code: 'notFound' });
    expect(await sb.call('stash-link-scene', { path: v.path, sceneId: '1@x' })).toEqual({ ok: false, code: 'badInput' });
  });

  it('re-home moves a video\'s link to its new path in one write', async () => {
    const sb = await synced();
    const from = sb.videos[0].path;
    const to = path.join(sb.dir, 'moved', 'Clip 1.mp4');
    expect(await sb.call('stash-rehome', [{ from, to }])).toEqual({ ok: true, moved: 1 });
    const data = await sb.call('stash-get-data');
    expect(data.links[from]).toBeUndefined();
    expect(data.links[to]).toMatchObject({ sceneId: '1', verify: true });
    expect(await sb.call('stash-rehome', 'x')).toEqual({ ok: false, code: 'badInput' });
  });

  it('Open in Stash opens <address>/scenes/<id> for the link, or a candidate', async () => {
    const sb = await synced();
    expect(await sb.call('stash-open-scene', { path: sb.videos[1].path })).toEqual({ ok: true });
    expect(await sb.call('stash-open-scene', { path: sb.videos[1].path, sceneId: '3' })).toEqual({ ok: true });
    expect(sb.opened).toEqual([`${sb.stash.address}/scenes/2`, `${sb.stash.address}/scenes/3`]);
    expect(await sb.call('stash-open-scene', { path: 'C:\\nothing.mp4' })).toEqual({ ok: false, code: 'badInput' });
  });
});

describe('Remove Stash data… and its Undo', () => {
  function manualTimers() {
    const pending = [];
    return {
      pending,
      setTimeout: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
      clearTimeout: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
      async fire() { const all = pending.splice(0); for (const t of all) await t.fn(); },
    };
  }

  it('sets the data and the key aside; Undo in time puts both back; the files go only after the window (guard)', async () => {
    const timers = manualTimers();
    const sb = sandbox({ timers });
    const videos = makeVideos(sb.dir, 2);
    const stash = await fake({ scenes: scenesFor(videos), apiKey: KEY });
    await sb.service.init();
    await sb.call('stash-link', { address: stash.address, apiKey: KEY });
    await sb.call('stash-sync', { videos: videos.map(({ path: p }) => ({ path: p })) });
    const stashDir = path.join(sb.dir, 'stash');
    const libFile = path.join(stashDir, 'library.json');
    const before = fs.readFileSync(libFile, 'utf8');

    const res = await sb.call('stash-remove-data');
    expect(res).toMatchObject({ ok: true, undoMs: 8000, key: { hasKey: false } });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(fs.existsSync(libFile)).toBe(false);
    expect(sb.secret.getKey()).toBe('');
    expect((await sb.call('stash-get-data')).links).toEqual({});
    // The set-aside file is still there while Undo can be pressed.
    expect(fs.readdirSync(stashDir).some((f) => f.startsWith('library.removed-'))).toBe(true);
    expect(timers.pending.map((t) => t.ms)).toEqual([10000]);

    expect(await sb.call('stash-undo', res.undoId)).toMatchObject({ ok: true, key: { hasKey: true } });
    expect(fs.readFileSync(libFile, 'utf8')).toBe(before);
    expect(sb.secret.getKey()).toBe(KEY);
    expect(timers.pending).toEqual([]);

    // Removed again and the window passes: the set-aside files are deleted, Undo is over.
    const again = await sb.call('stash-remove-data');
    expect(fs.readdirSync(stashDir).some((f) => f.startsWith('library.removed-'))).toBe(true);
    await timers.fire();
    expect(fs.readdirSync(stashDir).some((f) => f.startsWith('library.removed-'))).toBe(false);
    expect(await sb.call('stash-undo', again.undoId)).toEqual({ ok: false, code: 'expired' });
  });

  it('an Undo that fails keeps the set-aside files: it can be tried again, and they are never deleted after it (guard)', async () => {
    const timers = manualTimers();
    const sb = sandbox({ timers });
    const videos = makeVideos(sb.dir, 1);
    const stash = await fake({ scenes: scenesFor(videos), apiKey: KEY });
    await sb.service.init();
    await sb.call('stash-link', { address: stash.address, apiKey: KEY });
    await sb.call('stash-sync', { videos: videos.map(({ path: p }) => ({ path: p })) });
    const stashDir = path.join(sb.dir, 'stash');
    const aside = () => fs.readdirSync(stashDir).filter((f) => f.startsWith('library.removed-')).sort();
    const realUndo = sb.library.undoRemove;
    const failing = async () => ({ ok: false, error: 'restore-failed' }); // a locked file

    // Tried again in its window: it works, and the key comes back for its own address.
    const res = await sb.call('stash-remove-data');
    sb.library.undoRemove = failing;
    expect(await sb.call('stash-undo', res.undoId)).toEqual({ ok: false, code: 'restore-failed' });
    sb.library.undoRemove = realUndo;
    expect(await sb.call('stash-undo', res.undoId)).toMatchObject({ ok: true, key: { hasKey: true, address: stash.address, elsewhere: false } });
    expect(sb.secret.getKey()).toBe(KEY);
    expect(aside()).toEqual([]);

    // Not tried again: the window passes, and the set-aside files are kept.
    const again = await sb.call('stash-remove-data');
    const setAside = aside();
    expect(setAside.length).toBeGreaterThan(0);
    sb.library.undoRemove = failing;
    expect(await sb.call('stash-undo', again.undoId)).toEqual({ ok: false, code: 'restore-failed' });
    sb.library.undoRemove = realUndo;
    expect(timers.pending.map((t) => t.ms)).toEqual([10000]);
    await timers.fire();
    expect(aside()).toEqual(setAside); // kept: the user asked for them back
  });

  it('a sync running at the time is stopped first: nothing is written back after the removal (guard)', async () => {
    const sb = await linked({ n: 3 });
    sb.stash.set({ mode: 'slow', delayMs: 200 });
    const run = sb.call('stash-sync', { videos: sb.videos.map(({ path: p }) => ({ path: p })) });
    await vi.waitFor(() => expect(sb.service.isSyncing()).toBe(true));
    const res = await sb.call('stash-remove-data');
    expect(res.ok).toBe(true);
    await run;
    await sb.library.idle();
    expect(fs.existsSync(path.join(sb.dir, 'stash', 'library.json'))).toBe(false);
    expect((await sb.call('stash-get-data')).links).toEqual({});
  });
});

describe('Trust this certificate (guards)', () => {
  it('pins only a certificate this session was shown at that origin; then Test passes; a new origin drops the pin', async () => {
    const A = testCertificate('a');
    const B = testCertificate('b');
    const https = await fake({ tls: { key: A.key, cert: A.cert } });
    const origin = new URL(https.address).origin;
    const sb = sandbox();
    await sb.service.init();

    // Nothing seen yet: nothing can be pinned, whatever the page sends.
    expect(await sb.call('stash-trust-certificate', { address: https.address, fingerprint256: A.fingerprint256 }))
      .toEqual({ ok: false, code: 'notSeen' });
    const first = await sb.call('stash-test', { address: https.address });
    expect(first).toMatchObject({ ok: false, code: 'certificate', certificate: { origin, fingerprint256: A.fingerprint256, pinMismatch: false } });
    // Another fingerprint than the one shown: refused.
    expect(await sb.call('stash-trust-certificate', { address: https.address, fingerprint256: B.fingerprint256 }))
      .toEqual({ ok: false, code: 'notSeen' });
    // The one shown, at another origin: refused.
    expect(await sb.call('stash-trust-certificate', { address: `https://localhost:${new URL(https.address).port}`, fingerprint256: A.fingerprint256 }))
      .toEqual({ ok: false, code: 'notSeen' });
    const trusted = await sb.call('stash-trust-certificate', { address: https.address, fingerprint256: A.fingerprint256 });
    expect(trusted).toMatchObject({ ok: true, settings: { trustedCert: { origin, sha256: A.fingerprint256 } } });
    expect(trusted.settings.trustedCert.subject).toContain('FunSync test Stash A');
    expect(await sb.call('stash-test', { address: https.address })).toMatchObject({ ok: true, sceneCount: 9 });
    expect(await sb.call('stash-link', { address: https.address })).toMatchObject({ ok: true, settings: { url: https.address, trustedCert: { origin } } });
    expect(https.requests.every((r) => r.method === 'POST' && r.url === '/graphql')).toBe(true);

    // Changing the address drops the pin.
    const plain = await fake();
    expect(await sb.call('stash-link', { address: plain.address })).toMatchObject({ ok: true, settings: { trustedCert: null } });
  });

  it('the page cannot write the trusted certificate; an address it writes is normalized and drops the pin', async () => {
    const sb = sandbox({ settings: { stash: { url: 'https://nas.lan:9999', trustedCert: { origin: 'https://nas.lan:9999', sha256: testCertificate('a').fingerprint256, subject: null, at: 1 } } } });
    await sb.service.init();
    const forged = { origin: 'https://evil.lan', sha256: testCertificate('b').fingerprint256 };
    expect(sb.service.ownsSetting('stash.trustedCert')).toBe(true);
    expect(sb.service.ownsSetting('player.volume')).toBe(false);
    sb.service.applySettingWrite('stash.trustedCert', forged);
    sb.service.applySettingWrite('stash', { enabled: true, trustedCert: forged, url: 'https://nas.lan:9999/', apiKey: KEY });
    expect(sb.store.settings.stash.trustedCert.origin).toBe('https://nas.lan:9999');
    expect(sb.store.settings.stash).toMatchObject({ enabled: true, url: 'https://nas.lan:9999' });
    expect(JSON.stringify(sb.store.settings)).not.toContain(KEY);
    sb.service.applySettingWrite('stash.enabled', 'yes');
    expect(sb.store.settings.stash.enabled).toBe(true);
    const s = sb.service.applySettingWrite('stash.url', 'https://other.lan:9999');
    expect(s).toMatchObject({ url: 'https://other.lan:9999', trustedCert: null });
    expect(sb.events.at(-1)).toMatchObject({ channel: 'stash-settings-changed', payload: { url: 'https://other.lan:9999' } });
    sb.service.applySettingWrite('stash.url', 'not an address');
    expect(sb.store.settings.stash.url).toBe('https://other.lan:9999');
  });
});

describe('shutdown', () => {
  it('stops a running sync and finishes a pending removal', async () => {
    const sb = await linked();
    sb.stash.set({ mode: 'slow', delayMs: 200 });
    const run = sb.call('stash-sync', { videos: sb.videos.map(({ path: p }) => ({ path: p })) });
    await vi.waitFor(() => expect(sb.service.isSyncing()).toBe(true));
    await sb.service.shutdown();
    expect(sb.service.isSyncing()).toBe(false);
    expect((await run).cancelled).toBe(true);
  });
});

describe('s1-fixup-main (2026-11-19): data guards end to end', () => {
  it('an import of a backup made before "Not this scene" never brings the link back; a sync heals one that is there (guard, S1RB-3)', async () => {
    const sb = await linked({ n: 2 });
    const list = sb.videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs }));
    await sb.call('stash-sync', { videos: list });
    const backup = JSON.parse(fs.readFileSync(path.join(sb.dir, 'stash', 'library.json'), 'utf8'));
    const p = sb.videos[0].path;
    const shown = (await sb.call('stash-get-data')).links[p].sceneId;
    expect(await sb.call('stash-refuse', { path: p, target: 'link', sceneId: shown })).toMatchObject({ ok: true });
    // data-export.js applyImport -> mergeImported
    expect(await sb.library.mergeImported(backup)).toMatchObject({ ok: true });
    expect((await sb.call('stash-get-data')).links[p]).toBeUndefined();
    // A link to the refused scene that is there anyway (data from before this fix): the sync drops it.
    await sb.library.applySync((d) => { d.links[p] = backup.links[p]; return {}; });
    expect(await sb.call('stash-sync', { videos: list })).toMatchObject({ ok: true, complete: true });
    const data = await sb.call('stash-get-data');
    expect(data.links[p]).toBeUndefined();
    expect(data.refused[p].sceneIds).toEqual([shown]);
    expect(data.links[sb.videos[1].path]).toMatchObject({ state: 'ok' });
  });

  it('a Stash reset at the same address: links to reused ids become changed (never ok), the old record stays, Sync this video too (guard, S1RB-4)', async () => {
    const sb = await linked({ n: 3 });
    const list = sb.videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs }));
    await sb.call('stash-sync', { videos: list });
    const before = await sb.call('stash-get-data');
    const [p0, p1, p2] = sb.videos.map((v) => v.path);
    const title2 = before.scenes[before.links[p2].sceneId].title;
    // Video 1: a link you chose by hand to its scene.
    await sb.library.applySync((d) => { d.links[p1] = { ...d.links[p1], by: 'manual' }; return {}; });
    // Stash reinstalled at the same address: ids 1-3 are other files now.
    const fresh = scenesFor(sb.videos).map((s, i) => ({
      ...s, title: `UNRELATED SCENE ${i + 1}`, updated_at: '2026-11-19T08:00:00Z',
      files: [{ ...s.files[0], path: `/data/new/other-${i + 1}.mp4`, oshash: `aaaaaaaaaaaaaa0${i + 1}` }],
    }));
    sb.stash.set({ scenes: fresh });
    expect(await sb.call('stash-sync', { videos: list })).toMatchObject({ ok: true, complete: true });
    let data = await sb.call('stash-get-data');
    for (const p of [p0, p1, p2]) {
      expect(data.links[p]).toMatchObject({ state: 'changed', sceneChanged: true });
      // the old record is kept, not overwritten by the unrelated scene
      expect(data.scenes[data.links[p].sceneId].title).toBe(before.scenes[before.links[p].sceneId].title);
    }
    expect(data.links[p1].by).toBe('manual');
    expect(data.scenes[data.links[p2].sceneId].title).toBe(title2);

    // Sync this video on a link that was still ok: the same check.
    await sb.library.applySync((d) => { d.links[p2] = { ...d.links[p2], state: 'ok' }; delete d.links[p2].sceneChanged; return {}; });
    const one = await sb.call('stash-sync-video', { path: p2, size: sb.videos[2].size, mtimeMs: sb.videos[2].mtimeMs });
    expect(one).toMatchObject({ ok: true });
    data = await sb.call('stash-get-data');
    expect(data.links[p2]).toMatchObject({ state: 'changed', sceneChanged: true });
    expect(data.scenes[data.links[p2].sceneId].title).toBe(title2);
  });
});
