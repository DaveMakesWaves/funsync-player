/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here. The REAL
 * DragDrop is built on a two-method `document` stub (it only binds
 * listeners and looks for its overlay).
 */
// Block F follow-ups (Handy session 2026-11-17, not checked in v0.9.2):
//
//  1. O (and drag-and-drop, the same handler) had no cloud-upload gate. Long
//     Clip playing, O picking Variant Clip.mp4 + Variant Clip.funscript: the
//     new video played 82 ms after the change and the Handy's first play left
//     at 900 ms (upload + setScript), so the first ~0.9 s were not stroked.
//     FT-112 gated only the library autoplay and Play All. Now the video
//     waits for the upload, as a library open does.
//  2. O with the video alone did not load its same-name funscript (only a
//     script picked or dropped with it paired), so it played with "No
//     script". A library open of a video loads its script (its association,
//     or `<name>.funscript` beside it, FT-069), so O does the same, behind
//     the same gate.
//  3. (FN-01's rule, on the O route) every device stops when a video with
//     no script opens, and nothing starts them again on the old script.
//
// What runs is REAL: app.js's `_dragDropOptions` (the O / Browse / drop
// handler), loadVideo, the gate, `_loadPlayContent`, the Handy upload, the
// REAL HandyManager and SyncEngine on the fake SDK (helpers/fake-handy-sdk.js),
// and the REAL DragDrop for what a pick or a drop hands over. Nothing reaches
// the cloud; the key is the fake TESTKEY01.
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
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { DragDrop } from '../../renderer/js/drag-drop.js';
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';

const SCRIPT_LONG = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 600, pos: 90 }, { at: 1200, pos: 10 }] });
const SCRIPT_VARIANT = JSON.stringify({ actions: [{ at: 0, pos: 90 }, { at: 400, pos: 10 }] });
const SCRIPT_ASSOC = JSON.stringify({ actions: [{ at: 0, pos: 50 }, { at: 300, pos: 0 }] });
h.names.set(SCRIPT_LONG, 'Long');
h.names.set(SCRIPT_VARIANT, 'Variant');
h.names.set(SCRIPT_ASSOC, 'Assoc');
const LONG = 'C:\\Clips\\Long Clip.mp4';
const VARIANT = 'C:\\Clips\\Variant Clip.mp4';
const VARIANT_FS = 'C:\\Clips\\Variant Clip.funscript';
const NOSCRIPT = 'C:\\Clips\\Alpha Scene (copy).mp4';
const LIBVID = 'C:\\Lib\\Library Clip.mp4';
const ASSOC_FS = 'C:\\Scripts\\Associated.funscript';

// "It played" is waited for, not read after a fixed settle: how long a settle
// lasts depends on the platform's timers (coarse 15 ms on Windows, 1 ms on
// Linux), which is how CI's ubuntu job failed on the v0.10.0 tag (2026-11-20).
const WAIT = { timeout: 2000, interval: 5 };
const settle = async (n = 14) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let Lifted;
let app;
let video;
let relayed;
let manager;
let engine;
let script;            // what the funscript engine holds now
let scriptsOnDisk;     // path -> content the fake readFunscript answers

beforeAll(() => {
  Lifted = makeLoadAppClass({
    extra: ['_dragDropOptions', '_clearPlaySession', '_loadOpenedVideoScript', '_readFunscriptFileAgain',
      '_uploadAndStartSync', '_tryStartAutoblowSync'],
  });
});

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  manager._hsspSpacingMs = 0;
  // And the 220 ms between two setScripts: a new video's setup came within it
  // of the last one and waited it out, longer than the settles below on Linux
  // (1 ms timers) though not on Windows (coarse 15 ms ones), so CI's ubuntu
  // job saw no play yet (v0.10.0 tag, 2026-11-20).
  manager._setScriptSpacingMs = 0;
  ({ app, video, relayed } = buildLoadApp(Lifted, { handyManager: manager }));
  scriptsOnDisk = new Map([[VARIANT_FS, SCRIPT_VARIANT]]);
  globalThis.__liftedFunsync.readFunscript = vi.fn(async (p) => scriptsOnDisk.get(p) ?? null);
  script = null;
  app.funscriptEngine = { clear() { script = null; }, get isLoaded() { return !!script; }, getRawContent: () => script };
  engine = new SyncEngine({ videoPlayer: app.videoPlayer, handyManager: manager, funscriptEngine: app.funscriptEngine });
  app.syncEngine = engine;
  app._setUpNextContext = () => {};
  // A script load runs the app's real Handy upload, as loadFunscript does.
  app.loadFunscript = vi.fn(async (fs) => {
    script = fs.textContent ?? await fs.text();
    await app._uploadAndStartSync();
  });
});

