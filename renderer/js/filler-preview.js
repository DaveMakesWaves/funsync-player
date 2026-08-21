// Waveform preview + speed stats for the gap-filler picker.
//
// Dave: "with a wave form visualisation in the picker as well as the speed
// stats of the filler."
//
// Deliberately NOT built on action-graph.js. That is the full editor renderer
// (chapters, bookmarks, selection, heatmap, hit-testing) and is far heavier
// than a settings thumbnail needs; coupling them would mean every editor
// change risks the settings panel.
//
// The preview renders the REAL generated output, including the slew limiter
// and the join ramps, so what the user sees is what the device will do. A
// preview drawn from an idealised waveform would hide exactly the two things
// worth showing: that square is ramped rather than vertical, and that the
// joins ease in and out instead of jumping.

import { buildGapFiller } from './filler-engine.js';
import { computeSpeedStats } from './library-search.js';

/** Length of the sample window drawn in the picker. */
export const PREVIEW_WINDOW_MS = 8000;

/**
 * Generate the preview sample for a set of filler options.
 *
 * Modelled as a real gap with real neighbours, so the join ramps are present
 * and the picture matches playback.
 *
 * @param {object} opts — pattern, bpm, min, max, maxJoinSpeed
 * @returns {{actions: Array, stats: {avgSpeed:number, maxSpeed:number}}}
 */
export function buildPreviewSample(opts = {}) {
  const { min = 0, max = 100 } = opts;
  const mid = Math.round((min + max) / 2);
  const actions = buildGapFiller(
    { startMs: 0, endMs: PREVIEW_WINDOW_MS },
    mid,   // a neighbour either side, so both joins are drawn
    mid,
    opts,
  );
  return { actions, stats: computeSpeedStats(actions) };
}

/**
 * Draw a filler sample onto a canvas.
 *
 * Position 0 is drawn at the BOTTOM. Funscript position 0 is the retracted
 * end of the stroke, and every other visualisation in the app (heatmap,
 * action graph) uses the same orientation — flipping it here would make the
 * preview read as a different script.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{at:number,pos:number}>} actions
 * @param {{stroke?:string, fill?:string, grid?:string}} [colors]
 * @param {{playhead?: number|null}} [opts] — 0-1 position of the test playhead
 */
export function drawFillerWaveform(canvas, actions, colors = {}, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Respect device pixel ratio or the line looks soft on the panel.
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const cssW = canvas.clientWidth || canvas.width || 260;
  const cssH = canvas.clientHeight || canvas.height || 60;
  if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
  if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = 4;
  const usableH = Math.max(1, cssH - pad * 2);

  // Midline, so shallow presets still read as "centred" rather than "low".
  ctx.strokeStyle = colors.grid || 'rgba(127,127,127,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cssH / 2);
  ctx.lineTo(cssW, cssH / 2);
  ctx.stroke();

  if (!Array.isArray(actions) || actions.length < 2) return;

  const start = actions[0].at;
  const end = actions[actions.length - 1].at;
  const span = end - start || 1;
  const x = (at) => ((at - start) / span) * cssW;
  const y = (pos) => pad + (1 - Math.max(0, Math.min(100, pos)) / 100) * usableH;

  ctx.beginPath();
  ctx.moveTo(x(actions[0].at), y(actions[0].pos));
  for (let i = 1; i < actions.length; i++) {
    ctx.lineTo(x(actions[i].at), y(actions[i].pos));
  }

  if (colors.fill) {
    ctx.save();
    ctx.lineTo(x(end), cssH);
    ctx.lineTo(x(start), cssH);
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.restore();
    // Re-stroke the line itself, since the fill closed the path.
    ctx.beginPath();
    ctx.moveTo(x(actions[0].at), y(actions[0].pos));
    for (let i = 1; i < actions.length; i++) {
      ctx.lineTo(x(actions[i].at), y(actions[i].pos));
    }
  }

  ctx.strokeStyle = colors.stroke || '#4aa3ff';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Test playhead. Drawn last so it sits over the curve, and only while a
  // test is actually running — a parked playhead on an idle preview would
  // read as a position the device is holding.
  const head = opts.playhead;
  if (Number.isFinite(head) && head >= 0 && head <= 1) {
    const px = head * cssW;
    ctx.strokeStyle = colors.playhead || '#ff5c5c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, cssH);
    ctx.stroke();
  }
}
