// N-02 (Dave 2026-11-08): "Add variation" in the player's variation menu lost
// the script the video was playing before, so it could not be picked again.
// N-03 asks for the same check across every way a variant list starts. One
// block per starting state, each driven the same way the real-app repro drove
// it (scratchpad next-n-2026-11-16/n-repro.md):
//
//   open the video from the Library > + Add variation (first suggested name)
//   > pick every entry of the menu in turn > reload (a new Library and app
//   from what main stored) > the same checks again.
//
// Asserted: which script the engine PLAYS after each pick (each test file
// carries a `marker`), the menu's entries and its chip, and that nothing the
// user stored (associations, manual variations) changed and nothing was
// written. The repro's failing state was the association under another name
// with no sidecar: one entry, "Default", which was the NEW variation; the
// association was in no entry, and after a reload the chip named the
// variation while the association played. Two more states built "Default"
// the same way (a fuzzy-paired own script, a multi-axis association whose
// main is under another name) and are covered here too.
//
// REAL: Library (scan pass with associations, resolvePlayData,
// variantsForVideo), DataService, FunscriptEngine, Modal, and the app.js
// methods a load, an Add and a pick run (lifted). Fakes: the disk, the scan
// result, the script editor (it follows the picked script as the real one
// does, C-02) and the device starts (no device here).
//
// jsdom (no docblock): library.js and Modal import i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APP_SRC, liftMethod } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { t } = await import('../../renderer/js/i18n.js');
const { Library } = await import('../../renderer/components/library.js');
const { DataService } = await import('../../renderer/js/data-service.js');
const { FunscriptEngine } = await import('../../renderer/js/funscript-engine.js');
const { Modal } = await import('../../renderer/components/modal.js');
const { pickVariantIndexOnLoad } = await import('../../renderer/js/variant-select.js');
const { pickRehomeCandidate } = await import('../../renderer/js/association-rehome.js');
const { rankFunscriptMatches } = await import('../../renderer/js/fuzzy-match.js');
const { canonicalPath } = await import('../../renderer/js/path-utils.js');
const { planVariantAdds, pickedFiles, showBulkVariantNaming } = await import('../../renderer/js/variant-bulk-add.js');
const PLAYERWIN = await import('../../renderer/js/player-popout-protocol.js');

const LIB = 'C:\\Lib';
const SCRIPTS = `${LIB}\\scripts`;
const p = (dir, name) => `${dir}\\${name}`;

const METHODS = [
  '_loadPlayContent', 'loadFunscript', '_updateVariantSelector', '_variantLabelText',
  '_manualVariantsFor', '_planLazyRehome', '_addManualVariant', '_switchVariant',
  '_editorAllowsReplace', '_showVariantDropdown', '_applyPreferredVariant',
  '_getPreferredVariantLabel', '_setPreferredVariantLabel', '_readScriptResilient',
  '_refreshCurrentVariantsFromDisk', '_showAddVariantModal', '_addManualVariants',
  '_showManageVariantsModal', '_cycleVariant', '_streamPlayerWindowData',
];

