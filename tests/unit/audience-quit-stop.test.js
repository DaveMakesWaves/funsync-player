/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Quitting with an audience room open must stop every viewer's device
// (#361 research §4.11; SCOPE AB-20 claimed it, the code did not). A viewer's
// Handy plays its HSSP script on its own clock: a FunSync that closes
// without stopping it leaves a device running in someone else's room.
//
//   - electron/relaunch-stop.js `holdCloseForStop`: while a room is open,
//     main holds the main window's first close for the renderer's stop
//     handshake, bounded, then closes. With no room, nothing changes.
//   - app.js `_stopForRelaunch` (the REAL method, lifted) answers that
//     handshake; run here against a REAL AudienceBridge whose viewers are
//     faked to HandyManager's real contract, asserting the devices stopped.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { AudienceBridge } from '../../renderer/js/audience-bridge.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { liftAppClass } from './helpers/app-methods.js';
import { makeWorld, makeFakeHandyCtor, makeUploader, scriptContent, deviceOf } from './helpers/fake-viewer-handy.js';

const require_ = createRequire(import.meta.url);
const { holdCloseForStop, REQUEST_CHANNEL, DONE_CHANNEL, QUIT_STOP_TIMEOUT_MS } = require_('../../electron/relaunch-stop.js');

afterEach(() => { vi.useRealTimers(); });

/** A BrowserWindow stand-in: 'close' is cancellable, and an uncancelled
 *  close is counted. `answer` decides whether the renderer replies. */
function fakeWindow({ ipcMain, answer = true }) {
  const win = new EventEmitter();
  win.closed = 0;
  win.asked = 0;
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.webContents = {
    isDestroyed: () => win.destroyed,
    send: (channel, token) => {
      if (channel !== REQUEST_CHANNEL) return;
      win.asked++;
      if (answer) setImmediate(() => ipcMain.emit(DONE_CHANNEL, { sender: win.webContents }, token));
    },
  };
  win.close = () => {
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) { win.closed++; win.destroyed = true; }
  };
  return win;
}

describe('holdCloseForStop — closing the main window with a room open', () => {
  it('holds the first close, asks the renderer to stop, then closes once it has', async () => {
    const ipcMain = new EventEmitter();
    const win = fakeWindow({ ipcMain });
    const outcomes = [];
    holdCloseForStop({ win, ipcMain, shouldStop: () => true, onOutcome: (o) => outcomes.push(o) });
    win.close();
    expect(win.closed).toBe(0);           // held
    expect(win.asked).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(outcomes).toEqual(['stopped']);
    expect(win.closed).toBe(1);           // closed for real, once
  });

  it('with no room open the close is not held and nothing is asked', () => {
    const ipcMain = new EventEmitter();
    const win = fakeWindow({ ipcMain });
    holdCloseForStop({ win, ipcMain, shouldStop: () => false });
    win.close();
    expect(win.closed).toBe(1);
    expect(win.asked).toBe(0);
  });

  it('a renderer that never answers cannot keep the app open: it closes after the bound', async () => {
    vi.useFakeTimers();
    const ipcMain = new EventEmitter();
    const win = fakeWindow({ ipcMain, answer: false });
    const outcomes = [];
    holdCloseForStop({ win, ipcMain, shouldStop: () => true, onOutcome: (o) => outcomes.push(o) });
    win.close();
    await vi.advanceTimersByTimeAsync(QUIT_STOP_TIMEOUT_MS - 1);
    expect(win.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcomes).toEqual(['timeout']);
    expect(win.closed).toBe(1);
    expect(QUIT_STOP_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it('a quit that already stopped in before-quit is not held a second time', () => {
    const ipcMain = new EventEmitter();
    const win = fakeWindow({ ipcMain });
    const guard = holdCloseForStop({ win, ipcMain, shouldStop: () => true });
    guard.markStopped();
    win.close();
    expect(win.closed).toBe(1);
    expect(win.asked).toBe(0);
  });
});

describe('_stopForRelaunch (the REAL app.js method) stops every audience viewer', () => {
  it('a room playing on two viewers is stopped on both devices before it answers', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const player = { playing: false, timeMs: 0, rate: 1 };
    const bridge = new AudienceBridge({
      settings: { get: () => undefined, set: () => {} },
      eventBus: { emit: () => {} },
      HandyManagerCtor: makeFakeHandyCtor(world, { latency: 300 }),
      getCurrentVideoTimeMs: () => player.timeMs,
      isVideoPlaying: () => player.playing,
      getPlaybackRate: () => player.rate,
      uploadScript: makeUploader().upload,
    });
    bridge.openRoom();
    for (const key of ['A', 'B']) {
      const p = bridge.addViewer({ key });
      await vi.runAllTimersAsync();
      await p;
    }
    bridge.setScript(bridge.beginSource({ title: 'x' }), { content: scriptContent('x') });
    player.playing = true;
    bridge.onPlaying();
    await vi.runAllTimersAsync();
    expect(deviceOf(world, 'A').playing).toBe(true);
    expect(deviceOf(world, 'B').playing).toBe(true);

    const Lifted = liftAppClass(['_stopForRelaunch'], {
      window: { funsync: {} }, PLAYERWIN, console: { log() {}, warn() {} },
    });
    const app = Object.assign(new Lifted(), {
      videoPlayer: { video: { pause: () => { player.playing = false; bridge.onPaused(); } } },
      _playerWindowActive: false,
      _recordResumePosition() {},
      orgasmSwitch: { active: false },
      audienceBridge: bridge,
    });
    let answered = false;
    const run = app._stopForRelaunch().then(() => { answered = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(answered).toBe(false);           // waits for the stops to answer
    await vi.runAllTimersAsync();
    await run;
    expect(deviceOf(world, 'A').playing).toBe(false);
    expect(deviceOf(world, 'B').playing).toBe(false);
  });
});
