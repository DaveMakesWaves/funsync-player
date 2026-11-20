/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Associate Funscript dialog, the REAL search
 * modal and the REAL Modal build their dialogs in the document, and i18n.js
 * branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Associate Funscript's EroScripts search, round 4:
//
// R4-07 (new since v0.9.2): it never asked the editor's unsaved-changes
// question. Opened on the open video with unsaved edits (autosave off),
// Replace binned the old <video>.funscript and wrote the download while the
// editor kept its edits under that path and the engine the old script; the
// next Ctrl+S wrote the edits over the download. Now the order is the
// panel's (R3-03): look, "Replace?", then the editor's question when the
// editor holds a file the set writes or the set is for the open video, then
// the write; Cancel anywhere changes nothing; afterwards the engine and the
// editor load what was written.
// R4-08: an axis whose LOOK failed was dropped with no word, and its old
// <video>.<axis>.funscript stayed beside the new main. Now a warn toast.
// R4-09: after a Cancel the bytes the look fetched waited in main for 5 min.
// R4-10: a download whose bytes equal the file already there wrote nothing
// and the panel said "Script saved: <name>". Now "Already up to date".
//
// What runs for real: Library._associateFunscript (the Associate dialog and
// its "Search EroScripts" row), showEroScriptsSearchModal, the Replace
// question, EroScriptsPanel._downloadAttachment, the app.js hooks
// (_confirmBeforeAssociateDownload, _onAssociateDownloadWritten,
// _editorAllowsReplace, lifted), main.js's eroscripts-download and
// eroscripts-forget-download handlers (lifted) and EroScriptsAPI over a real
// scratch folder in os.tmpdir(). Stand-ins: the forum (search / topic), fetch,
// shell.trashItem (moves into a scratch bin) and the editor, which keeps the
// real one's contract: Save writes its file as Ctrl+S does, Don't save goes
// back to the file on disk (clean), Cancel keeps the edits and says no.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liftMainHandler } from './helpers/main-handlers.js';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { showEroScriptsSearchModal } = await import('../../renderer/components/eroscripts-inline-search.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const { Library } = await import('../../renderer/components/library.js');
const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI } = await import('../../electron/eroscripts-api.js');

// The words the user reads, pinned (the strings stage adds the new keys to
// the 8 locales).
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
Object.assign(ENX.eroscripts, {
  notDownloaded: '{name} was not saved: it could not be downloaded.',
  alreadyUpToDate: 'Already up to date: {name}',
});

const BASE = 'https://discuss.eroscripts.com/uploads/short-url';
const BYTES = {
  [`${BASE}/main.funscript`]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] }),
  [`${BASE}/roll.funscript`]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 50 }, { at: 400, pos: 70 }] }),
  [`${BASE}/pitch.funscript`]: JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 30 }, { at: 300, pos: 60 }] }),
  [`${BASE}/pack.zip`]: 'PK-not-really-a-zip',
};
const MAIN = BYTES[`${BASE}/main.funscript`];
const ATTACHMENTS = [
  { name: 'Izzy POV.funscript', url: `${BASE}/main.funscript` },
  { name: 'Izzy POV.roll.funscript', url: `${BASE}/roll.funscript` },
  { name: 'Izzy POV.pitch.funscript', url: `${BASE}/pitch.funscript` },
];
const OLD_MAIN = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 250, pos: 90 }, { at: 750, pos: 20 }] });
const EDITS = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 5 }, { at: 100, pos: 95 }, { at: 200, pos: 5 }, { at: 300, pos: 95 }] });

