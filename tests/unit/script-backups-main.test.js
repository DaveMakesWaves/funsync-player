/**
 * @vitest-environment node
 * main.js handlers lifted and run against real files in a temp dir; no DOM.
 * See notes/CLAUDE.md "Test environments".
 */
// Script backups in main (editor work list 3.1, 2026-11-24): save-funscript
// and write-funscript keep the version on disk before they replace it, and
// list-script-backups / read-script-backup answer the editor's "Restore an
// earlier version…". The handlers are lifted verbatim from electron/main.js
// (it cannot be imported without Electron) and reached through the REAL
// preload, so a wrong channel name anywhere on the way fails here. Temp dirs
// only: never the user's %APPDATA% or a library folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { liftMainHandler } from './helpers/main-handlers.js';

const require_ = createRequire(import.meta.url);
const { createScriptBackups, CHECKPOINT_MS } = require_('../../electron/script-backups.js');

const CHANNELS = ['write-funscript', 'save-funscript', 'list-script-backups', 'read-script-backup'];
const script = (n) => JSON.stringify({ version: '1.0', actions: Array.from({ length: n }, (_, i) => ({ at: i * 50, pos: 50 })) });

let tmp;
let lib;
let clock;
let lines;
let savePick;

const log = {
  warn: (...a) => lines.push({ level: 'warn', text: a.join(' ') }),
  error: (...a) => lines.push({ level: 'error', text: a.join(' ') }),
  info() {},
  debug() {},
};
const dialog = { showSaveDialog: async () => ({ canceled: !savePick, filePath: savePick }) };

/** The real preload, its invoke wired to the lifted main handlers. */
function realPreload(scriptBackups) {
  const deps = { scriptBackups, fs, log, dialog, mainWindow: null };
  const handlers = Object.fromEntries(CHANNELS.map((c) => [c, liftMainHandler(c, deps)]));
  const ipcRenderer = new EventEmitter();
  ipcRenderer.send = () => {};
  ipcRenderer.invoke = async (channel, ...args) => {
    if (!handlers[channel]) throw new Error(`no main handler wired for ${channel}`);
    return handlers[channel]({}, ...args);
  };
  let api = null;
  const fakeElectron = { contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } }, ipcRenderer, webUtils: {} };
  const resolved = require_.resolve('../../electron/preload.js');
  delete require_.cache[resolved];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  try { require_(resolved); } finally { Module._load = origLoad; }
  return api;
}

const backupsIn = (userData) => createScriptBackups({ getUserDataDir: () => userData, log, now: () => clock });

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-script-backups-main-'));
  lib = path.join(tmp, 'library');
  await fsp.mkdir(lib);
  await fsp.mkdir(path.join(tmp, 'userData'));
  clock = Date.UTC(2026, 10, 24, 14, 2, 0, 0);
  lines = [];
  savePick = null;
});
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

describe('write-funscript (autosave, Save, exports, Pair)', () => {
  it('keeps the version it overwrites; the editor lists and reads it back through the preload', async () => {
    const api = realPreload(backupsIn(path.join(tmp, 'userData')));
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(3));

    expect(await api.writeFunscript(script(4), file)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(script(4));

    const list = await api.listScriptBackups(file);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ points: 3, size: Buffer.byteLength(script(3)) });
    expect(await api.readScriptBackup(file, list[0].id)).toBe(script(3));
    // Nothing beside the script.
    expect(fs.readdirSync(lib)).toEqual(['Clip.funscript']);
    expect(lines).toEqual([]);
  });

  it('autosave every few seconds keeps one version, then a checkpoint after 10 minutes', async () => {
    const api = realPreload(backupsIn(path.join(tmp, 'userData')));
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    for (let i = 2; i <= 30; i++) {
      clock += 3000;
      await api.writeFunscript(script(i), file);
    }
    expect((await api.listScriptBackups(file)).map((e) => e.points)).toEqual([1]);
    clock += CHECKPOINT_MS;
    await api.writeFunscript(script(31), file);
    expect((await api.listScriptBackups(file)).map((e) => e.points)).toEqual([30, 1]);
  });

  it('a backup that cannot be made never blocks the write: a warning, then the file is written', async () => {
    const blocked = path.join(tmp, 'userData-is-a-file');
    fs.writeFileSync(blocked, 'x');
    const api = realPreload(backupsIn(blocked));
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    expect(await api.writeFunscript(script(2), file)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(script(2));
    expect(lines.map((l) => l.level)).toEqual(['warn']);
    expect(await api.listScriptBackups(file)).toEqual([]);
  });

  it('a new script: written, nothing kept', async () => {
    const api = realPreload(backupsIn(path.join(tmp, 'userData')));
    const file = path.join(lib, 'New.funscript');
    expect(await api.writeFunscript(script(1), file)).toBe(file);
    expect(await api.listScriptBackups(file)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'userData', 'script-backups'))).toBe(false);
  });
});

describe('save-funscript (Save As, a combined export)', () => {
  it('a file the user agreed to replace is kept first', async () => {
    const api = realPreload(backupsIn(path.join(tmp, 'userData')));
    const file = path.join(lib, 'Clip (edit).funscript');
    fs.writeFileSync(file, script(7));
    savePick = file;
    expect(await api.saveFunscript(script(8), 'Clip (edit).funscript')).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(script(8));
    const [entry] = await api.listScriptBackups(file);
    expect(await api.readScriptBackup(file, entry.id)).toBe(script(7));
  });

  it('cancelled: nothing written, nothing kept', async () => {
    const api = realPreload(backupsIn(path.join(tmp, 'userData')));
    savePick = null;
    expect(await api.saveFunscript(script(1), 'x.funscript')).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'userData', 'script-backups'))).toBe(false);
  });
});

describe('read-script-backup', () => {
  it('reads only that path\'s own versions', async () => {
    const api = realPreload(backupsIn(path.join(tmp, 'userData')));
    const a = path.join(lib, 'A.funscript');
    const b = path.join(lib, 'B.funscript');
    fs.writeFileSync(a, 'version of a');
    fs.writeFileSync(b, 'version of b');
    await api.writeFunscript(script(1), a);
    clock += 1;
    await api.writeFunscript(script(1), b);
    const [ea] = await api.listScriptBackups(a);
    const [eb] = await api.listScriptBackups(b);
    expect(await api.readScriptBackup(a, ea.id)).toBe('version of a');
    expect(await api.readScriptBackup(a, eb.id)).toBeNull();
    expect(await api.readScriptBackup(a, '../index')).toBeNull();
    expect(await api.readScriptBackup(a, `..${path.sep}..${path.sep}config`)).toBeNull();
  });
});
