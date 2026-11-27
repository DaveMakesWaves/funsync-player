/**
 * @vitest-environment jsdom
 * jsdom on purpose: NavBar builds real DOM and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// The top bar's polish (Dave, 2026-11-25: "1,2,3, but with 1 what if more
// than one device is connected?"):
//   1. Devices is one status pill: a dot and what is connected. Several
//      devices are counted, each listed in its tooltip; one not responding
//      is named and outranks the count.
//   2. EroScripts is marked like the views when open: the same underline,
//      not a coral label.
//   3. Devices, Stop all, Web Remote and VR are one button group; Settings
//      stays apart.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { NavBar, deviceStatusSummary } from '../../renderer/components/nav-bar.js';
import { liftAppClass } from './helpers/app-methods.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const css = (f) => fs.readFileSync(`renderer/styles/${f}`, 'utf8').replace(/\r\n/g, '\n');

afterAll(() => _setBundlesForTests('en', EN, EN));
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
});

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bar = new NavBar({ onNavigate: () => {} });
  bar.init(host);
  return { bar, el: host.querySelector('.nav-bar') };
}

const HANDY = { label: 'The Handy', state: 'connected' };
const EDGE = { label: 'Lovense Edge', state: 'connected' };
const TCODE = { label: 'TCode (COM3)', state: 'connected' };

describe('1. what the Devices pill says', () => {
  it('nothing connected: "No devices", and the tooltip says what the button is for', () => {
    expect(deviceStatusSummary([])).toMatchObject({ status: 'disconnected', text: 'No devices', title: 'Device Connection', count: 0 });
  });

  it('one device: its own name', () => {
    const s = deviceStatusSummary([HANDY]);
    expect(s).toMatchObject({ status: 'connected', text: 'The Handy', title: 'The Handy · Connected', aria: 'Devices: The Handy · Connected' });
  });

  it('several: a count, and the tooltip lists each one with its state', () => {
    const s = deviceStatusSummary([HANDY, EDGE, TCODE]);
    expect(s.text).toBe('3 devices');
    expect(s.title.split('\n')).toEqual(['The Handy · Connected', 'Lovense Edge · Connected', 'TCode (COM3) · Connected']);
    expect(s.aria).toBe('Devices: The Handy · Connected, Lovense Edge · Connected, TCode (COM3) · Connected');
    expect(deviceStatusSummary([HANDY, EDGE]).text).toBe('2 devices');
  });

  it('one not responding outranks the count and names the device', () => {
    const s = deviceStatusSummary([EDGE, { label: 'The Handy', state: 'unresponsive' }, TCODE]);
    expect(s).toMatchObject({ status: 'unresponsive', text: 'The Handy not responding', count: 3 });
    expect(s.title).toContain('The Handy · Not responding');
  });

  it('connecting says so, and still lists what is already connected', () => {
    expect(deviceStatusSummary([], { connecting: true })).toMatchObject({ status: 'connecting', text: 'Connecting...' });
    const s = deviceStatusSummary([EDGE], { connecting: true });
    expect(s.text).toBe('Connecting...');
    expect(s.title).toBe('Lovense Edge · Connected');
    expect(s.aria).toBe('Devices: Connecting..., Lovense Edge · Connected');
    // A device that stopped answering still outranks a connect in progress.
    expect(deviceStatusSummary([{ label: 'The Handy', state: 'unresponsive' }], { connecting: true }).status).toBe('unresponsive');
  });

  it('slow to respond: amber, the name as usual, the tooltip says which', () => {
    const s = deviceStatusSummary([{ label: 'The Handy', state: 'slow' }, EDGE]);
    expect(s).toMatchObject({ status: 'slow', text: '2 devices' });
    expect(s.title).toContain('The Handy · Slow to respond');
  });

  it('a nameless entry is not a device', () => {
    expect(deviceStatusSummary([{ label: '  ' }, null, { state: 'connected' }, HANDY]).text).toBe('The Handy');
    expect(deviceStatusSummary(null).text).toBe('No devices');
  });

  it('every locale has the words, the count in its plural forms', () => {
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const nav = bundle(l).nav;
      for (const k of ['noDevices', 'deviceTotal', 'deviceNotResponding', 'deviceSlow', 'connectionsGroup']) {
        expect(typeof nav[k], `${l} nav.${k}`).toBe('string');
      }
      expect(nav.deviceNotResponding, l).toContain('{name}');
      expect(nav.deviceTotal, l).toContain('{count');
      expect(nav.deviceCount, `${l}: the old "{count} Connected"`).toBeUndefined();
    }
    _setBundlesForTests('ru', bundle('ru'), EN);
    expect(t('nav.deviceTotal', { count: 2 })).toBe('2 устройства');
    expect(t('nav.deviceTotal', { count: 5 })).toBe('5 устройств');
  });
});

describe('1. the pill on the bar', () => {
  it('a dot and words: no "Devices" label beside them any more', () => {
    const { el } = mount();
    const pill = el.querySelector('.nav-bar__handy');
    expect([...pill.children].map((c) => c.className)).toEqual(['nav-bar__handy-led', 'nav-bar__handy-text']);
    expect(pill.textContent).toBe('No devices');
    expect(pill.dataset.status).toBe('disconnected');
  });

  it('paints each state on the dot, the words, the tooltip and the name a screen reader reads', () => {
    const { bar, el } = mount();
    const pill = el.querySelector('.nav-bar__handy');
    const led = () => [...pill.querySelector('.nav-bar__handy-led').classList].slice(1);
    bar.setDeviceStatus({ devices: [HANDY, EDGE] });
    expect(led()).toEqual(['nav-bar__handy-led--connected']);
    expect(pill.textContent).toBe('2 devices');
    expect(pill.title).toBe('The Handy · Connected\nLovense Edge · Connected');
    expect(pill.getAttribute('aria-label')).toBe('Devices: The Handy · Connected, Lovense Edge · Connected');
    bar.setDeviceStatus({ devices: [{ label: 'The Handy', state: 'unresponsive' }] });
    expect(led()).toEqual(['nav-bar__handy-led--unresponsive']);
    expect(pill.textContent).toBe('The Handy not responding');
    bar.setDeviceStatus({ connecting: true });
    expect(led()).toEqual(['nav-bar__handy-led--connecting']);
    bar.setDeviceStatus({ devices: [{ label: 'The Handy', state: 'slow' }] });
    expect(led()).toEqual(['nav-bar__handy-led--connecting']);
    bar.setDeviceStatus({});
    expect(led()).toEqual([]);
    expect(pill.textContent).toBe('No devices');
  });

  it('Stop all shows while anything is connected, a device not responding included', () => {
    const { bar, el } = mount();
    const stop = el.querySelector('.nav-bar__stop-all');
    expect(stop.hidden).toBe(true);
    bar.setDeviceStatus({ devices: [EDGE] });
    expect(stop.hidden).toBe(false);
    bar.setDeviceStatus({ devices: [{ label: 'The Handy', state: 'unresponsive' }] });
    expect(stop.hidden).toBe(false);
    bar.setDeviceStatus({ connecting: true });
    expect(stop.hidden).toBe(true);
  });
});

describe('1. app.js hands the pill every device with its own state', () => {
  const Lifted = liftAppClass(['_connectedDevices', '_paintNavDevices', '_updateHandyIndicators', '_updateDeviceIndicators', '_getConnectedDeviceCount'], {
    document: { getElementById: () => null },
    t: (k) => k,
  });
  const appWith = (managers) => Object.assign(new Lifted(), managers, {
    navBar: { calls: [], setDeviceStatus(s) { this.calls.push(s); } },
    _updatePlayerSyncChip() {},
  });

  it('names each device as the desktop does, with its state', () => {
    const app = appWith({
      handyManager: { connected: true, responsive: true, slow: true },
      buttplugManager: { connected: true, devices: [{ name: 'Lovense Edge' }, { name: 'Lovense Lush' }] },
      tcodeManager: { connected: true, endpoint: '192.168.1.42:8000' },
      autoblowManager: { connected: true, isUltra: true },
    });
    expect(app._connectedDevices()).toEqual([
      { kind: 'handy', label: 'The Handy', state: 'slow' },
      { kind: 'buttplug', label: 'Lovense Edge', state: 'connected' },
      { kind: 'buttplug', label: 'Lovense Lush', state: 'connected' },
      { kind: 'tcode', label: 'TCode (192.168.1.42:8000)', state: 'connected' },
      { kind: 'autoblow', label: 'Autoblow Ultra', state: 'connected' },
    ]);
    // Intiface with nothing paired is not a device.
    expect(appWith({ buttplugManager: { connected: true, devices: [] } })._connectedDevices()).toEqual([]);
  });

  it('a later device event no longer paints "connected" over a Handy that is not responding', () => {
    // Before: _updateDeviceIndicators called setHandyStatus('connected', n)
    // from a bare count, over the "not responding" the Handy had just set.
    const app = appWith({ handyManager: { connected: true, responsive: false, slow: false } });
    app._updateHandyIndicators('unresponsive');
    app._updateDeviceIndicators();                    // e.g. an Intiface toy connects
    const last = app.navBar.calls.at(-1);
    expect(last.devices).toEqual([{ kind: 'handy', label: 'The Handy', state: 'unresponsive' }]);
    expect(deviceStatusSummary(last.devices, last).text).toBe('The Handy not responding');
  });

  it('"connecting" lasts until the Handy reports anything else', () => {
    const app = appWith({ handyManager: { connected: false } });
    app._updateHandyIndicators('connecting');
    app._updateDeviceIndicators();
    expect(app.navBar.calls.at(-1).connecting).toBe(true);
    app._updateHandyIndicators('disconnected');
    expect(app.navBar.calls.at(-1).connecting).toBe(false);
  });
});

describe('2. EroScripts marked like the views', () => {
  it('open, it takes the views\' underline in every style, and its label stays white', () => {
    const { bar, el } = mount();
    bar.setActive('eroscripts');
    const es = el.querySelector('.nav-bar__eroscripts');
    expect(es.classList.contains('nav-bar__eroscripts--active')).toBe(true);
    expect(es.getAttribute('aria-current')).toBe('page');
    expect(css('nav-bar.css')).toMatch(/\.nav-bar__item--active::after,\n\.nav-bar__eroscripts--active::after \{\n  content: '';/);
    expect(css('modern.css')).toMatch(/\.nav-bar__item--active::after,\n:root\[data-style="modern"\] \.nav-bar__eroscripts--active::after \{\n  height: 3px;/);
    expect(css('modern-polish.css')).toMatch(/\.nav-bar__item--active::after,\n:root\[data-style="modern"\] \.nav-bar__eroscripts--active::after \{\n  height: 2px;/);
    expect(css('holiday.css')).toMatch(/\.nav-bar__item--active::after,\n:root\[data-season="holiday"\]\[data-style="modern"\] \.nav-bar__eroscripts--active::after \{/);
    expect(css('eroscripts.css')).not.toMatch(/\.nav-bar__eroscripts--active \{ color: var\(--accent\)/);
    // At the views' height: measured live, both lines end 48.5 px down.
    expect(css('nav-bar.css')).toMatch(/\.nav-bar__eroscripts--active::after \{\n  bottom: calc\(\(100% - 32px\) \/ 2 - 9px\);/);
    bar.setActive('library');
    expect(es.classList.contains('nav-bar__eroscripts--active')).toBe(false);
  });
});

describe('3. the connections, one button group', () => {
  it('Devices, Stop all, Web Remote and VR in a named group; Settings on its own after it', () => {
    const { el } = mount();
    const group = el.querySelector('.nav-bar__group');
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Connections');
    expect([...group.children].map((b) => b.className.split(' ')[1]))
      .toEqual(['nav-bar__handy', 'nav-bar__stop-all', 'nav-bar__remote-btn', 'nav-bar__vr-btn']);
    const settings = el.querySelector('.nav-bar__settings');
    expect(settings.parentElement).toBe(el);
    expect(group.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('one border, a hairline between the shown buttons, square inside even under Modern', () => {
    const s = css('nav-bar.css');
    expect(s).toMatch(/\.nav-bar__group \{[^}]*border: 1px solid[^}]*border-radius: 8px;[^}]*overflow: hidden;/);
    expect(s).toMatch(/\.nav-bar__group > :not\(\[hidden\]\) ~ :not\(\[hidden\]\) \{\n  border-left: 1px solid/);
    // (0,3,1): beats Modern's :root[data-style="modern"] .nav-bar__action (0,3,0).
    expect(s).toMatch(/\.nav-bar \.nav-bar__group > button\.nav-bar__action \{[^}]*border-radius: 0;/);
    expect(s).toMatch(/\.nav-bar \.nav-bar__group > button\.nav-bar__action:focus-visible \{[^}]*outline-offset: -2px;/);
    expect(s).toMatch(/\.nav-bar\.nav-bar--measuring \.nav-bar__group > \*,/);
  });
});