let dir;
let bin;
let video;
let mainFile;
let api;
let failing; // URLs whose fetch answers 404
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
  document.body.innerHTML = '<div id="app"></div><div id="player-container"></div>';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-r4-assoc-'));
  bin = path.join(dir, '$bin');
  fs.mkdirSync(bin);
  video = path.join(dir, 'Alpha Scene.mp4');
  mainFile = path.join(dir, 'Alpha Scene.funscript');
  failing = new Set();
  globalThis.fetch = vi.fn(async (url) => (failing.has(url)
    ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(BYTES[url]).buffer }));
  api = new EroScriptsAPI();
  const trashItem = async (p) => fs.renameSync(p, path.join(bin, path.basename(p)));
  const download = liftMainHandler('eroscripts-download', { eroScripts: api, shell: { trashItem }, log });
  const forget = liftMainHandler('eroscripts-forget-download', { eroScripts: api });
  window.funsync = {
    platform: 'win32',
    eroscriptsSearch: async () => ({ results: [{ id: 7, title: 'Izzy POV', tags: ['multi-axis'] }] }),
    eroscriptsTopic: async () => ({ attachments: ATTACHMENTS }),
    eroscriptsTopicImage: async () => null,
    eroscriptsDownload: vi.fn((url, p, opts) => download(null, url, p, opts)),
    eroscriptsForgetDownload: vi.fn((url) => forget(null, url)),
    readFunscript: async (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
  };
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (let i = 0; i < 4; i++) {
    for (const o of document.querySelectorAll('.modal-overlay')) o.querySelector('.modal-close-btn')?.click();
    await new Promise((r) => setTimeout(r, 0));
  }
  delete window.funsync;
  delete window.app;
  document.body.innerHTML = '';
  fs.rmSync(dir, { recursive: true, force: true });
});

const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const titled = (prefix) => overlays().find((d) => d.querySelector('.modal-title')?.textContent.startsWith(prefix)) || null;
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const inBin = () => fs.readdirSync(bin).map((n) => fs.readFileSync(path.join(bin, n), 'utf8'));
const writeCalls = () => window.funsync.eroscriptsDownload.mock.calls.filter(([, , o]) => !o?.checkOnly);
const toasts = () => showToast.mock.calls.map(([text, kind]) => ({ text, kind }));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function answerReplace(yes) {
  await vi.waitFor(() => expect(titled('Replace ')).not.toBeNull());
  titled('Replace ').querySelector(yes ? '.modal-btn--danger' : '.modal-btn--secondary').click();
}

/** The editor, keeping the real one's contract (see the file header). */
function makeEditor({ path: p = null, text = null, dirty = false } = {}) {
  const ed = {
    _funscriptPath: p,
    _unsavedPrompt: null,
    text,
    dirty,
    asked: 0,
    _answer: null,
    confirmBeforeReplace() {
      if (!ed.dirty) return true;
      if (ed._unsavedPrompt) return false;
      ed.asked++;
      ed._unsavedPrompt = new Promise((resolve) => { ed._answer = resolve; });
      return ed._unsavedPrompt.then((choice) => {
        ed._unsavedPrompt = null;
        if (choice === 'save') {
          fs.writeFileSync(ed._funscriptPath, ed.text); // exactly what Ctrl+S writes
          ed.dirty = false;
          return true;
        }
        if (choice === 'discard') {
          ed.text = read(ed._funscriptPath);
          ed.dirty = false;
          return true;
        }
        return false;
      });
    },
    async answer(choice) {
      await vi.waitFor(() => expect(ed._answer).toBeTruthy());
      const go = ed._answer;
      ed._answer = null;
      go(choice);
    },
  };
  return ed;
}

/** The app with a video open, the REAL hooks lifted from app.js. */
function makeApp({ openVideo, editor }) {
  const App = liftAppClass(
    ['_editorAllowsReplace', '_confirmBeforeAssociateDownload', '_onAssociateDownloadWritten'],
    { showToast, t },
  );
  const app = new App();
  Object.assign(app, {
    _currentVideoName: path.basename(openVideo),
    _currentVideoPath: openVideo,
    _currentFunscriptPath: editor._funscriptPath,
    _autoAdvancing: false,
    funscriptEngine: { loaded: null },
    scriptEditor: editor,
    loads: [],
  });
  // What the real loadFunscript does that matters here: the engine and the
  // editor take the file, clean, under its path.
  app.loadFunscript = vi.fn(async (file) => {
    app.loads.push({ path: file.path, text: file.textContent });
    app._currentFunscriptPath = file.path;
    app.funscriptEngine.loaded = file.textContent;
    Object.assign(editor, { _funscriptPath: file.path, text: file.textContent, dirty: false });
  });
  return app;
}