/** The app.js methods, lifted from `src` (app.js as it is now by default). */
function liftedApp(src = APP_SRC) {
  const deps = {
    t, showToast, Modal, pickVariantIndexOnLoad, pickRehomeCandidate,
    rankFunscriptMatches, canonicalPath, planVariantAdds, pickedFiles, showBulkVariantNaming,
    PLAYERWIN,
    SOURCE_PLAYER: { LOCAL: 'local', PHONE: 'phone' },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const make = new Function(...keys,
    `return class LiftedApp {\n${METHODS.map((n) => liftMethod(src, n)).join('\n\n')}\n};`);
  return make(...keys.map((k) => deps[k]));
}

const script = (marker) => JSON.stringify({ marker, actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });

// ---- The starting states (what electron/library-scan.js answers, and what
// ---- the user stored). `expected`: the menu at the first open, in order.
const PICK1 = p(SCRIPTS, 'Browse Pick One.funscript');
const PICK2 = p(SCRIPTS, 'Browse Pick (Soft).funscript');
const PICK3 = p(SCRIPTS, 'Browse Pick Three.hard.funscript');

const STATES = [
  {
    name: 'own sidecar only',
    video: p(`${LIB}\\own`, 'Own Only.mp4'),
    scan: (v) => ({ hasFunscript: true, funscriptPath: p(`${LIB}\\own`, 'Own Only.funscript'),
      variants: [{ label: 'Default', path: p(`${LIB}\\own`, 'Own Only.funscript'), name: 'Own Only.funscript' }] }),
    expected: [p(`${LIB}\\own`, 'Own Only.funscript')],
  },
  {
    name: 'an association under another name, no sidecar (the repro\'s failing state)',
    video: p(`${LIB}\\assoc`, 'Assoc Only.mp4'),
    scan: () => ({ hasFunscript: false, funscriptPath: null, variants: [] }),
    association: { active: 'single', single: p(SCRIPTS, 'Assoc Target Name.funscript'), multi: null, custom: null },
    expected: [p(SCRIPTS, 'Assoc Target Name.funscript')],
    activeLabel: 'Assoc Target Name',
  },
  {
    name: 'an association plus the video\'s own sidecar',
    video: p(`${LIB}\\assocplus`, 'Assoc Plus.mp4'),
    scan: () => ({ hasFunscript: true, funscriptPath: p(`${LIB}\\assocplus`, 'Assoc Plus.funscript'),
      variants: [{ label: 'Default', path: p(`${LIB}\\assocplus`, 'Assoc Plus.funscript'), name: 'Assoc Plus.funscript' }] }),
    association: { active: 'single', single: p(SCRIPTS, 'Assoc Plus Other.funscript'), multi: null, custom: null },
    expected: [p(SCRIPTS, 'Assoc Plus Other.funscript'), p(`${LIB}\\assocplus`, 'Assoc Plus.funscript')],
  },
  {
    name: 'FT-102 one-video folder: own sidecar plus the folder\'s scripts',
    video: p(`${LIB}\\folder`, 'Folder Clip.mp4'),
    scan: () => ({ hasFunscript: true, funscriptPath: p(`${LIB}\\folder`, 'Folder Clip.funscript'),
      variants: [
        { label: 'Default', path: p(`${LIB}\\folder`, 'Folder Clip.funscript'), name: 'Folder Clip.funscript' },
        { label: 'Alt Take', path: p(`${LIB}\\folder`, 'Alt Take.funscript'), name: 'Alt Take.funscript' },
        { label: 'Slow Version', path: p(`${LIB}\\folder`, 'Slow Version.funscript'), name: 'Slow Version.funscript' },
      ] }),
    expected: [p(`${LIB}\\folder`, 'Folder Clip.funscript'), p(`${LIB}\\folder`, 'Alt Take.funscript'), p(`${LIB}\\folder`, 'Slow Version.funscript')],
  },
  {
    name: 'FT-102 folder main, no script of its own',
    video: p(`${LIB}\\folder2`, 'Folder NoOwn.mp4'),
    scan: () => ({ hasFunscript: true, funscriptPath: p(`${LIB}\\folder2`, 'Round 1.funscript'), _folderVariantMain: true,
      variants: [
        { label: 'Round 1', path: p(`${LIB}\\folder2`, 'Round 1.funscript'), name: 'Round 1.funscript' },
        { label: 'Round 2', path: p(`${LIB}\\folder2`, 'Round 2.funscript'), name: 'Round 2.funscript' },
      ] }),
    expected: [p(`${LIB}\\folder2`, 'Round 1.funscript'), p(`${LIB}\\folder2`, 'Round 2.funscript')],
  },
  {
    name: 'a multi-axis main (its own sidecar plus a twist file)',
    video: p(`${LIB}\\multi`, 'Companion Clip.mp4'),
    scan: () => ({ hasFunscript: true, funscriptPath: p(`${LIB}\\multi`, 'Companion Clip.funscript'),
      variants: [{ label: 'Default', path: p(`${LIB}\\multi`, 'Companion Clip.funscript'), name: 'Companion Clip.funscript' }] }),
    association: { active: 'multi', single: null, custom: null,
      multi: { main: p(`${LIB}\\multi`, 'Companion Clip.funscript'), axes: { twist: p(`${LIB}\\multi`, 'Companion Clip.twist.funscript') } } },
    expected: [p(`${LIB}\\multi`, 'Companion Clip.funscript')],
    axes: true,
  },
  {
    name: 'a fuzzy-paired own script, no association (the scan gives it no list)',
    video: p(`${LIB}\\fuzzy`, 'Fuzzy Scene.mp4'),
    scan: () => ({ hasFunscript: true, funscriptPath: p(`${LIB}\\fuzzy`, 'Fuzzy Scene HD.funscript'), _fuzzyMatched: true, variants: [] }),
    expected: [p(`${LIB}\\fuzzy`, 'Fuzzy Scene HD.funscript')],
  },
  {
    name: 'a multi-axis association whose main is under another name, no sidecar',
    video: p(`${LIB}\\multi2`, 'Multi Other.mp4'),
    scan: () => ({ hasFunscript: false, funscriptPath: null, variants: [] }),
    association: { active: 'multi', single: null, custom: null,
      multi: { main: p(SCRIPTS, 'Multi Other Main.funscript'), axes: { twist: p(SCRIPTS, 'Multi Other Main.twist.funscript') } } },
    expected: [p(SCRIPTS, 'Multi Other Main.funscript')],
    axes: true,
  },
];

// ---- The disk, main's stored config, the scan --------------------------
let files;
let stored;
let writes;

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ||= {});
  o[keys[keys.length - 1]] = value;
}

