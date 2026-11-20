/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Tags section builds its DOM and stacks the REAL
 * Modal, and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// Get tags, Change post… and the links, after review-b (fixup-data,
// 2026-11-18). What runs for real: the Tags section, the Get tags engine and
// its TagFetchQueue, the record writers (script-tags.js), the tag merge
// (video-tags.js), Modal, the English bundle. Fakes: DataService (a map),
// main's topic request and the session check (no forum is contacted).
//
//   RB-1  A Get tags answer is written only if the video's record is still
//         the one resolved at the press; else it is dropped with a quiet
//         line. While it is pending, Change post…, Paste and Find are off.
//   RB-4  The forced session check after a 401 / 403 / 404 waits its turn in
//         the queue: never two forum requests at once, 1 s apart.
//   (b)   A link you make is written at once (first link too), with an exact
//         Undo; Find the post never runs Get tags.
//   RB-2  A record with no scriptPath (older builds) is about the video's
//         same-name script: shown and used only while the video uses it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { mountTagsSection, _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');
const { TagFetchQueue, getTagsForVideo } = await import('../../renderer/js/eroscripts-tag-fetch.js');
const {
  SCRIPT_TAGS_KEY, linkScriptPost, undoLinkScriptPost, recordDownloadTags,
} = await import('../../renderer/js/script-tags.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const FETCH = EN.videoOptions.tags.fetch;
const LIVE = EN.videoOptions.tags.live;

const VIDEO = 'C:/lib/Scene.mp4';
const SCRIPT = 'C:/lib/Scene.funscript';
const HAND_PICKED = 'C:/lib/hand-picked.funscript';
const RECORD = Object.freeze({
  tags: [{ id: 1, name: 'pov' }], topicId: 7, topicUrl: 'https://discuss.eroscripts.com/t/scene/7', title: 'Old post', creator: 'Ramie',
  scriptPath: SCRIPT, match: 'download', source: 'eroscripts', savedAt: 1, fetchedAt: null, stale: false,
});
// What v0.9.0 to v0.9.2 wrote after a download: no scriptPath, no match.
const LEGACY = Object.freeze({ tags: ['pov', 'the-handy'], topicId: 7, topicUrl: 'https://discuss.eroscripts.com/t/scene/7', source: 'eroscripts', savedAt: 1 });
const META_7 = { topicId: 7, url: RECORD.topicUrl, title: 'Old post', creator: 'Ramie', tags: [{ id: 1, name: 'pov' }, { id: 3, name: 'vr' }] };

function makeDs(settings = {}) {
  const store = structuredClone(settings);
  return {
    _store: store,
    get: (k) => store[k],
    set: vi.fn((k, v) => { store[k] = v; }),
    getCategories: () => [],
    getVideoCategories: () => [],
    getAllVideoCategories: () => ({}),
  };
}
/** main's topic request, answered when the test says. */
function deferredMain() {
  const pending = [];
  const topicMeta = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
  return { topicMeta, answer: (a) => pending.shift()(a) };
}
const okAnswer = (meta) => ({ ok: true, outcome: 'ok', status: 200, meta });
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 6) { for (let i = 0; i < n; i++) await flush(); }
const mapBytes = (ds) => JSON.stringify(ds._store[SCRIPT_TAGS_KEY]);
const byFocus = (host, key) => host.querySelector(`[data-vo-focus="${key}"]`);
const topOverlay = () => [...document.querySelectorAll('.modal-overlay')].at(-1) || null;
const eroChips = (host) => [...host.querySelectorAll('.video-options-tags__chip')]
  .filter((li) => li.textContent.includes('EroScripts')).map((li) => li.dataset.tagKey);

const handles = [];
function mount({ ds, queue, video = { path: VIDEO, name: 'Scene', funscriptPath: SCRIPT }, eroscripts } = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ctx = {
    video, dataService: ds, getLibraryVideos: () => [video], onDataChanged: vi.fn(), announce: vi.fn(),
    modalBody: document.body, tagQueue: queue,
    eroscripts: eroscripts || { isLoggedIn: async () => true, login: async () => true, sessionExpired: vi.fn(), checkSession: async () => 'valid' },
  };
  const handle = mountTagsSection(host, ctx);
  handles.push(handle);
  return { host, ctx, handle };
}

let savedFunsync;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetTagsSectionForTests();
  document.body.innerHTML = '<div id="toast-container"></div>';
  savedFunsync = window.funsync;
});
afterEach(() => {
  for (const h of handles.splice(0)) { try { h.dispose(); } catch { /* gone */ } }
  window.funsync = savedFunsync;
  vi.useRealTimers();
});

