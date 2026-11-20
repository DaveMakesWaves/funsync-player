/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document,
 * reads the video path from #player-container, and script-editor.js imports
 * DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// Where the editor's points go, on the real app routes (R3 fix-up after the
// 2026-11-06 real-app checks). The REAL app.js load methods (lifted,
// helpers/app-methods.js) run against a REAL ScriptEditor wired as app.js
// wires it; what is asserted is what the editor shows and what lands in
// which file.
//
//   R3-20 (verifier 1): Variant Clip (44 points) loaded, then the scriptless
//   Untagged Wide, then the phone played Alpha Scene (the engine is the
//   phone's). E showed Variant Clip's 44 points with no path, and Save As
//   wrote them as "Untagged Wide.funscript". A video load only cleared the
//   editor's path; `_ensureFunscript()` emptied the stale points on the next
//   open, but returns early while the engine is loaded, and with a phone
//   session it always is.
//
//   Associated script (verifier 2, also in v0.9.2, DATA LOSS): Zulu Last
//   associated with "Variant Clip (soft).funscript" while "Zulu Last.funscript"
//   exists. The library route carries the script's file as `_funscriptPath`,
//   not `path`, so the editor was pointed at a DERIVED `<video>.funscript`: a
//   Save wrote the soft script's points over Zulu Last.funscript, a different
//   user file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { stripBOM } = await import('../../renderer/js/funscript-engine.js');
const { fillRawScriptContent } = await import('../../renderer/js/filler-engine.js');
const { resolveFillerOptions } = await import('../../renderer/js/filler-presets.js');
const {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} = await import('../../renderer/js/device-transform-stack.js');
const { vrDisplayName, funsyncVideoIdFromVRPath } = await import('../../renderer/js/vr-bridge.js');
const { normalizeAssociation, resolveActiveConfig } = await import('../../renderer/js/association-shape.js');
const { RemotePlaybackProxy } = await import('../../renderer/js/remote-playback-proxy.js');
const { pathToFileURL } = await import('../../renderer/js/path-utils.js');
const { SOURCE_PLAYER } = await import('../../renderer/js/audience-bridge.js');

const METHODS = [
  'loadVideo', 'loadFunscript', '_onRemotePhoneConnected', '_onRemotePhoneDisconnected', '_stopVRSync',
  '_audienceScriptContent', '_audienceLocalPlayerPlaying', '_fillerOptionsForUpload',
  '_uploadAndStartSync', '_handyUploadContent', '_handyInverted', '_cutoffFromSettings',
  '_editorAllowsReplace',
];

// The editor's toast, in the English the app starts in.
const NOT_SHOWN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')).editor.toast.remoteScriptNotShown;
const DIR = 'C:\\sandbox\\library\\';
const points = (n, step = 100) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 90 : 10 }));
const scriptOf = (n) => JSON.stringify({ version: '1.0', actions: points(n) });

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 60; this.playbackRate = 1; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

let disk;
let writes;
let saveAsCalls;

