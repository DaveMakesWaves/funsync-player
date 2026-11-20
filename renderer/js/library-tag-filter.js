// The library's Tags filter and its ONE tag index (P1 wiring, Round 3,
// 2026-11-18; notes/features/DESIGN-video-options.md (e), PLAN-next-major-
// 2026-11.md §2.2 "Filtering").
//
// - LibraryTagIndex: path -> effective tags (video-tags.js effectiveTags) for
//   every library video that has any tag record, memoised per settings
//   version (the four stored maps, by identity, plus a counter the library
//   bumps on their settings:changed), per script-meta version (the funscript
//   files' own metadata, script-meta-store.js) and per library scan (the
//   video list, by identity, plus the scan counter). The pairing each video
//   has now (`funscriptPath`, which picks the funscript record and decides
//   whether an EroScripts record counts) is checked too, so a pair or an
//   Unpair re-indexes without a scan. The filter, its counts, the cards'
//   tag line, the dialog's suggestions and "Make a category" all read it.
// - applyTagFilter: the filter itself. Tags go through filterByTags in its
//   `facets` mode (OR within a facet, AND across facets; exclude kept
//   reachable in code). Category (FunSync's own categories, from their own
//   store) and Source (EroScripts / the script file / you) are two more
//   facets: OR inside each, AND with the rest. It runs BEFORE dedupeByName
//   (library.js runFilters): tags are stored per path, so a copy dedupe would
//   drop may be the one holding them.
//
// Rules kept here: pure reads, nothing is written; absence is "unknown",
// never "no tags" (a missing map is empty, a video with no record matches no
// include); search never matches tags (Dave's answer 4: nothing here feeds
// the search); the filter state is session-only (Dave's answer 5: the caller
// never stores it).
//
// r3-fixup (2026-11-18):
// - One cap on both sides (R3R-2): the index keeps at most
//   MAX_TAGS_PER_VIDEO tags per video (the names kept first), and leaves out
//   a key longer than MAX_TAG_KEY, exactly as the backend's register_tags
//   does to the slice the phone filters (backend/routes/media.py, the same
//   constants, pinned by tests/unit/tag-slice-parity.test.js). The phone's
//   slice IS this index, so both filter the same tags.
// - One label per tag key across the library (verify cosmetics): the label of
//   the highest-precedence source that gave it (yours, then the file, then
//   the forum), in its display form (video-tags.js tagDisplayLabel), so the
//   picker, the chips, the cards and the dialog show one form.
// - A filter pass reads each video's keys parsed ONCE per index build
//   (R3R-6: they were folded and slugged again on every pass, ~57 ms per
//   keystroke on 6,000 videos).
//
// Stash S1 (Round 1 stage 1d, 2026-11-18; DESIGN-stash-s1.md (c), (f)):
// - The `stash` source: LibraryTagIndex reads the Stash data (deps
//   `stashData` and `stashVersion`, renderer/js/stash-store.js) and the
//   setting `stash.enabled`, projects it with stash-tags.js stashTagRecords
//   (the trust check against each video's scanned size) and nameIdentities
//   (the bare-name join), once per data version, setting and library list.
//   Off, or never set up: no `stash` source, no join: the index as before.
// - "Tags from: Stash" in SOURCE_FACET; its count is the videos that SHOW a
//   Stash tag (the picker lists a source only with a count above 0).
// - Two keys of one name facet with the same label (two people called Jane
//   Doe, kept apart by Stash ID) get Stash's disambiguation, "Jane Doe
//   (blonde)", or else the last 4 characters of the identity, "Jane Doe ·
//   3f2a", in the one-label pass, so the chips, filter, cards and phone agree.
//
// Stash's tag aliases and sub-tags (Stash "next" lot, sn-tags, 2026-11-19;
// DESIGN-stash-s1.md (j) row 5; Dave: an opt-in, "Use Stash's tag aliases
// and sub-tags", `stash.useTagRules`, off by default):
// - While it is on (and Stash is), LibraryTagIndex reads main's `tagRules`
//   (stash-tags.js stashTagRuleSet) and compiles the tag rules with Stash's
//   aliases as their own layer (video-tags.js compileTagRules), so the
//   index, the chips (the result's `rules`), the cards and the phone show one
//   name per Stash tag. Off: exactly the index as before.
// - Sub-tags: picking a parent tag also finds the videos with any of its
//   sub-tags, all levels down, cycle-safe. Each video's IMPLIED parents (the
//   ancestors of its tags it does not have itself) are kept beside the index
//   (impliedTags), never in it: the cards and the chips show only a video's
//   own tags. The filter (applyTagFilter, through keySetsFor) and the
//   phone's slice (remote-tag-slice.js) both read them, so the phone's
//   unchanged filter finds what the desktop's finds. A parent's count is the
//   videos that have it or one of its sub-tags (what picking it shows, here
//   and on the phone); its row says how many sub-tags it has (`subTags`,
//   subTagNoteText). A tag you hid on every video is never a parent here.
// - Cost (sn-fixup, 2026-11-19, SN-R5): the same Stash rules keep the same
//   rule-set object across Stash data changes that did not change them
//   (tagRuleSetStamp, else sameTagRuleSet), so the compiled rules and the
//   sub-tag graph (one per compiled rules, graphFor) are reused; an index
//   rebuild then walks only its videos. Each implied parent is one shared
//   frozen tag object per key.

