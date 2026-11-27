// The move after a jump (Eroto #423, 2026-11-22): after a seek, a gap skip,
// the end of Edge Hold, or the Orgasm Switch / Edge Hold pattern starting,
// the device "moves to the new position at max speed, which is sometimes
// surprising, loud". The first move after a jump used to take one tick
// (~16 ms) whatever the distance, and the Speed limit is skipped for it.
//
// Now that first move goes from where the device is (TCodeManager
// estimatePosition) to where the script is at a gentle pace; a short hop
// still snaps, so a resume after a pause stays exact. Pure, so both the sync
// engine and the finisher loop use the same rule.

/** The pace of the move after a jump, in units (0-100) a second. */
export const JUMP_MOVE_UNITS_PER_S = 150;
/**
 * Below this distance a jump just snaps, as before: a tenth of the travel. A
 * resume after a pause on a fast stroke lands up to ~9 units from where the
 * device halted (one tick behind the script); that stays a crisp resync.
 */
export const JUMP_EASE_MIN_UNITS = 10;
/** The longest a move after a jump takes, however far. */
export const JUMP_EASE_MAX_MS = 1500;
/** Where an axis is taken to be when nothing has moved it since connecting (an OSR homes to the middle). */
export const UNKNOWN_POSITION = 50;

/**
 * T-Code channels that hold a POSITION (so a jump is a move across the
 * travel). Intensity channels (V0 vibe, V1 pump, A1 suck, A2 lube) are not
 * moves and are never eased. A0, the valve, is a position.
 */
export const POSITION_AXES = new Set(['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'A0']);

/**
 * How long the move from `from` to `to` should take after a jump: 0 when it
 * is short enough to snap, else the distance at `unitsPerS` (capped).
 * @param {number|null|undefined} from where the axis is (null: unknown)
 * @param {number} to where it should go
 * @param {number} [unitsPerS]
 * @returns {number} milliseconds, 0 = snap
 */
export function jumpEaseMs(from, to, unitsPerS = JUMP_MOVE_UNITS_PER_S) {
  const start = typeof from === 'number' && Number.isFinite(from) ? from : UNKNOWN_POSITION;
  if (typeof to !== 'number' || !Number.isFinite(to)) return 0;
  const distance = Math.abs(to - start);
  if (distance < JUMP_EASE_MIN_UNITS) return 0;
  const speed = unitsPerS > 0 ? unitsPerS : JUMP_MOVE_UNITS_PER_S;
  return Math.min(JUMP_EASE_MAX_MS, Math.round((distance / speed) * 1000));
}
