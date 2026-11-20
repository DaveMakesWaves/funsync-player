/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel and Library header render into a
 * document, and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// Labels rendered after boot must be in the active language (app test V51).
//
// Four labels were literal English in JS templates, tagged `data-i18n` and
// left for translatePage() to fix:
//   connection-panel  "Audience", "Sync"  (Devices panel tabs)
//   library header    "Filters", "Sort"
// translatePage() runs once at boot, BEFORE the Devices panel is built and
// before every library header rebuild, and again only on an in-session
// language switch. So in every other locale the Devices panel said
// "Audience" / "Sync", and the library said "Filters" after any rebuild.
// They now call t() at render time like their neighbours.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { Library } from '../../renderer/components/library.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const JA = bundle('ja');
const DE = bundle('de');

afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><div id="library-container"></div></div>';
});

const settingsFake = () => {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    getPlaylists: () => [],
    getPlaylist: () => null,
    getCategories: () => [],
    getCategory: () => null,
    getVideosByCategory: () => [],
  };
};

const tabLabel = (panel, tab) => panel._panel
  .querySelector(`.connection-panel__tab[data-tab="${tab}"] .connection-panel__tab-label`).textContent.trim();

describe('Devices panel tab labels (V51)', () => {
  it('are in the active language when the panel is built after boot', () => {
    _setBundlesForTests('ja', JA, EN);
    // No translatePage() here: in the app it ran at boot, before this.
    const panel = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings: settingsFake() });

    expect(tabLabel(panel, 'audience')).toBe(JA.audience.tab.label);
    expect(tabLabel(panel, 'sync')).toBe(JA.connection.tabSync);
  });

  it('follow a live language switch on their own', () => {
    _setBundlesForTests('ja', JA, EN);
    const panel = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings: settingsFake() });

    _setBundlesForTests('de', DE, EN);
    eventBus.emit('language:changed', { locale: 'de' });

    expect(tabLabel(panel, 'audience')).toBe(DE.audience.tab.label);
    expect(tabLabel(panel, 'sync')).toBe(DE.connection.tabSync);
  });
});

describe('Library header picker labels (V51)', () => {
  function renderHeader() {
    const lib = new Library({ settings: settingsFake() });
    // Header-only render, as the app does on every show()/rebuild. The
    // pickers' own builders are stubbed: nothing in them sets the Filters
    // label, which is the point.
    lib._renderBreadcrumb = () => {};
    lib._buildSortPicker = () => {};
    lib._buildFiltersPicker = () => {};
    lib._renderFilterChips = () => {};
    lib._syncSortForActiveTab = () => {};
    lib._container = document.getElementById('library-container');
    lib._renderWithHeader();
    return lib._container;
  }

  it('Filters and Sort are in the active language on a rebuild after boot', () => {
    _setBundlesForTests('ja', JA, EN);
    const header = renderHeader();
    expect(header.querySelector('#library-filters-btn .library__picker-label').textContent).toBe(JA.library.filters);
    expect(header.querySelector('#library-sort-btn .library__picker-label').textContent).toBe(JA.library.sort);
  });
});

describe('no literal English behind a data-i18n tag in renderer JS (V51 guard)', () => {
  // A `data-i18n="key">Word` inside a JS template is this exact bug: it is
  // right only until something re-renders it after translatePage().
  it('every data-i18n element in a JS template renders its text with t()', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const offenders = [];
    for (const file of walk('renderer')) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /data-i18n="([^"]+)"[^>]*>\s*([^<$\s][^<]*)</g;
      let m;
      while ((m = re.exec(src))) offenders.push(`${file}: ${m[1]} -> "${m[2].trim()}"`);
    }
    expect(offenders).toEqual([]);
  });
});
