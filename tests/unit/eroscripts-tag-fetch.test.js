// "Get tags from EroScripts" in the renderer (video options design (c) and
// the (h) test plan, 2026-11-18): which post a video's current script
// belongs to, one request at a time with 1 s between them, the 429 cooldown
// that disables every Get tags button, the login gate, and what each answer
// does to the stored record. Main is a fake (no forum).
//
// jsdom (the default): the module imports i18n.js through
// eroscripts-error-text.js, which branches on `window` (notes/CLAUDE.md).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveTopic, topicIdFromLink, TagFetchQueue, getTagsForVideo, outcomeMessage, outcomeText,
  buttonState, FETCH_KEYS, MIN_GAP_MS, DEFAULT_COOLDOWN_S,
} from '../../renderer/js/eroscripts-tag-fetch.js';
import { SCRIPT_TAGS_KEY } from '../../renderer/js/script-tags.js';
import { effectiveTags } from '../../renderer/js/video-tags.js';

const VIDEO = 'C:/v/Scene.mp4';
const SCRIPT = 'C:/v/Scene.funscript';
const OLD_SCRIPT = 'C:/v/old.funscript';
const META = {
  topicId: 7,
  slug: 'scene',
  url: 'https://discuss.eroscripts.com/t/scene/7',
  title: 'Scene [Multi-Axis]',
  creator: 'Ramie',
  tags: [{ id: 1, name: 'pov' }, { id: 2, name: 'the-handy' }, { name: 'len-10-25' }],
  status: 'open',
};
const OK = { ok: true, outcome: 'ok', status: 200, meta: META };

function makeSettings(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  const set = vi.fn((key, value) => { store[key] = value; });
  return { get: (key) => store[key], set, _store: store };
}

// An existing record from a download (v1: no scriptPath), plus the user's
// own tags and hides on the same video, plus another video's record.
function libraryWithRecord(record = { tags: ['old-tag', 'pov'], topicId: 7, topicUrl: 'https://discuss.eroscripts.com/t/scene/7', source: 'eroscripts', savedAt: 1 }) {
  return makeSettings({
    [SCRIPT_TAGS_KEY]: {
      [VIDEO]: record,
      'C:/v/Other.mp4': { tags: ['vr'], topicId: 99, topicUrl: null, source: 'eroscripts', savedAt: 2 },
    },
    'library.userTags': { [VIDEO]: ['cosplay', 'content:pov'] },
    'library.hiddenTags': { [VIDEO]: ['content:pov'] },
  });
}

function fakeMain(answers) {
  const queue = Array.isArray(answers) ? [...answers] : null;
  return vi.fn(async () => (queue ? queue.shift() : answers));
}

const loggedIn = () => true;

describe('topicIdFromLink (Paste a post link)', () => {
  it('takes a discuss.eroscripts.com topic link, by the funscript metadata\'s own reader', () => {
    expect(topicIdFromLink('https://discuss.eroscripts.com/t/scene-name/123456')).toBe(123456);
    expect(topicIdFromLink('  https://discuss.eroscripts.com/t/123456/4 ')).toBe(123456);
    expect(topicIdFromLink('https://discuss.eroscripts.com/t/scene-name/123456/12')).toBe(123456);
  });

  it('refuses another host, another path, or not a link', () => {
    for (const bad of ['https://evil.example/t/x/123', 'https://discuss.eroscripts.com/u/dave', '123', '', null, 42]) {
      expect(topicIdFromLink(bad)).toBeNull();
    }
  });
});

