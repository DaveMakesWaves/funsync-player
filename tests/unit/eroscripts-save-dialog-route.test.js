/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL EroScripts panel and the REAL Modal build their
 * dialogs in the document, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// R3-01 (MAJOR, data loss; the empty write is also in v0.9.2): the EroScripts
// panel's Save-dialog route (no video open, or several sources) picked the
// path with save-funscript('', name), and main's save-funscript writes its
// content at once: the chosen file was EMPTIED before the download started.
// Round 2's `replace: pickedInDialog` then trashed that empty file, so the
// user's script was gone for good; a failed download or a failed trash left
// 0 bytes, Linux asked no overwrite question, and a failed download to a new
// name left a 0-byte file.
//
// Now the panel picks with pick-download-save-path, which writes nothing, and
// the in-app "Replace <name>?" (old file to the Recycle Bin first) decides.
//
// Also here: R3-05 (a .zip with a video open is saved under its own name,
// never as <video>.funscript), R3-04 (the attachment name is cleaned before it
// is joined into a path) and R3-06 (a failed move to the bin is worded in the
// user's language, with the bin the platform has).
//
// What runs for real: the panel's _downloadAttachment, main.js's
// pick-download-save-path and eroscripts-download handlers (lifted), the
// EroScriptsAPI (download, look, stat, trash, write) against a real scratch
// folder in os.tmpdir() (never the user's data), and the Modal. Stand-ins:
// the OS Save dialog (returns the path a user would pick), fetch, and
// shell.trashItem (moves the file into a scratch "bin" folder).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liftMainHandler } from './helpers/main-handlers.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI } = await import('../../electron/eroscripts-api.js');

// The words as the user reads them, pinned as text so a missing key fails
// here. Added to en.json (and the other 7) by the strings stage.
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
Object.assign(ENX.eroscripts, {
  replaceTitle: 'Replace {name}?',
  replaceMessage: 'A different file is already saved under this name. Replace it with the download? The old file goes to the {os, select, win {Recycle Bin} other {Trash}}, so you can get it back.',
  replaceBtn: 'Replace',
  trashFailed: 'Couldn\'t move {name} to the {os, select, win {Recycle Bin} other {Trash}}, so the download was not saved over it.',
  unusableName: 'Can\'t save "{name}": that file name can\'t be used on this computer.',
  savedFileToast: 'Saved: {name}',
  downloadFailedStatus: 'Download failed (HTTP {status})',
});

const DOWNLOAD = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });
const MINE = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 250, pos: 90 }, { at: 750, pos: 20 }] });
const URL_A = 'https://discuss.eroscripts.com/uploads/short-url/abc.funscript';

let dir;
let bin;
let picked;       // what the OS Save dialog hands back
let dialogOpts;   // what main asked the OS dialog for
let trashItem;
let api;
let panel;
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

function wire({ platform = 'win32', sources = [] } = {}) {
  api = new EroScriptsAPI();
  const dialog = {
    showSaveDialog: vi.fn(async (_win, opts) => {
      dialogOpts = opts;
      return picked ? { canceled: false, filePath: picked } : { canceled: true };
    }),
  };
  const shell = { trashItem: (p) => trashItem(p) };
  const pick = liftMainHandler('pick-download-save-path', { dialog, mainWindow: null, path });
  const download = liftMainHandler('eroscripts-download', { eroScripts: api, shell, log });
  // The editor's Save As (writes its content at once): the panel used it to
  // pick, which is the R3-01 hole. Wired so that hole can be reopened.
  const saveAs = liftMainHandler('save-funscript', { dialog, mainWindow: null, fs, log });
  window.funsync = {
    platform,
    pickDownloadSavePath: vi.fn((name) => pick(null, name)),
    saveFunscript: vi.fn((content, name) => saveAs(null, content, name)),
    eroscriptsDownload: vi.fn((url, p, opts) => download(null, url, p, opts)),
  };
  panel = Object.assign(Object.create(EroScriptsPanel.prototype), {
    _settings: { get: (k) => (k === 'library.sources' ? sources : undefined) },
    _setLabel() {},
    onScriptDownloaded: vi.fn(),
    confirmBeforeDownload: vi.fn(() => true),
  });
}

