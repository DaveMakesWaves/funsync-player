/**
 * @vitest-environment jsdom
 * The Vibrate panel builds DOM (Dave, 2026-11-24). See notes/CLAUDE.md "Test environments".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { openVibratePanel, selectedRun } from '../../renderer/components/vibrate-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const acts = [{ at: 0, pos: 20 }, { at: 1000, pos: 80 }, { at: 2000, pos: 20 }];
let graph; let anchor;
const panel = () => document.querySelector('.vibrate-panel');
const range = (name) => panel().querySelector(`input[name="${name}"]`);

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<button id="b">v</button>';
  anchor = document.getElementById('b');
  graph = { setGhost: vi.fn(), clearGhost: vi.fn(), draw: vi.fn() };
});

function open(sel, extra = {}) {
  return openVibratePanel({
    anchor, graph, getActions: () => acts, getSelected: () => new Set(sel), getMaxSpeed: () => 400,
    onApply: vi.fn(), onRemember: vi.fn(), ...extra,
  });
}

describe('the Vibrate panel', () => {
  it('previews on the graph at once and again as the size moves; Apply hands over the choices and clears the preview', () => {
    const onApply = vi.fn();
    const onRemember = vi.fn();
    open([0, 1], { onApply, onRemember });
    expect(graph.setGhost).toHaveBeenCalledTimes(1);
    const [pts, win] = graph.setGhost.mock.calls[0];
    expect(win).toEqual({ from: 0, to: 1000 });
    expect(pts.length).toBeGreaterThan(2);
    range('size').value = '40';
    range('size').dispatchEvent(new Event('input'));
    // rAF in jsdom: flush it
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      expect(graph.setGhost.mock.calls.length).toBeGreaterThan(1);
      [...panel().querySelectorAll('button')].find((b) => b.textContent === t('editor.vibrate.apply')).click();
      expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ size: 40, maxSpeed: 400 }));
      expect(onRemember).toHaveBeenCalledWith(expect.objectContaining({ size: 40 }));
      expect(graph.clearGhost).toHaveBeenCalled();
      expect(panel()).toBeNull();
    });
  });

  it('Esc closes it with nothing applied', () => {
    const onApply = vi.fn();
    open([0, 1], { onApply });
    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel()).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(graph.clearGhost).toHaveBeenCalled();
  });

  it('without a run of two or more points: says what to do, Apply is off, no preview', () => {
    open([0, 2]);
    expect(panel().querySelector('.vibrate-panel__summary').textContent).toBe(t('editor.vibrate.needRun'));
    expect([...panel().querySelectorAll('button')].find((b) => b.textContent === t('editor.vibrate.apply')).disabled).toBe(true);
    expect(graph.setGhost).not.toHaveBeenCalled();
  });

  it('selectedRun: neighbours only', () => {
    expect(selectedRun(acts, new Set([1, 2]))).toEqual([acts[1], acts[2]]);
    expect(selectedRun(acts, new Set([0, 2]))).toBeNull();
    expect(selectedRun(acts, new Set([1]))).toBeNull();
  });
});

describe('device speed caps (Dave, 2026-11-24)', async () => {
  const { FASTEST_DEVICE_CAP, capAtWindow, DEVICE_SPEEDS } = await import('../../renderer/js/device-speed-caps.js');
  it('the overclocked Handy 2 Pro is the ceiling (640 u/s at full stroke); a narrower window goes faster', () => {
    expect(FASTEST_DEVICE_CAP).toBe(640);
    expect(capAtWindow(DEVICE_SPEEDS.handy2.mmPerSecond, DEVICE_SPEEDS.handy2.strokeMm)).toBe(320);
    expect(capAtWindow(DEVICE_SPEEDS.handy2Pro.mmPerSecond, DEVICE_SPEEDS.handy2Pro.strokeMm)).toBe(360);
    expect(capAtWindow(800, 125, 0.5)).toBe(1280);
  });
  it('the panel warns when the result is faster than the user\'s own limit', () => {
    open([0, 1], { getMaxSpeed: () => FASTEST_DEVICE_CAP, getMarkSpeed: () => 100 });
    range('size').value = '60';
    range('size').dispatchEvent(new Event('input'));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      // On its own line (hands-on pass): not run on after the summary.
      const warnEl = panel().querySelector('.vibrate-panel__warn');
      expect(warnEl.hidden).toBe(false);
      expect(warnEl.textContent).toBe(t('editor.vibrate.overMark', { limit: 100 }));
      expect(panel().querySelector('.vibrate-panel__summary:not(.vibrate-panel__warn)').textContent).not.toContain(t('editor.vibrate.overMark', { limit: 100 }));
    });
  });
});
