/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel builds its DOM and listens on the
 * shared eventBus; i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// Block C fix-up (2026-11-06, real-app verifier 2; also in v0.9.2): the
// Devices > Autoblow offset slider did not follow a change made on the phone.
// Since FT-052 the phone's Autoblow slider reaches the device and saves
// `autoblow.offset`, but the panel read that value once, when it was built,
// and its settings:changed listener mirrored only `handy.defaultOffset`:
// Devices slider at -300, phone to +250, the device and the setting at 250,
// the Devices tab (even reopened) still at -300ms.
//
// Driven through the REAL panel and the REAL eventBus, as DataService.set
// emits it; asserted on the slider and the label the user reads.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));

function build(saved) {
  const values = new Map([['autoblow.offset', saved]]);
  const settings = {
    get: (k) => values.get(k),
    // As DataService.set: store, then tell everyone.
    set: (k, v) => { values.set(k, v); eventBus.emit('settings:changed', { path: k, value: v }); },
    getAll: () => ({}),
  };
  const autoblowManager = { connected: true, deviceType: 'autoblow-ultra', syncOffset: vi.fn(async () => true) };
  const panel = new ConnectionPanel({
    handyManager: { on() {}, off() {} },
    buttplugManager: { connected: false, devices: [] },
    tcodeManager: { connected: false, setPrecision() {}, listPorts: async () => [] },
    autoblowManager,
    settings,
  });
  return { panel, settings, autoblowManager };
}

const slider = () => document.querySelector('#ab-offset');
const label = () => document.querySelector('#ab-offset-value').textContent;

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  eventBus.removeAll('settings:changed');
  document.body.innerHTML = '<div id="app"></div>';
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

describe('Devices > Autoblow offset follows the saved value, wherever it was changed', () => {
  it('the phone moves it to +250: the Devices slider and label read 250ms', () => {
    const { settings } = build(-300);
    expect(slider().value).toBe('-300');
    expect(label()).toBe('-300ms');
    // What app.js _applyRemoteOffset('autoblow', 250) saves (FT-052).
    settings.set('autoblow.offset', 250);
    expect(slider().value).toBe('250');
    expect(label()).toBe('250ms');
  });

  it('the Devices slider itself still saves and sends its value (no echo loop)', () => {
    const { settings, autoblowManager } = build(0);
    slider().value = '-120';
    slider().dispatchEvent(new Event('change'));
    expect(settings.get('autoblow.offset')).toBe(-120);
    expect(autoblowManager.syncOffset).toHaveBeenCalledTimes(1);
    expect(autoblowManager.syncOffset).toHaveBeenCalledWith(-120);
    expect(label()).toBe('-120ms');
  });

  it('another setting changing leaves the slider alone', () => {
    const { settings } = build(80);
    settings.set('handy.defaultOffset', 400);
    expect(slider().value).toBe('80');
    expect(label()).toBe('80ms');
  });
});
