// Tests for the multi-axis auto-promotion feature on Library.
// Calls the real Library prototype methods against a hand-rolled `this`
// with the minimum state each method actually reads. This pins behavior
// against the live source without spinning up the full component.
//
// Test matrix sourced from `notes/features/SCOPE-multi-axis-default.md` §3.
import { describe, it, expect, beforeEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

function mockSettings(initial = {}) {
  const store = { ...initial };
  return {
    get(key) { return store[key]; },
    set(key, value) { store[key] = value; },
    _store: store,
  };
}

function makeContext({
  videos = [],
  allFunscripts = [],
  preferMultiAxis = 'single',
  associations = {},
} = {}) {
  // `_reapplyAutoPromotion` calls `this._autoPromoteEligibleVideos`, so
  // wire those Library prototype methods onto the duck-typed context so
  // method-to-method dispatch resolves correctly under .call().
  return {
    _videos: videos,
    _allFunscripts: allFunscripts,
    _settings: mockSettings({
      'player.preferMultiAxis': preferMultiAxis,
      'library.associations': associations,
    }),
    _autoPromoteEligibleVideos: Library.prototype._autoPromoteEligibleVideos,
    _countAutoPromotionEligible: Library.prototype._countAutoPromotionEligible,
    _reapplyAutoPromotion: Library.prototype._reapplyAutoPromotion,
  };
}

const promote = Library.prototype._autoPromoteEligibleVideos;
const count = Library.prototype._countAutoPromotionEligible;
const reapply = Library.prototype._reapplyAutoPromotion;

describe('Library._autoPromoteEligibleVideos', () => {
  it('is a no-op when preference is single', () => {
    const ctx = makeContext({
      preferMultiAxis: 'single',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {};
    const promoted = promote.call(ctx, associations);
    expect(promoted).toBe(0);
    expect(associations).toEqual({});
    expect(ctx._videos[0]._multiAxis).toBeUndefined();
  });

  it('promotes a video with companions and active === null', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
        { name: 'a.surge.funscript', path: '/lib/a.surge.funscript' },
      ],
    });
    const associations = {};
    const promoted = promote.call(ctx, associations);
    expect(promoted).toBe(1);
    expect(associations['/lib/a.mp4'].active).toBe('multi');
    expect(associations['/lib/a.mp4'].multi.main).toBe('/lib/a.funscript');
    expect(associations['/lib/a.mp4'].multi.axes.twist).toBe('/lib/a.twist.funscript');
    expect(associations['/lib/a.mp4'].multi.axes.surge).toBe('/lib/a.surge.funscript');
    expect(associations['/lib/a.mp4'].multi.buttplugVib).toBe(false);
    // Mirror updates the in-memory video for immediate playback.
    expect(ctx._videos[0]._multiAxis).toBeDefined();
    expect(ctx._videos[0]._manualAssociation).toBe(true);
  });

  it('skips videos with no detected companions', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [{ name: 'a.funscript', path: '/lib/a.funscript' }],
    });
    const associations = {};
    expect(promote.call(ctx, associations)).toBe(0);
    expect(associations).toEqual({});
  });

  it('skips videos with active === "single" (sacred)', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {
      '/lib/a.mp4': { active: 'single', single: '/lib/a.funscript', multi: null, custom: null },
    };
    expect(promote.call(ctx, associations)).toBe(0);
    expect(associations['/lib/a.mp4'].active).toBe('single');
  });

  it('skips videos with active === "custom" (sacred)', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {
      '/lib/a.mp4': {
        active: 'custom',
        single: null,
        multi: null,
        custom: { routes: [{ deviceId: 'd1', scriptPath: '/lib/a.funscript', role: 'main' }] },
      },
    };
    expect(promote.call(ctx, associations)).toBe(0);
    expect(associations['/lib/a.mp4'].active).toBe('custom');
  });

  it('skips videos with active === "multi" already (no-op)', () => {
    const existingMulti = { main: '/lib/a.funscript', axes: { twist: '/lib/a.twist.funscript' }, buttplugVib: true };
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {
      '/lib/a.mp4': { active: 'multi', single: null, multi: existingMulti, custom: null },
    };
    expect(promote.call(ctx, associations)).toBe(0);
    // Existing config is untouched (buttplugVib stays true even though
    // synth would default to false).
    expect(associations['/lib/a.mp4'].multi.buttplugVib).toBe(true);
  });

  it('skips videos without a main funscript path (vib-only edge case)', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: false,
        funscriptPath: null,
      }],
      allFunscripts: [
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {};
    expect(promote.call(ctx, associations)).toBe(0);
    expect(associations).toEqual({});
  });

  it('promotes multiple eligible videos in one pass', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [
        { path: '/lib/a.mp4', hasFunscript: true, funscriptPath: '/lib/a.funscript' },
        { path: '/lib/b.mp4', hasFunscript: true, funscriptPath: '/lib/b.funscript' },
        { path: '/lib/c.mp4', hasFunscript: true, funscriptPath: '/lib/c.funscript' },
      ],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
        { name: 'b.funscript', path: '/lib/b.funscript' },
        { name: 'b.surge.funscript', path: '/lib/b.surge.funscript' },
        // c has no companions
        { name: 'c.funscript', path: '/lib/c.funscript' },
      ],
    });
    const associations = {};
    const promoted = promote.call(ctx, associations);
    expect(promoted).toBe(2);
    expect(associations['/lib/a.mp4'].active).toBe('multi');
    expect(associations['/lib/b.mp4'].active).toBe('multi');
    expect(associations['/lib/c.mp4']).toBeUndefined();
  });

  it('is idempotent — second pass over same state promotes 0', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {};
    expect(promote.call(ctx, associations)).toBe(1);
    expect(promote.call(ctx, associations)).toBe(0);
  });

  it('handles empty library gracefully', () => {
    const ctx = makeContext({ preferMultiAxis: 'multi', videos: [], allFunscripts: [] });
    expect(promote.call(ctx, {})).toBe(0);
  });

  it('does not double-write when no funscripts exist in library', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [], // no scripts at all
    });
    const associations = {};
    expect(promote.call(ctx, associations)).toBe(0);
  });
});

