/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash S1 (DESIGN-stash-s1.md (d), (e), (g)): the GraphQL client for the
// user's own Stash, against a REAL node:http fake (tests/helpers/
// fake-stash-server.js) whose answers are the ones recorded from the local
// test Stash v0.32.0, and Node's real fetch.
//
// Guards checked here, each by reopening its hole (stage s1-1a-client,
// 2026-11-18):
//   one host        every request goes to exactly `<address>/graphql`, path
//                   prefix kept (hole: the endpoint built as
//                   new URL('/graphql', address), which drops the prefix)
//   redirects       a 302 is the error `redirect`; the place it points at
//                   gets no request (hole: redirect: 'follow')
//   read-only       a raw document is refused before anything is sent; every
//                   body sent is a document from the list (hole: accept raw
//                   documents)
//   key placement   with a key: the ApiKey header, never in a URL; without:
//                   no header (hole: the key in the query string)
//   error words     each failure in (e) has its own code (hole: one generic
//                   code)
//   one at a time   never two requests open at once, across clients (hole:
//                   no queue)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  startFakeStash, closedPortAddress, loadStashFixture,
} from '../helpers/fake-stash-server.js';

const require = createRequire(import.meta.url);
const {
  createStashClient, normalizeStashAddress, isLoopbackAddress, keyTravelsInClear, stashSceneUrl,
  parseStashVersion, isStashVersionTooOld, isValidApiKey, stashErrorReply, StashError, STASH_ERROR,
  TIMEOUT_TEST_MS, TIMEOUT_SYNC_MS, MIN_STASH_VERSION, MAX_RESPONSE_BYTES,
} = require('../../electron/stash-client.js');
const { QUERY_NAMES, queryDocument } = require('../../electron/stash-queries.js');

// A sample key in a Stash API key's shape (a JWT). Not a real key.
const KEY = 'eyJhbGciOiJIUzI1NiJ9.U0FNUExFU1RBU0hLRVkwMDAx.c2FtcGxlc2lnbmF0dXJl';

function recordingFetch() {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    return fetch(url, init);
  };
  f.calls = calls;
  return f;
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
}

const codeOf = async (promise) => (await failure(promise)).code;

const client = (address, extra = {}) => createStashClient({ address, log: null, ...extra });

// Every method once, with inputs a hostile caller might pass.
async function everyMethod(c) {
  await c.test();
  await c.listScenes({ page: 1 });
  await c.sceneDetails(['1', '2', 999]);
  await c.scenesByOshash('6B3F3B3EE9E8C31A');
  await c.searchScenes('http://evil.example/graphql?apikey=x');
}

describe('the address (normalizeStashAddress)', () => {
  it.each([
    ['http://127.0.0.1:9999', 'http://127.0.0.1:9999'],
    ['  http://127.0.0.1:9999/  ', 'http://127.0.0.1:9999'],
    ['HTTP://LOCALHOST:9999', 'http://localhost:9999'],
    ['https://nas.lan/stash/', 'https://nas.lan/stash'],
    ['http://127.0.0.1:9999/graphql', 'http://127.0.0.1:9999'],
    ['https://nas.lan/stash/graphql/', 'https://nas.lan/stash'],
    ['http://192.168.1.20:9999', 'http://192.168.1.20:9999'],
    ['http://[::1]:9999', 'http://[::1]:9999'],
    ['https://stash.example:443/', 'https://stash.example'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeStashAddress(input)).toBe(out);
  });

  it.each([
    '', '   ', 'ftp://127.0.0.1', 'file:///C:/stash', 'javascript:alert(1)', 'stash.lan:9999',
    'http://user:pw@127.0.0.1:9999', 'http://127.0.0.1:9999@evil.example', 'http://evil.example\\@127.0.0.1',
    'http://127.0.0.1:9999/?x=1', 'http://127.0.0.1:9999/#frag', 'http://127.0.0.1:99 99',
    'http://', `http://a.example/${'x'.repeat(2100)}`, null, 9999, { href: 'http://127.0.0.1:9999' },
  ])('refuses %j', (input) => {
    expect(normalizeStashAddress(input)).toBeNull();
    if (typeof input === 'string' || input == null) {
      expect(() => createStashClient({ address: input, log: null })).toThrow(StashError);
    }
  });

  it('a bad address is the error badAddress', () => {
    let err;
    try { createStashClient({ address: 'http://u:p@host', log: null }); } catch (e) { err = e; }
    expect(err.code).toBe(STASH_ERROR.BAD_ADDRESS);
  });

  it('knows this PC from the network (the key-in-clear warning)', () => {
    expect(isLoopbackAddress('http://127.0.0.1:9999')).toBe(true);
    expect(isLoopbackAddress('http://localhost:9999')).toBe(true);
    expect(isLoopbackAddress('http://[::1]:9999')).toBe(true);
    expect(isLoopbackAddress('http://192.168.1.20:9999')).toBe(false);
    expect(keyTravelsInClear('http://192.168.1.20:9999', true)).toBe(true);
    expect(keyTravelsInClear('http://192.168.1.20:9999', false)).toBe(false);
    expect(keyTravelsInClear('https://192.168.1.20:9999', true)).toBe(false);
    expect(keyTravelsInClear('http://127.0.0.1:9999', true)).toBe(false);
  });
});