describe('resolveTopic', () => {
  it('uses the record when it names the current script', () => {
    expect(resolveTopic({ record: { topicId: 7, scriptPath: SCRIPT, match: 'search' }, scriptPath: SCRIPT }))
      .toMatchObject({ state: 'known', topicId: 7, match: 'search', from: 'record' });
  });

  // fixup-data 2026-11-18 (review-b RB-2): a record with no scriptPath was
  // made by a download before the field; that download saved the video's
  // same-name script, so it describes that file and no other.
  it('a record with no scriptPath (made before the field) describes the video\'s same-name script: match download', () => {
    expect(resolveTopic({ record: { topicId: 7, topicUrl: 'u' }, scriptPath: SCRIPT, videoPath: VIDEO }))
      .toEqual({ state: 'known', topicId: 7, topicUrl: 'u', match: 'download', from: 'record' });
  });

  it('...and on a script you paired since it is another script\'s post: not used (otherScript)', () => {
    expect(resolveTopic({ record: { topicId: 7, topicUrl: 'u' }, scriptPath: OLD_SCRIPT, videoPath: VIDEO }))
      .toEqual({ state: 'otherScript', topicId: 7, scriptPath: SCRIPT, scriptName: 'Scene.funscript' });
    // Without the video's path nothing can be proved: no post known.
    expect(resolveTopic({ record: { topicId: 7, topicUrl: 'u' }, scriptPath: SCRIPT })).toEqual({ state: 'none' });
  });

  it('the same file spelled with other slashes or case is the same script', () => {
    expect(resolveTopic({ record: { topicId: 7, scriptPath: 'c:\\V\\scene.funscript' }, scriptPath: SCRIPT }).state).toBe('known');
  });

  it('a record for ANOTHER script is not used: otherScript, with its file name', () => {
    expect(resolveTopic({ record: { topicId: 7, scriptPath: OLD_SCRIPT }, scriptPath: SCRIPT }))
      .toEqual({ state: 'otherScript', topicId: 7, scriptPath: OLD_SCRIPT, scriptName: 'old.funscript' });
  });

  it('then the current script\'s own metadata (topic_url, else script_url)', () => {
    const viaTopic = { topicId: 55, topicUrl: 'https://discuss.eroscripts.com/t/a/55', scriptUrl: null };
    expect(resolveTopic({ scriptPath: SCRIPT, scriptMeta: viaTopic }))
      .toMatchObject({ state: 'known', topicId: 55, match: 'topic_url', from: 'metadata', topicUrl: viaTopic.topicUrl });
    const viaScript = { topicId: 56, topicUrl: null, scriptUrl: 'https://discuss.eroscripts.com/t/b/56' };
    expect(resolveTopic({ scriptPath: SCRIPT, scriptMeta: viaScript }))
      .toMatchObject({ state: 'known', topicId: 56, match: 'script_url', topicUrl: viaScript.scriptUrl });
    // The metadata of the script you use now beats a record about the old one.
    expect(resolveTopic({ record: { topicId: 7, scriptPath: OLD_SCRIPT }, scriptPath: SCRIPT, scriptMeta: viaTopic }).topicId).toBe(55);
  });

  it('a post you just linked comes first', () => {
    expect(resolveTopic({ record: { topicId: 7, scriptPath: OLD_SCRIPT }, scriptPath: SCRIPT, link: { topicId: 88, match: 'search' } }))
      .toMatchObject({ state: 'known', topicId: 88, match: 'search', from: 'link', topicUrl: 'https://discuss.eroscripts.com/t/88' });
    expect(resolveTopic({ scriptPath: SCRIPT, link: { topicId: 88, match: 'download' } }).match).toBe('manual');
  });

  it('nothing known: none; no script: noScript', () => {
    expect(resolveTopic({ scriptPath: SCRIPT })).toEqual({ state: 'none' });
    expect(resolveTopic({ record: { topicId: 'x' }, scriptPath: SCRIPT })).toEqual({ state: 'none' });
    expect(resolveTopic({ record: { topicId: 7 }, scriptPath: null })).toEqual({ state: 'noScript' });
  });
});

