/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Main-process EroScripts request rules after review-b (fixup-data,
// 2026-11-18). No forum is contacted: fetch and the Electron session are
// fakes.
//
//   RB-3  Forum images the windows load themselves (search thumbnails and
//         avatars, also the Tags section's Find the post rows) carry the
//         shared EROSCRIPTS_USER_AGENT; every other host keeps its own.
//   RB-5  getTopicMeta gives up after 10 s (the session check's timeout):
//         a timeout is a network error, so the renderer's one-at-a-time
//         queue moves on and nothing is written.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';

const log = (await import('../../electron/logger.js')).default;
const {
  EroScriptsAPI, EROSCRIPTS_USER_AGENT, installForumUserAgent, FORUM_REQUEST_FILTER,
  TOPIC_META_TIMEOUT_MS, SESSION_CHECK_TIMEOUT_MS,
} = await import('../../electron/eroscripts-api.js');

const realFetch = globalThis.fetch;
beforeAll(() => { log.transports.file.level = false; log.transports.console.level = false; });
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

/** An Electron session's webRequest, as far as the hook uses it. */
function fakeSession() {
  const hooks = [];
  return {
    webRequest: { onBeforeSendHeaders: vi.fn((filter, listener) => hooks.push({ filter, listener })) },
    hooks,
    /** What the hook sends for one request (Electron calls it only for URLs the filter matches). */
    send(url, requestHeaders) {
      const { listener } = hooks.at(-1);
      let sent;
      listener({ url, requestHeaders }, (answer) => { sent = answer; });
      return sent;
    },
  };
}

describe('RB-3: the forum User-Agent on the windows\' own session', () => {
  const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) funsync-player/0.9.2 Chrome/146.0.0.0 Electron/41.0.0 Safari/537.36';

  it('an avatar or thumbnail from the forum goes out with EROSCRIPTS_USER_AGENT, whatever the header was spelled', () => {
    const s = fakeSession();
    expect(installForumUserAgent(s)).toBe(true);
    for (const url of [
      'https://discuss.eroscripts.com/user_avatar/discuss.eroscripts.com/x/90/1.png',
      'https://eroscripts-discourse.eroscripts.com/optimized/1X/abc_2_690x388.jpeg',
      'https://eroscripts.com/favicon.png',
    ]) {
      const sent = s.send(url, { 'user-agent': ELECTRON_UA, Accept: 'image/*' });
      expect(sent.requestHeaders).toEqual({ Accept: 'image/*', 'User-Agent': EROSCRIPTS_USER_AGENT });
    }
    expect(EROSCRIPTS_USER_AGENT).not.toMatch(/Electron|funsync-player/);
  });

  it('only the forum\'s hosts: the filter names them, and any other host keeps its own User-Agent', () => {
    const s = fakeSession();
    installForumUserAgent(s);
    expect(s.hooks).toHaveLength(1);
    expect([...s.hooks[0].filter.urls]).toEqual(['*://eroscripts.com/*', '*://*.eroscripts.com/*']);
    expect(FORUM_REQUEST_FILTER.urls).toEqual(s.hooks[0].filter.urls);
    // Even if a request from another host reached the listener, it is left alone.
    for (const url of ['https://example.com/a.png', 'https://eroscripts.com.evil.example/a.png', 'https://noteroscripts.com/a.png', 'not a url']) {
      const headers = { 'User-Agent': ELECTRON_UA };
      expect(s.send(url, headers).requestHeaders).toEqual({ 'User-Agent': ELECTRON_UA });
    }
  });

  it('no session (or no webRequest): nothing is hooked, nothing throws', () => {
    expect(installForumUserAgent(null)).toBe(false);
    expect(installForumUserAgent({})).toBe(false);
  });

  it('main hooks it on the default session (every window uses it), before the first window', () => {
    const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
    expect(main).toMatch(/require\('\.\/eroscripts-api'\)/);
    const ready = main.indexOf('app.whenReady().then(');
    const hook = main.indexOf('installForumUserAgent(session.defaultSession)', ready);
    const firstWindow = main.indexOf('createWindow();', ready);
    expect(ready).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(ready);
    expect(hook).toBeLessThan(firstWindow);
    // No window gets a partition of its own that would miss the hook (the
    // login window's persist:eroscripts-login sets its own User-Agent).
    const partitions = [...main.matchAll(/partition\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    expect(partitions).toEqual(['persist:eroscripts-login']);
    // One onBeforeSendHeaders per session (Electron keeps the last): nothing
    // else in main hooks the default session's.
    expect(main.match(/onBeforeSendHeaders/g) || []).toHaveLength(0);
  });
});

describe('RB-5: getTopicMeta gives up like the session check', () => {
  const hang = () => vi.fn((url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  }));

  it('10 s, the same as the session check', () => {
    expect(TOPIC_META_TIMEOUT_MS).toBe(10_000);
    expect(TOPIC_META_TIMEOUT_MS).toBe(SESSION_CHECK_TIMEOUT_MS);
    expect(new EroScriptsAPI()._topicMetaTimeoutMs).toBe(TOPIC_META_TIMEOUT_MS);
  });

  it('no answer by then: a network error (writes nothing), and the request carried a signal', async () => {
    vi.useFakeTimers();
    globalThis.fetch = hang();
    const api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    const pending = api.getTopicMeta(7);
    let settled = null;
    pending.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ ok: false, outcome: 'network', error: 'Timed out', errorCode: 'network' });
    expect(globalThis.fetch.mock.calls[0][1].signal).toBeTruthy();
  });

  it('headers in time, the body stalls: still a network error, not "failed"', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }));
    const api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    const pending = api.getTopicMeta(7);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, outcome: 'network', errorCode: 'network' });
  });

  it('an answer in time is as before, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ id: 7, slug: 'scene', title: 'Scene', tags: ['pov'], details: { created_by: { username: 'Ramie' } } }),
    }));
    const api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    const answer = await api.getTopicMeta(7);
    expect(answer).toMatchObject({ ok: true, outcome: 'ok', meta: { topicId: 7, title: 'Scene', creator: 'Ramie' } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
