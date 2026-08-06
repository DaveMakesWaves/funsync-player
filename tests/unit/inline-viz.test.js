// Inline script visualization (zaikechi #209 — TL/HM toggles outside the
// editor). The component is a read-only display overlay: these tests pin
// the visibility state machine (script × toggle gating), the read-only
// ActionGraph shim contract, and that clear() empties everything — the
// editor-side behaviors (pause, Up Next suppression) must never appear
// here by construction.

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineViz } from '../../renderer/components/inline-viz.js';

const ACTIONS = [
  { at: 0, pos: 0 },
  { at: 500, pos: 100 },
  { at: 1000, pos: 20 },
];

function makeViz() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const video = document.createElement('video');
  const viz = new InlineViz({ container, video });
  return { container, video, viz };
}

describe('InlineViz', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('hidden by default — no script, no toggles', () => {
    const { container } = makeViz();
    const root = container.querySelector('.inline-viz');
    expect(root).toBeTruthy();
    expect(root.hidden).toBe(true);
  });

  it('stays hidden with a script until a toggle turns on', () => {
    const { container, viz } = makeViz();
    viz.setScript(ACTIONS, 60);
    expect(container.querySelector('.inline-viz').hidden).toBe(true);
  });

  it('stays hidden with a toggle on until a script loads', () => {
    const { container, viz } = makeViz();
    viz.setTimelineVisible(true);
    expect(container.querySelector('.inline-viz').hidden).toBe(true);
  });

  it('TL and HM toggle independently (the ScriptPlayer+ reference behavior)', () => {
    const { container, viz } = makeViz();
    viz.setScript(ACTIONS, 60);
    viz.setTimelineVisible(true);
    const root = container.querySelector('.inline-viz');
    const tl = container.querySelector('.inline-viz__timeline');
    const hm = container.querySelector('.inline-viz__heatmap');
    expect(root.hidden).toBe(false);
    expect(tl.hidden).toBe(false);
    expect(hm.hidden).toBe(true);

    viz.setHeatmapVisible(true);
    expect(hm.hidden).toBe(false);

    viz.setTimelineVisible(false);
    expect(tl.hidden).toBe(true);
    expect(hm.hidden).toBe(false);
    expect(root.hidden).toBe(false); // HM alone keeps the overlay up

    viz.setHeatmapVisible(false);
    expect(root.hidden).toBe(true);
  });

  it('feeds the read-only ActionGraph shim (actions in, nothing selectable)', () => {
    const { viz } = makeViz();
    viz.setScript(ACTIONS, 60);
    expect(viz._shim.actions).toHaveLength(3);
    expect(viz._shim.selectedIndices.size).toBe(0);
    expect(viz._shim.getBookmarks()).toEqual([]);
  });

  it('rejects unusable scripts (fewer than 2 actions) like no script at all', () => {
    const { container, viz } = makeViz();
    viz.setTimelineVisible(true);
    viz.setScript([{ at: 0, pos: 50 }], 60);
    expect(container.querySelector('.inline-viz').hidden).toBe(true);
    expect(viz._shim.actions).toEqual([]);
  });

  it('clear() empties the shim and hides the overlay, toggles remembered', () => {
    const { container, viz } = makeViz();
    viz.setScript(ACTIONS, 60);
    viz.setHeatmapVisible(true);
    expect(container.querySelector('.inline-viz').hidden).toBe(false);

    viz.clear();
    expect(container.querySelector('.inline-viz').hidden).toBe(true);
    expect(viz._shim.actions).toEqual([]);
    // Toggle state survives — the next video with a script shows HM again.
    viz.setScript(ACTIONS, 60);
    expect(container.querySelector('.inline-viz').hidden).toBe(false);
    expect(viz.heatmapVisible).toBe(true);
  });

  it('destroy() removes the overlay from the DOM', () => {
    const { container, viz } = makeViz();
    viz.destroy();
    expect(container.querySelector('.inline-viz')).toBeNull();
  });
});

// --- Seek while playing must not freeze the timeline (Dave, 2026-08-06) ---
//
// `seeked` shared the `pause` handler, which stopped the rAF loop and drew
// one frame. That is right for a paused seek. For a seek DURING playback it
// killed the loop with nothing to restart it — `play` never fires, because
// the video never paused — so the timeline jumped to the new position and
// froze there while playback continued.
describe('InlineViz seek behaviour', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  /** jsdom's <video> has no real playback; drive `paused` directly. */
  function playingViz() {
    const { container, video, viz } = makeViz();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    viz.setScript(ACTIONS, 60);
    viz.setTimelineVisible(true);
    return { container, video, viz };
  }

  it('resumes the render loop after seeking while playing', () => {
    const { video, viz } = playingViz();
    video.dispatchEvent(new Event('play'));
    expect(viz._raf).not.toBeNull();

    video.dispatchEvent(new Event('seeked'));

    // The regression: this was null, and nothing would ever restart it.
    expect(viz._raf).not.toBeNull();
  });

  it('still leaves the loop stopped when seeking while paused', () => {
    const { container, video, viz } = makeViz();
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    viz.setScript(ACTIONS, 60);
    viz.setTimelineVisible(true);

    video.dispatchEvent(new Event('seeked'));

    expect(viz._raf).toBeNull();
    expect(container.querySelector('.inline-viz').hidden).toBe(false);
  });

  it('stops the loop on pause, as before', () => {
    const { video, viz } = playingViz();
    video.dispatchEvent(new Event('play'));
    expect(viz._raf).not.toBeNull();

    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    video.dispatchEvent(new Event('pause'));

    expect(viz._raf).toBeNull();
  });

  it('does not start a loop on seek when the timeline is off', () => {
    const { video, viz } = playingViz();
    viz.setTimelineVisible(false);

    video.dispatchEvent(new Event('seeked'));

    expect(viz._raf).toBeNull();
  });

  it('unbinds the seek handler on destroy', () => {
    const { video, viz } = playingViz();
    video.dispatchEvent(new Event('play'));
    viz.destroy();

    // The listener removed must be the one that was added — a mismatch
    // would silently leak a handler holding the graph alive.
    video.dispatchEvent(new Event('seeked'));
    expect(viz._raf).toBeNull();
  });
});
