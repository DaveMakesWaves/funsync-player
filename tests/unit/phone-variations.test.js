// FN-04 (Dave 2026-11-16: "yes variations should show on phone"; also in
// v0.9.2): the phone listed only the library scan's variations. The
// hand-added ones (`library.manualVariants`, + Add variation / the Associate
// dialog) never reached /api/remote/videos, so the phone could not show,
// pick or start on them, and a pinned hand-added variation was ignored by a
// phone session (E-09 started only one the phone listed).
//
// Driven through the REAL Library._registerWithBackend (what the backend,
// and so the phone, is sent), the REAL DataService and event bus, the REAL
// app.js methods (lifted, helpers/app-methods.js): `_wireGroupingsRegister`,
// the phone session (`_onRemotePhoneConnected`, `_phonePinnedVariant`,
// `_phoneVariantList`, `_handlePhoneSwitchVariant`, `_switchVariant`) and the
// desktop menu (`_updateVariantSelector`). Fakes: the backend, the disk and
// the Handy (`uploadAndSetScript` / `hsspStop`, as handy-manager.js has them).
// Asserted: the POST bodies, what the engine and the Handy are given, what
// the phone is told, and that listing writes nothing.
//
// jsdom on purpose (no node docblock): library.js imports modules that branch
// on `typeof window`. See notes/CLAUDE.md "Test environments".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APP_SRC, liftMethod } from './helpers/app-methods.js';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { remoteVariantList } from '../../renderer/js/variant-names.js';
import { pickVariantIndexOnLoad } from '../../renderer/js/variant-select.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} from '../../renderer/js/device-transform-stack.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { SOURCE_PLAYER } from '../../renderer/js/audience-bridge.js';

const PORT = 5123;
const VIDEO = 'C:/FakeLib/v/Clip.mp4';
const MAIN = 'C:/FakeLib/v/Clip.funscript';
const SOFT = 'C:/FakeLib/v/Clip (soft).funscript';
const HARD = 'C:/FakeLib/scripts/Clip hard remix.funscript';
const AMP = 'C:/FakeLib/scripts/Clip slow and soft.funscript';
const OTHER = 'C:/FakeLib/v/Other.mp4';
const OTHER_MAIN = 'C:/FakeLib/v/Other.funscript';
const OTHER_MANUAL = 'C:/FakeLib/scripts/Other extra.funscript';
const LONE = 'C:/FakeLib/v/Lone.mp4';
const LONE_MAIN = 'C:/FakeLib/v/Lone HD.funscript';           // fuzzy-paired: the scan gives no list
const LONE_MANUAL = 'C:/FakeLib/scripts/Lone alt.funscript';

const SCANNED = () => [
  { label: 'Default', path: MAIN, name: 'Clip.funscript' },
  { label: 'soft', path: SOFT, name: 'Clip (soft).funscript' },
];
const MANUAL = () => ({
  [VIDEO]: [
    { label: 'Hard Remix', path: HARD, name: 'Clip hard remix.funscript' },
    // Free text, as a user types it: the phone's URL must survive it.
    { label: 'Slow & Soft+', path: AMP, name: 'Clip slow and soft.funscript' },
    // Already in the scan's list (same path): the desktop menu shows it once.
    { label: 'dup of soft', path: SOFT, name: 'Clip (soft).funscript' },
  ],
  [OTHER]: [{ label: 'Extra', path: OTHER_MANUAL, name: 'Other extra.funscript' }],
  [LONE]: [{ label: 'Alt', path: LONE_MANUAL, name: 'Lone alt.funscript' }],
});

const script = (label) => JSON.stringify({ version: '1.0', _label: label, actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }] });
const labelOf = (c) => { try { return JSON.parse(c)._label; } catch { return null; } };

/** A backend that records every /api/media/register body. */
function fakeBackend() {
  const backend = { registers: [] };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    if (String(url).endsWith('/api/media/register')) backend.registers.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return backend;
}