describe('Library._countAutoPromotionEligible', () => {
  it('returns count without mutating settings or videos', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [
        { path: '/lib/a.mp4', hasFunscript: true, funscriptPath: '/lib/a.funscript' },
        { path: '/lib/b.mp4', hasFunscript: true, funscriptPath: '/lib/b.funscript' },
      ],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
        { name: 'b.funscript', path: '/lib/b.funscript' },
      ],
    });
    const before = JSON.stringify(ctx._settings._store);
    const c = count.call(ctx);
    expect(c).toBe(1);
    expect(JSON.stringify(ctx._settings._store)).toBe(before);
    expect(ctx._videos[0]._multiAxis).toBeUndefined();
  });

  it('counts correctly even when preference is single (used for confirmation modal)', () => {
    const ctx = makeContext({
      preferMultiAxis: 'single',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    expect(count.call(ctx)).toBe(1);
  });

  it('excludes already-set videos from the count', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [
        { path: '/lib/a.mp4', hasFunscript: true, funscriptPath: '/lib/a.funscript' },
        { path: '/lib/b.mp4', hasFunscript: true, funscriptPath: '/lib/b.funscript' },
      ],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
        { name: 'b.funscript', path: '/lib/b.funscript' },
        { name: 'b.surge.funscript', path: '/lib/b.surge.funscript' },
      ],
      associations: {
        '/lib/b.mp4': { active: 'single', single: '/lib/b.funscript', multi: null, custom: null },
      },
    });
    expect(count.call(ctx)).toBe(1); // only a, b is sacred
  });

  it('returns 0 when no eligible videos', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [{ name: 'a.funscript', path: '/lib/a.funscript' }],
    });
    expect(count.call(ctx)).toBe(0);
  });
});

