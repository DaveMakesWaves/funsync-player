// Unit tests for ProgressBar — imports from real source
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProgressBar } from '../../renderer/js/progress-bar.js';

function createProgressBarDOM() {
  document.body.innerHTML = `
    <div id="progress-container">
      <div id="tooltip-thumbnail"></div>
      <canvas id="heatmap-canvas"></canvas>
    </div>
  `;
}

describe('ProgressBar', () => {
  let bar, mockPlayer;

  beforeEach(() => {
    createProgressBarDOM();
    mockPlayer = {
      video: document.createElement('video'),
    };
    bar = new ProgressBar({
      containerElement: document.getElementById('progress-container'),
      videoPlayer: mockPlayer,
      backendPort: 5123,
    });
  });

  describe('_speedToColor', () => {
    it('returns blue for zero speed', () => {
      const color = bar._speedToColor(0);
      expect(color).toBe('rgb(0, 0, 255)');
    });

    it('returns red for maximum speed (0.5)', () => {
      const color = bar._speedToColor(0.5);
      expect(color).toBe('rgb(255, 0, 0)');
    });

    it('clamps speeds above 0.5', () => {
      const color = bar._speedToColor(1.0);
      expect(color).toBe('rgb(255, 0, 0)');
    });

    it('returns green for medium speed', () => {
      const color = bar._speedToColor(0.25);
      // normalized = 0.5, in green-to-yellow range
      expect(color).toBe('rgb(0, 255, 0)');
    });

    it('returns yellow for medium-high speed', () => {
      const color = bar._speedToColor(0.375);
      // normalized = 0.75
      expect(color).toBe('rgb(255, 255, 0)');
    });

    it('returns cyan-ish for low-medium speed', () => {
      const color = bar._speedToColor(0.0625);
      // normalized = 0.125, in blue-to-cyan range
      expect(color).toMatch(/^rgb\(/);
    });
  });

  describe('thumbnail preview', () => {
    it('does nothing when thumb video is not ready', () => {
      bar.updateThumbnailPreview(5);
      // Should not throw — no thumb video set up
      expect(bar.tooltipThumbnail.style.backgroundImage).toBe('');
    });

    it('queues seek when already seeking', () => {
      bar._thumbReady = true;
      bar._thumbVideo = document.createElement('video');
      bar._thumbSeeking = true;
      bar.updateThumbnailPreview(10);
      expect(bar._thumbPending).toBe(10);
    });

    it('destroyThumbVideo clears state', () => {
      bar._thumbVideo = document.createElement('video');
      document.body.appendChild(bar._thumbVideo);
      bar._thumbReady = true;
      bar._thumbSeeking = true;
      bar._thumbPending = 5;
      bar._destroyThumbVideo();
      expect(bar._thumbVideo).toBeNull();
      expect(bar._thumbReady).toBe(false);
      expect(bar._thumbSeeking).toBe(false);
      expect(bar._thumbPending).toBeNull();
    });
  });

  describe('renderHeatmap', () => {
    it('renders without throwing', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 500, pos: 100 },
        { at: 1000, pos: 50 },
      ];
      // Stub parentElement.getBoundingClientRect
      bar.heatmapCanvas.parentElement.getBoundingClientRect = () => ({ width: 400, height: 10 });
      expect(() => bar.renderHeatmap(actions, 10)).not.toThrow();
    });

    it('stores heatmap data for redraw', () => {
      const actions = [
        { at: 0, pos: 0 },
        { at: 1000, pos: 100 },
      ];
      bar.heatmapCanvas.parentElement.getBoundingClientRect = () => ({ width: 400, height: 10 });
      bar.renderHeatmap(actions, 10);
      expect(bar._heatmapData).toBeTruthy();
      expect(bar._heatmapData.actions).toBe(actions);
      expect(bar._heatmapData.duration).toBe(10);
    });

    it('does nothing with less than 2 actions', () => {
      bar.renderHeatmap([{ at: 0, pos: 0 }], 10);
      expect(bar._heatmapData).toBeNull();
    });

    it('does nothing with null actions', () => {
      bar.renderHeatmap(null, 10);
      expect(bar._heatmapData).toBeNull();
    });
  });

  describe('clearHeatmap', () => {
    it('clears heatmap data', () => {
      bar._heatmapData = { actions: [], duration: 10 };
      bar.clearHeatmap();
      expect(bar._heatmapData).toBeNull();
    });
  });
});