describe('Open in Stash (stashSceneUrl)', () => {
  it('is <address>/scenes/<id>, from the address and a numeric id only', () => {
    expect(stashSceneUrl('http://127.0.0.1:9999/', '12')).toBe('http://127.0.0.1:9999/scenes/12');
    expect(stashSceneUrl('https://nas.lan/stash', 7)).toBe('https://nas.lan/stash/scenes/7');
  });

  it.each(['//evil.example', '1/../../x', 'https://evil.example/scenes/1', '1?apikey=x', '', -1, 1.5, null, '1'.repeat(20)])(
    'refuses the id %j', (id) => {
      expect(stashSceneUrl('http://127.0.0.1:9999', id)).toBeNull();
    },
  );

  it('refuses a bad address', () => {
    expect(stashSceneUrl('http://u:p@evil.example', '1')).toBeNull();
  });
});

describe('versions', () => {
  it('reads Stash version strings', () => {
    expect(parseStashVersion('v0.32.0')).toEqual([0, 32, 0]);
    expect(parseStashVersion('0.27.1-12-gabcdef')).toEqual([0, 27, 1]);
    expect(parseStashVersion('')).toBeNull();
    expect(parseStashVersion(null)).toBeNull();
  });

  it('the minimum is v0.27.0; an unreadable version (a dev build) is not called too old', () => {
    expect(MIN_STASH_VERSION).toBe('0.27.0');
    expect(isStashVersionTooOld('v0.25.1')).toBe(true);
    expect(isStashVersionTooOld('v0.26.99')).toBe(true);
    expect(isStashVersionTooOld('v0.27.0')).toBe(false);
    expect(isStashVersionTooOld('v0.32.0')).toBe(false);
    expect(isStashVersionTooOld('v1.0.0')).toBe(false);
    expect(isStashVersionTooOld('')).toBe(false);
  });
});

describe('the fake answers as the local test Stash did (recorded fixtures)', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash(); });
  afterAll(() => fake.close());

  const data = (file) => loadStashFixture(file).body.data;

  it('Test connection: version and scene count', async () => {
    expect(await client(fake.address).test()).toEqual({ version: 'v0.32.0', sceneCount: 9 });
    const fx = data('s1-test.response.json');
    expect(fx.version.version).toBe('v0.32.0');
    expect(fx.findScenes.count).toBe(9);
  });

  it('the light list, one page and page 2 of 3', async () => {
    const c = client(fake.address);
    expect(await c.listScenes()).toEqual(data('s1-scene-list.response.json').findScenes);
    expect(await c.listScenes({ page: 2, perPage: 4 })).toEqual(data('s1-scene-list-page-2-of-3.response.json').findScenes);
  });

  it('details: one aliased findScene per id, a missing id answers null', async () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '999'];
    const out = await client(fake.address).sceneDetails(ids);
    const fx = data('s1-scene-details.response.json');
    expect(Object.keys(out)).toEqual(ids);
    ids.forEach((id, i) => expect(out[id]).toEqual(fx[`s${i}`]));
    expect(out['999']).toBeNull();
  });

  it('scenes by oshash (EQUALS), and a hash no file has', async () => {
    const c = client(fake.address);
    expect(await c.scenesByOshash('6b3f3b3ee9e8c31a')).toEqual(data('s1-scenes-by-oshash.response.json').findScenes);
    expect(await c.scenesByOshash('6b3f3b3e00000000')).toEqual(data('s1-scenes-by-oshash-none.response.json').findScenes);
  });

  it('Find in Stash', async () => {
    expect(await client(fake.address).searchScenes('Synthetic Scene')).toEqual(data('s1-scene-search.response.json').findScenes);
  });
});

