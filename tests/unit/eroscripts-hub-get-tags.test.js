/**
 * @vitest-environment jsdom
 * jsdom on purpose: the Tags section builds its DOM in the document, stacks
 * the REAL Modal and the link-only search, and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Get tags from EroScripts and a creator's INDEX / hub post (found
// 2026-11-19 by Dave: "all posts have a few [tags] so if you managed to get
// the creator name there must be some tags?"). A script's own metadata link
// can point at its creator's "Script Index" / "Content Hub" post, which has
// no tags or catalogue-wide ones. Such a post is never the video's post
// unless you picked it: the video counts as not linked, Find the post
// searches by the video's name with that creator's posts first, and a
// record saved earlier about the hub gives no tags and is replaced by the
// next post you link.
//
// What runs for real: the Get tags engine and its queue, the record writers
// (script-tags.js), the tag merge and the library index, the Tags section,
// Modal and the inline search in link-only mode. Fakes: a small forum (topic
// JSON and search, invented posts; no forum is ever contacted), DataService
// (a map), the login and the session check.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { mountTagsSection, _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');
const { TagFetchQueue, resolveTopic, getTagsForVideo, outcomeText, FETCH_KEYS } = await import('../../renderer/js/eroscripts-tag-fetch.js');
const { _forgetLearnedHubsForTests, KNOWN_HUB_TOPICS } = await import('../../renderer/js/eroscripts-hub.js');
const { SCRIPT_TAGS_KEY } = await import('../../renderer/js/script-tags.js');
const { funscriptMetaRecord } = await import('../../renderer/js/video-tags.js');
const { eroscriptsRecordForTags } = await import('../../renderer/js/video-options-model.js');
const { buildLibraryTagIndex } = await import('../../renderer/js/library-tag-filter.js');

// The words the assertions read (the merge adds the two new ones to the
// locales: SCRATCH/hub-fix/strings.json).
const STRINGS = {
  'videoOptions.tags.fetch.hub': "That post is its creator's script index, not this video's own post, so its tags were not used. Find this video's post to get its tags.",
  'videoOptions.tags.fetch.hubNote': "The script links to its creator's script index, not to this video's own post",
};
function bundle() {
  const b = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
  for (const [key, value] of Object.entries(STRINGS)) {
    const parts = key.split('.');
    let o = b;
    for (const p of parts.slice(0, -1)) {
      if (!o[p] || typeof o[p] !== 'object') o[p] = {};
      o = o[p];
    }
    o[parts.at(-1)] = value;
  }
  return b;
}
const EN = bundle();

// ---- the fake forum (invented creators and posts) ----

const HUB_ID = 900001;      // "Testmaker - Script Index": lists every script Testmaker made
const POST_ID = 900002;     // the video's own post, by Testmaker
const OTHER_ID = 900003;    // a post of the same name by someone else
const BARE_HUB_ID = 900009; // a hub whose link in the metadata has no slug
const T = (slug, id) => `https://discuss.eroscripts.com/t/${slug}/${id}`;
const HUB_URL = T('testmaker-script-index', HUB_ID);
const HUB_TAGS = [{ id: 70, name: 'pmv' }, { id: 71, name: 'hmv' }, { id: 72, name: 'fap-hero' }];
const POST_TAGS = [{ id: 1, name: 'pov' }, { id: 2, name: 'the-handy' }];

function fakeForum() {
  const topics = new Map([
    [HUB_ID, {
      topicId: HUB_ID, slug: 'testmaker-script-index', url: HUB_URL, title: 'Testmaker - Script Index',
      creator: 'Testmaker', tags: HUB_TAGS, status: 'open', body: 'Lumen Rooftop Sunset, Harbor Night',
    }],
    [POST_ID, {
      topicId: POST_ID, slug: 'lumen-rooftop-sunset', url: T('lumen-rooftop-sunset', POST_ID), title: 'Lumen Rooftop Sunset',
      creator: 'Testmaker', tags: POST_TAGS, status: 'open', body: '',
    }],
    [OTHER_ID, {
      topicId: OTHER_ID, slug: 'lumen-rooftop-sunset-alt-cut', url: T('lumen-rooftop-sunset-alt-cut', OTHER_ID),
      title: 'Lumen Rooftop Sunset (alt cut)', creator: 'Otherscripter', tags: [{ id: 3, name: 'vr' }], status: 'open', body: '',
    }],
    [BARE_HUB_ID, {
      topicId: BARE_HUB_ID, slug: 'testmaker-content-hub', url: T('testmaker-content-hub', BARE_HUB_ID), title: 'Testmaker Content Hub',
      creator: 'Testmaker', tags: [{ id: 80, name: 'compilation' }], status: 'open', body: '',
    }],
  ]);
  const meta = ({ body, ...rest }) => structuredClone(rest);
  // main's getTopicMeta: one topic's JSON, read.
  const topicMeta = vi.fn(async (id) => (topics.has(id)
    ? { ok: true, outcome: 'ok', status: 200, meta: meta(topics.get(id)) }
    : { ok: false, outcome: 'notFound', status: 404, error: 'Topic not found', errorCode: 'notFound' }));
  // main's search: every word in the title or the first post; the hub (most
  // liked) first, as the forum ranks it.
  const search = vi.fn(async (query) => {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (t) => words.every((w) => t.title.toLowerCase().includes(w) || t.body.toLowerCase().includes(w));
    const results = [HUB_ID, OTHER_ID, POST_ID].map((id) => topics.get(id)).filter(hit).map((t) => ({
      id: t.topicId, title: t.title, url: t.url, creator: t.creator, tags: t.tags.map((x) => x.name),
      likeCount: t.topicId === HUB_ID ? 500 : 3,
    }));
    return { results };
  });
  return { topicMeta, search };
}

// ---- the library ----

const VIDEO = 'C:/lib/Lumen Rooftop Sunset.mp4';
const SCRIPT = 'C:/lib/Lumen Rooftop Sunset.funscript';
const LONELY_VIDEO = 'C:/lib/Harbor Night.mp4';
const LONELY_SCRIPT = 'C:/lib/Harbor Night.funscript';
// The script's own metadata, as a creator's tool writes it: its creator and
// the creator's index post as its script_url.
const hubMeta = (url = HUB_URL) => funscriptMetaRecord({ creator: 'Testmaker', title: 'Lumen Rooftop Sunset', script_url: url }, 0);
// A record a Get tags of that link saved before this fix.
const SAVED_HUB_RECORD = Object.freeze({
  tags: HUB_TAGS, topicId: HUB_ID, topicUrl: HUB_URL, title: 'Testmaker - Script Index', creator: 'Testmaker',
  scriptPath: SCRIPT, match: 'script_url', source: 'eroscripts', savedAt: 5, fetchedAt: 5, stale: false,
});

function makeDs(settings = {}) {
  const store = structuredClone(settings);
  return {
    _store: store,
    get: (key) => store[key],
    set: vi.fn((key, value) => { store[key] = value; }),
    getCategories: () => [],
    getVideoCategories: () => [],
    getAllVideoCategories: () => ({}),
  };
}
const queueWith = (topicMeta) => new TagFetchQueue({ topicMeta, minGapMs: 0 });

const handles = [];
function mount({ ds, forum, video, scriptMeta }) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ctx = {
    video,
    dataService: ds,
    getLibraryVideos: () => [video],
    onDataChanged: vi.fn(),
    announce: vi.fn(),
    modalBody: document.body,
    tagQueue: queueWith(forum.topicMeta),
    getScriptMeta: () => scriptMeta,
    eroscripts: {
      isLoggedIn: vi.fn(async () => true),
      login: vi.fn(async () => true),
      sessionExpired: vi.fn(async () => 'valid'),
      checkSession: vi.fn(async () => 'valid'),
    },
  };
  const handle = mountTagsSection(host, ctx);
  handles.push(handle);
  return { host, ctx };
}

const byFocus = (host, key) => host.querySelector(`[data-vo-focus="${key}"]`);
const chipKeys = (host) => [...host.querySelectorAll('.video-options-tags__chip')].map((li) => li.dataset.tagKey);
const eroChips = (host) => [...host.querySelectorAll('.video-options-tags__chip')]
  .filter((li) => li.textContent.includes('EroScripts')).map((li) => li.dataset.tagKey);
const hubTagShown = (keys) => keys.some((k) => /pmv|hmv|fap-hero|compilation/.test(k));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const topOverlay = () => overlays().at(-1) || null;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 4) {
  for (let i = 0; i < times; i++) await flush();
}
const sourceNote = (host) => host.querySelector('.video-options-tags__source--eroscripts .video-options__note')?.textContent ?? null;

/** Find the post… → Search (the field holds the video's name) → the titles in the order shown. */
async function findThePost(host) {
  byFocus(host, 'tags:findPost').click();
  await vi.waitFor(() => expect(topOverlay()?.querySelector('.eroscripts-panel__search-input')).toBeTruthy());
  await settle();
  topOverlay().querySelector('.eroscripts-panel__btn').click();
  await vi.waitFor(() => expect(topOverlay().querySelector('.eroscripts-inline__results .eroscripts-inline__result, .eroscripts-panel__no-results')).toBeTruthy());
  return [...topOverlay().querySelectorAll('.eroscripts-inline__result .eroscripts-panel__result-title')].map((n) => n.textContent);
}

