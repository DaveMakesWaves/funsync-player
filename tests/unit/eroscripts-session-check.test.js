/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The EroScripts session check, main side (Dave, 2026-11-18): "there should
// be some sort of assessment we can do to see if the last login has timed
// out because just showing no results while the top bar says it's connected".
//
// Root cause pinned here: the forum answers `/session/current.json` with an
// empty 404 when the cookie is no longer good, and validateSession read every
// non-401/403 failure as "valid", so a timed-out login stayed "connected"
// while its searches came back empty (the forum reads a dead cookie as an
// anonymous visitor). Now one classifier decides, and only a definite
// "not logged in" is 'expired'; a network error, timeout, 5xx or Cloudflare
// page is 'unknown' and changes nothing.
//
// No forum is contacted: every answer is a fake `fetch`.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// The module's logger is CommonJS; vi.mock cannot reach it. Silence the SAME
// instance (see eroscripts-auth-expiry.test.js for why this matters).
const log = (await import('../../electron/logger.js')).default;
const {
  EroScriptsAPI, classifySessionAnswer, EROSCRIPTS_USER_AGENT,
  SESSION_CHECK_TTL_MS, SESSION_RECHECK_MS,
} = await import('../../electron/eroscripts-api.js');

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

function response({ status = 200, body = '', headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
    clone() { return this; },
  };
}

