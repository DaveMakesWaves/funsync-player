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
import { getAxisBySuffix, parseAxisSuffix } from '../../renderer/js/multi-axis.js';

// jsdom has no 2D canvas; the editor's graphs only need something to draw on.
HTMLCanvasElement.prototype.getContext = function getContext() {
  return new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : () => ({ addColorStop() {} })),
    set: (target, key, value) => { target[key] = value; return true; },
  });
};
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { Modal } = await import('../../renderer/components/modal.js');

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
  '_onEditorAxisSaved',
  '_onEditorCombinedSaved',
  '_onEditorMainSavedAs',
  '_loadDownloadedAxes',
  '_syncUpNextSuppression',
], {
  window, document, console, showToast, t, stripBOM,
  extractEmbeddedAxes, buildCompanionFiles, companionPathMap, getAxisBySuffix, parseAxisSuffix,
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

// Multi-axis editing (Dave, 2026-11-24: "combined as the master copy too
// might as well use the new format"): an axis inside the combined file is
// edited IN PLACE and saved back into it, in the new format (funscript 2.0
// `channels` + the `axes` mirror). A pick used to split every axis out into
// companion files first (V42); the kebab's Extract embedded axes still does.
describe('an embedded axis is edited in place and saved back into the combined file', () => {
  const mainActions = () => JSON.parse(MAIN_CONTENT).actions;
  const pairs = (list) => list.map(({ at, pos }) => ({ at, pos }));

  it('the pick opens it in place: no file written, its points on the canvas, nothing unsaved', async () => {
    await openCombinedClip();
    await pick(embeddedLabel('Roll'));
    expect(window.funsync.writeFunscript).not.toHaveBeenCalled();
    for (const s of ['twist', 'roll', 'pitch']) expect(disk.has(companion(s))).toBe(false);
    expect(pairs(editor.editableScript.actions)).toEqual(EMBED.roll);
    expect(editor.hasUnsavedChanges()).toBe(false);
  });

  it('Save writes the combined file in the new format: the stroke as it was, every axis, the edit; the devices play it', async () => {
    await openCombinedClip();
    await pick(embeddedLabel('Roll'));
    editor.editableScript.insertAction(5000, 33);
    await editor._save();
    await settle();
    const saved = JSON.parse(disk.get(MAIN));
    expect(saved.version).toBe('2.0');
    expect(saved.actions).toEqual(mainActions());
    expect(saved.channels.roll.actions).toEqual([...EMBED.roll, { at: 5000, pos: 33 }]);
    expect(saved.channels.twist.actions).toEqual(EMBED.twist);
    expect(saved.channels.pitch.actions).toEqual(EMBED.pitch);
    expect(saved.axes.map((a) => a.id)).toEqual(['R0', 'R1', 'R2']);
    for (const s of ['twist', 'roll', 'pitch']) expect(disk.has(companion(s))).toBe(false);
    expect(editor.hasUnsavedChanges()).toBe(false);
    // The main engine keeps the stroke; the roll channel plays the edit.
    expect(pairs(app.funscriptEngine.getActions())).toEqual(mainActions());
    expect(app.tcodeSync._axisActions.get('R1').actions).toContainEqual({ at: 5000, pos: 33 });
  });

  it('an axis with an edited companion stays the companion, untouched; the combined file keeps its own copy of it', async () => {
    // Twist: the user's own, edited, differently named companion, assigned.
    const myTwist = `${DIR}\\My Twist.funscript`;
    const editedTwist = JSON.stringify({ version: '1.0', actions: ramp(3, 70) });
    disk.set(myTwist, editedTwist);
    // Pitch: a file already at the companion path, not assigned.
    const ownPitch = JSON.stringify({ version: '1.0', actions: ramp(4, 80) });
    disk.set(companion('pitch'), ownPitch);
    const multi = { main: MAIN, axes: { twist: myTwist }, buttplugVib: false };
    store['library.associations'] = { [VIDEO]: { active: 'multi', single: MAIN, multi, custom: null } };
    await openCombinedClip(multi);
    expect(options()).toEqual([
      t('editor.mainAxisLabel'), 'Twist', embeddedLabel('Roll'), embeddedLabel('Pitch'),
    ]);

    await pick(embeddedLabel('Roll'));
    editor.editableScript.insertAction(5000, 33);
    await editor._save();
    await settle();

    expect(disk.get(myTwist)).toBe(editedTwist);
    expect(disk.has(companion('twist'))).toBe(false);
    expect(disk.get(companion('pitch'))).toBe(ownPitch);
    const saved = JSON.parse(disk.get(MAIN));
    expect(saved.channels.twist.actions).toEqual(EMBED.twist);
    expect(saved.channels.roll.actions).toContainEqual({ at: 5000, pos: 33 });
    expect(store['library.associations'][VIDEO].multi.axes).toEqual({ twist: myTwist });
    // The devices still play the edited twist companion.
    expect(app.buttplugSync._axisActions.get('R0').actions).toEqual(JSON.parse(editedTwist).actions);
  });
});

describe('New axis (multi-axis editing, 2026-11-24)', () => {
  const PLAIN = JSON.stringify({ version: '1.0', actions: ramp(20, 0), metadata: { title: 'Clip', creator: 'me' } });
  async function openPlainClip() {
    disk.set(MAIN, PLAIN);
    app._currentVideoName = 'Combined Clip.mp4';
    app._currentVideoPath = VIDEO;
    app._currentFunscriptPath = null;
    app._currentMultiAxis = null;
    editor.setFunscriptPath(null);
    editor.setAvailableScripts([]);
    await app.loadFunscript({ name: 'Combined Clip.funscript', textContent: PLAIN, _funscriptPath: MAIN });
  }
  const two = [{ at: 100, pos: 20 }, { at: 700, pos: 80 }];

  it('a separate script: <main>.<axis>.funscript, empty, written on Save; then the association, the list, its channel; the stroke stays the stroke', async () => {
    await openPlainClip();
    expect(editor._btnNewAxis.hidden).toBe(false);
    await editor._createAxis('twist');
    const twistPath = companion('twist');
    expect(editor._funscriptPath).toBe(twistPath);
    expect(editor.editableScript.actionCount).toBe(0);
    expect(disk.has(twistPath)).toBe(false);
    for (const p of two) editor.editableScript.insertAction(p.at, p.pos);
    expect(editor.hasUnsavedChanges()).toBe(true);
    await editor._save();
    await settle();
    expect(JSON.parse(disk.get(twistPath)).actions).toEqual(two);
    // The main script's block, as OFS; the save adds OFS's missing keys (work list 5.3).
    expect(JSON.parse(disk.get(twistPath)).metadata).toMatchObject({ title: 'Clip', creator: 'me', type: 'basic' });
    expect(store['library.associations'][VIDEO].multi.axes).toEqual({ twist: twistPath });
    expect(app.tcodeSync._axisActions.get('R0').actions).toEqual(two);
    expect(app.funscriptEngine.getActions()).toHaveLength(20);
    expect(options()).toEqual([t('editor.mainAxisLabel'), 'Twist']);
    expect(disk.get(MAIN)).toBe(PLAIN);
  });

  it('in a combined file the new axis goes inside it, and Save writes it as a channel', async () => {
    await openCombinedClip();
    await editor._createAxis('surge');
    expect(editor._funscriptPath).toBe(`${MAIN}#embedded=surge`);
    expect(editor.editableScript.actionCount).toBe(0);
    expect(options()).toContain(embeddedLabel('Surge'));
    for (const p of two) editor.editableScript.insertAction(p.at, p.pos);
    await editor._save();
    await settle();
    const saved = JSON.parse(disk.get(MAIN));
    expect(saved.channels.surge.actions).toEqual(two);
    expect(saved.axes.map((a) => a.id)).toEqual(['L1', 'R0', 'R1', 'R2']);
    expect(disk.has(companion('surge'))).toBe(false);
    expect(app.tcodeSync._axisActions.get('L1').actions).toEqual(two);
  });

  it('copy the stroke, New axis, paste: the new axis starts from the stroke\'s points', async () => {
    await openPlainClip();
    editor.editableScript.selectAll();
    editor.editableScript.copy();
    await editor._createAxis('roll');
    editor.editableScript.paste(0);
    expect(editor.editableScript.actions.map(({ at, pos }) => ({ at, pos }))).toEqual(ramp(20, 0));
  });

  it('a file already at the name IS that axis: it opens, never started over; the menu greys an axis the video has', async () => {
    await openPlainClip();
    const existing = JSON.stringify({ version: '1.0', actions: two });
    disk.set(companion('pitch'), existing);
    window.funsync.fileExists = vi.fn(async (p) => disk.has(p));
    await editor._createAxis('pitch');
    expect(editor.editableScript.actions.map(({ at, pos }) => ({ at, pos }))).toEqual(two);
    expect(editor.hasUnsavedChanges()).toBe(false);
    expect(editor._axesPresent().has('pitch')).toBe(true);
    await editor._createAxis('pitch');               // a second New pitch does nothing
    expect(editor._availableScripts.filter((s) => s.axis === 'pitch')).toHaveLength(1);
  });

  it('switching between the main script and a new axis keeps each one\'s edits; one Save writes both', async () => {
    await openPlainClip();
    editor.editableScript.insertAction(12345, 55);              // the stroke, edited
    await editor._createAxis('twist');
    for (const p of two) editor.editableScript.insertAction(p.at, p.pos);
    editor._scriptSelect.value = MAIN;
    editor._scriptSelect.dispatchEvent(new Event('change'));
    await settle();
    expect(editor.editableScript.actions.some((a) => a.at === 12345)).toBe(true);
    expect(editor._dirtyAxisCount()).toBe(2);
    await editor._save();
    await settle();
    expect(JSON.parse(disk.get(MAIN)).actions.some((a) => a.at === 12345)).toBe(true);
    expect(JSON.parse(disk.get(companion('twist'))).actions).toEqual(two);
    expect(editor.hasUnsavedChanges()).toBe(false);
  });
});

describe('the pop-out asks, this editor does the work (multi-axis editing)', () => {
  it('axis-create makes the axis; lanes-wanted sends every other axis with its points as they are in memory', async () => {
    await openCombinedClip();
    const relayed = [];
    window.funsync.editorPopoutRelay = (dir, p) => relayed.push(p);
    editor._popoutOpen = true;
    editor._handlePopoutMessage({ type: 'axis-create', suffix: 'surge' });
    await settle();
    expect(editor._funscriptPath).toBe(`${MAIN}#embedded=surge`);
    editor.editableScript.insertAction(100, 10);
    editor.editableScript.insertAction(600, 90);
    editor._scriptSelect.value = MAIN;
    editor._scriptSelect.dispatchEvent(new Event('change'));
    await settle();
    editor._handlePopoutMessage({ type: 'lanes-wanted', on: true });
    await settle();
    const lanes = relayed.filter((m) => m.type === 'lanes').at(-1).lanes;
    // In the tracks' order, the one being edited marking its place (no points: it is this window's timeline).
    expect(lanes[0]).toMatchObject({ active: true, label: t('editor.mainAxisLabel') });
    expect(lanes[0].actions).toBeUndefined();
    expect(lanes.filter((l) => !l.active).map((l) => l.label)).toEqual([embeddedLabel('Twist'), embeddedLabel('Roll'), embeddedLabel('Pitch'), embeddedLabel('Surge')]);
    expect(lanes.find((l) => l.path.endsWith('=surge')).actions).toEqual([{ at: 100, pos: 10 }, { at: 600, pos: 90 }]);
    const list = relayed.filter((m) => m.type === 'scripts-changed').at(-1);
    expect(list.axisTools).toBe(true);
    expect(list.axesPresent.sort()).toEqual(['pitch', 'roll', 'surge', 'twist']);
    editor._popoutOpen = false;
  });
});

describe('the Handy previews only the stroke (multi-axis editing)', () => {
  it('a point placed on the main script moves it; on another axis it does not', async () => {
    await openCombinedClip();
    const hdspMove = vi.fn();
    editor.handyManager = { connected: true, hdspMove };
    editor.syncEngine = { _active: false };
    editor._sendLivePreview(70);
    expect(hdspMove).toHaveBeenCalledTimes(1);
    await pick(embeddedLabel('Twist'));
    editor._sendLivePreview(70);
    expect(hdspMove).toHaveBeenCalledTimes(1);
  });
});

// Save As (belgriffinite, EroScripts #439, 2026-11-24): a tweak saved as a
// new file, the original kept; from then on the editor edits the new file
// and playback follows it.
describe('Save As (#439)', () => {
  const PLAIN = JSON.stringify({ version: '1.0', actions: ramp(20, 0) });
  async function openPlain() {
    disk.set(MAIN, PLAIN);
    app._currentVideoName = 'Combined Clip.mp4';
    app._currentVideoPath = VIDEO;
    app._currentFunscriptPath = null;
    app._currentMultiAxis = null;
    editor.setFunscriptPath(null);
    editor.setAvailableScripts([]);
    await app.loadFunscript({ name: 'Combined Clip.funscript', textContent: PLAIN, _funscriptPath: MAIN });
  }
  const EDIT = `${DIR}\\Combined Clip (edit).funscript`;

  it('the main script: the new file has the edit, the original stays; Save then writes the new one; the engine plays it', async () => {
    await openPlain();
    const asked = [];
    window.funsync.saveFunscript = vi.fn(async (json, suggested) => { asked.push(suggested); disk.set(EDIT, json); return EDIT; });
    editor.editableScript.insertAction(12345, 66);
    await editor._saveAs();
    await settle();
    expect(asked).toEqual([EDIT]);                                   // opens in the script's folder, "(edit)"
    expect(disk.get(MAIN)).toBe(PLAIN);                              // the original untouched
    expect(JSON.parse(disk.get(EDIT)).actions.some((a) => a.at === 12345)).toBe(true);
    expect(editor._funscriptPath).toBe(EDIT);
    expect(editor.hasUnsavedChanges()).toBe(false);
    expect(app._currentFunscriptPath).toBe(EDIT);
    editor.editableScript.insertAction(23456, 11);
    await editor._save();
    expect(JSON.parse(disk.get(EDIT)).actions.some((a) => a.at === 23456)).toBe(true);
    expect(disk.get(MAIN)).toBe(PLAIN);
    expect(app.funscriptEngine.getActions().some((a) => a.at === 23456)).toBe(true);
  });

  it('a combined file: Save As writes the whole file (every axis) and the list follows it', async () => {
    await openCombinedClip();
    await pick(embeddedLabel('Roll'));
    editor.editableScript.insertAction(5000, 33);
    window.funsync.saveFunscript = vi.fn(async (json) => { disk.set(EDIT, json); return EDIT; });
    await editor._saveAs();
    await settle();
    expect(disk.get(MAIN)).toBe(MAIN_CONTENT);
    const saved = JSON.parse(disk.get(EDIT));
    expect(saved.version).toBe('2.0');
    expect(saved.channels.roll.actions).toContainEqual({ at: 5000, pos: 33 });
    expect(saved.channels.twist.actions).toEqual(EMBED.twist);
    expect(editor._funscriptPath).toBe(`${EDIT}#embedded=roll`);
    expect(editor._availableScripts.every((s) => !s.path.startsWith(MAIN))).toBe(true);
    expect(editor.hasUnsavedChanges()).toBe(false);
  });

  it('cancelled: nothing written, nothing moved', async () => {
    await openPlain();
    window.funsync.saveFunscript = vi.fn(async () => null);
    editor.editableScript.insertAction(12345, 66);
    await editor._saveAs();
    expect(editor._funscriptPath).toBe(MAIN);
    expect(editor.hasUnsavedChanges()).toBe(true);
    expect(disk.get(MAIN)).toBe(PLAIN);
  });

  it('Ctrl+Shift+S is Save As; Ctrl+S stays Save', async () => {
    await openPlain();
    editor._panel.removeAttribute('inert');           // open, as the user has it
    const spyAs = vi.spyOn(editor, '_saveAs').mockResolvedValue();
    const spySave = vi.spyOn(editor, '_save').mockResolvedValue();
    editor._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true, bubbles: true }));
    editor._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }));
    expect(spyAs).toHaveBeenCalledTimes(1);
    expect(spySave).toHaveBeenCalledTimes(1);
  });
});