import {
  FACETS, NAME_FACETS, SOURCE_ORDER, compileTagRules, tagIndex, filterByTags, foldForMatch,
  isWellFormedText, tagDisplayLabel, tagKeySet, classifyTag, parseTagKey, deslug,
} from './video-tags.js';
import { recordWithScriptPath } from './script-tags.js';
import { eroscriptsRecordForTags } from './video-options-model.js';
import {
  stashTagRecords, nameIdentities, stashTagRuleSet, tagRuleSetStamp, sameTagRuleSet,
} from './stash-tags.js';

/** The Stash link's on/off setting (DataService path of settings.stash.enabled). */
export const STASH_ENABLED_KEY = 'stash.enabled';

/** "Use Stash's tag aliases and sub-tags" (settings.stash.useTagRules; off by default). */
export const STASH_TAG_RULES_KEY = 'stash.useTagRules';

/** The stored settings the index reads (DataService paths). */
export const TAG_DATA_KEYS = Object.freeze([
  'library.userTags', 'library.hiddenTags', 'library.scriptTags', 'library.tagSettings', STASH_ENABLED_KEY,
  STASH_TAG_RULES_KEY,
]);

/** The Source facet, in its display order: EroScripts, Stash, the script file, you. */
export const SOURCE_FACET = Object.freeze(['eroscripts', 'stash', 'funscript', 'user']);

/** The tag facets in the filter, in display order (the engine's). */
export const TAG_FILTER_FACETS = FACETS;

/**
 * The per-video limits, the same as the backend's (routes/media.py
 * MAX_TAGS_PER_VIDEO, MAX_TAG_KEY, MAX_TAG_LABEL). Far above what real
 * sources give (a funscript alone gives at most 601); they are junk guards
 * that both sides apply alike.
 */
export const MAX_TAGS_PER_VIDEO = 1000;
export const MAX_TAG_KEY = 512;
export const MAX_TAG_LABEL = 512;

const NAME_FACET_SET = new Set(NAME_FACETS);
const SOURCE_RANK = new Map(SOURCE_ORDER.map((s, i) => [s, i]));

/**
 * At most MAX_TAGS_PER_VIDEO tags: the names (performer, creator, studio)
 * first, then the rest in the order given (facet order); the kept ones stay
 * in the order given. The backend's cap_video_tags is the same rule.
 *
 * @param {Array<{facet: string}>} tags
 * @returns {Array}
 */
export function capVideoTags(tags) {
  if (!Array.isArray(tags) || tags.length <= MAX_TAGS_PER_VIDEO) return tags;
  const names = [];
  const others = [];
  tags.forEach((tag, i) => (NAME_FACET_SET.has(tag?.facet) ? names : others).push(i));
  const keep = new Set(names.slice(0, MAX_TAGS_PER_VIDEO));
  for (const i of others.slice(0, MAX_TAGS_PER_VIDEO - keep.size)) keep.add(i);
  return tags.filter((_, i) => keep.has(i));
}

// A tag the backend would keep as it is: a well-formed key no longer than
// MAX_TAG_KEY (else left out, as _clean_tag does); a label that is not
// usable falls back to the key's value, as _clean_tag's does.
function sendableTag(tag) {
  const key = tag?.key;
  if (typeof key !== 'string' || !key.trim() || key.length > MAX_TAG_KEY || !isWellFormedText(key)) return null;
  const label = tag.label;
  if (typeof label !== 'string' || !label.trim() || label.length > MAX_TAG_LABEL || !isWellFormedText(label)) {
    tag.label = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  }
  return tag;
}

/** A filter that filters nothing. Session-only: never stored. */
export function emptyTagFilter() {
  return { include: [], exclude: [], categories: [], sources: [] };
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map);
}

/** Does this filter narrow anything? */
export function tagFilterActive(state) {
  if (!state || typeof state !== 'object') return false;
  return list(state.include).length > 0 || list(state.exclude).length > 0
    || list(state.categories).length > 0 || list(state.sources).length > 0;
}

