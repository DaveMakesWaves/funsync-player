/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library renders its header, Filters picker, chip
 * strip and cards into a DOM and opens the REAL video options dialog through
 * the REAL Modal; i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// The desktop Tags filter (P1 wiring, Round 3, 2026-11-18; DESIGN-video-
// options.md (e), PLAN-next-major-2026-11.md §2.2 "Filtering" / "Showing
// tags"; Dave's answers 4 and 5), driven the way a user drives it: open
// Filters, tick a tag, read the grid, the chips and the badge.
//
// The script files' own metadata comes from script-meta-store.js, a stub
// another stage fills in; it is replaced here by a controllable fake with the
// same documented exports (scriptMetaMap / scriptMetaVersion /
// onScriptMetaChanged / getScriptMeta).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { _resetVideoOptionsSessionForTests } from '../../renderer/components/video-options-dialog.js';

const meta = vi.hoisted(() => ({ map: {}, version: 0, listeners: new Set(), asked: [] }));
vi.mock('../../renderer/js/script-meta-store.js', () => ({
  scriptMetaMap: () => meta.map,
  scriptMetaVersion: () => meta.version,
  onScriptMetaChanged: (cb) => { meta.listeners.add(cb); return () => meta.listeners.delete(cb); },
  getScriptMeta: async (p) => { meta.asked.push(p); return meta.map[p] ?? null; },
}));

const { Library } = await import('../../renderer/components/library.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const LIB = 'C:\\Lib';
const ALPHA = `${LIB}\\Alpha Scene.mp4`;
const ALPHA_OWN = `${LIB}\\Alpha Scene.funscript`;
const BRAVO = `${LIB}\\Bravo Take.mp4`;
const BRAVO_OWN = `${LIB}\\Bravo Take.funscript`;
const CHARLIE = `${LIB}\\Charlie Cut.mp4`;
const DELTA = `${LIB}\\Delta Plain.mp4`;
const ECHO_A = `${LIB}\\A\\Echo Twin.mp4`;    // has a script: the copy dedupe keeps
const ECHO_A_OWN = `${LIB}\\A\\Echo Twin.funscript`;
const ECHO_B = `${LIB}\\B\\Echo Twin.mp4`;    // no script, but the tag

const video = (path, own = null) => ({
  name: path.split('\\').pop(), path, hasFunscript: !!own, funscriptPath: own,
  hasSubtitle: false, subtitlePath: null, variants: own ? [{ label: 'Default', path: own, name: own.split('\\').pop() }] : [],
});

const ALL = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO_A, ECHO_B];

let lib;
let ds;
let container;
let setSetting;

function scanResult() {
  return {
    videos: [
      video(ALPHA, ALPHA_OWN), video(BRAVO, BRAVO_OWN), video(CHARLIE), video(DELTA),
      video(ECHO_A, ECHO_A_OWN), video(ECHO_B),
    ],
    unmatchedFunscripts: [],
    allFunscripts: [ALPHA_OWN, BRAVO_OWN, ECHO_A_OWN].map((p) => ({ name: p.split('\\').pop(), path: p })),
    failedPaths: [],
    skippedPaths: [],
  };
}

function baseLibrary(extra = {}) {
  return {
    viewMode: 'grid',
    sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }],
    associations: {},
    userTags: {
      [ALPHA]: ['pov'],
      [CHARLIE]: ['the handy', 'cosplay'],
      [ECHO_B]: ['twin-only'],
    },
    hiddenTags: {},
    scriptTags: {
      [ALPHA]: { tags: ['the-handy', 'non-vr'], topicId: 11, scriptPath: ALPHA_OWN, source: 'eroscripts', savedAt: 1 },
    },
    tagSettings: { aliases: {}, hidden: [], facetOverrides: {} },
    ...extra,
  };
}