// Editor work list 2.1 (2026-11-24): PageUp / PageDown step through the
// script list as OFS's keys do; each axis keeps its edits on the way.
describe('PageUp / PageDown (work list 2.1)', () => {
  const key = (k, extra = {}) => editor._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

  it('PageDown: the next script, PageUp: the previous, round the end; edits kept', async () => {
    await openCombinedClip();
    editor._panel.removeAttribute('inert');
    const list = editor._availableScripts.map((s) => s.path);
    expect(list.length).toBeGreaterThan(2);
    expect(editor._funscriptPath).toBe(list[0]);
    editor.editableScript.insertAction(7777, 42);
    key('PageDown'); await settle();
    expect(editor._funscriptPath).toBe(list[1]);
    key('PageUp'); await settle();
    expect(editor._funscriptPath).toBe(list[0]);
    expect(editor.editableScript.actions).toContainEqual({ at: 7777, pos: 42 });
    key('PageUp'); await settle();
    expect(editor._funscriptPath).toBe(list[list.length - 1]);
  });

  it('Shift+Del is ripple delete, a plain Del still deletes only', async () => {
    await openCombinedClip();
    editor._panel.removeAttribute('inert');
    const spyRipple = vi.spyOn(editor, '_rippleDelete');
    const spyDelete = vi.spyOn(editor, '_deleteSelected');
    key('Delete', { shiftKey: true });
    key('Delete');
    expect(spyRipple).toHaveBeenCalledTimes(1);
    expect(spyDelete).toHaveBeenCalledTimes(1);
  });
});