const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const replaceDialog = () => overlays().find((d) => d.querySelector('.modal-title')?.textContent.startsWith('Replace ')) || null;
async function answerReplace(yes) {
  await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
  replaceDialog().querySelector(yes ? '.modal-btn--danger' : '.modal-btn--secondary').click();
}
const inBin = () => fs.readdirSync(bin).map((n) => fs.readFileSync(path.join(bin, n), 'utf8'));
const toasts = () => showToast.mock.calls.map(([text, kind]) => ({ text, kind }));
const writeCalls = () => window.funsync.eroscriptsDownload.mock.calls.filter(([, , o]) => !o?.checkOnly);

beforeEach(() => {
  _setBundlesForTests('en', ENX, ENX);
  showToast.mockClear();
  document.body.innerHTML = '<div id="app"></div>';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-es-dialog-'));
  bin = path.join(dir, '$bin');
  fs.mkdirSync(bin);
  picked = null;
  dialogOpts = null;
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(DOWNLOAD).buffer,
  }));
  trashItem = vi.fn(async (p) => fs.renameSync(p, path.join(bin, path.basename(p))));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete window.funsync;
  document.body.innerHTML = '';
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (name = 'alpha_v2.funscript', url = URL_A) => panel._downloadAttachment({ name, url }, null, null);