function realDataService(manual = MANUAL()) {
  const ds = new DataService();
  ds._cache = {
    settings: {
      backend: { port: PORT },
      library: { sources: [{ id: 's1', name: 'Main', path: 'C:/FakeLib/v', enabled: true }], collections: [], manualVariants: manual },
    },
    playlists: [], categories: [], videoCategories: {},
  };
  ds._initialized = true;
  return ds;
}

function libraryVideos() {
  return [
    { path: VIDEO, name: 'Clip.mp4', hasFunscript: true, funscriptPath: MAIN, variants: SCANNED() },
    { path: OTHER, name: 'Other.mp4', hasFunscript: true, funscriptPath: OTHER_MAIN, variants: [] },
    { path: LONE, name: 'Lone.mp4', hasFunscript: true, funscriptPath: LONE_MAIN, variants: [] },
    { path: 'C:/FakeLib/v/Plain.mp4', name: 'Plain.mp4', hasFunscript: true, funscriptPath: 'C:/FakeLib/v/Plain.funscript', variants: [] },
  ];
}

function realLibrary(settings, videos = libraryVideos()) {
  const lib = Object.create(Library.prototype);
  lib._settings = settings;
  lib._videos = videos;
  lib._videosByPath = new Map(videos.map((v) => [v.path, v]));
  return lib;
}

/** The variation list the backend was last sent for one video. */
const sentVariants = (backend, path) => backend.registers.filter((r) => r.videos).at(-1)
  .videos.find((v) => v.path === path).variants;

describe('FN-04: the backend (so the phone) is sent the desktop\'s variation list, hand-added ones included', () => {
  let backend;
  let settings;

  beforeEach(() => {
    backend = fakeBackend();
    window.funsync = new Proxy({ setSetting: vi.fn() }, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)) });
    settings = realDataService();
  });

  afterEach(() => {
    delete globalThis.fetch;
    delete window.funsync;
  });

  it('the scan\'s entries, then the hand-added ones in their order, a duplicate path once, each named as the desktop names it', async () => {
    realLibrary(settings)._registerWithBackend();
    await vi.waitFor(() => expect(backend.registers.length).toBe(1));
    expect(sentVariants(backend, VIDEO)).toEqual([
      { label: 'Default', path: MAIN, name: 'Clip.funscript', text: 'Clip', main: true },
      { label: 'soft', path: SOFT, name: 'Clip (soft).funscript', text: 'soft', main: false },
      { label: 'Hard Remix', path: HARD, name: 'Clip hard remix.funscript', text: 'Hard Remix', main: false },
      { label: 'Slow & Soft+', path: AMP, name: 'Clip slow and soft.funscript', text: 'Slow & Soft+', main: false },
    ]);
  });

  it('a video whose scan gave no list gets its own script first, named by its file and marked main', async () => {
    realLibrary(settings)._registerWithBackend();
    await vi.waitFor(() => expect(backend.registers.length).toBe(1));
    expect(sentVariants(backend, LONE).map((v) => [v.text, v.path, v.main])).toEqual([
      ['Lone HD', LONE_MAIN, true],
      ['Alt', LONE_MANUAL, false],
    ]);
    expect(sentVariants(backend, OTHER).map((v) => v.text)).toEqual(['Other', 'Extra']);
    // Nothing to choose: nothing is invented.
    expect(sentVariants(backend, 'C:/FakeLib/v/Plain.mp4')).toEqual([]);
  });

  it('the list is the same, in the same order, as the desktop\'s own menu for that video', async () => {
    realLibrary(settings)._registerWithBackend();
    await vi.waitFor(() => expect(backend.registers.length).toBe(1));
    const Menu = new Function('t', 'document', `return class { ${['_updateVariantSelector', '_variantLabelText'].map((n) => liftMethod(APP_SRC, n)).join('\n')} };`)(
      (k) => k, { getElementById: () => ({ hidden: false, textContent: '' }) },
    );
    for (const [path, base, mainPath] of [[VIDEO, SCANNED(), MAIN], [LONE, [], LONE_MAIN]]) {
      const app = Object.assign(new Menu(), {
        _currentVideoPath: path, _currentVariants: base, _variantsPhoneEpoch: null,
        _videoLoadGen: 1, _mainScript: { gen: 1, path: mainPath },
        _activeVariantPath: null, _activeVariantIndex: 0, _engineHeldByRemote: false,
        funscriptEngine: { isLoaded: true, getRawContent: () => '{}' },
        scriptEditor: { _funscriptPath: mainPath },
        _manualVariantsFor: (p) => settings.get('library.manualVariants')[p] || [],
      });
      app._updateVariantSelector();
      const desktop = app._allVariantsWithManual.map((v, i) => [v.path, app._variantLabelText(v), i === app._mainVariantIndex]);
      expect(sentVariants(backend, path).map((v) => [v.path, v.text, v.main])).toEqual(desktop);
    }
  });

  it('listing writes nothing: no setting is stored and the stored lists are untouched', async () => {
    const before = JSON.stringify(settings.get('library.manualVariants'));
    const setSpy = vi.spyOn(settings, 'set');
    realLibrary(settings)._registerWithBackend();
    await vi.waitFor(() => expect(backend.registers.length).toBe(1));
    expect(setSpy).not.toHaveBeenCalled();
    expect(window.funsync.setSetting).not.toHaveBeenCalled();
    expect(JSON.stringify(settings.get('library.manualVariants'))).toBe(before);
  });

  it('the library\'s own video objects are not changed by the send', async () => {
    const videos = libraryVideos();
    realLibrary(settings, videos)._registerWithBackend();
    await vi.waitFor(() => expect(backend.registers.length).toBe(1));
    expect(videos[0].variants).toEqual(SCANNED());
    expect(videos[2].variants).toEqual([]);
  });
});

