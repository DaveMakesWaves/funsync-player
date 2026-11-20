/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// E-13 (2026-11-07; by reading, probably also in v0.9.2): an Autoblow on a
// NON-main custom route got its route script uploaded (`_loadCustomRouting`)
// but its sync was never started: loadFunscript skips `_tryStartAutoblowSync`
// unless the Autoblow is on the main route, and nothing else starts it. So the
// device held the script and never played.
//
// The REAL app.js `_loadCustomRouting` and `loadFunscript` (lifted), a REAL
// AutoblowSync, and a fake AutoblowManager that records what the device was
// sent (no token, no network). Asserted on the device: which script it holds,
// and whether Play starts it.
import { describe, it, expect, vi } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} from '../../renderer/js/device-transform-stack.js';
import { SOURCE_PLAYER } from '../../renderer/js/audience-bridge.js';

const METHODS = [
  '_loadCustomRouting', '_isDeviceOnMainRoute', 'loadFunscript', '_tryStartAutoblowSync',
  '_audienceScriptContent', '_fillerOptionsForUpload', '_handyInverted', '_cutoffFromSettings',
  '_handyUploadContent', '_autoblowUploadContent', '_uploadDurationMsFor', '_sessionTimelineMs', // FT-113
];

const DIR = 'C:\\sandbox\\library\\';
const VIDEO = `${DIR}Routed.mp4`;
const MAIN = `${DIR}Routed.funscript`;
const SUCK = `${DIR}Routed.suck.funscript`;
const script = (label) => JSON.stringify({
  version: '1.0', _label: label,
  actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }, { at: 1000, pos: 10 }, { at: 1500, pos: 90 }],
});
const labelOf = (c) => { try { return JSON.parse(c)._label; } catch { return null; } };

class FakeVideo extends EventTarget {
  constructor() { super(); this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 60; this.playbackRate = 1; }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
}

function build() {
  const disk = { [MAIN]: script('main'), [SUCK]: script('suck') };
  const Lifted = liftAppClass(METHODS, {
    window: { funsync: {} }, document: { getElementById: () => null },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    showToast: () => ({ dismiss() {} }), t: (k) => k,
    stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent, SOURCE_PLAYER,
  });
  const video = new FakeVideo();
  const videoPlayer = {
    video, duration: NaN,
    get paused() { return video.paused; },
    get currentTime() { return video.currentTime; },
  };
  // The device: what it was sent (fake; no token, nothing leaves the test).
  const device = { uploads: [], starts: [], stops: 0 };
  const autoblowManager = {
    connected: true,
    uploadScript: vi.fn(async (c) => { device.uploads.push(labelOf(c)); return true; }),
    syncStart: vi.fn(async (ms) => { device.starts.push(ms); return true; }),
    syncStop: vi.fn(async () => { device.stops++; return true; }),
  };
  const S = { 'player.gapFiller': { enabled: false }, 'player.rangeExtender.enabled': false };
  const engine = {
    isLoaded: false, _raw: null,
    loadContent: vi.fn(async function (c) { this.isLoaded = true; this._raw = c; return { filename: 'x', actionCount: 4 }; }),
    getRawContent() { return this._raw; },
    getActions: () => [], getChapters: () => [], getBookmarks: () => [],
  };
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set() {} },
    videoPlayer, funscriptEngine: engine, progressBar: { renderHeatmap() {}, setMarkers() {} },
    autoblowManager,
    autoblowSync: new AutoblowSync({ videoPlayer, autoblowManager }),
    handyManager: null, syncEngine: null, buttplugSync: null, tcodeSync: null, handyHdspSync: null,
    audienceBridge: null, scriptEditor: null,
    _videoLoadGen: 0, _currentVideoName: 'Routed.mp4', _currentVideoPath: VIDEO, _pendingFunscripts: [],
    _customRoutingActive: true,
    _readRouteScript: async (route) => (disk[route.scriptPath] ? { content: disk[route.scriptPath] } : null),
    _applyCustomRoutingAssignments: () => [], _reportCustomRoutingMismatches() {}, _persistCustomRoutes() {},
    _findKnownDeviceForRoute: () => null,
    _feedEmbeddedMultiAxis() {}, _showFunscriptBadge() {}, _feedInlineViz() {}, _refreshEditorScriptList() {},
    _uploadAndStartSync: async () => {}, _tryStartButtplugSync() {}, _tryStartTCodeSync() {},
    _startGapSkip() {}, _resolveCloudUpload() {},
  });
  return { app, device, video, disk };
}

/** A routed library video loads as `_loadPlayContent` loads it: routes, then main. */
async function openRouted(ctx, routes) {
  await ctx.app._loadCustomRouting(routes, VIDEO);
  await ctx.app.loadFunscript({ name: 'Routed.funscript', textContent: ctx.disk[MAIN], _funscriptPath: MAIN });
}

describe('E-13: an Autoblow on a non-main custom route plays its route script', () => {
  it('the routed Autoblow holds the route script, and Play starts it', async () => {
    const ctx = build();
    await openRouted(ctx, [
      { role: 'main', deviceId: 'handy', scriptPath: MAIN },
      { role: 'route', deviceId: 'autoblow', scriptPath: SUCK },
    ]);
    expect(ctx.device.uploads).toEqual(['suck']);    // never the main script
    ctx.video.currentTime = 2.5;
    ctx.video.play();
    await Promise.resolve();
    expect(ctx.device.starts).toEqual([2500]);
  });

  it('a routed Autoblow already playing the last video is stopped before its new script goes up', async () => {
    const ctx = build();
    ctx.app.autoblowSync.start();     // still active from the previous video
    const stopsBefore = ctx.device.stops;
    await openRouted(ctx, [
      { role: 'main', deviceId: 'handy', scriptPath: MAIN },
      { role: 'route', deviceId: 'autoblow', scriptPath: SUCK },
    ]);
    expect(ctx.device.stops).toBe(stopsBefore + 1);
    expect(ctx.device.uploads).toEqual(['suck']);
    ctx.video.play();
    await Promise.resolve();
    expect(ctx.device.starts).toEqual([0]);
  });

  it('the Autoblow on the MAIN route still plays the main script, uploaded once', async () => {
    const ctx = build();
    await openRouted(ctx, [
      { role: 'main', deviceId: 'autoblow', scriptPath: MAIN },
      { role: 'route', deviceId: 'buttplug:0', scriptPath: SUCK },
    ]);
    expect(ctx.device.uploads).toEqual(['main']);
    ctx.video.play();
    await Promise.resolve();
    expect(ctx.device.starts).toEqual([0]);
  });
});