describe('RB-1: a Get tags answer writes only over the record the press resolved', () => {
  it('Change post… (linkScriptPost) while the request runs: the new link stays, nothing is written, "superseded"', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: RECORD } });
    const main = deferredMain();
    const run = getTagsForVideo({ videoPath: VIDEO, scriptPath: SCRIPT, settings: ds, isLoggedIn: () => true, queue: new TagFetchQueue({ topicMeta: main.topicMeta, minGapMs: 0 }) });
    await settle();
    expect(main.topicMeta).toHaveBeenCalledWith(7);
    linkScriptPost(ds, VIDEO, { topicId: 123 }, { scriptPath: SCRIPT, match: 'manual', now: 5 });
    const linked = mapBytes(ds);
    ds.set.mockClear();

    main.answer(okAnswer(META_7));
    expect(await run).toEqual({ kind: 'superseded', topicId: 7 });
    expect(ds.set).not.toHaveBeenCalled();
    expect(mapBytes(ds)).toBe(linked);
  });

  it('the Undo of a Change post while Get tags for the new post runs: the Undo stands', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: RECORD } });
    const change = linkScriptPost(ds, VIDEO, { topicId: 123 }, { scriptPath: SCRIPT, match: 'manual', now: 5 });
    const main = deferredMain();
    const run = getTagsForVideo({ videoPath: VIDEO, scriptPath: SCRIPT, settings: ds, isLoggedIn: () => true, queue: new TagFetchQueue({ topicMeta: main.topicMeta, minGapMs: 0 }) });
    await settle();
    expect(main.topicMeta).toHaveBeenCalledWith(123);
    expect(undoLinkScriptPost(ds, VIDEO, change)).toEqual({ restored: true });

    main.answer(okAnswer({ ...META_7, topicId: 123, tags: [{ id: 9, name: 'cosplay' }] }));
    expect((await run).kind).toBe('superseded');
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toEqual(RECORD);
  });

  it('a download recording a new post while an older Get tags is pending: the download\'s record stays; a 404 marks nothing', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: RECORD } });
    const main = deferredMain();
    const queue = new TagFetchQueue({ topicMeta: main.topicMeta, minGapMs: 0 });
    const checkSession = vi.fn(async () => 'valid');
    const run = getTagsForVideo({ videoPath: VIDEO, scriptPath: SCRIPT, settings: ds, isLoggedIn: () => true, checkSession, queue });
    await settle();
    recordDownloadTags(ds, VIDEO, { topic: { id: 55, title: 'New', tags: ['sr6'] }, scriptPath: SCRIPT, now: 9 });
    const downloaded = mapBytes(ds);

    main.answer({ ok: false, outcome: 'notFound', status: 404 });
    expect((await run).kind).toBe('superseded');
    expect(mapBytes(ds)).toBe(downloaded);
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO].stale).toBe(false);
  });

  it('nothing changed meanwhile: written as before', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: RECORD } });
    const main = deferredMain();
    const run = getTagsForVideo({ videoPath: VIDEO, scriptPath: SCRIPT, settings: ds, isLoggedIn: () => true, queue: new TagFetchQueue({ topicMeta: main.topicMeta, minGapMs: 0 }) });
    await settle();
    main.answer(okAnswer(META_7));
    expect((await run).kind).toBe('success');
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO].tags).toEqual(META_7.tags);
  });

  it('UI: Change post… is disabled while the request is pending and back after; a dropped answer says so quietly', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: RECORD } });
    const main = deferredMain();
    const { host, ctx } = mount({ ds, queue: new TagFetchQueue({ topicMeta: main.topicMeta, minGapMs: 0 }) });
    await settle();
    expect(byFocus(host, 'tags:changePost').disabled).toBe(false);

    byFocus(host, 'tags:get').click();
    await settle();
    expect(main.topicMeta).toHaveBeenCalledTimes(1);
    const change = byFocus(host, 'tags:changePost');
    expect(change.disabled).toBe(true);
    change.click();
    await settle();
    expect(topOverlay()).toBeNull();

    // The record changes anyway (a download for this video, elsewhere).
    linkScriptPost(ds, VIDEO, { topicId: 123 }, { scriptPath: SCRIPT, match: 'manual', now: 5 });
    main.answer(okAnswer(META_7));
    await settle(10);
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: 123, unread: true, tags: [] });
    expect(ctx.announce).toHaveBeenLastCalledWith(FETCH.superseded);
    expect(byFocus(host, 'tags:changePost').disabled).toBe(false);
  });

  it('UI: Paste a post link… and Find the post… are disabled while the video\'s request is pending', async () => {
    // A record about another script: the link buttons show; a Get tags for
    // this video (pressed elsewhere, the app's one queue) is pending.
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: { ...RECORD, scriptPath: HAND_PICKED } } });
    const main = deferredMain();
    const queue = new TagFetchQueue({ topicMeta: main.topicMeta, minGapMs: 0 });
    const { host } = mount({ ds, queue });
    await settle();
    expect(byFocus(host, 'tags:paste').disabled).toBe(false);
    let release;
    queue.runFor(VIDEO, () => new Promise((r) => { release = r; }));
    await settle();
    expect(byFocus(host, 'tags:paste').disabled).toBe(true);
    expect(byFocus(host, 'tags:findPost').disabled).toBe(true);
    release();
    await settle();
    expect(byFocus(host, 'tags:paste').disabled).toBe(false);
    expect(byFocus(host, 'tags:findPost').disabled).toBe(false);
    // ...and they look disabled (eroscripts.css; video-options.css styles no :disabled).
    expect(fs.readFileSync('renderer/styles/eroscripts.css', 'utf8'))
      .toMatch(/\.video-options-tags__source--eroscripts \.video-options__btn:disabled\s*\{[^}]*opacity/);
  });
});

