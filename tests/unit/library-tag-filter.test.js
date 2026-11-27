/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The library's Tags filter and its one memoised tag index
// (renderer/js/library-tag-filter.js; P1 wiring, Round 3, 2026-11-18;
// DESIGN-video-options.md (e), PLAN-next-major-2026-11.md §2.2 "Filtering").
//
// Pinned here, each by what a caller sees:
//   - the filter: OR within a facet, AND across facets, Category and "Tags
//     from" as two more facets, the exclude the engine supports, a hidden
//     tag that no longer matches, a video with no record matching no include;
//   - the parity fixture (tests/fixtures/tag-filter-parity.json): the
//     library's filter step answers every facets-mode query the way the
//     fixture (and so the phone's tag-filter.js) does;
//   - the index: the funscript file's own metadata feeds the `funscript`
//     source, an EroScripts record follows the dialog's per-video rule,
//     counts are per path;
//   - the memo: one build for the same inputs, a rebuild for each input that
//     changed (a stored map, a bump, the script-meta version or map, the
//     library list, a video's pairing), and none for a change it does not read.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  applyTagFilter, buildLibraryTagIndex, LibraryTagIndex, emptyTagFilter, tagFilterActive,
  facetRows, SOURCE_FACET, TAG_DATA_KEYS,
} from '../../renderer/js/library-tag-filter.js';
import { effectiveTags, compileTagRules } from '../../renderer/js/video-tags.js';
import { stashTagRuleSet } from '../../renderer/js/stash-tags.js';

const A = 'C:/Lib/Alpha Scene.mp4';
const B = 'C:/Lib/Bravo Take.mp4';
const C = 'C:/Lib/Charlie Cut.mp4';
const D = 'C:/Lib/Delta Plain.mp4';
const A_SCRIPT = 'C:/Lib/Alpha Scene.funscript';
const B_SCRIPT = 'C:/Lib/Bravo Take.funscript';

const VIDEOS = [
  { path: A, name: 'Alpha Scene.mp4', funscriptPath: A_SCRIPT },
  { path: B, name: 'Bravo Take.mp4', funscriptPath: B_SCRIPT },
  { path: C, name: 'Charlie Cut.mp4', funscriptPath: null },
  { path: D, name: 'Delta Plain.mp4', funscriptPath: null },
];

const STORE = {
  'library.userTags': {
    [A]: ['pov'],
    [C]: ['the handy', 'cosplay'],
  },
  'library.hiddenTags': {},
  'library.scriptTags': {
    // Names A's script: counts while A plays it.
    [A]: { tags: ['the-handy', 'non-vr'], topicId: 1, scriptPath: A_SCRIPT, source: 'eroscripts', savedAt: 1 },
    // Names another script than B plays: does not count (a script swap).
    [B]: { tags: ['sr6'], topicId: 2, scriptPath: 'C:/Lib/Old Bravo.funscript', source: 'eroscripts', savedAt: 1 },
  },
  'library.tagSettings': { aliases: {}, hidden: [], facetOverrides: {} },
};
const META = {
  [B_SCRIPT]: { tags: ['POV', 'osr2'], topicTags: [], performers: [], creator: null },
};

const paths = (list) => list.map((v) => v.path);

function indexOf(store = STORE, meta = META, videos = VIDEOS) {
  return buildLibraryTagIndex({
    videos,
    userTags: store['library.userTags'],
    hiddenTags: store['library.hiddenTags'],
    scriptTags: store['library.scriptTags'],
    tagSettings: store['library.tagSettings'],
    scriptMeta: meta,
  });
}

