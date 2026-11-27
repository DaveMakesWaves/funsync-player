/**
 * @vitest-environment jsdom
 * jsdom: the control is a real checkbox in the Devices panel.
 */
// "Hybrid fades to off during holds" (EroScripts #434, 2026-11-23): Devices ▸
// Buttplug ▸ Output tuning. Off by default (Hybrid keeps a base level, as its
// help says); stored as player.hybridHoldFade; live on the engine; applied at
// startup.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

function mount(stored) {
  const store = { 'player.hybridHoldFade': stored };
  const panel = Object.create(ConnectionPanel.prototype);
  panel._panel = document.createElement('div');
  panel._panel.innerHTML = '<input type="checkbox" id="bp-hybrid-hold-fade">';
  panel.settings = { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
  panel.buttplugSync = { setHybridHoldFade: vi.fn() };
  panel._initHybridHoldFade();
  return { panel, store, cb: panel._panel.querySelector('#bp-hybrid-hold-fade') };
}

describe('the Hybrid hold fade setting', () => {
  it('shows what is stored, off when nothing is', () => {
    expect(mount(undefined).cb.checked).toBe(false);
    expect(mount(true).cb.checked).toBe(true);
  });

  it('a change is stored and reaches the engine at once', () => {
    const { panel, store, cb } = mount(false);
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    expect(store['player.hybridHoldFade']).toBe(true);
    expect(panel.buttplugSync.setHybridHoldFade).toHaveBeenCalledWith(true);
  });

  it('default off in store.js and the fallback; applied to the engine at startup; in the panel', () => {
    expect(read('electron/store.js')).toMatch(/hybridHoldFade: false,/);
    expect(read('renderer/components/settings-panel.js')).toContain("'player.hybridHoldFade': false,");
    expect(read('renderer/js/app.js')).toContain("engine.setHybridHoldFade?.(this.settings.get('player.hybridHoldFade') === true);");
    const cp = read('renderer/components/connection-panel.js');
    expect(cp).toContain('id="bp-hybrid-hold-fade"');
    expect(cp).toContain('    this._initHybridHoldFade();\n');
  });
});
