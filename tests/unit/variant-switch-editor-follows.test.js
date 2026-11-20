/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Modal draws the unsaved-changes question, and
 * script-editor.js imports DOM-branching modules (notes/CLAUDE.md "Test
 * environments").
 */
// Which script the editor holds after a variant pick.
//
// C-02 (also in v0.9.2, round-4 re-verify): picking a variant with the editor
// CLOSED left the editor on the previous variant. Sandbox repro: Alpha Scene
// associated with Alpha Custom Take (18 points) and its own sidecar (33);
// pick "Default", then E: the engine and heatmap play Default's 33 points
// while the editor shows Alpha Custom Take's 18, so what you edit and save is
// not what plays. `_switchVariant` reloaded only an OPEN editor, and show()
// loads only into an empty one.
//
// C-11 (probably also in v0.9.2): a variant tapped on the PHONE with the
// editor open loaded the phone video's variant into the editor, against
// R3-20's rule that the editor keeps off a remote's script.
//
// The REAL `_switchVariant` and `_editorAllowsReplace` (lifted from app.js),
// the REAL FunscriptEngine, the REAL ScriptEditor prototype with a REAL
// EditableScript, the REAL Modal. Only the disk, the toast and the canvas
// graph are fakes. Asserted: the points and the file the editor holds, what
// the engine plays, and that nothing was written.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { t } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { FunscriptEngine } = await import('../../renderer/js/funscript-engine.js');

const VIDEO = 'C:\\sandbox\\library\\Alpha Scene.mp4';
const DEFAULT = 'C:\\sandbox\\library\\Alpha Scene.funscript';
const CUSTOM = 'C:\\sandbox\\library\\Alpha Custom Take.funscript';
const PHONE_P1 = 'C:\\phone-lib\\Bravo.funscript';
const PHONE_P2 = 'C:\\phone-lib\\Bravo (soft).funscript';

const points = (n, step = 250) => Array.from({ length: n }, (_, i) => ({ at: (i + 1) * step, pos: i % 2 ? 90 : 10 }));
const file = (n) => JSON.stringify({ version: '1.0', actions: points(n) });

let disk;
let writes;

beforeEach(() => {
  showToast.mockClear();
  document.body.innerHTML = '';
  disk = { [DEFAULT]: file(33), [CUSTOM]: file(18), [PHONE_P1]: file(41), [PHONE_P2]: file(12) };
  writes = [];
  window.funsync = {
    convertFunscript: async () => null,
    writeFunscript: async (json, p) => { writes.push(p); disk[p] = json; return p; },
    saveFunscript: async () => null,
  };
});
afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
});

const Lifted = liftAppClass(['_switchVariant', '_editorAllowsReplace'], {
  showToast,
  t,
  SOURCE_PLAYER: { LOCAL: 'local', PHONE: 'phone' },
});

/** The docked editor, holding `path`'s script, open or closed. */
function editorOn(engine, app, path, { open }) {
  const ed = Object.create(ScriptEditor.prototype);
  ed.editableScript = new EditableScript();
  ed.editableScript.loadFromData(JSON.parse(disk[path]));
  Object.assign(ed, {
    funscriptEngine: engine,
    videoPlayer: { duration: 60, currentTime: 0, video: { paused: true } },
    graph: { setVideoDuration() {}, smartZoom() {}, fitAll() {} },
    engineHeldByRemote: () => app._engineHeldByRemote === true,
    _open: open,
    _funscriptPath: path,
    _unsavedPrompt: null,
    _autosaveTimer: null,
    _autosaveEnabled: false,
    _autosaveStatusEl: null,
    _statusEl: null,
    _stackedView: false,
    _clearWaveform() {},
    _clearBeatMarkers() {},
    _updateScrubber() {},
    _broadcastActionsChanged() {},
    _broadcastScriptsChanged() {},
    _reloadIntoEngineAndSync() {},
  });
  return ed;
}

