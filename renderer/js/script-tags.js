// Remember the EroScripts tags of the post a video's script came from.
//
// EroScripts maintains a genuinely useful taxonomy — device (`the-handy`,
// `osr2`, `sr6`), VR flag (`non-vr`), duration bucket (`len-10-25`) and
// content descriptors — and it arrives free with every search result. This
// records it against the video so it's there when something wants it.
//
// Recording only, no display (Dave, 2026-08-06). The video options dialog's
// Tags section (2026-11-18) shows them and adds "Get tags from EroScripts",
// which refreshes one record from the post (eroscripts-tag-fetch.js).
//
// The record (v2, video options design (c)):
//   { tags: [{id, name}] | string[], topicId, topicUrl, title, creator,
//     scriptPath, match, source: 'eroscripts', savedAt, fetchedAt, stale }
// `scriptPath` is the script the post's tags describe. A record without it
// was made by a download before the field existed (v0.9.0 to v0.9.2), and
// every download saved the post's main script as the video's same-name file
// (`<video>.funscript` beside it): so it describes THAT file, never whatever
// script the video has now (recordScriptPath; fixup-data 2026-11-18, RB-2).
// It shows, and Get tags uses it, only while the video's script is that file.
// Readers take both tag shapes. No migration: old records stay as they are,
// and none is ever deleted or rewritten to add the field.
// `unread: true` (2026-11-18, "Change post…"): the post is linked and its tags
// are not read yet (`tags` is [] until the next Get tags replaces the record).

/** Store key, alongside the other per-video-path maps under `settings.library`. */
export const SCRIPT_TAGS_KEY = 'library.scriptTags';

/** How a record found its post. */
export const TAG_MATCH = Object.freeze({
  DOWNLOAD: 'download',     // the script was downloaded from the post
  TOPIC_URL: 'topic_url',   // the script's own metadata names the post
  SCRIPT_URL: 'script_url', // ...through its script_url
  MANUAL: 'manual',         // you pasted the post's link
  SEARCH: 'search',         // you picked the post in "Find the post"
});
const MATCHES = new Set(Object.values(TAG_MATCH));

// Longer than this, a title or creator is left out (never cut): config.json
// is rewritten whole on every write.
const MAX_RECORD_TEXT = 1000;

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= MAX_RECORD_TEXT ? text : null;
}

// One tag as a record keeps it: a string stays the string it was (records
// from search results), `{id, name}` keeps its id (it survives a staff rename
// of the tag). Anything else is dropped.
function tagItem(tag) {
  if (typeof tag === 'string') return tag.trim() ? tag : null;
  if (!tag || typeof tag !== 'object' || typeof tag.name !== 'string' || !tag.name.trim()) return null;
  return { id: Number.isSafeInteger(tag.id) && tag.id > 0 ? tag.id : null, name: tag.name.trim() };
}

function tagName(item) {
  return typeof item === 'string' ? item : item.name;
}

/**
 * Build the stored record from a search result or a fetched topic.
 *
 * Keeps a little provenance alongside the tags: without the topic id there
 * is no way to link back to the post or re-check it later, and a bare array
 * of strings can't be told apart from tags entered by some other means.
 *
 * @param {{id?: number, tags?: Array<string|{id?: number, name: string}>,
 *   url?: string, title?: string, creator?: string}} topic
 * @param {number} now epoch ms — passed in so callers and tests stay
 *   deterministic
 * @param {{scriptPath?: string, match?: string, fetchedAt?: number}} [extra]
 *   the script the tags describe, how the post was found (default
 *   'download', the only writer before Get tags) and when its JSON was read
 * @returns {object|null} the record (v2, above)
 */
