/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash data in backups (Stash S1, notes/features/DESIGN-stash-s1.md (c)
// "Backups and import merge", (g) "Import merge"): the export carries
// stash/library.json and nothing else of userData/stash; the import merges
// it through main's library instance; `settings.stash` has its own merge
// rule; the API key is never exported or imported. Every guard here was
// checked by reopening its hole (the stage's holes.jsonl lists them).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const JSZip = require_('jszip');
const dataExport = require_('../../electron/data-export.js');
const { createStashLibraryFile, emptyData } = require_('../../electron/stash-library-file.js');

const SERVER = 'http://127.0.0.1:9999';
const KEY = 'sample-stash-key-3f2a9c';
const H1 = '0123456789abcdef';
const A = 'C:\\lib\\a.mp4';
const B = 'C:\\lib\\b.mp4';
const quiet = { warn() {}, info() {} };

let tmp;
let stashDir;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-stash-backup-'));
  stashDir = path.join(tmp, 'stash');
  await fsp.mkdir(stashDir);
});
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function library() {
  const d = emptyData();
  d.rev = 4;
  d.server = { url: SERVER, version: 'v0.32.0' };
  d.links[A] = { sceneId: '1', server: SERVER, by: 'manual', fp: { size: 1, mtimeMs: 1, oshash: H1 }, linkedAt: 1000, state: 'ok' };
  d.scenes['1'] = { id: '1', title: 'Synthetic Scene Small', fetchedAt: 1000 };
  return d;
}

function config(stash) {
  return { settings: { player: { volume: 50 }, ...(stash !== undefined ? { stash } : {}) }, playlists: [], categories: [], videoCategories: {} };
}

async function zipWith(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const p = path.join(tmp, `backup-${Math.random().toString(36).slice(2)}.zip`);
  await fsp.writeFile(p, await zip.generateAsync({ type: 'nodebuffer' }));
  return p;
}

describe('export', () => {
  it('adds stash/library.json, and never key.json or fingerprints.json', async () => {
    await fsp.writeFile(path.join(stashDir, 'library.json'), JSON.stringify(library()));
    await fsp.writeFile(path.join(stashDir, 'key.json'), JSON.stringify({ v: 1, storage: 'safeStorage', value: KEY }));
    await fsp.writeFile(path.join(stashDir, 'fingerprints.json'), JSON.stringify({ [A]: { size: 1, mtimeMs: 1, oshash: H1 } }));
    const out = path.join(tmp, 'out.zip');
    const res = await dataExport.exportData(config({ enabled: true, url: SERVER, syncOnStart: false, pathRules: [] }), out, { stashDir });
    expect(res.success).toBe(true);
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual(['config.json', 'metadata.json', 'stash/library.json']);
    expect(JSON.parse(await zip.file('stash/library.json').async('string'))).toEqual(library());
    const all = (await Promise.all(names.map((n) => zip.file(n).async('string')))).join('\n');
    expect(all).not.toContain(KEY);
  });

  it('no Stash file, a damaged one, or no folder: no stash entry and the export still works', async () => {
    for (const setup of [async () => {}, async () => fsp.writeFile(path.join(stashDir, 'library.json'), '{broken')]) {
      await setup();
      const out = path.join(tmp, `out-${Math.random()}.zip`);
      expect((await dataExport.exportData(config(), out, { stashDir })).success).toBe(true);
      const zip = await JSZip.loadAsync(fs.readFileSync(out));
      expect(Object.keys(zip.files).some((n) => n.startsWith('stash'))).toBe(false);
    }
    const out = path.join(tmp, 'none.zip');
    expect((await dataExport.exportData(config(), out)).success).toBe(true);
  });
});

