/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-116 (also in v0.9.2): an upload already on its way still reached the
// device after Next, and could win over the new one. Every upload that
// finished ran setScript and cached its URL, so with Next pressed twice the
// OLD script, finishing last, was the one left on the device. And app.js read
// the superseded upload's `false` as a failure: a "upload failed" toast, the
// new video's autoplay gate lifted early, the engine started on the old
// script.
//
// The REAL HandyManager on a fake SDK that keeps the real SDK's local rules
// (helpers/fake-handy-sdk.js); the cloud upload is a deferred each test
// settles in the order it wants. The app half runs the REAL
// `_uploadAndStartSync` (helpers/handy-load-app.js). Assertions are on what
// the device was told (setScript legs) and what the user sees (toasts,
// whether the video plays). No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud, deferred } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, uploads: [] }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  // Each upload waits for the test: h.uploads[i].resolve(url).
  uploadDataToServer: (content) => {
    const d = deferred();
    h.uploads.push(Object.assign(d, { content }));
    return d.promise;
  },
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';

const SCRIPT_A = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 600, pos: 90 }] });
const SCRIPT_B = JSON.stringify({ actions: [{ at: 0, pos: 90 }, { at: 400, pos: 10 }] });
const URL_A = 'https://scripts.local/A.csv';
const URL_B = 'https://scripts.local/B.csv';

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const setScripts = () => h.sdk.sent('setScript').map(([, url]) => url);

let manager;

/** A connected REAL HandyManager on a fresh fake SDK. */
async function connectManager(sdkOpts = {}) {
  h.sdk = createFakeHandySdk(sdkOpts);
  h.uploads = [];
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
}

beforeEach(async () => {
  await connectManager();
});

afterEach(() => {
  manager._stopHealthCheck();
});

describe('HandyManager: a superseded upload is never set (FT-116)', () => {
  it('Next twice: the first upload finishing LAST is dropped, the device ends on the second script', async () => {
    const first = manager.uploadAndSetScript(SCRIPT_A);
    const second = manager.uploadAndSetScript(SCRIPT_B);
    expect(h.uploads).toHaveLength(2);

    h.uploads[1].resolve(URL_B);   // the newer upload lands first
    await settle();
    h.uploads[0].resolve(URL_A);   // the older one lands last
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);

    expect(setScripts()).toEqual([URL_B]);
    expect(manager._lastCloudUrl).toBe(URL_B);
  });

  it('superseded during its own setScript: the newer setScript runs after it, and the cache names the newer script', async () => {
    // The SDK's own 200 ms throttle per command name, as on a device: a
    // setScript right after another one settles is handed THAT one's answer
    // and sent later, unless the manager waits the window out.
    await connectManager({ throttleMs: 200 });
    const heldSetup = h.sdk.hold('setScript');
    const first = manager.uploadAndSetScript(SCRIPT_A);
    h.uploads[0].resolve(URL_A);
    await settle();
    expect(setScripts()).toEqual([URL_A]);   // A's handshake is under way

    const second = manager.uploadAndSetScript(SCRIPT_B);
    h.uploads[1].resolve(URL_B);
    await settle();
    heldSetup.resolve({ result: 1 });
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    // B's own request had left (and answered) by the time B said "set".
    expect(setScripts()).toEqual([URL_A, URL_B]);   // B's set lands last

    // The cache describes B: the same B again needs no upload and no set.
    const again = manager.uploadAndSetScript(SCRIPT_B);
    await expect(again).resolves.toBe(true);
    expect(h.uploads).toHaveLength(2);
    expect(setScripts()).toEqual([URL_A, URL_B]);
  });

  it('a lone upload is untouched: set, cached, true', async () => {
    const only = manager.uploadAndSetScript(SCRIPT_A);
    expect(manager.uploadSeq).toBeGreaterThan(0);
    h.uploads[0].resolve(URL_A);
    await expect(only).resolves.toBe(true);
    expect(setScripts()).toEqual([URL_A]);
    expect(manager._lastCloudUrl).toBe(URL_A);
  });
});

describe('app.js: a superseded upload is neither a success nor a failure', () => {
  let Lifted;
  let app;
  let video;
  let toasts;
  let script;
  const engineStarts = [];

  beforeAll(() => {
    Lifted = makeLoadAppClass({ extra: ['_uploadAndStartSync'] });
  });

  beforeEach(() => {
    ({ app, video, toasts } = buildLoadApp(Lifted, { handyManager: manager }));
    script = null;
    engineStarts.length = 0;
    app.funscriptEngine = { clear() {}, get isLoaded() { return !!script; }, getRawContent: () => script };
    app.syncEngine = {
      _active: false, _scriptReady: false, player: app.videoPlayer,
      stop() { this._active = false; },
      start() { engineStarts.push(script); this._active = true; },
      resync: async () => true,
    };
    app.loadFunscript = vi.fn(async (fs) => { script = fs.textContent; await app._uploadAndStartSync(); });
    app._settingsMap.set('player.autoplayOnOpen', true);
  });

  it('the old video\'s upload landing after Next does not lift the new video\'s gate, toast, or start the engine', async () => {
    await app._playFromLibrary(fileItem('C:\\Lib\\Alpha.mp4'), { name: 'a.funscript', textContent: SCRIPT_A }, null, []);
    await app._playFromLibrary(fileItem('C:\\Lib\\Bravo.mp4'), { name: 'b.funscript', textContent: SCRIPT_B }, null, []);
    await settle();
    video.fire('loadeddata');
    expect(app._waitingForScript).toBe(true);

    h.uploads[0].resolve(URL_A);   // Alpha's upload, superseded twice over
    await settle();
    expect(app._waitingForScript).toBe(true);
    expect(video.play).not.toHaveBeenCalled();
    expect(engineStarts).toEqual([]);
    expect(toasts().map((x) => x.key)).not.toContain('toast.handyUploadFailed');

    h.uploads[1].resolve(URL_B);   // Bravo's own
    await settle();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(engineStarts).toEqual([SCRIPT_B]);
    expect(setScripts()).toEqual([URL_B]);
    expect(toasts().map((x) => x.key)).not.toContain('toast.handyUploadFailed');
  });

  it('a real failure is still a failure: the toast, and the gate opens', async () => {
    await app._playFromLibrary(fileItem('C:\\Lib\\Alpha.mp4'), { name: 'a.funscript', textContent: SCRIPT_A }, null, []);
    await settle();
    video.fire('loadeddata');
    h.uploads[0].reject(new Error('Network Error'));
    await settle();
    expect(toasts().map((x) => x.key)).toContain('toast.handyUploadFailed');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(engineStarts).toEqual([]);
  });
});
