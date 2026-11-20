/**
 * @vitest-environment node
 * Real folders, the REAL library-scan.js, main.js's handler lifted and the
 * REAL preload; no DOM. See notes/CLAUDE.md "Test environments".
 */
// V82 verify (2026-11-03): once Recheck stopped rescanning a library whose
// probe answers had not changed, a source that was listed fine and then had
// its listing denied read "All sources are reachable." The probe is
// `fs.access`, which passes for such a folder; only the scan found out.
// Recheck now asks `dirs-listable` for every source the probe passed, and
// rescans when one cannot be read. This pins the main-process half: what
// `rootListable` answers, that the IPC hands back one answer per path in
// order, and that the preload carries it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { rootListable, walkSource } = require_('../../electron/library-scan.js');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-listable-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, opendir'), { code: 'EPERM' });

describe('rootListable answers what the scan would find at the root', () => {
  it('a folder with files: true', async () => {
    fs.writeFileSync(path.join(dir, 'One.mp4'), 'x');
    await expect(rootListable(dir)).resolves.toBe(true);
  });

  it('an empty folder: true (nothing to list is not a failure)', async () => {
    await expect(rootListable(dir)).resolves.toBe(true);
  });

  it('a missing folder, a file, or no path: false', async () => {
    fs.writeFileSync(path.join(dir, 'One.mp4'), 'x');
    await expect(rootListable(path.join(dir, 'gone'))).resolves.toBe(false);
    await expect(rootListable(path.join(dir, 'One.mp4'))).resolves.toBe(false);
    await expect(rootListable('')).resolves.toBe(false);
    await expect(rootListable(undefined)).resolves.toBe(false);
  });

  it('listing denied (opendir EPERM, the Windows shape): false, as the scan fails that source', async () => {
    const opendir = vi.fn(async () => { throw eperm(); });
    await expect(rootListable(dir, { opendir })).resolves.toBe(false);
    // The scan's own root read fails the same way, which is what puts the
    // source in failedPaths.
    await expect(walkSource(dir, { readdir: async () => { throw eperm(); } })).rejects.toThrow(/EPERM/);
  });

  it('opens and READS: a folder that opens but cannot be read is false, and its handle is closed', async () => {
    const close = vi.fn(async () => {});
    const opendir = vi.fn(async () => ({ read: async () => { throw eperm(); }, close }));
    await expect(rootListable(dir, { opendir })).resolves.toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reads one entry, not the whole folder, and closes it', async () => {
    const read = vi.fn(async () => ({ name: 'One.mp4' }));
    const close = vi.fn(async () => {});
    await expect(rootListable(dir, { opendir: async () => ({ read, close }) })).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('no answer within the budget: null (unknown), and the late handle is still closed', async () => {
    const close = vi.fn(async () => {});
    let open;
    const opendir = () => new Promise((resolve) => { open = () => resolve({ read: async () => null, close }); });
    await expect(rootListable(dir, { opendir, timeoutMs: 20 })).resolves.toBeNull();
    open();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  // The fact the whole fix rests on, on the real file system: a folder whose
  // listing is denied passes the existence probe and fails this.
  it.runIf(process.platform === 'win32')('Windows: a folder with listing denied passes fs.access and is not listable', async () => {
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'Hidden.mp4'), 'x');
    const who = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync('icacls', [locked, '/deny', `${who}:(OI)(CI)(RX)`], { stdio: 'ignore' });
    try {
      await expect(fs.promises.access(locked).then(() => true)).resolves.toBe(true);
      await expect(rootListable(locked)).resolves.toBe(false);
    } finally {
      execFileSync('icacls', [locked, '/remove:d', who], { stdio: 'ignore' });
    }
    await expect(rootListable(locked)).resolves.toBe(true);
  });
});

// --- main.js `dirs-listable`, lifted, behind the REAL preload ---------------

const mainSrc = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

function liftDirsListable(rootListableImpl) {
  const start = mainSrc.indexOf("ipcMain.handle('dirs-listable'");
  if (start < 0) throw new Error('dirs-listable handler not found in main.js');
  const end = mainSrc.indexOf('\n});', start) + '\n});'.length;
  let handler;
  const ipcMain = { handle: (_name, fn) => { handler = fn; } };
  // eslint-disable-next-line no-new-func
  new Function('ipcMain', 'rootListable', mainSrc.slice(start, end))(ipcMain, rootListableImpl);
  return handler;
}

/** The real preload.js, its `invoke` routed to the lifted handler. */
function loadPreload(handlers) {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = vi.fn(async (channel, ...args) => {
    if (!handlers[channel]) throw new Error(`No handler registered for '${channel}'`);
    return handlers[channel]({}, ...args);
  });
  let api = null;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer,
    webUtils: {},
  };
  const resolved = require_.resolve('../../electron/preload.js');
  delete require_.cache[resolved];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  try {
    require_(resolved);
  } finally {
    Module._load = origLoad;
  }
  return api;
}

describe('window.funsync.dirsListable reaches rootListable in main', () => {
  it('one answer per path, in order, through the real preload and handler', async () => {
    fs.mkdirSync(path.join(dir, 'a'));
    const api = loadPreload({ 'dirs-listable': liftDirsListable(rootListable) });
    const answers = await api.dirsListable([path.join(dir, 'a'), path.join(dir, 'gone'), dir], 800);
    expect(answers).toEqual([true, false, true]);
  });

  it('passes the renderer budget on, falls back to the default without one, and answers [] to a non-list', async () => {
    const spy = vi.fn(async () => true);
    const handler = liftDirsListable(spy);
    await handler({}, ['X:\\a'], 800);
    expect(spy).toHaveBeenLastCalledWith('X:\\a', { timeoutMs: 800 });
    await handler({}, ['X:\\a']);
    expect(spy).toHaveBeenLastCalledWith('X:\\a', { timeoutMs: undefined });
    await expect(handler({}, 'X:\\a')).resolves.toEqual([]);
  });
});