describe('RB-4: the forced session check waits its turn in the queue', () => {
  function tracker() {
    const inFlight = new Set();
    const log = [];
    let max = 0;
    const track = (name, ms, answer) => {
      inFlight.add(name);
      max = Math.max(max, inFlight.size);
      log.push(`${Date.now()} start ${name}`);
      return new Promise((resolve) => setTimeout(() => {
        inFlight.delete(name);
        log.push(`${Date.now()} end ${name}`);
        resolve(answer);
      }, ms));
    };
    return { track, log, max: () => max };
  }

  for (const [label, refusal] of [
    ['404', { ok: false, outcome: 'notFound', status: 404 }],
    ['403', { ok: false, outcome: 'authExpired', status: 403, authExpired: true }],
  ]) {
    it(`after a ${label}: never two forum requests at once, and >= 1 s from one end to the next start`, async () => {
      vi.useFakeTimers({ now: 0 });
      const tr = tracker();
      const topicMeta = vi.fn((id) => tr.track(`topic ${id}`, 200, id === 1 ? refusal : okAnswer({ topicId: 2, tags: [] })));
      const checkSession = vi.fn(() => tr.track('session check', 3000, 'valid'));
      const queue = new TagFetchQueue({ topicMeta });
      const settings = () => makeDs({});
      const a = getTagsForVideo({ videoPath: 'C:/v/A.mp4', scriptPath: 'C:/v/A.funscript', settings: settings(), link: { topicId: 1 }, isLoggedIn: () => true, checkSession, queue });
      const b = getTagsForVideo({ videoPath: 'C:/v/B.mp4', scriptPath: 'C:/v/B.funscript', settings: settings(), link: { topicId: 2 }, isLoggedIn: () => true, checkSession, queue });
      await vi.advanceTimersByTimeAsync(20_000);
      await Promise.all([a, b]);
      expect(checkSession).toHaveBeenCalledTimes(1);
      expect(checkSession).toHaveBeenCalledWith({ force: true });
      expect(tr.max()).toBe(1);
      // Each start is >= 1 s after the previous end.
      const events = tr.log.map((line) => line.split(' ')).map(([at, what]) => ({ at: Number(at), what }));
      for (let i = 1; i < events.length; i++) {
        if (events[i].what === 'start') expect(events[i].at - events[i - 1].at).toBeGreaterThanOrEqual(1000);
      }
    });
  }

  it('in a 429 cooldown the check is not sent: the 404 counts as "could not check"', async () => {
    const queue = new TagFetchQueue({ topicMeta: vi.fn(), minGapMs: 0 });
    queue._startCooldown(60);
    const job = vi.fn(async () => 'expired');
    expect(await queue.run(job, 'unknown')).toBe('unknown');
    expect(job).not.toHaveBeenCalled();
    clearTimeout(queue._cooldownTimer);
  });

  it('UI, no check of its own (the hook only): the hook after a 403 also waits behind a running request', async () => {
    const main = deferredMain();
    const queue = new TagFetchQueue({ topicMeta: main.topicMeta, minGapMs: 0 });
    const order = [];
    const sessionExpired = vi.fn(async () => { order.push('hook'); });
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: RECORD, 'C:/lib/Two.mp4': { ...RECORD, scriptPath: 'C:/lib/Two.funscript', topicId: 8 } } });
    const { host } = mount({ ds, queue, eroscripts: { isLoggedIn: async () => true, login: async () => true, sessionExpired } });
    await settle();
    byFocus(host, 'tags:get').click();
    await settle();
    // Another video's request is queued right behind this one.
    const two = getTagsForVideo({ videoPath: 'C:/lib/Two.mp4', scriptPath: 'C:/lib/Two.funscript', settings: ds, isLoggedIn: () => true, queue });
    await settle();
    main.answer({ ok: false, outcome: 'authExpired', status: 403, authExpired: true });
    order.push('topic 7 answered');
    await settle(10);
    // Topic 8 is in flight now: the hook waits for it.
    expect(main.topicMeta).toHaveBeenCalledTimes(2);
    expect(sessionExpired).not.toHaveBeenCalled();
    main.answer(okAnswer({ ...META_7, topicId: 8 }));
    order.push('topic 8 answered');
    await settle(10);
    await two;
    expect(sessionExpired).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['topic 7 answered', 'topic 8 answered', 'hook']);
  });
});

