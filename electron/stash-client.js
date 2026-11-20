// Stash S1: the GraphQL client for the user's own Stash server. Main process
// only; the renderer never talks to Stash (DESIGN-stash-s1.md (d)).
//
// What it guarantees, each with a test in tests/unit/stash-client.test.js:
//   - ONE HOST. Every request goes to `<address>/graphql`, the address the
//     user set (normalizeStashAddress), path prefix kept. Nothing in a reply
//     (a stash-box endpoint, a scene URL, a `paths` URL) ever becomes a URL
//     FunSync fetches.
//   - NO REDIRECTS. `redirect: 'manual'`; a 3xx is the error `redirect` and
//     the place it points at gets no request.
//   - READ-ONLY. Only documents from electron/stash-queries.js, picked by
//     name; a raw document (a `mutation`) is refused before anything is sent.
//   - THE KEY. Sent as the `ApiKey` header, only to the address; never in a
//     URL. No key: no header at all (a stale key gets 401 even from a Stash
//     with no password, checked on v0.32.0). The key is never logged, never
//     in an error, never readable back from the client.
//   - GENTLE. One request at a time across every client in the process (a
//     shared queue); 5 s for Test, 30 s for every other request; no retries.
//     A failed request ends the step: the caller decides what that means.
//   - WORDS. Every failure is a StashError whose `code` the UI words
//     (STASH_ERROR; the strings are `stash.error.<code>`). No message from
//     Stash, no body, no address and no key travel with it.
//   - HTTPS (Round 2, Dave's answer after Round 1). An `https:` address goes
//     through electron/stash-tls.js: the system's trust, or the ONE
//     certificate the user trusted for this exact origin (`tlsPin`,
//     settings.stash.trustedCert); nothing is sent before the certificate
//     passed. A refused certificate is the error `certificate` and carries
//     the certificate's public facts (fingerprint, subject…) for the trust
//     step. Never a global "ignore certificate errors".
//
// One log line per request: `[Stash] FunSyncSceneDetails 50 ids → 200 in
// 132 ms`. No headers, no bodies, no search text, no file paths.

const { queryDocument, DETAILS_MAX, LIST_PAGE_MAX } = require('./stash-queries');

const TIMEOUT_TEST_MS = 5000;
const TIMEOUT_SYNC_MS = 30000;

// v0.27.0: when `movies` became `groups` (DESIGN-stash-s1.md (e)). Not
// checked on a real v0.27 (only v0.32.0 exists here).
const MIN_STASH_VERSION = '0.27.0';

// A light page of 1,000 scenes is ~270 KB; 50 full scenes far less. A reply
// this big is not a Stash answering FunSync's queries.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// A Stash API key is a JWT (base64url and dots). Anything that is not
// visible ASCII cannot be an HTTP header value.
const MAX_KEY_LENGTH = 4096;
const KEY_RE = /^[\x21-\x7e]+$/;

const MAX_ADDRESS_LENGTH = 2048;
const MAX_SEARCH_LENGTH = 200;
const SCENE_ID_RE = /^\d{1,12}$/;
const OSHASH_RE = /^[0-9a-f]{16}$/i;

const STASH_ERROR = Object.freeze({
  BAD_ADDRESS: 'badAddress',       // not an http(s) address FunSync accepts
  BAD_INPUT: 'badInput',           // an id, hash, page or search text that cannot be sent
  UNKNOWN_QUERY: 'unknownQuery',   // not a document from stash-queries.js (refused, nothing sent)
  UNREACHABLE: 'unreachable',      // ECONNREFUSED, a wrong host, the connection dropped
  CERTIFICATE: 'certificate',      // https with a certificate this PC does not trust
  TIMEOUT: 'timeout',              // no answer in time
  CANCELLED: 'cancelled',          // the caller's signal (Cancel, FunSync closing)
  REDIRECT: 'redirect',            // a 3xx: not followed
  BAD_KEY: 'badKey',               // 401 and a key was sent
  NEEDS_KEY: 'needsKey',           // 401 and no key was sent
  FORBIDDEN: 'forbidden',          // 403
  TOO_OLD: 'tooOld',               // below MIN_STASH_VERSION, or a query Stash does not know
  NOT_STASH: 'notStash',           // answered, but not as Stash (HTML, 404, not GraphQL JSON)
  GRAPHQL: 'graphql',              // Stash answered the query with an error
  HTTP: 'http',                    // another HTTP status (500, 502 from a proxy…)
  TOO_LARGE: 'tooLarge',           // a reply over MAX_RESPONSE_BYTES
});

