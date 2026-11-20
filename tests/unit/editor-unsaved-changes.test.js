/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Modal builds the dialog in the document, and
 * script-editor.js imports DOM-branching modules (notes/CLAUDE.md "Test
 * environments").
 */
// CB-01 (data loss, also in v0.9.2): with autosave off, unsaved editor edits
// were dropped without a word when another video opened. Verifier repro:
// Alpha Scene, editor, edit (38 points in memory, dirty), Back, open Variant
// Clip: the .funscript on disk still had 33 points and the edits were gone.
//
// Every route that replaces the script in the editor now asks first (OFS):
// "Save changes to <script>?" with Save / Don't save / Cancel, Escape =
// Cancel. What is asserted is what the user would see: whether the video
// loads, what the file on disk holds afterwards, and what the editor holds.
//
// The REAL ScriptEditor prototype runs on a minimal stand-in for its panel,
// the REAL Modal draws the dialog, and the REAL app.js routes are lifted
// (helpers/app-methods.js). Only the toast and the disk are fakes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { Library } = await import('../../renderer/components/library.js');
const { Playlists } = await import('../../renderer/components/playlists.js');
const { Categories } = await import('../../renderer/components/categories.js');
const { DragDrop } = await import('../../renderer/js/drag-drop.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const { UpNextEngine } = await import('../../renderer/js/up-next.js');

// The dialog's words as the user reads them: pinned as text so a missing key
// (t() shows the raw key) fails here. Added to en.json by the strings stage.
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
ENX.editor.unsaved = {
  title: 'Save changes to {name}?',
  message: 'Your edits to this script are not saved. If you don\'t save them, they are lost.',
  dontSave: 'Don\'t save',
};

const ALPHA = 'C:\\sandbox\\library\\Alpha Scene.funscript';
const OTHER = 'C:\\sandbox\\library\\Alpha Scene (soft).funscript';
const ON_DISK = Array.from({ length: 33 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));

let disk;
let writes;

function editorOn(path = ALPHA) {
  const ed = Object.create(ScriptEditor.prototype);
  ed.editableScript = new EditableScript();
  ed.editableScript.loadFromData(JSON.parse(disk[path]));
  Object.assign(ed, {
    _funscriptPath: path,
    _scriptSelect: { value: path },
    _availableScripts: [{ path: ALPHA }, { path: OTHER }],
    _undoCache: new Map(),
    _loadToken: 0,
    _autosaveTimer: null,
    _autosaveEnabled: false,
    _autosaveStatusEl: null,
    _stackedView: false,
    graph: null,
    _statusEl: null,
    _reloadIntoEngineAndSync() {},
    _broadcastScriptsChanged() {},
    _broadcastActionsChanged() {},
  });
  return ed;
}

/** Five new points: 38 in memory, dirty, nothing on disk yet. */
function edit(ed) {
  for (let i = 0; i < 5; i++) ed.editableScript.insertAction(9000 + i * 100, 50);
  expect(ed.editableScript.actionCount).toBe(38);
  expect(ed.editableScript.dirty).toBe(true);
}

const pointsOnDisk = (path = ALPHA) => JSON.parse(disk[path]).actions.length;
const dialog = () => document.querySelector('.modal-overlay');
/** The Save / Don't save / Cancel question, when another dialog is open too. */
const unsavedDialog = () => [...document.querySelectorAll('.modal-overlay')]
  .find((d) => d.querySelector('[data-choice]')) || null;

async function answer(choice) {
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  if (choice === 'escape') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  } else {
    dialog().querySelector(`[data-choice="${choice}"]`).click();
  }
}

beforeEach(() => {
  _setBundlesForTests('en', ENX, ENX);
  showToast.mockClear();
  document.body.innerHTML = '';
  disk = {
    [ALPHA]: JSON.stringify({ version: '1.0', actions: ON_DISK }),
    [OTHER]: JSON.stringify({ version: '1.0', actions: ON_DISK.slice(0, 7) }),
  };
  writes = [];
  window.funsync = {
    readFunscript: async (p) => disk[p] ?? null,
    writeFunscript: async (json, p) => { writes.push(p); disk[p] = json; return p; },
    saveFunscript: async () => null, // Save As cancelled
  };
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('the editor asks before unsaved edits are replaced (CB-01)', () => {
  it('a clean editor lets the caller go on at once, with no dialog', async () => {
    const ed = editorOn();
    expect(ed.hasUnsavedChanges()).toBe(false);
    await expect(ed.confirmUnsavedChanges()).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });

  it('asks "Save changes to <script>?", Save first, then Don\'t save and Cancel', async () => {
    const ed = editorOn();
    edit(ed);
    const asked = ed.confirmUnsavedChanges();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog().querySelector('.modal-title').textContent).toBe('Save changes to Alpha Scene.funscript?');
    expect(dialog().querySelector('.modal-message').textContent).toBe(ENX.editor.unsaved.message);
    // Modal.open focuses the first button: Enter saves.
    expect([...dialog().querySelectorAll('.modal-body button')].map((b) => b.textContent))
      .toEqual(['Save', 'Don\'t save', 'Cancel']);
    await answer('cancel');
    await asked;
  });

  it('Save writes the edits to the script\'s file, exactly as Ctrl+S, and lets the caller go on', async () => {
    const ed = editorOn();
    edit(ed);
    const asked = ed.confirmUnsavedChanges();
    await answer('save');
    await expect(asked).resolves.toBe(true);
    expect(writes).toEqual([ALPHA]);
    expect(pointsOnDisk()).toBe(38);
    expect(ed.editableScript.dirty).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Funscript saved', 'info');
  });

  it('Don\'t save leaves the file alone and puts the editor back on it', async () => {
    const ed = editorOn();
    edit(ed);
    const asked = ed.confirmUnsavedChanges();
    await answer('discard');
    await expect(asked).resolves.toBe(true);
    expect(writes).toEqual([]);
    expect(pointsOnDisk()).toBe(33);
    expect(ed.editableScript.actionCount).toBe(33);
    expect(ed.editableScript.dirty).toBe(false);
    // Nothing left to ask about: the next route goes straight through.
    await expect(ed.confirmUnsavedChanges()).resolves.toBe(true);
  });

  it.each([['cancel'], ['escape']])('%s keeps the edits and stops the caller', async (how) => {
    const ed = editorOn();
    edit(ed);
    const asked = ed.confirmUnsavedChanges();
    await answer(how);
    await expect(asked).resolves.toBe(false);
    expect(dialog()).toBeNull();
    expect(writes).toEqual([]);
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.editableScript.dirty).toBe(true);
  });

  it('a Save that writes nothing (Save As cancelled) stops the caller and keeps the edits', async () => {
    const ed = editorOn();
    ed._funscriptPath = null; // a script with no file yet: Save opens Save As
    edit(ed);
    const asked = ed.confirmUnsavedChanges();
    await answer('save');
    await expect(asked).resolves.toBe(false);
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.editableScript.dirty).toBe(true);
  });

  it('with autosave on it flushes the write instead of asking', async () => {
    const ed = editorOn();
    ed._autosaveEnabled = true;
    edit(ed);
    ed._autosaveTimer = setTimeout(() => {}, 60000); // the 1 s debounce, still pending
    await expect(ed.confirmUnsavedChanges()).resolves.toBe(true);
    expect(dialog()).toBeNull();
    expect(pointsOnDisk()).toBe(38);
    expect(ed._autosaveTimer).toBeNull();
  });

  it('with autosave on but the write failing, it asks', async () => {
    const ed = editorOn();
    ed._autosaveEnabled = true;
    edit(ed);
    window.funsync.writeFunscript = async () => { throw new Error('disk full'); };
    const asked = ed.confirmUnsavedChanges();
    await answer('cancel');
    await expect(asked).resolves.toBe(false);
    expect(ed.editableScript.dirty).toBe(true);
  });

  it('one question at a time: a second route asking meanwhile does not go on', async () => {
    const ed = editorOn();
    edit(ed);
    const first = ed.confirmUnsavedChanges();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    await expect(ed.confirmUnsavedChanges()).resolves.toBe(false);
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
    await answer('save');
    await expect(first).resolves.toBe(true);
  });

  it('the editor\'s own script list asks too; Cancel stays on the script being edited', async () => {
    const ed = editorOn();
    edit(ed);
    ed._scriptSelect.value = OTHER;
    const switching = ed._onScriptSelectChange();
    await answer('cancel');
    await switching;
    expect(ed._funscriptPath).toBe(ALPHA);
    expect(ed._scriptSelect.value).toBe(ALPHA);
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.editableScript.dirty).toBe(true);
  });

  // R3 fix-up (real-app verifier 1, new since v0.9.2): the pick came from the
  // editor POP-OUT's list. Cancel put only the docked list back, so the
  // pop-out went on naming Roll over Main's points, and picking Roll again
  // fired no change. What the pop-out is told is what its list shows.
  it('a pick in the pop-out\'s list: Cancel tells the pop-out to show the script being edited again', async () => {
    const ed = editorOn();
    ed._broadcastScriptsChanged = ScriptEditor.prototype._broadcastScriptsChanged;
    ed._relayToPopout = ScriptEditor.prototype._relayToPopout;
    ed._popoutOpen = true;
    const relayed = [];
    window.funsync.editorPopoutRelay = (dir, payload) => relayed.push(payload);
    edit(ed);
    ed._handlePopoutMessage({ type: 'script-switch', path: OTHER });
    await answer('cancel');
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(ed._funscriptPath).toBe(ALPHA);
    expect(relayed.filter((m) => m.type === 'scripts-changed').at(-1)?.activePath).toBe(ALPHA);
    expect(ed.editableScript.dirty).toBe(true);
  });

  it('the script list after Save: the file has the edits, and the way back shows them', async () => {
    const ed = editorOn();
    edit(ed);
    ed._scriptSelect.value = OTHER;
    const switching = ed._onScriptSelectChange();
    await answer('save');
    await switching;
    expect(ed._funscriptPath).toBe(OTHER);
    expect(pointsOnDisk()).toBe(38);
    ed._scriptSelect.value = ALPHA;
    await ed._onScriptSelectChange();
    expect(ed.editableScript.actionCount).toBe(38);
  });
});

