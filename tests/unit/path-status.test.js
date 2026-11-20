/**
 * @vitest-environment node
 * Real folders, the REAL electron/path-status.js and main.js's existence
 * section lifted whole; no DOM. See notes/CLAUDE.md "Test environments".
 */
// FT-002 (2026-11-05, in v0.9.2 too): a permission-denied folder read as
// "absent".
//
// `pathReachable` mapped EVERY `fs.access` error to `false`, "definitely
// absent". Inside a folder whose listing is denied (a Windows deny ACL, a
// POSIX folder without the execute bit), `fs.access` on a file that IS there
// fails with EPERM / EACCES while `fs.access` on the folder passes. So
// `library._safeToPrune` saw "file absent, folder answers", the shape of a
// proven deletion, and pruned the association. Paths under a source were
// covered by the scan's `skippedPaths` (V04); a script outside every source
// was not. Now only ENOENT / ENOTDIR are absent and any other error is
// unknown (`null`), which every prune treats as "keep".
//
// These tests use the real file system and a real deny rule, because what
// matters is what the OS answers, and a stubbed error code would only repeat
// our assumption about it back to us.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { pathReachable, statusForError, EXISTS_TIMEOUT_MS } = require_('../../electron/path-status.js');

const isWin = process.platform === 'win32';
// root ignores POSIX permission bits, so a chmod'd folder is not denied.
const canDeny = isWin || (typeof process.getuid === 'function' && process.getuid() !== 0);

/** Deny listing (and reading) a folder for the current user; returns the undo. */
function denyFolder(dir) {
  if (isWin) {
    const who = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync('icacls', [dir, '/deny', `${who}:(OI)(CI)(RX)`], { stdio: 'ignore' });
    return () => execFileSync('icacls', [dir, '/remove:d', who], { stdio: 'ignore' });
  }
  fs.chmodSync(dir, 0o000);
  return () => fs.chmodSync(dir, 0o755);
}

let dir;
let undo = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-path-status-'));
  undo = [];
});

