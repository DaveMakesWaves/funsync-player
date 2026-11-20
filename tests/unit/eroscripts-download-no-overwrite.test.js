/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Round 2 (2026-11-05), also in v0.9.2: with a video open, an EroScripts
// download is named <video>.funscript beside the video, and downloadFile
// wrote it with fs.writeFileSync without looking: the user's own script
// there was replaced with no question and no way back.
//
// The REAL EroScriptsAPI.downloadFile runs against a real scratch folder
// (os.tmpdir(), never the user's data). Only fetch and the Recycle Bin are
// stand-ins: the bin moves the file into a scratch "bin" folder, as
// shell.trashItem moves it out of the way.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Same logger instance the module holds; vi.mock cannot reach a CJS require
// (see eroscripts-auth-expiry.test.js). Off, so nothing lands in a real log.
const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI } = await import('../../electron/eroscripts-api.js');

const DOWNLOAD = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });
const MINE = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 250, pos: 90 }, { at: 750, pos: 20 }] });

let dir;
let bin;
let target;
let trashItem;
const realFetch = globalThis.fetch;
let prevFile;
let prevConsole;

beforeAll(() => {
  prevFile = log.transports.file.level;
  prevConsole = log.transports.console.level;
  log.transports.file.level = false;
  log.transports.console.level = false;
});

afterAll(() => {
  log.transports.file.level = prevFile;
  log.transports.console.level = prevConsole;
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-es-download-'));
  bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  target = path.join(dir, 'Alpha Scene.funscript');
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(DOWNLOAD).buffer,
  }));
  trashItem = vi.fn(async (p) => fs.renameSync(p, path.join(bin, path.basename(p))));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

const download = (opts) => new EroScriptsAPI().downloadFile('https://example.invalid/a.funscript', target, opts);
const inBin = () => fs.readdirSync(bin).map((n) => fs.readFileSync(path.join(bin, n), 'utf8'));

describe('an EroScripts download never silently replaces an existing script (round 2)', () => {
  it('nothing there: the download is written', async () => {
    await expect(download({ trashItem })).resolves.toEqual({ success: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(DOWNLOAD);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('a different file there: NOTHING is written, and the caller is told it exists', async () => {
    fs.writeFileSync(target, MINE);
    await expect(download({ trashItem })).resolves.toEqual({ success: false, exists: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(MINE);
    expect(trashItem).not.toHaveBeenCalled();
    expect(inBin()).toEqual([]);
  });

  it('Replace: the old file goes to the Recycle Bin first, then the download is written', async () => {
    fs.writeFileSync(target, MINE);
    await expect(download({ replace: true, trashItem })).resolves.toEqual({ success: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(DOWNLOAD);
    expect(inBin()).toEqual([MINE]); // recoverable
  });

  it('Replace, but the move to the Recycle Bin fails: nothing is written', async () => {
    fs.writeFileSync(target, MINE);
    trashItem.mockRejectedValueOnce(new Error('locked'));
    const res = await download({ replace: true, trashItem });
    expect(res.success).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(MINE);
  });

  it('Replace with no Recycle Bin to hand: nothing is written', async () => {
    fs.writeFileSync(target, MINE);
    const res = await download({ replace: true });
    expect(res.success).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(MINE);
  });

  it('the same bytes already there: nothing to ask, nothing moved, the file is left as it is', async () => {
    fs.writeFileSync(target, DOWNLOAD);
    const before = fs.statSync(target).mtimeMs;
    await expect(download({ trashItem })).resolves.toEqual({ success: true, unchanged: true });
    expect(trashItem).not.toHaveBeenCalled();
    expect(fs.statSync(target).mtimeMs).toBe(before);
  });

  it('an empty existing file still counts as a file that is there', async () => {
    fs.writeFileSync(target, '');
    await expect(download({ trashItem })).resolves.toEqual({ success: false, exists: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('');
  });

  it('a failed download writes nothing and moves nothing', async () => {
    fs.writeFileSync(target, MINE);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    const res = await download({ replace: true, trashItem });
    expect(res.success).toBe(false);
    expect(trashItem).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toBe(MINE);
  });
});