describe('the Save-dialog route writes nothing until the download is in hand (R3-01)', () => {
  it('an existing script picked in the dialog is never emptied: Replace sends it WHOLE to the Recycle Bin, then the download is written', async () => {
    wire();
    picked = path.join(dir, 'My Script.funscript');
    fs.writeFileSync(picked, MINE);
    const done = run();
    await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
    // The dialog has answered and the question is up: the file is as it was.
    expect(fs.readFileSync(picked, 'utf8')).toBe(MINE);
    expect(replaceDialog().querySelector('.modal-title').textContent).toBe('Replace My Script.funscript?');
    await answerReplace(true);
    await done;
    expect(fs.readFileSync(picked, 'utf8')).toBe(DOWNLOAD);
    expect(inBin()).toEqual([MINE]); // recoverable, and not an empty file
    expect(panel.onScriptDownloaded).toHaveBeenCalledWith(picked, 'My Script.funscript');
  });

  it('Cancel at "Replace?": the picked file is left exactly as it was', async () => {
    wire();
    picked = path.join(dir, 'My Script.funscript');
    fs.writeFileSync(picked, MINE);
    const done = run();
    await answerReplace(false);
    await done;
    expect(fs.readFileSync(picked, 'utf8')).toBe(MINE);
    expect(inBin()).toEqual([]);
    expect(writeCalls()).toEqual([]);
    expect(panel.onScriptDownloaded).not.toHaveBeenCalled();
  });

  it('a failed download over an existing file leaves it untouched (not 0 bytes), with no question', async () => {
    wire();
    picked = path.join(dir, 'My Script.funscript');
    fs.writeFileSync(picked, MINE);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    await run();
    expect(replaceDialog()).toBeNull();
    expect(fs.readFileSync(picked, 'utf8')).toBe(MINE);
    expect(inBin()).toEqual([]);
    // In the user's words (R3 fix-up): main's own English 'Download failed
    // (404)' showed in every language.
    expect(toasts()).toEqual([{ text: 'Download failed (HTTP 404)', kind: 'error' }]);
  });

  it('the failed download is worded in the user\'s language, not main\'s English (R3 fix-up)', async () => {
    const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
    _setBundlesForTests('de', DE, ENX);
    wire();
    picked = path.join(dir, 'Brand New.funscript');
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    await run();
    expect(toasts()).toEqual([{ text: DE.eroscripts.downloadFailedStatus.replace('{status}', '404'), kind: 'error' }]);
    expect(toasts()[0].text).not.toContain('Download failed');
  });

  it('a folder with the picked name: worded, not main\'s "The save path is not a file", and the folder is left alone', async () => {
    wire();
    picked = path.join(dir, 'realdir.funscript');
    fs.mkdirSync(picked);
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(DOWNLOAD) }));
    await run();
    expect(toasts()).toEqual([{ text: EN.eroscripts.saveNotAFile.replace('{name}', 'realdir.funscript'), kind: 'error' }]);
    expect(fs.statSync(picked).isDirectory()).toBe(true);
    expect(inBin()).toEqual([]);
  });

  it('a failed download to a NEW name leaves no file behind', async () => {
    wire();
    picked = path.join(dir, 'Brand New.funscript');
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await run();
    expect(fs.existsSync(picked)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['$bin']);
  });

  it('a new name: written as downloaded, no question', async () => {
    wire();
    picked = path.join(dir, 'Brand New.funscript');
    await run();
    expect(replaceDialog()).toBeNull();
    expect(fs.readFileSync(picked, 'utf8')).toBe(DOWNLOAD);
    expect(panel.onScriptDownloaded).toHaveBeenCalledWith(picked, 'Brand New.funscript');
  });

  it('a pathless (dropped) video: the editor\'s unsaved question is asked while the picked file is still whole', async () => {
    wire();
    picked = path.join(dir, 'My Script.funscript');
    fs.writeFileSync(picked, MINE);
    const seen = [];
    panel.confirmBeforeDownload = vi.fn(() => { seen.push(fs.readFileSync(picked, 'utf8')); return Promise.resolve(false); });
    const done = run();
    await answerReplace(true);
    await done;
    expect(seen).toEqual([MINE]);
    // Cancel at that question: nothing written, nothing moved.
    expect(fs.readFileSync(picked, 'utf8')).toBe(MINE);
    expect(inBin()).toEqual([]);
  });

  it('the same bytes already there: nothing asked, nothing moved, the file left as it is', async () => {
    wire();
    picked = path.join(dir, 'My Script.funscript');
    fs.writeFileSync(picked, DOWNLOAD);
    await run();
    expect(replaceDialog()).toBeNull();
    expect(inBin()).toEqual([]);
    expect(fs.readFileSync(picked, 'utf8')).toBe(DOWNLOAD);
  });

  it('the dialog only picks: it writes nothing, asks the OS for an overwrite question on Linux too, and keeps the type', async () => {
    wire();
    const pick = window.funsync.pickDownloadSavePath;
    picked = path.join(dir, 'My Script.funscript');
    fs.writeFileSync(picked, MINE);
    await expect(pick('alpha_v2.funscript')).resolves.toBe(picked);
    expect(fs.readFileSync(picked, 'utf8')).toBe(MINE);
    expect(dialogOpts.properties).toContain('showOverwriteConfirmation');
    expect(dialogOpts.defaultPath).toBe('alpha_v2.funscript');
    // GTK does not add the filter's extension to a typed name.
    picked = path.join(dir, 'typed without extension');
    await expect(pick('alpha_v2.funscript')).resolves.toBe(`${picked}.funscript`);
    expect(fs.existsSync(`${picked}.funscript`)).toBe(false);
    picked = path.join(dir, 'pack');
    await expect(pick('pack.zip')).resolves.toBe(`${picked}.zip`);
    expect(dialogOpts.filters[0].extensions).toEqual(['zip']);
    picked = null; // Cancel
    await expect(pick('alpha_v2.funscript')).resolves.toBeNull();
  });
});

