/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash in the tag engine and the library's one tag index (Stash S1, Round 1
// stage 1d, 2026-11-18; notes/features/DESIGN-stash-s1.md (c), (f) "The Tags
// filter", (g)). Files: renderer/js/video-tags.js (identity keys, the `#`
// guard, the bare-name join), renderer/js/library-tag-filter.js (the `stash`
// source in LibraryTagIndex, "Tags from: Stash", the label pass),
// renderer/js/video-tag-edits.js (your typed tag and a chip's key agree).
//
// Pinned here, each by what a user sees (the design's (g) rows):
//   - POV and pov: one chip with both sources;
//   - Same-name performers: two keys, two labels ("Jane Doe (blonde)",
//     "Jane Doe · 3f2a");
//   - Bare-name join: a funscript's "Jane Doe" joins the one identity; with
//     two it stays its own chip;
//   - No forged identity: a typed or file-given `#` never makes an identity;
//   - Hides survive a sync, an identity chip's hide included;
//   - Turned off: no `stash` source anywhere; on again: back, with no write;
//   - Trust check through the index;
//   - Tags from: Stash: counted only where a Stash tag shows;
//   - the memo rebuilds on the Stash data, its version and the setting.
import { describe, it, expect } from 'vitest';
import {
  effectiveTags, classifyTag, classifyTypedTag, compileTagRules, withNameIds, tagIdentity, nameSlug,
  IDENTITY_MARK, IDENTITY_FACETS,
} from '../../renderer/js/video-tags.js';
import {
  LibraryTagIndex, buildLibraryTagIndex, applyTagFilter, emptyTagFilter, SOURCE_FACET, STASH_ENABLED_KEY,
} from '../../renderer/js/library-tag-filter.js';
import { stashTagRecords, nameIdentities } from '../../renderer/js/stash-tags.js';
import { planAddTag, planRemoveTag, planShowAgain } from '../../renderer/js/video-tag-edits.js';

const A = 'C:/Lib/Alpha Scene.mp4';
const B = 'C:/Lib/Bravo Take.mp4';
const C = 'C:/Lib/Charlie Cut.mp4';
const K = 'C:/Lib/Kilo Script.mp4';
const K_SCRIPT = 'C:/Lib/Kilo Script.funscript';
const ID_BLONDE = '0b5e1c9a-0000-4000-8000-00000000aaaa';
const ID_OTHER = '0b5e1c9a-0000-4000-8000-000000003f2a';
const KEY_BLONDE = `performer:jane-doe#${ID_BLONDE}`;
const KEY_OTHER = `performer:jane-doe#${ID_OTHER}`;

const sbox = (stashId) => [{ endpoint: 'https://stash-box.invalid/graphql', stashId }];

function makeData({ twoJanes = true } = {}) {
  const data = {
    v: 1,
    rev: 1,
    server: { url: 'http://127.0.0.1:9999', version: 'v0.32.0' },
    lastSync: { at: 1, kind: 'full', ok: true, partial: false },
    links: {
      [A]: { sceneId: '1', server: 'http://127.0.0.1:9999', by: 'oshash', fp: { size: 100, oshash: 'a1' }, linkedAt: 1, state: 'ok' },
      [B]: { sceneId: '2', server: 'http://127.0.0.1:9999', by: 'oshash', fp: { size: 200, oshash: 'b2' }, linkedAt: 1, state: 'ok' },
    },
    check: {},
    refused: {},
    scenes: {
      1: { id: '1', title: 'Synthetic One', studioId: 's1', performerIds: ['p1'], tagIds: ['t1', 't2'], markers: [], files: [] },
      2: { id: '2', title: 'Synthetic Two', studioId: null, performerIds: twoJanes ? ['p2'] : [], tagIds: ['t3'], markers: [], files: [] },
    },
    performers: {
      p1: { id: 'p1', name: 'Jane Doe', disambiguation: 'blonde', stashIds: sbox(ID_BLONDE) },
    },
    studios: { s1: { id: 's1', name: 'Synthetic Studio', stashIds: [] } },
    tags: { t1: { id: 't1', name: 'POV' }, t2: { id: 't2', name: 'Outdoor' }, t3: { id: 't3', name: 'Synthetic Tag B' } },
  };
  if (twoJanes) data.performers.p2 = { id: 'p2', name: 'Jane Doe', disambiguation: '', stashIds: sbox(ID_OTHER) };
  return data;
}

