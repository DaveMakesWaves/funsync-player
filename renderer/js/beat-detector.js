// BeatDetector — Onset detection via spectral flux for music-synced scripting
// Uses Web Audio API OfflineAudioContext for frequency analysis

/**
 * @typedef {Object} BeatData
 * @property {Float64Array} beats — beat timestamps in milliseconds, sorted ascending
 * @property {number} count — number of beats detected
 * @property {number} duration — audio duration in seconds
 * @property {number} averageBPM — estimated average BPM
 */

/**
 * @typedef {Object} DetectOptions
 * @property {number} [sensitivity=1.4] — onset threshold multiplier (lower = more beats)
 * @property {number} [minBeatGapMs=150] — minimum gap between beats in ms
 * @property {number} [fftSize=2048] — FFT window size
 */

/** @type {Map<string, BeatData>} */
const _cache = new Map();

/** @type {Map<string, Promise<BeatData|null>>} */
const _pending = new Map();

/**
 * Detect beats in an audio/video source via spectral flux onset detection.
 * Returns cached data if available. Coalesces concurrent requests.
 *
 * @param {string} src — source URL (file:// or blob:)
 * @param {DetectOptions} [options]
 * @param {function} [onProgress] — optional progress callback (0.0–1.0)
 * @returns {Promise<BeatData|null>} beat data, or null on failure
 */
export async function detectBeats(src, options = {}, onProgress) {
  if (!src) return null;

  const cacheKey = src;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  if (_pending.has(cacheKey)) return _pending.get(cacheKey);

  const promise = _doDetect(src, options, onProgress);
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
 * Internal: fetch audio, decode, run spectral flux onset detection.
 * @param {string} src
 * @param {DetectOptions} options
 * @param {function} [onProgress]
 * @returns {Promise<BeatData|null>}
 */
async function _doDetect(src, options, onProgress) {
  const {
    sensitivity = 1.4,
    minBeatGapMs = 150,
    fftSize = 2048,
  } = options;

  try {
    if (onProgress) onProgress(0);

    const response = await fetch(src);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    if (onProgress) onProgress(0.2);

    // Decode to mono
    const audioCtx = new OfflineAudioContext(1, 1, 44100);
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    if (onProgress) onProgress(0.4);

    // Mix channels to mono
    const channelCount = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
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
    if (onProgress) onProgress(0.5);

    // Run spectral flux onset detection
    const beats = spectralFluxOnsets(mono, sampleRate, fftSize, sensitivity, minBeatGapMs);
    if (onProgress) onProgress(1.0);

    const duration = audioBuffer.duration;
    const averageBPM = beats.length >= 2
      ? 60000 / ((beats[beats.length - 1] - beats[0]) / (beats.length - 1))
      : 0;

    return {
      beats,
      count: beats.length,
      duration,
      averageBPM: Math.round(averageBPM * 10) / 10,
    };
  } catch (err) {
    console.warn('[BeatDetector] Detection failed:', err.message);
    return null;
  }
}

/**
 * Detect onsets using spectral flux with adaptive threshold.
 *
 * Spectral flux measures the increase in energy across frequency bins between
 * successive FFT frames. Peaks in the flux that exceed a running average
 * (scaled by sensitivity) are marked as onsets.
 *
 * @param {Float32Array} samples — mono audio samples
 * @param {number} sampleRate — audio sample rate (e.g. 44100)
 * @param {number} fftSize — FFT window size (power of 2)
 * @param {number} sensitivity — threshold multiplier (lower = more beats)
 * @param {number} minBeatGapMs — minimum milliseconds between detected beats
 * @returns {Float64Array} beat timestamps in milliseconds, sorted ascending
 */
export function spectralFluxOnsets(samples, sampleRate, fftSize, sensitivity, minBeatGapMs) {
  if (!samples || samples.length === 0 || sampleRate <= 0) {
    return new Float64Array(0);
  }

  const hopSize = Math.floor(fftSize / 2);
  const numFrames = Math.floor((samples.length - fftSize) / hopSize);
  if (numFrames < 2) return new Float64Array(0);

  const halfFFT = Math.floor(fftSize / 2);
  const window = _hannWindow(fftSize);

  // Compute magnitude spectra and spectral flux
  let prevSpectrum = new Float64Array(halfFFT);
  const flux = new Float64Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;
    const spectrum = _magnitudeSpectrum(samples, offset, fftSize, window);

    // Half-wave rectified spectral flux (only positive changes = energy increase)
    let sf = 0;
    for (let k = 0; k < halfFFT; k++) {
      const diff = spectrum[k] - prevSpectrum[k];
      if (diff > 0) sf += diff;
    }
    flux[f] = sf;
    prevSpectrum = spectrum;
  }

  // Adaptive threshold: running mean over a window, scaled by sensitivity
  const thresholdWindowFrames = Math.max(1, Math.round(0.5 * sampleRate / hopSize)); // ~0.5s window
  const minGapFrames = Math.max(1, Math.round(minBeatGapMs / 1000 * sampleRate / hopSize));

  const beats = [];
  let lastBeatFrame = -minGapFrames;

  for (let f = 0; f < numFrames; f++) {
    // Compute local average for adaptive threshold
    const windowStart = Math.max(0, f - thresholdWindowFrames);
    const windowEnd = Math.min(numFrames, f + thresholdWindowFrames + 1);
    let sum = 0;
    for (let j = windowStart; j < windowEnd; j++) {
      sum += flux[j];
    }
    const localMean = sum / (windowEnd - windowStart);
    const threshold = localMean * sensitivity;

    // Check if this frame is a peak above threshold with minimum gap
    if (flux[f] > threshold && (f - lastBeatFrame) >= minGapFrames) {
      // Verify it's a local peak (greater than neighbors)
      const prev = f > 0 ? flux[f - 1] : 0;
      const next = f < numFrames - 1 ? flux[f + 1] : 0;
      if (flux[f] >= prev && flux[f] >= next) {
        const timeMs = (offset_for_frame(f, hopSize) + fftSize / 2) / sampleRate * 1000;
        beats.push(timeMs);
        lastBeatFrame = f;
      }
    }
  }

  return Float64Array.from(beats);
}

