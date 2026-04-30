// search-context — Inverts the web-remote's collections / playlists /
// categories shape into a `Map<videoPath, string[]>` suitable for
// passing to library-search.js's `fuzzySearch` as `contextMap`.
//
// Without this, the mobile fuzzy search only matches video name + path
// — it can't find a video by the name of a collection / playlist /
// category the user has put it in. The desktop has the same map (built
// in library.js::_buildSearchContextMap from settings); this module is
// the mobile-side equivalent that builds it from the API responses.
//
// Pure function — no DOM, no fetch — so it's directly unit-testable.

/**
 * @typedef {Object} VideoEntry
 * @property {string} id
 * @property {string} path
 *
 * @typedef {Object} GroupingEntry
 * @property {string} name
 * @property {string[]} [videoIds]  // may be missing on legacy responses
 *
 * @param {VideoEntry[]|null|undefined} library
 * @param {GroupingEntry[]|null|undefined} collections
 * @param {GroupingEntry[]|null|undefined} playlists
 * @param {GroupingEntry[]|null|undefined} categories
 * @returns {Map<string, string[]>} videoPath → list of grouping names
 */
export function buildContextMapFromGroupings(library, collections, playlists, categories) {
  const idToPath = new Map();
  for (const v of (library || [])) {
    if (v?.id && v.path) idToPath.set(v.id, v.path);
  }
  const map = new Map();
  const add = (path, label) => {
    if (!path || !label) return;
    const list = map.get(path);
    if (list) list.push(label);
    else map.set(path, [label]);
  };
  for (const g of [...(collections || []), ...(playlists || []), ...(categories || [])]) {
    if (!g?.name) continue;
    for (const id of (g.videoIds || [])) {
      const p = idToPath.get(id);
      if (p) add(p, g.name);
    }
  }
  return map;
}
