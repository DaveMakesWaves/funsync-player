/**
 * Fill with pattern to a tempo (editor work list 4.7, 2026-11-24): the fill's
 * Speed set from a BPM, or from the beats the editor's beat detector found in
 * the stretch being filled, so a fill keeps time with the music.
 *
 * The drawer's Speed is the FunSync mean, |dpos| / dt in units/s. One stroke
 * (one leg, top to bottom or back) per beat over the fill's depth is
 * depth × BPM / 60 units/s. Patterns whose legs are not all full depth come
 * out a little off the beat; the drawer says "about".
 */

export const TEMPO_MIN_BPM = 30;
export const TEMPO_MAX_BPM = 300;

/**
 * @param {number} bpm
 * @param {number} depth — the fill's depth, 0-100 (its range's top minus bottom)
 * @param {{min?: number, max?: number}} [clamp] — the Speed slider's ends
 * @returns {number|null} units/s, or null for a BPM out of range
 */
export function speedForBpm(bpm, depth, { min = 10, max = 600 } = {}) {
  const b = Number(bpm);
  if (!Number.isFinite(b) || b < TEMPO_MIN_BPM || b > TEMPO_MAX_BPM) return null;
  const d = Math.max(1, Math.min(100, Math.abs(Number(depth) || 100)));
  return Math.round(Math.max(min, Math.min(max, d * b / 60)));
}

/**
 * The tempo of the beats inside [fromMs, toMs]: 60 000 over the median time
 * between them. Needs three beats in the stretch (two gaps); null otherwise.
 * @param {ArrayLike<number>|null} beats — beat times in ms, in order
 */
export function bpmFromBeats(beats, fromMs, toMs) {
  if (!beats || !(toMs > fromMs)) return null;
  const inside = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    if (b >= fromMs && b <= toMs) inside.push(b);
  }
  if (inside.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < inside.length; i++) if (inside[i] > inside[i - 1]) gaps.push(inside[i] - inside[i - 1]);
  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  const bpm = 60000 / gaps[Math.floor(gaps.length / 2)];
  return bpm >= TEMPO_MIN_BPM && bpm <= TEMPO_MAX_BPM ? Math.round(bpm) : null;
}
