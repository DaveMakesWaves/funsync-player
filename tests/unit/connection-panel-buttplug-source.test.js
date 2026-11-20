/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel builds the Buttplug device rows
 * in the document, and connection-panel.js imports modules that branch on
 * `window` (notes/CLAUDE.md "Test environments").
 */
// E-03 (2026-11-07; low, also in v0.9.2): Devices > Buttplug.io showed the
// Source (axis) dropdown BLANK for every device. After each device-list render
// `_loadButtplugDeviceSettings` synced "the" mode select with
// `row.querySelector('.connection-panel__device-select')`, whose first match
// is the Source select (same class), and set it to the vibe mode ('speed'):
// no such option, so selectedIndex -1. The axis the user chose (for example
// "Suck (A1)") was never shown, and the vibe-mode select was never synced.
//
// The REAL panel's device-list render, a REAL ButtplugSync and saved per-device
// settings; asserted on what each select shows.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));

const device = (index, name, caps) => ({
  index, name, canLinear: false, canVibrate: false, canRotate: false, canScalar: false, canOscillate: false, ...caps,
});

function render(devices, saved, { customRouting = false } = {}) {
  const sync = new ButtplugSync({ buttplugManager: { connected: true, devices }, videoPlayer: {}, funscriptEngine: {} });
  if (customRouting) sync._customRoutingActive = true;
  const root = document.createElement('div');
  root.innerHTML = '<div id="bp-device-list"></div>';
  document.body.appendChild(root);
  const panel = Object.assign(Object.create(ConnectionPanel.prototype), {
    buttplug: { connected: true, devices },
    buttplugSync: sync,
    settings: { get: (k) => (k === 'buttplug.deviceSettings' ? saved : undefined), set() {} },
    _panel: root,
  });
  panel._updateButtplugDeviceList();
  const rows = [...root.querySelectorAll('.connection-panel__device-row')];
  return { panel, sync, rows };
}

/** The visible choice of a row's Source select (what the user reads). */
const sourceShown = (row) => {
  const sel = row.querySelector('.connection-panel__device-axis-row select');
  return sel.selectedIndex < 0 ? '' : sel.options[sel.selectedIndex].textContent;
};
const modeSelects = (row) => [...row.querySelectorAll('select')].filter((s) => s.title && !s.closest('.connection-panel__device-axis-row'));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
});

describe('E-03: Devices > Buttplug.io shows each device\'s own Source and modes', () => {
  it('a vibrator saved on "Suck (A1)" with Position mode: Source reads "Suck (A1)", the mode reads Position', () => {
    const { rows } = render([device(0, 'Suction Toy', { canVibrate: true })], {
      '0:Suction Toy': { axisAssignment: 'A1', vibeMode: 'position' },
    });
    expect(sourceShown(rows[0])).toBe('Suck (A1)');
    const [vibe] = modeSelects(rows[0]);
    expect(vibe.value).toBe('position');
  });

  it('a stroker with nothing saved: Source reads the main stroke, never blank', () => {
    const { rows } = render([device(1, 'Stroker', { canLinear: true })], {});
    expect(sourceShown(rows[0])).toBe(EN.connection.buttplug.axisMainStroke);
  });

  it('two devices: each row shows its own axis and modes', () => {
    const { rows } = render([
      device(0, 'Twister', { canRotate: true }),
      device(1, 'Buzzer', { canVibrate: true }),
    ], {
      '0:Twister': { axisAssignment: 'R0', rotateMode: 'intensity' },
      '1:Buzzer': { axisAssignment: 'V0' },
    });
    expect(sourceShown(rows[0])).toBe('Twist (R0)');
    expect(modeSelects(rows[0])[0].value).toBe('intensity');
    expect(sourceShown(rows[1])).toBe('Vibe (V0)');
    expect(modeSelects(rows[1])[0].value).toBe('speed');
  });

  it('a device a custom route holds reads "Custom routing"', () => {
    const devices = [device(0, 'Routed', { canLinear: true })];
    const { panel, sync, rows } = render(devices, {}, { customRouting: true });
    sync.setAxisAssignment(0, 'CR1');
    panel._loadButtplugDeviceSettings();
    expect(sourceShown(rows[0])).toBe(EN.connection.buttplug.axisCustom);
  });
});