function build() {
  document.body.innerHTML = '<div id="player-container"></div><span id="video-title"></span><button id="btn-editor"></button>'
    + '<div id="funscript-badge"></div><div id="variant-selector"></div>';
  // app.js's own lookups get a harmless stand-in for any element this page
  // does not have; the editor reads the real #player-container.
  const appDocument = {
    getElementById: (id) => document.getElementById(id)
      || { hidden: false, innerHTML: '', textContent: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
  };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const Lifted = liftAppClass(METHODS, {
    window, document: appDocument, console: quiet,
    showToast, t: (k) => k, stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    vrDisplayName, funsyncVideoIdFromVRPath, normalizeAssociation, resolveActiveConfig,
    RemotePlaybackProxy, pathToFileURL, URL, SOURCE_PLAYER,
    maybeShowHevcGuidance: () => {}, isAutoMatch: () => false,
  });
  const S = { 'player.gapFiller': { enabled: false }, 'player.gapSkip': { mode: 'off' }, 'library.associations': {} };
  const video = new FakeVideo();
  const videoPlayer = Object.assign(new EventTarget(), {
    video, duration: 60, currentTime: 0, loadSource() {}, clearSubtitles() {},
  });
  const engine = {
    isLoaded: false,
    _actions: [],
    clear() { this.isLoaded = false; this._actions = []; },
    loadContent: vi.fn(async function (content) {
      this.isLoaded = true;
      this._actions = JSON.parse(content).actions;
      return { filename: 'x', actionCount: this._actions.length };
    }),
    loadFile: vi.fn(async function () { this.isLoaded = true; return { filename: 'x', actionCount: 0 }; }),
    getActions() { return this._actions.map((a) => ({ ...a })); },
    getMetadata: () => null,
    getChapters: () => [],
    getBookmarks: () => [],
    reloadActions: vi.fn(),
  };
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: () => {}, addRecentFile() {} },
    videoPlayer,
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {}, renderHeatmap() {} },
    funscriptEngine: engine,
    handyManager: null, autoblowManager: null, audienceBridge: null,
    buttplugSync: null, tcodeSync: null, autoblowSync: null, syncEngine: null, handyHdspSync: null,
    remoteBridge: { sendToPhone() {}, connected: true }, sessionTracker: null, vrBridge: null, library: null,
    _videoLoadGen: 0, _pendingFunscripts: [], _customRoutingActive: false,
    _currentVariants: [], _allVariantsWithManual: [], _activeVariantIndex: 0,
    _remoteActive: false, _playerWindowActive: false, _vrPlayerRef: null,
    _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    _engineHeldByRemote: false, // as the constructor sets it
    _maybePushCurrentToHistory() {}, _ensureVideoLoadWatch() {}, _disarmLoadAutoplay() {},
    _stopGapSkip() {}, _startGapSkip() {}, _clearCloudUploadGate() {}, _hideScriptLoadingOverlay() {},
    _showScriptLoadingOverlay() {}, _feedInlineViz() {}, _navigateTo() {}, _updateCategoryDots() {},
    _updateQueuePanelState() {}, _applyVRFlattenForCurrent() {}, _autoMatchEroScripts() {},
    _feedEmbeddedMultiAxis() {}, _showFunscriptBadge() {}, _refreshEditorScriptList() {},
    _isDeviceOnMainRoute: () => true, _resolveCloudUpload() {},
    _tryStartButtplugSync() {}, _tryStartTCodeSync() {}, _tryStartAutoblowSync: async () => {},
    _updateVariantSelector() {}, _loadMultiAxisScripts() {}, _loadSubtitleFromLibrary() {},
    _applyPreferredVariant: async () => {}, _formatActionsDuration: () => '0:00',
    _healManualVariantPath() {}, _markCloudUploadsPending() {},
    _resetCustomRoutingState() {}, _pushRemoteDeviceStatus() {}, _refreshLoopVideoVisibility() {},
    _settleVRVideoSyncOffset() {}, _applyVideoSyncOffset() {},
  });
  // The REAL editor, with the REAL options app.js hands it.
  const opts = liftCtorOptions('ScriptEditor', {}).call(app);
  app.scriptEditor = new ScriptEditor({
    videoPlayer,
    funscriptEngine: engine,
    progressBar: app.progressBar,
    settings: { get: () => undefined, set() {} },
    syncEngine: { stop: vi.fn(), start: vi.fn() },
    handyManager: { connected: false },
    engineHeldByRemote: opts.engineHeldByRemote,
  });
  app.scriptEditor._sendLivePreview = () => {};
  return app;
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A library click: the video, then its script as Library.resolvePlayData reads it. */
async function libraryOpen(app, name, scriptFile) {
  app.loadVideo({ name: `${name}.mp4`, path: `${DIR}${name}.mp4`, _isPathBased: true }, { autoPlay: false });
  if (scriptFile) {
    const p = `${DIR}${scriptFile}`;
    await app.loadFunscript({ name: scriptFile, textContent: disk[p], _funscriptPath: p });
  }
  await settle();
}

/** The phone plays `name`: its script goes into the shared engine. */
async function phonePlays(app, name) {
  const p = `${DIR}${name}.mp4`;
  app.library = { _videosByPath: new Map([[p, { name, hasFunscript: true, funscriptPath: `${DIR}${name}.funscript`, variants: [] }]]) };
  await app._onRemotePhoneConnected('192.168.1.5', 'id', p);
  await settle();
}

