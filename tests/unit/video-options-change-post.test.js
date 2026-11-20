/**
 * @vitest-environment jsdom
 * jsdom on purpose: the Tags section builds its DOM in the document, stacks
 * the REAL Modal for its questions and the link-only search, and i18n.js
 * branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// The video options dialog's Tags section, stage 2d (Dave, 2026-11-18):
//   - "Change post…" for a video whose post is known: paste a link or Find
//     the post. The old post's tags stop showing at once, nothing is fetched
//     until Get tags, and Undo puts the exact old record back;
//   - the session check as the section opens, and before a 404 calls a post
//     gone; a 403 the check finds harmless keeps the login.
// What runs for real: the section, the record writers (script-tags.js), the
// Get tags engine and its queue, Modal, the inline search in link-only mode.
// Fakes: DataService (a map), main's topic request and search (no forum is
// ever contacted), the login and the session check.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { mountTagsSection, _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');
const { TagFetchQueue } = await import('../../renderer/js/eroscripts-tag-fetch.js');
const { linkScriptPost, undoLinkScriptPost } = await import('../../renderer/js/script-tags.js');

// The English words the assertions read (the strings merge adds them to the
// locales: SCRATCH/2d-session/strings.json, and 1c's / 2b's).
const STRINGS = {
  'tags.source.eroscripts': 'EroScripts',
  'tags.source.user': 'you',
  'videoOptions.tags.source.post': '“{title}” by {creator}',
  'videoOptions.tags.source.postNoCreator': '“{title}”',
  'videoOptions.tags.source.postId': 'Post {id}',
  'videoOptions.tags.source.got': 'got {date}',
  'videoOptions.tags.source.stale': 'gone from EroScripts',
  'videoOptions.tags.source.notRead': 'tags not read yet',
  'videoOptions.tags.changePost': 'Change post…',
  'videoOptions.tags.change.title': 'Change the EroScripts post',
  'videoOptions.tags.change.message': "The tags from {post} stop showing on this video now. The new post's tags come in when you press Get tags.",
  'videoOptions.tags.live.postChanged': 'Post changed. Its tags come in when you press Get tags.',
  'videoOptions.tags.live.samePost': "That is already this video's post. Nothing changed.",
  'videoOptions.tags.live.undoChangedSince': "Not undone: this video's post was changed again since.",
  'videoOptions.tags.live.undone': 'Undone.',
  'videoOptions.tags.fetch.button': 'Get tags from EroScripts',
  'videoOptions.tags.fetch.loginButton': 'Log in to get tags…',
  'videoOptions.tags.fetch.success': 'Got {count, plural, one {# tag} other {# tags}} from EroScripts ({newCount} new).',
  'videoOptions.tags.fetch.gone': 'This post is gone from EroScripts. Its tags are kept.',
  'videoOptions.tags.fetch.loginAgain': 'Log in to EroScripts again',
  'videoOptions.tags.fetch.loginAction': 'Log in…',
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

const VIDEO = 'C:/lib/Scene.mp4';
const SCRIPT = 'C:/lib/Scene.funscript';
const OTHER = 'C:/lib/Other.mp4';
const RECORD = Object.freeze({
  tags: [{ id: 1, name: 'pov' }, { id: 2, name: 'the-handy' }],
  topicId: 7, topicUrl: 'https://discuss.eroscripts.com/t/scene/7', title: 'Scene', creator: 'Ramie', scriptPath: SCRIPT,
  match: 'download', source: 'eroscripts', savedAt: Date.UTC(2026, 10, 17), fetchedAt: null, stale: false,
});
const OTHER_RECORD = Object.freeze({ tags: ['vr'], topicId: 99, topicUrl: null, source: 'eroscripts', savedAt: 2 });

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
const okAnswer = (meta) => ({ ok: true, outcome: 'ok', status: 200, meta });

const handles = [];
function mount({ ds, queue, eroscripts, video = { path: VIDEO, name: 'Scene', funscriptPath: SCRIPT } } = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ctx = {
    video,
    dataService: ds,
    getLibraryVideos: () => [video],
    onDataChanged: vi.fn(),
    announce: vi.fn(),
    modalBody: document.body,
    tagQueue: queue,
    eroscripts: eroscripts || {
      isLoggedIn: vi.fn(async () => true),
      login: vi.fn(async () => true),
      sessionExpired: vi.fn(async () => 'expired'),
      checkSession: vi.fn(async () => 'valid'),
    },
  };
  const handle = mountTagsSection(host, ctx);
  handles.push(handle);
  return { host, handle, ctx };
}

const byFocus = (host, key) => host.querySelector(`[data-vo-focus="${key}"]`);
const eroChips = (host) => [...host.querySelectorAll('.video-options-tags__chip')]
  .filter((li) => li.textContent.includes('EroScripts')).map((li) => li.dataset.tagKey);
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const topOverlay = () => overlays().at(-1) || null;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 4) {
  for (let i = 0; i < times; i++) await flush();
}
const mapBytes = (ds) => JSON.stringify(ds._store['library.scriptTags']);

/** Change post… → Paste a post link… → the link → Link post. */
async function changeByPaste(host, link) {
  byFocus(host, 'tags:changePost').click();
  await vi.waitFor(() => expect(topOverlay()?.querySelector('.video-options-tags__change-paste')).toBeTruthy());
  topOverlay().querySelector('.video-options-tags__change-paste').click();
  await vi.waitFor(() => expect(topOverlay()?.querySelector('.video-options-tags__paste-input')).toBeTruthy());
  const dlg = topOverlay();
  dlg.querySelector('.video-options-tags__paste-input').value = link;
  dlg.querySelector('.modal-btn--primary').click();
  await settle();
}