export function makeScriptTagRecord(topic, now, extra = {}) {
  // No topic id means this didn't come from an EroScripts post, so there is
  // nothing meaningful to attribute. An EMPTY tag list is still recorded —
  // "this post has no tags" is a real answer, and distinguishing it from
  // "never downloaded from EroScripts" matters.
  if (!topic || topic.id == null) return null;

  // Tags that aren't a list are UNKNOWN (the search response didn't carry
  // them; eroscripts-api.js reports that as null). Unknown records nothing,
  // so it can never be stored as "no tags" nor overwrite a good record
  // (FT-066). Existing [] records are left as they are.
  if (!Array.isArray(topic.tags)) return null;

  const seen = new Set();
  const tags = [];
  for (const raw of topic.tags) {
    const item = tagItem(raw);
    if (!item || seen.has(tagName(item))) continue;
    seen.add(tagName(item));
    tags.push(item);
  }

  const opts = extra || {};
  return {
    tags,
    topicId: topic.id,
    topicUrl: topic.url || null,
    title: textOrNull(topic.title),
    creator: textOrNull(topic.creator),
    scriptPath: textOrNull(opts.scriptPath),
    match: MATCHES.has(opts.match) ? opts.match : TAG_MATCH.DOWNLOAD,
    source: 'eroscripts',
    savedAt: now,
    fetchedAt: Number.isFinite(opts.fetchedAt) ? opts.fetchedAt : null,
    stale: false,
    // The VIDEO came from this post too (the EroScripts tab's downloads, not
    // a script-only Get Script): its tags stay the video's when it has no
    // script (video-options-model.js eroscriptsRecordState; Dave, 2026-11-25).
    ...(opts.videoFromPost === true ? { videoFromPost: true } : {}),
  };
}

/**
 * Write the record for a video path.
 *
 * Last write wins rather than merging: the record describes the post the
 * video's CURRENT script came from, and union-ing tags from two different
 * posts would invent a set that describes neither.
 *
 * @param {{get: Function, set: Function}} settings
 * @param {string} videoPath
 * @param {object} topic
 * @param {number} [now]
 * @param {{scriptPath?: string, match?: string, fetchedAt?: number}} [extra]
 *   see makeScriptTagRecord
 * @returns {boolean} whether anything was written
 */
export function recordScriptTags(settings, videoPath, topic, now = Date.now(), extra = {}) {
  if (!settings?.get || !settings?.set || !videoPath) return false;
  const opts = { ...(extra || {}) };
  // A download names the script it saved. Not told, it is the video's
  // same-name file, the one every download saves (sameNameScriptPath): never
  // a record with no script, which older builds left (RB-2).
  if (!textOrNull(opts.scriptPath) && (opts.match == null || opts.match === TAG_MATCH.DOWNLOAD)) {
    opts.scriptPath = sameNameScriptPath(videoPath);
  }
  const record = makeScriptTagRecord(topic, now, opts);
  if (!record) return false;

  const map = { ...(settings.get(SCRIPT_TAGS_KEY) || {}) };
  map[videoPath] = record;
  settings.set(SCRIPT_TAGS_KEY, map);
  return true;
}

/**
 * What getTopicAttachments' answer says about the post itself (not its
 * attachments): `{topicId, url, title, creator, tags}`, `tags` null when the
 * JSON did not say. Null for an answer that is not an object.
 * @param {unknown} answer
 */
export function topicMetaOf(answer) {
  if (!answer || typeof answer !== 'object') return null;
  return {
    topicId: Number.isSafeInteger(answer.topicId) ? answer.topicId : null,
    url: typeof answer.url === 'string' ? answer.url : null,
    title: typeof answer.title === 'string' ? answer.title : null,
    creator: typeof answer.creator === 'string' ? answer.creator : null,
    tags: Array.isArray(answer.tags) ? answer.tags : null,
  };
}

/**
 * What a download saves its post's tags from (fixup-data 2026-11-18, RB-2):
 * the topic JSON it read for the attachments (`answer`, getTopicAttachments:
 * the post's own tags with their ids, title and creator) over the search
 * result (`topic`), and the script it saved and paired (`scriptPath`; for a
 * multi-axis set, the main script). Both download paths call this: the
 * EroScripts panel's Get Script and the Associate dialog's search
 * (library.js). Tags the JSON did not list fall back to the search's.
 *
 * @param {{get: Function, set: Function}} settings
 * @param {string} videoPath
 * @param {{topic: {id: number, title?: string, url?: string, creator?: string, tags?: Array},
 *   answer?: {topicId?: number|null, url?: string|null, title?: string|null,
 *   creator?: string|null, tags?: Array|null}|null, scriptPath?: string|null,
 *   now?: number}} download
 * @returns {boolean} whether anything was written
 */
