/**
 * Statistics for the editor's selection (work list 4.1, test day S011,
 * 2026-11-24; OFS has a statistics panel): how long the selection spans and
 * how fast its strokes are, in units/s, for both editors' status line.
 *
 * The speeds are those of the strokes INSIDE the selection: a pair of points
 * that are next to each other in the script and both selected. Holds (no
 * movement) and points at one time are skipped, and the average is the mean
 * of the strokes' speeds: the library's rule (library-search.js
 * computeSpeedStats), so a selection of the whole script reads as the card.
 */

/**
 * @param {Array<{at: number, pos: number}>} actions — the script, in time order
 * @param {Set<number>|number[]} selected — selected indices
 * @returns {null | {count: number, spanMs: number, avgSpeed: number, maxSpeed: number, strokes: number}}
 *   null with fewer than two points selected
 */
export function selectionStats(actions, selected) {
  const idx = [...(selected || [])].filter((i) => i >= 0 && i < (actions?.length || 0)).sort((a, b) => a - b);
  if (idx.length < 2) return null;
  const spanMs = actions[idx[idx.length - 1]].at - actions[idx[0]].at;
  let total = 0;
  let max = 0;
  let strokes = 0;
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] !== idx[k - 1] + 1) continue;          // not neighbours in the script
    const a = actions[idx[k - 1]];
    const b = actions[idx[k]];
    const dt = b.at - a.at;
    const dp = Math.abs(b.pos - a.pos);
    if (dt <= 0 || dp === 0) continue;
    const speed = (dp / dt) * 1000;
    total += speed;
    if (speed > max) max = speed;
    strokes++;
  }
  return {
    count: idx.length,
    spanMs,
    avgSpeed: strokes ? Math.round(total / strokes) : 0,
    maxSpeed: Math.round(max),
    strokes,
  };
}

/**
 * The status line's addition for a selection, or '' (fewer than two points).
 * @param {Function} t — the i18n lookup of the window drawing it
 */
export function selectionStatsText(actions, selected, t) {
  const s = selectionStats(actions, selected);
  if (!s) return '';
  const seconds = (s.spanMs / 1000).toFixed(s.spanMs < 10000 ? 2 : 1);
  return s.strokes > 0
    ? t('editor.statusStats', { seconds, avg: s.avgSpeed, top: s.maxSpeed })
    : t('editor.statusSpan', { seconds });
}