describe('FN-04: adding, renaming or removing a hand-added variation re-sends the list', () => {
  const Lifted = new Function('eventBus', `return class { ${['_wireGroupingsRegister', '_registerGroupingsEarly'].map((n) => liftMethod(APP_SRC, n)).join('\n')} };`)(eventBus);
  let backend;
  let settings;
  let savedHandlers;

  beforeEach(() => {
    vi.useFakeTimers();
    savedHandlers = eventBus._handlers;
    eventBus._handlers = new Map();
    backend = fakeBackend();
    window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
    settings = realDataService({});
    const app = new Lifted();
    app.backendPort = PORT;
    app.settings = settings;
    app.library = realLibrary(settings);
    app._wireGroupingsRegister();
  });

  afterEach(() => {
    vi.useRealTimers();
    eventBus._handlers = savedHandlers;
    delete globalThis.fetch;
    delete window.funsync;
  });

  it('a variation stored for the video reaches the backend within the debounce, with the video list', async () => {
    settings.set('library.manualVariants', { [VIDEO]: [{ label: 'Hard Remix', path: HARD, name: 'Clip hard remix.funscript' }] });
    expect(backend.registers).toHaveLength(0);           // debounced
    await vi.advanceTimersByTimeAsync(500);
    expect(sentVariants(backend, VIDEO).map((v) => v.label)).toEqual(['Default', 'soft', 'Hard Remix']);
  });

  it('removing it is sent too', async () => {
    settings.set('library.manualVariants', { [VIDEO]: [{ label: 'Hard Remix', path: HARD, name: 'x' }] });
    await vi.advanceTimersByTimeAsync(500);
    settings.set('library.manualVariants', {});
    await vi.advanceTimersByTimeAsync(500);
    expect(sentVariants(backend, VIDEO).map((v) => v.label)).toEqual(['Default', 'soft']);
  });
});

// ---- The phone session (the desktop drives the devices) ----

const SESSION_METHODS = [
  '_onRemotePhoneConnected', '_phonePinnedVariant', '_phoneVariantList', '_getPreferredVariantLabel',
  '_handlePhoneSwitchVariant', '_switchVariant', '_editorAllowsReplace', '_updateVariantSelector',
  '_variantLabelText', '_manualVariantsFor', '_planLazyRehome',
  '_audienceScriptContent', '_fillerOptionsForUpload', '_handyInverted', '_cutoffFromSettings',
  '_uploadAndStartSync', '_handyUploadContent',
];

