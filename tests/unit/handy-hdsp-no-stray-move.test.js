/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Fix-up after block F verify-1 (2026-11-16; medium, new since v0.9.2 in
// effect: the HDSP engine only runs since the bare-timer fix). Back at 1x
// after a non-1x rate, the stub cloud got MODE 1, SETUP, PLAY, then an
// hdsp/xpt and PUT /mode 2 0.18-0.4 s later: the HDSP engine calls hdspMove
// every ~33 ms without waiting, the SDK throttles each command name for
// 200 ms after it settles (handy.esm.js `#f`), hands a call inside that window
// the previous call's promise and sends the newest one on its own timer
// 200 ms later. That timer fired after the HSSP play; the SDK's hdsp switched
// the device to mode 2 for it, and the Handy stood still until the 2.5 s
// correction. After a pause during the return, one move + mode 2 reached the
// device after the stop.
//
// Now hdspMove sends one SDK call at a time, never inside that window, with
// the newest position, and a move a halt (the HDSP engine stopping) or any
// HSSP request overtook is never sent. Asserted on the device's legs, in
// order, through the REAL HandyManager and the REAL HandyHdspSync, on a fake
// SDK that keeps the real SDK's rules with its real 200 ms window
// (helpers/fake-handy-sdk.js). No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud, MODE } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, n: 0 }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async () => `https://scripts.local/${++h.n}.csv`,
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { HandyHdspSync } from '../../renderer/js/handy-hdsp-sync.js';

const SDK_WINDOW_MS = 200;   // handy.esm.js `throttleDelay`
const SCRIPT = JSON.stringify({ actions: [
  { at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 800, pos: 0 }, { at: 1200, pos: 100 },
  { at: 1600, pos: 0 }, { at: 2000, pos: 100 }, { at: 2400, pos: 0 }, { at: 2800, pos: 100 },
] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let manager;
let hdsp;
let player;

beforeEach(async () => {
  h.sdk = createFakeHandySdk({ throttleMs: SDK_WINDOW_MS });
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  // Playing at 1x: the script is set and the device plays it.
  expect(await manager.uploadAndSetScript(SCRIPT)).toBe(true);
  expect(await manager.hsspPlay(0)).toBe(true);
  // Seconds pass on a device before the rate changes; past every window.
  await sleep(SDK_WINDOW_MS + 60);
  player = { currentTime: 0.1 };
  hdsp = new HandyHdspSync({ handyManager: manager, player });
  hdsp.setActions(JSON.parse(SCRIPT).actions);
});

afterEach(() => {
  hdsp?.stop();
  manager._stopHealthCheck();
});

/** 1.5x: HDSP drives for `ms`, one tick every 33 ms on a moving picture. */
async function driveHdsp(ms) {
  // Ticks driven here (the engine's own interval is the same 33 ms).
  hdsp.setTimerImpl(() => 1, () => {});
  hdsp.start();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    player.currentTime += 0.033 * 1.5;
    hdsp._tick();
    await sleep(33);
  }
  // The last two ticks 5 ms apart: whatever the phase, the last one is asked
  // for inside the window of the one before (at 33 ms per tick that is the
  // usual case; this makes it the certain one).
  for (let i = 0; i < 2; i++) {
    player.currentTime += 0.033 * 1.5;
    hdsp._tick();
    await sleep(5);
  }
}

const legs = (from = 0) => h.sdk.calls.slice(from);
const strays = (from) => legs(from).filter(([n, a]) => n === 'hdsp' || (n === 'setMode' && a === MODE.HDSP));

describe('back at 1x after HDSP: no HDSP move reaches the device after the HSSP play', () => {
  it('the switch back sends setup + play, and nothing HDSP after it (the device stays in HSSP)', async () => {
    await driveHdsp(700);
    expect(h.sdk.sent('hdsp').length).toBeGreaterThanOrEqual(2);   // HDSP really drove it

    // Back to 1x: the player stops the HDSP engine and starts HSSP.
    const mark = h.sdk.calls.length;
    hdsp.stop();
    await expect(manager.hsspPlay(Math.round(player.currentTime * 1000))).resolves.toBe(true);
    await sleep(3 * SDK_WINDOW_MS);   // anything the SDK kept back has fired by now

    expect(legs(mark).map(([n]) => n)).toEqual(['setMode', 'setScript', 'hsspPlay']);
    expect(strays(mark)).toEqual([]);
    expect(h.sdk.getState().mode).toBe(MODE.HSSP);
    expect(h.sdk.getState().hssp.scriptSet).toBe(true);
  });

  it('a pause during the return: the stop is the device\'s last word, no move or mode 2 after it', async () => {
    await driveHdsp(500);
    const mark = h.sdk.calls.length;
    hdsp.stop();
    const heldSetup = h.sdk.hold('setScript');   // the self-heal setScript is slow
    const play = manager.hsspPlay(Math.round(player.currentTime * 1000));
    await sleep(20);
    const stop = manager.hsspStop();              // the user pauses
    await sleep(20);
    heldSetup.resolve({ result: 1 });
    await expect(play).resolves.toBe(false);
    await expect(stop).resolves.toBe(true);
    await sleep(3 * SDK_WINDOW_MS);

    const names = legs(mark).map(([n]) => n);
    expect(names.at(-1)).toBe('hsspStop');
    expect(names).not.toContain('hsspPlay');
    expect(strays(mark)).toEqual([]);
  });

  it('an HSSP play while our HDSP mode switch is still travelling waits for it, and no move follows', async () => {
    const mark = h.sdk.calls.length;
    const heldMode = h.sdk.hold('setMode');       // the switch into HDSP is slow
    const move = manager.hdspMove(50, 100);
    await sleep(10);
    expect(legs(mark)).toEqual([['setMode', MODE.HDSP]]);
    const play = manager.hsspPlay(2000);          // back at 1x meanwhile
    await sleep(10);
    expect(legs(mark)).toEqual([['setMode', MODE.HDSP]]);   // the play waits for it
    heldMode.resolve({ result: 0 });
    await expect(play).resolves.toBe(true);
    await move;
    await sleep(3 * SDK_WINDOW_MS);

    // The switch cleared the setup, so the play heals it: setMode 1 goes out
    // as its own request (not handed the HDSP switch's answer), then the
    // script and the play. No HDSP move after it, the device ends in HSSP.
    expect(legs(mark).map(([n, a]) => (n === 'setMode' ? `setMode ${a}` : n)))
      .toEqual(['setMode 2', 'setMode 1', 'setScript', 'hsspPlay']);
    expect(h.sdk.getState().mode).toBe(MODE.HSSP);
  });
});

describe('HDSP moves still flow while HDSP drives', () => {
  it('one SDK call at a time, each outside the last one\'s window, the newest position each time', async () => {
    const calledAt = [];
    const realHdsp = h.sdk.hdsp.bind(h.sdk);
    h.sdk.hdsp = (...a) => { calledAt.push(Date.now()); return realHdsp(...a); };

    await driveHdsp(1200);
    hdsp.stop();
    await sleep(3 * SDK_WINDOW_MS);

    // About one move per window (the SDK's own pace), and every one of them
    // was a call the SDK sent at once: as many calls as moves on the wire.
    const sent = h.sdk.sent('hdsp');
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(calledAt.length).toBe(sent.length);
    for (let i = 1; i < calledAt.length; i++) {
      expect(calledAt[i] - calledAt[i - 1]).toBeGreaterThanOrEqual(SDK_WINDOW_MS);
    }
  });

  it('moves asked for while one is out: only the newest goes, after the window', async () => {
    await manager.hdspMove(10, 100);              // the switch into HDSP, then 10
    await sleep(SDK_WINDOW_MS + 40);              // its window has passed
    const mark = h.sdk.calls.length;
    const held = h.sdk.hold('hdsp');
    const first = manager.hdspMove(20, 100);      // goes at once, answer held
    await sleep(5);
    expect(legs(mark)).toEqual([['hdsp', 0.2]]);
    manager.hdspMove(30, 100);
    manager.hdspMove(40, 100);
    held.resolve({ result: 0 });
    await first;
    await sleep(SDK_WINDOW_MS);
    // FW4: the position goes as a fraction (0-1).
    expect(legs(mark)).toEqual([['hdsp', 0.2], ['hdsp', 0.4]]);
  });

  it('a halt drops the move waiting for the window', async () => {
    await manager.hdspMove(10, 100);
    const mark = h.sdk.calls.length;
    const pending = manager.hdspMove(60, 100);    // waits out the window
    manager.hdspHalt();
    await pending;
    await sleep(SDK_WINDOW_MS);
    expect(legs(mark)).toEqual([]);
  });
});
