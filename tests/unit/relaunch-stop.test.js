/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Import Backup File and Restore From Backup must stop playback and every
// device before they relaunch the app (V02 review).
//
// The relaunch is app.exit(0), which destroys the window WITHOUT running the
// renderer's beforeunload, and beforeunload is where the devices are stopped
// on an ordinary close. A Handy in HSSP plays the script on its own clock, so
// it kept stroking after the app was gone, and the relaunched app's
// connect() sends no stop. Restore had this since it shipped; Import got it
// when it started relaunching.
//
// Each piece runs for real here:
//   - electron/relaunch-stop.js: main asks and waits, bounded;
//   - electron/preload.js: carries the ask and the answer (loaded with only
//     `electron` stubbed);
//   - app.js `_stopForRelaunch`: the stop itself. app.js self-instantiates
//     on import, so the REAL method body is lifted out and run against
//     recording fakes, as recovery-toast.test.js does.
// That applyImport waits for the stop before it reads, writes or relaunches
// is pinned in import-backup-roundtrip.test.js.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const require_ = createRequire(import.meta.url);
const { askRendererToStop, DONE_CHANNEL } = require_('../../electron/relaunch-stop.js');

// --- main ⇄ renderer -------------------------------------------------------

function fakeWebContents() {
  return { isDestroyed: () => false, send: vi.fn() };
}

/** The real preload.js, with `electron` stubbed by a pair of emitters. */
function loadPreload({ ipcMain, webContents }) {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = vi.fn();
  // Renderer → main, as Electron delivers it: (event, ...args) with a sender.
  ipcRenderer.send = (channel, ...args) => ipcMain.emit(channel, { sender: webContents }, ...args);
  // Main → renderer.
  webContents.send = (channel, ...args) => ipcRenderer.emit(channel, {}, ...args);
  let api = null;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer,
    webUtils: {},
  };
  const resolved = require_.resolve('../../electron/preload.js');
  delete require_.cache[resolved];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  try {
    require_(resolved);
  } finally {
    Module._load = origLoad;
  }
  return api;
}

describe('main asks the renderer to stop and waits for the answer', () => {
  it('waits until the renderer has stopped, through the real preload', async () => {
    const ipcMain = new EventEmitter();
    const webContents = fakeWebContents();
    const api = loadPreload({ ipcMain, webContents });
    let stoppedAt = 0;
    api.onStopForRelaunch(async (token) => {
      await new Promise((r) => setTimeout(r, 40)); // devices answering
      stoppedAt = Date.now();
      api.stoppedForRelaunch(token);
    });

    const outcome = await askRendererToStop({ webContents, ipcMain, timeoutMs: 2000 });

    expect(outcome).toBe('stopped');
    expect(stoppedAt).toBeGreaterThan(0);
    expect(ipcMain.listenerCount(DONE_CHANNEL)).toBe(0);
  });

  it('a renderer that never answers does not block the import: it gives up after the timeout', async () => {
    const ipcMain = new EventEmitter();
    const webContents = fakeWebContents(); // send() goes nowhere
    const started = Date.now();
    expect(await askRendererToStop({ webContents, ipcMain, timeoutMs: 60 })).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(ipcMain.listenerCount(DONE_CHANNEL)).toBe(0);
  });

  it('only this request\'s answer, from this window, counts', async () => {
    const ipcMain = new EventEmitter();
    const webContents = fakeWebContents();
    const other = fakeWebContents();
    webContents.send = (_channel, token) => setImmediate(() => {
      ipcMain.emit(DONE_CHANNEL, { sender: webContents }, token + 1); // a stale request
      ipcMain.emit(DONE_CHANNEL, { sender: other }, token);           // another window
    });
    expect(await askRendererToStop({ webContents, ipcMain, timeoutMs: 80 })).toBe('timeout');
  });

  it('does not wait when there is no window to ask', async () => {
    const ipcMain = new EventEmitter();
    expect(await askRendererToStop({ webContents: null, ipcMain })).toBe('no-window');
    expect(await askRendererToStop({ webContents: { isDestroyed: () => true, send: vi.fn() }, ipcMain })).toBe('no-window');
  });
});

// --- the renderer's stop ---------------------------------------------------