const VIDEOS = [
  { path: A, size: 100, funscriptPath: null },
  { path: B, size: 200, funscriptPath: null },
  { path: C, size: 300, funscriptPath: null },
  { path: K, size: 400, funscriptPath: K_SCRIPT },
];

// The library as the app wires it (Round 2): DataService-like settings, the
// Stash store's data and version.
function setup({ data = makeData(), enabled = true, store = {}, meta = {} } = {}) {
  const state = {
    settings: {
      'library.userTags': {},
      'library.hiddenTags': {},
      'library.scriptTags': {},
      'library.tagSettings': { aliases: {}, hidden: [], facetOverrides: {} },
      [STASH_ENABLED_KEY]: enabled,
      ...store,
    },
    data,
    version: 1,
    videos: VIDEOS.map((v) => ({ ...v })),
    meta,
  };
  const memo = new LibraryTagIndex({
    settings: () => ({ get: (k) => state.settings[k] }),
    videos: () => state.videos,
    scriptMeta: () => state.meta,
    scriptMetaVersion: () => 1,
    stashData: () => state.data,
    stashVersion: () => state.version,
  });
  return { state, memo };
}

const keysOf = (result, path) => (result.index.get(path) || []).map((t) => t.key);

describe('POV and pov: one chip with both sources', () => {
  it('a Stash "POV" and an EroScripts "pov" are one tag; the label is Stash\'s', () => {
    const { state, memo } = setup({
      store: { 'library.scriptTags': { [A]: { tags: ['pov'], topicId: 9, source: 'eroscripts', savedAt: 1 } } },
    });
    // The post describes the video's same-name script, which it plays.
    state.videos[0].funscriptPath = 'C:/Lib/Alpha Scene.funscript';
    const pov = memo.get().index.get(A).filter((t) => t.key === 'content:pov');
    expect(pov).toHaveLength(1);
    expect(pov[0].sources).toEqual(['stash', 'eroscripts']);
    expect(pov[0].label).toBe('POV');
  });
});

