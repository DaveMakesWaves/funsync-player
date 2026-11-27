/**
 * @vitest-environment jsdom
 *
 * zaikechi #381 (2026-11-22): the Timeline overlay's zoom and a left-anchored
 * playhead. Settings > Playback: "Timeline shows" 5 / 10 / 20 / 30 seconds,
 * and "Timeline playhead" in the middle or near the left (more of what is
 * coming). 5 s, centred, by default: as it always was. The pop-out follows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import {
  InlineViz, normalizeTimelineView, timelineViewport, INLINE_VIEW_MS,
} from '../../renderer/components/inline-viz.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const P = EN.settingsPanel.playback;
const ACTIONS = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 30000, pos: 20 }, { at: 90000, pos: 80 }];

beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('the view, as numbers', () => {
  it('unknown values fall back to 5 s in the middle', () => {
    expect(normalizeTimelineView(null)).toEqual({ windowMs: INLINE_VIEW_MS, anchor: 'centre' });
    expect(normalizeTimelineView({ windowMs: 7000, anchor: 'right' })).toEqual({ windowMs: 5000, anchor: 'centre' });
    expect(normalizeTimelineView({ windowMs: 20000, anchor: 'left' })).toEqual({ windowMs: 20000, anchor: 'left' });
  });

  it('in the middle the playhead is at half the window; near the left at a fifth of it', () => {
    expect(timelineViewport(60000, { windowMs: 10000, anchor: 'centre' })).toEqual({ start: 55000, end: 65000 });
    expect(timelineViewport(60000, { windowMs: 10000, anchor: 'left' })).toEqual({ start: 58000, end: 68000 });
    expect(timelineViewport(60000, null)).toEqual({ start: 57500, end: 62500 });
  });
});

describe('InlineViz draws the window it is given', () => {
  function makeViz() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 60, configurable: true, writable: true });
    const viz = new InlineViz({ container, video });
    viz.setScript(ACTIONS, 120);
    viz.setTimelineVisible(true);
    return { viz, video };
  }
  const view = (viz) => [Math.round(viz._graph._viewStartMs), Math.round(viz._graph._viewEndMs)];

  it('the default is the old 5 s, centred', () => {
    const { viz } = makeViz();
    viz._drawFrame();
    expect(view(viz)).toEqual([57500, 62500]);
  });

  it('20 s near the left: 4 s behind the playhead, 16 s ahead', () => {
    const { viz } = makeViz();
    viz.setTimelineView({ windowMs: 20000, anchor: 'left' });
    viz._drawFrame();
    expect(view(viz)).toEqual([56000, 76000]);
    expect(viz.timelineView).toEqual({ windowMs: 20000, anchor: 'left' });
  });

  it('a new video keeps the chosen window', () => {
    const { viz } = makeViz();
    viz.setTimelineView({ windowMs: 30000, anchor: 'centre' });
    viz.setScript(ACTIONS, 120);
    expect(Math.round(viz._graph.viewDurationMs)).toBe(30000);
  });

  it('at the start of a video the window stays inside it', () => {
    const { viz, video } = makeViz();
    video.currentTime = 1;
    viz.setTimelineView({ windowMs: 10000, anchor: 'centre' });
    viz._drawFrame();
    expect(view(viz)).toEqual([0, 10000]);
  });
});

describe('Settings > Playback', () => {
  it('"Timeline shows" and "Timeline playhead" show the saved values; a change saves them', async () => {
    window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
    const store = new Map([['player.inlineTimelineWindowMs', 20000], ['player.inlineTimelineAnchor', 'left']]);
    const settings = { get: (k) => store.get(k), set: vi.fn((k, v) => store.set(k, v)), getAll: () => ({}) };
    const tab = new SettingsPanel({ settings })._buildPlaybackTab();
    document.body.appendChild(tab);
    await new Promise((r) => setTimeout(r, 0));
    const win = tab.querySelector('#sp-inline-tl-window');
    const anchor = tab.querySelector('#sp-inline-tl-anchor');
    expect([...win.options].map((o) => o.textContent)).toEqual(['5 seconds', '10 seconds', '20 seconds', '30 seconds']);
    expect(win.value).toBe('20000');
    expect([...anchor.options].map((o) => o.textContent)).toEqual([P.inlineTimelineAnchorCentre, P.inlineTimelineAnchorLeft]);
    expect(anchor.value).toBe('left');
    win.value = '10000';
    win.dispatchEvent(new Event('change'));
    anchor.value = 'centre';
    anchor.dispatchEvent(new Event('change'));
    expect(settings.set).toHaveBeenCalledWith('player.inlineTimelineWindowMs', 10000);
    expect(settings.set).toHaveBeenCalledWith('player.inlineTimelineAnchor', 'centre');
    delete window.funsync;
  });

  it('the defaults are 5 s in the middle (electron/store.js)', () => {
    const src = fs.readFileSync('electron/store.js', 'utf8');
    expect(src).toMatch(/inlineTimelineWindowMs: 5000/);
    expect(src).toMatch(/inlineTimelineAnchor: 'centre'/);
  });
});

describe('app.js and the pop-out', () => {
  it('applies the view at start and on a change, and tells an open pop-out', () => {
    const Lifted = liftAppClass(['_wireInlineVizPlacement', '_inlineTimelineView'], { eventBus });
    const store = new Map([['player.inlineTimelineWindowMs', 10000]]);
    const app = Object.assign(new Lifted(), {
      settings: { get: (k) => store.get(k) },
      inlineViz: { setPlacement: vi.fn(), setTimelineView: vi.fn() },
      _sendPlayerWindowInlineVizState: vi.fn(),
    });
    app._wireInlineVizPlacement();
    expect(app.inlineViz.setTimelineView).toHaveBeenLastCalledWith({ windowMs: 10000, anchor: 'centre' });
    store.set('player.inlineTimelineAnchor', 'left');
    eventBus.emit('settings:changed', { path: 'player.inlineTimelineAnchor' });
    expect(app.inlineViz.setTimelineView).toHaveBeenLastCalledWith({ windowMs: 10000, anchor: 'left' });
    expect(app._sendPlayerWindowInlineVizState).toHaveBeenLastCalledWith({ timelineView: { windowMs: 10000, anchor: 'left' } });
  });

  it('the pop-out applies it when it opens and when it changes', () => {
    const src = fs.readFileSync('renderer/player-popout.js', 'utf8');
    expect(src.match(/if \(state\.timelineView\) inlineViz\?\.setTimelineView\?\.\(state\.timelineView\);/g)).toHaveLength(2);
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(app).toMatch(/timelineView: this\._inlineTimelineView\(\),/);
    expect(app).toMatch(/INLINE_VIZ_STATE, \{ playhead, opacity, placement, timelineView \}/);
  });
});
