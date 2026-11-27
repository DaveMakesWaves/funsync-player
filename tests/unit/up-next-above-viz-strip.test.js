/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// With the timeline and heatmap under the video (Settings > Playback), the
// Up Next card covered the right end of the strip (found in the full manual
// test, 2026-11-23). Like the control bar, it now sits over the video: lifted
// by the strip's height (--inline-viz-band, set by InlineViz). Checked live:
// card bottom 570, strip top 670 at 1280x800.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = (f) => fs.readFileSync(`renderer/styles/${f}`, 'utf8').replace(/\r\n/g, '\n');

describe('the Up Next card with the strip under the video', () => {
  it('is lifted by the strip\'s height; elsewhere it keeps its 100 px', () => {
    const player = css('player.css');
    const at = player.indexOf('.player-container--viz-below:not(.player-container--mini) .up-next {');
    expect(at).toBeGreaterThan(0);
    const rule = player.slice(at, player.indexOf('}', at));
    expect(rule).toContain('bottom: calc(100px + var(--inline-viz-band, 0px));');
    const base = css('up-next.css');
    const b = base.indexOf('\n.up-next {') + 1;
    expect(b).toBeGreaterThan(0);
    expect(base.slice(b, base.indexOf('}', b))).toContain('bottom: 100px;');
  });
});