describe('Same-name performers split by Stash ID', () => {
  it('two Jane Does with different Stash IDs are two keys with two labels', () => {
    const result = setup().memo.get();
    expect(keysOf(result, A)).toContain(KEY_BLONDE);
    expect(keysOf(result, B)).toContain(KEY_OTHER);
    expect(result.counts.get(KEY_BLONDE).label).toBe('Jane Doe (blonde)');
    expect(result.counts.get(KEY_OTHER).label).toBe('Jane Doe · 3f2a');
    // The label is written on every video's tag (chips, cards, phone).
    expect(result.index.get(B).find((t) => t.key === KEY_OTHER).label).toBe('Jane Doe · 3f2a');
    // Each filters to its own video.
    const run = (key) => applyTagFilter(VIDEOS, { ...emptyTagFilter(), include: [key] }, { index: result.index }).map((v) => v.path);
    expect(run(KEY_BLONDE)).toEqual([A]);
    expect(run(KEY_OTHER)).toEqual([B]);
  });

  it('one Jane Doe alone keeps her plain name', () => {
    const result = setup({ data: makeData({ twoJanes: false }) }).memo.get();
    expect(result.counts.get(KEY_BLONDE).label).toBe('Jane Doe');
  });

  it('an identity Jane Doe next to a bare-name Jane Doe: only the identity one gets a suffix', () => {
    // With one identity the bare name would join it: a second Stash Jane
    // Doe with no identity keeps the name ambiguous, so it stays bare.
    const data = makeData({ twoJanes: false });
    data.performers.p9 = { id: 'p9', name: 'Jane Doe', disambiguation: '', stashIds: [] };
    const result = setup({ data, store: { 'library.userTags': { [C]: ['performer:Jane Doe'] } } }).memo.get();
    expect(keysOf(result, C)).toEqual(['performer:jane-doe']);
    expect(result.counts.get('performer:jane-doe').label).toBe('Jane Doe');
    expect(result.counts.get(KEY_BLONDE).label).toBe('Jane Doe (blonde)');
  });

  it('two identities that would still read the same also get the id\'s last 4 characters', () => {
    const data = makeData();
    data.performers.p2.disambiguation = 'blonde';
    const result = setup({ data }).memo.get();
    expect(result.counts.get(KEY_BLONDE).label).toBe('Jane Doe (blonde) · aaaa');
    expect(result.counts.get(KEY_OTHER).label).toBe('Jane Doe (blonde) · 3f2a');
  });

  it('the identity keeps the key apart, the disambiguation rides on the tag', () => {
    const tags = effectiveTags(A, { stash: stashTagRecords(makeData(), { enabled: true }) });
    const jane = tags.find((t) => t.facet === 'performer');
    expect(jane).toMatchObject({ key: KEY_BLONDE, value: `jane-doe#${ID_BLONDE}`, identity: ID_BLONDE, disambiguation: 'blonde', label: 'Jane Doe' });
  });
});

describe('Bare-name join', () => {
  const meta = { [K_SCRIPT]: { tags: [], topicTags: [], performers: ['Jane Doe'], creator: null } };

  it('a funscript\'s "Jane Doe" joins the one Stash identity with that name', () => {
    const result = setup({ data: makeData({ twoJanes: false }), meta }).memo.get();
    expect(keysOf(result, K)).toEqual([KEY_BLONDE]);
    expect(result.counts.get(KEY_BLONDE).count).toBe(2);
  });

  it('with two identities of that name it stays its own chip', () => {
    const result = setup({ meta }).memo.get();
    expect(keysOf(result, K)).toEqual(['performer:jane-doe']);
    expect(result.counts.get('performer:jane-doe').label).toBe('Jane Doe');
  });

  it('a name you typed joins the same way; Stash turned off: no join', () => {
    const typed = { 'library.userTags': { [C]: ['performer:Jane Doe'] } };
    expect(keysOf(setup({ data: makeData({ twoJanes: false }), store: typed }).memo.get(), C)).toEqual([KEY_BLONDE]);
    expect(keysOf(setup({ data: makeData({ twoJanes: false }), store: typed, enabled: false }).memo.get(), C)).toEqual(['performer:jane-doe']);
  });

  it('the join reads nameIds from the options or from the rules (withNameIds)', () => {
    const nameIds = nameIdentities(makeData({ twoJanes: false }), { enabled: true });
    const sources = { funscript: meta };
    expect(effectiveTags(K, sources, { scriptPath: K_SCRIPT, nameIds }).map((t) => t.key)).toEqual([KEY_BLONDE]);
    const rules = withNameIds(compileTagRules(), nameIds);
    expect(effectiveTags(K, sources, { scriptPath: K_SCRIPT, rules }).map((t) => t.key)).toEqual([KEY_BLONDE]);
    expect(effectiveTags(K, sources, { scriptPath: K_SCRIPT }).map((t) => t.key)).toEqual(['performer:jane-doe']);
    expect(classifyTypedTag('performer:Jane Doe', rules).key).toBe(KEY_BLONDE);
    expect(classifyTag('performer:jane-doe', rules).key).toBe(KEY_BLONDE);
  });

  it('a creator never joins (no Stash source names one)', () => {
    const ids = new Map([['creator:jane-doe', ID_BLONDE]]);
    expect(effectiveTags(C, { user: { [C]: ['creator:Jane Doe'] } }, { nameIds: ids }).map((t) => t.key)).toEqual(['creator:jane-doe']);
  });
});