describe('only one host: every request goes to <address>/graphql (guard)', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash({ prefix: '/stash' }); });
  afterAll(() => fake.close());
  beforeEach(() => fake.reset());

  it('across Test and every sync and search call, path prefix kept', async () => {
    const f = recordingFetch();
    const c = client(`${fake.address}/`, { fetch: f });
    expect(c.address).toBe(fake.address);
    await everyMethod(c);
    expect(f.calls).toHaveLength(5);
    for (const call of f.calls) expect(call.url).toBe(`${fake.address}/graphql`);
    expect(fake.requests.map((r) => r.url)).toEqual(Array(5).fill('/stash/graphql'));
  });

  it('URLs inside a reply (stash-box endpoints, the scene\'s own URLs) are data, never fetched', async () => {
    const f = recordingFetch();
    const details = await client(fake.address, { fetch: f }).sceneDetails(['1']);
    const text = JSON.stringify(details);
    expect(text).toContain('https://stash-box.invalid/graphql');
    expect(text).toContain('https://example.invalid/scene/1');
    expect(f.calls.map((c) => c.url)).toEqual([`${fake.address}/graphql`]);
  });
});

describe('redirects are not followed (guard)', () => {
  let target;
  let redirector;
  beforeAll(async () => {
    target = await startFakeStash();
    redirector = await startFakeStash({ mode: 'redirect', redirectTo: target.address });
  });
  afterAll(async () => { await redirector.close(); await target.close(); });

  it('a 302 is the error redirect, and the second server gets no request', async () => {
    const c = client(redirector.address, { apiKey: KEY });
    expect(await codeOf(c.test())).toBe(STASH_ERROR.REDIRECT);
    expect(await codeOf(c.listScenes())).toBe(STASH_ERROR.REDIRECT);
    expect(redirector.requests).toHaveLength(2);
    expect(target.requests).toHaveLength(0);
  });

  it('the request says redirect: manual', async () => {
    const f = recordingFetch();
    await failure(client(redirector.address, { fetch: f }).test());
    expect(f.calls[0].init.redirect).toBe('manual');
  });
});

