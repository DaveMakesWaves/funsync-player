/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel builds the Devices tab strip,
 * and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// FT-019 (2026-11-05; new since v0.9.2): the Handy tab's LED for a device in
// trouble. `unresponsive` and `slow` are Handy-only statuses, and
// `_setTabLedState` used to list neither, so the tab LED went BLANK for both:
// the strip said nothing at all about a struggling device. Verifier 2 checked
// it in the app (orange pulsing for slow, red plus Reconnect for not
// responding); this pins the same through the REAL panel. Asserted on the LED
// class the CSS colours, the tab's accessible name and the Reconnect button.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
});

const settingsFake = () => {
  const map = new Map();
  return {
    get: (k) => map.get(k), set: (k, v) => map.set(k, v),
    getPlaylists: () => [], getPlaylist: () => null,
    getCategories: () => [], getCategory: () => null, getVideosByCategory: () => [],
  };
};

function build() {
  const panel = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings: settingsFake() });
  const led = panel._panel.querySelector('[data-tab-led="handy"]');
  const tab = panel._panel.querySelector('#connection-panel__tab-btn-handy');
  const reconnect = panel._panel.querySelector('#btn-reconnect');
  return { panel, led, tab, reconnect };
}

const ledState = (led) => [...led.classList].filter((c) => c.startsWith('connection-panel__tab-led--'));

describe('FT-019: the Handy tab LED says when the device is struggling', () => {
  it('slow: the amber "connecting" LED and "Handy: Connected, responding slowly", no Reconnect', () => {
    const { panel, led, tab, reconnect } = build();
    panel._updateStatus('slow');
    expect(ledState(led)).toEqual(['connection-panel__tab-led--connecting']);
    expect(tab.getAttribute('aria-label')).toBe(`Handy: ${EN.connection.status.respondingSlowly}`);
    expect(reconnect.hidden).toBe(true);
  });

  it('unresponsive: the red "error" LED, "Handy: Connected, not responding", and Reconnect offered', () => {
    const { panel, led, tab, reconnect } = build();
    panel._updateStatus('unresponsive');
    expect(ledState(led)).toEqual(['connection-panel__tab-led--error']);
    expect(tab.getAttribute('aria-label')).toBe(`Handy: ${EN.connection.status.notResponding}`);
    expect(reconnect.hidden).toBe(false);
  });

  it('back to connected, then disconnected: green, then no state at all', () => {
    const { panel, led, tab } = build();
    panel._updateStatus('unresponsive');
    panel._updateStatus('connected');
    expect(ledState(led)).toEqual(['connection-panel__tab-led--connected']);
    panel._updateStatus('disconnected');
    expect(ledState(led)).toEqual([]);
    expect(tab.getAttribute('aria-label')).toBe(`Handy: ${EN.connection.status.notConnected}`);
  });

  it('the accessible name is in the active language', () => {
    _setBundlesForTests('de', DE, EN);
    const { panel, tab } = build();
    panel._updateStatus('slow');
    expect(tab.getAttribute('aria-label')).toBe(`Handy: ${DE.connection.status.respondingSlowly}`);
  });
});
