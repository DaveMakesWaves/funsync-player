// Phone-side port of renderer/js/library-search.js
// Only fuzzySearch + sortVideos are needed for v1.1 — no speed stats, no
// collection/category filtering.
//
// Keep this module in sync with the desktop version: if you change matching
// behaviour in one, port to the other.

const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
const SEPARATOR_RE = /[._\-\[\]()\/\\&+]/g;

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

    if (normName === normQuery) { results.push({ video, score: -100 }); continue; }
    if (_stripMediaExt(normName) === normQuery) { results.push({ video, score: -50 }); continue; }

    const nameScore = _scoreAll(normName, normQuery, tokens);
    if (nameScore >= 0) { results.push({ video, score: nameScore }); continue; }

    if (searchPaths && video.path) {
      const pathScore = _scoreAll(_normalize(video.path), normQuery, tokens);
      if (pathScore >= 0) { results.push({ video, score: pathScore + 10 }); continue; }
    }

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

const _MEDIA_EXT_RE = / (mp4|mkv|webm|avi|mov|wmv|flv|m4v|mpg|mpeg|ts|m3u8|funscript)$/;
function _stripMediaExt(normName) {
  return normName.replace(_MEDIA_EXT_RE, '');
}

// Normalize for matching: lowercase, strip diacritics, flatten separators
// (., _, -, [], (), /, \, &, +) to spaces, collapse runs.
// This is why "my video title" now matches "My.Video.Title.mp4".
function _normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(DIACRITICS_RE, '')
    .replace(SEPARATOR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Score = sum of per-token scores. Every token must match somewhere (any
// order) for the video to be included. Lower score = better.
function _scoreAll(name, fullQuery, tokens) {
  if (name === fullQuery) return 0;                              // exact normalized match
  if (name.includes(fullQuery)) return tokens.length * 0.4;      // whole query substring

  let total = 0;
  for (const tok of tokens) {
    const s = _scoreToken(name, tok);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

// Per-token scoring:
//   0    — prefix of name ("alpha" in "alpha video")
//   0.5  — word-boundary substring ("video" in "alpha video")
//   1    — substring anywhere (mid-word)
//   2+   — fuzzy in-order char match, penalty scaled by gap size
//   -1   — no match
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
    case 'dateAdded':
      // asc = oldest first, desc = newest first. `dateAdded` comes from
      // the desktop scan's `fs.stat().mtimeMs` and is forwarded by the
      // backend's /api/remote/videos endpoint. Missing values default to
      // 0 (sort to the oldest end).
      sorted.sort((a, b) => dir * ((a.dateAdded || 0) - (b.dateAdded || 0)));
      break;
    default:
      break;
  }
  return sorted;
}