describe('No forged identity: only a Stash record makes one', () => {
  const stash = () => stashTagRecords(makeData(), { enabled: true });

  it('a typed performer:Jane Doe#<id> does not equal the identity key', () => {
    const tags = effectiveTags(C, { user: { [C]: [`performer:Jane Doe#${ID_BLONDE}`] }, stash: stash() });
    expect(tags.map((t) => t.key)).toEqual([`performer:jane-doe-${ID_BLONDE}`]);
    expect(tags[0].identity).toBeUndefined();
    expect(classifyTypedTag(`performer:Jane Doe#${ID_BLONDE}`).key).not.toBe(KEY_BLONDE);
  });

  it('a funscript\'s performer "Jane Doe#<id>" does not either', () => {
    const tags = effectiveTags(K, { funscript: { [K_SCRIPT]: { performers: [`Jane Doe#${ID_BLONDE}`] } } }, { scriptPath: K_SCRIPT });
    expect(tags.map((t) => t.key)).toEqual([`performer:jane-doe-${ID_BLONDE}`]);
  });

  it('an `identity` field is read from Stash and stash-box records only', () => {
    const forged = [{ name: 'Jane Doe', identity: ID_BLONDE }];
    expect(effectiveTags(C, { user: { [C]: [{ name: 'performer:Jane Doe', identity: ID_BLONDE }] } }).map((t) => t.key)).toEqual(['performer:jane-doe']);
    expect(effectiveTags(K, { funscript: { [K_SCRIPT]: { performers: forged } } }, { scriptPath: K_SCRIPT }).map((t) => t.key)).toEqual(['performer:jane-doe']);
    expect(effectiveTags(C, { stashbox: { [C]: { performers: forged } } }).map((t) => t.key)).toEqual([KEY_BLONDE]);
  });

  it('an alias can rename an identity key but never point at one', () => {
    const rules = compileTagRules({ aliases: { 'performer:jd': `performer:Jane Doe#${ID_BLONDE}` } });
    expect(effectiveTags(C, { user: { [C]: ['performer:jd'] } }, { rules }).map((t) => t.key)).toEqual([`performer:jane-doe-${ID_BLONDE}`]);
    const rename = compileTagRules({ aliases: { [KEY_OTHER]: 'performer:Janet Doe' } });
    expect(effectiveTags(B, { stash: stash() }, { rules: rename }).map((t) => t.key)).toContain('performer:janet-doe');
  });

  it('a chip\'s identity key comes back as itself (classifyTag), typed text does not', () => {
    expect(classifyTag(KEY_BLONDE).key).toBe(KEY_BLONDE);
    expect(classifyTag(`Performer: Jane Doe#${ID_BLONDE.toUpperCase()}`).key).toBe(KEY_BLONDE);
    expect(classifyTypedTag(KEY_BLONDE).key).toBe(`performer:jane-doe-${ID_BLONDE}`);
    expect(IDENTITY_MARK).toBe('#');
    expect(IDENTITY_FACETS).toEqual(['performer', 'studio']);
    expect(nameSlug('Jane ## Doe#')).toBe('jane-doe');
    expect(tagIdentity('AB#cd')).toBe('ab-cd');
  });

  it('a creator\'s key keeps a # as before (no identity in that facet)', () => {
    expect(classifyTypedTag('creator:DJ#1').key).toBe('creator:dj#1');
    expect(effectiveTags(C, { user: { [C]: ['creator:DJ#1'] } }).map((t) => t.key)).toEqual(['creator:dj#1']);
  });
});

