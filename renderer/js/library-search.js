// LibrarySearch — Fuzzy search, sort, and filter for library video lists
// Pure functions, no side effects, no DOM dependencies

/**
 * @typedef {Object} VideoEntry
 * @property {string} name — filename
 * @property {string} path — full file path
 * @property {boolean} hasFunscript — whether a funscript is associated
 * @property {string} [funscriptPath] — path to associated funscript
 * @property {number} [duration] — video duration in seconds (if known)
 * @property {number} [lastPlayed] — timestamp of last playback (if tracked)
 */

const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
const SEPARATOR_RE = /[._\-\[\]()\/\\&+]/g;

/**
 * Token-based fuzzy search across video names. The query is split on
 * whitespace; every token must match (in any order). Separators
 * (`.`, `_`, `-`, brackets, etc.) are flattened to spaces so
 * "my video title" matches "My.Video.Title.mp4".
 *
 * Match tiers (lower score = better, top of results):
 *   -100  — exact filename match incl. extension
 *   -50   — exact filename match minus media extension
 *    0..N — name fuzzy score (prefix 0, word-bound 0.5, substring 1, fuzzy 2+)
 *    +10  — path-only hit (e.g. typing a studio/folder name)
 *    +20  — context-only hit (collection/category name)
 *
 * @param {VideoEntry[]} videos
 * @param {string} query
 * @param {{ searchPaths?: boolean, contextMap?: Map<string,string[]>|Object<string,string[]> }} [options]
 * @returns {VideoEntry[]} filtered, ranked results
 */
export function fuzzySearch(videos, query, options = {}) {
  if (!videos || videos.length === 0) return [];
  if (!query || query.trim() === '') return videos;

  const normQuery = _normalize(query);
  if (!normQuery) return videos;
  const tokens = normQuery.split(' ').filter(Boolean);
  if (tokens.length === 0) return videos;

  const searchPaths = options.searchPaths !== false;
  const contextMap = options.contextMap || null;

  const results = [];
  for (const video of videos) {
    const normName = _normalize(video.name || '');

    // Tier 0: exact title match (with or without media extension).
    if (normName === normQuery) { results.push({ video, score: -100 }); continue; }
    if (_stripMediaExt(normName) === normQuery) { results.push({ video, score: -50 }); continue; }

    // Tier 1: name fuzzy score.
    const nameScore = _scoreAll(normName, normQuery, tokens);
    if (nameScore >= 0) { results.push({ video, score: nameScore }); continue; }

    // Tier 2: path-only hit — user typed studio/folder name.
    // Penalty keeps name matches above path-only matches.
    if (searchPaths && video.path) {
      const pathScore = _scoreAll(_normalize(video.path), normQuery, tokens);
      if (pathScore >= 0) { results.push({ video, score: pathScore + 10 }); continue; }
    }

    // Tier 3: context strings (collection / category names). Weakest match.
    if (contextMap) {
      const ctxList = typeof contextMap.get === 'function'
        ? contextMap.get(video.path)
        : contextMap[video.path];
      if (ctxList && ctxList.length) {
        let best = Infinity;
        for (const s of ctxList) {
          const ns = _normalize(s);
          if (!ns) continue;
          const cs = _scoreAll(ns, normQuery, tokens);
          if (cs >= 0 && cs < best) best = cs;
        }
        if (Number.isFinite(best)) results.push({ video, score: best + 20 });
      }
    }
  }

  results.sort((a, b) => a.score - b.score || (a.video.name || '').localeCompare(b.video.name || ''));
  return results.map(r => r.video);
}

// After normalization "foo.mp4" becomes "foo mp4". Trim the trailing media
// extension token so exact-title match works whether or not the user typed it.
const _MEDIA_EXT_RE = / (mp4|mkv|webm|avi|mov|wmv|flv|m4v|mpg|mpeg|ts|m3u8|funscript)$/;
function _stripMediaExt(normName) {
  return normName.replace(_MEDIA_EXT_RE, '');
}

