/**
 * @vitest-environment jsdom
 * jsdom on purpose: NavBar builds real DOM, the REAL SettingsPanel opens
 * through Modal.open(), and i18n.js / settings-panel.js branch on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Settings toggles to hide nav-bar buttons (zaikechi, EroScripts #381).
//
// Settings > Appearance > Navigation bar: one tick per hideable button
// (Playlists, Categories, EroScripts, Devices, Web Remote, VR). Library and
// Settings can never be hidden. All ticked, the default, is the bar as it
// always was. What is asserted is what the user sees: which buttons are on
// the bar, that a hidden cluster leaves no double or stray gap, that the
// right side stays on the right with EroScripts gone, that a hidden Devices
// button still takes the status updates app.js writes into it, and that the
// choice survives reopening Settings (the REAL panel, wired to app.js's own
// `onNavHiddenChanged` callback, lifted).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { NavBar, NAV_HIDEABLE_ITEMS } from '../../renderer/components/nav-bar.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { liftCtorOptions } from './helpers/app-methods.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');

afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
});

function mountNavBar() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bar = new NavBar({ onNavigate: () => {} });
  bar.init(host);
  return { bar, el: host.querySelector('.nav-bar') };
}

const shown = (el) => el && !el.hidden;

/** The bar left to right as the user sees it: labels, and `|` for a gap. */
function visibleBar(el) {
  const out = [];
  for (const child of el.children) {
    if (child.hidden) continue;
    if (child.classList.contains('nav-bar__cluster-gap')) { out.push('|'); continue; }
    if (child.classList.contains('nav-bar__library-wrapper')) { out.push('Library'); continue; }
    if (child.classList.contains('nav-bar__item')) { out.push(child.textContent.trim()); continue; }
    if (child.classList.contains('nav-bar__eroscripts')) { out.push('EroScripts'); continue; }
    if (child.classList.contains('nav-bar__handy')) { out.push('Devices'); continue; }
    if (child.classList.contains('nav-bar__remote-btn')) { out.push('Web Remote'); continue; }
    if (child.classList.contains('nav-bar__vr-btn')) { out.push('VR'); continue; }
    if (child.classList.contains('nav-bar__settings')) { out.push('Settings'); continue; }
    out.push(`?${child.className}`);
  }
  return out;
}

/** Which visible element carries the right-side `margin-left: auto`. */
function pushedRight(el) {
  return [...el.children].filter((c) => !c.hidden && (
    c.classList.contains('nav-bar__eroscripts') || c.classList.contains('nav-bar__action--push')));
}

const ALL = ['Library', 'Playlists', 'Categories', 'EroScripts', '|', 'Devices', 'Web Remote', 'VR', '|', 'Settings'];

describe('nav bar: hiding buttons (#381)', () => {
  it('the default (nothing hidden) is the bar exactly as it was', () => {
    const untouched = mountNavBar().el.outerHTML;
    document.body.innerHTML = '';
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({});
    expect(visibleBar(el)).toEqual(ALL);
    // Byte for byte: no stray attribute or class from the hide pass.
    expect(el.outerHTML).toBe(untouched);
    bar.setHiddenItems(undefined);
    expect(el.outerHTML).toBe(untouched);
  });

  it('every hideable button can go, one at a time', () => {
    const label = { playlists: 'Playlists', categories: 'Categories', eroscripts: 'EroScripts',
      devices: 'Devices', remote: 'Web Remote', vr: 'VR' };
    for (const { key } of NAV_HIDEABLE_ITEMS) {
      document.body.innerHTML = '';
      const { bar, el } = mountNavBar();
      bar.setHiddenItems({ [key]: true });
      const seen = visibleBar(el);
      expect(seen, key).not.toContain(label[key]);
      expect(seen.filter((x) => x !== '|'), key).toEqual(ALL.filter((x) => x !== '|' && x !== label[key]));
    }
  });

  it('Library and Settings can never be hidden', () => {
    const { bar, el } = mountNavBar();
    const everything = Object.fromEntries(NAV_HIDEABLE_ITEMS.map(({ key }) => [key, true]));
    bar.setHiddenItems({ ...everything, library: true, settings: true });
    expect(visibleBar(el)).toEqual(['Library', 'Settings']);
    expect(NAV_HIDEABLE_ITEMS.map((i) => i.key)).not.toContain('library');
    expect(NAV_HIDEABLE_ITEMS.map((i) => i.key)).not.toContain('settings');
  });

  it('hiding Web Remote and VR keeps both gaps (Devices still fills the cluster)', () => {
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({ remote: true, vr: true });
    expect(visibleBar(el)).toEqual(['Library', 'Playlists', 'Categories', 'EroScripts', '|', 'Devices', '|', 'Settings']);
  });

  it('hiding the whole Devices / Web Remote / VR cluster leaves one gap, not two', () => {
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({ devices: true, remote: true, vr: true });
    expect(visibleBar(el)).toEqual(['Library', 'Playlists', 'Categories', 'EroScripts', '|', 'Settings']);
  });

  it('hiding EroScripts drops its gap and moves the push to the first right-side button', () => {
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({ eroscripts: true });
    expect(visibleBar(el)).toEqual(['Library', 'Playlists', 'Categories', 'Devices', 'Web Remote', 'VR', '|', 'Settings']);
    expect(pushedRight(el).map((c) => c.className)).toEqual(['nav-bar__action nav-bar__handy nav-bar__action--push']);
  });

  it('with only Settings left on the right, Settings takes the push and no gap shows', () => {
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({ eroscripts: true, devices: true, remote: true, vr: true });
    expect(visibleBar(el)).toEqual(['Library', 'Playlists', 'Categories', 'Settings']);
    expect(pushedRight(el)).toHaveLength(1);
    expect(pushedRight(el)[0].classList.contains('nav-bar__settings')).toBe(true);
  });

  it('showing everything again puts the bar back as it was', () => {
    const untouched = mountNavBar().el.outerHTML;
    document.body.innerHTML = '';
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({ eroscripts: true, devices: true, remote: true, vr: true, playlists: true });
    bar.setHiddenItems({});
    expect(visibleBar(el)).toEqual(ALL);
    expect(el.outerHTML).toBe(untouched);
  });

  it('a hidden Devices button still takes the status app.js writes, and shows it once ticked again', () => {
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({ devices: true });
    // app.js flashes the LED on every device command through this field.
    expect(bar._handyLed.isConnected).toBe(true);
    bar.setHandyStatus('connected', 2);
    bar.setHiddenItems({});
    const handy = el.querySelector('.nav-bar__handy');
    expect(shown(handy)).toBe(true);
    expect(handy.querySelector('.nav-bar__handy-led').classList.contains('nav-bar__handy-led--connected')).toBe(true);
    expect(handy.querySelector('.nav-bar__handy-text').textContent).toBe(t('nav.deviceCount', { count: 2 }));
  });

  it('a live language switch keeps the hidden buttons hidden', () => {
    _setBundlesForTests('de', DE, EN);
    const { bar, el } = mountNavBar();
    bar.setHiddenItems({ remote: true, vr: true, categories: true });
    _setBundlesForTests('en', EN, EN);
    eventBus.emit('language:changed', { locale: 'en' });
    expect(visibleBar(el)).toEqual(['Library', 'Playlists', 'EroScripts', '|', 'Devices', '|', 'Settings']);
  });
});

