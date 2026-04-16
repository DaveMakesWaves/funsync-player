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
}
