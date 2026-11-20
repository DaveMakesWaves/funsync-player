// HeatmapStrip — compact funscript speed graph for list rows.
// Renders mirrored vertical bars around a horizontal center line. Bar height
// is proportional to speed at each time bin. Bar color is driven by CSS
// (`color: var(--accent)`) so theme changes propagate automatically; falls
// back to a coral accent if the canvas isn't attached to a styled tree yet.

const DEFAULT_BINS = 100;
const FALLBACK_COLOR = '#e94560';
const MAX_SPEED = 0.5; // pos-units per ms; anything faster saturates the bar height

// Kept for backward compat / tests. Not used by renderBars — theme color
// wins. It is the player's shared heatmap scale, not a private copy: a copy
// is how the seek bar and the HM overlay drifted apart (app test V36).
export { heatmapSpeedToColor as speedToColor } from './heatmap-palette.js';

function resolveFillColor(canvas) {
  try {
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const c = window.getComputedStyle(canvas).color;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
  } catch { /* ignore */ }
  return FALLBACK_COLOR;
}

export function computeBins(actions, binCount = DEFAULT_BINS) {
  if (!actions || actions.length < 2 || binCount < 1) return new Float32Array(0);

  const start = actions[0].at;
  const end = actions[actions.length - 1].at;
  const span = end - start;
  if (span <= 0) return new Float32Array(0);

  const bins = new Float32Array(binCount);
  const counts = new Uint32Array(binCount);

  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1];
    const b = actions[i];
    const dt = b.at - a.at;
    if (dt <= 0) continue;
    const dp = Math.abs(b.pos - a.pos);
    const speed = dp / dt;

    const mid = (a.at + b.at) / 2;
    let idx = Math.floor(((mid - start) / span) * binCount);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;

    bins[idx] += speed;
    counts[idx]++;
  }

  for (let i = 0; i < binCount; i++) {
    if (counts[i] > 0) bins[i] /= counts[i];
  }
  return bins;
}

export function renderBins(canvas, bins) {
  if (!canvas || !bins || bins.length === 0) return;
  const m = measureStrip(canvas, bins);
  if (m) drawStrip(m);
}

// Everything renderBins READS from layout and style. Reading `clientWidth`
// forces a layout and `getComputedStyle` a style pass whenever the DOM has
// changed since the last one, and drawing (`canvas.width = ...`) changes it.
// So drawing strips one at a time costs one full-document layout PER STRIP:
// a library grid of 1,546 cards spent 13 s in it on one sort (V81).
function measureStrip(canvas, bins) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return {
    canvas,
    bins,
    ctx,
    dpr,
    cssW: canvas.clientWidth || canvas.width / dpr || bins.length,
    cssH: canvas.clientHeight || canvas.height / dpr || 24,
    color: resolveFillColor(canvas),
  };
}

/**
 * Draw several strips with ONE layout: measure every canvas first, then draw
 * every canvas. Same pixels as calling renderBins on each.
 *
 * @param {Array<{canvas: HTMLCanvasElement, bins: Float32Array}>} jobs
 */
export function renderBinsBatch(jobs) {
  const measured = [];
  for (const { canvas, bins } of jobs || []) {
    if (!canvas || !bins || bins.length === 0) continue;
    const m = measureStrip(canvas, bins);
    if (m) measured.push(m);
  }
  for (const m of measured) drawStrip(m);
}

// Strips queued for the next animation frame, drawn as one batch. The last
// bins queued for a canvas win.
let pendingStrips = null;

/**
 * Draw this strip on the next animation frame, together with every other
 * strip queued for that frame (see renderBinsBatch). For callers that draw
 * many strips at once, such as a library grid render.
 */
export function queueRenderBins(canvas, bins) {
  if (!canvas || !bins || bins.length === 0) return;
  if (!pendingStrips) {
    pendingStrips = new Map();
    requestAnimationFrame(() => {
      const jobs = [...pendingStrips].map(([c, b]) => ({ canvas: c, bins: b }));
      pendingStrips = null;
      // A strip whose card was replaced before the frame has nothing to draw on.
      renderBinsBatch(jobs.filter((j) => j.canvas.isConnected !== false));
    });
  }
  pendingStrips.set(canvas, bins);
}

function drawStrip({ canvas, bins, ctx, dpr, cssW, cssH, color }) {
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  ctx.fillStyle = color;

  const binW = cssW / bins.length;
  for (let i = 0; i < bins.length; i++) {
    const speed = bins[i];
    if (speed <= 0) continue;
    const normalized = Math.min(speed / MAX_SPEED, 1);
    // Minimum 1px so sparse-but-present activity stays visible
    const barH = Math.max(1, cssH * normalized);
    const y = (cssH - barH) / 2;
    ctx.fillRect(i * binW, y, binW + 0.5, barH);
  }
}