afterEach(() => {
  engine.stop();
  manager._stopHealthCheck();
  delete globalThis.document;
});

const hssp = () => h.sdk.calls.filter(([n]) => n === 'hsspPlay' || n === 'hsspStop').map(([n]) => n);
const deviceRunning = () => hssp().at(-1) === 'hsspPlay';
const legsSince = (i) => h.sdk.calls.slice(i).map(([n, arg]) => (n === 'setScript' ? `setScript:${arg.split('/').pop()}` : n));
const scriptFile = (path, content) => {
  const f = new File([content], path.split('\\').pop());
  f.path = path;
  return f;
};

/** Long Clip open with O alongside its script, playing on the Handy. */
async function playLongClip() {
  scriptsOnDisk.set(LONG.replace('.mp4', '.funscript'), SCRIPT_LONG);
  const opts = app._dragDropOptions();
  opts.onVideoFile(fileItem(LONG));
  await settle();
  video.fire('loadeddata');
  await settle();
  expect(app._currentVideoPath).toBe(LONG);
  await vi.waitFor(() => expect(deviceRunning(), 'Long Clip plays on the Handy').toBe(true), WAIT);
}

describe('O / drag-and-drop with a video and its script: the video waits for the Handy upload', () => {
  it('nothing plays before the script is on the device; then the video and the Handy start together', async () => {
    await playLongClip();
    const mark = h.sdk.calls.length;
    const held = h.sdk.hold('setScript');   // a slow cloud: the upload has not landed
    const opts = app._dragDropOptions();
    video.play.mockClear();

    opts.onVideoFile(fileItem(VARIANT), { withScript: true });
    opts.onFunscriptFile(scriptFile(VARIANT_FS, SCRIPT_VARIANT));
    await settle();
    video.fire('loadeddata');   // the new video is ready long before the upload
    await settle();
    expect(video.play, 'the video waits for the upload').not.toHaveBeenCalled();
    expect(legsSince(mark)).not.toContain('hsspPlay');

    held.resolve({ result: 0 });
    await settle();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
    const legs = legsSince(mark);
    expect(legs.indexOf('setScript:Variant.csv')).toBeGreaterThan(-1);
    expect(legs.indexOf('hsspPlay')).toBeGreaterThan(legs.indexOf('setScript:Variant.csv'));
    expect(deviceRunning()).toBe(true);
  });

  it('no cloud device connected: the video plays at once, as before', async () => {
    await manager.disconnect();
    const opts = app._dragDropOptions();
    opts.onVideoFile(fileItem(VARIANT), { withScript: true });
    opts.onFunscriptFile(scriptFile(VARIANT_FS, SCRIPT_VARIANT));
    video.fire('loadeddata');
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
  });

  it('a script that fails to load lets the waiting video play (no 8 s stall)', async () => {
    const opts = app._dragDropOptions();
    app.loadFunscript = vi.fn(async () => {
      // loadFunscript's catch: no script, no upload.
      app._resolveCloudUpload('handy');
      app._resolveCloudUpload('autoblow');
    });
    opts.onVideoFile(fileItem(VARIANT), { withScript: true });
    video.fire('loadeddata');
    expect(video.play).not.toHaveBeenCalled();
    opts.onFunscriptFile(scriptFile(VARIANT_FS, 'not json'));
    await settle();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
  });
});