describe('Get tags, success', () => {
  it('replaces the record; userTags, hiddenTags and other videos stay byte-identical', async () => {
    const settings = libraryWithRecord();
    const userBefore = JSON.stringify(settings._store['library.userTags']);
    const hiddenBefore = JSON.stringify(settings._store['library.hiddenTags']);
    const otherBefore = JSON.stringify(settings._store[SCRIPT_TAGS_KEY]['C:/v/Other.mp4']);
    const topicMeta = fakeMain(OK);

    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn,
      queue: new TagFetchQueue({ topicMeta }), now: () => 1700000000000,
    });

    expect(topicMeta).toHaveBeenCalledWith(7);
    expect(outcome).toMatchObject({ kind: 'success', count: 3, newCount: 2 });
    // Replaced, not merged: old-tag is gone.
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO]).toEqual({
      tags: [{ id: 1, name: 'pov' }, { id: 2, name: 'the-handy' }, { id: null, name: 'len-10-25' }],
      topicId: 7,
      topicUrl: 'https://discuss.eroscripts.com/t/scene/7',
      title: 'Scene [Multi-Axis]',
      creator: 'Ramie',
      scriptPath: SCRIPT,
      match: 'download',
      source: 'eroscripts',
      savedAt: 1700000000000,
      fetchedAt: 1700000000000,
      stale: false,
    });
    expect(JSON.stringify(settings._store['library.userTags'])).toBe(userBefore);
    expect(JSON.stringify(settings._store['library.hiddenTags'])).toBe(hiddenBefore);
    expect(JSON.stringify(settings._store[SCRIPT_TAGS_KEY]['C:/v/Other.mp4'])).toBe(otherBefore);
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set.mock.calls[0][0]).toBe(SCRIPT_TAGS_KEY);
  });

  it('a tag you hid stays hidden after the refresh', async () => {
    const settings = libraryWithRecord();
    await getTagsForVideo({ videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn, queue: new TagFetchQueue({ topicMeta: fakeMain(OK) }) });
    const tags = effectiveTags(VIDEO, {
      user: { [VIDEO]: ['cosplay'] }, eroscripts: settings._store[SCRIPT_TAGS_KEY],
    }, { scriptPath: SCRIPT, hidden: settings._store['library.hiddenTags'] });
    const keys = tags.map((tag) => tag.key);
    expect(keys).not.toContain('content:pov');
    expect(keys.length).toBeGreaterThan(1);
  });

  it('an empty tag list is stored (a real "no tags")', async () => {
    const settings = libraryWithRecord();
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn,
      queue: new TagFetchQueue({ topicMeta: fakeMain({ ...OK, meta: { ...META, tags: [] } }) }),
    });
    expect(outcome).toMatchObject({ kind: 'success', count: 0 });
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO].tags).toEqual([]);
    expect(outcomeMessage(outcome)).toEqual({ key: FETCH_KEYS.successEmpty });
  });

  it('a post you linked is stored with how you found it and the current script', async () => {
    const settings = makeSettings();
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn,
      link: { topicId: 7, match: 'search' }, queue: new TagFetchQueue({ topicMeta: fakeMain(OK) }),
    });
    expect(outcome.kind).toBe('success');
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO]).toMatchObject({ match: 'search', scriptPath: SCRIPT, topicId: 7 });
  });
});

describe('Get tags, failures leave the record byte-identical', () => {
  const CASES = [
    ['401', { ok: false, outcome: 'authExpired', status: 401, authExpired: true, errorCode: 'accessDenied' }, 'loginAgain'],
    ['403', { ok: false, outcome: 'authExpired', status: 403, authExpired: true, errorCode: 'accessDenied' }, 'loginAgain'],
    ['429', { ok: false, outcome: 'rateLimited', status: 429, retryAfter: 42, errorCode: 'rateLimited' }, 'cooldown'],
    ['network', { ok: false, outcome: 'network', errorCode: 'network', error: 'ECONNRESET' }, 'error'],
    ['502', { ok: false, outcome: 'failed', status: 502, errorCode: 'topicFailed' }, 'error'],
    ['200 without tags', { ok: true, outcome: 'ok', status: 200, meta: { ...META, tags: null } }, 'unknown'],
    ['main says logged out', { ok: false, outcome: 'loginRequired', errorCode: 'loginRequired' }, 'loginRequired'],
  ];

  it.each(CASES)('%s', async (_name, answer, kind) => {
    const settings = libraryWithRecord();
    const before = JSON.stringify(settings._store);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn,
      queue: new TagFetchQueue({ topicMeta: fakeMain(answer) }),
    });
    expect(outcome.kind).toBe(kind);
    expect(settings.set).not.toHaveBeenCalled();
    expect(JSON.stringify(settings._store)).toBe(before);
  });

  it('an IPC that throws is a network error and writes nothing', async () => {
    const settings = libraryWithRecord();
    const before = JSON.stringify(settings._store);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn,
      queue: new TagFetchQueue({ topicMeta: vi.fn(async () => { throw new Error('ipc gone'); }) }),
    });
    expect(outcome).toMatchObject({ kind: 'error', answer: { outcome: 'network', errorCode: 'network' } });
    expect(JSON.stringify(settings._store)).toBe(before);
  });
});

