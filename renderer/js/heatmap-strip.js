// HeatmapStrip — compact funscript speed graph for list rows.
// Renders mirrored vertical bars around a horizontal center line. Bar height
// is proportional to speed at each time bin. Bar color is driven by CSS
// (`color: var(--accent)`) so theme changes propagate automatically; falls
// back to a coral accent if the canvas isn't attached to a styled tree yet.

const DEFAULT_BINS = 100;
const FALLBACK_COLOR = '#e94560';
const MAX_SPEED = 0.5; // pos-units per ms; anything faster saturates the bar height

export function speedToColor(speed) {
  // Kept for backward compat / tests. Not used by renderBars — theme color wins.
  const n = Math.min(Math.max(speed, 0) / MAX_SPEED, 1);
  if (n < 0.25) {
    const t = n / 0.25;
    return `rgb(0,${Math.round(t * 200)},${Math.round(255 - t * 55)})`;
  } else if (n < 0.5) {
    const t = (n - 0.25) / 0.25;
    return `rgb(0,${Math.round(200 + t * 55)},${Math.round(200 - t * 200)})`;
  } else if (n < 0.75) {
    const t = (n - 0.5) / 0.25;
    return `rgb(${Math.round(t * 255)},255,0)`;
  } else {
    const t = (n - 0.75) / 0.25;
    return `rgb(255,${Math.round(255 - t * 255)},0)`;
  }
}

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
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const cssW = canvas.clientWidth || canvas.width / dpr || bins.length;
  const cssH = canvas.clientHeight || canvas.height / dpr || 24;

  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  ctx.fillStyle = resolveFillColor(canvas);

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
