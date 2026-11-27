/**
 * @vitest-environment jsdom
 * jsdom: the real stylesheets are loaded into a document and the cascade
 * decides which rule wins (jsdom matches selectors and orders them by
 * specificity; calc() / var() come back as written, which is what is compared).
 */
// Fit-on-screen pass (2026-11-24). With the script strip set to sit under the
// video (Settings > Playback), its rules (more specific) beat the open
// editor's: the video kept its full height and the control bar sat behind the
// editor. And in the mini player (the editor hidden) the toasts were still
// lifted over an editor that was not on screen. Asserted on the declaration
// that wins for a real element in each state.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';

const css = ['renderer/styles/player.css', 'renderer/styles/editor.css', 'renderer/styles/queue-panel.css'].map((p) => fs.readFileSync(p, 'utf8')).join('\n');

function mount(containerClasses) {
  document.head.innerHTML = '';
  document.body.className = '';
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = `
    <div id="app" data-view="player">
      <div id="player-container" class="player-container ${containerClasses}">
        <div class="player__video-wrapper"><video class="player__video"></video></div>
        <div class="player__controls"></div>
      </div>
      <div class="queue-panel"></div>
    </div>
    <div class="toast-container"></div>`;
  return {
    wrapper: document.querySelector('.player__video-wrapper'),
    controls: document.querySelector('.player__controls'),
    toasts: document.querySelector('.toast-container'),
    queue: document.querySelector('.queue-panel'),
  };
}
const squash = (v) => String(v).replace(/\s+/g, ' ').trim();

let supportsHas = true;
beforeAll(() => {
  try { document.querySelector(':has(*)'); } catch { supportsHas = false; }
});

describe('the open editor wins over the strip under the video', () => {
  it('the video ends at the editor and the control bar sits on it', () => {
    const { wrapper, controls } = mount('player-container--viz-below player-container--editor-open');
    expect(squash(getComputedStyle(wrapper).height)).toBe('calc(100vh - 250px - var(--editor-toolbar-extra, 0px))');
    expect(squash(getComputedStyle(controls).bottom)).toBe('calc(250px + var(--editor-toolbar-extra, 0px))');
  });
  it('the editor closed: the strip\'s layout again', () => {
    const { wrapper, controls } = mount('player-container--viz-below');
    expect(squash(getComputedStyle(wrapper).height)).toBe('calc(100% - var(--inline-viz-band, 0px))');
    expect(squash(getComputedStyle(controls).bottom)).toBe('var(--inline-viz-band, 0px)');
  });
});

describe('toasts and the docked editor', () => {
  it('lifted over the open editor, never off the top', () => {
    if (!supportsHas) return;
    const { toasts } = mount('player-container--editor-open');
    expect(squash(getComputedStyle(toasts).bottom)).toBe('min(calc(330px + var(--editor-toolbar-extra, 0px)), calc(100vh - 64px))');
  });
  it('not in the mini player (the editor is hidden there)', () => {
    if (!supportsHas) return;
    const { toasts } = mount('player-container--editor-open player-container--mini');
    expect(getComputedStyle(toasts).bottom).toBe('80px');
  });
});

describe('the queue panel and the docked editor', () => {
  it('ends above the control bar on the editor (it ran down behind the editor)', () => {
    if (!supportsHas) return;
    const { queue } = mount('player-container--editor-open');
    expect(squash(getComputedStyle(queue).bottom)).toBe('calc(350px + var(--editor-toolbar-extra, 0px))');
  });
  it('the editor closed, or the mini player: above the bar at the bottom, as before', () => {
    if (!supportsHas) return;
    expect(squash(getComputedStyle(mount('').queue).bottom)).toBe('calc(100px + var(--inline-viz-band-root, 0px))');
    expect(squash(getComputedStyle(mount('player-container--editor-open player-container--mini').queue).bottom)).toBe('calc(100px + var(--inline-viz-band-root, 0px))');
  });
});