/** A REAL Library holding the one video, wired to the app as app.js wires it. */
function makeLibrary(app, store) {
  const lib = new Library({ settings: { get: (k) => store[k], set: (k, v) => { store[k] = structuredClone(v); } } });
  const hasMain = fs.existsSync(mainFile);
  lib._videos = [{ name: 'Alpha Scene.mp4', path: video, hasFunscript: hasMain, funscriptPath: hasMain ? mainFile : null, variants: [] }];
  lib._videosByPath = new Map(lib._videos.map((v) => [v.path, v]));
  lib._allFunscripts = hasMain ? [{ name: 'Alpha Scene.funscript', path: mainFile }] : [];
  lib._unmatchedFunscripts = [];
  lib._detectEmbeddedAxesForPath = async () => null;
  lib._applyFilters = () => {};
  lib._loadSpeedStatsForVideo = () => {};
  lib.confirmBeforeEroDownload = (videoPath, savePaths) => app._confirmBeforeAssociateDownload(videoPath, savePaths);
  lib.onEroDownloadWritten = (videoPath, done) => app._onAssociateDownloadWritten(videoPath, done);
  return lib;
}

/** Associate Funscript on the video > Search EroScripts > open the post > press a button. */
async function associateThroughSearch(lib, buttonText) {
  const card = document.createElement('div');
  card.innerHTML = '<div class="library__card-thumbnail"></div>';
  const done = lib._associateFunscript(lib._videos[0], card);
  let ero;
  await vi.waitFor(() => { ero = document.querySelector('.library__assoc-action--ero'); expect(ero).toBeTruthy(); });
  ero.click();
  let head;
  await vi.waitFor(() => { head = document.querySelector('.eroscripts-inline__result-head'); expect(head).toBeTruthy(); });
  head.click();
  let btn;
  await vi.waitFor(() => {
    btn = [...document.querySelectorAll('.eroscripts-inline__group-actions button')].find((b) => b.textContent === buttonText);
    expect(btn).toBeTruthy();
  });
  btn.click();
  return { done, btn };
}
const MAIN_ONLY = 'Main only';