/**
 * Keep the videos the Tags filter lets through. Order is kept; the same
 * objects come back in a new array.
 *
 * @param {Array<{path: string}>} videos
 * @param {{include?: string[], exclude?: string[], categories?: string[], sources?: string[]}} state
 * @param {{index?: Map<string, Array>, categoriesOf?: (path: string) => string[]}} ctx
 *   `index` from LibraryTagIndex (path -> effective tags); `categoriesOf` the
 *   video's category ids (DataService.getVideoCategories)
 * @returns {Array}
 */
export function applyTagFilter(videos, state, { index, categoriesOf } = {}) {
  if (!Array.isArray(videos)) return [];
  if (!tagFilterActive(state)) return videos.slice();
  const tags = index instanceof Map ? index : new Map();
  let out = filterByTags(videos, { include: list(state.include), exclude: list(state.exclude), mode: 'facets' }, keySetsFor(tags));
  const categories = new Set(list(state.categories));
  if (categories.size > 0) {
    const read = typeof categoriesOf === 'function' ? categoriesOf : () => [];
    out = out.filter((v) => {
      let ids;
      try { ids = read(v.path); } catch { ids = []; }
      return list(ids).some((id) => categories.has(id));
    });
  }
  const sources = new Set(list(state.sources));
  if (sources.size > 0) {
    out = out.filter((v) => list(tags.get(v.path)).some((tag) => list(tag.sources).some((s) => sources.has(s))));
  }
  return out;
}

// Each index's parsed key sets, built per video on first use and kept as
// long as that index is (a new build is a new Map, so a new set).
const KEY_SETS = new WeakMap();
const NO_KEYS = tagKeySet([]);

// Each index's implied parents (sub-tags on): path -> [{key, facet, label}].
const IMPLIED = new WeakMap();
const NO_IMPLIED = Object.freeze(new Map());

class KeySetMap extends Map {
  constructor(index) {
    super();
    this._index = index;
    this._implied = impliedTags(index);
  }

  get(path) {
    let set = super.get(path);
    if (set === undefined) {
      const tags = this._index.get(path);
      const extra = this._implied.get(path);
      const all = extra && Array.isArray(tags) ? [...tags, ...extra] : tags;
      set = Array.isArray(all) && all.length ? tagKeySet(all) : NO_KEYS;
      super.set(path, set);
    }
    return set;
  }
}

/**
 * The parsed key sets of an index (path -> tagKeySet), one per index. With
 * sub-tags on, a video's set also holds its implied parents (impliedTags),
 * so a parent picked in the filter finds it.
 */
export function keySetsFor(index) {
  if (!(index instanceof Map)) return new KeySetMap(new Map());
  let sets = KEY_SETS.get(index);
  if (!sets) {
    sets = new KeySetMap(index);
    KEY_SETS.set(index, sets);
  }
  return sets;
}

/**
 * The implied parents of an index's videos (sub-tags on): path -> [{key,
 * facet, label}], each a parent (any level up) of a tag the video has, which
 * it does not have itself. Empty for an index built with sub-tags off, or
 * not built by buildLibraryTagIndex.
 *
 * @param {Map<string, Array>} index
 * @returns {Map<string, Array<{key: string, facet: string, label: string}>>}
 */
export function impliedTags(index) {
  return (index instanceof Map && IMPLIED.get(index)) || NO_IMPLIED;
}

/**
 * The words under a parent tag's row in the Filters picker: "includes 3
 * sub-tags". '' for a row with none (or sub-tags off).
 *
 * @param {{subTags?: number}} row a `counts` row
 * @param {(key: string, params?: object) => string} translate i18n.js t
 * @returns {string}
 */
export function subTagNoteText(row, translate) {
  const n = row?.subTags;
  if (!Number.isInteger(n) || n <= 0 || typeof translate !== 'function') return '';
  return translate('library.filterTagIncludesSubTags', { count: n });
}

// The most tags one walk up or down the sub-tag graph visits.
const MAX_WALK = 20000;

// The most videos' implied-parent lists one graph keeps (by their own keys).
const MAX_IMPLIED_MEMO = 50000;
const NO_KEYS_LIST = Object.freeze([]);

/**
 * Stash's sub-tag rules over the compiled rules: each rule's text names a
 * tag key the way a source's tag would (aliases, yours included, and the
 * facet table applied); a performer, creator or studio never takes part.
 * `ancestorsOf(key)` lists every parent of `key`, all levels up, left out
 * the key itself and any tag hidden on every video (a walk passes through
 * such a tag to its own parents); `subTagCount(key)` counts every sub-tag
 * of a parent, all levels down. Both are cycle-safe and memoised.
 */
