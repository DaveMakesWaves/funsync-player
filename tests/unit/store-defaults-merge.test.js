/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Store defaults must reach EXISTING installs, not just fresh ones.
//
// electron-conf seeds `defaults` only when the config file does not exist.
// Once `config.json` has a `settings.player` object, a new key added under it
// in DEFAULTS is never merged in and `conf.get()` returns undefined for it
// forever. Verified on a live app 2026-08-25: keys written to the file read
// back fine; `player.rangeLivePreview`, `player.hwVideoDecode`,
// `player.randomVariantOnPlay` and `library.showResumeProgress` all returned
// undefined despite being declared.
//
// It bites unevenly, which is how it survived. `get(x) === true` gets the
// intended default from undefined by luck; `player.preferMultiAxis` is read as
// `!== 'multi'`, so undefined fails it and multi-axis auto-promotion stayed
// off for every existing user even after the default was "fixed" (stingray).
//
// `applyDefaults` is pure, so it is tested directly. The destructive cases
// matter most: a merge that resurrects deleted entries or overwrites falsy
// values would be a worse bug than the one it fixes.
import { describe, it, expect } from 'vitest';
import { applyDefaults, DEFAULTS } from '../../electron/store.js';

describe('applyDefaults', () => {
  it('fills a key the stored config has never seen', () => {
    const out = applyDefaults({ player: { volume: 80 } }, { player: { volume: 50, newKey: true } });
    expect(out.player.newKey).toBe(true);
    expect(out.player.volume).toBe(80);
  });

  it('fills a whole branch that is absent', () => {
    const out = applyDefaults({ player: {} }, { player: {}, security: { hideLogFileNames: false } });
    expect(out.security).toEqual({ hideLogFileNames: false });
  });

  it('NEVER overwrites a stored falsy value', () => {
    // false/0/'' are real choices. Treating them as missing would silently
    // undo the user's settings on every read.
    const out = applyDefaults(
      { player: { a: false, b: 0, c: '', d: null } },
      { player: { a: true, b: 99, c: 'x', d: { nested: 1 } } },
    );
    expect(out.player).toEqual({ a: false, b: 0, c: '', d: null });
  });

  it('takes arrays whole and never merges them element-wise', () => {
    // A user who cleared their sources must not get the defaults back.
    const out = applyDefaults({ library: { sources: [] } }, { library: { sources: ['a', 'b'] } });
    expect(out.library.sources).toEqual([]);
  });

  it('does not resurrect keys deleted from a user map', () => {
    // associations/customThumbnails default to {} — merging must add nothing.
    const out = applyDefaults(
      { library: { associations: { '/kept.mp4': 'x' } } },
      { library: { associations: {} } },
    );
    expect(out.library.associations).toEqual({ '/kept.mp4': 'x' });
  });

  it('deep-clones filled values, so callers cannot mutate DEFAULTS', () => {
    const defaults = { library: { sources: ['a'] } };
    const out = applyDefaults({}, defaults);
    out.library.sources.push('b');
    expect(defaults.library.sources).toEqual(['a']);
  });

  it('returns the stored value untouched when there is no default for it', () => {
    const out = applyDefaults({ player: { custom: 7 } }, { player: {} });
    expect(out.player.custom).toBe(7);
  });

  it('handles a completely empty stored config', () => {
    const out = applyDefaults(undefined, { player: { volume: 80 } });
    expect(out).toEqual({ player: { volume: 80 } });
  });

  it('does not descend into a stored value that is no longer an object', () => {
    // Corrupt/legacy shapes must pass through rather than throw.
    expect(applyDefaults({ player: 'legacy-string' }, { player: { volume: 80 } }))
      .toEqual({ player: 'legacy-string' });
  });
});

// The case that actually shipped broken, spelled out.
describe('the preferMultiAxis regression', () => {
  it('resolves to multi on a config that predates the setting', () => {
    // stingray's config.json had no preferMultiAxis at all.
    const legacy = { player: { volume: 80, theme: 'dark' } };
    const merged = applyDefaults(legacy, DEFAULTS.settings);
    expect(merged.player.preferMultiAxis).toBe('multi');
    // The promoter's actual guard. undefined fails this; 'multi' passes.
    expect(merged.player.preferMultiAxis !== 'multi').toBe(false);
  });

  it('still respects an explicit single the user chose', () => {
    const chosen = { player: { preferMultiAxis: 'single' } };
    expect(applyDefaults(chosen, DEFAULTS.settings).player.preferMultiAxis).toBe('single');
  });

  it('covers every default under settings, not just the ones we remembered', () => {
    const merged = applyDefaults({ player: { volume: 80 } }, DEFAULTS.settings);
    const missing = [];
    const walk = (def, got, path) => {
      for (const [k, v] of Object.entries(def)) {
        const here = path ? `${path}.${k}` : k;
        if (got?.[k] === undefined) { missing.push(here); continue; }
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, got[k], here);
      }
    };
    walk(DEFAULTS.settings, merged, '');
    expect(missing).toEqual([]);
  });
});