afterEach(() => {
  for (const u of undo.reverse()) { try { u(); } catch { /* best effort */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** <dir>/Locked/x.funscript, then the folder's listing denied. */
function lockedScript() {
  const locked = path.join(dir, 'Locked');
  fs.mkdirSync(locked);
  const file = path.join(locked, 'x.funscript');
  fs.writeFileSync(file, '{"actions":[]}');
  undo.push(denyFolder(locked));
  return { locked, file };
}

describe('pathReachable on the real file system', () => {
  it('a file or folder that is there: true', async () => {
    const file = path.join(dir, 'Scene.funscript');
    fs.writeFileSync(file, '{}');
    await expect(pathReachable(file)).resolves.toBe(true);
    await expect(pathReachable(dir)).resolves.toBe(true);
  });

  it('a missing file in a folder that answers: false (definitely absent)', async () => {
    await expect(pathReachable(path.join(dir, 'gone.funscript'))).resolves.toBe(false);
  });

  it('a missing folder, and a path through a file: false (ENOENT / ENOTDIR)', async () => {
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'x');
    await expect(pathReachable(path.join(dir, 'no-such-folder', 'x.funscript'))).resolves.toBe(false);
    await expect(pathReachable(path.join(dir, 'plain.txt', 'child.funscript'))).resolves.toBe(false);
  });

  it('no path at all: false, as before', async () => {
    await expect(pathReachable('')).resolves.toBe(false);
    await expect(pathReachable(undefined)).resolves.toBe(false);
  });

  it.runIf(canDeny)('a file inside a folder whose listing is denied: null (unknown), never false', async () => {
    const { locked, file } = lockedScript();
    // The shape that made `_safeToPrune` prune: the folder answers...
    await expect(pathReachable(locked)).resolves.toBe(true);
    // ...and the file is there, but cannot be reached. It used to be `false`.
    await expect(pathReachable(file)).resolves.toBeNull();
  });

  it.runIf(isWin)('Windows: a MISSING file inside a denied folder is still ENOENT, so still false', async () => {
    // Measured 2026-11-05: name lookup does not need the listing right, so a
    // file that is really not there still says so. Absence stays provable.
    const { locked } = lockedScript();
    await expect(pathReachable(path.join(locked, 'nope.funscript'))).resolves.toBe(false);
  });

  it.runIf(canDeny)('the same file once the folder is unlocked: true', async () => {
    const { file } = lockedScript();
    undo.pop()();
    await expect(pathReachable(file)).resolves.toBe(true);
  });
});

describe('which errors count as absent', () => {
  const err = (code) => Object.assign(new Error(code), { code });

  it('only ENOENT and ENOTDIR are false', () => {
    expect(statusForError(err('ENOENT'))).toBe(false);
    expect(statusForError(err('ENOTDIR'))).toBe(false);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY', 'EIO', 'ELOOP', 'EMFILE', 'ENETUNREACH', 'UNKNOWN'])(
    '%s is null (unknown)', (code) => {
      expect(statusForError(err(code))).toBeNull();
    },
  );

  it('an error with no code is unknown', () => {
    expect(statusForError(new Error('weird'))).toBeNull();
    expect(statusForError(undefined)).toBeNull();
  });

  it('an access that rejects or throws goes through the same mapping', async () => {
    const eperm = async () => { throw err('EPERM'); };
    const enoentSync = () => { throw err('ENOENT'); };
    await expect(pathReachable('C:/x', 50, { access: eperm })).resolves.toBeNull();
    await expect(pathReachable('C:/x', 50, { access: enoentSync })).resolves.toBe(false);
  });

  it('no answer within the budget: null', async () => {
    const never = () => new Promise(() => {});
    await expect(pathReachable('C:/x', 20, { access: never })).resolves.toBeNull();
  });

  it('keeps the 800 ms default budget', () => {
    expect(EXISTS_TIMEOUT_MS).toBe(800);
  });
});

// --- main.js's existence section, lifted whole ------------------------------
//
// From the "File existence check" marker to the end of the `files-exist`
// handler: the require of path-status.js is inside it, so this runs exactly
// what main.js runs (with the old inline `pathReachable` it ran that).

const mainSrc = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

function liftExistenceHandlers() {
  const start = mainSrc.indexOf('// --- File existence check ---');
  const batch = mainSrc.indexOf("ipcMain.handle('files-exist'");
  if (start < 0 || batch < start) throw new Error('existence section not found in main.js');
  const end = mainSrc.indexOf('\n});', batch) + '\n});'.length;
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const mainRequire = createRequire(new URL('../../electron/main.js', import.meta.url));
  // eslint-disable-next-line no-new-func
  new Function('ipcMain', 'require', 'fs', mainSrc.slice(start, end))(ipcMain, mainRequire, fs);
  if (!handlers['file-exists'] || !handlers['files-exist']) throw new Error('handlers not registered');
  return handlers;
}

describe("main.js 'files-exist' / 'file-exists' answer what the OS says", () => {
  it.runIf(canDeny)('files-exist: present true, missing false, denied null, in order', async () => {
    const present = path.join(dir, 'Here.funscript');
    fs.writeFileSync(present, '{}');
    const { file } = lockedScript();
    const h = liftExistenceHandlers();
    await expect(h['files-exist']({}, [present, path.join(dir, 'gone.funscript'), file]))
      .resolves.toEqual([true, false, null]);
  });

  it.runIf(canDeny)('file-exists stays boolean: unknown collapses to false for its true-only callers', async () => {
    const present = path.join(dir, 'Here.funscript');
    fs.writeFileSync(present, '{}');
    const { file } = lockedScript();
    const h = liftExistenceHandlers();
    await expect(h['file-exists']({}, present)).resolves.toBe(true);
    await expect(h['file-exists']({}, file)).resolves.toBe(false);
  });

  it('files-exist takes the caller budget and answers null when it runs out', async () => {
    const h = liftExistenceHandlers();
    // A real path, a real budget of 1 ms: either the OS answered in time
    // (true) or it did not (null); never false for a file that is there.
    const present = path.join(dir, 'Here.funscript');
    fs.writeFileSync(present, '{}');
    const [r] = await h['files-exist']({}, [present], 1);
    expect([true, null]).toContain(r);
    await expect(h['files-exist']({}, 'not-an-array')).resolves.toEqual([]);
  });
});
