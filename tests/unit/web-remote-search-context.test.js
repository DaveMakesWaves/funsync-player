// Tests for buildContextMapFromGroupings — the inversion that lets the
// mobile fuzzy search match a video by the name of a collection /
// playlist / category it belongs to (parity with the desktop's
// library.js::_buildSearchContextMap).
//
// This was reported as a search-quality regression: typing "gym" on
// mobile failed to find videos in a "Gym" collection, while the same
// query worked on desktop. The fix adds this helper + wires it into
// applyFilters; these tests pin the inversion contract so a refactor
// can't silently regress mobile back to name+path-only search.

import { describe, it, expect } from 'vitest';
import { buildContextMapFromGroupings } from '../../backend/web-remote/search-context.js';
import { fuzzySearch } from '../../backend/web-remote/library-search.js';

const library = [
  { id: 'v1', path: '/lib/alpha.mp4', name: 'alpha.mp4' },
  { id: 'v2', path: '/lib/beta.mp4',  name: 'beta.mp4' },
  { id: 'v3', path: '/lib/gamma.mp4', name: 'gamma.mp4' },
];

describe('buildContextMapFromGroupings', () => {
  it('returns an empty map when no groupings are provided', () => {
    const m = buildContextMapFromGroupings(library, [], [], []);
    expect(m.size).toBe(0);
  });

  it('returns an empty map when library is empty (nothing to key on)', () => {
    const m = buildContextMapFromGroupings(
      [],
      [{ name: 'Gym', videoIds: ['v1'] }],
      [],
      [],
    );
    expect(m.size).toBe(0);
  });

  it('handles all-null inputs gracefully (defensive — page might call before fetch lands)', () => {
    expect(() => buildContextMapFromGroupings(null, null, null, null)).not.toThrow();
    const m = buildContextMapFromGroupings(null, null, null, null);
    expect(m.size).toBe(0);
  });

  it('inverts a single collection — videos in it can be found by collection name', () => {
    const m = buildContextMapFromGroupings(
      library,
      [{ name: 'Gym', videoIds: ['v1', 'v3'] }],
      [],
      [],
    );
    expect(m.get('/lib/alpha.mp4')).toEqual(['Gym']);
    expect(m.get('/lib/gamma.mp4')).toEqual(['Gym']);
    expect(m.has('/lib/beta.mp4')).toBe(false);
  });

  it('a video in multiple groupings collects all their names', () => {
    const m = buildContextMapFromGroupings(
      library,
      [{ name: 'Gym',       videoIds: ['v1'] }],
      [{ name: 'Watchlist', videoIds: ['v1', 'v2'] }],
      [{ name: 'Favourite', videoIds: ['v1'] }],
    );
    expect(m.get('/lib/alpha.mp4')).toEqual(expect.arrayContaining(['Gym', 'Watchlist', 'Favourite']));
    expect(m.get('/lib/alpha.mp4')).toHaveLength(3);
    expect(m.get('/lib/beta.mp4')).toEqual(['Watchlist']);
  });

  it('skips groupings without a name (server returned malformed data)', () => {
    const m = buildContextMapFromGroupings(
      library,
      [{ name: '', videoIds: ['v1'] }, { videoIds: ['v2'] }],
      [],
      [],
    );
    expect(m.size).toBe(0);
  });

  it('skips videoIds that don\'t resolve to a known library path', () => {
    // Stale grouping membership — desktop deleted a video but the phone
    // still has the old grouping cached. Should silently skip.
    const m = buildContextMapFromGroupings(
      library,
      [{ name: 'Stale', videoIds: ['v1', 'ghost-id', 'v9'] }],
      [],
      [],
    );
    expect(m.get('/lib/alpha.mp4')).toEqual(['Stale']);
    expect(m.size).toBe(1);
  });

  it('handles missing videoIds field (server response missing or undefined)', () => {
    const m = buildContextMapFromGroupings(
      library,
      [{ name: 'Empty Collection' }, { name: 'Real', videoIds: ['v1'] }],
      [],
      [],
    );
    expect(m.size).toBe(1);
    expect(m.get('/lib/alpha.mp4')).toEqual(['Real']);
  });
});

// --- End-to-end parity with desktop -----------------------------------
//
// The whole point of this fix is that fuzzySearch with the contextMap
// finds videos by grouping name. These tests run that flow against the
// actual web-remote library-search.js to confirm the wiring (not just
// the inversion) produces the desired user-visible behaviour.

describe('mobile search picks up grouping names (desktop parity)', () => {
  const vids = [
    { id: 'v1', name: 'workout_morning.mp4',  path: '/lib/workout_morning.mp4',  hasFunscript: false },
    { id: 'v2', name: 'random_clip.mp4',      path: '/lib/random_clip.mp4',      hasFunscript: false },
    { id: 'v3', name: 'beach_day.mp4',        path: '/lib/beach_day.mp4',        hasFunscript: false },
  ];
  const collections = [{ name: 'Gym', videoIds: ['v1', 'v2'] }];

  it('without contextMap (pre-fix mobile): "gym" returns nothing', () => {
    const results = fuzzySearch(vids, 'gym');
    expect(results).toHaveLength(0);
  });

  it('with contextMap (post-fix mobile): "gym" returns the Gym collection videos', () => {
    const ctx = buildContextMapFromGroupings(vids, collections, [], []);
    const results = fuzzySearch(vids, 'gym', { contextMap: ctx });
    expect(results.map(v => v.name)).toEqual(
      expect.arrayContaining(['workout_morning.mp4', 'random_clip.mp4']),
    );
    expect(results).toHaveLength(2);
  });

  it('name match still beats context match in ranking (so name hits sort first)', () => {
    const vids2 = [
      ...vids,
      { id: 'v4', name: 'gym_session.mp4', path: '/lib/gym_session.mp4', hasFunscript: false },
    ];
    const ctx = buildContextMapFromGroupings(vids2, collections, [], []);
    const results = fuzzySearch(vids2, 'gym', { contextMap: ctx });
    // Direct name match should rank ahead of context-only matches (the
    // context tier carries a +20 score penalty in fuzzySearch).
    expect(results[0].name).toBe('gym_session.mp4');
  });
});
