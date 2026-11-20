/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document,
 * and script-editor.js imports DOM-branching modules (notes/CLAUDE.md
 * "Test environments").
 */
// FT-094 (2026-11-07; also in v0.9.2): an editor save never reached Audience
// viewers. Ctrl+S / autosave reloaded the edit into the engine and re-uploaded
// it to the streamer's OWN Handy (`onReuploadHandy`), which returns early with
// no streamer Handy, and nothing told the room: viewers kept playing the
// pre-edit script of the same video until the next video or variant.
//
// The save goes through the REAL ScriptEditor (`_save`, `_autosave`: write,
// reload into the REAL FunscriptEngine, `funscript:saved` on the REAL bus) and
// the REAL app.js listener (lifted, helpers/app-methods.js); the room is the
// REAL AudienceBridge with viewer HandyManagers faked to the real contract.
// What is asserted is the script each viewer was set up with, and whether it
// plays.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';
import { makeWorld, makeFakeHandyCtor, deviceOf } from './helpers/fake-viewer-handy.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { FunscriptEngine, stripBOM } = await import('../../renderer/js/funscript-engine.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { AudienceBridge, SOURCE_PLAYER, VIEWER_STATUS } = await import('../../renderer/js/audience-bridge.js');
const { fillRawScriptContent } = await import('../../renderer/js/filler-engine.js');
const { resolveFillerOptions } = await import('../../renderer/js/filler-presets.js');
const {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} = await import('../../renderer/js/device-transform-stack.js');
const { normalizeAssociation, resolveActiveConfig } = await import('../../renderer/js/association-shape.js');
const { pathToFileURL, canonicalPath } = await import('../../renderer/js/path-utils.js');

const METHODS = [
  'loadVideo', 'loadFunscript',
  '_audienceScriptContent', '_audienceLocalPlayerPlaying', '_fillerOptionsForUpload',
  '_uploadAndStartSync', '_handyUploadContent', '_handyInverted', '_cutoffFromSettings',
  '_editorAllowsReplace',
  // FT-094
  '_wireAudienceEditorSaves', '_onEditorSavedForAudience', '_isLocalMainScriptPath',
];

const DIR = 'C:\\sandbox\\library\\';
const MAIN = `${DIR}Variant Clip.funscript`;
const ROLL = `${DIR}Variant Clip.roll.funscript`;
const script = (pos1 = 90) => JSON.stringify({
  version: '1.0',
  actions: [{ at: 0, pos: 10 }, { at: 300, pos: pos1 }, { at: 600, pos: 10 }, { at: 900, pos: 90 }],
});

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 60; this.playbackRate = 1; }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}

let disk;
let uploads;
let wired;

function build() {
  document.body.innerHTML = '<div id="player-container"></div><span id="video-title"></span><button id="btn-editor"></button>'
    + '<div id="funscript-badge"></div><div id="variant-selector"></div>';
  const appDocument = {
    getElementById: (id) => document.getElementById(id)
      || { hidden: false, innerHTML: '', textContent: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
  };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const Lifted = liftAppClass(METHODS, {
    window, document: appDocument, console: quiet, eventBus,
    showToast, t: (k) => k, stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    normalizeAssociation, resolveActiveConfig, pathToFileURL, canonicalPath, URL, SOURCE_PLAYER,
    AUDIENCE_EDIT_RESEND_MS: 1500,
    maybeShowHevcGuidance: () => {}, isAutoMatch: () => false,
  });
  const S = { 'player.gapFiller': { enabled: false }, 'player.gapSkip': { mode: 'off' }, 'library.associations': {} };
  const video = new FakeVideo();
  const videoPlayer = Object.assign(new EventTarget(), {
    video, duration: 60, currentTime: 0, loadSource() {}, clearSubtitles() {},
  });
  const engine = new FunscriptEngine({ backendPort: 0 });
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: () => {}, addRecentFile() {} },
    videoPlayer,
    progressBar: { clearHeatmap() {}, setGaps() {}, setMarkers() {}, setVideoSource() {}, renderHeatmap() {}, renderChapterStrip() {} },
    funscriptEngine: engine,
    handyManager: null, autoblowManager: null, // NO streamer Handy: viewers must not depend on it
    buttplugSync: null, tcodeSync: null, autoblowSync: null, syncEngine: null, handyHdspSync: null,
    remoteBridge: null, sessionTracker: null, vrBridge: null, library: null,
    _videoLoadGen: 0, _pendingFunscripts: [], _customRoutingActive: false,
    _currentVariants: [], _allVariantsWithManual: [], _activeVariantIndex: 0,
    _remoteActive: false, _playerWindowActive: false, _vrPlayerRef: null,
    _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    _engineHeldByRemote: false,
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
  // The REAL room, from the REAL options app.js hands it; a keyless uploader
  // that gives every upload its own URL and keeps what it was sent.
  const world = makeWorld();
  const upload = async (content) => { uploads.push(content); return `https://scripts.test/${uploads.length}`; };
  const options = liftCtorOptions('AudienceBridge', {
    eventBus: { emit() {} }, HandyManager: makeFakeHandyCtor(world), uploadScriptToCloud: upload,
  }).call(app);
  app.audienceBridge = new AudienceBridge(options);
  video.addEventListener('playing', () => app.audienceBridge.onPlaying());
  video.addEventListener('pause', () => app.audienceBridge.onPaused());
  // The REAL editor with the REAL options app.js hands it.
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
  // As app.js init wires it, once the room exists.
  app._wireAudienceEditorSaves();
  wired = true;
  return { app, world, video };
}