function session({ settings = {}, disk } = {}) {
  const store = {
    'library.preferredVariants': {},
    'library.manualVariants': MANUAL(),
    'player.gapFiller': { enabled: false },
    'player.rangeExtender.enabled': false,
    ...settings,
  };
  const files = disk || { [MAIN]: script('main'), [SOFT]: script('soft'), [HARD]: script('hard'), [AMP]: script('amp'), [OTHER_MAIN]: script('other-main'), [OTHER_MANUAL]: script('other-extra') };
  const reads = [];
  const writes = [];
  const fakeWindow = { funsync: { readFunscript: vi.fn(async (p) => { reads.push(p); return files[p] ?? null; }) } };
  const make = new Function(
    'window', 'document', 'console', 'showToast', 't', 'pickVariantIndexOnLoad', 'stripBOM', 'fillRawScriptContent',
    'resolveFillerOptions', 'extendRawScriptContent', 'clampRawScriptContent', 'invertRawScriptContent',
    'RemotePlaybackProxy', 'SOURCE_PLAYER', 'remoteVariantList', 'pickRehomeCandidate',
    `return class { ${SESSION_METHODS.map((n) => liftMethod(APP_SRC, n)).join('\n\n')} };`,
  );
  const Lifted = make(
    fakeWindow, { getElementById: () => ({ hidden: true, textContent: '' }) }, { log() {}, warn() {}, error() {}, debug() {} },
    () => ({ dismiss() {} }), (k) => k, pickVariantIndexOnLoad, stripBOM, fillRawScriptContent,
    resolveFillerOptions, extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    RemotePlaybackProxy, SOURCE_PLAYER, remoteVariantList, () => null,
  );
  const engineLoads = [];
  const handyCalls = [];
  const toPhone = [];
  const readOwners = [];
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => store[k], set: (k, v) => { writes.push(k); store[k] = v; } },
    videoPlayer: { video: { paused: true, pause() {} }, duration: NaN },
    funscriptEngine: {
      isLoaded: false, _raw: null,
      loadContent: vi.fn(async function (c) { this.isLoaded = true; this._raw = c; engineLoads.push(labelOf(c)); return { filename: 'x', actionCount: 2 }; }),
      getRawContent() { return this._raw; },
      getActions: () => [{ at: 0, pos: 10 }, { at: 500, pos: 90 }], getChapters: () => [], getBookmarks: () => [],
    },
    // The streamer's Handy, a fake shaped like handy-manager.js: what it was told, in order.
    handyManager: {
      connected: true,
      uploadAndSetScript: vi.fn(async (c) => { handyCalls.push(`upload:${labelOf(c)}`); return true; }),
      hsspStop: vi.fn(async () => { handyCalls.push('stop'); return true; }),
    },
    syncEngine: { _active: false, _scriptReady: false, player: null, start() { this._active = true; }, stop() { this._active = false; } },
    autoblowManager: null, autoblowSync: null, buttplugSync: null, tcodeSync: null, buttplugManager: null, tcodeManager: null,
    audienceBridge: null, scriptEditor: null, sessionTracker: null, progressBar: { renderHeatmap() {}, setMarkers() {} },
    remoteBridge: { connected: true, sendToPhone: (m) => toPhone.push(m) },
    library: { _videosByPath: new Map(libraryVideos().map((v) => [v.path, v])) },
    _videoLoadGen: 1, _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    _currentVariants: [], _allVariantsWithManual: [], _activeVariantIndex: 0, _activeVariantPath: null,
    // This window plays ANOTHER video, with a hand-added variation of its own.
    _currentVideoPath: OTHER, _remoteActive: false,
    _applyVideoSyncOffset() {}, _resetCustomRoutingState() {}, _clearLocalAxesForRemote() {},
    _stashLocalScriptBeforeRemote() {}, _refreshLoopVideoVisibility() {}, _pushRemoteDeviceStatus() {},
    _markCloudUploadsPending() {}, _showScriptLoadingOverlay() {}, _hideScriptLoadingOverlay() {}, _clearCloudUploadGate() {},
    _readScriptResilient: async (p, owner) => { readOwners.push(owner); reads.push(p); return files[p] ? { content: files[p], recoveredPath: null } : null; },
    _healManualVariantPath() {}, _feedInlineViz() {}, _showFunscriptBadge() {}, _formatActionsDuration: () => '0:00',
    _tryStartAutoblowSync: async () => {}, _startGapSkip() {}, _resolveCloudUpload() {},
    // The phone video's timeline for the upload (FT-113's): not under test.
    _sessionTimelineMs: () => 0, _uploadDurationMsFor: () => 0,
  });
  return { app, reads, writes, engineLoads, handyCalls, toPhone, readOwners, store };
}

