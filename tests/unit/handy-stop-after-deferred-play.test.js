/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Block F review follow-ups (bf-review 2026-11-19, fixed in bf-fixup).
//
// BF-R1 (major, new since v0.9.2: the direct stop is). The SDK throttles each
// command name (handy.esm.js `#f`, throttleDelay 200 ms): a play handed to it
// while the previous hsspPlay is still unanswered is answered with that
// call's promise, and its own PUT /hssp/play leaves 200 ms LATER. On the
// FT-124 slow cloud every SDK play is unanswered past its 5 s deadline, so
// this is every play made within ~8 s of the previous one, SyncEngine's 2.5 s
// correction play included. A pause inside those 200 ms sent its stop
// straight to the cloud (FT-124) at once, so the device got stop, then PLAY,
// and kept playing under a paused video. Through the SDK the stop is no
// safer: when the SDK's request queue is empty (the previous play's own PUT
// is the slow part) its stop leaves at once too. Fix: a stop waits until a
// play the SDK holds back has left (at most throttleDelay + 50 ms), then
// goes: the stop is always the last word and still leaves within ~250 ms of
// the pause (FT-124's gain: 7.45 s before it).
//
// BF-R2 (minor). The late-answer handler of a stop was keyed to `_hsspGen`
// read when the stop RAN, not when it was asked for. A play asked for while
// the stop waited (behind a running setup) is newer news, yet the stop's late
// answer took "Not responding" back over that play's failure. The same for a
// play's self-heal retry, which read the generation after its setScript.
//
// REAL HandyManager (and REAL SyncEngine) on the repo's fake SDK
// (helpers/fake-handy-sdk.js) with its slow-cloud options and the SDK's real
// 200 ms throttle. No network; the key is the fake TESTKEY01.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud, FW4_INFO } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async () => 'https://scripts.local/A.csv',
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';

const LINK_MS = 4000;      // FT-124: every cloud request 4 s late
const THROTTLE_MS = 200;   // the real SDK's throttleDelay

let m;
afterEach(() => { m?._stopHealthCheck(); vi.useRealTimers(); });

async function slowCloud({ cloud = true, legMsFor = null } = {}) {
  vi.useFakeTimers();
  h.sdk = createFakeHandySdk({ queue: true, legMs: LINK_MS, legMsFor, cloud, throttleMs: THROTTLE_MS });
  m = attachFakeCloud(new HandyManager(), h.sdk);
  await m.init();
  const c = m.connect('TESTKEY01');
  await vi.advanceTimersByTimeAsync(LINK_MS + 10);
  expect(await c).toBe(true);
  const s = m.setupScript('https://scripts.local/A.csv');
  await vi.advanceTimersByTimeAsync(3 * LINK_MS + 50);
  expect(await s).toBe(true);
  m.setPlaybackActive(true);
  await vi.advanceTimersByTimeAsync(1000);
}

/** Device-moving legs (play / stop) that left at or after `from`, in order. */
const movingLegs = (from) => h.sdk.log
  .filter((e) => (e.name === 'hsspPlay' || e.name === 'hsspStop') && e.at >= from)
  .map((e) => ({ name: e.name, at: e.at - from }));

/**
 * A play, a second play 2.5 s later (a seek / the correction), which the
 * chain hands to the SDK when the first one's 5 s deadline passes while the
 * SDK has not answered it, then a pause `pauseAfterMs` after that hand-over.
 */
async function pauseAfterHeldBackPlay(pauseAfterMs) {
  const t0 = Date.now();
  m.hsspPlay(0).catch(() => {});
  await vi.advanceTimersByTimeAsync(2500);
  m.hsspPlay(2500).catch(() => {});
  await vi.advanceTimersByTimeAsync(2500 + pauseAfterMs);
  const pauseAt = Date.now();
  const stop = m.hsspStop();
  await vi.advanceTimersByTimeAsync(30000);
  await stop.catch(() => {});
  const legs = movingLegs(t0);
  const afterPause = movingLegs(pauseAt);
  const firstStop = afterPause.find((l) => l.name === 'hsspStop');
  return {
    legs,
    last: legs[legs.length - 1]?.name,
    firstStopAfterPauseMs: firstStop?.at ?? null,
    playsAfterFirstStop: firstStop ? afterPause.filter((l) => l.name === 'hsspPlay' && l.at > firstStop.at).length : null,
  };
}

