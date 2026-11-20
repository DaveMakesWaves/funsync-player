/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL search modal and the REAL Modal build their
 * dialogs in the document, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// R3-02 (MAJOR, regression from round 2, unreleased): the EroScripts search
// inside Associate Funscript downloaded with no options. Since round 2 a
// download refuses to write over a different file and answers `exists`, so
// for a video that already had a script the route said "Download failed" and
// did nothing, and a different AXIS file was skipped silently while the new
// main was written: the OLD axis then paired with the NEW main by name.
//
// Now every file of the set is looked at first (nothing written), one
// "Replace?" covers every existing different file, Replace sends each to the
// Recycle Bin first, Cancel writes nothing at all, the same bytes are left
// alone, and "exists" is never reported as "Download failed".
//
// What runs for real: showEroScriptsSearchModal (search, open the post, the
// group's buttons), the shared Replace question, main.js's
// eroscripts-download handler (lifted) and EroScriptsAPI against a real
// scratch folder in os.tmpdir(). Stand-ins: the forum (search / topic
// answers), fetch and shell.trashItem (moves into a scratch "bin" folder).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liftMainHandler } from './helpers/main-handlers.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { showEroScriptsSearchModal } = await import('../../renderer/components/eroscripts-inline-search.js');
const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI } = await import('../../electron/eroscripts-api.js');

// Pinned as text; added to the locales by the strings stage.
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
Object.assign(ENX.eroscripts, {
  replaceTitle: 'Replace {name}?',
  replaceMessage: 'A different file is already saved under this name. Replace it with the download? The old file goes to the {os, select, win {Recycle Bin} other {Trash}}, so you can get it back.',
  replaceManyTitle: 'Replace {count, plural, one {# file} other {# files}}?',
  replaceManyMessage: 'Different files are already saved under these names: {names}. Replace them with the download? The old files go to the {os, select, win {Recycle Bin} other {Trash}}, so you can get them back.',
  replaceBtn: 'Replace',
  trashFailed: 'Couldn\'t move {name} to the {os, select, win {Recycle Bin} other {Trash}}, so the download was not saved over it.',
  notReplaced: '{name} was not saved: a different file is already there.',
});

const BASE = 'https://discuss.eroscripts.com/uploads/short-url';
const BYTES = {
  [`${BASE}/main.funscript`]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] }),
  [`${BASE}/roll.funscript`]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 50 }, { at: 400, pos: 70 }] }),
  [`${BASE}/pitch.funscript`]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 30 }, { at: 300, pos: 60 }] }),
};
const ATTACHMENTS = [
  { name: 'Izzy POV.funscript', url: `${BASE}/main.funscript` },
  { name: 'Izzy POV.roll.funscript', url: `${BASE}/roll.funscript` },
  { name: 'Izzy POV.pitch.funscript', url: `${BASE}/pitch.funscript` },
];
const OLD_MAIN = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 250, pos: 90 }, { at: 750, pos: 20 }] });
const OLD_ROLL = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 40 }, { at: 900, pos: 60 }, { at: 1200, pos: 50 }] });

let dir;
let bin;
let video;
let mainFile;
let rollFile;
let pitchFile;
let trashItem;
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
});

beforeEach(() => {
  _setBundlesForTests('en', ENX, ENX);
  showToast.mockClear();
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-es-inline-'));
  bin = path.join(dir, '$bin');
  fs.mkdirSync(bin);
  video = path.join(dir, 'Alpha Scene.mp4');
  mainFile = path.join(dir, 'Alpha Scene.funscript');
  rollFile = path.join(dir, 'Alpha Scene.roll.funscript');
  pitchFile = path.join(dir, 'Alpha Scene.pitch.funscript');
  globalThis.fetch = vi.fn(async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(BYTES[url]).buffer,
  }));
  trashItem = vi.fn(async (p) => fs.renameSync(p, path.join(bin, path.basename(p))));
  const api = new EroScriptsAPI();
  const download = liftMainHandler('eroscripts-download', { eroScripts: api, shell: { trashItem: (p) => trashItem(p) }, log });
  window.funsync = {
    platform: 'win32',
    eroscriptsSearch: async () => ({ results: [{ id: 7, title: 'Izzy POV', tags: ['multi-axis'] }] }),
    eroscriptsTopic: async () => ({ attachments: ATTACHMENTS }),
    eroscriptsTopicImage: async () => null,
    eroscriptsDownload: vi.fn((url, p, opts) => download(null, url, p, opts)),
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const o of document.querySelectorAll('.modal-overlay')) o.querySelector('.modal-close-btn')?.click();
  delete window.funsync;
  document.body.innerHTML = '';
  fs.rmSync(dir, { recursive: true, force: true });
});

const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const replaceDialog = () => overlays().find((d) => d.querySelector('.modal-title')?.textContent.startsWith('Replace ')) || null;
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const inBin = () => fs.readdirSync(bin).sort();
const writeCalls = () => window.funsync.eroscriptsDownload.mock.calls.filter(([, , o]) => !o?.checkOnly);

/** Open the dialog on the video, open the post, press one of its buttons. */
async function press(buttonText) {
  const picked = showEroScriptsSearchModal({ path: video, name: 'Alpha Scene.mp4' });
  let head;
  await vi.waitFor(() => { head = document.querySelector('.eroscripts-inline__result-head'); expect(head).toBeTruthy(); });
  head.click();
  let btn;
  await vi.waitFor(() => {
    btn = [...document.querySelectorAll('.eroscripts-inline__group-actions button')].find((b) => b.textContent === buttonText);
    expect(btn).toBeTruthy();
  });
  btn.click();
  return { picked, btn };
}
const ALL = 'Download all (main + 2 axes)';