async function boot({ library = {}, categories = [], videoCategories = {}, tab = 'all', metaMap = null } = {}) {
  meta.map = metaMap || { [BRAVO_OWN]: { tags: ['POV', 'osr2'], topicTags: [], performers: [], creator: null } };
  meta.version = 1;
  ds = new DataService();
  ds._cache.settings = { backend: { port: 5123 }, player: {}, library: baseLibrary(library) };
  ds._cache.categories = categories;
  ds._cache.videoCategories = videoCategories;
  ds._initialized = true;
  lib = new Library({ settings: ds });
  lib._queueThumbnail = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._precomputeDurationsInBackground = async () => {};
  lib._activeTab = tab;
  container = document.createElement('div');
  document.body.appendChild(container);
  await lib.show(container);
  const wrapper = container.querySelector('.library__grid-wrapper');
  Object.defineProperty(wrapper, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true });
  await settle();
  setSetting.mockClear();
  return lib;
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const flush = () => new Promise((r) => setTimeout(r, 0));
const shown = () => [...container.querySelectorAll('.library__grid [data-video-path]')].map((el) => el.dataset.videoPath);
const pop = () => container.querySelector('#library-filters-pop');
const tagsSection = () => pop().querySelector('.library__picker-section--tags');
const box = (key) => tagsSection().querySelector(`input[type="checkbox"][data-filter-key="${key}"]`);
const chipKeys = () => [...container.querySelectorAll('#library-chips .filter-chip')].map((c) => c.dataset.filterKey);
const chip = (key) => [...container.querySelectorAll('#library-chips .filter-chip')].find((c) => c.dataset.filterKey === key);
const badge = () => container.querySelector('#library-filters-badge');
const overlays = () => [...document.querySelectorAll('.modal-overlay')];

function openFilters() {
  const btn = container.querySelector('#library-filters-btn');
  if (pop().hidden) btn.click();
  expect(pop().hidden).toBe(false);
}

function tick(key, on = true) {
  const b = box(key);
  expect(b, `no row ${key}`).toBeTruthy();
  b.checked = on;
  b.dispatchEvent(new Event('change', { bubbles: true }));
}

function rowsOf(facet) {
  const set = tagsSection().querySelector(`fieldset[data-facet="${facet}"]`);
  if (!set) return null;
  return [...set.querySelectorAll('.library__tag-option')].map((l) => [
    l.querySelector('.library__tag-option-label').textContent,
    l.querySelector('.library__tag-option-count').textContent,
  ]);
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetVideoOptionsSessionForTests();
  document.body.innerHTML = '<div id="toast-container"></div>';
  meta.listeners.clear();
  meta.asked = [];
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  setSetting = vi.fn();
  const known = {
    setSetting,
    scanDirectory: vi.fn(async () => scanResult()),
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (list) => list.map(() => true)),
    fileExists: vi.fn(async () => true),
    assignCategory: vi.fn(),
    unassignCategory: vi.fn(),
  };
  window.funsync = new Proxy(known, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)) });
});

afterEach(async () => {
  while (overlays().length > 0) {
    overlays().at(-1).querySelector('.modal-close-btn').click();
    await flush();
  }
  container?.remove();
  vi.unstubAllGlobals();
  delete globalThis.fetch;
  delete window.funsync;
  delete window.app;
});

