/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R4-14 (wording) and R4-15 (threadpool), both in electron/path-status.js.
//
// R4-14: `files-exist` answered null for a check that ran out of time as well
// as for a permission error, so on a slow share where the folder answered in
// time and the script did not, the open said "access denied". `files-exist`
// with `{ why: true }` now says which ('denied' / 'timeout' / 'error'); the
// tri-state answer every prune reads is unchanged.
//
// R4-15: the budget ends the WAIT, not the `fs.access` under it, which keeps
// a libuv threadpool slot until the OS gives up (30-60 s on a dead SMB host).
// The 30 s source poll asked again each time, adding one stuck access per root
// per poll; two or three such roots filled the 4-slot pool. A check of a path
// whose access has not settled now waits on that one.
//
// What runs for real: path-status.js, and main.js's existence section lifted
// whole (require included) over a real scratch folder. Stand-in: an access
// function that never settles, or settles when the test says.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pathReachable, pathStatusDetail, unsettledCount, EXISTS_TIMEOUT_MS,
} = require('../../electron/path-status.js');

const err = (code) => Object.assign(new Error(code), { code });

/** An access the test settles by hand; counts the calls it gets. */
function hangingAccess() {
  const pending = [];
  const fn = (p) => new Promise((resolve, reject) => { pending.push({ p, resolve, reject }); });
  fn.calls = () => pending.length;
  fn.settle = (i, error) => (error ? pending[i].reject(error) : pending[i].resolve());
  return fn;
}

describe('one fs.access per path at a time (R4-15)', () => {
  it('a hung path is accessed ONCE however often it is checked; every check still answers null in its budget', async () => {
    const access = hangingAccess();
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await pathReachable('\\\\nas\\share', 10, { access }));
    expect(answers).toEqual([null, null, null, null, null]);
    expect(access.calls()).toBe(1);
    expect(unsettledCount(access)).toBe(1);
  });

  it('checks that overlap share it too', async () => {
    const access = hangingAccess();
    const all = await Promise.all([1, 2, 3].map(() => pathReachable('\\\\nas\\share', 10, { access })));
    expect(all).toEqual([null, null, null]);
    expect(access.calls()).toBe(1);
  });

  it('each path gets its own access; one hung root does not hold back another', async () => {
    const access = hangingAccess();
    await pathReachable('\\\\nas\\a', 5, { access });
    await pathReachable('\\\\nas\\b', 5, { access });
    await pathReachable('\\\\nas\\a', 5, { access });
    expect(access.calls()).toBe(2);
    expect(unsettledCount(access)).toBe(2);
  });

  it('once it settles the entry goes: a check after it waits on it, the next one starts afresh', async () => {
    const access = hangingAccess();
    await expect(pathReachable('\\\\nas\\share', 5, { access })).resolves.toBeNull();
    // A check while it is still out, with time to spare, gets ITS answer.
    const late = pathReachable('\\\\nas\\share', 1000, { access });
    access.settle(0);
    await expect(late).resolves.toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(unsettledCount(access)).toBe(0);
    const next = pathReachable('\\\\nas\\share', 1000, { access });
    await new Promise((r) => setTimeout(r, 0));
    expect(access.calls()).toBe(2);
    access.settle(1, err('ENOENT'));
    await expect(next).resolves.toBe(false);
  });

  it('the answers themselves are unchanged: ENOENT / ENOTDIR false, EPERM / EBUSY / a sync throw null', async () => {
    await expect(pathReachable('C:/x', 50, { access: async () => {} })).resolves.toBe(true);
    await expect(pathReachable('C:/x', 50, { access: async () => { throw err('ENOENT'); } })).resolves.toBe(false);
    await expect(pathReachable('C:/x', 50, { access: async () => { throw err('ENOTDIR'); } })).resolves.toBe(false);
    await expect(pathReachable('C:/x', 50, { access: async () => { throw err('EPERM'); } })).resolves.toBeNull();
    await expect(pathReachable('C:/x', 50, { access: async () => { throw err('EBUSY'); } })).resolves.toBeNull();
    await expect(pathReachable('C:/x', 50, { access: () => { throw err('EACCES'); } })).resolves.toBeNull();
    await expect(pathReachable('', 50)).resolves.toBe(false);
    expect(EXISTS_TIMEOUT_MS).toBe(800);
  });
});

describe('why an answer is unknown (R4-14)', () => {
  it.each([
    ['there', async () => {}, { status: true, why: null }],
    ['missing (ENOENT)', async () => { throw err('ENOENT'); }, { status: false, why: null }],
    ['a parent that is a file (ENOTDIR)', async () => { throw err('ENOTDIR'); }, { status: false, why: null }],
    ['a deny ACL (EPERM)', async () => { throw err('EPERM'); }, { status: null, why: 'denied' }],
    ['no permission (EACCES)', async () => { throw err('EACCES'); }, { status: null, why: 'denied' }],
    ['busy (EBUSY)', async () => { throw err('EBUSY'); }, { status: null, why: 'error' }],
    ['a share that refuses (UNKNOWN)', async () => { throw err('UNKNOWN'); }, { status: null, why: 'error' }],
    ['no answer in time', () => new Promise(() => {}), { status: null, why: 'timeout' }],
  ])('%s', async (_label, access, expected) => {
    await expect(pathStatusDetail('C:/x', 20, { access })).resolves.toEqual(expected);
  });
});

// --- main.js's existence section, lifted whole (as path-status.test.js) ----

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
  return handlers;
}

describe("main.js 'files-exist' with { why: true } (R4-14)", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-why-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('answers { status, why } per path, in order; without it the plain tri-state as before', async () => {
    const present = path.join(dir, 'Here.funscript');
    fs.writeFileSync(present, '{}');
    const gone = path.join(dir, 'gone.funscript');
    const h = liftExistenceHandlers();
    await expect(h['files-exist']({}, [present, gone, dir], undefined, { why: true })).resolves.toEqual([
      { status: true, why: null },
      { status: false, why: null },
      { status: true, why: null },
    ]);
    await expect(h['files-exist']({}, [present, gone])).resolves.toEqual([true, false]);
    await expect(h['files-exist']({}, 'not-an-array', undefined, { why: true })).resolves.toEqual([]);
  });

  it('a budget that runs out says timeout (never false for a file that is there)', async () => {
    const present = path.join(dir, 'Here.funscript');
    fs.writeFileSync(present, '{}');
    const h = liftExistenceHandlers();
    const [r] = await h['files-exist']({}, [present], 1, { why: true });
    expect([JSON.stringify({ status: true, why: null }), JSON.stringify({ status: null, why: 'timeout' })])
      .toContain(JSON.stringify(r));
  });
});
