/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// electron/script-backups.js (editor work list 3.1, 2026-11-24): the version
// of a script on disk is kept in <userData>/script-backups before FunSync
// overwrites it. Real files in a temp dir throughout (never the user's
// %APPDATA% or a library folder); the clock is injected so the 10-minute
// checkpoint needs no waiting.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  createScriptBackups, compactIso, idTime, countPoints, KEEP_PER_SCRIPT, CHECKPOINT_MS, ID_RE,
} = require_('../../electron/script-backups.js');

const T0 = Date.UTC(2026, 10, 24, 14, 2, 5, 123);
const script = (n) => JSON.stringify({ version: '1.0', actions: Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: i % 2 ? 100 : 0 })) });

let tmp;
let userData;
let lib;
let clock;
let warnings;
let backups;

function make(opts = {}) {
  return createScriptBackups({
    getUserDataDir: () => userData,
    log: { warn: (...a) => warnings.push(a.join(' ')), info() {} },
    now: () => clock,
    ...opts,
  });
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-script-backups-'));
  userData = path.join(tmp, 'userData');
  lib = path.join(tmp, 'library');
  await fsp.mkdir(userData);
  await fsp.mkdir(lib);
  clock = T0;
  warnings = [];
  backups = make();
});
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

const root = () => path.join(userData, 'script-backups');
const folders = () => (fs.existsSync(root()) ? fs.readdirSync(root()) : []);

/** What the write handlers do: back up, then write. */
async function write(b, file, content) {
  const r = await b.backupBeforeWrite(file, content);
  fs.writeFileSync(file, content, 'utf-8');
  return r;
}

describe('ids', () => {
  it('compact ISO time, and back', () => {
    expect(compactIso(T0)).toBe('20261124T140205123Z');
    expect(idTime('20261124T140205123Z')).toBe(T0);
    expect(idTime('20261124T140205123Z-2')).toBe(T0);
    expect(ID_RE.test('20261124T140205123Z')).toBe(true);
    for (const bad of ['index', '..', '../x', '20261124T140205123Z.funscript', '20261124T140205123Z/..', 'C:\\x']) {
      expect(ID_RE.test(bad)).toBe(false);
    }
  });

  it('counts the main axis points; a file that is not a funscript has none', () => {
    expect(countPoints(Buffer.from(script(7)))).toBe(7);
    expect(countPoints(Buffer.from(`\uFEFF${script(3)}`))).toBe(3);
    expect(countPoints(Buffer.from('{broken'))).toBeNull();
    expect(countPoints(Buffer.from('{"axes":[]}'))).toBeNull();
  });
});

