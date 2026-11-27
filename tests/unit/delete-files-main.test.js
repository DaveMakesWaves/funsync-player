/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Main's half of deleting a video's files (2026-11-23, EroScripts #434;
// DESIGN.md §2.18): electron/delete-files.js, on a real temporary folder.
// listVideoFiles finds a video's files by name; deleteFiles holds every
// guard: a regular file, a video / script / subtitle extension, inside a
// library folder, the Recycle Bin unless permanent was confirmed, never the
// Recycle Bin on a network path (Windows would delete it for good).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listVideoFiles, deleteFiles, REASONS, isInside } = require('../../electron/delete-files.js');

let root;
const write = (rel, bytes = 10) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
};
const quiet = { info() {}, warn() {} };

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-delete-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('listVideoFiles: what belongs to a video by name', () => {
  it('the video, its script, axis files, variations and subtitles; nothing else', async () => {
    const video = write('lib/Clip One.mp4', 100);
    write('lib/Clip One.funscript', 20);
    write('lib/Clip One.twist.funscript', 5);
    write('lib/Clip One.soft.funscript', 6);
    write('lib/Clip One.srt', 3);
    write('lib/Clip One.en.srt', 3);
    write('lib/Clip One.nfo', 1);              // not ours to delete
    write('lib/Clip One Extended.mp4', 50);    // another video, same prefix
    write('lib/Clip One Extended.funscript', 5);
    const files = await listVideoFiles(video);
    expect(files.map((f) => [path.basename(f.path), f.kind, f.label])).toEqual([
      ['Clip One.mp4', 'video', null],
      ['Clip One.funscript', 'script', null],
      ['Clip One.twist.funscript', 'axis', 'twist'],
      ['Clip One.soft.funscript', 'variant', 'soft'],
      ['Clip One.en.srt', 'subtitle', 'en'],
      ['Clip One.srt', 'subtitle', null],
    ]);
    expect(files[0].size).toBe(100);
  });
});

describe('deleteFiles: the guards', () => {
  it('permanent: the file is gone; the Recycle Bin path is used otherwise', async () => {
    const a = write('lib/A.mp4');
    const b = write('lib/B.funscript');
    const trashItem = vi.fn(async () => {});
    const perm = await deleteFiles([a], { permanent: true, roots: [path.join(root, 'lib')], trashItem, log: quiet });
    expect(perm).toEqual([{ path: a, ok: true, size: 10 }]);
    expect(fs.existsSync(a)).toBe(false);
    expect(trashItem).not.toHaveBeenCalled();
    const bin = await deleteFiles([b], { permanent: false, roots: [path.join(root, 'lib')], trashItem, log: quiet });
    expect(bin[0].ok).toBe(true);
    expect(trashItem).toHaveBeenCalledWith(b);
  });

  it('refuses a file outside the library folders, and anything that is not a video, script or subtitle', async () => {
    const outside = write('elsewhere/C.mp4');
    const notes = write('lib/notes.txt');
    const res = await deleteFiles([outside, notes], { permanent: true, roots: [path.join(root, 'lib')], trashItem: vi.fn(), log: quiet });
    expect(res.map((r) => r.reason)).toEqual([REASONS.OUTSIDE, REASONS.WRONG_TYPE]);
    expect(fs.existsSync(outside) && fs.existsSync(notes)).toBe(true);
  });

  it('refuses a folder (even one named like a video), and the library folder itself', async () => {
    fs.mkdirSync(path.join(root, 'lib', 'Folder.mp4'), { recursive: true });
    const res = await deleteFiles([path.join(root, 'lib', 'Folder.mp4'), path.join(root, 'lib')], { permanent: true, roots: [path.join(root, 'lib')], trashItem: vi.fn(), log: quiet });
    expect(res.map((r) => r.reason)).toEqual([REASONS.NOT_FILE, REASONS.WRONG_TYPE]);
    expect(fs.existsSync(path.join(root, 'lib', 'Folder.mp4'))).toBe(true);
  });

  it('"Recycle Bin" on a network path is refused, never a silent permanent delete', async () => {
    const res = await deleteFiles(['\\\\nas\\share\\lib\\D.mp4'], {
      permanent: false, roots: ['\\\\nas\\share\\lib'], platform: 'win32', trashItem: vi.fn(), log: quiet,
      fs: { promises: { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }) } },
    });
    expect(res[0]).toMatchObject({ ok: false, reason: REASONS.NO_BIN });
  });

  it('one file that cannot go never stops the rest; a busy file says it is in use', async () => {
    const a = write('lib/A.mp4');
    const b = write('lib/B.mp4');
    const trashItem = vi.fn(async (p) => { if (p === a) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } });
    const res = await deleteFiles([a, b], { roots: [path.join(root, 'lib')], trashItem, log: quiet });
    expect(res).toEqual([
      expect.objectContaining({ path: a, ok: false, reason: REASONS.IN_USE }),
      expect.objectContaining({ path: b, ok: true }),
    ]);
  });

  it('a file already gone says so', async () => {
    const res = await deleteFiles([path.join(root, 'lib', 'Gone.mp4')], { permanent: true, roots: [path.join(root, 'lib')], trashItem: vi.fn(), log: quiet });
    expect(res[0].reason).toBe(REASONS.GONE);
  });

  it('inside: case-insensitive on Windows, never a sibling folder with the same prefix, never ..', () => {
    expect(isInside('C:\\Lib', 'c:\\lib\\sub\\a.mp4', 'win32')).toBe(true);
    expect(isInside('C:\\Lib', 'C:\\Library2\\a.mp4', 'win32')).toBe(false);
    expect(isInside('C:\\Lib', 'C:\\Lib\\..\\Windows\\a.mp4', 'win32')).toBe(false);
    expect(isInside('C:\\Lib', 'C:\\Lib', 'win32')).toBe(false);
  });
});

describe('the IPC takes its roots from the stored sources, never from the renderer', () => {
  it('main.js reads library.sources and passes them as roots', () => {
    const main = fs.readFileSync('electron/main.js', 'utf8').replace(/\r\n/g, '\n');
    expect(main).toContain("const sources = store.getSetting('library.sources');");
    expect(main).toMatch(/ipcMain\.handle\('delete-video-files', async \(_event, paths, opts\) => \{[\s\S]*?roots: libraryRoots\(\),/);
    expect(main).toMatch(/permanent: opts\?\.permanent === true,/);
  });
});
