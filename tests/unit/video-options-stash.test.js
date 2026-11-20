/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL video options dialog is built in a document by
 * the REAL Modal, with the REAL Tags section and the REAL Find in Stash…
 * picker, and driven by clicks and keys; i18n.js branches on `typeof
 * window` (notes/CLAUDE.md "Test environments").
 */
// Stash S1 in the video options dialog (DESIGN-stash-s1.md (b) "Ambiguity
// and how you resolve it", (e), (f) "The video options dialog", (g); stage
// s1-2c-dialog, 2026-11-18): File > Stash in every state, its actions with
// their exact Undo through the dialog's live line, the Tags section's Stash
// row, and Find in Stash….
//
// What runs for real: the dialog, Modal, the Tags section, the picker,
// DataService (its IPC faked), the view model (stash-tags.js
// stashVideoView) and the library's tag index (library-tag-filter.js
// buildLibraryTagIndex, so the performer labels are the ones the chips and
// the filter show). Fake: `host.stash` (library.js `_stashHost()`'s
// interface), which keeps main's rules for each write and its Undo token
// (tests/helpers/stash-dialog-fixtures.js). No Stash is ever contacted.
//
// Each guard here was checked by reopening its hole (SCRATCH/s1-2c-dialog/
// holes.jsonl): Stash off shows nothing; opening sends nothing; Undo gives
// main's token back (link, check and refusal exactly as before); the error
// words are the reason, not one "failed"; the choice is the one picked;
// Find in Stash… only links; identity labels; text from Stash is text.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { stashTagRecords, nameIdentities } from '../../renderer/js/stash-tags.js';
import { buildLibraryTagIndex } from '../../renderer/js/library-tag-filter.js';
import {
  bundleWith, stashData, makeFakeStash, videoEntry, REQUEST_CALLS, SERVER, OLD_SERVER, HASH, OTHER_HASH,
} from '../helpers/stash-dialog-fixtures.js';