function scanResult() {
  const videos = STATES.map((s) => ({ name: s.video.split('\\').pop(), path: s.video, ...s.scan() }));
  videos.push({ name: 'No Script.mp4', path: p(`${LIB}\\none`, 'No Script.mp4'), hasFunscript: false, funscriptPath: null, variants: [] });
  return {
    videos,
    unmatchedFunscripts: [],
    allFunscripts: [...files.keys()].map((f) => ({ name: f.split('\\').pop(), path: f })),
    failedPaths: [],
    skippedPaths: [],
  };
}

beforeEach(() => {
  showToast.mockClear();
  document.body.innerHTML = `
    <div id="variant-selector" hidden>
      <button id="variant-btn"><span id="variant-btn-label"></span></button>
      <div id="variant-dropdown" hidden></div>
    </div>`;
  files = new Map();
  for (const s of STATES) {
    for (const f of s.expected) files.set(f, script(f));
    const a = s.association;
    if (a?.single) files.set(a.single, script(a.single));
    if (a?.multi) {
      files.set(a.multi.main, script(a.multi.main));
      for (const f of Object.values(a.multi.axes)) files.set(f, script(f));
    }
  }
  files.set(PICK1, script(PICK1));
  files.set(PICK2, script(PICK2));
  files.set(PICK3, script(PICK3));
  stored = {
    library: {
      sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }],
      associations: Object.fromEntries(STATES.filter((s) => s.association).map((s) => [s.video, s.association])),
    },
  };
  writes = [];
  window.funsync = {
    setSetting: vi.fn((k, v) => setPath(stored, k, structuredClone(v))),
    scanDirectory: vi.fn(async () => scanResult()),
    readFunscript: vi.fn(async (f) => files.get(f) ?? null),
    filesExist: vi.fn(async (list) => list.map((f) => files.has(f) || f === LIB || f === SCRIPTS)),
    fileExists: vi.fn(async (f) => files.has(f)),
    convertFunscript: vi.fn(async () => null),
    writeFunscript: vi.fn(async (json, f) => { writes.push(f); return f; }),
    saveFunscript: vi.fn(async (...a) => { writes.push(a); return null; }),
  };
});

afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  delete window.funsync;
  document.body.innerHTML = '';
});

// ---- The app's start (a reload or a relaunch is another one) -------------
async function boot(App = liftedApp()) {
  const ds = new DataService();
  ds._cache.settings = structuredClone(stored);
  ds._initialized = true;
  const lib = new Library({ settings: ds });
  lib._registerWithBackend = () => {};
  lib._applyFilters = () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._precomputeDurationsInBackground = async () => {};
  await lib.ensureScanned({ forceRescan: true });

  const app = new App();
  const editor = {
    // Mirrors ScriptEditor: setFunscriptPath points it at a file, loadScript
    // reads that file; nothing is unsaved, so a replace is never asked.
    _funscriptPath: null, isOpen: false, _unsavedPrompt: null, loadedFrom: null,
    setFunscriptPath(f) { this._funscriptPath = f; },
    loadScript() { this.loadedFrom = this._funscriptPath; },
    confirmBeforeReplace: () => true,
  };
  Object.assign(app, {
    settings: ds,
    library: lib,
    funscriptEngine: new FunscriptEngine({ backendPort: 5123 }),
    scriptEditor: editor,
    videoPlayer: { video: { paused: true, play: async () => {}, pause() {} }, duration: NaN },
    progressBar: null,
    _videoLoadGen: 0,
    _pendingFunscripts: [],
    _autoAdvancing: false,
    _customRoutingActive: false,
    handyManager: null, autoblowManager: null, autoblowSync: null, buttplugSync: null,
    tcodeSync: null, remoteBridge: null, audienceBridge: null, handyHdspSync: null,
    _axisLoads: [],
    _loadMultiAxisScripts(cfg) { this._axisLoads.push(Object.values(cfg.axes)); },
    _loadCustomRouting: async () => {},
    _loadSubtitleFromLibrary() {},
    _feedEmbeddedMultiAxis() {},
    _showFunscriptBadge() {},
    _refreshEditorScriptList() {},
    _isDeviceOnMainRoute: () => false,
    _uploadAndStartSync: async () => {},
    _tryStartButtplugSync() {},
    _tryStartTCodeSync() {},
    _tryStartAutoblowSync: async () => {},
    _startGapSkip() {},
    _formatActionsDuration: () => '0:01',
    _healManualVariantPath() {},
    _pruneStaleManualVariant: async () => {},
  });
  return { app, lib };
}