// Normalize for matching: lowercase, strip diacritics, flatten separators
// to spaces, collapse runs.
function _normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(DIACRITICS_RE, '')
    .replace(SEPARATOR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _scoreAll(name, fullQuery, tokens) {
  if (name === fullQuery) return 0;
  if (name.includes(fullQuery)) return tokens.length * 0.4;

  let total = 0;
  for (const tok of tokens) {
    const s = _scoreToken(name, tok);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

function _scoreToken(name, token) {
  if (!token) return 0;
  const idx = name.indexOf(token);
  if (idx === 0) return 0;
  if (idx > 0) return name[idx - 1] === ' ' ? 0.5 : 1;

  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let ni = 0; ni < name.length && qi < token.length; ni++) {
    if (name[ni] === token[qi]) {
      if (last >= 0) gaps += ni - last - 1;
      last = ni;
      qi++;
    }
  }
  if (qi < token.length) return -1;
  return 2 + Math.min(gaps, 100) * 0.05;
}

/**
 * Compute average and max speed from a funscript actions array.
 * Follows the OFS/funscript-utils standard:
 *   speed = |deltaPos| / deltaTime (units per second, pos range 0-100)
 * Average excludes zero-movement pairs (same position consecutive actions)
 * to avoid skewing from pauses/holds.
 *
 * Reference values: Handy max ~432 units/s, Launch max ~377 units/s.
 *
 * @param {Array<{at: number, pos: number}>} actions
 * @returns {{avgSpeed: number, maxSpeed: number}} speeds in units/sec
 */
export function computeSpeedStats(actions) {
  if (!actions || actions.length < 2) return { avgSpeed: 0, maxSpeed: 0 };

  let totalSpeed = 0;
  let maxSpeed = 0;
  let count = 0;

  for (let i = 1; i < actions.length; i++) {
    const dt = actions[i].at - actions[i - 1].at;
    if (dt <= 0) continue;
    const dp = Math.abs(actions[i].pos - actions[i - 1].pos);
    if (dp === 0) continue; // Skip zero-movement pairs (pauses/holds)
    const speed = (dp / dt) * 1000; // units/sec
    totalSpeed += speed;
    if (speed > maxSpeed) maxSpeed = speed;
    count++;
  }

  return {
    avgSpeed: count > 0 ? Math.round(totalSpeed / count) : 0,
    maxSpeed: Math.round(maxSpeed),
  };
}

/**
 * Sort videos by a given criterion.
 *
 * @param {VideoEntry[]} videos — list to sort (not mutated)
 * @param {'name'|'duration'|'avgSpeed'|'maxSpeed'|'hasFunscript'} sortBy — sort criterion
 * @param {'asc'|'desc'} [order='asc'] — sort direction
 * @returns {VideoEntry[]} sorted copy
 */
export function sortVideos(videos, sortBy, order = 'asc') {
  if (!videos || videos.length === 0) return [];

  const sorted = [...videos];
  const dir = order === 'desc' ? -1 : 1;

  switch (sortBy) {
    case 'name':
      sorted.sort((a, b) => dir * (a.name || '').localeCompare(b.name || ''));
      break;

    case 'duration':
      sorted.sort((a, b) => dir * ((a.duration || 0) - (b.duration || 0)));
      break;

    case 'avgSpeed':
      sorted.sort((a, b) => dir * ((a.avgSpeed || 0) - (b.avgSpeed || 0)));
      break;

    case 'maxSpeed':
      sorted.sort((a, b) => dir * ((a.maxSpeed || 0) - (b.maxSpeed || 0)));
      break;

    case 'lastPlayed':
      sorted.sort((a, b) => -dir * ((a.lastPlayed || 0) - (b.lastPlayed || 0)));
      break;

    case 'dateAdded':
      // Standard timestamp semantics: asc = oldest first, desc = newest
      // first. Backed by `fs.stat` mtimeMs from the scan. Missing values
      // (stat failed) default to 0 → sort to the "oldest" end.
      sorted.sort((a, b) => dir * ((a.dateAdded || 0) - (b.dateAdded || 0)));
      break;

    case 'hasFunscript':
      // Funscript videos first
      sorted.sort((a, b) => {
        const aVal = a.hasFunscript ? 1 : 0;
        const bVal = b.hasFunscript ? 1 : 0;
        return -dir * (aVal - bVal) || (a.name || '').localeCompare(b.name || '');
      });
      break;

    default:
      // No sort — return copy as-is
      break;
  }

  return sorted;
}

/**
 * Filter videos by one or more criteria.
 *
 * @param {VideoEntry[]} videos — list to filter
 * @param {Object} filters — filter criteria
 * @param {boolean} [filters.hasFunscript] — only videos with funscript
 * @param {string} [filters.inPlaylist] — playlist ID — requires playlistVideos set
 * @param {string} [filters.inCategory] — category ID — requires videoCategoryMap
 * @param {Set<string>} [filters.playlistVideos] — set of video paths in the playlist
 * @param {Object<string, string[]>} [filters.videoCategoryMap] — videoPath → [categoryId]
 * @returns {VideoEntry[]} filtered results
 */
export function filterVideos(videos, filters = {}) {
  if (!videos || videos.length === 0) return [];

  return videos.filter(video => {
    if (filters.hasFunscript && !video.hasFunscript) return false;

    if (filters.inPlaylist && filters.playlistVideos) {
      if (!filters.playlistVideos.has(video.path)) return false;
    }

    if (filters.inCategory && filters.videoCategoryMap) {
      const cats = filters.videoCategoryMap[video.path];
      if (!cats || !cats.includes(filters.inCategory)) return false;
    }

    return true;
  });
}
