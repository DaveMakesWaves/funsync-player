/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL video options dialog is built in a document by
 * the REAL Modal, with the REAL Tags section, and driven by clicks;
 * i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// The Stash fix-up's dialog side (2026-11-19, s1-review-a RA-S1-3, -4, -5):
//   - "Not this scene…" sends the scene its confirm NAMED (s1-fixup-main's
//     stash-refuse {path, target, sceneId}): a link that changed while the
//     confirm was open is kept, only the named scene is refused, and the
//     line says so; a file unlinked meanwhile is "changed meanwhile".
//     Unlink sends the scene the block showed ('changed-since' otherwise).
//   - Tags > Where they came from keeps its Stash row while a kept link
//     waits on a check (design (b) rule 3): the chips still say Stash.
//   - "Hidden on this video" names Stash people as the chips do, never by
//     the raw identity key, and two of one name read apart.
// Real: the dialog, Modal, the Tags section, DataService (IPC faked),
// stash-tags.js, the library's tag index. Fake: host.stash
// (tests/helpers/stash-dialog-fixtures.js, main's rules for each write).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { stashTagRecords, nameIdentities } from '../../renderer/js/stash-tags.js';
import { buildLibraryTagIndex } from '../../renderer/js/library-tag-filter.js';
import {
  bundleWith, STASH_STRINGS, S1_FIXUP_STRINGS, stashData, makeFakeStash, videoEntry, SERVER, HASH,
} from '../helpers/stash-dialog-fixtures.js';

const { openVideoOptionsDialog, _resetVideoOptionsSessionForTests } = await import('../../renderer/components/video-options-dialog.js');
const { _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');

const EN = bundleWith(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')), { ...STASH_STRINGS, ...S1_FIXUP_STRINGS });
const VIDEO = 'C:\\Lib\\Square Clip.mp4';

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const dialogBody = () => document.querySelector('.modal-body.video-options');
const panel = (id) => dialogBody().querySelector(`.video-options__panel[data-section="${id}"]`);
const stashBlock = () => panel('file').querySelector('.video-options-stash');
const control = (key) => dialogBody().querySelector(`[data-vo-focus="${key}"]`);
const liveText = () => dialogBody().querySelector('.video-options__live-text').textContent;
const undoButton = () => dialogBody().querySelector('.video-options__undo');

let ds;
let video;
let stash;
let host;
let others = []; // more library videos for the index (their labels are the library's)

function tagIndex() {
  const on = ds.get('stash.enabled') === true;
  const data = stash.data();
  return buildLibraryTagIndex({
    videos: [video, ...others],
    userTags: ds.get('library.userTags') || {},
    hiddenTags: ds.get('library.hiddenTags') || {},
    scriptTags: ds.get('library.scriptTags') || {},
    tagSettings: ds.get('library.tagSettings') || {},
    stash: on ? stashTagRecords(data, { videos: [video, ...others], enabled: true }) : {},
    nameIds: on ? nameIdentities(data, { enabled: true }) : null,
  });
}

function setup({ data = stashData({ videoPath: VIDEO }), enabled = true, size = 1000, library = {} } = {}) {
  ds = new DataService();
  ds._cache.settings.library = { ...ds._cache.settings.library, ...library };
  ds._cache.settings.stash = { enabled, url: SERVER, syncOnStart: false, pathRules: [] };
  ds._initialized = true;
  video = { name: 'Square Clip.mp4', path: VIDEO, hasFunscript: false, funscriptPath: null, duration: 60, size, variants: [] };
  stash = makeFakeStash(data, { enabled: () => ds.get('stash.enabled') === true });
  host = {
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
    tagIndex: () => tagIndex(),
    stash,
  };
}

async function open(opts = { section: 'file' }) {
  const done = openVideoOptionsDialog(host, video, opts);
  await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
  return { done };
}

async function closeAll() {
  while (overlays().length > 0) {
    overlays().at(-1).querySelector('.modal-close-btn').click();
    await flush();
  }
}

const linkTo = (sceneId) => ({ sceneId, server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 5, oshash: HASH }, linkedAt: 20, state: 'ok' });

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetVideoOptionsSessionForTests();
  _resetTagsSectionForTests();
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
  others = [];
  setup();
});