describe('the index (path -> effective tags) for the library', () => {
  it('merges your tags, the EroScripts record and the script file\'s own metadata', () => {
    const { index } = indexOf();
    expect(index.get(A).map((t) => t.key)).toEqual(['vr:non-vr', 'device:the-handy', 'content:pov']);
    // B: the file's metadata (the `funscript` source, keyed by SCRIPT path);
    // its EroScripts record names another script and adds nothing.
    expect(index.get(B).map((t) => [t.key, t.sources])).toEqual([
      ['device:osr2', ['funscript']],
      ['content:pov', ['funscript']],
    ]);
    expect(index.get(C).map((t) => t.key)).toEqual(['device:the-handy', 'content:cosplay']);
    expect(index.has(D)).toBe(false);
  });

  it('counts each value per video path, and per source for "Tags from"', () => {
    const { counts, sourceCounts, suggestions } = indexOf();
    expect(counts.get('content:pov')).toMatchObject({ facet: 'content', count: 2 });
    expect(counts.get('device:the-handy').count).toBe(2);
    expect(sourceCounts).toEqual({ eroscripts: 1, stash: 0, funscript: 1, user: 2 });
    expect(suggestions.map((s) => s.key).sort()).toEqual([...counts.keys()].sort());
  });

  it('a record with no scriptPath counts only while the video plays its same-name script (RB-2)', () => {
    const store = {
      ...STORE,
      'library.scriptTags': {
        [A]: { tags: ['sr6'], topicId: 3, source: 'eroscripts', savedAt: 1 },
        [C]: { tags: ['sr6'], topicId: 4, source: 'eroscripts', savedAt: 1 }, // C has no script
      },
    };
    const { index } = indexOf(store);
    expect(index.get(A).map((t) => t.key)).toContain('device:sr6');
    expect(index.get(C).map((t) => t.key)).not.toContain('device:sr6');
  });

  it('a tag hidden on the video, or on every video, is not in the index (unless you gave it there)', () => {
    const store = {
      ...STORE,
      'library.hiddenTags': { [A]: ['the-handy'] },
      'library.tagSettings': { aliases: {}, hidden: ['cosplay', 'pov'], facetOverrides: {} },
    };
    const { index, counts } = indexOf(store);
    expect(index.get(A).map((t) => t.key)).not.toContain('device:the-handy');
    // C gave cosplay itself: shown although hidden everywhere (the 1b rule).
    expect(index.get(C).map((t) => t.key)).toContain('content:cosplay');
    // B's pov comes only from the file: hidden everywhere, so gone.
    expect(index.get(B).map((t) => t.key)).not.toContain('content:pov');
    expect(counts.get('content:pov').count).toBe(1); // A's own
  });

  it('absence is unknown: no maps, no metadata, no list give an empty index and nothing thrown', () => {
    expect(buildLibraryTagIndex({}).index.size).toBe(0);
    expect(buildLibraryTagIndex({ videos: VIDEOS, userTags: null, scriptTags: 'bad', scriptMeta: undefined }).index.size).toBe(0);
  });
});