let savedFunsync;
let forum;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetTagsSectionForTests();
  _forgetLearnedHubsForTests();
  savedFunsync = window.funsync;
  forum = fakeForum();
  window.funsync = {
    ...savedFunsync,
    eroscriptsSearch: forum.search,
    eroscriptsTopic: vi.fn(),
    eroscriptsDownload: vi.fn(),
  };
  document.body.innerHTML = '<div id="toast-container"></div>';
});
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  for (const o of overlays().reverse()) o.querySelector('.modal-close-btn')?.click();
  window.funsync = savedFunsync;
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

describe('resolveTopic: a hub you did not pick is not the video\'s post', () => {
  it('the script\'s own link to its creator\'s index: none, and it says which post it passed over', () => {
    expect(resolveTopic({ scriptPath: SCRIPT, scriptMeta: hubMeta(), videoPath: VIDEO }))
      .toEqual({ state: 'none', hub: { topicId: HUB_ID, from: 'metadata', creator: 'Testmaker' } });
    // A known hub by id, with a bare /t/<id> link (no slug to read).
    const bare = funscriptMetaRecord({ script_url: `https://discuss.eroscripts.com/t/${KNOWN_HUB_TOPICS[0]}` }, 0);
    expect(resolveTopic({ scriptPath: SCRIPT, scriptMeta: bare })).toMatchObject({ state: 'none', hub: { topicId: KNOWN_HUB_TOPICS[0] } });
  });

  it('a saved record about the hub counts as not linked (never "the post is for another script")', () => {
    expect(resolveTopic({ record: SAVED_HUB_RECORD, scriptPath: SCRIPT, scriptMeta: hubMeta(), videoPath: VIDEO }))
      .toEqual({ state: 'none', hub: { topicId: HUB_ID, from: 'record', creator: 'Testmaker' } });
    expect(resolveTopic({ record: { ...SAVED_HUB_RECORD, match: 'download' }, scriptPath: SCRIPT, videoPath: VIDEO }))
      .toMatchObject({ state: 'none', hub: { from: 'record' } });
  });

  it('...and the script\'s own link to its real post beats it', () => {
    const own = funscriptMetaRecord({ topic_url: T('lumen-rooftop-sunset', POST_ID) }, 0);
    expect(resolveTopic({ record: SAVED_HUB_RECORD, scriptPath: SCRIPT, scriptMeta: own, videoPath: VIDEO }))
      .toMatchObject({ state: 'known', topicId: POST_ID, from: 'metadata', match: 'topic_url' });
  });

  it('a hub you picked (Paste, Find the post, a link just made) is yours: kept', () => {
    expect(resolveTopic({ record: { ...SAVED_HUB_RECORD, match: 'manual' }, scriptPath: SCRIPT, videoPath: VIDEO }))
      .toMatchObject({ state: 'known', topicId: HUB_ID, from: 'record', match: 'manual' });
    expect(resolveTopic({ record: { ...SAVED_HUB_RECORD, match: 'search' }, scriptPath: SCRIPT, videoPath: VIDEO }))
      .toMatchObject({ state: 'known', topicId: HUB_ID, match: 'search' });
    expect(resolveTopic({ scriptPath: SCRIPT, scriptMeta: hubMeta(), link: { topicId: HUB_ID, match: 'manual' } }))
      .toMatchObject({ state: 'known', topicId: HUB_ID, from: 'link' });
  });

  it('a record about ANOTHER script with a hub link in the metadata: otherScript, as with no link at all', () => {
    expect(resolveTopic({ record: { topicId: 7, scriptPath: 'C:/lib/old.funscript' }, scriptPath: SCRIPT, scriptMeta: hubMeta() }))
      .toEqual({ state: 'otherScript', topicId: 7, scriptPath: 'C:/lib/old.funscript', scriptName: 'old.funscript' });
  });
});