describe('Your typed tag and its chip agree (video-tag-edits.js)', () => {
  it('a typed performer:Jane#x: added, its chip removed again from userTags', () => {
    const state = { userTags: {}, hiddenTags: {} };
    const added = planAddTag(state, C, 'performer:Jane#x');
    expect(added.key).toBe('performer:jane-x');
    state.userTags = added.writes.find((w) => w.key === 'library.userTags').value;
    const chip = effectiveTags(C, { user: state.userTags })[0];
    expect(chip.key).toBe(added.key);
    const removed = planRemoveTag(state, C, chip.key, { sources: { user: state.userTags } });
    expect(removed.writes.find((w) => w.key === 'library.userTags').value).toEqual({});
    expect(planAddTag(state, C, 'performer:Jane#x').changed).toBe(false); // already there: no second copy
  });

  it('a joined name you typed: removing its chip removes your copy (rules with nameIds)', () => {
    const nameIds = nameIdentities(makeData({ twoJanes: false }), { enabled: true });
    const rules = withNameIds(compileTagRules(), nameIds);
    const state = { userTags: { [C]: ['performer:Jane Doe'] }, hiddenTags: {} };
    const plan = planRemoveTag(state, C, KEY_BLONDE, { rules, sources: {} });
    expect(plan.writes.find((w) => w.key === 'library.userTags').value).toEqual({});
  });
});

describe('Hides survive a sync', () => {
  it('a hidden Stash tag and a hidden identity chip stay hidden after the Stash data is replaced', () => {
    const hidden = { [A]: ['content:pov', KEY_BLONDE] };
    const { state, memo } = setup({ store: { 'library.hiddenTags': hidden, 'library.userTags': { [A]: ['favourite'] } } });
    const tagsBefore = JSON.stringify({ u: state.settings['library.userTags'], h: state.settings['library.hiddenTags'] });
    expect(keysOf(memo.get(), A)).toEqual(['content:favourite', 'content:outdoor', 'studio:synthetic-studio']);
    // A sync: a new data object (a new scene record), a new version.
    const next = makeData();
    next.scenes[1] = { ...next.scenes[1], title: 'Synthetic One (renamed)', tagIds: ['t2', 't1'] };
    state.data = next;
    state.version = 2;
    expect(keysOf(memo.get(), A)).toEqual(['content:favourite', 'content:outdoor', 'studio:synthetic-studio']);
    expect(JSON.stringify({ u: state.settings['library.userTags'], h: state.settings['library.hiddenTags'] })).toBe(tagsBefore);
  });

  it('removing an identity chip hides exactly that key, and Show again brings it back', () => {
    const sources = { stash: stashTagRecords(makeData(), { enabled: true }) };
    const state = { userTags: {}, hiddenTags: {} };
    const plan = planRemoveTag(state, A, KEY_BLONDE, { sources });
    expect(plan.hidden).toBe(true);
    const hiddenTags = plan.writes.find((w) => w.key === 'library.hiddenTags').value;
    expect(hiddenTags).toEqual({ [A]: [KEY_BLONDE] });
    expect(effectiveTags(A, sources, { hidden: hiddenTags }).map((t) => t.key)).not.toContain(KEY_BLONDE);
    const again = planShowAgain({ ...state, hiddenTags }, A, KEY_BLONDE, { sources });
    expect(again.writes.find((w) => w.key === 'library.hiddenTags').value).toEqual({});
  });

  it('hiding one Jane Doe everywhere leaves the other', () => {
    const sources = { stash: stashTagRecords(makeData(), { enabled: true }) };
    expect(effectiveTags(B, sources, { hiddenEverywhere: [KEY_BLONDE] }).map((t) => t.key)).toContain(KEY_OTHER);
    expect(effectiveTags(A, sources, { hiddenEverywhere: [KEY_BLONDE] }).map((t) => t.key)).not.toContain(KEY_BLONDE);
  });
});

