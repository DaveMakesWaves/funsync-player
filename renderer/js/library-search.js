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

/**
 * Fuzzy search across video names. Matches if all query characters appear
 * in order within the name (case-insensitive). Results are sorted by match quality.
 *
 * @param {VideoEntry[]} videos — list of videos to search
 * @param {string} query — search query
 * @returns {VideoEntry[]} filtered and sorted results
 */
export function fuzzySearch(videos, query) {
  if (!videos || videos.length === 0) return [];
  if (!query || query.trim() === '') return videos;

  const q = query.toLowerCase().trim();
  const results = [];

  for (const video of videos) {
    const name = (video.name || '').toLowerCase();
    const score = _fuzzyScore(name, q);
    if (score >= 0) {
      results.push({ video, score });
    }
  }

  // Sort by score (lower = better match), then alphabetically
  results.sort((a, b) => a.score - b.score || a.video.name.localeCompare(b.video.name));

  return results.map(r => r.video);
}

/**
 * Score a fuzzy match. Returns -1 if no match.
 * Lower score = better match. Exact match = 0, substring = 1, fuzzy = distance-based.
 * @param {string} name — lowercase name
 * @param {string} query — lowercase query
 * @returns {number} match score (-1 = no match)
 */
function _fuzzyScore(name, query) {
  // Exact match
  if (name === query) return 0;

  // Substring match
  if (name.includes(query)) return 1;

  // Fuzzy: all query chars must appear in order
  let qi = 0;
  let gaps = 0;
  let lastMatchIdx = -1;

  for (let ni = 0; ni < name.length && qi < query.length; ni++) {
    if (name[ni] === query[qi]) {
      if (lastMatchIdx >= 0) {
        gaps += ni - lastMatchIdx - 1;
      }
      lastMatchIdx = ni;
      qi++;
    }
  }

  if (qi < query.length) return -1; // Not all chars matched

  return 2 + gaps; // Base score 2 + penalty for gaps
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
