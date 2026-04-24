// Collection sync helpers — pure functions for the "Sync with Source"
// collection feature.
//
// A collection can optionally track a library source (by id) or an
// arbitrary folder path. When it does, membership is computed LIVE from
// the folder index + excluded paths, rather than the frozen videoPaths
// snapshot. Videos dropped into the sync folder after creation
// automatically join the collection on the next scan.
//
// Data shape:
//   {
//     id, name, videoPaths,     // for synced collections, videoPaths
//                               // becomes an additive include list —
//                               // manually added videos from outside
//                               // the sync scope
//     syncSource?: {
//       sourceId?: string,      // tracks a named library source
//       folderPath?: string,    // tracks an arbitrary canonical path
//     },
//     excludedPaths?: string[], // videos within sync scope the user
//                               // explicitly removed
//   }
//
// Legacy collections (no syncSource) behave exactly as before — the
// helpers short-circuit.

import { canonicalPath } from './path-utils.js';

/**
 * Resolve a synced collection's sync scope to a canonical folder path,
 * or null if unsynced / source deleted.
 *
 * @param {object} col — collection
 * @param {Array<{id: string, path: string}>} sources — library.sources
 * @returns {string|null}
 */
export function resolveSyncFolder(col, sources) {
  if (!col?.syncSource) return null;
  if (col.syncSource.sourceId) {
    const src = (sources || []).find(s => s.id === col.syncSource.sourceId);
    return src ? canonicalPath(src.path) : null;
  }
  if (col.syncSource.folderPath) {
    return canonicalPath(col.syncSource.folderPath);
  }
  return null;
}

/**
 * Is the collection in sync mode? (Cheaper check than resolving, used
 * as a guard in UI code.)
 */
export function isSynced(col) {
  return !!col?.syncSource && !!(col.syncSource.sourceId || col.syncSource.folderPath);
}

/**
 * Expand a synced collection's membership to the actual set of video
 * paths, given a folder index. Falls back to the legacy frozen
 * videoPaths when the collection isn't synced.
 *
 * Membership rule for synced collections:
 *   (autoMembers − excluded) ∪ include
 * where:
 *   autoMembers = canonical paths of all videos under the sync folder
 *   excluded    = Set(col.excludedPaths || [])
 *   include     = Set(col.videoPaths || []) — additive list of manually
 *                 added videos that live outside the sync scope
 *
 * @param {object} col
 * @param {Array<{id: string, path: string}>} sources
 * @param {Map<string, {videos: Array<{path: string}>}>} folderIndex
 *        — Map from canonical folder path to a node with `.videos` list
 *        of descendants, matching the shape produced by folder-index.js
 * @param {(folderIndex: Map, canonical: string) => Array<{path: string}>} descendantsOf
 *        — helper from folder-index.js; passed in rather than imported
 *        directly so this module stays trivially testable
 * @returns {Set<string>} set of video paths that make up the collection
 */
export function expandSyncedMembership(col, sources, folderIndex, descendantsOf) {
  if (!isSynced(col)) {
    return new Set(col?.videoPaths || []);
  }
  const folder = resolveSyncFolder(col, sources);
  if (!folder || !folderIndex) {
    // Source deleted or index not built yet — fall back to the additive
    // list (so manually added videos still show). Treat as empty sync
    // scope; user will see "collection empty" if they only had auto
    // members.
    return new Set(col.videoPaths || []);
  }
  const descendants = descendantsOf(folderIndex, folder) || [];
  const excluded = new Set(col.excludedPaths || []);
  const members = new Set();
  for (const v of descendants) {
    if (!excluded.has(v.path)) members.add(v.path);
  }
  for (const p of (col.videoPaths || [])) members.add(p);
  return members;
}

/**
 * Freeze a synced collection back into a legacy snapshot: compute its
 * current effective membership, write it to videoPaths, clear
 * syncSource + excludedPaths. Used when the user unchecks "Sync with
 * source" in the edit modal.
 *
 * Returns a NEW collection object; doesn't mutate the input.
 */