describe('backupBeforeWrite', () => {
  it('the first overwrite in a session keeps the old version byte for byte, with an index', async () => {
    const file = path.join(lib, 'Clip.funscript');
    const original = `\uFEFF${script(5)}`; // a BOM from another tool stays in the copy
    fs.writeFileSync(file, original, 'utf-8');

    const r = await write(backups, file, script(6));
    expect(r).toEqual({ backedUp: true, id: '20261124T140205123Z' });
    expect(fs.readFileSync(file, 'utf8')).toBe(script(6));

    const [key] = folders();
    const dir = path.join(root(), key);
    expect(fs.readFileSync(path.join(dir, '20261124T140205123Z.funscript'), 'utf8')).toBe(original);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    expect(index).toEqual({
      path: file,
      entries: [{ id: '20261124T140205123Z', at: T0, size: Buffer.byteLength(original), points: 5 }],
    });
    expect(warnings).toEqual([]);
  });

  it('writes nothing next to the script: the library folder holds only the script', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    await write(backups, file, script(2));
    clock += CHECKPOINT_MS;
    await write(backups, file, script(3));
    expect(fs.readdirSync(lib)).toEqual(['Clip.funscript']);
  });

  it('a new script (nothing on disk yet) and an unchanged one keep nothing', async () => {
    const file = path.join(lib, 'New.funscript');
    expect(await write(backups, file, script(1))).toMatchObject({ backedUp: false, reason: 'absent' });
    expect(folders()).toEqual([]);
    // Same bytes again: nothing is overwritten, nothing kept, and the session
    // has not had its first overwrite yet.
    expect(await write(backups, file, script(1))).toMatchObject({ backedUp: false, reason: 'unchanged' });
    expect(folders()).toEqual([]);
    expect(await write(backups, file, script(2))).toMatchObject({ backedUp: true });
  });

  it('autosave: after the first, one version per 10 minutes of this session', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    expect((await write(backups, file, script(2))).backedUp).toBe(true);
    // Autosave every 5 s for three minutes: no more versions.
    for (let i = 3; i < 40; i++) {
      clock += 5000;
      expect(await write(backups, file, script(i))).toMatchObject({ backedUp: false, reason: 'recent' });
    }
    clock = T0 + CHECKPOINT_MS - 1;
    expect((await write(backups, file, script(50))).backedUp).toBe(false);
    clock = T0 + CHECKPOINT_MS;
    const r = await write(backups, file, script(51));
    expect(r.backedUp).toBe(true);
    // The checkpoint is the version on disk at that moment: the last autosave's.
    const dir = path.join(root(), folders()[0]);
    expect(fs.readFileSync(path.join(dir, `${r.id}.funscript`), 'utf8')).toBe(script(50));
    expect((await backups.listBackups(file)).map((e) => e.points)).toEqual([50, 1]);
  });

  it('a new app session backs up on its first overwrite again', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    await write(backups, file, script(2));
    clock += 1000;
    expect((await write(backups, file, script(3))).backedUp).toBe(false);
    const nextLaunch = make();
    clock += 1000;
    expect((await write(nextLaunch, file, script(4))).backedUp).toBe(true);
    expect((await nextLaunch.listBackups(file)).map((e) => e.points)).toEqual([3, 1]);
  });

  it('keeps the newest 20 per script and prunes only its own backup files', async () => {
    const file = path.join(lib, 'Clip.funscript');
    const other = path.join(lib, 'Other.funscript');
    fs.writeFileSync(file, script(0));
    fs.writeFileSync(other, script(100));
    await write(backups, other, script(101));
    const otherDir = path.join(root(), backups.keyOf(other));
    const dir = path.join(root(), backups.keyOf(file));
    await fsp.mkdir(dir, { recursive: true });
    // Things in the folder that are not versions: never touched.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    fs.writeFileSync(path.join(dir, 'index.json.tmp-1-abcd'), 'half');

    for (let i = 1; i <= KEEP_PER_SCRIPT + 5; i++) {
      clock += CHECKPOINT_MS;
      await write(backups, file, script(i));
    }
    const list = await backups.listBackups(file);
    expect(list).toHaveLength(KEEP_PER_SCRIPT);
    // Newest first: the versions written before the last 20 overwrites.
    expect(list.map((e) => e.points)).toEqual(Array.from({ length: KEEP_PER_SCRIPT }, (_, i) => KEEP_PER_SCRIPT + 4 - i));
    const names = fs.readdirSync(dir);
    expect(names.filter((n) => n.endsWith('.funscript'))).toHaveLength(KEEP_PER_SCRIPT);
    expect(names).toContain('notes.txt');
    expect(names).toContain('index.json.tmp-1-abcd');
    expect(names).toContain('index.json');
    // The other script's version is untouched.
    expect(fs.readdirSync(otherDir).filter((n) => n.endsWith('.funscript'))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).entries).toHaveLength(KEEP_PER_SCRIPT);
  });

  it('two versions in the same millisecond get their own names', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    await write(backups, file, script(2));
    const relaunch = make(); // same clock: a new session at the same instant
    await write(relaunch, file, script(3));
    expect((await relaunch.listBackups(file)).map((e) => e.id).sort())
      .toEqual(['20261124T140205123Z', '20261124T140205123Z-1']);
  });

  it('autosave and Save at once: one backup, never two index writes racing', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    const results = await Promise.all([
      backups.backupBeforeWrite(file, script(2)),
      backups.backupBeforeWrite(file, script(3)),
    ]);
    expect(results.filter((r) => r.backedUp)).toHaveLength(1);
    expect(await backups.listBackups(file)).toHaveLength(1);
  });

  it('a failing backup never throws: a warning, and the write goes ahead', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    // userData is a FILE: the backup folder cannot be made.
    const blocked = path.join(tmp, 'blocked');
    fs.writeFileSync(blocked, 'x');
    const failing = make({ getUserDataDir: () => blocked });
    const r = await write(failing, file, script(2));
    expect(r).toMatchObject({ backedUp: false, reason: 'error' });
    expect(fs.readFileSync(file, 'utf8')).toBe(script(2));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Backup failed');
    // One warning a minute, not one per autosave.
    clock += 5000;
    expect(await write(failing, file, script(3))).toMatchObject({ reason: 'retry-later' });
    expect(warnings).toHaveLength(1);
  });

  it('a throwing file system and a throwing logger still resolve', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    const boom = () => { throw new Error('boom'); };
    const b = createScriptBackups({
      getUserDataDir: boom,
      log: { warn: boom },
      now: () => clock,
    });
    await expect(b.backupBeforeWrite(file, script(2))).resolves.toMatchObject({ backedUp: false });
    await expect(b.listBackups(file)).resolves.toEqual([]);
    await expect(b.readBackup(file, '20261124T140205123Z')).resolves.toBeNull();
  });

  it('only absolute .funscript paths: never a stream key, a relative path or another file type', async () => {
    const txt = path.join(lib, 'notes.txt');
    fs.writeFileSync(txt, 'a');
    for (const p of [txt, 'Clip.funscript', 'stream:abc.funscript', '', null, 42, `${lib}${path.sep}a\0.funscript`]) {
      expect(await backups.backupBeforeWrite(p, 'b')).toMatchObject({ backedUp: false, reason: 'not-a-script' });
    }
    expect(folders()).toEqual([]);
  });

  it('a script too large to keep is skipped with a warning', async () => {
    const file = path.join(lib, 'Big.funscript');
    fs.writeFileSync(file, 'x');
    const realFsp = fs.promises;
    const big = make({ fsp: { ...realFsp, stat: async (p) => ({ ...(await realFsp.stat(p)), isFile: () => true, size: 65 * 1024 * 1024 }) } });
    expect(await big.backupBeforeWrite(file, 'y')).toMatchObject({ backedUp: false, reason: 'too-large' });
    expect(warnings[0]).toContain('Not keeping a copy');
  });
});