const chip = (ctx) => ctx.toPhone.filter((m) => m.type === 'variant-changed').map((m) => m.label);

describe('FN-04: a phone session lists, starts on and plays the hand-added variations', () => {
  it('the desktop holds the phone video\'s list, hand-added ones included, and not this window\'s video\'s', async () => {
    const ctx = session();
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', VIDEO);
    expect(ctx.app._allVariantsWithManual.map((v) => v.path)).toEqual([MAIN, SOFT, HARD, AMP]);
    expect(ctx.app._allVariantsWithManual.map((v) => v.path)).not.toContain(OTHER_MANUAL);
  });

  it('a pinned hand-added variation starts the session: the engine and the Handy get it, the phone\'s chip names it', async () => {
    const ctx = session({ settings: { 'library.preferredVariants': { [VIDEO]: 'Hard Remix' } } });
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', VIDEO);
    expect(ctx.engineLoads).toEqual(['hard']);
    expect(ctx.handyCalls).toEqual(['upload:hard']);
    expect(chip(ctx)).toEqual(['Hard Remix']);
    expect(ctx.app._activeVariantPath).toBe(HARD);
  });

  it('picking a hand-added one on the phone plays it on the desktop and the Handy (stop, then the upload)', async () => {
    const ctx = session();
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', VIDEO);
    ctx.handyCalls.length = 0;
    await ctx.app._handlePhoneSwitchVariant('Slow & Soft+');
    expect(ctx.engineLoads.at(-1)).toBe('amp');
    expect(ctx.handyCalls).toEqual(['stop', 'upload:amp']);
    expect(chip(ctx).at(-1)).toBe('Slow & Soft+');
    // A moved file is looked for under the PHONE video, not this window's.
    expect(ctx.readOwners.at(-1)).toBe(VIDEO);
  });

  it('the session lists and plays without writing a setting', async () => {
    const ctx = session({ settings: { 'library.preferredVariants': { [VIDEO]: 'Hard Remix' } } });
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', VIDEO);
    await ctx.app._handlePhoneSwitchVariant('soft');
    expect(ctx.writes).toEqual([]);
  });

  it('a phone video with one script: the desktop\'s chip names THAT script, not the file this window\'s editor holds', async () => {
    const PLAIN_MAIN = 'C:/FakeLib/v/Plain.funscript';
    const ctx = session({ disk: { [PLAIN_MAIN]: script('plain') } });
    ctx.app.scriptEditor = { _funscriptPath: OTHER_MAIN };   // this window's video's script
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', 'C:/FakeLib/v/Plain.mp4');
    expect(ctx.engineLoads).toEqual(['plain']);
    expect(ctx.app._allVariantsWithManual.map((v) => v.path)).toEqual([PLAIN_MAIN]);
    expect(ctx.app._variantLabelText(ctx.app._allVariantsWithManual[ctx.app._activeVariantIndex])).toBe('Plain');
    expect(ctx.app._mainVariantIndex).toBe(0);
  });

  it('control: a hand-added variation of another video is not offered to the phone', async () => {
    const ctx = session();
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', VIDEO);
    const before = ctx.engineLoads.length;
    await ctx.app._handlePhoneSwitchVariant('Extra');
    expect(ctx.engineLoads.length).toBe(before);
  });
});