describe('Get tags, 404', () => {
  it('marks the record stale and keeps its tags', async () => {
    const record = { tags: [{ id: 1, name: 'pov' }, 'vr'], topicId: 7, topicUrl: 'u', scriptPath: SCRIPT, match: 'download', source: 'eroscripts', savedAt: 5, fetchedAt: 6, stale: false };
    const settings = libraryWithRecord(record);
    const userBefore = JSON.stringify(settings._store['library.userTags']);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn,
      queue: new TagFetchQueue({ topicMeta: fakeMain({ ok: false, outcome: 'notFound', status: 404 }) }),
    });
    expect(outcome).toMatchObject({ kind: 'gone', marked: true });
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO]).toEqual({ ...record, stale: true });
    expect(JSON.stringify(settings._store['library.userTags'])).toBe(userBefore);
    // The tags still count.
    const keys = effectiveTags(VIDEO, { eroscripts: settings._store[SCRIPT_TAGS_KEY] }, { scriptPath: SCRIPT }).map((tag) => tag.key);
    expect(keys).toEqual(expect.arrayContaining(['content:pov']));
  });

  it('a 404 for a post that has no record (metadata only) writes nothing', async () => {
    const settings = makeSettings({ 'library.userTags': {} });
    const before = JSON.stringify(settings._store);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn,
      scriptMeta: { topicId: 55, topicUrl: 'https://discuss.eroscripts.com/t/a/55' },
      queue: new TagFetchQueue({ topicMeta: fakeMain({ ok: false, outcome: 'notFound', status: 404 }) }),
    });
    expect(outcome).toMatchObject({ kind: 'gone', marked: false });
    expect(JSON.stringify(settings._store)).toBe(before);
  });
});

describe('Get tags on a swapped script', () => {
  it('is not offered, sends nothing, writes nothing, and says the post is for another script', async () => {
    const record = { tags: ['pov'], topicId: 7, topicUrl: 'u', scriptPath: OLD_SCRIPT, source: 'eroscripts', savedAt: 1 };
    const settings = libraryWithRecord(record);
    const before = JSON.stringify(settings._store);
    const topicMeta = fakeMain(OK);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn, queue: new TagFetchQueue({ topicMeta }),
    });
    expect(outcome).toMatchObject({ kind: 'notOffered', resolution: { state: 'otherScript', scriptName: 'old.funscript' } });
    expect(topicMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(settings._store)).toBe(before);
    const translate = (key, params) => `${key}|${JSON.stringify(params ?? {})}`;
    expect(outcomeText(outcome, translate)).toBe(`${FETCH_KEYS.otherScript}|{"name":"old.funscript"}`);
    expect(buttonState({ resolution: outcome.resolution, loggedIn: true, pending: false, cooldownSeconds: 0 }).offered).toBe(false);
    // ...and what the Tags section shows agrees: the old post's tags are not shown.
    expect(effectiveTags(VIDEO, { eroscripts: settings._store[SCRIPT_TAGS_KEY] }, { scriptPath: SCRIPT })).toEqual([]);
  });
});