const settle = () => vi.advanceTimersByTimeAsync(50);
const later = (ms) => vi.advanceTimersByTimeAsync(ms);

async function openRoom(ctx) {
  ctx.app.audienceBridge.openRoom();
  const p = ctx.app.audienceBridge.addViewer({ key: 'VIEWERKEY01' });
  await vi.runAllTimersAsync();
  await p;
}

/** A library click on Variant Clip: the video, then its script. */
async function openVariantClip(ctx) {
  ctx.app.loadVideo({ name: 'Variant Clip.mp4', path: `${DIR}Variant Clip.mp4`, _isPathBased: true }, { autoPlay: false });
  await ctx.app.loadFunscript({ name: 'Variant Clip.funscript', textContent: disk[MAIN], _funscriptPath: MAIN });
  await vi.runAllTimersAsync();
}

/** What the viewer's device holds now, parsed back to the point at 300 ms. */
function viewerPointAt300(ctx) {
  const url = deviceOf(ctx.world, 'VIEWERKEY01').url;
  const n = Number(String(url || '').split('/').pop());
  if (!n) return null;
  return JSON.parse(uploads[n - 1]).actions.find((a) => a.at === 300)?.pos ?? null;
}

const setupsSent = (ctx) => ctx.world.sent.filter((e) => e.kind === 'setup').length;

beforeEach(() => {
  vi.useFakeTimers();
  showToast.mockClear();
  disk = { [MAIN]: script(90), [ROLL]: script(70) };
  uploads = [];
  window.funsync = {
    readFunscript: vi.fn(async (p) => disk[p] ?? null),
    // The editor's write: the file on disk takes the edit.
    writeFunscript: vi.fn(async (json, p) => { disk[p] = json; return p; }),
    saveFunscript: vi.fn(async () => null),
    convertFunscript: vi.fn(async () => null),
  };
});

afterEach(() => {
  if (wired) eventBus.removeAll('funscript:saved');
  wired = false;
  vi.useRealTimers();
});