function liftMethod(src, signature) {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found in app.js`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

const body = liftMethod(fs.readFileSync('renderer/js/app.js', 'utf8'), 'async _stopForRelaunch()');
// eslint-disable-next-line no-new-func
const makeStop = new Function('window', 'PLAYERWIN', `return async function () {${body}};`);

const ENGINES = ['syncEngine.stop', 'hdsp.stop', 'buttplugSync.stop', 'tcodeSync.stop', 'autoblowSync.stop'];
const DEVICES = ['handy.hsspStop', 'buttplug.stopAll', 'tcode.stop', 'autoblow.syncStop', 'audience.hsspStopAll'];

/** An App with every device connected; each call is recorded, in order. */
function fakeApp({ order, handyAnswer = Promise.resolve(true), ...over } = {}) {
  const rec = (name, ret) => vi.fn(() => { order.push(name); return ret; });
  return {
    videoPlayer: { video: { pause: rec('video.pause') } },
    _playerWindowActive: false,
    _recordResumePosition: rec('resume'),
    orgasmSwitch: { active: false },
    _finishOrgasm: rec('finishOrgasm'),
    syncEngine: { stop: rec('syncEngine.stop') },
    handyHdspSync: { stop: rec('hdsp.stop') },
    buttplugSync: { stop: rec('buttplugSync.stop') },
    tcodeSync: { stop: rec('tcodeSync.stop') },
    autoblowSync: { stop: rec('autoblowSync.stop') },
    handyManager: { connected: true, hsspStop: rec('handy.hsspStop', handyAnswer) },
    buttplugManager: { connected: true, stopAll: rec('buttplug.stopAll', Promise.resolve()) },
    tcodeManager: { connected: true, stop: rec('tcode.stop') },
    autoblowManager: { connected: true, syncStop: rec('autoblow.syncStop', Promise.resolve()) },
    audienceBridge: { roomActive: true, hsspStopAll: rec('audience.hsspStopAll', Promise.resolve([])) },
    ...over,
  };
}

describe('_stopForRelaunch (the REAL app.js method)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('pauses, stops every engine, then sends every connected device a real stop and waits for the answers', async () => {
    const order = [];
    let handyAnswers;
    const app = fakeApp({ order, handyAnswer: new Promise((r) => { handyAnswers = r; }) });
    let settled = false;
    const run = makeStop({ funsync: {} }, PLAYERWIN).call(app).then(() => { settled = true; });

    await new Promise((r) => setTimeout(r, 30));
    expect(settled, 'must wait for the Handy to answer its stop').toBe(false);
    handyAnswers(true);
    await run;

    expect(order[0]).toBe('video.pause');
    for (const name of [...ENGINES, ...DEVICES]) expect(order.filter((n) => n === name)).toHaveLength(1);
    const lastEngine = Math.max(...ENGINES.map((n) => order.indexOf(n)));
    const firstDevice = Math.min(...DEVICES.map((n) => order.indexOf(n)));
    expect(lastEngine, 'an engine still running could re-send a position after the stop').toBeLessThan(firstDevice);
  });

  it('keeps the resume position, as beforeunload would have', async () => {
    const order = [];
    const app = fakeApp({ order });
    await makeStop({ funsync: {} }, PLAYERWIN).call(app);
    expect(app._recordResumePosition).toHaveBeenCalledWith({ force: true });
  });

  it('pauses the pop-out when it owns playback', async () => {
    const order = [];
    const relay = vi.fn(async () => {});
    const app = fakeApp({ order, _playerWindowActive: true });
    await makeStop({ funsync: { playerPopoutRelay: relay } }, PLAYERWIN).call(app);
    expect(relay).toHaveBeenCalledWith('to-popout', { type: PLAYERWIN.SET_PLAY_STATE, paused: true });
  });

  it('ends a running Orgasm Switch, whose own loop drives Buttplug and T-Code, before the device stops', async () => {
    const order = [];
    const app = fakeApp({ order, orgasmSwitch: { active: true } });
    await makeStop({ funsync: {} }, PLAYERWIN).call(app);
    expect(order.indexOf('finishOrgasm')).toBeGreaterThan(-1);
    expect(order.indexOf('finishOrgasm')).toBeLessThan(Math.min(...DEVICES.map((n) => order.indexOf(n))));
  });

  it('sends nothing to a device that is not connected', async () => {
    const order = [];
    const app = fakeApp({ order });
    app.handyManager.connected = false;
    app.tcodeManager.connected = false;
    app.audienceBridge.roomActive = false;
    await makeStop({ funsync: {} }, PLAYERWIN).call(app);
    expect(order).not.toContain('handy.hsspStop');
    expect(order).not.toContain('tcode.stop');
    expect(order).not.toContain('audience.hsspStopAll');
    expect(order).toContain('buttplug.stopAll');
  });

  it('a device that never answers does not hold the relaunch: it gives up after 3 s', async () => {
    vi.useFakeTimers();
    const order = [];
    const app = fakeApp({ order, handyAnswer: new Promise(() => {}) });
    let settled = false;
    makeStop({ funsync: {} }, PLAYERWIN).call(app).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(order).toContain('handy.hsspStop');
  });

  it('Buttplug "connected" with its client gone (its stop never answers) does not hold it either (TODO: possible quit hang)', async () => {
    vi.useFakeTimers();
    const order = [];
    const app = fakeApp({ order });
    app.buttplugManager = { connected: true, stopAll: vi.fn(() => { order.push('buttplug.stopAll'); return new Promise(() => {}); }) };
    let settled = false;
    makeStop({ funsync: {} }, PLAYERWIN).call(app).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(true);
    expect(order).toContain('buttplug.stopAll');
  });
});
