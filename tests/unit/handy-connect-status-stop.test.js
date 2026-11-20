/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Found while FN-01 (by reading, low): the first video opened after a Handy
// connect sent one hsspStop. A new connection starts with
// `hsspMayBeRunning` null (unknown), and FN-01 stops the Handy on every video
// change unless it is false. Mostly needless (one cloud call, and with the
// SDK's mode not known yet a mode switch too, ahead of the new video's
// setScript), but the device MAY still be playing from an earlier session.
//
// Fixed (2026-11-19, bf-handy): after a connect HandyManager reads the
// device's status once (the SDK's own API.get.status) and takes the device's
// word only when it is clear: HSSP not playing, or HAMP stopped, makes it
// false; HSSP PLAYING makes it true; anything else, no answer, or a request
// asked for meanwhile leaves it unknown, and unknown still stops.
//
// What runs is the REAL HandyManager on the fake SDK (helpers/fake-handy-sdk.js
// with its opt-in `status`), and for the video change the REAL app.js load
// path (helpers/handy-load-app.js) with the REAL SyncEngine. No network; the
// key is the fake TESTKEY01.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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
import { makeLoadAppClass, buildLoadApp, fileItem } from './helpers/handy-load-app.js';

const HSSP = 1;
const HAMP = 0;
const HDSP = 2;
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let m;
afterEach(() => { m?._stopHealthCheck(); });

async function connectWith(opts) {
  h.sdk = createFakeHandySdk(opts);
  m = attachFakeCloud(new HandyManager(), h.sdk);
  await m.init();
  expect(await m.connect('TESTKEY01')).toBe(true);
  m._stopHealthCheck();
  return m;
}

describe('the device\'s own status after a connect settles hsspMayBeRunning', () => {
  const cases = [
    [{ mode: HSSP, state: 3 }, false, 'HSSP stopped'],
    [{ mode: HSSP, state: 2 }, false, 'HSSP with no script set up'],
    [{ mode: HSSP, state: 1 }, false, 'HSSP waiting for a sync'],
    [{ mode: HAMP, state: 1 }, false, 'HAMP stopped'],
    [{ mode: HSSP, state: 4 }, true, 'HSSP PLAYING from before'],
    [{ mode: HAMP, state: 2 }, null, 'HAMP moving (if in doubt, stop)'],
    [{ mode: HDSP }, null, 'HDSP (if in doubt, stop)'],
    [{}, null, 'an answer with no mode'],
  ];
  for (const [status, want, what] of cases) {
    it(`${what}: ${want}`, async () => {
      await connectWith({ status });
      await settle();
      expect(h.sdk.sent('API.get.status')).toHaveLength(1);
      expect(m.hsspMayBeRunning).toBe(want);
    });
  }

  it('no status read in the SDK at all: unknown (null), as before', async () => {
    await connectWith({});
    await settle();
    expect(m.hsspMayBeRunning).toBe(null);
  });

  it('a status read that fails: unknown (null)', async () => {
    h.sdk = createFakeHandySdk({ status: { mode: HSSP, state: 3 } });
    h.sdk.answer('API.get.status', new Error('Device timeout'));
    m = attachFakeCloud(new HandyManager(), h.sdk);
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    await settle();
    expect(m.hsspMayBeRunning).toBe(null);
  });

  it('a play asked for while the read was out is newer news: the read changes nothing', async () => {
    h.sdk = createFakeHandySdk({ status: { mode: HSSP, state: 3 } });
    const read = h.sdk.hold('API.get.status');
    m = attachFakeCloud(new HandyManager(), h.sdk);
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    m._hsspSpacingMs = 0;
    expect(await m.setupScript('https://scripts.local/A.csv')).toBe(true);
    await m.hsspPlay(0);
    expect(m.hsspMayBeRunning).toBe(true);
    read.resolve({ mode: HSSP, state: 3 });   // the device had not seen the play yet
    await settle();
    expect(m.hsspMayBeRunning).toBe(true);
  });

  it('a read from an earlier connection is ignored after a reconnect', async () => {
    h.sdk = createFakeHandySdk({ status: { mode: HSSP, state: 3 } });
    const read = h.sdk.hold('API.get.status');
    m = attachFakeCloud(new HandyManager(), h.sdk);
    await m.init();
    expect(await m.connect('TESTKEY01')).toBe(true);
    m._stopHealthCheck();
    await m.disconnect();                       // unknown again
    read.resolve({ mode: HSSP, state: 3 });
    await settle();
    expect(m.hsspMayBeRunning).toBe(null);
  });
});

describe('the first video opened after a connect (REAL app.js load path)', () => {
  let Lifted;
  beforeAll(() => {
    Lifted = makeLoadAppClass({ extra: ['_uploadAndStartSync', '_tryStartAutoblowSync'] });
  });

  async function firstVideoAfterConnect(status) {
    await connectWith(status === undefined ? {} : { status });
    await settle();
    const { app } = buildLoadApp(Lifted, { handyManager: m });
    app.funscriptEngine = { clear() {}, get isLoaded() { return false; }, getRawContent: () => null };
    const engine = new SyncEngine({ videoPlayer: app.videoPlayer, handyManager: m, funscriptEngine: app.funscriptEngine });
    app.syncEngine = engine;
    const mark = h.sdk.calls.length;
    await app._playFromLibrary(fileItem('C:\\Lib\\Bravo.mp4'), null, null, []);
    await settle();
    engine.stop();
    return h.sdk.calls.slice(mark).map(([n]) => n);
  }

  it('the device said it stands still: no stop is sent', async () => {
    const legs = await firstVideoAfterConnect({ mode: HSSP, state: 3 });
    expect(legs).not.toContain('hsspStop');
    expect(legs).not.toContain('setMode');
  });

  it('the device said it is still PLAYING from before: the video change stops it', async () => {
    const legs = await firstVideoAfterConnect({ mode: HSSP, state: 4 });
    expect(legs).toContain('hsspStop');
  });

  it('unknown (no status read): the video change still stops it — if in doubt, stop', async () => {
    const legs = await firstVideoAfterConnect(undefined);
    expect(legs).toContain('hsspStop');
  });
});