describe('(b) a link you make is written at once, with an exact Undo; Find the post only links', () => {
  it('first link, no post known: written at once; Undo leaves no record, byte-equal to before', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { 'C:/lib/Other.mp4': { tags: ['vr'], topicId: 99, savedAt: 2 } } });
    const before = mapBytes(ds);
    const main = vi.fn();
    const { host, ctx } = mount({ ds, queue: new TagFetchQueue({ topicMeta: main, minGapMs: 0 }) });
    await settle();
    byFocus(host, 'tags:paste').click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.video-options-tags__paste-input')).toBeTruthy());
    topOverlay().querySelector('.video-options-tags__paste-input').value = 'https://discuss.eroscripts.com/t/new/123';
    topOverlay().querySelector('.modal-btn--primary').click();
    await settle();
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: 123, unread: true, scriptPath: SCRIPT, match: 'manual' });
    expect(ctx.announce).toHaveBeenCalledWith(LIVE.linked);
    expect(main).not.toHaveBeenCalled();

    host.querySelector('.video-options-tags__undo').click();
    await settle();
    expect(mapBytes(ds)).toBe(before);
    expect(ctx.announce).toHaveBeenLastCalledWith(LIVE.undone);
  });

  it('a link over a record about another script: Undo puts that record back exactly', async () => {
    const other = { ...RECORD, scriptPath: HAND_PICKED };
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: other } });
    const before = mapBytes(ds);
    const { host } = mount({ ds, queue: new TagFetchQueue({ topicMeta: vi.fn(), minGapMs: 0 }) });
    await settle();
    expect(host.querySelector('.video-options-tags__other-script')).not.toBeNull();
    byFocus(host, 'tags:paste').click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.video-options-tags__paste-input')).toBeTruthy());
    topOverlay().querySelector('.video-options-tags__paste-input').value = 'https://discuss.eroscripts.com/t/123';
    topOverlay().querySelector('.modal-btn--primary').click();
    await settle();
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: 123, scriptPath: SCRIPT });
    host.querySelector('.video-options-tags__undo').click();
    await settle();
    expect(mapBytes(ds)).toBe(before);
  });

  it('Find the post (first link) links the picked post and sends no topic request', async () => {
    const results = [{ id: 321, title: 'Scene', url: 'https://discuss.eroscripts.com/t/scene/321', creator: 'Ramie', tags: [], likeCount: 0 }];
    window.funsync = { ...savedFunsync, eroscriptsSearch: vi.fn(async () => ({ results })), eroscriptsTopic: vi.fn(), eroscriptsDownload: vi.fn() };
    const main = vi.fn();
    const ds = makeDs({});
    const { host } = mount({ ds, queue: new TagFetchQueue({ topicMeta: main, minGapMs: 0 }) });
    await settle();
    byFocus(host, 'tags:findPost').click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.eroscripts-panel__search-input')).toBeTruthy());
    topOverlay().querySelector('.eroscripts-panel__btn').click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.eroscripts-inline__link-btn')).toBeTruthy());
    topOverlay().querySelector('.eroscripts-inline__link-btn').click();
    await vi.waitFor(() => expect(ds._store[SCRIPT_TAGS_KEY]?.[VIDEO]).toBeTruthy());
    await settle(10);
    expect(ds._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ topicId: 321, match: 'search', unread: true });
    expect(main).not.toHaveBeenCalled();
    expect(byFocus(host, 'tags:get').dataset.state).toBe('ready');
  });
});

