// Waveform — Audio peak extraction and caching for waveform display
// Uses Web Audio API OfflineAudioContext to decode audio from video elements

/**
 * @typedef {Object} WaveformData
 * @property {Float32Array} peaks — normalized peak amplitudes (0.0–1.0), one per sample
 * @property {number} peaksPerSecond — temporal resolution of the peaks array
 * @property {number} sampleRate — original audio sample rate
 * @property {number} duration — audio duration in seconds
 * @property {number} channelCount — number of audio channels (mixed to mono)
 */

/** @type {Map<string, WaveformData>} */
const _cache = new Map();

/** @type {Map<string, Promise<WaveformData|null>>} */
const _pending = new Map();

/**
 * Extract audio peaks from a video/audio source URL.
 * Returns cached data if available. Coalesces concurrent requests for the same source.
 *
 * @param {string} src — source URL (file:// or blob:)
 * @param {number} [peaksPerSecond=100] — temporal resolution (peaks per second of audio)
 * @param {function} [onProgress] — optional progress callback (0.0–1.0)
 * @returns {Promise<WaveformData|null>} peak data, or null on failure
 */
export async function extractPeaks(src, peaksPerSecond = 100, onProgress) {
  if (!src) return null;

  const cacheKey = src;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  // Coalesce concurrent requests for the same source
  if (_pending.has(cacheKey)) return _pending.get(cacheKey);

  const promise = _doExtract(src, peaksPerSecond, onProgress);
  _pending.set(cacheKey, promise);

  try {
    const result = await promise;
    if (result) _cache.set(cacheKey, result);
    return result;
  } finally {
    _pending.delete(cacheKey);
  }
}

/**
 * Internal: fetch audio, decode, and downsample to peaks.
 * @param {string} src
 * @param {number} peaksPerSecond
 * @param {function} [onProgress]
 * @returns {Promise<WaveformData|null>}
 */
async function _doExtract(src, peaksPerSecond, onProgress) {
  try {
    if (onProgress) onProgress(0);

    // Fetch audio data as ArrayBuffer
    const response = await fetch(src);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    if (onProgress) onProgress(0.3);

    // Decode audio using OfflineAudioContext
    // Initial context is throwaway — we just need decodeAudioData
    const audioCtx = new OfflineAudioContext(1, 1, 44100);
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    if (onProgress) onProgress(0.7);

    // Mix all channels to mono
    const channelCount = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);

    for (let ch = 0; ch < channelCount; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        mono[i] += channelData[i];
      }
    }
    if (channelCount > 1) {
      for (let i = 0; i < length; i++) {
        mono[i] /= channelCount;
      }
    }

    // Downsample to peaks
    const targetCount = Math.max(1, Math.round(audioBuffer.duration * peaksPerSecond));
    const peaks = downsamplePeaks(mono, targetCount);
    if (onProgress) onProgress(1.0);

    return {
      peaks,
      peaksPerSecond,
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      channelCount,
    };
  } catch (err) {
    console.warn('[Waveform] Extraction failed:', err.message);
    return null;
  }
}

/**
 * Downsample raw audio samples to peak amplitudes.
 * Each peak is the maximum absolute amplitude within its window.
 *
 * @param {Float32Array} samples — raw mono audio samples
 * @param {number} targetCount — desired number of output peaks
 * @returns {Float32Array} normalized peaks (0.0–1.0)
 */
export function downsamplePeaks(samples, targetCount) {
  if (!samples || samples.length === 0 || targetCount <= 0) {
    return new Float32Array(0);
  }

  const count = Math.min(targetCount, samples.length);
  const peaks = new Float32Array(count);
  const windowSize = samples.length / count;

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * windowSize);
    const end = Math.floor((i + 1) * windowSize);
    let max = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      const abs = Math.abs(samples[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }

  return peaks;
}

/**
 * Get cached waveform data for a source (synchronous).
 * @param {string} src
 * @returns {WaveformData|null}
 */
export function getCachedPeaks(src) {
  return _cache.get(src) || null;
}

/**
 * Check if waveform extraction is in progress for a source.
 * @param {string} src
 * @returns {boolean}
 */
export function isExtracting(src) {
  return _pending.has(src);
}

/**
 * Clear all cached waveform data.
 */
export function clearCache() {
  _cache.clear();
}

/**
 * Clear cached waveform data for a specific source.
 * @param {string} src
 */
export function clearCacheFor(src) {
  _cache.delete(src);
  _multiBandCache.delete(src);
}

// === Multi-band waveform (Audio Event Detection §2.1) ===
//
// Splits the decoded audio into three frequency bands (low / mid / high)
// using direct-form-I biquad IIR filters from the RBJ Audio EQ Cookbook.
// Each band is then downsampled to peaks the same way the single-trace
// waveform is — same `peaksPerSecond` resolution so the renderer can
// reuse its existing time→index math.
//
// Pure DSP — no model file, no ML runtime. Voice and slap-style sounds
// look acoustically distinct across these three traces (mid-band carries
// voice fundamentals; high-band carries sibilance and slap transients;
// low-band carries body / impact / rumble), giving the script author a
// strong visual signature without classification.

/** @typedef {{label: string, peaks: Float32Array, color: string}} BandData */
/** @typedef {{
 *   bands: BandData[],
 *   peaksPerSecond: number,
 *   sampleRate: number,
 *   duration: number,
 *   channelCount: number,
 * }} MultiBandWaveformData */

