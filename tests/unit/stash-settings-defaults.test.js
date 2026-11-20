/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The Stash settings group (Stash S1, notes/features/DESIGN-stash-s1.md (c)
// "Store keys"): every default is today's app, nothing Stash anywhere, and
// the API key is NOT a setting (electron/stash-secret.js keeps it in its own
// file, so it never reaches config.json, a snapshot or getAll()).
import { describe, it, expect } from 'vitest';
import { applyDefaults, DEFAULTS } from '../../electron/store.js';

describe('settings.stash defaults', () => {
  it('are off: never set up, no sync on start, no path rules, no trusted certificate, no Stash tag rules', () => {
    expect(DEFAULTS.settings.stash).toEqual({ enabled: false, url: '', syncOnStart: false, pathRules: [], trustedCert: null, useTagRules: false });
  });

  it('hold no key or other secret field', () => {
    for (const name of Object.keys(DEFAULTS.settings.stash)) {
      expect(name).not.toMatch(/key|token|secret|password|cookie/i);
    }
  });

  it('reach an existing install without changing anything stored', () => {
    const merged = applyDefaults({ player: { volume: 80 } }, DEFAULTS.settings);
    expect(merged.stash).toEqual({ enabled: false, url: '', syncOnStart: false, pathRules: [], trustedCert: null, useTagRules: false });
    const chosen = applyDefaults({ stash: { enabled: true, url: 'http://127.0.0.1:9999', pathRules: [] } }, DEFAULTS.settings);
    expect(chosen.stash).toEqual({ enabled: true, url: 'http://127.0.0.1:9999', syncOnStart: false, pathRules: [], trustedCert: null, useTagRules: false });
    // The next lot's opt-in (2026-11-19): an install that ticked it keeps it.
    expect(applyDefaults({ stash: { useTagRules: true } }, DEFAULTS.settings).stash.useTagRules).toBe(true);
  });
});
