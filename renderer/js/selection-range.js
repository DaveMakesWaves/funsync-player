// Shift-click range selection over the library's ordered item list.
//
// Community request: "hold shift to select every video between the first and
// second selected".
//
// Pure so the rules that are easy to get subtly wrong are directly testable:
// which order the range follows, what happens to folder rows, and what happens
// when the anchor no longer exists because the filter changed under it.

/**
 * Paths between two items in the CURRENT on-screen order.
 *
 * The order matters and is not obvious: it must be the sorted, filtered list
 * the user is looking at, not disk order. "Everything between these two" means
 * what they can see between them, so the caller passes `_filteredItems`.
 *
 * FOLDER ROWS ARE SKIPPED. In folder-browse mode the list mixes folder entries
 * with videos; implicitly selecting a folder's whole contents because it
 * happened to sit inside a dragged range is a nasty surprise at scale. Only
 * videos in the span are returned.
 *
 * Direction-agnostic: dragging up selects the same set as dragging down.
 *
 * @param {Array} items ordered list, may contain `{ isFolder: true }` entries
 * @param {string} anchorPath where the range starts (last plain click)
 * @param {string} targetPath the shift-clicked item
 * @param {(item: any) => string} [pathOf]
 * @returns {string[]} video paths in the span, inclusive of both ends
 */
export function rangeBetween(items, anchorPath, targetPath, pathOf = (i) => i?.path) {
  const list = Array.isArray(items) ? items : [];
  if (!targetPath) return [];

  const indexOfPath = (p) => list.findIndex((i) => i && !i.isFolder && pathOf(i) === p);

  const targetIdx = indexOfPath(targetPath);
  if (targetIdx < 0) return [];

  // No usable anchor — the very first click, or the anchor was filtered away
  // since. Degrade to a plain single selection rather than guessing at a span
  // or throwing. Selecting something arbitrary would be worse than doing the
  // obvious minimum.
  const anchorIdx = anchorPath ? indexOfPath(anchorPath) : -1;
  if (anchorIdx < 0) return [targetPath];

  const [from, to] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];

  const out = [];
  for (let i = from; i <= to; i += 1) {
    const item = list[i];
    if (!item || item.isFolder) continue;
    const p = pathOf(item);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Every selectable path in the current view — the Ctrl+A set.
 * Folder rows excluded for the same reason as above.
 */
export function allSelectablePaths(items, pathOf = (i) => i?.path) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && !i.isFolder)
    .map(pathOf)
    .filter(Boolean);
}

/**
 * Where the anchor should sit after a click.
 *
 * A shift-click must NOT move it, so the user can extend and re-extend from
 * the same start point — that is the whole point of the interaction, and
 * moving it turns a second shift-click into a new tiny range.
 *
 * @param {string|null} current
 * @param {string} clickedPath
 * @param {boolean} shiftHeld
 */
export function nextAnchor(current, clickedPath, shiftHeld) {
  if (shiftHeld && current) return current;
  return clickedPath;
}