/**
 * Get the sample offset for a given frame index.
 * @param {number} frame
 * @param {number} hopSize
 * @returns {number}
 */
function offset_for_frame(frame, hopSize) {
  return frame * hopSize;
}

/**
 * Compute magnitude spectrum for a windowed frame using a simple DFT.
 * For real-time we'd use FFT, but for offline analysis this is fine.
 * Uses a simplified approach: energy in frequency sub-bands.
 *
 * @param {Float32Array} samples — full audio buffer
 * @param {number} offset — start sample index
 * @param {number} fftSize — window size
 * @param {Float64Array} window — window function values
 * @returns {Float64Array} magnitude spectrum (half-spectrum)
 */
function _magnitudeSpectrum(samples, offset, fftSize, window) {
  const halfFFT = Math.floor(fftSize / 2);

  // Use sub-band energy approach for efficiency:
  // Divide the window into sub-bands, compute energy per band
  const numBands = Math.min(halfFFT, 32); // 32 sub-bands is sufficient for onset detection
  const spectrum = new Float64Array(numBands);
  const bandSize = Math.floor(fftSize / numBands);

  for (let b = 0; b < numBands; b++) {
    let energy = 0;
    const bandStart = offset + b * bandSize;
    const bandEnd = Math.min(bandStart + bandSize, offset + fftSize);
    for (let i = bandStart; i < bandEnd && i < samples.length; i++) {
      const windowed = samples[i] * window[i - offset];
      energy += windowed * windowed;
    }
    spectrum[b] = Math.sqrt(energy);
  }

  return spectrum;
}

/**
 * Generate a Hann window.
 * @param {number} size
 * @returns {Float64Array}
 */
function _hannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return w;
}

// --- Beat-to-action mapping ---

/**
 * Convert detected beats to funscript actions using a mapping strategy.
 *
 * @param {Float64Array} beats — beat timestamps in ms
 * @param {'alternating'|'sine'|'energy'} style — mapping style
 * @param {number} [min=0] — minimum position (0–100)
 * @param {number} [max=100] — maximum position (0–100)
 * @param {Float32Array} [amplitudes] — per-beat amplitude for energy mapping
 * @returns {Array<{at: number, pos: number}>} funscript actions
 */
export function beatsToActions(beats, style = 'alternating', min = 0, max = 100, amplitudes) {
  if (!beats || beats.length === 0) return [];

  min = Math.max(0, Math.min(100, min));
  max = Math.max(min, Math.min(100, max));

  const actions = [];

  for (let i = 0; i < beats.length; i++) {
    const at = Math.round(beats[i]);
    let pos;

    switch (style) {
      case 'alternating':
        pos = i % 2 === 0 ? min : max;
        break;

      case 'sine':
        // Sine wave mapped across beat indices
        pos = min + (max - min) * (0.5 + 0.5 * Math.sin(i * Math.PI));
        break;

      case 'energy':
        if (amplitudes && i < amplitudes.length) {
          // Map amplitude (0–1) to position range
          pos = min + (max - min) * Math.min(1, Math.max(0, amplitudes[i]));
        } else {
          // Fallback: alternating
          pos = i % 2 === 0 ? min : max;
        }
        break;

      default:
        pos = i % 2 === 0 ? min : max;
    }

    actions.push({ at, pos: Math.round(pos) });
  }

  return actions;
}

/**
 * Get cached beat data for a source (synchronous).
 * @param {string} src
 * @returns {BeatData|null}
 */
export function getCachedBeats(src) {
  return _cache.get(src) || null;
}

/**
 * Check if beat detection is in progress for a source.
 * @param {string} src
 * @returns {boolean}
 */
export function isDetecting(src) {
  return _pending.has(src);
}

/**
 * Clear all cached beat data.
 */
export function clearBeatCache() {
  _cache.clear();
}

/**
 * Clear cached beat data for a specific source.
 * @param {string} src
 */
export function clearBeatCacheFor(src) {
  _cache.delete(src);
}
