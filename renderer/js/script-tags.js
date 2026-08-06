// Remember the EroScripts tags of the post a video's script came from.
//
// EroScripts maintains a genuinely useful taxonomy — device (`the-handy`,
// `osr2`, `sr6`), VR flag (`non-vr`), duration bucket (`len-10-25`) and
// content descriptors — and it arrives free with every search result. This
// records it against the video so it's there when something wants it.
//
// Recording only, no display (Dave, 2026-08-06).

/** Store key, alongside the other per-video-path maps under `settings.library`. */
export const SCRIPT_TAGS_KEY = 'library.scriptTags';

/**
 * Build the stored record from a search result.
 *
 * Keeps a little provenance alongside the tags: without the topic id there
 * is no way to link back to the post or re-check it later, and a bare array
 * of strings can't be told apart from tags entered by some other means.
 *
 * @param {{id?: number, tags?: string[], url?: string, title?: string}} topic
 * @param {number} now epoch ms — passed in so callers and tests stay
 *   deterministic
 * @returns {{tags: string[], topicId: number|null, topicUrl: string|null,
 *   source: string, savedAt: number}|null}
 */
export function makeScriptTagRecord(topic, now) {
  // No topic id means this didn't come from an EroScripts post, so there is
  // nothing meaningful to attribute. An EMPTY tag list is still recorded —
  // "this post has no tags" is a real answer, and distinguishing it from
  // "never downloaded from EroScripts" matters.
  if (!topic || topic.id == null) return null;

  const tags = Array.isArray(topic.tags)
    ? [...new Set(topic.tags.filter((tag) => typeof tag === 'string' && tag.trim()))]
    : [];

  return {
    tags,
    topicId: topic.id,
    topicUrl: topic.url || null,
    source: 'eroscripts',
    savedAt: now,
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
 * @returns {boolean} whether anything was written
 */
export function recordScriptTags(settings, videoPath, topic, now = Date.now()) {
  if (!settings?.get || !settings?.set || !videoPath) return false;
  const record = makeScriptTagRecord(topic, now);
  if (!record) return false;

  const map = { ...(settings.get(SCRIPT_TAGS_KEY) || {}) };
  map[videoPath] = record;
  settings.set(SCRIPT_TAGS_KEY, map);
  return true;
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
