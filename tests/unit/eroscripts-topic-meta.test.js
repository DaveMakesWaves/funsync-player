/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// "Get tags from EroScripts" in main (video options design (c), 2026-11-18):
// parseTopicMeta, getTopicMeta's outcomes (one GET /t/{id}.json, logged in
// only, Retry-After honoured), getTopicAttachments' tags / title / creator,
// the User-Agent on every request and in the login window (the real Chromium
// UA plus FunSyncPlayer/<version>: Dave, 2026-11-18), and the IPC + preload
// wiring. No real forum: fetch is a fake throughout.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// See eroscripts-auth-expiry.test.js: vi.mock cannot silence a CJS require,
// so the module's own logger is switched off (never Dave's real main.log).
const log = (await import('../../electron/logger.js')).default;
const {
  EroScriptsAPI, parseTopicMeta, parseRetryAfter, eroscriptsUserAgent, EROSCRIPTS_USER_AGENT,
} = await import('../../electron/eroscripts-api.js');

const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

let prevFileLevel;
let prevConsoleLevel;
beforeAll(() => {
  prevFileLevel = log.transports.file.level;
  prevConsoleLevel = log.transports.console.level;
  log.transports.file.level = false;
  log.transports.console.level = false;
});
afterAll(() => {
  log.transports.file.level = prevFileLevel;
  log.transports.console.level = prevConsoleLevel;
});

// The fields /t/{id}.json carries that matter here (shape as Discourse sends
// it: tag objects, `details.created_by`, the first post in post_stream).
const TOPIC_JSON = {
  id: 300701,
  title: 'Sybian Aiko',
  fancy_title: 'Sybian Aiko',
  slug: 'sybian-aiko',
  closed: false,
  archived: false,
  deleted_at: null,
  tags: [
    { id: 288, name: 'the-handy', slug: 'the-handy' },
    { id: 573, name: 'non-vr', slug: 'non-vr' },
    { id: 435, name: 'len-10-25', slug: 'len-10-25' },
  ],
  details: { created_by: { id: 9, username: 'Ramie', name: 'R' } },
  post_stream: {
    posts: [{
      id: 709814, post_number: 1, username: 'Ramie',
      cooked: '<p><a class="attachment" href="/uploads/short-url/abc.funscript">Sybian Aiko.funscript</a></p>',
    }],
  },
};

