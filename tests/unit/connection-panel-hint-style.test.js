/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel builds the Devices markup and the
 * REAL player.css is applied to it, so getComputedStyle reads what the user
 * sees (notes/CLAUDE.md "Test environments").
 */
// Block C fix-up (2026-11-06, real-app verifier 1, cosmetic; also in
// v0.9.2): Devices > Buttplug.io > Output tuning's hint (#bp-tuning-hint)
// rendered at the browser's 16px, larger than the rest of the panel. It, and
// every other `.connection-panel__hint`, used a class no stylesheet had a
// rule for; a few uses hid that with inline styles.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const CSS = fs.readFileSync('renderer/styles/player.css', 'utf8');
afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="app"></div>';
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

describe('Devices panel hint text is the panel\'s small secondary text', () => {
  it('#bp-tuning-hint: 11px, not the browser\'s 16px, in the secondary text colour', () => {
    const values = new Map();
    new ConnectionPanel({
      handyManager: { on() {}, off() {} },
      buttplugManager: { connected: false, devices: [] },
      settings: { get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) },
    });
    const hint = document.getElementById('bp-tuning-hint');
    expect(hint).toBeTruthy();
    expect(hint.textContent.trim()).toBe(EN.settingsPanel.playback.bpHint);
    const style = getComputedStyle(hint);
    expect(style.fontSize).toBe('11px');
    expect(style.color).toBe('var(--text-secondary)');
    // The label it sits under is 12px: the hint is not larger than its label.
    const label = document.querySelector('label[for="bp-linear-strategy"]');
    expect(parseFloat(getComputedStyle(label).fontSize)).toBeGreaterThan(parseFloat(style.fontSize));
  });
});
