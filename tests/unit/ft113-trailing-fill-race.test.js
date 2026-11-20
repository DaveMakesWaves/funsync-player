/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-113 race (Handy session 2026-11-17, not checked in v0.9.2): the gap
// filler's fill to the end of the video was lost whenever the Handy upload
// left before the video knew its length. `_fillerOptionsForUpload` read
// `video.duration` at that moment, and a <video> says NaN until
// `loadedmetadata` (so 0: no trailing gap). Seen on a plain local open and on
// a custom route: Gap Copy (script ends at 30 s, video 40 s) uploaded 79
// actions ending at 29.8 s (upload 99 ms after the click, `loadeddata` at
// 113 ms), while Gap Clip just before uploaded 107 ending at 39.9 s. The
// output limits and the inner gap fill were always there. The phone path was
// fine (it measures the phone's video).
//
// Now every upload of this window's script (the Handy, the Autoblow, a
// custom route on either, and the Audience viewers' script) waits for the
// length, briefly, and only when the filler would fill to the end.
//
// The REAL app.js methods are lifted with the REAL processing functions
// (extend / fill / invert / clamp, the filler presets), a REAL AutoblowSync
// and fakes for the device managers that record what each was sent. The
// <video> behaves as Chromium's does while it loads: a source, `duration`
// NaN, then `durationchange` + `loadedmetadata`. What is asserted is the
// uploaded script: byte for byte what an upload after the length was known
// sends, filled to the video's end.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} from '../../renderer/js/device-transform-stack.js';

vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

const METHODS = [
  '_uploadAndStartSync', '_tryStartAutoblowSync', '_loadCustomRouting', 'loadFunscript', '_audienceScriptContent',
  '_localDurationPending', '_whenLocalDurationKnown',
  '_handyUploadContent', '_autoblowUploadContent', '_fillerOptionsForUpload',
  '_cutoffFromSettings', '_handyInverted', '_sessionTimelineMs', '_uploadDurationMsFor',
];

const SETTINGS = {
  'handy.cutoff': { min: 30, max: 80 },
  'autoblow.cutoff': { min: 30, max: 80 },
  'handy.inverted': false,
  'player.gapFiller': { enabled: true, presetId: 'steady', thresholdMs: 5000 },
  'player.gapSkip': { mode: 'off' },
  'player.rangeExtender.enabled': false,
};
// Strokes every 300 ms to 30 s, then nothing: on a 40 s video the filler has
// a 10 s trailing gap to fill (ft113/Gap Clip's shape).
const strokes = Array.from({ length: 101 }, (_, i) => ({ at: i * 300, pos: i % 2 ? 100 : 0 }));
const RAW = JSON.stringify({ version: '1.0', actions: strokes });
const ROUTE_RAW = JSON.stringify({ version: '1.0', actions: strokes.map((a) => ({ ...a, pos: 100 - a.pos })) });
const VIDEO_SEC = 40;
const MAIN_FS = 'C:\\sandbox\\clips\\Gap Copy.funscript';
const ROUTE_FS = 'C:\\sandbox\\clips\\Gap Copy.route.funscript';

const lastAt = (content) => JSON.parse(content).actions.at(-1).at;
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** This window's <video> as Chromium has it while a local file loads. */
class LoadingVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      src: 'file:///C:/sandbox/clips/Gap%20Copy.mp4', currentSrc: '', duration: NaN, error: null,
      paused: true, ended: false, currentTime: 0, playbackRate: 1,
    });
  }

  /** The length arrives: durationchange, then loadedmetadata. */
  metadata(sec = VIDEO_SEC) {
    this.duration = sec;
    this.dispatchEvent(new Event('durationchange'));
    this.dispatchEvent(new Event('loadedmetadata'));
  }
}