const { openVideoOptionsDialog, _resetVideoOptionsSessionForTests } = await import('../../renderer/components/video-options-dialog.js');
const { _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');

const EN = bundleWith(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')));
const VIDEO = 'C:\\Lib\\Square Clip.mp4';
const COPY = 'C:\\Lib\\Copies\\Square Clip (copy).mp4';

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const dialogBody = () => document.querySelector('.modal-body.video-options');
const panel = (id) => dialogBody().querySelector(`.video-options__panel[data-section="${id}"]`);
const stashBlock = () => panel('file').querySelector('.video-options-stash');
const control = (key) => dialogBody().querySelector(`[data-vo-focus="${key}"]`);
const liveText = () => dialogBody().querySelector('.video-options__live-text').textContent;
const undoButton = () => dialogBody().querySelector('.video-options__undo');
const requests = (stash) => stash.calls.filter(([name]) => REQUEST_CALLS.includes(name));

let ds;
let host;
let video;
let stash;
let ipc;

function makeDataService({ enabled = true, library = {} } = {}) {
  const d = new DataService();
  d._cache.settings.library = { ...d._cache.settings.library, ...library };
  d._cache.settings.stash = { enabled, url: SERVER, syncOnStart: false, pathRules: [] };
  d._initialized = true;
  return d;
}

/** The library's one tag index, as library.js builds it (the Stash source only while on). */
function tagIndex() {
  const on = ds.get('stash.enabled') === true;
  const data = stash.data();
  return buildLibraryTagIndex({
    videos: [video],
    userTags: ds.get('library.userTags') || {},
    hiddenTags: ds.get('library.hiddenTags') || {},
    scriptTags: ds.get('library.scriptTags') || {},
    tagSettings: ds.get('library.tagSettings') || {},
    stash: on ? stashTagRecords(data, { videos: [video], enabled: true }) : {},
    nameIds: on ? nameIdentities(data, { enabled: true }) : null,
  });
}

function makeHost(over = {}) {
  return {
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
    ...over,
  };
}

function setup({ data = stashData({ videoPath: VIDEO }), enabled = true, size = 1000, library = {} } = {}) {
  ds = makeDataService({ enabled, library });
  video = { name: 'Square Clip.mp4', path: VIDEO, hasFunscript: false, funscriptPath: null, duration: 60, size, variants: [] };
  stash = makeFakeStash(data, { enabled: () => ds.get('stash.enabled') === true });
  host = makeHost();
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

function lines(node) {
  return [...node.querySelectorAll('p, dd, dt, label, legend, summary, li')].map((n) => n.textContent);
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetVideoOptionsSessionForTests();
  _resetTagsSectionForTests();
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  ipc = [];
  window.funsync = new Proxy({}, {
    get: (_o, k) => vi.fn(async (...args) => { ipc.push([k, ...args]); return null; }),
  });
  setup();
});

afterEach(async () => {
  await closeAll();
  vi.unstubAllGlobals();
  delete window.funsync;
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------

describe('Stash off: nothing Stash anywhere', () => {
  it('settings.stash.enabled false: no Stash block in File, no Stash row or chips in Tags, no count from Stash', async () => {
    setup({ enabled: false });
    await open({ section: 'file' });
    expect(panel('file').querySelector('.video-options__block')).toBeTruthy(); // the file facts are there
    expect(stashBlock()).toBeNull();
    expect(panel('file').textContent).not.toContain('Stash');
    dialogBody().querySelector('.video-options__rail-item[data-section="tags"]').click();
    await vi.waitFor(() => expect(panel('tags').querySelector('.video-options-tags')).toBeTruthy());
    expect(panel('tags').querySelector('.video-options-tags__source--stash')).toBeNull();
    expect(panel('tags').querySelector('.video-options-tags__chip')).toBeNull();
    expect(dialogBody().querySelector('.video-options__rail-count').hidden).toBe(true);
    expect(requests(stash)).toEqual([]);
  });

  it('a library that gives no host.stash: nothing, even with the setting on', async () => {
    host = makeHost({ stash: undefined });
    await open({ section: 'file' });
    expect(stashBlock()).toBeNull();
  });
});

describe('never on its own (design (g) "Never on its own")', () => {
  it('opening the dialog and visiting File and Tags sends nothing to Stash and changes nothing', async () => {
    const before = JSON.stringify(stash.data());
    await open({ section: 'file' });
    expect(stashBlock()).toBeTruthy();
    dialogBody().querySelector('.video-options__rail-item[data-section="tags"]').click();
    await vi.waitFor(() => expect(panel('tags').querySelector('.video-options-tags__source--stash')).toBeTruthy());
    dialogBody().querySelector('.video-options__rail-item[data-section="file"]').click();
    await flush();
    expect(requests(stash)).toEqual([]);
    expect(stash.calls.filter(([n]) => n === 'openInStash')).toEqual([]);
    expect(JSON.stringify(stash.data())).toBe(before);
  });

  it('the dialog listens for Stash changes while open and stops when it closes', async () => {
    const { done } = await open();
    expect(stash.listenerCount()).toBe(1);
    await closeAll();
    await done;
    expect(stash.listenerCount()).toBe(0);
  });
});

describe('linked', () => {
  it('shows the title, date, studio, code, rating, markers, how it was matched, the performers with their identity labels, links and the description', async () => {
    await open();
    const b = stashBlock();
    expect(b.dataset.stashState).toBe('linked');
    expect(b.querySelector('h3').textContent).toBe('Stash');
    const head = b.querySelector('.video-options-stash__title');
    expect(head.querySelector('.video-options__name').textContent).toBe('“Synthetic Scene Small”');
    expect(head.querySelector('.video-options-stash__facts').textContent).toBe('2026-11-17 · Synthetic Studio (Synthetic Network)');
    const text = lines(b);
    expect(text).toContain('code SYN-001 · rated 80/100 · organised · 2 markers');
    expect(text.some((l) => l.startsWith('matched by file fingerprint · synced '))).toBe(true);
    // Two "Jane Doe"s with different Stash IDs: the labels the chips and the
    // Tags filter show (the index's one-label pass), not two equal names.
    expect(text).toContain('Jane Doe (blonde), Jane Doe · 9c1d');
    expect(text).toContain('0:01 Synthetic marker one · 0:04 Synthetic Tag B');
    expect(b.querySelector('.video-options-stash__url-text').textContent).toBe('https://example.invalid/scenes/syn-001');
    const details = b.querySelector('details.video-options-stash__details');
    expect(details.open).toBe(false); // collapsed
    expect(details.querySelector('summary').textContent).toBe('Show description');
    expect(details.querySelector('.video-options-stash__description').textContent).toBe('A synthetic scene for the tests.');
    const buttons = [...b.querySelectorAll('.video-options__actions button')].map((x) => x.textContent);
    expect(buttons).toEqual(['Open in Stash', 'Sync this video', 'Not this scene…']);
    expect(control('stash:open').getAttribute('aria-label')).toBe('Open in Stash (opens your browser)');
  });

  it('Open in Stash asks main to open the scene (by its id, as given) and builds no URL here', async () => {
    await open();
    control('stash:open').click();
    await flush();
    expect(stash.calls.filter(([n]) => n === 'openInStash')).toEqual([['openInStash', VIDEO, '1']]);
    expect(requests(stash)).toEqual([]);
    expect(ipc.map(([k]) => k)).not.toContain('openExternal');
  });

  it('Copy next to a link copies it as text', async () => {
    await open();
    control('stash:copyUrl:0').click();
    await vi.waitFor(() => expect(liveText()).toBe('Link copied.'));
    expect(host.copyText).toHaveBeenCalledWith('https://example.invalid/scenes/syn-001');
  });

  it('another file in the library with the same content is named', async () => {
    const data = stashData({ videoPath: VIDEO });
    data.links[COPY] = { ...data.links[VIDEO] };
    setup({ data });
    await open();
    expect(lines(stashBlock())).toContain(`Another file in your library is the same video: ${COPY}`);
  });
});

describe('text from Stash is text (design (d) "Untrusted text")', () => {
  it('a title, names, a link, a description and a candidate with markup render as text', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const data = stashData({ videoPath: VIDEO });
    data.scenes[1].title = `${evil} Title`;
    data.scenes[1].details = `${evil} details`;
    data.scenes[1].urls = [`https://example.invalid/${evil}`];
    data.performers.p1.name = `${evil} Jane`;
    data.studios.s1.name = `${evil} Studio`;
    data.tags.t1.name = `${evil} tag`;
    setup({ data });
    await open();
    const b = stashBlock();
    expect(b.querySelector('img')).toBeNull();
    expect(b.querySelector('.video-options__name').textContent).toBe(`“${evil} Title”`);
    expect(b.textContent).toContain(`${evil} Jane`);
    expect(b.textContent).toContain(`${evil} Studio`);
    expect(b.textContent).toContain(`${evil} details`);
    expect(window.__pwned).toBeUndefined();
    // The Tags section's Stash row too.
    dialogBody().querySelector('.video-options__rail-item[data-section="tags"]').click();
    await vi.waitFor(() => expect(panel('tags').querySelector('.video-options-tags__source--stash')).toBeTruthy());
    expect(panel('tags').querySelector('img')).toBeNull();
    expect(panel('tags').querySelector('.video-options-tags__stash-line').textContent).toContain(`“${evil} Title”`);
  });
});

describe('Not this scene… (stacked confirm) and its exact Undo', () => {
  const ask = async () => {
    await open();
    control('stash:notThis').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    return overlays()[1];
  };

  it('Cancel changes nothing and the focus comes back', async () => {
    const before = JSON.stringify(stash.data());
    const confirm = await ask();
    expect(confirm.querySelector('.modal-message').textContent)
      .toBe('FunSync will unlink this video from “Synthetic Scene Small” and will not link this file to it again. Nothing changes in Stash.');
    confirm.querySelector('.modal-btn--secondary').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(requests(stash)).toEqual([]);
    expect(JSON.stringify(stash.data())).toBe(before);
    expect(document.activeElement).toBe(control('stash:notThis'));
  });

  it('confirmed: the link goes and that scene is refused for this file; the focus goes to Undo; Undo puts link, check and refusal back exactly', async () => {
    const before = videoEntry(stash.data(), VIDEO);
    const confirm = await ask();
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('refused'));
    // With the scene the confirm named (RA-S1-3), exactly as the view gave it.
    expect(stash.calls.find(([n]) => n === 'refuse')).toEqual(['refuse', VIDEO, 'link', '1']);
    expect(stash.data().refused[VIDEO]).toEqual({ oshash: HASH, sceneIds: ['1'], at: 1000 });
    expect(liveText()).toBe('You said this file is not “Synthetic Scene Small”.');
    expect(lines(stashBlock())).toContain('You said this file is not “Synthetic Scene Small”.');
    expect(document.activeElement).toBe(undoButton());

    undoButton().click();
    await vi.waitFor(() => expect(liveText()).toBe(t('videoOptions.live.undone')));
    const undo = stash.calls.find(([n]) => n === 'undo');
    expect(undo).toEqual(['undo', VIDEO, 'undo-1']); // main's token, given back as it came
    expect(videoEntry(stash.data(), VIDEO)).toEqual(before);
    expect(stashBlock().dataset.stashState).toBe('linked');
    expect(document.activeElement).toBe(control('stash:notThis'));
  });

  it('an Undo main cannot carry out says so (not "Undone.")', async () => {
    const confirm = await ask();
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(undoButton().hidden).toBe(false));
    stash.answers.restoreFails = true;
    undoButton().click();
    await vi.waitFor(() => expect(liveText()).toBe("Can't undo: FunSync could not change its Stash data."));
    expect(stashBlock().dataset.stashState).toBe('refused');
  });

  it('an Undo still pending when the dialog closes goes on in a toast, and restores exactly', async () => {
    const before = videoEntry(stash.data(), VIDEO);
    const { done } = await (async () => { const r = await open(); return r; })();
    control('stash:notThis').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(stash.data().refused[VIDEO]).toBeTruthy());
    await closeAll();
    await done;
    let toastUndo;
    await vi.waitFor(() => { toastUndo = document.querySelector('.video-options__toast-undo'); expect(toastUndo).toBeTruthy(); });
    toastUndo.click();
    await vi.waitFor(() => expect(videoEntry(stash.data(), VIDEO)).toEqual(before));
  });
});

