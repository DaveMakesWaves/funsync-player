// Tags on a video: one record per SOURCE, merged only when something reads them.
//
// The pure core of the tags phase (P1) of the next major
// (notes/features/PLAN-next-major-2026-11.md §2;
// notes/features/DESIGN-video-options.md (c), (e)). Dave decided on
// 2026-11-17 that tags are stored apart from categories. The store keys are
// in electron/store.js (library.userTags, hiddenTags, tagSettings,
// showTagsOnCards), the backups count and merge them (data-backup.js,
// data-export.js), and the writers are renderer/js/video-tag-edits.js.
//
// Who reads the tag maps through this module (wired 2026-11-18, Round 3):
// - the video options dialog's Tags section (renderer/components/
//   video-options-tags.js: effectiveTags for one video, the chips, the add box);
// - the library's ONE memoised index (renderer/js/library-tag-filter.js
//   LibraryTagIndex / buildLibraryTagIndex over tagIndex): the Filters
//   picker's Tags facets and counts, the filter itself (filterByTags), the
//   cards' tag line, the dialog's suggestions and "Make a category";
// - the phone, through that same index: renderer/js/remote-tag-slice.js
//   sends each video's merged tags to the backend, and the phone filters them
//   with backend/web-remote/tag-filter.js (its copy of filterByTags);
// - the funscript files' own metadata comes in through funscriptMetaRecord
//   (renderer/js/script-meta-store.js, harvested by the backend).
// Search never matches tags (Dave, 2026-11-17): nothing here feeds it.
//
// The model, in one line (plan §2.2):
//
//   effectiveTags(video) = aliases( union( your own tags, Stash, stash-box,
//                                          the funscript's own metadata,
//                                          the EroScripts post ) )
//                          minus the tags you hid on this video
//                          minus the tags you hid on every video, unless
//                            you gave this video that tag yourself
//
// Each tag keeps the list of sources that gave it, so a UI can say "from
// EroScripts" or "added by you".
//
// Rules this module keeps:
// - Absence is never destructive. A source with no record for a video adds
//   nothing and never removes what another source gave. Nothing here writes:
//   every function returns new values and leaves its inputs as they were.
// - Each source keeps its own record; a refresh of one source replaces only
//   that record (the caller's job). The merge happens here, on read, so no
//   source can wipe another's tags and no bad diff can lose your own.
// - Tag keys are `facet:value`. The facet comes from a small bundled table
//   built from EroScripts' tag groups (TAG_TABLE); a tag the table does not
//   know is `content`. Matching folds case, whitespace and diacritics; the
//   label keeps the display form a source gave (EroScripts tags, which are
//   slugs, are only de-slugged). Facet names and the length unit are for the
//   UI to translate: nothing here is a user-facing string.
// - filterByTags is mirrored in backend/web-remote/tag-filter.js. Both copies
//   are pinned by tests/fixtures/tag-filter-parity.json.
// - A string that is not well-formed text (a lone UTF-16 surrogate: half an
//   emoji from a tool that cut one) is unusable, like a non-string: no tag,
//   no alias, no metadata value is made from it (r3-fixup R3R-1, 2026-11-18;
//   the backend's harvest and tag slice refuse the same strings).
// - One display form per tag (tagDisplayLabel): a label that is only its
//   multi-word slug (`the-handy`) shows de-slugged (`the handy`), as a forum
//   tag does; the library index then picks one label per key for every video
//   (library-tag-filter.js), so the picker, chips, cards, dialog and phone
//   agree (r3-fixup, 2026-11-18).
// - Identity keys (Stash S1, 1d, 2026-11-18; DESIGN-stash-s1.md (c)
//   "Performers and studios split by Stash ID"): a performer or studio a
//   linked Stash names with an identity (its Stash ID, else `d-<slug of its
//   disambiguation>`) has the key `performer:<name slug>#<identity>`, so two
//   people of one name are two tags. Only a record's own `identity` field
//   (the `stash` and `stashbox` sources) makes one: a `#` in a name you typed
//   or a file gave becomes `-` (the `#` guard). A bare name joins an identity
//   only when exactly one identity in the library has that name
//   (`options.nameIds`, stash-tags.js nameIdentities). A KEY you hand back
//   (a chip's key, a hidden key: classifyTag, the hide lists) keeps its
//   identity. filterByTags and the phone's copy are unchanged: a slug keeps
//   `#` on both.
// - Stash's tag aliases (Stash "next" lot, sn-tags, 2026-11-19;
//   DESIGN-stash-s1.md (j) row 5 and Dave's answer: an opt-in, "Use Stash's
//   tag aliases and sub-tags", off by default): compileTagRules(settings,
//   {stash}) adds them as a layer between the bundled table and your own
//   aliases, read from every source (yours, the file's, the forum's,
//   Stash's). Yours always win: an alias of yours from the same text, your
//   facet override of it, your alias of the key it is classified to, or a
//   chain of yours that would lead back to it drops Stash's alias. A Stash
//   tag's own name is never renamed by another tag's alias, and no Stash
//   alias touches a performer, creator or studio. An aliased tag shows
//   Stash's spelling. Without the layer (the opt-in off) every rule here is
//   exactly as before. Sub-tags are the library index's
//   (library-tag-filter.js).

import { sameNameScriptPath } from './script-tags.js';

/** Where a tag came from. */
export const TAG_SOURCES = Object.freeze({
  USER: 'user',             // your own tags (plan: library.userTags[videoPath])
  STASH: 'stash',           // a linked Stash server (stash-tags.js stashTagRecords, from main's stash/library.json)
  STASHBOX: 'stashbox',     // StashDB and the other stash-boxes (library.stashboxMeta), later
  FUNSCRIPT: 'funscript',   // the funscript file's own metadata (scriptMetaCache[funscriptPath])
  EROSCRIPTS: 'eroscripts', // the post the script came from (library.scriptTags[videoPath])
});

/**
 * Source precedence. A tag lists its sources in this order, and the first
 * source in it that gave the tag supplies the label: what you typed, then a
 * curated name (Stash, stash-box), then the file's own spelling, then the
 * forum's slug.
 */
export const SOURCE_ORDER = Object.freeze(['user', 'stash', 'stashbox', 'funscript', 'eroscripts']);

/**
 * Facets in display order. The first eight are EroScripts' tag groups (VR,
 * Display, Length, Devices, Axis, Script type, Sexuality, Threesome); then
 * `content`, the default for a tag in no group, and the three name facets.
 * Mirrored in backend/web-remote/tag-filter.js (FACET_IDS).
 */
export const FACETS = Object.freeze([
  'vr', 'display', 'length', 'device', 'axis', 'script-type', 'sexuality', 'threesome',
  'content', 'performer', 'creator', 'studio',
]);

export const DEFAULT_FACET = 'content';