describe('the login (no anonymous requests)', () => {
  it('logged out: no request, nothing written, loginRequired', async () => {
    const settings = libraryWithRecord();
    const before = JSON.stringify(settings._store);
    const topicMeta = fakeMain(OK);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: () => false, queue: new TagFetchQueue({ topicMeta }),
    });
    expect(outcome).toEqual({ kind: 'loginRequired' });
    expect(topicMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(settings._store)).toBe(before);
  });

  it('"Log in to get tags…": logs in first, then runs once', async () => {
    const settings = libraryWithRecord();
    const topicMeta = fakeMain(OK);
    const login = vi.fn(async () => true);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: () => false, login, queue: new TagFetchQueue({ topicMeta }),
    });
    expect(login).toHaveBeenCalledTimes(1);
    expect(topicMeta).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('success');
  });

  it('a cancelled login sends nothing', async () => {
    const topicMeta = fakeMain(OK);
    const outcome = await getTagsForVideo({
      videoPath: VIDEO, scriptPath: SCRIPT, settings: libraryWithRecord(), isLoggedIn: () => false,
      login: async () => false, queue: new TagFetchQueue({ topicMeta }),
    });
    expect(outcome.kind).toBe('loginRequired');
    expect(topicMeta).not.toHaveBeenCalled();
  });

  it('the button asks you to log in when logged out', () => {
    const resolution = { state: 'known', topicId: 7 };
    expect(buttonState({ resolution, loggedIn: false, pending: false, cooldownSeconds: 0 }))
      .toEqual({ offered: true, disabled: false, busy: false, labelKey: FETCH_KEYS.loginButton });
    expect(buttonState({ resolution, loggedIn: true, pending: false, cooldownSeconds: 0 }).labelKey).toBe(FETCH_KEYS.button);
    expect(buttonState({ resolution, loggedIn: true, pending: true, cooldownSeconds: 0 }))
      .toEqual({ offered: true, disabled: true, busy: true, labelKey: FETCH_KEYS.running });
  });
});

describe('one request at a time, and the 429 cooldown', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-18T10:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  function slowMain(answerFor, ms = 300) {
    const calls = [];
    const topicMeta = vi.fn((topicId) => {
      const call = { topicId, start: Date.now(), end: null };
      calls.push(call);
      return new Promise((resolve) => setTimeout(() => { call.end = Date.now(); resolve(answerFor(topicId)); }, ms));
    });
    return { topicMeta, calls };
  }

  it('two presses on two videos: the second request starts at least 1 s after the first ends', async () => {
    const { topicMeta, calls } = slowMain(() => OK);
    const queue = new TagFetchQueue({ topicMeta });
    const a = getTagsForVideo({ videoPath: 'C:/v/A.mp4', scriptPath: 'C:/v/A.funscript', settings: makeSettings(), link: { topicId: 1 }, isLoggedIn: loggedIn, queue });
    const b = getTagsForVideo({ videoPath: 'C:/v/B.mp4', scriptPath: 'C:/v/B.funscript', settings: makeSettings(), link: { topicId: 2 }, isLoggedIn: loggedIn, queue });

    await vi.advanceTimersByTimeAsync(0);
    expect(topicMeta).toHaveBeenCalledTimes(1);
    expect(queue.isPending('C:/v/A.mp4')).toBe(true);
    expect(queue.isPending('C:/v/B.mp4')).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([a, b]);
    expect(calls.map((c) => c.topicId)).toEqual([1, 2]);
    expect(calls[1].start - calls[0].end).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect(queue.isPending('C:/v/A.mp4')).toBe(false);
  });

  it('a second press on the same video gets the same request, not another', async () => {
    const { topicMeta } = slowMain(() => OK);
    const queue = new TagFetchQueue({ topicMeta });
    const input = { videoPath: VIDEO, scriptPath: SCRIPT, settings: libraryWithRecord(), isLoggedIn: loggedIn, queue };
    const first = getTagsForVideo(input);
    const second = getTagsForVideo(input);
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(topicMeta).toHaveBeenCalledTimes(1);
  });

  it('a 429 disables every Get tags button for Retry-After, sends nothing meanwhile, then comes back', async () => {
    const { topicMeta } = slowMain(() => ({ ok: false, outcome: 'rateLimited', status: 429, retryAfter: 42 }), 10);
    const queue = new TagFetchQueue({ topicMeta });
    const changes = [];
    queue.onChange((state) => changes.push(state.cooldownSeconds));
    const settings = libraryWithRecord();
    const before = JSON.stringify(settings._store);

    const first = getTagsForVideo({ videoPath: VIDEO, scriptPath: SCRIPT, settings, isLoggedIn: loggedIn, queue });
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toEqual({ kind: 'cooldown', seconds: 42 });
    expect(JSON.stringify(settings._store)).toBe(before);

    // Every button, for any video, is disabled with the countdown.
    const other = { state: 'known', topicId: 99 };
    expect(buttonState({ resolution: other, loggedIn: true, pending: false, cooldownSeconds: queue.cooldownSeconds() }))
      .toEqual({ offered: true, disabled: true, busy: false, labelKey: FETCH_KEYS.cooldown, params: { seconds: 42 } });
    const translate = (key, params) => `${key}|${JSON.stringify(params ?? {})}`;
    expect(outcomeText(await first, translate)).toBe(`${FETCH_KEYS.cooldown}|{"seconds":42}`);

    // A press on another video during the cooldown sends nothing.
    const during = await getTagsForVideo({
      videoPath: 'C:/v/Other.mp4', scriptPath: 'C:/v/Other.funscript', settings, isLoggedIn: loggedIn, queue,
    });
    expect(during.kind).toBe('cooldown');
    expect(topicMeta).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(41_000);
    expect(queue.cooldownSeconds()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.cooldownSeconds()).toBe(0);
    expect(changes.at(-1)).toBe(0); // the buttons were told it is over
    expect(buttonState({ resolution: other, loggedIn: true, pending: false, cooldownSeconds: queue.cooldownSeconds() }).disabled).toBe(false);
  });

  it('a request waiting behind the one that got the 429 sends nothing', async () => {
    const { topicMeta } = slowMain(() => ({ ok: false, outcome: 'rateLimited', status: 429, retryAfter: 5 }), 100);
    const queue = new TagFetchQueue({ topicMeta });
    const a = getTagsForVideo({ videoPath: 'C:/v/A.mp4', scriptPath: 'C:/v/A.funscript', settings: makeSettings(), link: { topicId: 1 }, isLoggedIn: loggedIn, queue });
    const b = getTagsForVideo({ videoPath: 'C:/v/B.mp4', scriptPath: 'C:/v/B.funscript', settings: makeSettings(), link: { topicId: 2 }, isLoggedIn: loggedIn, queue });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await a).kind).toBe('cooldown');
    expect((await b).kind).toBe('cooldown');
    expect(topicMeta).toHaveBeenCalledTimes(1);
  });

  it('a 429 without Retry-After waits 60 s', async () => {
    const queue = new TagFetchQueue({ topicMeta: fakeMain({ ok: false, outcome: 'rateLimited', status: 429, retryAfter: null }) });
    const outcome = await getTagsForVideo({ videoPath: VIDEO, scriptPath: SCRIPT, settings: libraryWithRecord(), isLoggedIn: loggedIn, queue });
    expect(outcome).toEqual({ kind: 'cooldown', seconds: DEFAULT_COOLDOWN_S });
  });
});

