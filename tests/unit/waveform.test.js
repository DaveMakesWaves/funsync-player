import { describe, it, expect, vi, beforeEach } from 'vitest';
import { downsamplePeaks, extractPeaks, getCachedPeaks, isExtracting, clearCache, clearCacheFor } from '../../renderer/js/waveform.js';

describe('waveform', () => {
  describe('downsamplePeaks', () => {
    it('returns empty for empty samples', () => {
      expect(downsamplePeaks(new Float32Array(0), 10)).toEqual(new Float32Array(0));
    });

    it('returns empty for null samples', () => {
      expect(downsamplePeaks(null, 10)).toEqual(new Float32Array(0));
    });

    it('returns empty for zero target count', () => {
      expect(downsamplePeaks(new Float32Array([0.5, 0.3]), 0)).toEqual(new Float32Array(0));
    });

    it('returns empty for negative target count', () => {
      expect(downsamplePeaks(new Float32Array([0.5]), -1)).toEqual(new Float32Array(0));
    });

    it('extracts correct peak count', () => {
      const samples = new Float32Array(1000);
      for (let i = 0; i < 1000; i++) samples[i] = Math.sin(i * 0.1);
      const peaks = downsamplePeaks(samples, 10);
      expect(peaks.length).toBe(10);
    });

    it('captures max absolute amplitude per window', () => {
      // 4 samples → 2 peaks, window size = 2
      const samples = new Float32Array([0.1, 0.9, -0.5, 0.3]);
      const peaks = downsamplePeaks(samples, 2);
      expect(peaks[0]).toBeCloseTo(0.9);
      expect(peaks[1]).toBeCloseTo(0.5); // abs(-0.5)
    });

    it('handles negative values correctly', () => {
      const samples = new Float32Array([-1.0, -0.5, -0.2]);
      const peaks = downsamplePeaks(samples, 1);
      expect(peaks[0]).toBeCloseTo(1.0);
    });

    it('returns all-zero peaks for silent audio', () => {
      const samples = new Float32Array(100); // all zeros
      const peaks = downsamplePeaks(samples, 5);
      expect(peaks.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(peaks[i]).toBe(0);
      }
    });

    it('clamps target count to sample length', () => {
      const samples = new Float32Array([0.5, 0.3, 0.7]);
      const peaks = downsamplePeaks(samples, 100);
      // Should not exceed sample length
      expect(peaks.length).toBe(3);
    });

    it('handles single sample', () => {
      const samples = new Float32Array([0.42]);
      const peaks = downsamplePeaks(samples, 1);
      expect(peaks.length).toBe(1);
      expect(peaks[0]).toBeCloseTo(0.42);
    });

    it('preserves peak values during downsampling', () => {
      // Create samples with a clear spike in the middle
      const samples = new Float32Array(100);
      samples[50] = 0.95;
      const peaks = downsamplePeaks(samples, 10);
      // The spike should appear in the 5th or 6th window (index 5)
      const maxPeak = Math.max(...peaks);
      expect(maxPeak).toBeCloseTo(0.95);
    });

    it('does not mutate input', () => {
      const samples = new Float32Array([0.5, -0.3, 0.7, 0.1]);
      const copy = new Float32Array(samples);
      downsamplePeaks(samples, 2);
      expect(samples).toEqual(copy);
    });
  });

  describe('extractPeaks', () => {
    let mockAudioBuffer;

    beforeEach(() => {
      clearCache();
      vi.restoreAllMocks();

      // Mock AudioBuffer
      const channelData = new Float32Array(4410); // 0.1s at 44100Hz
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = Math.sin(i * 0.05) * 0.8;
      }

      mockAudioBuffer = {
        numberOfChannels: 1,
        length: channelData.length,
        sampleRate: 44100,
        duration: 0.1,
        getChannelData: vi.fn().mockReturnValue(channelData),
      };

      // Mock OfflineAudioContext (must be a regular function, not arrow, to support `new`)
      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockResolvedValue(mockAudioBuffer);
      });

      // Mock fetch
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1024)),
      });
    });

    it('returns WaveformData with correct structure', async () => {
      const data = await extractPeaks('file:///test.mp4', 100);
      expect(data).not.toBeNull();
      expect(data.peaks).toBeInstanceOf(Float32Array);
      expect(data.peaksPerSecond).toBe(100);
      expect(data.sampleRate).toBe(44100);
      expect(data.duration).toBe(0.1);
      expect(data.channelCount).toBe(1);
    });

    it('returns null for empty src', async () => {
      expect(await extractPeaks('', 100)).toBeNull();
      expect(await extractPeaks(null, 100)).toBeNull();
    });

    it('returns null when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });
      const data = await extractPeaks('file:///missing.mp4', 100);
      expect(data).toBeNull();
    });

    it('returns null when decode fails', async () => {
      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockRejectedValue(new Error('Unsupported format'));
      });
      const data = await extractPeaks('file:///bad.mp4', 100);
      expect(data).toBeNull();
    });

    it('returns null for empty arrayBuffer', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      });
      const data = await extractPeaks('file:///empty.mp4', 100);
      expect(data).toBeNull();
    });

    it('caches results by src', async () => {
      const data1 = await extractPeaks('file:///test.mp4', 100);
      const data2 = await extractPeaks('file:///test.mp4', 100);
      expect(data1).toBe(data2); // same reference
      expect(globalThis.fetch).toHaveBeenCalledTimes(1); // only fetched once
    });

    it('different src produces different cache entry', async () => {
      const data1 = await extractPeaks('file:///a.mp4', 100);
      const data2 = await extractPeaks('file:///b.mp4', 100);
      expect(data1).not.toBe(data2);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('calls onProgress callback', async () => {
      const progress = vi.fn();
      await extractPeaks('file:///test.mp4', 100, progress);
      expect(progress).toHaveBeenCalledWith(0);
      expect(progress).toHaveBeenCalledWith(0.3);
      expect(progress).toHaveBeenCalledWith(0.7);
      expect(progress).toHaveBeenCalledWith(1.0);
    });

    it('mixes stereo to mono correctly', async () => {
      const left = new Float32Array([0.6, 0.4]);
      const right = new Float32Array([0.2, 0.8]);
      mockAudioBuffer.numberOfChannels = 2;
      mockAudioBuffer.length = 2;
      mockAudioBuffer.getChannelData = vi.fn().mockImplementation((ch) => ch === 0 ? left : right);

      const data = await extractPeaks('file:///stereo.mp4', 100);
      expect(data).not.toBeNull();
      expect(data.channelCount).toBe(2);
    });

    it('coalesces concurrent requests for the same source', async () => {
      // Launch two extractions in parallel
      const p1 = extractPeaks('file:///concurrent.mp4', 100);
      const p2 = extractPeaks('file:///concurrent.mp4', 100);
      const [d1, d2] = await Promise.all([p1, p2]);
      expect(d1).toBe(d2); // same reference
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCachedPeaks', () => {
    beforeEach(() => {
      clearCache();
    });

    it('returns null for uncached src', () => {
      expect(getCachedPeaks('file:///unknown.mp4')).toBeNull();
    });

    it('returns cached data after extraction', async () => {
      // Set up mocks for extraction
      const channelData = new Float32Array(100);
      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockResolvedValue({
          numberOfChannels: 1,
          length: 100,
          sampleRate: 44100,
          duration: 0.002,
          getChannelData: () => channelData,
        });
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      });

      await extractPeaks('file:///cached.mp4', 100);
      const cached = getCachedPeaks('file:///cached.mp4');
      expect(cached).not.toBeNull();
      expect(cached.peaks).toBeInstanceOf(Float32Array);
    });
  });

  describe('isExtracting', () => {
    beforeEach(() => {
      clearCache();
    });

    it('returns false when not extracting', () => {
      expect(isExtracting('file:///test.mp4')).toBe(false);
    });
  });

  describe('clearCache', () => {
    beforeEach(() => {
      clearCache();
    });

    it('removes all cached data', async () => {
      // Set up mocks
      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockResolvedValue({
          numberOfChannels: 1,
          length: 100,
          sampleRate: 44100,
          duration: 0.002,
          getChannelData: () => new Float32Array(100),
        });
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      });

      await extractPeaks('file:///a.mp4', 100);
      expect(getCachedPeaks('file:///a.mp4')).not.toBeNull();

      clearCache();
      expect(getCachedPeaks('file:///a.mp4')).toBeNull();
    });
  });

  describe('clearCacheFor', () => {
    beforeEach(() => {
      clearCache();
    });

    it('removes only the specified src', async () => {
      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockResolvedValue({
          numberOfChannels: 1,
          length: 100,
          sampleRate: 44100,
          duration: 0.002,
          getChannelData: () => new Float32Array(100),
        });
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      });

      await extractPeaks('file:///a.mp4', 100);
      await extractPeaks('file:///b.mp4', 100);

      clearCacheFor('file:///a.mp4');
      expect(getCachedPeaks('file:///a.mp4')).toBeNull();
      expect(getCachedPeaks('file:///b.mp4')).not.toBeNull();
    });
  });
});
