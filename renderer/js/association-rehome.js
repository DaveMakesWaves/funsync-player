// Re-home manual associations when a video MOVES.
//
// `library.associations` is keyed by absolute video path, so moving a video
// to a different source orphans its entry. The library has always had a
// filename fallback for this ("so drive-letter changes don't orphan
// associations"), but it matched on basename alone and took the first hit,
// which is unsafe in a library that legitimately contains several files
// with the same name (`intro.mp4`, `Scene 1.mp4`, ...):
//
//   * two STORED entries sharing a basename → an arbitrary one was taken;
//   * two SCANNED videos sharing a basename → whichever was processed first
//     took the entry and the other got nothing;
//   * the old entry was DELETED even when its video still existed, so a
//     live video could be robbed — and since that video then had no entry,
//     it would steal one back on its own turn, ping-ponging the association
//     between two unrelated files;
//   * entries on a disconnected drive could be stolen and deleted, which
//     defeats the offline-source protection the validation pass takes care
//     to implement.
//
// This planner is pure so the rules are unit-testable without a library
// scan, settings, or the filesystem.

/** Case-folded final path segment. Windows paths are case-insensitive. */
function baseNameOf(p) {
  return String(p || '').split(/[\\/]/).pop().toLowerCase();
}

/**
 * Work out which stored associations should move to which newly-scanned
 * video paths.
 *
 * A move is only inferred on an UNAMBIGUOUS 1:1 basename match: exactly one
 * orphaned entry and exactly one entry-less video share that filename.
 * Ambiguity on EITHER side is left alone — a wrong association is worse
 * than a missing one, because the user cannot tell it is wrong by looking.
 *
 * @param {object} o
 * @param {string[]} o.storedPaths   — keys of library.associations
 * @param {string[]} o.scannedPaths  — video paths in the current scan
 * @param {(path: string) => boolean} [o.isUnavailable] — true when the path
 *   sits under a configured-but-offline source. Those entries are NOT
 *   candidates: the drive may come back and the entry must still be there.
 * @returns {Array<{from: string, to: string}>}
 */
export function planAssociationRehome({ storedPaths, scannedPaths, isUnavailable } = {}) {
  const stored = Array.isArray(storedPaths) ? storedPaths : [];
  const scanned = Array.isArray(scannedPaths) ? scannedPaths : [];
  if (stored.length === 0 || scanned.length === 0) return [];

  const scannedSet = new Set(scanned);
  const storedSet = new Set(stored);
  const offline = typeof isUnavailable === 'function' ? isUnavailable : () => false;

  // Source side: entries whose video is no longer in the library at all.
  // A stored path that IS in the scan belongs to a live video — never a
  // candidate, which is what stops a present video being robbed.
  const orphansByName = new Map();
  for (const p of stored) {
    if (scannedSet.has(p)) continue;
    if (offline(p)) continue;
    const name = baseNameOf(p);
    if (!name) continue;
    const list = orphansByName.get(name);
    if (list) list.push(p);
    else orphansByName.set(name, [p]);
  }
  if (orphansByName.size === 0) return [];

  // Destination side: scanned videos that have no entry of their own.
  const needyByName = new Map();
  for (const p of scanned) {
    if (storedSet.has(p)) continue;
    const name = baseNameOf(p);
    if (!name) continue;
    const list = needyByName.get(name);
    if (list) list.push(p);
    else needyByName.set(name, [p]);
  }

  const moves = [];
  for (const [name, orphans] of orphansByName) {
    if (orphans.length !== 1) continue;      // ambiguous source
    const needy = needyByName.get(name);
    if (!needy || needy.length !== 1) continue; // missing or ambiguous target
    moves.push({ from: orphans[0], to: needy[0] });
  }
  return moves;
}

/**
 * Find the one path in `candidates` that shares `missingPath`'s filename.
 *
 * For recovering a file that moved when there is NO directory to search
 * next to — the global Orgasm Switch script is a single absolute path with
 * no owning video, so none of the "look beside the video" recovery applies.
 * The candidate pool is instead everything the library scan found.
 *
 * Same rule as everywhere else here: exactly one match or nothing. Several
 * files can legitimately share a name across folders, and silently picking
 * one would leave the user driving a device from a script they did not
 * choose.
 *
 * @param {string[]} candidates — pool of known paths
 * @param {string} missingPath — the path that no longer resolves
 * @returns {string|null}
 */
export function findMovedFile(candidates, missingPath) {
  if (!Array.isArray(candidates) || !missingPath) return null;
  const wanted = baseNameOf(missingPath);
  if (!wanted) return null;
  let found = null;
  for (const p of candidates) {
    if (!p || p === missingPath) continue;
    if (baseNameOf(p) !== wanted) continue;
    if (found) return null; // ambiguous
    found = p;
  }
  return found;
}

/**
 * Single-video form of the same rule, for lookups that happen lazily at
 * playback time rather than during a scan (`library.manualVariants`,
 * `library.preferredVariants`). Those had the identical unguarded
 * first-match-wins fallback, with the added problem that they mutate
 * settings from a getter, so a wrong guess is persisted immediately.
 *
 * Without a scan we cannot enumerate "entry-less videos", so the
 * destination side cannot be checked for ambiguity — but the two failure
 * modes that actually lose data can still be prevented:
 *   * several stored entries share the filename → refuse (ambiguous);
 *   * the candidate's video is STILL in the library → refuse, it belongs
 *     to that video and stealing it would delete a live pairing.
 *
 * @param {object} o
 * @param {string[]} o.storedPaths — keys of the map being searched
 * @param {string} o.videoPath — the video being looked up
 * @param {(path: string) => boolean} [o.isLive] — true when a path is still
 *   a known library video. Defaults to "assume nothing is live", which is
 *   only safe when the caller has no library to ask.
 * @returns {string|null} the single safe candidate, or null
 */
export function pickRehomeCandidate({ storedPaths, videoPath, isLive } = {}) {
  if (!videoPath || !Array.isArray(storedPaths) || storedPaths.length === 0) return null;
  const wanted = baseNameOf(videoPath);
  if (!wanted) return null;
  const live = typeof isLive === 'function' ? isLive : () => false;

  const candidates = [];
  for (const p of storedPaths) {
    if (p === videoPath) continue;
    if (baseNameOf(p) !== wanted) continue;
    if (live(p)) continue; // still owned by a video that exists
    candidates.push(p);
    if (candidates.length > 1) return null; // ambiguous — bail early
  }
  return candidates.length === 1 ? candidates[0] : null;
}
