// Unit tests for ProgressBar — imports from real source
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProgressBar } from '../../renderer/js/progress-bar.js';

function createProgressBarDOM() {
  document.body.innerHTML = `
    <div id="progress-container">
      <div id="tooltip-thumbnail"></div>
      <canvas id="heatmap-canvas"></canvas>
      <div id="chapter-strip-container" hidden>
        <canvas id="chapter-strip-canvas"></canvas>
      </div>
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

  describe('chapter + bookmark markers', () => {
    it('setMarkers stores empty arrays cleanly', () => {
      bar.setMarkers({ chapters: [], bookmarks: [] });
      expect(bar._chapters).toEqual([]);
      expect(bar._bookmarks).toEqual([]);
    });

    it('setMarkers hides chapter strip when chapters empty', () => {
      bar.setMarkers({ chapters: [], bookmarks: [] });
      expect(bar.chapterStripContainer.hidden).toBe(true);
    });

    it('setMarkers shows chapter strip when chapters present', () => {
      bar.setMarkers({
        chapters: [{ startMs: 0, endMs: 1000, name: 'A', color: '#fff' }],
        bookmarks: [],
      });
      expect(bar.chapterStripContainer.hidden).toBe(false);
    });

    it('setMarkers handles missing fields defensively', () => {
      bar.setMarkers({});  // both arrays missing
      expect(bar._chapters).toEqual([]);
      expect(bar._bookmarks).toEqual([]);
    });

    it('renderChapterStrip does not throw for valid input', () => {
      bar.setMarkers({
        chapters: [
          { startMs: 0, endMs: 1000, name: 'A', color: '#f00' },
          { startMs: 2000, endMs: 4000, name: 'B', color: '#00f' },
        ],
        bookmarks: [],
      });
      bar.chapterStripCanvas.parentElement.getBoundingClientRect = () => ({ width: 400, height: 4 });
      expect(() => bar.renderChapterStrip(10)).not.toThrow();
    });

    it('renderChapterStrip no-ops for zero/negative duration', () => {
      bar.setMarkers({
        chapters: [{ startMs: 0, endMs: 1000, name: 'A', color: '#f00' }],
        bookmarks: [],
      });
      // Just don't throw
      expect(() => bar.renderChapterStrip(0)).not.toThrow();
      expect(() => bar.renderChapterStrip(-1)).not.toThrow();
    });

    it('renderChapterStrip no-ops with empty chapters', () => {
      bar.setMarkers({ chapters: [], bookmarks: [] });
      bar.chapterStripCanvas.parentElement.getBoundingClientRect = () => ({ width: 400, height: 4 });
      // No exception when nothing to draw
      expect(() => bar.renderChapterStrip(10)).not.toThrow();
    });
  });

  describe('resolveHoverMarker', () => {
    beforeEach(() => {
      bar.setMarkers({
        chapters: [
          { startMs: 0,     endMs: 30000, name: 'Scene 1', color: '#f00' },
          { startMs: 30000, endMs: 60000, name: 'Scene 2', color: '#0f0' },
        ],
        bookmarks: [
          { at: 10000, name: 'Beat drop' },
        ],
      });
    });

    it('resolves to chapter when cursor within segment', () => {
      // 400px wide, 60s total → 1px = 150ms; chapter 1 is x=[0, 200]
      const out = bar.resolveHoverMarker(100, 400, 60000);
      expect(out.kind).toBe('chapter');
      expect(out.data.name).toBe('Scene 1');
    });

    it('resolves to bookmark when cursor near tick (C-E24: bookmark wins)', () => {
      // Bookmark at 10000ms → 400 * (10000/60000) = 66.66px. Cursor at 67
      // is within HIT_RADIUS_PX (6) AND inside chapter 1.
      const out = bar.resolveHoverMarker(67, 400, 60000);
      expect(out.kind).toBe('bookmark');
      expect(out.data.name).toBe('Beat drop');
    });

    it('returns null when cursor is in dead zone', () => {
      bar.setMarkers({
        chapters: [{ startMs: 0, endMs: 1000, name: 'X', color: '#f00' }],
        bookmarks: [],
      });
      // 1s chapter on a 10s bar in 400px → chapter is x=[0, 40]
      const out = bar.resolveHoverMarker(200, 400, 10000);
      expect(out).toBeNull();
    });

    it('returns null with zero duration', () => {
      expect(bar.resolveHoverMarker(50, 400, 0)).toBeNull();
    });

    it('returns null with zero width', () => {
      expect(bar.resolveHoverMarker(50, 0, 10000)).toBeNull();
    });
  });
});