describe('read-only: only documents from the frozen list are sent (guard)', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash(); });
  afterAll(() => fake.close());
  beforeEach(() => fake.reset());

  it('a raw mutation (or any raw document) is refused and nothing is sent', async () => {
    const f = recordingFetch();
    const c = client(fake.address, { fetch: f });
    for (const raw of [
      'mutation { sceneDestroy(input: {id: "1", delete_file: true}) }',
      'mutation FunSyncTest { sceneUpdate(input: {id: "1", rating100: 1}) { id } }',
      'query { version { version } }',
      'FunSyncSceneUpdate',
    ]) {
      expect(await codeOf(c.request(raw, {}))).toBe(STASH_ERROR.UNKNOWN_QUERY);
    }
    expect(f.calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('every body sent is {operationName, query, variables} with the list\'s own document', async () => {
    await everyMethod(client(fake.address));
    expect(fake.requests).toHaveLength(5);
    for (const r of fake.requests) {
      expect(r.method).toBe('POST');
      expect(Object.keys(r.json).sort()).toEqual(['operationName', 'query', 'variables']);
      expect(QUERY_NAMES).toContain(r.json.operationName);
      const n = r.json.operationName === 'FunSyncSceneDetails' ? Object.keys(r.json.variables).length : undefined;
      expect(r.json.query).toBe(queryDocument(r.json.operationName, n));
      expect(r.body).not.toMatch(/\bmutation\b|\bsubscription\b/);
    }
  });
});

describe('the API key: a header to the address only, never in a URL (guard)', () => {
  let locked;
  let open;
  beforeAll(async () => {
    locked = await startFakeStash({ apiKey: KEY });
    open = await startFakeStash();
  });
  afterAll(async () => { await locked.close(); await open.close(); });

  it('with a key: every request carries ApiKey, and no URL carries the key', async () => {
    const f = recordingFetch();
    await everyMethod(client(locked.address, { apiKey: KEY, fetch: f }));
    expect(locked.requests).toHaveLength(5);
    for (const r of locked.requests) {
      expect(r.headers.apikey).toBe(KEY);
      expect(r.url).toBe('/graphql');
      expect(r.body).not.toContain(KEY);
    }
    for (const call of f.calls) {
      expect(call.url).not.toContain(KEY);
      expect(call.url.toLowerCase()).not.toContain('apikey');
    }
  });

  it('without a key: no ApiKey header at all (an empty one is not sent)', async () => {
    await everyMethod(client(open.address));
    expect(open.requests).toHaveLength(5);
    for (const r of open.requests) expect(Object.keys(r.headers)).not.toContain('apikey');
  });

  it('the client keeps the key to itself: not on the object, not in an error, not in a reply', async () => {
    const c = client(open.address, { apiKey: KEY });
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(Object.values(c).map(String).join(' ')).not.toContain(KEY);
    expect(c.hasKey).toBe(true);
    const err = await failure(c.test());
    expect(err.code).toBe(STASH_ERROR.BAD_KEY);
    expect(`${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain(KEY);
    expect(JSON.stringify(stashErrorReply(err))).not.toContain(KEY);
  });

  it('refuses a key that cannot be a header value', () => {
    for (const bad of [`${KEY}\r\nX-Evil: 1`, 'two words', 'ü-key', 'x'.repeat(4097)]) {
      expect(isValidApiKey(bad)).toBe(false);
      expect(() => createStashClient({ address: 'http://127.0.0.1:9999', apiKey: bad, log: null })).toThrow(StashError);
    }
    expect(isValidApiKey(KEY)).toBe(true);
  });
});

describe('every failure has its own words (guard)', () => {
  const fakes = [];
  const fake = async (opts) => { const f = await startFakeStash(opts); fakes.push(f); return f; };
  afterAll(async () => { for (const f of fakes) await f.close(); });

  it('Stash not running: unreachable (ECONNREFUSED)', async () => {
    const err = await failure(client(await closedPortAddress()).test());
    expect(err.code).toBe(STASH_ERROR.UNREACHABLE);
    expect(err.causeCode).toBe('ECONNREFUSED');
  });

  it('no answer in time: timeout', async () => {
    const f = await fake({ mode: 'slow', delayMs: 3000 });
    expect(await codeOf(client(f.address, { timeouts: { test: 100 } }).test())).toBe(STASH_ERROR.TIMEOUT);
    expect(await codeOf(client(f.address, { timeouts: { sync: 100 } }).listScenes())).toBe(STASH_ERROR.TIMEOUT);
  });

  it('401 with a key (a password-less Stash refuses any key): badKey', async () => {
    const f = await fake();
    expect(await codeOf(client(f.address, { apiKey: KEY }).test())).toBe(STASH_ERROR.BAD_KEY);
    const locked = await fake({ apiKey: KEY });
    expect(await codeOf(client(locked.address, { apiKey: `${KEY}x` }).test())).toBe(STASH_ERROR.BAD_KEY);
  });

  it('401 with no key: needsKey', async () => {
    const f = await fake({ apiKey: KEY });
    expect(await codeOf(client(f.address).test())).toBe(STASH_ERROR.NEEDS_KEY);
  });

  it('403: forbidden', async () => {
    const f = await fake({ mode: 'forbidden' });
    expect(await codeOf(client(f.address).test())).toBe(STASH_ERROR.FORBIDDEN);
  });

  it('a version below v0.27.0: tooOld, with the version', async () => {
    const f = await fake({ version: 'v0.25.1' });
    const err = await failure(client(f.address).test());
    expect(err.code).toBe(STASH_ERROR.TOO_OLD);
    expect(err.version).toBe('v0.25.1');
    expect(stashErrorReply(err)).toEqual({ ok: false, code: 'tooOld', version: 'v0.25.1', minVersion: '0.27.0' });
  });

  it('400 GRAPHQL_VALIDATION_FAILED on a sync request: tooOld; on Test (every Stash knows version): notStash', async () => {
    const f = await fake({ mode: 'validation' });
    const err = await failure(client(f.address).listScenes());
    expect(err.code).toBe(STASH_ERROR.TOO_OLD);
    expect(err.status).toBe(400);
    expect(await codeOf(client(f.address).test())).toBe(STASH_ERROR.NOT_STASH);
  });

  it('200 HTML, JSON that is not GraphQL, or a wrong path prefix: notStash', async () => {
    const html = await fake({ mode: 'html' });
    expect(await codeOf(client(html.address).test())).toBe(STASH_ERROR.NOT_STASH);
    const broken = await fake({ mode: 'notJson' });
    expect(await codeOf(client(broken.address).test())).toBe(STASH_ERROR.NOT_STASH);
    const ok = await fake();
    expect(await codeOf(client(`${ok.address}/stash`).test())).toBe(STASH_ERROR.NOT_STASH);
    const noVersion = await fake({ respond: { FunSyncTest: () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":{"other":1}}' }) } });
    expect(await codeOf(client(noVersion.address).test())).toBe(STASH_ERROR.NOT_STASH);
  });

  it('a 3xx: redirect', async () => {
    const f = await fake({ mode: 'redirect', redirectTo: 'http://127.0.0.1:9' });
    expect(await codeOf(client(f.address).test())).toBe(STASH_ERROR.REDIRECT);
  });

  it('500: http, with the status', async () => {
    const f = await fake({ mode: 'serverError' });
    const err = await failure(client(f.address).listScenes());
    expect(err.code).toBe(STASH_ERROR.HTTP);
    expect(err.status).toBe(500);
  });

  it('a GraphQL error in a 200 (the id-list failure recorded on v0.32.0): graphql', async () => {
    const body = JSON.stringify(loadStashFixture('s1-id-list-error.response.json').body);
    const f = await fake({ respond: { FunSyncSceneDetails: () => ({ status: 200, headers: { 'content-type': 'application/json' }, body }) } });
    expect(await codeOf(client(f.address).sceneDetails(['1']))).toBe(STASH_ERROR.GRAPHQL);
  });

  it('a reply over the cap: tooLarge, by its length header or while reading', async () => {
    const big = async () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
    expect(await codeOf(client('http://127.0.0.1:9999', { fetch: big }).test())).toBe(STASH_ERROR.TOO_LARGE);
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const stream = () => new Response(new ReadableStream({
      pull(ctl) { sent += chunk.byteLength; ctl.enqueue(chunk); },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await codeOf(client('http://127.0.0.1:9999', { fetch: async () => stream() }).test())).toBe(STASH_ERROR.TOO_LARGE);
    expect(sent).toBeLessThan(MAX_RESPONSE_BYTES + 4 * chunk.byteLength);
  });

  it('a certificate this PC does not trust: certificate', async () => {
    const tls = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }; throw e; };
    expect(await codeOf(client('https://nas.lan', { fetch: tls }).test())).toBe(STASH_ERROR.CERTIFICATE);
  });

  it('the (e) reasons are told apart: eight failures, eight codes', async () => {
    const codes = [
      STASH_ERROR.UNREACHABLE, STASH_ERROR.TIMEOUT, STASH_ERROR.BAD_KEY, STASH_ERROR.NEEDS_KEY,
      STASH_ERROR.FORBIDDEN, STASH_ERROR.TOO_OLD, STASH_ERROR.NOT_STASH, STASH_ERROR.REDIRECT,
    ];
    expect(new Set(codes).size).toBe(8);
    expect(new Set(Object.values(STASH_ERROR)).size).toBe(Object.values(STASH_ERROR).length);
  });

  it('an IPC reply carries the code and a few facts, never a message', () => {
    const err = new StashError(STASH_ERROR.HTTP, { status: 502 });
    expect(stashErrorReply(err)).toEqual({ ok: false, code: 'http', status: 502 });
    expect(stashErrorReply(new Error('C:\\videos\\secret.mp4 apikey=x'))).toEqual({ ok: false, code: 'unreachable' });
  });
});

describe('timeouts: 5 s for Test, 30 s for every other request', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash(); });
  afterAll(() => fake.close());

  it('arms the right timer for each call, and clears it', async () => {
    const armed = [];
    let cleared = 0;
    const timers = {
      setTimeout: (fn, ms) => { armed.push(ms); return setTimeout(fn, ms); },
      clearTimeout: (t) => { cleared += 1; clearTimeout(t); },
    };
    await everyMethod(client(fake.address, { timers }));
    expect(TIMEOUT_TEST_MS).toBe(5000);
    expect(TIMEOUT_SYNC_MS).toBe(30000);
    expect(armed).toEqual([5000, 30000, 30000, 30000, 30000]);
    expect(cleared).toBe(5);
  });
});

describe('cancel', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash({ mode: 'slow', delayMs: 300 }); });
  afterAll(() => fake.close());
  beforeEach(() => fake.reset());

  it('a request in flight stops with cancelled', async () => {
    const ctl = new AbortController();
    const p = client(fake.address).listScenes({ signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    expect(await codeOf(p)).toBe(STASH_ERROR.CANCELLED);
  });

  it('a request still waiting its turn is cancelled without being sent', async () => {
    const first = client(fake.address).test();
    const ctl = new AbortController();
    const second = client(fake.address).listScenes({ signal: ctl.signal });
    ctl.abort();
    expect(await codeOf(second)).toBe(STASH_ERROR.CANCELLED);
    await first;
    expect(fake.requests.map((r) => r.json.operationName)).toEqual(['FunSyncTest']);
  });
});

describe('one request at a time, across every client (guard)', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash({ mode: 'slow', delayMs: 60 }); });
  afterAll(() => fake.close());
  beforeEach(() => fake.reset());

  it('calls made together are sent one after another', async () => {
    const a = client(fake.address);
    const b = client(fake.address);
    const results = await Promise.all([
      a.test(), a.listScenes(), b.sceneDetails(['1']), b.searchScenes('Synthetic'), a.scenesByOshash('6b3f3b3ee9e8c31a'),
    ]);
    expect(results).toHaveLength(5);
    expect(fake.requests).toHaveLength(5);
    expect(fake.stats.maxActive).toBe(1);
    expect(fake.requests.map((r) => r.json.operationName)).toEqual([
      'FunSyncTest', 'FunSyncSceneList', 'FunSyncSceneDetails', 'FunSyncSceneSearch', 'FunSyncScenesByOshash',
    ]);
  });

  it('a failed request does not hold up the next one', async () => {
    const down = client(await closedPortAddress());
    const [bad, good] = await Promise.allSettled([down.test(), client(fake.address).test()]);
    expect(bad.status).toBe('rejected');
    expect(good.status).toBe('fulfilled');
  });
});

describe('one log line per request, with nothing private in it', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash({ apiKey: KEY }); });
  afterAll(() => fake.close());

  it('names the query, the id count, the status and the time; no key, address, search text or path', async () => {
    const lines = [];
    const log = { info: (l) => lines.push(l) };
    const c = createStashClient({ address: fake.address, apiKey: KEY, log });
    await everyMethod(c);
    await failure(createStashClient({ address: fake.address, apiKey: `${KEY}x`, log }).test());
    expect(lines).toHaveLength(6);
    expect(lines[2]).toMatch(/^\[Stash\] FunSyncSceneDetails 3 ids → 200 in \d+ ms$/);
    expect(lines[5]).toMatch(/^\[Stash\] FunSyncTest → 401 badKey in \d+ ms$/);
    for (const l of lines) {
      expect(l).toMatch(/^\[Stash\] FunSync\w+( \d+ ids?)? → \S+( \w+)? in \d+ ms$/);
      expect(l).not.toContain(KEY);
      expect(l).not.toContain('127.0.0.1');
      expect(l).not.toContain('evil.example');
      expect(l).not.toContain('stash-test');
    }
  });
});

describe('inputs that cannot be sent are refused before anything is sent', () => {
  let fake;
  beforeAll(async () => { fake = await startFakeStash(); });
  afterAll(() => fake.close());
  beforeEach(() => fake.reset());

  it('ids, hashes, pages and search text', async () => {
    const c = client(fake.address);
    const tooMany = Array.from({ length: 51 }, (_, i) => String(i + 1));
    for (const p of [
      c.sceneDetails([]), c.sceneDetails(tooMany), c.sceneDetails(['1', 'x']), c.sceneDetails(['1 OR 1=1']),
      c.sceneDetails('1'), c.scenesByOshash('6b3f3b3e'), c.scenesByOshash('6b3f3b3ee9e8c31g'), c.scenesByOshash(null),
      c.listScenes({ page: 0 }), c.listScenes({ perPage: 1001 }), c.listScenes({ page: 1.5 }),
      c.searchScenes(''), c.searchScenes('   '), c.searchScenes('x'.repeat(201)), c.searchScenes('a\nb'),
    ]) {
      expect(await codeOf(p)).toBe(STASH_ERROR.BAD_INPUT);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('50 ids is one request; duplicates are sent once; the hash goes lower case', async () => {
    const c = client(fake.address);
    const fifty = Array.from({ length: 50 }, (_, i) => String(i + 1));
    const out = await c.sceneDetails(fifty);
    expect(Object.keys(out)).toHaveLength(50);
    expect(out['1'].title).toBe('Synthetic Scene Small');
    expect(out['50']).toBeNull();
    await c.sceneDetails(['1', 1, '1']);
    expect(fake.requests[1].json.variables).toEqual({ id0: '1' });
    await c.scenesByOshash('6B3F3B3EE9E8C31A');
    expect(fake.requests[2].json.variables).toEqual({ oshash: '6b3f3b3ee9e8c31a' });
  });
});
