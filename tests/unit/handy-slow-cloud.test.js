/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A slow cloud is not a failed cloud, and the app used to have no way to tell
// the difference.
//
// Welliambrisk's log (2026-08-27) — the numbers every test here is built on:
//
//   15:24:08  play      1.69s     <- healthy baseline
//   15:25:58  play      1.71s
//   15:26:02  play     20.59s     <-- chain blocked here
//   15:26:23  stop      4.15s        (his pause, finally sent)
//   15:26:27  stop x10  0.00s        (the queue draining)
//   15:26:34  stop     17.08s     <-- a STOP hung, on its own, then SUCCEEDED
//
// Nothing threw. Every call returned `{"result":0}`. So the retry added on
// 2026-08-26 never fired, `onStopFailed` never fired, and the toast never
// appeared — the user simply watched the device keep stroking for ~10-13s
// after pressing pause, with the UI reading "Connected" throughout.
//
// The three things that were actually missing, one describe block each:
//   1. a stop must not queue behind a play
//   2. every call needs a deadline, because a late success is not a success
//   3. the user has to be told while it is happening, not after
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockHandy = {
  connect: vi.fn().mockResolvedValue({ result: 1 }),
  disconnect: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  getClientServerLatency: vi.fn().mockReturnValue({ avgOffset: 0, avgRtd: 0, lastSyncTime: 0 }),
  getState: vi.fn().mockReturnValue({ info: { fwVersion: '3.2.0' }, mode: 1, hssp: { scriptSet: true } }),
  setScript: vi.fn().mockResolvedValue({ result: 1 }),
  hsspPlay: vi.fn().mockResolvedValue({ result: 0 }),
  hsspStop: vi.fn().mockResolvedValue({ result: 0 }),
  setOffset: vi.fn().mockResolvedValue(undefined),
  getOffset: vi.fn().mockResolvedValue({ offset: 0 }),
  setStrokeZone: vi.fn().mockResolvedValue(undefined),
  getStrokeZone: vi.fn().mockResolvedValue({ min: 0, max: 100 }),
  setHsspLoop: vi.fn().mockResolvedValue(undefined),
  setMode: vi.fn().mockResolvedValue(undefined),
  setHampVelocity: vi.fn().mockResolvedValue(undefined),
  hampPlay: vi.fn().mockResolvedValue(undefined),
  hampStop: vi.fn().mockResolvedValue(undefined),
  hdsp: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  API: { get: { connected: vi.fn().mockResolvedValue({ connected: true }) } },
};

const mockUpload = vi.fn().mockResolvedValue('https://scripts01.handyfeeling.com/abc123');

vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: vi.fn().mockReturnValue(mockHandy),
  getEstimatedServerTime: vi.fn().mockReturnValue(0),
  uploadDataToServer: mockUpload,
}));

vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';

