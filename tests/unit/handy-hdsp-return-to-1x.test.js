/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-118 (new since v0.9.2): the Handy pauses about 1 s when the rate goes
// back to 1x. At a non-1x rate HDSP drives the device; the SDK's setMode
// clears its own scriptSet flag, so the first HSSP play back at 1x throws
// "Script set is required" locally and the self-heal re-sets the cached
// script: one setScript round trip (~1 s) before the device moves.
//
// Whether firmware 4 keeps its HSSP setup through an HDSP excursion is not
// known, and only the device can say. So the try is built and left OFF
// (`_reuseHsspSetupAfterHdsp`): with it on, the manager asks the device to
// play on the setup it may still hold, and falls back to the self-heal on
// any other answer. Dave's Handy decides whether it goes on (the device step
// in notes/fix-test-list-2026-11-05.md).
//
// Also FT-110 on the same path: a stop that arrives during the self-heal's
// setScript must keep the device stopped.
//
// The REAL HandyManager on a fake SDK that keeps the real SDK's rules
// (helpers/fake-handy-sdk.js). No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, n: 0 }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async () => `https://scripts.local/${++h.n}.csv`,
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';

const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 600, pos: 90 }] });
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let manager;
let mark;   // index into the SDK's legs where "back at 1x" begins

/** Playing at 1x, then 1.5x drove the device through HDSP. */
beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  // Seconds pass between the upload and a rate change on a device; the
  // setScript spacing (FT-116) is not what these tests are about, nor the
  // same spacing for hsspPlay / hsspStop (block F review): seconds pass
  // between the 1x play below and the play back at 1x.
  manager._setScriptSpacingMs = 0;
  manager._hsspSpacingMs = 0;
  // Nor the wait for the HDSP mode switch's SDK window (fix-up after
  // verify-1; handy-hdsp-no-stray-move.test.js): the HDSP drive below and
  // the play back at 1x are seconds apart on a device.
  manager._hdspSpacingMs = 0;
  expect(await manager.uploadAndSetScript(SCRIPT)).toBe(true);
  expect(await manager.hsspPlay(0)).toBe(true);
  await manager.hdspMove(50, 100);   // what the HDSP engine sends at 1.5x
  expect(h.sdk.getState().hssp.scriptSet).toBe(false);   // the SDK's setMode cleared it
  mark = h.sdk.calls.length;
});

afterEach(() => {
  manager._stopHealthCheck();
});

const legsSince = () => h.sdk.calls.slice(mark).map(([n]) => n);

describe('back at 1x after HDSP (FT-118)', () => {
  it('OFF (the default until measured): the cached script is set again, then the device plays', async () => {
    await expect(manager.hsspPlay(1000)).resolves.toBe(true);
    expect(legsSince()).toEqual(['setMode', 'setScript', 'hsspPlay']);
  });

  it('ON, the device kept its setup: it plays with no setScript, and the 2.5 s correction plays too', async () => {
    manager._reuseHsspSetupAfterHdsp = true;
    await expect(manager.hsspPlay(1000)).resolves.toBe(true);
    expect(legsSince()).toEqual(['setMode', 'hsspPlay']);
    await expect(manager.hsspPlay(3500)).resolves.toBe(true);
    await settle();
    expect(legsSince()).toEqual(['setMode', 'hsspPlay', 'hsspPlay']);
  });

  it('ON, the device lost its setup: falls back to setting the script again, and plays', async () => {
    manager._reuseHsspSetupAfterHdsp = true;
    h.sdk.answer('hsspPlay', new Error('Illegal state. Mode specific setup required first.'));
    await expect(manager.hsspPlay(1000)).resolves.toBe(true);
    expect(legsSince()).toEqual(['setMode', 'hsspPlay', 'setScript', 'hsspPlay']);
  });

  it('ON, but the device\'s last script is not the cached one (a staged invert): straight to setScript', async () => {
    manager._reuseHsspSetupAfterHdsp = true;
    await manager.stageScript(SCRIPT.replace('10', '11'));
    await expect(manager.hsspPlay(1000)).resolves.toBe(true);
    expect(legsSince()).toEqual(['setMode', 'setScript', 'hsspPlay']);
    expect(h.sdk.sent('setScript').at(-1)[1]).toBe(manager._lastCloudUrl);
  });
});

describe('a stop during the self-heal setScript keeps the device stopped (FT-110)', () => {
  it('no retry play after the stop', async () => {
    const heldSetup = h.sdk.hold('setScript');
    const play = manager.hsspPlay(1000);
    await settle();
    expect(legsSince()).toEqual(['setMode', 'setScript']);

    const stop = manager.hsspStop();   // the user pauses during the handshake
    await settle();
    heldSetup.resolve({ result: 1 });
    await expect(play).resolves.toBe(false);
    await stop;
    await settle();
    expect(legsSince()).toEqual(['setMode', 'setScript', 'hsspStop']);
    expect(legsSince()).not.toContain('hsspPlay');
  });
});
