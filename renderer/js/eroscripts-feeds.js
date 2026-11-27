// EroScripts feeds: saved lists with a "new" badge (Dave, 2026-11-22: "custom
// queues based on tags and other things ... a badge for new ones showing the
// number of new ones"; scope: notes/features/SCOPE-eroscripts-feeds.md).
//
// A feed is the tab's own choices saved under a name: price, video / length /
// device, any forum tags, optional search words. Stored in
// `eroscripts.feeds`. The checker reads each feed's first page in the
// background, one feed at a time, and counts the threads started since the
// feed was last opened.

import { normalizeFilters, filterTags, decorateQuery, matchesFilters } from './eroscripts-browse.js';
import { normalizePriceFilter, matchesPrice } from './eroscripts-price.js';

export const SETTING_FEEDS = 'eroscripts.feeds';
export const MAX_FEEDS = 30;
export const MAX_TAGS = 5;
export const LATEST_PAGE = 30;           // the forum's newest list answers 30 a page
export const SEARCH_PAGE = 50;           // its search, 50
export const CHECK_EVERY_MS = 15 * 60 * 1000;   // Dave, 2026-11-23: every 15 minutes (was 30)
export const STALE_AFTER_MS = 5 * 60 * 1000;
export const CHECK_GAP_MS = 1500;

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** "pmv, #Hentai  multi-axis" -> ['pmv', 'hentai', 'multi-axis'] (forum tag slugs, each once). */
export function parseTags(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\s,]+/)) {
    const tag = raw.trim().toLowerCase().replace(/^#+/, '');
    if (TAG_RE.test(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function isoOr(value, fallback) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

/** A stored feed, made whole and safe (anything odd falls back to a default). */
export function normalizeFeed(feed, now = Date.now()) {
  const f = feed && typeof feed === 'object' ? feed : {};
  const nowIso = new Date(now).toISOString();
  // Tags chosen in the tab's filter bar (2026-11-23) join the feed's own tags.
  const fromBar = normalizeFilters(f.filters).tags;
  const filters = normalizeFilters({ ...(f.filters || {}), tags: [] });
  const own = filterTags(filters);
  const tags = [...new Set([...parseTags(Array.isArray(f.tags) ? f.tags.join(',') : f.tags), ...fromBar])].filter((t) => !own.includes(t));
  return {
    id: typeof f.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(f.id) ? f.id : newFeedId(now),
    name: String(f.name || '').trim().slice(0, 80),
    price: normalizePriceFilter(f.price),
    filters,
    tags: tags.slice(0, Math.max(0, MAX_TAGS - own.length)),
    words: String(f.words || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    notify: f.notify === true,
    createdAt: isoOr(f.createdAt, nowIso),
    lastSeenAt: isoOr(f.lastSeenAt, isoOr(f.createdAt, nowIso)),
    newCount: Number.isSafeInteger(f.newCount) && f.newCount > 0 ? f.newCount : 0,
    full: f.full === true,
    checkedAt: isoOr(f.checkedAt, null),
  };
}

export function newFeedId(now = Date.now()) {
  return `f${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Every forum tag a feed asks for: its filters' tags, then its own (at most 5). */
export function feedTags(feed) {
  const own = filterTags(feed?.filters);
  const extra = Array.isArray(feed?.tags) ? feed.tags.filter((t) => !own.includes(t)) : [];
  return [...own, ...extra].slice(0, MAX_TAGS);
}

/**
 * How to ask the forum for a feed's newest threads:
 *   no words: {kind: 'latest', price, opts: {sort: 'newest', period: 'all', tags}}
 *   words:    {kind: 'search', query}: the words (in titles), the price's hashtag, the
 *             first tag (the rest checked on the results, as a search does),
 *             newest threads first.
 */
export function feedRequest(feed) {
  const tags = feedTags(feed);
  if (feed?.words) {
    const base = decorateQuery(feed.words, { price: feed.price, sort: 'newest', filters: null });
    // in:title: the words in the thread's title, not anywhere in any reply
    // (a feed of "pmv mix" listed "Tent - jav mix" without it, seen live).
    const query = [base, 'in:title', tags.length ? `tags:${tags[0]}` : '', 'order:latest_topic'].filter(Boolean).join(' ');
    return { kind: 'search', query, tags };
  }
  return { kind: 'latest', price: normalizePriceFilter(feed?.price), opts: { sort: 'newest', period: 'all', tags }, tags };
}

/** Does a thread belong in the feed? (Search results are checked here; the newest list was asked with them.) */
export function inFeed(topic, feed) {
  if (!matchesPrice(topic, feed?.price)) return false;
  if (!matchesFilters(topic, feed?.filters)) return false;
  const extra = Array.isArray(feed?.tags) ? feed.tags : [];
  if (!extra.length || !Array.isArray(topic?.tags)) return true;
  const have = new Set(topic.tags.map((t) => String(t).toLowerCase()));
  return extra.every((t) => have.has(t));
}

/**
 * New threads in a page: started after `sinceIso`. `full` when every thread
 * of a whole page is new (the badge then reads "30+").
 */
export function countNew(results, sinceIso, pageSize) {
  const since = Date.parse(sinceIso);
  const list = Array.isArray(results) ? results : [];
  if (!Number.isFinite(since)) return { count: 0, full: false };
  const count = list.filter((r) => Date.parse(r?.createdAt) > since).length;
  return { count, full: count > 0 && count === list.length && list.length >= pageSize };
}

export function badgeText(feed) {
  const n = Number(feed?.newCount) || 0;
  if (!n) return '';
  return feed.full ? `${n}+` : String(n);
}

/** A name made from a feed's parts, for a feed saved without one. */
export function defaultFeedName(feed, label) {
  const parts = [];
  if (feed.words) parts.push(`"${feed.words}"`);
  for (const t of feed.tags || []) parts.push(t);
  const f = feed.filters || {};
  if (f.video && f.video !== 'any') parts.push(label('video', f.video));
  if (f.length && f.length !== 'any') parts.push(label('length', f.length));
  if (f.device && f.device !== 'any') parts.push(label('device', f.device));
  if (feed.price && feed.price !== 'all') parts.push(label('price', feed.price));
  return (parts.join(' · ') || label('all', '')).slice(0, 80);
}

/**
 * Checks every feed in the background: one at a time, CHECK_GAP_MS apart,
 * every CHECK_EVERY_MS, and on demand when the last check is stale. Writes
 * only the counts it found (newCount, full, checkedAt), merged into what is
 * stored at that moment, so an edit made meanwhile is kept.
 */
export class FeedChecker {
  /**
   * @param {object} o
   * @param {{get: Function, set: Function}} o.settings
   * @param {(price, page, opts) => Promise} o.latest   window.funsync.eroscriptsLatest
   * @param {(query, page) => Promise} o.search          window.funsync.eroscriptsSearch
   * @param {() => boolean} [o.loggedIn]
   * @param {(feed, count) => void} [o.onMore]          a check found more new threads than before
   * @param {() => void} [o.onChange]                   counts changed
   * @param {() => number} [o.now]
   * @param {(ms: number) => Promise} [o.wait]
   */
  constructor({ settings, latest, search, loggedIn = () => true, onMore = null, onChange = null, now = () => Date.now(), wait = null }) {
    this._settings = settings;
    this._latest = latest;
    this._search = search;
    this._loggedIn = loggedIn;
    this._onMore = onMore;
    this._onChange = onChange;
    this._now = now;
    this._wait = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._timer = null;
    this._running = null;
  }

  feeds() {
    const raw = this._settings?.get?.(SETTING_FEEDS);
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_FEEDS).map((f) => normalizeFeed(f, this._now()));
  }

  /** Replace one feed's fields in the stored list (by id); returns the new list. */
  update(id, patch) {
    const list = this.feeds();
    const i = list.findIndex((f) => f.id === id);
    if (i < 0) return list;
    list[i] = normalizeFeed({ ...list[i], ...patch }, this._now());
    this._settings?.set?.(SETTING_FEEDS, list);
    return list;
  }

  totalNew() {
    return this.feeds().reduce((n, f) => n + (f.newCount || 0), 0);
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.checkAll().catch(() => {}); }, CHECK_EVERY_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Check when any feed has not been checked in the last few minutes. */
  checkIfStale() {
    const now = this._now();
    const stale = this.feeds().some((f) => !f.checkedAt || now - Date.parse(f.checkedAt) > STALE_AFTER_MS);
    return stale ? this.checkAll() : Promise.resolve(false);
  }

  /** Every feed, one after another. Never two runs at once. */
  checkAll() {
    if (this._running) return this._running;
    this._running = (async () => {
      try {
        const ids = this.feeds().map((f) => f.id);
        for (let i = 0; i < ids.length; i += 1) {
          if (!this._loggedIn()) return false;
          if (i > 0) await this._wait(CHECK_GAP_MS);
          await this.checkOne(ids[i]);
        }
        return true;
      } finally {
        this._running = null;
      }
    })();
    return this._running;
  }

  async checkOne(id) {
    const feed = this.feeds().find((f) => f.id === id);
    if (!feed) return null;
    const req = feedRequest(feed);
    let answer = null;
    try {
      answer = req.kind === 'search' ? await this._search(req.query, 1) : await this._latest(req.price, 0, req.opts);
    } catch { answer = null; }
    if (!answer || answer.error) return null;
    const page = (answer.results || []).filter((t) => inFeed(t, feed));
    // The feed as it is now: opened or edited while the request was out.
    const current = this.feeds().find((f) => f.id === id);
    if (!current) return null;
    const { count, full } = countNew(page, current.lastSeenAt, req.kind === 'search' ? SEARCH_PAGE : LATEST_PAGE);
    const before = current.newCount || 0;
    this.update(id, { newCount: count, full, checkedAt: new Date(this._now()).toISOString() });
    if (count !== before) this._onChange?.();
    if (count > before && current.notify) this._onMore?.(current, count);
    return count;
  }
}