// --- Settings > Appearance > Navigation bar, wired the way app.js wires it --

let store;
let showing;

function makeApp() {
  const app = {
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
      getAll: () => ({}),
    },
    _orgasmSummaryText: () => [],
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  app.navBar = new NavBar({ onNavigate: () => {} });
  app.navBar.init(host);
  return app;
}

const appOptions = liftCtorOptions('SettingsPanel', { showToast: vi.fn(), t });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function openAppearance(app) {
  const panel = new SettingsPanel(appOptions.call(app));
  showing = panel.show();
  document.querySelector('.settings-panel__rail-item[data-area="appearance"]').click();
  await flush();
  return panel;
}

async function closeSettings() {
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
  showing = null;
}

describe('Settings > Appearance > Navigation bar (#381)', () => {
  beforeEach(() => {
    store = {};
    showing = null;
    window.funsync = {
      setSetting: () => {},
      onGlobalShortcut: () => {},
      setGlobalShortcuts: async () => [],
    };
  });
  afterEach(async () => { if (showing) await closeSettings(); });

  it('lists the six hideable buttons, all ticked by default, with the bar names', async () => {
    await openAppearance(makeApp());
    const boxes = [...document.querySelectorAll('#sp-sec-nav input[type="checkbox"]')];
    expect(boxes.map((b) => b.dataset.navKey)).toEqual(['playlists', 'categories', 'eroscripts', 'devices', 'remote', 'vr']);
    expect(boxes.every((b) => b.checked)).toBe(true);
    const labels = boxes.map((b) => document.querySelector(`label[for="${b.id}"]`).textContent);
    expect(labels).toEqual(['Playlists', 'Categories', EN.nav.eroscripts, 'Devices', 'Web Remote', 'VR']);
    // The hint says Devices keeps its key and the other two do not have one.
    expect(document.querySelector('#sp-nav-hint').textContent).toBe(EN.settingsPanel.appearance.navHint);
    // And the rail lists the section.
    expect([...document.querySelectorAll('.settings-panel__rail-group')].map((g) => g.dataset.section)).toContain('sp-sec-nav');
  });

  it('unticking VR hides it on the bar at once, saves it, and reopening shows it unticked', async () => {
    const app = makeApp();
    await openAppearance(app);
    const vr = document.querySelector('#sp-nav-show-vr');
    vr.click();
    expect(store['player.navHidden']).toEqual({ vr: true });
    expect(visibleBar(app.navBar._el)).not.toContain('VR');
    await closeSettings();

    await openAppearance(app);
    expect(document.querySelector('#sp-nav-show-vr').checked).toBe(false);
    expect(document.querySelector('#sp-nav-show-remote').checked).toBe(true);

    document.querySelector('#sp-nav-show-remote').click();
    expect(store['player.navHidden']).toEqual({ vr: true, remote: true });
    document.querySelector('#sp-nav-show-vr').click();
    expect(store['player.navHidden']).toEqual({ vr: false, remote: true });
    expect(visibleBar(app.navBar._el)).toEqual(['Library', 'Playlists', 'Categories', 'EroScripts', '|', 'Devices', 'VR', '|', 'Settings']);
  });

  it('the store default hides nothing', async () => {
    const { DEFAULTS } = await import('../../electron/store.js');
    expect(DEFAULTS.settings.player.navHidden).toEqual({
      playlists: false, categories: false, eroscripts: false, devices: false, remote: false, vr: false,
    });
    const app = makeApp();
    store['player.navHidden'] = DEFAULTS.settings.player.navHidden;
    app.navBar.setHiddenItems(store['player.navHidden']);
    expect(visibleBar(app.navBar._el)).toEqual(ALL);
  });
});
