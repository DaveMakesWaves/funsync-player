/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R3-04 (hardening): the eroscripts-download IPC validated nothing, so a
// renderer could have main fetch ANY url, with the EroScripts session cookie
// (sent to whatever URL was passed), and write the bytes to ANY path; the
// same-bytes check read the whole existing file into main with no cap; and
// the attachment name (the post's link text) was joined into the save path
// as it was.
//
// What runs for real: main.js's eroscripts-download handler (lifted), the
// EroScriptsAPI, safeAttachmentName, a real scratch folder in os.tmpdir().
// Stand-ins: fetch (records what each request carried) and shell.trashItem.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liftMainHandler } from './helpers/main-handlers.js';
import { safeAttachmentName } from '../../renderer/js/safe-file-name.js';

const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI, isEroScriptsUrl, normalizeSavePath } = await import('../../electron/eroscripts-api.js');

const DOWNLOAD = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });
const MINE = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 250, pos: 90 }, { at: 750, pos: 20 }] });
const ON_FORUM = 'https://discuss.eroscripts.com/uploads/short-url/abc.funscript';
const ON_CDN = 'https://eroscripts-discourse.eroscripts.com/original/3X/abc.funscript';

let dir;
let api;
let download;
let requests;
let prevFile;
let prevConsole;
const realFetch = globalThis.fetch;

beforeAll(() => {
  prevFile = log.transports.file.level;
  prevConsole = log.transports.console.level;
  log.transports.file.level = false;
  log.transports.console.level = false;
});
afterAll(() => {
  log.transports.file.level = prevFile;
  log.transports.console.level = prevConsole;
  delete globalThis.__funsyncEroscriptsTestOrigins;
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-es-hard-'));
  requests = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    requests.push({ url, cookie: init.headers?.Cookie ?? null });
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(DOWNLOAD).buffer };
  });
  api = new EroScriptsAPI();
  api.restoreSession('SESSIONCOOKIE01', 'tester');
  const trashItem = vi.fn(async (p) => fs.renameSync(p, `${p}.binned`));
  download = liftMainHandler('eroscripts-download', { eroScripts: api, shell: { trashItem }, log });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.__funsyncEroscriptsTestOrigins;
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = (name = 'Alpha Scene.funscript') => path.join(dir, name);

/**
 * Every fs entry point that writes, moves or removes, refused (it throws, as
 * a denied write would) and recorded, until `restore()` (R4-13). Reads stay
 * real. The API requires 'fs' inside, which is this same module object.
 */
function refuseWrites() {
  const attempts = [];
  const spies = [];
  const refuse = (obj, name) => {
    if (typeof obj?.[name] !== 'function') return;
    spies.push(vi.spyOn(obj, name).mockImplementation((...args) => {
      attempts.push(`${name} ${String(args[0])}`);
      throw Object.assign(new Error(`test: ${name} refused`), { code: 'EACCES' });
    }));
  };
  for (const n of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'openSync', 'open',
    'renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'createWriteStream', 'mkdirSync', 'mkdir',
    'rmSync', 'rm', 'unlinkSync', 'unlink', 'truncateSync', 'truncate']) refuse(fs, n);
  for (const n of ['writeFile', 'appendFile', 'open', 'rename', 'copyFile', 'cp', 'mkdir', 'rm', 'unlink', 'truncate']) {
    refuse(fs.promises, n);
  }
  return { attempts, restore: () => { for (const s of spies) s.mockRestore(); } };
}

