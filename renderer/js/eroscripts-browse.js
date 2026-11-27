// Browsing EroScripts in the tab: sort, tag filters, the chips a card shows,
// and what the library already holds (Dave, 2026-11-22: "do all of those").
//
// The forum's own tags (read from 450+ threads, 2026-11-22): `vr` / `non-vr`;
// lengths `len-0-2`, `len-2-5`, `len-5-10`, `len-10-25`, `len-25-60`,
// `len-60-plus` (and `len-multiple`); devices `multi-axis`, `sr6`, `osr2`,
// `the-handy`, `the-handy-2-pro`. The newest list filters by tag on the
// forum (every tag must be on the thread); a search sends one tag (its
// `tags:a+b` did not hold every tag, seen live) and the rest are checked here.

import { sameNameScriptPath } from './script-tags.js';

export const SORTS = Object.freeze(['newest', 'top-weekly', 'top-monthly', 'top-yearly', 'top-all']);
export const VIDEO_FILTERS = Object.freeze({ any: null, vr: 'vr', flat: 'non-vr' });
export const LENGTH_TAGS = Object.freeze(['len-0-2', 'len-2-5', 'len-5-10', 'len-10-25', 'len-25-60', 'len-60-plus']);
export const DEVICE_FILTERS = Object.freeze({ any: null, multi: 'multi-axis', handy: 'the-handy' });
/** The forum takes at most 5 tags in a list request; the Video / Length / Device choices count. */
export const MAX_FILTER_TAGS = 5;
/** Tags to hide (Dave, 2026-11-23: "no results with for example pmv or animation"): checked here, any number up to 10. */
export const MAX_HIDE_TAGS = 10;
const TAG_SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Your own tags (Dave, 2026-11-23: "search by tag in the eroscripts tab"): forum slugs, once each, in order. */
function cleanTags(list, taken = []) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const tg = String(raw || '').trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-');
    if (TAG_SLUG.test(tg) && !out.includes(tg) && !taken.includes(tg)) out.push(tg);
  }
  return out;
}

export function normalizeSort(value) {
  return SORTS.includes(value) ? value : 'newest';
}

/** {sort: 'newest'|'top', period} for main's latest(). */
export function sortParams(value) {
  const s = normalizeSort(value);
  return s === 'newest' ? { sort: 'newest', period: 'all' } : { sort: 'top', period: s.slice(4) };
}

export function normalizeFilters(value) {
  const v = value && typeof value === 'object' ? value : {};
  const f = {
    video: Object.prototype.hasOwnProperty.call(VIDEO_FILTERS, v.video) ? v.video : 'any',
    length: LENGTH_TAGS.includes(v.length) ? v.length : 'any',
    device: Object.prototype.hasOwnProperty.call(DEVICE_FILTERS, v.device) ? v.device : 'any',
  };
  const fixed = fixedTags(f);
  f.tags = cleanTags(v.tags, fixed).slice(0, Math.max(0, MAX_FILTER_TAGS - fixed.length));
  // Hidden tags never clash with a wanted one (a wanted tag wins).
  f.hide = cleanTags(v.hide, [...fixed, ...f.tags]).slice(0, MAX_HIDE_TAGS);
  return f;
}

/** The tags the Video / Length / Device choices stand for. */
function fixedTags(f) {
  return [VIDEO_FILTERS[f.video], f.length === 'any' ? null : f.length, DEVICE_FILTERS[f.device]].filter(Boolean);
}

/** The forum tags the filters ask for, in a fixed order: the choices, then your own tags. */
export function filterTags(filters) {
  const f = normalizeFilters(filters);
  return [...fixedTags(f), ...f.tags];
}

/** How many of your own tags still fit beside the choices. */
export function tagRoom(filters) {
  const f = normalizeFilters(filters);
  return Math.max(0, MAX_FILTER_TAGS - fixedTags(f).length);
}

export function anyFilter(filters) {
  return filterTags(filters).length > 0;
}

/**
 * Does a thread carry every tag the filters ask for, and none they hide?
 * (A thread whose tags are not known: kept.) Hidden tags are checked only
 * here: the forum's lists cannot leave several tags out.
 */
export function matchesFilters(topic, filters) {
  const f = normalizeFilters(filters);
  const want = filterTags(f);
  if (!want.length && !f.hide.length) return true;
  if (!Array.isArray(topic?.tags)) return true;
  const have = new Set(topic.tags.map((t) => String(t).toLowerCase()));
  if (f.hide.some((t) => have.has(t))) return false;
  return want.every((t) => have.has(t));
}

/** Any filter at all, hidden tags included (the empty note's words). */
export function anyFilterOrHide(filters) {
  const f = normalizeFilters(filters);
  return filterTags(f).length > 0 || f.hide.length > 0;
}

/**
 * A search query with the tab's choices: the price's category hashtag, Top as
 * the forum's `order:likes`, and the first filter tag as `tags:` (the rest are
 * checked on the results).
 */
export function decorateQuery(query, { price = 'all', sort = 'newest', filters = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return q;
  const parts = [q];
  if (price === 'free') parts.push('#free-scripts');
  else if (price === 'paid') parts.push('#paid-scripts');
  if (normalizeSort(sort) !== 'newest') parts.push('order:likes');
  const tags = filterTags(filters);
  if (tags.length) parts.push(`tags:${tags[0]}`);
  return parts.join(' ');
}

/**
 * What a card shows about a thread from its tags: {video: 'vr'|'flat'|null,
 * length: one of LENGTH_TAGS or null, multi: boolean}.
 */
export function cardTags(tags) {
  const have = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase()));
  const video = have.has('vr') || have.has('jav-vr') ? 'vr' : (have.has('non-vr') ? 'flat' : null);
  const length = LENGTH_TAGS.find((t) => have.has(t)) || null;
  const multi = have.has('multi-axis') || have.has('sr6') || have.has('osr2');
  return { video, length, multi };
}

/**
 * The videos the library already has from a post, by topic id: every record
 * a download or "Get tags" left in `library.scriptTags` (keyed by video path;
 * its script: the record's `scriptPath`, else the video's same-name script,
 * which is what downloads before that field saved). A post can be behind
 * several videos (two copies, an older download): every one, in order, as
 * [{video, script}]; the card shows a tick when any of them is still there.
 */
export function libraryByTopic(scriptTags) {
  const out = new Map();
  if (!scriptTags || typeof scriptTags !== 'object') return out;
  for (const [videoPath, rec] of Object.entries(scriptTags)) {
    const id = Number(rec?.topicId);
    if (!Number.isSafeInteger(id) || id <= 0 || !videoPath) continue;
    const script = typeof rec.scriptPath === 'string' && rec.scriptPath ? rec.scriptPath : sameNameScriptPath(videoPath);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ video: videoPath, script });
  }
  return out;
}

/**
 * Does a thread carry none of the hidden tags? The newest list's own check:
 * the forum has already applied the wanted tags there (re-checking them
 * here could drop a thread the forum matched by a tag synonym).
 */
export function passesHidden(topic, filters) {
  const hide = normalizeFilters(filters).hide;
  if (!hide.length || !Array.isArray(topic?.tags)) return true;
  const have = new Set(topic.tags.map((t) => String(t).toLowerCase()));
  return !hide.some((t) => have.has(t));
}