describe('BF-R1: a stop is never overtaken by a play the SDK is holding back', () => {
  it('slow cloud, direct stop: a pause 60 ms after the hand-over: the held-back play leaves, then the stop, within ~250 ms', async () => {
    await slowCloud();
    const r = await pauseAfterHeldBackPlay(60);
    expect(r.last, JSON.stringify(r.legs)).toBe('hsspStop');
    expect(r.playsAfterFirstStop, JSON.stringify(r.legs)).toBe(0);
    // FT-124's gain stands: the stop is not sent behind the SDK's queue.
    expect(r.firstStopAfterPauseMs).toBeLessThanOrEqual(THROTTLE_MS + 50);
    expect(h.sdk.calls.filter(([n, a]) => n === 'hsspStop' && a === 'direct').length).toBeGreaterThan(0);
  });

  it('through the SDK (cloud: false) with the previous play\'s own PUT the slow part, the SDK queue is empty: the stop still leaves last', async () => {
    // The previous play's PUT takes 9 s, nothing waits in the SDK's queue,
    // so an SDK hsspStop would leave at once: "the stop goes through the
    // SDK" alone does not keep it after the held-back play.
    await slowCloud({ cloud: false, legMsFor: (name) => (name === 'hsspPlay' ? 9000 : LINK_MS) });
    m._stopHealthCheck();   // no poll in the SDK's queue either
    const r = await pauseAfterHeldBackPlay(60);
    expect(r.last, JSON.stringify(r.legs)).toBe('hsspStop');
    expect(r.playsAfterFirstStop, JSON.stringify(r.legs)).toBe(0);
    expect(r.firstStopAfterPauseMs).toBeLessThanOrEqual(THROTTLE_MS + 50);
  });

  it('control: with no play held back the stop leaves the moment it is asked for', async () => {
    await slowCloud();
    const r = await pauseAfterHeldBackPlay(300);   // the held-back play has left already
    expect(r.last).toBe('hsspStop');
    expect(r.firstStopAfterPauseMs).toBe(0);
  });

  it('REAL SyncEngine: a pause 50 ms after the 2.5 s correction play is handed over: no play reaches the device after the pause\'s stop', async () => {
    await slowCloud();
    const t0 = Date.now();
    const video = Object.assign(new EventTarget(), { paused: false, seeking: false, readyState: 4, error: null, ended: false });
    Object.defineProperty(video, 'currentTime', { get: () => (video.paused ? video._frozen : (Date.now() - t0) / 1000) });
    const player = { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } };
    const engine = new SyncEngine({ videoPlayer: player, handyManager: m, funscriptEngine: { isLoaded: true } });
    engine._scriptReady = true;
    engine.start();

    const sdkPlay = h.sdk.hsspPlay;
    let handedAt = null;
    h.sdk.hsspPlay = (...a) => { if (Date.now() > t0 + 100 && handedAt == null) handedAt = Date.now(); return sdkPlay(...a); };
    for (let i = 0; i < 400 && handedAt == null; i++) await vi.advanceTimersByTimeAsync(50);
    expect(handedAt, 'the correction play was handed to the SDK').not.toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    video._frozen = video.currentTime;
    video.paused = true;
    const pauseAt = Date.now();
    video.dispatchEvent(new Event('pause'));
    await vi.advanceTimersByTimeAsync(40000);
    engine.stop();

    const after = movingLegs(pauseAt - 300);
    const firstStop = h.sdk.log.find((e) => e.name === 'hsspStop' && e.at >= pauseAt);
    expect(firstStop, JSON.stringify(after)).toBeTruthy();
    const playsAfter = h.sdk.log.filter((e) => e.name === 'hsspPlay' && e.at > firstStop.at).length;
    expect(playsAfter, JSON.stringify(after)).toBe(0);
    expect(firstStop.at - pauseAt).toBeLessThanOrEqual(THROTTLE_MS + 50);
  });
});

describe('BF-R2: a late answer speaks only for the request it belongs to', () => {
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  async function ready() {
    h.sdk = createFakeHandySdk({ info: { ...FW4_INFO } });
    m = attachFakeCloud(new HandyManager(), h.sdk);
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    m._hsspSpacingMs = 0;
    m._setScriptSpacingMs = 0;
    expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
    await tick(5);
  }

  it('a play asked for while the stop waited behind a setup fails; the stop\'s late answer does not say the device responds', async () => {
    await ready();
    const running = h.sdk.hold('setScript');          // an editor save's setScript
    const setup = m.setupScript('https://scripts.local/B.csv');
    await tick();
    m._hsspTimeoutMs = 30;
    const first = h.sdk.hold('hsspStop');
    const second = h.sdk.hold('hsspStop');
    const stop = m.hsspStop();                         // waits for the running setup
    h.sdk.answer('hsspPlay', new Error('Device timeout'));
    const play = m.hsspPlay(1000);                     // newer than the stop
    running.resolve({ result: 1 });
    await setup;
    await expect(stop).resolves.toBe(false);
    await expect(play).resolves.toBe(false);
    expect(m.responsive).toBe(false);
    first.resolve({ result: 0 });                      // the OLD stop answers late
    await tick();
    expect(m.responsive, 'the stop\'s late answer spoke over the newer failed play').toBe(false);
    second.resolve({ result: 0 });
  });

  it('control: with nothing asked for after it, a stop\'s late answer still takes "not responding" back', async () => {
    await ready();
    m._hsspTimeoutMs = 30;
    const first = h.sdk.hold('hsspStop');
    const second = h.sdk.hold('hsspStop');
    await expect(m.hsspStop()).resolves.toBe(false);
    expect(m.responsive).toBe(false);
    first.resolve({ result: 0 });
    await tick();
    expect(m.responsive).toBe(true);
    second.resolve({ result: 0 });
  });

  it('a play\'s self-heal retry: a play asked for during its setScript fails; the retry\'s late answer does not say the device responds', async () => {
    await ready();
    // Uploaded and set the way the app does, so the self-heal has the cloud URL.
    expect(await m.uploadAndSetScript('{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}]}')).toBe(true);
    await tick(5);
    await h.sdk.updateState({ hssp: { scriptSet: false } });   // HDSP cleared the setup
    const reSet = h.sdk.hold('setScript');
    const retryLeg = h.sdk.hold('hsspPlay');
    const healing = m.hsspPlay(500);                   // throws locally, re-sets the script
    await tick();
    const newer = m.hsspPlay(900);                     // asked for during that setScript
    m._hsspTimeoutMs = 30;
    reSet.resolve({ result: 0 });
    await tick(5);
    // The newer play is refused before anything is sent (old firmware read).
    await h.sdk.updateState({ info: { fwVersion: '2.0.0' } });
    await expect(healing).resolves.toBe(false);        // its retry passed the deadline
    await expect(newer).resolves.toBe(false);
    expect(m.responsive).toBe(false);
    retryLeg.resolve({ result: 0 });                   // the old retry answers late
    await tick();
    expect(m.responsive, 'the retry\'s late answer spoke over the newer failed play').toBe(false);
  });
});