let savedFunsync;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetTagsSectionForTests();
  savedFunsync = window.funsync;
  document.body.innerHTML = '<div id="toast-container"></div>';
});
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  for (const o of overlays().reverse()) o.querySelector('.modal-close-btn')?.click();
  window.funsync = savedFunsync;
  document.body.innerHTML = '';
});

describe('Change post…', () => {
  it('is offered for a known post (with View post); Cancel changes nothing', async () => {
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const { host } = mount({ ds, queue: queueWith(vi.fn()) });
    const change = byFocus(host, 'tags:changePost');
    expect(change.textContent).toBe('Change post…');
    change.click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.video-options-tags__change-find')).toBeTruthy());
    expect(topOverlay().textContent).toContain('The tags from “Scene” stop showing on this video now.');
    topOverlay().querySelector('.modal-close-btn').click();
    await settle();
    expect(ds.set).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byFocus(host, 'tags:changePost'));
  });

  it('paste a link: the old post\'s tags stop showing at once, nothing is fetched, and Undo puts the exact old record back', async () => {
    const main = vi.fn(async () => okAnswer({ topicId: 123, url: 'https://discuss.eroscripts.com/t/new/123', title: 'New', creator: 'X', tags: [{ id: 9, name: 'vr' }] }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD, [OTHER]: OTHER_RECORD } });
    const before = mapBytes(ds);
    const { host, ctx } = mount({ ds, queue: queueWith(main) });
    expect(eroChips(host)).toEqual(expect.arrayContaining(['content:pov', 'device:the-handy']));

    await changeByPaste(host, 'https://discuss.eroscripts.com/t/new-scene/123');

    // The old post's tags are gone at once; the record names the new post.
    expect(eroChips(host)).toEqual([]);
    const rec = ds._store['library.scriptTags'][VIDEO];
    expect(rec).toMatchObject({ topicId: 123, tags: [], unread: true, fetchedAt: null, scriptPath: SCRIPT, match: 'manual' });
    expect(ds._store['library.scriptTags'][OTHER]).toEqual(OTHER_RECORD);
    expect(host.querySelector('.video-options-tags__post').textContent).toBe('Post 123 · tags not read yet');
    expect(ctx.announce).toHaveBeenCalledWith('Post changed. Its tags come in when you press Get tags.');
    // Nothing fetched until Get tags; userTags / hiddenTags never written.
    expect(main).not.toHaveBeenCalled();
    expect(ds.set.mock.calls.every(([key]) => key === 'library.scriptTags')).toBe(true);

    // Undo (the focus is on it): the exact old record, byte for byte.
    const undo = host.querySelector('.video-options-tags__undo');
    expect(document.activeElement).toBe(undo);
    undo.click();
    await settle();
    expect(mapBytes(ds)).toBe(before);
    expect(eroChips(host)).toEqual(expect.arrayContaining(['content:pov', 'device:the-handy']));
    expect(document.activeElement).toBe(byFocus(host, 'tags:changePost'));
  });

  // followUp3 (2026-11-18, verify-2): Get tags has its own Undo now. The
  // first Undo puts the record back as it was before the fetch (the new
  // post, no tags yet); Change post's Undo then comes back and puts the old
  // record back. Before, the one Undo after Get tags was Change post's.
  it('the new post\'s tags come in on the next Get tags; Undo, then Undo again, puts the old record back', async () => {
    const main = vi.fn(async () => okAnswer({ topicId: 123, url: 'https://discuss.eroscripts.com/t/new/123', title: 'New', creator: 'X', tags: [{ id: 9, name: 'vr' }] }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const before = mapBytes(ds);
    const { host } = mount({ ds, queue: queueWith(main) });
    await changeByPaste(host, 'https://discuss.eroscripts.com/t/123');
    const linked = mapBytes(ds);

    byFocus(host, 'tags:get').click();
    await vi.waitFor(() => expect(main).toHaveBeenCalledTimes(1));
    expect(main).toHaveBeenCalledWith(123);
    await settle();
    expect(ds._store['library.scriptTags'][VIDEO]).toMatchObject({ topicId: 123, tags: [{ id: 9, name: 'vr' }] });
    expect(ds._store['library.scriptTags'][VIDEO].unread).toBeUndefined();

    host.querySelector('.video-options-tags__undo').click();         // Get tags' own Undo
    await settle();
    expect(mapBytes(ds)).toBe(linked);
    host.querySelector('.video-options-tags__undo').click();         // Change post's, back
    await settle();
    expect(mapBytes(ds)).toBe(before);
  });

  it('Find the post: the link-only search, the pick changes the post, and nothing is fetched until Get tags', async () => {
    const main = vi.fn();
    window.funsync = {
      ...savedFunsync,
      eroscriptsSearch: vi.fn(async () => ({ results: [{ id: 321, title: 'Better <b>match</b>', url: 'https://discuss.eroscripts.com/t/better/321', creator: 'Kim', tags: [], likeCount: 0 }] })),
      eroscriptsTopic: vi.fn(),
      eroscriptsDownload: vi.fn(),
    };
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const { host, ctx } = mount({ ds, queue: queueWith(main) });
    byFocus(host, 'tags:changePost').click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.video-options-tags__change-find')).toBeTruthy());
    topOverlay().querySelector('.video-options-tags__change-find').click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.eroscripts-panel__search-input')).toBeTruthy());
    // The search's own session check is the section's.
    await vi.waitFor(() => expect(ctx.eroscripts.checkSession).toHaveBeenCalledTimes(2));
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    topOverlay().querySelector('.eroscripts-panel__btn').click();
    await vi.waitFor(() => expect(topOverlay().querySelector('.eroscripts-inline__link-btn')).toBeTruthy());
    topOverlay().querySelector('.eroscripts-inline__link-btn').click();
    await settle();

    expect(ds._store['library.scriptTags'][VIDEO]).toMatchObject({
      topicId: 321, topicUrl: 'https://discuss.eroscripts.com/t/better/321', title: 'Better <b>match</b>', creator: 'Kim',
      match: 'search', tags: [], unread: true,
    });
    // The old post's tags (and its creator) are gone; only the new post's
    // creator, from the pick, shows until Get tags.
    expect(eroChips(host)).toEqual(['creator:kim']);
    expect(host.querySelector('.video-options-tags__post').textContent).toBe('“Better <b>match</b>” by Kim · tags not read yet');
    expect(main).not.toHaveBeenCalled();
    expect(window.funsync.eroscriptsTopic).not.toHaveBeenCalled();
    expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();
  });

  it('the same post again changes nothing and says so', async () => {
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()) });
    await changeByPaste(host, 'https://discuss.eroscripts.com/t/scene/7');
    expect(ds.set).not.toHaveBeenCalled();
    expect(ctx.announce).toHaveBeenCalledWith("That is already this video's post. Nothing changed.");
  });

  it('a post known only from the script file\'s metadata: Undo leaves no record, as before', async () => {
    const ds = makeDs({ 'library.scriptTags': { [OTHER]: OTHER_RECORD } });
    const before = mapBytes(ds);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountTagsSection(host, {
      video: { path: VIDEO, name: 'Scene', funscriptPath: SCRIPT },
      dataService: ds, getLibraryVideos: () => [], onDataChanged: vi.fn(), announce: vi.fn(), modalBody: document.body,
      tagQueue: queueWith(vi.fn()),
      eroscripts: { isLoggedIn: async () => true, login: async () => true, sessionExpired: async () => 'expired', checkSession: async () => 'valid' },
      getScriptMeta: () => ({ topicId: 55, topicUrl: 'https://discuss.eroscripts.com/t/meta/55', tags: [] }),
    });
    handles.push(handle);
    await settle();
    await changeByPaste(host, 'https://discuss.eroscripts.com/t/77');
    expect(ds._store['library.scriptTags'][VIDEO]).toMatchObject({ topicId: 77, unread: true });
    host.querySelector('.video-options-tags__undo').click();
    await settle();
    expect(mapBytes(ds)).toBe(before);
    expect(Object.hasOwn(ds._store['library.scriptTags'], VIDEO)).toBe(false);
  });
});

