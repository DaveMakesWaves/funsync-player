// Folder-tree index for the web-remote "Browse by Folder" view.
//
// Direct port of renderer/js/folder-index.js (plus the one helper it
// imported from path-utils.js). Kept as a pure module so it stays easy
// to test and mirror against the desktop version — if you change one,
// port to the other.

/**
 * Normalise a filesystem path for comparison:
 *   - Drop trailing slashes
 *   - Lowercase Windows drive letters
 *   - Convert backslashes to forward slashes
 */
export function canonicalPath(p) {
  if (!p) return '';
  let out = String(p).replace(/\\/g, '/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out;
}

/**
 * @typedef FolderNode
 * @property {string} path
 * @property {string} label
 * @property {string|null} parent
 * @property {Set<string>} childFolders
 * @property {Array<object>} videos
 * @property {boolean} isSourceRoot
 * @property {string|null} sourceId
 */

/**
 * @param {Array<{path: string, name?: string}>} videos
 * @param {Array<{id: string, name: string, path: string, enabled?: boolean}>} sources
 * @returns {Map<string, FolderNode>}
 */
export function buildFolderIndex(videos, sources) {
  const index = new Map();
  const sourceByCanonical = new Map();

  const ensure = (canonical, seed = {}) => {
    let node = index.get(canonical);
    if (!node) {
      node = {
        path: canonical,
        label: canonical.split('/').pop() || canonical,
        parent: null,
        childFolders: new Set(),
        videos: [],
        isSourceRoot: false,
        sourceId: null,
        ...seed,
      };
      index.set(canonical, node);
    } else if (seed) {
      Object.assign(node, seed);
    }
    return node;
  };

  // Seed an entry for every enabled source so empty sources still appear.
  for (const src of sources || []) {
    if (src.enabled === false) continue;
    const canonical = canonicalPath(src.path);
    sourceByCanonical.set(canonical, src);
    ensure(canonical, {
      label: src.name || canonical.split('/').pop() || canonical,
      isSourceRoot: true,
      sourceId: src.id,
      parent: null,
    });
  }

  // Place each video, walking parents up to (and including) its source root.
  for (const video of videos || []) {
    if (!video?.path) continue;

    const videoPath = canonicalPath(video.path);
    const lastSlash = videoPath.lastIndexOf('/');
    if (lastSlash < 0) continue;
    const dir = videoPath.slice(0, lastSlash) || '/';

    // Longest matching source prefix wins (nested-source case).
    let owningCanonical = null;
    for (const [canonical] of sourceByCanonical) {
      if (videoPath.startsWith(canonical + '/') &&
          (!owningCanonical || canonical.length > owningCanonical.length)) {
        owningCanonical = canonical;
      }
    }
    // Video not owned by any source (manual drag-and-drop? rogue entry?) —
    // skip so the tree stays consistent.
    if (!owningCanonical) continue;

    const leaf = ensure(dir);
    leaf.videos.push(video);

    // Walk up to the owning source root, wiring parent relationships.
    let current = dir;
    while (current !== owningCanonical) {
      const parentSlash = current.lastIndexOf('/');
      if (parentSlash <= 0) break;
      const parent = current.slice(0, parentSlash);
      const parentNode = ensure(parent);
      parentNode.childFolders.add(current);
      index.get(current).parent = parent;
      if (parent === owningCanonical) break;
      current = parent;
    }
  }

  return index;
}

/** Every video under `folderPath` or its descendants. */
export function descendantsOf(index, folderPath) {
  const node = index.get(folderPath);
  if (!node) return [];
  const out = [...node.videos];
  const stack = [...node.childFolders];
  while (stack.length) {
    const childPath = stack.pop();
    const child = index.get(childPath);
    if (!child) continue;
    for (const v of child.videos) out.push(v);
    for (const sub of child.childFolders) stack.push(sub);
  }
  return out;
}

/**
 * Longest folder path shared by every file in `filePaths`. Takes file
 * paths (not directories) and drops the filename segment before comparing.
 * Used by mobile collection detail to show "this collection lives in X"
 * so users can jump into folder-browse at that location.
 *
 * Port of renderer/js/path-utils.js::commonAncestorOfFiles — kept here
 * to avoid adding another module file.
 */
export function commonAncestorOfFiles(filePaths) {
  if (!filePaths || filePaths.length === 0) return '';
  const dirs = filePaths
    .map(p => canonicalPath(p))
    .filter(Boolean)
    .map(p => {
      const idx = p.lastIndexOf('/');
      return idx > 0 ? p.slice(0, idx) : p;
    });
  if (dirs.length === 0) return '';
  if (dirs.length === 1) return dirs[0];

  const parts = dirs.map(d => d.split('/'));
  const minLen = Math.min(...parts.map(p => p.length));
  const common = [];
  for (let i = 0; i < minLen; i++) {
    const seg = parts[0][i];
    if (parts.every(p => p[i] === seg)) common.push(seg);
    else break;
  }
  return common.join('/');
}

/** Source-root → folderPath trail as [{path, label}, ...]. */
export function breadcrumbOf(index, folderPath) {
  if (!folderPath) return [];
  const trail = [];
  let cursor = folderPath;
  while (cursor) {
    const node = index.get(cursor);
    if (!node) break;
    trail.unshift({ path: cursor, label: node.label });
    cursor = node.parent;
  }
  return trail;
}