export function recordDownloadTags(settings, videoPath, { topic, answer = null, scriptPath = null, now, video = false } = {}) {
  if (!topic || topic.id == null) return false;
  // The answer is about the post downloaded from; another id is not used.
  const same = answer && typeof answer === 'object'
    && (answer.topicId == null || Number(answer.topicId) === Number(topic.id));
  const read = same && Array.isArray(answer.tags);
  const when = Number.isFinite(now) ? now : Date.now();
  const merged = {
    id: topic.id,
    url: (same && answer.url) || topic.url,
    title: (same && textOrNull(answer.title)) || topic.title,
    creator: (same && textOrNull(answer.creator)) || topic.creator,
    tags: read ? answer.tags : topic.tags,
  };
  return recordScriptTags(settings, videoPath, merged, when, {
    scriptPath: textOrNull(scriptPath) || undefined,
    match: TAG_MATCH.DOWNLOAD,
    fetchedAt: read ? when : undefined,
    videoFromPost: video === true,
  });
}

/**
 * Downloads made before the mark (Dave, 2026-11-25): the tab's own list of
 * what it saved per post (`eroscripts.downloaded`: topic id -> {video}) says
 * which videos came from a post. Their records get `videoFromPost` when they
 * name that post. Adds the mark only, never removes or rewrites anything.
 * @returns {number} how many records were marked
 */
export function markVideosFromPosts(settings, downloaded) {
  if (!settings?.get || !settings?.set || !downloaded || typeof downloaded !== 'object') return 0;
  const map = settings.get(SCRIPT_TAGS_KEY);
  if (!map || typeof map !== 'object') return 0;
  let changed = 0;
  const next = { ...map };
  for (const [topicId, entry] of Object.entries(downloaded)) {
    const video = entry && typeof entry.video === 'string' ? entry.video : '';
    const rec = video ? next[video] : null;
    if (!rec || typeof rec !== 'object' || rec.videoFromPost === true) continue;
    if (rec.match !== TAG_MATCH.DOWNLOAD || Number(rec.topicId) !== Number(topicId)) continue;
    next[video] = { ...rec, videoFromPost: true };
    changed += 1;
  }
  if (changed) settings.set(SCRIPT_TAGS_KEY, next);
  return changed;
}

/**
 * Read the record for a video path, or null.
 *
 * @param {{get: Function}} settings
 * @param {string} videoPath
 */
export function getScriptTags(settings, videoPath) {
  if (!settings?.get || !videoPath) return null;
  return (settings.get(SCRIPT_TAGS_KEY) || {})[videoPath] || null;
}

/**
 * The names of a record's tags, whichever shape they are stored in (the old
 * `string[]` or `{id, name}`). No record, or no list: [].
 * @param {object|null} record
 * @returns {string[]}
 */
export function scriptTagNames(record) {
  if (!record || !Array.isArray(record.tags)) return [];
  return record.tags.map((item) => {
    const one = tagItem(item);
    return one ? tagName(one) : null;
  }).filter(Boolean);
}

/**
 * Two script paths name the same file: the comparison video-tags.js uses for
 * a record's `scriptPath`, so what Get tags offers and what the Tags section
 * shows always agree (slashes either way, no trailing slash, any case).
 */
export function sameScriptPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const canon = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return canon(a) === canon(b);
}

/**
 * The video's same-name script: `<folder>/<video name without its
 * extension>.funscript`, the file every EroScripts download saves the main
 * script as (the panel's Get Script with a video open; the Associate
 * search's `targetFileName`), in every build that wrote a record.
 * @param {unknown} videoPath
 * @returns {string|null}
 */
export function sameNameScriptPath(videoPath) {
  if (typeof videoPath !== 'string' || !videoPath.trim()) return null;
  const cut = videoPath.search(/[\\/][^\\/]*$/);
  const dir = cut >= 0 ? videoPath.slice(0, cut + 1) : '';
  const name = videoPath.slice(dir.length);
  const stem = name.replace(/\.[^.]+$/, '');
  return stem ? `${dir}${stem}.funscript` : null;
}

/**
 * The script a record's tags describe: its `scriptPath`; for a record without
 * one (a download before the field), the video's same-name script, which is
 * what that download saved. Null when that cannot be told (no video path).
 * @param {object|null} record
 * @param {string|null} [videoPath] the video the record is filed under
 * @returns {string|null}
 */
export function recordScriptPath(record, videoPath) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.scriptPath === 'string' && record.scriptPath) return record.scriptPath;
  return sameNameScriptPath(videoPath);
}