// Fix-up after block F verify-1 (FN-04, medium, also in v0.9.2): a video
// whose only scripts are hand-added variations (no script of its own). The
// registration listed them, but the session answered "script missing" before
// building any list (`!video.hasFunscript`), so the phone said "No funscript
// — playing video only" and nothing reached a device. It now starts on the
// first of them (the pinned one wins), as the desktop opens such a video.
describe('FN-04: a video whose only scripts are hand-added variations', () => {
  const MO = 'C:/FakeLib/v/Manual Only.mp4';
  const PICK_A = 'C:/FakeLib/scripts/Manual Pick A.funscript';
  const PICK_B = 'C:/FakeLib/scripts/Manual Pick B.funscript';
  const manualOnly = (prefs = {}) => {
    const ctx = session({
      settings: {
        'library.manualVariants': {
          [MO]: [
            { label: 'Manual Pick A', path: PICK_A, name: 'Manual Pick A.funscript' },
            { label: 'Manual Pick B', path: PICK_B, name: 'Manual Pick B.funscript' },
          ],
        },
        'library.preferredVariants': prefs,
      },
      disk: { [PICK_A]: script('pick-a'), [PICK_B]: script('pick-b') },
    });
    ctx.app.library._videosByPath.set(MO, { path: MO, name: 'Manual Only.mp4', hasFunscript: false, funscriptPath: null, variants: [] });
    return ctx;
  };

  it('the session starts on the first of them: the engine and the Handy get it, the list is both, neither marked main', async () => {
    const ctx = manualOnly();
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', MO);
    expect(ctx.toPhone.map((m) => m.type)).not.toContain('script-missing');
    expect(ctx.engineLoads).toEqual(['pick-a']);
    expect(ctx.handyCalls).toEqual(['upload:pick-a']);
    expect(ctx.app._allVariantsWithManual.map((v) => v.path)).toEqual([PICK_A, PICK_B]);
    expect(ctx.app._activeVariantIndex).toBe(0);
    expect(ctx.app._mainVariantIndex).toBe(-1);
    expect(ctx.toPhone.map((m) => m.type)).toContain('script-ready');
  });

  it('a pinned one starts the session instead, and the phone\'s chip is told', async () => {
    const ctx = manualOnly({ [MO]: 'Manual Pick B' });
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', MO);
    expect(ctx.engineLoads).toEqual(['pick-b']);
    expect(ctx.handyCalls).toEqual(['upload:pick-b']);
    expect(chip(ctx)).toEqual(['Manual Pick B']);
  });

  it('a pick on the phone plays it on the desktop and the Handy; nothing is written', async () => {
    const ctx = manualOnly();
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', MO);
    ctx.handyCalls.length = 0;
    await ctx.app._handlePhoneSwitchVariant('Manual Pick B');
    expect(ctx.engineLoads.at(-1)).toBe('pick-b');
    expect(ctx.handyCalls).toEqual(['stop', 'upload:pick-b']);
    expect(chip(ctx).at(-1)).toBe('Manual Pick B');
    expect(ctx.writes).toEqual([]);
  });

  it('control: a video with no script and no variation still answers "script missing", nothing loads', async () => {
    const ctx = manualOnly();
    ctx.app.library._videosByPath.set('C:/FakeLib/v/Bare.mp4', { path: 'C:/FakeLib/v/Bare.mp4', name: 'Bare.mp4', hasFunscript: false, funscriptPath: null, variants: [] });
    await ctx.app._onRemotePhoneConnected('192.168.1.5', 'id1', 'C:/FakeLib/v/Bare.mp4');
    expect(ctx.toPhone.map((m) => m.type)).toEqual(['script-missing']);
    expect(ctx.engineLoads).toEqual([]);
    expect(ctx.handyCalls).toEqual([]);
  });
});
