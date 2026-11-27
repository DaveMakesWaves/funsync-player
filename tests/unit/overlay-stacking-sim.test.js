/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Break-it, 2026-11-25: with the device simulator parked in the bottom-right
// corner, the Up Next card ("End of list") came up under it: its Dismiss (×)
// was covered by the 3D picture (z-index 16 under 50) and a real click on it
// hit the simulator. The Skip gap button sits in the same corner (z 15). Both
// are short-lived and carry buttons: they go over the simulator, as the
// player's own buttons do (z 51, 2026-11-24).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = ['renderer/styles/player.css', 'renderer/styles/up-next.css'].map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** The z-index of the first rule whose selector is exactly `sel`. */
function zOf(sel) {
  const at = css.search(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
  expect(at, `rule ${sel}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf('}', at));
  const m = body.match(/z-index:\s*(\d+)/);
  expect(m, `${sel} has a z-index`).toBeTruthy();
  return Number(m[1]);
}

describe('short-lived player overlays go over the device simulator', () => {
  it('the Up Next card and the Skip gap button sit above the simulator; the card over Skip gap, as before', () => {
    const sim = zOf('.device-sim');
    expect(zOf('.up-next')).toBeGreaterThan(sim);
    expect(zOf('.gap-skip')).toBeGreaterThan(sim);
    expect(zOf('.up-next')).toBeGreaterThan(zOf('.gap-skip'));
  });

  // The same pass, 20 minutes later: with the card raised, the ⋮ menu (30)
  // opened UNDER it (Picture-in-Picture and Pop out player hidden), and the
  // control bar's popovers lost to a parked simulator (50) wherever they met.
  // What you open goes over the passive overlays.
  it('the control bar\'s menus and popovers open over the Up Next card, Skip gap and the simulator', () => {
    const top = Math.max(zOf('.up-next'), zOf('.gap-skip'), zOf('.device-sim'));
    for (const sel of ['.controls-overflow__menu', '.speed-popover', '.variant-selector__dropdown', '.player__quality-menu']) {
      expect(zOf(sel), sel).toBeGreaterThan(top);
    }
    // The speed submenu opens from the ⋮ menu: still above it.
    expect(zOf('.speed-popover')).toBeGreaterThan(zOf('.controls-overflow__menu'));
  });
});