function build({ settings = {}, video = new LoadingVideo() } = {}) {
  const S = { ...SETTINGS, ...settings };
  const warnings = [];
  const Lifted = liftAppClass(METHODS, {
    window: { funsync: { readFunscript: vi.fn(async () => null) } },
    document: { getElementById: () => null },
    console: { log() {}, debug() {}, info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
    showToast() {}, t: (k) => k,
    stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
  });
  const videoPlayer = {
    video,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
  };
  const handySent = [];
  const handyManager = {
    connected: true,
    uploadSeq: 0,
    _lastCloudUrl: null,
    uploadAndSetScript: vi.fn(async function (c) { this.uploadSeq++; handySent.push(c); return true; }),
    hsspStop: vi.fn(async () => true),
  };
  const autoblowSent = [];
  const autoblowManager = {
    connected: true,
    uploadScript: vi.fn(async (c) => { autoblowSent.push(c); return true; }),
    syncStart: vi.fn(async () => true),
    syncStop: vi.fn(async () => true),
  };
  const viewerScripts = [];
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; } },
    videoPlayer,
    funscriptEngine: {
      isLoaded: true, _raw: RAW,
      loadContent: vi.fn(async function (c) { this._raw = c; this.isLoaded = true; return { filename: 'Gap Copy.funscript', actionCount: 101 }; }),
      getRawContent() { return this._raw; },
      getActions() { return JSON.parse(this._raw).actions; },
      getChapters: () => [], getBookmarks: () => [],
    },
    handyManager,
    syncEngine: {
      _active: false, _scriptReady: false, player: videoPlayer,
      start() { this._active = true; }, stop() { this._active = false; }, resync: async () => true,
    },
    autoblowManager,
    autoblowSync: new AutoblowSync({ videoPlayer, autoblowManager }),
    buttplugSync: null, tcodeSync: null, handyHdspSync: null, scriptEditor: null,
    // Viewers in the room: the bridge builds their script at once.
    audienceBridge: {
      beginSource: () => 7,
      setScript: vi.fn((token, { content }) => { viewerScripts.push(typeof content === 'function' ? content() : content); return true; }),
      setNoScript() {},
    },
    progressBar: { renderHeatmap() {}, setMarkers() {}, renderChapterStrip() {} },
    library: null, vrBridge: null, _vrPlayerRef: null, _remoteProxy: null,
    _videoLoadGen: 1, _currentVideoName: 'Gap Copy.mp4', _currentVideoPath: 'C:\\sandbox\\clips\\Gap Copy.mp4',
    _customRoutingActive: false, _pendingFunscripts: [],
    _resolveCloudUpload: vi.fn(),
    _feedEmbeddedMultiAxis() {}, _showFunscriptBadge() {}, _feedInlineViz() {},
    _tryStartButtplugSync() {}, _tryStartTCodeSync() {}, _startGapSkip() {},
    _isDeviceOnMainRoute: () => true,
    _readRouteScript: async (route) => ({ content: route.scriptPath === ROUTE_FS ? ROUTE_RAW : RAW }),
    _applyCustomRoutingAssignments: () => [], _reportCustomRoutingMismatches() {}, _persistCustomRoutes() {},
    _findKnownDeviceForRoute: () => null, _refreshEditorScriptList() {},
  });
  return { app, video, handySent, autoblowSent, viewerScripts, warnings, handyManager, autoblowManager, S };
}

/** What uploads once the 40 s length is known: the reference. */
async function reference(raw = RAW) {
  const video = new LoadingVideo();
  video.metadata();
  const ref = build({ video });
  ref.app.funscriptEngine._raw = raw;
  await ref.app._uploadAndStartSync();
  await ref.app._tryStartAutoblowSync();
  return { handy: ref.handySent[0], autoblow: ref.autoblowSent[0] };
}

afterEach(() => { vi.useRealTimers(); });

