// Phone-side copy of the tag filter in renderer/js/video-tags.js
// (filterByTags and the key normalisation it needs). The phone cannot import
// from renderer/, so the code is copied, not shared.
//
// WIRED (Round 3, 2026-11-18): the phone's filter sheet has a Tags section
// (app.js applyMatchedVrFilters). The desktop sends each video's merged tag
// keys (the `videoTags` slice, renderer/js/remote-tag-slice.js, through
// /api/media/register and GET /api/remote/tags; PLAN-next-major-2026-11.md
// §2.6), and the phone filters on them with this. There is no merge logic
// here on purpose: the desktop computes effective tags once, the phone only
// filters.
//
// Stash's tag aliases and sub-tags (sn-tags, 2026-11-19; the desktop's
// opt-in "Use Stash's tag aliases and sub-tags") need nothing here either:
// the aliases are already in the keys the desktop sends, and each video's
// list also carries its implied parent tags (renderer/js/library-tag-filter.js
// impliedTags), so picking a parent finds the videos with any of its
// sub-tags here exactly as on the desktop. The parity fixture's `subTags`
// block pins both sides.
//
// Keep this module in step with the desktop copy:
// tests/unit/tag-filter-parity.test.js runs BOTH on
// tests/fixtures/tag-filter-parity.json and fails when they disagree on any
// query.
//
// Pure: no DOM, no fetch, no module state.

/** The facet ids, as renderer/js/video-tags.js FACETS. */
export const FACET_IDS = Object.freeze([
  'vr', 'display', 'length', 'device', 'axis', 'script-type', 'sexuality', 'threesome',
  'content', 'performer', 'creator', 'studio',
]);

/** Filter modes. `facets`: OR within a facet, AND across facets (the default). */
export const FILTER_MODES = Object.freeze(['facets', 'all', 'any']);

const FACET_SET = new Set(FACET_IDS);
const COMBINING_RE = /[\u0300-\u036f]/g; // the combining diacritical marks

export function foldForMatch(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text)
    .normalize('NFKD').replace(COMBINING_RE, '').normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function tagSlug(text) {
  return foldForMatch(text)
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseTagKey(key) {
  if (typeof key !== 'string' && typeof key !== 'number') return null;
  const text = String(key);
  const colon = text.indexOf(':');
  if (colon > 0) {
    // Folded as the value is (as the desktop's, fix-up 2026-11-17).
    const facet = tagSlug(text.slice(0, colon));
    if (FACET_SET.has(facet)) {
      const value = tagSlug(text.slice(colon + 1));
      return value ? { facet, value } : null;
    }
  }
  const value = tagSlug(text);
  return value ? { facet: null, value } : null;
}

export function normalizeTagKey(key) {
  const parsed = parseTagKey(key);
  if (!parsed) return '';
  return parsed.facet ? `${parsed.facet}:${parsed.value}` : parsed.value;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

// The desktop's pick(), verbatim: a video with no path (missing, null or '')
// has no entry, whatever the map holds under 'undefined', 'null' or ''.
function pick(map, key) {
  if (!map || key == null || key === '') return undefined;
  if (map instanceof Map) return map.get(key);
  if (typeof map !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

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

function videoTagSet(video, tagsByPath) {
  const path = video?.path;
  let list;
  if (tagsByPath instanceof Map) list = tagsByPath.get(path);
  else if (tagsByPath && typeof tagsByPath === 'object') list = pick(tagsByPath, path);
  else list = video?.tags;
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
 * Keep the videos whose tags match. Same contract as the desktop's
 * filterByTags: `include` (OR within a facet, AND across facets by default;
 * `mode: 'all'` / `'any'`), `exclude` drops a video with any of its keys, a
 * key with no known facet matches that value in any facet, a video with no
 * tags matches no include and no exclude, order kept.
 *
 * @param {{path: string, tags?: Array}[]} videos
 * @param {{include?: string[], exclude?: string[], mode?: string}} [query]
 * @param {Map<string, Array>|Object<string, Array>} [tagsByPath]
 * @returns {Array}
 */
export function filterByTags(videos, query = {}, tagsByPath = undefined) {
  if (!Array.isArray(videos)) return [];
  const include = queryKeys(query?.include);
  const exclude = queryKeys(query?.exclude);
  if (!include.length && !exclude.length) return videos.slice();
  const mode = FILTER_MODES.includes(query?.mode) ? query.mode : 'facets';

  const groups = new Map();
  for (const q of include) {
    const group = q.facet || '';
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