describe('O with the video alone loads the script a library open loads', () => {
  it('its `<name>.funscript` beside it: loaded, uploaded, and the video waits for it', async () => {
    const held = h.sdk.hold('setScript');
    const opts = app._dragDropOptions();
    opts.onVideoFile(fileItem(VARIANT));
    video.fire('loadeddata');   // before the script was even read
    await settle();
    expect(app.loadFunscript).toHaveBeenCalledTimes(1);
    const loaded = app.loadFunscript.mock.calls[0][0];
    expect(loaded.textContent).toBe(SCRIPT_VARIANT);
    expect(loaded._funscriptPath).toBe(VARIANT_FS);   // the editor saves to the file it came from
    expect(video.play, 'waits for the upload').not.toHaveBeenCalled();

    held.resolve({ result: 0 });
    await settle();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
    expect(deviceRunning()).toBe(true);
  });

  it('a video the library holds: what its card loads (its association), not a guess', async () => {
    const libVideo = { name: 'Library Clip.mp4', path: LIBVID, hasFunscript: true, funscriptPath: ASSOC_FS };
    app.library = {
      getVideoByPath: (p) => (p === LIBVID ? libVideo : null),
      resolvePlayData: vi.fn(async () => ({
        funscriptData: { name: 'Associated.funscript', textContent: SCRIPT_ASSOC, _funscriptPath: ASSOC_FS },
        subtitleData: null,
        variants: [],
      })),
    };
    const opts = app._dragDropOptions();
    opts.onVideoFile(fileItem(LIBVID));
    await settle();
    expect(app.library.resolvePlayData).toHaveBeenCalledWith(libVideo);
    expect(app.loadFunscript.mock.calls[0][0]._funscriptPath).toBe(ASSOC_FS);
    // Still a file on its own: no list after it (FT-074).
    expect(app._currentPlayContext).toBe(null);
  });

  it('no script anywhere: the video plays at once and nothing is loaded', async () => {
    const opts = app._dragDropOptions();
    opts.onVideoFile(fileItem(NOSCRIPT));
    video.fire('loadeddata');   // even before the look-up answered
    await settle();
    expect(app.loadFunscript).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
    expect(app._waitingForScript).toBe(false);
  });

  it('a script picked with the video wins: the one beside it is not read', async () => {
    const opts = app._dragDropOptions();
    opts.onVideoFile(fileItem(VARIANT), { withScript: true });
    opts.onFunscriptFile(scriptFile('C:\\Other\\Mine.funscript', SCRIPT_ASSOC));
    await settle();
    expect(globalThis.__liftedFunsync.readFunscript).not.toHaveBeenCalled();
    expect(app.loadFunscript).toHaveBeenCalledTimes(1);
  });

  it('another video opened during the look-up owns the gate: the first one\'s script never lands', async () => {
    let answer;
    globalThis.__liftedFunsync.readFunscript = vi.fn(() => new Promise((r) => { answer = r; }));
    const opts = app._dragDropOptions();
    opts.onVideoFile(fileItem(VARIANT));
    globalThis.__liftedFunsync.readFunscript = vi.fn(async () => null);
    opts.onVideoFile(fileItem(NOSCRIPT));
    answer(SCRIPT_VARIANT);
    await settle();
    expect(app.loadFunscript).not.toHaveBeenCalled();
    expect(app._currentVideoPath).toBe(NOSCRIPT);
  });
});

