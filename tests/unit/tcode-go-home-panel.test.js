/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Devices panel renders its T-Code tab into a
 * document; i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// The T-Code tab's Go home button (#384 uhntiss, #389 kissenpirat; Dave
// 2026-11-20): shown only while T-Code is connected, it asks the app to go
// home (app.js _tcodeGoHome: pause, then TCodeSync.goHome) and rests while
// the 2 s move runs. The app side: tcode-go-home.test.js (the frame).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { GO_HOME_MOVE_MS } from '../../renderer/js/tcode-sync.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const flush = () => new Promise((r) => setTimeout(r, 0));

function makePanel({ onTCodeGoHome } = {}) {
  window.funsync = {
    setSetting: () => {},
    tcodeListPorts: async () => [{ path: 'COM3' }],
    tcodeConnect: vi.fn(async () => ({ success: true })),
    onTcodeDisconnected: () => () => {},
    tcodeSend: async () => true,
    tcodeDisconnect: async () => {},
  };
  const values = new Map([['player.language', 'en']]);
  const settings = { get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) };
  const tcodeManager = new TCodeManager();
  const panel = new ConnectionPanel({
    handyManager: { connected: false, setOffset: async () => {}, setStrokeZone: async () => {}, on() {}, off() {} },
    buttplugManager: { connected: false, devices: [] },
    tcodeManager, settings, onTCodeGoHome,
  });
  return { panel, tcodeManager };
}

async function connectSerial() {
  await vi.waitFor(() => expect(document.querySelector('#tcode-port-select option[value="COM3"]')).not.toBeNull());
  document.querySelector('#tcode-port-select').value = 'COM3';
  document.querySelector('#tcode-connect-btn').click();
  await vi.waitFor(() => expect(window.funsync.tcodeConnect).toHaveBeenCalled());
  await flush();
}

const homeBtn = () => document.querySelector('#tcode-home-btn');

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
});
afterEach(() => vi.useRealTimers());

describe('Devices > T-Code > Go home', () => {
  it('is hidden until T-Code is connected, then shows with its label and hint', async () => {
    makePanel({ onTCodeGoHome: vi.fn() });
    expect(homeBtn()).not.toBeNull();
    expect(homeBtn().hidden).toBe(true);
    await connectSerial();
    expect(homeBtn().hidden).toBe(false);
    expect(homeBtn().textContent.trim()).toBe(EN.connection.tcode.goHome);
    expect(homeBtn().title).toBe(EN.connection.tcode.goHomeTitle);
  });

  it('a click asks the app to go home, once; the button rests for the move, then comes back', async () => {
    const onTCodeGoHome = vi.fn(async () => ({ sent: true }));
    makePanel({ onTCodeGoHome });
    await connectSerial();
    vi.useFakeTimers();
    homeBtn().click();
    homeBtn().click();                       // a second click while it moves does nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(onTCodeGoHome).toHaveBeenCalledTimes(1);
    expect(homeBtn().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(GO_HOME_MOVE_MS - 10);
    expect(homeBtn().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(homeBtn().disabled).toBe(false);
  });

  it('hides again on disconnect, and never shows when the app gave no handler', async () => {
    const { tcodeManager } = makePanel({ onTCodeGoHome: vi.fn() });
    await connectSerial();
    expect(homeBtn().hidden).toBe(false);
    tcodeManager.onDisconnect?.();
    expect(homeBtn().hidden).toBe(true);

    document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
    makePanel({});
    await connectSerial();
    expect(homeBtn().hidden, 'no handler: nothing to press').toBe(true);
  });
});