describe('the record writers for Change post (script-tags.js)', () => {
  it('Undo refuses when the post was changed again since, and writes nothing', () => {
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const change = linkScriptPost(ds, VIDEO, { topicId: 123 }, { scriptPath: SCRIPT, match: 'manual', now: 5 });
    expect(change.written).toBe(true);
    linkScriptPost(ds, VIDEO, { topicId: 456 }, { scriptPath: SCRIPT, match: 'manual', now: 6 });
    const bytes = mapBytes(ds);
    ds.set.mockClear();
    expect(undoLinkScriptPost(ds, VIDEO, change)).toEqual({ restored: false, reason: 'changedSince' });
    expect(ds.set).not.toHaveBeenCalled();
    expect(mapBytes(ds)).toBe(bytes);
  });

  it('a damaged map is never rewritten; a bad topic id writes nothing', () => {
    const damaged = makeDs({ 'library.scriptTags': ['not', 'a', 'map'] });
    expect(linkScriptPost(damaged, VIDEO, { topicId: 1 }).written).toBe(false);
    expect(damaged.set).not.toHaveBeenCalled();
    const ds = makeDs({});
    for (const topicId of [0, -1, 1.5, '12', null]) expect(linkScriptPost(ds, VIDEO, { topicId }).written).toBe(false);
    expect(ds.set).not.toHaveBeenCalled();
  });
});