describe('applyTagFilter: every ticked tag (Dave 2026-11-22), the length buckets OR', () => {
  const { index } = indexOf();
  const run = (state, extra = {}) => paths(applyTagFilter(VIDEOS, { ...emptyTagFilter(), ...state }, { index, ...extra }));

  it('no selection keeps every video, in order, as a new array', () => {
    const out = applyTagFilter(VIDEOS, emptyTagFilter(), { index });
    expect(out).toEqual(VIDEOS);
    expect(out).not.toBe(VIDEOS);
    expect(tagFilterActive(emptyTagFilter())).toBe(false);
  });

  it('two values of one facet: a video needs both', () => {
    expect(run({ include: ['device:the-handy', 'device:osr2'] })).toEqual([]);
    expect(run({ include: ['device:the-handy', 'content:pov'] })).toEqual([A]);
  });

  it('values of two facets: both', () => {
    expect(run({ include: ['device:the-handy', 'content:pov'] })).toEqual([A]);
    expect(run({ include: ['device:the-handy', 'device:osr2', 'content:pov'] })).toEqual([]);
  });

  it('a video with no tags matches no include', () => {
    expect(run({ include: ['content:pov'] })).not.toContain(D);
  });

  it('the exclude the engine supports is reachable (the first UI only includes)', () => {
    expect(run({ exclude: ['content:pov'] })).toEqual([C, D]);
    expect(tagFilterActive({ ...emptyTagFilter(), exclude: ['content:pov'] })).toBe(true);
  });

  it('Category is one more facet: OR inside, AND with the tags', () => {
    const cats = { [A]: ['c1'], [B]: ['c2'], [D]: ['c1', 'c2'] };
    const categoriesOf = (p) => cats[p] || [];
    expect(run({ categories: ['c1'] }, { categoriesOf })).toEqual([A, D]);
    expect(run({ categories: ['c1', 'c2'] }, { categoriesOf })).toEqual([A, B, D]);
    expect(run({ categories: ['c1', 'c2'], include: ['content:pov'] }, { categoriesOf })).toEqual([A, B]);
    // No reader: nothing is in a category.
    expect(run({ categories: ['c1'] })).toEqual([]);
  });

  it('"Tags from" is one more facet: a video with a tag from that source', () => {
    expect(run({ sources: ['funscript'] })).toEqual([B]);
    expect(run({ sources: ['funscript', 'eroscripts'] })).toEqual([A, B]);
    expect(run({ sources: ['user'], include: ['device:the-handy'] })).toEqual([A, C]);
    expect(SOURCE_FACET).toEqual(['eroscripts', 'stash', 'funscript', 'user']);
  });

  it('a tag hidden on a video no longer matches it (filter reads the index, hides applied)', () => {
    const hidden = indexOf({ ...STORE, 'library.hiddenTags': { [A]: ['pov'] } }).index;
    expect(paths(applyTagFilter(VIDEOS, { ...emptyTagFilter(), include: ['content:pov'] }, { index: hidden }))).toEqual([B]);
  });
});

describe('the parity fixture: the library\'s filter step answers as the fixture says', () => {
  const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tag-filter-parity.json', 'utf8'));
  // sn-tags (2026-11-19): the fixture's Stash tag aliases (the opt-in on) as the merge's layer.
  const stash = stashTagRuleSet({ tagRules: fixture.stashTagRules, tags: {} }, { enabled: true, useTagRules: true });
  const rules = compileTagRules(fixture.options, { stash });
  const index = new Map(fixture.videos.map((v) => [v.path, effectiveTags(v.path, fixture.sources, {
    ...fixture.options, rules, hidden: fixture.hidden, scriptPath: v.scriptPath || undefined,
  })]));
  // The desktop UI filters in the default (facets) mode; the other modes are
  // the engine's and stay pinned by tag-filter-parity.test.js.
  const facetsQueries = fixture.queries.filter((q) => !q.mode || q.mode === 'facets' || q.mode === 'bogus');
  it('has facets-mode queries to check', () => {
    expect(facetsQueries.length).toBeGreaterThan(10);
  });
  for (const q of facetsQueries) {
    it(q.name, () => {
      const out = applyTagFilter(fixture.videos, { ...emptyTagFilter(), include: q.include || [], exclude: q.exclude || [] }, { index });
      expect(paths(out)).toEqual(q.expect);
    });
  }
});