describe('FT-113 race: an upload that starts before the video knows its length still fills to its end', () => {
  it('the reference: known length, filled to ~40 s, inside the limits', async () => {
    const ref = await reference();
    expect(lastAt(ref.handy)).toBeGreaterThan((VIDEO_SEC - 1) * 1000);
    expect(lastAt(ref.autoblow)).toBeGreaterThan((VIDEO_SEC - 1) * 1000);
    for (const a of JSON.parse(ref.handy).actions) expect(a.pos >= 30 && a.pos <= 80).toBe(true);
  });

  it('the Handy (a plain local open): it waits for the length and sends what the reference sends', async () => {
    const ref = await reference();
    const ctx = build();
    const upload = ctx.app._uploadAndStartSync();
    await settle();
    expect(ctx.handySent, 'nothing leaves before the length is known').toEqual([]);

    ctx.video.metadata();
    await upload;
    expect(ctx.handySent).toHaveLength(1);
    expect(lastAt(ctx.handySent[0])).toBeGreaterThan((VIDEO_SEC - 1) * 1000);
    expect(ctx.handySent[0]).toBe(ref.handy);
    expect(ctx.app.syncEngine._scriptReady).toBe(true);
  });

  it('the Autoblow: the same', async () => {
    const ref = await reference();
    const ctx = build();
    const upload = ctx.app._tryStartAutoblowSync();
    await settle();
    expect(ctx.autoblowSent).toEqual([]);
    ctx.video.metadata();
    await upload;
    expect(ctx.autoblowSent[0]).toBe(ref.autoblow);
  });

  it('a Handy and an Autoblow on custom routes (main on another device): both fill to the end', async () => {
    const ref = await reference(ROUTE_RAW);
    const ctx = build();
    ctx.app._isDeviceOnMainRoute = () => false;
    const routes = [
      { role: 'main', deviceId: 'buttplug:0:Stroker', scriptPath: MAIN_FS },
      { role: 'route', deviceId: 'handy', scriptPath: ROUTE_FS },
      { role: 'route', deviceId: 'autoblow', scriptPath: ROUTE_FS },
    ];
    const loading = ctx.app._loadCustomRouting(routes, 'C:\\sandbox\\clips\\Gap Copy.mp4');
    await settle();
    expect(ctx.handySent).toEqual([]);
    ctx.video.metadata();
    await loading;
    expect(ctx.handySent[0]).toBe(ref.handy);
    expect(ctx.autoblowSent[0]).toBe(ref.autoblow);
  });

  it('the Audience viewers\' script, set once the length is known (the rest of the load does not wait)', async () => {
    const ctx = build();
    ctx.app.funscriptEngine.isLoaded = false;
    ctx.handyManager.connected = false;   // the streamer's own Handy is not what this is about
    ctx.autoblowManager.connected = false;
    await ctx.app.loadFunscript({ name: 'Gap Copy.funscript', textContent: RAW });
    expect(ctx.viewerScripts).toEqual([]);
    ctx.video.metadata();
    await settle();
    expect(ctx.viewerScripts).toHaveLength(1);
    expect(lastAt(ctx.viewerScripts[0])).toBeGreaterThan((VIDEO_SEC - 1) * 1000);
  });
});

describe('FT-113 race: when there is nothing to wait for, nothing waits', () => {
  it('the length is known already: the upload leaves at once', async () => {
    const video = new LoadingVideo();
    video.metadata();
    const ctx = build({ video });
    ctx.app._uploadAndStartSync();
    expect(ctx.handyManager.uploadAndSetScript).toHaveBeenCalledTimes(1);
  });

  it('the gap filler is off: the upload leaves at once (nothing is measured against the length)', async () => {
    const ctx = build({ settings: { 'player.gapFiller': { enabled: false } } });
    ctx.app._uploadAndStartSync();
    expect(ctx.handyManager.uploadAndSetScript).toHaveBeenCalledTimes(1);
  });

  it('the video failed to load: the upload goes on (without a fill to an end nobody knows)', async () => {
    const ctx = build();
    const upload = ctx.app._uploadAndStartSync();
    await settle();
    ctx.video.error = { code: 4 };
    ctx.video.dispatchEvent(new Event('error'));
    await upload;
    expect(ctx.handySent).toHaveLength(1);
    expect(lastAt(ctx.handySent[0])).toBeLessThan(31000);
  });

  it('the length never comes: after 3 s it uploads as before and says so', async () => {
    vi.useFakeTimers();
    const ctx = build();
    const upload = ctx.app._uploadAndStartSync();
    await vi.advanceTimersByTimeAsync(2900);
    expect(ctx.handySent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await upload;
    expect(ctx.handySent).toHaveLength(1);
    expect(ctx.warnings.some((w) => w.includes('length is still unknown'))).toBe(true);
  });

  it('another video loads while it waits: the old upload never leaves and leaves the gate alone', async () => {
    const ctx = build();
    const upload = ctx.app._uploadAndStartSync();
    await settle();
    ctx.app._videoLoadGen += 1;   // loadVideo for the next video
    ctx.video.metadata(25);
    await upload;
    expect(ctx.handySent).toEqual([]);
    expect(ctx.app._resolveCloudUpload).not.toHaveBeenCalled();
  });

  it('a durationchange to NaN (a source swap) is not the length', async () => {
    const ctx = build();
    const upload = ctx.app._uploadAndStartSync();
    await settle();
    ctx.video.dispatchEvent(new Event('durationchange'));   // still NaN
    await settle();
    expect(ctx.handySent).toEqual([]);
    ctx.video.metadata();
    await upload;
    expect(lastAt(ctx.handySent[0])).toBeGreaterThan((VIDEO_SEC - 1) * 1000);
  });
});
