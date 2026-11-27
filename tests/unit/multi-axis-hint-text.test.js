/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Settings > Playback > Multi-Axis said Single "will not revert
// auto-assignments — use Change funscript on individual videos to undo",
// the opposite of what the app does since 2026-11-20: switching to Single
// puts the videos FunSync paired by itself back to their own script (toast
// "Put N videos back to their own script", multi-axis-switch-back.test.js).
// Found in the full manual test, 2026-11-23. The text follows the behaviour.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));

describe('the Multi-Axis hint', () => {
  it('says Single puts FunSync\'s own pairings back, and a set you made stays (en)', () => {
    const hint = bundle('en').settingsPanel.playback.multiHint;
    expect(hint).not.toMatch(/will not revert/i);
    expect(hint).toMatch(/Single axis puts the videos FunSync paired by itself back to their own script/);
    expect(hint).toMatch(/a set you made yourself is never changed/);
  });

  it('every language was rewritten (none keeps the old sentence about Change funscript)', () => {
    const OLD = {
      en: 'Change funscript', de: 'Funscript ändern', es: 'Cambiar funscript', fr: 'Changer de funscript',
    };
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const hint = bundle(l).settingsPanel.playback.multiHint;
      expect(hint.length, l).toBeGreaterThan(40);
      if (OLD[l]) expect(hint, l).not.toContain(OLD[l]);
    }
  });
});
