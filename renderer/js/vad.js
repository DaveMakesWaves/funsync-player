// Voice-activity detection — energy-based stopgap.
//
// Renderer-side VAD that thresholds the mid-band envelope of the
// existing multi-band waveform extractor. Voice fundamentals live in
// 250 Hz – 3 kHz, so mid-band RMS is a usable proxy for "voice present
// here." Imperfect by design — slaps, low impact harmonics, and music
// energy also show up in the mid band — but it ships value with no new
// dependencies, no model bundling, and no backend changes.
//
// Phase 1c (`SCOPE-audio-event-detection.md` §2.2) replaces the
// energy step with silero-vad via ONNX-runtime in the Python backend.
// API surface here matches what that drop-in replacement will return,
// so the renderer / action-graph code paths don't need to change.

import { extractMultiBandPeaks } from './waveform.js';

const _cache = new Map();
const _pending = new Map();

/** Default tuning. Threshold is empirical — calibrated against typical
 *  narrative + SFX content where voice peaks land around 0.1-0.3 in the
 *  normalised mid-band envelope. Min/merge guard against single-peak
 *  blips becoming "voice on" segments. */
export const DEFAULT_VAD_OPTIONS = {
  threshold: 0.08,
  minSegmentMs: 250,
  mergeGapMs: 200,
};

/**
 * @typedef {{ startMs: number, endMs: number }} VADSegment
 * @typedef {{
 *   segments: VADSegment[],
 *   duration: number,
 *   threshold: number,
 *   method: 'energy-mid-band' | 'silero-vad',
 * }} VADData
 */

/**
 * Extract voice-activity segments for `src`. Cached + coalesced like
 * `extractPeaks` / `extractMultiBandPeaks`.
 *
 * @param {string} src — source URL (file:// or blob:)
 * @param {Partial<typeof DEFAULT_VAD_OPTIONS>} [opts]
 * @returns {Promise<VADData|null>}
 */
export async function extractVAD(src, opts = {}) {
  if (!src) return null;
  const options = { ...DEFAULT_VAD_OPTIONS, ...opts };
  const key = _cacheKey(src, options);
  if (_cache.has(key)) return _cache.get(key);
  if (_pending.has(key)) return _pending.get(key);

  const promise = _doExtract(src, options);
  _pending.set(key, promise);
  try {
    const result = await promise;
    if (result) _cache.set(key, result);
    return result;
  } finally {
    _pending.delete(key);
  }
}

async function _doExtract(src, options) {
  const multi = await extractMultiBandPeaks(src, 100);
  if (!multi || !multi.bands) return null;
  const midBand = multi.bands.find(b => b.label === 'Mid');
  if (!midBand) return null;
  return computeVADSegments(midBand.peaks, multi.peaksPerSecond, multi.duration, options);
}

/**
 * Pure function: given a per-peak amplitude array (mid-band envelope),
 * a sampling resolution, and the underlying audio duration, compute
 * voice-activity segments via threshold → merge → drop-short.
 *
 * Exported so unit tests can verify the threshold / merge / drop-short
 * logic without spinning up an OfflineAudioContext.
 */
export function computeVADSegments(peaks, peaksPerSecond, durationSec, options) {
  const opts = { ...DEFAULT_VAD_OPTIONS, ...(options || {}) };
  if (!peaks || peaks.length === 0 || peaksPerSecond <= 0) {
    return { segments: [], duration: durationSec || 0, threshold: opts.threshold, method: 'energy-mid-band' };
  }

  const minPeaks = Math.max(1, Math.round(opts.minSegmentMs / 1000 * peaksPerSecond));
  const mergePeaks = Math.max(0, Math.round(opts.mergeGapMs / 1000 * peaksPerSecond));

  // Pass 1: raw above-threshold runs.
  const raw = [];
  let runStart = -1;
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] > opts.threshold) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      raw.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  if (runStart >= 0) raw.push({ start: runStart, end: peaks.length });

  // Pass 2: merge runs separated by ≤ mergePeaks (bridges brief breaths
  // / consonant silences inside a single utterance).
  const merged = [];
  for (const r of raw) {
    if (merged.length && r.start - merged[merged.length - 1].end <= mergePeaks) {
      merged[merged.length - 1].end = r.end;
    } else {
      merged.push({ ...r });
    }
  }

  // Pass 3: drop runs shorter than minPeaks (single-peak blips, plosive
  // transients that aren't voice).
  const filtered = merged.filter(r => r.end - r.start >= minPeaks);

  return {
    segments: filtered.map(r => ({
      startMs: (r.start / peaksPerSecond) * 1000,
      endMs: (r.end / peaksPerSecond) * 1000,
    })),
    duration: durationSec || 0,
    threshold: opts.threshold,
    method: 'energy-mid-band',
  };
}

function _cacheKey(src, options) {
  return `${src}::${options.threshold}::${options.minSegmentMs}::${options.mergeGapMs}`;
}

export function getCachedVAD(src, opts = {}) {
  const options = { ...DEFAULT_VAD_OPTIONS, ...opts };
  return _cache.get(_cacheKey(src, options)) || null;
}

export function clearVADCache() { _cache.clear(); }

export function clearVADCacheFor(src) {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${src}::`)) _cache.delete(key);
  }
}