function subTagGraph(children, rules, hiddenEverywhere) {
  const down = new Map();
  const up = new Map();
  const known = new Map(); // a rule's text -> its key (main lists every level, so texts repeat)
  const keyOf = (textValue) => {
    if (known.has(textValue)) return known.get(textValue);
    const c = classifyTag(textValue, rules);
    const key = c && !NAME_FACET_SET.has(c.facet) ? c.key : null;
    known.set(textValue, key);
    return key;
  };
  const link = (map, a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const entry of list(children)) {
    if (!Array.isArray(entry)) continue;
    const parent = keyOf(entry[0]);
    if (!parent) continue;
    for (const childText of list(entry[1])) {
      const child = keyOf(childText);
      if (!child || child === parent) continue;
      link(down, parent, child);
      link(up, child, parent);
    }
  }
  if (!down.size) return null;
  const hidden = new Set();
  for (const item of list(hiddenEverywhere)) {
    const c = classifyTag(item, rules);
    if (c) hidden.add(c.key);
  }
  const walk = (map, start) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length && seen.size < MAX_WALK) {
      for (const next of map.get(stack.pop()) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    seen.delete(start);
    return seen;
  };
  const ancestors = new Map();
  const counts = new Map();
  let ranks = null;
  let byRank = null;
  const parentRows = new Map();
  const impliedBySet = new Map();
  return {
    // A video's implied parents (every ancestor of its keys it does not
    // have itself), in compareKeys order; the same own keys give the same
    // list, so it is kept per own-key list (an index rebuild with these rules
    // reuses it for every video whose tags did not change).
    impliedOf(tags) {
      let mark = '';
      for (const tag of tags) mark += `${tag.key}\n`;
      let out = impliedBySet.get(mark);
      if (out) return out;
      const have = new Set();
      for (const tag of tags) have.add(tag.key);
      const extra = new Set();
      for (const tag of tags) {
        for (const parent of this.ancestorsOf(tag.key)) if (!have.has(parent)) extra.add(parent);
      }
      out = extra.size ? Object.freeze(sortByRank(extra, this)) : NO_KEYS_LIST;
      if (impliedBySet.size >= MAX_IMPLIED_MEMO) impliedBySet.clear();
      impliedBySet.set(mark, out);
      return out;
    },
    // Every key of the graph in compareKeys order, as a number (built once):
    // a video's implied parents sort by it. undefined: not in the graph.
    rankOf(key) {
      if (!ranks) {
        byRank = [...new Set([...down.keys(), ...up.keys()])].sort(compareKeys);
        ranks = new Map(byRank.map((k, i) => [k, i]));
      }
      return ranks.get(key);
    },
    keyAt(rank) {
      return byRank ? byRank[rank] : undefined;
    },
    // The row of a parent no video has itself: its facet and Stash's name
    // (else the key's value, de-slugged), or null when it cannot be sent.
    // The same for every build with these rules, so kept.
    parentRow(key, compiled) {
      if (parentRows.has(key)) return parentRows.get(key);
      const parsed = parseTagKey(key);
      let made = null;
      if (parsed?.facet) {
        const stashName = compiled?.stashNames?.get(key);
        const label = stashName || (parsed.facet === 'length' ? parsed.value : deslug(parsed.value));
        const tag = sendableTag({ key, facet: parsed.facet, label });
        if (tag) made = { facet: parsed.facet, label: tag.label };
      }
      parentRows.set(key, made);
      return made;
    },
    ancestorsOf(key) {
      let out = ancestors.get(key);
      if (!out) {
        out = up.has(key) ? [...walk(up, key)].filter((k) => !hidden.has(k)) : [];
        ancestors.set(key, out);
      }
      return out;
    },
    subTagCount(key) {
      if (hidden.has(key) || !down.has(key)) return 0;
      let n = counts.get(key);
      if (n === undefined) {
        n = walk(down, key).size;
        counts.set(key, n);
      }
      return n;
    },
  };
}

// The sub-tag graph of one compiled rules object, its sub-tag rules and the
// tags hidden everywhere, built once and reused by every index built with
// them (its walks are memoised too). A rules object is never changed after
// compileTagRules, so it is a safe key.
const GRAPHS = new WeakMap();
function graphFor(children, rules, hiddenEverywhere) {
  const memo = rules && typeof rules === 'object' ? GRAPHS.get(rules) : undefined;
  if (memo && memo.children === children && memo.hidden === hiddenEverywhere) return memo.graph;
  const graph = subTagGraph(children, rules, hiddenEverywhere);
  if (rules && typeof rules === 'object') GRAPHS.set(rules, { children, hidden: hiddenEverywhere, graph });
  return graph;
}

// Key order for the implied parents: facet order, then the key.
const FACET_RANK = new Map(FACETS.map((f, i) => [f, i]));
function compareKeys(a, b) {
  const fa = FACET_RANK.get(a.slice(0, a.indexOf(':'))) ?? FACETS.length;
  const fb = FACET_RANK.get(b.slice(0, b.indexOf(':'))) ?? FACETS.length;
  return (fa - fb) || (a < b ? -1 : a > b ? 1 : 0);
}