beforeEach(() => {
  showToast.mockClear();
  disk = {
    [`${DIR}Variant Clip.funscript`]: scriptOf(44),
    [`${DIR}Alpha Scene.funscript`]: scriptOf(37),
    [`${DIR}Zulu Last.funscript`]: scriptOf(21),
    [`${DIR}Variant Clip (soft).funscript`]: scriptOf(22),
  };
  writes = [];
  saveAsCalls = [];
  window.funsync = {
    filesExist: async (paths) => paths.map((p) => p in disk),
    readFunscript: async (p) => disk[p] ?? null,
    writeFunscript: async (json, p) => { writes.push(p); disk[p] = json; return p; },
    saveFunscript: async (json, name) => {
      saveAsCalls.push(name);
      const p = `${DIR}verify-artifacts\\${name}`;
      writes.push(p);
      disk[p] = json;
      return p;
    },
  };
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('a phone session never puts the previous video\'s points in this video\'s file (R3-20 fix-up)', () => {
  it('Variant Clip, then the scriptless Untagged Wide, then the phone plays Alpha: E shows none of the 44 points', async () => {
    const app = build();
    await libraryOpen(app, 'Variant Clip', 'Variant Clip.funscript');
    expect(app.scriptEditor.editableScript.actionCount).toBe(44); // as the editor loads it on every script load
    await libraryOpen(app, 'Untagged Wide', null);
    await phonePlays(app, 'Alpha Scene');
    expect(app.funscriptEngine.getActions()).toHaveLength(37);
    expect(app._engineHeldByRemote).toBe(true);

    app.scriptEditor.show();
    await settle();
    expect(app.scriptEditor.editableScript.actionCount).toBe(0);
    expect(app.scriptEditor._funscriptPath).toBe(null);
    expect(showToast).toHaveBeenCalledWith(NOT_SHOWN, 'info', 6000);
  });

  it('a Save there writes only the point drawn for Untagged Wide, and the phone\'s engine keeps its 37', async () => {
    const app = build();
    await libraryOpen(app, 'Variant Clip', 'Variant Clip.funscript');
    await libraryOpen(app, 'Untagged Wide', null);
    await phonePlays(app, 'Alpha Scene');
    app.scriptEditor.show();
    await settle();
    app.scriptEditor.editableScript.insertAction(1500, 60);
    await app.scriptEditor._save();
    await settle();
    expect(saveAsCalls).toEqual(['Untagged Wide.funscript']);
    const saved = JSON.parse(disk[writes.at(-1)]);
    expect(saved.actions).toEqual([{ at: 1500, pos: 60 }]);
    expect(disk[`${DIR}Variant Clip.funscript`]).toBe(scriptOf(44));
    expect(app.funscriptEngine.getActions()).toHaveLength(37);
  });

  it('with the editor popped out, the pop-out shows the NEW video\'s script after a load, never the old one\'s', async () => {
    const app = build();
    await libraryOpen(app, 'Variant Clip', 'Variant Clip.funscript');
    const relayed = [];
    window.funsync.editorPopoutRelay = (dir, payload) => { if (dir === 'to-popout') relayed.push(payload); };
    app.scriptEditor._popoutOpen = true;
    await libraryOpen(app, 'Zulu Last', 'Zulu Last.funscript');
    const last = relayed.filter((m) => m.type === 'actions-changed').at(-1);
    expect(last.actions).toHaveLength(21);
    expect(last.path).toBe(`${DIR}Zulu Last.funscript`);
    // A scriptless video next: the pop-out is emptied, not left on Zulu's.
    await libraryOpen(app, 'Untagged Wide', null);
    expect(relayed.filter((m) => m.type === 'actions-changed').at(-1).actions).toEqual([]);
  });

  it('with no phone, a scriptless video after a scripted one still opens empty, as before', async () => {
    const app = build();
    await libraryOpen(app, 'Variant Clip', 'Variant Clip.funscript');
    await libraryOpen(app, 'Untagged Wide', null);
    app.scriptEditor.show();
    await settle();
    expect(app.scriptEditor.editableScript.actionCount).toBe(0);
  });
});

describe('a Save writes the script that was opened, never another file of the video\'s name (R3 fix-up, data loss)', () => {
  it('Zulu Last associated with the soft script: Save writes the soft script, Zulu Last.funscript is untouched', async () => {
    const app = build();
    const own = disk[`${DIR}Zulu Last.funscript`];
    await libraryOpen(app, 'Zulu Last', 'Variant Clip (soft).funscript');
    expect(app.scriptEditor.editableScript.actionCount).toBe(22);
    app.scriptEditor.editableScript.insertAction(9900, 40);
    await app.scriptEditor._save();
    await settle();
    expect(writes).toEqual([`${DIR}Variant Clip (soft).funscript`]);
    expect(JSON.parse(disk[`${DIR}Variant Clip (soft).funscript`]).actions).toHaveLength(23);
    expect(disk[`${DIR}Zulu Last.funscript`]).toBe(own);
  });

  it('the video\'s own script by the library route: Save writes it, as before', async () => {
    const app = build();
    await libraryOpen(app, 'Zulu Last', 'Zulu Last.funscript');
    app.scriptEditor.editableScript.insertAction(9900, 40);
    await app.scriptEditor._save();
    expect(writes).toEqual([`${DIR}Zulu Last.funscript`]);
    expect(JSON.parse(disk[`${DIR}Zulu Last.funscript`]).actions).toHaveLength(22);
  });

  it('a script read with no path at all still saves beside the video', async () => {
    const app = build();
    app.loadVideo({ name: 'Zulu Last.mp4', path: `${DIR}Zulu Last.mp4`, _isPathBased: true }, { autoPlay: false });
    await app.loadFunscript({ name: 'x.funscript', textContent: scriptOf(5) });
    await settle();
    expect(app.scriptEditor._funscriptPath).toBe(`${DIR}Zulu Last.funscript`);
  });
});
