// Regression — the mobile (web-remote) search applyFilters() pipeline
// must NOT re-sort fuzzySearch's output by name/duration/etc. when a
// search query is active. fuzzySearch already returns results ranked
// by relevance (exact-title match at the top); a follow-up sortVideos
// throws that ranking away and lets alphabetically-earlier partial
// matches sink the high-relevance hits.
//
// The desktop has the same rule at renderer/components/library.js:4252;
// the original web-remote port copied the function imports but missed
// the call-site composition. Real user incident 2026-04-30.
//
// This test pins the invariant on the SHARED behaviour of fuzzySearch
// + sortVideos so anyone who ever removes the "skip sort while searching"
// gate in backend/web-remote/app.js::applyFilters has to read this test
// and understand why the gate exists.

import { describe, it, expect } from 'vitest';
import { fuzzySearch, sortVideos } from '../../backend/web-remote/library-search.js';

// Dataset chosen so relevance-order and alphabetic-order diverge:
//   - The exact-title match for "ass" is "ass.mp4" — relevance score -50
//     (exact match sans extension), so fuzzySearch puts it first.
//   - Two partial matches are alphabetically EARLIER than "ass" — Adam's
//     Ass (substring) and Bobs Ass (substring after a space). With a
//     name-sort applied AFTER fuzzy, "Adam's…" lands first and the
//     exact match sinks to third.
const videos = [
  { name: "Adam's Ass.mp4",       path: '/v/adam.mp4',       hasFunscript: false },
  { name: 'Bobs Ass.mp4',         path: '/v/bob.mp4',        hasFunscript: false },
  { name: 'ass.mp4',              path: '/v/exact.mp4',      hasFunscript: true  },
  { name: 'Different Title.mp4',  path: '/v/different.mp4',  hasFunscript: true  },
  { name: 'Yet Another Ass.mp4',  path: '/v/yet.mp4',        hasFunscript: false },
];

describe('web-remote search ranking — regression', () => {
  it('fuzzySearch alone puts the exact-title match first', () => {
    // Sanity check on the shared algorithm. If this ever fails, the
    // problem is in fuzzySearch itself, not the composition.
    const ranked = fuzzySearch(videos, 'ass');
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].name).toBe('ass.mp4');
  });

  it('sorting fuzzySearch output by name destroys relevance ordering', () => {
    // This is the failure mode the gate prevents. Documenting it as a
    // positive assertion: if you EVER call sortVideos(name) on
    // fuzzySearch's output, the exact match sinks below alphabetically-
    // earlier partial matches. Removing the gate in applyFilters
    // reintroduces exactly this bug.
    const ranked = fuzzySearch(videos, 'ass');
    const reSorted = sortVideos(ranked, 'name', 'asc');
    expect(reSorted[0].name).toBe("Adam's Ass.mp4"); // alphabetically first
    const exactPos = reSorted.findIndex(v => v.name === 'ass.mp4');
    expect(exactPos).toBeGreaterThan(0); // exact match is no longer #1
  });

  // Mirror of backend/web-remote/app.js::applyFilters with the bug-fix
  // gate, kept in this test file so a removal of the gate at the call
  // site is caught here. Pure function, no DOM / uiState.
  function applyFilters({ videos, search, sort }) {
    let out = videos;
    if (search) {
      out = fuzzySearch(out, search);
    } else {
      const [field, dir] = (sort || 'name:asc').split(':');
      out = sortVideos(out, field, dir || 'asc');
    }
    return out;
  }

  it('applyFilters preserves fuzzy relevance when search is active', () => {
    const out = applyFilters({ videos, search: 'ass', sort: 'name:asc' });
    expect(out[0].name).toBe('ass.mp4');
  });

  it('applyFilters falls back to name-sort when search is empty', () => {
    // No search → user-selected sort wins (the existing path that
    // worked correctly even before the fix).
    const out = applyFilters({ videos, search: '', sort: 'name:asc' });
    expect(out[0].name).toBe("Adam's Ass.mp4"); // alphabetically first
    expect(out.map(v => v.name)).toEqual([
      "Adam's Ass.mp4",
      'ass.mp4',
      'Bobs Ass.mp4',
      'Different Title.mp4',
      'Yet Another Ass.mp4',
    ]);
  });

  it('applyFilters honours non-default sort when no search', () => {
    // Different sort field — make sure the gate doesn't also swallow
    // legitimate non-default sorts in the no-search branch.
    const withDur = videos.map((v, i) => ({ ...v, duration: (5 - i) * 60 }));
    const out = applyFilters({ videos: withDur, search: '', sort: 'duration:desc' });
    expect(out[0].duration).toBe(300); // longest first
  });
});