describe('the download IPC checks what it is asked to do (R3-04)', () => {
  it.each([
    ['an http (not https) forum URL', 'http://discuss.eroscripts.com/uploads/a.funscript'],
    ['another host', 'https://evil.example/a.funscript'],
    ['a look-alike host', 'https://eroscripts.com.evil.example/a.funscript'],
    ['a host that only ends in the name', 'https://noteroscripts.com/a.funscript'],
    ['a local server', 'http://127.0.0.1:8765/a.funscript'],
    ['a file URL', 'file:///C:/Windows/win.ini'],
    ['not a URL', 'just text'],
    ['not a string', 42],
  ])('refuses %s: nothing fetched, nothing written', async (_label, url) => {
    const res = await download(null, url, target(), {});
    expect(res).toMatchObject({ success: false, refused: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // These save paths are NOT in the scratch folder: a relative one resolves
  // against the cwd, which is the repo. With the check swapped out (a hole
  // run), "a relative path" wrote a 67-byte Alpha Scene.funscript into the
  // repo root (R4-13). Every fs write is refused and recorded while they
  // run, so a reopened hole fails here and can never write anywhere.
  it.each([
    ['a relative path', 'Alpha Scene.funscript'],
    ['another type', path.join(os.tmpdir(), 'funsync-es-hard-x', 'evil.exe')],
    ['a path with a NUL', `${path.join(os.tmpdir(), 'a')}\0.funscript`],
    ['an empty path', ''],
    ['not a string', null],
  ])('refuses %s as the save path', async (_label, savePath) => {
    const guard = refuseWrites();
    let res;
    try {
      res = await download(null, ON_FORUM, savePath, { replace: true });
    } finally {
      guard.restore();
    }
    expect(guard.attempts).toEqual([]);
    expect(res).toMatchObject({ success: false, refused: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('accepts the forum and its CDN, and an attachment URL the forum itself handed out', async () => {
    expect(isEroScriptsUrl(ON_FORUM)).toBe(true);
    expect(isEroScriptsUrl(ON_CDN)).toBe(true);
    expect(isEroScriptsUrl('https://eroscripts.com/x')).toBe(true);
    await expect(download(null, ON_CDN, target('a.funscript'), {})).resolves.toEqual({ success: true });
    // A post's attachment link on some other host: allowed because it came
    // from getTopicAttachments, never because a renderer asked for it.
    const elsewhere = 'https://files.example.net/u/b.funscript';
    await expect(download(null, elsewhere, target('b.funscript'), {})).resolves.toMatchObject({ refused: true });
    api._noteIssuedUrl(elsewhere);
    await expect(download(null, elsewhere, target('b.funscript'), {})).resolves.toEqual({ success: true });
  });

  it('a sandbox driver can allow a local test server from the MAIN process only', async () => {
    const local = 'http://127.0.0.1:8765/a.funscript';
    await expect(download(null, local, target(), {})).resolves.toMatchObject({ refused: true });
    globalThis.__funsyncEroscriptsTestOrigins = ['http://127.0.0.1:8765'];
    await expect(download(null, local, target(), {})).resolves.toEqual({ success: true });
    expect(requests.at(-1).cookie).toBeNull(); // never the session cookie
  });
});

describe('the session cookie goes only to EroScripts (R3-04)', () => {
  it('sent to the forum and its CDN, never to another host', async () => {
    const elsewhere = 'https://files.example.net/u/b.funscript';
    api._noteIssuedUrl(elsewhere);
    await download(null, ON_FORUM, target('a.funscript'), {});
    await download(null, ON_CDN, target('b.funscript'), {});
    await download(null, elsewhere, target('c.funscript'), {});
    expect(requests.map((r) => [new URL(r.url).host, r.cookie])).toEqual([
      ['discuss.eroscripts.com', '_t=SESSIONCOOKIE01'],
      ['eroscripts-discourse.eroscripts.com', '_t=SESSIONCOOKIE01'],
      ['files.example.net', null],
    ]);
  });

  it('the forum requests themselves still carry it', () => {
    expect(api._headers().Cookie).toBe('_t=SESSIONCOOKIE01');
  });
});

describe('the existing file is stat\'ed before anything is read (R3-04)', () => {
  it('a folder at the save path is an error: nothing written, the folder untouched', async () => {
    const folder = target('Folder.funscript');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'inside.txt'), 'x');
    const res = await download(null, ON_FORUM, folder, { replace: true });
    expect(res).toMatchObject({ success: false, notAFile: true });
    expect(fs.readdirSync(folder)).toEqual(['inside.txt']);
  });

  it('a file of another size is "different" without being read', async () => {
    fs.writeFileSync(target(), MINE);
    expect(MINE.length).not.toBe(DOWNLOAD.length);
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const readSync = vi.spyOn(fs, 'readFileSync');
    try {
      await expect(download(null, ON_FORUM, target(), {})).resolves.toEqual({ success: false, exists: true });
      expect(readSpy.mock.calls.filter(([p]) => p === target())).toEqual([]);
      expect(readSync.mock.calls.filter(([p]) => p === target())).toEqual([]);
    } finally {
      readSpy.mockRestore();
      readSync.mockRestore();
    }
    expect(fs.readFileSync(target(), 'utf8')).toBe(MINE);
  });

  it('a file of the same size is compared: other bytes are "different", the same bytes are "unchanged"', async () => {
    const sameSize = DOWNLOAD.replace('"pos":100', '"pos":101'.slice(0, 9)); // same length, other bytes
    expect(sameSize.length).toBe(DOWNLOAD.length);
    expect(sameSize).not.toBe(DOWNLOAD);
    fs.writeFileSync(target(), sameSize);
    await expect(download(null, ON_FORUM, target(), {})).resolves.toEqual({ success: false, exists: true });
    fs.writeFileSync(target(), DOWNLOAD);
    await expect(download(null, ON_FORUM, target(), {})).resolves.toEqual({ success: true, unchanged: true });
  });
});

describe('a look writes nothing, and its write never overwrites what appeared since (R3-03, R3-04)', () => {
  it('checkOnly fetches and answers, and writes or moves nothing', async () => {
    await expect(download(null, ON_FORUM, target(), { checkOnly: true })).resolves.toEqual({ success: true, checked: true });
    expect(fs.existsSync(target())).toBe(false);
    fs.writeFileSync(target(), MINE);
    await expect(download(null, ON_FORUM, target(), { checkOnly: true, replace: true }))
      .resolves.toEqual({ success: true, checked: true, exists: true });
    expect(fs.readFileSync(target(), 'utf8')).toBe(MINE);
    expect(fs.readdirSync(dir)).toEqual(['Alpha Scene.funscript']);
  });

  it('a look and its write are ONE request', async () => {
    await download(null, ON_FORUM, target(), { checkOnly: true });
    await download(null, ON_FORUM, target(), {});
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(target(), 'utf8')).toBe(DOWNLOAD);
    // Written: the next download of the same URL fetches afresh.
    fs.rmSync(target());
    await download(null, ON_FORUM, target(), {});
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('a file that appeared between the look and the write is never written over', async () => {
    await expect(download(null, ON_FORUM, target(), { checkOnly: true })).resolves.toEqual({ success: true, checked: true });
    fs.writeFileSync(target(), MINE); // e.g. the editor's Save at the unsaved question
    // The stat sees it now; a file created between the stat and the write is
    // what flag 'wx' covers, and it answers the same way.
    await expect(download(null, ON_FORUM, target(), {})).resolves.toEqual({ success: false, exists: true });
    expect(fs.readFileSync(target(), 'utf8')).toBe(MINE);
  });

  it('flag wx: a file created after the stat is not overwritten either', async () => {
    const realStat = fs.promises.stat;
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (p === target()) {
        fs.writeFileSync(target(), MINE); // lands just after the stat answered "nothing there"
        throw err;
      }
      return realStat(p);
    });
    try {
      await expect(download(null, ON_FORUM, target(), {})).resolves.toEqual({ success: false, exists: true });
    } finally {
      statSpy.mockRestore();
    }
    expect(fs.readFileSync(target(), 'utf8')).toBe(MINE);
  });
});

describe('a look\'s bytes do not wait in main after a Cancel, and the copy is capped by bytes (R4-09)', () => {
  const urlN = (n) => `https://discuss.eroscripts.com/uploads/short-url/n${n}.funscript`;
  const heldBytes = () => [...api._fetched.values()].reduce((sum, h) => sum + h.buffer.length, 0);

  it('eroscripts-forget-download drops what the look fetched: the next write fetches again', async () => {
    const forget = liftMainHandler('eroscripts-forget-download', { eroScripts: api });
    await download(null, ON_FORUM, target(), { checkOnly: true });
    expect(heldBytes()).toBe(DOWNLOAD.length);
    await expect(forget(null, ON_FORUM)).resolves.toBe(true);
    expect(heldBytes()).toBe(0);
    await expect(forget(null, ON_FORUM)).resolves.toBe(false); // nothing left; never throws
    await expect(forget(null, 42)).resolves.toBe(false);
    await download(null, ON_FORUM, target(), {});
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(target(), 'utf8')).toBe(DOWNLOAD);
  });

  it('the kept bytes never pass the byte cap: the oldest go first, the newest stays for its write', async () => {
    api._fetchKeepBytes = Math.floor(2.5 * DOWNLOAD.length);
    for (const n of [1, 2, 3, 4]) await download(null, urlN(n), target(`n${n}.funscript`), { checkOnly: true });
    expect(heldBytes()).toBeLessThanOrEqual(api._fetchKeepBytes);
    expect([...api._fetched.keys()]).toEqual([urlN(3), urlN(4)]);
    await download(null, urlN(4), target('n4.funscript'), {});
    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // n4's look was reused
    await download(null, urlN(1), target('n1.funscript'), {});
    expect(globalThis.fetch).toHaveBeenCalledTimes(5); // n1 had been let go
  });

  it('one download larger than the cap is still kept for the write after its look', async () => {
    api._fetchKeepBytes = 10;
    await download(null, ON_FORUM, target(), { checkOnly: true });
    await download(null, ON_FORUM, target(), {});
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('the 64 MB default and the 16-download count cap', async () => {
    expect(api._fetchKeepBytes).toBe(64 * 1024 * 1024);
    for (let n = 1; n <= 17; n++) await download(null, urlN(n), target(`n${n}.funscript`), { checkOnly: true });
    expect(api._fetched.size).toBe(16);
    expect(api._fetched.has(urlN(1))).toBe(false);
  });
});

describe('the save path as the OS spells it, before the trash and the write (R4-11)', () => {
  it('normalizeSavePath: forward slashes become backslashes on Windows; posix is left as it is', () => {
    expect(normalizeSavePath('C:/Lib/a/../Alpha Scene.funscript', 'win32')).toBe('C:\\Lib\\Alpha Scene.funscript');
    expect(normalizeSavePath('C:\\Lib\\x.funscript', 'win32')).toBe('C:\\Lib\\x.funscript');
    expect(normalizeSavePath('/home/u/./x.funscript', 'linux')).toBe('/home/u/x.funscript');
    expect(normalizeSavePath(null, 'win32')).toBeNull();
    expect(normalizeSavePath('', 'win32')).toBe('');
  });

  it('Replace with a forward-slash path: the trash and the write get the OS spelling, so Replace works', async () => {
    // Electron's shell.trashItem rejects a forward-slash Windows path
    // ("Failed to parse path", measured by real-app verifier 3 in round 3).
    const trashed = [];
    const strictTrash = vi.fn(async (p) => {
      if (process.platform === 'win32' && p.includes('/')) throw new Error('Failed to parse path');
      trashed.push(p);
      fs.renameSync(p, `${p}.binned`);
    });
    const strict = liftMainHandler('eroscripts-download', { eroScripts: api, shell: { trashItem: strictTrash }, log });
    fs.writeFileSync(target(), MINE);
    const slashed = target().replace(/\\/g, '/');
    await expect(strict(null, ON_FORUM, slashed, { checkOnly: true })).resolves.toMatchObject({ exists: true });
    await expect(strict(null, ON_FORUM, slashed, { replace: true })).resolves.toEqual({ success: true });
    expect(trashed).toEqual([path.normalize(target())]);
    expect(fs.readFileSync(target(), 'utf8')).toBe(DOWNLOAD);
    expect(fs.readFileSync(`${target()}.binned`, 'utf8')).toBe(MINE);
  });

  it('pick-download-save-path hands back the OS spelling of what the dialog chose', async () => {
    const chosen = target('picked.funscript').replace(/\\/g, '/');
    const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: chosen })) };
    const pick = liftMainHandler('pick-download-save-path', { dialog, mainWindow: null, path });
    await expect(pick(null, 'picked.funscript')).resolves.toBe(path.normalize(chosen));
    // Writes nothing (R3-01 still holds).
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('on Windows the save path must be a drive-letter or UNC path (R4-12)', () => {
  it.each([
    ['C:\\Lib\\a.funscript', true],
    ['C:/Lib/a.funscript', true],
    ['d:\\x\\Pack.zip', true],
    ['\\\\nas\\share\\a.funscript', true],
    ['//nas/share/sub/a.funscript', true],
    ['\\a.funscript', false], // the root of whatever drive is current
    ['/a.funscript', false],
    ['C:a.funscript', false], // drive-relative
    ['\\\\nas\\a.funscript', false], // a server with no share
    ['\\\\.\\pipe\\a.funscript', false], // the device namespace
    ['\\\\?\\C:\\a.funscript', false],
    ['a.funscript', false],
  ])('win32 %j: %s', (savePath, ok) => {
    const refused = api.checkDownloadRequest(ON_FORUM, savePath, { platform: 'win32' });
    expect(refused === null).toBe(ok);
  });

  it.each([
    ['/home/u/a.funscript', true],
    ['/mnt/nas/Pack.zip', true],
    ['home/u/a.funscript', false],
    ['C:\\Lib\\a.funscript', false],
  ])('posix %j: %s', (savePath, ok) => {
    const refused = api.checkDownloadRequest(ON_FORUM, savePath, { platform: 'linux' });
    expect(refused === null).toBe(ok);
  });

  it.runIf(process.platform === 'win32')('the IPC refuses a root-relative path: nothing fetched, nothing written', async () => {
    const guard = refuseWrites();
    let res;
    try {
      res = await download(null, ON_FORUM, '\\funsync-r4-12-probe.funscript', { replace: true });
    } finally {
      guard.restore();
    }
    expect(res).toMatchObject({ success: false, refused: true });
    expect(guard.attempts).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('safeAttachmentName: the post\'s link text, made safe to save under (R3-04)', () => {
  it.each([
    ['Alpha Scene.funscript', 'Alpha Scene.funscript'],
    ['../x.funscript', 'x.funscript'],
    ['..\\..\\x.funscript', 'x.funscript'],
    ['C:\\Windows\\x.funscript', 'x.funscript'],
    ['/etc/x.funscript', 'x.funscript'],
    ['a/../b.funscript', 'b.funscript'],
    ['Scene: "Part 1"?.funscript', 'Scene_ _Part 1__.funscript'],
    ['<x>|y*.zip', '_x__y_.zip'],
    ['tab\there.funscript', 'tabhere.funscript'],
    ['  .hidden.funscript  ', 'hidden.funscript'],
    ['name. .funscript', 'name. .funscript'],
    ['trailing.funscript. ', 'trailing.funscript'],
    ['CON.funscript', '_CON.funscript'],
    ['nul.roll.funscript', '_nul.roll.funscript'],
    ['com1.zip', '_com1.zip'],
    ['Console.funscript', 'Console.funscript'],
    ['UPPER.FUNSCRIPT', 'UPPER.FUNSCRIPT'],
    ['Pack.ZIP', 'Pack.ZIP'],
  ])('%j -> %j', (input, out) => {
    expect(safeAttachmentName(input)).toBe(out);
  });

  it.each(['', '..', '.', '.funscript', '..funscript', '___.funscript', ' . ', '../..', 'x.txt', 'x.funscript.exe', null, 42])(
    'nothing usable in %j: refused (empty)', (input) => {
      expect(safeAttachmentName(input)).toBe('');
    },
  );

  it('a very long name is cut to fit (240 UTF-8 bytes), keeping the extension', () => {
    const long = `${'あ'.repeat(200)}.funscript`;
    const out = safeAttachmentName(long);
    expect(out.endsWith('.funscript')).toBe(true);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(240);
    expect(out.startsWith('あああ')).toBe(true);
  });
});
