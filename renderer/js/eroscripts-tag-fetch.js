// "Get tags from EroScripts" for one video (video options design (c)).
//
// What this module decides, so the Tags section only draws it:
//   - which post a video's CURRENT script belongs to (resolveTopic), and so
//     whether Get tags is offered at all; a creator's index / hub post you
//     did not pick is never it (eroscripts-hub.js, 2026-11-19);
//   - one request at a time for the whole app, at least 1 s from the end of
//     one to the start of the next, and a cooldown after a 429 that disables
//     every Get tags button (TagFetchQueue);
//   - what each answer means for the stored record and what the section says
//     (getTagsForVideo, outcomeMessage).
//
// Every request comes from one press: no loop, no retry, no background run,
// no batch (Dave, §11 of the plan). It needs the EroScripts login (Dave,
// 2026-11-17, answer 6): logged out, nothing is sent. Main only fetches
// (EroScriptsAPI.getTopicMeta); the record is written here, through the
// settings DataService gives, by script-tags.js.

import { t } from './i18n.js';
import { eroscriptsErrorText } from './eroscripts-error-text.js';
import { funscriptMetaRecord } from './video-tags.js';
import {
  TAG_MATCH, getScriptTags, recordIsForScript, recordScriptPath, applyTopicMeta, markScriptTagsStale,
  scriptTagsFingerprint,
} from './script-tags.js';
import { isHubTopic, isAutoHubRecord, isUserPickedMatch, learnHubTopic, learnedHubCreator } from './eroscripts-hub.js';

/** At least this long from the end of one topic request to the start of the next. */
export const MIN_GAP_MS = 1000;
/** The cooldown after a 429 that gave no Retry-After. */
export const DEFAULT_COOLDOWN_S = 60;
/** The longest cooldown a Retry-After can ask for (a broken header must not switch Get tags off for the day). */
export const MAX_COOLDOWN_S = 3600;

const TOPIC_BASE = 'https://discuss.eroscripts.com/t/';
const LINK_MATCHES = new Set([TAG_MATCH.MANUAL, TAG_MATCH.SEARCH]);
const RECORD_MATCHES = new Set(Object.values(TAG_MATCH));

/** Where the strings live (locales: `videoOptions.tags.fetch.*`). */
export const FETCH_KEYS = Object.freeze({
  button: 'videoOptions.tags.fetch.button',
  loginButton: 'videoOptions.tags.fetch.loginButton',
  running: 'videoOptions.tags.fetch.running',
  success: 'videoOptions.tags.fetch.success',
  successEmpty: 'videoOptions.tags.fetch.successEmpty',
  unknown: 'videoOptions.tags.fetch.unknown',
  gone: 'videoOptions.tags.fetch.gone',
  loginAgain: 'videoOptions.tags.fetch.loginAgain',
  loginAction: 'videoOptions.tags.fetch.loginAction',
  loginRequired: 'videoOptions.tags.fetch.loginRequired',
  cooldown: 'videoOptions.tags.fetch.cooldown',
  otherScript: 'videoOptions.tags.fetch.otherScript',
  noPost: 'videoOptions.tags.fetch.noPost',
  noScript: 'videoOptions.tags.fetch.noScript',
  superseded: 'videoOptions.tags.fetch.superseded',
  hub: 'videoOptions.tags.fetch.hub',
  hubNote: 'videoOptions.tags.fetch.hubNote',
});