/** A library click on `videoPath`: what loadVideo resets, then _loadPlayContent. */
async function open(app, lib, videoPath) {
  app._videoLoadGen += 1;
  app.funscriptEngine.clear();
  app._currentVariants = [];
  app._allVariantsWithManual = [];
  app._activeVariantIndex = 0;
  app._activeVariantPath = null;
  app._variantsPhoneEpoch = null;
  app._engineHeldByRemote = false;
  app.scriptEditor._funscriptPath = null;
  const video = lib.getVideoByPath(videoPath);
  app._currentVideoPath = videoPath;
  app._currentVideoName = video.name;
  const { funscriptData, subtitleData, variants } = await lib.resolvePlayData(video);
  await app._loadPlayContent({ path: videoPath, name: video.name }, funscriptData, subtitleData, variants);
  if (funscriptData?.textContent) await vi.waitFor(() => expect(app.funscriptEngine.isLoaded).toBe(true));
}

const playing = (app) => JSON.parse(app.funscriptEngine.getRawContent()).marker;
const entries = (app) => (app._allVariantsWithManual || []).map((v) => v.path);
const chip = () => document.getElementById('variant-btn-label').textContent;

/** + Add variation: the file, then the first suggested name in the naming dialog. */
async function add(app, path) {
  const done = app._addManualVariant(path, path.split('\\').pop());
  await vi.waitFor(() => expect(document.querySelector('.modal-overlay .modal-body .library__assoc-save-btn')).not.toBeNull());
  document.querySelector('.modal-overlay .modal-body .library__assoc-save-btn').click();
  await done;
  await vi.waitFor(() => expect(playing(app)).toBe(path));
}

/** Click the menu's entry `i` and wait for its script to play. */
async function pickFromMenu(app, i) {
  app._showVariantDropdown();
  const items = [...document.querySelectorAll('#variant-dropdown .variant-selector__item')];
  expect(items).toHaveLength(entries(app).length);
  const want = entries(app)[i];
  items[i].click();
  await vi.waitFor(() => expect(playing(app)).toBe(want));
  expect(app._activeVariantIndex).toBe(i);
  expect(chip()).toBe(app._variantLabelText(app._allVariantsWithManual[i]));
}

async function everyEntryPlays(app) {
  const list = entries(app);
  // Last to first, then back to the first: every entry is reachable from
  // every other, the one the video opened on included.
  for (let i = list.length - 1; i >= 0; i--) {
    if (i === app._activeVariantIndex) continue;
    await pickFromMenu(app, i);
  }
  if (app._activeVariantIndex !== list.length - 1 && list.length > 1) await pickFromMenu(app, list.length - 1);
  if (list.length > 1) await pickFromMenu(app, 0);
}

describe.each(STATES)('N-02 / N-03 variant menu: $name', (state) => {
  it('opens on its own script, with the menu the scan and the user give it', async () => {
    const { app, lib } = await boot();
    await open(app, lib, state.video);
    expect(entries(app)).toEqual(state.expected);
    expect(playing(app)).toBe(state.expected[0]);
    expect(app._activeVariantIndex).toBe(0);
    if (state.activeLabel) expect(chip()).toBe(state.activeLabel);
    if (state.axes) expect(app._axisLoads).toHaveLength(1);
  });

  it('after + Add variation every earlier script can still be picked, and the new one too', async () => {
    const { app, lib } = await boot();
    await open(app, lib, state.video);
    const assocBefore = structuredClone(stored.library.associations);

    await add(app, PICK1);
    expect(entries(app)).toEqual([...state.expected, PICK1]);
    expect(chip()).toBe('Browse Pick One');
    await everyEntryPlays(app);

    // A second Add, made while the video's own first entry plays.
    await add(app, PICK2);
    expect(entries(app)).toEqual([...state.expected, PICK1, PICK2]);
    await everyEntryPlays(app);

    // Add only appended to the manual list; nothing else stored changed,
    // and no script file was written.
    expect(stored.library.associations).toEqual(assocBefore);
    expect(stored.library.manualVariants[state.video].map((v) => v.path)).toEqual([PICK1, PICK2]);
    expect(writes).toEqual([]);
  });

  it('after a reload (and a relaunch) the video opens on its own script, its chip says so, and every entry plays', async () => {
    {
      const { app, lib } = await boot();
      await open(app, lib, state.video);
      await add(app, PICK1);
    }
    // View > Reload / a relaunch: a new Library and app from what main stored.
    const { app, lib } = await boot();
    await open(app, lib, state.video);
    expect(entries(app)).toEqual([...state.expected, PICK1]);
    expect(playing(app)).toBe(state.expected[0]);
    expect(app._activeVariantIndex).toBe(0);
    expect(chip()).toBe(app._variantLabelText(app._allVariantsWithManual[0]));
    expect(chip()).not.toBe('Browse Pick One');
    // The menu's refresh from disk on opening it keeps the same entries.
    await app._refreshCurrentVariantsFromDisk();
    expect(entries(app)).toEqual([...state.expected, PICK1]);
    await everyEntryPlays(app);
  });
});