/**
 * The record as the readers should see it: one without `scriptPath` (older
 * builds) gets the script it describes (recordScriptPath), as a COPY. The
 * stored record is never rewritten. Anything else is returned as it is.
 * @param {object|null} record
 * @param {string|null} videoPath
 */
export function recordWithScriptPath(record, videoPath) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record ?? null;
  if (typeof record.scriptPath === 'string' && record.scriptPath) return record;
  const scriptPath = sameNameScriptPath(videoPath);
  return scriptPath ? { ...record, scriptPath } : record;
}

/**
 * Does this record describe the video's script `scriptPath`? Only when the
 * script it describes (recordScriptPath) is that file. A record naming
 * ANOTHER script does not: you changed the script after the download, and
 * refreshing it would stamp that post's tags on this script. A record with
 * no `scriptPath` (older builds) describes the video's same-name script, so
 * it counts only while the video uses that file; without the video's path
 * that cannot be proved, and it does not count (RB-2).
 * @param {object|null} record
 * @param {string|null} scriptPath the video's script now
 * @param {string|null} [videoPath] the video the record is filed under
 */
export function recordIsForScript(record, scriptPath, videoPath = null) {
  if (!record || typeof record !== 'object') return false;
  return sameScriptPath(recordScriptPath(record, videoPath), scriptPath);
}

/**
 * The record exactly as stored, as text: what Get tags compares when its
 * answer lands (RB-1). Absent is its own value.
 * @param {{get: Function}} settings
 * @param {string} videoPath
 * @returns {string}
 */
export function scriptTagsFingerprint(settings, videoPath) {
  if (!settings?.get || !videoPath) return 'none';
  const stored = settings.get(SCRIPT_TAGS_KEY);
  if (!plainObjectOrAbsent(stored)) return 'damaged';
  if (!stored || !Object.prototype.hasOwnProperty.call(stored, videoPath)) return 'none';
  try { return `record:${JSON.stringify(stored[videoPath])}`; } catch { return 'damaged'; }
}

/**
 * Store what a successful "Get tags from EroScripts" read: the video's record
 * is REPLACED by one built from the topic (`meta` from parseTopicMeta).
 *
 * Only this one record is written. `userTags`, `hiddenTags` and every other
 * video's record are never touched, so your own tags and your hides survive
 * every refresh. Tags the JSON did not list (`meta.tags` not a list) are
 * unknown: nothing is written. An empty list is a real "no tags" and is
 * stored.
 *
 * @param {{get: Function, set: Function}} settings
 * @param {string} videoPath
 * @param {{topicId: number, url?: string, title?: string, creator?: string,
 *   tags: Array|null}} meta
 * @param {{scriptPath?: string, match?: string, now?: number}} [opts]
 * @returns {{written: boolean, record: object|null, count: number, newCount: number}}
 */
export function applyTopicMeta(settings, videoPath, meta, opts = {}) {
  const none = { written: false, record: null, count: 0, newCount: 0 };
  if (!settings?.get || !settings?.set || !videoPath || !meta) return none;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const topic = { id: meta.topicId, url: meta.url, title: meta.title, creator: meta.creator, tags: meta.tags };
  const record = makeScriptTagRecord(topic, now, { scriptPath: opts.scriptPath, match: opts.match, fetchedAt: now });
  if (!record) return none;

  // Read again right before the write: another video's record may have
  // been written while the request ran.
  const map = { ...(settings.get(SCRIPT_TAGS_KEY) || {}) };
  const fold = (name) => name.trim().toLowerCase();
  const before = new Set(scriptTagNames(map[videoPath]).map(fold));
  const names = scriptTagNames(record);
  map[videoPath] = record;
  settings.set(SCRIPT_TAGS_KEY, map);
  return {
    written: true,
    record,
    count: names.length,
    newCount: names.filter((name) => !before.has(fold(name))).length,
  };
}

function plainObjectOrAbsent(value) {
  return value == null || (typeof value === 'object' && !Array.isArray(value));
}

function copyOf(value) {
  try { return typeof structuredClone === 'function' ? structuredClone(value) : value; } catch { return value; }
}