/** Facets whose values are names (people, studios), not tags. */
export const NAME_FACETS = Object.freeze(['performer', 'creator', 'studio']);

/**
 * Name facets whose values can carry an identity (Stash S1): the people and
 * studios Stash keeps apart by Stash ID. `creator` has none (no Stash source
 * gives one), so its keys stay exactly as before.
 */
export const IDENTITY_FACETS = Object.freeze(['performer', 'studio']);

/** Joins a name to its identity in a key: `performer:jane-doe#3f2a…`. */
export const IDENTITY_MARK = '#';

const FACET_SET = new Set(FACETS);
const NAME_FACET_SET = new Set(NAME_FACETS);
const IDENTITY_FACET_SET = new Set(IDENTITY_FACETS);
// The sources whose records may carry an identity: Stash and the stash-boxes.
const IDENTITY_SOURCES = new Set(['stash', 'stashbox']);
const MAX_ALIAS_STEPS = 8;
const MAX_IDENTITY = 256;

/**
 * The bundled facet and alias table (plan §2.2). Data only: add a row here,
 * not a branch in the code. It is bundled, never fetched: no extra requests,
 * no ToS question, and it updates when FunSync updates.
 *
 * NOT YET CHECKED against the live group list. The 2026-11-05 research
 * download of EroScripts' tag groups is no longer on disk, so this holds only
 * the tags the plan and the repo name: `non-vr`, the devices (`the-handy`,
 * `osr2`, `sr6`, `machine`, `toy`), the `len-a-b` buckets and the plan's four
 * aliases. `multi-axis`, `cock-hero` and `futanari` are placed by meaning,
 * not read from a group. The Display and Threesome groups have no rows yet.
 * Confirm against the group list before the tags phase ships.
 *
 * - `facets`: tag slug → facet.
 * - `patterns`: a slug matching `match` (anchored) goes to `facet`, with the
 *   value rewritten by `value` (String#replace syntax).
 * - `aliases`: tag slug → the slug (or `facet:value` key) it means.
 */
export const TAG_TABLE = deepFreeze({
  facets: {
    vr: 'vr',
    'non-vr': 'vr',
    'the-handy': 'device',
    // Not in EroScripts' Devices group (newer device tags drift): a hand override.
    'the-handy-2': 'device',
    osr2: 'device',
    sr6: 'device',
    machine: 'device',
    toy: 'device',
    'multi-axis': 'axis',
    'cock-hero': 'script-type',
    futanari: 'sexuality',
  },
  patterns: [
    // `len-10-25` → `length:10-25`. Junk like `len-40` or `muti-len` does not
    // match and stays a plain content tag (plan §2.2).
    { facet: 'length', match: '^len-(\\d+)-(\\d+)$', value: '$1-$2' },
  ],
  aliases: {
    cockhero: 'cock-hero',
    thehandy: 'the-handy',
    futa: 'futanari',
    'handy-2': 'the-handy-2',
  },
});

const TABLE_PATTERNS = TAG_TABLE.patterns.map((p) => ({ facet: p.facet, re: new RegExp(p.match), value: p.value }));

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// The combining marks library-search.js strips too.
const COMBINING_RE = /[\u0300-\u036f]/g; // the combining diacritical marks

// A lone surrogate: a high one not followed by a low one, or a low one not
// after a high one (String.prototype.isWellFormed, which older engines lack).
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Is this usable text: a string with no lone UTF-16 surrogate? JSON allows
 * `"\ud83d"` (half an emoji), and no UTF-8 encoder (the backend's answers,
 * its cache file) can carry it, so such a string is unusable everywhere
 * (r3-fixup R3R-1). The backend's twin: services/script_meta.py _well_formed.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isWellFormedText(text) {
  if (typeof text !== 'string') return false;
  return typeof text.isWellFormed === 'function' ? text.isWellFormed() : !LONE_SURROGATE_RE.test(text);
}

/**
 * The form two spellings are compared in: compatibility-decomposed (full-width
 * letters become ASCII, ligatures split), diacritics stripped, recomposed (so
 * Hangul and kana stay whole), lower case, whitespace collapsed.
 *
 * @param {unknown} text
 * @returns {string} '' for anything that is not a string or a number
 */
