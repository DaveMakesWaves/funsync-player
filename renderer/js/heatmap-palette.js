// The player's heatmap speed → colour scale. One function so the seek-bar
// heatmap (progress-bar.js) and the HM overlay strip (inline-viz.js) can
// never disagree about what a speed looks like: the overlay used the
// editor's scale (saturating at 0.3 pos/ms, from black) and went red at a
// lower speed than the seek bar under it (EroScripts #381, app test V36).
//
// The script editor's lines and heatmap bar keep their own OFS 6-stop scale
// (ActionGraph.speedToColor); that is the OFS convention editor users know.

/** Speed (pos-units per ms) at which the scale saturates to red. */
export const HEATMAP_MAX_SPEED = 0.5;

/**
 * Map a stroke speed to the heatmap colour: blue (slow) → cyan → green →
 * yellow → red (fast).
 * @param {number} speed - |Δpos| / Δt in position units per millisecond
 * @returns {string} CSS colour
 */
export function heatmapSpeedToColor(speed) {
  const n = Math.min(Math.max(speed, 0) / HEATMAP_MAX_SPEED, 1);
  if (n < 0.25) {
    const t = n / 0.25;
    return `rgb(0, ${Math.round(t * 200)}, ${Math.round(255 - t * 55)})`;
  } else if (n < 0.5) {
    const t = (n - 0.25) / 0.25;
    return `rgb(0, ${Math.round(200 + t * 55)}, ${Math.round(200 - t * 200)})`;
  } else if (n < 0.75) {
    const t = (n - 0.5) / 0.25;
    return `rgb(${Math.round(t * 255)}, 255, 0)`;
  }
  const t = (n - 0.75) / 0.25;
  return `rgb(255, ${Math.round(255 - t * 255)}, 0)`;
}
