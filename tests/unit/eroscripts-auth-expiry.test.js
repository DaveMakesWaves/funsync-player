// EroScripts session-expiry contract.
//
// Regression (Dave, 2026-08-05): his session expired server-side, but
// FunSync kept showing "connected" and script-found notifications silently
// stopped. Root cause was that the API reported the failure and the
// auto-match caller destructured `results` only, so a 403 arrived as an
// empty array — indistinguishable from "no script exists for this video".
//
// These tests pin the machine-readable half of that contract.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// `vi.mock` CANNOT silence this module's logging: eroscripts-api.js is
// CommonJS and does `require('./logger')`, and vi.mock only intercepts ESM
// `import` (see the vitest-gotchas note). A mock here looks like it works
// and doesn't — the first version of this file wrote fake "SESSION restored
// for dave" and Cloudflare-error entries straight into the real
// %APPDATA%/funsync-player/logs/main.log, which is a genuinely bad thing to
// do to a log Dave reads for forensics.
//
// Instead, grab the SAME logger instance the module under test holds and use
// electron-log's own switch: a transport level of `false` disables it.
const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI } = await import('../../electron/eroscripts-api.js');

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

function stubFetch(status, body = '') {
  globalThis.fetch = vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'text/html' },
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
    clone() { return this; },
  }));
}

describe('EroScripts auth expiry', () => {
  let api;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    api = new EroScriptsAPI();
    api.restoreSession('deadcookie', 'dave');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('search flags a 403 as authExpired, not just an empty result set', async () => {
    stubFetch(403, '<!DOCTYPE html><html>denied</html>');
    const res = await api.search('some video');
    expect(res.results).toEqual([]);
    expect(res.authExpired).toBe(true);
    expect(res.error).toBeTruthy();
  });

  it('search flags a 401 the same way', async () => {
    stubFetch(401, '');
    expect((await api.search('x')).authExpired).toBe(true);
  });

  it('does NOT flag a rate limit as expired — 429 must not log the user out', async () => {
    stubFetch(429, '');
    const res = await api.search('x');
    expect(res.results).toEqual([]);
    expect(res.authExpired).toBeFalsy();
  });

  it('does NOT flag a server error as expired', async () => {
    // A 503 returns no results, but the session may be perfectly fine.
    stubFetch(503, '<!DOCTYPE html><html>oops</html>');
    expect((await api.search('x')).authExpired).toBeFalsy();
  });

  it('topic lookup flags a 403 as authExpired too', async () => {
    stubFetch(403, '');
    const res = await api.getTopicAttachments(1234);
    expect(res.attachments).toEqual([]);
    expect(res.authExpired).toBe(true);
  });

  it('validateSession reports an expired cookie as invalid', async () => {
    stubFetch(403, '');
    expect(await api.validateSession()).toEqual({ valid: false });
  });

  it('validateSession stays valid on a transient server error', async () => {
    // Guards against logging the user out over a Cloudflare blip.
    stubFetch(503, '');
    expect(await api.validateSession()).toEqual({ valid: true });
  });

  it('validateSession is invalid with no cookie at all', async () => {
    const fresh = new EroScriptsAPI();
    expect(await fresh.validateSession()).toEqual({ valid: false });
  });
});