const _CODES = new Set(Object.values(STASH_ERROR));

const _CERT_TEXT_FIELDS = ['origin', 'subject', 'issuer', 'altNames', 'validFrom', 'validTo', 'reason'];
const _FINGERPRINT_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** A certificate's public facts as the trust step shows them, or null (stash-tls.js describeCertificate). */
function _cleanCertificate(c) {
  if (!c || typeof c !== 'object' || typeof c.fingerprint256 !== 'string' || !_FINGERPRINT_RE.test(c.fingerprint256)) return null;
  const out = { fingerprint256: c.fingerprint256, pinMismatch: c.pinMismatch === true };
  for (const k of _CERT_TEXT_FIELDS) out[k] = typeof c[k] === 'string' ? c[k].slice(0, 500) : null;
  return out;
}

class StashError extends Error {
  /**
   * @param {string} code one of STASH_ERROR
   * @param {{status?: number, version?: string|null, cause?: string, certificate?: object}} [extra]
   */
  constructor(code, extra = {}) {
    super(`Stash: ${code}`);
    this.name = 'StashError';
    this.code = _CODES.has(code) ? code : STASH_ERROR.UNREACHABLE;
    if (Number.isInteger(extra.status)) this.status = extra.status;
    if (typeof extra.version === 'string') this.version = extra.version;
    if (typeof extra.cause === 'string') this.causeCode = extra.cause;
    const certificate = this.code === STASH_ERROR.CERTIFICATE ? _cleanCertificate(extra.certificate) : null;
    if (certificate) this.certificate = certificate;
  }
}

/**
 * What an IPC reply may carry about a failure: the code and the few facts
 * the words need (for `certificate`, the certificate's public facts for the
 * trust step). Never a message, a body, the key or a path.
 * @param {unknown} err
 * @returns {{ok: false, code: string, status?: number, version?: string, minVersion?: string, certificate?: object}}
 */
function stashErrorReply(err) {
  const code = err instanceof StashError ? err.code : STASH_ERROR.UNREACHABLE;
  const out = { ok: false, code };
  if (err instanceof StashError) {
    if (Number.isInteger(err.status)) out.status = err.status;
    if (typeof err.version === 'string') out.version = err.version;
    if (err.certificate) out.certificate = { ...err.certificate };
  }
  if (code === STASH_ERROR.TOO_OLD) out.minVersion = MIN_STASH_VERSION;
  return out;
}

/**
 * The address as FunSync stores and uses it, or null when it is not one it
 * accepts: `http` or `https` only; no `user:password@`, no query, no
 * fragment; a trailing `/` dropped; a path prefix kept (a Stash behind a
 * reverse proxy); a trailing `/graphql` dropped (the endpoint is added to
 * every request). localhost, 127.0.0.1, LAN names and addresses are allowed.
 * @param {unknown} input
 * @returns {string|null}
 */
function normalizeStashAddress(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_ADDRESS_LENGTH) return null;
  // A space, a control character or a backslash inside: the URL parser
  // would quietly turn `\` into `/` or drop a tab; refuse instead.
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\x00-\x1f\x7f]/.test(s)) return null;
  if (s.includes('?') || s.includes('#') || s.includes('@')) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  let p = u.pathname.replace(/\/+$/, '');
  if (/\/graphql$/i.test(p)) p = p.slice(0, -'/graphql'.length).replace(/\/+$/, '');
  return u.origin + p;
}

/**
 * Is the address this PC (where a key sent over plain http stays on the
 * machine)?
 * @param {string} address a normalized address
 * @returns {boolean}
 */
