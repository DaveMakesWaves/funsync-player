/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A probe that times out has not proved anything.
//
// `pathReachable` returned `false` on timeout, so "could not answer in time"
// was indistinguishable from "does not exist" — and absence is acted on. With
// the app busy (statting 1,532 files, rescanning 880 GB), the source probe
// timed out on every path and the app locked the user's ENTIRE library as
// unreachable, including a local folder on C: that plainly existed. The whole
// library appeared to vanish (2026-08-26).
//
// The existing `catch` already failed open, with a comment saying a wrongly
// locked library is far worse than a missing lock state. A timeout *resolves*
// rather than throwing, so it walked straight past that protection.
//
// Same family as "absence is never destructive": treat unknown as unknown.
//
// FT-002 (2026-11-05): these used to assert main.js's source text, including
// `.then(() => true, () => false)`, which pinned "every error is absent" as
// correct. They now run the real code: `pathReachable` from
// electron/path-status.js (real folders and a real deny ACL in
// path-status.test.js), main.js's `file-exists` handler lifted, and app.js's
// REAL `_probeSourceReachability`.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { liftAppClass } from './helpers/app-methods.js';
import { sourcesToProbe } from '../../renderer/js/source-state.js';

const require_ = createRequire(import.meta.url);
const { pathReachable } = require_('../../electron/path-status.js');
const mainSrc = fs.readFileSync('electron/main.js', 'utf8');

const errCode = (code) => Object.assign(new Error(code), { code });

describe('pathReachable — three states, not two', () => {
  it('resolves null on timeout rather than false', async () => {
    const never = () => new Promise(() => {});
    await expect(pathReachable('D:/slow/share', 20, { access: never })).resolves.toBeNull();
  });

  it('still reports a genuinely missing path as false', async () => {
    // A real missing path: ENOENT is real evidence of absence and stays false.
    const missing = path.join(os.tmpdir(), `funsync-no-such-${process.pid}-${Date.now()}`, 'x.funscript');
    await expect(pathReachable(missing)).resolves.toBe(false);
  });

  it('a permission error is unknown, not absent (FT-002)', async () => {
    const eperm = async () => { throw errCode('EPERM'); };
    await expect(pathReachable('C:/Locked/x.funscript', 50, { access: eperm })).resolves.toBeNull();
  });

  it('rejects an empty path outright', async () => {
    await expect(pathReachable('')).resolves.toBe(false);
  });
});

/** main.js's `file-exists` handler, lifted, over a given `pathReachable`. */
function liftFileExists(pathReachableImpl) {
  const start = mainSrc.indexOf("ipcMain.handle('file-exists'");
  if (start < 0) throw new Error('file-exists handler not found in main.js');
  const end = mainSrc.indexOf('\n});', start) + '\n});'.length;
  let handler;
  const ipcMain = { handle: (_name, fn) => { handler = fn; } };
  // eslint-disable-next-line no-new-func
  new Function('ipcMain', 'pathReachable', mainSrc.slice(start, end))(ipcMain, pathReachableImpl);
  return handler;
}

describe('the singular file-exists IPC stays boolean', () => {
  it('collapses unknown to false for its many existing callers', async () => {
    // Dozens of callers treat this as a plain boolean and are probing single
    // scripts, not deciding whether a library is reachable. Changing their
    // contract would be a far larger blast radius than the bug being fixed.
    // Every one of them acts only on `true` (audited for FT-002).
    const answers = { 'C:/here': true, 'C:/gone': false, 'C:/slow': null };
    const handler = liftFileExists(async (p) => answers[p]);
    await expect(handler({}, 'C:/here')).resolves.toBe(true);
    await expect(handler({}, 'C:/gone')).resolves.toBe(false);
    await expect(handler({}, 'C:/slow')).resolves.toBe(false);
  });
});

// --- app.js `_probeSourceReachability`, the REAL method -------------------

const LiftedApp = liftAppClass(['_probeSourceReachability'], {
  sourcesToProbe, SOURCE_PROBE_TIMEOUT_MS: 800,
});

const SOURCES = ['C:/a', 'D:/b', 'D:/c'].map((p, i) => ({ id: `s${i}`, name: p, path: p, enabled: true }));

async function probe(filesExist, sources = SOURCES) {
  const prev = globalThis.window;
  globalThis.window = { funsync: { filesExist: vi.fn(filesExist) } };
  try {
    const unreachable = await new LiftedApp()._probeSourceReachability(sources, true);
    return { unreachable: [...unreachable], filesExist: globalThis.window.funsync.filesExist };
  } finally {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  }
}

describe('the source probe only locks on definite absence', () => {
  it('locks nothing when every probe timed out', async () => {
    const { unreachable } = await probe(async (paths) => paths.map(() => null));
    expect(unreachable).toEqual([]);
  });

  it('locks only the path that definitely does not exist', async () => {
    const { unreachable } = await probe(async () => [true, false, null]);
    expect(unreachable).toEqual(['D:/b']);
  });

  it('asks with the short source budget', async () => {
    const { filesExist } = await probe(async (paths) => paths.map(() => true));
    expect(filesExist).toHaveBeenCalledWith(['C:/a', 'D:/b', 'D:/c'], 800);
  });

  it('locks nothing on a malformed response or a length mismatch', async () => {
    expect((await probe(async () => undefined)).unreachable).toEqual([]);
    expect((await probe(async () => [false])).unreachable).toEqual([]);
  });

  it('still fails open when the IPC throws', async () => {
    const { unreachable } = await probe(async () => { throw new Error('ipc died'); });
    expect(unreachable).toEqual([]);
  });

  it('a source root that refuses (EPERM) is not locked: the scan fails it instead (FT-002)', async () => {
    // Behind the bridge: the REAL pathReachable, one root answering EPERM.
    const access = async (p) => {
      if (p === 'D:/b') throw errCode('EPERM');
      if (p === 'D:/c') throw errCode('ENOENT');
    };
    const { unreachable } = await probe(
      async (paths) => Promise.all(paths.map((p) => pathReachable(p, 50, { access }))),
    );
    expect(unreachable).toEqual(['D:/c']);
  });
});