/** A promise that only settles when the test says so. Stands in for a cloud
 *  call that has left for the device and is simply not answering. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function makeManager() {
  const manager = new HandyManager();
  await manager.init();
  manager._connected = true;
  manager._connectionKey = 'testkey';
  manager._mode = 1;
  return manager;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHandy.hsspPlay.mockResolvedValue({ result: 0 });
  mockHandy.hsspStop.mockResolvedValue({ result: 0 });
  mockHandy.setScript.mockResolvedValue({ result: 1 });
  mockHandy.getState.mockReturnValue({ info: { fwVersion: '3.2.0' }, mode: 1, hssp: { scriptSet: true } });
  mockUpload.mockResolvedValue('https://scripts01.handyfeeling.com/abc123');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a stop must not wait behind an in-flight play', () => {
  it('sends the stop to the device while the play is still unanswered', async () => {
    const manager = await makeManager();
    const hangingPlay = deferred();
    mockHandy.hsspPlay.mockReturnValueOnce(hangingPlay.promise);

    const playPromise = manager.hsspPlay(5425);
    await tick();
    expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(1);

    // The user presses pause. This is the exact moment that mattered: in the
    // log the stop was not sent for another 20.59s.
    const stopPromise = manager.hsspStop();
    await tick();
    expect(mockHandy.hsspStop).toHaveBeenCalledTimes(1);
    await expect(stopPromise).resolves.toBe(true);

    // ...and only now does the play come back, exactly as it did at 15:26:23.
    hangingPlay.resolve({ result: 0 });
    await playPromise;
  });

  it('goes ahead of a running setup too (Dave 2026-11-20: "stop it at once"); a setup that lands is not set again', async () => {
    // Until 2026-11-20 a running setup was not pre-empted (2026-08-21,
    // "stopped following the video"), and a pause during a slow setScript
    // left the Handy stroking for the whole setup (device session step 43).
    const manager = await makeManager();
    const hangingSetup = deferred();
    mockHandy.setScript.mockReturnValueOnce(hangingSetup.promise);

    const setupPromise = manager.setupScript('https://example/script.csv');
    await tick();
    expect(mockHandy.setScript).toHaveBeenCalledTimes(1);

    const stopPromise = manager.hsspStop();
    await tick();
    expect(mockHandy.hsspStop, 'the stop left while the setup was still running').toHaveBeenCalledTimes(1);
    await expect(stopPromise).resolves.toBe(true);

    hangingSetup.resolve({ result: 1 });
    await expect(setupPromise).resolves.toBe(true);
    expect(mockHandy.setScript, 'a setup that landed is not set again').toHaveBeenCalledTimes(1);
    expect(mockHandy.hsspPlay, 'nothing plays after it').not.toHaveBeenCalled();
  });

  it('a setup that FAILS with a stop sent during it answers false to its caller and is not set again here; nothing plays', async () => {
    // Only the caller knows whether that script is still wanted: on a video
    // change the stop interrupts the OLD script's setup (the Audience
    // bridge sets the new one; the main script's next play self-heals from
    // `_lastCloudUrl`, recorded before its setup).
    const manager = await makeManager();
    const hangingSetup = deferred();
    mockHandy.setScript.mockReturnValueOnce(hangingSetup.promise);

    const setupPromise = manager.setupScript('https://example/script.csv');
    await tick();
    const stopPromise = manager.hsspStop();
    await tick();
    expect(mockHandy.hsspStop).toHaveBeenCalledTimes(1);

    hangingSetup.reject(new Error('Device timeout'));
    await expect(setupPromise).resolves.toBe(false);
    await stopPromise;
    expect(mockHandy.setScript).toHaveBeenCalledTimes(1);
    expect(mockHandy.hsspPlay, 'a pause never ends in a play').not.toHaveBeenCalled();
  });

  it('a play queued behind the running setup when the stop goes out is dropped (it never starts the device under or after the setup)', async () => {
    const manager = await makeManager();
    const hangingSetup = deferred();
    mockHandy.setScript.mockReturnValueOnce(hangingSetup.promise);
    const setupPromise = manager.setupScript('https://example/script.csv');
    await tick();
    const playPromise = manager.hsspPlay(1000);
    const stopPromise = manager.hsspStop();
    await tick();
    expect(mockHandy.hsspStop).toHaveBeenCalledTimes(1);
    hangingSetup.resolve({ result: 1 });
    await setupPromise;
    await stopPromise;
    await expect(playPromise).resolves.toBe(false);
    expect(mockHandy.hsspPlay).not.toHaveBeenCalled();
  });

  it('keeps later calls behind the pre-empting stop, not racing it', async () => {
    const manager = await makeManager();
    const hangingPlay = deferred();
    mockHandy.hsspPlay.mockReturnValueOnce(hangingPlay.promise);
    const slowStop = deferred();
    mockHandy.hsspStop.mockReturnValueOnce(slowStop.promise);

    const playPromise = manager.hsspPlay(1000);
    await tick();
    const stopPromise = manager.hsspStop();
    await tick();

    // A resume arriving after the pause must not overtake the stop and
    // restart the device.
    const laterPlay = manager.hsspPlay(2000);
    await tick();
    expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(1);

    hangingPlay.resolve({ result: 0 });
    slowStop.resolve({ result: 0 });
    await Promise.all([playPromise, stopPromise, laterPlay]);
    expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(2);
    expect(mockHandy.hsspPlay).toHaveBeenLastCalledWith(2000, expect.anything());
  });

  it('an in-flight play does not restart a device the user has stopped', async () => {
    // The self-heal path re-sets the script and replays. If the user paused
    // while the original play was travelling, that retry would resurrect a
    // device they just stopped — the same bug, self-inflicted.
    const manager = await makeManager();
    manager._lastCloudUrl = 'https://example/cached.csv';
    const hangingPlay = deferred();
    mockHandy.hsspPlay.mockReturnValueOnce(hangingPlay.promise);

    const playPromise = manager.hsspPlay(5425);
    await tick();
    await manager.hsspStop();

    hangingPlay.reject(new Error('Script set is required'));
    await expect(playPromise).resolves.toBe(false);
    expect(mockHandy.setScript).not.toHaveBeenCalled();
    expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(1);
  });

  it('a stop that arrives DURING the self-heal setScript keeps the device stopped (FT-110)', async () => {
    // The play finds the HSSP setup gone (an HDSP excursion cleared it), so
    // it re-sets the cached script and would play again. setScript is a 2-8 s
    // handshake and the user pauses during it. The stop was checked only
    // BEFORE the setScript, so the retry play restarted the Handy the user
    // had just stopped (new since v0.9.2).
    const manager = await makeManager();
    manager._lastCloudUrl = 'https://example/cached.csv';
    mockHandy.hsspPlay.mockRejectedValueOnce(new Error('Script set is required'));
    const slowSetup = deferred();
    mockHandy.setScript.mockReturnValueOnce(slowSetup.promise);

    const playPromise = manager.hsspPlay(5425);
    await tick();
    expect(mockHandy.setScript).toHaveBeenCalledTimes(1);   // the self-heal is under way

    const stopPromise = manager.hsspStop();
    await tick();
    expect(mockHandy.hsspStop).toHaveBeenCalledTimes(1);    // the pause's stop went at once

    slowSetup.resolve({ result: 1 });
    await expect(playPromise).resolves.toBe(false);
    await stopPromise;
    expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(1);    // no retry play after the stop
    expect(manager.hsspMayBeRunning).toBe(false);
  });

  it('control: with no stop the self-heal still re-sets the script and plays (FT-110 keeps the recovery)', async () => {
    const manager = await makeManager();
    manager._lastCloudUrl = 'https://example/cached.csv';
    mockHandy.hsspPlay.mockRejectedValueOnce(new Error('Script set is required'));

    await expect(manager.hsspPlay(5425)).resolves.toBe(true);
    expect(mockHandy.setScript).toHaveBeenCalledWith('https://example/cached.csv');
    expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(2);
  });
});

describe('a late success is not a success — every HSSP call has a deadline', () => {
  it('gives up on a play that never answers, instead of holding the chain', async () => {
    const manager = await makeManager();
    manager._hsspTimeoutMs = 20;
    const neverAnswers = deferred();
    mockHandy.hsspPlay.mockReturnValueOnce(neverAnswers.promise);

    await expect(manager.hsspPlay(1000)).resolves.toBe(false);
    // Chain released: the next call runs rather than queueing behind a
    // promise that is still, technically, pending.
    await expect(manager.hsspPlay(2000)).resolves.toBe(true);
    neverAnswers.resolve({ result: 0 });
  });

  it('re-sends a stop the device has not acknowledged in time', async () => {
    // 15:26:34 in the log: one stop, 17.08 seconds, then success. No error to
    // catch, so the existing retry could never fire. The deadline is what
    // turns that into a second stop.
    const manager = await makeManager();
    manager._hsspTimeoutMs = 20;
    const neverAnswers = deferred();
    mockHandy.hsspStop.mockReturnValueOnce(neverAnswers.promise);

    await expect(manager.hsspStop()).resolves.toBe(true);
    expect(mockHandy.hsspStop).toHaveBeenCalledTimes(2);
    neverAnswers.resolve({ result: 0 });
  });

  it('reports a stop as failed when BOTH attempts time out', async () => {
    const manager = await makeManager();
    manager._hsspTimeoutMs = 20;
    const onError = vi.fn();
    manager.onError = onError;
    mockHandy.hsspStop.mockReturnValue(deferred().promise);

    // false is the contract for "hardware may still be moving" — SyncEngine
    // turns it into the toast.
    await expect(manager.hsspStop()).resolves.toBe(false);
    expect(mockHandy.hsspStop).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalled();
    expect(manager.responsive).toBe(false);
  });

  it('tells the user the device is not answering, not the internal message', async () => {
    // "hsspPlay timed out after 5000ms" is a diagnostic for the log file.
    // What reaches the UI has to be something the user can act on.
    const manager = await makeManager();
    manager._hsspTimeoutMs = 20;
    const onError = vi.fn();
    manager.onError = onError;
    mockHandy.hsspPlay.mockReturnValueOnce(deferred().promise);

    await manager.hsspPlay(1000);
    expect(onError).toHaveBeenCalledWith('error.handyNotAnswering');
  });

  it('still passes a REAL SDK error through with its detail', async () => {
    const manager = await makeManager();
    const onError = vi.fn();
    manager.onError = onError;
    mockHandy.hsspPlay.mockRejectedValueOnce(new Error('Device timeout'));

    await manager.hsspPlay(1000);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Device timeout'));
  });

  it('leaves a normal-speed call completely alone', async () => {
    const manager = await makeManager();
    await expect(manager.hsspPlay(1000)).resolves.toBe(true);
    await expect(manager.hsspStop()).resolves.toBe(true);
    expect(mockHandy.hsspPlay).toHaveBeenCalledTimes(1);
    expect(mockHandy.hsspStop).toHaveBeenCalledTimes(1);
  });
});

describe('the user is told while it is happening', () => {
  it('announces slowness once a command passes the threshold', async () => {
    const manager = await makeManager();
    manager._slowCommandMs = 10;
    manager._hsspTimeoutMs = 5000;
    const onSlownessChange = vi.fn();
    manager.onSlownessChange = onSlownessChange;

    const hanging = deferred();
    mockHandy.hsspPlay.mockReturnValueOnce(hanging.promise);
    const playPromise = manager.hsspPlay(1000);

    await new Promise((r) => setTimeout(r, 40));
    expect(onSlownessChange).toHaveBeenCalledWith(true);
    expect(manager.slow).toBe(true);

    hanging.resolve({ result: 0 });
    await playPromise;
    expect(onSlownessChange).toHaveBeenLastCalledWith(false);
    expect(manager.slow).toBe(false);
  });

  it('says nothing at all when commands answer promptly', async () => {
    const manager = await makeManager();
    manager._slowCommandMs = 200;
    const onSlownessChange = vi.fn();
    manager.onSlownessChange = onSlownessChange;

    await manager.hsspPlay(1000);
    await manager.hsspStop();
    expect(onSlownessChange).not.toHaveBeenCalled();
    expect(manager.slow).toBe(false);
  });

  it('a play that lands clears a previous "not responding"', async () => {
    // Only the stop path reported success, so a device that recovered could
    // stay marked unresponsive until the next pause.
    const manager = await makeManager();
    manager._noteCommandResult(false);
    expect(manager.responsive).toBe(false);

    const onResponsivenessChange = vi.fn();
    manager.onResponsivenessChange = onResponsivenessChange;
    await manager.hsspPlay(1000);

    expect(manager.responsive).toBe(true);
    expect(onResponsivenessChange).toHaveBeenCalledWith(true);
  });
});

describe('an unchanged script is not re-uploaded', () => {
  const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });

  it('skips upload AND setScript when the device already holds this script', async () => {
    // Welliambrisk's log: three `Sync engine started — HSSP active` in 90s,
    // each preceded by a fresh upload + setScript of the SAME cloud hash.
    // setScript measured 2.4s and 8.1s, and every second of it went into the
    // same serial chain as his pause's stop.
    const manager = await makeManager();
    await expect(manager.uploadAndSetScript(SCRIPT)).resolves.toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockHandy.setScript).toHaveBeenCalledTimes(1);

    await expect(manager.uploadAndSetScript(SCRIPT)).resolves.toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockHandy.setScript).toHaveBeenCalledTimes(1);
  });

  it('re-sets the cached URL without re-uploading when the device lost HSSP setup', async () => {
    const manager = await makeManager();
    await manager.uploadAndSetScript(SCRIPT);
    expect(mockUpload).toHaveBeenCalledTimes(1);

    // An HDSP excursion (Orgasm Switch, scrub preview) clears scriptSet.
    manager._mode = null;
    mockHandy.getState.mockReturnValue({ mode: 2, hssp: { scriptSet: false } });

    await expect(manager.uploadAndSetScript(SCRIPT)).resolves.toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(1);              // no second upload
    expect(mockHandy.setScript).toHaveBeenCalledTimes(2);     // but it IS re-set
    expect(mockHandy.setScript).toHaveBeenLastCalledWith('https://scripts01.handyfeeling.com/abc123');
  });

  it('DOES upload when the script actually changed', async () => {
    const manager = await makeManager();
    await manager.uploadAndSetScript(SCRIPT);
    await manager.uploadAndSetScript(JSON.stringify({ actions: [{ at: 0, pos: 50 }] }));
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockHandy.setScript).toHaveBeenCalledTimes(2);
  });

  it('forgets the cached script when the device goes away', async () => {
    // "The device holds this script" cannot survive the device leaving, or
    // the next session skips an upload it never made.
    const manager = await makeManager();
    await manager.uploadAndSetScript(SCRIPT);
    manager._handleDeviceLost();
    manager._connected = true;
    manager._mode = 1;

    await manager.uploadAndSetScript(SCRIPT);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('does not claim the main script is loaded while a DIFFERENT one is set', async () => {
    // The Orgasm Switch finisher goes on via setupScript with its own URL.
    // If the skip still believed the main script was resident, the restore
    // afterwards would be skipped and the finisher would stay loaded.
    const manager = await makeManager();
    await manager.uploadAndSetScript(SCRIPT);
    expect(mockUpload).toHaveBeenCalledTimes(1);

    await manager.setupScript('https://scripts01.handyfeeling.com/finisher');
    await manager.uploadAndSetScript(SCRIPT);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });
});
