// EroScripts API — Discourse REST API client for discuss.eroscripts.com
// Runs in main process (no CORS restrictions).

const log = require('./logger');

const BASE_URL = 'https://discuss.eroscripts.com';

// The OS part of a Chrome User-Agent: what Chrome itself sends on each OS
// (frozen by Chrome's User-Agent reduction, whatever the OS version or CPU).
// Any other OS reads as Linux.
const UA_PLATFORM = Object.freeze({
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
});

/**
 * The User-Agent of every EroScripts request: this client's, the login's
 * session check and the login window's (Dave, 2026-11-18, option (b) of the
 * video options design's question 3). The real Chromium User-Agent the app
 * runs on, with ` FunSyncPlayer/<version>` after it, so the forum can tell
 * the app's traffic apart while the login page and Cloudflare still see a
 * browser. It used to be a fixed Chrome 120 string that did not name the app.
 * One string for the client and the login window: Cloudflare ties its
 * clearance cookie to the User-Agent that earned it.
 *
 * No "Electron/…" token and no npm package-name token. An odd value gives
 * `0` in its place, never a header with stray characters.
 * @param {{chrome?: unknown, platform?: string, version?: unknown}} parts
 *   process.versions.chrome, process.platform, the app version
 * @returns {string}
 */
function eroscriptsUserAgent({ chrome, platform, version } = {}) {
  const v = typeof version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? version : '0';
  const c = typeof chrome === 'string' && /^\d{1,6}(\.\d{1,6}){0,3}$/.test(chrome) ? chrome : '0.0.0.0';
  const os = Object.prototype.hasOwnProperty.call(UA_PLATFORM, platform) ? UA_PLATFORM[platform] : UA_PLATFORM.linux;
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${c} Safari/537.36 FunSyncPlayer/${v}`;
}

function _appVersion() {
  try { return require('../package.json').version; } catch { return null; }
}

// Built once, in the main process, from the Chromium it runs on.
const USER_AGENT = eroscriptsUserAgent({
  chrome: process.versions.chrome,
  platform: process.platform,
  version: _appVersion(),
});

// Diagnostic logging — routes through electron-log so entries land in the
// rotating main log under %APPDATA%/funsync-player/logs/ (5MB cap) instead
// of a hand-rolled file in the install dir that silently fails to write on
// packaged Windows builds (Program Files is read-only).
function _debugLog(msg) {
  try { log.debug(`[EroScripts] ${msg}`); } catch { /* log unavailable */ }
}

/**
 * Pick a thumbnail from a Discourse `thumbnails[]` array.
 *
 * Entries come in several sizes (typically 1366/1920, 1024, 800, 400, 200,
 * 100, 50 px wide, the smaller ones as `optimized/` derivatives). The
 * smallest entry at least `MIN_THUMB_WIDTH` wins — big enough not to look
 * soft, small enough not to pull a full-size image per row.
 *
 * 400 because the row renders the thumbnail at 120 CSS px, which is 240
 * device px on a 2x display: a 200px source would be upscaled and visibly
 * soft there, while 1024+ is wasteful for a 120px slot. Topics whose
 * original is smaller than 400 (plenty are ~200) have no such entry and
 * fall through to the largest they do offer.
 *
 * @param {Array<{width?: number, url?: string}>} thumbnails
 * @returns {string|null}
 */
const MIN_THUMB_WIDTH = 400;

/**
 * Decode the HTML entities Discourse emits inside post markup.
 *
 * Attachment names come from the link TEXT of the rendered `cooked` HTML,
 * so a script called `Luna Snow & Sue Storm.funscript` arrives as
 * `Luna Snow &amp; Sue Storm.funscript` and would be saved to disk under
 * that literal name. That also breaks multi-axis pairing, which matches a
 * main against its companions by exact base name.
 *
 * Deliberately a small explicit table plus numeric refs rather than a DOM
 * round-trip: this runs in the main process, where there is no document.
 */
const _ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(_ENTITIES, key)) return _ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    // Unknown entity — leave it alone rather than mangling the name.
    return whole;
  });
}

/** A search headline's HTML marks (<span class="search-highlight">) gone; '' for none. */
function stripTags(html) {
  if (typeof html !== 'string') return '';
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

/**
 * Is `url` on the EroScripts origin: https, host eroscripts.com or one of its
 * subdomains (discuss., and the eroscripts-discourse. CDN)? The session
 * cookie goes only there (R3-04: it was sent to whatever URL was passed).
 * @param {unknown} url
 * @returns {boolean}
 */
/**
 * A post's links that leave the forum, in order, once each: `[{url, text}]`
 * (the EroScripts tab, 2026-11-22). Forum links (other posts, uploads,
 * mentions, tags) and anything not http(s) are left out.
 * @param {string} html  a post's `cooked` HTML
 */
function extractExternalLinks(html) {
  const out = [];
  const seen = new Set();
  // Links, and embedded players: a post can carry its video only as an
  // iframe (an erosync.net embed, 2026-11-22: the tab said "no video").
  const re = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<iframe\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const url = decodeEntities(m[1] ?? m[3]).trim();
    if (!/^https?:\/\//i.test(url) || isEroScriptsUrl(url)) continue;
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    if (!host || host === 'eroscripts.com' || host.endsWith('.eroscripts.com')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: m[2] === undefined ? '' : stripTags(m[2]).trim().slice(0, 200) });
    if (out.length >= 50) break;
  }
  return out;
}

/** A post's like count (Discourse: like_count, or actions_summary id 2). */
function likeCount(p) {
  const n = Number(p?.like_count);
  if (Number.isFinite(n) && n >= 0) return n;
  const a = Array.isArray(p?.actions_summary) ? p.actions_summary.find((x) => x && x.id === 2) : null;
  return Number.isFinite(Number(a?.count)) ? Number(a.count) : 0;
}

/** A reply's HTML without its quotes (a quote repeats an earlier post). */
function withoutQuotes(html) {
  return String(html || '').replace(/<aside\b[^>]*class="[^"]*\bquote\b[^"]*"[\s\S]*?<\/aside>/gi, '');
}

const SCRIPT_FILE_RE = /\.(funscript|zip)$/i;

/**
 * A post's attached .funscript / .zip files: [{name, url}], each URL once
 * (forum-relative made absolute). An attachment is a link Discourse marked
 * `class="attachment"` with a script's name, OR any link to a FORUM upload
 * whose path ends .funscript / .zip: a poster who writes [name](upload://...)
 * without "|attachment" gets a plain link (test day 2026-11-24, B002:
 * "Collect Mandy's Rent - GTA VI" showed "No script in this post"). Another
 * host's link named "x.funscript" is not an attachment. `upload://` hrefs are
 * left to the short-URL lookup.
 */
function attachmentAnchors(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const hrefMatch = /\bhref="([^"]+)"/i.exec(m[1]);
    if (!hrefMatch) continue;
    const href = decodeEntities(hrefMatch[1]).trim();
    if (!href || href.startsWith('upload://') || href.startsWith('#')) continue;
    const url = /^https?:\/\//i.test(href) ? href : (href.startsWith('/') ? `${BASE_URL}${href}` : null);
    if (!url) continue;
    const text = decodeEntities(stripTags(m[2])).trim();
    const classed = /\bclass="[^"]*\battachment\b[^"]*"/i.test(m[1]);
    let path = '';
    try { path = decodeURIComponent(new URL(url).pathname); } catch { continue; }
    const upload = isEroScriptsUrl(url) && /\/uploads\//i.test(path);
    let name = null;
    if (SCRIPT_FILE_RE.test(text) && (classed || upload)) name = text;
    else if (upload && SCRIPT_FILE_RE.test(path)) name = path.split('/').pop();
    if (!name || seen.has(url)) continue;
    seen.add(url);
    out.push({ name, url });
  }
  return out;
}

/**
 * Scripts attached to a topic's REPLIES (the EroScripts review 2.5,
 * 2026-11-23: "The scripter posted v2 in reply #23"): each reply's
 * .funscript / .zip attachments, newest reply first, each URL once. Each:
 * {name, url, postNumber, username, createdAt, likes}. Quotes are dropped.
 */
function extractReplyAttachments(posts, firstPostUrls = []) {
  const out = [];
  const seen = new Set(firstPostUrls);
  const replies = (Array.isArray(posts) ? posts : [])
    .filter((p) => p && Number(p.post_number) > 1)
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)
      || Number(b.post_number) - Number(a.post_number));
  for (const p of replies) {
    for (const a of attachmentAnchors(withoutQuotes(p.cooked))) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      out.push({ ...a, postNumber: Number(p.post_number), username: p.username || '', createdAt: p.created_at || null, likes: likeCount(p) });
      if (out.length >= 40) return out;
    }
  }
  return out;
}