/** @type {Map<string, MultiBandWaveformData>} */
const _multiBandCache = new Map();
/** @type {Map<string, Promise<MultiBandWaveformData|null>>} */
const _multiBandPending = new Map();

/**
 * Default 3-band split from `notes/features/SCOPE-audio-event-detection.md` §2.1.
 *   Low : 40–250 Hz   — body sounds, low impacts, rumble
 *   Mid : 250 Hz–3 kHz — voice fundamentals, moans
 *   High: 3–12 kHz    — sibilance, slap transients, breath
 */
export const DEFAULT_BANDS = [
  { label: 'Low',  type: 'lp',  freq: 250,   color: 'rgba(180, 100, 255, 0.45)' },
  { label: 'Mid',  type: 'bp',  low: 250, high: 3000, color: 'rgba(100, 220, 200, 0.45)' },
  { label: 'High', type: 'hp',  freq: 3000,  color: 'rgba(255, 180, 80, 0.45)' },
];

/**
 * Extract per-band peaks from an audio source. Decodes the source once,
 * applies a biquad filter chain per band, downsamples each band's
 * filtered signal independently. Cached + coalesced like the single-band
 * extractor.
 *
 * @param {string} src — source URL (file:// or blob:)
 * @param {number} [peaksPerSecond=100]
 * @param {function} [onProgress] — receives 0.0–1.0 over the run
 * @returns {Promise<MultiBandWaveformData|null>}
 */
export async function extractMultiBandPeaks(src, peaksPerSecond = 100, onProgress) {
  if (!src) return null;
  if (_multiBandCache.has(src)) return _multiBandCache.get(src);
  if (_multiBandPending.has(src)) return _multiBandPending.get(src);

  const promise = _doExtractMultiBand(src, peaksPerSecond, onProgress);
  _multiBandPending.set(src, promise);
  try {
    const result = await promise;
    if (result) _multiBandCache.set(src, result);
    return result;
  } finally {
    _multiBandPending.delete(src);
  }
}

async function _doExtractMultiBand(src, peaksPerSecond, onProgress) {
  try {
    if (onProgress) onProgress(0);
    const response = await fetch(src);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    if (onProgress) onProgress(0.2);

    const audioCtx = new OfflineAudioContext(1, 1, 44100);
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    if (onProgress) onProgress(0.45);

    // Mix to mono — same path as single-band extractor.
    const channelCount = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < channelCount; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += channelData[i];
    }
    if (channelCount > 1) for (let i = 0; i < length; i++) mono[i] /= channelCount;

    const sampleRate = audioBuffer.sampleRate;
    const targetCount = Math.max(1, Math.round(audioBuffer.duration * peaksPerSecond));
    const bands = [];
    for (let bi = 0; bi < DEFAULT_BANDS.length; bi++) {
      const band = DEFAULT_BANDS[bi];
      const filtered = applyBandFilter(mono, sampleRate, band);
      const peaks = downsamplePeaks(filtered, targetCount);
      bands.push({ label: band.label, peaks, color: band.color });
      if (onProgress) onProgress(0.45 + (0.55 * (bi + 1) / DEFAULT_BANDS.length));
    }

    return {
      bands,
      peaksPerSecond,
      sampleRate,
      duration: audioBuffer.duration,
      channelCount,
    };
  } catch (err) {
    console.warn('[Waveform] Multi-band extraction failed:', err.message);
    return null;
  }
}

/**
 * Apply the band's filter chain to `samples`. Bandpass is implemented as
 * a cascade of HPF → LPF (sharper rolloff than a single biquad bandpass)
 * so the low/mid/high split is visually crisp at typical audio rates.
 */
export function applyBandFilter(samples, sampleRate, band) {
  if (band.type === 'lp') return applyBiquad(samples, biquadLowpass(band.freq, sampleRate));
  if (band.type === 'hp') return applyBiquad(samples, biquadHighpass(band.freq, sampleRate));
  if (band.type === 'bp') {
    const stage1 = applyBiquad(samples, biquadHighpass(band.low, sampleRate));
    return applyBiquad(stage1, biquadLowpass(band.high, sampleRate));
  }
  return samples;
}

/** RBJ biquad LPF coefficients with Q ≈ 0.707 (Butterworth response). */
export function biquadLowpass(cutoffHz, sampleRate) {
  const w0 = 2 * Math.PI * cutoffHz / sampleRate;
  const Q = Math.SQRT1_2;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosW0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosW0) / 2) / a0,
    b1: (1 - cosW0) / a0,
    b2: ((1 - cosW0) / 2) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ biquad HPF coefficients with Q ≈ 0.707. */
export function biquadHighpass(cutoffHz, sampleRate) {
  const w0 = 2 * Math.PI * cutoffHz / sampleRate;
  const Q = Math.SQRT1_2;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosW0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosW0) / 2) / a0,
    b1: (-(1 + cosW0)) / a0,
    b2: ((1 + cosW0) / 2) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Direct-form-I biquad applied in-order across `samples`. */
export function applyBiquad(samples, c) {
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

/** Synchronous cache lookup for a source. */
export function getCachedMultiBand(src) {
  return _multiBandCache.get(src) || null;
}

export function clearMultiBandCache() {
  _multiBandCache.clear();
}