function response({ status = 200, body = '', headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    clone() { return this; },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('parseTopicMeta', () => {
  it('reads id, slug, title, creator, tags (with ids) and state from the topic JSON', () => {
    expect(parseTopicMeta(TOPIC_JSON)).toEqual({
      topicId: 300701,
      slug: 'sybian-aiko',
      title: 'Sybian Aiko',
      creator: 'Ramie',
      tags: [{ id: 288, name: 'the-handy' }, { id: 573, name: 'non-vr' }, { id: 435, name: 'len-10-25' }],
      status: 'open',
      url: 'https://discuss.eroscripts.com/t/sybian-aiko/300701',
    });
  });

  it('reads plain string tags (older Discourse) too', () => {
    expect(parseTopicMeta({ ...TOPIC_JSON, tags: ['osr2', 'vr'] }).tags).toEqual([{ name: 'osr2' }, { name: 'vr' }]);
  });

  it('a missing tags list is unknown (null), never "no tags"; an empty list is a real "no tags"', () => {
    const { tags: _omit, ...noTags } = TOPIC_JSON;
    expect(parseTopicMeta(noTags).tags).toBeNull();
    expect(parseTopicMeta({ ...TOPIC_JSON, tags: null }).tags).toBeNull();
    expect(parseTopicMeta({ ...TOPIC_JSON, tags: [] }).tags).toEqual([]);
  });

  it('drops blank, duplicate and over-long tags, and keeps at most 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => `tag-${i}`);
    expect(parseTopicMeta({ ...TOPIC_JSON, tags: ['vr', '', '  ', null, 'VR', { id: 'x', name: 'pov' }, 'x'.repeat(201)] }).tags)
      .toEqual([{ name: 'vr' }, { name: 'pov' }]);
    expect(parseTopicMeta({ ...TOPIC_JSON, tags: many }).tags).toHaveLength(200);
  });

  it('falls back to the first post for the creator and to fancy_title for the title', () => {
    const meta = parseTopicMeta({ ...TOPIC_JSON, title: undefined, fancy_title: 'Luna &amp; Sue', details: {} });
    expect(meta.title).toBe('Luna & Sue');
    expect(meta.creator).toBe('Ramie');
  });

  it('names the topic state', () => {
    expect(parseTopicMeta({ ...TOPIC_JSON, closed: true }).status).toBe('closed');
    expect(parseTopicMeta({ ...TOPIC_JSON, archived: true }).status).toBe('archived');
    expect(parseTopicMeta({ ...TOPIC_JSON, deleted_at: '2026-11-01T00:00:00Z' }).status).toBe('deleted');
  });

  it('is null for anything that is not a topic', () => {
    for (const bad of [null, undefined, 'x', [], {}, { id: 0 }, { id: -3 }, { id: '12' }, { id: 1.5 }]) {
      expect(parseTopicMeta(bad)).toBeNull();
    }
  });

  it('never puts an odd slug into the post link', () => {
    expect(parseTopicMeta({ ...TOPIC_JSON, slug: '../evil?x=1' }).url).toBe('https://discuss.eroscripts.com/t/topic/300701');
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates, and caps at an hour', () => {
    const now = Date.parse('2026-11-18T10:00:00Z');
    expect(parseRetryAfter('42', now)).toBe(42);
    expect(parseRetryAfter(' 7 ', now)).toBe(7);
    expect(parseRetryAfter('Wed, 18 Nov 2026 10:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Wed, 18 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('86400', now)).toBe(3600);
  });

  it('is null when absent or unreadable', () => {
    for (const bad of [null, undefined, '', 'soon', '-5', '1.5']) expect(parseRetryAfter(bad)).toBeNull();
  });
});

describe('getTopicMeta', () => {
  let api;
  beforeEach(() => {
    api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
  });

  it('makes exactly one GET of /t/{id}.json and returns the meta', async () => {
    globalThis.fetch = vi.fn(async () => response({ body: TOPIC_JSON }));
    const answer = await api.getTopicMeta(300701);
    expect(answer).toMatchObject({ ok: true, outcome: 'ok', status: 200 });
    expect(answer.meta.tags.map((t) => t.name)).toEqual(['the-handy', 'non-vr', 'len-10-25']);
    expect(answer.meta.creator).toBe('Ramie');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://discuss.eroscripts.com/t/300701.json');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('never resolves short upload URLs, searches, or reads another topic', async () => {
    const withShort = {
      ...TOPIC_JSON,
      post_stream: { posts: [{ post_number: 1, cooked: '<a href="upload://abc.funscript">x</a>' }] },
    };
    globalThis.fetch = vi.fn(async () => response({ body: withShort }));
    await api.getTopicMeta(300701);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts the id as digits, and refuses anything else without a request', async () => {
    globalThis.fetch = vi.fn(async () => response({ body: TOPIC_JSON }));
    expect((await api.getTopicMeta('300701')).ok).toBe(true);
    for (const bad of [0, -1, 1.5, 'abc', '12/../13', null, {}, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await api.getTopicMeta(bad)).toMatchObject({ ok: false, outcome: 'invalid' });
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('logged out: no request at all (no anonymous requests)', async () => {
    api.logout();
    globalThis.fetch = vi.fn(async () => response({ body: TOPIC_JSON }));
    expect(await api.getTopicMeta(300701)).toMatchObject({ ok: false, outcome: 'loginRequired' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a topic with no tags list answers ok with tags null (unknown)', async () => {
    const { tags: _omit, ...noTags } = TOPIC_JSON;
    globalThis.fetch = vi.fn(async () => response({ body: noTags }));
    const answer = await api.getTopicMeta(300701);
    expect(answer.outcome).toBe('ok');
    expect(answer.meta.tags).toBeNull();
  });

  it.each([401, 403])('%i is authExpired', async (status) => {
    globalThis.fetch = vi.fn(async () => response({ status, body: { errors: ['no'] } }));
    expect(await api.getTopicMeta(1)).toMatchObject({ ok: false, outcome: 'authExpired', authExpired: true, errorCode: 'accessDenied', status });
  });

  it.each([404, 410])('%i is notFound (the post is gone)', async (status) => {
    globalThis.fetch = vi.fn(async () => response({ status, body: { errors: ['gone'] } }));
    expect(await api.getTopicMeta(1)).toMatchObject({ ok: false, outcome: 'notFound', status });
  });

  it('429 returns the Retry-After seconds', async () => {
    globalThis.fetch = vi.fn(async () => response({ status: 429, headers: { 'Retry-After': '42' } }));
    expect(await api.getTopicMeta(1)).toMatchObject({ ok: false, outcome: 'rateLimited', retryAfter: 42, errorCode: 'rateLimited' });
  });

  it('429 without a readable Retry-After answers null (the renderer then waits 60 s)', async () => {
    globalThis.fetch = vi.fn(async () => response({ status: 429, body: '<html>slow down</html>' }));
    expect(await api.getTopicMeta(1)).toMatchObject({ outcome: 'rateLimited', retryAfter: null });
    globalThis.fetch = vi.fn(async () => response({ status: 429, headers: { 'Retry-After': 'soon' } }));
    expect(await api.getTopicMeta(1)).toMatchObject({ outcome: 'rateLimited', retryAfter: null });
  });

  it('429 with an HTTP-date Retry-After counts the seconds to it', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    globalThis.fetch = vi.fn(async () => response({ status: 429, headers: { 'Retry-After': at } }));
    const { retryAfter } = await api.getTopicMeta(1);
    expect(retryAfter).toBeGreaterThanOrEqual(29);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });

  it('a request that does not complete is network', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await api.getTopicMeta(1)).toMatchObject({ ok: false, outcome: 'network', errorCode: 'network' });
  });

  it('any other status, or a body that is not a topic, is failed', async () => {
    globalThis.fetch = vi.fn(async () => response({ status: 502, body: 'Bad gateway' }));
    expect(await api.getTopicMeta(1)).toMatchObject({ ok: false, outcome: 'failed', errorCode: 'topicFailed', status: 502 });
    globalThis.fetch = vi.fn(async () => response({ status: 200, body: '<!DOCTYPE html><p>Cloudflare</p>' }));
    expect(await api.getTopicMeta(1)).toMatchObject({ ok: false, outcome: 'failed', status: 200 });
    globalThis.fetch = vi.fn(async () => response({ status: 200, body: { errors: ['x'] } }));
    expect(await api.getTopicMeta(1)).toMatchObject({ ok: false, outcome: 'failed' });
  });
});

describe('getTopicAttachments also returns the post\'s tags, title and creator', () => {
  it('from the same JSON, with no extra request', async () => {
    const api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    globalThis.fetch = vi.fn(async () => response({ body: TOPIC_JSON }));
    const answer = await api.getTopicAttachments(300701);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(answer.attachments).toHaveLength(1);
    expect(answer).toMatchObject({
      topicId: 300701,
      url: 'https://discuss.eroscripts.com/t/sybian-aiko/300701',
      title: 'Sybian Aiko',
      creator: 'Ramie',
      tags: [{ id: 288, name: 'the-handy' }, { id: 573, name: 'non-vr' }, { id: 435, name: 'len-10-25' }],
    });
  });

  it('tags stay unknown (null) when the JSON has no list', async () => {
    const api = new EroScriptsAPI();
    const { tags: _omit, ...noTags } = TOPIC_JSON;
    globalThis.fetch = vi.fn(async () => response({ body: noTags }));
    expect((await api.getTopicAttachments(300701)).tags).toBeNull();
  });
});

// The shape Dave chose (2026-11-18, option (b)): a normal Chrome UA, then the
// app. No Electron token, no npm package name.
const UA_SHAPE = /^Mozilla\/5\.0 \((Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10_15_7|X11; Linux x86_64)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+(\.\d+){0,3} Safari\/537\.36 FunSyncPlayer\/[0-9A-Za-z.+-]+$/;

function expectHonestBrowserShape(ua) {
  expect(ua).toMatch(UA_SHAPE);
  expect(ua.endsWith(` FunSyncPlayer/${PKG_VERSION}`)).toBe(true);
  expect(ua).not.toMatch(/Electron/i);
  expect(ua).not.toMatch(/funsync-player/);
}

// eroscripts-api.js loaded again with process.versions.chrome / platform set
// as Electron's main process has them (plain Node has no `chrome`).
const requireCjs = createRequire(import.meta.url);
function loadApiWith({ chrome, platform }) {
  const modPath = requireCjs.resolve('../../electron/eroscripts-api.js');
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const hadChrome = Object.prototype.hasOwnProperty.call(process.versions, 'chrome');
  const oldChrome = process.versions.chrome;
  Object.defineProperty(process.versions, 'chrome', { value: chrome, configurable: true, enumerable: true, writable: true });
  Object.defineProperty(process, 'platform', { ...platformDesc, value: platform });
  const cached = requireCjs.cache[modPath];
  delete requireCjs.cache[modPath];
  try {
    return requireCjs(modPath);
  } finally {
    // Put back whatever instance was there, for anything else in this worker.
    if (cached) requireCjs.cache[modPath] = cached;
    else delete requireCjs.cache[modPath];
    Object.defineProperty(process, 'platform', platformDesc);
    if (hadChrome) process.versions.chrome = oldChrome;
    else delete process.versions.chrome;
  }
}

describe('the User-Agent: the real Chromium UA plus FunSyncPlayer/<version> (Dave, 2026-11-18)', () => {
  it('has the shape of a normal Chrome UA with the app last, per OS', () => {
    const parts = { chrome: '134.0.6998.205', version: '0.9.2' };
    expect(eroscriptsUserAgent({ ...parts, platform: 'win32' })).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36 FunSyncPlayer/0.9.2');
    expect(eroscriptsUserAgent({ ...parts, platform: 'linux' })).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36 FunSyncPlayer/0.9.2');
    expect(eroscriptsUserAgent({ ...parts, platform: 'darwin' })).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36 FunSyncPlayer/0.9.2');
    expect(eroscriptsUserAgent({ ...parts, platform: 'freebsd' })).toMatch(/^Mozilla\/5\.0 \(X11; Linux x86_64\)/);
  });

  it('never carries stray characters: an odd part becomes 0', () => {
    for (const odd of [undefined, null, '', 'a b', '1.0\r\nX-Evil: 1', 'x'.repeat(41)]) {
      const ua = eroscriptsUserAgent({ chrome: odd, platform: 'win32', version: odd });
      expect(ua).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/0.0.0.0 Safari/537.36 FunSyncPlayer/0');
    }
    expect(eroscriptsUserAgent({ chrome: '1.2.3.4.5', platform: '__proto__', version: '1' })).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/0.0.0.0 Safari/537.36 FunSyncPlayer/1');
  });

  it('is built at runtime from process.versions.chrome and process.platform, with the package version', () => {
    const win = loadApiWith({ chrome: '134.0.6998.205', platform: 'win32' }).EROSCRIPTS_USER_AGENT;
    expect(win).toBe(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36 FunSyncPlayer/${PKG_VERSION}`);
    expectHonestBrowserShape(win);
    const linux = loadApiWith({ chrome: '140.0.7339.80', platform: 'linux' }).EROSCRIPTS_USER_AGENT;
    expect(linux).toBe(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36 FunSyncPlayer/${PKG_VERSION}`);
    expectHonestBrowserShape(linux);
  });

  it('the constant this process built has the same shape', () => {
    expectHonestBrowserShape(EROSCRIPTS_USER_AGENT);
  });

  it('every request the client makes sends it: session check, search, topic, short URLs, image, tags, download', async () => {
    const api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    const withShort = {
      ...TOPIC_JSON,
      post_stream: { posts: [{ post_number: 1, cooked: '<a href="upload://abc.funscript">abc.funscript</a><img src="/uploads/x.jpg">' }] },
    };
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/session/current.json')) return response({ body: { current_user: { username: 'dave' } } });
      if (url.includes('/search.json')) return response({ body: { topics: [], posts: [], users: [] } });
      if (url.includes('/uploads/lookup-urls')) return response({ body: [{ url: '/uploads/abc.funscript' }] });
      if (url.endsWith('.funscript')) return response({ body: '{"actions":[]}' });
      return response({ body: withShort });
    });

    await api.validateSession();
    await api.search('sybian');
    await api.getTopicAttachments(300701);
    await api.getTopicImage(300701);
    await api.getTopicMeta(300701);
    // A look only (checkOnly): fetched, never written.
    const target = path.join(os.tmpdir(), `funsync-ua-check-${process.pid}-never-written.funscript`);
    const got = await api.downloadFile('https://discuss.eroscripts.com/uploads/abc.funscript', target, { checkOnly: true });
    expect(got.success).toBe(true);
    expect(fs.existsSync(target)).toBe(false);

    const urls = globalThis.fetch.mock.calls.map(([url]) => url);
    expect(urls.some((u) => u.includes('/session/current.json'))).toBe(true);
    expect(urls.some((u) => u.includes('/search.json'))).toBe(true);
    expect(urls.some((u) => u.includes('/uploads/lookup-urls'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/uploads/abc.funscript'))).toBe(true);
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThanOrEqual(7);
    for (const [url, init] of globalThis.fetch.mock.calls) {
      expect(init?.headers?.['User-Agent'], url).toBe(EROSCRIPTS_USER_AGENT);
    }
  });

  it('a download from another host sends it too (without the cookie)', async () => {
    const api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    globalThis.fetch = vi.fn(async () => response({ body: '{}' }));
    await api._fetchDownload('https://cdn.example/x.funscript');
    const [, init] = globalThis.fetch.mock.calls[0];
    expect(init.headers['User-Agent']).toBe(EROSCRIPTS_USER_AGENT);
    expect(init.headers.Cookie).toBeUndefined();
  });

  it('the login window and the login\'s session check in main use the same constant', () => {
    const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
    expect(main).toMatch(/const \{ EroScriptsAPI, EROSCRIPTS_USER_AGENT(, installForumUserAgent)? \} = require\('\.\/eroscripts-api'\)/);
    const handlerStart = main.indexOf("ipcMain.handle('eroscripts-login-window'");
    const handlerEnd = main.indexOf("ipcMain.handle('eroscripts-logout'");
    expect(handlerStart).toBeGreaterThan(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const login = main.slice(handlerStart, handlerEnd);

    // The window: set once, on its session, before the window exists, so the
    // window and every later request of that session send it.
    const setters = login.match(/setUserAgent\([^)]*\)/g) || [];
    expect(setters).toEqual(['setUserAgent(EROSCRIPTS_USER_AGENT)']);
    expect(login).toMatch(/\bsess\.setUserAgent\(EROSCRIPTS_USER_AGENT\)/);
    expect(login.indexOf('sess.setUserAgent(')).toBeLessThan(login.indexOf('new BrowserWindow('));
    expect(login).not.toMatch(/userAgent\s*:/);

    // The session check after the login.
    const start = login.indexOf("'https://discuss.eroscripts.com/session/current.json'");
    expect(start).toBeGreaterThan(0);
    const fetchHeaders = login.slice(start, login.indexOf('});', start));
    expect(fetchHeaders).toMatch(/'User-Agent': EROSCRIPTS_USER_AGENT/);

    // No other User-Agent anywhere in main.js, and none hard-coded.
    expect(main.match(/'User-Agent':\s*[^,\n]+/g)).toEqual(["'User-Agent': EROSCRIPTS_USER_AGENT"]);
    expect(main.match(/setUserAgent\([^)]*\)/g)).toEqual(['setUserAgent(EROSCRIPTS_USER_AGENT)']);
    expect(main).not.toMatch(/Mozilla\/5\.0|Chrome\/\d/);
  });

  it('no Chrome version is hard-coded in eroscripts-api.js', () => {
    const src = fs.readFileSync(new URL('../../electron/eroscripts-api.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Chrome\/\d/);
    expect(src.match(/'User-Agent':\s*[^,\n}]+/g)).toEqual(["'User-Agent': USER_AGENT"]);
  });
});

describe('IPC and preload', () => {
  it('main has one eroscripts-topic-meta handler that calls getTopicMeta', () => {
    const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
    const handlers = main.match(/ipcMain\.handle\('eroscripts-topic-meta'/g) || [];
    expect(handlers).toHaveLength(1);
    expect(main).toMatch(/ipcMain\.handle\('eroscripts-topic-meta', async \(_event, topicId\) => \{\s*return eroScripts\.getTopicMeta\(topicId\);/);
  });

  it('preload exposes eroscriptsTopicMeta on that channel', () => {
    const preload = fs.readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8');
    expect(preload).toMatch(/eroscriptsTopicMeta: \(topicId\) => ipcRenderer\.invoke\('eroscripts-topic-meta', topicId\),/);
  });
});