describe('import', () => {
  it('reads stash/library.json only; a stash/key.json in a backup is never read', async () => {
    const zipPath = await zipWith({
      'config.json': JSON.stringify(config()),
      'stash/library.json': JSON.stringify(library()),
      'stash/key.json': JSON.stringify({ v: 1, storage: 'plain', value: KEY }),
    });
    const res = await dataExport.importData(zipPath, 'merge');
    expect(res.success).toBe(true);
    expect(res.stashLibrary).toEqual(library());
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('a backup with no Stash file, or a damaged one, gives none', async () => {
    const none = await dataExport.importData(await zipWith({ 'config.json': JSON.stringify(config()) }), 'merge');
    expect(none.stashLibrary).toBeNull();
    const broken = await dataExport.importData(await zipWith({ 'config.json': JSON.stringify(config()), 'stash/library.json': '{nope' }), 'merge');
    expect(broken.success).toBe(true);
    expect(broken.stashLibrary).toBeNull();
  });
});

describe('settings.stash in a merge import', () => {
  const local = { enabled: true, url: SERVER, syncOnStart: false, pathRules: [{ local: 'C:\\lib', stash: '/data' }] };

  it('this machine\'s enabled stays; url and pathRules fill only an empty local value', () => {
    const merged = dataExport.mergeConfig(
      config(local),
      config({ enabled: false, url: 'http://192.168.1.20:9999', syncOnStart: true, pathRules: [{ local: 'X:\\', stash: '/x' }] }),
      'merge',
    );
    expect(merged.settings.stash).toEqual({ enabled: true, url: SERVER, syncOnStart: true, pathRules: local.pathRules });

    const fresh = { enabled: false, url: '', syncOnStart: false, pathRules: [] };
    const filled = dataExport.mergeConfig(config(fresh), config({ enabled: true, url: SERVER, pathRules: local.pathRules }), 'merge');
    expect(filled.settings.stash).toEqual({ enabled: false, url: SERVER, syncOnStart: false, pathRules: local.pathRules });
  });

  it('the key is never imported: a backup that carries one under stash brings nothing but the four fields', () => {
    const merged = dataExport.mergeConfig(
      config({ enabled: false, url: '', syncOnStart: false, pathRules: [] }),
      config({ url: SERVER, apiKey: KEY, key: KEY, extra: { value: KEY } }),
      'merge',
    );
    expect(JSON.stringify(merged)).not.toContain(KEY);
    expect(Object.keys(merged.settings.stash).sort()).toEqual(['enabled', 'pathRules', 'syncOnStart', 'url']);
    const over = dataExport.mergeConfig(config(local), config({ url: SERVER, apiKey: KEY, extra: { value: KEY } }), 'overwrite');
    expect(JSON.stringify(over)).not.toContain(KEY);
  });

  it('a backup without a stash block leaves this machine\'s as it is (merge and overwrite)', () => {
    expect(dataExport.mergeConfig(config(local), config(), 'merge').settings.stash).toEqual(local);
    expect(dataExport.mergeConfig(config(local), config(), 'overwrite').settings.stash).toEqual(local);
    const over = dataExport.mergeConfig(config(local), config({ url: 'http://x', apiKey: KEY }), 'overwrite');
    expect(over.settings.stash).toEqual({ url: 'http://x' });
  });
});

describe('Import Backup File (applyImport) with Stash data', () => {
  function fakeStore(cfg) {
    let current = JSON.parse(JSON.stringify(cfg));
    return { getAll: () => JSON.parse(JSON.stringify(current)), replaceData: (m) => { current = { ...current, ...m }; }, get: () => current };
  }

  it('merges the backup\'s Stash file through main\'s instance: your manual link stays, a new one comes in', async () => {
    await fsp.writeFile(path.join(stashDir, 'library.json'), JSON.stringify(library()));
    const lib = createStashLibraryFile({ dir: stashDir, now: () => 5000, log: quiet });
    await lib.load();
    const incoming = emptyData();
    incoming.links[A] = { sceneId: '9', by: 'oshash', linkedAt: 9000, state: 'ok' };
    incoming.links[B] = { sceneId: '2', by: 'oshash', linkedAt: 9000, state: 'ok' };
    incoming.scenes['2'] = { id: '2', title: 'Two', fetchedAt: 9000 };
    const zipPath = await zipWith({ 'config.json': JSON.stringify(config()), 'stash/library.json': JSON.stringify(incoming) });
    const relaunch = vi.fn();
    const res = await dataExport.applyImport({ filePath: zipPath, store: fakeStore(config()), stashLibrary: lib, relaunch });
    expect(res).toMatchObject({ success: true, stash: { merged: true } });
    expect(relaunch).toHaveBeenCalledTimes(1);
    const d = JSON.parse(fs.readFileSync(path.join(stashDir, 'library.json'), 'utf8'));
    expect(d.links[A]).toEqual(library().links[A]);
    expect(d.links[B].sceneId).toBe('2');
    expect(d.scenes['2'].title).toBe('Two');
  });

  it('a backup with no Stash file leaves the local one untouched', async () => {
    await fsp.writeFile(path.join(stashDir, 'library.json'), JSON.stringify(library()));
    const before = sha(path.join(stashDir, 'library.json'));
    const lib = createStashLibraryFile({ dir: stashDir, log: quiet });
    await lib.load();
    const spy = vi.spyOn(lib, 'mergeImported');
    const zipPath = await zipWith({ 'config.json': JSON.stringify(config()) });
    const res = await dataExport.applyImport({ filePath: zipPath, store: fakeStore(config()), stashLibrary: lib, relaunch: () => {} });
    expect(res.success).toBe(true);
    expect(res.stash).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(sha(path.join(stashDir, 'library.json'))).toBe(before);
  });

  it('a Stash merge that fails does not stop the import, and the local file stays as it was', async () => {
    await fsp.writeFile(path.join(stashDir, 'library.json'), JSON.stringify(library()));
    const before = sha(path.join(stashDir, 'library.json'));
    const lib = { mergeImported: async () => { throw new Error('disk full'); } };
    const zipPath = await zipWith({ 'config.json': JSON.stringify(config({ url: SERVER })), 'stash/library.json': JSON.stringify(emptyData()) });
    const store = fakeStore(config());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await dataExport.applyImport({ filePath: zipPath, store, stashLibrary: lib, relaunch: () => {} });
    warn.mockRestore();
    expect(res).toMatchObject({ success: true, stash: { merged: false } });
    expect(store.get().settings.stash.url).toBe(SERVER);
    expect(sha(path.join(stashDir, 'library.json'))).toBe(before);
  });
});
