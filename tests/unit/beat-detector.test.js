import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectBeats, beatsToActions, spectralFluxOnsets,
  getCachedBeats, isDetecting, clearBeatCache, clearBeatCacheFor,
} from '../../renderer/js/beat-detector.js';

describe('beat-detector', () => {
  describe('spectralFluxOnsets', () => {
    it('returns empty for empty samples', () => {
      expect(spectralFluxOnsets(new Float32Array(0), 44100, 2048, 1.4, 150)).toEqual(new Float64Array(0));
    });

    it('returns empty for null samples', () => {
      expect(spectralFluxOnsets(null, 44100, 2048, 1.4, 150)).toEqual(new Float64Array(0));
    });

    it('returns empty for zero sample rate', () => {
      expect(spectralFluxOnsets(new Float32Array(4096), 0, 2048, 1.4, 150)).toEqual(new Float64Array(0));
    });

    it('returns empty when too few frames', () => {
      // Need at least fftSize + hopSize samples for 2 frames
      const samples = new Float32Array(1024); // less than fftSize (2048)
      expect(spectralFluxOnsets(samples, 44100, 2048, 1.4, 150)).toEqual(new Float64Array(0));
    });

    it('detects onsets in a signal with periodic impulses', () => {
      // Create a signal with distinct impulses every ~0.5s at 44100 Hz
      const sampleRate = 44100;
      const duration = 3; // 3 seconds
      const samples = new Float32Array(sampleRate * duration);

      // Place impulses at 0.5s intervals
      const impulseIntervalSamples = Math.floor(sampleRate * 0.5);
      for (let i = 0; i < samples.length; i += impulseIntervalSamples) {
        // Sharp impulse burst (64 samples)
        for (let j = 0; j < 64 && i + j < samples.length; j++) {
          samples[i + j] = 0.9 * Math.sin(j * 0.5);
        }
      }

      const beats = spectralFluxOnsets(samples, sampleRate, 2048, 1.2, 100);
      expect(beats.length).toBeGreaterThan(0);
    });

    it('returns sorted timestamps', () => {
      const sampleRate = 44100;
      const samples = new Float32Array(sampleRate * 2);

      // Impulses
      for (let i = 0; i < samples.length; i += Math.floor(sampleRate * 0.3)) {
        for (let j = 0; j < 32 && i + j < samples.length; j++) {
          samples[i + j] = 0.8;
        }
      }

      const beats = spectralFluxOnsets(samples, sampleRate, 2048, 1.2, 100);
      for (let i = 1; i < beats.length; i++) {
        expect(beats[i]).toBeGreaterThanOrEqual(beats[i - 1]);
      }
    });

    it('returns timestamps within audio duration', () => {
      const sampleRate = 44100;
      const duration = 2;
      const samples = new Float32Array(sampleRate * duration);

      for (let i = 0; i < samples.length; i += Math.floor(sampleRate * 0.4)) {
        for (let j = 0; j < 64 && i + j < samples.length; j++) {
          samples[i + j] = 0.7;
        }
      }

      const beats = spectralFluxOnsets(samples, sampleRate, 2048, 1.2, 100);
      const durationMs = duration * 1000;
      for (let i = 0; i < beats.length; i++) {
        expect(beats[i]).toBeGreaterThanOrEqual(0);
        expect(beats[i]).toBeLessThanOrEqual(durationMs + 100); // small tolerance for FFT windowing
      }
    });

    it('returns empty for silence', () => {
      const samples = new Float32Array(44100 * 2); // 2s silence
      const beats = spectralFluxOnsets(samples, 44100, 2048, 1.4, 150);
      expect(beats.length).toBe(0);
    });

    it('sensitivity affects beat count — lower sensitivity finds more beats', () => {
      const sampleRate = 44100;
      const samples = new Float32Array(sampleRate * 3);

      // Create a complex signal with varying amplitudes
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin(i * 0.01) * 0.3 + (i % 10000 < 100 ? 0.7 : 0);
      }

      const beatsLow = spectralFluxOnsets(samples, sampleRate, 2048, 1.0, 100);
      const beatsHigh = spectralFluxOnsets(samples, sampleRate, 2048, 2.0, 100);

      // Lower sensitivity should find at least as many beats
      expect(beatsLow.length).toBeGreaterThanOrEqual(beatsHigh.length);
    });

    it('respects minBeatGapMs', () => {
      const sampleRate = 44100;
      const samples = new Float32Array(sampleRate * 2);

      // Dense impulses every 50ms
      for (let i = 0; i < samples.length; i += Math.floor(sampleRate * 0.05)) {
        for (let j = 0; j < 32 && i + j < samples.length; j++) {
          samples[i + j] = 0.9;
        }
      }

      const beats = spectralFluxOnsets(samples, sampleRate, 1024, 1.0, 500);
      // With 500ms min gap, consecutive beats should be >= 400ms apart (allowing some tolerance)
      for (let i = 1; i < beats.length; i++) {
        expect(beats[i] - beats[i - 1]).toBeGreaterThanOrEqual(300);
      }
    });
  });

  describe('beatsToActions', () => {
    const beats = Float64Array.from([0, 500, 1000, 1500, 2000]);

    it('returns empty for empty beats', () => {
      expect(beatsToActions(new Float64Array(0))).toEqual([]);
    });

    it('returns empty for null beats', () => {
      expect(beatsToActions(null)).toEqual([]);
    });

    it('alternating style produces 0/100 pattern', () => {
      const actions = beatsToActions(beats, 'alternating', 0, 100);
      expect(actions.length).toBe(5);
      expect(actions[0].pos).toBe(0);
      expect(actions[1].pos).toBe(100);
      expect(actions[2].pos).toBe(0);
      expect(actions[3].pos).toBe(100);
      expect(actions[4].pos).toBe(0);
    });

    it('alternating style respects min/max', () => {
      const actions = beatsToActions(beats, 'alternating', 20, 80);
      expect(actions[0].pos).toBe(20);
      expect(actions[1].pos).toBe(80);
    });

    it('sine style produces sine-wave positions', () => {
      const actions = beatsToActions(beats, 'sine', 0, 100);
      expect(actions.length).toBe(5);
      // All positions should be in range
      for (const a of actions) {
        expect(a.pos).toBeGreaterThanOrEqual(0);
        expect(a.pos).toBeLessThanOrEqual(100);
      }
    });

    it('energy style uses amplitudes', () => {
      const amplitudes = new Float32Array([0.0, 0.5, 1.0, 0.3, 0.8]);
      const actions = beatsToActions(beats, 'energy', 0, 100, amplitudes);
      expect(actions[0].pos).toBe(0);   // amplitude 0.0 → min
      expect(actions[2].pos).toBe(100); // amplitude 1.0 → max
    });

    it('energy style falls back to alternating without amplitudes', () => {
      const actions = beatsToActions(beats, 'energy', 0, 100);
      expect(actions[0].pos).toBe(0);
      expect(actions[1].pos).toBe(100);
    });

    it('timestamps are rounded', () => {
      const preciseBeats = Float64Array.from([0.3, 500.7, 1000.1]);
      const actions = beatsToActions(preciseBeats, 'alternating');
      expect(actions[0].at).toBe(0);
      expect(actions[1].at).toBe(501);
      expect(actions[2].at).toBe(1000);
    });

    it('clamps min/max to 0-100 range', () => {
      const actions = beatsToActions(beats, 'alternating', -10, 150);
      expect(actions[0].pos).toBe(0);
      expect(actions[1].pos).toBe(100);
    });

    it('unknown style defaults to alternating', () => {
      const actions = beatsToActions(beats, 'unknown', 0, 100);
      expect(actions[0].pos).toBe(0);
      expect(actions[1].pos).toBe(100);
    });
  });

  describe('detectBeats', () => {
    let mockAudioBuffer;

    beforeEach(() => {
      clearBeatCache();
      vi.restoreAllMocks();

      // Create audio buffer with periodic impulses for detection
      const sampleRate = 44100;
      const duration = 2;
      const channelData = new Float32Array(sampleRate * duration);
      // Place impulses
      for (let i = 0; i < channelData.length; i += Math.floor(sampleRate * 0.5)) {
        for (let j = 0; j < 64 && i + j < channelData.length; j++) {
          channelData[i + j] = 0.8 * Math.sin(j * 0.5);
        }
      }

      mockAudioBuffer = {
        numberOfChannels: 1,
        length: channelData.length,
        sampleRate,
        duration,
        getChannelData: vi.fn().mockReturnValue(channelData),
      };

      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockResolvedValue(mockAudioBuffer);
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1024)),
      });
    });

    it('returns BeatData with correct structure', async () => {
      const data = await detectBeats('file:///test.mp4');
      expect(data).not.toBeNull();
      expect(data.beats).toBeInstanceOf(Float64Array);
      expect(data.count).toBe(data.beats.length);
      expect(data.duration).toBe(2);
      expect(typeof data.averageBPM).toBe('number');
    });

    it('returns null for empty src', async () => {
      expect(await detectBeats('')).toBeNull();
      expect(await detectBeats(null)).toBeNull();
    });

    it('returns null when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });
      expect(await detectBeats('file:///bad.mp4')).toBeNull();
    });

    it('returns null when decode fails', async () => {
      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockRejectedValue(new Error('Bad format'));
      });
      expect(await detectBeats('file:///bad.mp4')).toBeNull();
    });

    it('caches results by src', async () => {
      const data1 = await detectBeats('file:///test.mp4');
      const data2 = await detectBeats('file:///test.mp4');
      expect(data1).toBe(data2);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('calls onProgress callback', async () => {
      const progress = vi.fn();
      await detectBeats('file:///test.mp4', {}, progress);
      expect(progress).toHaveBeenCalledWith(0);
      expect(progress).toHaveBeenCalledWith(0.2);
      expect(progress).toHaveBeenCalledWith(0.4);
      expect(progress).toHaveBeenCalledWith(0.5);
      expect(progress).toHaveBeenCalledWith(1.0);
    });
  });

  describe('getCachedBeats', () => {
    beforeEach(() => {
      clearBeatCache();
    });

    it('returns null for uncached src', () => {
      expect(getCachedBeats('file:///unknown.mp4')).toBeNull();
    });
  });

  describe('isDetecting', () => {
    it('returns false when not detecting', () => {
      expect(isDetecting('file:///test.mp4')).toBe(false);
    });
  });

  describe('clearBeatCache', () => {
    beforeEach(() => {
      clearBeatCache();

      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockResolvedValue({
          numberOfChannels: 1,
          length: 88200,
          sampleRate: 44100,
          duration: 2,
          getChannelData: () => new Float32Array(88200),
        });
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      });
    });

    it('removes all cached data', async () => {
      await detectBeats('file:///a.mp4');
      expect(getCachedBeats('file:///a.mp4')).not.toBeNull();
      clearBeatCache();
      expect(getCachedBeats('file:///a.mp4')).toBeNull();
    });
  });

  describe('clearBeatCacheFor', () => {
    beforeEach(() => {
      clearBeatCache();

      globalThis.OfflineAudioContext = vi.fn().mockImplementation(function () {
        this.decodeAudioData = vi.fn().mockResolvedValue({
          numberOfChannels: 1,
          length: 88200,
          sampleRate: 44100,
          duration: 2,
          getChannelData: () => new Float32Array(88200),
        });
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      });
    });

    it('removes only the specified src', async () => {
      await detectBeats('file:///a.mp4');
      await detectBeats('file:///b.mp4');
      clearBeatCacheFor('file:///a.mp4');
      expect(getCachedBeats('file:///a.mp4')).toBeNull();
      expect(getCachedBeats('file:///b.mp4')).not.toBeNull();
    });
  });
});
