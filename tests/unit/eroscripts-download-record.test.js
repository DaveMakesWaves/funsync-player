/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL EroScriptsPanel builds its DOM, library.js and
 * the panel import i18n.js, which branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// What an EroScripts download records about its post (review-b RB-2,
// fixup-data 2026-11-18; video options design (c)). Both download paths, the
// panel's Get Script and the Associate dialog's search (library.js), save the
// record WITH the script they saved (for a multi-axis set, the main script)
// and with the topic JSON's own tags, title and creator, which
// getTopicAttachments returns at no extra request. A record without the
// script read as "whatever script the video has now": pairing another script
// by hand kept the old post's tags on it and offered Get tags for it.
// Fakes: the IPC (no forum), the store (a map).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
// The Associate search is the user's picks; the library's writer is what is
// tested here.
const picked = { value: null };
vi.mock('../../renderer/components/eroscripts-inline-search.js', () => ({
  showEroScriptsSearchModal: vi.fn(async () => picked.value),
}));

const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const { Library } = await import('../../renderer/components/library.js');
const { SCRIPT_TAGS_KEY, recordDownloadTags, getScriptTags, sameScriptPath } = await import('../../renderer/js/script-tags.js');
const { resolveTopic } = await import('../../renderer/js/eroscripts-tag-fetch.js');
const { effectiveTags } = await import('../../renderer/js/video-tags.js');
const { eroscriptsRecordForTags } = await import('../../renderer/js/video-options-model.js');

const VIDEO = 'C:/v/Scene.mp4';
const SAVED = 'C:/v/Scene.funscript';
const HAND_PICKED = 'C:/v/hand-picked.funscript';
// A search result (the panel's and the Associate search's `topic`).
const SEARCH = { id: 7, title: 'Post A (search)', url: 'https://discuss.eroscripts.com/t/a/7', creator: 'searchname', tags: ['pov', 'the-handy'] };
// getTopicAttachments' answer: the post's own tags with ids, title, creator.
const TOPIC_ANSWER = {
  attachments: [{ name: 'Post A.funscript', url: 'https://discuss.eroscripts.com/uploads/a.funscript' }],
  topicId: 7, url: 'https://discuss.eroscripts.com/t/post-a/7', title: 'Post A', creator: 'Ramie',
  tags: [{ id: 1, name: 'pov' }, { id: 2, name: 'the-handy' }, { id: 3, name: 'vr' }],
};

function makeSettings(initial = {}) {
  const store = structuredClone(initial);
  return { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }), _store: store };
}

describe('recordDownloadTags (script-tags.js)', () => {
  it('names the script saved and takes the topic JSON\'s tags, title and creator', () => {
    const s = makeSettings();
    expect(recordDownloadTags(s, VIDEO, { topic: SEARCH, answer: TOPIC_ANSWER, scriptPath: SAVED, now: 5 })).toBe(true);
    expect(getScriptTags(s, VIDEO)).toEqual({
      tags: TOPIC_ANSWER.tags, topicId: 7, topicUrl: TOPIC_ANSWER.url, title: 'Post A', creator: 'Ramie',
      scriptPath: SAVED, match: 'download', source: 'eroscripts', savedAt: 5, fetchedAt: 5, stale: false,
    });
  });

  it('an answer about another post, or one that did not list tags, leaves the search result\'s', () => {
    const s = makeSettings();
    recordDownloadTags(s, VIDEO, { topic: SEARCH, answer: { ...TOPIC_ANSWER, topicId: 8 }, scriptPath: SAVED, now: 5 });
    expect(getScriptTags(s, VIDEO)).toMatchObject({ tags: SEARCH.tags, title: SEARCH.title, creator: 'searchname', fetchedAt: null, scriptPath: SAVED });
    recordDownloadTags(s, VIDEO, { topic: SEARCH, answer: { ...TOPIC_ANSWER, tags: null }, scriptPath: SAVED, now: 6 });
    expect(getScriptTags(s, VIDEO)).toMatchObject({ tags: SEARCH.tags, title: 'Post A', fetchedAt: null });
  });

  it('not told the script, it is the video\'s same-name file (what every download saves); never none', () => {
    const s = makeSettings();
    recordDownloadTags(s, 'C:\\v\\My.Scene.mp4', { topic: SEARCH });
    expect(getScriptTags(s, 'C:\\v\\My.Scene.mp4').scriptPath).toBe('C:\\v\\My.Scene.funscript');
  });
});