// --- The app's routes (REAL app.js methods) ---------------------------------

const LIFTED = [
  '_editorAllowsReplace', '_rereadAfterEditorAnswer', '_playFromLibrary', '_playAll', '_playQueueItem',
  '_dragDropOptions', '_clearPlaySession', '_loadRemoteVideo', '_switchVariant',
  '_readFunscriptFileAgain', '_confirmBeforeEroScriptsDownload', '_onEroScriptDownloaded',
  '_hasOpenVideo', '_currentView', // C-05: the download hooks ask whether a video is open
  '_playUpNext', '_playUpNextInner',
  '_armQueueEndedListener', // R3-09: Play All's own `ended` advance, armed by _playQueueItem
];
let Lifted;

function appWith(ed) {
  Lifted ||= liftAppClass(LIFTED, {
    showToast,
    t,
    shouldOfferResume: () => false,
    formatResumeTime: () => '0:00',
    SOURCE_PLAYER: { LOCAL: 'local', PHONE: 'phone' },
  });
  const app = new Lifted();
  const loads = [];
  Object.assign(app, {
    scriptEditor: ed,
    settings: { get: () => undefined },
    videoPlayer: { video: { paused: true, addEventListener() {}, removeEventListener() {} } },
    loads,
    // What the real loadVideo does to the editor, and a record of the load.
    loadVideo: vi.fn((file) => {
      loads.push(file.path || file.name);
      ed.setFunscriptPath(null);
      ed.clearUndoCache();
    }),
    loadFunscript: vi.fn(),
    navigations: [],
    _navigateTo(view) { this.navigations.push(view); },
    _recordResumePosition() {},
    _updateQueueUI() {},
    _updateQueuePanelState() {},
    _withShuffledStart: (ctx) => ctx,
    _setUpNextContext() {},
    _resetCustomRoutingState() {},
    _isPlaylistContext: () => false,
    _markCloudUploadsPending() {},
    _applyPendingResumeSeek() {},
    _loadPlayContent: async () => {},
    _routeLoadedVideoToPlayerWindow: async () => {},
    _loadQueueItemContent: async () => {},
    _advanceQueueOnEnded() {},
    _playAllOrder: (list) => list,
    getResumeEntry: () => null,
    _currentVideoPath: 'C:\\sandbox\\library\\Alpha Scene.mp4',
    _playerWindowActive: false,
    _miniActive: false,
    _playQueue: [],
    _playQueueIndex: -1,
  });
  return app;
}

