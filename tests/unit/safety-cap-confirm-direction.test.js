/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Devices panel builds the Safety Cap row and the
 * REAL Modal opens into a document; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// FT-058 (also in v0.9.2): the Safety Cap asked to confirm again when it was
// LOWERED. Its change handler asked whenever the new value was over 90, with
// no look at the old one, so 100 -> 99 with the arrow keys asked "set to
// 99%?", and Cancel then put the cap at 70, a value nobody chose.
//
// Now only raising the cap above 90 % asks, and Cancel keeps the cap it had.
// Driven through the real slider events on the real panel with a real
// ButtplugSync, an oscillate device and the real Modal.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const JORDAN = { index: 0, name: 'Svakom Jordan', canVibrate: true, canOscillate: true };

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];

/** Let the change handler run to its end (it awaits a dynamic import first). */
async function settle() {
  for (let i = 0; i < 20; i++) await flush();
}
async function dialogShown() {
  const until = Date.now() + 3000;
  while (overlays().length === 0 && Date.now() < until) await flush();
  return overlays().length;
}

function devicesPanel() {
  const buttplug = {
    connected: true, devices: [JORDAN],
    sendLinear() {}, sendVibrate() {}, sendRotate() {}, sendScalar() {}, sendOscillate() {},
    stopAll() {}, stopDevice() {},
  };
  const buttplugSync = new ButtplugSync({
    videoPlayer: { video: { addEventListener() {}, removeEventListener() {} }, currentTime: 0, paused: true, duration: 60 },
    buttplugManager: buttplug,
    funscriptEngine: { isLoaded: false, getActions: () => [] },
  });
  const values = new Map([['player.language', 'en']]);
  const settings = { get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) };
  const panel = new ConnectionPanel({
    handyManager: { on() {}, off() {} }, buttplugManager: buttplug, buttplugSync, settings,
  });
  buttplug.onDeviceAdded(JORDAN);
  return { panel, buttplugSync };
}

const slider = (panel) => panel._panel.querySelector('.connection-panel__device-safety-section input[type="range"]');
const shown = (panel) => panel._panel
  .querySelector('.connection-panel__device-safety-section .connection-panel__safety-value').textContent;

/** One step as the arrow keys make it: input, then change. */
function moveTo(panel, v) {
  const s = slider(panel);
  s.value = String(v);
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Put the cap at `v` the way a user does, confirming when asked. */
async function setCapConfirmed(panel, v) {
  moveTo(panel, v);
  if (await dialogShown()) {
    overlays().at(-1).querySelector('.modal-actions .modal-btn--danger').click();
  }
  await settle();
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});
afterEach(async () => {
  while (overlays().length > 0) {
    overlays().at(-1).querySelector('.modal-close-btn').click();
    await flush();
  }
});
afterAll(() => _setBundlesForTests('en', EN, EN));

describe('Safety Cap: only raising it above 90 % asks (FT-058)', () => {
  it('100 -> 99 (ArrowLeft) sets 99 without a dialog', async () => {
    const { panel, buttplugSync } = devicesPanel();
    await setCapConfirmed(panel, 100);
    expect(buttplugSync.getMaxIntensity(0)).toBe(100);

    moveTo(panel, 99);
    await settle();

    expect(overlays()).toHaveLength(0);
    expect(buttplugSync.getMaxIntensity(0)).toBe(99);
    expect(slider(panel).value).toBe('99');
    expect(shown(panel)).toBe('99%');
  });

  it('every step down from 100 to 91 goes through without asking', async () => {
    const { panel, buttplugSync } = devicesPanel();
    await setCapConfirmed(panel, 100);
    for (let v = 99; v >= 91; v--) {
      moveTo(panel, v);
      await settle();
      expect(overlays()).toHaveLength(0);
      expect(buttplugSync.getMaxIntensity(0)).toBe(v);
    }
  });

  it('90 -> 95 still asks, and Cancel keeps 90 (not 70)', async () => {
    const { panel, buttplugSync } = devicesPanel();
    moveTo(panel, 90);
    await settle();
    expect(overlays()).toHaveLength(0);           // 90 is not above 90
    expect(buttplugSync.getMaxIntensity(0)).toBe(90);

    moveTo(panel, 95);
    expect(await dialogShown()).toBe(1);
    overlays().at(-1).querySelector('.modal-actions .modal-btn--secondary').click();
    await settle();

    expect(buttplugSync.getMaxIntensity(0)).toBe(90);
    expect(slider(panel).value).toBe('90');
    expect(shown(panel)).toBe('90%');
  });

  it('95 -> 98 asks again (still a raise), and Cancel keeps 95', async () => {
    const { panel, buttplugSync } = devicesPanel();
    await setCapConfirmed(panel, 95);
    expect(buttplugSync.getMaxIntensity(0)).toBe(95);

    moveTo(panel, 98);
    expect(await dialogShown()).toBe(1);
    overlays().at(-1).querySelector('.modal-actions .modal-btn--secondary').click();
    await settle();

    expect(buttplugSync.getMaxIntensity(0)).toBe(95);
    expect(slider(panel).value).toBe('95');
  });
});
