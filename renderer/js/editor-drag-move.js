// Shift+drag to move points (OFS style), the docked editor and the pop-out
// alike (test day 2026-11-24, B031 / B032).
//
// The grabbed point (the anchor) follows the cursor by how far the cursor has
// moved since the press, and with Snap to frame on it lands on a frame start,
// as a click, a position key or Shift+Left/Right already did. Each mousemove
// asks for the step from where the points ARE to where they should be, in
// whole ms, so nothing builds up:
//   - the docked editor added each mousemove's raw delta, rounded to the ms,
//     to the last: a long drag drifted off the cursor, and never snapped;
//   - the pop-out sent OP_UPDATE by the index each point had at the press:
//     once the point passed a neighbour (the list re-sorts by time) the next
//     update moved the NEIGHBOUR, and a point sharing the new time was
//     dropped at once, mid-drag. It sends these steps as OP_MOVE_ACTIONS now:
//     the selection is followed by reference, and a point under the drag is
//     only replaced where the drag ends (the batch, CB-02).

/**
 * @param {{ anchorAt: number, anchorPos: number, cursorAt: number, cursorPos: number }} press
 *   the grabbed point and the cursor (ms, 0-100) at the press
 */
export function startDragMove({ anchorAt, anchorPos, cursorAt, cursorPos }) {
  return { anchorAt, anchorPos, cursorAt0: cursorAt, cursorPos0: cursorPos, sentAt: 0, sentPos: 0 };
}

/**
 * The next step of the drag, or null when the points are already where the
 * cursor says. Updates `state` with what it returns: send or apply it.
 * @param {ReturnType<typeof startDragMove>} state
 * @param {{ cursorAt: number, cursorPos: number, snap?: ((ms: number) => number) | null }} now
 * @returns {{ deltaAt: number, deltaPos: number } | null}  whole ms, whole position units
 */
export function dragMoveStep(state, { cursorAt, cursorPos, snap = null }) {
  if (!Number.isFinite(cursorAt) || !Number.isFinite(cursorPos)) return null;
  let at = Math.max(0, state.anchorAt + (cursorAt - state.cursorAt0));
  if (typeof snap === 'function') at = Math.max(0, snap(at));
  at = Math.round(at);
  const pos = Math.max(0, Math.min(100, Math.round(state.anchorPos + (cursorPos - state.cursorPos0))));
  const deltaAt = (at - state.anchorAt) - state.sentAt;
  const deltaPos = (pos - state.anchorPos) - state.sentPos;
  if (deltaAt === 0 && deltaPos === 0) return null;
  state.sentAt += deltaAt;
  state.sentPos += deltaPos;
  return { deltaAt, deltaPos };
}
