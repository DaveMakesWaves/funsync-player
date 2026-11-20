/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar, script
 * selector and stacked lanes as DOM (notes/CLAUDE.md "Test environments").
 */
// The editor can reach axes embedded in the main script (app test V42,
// forum #376).
//
// The editor's script selector was fed only from file paths (companion
// files, custom routes), and it loads each entry from disk. A combined
// funscript (twist/roll/pitch inside the one file) gave it nothing: the
// selector stayed hidden while the device played three axes.
//
// The conservative fix: list each embedded axis that no companion covers.
// It has no file, so the stacked view previews it read-only and picking it
// runs the library's Extract (companion files + association), switches the
// video over to those files, and opens the chosen one. Extract never
// overwrites a companion that is already there.
//
// The REAL app.js methods (loadFunscript included) are lifted and run with
// the REAL ScriptEditor, FunscriptEngine, ButtplugSync and TCodeSync over a
// fake disk. The editor callbacks are wired by the statements app.js uses.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { APP_SRC, liftAppClass } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { FunscriptEngine, stripBOM } from '../../renderer/js/funscript-engine.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import {
  extractEmbeddedAxes, buildCompanionFiles, companionPathMap,
} from '../../renderer/js/embedded-multi-axis.js';
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';

// jsdom has no 2D canvas; the editor's graphs only need something to draw on.
HTMLCanvasElement.prototype.getContext = function getContext() {
  return new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : () => ({ addColorStop() {} })),
    set: (target, key, value) => { target[key] = value; return true; },
  });
};
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DIR = 'C:\\Lib';
const VIDEO = `${DIR}\\Combined Clip.mp4`;
const MAIN = `${DIR}\\Combined Clip.funscript`;
const companion = (s) => `${DIR}\\Combined Clip.${s}.funscript`;
const ramp = (n, base) => Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: (base + i * 9) % 100 }));
const EMBED = { twist: ramp(12, 5), roll: ramp(14, 25), pitch: ramp(16, 45) };
const MAIN_CONTENT = JSON.stringify({
  actions: ramp(20, 0),
  axes: [
    { id: 'R0', actions: EMBED.twist },
    { id: 'R1', actions: EMBED.roll },
    { id: 'R2', actions: EMBED.pitch },
  ],
});

const showToast = vi.fn();
const LiftedApp = liftAppClass([
  'loadFunscript',
  '_feedEmbeddedMultiAxis',
  '_applyEmbeddedAxes',
  '_companionAxisSuffixes',
  '_releaseCompanionAxis',
  'getEmbeddedAxes',
  'detectEmbeddedAxesForPath',
  '_loadMultiAxisScripts',
  '_refreshEditorScriptList',
  '_editEmbeddedAxis',
  '_extractEmbeddedAxesToCompanions',
], {
  window, document, console, showToast, t, stripBOM,
  extractEmbeddedAxes, buildCompanionFiles, companionPathMap, getAxisBySuffix,
});

/** The two statements in app.js `init()` that connect the editor to the app. */
function wireEditor(app) {
  const start = APP_SRC.indexOf('this.scriptEditor.onEditEmbeddedAxis =');
  expect(start, 'editor wiring not found in app.js').toBeGreaterThan(-1);
  const end = APP_SRC.indexOf('|| null;', start) + '|| null;'.length;
  // eslint-disable-next-line no-new-func
  new Function(APP_SRC.slice(start, end)).call(app);
}

let disk;
let store;
let app;
let editor;

function makeApp() {
  const a = new LiftedApp();
  const player = new EventTarget();
  const video = Object.assign(new EventTarget(), { currentTime: 0, duration: 2, paused: true });
  a.videoPlayer = Object.assign(new EventTarget(), { video, duration: NaN, currentTime: 0 });
  a.funscriptEngine = new FunscriptEngine({ backendPort: 0 });
  a.buttplugSync = new ButtplugSync({ videoPlayer: player, buttplugManager: {}, funscriptEngine: a.funscriptEngine });
  a.tcodeSync = new TCodeSync({ videoPlayer: player, tcodeManager: {}, funscriptEngine: a.funscriptEngine });
  a.buttplugManager = { connected: false };
  a.handyHdspSync = null;
  a.settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  a.library = null;
  a._currentView = () => 'player';
  a._customRoutingActive = false;
  a._pendingFunscripts = [];
  a._embeddedAxisTcodes = new Set();
  a._companionAxesFailed = new Set();
  // Not under test: badge, devices, gap skip.
  a._showFunscriptBadge = () => {};
  a._uploadAndStartSync = async () => {};
  a._tryStartButtplugSync = () => {};
  a._tryStartTCodeSync = () => {};
  a._tryStartAutoblowSync = async () => {};
  a._startGapSkip = () => {};
  a._isDeviceOnMainRoute = () => false;
  a._readScriptResilient = async (p) => (disk.has(p) ? { content: disk.get(p) } : null);
  a.scriptEditor = new ScriptEditor({
    videoPlayer: a.videoPlayer,
    funscriptEngine: a.funscriptEngine,
    progressBar: {},
    settings: { get: () => undefined, set() {} },
  });
  wireEditor(a);
  return a;
}

/** What `_playFromLibrary` + `loadVideo` leave behind, then the script load. */
async function openCombinedClip(multiAxis = null) {
  app._currentVideoName = 'Combined Clip.mp4';
  app._currentVideoPath = VIDEO;
  app._currentFunscriptPath = null;
  app._currentMultiAxis = multiAxis;
  editor.setFunscriptPath(null);
  editor.setAvailableScripts([]);
  const loads = [app.loadFunscript({ name: 'Combined Clip.funscript', textContent: MAIN_CONTENT, _funscriptPath: MAIN })];
  if (multiAxis) loads.push(app._loadMultiAxisScripts(multiAxis));
  await Promise.all(loads);
}