const VARIANT_CLIP = { name: 'Variant Clip.mp4', path: 'C:\\sandbox\\library\\Variant Clip.mp4', _isPathBased: true };

describe('every route that opens another video asks first (CB-01)', () => {
  it('a library click with a clean editor loads at once, with no dialog', async () => {
    const ed = editorOn();
    const app = appWith(ed);
    const done = app._playFromLibrary(VARIANT_CLIP, null, null, []);
    expect(app.loads).toEqual([VARIANT_CLIP.path]); // synchronously, as before CB-01
    await done;
    expect(dialog()).toBeNull();
  });

  it('the verifier\'s repro: Cancel keeps Alpha Scene and its 38 points; nothing loads', async () => {
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    const done = app._playFromLibrary(VARIANT_CLIP, null, null, []);
    await answer('cancel');
    await done;
    expect(app.loads).toEqual([]);
    expect(app.navigations).toEqual([]);
    expect(ed._funscriptPath).toBe(ALPHA);
    expect(ed.editableScript.actionCount).toBe(38);
    expect(pointsOnDisk()).toBe(33);
  });

  it('Save: Alpha Scene.funscript has the 38 points before Variant Clip loads', async () => {
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    app.loadVideo.mockImplementation((file) => {
      app.loads.push({ path: file.path, pointsOnDiskThen: pointsOnDisk() });
    });
    const done = app._playFromLibrary(VARIANT_CLIP, null, null, []);
    await answer('save');
    await done;
    expect(app.loads).toEqual([{ path: VARIANT_CLIP.path, pointsOnDiskThen: 38 }]);
  });

  it('Don\'t save: Variant Clip loads and the file keeps its 33 points', async () => {
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    const done = app._playFromLibrary(VARIANT_CLIP, null, null, []);
    await answer('discard');
    await done;
    expect(app.loads).toEqual([VARIANT_CLIP.path]);
    expect(pointsOnDisk()).toBe(33);
    expect(writes).toEqual([]);
  });

  it('an Up Next advance in the mini player stays in the mini player after the answer', async () => {
    // _playUpNext holds `_autoAdvancing` only until the call returns, as here.
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    app._miniActive = true;
    app._autoAdvancing = true;
    const done = app._playFromLibrary(VARIANT_CLIP, null, null, []);
    app._autoAdvancing = false;
    await answer('save');
    await done;
    expect(app.loads).toEqual([VARIANT_CLIP.path]);
    expect(app.navigations).toEqual([]); // not expanded to the full player
    expect(app._autoAdvancing).toBe(false);
  });

  it('Play All, and its Next / ended advance, ask before the queue moves on', async () => {
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    const list = [
      { name: 'Bravo.mp4', path: 'C:\\v\\Bravo.mp4' },
      { name: 'Charlie.mp4', path: 'C:\\v\\Charlie.mp4' },
    ];
    const started = app._playAll(list, { sourceLabel: 'My list' });
    await answer('cancel');
    await started;
    expect(app.loads).toEqual([]);
    expect(app._playQueue).toEqual([]); // the old queue is left as it was

    // Answer Save this time: Play All starts, then Next on a dirty editor asks again.
    const again = app._playAll(list, { sourceLabel: 'My list' });
    await answer('save');
    await again;
    expect(app.loads).toEqual(['C:\\v\\Bravo.mp4']);
    ed.editableScript.insertAction(12345, 70); // a new unsaved edit on this item
    const next = app._playQueueItem(1, { auto: true });
    await answer('cancel');
    await next;
    expect(app.loads).toEqual(['C:\\v\\Bravo.mp4']);
    expect(app._playQueueIndex).toBe(0);
    const next2 = app._playQueueItem(1, { auto: true });
    await answer('discard');
    await next2;
    expect(app.loads).toEqual(['C:\\v\\Bravo.mp4', 'C:\\v\\Charlie.mp4']);
    expect(app._playQueueIndex).toBe(1);
  });

  it('a dropped video, Browse or O, and a dropped funscript ask first', async () => {
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    const opts = app._dragDropOptions();
    const dropped = opts.onVideoFile({ name: 'Dropped.mp4', path: 'C:\\v\\Dropped.mp4', _isPathBased: true });
    await answer('cancel');
    await dropped;
    expect(app.loads).toEqual([]);
    const script = opts.onFunscriptFile({ name: 'x.funscript', textContent: '{"actions":[]}' });
    await answer('escape');
    await script;
    expect(app.loadFunscript).not.toHaveBeenCalled();
    expect(ed.editableScript.actionCount).toBe(38);
    const script2 = opts.onFunscriptFile({ name: 'x.funscript', textContent: '{"actions":[]}' });
    await answer('save');
    await script2;
    expect(app.loadFunscript).toHaveBeenCalledTimes(1);
    expect(pointsOnDisk()).toBe(38);
  });

  it('a clean editor never delays a drop', () => {
    const app = appWith(editorOn());
    app._dragDropOptions().onVideoFile({ name: 'Dropped.mp4', path: 'C:\\v\\Dropped.mp4', _isPathBased: true });
    expect(app.loads).toEqual(['C:\\v\\Dropped.mp4']);
  });

  it('Load from URL asks first', async () => {
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    const done = app._loadRemoteVideo({ proxyUrl: 'http://127.0.0.1:5123/p/1', title: 'Clip' });
    await answer('cancel');
    await done;
    expect(app.loads).toEqual([]);
  });

  it('a variant switch (desktop, or the phone, which waits) asks first', async () => {
    const ed = editorOn();
    edit(ed);
    const app = appWith(ed);
    const variants = [{ label: 'Default', path: ALPHA }, { label: 'soft', path: OTHER }];
    Object.assign(app, {
      _allVariantsWithManual: variants,
      _activeVariantIndex: 0,
      _videoLoadGen: 1,
      _readScriptResilient: vi.fn(async () => null),
    });
    const switching = app._switchVariant(1);
    await answer('cancel');
    await switching;
    expect(app._activeVariantIndex).toBe(0);
    expect(app._readScriptResilient).not.toHaveBeenCalled();
    expect(ed.editableScript.actionCount).toBe(38);

    const again = app._switchVariant(1);
    await answer('save');
    await again;
    expect(pointsOnDisk()).toBe(38);
    // Saved, then the switch went ahead and read the variant's script.
    expect(app._readScriptResilient).toHaveBeenCalledWith(OTHER, app._currentVideoPath);
    // This fake read gives nothing, so nothing was loaded and the entry
    // that played before is marked again (fix-up after block F verify-1:
    // the picked one stayed marked over the old script, also in v0.9.2).
    expect(app._activeVariantIndex).toBe(0);
  });
});

