/**
 * @vitest-environment node
 * Node: real files in a temp folder (electron/converted-copies.js is main
 * process code). See notes/CLAUDE.md "Test environments".
 */
// Convert to play's copies live in <userData>/converted (Dave, 2026-11-26:
// "yes move them to the data folder"); Settings > Data shows how many and how
// big, and Clear converted copies deletes them. Only the backend's own files
// are counted or touched; a copy the player has open is kept.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../../electron/converted-copies.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-converted-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
const put = (name, bytes) => fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));

describe('converted copies', () => {
  it('lives under the data folder', () => {
    expect(mod.convertedDir('C:\\Users\\u\\AppData\\Roaming\\funsync-player')).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\funsync-player', 'converted'));
  });

  it('counts the finished copies and their size; a part file or anything else is not a copy', async () => {
    put('0123456789ab.h264.mp4', 1000);
    put('ba9876543210.h264.mp4', 500);
    put('0123456789ab.h264.part.mp4', 300);
    put('notes.txt', 50);
    put('movie.mp4', 70);
    expect(await mod.convertedInfo(dir)).toEqual({ count: 2, bytes: 1500 });
  });

  it('no folder yet: none', async () => {
    expect(await mod.convertedInfo(path.join(dir, 'missing'))).toEqual({ count: 0, bytes: 0 });
    expect(await mod.clearConverted(path.join(dir, 'missing'))).toEqual({ removed: 0, bytes: 0, kept: 0 });
  });

  it('Clear deletes the finished copies, never anything else; a part file (a conversion writing) is left alone', async () => {
    put('0123456789ab.h264.mp4', 1000);
    put('0123456789ab.h264.part.mp4', 300);
    put('notes.txt', 50);
    put('movie.mp4', 70);
    expect(await mod.clearConverted(dir)).toEqual({ removed: 1, bytes: 1000, kept: 0 });
    // On Linux / macOS deleting a part file mid-conversion succeeds and that
    // conversion then fails at its end; the backend clears leftovers at start.
    expect(fs.readdirSync(dir).sort()).toEqual(['0123456789ab.h264.part.mp4', 'movie.mp4', 'notes.txt']);
  });

  it('Delete video files takes the converted copies of the videos that went, nothing else', async () => {
    put('0123456789ab.h264.mp4', 1000); // A.wmv's copy
    put('ba9876543210.h264.mp4', 500);  // B.wmv's copy: its delete failed
    put('notes.txt', 5);
    const copies = new Map([
      ['C:/Lib/A.wmv', path.join(dir, '0123456789ab.h264.mp4')],
      ['C:/Lib/B.wmv', path.join(dir, 'ba9876543210.h264.mp4')],
      ['C:/Lib/C.wmv', path.join(os.tmpdir(), 'elsewhere', '0123456789ab.h264.mp4')], // not in the folder: never
      ['C:/Lib/D.wmv', path.join(dir, 'notes.txt')],                                 // not a copy's name: never
    ]);
    const results = [
      { path: 'C:/Lib/A.wmv', ok: true },
      { path: 'C:/Lib/B.wmv', ok: false },
      { path: 'C:/Lib/C.wmv', ok: true },
      { path: 'C:/Lib/D.wmv', ok: true },
    ];
    const removed = await mod.removeCopiesOf(results, copies, dir);
    expect(removed).toEqual([path.join(dir, '0123456789ab.h264.mp4')]);
    expect(fs.readdirSync(dir).sort()).toEqual(['ba9876543210.h264.mp4', 'notes.txt']);
  });

  it('a copy the player has open (unlink refused) is kept and counted', async () => {
    put('0123456789ab.h264.mp4', 1000);
    put('ba9876543210.h264.mp4', 500);
    const real = fs.promises.unlink;
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p) => {
      if (String(p).endsWith('0123456789ab.h264.mp4')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return real(p);
    });
    expect(await mod.clearConverted(dir)).toEqual({ removed: 1, bytes: 500, kept: 1 });
    expect(fs.existsSync(path.join(dir, '0123456789ab.h264.mp4'))).toBe(true);
  });
});
