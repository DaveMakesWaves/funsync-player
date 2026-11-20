/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-117: the Handy's firmware read 'unknown' after a manual reconnect.
//
// The connect log line read `handyManager.fwVersion || _fwVersion`, neither
// of which exists, and onConnect ran inside the SDK's connect, before
// HandyManager.connect() reached its one read of the device info: so the
// line always said "firmware unknown", and an SDK-initiated reconnect never
// read the info at all. A connect that came back with no firmware got no
// second read, and hdspMove sends nothing on unknown firmware (0-100 on FW4
// drives the slider into its end stop), so the Test pulse and every non-1x
// rate stood still.
//
// The REAL HandyManager on a fake SDK that keeps the real SDK's rules
// (helpers/fake-handy-sdk.js: connect stores the info, then emits 'connect';
// API.get.info stores its answer; every command checks the firmware first).
// No network; the key is the fake TESTKEY01.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFakeHandySdk, FW4_INFO, FAKE_ONLY, realHandyMethodNames, sdkMethodsHandyManagerCalls, attachFakeCloud,
} from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async () => 'https://scripts.local/x.csv',
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const NO_FW = Object.freeze({ model: 'H01', fwStatus: 0 });

let manager;

async function makeManager(sdkOpts) {
  h.sdk = createFakeHandySdk(sdkOpts);
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  manager._deviceInfoRetryMs = 5;   // the re-read spacing, short for a unit test
  await manager.init();
  return manager;
}

afterEach(() => {
  manager?._stopHealthCheck();
});

describe('the fake SDK is the real one\'s shape', () => {
  it('has no method the real Handy class lacks', async () => {
    const real = realHandyMethodNames();
    const fake = Object.keys(createFakeHandySdk()).filter((k) => !FAKE_ONLY.has(k) && typeof createFakeHandySdk()[k] === 'function');
    for (const m of fake) expect(real.has(m), `fake-only method ${m}`).toBe(true);
  });

  // The other direction (bf-review BF-R3, 2026-11-19): the fake had no
  // getConfig() unless a test opted in, so HandyManager's direct stop
  // (FT-124), the path every stop in HSSP mode takes in production, never
  // ran in 11 of the 12 test files built on it.
  it('has every real Handy method HandyManager calls, by default', () => {
    const used = sdkMethodsHandyManagerCalls();
    expect(used).toEqual(expect.arrayContaining(['getConfig', 'getState', 'hsspPlay', 'hsspStop', 'setScript']));
    const fake = createFakeHandySdk();
    expect(used.filter((m) => typeof fake[m] !== 'function'), 'real methods HandyManager calls that the fake lacks').toEqual([]);
  });

  it('by default a stop in HSSP mode takes the direct path, as in production', async () => {
    await makeManager();
    expect(await manager.connect('TESTKEY01')).toBe(true);
    manager._stopHealthCheck();
    expect(await manager.setupScript('https://scripts.local/x.csv')).toBe(true);
    const mark = h.sdk.calls.length;
    await expect(manager.hsspStop()).resolves.toBe(true);
    expect(h.sdk.calls.slice(mark)).toEqual([['hsspStop', 'direct']]);
  });
});

describe('the firmware is known when it is first needed (FT-117)', () => {
  it('onConnect already sees it (the connect log line and the panel read it there)', async () => {
    await makeManager();
    let seen = 'not called';
    manager.onConnect = () => { seen = manager.deviceInfo?.fwVersion ?? null; };
    expect(await manager.connect('TESTKEY01')).toBe(true);
    expect(seen).toBe(FW4_INFO.fwVersion);
  });

  it('a connect with no firmware reads it again: onDeviceInfo fires with it and a Test pulse moves', async () => {
    await makeManager({ info: NO_FW, infoLater: FW4_INFO });
    const announced = [];
    manager.onDeviceInfo = (info) => announced.push(info.fwVersion ?? null);
    expect(await manager.connect('TESTKEY01')).toBe(true);
    expect(manager.deviceInfo?.fwVersion).toBeUndefined();

    await vi.waitFor(() => expect(manager.deviceInfo?.fwVersion).toBe(FW4_INFO.fwVersion));
    expect(h.sdk.sent('API.get.info')).toHaveLength(1);
    expect(announced.at(-1)).toBe(FW4_INFO.fwVersion);

    // The Devices tab's Test pulse: hdspMove(70, 500) on firmware 4 is xpt 0.7.
    await manager.hdspMove(70, 500);
    const sentPos = h.sdk.sent('hdsp').map(([, pos]) => pos);
    expect(sentPos).toHaveLength(1);
    expect(sentPos[0]).toBeCloseTo(0.7, 6);
  });

  it('a manual reconnect announces the firmware once per connection, not twice', async () => {
    await makeManager();
    const announced = [];
    manager.onDeviceInfo = (info) => announced.push(info.fwVersion);
    await manager.connect('TESTKEY01');
    await manager.disconnect();
    await manager.connect('TESTKEY01');
    expect(announced).toEqual([FW4_INFO.fwVersion, FW4_INFO.fwVersion]);
  });

  it('stops re-reading once disconnected', async () => {
    await makeManager({ info: NO_FW, infoLater: FW4_INFO });
    await manager.connect('TESTKEY01');
    await manager.disconnect();
    await settle(40);
    expect(h.sdk.sent('API.get.info')).toHaveLength(0);
    expect(manager.deviceInfo).toBeNull();
  });

  it('gives up after its re-reads, with HDSP still off (never a guessed scale)', async () => {
    await makeManager({ info: NO_FW, infoLater: NO_FW });
    await manager.connect('TESTKEY01');
    await vi.waitFor(() => expect(h.sdk.sent('API.get.info')).toHaveLength(3));
    await settle(20);
    expect(h.sdk.sent('API.get.info')).toHaveLength(3);
    await manager.hdspMove(70, 500);
    expect(h.sdk.sent('hdsp')).toHaveLength(0);
  });
});

describe('the panel\'s firmware line (FT-117)', () => {
  function panelWith(info) {
    const fields = { '#device-firmware': { textContent: '4.2.1+old' }, '#device-model': { textContent: 'H01' }, '#firmware-warning': { hidden: true } };
    return {
      handy: { deviceInfo: info },
      _panel: { querySelector: (sel) => fields[sel] },
      fields,
    };
  }

  it('shows no firmware rather than the previous connection\'s while none is known', () => {
    const p = panelWith(null);
    ConnectionPanel.prototype._updateDeviceInfo.call(p);
    expect(p.fields['#device-firmware'].textContent).toBe('—');
  });

  // Block F review (2026-11-16, nit): the model cell, and a firmware
  // warning, were the previous connection's too.
  it('clears the model and hides a previous connection\'s firmware warning while none is known', () => {
    const p = panelWith(null);
    p.fields['#firmware-warning'].hidden = false;
    ConnectionPanel.prototype._updateDeviceInfo.call(p);
    expect(p.fields['#device-model'].textContent).toBe('—');
    expect(p.fields['#firmware-warning'].hidden).toBe(true);
  });

  it('shows the firmware once it is known', () => {
    const p = panelWith(FW4_INFO);
    ConnectionPanel.prototype._updateDeviceInfo.call(p);
    expect(p.fields['#device-firmware'].textContent).toBe(FW4_INFO.fwVersion);
  });
});