afterEach(async () => {
  await closeAll();
  vi.unstubAllGlobals();
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('Not this scene… sends the scene its confirm named (RA-S1-3)', () => {
  const ask = async () => {
    await open();
    expect(stashBlock().dataset.stashState).toBe('linked');
    control('stash:notThis').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    return overlays()[1];
  };

  it('re-linked while the confirm was open: only the named scene is refused, the new link stays, the line says so; Undo is exact', async () => {
    const confirm = await ask();
    expect(confirm.querySelector('.modal-message').textContent).toContain('“Synthetic Scene Small”');
    // The start-up sync ends meanwhile and re-links the file to scene 2.
    const next = structuredClone(stash.raw);
    next.links[VIDEO] = linkTo('2');
    stash.raw = next;
    await flush();
    const before = videoEntry(stash.data(), VIDEO);
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(liveText()).not.toBe(''));
    expect(stash.calls.find(([n]) => n === 'refuse')).toEqual(['refuse', VIDEO, 'link', '1']);
    expect(stash.data().refused[VIDEO].sceneIds).toEqual(['1']);
    expect(stash.data().links[VIDEO].sceneId).toBe('2');
    expect(liveText()).toBe('You said this file is not “Synthetic Scene Small”. It is now linked to “Synthetic Scene Two”, which was left as it is.');
    expect(stashBlock().dataset.stashState).toBe('linked');
    expect(document.activeElement).toBe(undoButton());
    undoButton().click();
    await vi.waitFor(() => expect(stash.calls.some(([n]) => n === 'undo')).toBe(true));
    await vi.waitFor(() => expect(videoEntry(stash.data(), VIDEO)).toEqual(before));
  });

  it('unlinked while the confirm was open: "changed meanwhile", and nothing is refused', async () => {
    const confirm = await ask();
    const next = structuredClone(stash.raw);
    delete next.links[VIDEO];
    stash.raw = next;
    await flush();
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(liveText()).toBe("This video's Stash data changed meanwhile. Nothing was changed."));
    expect(stash.data().refused[VIDEO]).toBeUndefined();
  });

  it('the link unchanged: the named scene is refused and the link goes, as before', async () => {
    const confirm = await ask();
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('refused'));
    expect(liveText()).toBe('You said this file is not “Synthetic Scene Small”.');
  });
});

describe('Unlink sends the scene the block showed (RA-S1-3)', () => {
  const gone = () => {
    const data = stashData({ videoPath: VIDEO });
    data.links[VIDEO].state = 'gone';
    return data;
  };

  it('the request names it', async () => {
    setup({ data: gone() });
    await open();
    control('stash:unlink').click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('notInStash'));
    expect(stash.calls.find(([n]) => n === 'unlink')).toEqual(['unlink', VIDEO, '1']);
  });

  it('another scene linked by the time it arrives: "changed meanwhile", that link is kept', async () => {
    setup({ data: gone() });
    await open();
    stash.raw.links[VIDEO] = linkTo('3'); // main's data moved on; the block has not redrawn yet
    control('stash:unlink').click();
    await vi.waitFor(() => expect(liveText()).toBe("This video's Stash data changed meanwhile. Nothing was changed."));
    expect(stash.data().links[VIDEO].sceneId).toBe('3');
  });
});

describe('Tags > Where they came from, while a kept link waits on a check (RA-S1-4)', () => {
  const openTags = async () => {
    await open({ section: 'tags' });
    await vi.waitFor(() => expect(panel('tags').querySelector('.video-options-tags')).toBeTruthy());
  };
  const check = { [VIDEO]: { kind: 'several', sceneIds: ['1', '2'], fp: { size: 1000, mtimeMs: 5, oshash: HASH }, seenAt: 9, server: SERVER } };

  it('the Stash row shows the kept link\'s scene and counts (the chips say Stash), with Open in Stash', async () => {
    setup({ data: stashData({ videoPath: VIDEO, check }) });
    await openTags();
    expect(panel('tags').querySelectorAll('.video-options-tags__chip').length).toBeGreaterThan(0);
    const row = panel('tags').querySelector('.video-options-tags__source--stash');
    expect(row).toBeTruthy();
    expect(row.querySelector('.video-options-tags__stash-line').textContent.startsWith('“Synthetic Scene Small” · 2 tags, 2 performers, 1 studio · synced ')).toBe(true);
    expect(row.querySelector('[data-vo-focus="tags:stashOpen"]')).toBeTruthy();
  });

  it('a check with no link: no Stash row (no chip says Stash)', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {}, check }) });
    await openTags();
    expect(panel('tags').querySelector('.video-options-tags__source--stash')).toBeNull();
  });

  it('a kept link whose file changed, with a check: the row says its Stash tags are hidden', async () => {
    setup({ data: stashData({ videoPath: VIDEO, check }), size: 2000 });
    await openTags();
    expect(panel('tags').querySelector('.video-options-tags__stash-line').textContent)
      .toBe('“Synthetic Scene Small” · this file changed; its Stash tags are hidden until the next sync');
  });
});

