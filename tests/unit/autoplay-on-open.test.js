/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// `player.autoplayOnOpen` (jwonone, EroScripts #322):
//
//   "when I select a file from the library, it switches to the player page,
//    but does not start playing. Instead I must manually hit the play button"
//
// Loading paused on a direct click is deliberate — a single click should not
// set a device moving — so this is opt-in, and the DEFAULT staying false is
// part of the contract, not an implementation detail.
//
// The load path is a ~200-line method on a class that needs the whole app to
// construct, so these test the two things that actually carry the risk: the
// setting's default in the copy the app reads, and the fact that the flag is
// OR-ed into `autoPlayOnLoad` rather than played separately. That second one
// matters more than it looks — everything downstream keys off that flag,
// including the cloud-upload gate that stops the video racing ahead of a
// Handy/Autoblow script upload. A bolted-on `.play()` would skip it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('autoplayOnOpen — setting', () => {
  it('defaults to false in the store, which is what the app reads', async () => {
    const { DEFAULTS } = await import('../../electron/store.js');
    expect(DEFAULTS.settings.player.autoplayOnOpen).toBe(false);
  });

  it('agrees with the settings-panel fallback constant', async () => {
    const { DEFAULTS } = await import('../../electron/store.js');
    const src = fs.readFileSync('renderer/components/settings-panel.js', 'utf8');
    const m = src.match(/'player\.autoplayOnOpen':\s*(true|false)/);
    expect(m, 'SETTINGS_DEFAULTS is missing player.autoplayOnOpen').not.toBeNull();
    expect(m[1] === 'true').toBe(DEFAULTS.settings.player.autoplayOnOpen);
  });

  it('is a SEPARATE key from autoplayOnAdvance', async () => {
    // Up Next advances and direct library clicks are different decisions;
    // collapsing them would silently change auto-advance behaviour for
    // everyone who only wanted click-to-play.
    const { DEFAULTS } = await import('../../electron/store.js');
    expect(DEFAULTS.settings.player).toHaveProperty('autoplayOnAdvance');
    expect(DEFAULTS.settings.player).toHaveProperty('autoplayOnOpen');
  });
});

describe('autoplayOnOpen — wiring', () => {
  const appSrc = fs.readFileSync('renderer/js/app.js', 'utf8');

  it('feeds the existing autoPlayOnLoad flag rather than calling play() itself', () => {
    // The cloud-upload gate, the resume seek and the sync-engine anchor all
    // hang off `autoPlayOnLoad`. Routing through it is the whole point.
    const decl = appSrc.match(/const autoPlayOnLoad = [^;]+;/);
    expect(decl, 'autoPlayOnLoad declaration not found').not.toBeNull();
    expect(decl[0]).toContain('_autoPlayOnLoad');
    expect(decl[0]).toContain('player.autoplayOnOpen');
  });

  it('requires an explicit true, so a missing key cannot switch it on', () => {
    const decl = appSrc.match(/const autoPlayOnLoad = [^;]+;/)[0];
    expect(decl).toMatch(/player\.autoplayOnOpen'\)\s*===\s*true/);
  });

  it('still honours the per-video flag on its own', () => {
    // Up Next advances set `_autoPlayOnLoad` directly and must keep working
    // with the new setting off.
    const decl = appSrc.match(/const autoPlayOnLoad = [^;]+;/)[0];
    expect(decl).toMatch(/!!videoData\?\._autoPlayOnLoad/);
  });
});

describe('autoplayOnOpen — UI', () => {
  const panelSrc = fs.readFileSync('renderer/components/settings-panel.js', 'utf8');

  it('has a checkbox that persists the setting', () => {
    expect(panelSrc).toContain('sp-autoplay-on-open');
    expect(panelSrc).toMatch(/set\('player\.autoplayOnOpen'/);
  });

  it('wires its reset button, so the control is not decorative', () => {
    // A visible reset that does nothing is its own bug — several have shipped
    // that way in this file's history.
    expect(panelSrc).toMatch(/wireDefaultCheckbox\(\s*panel\.querySelector\('#sp-autoplay-on-open'\)/);
  });
});