describe('FT-094: an editor save reaches Audience viewers', () => {
  it('Ctrl+S on the playing script: viewers are stopped, set up with the EDITED script, and play it', async () => {
    const ctx = build();
    await openRoom(ctx);
    await openVariantClip(ctx);
    ctx.video.play();
    await vi.runAllTimersAsync();
    expect(viewerPointAt300(ctx)).toBe(90);
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);

    // Nudge the point at 300 ms from 90 to 33 and save.
    ctx.app.scriptEditor.editableScript.updateAction(1, { pos: 33 });
    await ctx.app.scriptEditor._save();
    expect(JSON.parse(disk[MAIN]).actions[1].pos).toBe(33);   // the file has it
    await later(1600);
    await vi.runAllTimersAsync();

    expect(viewerPointAt300(ctx)).toBe(33);
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);
    expect(ctx.app.audienceBridge.getViewerStatus('VIEWERKEY01')).toBe(VIEWER_STATUS.PLAYING);
    // A stop came before the new setup (never the old script under the edit).
    const kinds = ctx.world.sent.map((e) => e.kind);
    const lastSetup = kinds.lastIndexOf('setup');
    expect(kinds.slice(0, lastSetup).lastIndexOf('stop')).toBeGreaterThan(kinds.indexOf('play'));
  });

  // verify-2 / review 2026-11-07: an UNCHANGED Ctrl+S while playing stopped
  // every viewer, set the same script up again and replayed it ~1.5 s later:
  // a 1-3 s gap per viewer on a real Handy, for no edit.
  it('an unchanged Ctrl+S while playing: viewers keep playing, nothing is stopped, set up or replayed', async () => {
    const ctx = build();
    await openRoom(ctx);
    await openVariantClip(ctx);
    ctx.video.play();
    await vi.runAllTimersAsync();
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);
    const sentBefore = ctx.world.sent.length;

    await ctx.app.scriptEditor._save();   // nothing edited
    await later(1600);
    await vi.runAllTimersAsync();
    expect(ctx.world.sent.slice(sentBefore)).toEqual([]);
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);

    // A real edit after it still goes out (the check is per content).
    ctx.app.scriptEditor.editableScript.updateAction(1, { pos: 21 });
    await ctx.app.scriptEditor._save();
    await later(1600);
    await vi.runAllTimersAsync();
    expect(viewerPointAt300(ctx)).toBe(21);
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);
  });

  it('paused: viewers are set up with the edit and stay stopped until this window plays', async () => {
    const ctx = build();
    await openRoom(ctx);
    await openVariantClip(ctx);
    ctx.app.scriptEditor.editableScript.updateAction(1, { pos: 44 });
    await ctx.app.scriptEditor._save();
    await later(1600);
    await vi.runAllTimersAsync();
    expect(viewerPointAt300(ctx)).toBe(44);
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(false);
    ctx.video.play();
    await vi.runAllTimersAsync();
    expect(deviceOf(ctx.world, 'VIEWERKEY01').playing).toBe(true);
  });

  it('autosave after every pause in editing: one setup once the saves go quiet, with the last edit', async () => {
    const ctx = build();
    await openRoom(ctx);
    await openVariantClip(ctx);
    const before = setupsSent(ctx);
    for (const pos of [20, 30, 40]) {
      ctx.app.scriptEditor.editableScript.updateAction(1, { pos });
      await ctx.app.scriptEditor._autosave();
      await later(1000);
    }
    expect(setupsSent(ctx)).toBe(before);   // still editing
    await later(600);
    await vi.runAllTimersAsync();
    expect(setupsSent(ctx)).toBe(before + 1);
    expect(viewerPointAt300(ctx)).toBe(40);
  });

  it('a companion file\'s save sends viewers nothing', async () => {
    const ctx = build();
    await openRoom(ctx);
    await openVariantClip(ctx);
    const before = setupsSent(ctx);
    const ed = ctx.app.scriptEditor;
    ed.setFunscriptPath(ROLL);
    ed.editableScript.loadFromData(JSON.parse(disk[ROLL]));
    ed.editableScript.updateAction(1, { pos: 11 });
    await ed._save();
    expect(JSON.parse(disk[ROLL]).actions[1].pos).toBe(11);
    await later(1600);
    await vi.runAllTimersAsync();
    expect(setupsSent(ctx)).toBe(before);
    expect(viewerPointAt300(ctx)).toBe(90);
  });

  it('a save while the phone or a headset drives sends viewers nothing', async () => {
    for (const drive of ['phone', 'vr']) {
      const ctx = build();
      await openRoom(ctx);
      await openVariantClip(ctx);
      const before = setupsSent(ctx);
      // The engine holds the remote's script (R3-20); the editor keeps this window's.
      ctx.app._engineHeldByRemote = true;
      if (drive === 'phone') ctx.app._remoteActive = true;
      else ctx.app._vrPlayerRef = {};
      ctx.app.scriptEditor.editableScript.updateAction(1, { pos: 55 });
      await ctx.app.scriptEditor._save();
      await later(1600);
      await vi.runAllTimersAsync();
      expect(setupsSent(ctx)).toBe(before);
      eventBus.removeAll('funscript:saved');
    }
  });

  it('the same video opened again right after the save: its own load sets viewers up once, no second send', async () => {
    const ctx = build();
    await openRoom(ctx);
    await openVariantClip(ctx);
    ctx.app.scriptEditor.editableScript.updateAction(1, { pos: 77 });
    await ctx.app.scriptEditor._save();
    const before = setupsSent(ctx);
    await openVariantClip(ctx);          // reads the saved file, edit included
    await later(1600);
    await vi.runAllTimersAsync();
    expect(setupsSent(ctx)).toBe(before + 1);
    expect(viewerPointAt300(ctx)).toBe(77);
  });

  it('a new video opened right after the save: the old video\'s edit is not sent over it', async () => {
    const ctx = build();
    await openRoom(ctx);
    await openVariantClip(ctx);
    ctx.app.scriptEditor.editableScript.updateAction(1, { pos: 66 });
    await ctx.app.scriptEditor._save();
    disk[`${DIR}Other.funscript`] = script(12);
    ctx.app.loadVideo({ name: 'Other.mp4', path: `${DIR}Other.mp4`, _isPathBased: true }, { autoPlay: false });
    await ctx.app.loadFunscript({ name: 'Other.funscript', textContent: disk[`${DIR}Other.funscript`], _funscriptPath: `${DIR}Other.funscript` });
    await later(1600);
    await vi.runAllTimersAsync();
    expect(viewerPointAt300(ctx)).toBe(12);
    expect(uploads.some((c) => JSON.parse(c).actions[1].pos === 66)).toBe(false);
  });
});