describe('Library._reapplyAutoPromotion', () => {
  it('writes back to settings only when promotions occurred', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const promoted = reapply.call(ctx);
    expect(promoted).toBe(1);
    const stored = ctx._settings.get('library.associations');
    expect(stored['/lib/a.mp4'].active).toBe('multi');
  });

  it('returns 0 when preference is single', () => {
    const ctx = makeContext({
      preferMultiAxis: 'single',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    expect(reapply.call(ctx)).toBe(0);
    // No promotion writes — associations map stays empty.
    expect(Object.keys(ctx._settings.get('library.associations') || {})).toHaveLength(0);
  });

  it('does not write when no promotions occurred', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [{ name: 'a.funscript', path: '/lib/a.funscript' }],
    });
    expect(reapply.call(ctx)).toBe(0);
    expect(Object.keys(ctx._settings.get('library.associations') || {})).toHaveLength(0);
  });

  it('toggle-off → toggle-on cycle re-promotes only newly-eligible videos', () => {
    // Initial state: 2 videos eligible.
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [
        { path: '/lib/a.mp4', hasFunscript: true, funscriptPath: '/lib/a.funscript' },
        { path: '/lib/b.mp4', hasFunscript: true, funscriptPath: '/lib/b.funscript' },
      ],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
        { name: 'b.funscript', path: '/lib/b.funscript' },
        { name: 'b.surge.funscript', path: '/lib/b.surge.funscript' },
      ],
    });
    expect(reapply.call(ctx)).toBe(2);

    // Toggle off — preference flips, but writes are sacred.
    ctx._settings.set('player.preferMultiAxis', 'single');
    expect(reapply.call(ctx)).toBe(0);

    // Add a new video to the library.
    ctx._videos.push({ path: '/lib/c.mp4', hasFunscript: true, funscriptPath: '/lib/c.funscript' });
    ctx._allFunscripts.push(
      { name: 'c.funscript', path: '/lib/c.funscript' },
      { name: 'c.twist.funscript', path: '/lib/c.twist.funscript' },
    );

    // Toggle back on — only the new video gets promoted.
    ctx._settings.set('player.preferMultiAxis', 'multi');
    expect(reapply.call(ctx)).toBe(1);

    const stored = ctx._settings.get('library.associations');
    expect(stored['/lib/a.mp4'].active).toBe('multi');
    expect(stored['/lib/b.mp4'].active).toBe('multi');
    expect(stored['/lib/c.mp4'].active).toBe('multi');
  });
});

describe('Library auto-promotion + user reverts via modal', () => {
  it('user reverts a promoted video to single; subsequent re-toggle does NOT re-promote', () => {
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });

    // First promotion.
    expect(reapply.call(ctx)).toBe(1);

    // User opens modal, sets to Single (mutates association directly).
    const stored = ctx._settings.get('library.associations');
    stored['/lib/a.mp4'] = {
      active: 'single',
      single: '/lib/a.funscript',
      multi: stored['/lib/a.mp4'].multi, // saved multi pane state preserved
      custom: null,
    };
    ctx._settings.set('library.associations', stored);

    // Re-toggle off → on.
    ctx._settings.set('player.preferMultiAxis', 'single');
    ctx._settings.set('player.preferMultiAxis', 'multi');

    // No re-promotion because active is now 'single' (sacred).
    expect(reapply.call(ctx)).toBe(0);
    expect(ctx._settings.get('library.associations')['/lib/a.mp4'].active).toBe('single');
  });
});

describe('Library._autoPromoteEligibleVideos — round-trip carry-over', () => {
  it('persists the auto-paired funscript into the single slot when promoting', () => {
    // Bug repro: pre-fix, auto-promote wrote `single: null` even when the
    // video had an auto-paired funscript. Switching the modal back to Single
    // then showed "No script associated" and the fuzzy search couldn't
    // surface the script (matched scripts aren't in `_unmatchedFunscripts`).
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {};
    const promoted = promote.call(ctx, associations);

    expect(promoted).toBe(1);
    expect(associations['/lib/a.mp4'].active).toBe('multi');
    // The carry-over: the single slot is populated with the auto-pair so
    // a future switch back to single is lossless.
    expect(associations['/lib/a.mp4'].single).toBe('/lib/a.funscript');
    expect(associations['/lib/a.mp4'].multi.main).toBe('/lib/a.funscript');
  });

  it('preserves an explicit prior single choice when promoting', () => {
    // If the user already had `single` set to a different path (e.g. they
    // manually picked a non-auto script and later wiped active to null),
    // promotion must not clobber that explicit choice.
    const ctx = makeContext({
      preferMultiAxis: 'multi',
      videos: [{
        path: '/lib/a.mp4',
        hasFunscript: true,
        funscriptPath: '/lib/a.funscript',
      }],
      allFunscripts: [
        { name: 'a.funscript', path: '/lib/a.funscript' },
        { name: 'a.twist.funscript', path: '/lib/a.twist.funscript' },
      ],
    });
    const associations = {
      '/lib/a.mp4': {
        active: null,
        single: '/lib/manual-pick.funscript',
        multi: null,
        custom: null,
      },
    };
    const promoted = promote.call(ctx, associations);

    expect(promoted).toBe(1);
    expect(associations['/lib/a.mp4'].single).toBe('/lib/manual-pick.funscript');
  });
});
