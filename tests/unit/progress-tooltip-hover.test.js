/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL index.html body, the REAL VideoPlayer and the
 * REAL ProgressBar, built the way app.js builds them; video-player.js and
 * i18n.js branch on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// CB-09: a grey seek-bar hover preview labelled "0:00" sat at the left edge
// of the player after synthetic mouse input over the editor (block B,
// sandbox-1 shots/33-2-extend.png). The preview is shown by CSS on
// `.controls__progress:hover` alone; VideoPlayer only moves it to the cursor
// on mousemove. Hover can begin with no mousemove (the bar moving under a
// still pointer when the editor lifts the controls, or synthetic input), and
// the box then showed where nobody pointed: at `left: auto` (the bar's left
// edge) with the markup's "0:00" and an empty thumbnail.
//
// jsdom has no :hover, so this asserts what decides it now: the preview is
// hidden (computed visibility) until a mousemove has put it at the cursor,
// and hidden again when the pointer leaves.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';

const { VideoPlayer } = await import('../../renderer/js/video-player.js');
const { ProgressBar } = await import('../../renderer/js/progress-bar.js');

const INDEX_BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(fs.readFileSync('renderer/index.html', 'utf8'))[1]
  .replace(/<script[\s\S]*?<\/script>/g, '');

let container;
const tip = () => document.getElementById('progress-tooltip');
const shown = () => getComputedStyle(tip()).visibility !== 'hidden';

beforeEach(() => {
  document.body.innerHTML = INDEX_BODY;
  const video = document.getElementById('video');
  Object.defineProperty(video, 'duration', { value: 120, configurable: true });
  const videoPlayer = new VideoPlayer({
    videoElement: video,
    controlsElement: document.getElementById('controls'),
    containerElement: document.getElementById('player-container'),
  });
  container = document.getElementById('progress-container');
  new ProgressBar({ containerElement: container, videoPlayer, backendPort: 5123 });
  container.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 470, height: 16, right: 1100, bottom: 486 });
});

describe('the seek-bar hover preview shows only where the pointer is (CB-09)', () => {
  it('before any mousemove it is hidden: no box at the left edge with "0:00"', () => {
    expect(tip()).not.toBeNull();
    expect(document.getElementById('tooltip-time').textContent).toBe('0:00'); // the markup's text
    expect(tip().style.left).toBe(''); // never positioned
    expect(shown()).toBe(false);
  });

  it('a pointer entering with no mousemove (mouseover / mouseenter only) does not show it', () => {
    container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 600 }));
    container.dispatchEvent(new MouseEvent('mouseenter', { clientX: 600 }));
    expect(shown()).toBe(false);
  });

  it('a mousemove puts it at the cursor with that time, and shows it', () => {
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 600 }));
    expect(tip().style.left).toBe('50%');
    expect(document.getElementById('tooltip-time').textContent).toBe('1:00');
    expect(shown()).toBe(true);
  });

  it('leaving hides it, so the next hover cannot show the old place until the pointer moves', () => {
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 600 }));
    container.dispatchEvent(new MouseEvent('mouseleave', { clientX: 1200 }));
    expect(shown()).toBe(false);
    container.dispatchEvent(new MouseEvent('mouseenter', { clientX: 150 }));
    expect(shown()).toBe(false);
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150 }));
    expect(tip().style.left).toBe('5%');
    expect(shown()).toBe(true);
  });
});