describe('hiding a lane, docked (work list 2.2)', () => {
  it('right-click > Hide takes it out; "Show 1 hidden lane" puts it back; another video shows all', async () => {
    await openCombinedClip();
    await editor._setStackedView(true);
    const lanes = () => [...document.querySelectorAll('.editor__stacked-lanes .editor__lane')];
    const n = lanes().length;
    expect(n).toBeGreaterThan(1);
    lanes()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    [...document.querySelectorAll('.editor-context-menu [role="menuitem"]')][0].click();
    await settle();
    expect(lanes()).toHaveLength(n - 1);
    expect(document.querySelector('.editor__lanes-show-hidden').textContent).toBe(t('editor.lanes.showHidden', { count: 1 }));
    document.querySelector('.editor__lanes-show-hidden').click();
    await settle();
    expect(lanes()).toHaveLength(n);
    editor._hiddenLanes.add(editor._availableScripts[1].path);
    editor.clearForVideoLoad();
    expect(editor._hiddenLanes.size).toBe(0);
    await editor._setStackedView(false);
  });
});

// Dave, 2026-11-24: "for more than 3 axis the stacked axis mode only shows 3
// max on editor ... you should be checking everything is size adaptable and
// fits on screen". The lanes area is sized so every lane fits (48 px each,
// down to 30, then it scrolls), the panel grows by it (the main graph keeps
// its height) but never so far that the video drops under 160 px, it follows
// the window, and stacked off gives the room back.
describe('stacked lanes fit the window (fit-on-screen pass)', () => {
  // Main is first, so its lanes are all in the box below the timeline.
  const box = () => document.querySelector('.editor__stacked-lanes--after');
  const extra = () => document.body.style.getPropertyValue('--editor-toolbar-extra');
  const setHeight = (h) => { Object.defineProperty(window, 'innerHeight', { value: h, configurable: true }); };
  it('room to spare: 48 px lanes, the panel grows by them', async () => {
    setHeight(900);
    await openCombinedClip();
    await editor._setStackedView(true);
    const n = document.querySelectorAll('.editor__lane').length;
    expect(n).toBe(3);
    expect(box().style.getPropertyValue('--lane-h')).toBe('48px');
    expect(box().style.height).toBe(`${n * 49 + 5}px`);
    expect(extra()).toBe(`${n * 49 + 5}px`);
    // Compact lane graphs.
    for (const lane of editor._inactiveLanes.values()) expect(lane.graph._compact).toBe(true);
    await editor._setStackedView(false);
    expect(extra()).toBe('0px');
  });
  it('a short window: the lanes shrink to 30 px and scroll, the video keeps 160 px; a resize re-fits them', async () => {
    setHeight(500);
    await openCombinedClip();
    await editor._setStackedView(true);
    // 500 - 250 (the panel) - 160 (the video) = 90 px for the lanes.
    expect(box().style.height).toBe('90px');
    expect(box().style.getPropertyValue('--lane-h')).toBe('30px');
    expect(getComputedStyleOverflow()).toBe('auto');
    setHeight(900);
    window.dispatchEvent(new Event('resize'));
    expect(box().style.height).toBe('152px');
    await editor._setStackedView(false);
    setHeight(768);
  });
  function getComputedStyleOverflow() {
    // editor.css is not loaded in jsdom: the rule itself is checked.
    const css = fs.readFileSync('renderer/styles/editor.css', 'utf8');
    const rule = css.slice(css.indexOf('.editor__stacked-lanes {'), css.indexOf('}', css.indexOf('.editor__stacked-lanes {')));
    return /overflow-y:\s*auto/.test(rule) ? 'auto' : 'visible';
  }
});