describe('Turned off', () => {
  it('stash.enabled false: no `stash` source in the index; the data is not touched', () => {
    const data = makeData();
    const before = JSON.stringify(data);
    const result = setup({ data, enabled: false }).memo.get();
    expect(result.index.size).toBe(0);
    expect(result.sourceCounts.stash).toBe(0);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('a missing setting is off; turning it on shows the data at once (no write, no sync)', () => {
    const { state, memo } = setup({ store: { [STASH_ENABLED_KEY]: undefined } });
    expect(memo.get().index.size).toBe(0);
    state.settings[STASH_ENABLED_KEY] = true;
    expect(keysOf(memo.get(), A)).toContain('content:pov');
    state.settings[STASH_ENABLED_KEY] = false;
    expect(memo.get().index.has(A)).toBe(false);
    expect(memo.builds).toBe(3);
  });
});

describe('Trust check through the index', () => {
  it('a scanned size other than the link\'s gives no Stash tags; the link stays in the data', () => {
    const { state, memo } = setup();
    state.videos = state.videos.map((v) => (v.path === A ? { ...v, size: 101 } : v));
    expect(memo.get().index.has(A)).toBe(false);
    expect(state.data.links[A].sceneId).toBe('1');
  });
});

describe('Tags from: Stash', () => {
  it('is in the facet, between EroScripts and the script file', () => {
    expect(SOURCE_FACET).toEqual(['eroscripts', 'stash', 'funscript', 'user']);
  });

  it('counts the videos that show a Stash tag, and filters to them', () => {
    const result = setup().memo.get();
    expect(result.sourceCounts.stash).toBe(2);
    const out = applyTagFilter(VIDEOS, { ...emptyTagFilter(), sources: ['stash'] }, { index: result.index });
    expect(out.map((v) => v.path)).toEqual([A, B]);
  });

  it('a video whose Stash tags are all hidden does not count', () => {
    const hidden = { [B]: [KEY_OTHER, 'content:synthetic-tag-b'] };
    const result = setup({ store: { 'library.hiddenTags': hidden } }).memo.get();
    expect(result.sourceCounts.stash).toBe(1);
  });

  it('no Stash data: a count of 0 (the picker hides the source)', () => {
    expect(setup({ data: {} }).memo.get().sourceCounts.stash).toBe(0);
    expect(buildLibraryTagIndex({ videos: VIDEOS }).sourceCounts.stash).toBe(0);
  });
});

describe('LibraryTagIndex: the Stash data as a memo input', () => {
  it('the same Stash data: built once; the result carries the source and the join it used', () => {
    const { memo } = setup();
    const first = memo.get();
    expect(memo.get()).toBe(first);
    expect(memo.builds).toBe(1);
    expect(first.stash[A].tags.map((t) => t.name)).toEqual(['POV', 'Outdoor']);
    expect(first.nameIds instanceof Map).toBe(true);
  });

  it('a new Stash version (main reported a change, the data object kept): rebuilt', () => {
    const { state, memo } = setup();
    memo.get();
    state.data.tags.t3 = { id: 't3', name: 'Synthetic Tag C' }; // the store changed it in place
    expect(keysOf(memo.get(), B)).toContain('content:synthetic-tag-b');
    state.version = 2;
    expect(keysOf(memo.get(), B)).toContain('content:synthetic-tag-c');
    expect(memo.builds).toBe(2);
  });

  it('a new Stash data object: rebuilt', () => {
    const { state, memo } = setup();
    memo.get();
    const next = makeData();
    next.links = { [A]: next.links[A] };
    state.data = next;
    expect(memo.get().index.has(B)).toBe(false);
    expect(memo.builds).toBe(2);
  });

  it('a stashData or stashVersion that throws: no Stash, nothing thrown', () => {
    const memo = new LibraryTagIndex({
      settings: () => ({ get: (k) => (k === STASH_ENABLED_KEY ? true : undefined) }),
      videos: () => VIDEOS,
      stashData: () => { throw new Error('x'); },
      stashVersion: () => { throw new Error('y'); },
    });
    expect(memo.get().index.size).toBe(0);
  });
});
