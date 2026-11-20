/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The 60-second "Auto-save" snapshot must fire after ordinary edits (V05).
//
// main.js arms dataBackup.scheduleSnapshot from store.subscribe(). That
// used to be electron-conf's onDidAnyChange, which never fired for a nested
// setting or for the store helpers that edit an array from conf.get() in
// place: electron-conf 1.3.0 hands out a SHALLOW clone, the write mutates
// the object the listener cached as "old", and deep-equal finds no change.
// So the auto-save never ran for a settings tweak, a category assignment or
// a new playlist, in v0.9.2 and earlier.
//
// These run against the REAL electron-conf (tests/unit/helpers/
// real-electron-conf.js). store.test.js's MockConf deep-clones, which is
// how this hid behind a green suite.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});

const store = await import('../../electron/store.js');
const require_ = createRequire(import.meta.url);
const dataBackup = require_('../../electron/data-backup.js');

function newUserData() {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-autosave-'));
}

function listSnapshots(trigger) {
  const dir = path.join(h.userData, 'backups', 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((s) => !trigger || s.metadata.trigger === trigger);
}

describe('store.subscribe hears every kind of write (real electron-conf)', () => {
  let calls;
  let seedList;
  let unsubscribe;

  beforeEach(async () => {
    newUserData();
    await store.initStore();
    // Seed so the helpers below have something to mutate in place.
    const list = store.addPlaylist('Seed');
    store.addCategory('Seed Cat', '#123456');
    seedList = list.id;
    calls = 0;
    unsubscribe = store.subscribe(() => { calls += 1; });
  });

  afterEach(() => {
    unsubscribe();
    try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const cases = [
    ['a nested setting (setSetting player.volume)', () => store.setSetting('player.volume', 42)],
    ['a nested map (library.associations)', () => store.setSetting('library.associations', { '/v.mp4': { single: '/v.funscript' } })],
    ['a new playlist (push into the live array)', () => store.addPlaylist('Another')],
    ['adding a video to a playlist', () => store.addVideoToPlaylist(seedList, '/v.mp4')],
    ['a new category', () => store.addCategory('Another Cat', '#654321')],
    ['a category assignment', () => store.assignCategory('/v.mp4', store.getCategories()[0].id)],
    ['a recent file', () => store.addRecentFile('/v.mp4')],
  ];

  for (const [name, write] of cases) {
    it(`fires for ${name}`, () => {
      write();
      expect(calls).toBeGreaterThanOrEqual(1);
    });
  }

  it('stops firing after unsubscribe', () => {
    unsubscribe();
    store.setSetting('player.volume', 7);
    expect(calls).toBe(0);
  });
});

describe('the auto-save snapshot, wired exactly as main.js wires it', () => {
  let unsubscribe;

  beforeEach(async () => {
    newUserData();
    await store.initStore();
    // Only the timer functions are faked. Snapshot file names come from
    // the real clock, and the snapshot write is real disk I/O.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    unsubscribe = store.subscribe(() => {
      dataBackup.scheduleSnapshot({
        userDataDir: h.userData,
        getConfig: () => store.getAll(),
      });
    });
  });

  afterEach(() => {
    unsubscribe();
    dataBackup.cancelScheduled();
    vi.useRealTimers();
    try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('takes a debounced snapshot 60 s after a nested settings edit, holding the edit', async () => {
    store.setSetting('player.volume', 42);

    await vi.advanceTimersByTimeAsync(dataBackup.DEBOUNCE_MS - 1000);
    expect(listSnapshots('debounced')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(listSnapshots('debounced')).toHaveLength(1), { timeout: 5000 });
    expect(listSnapshots('debounced')[0].config.settings.player.volume).toBe(42);
  });

  it('takes one after a category assignment too', async () => {
    const cat = store.addCategory('E Cat', '#3498db');
    store.assignCategory('D:\\lib\\Alpha Scene.mp4', cat.id);

    await vi.advanceTimersByTimeAsync(dataBackup.DEBOUNCE_MS + 500);
    await vi.waitFor(() => expect(listSnapshots('debounced')).toHaveLength(1), { timeout: 5000 });
    expect(listSnapshots('debounced')[0].config.videoCategories).toEqual({ 'D:\\lib\\Alpha Scene.mp4': [cat.id] });
  });

  it('still takes one while writes never pause: a resume position every 15 s during playback', async () => {
    // Every write resets the 60 s debounce, and playback saves the resume
    // position every 15 s. Without a cap, an edit made from the player was
    // not snapshotted until playback had been stopped for a minute.
    const VIDEO = 'D:\\lib\\Alpha Scene.mp4';
    const cat = store.addCategory('Played Cat', '#3498db');
    store.assignCategory(VIDEO, cat.id);

    for (let elapsed = 15_000; elapsed <= 6 * 60_000; elapsed += 15_000) {
      await vi.advanceTimersByTimeAsync(15_000);
      store.setSetting('library.resumePositions', {
        [VIDEO]: { position: elapsed / 1000, duration: 900, updatedAt: elapsed },
      });
      // The debounce alone never fires: there is never a 60 s gap.
      if (elapsed < dataBackup.DEBOUNCE_MAX_WAIT_MS) expect(listSnapshots('debounced')).toHaveLength(0);
    }

    await vi.waitFor(() => expect(listSnapshots('debounced')).toHaveLength(1), { timeout: 5000 });
    expect(listSnapshots('debounced')[0].config.videoCategories).toEqual({ [VIDEO]: [cat.id] });
  });
});

describe('a debounced snapshot that would change nothing is skipped', () => {
  let dir;
  const config = () => ({
    settings: { player: { volume: 50 }, library: { associations: { '/a.mp4': { single: '/a.funscript' } } } },
    playlists: [], categories: [], videoCategories: {},
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-dedupe-'));
    h.userData = dir;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    dataBackup.cancelScheduled();
    vi.useRealTimers();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('skips when only a blacklisted cache changed, snapshots when real data changed', async () => {
    await dataBackup.takeSnapshot({ userDataDir: dir, config: config(), trigger: dataBackup.TRIGGER.STARTUP });

    const cacheOnly = config();
    cacheOnly.settings.library.thumbnailCache = { '/a.mp4': 'data:image/jpeg;base64,xyz' };
    cacheOnly.settings.library.durationCache = { '/a.mp4': 12 };
    dataBackup.scheduleSnapshot({ userDataDir: dir, getConfig: () => cacheOnly });
    await vi.advanceTimersByTimeAsync(dataBackup.DEBOUNCE_MS + 10);
    await new Promise((r) => setImmediate(r));
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 300));
    expect(listSnapshots('debounced')).toHaveLength(0);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const realEdit = config();
    realEdit.playlists = [{ id: 'p1', name: 'New', videoPaths: [] }];
    dataBackup.scheduleSnapshot({ userDataDir: dir, getConfig: () => realEdit });
    await vi.advanceTimersByTimeAsync(dataBackup.DEBOUNCE_MS + 10);
    await vi.waitFor(() => expect(listSnapshots('debounced')).toHaveLength(1), { timeout: 5000 });
  });
});