describe('the session check in the Tags section', () => {
  it('opening asks it once (a kept answer); a timed-out login reads "Log in to get tags…"', async () => {
    // Main's session says logged in until the check finds the login dead
    // and drops it (as the panel's checkSession does).
    let cookie = true;
    const eroscripts = {
      isLoggedIn: vi.fn(async () => cookie),
      login: vi.fn(async () => false),
      sessionExpired: vi.fn(),
      checkSession: vi.fn(async () => {
        await flush(); // slower than the status read
        cookie = false;
        return 'expired';
      }),
    };
    const main = vi.fn();
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const { host } = mount({ ds, queue: queueWith(main), eroscripts });
    await settle();
    expect(eroscripts.checkSession).toHaveBeenCalledTimes(1);
    expect(byFocus(host, 'tags:get').textContent).toBe('Log in to get tags…');
    expect(ds.set).not.toHaveBeenCalled();
    expect(main).not.toHaveBeenCalled();
  });

  it('a video with no script asks nothing', async () => {
    const { ctx } = mount({ ds: makeDs({}), queue: queueWith(vi.fn()), video: { path: VIDEO, funscriptPath: null } });
    await settle();
    expect(ctx.eroscripts.checkSession).not.toHaveBeenCalled();
  });

  it('a 404 with a dead login stores nothing (the post is not called gone) and asks to log in again', async () => {
    const main = vi.fn(async () => ({ ok: false, outcome: 'notFound', status: 404 }));
    const checkSession = vi.fn(async (opts) => (opts?.force ? 'expired' : 'valid'));
    const sessionExpired = vi.fn();
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const before = mapBytes(ds);
    const { host, ctx } = mount({ ds, queue: queueWith(main), eroscripts: { isLoggedIn: async () => true, login: async () => true, sessionExpired, checkSession } });
    await settle();
    byFocus(host, 'tags:get').click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Log in to EroScripts again'));
    expect(checkSession).toHaveBeenLastCalledWith({ force: true });
    expect(mapBytes(ds)).toBe(before);
    expect(ds.set).not.toHaveBeenCalled();
    // The check already dropped the login: not asked twice.
    expect(sessionExpired).not.toHaveBeenCalled();
    // One login button (verify-1): Get tags reads "Log in to get tags…".
    expect(byFocus(host, 'tags:login')).toBeNull();
    expect(byFocus(host, 'tags:get').textContent).toBe('Log in to get tags…');
    expect(document.activeElement).toBe(byFocus(host, 'tags:get'));
  });

  it('a 404 with a good login marks the post gone, as before', async () => {
    const main = vi.fn(async () => ({ ok: false, outcome: 'notFound', status: 404 }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const { host, ctx } = mount({ ds, queue: queueWith(main) });
    await settle();
    byFocus(host, 'tags:get').click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('This post is gone from EroScripts. Its tags are kept.'));
    expect(ds._store['library.scriptTags'][VIDEO].stale).toBe(true);
  });

  it('a 403 the session check finds harmless keeps the login and says the refusal', async () => {
    const main = vi.fn(async () => ({ ok: false, outcome: 'authExpired', status: 403, authExpired: true }));
    const sessionExpired = vi.fn(async () => 'valid');
    const checkSession = vi.fn(async () => 'valid');
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const before = mapBytes(ds);
    const { host, ctx } = mount({ ds, queue: queueWith(main), eroscripts: { isLoggedIn: async () => true, login: async () => true, sessionExpired, checkSession } });
    await settle();
    byFocus(host, 'tags:get').click();
    // The forced check runs in Get tags' own line (RB-4), once; the hook is
    // not asked again.
    await vi.waitFor(() => expect(checkSession).toHaveBeenLastCalledWith({ force: true }));
    await settle();
    expect(checkSession.mock.calls.filter(([opts]) => opts?.force === true)).toHaveLength(1);
    expect(sessionExpired).not.toHaveBeenCalled();
    expect(ctx.announce).toHaveBeenLastCalledWith(EN.eroscripts.error.accessDenied);
    expect(byFocus(host, 'tags:login')).toBeNull();
    expect(byFocus(host, 'tags:get').textContent).toBe('Get tags from EroScripts');
    expect(mapBytes(ds)).toBe(before);
  });

  it('the library\'s hook answers nothing: a login still there afterwards was kept, one gone was dropped', async () => {
    const main = vi.fn(async () => ({ ok: false, outcome: 'authExpired', status: 403, authExpired: true }));
    let session = true;
    const keep = { isLoggedIn: async () => session, login: async () => true, sessionExpired: vi.fn(async () => {}) };
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const kept = mount({ ds, queue: queueWith(main), eroscripts: keep });
    await settle();
    byFocus(kept.host, 'tags:get').click();
    await vi.waitFor(() => expect(kept.ctx.announce).toHaveBeenCalledWith(EN.eroscripts.error.accessDenied));
    expect(byFocus(kept.host, 'tags:login')).toBeNull();
    kept.handle.dispose();

    const drop = { ...keep, sessionExpired: vi.fn(async () => { session = false; }) };
    const dropped = mount({ ds, queue: queueWith(main), eroscripts: drop });
    await settle();
    byFocus(dropped.host, 'tags:get').click();
    await vi.waitFor(() => expect(dropped.ctx.announce).toHaveBeenCalledWith('Log in to EroScripts again'));
    // One login button (verify-1): Get tags reads "Log in to get tags…".
    expect(byFocus(dropped.host, 'tags:login')).toBeNull();
    expect(byFocus(dropped.host, 'tags:get').textContent).toBe('Log in to get tags…');
  });
});
