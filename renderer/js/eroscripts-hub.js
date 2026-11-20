// A creator's INDEX / hub post on EroScripts is never one video's post
// unless you picked it (found 2026-11-19 by Dave: "all posts have a few
// [tags] so if you managed to get the creator name there must be some
// tags?").
//
// Some prolific creators put the same link in the metadata of every script
// they make: their "Script Index" or "Content Hub" topic, a post that lists
// (or holds) all of their scripts. That post has no tags, or tags for the
// whole catalogue, so taking it as the video's post gave the video none or
// wrong ones while it looked linked. Get tags (eroscripts-tag-fetch.js) now
// passes such a post over, exactly as if the script named no post, and the
// tag merge (video-options-model.js eroscriptsRecordForTags) leaves out a
// saved record about one. Nothing is deleted.
//
// What says "hub", strongest first:
//   - the topic's TITLE (the topic JSON Get tags reads; the record a download
//     or Get tags saved): "script index", "content hub", "index of", "my
//     scripts", "script collection", "master list" and their kin;
//   - the SLUG in a `/t/<slug>/<id>` link: the forum makes it from the title,
//     so the script's own link tells before any request is sent;
//   - a few hub topics known by id (the ones Dave's library named on
//     2026-11-19), for a bare `/t/<id>` link with no slug;
//   - a hub learned this session: a Get tags answer whose title said so
//     (memory only; the next press after a restart learns it again).
// Not used: how many funscripts the post carries. getTopicMeta does not read
// the attachments, and one video's own post can carry many too (a multi-axis
// set, variants, a pack), so a count would call real posts hubs.
//
// A post YOU picked (Paste a post link…, Find the post…, Change post…: match
// 'manual' / 'search') is never second-guessed, hub or not: you chose it.
//
// Pure, but for the learned set.

import { TAG_MATCH } from './script-tags.js';

/** Hub topics known by id (topic titles read 2026-11-19): Slibowitz "Content Hub", and the "Script Index" posts of Husky, Sobolsdaemon1, Zalunda and Nosse. */
export const KNOWN_HUB_TOPICS = Object.freeze([13335, 16609, 34342, 35290, 50898]);
const KNOWN = new Set(KNOWN_HUB_TOPICS);

/** How a record or a link found its post, when YOU picked it. */
export const USER_PICKED_MATCHES = Object.freeze([TAG_MATCH.MANUAL, TAG_MATCH.SEARCH]);
const PICKED = new Set(USER_PICKED_MATCHES);

// On the folded text (lower case, separators as single spaces).
const HUB_PATTERNS = [
  /\bscripts? (?:index|hub|collection|list|catalog(?:ue)?|directory|archive)\b/,
  /\bcontent hub\b/,
  /\bindex of\b/,
  /\b(?:collection|list|catalog(?:ue)?|archive) of (?:(?:my|all|the|our) )*scripts\b/,
  /\bmy scripts\b/,
  /\bmaster ?list\b/,
];

const MAX_TEXT = 1000;
const MAX_LEARNED = 1000;
const TOPIC_HOST = 'discuss.eroscripts.com';

const learned = new Map(); // topicId -> {creator}

function topicIdOf(value) {
  const id = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^@/, '');
  return text && text.length <= MAX_TEXT ? text : null;
}

/**
 * Does a post title (or a slug) name a creator's index / hub post?
 * "Husky - Script Index", "Slibowitz Content Hub", "husky-script-index",
 * "Index of my scripts", "My Scripts", "Script collection", "Master list".
 * @param {unknown} text
 * @returns {boolean}
 */
export function isHubTitle(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return false;
  const folded = text.toLowerCase()
    .replace(/[-_.+/\\|:;,()[\]{}<>"'’‘“”–—~!?#*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return HUB_PATTERNS.some((re) => re.test(folded));
}

/**
 * The slug of a forum topic link (`/t/<slug>/<id>`), or null: a bare
 * `/t/<id>` link, another host, not a link. Never fetched.
 * @param {unknown} url
 * @returns {string|null}
 */
export function slugOfTopicUrl(url) {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) return null;
  let parsed;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol) || parsed.hostname.toLowerCase() !== TOPIC_HOST) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] !== 't' || parts.length < 3 || /^\d+$/.test(parts[1])) return null;
  let slug;
  try { slug = decodeURIComponent(parts[1]); } catch { slug = parts[1]; }
  return slug || null;
}

/**
 * Is this topic a creator's index / hub post? By its title, its slug (given,
 * or read from its link), its id among the known hubs, or a hub learned
 * this session.
 * @param {{topicId?: number, id?: number, title?: string|null, slug?: string|null, url?: string|null}|null} topic
 * @returns {boolean}
 */
export function isHubTopic(topic) {
  if (!topic || typeof topic !== 'object') return false;
  const id = topicIdOf(topic.topicId ?? topic.id);
  if (id != null && (KNOWN.has(id) || learned.has(id))) return true;
  return isHubTitle(topic.title) || isHubTitle(topic.slug) || isHubTitle(slugOfTopicUrl(topic.url));
}

/** Did you pick this post yourself (Paste, Find the post, Change post…)? */
export function isUserPickedMatch(match) {
  return PICKED.has(match);
}

/**
 * A saved record (`library.scriptTags[videoPath]`) that names a hub you did
 * NOT pick: a download from the hub, or a Get tags of the script's own hub
 * link before this fix. It counts as "not linked": Get tags passes it over
 * and its tags are not the video's. It is never deleted or rewritten; the
 * next post you link replaces it.
 * @param {unknown} record
 * @returns {boolean}
 */
export function isAutoHubRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (isUserPickedMatch(record.match)) return false;
  return isHubTopic({ topicId: record.topicId, title: record.title, url: record.topicUrl });
}

/**
 * Remember, for this session, that a topic is a hub (a Get tags answer's
 * title said so), with its creator for Find the post's order.
 * @param {number} topicId
 * @param {{creator?: string|null}} [info]
 */
export function learnHubTopic(topicId, { creator = null } = {}) {
  const id = topicIdOf(topicId);
  if (id == null) return;
  if (!learned.has(id) && learned.size >= MAX_LEARNED) learned.delete(learned.keys().next().value);
  learned.set(id, { creator: textOrNull(creator) });
}

/** The creator a learned hub named, or null. */
export function learnedHubCreator(topicId) {
  return learned.get(topicIdOf(topicId))?.creator ?? null;
}

/** Tests only: forget the hubs learned this session. */
export function _forgetLearnedHubsForTests() {
  learned.clear();
}

/**
 * Find the post's results in the order to show them (link mode): posts by
 * `preferCreator` (the script's creator, when its metadata names one) first,
 * then the others, and index / hub posts last. Kept in the forum's order
 * within each group; nothing is left out (you may still pick a hub).
 * @param {Array<{id?: number, title?: string, url?: string, creator?: string}>} list
 * @param {string|null} [preferCreator]
 * @returns {Array}
 */
export function orderLinkResults(list, preferCreator = null) {
  if (!Array.isArray(list)) return [];
  const want = textOrNull(preferCreator)?.toLowerCase() ?? null;
  const rank = (topic) => {
    if (isHubTopic({ topicId: topic?.id, title: topic?.title, url: topic?.url })) return 2;
    const creator = textOrNull(topic?.creator);
    return want && creator && creator.toLowerCase() === want ? 0 : 1;
  };
  return list
    .map((topic, index) => ({ topic, index, rank: rank(topic) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.topic);
}