function isLoopbackAddress(address) {
  const a = normalizeStashAddress(address);
  if (!a) return false;
  const host = new URL(a).hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Should Settings warn that the key travels unencrypted over the network?
 * (`http` to a host that is not this PC, with a key set.)
 * @param {string} address
 * @param {boolean} hasKey
 * @returns {boolean}
 */
function keyTravelsInClear(address, hasKey) {
  const a = normalizeStashAddress(address);
  return !!hasKey && !!a && a.startsWith('http:') && !isLoopbackAddress(a);
}

/**
 * The page "Open in Stash" hands to the browser through `open-external`:
 * `<address>/scenes/<id>`. FunSync itself sends nothing there, and the key
 * is never in it. Only a numeric Stash id is accepted: nothing from a reply
 * other than the id shapes the URL.
 * @param {string} address
 * @param {unknown} sceneId
 * @returns {string|null}
 */
function stashSceneUrl(address, sceneId) {
  const a = normalizeStashAddress(address);
  const id = typeof sceneId === 'number' && Number.isSafeInteger(sceneId) ? String(sceneId) : sceneId;
  if (!a || typeof id !== 'string' || !SCENE_ID_RE.test(id)) return null;
  return `${a}/scenes/${id}`;
}

/**
 * `v0.32.0`, `0.27.1-12-gabc` -> [0, 32, 0]; null when it is not a version.
 * @param {unknown} v
 * @returns {number[]|null}
 */
function parseStashVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Is this Stash version below the minimum? An unreadable version (a
 * development build) is not called too old: the queries decide then.
 * @param {unknown} version
 * @returns {boolean}
 */
function isStashVersionTooOld(version) {
  const v = parseStashVersion(version);
  if (!v) return false;
  const min = parseStashVersion(MIN_STASH_VERSION);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] < min[i];
  }
  return false;
}

/** @param {unknown} key */
function isValidApiKey(key) {
  return typeof key === 'string' && key.length <= MAX_KEY_LENGTH && KEY_RE.test(key);
}

// ONE request at a time, across every client in this process: a Test while a
// sync runs waits its turn instead of adding load. A request's timer starts
// when it is sent, not while it waits.
let _queueTail = Promise.resolve();
function _enqueue(task) {
  const run = _queueTail.then(task, task);
  _queueTail = run.then(() => {}, () => {});
  return run;
}

const _VALIDATION_CODES = new Set(['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED']);

function _isValidationFailure(json) {
  return !!json && Array.isArray(json.errors) && json.errors.some((e) =>
    e && e.extensions && _VALIDATION_CODES.has(e.extensions.code));
}

function _certificateCause(code) {
  return typeof code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code);
}

function _causeCode(err) {
  const c = err && (err.cause && err.cause.code ? err.cause.code : err.code);
  return typeof c === 'string' && /^[A-Z0-9_]{2,60}$/.test(c) ? c : undefined;
}

async function _discardBody(res) {
  try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* already gone */ }
}

/** The reply's text, refusing one over the cap before and while reading. */
async function _readCapped(res, max) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) {
    await _discardBody(res);
    throw new StashError(STASH_ERROR.TOO_LARGE, { status: res.status });
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > max) throw new StashError(STASH_ERROR.TOO_LARGE, { status: res.status });
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* gone */ }
      throw new StashError(STASH_ERROR.TOO_LARGE, { status: res.status });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The GraphQL `data` of a reply, or the StashError that words it.
 * @param {Response} res
 * @param {boolean} keySent
 */
async function _readReply(res, keySent) {
  const status = res.status;
  if (res.type === 'opaqueredirect' || res.redirected || (status >= 300 && status < 400)) {
    await _discardBody(res);
    throw new StashError(STASH_ERROR.REDIRECT, { status: status || undefined });
  }
  if (status === 401) {
    await _discardBody(res);
    throw new StashError(keySent ? STASH_ERROR.BAD_KEY : STASH_ERROR.NEEDS_KEY, { status });
  }
  if (status === 403) {
    await _discardBody(res);
    throw new StashError(STASH_ERROR.FORBIDDEN, { status });
  }
  const text = await _readCapped(res, MAX_RESPONSE_BYTES);
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (_isValidationFailure(json)) throw new StashError(STASH_ERROR.TOO_OLD, { status });
  if (status === 404) throw new StashError(STASH_ERROR.NOT_STASH, { status });
  if (status < 200 || status > 299) throw new StashError(STASH_ERROR.HTTP, { status });
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new StashError(STASH_ERROR.NOT_STASH, { status });
  if (Array.isArray(json.errors) && json.errors.length) throw new StashError(STASH_ERROR.GRAPHQL, { status });
  if (!json.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
    throw new StashError(STASH_ERROR.NOT_STASH, { status });
  }
  return json.data;
}