describe('a .zip with a video open keeps its own name (R3-05)', () => {
  it('saved beside the video as pack.zip; the video\'s script is not touched, asked about or replaced', async () => {
    wire();
    const video = path.join(dir, 'Alpha Scene.mp4');
    const script = path.join(dir, 'Alpha Scene.funscript');
    fs.writeFileSync(script, MINE);
    document.body.insertAdjacentHTML('beforeend', '<div id="player-container"></div>');
    document.getElementById('player-container').dataset.videoPath = video;
    await run('pack.zip', 'https://discuss.eroscripts.com/uploads/short-url/pack.zip');
    expect(replaceDialog()).toBeNull();
    expect(fs.readFileSync(script, 'utf8')).toBe(MINE);
    expect(fs.readFileSync(path.join(dir, 'pack.zip'), 'utf8')).toBe(DOWNLOAD);
    expect(inBin()).toEqual([]);
    // Not the video's script: not loaded, not associated, no editor question.
    expect(panel.onScriptDownloaded).not.toHaveBeenCalled();
    expect(panel.confirmBeforeDownload).not.toHaveBeenCalled();
    expect(toasts()).toEqual([{ text: 'Saved: pack.zip', kind: 'info' }]);
  });

  it('a .funscript with a video open still becomes <video>.funscript', async () => {
    wire();
    const video = path.join(dir, 'Alpha Scene.mp4');
    document.body.insertAdjacentHTML('beforeend', '<div id="player-container"></div>');
    document.getElementById('player-container').dataset.videoPath = video;
    await run('alpha_v2.funscript');
    expect(fs.readFileSync(path.join(dir, 'Alpha Scene.funscript'), 'utf8')).toBe(DOWNLOAD);
    expect(panel.onScriptDownloaded).toHaveBeenCalledWith(path.join(dir, 'Alpha Scene.funscript'), 'Alpha Scene.funscript');
  });
});

describe('the attachment name is cleaned before it becomes a path (R3-04)', () => {
  it('"../" in the link text cannot leave the source folder', async () => {
    // Two levels deep inside the scratch folder, so even the unsafe join (the
    // hole) lands inside it and is cleaned up with it.
    const source = path.join(dir, 'a', 'b', 'library');
    fs.mkdirSync(source, { recursive: true });
    wire({ sources: [{ path: source, enabled: true }] });
    await run('../../escape.funscript');
    expect(fs.readFileSync(path.join(source, 'escape.funscript'), 'utf8')).toBe(DOWNLOAD);
    expect(fs.readdirSync(path.join(dir, 'a'))).toEqual(['b']);
    expect(fs.readdirSync(path.join(dir, 'a', 'b'))).toEqual(['library']);
  });

  it('Windows-reserved characters and names are replaced', async () => {
    const source = path.join(dir, 'library');
    fs.mkdirSync(source);
    wire({ sources: [{ path: source, enabled: true }] });
    await run('Scene: "Part 1"?.funscript');
    await run('CON.funscript');
    expect(fs.readdirSync(source).sort()).toEqual(['Scene_ _Part 1__.funscript', '_CON.funscript']);
  });

  it.each(['..', '.funscript', '../..', 'notes.txt', ' . '])('a name with nothing usable left (%j) is refused: nothing fetched or written', async (name) => {
    const source = path.join(dir, 'library');
    fs.mkdirSync(source);
    wire({ sources: [{ path: source, enabled: true }] });
    await run(name);
    expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(source)).toEqual([]);
    expect(toasts()).toEqual([{ text: `Can't save "${name}": that file name can't be used on this computer.`, kind: 'error' }]);
  });
});

describe('a failed move to the bin is worded for the user, with the bin the platform has (R3-06)', () => {
  it.each([
    ['win32', 'Recycle Bin'],
    ['linux', 'Trash'],
    ['darwin', 'Trash'],
  ])('on %s the question and the failure say "%s", never Electron\'s raw error', async (platform, word) => {
    wire({ platform });
    picked = path.join(dir, 'My Script.funscript');
    fs.writeFileSync(picked, MINE);
    trashItem = vi.fn(async () => { throw new Error('Failed to move item to trash: EPERM 0x80070005'); });
    const done = run();
    await vi.waitFor(() => expect(replaceDialog()).not.toBeNull());
    const message = replaceDialog().querySelector('.modal-message').textContent;
    expect(message).toBe(`A different file is already saved under this name. Replace it with the download? The old file goes to the ${word}, so you can get it back.`);
    await answerReplace(true);
    await done;
    expect(fs.readFileSync(picked, 'utf8')).toBe(MINE); // nothing written
    expect(toasts()).toEqual([{
      text: `Couldn't move My Script.funscript to the ${word}, so the download was not saved over it.`,
      kind: 'error',
    }]);
  });
});