describe('needs a check (design (b))', () => {
  const several = () => stashData({
    videoPath: VIDEO,
    links: {},
    check: { [VIDEO]: { kind: 'several', sceneIds: ['2', '3'], fp: { size: 1000, mtimeMs: 5, oshash: HASH }, seenAt: 9 } },
  });

  it('two scenes with this exact file: the question, a radio per scene (title, date, studio, file name; a length far off is flagged)', async () => {
    setup({ data: several() });
    await open();
    const b = stashBlock();
    expect(b.dataset.stashState).toBe('check');
    expect(lines(b)).toContain('Two Stash scenes have this exact file. Which one is it?');
    expect(b.querySelector('fieldset legend').textContent).toBe('Which Stash scene is this?');
    const radios = [...b.querySelectorAll('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(['2', '3']);
    expect(radios.map((r) => r.closest('label').querySelector('.video-options__radio-text').textContent)).toEqual([
      '“Synthetic Scene Two” · 2026-11-01 · Synthetic Studio · two.mp4',
      '“Synthetic Scene Three” · 2026-11-02 · three.mp4',
    ]);
    // 61 s against this video's 60 s: within 2 s; 75 s: flagged.
    expect(radios[0].closest('label').querySelector('.video-options__tag--warn')).toBeNull();
    expect(radios[1].closest('label').querySelector('.video-options__tag--warn').textContent).toBe('length differs by 15 s');
    expect(control('stash:use').disabled).toBe(true); // nothing picked yet
    expect(control('stash:none').textContent).toBe('None of these');
  });

  it('Use this scene links the scene you picked (not the first), with an exact Undo', async () => {
    setup({ data: several() });
    const before = videoEntry(stash.data(), VIDEO);
    await open();
    const second = stashBlock().querySelectorAll('input[type="radio"]')[1];
    second.click();
    expect(control('stash:use').disabled).toBe(false);
    control('stash:use').click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('linked'));
    expect(stash.calls.find(([n]) => n === 'choose')).toEqual(['choose', VIDEO, '3']);
    expect(stash.data().links[VIDEO]).toMatchObject({ sceneId: '3', by: 'chosen' });
    expect(liveText()).toBe('Linked this video to “Synthetic Scene Three”.');
    expect(lines(stashBlock()).some((l) => l.startsWith('chosen by you'))).toBe(true);
    expect(document.activeElement).toBe(undoButton());
    undoButton().click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('check'));
    expect(videoEntry(stash.data(), VIDEO)).toEqual(before);
  });

  it('None of these refuses every candidate for this file, with an exact Undo', async () => {
    setup({ data: several() });
    const before = videoEntry(stash.data(), VIDEO);
    await open();
    control('stash:none').click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('refused'));
    expect(stash.calls.find(([n]) => n === 'refuse')).toEqual(['refuse', VIDEO, 'check']);
    expect(liveText()).toBe('None of these scenes will be offered for this file again.');
    expect(lines(stashBlock())).toContain('You said this file is none of the 2 Stash scenes offered for it.');
    undoButton().click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('check'));
    expect(videoEntry(stash.data(), VIDEO)).toEqual(before);
  });

  it('same path, other content: Use it anyway (the one candidate) or Ignore', async () => {
    setup({
      data: stashData({
        videoPath: VIDEO,
        links: {},
        check: { [VIDEO]: { kind: 'pathChanged', sceneIds: ['2'], fp: { size: 1000, mtimeMs: 5, oshash: OTHER_HASH }, seenAt: 9 } },
      }),
    });
    await open();
    expect(lines(stashBlock())).toContain('Stash has a file at this path, but it is not the same file. It changed after Stash last scanned it.');
    expect(control('stash:use').textContent).toBe('Use it anyway');
    expect(control('stash:use').disabled).toBe(false);
    expect(control('stash:none').textContent).toBe('Ignore');
    control('stash:use').click();
    await vi.waitFor(() => expect(stash.data().links[VIDEO]?.sceneId).toBe('2'));
  });

  it('opened from Settings\' Choose… (section file, focusKey stash:choice): the focus is on the first choice', async () => {
    setup({ data: several() });
    await open({ section: 'file', focusKey: 'stash:choice' });
    await vi.waitFor(() => expect(document.activeElement).toBe(stashBlock().querySelector('input[type="radio"]')));
  });
});