describe('the Tags section of the Filters picker', () => {
  it('lists the engine\'s facets, translated, each value with its count of videos; Category and "Tags from" too', async () => {
    await boot({ categories: [{ id: 'c1', name: 'Faves', color: '#f00' }], videoCategories: { [DELTA]: ['c1'] } });
    openFilters();
    const sec = tagsSection();
    expect(sec.querySelector('.library__picker-section-title').textContent).toBe('Tags');
    expect([...sec.querySelectorAll('fieldset')].map((f) => f.dataset.facet))
      .toEqual(['category', 'vr', 'device', 'content', 'source']);
    expect([...sec.querySelectorAll('legend')].map((l) => l.textContent))
      .toEqual(['Category', 'VR', 'Device', 'Content', 'Tags from']);
    // the handy: Alpha (its EroScripts post) and Charlie (yours); osr2: Bravo's file.
    expect(rowsOf('device')).toEqual([['the handy', '2'], ['osr2', '1']]);
    // pov: Alpha (yours) and Bravo (its file).
    // Most used first; your own spelling is the label (twin-only as typed).
    expect(rowsOf('content')).toEqual([['pov', '2'], ['cosplay', '1'], ['twin-only', '1']]);
    expect(rowsOf('category')).toEqual([['Faves', '1']]);
    expect(rowsOf('source')).toEqual([['EroScripts', '1'], ['The script file', '1'], ['You', '3']]);
    expect(box('tag:device:the-handy').getAttribute('aria-label')).toBe('the handy, 2 videos');
  });

  it('OR within a facet, AND across facets; one chip per tag; the badge counts each chip', async () => {
    await boot();
    openFilters();
    tick('tag:device:osr2');
    expect(shown()).toEqual([BRAVO]);
    tick('tag:device:the-handy');
    expect(shown().sort()).toEqual([ALPHA, BRAVO, CHARLIE].sort());
    tick('tag:content:pov');
    expect(shown().sort()).toEqual([ALPHA, BRAVO].sort());
    expect(chipKeys()).toEqual(['tag:device:osr2', 'tag:device:the-handy', 'tag:content:pov']);
    expect(chip('tag:device:the-handy').textContent).toBe('Device: the handy');
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('3');
  });

  it('the badge counts the Match status chip and every tag chip', async () => {
    await boot({ tab: 'matched' });
    openFilters();
    tick('tag:content:pov');
    tick('tag:vr:non-vr');
    expect(chipKeys()).toEqual(['tab', 'tag:content:pov', 'tag:vr:non-vr']);
    expect(badge().textContent).toBe('3');
    expect(shown()).toEqual([ALPHA]);
  });

  it('a chip\'s × takes that tag off and unticks its row; the rest stay', async () => {
    await boot();
    openFilters();
    tick('tag:device:the-handy');
    tick('tag:content:cosplay');
    expect(shown()).toEqual([CHARLIE]);
    chip('tag:content:cosplay').click();
    expect(chipKeys()).toEqual(['tag:device:the-handy']);
    expect(box('tag:content:cosplay').checked).toBe(false);
    expect(box('tag:device:the-handy').checked).toBe(true);
    expect(shown().sort()).toEqual([ALPHA, CHARLIE].sort());
    expect(badge().textContent).toBe('1');
  });

  it('a tag hidden on a video does not find it, and is not counted for it', async () => {
    await boot({ library: { hiddenTags: { [ALPHA]: ['pov'] } } });
    openFilters();
    // Only Bravo's file gives it now, so the file's spelling labels it.
    expect(rowsOf('content').find((r) => r[0].toLowerCase() === 'pov')).toEqual(['POV', '1']);
    tick('tag:content:pov');
    expect(shown()).toEqual([BRAVO]);
  });

  it('runs BEFORE the duplicate-name collapse: the copy holding the tag is the one shown', async () => {
    await boot({ library: { hideDuplicateNames: true } });
    // Collapsed without the filter: the scripted copy stands for both.
    expect(shown()).toContain(ECHO_A);
    expect(shown()).not.toContain(ECHO_B);
    openFilters();
    tick('tag:content:twin-only');
    expect(shown()).toEqual([ECHO_B]);
  });

  it('Category: FunSync\'s own categories filter the grid (OR inside), AND with tags', async () => {
    await boot({
      categories: [{ id: 'c1', name: 'Faves', color: '#f00' }, { id: 'c2', name: 'Later', color: '#0f0' }],
      videoCategories: { [DELTA]: ['c1'], [ALPHA]: ['c2'], [CHARLIE]: ['c2'] },
    });
    openFilters();
    tick('category:c1');
    expect(shown()).toEqual([DELTA]);
    expect(chip('category:c1').textContent).toBe('Category: Faves');
    tick('category:c2');
    expect(shown().sort()).toEqual([ALPHA, CHARLIE, DELTA].sort());
    tick('tag:content:cosplay');
    expect(shown()).toEqual([CHARLIE]);
  });

  it('"Tags from": the videos with a tag from that source', async () => {
    await boot();
    openFilters();
    tick('source:funscript');
    expect(shown()).toEqual([BRAVO]);
    expect(chip('source:funscript').textContent).toBe('Tags from: The script file');
    tick('source:eroscripts');
    expect(shown().sort()).toEqual([ALPHA, BRAVO].sort());
  });

  it('the find box narrows the rows; nothing found says so', async () => {
    await boot({ categories: [{ id: 'c1', name: 'Handy picks', color: '#f00' }], videoCategories: { [DELTA]: ['c1'] } });
    openFilters();
    const find = tagsSection().querySelector('.library__tag-find');
    find.value = 'HAN';
    find.dispatchEvent(new Event('input'));
    expect([...tagsSection().querySelectorAll('fieldset')].map((f) => f.dataset.facet)).toEqual(['category', 'device']);
    expect(rowsOf('device')).toEqual([['the handy', '2']]);
    find.value = 'zzz';
    find.dispatchEvent(new Event('input'));
    expect(tagsSection().querySelectorAll('fieldset')).toHaveLength(0);
    const note = tagsSection().querySelector('.library__tag-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Nothing matches “zzz”.');
  });

  it('a long facet shows ten rows and "Show all (n)"; ticked rows always show', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `topic ${String(i).padStart(2, '0')}`);
    await boot({ library: { userTags: { [DELTA]: many } } });
    openFilters();
    // Twelve of Delta's, and pov from Bravo's file.
    expect(rowsOf('content')).toHaveLength(10);
    const more = tagsSection().querySelector('fieldset[data-facet="content"] .library__tag-show-all');
    expect(more.textContent).toBe('Show all (13)');
    more.click();
    expect(rowsOf('content')).toHaveLength(13);
    tick('tag:content:topic-11');
    tagsSection().querySelector('fieldset[data-facet="content"] .library__tag-show-all').click(); // Show fewer
    expect(rowsOf('content').map((r) => r[0])).toContain('topic 11');
  });

  it('a library with no tags and no categories says so', async () => {
    await boot({ library: { userTags: {}, scriptTags: {} }, metaMap: {} });
    openFilters();
    const note = tagsSection().querySelector('.library__tag-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('No tags or categories on your videos yet.');
  });
});