export function freezeSyncedCollection(col, sources, folderIndex, descendantsOf) {
  const members = expandSyncedMembership(col, sources, folderIndex, descendantsOf);
  return {
    ...col,
    videoPaths: [...members],
    syncSource: undefined,
    excludedPaths: undefined,
  };
}

/**
 * Convert a synced collection from sourceId-mode to folderPath-mode,
 * snapshotting the path before the source is deleted. Called from the
 * source-delete flow in settings so the collection keeps tracking the
 * same physical folder instead of breaking.
 *
 * Returns a NEW collection object; doesn't mutate the input.
 */
export function convertSourceIdToFolderPath(col, deletedSourcePath) {
  if (!col?.syncSource?.sourceId) return col;
  return {
    ...col,
    syncSource: { folderPath: canonicalPath(deletedSourcePath) },
  };
}

/**
 * For a given video path, should it be added to `videoPaths` (additive
 * include) or removed from `excludedPaths` (un-exclude)? Used by
 * "Add to Collection" on a synced collection.
 *
 * Returns { changed: boolean, col: object } where col is a new copy
 * with the mutation applied.
 */
export function addVideoToCollection(col, videoPath, sources, folderIndex, descendantsOf) {
  if (!isSynced(col)) {
    const videoPaths = col.videoPaths || [];
    if (videoPaths.includes(videoPath)) return { changed: false, col };
    return { changed: true, col: { ...col, videoPaths: [...videoPaths, videoPath] } };
  }
  const excluded = col.excludedPaths || [];
  if (excluded.includes(videoPath)) {
    // Un-exclude: remove from excludedPaths. The video was inside the
    // sync scope and the user had explicitly removed it; adding it back
    // is just reversing that.
    return {
      changed: true,
      col: { ...col, excludedPaths: excluded.filter(p => p !== videoPath) },
    };
  }
  // Check if already in auto-membership via sync scope. If so, it's
  // already in — nothing to change.
  const folder = resolveSyncFolder(col, sources);
  if (folder && folderIndex) {
    const descendants = descendantsOf(folderIndex, folder) || [];
    if (descendants.some(v => v.path === videoPath)) {
      return { changed: false, col };
    }
  }
  // Outside sync scope — add to additive include list.
  const videoPaths = col.videoPaths || [];
  if (videoPaths.includes(videoPath)) return { changed: false, col };
  return { changed: true, col: { ...col, videoPaths: [...videoPaths, videoPath] } };
}

/**
 * Remove a video from a collection. For synced collections, branches:
 *   - If in additive include list → remove from videoPaths
 *   - Else if in auto-membership → add to excludedPaths
 *   - Else → no-op
 * For legacy collections, just removes from videoPaths.
 *
 * Returns { changed, col } tuple same as addVideoToCollection.
 */
export function removeVideoFromCollection(col, videoPath, sources, folderIndex, descendantsOf) {
  const videoPaths = col.videoPaths || [];
  const inIncludeList = videoPaths.includes(videoPath);

  if (!isSynced(col)) {
    if (!inIncludeList) return { changed: false, col };
    return { changed: true, col: { ...col, videoPaths: videoPaths.filter(p => p !== videoPath) } };
  }

  if (inIncludeList) {
    // Additive-include list takes priority — just remove from it.
    return { changed: true, col: { ...col, videoPaths: videoPaths.filter(p => p !== videoPath) } };
  }

  // Check if it's in auto-membership so we know to exclude it.
  const folder = resolveSyncFolder(col, sources);
  if (folder && folderIndex) {
    const descendants = descendantsOf(folderIndex, folder) || [];
    if (descendants.some(v => v.path === videoPath)) {
      const excluded = col.excludedPaths || [];
      if (excluded.includes(videoPath)) return { changed: false, col };
      return { changed: true, col: { ...col, excludedPaths: [...excluded, videoPath] } };
    }
  }
  // Not in sync scope and not in include list — nothing to remove.
  return { changed: false, col };
}
