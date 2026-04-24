// Folder-tree index for the library's "Browse by Folder" view.
// Pure functions operating on the flat `_videos` array produced by scanning.
// Built once per scan; `descendantsOf()` pre-flattens each folder's video
// list so filter passes (search / VR / matched-tab) stay O(filter * N) per
// current folder rather than re-walking the tree.

import { canonicalPath } from './path-utils.js';

/**
 * @typedef FolderNode
 * @property {string} path         canonicalised path (the key)
 * @property {string} label        display label (source name at the root, basename otherwise)
 * @property {string|null} parent  canonical parent path, or null for source roots
 * @property {Set<string>} childFolders  canonical child paths
 * @property {Array<object>} videos     videos located directly in this folder
 * @property {boolean} isSourceRoot true when this folder is the top-level of a source
 * @property {string|null} sourceId one of `sources[].id` when `isSourceRoot`
 */

/**
 * Build a folder index from a flat video list and the list of source folders.
 *
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

    // Find which source this video belongs to — longest matching source prefix.
    let owningSource = null;
    let owningCanonical = null;
    for (const [canonical, src] of sourceByCanonical) {
      if (videoPath.startsWith(canonical + '/') &&
          (!owningCanonical || canonical.length > owningCanonical.length)) {
        owningSource = src;
        owningCanonical = canonical;
      }
    }
    // If no source owns this video (possible for manually-added paths), skip;
    // it simply won't appear in folder view.
    if (!owningCanonical) continue;

    // Ensure the direct parent folder exists and stash the video on it.
    const leaf = ensure(dir);
    leaf.videos.push(video);

    // Walk up to the owning source root, wiring child->parent and adding
    // intermediate folders as needed.
    let current = dir;
    while (current !== owningCanonical) {
      const parentSlash = current.lastIndexOf('/');
      if (parentSlash <= 0) break;
      const parent = current.slice(0, parentSlash);
      const parentNode = ensure(parent);
      parentNode.childFolders.add(current);
      index.get(current).parent = parent;
      if (parent === owningCanonical) {
        // Reached source root — stop here so we don't walk into the filesystem.
        break;
      }
      current = parent;
    }
  }

  return index;
}

/**
 * Return every video located in `folderPath` or any of its descendants.
 * Assumes `folderPath` is already canonical.
 */
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
 * Build a breadcrumb trail from the root to `folderPath`.
 * @returns {Array<{path: string, label: string}>}
 */
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
