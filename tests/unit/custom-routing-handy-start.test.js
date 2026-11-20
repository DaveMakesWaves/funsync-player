/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FN-01 fix-up (block F review, 2026-11-16; major, new since FN-01): a Handy
// on a custom-routing route that is NOT main never started. loadVideo now
// sets `syncEngine._scriptReady = false` on every load (FN-01, so the old
// script cannot play under a new video), and `_loadCustomRouting` uploaded
// the route's script and then only ran
// `this.syncEngine?._scriptReady && this.syncEngine.start()`: nothing on that
// path set it true again, and loadFunscript leaves a Handy that is not on the
// main route alone. The script sat on the device and the Handy never played.
// Before FN-01 it worked only on a stale `true` from an earlier main upload.
// The route upload's result now marks the script ready and starts the
// engine, as `_uploadAndStartSync` does for main; a superseded upload starts
// nothing (FT-116).
//
// What runs is REAL: app.js's load path with `_loadCustomRouting`
// (helpers/handy-load-app.js), the REAL HandyManager and the REAL SyncEngine
// on the fake SDK (helpers/fake-handy-sdk.js). Assertions are on the legs the
// device was sent. No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, names: new Map() }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async (content) => {
    await new Promise((r) => setTimeout(r, 0));
    return `https://scripts.local/${h.names.get(content) || 'unknown'}.csv`;
  },
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';

const MAIN = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 600, pos: 90 }] });
const ROUTE = JSON.stringify({ actions: [{ at: 0, pos: 90 }, { at: 400, pos: 10 }, { at: 800, pos: 90 }] });
h.names.set(ROUTE, 'ROUTE');
const A = 'C:\\Lib\\Alpha.mp4';
const B = 'C:\\Lib\\Bravo.mp4';
const MAIN_FS = 'C:\\Lib\\Alpha.funscript';
const ROUTE_FS = 'C:\\Lib\\Alpha.twist.funscript';
const ROUTES = [
  { role: 'main', deviceId: 'buttplug:0:Stroker', scriptPath: MAIN_FS },
  { role: 'route', deviceId: 'handy', scriptPath: ROUTE_FS },
];
const DISK = { [MAIN_FS]: MAIN, [ROUTE_FS]: ROUTE };

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let Lifted;
let app;
let video;
let manager;
let engine;

beforeAll(() => {
  Lifted = makeLoadAppClass({ extra: ['_loadCustomRouting'] });
});

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  // No per-name throttle in this fake SDK (throttleMs 0), so no window to
  // keep out of (that spacing is pinned in handy-sdk-throttle-stop-wins).
  manager._hsspSpacingMs = 0;
  ({ app, video } = buildLoadApp(Lifted, {
    handyManager: manager,
    buttplugSync: null, tcodeSync: null, autoblowManager: null, autoblowSync: null, scriptEditor: null,
    _readRouteScript: async (route) => (DISK[route.scriptPath] ? { content: DISK[route.scriptPath] } : null),
    _applyCustomRoutingAssignments: () => [],
    _reportCustomRoutingMismatches() {},
    _persistCustomRoutes() {},
    _findKnownDeviceForRoute: () => null,
  }));
  app.funscriptEngine = { clear() {}, isLoaded: false, getRawContent: () => null };
  engine = new SyncEngine({ videoPlayer: app.videoPlayer, handyManager: manager, funscriptEngine: { isLoaded: true } });
  app.syncEngine = engine;
  // The main script is the Buttplug stroker's: loadFunscript leaves the Handy alone.
  app.loadFunscript = vi.fn();
});

afterEach(() => {
  engine.stop();
  manager._stopHealthCheck();
});

const hssp = () => h.sdk.calls.filter(([n]) => n === 'hsspPlay' || n === 'hsspStop').map(([n]) => n);
const deviceRunning = () => hssp().at(-1) === 'hsspPlay';

describe('a Handy on a custom route that is not main (FN-01 fix-up)', () => {
  it('after a load, the route\'s upload marks its script ready and the Handy plays on "playing"', async () => {
    await app._playFromLibrary(fileItem(A), { name: 'Alpha.funscript', textContent: MAIN, _customRouting: ROUTES }, null, []);
    video.fire('loadeddata');
    await vi.waitFor(() => expect(engine._scriptReady, 'the routed Handy\'s script never became ready').toBe(true));
    expect(engine._active, 'the routed Handy\'s engine never started').toBe(true);
    expect(h.sdk.sent('setScript').at(-1)[1]).toBe('https://scripts.local/ROUTE.csv');

    video.play();
    await settle();
    expect(deviceRunning(), 'the routed Handy never played').toBe(true);
  });

  it('the next video (no script) stops it, and the route\'s script does not come back', async () => {
    await app._playFromLibrary(fileItem(A), { name: 'Alpha.funscript', textContent: MAIN, _customRouting: ROUTES }, null, []);
    video.fire('loadeddata');
    await vi.waitFor(() => expect(engine._scriptReady).toBe(true));
    video.play();
    await settle();
    expect(deviceRunning()).toBe(true);
    const mark = h.sdk.calls.length;

    await app._playFromLibrary(fileItem(B), null, null, []);
    await settle();
    video.fire('loadeddata');
    video.play();
    await settle();
    const legs = h.sdk.calls.slice(mark).map(([n]) => n);
    expect(legs).toContain('hsspStop');
    expect(legs).not.toContain('hsspPlay');
    expect(deviceRunning()).toBe(false);
  });

  it('a route upload that lands after the video changed starts nothing', async () => {
    let release;
    const slow = new Promise((r) => { release = r; });
    app._readRouteScript = async (route) => { await slow; return { content: DISK[route.scriptPath] }; };
    const first = app._playFromLibrary(fileItem(A), { name: 'Alpha.funscript', textContent: MAIN, _customRouting: ROUTES }, null, []);
    await settle();
    app._readRouteScript = async () => null;
    await app._playFromLibrary(fileItem(B), null, null, []);
    release();
    await first;
    await settle();
    video.fire('loadeddata');
    video.play();
    await settle();
    expect(engine._scriptReady).toBe(false);
    expect(hssp()).not.toContain('hsspPlay');
  });
});
