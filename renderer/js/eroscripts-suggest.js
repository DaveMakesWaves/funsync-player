// "Suggested for you" in the EroScripts tab (Dave, 2026-11-24: "a suggested
// feed based on tags that appear most in the users library, a curated
// selection of posts which the user doesn't have or doesn't have linked to a
// post organised by date exclude length tags and suggest other things which
// wouldn't be relevant to a users preference").
//
// The taste comes from the library: the EroScripts post tags of every linked
// video (library.scriptTags) and the user's own tags (library.userTags).
// Tags that describe the gear, the format, the price or how the script was
// made say nothing about taste and are left out (NOT_TASTE). The rest are
// ranked by how much MORE often they show in the library than on the forum,
// so the tags nearly every post carries ("real", "straight") do not swamp it.
// The feed asks the forum for the newest posts with ANY of the top tags;
// posts the user has or has linked, the other format, Hide tags and the
// ones marked "Not interested" are left out here.

import { LENGTH_TAGS } from './eroscripts-browse.js';

export const SUGGEST_ID = 'suggested';
export const SUGGEST_TAGS = 5;          // the forum takes 5 tags at most
const SETTING_DISMISSED = 'eroscripts.suggestDismissed';
const SETTING_LEFT_OUT = 'eroscripts.suggestLeftOut';
const MAX_DISMISSED = 2000;

/** Tags that are not a taste: length, devices and tools, price and source, format. */
export const NOT_TASTE = new Set([
  ...LENGTH_TAGS,
  // devices and tools
  'the-handy', 'handy', 'osr', 'osr2', 'osr2-plus', 'sr6', 'ssr1', 't-code', 'tcode', 'multi-axis', 'multiaxis',
  'vibration', 'vibe', 'vibrator', 'vibrators', 'lovense', 'kiiroo', 'keon', 'autoblow', 'autoblow-ai-ultra',
  'autoblow-ultra', 'vacuglide', 'vacuglide-2', 'intiface', 'buttplug', 'ofs', 'openfunscripter',
  'ai', 'ai-assisted', 'ai-generated', 'ai-script', 'auto-generated', 'motion-tracking', 'mtfg',
  // price and source
  'free', 'free-script', 'paid', 'paid-script', 'only-fans', 'onlyfans', 'patreon', 'fansly', 'payhip', 'gumroad',
  // format (a hard filter, not a taste: formatPreference)
  'vr', 'non-vr', '2d', 'flat',
  // how the script was made (live 2026-11-24: "action-based" led a library's taste)
  'action-based', 'beat-based', 'beat', 'beats', 'rhythm-based', 'manual', 'handmade',
  // the forum's own words for a script post
  'funscript', 'script', 'scripts', 'script-request', 'request', 'update', 'updated',
]);

/** Device, tool and scripting-style tags by their shape (the-handy-2-pro, osr2-plus, multi-device, hybrid-based). */
const NOT_TASTE_RE = /^(the-)?handy(-|$)|^osr|^sr6|^ssr\d|^keon|^lovense|^kiiroo|^autoblow|^vacuglide|^t-?code|^multi-?(axis|device|script)|^vib|-based$|^len-/;

/** Not a taste tag: the list, or a device / tool / style by its shape. */
export function isNotTaste(tag) {
  return NOT_TASTE.has(tag) || NOT_TASTE_RE.test(tag);
}

/**
 * Genres: what a library can be "none of" (avoidTags). An act (doggy,
 * titfuck) the library happens not to have says little; a genre the forum
 * is full of and the library is not (animation for a real-only library, real
 * for an anime one) says a lot (live 2026-11-24).
 */
export const GENRES = new Set([
  'animation', 'animated', 'anime', 'hentai', 'cartoon', '3d', 'cgi', 'mmd', 'vam', 'sfm', 'koikatsu', 'game', 'games',
  'furry', 'futa', 'futanari', 'gay', 'trans', 'femboy', 'sissy', 'real', 'jav',
  'pmv', 'hmv', 'cock-hero', 'fap-hero', 'joi', 'asmr', 'audio', 'cosplay', 'loli', 'monster', 'tentacles',
]);