// N-04 (Dave 2026-11-08: "one at a time is annoying"): Browse... in + Add
// variation takes several files, named in ONE step; a file already in the
// list, or picked twice, is skipped and the dialog says so.
describe('N-04: + Add variation > Browse... with several files', () => {
  const overlays = () => [...document.querySelectorAll('.modal-overlay')];
  const top = () => overlays().at(-1);

  async function browse(app, picked) {
    window.funsync.selectFunscript = vi.fn(async () => picked);
    const done = app._showAddVariantModal();
    await vi.waitFor(() => expect(top()?.querySelector('.library__assoc-action')).toBeTruthy());
    top().querySelector('.library__assoc-action').click();
    return done;
  }

  it('one naming step names them all; duplicates are skipped with a note; each new one plays', async () => {
    const own = STATES[0];
    const { app, lib } = await boot();
    await open(app, lib, own.video);
    const done = browse(app, [
      { name: 'Browse Pick One.funscript', path: PICK1 },
      { name: 'Own Only.funscript', path: own.expected[0] },          // already the video's script
      { name: 'Browse Pick (Soft).funscript', path: PICK2 },
      { name: 'Browse Pick One.funscript', path: PICK1.replace(/\\/g, '/').replace('C:', 'c:') }, // picked twice
      { name: 'Browse Pick Three.hard.funscript', path: PICK3 },
    ]);
    await vi.waitFor(() => expect(top()?.querySelector('.variant-bulk__list')).toBeTruthy());
    expect(window.funsync.selectFunscript).toHaveBeenCalledWith({ multiple: true });

    const dialog = top();
    expect(overlays()).toHaveLength(1); // one step, not a dialog per file
    const rows = [...dialog.querySelectorAll('.variant-bulk__row')];
    expect(rows.map((r) => r.querySelector('.variant-bulk__file').textContent))
      .toEqual(['Browse Pick One.funscript', 'Browse Pick (Soft).funscript', 'Browse Pick Three.hard.funscript']);
    // The existing suggestion rules, best first: (paren), .dot, the name.
    expect(rows.map((r) => r.querySelector('input').value)).toEqual(['Browse Pick One', 'Soft', 'hard']);
    expect([...rows[2].querySelectorAll('.variant-bulk__chip')].map((c) => c.textContent))
      .toEqual(['hard', 'Browse Pick Three.hard']);
    const note = dialog.querySelector('.variant-bulk__skipped').textContent;
    expect(note).toBe(t('variants.bulkSkipped', { count: 2, names: 'Own Only.funscript, Browse Pick One.funscript' }));

    // Edited: one typed, one from its chip.
    rows[0].querySelector('input').value = '  Long Strokes ';
    rows[2].querySelector('.variant-bulk__chip:last-child').click();
    dialog.querySelector('.variant-bulk__add').click();
    await done;

    expect(stored.library.manualVariants[own.video]).toEqual([
      { label: 'Long Strokes', path: PICK1, name: 'Browse Pick One.funscript' },
      { label: 'Soft', path: PICK2, name: 'Browse Pick (Soft).funscript' },
      { label: 'Browse Pick Three.hard', path: PICK3, name: 'Browse Pick Three.hard.funscript' },
    ]);
    expect(entries(app)).toEqual([...own.expected, PICK1, PICK2, PICK3]);
    await vi.waitFor(() => expect(playing(app)).toBe(PICK1));
    expect(chip()).toBe('Long Strokes');
    await everyEntryPlays(app);
    expect(writes).toEqual([]);
  });

  // verify-1 (2026-11-16, cosmetic, new): a last row with one suggestion has
  // no chip row, and Cancel / "Add 2" sat right against its input (German, 2
  // files). The buttons keep a one-field prompt's gap whatever the last row
  // ends in. jsdom computes no layout, so this reads the margin the app's
  // own stylesheet gives the buttons.
  it('the buttons keep a gap below the last row, with or without its suggestions', async () => {
    const style = document.createElement('style');
    style.textContent = (await import('node:fs')).readFileSync('renderer/styles/library.css', 'utf8');
    document.head.appendChild(style);
    try {
      const { app, lib } = await boot();
      await open(app, lib, STATES[1].video);
      // The last file has one suggestion (its name), so no chip row.
      const done = browse(app, [{ name: 'Browse Pick (Soft).funscript', path: PICK2 }, { name: 'Browse Pick One.funscript', path: PICK1 }]);
      await vi.waitFor(() => expect(top()?.querySelector('.variant-bulk__list')).toBeTruthy());
      const rows = [...top().querySelectorAll('.variant-bulk__row')];
      expect(rows.at(-1).querySelector('.variant-bulk__chips')).toBeNull();
      const actions = top().querySelector('.variant-bulk__list + .modal-actions');
      expect(actions).not.toBeNull();
      expect(getComputedStyle(actions).marginTop).toBe('16px');
      top().querySelector('.modal-btn--secondary').click();
      await done;
    } finally {
      style.remove();
    }
  });

  it('Cancel stores nothing and changes nothing that plays', async () => {
    const { app, lib } = await boot();
    await open(app, lib, STATES[1].video);
    const done = browse(app, [{ name: 'a', path: PICK1 }, { name: 'b', path: PICK2 }]);
    await vi.waitFor(() => expect(top()?.querySelector('.variant-bulk__list')).toBeTruthy());
    top().querySelector('.modal-btn--secondary').click();
    await done;
    expect(stored.library.manualVariants).toBeUndefined();
    expect(entries(app)).toEqual(STATES[1].expected);
    expect(playing(app)).toBe(STATES[1].expected[0]);
  });

  it('one file still gets the one-file naming dialog; one already listed is not added again but played', async () => {
    const { app, lib } = await boot();
    await open(app, lib, STATES[3].video);
    const done = browse(app, [{ name: 'Browse Pick One.funscript', path: PICK1 }]);
    await vi.waitFor(() => expect(top()?.querySelector('.modal-input:not(.variant-bulk__input)')).toBeTruthy());
    expect(top().querySelector('.variant-bulk__list')).toBeNull();
    top().querySelector('.modal-body .library__assoc-save-btn').click();
    await done;
    await vi.waitFor(() => expect(playing(app)).toBe(PICK1));

    // The folder's own "Slow Version", picked again from Browse.
    const slow = STATES[3].expected[2];
    showToast.mockClear();
    await browse(app, [{ name: 'Slow Version.funscript', path: slow }]);
    await vi.waitFor(() => expect(playing(app)).toBe(slow));
    expect(showToast).toHaveBeenCalledWith(t('variants.alreadyListed', { count: 1, names: 'Slow Version.funscript' }), 'info', 4000);
    expect(stored.library.manualVariants[STATES[3].video].map((v) => v.path)).toEqual([PICK1]);
    expect(entries(app)).toEqual([...STATES[3].expected, PICK1]);
  });

  it('the Associate dialog\'s + Add Variation takes several files the same way', async () => {
    const { app, lib } = await boot();
    const video = lib.getVideoByPath(STATES[2].video);
    const done = lib._addVariantsWithNaming(video, [
      { name: 'Assoc Plus Other.funscript', path: STATES[2].association.single }, // its association
      { name: 'Browse Pick One.funscript', path: PICK1 },
      { name: 'Browse Pick (Soft).funscript', path: PICK2 },
    ]);
    await vi.waitFor(() => expect(top()?.querySelector('.variant-bulk__list')).toBeTruthy());
    expect(top().querySelector('.variant-bulk__skipped').textContent)
      .toBe(t('variants.bulkSkipped', { count: 1, names: 'Assoc Plus Other.funscript' }));
    top().querySelector('.variant-bulk__add').click();
    await done;
    expect(stored.library.manualVariants[STATES[2].video].map((v) => [v.label, v.path]))
      .toEqual([['Browse Pick One', PICK1], ['Soft', PICK2]]);
    // The player's menu then lists them after the video's own entries.
    await open(app, lib, STATES[2].video);
    expect(entries(app)).toEqual([...STATES[2].expected, PICK1, PICK2]);
  });
});

