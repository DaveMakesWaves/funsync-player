// Video availability — "is this file reachable right now?"
//
// Bug, 2026-08-06 (Dave): add videos from an external drive to a playlist,
// unplug the drive, open the playlist — and every entry was PERMANENTLY
// DELETED. `_renderDetail` probed each path with fileExists and called
// removeVideoFromPlaylist on every miss, so an absent volume was treated as
// identical to a deleted file. Reconnecting the drive could not undo it: the
// data was already gone from config.json.
//
// The rule this module encodes: **absence is never destructive**. A path that
// isn't reachable is UNAVAILABLE, not removed. It keeps its slot, its order,
// its resume position and its watched mark; it is greyed in the UI and skipped
// by anything that would try to play it. Plug the drive back in and it simply
// returns.
//
// Availability is deliberately NOT persisted. It is a fact about right now,
// re-probed when a view renders, so a reconnect needs no migration or repair
// step — the next render just sees the files again.

/**
 * Probe a batch of paths. One IPC round trip for the whole list; a 500-entry
 * playlist previously issued 500 invokes, each able to block on a spun-down
 * or disconnected volume.
 *
 * Fails OPEN: if the IPC is missing or throws, every path is reported
 * available. That matters — a probe failure must never cascade into greying
 * out (or worse, dropping) a library that is perfectly fine. The destructive
 * bug this module exists to fix came from trusting a negative answer.
 *
 * @param {string[]} paths
 * @param {object} [api] injection point for tests; defaults to window.funsync
 * @returns {Promise<Set<string>>} the subset that is currently reachable
 */
export async function probeAvailability(paths, api) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
  const unique = [...new Set(list)];
  if (unique.length === 0) return new Set();

  const bridge = api || (typeof window !== 'undefined' ? window.funsync : null);

  try {
    if (bridge?.filesExist) {
      const results = await bridge.filesExist(unique);
      if (Array.isArray(results) && results.length === unique.length) {
        return new Set(unique.filter((_, i) => results[i]));
      }
      // Length mismatch means a contract break, not a set of absent files.
      return new Set(unique);
    }
    if (bridge?.fileExists) {
      // Older bridge — fall back to per-path, still non-destructive.
      const results = await Promise.all(unique.map((p) => bridge.fileExists(p)));
      return new Set(unique.filter((_, i) => results[i]));
    }
  } catch {
    // Fail open — see the note above.
    return new Set(unique);
  }

  return new Set(unique);
}

/**
 * Build the predicate the rest of the app passes around.
 *
 * A null/undefined set means "availability unknown" and yields a predicate
 * that answers true for everything, so callers that haven't probed behave
 * exactly as they did before this module existed.
 *
 * @param {Set<string>|null} availableSet
 * @returns {(path: string) => boolean}
 */
export function availabilityPredicate(availableSet) {
  if (!availableSet || typeof availableSet.has !== 'function') return () => true;
  return (path) => availableSet.has(path);
}

/**
 * Split a playlist's paths into what can play now and what can't, preserving
 * order in both halves.
 *
 * @param {string[]} videoPaths
 * @param {(path: string) => boolean} isAvailable
 */
export function partitionByAvailability(videoPaths, isAvailable) {
  const list = Array.isArray(videoPaths) ? videoPaths : [];
  const ok = typeof isAvailable === 'function' ? isAvailable : () => true;
  const available = [];
  const unavailable = [];
  for (const path of list) (ok(path) ? available : unavailable).push(path);
  return { available, unavailable };
}

/**
 * Group unavailable paths by the volume/root they live under, so the UI can
 * say "3 videos on E:\ are unavailable" instead of listing three filenames.
 *
 * Windows gives `E:`; POSIX gives the first path segment (`/Volumes/Media`,
 * `/mnt/usb`). Anything unrecognisable groups under '' and the caller falls
 * back to a generic message rather than inventing a location.
 *
 * @param {string[]} paths
 * @returns {Map<string, string[]>} root → paths, insertion-ordered
 */
export function groupByVolume(paths) {
  const out = new Map();
  for (const path of (Array.isArray(paths) ? paths : [])) {
    if (typeof path !== 'string' || !path) continue;
    let root = '';
    const win = /^([A-Za-z]:)[\\/]/.exec(path);
    if (win) {
      root = win[1];
    } else if (path.startsWith('\\\\')) {
      // UNC share: \\server\share
      const m = /^\\\\([^\\]+\\[^\\]+)/.exec(path);
      root = m ? `\\\\${m[1]}` : '';
    } else if (path.startsWith('/')) {
      const segs = path.split('/').filter(Boolean);
      // /Volumes/X and /mnt/X and /media/X are mount points; two segments
      // identify the volume. A plain /home/... path isn't removable media,
      // but grouping it by its first segment is still a truthful label.
      root = segs.length >= 2 && ['Volumes', 'mnt', 'media', 'run'].includes(segs[0])
        ? `/${segs[0]}/${segs[1]}`
        : (segs.length ? `/${segs[0]}` : '');
    }
    if (!out.has(root)) out.set(root, []);
    out.get(root).push(path);
  }
  return out;
}
