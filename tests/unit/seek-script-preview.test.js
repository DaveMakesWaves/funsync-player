/**
 * @vitest-environment jsdom
 * jsdom: progress-bar.js and i18n.js branch on `typeof window`, and the
 * preview builds DOM inside the hover card (notes/CLAUDE.md "Test
 * environments").
 *
 * The script at the cursor in the seek bar's hover card (powerkool #433,
 * Dave 2026-11-23: "a script timeline preview at the mouse location").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { ProgressBar, scriptAt, scriptWindow, SCRIPT_PREVIEW_HALF_MS } from '../../renderer/js/progress-bar.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ACTIONS = [
  { at: 1000, pos: 0 },
  { at: 2000, pos: 100 },  // 100 units in 1 s: 100 units/s
  { at: 2500, pos: 0 },    // 100 units in 0.5 s: 200 units/s
  { at: 20000, pos: 50 },
];

describe('reading the script at a moment', () => {
  it('position on the straight line between two actions, speed of that stroke in units/s', () => {
    expect(scriptAt(ACTIONS, 1500)).toEqual({ pos: 50, speed: 100 });
    expect(scriptAt(ACTIONS, 2250)).toEqual({ pos: 50, speed: 200 });
  });
  it('before the first action / after the last: that position, standing still', () => {
    expect(scriptAt(ACTIONS, 0)).toEqual({ pos: 0, speed: 0 });
    expect(scriptAt(ACTIONS, 30000)).toEqual({ pos: 50, speed: 0 });
    expect(scriptAt([], 10)).toEqual({ pos: 0, speed: 0 });
  });
  it('the window holds what is drawn, one action either side so the lines reach the edges', () => {
    const win = scriptWindow(ACTIONS, 3000, 1000); // 2000..4000
    expect(win.map((a) => a.at)).toEqual([2000, 2500, 20000]);
    expect(scriptWindow(ACTIONS, 1500, SCRIPT_PREVIEW_HALF_MS).map((a) => a.at)).toEqual([1000, 2000, 2500, 20000]);
  });
});

describe('the hover card', () => {
  beforeEach(() => {
    _setBundlesForTests('en', EN, EN);
    document.body.innerHTML = `<div id="progress-container"><div id="progress-tooltip">
      <div id="tooltip-thumbnail"></div><div id="tooltip-time">0:00</div></div></div>`;
  });

  function bar() {
    return new ProgressBar({ containerElement: document.getElementById('progress-container'), videoPlayer: {}, backendPort: 0 });
  }

  it('shows the graph and the readout between the frame and the time, when a script is loaded', () => {
    const pb = bar();
    pb._heatmapData = { actions: ACTIONS, duration: 30 };
    pb.updateScriptPreview(1.5);
    const box = document.querySelector('.tooltip__script');
    expect(box.hidden).toBe(false);
    expect(box.nextElementSibling.id).toBe('tooltip-time');
    expect(box.previousElementSibling.id).toBe('tooltip-thumbnail');
    expect(box.querySelector('canvas')).not.toBeNull();
    expect(box.querySelector('.tooltip__script-readout').textContent).toBe('50% · 100 units/s');
    pb.updateScriptPreview(2.25);
    expect(document.querySelectorAll('.tooltip__script')).toHaveLength(1); // built once
    expect(box.querySelector('.tooltip__script-readout').textContent).toBe('50% · 200 units/s');
  });

  it('hidden with no script, or once the script is cleared', () => {
    const pb = bar();
    pb.updateScriptPreview(1);
    expect(document.querySelector('.tooltip__script').hidden).toBe(true);
    pb._heatmapData = { actions: ACTIONS, duration: 30 };
    pb.updateScriptPreview(1);
    expect(document.querySelector('.tooltip__script').hidden).toBe(false);
    pb.clearHeatmap();
    pb.updateScriptPreview(1);
    expect(document.querySelector('.tooltip__script').hidden).toBe(true);
  });

  it('both players ask for it on hover, and the readout is in every language', () => {
    expect(fs.readFileSync('renderer/js/app.js', 'utf8')).toMatch(/this\.progressBar\.updateThumbnailPreview\(time\);\s+\/\/ The script at the cursor[^\n]*\n\s+this\.progressBar\.updateScriptPreview\?\.\(time\);/);
    expect(fs.readFileSync('renderer/player-popout.js', 'utf8')).toMatch(/progressBar\.updateScriptPreview\?\.\(timeSeconds\);/);
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const j = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
      expect(j.player.scriptPreview.readout, l).toMatch(/^\{pos\}% · .*\{speed\}/);
    }
  });
});