// Keys in compareKeys order through the graph's ranks (one lookup per key,
// then a numeric sort); a key the graph has no rank for (never an ancestor)
// sorts after them by compareKeys.
function sortByRank(keys, graph) {
  const ranked = [];
  const rest = [];
  for (const key of keys) {
    const r = graph.rankOf(key);
    if (r === undefined) rest.push(key); else ranked.push(r);
  }
  ranked.sort((a, b) => a - b);
  const out = ranked.map((r) => graph.keyAt(r));
  if (rest.length) out.push(...rest.sort(compareKeys));
  return out;
}

/**
 * Add each video's implied parents to the counts (a parent no video has
 * gets its own row, labelled with Stash's name), mark the parents' rows
 * with their sub-tag count, and keep the implied parents beside the index.
 * A video keeps at most MAX_TAGS_PER_VIDEO tags with its implied parents
 * (the backend's cap: the phone gets them all).
 */
function addImpliedParents(index, counts, graph, rules, hiddenTags) {
  const implied = new Map();
  for (const [path, tags] of index) {
    let extra = graph.impliedOf(tags);
    // A parent you hid on this video is not implied on it either.
    if (extra.length && Object.prototype.hasOwnProperty.call(hiddenTags, path)) {
      const drop = new Set();
      for (const item of list(hiddenTags[path])) {
        const c = classifyTag(item, rules);
        if (c) drop.add(c.key);
      }
      if (drop.size) extra = extra.filter((key) => !drop.has(key));
    }
    const room = MAX_TAGS_PER_VIDEO - tags.length;
    if (!extra.length || room <= 0) continue;
    const keys = [];
    for (const key of extra) {
      if (keys.length >= room) break;
      let row = counts.get(key);
      if (!row) {
        const made = graph.parentRow(key, rules);
        if (!made) continue;
        row = { key, facet: made.facet, label: made.label, count: 0 };
        counts.set(key, row);
      }
      row.count += 1;
      keys.push(key);
    }
    if (keys.length) implied.set(path, keys);
  }
  for (const row of counts.values()) {
    const n = graph.subTagCount(row.key);
    if (n > 0) row.subTags = n;
  }
  // One frozen tag per key (its label is the row's, the same on every video).
  const shared = new Map();
  const tagOf = (key) => {
    let tag = shared.get(key);
    if (!tag) {
      const row = counts.get(key);
      tag = Object.freeze({ key, facet: row.facet, label: row.label });
      shared.set(key, tag);
    }
    return tag;
  };
  const out = new Map();
  for (const [path, keys] of implied) out.set(path, Object.freeze(keys.map(tagOf)));
  if (out.size) IMPLIED.set(index, out);
}

/**
 * The index for a list of videos (not memoised: LibraryTagIndex is).
 *
 * Only videos with a record from some source are merged (a video with none
 * has no tags), so a large library with few tags costs little. The
 * EroScripts record goes through the same per-video rule as the dialog's
 * chip list (video-options-tags.js): a record about another script, or one
 * naming a script on a video left with none, does not count; a record with
 * no `scriptPath` is about the video's same-name script (RB-2).
 *
 * @param {object} input
 * @param {Array<{path: string, funscriptPath?: string|null}>} input.videos
 * @param {object} [input.userTags] library.userTags
 * @param {object} [input.hiddenTags] library.hiddenTags
 * @param {object} [input.scriptTags] library.scriptTags
 * @param {object} [input.tagSettings] library.tagSettings
 * @param {object} [input.scriptMeta] scriptMetaMap(): funscript records by SCRIPT path
 * @param {object} [input.stash] the `stash` source by VIDEO path
 *   (stash-tags.js stashTagRecords: already empty when Stash is off)
 * @param {Map<string,string>|object} [input.nameIds] stash-tags.js
 *   nameIdentities: a bare performer or studio name joins its one identity
 * @param {object} [input.stashRules] stash-tags.js stashTagRuleSet: Stash's
 *   tag aliases and sub-tags (null while "Use Stash's tag aliases and
 *   sub-tags" is off: then nothing changes)
 * @param {object} [input.rules] compileTagRules(tagSettings, {stash:
 *   stashRules}), reused when given
 * @returns {{index: Map<string, Array>, counts: Map<string, {key, facet, label, count, subTags?}>,
 *   suggestions: Array<{key, facet, label, count}>, sourceCounts: Object<string, number>,
 *   stash: object, nameIds: Map<string,string>|object|null, rules: object}}
 *   `stash`, `nameIds` and `rules` are the ones this build used, for a
 *   reader that merges one video the same way (the dialog's chips); a count
 *   row of a parent tag (sub-tags on) counts the videos with it or one of its
 *   sub-tags, and `subTags` says how many sub-tags it has
 */
