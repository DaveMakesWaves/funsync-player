// The phone's tag slice (P1 tags, Round 3, 2026-11-18).
//
// DESIGN-video-options.md (e) "The phone's filter slice" and PLAN §2.6: the
// desktop merges every tag source ONCE (video-tags.js effectiveTags, the
// tags you hid already removed) and sends the phone each video's result as
// `videoTags` in /api/media/register (backend routes/media.py register_tags).
// The phone keeps no merge logic: it filters those keys with its copy of the
// desktop filter (backend/web-remote/tag-filter.js, pinned to the desktop's
// by tests/fixtures/tag-filter-parity.json) and translates the facet names
// itself, from the shared locale bundles.
//
// The merge is the library's own (library-tag-filter.js
// buildLibraryTagIndex, the index the desktop's Tags filter reads), so the
// phone and the desktop filter the same tags: the dialog's per-video
// EroScripts rule (a record about another script, or naming one on a video
// left with none after Unpair, does not count; one without `scriptPath` is
// about the video's same-name script, RB-2), the funscript harvest
// (script-meta-store.js scriptMetaMap) by the script's path.
//
// r3-fixup (2026-11-18, R3R-6): the app builds the slice from the library's
// memoised index (remoteTagSliceFromIndex over Library._tagIndexMemo().get()),
// not from a second merge, and sends it only when its text changed. The
// index already applies the backend's per-video cap and key limits with the
// names kept first (R3R-2), so what the phone filters is what the desktop
// filters.
//
// Stash's tag aliases and sub-tags (sn-tags, 2026-11-19; the opt-in "Use
// Stash's tag aliases and sub-tags", `stash.useTagRules`): the aliases are
// already in the index's keys and labels. Sub-tags ride in the slice as
// each video's IMPLIED parents (library-tag-filter.js impliedTags), after
// its own tags: the phone's unchanged filter then finds a video by any
// parent of its tags, exactly as the desktop's filter does, and the
// backend's counts for a parent are the desktop picker's. Off: none.
//
// Pure: no DOM, no fetch, no module state. Nothing is written.

import { buildLibraryTagIndex, impliedTags } from './library-tag-filter.js';

/** The settings whose change changes some video's merged tags. */
export const REMOTE_TAG_SETTING_PATHS = Object.freeze([
  'library.userTags',
  'library.hiddenTags',
  'library.scriptTags',
  'library.tagSettings',
  // A pairing picks the script whose metadata and post count.
  'library.associations',
  // Stash S1: turning the Stash link on or off adds or removes its tags.
  // (The Stash data itself is not a setting: stash-store.js onStashChanged
  // re-sends the slice, app.js _wireStash.)
  'stash.enabled',
  // sn-tags: Stash's tag aliases and sub-tags on or off.
  'stash.useTagRules',
]);

/**
 * Each video's merged tags as the phone needs them: `{videoPath: [{key,
 * facet, label}]}`. A video with no tag is left out.
 *
 * @param {{path: string, funscriptPath?: string|null}[]} videos the library list
 * @param {{userTags?: object, hiddenTags?: object, scriptTags?: object,
 *   tagSettings?: object, scriptMeta?: object, stash?: object,
 *   nameIds?: Map<string, string>, stashRules?: object}} [stores] `stash` /
 *   `nameIds`: stash-tags.js stashTagRecords / nameIdentities (Stash S1;
 *   absent: no Stash tags); `stashRules`: stashTagRuleSet (sn-tags; absent:
 *   no Stash aliases, no sub-tags)
 * @returns {Object<string, {key: string, facet: string, label: string}[]>}
 */
export function buildRemoteTagSlice(videos, stores = {}) {
  const { index } = buildLibraryTagIndex({
    videos: Array.isArray(videos) ? videos : [],
    userTags: stores?.userTags,
    hiddenTags: stores?.hiddenTags,
    scriptTags: stores?.scriptTags,
    tagSettings: stores?.tagSettings,
    scriptMeta: stores?.scriptMeta,
    stash: stores?.stash,
    nameIds: stores?.nameIds,
    stashRules: stores?.stashRules,
  });
  return remoteTagSliceFromIndex(index);
}

/**
 * The slice from an index the library already built (LibraryTagIndex.get()
 * .index): no merge, a copy of each tag's key, facet and label, then the
 * video's implied parents (sub-tags on; none for an index without them).
 *
 * @param {Map<string, Array<{key: string, facet: string, label: string}>>} index
 * @returns {Object<string, {key: string, facet: string, label: string}[]>}
 */
export function remoteTagSliceFromIndex(index) {
  const out = {};
  if (!(index instanceof Map)) return out;
  const implied = impliedTags(index);
  for (const [path, tags] of index) {
    if (!Array.isArray(tags) || !tags.length) continue;
    const extra = implied.get(path);
    out[path] = (extra ? [...tags, ...extra] : tags).map((tag) => ({ key: tag.key, facet: tag.facet, label: tag.label }));
  }
  return out;
}