describe('gone, changed, from another Stash', () => {
  it('gone: says so, keeps the scene\'s facts, and offers Unlink (with an exact Undo)', async () => {
    const data = stashData({ videoPath: VIDEO });
    data.links[VIDEO].state = 'gone';
    setup({ data });
    const before = videoEntry(stash.data(), VIDEO);
    await open();
    const b = stashBlock();
    expect(b.dataset.stashState).toBe('gone');
    expect(lines(b)).toContain('This scene is gone from Stash. Its data is kept.');
    expect(b.querySelector('.video-options__name').textContent).toBe('“Synthetic Scene Small”');
    expect(control('stash:open')).toBeNull();
    control('stash:unlink').click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('notInStash'));
    expect(liveText()).toBe('Unlinked this video from “Synthetic Scene Small”.');
    undoButton().click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('gone'));
    expect(videoEntry(stash.data(), VIDEO)).toEqual(before);
  });

  it('changed (the scanned size differs from the link\'s): its data is hidden, the record is kept', async () => {
    setup({ size: 2000 });
    await open();
    const b = stashBlock();
    expect(b.dataset.stashState).toBe('changed');
    expect(lines(b)).toContain('This file changed since it was matched. Its Stash data is hidden until the next sync.');
    expect(b.textContent).not.toContain('Jane Doe');
    expect(b.textContent).not.toContain('SYN-001');
    expect([...b.querySelectorAll('.video-options__actions button')].map((x) => x.textContent)).toEqual(['Sync this video', 'Unlink']);
    expect(stash.data().links[VIDEO]).toBeTruthy();
  });

  it('a link made with your other Stash says so and keeps its data; Open in Stash hands main the id exactly as stored', async () => {
    const data = stashData({ videoPath: VIDEO });
    const id = `1@${OLD_SERVER}`;
    data.scenes[id] = { ...data.scenes[1], id, server: OLD_SERVER };
    data.links[VIDEO] = { ...data.links[VIDEO], sceneId: id, server: OLD_SERVER };
    setup({ data });
    await open();
    const b = stashBlock();
    expect(lines(b)).toContain(`From your other Stash (${OLD_SERVER}).`);
    expect(b.querySelector('.video-options__name').textContent).toBe('“Synthetic Scene Small”');
    control('stash:open').click();
    await flush();
    expect(stash.calls.filter(([n]) => n === 'openInStash')).toEqual([['openInStash', VIDEO, id]]);
    expect(control('stash:notThis')).toBeNull();
    expect(control('stash:unlink')).toBeTruthy();
  });

  it('a stored scene from another server than the link\'s is not shown as this link\'s scene', async () => {
    const data = stashData({ videoPath: VIDEO });
    data.scenes[1].server = OLD_SERVER; // same id, another server
    setup({ data });
    await open();
    const b = stashBlock();
    expect(b.textContent).not.toContain('Synthetic Scene Small');
    expect(b.querySelector('.video-options__name').textContent).toBe('Scene 1');
    expect(control('stash:open')).toBeNull();
  });
});

