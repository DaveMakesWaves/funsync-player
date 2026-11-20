/**
 * @vitest-environment jsdom
 * jsdom on purpose: NavBar builds real DOM and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// A live language switch must leave the nav bar exactly as booting in that
// language would (app test V50).
//
// `_retranslate()` refreshed the device widget only by replaying the last
// setHandyStatus() call, and app.js makes that call only on device
// activity. With no saved Handy key, "Devices / Not connected" stayed in the
// boot language forever. Most titles and aria-labels (the nav itself, the
// Playlists/Categories items, the library arrow, Web Remote, VR, the device
// button) were set once in init() and never again.
//
// The check is deliberately generic: every text node, title and aria-label in
// the bar after a de -> en switch must equal a bar that booted in English. A
// new control that forgets to retranslate fails it without a new assertion.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { NavBar } from '../../renderer/components/nav-bar.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');

afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  document.body.innerHTML = '';
});

function mountNavBar() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bar = new NavBar({ onNavigate: () => {} });
  bar.init(host);
  return { bar, el: host.querySelector('.nav-bar') };
}

/** Everything a user or a screen reader gets from the bar. */
function rendered(el) {
  const out = [];
  const nodes = [el, ...el.querySelectorAll('*')];
  nodes.forEach((n, i) => {
    const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('');
    out.push(`${i} ${n.className} text=${own} title=${n.getAttribute('title') ?? ''} aria=${n.getAttribute('aria-label') ?? ''}`);
  });
  return out;
}

function switchTo(locale, dict) {
  _setBundlesForTests(locale, dict, EN);
  eventBus.emit('language:changed', { locale });
}

describe('nav bar follows a live language switch (V50)', () => {
  it('with no device activity, matches a bar that booted in the new language', () => {
    _setBundlesForTests('en', EN, EN);
    const reference = rendered(mountNavBar().el);
    document.body.innerHTML = '';

    _setBundlesForTests('de', DE, EN);
    const { el } = mountNavBar();
    // Sanity: it really booted German.
    expect(el.querySelector('.nav-bar__handy-text').textContent).toBe(DE.nav.notConnected);

    switchTo('en', EN);

    expect(rendered(el)).toEqual(reference);
    expect(el.querySelector('.nav-bar__handy-label').textContent).toBe(EN.nav.devices);
    expect(el.querySelector('.nav-bar__handy-text').textContent).toBe(EN.nav.notConnected);
  });

  it('keeps live device state while translating it', () => {
    _setBundlesForTests('de', DE, EN);
    const { bar, el } = mountNavBar();
    bar.setHandyStatus('connected', 2);

    switchTo('en', EN);

    expect(el.querySelector('.nav-bar__handy-led').classList.contains('nav-bar__handy-led--connected')).toBe(true);
    expect(el.querySelector('.nav-bar__handy-text').textContent).not.toBe(DE.nav.notConnected);
    expect(el.querySelector('.nav-bar__handy').getAttribute('aria-label')).toMatch(/^Devices: /);
  });

  it('keeps the active collection name on the library button', () => {
    _setBundlesForTests('de', DE, EN);
    const { bar, el } = mountNavBar();
    bar.setCollections([{ id: 'c1', name: 'My Picks' }], 'c1', []);
    expect(el.querySelector('.nav-bar__item[data-view-id="library"] .nav-bar__label').textContent).toBe('My Picks');

    switchTo('en', EN);

    expect(el.querySelector('.nav-bar__item[data-view-id="library"] .nav-bar__label').textContent).toBe('My Picks');
  });
});
