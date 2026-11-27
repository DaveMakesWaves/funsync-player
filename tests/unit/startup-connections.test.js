/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Dave, 2026-11-25: "since we dont just cater to handy users anymore lets
// remove the handy failed to connect toast on start up and have a toast for
// any devices that do get connected on start up".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { StartupConnections, deviceList, WINDOW_MS, SETTLE_MS } from '../../renderer/js/startup-connections.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('one toast for the devices that connected at start-up', () => {
  it('the Handy, then a toy from the Intiface scan a few seconds later: ONE toast naming both, once they settle', () => {
    const onShow = vi.fn();
    const s = new StartupConnections({ onShow });
    s.begin();
    vi.advanceTimersByTime(1200);
    s.connected('The Handy');
    vi.advanceTimersByTime(2000);                       // Intiface's scan still going
    expect(onShow).not.toHaveBeenCalled();
    s.connected('Lovense Edge');
    s.connected('Lovense Edge');                        // a second report of the same toy
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(onShow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith(['The Handy', 'Lovense Edge']);
    // Later connections are the user's own: no second toast.
    s.connected('Kiiroo Keon');
    vi.advanceTimersByTime(WINDOW_MS);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('nothing connected: nothing said', () => {
    const onShow = vi.fn();
    const s = new StartupConnections({ onShow });
    s.begin();
    vi.advanceTimersByTime(WINDOW_MS + SETTLE_MS);
    expect(onShow).not.toHaveBeenCalled();
    s.connected('The Handy');                           // after the window
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onShow).not.toHaveBeenCalled();
  });

  it('connections that keep coming are said when the window ends, not held for ever', () => {
    const onShow = vi.fn();
    const s = new StartupConnections({ onShow });
    s.begin();
    for (let i = 0; i < 10; i++) { s.connected(`Toy ${i}`); vi.advanceTimersByTime(SETTLE_MS - 100); }
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow.mock.calls[0][0].length).toBeGreaterThan(1);
  });

  it('before begin(), and empty names, count for nothing', () => {
    const onShow = vi.fn();
    const s = new StartupConnections({ onShow });
    s.connected('The Handy');
    s.begin();
    s.connected('  ');
    s.connected(null);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(onShow).not.toHaveBeenCalled();
  });

  it('the list reads in the language shown', () => {
    expect(deviceList(['The Handy'])).toBe('The Handy');
    expect(deviceList(['The Handy', 'Lovense Edge'], 'en')).toBe('The Handy and Lovense Edge');
    expect(deviceList(['A', 'B', 'C'], 'de')).toBe('A, B und C');
    expect(deviceList([], 'en')).toBe('');
  });
});

describe('the app', () => {
  const app = fs.readFileSync('renderer/js/app.js', 'utf8');
  it('no "Handy auto-connect failed" toast any more; the string is gone from every language', () => {
    expect(app).not.toMatch(/toast\.handyAutoFailed/);
    for (const loc of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const j = JSON.parse(fs.readFileSync(`renderer/locales/${loc}.json`, 'utf8'));
      expect(j.toast.handyAutoFailed, loc).toBeUndefined();
      expect(typeof j.toast.devicesConnected, loc).toBe('string');
      expect(j.toast.devicesConnected, loc).toContain('{devices}');
    }
  });

  it('starts listening before the start-up connects, and the Handy and Intiface\'s toys report in', () => {
    const begin = app.indexOf('this._startupConnections.begin()');
    expect(begin).toBeGreaterThan(0);
    expect(begin).toBeLessThan(app.indexOf('this._autoConnectHandy(savedKey)'));
    const handy = app.slice(app.indexOf('this.handyManager.onConnect = () => {'), app.indexOf('const panelOnDeviceInfo'));
    expect(handy).toMatch(/this\._startupConnections\?\.connected\('The Handy'\)/);
    const bp = app.slice(app.indexOf('this.buttplugManager.onDeviceAdded = (dev) => {'));
    expect(bp.slice(0, 2500)).toMatch(/this\._startupConnections\?\.connected\(dev\.name\)/);
  });
});