describe('getTagsForVideo and a hub', () => {
  const run = (settings, extra = {}) => getTagsForVideo({
    videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: () => true, queue: queueWith(forum.topicMeta), ...extra,
  });

  it('the script\'s hub link: nothing is requested and nothing is written', async () => {
    const ds = makeDs();
    const out = await run(ds, { scriptMeta: hubMeta() });
    expect(out).toMatchObject({ kind: 'notOffered', resolution: { state: 'none', hub: { topicId: HUB_ID } } });
    expect(outcomeText(out)).toBe(STRINGS['videoOptions.tags.fetch.hubNote']);
    expect(forum.topicMeta).not.toHaveBeenCalled();
    expect(ds.set).not.toHaveBeenCalled();
  });

  it('a bare /t/<id> link: read once, its title says hub, nothing written, and from then on it is not linked', async () => {
    const ds = makeDs();
    const scriptMeta = hubMeta(`https://discuss.eroscripts.com/t/${BARE_HUB_ID}`);
    expect(resolveTopic({ scriptPath: SCRIPT, scriptMeta }).state).toBe('known');
    const out = await run(ds, { scriptMeta });
    expect(out).toEqual({ kind: 'hub', topicId: BARE_HUB_ID, creator: 'Testmaker' });
    expect(outcomeText(out)).toBe(STRINGS['videoOptions.tags.fetch.hub']);
    expect(forum.topicMeta).toHaveBeenCalledTimes(1);
    expect(ds.set).not.toHaveBeenCalled();
    expect(resolveTopic({ scriptPath: SCRIPT, scriptMeta })).toMatchObject({ state: 'none', hub: { topicId: BARE_HUB_ID } });
    // A second press sends nothing.
    expect((await run(ds, { scriptMeta })).kind).toBe('notOffered');
    expect(forum.topicMeta).toHaveBeenCalledTimes(1);
  });

  it('a hub you picked: its tags are read and stored (you chose it)', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: { ...SAVED_HUB_RECORD, match: 'manual', tags: [], unread: true } } });
    const out = await run(ds, { scriptMeta: hubMeta() });
    expect(out.kind).toBe('success');
    expect(forum.topicMeta).toHaveBeenCalledWith(HUB_ID);
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: HUB_ID, match: 'manual', tags: HUB_TAGS });
  });

  it('a record saved about the hub is repaired by the next Get tags when the script names its own post', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: { ...SAVED_HUB_RECORD, match: 'download' } } });
    const own = funscriptMetaRecord({ creator: 'Testmaker', topic_url: T('lumen-rooftop-sunset', POST_ID) }, 0);
    const out = await run(ds, { scriptMeta: own });
    expect(out.kind).toBe('success');
    expect(forum.topicMeta.mock.calls).toEqual([[POST_ID]]);
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: POST_ID, match: 'topic_url', tags: POST_TAGS, scriptPath: SCRIPT });
  });
});