export function buildLibraryTagIndex({
  videos, userTags, hiddenTags, scriptTags, tagSettings, scriptMeta, stash, nameIds, stashRules, rules,
} = {}) {
  const user = isPlainObject(userTags) ? userTags : {};
  const records = isPlainObject(scriptTags) ? scriptTags : {};
  const meta = isPlainObject(scriptMeta) ? scriptMeta : {};
  const stashRecords = isPlainObject(stash) ? stash : {};
  const ids = nameIds instanceof Map || isPlainObject(nameIds) ? nameIds : null;
  const settings = isPlainObject(tagSettings) ? tagSettings : {};
  const tagRules = isPlainObject(stashRules) ? stashRules : null;
  const compiled = rules || compileTagRules(settings, tagRules ? { stash: tagRules } : undefined);
  const picked = candidates(videos, user, records, meta, stashRecords);

  const eroscripts = {};
  for (const v of picked) {
    if (!Object.prototype.hasOwnProperty.call(records, v.path)) continue;
    const rec = eroscriptsRecordForTags(recordWithScriptPath(records[v.path], v.path), v.funscriptPath || null);
    if (rec) eroscripts[v.path] = rec;
  }
  const merged = tagIndex(picked, { user, stash: stashRecords, eroscripts, funscript: meta }, {
    rules: compiled,
    nameIds: ids,
    hidden: isPlainObject(hiddenTags) ? hiddenTags : {},
    hiddenEverywhere: Array.isArray(settings.hidden) ? settings.hidden : [],
  });

  // The backend's limits, applied here so the phone filters what the
  // desktop filters (R3R-2); then one label per key, the best source's in
  // its display form, chosen while counting and written back on every
  // video's tag. The tag objects are this build's own: changed here only.
  const index = new Map();
  const counts = new Map();
  const labelRank = new Map();
  const who = new Map(); // key -> {identity, disambiguation} (Stash S1)
  const sourceCounts = Object.fromEntries(SOURCE_FACET.map((s) => [s, 0]));
  for (const [path, all] of merged) {
    const kept = capVideoTags(all.every(sendableTag) ? all : all.filter(sendableTag));
    if (!kept.length) continue;
    index.set(path, kept);
    const seenSources = new Set();
    for (const tag of kept) {
      const sources = list(tag.sources);
      const rank = SOURCE_RANK.get(sources[0]) ?? SOURCE_ORDER.length;
      const known = counts.get(tag.key);
      if (!known) {
        counts.set(tag.key, { key: tag.key, facet: tag.facet, label: tagDisplayLabel(tag), count: 1 });
        labelRank.set(tag.key, rank);
      } else {
        known.count += 1;
        if (rank < labelRank.get(tag.key)) {
          known.label = tagDisplayLabel(tag);
          labelRank.set(tag.key, rank);
        }
      }
      if (tag.identity) {
        const info = who.get(tag.key);
        if (!info) who.set(tag.key, { identity: tag.identity, disambiguation: tag.disambiguation || '' });
        else if (!info.disambiguation && tag.disambiguation) info.disambiguation = tag.disambiguation;
      }
      for (const s of sources) seenSources.add(s);
    }
    for (const s of seenSources) if (s in sourceCounts) sourceCounts[s] += 1;
  }
  if (who.size) disambiguateLabels(counts, who);
  for (const tags of index.values()) {
    for (const tag of tags) tag.label = counts.get(tag.key).label;
  }
  // Sub-tags (sn-tags): the implied parents, after the one-label pass, so a
  // parent's row and its implied copies show one label.
  const graph = tagRules ? graphFor(tagRules.children, compiled, settings.hidden) : null;
  if (graph) addImpliedParents(index, counts, graph, compiled, isPlainObject(hiddenTags) ? hiddenTags : {});
  return {
    index, counts, suggestions: [...counts.values()], sourceCounts, stash: stashRecords, nameIds: ids, rules: compiled,
  };
}

// Rows of one name facet whose labels read the same (folded), by group.
function sameLabelGroups(counts) {
  const groups = new Map();
  for (const row of counts.values()) {
    if (!NAME_FACET_SET.has(row.facet)) continue;
    const mark = `${row.facet}\u0000${foldForMatch(row.label)}`;
    if (!groups.has(mark)) groups.set(mark, []);
    groups.get(mark).push(row);
  }
  return [...groups.values()].filter((rows) => rows.length > 1);
}

/**
 * Two keys of one name facet that would show the same label (Stash S1:
 * two people called Jane Doe with different Stash IDs, or one of them and a
 * bare name): each key WITH an identity gets Stash's disambiguation, "Jane
 * Doe (blonde)", or else the last 4 characters of its identity, "Jane Doe ·
 * 3f2a"; a pair that still reads the same gets the 4 characters too. A key
 * with no identity keeps its label. No words, so nothing to translate.
 */
