// jsdom on purpose (no node docblock): the REAL Library renders its header,
// sort picker and grid, and imports i18n.js, which branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
//
// V81 (Dave, 2026-11-03): a sort click while a scan or a Refresh is running
// must take effect. The picker's handlers skip `_applyFilters` while
// `_scanning` is set (`if (!this._scanning) this._applyFilters()`), so the
// click itself repaints nothing; what makes it count is that the handler
// records the choice before that gate, and the scan's own render at the end
// sorts by it. Measured live: a sort during a Refresh applied when the scan
// ended. Nothing pinned it: the only sort test that set `_scanning` used it
// to skip rendering.
//
// Driven through the REAL picker (button, then the row's radio) and the REAL
// header Refresh, with the scan held open on a promise the test releases.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { Library } = await import('../../renderer/components/library.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DIR = 'D:\\funsc';

// Name order and duration order disagree, so the grid says which one won.
const VIDEOS = [
  { name: 'Alpha.mp4', duration: 300 },
  { name: 'Bravo.mp4', duration: 100 },
  { name: 'Charlie.mp4', duration: 200 },
];
const scanResult = () => ({
  videos: VIDEOS.map((v) => ({ ...v, path: `${DIR}\\${v.name}`, hasFunscript: false, variants: [] })),
  unmatchedFunscripts: [], unmatchedSubtitles: [], allFunscripts: [], failedPaths: [], skippedPaths: [],
});

let lib;
let container;
let store;

beforeEach(async () => {
  _setBundlesForTests('en', EN, EN);
  store = {
    'library.sources': [{ id: 'a', name: 'Main', path: DIR, enabled: true }],
    'library.collections': [],
    'library.associations': {},
  };
  const settings = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
  window.funsync = { scanDirectory: vi.fn(async () => scanResult()) };
  lib = new Library({ settings });
  // Not under test: background passes and thumbnails.
  lib._registerWithBackend = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeDurationsInBackground = async () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._lazyLoadVisibleThumbnails = () => {};
  lib._activeTab = 'all';   // the test videos have no scripts
  container = document.createElement('div');
  document.body.appendChild(container);
  await lib.show(container);
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

const shownNames = () => [...container.querySelectorAll('.library__card')]
  .map((c) => c.dataset.videoPath.split('\\').pop());

/** Hold the next scan open until the returned release() is called. */
function holdNextScan() {
  let release;
  window.funsync.scanDirectory = vi.fn(() => new Promise((r) => { release = () => r(scanResult()); }));
  return () => release();
}

/** What the user does: open the Sort picker, click a row. */
function pickSort(field) {
  container.querySelector('#library-sort-btn').click();
  container.querySelector(`.library__picker-item[data-value="${field}"] input[type="radio"]`).click();
}

describe('a sort click during a scan takes effect (V81)', () => {
  it('a sort picked during a Refresh is the order the refreshed grid shows', async () => {
    expect(shownNames()).toEqual(['Alpha.mp4', 'Bravo.mp4', 'Charlie.mp4']);   // name A-Z

    const release = holdNextScan();
    const refreshing = lib.refresh();
    await vi.waitFor(() => expect(lib._scanning).toBe(true));

    pickSort('duration');
    // The click is not lost while the scan runs: the picker says what the
    // user chose, even though the grid is still the scan's loading state.
    expect(container.querySelector('#library-sort-btn .library__picker-label').textContent)
      .toBe(t('library.sortDurationAsc'));

    release();
    await refreshing;

    expect(lib._scanning).toBe(false);
    expect(shownNames()).toEqual(['Bravo.mp4', 'Charlie.mp4', 'Alpha.mp4']);   // shortest first
  });

  it('a direction flip during a Refresh applies too', async () => {
    const release = holdNextScan();
    const refreshing = lib.refresh();
    await vi.waitFor(() => expect(lib._scanning).toBe(true));

    pickSort('name');                 // re-clicking the selected row flips it
    release();
    await refreshing;

    expect(shownNames()).toEqual(['Charlie.mp4', 'Bravo.mp4', 'Alpha.mp4']);   // Z-A
  });

  it('with no scan running, the click repaints at once', () => {
    pickSort('duration');
    expect(shownNames()).toEqual(['Bravo.mp4', 'Charlie.mp4', 'Alpha.mp4']);
  });
});