describe('a hub\'s tags are never the video\'s (chips, the library index, the phone)', () => {
  it('a saved hub record you did not pick gives no tags; it is kept as it is', () => {
    expect(eroscriptsRecordForTags(SAVED_HUB_RECORD, SCRIPT)).toBeNull();
    expect(eroscriptsRecordForTags({ ...SAVED_HUB_RECORD, match: 'manual' }, SCRIPT)).toMatchObject({ topicId: HUB_ID });
    const scriptTags = { [VIDEO]: SAVED_HUB_RECORD, [LONELY_VIDEO]: { ...SAVED_HUB_RECORD, scriptPath: LONELY_SCRIPT, match: 'manual' } };
    const before = JSON.stringify(scriptTags);
    const { index } = buildLibraryTagIndex({
      videos: [{ path: VIDEO, funscriptPath: SCRIPT }, { path: LONELY_VIDEO, funscriptPath: LONELY_SCRIPT }],
      scriptTags,
    });
    expect(hubTagShown((index.get(VIDEO) || []).map((t) => t.key))).toBe(false);
    expect(hubTagShown((index.get(LONELY_VIDEO) || []).map((t) => t.key))).toBe(true); // picked by you
    expect(JSON.stringify(scriptTags)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The Tags section, end to end with the fake forum
// ---------------------------------------------------------------------------

describe('Tags section: the script\'s own link is its creator\'s index', () => {
  const video = { path: VIDEO, name: 'Lumen Rooftop Sunset.mp4', funscriptPath: SCRIPT };

  it('passed over; Find the post searches the video\'s name, the creator\'s own post first; Get tags reads that post only', async () => {
    const ds = makeDs();
    const { host } = mount({ ds, forum, video, scriptMeta: hubMeta() });
    await settle();
    expect(byFocus(host, 'tags:get')).toBeNull();
    expect(sourceNote(host)).toBe(STRINGS['videoOptions.tags.fetch.hubNote']);
    expect(byFocus(host, 'tags:findPost')).toBeTruthy();

    const titles = await findThePost(host);
    expect(forum.search).toHaveBeenCalledWith('Lumen Rooftop Sunset');
    // The forum ranked the hub first; the creator's own post comes first, the hub last.
    expect(titles).toEqual(['Lumen Rooftop Sunset', 'Lumen Rooftop Sunset (alt cut)', 'Testmaker - Script Index']);
    topOverlay().querySelector('.eroscripts-inline__link-btn').click();
    await settle();
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: POST_ID, match: 'search', creator: 'Testmaker', unread: true });

    byFocus(host, 'tags:get').click();
    await vi.waitFor(() => expect(ds._store[SCRIPT_TAGS_KEY][VIDEO].unread).toBeUndefined());
    await settle();
    expect(forum.topicMeta.mock.calls).toEqual([[POST_ID]]);
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: POST_ID, tags: POST_TAGS });
    expect(eroChips(host)).toEqual(expect.arrayContaining(['content:pov', 'device:the-handy']));
    expect(hubTagShown(chipKeys(host))).toBe(false);
  });

  it('no post of its own on the forum (only the hub matches): nothing is linked and no tag of the hub shows', async () => {
    const lonely = { path: LONELY_VIDEO, name: 'Harbor Night.mp4', funscriptPath: LONELY_SCRIPT };
    const ds = makeDs();
    const { host } = mount({ ds, forum, video: lonely, scriptMeta: hubMeta() });
    await settle();
    const titles = await findThePost(host);
    expect(titles).toEqual(['Testmaker - Script Index']);
    topOverlay().querySelector('.modal-close-btn').click();
    await settle();
    expect(ds.set).not.toHaveBeenCalled();
    expect(forum.topicMeta).not.toHaveBeenCalled();
    expect(byFocus(host, 'tags:get')).toBeNull();
    expect(sourceNote(host)).toBe(STRINGS['videoOptions.tags.fetch.hubNote']);
    expect(eroChips(host)).toEqual([]);
  });

  it('a bare link Get tags finds to be a hub: nothing written, the line says why, and Find the post takes the focus', async () => {
    const ds = makeDs();
    const { host, ctx } = mount({ ds, forum, video, scriptMeta: hubMeta(`https://discuss.eroscripts.com/t/${BARE_HUB_ID}`) });
    await settle();
    const get = byFocus(host, 'tags:get');
    get.focus();
    get.click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith(STRINGS['videoOptions.tags.fetch.hub']));
    await settle();
    expect(forum.topicMeta.mock.calls).toEqual([[BARE_HUB_ID]]);
    expect(ds.set).not.toHaveBeenCalled();
    expect(byFocus(host, 'tags:get')).toBeNull();
    expect(sourceNote(host)).toBe(STRINGS['videoOptions.tags.fetch.hubNote']);
    expect(document.activeElement).toBe(byFocus(host, 'tags:findPost'));
    expect(hubTagShown(chipKeys(host))).toBe(false);
  });

  it('a hub you picked yourself is kept: Get tags reads it and its tags show', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: { ...SAVED_HUB_RECORD, match: 'manual', tags: [], unread: true } } });
    const { host } = mount({ ds, forum, video, scriptMeta: hubMeta() });
    await settle();
    expect(sourceNote(host)).toBeNull();
    byFocus(host, 'tags:get').click();
    await vi.waitFor(() => expect(ds._store[SCRIPT_TAGS_KEY][VIDEO].unread).toBeUndefined());
    await settle();
    expect(forum.topicMeta.mock.calls).toEqual([[HUB_ID]]);
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: HUB_ID, match: 'manual', tags: HUB_TAGS });
    expect(hubTagShown(eroChips(host))).toBe(true);
  });

  it('a record saved earlier about the hub: no tags, not linked, and the next post you link and Get tags repair it (Undo puts it back exactly)', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: SAVED_HUB_RECORD } });
    const saved = JSON.stringify(ds._store[SCRIPT_TAGS_KEY]);
    const { host } = mount({ ds, forum, video, scriptMeta: hubMeta() });
    await settle();
    // Nothing deleted or rewritten by opening; the hub's tags do not show.
    expect(ds.set).not.toHaveBeenCalled();
    expect(hubTagShown(chipKeys(host))).toBe(false);
    expect(byFocus(host, 'tags:get')).toBeNull();
    expect(sourceNote(host)).toBe(STRINGS['videoOptions.tags.fetch.hubNote']);

    await findThePost(host);
    topOverlay().querySelector('.eroscripts-inline__link-btn').click();
    await settle();
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: POST_ID, match: 'search' });
    // The link's Undo puts the old record back byte for byte (and it is
    // still not linked).
    host.querySelector('.video-options-tags__undo').click();
    await settle();
    expect(JSON.stringify(ds._store[SCRIPT_TAGS_KEY])).toBe(saved);
    expect(byFocus(host, 'tags:get')).toBeNull();

    await findThePost(host);
    topOverlay().querySelector('.eroscripts-inline__link-btn').click();
    await settle();
    byFocus(host, 'tags:get').click();
    await vi.waitFor(() => expect(ds._store[SCRIPT_TAGS_KEY][VIDEO].tags).toEqual(POST_TAGS));
    await settle();
    expect(forum.topicMeta.mock.calls).toEqual([[POST_ID]]);
    expect(eroChips(host)).toEqual(expect.arrayContaining(['content:pov', 'device:the-handy']));
    expect(hubTagShown(chipKeys(host))).toBe(false);
  });
});

describe('the strings', () => {
  it('the two keys are where the section looks for them', () => {
    expect(FETCH_KEYS.hub).toBe('videoOptions.tags.fetch.hub');
    expect(FETCH_KEYS.hubNote).toBe('videoOptions.tags.fetch.hubNote');
  });
});