// --- CB-01 review --------------------------------------------------------------

const ALPHA_MP4 = 'C:\\sandbox\\library\\Alpha Scene.mp4';
const ALPHA_RECORD = {
  name: 'Alpha Scene.mp4', path: ALPHA_MP4, hasFunscript: true, funscriptPath: ALPHA, variants: [],
};

// The three click routes, each REAL, each reading the script BEFORE the
// question is asked (`_playFromLibrary` asks), as in the app.
const CLICK_ROUTES = {
  'a library click (and Up Next, prev / next)': (app) => {
    const lib = Object.create(Library.prototype);
    Object.assign(lib, {
      _filteredVideos: [ALPHA_RECORD],
      _onPlayVideo: (...args) => app._playFromLibrary(...args),
    });
    return lib._playVideo(ALPHA_RECORD);
  },
  'a playlist click': (app) => new Playlists({
    settings: { get: () => undefined, set() {}, getPlaylists: () => [], getPlaylist: () => null },
    library: { getVideoByPath: () => ALPHA_RECORD },
    onPlayVideo: (...args) => app._playFromLibrary(...args),
    onPlayAll() {},
  })._playVideoByPath(ALPHA_MP4),
  'a category click': (app) => {
    const cat = Object.create(Categories.prototype);
    Object.assign(cat, {
      _library: { getVideoByPath: () => ALPHA_RECORD },
      _settings: { get: () => undefined },
      _onPlayVideo: (...args) => app._playFromLibrary(...args),
    });
    return cat._playVideo(ALPHA_MP4);
  },
};

