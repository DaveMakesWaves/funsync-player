/**
 * @vitest-environment jsdom
 * jsdom on purpose: DeviceSimulator builds its panel on the DOM
 * (notes/CLAUDE.md "Test environments").
 */
// The device simulator's speed read-out while a live loop drives the devices
// on its own clock (X, an Edge Hold pattern): on a paused video it said 0/s
// while its bar followed the loop (live verifier 2026-11-17). The speed is
// measured on the wall clock while a loop is live, on the video's otherwise.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeviceSimulator } from '../../renderer/components/device-simulator.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelector('.device-sim')?.remove();
});

function make() {
  if (!document.getElementById('app')) {
    const app = document.createElement('div');
    app.id = 'app';
    document.body.appendChild(app);
  }
  const player = { video: document.createElement('video'), currentTime: 40, paused: true };
  const funscript = { isLoaded: true, getPositionAt: vi.fn(() => 50) };
  return new DeviceSimulator({ videoPlayer: player, funscriptEngine: funscript });
}

describe('the simulator\'s speed while a loop plays on a paused video', () => {
  for (const which of ['edgeLoop', 'orgasmSwitch']) {
    it(`${which}: the read-out shows the loop's speed, not 0/s`, () => {
      const sim = make();
      const loop = { livePosition: 58 };
      sim[which] = loop;
      let now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      sim._update();
      now += 100;
      loop.livePosition = 67;                                // 9 units in 100 ms
      sim._update();
      expect(sim._posLabel.textContent).toBe('67');
      expect(sim._speedLabel.textContent).toBe('90');
      // The loop moves once per 40 ms tick; a frame in between sees no
      // change and keeps the speed (seen live: it read 0/s most frames).
      now += 16;
      sim._update();
      expect(sim._speedLabel.textContent).toBe('90');
      now += 24;
      loop.livePosition = 71;                                // 4 units since the last change, 40 ms ago
      sim._update();
      expect(sim._speedLabel.textContent).toBe('100');
      // A loop that holds still for longer reads 0 again.
      now += 300;
      sim._update();
      expect(sim._speedLabel.textContent).toBe('0');
    });
  }

  it('no loop: the video\'s clock as before (a paused video reads 0/s)', () => {
    const sim = make();
    vi.spyOn(performance, 'now').mockImplementation(() => 5000);
    sim._update();
    sim._update();
    expect(sim._speedLabel.textContent).toBe('0');
  });
});