function topicIdOf(value) {
  const id = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function baseName(path) {
  return String(path).split(/[\\/]/).pop();
}

/**
 * The topic id of a pasted post link, or null. The same reader the funscript
 * metadata uses (funscriptMetaRecord): a `discuss.eroscripts.com/t/<slug>/<id>`
 * or `/t/<id>` URL on the forum's own host, nothing else. Only the id is ever
 * sent to main, which builds the request URL itself; the link is never
 * fetched as given.
 * @param {unknown} text
 * @returns {number|null}
 */
export function topicIdFromLink(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return funscriptMetaRecord({ topic_url: text.trim() }, 0)?.topicId ?? null;
}

/** A link to a topic by id (the forum redirects to its slug). */
export function topicUrlFor(topicId) {
  return `${TOPIC_BASE}${topicId}`;
}

/**
 * Which post Get tags would read for this video, if any. Offered only for a
 * post known for the video's CURRENT script:
 *   - `link`: a post you linked just now (Paste a post link, Find the post).
 *     Your choice, so it comes first.
 *   - the record (`library.scriptTags[path]`) when the script it describes
 *     is the current script (script-tags.js recordIsForScript: its
 *     `scriptPath`; a record without one, from a download before the field,
 *     describes the video's same-name script, so it needs `videoPath`);
 *   - the current script's own metadata (`topic_url`, or a `script_url` that
 *     is a topic link), as funscriptMetaRecord reads it.
 * A record about ANOTHER script is never used: re-fetching would stamp that
 * post's tags on this script. Then the state is 'otherScript' and the
 * section offers to link a post.
 *
 * A creator's index / hub post (eroscripts-hub.js; Dave, 2026-11-19) that
 * you did not pick, from the record (a download from the hub, an earlier Get
 * tags of the hub link) or from the metadata (its script_url / topic_url),
 * is passed over as if it were not there: the state is what it would be
 * without it, and `hub` says which post was passed over, so the section can
 * say why and Find the post can put that creator's posts first. A post you
 * linked (`link`, or a record with match 'manual' / 'search') is kept, hub
 * or not.
 *
 * @param {object} input
 * @param {object|null} [input.record] the video's EroScripts record
 * @param {string|null} [input.scriptPath] the video's script now
 * @param {string|null} [input.videoPath] the video the record is filed under
 * @param {object|null} [input.scriptMeta] the current script's funscript
 *   record (funscriptMetaRecord), when read
 * @param {{topicId: number, match?: string, topicUrl?: string}|null} [input.link]
 * @returns {{state: 'known', topicId: number, topicUrl: string, match: string,
 *   from: 'link'|'record'|'metadata'}
 *   | {state: 'otherScript', topicId: number, scriptPath: string, scriptName: string}
 *   | {state: 'none', hub?: {topicId: number, from: 'record'|'metadata', creator: string|null}}
 *   | {state: 'noScript'}}
 */
export function resolveTopic({ record = null, scriptPath = null, scriptMeta = null, link = null, videoPath = null } = {}) {
  if (typeof scriptPath !== 'string' || !scriptPath) return { state: 'noScript' };

  const linkId = topicIdOf(link?.topicId);
  if (linkId != null) {
    return {
      state: 'known', topicId: linkId,
      topicUrl: typeof link.topicUrl === 'string' && link.topicUrl ? link.topicUrl : topicUrlFor(linkId),
      match: LINK_MATCHES.has(link.match) ? link.match : TAG_MATCH.MANUAL,
      from: 'link',
    };
  }

  // A hub you did not pick, passed over (Dave, 2026-11-19): the first one.
  let hub = null;
  const recordId = record && typeof record === 'object' ? topicIdOf(record.topicId) : null;
  const recordForScript = recordId != null && recordIsForScript(record, scriptPath, videoPath);
  if (recordForScript) {
    if (!isAutoHubRecord(record)) {
      return {
        state: 'known', topicId: recordId,
        topicUrl: record.topicUrl || topicUrlFor(recordId),
        match: RECORD_MATCHES.has(record.match) ? record.match : TAG_MATCH.DOWNLOAD,
        from: 'record',
      };
    }
    hub = { topicId: recordId, from: 'record' };
  }

  const metaId = scriptMeta && typeof scriptMeta === 'object' ? topicIdOf(scriptMeta.topicId) : null;
  if (metaId != null) {
    const viaTopicUrl = topicIdFromLink(scriptMeta.topicUrl) === metaId;
    const topicUrl = (viaTopicUrl ? scriptMeta.topicUrl : scriptMeta.scriptUrl) || topicUrlFor(metaId);
    // The metadata's title is the SCRIPT's, not the post's: only the link
    // (its slug) and the id can tell a hub here.
    if (!isHubTopic({ topicId: metaId, url: topicUrl })) {
      return {
        state: 'known', topicId: metaId,
        topicUrl,
        match: viaTopicUrl ? TAG_MATCH.TOPIC_URL : TAG_MATCH.SCRIPT_URL,
        from: 'metadata',
      };
    }
    if (!hub) hub = { topicId: metaId, from: 'metadata' };
  }

  // A hub record IS about this script: never "the post is for another script".
  const described = recordId != null && !recordForScript ? recordScriptPath(record, videoPath) : null;
  if (described) {
    return { state: 'otherScript', topicId: recordId, scriptPath: described, scriptName: baseName(described) };
  }
  if (!hub) return { state: 'none' };
  const creator = textOrNull(scriptMeta?.creator)
    || (hub.from === 'record' ? textOrNull(record.creator) : null)
    || learnedHubCreator(hub.topicId);
  return { state: 'none', hub: { ...hub, creator: creator || null } };
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * One topic request at a time for the whole app.
 *   - A press while another request runs waits behind it.
 *   - The next request starts at least `minGapMs` after the previous one
 *     ENDED.
 *   - A 429 starts a cooldown (`Retry-After` seconds, else 60 s): every press
 *     in it, and every request still waiting, answers 'cooldown' and sends
 *     nothing.
 *   - `runFor(key, …)` runs one job per key (a video): a second press on the
 *     same video gets the same promise, not a second request.
 * `onChange` listeners hear every change of the busy set and the cooldown
 * (also when the cooldown ends), so every Get tags button can redraw.
 */
export class TagFetchQueue {
  /**
   * @param {object} opts
   * @param {(topicId: number) => Promise<object>} opts.topicMeta main's
   *   getTopicMeta (window.funsync.eroscriptsTopicMeta)
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {number} [opts.minGapMs]
   */
  constructor({
    topicMeta,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    minGapMs = MIN_GAP_MS,
  } = {}) {
    this._topicMeta = topicMeta;
    this._now = now;
    this._sleep = sleep;
    this._minGapMs = minGapMs;
    this._tail = Promise.resolve();
    this._lastEnd = -Infinity;
    this._cooldownUntil = 0;
    this._cooldownTimer = null;
    this._running = new Map();
    this._listeners = new Set();
  }

  /** Whole seconds left of the cooldown; 0 when there is none. */
  cooldownSeconds() {
    const ms = this._cooldownUntil - this._now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  /** Is a job for `key` (a video path) queued or running? */
  isPending(key) {
    return this._running.has(key);
  }

  /** @param {(state: {cooldownSeconds: number}) => void} fn @returns {() => void} unsubscribe */
  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const state = { cooldownSeconds: this.cooldownSeconds() };
    for (const fn of [...this._listeners]) {
      try { fn(state); } catch { /* one listener must not stop the others */ }
    }
  }

  /**
   * Run `job` once for `key`: while it runs, the same key gets the same
   * promise.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  runFor(key, job) {
    const running = this._running.get(key);
    if (running) return running;
    const promise = Promise.resolve().then(job).finally(() => {
      this._running.delete(key);
      this._emit();
    });
    this._running.set(key, promise);
    this._emit();
    return promise;
  }

  /**
   * Main's answer for one topic, after the requests before it, the gap and
   * any cooldown. Never rejects: a failed IPC answers 'network'.
   * @param {number} topicId
   * @returns {Promise<object>}
   */
  fetch(topicId) {
    const run = this._tail.then(() => this._run(topicId));
    this._tail = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Another forum request a Get tags press makes, in the same line as the
   * topic requests (review-b RB-4): the forced session check after a 401 /
   * 403 / 404. It waits for the requests before it, starts at least
   * `minGapMs` after the last one ended, and its end counts for the next
   * one, so two forum requests are never open at once. In a 429 cooldown it
   * is not sent at all.
   * @template T, F
   * @param {() => Promise<T>} job
   * @param {F} [fallback] the answer in a cooldown, or when the job throws
   * @returns {Promise<T|F>}
   */
  run(job, fallback = undefined) {
    const run = this._tail.then(() => this._runJob(job, fallback));
    this._tail = run.then(() => {}, () => {});
    return run;
  }

  async _runJob(job, fallback) {
    if (this.cooldownSeconds() > 0) return fallback;
    await this._waitGap();
    if (this.cooldownSeconds() > 0) return fallback;
    try {
      return await job();
    } catch {
      return fallback;
    } finally {
      this._lastEnd = this._now();
    }
  }

  _cooldownAnswer() {
    return { ok: false, outcome: 'cooldown', retryAfter: this.cooldownSeconds() };
  }

  async _waitGap() {
    // A loop, not one wait: a timer may fire a hair early.
    for (let gap = this._lastEnd + this._minGapMs - this._now(); gap > 0;
      gap = this._lastEnd + this._minGapMs - this._now()) {
      await this._sleep(gap);
    }
  }

  async _run(topicId) {
    if (this.cooldownSeconds() > 0) return this._cooldownAnswer();
    await this._waitGap();
    if (this.cooldownSeconds() > 0) return this._cooldownAnswer();

    let answer;
    try {
      answer = await this._topicMeta(topicId);
    } catch (err) {
      answer = { ok: false, outcome: 'network', error: String(err?.message || err), errorCode: 'network' };
    } finally {
      this._lastEnd = this._now();
    }
    if (!answer || typeof answer !== 'object') {
      answer = { ok: false, outcome: 'network', error: 'No answer', errorCode: 'network' };
    }
    if (answer.outcome === 'rateLimited') this._startCooldown(answer.retryAfter);
    return answer;
  }

  _startCooldown(retryAfter) {
    const seconds = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(MAX_COOLDOWN_S, Math.max(1, Math.ceil(retryAfter)))
      : DEFAULT_COOLDOWN_S;
    this._cooldownUntil = Math.max(this._cooldownUntil, this._now() + seconds * 1000);
    if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
    // Tell the buttons when it is over, so they come back without a click.
    this._cooldownTimer = setTimeout(() => {
      this._cooldownTimer = null;
      this._emit();
    }, Math.max(0, this._cooldownUntil - this._now()));
    this._emit();
  }
}

let defaultQueue = null;

/** The app's one queue, on window.funsync.eroscriptsTopicMeta. */
export function tagFetchQueue() {
  if (!defaultQueue) {
    defaultQueue = new TagFetchQueue({
      topicMeta: async (topicId) => {
        const api = globalThis.window?.funsync;
        if (typeof api?.eroscriptsTopicMeta !== 'function') {
          return { ok: false, outcome: 'network', error: 'eroscriptsTopicMeta is not available', errorCode: 'network' };
        }
        return api.eroscriptsTopicMeta(topicId);
      },
    });
  }
  return defaultQueue;
}

async function defaultIsLoggedIn() {
  try {
    const status = await globalThis.window?.funsync?.eroscriptsStatus?.();
    return status?.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Get tags for one video: resolve its post, check the login, wait its turn,
 * make the one request, store what it means, and say what happened.
 *
 * | answer                | stored                                   | outcome.kind   |
 * |-----------------------|------------------------------------------|----------------|
 * | 200 with a tags list  | the record replaced (applyTopicMeta)     | 'success'      |
 * | 200 / 404 after the   | nothing (Change post…, its Undo, a       | 'superseded'   |
 * |   record changed      |   download changed it since the press)   |                |
 * | 200, no tags list     | nothing                                  | 'unknown'      |
 * | 200, a hub's title,   | nothing (the hub is remembered for the   | 'hub'          |
 * |   a post not picked   |   session: no longer the video's post)   |                |
 * | 404                   | `stale: true` on the record, tags kept   | 'gone'         |
 * | 404, the login dead   | nothing (the session check said so)      | 'loginAgain'   |
 * | 401 / 403, login dead | nothing                                  | 'loginAgain'   |
 * | 401 / 403, login good | nothing (or the check could not tell)    | 'error'        |
 * | 429 (or in cooldown)  | nothing                                  | 'cooldown'     |
 * | network / other       | nothing                                  | 'error'        |
 * | logged out            | nothing, and no request                  | 'loginRequired'|
 * | no post for the script| nothing, and no request                  | 'notOffered'   |
 * `userTags` and `hiddenTags` are never written, whatever the answer.
 *
 * @param {object} input
 * @param {string} input.videoPath
 * @param {string|null} input.scriptPath the video's script now
 * @param {{get: Function, set: Function}} input.settings
 * @param {object|null} [input.scriptMeta] see resolveTopic
 * @param {object|null} [input.link] see resolveTopic
 * @param {() => (boolean|Promise<boolean>)} [input.isLoggedIn] default: main's
 *   eroscriptsStatus
 * @param {() => Promise<boolean>} [input.login] opens the login window (the
 *   panel's own login, so the session is saved); true when logged in after.
 *   Given, a logged-out press logs in first and then runs once.
 * @param {(opts: {force: boolean}) => Promise<string>} [input.checkSession]
 *   the panel's session check (it drops a dead login itself); asked, forced,
 *   after a 401 / 403 and before a 404 marks the post gone, through the
 *   queue (TagFetchQueue.run: never beside another forum request, 1 s
 *   apart). Without it a 404 marks the post, and a 401 / 403 leaves the
 *   check to the caller.
 * @param {TagFetchQueue} [input.queue] default: the app's one queue
 * @param {() => number} [input.now]
 * @returns {Promise<object>} the outcome (see outcomeMessage)
 */
export function getTagsForVideo(input = {}) {
  const queue = input.queue || tagFetchQueue();
  if (typeof input.videoPath !== 'string' || !input.videoPath) {
    return Promise.resolve({ kind: 'notOffered', resolution: { state: 'none' } });
  }
  return queue.runFor(input.videoPath, () => runGetTags(input, queue));
}

async function runGetTags(input, queue) {
  const { videoPath, scriptPath, settings } = input;
  const now = typeof input.now === 'function' ? input.now : () => Date.now();
  // The record as it was when Get tags was pressed: the answer is written
  // only if it is still exactly that (RB-1).
  const pressed = scriptTagsFingerprint(settings, videoPath);
  const resolution = resolveTopic({
    record: getScriptTags(settings, videoPath),
    scriptPath,
    scriptMeta: input.scriptMeta,
    link: input.link,
    videoPath,
  });
  if (resolution.state !== 'known') return { kind: 'notOffered', resolution };
  // The record changed while the request waited or ran (Change post…, its
  // Undo, a download, another link): the answer is about a post the video no
  // longer names, so nothing is written and the section says so quietly.
  const superseded = () => scriptTagsFingerprint(settings, videoPath) !== pressed;
  // The forced session check after a refusal or a 404, in the queue's line.
  const forcedCheck = typeof input.checkSession === 'function'
    ? () => queue.run(() => input.checkSession({ force: true }), 'unknown')
    : null;

  if (queue.cooldownSeconds() > 0) return { kind: 'cooldown', seconds: queue.cooldownSeconds() };

  const isLoggedIn = typeof input.isLoggedIn === 'function' ? input.isLoggedIn : defaultIsLoggedIn;
  let loggedIn = false;
  try { loggedIn = (await isLoggedIn()) === true; } catch { loggedIn = false; }
  if (!loggedIn && typeof input.login === 'function') {
    try { loggedIn = (await input.login()) === true; } catch { loggedIn = false; }
  }
  if (!loggedIn) return { kind: 'loginRequired' };

  const answer = await queue.fetch(resolution.topicId);
  switch (answer.outcome) {
    case 'ok': {
      // A creator's index / hub post the press could not tell before the
      // request (a bare /t/<id> link, a record with no title): its tags are
      // never this video's unless you picked it (Dave, 2026-11-19). Nothing
      // is written; for the rest of the session it counts as not linked.
      if (!isUserPickedMatch(resolution.match) && isHubTopic(answer.meta)) {
        learnHubTopic(resolution.topicId, { creator: answer.meta?.creator });
        return { kind: 'hub', topicId: resolution.topicId, creator: textOrNull(answer.meta?.creator) };
      }
      if (!Array.isArray(answer.meta?.tags)) return { kind: 'unknown', topicId: resolution.topicId };
      if (superseded()) return { kind: 'superseded', topicId: resolution.topicId };
      const res = applyTopicMeta(settings, videoPath, answer.meta, {
        scriptPath, match: resolution.match, now: now(),
      });
      if (!res.written) return { kind: 'unknown', topicId: resolution.topicId };
      return { kind: 'success', count: res.count, newCount: res.newCount, record: res.record };
    }
    case 'notFound': {
      if (superseded()) return { kind: 'superseded', topicId: resolution.topicId };
      // The forum hides a post a logged-out visitor may not see behind a 404,
      // and it reads a timed-out login as logged out: before the post is
      // called gone, the session check (forced) decides (2026-11-18). A dead
      // login stores nothing and asks to log in again (the check already
      // dropped it); a good one, or one it could not check, is as before.
      if (forcedCheck) {
        const state = await forcedCheck();
        if (state === 'expired' || state === 'loggedOut') {
          return { kind: 'loginAgain', authExpired: true, sessionChecked: true };
        }
      }
      // Checked again after the session check, which waited its turn.
      if (superseded()) return { kind: 'superseded', topicId: resolution.topicId };
      return { kind: 'gone', topicId: resolution.topicId, marked: markScriptTagsStale(settings, videoPath, resolution.topicId) };
    }
    case 'authExpired': {
      // The session check (forced, in the queue's line) decides whether the
      // login is dead; a good one, or one it could not check, is kept and
      // the refusal is said instead. Without the check, the caller asks.
      if (!forcedCheck) return { kind: 'loginAgain', authExpired: true };
      const state = await forcedCheck();
      if (state === 'expired' || state === 'loggedOut') {
        return { kind: 'loginAgain', authExpired: true, sessionChecked: true };
      }
      return {
        kind: 'error', sessionChecked: true, sessionKept: true,
        answer: { ...answer, errorCode: 'accessDenied', error: answer.error || 'Access denied' },
      };
    }
    case 'loginRequired':
      return { kind: 'loginRequired' };
    case 'rateLimited':
    case 'cooldown':
      return { kind: 'cooldown', seconds: queue.cooldownSeconds() || DEFAULT_COOLDOWN_S };
    default:
      return { kind: 'error', answer };
  }
}

/**
 * The words for an outcome, as a key and its params (null for none). A
 * network or other failure has no key of its own: eroscripts-error-text.js
 * words it, so outcomeText is the one to call for display.
 * @param {object} outcome
 * @returns {{key: string, params?: object}|null}
 */
export function outcomeMessage(outcome) {
  switch (outcome?.kind) {
    case 'success':
      return outcome.count > 0
        ? { key: FETCH_KEYS.success, params: { count: outcome.count, newCount: outcome.newCount } }
        : { key: FETCH_KEYS.successEmpty };
    case 'unknown': return { key: FETCH_KEYS.unknown };
    case 'hub': return { key: FETCH_KEYS.hub };
    case 'superseded': return { key: FETCH_KEYS.superseded };
    case 'gone': return { key: FETCH_KEYS.gone };
    case 'loginAgain': return { key: FETCH_KEYS.loginAgain };
    case 'loginRequired': return { key: FETCH_KEYS.loginRequired };
    case 'cooldown': return { key: FETCH_KEYS.cooldown, params: { seconds: outcome.seconds } };
    case 'notOffered': {
      const r = outcome.resolution || {};
      if (r.state === 'otherScript') return { key: FETCH_KEYS.otherScript, params: { name: r.scriptName } };
      if (r.state === 'noScript') return { key: FETCH_KEYS.noScript };
      if (r.hub) return { key: FETCH_KEYS.hubNote };
      return { key: FETCH_KEYS.noPost };
    }
    default: return null;
  }
}

/**
 * The text the live line shows for an outcome (plain text: set it with
 * textContent; a script name in it is the user's own file name).
 * @param {object} outcome
 * @param {(key: string, params?: object) => string} [translate]
 * @returns {string}
 */
export function outcomeText(outcome, translate = t) {
  if (outcome?.kind === 'error') return eroscriptsErrorText(outcome.answer, translate);
  const msg = outcomeMessage(outcome);
  return msg ? translate(msg.key, msg.params) : '';
}

/**
 * How a video's Get tags button looks right now.
 * @param {object} input
 * @param {object} input.resolution resolveTopic's answer for the video
 * @param {boolean} input.loggedIn
 * @param {boolean} input.pending this video's request is queued or running
 * @param {number} input.cooldownSeconds the queue's cooldown
 * @returns {{offered: boolean, disabled: boolean, busy: boolean, labelKey: string|null, params?: object}}
 */
export function buttonState({ resolution, loggedIn, pending, cooldownSeconds }) {
  if (resolution?.state !== 'known') return { offered: false, disabled: true, busy: false, labelKey: null };
  if (pending) return { offered: true, disabled: true, busy: true, labelKey: FETCH_KEYS.running };
  if (cooldownSeconds > 0) {
    return { offered: true, disabled: true, busy: false, labelKey: FETCH_KEYS.cooldown, params: { seconds: cooldownSeconds } };
  }
  if (!loggedIn) return { offered: true, disabled: false, busy: false, labelKey: FETCH_KEYS.loginButton };
  return { offered: true, disabled: false, busy: false, labelKey: FETCH_KEYS.button };
}