/** The post reader's copy of a post: its HTML (capped) and who / when / likes. */
const MAX_POST_HTML = 200000;
const MAX_REPLY_HTML = 20000;
const MAX_READER_REPLIES = 60;
function readerPost(p, cap) {
  return {
    postNumber: Number(p?.post_number) || 0,
    username: typeof p?.username === 'string' ? p.username : '',
    createdAt: p?.created_at || null,
    likes: likeCount(p),
    cooked: String(p?.cooked || '').slice(0, cap),
  };
}

/** A script preview's most actions (a long script is ~20k). */
const MAX_PREVIEW_ACTIONS = 100000;
/** A post image's most bytes (a preview GIF can be big). */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif)$/;

/**
 * Links posted in a topic's REPLIES (Dave, 2026-11-22: "sometimes the original
 * link dies and someone comments a replacement link"): the off-forum links of
 * every post after the first, newest post first, each once, none the first
 * post already has. Quotes are dropped first (a quote repeats the first
 * post's links). Each: {url, text, postNumber, username, createdAt}.
 */
function extractReplyLinks(posts, firstPostUrls = []) {
  const out = [];
  const seen = new Set(firstPostUrls);
  const replies = (Array.isArray(posts) ? posts : [])
    .filter((p) => p && Number(p.post_number) > 1)
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)
      || Number(b.post_number) - Number(a.post_number));
  for (const p of replies) {
    for (const l of extractExternalLinks(withoutQuotes(p.cooked))) {
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      out.push({ ...l, postNumber: Number(p.post_number), username: p.username || '', createdAt: p.created_at || null, likes: likeCount(p) });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

/**
 * A category's latest topic list as search results (the EroScripts tab's
 * opening list): free (14) and paid (15) script threads only, pinned ones
 * (the category's own "About" thread) left out, each with its original
 * poster as the creator.
 */
const TOP_PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'all'];

function latestTopicsToResults(data) {
  const users = new Map((data?.users || []).map((u) => [u.id, u]));
  const topics = data?.topic_list?.topics || [];
  const out = [];
  for (const t of topics) {
    if (!t || t.pinned || t.pinned_globally) continue;
    if (t.category_id !== 14 && t.category_id !== 15) continue;
    const op = (t.posters || []).find((p) => /original poster/i.test(p.description || '')) || (t.posters || [])[0];
    const user = op ? users.get(op.user_id) : null;
    let avatar = user?.avatar_template ? user.avatar_template.replace('{size}', '90') : null;
    if (avatar && !avatar.startsWith('http')) avatar = `${BASE_URL}${avatar}`;
    let thumbnail = t.image_url || null;
    if (thumbnail && !thumbnail.startsWith('http')) thumbnail = `${BASE_URL}${thumbnail}`;
    out.push({
      id: t.id,
      title: t.title || `#${t.id}`,
      slug: t.slug || null,
      createdAt: t.created_at || null,
      likeCount: t.like_count || 0,
      views: t.views || 0,
      // The forum list's own columns (the tab's list view, 2026-11-22).
      replies: Math.max(0, (Number(t.posts_count) || 1) - 1),
      activityAt: t.bumped_at || t.last_posted_at || t.created_at || null,
      tags: normaliseTags(t.tags) || [],
      thumbnail,
      avatar,
      creator: user?.username || null,
      url: `${BASE_URL}/t/${t.slug || t.id}/${t.id}`,
      categoryId: t.category_id,
    });
  }
  return out;
}

/** /tags.json as [{name, count}], each once, most used first (grouped tags included). */
function forumTagList(data) {
  const all = [...(Array.isArray(data?.tags) ? data.tags : [])];
  for (const g of data?.extras?.tag_groups || []) all.push(...(Array.isArray(g?.tags) ? g.tags : []));
  const byName = new Map();
  for (const t of all) {
    const name = String(t?.text || t?.name || t?.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)) continue;
    const count = Number(t?.count) || 0;
    if (!byName.has(name) || byName.get(name) < count) byName.set(name, count);
  }
  return [...byName.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function isEroScriptsUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'eroscripts.com' || host.endsWith('.eroscripts.com');
}

/**
 * The requests a window session sends to the forum's hosts (eroscripts.com
 * and its subdomains: discuss., the CDN), whatever the scheme.
 */
const FORUM_REQUEST_FILTER = Object.freeze({
  urls: Object.freeze(['*://eroscripts.com/*', '*://*.eroscripts.com/*']),
});

function isForumHostUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'eroscripts.com' || host.endsWith('.eroscripts.com');
}

/**
 * Forum images the app's own windows load (search thumbnails and avatars,
 * also the Tags section's "Find the post" rows: `<img>` in the renderer, not
 * this client) carry the same EroScripts User-Agent as every other EroScripts
 * request (review-b RB-3; Dave's answer 3). They used to go out with
 * Electron's default one, which names Electron and the npm package.
 *
 * Hooks `onBeforeSendHeaders` on `session`, filtered to the forum's hosts,
 * and sets the User-Agent only there: every other host keeps its own. One
 * listener per session (Electron keeps the last one registered), so this is
 * the window session's only one.
 * @param {{webRequest?: {onBeforeSendHeaders?: Function}}} session
 * @param {string} [userAgent]
 * @returns {boolean} whether the hook was set
 */
function installForumUserAgent(session, userAgent = USER_AGENT) {
  const hook = session?.webRequest?.onBeforeSendHeaders;
  if (typeof hook !== 'function') return false;
  hook.call(session.webRequest, FORUM_REQUEST_FILTER, (details, callback) => {
    const requestHeaders = { ...(details?.requestHeaders || {}) };
    if (isForumHostUrl(details?.url)) {
      for (const name of Object.keys(requestHeaders)) {
        if (name.toLowerCase() === 'user-agent') delete requestHeaders[name];
      }
      requestHeaders['User-Agent'] = userAgent;
    }
    callback({ requestHeaders });
  });
  return true;
}

// The file types a download may be saved as: what getTopicAttachments keeps.
const DOWNLOAD_EXT_RE = /\.(funscript|zip)$/i;

// A download fetched for a look (`checkOnly`) is kept this long for the write
// that follows the user's answer, so one download is one request.
const FETCH_KEEP_MS = 5 * 60 * 1000;
// ...and at most this many downloads, and this many bytes in all (R4-09: a
// few large .zip attachments could hold hundreds of MB in main). The newest
// is kept even when it alone is larger, for the write that follows its look.
const FETCH_KEEP_COUNT = 16;
const FETCH_KEEP_BYTES = 64 * 1024 * 1024;

/**
 * The save path as the OS spells it (R4-11): `path.normalize` for the
 * platform, so `C:/x/a.funscript` from a dialog stub or a renderer becomes
 * `C:\x\a.funscript` before anything is trashed or written (`shell.trashItem`
 * rejects a forward-slash Windows path). Not a string: returned unchanged,
 * for the check to refuse.
 */
function normalizeSavePath(savePath, platform = process.platform) {
  if (typeof savePath !== 'string' || !savePath || savePath.includes('\0')) return savePath;
  const path = require('path');
  return (platform === 'win32' ? path.win32 : path.posix).normalize(savePath);
}

/**
 * Is this a save path the download may write to (R4-12)? On Windows only a
 * drive-letter path (`X:\...`) or a UNC path (`\\server\share\...`):
 * `path.isAbsolute` is also true for `\x.funscript` (the root of whatever
 * drive is current) and `\\.\` device paths. Elsewhere, absolute as before.
 * Takes the normalized path.
 */
function isAbsoluteSavePath(savePath, platform = process.platform) {
  if (platform !== 'win32') return require('path').posix.isAbsolute(savePath);
  if (/^[A-Za-z]:\\/.test(savePath)) return true;
  return /^\\\\[^\\.?][^\\]*\\[^\\]+\\/.test(savePath);
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  const usable = thumbnails.filter(x => x && typeof x.url === 'string' && x.url);
  if (usable.length === 0) return null;
  const big = usable
    .filter(x => Number(x.width) >= MIN_THUMB_WIDTH)
    .sort((a, b) => Number(a.width) - Number(b.width));
  return (big[0] || usable[0]).url;
}

// A result's tags, or null when the response didn't say (FT-066). Null is
// "unknown" and must stay distinct from [] ("this post has no tags"):
// script-tags.js stores a list as a real answer and writes nothing for null,
// so coercing a missing field to [] used to record "no tags" for posts that
// have them, and could overwrite a good record.
function normaliseTags(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter(tag => tag != null)
    .map(tag => typeof tag === 'string' ? tag : (tag.name || tag.text || String(tag)));
}

