/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-124 (Handy session 2026-11-17, medium): on a slow cloud a pause did not
// stop the Handy for many seconds. Every handyfeeling request was held 4 s
// in the renderer, Long Clip playing, Space 8 s in: HandyManager asked for
// hsspStop at once, but the SDK put the stop request out only 8.8 s later,
// behind its own requests in its ONE request queue (handy.esm.js `z`: every
// request but a play's PUT leaves one at a time). Both stop attempts hit the
// 5 s deadline and the slider stroked on 12.9 s after Space. The queue held
// a play's state read and our own health polls, which pile up there when the
// link is slower than the 3 s poll.
//
// Fixed (2026-11-19, bf-handy):
//   - while the SDK is in HSSP mode the stop request goes straight to the
//     cloud (the SDK's own PUT {API}/hssp/stop), around that queue, as a play
//     already did;
//   - in HandyManager's own chain a stop goes ahead of everything QUEUED (a
//     queued play is dropped, a queued setup runs after it); it waits only
//     for an earlier stop (since 2026-11-20, Dave: "stop it at once", not
//     for a running setup either: a setup the stop made fail is set again,
//     without a play — handy-slow-cloud.test.js);
//   - a health poll is never sent while the last one is unanswered;
//   - a late stop is still a stop (feedback_deadline_before_catch_block): an
//     answer after the deadline takes back the "not responding" it caused,
//     and a late play's success does the same.
// FT-127 (same session, low): a stop answered "Illegal state. Mode specific
// setup required first." (the device lost its HSSP setup) was reported as a
// failed stop, with "Not responding" and the "did not confirm it stopped"
// toast, while the slider sat still. With no setup nothing can run: that
// answer is a stop.
//
// What runs is the REAL HandyManager (and the REAL SyncEngine for the pause)
// on the fake SDK (helpers/fake-handy-sdk.js) with its opt-in request queue,
// timed legs and fake cloud. No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, FAKE_API, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async () => 'https://scripts.local/A.csv',
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';

const LINK_MS = 4000;   // FT-124: every cloud request 4 s late
const SETUP_LEGS = 3;   // setMode, setScript, the state read after it

let m;

afterEach(() => {
  m?._stopHealthCheck();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Connected, the script set, 3 s polls on (a script plays), on a 4 s link. */
async function slowCloudReady({ cloud = true } = {}) {
  vi.useFakeTimers();
  h.sdk = createFakeHandySdk({ queue: true, legMs: LINK_MS, cloud });
  m = new HandyManager();
  if (cloud) m._fetchImpl = h.sdk.fetch;
  await m.init();
  const c = m.connect('TESTKEY01');
  await vi.advanceTimersByTimeAsync(LINK_MS + 10);
  expect(await c).toBe(true);
  const s = m.setupScript('https://scripts.local/A.csv');
  await vi.advanceTimersByTimeAsync(SETUP_LEGS * LINK_MS + 50);
  expect(await s).toBe(true);
  m.setPlaybackActive(true);   // what SyncEngine.start() does
  return m;
}

const leftAt = (name, from = 0) => h.sdk.log.filter((e) => e.name === name && e.at >= from).map((e) => e.at);

describe('FT-124: a pause on a slow cloud — the stop leaves at once', () => {
  it('Long Clip playing, Space 8 s in: the stop request leaves the moment it is asked for, and the device is stopped one link time later', async () => {
    await slowCloudReady();
    m.hsspPlay(0).catch(() => {});
    await vi.advanceTimersByTimeAsync(8000);    // the SDK's own requests are in its queue by now
    const space = Date.now();
    const stop = m.hsspStop();
    await vi.advanceTimersByTimeAsync(10);
    expect(leftAt('hsspStop', space), 'the stop left at once, not behind the SDK queue').toEqual([space]);
    await vi.advanceTimersByTimeAsync(LINK_MS);
    await expect(stop).resolves.toBe(true);
    expect(m.responsive).toBe(true);
  });

  it('the stop request is the SDK\'s own: PUT {API}/hssp/stop with the connection key, not the SDK\'s hsspStop', async () => {
    await slowCloudReady();
    const seen = [];
    const realFetch = m._fetchImpl;
    m._fetchImpl = (url, init) => { seen.push({ url, method: init.method, key: init.headers['X-Connection-Key'] }); return realFetch(url, init); };
    const sdkStop = vi.spyOn(h.sdk, 'hsspStop');
    const stop = m.hsspStop();
    await vi.advanceTimersByTimeAsync(LINK_MS + 10);
    await expect(stop).resolves.toBe(true);
    expect(seen).toEqual([{ url: `${FAKE_API}/hssp/stop`, method: 'PUT', key: 'TESTKEY01' }]);
    expect(sdkStop).not.toHaveBeenCalled();
  });

  it('control: with the SDK out of HSSP mode (after HDSP) the stop goes through the SDK, which switches the mode first', async () => {
    h.sdk = createFakeHandySdk({ cloud: true });
    m = new HandyManager();
    const fetchSpy = vi.fn(h.sdk.fetch);
    m._fetchImpl = fetchSpy;
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
    await h.sdk.updateState({ mode: 2 });   // HDSP drove it (a non-1x rate, the Orgasm Switch)
    const mark = h.sdk.calls.length;
    await expect(m.hsspStop()).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.sdk.calls.slice(mark).map(([n]) => n)).toEqual(['setMode', 'hsspStop']);
  });

  it('the default fetch is called bare, never with HandyManager as its receiver ("Illegal invocation" in Chromium)', async () => {
    vi.stubGlobal('fetch', function strictFetch(url, init) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return h.sdk.fetch(url, init);
    });
    vi.useFakeTimers();
    h.sdk = createFakeHandySdk({ cloud: true });
    m = new HandyManager();   // the default _fetchImpl
    await m.init();
    const c = m.connect('TESTKEY01');
    await vi.advanceTimersByTimeAsync(50);
    expect(await c).toBe(true);
    m._stopHealthCheck();
    const s = m.setupScript('https://scripts.local/A.csv');
    await vi.advanceTimersByTimeAsync(50);
    expect(await s).toBe(true);
    const stop = m.hsspStop();
    await vi.advanceTimersByTimeAsync(50);
    await expect(stop).resolves.toBe(true);
    expect(h.sdk.calls.filter(([n, a]) => n === 'hsspStop' && a === 'direct')).toHaveLength(1);
  });
});

