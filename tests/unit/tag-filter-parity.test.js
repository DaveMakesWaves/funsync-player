/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The tag filter exists twice: the desktop's (renderer/js/video-tags.js) and
// the phone's copy (backend/web-remote/tag-filter.js), because the phone
// cannot import from renderer/. The plan (PLAN-next-major-2026-11.md 2.6)
// wants one algorithm with the same result on both, so one fixture pins both:
// tests/fixtures/tag-filter-parity.json. The desktop merges the fixture's
// sources (expectedTags pins that), the phone gets only the merged keys, as
// the planned `videoTags` slice would carry them, and every query must return
// the same videos on both. A rule changed in one copy and not the other (OR
// within a facet turned into AND, say) fails here.
//
// Groundwork for the tags phase (2026-11-17): neither module is wired yet.
//
// Stash's tag aliases and sub-tags (sn-tags, 2026-11-19; the opt-in "Use
// Stash's tag aliases and sub-tags"): the desktop merge here compiles the
// fixture's `stashTagRules` (main's `tagRules`) as its alias layer, so both
// filters run on the aliased keys; the fixture's `subTags` library goes
// through the desktop's index and filter and the phone's slice and filter,
// and both must agree on every query.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  effectiveTags,
  filterByTags as desktopFilter,
  compileTagRules,
  FACETS,
  FILTER_MODES as DESKTOP_MODES,
  tagSlug as desktopSlug,
  normalizeTagKey as desktopKey,
} from '../../renderer/js/video-tags.js';
import {
  filterByTags as phoneFilter,
  FACET_IDS,
  FILTER_MODES as PHONE_MODES,
  tagSlug as phoneSlug,
  normalizeTagKey as phoneKey,
} from '../../backend/web-remote/tag-filter.js';
import { stashTagRuleSet } from '../../renderer/js/stash-tags.js';
import {
  buildLibraryTagIndex, applyTagFilter, keySetsFor, impliedTags,
} from '../../renderer/js/library-tag-filter.js';
import { remoteTagSliceFromIndex } from '../../renderer/js/remote-tag-slice.js';

const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tag-filter-parity.json', 'utf8'));
// The opt-in on: main's tagRules as the renderer holds them.
const stashRules = stashTagRuleSet({ tagRules: fixture.stashTagRules, tags: {} }, { enabled: true, useTagRules: true });
const rules = compileTagRules(fixture.options, { stash: stashRules });

function tagsFor(video) {
  return effectiveTags(video.path, fixture.sources, {
    ...fixture.options,
    rules,
    hidden: fixture.hidden,
    scriptPath: video.scriptPath || undefined,
  });
}

// What the desktop would hold (full tag objects) and what the phone would be
// sent (keys only).
const tagObjectsByPath = new Map(fixture.videos.map((v) => [v.path, tagsFor(v)]));
const keysByPath = Object.fromEntries([...tagObjectsByPath].map(([path, tags]) => [path, tags.map((t) => t.key)]));
const paths = (list) => list.map((v) => v.path);