describe('N-02: the menu\'s own "Default" belongs to the video it was noted for', () => {
  it('a video with no script, opened after one whose menu had a noted "Default", gets no entry from it', async () => {
    const { app, lib } = await boot();
    const fuzzy = STATES.find((s) => s.video.includes('Fuzzy'));
    await open(app, lib, fuzzy.video);
    expect(entries(app)).toEqual(fuzzy.expected);
    await open(app, lib, p(`${LIB}\\none`, 'No Script.mp4'));
    expect(entries(app)).toEqual([]);
    expect(app.funscriptEngine.isLoaded).toBe(false);
  });
});

// verify-1 (2026-11-16, N-03; also in v0.9.2): Manage variations > ✕ on the
// variation that PLAYS left its script playing while the chip and the menu
// marked the entry that moved into its place as playing, and a click on that
// entry did nothing until another one was picked (Paren Clip: "Second Set B"
// removed, "C" marked). Driven through the real Manage dialog.
describe('N-03: Manage variations > ✕ on the variation that plays', () => {
  const top = () => [...document.querySelectorAll('.modal-overlay')].at(-1);

  async function manageRemove(app, path) {
    const name = path.split('\\').pop();
    const done = app._showManageVariantsModal();
    await vi.waitFor(() => expect(top()?.querySelector('.nav-bar__library-action--danger')).toBeTruthy());
    const row = [...top().querySelectorAll('.modal-list .modal-list-item')]
      .find((r) => r.querySelector('.modal-list-item-label')?.title === name);
    row.querySelector('.nav-bar__library-action--danger').click();
    top().querySelector('.library__assoc-save-btn').click();
    await done;
  }

  async function playingPick1BeforePick2() {
    const state = STATES[3];   // three entries of its own
    const { app, lib } = await boot();
    await open(app, lib, state.video);
    await add(app, PICK1);
    await add(app, PICK2);
    await pickFromMenu(app, state.expected.length);
    expect(playing(app)).toBe(PICK1);
    return { app, state };
  }

  it('its script plays on, no entry is marked, the chip names it, and the entry in its place plays on a click', async () => {
    const { app, state } = await playingPick1BeforePick2();
    await manageRemove(app, PICK1);

    expect(stored.library.manualVariants[state.video].map((v) => v.path)).toEqual([PICK2]);
    expect(entries(app)).toEqual([...state.expected, PICK2]);
    // Nothing switched under the user, and nothing is lost.
    expect(playing(app)).toBe(PICK1);
    expect(files.has(PICK1)).toBe(true);
    expect(writes).toEqual([]);

    // The menu and the chip say what plays.
    expect(chip(), 'the chip named the entry that moved into the removed one\'s place').toBe('Browse Pick One');
    app._showVariantDropdown();
    expect(document.querySelectorAll('#variant-dropdown .variant-selector__item--active')).toHaveLength(0);

    // The pop-out is told the same: nothing marked, and the name for its chip.
    const relays = [];
    window.funsync.playerPopoutRelay = (dir, msg) => { if (dir === 'to-popout') relays.push(msg); };
    app._playerWindowOpen = true;
    app._streamPlayerWindowData();
    app._playerWindowOpen = false;
    expect(relays.find((m) => m.type === PLAYERWIN.VARIANTS)).toMatchObject({ activeLabel: '', activeText: 'Browse Pick One' });

    // A click on the entry that took its place plays it (it did nothing).
    await pickFromMenu(app, state.expected.length);
    expect(playing(app)).toBe(PICK2);
    await everyEntryPlays(app);
  });

  it('Shift+V from there goes to the last entry', async () => {
    const { app, state } = await playingPick1BeforePick2();
    await manageRemove(app, PICK1);
    app._cycleVariant(-1);
    await vi.waitFor(() => expect(playing(app)).toBe(PICK2));
    expect(app._activeVariantIndex).toBe(state.expected.length);
  });

  it('V from there goes to the first entry', async () => {
    const { app, state } = await playingPick1BeforePick2();
    await manageRemove(app, PICK1);
    app._cycleVariant(1);
    await vi.waitFor(() => expect(playing(app)).toBe(state.expected[0]));
    expect(app._activeVariantIndex).toBe(0);
  });

  it('control: ✕ on a variation that does not play keeps the one that does marked', async () => {
    const { app, state } = await playingPick1BeforePick2();
    await manageRemove(app, PICK2);
    expect(entries(app)).toEqual([...state.expected, PICK1]);
    expect(playing(app)).toBe(PICK1);
    expect(app._activeVariantIndex).toBe(state.expected.length);
    expect(chip()).toBe('Browse Pick One');
    app._showVariantDropdown();
    const active = [...document.querySelectorAll('#variant-dropdown .variant-selector__item--active')];
    expect(active.map((i) => i.querySelector('.variant-selector__item-label').textContent)).toEqual(['Browse Pick One']);
  });
});