describe('LibraryTagIndex: one memoised index', () => {
  function setup() {
    const store = structuredClone(STORE);
    const ds = { get: (k) => store[k] };
    const state = { videos: VIDEOS.map((v) => ({ ...v })), meta: { ...META }, metaVersion: 1 };
    const memo = new LibraryTagIndex({
      settings: () => ds,
      videos: () => state.videos,
      scriptMeta: () => state.meta,
      scriptMetaVersion: () => state.metaVersion,
    });
    return { store, state, memo };
  }

  it('the same inputs: the same result, built once', () => {
    const { memo } = setup();
    const first = memo.get();
    expect(memo.get()).toBe(first);
    expect(memo.get()).toBe(first);
    expect(memo.builds).toBe(1);
    expect(memo.peek()).toBe(first);
  });

  it('a stored map written (a new object, as every writer writes): rebuilt with it', () => {
    const { store, memo } = setup();
    const first = memo.get();
    store['library.userTags'] = { ...store['library.userTags'], [D]: ['outdoor'] };
    const next = memo.get();
    expect(next).not.toBe(first);
    expect(next.index.get(D).map((t) => t.key)).toEqual(['content:outdoor']);
    expect(memo.builds).toBe(2);
  });

  it('bump() (settings:changed on a tag key): rebuilt even when the identities did not change', () => {
    const { store, memo } = setup();
    memo.get();
    store['library.userTags'][A].push('outdoor'); // edited in place: no identity changed
    expect(memo.get().index.get(A).map((t) => t.key)).not.toContain('content:outdoor'); // not seen without the bump
    memo.bump();
    expect(memo.get().index.get(A).map((t) => t.key)).toContain('content:outdoor');
    expect(memo.builds).toBe(2);
  });

  it('the script-meta version: rebuilt, and the file\'s new tags are in', () => {
    const { state, memo } = setup();
    memo.get();
    state.meta[B_SCRIPT] = { tags: ['Cosplay'], topicTags: [], performers: [], creator: null };
    expect(memo.get().index.get(B).map((t) => t.key)).not.toContain('content:cosplay');
    state.metaVersion = 2;
    expect(memo.get().index.get(B).map((t) => t.key)).toContain('content:cosplay');
    expect(memo.builds).toBe(2);
  });

  it('a new script-meta map (the harvest replaced it): rebuilt', () => {
    const { state, memo } = setup();
    memo.get();
    state.meta = { [A_SCRIPT]: { tags: ['Outdoor'], topicTags: [], performers: [], creator: null } };
    expect(memo.get().index.get(A).map((t) => t.key)).toContain('content:outdoor');
  });

  it('a library scan (a new list): rebuilt', () => {
    const { state, memo } = setup();
    memo.get();
    state.videos = state.videos.filter((v) => v.path !== C);
    expect(memo.get().index.has(C)).toBe(false);
    expect(memo.builds).toBe(2);
  });

  it('a pairing changed in place (Unpair, a pair): rebuilt, without a scan', () => {
    const { state, memo } = setup();
    expect(memo.get().index.get(A).map((t) => t.key)).toContain('device:the-handy');
    state.videos[0].funscriptPath = null; // A unpaired: its EroScripts record no longer counts
    expect(memo.get().index.get(A).map((t) => t.key)).toEqual(['content:pov']);
    expect(memo.builds).toBe(2);
  });

  it('a video with no record changing its pairing is not a reason to rebuild', () => {
    const { state, memo } = setup();
    memo.get();
    state.videos[3].funscriptPath = 'C:/Lib/Nothing Known.funscript';
    memo.get();
    expect(memo.builds).toBe(1);
  });

  it('reads exactly the stored keys it says it reads', () => {
    // sn-tags (2026-11-19): `stash.useTagRules`, Stash's tag aliases and sub-tags.
    expect(TAG_DATA_KEYS).toEqual(['library.userTags', 'library.hiddenTags', 'library.scriptTags', 'library.tagSettings', 'stash.enabled', 'stash.useTagRules']);
  });

  it('a settings object that throws, or none: an empty index, nothing thrown', () => {
    const memo = new LibraryTagIndex({ settings: () => ({ get: () => { throw new Error('x'); } }), videos: () => VIDEOS });
    expect(memo.get().index.size).toBe(0);
    expect(new LibraryTagIndex().get().index.size).toBe(0);
  });
});

describe('facetRows: the picker\'s rows of one facet', () => {
  const rows = [
    { key: 'content:pov', label: 'pov', count: 2 },
    { key: 'content:cosplay', label: 'cosplay', count: 5 },
    { key: 'content:blowjob', label: 'blowjob', count: 2 },
  ];
  it('most used first, then by label', () => {
    expect(facetRows(rows).map((r) => r.label)).toEqual(['cosplay', 'blowjob', 'pov']);
  });
  it('the find box keeps the rows whose shown text has it (folded)', () => {
    expect(facetRows(rows, 'PO').map((r) => r.label)).toEqual(['pov']);
    expect(facetRows(rows, 'min', (r) => `${r.label} min`).length).toBe(3);
  });
});