describe('"Hidden on this video" names Stash people as the chips do (RA-S1-5)', () => {
  const HIDDEN = { [VIDEO]: ['performer:jane-doe#aaaa-3f2a', 'performer:jane-doe#bbbb-9c1d'] };
  const labels = () => [...panel('tags').querySelectorAll('.video-options-tags__hidden-label')].map((n) => n.textContent);
  const openTags = async () => {
    await open({ section: 'tags' });
    await vi.waitFor(() => expect(panel('tags').querySelector('.video-options-tags')).toBeTruthy());
  };

  it('two Jane Does hidden on this video read apart, each with its own Show again', async () => {
    setup({ library: { hiddenTags: HIDDEN } });
    await openTags();
    expect(labels()).toEqual(['Jane Doe (blonde)', 'Jane Doe · 9c1d']);
    const again = [...panel('tags').querySelectorAll('.video-options-tags__show-again')].map((b) => b.getAttribute('aria-label'));
    expect(new Set(again).size).toBe(2);
  });

  it('one Jane Doe hidden here, both shown on another video: the row reads as the library labels her ("Jane Doe (blonde)")', async () => {
    const OTHER = 'C:\\Lib\\Other Clip.mp4';
    const data = stashData({ videoPath: VIDEO });
    data.links[OTHER] = { ...data.links[VIDEO] };
    setup({ data, library: { hiddenTags: { [VIDEO]: ['performer:jane-doe#aaaa-3f2a'] } } });
    others = [{ name: 'Other Clip.mp4', path: OTHER, hasFunscript: false, funscriptPath: null, duration: 60, size: 1000, variants: [] }];
    await openTags();
    expect(labels()).toEqual(['Jane Doe (blonde)']);
    const chips = [...panel('tags').querySelectorAll('.video-options-tags__chip')];
    expect(chips.find((c) => c.dataset.tagKey === 'performer:jane-doe#bbbb-9c1d').textContent).toContain('Jane Doe · 9c1d');
  });

  it('Stash off: names, never a Stash ID or the raw key', async () => {
    setup({ library: { hiddenTags: HIDDEN }, enabled: false });
    await openTags();
    expect(labels()).toHaveLength(2);
    for (const l of labels()) expect(l).not.toMatch(/#|aaaa|bbbb/i);
    expect(new Set(labels()).size).toBe(2);
  });
});

// s1-fixup-main (ipc-changes.txt 5, S1RB-4): a link whose Stash scene id now
// names a scene without this file is 'changed' with `sceneChanged: true`.
describe('File > Stash: the scene with this id no longer has this file', () => {
  it('says so (not "this file changed"), keeps the data hidden, and offers Sync this video and Unlink', async () => {
    const data = stashData({ videoPath: VIDEO });
    data.links[VIDEO] = { ...data.links[VIDEO], state: 'changed', sceneChanged: true };
    setup({ data });
    await open();
    const b = stashBlock();
    expect(b.dataset.stashState).toBe('changed');
    const words = [...b.querySelectorAll('p')].map((n) => n.textContent);
    expect(words).toContain('The Stash scene with this id no longer has this file (Stash may have been reset or rescanned). Its data is hidden. Unlink it, or link it again with Find in Stash…');
    expect(words).not.toContain('This file changed since it was matched. Its Stash data is hidden until the next sync.');
    expect(b.textContent).not.toContain('Jane Doe');
    expect([...b.querySelectorAll('.video-options__actions button')].map((x) => x.textContent)).toEqual(['Sync this video', 'Unlink']);
  });

  it('Tags > Where they came from says it the same way, not "this file changed" (s1-fixup-renderer, fixed 2026-11-22)', async () => {
    const data = stashData({ videoPath: VIDEO });
    data.links[VIDEO] = { ...data.links[VIDEO], state: 'changed', sceneChanged: true };
    setup({ data });
    await open({ section: 'tags' });
    const line = panel('tags').querySelector('.video-options-tags__stash-line').textContent;
    expect(line).toContain('its Stash scene no longer has this file; its Stash tags are hidden');
    expect(line).not.toContain('this file changed');
  });

  it('a file that changed (no sceneChanged) keeps its own words', async () => {
    setup({ size: 2000 });
    await open();
    expect([...stashBlock().querySelectorAll('p')].map((n) => n.textContent))
      .toContain('This file changed since it was matched. Its Stash data is hidden until the next sync.');
  });
});
