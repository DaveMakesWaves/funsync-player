/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash's two sorts in library-search.js sortVideos (Stash "next" lot,
// stage sn-library, 2026-11-19; DESIGN-stash-s1.md (j) #3, #10): by Stash's
// rating and by Stash's last played, over the seeded test Stash's values
// (ratings 20/60/80/80/100, plays on three scenes). Asserted: the order,
// unrated / never played / unlinked LAST in both directions, equal values
// A-Z whatever order the list came in, and the other sorts unchanged.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { sortVideos, compareVideoNames } from '../../renderer/js/library-search.js';
import * as phone from '../../backend/web-remote/library-search.js';
import { stashFieldsIndex } from '../../renderer/js/stash-scene-fields.js';
import { P, snProjection, snVideos } from '../helpers/stash-next-fixtures.js';

const VIDEOS = snVideos();
const INDEX = stashFieldsIndex(snProjection(), VIDEOS, { enabled: true });
const paths = (list) => list.map((v) => v.path);
const reversed = [...VIDEOS].reverse();
const UNRATED = [P.reencode, P.edge65535, P.edge65536, P.edge65543, P.edge131079];
const byName = (list) => [...list].sort((a, b) => compareVideoNames({ path: a, name: a.split('\\').pop() }, { path: b, name: b.split('\\').pop() }));

describe('sortVideos: Stash rating', () => {
  it('High-Low: 100, the two 80s A-Z, 60, 20, then every unrated video A-Z', () => {
    const out = paths(sortVideos(VIDEOS, 'stashRating', 'desc', { stash: INDEX }));
    expect(out.slice(0, 5)).toEqual([P.large, ...byName([P.small, P.edge131072]), P.mid, P.tiny]);
    expect(out.slice(5)).toEqual(byName(UNRATED));
  });

  it('Low-High: 20 first, and the unrated STILL last (not first)', () => {
    const out = paths(sortVideos(VIDEOS, 'stashRating', 'asc', { stash: INDEX }));
    expect(out.slice(0, 5)).toEqual([P.tiny, P.mid, ...byName([P.small, P.edge131072]), P.large]);
    expect(out.slice(5)).toEqual(byName(UNRATED));
  });

  it('ties and the unrated keep one order whatever order the list arrived in', () => {
    for (const dir of ['asc', 'desc']) {
      expect(paths(sortVideos(reversed, 'stashRating', dir, { stash: INDEX })))
        .toEqual(paths(sortVideos(VIDEOS, 'stashRating', dir, { stash: INDEX })));
    }
  });

  it('an unlinked video sorts with the unrated, last', () => {
    const idx = stashFieldsIndex(snProjection({ unlinked: [P.large] }), VIDEOS, { enabled: true });
    const out = paths(sortVideos(VIDEOS, 'stashRating', 'desc', { stash: idx }));
    expect(out.indexOf(P.large)).toBeGreaterThan(out.indexOf(P.tiny));
  });

  it('does not change its input', () => {
    const before = paths(VIDEOS);
    sortVideos(VIDEOS, 'stashRating', 'desc', { stash: INDEX });
    expect(paths(VIDEOS)).toEqual(before);
  });
});

describe('sortVideos: Stash last played', () => {
  it('Recently played first; the never played last, A-Z', () => {
    const out = paths(sortVideos(VIDEOS, 'stashLastPlayed', 'desc', { stash: INDEX }));
    expect(out.slice(0, 3)).toEqual([P.large, P.mid, P.small]);
    const never = VIDEOS.map((v) => v.path).filter((p) => ![P.large, P.mid, P.small].includes(p));
    expect(out.slice(3)).toEqual(byName(never));
  });

  it('Played longest ago first, the never played still last', () => {
    const out = paths(sortVideos(reversed, 'stashLastPlayed', 'asc', { stash: INDEX }));
    expect(out.slice(0, 3)).toEqual([P.small, P.mid, P.large]);
    expect(out.slice(3)).toEqual(byName(out.slice(3)));
  });

  it('an older library.json (no last played): every video unknown, A-Z', () => {
    const idx = stashFieldsIndex(snProjection({ omitNext: true }), VIDEOS, { enabled: true });
    expect(paths(sortVideos(reversed, 'stashLastPlayed', 'desc', { stash: idx }))).toEqual(byName(paths(VIDEOS)));
  });
});

describe('without Stash values (Stash off) and the other sorts', () => {
  it('a Stash sort with no index is Name A-Z, never a throw', () => {
    expect(paths(sortVideos(reversed, 'stashRating', 'desc'))).toEqual(byName(paths(VIDEOS)));
    expect(paths(sortVideos(reversed, 'stashLastPlayed', 'asc', { stash: null }))).toEqual(byName(paths(VIDEOS)));
  });

  it('the five existing sorts ignore the Stash option', () => {
    for (const field of ['name', 'dateAdded', 'duration', 'avgSpeed', 'maxSpeed']) {
      for (const dir of ['asc', 'desc']) {
        expect(paths(sortVideos(VIDEOS, field, dir, { stash: INDEX }))).toEqual(paths(sortVideos(VIDEOS, field, dir)));
      }
    }
  });

  it('the phone and the desktop agree: the phone offers no Stash sort today; if it ever does, it sorts as the desktop', () => {
    // backend/web-remote/app.js's sort sheet lists name, dateAdded, duration,
    // avgSpeed and maxSpeed; the phone's videos carry no Stash data.
    const sheet = fs.readFileSync('backend/web-remote/app.js', 'utf8');
    const offers = /field:\s*'stash(Rating|LastPlayed)'/.test(sheet);
    if (!offers) {
      expect(sheet).toMatch(/field:\s*'maxSpeed'/);
      expect(paths(phone.sortVideos(reversed, 'stashRating', 'desc'))).toEqual(paths(reversed));
    } else {
      for (const field of ['stashRating', 'stashLastPlayed']) {
        for (const dir of ['asc', 'desc']) {
          expect(paths(phone.sortVideos(reversed, field, dir, { stash: INDEX })))
            .toEqual(paths(sortVideos(reversed, field, dir, { stash: INDEX })));
        }
      }
    }
  });
});