describe('Associate Funscript\'s EroScripts search over files that are already there (R3-02)', () => {
  it('asks ONCE for the whole set, naming every different file; Replace bins each old file, then writes the set', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    fs.writeFileSync(rollFile, OLD_ROLL);
    const { picked } = await press(ALL);
    await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
    expect(overlays().filter((o) => o.querySelector('.modal-title')?.textContent.startsWith('Replace '))).toHaveLength(1);
    expect(replaceDialog().querySelector('.modal-title').textContent).toBe('Replace 2 files?');
    expect(replaceDialog().querySelector('.modal-message').textContent).toBe(
      'Different files are already saved under these names: Alpha Scene.funscript, Alpha Scene.roll.funscript. '
      + 'Replace them with the download? The old files go to the Recycle Bin, so you can get them back.',
    );
    // Nothing written while the question is up.
    expect(writeCalls()).toEqual([]);
    expect([read(mainFile), read(rollFile), read(pitchFile)]).toEqual([OLD_MAIN, OLD_ROLL, null]);
    replaceDialog().querySelector('.modal-btn--danger').click();
    const payload = await picked;
    expect([read(mainFile), read(rollFile), read(pitchFile)])
      .toEqual([BYTES[`${BASE}/main.funscript`], BYTES[`${BASE}/roll.funscript`], BYTES[`${BASE}/pitch.funscript`]]);
    expect(inBin()).toEqual(['Alpha Scene.funscript', 'Alpha Scene.roll.funscript']);
    expect(fs.readFileSync(path.join(bin, 'Alpha Scene.roll.funscript'), 'utf8')).toBe(OLD_ROLL);
    expect(payload).toMatchObject({ mode: 'multi', main: mainFile, axes: { roll: rollFile, pitch: pitchFile } });
    expect(showToast).not.toHaveBeenCalled();
    // One request per file: the look's bytes are reused by the write.
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('Cancel writes NOTHING, not even the axis that was not there; no "Download failed"; the search stays open', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    fs.writeFileSync(rollFile, OLD_ROLL);
    const { btn } = await press(ALL);
    await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
    replaceDialog().querySelector('.modal-btn--secondary').click();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect([read(mainFile), read(rollFile), read(pitchFile)]).toEqual([OLD_MAIN, OLD_ROLL, null]);
    expect(inBin()).toEqual([]);
    expect(writeCalls()).toEqual([]);
    expect(showToast).not.toHaveBeenCalled();
    expect(btn.textContent).toBe(ALL);
    expect(overlays()).toHaveLength(1); // the search modal, still open
  });

  it('only an AXIS differs: it is asked about too, never skipped while the new main is written', async () => {
    fs.writeFileSync(mainFile, BYTES[`${BASE}/main.funscript`]); // same bytes
    fs.writeFileSync(rollFile, OLD_ROLL);
    const { picked } = await press(ALL);
    await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
    expect(replaceDialog().querySelector('.modal-title').textContent).toBe('Replace Alpha Scene.roll.funscript?');
    replaceDialog().querySelector('.modal-btn--danger').click();
    await picked;
    expect(read(rollFile)).toBe(BYTES[`${BASE}/roll.funscript`]);
    expect(inBin()).toEqual(['Alpha Scene.roll.funscript']);
  });

  it('the same bytes everywhere: no question, nothing moved, the files left as they are', async () => {
    for (const [p, u] of [[mainFile, 'main'], [rollFile, 'roll'], [pitchFile, 'pitch']]) {
      fs.writeFileSync(p, BYTES[`${BASE}/${u}.funscript`]);
    }
    const before = fs.statSync(mainFile).mtimeMs;
    const { picked } = await press(ALL);
    const payload = await picked;
    expect(replaceDialog()).toBeNull();
    expect(inBin()).toEqual([]);
    expect(fs.statSync(mainFile).mtimeMs).toBe(before);
    expect(payload).toMatchObject({ mode: 'multi', main: mainFile });
  });

  it('Main only: only the main is looked at and asked about; the axis files are not touched', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    fs.writeFileSync(rollFile, OLD_ROLL);
    const { picked } = await press('Main only');
    await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
    expect(replaceDialog().querySelector('.modal-title').textContent).toBe('Replace Alpha Scene.funscript?');
    replaceDialog().querySelector('.modal-btn--danger').click();
    const payload = await picked;
    expect(payload).toMatchObject({ mode: 'single', path: mainFile });
    expect(read(rollFile)).toBe(OLD_ROLL);
    expect(read(pitchFile)).toBeNull();
    expect(inBin()).toEqual(['Alpha Scene.funscript']);
  });

  it('nothing there yet: no question, the whole set written', async () => {
    const { picked } = await press(ALL);
    const payload = await picked;
    expect(replaceDialog()).toBeNull();
    expect(payload).toMatchObject({ mode: 'multi', main: mainFile, axes: { roll: rollFile, pitch: pitchFile } });
  });

  it('the move to the bin fails: nothing written over the old file, and the failure is worded (not "Download failed", not the raw error)', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    trashItem = vi.fn(async () => { throw new Error('EBUSY: resource busy or locked'); });
    const { btn } = await press(ALL);
    await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
    replaceDialog().querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(read(mainFile)).toBe(OLD_MAIN);
    expect(read(rollFile)).toBeNull(); // no main written, so nothing else either
    expect(showToast.mock.calls.map(([text, kind]) => ({ text, kind }))).toEqual([{
      text: 'Couldn\'t move Alpha Scene.funscript to the Recycle Bin, so the download was not saved over it.',
      kind: 'error',
    }]);
  });
});