describe('FT-124: health polls never pile up in the SDK queue', () => {
  it('40 s of playing on a 4 s link with a 3 s poll: never more than one poll unanswered', async () => {
    await slowCloudReady();
    let out = 0;
    let maxOut = 0;
    let asked = 0;
    const real = h.sdk.API.get.connected;
    h.sdk.API.get.connected = async (key) => {
      asked++;
      out++;
      maxOut = Math.max(maxOut, out);
      try { return await real(key); } finally { out--; }
    };
    await vi.advanceTimersByTimeAsync(40000);
    expect(asked).toBeGreaterThan(3);
    expect(maxOut).toBe(1);
  });
});

describe('FT-124: in HandyManager\'s chain a stop goes ahead of anything queued', () => {
  beforeEach(async () => {
    h.sdk = createFakeHandySdk();
    m = attachFakeCloud(new HandyManager(), h.sdk);
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    m._hsspSpacingMs = 0;
    m._setScriptSpacingMs = 0;
    expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
    // Out of the fake SDK's per-name window (it closes a macrotask after the
    // answer), so the next setScript is answered by its own request.
    await new Promise((r) => setTimeout(r, 5));
    h.sdk.calls.length = 0;
  });

  const hsspLegs = () => h.sdk.calls
    .filter(([n]) => n === 'setScript' || n === 'hsspStop' || n === 'hsspPlay')
    .map(([n, a]) => (n === 'setScript' ? `setScript:${String(a).split('/').pop()}` : n));

  it('a setup running, a second setup queued, then a pause: the stop goes at once, during the running setup, before the queued one (Dave 2026-11-20)', async () => {
    const running = h.sdk.hold('setScript');
    const s1 = m.setupScript('https://scripts.local/B.csv');
    await new Promise((r) => setTimeout(r, 0));
    const s2 = m.setupScript('https://scripts.local/C.csv');
    const stop = m.hsspStop();
    await new Promise((r) => setTimeout(r, 5));
    expect(hsspLegs(), 'the stop did not wait for the running setup').toEqual(['setScript:B.csv', 'hsspStop']);
    // C now follows B straight away (the stop is no longer between them), so
    // the real spacing between two setScripts applies again: inside the SDK's
    // per-name window C would be handed B's answer (SDK_SETSCRIPT_SPACING_MS).
    m._setScriptSpacingMs = 10;
    running.resolve({ result: 1 });
    await Promise.all([s1, s2, stop]);
    expect(hsspLegs(), 'B landed, so it is not set again; C runs after the stop').toEqual(['setScript:B.csv', 'hsspStop', 'setScript:C.csv']);
  });

  it('a setup running and a play queued behind it, then a pause: the play is dropped and the stop goes right after the setup', async () => {
    const running = h.sdk.hold('setScript');
    const s1 = m.setupScript('https://scripts.local/B.csv');
    await new Promise((r) => setTimeout(r, 0));
    const play = m.hsspPlay(1000);
    const stop = m.hsspStop();
    running.resolve({ result: 1 });
    await expect(play).resolves.toBe(false);
    await Promise.all([s1, stop]);
    expect(hsspLegs()).toEqual(['setScript:B.csv', 'hsspStop']);
  });

  it('a play asked for after the pause still waits for the stop (nothing races a stop back to the device)', async () => {
    const running = h.sdk.hold('setScript');
    const s1 = m.setupScript('https://scripts.local/B.csv');
    await new Promise((r) => setTimeout(r, 0));
    const s2 = m.setupScript('https://scripts.local/C.csv');
    const slowStop = h.sdk.hold('hsspStop');
    const stop = m.hsspStop();
    const later = m.hsspPlay(2000);
    running.resolve({ result: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(hsspLegs()).toEqual(['setScript:B.csv', 'hsspStop']);
    slowStop.resolve({ result: 0 });
    await Promise.all([s1, s2, stop]);
    await expect(later).resolves.toBe(true);
    expect(hsspLegs()).toEqual(['setScript:B.csv', 'hsspStop', 'setScript:C.csv', 'hsspPlay']);
  });
});

describe('a late stop is still a stop (FT-124, feedback_deadline_before_catch_block)', () => {
  beforeEach(async () => {
    h.sdk = createFakeHandySdk({ cloud: true });
    m = new HandyManager();
    m._fetchImpl = h.sdk.fetch;
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
    m._hsspTimeoutMs = 30;
  });

  it('both stop attempts pass the deadline, then the device answers: "not responding" is taken back', async () => {
    const changes = [];
    m.onResponsivenessChange = (r) => changes.push(r);
    const first = h.sdk.hold('hsspStop');
    const second = h.sdk.hold('hsspStop');
    await expect(m.hsspStop()).resolves.toBe(false);    // the toast's contract: may still be moving
    expect(m.responsive).toBe(false);
    first.resolve({ result: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.responsive).toBe(true);
    expect(changes).toEqual([false, true]);
    second.resolve({ result: 0 });
  });

  it('a late answer does not speak for the device after a newer request was asked for', async () => {
    const first = h.sdk.hold('hsspStop');
    const second = h.sdk.hold('hsspStop');
    await expect(m.hsspStop()).resolves.toBe(false);
    h.sdk.answer('hsspPlay', new Error('Device timeout'));
    await m.hsspPlay(1000);                               // a newer request, and it failed
    expect(m.responsive).toBe(false);
    first.resolve({ result: 0 });
    second.resolve({ result: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.responsive).toBe(false);
  });

  it('a play that answers ok after its deadline takes back "not responding" too', async () => {
    const late = h.sdk.hold('hsspPlay');
    await expect(m.hsspPlay(1000)).resolves.toBe(false);
    expect(m.responsive).toBe(false);
    late.resolve({ result: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.responsive).toBe(true);
  });
});

describe('FT-127: a stop on a Handy that lost its HSSP setup is a stop', () => {
  const SETUP_LOST = 'Illegal state. Mode specific setup required first.';

  async function manager({ cloud }) {
    h.sdk = createFakeHandySdk({ cloud });
    m = new HandyManager();
    if (cloud) m._fetchImpl = h.sdk.fetch;
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    m._hsspSpacingMs = 0;
    expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
    return m;
  }

  for (const cloud of [true, false]) {
    it(`answered "${SETUP_LOST}" (${cloud ? 'sent straight to the cloud' : 'through the SDK'}): true, one attempt, no error, still responding`, async () => {
      await manager({ cloud });
      const onError = vi.fn();
      m.onError = onError;
      h.sdk.answer('hsspStop', new Error(SETUP_LOST));
      await expect(m.hsspStop()).resolves.toBe(true);
      expect(h.sdk.sent('hsspStop')).toHaveLength(1);
      expect(onError).not.toHaveBeenCalled();
      expect(m.responsive).toBe(true);
    });
  }

  it('through the REAL SyncEngine: the pause raises no "did not confirm it stopped" toast', async () => {
    await manager({ cloud: true });
    const engine = new SyncEngine({
      videoPlayer: { video: new EventTarget(), paused: true, currentTime: 5 },
      handyManager: m,
      funscriptEngine: { isLoaded: true },
    });
    engine._active = true;
    engine.onStopFailed = vi.fn();
    h.sdk.answer('hsspStop', new Error(SETUP_LOST));
    await engine._handlePause();
    expect(engine.onStopFailed).not.toHaveBeenCalled();
  });

  it('control: any other stop error still fails after the retry, with the toast\'s false', async () => {
    await manager({ cloud: true });
    const onError = vi.fn();
    m.onError = onError;
    h.sdk.answer('hsspStop', new Error('Device timeout'));
    h.sdk.answer('hsspStop', new Error('Device timeout'));
    await expect(m.hsspStop()).resolves.toBe(false);
    expect(h.sdk.sent('hsspStop')).toHaveLength(2);
    expect(onError).toHaveBeenCalledWith('error.handyStopFailed');
  });

  it('the next play re-sets the script the device lost, then plays', async () => {
    await manager({ cloud: true });
    m._lastCloudUrl = 'https://scripts.local/A.csv';
    h.sdk.answer('hsspStop', new Error(SETUP_LOST));
    await expect(m.hsspStop()).resolves.toBe(true);
    h.sdk.answer('hsspPlay', new Error(SETUP_LOST));
    const mark = h.sdk.calls.length;
    await expect(m.hsspPlay(1000)).resolves.toBe(true);
    expect(h.sdk.calls.slice(mark).map(([n]) => n)).toEqual(['hsspPlay', 'setScript', 'hsspPlay']);
  });
});
