// Phone-side port of renderer/js/library-search.js
// Only fuzzySearch + sortVideos are needed for v1.1 — no speed stats, no
// collection/category filtering.
//
// Keep this module in sync with the desktop version: if you change matching
// behaviour in one, port to the other.

const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
const SEPARATOR_RE = /[._\-\[\]()\/\\&+]/g;

// The desktop's name comparator (renderer/js/library-search.js
// compareNames), copied because the phone cannot import from renderer/.
// Natural numbers ("Clip 2" before "Clip 10"), case ignored, and forced 'en'
// collation so the phone's own locale never reorders the list. Bare
// localeCompare put "Clip 10" before "Clip 2" here while the desktop did the
// opposite (CB-24). web-remote-natural-sort.test.js runs both copies on the
// same names.
const naturalSortCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

export function compareNames(a, b) {
  return naturalSortCollator.compare(a || '', b || '');
}

// Name A-Z's key for a VIDEO, copied from the desktop's videoNameKey /
// compareVideoNames (R3-28): the name WITHOUT its extension, then the
// extension, then the path, like Windows Explorer ("Alpha Scene" before
// "Alpha Scene (copy)"). This side's `name` from /api/remote/videos has no
// extension and the desktop's has one, so the extension comes from `path`:
// both sides sort on the same key. Before, the desktop sorted "Alpha Scene
// (copy).mp4" first and the phone "Alpha Scene" first.
// web-remote-natural-sort.test.js feeds each side the objects it really sorts.
export function videoNameKey(video) {
  const name = String(video?.name ?? '');
  const file = String(video?.path ?? '').split(/[\\/]/).pop() || name;
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot + 1) : '';
  const stem = ext && name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
    ? name.slice(0, name.length - ext.length - 1)
    : name;
  return { stem, ext };
}

export function compareVideoNames(a, b) {
  const ka = videoNameKey(a);
  const kb = videoNameKey(b);
  return compareNames(ka.stem, kb.stem)
    || compareNames(ka.ext, kb.ext)
    || compareNames(a?.path, b?.path);
}

// The in-order "fuzzy" fallback applies to the NAME only. Path and context
// hits must contain each token as written: a subsequence of a long path
// matches nearly any short query (app test V35). With `pathRoots` (the
// library's source folders) the path is scored from the source folder's
// own name down, so the folders above it never match anything.
export function fuzzySearch(videos, query, options = {}) {
  if (!videos || videos.length === 0) return [];
  if (!query || query.trim() === '') return videos;

  const normQuery = _normalize(query);
  if (!normQuery) return videos;
  const tokens = normQuery.split(' ').filter(Boolean);
  if (tokens.length === 0) return videos;

  const searchPaths = options.searchPaths !== false;
  const contextMap = options.contextMap || null;
  const pathRoots = _prepareRoots(options.pathRoots);

  const results = [];
  for (const video of videos) {
    const normName = _normalize(video.name || '');

    if (normName === normQuery) { results.push({ video, score: -100 }); continue; }
    if (_stripMediaExt(normName) === normQuery) { results.push({ video, score: -50 }); continue; }

    const nameScore = _scoreAll(normName, normQuery, tokens);
    if (nameScore >= 0) { results.push({ video, score: nameScore }); continue; }

    if (searchPaths && video.path) {
      const pathScore = _scoreAll(_normalize(_pathFromRoot(video.path, pathRoots)), normQuery, tokens, false);
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
          const cs = _scoreAll(ns, normQuery, tokens, false);
          if (cs >= 0 && cs < best) best = cs;
        }
        if (Number.isFinite(best)) results.push({ video, score: best + 20 });
      }
    }
  }

  results.sort((a, b) => a.score - b.score || compareVideoNames(a.video, b.video));
  return results.map(r => r.video);
}

// The older formats the library lists since 2026-11-26 too (S031): kept, a
// title typed in full lost to the same words in another order.
const _MEDIA_EXT_RE = / (mp4|mkv|webm|avi|mov|wmv|asf|flv|f4v|m4v|mpg|mpeg|vob|ts|m2ts|mts|3gp|3g2|ogv|divx|m3u8|funscript)$/;
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

// Source roots, canonicalised once per search: forward slashes, no trailing
// slash, lowercase. Longest first, so a source nested inside another source
// is cut at its own folder.
function _prepareRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) return [];
  const out = [];
  for (const r of roots) {
    if (!r) continue;
    const c = String(r).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.length - a.length);
}

// The part of `path` a path search may match: from the source folder's own
// name down ("library/Studio/clip.mp4" for a source at C:/.../library).
// A path under no known root is used whole.
function _pathFromRoot(path, roots) {
  if (roots.length === 0) return path;
  const p = String(path).replace(/\\/g, '/').toLowerCase();
  for (const r of roots) {
    if (p.startsWith(r + '/')) {
      const cut = r.lastIndexOf('/');
      return cut >= 0 ? p.slice(cut + 1) : p;
    }
  }
  return path;
}

// Score = sum of per-token scores. Every token must match somewhere (any
// order) for the video to be included. Lower score = better.
// `fuzzy: false` = every token must appear as written (path and context
// tiers); the in-order subsequence fallback is for names only.
function _scoreAll(name, fullQuery, tokens, fuzzy = true) {
  if (name === fullQuery) return 0;                              // exact normalized match
  if (name.includes(fullQuery)) return tokens.length * 0.4;      // whole query substring

  let total = 0;
  for (const tok of tokens) {
    const s = _scoreToken(name, tok, fuzzy);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

// Per-token scoring:
//   0    — prefix of name ("alpha" in "alpha video")
//   0.5  — word-boundary substring ("video" in "alpha video")
//   1    — substring anywhere (mid-word)
//   2+   — fuzzy in-order char match, penalty scaled by gap size (names only)
//   -1   — no match
function _scoreToken(name, token, fuzzy = true) {
  if (!token) return 0;
  const idx = name.indexOf(token);
  if (idx === 0) return 0;
  if (idx > 0) return name[idx - 1] === ' ' ? 0.5 : 1;
  if (!fuzzy) return -1;

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
      sorted.sort((a, b) => dir * compareVideoNames(a, b));
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