describe('not linked', () => {
  it('no sync yet: says so, with Find in Stash… and Sync this video', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {}, lastSync: false }) });
    await open();
    expect(stashBlock().dataset.stashState).toBe('notSynced');
    expect(lines(stashBlock())).toContain('FunSync has not synced with Stash yet.');
    expect([...stashBlock().querySelectorAll('.video-options__actions button')].map((x) => x.textContent))
      .toEqual(['Find in Stash…', 'Sync this video']);
  });

  it('synced and not found: "Not found in Stash."', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {} }) });
    await open();
    expect(stashBlock().dataset.stashState).toBe('notInStash');
    expect(lines(stashBlock())).toContain('Not found in Stash.');
  });

  it('refused earlier: names the scene, and Find in Stash… is there', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {}, refused: { [VIDEO]: { oshash: HASH, sceneIds: ['1'], at: 5 } } }) });
    await open();
    expect(lines(stashBlock())).toContain('You said this file is not “Synthetic Scene Small”.');
    expect(control('stash:find')).toBeTruthy();
  });
});

describe('Sync this video', () => {
  it('one request for this video; the block shows what main found', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {} }) });
    stash.answers.syncVideo = (data, path, { changed }) => {
      data.links[path] = { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 5, oshash: HASH }, linkedAt: 50, state: 'ok' };
      changed();
      return { ok: true, kind: 'video', written: true, counts: { linked: 1 }, relinked: [] };
    };
    await open();
    control('stash:sync').click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('linked'));
    expect(requests(stash)).toEqual([['syncVideo', VIDEO]]);
    expect(liveText()).toBe('Synced. This video is “Synthetic Scene Small” in Stash.');
  });

  it('one at a time: a second press while it runs sends nothing', async () => {
    let finish;
    stash.answers.syncVideo = () => new Promise((r) => { finish = r; });
    await open();
    control('stash:sync').click();
    await vi.waitFor(() => expect(control('stash:sync').getAttribute('aria-disabled')).toBe('true'));
    expect(control('stash:sync').textContent).toBe('Syncing…');
    control('stash:sync').click();
    control('stash:notThis').click();
    await flush();
    expect(requests(stash)).toEqual([['syncVideo', VIDEO]]);
    expect(overlays()).toHaveLength(1);
    finish({ ok: true, kind: 'video', written: false, counts: {}, relinked: [] });
    await vi.waitFor(() => expect(control('stash:sync').getAttribute('aria-disabled')).toBeNull());
  });

  it('Stash not running: the reason in words (with the address), every stored fact still shown, nothing changed', async () => {
    const before = JSON.stringify(stash.data());
    stash.answers.failNext = { name: 'syncVideo', reply: { ok: false, kind: 'video', written: false, error: { code: 'unreachable' } } };
    await open();
    control('stash:sync').click();
    const words = `Can't reach Stash at ${SERVER}. Is it running?`;
    await vi.waitFor(() => expect(liveText()).toBe(words));
    const b = stashBlock();
    expect(b.querySelector('.video-options-stash__error').textContent).toBe(words);
    expect(b.dataset.stashState).toBe('linked');
    expect(b.querySelector('.video-options__name').textContent).toBe('“Synthetic Scene Small”');
    expect(lines(b)).toContain('Jane Doe (blonde), Jane Doe · 9c1d');
    expect(JSON.stringify(stash.data())).toBe(before);
    expect(document.activeElement).toBe(control('stash:sync'));
  });

  it('each failure has its own words: the file offline, a sync already running, a timeout, an unknown code', async () => {
    await open();
    const cases = [
      [{ ok: false, skipped: true, error: { code: 'skipped' } }, "FunSync could not read this video's file (its drive may be offline). Nothing was changed."],
      [{ ok: false, error: { code: 'busy' } }, 'Stash is syncing already. Try again when it ends.'],
      [{ ok: false, code: 'timeout' }, 'Stash did not answer in time.'],
      [{ ok: false, code: 'tooOld', version: '0.25.1', minVersion: '0.27.0' }, 'This Stash (v0.25.1) is too old. FunSync needs v0.27.0 or newer.'],
      [{ ok: false, error: { code: 'http', status: 502 } }, 'Stash answered with an error (HTTP 502).'],
      [{ ok: false, code: 'somethingNew' }, 'Stash could not be asked. Nothing was changed.'],
    ];
    for (const [reply, words] of cases) {
      stash.answers.failNext = { name: 'syncVideo', reply };
      control('stash:sync').click();
      await vi.waitFor(() => expect(stashBlock().querySelector('.video-options-stash__error')?.textContent).toBe(words));
    }
  });

  it('a re-link to a new unique match comes with an exact Undo', async () => {
    let before;
    stash.answers.syncVideo = (data, path, { keep, changed }) => {
      before = videoEntry(data, path);
      const undoId = keep(path);
      data.links[path] = { ...data.links[path], sceneId: '2', linkedAt: 60 };
      changed();
      return { ok: true, kind: 'video', written: true, counts: {}, relinked: [{ path, from: '1', to: '2', undoId }] };
    };
    await open();
    control('stash:sync').click();
    await vi.waitFor(() => expect(liveText()).toBe('This file is now linked to “Synthetic Scene Two”.'));
    expect(undoButton().hidden).toBe(false);
    undoButton().click();
    await vi.waitFor(() => expect(stash.data().links[VIDEO].sceneId).toBe('1'));
    expect(videoEntry(stash.data(), VIDEO)).toEqual(before);
  });
});