describe('folder per script', () => {
  it('Windows: sha1 of the normalised, lower-cased path, so case and slashes do not split a script', () => {
    const b = make({ pathImpl: path.win32, platform: 'win32' });
    const sha = crypto.createHash('sha1').update('c:\\lib\\vr\\clip.funscript').digest('hex');
    expect(b.keyOf('C:\\Lib\\VR\\Clip.funscript')).toBe(sha);
    expect(b.keyOf('c:/lib/vr/CLIP.funscript')).toBe(sha);
    expect(b.keyOf('C:\\Lib\\VR\\..\\VR\\Clip.funscript')).toBe(sha);
    expect(b.keyOf('C:\\Lib\\VR\\Other.funscript')).not.toBe(sha);
  });

  it('Linux keeps the case: there those are two scripts', () => {
    const b = make({ pathImpl: path.posix, platform: 'linux' });
    expect(b.keyOf('/lib/Clip.funscript')).not.toBe(b.keyOf('/lib/clip.funscript'));
    expect(b.keyOf('/lib/x/../Clip.funscript')).toBe(b.keyOf('/lib/Clip.funscript'));
  });

  it('userData is asked on every call (portable mode moves it before anything reads it)', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    let dir = path.join(tmp, 'first');
    const b = make({ getUserDataDir: () => dir });
    dir = path.join(tmp, 'portable-data');
    await write(b, file, script(2));
    expect(fs.existsSync(path.join(tmp, 'portable-data', 'script-backups'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'first'))).toBe(false);
  });
});

describe('listBackups', () => {
  it('newest first, with time, size and points; none for a script never backed up', async () => {
    const file = path.join(lib, 'Clip.funscript');
    expect(await backups.listBackups(file)).toEqual([]);
    fs.writeFileSync(file, script(3));
    await write(backups, file, '{broken');
    clock += CHECKPOINT_MS;
    await write(backups, file, script(9));
    const list = await backups.listBackups(file);
    expect(list).toEqual([
      { id: compactIso(T0 + CHECKPOINT_MS), at: T0 + CHECKPOINT_MS, size: 7, points: null },
      { id: compactIso(T0), at: T0, size: Buffer.byteLength(script(3)), points: 3 },
    ]);
  });

  it('absence is never destructive: a lost or damaged index.json loses no version', async () => {
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, script(1));
    await write(backups, file, script(2));
    clock += CHECKPOINT_MS;
    await write(backups, file, script(3));
    const dir = path.join(root(), backups.keyOf(file));
    fs.writeFileSync(path.join(dir, 'index.json'), '{damaged');
    expect((await backups.listBackups(file)).map((e) => e.points)).toEqual([2, 1]);
    fs.rmSync(path.join(dir, 'index.json'));
    expect((await backups.listBackups(file)).map((e) => e.points)).toEqual([2, 1]);
    // A version written before a crash, with no index entry, still lists and
    // the next backup keeps it (and writes a whole index again).
    const after = make();
    clock += CHECKPOINT_MS;
    await write(after, file, script(4));
    expect((await after.listBackups(file)).map((e) => e.points)).toEqual([3, 2, 1]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).entries).toHaveLength(3);
  });
});

describe('readBackup', () => {
  let file;
  let id;
  beforeEach(async () => {
    file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, `\uFEFF${script(4)}`);
    ({ id } = await write(backups, file, script(5)));
  });

  it("one of the path's own versions, BOM stripped like read-funscript", async () => {
    expect(await backups.readBackup(file, id)).toBe(script(4));
  });

  it('never a name from elsewhere: traversal, the index, another script, a made-up id', async () => {
    const other = path.join(lib, 'Other.funscript');
    fs.writeFileSync(other, 'secret other');
    clock += 1;
    const { id: otherId } = await write(backups, other, script(1));
    const dir = path.join(root(), backups.keyOf(file));
    for (const bad of [
      '..', '../index', 'index', 'index.json', `../${backups.keyOf(other)}/${otherId}`,
      `..\\${backups.keyOf(other)}\\${otherId}`, path.join(dir, `${id}.funscript`), `${id}.funscript`,
      otherId, '20991231T235959999Z', '', null, 42, { id },
    ]) {
      expect(await backups.readBackup(file, bad)).toBeNull();
    }
    expect(await backups.readBackup(other, otherId)).toBe('secret other');
  });

  it('a path that is not a script reads nothing', async () => {
    expect(await backups.readBackup('stream:abc', id)).toBeNull();
    expect(await backups.readBackup(path.join(lib, 'Clip.txt'), id)).toBeNull();
  });
});