describe('the fixture itself', () => {
  it('covers every source, both filter directions and every mode', () => {
    expect(Object.keys(fixture.sources).sort()).toEqual(['eroscripts', 'funscript', 'stash', 'stashbox', 'user']);
    expect(fixture.queries.some((q) => q.include?.length && q.exclude?.length)).toBe(true);
    for (const mode of ['all', 'any']) expect(fixture.queries.some((q) => q.mode === mode)).toBe(true);
    expect(fixture.videos.every((v) => !/^[A-Za-z]:/.test(v.path) || v.path.startsWith('C:/Library/'))).toBe(true);
  });

  // Stash S1 (1d, 2026-11-18): the identity rows stay in the shared fixture,
  // so both filters keep being run on `performer:<name>#<identity>` keys.
  it('covers identity keys: two of one name, a joined bare name, a guarded #', () => {
    const keys = Object.values(fixture.expectedTags).flat().map((t) => t.key);
    expect(keys.filter((k) => /^performer:jane-doe#/.test(k))).toHaveLength(2);
    expect(keys.filter((k) => k.startsWith('performer:sam-roe#'))).toHaveLength(2);
    expect(keys.some((k) => /^performer:jane-doe-[0-9a-f]/.test(k))).toBe(true);
    expect(fixture.queries.filter((q) => [...(q.include || []), ...(q.exclude || [])].some((k) => String(k).includes('#'))).length).toBeGreaterThanOrEqual(5);
  });

  // sn-tags: Stash's aliases and sub-tags stay in the shared fixture, both sides.
  it("covers Stash's aliases (every source) and sub-tags (all levels, a loop, both directions, every mode)", () => {
    expect(stashRules.aliases.length).toBeGreaterThanOrEqual(3);
    const tags = Object.values(fixture.expectedTags).flat().filter((t) => t.key === 'content:open-air');
    expect([...new Set(tags.flatMap((t) => t.sources))].sort()).toEqual(['eroscripts', 'funscript', 'stashbox']);
    expect(fixture.expectedTags['C:/Library/Video P.mp4'][0]).toMatchObject({ key: 'content:beach-scene', sources: ['user'] });
    const sub = fixture.subTags.queries;
    expect(sub.some((q) => q.exclude?.length)).toBe(true);
    for (const mode of ['all', 'any']) expect(sub.some((q) => q.mode === mode)).toBe(true);
    expect(Object.keys(fixture.stashTagRules.children)).toEqual(expect.arrayContaining(['loop-a', 'loop-b']));
  });
});

describe('effectiveTags on the fixture (the desktop merge the phone relies on)', () => {
  for (const video of fixture.videos) {
    it(`${video.name}: the merged tags, their labels and their sources`, () => {
      const actual = tagObjectsByPath.get(video.path).map((t) => ({
        key: t.key,
        label: t.label,
        sources: t.sources,
        ...(t.refs.length ? { refs: t.refs } : {}),
      }));
      expect(actual).toEqual(fixture.expectedTags[video.path]);
    });
  }
});

describe('filterByTags: the desktop and the phone return the same videos', () => {
  for (const query of fixture.queries) {
    it(query.name, () => {
      const q = { include: query.include, exclude: query.exclude, mode: query.mode };
      expect(paths(desktopFilter(fixture.videos, q, tagObjectsByPath))).toEqual(query.expect);
      expect(paths(desktopFilter(fixture.videos, q, keysByPath))).toEqual(query.expect);
      expect(paths(phoneFilter(fixture.videos, q, keysByPath))).toEqual(query.expect);
    });
  }

  // Fix-up 2026-11-17 (review-1): the phone's Map branch and its {key} items
  // were never run, so deleting either passed every test.
  it('the phone reads the desktop\'s own shape too: a Map of tag objects ({key}), and a Map of keys', () => {
    const keysMap = new Map(Object.entries(keysByPath));
    for (const query of fixture.queries) {
      const q = { include: query.include, exclude: query.exclude, mode: query.mode };
      expect(paths(phoneFilter(fixture.videos, q, tagObjectsByPath)), query.name).toEqual(query.expect);
      expect(paths(phoneFilter(fixture.videos, q, keysMap)), query.name).toEqual(query.expect);
      expect(paths(desktopFilter(fixture.videos, q, keysMap)), query.name).toEqual(query.expect);
    }
  });

  // Fix-up 2026-11-17 (review-1): a video with no path. The desktop's pick()
  // found nothing for it; the phone looked up 'undefined', 'null' or ''.
  describe('videos with no path (fixture.pathless)', () => {
    const { videos, keysByPath: pathlessKeys, queries } = fixture.pathless;
    for (const query of queries) {
      it(query.name, () => {
        const q = { include: query.include, exclude: query.exclude, mode: query.mode };
        const names = (list) => list.map((v) => v.name);
        expect(names(desktopFilter(videos, q, pathlessKeys))).toEqual(query.expectNames);
        expect(names(phoneFilter(videos, q, pathlessKeys))).toEqual(query.expectNames);
      });
    }
  });

  it('both read tags carried on the video when no map is given', () => {
    const carried = fixture.videos.map((v) => ({ ...v, tags: keysByPath[v.path] }));
    for (const query of fixture.queries) {
      const q = { include: query.include, exclude: query.exclude, mode: query.mode };
      expect(paths(desktopFilter(carried, q))).toEqual(query.expect);
      expect(paths(phoneFilter(carried, q))).toEqual(query.expect);
    }
  });
});

describe('the two copies share their vocabulary', () => {
  it('the same facets and modes', () => {
    expect([...FACET_IDS]).toEqual([...FACETS]);
    expect([...PHONE_MODES]).toEqual([...DESKTOP_MODES]);
  });

  it('the same key normalisation', () => {
    const samples = [
      'Device: The Handy', 'device:the-handy', 'the handy', 'THE_HANDY', '  vr : Non VR ', 'content:Ünïcode  Tàg',
      'ＶＲ', '00:51-lenght', 'nope:thing', 'performer:Jane   Doe', 'len-10-25', '한국어 태그', 'がぎ', 'ﬁlm',
      'Script Type: Cock Hero', 'SCRIPT_TYPE:x', 'Dévice: Ünïcode', 'ＤＥＶＩＣＥ：x',
      '', ' ', '-', 'device:', 42, null, undefined, {},
    ];
    for (const s of samples) {
      expect(phoneSlug(s)).toBe(desktopSlug(s));
      expect(phoneKey(s)).toBe(desktopKey(s));
    }
  });
});

describe("Stash's sub-tags (fixture.subTags): the desktop's index and the phone's slice agree", () => {
  const { input, queries, expectImplied, expectSubTags } = fixture.subTags;
  const result = buildLibraryTagIndex({ ...input, stashRules });
  const slice = remoteTagSliceFromIndex(result.index);
  const sliceKeys = Object.fromEntries(Object.entries(slice).map(([path, tags]) => [path, tags.map((t) => t.key)]));
  const { videos } = input;

  it("each video's implied parents, and the parents' sub-tag counts", () => {
    const implied = Object.fromEntries([...impliedTags(result.index)].map(([path, tags]) => [path, tags.map((t) => t.key)]));
    expect(implied).toEqual(expectImplied);
    const subTags = Object.fromEntries([...result.counts.values()].filter((r) => r.subTags).map((r) => [r.key, r.subTags]));
    expect(subTags).toEqual(expectSubTags);
  });

  for (const query of queries) {
    it(query.name, () => {
      const q = { include: query.include, exclude: query.exclude, mode: query.mode };
      expect(paths(desktopFilter(videos, q, keySetsFor(result.index)))).toEqual(query.expect);
      if (!query.mode) {
        const state = { include: query.include || [], exclude: query.exclude || [], categories: [], sources: [] };
        expect(paths(applyTagFilter(videos, state, { index: result.index }))).toEqual(query.expect);
      }
      expect(paths(phoneFilter(videos, q, sliceKeys))).toEqual(query.expect);
    });
  }

  it("the phone's count per key (registered videos whose list has it) is the desktop picker's", () => {
    const phone = new Map();
    for (const keys of Object.values(sliceKeys)) for (const key of keys) phone.set(key, (phone.get(key) || 0) + 1);
    expect(Object.fromEntries(phone)).toEqual(Object.fromEntries([...result.counts.values()].map((r) => [r.key, r.count])));
  });
});