/**
 * "Change post…" (Dave, 2026-11-18): link the video's script to a different
 * post. The video's record is REPLACED by one that names the new post and has
 * no tags yet (`tags: []`, `unread: true`, `fetchedAt: null`): the old post's
 * tags stop showing at once, wherever the record is read, and nothing is
 * fetched. The next Get tags reads the new post and replaces this record
 * (applyTopicMeta). Only this one record is written: `userTags`, `hiddenTags`
 * and every other video's record are never touched. A damaged map (not an
 * object) is never rewritten.
 *
 * @param {{get: Function, set: Function}} settings
 * @param {string} videoPath
 * @param {{topicId: number, url?: string|null, title?: string|null, creator?: string|null}} topic
 * @param {{scriptPath?: string, match?: string, now?: number}} [opts]
 * @returns {{written: boolean, reason?: 'bad-store'|'no-path'|'invalid', record: object|null,
 *   before: object|undefined, hadBefore: boolean, topicId: number|null}}
 *   `before` is a copy of the EXACT old record (`hadBefore` false: there was
 *   none), for undoLinkScriptPost.
 */
export function linkScriptPost(settings, videoPath, topic, opts = {}) {
  const none = (reason) => ({ written: false, reason, record: null, before: undefined, hadBefore: false, topicId: null });
  if (!settings?.get || !settings?.set || !videoPath) return none('no-path');
  const topicId = topic?.topicId;
  if (!Number.isSafeInteger(topicId) || topicId <= 0) return none('invalid');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const record = makeScriptTagRecord(
    { id: topicId, url: topic.url, title: topic.title, creator: topic.creator, tags: [] },
    now, { scriptPath: opts.scriptPath, match: opts.match },
  );
  if (!record) return none('invalid');
  record.unread = true;

  const stored = settings.get(SCRIPT_TAGS_KEY);
  if (!plainObjectOrAbsent(stored)) return none('bad-store');
  const map = { ...(stored || {}) };
  const hadBefore = Object.prototype.hasOwnProperty.call(map, videoPath);
  const before = hadBefore ? copyOf(map[videoPath]) : undefined;
  map[videoPath] = record;
  settings.set(SCRIPT_TAGS_KEY, map);
  return { written: true, record, before, hadBefore, topicId };
}

/**
 * Undo of "Change post…": put the video's EXACT old record back (none, when
 * it had none), while the record is still about the post the change linked
 * (the linked record, or a Get tags of that same post since). A record about
 * yet another post since is kept and nothing is written. Every other
 * video's record is left as it is now.
 *
 * @param {{get: Function, set: Function}} settings
 * @param {string} videoPath
 * @param {{before: object|undefined, hadBefore: boolean, topicId: number}} change linkScriptPost's answer
 * @returns {{restored: boolean, reason?: 'changedSince'|'bad-store'|'no-path'}}
 */
export function undoLinkScriptPost(settings, videoPath, change) {
  if (!settings?.get || !settings?.set || !videoPath || !change?.written) return { restored: false, reason: 'no-path' };
  const stored = settings.get(SCRIPT_TAGS_KEY);
  if (!plainObjectOrAbsent(stored)) return { restored: false, reason: 'bad-store' };
  const map = { ...(stored || {}) };
  const now = map[videoPath];
  if (!now || typeof now !== 'object' || Number(now.topicId) !== Number(change.topicId)) {
    return { restored: false, reason: 'changedSince' };
  }
  if (change.hadBefore) map[videoPath] = copyOf(change.before);
  else delete map[videoPath];
  settings.set(SCRIPT_TAGS_KEY, map);
  return { restored: true };
}

/**
 * The post is gone from EroScripts (404): mark the video's record `stale`
 * and keep its tags (they still describe the script). Only a record for
 * that same topic is marked; no record, another topic or already stale:
 * nothing is written.
 * @param {{get: Function, set: Function}} settings
 * @param {string} videoPath
 * @param {number} topicId the topic that answered 404
 * @returns {boolean} whether anything was written
 */
export function markScriptTagsStale(settings, videoPath, topicId) {
  if (!settings?.get || !settings?.set || !videoPath || topicId == null) return false;
  const map = settings.get(SCRIPT_TAGS_KEY) || {};
  const record = map[videoPath];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (Number(record.topicId) !== Number(topicId) || record.stale === true) return false;
  settings.set(SCRIPT_TAGS_KEY, { ...map, [videoPath]: { ...record, stale: true } });
  return true;
}