export function foldForMatch(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text)
    .normalize('NFKD').replace(COMBINING_RE, '').normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The form a tag is shown in: as the source wrote it, whitespace collapsed.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function displayForm(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * The matching key of one tag value: folded, with spaces and underscores as
 * single dashes. `Blow Job`, `blow_job` and `BLOW-JOB` are all `blow-job`.
 * Idempotent: a slug slugs to itself.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function tagSlug(text) {
  return foldForMatch(text)
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A slug for showing: dashes become spaces (`the-handy` → `the handy`). */
export function deslug(value) {
  return String(value ?? '').replace(/-+/g, ' ').trim();
}

/**
 * The one form a tag is shown in, everywhere (the Filters picker, the
 * chips, the cards, the dialog, the phone): its label, except that a label
 * a file or a post gave which is only its own multi-word slug (`the-handy`,
 * as a funscript's metadata often spells it) shows de-slugged (`the handy`),
 * the form the forum's tags already show in. What you typed keeps your
 * spelling (the label's source is the first of `sources`); a length keeps
 * its numbers (the UI adds the unit); a name (performer, creator, studio)
 * keeps its spelling.
 *
 * @param {{facet?: string, value?: string, label?: unknown, key?: string, sources?: string[]}} tag
 * @returns {string}
 */
export function tagDisplayLabel(tag) {
  const label = String(tag?.label ?? '');
  if (!tag || tag.facet === 'length' || NAME_FACET_SET.has(tag.facet)) return label;
  if (Array.isArray(tag.sources) && tag.sources[0] === TAG_SOURCES.USER) return label;
  const value = typeof tag.value === 'string' ? tag.value
    : (typeof tag.key === 'string' && tag.key.includes(':') ? tag.key.slice(tag.key.indexOf(':') + 1) : null);
  return value && label === value && value.includes('-') ? deslug(value) : label;
}

/**
 * Read a `facet:value` key. A prefix that is not a known facet is part of the
 * value (`00:51-lenght` is one bare value), so is a missing one.
 *
 * @param {unknown} key
 * @returns {{facet: string|null, value: string}|null} null when nothing is left
 */
export function parseTagKey(key) {
  const parsed = parseLoose(key);
  return parsed ? { facet: parsed.facet, value: parsed.value } : null;
}

/**
 * A key in its matching form: `Device: The Handy` → `device:the-handy`; a
 * bare value stays bare (`The Handy` → `the-handy`). '' when nothing is left.
 *
 * @param {unknown} key
 * @returns {string}
 */
export function normalizeTagKey(key) {
  const parsed = parseLoose(key);
  if (!parsed) return '';
  return parsed.facet ? `${parsed.facet}:${parsed.value}` : parsed.value;
}

// parseTagKey plus the display text of the value part.
function parseLoose(key) {
  if (typeof key !== 'string' && typeof key !== 'number') return null;
  const text = String(key);
  const colon = text.indexOf(':');
  if (colon > 0) {
    // Folded as the value is: `Script Type: Cock Hero` is script-type:cock-hero,
    // not content:script-type:-cock-hero (fix-up 2026-11-17).
    const facet = tagSlug(text.slice(0, colon));
    if (FACET_SET.has(facet)) {
      const rest = text.slice(colon + 1);
      const value = tagSlug(rest);
      return value ? { facet, value, text: displayForm(rest) } : null;
    }
  }
  const value = tagSlug(text);
  return value ? { facet: null, value, text: displayForm(text) } : null;
}

// ---------------------------------------------------------------------------
// Identities (Stash S1): same-name performers and studios kept apart
// ---------------------------------------------------------------------------

// A slug with no `#` in it: each run of `#` becomes one dash, then the
// dashes are tidied as tagSlug tidies them.
function withoutMark(slug) {
  return String(slug)
    .replace(/#+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The identity part of a key, from a Stash ID or `d-<disambiguation>`:
 * folded as a slug (lower case), with no `#` in it. null for anything that
 * is not usable text or is longer than 256 characters.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function tagIdentity(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_IDENTITY || !isWellFormedText(raw)) return null;
  return withoutMark(tagSlug(raw)) || null;
}

/**
 * The slug of a performer's or studio's NAME: tagSlug with each `#` turned
 * into `-`, so no name a file gave or you typed can spell an identity key.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function nameSlug(text) {
  return withoutMark(tagSlug(text));
}

// A key's value in an identity facet, read as a KEY: the name before the
// first `#`, the identity after it (null when none is usable).
function splitIdentity(value) {
  const at = value.indexOf(IDENTITY_MARK);
  if (at < 0) return { name: value, identity: null };
  const name = withoutMark(value.slice(0, at));
  return name ? { name, identity: tagIdentity(value.slice(at + 1)) } : null;
}

// The one identity the library has for a bare name, or null (none, or two
// and more: then nameIdentities leaves the name out).
function joinedIdentity(nameIds, facet, value) {
  if (!nameIds || !IDENTITY_FACET_SET.has(facet)) return null;
  const id = pick(nameIds, `${facet}:${value}`);
  return typeof id === 'string' && tagIdentity(id) === id ? id : null;
}

/**
 * Rules that also join bare names to identities (`nameIds` from
 * stash-tags.js nameIdentities): hand them to classifyTag,
 * classifyTypedTag and the edit planners (video-tag-edits.js ctx.rules) so
 * a chip's key, your typed tag and effectiveTags agree.
 *
 * @param {object} rules a compileTagRules result
 * @param {Map<string,string>|Object<string,string>|null} nameIds
 * @returns {object} new rules; `rules` itself is not changed
 */
export function withNameIds(rules, nameIds) {
  return { ...(rules || DEFAULT_RULES), nameIds: nameIds || null };
}

// ---------------------------------------------------------------------------
// Classification: the facet table, the aliases and your overrides
// ---------------------------------------------------------------------------

/**
 * Compile the table plus your own settings once, for many effectiveTags calls
 * (pass the result as `options.rules`). The plan's `tagSettings` shape:
 *
 * - `aliases`: `{from: to}`, applied when tags are read (a rename or merge is
 *   an alias, so nothing rewrites stored tags and undo is deleting the
 *   alias). A bare `from` (or a `content:` one) renames a tag before the
 *   facet table sees it; a `facet:value` `from` renames that key (for names:
 *   `performer:jane` → `performer:jane-doe`). Yours win over the bundled ones.
 * - `facetOverrides`: `{tag: facet}`, moving a tag to another facet. Unknown
 *   facets are ignored.
 *
 * `layers.stash` (sn-tags, 2026-11-19): Stash's tag aliases and tag names
 * (stash-tags.js stashTagRuleSet), given only while "Use Stash's tag aliases
 * and sub-tags" is on. A layer between the bundled table and your aliases:
 * it wins over a bundled alias of the same text, and yours win over it (see
 * addStashLayer). Absent or null: the rules are exactly today's.
 *
 * @param {{aliases?: Object<string,string>, facetOverrides?: Object<string,string>}} [settings]
 * @param {{stash?: {aliases?: Array<[string, string]>, names?: string[]}|null}} [layers]
 */
export function compileTagRules(settings = {}, layers = undefined) {
  const slugAliases = new Map();
  const keyAliases = new Map();
  const addAlias = (from, to) => {
    if (typeof to !== 'string' && typeof to !== 'number') return null;
    if (!isWellFormedText(String(from)) || !isWellFormedText(String(to))) return null;
    const src = parseTagKey(from);
    let dst = parseTagKey(to);
    if (!src || !dst) return null;
    // Stash S1: an alias may rename an identity key (`from` is a key), but
    // never point at one (`to` is typed text): the `#` guard.
    if (IDENTITY_FACET_SET.has(dst.facet)) {
      dst = { facet: dst.facet, value: withoutMark(dst.value) };
      if (!dst.value) return null;
    }
    if (IDENTITY_FACET_SET.has(src.facet)) {
      const parts = splitIdentity(src.value);
      if (!parts) return null;
      const mark = parts.identity ? `${parts.name}${IDENTITY_MARK}${parts.identity}` : parts.name;
      keyAliases.set(`${src.facet}:${mark}`, dst);
      return { key: `${src.facet}:${mark}` };
    }
    if (src.facet && src.facet !== DEFAULT_FACET) {
      keyAliases.set(`${src.facet}:${src.value}`, dst);
      return { key: `${src.facet}:${src.value}` };
    }
    slugAliases.set(src.value, dst);
    return { slug: src.value };
  };
  // What YOUR settings claim (the Stash layer never overrides them).
  const own = { slugs: new Set(), keys: new Set(), facets: new Set() };
  for (const [from, to] of Object.entries(TAG_TABLE.aliases)) addAlias(from, to);
  if (isPlainObject(settings?.aliases)) {
    for (const [from, to] of Object.entries(settings.aliases)) {
      const set = addAlias(from, to);
      if (set?.slug) own.slugs.add(set.slug);
      if (set?.key) own.keys.add(set.key);
    }
  }

  const facetOf = new Map(Object.entries(TAG_TABLE.facets));
  if (isPlainObject(settings?.facetOverrides)) {
    for (const [tag, facet] of Object.entries(settings.facetOverrides)) {
      const slug = tagSlug(tag);
      const target = typeof facet === 'string' ? facet.trim().toLowerCase() : '';
      if (slug && FACET_SET.has(target) && !NAME_FACET_SET.has(target)) {
        facetOf.set(slug, target);
        own.facets.add(slug);
      }
    }
  }
  const rules = { slugAliases, keyAliases, facetOf, patterns: TABLE_PATTERNS };
  const stash = layers?.stash;
  if (stash && typeof stash === 'object') {
    // The same rules without the Stash layer (sn-fixup, 2026-11-19, SN-R1):
    // how a source's tag reads once the opt-in or Stash is off, for the
    // writer that keeps a hide working then (video-tag-edits.js
    // planRemoveTag, through sourceKeysUnder).
    rules.withoutStash = { slugAliases: new Map(slugAliases), keyAliases: new Map(keyAliases), facetOf, patterns: TABLE_PATTERNS };
    addStashLayer(rules, stash, own);
  }
  return rules;
}

// A key's mark as resolveKey records it: a bare or content value as
// `:value`, any other facet as `facet:value`.
function aliasMark(parsed) {
  return !parsed.facet || parsed.facet === DEFAULT_FACET ? `:${parsed.value}` : `${parsed.facet}:${parsed.value}`;
}

/**
 * Stash's tag aliases and names into compiled rules (sn-tags). Each alias
 * `from -> to` (an alias's slug -> its tag's key) is left out when:
 * - either side is a performer, creator or studio (tag aliases are tags);
 * - `from` is a Stash tag's own name, or a tag a rule names (no Stash tag is
 *   ever renamed by another tag's alias, so Stash's aliases never chain);
 * - YOURS claim it: your alias of the same text, your facet override of it,
 *   your alias of the key the table classifies it to, or your aliases lead
 *   from its target back to it (a cycle: yours win).
 * It replaces a bundled alias of the same text. Stash's names label the tags
 * they key (`stashNames`, read by resolveEntry when an alias, a pattern or a
 * slug changed the source's spelling).
 */
function addStashLayer(rules, stash, own) {
  const canonical = new Set();
  const names = new Map();
  for (const name of asList(stash.names)) {
    if (typeof name !== 'string' || !isWellFormedText(name)) continue;
    const parsed = parseLoose(name);
    if (!parsed || NAME_FACET_SET.has(parsed.facet)) continue;
    canonical.add(aliasMark(parsed));
    const key = !parsed.facet || parsed.facet === DEFAULT_FACET ? classifyBare(parsed.value, rules) : parsed;
    const keyText = `${key.facet}:${key.value}`;
    if (key.facet !== 'length' && parsed.text && !names.has(keyText)) names.set(keyText, parsed.text);
  }
  const pairs = [];
  for (const pair of asList(stash.aliases)) {
    if (!Array.isArray(pair)) continue;
    const [from, to] = pair;
    if (typeof from !== 'string' || typeof to !== 'string' || !isWellFormedText(from) || !isWellFormedText(to)) continue;
    const src = parseTagKey(from);
    const dst = parseTagKey(to);
    if (!src || !dst || NAME_FACET_SET.has(src.facet) || NAME_FACET_SET.has(dst.facet)) continue;
    canonical.add(aliasMark(dst));
    pairs.push({ src, dst });
  }
  // The tags the sub-tag rules name are Stash tags too.
  for (const entry of asList(stash.children)) {
    if (!Array.isArray(entry)) continue;
    for (const text of [entry[0], ...asList(entry[1])]) {
      if (typeof text !== 'string' || !isWellFormedText(text)) continue;
      const parsed = parseTagKey(text);
      if (parsed && !NAME_FACET_SET.has(parsed.facet)) canonical.add(aliasMark(parsed));
    }
  }
  for (const { src, dst } of pairs) {
    const mark = aliasMark(src);
    if (canonical.has(mark) || mark === aliasMark(dst)) continue;
    const bare = mark.startsWith(':');
    if (bare) {
      if (own.slugs.has(src.value) || own.facets.has(src.value)) continue;
      const classified = classifyBare(src.value, rules);
      if (classified.facet !== DEFAULT_FACET && own.keys.has(`${classified.facet}:${classified.value}`)) continue;
    } else if (own.keys.has(mark)) continue;
    const map = bare ? rules.slugAliases : rules.keyAliases;
    const at = bare ? src.value : mark;
    const before = map.get(at);
    map.set(at, { facet: dst.facet, value: dst.value });
    const seen = new Set();
    resolveKey({ facet: dst.facet, value: dst.value }, rules, seen);
    if (seen.has(mark)) {
      if (before) map.set(at, before);
      else map.delete(at);
    }
  }
  if (names.size) rules.stashNames = names;
}

const DEFAULT_RULES = compileTagRules();

// A bare slug through the facet table: an override or a table row, then the
// patterns, else content.
function classifyBare(slug, rules) {
  const facet = rules.facetOf.get(slug);
  if (facet) return { facet, value: slug };
  for (const pattern of rules.patterns) {
    if (pattern.re.test(slug)) return { facet: pattern.facet, value: slug.replace(pattern.re, pattern.value) };
  }
  return { facet: DEFAULT_FACET, value: slug };
}

// Follow aliases (bounded, cycle-safe), classifying a bare tag on the way.
// `content:` counts as bare: content is where unclassified tags live, so a
// content key re-classifies when the table or an alias learns it. `seen`
// collects every mark passed (the Stash layer's cycle check reads it).
function resolveKey(start, rules, seen = new Set()) {
  let cur = start;
  for (let step = 0; step < MAX_ALIAS_STEPS; step += 1) {
    if (!cur.facet || cur.facet === DEFAULT_FACET) {
      const mark = `:${cur.value}`;
      const next = seen.has(mark) ? null : rules.slugAliases.get(cur.value);
      seen.add(mark);
      if (next) { cur = next; continue; }
      cur = classifyBare(cur.value, rules);
      if (cur.facet === DEFAULT_FACET) return cur;
    }
    const mark = `${cur.facet}:${cur.value}`;
    const next = seen.has(mark) ? null : rules.keyAliases.get(mark);
    seen.add(mark);
    if (!next) return cur;
    cur = next;
  }
  return (!cur.facet || cur.facet === DEFAULT_FACET) ? classifyBare(cur.value, rules) : cur;
}

/**
 * The canonical key of one tag KEY: a chip's key, a key in a hide list, a
 * name with its facet. An identity in a performer or studio key
 * (`performer:jane-doe#3f2a…`) is kept, so a Stash chip's key comes back as
 * itself; a bare name joins an identity when `rules.nameIds` (withNameIds)
 * has exactly one for it. For text you TYPED, use classifyTypedTag.
 *
 * @param {string} raw tag text, or `facet:value`
 * @param {object} [rules] from compileTagRules (or withNameIds)
 * @param {string} [facet] a name facet the source already knows (performer…)
 * @returns {{key: string, facet: string, value: string}|null}
 */
export function classifyTag(raw, rules = DEFAULT_RULES, facet = null) {
  const resolved = resolveEntry({ raw, facet, keyRef: true }, rules || DEFAULT_RULES);
  return resolved ? { key: resolved.key, facet: resolved.facet, value: resolved.value } : null;
}

/**
 * The key a tag you typed gets, exactly as effectiveTags reads your own tags
 * (library.userTags): a `#` in a performer or studio name becomes `-`, so a
 * typed `performer:Jane#x` never equals an identity key (Stash S1).
 *
 * @param {string} raw what you typed (`facet:value` puts it in that facet)
 * @param {object} [rules] from compileTagRules (or withNameIds)
 * @returns {{key: string, facet: string, value: string}|null}
 */
export function classifyTypedTag(raw, rules = DEFAULT_RULES) {
  const resolved = resolveEntry({ raw, facet: null, source: TAG_SOURCES.USER }, rules || DEFAULT_RULES);
  return resolved ? { key: resolved.key, facet: resolved.facet, value: resolved.value } : null;
}

function resolveEntry(entry, rules, nameIds = rules?.nameIds) {
  let parsed;
  let identity = null;
  if (entry.facet && NAME_FACET_SET.has(entry.facet)) {
    // A name from a record's own field. A `#` in it is never an identity:
    // only the record's `identity` gives one (itemEntry, Stash and
    // stash-box records only).
    const value = IDENTITY_FACET_SET.has(entry.facet) ? nameSlug(entry.raw) : tagSlug(entry.raw);
    if (!value) return null;
    parsed = { facet: entry.facet, value, text: displayForm(entry.raw) };
    if (entry.identity && IDENTITY_FACET_SET.has(entry.facet)) identity = entry.identity;
  } else {
    parsed = parseLoose(entry.raw);
    if (!parsed) return null;
    // A name facet (performer, creator, studio) typed into a tag is yours to
    // give. From another source it is refused: a downloaded funscript's tag
    // `performer:Some Name` must not plant a performer (fix-up 2026-11-17).
    // Their names come from the record's own fields (entry.facet, above).
    if (parsed.facet && NAME_FACET_SET.has(parsed.facet) && entry.source && entry.source !== TAG_SOURCES.USER) return null;
    if (IDENTITY_FACET_SET.has(parsed.facet)) {
      if (entry.keyRef) {
        // A key handed back (a chip, a hide): its identity is kept.
        const parts = splitIdentity(parsed.value);
        if (!parts) return null;
        parsed = { ...parsed, value: parts.name };
        identity = parts.identity;
      } else {
        // Typed text: the `#` guard.
        const value = withoutMark(parsed.value);
        if (!value) return null;
        parsed = { ...parsed, value };
      }
    }
  }
  let resolved = null;
  const own = identity;
  if (identity) {
    // An alias of this identity key (yours, from Settings) wins.
    const target = rules.keyAliases.get(`${parsed.facet}:${parsed.value}${IDENTITY_MARK}${identity}`);
    if (target) {
      resolved = resolveKey(target, rules);
      identity = null;
    }
  }
  if (!resolved) {
    resolved = resolveKey({ facet: parsed.facet, value: parsed.value }, rules);
    if (!IDENTITY_FACET_SET.has(resolved.facet)) identity = null;
    else if (!own) identity = joinedIdentity(nameIds, resolved.facet, resolved.value);
  }
  // The source's own spelling is the label when it still names this tag (no
  // alias or pattern changed it), unless it is a forum TAG, which is a slug
  // (a forum creator is a name and keeps its spelling). Otherwise the
  // canonical value, de-slugged; a length stays as its numbers (the UI adds
  // the translated unit).
  const ownSpelling = entry.source !== TAG_SOURCES.EROSCRIPTS || NAME_FACET_SET.has(parsed.facet);
  let label;
  if (ownSpelling && parsed.value === resolved.value && parsed.text) {
    label = parsed.text;
  } else {
    // sn-tags: a tag Stash names (its aliases on) shows Stash's spelling.
    const stashName = rules.stashNames ? rules.stashNames.get(`${resolved.facet}:${resolved.value}`) : undefined;
    label = stashName || (resolved.facet === 'length' ? resolved.value : deslug(resolved.value));
  }
  const value = identity ? `${resolved.value}${IDENTITY_MARK}${identity}` : resolved.value;
  const out = { key: `${resolved.facet}:${value}`, facet: resolved.facet, value, label };
  if (identity) {
    out.identity = identity;
    if (identity === own && entry.disambiguation) out.disambiguation = entry.disambiguation;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source records → entries
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EroScriptsTagRecord  library.scriptTags[videoPath]
 *   Today (renderer/js/script-tags.js): `{tags: string[], topicId, topicUrl,
 *   source: 'eroscripts', savedAt}`. The plan adds `tags` as `{id, name}`
 *   (ids survive staff renames), `creator`, `title`, `attachment`,
 *   `scriptPath` (the script the post's tags describe), `match`, `fetchedAt`
 *   and `stale` (topic deleted: the tags still count). Both tag shapes are
 *   read. An empty list adds nothing (the posts-only search branch stored
 *   false-empty records; empty means unknown, not "no tags").
 *
 * @typedef {Object} FunscriptTagRecord  scriptMetaCache[funscriptPath]
 *   `{tags: string[], topicTags: string[], performers: string[], creator,
 *   title, topicId, topicUrl, scriptUrl, videoUrl, readAt}`, from
 *   funscriptMetaRecord(). Keyed by the SCRIPT's path: the metadata belongs
 *   to the file, and `options.scriptPath` picks it.
 *
 * @typedef {string[]} UserTagRecord  library.userTags[videoPath]
 *   What you typed. `facet:value` puts a tag in that facet (`performer:Jane
 *   Doe`); anything else goes through the facet table.
 *
 * @typedef {Object} StashTagRecord  the `stash` source, keyed by VIDEO path
 *   Built by renderer/js/stash-tags.js stashTagRecords from Electron main's
 *   stash/library.json (Stash S1): `{tags: [{id, name}], performers: [{id,
 *   name, identity, disambiguation}], studio: {id, name, identity}}`. Plain
 *   strings are read too. `identity` (a Stash ID, or `d-<disambiguation>`)
 *   puts `#<identity>` on the key, so two people of one name stay two tags.
 *   The stash-box record (S2) has the same tags / performers / studio
 *   fields. Markers are chapters, not tags.
 */

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function pick(map, key) {
  if (!map || key == null || key === '') return undefined;
  if (map instanceof Map) return map.get(key);
  if (typeof map !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// A tag item as a source holds it: a string, or `{id, name}` / `{id, slug}`.
// Text that is not well-formed (a lone surrogate) gives no tag (R3R-1).
function itemEntry(source, item, facet = null) {
  if (typeof item === 'number') return { source, raw: item, facet, id: null };
  if (typeof item === 'string') return isWellFormedText(item) ? { source, raw: item, facet, id: null } : null;
  if (item && typeof item === 'object') {
    const raw = item.name ?? item.slug;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    if (typeof raw === 'string' && !isWellFormedText(raw)) return null;
    const id = (typeof item.id === 'string' || typeof item.id === 'number') && item.id !== '' ? item.id : null;
    const entry = { source, raw, facet, id };
    // Stash S1: a Stash (or stash-box) performer or studio carries its
    // identity; from any other source the field is ignored (the `#` guard).
    if (IDENTITY_SOURCES.has(source) && IDENTITY_FACET_SET.has(facet)) {
      const identity = tagIdentity(item.identity);
      if (identity) {
        entry.identity = identity;
        const dis = item.disambiguation;
        if (typeof dis === 'string' && dis.trim() && dis.length <= MAX_META_TEXT && isWellFormedText(dis)) {
          entry.disambiguation = displayForm(dis);
        }
      }
    }
    return entry;
  }
  return null;
}

function samePath(a, b) {
  const canon = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return canon(a) === canon(b);
}

const SOURCE_READERS = {
  user(record) {
    const list = Array.isArray(record) ? record : asList(record?.tags);
    return list.map((item) => itemEntry('user', item));
  },
  stash(record) {
    return namedRecordEntries('stash', record);
  },
  stashbox(record) {
    return namedRecordEntries('stashbox', record);
  },
  funscript(record) {
    if (!record || typeof record !== 'object') return [];
    const entries = [
      ...asList(record.tags).map((item) => itemEntry('funscript', item)),
      ...asList(record.topicTags).map((item) => itemEntry('funscript', item)),
      ...asList(record.performers).map((item) => itemEntry('funscript', item, 'performer')),
    ];
    const creator = record.creator ?? record.author;
    if (creator) entries.push(itemEntry('funscript', creator, 'creator'));
    return entries;
  },
  eroscripts(record, options) {
    if (!record || typeof record !== 'object') return [];
    // A record about another script than the one associated now (a script
    // swap) is ignored, not deleted: it may be right again after an undo.
    // A record naming its script: only when both paths are known.
    if (record.scriptPath && options.scriptPath && !samePath(record.scriptPath, options.scriptPath)) return [];
    // One without (a download before the field, fixup-data 2026-11-18)
    // describes the video's same-name script, the file that download saved
    // (script-tags.js recordScriptPath): with the script known, it counts
    // only while the video uses that file. A caller that knows the video has
    // NO script hands no record (the Tags section, eroscriptsRecordForTags).
    if (!record.scriptPath && options.scriptPath) {
      const saved = sameNameScriptPath(options.videoPath);
      if (!saved || !samePath(saved, options.scriptPath)) return [];
    }
    const entries = asList(record.tags).map((item) => itemEntry('eroscripts', item));
    if (record.creator) entries.push(itemEntry('eroscripts', record.creator, 'creator'));
    return entries;
  },
};

function namedRecordEntries(source, record) {
  if (!record || typeof record !== 'object') return [];
  const entries = [
    ...asList(record.tags).map((item) => itemEntry(source, item)),
    ...asList(record.performers).map((item) => itemEntry(source, item, 'performer')),
  ];
  if (record.studio) entries.push(itemEntry(source, record.studio, 'studio'));
  return entries;
}

/**
 * The tags one source gives one video, as entries for the merge. Exposed for
 * a UI that lists a source on its own ("from EroScripts").
 *
 * @param {string} sourceId one of TAG_SOURCES
 * @param {*} record that source's record for the video
 * @param {{scriptPath?: string}} [options]
 * @returns {{source: string, raw: string|number, facet: string|null, id: string|number|null}[]}
 */
export function sourceEntries(sourceId, record, options = {}) {
  const reader = Object.prototype.hasOwnProperty.call(SOURCE_READERS, sourceId) ? SOURCE_READERS[sourceId] : null;
  if (!reader || record == null) return [];
  return reader(record, options || {}).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

const valueCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareTags(a, b) {
  return (FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet))
    || valueCollator.compare(a.value, b.value)
    || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
}

// The keys a list of hidden tags names. A hidden item is a KEY (the chip's,
// video-tag-edits.js): an identity in it is kept, so hiding one of two
// same-name performers hides that one (Stash S1).
function hiddenKeySet(list, rules, nameIds) {
  const keys = new Set();
  for (const item of asList(list)) {
    const resolved = resolveEntry({ raw: item, facet: null, source: 'user', keyRef: true }, rules, nameIds);
    if (resolved) keys.add(resolved.key);
  }
  return keys;
}

/**
 * Every tag of one video, merged from every source.
 *
 * @param {string} path the video's path
 * @param {Object<string, Object|Map>} sources one map per source id, each
 *   keyed by VIDEO path, except `funscript`, keyed by the script's path:
 *   `{user, stash, stashbox, funscript, eroscripts}`. Any may be missing.
 * @param {Object} [options]
 * @param {string} [options.scriptPath] the video's associated funscript now:
 *   picks the funscript record, and an EroScripts record naming another
 *   script is ignored
 * @param {string[]|Object<string,string[]>} [options.hidden] tags you hid on
 *   this video (a list, or the path-keyed hiddenTags map): they stay hidden
 *   through every re-sync, whichever source gives them
 * @param {string[]} [options.hiddenEverywhere] keys hidden on every video
 *   (tagSettings.hidden), except a tag YOU gave this video: that one shows
 * @param {Object<string,string>} [options.aliases] see compileTagRules
 * @param {Object<string,string>} [options.facetOverrides] see compileTagRules
 * @param {object} [options.rules] a compileTagRules result, reused across
 *   calls (then `aliases` and `facetOverrides` are not read)
 * @param {Map<string,string>|Object<string,string>} [options.nameIds]
 *   `facet:name-slug` -> the one identity the library has for that name
 *   (stash-tags.js nameIdentities): a bare performer or studio name joins
 *   it. Default: `rules.nameIds` (withNameIds), else no join.
 * @returns {{key: string, facet: string, value: string, label: string,
 *   sources: string[], refs: {source: string, id: string|number}[],
 *   identity?: string, disambiguation?: string}[]}
 *   sorted by facet (FACETS order), then value; `identity` (and Stash's
 *   `disambiguation`) only on a performer or studio with an identity
 */
export function effectiveTags(path, sources, options = {}) {
  if (typeof path !== 'string' || !path) return [];
  const opts = options || {};
  const rules = opts.rules || compileTagRules(opts);
  const nameIds = opts.nameIds ?? rules.nameIds ?? null;
  const maps = sources && typeof sources === 'object' ? sources : {};

  const byKey = new Map();
  const readOpts = { ...opts, videoPath: path }; // the EroScripts record's same-name script
  for (const sourceId of SOURCE_ORDER) {
    const recordKey = sourceId === TAG_SOURCES.FUNSCRIPT ? opts.scriptPath : path;
    const record = pick(maps[sourceId], recordKey);
    for (const entry of sourceEntries(sourceId, record, readOpts)) {
      const resolved = resolveEntry(entry, rules, nameIds);
      if (!resolved) continue;
      let tag = byKey.get(resolved.key);
      if (!tag) {
        tag = { key: resolved.key, facet: resolved.facet, value: resolved.value, label: resolved.label, sources: [], refs: [] };
        if (resolved.identity) tag.identity = resolved.identity;
        byKey.set(resolved.key, tag);
      }
      if (resolved.disambiguation && !tag.disambiguation) tag.disambiguation = resolved.disambiguation;
      if (!tag.sources.includes(sourceId)) tag.sources.push(sourceId);
      if (entry.id != null && !tag.refs.some((r) => r.source === sourceId && r.id === entry.id)) {
        tag.refs.push({ source: sourceId, id: entry.id });
      }
    }
  }

  // Hidden on this video: hidden whatever gives it (the writer that adds
  // your own copy clears the hide first, video-tag-edits.js). Hidden on
  // every video: except where you added it to this video yourself (Dave,
  // 2026-11-17: a hidden tag you add again shows again).
  const hiddenHere = hiddenKeySet(Array.isArray(opts.hidden) ? opts.hidden : pick(opts.hidden, path), rules, nameIds);
  const hiddenEverywhere = hiddenKeySet(opts.hiddenEverywhere, rules, nameIds);
  return [...byKey.values()]
    .filter((tag) => !hiddenHere.has(tag.key)
      && !(hiddenEverywhere.has(tag.key) && !tag.sources.includes(TAG_SOURCES.USER)))
    .sort(compareTags);
}

/**
 * effectiveTags for every video of a list, as one index (design (e)): the
 * dialog, the filter, the suggestions and "Make a category" all read it. The
 * caller memoises it per settings version and per library scan.
 *
 * @param {{path: string, funscriptPath?: string|null}[]} videos the library
 *   list; `funscriptPath` is the script associated now (options.scriptPath)
 * @param {Object<string, Object|Map>} sources as effectiveTags
 * @param {Object} [options] as effectiveTags, without scriptPath; `rules` is
 *   compiled once here when not given
 * @returns {Map<string, Array>} path → its tags; a video with none is left out
 */
export function tagIndex(videos, sources, options = {}) {
  const opts = options || {};
  const rules = opts.rules || compileTagRules(opts);
  const index = new Map();
  for (const video of asList(videos)) {
    const path = video?.path;
    if (typeof path !== 'string' || !path || index.has(path)) continue;
    const tags = effectiveTags(path, sources, { ...opts, rules, scriptPath: video.funscriptPath || undefined });
    if (tags.length) index.set(path, tags);
  }
  return index;
}

/**
 * The keys a video's source items read as under `other` rules, for every
 * item that `rules` reads as `key` (sn-fixup, 2026-11-19, SN-R1). With
 * Stash's tag aliases on, a chip can stand for several spellings ("outside"
 * from EroScripts shows as Stash's "Open Air"); `other` = the rules without
 * that layer (compileTagRules' `withoutStash`) gives the keys those
 * spellings have once the layer is gone, so a hide can name them too. The
 * same per-source reading as effectiveTags; no hide is applied.
 *
 * @param {string} path the video's path
 * @param {Object<string, Object|Map>} sources as effectiveTags
 * @param {string} key a key under `rules` (a chip's key)
 * @param {object} rules the rules the key was read with
 * @param {object} other the rules to read the same items with
 * @param {{scriptPath?: string}} [options]
 * @returns {Set<string>} the keys under `other` (may hold `key` itself)
 */
export function sourceKeysUnder(path, sources, key, rules, other, options = {}) {
  const out = new Set();
  if (typeof path !== 'string' || !path || typeof key !== 'string' || !rules || !other) return out;
  const maps = sources && typeof sources === 'object' ? sources : {};
  const opts = options || {};
  const readOpts = { ...opts, videoPath: path };
  for (const sourceId of SOURCE_ORDER) {
    const recordKey = sourceId === TAG_SOURCES.FUNSCRIPT ? opts.scriptPath : path;
    const record = pick(maps[sourceId], recordKey);
    for (const entry of sourceEntries(sourceId, record, readOpts)) {
      if (resolveEntry(entry, rules, rules.nameIds ?? null)?.key !== key) continue;
      const otherKey = resolveEntry(entry, other, other.nameIds ?? null)?.key;
      if (otherKey) out.add(otherKey);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Funscript metadata → the funscript source record
// ---------------------------------------------------------------------------

const TOPIC_HOST = 'discuss.eroscripts.com';
const DIGITS_RE = /^\d{1,15}$/;

/**
 * The topic id of a forum topic URL: /t/<id>, /t/<slug>/<id>, either with a
 * post number after it. Parsed as a URL on the forum's own host only, and a
 * whole number that fits (fix-up 2026-11-17: a pattern matched any host and
 * read /t/123/7 as topic 7). Never fetched.
 */
function topicIdFrom(url) {
  if (typeof url !== 'string' || url.length > MAX_META_URL || !isWellFormedText(url)) return null;
  let parsed;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol) || parsed.hostname.toLowerCase() !== TOPIC_HOST) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] !== 't' || parts.length < 2) return null;
  const raw = DIGITS_RE.test(parts[1]) ? parts[1] : (DIGITS_RE.test(parts[2] || '') ? parts[2] : null);
  const id = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// What one funscript's metadata may put in the record (persisted in the
// script cache later): a file with 200,000 tags or a 5 MB title must not
// bloat config.json. A longer list keeps its first items; a longer string is
// left out, never cut into a different tag.
const MAX_META_LIST = 200;
const MAX_META_TEXT = 200;
const MAX_META_URL = 2048;

// A string that is not well-formed text (a lone surrogate) is unusable, like
// a non-string (R3R-1; script_meta.py _ok_item / _short_text agree).
function stringList(value) {
  const ok = (item) => typeof item === 'string' && item.trim() && item.length <= MAX_META_TEXT && isWellFormedText(item);
  if (typeof value === 'string') return ok(value) ? [value] : [];
  return asList(value).slice(0, 4 * MAX_META_LIST).filter(ok);
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim() && isWellFormedText(value)) return value.trim();
  return null;
}

/** firstString, refusing a string longer than `max`. */
function firstShort(max, ...values) {
  return firstString(...values.filter((v) => typeof v !== 'string' || v.length <= max));
}

/**
 * Build the funscript source record from a parsed file's `metadata` block
 * (plan §2.2): `creator` or `author`; `tags` plus `topic_tags`; `performers`;
 * `script_url` / `topic_url`, and the topic id from a
 * `discuss.eroscripts.com/t/<slug>/<id>` URL in either; `video_url` or
 * `videoSourceUrl`. A file with no metadata, or none of these, gives null
 * (unknown), never an empty record that could read as "no tags".
 *
 * @param {object} metadata the funscript's `metadata` object
 * @param {number} now epoch ms, passed in so callers and tests stay deterministic
 * @returns {FunscriptTagRecord|null}
 */
export function funscriptMetaRecord(metadata, now) {
  if (!isPlainObject(metadata)) return null;
  const tags = [...new Set(stringList(metadata.tags))].slice(0, MAX_META_LIST);
  const topicTags = [...new Set(stringList(metadata.topic_tags))].slice(0, MAX_META_LIST);
  const performers = [...new Set(stringList(metadata.performers))].slice(0, MAX_META_LIST);
  const creator = firstShort(MAX_META_TEXT, metadata.creator, metadata.author, metadata.topic_creator);
  const topicUrl = firstShort(MAX_META_URL, metadata.topic_url);
  const scriptUrl = firstShort(MAX_META_URL, metadata.script_url);
  const videoUrl = firstShort(MAX_META_URL, metadata.video_url, metadata.videoSourceUrl);
  const title = firstShort(MAX_META_TEXT, metadata.title);
  const topicId = topicIdFrom(topicUrl) ?? topicIdFrom(scriptUrl);
  if (!tags.length && !topicTags.length && !performers.length && !creator && topicId == null && !videoUrl) return null;
  return { tags, topicTags, performers, creator, title, topicId, topicUrl, scriptUrl, videoUrl, readAt: now };
}

// ---------------------------------------------------------------------------
// Filtering (mirrored in backend/web-remote/tag-filter.js)
// ---------------------------------------------------------------------------

/** Filter modes. `facets` (the default): every included tag, except the length buckets, which are OR. */
export const FILTER_MODES = Object.freeze(['facets', 'all', 'any']);

function queryKeys(list) {
  const out = [];
  const seen = new Set();
  for (const item of asList(list)) {
    const parsed = parseTagKey(typeof item === 'object' && item ? item.key : item);
    if (!parsed) continue;
    const mark = parsed.facet ? `${parsed.facet}:${parsed.value}` : `:${parsed.value}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    out.push(parsed);
  }
  return out;
}

// Marks a tagKeySet() result: filterByTags reads it as is, without parsing.
const KEY_SET = Symbol('tagKeySet');

/**
 * One video's tags parsed for filterByTags, once (r3-fixup R3R-6): pass a
 * Map path -> tagKeySet(list) as `tagsByPath` and a filter pass compares
 * set members instead of folding and slugging every key of every video
 * again. The same answer as passing the list itself.
 *
 * @param {Array} list keys, or effectiveTags objects
 * @returns {{keys: Set<string>, values: Set<string>}}
 */
export function tagKeySet(list) {
  const keys = new Set();
  const values = new Set();
  for (const item of asList(list)) {
    const parsed = parseTagKey(typeof item === 'object' && item ? item.key : item);
    if (!parsed) continue;
    if (parsed.facet) keys.add(`${parsed.facet}:${parsed.value}`);
    values.add(parsed.value);
  }
  return Object.freeze({ keys, values, [KEY_SET]: true });
}

function videoTagSet(video, tagsByPath) {
  const path = video?.path;
  let list;
  if (tagsByPath instanceof Map) list = tagsByPath.get(path);
  else if (tagsByPath && typeof tagsByPath === 'object') list = pick(tagsByPath, path);
  else list = video?.tags;
  if (list && list[KEY_SET] === true) return list;
  const keys = new Set();
  const values = new Set();
  for (const item of asList(list)) {
    const parsed = parseTagKey(typeof item === 'object' && item ? item.key : item);
    if (!parsed) continue;
    if (parsed.facet) keys.add(`${parsed.facet}:${parsed.value}`);
    values.add(parsed.value);
  }
  return { keys, values };
}

function hasTag(query, have) {
  return query.facet ? have.keys.has(`${query.facet}:${query.value}`) : have.values.has(query.value);
}

/**
 * Keep the videos whose tags match.
 *
 * - `include`: keys a video must have. In the default `facets` mode a video
 *   needs EVERY included key, except the length buckets, where one is enough
 *   (a video has one length; Dave 2026-11-22: tags were OR within a facet, so
 *   "asian" and another tag showed videos with either); `all` needs every
 *   key, `any` one of them. Empty: no include filter.
 * - `exclude`: a video with any of these keys is dropped (the forum's
 *   `-tags:`). Supported from day one; the first UI may only include.
 * - A key without a known facet (`the-handy`) matches that value in any facet.
 * - A video with no tags (no record from any source) matches no include and
 *   no exclude: the filter can narrow a list, never change what is stored.
 * - Order is kept. Run it BEFORE dedupeByName (library-search.js): tags are
 *   stored per path, so a copy that dedupe would drop may hold the tags.
 *
 * @param {{path: string, tags?: Array}[]} videos
 * @param {{include?: string[], exclude?: string[], mode?: string}} [query]
 * @param {Map<string, Array>|Object<string, Array>} [tagsByPath] per path a
 *   list of keys or of effectiveTags objects; without it, `video.tags`
 * @returns {Array} the matching videos (the same objects), as a new array
 */
export function filterByTags(videos, query = {}, tagsByPath = undefined) {
  if (!Array.isArray(videos)) return [];
  const include = queryKeys(query?.include);
  const exclude = queryKeys(query?.exclude);
  if (!include.length && !exclude.length) return videos.slice();
  const mode = FILTER_MODES.includes(query?.mode) ? query.mode : 'facets';

  // Every ticked tag must be on the video (Dave 2026-11-22: "only show
  // videos with both"), except the length buckets: a video has one length,
  // so two ticked lengths mean either. Change both copies together
  // (renderer/js/video-tags.js and backend/web-remote/tag-filter.js).
  const groups = new Map();
  for (const q of include) {
    const group = q.facet === 'length' ? 'length' : (q.facet ? `${q.facet}:${q.value}` : `:${q.value}`);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(q);
  }

  return videos.filter((video) => {
    if (!video || typeof video !== 'object') return false;
    const have = videoTagSet(video, tagsByPath);
    if (exclude.some((q) => hasTag(q, have))) return false;
    if (!include.length) return true;
    if (mode === 'any') return include.some((q) => hasTag(q, have));
    if (mode === 'all') return include.every((q) => hasTag(q, have));
    for (const list of groups.values()) {
      if (!list.some((q) => hasTag(q, have))) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