describe('what the Tags filter leaves alone', () => {
  it('search does not match tags (Dave\'s answer 4)', async () => {
    await boot();
    const input = container.querySelector('.library__search-input');
    input.value = 'cosplay';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    expect(shown()).not.toContain(CHARLIE);
    expect(shown()).toEqual([]);
  });

  it('is not remembered: nothing is written to the store, and a new library starts with no tag filter (answer 5)', async () => {
    await boot();
    openFilters();
    tick('tag:content:pov');
    chip('tag:content:pov').click();
    tick('source:user');
    expect(setSetting).not.toHaveBeenCalled();
    const fresh = new Library({ settings: ds });
    expect(fresh._tagChips()).toEqual([]);
  });

  it('Clear filters (the filtered-to-nothing state) clears the tags and unticks their rows', async () => {
    await boot({ tab: 'all' });
    openFilters();
    tick('tag:device:osr2');
    tick('tag:content:cosplay');
    expect(shown()).toEqual([]);
    const cta = container.querySelector('.library__grid .library__empty-btn');
    expect(cta.textContent).toBe(EN.library.emptyFilteredCta);
    cta.click();
    expect(chipKeys()).toEqual([]);
    expect(box('tag:device:osr2').checked).toBe(false);
    expect(shown().length).toBe(ALL.length);
  });
});

