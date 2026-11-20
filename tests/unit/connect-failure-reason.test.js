/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Devices panel renders its T-Code and Autoblow
 * tabs into a document and its toast goes into #toast-container; i18n.js
 * branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// FT-060 (also in v0.9.2): a failed T-Code or Autoblow connect never said
// why. Both managers report a failure only through `onError`, and the Devices
// panel wired onError for the Handy and Buttplug only, so the tab went back
// to "Not connected" and the reason ("Opening COM3: File not found", "Device
// not connected — check power and WiFi") stayed in the log.
//
// The managers here are the REAL TCodeManager and AutoblowManager over a
// fake `window.funsync` that answers the connect IPC the way main does on a
// failure ({ success: false, error }). Nothing leaves the test.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { connectFailureReason, describeConnectFailure } from '../../renderer/js/connect-failure-reason.js';

const EN_FILE = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
// The keys the panel words a failure with. The English below is what the
// code was written against; en.json's own text wins wherever it has the key
// (the guard test at the bottom fails while en.json lacks one).
const FAILURE_KEYS = {
  tcodePortNotFound: 'Port not found. Check the cable, then pick the port again.',
  tcodePortBusy: 'The port is busy or access was denied. Close any other program using it, then try again.',
  tcodeWsRefused: "Couldn't reach that WebSocket address. Check it, and that the device or program is running.",
  autoblowOffline: 'Device not connected. Check its power and WiFi.',
  autoblowRateLimited: 'Too many requests. Wait a moment, then try again.',
  generic: 'Connection failed: {detail}',
  withDetail: '{reason} ({detail})',
};
const EN = {
  ...EN_FILE,
  connection: { ...EN_FILE.connection, failure: { ...FAILURE_KEYS, ...(EN_FILE.connection.failure || {}) } },
};
const TOKEN = 'TESTKEY01-not-a-real-token';
const flush = () => new Promise((r) => setTimeout(r, 0));

let tcodeAnswer;
let autoblowAnswer;
function panelWithRealManagers() {
  window.funsync = {
    setSetting: () => {},
    tcodeListPorts: async () => [{ path: 'COM3' }],
    tcodeConnect: vi.fn(async () => tcodeAnswer),
    onTcodeDisconnected: () => () => {},
    autoblowConnect: vi.fn(async () => autoblowAnswer),
    autoblowDisconnect: async () => {},
  };
  const values = new Map([['player.language', 'en']]);
  const settings = { get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) };
  const tcodeManager = new TCodeManager();
  const autoblowManager = new AutoblowManager();
  const panel = new ConnectionPanel({
    handyManager: { connected: false, setOffset: async () => {}, setStrokeZone: async () => {}, on() {}, off() {} },
    buttplugManager: { connected: false, devices: [] },
    tcodeManager, autoblowManager, settings,
  });
  return { panel, tcodeManager, autoblowManager };
}

const text = (sel) => document.querySelector(sel)?.textContent.trim();
const toasts = () => [...document.querySelectorAll('#toast-container .toast')].map((el) => el.textContent);

async function connectTCodeSerial() {
  await vi.waitFor(() => expect(document.querySelector('#tcode-port-select option[value="COM3"]')).not.toBeNull());
  document.querySelector('#tcode-port-select').value = 'COM3';
  document.querySelector('#tcode-connect-btn').click();
  await vi.waitFor(() => expect(window.funsync.tcodeConnect).toHaveBeenCalled());
  await flush();
}
async function connectTCodeWs(url) {
  const select = document.querySelector('#tcode-transport-select');
  select.value = 'websocket';
  select.dispatchEvent(new Event('change'));
  document.querySelector('#tcode-ws-url').value = url;
  document.querySelector('#tcode-connect-btn').click();
  await vi.waitFor(() => expect(window.funsync.tcodeConnect).toHaveBeenCalled());
  await flush();
}
async function connectAutoblow() {
  document.querySelector('#ab-token-input').value = TOKEN;
  document.querySelector('#ab-connect-btn').click();
  await vi.waitFor(() => expect(window.funsync.autoblowConnect).toHaveBeenCalled());
  await flush();
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => _setBundlesForTests('en', EN, EN));