function disambiguateLabels(counts, who) {
  const tail = (info) => info.identity.slice(-4);
  for (const rows of sameLabelGroups(counts)) {
    for (const row of rows) {
      const info = who.get(row.key);
      if (!info) continue;
      row.label = info.disambiguation ? `${row.label} (${info.disambiguation})` : `${row.label} · ${tail(info)}`;
      info.suffixed = info.disambiguation ? 'dis' : 'tail';
    }
  }
  for (const rows of sameLabelGroups(counts)) {
    for (const row of rows) {
      const info = who.get(row.key);
      if (info?.suffixed === 'dis') row.label = `${row.label} · ${tail(info)}`;
    }
  }
}

// The videos that have a record in some source (own key in a map: a
// prototype name is not a record).
function candidates(videos, user, records, meta, stash = {}) {
  const has = (map, key) => typeof key === 'string' && key !== '' && Object.prototype.hasOwnProperty.call(map, key) && map[key] != null;
  const out = [];
  const seen = new Set();
  for (const v of list(videos)) {
    const p = v?.path;
    if (typeof p !== 'string' || !p || seen.has(p)) continue;
    if (has(user, p) || has(records, p) || has(meta, v.funscriptPath) || has(stash, p)) {
      seen.add(p);
      out.push(v);
    }
  }
  return out;
}

/**
 * The library's one memoised tag index.
 *
 *   new LibraryTagIndex({ settings, videos, scriptMeta, scriptMetaVersion,
 *                         stashData, stashVersion })
 *   .get()   -> the index result (buildLibraryTagIndex), rebuilt only when an
 *               input changed: a stored map (identity or `bump()`), the
 *               script-meta version or map, the video list or the scan
 *               counter, a candidate video's pairing, or the Stash data
 *               (its object, its version, `stash.enabled`, or
 *               `stash.useTagRules`: Stash's tag aliases and sub-tags)
 *   .bump()  -> the caller saw a change the identities may not show
 *               (settings:changed on a tag key, a scan, a meta change)
 *   .builds  -> how many times it rebuilt (tests)
 */
export class LibraryTagIndex {
  /**
   * @param {object} deps
   * @param {() => object} deps.settings the DataService (get(path))
   * @param {() => Array} deps.videos the library's video list now
   * @param {() => object} [deps.scriptMeta] scriptMetaMap
   * @param {() => number} [deps.scriptMetaVersion]
   * @param {() => object} [deps.stashData] stash-store.js stashData(): main's
   *   stash/library.json (frozen, never null; empty before the first load)
   * @param {() => number} [deps.stashVersion] stash-store.js stashVersion()
   */
  constructor({ settings, videos, scriptMeta, scriptMetaVersion, stashData, stashVersion } = {}) {
    this._settings = typeof settings === 'function' ? settings : () => null;
    this._videos = typeof videos === 'function' ? videos : () => [];
    this._scriptMeta = typeof scriptMeta === 'function' ? scriptMeta : () => ({});
    this._scriptMetaVersion = typeof scriptMetaVersion === 'function' ? scriptMetaVersion : () => 0;
    this._stashData = typeof stashData === 'function' ? stashData : () => null;
    this._stashVersion = typeof stashVersion === 'function' ? stashVersion : () => 0;
    this._version = 0;
    this._key = null;
    this._result = null;
    this._rulesMemo = null;
    this._stashMemo = null;
    this._idsMemo = null;
    this._tagRulesMemo = null;
    this.builds = 0;
  }

  /** Something changed that the identities may not show. */
  bump() {
    this._version += 1;
  }

  /** The last result, without the checks (null before the first get()). */
  peek() {
    return this._result;
  }