describe('the one tag index follows the data', () => {
  it('the script files\' metadata changes: re-indexed, and the filtered grid follows', async () => {
    await boot();
    openFilters();
    tick('tag:content:pov');
    expect(shown().sort()).toEqual([ALPHA, BRAVO].sort());
    meta.map = { ...meta.map, [ECHO_A_OWN]: { tags: ['pov'], topicTags: [], performers: [], creator: null } };
    meta.version = 2;
    for (const cb of meta.listeners) cb();
    expect(rowsOf('content')[0]).toEqual(['pov', '3']); // the open picker's count, at once
    await flush();
    expect(shown().sort()).toEqual([ALPHA, BRAVO, ECHO_A].sort());
  });

  it('a tag written to the store re-filters once, and a pass that ran since is not repeated', async () => {
    await boot();
    openFilters();
    tick('tag:content:cosplay');
    expect(shown()).toEqual([CHARLIE]);
    const renders = vi.spyOn(lib, '_applyFilters');
    ds.set('library.userTags', { ...ds.get('library.userTags'), [DELTA]: ['cosplay'] });
    ds.set('library.hiddenTags', {});
    await flush();
    expect(renders).toHaveBeenCalledTimes(1);
    expect(shown().sort()).toEqual([CHARLIE, DELTA].sort());

    // A pass that ran after the write (the dialog's close, say) already read
    // the new tags: the queued one does not render the grid a second time.
    renders.mockClear();
    ds.set('library.userTags', { ...ds.get('library.userTags'), [DELTA]: [] });
    lib._applyFilters();
    await flush();
    expect(renders).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([CHARLIE]);
  });

  it('while the video options dialog is open the render is owed to its close', async () => {
    await boot();
    openFilters();
    tick('tag:content:cosplay');
    lib._videoOptionsOpen = true;
    const renders = vi.spyOn(lib, '_applyFilters');
    ds.set('library.userTags', { ...ds.get('library.userTags'), [DELTA]: ['cosplay'] });
    await flush();
    expect(renders).not.toHaveBeenCalled();
    expect(lib._renderOwedOnClose).toBe(true);
    lib._videoOptionsOpen = false;
  });

  it('one index for the filter, the counts and the cards: built once while nothing changes', async () => {
    await boot({ library: { showTagsOnCards: true } });
    const memo = lib._tagIndexMemo();
    const before = memo.builds;
    openFilters();
    tick('tag:content:pov');
    chip('tag:content:pov').click();
    lib._applyFilters();
    expect(memo.builds).toBe(before);
    ds.set('library.userTags', { ...ds.get('library.userTags'), [DELTA]: ['x'] });
    lib._applyFilters();
    expect(memo.builds).toBe(before + 1);
  });
});