describe('the REAL DragDrop tells the handler whether a script came with the video', () => {
  function realDragDrop() {
    globalThis.document = { getElementById: () => null, addEventListener() {} };
    return new DragDrop({ ...app._dragDropOptions(), dropZoneElement: null });
  }

  it('O / Browse picking the video and its script: gated, then played with the device', async () => {
    const dd = realDragDrop();
    const held = h.sdk.hold('setScript');
    globalThis.window = { funsync: {
      openFileDialog: async () => [
        { name: 'Variant Clip.funscript', path: VARIANT_FS, textContent: SCRIPT_VARIANT },
        { name: 'Variant Clip.mp4', path: VARIANT },
      ],
    } };
    try {
      await dd._openNativeDialog();
    } finally {
      delete globalThis.window;
    }
    await settle();
    video.fire('loadeddata');
    await settle();
    expect(video.play).not.toHaveBeenCalled();
    held.resolve({ result: 0 });
    await settle();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
    expect(deviceRunning()).toBe(true);
    // The picked script is the one: nothing else is looked up or loaded.
    expect(app.loadFunscript).toHaveBeenCalledTimes(1);
    expect(globalThis.__liftedFunsync.readFunscript).not.toHaveBeenCalled();
  });

  it('a drop of the video and its script: the same', async () => {
    const dd = realDragDrop();
    const held = h.sdk.hold('setScript');
    const files = [scriptFile(VARIANT_FS, SCRIPT_VARIANT), Object.assign(new File(['x'], 'Variant Clip.mp4'))];
    globalThis.window = { funsync: { getPathForFile: (f) => (f.name.endsWith('.mp4') ? VARIANT : VARIANT_FS) } };
    try {
      dd._onDrop({
        preventDefault() {},
        dataTransfer: { types: ['Files'], files },
      });
    } finally {
      delete globalThis.window;
    }
    await settle();
    video.fire('loadeddata');
    await settle();
    expect(video.play).not.toHaveBeenCalled();
    held.resolve({ result: 0 });
    await settle();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
    expect(app.loadFunscript).toHaveBeenCalledTimes(1);
    expect(globalThis.__liftedFunsync.readFunscript).not.toHaveBeenCalled();
  });
});

describe('FN-01 on the O route: a video with no script stops every device', () => {
  it('Handy, Buttplug, T-Code and the Autoblow stop, and nothing starts the old script again', async () => {
    await playLongClip();
    const actions = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }];
    const fsEngine = { isLoaded: true, getActions: () => actions, getAuthoredActions: () => actions };
    const buttplugManager = {
      connected: true, devices: [],
      sendLinear: vi.fn(), sendVibrate: vi.fn(), sendRotate: vi.fn(), sendScalar: vi.fn(), sendOscillate: vi.fn(),
      stopAll: vi.fn(async () => {}),
    };
    const tcodeManager = { connected: true, stop: vi.fn(), sendMove: vi.fn(), sendAxisMove: vi.fn() };
    const autoblowManager = { connected: true, syncStop: vi.fn(async () => true), syncStart: vi.fn(async () => true) };
    app.buttplugSync = new ButtplugSync({ videoPlayer: app.videoPlayer, buttplugManager, funscriptEngine: fsEngine });
    app.tcodeSync = new TCodeSync({ videoPlayer: app.videoPlayer, tcodeManager, funscriptEngine: fsEngine });
    app.autoblowSync = new AutoblowSync({ videoPlayer: app.videoPlayer, autoblowManager });
    for (const e of [app.buttplugSync, app.tcodeSync, app.autoblowSync]) e.start();
    buttplugManager.stopAll.mockClear();
    tcodeManager.stop.mockClear();
    autoblowManager.syncStop.mockClear();
    const mark = h.sdk.calls.length;

    app._dragDropOptions().onVideoFile(fileItem(NOSCRIPT));   // O, a video with no script
    await settle();
    expect(legsSince(mark)).toContain('hsspStop');
    expect(buttplugManager.stopAll).toHaveBeenCalled();
    expect(tcodeManager.stop).toHaveBeenCalled();
    expect(autoblowManager.syncStop).toHaveBeenCalled();

    // The new video loads and plays: the old script must not come back.
    video.fire('loadeddata');
    await settle();
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled(), WAIT);
    expect(legsSince(mark)).not.toContain('hsspPlay');
    expect(deviceRunning()).toBe(false);
    app.buttplugSync.stop(); app.tcodeSync.stop();
  });
});