describe('RB-2: the Associate search hands out what the topic JSON said', () => {
  it('a download pick carries `topicAnswer` (tags with ids, title, creator) beside the search result', async () => {
    const { showEroScriptsSearchModal } = await import('../../renderer/components/eroscripts-inline-search.js');
    const answer = {
      attachments: [{ name: 'Post A.funscript', url: 'https://discuss.eroscripts.com/uploads/a.funscript' }],
      topicId: 7, url: 'https://discuss.eroscripts.com/t/post-a/7', title: 'Post A', creator: 'Ramie', tags: [{ id: 1, name: 'pov' }],
    };
    window.funsync = {
      ...savedFunsync,
      platform: 'win32',
      eroscriptsStatus: vi.fn(async () => ({ loggedIn: true })),
      eroscriptsSearch: vi.fn(async () => ({ results: [{ id: 7, title: 'Post A (search)', tags: ['pov'] }] })),
      eroscriptsTopic: vi.fn(async () => structuredClone(answer)),
      eroscriptsDownload: vi.fn(async () => ({ success: true })),
    };
    const picked = showEroScriptsSearchModal({ path: VIDEO, name: 'Scene.mp4' });
    let head;
    await vi.waitFor(() => { head = document.querySelector('.eroscripts-inline__result-head'); expect(head).toBeTruthy(); });
    head.click();
    let btn;
    await vi.waitFor(() => { btn = document.querySelector('.eroscripts-inline__group-actions button'); expect(btn).toBeTruthy(); });
    btn.click();
    const payload = await picked;
    expect(payload).toMatchObject({
      mode: 'single',
      topic: { id: 7, title: 'Post A (search)' },
      topicAnswer: { topicId: 7, url: answer.url, title: 'Post A', creator: 'Ramie', tags: answer.tags },
    });
    expect(payload.topicAnswer).not.toHaveProperty('attachments');
  });
});

describe('RB-2: a record with no scriptPath (v0.9.0 to v0.9.2) is about the video\'s same-name script', () => {
  it('on that script: its tags show and Get tags is offered (and replaces it with a record that names the script)', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: LEGACY } });
    const main = vi.fn(async () => okAnswer(META_7));
    const { host } = mount({ ds, queue: new TagFetchQueue({ topicMeta: main, minGapMs: 0 }) });
    await settle();
    expect(eroChips(host).sort()).toEqual(['content:pov', 'device:the-handy']);
    expect(byFocus(host, 'tags:get')).not.toBeNull();
    byFocus(host, 'tags:get').click();
    await vi.waitFor(() => expect(main).toHaveBeenCalledWith(7));
    await vi.waitFor(() => expect(ds._store[SCRIPT_TAGS_KEY][VIDEO].scriptPath).toBe(SCRIPT));
  });

  it('on a script you paired since: not shown, not offered, the "another script" line names the file it is about; the record is never rewritten', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: LEGACY } });
    const before = mapBytes(ds);
    const main = vi.fn();
    const { host } = mount({ ds, queue: new TagFetchQueue({ topicMeta: main, minGapMs: 0 }), video: { path: VIDEO, name: 'Scene', funscriptPath: HAND_PICKED } });
    await settle();
    expect(eroChips(host)).toEqual([]);
    expect(byFocus(host, 'tags:get')).toBeNull();
    expect(host.querySelector('.video-options-tags__other-script').textContent)
      .toBe(FETCH.otherScript.replace('{name}', 'Scene.funscript'));
    expect(main).not.toHaveBeenCalled();
    expect(ds.set).not.toHaveBeenCalled();
    expect(mapBytes(ds)).toBe(before);
  });

  it('on a video left with no script (after Unpair): not shown, and kept', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: LEGACY } });
    const before = mapBytes(ds);
    const { host } = mount({ ds, queue: new TagFetchQueue({ topicMeta: vi.fn(), minGapMs: 0 }), video: { path: VIDEO, name: 'Scene', funscriptPath: null } });
    await settle();
    expect(eroChips(host)).toEqual([]);
    expect(mapBytes(ds)).toBe(before);
  });

  it('Get tags itself refuses it on another script (no request), whatever the caller shows', async () => {
    const ds = makeDs({ [SCRIPT_TAGS_KEY]: { [VIDEO]: LEGACY } });
    const main = vi.fn();
    const out = await getTagsForVideo({ videoPath: VIDEO, scriptPath: HAND_PICKED, settings: ds, isLoggedIn: () => true, queue: new TagFetchQueue({ topicMeta: main, minGapMs: 0 }) });
    expect(out).toMatchObject({ kind: 'notOffered', resolution: { state: 'otherScript', scriptName: 'Scene.funscript' } });
    expect(main).not.toHaveBeenCalled();
    expect(ds.set).not.toHaveBeenCalled();
  });
});