describe('the SAME video opened again after the question (CB-01 review)', () => {
  // Alpha Scene, edited (38 in memory, 33 on disk), Back, Alpha Scene again.
  // The route had already read the 33-point file when Save wrote 38: that
  // stale copy went into the engine and back into the editor, clean, so the
  // next save wrote 33 + new points over the 38.
  function reopenApp(ed) {
    const app = appWith(ed);
    app._currentVideoPath = ALPHA_MP4;
    app.handed = []; // points in the script each load was given
    app._loadPlayContent = async (_video, script) => {
      app.handed.push(script?.textContent == null ? null : JSON.parse(script.textContent).actions.length);
    };
    return app;
  }

  it.each(Object.keys(CLICK_ROUTES))('%s, Save: the load gets the 38 saved points', async (route) => {
    const ed = editorOn();
    edit(ed);
    const app = reopenApp(ed);
    CLICK_ROUTES[route](app);
    await answer('save');
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(pointsOnDisk()).toBe(38);
    expect(app.handed).toEqual([38]);
    expect(app.loads).toEqual([ALPHA_MP4]);
  });

  it.each(Object.keys(CLICK_ROUTES))('%s, Don\'t save: the load gets the file\'s 33', async (route) => {
    const ed = editorOn();
    edit(ed);
    const app = reopenApp(ed);
    CLICK_ROUTES[route](app);
    await answer('discard');
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(app.handed).toEqual([33]);
    expect(writes).toEqual([]);
  });

  it('another video\'s script is loaded as the route read it, with no second read', async () => {
    const ed = editorOn();
    edit(ed);
    const app = reopenApp(ed);
    const reads = vi.spyOn(window.funsync, 'readFunscript');
    const other = { name: 'Other.funscript', textContent: disk[OTHER], _funscriptPath: OTHER };
    const done = app._playFromLibrary(VARIANT_CLIP, other, null, []);
    await answer('save');
    await done;
    expect(app.handed).toEqual([7]);
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('a Save from the question does not re-upload the script being left (CB-01 review)', () => {
  // The route loads (and uploads) another script next. Save used to start
  // the OLD script's Handy re-upload too, unawaited and unguarded, so the two
  // uploads raced and the old one could finish last.
  function syncedEditor() {
    const ed = editorOn();
    delete ed._reloadIntoEngineAndSync; // the REAL one: engine reload + Handy re-upload
    Object.assign(ed, {
      funscriptEngine: { isLoaded: true, reloadActions: vi.fn() },
      handyManager: { connected: true },
      syncEngine: { stop() {} },
      onReuploadHandy: vi.fn(async () => {}),
      _refreshHeatmap() {},
    });
    return ed;
  }

  it('Save on a route that loads another video: written, the old script not re-uploaded', async () => {
    const ed = syncedEditor();
    edit(ed);
    const app = appWith(ed);
    const done = app._playFromLibrary(VARIANT_CLIP, null, null, []);
    await answer('save');
    await done;
    expect(pointsOnDisk()).toBe(38);
    expect(ed.funscriptEngine.reloadActions).not.toHaveBeenCalled();
    expect(ed.onReuploadHandy).not.toHaveBeenCalled();
  });

  it('the autosave flush on such a route: written, not re-uploaded', async () => {
    const ed = syncedEditor();
    ed._autosaveEnabled = true;
    edit(ed);
    ed._autosaveTimer = setTimeout(() => {}, 60000);
    const app = appWith(ed);
    await app._playFromLibrary(VARIANT_CLIP, null, null, []);
    expect(pointsOnDisk()).toBe(38);
    expect(ed.onReuploadHandy).not.toHaveBeenCalled();
    clearTimeout(ed._autosaveTimer);
  });

  it('Ctrl+S, and Save before the editor\'s own script list switches, still re-upload', async () => {
    const ed = syncedEditor();
    edit(ed);
    await ed._save();
    expect(ed.onReuploadHandy).toHaveBeenCalledTimes(1);
    ed.editableScript.insertAction(12345, 70);
    ed._scriptSelect.value = OTHER;
    const switching = ed._onScriptSelectChange();
    await answer('save');
    await switching;
    expect(ed.onReuploadHandy).toHaveBeenCalledTimes(2);
  });
});

describe('one question per drop or Browse pick (CB-01 review)', () => {
  // DragDrop hands its files over in one synchronous loop. The second file
  // found the question open, got `false` and was dropped whatever the
  // answer: a video dropped with its funscript lost the funscript, and a
  // subtitle attached to the OLD video.
  function dropApp(ed) {
    const app = appWith(ed);
    app.events = [];
    app.loadVideo.mockImplementation((file) => app.events.push(`video ${file.name}`));
    app.loadFunscript.mockImplementation((file) => app.events.push(`script ${file.name}`));
    app.videoPlayer.loadSubtitles = vi.fn((file) => app.events.push(`subtitle ${file.name}`));
    return app;
  }
  const dropEvent = (names) => ({
    preventDefault() {},
    dataTransfer: { types: ['Files'], files: names.map((n) => new File(['{"actions":[]}'], n)) },
  });

  it.each([
    ['Save', 'save', ['video Dropped.mp4', 'script Dropped.funscript', 'subtitle Dropped.srt']],
    ['Don\'t save', 'discard', ['video Dropped.mp4', 'script Dropped.funscript', 'subtitle Dropped.srt']],
    ['Cancel', 'cancel', []],
  ])('a drop of a video, its funscript and a subtitle asks once; %s', async (_label, choice, expected) => {
    const ed = editorOn();
    edit(ed);
    const app = dropApp(ed);
    window.funsync.getPathForFile = (f) => `C:\\v\\${f.name}`;
    const dd = new DragDrop({ dropZoneElement: null, ...app._dragDropOptions() });
    dd._onDrop(dropEvent(['Dropped.mp4', 'Dropped.funscript', 'Dropped.srt']));
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
    await answer(choice);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    // The video first; the funscript is read again from its path after the
    // answer (round 2), so it may land after the subtitle.
    expect(app.events[0]).toBe(expected[0]);
    expect([...app.events].sort()).toEqual([...expected].sort());
  });

  it('Browse (or O) picking a video and its funscript asks once and loads both', async () => {
    const ed = editorOn();
    edit(ed);
    const app = dropApp(ed);
    window.funsync.openFileDialog = async () => [
      { name: 'Picked.mp4', path: 'C:\\v\\Picked.mp4' },
      { name: 'Picked.funscript', path: 'C:\\v\\Picked.funscript', textContent: '{"actions":[]}' },
    ];
    const dd = new DragDrop({ dropZoneElement: null, ...app._dragDropOptions() });
    const picked = dd._openNativeDialog();
    await answer('save');
    await picked;
    await vi.waitFor(() => expect(app.events).toEqual(['video Picked.mp4', 'script Picked.funscript']));
    expect(pointsOnDisk()).toBe(38);
  });

  it('a later drop is its own batch: asked again, not carried on the first answer', async () => {
    const ed = editorOn();
    edit(ed);
    const app = dropApp(ed);
    const opts = app._dragDropOptions();
    const first = opts.onVideoFile({ name: 'One.mp4', path: 'C:\\v\\One.mp4', _isPathBased: true });
    await answer('cancel');
    await first;
    const second = opts.onVideoFile({ name: 'Two.mp4', path: 'C:\\v\\Two.mp4', _isPathBased: true });
    await answer('discard');
    await second;
    expect(app.events).toEqual(['video Two.mp4']);
  });

  it('a subtitle alone, with unsaved edits, attaches at once with no question', () => {
    const ed = editorOn();
    edit(ed);
    const app = dropApp(ed);
    app._dragDropOptions().onSubtitleFile({ name: 'Alone.srt' });
    expect(app.events).toEqual(['subtitle Alone.srt']);
    expect(dialog()).toBeNull();
  });
});

describe('closing and reopening the editor on a video with no script (CB-01 review)', () => {
  // A scriptless video: the editor's new points live only in the editor
  // until the first save loads the engine. show() ran _ensureFunscript()
  // on every open, which wrote an empty file again and emptied the editor:
  // close and reopen lost every unsaved point, with no question (v0.9.2 too).
  const NOSCRIPT_MP4 = 'C:\\sandbox\\library\\No Script.mp4';
  const NOSCRIPT = 'C:\\sandbox\\library\\No Script.funscript';

  function realEditor() {
    document.body.innerHTML = `<div id="player-container" data-video-path="${NOSCRIPT_MP4}"></div>`;
    const video = Object.assign(new EventTarget(), { currentTime: 0, duration: 60, paused: true });
    const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 0 });
    const ed = new ScriptEditor({
      videoPlayer,
      funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
      progressBar: { renderHeatmap() {} },
      settings: { get: () => undefined, set() {} },
    });
    ed._sendLivePreview = () => {};
    return ed;
  }
  // The real bridge's answer: true / false (ENOENT) / null (unknown).
  const existsFrom = (answerFor) => async (paths) => paths.map(answerFor);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('the points added on the first open are still there after the second; the file is created once', async () => {
    window.funsync.filesExist = existsFrom((p) => p in disk);
    const ed = realEditor();
    ed.show();
    await vi.waitFor(() => expect(writes).toEqual([NOSCRIPT]));
    expect(ed._funscriptPath).toBe(NOSCRIPT);
    for (let i = 0; i < 5; i++) ed.editableScript.insertAction(1000 + i * 300, 50);
    ed.hide();
    ed.show();
    await flush();
    await flush();
    expect(ed.editableScript.actionCount).toBe(5);
    expect(ed.editableScript.dirty).toBe(true);
    expect(writes).toEqual([NOSCRIPT]); // the empty file, once
    expect(JSON.parse(disk[NOSCRIPT]).actions).toEqual([]);
    // Ctrl+S then writes the five to the file the first open created.
    await ed._save();
    expect(JSON.parse(disk[NOSCRIPT]).actions).toHaveLength(5);
  });

  it('a script already beside the video that nothing loaded is opened, never overwritten', async () => {
    disk[NOSCRIPT] = JSON.stringify({ version: '1.0', actions: ON_DISK });
    window.funsync.filesExist = existsFrom((p) => p in disk);
    const ed = realEditor();
    ed.show();
    await vi.waitFor(() => expect(ed.editableScript.actionCount).toBe(33));
    expect(writes).toEqual([]);
    expect(pointsOnDisk(NOSCRIPT)).toBe(33);
    expect(ed._funscriptPath).toBe(NOSCRIPT);
    expect(ed.editableScript.dirty).toBe(false);
  });

  it('an unknown answer (unreadable, timed out) writes nothing and keeps no path', async () => {
    window.funsync.filesExist = existsFrom(() => null);
    const ed = realEditor();
    ed.show();
    await flush();
    await flush();
    expect(writes).toEqual([]);
    expect(ed._funscriptPath).toBeNull();
    expect(ed.editableScript.actionCount).toBe(0);
  });

  it('another video loaded since: the next open is set up afresh for it', async () => {
    window.funsync.filesExist = existsFrom((p) => p in disk);
    const ed = realEditor();
    ed.show();
    await vi.waitFor(() => expect(writes).toEqual([NOSCRIPT]));
    ed.editableScript.insertAction(1000, 50);
    await ed._save();
    ed.hide();
    // What loadVideo does for the next (scriptless) video.
    ed.setFunscriptPath(null);
    document.getElementById('player-container').dataset.videoPath = 'C:\\sandbox\\library\\Next.mp4';
    ed.show();
    await vi.waitFor(() => expect(ed._funscriptPath).toBe('C:\\sandbox\\library\\Next.funscript'));
    expect(ed.editableScript.actionCount).toBe(0); // not the previous video's point
    expect(pointsOnDisk(NOSCRIPT)).toBe(1);
  });
});

// --- Round 2 (2026-11-05): read or write only after the answer --------------

const handedPoints = async (f) => ({
  path: f.path || null,
  n: JSON.parse(f.textContent ?? await f.text()).actions.length,
});

describe('Browse / O or a drop of the script open in the editor (round 2)', () => {
  // Main reads a Browse pick's text the moment the dialog returns, and a drop
  // is a File from before the question: the copy loaded after a Save was the
  // 33-point one, under the same path, clean. The next save wrote it over the
  // 38 the user had chosen to keep.
  function pickApp(ed) {
    const app = appWith(ed);
    app.handed = [];
    app.loadFunscript.mockImplementation(async (f) => { app.handed.push(await handedPoints(f)); });
    return app;
  }

  it.each([
    ['Browse, the script alone', false],
    ['Browse, the video and its script', true],
  ])('%s, Save: the load gets the 38 saved points', async (_label, withVideo) => {
    const ed = editorOn();
    edit(ed);
    const app = pickApp(ed);
    const early = disk[ALPHA]; // what main read as the dialog returned: 33 points
    window.funsync.openFileDialog = async () => [
      ...(withVideo ? [{ name: 'Alpha Scene.mp4', path: ALPHA_MP4 }] : []),
      { name: 'Alpha Scene.funscript', path: ALPHA, textContent: early },
    ];
    const dd = new DragDrop({ dropZoneElement: null, ...app._dragDropOptions() });
    const picked = dd._openNativeDialog();
    await answer('save');
    await picked;
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(pointsOnDisk()).toBe(38);
    expect(app.handed).toEqual([{ path: ALPHA, n: 38 }]);
  });

  it('a drop of that script, Save: the load gets the 38 saved points', async () => {
    const ed = editorOn();
    edit(ed);
    const app = pickApp(ed);
    window.funsync.getPathForFile = () => ALPHA;
    const dd = new DragDrop({ dropZoneElement: null, ...app._dragDropOptions() });
    dd._onDrop({
      preventDefault() {},
      dataTransfer: { types: ['Files'], files: [new File([disk[ALPHA]], 'Alpha Scene.funscript')] },
    });
    await answer('save');
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(app.handed).toEqual([{ path: ALPHA, n: 38 }]);
  });

  it('Browse, Don\'t save: the load gets the file\'s 33, nothing is written', async () => {
    const ed = editorOn();
    edit(ed);
    const app = pickApp(ed);
    window.funsync.openFileDialog = async () => [{ name: 'Alpha Scene.funscript', path: ALPHA, textContent: disk[ALPHA] }];
    const dd = new DragDrop({ dropZoneElement: null, ...app._dragDropOptions() });
    const picked = dd._openNativeDialog();
    await answer('discard');
    await picked;
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(app.handed).toEqual([{ path: ALPHA, n: 33 }]);
    expect(writes).toEqual([]);
  });

  it('a clean editor loads the pick as it is, with no question and no second read', async () => {
    const ed = editorOn();
    const app = pickApp(ed);
    const read = vi.spyOn(window.funsync, 'readFunscript');
    await app._dragDropOptions().onFunscriptFile(Object.assign(new File([disk[OTHER]], 'x.funscript'), { path: OTHER }));
    expect(dialog()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(app.handed).toEqual([{ path: OTHER, n: 7 }]);
  });
});

describe('an EroScripts download while a video is open (round 2)', () => {
  // The download is named <video>.funscript beside the video: the editor's
  // own file. It used to be written BEFORE the unsaved-changes question, so
  // Save wrote the edits over the download while the editor loaded the copy
  // read before the answer; and (also in v0.9.2) an existing, different
  // script there was overwritten with no question at all.
  const DOWNLOAD = JSON.stringify({ version: '1.0', actions: ON_DISK.slice(0, 20) });
  let trashed;
  let calls;

  function downloadApp(ed) {
    const app = appWith(ed);
    // Open in the player view (C-05: a closed video is no download target).
    Object.assign(app, { _currentVideoName: 'Alpha Scene.mp4', _currentVideoPath: ALPHA_MP4, funscriptEngine: {}, library: null, _navStack: ['library', 'player'] });
    app.handed = [];
    app.loadFunscript.mockImplementation(async (f) => { app.handed.push(await handedPoints(f)); });
    document.body.insertAdjacentHTML('beforeend', '<div id="player-container"></div>');
    document.getElementById('player-container').dataset.videoPath = ALPHA_MP4;
    trashed = [];
    calls = [];
    // Mirrors EroScriptsAPI.downloadFile, whose contract is pinned against a
    // real folder in eroscripts-download-no-overwrite.test.js. A look
    // (`checkOnly`, R3-03) writes nothing.
    window.funsync.eroscriptsDownload = vi.fn(async (_url, p, opts = {}) => {
      calls.push({ path: p, replace: !!opts.replace, checkOnly: !!opts.checkOnly, unsavedOpen: !!unsavedDialog() });
      if (opts.checkOnly) {
        if (!(p in disk)) return { success: true, checked: true };
        return disk[p] === DOWNLOAD
          ? { success: true, checked: true, unchanged: true }
          : { success: true, checked: true, exists: true };
      }
      if (p in disk) {
        if (disk[p] === DOWNLOAD) return { success: true, unchanged: true };
        if (!opts.replace) return { success: false, exists: true };
        trashed.push(JSON.parse(disk[p]).actions.length);
        delete disk[p];
      }
      disk[p] = DOWNLOAD;
      return { success: true };
    });
    const panel = Object.assign(Object.create(EroScriptsPanel.prototype), {
      _settings: { get: () => [] },
      _setLabel() {},
      confirmBeforeDownload: () => app._confirmBeforeEroScriptsDownload(),
      onScriptDownloaded: (p, n) => app._onEroScriptDownloaded(p, n),
    });
    const run = () => panel._downloadAttachment({ name: 'alpha_v2.funscript', url: 'https://example.invalid/a' }, null, null);
    return { app, run };
  }

  const titled = (text) => [...document.querySelectorAll('.modal-overlay')]
    .find((d) => d.querySelector('.modal-title')?.textContent === text) || null;
  const REPLACE_TITLE = 'Replace Alpha Scene.funscript?';
  async function answerReplace(yes) {
    await vi.waitFor(() => expect(titled(REPLACE_TITLE)).not.toBeNull());
    titled(REPLACE_TITLE).querySelector(yes ? '.modal-btn--danger' : '.modal-btn--secondary').click();
  }
  /** The Save / Don't save / Cancel question, whichever overlay it is. */
  async function answerUnsaved(choice) {
    await vi.waitFor(() => expect(unsavedDialog()).not.toBeNull());
    unsavedDialog().querySelector(`[data-choice="${choice}"]`).click();
  }
  const writeCalls = () => calls.filter((c) => !c.checkOnly).map(({ path, replace }) => ({ path, replace }));

  // R3-03: "Replace?" comes BEFORE the unsaved-changes question. It came
  // after, so Don't save, then Cancel at Replace, threw the edits away for a
  // download that never happened. The rewrite of round 2's first three cases
  // here: they pinned the old order (unsaved question first, no look).
  it('nothing is written before the unsaved-changes question is answered, and Cancel there writes nothing', async () => {
    const ed = editorOn();
    edit(ed);
    const { app, run } = downloadApp(ed);
    const done = run();
    await answerReplace(true);
    await vi.waitFor(() => expect(unsavedDialog()).not.toBeNull());
    expect(writeCalls()).toEqual([]); // only the look so far
    expect(pointsOnDisk()).toBe(33);
    await answerUnsaved('cancel');
    await done;
    // Cancel: nothing written or moved, the file and the edits as they were.
    expect(writeCalls()).toEqual([]);
    expect(trashed).toEqual([]);
    expect(pointsOnDisk()).toBe(33);
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.editableScript.dirty).toBe(true);
    expect(app.handed).toEqual([]);
  });

  it('Cancel at "Replace?" (asked first) never reaches the unsaved question: the edits stay, nothing is written (R3-03)', async () => {
    const ed = editorOn();
    edit(ed);
    const { app, run } = downloadApp(ed);
    const done = run();
    await vi.waitFor(() => expect(titled(REPLACE_TITLE)).not.toBeNull());
    expect(unsavedDialog()).toBeNull();
    await answerReplace(false);
    await done;
    expect(unsavedDialog()).toBeNull();
    expect(ed.editableScript.actionCount).toBe(38);
    expect(ed.editableScript.dirty).toBe(true);
    expect(pointsOnDisk()).toBe(33);
    expect(writeCalls()).toEqual([]);
    expect(trashed).toEqual([]);
    expect(app.handed).toEqual([]);
  });

  it('Replace, then Save: the saved edits go to the Recycle Bin, the download is written and loaded', async () => {
    const ed = editorOn();
    edit(ed);
    const { app, run } = downloadApp(ed);
    const done = run();
    await answerReplace(true);
    await answerUnsaved('save');
    await done;
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(trashed).toEqual([38]); // the edits, recoverable
    expect(pointsOnDisk()).toBe(20);
    expect(app.handed).toEqual([{ path: ALPHA, n: 20 }]);
    expect(writeCalls()).toEqual([{ path: ALPHA, replace: true }]);
  });

  it('Replace, then Don\'t save: the old file goes to the Recycle Bin, the download is written and loaded', async () => {
    const ed = editorOn();
    edit(ed);
    const { app, run } = downloadApp(ed);
    const done = run();
    await answerReplace(true);
    await answerUnsaved('discard');
    await done;
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(trashed).toEqual([33]);
    expect(pointsOnDisk()).toBe(20);
    expect(app.handed).toEqual([{ path: ALPHA, n: 20 }]);
  });

  it('nothing there yet, unsaved edits, Save: the file Save just wrote is asked about before it is replaced', async () => {
    const ed = editorOn();
    edit(ed);
    delete disk[ALPHA];
    const { app, run } = downloadApp(ed);
    const done = run();
    await answerUnsaved('save'); // no "Replace?" first: nothing was there
    expect(pointsOnDisk()).toBe(38);
    await answerReplace(false);
    await done;
    expect(pointsOnDisk()).toBe(38); // the saved edits, untouched
    expect(trashed).toEqual([]);
    expect(app.handed).toEqual([]);
  });

  it('a clean editor and the user\'s own script already there (also in v0.9.2): asked, Cancel writes nothing', async () => {
    const ed = editorOn();
    const { app, run } = downloadApp(ed);
    const done = run();
    await answerReplace(false);
    await done;
    expect(pointsOnDisk()).toBe(33);
    expect(trashed).toEqual([]);
    expect(app.handed).toEqual([]);
  });

  it('nothing there yet: no question, written and loaded', async () => {
    const ed = editorOn();
    delete disk[ALPHA];
    const { app, run } = downloadApp(ed);
    await run();
    await vi.waitFor(() => expect(app.handed).toHaveLength(1));
    expect(dialog()).toBeNull();
    expect(app.handed).toEqual([{ path: ALPHA, n: 20 }]);
  });
});

describe('Cancel at the question an Up Next advance raised (round 2)', () => {
  // The engine's advance is one-shot per video (V18). After Cancel here it
  // stayed spent: seek back, play to the end again, and no card, no advance.
  // The REAL UpNextEngine, the REAL _playUpNext and the REAL question.
  const NEXT = VARIANT_CLIP.path;
  function upNextApp(ed) {
    const app = appWith(ed);
    const clip = { currentTime: 30, duration: 60, paused: false, ended: false };
    const engine = new UpNextEngine({ videoPlayer: clip, funscriptEngine: { isLoaded: false } });
    engine.setSettings('auto', 10);
    const ctx = { source: 'library', sourceLabel: 'Library', sourceContext: {}, list: [ALPHA_MP4, NEXT], index: 0 };
    engine.setPlayContext(ctx);
    engine.onPlayNext = (path) => { app._playUpNext(path); };
    Object.assign(app, {
      upNextEngine: engine,
      _currentPlayContext: ctx,
      _userQueue: [],
      _reshuffleContextForWrap: () => null,
      _contextIndexOfNext: () => 1,
      _autoplayOnAdvance: () => false,
      library: {
        getVideoByPath: (p) => ({ name: 'Variant Clip.mp4', path: p }),
        // The library's click route: onPlayVideo -> _playFromLibrary.
        _playVideo: (video) => app._playFromLibrary({ ...video, _isPathBased: true }, null),
      },
    });
    const at = (s) => { clip.currentTime = s; engine.check(); };
    return { app, engine, at };
  }

  afterEach(() => { document.querySelectorAll('.modal-overlay').forEach((d) => d.remove()); });

  it('the card comes back on the next end, and that advance asks and loads', async () => {
    const ed = editorOn();
    edit(ed);
    const { app, engine, at } = upNextApp(ed);
    at(55);
    expect(engine.visible).toBe(true);
    engine.playNext();
    await answer('cancel');
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(app.loads).toEqual([]); // Cancel: still on Alpha Scene, with its edits
    expect(ed.editableScript.actionCount).toBe(38);
    at(60);
    expect(engine.visible).toBe(false); // not at once: "not now"
    at(30); // seek back
    at(55); // and play to the end again
    expect(engine.visible).toBe(true);
    engine.playNext();
    await answer('discard');
    await vi.waitFor(() => expect(app.loads).toEqual([NEXT]));
    engine.hide();
  });
});
