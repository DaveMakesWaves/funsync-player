/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Block F review, 2026-11-16 (major; also in v0.9.2): the SDK throttles each
// command NAME (handy.esm.js `#f`, `throttleDelay` 200 ms). A call made while
// the last call of that name is in flight, or within 200 ms of it SETTLING, is
// handed THAT call's promise, and its own request leaves 200 ms later. The
// HSSP chain sends the next call the instant the last settles, so:
//
//   - play, play (start() and the element's own 'playing' 1 ms apart), then a
//     pause: the second play "answered" at once, the pause's stop went out at
//     once, and the second play's own request left AFTER it: the device got
//     play, stop, PLAY and ran the script under a paused video. Nothing in
//     SyncEngine could see it (that play had already answered);
//   - stop, stop, then a play (two quick seeks): the second stop left after
//     the play and stopped a playing device until the 2.5 s correction.
//
// HandyManager now keeps hsspPlay / hsspStop out of the previous same-name
// call's window inside the HSSP chain (as `_sdkSetScript` does), and a play
// re-checks for a stop after that wait. What runs is the REAL HandyManager
// (and the REAL SyncEngine) on the fake SDK with the SDK's own 200 ms window
// (helpers/fake-handy-sdk.js `throttleMs`). Assertions are on the legs the
// device was sent, in order. No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async () => 'https://scripts.local/A.csv',
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';

const SDK_WINDOW_MS = 200;   // handy.esm.js throttleDelay
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** The HSSP legs that reached the device, in order. */
const legs = () => h.sdk.order().filter((n) => n === 'hsspPlay' || n === 'hsspStop');

let m;

beforeEach(async () => {
  h.sdk = createFakeHandySdk({ throttleMs: SDK_WINDOW_MS });
  m = attachFakeCloud(new HandyManager(), h.sdk);
  await m.init();
  expect(await m.connect('TESTKEY01')).toBe(true);
  m._stopHealthCheck();
  expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
  await wait(SDK_WINDOW_MS + 50);   // out of every window
  h.sdk.calls.length = 0;
});

afterEach(() => {
  m._stopHealthCheck();
});

describe('a stop always wins over a play the SDK throttle deferred', () => {
  it('play, play inside the window, then a pause: the stop is the last word', async () => {
    const p1 = m.hsspPlay(1000);        // start()
    await wait(0);
    const p2 = m.hsspPlay(1001);        // the element's own 'playing', 1 ms later
    expect(await p1).toBe(true);
    const stop = m.hsspStop();          // the user pauses right away
    expect(await stop).toBe(true);
    expect(await p2).toBe(false);       // overtaken while it waited: dropped
    await wait(SDK_WINDOW_MS + 100);    // anything deferred has gone by now
    expect(legs(), 'a deferred play reached the device after the pause').toEqual(['hsspPlay', 'hsspStop']);
    expect(legs().at(-1)).toBe('hsspStop');
  });

  it('play, play inside the window, no stop: the second play still goes, once, with its own time', async () => {
    const p1 = m.hsspPlay(1000);
    await wait(0);
    const p2 = m.hsspPlay(1300);
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    await wait(SDK_WINDOW_MS + 100);
    expect(legs()).toEqual(['hsspPlay', 'hsspPlay']);
    // Its own request, not the first one's answer: the device got 1300.
    expect(h.sdk.sent('hsspPlay').map(([, at]) => at)).toEqual([1000, 1300]);
  });

  it('stop, stop inside the window, then a play: the play is the last word (two quick seeks)', async () => {
    expect(await m.hsspStop()).toBe(true);
    const s2 = m.hsspStop();
    const play = m.hsspPlay(5000);
    expect(await s2).toBe(true);
    expect(await play).toBe(true);
    await wait(SDK_WINDOW_MS + 100);
    expect(legs(), 'a deferred stop stopped a device that should play').toEqual(['hsspStop', 'hsspStop', 'hsspPlay']);
  });

  it('a call the SDK refuses before its throttle opens no window (the self-heal is not held back)', async () => {
    // HDSP cleared scriptSet: the play throws locally, the self-heal re-sets
    // the cached script and plays at once.
    await h.sdk.updateState({ hssp: { scriptSet: false } });
    m._lastCloudUrl = 'https://scripts.local/A.csv';   // what an upload caches
    const t0 = Date.now();
    expect(await m.hsspPlay(2000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(SDK_WINDOW_MS);
    expect(legs()).toEqual(['hsspPlay']);
  });
});

describe('through the REAL SyncEngine: start() and "playing" 1 ms apart, then a pause', () => {
  it('the device ends stopped', async () => {
    const video = Object.assign(new EventTarget(), { paused: false, seeking: false, readyState: 4, error: null, currentTime: 3 });
    const player = { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } };
    const engine = new SyncEngine({ videoPlayer: player, handyManager: m, funscriptEngine: { isLoaded: true } });
    engine._scriptReady = true;
    engine.start();                                  // anchors at once (video playing)
    await wait(0);
    video.dispatchEvent(new Event('playing'));       // the element's own, 1 ms later
    await wait(30);
    video.paused = true;
    video.dispatchEvent(new Event('pause'));
    await wait(SDK_WINDOW_MS * 2 + 200);
    engine.stop();
    expect(legs().at(-1), 'the device runs the script under a paused video').toBe('hsspStop');
    expect(legs().lastIndexOf('hsspPlay')).toBeLessThan(legs().lastIndexOf('hsspStop'));
  });
});
