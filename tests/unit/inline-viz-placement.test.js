/**
 * @vitest-environment jsdom
 * jsdom on purpose: InlineViz builds its strip as DOM and branches on
 * `typeof window`, and the REAL SettingsPanel builds the Playback rows
 * (notes/CLAUDE.md "Test environments").
 */
// Timeline and heatmap over the video or under it (zaikechi #381; Dave
// 2026-11-22: "i want the option for either overlay or under video").
// `player.inlineVizPlacement`: 'overlay' (as always, the default) or 'below'.
// Under it, InlineViz marks the player container (.player-container--viz-below)
// and gives it the strip's height (--inline-viz-band); player.css then shortens
// the video and keeps the controls off the strip (checked in the app: jsdom
// has no layout). Asserted: when the container is marked and with what band,
// that nothing is marked while no strip shows, the Settings row, and that
// app.js applies the setting at start and on a change, and tells the pop-out.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { InlineViz } from '../../renderer/components/inline-viz.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ACTIONS = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 3000, pos: 20 }, { at: 9000, pos: 80 }];

beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

function makeViz() {
  const container = document.createElement('div');
  container.className = 'player-container';
  document.body.appendChild(container);
  const video = document.createElement('video');
  const viz = new InlineViz({ container, video });
  // jsdom has no layout: give the strip the height a TL + HM strip has.
  viz._root.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1000, height: 130, right: 1000, bottom: 130 });
  return { container, viz };
}
const below = (c) => c.classList.contains('player-container--viz-below');
const band = (c) => c.style.getPropertyValue('--inline-viz-band');

describe('the queue panel and the strip under the video (full manual test, 2026-11-23)', () => {
  // The control bar is lifted by the strip, and the queue panel (a child of
  // #app, not of the player) ended 100 px from the bottom: docked, the bar's
  // right end (Devices, the menu, Fullscreen) ran under it. InlineViz now
  // gives the page root the band too, and the panel ends above the bar.
  it('the page root carries the band while the strip is below, and loses it when not', () => {
    const { viz } = makeViz();
    const rootBand = () => document.documentElement.style.getPropertyValue('--inline-viz-band-root');
    viz.setScript(ACTIONS, 10);
    viz.setTimelineVisible(true);
    viz.setPlacement('below');
    expect(rootBand()).toBe('130px');
    viz.setPlacement('overlay');
    expect(rootBand()).toBe('');
    viz.setPlacement('below');
    viz.destroy();
    expect(rootBand()).toBe('');
  });

  it('the panel ends above the lifted bar, docked or not, and inside the player in fullscreen', () => {
    const css = fs.readFileSync('renderer/styles/queue-panel.css', 'utf8').replace(/\r\n/g, '\n');
    const rule = (sel) => { const i = css.indexOf(sel + ' {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
    expect(rule('#app[data-view="player"] > .queue-panel')).toContain('bottom: calc(100px + var(--inline-viz-band-root, 0px));');
    expect(rule('.player-container--viz-below:not(.player-container--mini) > .queue-panel')).toContain('bottom: calc(100px + var(--inline-viz-band, 0px));');
  });
});

describe('InlineViz.setPlacement', () => {
  it('under the video: the container is marked, with the strip\'s height as the band', () => {
    const { container, viz } = makeViz();
    viz.setScript(ACTIONS, 10);
    viz.setTimelineVisible(true);
    viz.setHeatmapVisible(true);
    expect(below(container)).toBe(false);          // the default is over the video
    viz.setPlacement('below');
    expect(viz.placement).toBe('below');
    expect(below(container)).toBe(true);
    expect(band(container)).toBe('130px');
    viz.setPlacement('overlay');
    expect(below(container)).toBe(false);
    expect(band(container)).toBe('');
  });

  it('nothing showing (both off, or no script) gives the video the whole player back, and showing again marks it again', () => {
    const { container, viz } = makeViz();
    viz.setPlacement('below');
    expect(below(container)).toBe(false);          // no script yet
    viz.setScript(ACTIONS, 10);
    expect(below(container)).toBe(false);          // TL and HM both off
    viz.setTimelineVisible(true);
    expect(below(container)).toBe(true);
    viz.setTimelineVisible(false);
    expect(below(container)).toBe(false);
    viz.setHeatmapVisible(true);
    expect(below(container)).toBe(true);
    viz.clear();                                   // a video with no script
    expect(below(container)).toBe(false);
    expect(band(container)).toBe('');
  });

  it('anything but "below" is over the video; destroy leaves the container clean', () => {
    const { container, viz } = makeViz();
    viz.setScript(ACTIONS, 10);
    viz.setTimelineVisible(true);
    viz.setPlacement('sideways');
    expect(viz.placement).toBe('overlay');
    viz.setPlacement('below');
    viz.destroy();
    expect(below(container)).toBe(false);
    expect(band(container)).toBe('');
  });
});

describe('Settings > Playback', () => {
  it('"Timeline and heatmap": Over the video / Under the video, showing the saved one; a change saves it', async () => {
    window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
    const store = new Map([['player.inlineVizPlacement', 'below']]);
    const settings = { get: (k) => store.get(k), set: vi.fn((k, v) => store.set(k, v)), getAll: () => ({}) };
    const tab = new SettingsPanel({ settings })._buildPlaybackTab();
    document.body.appendChild(tab);
    await new Promise((r) => setTimeout(r, 0));
    const sel = tab.querySelector('#sp-inline-viz-placement');
    expect([...sel.options].map((o) => o.textContent)).toEqual([EN.settingsPanel.playback.inlineVizPlacementOverlay, EN.settingsPanel.playback.inlineVizPlacementBelow]);
    expect(sel.value).toBe('below');
    expect(tab.querySelector(`label[for="sp-inline-viz-placement"]`).textContent).toBe(EN.settingsPanel.playback.inlineVizPlacementLabel);
    sel.value = 'overlay';
    sel.dispatchEvent(new Event('change'));
    expect(settings.set).toHaveBeenCalledWith('player.inlineVizPlacement', 'overlay');
    delete window.funsync;
  });

  it('the default is over the video (electron/store.js)', () => {
    const src = fs.readFileSync('electron/store.js', 'utf8');
    expect(src).toMatch(/inlineVizPlacement: 'overlay'/);
  });
});

describe('app.js', () => {
  it('applies the setting at start and on a change, and tells an open pop-out', () => {
    const Lifted = liftAppClass(['_wireInlineVizPlacement', '_inlineTimelineView'], { eventBus });
    const store = new Map([['player.inlineVizPlacement', 'below']]);
    const app = Object.assign(new Lifted(), {
      settings: { get: (k) => store.get(k) },
      inlineViz: { setPlacement: vi.fn() },
      _sendPlayerWindowInlineVizState: vi.fn(),
    });
    app._wireInlineVizPlacement();
    expect(app.inlineViz.setPlacement).toHaveBeenLastCalledWith('below');
    store.set('player.inlineVizPlacement', 'overlay');
    eventBus.emit('settings:changed', { path: 'player.inlineVizPlacement' });
    expect(app.inlineViz.setPlacement).toHaveBeenLastCalledWith('overlay');
    expect(app._sendPlayerWindowInlineVizState).toHaveBeenLastCalledWith({ placement: 'overlay' });
    eventBus.emit('settings:changed', { path: 'player.volume' });
    expect(app.inlineViz.setPlacement).toHaveBeenCalledTimes(2);
  });
});