// Dave, 2026-11-24: "clicking any track in stacked view makes the script
// timeline zoom out fully ... why when i click a track does it take up the
// primary spot ... shouldnt the clicked track just expand ... and the other
// clicked off track contract? ... i didnt even notice the tracks swapped
// positions". The tracks keep the video's order: the one being edited is the
// timeline in its own place, the others lanes above and below it; a click
// keeps the zoom; every track's name is in the gutter.
describe('stacked tracks keep their order, and a click keeps the zoom', () => {
  /** Top to bottom: the lanes above, the timeline (its name), the lanes below. */
  const order = () => [
    ...[...document.querySelectorAll('.editor__stacked-lanes:not(.editor__stacked-lanes--after) .editor__lane-label')].map((n) => n.textContent),
    `[${document.querySelector('.editor__track-label')?.textContent}]`,
    ...[...document.querySelectorAll('.editor__stacked-lanes--after .editor__lane-label')].map((n) => n.textContent),
  ];
  const all = () => [t('editor.mainAxisLabel'), embeddedLabel('Twist'), embeddedLabel('Roll'), embeddedLabel('Pitch')];

  it('clicking a track edits it in its own place; the one left goes back to its place', async () => {
    await openCombinedClip();
    await editor._setStackedView(true);
    const [main, twist, roll, pitch] = all();
    expect(order()).toEqual([`[${main}]`, twist, roll, pitch]);
    const lane = [...document.querySelectorAll('.editor__lane')].find((l) => l.querySelector('.editor__lane-label').textContent === roll);
    lane.click();
    await settle();
    expect(editor._scriptSelect.selectedOptions[0].textContent).toBe(roll);
    expect(order()).toEqual([main, twist, `[${roll}]`, pitch]);
    [...document.querySelectorAll('.editor__lane')].find((l) => l.querySelector('.editor__lane-label').textContent === main).click();
    await settle();
    expect(order()).toEqual([`[${main}]`, twist, roll, pitch]);
    await editor._setStackedView(false);
  });

  // Dave, 2026-11-25: "you have to double click on a new track to use the up
  // down point navigation". The click left focus on the track's row, so the
  // editor's keys went to the player; the timeline takes the keys now.
  it('after a track click the keys go to the timeline: Up selects a point at once', async () => {
    await openCombinedClip();
    editor.show();                    // a closed editor takes no keys
    await editor._setStackedView(true);
    document.activeElement?.blur();
    expect(document.activeElement).not.toBe(editor._canvas);
    [...document.querySelectorAll('.editor__lane')][1].click();
    await settle();
    expect(document.activeElement).toBe(editor._canvas);
    editor.editableScript.clearSelection();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(editor.editableScript.selectedIndices.size).toBe(1);
    await editor._setStackedView(false);
  });

  it('a click keeps the zoom and the place (it zoomed right out)', async () => {
    await openCombinedClip();
    await editor._setStackedView(true);
    editor.graph.setViewport(400, 1500);
    const zoomed = [editor.graph.viewStartMs, editor.graph.viewEndMs];
    editor.graph.fitAll();
    const whole = [editor.graph.viewStartMs, editor.graph.viewEndMs];
    expect(zoomed).not.toEqual(whole);
    editor.graph.setViewport(...zoomed);
    [...document.querySelectorAll('.editor__lane')][1].click();
    await settle();
    expect([editor.graph.viewStartMs, editor.graph.viewEndMs]).toEqual(zoomed);
    for (const lane of editor._inactiveLanes.values()) expect([lane.graph.viewStartMs, lane.graph.viewEndMs]).toEqual(zoomed);
    await editor._setStackedView(false);
  });

  it('the names have a column: the timeline\'s gutter widens while stacked, and back after', async () => {
    await openCombinedClip();
    expect(editor.graph._padding.left).toBe(40);
    await editor._setStackedView(true);
    expect(editor.graph._padding.left).toBe(92);
    await editor._setStackedView(false);
    expect(editor.graph._padding.left).toBe(40);
    expect(document.querySelector('.editor__stacked-lanes--after')).toBeNull();
  });
});