describe('the EroScripts panel\'s Get Script', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    window.funsync = {
      eroscriptsRestoreSession: vi.fn(async () => {}),
      eroscriptsValidate: vi.fn(async () => ({ valid: true })),
      eroscriptsCheckSession: vi.fn(async () => ({ state: 'valid' })),
      eroscriptsTopic: vi.fn(async () => structuredClone(TOPIC_ANSWER)),
      eroscriptsDownload: vi.fn(async () => ({ success: true })),
      readFunscript: vi.fn(async () => null),
    };
  });
  afterEach(() => { delete window.funsync; document.body.innerHTML = ''; });

  it('records the post against the open video WITH the script it saved; after a hand-picked script, Get tags is not offered and its tags do not show', async () => {
    const settings = makeSettings({ 'eroscripts.session': { cookie: 'TESTKEY01', username: 'tester' }, 'library.sources': [] });
    const panel = new EroScriptsPanel({ settings });
    panel._setLoggedIn('tester');
    panel.getOpenVideoPath = () => VIDEO;
    const row = document.createElement('div');
    const btn = document.createElement('button');
    row.appendChild(btn);
    document.body.appendChild(row);

    await panel._downloadFromTopic(structuredClone(SEARCH), btn);

    const writes = window.funsync.eroscriptsDownload.mock.calls.filter(([, , opts]) => !opts?.checkOnly);
    expect(writes).toHaveLength(1);
    const savePath = writes[0][1];
    expect(sameScriptPath(savePath, SAVED)).toBe(true);
    const record = settings._store[SCRIPT_TAGS_KEY][VIDEO];
    expect(record).toMatchObject({ scriptPath: savePath, match: 'download', topicId: 7, title: 'Post A', creator: 'Ramie', tags: TOPIC_ANSWER.tags });
    expect(Number.isFinite(record.fetchedAt)).toBe(true);

    // On the script it saved: known. On one you picked since: another script's post.
    expect(resolveTopic({ record, scriptPath: SAVED, videoPath: VIDEO })).toMatchObject({ state: 'known', topicId: 7 });
    expect(resolveTopic({ record, scriptPath: HAND_PICKED, videoPath: VIDEO }).state).toBe('otherScript');
    const shown = (scriptPath) => effectiveTags(VIDEO, { eroscripts: { [VIDEO]: eroscriptsRecordForTags(record, scriptPath) } }, { scriptPath: scriptPath || undefined });
    expect(shown(SAVED).length).toBeGreaterThan(0);
    expect(shown(HAND_PICKED)).toEqual([]);
    expect(shown(null)).toEqual([]); // after an Unpair that leaves no script
  });
});

describe('the Associate dialog\'s EroScripts search (library.js)', () => {
  // Paths apart from the video's same-name file (the default when no script
  // is given), so the tests tell "the writer named it" from the default.
  const MAIN = 'C:/v/sets/Scene.funscript';
  function fakeLibrary(settings) {
    const lib = Object.create(Library.prototype);
    lib._settings = settings;
    lib.registerFunscripts = vi.fn();
    lib._applyAssociation = vi.fn();
    lib._applyMultiAxisAssociation = vi.fn();
    lib.onEroDownloadWritten = null;
    lib.confirmBeforeEroDownload = null;
    return lib;
  }

  it('a single script: the record names the script saved, with the topic JSON\'s tags', async () => {
    const settings = makeSettings();
    picked.value = {
      mode: 'single', path: MAIN, name: 'Scene.funscript', topic: structuredClone(SEARCH),
      topicAnswer: { topicId: 7, url: TOPIC_ANSWER.url, title: 'Post A', creator: 'Ramie', tags: TOPIC_ANSWER.tags }, written: [MAIN],
    };
    await fakeLibrary(settings)._eroScriptsSearchFlow({ path: VIDEO, name: 'Scene.mp4' }, null);
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ scriptPath: MAIN, tags: TOPIC_ANSWER.tags, title: 'Post A', creator: 'Ramie', match: 'download' });
  });

  it('a multi-axis set: the record names its MAIN script', async () => {
    const settings = makeSettings();
    picked.value = {
      mode: 'multi', main: MAIN, axes: { R1: 'C:/v/sets/Scene.roll.funscript' }, topic: structuredClone(SEARCH), topicAnswer: null, written: [MAIN],
    };
    await fakeLibrary(settings)._eroScriptsSearchFlow({ path: VIDEO, name: 'Scene.mp4' }, null);
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ scriptPath: MAIN, tags: SEARCH.tags, title: SEARCH.title });
  });
});