// What one topic may put in a tag record (config.json is rewritten whole on
// every write): a longer list keeps its first tags, a longer name or title is
// left out rather than cut into something else.
const MAX_TOPIC_TAGS = 200;
const MAX_TAG_NAME = 200;
const MAX_TOPIC_TEXT = 1000;
const SLUG_RE = /^[A-Za-z0-9_%-]{1,255}$/;

function _shortText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

// One tag as the topic JSON sends it: a string (older Discourse) or
// `{id, name, slug}` (what discuss.eroscripts.com sends now). The id is kept:
// it survives a staff rename of the tag.
function _topicTag(raw) {
  if (typeof raw === 'string') {
    const name = _shortText(raw, MAX_TAG_NAME);
    return name ? { name } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const name = _shortText(raw.name, MAX_TAG_NAME) || _shortText(raw.slug, MAX_TAG_NAME)
    || _shortText(raw.text, MAX_TAG_NAME);
  if (!name) return null;
  return Number.isSafeInteger(raw.id) && raw.id > 0 ? { id: raw.id, name } : { name };
}

/**
 * The facts a topic's JSON (`GET /t/{id}.json`) gives about the post: its id,
 * slug, title, creator (`details.created_by.username`), tags and state.
 *
 * `tags` is null when the JSON has no `tags` list: UNKNOWN, which must stay
 * distinct from [] ("this post has no tags"), as for search results (FT-066).
 * `status` is the topic's own state: 'open', 'closed', 'archived' or
 * 'deleted'. Anything that is not a topic (no positive id) gives null.
 *
 * Pure: no request, no log. getTopicMeta and getTopicAttachments both use it.
 * @param {unknown} json
 * @returns {{topicId: number, slug: string|null, title: string|null,
 *   creator: string|null, tags: {id?: number, name: string}[]|null,
 *   status: string, url: string}|null}
 */
function parseTopicMeta(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const topicId = json.id;
  if (!Number.isSafeInteger(topicId) || topicId <= 0) return null;
  const slug = typeof json.slug === 'string' && SLUG_RE.test(json.slug) ? json.slug : null;
  const title = _shortText(json.title, MAX_TOPIC_TEXT)
    || _shortText(decodeEntities(json.fancy_title), MAX_TOPIC_TEXT);
  const firstPost = json.post_stream?.posts?.[0];
  const creator = _shortText(json.details?.created_by?.username, MAX_TAG_NAME)
    || (firstPost?.post_number === 1 ? _shortText(firstPost.username, MAX_TAG_NAME) : null);
  let tags = null;
  if (Array.isArray(json.tags)) {
    tags = [];
    const seen = new Set();
    for (const raw of json.tags) {
      const tag = _topicTag(raw);
      if (!tag || seen.has(tag.name.toLowerCase())) continue;
      seen.add(tag.name.toLowerCase());
      tags.push(tag);
      if (tags.length >= MAX_TOPIC_TAGS) break;
    }
  }
  const status = json.deleted_at ? 'deleted' : json.archived ? 'archived' : json.closed ? 'closed' : 'open';
  return { topicId, slug, title, creator, tags, status, url: `${BASE_URL}/t/${slug || 'topic'}/${topicId}` };
}

// The most a Retry-After may hold the client back, so a broken header cannot
// switch Get tags off for the rest of the day.
const MAX_RETRY_AFTER_S = 3600;

/**
 * A `Retry-After` header as whole seconds from `now`: delta-seconds or an
 * HTTP date. Null when absent or unreadable; at most MAX_RETRY_AFTER_S.
 * @param {unknown} value
 * @param {number} [now] epoch ms
 * @returns {number|null}
 */
function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  let seconds;
  if (/^\d{1,10}$/.test(text)) {
    seconds = Number(text);
  } else {
    // An HTTP date names its month ("Wed, 18 Nov 2026 10:00:30 GMT");
    // Date.parse alone would read "-5" or "1.5" as dates.
    const at = /[A-Za-z]{3}/.test(text) ? Date.parse(text) : NaN;
    if (!Number.isFinite(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(MAX_RETRY_AFTER_S, Math.max(0, seconds));
}

// The session check (Dave, 2026-11-18): is the saved login cookie still good?
// A definite answer is kept this long, so opening the panel, the inline search
// or the Tags section again and again sends one request, not one per open. A
// login or a logout starts over.
const SESSION_CHECK_TTL_MS = 5 * 60 * 1000;
// "Could not check" is asked again sooner, but not on every open either.
const SESSION_RECHECK_MS = 30 * 1000;
// A check that has not answered by then could not check (a hung connection
// must not hold the panel's search).
const SESSION_CHECK_TIMEOUT_MS = 10 * 1000;
// The same for Get tags' one topic request (review-b RB-5): a stalled answer
// held the renderer's one-at-a-time queue, so every Get tags button in the
// app waited for minutes. Past this it is a network error: nothing is
// written, and the queue moves on.
const TOPIC_META_TIMEOUT_MS = SESSION_CHECK_TIMEOUT_MS;

/**
 * What one answer to `GET /session/current.json` (sent with the saved cookie)
 * says about the login. Discourse answers it with the user when the cookie is
 * good and with an empty 404 when it is not (a timed-out or revoked `_t` is
 * read as no user at all; the forum's search then answers 200 with nothing,
 * which is why the panel used to show "no results" while the top bar said
 * connected). Only an answer the forum itself gives is definite; anything
 * that looks like Cloudflare, a proxy or a busy page could not check.
 *
 *   'valid'    2xx JSON with `current_user.username`
 *   'expired'  404 or 401 / 403 with an empty or JSON body; 2xx JSON with
 *              `current_user: null`; or the forum's `Discourse-Logged-Out: 1`
 *              header (on any body that is not HTML)
 *   'unknown'  everything else: an HTML body on any status (Cloudflare's
 *              challenge or block page, the "high load" page, a login page),
 *              a `cf-mitigated: challenge` header, 429, 5xx, a redirect, a
 *              2xx JSON of another shape, a body that is not JSON
 * The network error and the timeout are 'unknown' too (checkSession).
 *
 * @param {{status: number, text?: string, headers?: {get?: (name: string) => (string|null)}}} answer
 * @returns {{state: 'valid'|'expired'|'unknown', username?: string, avatar?: string}}
 */
function classifySessionAnswer({ status, text = '', headers } = {}) {
  const header = (name) => {
    try {
      const v = headers?.get?.(name);
      return typeof v === 'string' ? v.trim().toLowerCase() : '';
    } catch {
      return '';
    }
  };
  const body = typeof text === 'string' ? text.trim() : '';
  // Cloudflare's pages, a proxy's error page or a login page: not the forum's
  // own answer, whatever the status.
  if (body.startsWith('<')) return { state: 'unknown' };
  if (header('cf-mitigated') === 'challenge') return { state: 'unknown' };

  let json;
  if (body) {
    try { json = JSON.parse(body); } catch { return { state: 'unknown' }; }
  }
  if (header('discourse-logged-out') === '1') return { state: 'expired' };

  if (status >= 200 && status < 300) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { state: 'unknown' };
    const user = json.current_user;
    if (user === null) return { state: 'expired' };
    const username = user && typeof user === 'object' ? user.username : null;
    if (typeof username === 'string' && username.trim()) {
      const out = { state: 'valid', username: username.trim() };
      // The tab's account button shows it (Dave, 2026-11-25): no request more.
      const avatar = sessionAvatarUrl(user.avatar_template);
      if (avatar) out.avatar = avatar;
      return out;
    }
    return { state: 'unknown' };
  }
  if (status === 404 || status === 401 || status === 403) return { state: 'expired' };
  return { state: 'unknown' };
}

/**
 * The signed-in user's picture from Discourse's `avatar_template` at 64 px: a
 * path on the forum, or an https address (a CDN's letter avatar). Anything
 * else (another scheme, plain http, not a string) is left out.
 * @param {unknown} template
 * @returns {string|null}
 */
function sessionAvatarUrl(template, size = 64) {
  if (typeof template !== 'string' || !template.trim()) return null;
  let url = template.trim().replace('{size}', String(size));
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('/')) url = `${BASE_URL}${url}`;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// A topic id as the renderer passes it: a positive whole number (or its
// digits). Anything else is refused before a request is made.
function _topicIdArg(topicId) {
  const id = typeof topicId === 'string' && /^\d{1,15}$/.test(topicId) ? Number(topicId) : topicId;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

class EroScriptsAPI {
  constructor() {
    this._cookie = null;
    this._username = null;
    this._sessionCookies = '';
    // Attachment URLs this session read from the forum (getTopicAttachments).
    // The download IPC accepts these as well as the EroScripts origin, so a
    // post whose attachment link points at another host still downloads (the
    // cookie never goes there). Bounded; oldest first out.
    this._issuedUrls = new Set();
    // Downloads fetched by a look (`checkOnly`), reused by the write:
    // url → { buffer, at }.
    this._fetched = new Map();
    // The byte cap on that copy (R4-09); a property so a test can lower it.
    this._fetchKeepBytes = FETCH_KEEP_BYTES;
    // The session check's last answer ({cookie, state, username, at}) and the
    // one in flight ({cookie, generation, promise}). A login or a logout
    // bumps the generation, so an answer about the old cookie is never kept.
    this._sessionCheck = null;
    this._sessionCheckInFlight = null;
    this._sessionGeneration = 0;
    // The clock and the timeout, as properties so a test can set them.
    this._now = () => Date.now();
    this._sessionCheckTimeoutMs = SESSION_CHECK_TIMEOUT_MS;
    this._topicMetaTimeoutMs = TOPIC_META_TIMEOUT_MS;
  }

  get isLoggedIn() {
    return !!this._cookie;
  }

  get username() {
    return this._username;
  }

  restoreSession(cookie, username) {
    this._cookie = cookie;
    this._username = username;
    this._sessionCookies = cookie ? `_t=${cookie}` : '';
    this._resetSessionCheck();
    _debugLog(`SESSION restored for ${username}, cookie length: ${(cookie || '').length}`);
  }

  /** A login or a logout: the session check starts over. */
  _resetSessionCheck() {
    this._sessionGeneration += 1;
    this._sessionCheck = null;
    this._sessionCheckInFlight = null;
  }

  /**
   * Validate the current session is still active (the panel asks once at
   * start-up). The session check's answer: only a definite "not logged in"
   * (or no cookie) is invalid; "could not check" (network, timeout, 5xx,
   * Cloudflare) keeps the session, so connectivity never logs anyone out.
   * Before 2026-11-18 the forum's own logged-out answer (an empty 404) read
   * as valid here, so a timed-out login stayed "connected".
   * @returns {Promise<{ valid: boolean }>}
   */
  async validateSession() {
    const { state } = await this.checkSession();
    return { valid: state === 'valid' || state === 'unknown' };
  }

  /**
   * Is the saved login cookie still good? One `GET /session/current.json`
   * with the cookie and the shared User-Agent; what each answer means is
   * classifySessionAnswer. Writes nothing and logs nobody out: the renderer
   * acts on a definite 'expired' (the panel's handleSessionExpired).
   *
   *   'loggedOut'  no cookie: nothing is sent
   *   'valid' / 'expired' / 'unknown'  as classifySessionAnswer; a network
   *                error or a timeout is 'unknown'
   *
   * A 'valid' or 'expired' answer is reused for SESSION_CHECK_TTL_MS, an
   * 'unknown' one for SESSION_RECHECK_MS, unless `force` (a request just came
   * back 401 / 403). Checks asked while one runs share it. A login or a
   * logout (restoreSession, logout) starts over.
   *
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<{state: 'loggedOut'|'valid'|'expired'|'unknown', status?: number, username?: string, avatar?: string, cached?: boolean}>}
   */
  async checkSession({ force = false } = {}) {
    const cookie = this._cookie;
    if (!cookie) return { state: 'loggedOut' };

    const kept = this._sessionCheck;
    if (!force && kept && kept.cookie === cookie) {
      const ttl = kept.state === 'unknown' ? SESSION_RECHECK_MS : SESSION_CHECK_TTL_MS;
      const age = this._now() - kept.at;
      if (age >= 0 && age < ttl) {
        const answer = { state: kept.state, cached: true };
        if (kept.status != null) answer.status = kept.status;
        if (kept.username) answer.username = kept.username;
        if (kept.avatar) answer.avatar = kept.avatar;
        return answer;
      }
    }

    const running = this._sessionCheckInFlight;
    if (running && running.cookie === cookie && running.generation === this._sessionGeneration) {
      return running.promise;
    }

    const generation = this._sessionGeneration;
    const promise = this._askSession().then((answer) => {
      if (this._sessionGeneration === generation && this._cookie === cookie) {
        this._sessionCheck = { cookie, state: answer.state, status: answer.status, username: answer.username, avatar: answer.avatar, at: this._now() };
      }
      return answer;
    }).finally(() => {
      if (this._sessionCheckInFlight?.promise === promise) this._sessionCheckInFlight = null;
    });
    this._sessionCheckInFlight = { cookie, generation, promise };
    return promise;
  }

  /** The one request of a session check. Never throws. */
  async _askSession() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this._sessionCheckTimeoutMs) : null;
    try {
      const resp = await fetch(`${BASE_URL}/session/current.json`, {
        headers: this._headers(),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let text = '';
      try { text = await resp.text(); } catch { text = ''; }
      const { state, username, avatar } = classifySessionAnswer({ status: resp.status, text, headers: resp.headers });
      _debugLog(`SESSION CHECK status=${resp.status} -> ${state}`);
      const answer = { state, status: resp.status };
      if (username) answer.username = username;
      if (avatar) answer.avatar = avatar;
      return answer;
    } catch (err) {
      _debugLog(`SESSION CHECK could not check: ${err?.name || 'error'}`);
      return { state: 'unknown' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  logout() {
    this._cookie = null;
    this._username = null;
    this._sessionCookies = '';
    this._resetSessionCheck();
  }

  /**
   * Search for funscript topics. Logged out, nothing is sent (Dave,
   * 2026-11-18: every EroScripts search needs the login, as Get tags does):
   * the answer is `loginRequired` and the renderer asks to log in.
   */
  async search(query, page = 1) {
    if (!this._cookie) {
      return { results: [], error: 'Not logged in to EroScripts', errorCode: 'loginRequired', loginRequired: true };
    }
    try {
      const params = new URLSearchParams({
        q: `${query} #scripts`,
        page: String(page),
      });

      const resp = await fetch(`${BASE_URL}/search.json?${params}`, {
        headers: this._headers(),
      });

      log.info(`[EroScripts] Search status: ${resp.status} for query: ${query}`);
      _debugLog(`SEARCH query="${query}" status=${resp.status}`);
      _debugLog(`SEARCH cookies sent: ${(this._headers().Cookie || '').length} bytes`);
      if (resp.status !== 200) {
        const bodyPreview = await resp.clone().text();
        _debugLog(`SEARCH error body: ${bodyPreview.substring(0, 500)}`);
      }

      // `error` is English, for the log; `errorCode` (+ `status`) is what the
      // renderer shows, through t() (verify-2, 2026-11-07: the panel printed
      // these English sentences in every language; also in v0.9.2).
      if (resp.status === 429) {
        return { results: [], error: 'Rate limited — try again in a moment', errorCode: 'rateLimited' };
      }
      if (resp.status === 403 || resp.status === 401) {
        // `authExpired` is the machine-readable half of this. The message
        // alone forced every caller to string-match, and the auto-match
        // path simply ignored it — so a dead session looked exactly like
        // "this video has no script", silently, for weeks.
        return { results: [], error: 'Access denied — try logging in again', errorCode: 'accessDenied', authExpired: true };
      }

      const data = await this._safeJson(resp);
      if (!data) {
        return {
          results: [], error: `Search failed (${resp.status}) — try logging out and back in`,
          errorCode: 'searchFailed', status: resp.status,
        };
      }

      // Log structure for debugging
      log.info('[EroScripts] Search response: topics=%d, posts=%d, users=%d',
        (data.topics || []).length, (data.posts || []).length, (data.users || []).length);
      if (data.topics?.length > 0) {
        const t = data.topics[0];
        // Field list and tags called out on their own lines. The truncated
        // dump below used to cut at 500 chars, which lands before `tags` on
        // almost every topic — so "does search actually return tags?" was
        // unanswerable from the logs, despite the parser and the panel both
        // being wired for them.
        log.info('[EroScripts] Topic fields: %s', Object.keys(t).join(','));
        log.info('[EroScripts] Topic tags: %s', JSON.stringify(t.tags ?? null));
        log.info('[EroScripts] Sample topic:', JSON.stringify(t).substring(0, 1500));
      }
      if (data.posts?.length > 0) {
        const p = data.posts[0];
        log.info('[EroScripts] Sample post:', JSON.stringify(p).substring(0, 500));
      }

      const users = new Map((data.users || []).map(u => [u.id, u]));
      const topicsMap = new Map((data.topics || []).map(t => [t.id, t]));
      const posts = data.posts || [];

      // Build results from whichever is available — topics or posts
      let topics;

      if (data.topics && data.topics.length > 0) {
        // Topics available (some Discourse versions return these)
        topics = data.topics.map(t => {
          // A topic without a `tags` field is unknown (null), not "no tags".
          const tags = normaliseTags(t.tags);

          const post = posts.find(p => p.topic_id === t.id);
          const user = post ? users.get(post.user_id) : null;

          // Search topics carry `thumbnails[]` (several sizes), NOT the
          // `image_url` this used to read — that field only exists on the
          // topic endpoint, so every search result came back with a null
          // thumbnail and the panel paid for a second request per row to
          // fetch one. Prefer an entry near the rendered size.
          let thumbnail = pickThumbnail(t.thumbnails) || t.image_url || null;
          if (thumbnail && !thumbnail.startsWith('http')) thumbnail = `${BASE_URL}${thumbnail}`;

          let avatar = post?.avatar_template || null;
          if (avatar) {
            avatar = avatar.replace('{size}', '90');
            if (!avatar.startsWith('http')) avatar = `${BASE_URL}${avatar}`;
          }

          return {
            id: t.id, title: t.title, slug: t.slug,
            createdAt: t.created_at,
            // Like count lives on the POST in a search response, not the
            // topic — `t.like_count` doesn't exist there, so this read 0 for
            // every result and the panel (which hides a 0) showed nothing.
            // The post was already being looked up two lines above for the
            // avatar.
            likeCount: post?.like_count ?? t.like_count ?? 0,
            // `views` genuinely isn't in the search serializer — not on the
            // topic and not on the post. It only exists on /t/{id}.json.
            // Left at 0 rather than faked; the panel hides a 0 view count.
            views: t.views || 0,
            replies: Number.isFinite(Number(t.reply_count)) ? Number(t.reply_count) : Math.max(0, (Number(t.posts_count) || 1) - 1),
            activityAt: t.bumped_at || t.last_posted_at || null,
            tags, thumbnail, avatar,
            // Free or paid (the EroScripts tab, 2026-11-22): the forum files
            // them in separate categories; see renderer/js/eroscripts-price.js.
            categoryId: t.category_id ?? null,
            creator: post?.username || user?.username || null,
            url: `${BASE_URL}/t/${t.slug || t.id}/${t.id}`,
          };
        });
      } else {
        // No topics — build from posts (EroScripts returns results this way)
        const seen = new Set();
        topics = [];

        for (const post of posts) {
          if (seen.has(post.topic_id)) continue;
          seen.add(post.topic_id);

          const rawTopic = topicsMap.get(post.topic_id);
          const user = users.get(post.user_id);

          // Extract thumbnail from post blurb HTML
          let thumbnail = rawTopic?.image_url || null;
          if (!thumbnail && post.blurb) {
            const imgMatch = post.blurb.match(/<img[^>]+src="([^"]+)"/i);
            if (imgMatch) {
              thumbnail = imgMatch[1];
            }
          }
          if (thumbnail && !thumbnail.startsWith('http')) thumbnail = `${BASE_URL}${thumbnail}`;

          // This branch runs only when `data.topics` is empty, so `rawTopic`
          // is always undefined here and `rawTopic?.tags` alone always gave
          // [] — a "no tags" answer for every result (FT-066). Take the
          // post's embedded topic tags when the post carries them; otherwise
          // the tags are unknown (null), and nothing gets recorded.
          const normTags = normaliseTags(
            Array.isArray(rawTopic?.tags) ? rawTopic.tags : post.topic?.tags,
          );

          // Build avatar URL from template
          let avatar = post.avatar_template || null;
          if (avatar) {
            avatar = avatar.replace('{size}', '90');
            if (!avatar.startsWith('http')) avatar = `${BASE_URL}${avatar}`;
          }

          topics.push({
            id: post.topic_id,
            // Never `post.name`: in a Discourse search result that is the
            // POSTER's display name, so the panel and the auto-match toast
            // read "Script found: <author>" (verify-2, by reading; also in
            // v0.9.2). The headline is the topic title with <span> marks.
            // Last resort: the topic NUMBER, as "#<id>", which reads the
            // same in every language. It was the English "Topic <id>" in
            // all eight (E-11); main has no translations, and three
            // renderer views show this title.
            title: rawTopic?.title || post.topic?.title
              || stripTags(post.topic_title_headline) || `#${post.topic_id}`,
            slug: rawTopic?.slug || null,
            createdAt: post.created_at,
            likeCount: post.like_count || rawTopic?.like_count || 0,
            views: rawTopic?.views || 0,
            replies: rawTopic ? Math.max(0, (Number(rawTopic.posts_count) || 1) - 1) : null,
            activityAt: rawTopic?.bumped_at || rawTopic?.last_posted_at || null,
            categoryId: rawTopic?.category_id ?? post.topic?.category_id ?? post.category_id ?? null,
            tags: normTags,
            thumbnail,
            avatar,
            creator: post.username || user?.username || null,
            url: `${BASE_URL}/t/${rawTopic?.slug || post.topic_id}/${post.topic_id}`,
          });
        }
      }

      return { results: topics };
    } catch (err) {
      log.error('[EroScripts] Search error:', err.message);
      return { results: [], error: err.message, errorCode: 'network' };
    }
  }

  /**
   * The newest script threads, for the EroScripts tab when nothing is
   * searched (Dave, 2026-11-22: "by default just show the most recent threads
   * ... free or paid, as long as they are marked as scripts"). `price`:
   * 'free' = Free Scripts (14), 'paid' = Paid Scripts (15), anything else =
   * the Scripts category, of which only those two are kept. Newest first by
   * when the thread was started (Discourse's latest, order=created), a page at
   * a time (0 first). Same result shape as search(); `more` = another page.
   * Logged in only: the script categories are hidden from guests.
   */
  async latest(price = 'all', page = 0, { sort = 'newest', period = 'all', tags = [], anyTags = false } = {}) {
    if (!this._cookie) {
      return { results: [], error: 'Not logged in to EroScripts', errorCode: 'loginRequired', loginRequired: true };
    }
    const p = Number.isSafeInteger(Number(page)) && Number(page) >= 0 ? Number(page) : 0;
    const cat = price === 'free' ? '/c/14' : price === 'paid' ? '/c/15' : '/c/scripts';
    // Most liked: Discourse's top list for a period; Newest: started newest first.
    const top = sort === 'top';
    const per = TOP_PERIODS.includes(period) ? period : 'all';
    const params = new URLSearchParams(top ? { period: per, page: String(p) } : { order: 'created', page: String(p) });
    // Tag filters (VR / 2D, length, multi-axis): every one must be on the
    // thread. `anyTags`: any one of them will do (the Suggested feed,
    // 2026-11-24: the library's taste tags, a post needs only one).
    const wanted = (Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string' && /^[a-z0-9-]{1,60}$/.test(t)).slice(0, 5);
    for (const t of wanted) params.append('tags[]', t);
    if (wanted.length > 1 && !anyTags) params.set('match_all_tags', 'true');
    try {
      const resp = await fetch(`${BASE_URL}${cat}/l/${top ? 'top' : 'latest'}.json?${params}`, { headers: this._headers() });
      log.info(`[EroScripts] Latest status: ${resp.status} for ${price} page ${p}`);
      if (resp.status === 429) return { results: [], error: 'Rate limited — try again in a moment', errorCode: 'rateLimited' };
      if (resp.status === 403 || resp.status === 401) {
        return { results: [], error: 'Access denied — try logging in again', errorCode: 'accessDenied', authExpired: true };
      }
      const data = await this._safeJson(resp);
      if (!data?.topic_list) {
        return { results: [], error: `Latest failed (${resp.status})`, errorCode: 'searchFailed', status: resp.status };
      }
      return { results: latestTopicsToResults(data), more: !!data.topic_list.more_topics_url };
    } catch (err) {
      log.error('[EroScripts] Latest error:', err.message);
      return { results: [], error: err.message, errorCode: 'network' };
    }
  }

  /**
   * Get attachments from a topic's first post.
   */
  /**
   * @param {number|string} topicId
   * @param {{replies?: boolean}} [opts] replies: also read the newest replies
   *   the topic JSON did not carry (at most 2 more requests, 40 posts), for
   *   `replyLinks` (the EroScripts tab's download window).
   */
  async getTopicAttachments(topicId, { replies = false } = {}) {
    try {
      const resp = await fetch(`${BASE_URL}/t/${topicId}.json`, {
        headers: this._headers(),
      });

      if (resp.status === 429) {
        return { attachments: [], error: 'Rate limited', errorCode: 'rateLimited' };
      }
      if (resp.status === 403 || resp.status === 401) {
        return { attachments: [], error: 'Access denied — try logging in again', errorCode: 'accessDenied', authExpired: true };
      }

      const data = await this._safeJson(resp);
      if (!data) {
        return {
          attachments: [], error: `Failed to load topic (${resp.status})`,
          errorCode: 'topicFailed', status: resp.status,
        };
      }

      const firstPost = data.post_stream?.posts?.[0];
      if (!firstPost) {
        return { attachments: [], error: 'No posts found', errorCode: 'noPosts' };
      }

      const attachments = [];
      const html = firstPost.cooked || '';

      // Discourse attachment links, and plain links to a forum upload (B002).
      attachments.push(...attachmentAnchors(html));
      let match;

      // Also check for upload:// short URLs
      const shortUrlRegex = /href="(upload:\/\/[^"]+)"/gi;
      const shortUrls = [];
      while ((match = shortUrlRegex.exec(html)) !== null) {
        shortUrls.push(match[1]);
      }

      if (shortUrls.length > 0) {
        try {
          const lookupResp = await fetch(`${BASE_URL}/uploads/lookup-urls`, {
            method: 'POST',
            headers: { ...this._headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ short_urls: shortUrls }),
          });
          if (lookupResp.ok) {
            const resolved = await lookupResp.json();
            for (const item of resolved) {
              if (item.url && (item.url.endsWith('.funscript') || item.url.endsWith('.zip'))) {
                attachments.push({
                  name: item.url.split('/').pop(),
                  url: item.url.startsWith('http') ? item.url : `${BASE_URL}${item.url}`,
                });
              }
            }
          }
        } catch { /* ignore */ }
      }

      for (const a of attachments) this._noteIssuedUrl(a.url);
      // The post's links off the forum (where the video is: a file host or a
      // tube site), for the EroScripts tab's post view (2026-11-22). Read only;
      // the backend's /api/downloads/classify says what each one is.
      const links = extractExternalLinks(html);
      // Replacement links in the replies, newest first (2026-11-22).
      let posts = data.post_stream?.posts || [];
      if (replies) posts = posts.concat(await this._morePosts(topicId, data));
      const replyLinks = extractReplyLinks(posts, links.map((l) => l.url));
      // Scripts in the replies (a fixed v2, another cut's timing): the
      // window lists them by who posted them (review 2.5).
      const replyScripts = extractReplyAttachments(posts, attachments.map((a) => a.url));
      for (const a of replyScripts) this._noteIssuedUrl(a.url);
      // The post's tags, title and creator come in the same JSON, so a
      // download can record them with no extra request (video options design
      // (c)). `tags` null = the JSON did not say (unknown, never "no tags").
      const meta = parseTopicMeta(data);
      // The post reader (review 2.1): the first post's HTML and the replies,
      // only for the download window (replies: true); the card checks skip it.
      const reader = replies ? {
        post: readerPost(firstPost, MAX_POST_HTML),
        replies: posts.filter((p) => p && Number(p.post_number) > 1)
          .sort((a, b) => Number(a.post_number) - Number(b.post_number))
          .slice(0, MAX_READER_REPLIES)
          .map((p) => readerPost(p, MAX_REPLY_HTML)),
        replyCount: Math.max(0, (Number(data.posts_count) || posts.length) - 1),
      } : {};
      return {
        attachments,
        links,
        replyLinks,
        replyScripts,
        ...reader,
        topicId: meta?.topicId ?? null,
        url: meta?.url ?? null,
        title: meta?.title ?? null,
        creator: meta?.creator ?? null,
        tags: meta ? meta.tags : null,
        // Free (14) or paid (15) scripts: renderer/js/eroscripts-price.js.
        categoryId: data.category_id ?? null,
      };
    } catch (err) {
      log.error('[EroScripts] Topic error:', err.message);
      return { attachments: [], error: err.message, errorCode: 'network' };
    }
  }

  /** The newest posts the topic JSON left out (2 requests of 20 at most). Never throws. */
  async _morePosts(topicId, data) {
    const loaded = new Set((data.post_stream?.posts || []).map((p) => p.id));
    const missing = (data.post_stream?.stream || []).filter((id) => !loaded.has(id)).slice(-40);
    const out = [];
    for (let i = 0; i < missing.length; i += 20) {
      const ids = missing.slice(i, i + 20);
      const qs = ids.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join('&');
      try {
        const resp = await fetch(`${BASE_URL}/t/${encodeURIComponent(topicId)}/posts.json?${qs}`, { headers: this._headers() });
        if (!resp.ok) break;
        const more = await this._safeJson(resp);
        out.push(...(more?.post_stream?.posts || []));
      } catch { break; }
    }
    return out;
  }

  /**
   * A topic's tags, title and creator, for "Get tags from EroScripts" on one
   * video (video options design (c)). One `GET /t/{id}.json`, nothing else:
   * no lookup-urls call, no search, no other topic. Main only fetches and
   * returns; the renderer is the one writer of the tag record.
   *
   * Needs the login (Dave, 2026-11-17, answer 6): logged out, no request is
   * made at all (anonymous requests share one small pool for the whole site).
   *
   * Every answer has `ok` and an `outcome`, one per case the Tags section
   * words differently:
   *   - 'ok'            200 with a topic: `meta` (parseTopicMeta; `tags`
   *                     null when the JSON did not say)
   *   - 'loginRequired' no session: no request made
   *   - 'invalid'       not a topic id: no request made
   *   - 'authExpired'   401 / 403 (`authExpired: true`)
   *   - 'notFound'      404 / 410: the post is gone
   *   - 'rateLimited'   429: `retryAfter` = seconds from the Retry-After
   *                     header, else null (the renderer then waits 60 s)
   *   - 'network'       the request did not complete, or not within 10 s
   *                     (`_topicMetaTimeoutMs`: request and body)
   *   - 'failed'        any other status, or a body that is not a topic
   * `errorCode` (+ `status`) is what eroscripts-error-text.js words; `error`
   * is English, for the log.
   * @param {number|string} topicId
   */
  async getTopicMeta(topicId) {
    const id = _topicIdArg(topicId);
    if (id == null) {
      return { ok: false, outcome: 'invalid', error: 'Not a topic id', errorCode: 'invalid' };
    }
    if (!this._cookie) {
      return { ok: false, outcome: 'loginRequired', error: 'Not logged in to EroScripts', errorCode: 'loginRequired' };
    }
    // The request and its body, within `_topicMetaTimeoutMs` (10 s, as the
    // session check): a timeout is a network error (RB-5).
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this._topicMetaTimeoutMs) : null;
    const timedOut = () => !!controller?.signal.aborted;
    const network = (message) => ({ ok: false, outcome: 'network', error: message, errorCode: 'network' });
    try {
      let resp;
      try {
        resp = await fetch(`${BASE_URL}/t/${id}.json`, {
          headers: this._headers(),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (err) {
        const message = timedOut() ? 'Timed out' : err.message;
        log.warn('[EroScripts] Topic meta error:', message);
        return network(message);
      }
      const status = resp.status;
      _debugLog(`TOPIC META ${id} status=${status}`);
      if (status === 429) {
        const retryAfter = parseRetryAfter(resp.headers?.get?.('retry-after'));
        return { ok: false, outcome: 'rateLimited', status, retryAfter, error: 'Rate limited', errorCode: 'rateLimited' };
      }
      if (status === 401 || status === 403) {
        return {
          ok: false, outcome: 'authExpired', status, authExpired: true,
          error: 'Access denied — try logging in again', errorCode: 'accessDenied',
        };
      }
      if (status === 404 || status === 410) {
        return { ok: false, outcome: 'notFound', status, error: 'Topic not found', errorCode: 'notFound' };
      }
      const data = resp.ok ? await this._safeJson(resp) : null;
      if (timedOut()) {
        log.warn('[EroScripts] Topic meta error: Timed out');
        return network('Timed out');
      }
      const meta = parseTopicMeta(data);
      if (!meta) {
        return { ok: false, outcome: 'failed', status, error: `Failed to load topic (${status})`, errorCode: 'topicFailed' };
      }
      return { ok: true, outcome: 'ok', status, meta };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fetch the first image URL from a topic's first post.
   * Used for lazy thumbnail loading in search results.
   */
  /**
   * Every tag on the forum with its thread count, most used first: the feed
   * window's tag box suggests from it (Dave, 2026-11-22: "not all the tags
   * from eroscripts pop up in the list ... i just created a feed for
   * tentacle"). Logged in (members see tags guests do not). One request,
   * kept for an hour. Tags in tag groups are listed under `extras`.
   */
  async tags() {
    if (!this._cookie) {
      return { tags: [], error: 'Not logged in to EroScripts', errorCode: 'loginRequired', loginRequired: true };
    }
    if (this._tagCache && Date.now() - this._tagCache.at < 60 * 60 * 1000) return { tags: this._tagCache.tags };
    try {
      const resp = await fetch(`${BASE_URL}/tags.json`, { headers: this._headers() });
      if (resp.status === 429) return { tags: [], error: 'Rate limited', errorCode: 'rateLimited' };
      if (resp.status === 401 || resp.status === 403) return { tags: [], error: 'Access denied', errorCode: 'accessDenied', authExpired: true };
      const data = await this._safeJson(resp);
      if (!data) return { tags: [], error: `Tags failed (${resp.status})`, errorCode: 'searchFailed', status: resp.status };
      const tags = forumTagList(data);
      this._tagCache = { at: Date.now(), tags };
      return { tags };
    } catch (err) {
      log.error('[EroScripts] Tags error:', err.message);
      return { tags: [], error: err.message, errorCode: 'network' };
    }
  }

  /**
   * Tags matching what is typed, as the forum's own post editor suggests
   * them (/tags/filter/search.json): every tag a member can use, the
   * members-only script categories' included, which /tags.json leaves out
   * (it counts public threads only: "tentacle" showed 2 there, 2026-11-22).
   * [{name, count}], at most 25. Logged in only.
   */
  async searchTags(query) {
    const q = String(query || '').trim().toLowerCase().slice(0, 60);
    if (!this._cookie) return { tags: [], error: 'Not logged in to EroScripts', errorCode: 'loginRequired', loginRequired: true };
    if (!q) return { tags: [] };
    try {
      const params = new URLSearchParams({ q, limit: '25' });
      const resp = await fetch(`${BASE_URL}/tags/filter/search.json?${params}`, { headers: this._headers() });
      if (resp.status === 429) return { tags: [], error: 'Rate limited', errorCode: 'rateLimited' };
      if (resp.status === 401 || resp.status === 403) return { tags: [], error: 'Access denied', errorCode: 'accessDenied', authExpired: true };
      const data = await this._safeJson(resp);
      if (!data) return { tags: [], error: `Tag search failed (${resp.status})`, errorCode: 'searchFailed', status: resp.status };
      return { tags: forumTagList({ tags: data.results || [] }) };
    } catch (err) {
      log.error('[EroScripts] Tag search error:', err.message);
      return { tags: [], error: err.message, errorCode: 'network' };
    }
  }

  async getTopicImage(topicId) {
    try {
      const resp = await fetch(`${BASE_URL}/t/${topicId}.json`, {
        headers: this._headers(),
      });
      const data = await this._safeJson(resp);
      if (!data) return null;

      const html = data.post_stream?.posts?.[0]?.cooked || '';
      const imgMatch = html.match(/<img[^>]+src="([^"]+\.(jpg|jpeg|png|gif|webp)(\?[^"]*)?)"/i);
      if (imgMatch) {
        let url = imgMatch[1];
        if (!url.startsWith('http')) url = `${BASE_URL}${url}`;
        return url;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * May main fetch this script URL for the renderer? The forum's origin, or
   * an attachment this session read from the forum (as checkDownloadRequest).
   */
  _scriptUrlAllowed(url) {
    if (typeof url !== 'string' || !url || url.length > 4096) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    const testOrigins = globalThis.__funsyncEroscriptsTestOrigins;
    return isEroScriptsUrl(url)
      || (u.protocol === 'https:' && this._issuedUrls.has(url))
      || (Array.isArray(testOrigins) && testOrigins.includes(u.origin));
  }

  /**
   * What a script is like before it is downloaded (the EroScripts review
   * 2.2, 2026-11-23: "I want to know if it's frantic or slow, and how
   * long"): its actions, its recorded length and channels. The bytes stay in
   * the fetch cache, so the download that may follow does not fetch again.
   * @returns {Promise<{ok:true, actions, truncated, metaDuration, channels, bytes}|{error, errorCode?, httpStatus?, refused?}>}
   */
  async previewScript(url) {
    if (!this._scriptUrlAllowed(url)) return { error: 'url not allowed', refused: true };
    try {
      const got = await this._fetchDownload(url);
      if (got.error) return { error: got.error, httpStatus: got.httpStatus };
      let json;
      try { json = JSON.parse(got.buffer.toString('utf8').replace(/^\uFEFF/, '')); } catch { return { error: 'not a funscript', errorCode: 'notScript' }; }
      const all = Array.isArray(json?.actions) ? json.actions : null;
      if (!all) return { error: 'not a funscript', errorCode: 'notScript' };
      const actions = [];
      let truncated = false;
      for (const a of all) {
        if (actions.length >= MAX_PREVIEW_ACTIONS) { truncated = true; break; }
        const at = Number(a?.at);
        const pos = Number(a?.pos);
        if (Number.isFinite(at) && Number.isFinite(pos)) actions.push({ at, pos });
      }
      actions.sort((a, b) => a.at - b.at);
      let channels = [];
      if (json.channels && typeof json.channels === 'object' && !Array.isArray(json.channels)) channels = Object.keys(json.channels);
      else if (Array.isArray(json.axes)) channels = json.axes.map((x) => x?.id).filter((s) => typeof s === 'string');
      const meta = json.metadata && typeof json.metadata === 'object' ? json.metadata : {};
      return {
        ok: true, actions, truncated,
        metaDuration: Number.isFinite(Number(meta.duration)) ? Number(meta.duration) : null,
        channels: channels.slice(0, 12).map((c) => String(c).slice(0, 40)),
        bytes: got.buffer.length,
      };
    } catch (err) {
      return { error: err.message, errorCode: 'network' };
    }
  }

  /**
   * An image in a post, for the post reader (review 2.1): a data: URL (the
   * page's CSP allows data: images). Forum images go with the session (a
   * plain fetch of a secure upload gets a placeholder); another host's only
   * when the user asked for it (`external`: the "Show image" button), never
   * with the cookie. Images only (no SVG), at most MAX_IMAGE_BYTES.
   */
  async fetchImage(url, { external = false } = {}) {
    if (typeof url !== 'string' || !url || url.length > 4096) return { error: 'invalid url' };
    let u;
    try { u = new URL(url); } catch { return { error: 'invalid url' }; }
    if (u.protocol !== 'https:') return { error: 'not https' };
    const forum = isEroScriptsUrl(url);
    if (!forum && !external) return { error: 'not on the forum', notForum: true };
    try {
      // _headers sends the session only to the forum's hosts: never to another's.
      const resp = await fetch(url, { headers: { ...this._headers(url), Accept: 'image/*' } });
      if (!resp.ok) return { error: `Image failed (${resp.status})`, httpStatus: resp.status };
      const type = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES.test(type)) return { error: 'not an image', notImage: true };
      if (Number(resp.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) return { error: 'too big', tooBig: true };
      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) return { error: 'too big', tooBig: true };
      return { ok: true, dataUrl: `data:${type};base64,${buffer.toString('base64')}` };
    } catch (err) {
      return { error: err.message, errorCode: 'network' };
    }
  }

  /**
   * Why the download IPC must refuse `(url, savePath)`, or null when it may
   * run (R3-04: the handler validated nothing, so a renderer could have main
   * fetch any URL with the session cookie and write it to any path).
   *   - url: a string on the EroScripts origin (`isEroScriptsUrl`), or an
   *     attachment URL this session read from the forum. A driver testing in
   *     a sandbox may add origins (e.g. a 127.0.0.1 server) to
   *     `globalThis.__funsyncEroscriptsTestOrigins` in the MAIN process; the
   *     renderer cannot reach that global.
   *   - savePath: a non-empty absolute path ending .funscript or .zip, with no
   *     NUL; on Windows a drive-letter or UNC path (R4-12), checked as
   *     `path.normalize` spells it (R4-11, which is also what `downloadFile`
   *     writes). "Not a directory" is checked by `downloadFile`, which stats
   *     first.
   * @param {{platform?: string}} [opts] test seam (default process.platform)
   * @returns {string|null}
   */
  checkDownloadRequest(url, savePath, { platform = process.platform } = {}) {
    if (typeof url !== 'string' || !url || url.length > 4096) return 'invalid url';
    let u;
    try { u = new URL(url); } catch { return 'invalid url'; }
    const testOrigins = globalThis.__funsyncEroscriptsTestOrigins;
    const allowed = isEroScriptsUrl(url)
      || (u.protocol === 'https:' && this._issuedUrls.has(url))
      || (Array.isArray(testOrigins) && testOrigins.includes(u.origin));
    if (!allowed) return `url not on the EroScripts origin (${u.protocol}//${u.host})`;
    if (typeof savePath !== 'string' || !savePath || savePath.includes('\0')) return 'invalid save path';
    const normalized = normalizeSavePath(savePath, platform);
    if (!isAbsoluteSavePath(normalized, platform)) return 'save path is not absolute';
    if (!DOWNLOAD_EXT_RE.test(normalized)) return 'save path is not a .funscript or .zip file';
    return null;
  }

  /**
   * Let go of the bytes a look fetched for `url` (R4-09): the user answered
   * Cancel, so no write will come for them. Returns whether there were any.
   */
  forgetDownload(url) {
    if (typeof url !== 'string' || !url) return false;
    return this._fetched.delete(url);
  }

  /**
   * Download a file from a URL to `savePath`.
   *
   * An existing, different file there is never replaced without being told
   * to (round 2, also in v0.9.2: a download named `<video>.funscript` beside
   * the video overwrote the user's own script with no question):
   *   - nothing there: written.
   *   - the same bytes already there: nothing written, `unchanged: true`.
   *   - a different file there and `replace` not set: NOTHING written,
   *     `{ success: false, exists: true }`. The panel asks "Replace <name>?"
   *     and calls again with `replace: true`.
   *   - `replace: true`: the old file goes to the Recycle Bin first
   *     (`trashItem`, shell.trashItem from main, as Find duplicates does), so
   *     it can be got back. No trash, or the move fails: nothing written,
   *     `trashFailed: true` (the renderer words it, in the user's language).
   * `checkOnly: true` (R3-03) fetches and looks but never writes or moves:
   * `{ success: true, checked: true }` plus `exists` (a different file is
   * there) or `unchanged` (the same bytes are there). The fetched bytes are
   * kept for the write that follows the user's answers, so a look and its
   * write are one request.
   *
   * The target is stat'ed first (R3-04): only ENOENT counts as "nothing
   * there", anything that is not a regular file (a folder) is an error, and a
   * file of another size is different without being read; only a same-size
   * file is read to compare. The write uses flag 'wx', so a file that
   * appeared since the look is never overwritten (it comes back `exists`).
   *
   * @param {string} url
   * @param {string} savePath
   * @param {{replace?: boolean, checkOnly?: boolean, trashItem?: (path: string) => Promise<void>}} [opts]
   */
  async downloadFile(url, savePath, opts = {}) {
    // The stat, the trash and the write all use the path as the OS spells it
    // (R4-11).
    const result = await this._downloadFile(url, normalizeSavePath(savePath), opts);
    // The kept copy serves the write after a look, and a second write after a
    // late "Replace?" (`exists`); any other ending of a write lets it go.
    if (!opts.checkOnly && !result.exists) this._fetched.delete(url);
    return result;
  }

  async _downloadFile(url, savePath, { replace = false, checkOnly = false, trashItem = null } = {}) {
    const fs = require('fs');
    try {
      const got = await this._fetchDownload(url);
      if (got.error) return { success: false, error: got.error, httpStatus: got.httpStatus };
      const buffer = got.buffer;

      let st = null;
      try {
        st = await fs.promises.stat(savePath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (st && !st.isFile()) {
        return { success: false, error: 'The save path is not a file', notAFile: true };
      }
      let same = false;
      if (st && st.size === buffer.length) {
        same = (await fs.promises.readFile(savePath)).equals(buffer);
      }

      if (checkOnly) {
        if (!st) return { success: true, checked: true };
        return same
          ? { success: true, checked: true, unchanged: true }
          : { success: true, checked: true, exists: true };
      }

      if (st) {
        if (same) {
          log.info(`[EroScripts] Already there, unchanged: ${savePath}`);
          return { success: true, unchanged: true };
        }
        if (!replace) return { success: false, exists: true };
        if (typeof trashItem !== 'function') {
          return { success: false, trashFailed: true, error: 'No Recycle Bin to move the existing file to' };
        }
        try {
          await trashItem(savePath);
        } catch (err) {
          log.warn(`[EroScripts] Could not move the existing file to the Recycle Bin, nothing written: ${err.message}`);
          return { success: false, trashFailed: true, error: err.message };
        }
        log.info(`[EroScripts] Moved the replaced file to the Recycle Bin: ${savePath}`);
      }
      try {
        fs.writeFileSync(savePath, buffer, { flag: 'wx' });
      } catch (err) {
        // Something was put there since the look: never written over.
        if (err.code === 'EEXIST') return { success: false, exists: true };
        throw err;
      }
      log.info(`[EroScripts] Downloaded: ${savePath}`);
      return { success: true };
    } catch (err) {
      log.error('[EroScripts] Download error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // --- Internal ---

  /**
   * Fetch a download's bytes, reusing a copy fetched for the same URL in the
   * last few minutes (a look, then its write; a multi-axis set looks at every
   * file before writing any). `downloadFile` drops the copy once written.
   * @returns {Promise<{buffer?: Buffer, error?: string}>}
   */
  async _fetchDownload(url) {
    const now = Date.now();
    for (const [u, held] of this._fetched) {
      if (now - held.at >= FETCH_KEEP_MS) this._fetched.delete(u);
    }
    const held = this._fetched.get(url);
    if (held) return { buffer: held.buffer };
    const resp = await fetch(url, { headers: this._headers(url) });
    // The status goes back as a number too: the renderer words it in the
    // user's language (R3 fix-up; the English text here is for the log).
    if (!resp.ok) return { error: `Download failed (${resp.status})`, httpStatus: resp.status };
    const buffer = Buffer.from(await resp.arrayBuffer());
    this._fetched.set(url, { buffer, at: now });
    // Oldest out first, by count and by total bytes (R4-09); never this one.
    let bytes = 0;
    for (const held of this._fetched.values()) bytes += held.buffer.length;
    while (this._fetched.size > 1
      && (this._fetched.size > FETCH_KEEP_COUNT || bytes > this._fetchKeepBytes)) {
      const oldest = this._fetched.keys().next().value;
      bytes -= this._fetched.get(oldest).buffer.length;
      this._fetched.delete(oldest);
    }
    return { buffer };
  }

  _noteIssuedUrl(url) {
    if (typeof url !== 'string' || !url) return;
    this._issuedUrls.delete(url);
    this._issuedUrls.add(url);
    while (this._issuedUrls.size > 2000) {
      this._issuedUrls.delete(this._issuedUrls.values().next().value);
    }
  }

  /**
   * Request headers. The session cookies go only to the EroScripts origin
   * (R3-04): a download URL on any other host gets none.
   * @param {string} [forUrl] the URL these headers are for (default: the forum)
   */
  _headers(forUrl = BASE_URL) {
    const h = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
    if (!isEroScriptsUrl(forUrl)) return h;
    // Send all session cookies (includes _t + Cloudflare cf_clearance etc.)
    if (this._sessionCookies) {
      h['Cookie'] = this._sessionCookies;
    } else if (this._cookie) {
      h['Cookie'] = `_t=${this._cookie}`;
    }
    return h;
  }

  async _safeJson(resp) {
    try {
      const text = await resp.text();
      // Guard against HTML responses (DOCTYPE, login redirects, etc.)
      if (text.startsWith('<!') || text.startsWith('<html')) {
        log.warn('[EroScripts] Received HTML instead of JSON');
        _debugLog(`HTML response (${resp.status}): ${text.substring(0, 300)}`);
        return null;
      }
      return JSON.parse(text);
    } catch (err) {
      _debugLog(`JSON parse error: ${err.message}`);
      return null;
    }
  }

}

module.exports = {
  EroScriptsAPI, isEroScriptsUrl, extractExternalLinks, extractReplyLinks, extractReplyAttachments, likeCount, MAX_IMAGE_BYTES, latestTopicsToResults, forumTagList, normalizeSavePath, isAbsoluteSavePath, FETCH_KEEP_BYTES, FETCH_KEEP_COUNT,
  parseTopicMeta, parseRetryAfter, eroscriptsUserAgent, EROSCRIPTS_USER_AGENT: USER_AGENT, MAX_RETRY_AFTER_S,
  classifySessionAnswer, sessionAvatarUrl, SESSION_CHECK_TTL_MS, SESSION_RECHECK_MS, SESSION_CHECK_TIMEOUT_MS,
  TOPIC_META_TIMEOUT_MS, installForumUserAgent, FORUM_REQUEST_FILTER,
};