function _defaultLog() {
  try { return require('./logger'); } catch { return null; }
}

function _appVersion() {
  try { return require('../package.json').version; } catch { return '0'; }
}

function _isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `{count, scenes}` from a findScenes answer, or notStash. */
function _sceneList(data) {
  const found = data && data.findScenes;
  if (!_isPlainObject(found) || !Number.isSafeInteger(found.count) || !Array.isArray(found.scenes)
      || !found.scenes.every(_isPlainObject)) {
    throw new StashError(STASH_ERROR.NOT_STASH);
  }
  return { count: found.count, scenes: found.scenes };
}

/** `{count, tags}` from a findTags answer (the next lot's tag list), or notStash. */
function _tagList(data) {
  const found = data && data.findTags;
  if (!_isPlainObject(found) || !Number.isSafeInteger(found.count) || !Array.isArray(found.tags)
      || !found.tags.every(_isPlainObject)) {
    throw new StashError(STASH_ERROR.NOT_STASH);
  }
  return { count: found.count, tags: found.tags };
}

/**
 * A client for one Stash address and key. Both are fixed for its life:
 * a new address or key is a new client.
 *
 * @param {object} options
 * @param {string} options.address what the user typed or stored; normalized here
 * @param {string} [options.apiKey] '' or absent: no ApiKey header
 * @param {typeof fetch} [options.fetch] injected for tests
 * @param {{info: Function, warn?: Function}|null} [options.log]
 * @param {() => number} [options.now]
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @param {{test?: number, sync?: number}} [options.timeouts] ms; tests only
 * @param {{origin: string, sha256: string}|null} [options.tlsPin] the https
 *   certificate the user trusted (settings.stash.trustedCert); it counts only
 *   at its own origin (stash-tls.js)
 * @param {object} [options.tlsOptions] extra tls.connect options; tests only
 */
