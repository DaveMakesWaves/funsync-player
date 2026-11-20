/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL video options dialog is built in a document by
 * the REAL Modal; i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// Stash's plays, last played and O-count in the video options dialog's
// File > Stash block (Stash "next" lot, stage sn-library, 2026-11-19;
// DESIGN-stash-s1.md (j) #10): read-only lines from the data already
// synced (the seeded test Stash's values, tests/helpers/stash-next-
// fixtures.js), "never" only when Stash counts no plays, and no line at all
// when Stash gave no value (an older library.json) or the link's data does
// not count. Fake: `host.stash` (tests/helpers/stash-dialog-fixtures.js
// makeFakeStash, library.js `_stashHost()`'s interface). No Stash is ever
// contacted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { bundleWith, makeFakeStash, REQUEST_CALLS, STASH_STRINGS } from '../helpers/stash-dialog-fixtures.js';
import { P, SERVER, NEXT_STRINGS, snProjection, snVideos } from '../helpers/stash-next-fixtures.js';

const { openVideoOptionsDialog, _resetVideoOptionsSessionForTests } = await import('../../renderer/components/video-options-dialog.js');
const { _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');

const EN = bundleWith(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')), { ...STASH_STRINGS, ...NEXT_STRINGS });

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const dialogBody = () => document.querySelector('.modal-body.video-options');
const stashBlock = () => dialogBody().querySelector('.video-options__panel[data-section="file"] .video-options-stash');
const requests = (stash) => stash.calls.filter(([name]) => REQUEST_CALLS.includes(name));

/** The activity lines: [{fact, label, value}] in order. */
function activity() {
  return [...stashBlock().querySelectorAll('dd[data-stash-fact]')].map((dd) => ({
    fact: dd.dataset.stashFact, label: dd.previousElementSibling.textContent, value: dd.textContent,
  }));
}

/** The dialog's short date (stashShortDate): the year only when it is not this year. */
function shortDate(iso) {
  const d = new Date(Date.parse(iso));
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat('en', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

let ds;
let stash;

function makeDataService(enabled) {
  const d = new DataService();
  d._cache.settings.stash = { enabled, url: SERVER, syncOnStart: false, pathRules: [] };
  d._initialized = true;
  return d;
}

async function open(path, { data = snProjection(), enabled = true, size } = {}) {
  ds = makeDataService(enabled);
  const scanned = snVideos().find((v) => v.path === path);
  const video = { ...scanned, size: size === undefined ? scanned.size : size };
  stash = makeFakeStash(data, { enabled: () => ds.get('stash.enabled') === true });
  const host = {
    settings: ds,
    getVideo: (p) => (p === video.path ? video : null),
    libraryVideos: () => [video],
    canQueue: false,
    formatDuration: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
    thumbnailUrl: () => null,
    pathStatus: vi.fn(async () => true),
    collectionContext: () => ({ sources: [], folderIndex: null, descendantsOf: null }),
    dataChanged: vi.fn(),
    copyText: vi.fn(async () => true),
    tagIndex: () => null,
    stash,
  };
  openVideoOptionsDialog(host, video, { section: 'file' });
  await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetVideoOptionsSessionForTests();
  _resetTagsSectionForTests();
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
});

afterEach(async () => {
  while (overlays().length > 0) {
    overlays().at(-1).querySelector('.modal-close-btn').click();
    await flush();
  }
  vi.unstubAllGlobals();
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('File > Stash: plays, last played, O-count', () => {
  it('shows Stash\'s counts and date for a linked video (5 plays, 17 Nov, O-count 3)', async () => {
    await open(P.large);
    expect(stashBlock().dataset.stashState).toBe('linked');
    expect(activity()).toEqual([
      { fact: 'plays', label: 'Plays', value: '5' },
      { fact: 'lastPlayed', label: 'Last played', value: shortDate('2026-11-17T21:45:00Z') },
      { fact: 'oCount', label: 'O-count', value: '3' },
    ]);
  });

  it('"never" when Stash counts no plays; a zero O-count is still a value', async () => {
    await open(P.edge131072);
    expect(activity()).toEqual([
      { fact: 'plays', label: 'Plays', value: '0' },
      { fact: 'lastPlayed', label: 'Last played', value: 'never' },
      { fact: 'oCount', label: 'O-count', value: '2' },
    ]);
  });

  it('plays without a date: the date line is hidden, not "never"', async () => {
    await open(P.mid, { data: snProjection({ scenes: { 3: { lastPlayedAt: null } } }) });
    expect(activity()).toEqual([
      { fact: 'plays', label: 'Plays', value: '2' },
      { fact: 'oCount', label: 'O-count', value: '0' },
    ]);
  });

  it('an older library.json (no plays, no O-count): no line at all, never "0 plays"', async () => {
    await open(P.large, { data: snProjection({ omitNext: true }) });
    expect(stashBlock().dataset.stashState).toBe('linked');
    expect(activity()).toEqual([]);
    expect(stashBlock().textContent).not.toContain('Plays');
    expect(stashBlock().textContent).not.toContain('never');
    // The rest of the block is still there (S1's rating line).
    expect(stashBlock().textContent).toContain('rated 100/100');
  });

  it('a file changed since its link (the trust check): none of the old scene\'s counts', async () => {
    await open(P.large, { size: 1 });
    expect(stashBlock().dataset.stashState).toBe('changed');
    expect(activity()).toEqual([]);
  });

  it('Stash off: no block, no counts', async () => {
    await open(P.large, { enabled: false });
    expect(stashBlock()).toBeNull();
  });

  it('read-only: the lines are text, and opening asks Stash nothing', async () => {
    await open(P.large);
    for (const dd of stashBlock().querySelectorAll('dd[data-stash-fact]')) {
      expect(dd.querySelector('button, input, a')).toBeNull();
    }
    expect(requests(stash)).toEqual([]);
  });
});
