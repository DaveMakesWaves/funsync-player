import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceSimulator } from '../../renderer/components/device-simulator.js';

describe('DeviceSimulator', () => {
  let sim;
  let mockPlayer;
  let mockFunscript;

  beforeEach(() => {
    // Ensure #app exists for panel append
    if (!document.getElementById('app')) {
      const app = document.createElement('div');
      app.id = 'app';
      document.body.appendChild(app);
    }

    mockPlayer = {
      video: document.createElement('video'),
      currentTime: 0,
      paused: true,
    };

    mockFunscript = {
      isLoaded: true,
      getPositionAt: vi.fn().mockReturnValue(50),
    };

    sim = new DeviceSimulator({
      videoPlayer: mockPlayer,
      funscriptEngine: mockFunscript,
    });
  });

  afterEach(() => {
    sim.hide();
    // Clean up DOM
    const panel = document.querySelector('.device-sim');
    if (panel) panel.remove();
  });

  describe('construction', () => {
    it('starts hidden', () => {
      expect(sim.isVisible).toBe(false);
    });

    it('creates panel element', () => {
      expect(sim._panel).not.toBeNull();
      expect(sim._panel.classList.contains('device-sim')).toBe(true);
    });

    it('panel is hidden in DOM', () => {
      expect(sim._panel.hidden).toBe(true);
    });
  });

  describe('show/hide/toggle', () => {
    it('show makes panel visible', () => {
      sim.show();
      expect(sim.isVisible).toBe(true);
      expect(sim._panel.hidden).toBe(false);
    });

    it('hide makes panel hidden', () => {
      sim.show();
      sim.hide();
      expect(sim.isVisible).toBe(false);
      expect(sim._panel.hidden).toBe(true);
    });

    it('toggle switches visibility', () => {
      sim.toggle();
      expect(sim.isVisible).toBe(true);
      sim.toggle();
      expect(sim.isVisible).toBe(false);
    });

    it('show is idempotent', () => {
      sim.show();
      sim.show();
      expect(sim.isVisible).toBe(true);
    });

    it('hide is idempotent', () => {
      sim.hide();
      sim.hide();
      expect(sim.isVisible).toBe(false);
    });
  });

  describe('getPosition', () => {
    it('returns interpolated position from funscript engine', () => {
      mockFunscript.getPositionAt.mockReturnValue(75);
      mockPlayer.currentTime = 1.5;
      expect(sim.getPosition()).toBe(75);
      expect(mockFunscript.getPositionAt).toHaveBeenCalledWith(1500);
    });

    it('returns 50 when no script loaded', () => {
      mockFunscript.isLoaded = false;
      expect(sim.getPosition()).toBe(50);
    });

    it('calls getPositionAt with correct time in ms', () => {
      mockPlayer.currentTime = 2.5;
      sim.getPosition();
      expect(mockFunscript.getPositionAt).toHaveBeenCalledWith(2500);
    });
  });

  describe('getSpeed', () => {
    it('returns 0 when no time has elapsed', () => {
      expect(sim.getSpeed(50, 0)).toBe(0);
    });

    it('calculates speed as pos-units per second', () => {
      sim._lastPosition = 0;
      sim._lastTimeMs = 0;
      // Position changed 100 units in 500ms = 200 units/sec
      expect(sim.getSpeed(100, 500)).toBe(200);
    });

    it('uses absolute position change', () => {
      sim._lastPosition = 100;
      sim._lastTimeMs = 0;
      // Moved from 100 to 0 in 1000ms = 100 units/sec
      expect(sim.getSpeed(0, 1000)).toBe(100);
    });

    it('returns 0 when position unchanged', () => {
      sim._lastPosition = 50;
      sim._lastTimeMs = 0;
      expect(sim.getSpeed(50, 1000)).toBe(0);
    });

    it('returns 0 for negative time delta', () => {
      sim._lastTimeMs = 1000;
      expect(sim.getSpeed(75, 500)).toBe(0);
    });
  });

  describe('_update', () => {
    it('updates marker position style', () => {
      mockFunscript.getPositionAt.mockReturnValue(80);
      mockPlayer.currentTime = 1;
      sim._lastTimeMs = 500;
      sim._lastPosition = 60;

      sim._update();

      expect(sim._marker.style.bottom).toBe('80%');
      expect(sim._fill.style.height).toBe('80%');
      expect(sim._posLabel.textContent).toBe('80');
    });

    it('clamps position to 0-100%', () => {
      mockFunscript.getPositionAt.mockReturnValue(150);
      mockPlayer.currentTime = 1;
      sim._update();
      expect(sim._marker.style.bottom).toBe('100%');
    });

    it('updates speed label', () => {
      sim._lastPosition = 0;
      sim._lastTimeMs = 0;
      mockFunscript.getPositionAt.mockReturnValue(50);
      mockPlayer.currentTime = 0.5; // 500ms
      sim._update();
      expect(sim._speedLabel.textContent).toBe('100'); // 50 units / 0.5s = 100/s
    });

    it('stores last position and time', () => {
      mockFunscript.getPositionAt.mockReturnValue(30);
      mockPlayer.currentTime = 2;
      sim._update();
      expect(sim._lastPosition).toBe(30);
      expect(sim._lastTimeMs).toBe(2000);
    });
  });
});