describe('Find in Stash… (a search per press, link only)', () => {
  const RESULTS = {
    ok: true,
    count: 2,
    scenes: [
      { id: '2', title: 'Synthetic Scene Two', code: null, date: '2026-11-01', studio: { id: 's1', name: 'Synthetic Studio' }, files: [{ name: 'two.mp4', size: 1000, duration: 61 }] },
      { id: '3', title: 'Synthetic Scene Three', code: 'SYN-003', date: '2026-11-02', studio: null, files: [{ name: 'three.mp4', size: 1000, duration: 75 }] },
    ],
  };

  it('stacks the picker; nothing is sent until Search; picking links that scene once (no sync); Undo puts it back exactly', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {} }) });
    stash.answers.search = () => RESULTS;
    const before = videoEntry(stash.data(), VIDEO);
    await open();
    control('stash:find').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    const picker = overlays()[1];
    const input = picker.querySelector('.stash-picker__input');
    expect(input.value).toBe('Square Clip');
    input.value = 'Synthetic';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(requests(stash)).toEqual([]); // never as you type
    picker.querySelector('.stash-picker__go').click();
    await vi.waitFor(() => expect(picker.querySelectorAll('.stash-picker__result')).toHaveLength(2));
    expect(requests(stash)).toEqual([['search', 'Synthetic']]);
    picker.querySelectorAll('.stash-picker__link')[1].click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('linked'));
    expect(requests(stash)).toEqual([['search', 'Synthetic'], ['link', VIDEO, '3']]);
    expect(stash.data().links[VIDEO]).toMatchObject({ sceneId: '3', by: 'manual' });
    expect(liveText()).toBe('Linked this video to “Synthetic Scene Three”.');
    expect(lines(stashBlock()).some((l) => l.startsWith('linked by you'))).toBe(true);
    expect(document.activeElement).toBe(undoButton());
    undoButton().click();
    await vi.waitFor(() => expect(stashBlock().dataset.stashState).toBe('notInStash'));
    expect(videoEntry(stash.data(), VIDEO)).toEqual(before);
  });

  it('closing the picker links nothing; the focus comes back to Find in Stash…', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {} }) });
    await open();
    control('stash:find').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-close-btn').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    await flush();
    expect(requests(stash)).toEqual([]);
    expect(document.activeElement).toBe(control('stash:find'));
  });

  it('a failed search says why in the picker; nothing is linked', async () => {
    setup({ data: stashData({ videoPath: VIDEO, links: {} }) });
    stash.answers.search = () => ({ ok: false, code: 'unreachable' });
    await open();
    control('stash:find').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.stash-picker__go').click();
    await vi.waitFor(() => expect(overlays()[1].querySelector('.stash-picker__status').textContent).toBe(`Can't reach Stash at ${SERVER}. Is it running?`));
    expect(requests(stash).map(([n]) => n)).toEqual(['search']);
  });
});