/** A tag as the forum spells it: lower case, dashes for spaces. */
export function tagSlug(text) {
  return String(text || '').trim().toLowerCase().replace(/^#+/, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
}

/**
 * How many videos carry each tag: {counts: Map<tag, videos>, videos}. A video
 * counts once per tag, from its post's tags and the user's own tags.
 */
export function libraryTagCounts(scriptTags, userTags) {
  const perVideo = new Map();
  const add = (path, tag) => {
    const slug = tagSlug(typeof tag === 'string' ? tag : tag?.name);
    if (!slug) return;
    if (!perVideo.has(path)) perVideo.set(path, new Set());
    perVideo.get(path).add(slug);
  };
  for (const [path, rec] of Object.entries(scriptTags && typeof scriptTags === 'object' ? scriptTags : {})) {
    if (!rec || rec.topicId == null) continue;         // linked to a post: that post's tags
    for (const tag of Array.isArray(rec.tags) ? rec.tags : []) add(path, tag);
  }
  for (const [path, tags] of Object.entries(userTags && typeof userTags === 'object' ? userTags : {})) {
    for (const tag of Array.isArray(tags) ? tags : []) add(path, tag);
  }
  const counts = new Map();
  for (const tags of perVideo.values()) for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  return { counts, videos: perVideo.size };
}

/** 'vr' or 'flat' when most of the library is one (60% or more), else null. */
export function formatPreference({ counts, videos }) {
  if (!videos) return null;
  if ((counts.get('vr') || 0) / videos >= 0.6) return 'vr';
  if ((counts.get('non-vr') || 0) / videos >= 0.6) return 'flat';
  return null;
}

/**
 * How often each tag is on the forum's own script posts: {counts, posts},
 * from a sample of them (the newest pages). The forum's tag list counts are
 * no use for this: they leave the script categories out (seen 2026-11-24:
 * "blowjob" 45, "the-handy" 830).
 */
export function baselineCounts(topics) {
  const counts = new Map();
  let posts = 0;
  for (const tp of Array.isArray(topics) ? topics : []) {
    const own = new Set((Array.isArray(tp?.tags) ? tp.tags : []).map((t) => tagSlug(typeof t === 'string' ? t : t?.name)).filter(Boolean));
    if (!own.size) continue;
    posts += 1;
    for (const t of own) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return { counts, posts };
}

/**
 * The library's taste tags, best first: [{tag, videos, score}]. With a
 * `baseline` (baselineCounts of the forum's newest script posts) a tag
 * scores by how much more often it is in the library than on the forum:
 * its share of the library / its (smoothed) share of the forum's posts. A
 * tag nearly every post has ("real", "straight") then sinks: in an
 * any-of-these query it would match most of the forum. With `known` (the
 * forum's tag names) a tag the forum does not have is skipped (a query on it
 * finds nothing). Without a baseline: by count. A tag needs 2 videos or a
 * tenth of the library (1 in a library under 5); `leftOut` tags (the user's
 * choice) are skipped.
 */
export function rankTasteTags({ counts, videos }, { baseline = null, known = null } = {}, { max = SUGGEST_TAGS, leftOut = [] } = {}) {
  const skip = new Set((Array.isArray(leftOut) ? leftOut : []).map(tagSlug));
  const names = known && known.size ? known : null;
  const base = baseline && baseline.posts > 0 ? baseline : null;
  const need = videos < 5 ? 1 : Math.max(2, Math.ceil(videos * 0.1));
  const out = [];
  for (const [tag, n] of counts) {
    if (isNotTaste(tag) || skip.has(tag) || n < need) continue;
    if (names && !names.has(tag)) continue;
    const forumShare = base ? (base.counts.get(tag) || 0) / base.posts : 0;
    const score = base
      ? (n / Math.max(1, videos)) / (((base.counts.get(tag) || 0) + 1) / (base.posts + 2))
      : n;
    // Broad: on 30% or more of the forum's posts; alone it does not make a suggestion.
    out.push({ tag, videos: n, score, broad: forumShare >= BROAD_SHARE });
  }
  out.sort((a, b) => b.score - a.score || b.videos - a.videos || a.tag.localeCompare(b.tag));
  return out.slice(0, Math.max(0, max));
}

const BROAD_SHARE = 0.3;
/** A genre on this share of the forum's posts (and 3 at least)... */
const AVOID_FORUM_SHARE = 0.1;
/** ...and in the library at under this part of the forum's share: "your library has (almost) none of it". */
const AVOID_RATIO = 0.25;
/** A library smaller than this cannot say what it never has. */
const AVOID_MIN_VIDEOS = 10;

/**
 * The genres the library has (almost) none of, though the forum's posts
 * often carry them (live 2026-11-24: a library 95% "real" with one animated
 * video was offered animated posts because they were tagged blowjob;
 * "animation" was on 37 of the forum's 60 newest): [{tag, posts}], most
 * common first, at most 8. Posts with one of these are not suggested. Only
 * GENRES (an act the library lacks says little); `allowed` ones (the user's
 * choice) never.
 */
export function avoidTags({ counts, videos }, baseline, { allowed = [] } = {}) {
  if (!baseline?.posts || videos < AVOID_MIN_VIDEOS) return [];
  const ok = new Set((Array.isArray(allowed) ? allowed : []).map(tagSlug));
  const out = [];
  for (const [tag, n] of baseline.counts) {
    if (!GENRES.has(tag) || ok.has(tag)) continue;
    if (n < Math.max(3, baseline.posts * AVOID_FORUM_SHARE)) continue;
    if ((counts.get(tag) || 0) / videos >= (n / baseline.posts) * AVOID_RATIO) continue;
    out.push({ tag, posts: n });
  }
  return out.sort((a, b) => b.posts - a.posts || a.tag.localeCompare(b.tag)).slice(0, 8);
}

/** Which of the suggested tags a post has, in their order. */
export function suggestionReason(topic, tags) {
  const has = new Set((Array.isArray(topic?.tags) ? topic.tags : []).map((t) => tagSlug(typeof t === 'string' ? t : t?.name)));
  return (Array.isArray(tags) ? tags : []).map((t) => t.tag || t).filter((t) => has.has(t));
}

/**
 * Is this post a suggestion? Not one the user has or has linked (`have`), of
 * the library's format when it has one, none of the Hide tags nor of what
 * the library has none of (`avoid`), not marked "Not interested", and with a
 * suggested tag that is not broad, or two of them.
 */
export function passesSuggested(topic, { tags = [], format = null, hide = [], avoid = [], dismissed = {}, have = () => false } = {}) {
  if (!topic || topic.id == null) return false;
  if (have(topic)) return false;
  if (dismissed && Object.prototype.hasOwnProperty.call(dismissed, String(topic.id))) return false;
  const own = new Set((Array.isArray(topic.tags) ? topic.tags : []).map((t) => tagSlug(typeof t === 'string' ? t : t?.name)));
  if (format === 'vr' && !own.has('vr')) return false;
  if (format === 'flat' && own.has('vr')) return false;
  for (const h of Array.isArray(hide) ? hide : []) if (own.has(tagSlug(h))) return false;
  for (const a of Array.isArray(avoid) ? avoid : []) if (own.has(tagSlug(a?.tag || a))) return false;
  const why = suggestionReason(topic, tags);
  const broad = new Set((Array.isArray(tags) ? tags : []).filter((t) => t?.broad).map((t) => t.tag));
  return why.some((t) => !broad.has(t)) || why.length >= 2;
}

/** "Not interested": the topics (id -> when), newest kept, at most MAX_DISMISSED. */
export function readDismissed(settings) {
  const v = settings?.get?.(SETTING_DISMISSED);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function dismissTopic(settings, id, on = true) {
  const next = { ...readDismissed(settings) };
  if (on) next[String(id)] = Date.now();
  else delete next[String(id)];
  const kept = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, MAX_DISMISSED);
  settings?.set?.(SETTING_DISMISSED, Object.fromEntries(kept));
}

const SETTING_ALLOWED = 'eroscripts.suggestAllowed';
/** Tags the user allowed back (avoidTags would otherwise leave them out). */
export function readAllowed(settings) {
  const v = settings?.get?.(SETTING_ALLOWED);
  return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
}

export function setAllowed(settings, tag, on = true) {
  const slug = tagSlug(tag);
  const now = readAllowed(settings).filter((t) => t !== slug);
  if (on && slug) now.push(slug);
  settings?.set?.(SETTING_ALLOWED, now.slice(-50));
}

/** Tags the user left out of their suggestions. */
export function readLeftOut(settings) {
  const v = settings?.get?.(SETTING_LEFT_OUT);
  return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
}

export function setLeftOut(settings, tag, on = true) {
  const slug = tagSlug(tag);
  const now = readLeftOut(settings).filter((t) => t !== slug);
  if (on && slug) now.push(slug);
  settings?.set?.(SETTING_LEFT_OUT, now.slice(-50));
}