describe('R4-07: Associate Funscript\'s EroScripts search asks the editor before it writes', () => {
  it('Replace, then the editor\'s question; nothing is written while it is up, and Cancel there changes nothing', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const editor = makeEditor({ path: mainFile, text: EDITS, dirty: true });
    const app = makeApp({ openVideo: video, editor });
    const store = { 'library.associations': {} };
    const lib = makeLibrary(app, store);
    const { btn } = await associateThroughSearch(lib, MAIN_ONLY);
    await answerReplace(true);
    await vi.waitFor(() => expect(editor.asked).toBe(1));
    expect(read(mainFile)).toBe(OLD_MAIN);
    expect(writeCalls()).toEqual([]);
    await editor.answer('cancel');
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    await settle();
    expect(read(mainFile)).toBe(OLD_MAIN);
    expect(inBin()).toEqual([]);
    expect(writeCalls()).toEqual([]);
    expect(editor).toMatchObject({ dirty: true, text: EDITS, _funscriptPath: mainFile });
    expect(app.loadFunscript).not.toHaveBeenCalled();
    expect(store['library.associations']).toEqual({});
    expect(showToast).not.toHaveBeenCalled();
    // R4-09: the look's bytes were let go.
    expect(api._fetched.size).toBe(0);
  });

  it('Cancel at "Replace?" never reaches the editor\'s question', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const editor = makeEditor({ path: mainFile, text: EDITS, dirty: true });
    const lib = makeLibrary(makeApp({ openVideo: video, editor }), { 'library.associations': {} });
    const { btn } = await associateThroughSearch(lib, MAIN_ONLY);
    await answerReplace(false);
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    await settle();
    expect(editor.asked).toBe(0);
    expect(read(mainFile)).toBe(OLD_MAIN);
    expect(api._fetched.size).toBe(0);
  });

  it('Don\'t save: the old file goes to the bin, the download is written and the engine and the editor load it', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const editor = makeEditor({ path: mainFile, text: EDITS, dirty: true });
    const app = makeApp({ openVideo: video, editor });
    const store = { 'library.associations': {} };
    const lib = makeLibrary(app, store);
    await associateThroughSearch(lib, MAIN_ONLY);
    await answerReplace(true);
    await editor.answer('discard');
    await vi.waitFor(() => expect(app.loadFunscript).toHaveBeenCalled());
    expect(read(mainFile)).toBe(MAIN);
    expect(inBin()).toEqual([OLD_MAIN]);
    expect(app.loads).toEqual([{ path: mainFile, text: MAIN }]);
    expect(app.funscriptEngine.loaded).toBe(MAIN);
    expect(editor).toMatchObject({ dirty: false, text: MAIN, _funscriptPath: mainFile });
    expect(store['library.associations'][video]).toMatchObject({ active: 'single', single: mainFile });
  });

  it('Save: the edits are saved first, so the one Replace sends to the bin is the saved edits, never lost', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const editor = makeEditor({ path: mainFile, text: EDITS, dirty: true });
    const app = makeApp({ openVideo: video, editor });
    const lib = makeLibrary(app, { 'library.associations': {} });
    await associateThroughSearch(lib, MAIN_ONLY);
    await answerReplace(true);
    await editor.answer('save');
    await vi.waitFor(() => expect(app.loadFunscript).toHaveBeenCalled());
    expect(read(mainFile)).toBe(MAIN);
    expect(inBin()).toEqual([EDITS]);
    expect(app.funscriptEngine.loaded).toBe(MAIN);
  });

  it('nothing there yet, the editor holding that path: Save writes it, and it is asked about before the download replaces it', async () => {
    // An unsaved new script under <video>.funscript (no file yet).
    const editor = makeEditor({ path: mainFile, text: EDITS, dirty: true });
    const app = makeApp({ openVideo: video, editor });
    const lib = makeLibrary(app, { 'library.associations': {} });
    const { btn } = await associateThroughSearch(lib, MAIN_ONLY);
    await vi.waitFor(() => expect(editor.asked).toBe(1));
    expect(titled('Replace ')).toBeNull(); // nothing was there at the look
    await editor.answer('save');
    expect(read(mainFile)).toBe(EDITS);
    await answerReplace(false); // the file the Save wrote
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    await settle();
    expect(read(mainFile)).toBe(EDITS);
    expect(inBin()).toEqual([]);
    expect(writeCalls()).toEqual([]);
    expect(app.loadFunscript).not.toHaveBeenCalled();
  });

  it('another video, the editor on another file: no question, nothing reloaded', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const other = path.join(dir, 'Other.funscript');
    fs.writeFileSync(other, OLD_MAIN);
    const editor = makeEditor({ path: other, text: EDITS, dirty: true });
    const app = makeApp({ openVideo: path.join(dir, 'Other.mp4'), editor });
    const lib = makeLibrary(app, { 'library.associations': {} });
    const { done } = await associateThroughSearch(lib, MAIN_ONLY);
    await answerReplace(true);
    await vi.waitFor(() => expect(read(mainFile)).toBe(MAIN));
    await done;
    await settle();
    expect(editor.asked).toBe(0);
    expect(editor).toMatchObject({ dirty: true, text: EDITS });
    expect(app.loadFunscript).not.toHaveBeenCalled();
  });

  it('a clean editor on the open video: no question, and the download loads', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const editor = makeEditor({ path: mainFile, text: OLD_MAIN, dirty: false });
    const app = makeApp({ openVideo: video, editor });
    const lib = makeLibrary(app, { 'library.associations': {} });
    await associateThroughSearch(lib, MAIN_ONLY);
    await answerReplace(true);
    await vi.waitFor(() => expect(app.loadFunscript).toHaveBeenCalled());
    expect(editor.asked).toBe(0);
    expect(app.loads).toEqual([{ path: mainFile, text: MAIN }]);
  });
});

// --- the search modal on its own (no app hook) ------------------------------

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

describe('R4-08: an axis whose look failed is said, not dropped silently', () => {
  it('a warn toast names it; the rest of the set is written; its old file is left as it is', async () => {
    const pitchFile = path.join(dir, 'Alpha Scene.pitch.funscript');
    fs.writeFileSync(pitchFile, OLD_MAIN);
    failing.add(`${BASE}/pitch.funscript`);
    const { picked } = await press(ALL);
    const payload = await picked;
    expect(toasts()).toEqual([
      { text: 'Alpha Scene.pitch.funscript was not saved: it could not be downloaded.', kind: 'warn' },
    ]);
    expect(payload).toMatchObject({ mode: 'multi', main: mainFile, axes: { roll: path.join(dir, 'Alpha Scene.roll.funscript') } });
    expect(payload.axes.pitch).toBeFalsy();
    expect(read(pitchFile)).toBe(OLD_MAIN);
  });

  it('the main\'s look failing still fails the set with no write (as before)', async () => {
    failing.add(`${BASE}/main.funscript`);
    const { btn } = await press(ALL);
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(writeCalls()).toEqual([]);
    expect(toasts().map((x) => x.kind)).toEqual(['error']);
    // R4-09: the axes' fetched bytes were let go too.
    expect(api._fetched.size).toBe(0);
  });
});