describe('a failed T-Code connect says why (FT-060)', () => {
  it('a serial port that is not there: the reason, with the port, in the tab and a toast', async () => {
    tcodeAnswer = { success: false, error: 'Opening COM3: File not found' };
    panelWithRealManagers();
    await connectTCodeSerial();

    const shown = text('#tcode-status-text');
    expect(shown).not.toBe(EN.connection.status.notConnected);
    expect(shown).toBe(t('connection.failure.withDetail', {
      reason: t('connection.failure.tcodePortNotFound'), detail: 'Opening COM3: File not found',
    }));
    expect(shown).toContain('COM3');
    expect(toasts()).toEqual([shown]);
    expect(document.querySelector('#tcode-led').classList.contains('connection-panel__led--connecting')).toBe(false);
    expect(document.querySelector('[data-tab-led="tcode"]').classList.contains('connection-panel__tab-led--error')).toBe(true);
  });

  it('a port another program holds reads "busy", not "not found"', async () => {
    tcodeAnswer = { success: false, error: 'Opening COM3: Access denied' };
    panelWithRealManagers();
    await connectTCodeSerial();
    expect(text('#tcode-status-text')).toContain(t('connection.failure.tcodePortBusy'));
  });

  it('a WebSocket nobody answers (ws://127.0.0.1:1) reads "could not reach"', async () => {
    tcodeAnswer = { success: false, error: 'closed before open (1006)' };
    panelWithRealManagers();
    await connectTCodeWs('ws://127.0.0.1:1');
    expect(text('#tcode-status-text')).toContain(t('connection.failure.tcodeWsRefused'));
    expect(text('#tcode-status-text')).toContain('1006');
  });

  it('an unknown error still shows what the transport said', async () => {
    tcodeAnswer = { success: false, error: 'Unknown error code 121' };
    panelWithRealManagers();
    await connectTCodeSerial();
    expect(text('#tcode-status-text')).toBe(t('connection.failure.generic', { detail: 'Unknown error code 121' }));
  });

  it('the reason follows a language switch', async () => {
    tcodeAnswer = { success: false, error: 'Opening COM3: File not found' };
    panelWithRealManagers();
    await connectTCodeSerial();
    _setBundlesForTests('de', DE, EN);
    eventBus.emit('language:changed', { locale: 'de' });
    expect(text('#tcode-status-text')).toBe(t('connection.failure.withDetail', {
      reason: t('connection.failure.tcodePortNotFound'), detail: 'Opening COM3: File not found',
    }));
  });

  it('a later successful connect says Connected again', async () => {
    tcodeAnswer = { success: false, error: 'Opening COM3: File not found' };
    panelWithRealManagers();
    await connectTCodeSerial();
    tcodeAnswer = { success: true };
    window.funsync.tcodeConnect.mockClear();
    document.querySelector('#tcode-connect-btn').click();
    await vi.waitFor(() => expect(window.funsync.tcodeConnect).toHaveBeenCalled());
    await flush();
    expect(text('#tcode-status-text')).toBe(EN.connection.status.connected);
  });
});

describe('a failed Autoblow connect says why (FT-060)', () => {
  it('"Device not connected — check power and WiFi": the localised sentence in the tab and a toast', async () => {
    autoblowAnswer = { success: false, error: 'Device not connected — check power and WiFi' };
    panelWithRealManagers();
    await connectAutoblow();

    const shown = text('#ab-status-text');
    expect(shown).not.toBe(EN.connection.status.notConnected);
    expect(shown).toBe(t('connection.failure.autoblowOffline'));
    expect(toasts()).toEqual([shown]);
  });

  it('rate limited', async () => {
    autoblowAnswer = { success: false, error: 'Rate limited' };
    panelWithRealManagers();
    await connectAutoblow();
    expect(text('#ab-status-text')).toBe(t('connection.failure.autoblowRateLimited'));
  });

  it('the token never reaches the text, even inside an error message', async () => {
    autoblowAnswer = { success: false, error: `HTTP 401: bad token ${TOKEN}` };
    panelWithRealManagers();
    await connectAutoblow();
    expect(text('#ab-status-text')).not.toContain(TOKEN);
    expect(text('#ab-status-text')).toContain('HTTP 401');
    expect(toasts().join(' ')).not.toContain(TOKEN);
  });

  it('an upload that fails while connected leaves the tab on Connected', async () => {
    autoblowAnswer = { success: true, deviceType: 'autoblow-ultra', deviceInfo: {} };
    const { autoblowManager } = panelWithRealManagers();
    await connectAutoblow();
    expect(text('#ab-status-text')).toBe(EN.connection.status.connected);
    window.funsync.autoblowUploadScript = async () => ({ success: false, error: 'HTTP 500: Internal' });
    await autoblowManager.uploadScript('{"actions":[]}');
    expect(text('#ab-status-text')).toBe(EN.connection.status.connected);
    expect(toasts()).toEqual([]);
  });
});

describe('connectFailureReason (pure)', () => {
  it('drops TCodeManager\'s prefix and maps each known cause', () => {
    expect(connectFailureReason('tcode', 'Connection failed: Opening COM3: File not found'))
      .toEqual({ key: 'connection.failure.tcodePortNotFound', detail: 'Opening COM3: File not found', showDetail: true });
    expect(connectFailureReason('tcode', 'Connection error: Error: Resource busy, cannot open /dev/ttyUSB0').key)
      .toBe('connection.failure.tcodePortBusy');
    expect(connectFailureReason('tcode', 'Connection failed: connect failed').key).toBe('connection.failure.tcodeWsRefused');
    expect(connectFailureReason('autoblow', 'Device not connected — check power and WiFi'))
      .toEqual({ key: 'connection.failure.autoblowOffline', detail: 'Device not connected — check power and WiFi', showDetail: false });
    expect(connectFailureReason('autoblow', 'fetch failed')).toEqual({ key: null, detail: 'fetch failed', showDetail: true });
  });

  it('with nothing said it falls back to "Connection Failed"', () => {
    _setBundlesForTests('en', EN, EN);
    expect(describeConnectFailure('tcode', '', t)).toBe(EN.connection.status.failed);
  });
});

describe('the failure strings ship', () => {
  it('en.json carries every connection.failure key the panel uses, with the same placeholders', () => {
    const shipped = EN_FILE.connection.failure || {};
    expect(Object.keys(shipped).sort()).toEqual(Object.keys(FAILURE_KEYS).sort());
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(FAILURE_KEYS)) expect(names(shipped[k] || ''), k).toEqual(names(v));
  });
});