// What the forum answers (Discourse SessionController#current), and what
// stands in front of it (Cloudflare).
const LOGGED_IN = () => response({ body: { current_user: { id: 1, username: 'dave' } } });
const LOGGED_OUT_404 = () => response({ status: 404, body: '' });
const CF_CHALLENGE = () => response({
  status: 403, body: '<!DOCTYPE html><html><title>Just a moment...</title></html>', headers: { 'cf-mitigated': 'challenge' },
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function loggedInApi() {
  const api = new EroScriptsAPI();
  api.restoreSession('TESTCOOKIE', 'dave');
  return api;
}

describe('classifySessionAnswer: which answers mean valid, expired, could not check', () => {
  it.each([
    ['200 with the user', { status: 200, text: '{"current_user":{"username":"dave"}}' }, 'valid'],
    ['404, empty (the forum\'s logged-out answer)', { status: 404, text: '' }, 'expired'],
    ['404 with a JSON error', { status: 404, text: '{"errors":["not found"]}' }, 'expired'],
    ['403 with the forum\'s JSON error (a bad token)', { status: 403, text: '{"errors":["invalid access"],"error_type":"invalid_access"}' }, 'expired'],
    ['401, empty', { status: 401, text: '' }, 'expired'],
    ['200 with current_user: null', { status: 200, text: '{"current_user":null}' }, 'expired'],
    ['any JSON answer with Discourse-Logged-Out: 1', { status: 200, text: '{}', headers: { 'discourse-logged-out': '1' } }, 'expired'],
    ['403 Cloudflare challenge (HTML + cf-mitigated)', { status: 403, text: '<!DOCTYPE html><html>Just a moment</html>', headers: { 'cf-mitigated': 'challenge' } }, 'unknown'],
    ['403 Cloudflare block page (HTML)', { status: 403, text: '<html><body>Sorry, you have been blocked</body></html>' }, 'unknown'],
    ['cf-mitigated: challenge with an empty body', { status: 403, text: '', headers: { 'cf-mitigated': 'challenge' } }, 'unknown'],
    ['404 as an HTML page (a proxy, not the forum)', { status: 404, text: '<!DOCTYPE html><html>Not Found</html>' }, 'unknown'],
    ['200 HTML (the "high load" page, a login page)', { status: 200, text: '<!DOCTYPE html><html>experiencing high load</html>' }, 'unknown'],
    ['200 HTML with Discourse-Logged-Out (not the JSON answer)', { status: 200, text: '<html></html>', headers: { 'discourse-logged-out': '1' } }, 'unknown'],
    ['200 JSON of another shape', { status: 200, text: '{"foo":1}' }, 'unknown'],
    ['200 JSON, a user without a name', { status: 200, text: '{"current_user":{"id":1}}' }, 'unknown'],
    ['200, empty', { status: 200, text: '' }, 'unknown'],
    ['200, not JSON', { status: 200, text: 'oops' }, 'unknown'],
    ['429', { status: 429, text: '' }, 'unknown'],
    ['500', { status: 500, text: '' }, 'unknown'],
    ['502', { status: 502, text: '{"errors":["bad gateway"]}' }, 'unknown'],
    ['503', { status: 503, text: '' }, 'unknown'],
    ['302', { status: 302, text: '' }, 'unknown'],
  ])('%s -> %s', (_name, answer, state) => {
    const headers = { get: (n) => answer.headers?.[n.toLowerCase()] ?? null };
    expect(classifySessionAnswer({ ...answer, headers }).state).toBe(state);
  });

  it('a valid answer names the user', () => {
    expect(classifySessionAnswer({ status: 200, text: '{"current_user":{"username":" dave "}}' })).toEqual({ state: 'valid', username: 'dave' });
  });
});

describe('checkSession: one cheap request, with the shared User-Agent', () => {
  it('logged out: nothing is sent', async () => {
    globalThis.fetch = vi.fn();
    const api = new EroScriptsAPI();
    expect(await api.checkSession()).toEqual({ state: 'loggedOut' });
    expect(await api.checkSession({ force: true })).toEqual({ state: 'loggedOut' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('asks /session/current.json with the cookie and the shared User-Agent', async () => {
    globalThis.fetch = vi.fn(async () => LOGGED_IN());
    const api = loggedInApi();
    expect(await api.checkSession()).toMatchObject({ state: 'valid', status: 200, username: 'dave' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://discuss.eroscripts.com/session/current.json');
    expect(init.headers['User-Agent']).toBe(EROSCRIPTS_USER_AGENT);
    expect(init.headers.Cookie).toBe('_t=TESTCOOKIE');
  });

  it('the forum\'s logged-out answer (empty 404) is expired', async () => {
    globalThis.fetch = vi.fn(async () => LOGGED_OUT_404());
    expect((await loggedInApi().checkSession()).state).toBe('expired');
  });

  it('a network error, a timeout, a 5xx or Cloudflare could not check', async () => {
    const api = loggedInApi();
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect((await api.checkSession({ force: true })).state).toBe('unknown');

    globalThis.fetch = vi.fn(async () => response({ status: 503 }));
    expect((await api.checkSession({ force: true })).state).toBe('unknown');

    globalThis.fetch = vi.fn(async () => CF_CHALLENGE());
    expect((await api.checkSession({ force: true })).state).toBe('unknown');

    // A hung connection: aborted after the timeout.
    api._sessionCheckTimeoutMs = 5;
    globalThis.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    expect((await api.checkSession({ force: true })).state).toBe('unknown');
    // It writes nothing and logs nobody out.
    expect(api.isLoggedIn).toBe(true);
  });

  it('even "expired" logs nobody out in main: the renderer acts on it', async () => {
    globalThis.fetch = vi.fn(async () => LOGGED_OUT_404());
    const api = loggedInApi();
    await api.checkSession();
    expect(api.isLoggedIn).toBe(true);
  });
});

describe('the kept answer: opening things again does not ask again', () => {
  it('a second check within the window sends nothing; past it, one request', async () => {
    let now = 1_000_000;
    globalThis.fetch = vi.fn(async () => LOGGED_IN());
    const api = loggedInApi();
    api._now = () => now;
    await api.checkSession();
    now += SESSION_CHECK_TTL_MS - 1;
    expect(await api.checkSession()).toMatchObject({ state: 'valid', cached: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    now += 2;
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('"could not check" is asked again sooner (30 s), not on every open', async () => {
    let now = 1_000_000;
    globalThis.fetch = vi.fn(async () => response({ status: 503 }));
    const api = loggedInApi();
    api._now = () => now;
    await api.checkSession();
    now += SESSION_RECHECK_MS - 1;
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    now += 2;
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('a login resets it: the next check asks again (the same cookie too)', async () => {
    globalThis.fetch = vi.fn(async () => LOGGED_IN());
    const api = loggedInApi();
    await api.checkSession();
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    api.restoreSession('TESTCOOKIE', 'dave');
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    api.restoreSession('NEWCOOKIE', 'dave');
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch.mock.calls[2][1].headers.Cookie).toBe('_t=NEWCOOKIE');
  });

  it('a logout (an expiry) resets it: logged out nothing is asked, and a new login asks again', async () => {
    globalThis.fetch = vi.fn(async () => LOGGED_IN());
    const api = loggedInApi();
    await api.checkSession();
    api.logout();
    expect((await api.checkSession()).state).toBe('loggedOut');
    api.restoreSession('TESTCOOKIE', 'dave');
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('force (after a 401 / 403) asks again; checks asked while one runs share it', async () => {
    let release;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { release = () => resolve(LOGGED_OUT_404()); }));
    const api = loggedInApi();
    const a = api.checkSession();
    const b = api.checkSession({ force: true });
    release();
    expect((await a).state).toBe('expired');
    expect((await b).state).toBe('expired');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    globalThis.fetch = vi.fn(async () => LOGGED_IN());
    expect((await api.checkSession()).state).toBe('expired'); // kept
    expect((await api.checkSession({ force: true })).state).toBe('valid');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('an answer about the old cookie that lands after a login is not kept', async () => {
    let release;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { release = () => resolve(LOGGED_OUT_404()); }));
    const api = loggedInApi();
    const old = api.checkSession();
    api.restoreSession('NEWCOOKIE', 'dave');
    release();
    expect((await old).state).toBe('expired');
    globalThis.fetch = vi.fn(async () => LOGGED_IN());
    expect((await api.checkSession()).state).toBe('valid');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('validateSession (the panel\'s start-up check) goes through the same classifier', () => {
  it('the forum\'s logged-out 404 is invalid (it read as valid before 2026-11-18)', async () => {
    globalThis.fetch = vi.fn(async () => LOGGED_OUT_404());
    expect(await loggedInApi().validateSession()).toEqual({ valid: false });
  });

  it('a Cloudflare page or a network error keeps the session', async () => {
    globalThis.fetch = vi.fn(async () => CF_CHALLENGE());
    expect(await loggedInApi().validateSession()).toEqual({ valid: true });
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await loggedInApi().validateSession()).toEqual({ valid: true });
  });

  it('a logged-in answer is valid and is kept for the next open', async () => {
    globalThis.fetch = vi.fn(async () => LOGGED_IN());
    const api = loggedInApi();
    expect(await api.validateSession()).toEqual({ valid: true });
    await api.checkSession();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('search sends nothing logged out', () => {
  it('no cookie: no request, a loginRequired answer the renderer words', async () => {
    globalThis.fetch = vi.fn();
    const answer = await new EroScriptsAPI().search('alpha');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ results: [], errorCode: 'loginRequired', loginRequired: true });
  });

  it('logged in, it searches as before', async () => {
    globalThis.fetch = vi.fn(async () => response({ body: { topics: [], posts: [], users: [] } }));
    const answer = await loggedInApi().search('alpha');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(answer.loginRequired).toBeUndefined();
  });
});