function createStashClient(options = {}) {
  const address = normalizeStashAddress(options.address);
  if (!address) throw new StashError(STASH_ERROR.BAD_ADDRESS);
  const apiKey = options.apiKey == null ? '' : options.apiKey;
  if (apiKey !== '' && !isValidApiKey(apiKey)) throw new StashError(STASH_ERROR.BAD_INPUT);
  // https: stash-tls.js decides about the certificate before anything is
  // sent (the system's trust, or the one pinned certificate of this origin).
  const fetchImpl = options.fetch || (address.startsWith('https:')
    ? require('./stash-tls').createStashFetch({ pin: options.tlsPin || null, tlsOptions: options.tlsOptions })
    : globalThis.fetch);
  const log = options.log === undefined ? _defaultLog() : options.log;
  const now = options.now || (() => Date.now());
  const timers = options.timers || { setTimeout, clearTimeout };
  const timeouts = {
    test: (options.timeouts && options.timeouts.test) || TIMEOUT_TEST_MS,
    sync: (options.timeouts && options.timeouts.sync) || TIMEOUT_SYNC_MS,
  };
  const endpoint = `${address}/graphql`;
  const userAgent = `FunSyncPlayer/${_appVersion()}`;

  function _log(name, n, outcome, ms) {
    if (!log || typeof log.info !== 'function') return;
    const what = Number.isInteger(n) ? `${name} ${n} id${n === 1 ? '' : 's'}` : name;
    try { log.info(`[Stash] ${what} → ${outcome} in ${ms} ms`); } catch { /* log unavailable */ }
  }

  /**
   * Send one document from the list, by name. The only way out of this
   * client.
   * @param {string} name a name from stash-queries.js
   * @param {Record<string, unknown>} variables
   * @param {{signal?: AbortSignal, n?: number, timeoutMs?: number}} [opts]
   * @returns {Promise<object>} the GraphQL `data`
   */
  async function request(name, variables = {}, opts = {}) {
    const document = queryDocument(name, opts.n);
    if (!document) throw new StashError(STASH_ERROR.UNKNOWN_QUERY);
    const signal = opts.signal;
    const timeoutMs = opts.timeoutMs || timeouts.sync;
    const body = JSON.stringify({ operationName: name, query: document, variables });
    return _enqueue(async () => {
      if (signal && signal.aborted) throw new StashError(STASH_ERROR.CANCELLED);
      const ctl = new AbortController();
      let timedOut = false;
      const timer = timers.setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const t0 = now();
      let outcome = 'error';
      const fail = (err) => {
        if (err instanceof StashError) return err;
        if (timedOut) return new StashError(STASH_ERROR.TIMEOUT);
        if (signal && signal.aborted) return new StashError(STASH_ERROR.CANCELLED);
        const cause = _causeCode(err);
        return new StashError(_certificateCause(cause) ? STASH_ERROR.CERTIFICATE : STASH_ERROR.UNREACHABLE, {
          cause, certificate: err && err.certificate,
        });
      };
      try {
        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/graphql-response+json, application/json',
          'User-Agent': userAgent,
        };
        if (apiKey) headers.ApiKey = apiKey;
        let res;
        try {
          res = await fetchImpl(endpoint, {
            method: 'POST', headers, body, redirect: 'manual', signal: ctl.signal,
          });
        } catch (err) {
          throw fail(err);
        }
        outcome = String(res.status);
        try {
          return await _readReply(res, !!apiKey);
        } catch (err) {
          throw fail(err);
        }
      } catch (err) {
        if (err instanceof StashError && outcome === 'error') outcome = err.code;
        else if (err instanceof StashError) outcome = `${outcome} ${err.code}`;
        throw err;
      } finally {
        timers.clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        _log(name, opts.n, outcome, Math.max(0, Math.round(now() - t0)));
      }
    });
  }

  return Object.freeze({
    address,
    hasKey: !!apiKey,
    request,

    /**
     * Test connection: `{version, sceneCount}`. A Stash below the minimum is
     * `tooOld` (with its version); an answer without `data.version`, or a
     * GraphQL server that does not know `version`, is `notStash`.
     * @param {{signal?: AbortSignal}} [opts]
     */
    async test(opts = {}) {
      let data;
      try {
        data = await request('FunSyncTest', {}, { signal: opts.signal, timeoutMs: timeouts.test });
      } catch (err) {
        // Every Stash knows `version` and `findScenes.count`: a server that
        // rejects them is not one.
        if (err instanceof StashError && err.code === STASH_ERROR.TOO_OLD) {
          throw new StashError(STASH_ERROR.NOT_STASH, { status: err.status });
        }
        throw err;
      }
      const v = data.version;
      if (!_isPlainObject(v)) throw new StashError(STASH_ERROR.NOT_STASH);
      const version = typeof v.version === 'string' && v.version.length <= 64 ? v.version : null;
      if (isStashVersionTooOld(version)) throw new StashError(STASH_ERROR.TOO_OLD, { version });
      const count = _isPlainObject(data.findScenes) && Number.isSafeInteger(data.findScenes.count)
        ? data.findScenes.count : null;
      return { version, sceneCount: count };
    },

    /**
     * One page of the light scene list: `{count, scenes: [{id, updated_at,
     * files: [{path, size, oshash}]}]}`, as Stash answers it. Whether the
     * list is complete is the caller's to decide from `count`.
     * @param {{page?: number, perPage?: number, signal?: AbortSignal}} [opts]
     */
    async listScenes(opts = {}) {
      const page = opts.page == null ? 1 : opts.page;
      const perPage = opts.perPage == null ? LIST_PAGE_MAX : opts.perPage;
      if (!Number.isSafeInteger(page) || page < 1 || page > 1e6
          || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > LIST_PAGE_MAX) {
        throw new StashError(STASH_ERROR.BAD_INPUT);
      }
      return _sceneList(await request('FunSyncSceneList', { page, perPage }, { signal: opts.signal }));
    },

    /**
     * One page of Stash's tag list (the "next" lot, 2026-11-19): `{count,
     * tags: [{id, name, aliases, parents: [{id}]}]}`, as Stash answers it.
     * Whether the list is complete is the caller's to decide from `count`.
     * @param {{page?: number, perPage?: number, signal?: AbortSignal}} [opts]
     */
    async listTags(opts = {}) {
      const page = opts.page == null ? 1 : opts.page;
      const perPage = opts.perPage == null ? LIST_PAGE_MAX : opts.perPage;
      if (!Number.isSafeInteger(page) || page < 1 || page > 1e6
          || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > LIST_PAGE_MAX) {
        throw new StashError(STASH_ERROR.BAD_INPUT);
      }
      return _tagList(await request('FunSyncTagList', { page, perPage }, { signal: opts.signal }));
    },

    /**
     * Details for up to DETAILS_MAX scenes, one aliased `findScene` each:
     * `{[id]: scene|null}` (null: no such scene in Stash now). Scene objects
     * are Stash's, in the shape of stash-queries.js's FunSyncSceneDetail.
     * @param {Array<string|number>} ids
     * @param {{signal?: AbortSignal}} [opts]
     */
    async sceneDetails(ids, opts = {}) {
      if (!Array.isArray(ids)) throw new StashError(STASH_ERROR.BAD_INPUT);
      const list = [...new Set(ids.map((id) => (typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id)))];
      if (!list.length || list.length > DETAILS_MAX || !list.every((id) => typeof id === 'string' && SCENE_ID_RE.test(id))) {
        throw new StashError(STASH_ERROR.BAD_INPUT);
      }
      const variables = {};
      list.forEach((id, i) => { variables[`id${i}`] = id; });
      const data = await request('FunSyncSceneDetails', variables, { signal: opts.signal, n: list.length });
      const out = {};
      list.forEach((id, i) => {
        const scene = data[`s${i}`];
        if (scene !== null && !_isPlainObject(scene)) throw new StashError(STASH_ERROR.NOT_STASH);
        out[id] = scene === undefined ? null : scene;
      });
      return out;
    },

    /**
     * Every scene with a file of exactly this oshash: `{count, scenes}`
     * (light scenes). Two scenes means "several", never the first one.
     * @param {string} oshash 16 hex characters
     * @param {{signal?: AbortSignal}} [opts]
     */
    async scenesByOshash(oshash, opts = {}) {
      if (typeof oshash !== 'string' || !OSHASH_RE.test(oshash)) throw new StashError(STASH_ERROR.BAD_INPUT);
      return _sceneList(await request('FunSyncScenesByOshash', { oshash: oshash.toLowerCase() }, { signal: opts.signal }));
    },

    /**
     * Find in Stash…: `{count, scenes}`, at most 20 scenes.
     * @param {string} q
     * @param {{signal?: AbortSignal}} [opts]
     */
    async searchScenes(q, opts = {}) {
      const text = typeof q === 'string' ? q.trim() : '';
      // eslint-disable-next-line no-control-regex
      if (!text || text.length > MAX_SEARCH_LENGTH || /[\x00-\x1f\x7f]/.test(text)) {
        throw new StashError(STASH_ERROR.BAD_INPUT);
      }
      return _sceneList(await request('FunSyncSceneSearch', { q: text }, { signal: opts.signal }));
    },
  });
}

module.exports = {
  createStashClient,
  normalizeStashAddress,
  isLoopbackAddress,
  keyTravelsInClear,
  stashSceneUrl,
  parseStashVersion,
  isStashVersionTooOld,
  isValidApiKey,
  stashErrorReply,
  StashError,
  STASH_ERROR,
  TIMEOUT_TEST_MS,
  TIMEOUT_SYNC_MS,
  MIN_STASH_VERSION,
  MAX_RESPONSE_BYTES,
};