const options = () => [...editor._scriptSelect.options].map((o) => o.textContent);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

async function pick(label) {
  const opt = [...editor._scriptSelect.options].find((o) => o.textContent === label);
  expect(opt, `no "${label}" in ${JSON.stringify(options())}`).toBeTruthy();
  editor._scriptSelect.value = opt.value;
  editor._scriptSelect.dispatchEvent(new Event('change'));
  await settle();
}

const embeddedLabel = (axis) => t('editor.embeddedAxisLabel', { axis });

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="player-container"></div>';
  showToast.mockClear();
  disk = new Map([[MAIN, MAIN_CONTENT]]);
  store = { 'library.associations': {} };
  window.funsync = {
    convertFunscript: async () => null,
    readFunscript: vi.fn(async (p) => disk.get(p) ?? null),
    writeFunscript: vi.fn(async (content, p) => { disk.set(p, content); return p; }),
    filesExist: vi.fn(async (list) => list.map((p) => disk.has(p))),
    onEditorPopoutRelay: () => () => {},
    editorPopoutRelay: () => {},
  };
  app = makeApp();
  editor = app.scriptEditor;
});

describe('the editor lists embedded axes (V42)', () => {
  it('a combined script shows its embedded axes in the script selector', async () => {
    await openCombinedClip();
    expect(editor._scriptSelect.hidden).toBe(false);
    expect(options()).toEqual([
      t('editor.mainAxisLabel'), embeddedLabel('Twist'), embeddedLabel('Roll'), embeddedLabel('Pitch'),
    ]);
  });

  it('the stacked view previews each embedded axis from the script itself', async () => {
    await openCombinedClip();
    await editor._setStackedView(true);
    const lanes = [...document.querySelectorAll('.editor__lane .editor__lane-label')].map((n) => n.textContent);
    expect(lanes).toEqual([embeddedLabel('Twist'), embeddedLabel('Roll'), embeddedLabel('Pitch')]);
    // Previewed from memory: no disk read for a path that is not a file.
    expect(window.funsync.readFunscript.mock.calls.map(([p]) => p).filter((p) => p.includes('#'))).toEqual([]);
  });
});

describe('picking an embedded axis extracts it and opens it (V42)', () => {
  it('writes the companion files, switches the video to them and opens the chosen axis', async () => {
    await openCombinedClip();
    await pick(embeddedLabel('Roll'));

    for (const s of ['twist', 'roll', 'pitch']) {
      expect(JSON.parse(disk.get(companion(s))).actions).toEqual(EMBED[s].map(({ at, pos }) => ({ at, pos })));
    }
    expect(store['library.associations'][VIDEO].active).toBe('multi');

    // The editor now edits the roll FILE, with the roll motion on the canvas.
    expect(editor._funscriptPath).toBe(companion('roll'));
    expect(editor.editableScript.actions.map(({ at, pos }) => ({ at, pos }))).toEqual(EMBED.roll);
    expect(options()).toEqual([t('editor.mainAxisLabel'), 'Twist', 'Roll', 'Pitch']);
    // And the devices play the companions.
    expect(app.tcodeSync._axisActions.get('R1').actions).toEqual(JSON.parse(disk.get(companion('roll'))).actions);
  });

  it('an axis that already has an edited companion is neither listed as embedded nor overwritten', async () => {
    // Twist: the user's own, edited, differently named companion, assigned.
    const myTwist = `${DIR}\\My Twist.funscript`;
    const editedTwist = JSON.stringify({ version: '1.0', actions: ramp(3, 70) });
    disk.set(myTwist, editedTwist);
    // Pitch: a file already at the companion path, not assigned yet.
    const ownPitch = JSON.stringify({ version: '1.0', actions: ramp(4, 80) });
    disk.set(companion('pitch'), ownPitch);
    const multi = { main: MAIN, axes: { twist: myTwist }, buttplugVib: false };
    store['library.associations'] = { [VIDEO]: { active: 'multi', single: MAIN, multi, custom: null } };
    await openCombinedClip(multi);

    expect(options()).toEqual([
      t('editor.mainAxisLabel'), 'Twist', embeddedLabel('Roll'), embeddedLabel('Pitch'),
    ]);

    await pick(embeddedLabel('Roll'));

    // Nothing the user had is replaced: not the assignment, not a file.
    expect(disk.get(myTwist)).toBe(editedTwist);
    expect(disk.has(companion('twist'))).toBe(false);
    expect(disk.get(companion('pitch'))).toBe(ownPitch);
    expect(store['library.associations'][VIDEO].multi.axes).toEqual({
      twist: myTwist, roll: companion('roll'), pitch: companion('pitch'),
    });
    expect(editor._funscriptPath).toBe(companion('roll'));
    // The devices play the edited twist and the pitch file that was there.
    expect(app.buttplugSync._axisActions.get('R0').actions).toEqual(JSON.parse(editedTwist).actions);
    expect(app.tcodeSync._axisActions.get('R2').actions).toEqual(JSON.parse(ownPitch).actions);
    expect(showToast).toHaveBeenCalledWith(
      t('toast.extractKeptExisting', { count: 2, names: 'My Twist.funscript, Combined Clip.pitch.funscript' }), 'info', 6000,
    );
  });
});