/** The app with Alpha Scene open, the engine on `playing`, the variant list `variants`. */
async function appOn({ variants, active, playing, editorPath = playing, open, phone = false }) {
  const engine = new FunscriptEngine({ backendPort: 5123 });
  await engine.loadContent(disk[playing], playing.split('\\').pop());
  const app = new Lifted();
  Object.assign(app, {
    funscriptEngine: engine,
    videoPlayer: { video: { paused: true }, duration: NaN },
    _allVariantsWithManual: variants,
    _activeVariantIndex: active,
    _activeVariantPath: variants[active].path,
    _videoLoadGen: 1,
    _currentVideoPath: VIDEO,
    _currentFunscriptPath: playing,
    // A phone list: the phone filled it during its session (epoch 7).
    _variantsPhoneEpoch: phone ? 7 : null,
    _remotePhoneEpoch: phone ? 7 : null,
    _engineHeldByRemote: phone,
    _autoAdvancing: false,
    handyManager: null,
    autoblowManager: null,
    autoblowSync: null,
    buttplugSync: null,
    tcodeSync: null,
    remoteBridge: null,
    audienceBridge: null,
    _readScriptResilient: vi.fn(async (p) => (disk[p] == null ? null : { content: disk[p] })),
    _healManualVariantPath() {},
    _formatActionsDuration: () => '0:08',
    _showFunscriptBadge() {},
    _tryStartAutoblowSync: async () => {},
    _startGapSkip() {},
    _updateVariantSelector() {},
  });
  app.scriptEditor = editorOn(engine, app, editorPath, { open });
  return app;
}

const LOCAL_VARIANTS = [{ label: 'Default', path: DEFAULT }, { label: 'Alpha Custom Take', path: CUSTOM }];

async function answer(choice) {
  await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull());
  document.querySelector(`.modal-overlay [data-choice="${choice}"]`).click();
}

describe('C-02: a variant picked with the editor CLOSED is the one the editor opens on', () => {
  it('the verifier\'s repro: on Alpha Custom Take (18), pick Default, then E: the editor holds Default\'s 33 points and its file', async () => {
    const app = await appOn({ variants: LOCAL_VARIANTS, active: 1, playing: CUSTOM, open: false });
    await app._switchVariant(0);
    expect(app.funscriptEngine.getActions()).toHaveLength(33); // what plays
    const ed = app.scriptEditor;
    expect(ed._funscriptPath).toBe(DEFAULT); // what a save writes
    expect(ed.editableScript.actionCount).toBe(33); // what E shows
    expect(ed.editableScript.dirty).toBe(false);
    expect(writes).toEqual([]); // a pick writes nothing
  });

  it('an open editor follows too, as before', async () => {
    const app = await appOn({ variants: LOCAL_VARIANTS, active: 0, playing: DEFAULT, open: true });
    await app._switchVariant(1);
    expect(app.scriptEditor._funscriptPath).toBe(CUSTOM);
    expect(app.scriptEditor.editableScript.actionCount).toBe(18);
  });

  it('a closed editor holding unsaved edits asks first; Cancel keeps the variant and the edits', async () => {
    const app = await appOn({ variants: LOCAL_VARIANTS, active: 1, playing: CUSTOM, open: false });
    app.scriptEditor.editableScript.insertAction(30000, 50); // 19 points, unsaved
    const switching = app._switchVariant(0);
    await answer('cancel');
    await switching;
    expect(app._activeVariantIndex).toBe(1);
    expect(app.funscriptEngine.getActions()).toHaveLength(18);
    expect(app.scriptEditor._funscriptPath).toBe(CUSTOM);
    expect(app.scriptEditor.editableScript.actionCount).toBe(19);
    expect(writes).toEqual([]);
  });

  it('Save writes the edits to the variant they belong to, then the editor holds the new one', async () => {
    const app = await appOn({ variants: LOCAL_VARIANTS, active: 1, playing: CUSTOM, open: false });
    app.scriptEditor.editableScript.insertAction(30000, 50);
    const switching = app._switchVariant(0);
    await answer('save');
    await switching;
    expect(writes).toEqual([CUSTOM]);
    expect(JSON.parse(disk[CUSTOM]).actions).toHaveLength(19);
    expect(app.scriptEditor._funscriptPath).toBe(DEFAULT);
    expect(app.scriptEditor.editableScript.actionCount).toBe(33);
  });
});

describe('C-11: a variant tapped on the phone never lands in this window\'s editor', () => {
  for (const open of [true, false]) {
    it(`editor ${open ? 'OPEN' : 'closed'}: the engine plays the phone's variant, the editor keeps this video's script`, async () => {
      // This window: Alpha Scene with its 33-point Default in the editor. The
      // phone plays Bravo, whose list (P1 41 points, P2 12) the phone filled.
      const variants = [{ label: 'P1', path: PHONE_P1 }, { label: 'P2', path: PHONE_P2 }];
      const app = await appOn({ variants, active: 0, playing: PHONE_P1, editorPath: DEFAULT, open, phone: true });
      await app._switchVariant(1);
      expect(app.funscriptEngine.getActions()).toHaveLength(12); // the phone plays P2
      expect(app._engineHeldByRemote).toBe(true);
      const ed = app.scriptEditor;
      expect(ed._funscriptPath).toBe(DEFAULT);
      expect(ed.editableScript.actionCount).toBe(33);
      expect(writes).toEqual([]);
    });
  }
});