  get() {
    const ds = this._settings();
    const read = (k) => { try { return ds?.get?.(k); } catch { return undefined; } };
    const userTags = read('library.userTags');
    const hiddenTags = read('library.hiddenTags');
    const scriptTags = read('library.scriptTags');
    const tagSettings = read('library.tagSettings');
    let meta;
    let metaVersion;
    try { meta = this._scriptMeta(); } catch { meta = {}; }
    try { metaVersion = this._scriptMetaVersion(); } catch { metaVersion = 0; }
    const videos = list(this._videos());
    // Stash S1: off (or never set up) gives no source and no join.
    const stashEnabled = read(STASH_ENABLED_KEY) === true;
    let stashData;
    let stashVersion;
    try { stashData = this._stashData(); } catch { stashData = null; }
    try { stashVersion = this._stashVersion(); } catch { stashVersion = 0; }
    const stash = this._stashFor(stashData, stashVersion, stashEnabled, videos);
    const nameIds = this._nameIdsFor(stashData, stashVersion, stashEnabled);
    // sn-tags: Stash's tag aliases and sub-tags, only while both settings are on.
    const useTagRules = read(STASH_TAG_RULES_KEY) === true;
    const stashRules = this._tagRulesFor(stashData, stashVersion, stashEnabled, useTagRules);
    const picked = candidates(videos, isPlainObject(userTags) ? userTags : {},
      isPlainObject(scriptTags) ? scriptTags : {}, isPlainObject(meta) ? meta : {}, stash);
    const pairing = picked.map((v) => `${v.path}\u0000${v.funscriptPath || ''}`);

    const key = {
      userTags, hiddenTags, scriptTags, tagSettings, meta, metaVersion, videos, version: this._version, pairing,
      stash, nameIds, stashVersion, stashEnabled, stashRules, useTagRules,
    };
    if (this._result && sameKey(this._key, key)) return this._result;

    const rules = this._rulesFor(tagSettings, stashRules);
    this._result = buildLibraryTagIndex({
      videos: picked, userTags, hiddenTags, scriptTags, tagSettings, scriptMeta: meta, stash, nameIds, stashRules, rules,
    });
    this._key = key;
    this.builds += 1;
    return this._result;
  }

  // The `stash` source for this list: projected again only when the data,
  // its version, the setting or the library list changed (the trust check
  // reads each video's scanned size).
  _stashFor(data, version, enabled, videos) {
    const m = this._stashMemo;
    if (m && m.data === data && m.version === version && m.enabled === enabled && m.videos === videos) return m.records;
    const records = stashTagRecords(data, { videos, enabled });
    this._stashMemo = { data, version, enabled, videos, records };
    return records;
  }

  // The bare-name join, once per Stash data version and setting.
  _nameIdsFor(data, version, enabled) {
    const m = this._idsMemo;
    if (m && m.data === data && m.version === version && m.enabled === enabled) return m.ids;
    const ids = nameIdentities(data, { enabled });
    this._idsMemo = { data, version, enabled, ids };
    return ids;
  }

  // Stash's tag aliases and sub-tags, once per data version and settings.
  // The same rules keep the same set object (sn-fixup SN-R5): a Stash data
  // change that did not change them (a link, an Undo, a sync without a new
  // tag tree) reuses the compiled rules and the sub-tag graph.
  _tagRulesFor(data, version, enabled, useTagRules) {
    const m = this._tagRulesMemo;
    if (m && m.data === data && m.version === version && m.enabled === enabled && m.useTagRules === useTagRules) {
      return m.set;
    }
    const stamp = tagRuleSetStamp(data, { enabled, useTagRules });
    if (m && stamp !== null && m.stamp === stamp) {
      this._tagRulesMemo = { ...m, data, version };
      return m.set;
    }
    let set = stashTagRuleSet(data, { enabled, useTagRules });
    if (m && sameTagRuleSet(m.set, set)) set = m.set;
    this._tagRulesMemo = { data, version, enabled, useTagRules, set, stamp };
    return set;
  }

  _rulesFor(tagSettings, stashRules = null) {
    const m = this._rulesMemo;
    if (m && m.settings === tagSettings && m.stash === stashRules) return m.rules;
    const rules = compileTagRules(isPlainObject(tagSettings) ? tagSettings : {}, stashRules ? { stash: stashRules } : undefined);
    this._rulesMemo = { settings: tagSettings, stash: stashRules, rules };
    return rules;
  }
}

function sameKey(a, b) {
  if (!a || !b) return false;
  for (const k of ['userTags', 'hiddenTags', 'scriptTags', 'tagSettings', 'meta', 'metaVersion', 'videos', 'version',
    'stash', 'nameIds', 'stashVersion', 'stashEnabled', 'stashRules', 'useTagRules']) {
    if (a[k] !== b[k]) return false;
  }
  if (a.pairing.length !== b.pairing.length) return false;
  for (let i = 0; i < a.pairing.length; i += 1) if (a.pairing[i] !== b.pairing[i]) return false;
  return true;
}

/**
 * The rows of one facet for the Filters picker, most used first, then by
 * label. `query` (the find box) keeps the rows whose shown text has it.
 *
 * @param {Array<{key, facet, label, count}>} rows
 * @param {string} [query]
 * @param {(row) => string} [shown] the text a row is shown with (length: "10-25 min")
 */
export function facetRows(rows, query = '', shown = (r) => r.label) {
  const q = foldForMatch(query);
  const out = list(rows).filter((r) => !q || foldForMatch(shown(r)).includes(q));
  return out.sort((a, b) => (b.count - a.count) || String(shown(a)).localeCompare(String(shown(b))));
}