describe('tags on cards (Settings > Appearance, off by default)', () => {
  it('off: no tag line at all, cards as before', async () => {
    await boot();
    expect(container.querySelectorAll('.library__card-tags')).toHaveLength(0);
  });

  it('on: every card has a tag line; a few tags, then "+N"', async () => {
    const many = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    await boot({ library: { showTagsOnCards: true, userTags: { [DELTA]: many, [CHARLIE]: ['the handy', 'cosplay'] } } });
    const cards = [...container.querySelectorAll('.library__card')];
    expect(cards.length).toBe(ALL.length);
    expect(cards.every((c) => c.querySelector('.library__card-tags'))).toBe(true);
    const line = (p) => cards.find((c) => c.dataset.videoPath === p).querySelector('.library__card-tags');
    expect([...line(CHARLIE).querySelectorAll('.library__card-tag')].map((s) => s.textContent)).toEqual(['the handy', 'cosplay']);
    expect([...line(DELTA).querySelectorAll('.library__card-tag')].map((s) => s.textContent)).toEqual(['alpha', 'beta', 'delta', '+2']);
    expect(line(DELTA).title).toBe('alpha, beta, delta, epsilon, gamma');
    expect(line(ECHO_A).children).toHaveLength(0);
  });

  it('a tag named like markup is text on the card, never an element', async () => {
    await boot({ library: { showTagsOnCards: true, userTags: { [DELTA]: ['<img src=x onerror=alert(1)>'] } } });
    const card = [...container.querySelectorAll('.library__card')].find((c) => c.dataset.videoPath === DELTA);
    const line = card.querySelector('.library__card-tags');
    expect(line.querySelector('img')).toBeNull();
    expect(line.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('list rows get the line too', async () => {
    await boot({ library: { showTagsOnCards: true, viewMode: 'list' } });
    const row = [...container.querySelectorAll('.library__list-item')].find((r) => r.dataset.videoPath === CHARLIE);
    expect(row.querySelector('.library__card-tags--list').textContent).toBe('the handycosplay');
  });
});

describe('the video options dialog\'s Tags section, from the library', () => {
  async function openTags(path) {
    lib._openVideoOptions(lib.getVideoByPath(path), { section: 'tags' });
    await vi.waitFor(() => expect(document.querySelector('.modal-body.video-options .video-options-tags')).toBeTruthy());
    return document.querySelector('.video-options__panel[data-section="tags"]');
  }
  const tagChip = (panel, key) => [...panel.querySelectorAll('.video-options-tags__chip')].find((li) => li.dataset.tagKey === key);

  it('"Show videos with this tag": the dialog closes, that tag\'s chip filters the grid, the focus is on the grid', async () => {
    await boot();
    openFilters();
    tick('tag:device:osr2'); // another pick: replaced by the one tag
    container.querySelector('#library-filters-btn').click(); // close the picker
    const panel = await openTags(ALPHA);
    tagChip(panel, 'content:pov').querySelector('.video-options-tags__chip-label').click();
    const item = [...panel.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Show videos with this tag');
    expect(item).toBeTruthy();
    item.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(0));
    await settle();
    expect(chipKeys()).toEqual(['tag:content:pov']);
    expect(chip('tag:content:pov').textContent).toBe('Content: pov');
    expect(shown().sort()).toEqual([ALPHA, BRAVO].sort());
    const firstCard = container.querySelector('.library__grid .library__card');
    expect(document.activeElement).toBe(firstCard.querySelector('.library__kebab-btn'));
    expect(lib._videoOptionsOpen).toBe(false);
  });

  it('the script file\'s own metadata reaches the section (ctx.getScriptMeta) and the rail count', async () => {
    await boot();
    const panel = await openTags(BRAVO);
    expect(meta.asked).toContain(BRAVO_OWN);
    await vi.waitFor(() => expect(tagChip(panel, 'device:osr2')).toBeTruthy());
    const count = document.querySelector('.video-options__rail-item[data-section="tags"] .video-options__rail-count');
    expect(count.textContent).toBe('2');
  });

  it('the add box suggests from the library\'s one index (the script files\' tags included)', async () => {
    await boot();
    const panel = await openTags(CHARLIE);
    const input = panel.querySelector('.video-options-tags__add input, input.video-options-tags__add-input')
      || panel.querySelector('input[type="text"]');
    input.value = 'osr';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const options = [...panel.querySelectorAll('[role="option"]')].map((o) => o.dataset.tagKey);
    expect(options).toEqual(['device:osr2']);
  });

  it('the EroScripts hooks: the panel\'s session check, and its answer after a refusal (2d\'s TODO)', async () => {
    await boot();
    const panelApi = {
      checkSession: vi.fn(async () => 'expired'),
      handleSessionExpired: vi.fn(async () => 'valid'),
      login: vi.fn(async () => true),
    };
    window.app = { eroscriptsPanel: panelApi };
    const hooks = lib._videoOptionsHost().eroscripts;
    expect(typeof hooks.checkSession).toBe('function');
    expect(await hooks.checkSession({ force: true })).toBe('expired');
    expect(panelApi.checkSession).toHaveBeenCalledWith({ force: true });
    expect(await hooks.sessionExpired()).toBe('valid');
    delete window.app;
    expect(hooks.checkSession).toBeUndefined();
    expect(await hooks.sessionExpired()).toBeUndefined();
  });
});