// Block F verify-1 (2026-11-16, FN-03, medium): a video whose only scripts
// are hand-added variations (no script of its own; the sandbox's "Manual
// Only"). After + Add variation the menu built its own first entry from the
// script the editor followed, the PLAYING variation, named it after the VIDEO
// and tagged it "main", so the variation was gone under its own name and a
// pick renamed the other one; on open the chip and menu ticked the first
// variation while nothing was loaded, and a click on it did nothing. Now the
// list is the variations, under their own names, none tagged main; the video
// opens on the first of them (or the pinned one), as the phone starts it.
describe('FN-03: a video whose only scripts are hand-added variations', () => {
  const NONE = p(`${LIB}\\none`, 'No Script.mp4');
  const labels = () => [...document.querySelectorAll('#variant-dropdown .variant-selector__item-label')].map((e) => e.textContent);
  const activeLabels = () => [...document.querySelectorAll('#variant-dropdown .variant-selector__item--active .variant-selector__item-label')].map((e) => e.textContent);
  const mainTags = () => document.querySelectorAll('#variant-dropdown .variant-selector__main-tag').length;

  async function withTwo() {
    const { app, lib } = await boot();
    await open(app, lib, NONE);
    expect(app.funscriptEngine.isLoaded).toBe(false);
    await add(app, PICK1);
    await add(app, PICK2);
    return { app, lib };
  }

  it('+ Add variation twice: both listed under their own names, the playing one marked, no "main", nothing named after the video', async () => {
    const { app } = await withTwo();
    expect(entries(app)).toEqual([PICK1, PICK2]);
    expect(playing(app)).toBe(PICK2);
    expect(app._activeVariantIndex).toBe(1);
    expect(app._mainVariantIndex).toBe(-1);
    const names = entries(app).map((_, i) => app._variantLabelText(app._allVariantsWithManual[i]));
    expect(chip()).toBe(names[1]);
    app._showVariantDropdown();
    expect(labels()).toEqual(names);
    expect(labels()).not.toContain('No Script');
    expect(activeLabels()).toEqual([names[1]]);
    expect(mainTags()).toBe(0);
  });

  it('every pick plays its own script and keeps both names (a pick renamed the other one)', async () => {
    const { app } = await withTwo();
    const names = entries(app).map((_, i) => app._variantLabelText(app._allVariantsWithManual[i]));
    await pickFromMenu(app, 0);
    expect(entries(app)).toEqual([PICK1, PICK2]);
    app._showVariantDropdown();
    expect(labels()).toEqual(names);
    expect(activeLabels()).toEqual([names[0]]);
    expect(mainTags()).toBe(0);
    await pickFromMenu(app, 1);
    expect(entries(app)).toEqual([PICK1, PICK2]);
    expect(app._mainVariantIndex).toBe(-1);
  });

  it('reopened (a reload): it opens ON the first one, so what the chip and the menu mark is what plays', async () => {
    await withTwo();
    const { app, lib } = await boot();
    await open(app, lib, NONE);
    await vi.waitFor(() => expect(playing(app)).toBe(PICK1));
    expect(entries(app)).toEqual([PICK1, PICK2]);
    expect(app._activeVariantIndex).toBe(0);
    expect(chip()).toBe(app._variantLabelText(app._allVariantsWithManual[0]));
    app._showVariantDropdown();
    expect(activeLabels()).toEqual([chip()]);
    expect(mainTags()).toBe(0);
    await pickFromMenu(app, 1);
    await pickFromMenu(app, 0);
    expect(writes).toEqual([]);
  });

  it('reopened with the second one pinned: it opens on that one', async () => {
    await withTwo();
    stored.library.preferredVariants = { [NONE]: stored.library.manualVariants[NONE][1].label };
    const { app, lib } = await boot();
    await open(app, lib, NONE);
    await vi.waitFor(() => expect(playing(app)).toBe(PICK2));
    expect(app._activeVariantIndex).toBe(1);
  });

  it('reopened with the first one\'s file unreadable: nothing is marked as playing, the chip says no script, the failure is said, and the second still plays', async () => {
    await withTwo();
    const { app, lib } = await boot();
    // The file is there (so nothing proves it gone and nothing is pruned)
    // but cannot be read now: a lock, a drive that answers slowly.
    const read = window.funsync.readFunscript;
    window.funsync.readFunscript = vi.fn(async (f) => (f === PICK1 ? null : read(f)));
    showToast.mockClear();
    await open(app, lib, NONE);
    expect(app.funscriptEngine.isLoaded).toBe(false);
    expect(app._activeVariantIndex).toBe(-1);
    expect(app._activeVariantPath).toBe(null);
    expect(chip()).toBe(t('syncChip.noScript'));
    expect(showToast).toHaveBeenCalledWith(t('toast.variantSwitchFailed'), 'error');
    app._showVariantDropdown();
    expect(activeLabels()).toEqual([]);
    await pickFromMenu(app, 1);
    expect(playing(app)).toBe(PICK2);
    expect(writes).toEqual([]);
  });

  it('with nothing loaded (routing in charge, so no auto-open): no entry is marked, the chip says so, and the first one plays on a click', async () => {
    await withTwo();
    const { app, lib } = await boot();
    app._customRoutingActive = true;
    await open(app, lib, NONE);
    expect(app.funscriptEngine.isLoaded).toBe(false);
    expect(app._activeVariantIndex).toBe(-1);
    expect(chip()).toBe(t('syncChip.noScript'));
    app._showVariantDropdown();
    expect(activeLabels()).toEqual([]);
    await pickFromMenu(app, 0);
    expect(playing(app)).toBe(PICK1);
  });
});
