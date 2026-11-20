/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Locate (Dave, 2026-11-18): "Script not found" opens the file explorer "to
// where the path says it should be". main's `select-funscript` takes
// `{ defaultPath }` (the stored path of the script that is not found) and the
// picker opens in its folder, or the nearest parent folder that exists
// (electron/dialog-default-path.js). It only reads: no folder is created.
// The value comes over IPC from the renderer, so anything but a plain
// absolute path string is ignored and the picker opens as it always did.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { liftMainHandler } from './helpers/main-handlers.js';

const requireElectron = createRequire(path.resolve('electron/main.js'));
const dialogDefaultPath = requireElectron('./dialog-default-path');
const { nearestExistingFolder, isPlainAbsolutePath } = dialogDefaultPath;

describe('nearestExistingFolder (pure, a fake folder check)', () => {
  const W = path.win32;
  const folders = (...present) => vi.fn(async (dir) => present.includes(dir));

  it('the script\'s own folder when it is there', async () => {
    const isFolder = folders('E:\\Scripts\\Pack');
    await expect(nearestExistingFolder('E:\\Scripts\\Pack\\gone.funscript', { isFolder, pathApi: W })).resolves.toBe('E:\\Scripts\\Pack');
  });

  it('the nearest parent that is there when the folder is gone too; null when none is', async () => {
    await expect(nearestExistingFolder('E:\\Scripts\\Pack\\Sub\\gone.funscript', { isFolder: folders('E:\\Scripts'), pathApi: W }))
      .resolves.toBe('E:\\Scripts');
    await expect(nearestExistingFolder('E:\\Scripts\\Pack\\gone.funscript', { isFolder: folders(), pathApi: W })).resolves.toBeNull();
  });

  it('refuses anything but a plain absolute path string (it comes over IPC)', async () => {
    const isFolder = vi.fn(async () => true);
    for (const bad of [undefined, null, 42, {}, ['E:\\x.funscript'], '', 'relative\\x.funscript', 'E:\\a\0b.funscript', `E:\\${'x'.repeat(5000)}`]) {
      await expect(nearestExistingFolder(bad, { isFolder, pathApi: W })).resolves.toBeNull();
      expect(isPlainAbsolutePath(bad, W)).toBe(false);
    }
    expect(isFolder).not.toHaveBeenCalled();
  });

  it('gives up when the walk runs out of time (a dead share), rather than hold the picker', async () => {
    let clock = 0;
    const isFolder = vi.fn(async () => { clock += 1000; return false; });
    await expect(nearestExistingFolder('\\\\nas\\share\\a\\b\\c\\gone.funscript', { isFolder, pathApi: W, now: () => clock }))
      .resolves.toBeNull();
    expect(isFolder.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('nearestExistingFolder on real folders: it reads, it never creates', () => {
  let root = null;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

  it('a script whose folder was removed: its parent, and no folder is made', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-locate-'));
    fs.mkdirSync(path.join(root, 'Scripts'));
    const listing = () => fs.readdirSync(root, { recursive: true }).sort();
    const before = listing();
    await expect(nearestExistingFolder(path.join(root, 'Scripts', 'Pack', 'gone.funscript'))).resolves.toBe(path.join(root, 'Scripts'));
    expect(listing()).toEqual(before);
  });
});

describe('main: select-funscript with { defaultPath }', () => {
  function handlerAnswering(filePaths, { found = 'E:\\Scripts' } = {}) {
    const calls = [];
    const dialog = {
      showOpenDialog: vi.fn(async (_win, opts) => { calls.push(opts); return { canceled: !filePaths.length, filePaths }; }),
    };
    // Windows rules for these Windows-style paths, on every platform: with
    // the host's own rules `E:\...` is not absolute on Linux, so the fake
    // found nothing there and CI's ubuntu job failed (v0.10.0 tag, 2026-11-20).
    const nearest = vi.fn(async (p) => (isPlainAbsolutePath(p, path.win32) ? found : null));
    const fakeRequire = (m) => (m === './dialog-default-path' ? { ...dialogDefaultPath, nearestExistingFolder: nearest } : requireElectron(m));
    return { handler: liftMainHandler('select-funscript', { dialog, mainWindow: {}, path: path.win32, require: fakeRequire }), calls, nearest };
  }

  it('opens at the nearest existing folder of the stored path, funscripts only, one file', async () => {
    const { handler, calls, nearest } = handlerAnswering(['E:\\Scripts\\moved.funscript']);
    await expect(handler({}, { defaultPath: 'E:\\Scripts\\Pack\\gone.funscript' }))
      .resolves.toEqual({ name: 'moved.funscript', path: 'E:\\Scripts\\moved.funscript' });
    expect(nearest).toHaveBeenCalledWith('E:\\Scripts\\Pack\\gone.funscript');
    expect(calls[0]).toMatchObject({ defaultPath: 'E:\\Scripts', properties: ['openFile'], filters: [{ name: 'Funscript Files', extensions: ['funscript'] }] });
  });

  it('a defaultPath that is not a plain path, or no folder found: the picker opens as it always did', async () => {
    const { handler, calls } = handlerAnswering([], { found: null });
    await expect(handler({}, { defaultPath: { evil: true } })).resolves.toBeNull();
    await expect(handler({}, { defaultPath: 'E:\\none\\gone.funscript' })).resolves.toBeNull();
    for (const c of calls) expect(c).not.toHaveProperty('defaultPath');
  });

  it('no options: unchanged (no defaultPath asked for, none passed)', async () => {
    const { handler, calls, nearest } = handlerAnswering(['C:\\S\\A.funscript']);
    await expect(handler({}, undefined)).resolves.toEqual({ name: 'A.funscript', path: 'C:\\S\\A.funscript' });
    expect(nearest).not.toHaveBeenCalled();
    expect(calls[0]).not.toHaveProperty('defaultPath');
  });
});