describe('the Tags section\'s Stash row and chips', () => {
  const openTags = async () => {
    await open({ section: 'tags' });
    await vi.waitFor(() => expect(panel('tags').querySelector('.video-options-tags')).toBeTruthy());
  };

  it('Where they came from: Stash, the scene, its counts and the sync date, with Open in Stash', async () => {
    await openTags();
    const row = panel('tags').querySelector('.video-options-tags__source--stash');
    expect(row.querySelector('.video-options-tags__source-name').textContent).toBe('Stash');
    const line = row.querySelector('.video-options-tags__stash-line').textContent;
    expect(line.startsWith('“Synthetic Scene Small” · 2 tags, 2 performers, 1 studio · synced ')).toBe(true);
    row.querySelector('[data-vo-focus="tags:stashOpen"]').click();
    await flush();
    expect(stash.calls.filter(([n]) => n === 'openInStash')).toEqual([['openInStash', VIDEO, '1']]);
  });

  it('the chips carry the Stash source (a Stash "POV" and your "pov" are one chip), and the rail counts them', async () => {
    setup({ library: { userTags: { [VIDEO]: ['pov'] } } });
    await openTags();
    const chips = [...panel('tags').querySelectorAll('.video-options-tags__chip')];
    const pov = chips.find((c) => c.dataset.tagKey === 'content:pov');
    expect(pov.querySelector('.video-options-tags__chip-sources').textContent).toBe('you, Stash');
    const keys = chips.map((c) => c.dataset.tagKey);
    expect(keys.filter((k) => k.startsWith('performer:jane-doe#'))).toHaveLength(2);
    expect(keys).toContain('studio:synthetic-studio');
    expect(Number(dialogBody().querySelector('.video-options__rail-count').textContent)).toBe(chips.length);
  });

  it('removing a chip Stash gives hides it on this video; the Stash data is not touched', async () => {
    const before = JSON.stringify(stash.data());
    await openTags();
    const chip = [...panel('tags').querySelectorAll('.video-options-tags__chip')].find((c) => c.dataset.tagKey === 'content:pov');
    chip.querySelector('.video-options-tags__chip-remove').click();
    await vi.waitFor(() => expect(ds.get('library.hiddenTags')?.[VIDEO]).toEqual(['content:pov']));
    expect(JSON.stringify(stash.data())).toBe(before);
    expect(requests(stash)).toEqual([]);
  });

  it('a bare name you typed joins the one Stash identity: one chip, and removing it removes your copy too', async () => {
    const data = stashData({ videoPath: VIDEO });
    data.performers.p2 = { id: 'p2', name: 'Ann Lee', disambiguation: null, stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: 'CCCC-1111' }] };
    setup({ data, library: { userTags: { [VIDEO]: ['performer:Ann Lee'] } } });
    await openTags();
    const chips = [...panel('tags').querySelectorAll('.video-options-tags__chip')];
    const ann = chips.filter((c) => c.dataset.tagKey.startsWith('performer:ann-lee'));
    expect(ann).toHaveLength(1);
    expect(ann[0].dataset.tagKey).toBe('performer:ann-lee#cccc-1111');
    expect(ann[0].querySelector('.video-options-tags__chip-sources').textContent).toBe('you, Stash');
    ann[0].querySelector('.video-options-tags__chip-remove').click();
    await vi.waitFor(() => expect(ds.get('library.userTags')?.[VIDEO] || []).toEqual([]));
    expect(ds.get('library.hiddenTags')?.[VIDEO]).toEqual(['performer:ann-lee#cccc-1111']);
  });

  it('a changed file: the row says its Stash tags are hidden; no Stash chips', async () => {
    setup({ size: 2000 });
    await openTags();
    const row = panel('tags').querySelector('.video-options-tags__source--stash');
    expect(row.querySelector('.video-options-tags__stash-line').textContent)
      .toBe('“Synthetic Scene Small” · this file changed; its Stash tags are hidden until the next sync');
    expect(row.querySelector('[data-vo-focus="tags:stashOpen"]')).toBeNull();
    expect(panel('tags').querySelector('.video-options-tags__chip')).toBeNull();
  });

  it('a change main reports (a sync from Settings) redraws the open Tags section and File block', async () => {
    await openTags();
    expect(panel('tags').querySelector('.video-options-tags__source--stash')).toBeTruthy();
    const next = stashData({ videoPath: VIDEO, links: {} });
    stash.raw = next; // main wrote; the store reported it
    await vi.waitFor(() => expect(panel('tags').querySelector('.video-options-tags__source--stash')).toBeNull());
    expect(panel('tags').querySelector('.video-options-tags__chip')).toBeNull();
  });
});