describe('R4-09: a Cancel lets main drop what the look fetched', () => {
  it('Cancel at "Replace?": every looked-at URL is forgotten, nothing is held', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const { btn } = await press(ALL);
    await answerReplace(false);
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(window.funsync.eroscriptsForgetDownload.mock.calls.map(([u]) => u).sort())
      .toEqual(ATTACHMENTS.map((a) => a.url).sort());
    expect(api._fetched.size).toBe(0);
  });

  it('a set written as asked holds nothing afterwards either', async () => {
    const { picked } = await press(ALL);
    await picked;
    expect(api._fetched.size).toBe(0);
  });
});

describe('R4-10: the same bytes already there say "Already up to date", not "saved"', () => {
  it('Associate\'s search: every file unchanged, one info toast naming them; nothing written', async () => {
    for (const [p, u] of [['', 'main'], ['.roll', 'roll'], ['.pitch', 'pitch']]) {
      fs.writeFileSync(path.join(dir, `Alpha Scene${p}.funscript`), BYTES[`${BASE}/${u}.funscript`]);
    }
    const before = fs.statSync(mainFile).mtimeMs;
    const { picked } = await press(ALL);
    await picked;
    expect(toasts()).toEqual([{
      text: 'Already up to date: Alpha Scene.funscript, Alpha Scene.roll.funscript, Alpha Scene.pitch.funscript',
      kind: 'info',
    }]);
    expect(fs.statSync(mainFile).mtimeMs).toBe(before);
  });

  it('Associate\'s search: something written, no "up to date" toast', async () => {
    const { picked } = await press(ALL);
    await picked;
    expect(toasts()).toEqual([]);
  });

  function panelWithVideoOpen() {
    document.getElementById('player-container').dataset.videoPath = video;
    return Object.assign(Object.create(EroScriptsPanel.prototype), {
      _settings: { get: () => undefined },
      _setLabel() {},
      onScriptDownloaded: vi.fn(),
      confirmBeforeDownload: vi.fn(() => true),
    });
  }

  it('the panel: the same script there, "Already up to date: <name>"', async () => {
    fs.writeFileSync(mainFile, MAIN);
    const panel = panelWithVideoOpen();
    await panel._downloadAttachment({ name: 'Izzy POV.funscript', url: `${BASE}/main.funscript` }, null, null);
    expect(toasts()).toEqual([{ text: 'Already up to date: Alpha Scene.funscript', kind: 'info' }]);
    expect(inBin()).toEqual([]);
  });

  it('the panel: a .zip with the same bytes too', async () => {
    fs.writeFileSync(path.join(dir, 'Pack.zip'), BYTES[`${BASE}/pack.zip`]);
    const panel = panelWithVideoOpen();
    await panel._downloadAttachment({ name: 'Pack.zip', url: `${BASE}/pack.zip` }, null, null);
    expect(toasts()).toEqual([{ text: 'Already up to date: Pack.zip', kind: 'info' }]);
  });

  it('the panel: a real write still says "Script saved"', async () => {
    const panel = panelWithVideoOpen();
    await panel._downloadAttachment({ name: 'Izzy POV.funscript', url: `${BASE}/main.funscript` }, null, null);
    expect(toasts()).toEqual([{ text: t('eroscripts.savedToast', { name: 'Alpha Scene.funscript' }), kind: 'info' }]);
    expect(read(mainFile)).toBe(MAIN);
  });

  it('the panel: Cancel at "Replace?" lets main drop the look\'s bytes (R4-09)', async () => {
    fs.writeFileSync(mainFile, OLD_MAIN);
    const panel = panelWithVideoOpen();
    const run = panel._downloadAttachment({ name: 'Izzy POV.funscript', url: `${BASE}/main.funscript` }, null, null);
    await answerReplace(false);
    await run;
    expect(api._fetched.size).toBe(0);
    expect(read(mainFile)).toBe(OLD_MAIN);
  });
});