// Dave, 2026-11-25: "do users have the option to export the track separately
// and combined? how clear is that" -> sections in the Export menu, Restore
// in History, and Save saying what it writes.
describe('export and save say what they do', () => {
  const heads = () => [...document.querySelectorAll('.editor-context-menu .editor-context-menu__heading')].map((h) => h.textContent);
  const items = () => [...document.querySelectorAll('.editor-context-menu [role="menuitem"]')].map((i) => i.textContent);

  it('Export: This script (Save as), Every axis (combined, separate); no Restore', async () => {
    await openCombinedClip();
    editor._btnExportAxes.click();
    expect(heads()).toEqual([t('editor.export.thisScript'), t('editor.export.everyAxis')]);
    expect(items()).toEqual([t('editor.export.saveAs'), t('editor.export.combined'), t('editor.export.separate')]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('History: the undo steps, then Saved versions with Restore an earlier version', async () => {
    await openCombinedClip();
    editor._btnHistory.click();
    expect(heads()).toEqual([t('editor.history.versionsGroup')]);
    expect(items().at(-1)).toBe(t('editor.backups.menuItem'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('Save says what it writes: into the combined file for a combined script', async () => {
    await openCombinedClip();
    editor._broadcastScriptsChanged();
    expect(editor._btnSave.title).toBe(t('editor.btn.saveCombined'));
    expect(editor._btnSave.getAttribute('aria-label')).toBe(t('editor.btn.saveCombined'));
    // Companion files (no axis inside the main file): each to its own file.
    editor.setAvailableScripts(editor._availableScripts.map((s) => ({ ...s, embeddedAxis: undefined })));
    editor._broadcastScriptsChanged();
    expect(editor._btnSave.title).toBe(t('editor.btn.saveEach'));
    // One script: plain Save.
    editor.setAvailableScripts([]);
    editor._broadcastScriptsChanged();
    expect(editor._btnSave.title).toBe(t('editor.btn.save'));
  });
});

// Fit-on-screen pass (2026-11-24): opened with E (not the player's button), an
// Up Next card already up stayed behind the editor until playback ticked.
// Every way in or out now tells the app, which pauses Up Next for an open
// editor and brings it back when it closes.
describe('Up Next pauses for the editor, however it opens', () => {
  it('show() and hide() (E calls them) pause and resume Up Next', () => {
    const start = APP_SRC.indexOf('this.scriptEditor.onOpenChange =');
    expect(start).toBeGreaterThan(-1);
    const end = APP_SRC.indexOf('};', start) + 2;
    // eslint-disable-next-line no-new-func
    new Function(APP_SRC.slice(start, end)).call(app);
    app.upNextEngine = { setSuppressed: vi.fn(), check: vi.fn() };
    editor.show();
    expect(app.upNextEngine.setSuppressed).toHaveBeenLastCalledWith(true);
    expect(app.upNextEngine.check).toHaveBeenCalled();
    editor.hide();
    expect(app.upNextEngine.setSuppressed).toHaveBeenLastCalledWith(false);
  });
});

describe('the stroke behind an axis (2.3) and Make from the stroke (2.4)', () => {
  it('on an axis the stroke is the graph\'s reference; on the stroke itself none; T hides and shows it', async () => {
    await openCombinedClip();
    expect(editor.graph.reference).toBeNull();
    await pick(embeddedLabel('Roll'));
    const strokeAts = JSON.parse(MAIN_CONTENT).actions.map((a) => a.at);
    expect(editor.graph.reference.map((a) => a.at)).toEqual(strokeAts);
    editor._panel.removeAttribute('inert');
    editor._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    expect(editor.graph.reference).toBeNull();
    editor._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    expect(editor.graph.reference).not.toBeNull();
  });

  it('Make from the stroke replaces the axis with the stroke, shifted, as one undo step', async () => {
    await openCombinedClip();
    await pick(embeddedLabel('Roll'));
    const before = editor.editableScript.actions.map((a) => ({ ...a }));
    const open = vi.spyOn(Modal, 'open').mockImplementation(async () => ({ shiftMs: 100, scalePct: 100, centre: 50, invert: true }));
    await editor._openAxisFromStrokeModal();
    open.mockRestore();
    const stroke = JSON.parse(MAIN_CONTENT).actions;
    expect(editor.editableScript.actions).toEqual(stroke.map((a) => ({ at: a.at + 100, pos: 100 - a.pos })));
    editor.editableScript.undo();
    expect(editor.editableScript.actions).toEqual(before);
  });

  it('on the stroke itself it only says to pick an axis', async () => {
    await openCombinedClip();
    const open = vi.spyOn(Modal, 'open');
    const notify = vi.fn();
    await editor._openAxisFromStrokeModal(notify);
    expect(open).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(t('editor.fromStroke.pickAxis'), 'info');
    open.mockRestore();
  });
});

describe('E twice (work list 5.5)', () => {
  it('E with nothing selected is left to the player (which closes the editor); with points selected it is Equalize', async () => {
    await openCombinedClip();
    editor._panel.removeAttribute('inert');
    editor.editableScript.clearSelection();
    const free = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    editor._canvas.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
    const eq = vi.spyOn(editor, '_equalizeSelected');
    editor.editableScript.select(0);
    editor.editableScript.toggleSelect(1);
    editor.editableScript.toggleSelect(2);
    const taken = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    editor._canvas.dispatchEvent(taken);
    expect(taken.defaultPrevented).toBe(true);
    expect(eq).toHaveBeenCalledTimes(1);
  });
});

describe('Restore an earlier version (work list 3.1)', () => {
  it('a version of the main script lands as one undo step; an axis in a combined file takes its own channel', async () => {
    await openCombinedClip();
    const before = editor.editableScript.actions.map((a) => ({ ...a }));
    const restored = [{ at: 100, pos: 10 }, { at: 900, pos: 90 }];
    expect(editor._restoreBackupContent(JSON.stringify({ version: '1.0', actions: restored }), vi.fn())).toBe(true);
    expect(editor.editableScript.actions).toEqual(restored);
    expect(editor.hasUnsavedChanges()).toBe(true);
    editor.editableScript.undo();
    expect(editor.editableScript.actions).toEqual(before);

    await pick(embeddedLabel('Roll'));
    expect(editor._backupFilePath()).toBe(MAIN);
    const roll = [{ at: 50, pos: 33 }, { at: 550, pos: 66 }];
    const combined = { version: '2.0', actions: restored, channels: { roll: { actions: roll } } };
    editor._restoreBackupContent(JSON.stringify(combined), vi.fn());
    expect(editor.editableScript.actions).toEqual(roll);
  });

  it('unreadable content changes nothing and says so', async () => {
    await openCombinedClip();
    const before = editor.editableScript.actions.map((a) => ({ ...a }));
    const notify = vi.fn();
    expect(editor._restoreBackupContent('{not json', notify)).toBe(false);
    expect(notify).toHaveBeenCalledWith(t('editor.backups.readFailed'), 'error');
    expect(editor.editableScript.actions).toEqual(before);
  });
});

describe('gamepad recording lands on two axes (work list 2.6)', () => {
  it('a take: left / right onto Roll (on screen), up / down onto Pitch (kept), one undo step each', async () => {
    await openCombinedClip();
    await pick(embeddedLabel('Roll'));
    const roll = editor._funscriptPath;
    const pitch = editor._availableScripts.find((s) => s.embeddedAxis === 'pitch').path;
    editor._gamepadTargets = { a: roll, b: pitch, mapping: { x: 'roll', y: 'pitch' } };
    const ramp = (from, to) => Array.from({ length: 31 }, (_, i) => ({ at: 20000 + i * 100, pos: Math.round(from + (to - from) * i / 30) }));
    await editor._landGamepadTakes([{ t0: 20000, t1: 23000, a: ramp(0, 100), b: ramp(100, 0) }]);
    const inTake = (acts) => acts.filter((a) => a.at >= 20000 && a.at <= 23000);
    expect(inTake(editor.editableScript.actions).length).toBeGreaterThanOrEqual(2);
    expect(inTake(editor.editableScript.actions)[0].pos).toBe(0);
    const keptPitch = editor._undoCache.get(pitch);
    expect(keptPitch.dirty).toBe(true);
    expect(inTake(keptPitch.state.actions)[0].pos).toBe(100);
    editor.editableScript.undo();
    expect(inTake(editor.editableScript.actions)).toEqual(inTake(JSON.parse(MAIN_CONTENT).channels?.roll?.actions || EMBED.roll || []));
  });
});

describe('Download all for the open video: the axes play at once (work list 6.4)', () => {
  it('axis files written beside the new main join the session\'s multi-axis set; nothing is written to the associations', async () => {
    await openCombinedClip();
    const main = `${DIR}\New.funscript`;
    const twist = `${DIR}\New.twist.funscript`;
    const surge = `${DIR}\New.surge.funscript`;
    disk.set(twist, JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 1000, pos: 90 }] }));
    disk.set(surge, JSON.stringify({ actions: [{ at: 0, pos: 30 }, { at: 1000, pos: 70 }] }));
    const loadSpy = vi.spyOn(app, '_loadMultiAxisScripts');
    const assocBefore = JSON.stringify(app.settings?.get?.('library.associations') || {});
    await app._loadDownloadedAxes(main, [main, twist, surge, `${DIR}\notes.txt`]);
    expect(app._currentMultiAxis).toMatchObject({ main, axes: { twist, surge } });
    expect(loadSpy).toHaveBeenCalledWith(app._currentMultiAxis);
    expect(JSON.stringify(app.settings?.get?.('library.associations') || {})).toBe(assocBefore);
  });

  it('only the main written: nothing changes', async () => {
    await openCombinedClip();
    const before = app._currentMultiAxis;
    await app._loadDownloadedAxes(`${DIR}\New.funscript`, [`${DIR}\New.funscript`]);
    expect(app._currentMultiAxis).toBe(before);
  });
});

describe('the simulator reads the editor\'s live axes (work list 2.5)', () => {
  it('getLiveAxisActions: the axis on screen, a kept axis with unsaved edits, null for one never opened', async () => {
    await openCombinedClip();
    expect(editor.getLiveAxisActions('roll')).toBeNull();          // not opened in the editor yet
    await pick(embeddedLabel('Roll'));
    editor.editableScript.insertAction(4321, 12);
    expect(editor.getLiveAxisActions('R1') ?? editor.getLiveAxisActions('roll')).toContainEqual({ at: 4321, pos: 12 });
    await pick(embeddedLabel('Twist'));
    expect(editor.getLiveAxisActions('roll')).toContainEqual({ at: 4321, pos: 12 });   // kept, unsaved
    expect(editor.getLiveAxisActions('nope')).toBeNull();
  });
});
