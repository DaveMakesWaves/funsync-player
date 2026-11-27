// A streamed video's quality (Dave, 2026-11-22: "the quality went really poor
// can we do anything to remedy that?"). Pure helpers for VideoPlayer's hls.js
// setup and the player's Quality button.

/**
 * hls.js settings that favour picture quality: a first guess of the line's
 * speed of 5 Mbit/s (hls.js's own 500 kbit/s started at 240p; 8 Mbit/s
 * started at 1080p and a slow line waited long for its first frame, so most
 * streams now start at 720p and step up within seconds), up to a minute
 * buffered ahead (five at most) so a short slow patch does not force a step
 * down, and quicker to step back up.
 */
export const HLS_QUALITY_CONFIG = Object.freeze({
  enableWorker: true,
  lowLatencyMode: false,
  abrEwmaDefaultEstimate: 5_000_000,
  maxBufferLength: 60,
  maxMaxBufferLength: 300,
  abrBandWidthFactor: 0.95,
  abrBandWidthUpFactor: 0.85,
  startFragPrefetch: true,
});

/** 'auto', or a height (720 ...). Anything else: 'auto'. */
export function normalizeStreamQuality(value) {
  if (value === 'auto') return 'auto';
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 4320 ? n : 'auto';
}

/**
 * The level to hold for a chosen height: the tallest at or under it, else the
 * shortest there is. -1 (hls.js's "automatic") for 'auto' or no levels.
 */
export function pickLevelIndex(levels, pref) {
  const p = normalizeStreamQuality(pref);
  if (p === 'auto' || !Array.isArray(levels) || !levels.length) return -1;
  let best = -1;
  let bestH = -1;
  let lowest = 0;
  levels.forEach((l, i) => {
    const h = Number(l?.height) || 0;
    if (h <= p && h > bestH) { best = i; bestH = h; }
    if (h < (Number(levels[lowest]?.height) || 0)) lowest = i;
  });
  return best >= 0 ? best : lowest;
}

/**
 * The height limit for a single-file stream (several files, one per height,
 * no adaptive switching): the held height; on Auto 720p, unless the last
 * adaptive stream measured the line at 10 Mbit/s or more (then no limit).
 */
export function progressiveMaxHeight(pref, bandwidthBps) {
  const p = normalizeStreamQuality(pref);
  if (p !== 'auto') return p;
  return Number(bandwidthBps) >= 10_000_000 ? null : 720;
}

/** The index of the level for a height limit: the tallest at or under it, else the shortest; no limit, the tallest. */
export function pickProgressiveIndex(levels, maxHeight) {
  if (!Array.isArray(levels) || !levels.length) return -1;
  if (!maxHeight) {
    let best = 0;
    levels.forEach((l, i) => { if ((l?.height || 0) > (levels[best]?.height || 0)) best = i; });
    return best;
  }
  return pickLevelIndex(levels, maxHeight);
}

/** The distinct heights on offer, tallest first. */
export function levelHeights(levels) {
  const out = [];
  for (const l of Array.isArray(levels) ? levels : []) {
    const h = Number(l?.height) || 0;
    if (h > 0 && !out.includes(h)) out.push(h);
  }
  return out.sort((a, b) => b - a);
}