describe('the words', () => {
  const translate = (key, params) => `${key}|${JSON.stringify(params ?? {})}`;

  it('each outcome has its line', () => {
    expect(outcomeText({ kind: 'success', count: 7, newCount: 2 }, translate)).toBe(`${FETCH_KEYS.success}|{"count":7,"newCount":2}`);
    expect(outcomeText({ kind: 'unknown' }, translate)).toBe(`${FETCH_KEYS.unknown}|{}`);
    expect(outcomeText({ kind: 'gone' }, translate)).toBe(`${FETCH_KEYS.gone}|{}`);
    expect(outcomeText({ kind: 'loginAgain' }, translate)).toBe(`${FETCH_KEYS.loginAgain}|{}`);
    expect(outcomeText({ kind: 'loginRequired' }, translate)).toBe(`${FETCH_KEYS.loginRequired}|{}`);
    expect(outcomeText({ kind: 'notOffered', resolution: { state: 'none' } }, translate)).toBe(`${FETCH_KEYS.noPost}|{}`);
    expect(outcomeText({ kind: 'notOffered', resolution: { state: 'noScript' } }, translate)).toBe(`${FETCH_KEYS.noScript}|{}`);
  });

  it('network and other failures use the existing EroScripts error words', () => {
    expect(outcomeText({ kind: 'error', answer: { errorCode: 'network' } }, translate)).toBe('eroscripts.error.network|{"status":""}');
    expect(outcomeText({ kind: 'error', answer: { errorCode: 'topicFailed', status: 502 } }, translate)).toBe('eroscripts.error.topicFailed|{"status":502}');
  });
});
