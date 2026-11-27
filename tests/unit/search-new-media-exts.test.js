/**
 * @vitest-environment node
 * Node: pure search functions. See notes/CLAUDE.md "Test environments".
 */
// The library lists older formats since 2026-11-26 (S031: .vob, .m2ts, .3gp,
// .ogv...). Search drops a trailing media extension so typing a title finds
// it first; that list did not know them, so "alpha video full" could rank
// "alpha.ogv" above "alpha video full.ogv". Desktop and phone search are the
// same (memory: search parity), so both are checked.
import { describe, it, expect } from 'vitest';
import * as desktop from '../../renderer/js/library-search.js';
import * as phone from '../../backend/web-remote/library-search.js';

const EXTS = ['asf', 'vob', 'm2ts', 'mts', 'f4v', '3gp', '3g2', 'ogv', 'divx', 'wmv', 'mpg', 'ts', 'flv'];

for (const [label, mod] of [['desktop', desktop], ['phone', phone]]) {
  describe(`${label} search: the exact title first, whatever the video's extension`, () => {
    for (const ext of EXTS) {
      it(`.${ext}`, () => {
        // "alpha beta" is that video's whole title only once its extension is
        // dropped; kept, "beta alpha" (the same words) ranked first.
        const vids = [
          { name: `beta alpha.${ext}`, path: `/b.${ext}` },
          { name: `alpha beta.${ext}`, path: `/a.${ext}` },
        ];
        expect(mod.fuzzySearch(vids, 'alpha beta')[0].name).toBe(`alpha beta.${ext}`);
      });
    }
  });
}
